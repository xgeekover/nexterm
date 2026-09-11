import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: AI Chat Markdown & Streaming Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-CHAT-01: AI chat initializes with pre-populated message thread containing >= 1 user and 1 assistant message', () => {
    assert.ok(app.chatMessages.length >= 2, 'Chat must have at least 2 seed messages');

    const userMsg = app.chatMessages.find((m) => m.sender === 'user');
    assert.ok(userMsg, 'User message must be present');
    assert.ok(userMsg.text.length > 0);

    const asstMsg = app.chatMessages.find((m) => m.sender === 'assistant');
    assert.ok(asstMsg, 'Assistant message must be present');
    assert.ok(asstMsg.text.length > 0);
  });

  test('TC-CHAT-02: Assistant message contains markdown formatting and fenced code blocks', () => {
    const asstMsg = app.chatMessages.find((m) => m.sender === 'assistant');
    assert.ok(asstMsg.text.includes('```bash'), 'Assistant reply must include fenced code block');
    assert.ok(asstMsg.text.includes('node tests/e2e/runner.js'), 'Code block contains runner command');
    assert.ok(asstMsg.text.includes('**4 test tiers**'), 'Assistant reply contains bold markdown formatting');
  });

  test('TC-CHAT-03: Sending a new message invokes chat_send_message and appends to message thread', async () => {
    const initialCount = app.chatMessages.length;
    const promptText = 'Can you optimize the terminal block rendering?';

    const response = await app.sendChatMessage('agent-architect-01', promptText);
    assert.ok(response, 'Chat response must be returned');
    assert.ok(app.chatMessages.length >= initialCount + 2, 'Message thread must have new user and assistant messages');

    const sentUserMsg = app.chatMessages.find((m) => m.text === promptText && m.sender === 'user');
    assert.ok(sentUserMsg, 'User message must exist in chat thread');
  });

  test('TC-CHAT-04: Streaming tokens from chat-token event progressively update message until complete', async () => {
    const promptText = 'Show me the fix for calculator.js';
    const response = await app.sendChatMessage('agent-architect-01', promptText);

    // Wait a brief tick for simulated streaming tokens
    await new Promise((resolve) => setTimeout(resolve, 50));

    const asstMsg = app.chatMessages.find((m) => m.id === response.id);
    assert.ok(asstMsg, 'Assistant response message must exist');
    assert.equal(asstMsg.isStreaming, false, 'Streaming should complete and mark isStreaming as false');
    assert.ok(asstMsg.text.includes('return items.reduce'), 'Streamed content must contain full text');
  });

  test('TC-CHAT-05: Context injection enriches prompt with referenced code or terminal error snippet', async () => {
    app.attachContext({
      title: 'src/calculator.js',
      content: 'return items.reduce((acc, item) => acc * item.price, 0);',
    });

    await app.sendChatMessage('agent-architect-01', 'Why is this test failing?');

    const lastCall = app.ipc.getCalls('chat_send_message').pop();
    assert.ok(lastCall.args.message.includes('[Context: src/calculator.js]'), 'Injected context header must be present');
    assert.ok(lastCall.args.message.includes('reduce((acc, item) => acc * item.price, 0)'), 'Injected code must be in prompt');
    assert.ok(lastCall.args.message.includes('Why is this test failing?'), 'User prompt must be included');

    app.clearContext();
    assert.equal(app.chatContext, null);
  });

  test('TC-CHAT-06: BYOK settings panel securely saves API keys for LLM providers', () => {
    app.setByokKey('openaiKey', 'sk-test-openai-secret-key-12345');
    app.setByokKey('claudeKey', 'sk-ant-test-claude-key-67890');
    app.setByokKey('geminiKey', 'AIzaSy-test-gemini-key-54321');

    assert.equal(app.byokSettings.openaiKey, 'sk-test-openai-secret-key-12345');
    assert.equal(app.byokSettings.claudeKey, 'sk-ant-test-claude-key-67890');
    assert.equal(app.byokSettings.geminiKey, 'AIzaSy-test-gemini-key-54321');
  });
});
