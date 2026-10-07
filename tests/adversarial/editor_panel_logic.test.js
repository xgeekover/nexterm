/**
 * What EditorPanel.jsx decides without drawing anything.
 *
 * The panel itself cannot be mounted here: it is Monaco's, and Monaco does
 * not load outside a browser. What it decides is in small exported functions,
 * and those are run here against stand-ins given by hand — a Monaco editor is
 * an object that can be disposed and says so.
 *
 * Node cannot import a .jsx file, so EditorPanel.jsx is bundled with esbuild
 * and imported from a data: URL, as editor_tab_reorder_ui.test.js does: React
 * kept real and every other import replaced by an empty stand-in that nothing
 * these cases reach ever calls. Nothing is registered process-wide.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';

const EDITOR_DIR = fileURLToPath(new URL('../../src/components/editor/', import.meta.url));
/** Kept real: the React the module was written against. */
const REAL = new Set(['react', 'react/jsx-runtime']);

let loading = null;
function loadEditorPanel() {
  loading ??= build({
    stdin: {
      contents: "export * from './EditorPanel.jsx';",
      resolveDir: EDITOR_DIR,
      sourcefile: 'editor-panel-under-test.js',
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
        name: 'editor-panel-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (/^\.\/EditorPanel\.jsx$/.test(args.path)) return undefined;
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            return { path: args.path, namespace: 'stand-in' };
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

let ui = null;
const loadUi = async () => {
  ui = await loadEditorPanel();
};

/** An export of EditorPanel.jsx, failing by name when it is not there. */
function exported(name) {
  const value = ui[name];
  assert.ok(value !== undefined, `EditorPanel.jsx does not export ${name}, so none of this is under test`);
  return value;
}

// ---- The editor a group holds ------------------------------------------------

/** A Monaco editor as far as the panel uses it: disposed, it says so. */
function fakeEditor(name) {
  const listeners = [];
  return {
    name,
    onDidDispose(listener) {
      listeners.push(listener);
      return { dispose() {} };
    },
    dispose() {
      for (const listener of listeners) listener();
    },
  };
}

/** Which editor `ref` holds, by name — never the object in an assertion. */
const held = (ref) => ref.current?.name ?? null;

/**
 * Each tab a group shows gets an editor of its own, and the one before is
 * disposed as the new one mounts — asynchronously, Monaco loading first. The
 * group kept the disposed one, and handed it what was meant for the new one:
 * Go to File asking for the keyboard, a terminal link's line. A disposed
 * editor moves nothing and focuses nothing, and the request was spent on it,
 * so a file picked into a group already showing another opened without the
 * keyboard, and a link into it opened at the top.
 */
describe('EditorPanel: the editor a group holds', () => {
  beforeEach(loadUi);

  test('EP-01: an editor is held until it is disposed, and not after — what is asked of the group waits for the next one', () => {
    const holdEditor = exported('holdEditor');
    const ref = { current: null };
    const first = fakeEditor('a.js');
    holdEditor(ref, first);
    assert.equal(held(ref), 'a.js');

    // b.js picked in Go to File: a.js's editor goes first...
    first.dispose();
    assert.equal(held(ref), null, 'a disposed editor held: the request for the keyboard was spent on it');
    // ...and b.js's arrives once Monaco has made it.
    const second = fakeEditor('b.js');
    holdEditor(ref, second);
    assert.equal(held(ref), 'b.js');
  });

  test('EP-02: an editor disposed after the next one is held leaves the next one held', () => {
    const holdEditor = exported('holdEditor');
    const ref = { current: null };
    const first = fakeEditor('a.js');
    const second = fakeEditor('b.js');
    holdEditor(ref, first);
    holdEditor(ref, second);
    first.dispose();
    assert.equal(held(ref), 'b.js');
    second.dispose();
    assert.equal(held(ref), null);
  });
});
