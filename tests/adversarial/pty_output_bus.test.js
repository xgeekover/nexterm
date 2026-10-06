/**
 * Output a tab prints before its terminal exists is kept for it
 * (src/lib/ptyOutputBus.js).
 *
 * A tab's xterm is made the first time a TerminalView shows it, and until then
 * nothing wrote its shell's output anywhere. Measured in the macOS app
 * (2026-10-05): a layout template's background tab ran its startup command —
 * `fc -ln -1` in it printed the command — and showed only a fresh prompt when
 * brought forward. Every chunk now goes through one listener: into the
 * terminal when there is one, kept (the newest BACKLOG_LIMIT characters) when
 * there is not, and handed over in one synchronous step when it appears.
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import {
  BACKLOG_LIMIT,
  attachOutput,
  backlogSize,
  deliver,
  forgetOutput,
  resetPtyOutputBus,
  startPtyOutputBus,
} from '../../src/lib/ptyOutputBus.js';

const { Terminal: HeadlessTerminal } = headless;

/** A stand-in for Tauri's `listen`: records handlers, lets the test emit. */
function fakeListen() {
  const handlers = [];
  const on = (event, handler) => {
    handlers.push({ event, handler });
    return Promise.resolve(() => {
      const i = handlers.findIndex((h) => h.handler === handler);
      if (i >= 0) handlers.splice(i, 1);
    });
  };
  const emit = (session_id, data) => {
    for (const h of handlers) if (h.event === 'pty-output') h.handler({ session_id, data });
  };
  return { on, emit, handlers };
}

describe('Output a tab printed before its terminal existed', () => {
  test('PB-01: kept until a terminal attaches, handed over in order, then live — nothing doubled', async () => {
    await resetPtyOutputBus();
    const bus = fakeListen();
    await startPtyOutputBus({ listen: bus.on });
    bus.emit('s1', 'one ');
    bus.emit('s1', 'two ');
    assert.equal(backlogSize('s1'), 8);
    const got = [];
    attachOutput('s1', (d) => got.push(d));
    assert.deepEqual(got, ['one ', 'two '], 'what was kept, first and in order');
    assert.equal(backlogSize('s1'), 0, 'and no longer kept');
    bus.emit('s1', 'three');
    assert.deepEqual(got, ['one ', 'two ', 'three'], 'then live, once');
  });

  test('PB-02: the newest BACKLOG_LIMIT characters are kept — oldest chunks out, a huge one by its tail', async () => {
    await resetPtyOutputBus();
    const half = 'a'.repeat(BACKLOG_LIMIT / 2);
    deliver('s2', 'OLD');
    deliver('s2', half);
    deliver('s2', half);
    assert.equal(backlogSize('s2'), BACKLOG_LIMIT, 'the oldest chunk went');
    const got = [];
    attachOutput('s2', (d) => got.push(d));
    assert.equal(got.join(''), half + half);

    deliver('s3', 'x'.repeat(BACKLOG_LIMIT) + 'TAIL');
    assert.equal(backlogSize('s3'), BACKLOG_LIMIT);
    const tail = [];
    attachOutput('s3', (d) => tail.push(d));
    assert.ok(tail.join('').endsWith('TAIL'), 'one chunk past the limit keeps its tail');
  });

  test('PB-03: taken away again, output is kept again — and goes to the next terminal attached', async () => {
    await resetPtyOutputBus();
    const first = [];
    const detach = attachOutput('s4', (d) => first.push(d));
    deliver('s4', 'a');
    detach();
    deliver('s4', 'b');
    assert.deepEqual(first, ['a']);
    assert.equal(backlogSize('s4'), 1);
    const second = [];
    attachOutput('s4', (d) => second.push(d));
    assert.deepEqual(second, ['b']);
  });

  test('PB-04: sessions are kept apart, and a forgotten one is gone', async () => {
    await resetPtyOutputBus();
    deliver('s5', 'five');
    deliver('s6', 'six');
    forgetOutput('s5');
    assert.equal(backlogSize('s5'), 0);
    assert.equal(backlogSize('s6'), 3);
    const got = [];
    attachOutput('s5', (d) => got.push(d));
    deliver('s6', '!');
    assert.deepEqual(got, [], 'nothing of s6 reaches s5');
  });

  test('PB-05: one listener however often it is started; a sink that throws loses its chunk, not the listener', async () => {
    await resetPtyOutputBus();
    const bus = fakeListen();
    await Promise.all([startPtyOutputBus({ listen: bus.on }), startPtyOutputBus({ listen: bus.on }), startPtyOutputBus({ listen: bus.on })]);
    assert.equal(bus.handlers.length, 1);
    const warn = console.warn;
    console.warn = () => {};
    try {
      attachOutput('s7', () => {
        throw new Error('boom');
      });
      const other = [];
      attachOutput('s8', (d) => other.push(d));
      bus.emit('s7', 'lost');
      bus.emit('s8', 'kept going');
      assert.deepEqual(other, ['kept going']);
    } finally {
      console.warn = warn;
    }
    // Empty, missing or non-string data is nothing.
    deliver('s9', '');
    deliver('s9', null);
    deliver(null, 'x');
    assert.equal(backlogSize('s9'), 0);
  });

  test('PB-06: real xterm made after the output came shows it', async () => {
    await resetPtyOutputBus();
    deliver('s10', 'printed before the terminal existed\r\n');
    deliver('s10', '\x1b[32mstill green\x1b[0m\r\n');
    const term = new HeadlessTerminal({ cols: 60, rows: 5, allowProposedApi: true });
    await new Promise((resolve) => {
      attachOutput('s10', (d) => term.write(d));
      term.write('', resolve);
    });
    const b = term.buffer.active;
    assert.equal(b.getLine(0).translateToString(true), 'printed before the terminal existed');
    assert.equal(b.getLine(1).translateToString(true), 'still green');
    assert.equal(b.getLine(1).getCell(0).getFgColor(), 2, 'escape sequences arrive intact');
    term.dispose();
  });

  test('PB-07: wired — the registry attaches through the bus, and the store starts it first', () => {
    const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(registry, /ptyUnlisten = attachOutput\(sessionId, \(data\) => entry\.term\.write\(data\)\);/);
    assert.doesNotMatch(registry, /listen\('pty-output'/, 'no listener of its own left to race the bus');
    assert.match(registry, /forgetOutput\(entry\.sessionId\)/, 'a rebound instance drops the old shell');
    const store = readFileSync(new URL('../../src/stores/terminalStore.js', import.meta.url), 'utf8');
    const attach = store.indexOf('attachListeners: async () => {');
    assert.ok(attach > 0);
    const startAt = store.indexOf('await startPtyOutputBus();', attach);
    const firstListen = store.indexOf("listen('pty-output'", attach);
    assert.ok(startAt > attach && startAt < firstListen, 'the bus starts before the other listeners, at bootstrap');
    // What closing a terminal frees is checked by doing it — PB-09 to PB-14,
    // every way a terminal closes. One `forgetOutput(tab.sessionId)` anywhere
    // in the store satisfied a check that read the source, and closing a pane,
    // a group or the workspace freed nothing.
  });

  test('PB-08: teardown — a fresh bus for whatever runs next', async () => {
    await resetPtyOutputBus();
    assert.equal(backlogSize('s1'), 0);
  });
});

// ---------------------------------------------------------------------------
// What a closed terminal kept goes with it — by every way a terminal closes.
//
// In Node no terminal is ever shown, so every tab here is the one that leaks:
// a pane's background tab, never brought forward, whose output the bus keeps
// (up to BACKLOG_LIMIT characters) for a terminal that will never exist.

const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

/** Borrow the global for one case, then hand it back — see layout_gaps. */
function borrowStorage() {
  const held = globalThis.localStorage;
  globalThis.localStorage = shim;
  return () => {
    globalThis.localStorage = held;
  };
}

// Imported WITHOUT swapping the global first — see pty_reload_leak.
const { useTerminalStore: S } = await import('../../src/stores/terminalStore.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const leaves = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((child) => leaves(child, acc));
  return acc;
};
const sessionsOf = (tabs) => tabs.map((t) => t.sessionId);
const print = (sessionId, data = 'printed while nobody was looking\r\n') =>
  mockBridge.emit('pty-output', { session_id: sessionId, data });

/** A fresh bus, a clean backend and a store started on them, as the app starts. */
async function startApp() {
  await resetPtyOutputBus();
  S.getState().dispose();
  backing.clear();
  await mockBridge.invoke('pty_retain_only', { session_ids: [] });
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
  await S.getState().init();
  await wait(20);
}

describe('Output kept for a terminal goes when the terminal does', () => {
  let release = () => {};
  beforeEach(async () => {
    release = borrowStorage();
    await startApp();
  });
  afterEach(() => release());

  test('PB-09: closing a pane frees what its tabs kept — and nothing of the panes left', async () => {
    const group = S.getState().groups[0];
    const pane = leaves(group.tree)[0];
    await S.getState().createTab({ paneId: pane.id, groupId: group.id });
    const closing = [...S.getState().tabs];
    assert.equal(closing.length, 2, 'two tabs in the pane, one of them never shown');
    await S.getState().splitPane(pane.id, 'horizontal', group.id);
    const survivor = S.getState().tabs.find((t) => !closing.some((c) => c.id === t.id));

    for (const id of [...sessionsOf(closing), survivor.sessionId]) await print(id);
    for (const id of sessionsOf(closing)) assert.ok(backlogSize(id) > 0, 'kept while the tab is open');

    await S.getState().closePane(pane.id, group.id);
    for (const id of sessionsOf(closing)) assert.equal(backlogSize(id), 0, `${id}: freed with its pane`);
    assert.ok(backlogSize(survivor.sessionId) > 0, 'a tab still open keeps its own');
  });

  test('PB-10: closing a group frees what its tabs kept', async () => {
    const group = await S.getState().createGroup({ name: 'background' });
    const pane = leaves(group.tree)[0];
    await S.getState().createTab({ paneId: pane.id, groupId: group.id });
    const tree = S.getState().groups.find((g) => g.id === group.id).tree;
    const ownedIds = leaves(tree).flatMap((leaf) => leaf.tabIds);
    const owned = S.getState().tabs.filter((t) => ownedIds.includes(t.id));
    assert.equal(owned.length, 2);
    for (const id of sessionsOf(owned)) await print(id);

    await S.getState().closeGroup(group.id);
    for (const id of sessionsOf(owned)) assert.equal(backlogSize(id), 0, `${id}: freed with its group`);
  });

  test('PB-11: replacing the workspace frees what the replaced tabs kept', async () => {
    const entry = S.getState().saveWorkspace('desk');
    const replaced = [...S.getState().tabs];
    for (const id of sessionsOf(replaced)) await print(id);

    await S.getState().loadWorkspace(entry.id, { mode: 'replace' });
    for (const id of sessionsOf(replaced)) assert.equal(backlogSize(id), 0, `${id}: freed with the workspace it was in`);
    assert.ok(S.getState().tabs.length > 0 && !S.getState().tabs.some((t) => replaced.some((r) => r.id === t.id)));
  });

  test('PB-12: closing a tab frees what it kept, as it always did', async () => {
    const [tab] = S.getState().tabs;
    await print(tab.sessionId);
    await S.getState().closeTab(tab.id);
    assert.equal(backlogSize(tab.sessionId), 0);
  });

  test('PB-13: output the shell printed after its terminal closed goes when the shell’s end is reported', async () => {
    // The backend reads a killed shell to its end and only then reports the
    // exit, so its last output arrives after the close freed what was kept.
    for (const close of ['closeTab', 'closePane']) {
      await startApp();
      const group = S.getState().groups[0];
      const [tab] = S.getState().tabs;
      if (close === 'closeTab') await S.getState().closeTab(tab.id);
      else await S.getState().closePane(leaves(group.tree)[0].id, group.id);
      await print(tab.sessionId, 'the last of it, drained after the kill\r\n');
      assert.ok(backlogSize(tab.sessionId) > 0, `${close}: kept, with no terminal to go to`);
      await mockBridge.emit('pty-exit', { session_id: tab.sessionId, exit_code: 130 });
      assert.equal(backlogSize(tab.sessionId), 0, `${close}: freed at the end of the shell`);
    }
  });

  test('PB-14: a shell that ends while its tab is open keeps its last words for when the tab is shown', async () => {
    const [tab] = S.getState().tabs;
    await print(tab.sessionId, 'zsh: no such file or directory: /bad/rc\r\n');
    await mockBridge.emit('pty-exit', { session_id: tab.sessionId, exit_code: 1 });
    assert.ok(backlogSize(tab.sessionId) > 0, 'kept for the tab still holding it');
    assert.ok(S.getState().tabs.find((t) => t.id === tab.id).exited, 'and the tab knows its shell is gone');
  });

  test('PB-15: while the store starts, a shell that ended with no tab yet keeps its output until the store is up', async () => {
    // A restore spawns every shell before any tab holds one; a shell gone at
    // once (a missing WSL distro, a broken profile) left its last words for
    // the tab about to show them. A shell nothing takes is freed once up.
    S.setState({ isInitialized: false });
    await print('restored-1', 'The Windows Subsystem for Linux has no installed distributions.\r\n');
    await mockBridge.emit('pty-exit', { session_id: 'restored-1', exit_code: 1 });
    await print('left-by-reload');
    await mockBridge.emit('pty-exit', { session_id: 'left-by-reload', exit_code: 130 });
    assert.ok(backlogSize('restored-1') > 0, 'kept while the store is starting');
    assert.ok(backlogSize('left-by-reload') > 0);

    const restored = { ...S.getState().tabs[0], id: 'tab-restored-1', sessionId: 'restored-1' };
    S.setState((state) => ({ tabs: [...state.tabs, restored], isInitialized: true }));
    assert.ok(backlogSize('restored-1') > 0, 'a tab took it: kept for that tab');
    assert.equal(backlogSize('left-by-reload'), 0, 'no tab took it: freed');
    S.setState((state) => ({ tabs: state.tabs.filter((t) => t.id !== restored.id) }));
  });

  test('PB-16: teardown — a fresh bus and store for whatever runs next', async () => {
    S.getState().dispose();
    await resetPtyOutputBus();
    assert.equal(backlogSize('restored-1'), 0);
  });
});
