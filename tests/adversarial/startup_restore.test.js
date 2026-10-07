/**
 * A terminal asked for while the store is still starting.
 *
 * At launch the store holds a placeholder group with one empty pane — "No
 * terminal in this pane / New Terminal" — for as long as the start takes,
 * and a restore spawns its terminals one after another: seconds on ConPTY
 * with several of them. A click on that button used to:
 *
 *   - be dropped when the restore landed, which replaced `tabs` and `groups`
 *     wholesale, with its shell left running where nothing could show it
 *     until the next launch reaped it;
 *   - take a tab id a restored terminal was about to get, since the counter
 *     is moved past the saved ids only at the end of the restore — and the
 *     xterm registry keys on tab ids, so the restored terminal showed the
 *     dropped one's shell;
 *   - or, clicked before the start's clean-up of a previous page's shells,
 *     have its own shell reaped by it.
 *
 * And wherever the pane or group a new terminal was asked for went away while
 * its shell started — the restore, or a close — `createTab` and `splitPane`
 * left the tab in no pane at all, the same unseen shell.
 *
 * The backend here is the browser mock, made slow: a spawn starts the shell
 * at once and answers later, the way a ConPTY spawn does.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';

// --- localStorage shim, borrowed for the length of each case -----------------
const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

/** Reinstall this file's shim for one case, then hand the global back — see layout_gaps. */
function borrowStorage() {
  const held = globalThis.localStorage;
  globalThis.localStorage = shim;
  return () => {
    globalThis.localStorage = held;
  };
}

const { useTerminalStore: S, PERSIST_KEY } = await import('../../src/stores/terminalStore.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const st = () => S.getState();
const activeGroup = () => st().groups.find((g) => g.id === st().activeGroupId);
const panesHolding = (tabId) => st().groups.flatMap((g) => leavesOf(g.tree)).filter((l) => l.tabIds.includes(tabId));
const backendSessions = () => [...mockBridge.ptySessions.keys()].sort();
const tabSessions = () => st().tabs.map((t) => t.sessionId).sort();

/** The placeholder a page load starts with: one group, one empty pane. */
const PLACEHOLDER = { groupId: 'group-placeholder', paneId: 'pane-placeholder' };
const placeholderGroup = () => ({
  id: PLACEHOLDER.groupId,
  name: 'Group 1',
  createdAt: 0,
  tree: { type: 'leaf', id: PLACEHOLDER.paneId, tabIds: [], activeTabId: null },
  activePaneId: PLACEHOLDER.paneId,
});

/** What a page load does to the store; the backend keeps whatever it holds. */
function pageLoad() {
  st().dispose(); // writes out anything pending — before a case seeds what it restores
  S.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    workspaceName: 'Default',
    groups: [placeholderGroup()],
    activeGroupId: PLACEHOLDER.groupId,
  });
}

/** A saved layout of one group holding `tabIds`, as the persist write-behind leaves it. */
function seedLayout(tabIds) {
  const payload = {
    workspaceName: 'Default',
    groups: [
      {
        id: 'group-saved',
        name: 'Saved',
        createdAt: 1,
        activePaneId: 'pane-saved',
        tree: { type: 'leaf', id: 'pane-saved', tabIds, activeTabId: tabIds[0] },
      },
    ],
    activeGroupId: 'group-saved',
    tabs: tabIds.map((id, i) => ({ id, title: `Terminal ${i + 1}`, cwd: '/workspace' })),
  };
  backing.set(PERSIST_KEY, JSON.stringify({ version: SCHEMA_VERSION, data: payload }));
}

/**
 * The numbers the next `count` new tab ids will carry. A saved layout written
 * by the previous launch holds exactly those: the counter starts from one on
 * every launch.
 */
async function nextTabNumbers(count) {
  const probe = await st().createTab();
  const n = Number(/(\d+)$/.exec(probe.id)[1]);
  await st().closeTab(probe.id);
  return Array.from({ length: count }, (_, i) => `tab-term-${n + 1 + i}`);
}

/**
 * Run `fn` with `pty_spawn` slow: the shell starts at once and the answer
 * takes `ms`. A spawn `refuse` picks out (by its arguments) fails instead.
 */
async function withSlowSpawns(ms, fn, { refuse = () => false } = {}) {
  const original = mockBridge.invoke;
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command !== 'pty_spawn') return original.call(this, command, args, ...rest);
    if (refuse(args)) {
      await wait(ms);
      throw new Error('pty_spawn failed (simulated)');
    }
    const answer = await original.call(this, command, args, ...rest);
    await wait(ms);
    return answer;
  };
  try {
    return await fn();
  } finally {
    mockBridge.invoke = original;
  }
}

/** Every tab sits in exactly one pane, and every shell the backend holds is a tab's. */
function assertNothingUnseen(msg) {
  for (const tab of st().tabs) {
    assert.equal(panesHolding(tab.id).length, 1, `${msg}: ${tab.id} is in ${panesHolding(tab.id).length} panes`);
  }
  assert.equal(new Set(st().tabs.map((t) => t.id)).size, st().tabs.length, `${msg}: two tabs share an id`);
  assert.deepEqual(backendSessions(), tabSessions(), `${msg}: a shell is running with no tab to show it`);
}

/** Quiet the store's expected warnings for one call. */
async function quietly(fn) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

describe('Startup restore: a terminal asked for while the store starts', () => {
  let release;
  beforeEach(async () => {
    release = borrowStorage();
    pageLoad();
    backing.clear();
    await st().init();
  });
  afterEach(() => release());

  // Clicked in the same tick the start begins — before its clean-up of a
  // previous page's shells has run — and again while it spawns.
  for (const clickAfterMs of [null, 30]) {
    const when = clickAfterMs === null ? 'as the start begins' : 'while the restore spawns';
    test(`SU-01 (${when}): New Terminal in the empty pane is kept, shown, and leaks no shell`, async () => {
      const savedIds = await nextTabNumbers(3);
      pageLoad();
      seedLayout(savedIds);

      const clicked = await withSlowSpawns(20, async () => {
        const starting = st().init();
        if (clickAfterMs !== null) await wait(clickAfterMs);
        assert.equal(st().isInitialized, false, 'setup: the store is still starting');
        // TerminalSplitContainer's empty pane: createTab(null, { paneId, groupId })
        const asked = st().createTab(null, { ...PLACEHOLDER });
        const [, tab] = await Promise.all([starting, asked]);
        return tab;
      });

      assert.ok(clicked, 'the terminal was made');
      assert.ok(st().tabs.some((t) => t.id === clicked.id), 'and is still there once the restore landed');
      for (const id of savedIds) assert.ok(st().tabs.some((t) => t.id === id), `restored ${id} is there`);
      assert.equal(savedIds.includes(clicked.id), false, `it took ${clicked.id}, a restored terminal's id`);
      assert.equal(panesHolding(clicked.id).length, 1);
      assert.ok(leavesOf(activeGroup().tree).some((l) => l.tabIds.includes(clicked.id)), 'on screen');
      assert.equal(st().activeTabId, clicked.id, 'shown, as a new terminal is');
      assertNothingUnseen('after the restore');
    });
  }

  test('SU-02: a split asked for on the empty pane lands beside what the restore put on screen', async () => {
    const savedIds = await nextTabNumbers(1);
    pageLoad();
    seedLayout(savedIds);

    const newPaneId = await withSlowSpawns(20, async () => {
      const starting = st().init();
      await wait(10);
      const asked = st().splitPane(PLACEHOLDER.paneId, 'horizontal', PLACEHOLDER.groupId);
      const [, paneId] = await Promise.all([starting, asked]);
      return paneId;
    });

    assert.ok(newPaneId, 'the split happened');
    const pane = leavesOf(activeGroup().tree).find((l) => l.id === newPaneId);
    assert.ok(pane, 'in the group on screen');
    assert.equal(pane.tabIds.length, 1, 'holding the new terminal');
    assert.equal(leavesOf(activeGroup().tree).length, 2, 'beside the restored one');
    assert.ok(st().tabs.some((t) => t.id === savedIds[0]), 'which is still there');
    assertNothingUnseen('after the restore');
  });

  test('SU-03: a terminal asked for in a group that closes while its shell starts goes to the group on screen', async () => {
    const first = activeGroup();
    const other = await st().createGroup({ name: 'Other' });

    const made = await withSlowSpawns(20, async () => {
      const asked = st().createTab({ groupId: other.id });
      await wait(5);
      const closing = st().closeGroup(other.id);
      const [tab] = await Promise.all([asked, closing]);
      return tab;
    });

    assert.ok(made, 'the terminal was made');
    assert.equal(st().activeGroupId, first.id, 'the group left on screen');
    assert.ok(leavesOf(activeGroup().tree).some((l) => l.tabIds.includes(made.id)), 'and the terminal is in it');
    assertNothingUnseen('after the close');
  });

  test('SU-04: a split asked for on a pane that closes while its shell starts still lands', async () => {
    const group = activeGroup();
    const kept = await st().splitPane(group.activePaneId, 'horizontal', group.id);
    const closingPane = leavesOf(activeGroup().tree).find((l) => l.id !== kept).id;

    const newPaneId = await withSlowSpawns(20, async () => {
      const asked = st().splitPane(closingPane, 'vertical', group.id);
      await wait(5);
      const closing = st().closePane(closingPane, group.id);
      const [paneId] = await Promise.all([asked, closing]);
      return paneId;
    });

    const pane = leavesOf(activeGroup().tree).find((l) => l.id === newPaneId);
    assert.ok(pane, `the pane it returned (${newPaneId}) exists`);
    assert.equal(pane.tabIds.length, 1, 'and holds the new terminal');
    assertNothingUnseen('after the close');
  });

  test('SU-05: a terminal already in the store when the start begins is kept, with its shell and its own id', async () => {
    const [nextId] = await nextTabNumbers(1);
    pageLoad();
    // The saved layout's terminal carries the id the next new tab will get.
    seedLayout([nextId]);
    const early = await st().createTab(null, { ...PLACEHOLDER });
    assert.equal(early.id, nextId, 'setup: the id a restored terminal is about to take');

    await st().init();

    assert.ok(st().tabs.some((t) => t.id === early.id && t.sessionId === early.sessionId), 'kept, with its shell');
    assert.ok(mockBridge.ptySessions.has(early.sessionId), 'whose shell the start did not reap');
    assert.equal(st().tabs.length, 2, 'beside the restored terminal');
    const restored = st().tabs.find((t) => t.id !== early.id);
    assert.notEqual(restored.sessionId, early.sessionId, 'the restored terminal has a shell of its own');
    assert.ok(leavesOf(activeGroup().tree).some((l) => l.tabIds.includes(early.id)), 'on screen');
    assertNothingUnseen('after the restore');
  });

  test('SU-06: the same with nothing to restore — kept beside the first terminal', async () => {
    pageLoad();
    backing.clear();
    const early = await st().createTab(null, { ...PLACEHOLDER });

    await st().init();

    assert.ok(st().tabs.some((t) => t.id === early.id), 'kept');
    assert.ok(mockBridge.ptySessions.has(early.sessionId), 'its shell not reaped');
    assert.equal(st().tabs.length, 2, 'beside the first terminal');
    assertNothingUnseen('after the start');
  });

  test('SU-07: a start that fails still lets the terminal asked for during it be made', async () => {
    pageLoad();
    backing.clear();

    const made = await quietly(() =>
      // The start's first terminal is asked for in the open folder and its
      // shell will not start there; the click asks for no directory.
      withSlowSpawns(
        10,
        async () => {
          const starting = st().init();
          const asked = st().createTab(null, { ...PLACEHOLDER });
          const [, tab] = await Promise.all([starting, asked]);
          return tab;
        },
        { refuse: (args) => args?.cwd === '/workspace' }
      )
    );

    assert.equal(st().isInitialized, false, 'setup: the start failed');
    assert.ok(made, 'the terminal asked for was still made');
    assert.equal(panesHolding(made.id).length, 1, 'and put in a pane');
    assertNothingUnseen('after the failed start');
  });

  test('SU-08: Split Right from the keyboard while a layout is restored focuses the pane it made', async () => {
    const savedIds = await nextTabNumbers(1);
    pageLoad();
    seedLayout(savedIds);

    const newPaneId = await withSlowSpawns(20, async () => {
      const starting = st().init();
      await wait(10);
      const asked = st().splitActivePane('horizontal'); // the placeholder's pane is the active one
      const [, paneId] = await Promise.all([starting, asked]);
      return paneId;
    });

    assert.ok(newPaneId, 'the split happened');
    assert.equal(activeGroup().activePaneId, newPaneId, 'and the pane it made has the focus');
    assertNothingUnseen('after the restore');
  });

  test('SU-09: a pane\'s own split button focuses the new pane by its id alone, wherever it landed', async () => {
    // TerminalSplitContainer's handler, cut from the component and run with
    // what it closes over handed in — as PN-49 runs the registry's calls.
    const src = readFileSync(
      new URL('../../src/components/terminal/TerminalSplitContainer.jsx', import.meta.url),
      'utf8'
    );
    const start = src.indexOf('const handleSplit = useCallback(');
    const end = src.indexOf('\n  );', start) + 5;
    assert.ok(start > 0 && end > start, 'the container splits through handleSplit');
    const calls = [];
    const handleSplit = new Function(
      'useCallback',
      'splitPane',
      'setActivePane',
      'activeGroupIdRef',
      `${src.slice(start, end)}\nreturn handleSplit;`
    )(
      (fn) => fn,
      async (...args) => {
        calls.push(['splitPane', ...args]);
        return 'pane-new';
      },
      (...args) => calls.push(['setActivePane', ...args]),
      { current: 'group-asked' }
    );
    await handleSplit('pane-asked', 'vertical');
    assert.deepEqual(calls, [
      ['splitPane', 'pane-asked', 'vertical', 'group-asked'],
      ['setActivePane', 'pane-new'],
    ]);
  });

  test('SU-10: New Group clicked while a layout is restored is added beside the restored groups', async () => {
    const savedIds = await nextTabNumbers(2);
    pageLoad();
    seedLayout(savedIds);

    const made = await withSlowSpawns(20, async () => {
      const starting = st().init();
      await wait(10);
      const asked = st().createGroup(); // the group switcher's "New Terminal Group"
      const [, group] = await Promise.all([starting, asked]);
      return group;
    });

    assert.ok(made, 'the group was made');
    assert.deepEqual(
      st().groups.map((g) => g.name),
      ['Saved', 'Group 1'],
      'beside the restored group, numbered among the groups that are there'
    );
    assert.equal(st().activeGroupId, made.id, 'and on screen');
    assert.equal(new Set(st().groups.map((g) => g.id)).size, st().groups.length, 'two groups share an id');
    for (const id of savedIds) assert.ok(st().tabs.some((t) => t.id === id), `restored ${id} is there`);
    assertNothingUnseen('after the restore');
  });
});

describe('Startup restore: teardown', () => {
  test('SU-99: teardown — the store disposed, nothing persisted, no shell left', async () => {
    const release = borrowStorage();
    st().dispose();
    backing.clear();
    release();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false, workspaceName: 'Default' });
    await mockBridge.invoke('pty_retain_only', { session_ids: [] });
  });
});
