/**
 * A right-click on a row of the Explorer opens THAT row's menu.
 *
 * From the tree's rebuild (f156cd5) until the Windows run (V30, V37), a row's
 * `contextmenu` went on up to the tree, whose own handler — meant for the
 * empty space below the rows — replaced the row with the workspace root and
 * cleared the selection. Every row offered New File and New Folder, and Cut,
 * Copy, Paste, Rename and Delete stayed greyed out: nothing in the Explorer
 * could be copied, pasted or deleted. `renderToString` runs no handler, so
 * TreeRow is mounted here (react_page.js) inside a parent with a menu of its
 * own, as FileExplorer's tree is.
 *
 * And a refused rename says why. Tauri rejects with the backend's own string,
 * which has no `message`, so the field said only "Failed" (V37).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage, dispatch } from './react_page.js';
import { failureReason, failureText } from '../../src/components/explorer/treeRows.js';

const h = React.createElement;

const EXPLORER_DIR = fileURLToPath(new URL('../../src/components/explorer/', import.meta.url));
/** Kept real: the React the page renders with must be the one the component calls. */
const REAL = new Set(['react', 'react/jsx-runtime', 'lucide-react']);

let loading = null;
function loadTreeRow() {
  loading ??= build({
    stdin: {
      contents: "export { TreeRow } from './TreeRow.jsx';",
      resolveDir: EXPLORER_DIR,
      sourcefile: 'tree-row-under-test.js',
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
        name: 'real-react',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            REAL.has(args.path) ? { path: import.meta.resolve(args.path), external: true } : undefined
          );
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

const FILE_ROW = { node: { path: '/w/src/a.txt', name: 'a.txt' }, depth: 1, isFolder: false, isExpanded: false };
const FOLDER_ROW = { node: { path: '/w/src', name: 'src' }, depth: 0, isFolder: true, isExpanded: true };

/** The tree as FileExplorer draws it: a container with its own empty-area menu, the rows inside. */
function tree(TreeRow, rows, calls) {
  return h(
    'div',
    { role: 'tree', onContextMenu: () => calls.push(['empty-area menu']) },
    rows.map((row) =>
      h(TreeRow, {
        key: row.node.path,
        row,
        isSelected: false,
        isFocused: true,
        isCut: false,
        onSelect: (r) => calls.push(['select', r.node.path]),
        onActivate: (r) => calls.push(['activate', r.node.path]),
        onToggle: () => {},
        onContextMenu: (e, r) => calls.push(['row menu', r.node.path, e.clientX, e.clientY]),
        renaming: false,
      })
    )
  );
}

describe('Explorer: a right-click on a row opens that row\'s menu', () => {
  test('RM-01: a file row\'s menu is the row\'s; the tree\'s empty-area menu does not open over it', async () => {
    const { TreeRow } = await loadTreeRow();
    await onPage(async (p) => {
      const calls = [];
      p.render(tree(TreeRow, [FOLDER_ROW, FILE_ROW], calls));
      const row = p.document.querySelector('[data-path="/w/src/a.txt"]');
      assert.ok(row, 'precondition: the file row is drawn');

      const event = p.settled(() => dispatchContextMenu(p, row, 140, 230));
      assert.deepEqual(
        calls,
        [
          ['select', '/w/src/a.txt'],
          ['row menu', '/w/src/a.txt', 140, 230],
        ],
        'the row is selected and its own menu asked for, at the pointer'
      );
      assert.ok(!calls.some(([what]) => what === 'empty-area menu'), 'the empty-area menu never saw the event');
      assert.equal(event.defaultPrevented, true, 'and the browser\'s own menu is not shown');
    });
  });

  test('RM-02: a folder row, the same — its menu, not the workspace root\'s', async () => {
    const { TreeRow } = await loadTreeRow();
    await onPage(async (p) => {
      const calls = [];
      p.render(tree(TreeRow, [FOLDER_ROW, FILE_ROW], calls));
      p.settled(() => dispatchContextMenu(p, p.document.querySelector('[data-path="/w/src"]'), 20, 40));
      assert.deepEqual(calls, [
        ['select', '/w/src'],
        ['row menu', '/w/src', 20, 40],
      ]);
    });
  });

  test('RM-03: a right-click on the space below the rows still opens the empty-area menu', async () => {
    const { TreeRow } = await loadTreeRow();
    await onPage(async (p) => {
      const calls = [];
      p.render(tree(TreeRow, [FILE_ROW], calls));
      p.settled(() => dispatchContextMenu(p, p.document.querySelector('[role="tree"]'), 50, 600));
      assert.deepEqual(calls, [['empty-area menu']], 'no row was involved');
    });
  });
});

describe('Explorer: a refused rename says why', () => {
  test('RM-04: the backend\'s string is the text; an Error\'s message is; nothing is an empty string', () => {
    const backend =
      'Path has a name that ends in a dot or a space, which Windows would read as another: C:\\proj\\v37-dot.';
    assert.equal(failureText(backend), backend, 'Tauri rejects with a plain string');
    assert.equal(failureText(new Error('boom')), 'boom', 'the browser mock rejects with an Error');
    assert.equal(failureText(undefined), '');
  });

  test('RM-05: beside the name, the reason without the path the backend appends', () => {
    assert.equal(
      failureReason('Path has a name that ends in a dot or a space, which Windows would read as another: C:\\proj\\v37-dot.'),
      'Path has a name that ends in a dot or a space, which Windows would read as another'
    );
    assert.equal(failureReason('Already exists: /w/src/b.txt'), 'Already exists');
    assert.equal(failureReason('Path goes through a link to another machine: \\\\host\\share\\x'), 'Path goes through a link to another machine');
    assert.equal(failureReason('Permission denied (os error 5)'), 'Permission denied (os error 5)', 'no path, kept whole');
    assert.equal(failureReason('C:\\only\\a\\path'), 'C:\\only\\a\\path', 'never left empty');
  });
});

/** A right-click arriving on `node`, as the browser sends it. */
function dispatchContextMenu(p, node, clientX, clientY) {
  return dispatch(p.window, node, { type: 'contextmenu', button: 2, clientX, clientY });
}

// ---- A focused tree always shows where the keyboard is -----------------------
//
// The keyboard ring lives in the base layer, so the tree's `outline-none`
// really takes it off the tree, and the tree shows focus through its rows. It
// marked only a selected row: with nothing selected (no file open, or after a
// click on the space below the rows) Tab into the tree showed nothing at all.
// FileExplorer is mounted whole here, with its stores stood in for, because
// what it marks depends on `treeFocused` and `focusIndex`, state that only a
// real focus event and real keys reach.

const STAND_INS = {
  editorStore: `
    import { create } from 'zustand';
    export const calls = [];
    export const useEditorStore = create((set, get) => ({
      fileTree: [],
      isLoadingTree: false,
      rootResolved: true,
      rootPath: '/w',
      recentRoots: [],
      expandedFolders: new Set(),
      selectedPath: null,
      creatingEntry: null,
      renamingPath: null,
      tabs: [],
      activeTabId: null,
      clipboard: null,
      pasting: null,
      refreshExplorer: async () => {},
      openRoot: async () => {},
      pickRoot: async () => {},
      createFile: async () => {},
      createFolder: async () => {},
      deletePath: async () => {},
      renamePath: async () => {},
      copyToClipboard: () => {},
      cutToClipboard: () => {},
      pasteClipboard: async () => {},
      tabsUnder: () => [],
      setCreatingEntry: (creatingEntry) => set({ creatingEntry }),
      beginRename: (renamingPath) => set({ renamingPath }),
      cancelRename: () => set({ renamingPath: null }),
      setSelectedPath: (selectedPath) => set({ selectedPath }),
      openFile: async (path) => {
        calls.push(['openFile', path]);
      },
      toggleFolder: (path) => {
        const next = new Set(get().expandedFolders);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        set({ expandedFolders: next });
      },
      setFolderExpanded: (path, open) => {
        const next = new Set(get().expandedFolders);
        if (open) next.add(path);
        else next.delete(path);
        set({ expandedFolders: next });
      },
    }));`,
  settingsStore: `
    import { create } from 'zustand';
    export const useSettingsStore = create(() => ({ filesEnableTrash: true }));`,
  systemStore: `
    import { create } from 'zustand';
    export const useSystemStore = create(() => ({ os: 'macos' }));`,
  gitStore: `
    import { create } from 'zustand';
    export const useGitStore = create(() => ({ status: null }));
    export const fileStatusIn = () => null;`,
  // Dragging a row onto a terminal is terminal_file_drop's.
  pathDrag: `
    export function useExplorerPathDrag() {
      return { onRowPointerDown: () => {}, ghost: null, ghostRef: { current: null } };
    }`,
  copyText: `export async function copyText() {}`,
  workspaceFocus: `export function focusWorkspace() {}`,
};

/** Which stand-in a module FileExplorer imports is replaced by, if any. */
function explorerStandIn(path) {
  const store = /\/stores\/(editor|settings|system|git)Store\.js$/.exec(path);
  if (store) return `${store[1]}Store`;
  if (/\/hooks\/useExplorerPathDrag\.js$/.test(path)) return 'pathDrag';
  if (/\/lib\/copyText\.js$/.test(path)) return 'copyText';
  if (/\/lib\/workspaceFocus\.js$/.test(path)) return 'workspaceFocus';
  return null;
}

/** Kept real for the whole explorer: React, its DOM half, the store library and the icons. */
const EXPLORER_REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'zustand', 'lucide-react']);

let loadingExplorer = null;
function loadExplorer() {
  loadingExplorer ??= build({
    stdin: {
      contents: [
        "export { FileExplorer } from './FileExplorer.jsx';",
        "export { useEditorStore, calls } from '../../stores/editorStore.js';",
      ].join('\n'),
      resolveDir: EXPLORER_DIR,
      sourcefile: 'file-explorer-under-test.js',
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
        name: 'explorer-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (EXPLORER_REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            const standIn = explorerStandIn(args.path);
            return standIn ? { path: standIn, namespace: 'stand-in' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({
            contents: STAND_INS[args.path],
            loader: 'js',
            resolveDir: EXPLORER_DIR,
          }));
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loadingExplorer;
}

/** A folder holding one file, and a file beside it: three rows with the folder open. */
const FILE_TREE = [
  { name: 'src', path: '/w/src', is_dir: true, children: [{ name: 'a.txt', path: '/w/src/a.txt', is_dir: false }] },
  { name: 'b.txt', path: '/w/b.txt', is_dir: false },
];

/**
 * The Explorer, mounted on a page, from a fresh store holding `state`. The
 * effect that keeps the focused row in view asks `CSS.escape`, which a
 * browser has and Node does not: lent for the case.
 */
async function onExplorer(state, fn) {
  const ui = await loadExplorer();
  ui.useEditorStore.setState(ui.useEditorStore.getInitialState(), true);
  ui.useEditorStore.setState({ fileTree: FILE_TREE, expandedFolders: new Set(['/w/src']), ...state });
  ui.calls.length = 0;
  const hadCSS = Object.hasOwn(globalThis, 'CSS');
  const css = globalThis.CSS;
  globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  try {
    await onPage(async (p) => {
      // The inline name field selects its text as it opens; the page's inputs
      // have no selection of their own, so this page lends them a `select`.
      const make = p.document.createElement.bind(p.document);
      p.document.createElement = (tag) => {
        const el = make(tag);
        if (el.tagName === 'INPUT') el.select = () => {};
        return el;
      };
      p.render(h(ui.FileExplorer));
      const tree = () => p.document.querySelector('[role="tree"]');
      await fn({
        p,
        ui,
        tree,
        rows: () => p.document.querySelectorAll('[role="treeitem"]'),
        focus: () =>
          p.settled(() => {
            tree().focus();
            dispatch(p.window, tree(), { type: 'focusin', relatedTarget: null });
          }),
        blur: () =>
          p.settled(() => {
            tree().blur();
            dispatch(p.window, tree(), { type: 'focusout', relatedTarget: null });
          }),
        // A press on the space below the rows: the tree's own, which clears the selection.
        pressEmptySpace: () => p.settled(() => dispatch(p.window, tree(), { type: 'mousedown', button: 0 })),
      });
    });
  } finally {
    if (hadCSS) globalThis.CSS = css;
    else delete globalThis.CSS;
  }
}

const classOf = (el) => el.getAttribute('class') || '';
const pathOf = (el) => el.getAttribute('data-path');
/** The selected look, focused or not (TreeRow). */
const selectedLook = (el) => /(^|\s)bg-vsc-(inactive-)?selection(\s|$)/.test(classOf(el));
/** The keyboard-ring colour on a row: the focus mark. */
const focusMark = (el) => /vsc-focus-ring/.test(classOf(el));
/** The rows that do not look like a row at rest: `rest` is a row's class with nothing on it. */
const markedRows = (rows, rest) => rows.filter((el) => classOf(el) !== rest);

describe('Explorer: a focused tree always shows where the keyboard is (K-01)', () => {
  test('RM-06: focused with rows and nothing selected, exactly one row is marked, the one the arrow keys move from, in the ring colour', async () => {
    await onExplorer({}, async ({ p, rows, focus, blur }) => {
      const before = rows();
      assert.equal(before.length, 3, 'precondition: three rows');
      const rest = classOf(before[0]);
      assert.ok(before.every((el) => classOf(el) === rest), 'unfocused and with nothing selected, every row is at rest');
      assert.ok(!before.some(focusMark), 'and none carries the focus mark');

      focus();
      const marked = markedRows(rows(), rest);
      assert.deepEqual(marked.map(pathOf), ['/w/src'], 'focused, exactly one row is marked: the first, where the arrow keys start');
      assert.ok(focusMark(marked[0]), `the mark is the keyboard-ring colour: ${classOf(marked[0])}`);
      assert.ok(!selectedLook(marked[0]), 'and it is not the selected look: nothing is selected');
      assert.ok(rows().every((el) => el.getAttribute('aria-selected') !== 'true'), 'nothing is announced as selected');

      // The arrow keys move from the marked row.
      p.keydown('ArrowDown');
      assert.deepEqual(rows().filter(selectedLook).map(pathOf), ['/w/src/a.txt'], 'ArrowDown selects the row below the mark');

      blur();
      assert.ok(!rows().some(focusMark), 'a tree without focus marks no row for it');
    });
  });

  test('RM-07: focused with a selection, the selected row shows only its selected look, and no other row is marked', async () => {
    await onExplorer({ selectedPath: '/w/b.txt' }, async ({ rows, focus }) => {
      const rest = classOf(rows()[1]);
      focus();
      const marked = markedRows(rows(), rest);
      assert.deepEqual(marked.map(pathOf), ['/w/b.txt'], 'one row is marked: the selected one');
      assert.ok(/(^|\s)bg-vsc-selection(\s|$)/.test(classOf(marked[0])), `the selected row has the focused selection: ${classOf(marked[0])}`);
      assert.ok(!rows().some(focusMark), 'and no row draws a second mark');
    });
    // The open file stands for the selection while nothing is selected: the same.
    await onExplorer(
      { tabs: [{ id: 'tab-1', filePath: '/w/src/a.txt' }], activeTabId: 'tab-1' },
      async ({ rows, focus }) => {
        const rest = classOf(rows()[0]);
        focus();
        const marked = markedRows(rows(), rest);
        assert.deepEqual(marked.map(pathOf), ['/w/src/a.txt'], "one row is marked: the open file's");
        assert.ok(selectedLook(marked[0]) && !focusMark(marked[0]), `only the selected look: ${classOf(marked[0])}`);
      }
    );
  });

  test('RM-08: a press on the space below the rows clears the selection; the row the keyboard was on keeps the mark', async () => {
    await onExplorer({}, async ({ p, ui, rows, focus, pressEmptySpace }) => {
      const rest = classOf(rows()[0]);
      focus();
      p.keydown('ArrowDown');
      p.keydown('ArrowDown');
      assert.deepEqual(rows().filter(selectedLook).map(pathOf), ['/w/b.txt'], 'precondition: the keys selected the last row');
      pressEmptySpace();
      assert.equal(ui.useEditorStore.getState().selectedPath, null, 'precondition: the press cleared the selection');
      const marked = markedRows(rows(), rest);
      assert.deepEqual(marked.map(pathOf), ['/w/b.txt'], 'the row the keyboard was on is the one marked');
      assert.ok(focusMark(marked[0]) && !selectedLook(marked[0]), `in the ring colour, not as selected: ${classOf(marked[0])}`);
      p.keydown('ArrowUp');
      assert.deepEqual(rows().filter(selectedLook).map(pathOf), ['/w/src/a.txt'], 'ArrowUp moves from the marked row');
      assert.ok(!rows().some(focusMark), 'and once a row is selected the mark is gone');
    });
  });

  test('RM-09: rows hidden under the keyboard\u{2019}s row still leave exactly one row marked, and the keys move from it', async () => {
    await onExplorer({}, async ({ p, ui, rows, focus, pressEmptySpace }) => {
      const rest = classOf(rows()[0]);
      focus();
      p.keydown('End');
      pressEmptySpace();
      // The folder closes (Collapse All, the watcher, another window): two rows left, the keyboard's index past them.
      p.settled(() => ui.useEditorStore.setState({ expandedFolders: new Set() }));
      assert.equal(rows().length, 2, 'precondition: two rows');
      const marked = markedRows(rows(), rest);
      assert.deepEqual(marked.map(pathOf), ['/w/b.txt'], 'the last row is marked, not none');
      assert.ok(focusMark(marked[0]));
      p.keydown('ArrowUp');
      assert.deepEqual(rows().filter(selectedLook).map(pathOf), ['/w/src'], 'ArrowUp moves from the marked row');
    });
  });

  test('RM-10: an empty tree takes the ring itself; a tree with rows leaves it to its rows', async () => {
    await onExplorer({ fileTree: [] }, async ({ tree }) => {
      assert.equal(tree().querySelectorAll('[role="treeitem"]').length, 0, 'precondition: no rows');
      assert.ok(!/(^|\s)outline-none(\s|$)/.test(classOf(tree())), `an empty tree keeps the keyboard ring: ${classOf(tree())}`);
    });
    await onExplorer({}, async ({ tree }) => {
      assert.ok(/(^|\s)outline-none(\s|$)/.test(classOf(tree())), 'a tree with rows marks a row, not its whole box');
    });
  });

  test('RM-11: while an inline name field has the keyboard, no row carries the focus mark; the field shows focus itself', async () => {
    await onExplorer({ creatingEntry: { parentPath: '/w', type: 'file' } }, async ({ p, ui, rows, tree }) => {
      const input = tree().querySelector('input');
      assert.ok(input, 'precondition: the New File field is open in the tree');
      // Its focus reaches the tree as a focusin, as a browser sends it.
      p.settled(() => dispatch(p.window, input, { type: 'focusin', relatedTarget: null }));
      assert.ok(!rows().some(focusMark), 'no row is marked: the arrow keys belong to the field');
      assert.ok(/(^|\s)ui-field(\s|$)/.test(classOf(input)), 'the field is a ui-field, which shows its own focus');
      // The field closed, the tree keeps the keyboard and marks its row again.
      p.settled(() => ui.useEditorStore.setState({ creatingEntry: null }));
      assert.deepEqual(rows().filter(focusMark).map(pathOf), ['/w/src'], 'the row the keys move from is marked again');
    });
  });
});
