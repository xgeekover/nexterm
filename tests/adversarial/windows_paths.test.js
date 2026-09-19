/**
 * The explorer has to work on Windows.
 *
 * The backend returns whatever the OS uses — `/Users/me/p/src` on unix,
 * `C:\Users\me\p\src` on Windows. The explorer used to re-derive the root's
 * children by testing `path.startsWith(root + '/')`, which on Windows compares
 * `C:\p\src` against `C:\p/` and is false for EVERY entry: the tree rendered
 * empty no matter what the backend sent, and fixing the tree itself could not
 * help. These cases pin the path handling that replaced it.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { cwdLabel } from '../../src/lib/statusInfo.js';
import {
  basename,
  depthOf,
  dirname,
  displayPath,
  extname,
  isDirectChild,
  isInside,
  join,
  relativeTo,
  reparent,
  samePath,
  sepOf,
  stripTrailingSep,
} from '../../src/lib/paths.js';

/** The same workspace, written the way each platform's backend reports it. */
const WORKSPACES = [
  {
    os: 'unix',
    root: '/Users/me/project',
    src: '/Users/me/project/src',
    deep: '/Users/me/project/src/components/App.jsx',
    pkg: '/Users/me/project/package.json',
  },
  {
    os: 'windows',
    root: 'C:\\Users\\me\\project',
    src: 'C:\\Users\\me\\project\\src',
    deep: 'C:\\Users\\me\\project\\src\\components\\App.jsx',
    pkg: 'C:\\Users\\me\\project\\package.json',
  },
];

describe('Windows paths: the explorer must not render empty', () => {
  for (const w of WORKSPACES) {
    test(`WP-01 [${w.os}]: the root's direct children are recognised as such`, () => {
      assert.equal(isDirectChild(w.root, w.src), true, 'src is a direct child of the root');
      assert.equal(isDirectChild(w.root, w.pkg), true, 'package.json is a direct child of the root');
      assert.equal(isDirectChild(w.root, w.deep), false, 'a grandchild is not a direct child');
      assert.equal(isInside(w.root, w.deep), true, 'but it is still inside the root');
    });

    test(`WP-02 [${w.os}]: names, parents and extensions come apart correctly`, () => {
      assert.equal(basename(w.deep), 'App.jsx');
      assert.equal(extname(w.deep), 'jsx');
      assert.equal(samePath(dirname(w.pkg), w.root), true, 'a root file’s parent is the root');
      assert.equal(basename(w.root), 'project', 'the sidebar header shows the folder name');
      // src / components / App.jsx
      assert.equal(depthOf(w.deep) - depthOf(w.root), 3, 'three levels below the root');
    });

    test(`WP-03 [${w.os}]: paths are rebuilt with the separator they came with`, () => {
      const sep = sepOf(w.root);
      assert.equal(join(w.root, 'notes.md'), `${w.root}${sep}notes.md`);
      assert.equal(join(w.src, 'index.js'), `${w.src}${sep}index.js`);
      // A trailing separator must not double up.
      assert.equal(join(`${w.root}${sep}`, 'a'), `${w.root}${sep}a`);
    });

    test(`WP-04 [${w.os}]: rename re-roots every descendant`, () => {
      const renamed = join(dirname(w.src), 'source');
      assert.equal(reparent(w.src, w.src, renamed), renamed, 'the folder itself moves');
      assert.equal(
        reparent(w.deep, w.src, renamed),
        w.deep.replace(w.src, renamed),
        'a file underneath follows it'
      );
      assert.equal(reparent(w.pkg, w.src, renamed), w.pkg, 'an unrelated sibling is untouched');
    });

    test(`WP-05 [${w.os}]: "copy relative path" is relative to the root`, () => {
      const sep = sepOf(w.root);
      assert.equal(relativeTo(w.root, w.deep), ['src', 'components', 'App.jsx'].join(sep));
      assert.equal(relativeTo(w.root, w.root), '.');
    });
  }

  test('WP-06: a sibling whose name merely starts the same is not inside', () => {
    assert.equal(isInside('/a/b', '/a/bc'), false);
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\bc'), false);
    assert.equal(isDirectChild('/a/b', '/a/bc'), false);
  });

  test('WP-07: trailing separators never change what a path means', () => {
    assert.equal(samePath('/a/b/', '/a/b'), true);
    assert.equal(samePath('C:\\a\\b\\', 'C:\\a\\b'), true);
    assert.equal(isDirectChild('/a/', '/a/b'), true);
    assert.equal(isDirectChild('C:\\a\\', 'C:\\a\\b'), true);
    assert.equal(stripTrailingSep('/'), '/', 'the posix root survives');
  });

  test('WP-08: the status bar shortens a path without mangling it', () => {
    assert.equal(displayPath('/Users/me/project', { home: '/Users/me' }), '~/project');
    assert.equal(displayPath('C:\\Users\\me\\project', { home: 'C:\\Users\\me' }), '~\\project');
    assert.equal(displayPath('/Users/me', { home: '/Users/me' }), '~');
    assert.equal(
      displayPath('/a/b/c/d/e/f', { keep: 3 }),
      '…/d/e/f',
      'a long path keeps its tail'
    );
    assert.equal(displayPath('/a/b', { keep: 3 }), '/a/b', 'a short one is left alone');
  });

  test('WP-09: a terminal\'s directory is shortened from the FRONT, never the back', () => {
    // The TERMINALS panel used to run its own `basename`, splitting on '/'
    // alone. A Windows cwd has none, so `.pop()` handed back the WHOLE path
    // and CSS cut the end off it — the panel showed `C:\Users\geekover\w…`
    // and never the folder the terminal was actually in. Both the status bar
    // and the panel go through `cwdLabel` now.
    const deep = 'C:\\Users\\geekover\\workspace\\ai\\projects\\nexterm\\src-tauri\\src';
    const label = cwdLabel(deep, { platform: 'windows', homeDir: 'C:\\Users\\geekover' });

    assert.equal(label, '…\\src-tauri\\src');
    assert.equal(label.endsWith('src-tauri\\src'), true, 'the tail is what identifies it');
    assert.equal(label.includes('Users'), false, 'the shared front is what gets dropped');
    assert.equal(label.length < deep.length, true);

    // Off Windows the home directory folds to `~`; on Windows it does not,
    // because `~\project` is not how a Windows path is read.
    assert.equal(
      cwdLabel('/Users/me/work/nexterm/src', { platform: 'macos', homeDir: '/Users/me' }),
      '~/…/nexterm/src'
    );
    assert.equal(
      cwdLabel('C:\\Users\\me\\project', { platform: 'windows', homeDir: 'C:\\Users\\me' }).startsWith('~'),
      false
    );

    // A path that already fits is left exactly as the backend reported it.
    assert.equal(cwdLabel('C:\\proj', { platform: 'windows' }), 'C:\\proj');
  });
});
