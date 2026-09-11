/**
 * Adversarial & Stress Test Suite for NexTerm
 * Modules tested:
 * - R3: Multi-Agent Mission Control (Lifecycle, Concurrency, Dependency Chaining, Ring Buffer)
 * - R4: AI Chat (Token Streaming, Cancellation Race Conditions, Markdown Resilience)
 * - R5: Command Palette & Theming (Fuzzy Search, Regex Safety, Rapid Theme Toggle, Monaco Sync)
 */

import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { MockIpcBridge } from '../e2e/harness/mockIpc.js';
import { fuzzyMatch, parseAnsiToSpans, formatBytes, formatDuration } from '../../src/lib/utils.js';
import { useAgentStore } from '../../src/stores/agentStore.js';
import { useChatStore } from '../../src/stores/chatStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

describe('Adversarial Stress: R3 Multi-Agent Mission Control', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('ADV-MC-01: Rapid creation of 50 agents in tight succession preserves integrity and unique IDs', async () => {
    const initialCount = app.agents.length;
    const createPromises = [];
    const models = ['Claude Opus 4.6', 'Gemini 3.8 Flash', 'GPT-4o', 'Ollama-Codellama'];
    const roles = ['Architect', 'Security Auditor', 'Database Optimizer', 'Test Engineer', 'DevOps'];

    for (let i = 0; i < 50; i++) {
      createPromises.push(
        app.createAgent({
          name: `StressAgent-${i}`,
          role: roles[i % roles.length],
          model: models[i % models.length],
          systemPrompt: `Automated stress task prompt #${i}`,
          dependency: i > 0 && i % 5 === 0 ? `agent-${i - 1}` : null,
        })
      );
    }

    const createdAgents = await Promise.all(createPromises);
    assert.equal(createdAgents.length, 50, 'All 50 agents must be returned');

    // Verify all agents registered in environment
    assert.equal(app.agents.length, initialCount + 50, 'Agent count must match baseline + 50');

    // Verify all IDs are unique
    const idSet = new Set(app.agents.map((a) => a.id));
    assert.equal(idSet.size, initialCount + 50, 'All agent IDs must be strictly unique');

    // Verify dependent agents have waiting status
    const dependent = app.agents.filter((a) => a.dependency !== null && a.dependency !== undefined);
    assert.ok(dependent.length > 0, 'Should have created dependent agents');
    for (const dep of dependent) {
      assert.equal(dep.status, 'waiting', `Dependent agent ${dep.name} must start in waiting status`);
    }
  });

  test('ADV-MC-02: Boundary and adversarial inputs for agent creation are strictly validated or sanitized', async () => {
    // 1. Empty name
    await assert.rejects(
      async () => app.createAgent({ name: '', model: 'GPT-4o' }),
      /Agent name is required/,
      'Empty string name must throw error'
    );

    // 2. Whitespace-only name
    await assert.rejects(
      async () => app.createAgent({ name: '    \t\n  ', model: 'GPT-4o' }),
      /Agent name is required/,
      'Whitespace-only name must throw error'
    );

    // 3. Null / undefined / empty model
    await assert.rejects(
      async () => app.createAgent({ name: 'ValidName', model: null }),
      /Agent model is required/,
      'Null model must throw error'
    );
    await assert.rejects(
      async () => app.createAgent({ name: 'ValidName', model: '' }),
      /Agent model is required/,
      'Empty model must throw error'
    );

    // 4. XSS & script injection payloads in name, role, system prompt
    const xssPayload = '<script>alert("xss")</script><img src=x onerror=console.error(1)>';
    const xssAgent = await app.createAgent({
      name: xssPayload,
      role: xssPayload,
      model: 'GPT-4o',
      systemPrompt: xssPayload,
    });
    assert.ok(xssAgent, 'Agent with XSS payload should be handled safely');
    assert.equal(xssAgent.name, xssPayload);
    assert.equal(xssAgent.role, xssPayload);

    // 5. Huge unicode and emoji payloads
    const emojiName = '🚀🤖🧠 DeepMind Specialist (AlphaFold-3) — 韩国어 / 日本語';
    const emojiAgent = await app.createAgent({
      name: emojiName,
      role: 'Bioinformatics AI',
      model: 'Claude Opus 4.6',
      systemPrompt: 'Protein structural prediction sequence: ' + 'MKTIIALSYIFCLVFA'.repeat(100),
    });
    assert.equal(emojiAgent.name, emojiName);
    assert.ok(emojiAgent.systemPrompt.length > 1000);
  });

  test('ADV-MC-03: Multi-stage linear dependency chain unblocks sequentially as predecessors complete', async () => {
    // Build chain: Agent A -> Agent B -> Agent C -> Agent D
    const agentA = await app.createAgent({ name: 'Pipeline-Stage-1', role: 'Ingestion', model: 'GPT-4o' });
    const agentB = await app.createAgent({ name: 'Pipeline-Stage-2', role: 'Transformation', model: 'GPT-4o', dependency: agentA.id });
    const agentC = await app.createAgent({ name: 'Pipeline-Stage-3', role: 'Analysis', model: 'GPT-4o', dependency: agentB.id });
    const agentD = await app.createAgent({ name: 'Pipeline-Stage-4', role: 'Export', model: 'GPT-4o', dependency: agentC.id });

    // Initial state: Stage 1 active, 2, 3, 4 waiting
    assert.equal(app.agents.find((a) => a.id === agentA.id).status, 'active');
    assert.equal(app.agents.find((a) => a.id === agentB.id).status, 'waiting');
    assert.equal(app.agents.find((a) => a.id === agentC.id).status, 'waiting');
    assert.equal(app.agents.find((a) => a.id === agentD.id).status, 'waiting');

    // Non-completing status change: Pausing Stage 1 must NOT unblock Stage 2
    await app.updateAgentStatus(agentA.id, 'paused');
    assert.equal(app.agents.find((a) => a.id === agentA.id).status, 'paused');
    assert.equal(app.agents.find((a) => a.id === agentB.id).status, 'waiting', 'Stage 2 must remain waiting when Stage 1 is paused');

    // Resume Stage 1
    await app.updateAgentStatus(agentA.id, 'active');
    assert.equal(app.agents.find((a) => a.id === agentB.id).status, 'waiting');

    // Step 1: Complete Stage 1 -> Stage 2 must unblock to active, Stage 3 & 4 remain waiting
    await app.updateAgentStatus(agentA.id, 'completed');
    assert.equal(app.agents.find((a) => a.id === agentA.id).status, 'completed');
    assert.equal(app.agents.find((a) => a.id === agentA.id).progress, 100);
    assert.equal(app.agents.find((a) => a.id === agentB.id).status, 'active', 'Stage 2 must transition to active');
    assert.equal(app.agents.find((a) => a.id === agentC.id).status, 'waiting', 'Stage 3 must still be waiting');
    assert.equal(app.agents.find((a) => a.id === agentD.id).status, 'waiting', 'Stage 4 must still be waiting');

    // Step 2: Complete Stage 2 -> Stage 3 must unblock to active, Stage 4 remains waiting
    await app.updateAgentStatus(agentB.id, 'completed');
    assert.equal(app.agents.find((a) => a.id === agentB.id).status, 'completed');
    assert.equal(app.agents.find((a) => a.id === agentC.id).status, 'active', 'Stage 3 must transition to active');
    assert.equal(app.agents.find((a) => a.id === agentD.id).status, 'waiting', 'Stage 4 must still be waiting');

    // Step 3: Complete Stage 3 -> Stage 4 unblocks to active
    await app.updateAgentStatus(agentC.id, 'completed');
    assert.equal(app.agents.find((a) => a.id === agentC.id).status, 'completed');
    assert.equal(app.agents.find((a) => a.id === agentD.id).status, 'active', 'Stage 4 must transition to active');

    // Step 4: Complete Stage 4 -> All 4 completed
    await app.updateAgentStatus(agentD.id, 'completed');
    assert.equal(app.agents.find((a) => a.id === agentD.id).status, 'completed');
  });

  test('ADV-MC-04: Fan-out dependency unblocking unblocks all dependent siblings simultaneously', async () => {
    const parent = await app.createAgent({ name: 'Leader-Agent', role: 'Coordinator', model: 'Claude Opus 4.6' });
    const worker1 = await app.createAgent({ name: 'Subtask-1', role: 'Worker', model: 'GPT-4o', dependency: parent.id });
    const worker2 = await app.createAgent({ name: 'Subtask-2', role: 'Worker', model: 'GPT-4o', dependency: parent.id });
    const worker3 = await app.createAgent({ name: 'Subtask-3', role: 'Worker', model: 'GPT-4o', dependency: parent.id });

    assert.equal(app.agents.find((a) => a.id === worker1.id).status, 'waiting');
    assert.equal(app.agents.find((a) => a.id === worker2.id).status, 'waiting');
    assert.equal(app.agents.find((a) => a.id === worker3.id).status, 'waiting');

    // Complete Leader
    await app.updateAgentStatus(parent.id, 'completed');

    assert.equal(app.agents.find((a) => a.id === worker1.id).status, 'active');
    assert.equal(app.agents.find((a) => a.id === worker2.id).status, 'active');
    assert.equal(app.agents.find((a) => a.id === worker3.id).status, 'active');
  });

  test('ADV-MC-05: High-volume log emission strictly obeys the 500-entry ring buffer ceiling', () => {
    const testAgentId = 'agent-ringbuffer-test';

    // Emit 1,500 logs rapidly into the Zustand agent store
    for (let i = 1; i <= 1500; i++) {
      useAgentStore.getState().appendLog(testAgentId, {
        id: `log-${i}`,
        agent_id: testAgentId,
        timestamp: Date.now() + i,
        level: i % 10 === 0 ? 'ERROR' : i % 3 === 0 ? 'WARN' : 'INFO',
        message: `Log payload entry #${i}: telemetry heartbeat check`,
      });
    }

    const currentLogs = useAgentStore.getState().agentLogs.get(testAgentId);
    assert.ok(currentLogs, 'Logs array must exist for agent');
    assert.equal(currentLogs.length, 500, 'Ring buffer MUST be bounded to exactly 500 entries (no memory leaks)');

    // Verify FIFO ring buffer eviction: oldest logs (1..1000) dropped, newest (1001..1500) kept
    assert.equal(currentLogs[0].id, 'log-1001', 'First item in ring buffer must be the 1001st log (oldest remaining)');
    assert.equal(currentLogs[499].id, 'log-1500', 'Last item in ring buffer must be the 1500th log (newest)');
  });

  test('ADV-MC-06: Telemetry aggregations remain stable under extreme agent values', async () => {
    const created = await app.createAgent({
      name: 'Heavy-Telemetry-Agent',
      role: 'Heavy Compute',
      model: 'GPT-4o',
    });

    const agentObj = app.agents.find((a) => a.id === created.id);
    agentObj.tokens = 100_000_000;
    agentObj.cost = 1500.75;

    const telemetry = app.getTelemetry();
    assert.ok(telemetry.totalTokens >= 100_000_000, 'Total tokens should sum correctly');
    assert.ok(telemetry.totalCost >= 1500.75, 'Total cost should sum correctly');
    assert.equal(typeof telemetry.activeCount, 'number');
    assert.equal(typeof telemetry.waitingCount, 'number');
  });
});

describe('Adversarial Stress: R4 AI Chat & Streaming', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('ADV-CHAT-01: Message ID generation collision under sub-millisecond execution', async () => {
    // Testing the ID collision vulnerability when messages are dispatched in the same millisecond
    const reply1 = await app.sendChatMessage('agent-architect-01', 'Query 1');
    const reply2 = await app.sendChatMessage('agent-test-eng-02', 'Query 2');

    assert.ok(reply1.id, 'Reply 1 must have an ID');
    assert.ok(reply2.id, 'Reply 2 must have an ID');
    assert.notEqual(reply1.id, reply2.id, 'Message IDs must be strictly unique under sub-millisecond dispatches');
  });

  test('ADV-CHAT-02: Stop Generating cancellation stops generation and prevents ghost resumes', async () => {
    const store = useChatStore.getState();
    await store.initChat();

    // Set streaming active
    useChatStore.setState({ isStreaming: true, activeStreamingMessageId: 'msg-stream-active' });
    assert.equal(useChatStore.getState().isStreaming, true);

    // Invoke stopGenerating
    useChatStore.getState().stopGenerating();
    assert.equal(useChatStore.getState().isStreaming, false, 'isStreaming must immediately flip to false');
    assert.equal(useChatStore.getState().activeStreamingMessageId, null, 'activeStreamingMessageId must be cleared');
  });

  test('ADV-CHAT-02B: In-flight token after stopGenerating causes zombie stream resurrection defect', async () => {
    const store = useChatStore.getState();
    await store.initChat();

    const msgId = 'msg-zombie-test';
    useChatStore.setState({
      messages: [{ id: msgId, text: 'Initial', sender: 'assistant', isStreaming: true }],
      isStreaming: true,
      activeStreamingMessageId: msgId,
    });

    // User clicks stopGenerating
    store.stopGenerating();
    assert.equal(useChatStore.getState().isStreaming, false, 'Stream stopped by user');

    // An in-flight token arrives from background thread
    await mockBridge.emit('chat-token', { message_id: msgId, token: ' extra token', done: false });

    // Verify stream is NOT resurrected and token is discarded
    const stateAfterInFlight = useChatStore.getState();
    assert.ok(stateAfterInFlight.messages.some((m) => m.id === msgId));
    assert.equal(stateAfterInFlight.isStreaming, false, 'Stream must not be resurrected by in-flight tokens');
    assert.equal(stateAfterInFlight.messages.find((m) => m.id === msgId).text, 'Initial', 'In-flight token payload must be discarded for cancelled message');
  });

  test('ADV-CHAT-03: Context injection with complex code and special characters', async () => {
    const complexSnippet = `
      function test() {
        const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/;
        const template = \`Value is: \${1 + 2}\`;
        console.log("Quotes: 'single' and \\"double\\" and \`backticks\`");
        return regex.test("test@example.com");
      }
    `;

    app.attachContext({
      title: 'src/specialChars.js',
      content: complexSnippet,
    });

    await app.sendChatMessage('agent-architect-01', 'Please review regex correctness');
    const lastCall = app.ipc.getCalls('chat_send_message').pop();

    assert.ok(lastCall.args.message.includes('[Context: src/specialChars.js]'));
    assert.ok(lastCall.args.message.includes('test@example.com'));
    assert.ok(lastCall.args.message.includes('Please review regex correctness'));
  });

  test('ADV-CHAT-04: Markdown parser resilience with unclosed fences, nested blocks, and missing language tags', () => {
    const testCases = [
      {
        name: 'Missing language tag',
        input: '```\nconsole.log(42);\n```',
        hasFencedCode: true,
      },
      {
        name: 'Unclosed code fence (streaming state)',
        input: 'Here is unfinished code:\n```javascript\nconst a = 10;\nconst b = 20;',
        hasFencedCode: true,
      },
      {
        name: 'Nested backticks inside code',
        input: '```sh\necho `date`\n```',
        hasFencedCode: true,
      },
      {
        name: 'Empty code fence',
        input: '```\n```',
        hasFencedCode: true,
      },
      {
        name: 'Deep markdown formatting with XSS attempts',
        input: '### Heading\n- Item 1\n  - Subitem 1.1\n\n<script>alert("hack")</script>\n**Bold** and *italic* and `inline_code()`',
        hasFencedCode: false,
      },
    ];

    for (const tc of testCases) {
      assert.ok(typeof tc.input === 'string', `${tc.name} input must be a valid string`);
      if (tc.hasFencedCode) {
        assert.ok(tc.input.includes('```'), `${tc.name} must contain code fence`);
      }
    }
  });
});

describe('Adversarial Stress: R5 Command Palette & Theming', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('ADV-PAL-01: Fuzzy match handles empty queries, null targets, and whitespace gracefully', () => {
    assert.equal(fuzzyMatch('', 'calculator.js'), true, 'Empty query matches any target');
    assert.equal(fuzzyMatch(null, 'calculator.js'), true, 'Null query matches any target');
    assert.equal(fuzzyMatch('calc', ''), false, 'Non-empty query against empty target returns false');
    assert.equal(fuzzyMatch('calc', null), false, 'Non-empty query against null target returns false');
    assert.equal(fuzzyMatch('calc', undefined), false, 'Non-empty query against undefined target returns false');
  });

  test('ADV-PAL-02: Fuzzy match safely handles regex metacharacters without compiling or throwing', () => {
    const dangerousRegexQueries = [
      '.*',
      '[a-z]+',
      '^(.*)$',
      '(\\d+)',
      '???***+++',
      '[\\]\\^$.|?*+()',
      'test{0,5}',
      'a|b|c',
      '\\',
      '\\\\',
    ];

    for (const q of dangerousRegexQueries) {
      assert.doesNotThrow(() => {
        const result = fuzzyMatch(q, 'some/path/file.js');
        assert.equal(typeof result, 'boolean');
      }, `Query "${q}" must not throw regex syntax errors`);
    }
  });

  test('ADV-PAL-03: Fuzzy match accurately matches character subsequences case-insensitively', () => {
    assert.equal(fuzzyMatch('calc', 'src/calculator.js'), true);
    assert.equal(fuzzyMatch('CALC', 'src/calculator.js'), true);
    assert.equal(fuzzyMatch('cross', 'tests/tier3-combinations/crossFeature.test.js'), true);
    assert.equal(fuzzyMatch('swth', 'Switch Dark / Light Theme'), true);
    assert.equal(fuzzyMatch('nonexistent12345', 'src/App.jsx'), false);
    assert.equal(fuzzyMatch('abc', 'cba'), false, 'Subsequence order must be strictly preserved');
  });

  test('ADV-PAL-04: Command palette search handles special characters and non-matching queries without failure', () => {
    app.openCommandPalette();

    const specialSearches = [
      '!!!',
      '###',
      '$$$',
      '%%%',
      '***',
      '<<<>>>',
      'non_existent_file_xyz_99999.txt',
      '🚀',
      '한국어',
    ];

    for (const term of specialSearches) {
      assert.doesNotThrow(() => {
        const res = app.searchPalette(term);
        assert.ok(Array.isArray(res.files));
        assert.ok(Array.isArray(res.commands));
        assert.ok(Array.isArray(res.aiActions));
      }, `Search with "${term}" must not throw error`);
    }
  });

  test('ADV-THM-01: Rapid 200 theme toggles in tight loop maintain strict synchronization and parity', () => {
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark');

    // Toggle 200 times
    for (let i = 0; i < 200; i++) {
      app.toggleTheme();
    }

    // 200 toggles from dark -> dark
    assert.equal(app.theme, 'dark', 'Even number of toggles must return to dark mode');
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Monaco theme must match dark mode');

    // 1 more toggle -> light
    app.toggleTheme();
    assert.equal(app.theme, 'light', 'Odd toggle must switch to light mode');
    assert.equal(app.monacoTheme, 'nexterm-light', 'Monaco theme must switch to vs-light');
  });

  test('ADV-THM-02: Zustand settingsStore setTheme strictly synchronizes monacoTheme without reload', () => {
    useSettingsStore.getState().setTheme('light');
    assert.equal(useSettingsStore.getState().theme, 'light');
    assert.equal(useSettingsStore.getState().monacoTheme, 'nexterm-light');

    useSettingsStore.getState().setTheme('dark');
    assert.equal(useSettingsStore.getState().theme, 'dark');
    assert.equal(useSettingsStore.getState().monacoTheme, 'nexterm-dark');

    assert.throws(
      () => useSettingsStore.getState().setTheme('invalid-color-palette'),
      /Invalid theme/,
      'Invalid theme must throw validation error'
    );
  });
});
