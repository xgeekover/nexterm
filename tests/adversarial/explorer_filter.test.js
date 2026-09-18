/**
 * Narrowing the explorer.
 *
 * ⌘P already finds a file anywhere in the workspace; this answers a different
 * question — "what is in here that looks like X, and where does it sit" — so
 * the thing that matters is that the ANSWER IS STILL A TREE. A filter that
 * flattened its hits, or that hid a match inside a folder whose own name did
 * not match, would just be a worse quick open.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { filterTree } from '../../src/components/explorer/treeRows.js';

/** A small project: src/{App.jsx,lib/{paths.js,paths.test.js}}, tests/, README.md */
const tree = () => [
  {
    name: 'src',
    path: '/w/src',
    is_dir: true,
    children: [
      { name: 'App.jsx', path: '/w/src/App.jsx', is_dir: false },
      {
        name: 'lib',
        path: '/w/src/lib',
        is_dir: true,
        children: [
          { name: 'paths.js', path: '/w/src/lib/paths.js', is_dir: false },
          { name: 'paths.test.js', path: '/w/src/lib/paths.test.js', is_dir: false },
        ],
      },
    ],
  },
  { name: 'tests', path: '/w/tests', is_dir: true, children: [] },
  { name: 'README.md', path: '/w/README.md', is_dir: false },
];

const names = (nodes) => nodes.map((n) => n.name);

describe('Explorer filter', () => {
  test('EF-01: an empty query is not a filter', () => {
    const before = tree();
    const out = filterTree(before, '');
    assert.equal(out.nodes, before, 'the untouched tree must come back as the same object');
    assert.equal(out.matches, 0);

    assert.equal(filterTree(before, '   ').nodes, before);
    assert.equal(filterTree(before, null).nodes, before);
  });

  test('EF-02: a match keeps the folders that lead to it', () => {
    // The failure this prevents: `paths.js` matches, `src` and `lib` do not,
    // so a naive filter drops both and the match has nowhere to live.
    const out = filterTree(tree(), 'paths');
    assert.deepEqual(names(out.nodes), ['src']);
    assert.deepEqual(names(out.nodes[0].children), ['lib']);
    assert.deepEqual(names(out.nodes[0].children[0].children), ['paths.js', 'paths.test.js']);
    assert.equal(out.matches, 2);
  });

  test('EF-03: what does not lead anywhere is gone', () => {
    const out = filterTree(tree(), 'paths');
    assert.equal(names(out.nodes).includes('README.md'), false);
    assert.equal(names(out.nodes).includes('tests'), false);
  });

  test('EF-04: every folder on the way is opened', () => {
    // A result hidden behind a closed twisty has not narrowed anything.
    const out = filterTree(tree(), 'paths');
    assert.deepEqual(out.expand.sort(), ['/w/src', '/w/src/lib']);
  });

  test('EF-05: a folder may match on its own name, and keeps its contents', () => {
    const out = filterTree(tree(), 'lib');
    assert.deepEqual(names(out.nodes), ['src']);
    const lib = out.nodes[0].children[0];
    assert.equal(lib.name, 'lib');
    // Matched as a folder, so it is kept whole rather than emptied.
    assert.deepEqual(names(lib.children), ['paths.js', 'paths.test.js']);
  });

  test('EF-06: case does not matter, and neither does where the match sits', () => {
    assert.deepEqual(names(filterTree(tree(), 'README').nodes), ['README.md']);
    assert.deepEqual(names(filterTree(tree(), 'readme').nodes), ['README.md']);
    assert.deepEqual(names(filterTree(tree(), 'ADME').nodes), ['README.md']);
  });

  test('EF-07: names are matched, not paths', () => {
    // Everything here lives under `/w`. If paths were matched, filtering for
    // `w` would match every single entry and narrow nothing — and a project
    // checked out under ~/tests/ would do that for `test`.
    assert.deepEqual(filterTree(tree(), '/w').nodes, []);
    const out = filterTree(tree(), 'test');
    assert.deepEqual(names(out.nodes), ['src', 'tests']);
  });

  test('EF-08: nothing matching is an empty tree, not the whole one', () => {
    const out = filterTree(tree(), 'zzzz');
    assert.deepEqual(out.nodes, []);
    assert.equal(out.matches, 0);
    assert.deepEqual(out.expand, []);
  });

  test('EF-09: an unread folder is judged on its own name alone', () => {
    // `children: undefined` means "not fetched yet". Reading the disk to
    // answer a keystroke is not this function's job, so it can only look at
    // the name — and must not crash on the missing array.
    const lazy = [{ name: 'vendor', path: '/w/vendor', is_dir: true }];
    assert.deepEqual(names(filterTree(lazy, 'vend').nodes), ['vendor']);
    assert.deepEqual(filterTree(lazy, 'paths').nodes, []);
  });

  test('EF-10: the input tree is never modified', () => {
    const before = tree();
    const snapshot = JSON.stringify(before);
    filterTree(before, 'paths');
    assert.equal(JSON.stringify(before), snapshot, 'filtering must not mutate the store’s tree');
  });
});
