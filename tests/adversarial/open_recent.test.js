/**
 * Open Recent.
 *
 * The app opens with no folder, and the only way back to one was the native
 * dialog — on Windows that means clicking through a tree to a path you have
 * typed a hundred times in the terminal below.
 *
 * The case that matters is the one VS Code gets right and a naive list gets
 * wrong: a folder in the list may have been moved, renamed or deleted since,
 * and a row that fails every time it is clicked is worse than no row.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { buildPaletteGroups } from '../../src/lib/paletteItems.js';

const { useEditorStore: E } = await import('../../src/stores/editorStore.js');

const recents = () => E.getState().recentRoots;

describe('Open Recent', () => {
  beforeEach(() => {
    E.setState({ recentRoots: [] });
  });

  test('OR-01: newest first', () => {
    E.getState().rememberRoot('/a');
    E.getState().rememberRoot('/b');
    assert.deepEqual(recents(), ['/b', '/a']);
  });

  test('OR-02: opening one again moves it rather than repeating it', () => {
    E.getState().rememberRoot('/a');
    E.getState().rememberRoot('/b');
    E.getState().rememberRoot('/a');
    assert.deepEqual(recents(), ['/a', '/b']);
  });

  test('OR-03: the list is capped', () => {
    for (let i = 0; i < 40; i += 1) E.getState().rememberRoot(`/p/${i}`);
    assert.equal(recents().length <= 12, true, `unbounded at ${recents().length}`);
    assert.equal(recents()[0], '/p/39', 'and the newest survives');
  });

  test('OR-04: nothing is remembered that is not a path', () => {
    E.getState().rememberRoot('');
    E.getState().rememberRoot(null);
    E.getState().rememberRoot(undefined);
    assert.deepEqual(recents(), []);
  });

  test('OR-05: a folder that will not open comes out of the list', async () => {
    // The whole point. The backend refuses a folder that has moved, and a row
    // that fails every time it is clicked is worse than no row at all.
    E.getState().rememberRoot('/gone/for/good');
    assert.deepEqual(recents(), ['/gone/for/good']);
    const opened = await E.getState().openRoot('/gone/for/good');
    assert.equal(opened, null, 'it must not report success');
    assert.deepEqual(recents(), [], 'and it must not stay in the list');
  });

  test('OR-06: opening one that works keeps it, at the front', async () => {
    E.getState().rememberRoot('/somewhere/else');
    const opened = await E.getState().openRoot('/workspace');
    assert.equal(opened, '/workspace');
    assert.equal(recents()[0], '/workspace');
  });

  test('OR-07: forgetting one leaves the rest', () => {
    E.getState().rememberRoot('/a');
    E.getState().rememberRoot('/b');
    E.getState().forgetRoot('/a');
    assert.deepEqual(recents(), ['/b']);
    E.getState().forgetRoot('/nothing-like-this');
    assert.deepEqual(recents(), ['/b'], 'an unknown path changes nothing');
  });

  test('OR-08: the palette lists them as their own mode', () => {
    const groups = buildPaletteGroups({ mode: 'recent', recentRoots: ['/w/alpha', '/w/beta'] });
    assert.deepEqual(groups.map((g) => g.label), ['recent folders']);
    const rows = groups[0].items;
    assert.deepEqual(rows.map((r) => r.title), ['alpha', 'beta']);
    assert.equal(rows[0].subtitle, '/w/alpha', 'the full path is what tells two "src" apart');
    assert.equal(rows[0].type, 'recent');
  });

  test('OR-09: typing narrows them, and nothing matching is no group', () => {
    const of = (query) =>
      buildPaletteGroups({ mode: 'recent', query, recentRoots: ['/w/alpha', '/w/beta'] })
        .flatMap((g) => g.items)
        .map((r) => r.title);
    assert.deepEqual(of('alph'), ['alpha']);
    assert.deepEqual(of('/w/'), ['alpha', 'beta'], 'the path is matched too');
    assert.deepEqual(of('zzz'), []);
  });

  test('OR-10: the other palette modes never show folders', () => {
    const all = buildPaletteGroups({ mode: 'all', recentRoots: ['/w/alpha'] });
    assert.equal(all.some((g) => g.label === 'recent folders'), false);
  });

  test('OR-11: teardown', () => {
    E.setState({ recentRoots: [] });
    assert.deepEqual(recents(), []);
  });
});
