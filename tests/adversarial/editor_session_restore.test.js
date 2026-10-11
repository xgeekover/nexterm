/**
 * The editor tabs each folder had open, brought back.
 *
 * A restart brought every terminal back and no editor tab; so did opening a
 * folder again after another. The editor now keeps, per folder, its groups
 * and the file each tab shows (src/lib/editorSession.js), writes them behind
 * every change, and reads them back when the folder opens — at launch
 * (`init`) and from Open Folder / Open Recent (`enterRoot`).
 *
 * Every round trip here goes through storage: a "relaunch" disposes the store
 * (which writes out what is pending, as the page going away does), empties
 * it, and runs `init()` again, which has nothing to go on but what storage
 * holds. The backend is the browser mock, in folders of this suite's own.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';
import {
  useEditorStore as E,
  EDITOR_SESSIONS_KEY,
  RESTORE_DEADLINE_MS,
  RESTORE_READ_TIMEOUT_MS,
  readFailureIsFinal,
  whenTabsRestored,
} from '../../src/stores/editorStore.js';
import { collapseDots } from '../../src/lib/paths.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useSystemStore } from '../../src/stores/systemStore.js';
import {
  SESSION_FOLDER_LIMIT,
  SESSION_FORMAT,
  SESSION_TAB_LIMIT,
  restorablePath,
  normalizeSession,
  normalizeSessions,
  restoredLayout,
  serializeSession,
} from '../../src/lib/editorSession.js';

// --- localStorage, borrowed for the length of each case (see TEST_INFRA.md) --
const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
let heldStorage = null;

// --- This suite's folders, in the mock backend -------------------------------
const A = '/er-proj-a';
const B = '/er-proj-b';
const OUTSIDE = '/er-outside';

/** Put a folder holding `names` into the mock, each file's text naming it. */
function makeFolder(root, names) {
  mockBridge.directories.add(root);
  return names.map((name) => {
    const path = `${root}/${name}`;
    mockBridge.files.set(path, `// ${name} on disk\n`);
    return path;
  });
}

/** Every file and folder of this suite out of the mock. */
function removeFolders() {
  for (const dir of [...mockBridge.directories]) {
    if (dir.startsWith('/er-')) mockBridge.directories.delete(dir);
  }
  for (const path of [...mockBridge.files.keys()]) {
    if (path.startsWith('/er-')) mockBridge.files.delete(path);
  }
}

const emptyTree = () => ({ type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null });

/** The store as a page load finds it, before `init()`. */
function emptyStore() {
  E.setState({
    tabs: [],
    activeTabId: null,
    fileTree: [],
    rootPath: '/workspace',
    rootResolved: false,
    expandedFolders: new Set(),
    editorSplitTree: emptyTree(),
    activeEditorPaneId: 'editor-pane-root',
    pendingClose: null,
    pendingOverwrite: null,
    openFailure: null,
    pendingReveal: null,
  });
}

/**
 * Run `fn` with the backend's open folder at `root`: what `fs_get_root`
 * answers at launch (the mock always says /workspace) and what it has open.
 */
async function withRoot(root, fn) {
  const original = mockBridge.invoke;
  mockBridge.root = root;
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'fs_get_root') return Promise.resolve(root);
    return original.call(this, command, args, ...rest);
  };
  try {
    return await fn();
  } finally {
    mockBridge.invoke = original;
  }
}

/** Close the app and start it again with `root` open. Only storage survives. */
async function relaunch(root = A) {
  E.getState().dispose(); // writes out anything pending, as the page going away does
  emptyStore();
  await withRoot(root, () => E.getState().init());
  await whenTabsRestored(); // init() does not wait for the tabs; the cases do
}

/** Open Recent on `root`, and the restore of its tabs it starts. */
async function openFolder(root) {
  const opened = await st().openRoot(root);
  await whenTabsRestored();
  return opened;
}

/**
 * Write out whatever is pending, as `beforeunload` would. Through dispose(),
 * which also stops this run saving until the next init(): call it last.
 */
function flush() {
  E.getState().dispose();
}

/** What storage holds, normalized as the store reads it — or null for nothing. */
function stored() {
  const raw = backing.get(EDITOR_SESSIONS_KEY);
  if (raw == null) return null;
  return normalizeSessions(JSON.parse(raw).data);
}

/** Store a raw payload for the editor sessions, exactly as given. */
function storeRaw(data, version = SCHEMA_VERSION) {
  backing.set(EDITOR_SESSIONS_KEY, JSON.stringify({ version, data }));
}

const st = () => E.getState();
function leaves(node = st().editorSplitTree, acc = []) {
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((child) => leaves(child, acc));
  return acc;
}
const pathOf = (tabId) => st().tabs.find((t) => t.id === tabId)?.filePath ?? null;
const tabOf = (path) => st().tabs.find((t) => t.filePath === path) ?? null;
/** The editor as files: each group's files, its shown file, and which group and file are active. */
function picture() {
  const ls = leaves();
  return {
    groups: ls.map((leaf) => ({ files: leaf.tabIds.map(pathOf), shown: pathOf(leaf.activeTabId) })),
    activeGroup: ls.findIndex((leaf) => leaf.id === st().activeEditorPaneId),
    activeFile: pathOf(st().activeTabId),
  };
}

/** Every `fs_read_file` the store sends while `fn` runs, by path. */
async function readsDuring(fn) {
  const original = mockBridge.invoke;
  const reads = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'fs_read_file') reads.push(args.path);
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
  return reads;
}

/** `console.warn` lines written while `fn` runs. */
async function warningsDuring(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

/**
 * Hold every `fs_read_file` for a path `parks` picks until the case lets it
 * go. `parked` lists them in the order they were asked for.
 */
function parkReads(parks = () => true) {
  const original = mockBridge.invoke;
  const parked = [];
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'fs_read_file' && parks(args.path)) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      parked.push({ path: args.path, release });
      await gate;
    }
    return original.call(this, command, args, ...rest);
  };
  return {
    parked,
    releaseAll: () => parked.forEach((p) => p.release()),
    stop: () => {
      mockBridge.invoke = original;
      parked.forEach((p) => p.release());
    },
  };
}

/** `promise`, or a failure naming `what` if it has not settled within two seconds — never a case that hangs. */
function within(promise, what) {
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle`)), 2000);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Wait until `condition()` holds, a turn of the event loop at a time. */
async function until(condition, what) {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const setRestore = (on) => useSettingsStore.getState().setSetting('editorRestoreTabs', on);

/**
 * Run `fn` with the reads of `big` refused as too large, `locked` as held by
 * another program, and `slow` never answered — a launch while they are so.
 * Any of the three may be left out.
 */
async function failing({ big = null, locked = null, slow = null }, fn) {
  const reads = parkReads((path) => path === slow);
  const original = mockBridge.invoke;
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'fs_read_file' && args.path === big) {
      return Promise.reject(new Error(`File is too large to open (60.1 MB; the limit is 50 MB): ${big}`));
    }
    if (command === 'fs_read_file' && args.path === locked) {
      return Promise.reject(new Error(`Failed to read file '${locked}': The process cannot access the file (os error 32)`));
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    return await withShortTimeouts(fn);
  } finally {
    mockBridge.invoke = original;
    reads.stop();
  }
}

/**
 * Run `fn` with a restore's waits — for one file (RESTORE_READ_TIMEOUT_MS)
 * unless `cut` names others — cut to a moment, so a read that never answers
 * runs out of time in the case rather than seconds later. Every other timer
 * keeps its length.
 */
async function withShortTimeouts(fn, cut = [RESTORE_READ_TIMEOUT_MS]) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...rest) => real(callback, cut.includes(ms) ? 20 : ms, ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

describe('Editor tabs come back per folder', () => {
  beforeEach(async () => {
    heldStorage = globalThis.localStorage;
    globalThis.localStorage = shim;
    backing.clear();
    removeFolders();
    setRestore(true);
    // A launch with nothing saved, in folder A.
    E.getState().dispose();
    emptyStore();
    backing.delete(EDITOR_SESSIONS_KEY);
  });

  afterEach(() => {
    E.getState().dispose();
    globalThis.localStorage = heldStorage;
    heldStorage = null;
  });

  test('ER-01: two groups, their tabs, the shown tab of each, the active group and tab survive a relaunch', async () => {
    const [a, b, c] = makeFolder(A, ['a.js', 'b.js', 'c.js']);
    await relaunch(A);
    assert.equal(st().tabs.length, 0, 'setup: nothing saved, nothing open');

    const tabA = await st().openFile(a);
    const tabB = await st().openFile(b);
    st().dropEditorTabOnPane(tabB.id, 'editor-pane-root', 'right'); // b splits off to the right
    const right = leaves()[1].id;
    await st().openFile(c); // joins the right group, the active one
    st().bindEditorPaneToTab(right, tabB.id); // the right group shows b
    st().setActiveEditorPane(leaves()[0].id); // and the left group is the active one
    assert.equal(st().activeTabId, tabA.id, 'setup: a is the active tab');
    const before = picture();
    assert.deepEqual(before, {
      groups: [
        { files: [a], shown: a },
        { files: [b, c], shown: b },
      ],
      activeGroup: 0,
      activeFile: a,
    });

    await relaunch(A);

    assert.deepEqual(picture(), before, 'the editor did not come back as it was');
    assert.equal(st().editorSplitTree.type, 'split');
    assert.equal(st().editorSplitTree.direction, 'horizontal');
    assert.equal(tabOf(c).content, '// c.js on disk\n', 'a restored tab holds the file as it is on disk');
    assert.equal(tabOf(c).isDirty, false);
    assert.equal(st().openFailure, null);
    // The tabs are the editor's own: a restored tab is saved like any other.
    st().editBuffer(tabOf(c).id, 'edited');
    await st().saveFile(tabOf(c).id);
    assert.equal(mockBridge.files.get(c), 'edited');
  });

  test('ER-02: unsaved edits are not brought back — the file reopens as it is on disk', async () => {
    const [a] = makeFolder(A, ['a.js']);
    await relaunch(A);
    const tab = await st().openFile(a);
    st().editBuffer(tab.id, 'typed and never saved');

    await relaunch(A);

    assert.equal(tabOf(a).content, '// a.js on disk\n');
    assert.equal(tabOf(a).isDirty, false);
    assert.ok(!(backing.get(EDITOR_SESSIONS_KEY) || '').includes('typed and never saved'), 'the text reached storage');
  });

  test('ER-03: each folder keeps its own tabs, and opening one again brings its own back', async () => {
    const [a1, a2] = makeFolder(A, ['a1.js', 'a2.js']);
    const [b1] = makeFolder(B, ['b1.js']);
    await relaunch(A);
    await st().openFile(a1);
    await st().openFile(a2);

    assert.equal(await openFolder(B), B);
    assert.deepEqual(st().tabs.map((t) => t.filePath), [], "B opened with A's tabs");
    await st().openFile(b1);

    assert.equal(await openFolder(A), A);
    assert.deepEqual(picture().groups, [{ files: [a1, a2], shown: a2 }], "A's tabs did not come back");

    assert.equal(await openFolder(B), B);
    assert.deepEqual(picture().groups, [{ files: [b1], shown: b1 }], "B's tabs did not come back");

    // And across a relaunch, each folder its own.
    await relaunch(A);
    assert.deepEqual(st().tabs.map((t) => t.filePath), [a1, a2]);
  });

  test('ER-03b: straight to another folder and back, before the last change was written, loses nothing', async () => {
    const [a1, a2, a3] = makeFolder(A, ['a1.js', 'a2.js', 'a3.js']);
    makeFolder(B, ['b1.js']);
    await relaunch(A);
    await st().openFile(a1);
    await st().openFile(a2);
    await st().openFile(a3); // written behind, not yet on its way to storage

    assert.equal(await openFolder(B), B); // nothing opened there, nothing written for B
    assert.equal(await openFolder(A), A);

    assert.deepEqual(st().tabs.map((t) => t.filePath), [a1, a2, a3], "A's last change was lost on the way out");
  });

  test('ER-04: a file that will not open again is left out quietly; its group keeps the rest, an emptied group goes', async () => {
    const [a, x, y, z] = makeFolder(A, ['a.js', 'x.js', 'y.js', 'z.bin']);
    await relaunch(A);
    await st().openFile(a);
    const tabX = await st().openFile(x);
    st().dropEditorTabOnPane(tabX.id, 'editor-pane-root', 'right');
    st().dropEditorTabOnPane((await st().openFile(y)).id, leaves()[1].id, 'bottom');
    await st().openFile(z);
    assert.equal(leaves().length, 3, 'setup: three groups');
    st().dispose(); // saved

    // Gone and renamed behind the app's back, and one no longer text.
    mockBridge.files.delete(x);
    mockBridge.files.delete(y);
    const original = mockBridge.invoke;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'fs_read_file' && args.path === z) {
        return Promise.reject(new Error(`File is not UTF-8 text: ${z}`));
      }
      return original.call(this, command, args, ...rest);
    };
    let warnings;
    try {
      warnings = await warningsDuring(() => relaunch(A));
    } finally {
      mockBridge.invoke = original;
    }

    assert.deepEqual(picture().groups, [{ files: [a], shown: a }], 'the groups were not cut down to what still opens');
    assert.equal(st().tabs.length, 1);
    assert.equal(st().activeTabId, tabOf(a).id, 'the active tab went with a skipped file and nothing replaced it');
    assert.equal(st().activeEditorPaneId, leaves()[0].id);
    assert.equal(st().openFailure, null, 'a skipped file put up a notice');
    assert.equal(warnings.length, 1, `expected one quiet line, got ${JSON.stringify(warnings)}`);
    for (const name of ['x.js', 'y.js', 'z.bin']) assert.ok(warnings[0].includes(name), `the line does not name ${name}`);

    // What is open now is what is saved: gone, and not text — what opening
    // it by hand would say too — are not tried again.
    flush();
    assert.deepEqual(stored()[0].recent, [a]);
  });

  test('ER-05: when no saved file opens, the editor is the empty group it starts as', async () => {
    const [x] = makeFolder(A, ['x.js']);
    await relaunch(A);
    await st().openFile(x);
    mockBridge.files.delete(x);

    const warnings = await warningsDuring(() => relaunch(A));

    assert.deepEqual(st().editorSplitTree, emptyTree());
    assert.equal(st().activeEditorPaneId, 'editor-pane-root');
    assert.equal(st().activeTabId, null);
    assert.equal(st().openFailure, null);
    assert.equal(warnings.length, 1);
  });

  test(`ER-06: past ${SESSION_TAB_LIMIT} tabs, the most recently active are the ones kept`, async () => {
    const names = Array.from({ length: SESSION_TAB_LIMIT + 5 }, (_, i) => `f${String(i).padStart(2, '0')}.js`);
    const files = makeFolder(A, names);
    await relaunch(A);
    for (const path of files) await st().openFile(path); // f54 the latest
    for (const path of files.slice(0, 5)) await st().openFile(path); // then f00..f04 again
    // So f05..f09 are the five least recently active.

    await relaunch(A);

    const kept = st().tabs.map((t) => t.filePath);
    assert.equal(kept.length, SESSION_TAB_LIMIT);
    for (const path of files.slice(5, 10)) assert.ok(!kept.includes(path), `${path} was kept over a more recent one`);
    assert.deepEqual(
      picture().groups[0].files,
      files.filter((_, i) => i < 5 || i >= 10),
      'the tabs kept are not in the order they were shown in'
    );
    assert.equal(picture().activeFile, files[4], 'the active tab');
  });

  test(`ER-07: past ${SESSION_FOLDER_LIMIT} folders, the one used longest ago is forgotten`, async () => {
    const roots = Array.from({ length: SESSION_FOLDER_LIMIT + 1 }, (_, i) => `/er-cap-${i}`);
    const files = roots.map((root) => makeFolder(root, ['only.js'])[0]);
    await relaunch(roots[0]);
    await st().openFile(files[0]);
    for (let i = 1; i < roots.length; i += 1) {
      assert.equal(await openFolder(roots[i]), roots[i]);
      await st().openFile(files[i]);
    }
    flush();

    const remembered = stored().map((s) => s.root);
    assert.equal(remembered.length, SESSION_FOLDER_LIMIT);
    const raw = JSON.parse(backing.get(EDITOR_SESSIONS_KEY)).data.folders;
    assert.equal(raw.length, SESSION_FOLDER_LIMIT, `storage holds ${raw.length} folders`);
    assert.deepEqual(remembered, roots.slice(1).reverse(), 'not the most recently used first, or the wrong one dropped');

    await relaunch(roots[1]);
    assert.deepEqual(st().tabs.map((t) => t.filePath), [files[1]], 'a folder still remembered lost its tabs');
    assert.equal(await openFolder(roots[0]), roots[0]);
    assert.equal(st().tabs.length, 0, 'the forgotten folder came back with tabs');
  });

  test('ER-08: with Restore Open Editors off nothing comes back, nothing is saved, and what was saved is gone', async () => {
    const [a, b] = makeFolder(A, ['a.js', 'b.js']);
    await relaunch(A);
    await st().openFile(a);
    flush();
    assert.equal(stored().length, 1, 'setup: A is saved');

    try {
      setRestore(false);
      assert.deepEqual(stored(), [], 'turning it off kept the list of files');

      await relaunch(A);
      assert.equal(st().tabs.length, 0, 'restored with the setting off');
      // Nor from a session written while it was on — by a build that kept
      // them, or one that could not clear them.
      storeRaw({
        format: SESSION_FORMAT,
        folders: [{ root: A, tree: { type: 'leaf', files: [a], active: a }, activePane: 0, activeFile: a, recent: [a] }],
      });
      const reads = await readsDuring(() => relaunch(A));
      assert.equal(st().tabs.length, 0, 'restored a saved session with the setting off');
      assert.deepEqual(reads, [], 'read the files of a session it will not restore');
      storeRaw({ format: SESSION_FORMAT, folders: [] });
      await st().openFile(b);
      flush();
      assert.deepEqual(stored(), [], 'saved with the setting off');

      // Back on: what is open now is saved, without waiting for a change.
      await relaunch(A);
      await st().openFile(b);
      setRestore(true);
      flush();
      await relaunch(A);
      assert.deepEqual(st().tabs.map((t) => t.filePath), [b]);
    } finally {
      setRestore(true);
    }
  });

  test('ER-09: init() twice at once, and the StrictMode remount between, open each file once', async () => {
    const files = makeFolder(A, ['a.js', 'b.js', 'c.js']);
    await relaunch(A);
    for (const path of files) await st().openFile(path);
    E.getState().dispose();
    emptyStore();

    const reads = await readsDuring(() =>
      withRoot(A, async () => {
        // App's effect, its StrictMode clean-up, and the effect again.
        const first = st().init();
        st().dispose();
        const second = st().init();
        await Promise.all([first, second, st().init()]);
        await whenTabsRestored();
      })
    );

    assert.deepEqual(st().tabs.map((t) => t.filePath), files, 'a file is open twice, or not at all');
    assert.equal(reads.length, files.length, `read ${reads.length} times for ${files.length} files`);
    assert.equal(leaves().length, 1);
    assert.equal(new Set(leaves()[0].tabIds).size, files.length);
  });

  test('ER-10: a file the user opens while the restore is reading it ends up in one tab — user first', async () => {
    const [a, b] = makeFolder(A, ['a.js', 'b.js']);
    await relaunch(A);
    await st().openFile(a);
    await st().openFile(b); // b active when saved
    E.getState().dispose();
    emptyStore();

    // The restore's two reads wait; the user's own read of a does not.
    let restoring = true;
    const reads = parkReads(() => restoring);
    try {
      const launch = withRoot(A, () => st().init());
      await until(() => reads.parked.length === 2, "the restore's reads");
      restoring = false;
      const mine = await st().openFile(a);
      assert.equal(st().tabs.length, 1, 'setup: the user has a open');
      reads.releaseAll();
      await launch;
      await whenTabsRestored();

      assert.deepEqual(st().tabs.map((t) => t.filePath).sort(), [a, b], 'a file is open twice');
      assert.equal(tabOf(a).id, mine.id, "the user's tab was replaced");
      assert.equal(st().activeTabId, mine.id, 'the restore took the active tab from the file the user just opened');
      assert.equal(leaves().length, 1);
      assert.deepEqual(leaves()[0].tabIds.map(pathOf), [a, b]);
    } finally {
      reads.stop();
    }
  });

  test('ER-11: a file the user asked for before the restore read it, answered after, ends up in one tab — restore first', async () => {
    const [a, b] = makeFolder(A, ['a.js', 'b.js']);
    await relaunch(A);
    await st().openFile(a);
    await st().openFile(b);
    E.getState().dispose();
    emptyStore();

    // The user's read of a is held; the restore's own reads are not.
    let first = true;
    const reads = parkReads(() => {
      const park = first;
      first = false;
      return park;
    });
    try {
      E.setState({ rootPath: A });
      const opening = st().openFile(a);
      await until(() => reads.parked.length === 1, "the user's read");
      await withRoot(A, () => st().init());
      await whenTabsRestored();
      assert.equal(st().tabs.length, 2, 'setup: the restore landed first');
      reads.releaseAll();
      const mine = await opening;

      assert.deepEqual(st().tabs.map((t) => t.filePath).sort(), [a, b], 'a file is open twice');
      assert.equal(mine.id, tabOf(a).id, 'the open handed back a tab that is not on screen');
      assert.equal(st().activeTabId, mine.id, 'the file the user opened is not in front');
    } finally {
      reads.stop();
    }
  });

  test('ER-12: restoring into a folder that already has its tabs open duplicates none and keeps unsaved edits', async () => {
    const [a, b] = makeFolder(A, ['a.js', 'b.js']);
    await relaunch(A);
    await st().openFile(a);
    const tabB = await st().openFile(b);
    st().editBuffer(tabB.id, 'unsaved');

    // A remount (HMR): the store is disposed, its state kept, init() again.
    st().dispose();
    await withRoot(A, () => st().init());
    await whenTabsRestored();

    assert.deepEqual(st().tabs.map((t) => t.filePath), [a, b]);
    assert.equal(tabOf(b).id, tabB.id);
    assert.equal(tabOf(b).content, 'unsaved', 'the restore replaced a buffer with unsaved edits');
    assert.equal(tabOf(b).isDirty, true);
    assert.equal(new Set(leaves().flatMap((l) => l.tabIds)).size, 2);
  });

  test('ER-13: a rename and a delete of open files are what is saved', async () => {
    const [a, b] = makeFolder(A, ['a.js', 'b.js']);
    await relaunch(A);
    await st().openFile(a);
    await st().openFile(b);

    await st().renamePath(b, 'renamed.js');
    await st().deletePath(a);
    flush();

    assert.deepEqual(stored()[0].recent, [`${A}/renamed.js`]);
    await relaunch(A);
    assert.deepEqual(st().tabs.map((t) => t.filePath), [`${A}/renamed.js`]);
  });

  test('ER-14: a restore still reading when another folder opens is dropped, and saves nothing over either folder', async () => {
    const [a1, a2] = makeFolder(A, ['a1.js', 'a2.js']);
    const [b1] = makeFolder(B, ['b1.js']);
    await relaunch(B);
    await st().openFile(b1);
    await relaunch(A);
    await st().openFile(a1);
    await st().openFile(a2);
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => path.startsWith(`${A}/`));
    try {
      const launch = withRoot(A, () => st().init());
      await until(() => reads.parked.length === 2, "A's reads");
      const restoringA = whenTabsRestored();
      assert.equal(await openFolder(B), B);
      reads.releaseAll();
      await launch;
      await restoringA;
    } finally {
      reads.stop();
    }

    assert.equal(st().rootPath, B);
    assert.deepEqual(st().tabs.map((t) => t.filePath), [b1], "A's tabs landed in B");
    flush();
    const saved = Object.fromEntries(stored().map((s) => [s.root, s.recent]));
    assert.deepEqual(saved[A], [a2, a1], "A's saved tabs were lost");
    assert.deepEqual(saved[B], [b1]);
  });

  test('ER-15: storage that is malformed or of another shape is ignored, never a crash', async () => {
    const [a] = makeFolder(A, ['a.js']);
    const leaf = (files) => ({ type: 'leaf', files, active: files[0] ?? null });
    const deep = { type: 'leaf', files: [a], active: a };
    let nested = deep;
    for (let i = 0; i < 200; i += 1) nested = { type: 'split', direction: 'vertical', children: [nested] };

    const payloads = [
      ['not JSON', () => backing.set(EDITOR_SESSIONS_KEY, '{"version": 2, "data": {')],
      ['an older schema', () => storeRaw({ format: SESSION_FORMAT, folders: [{ root: A, tree: leaf([a]) }] }, 1)],
      ['no data', () => storeRaw(null)],
      ['an array', () => storeRaw([{ root: A, tree: leaf([a]) }])],
      ['another format', () => storeRaw({ format: SESSION_FORMAT + 1, folders: [{ root: A, tree: leaf([a]) }] })],
      ['folders not a list', () => storeRaw({ format: SESSION_FORMAT, folders: { root: A } })],
      [
        'junk entries',
        () =>
          storeRaw({
            format: SESSION_FORMAT,
            folders: [null, 42, 'x', { root: 5 }, { root: A }, { root: A, tree: 'leaf' }, { root: A, tree: leaf('a.js') }],
          }),
      ],
      ['a tree nested past any screen', () => storeRaw({ format: SESSION_FORMAT, folders: [{ root: A, tree: nested }] })],
      [
        'splits that are not splits',
        () =>
          storeRaw({
            format: SESSION_FORMAT,
            folders: [{ root: A, tree: { type: 'split', direction: 'diagonal', children: [leaf([a])] } }],
          }),
      ],
    ];
    for (const [what, put] of payloads) {
      backing.clear();
      put();
      E.getState().dispose();
      emptyStore();
      await withRoot(A, () => st().init());
      await whenTabsRestored();
      assert.equal(st().tabs.length, 0, `${what}: something was restored`);
      assert.equal(st().rootPath, A, `${what}: the folder did not open`);
    }
  });

  test('ER-16: a saved path outside the folder is never read, and the rest of the session still comes back', async () => {
    const [a] = makeFolder(A, ['a.js']);
    const [secret] = makeFolder(OUTSIDE, ['secret.txt']);
    const [sibling] = makeFolder(`${A}-evil`, ['x.js']); // shares A's text, not A
    storeRaw({
      format: SESSION_FORMAT,
      folders: [
        {
          root: A,
          tree: {
            type: 'split',
            direction: 'horizontal',
            children: [
              { type: 'leaf', files: [secret, `${A}/../er-outside/secret.txt`, sibling, A, `${A}/./a.js`], active: secret },
              { type: 'leaf', files: [a, a, 7, null, `${A}/a.js\u{0}`], active: a },
            ],
          },
          activePane: 0,
          activeFile: secret,
          recent: [secret, a],
        },
      ],
    });

    const reads = await readsDuring(async () => {
      E.getState().dispose();
      emptyStore();
      await withRoot(A, () => st().init());
      await whenTabsRestored();
    });

    assert.deepEqual(reads, [a], `read ${JSON.stringify(reads)}`);
    assert.deepEqual(picture(), { groups: [{ files: [a], shown: a }], activeGroup: 0, activeFile: a });
  });

  test('ER-17: the session shape — saving and reading back agree, and the reading is strict', () => {
    const state = {
      rootPath: A,
      tabs: [
        { id: 't1', filePath: `${A}/1.js` },
        { id: 't2', filePath: `${A}/2.js` },
        { id: 't3', filePath: `${A}/3.js` },
        { id: 'orphan', filePath: `${A}/orphan.js` }, // in no group
      ],
      editorSplitTree: {
        type: 'split',
        id: 's',
        direction: 'vertical',
        children: [
          { type: 'leaf', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't2' },
          { type: 'leaf', id: 'p-empty', tabIds: [], activeTabId: null }, // just split off, empty
          { type: 'leaf', id: 'p3', tabIds: ['t3'], activeTabId: 't3' },
        ],
      },
      activeEditorPaneId: 'p3',
      activeTabId: 't3',
    };
    const recency = { t1: 1, t2: 2, t3: 3 };
    const session = serializeSession(state, (id) => recency[id] ?? 0);
    assert.deepEqual(session, {
      root: A,
      tree: {
        type: 'split',
        direction: 'vertical',
        children: [
          { type: 'leaf', files: [`${A}/1.js`, `${A}/2.js`], active: `${A}/2.js` },
          { type: 'leaf', files: [`${A}/3.js`], active: `${A}/3.js` },
        ],
      },
      activePane: 1,
      activeFile: `${A}/3.js`,
      recent: [`${A}/3.js`, `${A}/2.js`, `${A}/1.js`],
      misses: {},
    });
    assert.deepEqual(normalizeSession(JSON.parse(JSON.stringify(session))), session, 'what is saved does not read back');
    assert.equal(serializeSession({ ...state, editorSplitTree: emptyTree() }), null, 'nothing open is no session');
    assert.equal(serializeSession({ ...state, rootPath: null }), null, 'no folder is no session');

    let n = 0;
    const layout = restoredLayout(session, (path) => `id:${path}`, (kind) => `${kind}-${(n += 1)}`);
    assert.equal(layout.tree.type, 'split');
    assert.equal(layout.activeTabId, `id:${A}/3.js`);
    assert.equal(layout.activePaneId, layout.tree.children[1].id);
    assert.equal(new Set([layout.tree.id, ...layout.tree.children.map((c) => c.id)]).size, 3, 'ids repeat');
    assert.equal(
      restoredLayout(session, () => null, (kind) => kind),
      null,
      'a layout with no file left is no layout'
    );

    // Folders: one per folder, the first wins, capped.
    const many = Array.from({ length: SESSION_FOLDER_LIMIT + 3 }, (_, i) => ({ ...session, root: `/f${i}`, tree: { type: 'leaf', files: [`/f${i}/x.js`], active: null } }));
    const read = normalizeSessions({ format: SESSION_FORMAT, folders: [many[0], { ...many[0] }, ...many.slice(1)] });
    assert.equal(read.length, SESSION_FOLDER_LIMIT);
    assert.deepEqual(read.map((s) => s.root), many.slice(0, SESSION_FOLDER_LIMIT).map((s) => s.root));

    // Files: strictly inside once `.` and `..` are worked out, either separator.
    assert.equal(restorablePath('C:\\proj', 'C:\\proj\\src\\a.js'), 'C:\\proj\\src\\a.js');
    assert.equal(restorablePath('C:\\proj', 'C:\\proj/src/a.js'), 'C:\\proj/src/a.js');
    assert.equal(restorablePath('C:\\proj', 'C:\\proj\\..\\Windows\\win.ini'), null);
    assert.equal(restorablePath('C:\\proj', 'C:\\project\\a.js'), null);
    assert.equal(restorablePath('C:\\proj', 'C:\\proj'), null);
    assert.equal(restorablePath('C:\\', 'C:\\a.js'), 'C:\\a.js');
    assert.equal(restorablePath('/', '/etc/hosts'), '/etc/hosts', 'a folder that is the filesystem root holds every file');
    assert.equal(restorablePath('/p', '/p/a\u{0}.js'), null);
    assert.equal(restorablePath('/p', 42), null);

    // Two spellings of one Windows file are one tab, the first spelling kept.
    const windows = normalizeSession({
      root: 'C:\\proj',
      tree: { type: 'leaf', files: ['C:\\proj\\a.js', 'C:\\proj/a.js', 'C:\\proj\\b.js'], active: 'C:\\proj/b.js' },
    });
    assert.deepEqual(windows.tree, { type: 'leaf', files: ['C:\\proj\\a.js', 'C:\\proj\\b.js'], active: 'C:\\proj\\b.js' });
  });

  // --- What a review found (the restore runs in the background now) -------

  test('ER-19: a file deleted in the Explorer while the restore reads stays deleted, and is not saved back', async () => {
    const [a, x] = makeFolder(A, ['a.js', 'x.js']);
    await relaunch(A);
    await st().openFile(a);
    await st().openFile(x);
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => path === a); // x is read at once, a holds the restore
    // And the watcher says nothing, as on a drive it cannot watch: the
    // Explorer's own word is what keeps x out.
    const emit = mockBridge.emit;
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 1, 'the read of a');
      mockBridge.emit = async (event, ...rest) => (event === 'fs-change' ? undefined : emit.call(mockBridge, event, ...rest));
      await st().deletePath(x);
      mockBridge.emit = emit;
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      mockBridge.emit = emit;
      reads.stop();
    }

    assert.deepEqual(st().tabs.map((t) => t.filePath), [a], 'the deleted file came back as a tab, with its old text');
    assert.equal(mockBridge.files.has(x), false);
    flush();
    assert.deepEqual(stored()[0].recent, [a]);
  });

  test('ER-20: a file renamed in the Explorer while the restore reads opens under its new name', async () => {
    const [a, b] = makeFolder(A, ['a.js', 'b.js']);
    const renamed = `${A}/renamed.js`;
    await relaunch(A);
    await st().openFile(a);
    await st().openFile(b); // active when saved
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => path === a);
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 1, 'the read of a');
      await st().renamePath(b, 'renamed.js');
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      reads.stop();
    }

    assert.deepEqual(st().tabs.map((t) => t.filePath), [a, renamed], 'the tab is not on the file as it is named now');
    assert.equal(tabOf(renamed).content, '// b.js on disk\n');
    assert.equal(picture().activeFile, renamed);
    flush();
    assert.deepEqual([...stored()[0].recent].sort(), [a, renamed]);
  });

  test('ER-21: what the watcher saw deleted while the restore read is looked at again — gone stays out, written anew comes in', async () => {
    const [a, x, y, z] = makeFolder(A, ['a.js', 'x.js', 'y.js', 'z.js']);
    await relaunch(A);
    for (const path of [a, x, y, z]) await st().openFile(path);
    E.getState().dispose();
    emptyStore();

    // x, y and z are read at once; a holds the restore. z cannot be looked
    // at again — which says nothing about whether it is there.
    const reads = parkReads((path) => path === a);
    const original = mockBridge.invoke;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'fs_file_size' && args.path === z) {
        return Promise.reject(new Error(`Failed to read the size of '${z}': Permission denied (os error 13)`));
      }
      return original.call(this, command, args, ...rest);
    };
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 1, 'the read of a');
      // x deleted by something else — `rm` in a terminal; y deleted and
      // written again, the way a program saving it, or git, does.
      mockBridge.files.delete(x);
      await mockBridge.emit('fs-change', { path: x, kind: 'delete' });
      await mockBridge.emit('fs-change', { path: y, kind: 'delete' });
      await mockBridge.emit('fs-change', { path: z, kind: 'delete' });
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      mockBridge.invoke = original;
      reads.stop();
    }

    assert.deepEqual(st().tabs.map((t) => t.filePath), [a, y, z]);
  });

  test('ER-22: one read that never answers holds nothing back: the rest come in, and that file stays saved', async () => {
    assert.equal(RESTORE_READ_TIMEOUT_MS, 5000);
    const [a, b, stuck] = makeFolder(A, ['a.js', 'b.js', 'stuck.js']);
    await relaunch(A);
    for (const path of [a, stuck, b]) await st().openFile(path);
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => path === stuck); // never answered while the case runs
    let warnings;
    try {
      warnings = await warningsDuring(() =>
        withShortTimeouts(async () => {
          await withRoot(A, () => st().init());
          await within(whenTabsRestored(), 'a restore with a read that never answers');
        })
      );
      assert.deepEqual(st().tabs.map((t) => t.filePath), [a, b], 'the other tabs waited for the one read');
      assert.equal(picture().activeFile, b);
      assert.equal(st().openFailure, null);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('stuck.js (No answer within 5 s)'), warnings[0]);
      flush();
      assert.deepEqual([...stored()[0].recent].sort(), [a, b, stuck], 'the file that did not answer was forgotten');
    } finally {
      reads.stop();
    }
  });

  test('ER-23: while a read hangs, init() and Open Recent settle, and the folder is saved — with what the restore has not read', async () => {
    const [a, u] = makeFolder(A, ['a.js', 'u.js']);
    const [b1] = makeFolder(B, ['b1.js']);
    await relaunch(B);
    await st().openFile(b1);
    await relaunch(A);
    await st().openFile(a);
    E.getState().dispose();
    emptyStore();

    const settles = (promise) =>
      Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 500))]);
    const reads = parkReads((path) => path === a || path === b1); // never answered while the case runs
    try {
      assert.equal(await settles(withRoot(A, () => st().init())), true, 'init() waited for a read that never answers');
      assert.equal(await settles(withRoot(A, () => st().init())), true, 'a second init() was handed the stuck one');
      const tab = await st().openFile(u);
      st().editBuffer(tab.id, 'written while the restore hung');
      await st().saveFile(tab.id);
      flush(); // quit
      assert.deepEqual(
        [...stored()[0].recent].sort(),
        [a, u],
        'quitting while the restore hung lost the file opened meanwhile, or the one still being read'
      );
      // B's own restore hangs on b1 the same way.
      assert.equal(await settles(st().openRoot(B)), true, 'Open Recent waited for the restore');
    } finally {
      reads.stop();
    }

    await relaunch(A);
    assert.deepEqual([...st().tabs.map((t) => t.filePath)].sort(), [a, u]);
  });

  test('ER-24: a path spelled with `..` is the file the Explorer opens, and a tab saved that way still comes back', async () => {
    const [readme] = makeFolder(A, ['README.md']);
    mockBridge.directories.add(`${A}/src`);
    const viaSrc = `${A}/src/../README.md`; // a build run from src printed ../README.md
    mockBridge.files.set(viaSrc, mockBridge.files.get(readme)); // as the backend reads it
    await relaunch(A);

    const fromExplorer = await st().openFile(readme);
    const fromLink = await st().openFileAt(viaSrc, 1);
    assert.equal(fromLink.id, fromExplorer.id, 'the link opened a second tab on the file');
    assert.deepEqual(st().tabs.map((t) => t.filePath), [readme]);

    // Saved by the build before this, spelled as the link was.
    E.getState().dispose();
    storeRaw({
      format: SESSION_FORMAT,
      folders: [{ root: A, tree: { type: 'leaf', files: [viaSrc], active: viaSrc }, activePane: 0, activeFile: viaSrc, recent: [viaSrc] }],
    });
    emptyStore();
    await withRoot(A, () => st().init());
    await whenTabsRestored();
    assert.deepEqual(st().tabs.map((t) => t.filePath), [readme], 'a tab saved with `..` in it was never reopened');
  });

  test('ER-25: paths read back work out `.` and `..`, and leave case aside where the disk does', () => {
    assert.equal(collapseDots('/w/src/../README.md'), '/w/README.md');
    assert.equal(collapseDots('/w/./a/./b.js'), '/w/a/b.js');
    assert.equal(collapseDots('C:\\p\\src\\..\\a.js'), 'C:\\p\\a.js');
    assert.equal(collapseDots('\\\\host\\share\\x\\..\\y.js'), '\\\\host\\share\\y.js');
    assert.equal(collapseDots('/..'), '/');
    assert.equal(collapseDots('C:\\..\\x'), 'C:\\x');
    assert.equal(collapseDots('a/../../b'), '../b');
    const plain = 'C:\\p/mixed\\a.js';
    assert.equal(collapseDots(plain), plain, 'a path with nothing to work out is changed');

    assert.equal(restorablePath('/w', '/w/src/../README.md'), '/w/README.md');
    assert.equal(restorablePath('/w', '/w/src/../../etc/passwd'), null);
    assert.equal(restorablePath('C:\\Proj', 'c:\\proj\\src\\a.js', { caseless: true }), 'C:\\Proj\\src\\a.js');
    assert.equal(restorablePath('/Users/me/Proj', '/users/me/proj/a.js', { caseless: true }), '/Users/me/Proj/a.js');
    assert.equal(restorablePath('C:\\Proj', 'c:\\proj\\src\\a.js'), null, 'case left aside where the disk tells it apart');
    assert.equal(restorablePath('C:\\Proj', 'C:\\Project\\a.js', { caseless: true }), null);

    const raw = {
      root: 'C:\\Proj',
      tree: { type: 'leaf', files: ['C:\\Proj\\A.js', 'c:\\proj\\a.js', 'C:\\Proj\\src\\..\\b.js'], active: 'c:\\PROJ\\B.JS' },
      activePane: 0,
      activeFile: 'c:\\proj\\b.js',
      recent: ['c:\\proj\\b.js'],
    };
    const caseless = normalizeSession(raw, { caseless: true });
    assert.deepEqual(caseless.tree, { type: 'leaf', files: ['C:\\Proj\\A.js', 'C:\\Proj\\b.js'], active: 'C:\\Proj\\b.js' });
    assert.equal(caseless.activeFile, 'C:\\Proj\\b.js');
    assert.deepEqual(caseless.recent, ['C:\\Proj\\b.js', 'C:\\Proj\\A.js']);
    assert.deepEqual(normalizeSession(raw).tree.files, ['C:\\Proj\\A.js', 'C:\\Proj\\b.js'], 'without the option, case counts');
    assert.equal(normalizeSessions({ format: SESSION_FORMAT, folders: [raw] }, { caseless: true })[0].tree.files.length, 2);

    // Two tabs on one file in two cases are saved once — the one used last.
    const twice = {
      rootPath: 'C:\\Proj',
      tabs: [
        { id: 't1', filePath: 'C:\\Proj\\a.js' },
        { id: 't2', filePath: 'C:\\Proj\\A.JS' },
      ],
      editorSplitTree: { type: 'leaf', id: 'p', tabIds: ['t1', 't2'], activeTabId: 't2' },
      activeEditorPaneId: 'p',
      activeTabId: 't2',
    };
    const recency = (id) => (id === 't2' ? 2 : 1);
    assert.deepEqual(serializeSession(twice, recency, { caseless: true }).recent, ['C:\\Proj\\A.JS']);
    assert.equal(serializeSession(twice, recency).recent.length, 2, 'without the option, case counts');
  });

  test('ER-26: at the tab cap, the tabs the user opened while the restore read outrank the restored ones', async () => {
    const names = Array.from({ length: SESSION_TAB_LIMIT }, (_, i) => `f${String(i).padStart(2, '0')}.js`);
    const files = makeFolder(A, [...names, 'u1.js', 'u2.js']);
    const saved = files.slice(0, SESSION_TAB_LIMIT);
    const [u1, u2] = files.slice(SESSION_TAB_LIMIT);
    await relaunch(A);
    for (const path of saved) await st().openFile(path); // f49 the latest
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => path === saved[SESSION_TAB_LIMIT - 1]);
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 1, 'the read of f49');
      await st().openFile(u1);
      await st().openFile(u2);
      await st().openFile(u1); // u1 in front, u2 opened but not
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      reads.stop();
    }
    assert.equal(st().tabs.length, SESSION_TAB_LIMIT + 2);
    flush();

    const kept = stored()[0].recent;
    assert.equal(kept.length, SESSION_TAB_LIMIT);
    assert.ok(kept.includes(u1) && kept.includes(u2), "the user's own tabs went before the last session's");
    assert.ok(!kept.includes(saved[0]) && !kept.includes(saved[1]), 'not the two least recently used that went');
  });

  test('ER-30: a saved file the user opens and closes again while the restore reads stays closed', async () => {
    const [a, b] = makeFolder(A, ['a.js', 'b.js']);
    await relaunch(A);
    await st().openFile(a);
    await st().openFile(b);
    E.getState().dispose();
    emptyStore();

    let restoring = true;
    const reads = parkReads(() => restoring);
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 2, "the restore's reads");
      restoring = false;
      const mine = await st().openFile(b);
      st().closeTab(mine.id);
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      reads.stop();
    }

    assert.deepEqual(st().tabs.map((t) => t.filePath), [a], 'a tab the user closed came back when the restore landed');
    flush();
    assert.deepEqual(stored()[0].recent, [a]);
  });

  test('ER-27: a split made while the restore reads is kept, and the restored tabs join its active group', async () => {
    const [a, b, u] = makeFolder(A, ['a.js', 'b.js', 'u.js']);
    await relaunch(A);
    await st().openFile(a);
    await st().openFile(b);
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => path === a || path === b);
    let right;
    let groups;
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 2, "the restore's reads");
      await st().openFile(u);
      right = st().splitEditorPane('editor-pane-root', 'horizontal'); // the new, empty group is active
      groups = leaves().map((leaf) => leaf.id);
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      reads.stop();
    }

    assert.deepEqual(leaves().map((leaf) => leaf.id), groups, "the user's groups were replaced");
    assert.deepEqual(picture(), {
      groups: [
        { files: [u], shown: u },
        { files: [a, b], shown: b },
      ],
      activeGroup: 1,
      activeFile: b,
    });
    assert.equal(st().activeEditorPaneId, right);
    assert.equal(st().pendingReveal, null, 'the keyboard was asked for, though it was not in the editor');
  });

  test('ER-28: a "close this group?" question open when the restore lands is still about a group that is there', async () => {
    const [a, u, v] = makeFolder(A, ['a.js', 'u.js', 'v.js']);
    await relaunch(A);
    await st().openFile(a);
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => path === a);
    let asked;
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 1, 'the read of a');
      await st().openFile(u);
      const tabV = await st().openFile(v);
      st().dropEditorTabOnPane(tabV.id, 'editor-pane-root', 'right'); // [u] | [v], the right active
      st().editBuffer(tabV.id, 'unsaved');
      asked = leaves()[1].id;
      st().requestCloseEditorPane(asked);
      assert.equal(st().pendingClose?.id, asked, 'setup: the question is open');
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      reads.stop();
    }

    assert.ok(leaves().some((leaf) => leaf.id === asked), 'the group the question is about is gone');
    assert.deepEqual(picture().groups, [
      { files: [u, a], shown: u },
      { files: [v], shown: v },
    ]);
    await st().discardPendingClose();
    assert.deepEqual(st().tabs.map((t) => t.filePath).sort(), [a, u], 'closing the group took the restored tab with it');
  });

  test('ER-29: a file that is gone, too large or not text is forgotten; one that fails for now stays saved until it opens, or the editor is emptied', async () => {
    assert.equal(readFailureIsFinal(new Error('File not found: /x')), true);
    assert.equal(readFailureIsFinal("Failed to read file '/x': it is not a file"), true);
    assert.equal(readFailureIsFinal('Path is outside the workspace root (/w): /x'), true);
    assert.equal(readFailureIsFinal('Path is on another machine or a device: \\\\host\\x'), true);
    assert.equal(readFailureIsFinal('File is too large to open (60.1 MB; the limit is 50 MB): /x'), true);
    assert.equal(readFailureIsFinal('File is not UTF-8 text: /x'), true);
    assert.equal(readFailureIsFinal("Failed to read file '/x': Permission denied (os error 13)"), false);
    assert.equal(readFailureIsFinal("Failed to read file '/x': Path goes through a broken link (/x): /x"), false);
    assert.equal(readFailureIsFinal('No answer within 5 s'), false);

    const [a, gone, big, locked, slow] = makeFolder(A, ['a.js', 'gone.js', 'big.log', 'locked.js', 'slow.js']);
    await relaunch(A);
    for (const path of [slow, locked, big, gone, a]) await st().openFile(path);
    E.getState().dispose();
    emptyStore();
    mockBridge.files.delete(gone);

    await failing({ big, locked, slow }, async () => {
      await within(warningsDuring(() => relaunch(A)), 'the launch');
      assert.deepEqual(st().tabs.map((t) => t.filePath), [a]);
      flush();
    });
    assert.deepEqual([...stored()[0].recent].sort(), [a, locked, slow].sort(), 'the wrong files were forgotten');
    assert.deepEqual(stored()[0].misses, { [locked]: 1, [slow]: 1 });

    // They open again: back they come, and nothing counts against them.
    await relaunch(A);
    assert.deepEqual([...st().tabs.map((t) => t.filePath)].sort(), [a, locked, slow].sort());
    flush();
    assert.deepEqual(stored()[0].misses, {});

    // Failing again, and the user closes the one tab that opened: nothing is open, nothing saved.
    E.getState().dispose();
    await failing({ big, locked, slow }, async () => {
      await within(warningsDuring(() => relaunch(A)), 'the launch');
      st().closeTab(tabOf(a).id);
      flush();
    });
    assert.deepEqual(stored(), [], 'an editor the user emptied still brings files back');
  });

  // --- A second review ------------------------------------------------------

  test('ER-31: a tab the user opened while the restore read stays in its group, in front, with the keyboard', async () => {
    const [a, b, u] = makeFolder(A, ['a.js', 'b.js', 'u.js']);
    // Saved: two groups, the right one active.
    storeRaw({
      format: SESSION_FORMAT,
      folders: [
        {
          root: A,
          tree: {
            type: 'split',
            direction: 'horizontal',
            children: [
              { type: 'leaf', files: [a], active: a },
              { type: 'leaf', files: [b], active: b },
            ],
          },
          activePane: 1,
          activeFile: b,
          recent: [b, a],
        },
      ],
    });
    emptyStore();

    const reads = parkReads((path) => path === a);
    const hadDocument = 'document' in globalThis;
    const heldDocument = globalThis.document;
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 1, 'the read of a');
      const mine = await st().openFile(u); // in the starting group, and typed in
      st().editBuffer(mine.id, 'abc');
      // The keyboard is in that editor when the restore lands.
      globalThis.document = { activeElement: { closest: (selector) => (selector.includes('data-editor-pane-body') ? {} : null) } };
      reads.releaseAll();
      await whenTabsRestored();

      assert.equal(st().editorSplitTree.type, 'leaf', 'the group the user was typing in was replaced');
      assert.equal(st().editorSplitTree.id, 'editor-pane-root');
      assert.equal(st().activeEditorPaneId, 'editor-pane-root');
      assert.equal(st().activeTabId, mine.id, 'the tab being typed in is no longer the active one');
      assert.equal(st().editorSplitTree.activeTabId, mine.id, 'its group no longer shows it');
      assert.deepEqual(picture().groups[0].files, [u, a, b], 'the restored tabs did not join its group, in the saved order');
      assert.equal(tabOf(u).content, 'abc');
      assert.deepEqual(st().pendingReveal, { filePath: u, line: null, column: null }, 'the keyboard was not handed back');
    } finally {
      if (hadDocument) globalThis.document = heldDocument;
      else delete globalThis.document;
      reads.stop();
    }
  });

  test('ER-32: a file renamed in the Explorer while its read is under way, or before it starts, opens under its new name', async () => {
    const [p1, p2, p3, c, q] = makeFolder(A, ['p1.js', 'p2.js', 'p3.js', 'c.js', 'q.js']);
    await relaunch(A);
    for (const path of [q, p1, p2, p3, c]) await st().openFile(path); // read c, p3, p2, p1, then q
    E.getState().dispose();
    emptyStore();

    const reads = parkReads((path) => [p1, p2, p3, c].includes(path));
    try {
      await withRoot(A, () => st().init());
      await until(() => reads.parked.length === 4, 'the first four reads');
      await st().renamePath(c, 'c-renamed.js'); // its read is out, asking for c.js
      await st().renamePath(q, 'q-renamed.js'); // its read has not started
      reads.releaseAll();
      await whenTabsRestored();
    } finally {
      reads.stop();
    }

    const paths = st().tabs.map((t) => t.filePath);
    assert.ok(paths.includes(`${A}/c-renamed.js`), 'the file renamed while it was read was dropped');
    assert.ok(paths.includes(`${A}/q-renamed.js`), 'the file renamed before it was read was dropped');
    assert.equal(tabOf(`${A}/c-renamed.js`).content, '// c.js on disk\n');
    assert.equal(paths.length, 5);
  });

  test('ER-33: files kept for next time are saved in the groups they came from, not the active one', async () => {
    const [a, b, k1, k2, k3] = makeFolder(A, ['a.js', 'b.js', 'k1.js', 'k2.js', 'k3.js']);
    const saved = {
      type: 'split',
      direction: 'horizontal',
      children: [
        { type: 'leaf', files: [a, k1], active: a },
        { type: 'leaf', files: [b, k2], active: b },
        { type: 'leaf', files: [k3], active: k3 },
      ],
    };
    storeRaw({
      format: SESSION_FORMAT,
      folders: [{ root: A, tree: saved, activePane: 1, activeFile: b, recent: [b, a, k1, k2, k3] }],
    });
    emptyStore();

    const original = mockBridge.invoke;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'fs_read_file' && [k1, k2, k3].includes(args.path)) {
        return Promise.reject(new Error(`Failed to read file '${args.path}': The process cannot access the file (os error 32)`));
      }
      return original.call(this, command, args, ...rest);
    };
    try {
      await warningsDuring(async () => {
        await withRoot(A, () => st().init());
        await whenTabsRestored();
      });
    } finally {
      mockBridge.invoke = original;
    }
    assert.deepEqual(picture().groups, [
      { files: [a], shown: a },
      { files: [b], shown: b },
    ]);
    // A change, so that the carried files are saved again with it.
    st().setActiveEditorPane(leaves()[0].id);
    flush();

    assert.deepEqual(stored()[0].tree, saved, 'the files not read were saved somewhere else');
    assert.deepEqual(stored()[0].misses, { [k1]: 1, [k2]: 1, [k3]: 1 });
  });

  test('ER-34: a file that fails launch after launch is forgotten at the third, and a restore never waits past its deadline', async () => {
    assert.equal(RESTORE_DEADLINE_MS, 15000);
    const [a, k] = makeFolder(A, ['a.js', 'k.js']);
    const session = (misses) => ({
      format: SESSION_FORMAT,
      folders: [
        {
          root: A,
          tree: { type: 'leaf', files: [a, k], active: a },
          activePane: 0,
          activeFile: a,
          recent: [a, k],
          misses,
        },
      ],
    });
    const launch = async () => {
      let warnings;
      await failing({ locked: k }, async () => {
        warnings = await within(warningsDuring(() => relaunch(A)), 'the launch');
        flush();
      });
      return warnings;
    };

    E.getState().dispose();
    storeRaw(session({}));
    await launch();
    assert.deepEqual(stored()[0].misses, { [k]: 1 }, 'the first failed launch was not counted');
    await launch();
    assert.deepEqual(stored()[0].misses, { [k]: 2 });
    const warnings = await launch();
    assert.deepEqual(stored()[0].recent, [a], 'still saved after three failed launches');
    assert.ok(warnings[0].includes('not read in 3 launches, forgotten'), warnings[0]);

    // A drive that answers nothing: the restore lands at its deadline, with
    // nothing read, and every file kept for next time.
    E.getState().dispose();
    storeRaw(session({}));
    emptyStore();
    const reads = parkReads(() => true);
    try {
      await withShortTimeouts(async () => {
        await withRoot(A, () => st().init());
        await within(warningsDuring(() => whenTabsRestored()), 'a restore past its deadline');
      }, [RESTORE_DEADLINE_MS]);
      assert.equal(st().tabs.length, 0);
      flush();
      assert.deepEqual(stored()[0].misses, { [a]: 1, [k]: 1 });
    } finally {
      reads.stop();
    }
  });

  test('ER-35: where the disk does not tell case apart, two spellings of one file are one tab — restored, opened or saved', async () => {
    const [a] = makeFolder(A, ['a.js']);
    const upper = `${A}/A.js`;
    const heldOs = useSystemStore.getState().os;
    try {
      useSystemStore.setState({ os: 'windows' });
      await relaunch(A);
      const tab = await st().openFile(a);
      assert.equal((await st().openFile(`${A}/A.JS`)).id, tab.id, 'a second tab on one file, by its case');

      // Saved as `A.js`; the user opens `a.js` while it is read.
      mockBridge.files.set(upper, mockBridge.files.get(a)); // as a case-blind disk reads it
      E.getState().dispose();
      storeRaw({
        format: SESSION_FORMAT,
        folders: [{ root: A, tree: { type: 'leaf', files: [upper], active: upper }, activePane: 0, activeFile: upper, recent: [upper] }],
      });
      emptyStore();
      const reads = parkReads((path) => path === upper);
      try {
        await withRoot(A, () => st().init());
        await until(() => reads.parked.length === 1, 'the read of A.js');
        await st().openFile(a);
        reads.releaseAll();
        await whenTabsRestored();
      } finally {
        reads.stop();
      }
      assert.deepEqual(st().tabs.map((t) => t.filePath), [a], 'restored beside the same file in another case');

      // Two tabs on one file in two cases, however they came about: saved once.
      const extra = { ...tabOf(a), id: 'tab-upper', filePath: upper };
      E.setState((state) => ({
        tabs: [...state.tabs, extra],
        editorSplitTree: { ...state.editorSplitTree, tabIds: [...state.editorSplitTree.tabIds, extra.id] },
      }));
      flush();
      assert.equal(stored()[0].recent.length, 1, 'one file saved twice');

      // Where the disk tells case apart, they are two files.
      useSystemStore.setState({ os: 'linux' });
      await relaunch(A);
      await st().openFile(a);
      mockBridge.files.delete(upper);
      await assert.rejects(st().openFile(`${A}/A.JS`), /File not found/);
      st().dismissOpenFailure();
    } finally {
      useSystemStore.setState({ os: heldOs });
    }
  });

  test('ER-36: at the deadline, only a file whose read was asked for counts a failed launch', async () => {
    const files = makeFolder(A, ['f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js', 'f6.js']);
    E.getState().dispose();
    storeRaw({
      format: SESSION_FORMAT,
      folders: [{ root: A, tree: { type: 'leaf', files, active: files[0] }, activePane: 0, activeFile: files[0], recent: files }],
    });
    emptyStore();

    // Nothing answers; four reads go out at a time, so f5 and f6 are never asked for.
    const reads = parkReads(() => true);
    try {
      await withShortTimeouts(async () => {
        await withRoot(A, () => st().init());
        await within(warningsDuring(() => whenTabsRestored()), 'a restore past its deadline');
      }, [RESTORE_DEADLINE_MS]);
      assert.deepEqual(reads.parked.map((r) => r.path), files.slice(0, 4), 'setup: the first four were asked for');
      flush();
    } finally {
      reads.stop();
    }

    const counted = Object.fromEntries(files.slice(0, 4).map((path) => [path, 1]));
    assert.deepEqual(stored()[0].misses, counted, 'files never asked for were counted as failing');
    assert.deepEqual(stored()[0].recent, files, 'a file was dropped');
  });

  test('ER-37: a file failing every time its folder opens counts once a run, however often the folder opens', async () => {
    const [a, k] = makeFolder(A, ['a.js', 'k.js']);
    makeFolder(B, ['b1.js']);
    await relaunch(A);
    await st().openFile(k);
    await st().openFile(a);

    await failing({ locked: k }, async () => {
      await warningsDuring(async () => {
        await relaunch(A); // a new run: its first failed read of k counts
        for (let i = 0; i < 3; i += 1) {
          await openFolder(B);
          await openFolder(A); // the same run: k fails again, and does not count again
        }
      });
      flush();
    });
    assert.deepEqual(stored().find((s) => s.root === A).misses, { [k]: 1 }, 'counted more than once in one run');

    await failing({ locked: k }, async () => {
      await warningsDuring(() => relaunch(A)); // the next run counts again
      flush();
    });
    assert.deepEqual(stored().find((s) => s.root === A).misses, { [k]: 2 });
  });

  test('ER-18: teardown — nothing of this suite left in the mock or the store', () => {
    removeFolders();
    delete mockBridge.root;
    setRestore(true);
    E.getState().dispose();
    E.setState({
      tabs: [],
      activeTabId: null,
      rootPath: '/workspace',
      rootResolved: true,
      expandedFolders: new Set(['/workspace']),
      editorSplitTree: emptyTree(),
      activeEditorPaneId: 'editor-pane-root',
      openFailure: null,
    });
    assert.equal(st().tabs.length, 0);
  });
});
