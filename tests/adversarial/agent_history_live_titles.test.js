/**
 * Live Claude Code titles (F23): the conversation title Claude Code shows in
 * its terminal's title (`✳ <title>`, a spinner glyph while it works) is kept
 * as its AGENT SESSIONS entry's title while the agent runs.
 *
 * AC35 — `claudeTitleOf` (src/lib/agents.js) reads exactly F23(a). AC36 —
 * `noteAgentTitle` (terminalStore) tells `onAgentTitleShown` once per text,
 * for a claude record with an id that is not only offered, without changing
 * the record; the recorder (agentHistoryStore) writes one upsert per text
 * through its queue and is heard as `titled`. The evidence sequences are
 * those real Claude Code 2.1.323 sent in a pty (the Queen's recording,
 * runtime/reports/T-20261114-192901-6863/claude-code-terminal-titles.txt).
 * AC33 (live part) — a user's name beats a live title.
 *
 * Writes to the terminals are held; every backend call is logged. AHT-99
 * puts the stores, the storage and the mock back.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useAgentHistoryStore, subscribeAgentLifecycle } from '../../src/stores/agentHistoryStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { claudeTitleOf, startCommand } from '../../src/lib/agents.js';
import { historyDisplay } from '../../src/lib/agentHistory.js';

const T = terminalStore.useTerminalStore;
const H = useAgentHistoryStore;
const { onAgentTitleShown } = terminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const IDLE = '✳';
const SPIN_A = '◐';
const SPIN_B = '◑';
const TITLE = 'NexTerm 세션 기록 기능 테스트';
/** u3: a session that sent one message — its seven title changes, as recorded. */
const U3 = [
  `${IDLE} Claude Code`,
  `${SPIN_A} Claude Code`,
  `${SPIN_B} Claude Code`,
  `${SPIN_A} Claude Code`,
  `${SPIN_A} ${TITLE}`,
  `${SPIN_B} ${TITLE}`,
  `${IDLE} ${TITLE}`,
];
/** u2: a session that sent nothing. */
const U2 = [`${IDLE} Claude Code`];

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
const showTitle = (tab, title) => mockBridge.emit('pty-title', { session_id: tab.sessionId, title });

async function typeLine(tabId, text) {
  for (const key of text) await T.getState().writeRaw(tabId, key);
  await T.getState().writeRaw(tabId, '\r');
}

async function readyTerminal(cwd = '/workspace/src') {
  await T.getState().init();
  const tab = await T.getState().createTab({ cwd });
  assert.ok(tab, 'setup: a terminal');
  await prompt(tab);
  return tabById(tab.id);
}

const fileText = () => mockBridge.agentHistoryFile() ?? '';
const fileEntry = (key) => (fileText() ? JSON.parse(fileText()).entries.find((e) => e.key === key) : undefined);
const storeEntry = (key) => H.getState().entries.find((e) => e.key === key);

const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
let before = null;
/** Every backend call of the case: `{ command, args }`. Terminal writes are held. */
const log = [];
const emptyStore = () => ({ entries: [], loaded: false, error: null, holders: {}, groups: [], readOnly: false, version: null });
/** The upserts sent since `mark` for the conversation `sessionId`. */
const upsertsFor = (mark, sessionId) =>
  log.slice(mark).filter((c) => c.command === 'agent_history_upsert' && c.args?.entry?.sessionId === sessionId);

async function fresh(fn, { record = true } = {}) {
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
  H.setState(emptyStore());
  log.length = 0;
  const unsink = setTerminalNoticeSink(() => true);
  const original = mockBridge.invoke;
  mockBridge.invoke = async function (command, args, ...rest) {
    log.push({ command, args: args === undefined ? undefined : structuredClone(args) });
    if (command === 'pty_write') return null;
    return original.call(this, command, args, ...rest);
  };
  try {
    if (record) {
      H.getState().start({ delayMs: 0 });
      await H.getState().load();
    }
    await fn();
  } finally {
    await H.getState().stop();
    mockBridge.invoke = original;
    unsink();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    mockBridge.claudeTranscripts = null;
    mockBridge.claudeSessionMarkers = [];
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  }
}

async function relaunch() {
  await H.getState().stop();
  H.setState(emptyStore());
  mockBridge.agentHistoryMemory = null;
  H.getState().start({ delayMs: 0 });
  await H.getState().load();
}

/** A Claude Code terminal started by NexTerm, its start written; its key and the log mark after it. */
async function claudeTerminal() {
  const tab = await readyTerminal();
  const agent = await T.getState().startAgent(tab.id, 'claude');
  await H.getState().flush();
  const key = `claude:${agent.sessionId}`;
  assert.ok(fileEntry(key), 'premise: its start is recorded');
  return { tab: tabById(tab.id), agent, key, mark: log.length };
}

describe('Agent session history: live Claude Code titles (F23)', () => {
  test('AHT-01: claudeTitleOf reads one status glyph, one space, the title; null for the default and anything else (AC35)', () => {
    for (const glyph of [IDLE, SPIN_A, SPIN_B]) assert.equal(claudeTitleOf(`${glyph} Claude Code`), null, `${glyph} Claude Code`);
    for (const glyph of [SPIN_A, SPIN_B, IDLE]) assert.equal(claudeTitleOf(`${glyph} ${TITLE}`), TITLE);
    assert.equal(claudeTitleOf(`${IDLE} \u{1F680} Launch plan`), '\u{1F680} Launch plan');
    for (const other of ['NexTerm 세션', '', IDLE, `${IDLE} `, 'OC | Fix it']) assert.equal(claudeTitleOf(other), null, JSON.stringify(other));
    assert.equal(claudeTitleOf('◒ Two'), 'Two');
    assert.equal(claudeTitleOf('◓ Three'), 'Three');
    assert.equal(claudeTitleOf(`${IDLE}️ Emoji form`), 'Emoji form', 'the glyph may carry U+FE0F');
    assert.equal(claudeTitleOf(`${IDLE}  Padded  `), 'Padded', 'trimmed');
    assert.equal(claudeTitleOf(`${IDLE} Claude Code `), null, 'the default, trimmed');
    assert.equal(claudeTitleOf(`x${IDLE} Title`), null, 'the glyph comes first');
    assert.equal(claudeTitleOf(`${IDLE}Title`), null, 'one space after the glyph');
    assert.equal(claudeTitleOf('◔ Not a spinner'), null);
    assert.equal(claudeTitleOf(null), null);
    assert.equal(claudeTitleOf(42), null);
  });

  test('AHT-02: the u3 titles while the agent runs — one upsert, the title in the file and the store, heard as titled; the record unchanged (AC36)', async () => {
    await fresh(async () => {
      const events = [];
      const unhear = subscribeAgentLifecycle((e) => events.push(e));
      const shown = [];
      const unshown = onAgentTitleShown((e) => shown.push(e));
      try {
        const { tab, agent, key, mark } = await claudeTerminal();
        const record = tabById(tab.id).agent;
        for (const title of U3) await showTitle(tab, title);
        await H.getState().flush();
        const kept = fileEntry(key);
        assert.equal(kept.title, TITLE, 'the file has the title');
        assert.deepEqual([kept.endedAt, kept.endReason], [null, null], 'still running: no end');
        const ups = upsertsFor(mark, agent.sessionId);
        assert.equal(ups.length, 1, `exactly one upsert: ${JSON.stringify(ups.map((u) => u.args.entry.title))}`);
        assert.equal(ups[0].args.entry.title, TITLE);
        assert.equal(ups[0].args.entry.endedAt, null);
        assert.equal(ups[0].args.unarchive, undefined, 'a title never unarchives');
        assert.equal(storeEntry(key)?.title, TITLE, 'the store shows it');
        assert.equal(historyDisplay(storeEntry(key)).title, TITLE);
        assert.deepEqual(shown, [{ tabId: tab.id, kind: 'claude', sessionId: agent.sessionId, title: TITLE }], 'told once');
        const titledEvents = events.filter((e) => e.type === 'titled');
        assert.equal(titledEvents.length, 1, 'a lifecycle titled event is heard');
        assert.equal(titledEvents[0].key, key);
        assert.equal(titledEvents[0].tabId, tab.id);
        assert.equal(titledEvents[0].entry.title, TITLE);
        assert.equal(tabById(tab.id).agent, record, 'the record is the same object');
        assert.equal(tabById(tab.id).agent.title, null, 'a Claude Code record names no conversation');

        // 100 more spinner frames with the same text: nothing.
        const frames = log.length;
        for (let i = 0; i < 100; i += 1) await showTitle(tab, `${i % 2 ? SPIN_A : SPIN_B} ${TITLE}`);
        await H.getState().flush();
        assert.equal(upsertsFor(frames, agent.sessionId).length, 0, 'spinner frames send no upsert');
        assert.equal(shown.length, 1, 'and are not even told');

        // A second, different title: one more.
        const second = log.length;
        await showTitle(tab, `${SPIN_A} Plan the release`);
        await showTitle(tab, `${SPIN_B} Plan the release`);
        await showTitle(tab, `${IDLE} Plan the release`);
        await H.getState().flush();
        const more = upsertsFor(second, agent.sessionId);
        assert.equal(more.length, 1, 'exactly one more');
        assert.equal(fileEntry(key).title, 'Plan the release');
        assert.equal(events.filter((e) => e.type === 'titled').length, 2);

        // Through noteAgentTitle itself, as the pty-title listener calls it.
        const direct = log.length;
        T.getState().noteAgentTitle(tab.id, `${IDLE} Straight in`);
        await H.getState().flush();
        assert.equal(upsertsFor(direct, agent.sessionId).length, 1);
        assert.equal(fileEntry(key).title, 'Straight in');

        // A new record in the same terminal has seen no title yet.
        const again = await T.getState().startAgent(tab.id, 'claude');
        await H.getState().flush();
        const fresh2 = log.length;
        await showTitle(tab, `${IDLE} Straight in`);
        await H.getState().flush();
        assert.equal(upsertsFor(fresh2, again.sessionId).length, 1, 'the same text, told for the new conversation');
      } finally {
        unhear();
        unshown();
      }
    });
  });

  test('AHT-03: what sends nothing — the u2 titles, a terminal only offering its record, a claude typed by hand, a title before the recorder tracks it (AC36)', async () => {
    await fresh(async () => {
      const shown = [];
      const unshown = onAgentTitleShown((e) => shown.push(e));
      try {
        // u2: only the default.
        const { tab, agent, mark } = await claudeTerminal();
        for (const title of U2) await showTitle(tab, title);
        await H.getState().flush();
        assert.equal(upsertsFor(mark, agent.sessionId).length, 0, 'u2 sends none');

        // Offered only: a restored terminal's record.
        const offering = await readyTerminal('/workspace/tests');
        const { agent: offered } = startCommand('claude');
        T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === offering.id ? { ...t, agent: offered, agentResumeOffered: true } : t)) }));
        const offeredMark = log.length;
        for (const title of U3) await showTitle(offering, title);
        await H.getState().flush();
        assert.equal(upsertsFor(offeredMark, offered.sessionId).length, 0, 'an offer sends none');

        // Typed by hand, no id.
        const byHand = await readyTerminal('/workspace/docs');
        await typeLine(byHand.id, 'claude');
        await started(byHand);
        await H.getState().flush();
        assert.equal(tabById(byHand.id).agent?.kind, 'claude', 'premise: recorded');
        assert.equal(tabById(byHand.id).agent.sessionId, null, 'premise: no id');
        const handMark = log.length;
        for (const title of U3) await showTitle(byHand, title);
        await H.getState().flush();
        assert.equal(upsertsFor(handMark, null).length, 0, 'a claude typed by hand sends none');
        assert.deepEqual(shown, [], 'none of them was even told');
      } finally {
        unshown();
      }
    });

    await fresh(async () => {
      // The recorder not running: told, and let go.
      const tab = await readyTerminal();
      const agent = await T.getState().startAgent(tab.id, 'claude');
      const mark = log.length;
      for (const title of U3) await showTitle(tab, title);
      await H.getState().flush();
      assert.equal(upsertsFor(mark, agent.sessionId).length, 0, 'not tracked: nothing written');
    }, { record: false });
  });

  test('AHT-04: a live title is stored masked and cleaned; an archived running entry stays archived (AC35, AC41)', async () => {
    await fresh(async () => {
      const { tab, key } = await claudeTerminal();
      await H.getState().archive(key);
      await showTitle(tab, `${IDLE} Rotate ${TOKEN}\u202e\u0007 key`);
      await H.getState().flush();
      const title = fileEntry(key).title;
      assert.ok(title.includes('[hidden]'), `shows [hidden]: ${title}`);
      assert.ok(!title.includes(TOKEN.slice(4)), 'the secret is not kept');
      assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(title), 'no control or bidi characters');
      assert.ok(!fileText().includes(TOKEN.slice(4)), 'nowhere in the file');
      assert.equal(fileEntry(key).archived, true, 'a title never unarchives');
    });
  });

  test('AHT-05: a renamed Claude Code entry keeps its name after a live title, and after a restart; the title changes underneath (AC33)', async () => {
    await fresh(async () => {
      const { tab, key } = await claudeTerminal();
      await showTitle(tab, `${IDLE} First live`);
      await H.getState().flush();
      await H.getState().rename(key, 'Mine');
      await showTitle(tab, `${SPIN_A} Second live`);
      await H.getState().flush();
      assert.deepEqual([fileEntry(key).name, fileEntry(key).title], ['Mine', 'Second live']);
      const shown = historyDisplay(storeEntry(key));
      assert.deepEqual([shown.title, shown.autoTitle], ['Mine', 'Second live'], 'the side bar shows the name; the tooltip the title');
      await relaunch();
      assert.equal(historyDisplay(storeEntry(key)).title, 'Mine', 'after a restart');
      await showTitle(tab, `${IDLE} Third live`);
      await H.getState().flush();
      assert.deepEqual([fileEntry(key).name, fileEntry(key).title], ['Mine', 'Third live'], 'a live title after the restart, under the name');
      await H.getState().rename(key, '');
      assert.equal(historyDisplay(storeEntry(key)).title, 'Third live', 'an empty name shows the newest title');
    });
  });

  test('AHT-99: teardown — the stores, the storage and the mock as the next suite expects', async () => {
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ agentHistoryNotice: null });
    H.setState(emptyStore());
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      mockBridge.claudeTranscripts = before.transcripts;
      mockBridge.claudeSessionMarkers = before.markers;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    }
    assert.equal(H.getState().isRecording(), false);
  });
});
