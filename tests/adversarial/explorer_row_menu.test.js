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
