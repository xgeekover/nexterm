/**
 * Claude Code's own record of its conversations in the agent session history
 * (F16, F17): src-tauri/src/claude_conversations.rs read through
 * `claude_conversations`, here the browser mock's (`mockBridge.claudeTranscripts`).
 *
 * F16 — a Claude Code entry is named by the title Claude Code gave the
 * conversation (its newest `ai-title`, else its newest `last-prompt`):
 * looked up when the history is loaded and when a Claude Code agent ends,
 * kept masked and cleaned, shown in the side bar and the palette, found by
 * the palette's filter, and kept once the transcript can no longer be read.
 *
 * F17 — a Claude Code conversation that was never saved (its terminal quit
 * before a first message) is never resumed with `claude --resume <id>`, which
 * can only fail: on the same schedule a NEW conversation is typed instead,
 * `claude --session-id <new uuid>`, it becomes the terminal's record and the
 * history's, a notice says so, and the old entry goes. Asked right before
 * typing; "never saved" needs Claude Code's session-env marker
 * (`claudeSessionMarkers`), and "cannot tell" (null) resumes as always.
 * Loading the history drops a
 * never-saved entry no terminal of this window holds.
 *
 * Writes to the terminals are held. AHC-99 puts the stores, the storage, the
 * hooks and the mock back.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useAgentHistoryStore } from '../../src/stores/agentHistoryStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { isSessionIdFor, startCommand } from '../../src/lib/agents.js';
import {
  CLAUDE_TITLE_READ_CHARS,
  claudeHistoryChanges,
  claudeHistoryTitle,
  claudeIdsHeld,
  historyDisplay,
} from '../../src/lib/agentHistory.js';
import {
  CLAUDE_LOOKUP_TIMEOUT_MS,
  __setClaudeLookupTimeoutMs,
  claudeConversationSaved,
  lookUpClaudeConversations,
} from '../../src/lib/claudeConversations.js';
import { agentSessionRows, buildPaletteGroups } from '../../src/lib/paletteItems.js';

const T = terminalStore.useTerminalStore;
const H = useAgentHistoryStore;
const { NEVER_SAVED_NOTE } = terminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const OTHER = '60a62d81-6923-4289-9d6d-7ce3f8f44043';
const THIRD = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const KEY = `claude:${UUID}`;

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });

/** A transcript's records, as Claude Code 2.1.323 writes them (only the two kinds read). */
const aiTitle = (title) => ({ type: 'ai-title', aiTitle: title, sessionId: UUID });
const lastPrompt = (text) => ({ type: 'last-prompt', lastPrompt: text, leafUuid: 'x', sessionId: UUID });

/**
 * `fn` with terminal writes held, and spawns, writes and lookups counted.
 * `answer(command, args)`, when given, answers a call itself by returning
 * `{ value }` (or a promise of one) or throwing; undefined lets the mock answer.
 */
async function withBackend(fn, { answer = null } = {}) {
  const original = mockBridge.invoke;
  const calls = { writes: [], spawns: [], lookups: [] };
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') {
      calls.writes.push({ session: args?.session_id, data: args?.data });
      return null;
    }
    if (command === 'pty_spawn') calls.spawns.push({ ...args });
    if (command === 'claude_conversations') calls.lookups.push([...(args?.ids ?? [])]);
    const answered = answer ? await answer(command, args) : undefined;
    if (answered) return answered.value;
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(calls);
  } finally {
    mockBridge.invoke = original;
  }
  return calls;
}

async function until(check, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function readyTerminal(cwd = null) {
  await T.getState().init();
  const tab = await T.getState().createTab(cwd ? { cwd } : {});
  assert.ok(tab, 'setup: a terminal');
  await prompt(tab);
  return tabById(tab.id);
}

/** A restored terminal offering `agent` back. */
function offer(tab, agent) {
  T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, agent, agentResumeOffered: true } : t)) }));
}

const entry = (kind, sessionId, cwd = '/workspace/src', title = null, lastUsedAt = 2000) => ({
  kind, sessionId, cwd, title, startedAt: 1000, lastUsedAt, endedAt: lastUsedAt, endReason: 'closed',
});
/** Put `e` in the history; its key, as the backend made it. */
const remember = async (e) => (await mockBridge.invoke('agent_history_upsert', { entry: e })).key;
const listed = () => mockBridge.invoke('agent_history_list');
const keysListed = async () => (await listed()).map((e) => e.key);
const fileText = () => mockBridge.agentHistoryFile() ?? '';

/**
 * `fn(resume)`: resume `key` from the history; once the new terminal is
 * there, check nothing was typed yet, then (after `beforePrompt`) draw its
 * first prompt. Resolves with the result, the new terminal and the calls.
 */
async function resumeNew(key, { beforePrompt = null, answer = null } = {}) {
  const tabsBefore = T.getState().tabs.length;
  let result;
  let tab;
  const calls = await withBackend(async (c) => {
    const pending = T.getState().resumeFromHistory(key);
    await until(() => T.getState().tabs.length > tabsBefore && tabById(T.getState().activeTabId)?.agentHistoryKey === key, 'the new terminal');
    tab = tabById(T.getState().activeTabId);
    await sleep(20);
    assert.deepEqual(c.writes, [], 'nothing typed before the shell’s first prompt');
    if (beforePrompt) await beforePrompt(tab, c);
    await prompt(tab);
    result = await pending;
  }, { answer });
  return { result, tab: tabById(tab.id) ?? tab, calls };
}

/** The one line typed, and the id of the new conversation it starts, or fails. */
function freshConversationTyped(calls, tab, oldId) {
  assert.equal(calls.writes.length, 1, `one line typed: ${JSON.stringify(calls.writes)}`);
  const [{ session, data }] = calls.writes;
  assert.equal(session, tab.sessionId, 'into the terminal resumed in');
  assert.ok(!data.includes('--resume'), `never --resume: ${JSON.stringify(data)}`);
  const match = /^claude --session-id ([0-9a-f-]{36})\r$/.exec(data);
  assert.ok(match, `exactly \`claude --session-id <uuid>\\r\`: ${JSON.stringify(data)}`);
  const id = match[1];
  assert.ok(isSessionIdFor('claude', id), `a v4 uuid: ${id}`);
  assert.notEqual(id, oldId, 'a fresh one, not the one never saved');
  return id;
}

// ---- A disk of our own, and everything put back after each case ---------------

const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
let before = null;
const notices = [];

/**
 * Each case: an empty history in its own storage, no Claude Code transcripts
 * (`claudeTranscripts` null: "cannot tell"), terminal notices caught; with
 * `record`, the recorder started with no write delay. Everything closed,
 * stopped and put back after.
 */
async function fresh(fn, { record = false } = {}) {
  if (!before) {
    before = {
      storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      memory: mockBridge.agentHistoryMemory,
      bad: mockBridge.agentHistoryBad,
      transcripts: mockBridge.claudeTranscripts,
      markers: mockBridge.claudeSessionMarkers,
    };
  }
  backing.clear();
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  mockBridge.claudeTranscripts = null;
  mockBridge.claudeSessionMarkers = [];
  T.setState({ agentHistoryNotice: null });
  H.setState({ entries: [], loaded: false, error: null, holders: {} });
  notices.length = 0;
  const unsink = setTerminalNoticeSink((tabId, message) => {
    notices.push({ tabId, message });
    return true;
  });
  try {
    if (record) {
      H.getState().start({ delayMs: 0 });
      await H.getState().load();
    }
    await fn();
  } finally {
    unsink();
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    mockBridge.agentSessions = [];
    mockBridge.claudeTranscripts = null;
    mockBridge.claudeSessionMarkers = [];
    __setClaudeLookupTimeoutMs(CLAUDE_LOOKUP_TIMEOUT_MS);
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  }
}

/** A restart of the page: the recorder stops, the store forgets, both come back from the file. */
async function relaunch() {
  await H.getState().stop();
  H.setState({ entries: [], loaded: false, error: null, holders: {} });
  mockBridge.agentHistoryMemory = null;
  H.getState().start({ delayMs: 0 });
  await H.getState().load();
}

// ---- F16: Claude Code's own titles --------------------------------------------

describe('Agent session history: Claude Code entries named by Claude Code’s own title (F16)', () => {
  test('AHC-01: loading the history gives a claude entry its title — masked, in the file, in the side bar and palette rows, found by a word of it (AC23)', async () => {
    await fresh(async () => {
      await remember(entry('claude', UUID, '/workspace/src', null, 5000));
      await remember(entry('opencode', 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA', '/workspace/tests', 'Port the parser', 9000));
      mockBridge.claudeTranscripts = {
        [UUID]: [lastPrompt('an early prompt'), aiTitle('First guess'), aiTitle(`Rotate the deploy key ${TOKEN}‮\u0007 safely`)],
      };
      const calls = await withBackend(async () => {
        await H.getState().load();
      });
      assert.deepEqual(calls.lookups, [[UUID]], 'one lookup, of the claude entry with an id only');
      const shown = 'Rotate the deploy key ghp_[hidden] safely';
      const claude = H.getState().entries.find((e) => e.key === KEY);
      assert.equal(claude?.title, shown, 'the newest ai-title, masked and cleaned');
      // In the file, never the secret.
      const stored = JSON.parse(fileText()).entries.find((e) => e.key === KEY);
      assert.equal(stored.title, shown);
      assert.ok(!fileText().includes(TOKEN.slice(4)), 'the token is nowhere in the file');
      // Moved nothing: the title kept the entry's own times and place.
      assert.deepEqual([stored.startedAt, stored.lastUsedAt, stored.endedAt, stored.endReason], [1000, 5000, 5000, 'closed']);
      assert.deepEqual(await keysListed(), ['opencode:ses_aaaaaaaaaaaaAAAAAAAAAAAAAA', KEY]);
      // The side bar row (`historyDisplay`, TerminalsPanel.jsx) and the palette row.
      const row = historyDisplay(claude);
      assert.deepEqual([row.title, row.titled, row.label], [shown, true, 'Claude Code'], 'the side bar row: the title, not the short id');
      const paletteRow = agentSessionRows(H.getState().entries).find((r) => r.historyKey === KEY);
      assert.deepEqual([paletteRow.title, paletteRow.hint], [shown, 'Claude Code'], 'the palette row');
      // A palette query on a word of the title finds it, in the pick and in the default palette.
      const pick = (query, mode) =>
        buildPaletteGroups({ mode, query, agentSessions: H.getState().entries }).find((g) => g.label === 'agent sessions')?.items.map((r) => r.historyKey) ?? [];
      assert.deepEqual(pick('deploy', 'agent-sessions'), [KEY]);
      assert.deepEqual(pick('ROTATE safely', 'agent-sessions'), [KEY], 'every word, case aside');
      assert.deepEqual(pick('deploy', 'all'), [KEY], 'the default palette’s Agent sessions group');
      assert.deepEqual(pick('parser', 'agent-sessions'), ['opencode:ses_aaaaaaaaaaaaAAAAAAAAAAAAAA']);
    });
  });

  test('AHC-02: with no ai-title, the newest last-prompt; a newer title replaces the stored one; only claude entries with an id are asked about', async () => {
    await fresh(async () => {
      await remember(entry('claude', UUID));
      await remember(entry('claude', null, '/workspace/tests'));
      await remember(entry('opencode', null, '/workspace'));
      mockBridge.claudeTranscripts = {
        [UUID]: [lastPrompt('Fix the login flow'), { type: 'last-prompt', leafUuid: 'y' }, lastPrompt('Then add a test'), { type: 'ai-title', aiTitle: 7 }, aiTitle('   ')],
      };
      const calls = await withBackend(() => H.getState().load());
      assert.deepEqual(calls.lookups, [[UUID]], 'the id-less claude entry (`--continue`) and opencode are not looked up');
      assert.equal(H.getState().entries.find((e) => e.key === KEY)?.title, 'Then add a test', 'the newest last-prompt; malformed records passed over');

      mockBridge.claudeTranscripts[UUID].push(aiTitle('Login flow and its tests'));
      await H.getState().load();
      assert.equal(H.getState().entries.find((e) => e.key === KEY)?.title, 'Login flow and its tests', 'Claude Code named it since');
      const upserts = [];
      await withBackend(async () => {
        const original = mockBridge.invoke;
        mockBridge.invoke = async function (command, args, ...rest) {
          if (command === 'agent_history_upsert') upserts.push(args);
          return original.call(this, command, args, ...rest);
        };
        try {
          await H.getState().load();
        } finally {
          mockBridge.invoke = original;
        }
      });
      assert.deepEqual(upserts, [], 'the same title again writes nothing');
    });
  });

  test('AHC-03: the stored title stays — after a restart with the transcript gone, and when a lookup finds none, fails or times out (AC23)', async () => {
    await fresh(async () => {
      await remember(entry('claude', UUID));
      mockBridge.claudeTranscripts = { [UUID]: [aiTitle('Rename the store')] };
      await H.getState().load();
      assert.equal(H.getState().entries[0]?.title, 'Rename the store', 'premise: the title is kept');

      // A restart, and Claude Code's folder cannot be read any more.
      mockBridge.claudeTranscripts = null;
      await relaunch();
      assert.equal(H.getState().entries[0]?.title, 'Rename the store', 'after the restart, the title the history kept');
      assert.equal(historyDisplay(H.getState().entries[0]).title, 'Rename the store', 'and the side bar shows it');

      // The transcript there, with no title in it any more.
      mockBridge.claudeTranscripts = { [UUID]: [{ type: 'user', message: 'x' }] };
      await relaunch();
      assert.equal(H.getState().entries[0]?.title, 'Rename the store', 'a lookup that finds no title clears nothing');

      // The lookup failing, or never answering.
      await withBackend(() => H.getState().load(), {
        answer: (command) => {
          if (command === 'claude_conversations') throw new Error('the disk went away');
          return undefined;
        },
      });
      assert.equal(H.getState().entries[0]?.title, 'Rename the store');
      __setClaudeLookupTimeoutMs(30);
      const startedAt = Date.now();
      await withBackend(() => H.getState().load(), {
        answer: (command) => (command === 'claude_conversations' ? new Promise(() => {}) : undefined),
      });
      assert.ok(Date.now() - startedAt < 1000, 'a lookup that never answers is not waited for');
      assert.equal(H.getState().entries[0]?.title, 'Rename the store');
      assert.deepEqual(await keysListed(), [KEY], 'and nothing was removed: "cannot tell"');
    });
  });

  test('AHC-04: a claude agent that ends is looked up: the first message named it; none sent, and its entry goes (F16, F17)', async () => {
    await fresh(
      async () => {
        const a = await readyTerminal();
        const b = await T.getState().createTab({ cwd: '/workspace/src' });
        await prompt(b);
        let named;
        let unnamed;
        await withBackend(async () => {
          named = await T.getState().startAgent(a.id, 'claude');
          unnamed = await T.getState().startAgent(b.id, 'claude');
          await H.getState().flush();
        });
        assert.deepEqual(await keysListed().then((k) => k.sort()), [`claude:${named.sessionId}`, `claude:${unnamed.sessionId}`].sort(), 'premise: both recorded');
        // One was sent a message — Claude Code saved and named it — the other none.
        mockBridge.claudeTranscripts = {
          [named.sessionId]: [{ type: 'ai-title', aiTitle: 'Explain the build', sessionId: named.sessionId }],
        };
        mockBridge.claudeSessionMarkers = [named.sessionId, unnamed.sessionId];
        const calls = await withBackend(async () => {
          await started(tabById(a.id));
          await prompt(tabById(a.id)); // the agent exited
          await started(tabById(b.id));
          await prompt(tabById(b.id));
          await until(() => H.getState().entries.length === 1, 'the never-saved entry to go');
          await H.getState().flush();
        });
        assert.deepEqual(calls.lookups.flat().sort(), [named.sessionId, unnamed.sessionId].sort(), 'each ended conversation looked up');
        const [kept] = await listed();
        assert.deepEqual([kept.key, kept.title, kept.endReason], [`claude:${named.sessionId}`, 'Explain the build', 'exited']);
      },
      { record: true }
    );
  });

  test('AHC-05: the lookup itself — the mock’s refusals, and what the page makes of an answer', async () => {
    await fresh(async () => {
      await assert.rejects(() => mockBridge.invoke('claude_conversations', {}), /missing required key ids/);
      await assert.rejects(() => mockBridge.invoke('claude_conversations', { ids: [UUID, 7] }), /expected a sequence of strings/);
      await assert.rejects(() => mockBridge.invoke('claude_conversations', { ids: Array(201).fill(UUID) }), /At most 200/);
      const NO_MARKER = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';
      mockBridge.claudeTranscripts = { [UUID]: [aiTitle(`é${'y'.repeat(1200)}`)], [OTHER]: null };
      mockBridge.claudeSessionMarkers = [THIRD, OTHER, UUID.toUpperCase()];
      const answer = await mockBridge.invoke('claude_conversations', {
        ids: [UUID.toUpperCase(), '../x', UUID, OTHER, THIRD, NO_MARKER],
      });
      assert.deepEqual(
        answer.map((a) => [a.saved, a.title === null ? null : Array.from(a.title).length]),
        [[null, null], [null, null], [true, CLAUDE_TITLE_READ_CHARS], [null, null], [false, null], [null, null]],
        'not an id: cannot tell; a title cut to 1000 characters; one there but not read: cannot tell; none but its session marker: false; none and no marker: cannot tell'
      );
      // The page asks about ids only, each once, and never waits long.
      const calls = await withBackend(async () => {
        const found = await lookUpClaudeConversations([UUID, 'x; curl a | sh', UUID, null]);
        assert.deepEqual([...found.keys()], [UUID]);
      });
      assert.deepEqual(calls.lookups, [[UUID]]);
      assert.deepEqual((await withBackend(async () => assert.equal((await lookUpClaudeConversations(['nope'])).size, 0))).lookups, [], 'nothing to ask: no call');
      assert.equal(await claudeConversationSaved(THIRD), false);
      mockBridge.claudeTranscripts = null;
      assert.equal(await claudeConversationSaved(UUID), null);
      // A title the backend cut: a token it ends in is hidden from its prefix on.
      const cut = `Fix${' '.repeat(CLAUDE_TITLE_READ_CHARS - 'Fix'.length - 'ghp_abc'.length)}ghp_abc`;
      assert.equal(Array.from(cut).length, CLAUDE_TITLE_READ_CHARS, 'premise: as long as the backend hands over');
      assert.equal(claudeHistoryTitle(cut), 'Fix ghp_[hidden]', 'cut at 1000 by the backend, short once cleaned: the prefix still hidden');
      assert.match(claudeHistoryTitle('Fix ghp_abc'), /ghp_abc$/, 'not cut: left as the masking finds it');
      assert.equal(claudeHistoryTitle(null), null);
    });
  });
});

// ---- F17: a Claude Code conversation never saved ------------------------------

describe('Agent session history: a Claude Code session that never saved a conversation (F17)', () => {
  test('AHC-10: resumeFromHistory on an entry reported never saved types `claude --session-id <new uuid>`, never --resume; notice; the terminal and the history carry the new id (AC24 1)', async () => {
    await fresh(
      async () => {
        await readyTerminal();
        await remember(entry('claude', UUID));
        // Claude Code's projects folder is there, with no transcript of it,
        // and the session marker Claude Code made when it started.
        mockBridge.claudeTranscripts = { [OTHER]: [aiTitle('Someone else')] };
        mockBridge.claudeSessionMarkers = [UUID];
        const { result, tab, calls } = await resumeNew(KEY);
        const id = freshConversationTyped(calls, tab, UUID);
        assert.deepEqual(calls.lookups, [[UUID]], 'asked once, after the prompt');
        assert.equal(result.outcome, 'opened');
        assert.equal(result.typed, true);
        assert.equal(result.notice?.kind, 'newConversation');
        assert.equal(result.notice.text, NEVER_SAVED_NOTE);
        assert.equal(T.getState().agentHistoryNotice?.kind, 'newConversation', 'the pick says so');
        assert.ok(notices.some((n) => n.tabId === tab.id && n.message === NEVER_SAVED_NOTE), 'and so does the terminal');
        assert.equal(tab.agent.kind, 'claude');
        assert.equal(tab.agent.sessionId, id, 'the terminal’s record is the new conversation');
        assert.equal(tab.agentResumeOffered, false);
        await H.getState().flush();
        await until(() => H.getState().entries.every((e) => e.key !== KEY), 'the old entry to go');
        const keys = await keysListed();
        assert.ok(keys.includes(`claude:${id}`), `the new one recorded: ${keys}`);
        assert.ok(!keys.includes(KEY), 'the one never saved removed');
      },
      { record: true }
    );
  });

  test('AHC-11: a restored claude terminal reported never saved does the same on Resume (AC24 2)', async () => {
    await fresh(
      async () => {
        const tab = await readyTerminal();
        const { agent } = startCommand('claude');
        await remember(entry('claude', agent.sessionId, '/workspace'));
        offer(tab, agent);
        mockBridge.claudeTranscripts = {};
        mockBridge.claudeSessionMarkers = [agent.sessionId];
        let resumed;
        const calls = await withBackend(async () => {
          resumed = await T.getState().resumeAgent(tab.id);
        });
        assert.equal(resumed, true);
        const now = tabById(tab.id);
        const id = freshConversationTyped(calls, now, agent.sessionId);
        assert.equal(now.agent.sessionId, id);
        assert.equal(now.agentResumeOffered, false);
        assert.deepEqual(notices.map((n) => [n.tabId, n.message]), [[tab.id, NEVER_SAVED_NOTE]], 'the terminal says why');
        assert.equal(T.getState().agentHistoryNotice, null, 'no history notice: no pick was made');
        await H.getState().flush();
        await until(() => H.getState().entries.every((e) => e.key !== `claude:${agent.sessionId}`), 'the old entry to go');
        assert.ok((await keysListed()).includes(`claude:${id}`));
        // It exits like any agent.
        await started(now);
        await prompt(now);
        assert.equal(tabById(tab.id).agent, null);
      },
      { record: true }
    );
  });

  test('AHC-12: "cannot tell" (saved null) — no projects folder, no session marker, a failed or a slow lookup — types `claude --resume <uuid>` as in AC12 (AC24 3)', async () => {
    await fresh(async () => {
      await readyTerminal();
      const key = await remember(entry('claude', UUID));
      // No transcript, but no marker either: perhaps another config folder than the shell's.
      mockBridge.claudeTranscripts = {};
      mockBridge.claudeSessionMarkers = [OTHER];
      const { result, tab, calls } = await resumeNew(key);
      assert.deepEqual(calls.writes, [{ session: tab.sessionId, data: `claude --resume ${UUID}\r` }], 'no marker: resumed as always');
      assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: true, notice: null });
    });
    await fresh(async () => {
      await readyTerminal();
      const key = await remember(entry('claude', UUID));
      const { result, tab, calls } = await resumeNew(key);
      assert.deepEqual(calls.writes, [{ session: tab.sessionId, data: `claude --resume ${UUID}\r` }]);
      assert.deepEqual(calls.lookups, [[UUID]], 'asked, and could not tell');
      assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: true, notice: null });
      assert.equal(tab.agent.sessionId, UUID);
      assert.deepEqual(notices, []);
    });
    for (const [what, answer] of [
      ['a lookup that fails', (command) => {
        if (command === 'claude_conversations') throw new Error('Permission denied');
        return undefined;
      }],
      ['a lookup that never answers', (command) => (command === 'claude_conversations' ? new Promise(() => {}) : undefined)],
    ]) {
      await fresh(async () => {
        __setClaudeLookupTimeoutMs(50);
        const tab = await readyTerminal();
        const { agent } = startCommand('claude');
        offer(tab, agent);
        const clicked = Date.now();
        const calls = await withBackend(async () => {
          assert.equal(await T.getState().resumeAgent(tab.id), true, what);
        }, { answer });
        assert.deepEqual(calls.writes.map((w) => w.data), [`claude --resume ${agent.sessionId}\r`], what);
        assert.ok(Date.now() - clicked < 1500, `${what}: not waited on`);
      });
    }
  });

  test('AHC-13: saved true types `claude --resume <uuid>` — from the history and in a restored terminal (AC24 4)', async () => {
    await fresh(async () => {
      await readyTerminal();
      const key = await remember(entry('claude', UUID));
      mockBridge.claudeTranscripts = { [UUID]: [aiTitle('Kept')] };
      const { result, tab, calls } = await resumeNew(key);
      assert.deepEqual(calls.writes, [{ session: tab.sessionId, data: `claude --resume ${UUID}\r` }]);
      assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: true, notice: null });

      const restored = await readyTerminal();
      const { agent } = startCommand('claude');
      mockBridge.claudeTranscripts[agent.sessionId] = [];
      offer(restored, agent);
      const typed = await withBackend(async () => {
        assert.equal(await T.getState().resumeAgent(restored.id), true);
      });
      assert.deepEqual(typed.writes.map((w) => w.data), [`claude --resume ${agent.sessionId}\r`]);
      assert.deepEqual(notices, []);
    });
  });

  test('AHC-14: the check is made right before typing — a conversation saved while the shell started is still resumed; a terminal gone meanwhile is typed nothing', async () => {
    await fresh(async () => {
      await readyTerminal();
      const key = await remember(entry('claude', UUID));
      mockBridge.claudeTranscripts = {};
      mockBridge.claudeSessionMarkers = [UUID];
      const { calls } = await resumeNew(key, {
        beforePrompt: (_tab, c) => {
          assert.deepEqual(c.lookups, [], 'not asked before the prompt');
          mockBridge.claudeTranscripts = { [UUID]: [] }; // saved since the pick
        },
      });
      assert.deepEqual(calls.writes.map((w) => w.data), [`claude --resume ${UUID}\r`]);
    });
    await fresh(async () => {
      const tab = await readyTerminal();
      const { agent } = startCommand('claude');
      offer(tab, agent);
      mockBridge.claudeTranscripts = {};
      let release;
      const calls = await withBackend(async () => {
        const pending = T.getState().resumeAgent(tab.id);
        await until(() => release, 'the lookup');
        await T.getState().closeTab(tab.id);
        release();
        assert.equal(await pending, false, 'nothing typed into a terminal that went');
      }, {
        answer: (command, args) =>
          command === 'claude_conversations'
            ? new Promise((resolve) => {
                release = () => resolve({ value: args.ids.map((sessionId) => ({ sessionId, saved: false, title: null })) });
              })
            : undefined,
      });
      assert.deepEqual(calls.writes, []);
      assert.deepEqual(notices, []);
    });
  });

  test('AHC-15: loading the history removes a never-saved claude entry no terminal holds, and keeps one a terminal of this window holds (AC24 5)', async () => {
    await fresh(
      async () => {
        const running = await readyTerminal();
        const offering = await readyTerminal();
        let live;
        await withBackend(async () => {
          live = await T.getState().startAgent(running.id, 'claude');
          await H.getState().flush();
        });
        const { agent: offered } = startCommand('claude');
        offer(offering, offered);
        await remember(entry('claude', offered.sessionId, '/workspace'));
        await remember(entry('claude', UUID));
        await remember(entry('claude', OTHER, '/workspace/tests', 'Named once'));
        await remember(entry('claude', null, '/workspace/tests'));
        await remember(entry('opencode', null, '/workspace'));
        // Claude Code's folder is there and holds none of them: none was sent a
        // message. Each has its session marker but THIRD, which is then only
        // "cannot tell".
        await remember(entry('claude', THIRD, '/workspace/src', 'No marker'));
        mockBridge.claudeTranscripts = {};
        mockBridge.claudeSessionMarkers = [UUID, OTHER, live.sessionId, offered.sessionId];
        await H.getState().load();
        const keys = await keysListed();
        assert.ok(!keys.includes(KEY), 'never saved, no terminal holds it: removed');
        assert.ok(!keys.includes(`claude:${OTHER}`), 'a title once kept does not save it: the conversation is gone');
        assert.ok(keys.includes(`claude:${live.sessionId}`), 'the running terminal’s stays: it may yet send a first message');
        assert.ok(keys.includes(`claude:${offered.sessionId}`), 'and the one a restored terminal offers back');
        assert.ok(keys.includes(`claude:${THIRD}`), 'no session marker: cannot tell, kept');
        assert.ok(keys.includes('claude:~/workspace/tests\u0000'), 'a claude entry with no id is not checked');
        assert.ok(keys.includes('opencode:~/workspace\u0000'), 'nor an opencode one');
        assert.deepEqual(H.getState().entries.map((e) => e.key), keys, 'the list shows what the file holds');
      },
      { record: true }
    );
  });

  test('AHC-16: the pure rule — claudeIdsHeld and claudeHistoryChanges', () => {
    const tabs = [
      { id: 'a', agent: { kind: 'claude', sessionId: UUID } },
      { id: 'b', agent: { kind: 'claude', sessionId: 'NOT-AN-ID' }, agentResumeOffered: true },
      { id: 'c', agent: { kind: 'opencode', sessionId: OTHER } },
      { id: 'd', agent: null },
      null,
    ];
    assert.deepEqual([...claudeIdsHeld(tabs)], [UUID]);
    const listedEntries = [
      { ...entry('claude', UUID), key: KEY },
      { ...entry('claude', OTHER, '/w', 'Old'), key: `claude:${OTHER}` },
      { ...entry('claude', THIRD), key: `claude:${THIRD}` },
      { ...entry('claude', null, '/w'), key: 'claude:~/w\u0000' },
    ];
    const answers = new Map([
      [UUID, { saved: false, title: null }],
      [OTHER, { saved: true, title: 'New name' }],
      [THIRD, { saved: false, title: null }],
    ]);
    const { removed, titled } = claudeHistoryChanges(listedEntries, answers, new Set([UUID]));
    assert.deepEqual(removed, [`claude:${THIRD}`], 'never saved and not held');
    assert.deepEqual(titled, [
      {
        key: `claude:${OTHER}`,
        entry: { kind: 'claude', sessionId: OTHER, cwd: '/w', title: 'New name', startedAt: 1000, lastUsedAt: 2000, endedAt: 2000, endReason: 'closed' },
      },
    ]);
    assert.deepEqual(claudeHistoryChanges(listedEntries, null), { removed: [], titled: [] }, 'no answer: nothing');
  });

  test('AHC-99: teardown — the stores, the storage, the hooks and the mock as the next suite expects', async () => {
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ agentHistoryNotice: null });
    H.setState({ entries: [], loaded: false, error: null, holders: {} });
    __setClaudeLookupTimeoutMs(CLAUDE_LOOKUP_TIMEOUT_MS);
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      mockBridge.claudeTranscripts = before.transcripts;
      mockBridge.claudeSessionMarkers = before.markers;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    } else {
      mockBridge.claudeTranscripts = null;
    }
    assert.equal(mockBridge.claudeTranscripts, null, 'no transcripts left for the next suite');
    assert.equal(H.getState().isRecording(), false);
  });
});
