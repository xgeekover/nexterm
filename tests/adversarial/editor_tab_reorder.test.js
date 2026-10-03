/**
 * Reordering editor tabs: drag a chip along its own tab strip, or drop it at a
 * position in another group's strip.
 *
 * Before this a chip could only be dropped on a pane's BODY — the centre
 * appended it to that group and the edges split — so the order of the tabs in
 * a strip could not be changed at all.
 *
 * Every case drives the real `moveEditorTabInStrip`, on files opened through
 * the real `openFile` and the browser mock bridge. The order a strip draws is
 * its leaf's `tabIds` — nothing else in the app holds one — so that is what
 * the cases read back.
 *
 * The index is a GAP in the strip as drawn when the drop happens, with the
 * dragged chip still in it: the pointer is compared against the chips on
 * screen, and the dragged one stays on screen, dimmed, for the whole gesture.
 * That makes moving RIGHT the direction that is easy to get wrong. Both gaps
 * beside a chip mean "where it already is", and every gap past it is one
 * further along than the slot the tab ends up in.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke } from '../../src/lib/ipc.js';

const S = useEditorStore;
const ROOT = 'editor-pane-root';
const tree = () => S.getState().editorSplitTree;
const move = (tabId, paneId, index) => S.getState().moveEditorTabInStrip(tabId, paneId, index);

function leaves(node = tree(), acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leaves(c, acc));
  return acc;
}
const pane = (paneId) => leaves().find((l) => l.id === paneId);
const leafOf = (tabId) => leaves().find((l) => l.tabIds.includes(tabId));
const strip = (paneId) => pane(paneId)?.tabIds;

/** Every group's strip, by pane id. */
const strips = () => Object.fromEntries(leaves().map((l) => [l.id, [...l.tabIds]]));

/** Store notifications while `fn` runs. A drop that changes nothing must cause none. */
function notificationsDuring(fn) {
  let count = 0;
  const unsubscribe = S.subscribe(() => {
    count += 1;
  });
  try {
    fn();
  } finally {
    unsubscribe();
  }
  return count;
}

/**
 * The semantics written a second way, to check the store against: mark the
 * gap in the strip as drawn, take the dragged tab out of wherever it was, and
 * put it where the mark is. No index arithmetic, so it cannot share an
 * off-by-one with the store.
 */
function expectedStrip(drawn, tabId, gap) {
  const at = Math.min(Math.max(Math.floor(gap), 0), drawn.length);
  const MARK = Symbol('gap');
  return [...drawn.slice(0, at), MARK, ...drawn.slice(at)]
    .filter((id) => id !== tabId)
    .map((id) => (id === MARK ? tabId : id));
}

/** Deterministic, so a failing sequence can be replayed. */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let scratchCounter = 0;
const scratchDirs = [];

/**
 * Fresh files in a scratch folder, opened in order into the root group, so
 * this suite never depends on (or disturbs) the /workspace fixture other
 * suites read. Returns the tab ids in strip order.
 */
async function openScratchFiles(n) {
  scratchCounter += 1;
  const dir = `/workspace/_editor_tab_reorder_${Date.now()}_${scratchCounter}`;
  await invoke('fs_create_dir', { path: dir });
  scratchDirs.push(dir);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const path = `${dir}/file-${i}.js`;
    await invoke('fs_write_file', { path, content: `// file ${i}\n` });
    ids.push((await S.getState().openFile(path)).id);
  }
  return ids;
}

/**
 * Two groups made the way a user makes them, by dropping on a pane's edge and
 * centre: the root keeps the first `n` tabs, the group split off to its right
 * holds the rest. Returns the right-hand group's id.
 */
function splitAfter(ids, n) {
  S.getState().dropEditorTabOnPane(ids[n], ROOT, 'right');
  const right = leafOf(ids[n]).id;
  for (const id of ids.slice(n + 1)) S.getState().dropEditorTabOnPane(id, right, 'center');
  return right;
}

let ids;

describe('Editor tabs: reordering within a strip and inserting into another', () => {
  beforeEach(async () => {
    S.setState({
      tabs: [],
      activeTabId: null,
      pendingClose: null,
      editorSplitTree: { type: 'leaf', id: ROOT, tabIds: [], activeTabId: null },
      activeEditorPaneId: ROOT,
    });
    ids = await openScratchFiles(5);
  });

  test('ETR-01: dragged right, a tab lands in the gap the pointer was over', () => {
    const [a, b, c, d, e] = ids;
    // Gap 3 is between c and d as drawn. `a` has left slot 0 by the time it
    // lands, so it ends up in slot 2 — the off-by-one this case exists for.
    move(a, ROOT, 3);
    assert.deepEqual(strip(ROOT), [b, c, a, d, e]);

    // One more gap to the right, from the middle.
    move(c, ROOT, 4);
    assert.deepEqual(strip(ROOT), [b, a, d, c, e]);
  });

  test('ETR-02: dragged left, a tab lands in the gap the pointer was over', () => {
    const [a, b, c, d, e] = ids;
    move(d, ROOT, 1);
    assert.deepEqual(strip(ROOT), [a, d, b, c, e]);

    move(e, ROOT, 2);
    assert.deepEqual(strip(ROOT), [a, d, e, b, c]);
  });

  test('ETR-03: the first gap puts it first and the last gap puts it last', () => {
    const [a, b, c, d, e] = ids;
    move(c, ROOT, 0);
    assert.deepEqual(strip(ROOT), [c, a, b, d, e]);

    move(c, ROOT, 5);
    assert.deepEqual(strip(ROOT), [a, b, d, e, c]);

    move(e, ROOT, 0);
    assert.deepEqual(strip(ROOT), [e, a, b, d, c]);
  });

  test('ETR-04: both gaps beside its own chip keep the order, and the tab becomes the visible one', () => {
    const [a, b, c, d, e] = ids;
    assert.equal(pane(ROOT).activeTabId, e, 'precondition: the last file opened is showing');

    move(b, ROOT, 1);
    assert.deepEqual(strip(ROOT), [a, b, c, d, e], 'the gap before b moved it');
    assert.equal(pane(ROOT).activeTabId, b, 'the dragged tab is not the one its group shows');
    assert.equal(S.getState().activeTabId, b);

    move(b, ROOT, 2);
    assert.deepEqual(strip(ROOT), [a, b, c, d, e], 'the gap after b moved it');
  });

  test('ETR-05: a gap outside the strip is clamped to its ends; a fraction rounds down', () => {
    const [a, b, c, d, e] = ids;
    // -1, not some large negative: `splice` reads -1 as "before the last
    // element", so an unclamped gap lands in the wrong place instead of
    // happening to land at 0.
    move(c, ROOT, -1);
    assert.deepEqual(strip(ROOT), [c, a, b, d, e], 'a negative gap did not mean the front');

    move(c, ROOT, 99);
    assert.deepEqual(strip(ROOT), [a, b, d, e, c], 'a gap past the end did not mean the end');

    move(a, ROOT, 2.7);
    assert.deepEqual(strip(ROOT), [b, a, d, e, c], 'gap 2.7 is not gap 2');

    move(e, ROOT, -Infinity);
    assert.deepEqual(strip(ROOT), [e, b, a, d, c]);
  });

  test('ETR-06: a drop that changes nothing changes no state', () => {
    const [, , , , e] = ids;
    // `e` is the visible tab, its group the active one: dropping it either
    // side of its own chip asks for exactly what is already there.
    const before = S.getState();
    const notified = notificationsDuring(() => {
      move(e, ROOT, 4);
      move(e, ROOT, 5);
    });
    assert.equal(notified, 0, 'subscribers were told about a change that is not one');
    assert.equal(S.getState(), before, 'the store state was replaced');
  });

  test('ETR-07: an unknown tab, an unknown group or a gap that is not a number changes nothing', () => {
    const [a] = ids;
    const before = S.getState();
    const notified = notificationsDuring(() => {
      move('tab-edit-nope', ROOT, 0);
      move(a, 'editor-pane-nope', 0);
      move(a, ROOT, NaN);
      move(a, ROOT, undefined);
      move(a, ROOT, '3');
    });
    assert.equal(notified, 0);
    assert.equal(S.getState(), before);
  });

  test("ETR-08: dropped in another group's strip, a tab is inserted at the gap, not appended", () => {
    const [a, b, c, d, e] = ids;
    const right = splitAfter(ids, 3);
    assert.deepEqual(strips(), { [ROOT]: [a, b, c], [right]: [d, e] }, 'precondition');
    // The press that starts a drag focuses the group the chip is in.
    S.getState().setActiveEditorPane(ROOT);

    move(a, right, 1);

    assert.deepEqual(strips(), { [ROOT]: [b, c], [right]: [d, a, e] });
    assert.equal(pane(right).activeTabId, a, 'the dropped tab is not the one its new group shows');
    assert.equal(S.getState().activeEditorPaneId, right, 'focus did not follow the tab');
    assert.equal(S.getState().activeTabId, a);
    assert.ok(pane(ROOT).tabIds.includes(pane(ROOT).activeTabId), 'the group it left shows a tab it no longer has');
  });

  test("ETR-09: the first and last gaps of another group's strip, clamped like its own", () => {
    const [a, b, c, d, e] = ids;
    const right = splitAfter(ids, 3);

    move(b, right, 0);
    assert.deepEqual(strip(right), [b, d, e]);

    move(c, right, 3);
    assert.deepEqual(strip(right), [b, d, e, c]);

    move(a, right, 99);
    assert.deepEqual(strip(right), [b, d, e, c, a]);
  });

  test("ETR-10: moving a group's last tab out collapses that group, as a centre drop does", () => {
    const [a, b, c, d, e] = ids;
    const right = splitAfter(ids, 4);
    assert.deepEqual(strip(right), [e], 'precondition');

    move(e, ROOT, 1);

    assert.equal(leaves().length, 1, 'an empty group was left behind');
    assert.deepEqual(strip(ROOT), [a, e, b, c, d]);
    assert.equal(S.getState().activeEditorPaneId, ROOT);
  });

  test('ETR-11: a move never collapses an empty group the user split off and has not filled', () => {
    const [a, b, c, d, e] = ids;
    const empty = S.getState().splitEditorPane(ROOT, 'horizontal');
    assert.deepEqual(strip(empty), [], 'precondition');

    move(a, ROOT, 5);
    assert.deepEqual(strip(ROOT), [b, c, d, e, a]);
    assert.deepEqual(strip(empty), [], 'reordering one strip removed another group');

    // Filling one empty group must leave a second empty one alone too.
    const another = S.getState().splitEditorPane(empty, 'vertical');
    move(c, empty, 0);
    assert.deepEqual(strip(empty), [c]);
    assert.deepEqual(strip(another), [], 'moving a tab between two groups removed a third');
  });

  test('ETR-12: a dirty file keeps its unsaved content and its dirty flag wherever it moves', async () => {
    const [a, b, c] = ids;
    const path = S.getState().tabs.find((t) => t.id === b).filePath;
    S.getState().editBuffer(b, '// edited, not saved\n');
    const dirty = () => S.getState().tabs.find((t) => t.id === b);
    const tabsBefore = S.getState().tabs;

    move(b, ROOT, 5);
    assert.equal(S.getState().tabs, tabsBefore, 'a reorder rewrote the open buffers');

    const right = splitAfter(ids, 3);
    move(b, right, 0);
    assert.equal(strip(right)[0], b, 'precondition: b moved groups');

    assert.equal(dirty().content, '// edited, not saved\n', 'the unsaved edit was lost');
    assert.equal(dirty().savedContent, '// file 1\n');
    assert.equal(dirty().isDirty, true, 'the tab no longer says it is unsaved');
    assert.equal(await invoke('fs_read_file', { path }), '// file 1\n', 'moving a tab wrote it to disk');
    assert.ok(strip(ROOT).includes(a) && strip(ROOT).includes(c), 'other tabs went missing');
  });

  test('ETR-13: later actions keep the dragged order', async () => {
    const [a, b, c, d, e] = ids;
    move(e, ROOT, 0);
    move(a, ROOT, 5);
    assert.deepEqual(strip(ROOT), [e, b, c, d, a]);

    S.getState().closeTab(c);
    assert.deepEqual(strip(ROOT), [e, b, d, a], 'closing a tab undid the order');

    const path = S.getState().tabs.find((t) => t.id === b).filePath;
    await S.getState().openFile(path);
    assert.deepEqual(strip(ROOT), [e, b, d, a], 'revealing an open file reordered the strip');
    assert.equal(pane(ROOT).activeTabId, b);

    S.getState().bindEditorPaneToTab(ROOT, d);
    assert.deepEqual(strip(ROOT), [e, b, d, a], 'clicking a tab reordered the strip');
  });

  test('ETR-14: 300 random drops across three groups each land where the gap semantics say', async () => {
    const extra = await openScratchFiles(1);
    const all = [...ids, ...extra];
    const random = seededRandom(0x7ab5);
    const pick = (list) => list[Math.floor(random() * list.length)];

    for (let round = 0; round < 15; round++) {
      // Three groups: the root, one to its right, one below that.
      S.setState({
        editorSplitTree: { type: 'leaf', id: ROOT, tabIds: [...all], activeTabId: all[0] },
        activeEditorPaneId: ROOT,
        activeTabId: all[0],
      });
      const right = splitAfter(all, 2);
      S.getState().dropEditorTabOnPane(all[4], right, 'bottom');
      S.getState().dropEditorTabOnPane(all[5], leafOf(all[4]).id, 'center');
      assert.equal(leaves().length, 3, 'precondition: three groups');

      for (let step = 0; step < 20; step++) {
        const before = strips();
        const tabId = pick(all);
        const target = pick(Object.keys(before));
        const source = leafOf(tabId).id;
        // One gap either side of the strip, so clamping is exercised too.
        const gap = Math.floor(random() * (before[target].length + 3)) - 1;

        const expected = { ...before };
        if (source !== target) {
          expected[source] = before[source].filter((id) => id !== tabId);
          if (expected[source].length === 0) delete expected[source];
        }
        expected[target] = expectedStrip(before[target], tabId, gap);

        move(tabId, target, gap);

        const where = `round ${round}, step ${step}: ${tabId} to gap ${gap} of ${target}`;
        assert.deepEqual(strips(), expected, where);
        assert.equal(pane(target).activeTabId, tabId, `${where}: not the visible tab`);
        assert.equal(S.getState().activeEditorPaneId, target, `${where}: focus did not follow`);
        for (const l of leaves()) {
          assert.ok(l.tabIds.includes(l.activeTabId), `${where}: ${l.id} shows a tab it does not hold`);
        }
        for (const id of all) {
          assert.equal(leaves().filter((l) => l.tabIds.includes(id)).length, 1, `${where}: ${id} lost or duplicated`);
        }
      }
    }
  });

  test('ETR-15: teardown — the editor is back to one empty group, and the scratch files are gone', async () => {
    S.setState({
      tabs: [],
      activeTabId: null,
      pendingClose: null,
      editorSplitTree: { type: 'leaf', id: ROOT, tabIds: [], activeTabId: null },
      activeEditorPaneId: ROOT,
    });
    for (const dir of scratchDirs.splice(0)) {
      await invoke('fs_delete_path', { path: dir, recursive: true });
    }
    assert.deepEqual(strips(), { [ROOT]: [] });
  });
});
