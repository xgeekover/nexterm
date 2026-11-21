/**
 * Reopen Closed Terminal (Bundle 2, A5-4; AC3's RC-01..RC-07).
 *
 * Over the app's real terminal store and the browser IPC mock it runs on
 * outside Tauri (`AppEnvironment`): every shell here is a `pty_spawn` the
 * mock answers, so a reopened terminal's session id, folder and shell are
 * read off what the store actually asked the backend for.
 *
 * A fake page stands for the DOM, as in tab_navigation.test.js, so where the
 * keyboard lands after a reopen is read off `document.activeElement`: an
 * xterm textarea per terminal pane.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import {
  useTerminalStore,
  PERSIST_KEY,
  __closedTerminals,
  __forgetClosedTerminals,
} from '../../src/stores/terminalStore.js';
import {
  CLOSED_TERMINALS_LIMIT,
  closedTerminalEntry,
  createClosedTerminals,
  reopenPlacement,
} from '../../src/lib/closedTerminals.js';
import { COMMANDS, DEFAULT_RESOLVED, dispatchKeydownOverTerminal } from '../../src/lib/keybindings.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { useSystemStore } from '../../src/stores/systemStore.js';
import { workbenchContext } from '../../src/lib/workbenchCommands.js';

const T = useTerminalStore;
const ENTRY_FIELDS = ['cwd', 'groupId', 'index', 'paneId', 'shell', 'title'];

// --- reading the layout -----------------------------------------------------
function leavesOf(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else for (const child of node.children ?? []) leavesOf(child, acc);
  return acc;
}
const groups = () => T.getState().groups;
const group = (id) => groups().find((g) => g.id === id) ?? null;
const activeGroup = () => group(T.getState().activeGroupId);
const tab = (id) => T.getState().tabs.find((t) => t.id === id) ?? null;
/** The group and pane showing `tabId`, and its slot there. */
function placeOf(tabId) {
  for (const g of groups()) {
    for (const leaf of leavesOf(g.tree)) {
      const index = leaf.tabIds.indexOf(tabId);
      if (index !== -1) return { groupId: g.id, paneId: leaf.id, index, leaf };
    }
  }
  return null;
}
// --- what reached the backend ---------------------------------------------
// The suite's own record, over whatever `mockBridge.invoke` an earlier suite
// left in place: the harness's recorder does not survive one that put back
// an `invoke` it took before the recorder went on. `refuse` lets a case make
// the backend fail one call.
const calls = [];
let refuse = null;
let realInvoke = null;
let invokeFound = null;
function installRecorder() {
  realInvoke = mockBridge.invoke;
  invokeFound ??= realInvoke;
  calls.length = 0;
  refuse = null;
  mockBridge.invoke = (command, args = {}) => {
    calls.push({ command, args });
    if (refuse?.(command, args)) return Promise.reject(new Error(`refused: ${command}`));
    return realInvoke.call(mockBridge, command, args);
  };
}
function removeRecorder() {
  if (realInvoke) mockBridge.invoke = realInvoke;
  realInvoke = null;
  refuse = null;
}
const callsOf = (command) => calls.filter((c) => c.command === command);
const lastSpawn = () => callsOf('pty_spawn').at(-1)?.args ?? null;
const newIds = (before) => T.getState().tabs.map((t) => t.id).filter((id) => !before.includes(id));
const ids = () => T.getState().tabs.map((t) => t.id);

/** Open `count` more terminals in the active pane; their ids, in strip order. */
async function openTabs(count, options = {}) {
  const made = [];
  for (let i = 0; i < count; i += 1) made.push((await T.getState().createTab(options)).id);
  return made;
}

// --- the fake page ----------------------------------------------------------
let original = null;
let page = null;
function fakePage() {
  const body = { tagName: 'BODY', closest: () => null, focus() {}, blur() {} };
  const p = { activeElement: body, body, focusLog: [] };
  const xterms = new Map();
  const xterm = (paneId) => ({
    tagName: 'TEXTAREA',
    paneId,
    closest: (sel) => (sel === '.xterm' ? p.activeElement : null),
    focus() {
      p.activeElement = this;
      p.focusLog.push(paneId);
    },
    blur() {
      if (p.activeElement === this) p.activeElement = body;
    },
  });
  p.querySelector = (sel) => {
    const match = /^\[data-pane-body="([^"]+)"\] \.xterm-helper-textarea$/.exec(sel);
    if (!match) return null;
    const paneId = match[1];
    const isTerminalPane = groups().some((g) => leavesOf(g.tree).some((l) => l.id === paneId && l.kind !== 'editor'));
    if (!isTerminalPane) return null;
    if (!xterms.has(paneId)) xterms.set(paneId, xterm(paneId));
    return xterms.get(paneId);
  };
  p.querySelectorAll = () => [];
  return p;
}

// --- keys -------------------------------------------------------------------
function keydown(fields) {
  const e = {
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '',
    prevented: false, stopped: false, ...fields,
  };
  e.preventDefault = () => {
    e.prevented = true;
  };
  e.stopPropagation = () => {
    e.stopped = true;
  };
  return e;
}
function ctxFor(e, platform) {
  return {
    bindings: DEFAULT_RESOLVED,
    isMod: platform === 'macos' ? e.metaKey : e.ctrlKey,
    isInMonacoEditor: false,
    isInTerminal: true,
    isWindows: platform === 'windows',
    isCommandPaletteOpen: false,
    modalOpen: () => false,
    ...workbenchContext({ isInMonacoEditor: false }),
  };
}
function overTerminal(fields, platform) {
  const e = keydown(fields);
  return { fired: dispatchKeydownOverTerminal(e, ctxFor(e, platform)), e };
}
// Shift makes `e.key` the capital; the browser reports `code` as KeyT.
const CTRL_SHIFT_T = { ctrlKey: true, shiftKey: true, key: 'T', code: 'KeyT' };
const CMD_SHIFT_T = { metaKey: true, shiftKey: true, key: 'T', code: 'KeyT' };
const CTRL_T = { ctrlKey: true, key: 't', code: 'KeyT' };

/** Let the store's awaited work run until `done()` holds (or give up). */
async function until(done, rounds = 200) {
  for (let i = 0; i < rounds && !done(); i += 1) await new Promise((r) => setTimeout(r, 0));
  return done();
}

let env = null;
let heldOs = { taken: false, os: null };

/**
 * Put back what a case changed. afterEach runs only after a case that
 * passed, so beforeEach runs this too: a failed case must not leave its
 * recorder, its store or its `os` to the next one.
 */
function cleanup() {
  env?.destroy();
  env = null;
  removeRecorder();
  if (heldOs.taken) useSystemStore.setState({ os: heldOs.os });
  __forgetClosedTerminals();
}

describe('Reopen Closed Terminal (A5-4)', () => {
  beforeEach(async () => {
    if (!original) original = { hadDocument: 'document' in globalThis, document: globalThis.document };
    cleanup();
    env = new AppEnvironment();
    installRecorder();
    // A POSIX machine: on Windows a Git Bash folder is respelled
    // (`startableCwd`), and an earlier suite may have left `os` there.
    if (!heldOs.taken) heldOs = { taken: true, os: useSystemStore.getState().os };
    useSystemStore.setState({ os: 'macos' });
    await env.initialize();
    __forgetClosedTerminals();
    page = fakePage();
    globalThis.document = page;
  });
  afterEach(() => cleanup());

  test('RC-01: closeTab then reopen gives a NEW shell with the same title, folder and shell, in the same pane and slot', async () => {
    const [first] = ids();
    const [mid, last] = await openTabs(2);
    const { paneId, groupId } = placeOf(first);
    // `mid` becomes a bash in /workspace/src the user named "build".
    await T.getState().closeTab(mid);
    const [bash] = await openTabs(1, { shell: '/bin/bash', paneId });
    T.getState().moveTabInStrip(bash, paneId, 1);
    T.getState().renameTab(bash, 'build');
    T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === bash ? { ...t, cwd: '/workspace/src' } : t)) }));
    __forgetClosedTerminals();
    assert.deepEqual(placeOf(bash).leaf.tabIds, [first, bash, last], 'arranged: the bash is the 2nd of three');
    const old = tab(bash);

    await T.getState().closeTab(bash);
    assert.equal(tab(bash), null, 'closed');
    assert.deepEqual(__closedTerminals(), [{ title: 'build', cwd: '/workspace/src', shell: '/bin/bash', groupId, paneId, index: 1 }]);

    T.getState().switchTab(last);
    const before = ids();
    const spawns = callsOf('pty_spawn').length;
    const writes = callsOf('pty_write').length;
    const reopened = await T.getState().reopenClosedTerminal();
    assert.ok(reopened, 'a terminal came back');
    const [id] = newIds(before);
    assert.equal(reopened.id, id);
    assert.notEqual(id, bash, 'a new tab id');
    assert.notEqual(tab(id).sessionId, old.sessionId, 'a NEW session, not the closed one');
    assert.equal(callsOf('pty_spawn').length, spawns + 1, 'one fresh shell');
    assert.equal(lastSpawn().cwd, '/workspace/src', 'started in the folder it was in');
    assert.equal(lastSpawn().shell, '/bin/bash', 'with the shell it ran');
    assert.notEqual(lastSpawn().strict_cwd, true, 'not strict about the folder');
    assert.equal(tab(id).title, 'build', 'the name the user gave it');
    assert.equal(tab(id).cwd, '/workspace/src');
    assert.equal(tab(id).shell, '/bin/bash');
    assert.equal(tab(id).agent, null, 'no agent is started');
    const at = placeOf(id);
    assert.equal(at.paneId, paneId, 'its old pane');
    assert.equal(at.index, 1, 'its old slot');
    assert.deepEqual(at.leaf.tabIds, [first, id, last]);
    assert.equal(at.leaf.activeTabId, id, 'shown in its pane');
    assert.equal(T.getState().activeTabId, id, 'the active tab');
    assert.equal(group(groupId).activePaneId, paneId, 'its pane is the active one');
    assert.equal(callsOf('pty_write').length, writes, 'nothing is typed into it');
    assert.deepEqual(__closedTerminals(), [], 'the entry is used up');

    // A stack with nothing left: nothing happens.
    const quiet = ids();
    assert.equal(await T.getState().reopenClosedTerminal(), null);
    assert.deepEqual(ids(), quiet);
    assert.equal(callsOf('pty_spawn').length, spawns + 1, 'no shell started for nothing');
  });

  test('RC-01b: a slot past the strip is clamped, and a folder that is gone falls back as Copy Tab\u{2019}s does', async () => {
    const [first] = ids();
    const [b, c] = await openTabs(2);
    const { paneId } = placeOf(first);
    T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === c ? { ...t, cwd: '/workspace/gone' } : t)) }));
    await T.getState().closeTab(c); // slot 2 of three
    assert.equal(__closedTerminals()[0].index, 2);
    // b leaves the strip without closing (nothing recorded): one tab is left.
    T.getState().moveTabToNewPane(b, 'horizontal');
    assert.deepEqual(placeOf(first).leaf.tabIds, [first], 'arranged: a strip of one');
    assert.equal(__closedTerminals().length, 1, 'a move is not a close');

    // The backend refuses a shell in a folder that is gone (the mock does not
    // know folders, so it is told to).
    const spawnsBefore = callsOf('pty_spawn').length;
    refuse = (command, args) => command === 'pty_spawn' && args.cwd === '/workspace/gone';
    const rc = await T.getState().reopenClosedTerminal();
    refuse = null;
    assert.ok(rc, 'reopened although its folder is gone');
    const asked = callsOf('pty_spawn').slice(spawnsBefore).map((c) => c.args);
    assert.equal(asked.length, 2, 'asked there, then where a new terminal starts');
    assert.equal(asked[0].cwd, '/workspace/gone');
    assert.notEqual(asked[0].strict_cwd, true, 'not strict about the folder');
    assert.equal(asked[1].cwd ?? null, null, 'the fallback: the default folder');
    assert.notEqual(tab(rc.id).cwd, '/workspace/gone', 'started where a new terminal starts');
    assert.equal(placeOf(rc.id).paneId, paneId, 'its old pane');
    assert.deepEqual(placeOf(rc.id).leaf.tabIds, [first, rc.id], 'slot 2 in a strip of one: the end');
  });

  test('RC-02: a default-titled tab comes back with a fresh default title', async () => {
    const [d] = await openTabs(1);
    const oldTitle = tab(d).title;
    assert.ok(/^Terminal \d+$/.test(oldTitle), `arranged: a default title (${oldTitle})`);
    await T.getState().closeTab(d);
    assert.equal(__closedTerminals()[0].title, null, 'a default name is not kept');
    // Its number is given to a new terminal meanwhile.
    const [taker] = await openTabs(1);
    const reopened = await T.getState().reopenClosedTerminal();
    const title = tab(reopened.id).title;
    assert.ok(/^Terminal \d+$/.test(title), `a default title, got ${title}`);
    assert.equal(tab(reopened.id).defaultTitle, title);
    const titles = T.getState().tabs.map((t) => t.title);
    assert.equal(new Set(titles).size, titles.length, `no two tabs share a name: ${titles.join(', ')}`);
    assert.notEqual(title, tab(taker).title);
  });

  test('RC-03: closePane and closeGroup record their terminals; the pane gone, the group\u{2019}s active terminal pane; the group gone, where createTab puts one', async () => {
    const [first] = ids();
    const home = placeOf(first);
    // A second pane with two named terminals.
    await T.getState().splitPane(home.paneId, 'horizontal');
    const [p1] = newIds([first]);
    const side = placeOf(p1).paneId;
    assert.notEqual(side, home.paneId, 'arranged: a pane of its own');
    const [p2] = await openTabs(1, { paneId: side });
    T.getState().renameTab(p1, 'p1');
    T.getState().renameTab(p2, 'p2');
    T.getState().switchTab(first);

    await T.getState().closePane(side, home.groupId);
    assert.equal(tab(p1), null, 'their shells are gone');
    assert.equal(tab(p2), null);
    assert.deepEqual(
      __closedTerminals().map(({ title, paneId, groupId, index }) => ({ title, paneId, groupId, index })),
      [
        { title: 'p1', paneId: side, groupId: home.groupId, index: 0 },
        { title: 'p2', paneId: side, groupId: home.groupId, index: 1 },
      ],
      'both recorded, with the pane they were in; the first of the strip on top'
    );

    const r1 = await T.getState().reopenClosedTerminal();
    const r2 = await T.getState().reopenClosedTerminal();
    assert.equal(tab(r1.id).title, 'p1');
    assert.equal(tab(r2.id).title, 'p2');
    const g = group(home.groupId);
    for (const r of [r1, r2]) {
      assert.equal(placeOf(r.id).groupId, home.groupId, 'its old group');
      assert.equal(placeOf(r.id).paneId, g.activePaneId, "that group's active terminal pane");
    }
    assert.deepEqual(placeOf(first).leaf.tabIds, [first, r1.id, r2.id], 'at the end, in their old strip order');

    // A second group with a named terminal, closed whole.
    await T.getState().createGroup({ name: 'Other' });
    const other = T.getState().activeGroupId;
    assert.notEqual(other, home.groupId, 'arranged: a second group');
    const [g1] = leavesOf(group(other).tree).flatMap((l) => l.tabIds);
    T.getState().renameTab(g1, 'g1');
    const otherPane = placeOf(g1).paneId;
    const g1Shell = tab(g1).shell;
    assert.equal(await T.getState().closeGroup(other), true);
    assert.equal(group(other), null, 'the group is gone');
    assert.equal(tab(g1), null);
    assert.deepEqual(__closedTerminals()[0], { title: 'g1', cwd: '/workspace', shell: g1Shell, groupId: other, paneId: otherPane, index: 0 });

    // Where createTab would put a new terminal: the active pane of the group
    // on screen — made the second pane here, so it is not just "the first".
    const known = ids();
    await T.getState().splitPane(home.paneId, 'vertical');
    const [splitTab] = newIds(known);
    T.getState().switchTab(splitTab);
    const g2 = activeGroup();
    const expected = g2.activePaneId;
    assert.equal(expected, placeOf(splitTab).paneId, 'arranged: the new pane is the active one');
    assert.notEqual(expected, home.paneId, 'arranged: the active pane is the new one');
    const rg = await T.getState().reopenClosedTerminal();
    assert.equal(tab(rg.id).title, 'g1');
    assert.equal(placeOf(rg.id).groupId, g2.id);
    assert.equal(placeOf(rg.id).paneId, expected, 'where createTab puts one');
    assert.equal(T.getState().activeTabId, rg.id);
  });

  test('RC-03b: closing the only group keeps it, emptied; its terminal comes back into the group\u{2019}s new pane', async () => {
    const [first] = ids();
    T.getState().renameTab(first, 'only');
    const { groupId } = placeOf(first);
    assert.equal(groups().length, 1, 'arranged: one group');
    await T.getState().closeGroup(groupId);
    assert.equal(tab(first), null);
    const r = await T.getState().reopenClosedTerminal();
    assert.equal(tab(r.id).title, 'only');
    assert.equal(placeOf(r.id).groupId, groupId);
    assert.equal(placeOf(r.id).paneId, group(groupId).activePaneId);
  });

  test('RC-04: the stack keeps the last 10, last in first out; an empty stack does nothing', async () => {
    assert.equal(CLOSED_TERMINALS_LIMIT, 10);
    const made = await openTabs(12);
    made.forEach((id, i) => T.getState().renameTab(id, `r${i + 1}`));
    for (const id of made) await T.getState().closeTab(id);
    assert.deepEqual(
      __closedTerminals().map((e) => e.title),
      ['r12', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3'],
      'the 10 closed last, newest first; r1 and r2 are forgotten'
    );
    const order = [];
    for (let i = 0; i < 10; i += 1) order.push(tab((await T.getState().reopenClosedTerminal()).id).title);
    assert.deepEqual(order, ['r12', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3']);

    const before = ids();
    const spawns = callsOf('pty_spawn').length;
    const state = T.getState();
    assert.equal(await T.getState().reopenClosedTerminal(), null, 'nothing left');
    assert.deepEqual(ids(), before);
    assert.equal(callsOf('pty_spawn').length, spawns, 'no shell started');
    assert.equal(T.getState().groups, state.groups, 'the layout untouched');
  });

  test('RC-05: restartShell records nothing, nor does a workspace load that replaces the layout', async () => {
    const [first] = ids();
    T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === first ? { ...t, exited: true } : t)) }));
    const restarted = await T.getState().restartShell(first);
    assert.equal(restarted, true, 'arranged: the shell was restarted');
    assert.deepEqual(__closedTerminals(), [], 'a restart is not a close');

    await openTabs(1);
    T.getState().saveWorkspace('ws');
    const saved = T.getState().savedWorkspaces.at(-1);
    assert.ok(saved, 'arranged: a saved workspace');
    const before = ids();
    await T.getState().loadWorkspace(saved.id, { mode: 'replace' });
    assert.ok(before.every((id) => tab(id) === null), 'arranged: the old terminals were replaced');
    assert.deepEqual(__closedTerminals(), [], 'a replaced layout is not a close');

    // Start-up: the store comes up again over the saved layout, reaping the
    // previous page's shells and restoring fresh ones.
    const spawnsBefore = callsOf('pty_spawn').length;
    T.getState().dispose();
    T.setState({ isInitialized: false });
    await T.getState().init();
    assert.ok(callsOf('pty_spawn').length > spawnsBefore, 'arranged: started again, with fresh shells');
    assert.ok(T.getState().tabs.length > 0);
    assert.deepEqual(__closedTerminals(), [], 'nor is a start-up');
  });

  test('RC-06: no closed-terminal data is persisted, and no scrollback is written for a reopened tab', async () => {
    const [x] = await openTabs(1);
    T.getState().renameTab(x, 'secret-name-x');
    T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === x ? { ...t, cwd: '/workspace/tests' } : t)) }));
    await T.getState().closeTab(x);
    assert.equal(__closedTerminals().length, 1, 'arranged: one closed terminal');
    // Only the six fields: no session, agent, output or scrollback.
    assert.deepEqual(Object.keys(__closedTerminals()[0]).sort(), ENTRY_FIELDS);

    // A storage of its own, with every key on it: an earlier suite may have
    // left a shim that cannot list its keys.
    const written = new Map();
    const held = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => (written.has(k) ? written.get(k) : null),
      setItem: (k, v) => written.set(k, String(v)),
      removeItem: (k) => written.delete(k),
      clear: () => written.clear(),
      key: (i) => [...written.keys()][i] ?? null,
      get length() {
        return written.size;
      },
    };
    try {
      T.getState().dispose(); // writes the pending layout out
    } finally {
      globalThis.localStorage = held;
    }
    assert.ok(written.has(PERSIST_KEY), 'arranged: the layout was written');
    for (const [key, value] of written) {
      assert.ok(!value.includes('secret-name-x'), `${key} names no closed terminal`);
      assert.ok(!/closed/i.test(value), `${key} carries no closed-terminal field`);
    }
    const payload = JSON.parse(written.get(PERSIST_KEY));
    assert.deepEqual(Object.keys(payload.data ?? payload).sort(), ['activeGroupId', 'groups', 'tabs', 'workspaceName']);

    // The serializer itself reads nothing of the stack.
    const source = readFileSync(fileURLToPath(new URL('../../src/stores/terminalStore.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function buildPersistedPayload(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.ok(start !== -1 && body.length > 0, 'found the serializer');
    assert.ok(!/closed/i.test(body), 'buildPersistedPayload does not touch the closed terminals');

    await T.getState().init();
    const writesBefore = callsOf('scrollback_write').length;
    const r = await T.getState().reopenClosedTerminal();
    assert.ok(r, 'reopened');
    const writes = callsOf('scrollback_write').slice(writesBefore);
    assert.deepEqual(writes.filter((c) => c.args?.tab_id === r.id), [], 'nothing of a scrollback is written for it');
    assert.equal(callsOf('scrollback_read').filter((c) => c.args?.tab_id === r.id).length, 0, 'nor read back');
  });

  test('RC-07: Ctrl+Shift+T off macOS and \u{2318}\u{21E7}T on macOS, over a focused terminal, run Reopen Closed Terminal', async () => {
    assert.equal(COMMANDS['reopen-closed-terminal'].overTerminal, true);
    assert.equal(COMMANDS['reopen-closed-terminal'].menuId, null);
    for (const [platform, chord] of [['windows', CTRL_SHIFT_T], ['linux', CTRL_SHIFT_T], ['macos', CMD_SHIFT_T]]) {
      const [x] = await openTabs(1);
      T.getState().renameTab(x, `x-${platform}`);
      const { paneId } = placeOf(x);
      await T.getState().closeTab(x);
      const before = ids();
      page.focusLog.length = 0;
      const { fired, e } = overTerminal(chord, platform);
      assert.equal(fired, 'reopen-closed-terminal', `${platform}: the chord runs the command`);
      assert.ok(e.prevented && e.stopped, `${platform}: claimed ahead of xterm`);
      assert.ok(await until(() => newIds(before).length === 1), `${platform}: a terminal came back`);
      const [id] = newIds(before);
      assert.equal(tab(id).title, `x-${platform}`);
      assert.equal(placeOf(id).paneId, paneId);
      assert.equal(T.getState().activeTabId, id);
      assert.ok(await until(() => page.focusLog.length > 0), `${platform}: the keyboard is handed over`);
      assert.equal(page.activeElement.paneId, paneId, `${platform}: the keyboard lands in its pane`);
    }

    // The other spellings are not it: Ctrl+Shift+T on macOS, Win+Shift+T off
    // it, and a bare Ctrl+T, which stays the shell's (transpose-chars).
    const [y] = await openTabs(1);
    await T.getState().closeTab(y);
    for (const [platform, chord, name] of [
      ['macos', CTRL_SHIFT_T, 'Ctrl+Shift+T on macOS'],
      ['windows', CMD_SHIFT_T, 'Win+Shift+T'],
      ['linux', CMD_SHIFT_T, 'Super+Shift+T'],
      ['windows', CTRL_T, 'Ctrl+T on Windows'],
      ['linux', CTRL_T, 'Ctrl+T on Linux'],
      ['macos', CTRL_T, 'Ctrl+T on macOS'],
    ]) {
      const { fired, e } = overTerminal(chord, platform);
      assert.notEqual(fired, 'reopen-closed-terminal', `${name} does not reopen`);
      if (chord === CTRL_T) {
        assert.equal(fired, null, `${name} reaches the shell`);
        assert.ok(!e.prevented && !e.stopped, `${name} is not swallowed`);
      }
    }
    await until(() => false, 5);
    assert.equal(__closedTerminals().length, 1, 'still waiting to be reopened');
  });

  test('RC-08: the stack and the placement rule, on their own', () => {
    const stack = createClosedTerminals(3);
    assert.equal(stack.take(), null, 'empty');
    stack.record(null);
    stack.record({ title: 'a', cwd: '/a', shell: '/bin/sh', groupId: 'g', paneId: 'p', index: 0, sessionId: 's', agent: { kind: 'claude' }, scrollback: 'x' });
    assert.deepEqual(stack.list(), [{ title: 'a', cwd: '/a', shell: '/bin/sh', groupId: 'g', paneId: 'p', index: 0 }], 'only the six fields are kept');
    for (const t of ['b', 'c', 'd']) stack.record({ title: t });
    assert.equal(stack.size, 3);
    assert.deepEqual(stack.list().map((e) => e.title), ['d', 'c', 'b'], 'the oldest went past the limit');
    stack.list()[0].title = 'edited';
    assert.equal(stack.take().title, 'd', 'list() hands out copies; take() is newest first');
    stack.clear();
    assert.equal(stack.size, 0);
    assert.deepEqual(closedTerminalEntry({ title: '', cwd: 7, index: -1 }), { title: null, cwd: null, shell: null, groupId: null, paneId: null, index: null });

    const tree = {
      type: 'split', id: 's', direction: 'horizontal', sizes: [50, 50], children: [
        { type: 'leaf', id: 'pa', tabIds: ['t1', 't2'], activeTabId: 't1' },
        { type: 'leaf', id: 'pb', tabIds: ['t3'], activeTabId: 't3' },
        { type: 'leaf', kind: 'editor', id: 'pe', tabIds: ['f1'], activeTabId: 'f1' },
      ],
    };
    const gs = [{ id: 'g1', activePaneId: 'pb', tree }];
    const entry = (over) => ({ ...closedTerminalEntry({ groupId: 'g1', paneId: 'pa', index: 1 }), ...over });
    assert.deepEqual(reopenPlacement(entry({}), gs), { groupId: 'g1', paneId: 'pa', index: 1 }, 'its pane, its slot');
    assert.deepEqual(reopenPlacement(entry({ index: 9 }), gs), { groupId: 'g1', paneId: 'pa', index: 2 }, 'clamped');
    assert.deepEqual(reopenPlacement(entry({ index: null }), gs), { groupId: 'g1', paneId: 'pa', index: 2 }, 'no slot: the end');
    assert.deepEqual(reopenPlacement(entry({ paneId: 'gone' }), gs), { groupId: 'g1', paneId: 'pb', index: null }, 'pane gone: the active terminal pane');
    assert.deepEqual(reopenPlacement(entry({ paneId: 'pe' }), gs), { groupId: 'g1', paneId: 'pb', index: null }, 'a file pane is not its pane');
    assert.deepEqual(
      reopenPlacement(entry({ paneId: 'gone' }), [{ ...gs[0], activePaneId: 'pe' }]),
      { groupId: 'g1', paneId: 'pa', index: null },
      'no terminal pane active: the first terminal pane'
    );
    const filesOnly = [{ id: 'g1', activePaneId: null, tree: tree.children[2] }];
    assert.equal(reopenPlacement(entry({ paneId: 'gone' }), filesOnly), null, 'no terminal pane at all: as createTab places');
    assert.equal(reopenPlacement(entry({ groupId: 'gone' }), gs), null, 'group gone: as createTab places');
    assert.equal(reopenPlacement(entry({ groupId: null }), gs), null, 'never placed');
    assert.equal(reopenPlacement(null, gs), null);
    assert.equal(reopenPlacement(entry({}), null), null);
  });

  test('RC-99: teardown \u{2014} the store, the stack and the page as the next suite expects', () => {
    cleanup();
    env = new AppEnvironment();
    if (original.hadDocument) globalThis.document = original.document;
    else delete globalThis.document;
    assert.equal(mockBridge.invoke, invokeFound, 'the backend as the suite found it');
    assert.equal(useSystemStore.getState().os, heldOs.os, 'os as the suite found it');
    assert.deepEqual(__closedTerminals(), []);
    assert.deepEqual(T.getState().tabs, []);
    assert.equal(globalThis.document, original.hadDocument ? original.document : undefined);
  });
});
