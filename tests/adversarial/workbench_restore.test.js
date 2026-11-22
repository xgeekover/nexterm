/**
 * The workbench saved and restored (editor placement, sibling B).
 *
 *   B2 (workspace half): `nexterm.terminal.workspace` stays SCHEMA_VERSION 2.
 *   Editor leaves are written with `kind` and no tab ids, terminal leaves
 *   exactly as in v0.31.0; they come back empty and WAITING for the editor
 *   restore, and are pruned if still empty when it is done or the deadline
 *   passes. Templates stay terminal-only, a workspace replace keeps the files,
 *   and a group close asks before closing unsaved files.
 *
 * Each case reloads from localStorage through the real load path
 * (`loadWorkspacePayload`, reached by `init`), never from memory.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  useTerminalStore,
  PERSIST_KEY,
  setEditorBridge,
  __editorBridge,
  __waitingEditorLeaves,
} from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import {
  useEditorStore,
  registerEditorBridge,
  EDITOR_SESSIONS_KEY,
  RESTORE_DEADLINE_MS,
  RESTORE_READ_TIMEOUT_MS,
  whenTabsRestored,
} from '../../src/stores/editorStore.js';
import { normalizeSessions } from '../../src/lib/editorSession.js';
import { normalizeSessions as normalizeSessionsV031 } from './fixtures/legacy/editorSession.v0_31.js';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { leafKind, leavesOfKind, tabIdsOfKind, projectTree } from '../../src/components/terminal/splitLayout.js';

const S = useTerminalStore;
const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/workbench/${name}`, import.meta.url)), 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- storage, a fake editor bridge, and every IPC call recorded -------------
const backing = new Map();
let previousStorage;
let hadStorage = false;
const editorIds = new Set();
const bridgeLog = { closed: [], asked: [], restored: [] };
let answer = true;
let realInvoke = null;
const calls = [];

let installed = false;

function installStorage() {
  // Captured once per case: a second install must not take our own shim for
  // the one to hand back (a suite that set its own at import would lose it).
  if (!installed) {
    hadStorage = 'localStorage' in globalThis;
    previousStorage = globalThis.localStorage;
    installed = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

function installBridge({ deadlineMs = 15000 } = {}) {
  editorIds.clear();
  bridgeLog.closed = [];
  bridgeLog.asked = [];
  bridgeLog.restored = [];
  answer = true;
  setEditorBridge({
    tabIds: () => editorIds,
    closeTabs: (ids) => {
      bridgeLog.closed.push(...ids);
      for (const id of ids) editorIds.delete(id);
    },
    confirmClose: async (kind, ids) => {
      bridgeLog.asked.push({ kind, ids: [...ids] });
      return answer;
    },
    layoutRestored: (waiting) => bridgeLog.restored.push([...waiting]),
    restoreDeadlineMs: deadlineMs,
  });
}

function recordIpc() {
  stopRecording();
  calls.length = 0;
  const original = mockBridge.invoke;
  realInvoke = original;
  mockBridge.invoke = function recording(cmd, args, ...rest) {
    calls.push({ cmd, args });
    return original.call(this, cmd, args, ...rest);
  };
}

function stopRecording() {
  if (realInvoke) mockBridge.invoke = realInvoke;
  realInvoke = null;
}

/** A relaunch: the store thrown away and `init` run against what is on disk. */
/** The store as a fresh page load has it: one empty placeholder group, no terminals, no files. */
function freshPage() {
  editorIds.clear();
  S.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    groups: [{ id: 'group-1', name: 'Group 1', createdAt: 1, tree: { type: 'leaf', id: 'pane-1', tabIds: [], activeTabId: null }, activePaneId: 'pane-1' }],
    activeGroupId: 'group-1',
  });
}

async function relaunch({ seed = null } = {}) {
  S.getState().dispose();
  if (seed) backing.set(PERSIST_KEY, JSON.stringify(seed));
  freshPage();
  calls.length = 0;
  await S.getState().init();
}

function teardown() {
  stopRecording();
  S.getState().dispose();
  // The app's own bridge back, not none: the next suite starts as the app does.
  registerEditorBridge();
  useSettingsStore.getState().resetSettings();
  if (installed) {
    if (hadStorage) globalThis.localStorage = previousStorage;
    else delete globalThis.localStorage;
    installed = false;
  }
}

async function setUp(opts) {
  backing.clear();
  installStorage();
  useSettingsStore.getState().resetSettings();
  installBridge(opts);
  recordIpc();
}

/** What is on disk under PERSIST_KEY once the write-behind has run. */
async function saved() {
  await wait(400);
  return JSON.parse(backing.get(PERSIST_KEY));
}

const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groupById = (id) => S.getState().groups.find((g) => g.id === id);
const spawns = () => calls.filter((c) => c.cmd === 'pty_spawn').length;
const kills = () => calls.filter((c) => c.cmd === 'pty_kill').length;

describe('Workbench restore: v0.31.0 payloads (AC-B5, workspace half)', () => {
  beforeEach(() => setUp());
  afterEach(teardown);

  test('WR-01: a v0.31.0 workspace (no `kind`) restores exactly as before and is written back byte-identical', async () => {
    const v031 = fixture('workspace_v0_31.json');
    await relaunch({ seed: v031 });
    assert.equal(spawns(), 5, 'one shell per saved terminal');
    const state = S.getState();
    assert.equal(state.activeGroupId, 'group-1');
    assert.deepEqual(state.groups.map((g) => g.tree), v031.data.groups.map((g) => g.tree), 'the same trees: ids, tab ids, sizes');
    assert.deepEqual(state.groups.map((g) => g.activePaneId), ['pane-3', 'pane-4']);
    assert.equal(state.groups.some((g) => 'editorPaneId' in g), false);
    const back = await saved();
    assert.equal(back.version, SCHEMA_VERSION);
    assert.equal(back.version, 2);
    assert.equal(JSON.stringify(back.data.groups), JSON.stringify(v031.data.groups), 'byte-identical groups');
    assert.equal(back.data.activeGroupId, 'group-1');
  });

  test('WR-02: malformed, newer and cut-short editor leaves are ignored per field and never throw', async () => {
    const v031 = fixture('workspace_v0_31.json');
    const hand = JSON.parse(JSON.stringify(v031));
    hand.data.groups[1].tree = {
      type: 'split',
      id: 'split-9',
      direction: 'vertical',
      children: [
        { type: 'leaf', kind: 'editor', tabIds: 'nope', activeTabId: 7 },
        { type: 'leaf', kind: 'editor', id: 'pane-20', tabIds: ['tab-term-5'], activeTabId: 'tab-term-5' },
        { type: 'leaf', kind: 'diagram', id: 'pane-21', tabIds: ['tab-term-5'], activeTabId: 'tab-term-5' },
        { type: 'leaf' },
      ],
      sizes: [10, 'x', 30],
    };
    hand.data.groups[1].editorPaneId = 42;
    await relaunch({ seed: hand });
    const two = groupById('group-2');
    assert.ok(two, 'the group comes back');
    const terminals = leavesOfKind(two.tree, 'terminal');
    assert.deepEqual(tabIdsOfKind(two.tree, 'terminal'), ['tab-term-5'], 'the terminal is restored, once');
    assert.equal(terminals.length, 1, 'an unknown kind reads as a terminal leaf; the empty leaf is pruned');
    const editors = leavesOfKind(two.tree, 'editor');
    assert.equal(editors.length, 2, 'both editor leaves come back');
    editors.forEach((l) => assert.deepEqual(l.tabIds, [], 'empty, whatever the payload held'));
    assert.equal(typeof editors[0].id, 'string');
    assert.equal(two.editorPaneId, undefined, 'a bad editorPaneId is dropped');
    assert.equal(spawns(), 5, 'an id in an editor leaf is no reason to spawn a shell');

    // Cut short: the payload ends mid-way. Nothing throws; a fresh start follows.
    await saved(); // the restore's own write-behind first, so it cannot land on top
    backing.set(PERSIST_KEY, JSON.stringify(v031).slice(0, 200));
    await relaunch();
    assert.equal(S.getState().groups.length, 1);
    assert.equal(S.getState().tabs.length, 1);
  });
});

describe('Workbench restore: editor leaves in the workspace payload (AC-B4, AC-B5, AC-B6 workspace half)', () => {
  beforeEach(async () => {
    await setUp({ deadlineMs: 60 });
    await relaunch();
  });
  afterEach(teardown);

  test('WR-03: editor leaves are written with `kind` and `tabIds: []`; terminal leaves as a v0.31.0 payload of the same terminals', async () => {
    const g = S.getState().getActiveGroup();
    await S.getState().splitPane(g.activePaneId, 'horizontal', g.id);
    const before = await saved();
    editorIds.add('e1');
    editorIds.add('e2');
    const { paneId } = S.getState().placeEditorTab('e1');
    S.getState().placeEditorTab('e2');
    const after = await saved();
    assert.equal(after.version, 2);
    const tree = after.data.groups[0].tree;
    assert.equal(tree.direction, 'vertical');
    assert.deepEqual(tree.sizes, [60, 40]);
    assert.deepEqual(tree.children[0], { type: 'leaf', kind: 'editor', id: paneId, tabIds: [], activeTabId: null });
    assert.equal(JSON.stringify(tree.children[1]), JSON.stringify(before.data.groups[0].tree), 'terminal leaves byte-identical');
    assert.equal(after.data.groups[0].editorPaneId, paneId);
    assert.equal(after.data.tabs.length, before.data.tabs.length, 'no editor tab is written as a terminal');
  });

  test('WR-04: a file shown or moved within its leaf never schedules a workspace write', async () => {
    editorIds.add('e1');
    editorIds.add('e2');
    const { paneId } = S.getState().placeEditorTab('e1');
    S.getState().placeEditorTab('e2');
    await saved();
    let writes = 0;
    const setItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (k, v) => {
      if (k === PERSIST_KEY) writes += 1;
      setItem(k, v);
    };
    S.getState().bindPaneToTab(paneId, 'e1');
    S.getState().moveTabInStrip('e2', paneId, 0);
    await wait(400);
    globalThis.localStorage.setItem = setItem;
    assert.equal(writes, 0);
  });

  test('WR-05: with Restore Open Files off, no editor leaf or editorPaneId is written, and none restored', async () => {
    editorIds.add('e1');
    S.getState().placeEditorTab('e1');
    const withEditors = await saved();
    useSettingsStore.getState().setSetting('editorRestoreTabs', false);
    S.getState().renameGroup(S.getState().activeGroupId, 'Renamed');
    const off = await saved();
    assert.equal(leavesOf(off.data.groups[0].tree).some((l) => l.kind === 'editor'), false);
    assert.equal('editorPaneId' in off.data.groups[0], false);
    // A payload with editor leaves, read with the setting off: none come back.
    await relaunch({ seed: withEditors });
    assert.equal(leavesOfKind(S.getState().getActiveGroup().tree, 'editor').length, 0);
    assert.equal(__waitingEditorLeaves().size, 0);
  });

  test('WR-06: a mixed layout comes back: same shape, sizes, kinds, editorPaneId, activePaneId, active group; editor leaves empty and waiting', async () => {
    const g1 = S.getState().getActiveGroup();
    const t1Pane = g1.activePaneId;
    const t2Pane = await S.getState().splitPane(t1Pane, 'horizontal', g1.id);
    for (const id of ['e1', 'e2', 'e3']) editorIds.add(id);
    const { paneId: e1Pane } = S.getState().placeEditorTab('e1');
    const e2Pane = S.getState().splitEditorLeaf(e1Pane, 'horizontal');
    S.getState().placeEditorTab('e2', { paneId: e2Pane });
    const g2 = await S.getState().createGroup({ name: 'Two' });
    S.getState().placeEditorTab('e3', { groupId: g2.id });
    S.getState().setActiveGroup(g1.id);
    S.getState().setActivePane(t2Pane);
    const top = groupById(g1.id).tree;
    S.getState().setPaneSizes(g1.id, top.id, [70, 30]);
    const expected = JSON.parse(JSON.stringify(S.getState().groups));
    await saved();

    await relaunch();
    const state = S.getState();
    assert.equal(state.activeGroupId, g1.id);
    assert.equal(spawns(), 3, 'pty_spawn for the three terminals only');
    const strip = (node) => (node.type === 'leaf'
      ? { kind: leafKind(node), id: node.id, tabIds: leafKind(node) === 'editor' ? [] : node.tabIds }
      : { id: node.id, direction: node.direction, sizes: node.sizes, children: node.children.map(strip) });
    assert.deepEqual(state.groups.map((g) => strip(g.tree)), expected.map((g) => strip(g.tree)), 'the same trees, editor leaves empty');
    assert.deepEqual(state.groups.map((g) => g.activePaneId), expected.map((g) => g.activePaneId));
    assert.deepEqual(state.groups.map((g) => g.editorPaneId), expected.map((g) => g.editorPaneId));
    assert.deepEqual(groupById(g1.id).tree.sizes, [70, 30]);
    const waiting = __waitingEditorLeaves();
    assert.deepEqual([...waiting].sort(), [e1Pane, e2Pane, leavesOfKind(groupById(g2.id).tree, 'editor')[0].id].sort());
    assert.deepEqual(bridgeLog.restored.at(-1).sort(), [...waiting].sort(), 'the bridge is told which leaves wait');
  });

  test('WR-07: waiting leaves are kept until released; released or past the deadline, the empty ones are pruned', async () => {
    for (const id of ['e1', 'e2']) editorIds.add(id);
    const { paneId: a } = S.getState().placeEditorTab('e1');
    const b = S.getState().splitEditorLeaf(a, 'vertical');
    S.getState().placeEditorTab('e2', { paneId: b });
    await saved();

    await relaunch();
    assert.deepEqual([...__waitingEditorLeaves()].sort(), [a, b].sort());
    // The editor restore fills `a`, and is done with it.
    editorIds.add('e1');
    S.getState().placeEditorTab('e1', { paneId: a });
    S.getState().releaseWaitingEditorLeaves([a]);
    assert.ok(leavesOf(S.getState().getActiveGroup().tree).some((l) => l.id === b), 'b still waits');
    S.getState().removeEditorTabs(['nothing']);
    await wait(100);
    const tree = S.getState().getActiveGroup().tree;
    assert.equal(leavesOf(tree).some((l) => l.id === b), false, 'past the deadline, the empty waiting leaf is pruned');
    assert.deepEqual(leavesOf(tree).find((l) => l.id === a).tabIds, ['e1']);
    assert.equal(__waitingEditorLeaves().size, 0);
  });

  test('WR-08: files placed before the terminal restore lands survive it: by leaf id, else wrapped above the active group', async () => {
    for (const id of ['e1']) editorIds.add(id);
    const { paneId: saved1 } = S.getState().placeEditorTab('e1');
    await saved();
    S.getState().dispose();
    freshPage();
    // Hold the first shell, so the files are placed while the restore runs.
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = mockBridge.invoke;
    let held = false;
    mockBridge.invoke = async function holding(cmd, args, ...rest) {
      if (cmd === 'pty_spawn' && !held) {
        held = true;
        await gate;
      }
      return inner.call(this, cmd, args, ...rest);
    };
    const starting = S.getState().init();
    await wait(20);
    editorIds.add('e9');
    editorIds.add('e8');
    const placeholder = S.getState().getActiveGroup();
    S.setState({
      groups: [{
        ...placeholder,
        tree: {
          type: 'split', id: 'split-pre', direction: 'vertical', sizes: [50, 50],
          children: [
            { type: 'leaf', kind: 'editor', id: saved1, tabIds: ['e8'], activeTabId: 'e8' },
            { type: 'split', id: 'split-pre2', direction: 'vertical', sizes: [50, 50], children: [
              { type: 'leaf', kind: 'editor', id: 'pane-900', tabIds: ['e9'], activeTabId: 'e9' },
              placeholder.tree,
            ] },
          ],
        },
      }],
    });
    release();
    await starting;
    mockBridge.invoke = inner;
    const tree = S.getState().getActiveGroup().tree;
    const editors = leavesOfKind(tree, 'editor');
    assert.deepEqual(editors.find((l) => l.id === saved1)?.tabIds, ['e8'], 'a leaf of the same id is filled');
    const wrapped = editors.find((l) => l.tabIds.includes('e9'));
    assert.ok(wrapped, 'a file in a leaf the layout does not have is kept');
    assert.equal(tree.children[0].id, wrapped.id, 'wrapped above the restored tree');
    assert.deepEqual(tree.sizes, [60, 40]);
    assert.equal(__waitingEditorLeaves().has(saved1), false, 'a filled leaf does not wait');
  });

  test('WR-13: a start carries only the files placed while it ran, never those an earlier run left in the store', async () => {
    // What the suites' relaunches leave: the last run's groups, with a file
    // still open in an editor leaf, and only `tabs` and `isInitialized` reset.
    // The app never starts twice on one store (the start runs once a page);
    // carried, that run's files were wrapped into every later fresh start.
    editorIds.add('old1');
    const { paneId: oldPane } = S.getState().placeEditorTab('old1');
    await saved();
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = mockBridge.invoke;
    let held = false;
    mockBridge.invoke = async function holding(cmd, args, ...rest) {
      if (cmd === 'pty_spawn' && !held) {
        held = true;
        await gate;
      }
      return inner.call(this, cmd, args, ...rest);
    };
    const starting = S.getState().init();
    await wait(20);
    editorIds.add('new1');
    S.getState().placeEditorTab('new1');
    release();
    await starting;
    mockBridge.invoke = inner;
    const tree = S.getState().getActiveGroup().tree;
    assert.deepEqual(tabIdsOfKind(tree, 'editor'), ['new1'], 'the file placed while the start ran is carried, the earlier run\u{2019}s is not');
    assert.deepEqual(leavesOfKind(tree, 'editor').map((l) => l.id), [oldPane], 'into the restored leaf of its id');
    assert.equal(__waitingEditorLeaves().size, 0);
  });

  test('WR-14: turning Restore Open Files off rewrites the workspace without its editor leaves at once, and on again with them', async () => {
    editorIds.add('e1');
    S.getState().placeEditorTab('e1');
    const on = await saved();
    assert.ok(leavesOf(on.data.groups[0].tree).some((l) => l.kind === 'editor'));
    useSettingsStore.getState().setSetting('editorRestoreTabs', false);
    const off = await saved();
    assert.equal(leavesOf(off.data.groups[0].tree).some((l) => l.kind === 'editor'), false, 'written with no layout change to prompt it');
    useSettingsStore.getState().setSetting('editorRestoreTabs', true);
    const back = await saved();
    assert.ok(leavesOf(back.data.groups[0].tree).some((l) => l.kind === 'editor'), 'and back with them');
  });
});

describe('Workbench restore: templates, workspace loads, group moves and closes (FB6, FB7 store half)', () => {
  beforeEach(async () => {
    await setUp();
    await relaunch();
  });
  afterEach(teardown);

  test('WR-09: saved groups and workspaces are terminal-only; loading a workspace over files keeps every file, in one editor leaf', async () => {
    const g = S.getState().getActiveGroup();
    await S.getState().splitPane(g.activePaneId, 'vertical', g.id);
    for (const id of ['e1', 'e2']) editorIds.add(id);
    const { paneId } = S.getState().placeEditorTab('e1');
    S.getState().splitEditorLeaf(paneId, 'horizontal');
    S.getState().placeEditorTab('e2');
    const savedGroupId = S.getState().saveGroup(g.id, 'Tpl');
    const entry = S.getState().savedGroups.find((x) => x.id === savedGroupId) ?? S.getState().savedGroups.at(-1);
    assert.equal(leavesOf(entry.tree).some((l) => l.kind === 'editor'), false, 'no editor leaf in a template');
    assert.equal(entry.tabs.length, 2);
    const ws = S.getState().saveWorkspace('WS');
    const wsEntry = S.getState().savedWorkspaces.find((x) => x.id === ws) ?? S.getState().savedWorkspaces.at(-1);
    assert.equal(wsEntry.groups.some((sg) => leavesOf(sg.tree).some((l) => l.kind === 'editor')), false);

    calls.length = 0;
    const activeId = await S.getState().loadWorkspace(wsEntry.id, { mode: 'replace' });
    const active = groupById(activeId);
    const editors = leavesOfKind(active.tree, 'editor');
    assert.equal(editors.length, 1, 'one editor leaf');
    assert.deepEqual(editors[0].tabIds, ['e1', 'e2']);
    assert.equal(active.tree.children[0].id, editors[0].id);
    assert.deepEqual(active.tree.sizes, [60, 40]);
    assert.deepEqual(bridgeLog.closed, [], 'no file is closed');
    assert.equal(kills(), 2, 'the two old terminals are killed, nothing else');
    assert.deepEqual(bridgeLog.asked, [], 'and nothing is asked');
  });

  test('WR-10: moveTabToGroup takes a file into the group\'s editor pane, else wraps', async () => {
    const one = S.getState().getActiveGroup();
    const two = await S.getState().createGroup({ name: 'Two' });
    for (const id of ['e1', 'e2']) editorIds.add(id);
    S.getState().placeEditorTab('e1', { groupId: one.id });
    S.getState().moveTabToGroup('e1', two.id);
    let target = groupById(two.id);
    assert.deepEqual(tabIdsOfKind(target.tree, 'editor'), ['e1']);
    assert.deepEqual(target.tree.sizes, [60, 40]);
    assert.equal(leavesOfKind(groupById(one.id).tree, 'editor').length, 0, 'the leaf it left is pruned');
    S.getState().placeEditorTab('e2', { groupId: one.id });
    S.getState().moveTabToGroup('e2', two.id);
    target = groupById(two.id);
    assert.equal(leavesOfKind(target.tree, 'editor').length, 1);
    assert.deepEqual(tabIdsOfKind(target.tree, 'editor'), ['e1', 'e2'], 'into its editor pane');
  });

  test('WR-11: closing a group with files asks first; Cancel changes nothing and kills nothing', async () => {
    const one = S.getState().getActiveGroup();
    const two = await S.getState().createGroup({ name: 'Two' });
    editorIds.add('e1');
    S.getState().placeEditorTab('e1', { groupId: two.id });
    const before = JSON.stringify(S.getState().groups);
    answer = false;
    calls.length = 0;
    assert.equal(await S.getState().closeGroup(two.id), false);
    assert.deepEqual(bridgeLog.asked, [{ kind: 'group', ids: ['e1'] }]);
    assert.equal(JSON.stringify(S.getState().groups), before, 'the tree is untouched');
    assert.equal(kills(), 0, 'no pty_kill');
    assert.deepEqual(bridgeLog.closed, []);
    answer = true;
    assert.equal(await S.getState().closeGroup(two.id), true);
    assert.equal(groupById(two.id), undefined);
    assert.deepEqual(bridgeLog.closed, ['e1'], 'the file is closed through editorStore');
    assert.equal(kills(), 1, 'and the terminal killed');
    bridgeLog.asked = [];
    const three = await S.getState().createGroup({ name: 'Three' });
    await S.getState().closeGroup(three.id);
    assert.deepEqual(bridgeLog.asked, [], 'a group with no file asks nothing');
    assert.ok(groupById(one.id));
  });

  test('WR-12: the terminal projection of a restored mixed layout keeps every terminal node id', async () => {
    const g = S.getState().getActiveGroup();
    await S.getState().splitPane(g.activePaneId, 'horizontal', g.id);
    const terminalsBefore = JSON.stringify(projectTree(groupById(g.id).tree, 'terminal'));
    editorIds.add('e1');
    S.getState().placeEditorTab('e1');
    assert.equal(JSON.stringify(projectTree(groupById(g.id).tree, 'terminal')), terminalsBefore);
  });
});

// --- The session half: both stores, the real bridge, the real load paths ------
//
// Every round trip below goes through storage: the stores write what is
// pending as the page going away does (`dispose`), both are emptied, and both
// `init`s run with nothing to go on but localStorage — the workspace through
// `loadWorkspacePayload`, the editor sessions through `normalizeSessions`.

const E = useEditorStore;
const ROOT = '/wb-proj';
const ROOT2 = '/wb-proj-two';
const madeFiles = new Set();
const madeDirs = new Set();

function makeFiles(root, names) {
  for (const dir of [root, ...names.filter((n) => n.includes('/')).map((n) => `${root}/${n.slice(0, n.lastIndexOf('/'))}`)]) {
    if (!mockBridge.directories.has(dir)) madeDirs.add(dir);
    mockBridge.directories.add(dir);
  }
  return names.map((name) => {
    const path = `${root}/${name}`;
    madeFiles.add(path);
    mockBridge.files.set(path, `// ${name}\n`);
    return path;
  });
}

function emptyEditor() {
  E.setState({
    tabs: [],
    activeTabId: null,
    fileTree: [],
    rootPath: '/workspace',
    rootResolved: false,
    expandedFolders: new Set(),
    pendingClose: null,
    pendingOverwrite: null,
    openFailure: null,
    pendingReveal: null,
  });
}

let heldRoot;

/** Both stores thrown away and started again with `root` open, terminals first as App starts them. */
async function launchBoth(root = ROOT, { strict = false } = {}) {
  S.getState().dispose();
  E.getState().dispose();
  freshPage();
  emptyEditor();
  calls.length = 0;
  const original = mockBridge.invoke;
  mockBridge.root = root;
  mockBridge.invoke = function (cmd, args, ...rest) {
    if (cmd === 'fs_get_root') return Promise.resolve(root);
    return original.call(this, cmd, args, ...rest);
  };
  try {
    const runs = [S.getState().init(), E.getState().init()];
    if (strict) {
      // React StrictMode: the mount effect, its cleanup, the effect again.
      S.getState().dispose();
      E.getState().dispose();
      runs.push(S.getState().init(), E.getState().init());
    }
    await Promise.all(runs);
    await whenTabsRestored();
  } finally {
    mockBridge.invoke = original;
  }
}

/** Both stores' pending writes out, as the page going away writes them. */
function closePage() {
  S.getState().dispose();
  E.getState().dispose();
}

const pathOf = (id) => E.getState().tabs.find((t) => t.id === id)?.filePath ?? null;
const tabOf = (path) => E.getState().tabs.find((t) => t.filePath === path) ?? null;

/** The workbench as files: every group's tree, with each editor leaf's files and shown file by path. */
function picture() {
  const st = S.getState();
  const strip = (node) =>
    node.type === 'leaf'
      ? leafKind(node) === 'editor'
        ? { kind: 'editor', id: node.id, files: node.tabIds.map(pathOf), shown: pathOf(node.activeTabId) }
        : { kind: 'terminal', id: node.id, tabIds: [...node.tabIds], shown: node.activeTabId }
      : { id: node.id, direction: node.direction, sizes: node.sizes, children: node.children.map(strip) };
  return {
    groups: st.groups.map((g) => ({ id: g.id, tree: strip(g.tree), activePaneId: g.activePaneId, editorPaneId: g.editorPaneId ?? null })),
    activeGroupId: st.activeGroupId,
    activeFile: pathOf(E.getState().activeTabId),
  };
}

/** Park the reads `parks` picks until released. */
function parkReads(parks) {
  const original = mockBridge.invoke;
  const parked = [];
  mockBridge.invoke = async function (cmd, args, ...rest) {
    if (cmd === 'fs_read_file' && parks(args.path)) {
      await new Promise((resolve) => parked.push(resolve));
    }
    return original.call(this, cmd, args, ...rest);
  };
  return {
    parked,
    stop: () => {
      mockBridge.invoke = original;
      parked.forEach((release) => release());
    },
  };
}

/** `fn` with the restore's waits — the deadline and the per-read timeout — cut to a moment: a controlled clock. */
async function withShortDeadlines(fn) {
  const real = globalThis.setTimeout;
  const cut = [RESTORE_DEADLINE_MS, RESTORE_READ_TIMEOUT_MS];
  globalThis.setTimeout = (callback, ms, ...rest) => real(callback, cut.includes(ms) ? 20 : ms, ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

async function sessionSetUp() {
  closePage(); // whatever an earlier case left pending goes to its own storage, not this case's
  backing.clear();
  installStorage();
  useSettingsStore.getState().resetSettings();
  registerEditorBridge();
  recordIpc();
  heldRoot = mockBridge.root;
  await launchBoth(ROOT);
}

function sessionTeardown() {
  stopRecording();
  E.setState({ tabs: [], activeTabId: null, pendingClose: null });
  registerEditorBridge();
  S.getState().clearEditorLeaves();
  closePage(); // after the clean-up above, so nothing it schedules is left pending
  for (const path of madeFiles) mockBridge.files.delete(path);
  for (const dir of madeDirs) mockBridge.directories.delete(dir);
  madeFiles.clear();
  madeDirs.clear();
  mockBridge.root = heldRoot;
  teardown();
}

describe('Workbench restore: both stores through storage (AC-B4, AC-B5, AC-B6 session half)', () => {
  beforeEach(() => sessionSetUp());
  afterEach(sessionTeardown);

  test('WR-15: a mixed layout of two groups comes back from storage: shape, sizes, kinds, files per leaf, shown files, editor and terminal panes, active group', async () => {
    const [a, b, c, d] = makeFiles(ROOT, ['a.js', 'b.js', 'c.js', 'd.js']);
    await launchBoth(ROOT);
    const g1 = S.getState().getActiveGroup();
    await S.getState().splitPane(g1.activePaneId, 'horizontal', g1.id);
    await E.getState().openFile(a);
    const e1 = groupById(g1.id).editorPaneId;
    const e2 = E.getState().splitEditorPane(e1, 'horizontal');
    await E.getState().openFile(b);
    await E.getState().openFile(c);
    E.getState().bindEditorPaneToTab(e2, tabOf(b).id);
    const g2 = await S.getState().createGroup({ name: 'Two' });
    S.getState().setActiveGroup(g2.id);
    await E.getState().openFile(d);
    S.getState().setActiveGroup(g1.id);
    E.getState().setActiveEditorPane(e2);
    const top = groupById(g1.id).tree;
    S.getState().setPaneSizes(g1.id, top.id, [70, 30]);
    S.getState().setPaneSizes(g1.id, top.children[0].id, [35, 65]);
    const before = picture();
    assert.deepEqual(before.groups[0].tree.children[0].children.map((l) => [l.files, l.shown]), [[[a], a], [[b, c], b]], 'arranged as meant');
    assert.equal(before.groups[0].editorPaneId, e2, 'the last editor pane of the active group is its editor pane');
    assert.deepEqual(before.groups[1].tree.children[0].files, [d]);
    assert.equal(before.activeFile, b);
    closePage();
    assert.ok(backing.get(PERSIST_KEY) && backing.get(EDITOR_SESSIONS_KEY), 'both payloads are in storage');

    await launchBoth(ROOT);
    assert.deepEqual(picture(), before, 'the same workbench, from storage alone');
    assert.equal(S.getState().tabs.length, 3);
    assert.equal(spawns(), 3, 'pty_spawn for the three terminals only');
    const reads = [...new Set(calls.filter((x) => x.cmd === 'fs_read_file').map((x) => x.args.path))].sort();
    assert.deepEqual(reads, [a, b, c, d].sort(), 'every file read through fs_read_file');
    assert.equal(__waitingEditorLeaves().size, 0, 'every waiting leaf filled, none left waiting');
  });

  test('WR-16: v0.31.0 payloads: the terminals exactly as before, the files wrapped above the active group at [60, 40] with their splits, pane and file; B\u{2019}s payloads stay v2 / format 1 and a v0.31.0 reader loses only `pane`', async () => {
    const ws = fixture('workspace_v0_31.json');
    const sessions = fixture('editor_sessions_v0_31.json');
    const [main, app, readme, util, pkg] = makeFiles('/work/app', ['src/main.js', 'src/app.js', 'README.md', 'src/lib/util.js', 'package.json']);
    closePage(); // the set-up launch's own writes first, so they cannot land on the fixtures
    backing.set(PERSIST_KEY, JSON.stringify(ws));
    backing.set(EDITOR_SESSIONS_KEY, JSON.stringify(sessions));
    await launchBoth('/work/app');
    const st = S.getState();
    assert.equal(spawns(), 5, 'one shell per saved terminal');
    st.groups.forEach((g, i) => assert.deepEqual(projectTree(g.tree, 'terminal'), ws.data.groups[i].tree, `group ${i + 1}: every terminal as before`));
    assert.deepEqual(groupById('group-2').tree, ws.data.groups[1].tree, 'the other group untouched');
    const active = groupById(ws.data.activeGroupId);
    assert.equal(active.tree.direction, 'vertical');
    assert.deepEqual(active.tree.sizes, [60, 40], 'wrapped at [60, 40]');
    assert.deepEqual(active.tree.children[1], ws.data.groups[0].tree, 'above the terminals, which keep their tree');
    const shape = (n) => (n.type === 'leaf'
      ? { kind: leafKind(n), files: n.tabIds.map(pathOf), shown: pathOf(n.activeTabId) }
      : { direction: n.direction, children: n.children.map(shape) });
    assert.deepEqual(shape(active.tree.children[0]), {
      direction: 'horizontal',
      children: [
        { kind: 'editor', files: [main, app], shown: app },
        { direction: 'vertical', children: [{ kind: 'editor', files: [readme], shown: readme }, { kind: 'editor', files: [util, pkg], shown: util }] },
      ],
    }, 'the saved splits, files and shown files');
    assert.equal(active.editorPaneId, leavesOfKind(active.tree, 'editor')[2].id, 'activePane 2');
    assert.equal(pathOf(E.getState().activeTabId), util, 'activeFile');

    closePage();
    const wsBack = JSON.parse(backing.get(PERSIST_KEY));
    assert.equal(wsBack.version, SCHEMA_VERSION);
    assert.equal(wsBack.version, 2);
    assert.equal(JSON.stringify(wsBack.data.groups[1]), JSON.stringify(ws.data.groups[1]), 'a terminal-only group byte-identical');
    assert.equal(JSON.stringify(wsBack.data.groups[0].tree.children[1]), JSON.stringify(ws.data.groups[0].tree), 'terminal leaves byte-identical');
    for (const leaf of leavesOf(wsBack.data.groups[0].tree.children[0])) {
      assert.equal(leaf.kind, 'editor');
      assert.deepEqual(leaf.tabIds, [], 'editor leaves carry no tab ids');
    }
    const sesBack = JSON.parse(backing.get(EDITOR_SESSIONS_KEY));
    assert.equal(sesBack.version, SCHEMA_VERSION);
    assert.equal(sesBack.data.format, 1);
    const withPane = normalizeSessions(sesBack.data);
    const appSession = withPane.find((x) => x.root === '/work/app');
    assert.ok(leavesOf(appSession.tree).every((l) => /^pane-\d+$/.test(l.pane)), 'B saves `pane` per leaf');
    assert.deepEqual(withPane.find((x) => x.root === '/work/other'), normalizeSessionsV031(sessions.data).find((x) => x.root === '/work/other'), 'the other folder kept as it was');
    const lost = JSON.parse(JSON.stringify(withPane, (k, v) => (k === 'pane' ? undefined : v)));
    assert.deepEqual(normalizeSessionsV031(sesBack.data), lost, 'the v0.31.0 reader: everything but `pane`');
  });

  test('WR-17: newer, cut-short and hand-edited session payloads are ignored per field and never throw', async () => {
    const [a] = makeFiles(ROOT, ['a.js']);
    const good = { type: 'leaf', files: [a], active: a };
    const cases = [
      ['newer', { version: 2, data: { format: 2, folders: [{ root: ROOT, tree: good, activePane: 0, activeFile: a, recent: [a], misses: {} }] } }, []],
      ['cut short', JSON.stringify({ version: 2, data: { format: 1, folders: [{ root: ROOT, tree: good }] } }).slice(0, 60), []],
      ['hand-edited', { version: 2, data: { format: 1, folders: [{ root: ROOT, tree: { type: 'leaf', files: [a, 7, null, '/elsewhere/x.js'], active: 9, pane: 42, extra: true }, activePane: 'x', activeFile: 5, recent: 'r', misses: [] }] } }, [a]],
    ];
    for (const [what, payload, files] of cases) {
      closePage();
      backing.set(EDITOR_SESSIONS_KEY, typeof payload === 'string' ? payload : JSON.stringify(payload));
      await launchBoth(ROOT);
      assert.deepEqual(E.getState().tabs.map((t) => t.filePath), files, `${what}: the files that come back`);
      assert.equal(S.getState().tabs.length, 1, `${what}: the terminals start regardless`);
      const editors = leavesOfKind(S.getState().getActiveGroup().tree, 'editor');
      assert.equal(editors.length, files.length ? 1 : 0, `${what}: an editor leaf only for a file`);
    }
  });

  test('WR-18: a StrictMode double init makes no second tab, leaf or shell', async () => {
    const [a, b] = makeFiles(ROOT, ['a.js', 'b.js']);
    await E.getState().openFile(a);
    const pane = S.getState().getActiveGroup().editorPaneId;
    E.getState().splitEditorPane(pane, 'vertical');
    await E.getState().openFile(b);
    const before = picture();
    closePage();
    await launchBoth(ROOT, { strict: true });
    assert.deepEqual(E.getState().tabs.map((t) => t.filePath).sort(), [a, b].sort(), 'one tab per file');
    assert.deepEqual(picture(), before, 'the same leaves, once each');
    assert.equal(spawns(), 1, 'one shell');
    const ids = S.getState().groups.flatMap((g) => leavesOf(g.tree).map((l) => l.id));
    assert.equal(new Set(ids).size, ids.length, 'no pane id twice');
  });

  test('WR-19: a restore racing a user open of the same file makes one tab; a deleted saved file is skipped and its leaf goes', async () => {
    const [a, b, c] = makeFiles(ROOT, ['a.js', 'b.js', 'c.js']);
    await E.getState().openFile(a);
    const pane = S.getState().getActiveGroup().editorPaneId;
    E.getState().splitEditorPane(pane, 'horizontal');
    await E.getState().openFile(b);
    E.getState().splitEditorPane(S.getState().getActiveGroup().editorPaneId, 'horizontal');
    await E.getState().openFile(c);
    closePage();
    mockBridge.files.delete(c); // gone by the next launch
    let first = true;
    const reads = parkReads((path) => {
      if (path !== a || !first) return false;
      first = false;
      return true;
    });
    try {
      const launching = launchBoth(ROOT);
      for (let i = 0; i < 200 && reads.parked.length === 0; i += 1) await wait(5);
      assert.equal(reads.parked.length, 1, 'the restore is reading a.js');
      await E.getState().openFile(a); // the user opens it meanwhile
      reads.stop();
      await launching;
    } finally {
      reads.stop();
    }
    assert.equal(E.getState().tabs.filter((t) => t.filePath === a).length, 1, 'one tab for a.js');
    assert.equal(tabOf(c), null, 'the deleted file is skipped');
    const editors = leavesOfKind(S.getState().getActiveGroup().tree, 'editor');
    assert.equal(editors.some((l) => l.tabIds.length === 0), false, 'its leaf is not left empty');
    assert.deepEqual(editors.flatMap((l) => l.tabIds).map(pathOf).sort(), [a, b].sort(), 'each file in one leaf');
    assert.equal(__waitingEditorLeaves().size, 0);
  });

  test('WR-20: waiting leaves are kept while the editor restore reads, and pruned once the deadline passes with nothing read', async () => {
    const [a] = makeFiles(ROOT, ['a.js']);
    await E.getState().openFile(a);
    const pane = S.getState().getActiveGroup().editorPaneId;
    closePage();

    // Slow: kept, waiting, until the read lands, then filled.
    let reads = parkReads((path) => path === a);
    const launching = launchBoth(ROOT);
    for (let i = 0; i < 200 && !(S.getState().isInitialized && reads.parked.length > 0); i += 1) await wait(5);
    await wait(50);
    assert.ok(__waitingEditorLeaves().has(pane), 'the saved leaf waits while its file is read');
    assert.deepEqual(leavesOfKind(S.getState().getActiveGroup().tree, 'editor').map((l) => l.id), [pane], 'and is not pruned');
    reads.stop();
    await launching;
    assert.deepEqual(leavesOfKind(S.getState().getActiveGroup().tree, 'editor')[0].tabIds.map(pathOf), [a], 'then filled');

    // Never answered: past RESTORE_DEADLINE_MS (a controlled clock) the empty leaf goes.
    closePage();
    reads = parkReads((path) => path === a);
    try {
      await withShortDeadlines(() => launchBoth(ROOT));
      await wait(100);
    } finally {
      reads.stop();
    }
    assert.equal(__waitingEditorLeaves().size, 0, 'nothing waits past the deadline');
    assert.equal(leavesOfKind(S.getState().getActiveGroup().tree, 'editor').length, 0, 'the empty leaf is pruned');
    assert.equal(S.getState().tabs.length, 1, 'the terminal is untouched');
  });

  test('WR-21: a folder switch closes the old folder\u{2019}s leaves in every group and places the new folder\u{2019}s session above the active group at [60, 40]', async () => {
    const [a, d] = makeFiles(ROOT, ['a.js', 'd.js']);
    const [x, y] = makeFiles(ROOT2, ['x.js', 'y.js']);
    await E.getState().openFile(a);
    const g2 = await S.getState().createGroup({ name: 'Two' });
    S.getState().setActiveGroup(g2.id);
    await E.getState().openFile(d);
    // The other folder's session as v0.31.0 wrote it: no `pane`.
    const raw = JSON.parse(backing.get(EDITOR_SESSIONS_KEY) ?? '{"version":2,"data":{"format":1,"folders":[]}}');
    E.getState().dispose();
    raw.data.folders.push({ root: ROOT2, tree: { type: 'split', direction: 'horizontal', children: [{ type: 'leaf', files: [x], active: x }, { type: 'leaf', files: [y], active: y }] }, activePane: 1, activeFile: y, recent: [y, x], misses: {} });
    backing.set(EDITOR_SESSIONS_KEY, JSON.stringify(raw));
    await launchBoth(ROOT);
    S.getState().setActiveGroup(g2.id);
    const terminalsBefore = S.getState().groups.map((g) => projectTree(g.tree, 'terminal'));

    await E.getState().openRoot(ROOT2);
    await whenTabsRestored();
    assert.deepEqual(E.getState().tabs.map((t) => t.filePath).sort(), [x, y].sort(), 'the old files closed, the new folder\u{2019}s open');
    const other = S.getState().groups.find((g) => g.id !== g2.id);
    assert.equal(leavesOfKind(other.tree, 'editor').length, 0, 'no old leaf left in the other group');
    const active = groupById(g2.id);
    assert.deepEqual(active.tree.sizes, [60, 40]);
    assert.deepEqual(leavesOfKind(active.tree.children[0], 'editor').map((l) => l.tabIds.map(pathOf)), [[x], [y]], 'its splits kept');
    assert.equal(pathOf(E.getState().activeTabId), y, 'its active file');
    assert.deepEqual(S.getState().groups.map((g) => projectTree(g.tree, 'terminal')), terminalsBefore, 'every terminal untouched');
    assert.equal(kills(), 0, 'no shell killed');
  });

  test('WR-22: with Restore Open Files off, no editor leaf or session is written, and none restored', async () => {
    const [a] = makeFiles(ROOT, ['a.js']);
    useSettingsStore.getState().setSetting('editorRestoreTabs', false);
    await E.getState().openFile(a);
    assert.equal(leavesOfKind(S.getState().getActiveGroup().tree, 'editor').length, 1, 'the file is open');
    closePage();
    const ws = JSON.parse(backing.get(PERSIST_KEY));
    assert.equal(ws.data.groups.some((g) => leavesOf(g.tree).some((l) => l.kind === 'editor') || 'editorPaneId' in g), false, 'no editor leaf written');
    const ses = backing.get(EDITOR_SESSIONS_KEY);
    assert.equal(ses == null ? [] : normalizeSessions(JSON.parse(ses).data).filter((x) => x.root === ROOT).length, 0, 'no session written');
    await launchBoth(ROOT);
    assert.equal(E.getState().tabs.length, 0, 'nothing restored');
    assert.equal(leavesOfKind(S.getState().getActiveGroup().tree, 'editor').length, 0);
    assert.equal(__waitingEditorLeaves().size, 0);
  });

  test('WR-23: the e2e harness puts the editor placement back between cases: no editor leaf or pane, nothing waiting, the app\u{2019}s bridge', async () => {
    const [a] = makeFiles(ROOT, ['a.js']);
    await E.getState().openFile(a);
    closePage();
    await launchBoth(ROOT, {});
    // A restore still pending would leave leaves waiting; a suite\u{2019}s own bridge stays in place.
    setEditorBridge({ tabIds: () => new Set(['fake']) });
    assert.ok(leavesOfKind(S.getState().getActiveGroup().tree, 'editor').length > 0);
    stopRecording();
    new AppEnvironment();
    const st = S.getState();
    assert.equal(st.groups.some((g) => leavesOfKind(g.tree, 'editor').length > 0 || 'editorPaneId' in g), false, 'no editor leaf, no editorPaneId');
    assert.equal(__waitingEditorLeaves().size, 0, 'nothing waiting');
    assert.equal(__editorBridge().restoreDeadlineMs, RESTORE_DEADLINE_MS, 'the app\u{2019}s bridge is back');
    assert.equal(E.getState().tabs.length, 0);
    installStorage();
  });

  // Review K-02: a group whose last terminal closed is kept while it holds
  // files (FB2), and it is written so. It has to come back so, too.
  test('WR-24: a group holding a file and no terminal comes back from storage with its file, name and place; its file does not move to the active group', async () => {
    const [a, d] = makeFiles(ROOT, ['a.js', 'd.js']);
    await launchBoth(ROOT);
    const g1 = S.getState().getActiveGroup();
    await E.getState().openFile(a);
    const g2 = await S.getState().createGroup({ name: 'Two' });
    await E.getState().openFile(d);
    const [t2] = tabIdsOfKind(groupById(g2.id).tree, 'terminal');
    await S.getState().closeTab(t2);
    assert.ok(groupById(g2.id), 'group 2 outlives its last terminal while it holds a file');
    assert.deepEqual(tabIdsOfKind(groupById(g2.id).tree, 'terminal'), [], 'with an empty terminal leaf');
    S.getState().setActiveGroup(g1.id);
    const before = picture();
    assert.deepEqual(before.groups.map((g) => g.id), [g1.id, g2.id]);
    assert.deepEqual(before.groups[1].tree.children[0].files, [d], 'arranged as meant');
    closePage();

    await launchBoth(ROOT);
    assert.deepEqual(picture(), before, 'group 2 comes back: same shape and ids, its file in its own editor leaf, group 1 untouched');
    assert.deepEqual(S.getState().groups.map((g) => g.name), [g1.name, 'Two'], 'with its name, in its place');
    assert.deepEqual(tabIdsOfKind(groupById(g1.id).tree, 'editor').map(pathOf), [a], 'group 1 holds its own file only');
    assert.equal(spawns(), 1, 'one shell, for group 1\u{2019}s terminal');
    assert.equal(__waitingEditorLeaves().size, 0, 'every waiting leaf filled');
  });

  test('WR-25: when every group holds only files, the workspace still comes back whole: no fresh start, no shell, every file in its group', async () => {
    const [a, d] = makeFiles(ROOT, ['a.js', 'd.js']);
    await launchBoth(ROOT);
    const g1 = S.getState().getActiveGroup();
    await E.getState().openFile(a);
    const g2 = await S.getState().createGroup({ name: 'Two' });
    await E.getState().openFile(d);
    for (const id of S.getState().tabs.map((t) => t.id)) await S.getState().closeTab(id);
    assert.equal(S.getState().tabs.length, 0, 'no terminal left anywhere');
    assert.deepEqual(S.getState().groups.map((g) => g.id), [g1.id, g2.id], 'both groups kept: each holds a file');
    const before = picture();
    closePage();
    assert.ok(backing.get(PERSIST_KEY), 'the workspace is in storage');

    await launchBoth(ROOT);
    assert.deepEqual(picture(), before, 'both groups come back with their files, the same shape and ids');
    assert.deepEqual(S.getState().groups.map((g) => g.name), [g1.name, 'Two']);
    assert.equal(S.getState().tabs.length, 0, 'no terminal was made up');
    assert.equal(spawns(), 0, 'and no shell started');
    assert.equal(__waitingEditorLeaves().size, 0);
  });
});
