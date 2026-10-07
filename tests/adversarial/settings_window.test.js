/**
 * The Settings window (src/components/common/SettingsWindow.jsx) and its
 * Keyboard Shortcuts section (KeybindingSettings.jsx): what a field commits,
 * what a key does to the window, and where focus goes when it closes.
 *
 * Each of those is decided by a small exported function, and these cases call
 * it. Where the window puts it to work — a listener on the document, an
 * effect — needs a browser, which is what driving the app is for (see
 * TEST_INFRA.md).
 *
 * Node cannot import a .jsx file, so the two are bundled with esbuild (already
 * present — the render suite transforms JSX with it) and imported from a
 * data: URL, as in confirm_dialog.test.js: nothing is registered
 * process-wide. Only the .jsx files are bundled. Every other import is left to
 * Node as the real module, so the stores the window reads are the ones these
 * cases see.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test, assert } from '../e2e/harness/testFramework.js';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

let loading = null;
function loadSettingsUi() {
  loading ??= build({
    stdin: {
      contents: [
        "export * from './components/common/SettingsWindow.jsx';",
        "export * from './components/common/KeybindingSettings.jsx';",
      ].join('\n'),
      resolveDir: SRC_DIR,
      sourcefile: 'settings-ui-under-test.js',
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
        name: 'real-modules',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path.endsWith('.jsx')) return undefined;
            if (args.path.startsWith('.')) {
              return { path: pathToFileURL(path.resolve(args.resolveDir, args.path)).href, external: true };
            }
            return { path: import.meta.resolve(args.path), external: true };
          });
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

/** An export of the two files, failing by name when it is not there. */
async function exported(name) {
  const ui = await loadSettingsUi();
  assert.ok(ui[name] !== undefined, `the Settings window does not export ${name}, so none of this is under test`);
  return ui[name];
}

const SCROLLBACK = { min: 100, max: 100000 };
const NOTIFY_AFTER = { min: 0, max: 600 };

describe('Settings: a number field commits only a number that was typed', () => {
  test('SW-01: a field left blank puts the saved value back', async () => {
    // Select the scrollback, delete it to type another, click elsewhere: the
    // blur commits. Number('') is 0, which was clamped to the minimum and
    // saved — every open terminal then kept only its last 100 lines.
    const numberToCommit = await exported('numberToCommit');
    assert.equal(numberToCommit('', SCROLLBACK, 5000), 5000);
    assert.equal(numberToCommit('', { min: 8, max: 32 }, 12), 12, 'a font size is not set to 8');
    assert.equal(numberToCommit('', { min: 1, max: 8 }, 2), 2, 'a tab size is not set to 1');
    assert.equal(numberToCommit('', NOTIFY_AFTER, 10), 10, 'notifications are not turned off');
  });

  test('SW-02: spaces, or text that is not a number, put the saved value back too', async () => {
    const numberToCommit = await exported('numberToCommit');
    for (const text of ['   ', '\t', 'abc', '1e', '--5', 'NaN', 'Infinity', null, undefined]) {
      assert.equal(numberToCommit(text, SCROLLBACK, 5000), 5000, `${JSON.stringify(text)} is not a number anyone typed`);
    }
  });

  test('SW-03: a number that was typed is committed, held to the field\'s range', async () => {
    const numberToCommit = await exported('numberToCommit');
    assert.equal(numberToCommit('2500', SCROLLBACK, 5000), 2500);
    assert.equal(numberToCommit(' 2500 ', SCROLLBACK, 5000), 2500);
    assert.equal(numberToCommit('50', SCROLLBACK, 5000), 100, 'below the range: its minimum');
    assert.equal(numberToCommit('250000', SCROLLBACK, 5000), 100000, 'above it: its maximum');
    assert.equal(numberToCommit('1.5', { min: 1, max: 2 }, 1.2), 1.5, 'line height takes a fraction');
  });

  test('SW-04: a typed 0 is a number, and where 0 is allowed it is committed', async () => {
    // "0 turns it off" is what Notify After says — typing it must work.
    const numberToCommit = await exported('numberToCommit');
    assert.equal(numberToCommit('0', NOTIFY_AFTER, 10), 0);
    assert.equal(numberToCommit('0', SCROLLBACK, 5000), 100, 'and where it is not, the minimum, as for any number too small');
  });
});
