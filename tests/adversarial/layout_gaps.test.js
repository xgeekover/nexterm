/**
 * The behaviours the existing suites could be deleted out from under.
 *
 * A verification pass over the terminal layout work found six pieces of logic
 * that could each be removed with every test still green. Each case below was
 * written against the deletion first — the assertion fails with the guard
 * taken out — so the suite actually holds the behaviour down.
 *
 * Three live in the store; three live in the renderer's handshake with
 * react-resizable-panels (src/components/terminal/splitLayout.js), which is
 * the half of "restore a group's remembered arrangement" that a store-only
 * test can never see.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import {
  sizesOf,
  layoutOf,
  panelMinSize,
  shouldReconcile,
  sizesFromLayout,
  SIZE_EPSILON,
} from '../../src/components/terminal/splitLayout.js';

// --- localStorage shim, borrowed for the length of this file ---------------
const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
const previousLocalStorage = globalThis.localStorage;
globalThis.localStorage = shim;

const { useTerminalStore: S } = await import('../../src/stores/terminalStore.js');

globalThis.localStorage = previousLocalStorage;

/** Reinstall this file's shim for one case, then hand the global back. */
function borrowStorage() {
  const held = globalThis.localStorage;
  globalThis.localStorage = shim;
  return () => {
    globalThis.localStorage = held;
  };
}

const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const splitsOf = (node, acc = []) => {
  if (!node || node.type !== 'split') return acc;
  acc.push(node);
  node.children.forEach((c) => splitsOf(c, acc));
  return acc;
};
const st = () => S.getState();
/** Replace one group's whole tree, as a restored payload would. */
const updateGroupTree = (groups, groupId, tree) =>
  groups.map((g) => (g.id === groupId ? { ...g, tree, activePaneId: leavesOf(tree)[0].id } : g));
const groupById = (id) => st().groups.find((g) => g.id === id);
const allPanes = () => st().groups.flatMap((g) => leavesOf(g.tree));
const panesHolding = (tabId) => allPanes().filter((p) => p.tabIds.includes(tabId));

async function relaunch() {
  S.getState().dispose();
  backing.clear();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
  await S.getState().init();
}

describe('Layout gaps: behaviours no test was holding down', () => {
  let release;

  beforeEach(async () => {
    release = borrowStorage();
    await relaunch();
  });

  // --- M1: settle's cross-group dedupe ------------------------------------
  test(
    'GAP-01: a terminal can never be shown in two places at once, even across groups',
    async () => {
      const first = st().groups[0];
      const tabId = st().activeTabId;

      const second = await S.getState().createGroup({ name: 'Second' });
      assert.ok(second, 'a second group must be creatable');

      // Force the invariant violation `settle` exists to repair: plant the
      // SAME live tab in a pane of the other group, the way a half-applied
      // drop or a restored payload naming one tab twice would.
      S.setState((state) => ({
        groups: state.groups.map((g) => {
          if (g.id !== second.id) return g;
          const pane = leavesOf(g.tree)[0];
          return {
            ...g,
            tree: { ...pane, tabIds: [...pane.tabIds, tabId], activeTabId: tabId },
          };
        }),
      }));
      assert.equal(panesHolding(tabId).length, 2, 'precondition: the tab really is planted twice');

      // Any action that runs the state through `settle` must heal it.
      S.getState().setActiveGroup(first.id);

      const holders = panesHolding(tabId);
      assert.equal(holders.length, 1, 'settle must drop the duplicate placement');
      assert.ok(
        leavesOf(groupById(first.id).tree).some((l) => l.id === holders[0].id),
        'the copy that survives is the one in the group that owned it first'
      );
      for (const pane of allPanes()) {
        assert.ok(
          pane.tabIds.length === 0 || pane.tabIds.includes(pane.activeTabId),
          `pane ${pane.id} still shows one of its own tabs after the repair`
        );
      }
    }
  );

  // --- M4: keepSizes renormalization --------------------------------------
  test('GAP-02: closing one pane of a lopsided split rescales the survivors to 100%', async () => {
    const group = st().groups[0];
    const rootPane = leavesOf(group.tree)[0].id;

    // `splitPane` always nests (a pane becomes a split of itself plus the new
    // pane), so a split with three SIBLINGS only ever arrives from a restored
    // payload. Build one the way the restorer would, over real terminals.
    await S.getState().splitPane(rootPane, 'horizontal', group.id);
    const a = leavesOf(groupById(group.id).tree);
    await S.getState().splitPane(a[1].id, 'horizontal', group.id);
    const panes = leavesOf(groupById(group.id).tree);
    assert.equal(panes.length, 3, 'three panes, however they are nested');

    const splitId = 'split-flat-1';
    S.setState((state) => ({
      groups: updateGroupTree(state.groups, group.id, {
        type: 'split',
        id: splitId,
        direction: 'horizontal',
        // A deliberately lopsided arrangement, so an unscaled survivor list
        // would be obvious: 20 / 30 / 50.
        sizes: [20, 30, 50],
        children: panes.map((p) => ({ ...p })),
      }),
    }));

    const flat = splitsOf(groupById(group.id).tree).find((sp) => sp.id === splitId);
    assert.ok(flat, 'the flat three-child split is in place');
    assert.deepEqual(flat.sizes, [20, 30, 50], 'with its stored sizes');

    // Drop the middle pane. 20 + 50 = 70 — if the survivors were carried
    // through as-is the split would only cover 70% of the row.
    await S.getState().closePane(panes[1].id, group.id);

    const after = splitsOf(groupById(group.id).tree).find((sp) => sp.id === splitId);
    assert.ok(after, 'the split survives with two children');
    assert.equal(after.children.length, 2, 'two panes remain');
    const total = after.sizes.reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(total - 100) < 0.001, `surviving sizes must sum to 100, got ${total}`);
    // 20:50 renormalized is 28.57:71.43 — the proportions are kept. Sizes are
    // stored rounded to two decimals, so compare at that resolution.
    assert.deepEqual(after.sizes, [28.57, 71.43], 'the survivors keep their relative shares');
  });

  // --- M6: closeGroup on the last group -----------------------------------
  test('GAP-03: closing the only group empties it instead of leaving nowhere to put a terminal', async () => {
    assert.equal(st().groups.length, 1, 'precondition: exactly one group');
    const onlyId = st().groups[0].id;

    await S.getState().closeGroup(onlyId);

    assert.equal(st().groups.length, 1, 'there is always at least one group');
    const survivor = st().groups[0];
    assert.equal(survivor.id, onlyId, 'the group itself survives rather than being replaced');
    const panes = leavesOf(survivor.tree);
    assert.equal(panes.length, 1, 'it is left with a single empty pane');
    assert.equal(panes[0].tabIds.length, 0, 'that pane holds no terminals');
    assert.equal(panes[0].activeTabId, null, 'an empty pane has no active tab');
    assert.equal(survivor.activePaneId, panes[0].id, 'activePaneId names the pane that is there');
    assert.equal(st().activeGroupId, onlyId, 'the emptied group is still the active one');
    assert.equal(st().tabs.length, 0, 'its terminal was killed with it');

    // And the app is still usable: a new terminal lands in that empty pane.
    const tab = await S.getState().createTab();
    assert.ok(tab, 'a terminal can still be opened afterwards');
    assert.equal(panesHolding(tab.id).length, 1, 'the new terminal is placed exactly once');
  });

  // --- M10: setActiveGroup honours each group's own activePaneId -----------
  test('GAP-04: switching groups restores the pane that group was last focused on', async () => {
    const first = st().groups[0];
    const second = await S.getState().createGroup({ name: 'Second' });

    // Give the second group three panes and focus the LAST one, so falling
    // back to "the first pane" would be visibly wrong.
    const seedPane = leavesOf(groupById(second.id).tree)[0].id;
    await S.getState().splitPane(seedPane, 'horizontal', second.id);
    const two = leavesOf(groupById(second.id).tree);
    await S.getState().splitPane(two[1].id, 'vertical', second.id);

    const panes = leavesOf(groupById(second.id).tree);
    assert.equal(panes.length, 3, 'the second group has three panes');
    const target = panes[2];
    S.getState().setActivePane(target.id, second.id);
    assert.equal(groupById(second.id).activePaneId, target.id);

    // Go away and come back.
    S.getState().setActiveGroup(first.id);
    assert.equal(st().activeGroupId, first.id);
    S.getState().setActiveGroup(second.id);

    assert.equal(
      groupById(second.id).activePaneId,
      target.id,
      'the group comes back focused on the pane it was left on'
    );
    assert.equal(
      st().activeTabId,
      target.activeTabId,
      'and the active terminal is that pane’s, not the first pane’s'
    );
    assert.ok(
      leavesOf(groupById(second.id).tree).find((l) => l.id === target.id).tabIds.includes(st().activeTabId),
      'the active terminal really lives in the restored pane'
    );
  });

  // --- M11: the renderer is handed the remembered sizes --------------------
  test('GAP-05: a restored split hands the library its stored sizes, not an even split', async () => {
    const group = st().groups[0];
    const rootPane = leavesOf(group.tree)[0].id;
    await S.getState().splitPane(rootPane, 'horizontal', group.id);
    const split = splitsOf(groupById(group.id).tree)[0];
    S.getState().setPaneSizes(group.id, split.id, [70, 30]);

    const stored = splitsOf(groupById(group.id).tree)[0];
    const layout = layoutOf(stored);

    // `defaultLayout` is the only thing that seeds the arrangement at mount,
    // and `defaultSize` has to agree with it panel for panel.
    assert.deepEqual(
      Object.keys(layout),
      stored.children.map((c) => c.id),
      'the layout names exactly this split’s children'
    );
    assert.equal(layout[stored.children[0].id], 70, 'the first panel is seeded at its stored share');
    assert.equal(layout[stored.children[1].id], 30, 'the second panel is seeded at its stored share');
    assert.deepEqual(
      sizesOf(stored).map(String),
      ['70', '30'],
      'each Panel’s defaultSize matches its entry in defaultLayout'
    );

    // Malformed or partial sizes must still produce a usable layout rather
    // than a pane at zero width.
    const broken = { ...stored, sizes: [0, -4] };
    assert.deepEqual(sizesOf(broken), [50, 50], 'unusable sizes fall back to an even split');
    const missing = { ...stored, sizes: undefined };
    assert.deepEqual(sizesOf(missing), [50, 50], 'absent sizes fall back to an even split');
    const unnormalized = { ...stored, sizes: [1, 3] };
    assert.deepEqual(sizesOf(unnormalized), [25, 75], 'sizes that do not sum to 100 are rescaled');

    // minSize has to stay satisfiable as children are added, or the library
    // rejects the whole layout and the arrangement is lost.
    assert.equal(panelMinSize(2), '15');
    assert.equal(panelMinSize(6), '15');
    assert.equal(panelMinSize(7), '12');
    for (let n = 2; n <= 24; n++) {
      const min = Number(panelMinSize(n));
      assert.ok(min >= 4, `minSize stays above the floor at ${n} panes`);
      assert.ok(min * n <= 100, `${n} panes at ${min}% each must still fit in 100%`);
    }
  });

  // --- M12: the reconcile, and the guard that stops the library winning ----
  test('GAP-06: the live group is pushed back to the store, and only a real drag writes back', () => {
    const node = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [{ id: 'pane-a' }, { id: 'pane-b' }],
      sizes: [70, 30],
    };
    const layout = layoutOf(node);

    // React reuses the Group across a group switch, so mount-time defaults
    // never re-run: an even 50/50 has to be corrected to the stored 70/30.
    assert.equal(
      shouldReconcile({ 'pane-a': 50, 'pane-b': 50 }, layout),
      true,
      'a live layout that disagrees with the store must be corrected'
    );
    assert.equal(
      shouldReconcile({ 'pane-a': 70, 'pane-b': 30 }, layout),
      false,
      'an agreeing layout must be left alone'
    );
    assert.equal(
      shouldReconcile({ 'pane-a': 70 + SIZE_EPSILON / 2, 'pane-b': 30 - SIZE_EPSILON / 2 }, layout),
      false,
      'sub-epsilon drift is not worth a round trip'
    );
    // `setLayout` throws on a layout that does not name exactly the Group's
    // panels, which is the state mid-registration and after a pane closes.
    assert.equal(shouldReconcile({ 'pane-a': 100 }, layout), false, 'too few panels: do not call setLayout');
    assert.equal(
      shouldReconcile({ 'pane-a': 40, 'pane-b': 40, 'pane-c': 20 }, layout),
      false,
      'too many panels: do not call setLayout'
    );
    assert.equal(
      shouldReconcile({ 'pane-a': 70, 'pane-b': undefined }, layout),
      false,
      'a panel with no measured size: do not call setLayout'
    );

    // The write-back guard. Without it the library echoes our own `setLayout`
    // straight back into the store, which is how a restored layout gets
    // overwritten by the even split it was momentarily showing.
    const ids = ['pane-a', 'pane-b'];
    assert.deepEqual(
      sizesFromLayout(ids, { 'pane-a': 60, 'pane-b': 40 }, { isUserInteraction: true }),
      [60, 40],
      'a real separator drag is persisted'
    );
    assert.equal(
      sizesFromLayout(ids, { 'pane-a': 50, 'pane-b': 50 }, { isUserInteraction: false }),
      null,
      'the library echoing a non-user change must never reach the store'
    );
    assert.equal(
      sizesFromLayout(ids, { 'pane-a': 60 }, { isUserInteraction: true }),
      null,
      'a partial layout is ignored rather than half-written'
    );
    assert.equal(
      sizesFromLayout(ids, { 'pane-a': 60, 'pane-b': 0 }, { isUserInteraction: true }),
      null,
      'a zero-width pane is ignored rather than persisted'
    );
  });
});

/**
 * A paste the kernel will discard must be SEEN.
 *
 * The line discipline drops a canonical-mode line at MAX_CANON whole — not
 * truncated — so the backend refuses it up front (src-tauri/src/pty/manager.rs
 * proves the kernel behaviour). That refusal is only worth anything if it
 * reaches the screen; it used to go to `console.error`, which is how a pasted
 * block could vanish with nothing to show for it.
 */
describe('A refused write is shown to the user, not swallowed', () => {
  let release;
  let notices;
  let unsink;
  let consoleErrors;
  let realConsoleError;

  beforeEach(async () => {
    release = borrowStorage();
    await relaunch();
    notices = [];
    consoleErrors = [];
    realConsoleError = console.error;
    console.error = (...args) => consoleErrors.push(args.join(' '));
    unsink = setTerminalNoticeSink((tabId, message) => {
      notices.push({ tabId, message });
      return true;
    });
  });

  test('PASTE-01: the backend’s refusal is printed into the terminal it was meant for', async () => {
    const tabId = st().activeTabId;
    const tab = st().tabs.find((t) => t.id === tabId);

    // Stand in for the backend refusing an over-limit paste.
    const refusal =
      '4096 bytes were not sent: the program reading this terminal takes at most 1023 bytes on one line.';
    const bridge = await import('../../src/lib/ipc.js');
    const original = bridge.mockBridge.invoke.bind(bridge.mockBridge);
    bridge.mockBridge.invoke = async (command, args) => {
      if (command === 'pty_write' && args?.session_id === tab.sessionId) throw new Error(refusal);
      return original(command, args);
    };

    try {
      await S.getState().writeRaw(tabId, 'a'.repeat(4096));
    } finally {
      bridge.mockBridge.invoke = original;
    }

    assert.equal(notices.length, 1, 'exactly one notice must be shown');
    assert.equal(notices[0].tabId, tabId, 'it goes to the terminal the paste was aimed at');
    assert.ok(
      notices[0].message.includes('were not sent'),
      `the user is told the paste did not go: ${notices[0].message}`
    );
    assert.equal(
      consoleErrors.length,
      0,
      'nothing is swallowed to the console once the user has been told'
    );
  });

  test('PASTE-02: with no terminal on screen to tell, the failure still reaches the console', async () => {
    unsink();
    unsink = setTerminalNoticeSink(null);

    const tabId = st().activeTabId;
    const tab = st().tabs.find((t) => t.id === tabId);
    const bridge = await import('../../src/lib/ipc.js');
    const original = bridge.mockBridge.invoke.bind(bridge.mockBridge);
    bridge.mockBridge.invoke = async (command, args) => {
      if (command === 'pty_write' && args?.session_id === tab.sessionId) throw new Error('nope');
      return original(command, args);
    };

    try {
      await S.getState().writeRaw(tabId, 'x');
    } finally {
      bridge.mockBridge.invoke = original;
    }

    assert.equal(notices.length, 0, 'no notice could be drawn');
    assert.equal(consoleErrors.length, 1, 'so the failure is not lost entirely');
  });

  test('PASTE-03: teardown', () => {
    unsink();
    console.error = realConsoleError;
    release();
    assert.ok(true);
  });
});
