/**
 * The AGENT SESSIONS menus of the side bar (F25-F30), as
 * src/components/terminal/agentSessionsModel.js builds them and
 * TerminalsPanel.jsx wires them to the history store and the questions.
 *
 * AC38 — the row, Move to Group ▸, group header and section header menus:
 * their items in order, their separators, and the reason every disabled item
 * gives (no id, running here, a newer file, its own group, no group, 50
 * groups); the rename rule. AC39 — Copy Session ID on the (stood-in)
 * clipboard; Delete…, Delete Group… and Clear chosen from the menus, asked,
 * declined and confirmed against the browser mock's file, the transcripts
 * untouched. AC40 — the palette's rows. AC41 (the UI path) — an archived
 * entry resumed from its row's menu, in a new terminal or the one holding it.
 *
 * Every backend call is logged; terminal writes are held. ASM-99 puts the
 * stores, the storage and the mock back.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useAgentHistoryStore } from '../../src/stores/agentHistoryStore.js';
import {
  clearAgentHistory,
  deleteAgentGroup,
  deleteAgentSession,
  useAgentHistoryPromptStore,
} from '../../src/stores/agentHistoryPromptStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { copyText } from '../../src/lib/copyText.js';
import { historyDisplay, renameChange } from '../../src/lib/agentHistory.js';
import { agentSessionRows, buildPaletteGroups } from '../../src/lib/paletteItems.js';
import { LIST_MENUS, resumeAgentSessionWith, subjectExists } from '../../src/components/terminal/statusBoardModel.js';
import {
  AGENT_SESSIONS_SHOWN,
  NOTHING_TO_CLEAR_REASON,
  NOT_GROUPED_REASON,
  NO_SESSIONS_REASON,
  NO_SESSION_ID_REASON,
  READ_ONLY_REASON,
  RUNNING_HERE_REASON,
  SAME_GROUP_REASON,
  TOO_MANY_GROUPS_REASON,
  agentGroupItems,
  agentSessionMoveItems,
  agentSessionRowItems,
  agentSessionsHeaderItems,
  agentSessionsView,
  groupOfEntry,
  isRunningHere,
  renamePrefill,
} from '../../src/components/terminal/agentSessionsModel.js';

const T = terminalStore.useTerminalStore;
const H = useAgentHistoryStore;
const P = useAgentHistoryPromptStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const SES = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const KEY = `claude:${UUID}`;
const DELAY = 40;
/** An icon stand-in: the builders only pass it on. */
const Marker = () => null;

/** An entry as `agent_history_list` answers. */
const E = { key: KEY, kind: 'claude', sessionId: UUID, cwd: '/workspace/src', title: 'Auto', startedAt: 1, lastUsedAt: 2 };
const labels = (items) => items.map((i) => (i.type === 'separator' ? '—' : i.label));
const byKey = (items, key) => items.find((i) => i.key === key);
/** `on` callbacks that only note what was called, and with what. */
function recorder() {
  const calls = [];
  const on = new Proxy({}, { get: (_, name) => (...args) => (calls.push([name, ...args]), name) });
  return { calls, on };
}

// ---- A disk of our own, every backend call logged, everything put back ---------

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const aiTitle = (title, sessionId = UUID) => ({ type: 'ai-title', aiTitle: title, sessionId });
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
const entry = (kind, sessionId, cwd = '/workspace/src', title = null, lastUsedAt = 2000) => ({
  kind, sessionId, cwd, title, startedAt: 1000, lastUsedAt, endedAt: lastUsedAt, endReason: 'closed',
});
const remember = async (e) => (await mockBridge.invoke('agent_history_upsert', { entry: e })).key;
const fileText = () => mockBridge.agentHistoryFile() ?? '';
const fileDoc = () => JSON.parse(fileText());
const fileEntry = (key) => fileDoc().entries.find((e) => e.key === key);
const storeEntry = (key) => H.getState().entries.find((e) => e.key === key);
const keysListed = async () => (await mockBridge.invoke('agent_history_list')).map((e) => e.key).sort();

const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
let before = null;
const log = [];
const emptyStore = () => ({ entries: [], loaded: false, error: null, holders: {}, groups: [], readOnly: false, version: null });

async function fresh(fn) {
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
    const item = { command, args: args === undefined ? undefined : structuredClone(args) };
    log.push(item);
    if (command === 'pty_write') return null;
    return original.call(this, command, args, ...rest);
  };
  try {
    H.getState().start({ delayMs: DELAY });
    await H.getState().load();
    await fn();
  } finally {
    await H.getState().stop();
    mockBridge.invoke = original;
    unsink();
    P.getState().answer(false);
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    mockBridge.agentSessions = [];
    mockBridge.claudeTranscripts = null;
    mockBridge.claudeSessionMarkers = [];
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  }
}

describe('AGENT SESSIONS menus: items, reasons, questions, palette (F25-F30)', () => {
  // ---- AC38: the menus ---------------------------------------------------------

  test('ASM-01: a row’s menu — Resume or Show Its Terminal, Copy Session ID, Pin or Unpin, Rename…, Move to Group ▸, Archive or Unarchive, Delete…, with F26’s separators (AC38)', () => {
    const { calls, on } = recorder();
    const items = agentSessionRowItems(E, { on });
    assert.deepEqual(labels(items), ['Resume in New Terminal', '—', 'Copy Session ID', '—', 'Pin', 'Rename…', 'Move to Group ▸', '—', 'Archive', 'Delete…']);
    assert.deepEqual(items.filter((i) => i.type === 'separator').map((i) => i.key), ['s1', 's2', 's3'], 'separator keys are unique');
    assert.ok(items.every((i) => i.type === 'separator' || (!i.disabled && typeof i.onSelect === 'function')), 'all on');
    assert.deepEqual(items.filter((i) => i.danger).map((i) => i.label), ['Delete…'], 'only Delete… is dangerous');
    for (const i of items) i.onSelect?.();
    assert.deepEqual(calls, [['resume', KEY], ['copyId', UUID], ['pin', KEY], ['rename', E], ['moveMenu', E], ['archive', KEY], ['remove', KEY]]);

    calls.length = 0;
    const other = agentSessionRowItems({ ...E, pinned: true, archived: true }, { holder: { tabId: 't1', state: 'offered' }, icons: { resume: Marker }, on });
    assert.deepEqual(labels(other), ['Show Its Terminal', '—', 'Copy Session ID', '—', 'Unpin', 'Rename…', 'Move to Group ▸', '—', 'Unarchive', 'Delete…']);
    assert.equal(other[0].icon, Marker);
    assert.equal(items[0].icon, undefined, 'no icon unless given');
    for (const i of other) i.onSelect?.();
    assert.deepEqual(calls.map(([name]) => name), ['resume', 'copyId', 'unpin', 'rename', 'moveMenu', 'unarchive', 'remove']);
    assert.ok(!labels(items).concat(labels(other)).some((l) => /Remove from List|Clear Agent Session History/.test(l)), 'no Remove from List, no Clear on a row');
  });

  test('ASM-02: Copy Session ID puts exactly the session id on the clipboard; off with a reason for an entry without one (AC38, AC39)', async () => {
    const { calls, on } = recorder();
    const idless = byKey(agentSessionRowItems({ ...E, key: 'claude:/workspace/src', sessionId: null }, { on }), 'copy-id');
    assert.equal(idless.disabled, true);
    assert.equal(idless.disabledReason, "NexTerm does not know this session's id");
    assert.equal(NO_SESSION_ID_REASON, idless.disabledReason);
    assert.equal(byKey(agentSessionRowItems({ ...E, sessionId: '' }, { on }), 'copy-id').disabled, true, 'an empty id is none');
    assert.deepEqual(calls, []);

    // What the panel wires it to: copyText, here onto a stood-in clipboard.
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const written = [];
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async (text) => void written.push(text) } },
      configurable: true,
      writable: true,
    });
    try {
      for (const e of [E, { ...E, key: `opencode:${SES}`, kind: 'opencode', sessionId: SES, title: 'Named so' }]) {
        const item = byKey(agentSessionRowItems(e, { on: { copyId: (sessionId) => copyText(sessionId) } }), 'copy-id');
        assert.equal(await item.onSelect(), true, 'copied');
      }
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved);
      else delete globalThis.navigator;
    }
    assert.deepEqual(written, [UUID, SES], 'exactly the ids, nothing around them');
    assert.match(source('../../src/components/terminal/TerminalsPanel.jsx'), /copyId: \(sessionId\) => copyText\(sessionId\),/);
  });

  test('ASM-03: Delete… is off, saying why, while a terminal of this window runs the entry; on when offered or held by none (AC38, F26)', () => {
    const { on } = recorder();
    const running = byKey(agentSessionRowItems(E, { holder: { tabId: 't1', state: 'open' }, on }), 'delete');
    assert.equal(running.disabled, true);
    assert.equal(running.disabledReason, 'It is running in a terminal of this window; end the agent first');
    assert.equal(RUNNING_HERE_REASON, running.disabledReason);
    for (const holder of [null, { tabId: 't1', state: 'offered' }]) {
      const item = byKey(agentSessionRowItems(E, { holder, on }), 'delete');
      assert.ok(!item.disabled && !item.disabledReason, JSON.stringify(holder));
    }
    assert.equal(isRunningHere({ state: 'open' }), true);
    assert.equal(isRunningHere({ state: 'offered' }), false);
    assert.equal(isRunningHere(null), false);
    // The store's deleteEntry does not refuse one running here: the panel must pass the holder.
    assert.match(source('../../src/components/terminal/TerminalsPanel.jsx'), /agentSessionRowItems\(entry, \{\n\s*holder: agentHolders\[entry\.key\] \?\? null,\n\s*readOnly: agentReadOnly,/);
  });

  test('ASM-04: a list a newer NexTerm wrote — every curation item off with the read-only reason; Resume and Copy Session ID stay on (AC38, F30)', () => {
    const { on } = recorder();
    assert.equal(READ_ONLY_REASON, 'A newer NexTerm wrote this list; this version only reads it');
    const CURATION = new Set(['pin', 'unpin', 'rename', 'move-group', 'archive', 'unarchive', 'delete']);
    for (const e of [E, { ...E, pinned: true, archived: true, groupId: 'g-1' }]) {
      for (const holder of [null, { tabId: 't1', state: 'open' }]) {
        const items = agentSessionRowItems(e, { holder, readOnly: true, on });
        const curation = items.filter((i) => CURATION.has(i.key));
        assert.equal(curation.length, 5);
        for (const i of curation) assert.deepEqual([i.key, i.disabled, i.disabledReason], [i.key, true, READ_ONLY_REASON]);
        assert.ok(!byKey(items, 'resume').disabled && !byKey(items, 'copy-id').disabled, 'Resume and Copy stay on');
      }
    }
    const groups = [{ id: 'g-1', name: 'Work', collapsed: false }, { id: 'g-2', name: 'Other', collapsed: false }];
    const move = agentSessionMoveItems({ ...E, groupId: 'g-1' }, { groupRows: agentSessionsView([], groups).groups, readOnly: true, on });
    for (const i of move.filter((x) => x.type !== 'separator' && x.key !== 'back')) assert.deepEqual([i.label, i.disabledReason], [i.label, READ_ONLY_REASON]);
    assert.ok(!byKey(move, 'back').disabled);
    for (const i of agentGroupItems(groups[0], { readOnly: true, on })) assert.deepEqual([i.label, i.disabled, i.disabledReason], [i.label, true, READ_ONLY_REASON]);
    const header = agentSessionsHeaderItems({ entries: [E], groups, readOnly: true, on });
    assert.equal(byKey(header, 'new-group').disabledReason, READ_ONLY_REASON);
    // FX-2: Clear is off too — this build cannot clear a newer file — and Resume Agent Session… stays on.
    assert.deepEqual([byKey(header, 'clear').disabled, byKey(header, 'clear').disabledReason], [true, READ_ONLY_REASON], 'Clear is off with the read-only reason');
    assert.ok(!byKey(header, 'resume-pick').disabled, 'Resume Agent Session… stays on');
    const nothing = agentSessionsHeaderItems({ entries: [], groups: [], readOnly: true, on });
    assert.equal(byKey(nothing, 'clear').disabledReason, READ_ONLY_REASON, 'read-only comes before nothing to clear');
  });

  test('ASM-05: Move to Group ▸ — Back, every group as "name (n)" with its own off, New Group…, Remove from Group off when ungrouped; 50 groups (AC38, F26)', () => {
    const { calls, on } = recorder();
    const groups = [{ id: 'g-1', name: 'Work', collapsed: false }, { id: 'g-2', name: 'Other', collapsed: true }];
    const entries = [
      { ...E, groupId: 'g-1' },
      { ...E, key: 'opencode:x', kind: 'opencode', sessionId: SES, groupId: 'g-1', lastUsedAt: 3 },
      { ...E, key: 'claude:/w', sessionId: null, groupId: 'g-1', pinned: true },
    ];
    const rows = agentSessionsView(entries, groups).groups;
    const items = agentSessionMoveItems(entries[0], { groupRows: rows, icons: { back: Marker }, on });
    assert.deepEqual(labels(items), ['Back', '—', 'Work (2)', 'Other (0)', '—', 'New Group…', 'Remove from Group'], 'n is the rows under the header: the pinned one is not');
    assert.equal(items[0].icon, Marker);
    assert.deepEqual([byKey(items, 'group-g-1').disabled, byKey(items, 'group-g-1').disabledReason], [true, 'It is already in this group']);
    assert.equal(SAME_GROUP_REASON, 'It is already in this group');
    for (const i of items) if (!i.disabled) i.onSelect?.();
    assert.deepEqual(calls, [['back'], ['moveToGroup', KEY, 'g-2'], ['newGroup', KEY], ['removeFromGroup', KEY]]);

    for (const e of [E, { ...E, groupId: 'g-gone' }]) {
      const ungrouped = agentSessionMoveItems(e, { groupRows: rows, on });
      assert.deepEqual([byKey(ungrouped, 'remove-group').disabled, byKey(ungrouped, 'remove-group').disabledReason], [true, 'It is not in a group']);
      assert.ok(!byKey(ungrouped, 'group-g-1').disabled && !byKey(ungrouped, 'group-g-2').disabled, 'every group is on');
    }
    assert.equal(NOT_GROUPED_REASON, 'It is not in a group');
    assert.deepEqual(labels(agentSessionMoveItems(E, { groupRows: [], on })), ['Back', '—', 'New Group…', 'Remove from Group'], 'no groups: no empty run between separators');

    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, collapsed: false }));
    const full = byKey(agentSessionMoveItems(E, { groupRows: agentSessionsView([], fifty).groups, on }), 'new-group');
    assert.deepEqual([full.disabled, full.disabledReason], [true, 'There can be at most 50 agent session groups']);
    assert.equal(TOO_MANY_GROUPS_REASON, full.disabledReason);
    assert.ok(!byKey(agentSessionMoveItems(E, { groupRows: agentSessionsView([], fifty.slice(1)).groups, on }), 'new-group').disabled, '49 groups: on');
  });

  test('ASM-06: a group header’s menu is Rename Group…, Delete Group…; the section header’s is Resume Agent Session…, New Group…, Clear Agent Session History… (AC38, F27)', () => {
    const { calls, on } = recorder();
    const group = { id: 'g-1', name: 'Work', collapsed: false };
    const items = agentGroupItems(group, { on });
    assert.deepEqual(labels(items), ['Rename Group…', 'Delete Group…']);
    assert.deepEqual(items.map((i) => Boolean(i.danger)), [false, true]);
    for (const i of items) i.onSelect();
    assert.deepEqual(calls, [['rename', group], ['remove', 'g-1']]);

    calls.length = 0;
    const header = agentSessionsHeaderItems({ entries: [E], groups: [group], on });
    assert.deepEqual(labels(header), ['Resume Agent Session…', 'New Group…', '—', 'Clear Agent Session History…']);
    assert.ok(header.every((i) => i.type === 'separator' || !i.disabled));
    assert.equal(byKey(header, 'clear').danger, true);
    for (const i of header) i.onSelect?.();
    assert.deepEqual(calls, [['pick'], ['newGroup'], ['clear']]);

    const none = agentSessionsHeaderItems({ entries: [], groups: [], on });
    assert.deepEqual([byKey(none, 'resume-pick').disabledReason, byKey(none, 'clear').disabledReason], [NO_SESSIONS_REASON, NOTHING_TO_CLEAR_REASON]);
    assert.ok(!byKey(none, 'new-group').disabled, 'a group can be made before any entry');
    assert.ok(!byKey(agentSessionsHeaderItems({ entries: [], groups: [group], on }), 'clear').disabled, 'a group alone is something to clear');
    assert.ok(!byKey(agentSessionsHeaderItems({ entries: [{ ...E, archived: true }], groups: [], on }), 'clear').disabled, 'an archived entry too');
    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }));
    assert.equal(byKey(agentSessionsHeaderItems({ entries: [E], groups: fifty, on }), 'new-group').disabledReason, TOO_MANY_GROUPS_REASON);
  });

  test('ASM-07: Rename… — prefilled with a name or title, else empty; empty clears, the automatic title while unnamed changes nothing, the rest is stored cleaned and masked (AC38)', async () => {
    assert.equal(renamePrefill({ ...E, name: 'Mine' }), 'Mine');
    assert.equal(renamePrefill(E), 'Auto');
    assert.equal(renamePrefill({ ...E, title: null }), '', 'a short id is not a name');
    assert.equal(renamePrefill({ ...E, key: 'claude:/w', sessionId: null, title: null }), '');
    assert.equal(renameChange(E, '   '), null, 'nothing to clear');
    assert.deepEqual(renameChange({ ...E, name: 'Mine' }, ''), { name: null });
    assert.equal(renameChange(E, '  Auto  '), null, 'its own title, unnamed');
    assert.deepEqual(renameChange({ ...E, name: 'Mine' }, 'Auto'), { name: 'Auto' }, 'named: the title is a new name');
    const masked = renameChange(E, `Rotate \u0007${TOKEN}\u202e now`).name;
    assert.ok(!masked.includes(TOKEN) && /\[hidden\]/.test(masked) && !/[\u0000-\u001f\u202a-\u202e]/.test(masked), masked);

    await fresh(async () => {
      await remember(entry('claude', UUID, '/workspace/src', 'Auto'));
      await H.getState().load();
      const sent = (mark) => log.slice(mark).filter((c) => c.command === 'agent_history_update');
      let mark = log.length;
      await H.getState().rename(KEY, '  Auto ');
      assert.deepEqual(sent(mark), [], 'the automatic title while unnamed sends nothing');
      assert.ok(!('name' in fileEntry(KEY)));
      mark = log.length;
      await H.getState().rename(KEY, `Rotate \u0007${TOKEN} now`);
      assert.equal(sent(mark).length, 1);
      const name = fileEntry(KEY).name;
      assert.ok(name.startsWith('Rotate ') && name.endsWith(' now') && !name.includes(TOKEN) && /\[hidden\]/.test(name), name);
      assert.equal(historyDisplay(storeEntry(KEY)).title, name, 'the row shows the name');
      await H.getState().rename(KEY, '');
      assert.ok(!('name' in fileEntry(KEY)), 'empty clears it');
      assert.equal(historyDisplay(storeEntry(KEY)).title, 'Auto', 'and the automatic title is back');
    });
    const panel = source('../../src/components/terminal/TerminalsPanel.jsx');
    assert.match(panel, /rename: \(e\) => startRename\('agent-session', e\.key, renamePrefill\(e\)\),/);
    assert.match(panel, /else if \(draft\.kind === 'agent-session'\) agentHistory\(\)\.rename\(draft\.id, value\);/);
    assert.match(panel, /else if \(draft\.kind === 'agent-group'\) agentHistory\(\)\.renameGroup\(draft\.id, value\);/);
  });

  // ---- AC39: copy, delete and the questions ----------------------------------------

  test('ASM-08: Delete…, Delete Group… and Clear from the menus ask first; Cancel changes nothing; yes removes only what it says; the transcripts stay (AC39)', async () => {
    await fresh(async () => {
      const K1 = await remember(entry('claude', UUID, '/workspace/src', 'First'));
      const K2 = await remember(entry('opencode', SES, '/workspace/tests', 'Second'));
      await H.getState().load();
      mockBridge.claudeTranscripts = { [UUID]: [aiTitle('First')] };
      const transcripts = structuredClone(mockBridge.claudeTranscripts);
      // As the panel wires a row's menu.
      const rowMenu = (key) =>
        agentSessionRowItems(storeEntry(key), {
          holder: H.getState().holders[key] ?? null,
          readOnly: H.getState().readOnly,
          on: { remove: (k) => deleteAgentSession(k) },
        });

      const textBefore = fileText();
      let pending = byKey(rowMenu(K1), 'delete').onSelect();
      let asked = P.getState().prompt;
      assert.deepEqual([asked?.kind, asked?.key], ['delete', K1]);
      assert.equal(asked.question.title, 'Delete Agent Session?');
      assert.equal(asked.question.confirmLabel, 'Delete');
      assert.match(asked.question.message, /“First”/);
      assert.match(asked.question.message, /The conversation itself stays with Claude Code, and NexTerm deletes none of its files\./);
      P.getState().answer(false);
      assert.equal(await pending, null, 'Cancel');
      assert.equal(fileText(), textBefore, 'Cancel changes nothing');
      assert.deepEqual(await keysListed(), [K1, K2].sort());
      pending = byKey(rowMenu(K1), 'delete').onSelect();
      P.getState().answer(true);
      assert.equal(await pending, true);
      assert.deepEqual(await keysListed(), [K2], 'only that entry went');
      assert.deepEqual(mockBridge.claudeTranscripts, transcripts, 'a delete leaves the transcripts');

      const g = await H.getState().createGroup({ name: 'Work', moveKey: K2 });
      const groupMenu = agentGroupItems(g, { on: { remove: (id) => deleteAgentGroup(id) } });
      pending = byKey(groupMenu, 'delete-group').onSelect();
      asked = P.getState().prompt;
      assert.deepEqual([asked?.kind, asked?.groupId, asked?.question.title], ['deleteGroup', g.id, 'Delete Group?']);
      assert.match(asked.question.message, /Its 1 session goes back to the list; none is deleted\./);
      P.getState().answer(false);
      assert.equal(await pending, null);
      assert.equal(fileEntry(K2).groupId, g.id, 'No: still grouped');
      pending = byKey(groupMenu, 'delete-group').onSelect();
      P.getState().answer(true);
      assert.equal(await pending, 1);
      assert.ok(fileEntry(K2) && !('groupId' in fileEntry(K2)), 'its member is ungrouped, not deleted');
      assert.deepEqual(H.getState().groups, []);

      await H.getState().createGroup({ name: 'Again' });
      const header = agentSessionsHeaderItems({ entries: H.getState().entries, groups: H.getState().groups, on: { clear: () => clearAgentHistory() } });
      pending = byKey(header, 'clear').onSelect();
      asked = P.getState().prompt;
      assert.equal(asked?.kind, 'clear');
      assert.match(asked.question.message, /^1 entry will be removed from AGENT SESSIONS, with the damaged copies/);
      assert.match(asked.question.message, /every group goes too/);
      P.getState().answer(true);
      assert.equal(await pending, 1);
      assert.deepEqual(fileDoc(), { version: 1, entries: [] }, 'entries and groups gone');
      assert.deepEqual(mockBridge.claudeTranscripts, transcripts, 'a clear leaves the transcripts');
    });
    // The one dialog draws each prompt's own words, Cancel focused, as a danger.
    const dialog = source('../../src/components/terminal/AgentHistoryClearDialog.jsx');
    assert.match(dialog, /const question = prompt\.question \?\? clearAgentHistoryQuestion\(prompt\.count\);/);
    assert.match(dialog, /title=\{question\.title\}\s+message=\{question\.message\}\s+confirmLabel=\{question\.confirmLabel\}\s+danger\s+initialFocus="cancel"/);
    const panel = source('../../src/components/terminal/TerminalsPanel.jsx');
    assert.match(panel, /remove: \(groupId\) => deleteAgentGroup\(groupId\),/);
    assert.match(source('../../src/components/terminal/AgentHistoryNotice.jsx'), /curationFailed: 'Agent session not changed',/);
  });

  // ---- AC40: the palette ---------------------------------------------------------

  test('ASM-09: the palette — pinned first, then newest first, then archived; a name or a group’s name finds an entry; the ordinary palette never lists an archived one (AC40, F28)', () => {
    const groups = [{ id: 'g-q', name: 'Quarterly', collapsed: false }];
    const list = [
      { key: 'k-old-pinned', kind: 'opencode', sessionId: null, cwd: '/w/a', title: 'Old but pinned', pinned: true, lastUsedAt: 10 },
      { key: 'k-new', kind: 'opencode', sessionId: null, cwd: '/w/b', title: 'Newest', lastUsedAt: 90 },
      { key: 'k-mid', kind: 'claude', sessionId: UUID, cwd: '/w/c', title: 'Middle', name: 'Zebra crossing', groupId: 'g-q', lastUsedAt: 50 },
      { key: 'k-arch', kind: 'opencode', sessionId: null, cwd: '/w/d', title: 'Newest archived', archived: true, lastUsedAt: 99 },
      { key: 'k-arch-pinned', kind: 'opencode', sessionId: null, cwd: '/w/e', title: 'Older archived', archived: true, pinned: true, lastUsedAt: 5 },
    ];
    const pick = (query = '') => buildPaletteGroups({ mode: 'agent-sessions', query, agentSessions: list, agentGroups: groups });
    const all = pick();
    assert.deepEqual(all.map((g) => g.label), ['agent sessions', 'archived agent sessions']);
    assert.deepEqual(all[0].items.map((r) => r.historyKey), ['k-old-pinned', 'k-new', 'k-mid']);
    assert.deepEqual(all[1].items.map((r) => r.historyKey), ['k-arch', 'k-arch-pinned'], 'archived: newest first, a pin aside');
    assert.deepEqual(all[0].items.map((r) => r.hint), ['opencode · pinned', 'opencode', 'Claude Code']);
    assert.equal(all[1].items[1].hint, 'opencode');
    const mid = all[0].items[2];
    assert.deepEqual([mid.title, mid.subtitle], ['Zebra crossing', '/w/c · Quarterly'], "a grouped row's subtitle names its group");
    for (const query of ['zebra', 'QUARTERLY', 'zebra quarterly']) {
      assert.deepEqual(pick(query).flatMap((g) => g.items.map((r) => r.historyKey)), ['k-mid'], query);
    }
    assert.deepEqual(pick('older archived').map((g) => g.label), ['archived agent sessions'], 'only archived rows: only their group');
    assert.equal(pick('nothing like it')[0].note, 'No agent session matches.');
    assert.deepEqual(agentSessionRows(list).map((r) => r.historyKey), ['k-old-pinned', 'k-new', 'k-mid'], 'never archived by default');

    const ordinary = (query) => buildPaletteGroups({ mode: 'all', query, agentSessions: list, agentGroups: groups }).find((g) => g.label === 'agent sessions');
    assert.deepEqual(ordinary('newest').items.map((r) => r.historyKey), ['k-new'], 'the archived Newest is not listed');
    assert.equal(ordinary('older archived'), undefined, 'an archived entry alone: no group');
    assert.deepEqual(ordinary('quarterly').items.map((r) => r.historyKey), ['k-mid']);
    // Selecting a row resumes by its key (CommandPalette.jsx), with the groups passed in.
    const palette = source('../../src/components/command/CommandPalette.jsx');
    assert.match(palette, /item\.type === 'agent-session'\) \{[^}]*await resumeFromHistory\?\.\(item\.historyKey\);/);
    assert.match(palette, /agentGroups: Array\.isArray\(agentGroups\) \? agentGroups : \[\],/);
    assert.ok(all.flatMap((g) => g.items).every((r) => r.type === 'agent-session' && r.historyKey === r.id.replace(/^agent-session-/, '')));
  });

  // ---- AC41 (the UI path): archived entries come back ------------------------------

  test('ASM-10: Resume in New Terminal on an archived row opens it; the resumed write unarchives it, keeping its name, pin and group (AC41)', async () => {
    await fresh(async () => {
      await readyTerminal();
      await remember(entry('claude', UUID, '/workspace/src'));
      await H.getState().load();
      const g = await H.getState().createGroup({ name: 'Keep', moveKey: KEY });
      await H.getState().rename(KEY, 'Named');
      await H.getState().pin(KEY);
      await H.getState().archive(KEY);
      assert.equal(fileEntry(KEY).archived, true, 'premise');
      const selected = [];
      // As the panel wires it: resumeAgentSessionWith and the terminal store's resumeFromHistory.
      const resume = (key) => resumeAgentSessionWith(key, { select: (k) => selected.push(k), resumeFromHistory: T.getState().resumeFromHistory });
      const item = byKey(agentSessionRowItems(storeEntry(KEY), { holder: H.getState().holders[KEY] ?? null, on: { resume } }), 'resume');
      assert.equal(item.label, 'Resume in New Terminal');
      const tabsBefore = T.getState().tabs.length;
      const pending = item.onSelect();
      await until(() => T.getState().tabs.length > tabsBefore && tabById(T.getState().activeTabId)?.agentHistoryKey === KEY, 'the new terminal');
      await sleep(20);
      await prompt(tabById(T.getState().activeTabId));
      const result = await pending;
      assert.equal(result.outcome, 'opened');
      assert.deepEqual(selected, [KEY], 'the row is selected');
      await H.getState().flush();
      const kept = fileEntry(KEY);
      assert.ok(!('archived' in kept), 'no longer archived');
      assert.deepEqual([kept.name, kept.pinned, kept.groupId], ['Named', true, g.id]);
      assert.equal(agentSessionsView(H.getState().entries, H.getState().groups).pinned[0]?.key, KEY, 'back in the pinned area');
    });
  });

  test('ASM-11: Show Its Terminal on an archived row a terminal runs focuses it and unarchives the entry; Delete… is off meanwhile (AC41, prior AC14, F26)', async () => {
    await fresh(async () => {
      const tab = await readyTerminal('/workspace/src');
      const agent = await T.getState().startAgent(tab.id, 'claude');
      await H.getState().flush();
      const K = `claude:${agent.sessionId}`;
      await H.getState().archive(K);
      await readyTerminal();
      await until(() => H.getState().holders[K]?.state === 'open', 'the holder');
      const items = agentSessionRowItems(storeEntry(K), {
        holder: H.getState().holders[K],
        on: { resume: (key) => resumeAgentSessionWith(key, { select: () => {}, resumeFromHistory: T.getState().resumeFromHistory }) },
      });
      assert.equal(byKey(items, 'resume').label, 'Show Its Terminal');
      assert.equal(byKey(items, 'delete').disabledReason, RUNNING_HERE_REASON);
      const tabsBefore = T.getState().tabs.length;
      const result = await byKey(items, 'resume').onSelect();
      assert.deepEqual([result.outcome, result.tabId], ['focused', tab.id]);
      assert.equal(T.getState().activeTabId, tab.id);
      assert.equal(T.getState().tabs.length, tabsBefore, 'no new terminal');
      await until(() => log.some((c) => c.command === 'agent_history_update' && c.args?.key === K && c.args?.changes?.archived === false), 'the unarchive');
      await H.getState().flush();
      assert.ok(!('archived' in fileEntry(K)), 'unarchived');
    });
  });

  // ---- The section's layout as data, and the panel's wiring ------------------------

  test('ASM-12: agentSessionsView — 15 rows then Show all, Archived closed by default, folded only for a read-only list, the hint; the group header menu closes with its group', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, kind: 'opencode', lastUsedAt: 100 - i }));
    const archived = Array.from({ length: 17 }, (_, i) => ({ key: `a${i}`, kind: 'opencode', archived: true, lastUsedAt: 50 - i }));
    const groups = [{ id: 'g', name: 'G', collapsed: false }];
    const closed = agentSessionsView([...many, ...archived], groups);
    assert.equal(AGENT_SESSIONS_SHOWN, 15);
    assert.deepEqual([closed.count, closed.ungrouped.length, closed.ungroupedMore, closed.empty], [20, 15, true, false]);
    assert.deepEqual([closed.archived.count, closed.archived.open, closed.archived.rows.length, closed.archived.more], [17, false, 0, false]);
    const open = agentSessionsView([...many, ...archived], groups, { archivedOpen: true });
    assert.deepEqual([open.archived.rows.length, open.archived.more, open.archived.rows[0].key], [15, true, 'a0']);
    const member = { key: 'm', kind: 'opencode', groupId: 'g', lastUsedAt: 1 };
    assert.deepEqual(agentSessionsView([member], groups).groups.map((x) => [x.collapsed, x.count, x.rows.length]), [[false, 1, 1]]);
    assert.deepEqual(agentSessionsView([member], groups, { folded: { g: true } }).groups.map((x) => [x.collapsed, x.count, x.rows.length]), [[true, 1, 0]]);
    assert.deepEqual(agentSessionsView([member], [{ ...groups[0], collapsed: true }], { folded: { g: false } }).groups[0].rows.length, 1);
    assert.equal(agentSessionsView([], []).empty, true);
    assert.equal(agentSessionsView(archived, []).empty, true, 'only archived: the hint');
    assert.equal(agentSessionsView([], groups).empty, false, 'a group: no hint');
    assert.deepEqual(groupOfEntry(member, groups), groups[0]);
    assert.equal(groupOfEntry({ groupId: 'gone' }, groups), null);

    const has = { agentGroup: (id) => id === 'g' };
    assert.equal(subjectExists('agent-group', 'g', has), true);
    assert.equal(subjectExists('agent-group', 'gone', has), false);
    assert.equal(subjectExists('agent-group', 'g', {}), false);
    assert.ok(LIST_MENUS.has('agent-group'));
    const panel = source('../../src/components/terminal/TerminalsPanel.jsx');
    assert.match(panel, /agentGroup: \(id\) => agentGroups\.some\(\(group\) => group\.id === id\),/);
    // A read-only list folds on screen only; otherwise the fold is saved.
    assert.match(panel, /if \(agentReadOnly\) setAgentFolded\(\(prev\) => \(\{ \.\.\.prev, \[group\.id\]: !collapsedNow \}\)\);\n\s*else agentHistory\(\)\.setGroupCollapsed\(group\.id, !collapsedNow\);/);
    // New Group…: one write, then the inline editor on its header.
    assert.match(panel, /agentHistory\(\)\.createGroup\(moveKey \? \{ moveKey \} : \{\}\);\n\s*if \(!group\) return;[^\n]*\n\s*setAgentOpen\(true\);\n\s*setDraft\(\{ kind: 'agent-group', id: group\.id, value: group\.name \}\);/);
    assert.doesNotMatch(panel, /removeAgentEntry|Remove from List/);
  });

  test('ASM-13: Move to Group ▸ with 50 groups — Back, the 50 groups in stored order, New Group… off with the 50-groups reason, Remove from Group, in that order (FX-1, F26)', () => {
    const { on } = recorder();
    // Stored in an order that is neither by name nor by id.
    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `g${(i * 7) % 50}`, name: `Group ${49 - i}`, collapsed: i % 2 === 0 }));
    const entries = [{ ...E, groupId: 'g7' }];
    const items = agentSessionMoveItems(entries[0], { groupRows: agentSessionsView(entries, fifty).groups, on });
    assert.deepEqual(
      labels(items),
      ['Back', '—', ...fifty.map((g) => `${g.name} (${g.id === 'g7' ? 1 : 0})`), '—', 'New Group…', 'Remove from Group']
    );
    assert.deepEqual(items.filter((i) => i.key?.startsWith('group-')).map((i) => i.key), fifty.map((g) => `group-${g.id}`), 'in stored order');
    assert.deepEqual([byKey(items, 'new-group').disabled, byKey(items, 'new-group').disabledReason], [true, TOO_MANY_GROUPS_REASON]);
    assert.ok(!byKey(items, 'remove-group').disabled, 'Remove from Group is on for a grouped entry');
    assert.equal(items.at(-1).key, 'remove-group', 'and is the last item');
  });

  test('ASM-14: Clear chosen from the palette for a list a newer NexTerm wrote asks nothing, sends nothing, says why, and leaves the file as it is (FX-2, F30)', async () => {
    await fresh(async () => {
      const k = await remember(entry('claude', UUID, '/workspace/src', 'First'));
      await mockBridge.invoke('agent_history_group_create', { group: { id: 'g1', name: 'Work' }, move_key: k });
      mockBridge.agentHistoryCorruptFile(JSON.stringify({ ...fileDoc(), version: 3 }));
      await H.getState().load();
      assert.equal(H.getState().readOnly, true, 'premise: a newer file, read only');
      assert.equal(H.getState().version, 3);
      const text = fileText();
      T.setState({ agentHistoryNotice: null });
      const mark = log.length;
      const pending = clearAgentHistory();
      assert.equal(P.getState().prompt, null, 'no question is asked');
      assert.equal(await pending, null, 'it resolves as a declined question does');
      assert.equal(P.getState().prompt, null);
      assert.equal(log.slice(mark).filter((c) => c.command === 'agent_history_clear').length, 0, 'no clear reaches the backend');
      const notice = T.getState().agentHistoryNotice;
      assert.deepEqual([notice?.kind, notice?.text], ['clearFailed', READ_ONLY_REASON], 'the "not cleared" notice says why');
      assert.equal(fileText(), text, 'the file is byte for byte as it was');
      assert.deepEqual(H.getState().entries.map((e) => e.key), [k], 'and still listed');

      // A list this build writes is asked about as before.
      mockBridge.agentHistoryCorruptFile(JSON.stringify({ ...JSON.parse(text), version: 2 }));
      await H.getState().load();
      assert.equal(H.getState().readOnly, false);
      const again = clearAgentHistory();
      assert.equal(P.getState().prompt?.kind, 'clear', 'writable: the question is asked');
      P.getState().answer(false);
      assert.equal(await again, null);
    });
    assert.match(source('../../src/components/terminal/AgentHistoryNotice.jsx'), /clearFailed: 'Agent session history not cleared',/);
  });

  test('ASM-99: teardown — the stores, the storage and the mock as the next suite expects', async () => {
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ agentHistoryNotice: null });
    H.setState(emptyStore());
    P.getState().answer(false);
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      mockBridge.claudeTranscripts = before.transcripts;
      mockBridge.claudeSessionMarkers = before.markers;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    }
    assert.equal(P.getState().prompt, null);
    assert.equal(H.getState().isRecording(), false);
  });
});
