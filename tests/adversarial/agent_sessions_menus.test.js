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
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun } from './react_page.js';
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
import { entryOfAgent, forkedFromText, historyDisplay, historyTitle, renameChange } from '../../src/lib/agentHistory.js';
import { agentSessionRows, buildPaletteGroups } from '../../src/lib/paletteItems.js';
import { LIST_MENUS, resumeAgentSessionWith, subjectExists } from '../../src/components/terminal/statusBoardModel.js';
import {
  AGENT_SESSIONS_SHOWN,
  FORK_OPENCODE_REASON,
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
  agentSessionTooltip,
  agentSessionsHeaderItems,
  agentSessionsView,
  drawnAgentSessionKeys,
  droppedRenameNotice,
  groupOfEntry,
  isRunningHere,
  LAUNCHER_SESSIONS_SHOWN,
  launcherSessions,
  renameNotSavedText,
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

// ---- The empty pane's launcher, mounted (bundle 1, A2) -------------------------
// EmptyPaneLauncher.jsx bundled with esbuild and imported from a data: URL, as
// workbench_bundle.js does: React and every plain module — the stores above
// all — are the app's own, by file URL, so the launcher drives the very store
// and mock these cases watch. lucide's icons are stood in for.
const TERMINAL_DIR = fileURLToPath(new URL('../../src/components/terminal/', import.meta.url));

/** The names `file` imports from lucide-react, each an icon that draws nothing. */
function lucideStandIn(file) {
  const names = new Set();
  for (const m of readFileSync(file, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return `const Icon = () => null; ${[...names].map((n) => `export const ${n} = Icon;`).join(' ')}`;
}

let launcherLoading = null;
function loadLauncher() {
  launcherLoading ??= build({
    stdin: {
      contents: "export { EmptyPaneLauncher } from './EmptyPaneLauncher.jsx';",
      resolveDir: TERMINAL_DIR,
      sourcefile: 'launcher-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'launcher-modules',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === 'lucide-react') return { path: args.importer, namespace: 'lucide' };
            if (args.path.endsWith('.jsx')) return undefined;
            if (args.path.startsWith('.') && args.resolveDir) {
              return { path: pathToFileURL(resolvePath(args.resolveDir, args.path)).href, external: true };
            }
            return { path: import.meta.resolve(args.path), external: true };
          });
          b.onLoad({ filter: /.*/, namespace: 'lucide' }, (args) => ({ contents: lucideStandIn(args.path), loader: 'js' }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return launcherLoading;
}

/** Every leaf of the group on screen, as `{ id, tabIds }`. */
function leavesOnScreen() {
  const state = T.getState();
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  const leaves = [];
  const walk = (n) => (n?.type === 'leaf' ? leaves.push({ id: n.id, tabIds: [...n.tabIds] }) : n?.children?.forEach(walk));
  walk(group?.tree);
  return { groupId: group?.id ?? null, activePaneId: group?.activePaneId ?? null, leaves };
}

describe('AGENT SESSIONS menus: items, reasons, questions, palette (F25-F30)', () => {
  // ---- AC38: the menus ---------------------------------------------------------

  test('ASM-01: a row’s menu — Resume or Show Its Terminal, Fork Conversation, Copy Session ID, Pin or Unpin, Rename…, Move to Group ▸, Archive or Unarchive, Delete…, with F26’s separators (AC38, AC5)', () => {
    const { calls, on } = recorder();
    const items = agentSessionRowItems(E, { on });
    assert.deepEqual(labels(items), ['Resume in New Terminal', 'Fork Conversation', '—', 'Copy Session ID', '—', 'Pin', 'Rename…', 'Move to Group ▸', '—', 'Archive', 'Delete…']);
    assert.deepEqual(items.filter((i) => i.type === 'separator').map((i) => i.key), ['s1', 's2', 's3'], 'separator keys are unique');
    assert.ok(items.every((i) => i.type === 'separator' || (!i.disabled && typeof i.onSelect === 'function')), 'all on');
    assert.deepEqual(items.filter((i) => i.danger).map((i) => i.label), ['Delete…'], 'only Delete… is dangerous');
    for (const i of items) i.onSelect?.();
    assert.deepEqual(calls, [['resume', KEY], ['fork', E], ['copyId', UUID], ['pin', KEY], ['rename', E], ['moveMenu', E], ['archive', KEY], ['remove', KEY]]);

    calls.length = 0;
    const other = agentSessionRowItems({ ...E, pinned: true, archived: true }, { holder: { tabId: 't1', state: 'offered' }, icons: { resume: Marker }, on });
    assert.deepEqual(labels(other), ['Show Its Terminal', 'Fork Conversation', '—', 'Copy Session ID', '—', 'Unpin', 'Rename…', 'Move to Group ▸', '—', 'Unarchive', 'Delete…']);
    assert.equal(other[0].icon, Marker);
    assert.equal(items[0].icon, undefined, 'no icon unless given');
    for (const i of other) i.onSelect?.();
    assert.deepEqual(calls.map(([name]) => name), ['resume', 'fork', 'copyId', 'unpin', 'rename', 'moveMenu', 'unarchive', 'remove']);
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

  // ---- C-03: an agent session's name being edited counts only while its row is drawn ----

  test('ASM-15: the drawn rows — the pinned entries, the rows of unfolded groups (none of a folded one, also folded through the read-only map), the first 15 ungrouped (not the 16th), the archived only while Archived is open; none with the section closed (C-03)', () => {
    const at = (n) => ({ kind: 'opencode', lastUsedAt: 1000 - n });
    const pinned = { key: 'p', ...at(0), pinned: true };
    const open = { key: 'm-open', ...at(1), groupId: 'g-open' };
    const shut = { key: 'm-shut', ...at(2), groupId: 'g-shut' };
    const foldedHere = { key: 'm-folded', ...at(3), groupId: 'g-folded' };
    const ungrouped = Array.from({ length: 16 }, (_, i) => ({ key: `u${i}`, ...at(10 + i) }));
    const archived = [{ key: 'a0', ...at(40), archived: true }, { key: 'a1', ...at(41), archived: true, groupId: 'g-open' }];
    const entries = [pinned, open, shut, foldedHere, ...ungrouped, ...archived];
    const groups = [
      { id: 'g-open', name: 'Open', collapsed: false },
      { id: 'g-shut', name: 'Shut', collapsed: true },
      { id: 'g-folded', name: 'Folded here', collapsed: false },
    ];
    const sorted = (set) => [...set].sort();
    const firstFifteen = ungrouped.slice(0, 15).map((e) => e.key);
    // The read-only map folds 'g-folded' on screen (F30): its own `collapsed` is false.
    const view = agentSessionsView(entries, groups, { folded: { 'g-folded': true } });
    assert.deepEqual(sorted(drawnAgentSessionKeys(view, true)), ['m-open', 'p', ...firstFifteen].sort());
    const keys = drawnAgentSessionKeys(view, true);
    assert.equal(keys.has('m-shut'), false, 'a folded group draws none of its rows');
    assert.equal(keys.has('m-folded'), false, 'nor one folded through the read-only map');
    assert.equal(keys.has('u14'), true, 'the 15th ungrouped is drawn');
    assert.equal(keys.has('u15'), false, 'the 16th is past "Show all (N)…"');
    assert.equal(keys.has('a0'), false, 'Archived closed: no archived row');
    const archivedOpen = agentSessionsView(entries, groups, { archivedOpen: true, folded: { 'g-folded': true } });
    assert.deepEqual(sorted(drawnAgentSessionKeys(archivedOpen, true)), ['a0', 'a1', 'm-open', 'p', ...firstFifteen].sort(), 'Archived open: its rows too');
    const unfolded = agentSessionsView(entries, groups, { folded: { 'g-shut': false } });
    assert.equal(drawnAgentSessionKeys(unfolded, true).has('m-shut'), true, 'unfolded through the map: drawn');
    assert.equal(drawnAgentSessionKeys(unfolded, true).has('m-folded'), true, 'and the map no longer folding the other');
    assert.deepEqual(sorted(drawnAgentSessionKeys(archivedOpen, false)), [], 'the section closed: no row is drawn');
    assert.deepEqual(sorted(drawnAgentSessionKeys(null, true)), [], 'no view: none');
  });

  test('ASM-16: the notice for a rename not saved quotes the typed name as the list keeps it — cleaned, a secret masked — or quotes nothing when nothing of it is kept; both say to rename it again if the session is still listed (C-03)', () => {
    const again = 'If the session is still listed, rename it again.';
    const plain = renameNotSavedText('  QA lost ');
    assert.equal(plain, `The list changed while this session was being renamed, and the name “QA lost” was not saved. ${again}`);
    const typed = `Rotate \u0007${TOKEN}\u202e now`;
    const masked = renameNotSavedText(typed);
    const kept = historyTitle(typed.trim());
    assert.ok(kept && !kept.includes(TOKEN) && /\[hidden\]/.test(kept), `premise: historyTitle masks it: ${kept}`);
    assert.ok(masked.includes(`“${kept}”`), masked);
    assert.ok(!masked.includes(TOKEN), 'the secret is not shown');
    assert.ok(!/[\u0000-\u001f\u202a-\u202e]/.test(masked), 'nor the control characters');
    assert.ok(masked.endsWith(again));
    const cleared = renameNotSavedText('   ');
    assert.equal(cleared, `The list changed while this session was being renamed, and clearing its name was not saved. ${again}`);
    const nothingKept = renameNotSavedText('\u0007\u202e');
    assert.equal(historyTitle('\u0007\u202e'), null, 'premise: nothing of it is kept');
    assert.equal(nothingKept, `The list changed while this session was being renamed, and the new name was not saved. ${again}`);
    for (const text of [cleared, nothingKept]) assert.ok(!/[“”]/.test(text), `no quoted name: ${text}`);
    assert.equal(renameNotSavedText(undefined), cleared, 'no text at all: as cleared');
  });

  test('ASM-17: the drop rule — an agent session’s editor whose row is not drawn, its text changed, gets the notice; unchanged, drawn, or of another kind, none; the panel drops such an editor by the rows drawn and says the notice as it drops it (C-03)', () => {
    const drawn = new Set(['shown']);
    const draft = (over) => ({ kind: 'agent-session', id: 'gone', value: 'QA lost', initial: 'Auto', ...over });
    const notice = droppedRenameNotice(draft(), drawn);
    assert.ok(notice.includes('“QA lost”'), notice);
    assert.equal(notice, renameNotSavedText('QA lost'));
    assert.equal(droppedRenameNotice(draft({ id: 'shown' }), drawn), null, 'its row is drawn: not dropped');
    assert.equal(droppedRenameNotice(draft({ value: ' Auto  ' }), drawn), null, 'unchanged but for spaces: dropped silently');
    assert.equal(droppedRenameNotice(draft({ value: '', initial: '' }), drawn), null, 'opened empty and left empty: silently');
    assert.ok(droppedRenameNotice(draft({ value: '', initial: 'Mine' }), drawn).includes('clearing its name'), 'a name cleared and not saved: said');
    for (const kind of ['tab', 'group', 'saved', 'workspace', 'workspace-name', 'agent-group']) {
      assert.equal(droppedRenameNotice(draft({ kind }), drawn), null, `${kind}: not this rule's`);
    }
    assert.equal(droppedRenameNotice(null, drawn), null);

    const panel = source('../../src/components/terminal/TerminalsPanel.jsx');
    // The view is worked out before `has`, and the editor of an agent session is judged by the rows it draws.
    assert.ok(panel.indexOf('const agentView = agentSessionsView(') < panel.indexOf('const has = {'), 'agentView before has');
    assert.equal(panel.match(/const agentView = /g).length, 1, 'worked out once');
    // Its subject gone, any editor goes, as before (RN-116); listed with no row drawn, an agent session's too.
    assert.match(panel, /const liveDraft = draft && subjectExists\(draft\.kind, draft\.id, has\) \? draft : null;/);
    assert.match(panel, /const drawnAgentKeys = drawnAgentSessionKeys\(agentView, agentOpen\);/);
    assert.match(panel, /const agentDraftHidden = liveDraft\?\.kind === 'agent-session' && !drawnAgentKeys\.has\(liveDraft\.id\);/);
    assert.match(panel, /const lostRename = droppedRenameNotice\(draft, drawnAgentKeys\);/);
    // Dropped: no editor, and the notice with that text, in the same effect; nothing is renamed.
    assert.match(
      panel,
      /if \(draft && !liveDraft\) setDraft\(null\);\n\s*else if \(agentDraftHidden\) setDraft\(null\);\n\s*if \(lostRename\) useTerminalStore\.getState\(\)\.showAgentHistoryNotice\?\.\('curationFailed', lostRename\);\n\s*\}, \[menu, liveMenu, draft, liveDraft, agentDraftHidden, lostRename\]\);/
    );
    // What the editor opened with, kept for every kind.
    assert.match(panel, /const startRename = \(kind, id, current\) => setDraft\(\{ kind, id, value: current \|\| '', initial: current \|\| '' \}\);/);
    // The row's editor is the live one's.
    assert.match(panel, /const editing = liveDraft\?\.kind === 'agent-session' && liveDraft\.id === entry\.key;/);
  });

  test('ASM-18: renaming otherwise as in v0.27.0 — `holding` counts only tab and group drafts, the menus go by `has` (all entries), the commit routes as before (C-03)', () => {
    const panel = source('../../src/components/terminal/TerminalsPanel.jsx');
    assert.match(panel, /const holding = aiming \|\| listMenuOpen \|\| liveDraft\?\.kind === 'tab' \|\| liveDraft\?\.kind === 'group';/);
    assert.match(panel, /const liveMenu = menu && subjectExists\(menu\.kind, menu\.id, has\) \? menu : null;/);
    assert.match(panel, /agentSession: \(key\) => agentEntries\.some\(\(entry\) => entry\.key === key\),/);
    assert.match(panel, /else if \(draft\.kind === 'agent-session'\) agentHistory\(\)\.rename\(draft\.id, value\);/);
    assert.match(panel, /\} else if \(e\.key === 'Escape'\) \{\n\s*e\.preventDefault\(\);\n\s*setDraft\(null\);/, 'Escape drops the editor silently');
    assert.match(panel, /onBlur=\{commitDraft\}/, 'a blur commits');
    // The store's own words for a commit that reaches it with the old key (FX-4) stay its own.
    assert.doesNotMatch(panel, /ENTRY_GONE_TEXT/);
  });

  // ---- Fork (bundle 1, A1: F3, F4, F5) -----------------------------------------

  test('ASM-19: a fork’s row tooltip names its source — the listed row’s name, else its short id; none for an entry that is no fork or names no valid id; entryOfAgent passes forkOf only when valid (AC4)', () => {
    const SRC = '0b6a5c2e-7f41-4d3a-9c8e-2f1d0a9b8c7d';
    const FORK = { ...E, key: `claude:${UUID}`, forkOf: SRC };
    const srcEntry = { key: `claude:${SRC}`, kind: 'claude', sessionId: SRC, cwd: '/workspace/src', title: 'Login flow', startedAt: 1, lastUsedAt: 1 };
    const named = { ...srcEntry, name: 'My login work' };
    const lines = (tip) => tip.split('\n');

    // Listed: what its row is called — its name over its title.
    assert.equal(forkedFromText(FORK, [srcEntry, E]), 'Forked from Login flow');
    assert.equal(forkedFromText(FORK, [named]), 'Forked from My login work');
    const tip = agentSessionTooltip(FORK, { entries: [E, named], when: '5 minutes ago' });
    assert.ok(lines(tip).includes('Forked from My login work'), tip);
    assert.equal(lines(tip)[1], 'Forked from My login work', 'right after the first line');
    // Not listed (deleted, or never recorded here): its short id.
    const short = forkedFromText(FORK, [E]);
    assert.equal(short, `Forked from ${SRC.slice(0, 8)}`);
    assert.ok(lines(agentSessionTooltip(FORK, { entries: [] })).includes(short));
    // Another agent's entry with the same id is not the source.
    assert.equal(forkedFromText(FORK, [{ ...srcEntry, kind: 'opencode' }]), short);
    // No fork, or a forkOf that is not its agent's id: no line at all.
    const plain = agentSessionTooltip(E, { entries: [srcEntry], when: 'now' });
    for (const bad of [undefined, null, '', 'x; rm -rf ~', SES, SRC.toUpperCase(), 42]) {
      const e = { ...E, forkOf: bad };
      assert.equal(forkedFromText(e, [srcEntry]), null, String(bad));
      assert.equal(agentSessionTooltip(e, { entries: [srcEntry], when: 'now' }), plain, `no extra line for ${String(bad)}`);
    }
    assert.ok(!/Forked from/.test(plain));
    assert.equal(forkedFromText({ ...E, kind: 'opencode', sessionId: SES, forkOf: SRC }, [srcEntry]), null, 'a Claude id is not an OpenCode fork source');
    // The rest of the tooltip is the panel's, unchanged.
    assert.deepEqual(lines(plain), ['Claude Code: Auto', '/workspace/src', 'Last used now', 'Double-click to resume in a new terminal · right-click for more']);
    assert.match(source('../../src/components/terminal/TerminalsPanel.jsx'), /const tip = agentSessionTooltip\(entry, \{ entries: agentEntries, groups: agentGroups, holder, when \}\);/);

    // entryOfAgent: forkOf passed on only when it is an id of the agent's shape.
    const times = { startedAt: 10, lastUsedAt: 20 };
    const agent = { kind: 'claude', sessionId: UUID, startedAt: 1, title: null };
    assert.equal(entryOfAgent({ ...agent, forkOf: SRC }, '/workspace/src', times).forkOf, SRC);
    const nine = entryOfAgent(agent, '/workspace/src', times);
    assert.deepEqual(Object.keys(nine), ['kind', 'sessionId', 'cwd', 'title', 'startedAt', 'lastUsedAt', 'endedAt', 'endReason'], 'no forkOf key without a fork');
    for (const bad of [null, '', 'x; rm -rf ~', SES, SRC.toUpperCase(), `${SRC} `, 7]) {
      const e = entryOfAgent({ ...agent, forkOf: bad }, '/workspace/src', times);
      assert.ok(!Object.prototype.hasOwnProperty.call(e, 'forkOf'), `forkOf ${String(bad)} left out`);
      assert.deepEqual(e, nine);
    }
    assert.ok(!('forkOf' in entryOfAgent({ kind: 'opencode', sessionId: SES, startedAt: 1, title: 'x', forkOf: SRC }, '/w', times)), 'a Claude id is no OpenCode forkOf');
  });

  test('ASM-20: Fork Conversation in a row’s menu — after Resume, on for a Claude Code entry with an id (also read-only, also held), off with a reason for OpenCode and for no id (AC5)', () => {
    const { calls, on } = recorder();
    const items = agentSessionRowItems(E, { icons: { fork: Marker }, on });
    const fork = byKey(items, 'fork');
    assert.equal(items.indexOf(fork), 1, 'right after Resume');
    assert.equal(fork.label, 'Fork Conversation');
    assert.equal(fork.icon, Marker);
    assert.ok(!fork.disabled && !fork.disabledReason);
    fork.onSelect();
    assert.deepEqual(calls, [['fork', E]], 'the entry, for its id and folder');
    for (const holder of [null, { tabId: 't1', state: 'open' }, { tabId: 't1', state: 'offered' }]) {
      for (const readOnly of [false, true]) {
        const item = byKey(agentSessionRowItems({ ...E, pinned: true, archived: true }, { holder, readOnly, on }), 'fork');
        assert.ok(!item.disabled, `on: ${JSON.stringify({ holder, readOnly })}`);
      }
    }
    // OpenCode, with or without an id: off, saying why.
    for (const sessionId of [SES, null]) {
      const item = byKey(agentSessionRowItems({ ...E, key: `opencode:${sessionId}`, kind: 'opencode', sessionId }, { on }), 'fork');
      assert.deepEqual([item.disabled, item.disabledReason], [true, 'OpenCode conversations cannot be forked here']);
      assert.equal(FORK_OPENCODE_REASON, item.disabledReason);
    }
    // A Claude Code entry with no id, or one not of its shape: off with the no-id reason.
    for (const sessionId of [null, '', 'x; rm -rf ~', UUID.toUpperCase()]) {
      const item = byKey(agentSessionRowItems({ ...E, key: 'claude:~/w', sessionId }, { readOnly: true, on }), 'fork');
      assert.deepEqual([item.disabled, item.disabledReason], [true, NO_SESSION_ID_REASON], String(sessionId));
    }
    // The panel wires it to the store's forkConversation, with the entry's id and folder.
    const panel = source('../../src/components/terminal/TerminalsPanel.jsx');
    assert.match(panel, /icons: \{ resume: Play, fork: GitFork \},/);
    assert.match(panel, /fork: \(e\) => forkConversation\(\{ sessionId: e\.sessionId, cwd: e\.cwd \}\),/);
    assert.match(panel, /const forkConversation = useTerminalStore\(\(s\) => s\.forkConversation\);/);
  });

  test('ASM-21: launcherSessions — at most 3 entries, newest lastUsedAt first, archived and unknown agents left out, pinned and grouped kept; the list is not changed (A2, F8)', () => {
    const U = (n) => `${String(n).repeat(8)}-c043-40ef-b157-640fb31ac0ea`;
    const at = (kind, sessionId, lastUsedAt, more = {}) => ({ key: `${kind}:${sessionId}`, kind, sessionId, cwd: `/w/${lastUsedAt}`, title: null, startedAt: 1, lastUsedAt, ...more });
    const a = at('claude', U(1), 500);
    const b = at('opencode', SES, 400, { pinned: true });
    const c = at('claude', U(2), 300, { groupId: 'g1' });
    const d = at('claude', U(3), 200);
    const archived = at('claude', U(4), 900, { archived: true });
    const unknown = at('codex', 'x1', 800);
    const list = [d, unknown, b, archived, a, c];
    const copy = structuredClone(list);
    assert.equal(LAUNCHER_SESSIONS_SHOWN, 3);
    assert.deepEqual(launcherSessions(list).map((e) => e.key), [a.key, b.key, c.key], 'newest first, three of them');
    assert.deepEqual(list, copy, 'the list as it was');
    assert.deepEqual(launcherSessions(list, 10).map((e) => e.key), [a.key, b.key, c.key, d.key], 'never an archived entry or an unknown agent');
    assert.deepEqual(launcherSessions([archived, unknown]), [], 'nothing to offer');
    assert.deepEqual(launcherSessions([]), []);
    for (const junk of [null, undefined, 'x', {}, [null, 3, 'x', { kind: 'claude' }, { ...a, key: 7 }]]) {
      assert.deepEqual(launcherSessions(junk), [], `nothing from ${JSON.stringify(junk)}`);
    }
    // The same time: the order they came in (the history's own, newest first).
    const same = [at('claude', U(5), 100), at('claude', U(6), 100), at('claude', U(7), 100), at('claude', U(8), 100)];
    assert.deepEqual(launcherSessions(same).map((e) => e.sessionId), [U(5), U(6), U(7)]);
    assert.deepEqual(launcherSessions(list, 0), []);
    assert.deepEqual(launcherSessions(list, -1), []);
  });

  test('ASM-22: the empty-pane launcher, mounted — drawn, it asks the backend nothing and types nothing; New Claude Code Terminal opens ONE terminal in its pane and starts the agent once; a recent session resumes that entry in that pane (AC10, F9)', async () => {
    const ui = await loadLauncher();
    await fresh(async () => {
      await readyTerminal();
      await remember(entry('claude', UUID, '/workspace/src', 'Login flow'));
      await remember({ ...entry('claude', '0b6a5c2e-7f41-4d3a-9c8e-2f1d0a9b8c7d', '/workspace/old', 'Old'), lastUsedAt: 9000 });
      await H.getState().load();
      await H.getState().archive('claude:0b6a5c2e-7f41-4d3a-9c8e-2f1d0a9b8c7d');
      // Two panes; the launcher is drawn for the one that is NOT active.
      const { groupId, leaves: [paneA] } = leavesOnScreen();
      await T.getState().splitPane(paneA.id, 'horizontal', groupId);
      const paneB = leavesOnScreen().leaves.find((l) => l.id !== paneA.id);
      assert.ok(paneB, 'setup: a second pane');
      await prompt(tabById(paneB.tabIds[0]));
      T.getState().setActivePane(paneA.id, groupId);
      assert.equal(leavesOnScreen().activePaneId, paneA.id, 'setup: the other pane is the active one');

      const real = { startAgent: T.getState().startAgent, resumeFromHistory: T.getState().resumeFromHistory };
      const started = [];
      const resumed = [];
      T.setState({
        startAgent: (...args) => (started.push(args), real.startAgent(...args)),
        resumeFromHistory: (...args) => (resumed.push(structuredClone(args)), real.resumeFromHistory(...args)),
      });
      try {
        await onPage(async (p) => {
          const asked = log.length;
          // What the launcher asked for: the setup's two shells are not counted.
          const since = () => log.slice(asked);
          p.render(React.createElement(ui.EmptyPaneLauncher, { paneId: paneB.id, groupId, newTerminalKeys: '⌃`' }));
          await letItRun(30);
          assert.deepEqual(log.slice(asked).map((c) => c.command), [], 'drawing the launcher asked the backend nothing');
          assert.deepEqual([started, resumed], [[], []], 'and started or resumed nothing');

          const agentButtons = p.document.querySelectorAll('[data-launcher-agent]');
          assert.deepEqual(agentButtons.map((b) => b.getAttribute('data-launcher-agent')), ['claude', 'opencode']);
          const rows = p.document.querySelectorAll('[data-launcher-session]');
          assert.deepEqual(rows.map((r) => r.getAttribute('data-launcher-session')), [KEY], 'the archived entry is not offered');

          // New Claude Code Terminal, clicked twice before the shell is up: one terminal.
          const tabsBefore = new Set(T.getState().tabs.map((t) => t.id));
          const claude = p.document.querySelector('[data-launcher-agent="claude"]');
          p.click(claude);
          p.click(claude);
          await until(() => started.length === 1, 'startAgent');
          const fresh1 = T.getState().tabs.filter((t) => !tabsBefore.has(t.id));
          assert.equal(fresh1.length, 1, 'one new terminal');
          const created = fresh1[0];
          assert.deepEqual(started, [[created.id, 'claude']], 'the agent started once, in the new terminal');
          let shown = leavesOnScreen();
          assert.ok(shown.leaves.find((l) => l.id === paneB.id).tabIds.includes(created.id), 'in the launcher’s pane');
          assert.ok(!shown.leaves.find((l) => l.id === paneA.id).tabIds.includes(created.id), 'not in the active one');
          assert.equal(since().filter((c) => c.command === 'pty_spawn').length, 1, 'one shell started');
          assert.deepEqual(since().filter((c) => c.command === 'pty_write'), [], 'nothing typed before its prompt');
          await prompt(tabById(created.id));
          await until(() => since().some((c) => c.command === 'pty_write'), 'the agent line');
          const writes = since().filter((c) => c.command === 'pty_write');
          assert.equal(writes.length, 1);
          assert.equal(writes[0].args.session_id, tabById(created.id).sessionId);
          assert.match(writes[0].args.data, /^claude --session-id [0-9a-f-]{36}\r$/);

          // A recent session: resumed with that key and this pane, and opened there.
          T.getState().setActivePane(paneA.id, groupId);
          const tabsBefore2 = new Set(T.getState().tabs.map((t) => t.id));
          p.click(p.document.querySelector(`[data-launcher-session="${KEY}"]`));
          assert.deepEqual(resumed, [[KEY, { paneId: paneB.id, groupId }]], 'resumeFromHistory with the key and the pane');
          await until(() => T.getState().tabs.some((t) => !tabsBefore2.has(t.id) && t.sessionId), 'the resumed terminal');
          const opened = T.getState().tabs.find((t) => !tabsBefore2.has(t.id));
          shown = leavesOnScreen();
          assert.ok(shown.leaves.find((l) => l.id === paneB.id).tabIds.includes(opened.id), 'the terminal opened in that pane');
          assert.ok(!shown.leaves.find((l) => l.id === paneA.id).tabIds.includes(opened.id));
          await sleep(20);
          await prompt(tabById(opened.id));
          await until(() => since().filter((c) => c.command === 'pty_write').length === 2, 'the resume line');
          const resumeWrite = since().filter((c) => c.command === 'pty_write')[1];
          assert.deepEqual([resumeWrite.args.session_id, resumeWrite.args.data], [tabById(opened.id).sessionId, `claude --resume ${UUID}\r`]);
          assert.equal(started.length, 1, 'still one start');
        });
      } finally {
        T.setState(real);
      }
    });
  });

  test('ASM-23: the empty-pane launcher imports no terminal registry and no xterm module, so the workbench never loads xterm through it (review B-R4)', () => {
    const launcher = source('../../src/components/terminal/EmptyPaneLauncher.jsx');
    const imported = [...launcher.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(imported.includes('react') && imported.includes('../../stores/terminalStore.js'), `premise: its imports are read: ${imported}`);
    for (const spec of imported) {
      assert.doesNotMatch(spec, /terminalRegistry/, `it imports ${spec}`);
      assert.doesNotMatch(spec, /^@xterm\//, `it imports ${spec}`);
    }
    // Nor in any other form: a re-export, a dynamic import, a require.
    assert.doesNotMatch(launcher, /['"`][^'"`\n]*(terminalRegistry|@xterm\/)[^'"`\n]*['"`]/, 'no module path names either');
    assert.doesNotMatch(launcher, /\bimport\s*\(|\brequire\s*\(/, 'nothing loaded later');
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
