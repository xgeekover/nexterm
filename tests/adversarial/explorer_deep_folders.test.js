/**
 * Folders below the depth the Explorer reads its tree to.
 *
 * `refreshExplorer` reads the open folder five levels deep, and a folder on
 * that fifth level comes back with `children: []` whether or not it has
 * anything in it. Opening one reads it into the tree (toggleFolder →
 * ensureChildrenLoaded). But every refresh — 300 ms after any change on disk:
 * the file being edited saved, an agent writing, a build, a checkout —
 * replaced the whole tree with a new five-level read. A folder the user had
 * opened down there stayed open and showed nothing, and a file just created in
 * it did not appear, until the folder was closed and opened again. That is
 * `src/main/java/com/acme` in any Java project.
 *
 * A folder reached through a link has the same tree under two names, and the
 * backend reads it under the one it resolves to — the link's target — so what
 * was read in landed in the tree under paths the tree had never shown.
 *
 * The real store against the browser mock, which reads to the same depth and
 * hands the last level back empty, as the backend does.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore as S } from '../../src/stores/editorStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import { findNode, flattenVisible, frontierOf, placeUnder } from '../../src/components/explorer/treeRows.js';

let counter = 0;

/**
 * `<scratch>/main/java/com/acme/App.java`, with the scratch folder directly
 * in /workspace: `acme` is on the fifth level, the last one a refresh reads.
 */
async function javaTree(extra = []) {
  counter += 1;
  const base = `/workspace/_deep_folders_${Date.now()}_${counter}`;
  const acme = `${base}/main/java/com/acme`;
  for (const dir of [base, `${base}/main`, `${base}/main/java`, `${base}/main/java/com`, acme, ...extra.map((d) => `${acme}/${d}`)]) {
    await invoke('fs_create_dir', { path: dir });
  }
  await invoke('fs_write_file', { path: `${acme}/App.java`, content: 'class App {}' });
  return { base, acme, com: `${base}/main/java/com` };
}

const childNames = (path) => (findNode(S.getState().fileTree, path)?.children || []).map((n) => n.name);
const isOpen = (path) => S.getState().expandedFolders.has(path);

/** Resolves once `check` holds, failing after a second. */
async function until(check, what) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Open `path` in the tree, as a click on its row does, and wait for it to be read. */
async function open(path, firstChild) {
  if (!isOpen(path)) S.getState().toggleFolder(path);
  await until(() => childNames(path).includes(firstChild), `${path} to show ${firstChild}`);
}

/** Every `fs_read_dir` path sent while `fn` runs, answered as usual unless `answer` says otherwise. */
async function readsDuring(fn, answer = null) {
  const real = Object.getPrototypeOf(mockBridge).invoke;
  const paths = [];
  mockBridge.invoke = function (command, args) {
    if (command === 'fs_read_dir') paths.push(args.path);
    const custom = command === 'fs_read_dir' && answer ? answer(args) : undefined;
    return custom !== undefined ? custom : real.call(mockBridge, command, args);
  };
  try {
    await fn();
  } finally {
    delete mockBridge.invoke;
  }
  return paths;
}

describe('Explorer: folders below the depth of a refresh', () => {
  beforeEach(async () => {
    // The fs-change listener refreshes the tree by itself 300 ms after any
    // change, at times no case chooses. Off for these cases, and whatever it
    // had queued is let run first.
    S.getState().dispose();
    await new Promise((r) => setTimeout(r, 350));
    S.setState({ rootPath: '/workspace', rootResolved: true, expandedFolders: new Set(['/workspace']), tabs: [], activeTabId: null });
    await S.getState().refreshExplorer();
  });

  test('ED-01: a folder opened on the last level read keeps its files through a refresh — a file just created in it too', async () => {
    const { acme, base } = await javaTree();
    await S.getState().refreshExplorer();
    assert.deepEqual(childNames(acme), [], 'precondition: the refresh read stops at acme');

    await open(acme, 'App.java');
    await invoke('fs_write_file', { path: `${acme}/Util.java`, content: 'class Util {}' });
    await S.getState().refreshExplorer();

    assert.ok(isOpen(acme), 'still open');
    assert.deepEqual(childNames(acme), ['App.java', 'Util.java'], 'the open folder came back empty');
    // With the folders above it open as well, the new file is a row on screen.
    const above = [base, `${base}/main`, `${base}/main/java`, `${base}/main/java/com`];
    const rows = flattenVisible(S.getState().fileTree, new Set([...S.getState().expandedFolders, ...above]));
    assert.ok(rows.some((r) => r.node.path === `${acme}/Util.java`), 'and the new file is a row on screen');
  });

  test('ED-02: open folders further down are all read in, and the tree is replaced once — never with an open folder empty', async () => {
    const { acme } = await javaTree(['app', 'app/util', 'app/util/deep']);
    await invoke('fs_write_file', { path: `${acme}/app/A.java`, content: '' });
    await invoke('fs_write_file', { path: `${acme}/app/util/U.java`, content: '' });
    await invoke('fs_write_file', { path: `${acme}/app/util/deep/D.java`, content: '' });
    await S.getState().refreshExplorer();
    await open(acme, 'App.java');
    await open(`${acme}/app`, 'A.java');
    await open(`${acme}/app/util`, 'U.java');
    await open(`${acme}/app/util/deep`, 'D.java');

    const published = [];
    const unsubscribe = S.subscribe((state, previous) => {
      if (state.fileTree !== previous.fileTree) published.push(state.fileTree);
    });
    try {
      await S.getState().refreshExplorer();
    } finally {
      unsubscribe();
    }

    assert.equal(published.length, 1, `the tree was replaced ${published.length} times by one refresh`);
    for (const [path, file] of [[acme, 'App.java'], [`${acme}/app`, 'A.java'], [`${acme}/app/util`, 'U.java'], [`${acme}/app/util/deep`, 'D.java']]) {
      assert.ok(childNames(path).includes(file), `${path} came back without ${file}`);
    }
  });

  test('ED-03: an open folder inside a closed one is read in too, so opening the parent shows it full', async () => {
    const { acme, com } = await javaTree();
    await S.getState().refreshExplorer();
    await open(acme, 'App.java');
    S.getState().toggleFolder(com); // closed; acme stays open inside it
    await invoke('fs_write_file', { path: `${acme}/Util.java`, content: '' });
    await S.getState().refreshExplorer();

    const reads = await readsDuring(async () => {
      S.getState().toggleFolder(com);
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.deepEqual(childNames(acme), ['App.java', 'Util.java'], 'acme showed empty once com was opened again');
    assert.deepEqual(reads, [], 'and nothing had to be read to show it');
  });

  test('ED-04: opening a folder on the last level also reads in what was left open below it', async () => {
    const { acme } = await javaTree(['app', 'app/util']);
    await invoke('fs_write_file', { path: `${acme}/app/util/U.java`, content: '' });
    await S.getState().refreshExplorer();
    await open(acme, 'app');
    await open(`${acme}/app`, 'util');
    await open(`${acme}/app/util`, 'U.java');

    // acme closed: the next refresh does not read it, and util stays open.
    S.getState().toggleFolder(acme);
    await S.getState().refreshExplorer();
    assert.deepEqual(childNames(acme), [], 'precondition: a closed folder on the last level is not read');

    await open(acme, 'app');
    await until(() => childNames(`${acme}/app/util`).includes('U.java'), 'util, still open, to be read in with acme');
  });

  test('ED-05: with nothing open below the depth read, a refresh reads the root and nothing else', async () => {
    await javaTree();
    const reads = await readsDuring(() => S.getState().refreshExplorer());
    assert.deepEqual(reads, ['/workspace']);
  });

  test('ED-06: a refresh that finishes after a newer one leaves the newer tree alone', async () => {
    // Two refreshes overlap: the one 300 ms after a change and the one a
    // create runs itself. Each reads more than once now, which widens the
    // window. The new file is where only the root's read sees it, so the
    // older refresh, which read the root before it existed, cannot know it.
    const { acme, base } = await javaTree();
    await S.getState().refreshExplorer();
    await open(acme, 'App.java');

    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const real = Object.getPrototypeOf(mockBridge).invoke;
    let first = true;
    mockBridge.invoke = function (command, args) {
      if (command === 'fs_read_dir' && args.path === '/workspace' && first) {
        first = false;
        // The first refresh reads the disk as it is now, and answers late.
        const answer = real.call(mockBridge, command, args);
        return gate.then(() => answer);
      }
      return real.call(mockBridge, command, args);
    };
    try {
      const older = S.getState().refreshExplorer();
      await invoke('fs_write_file', { path: `${base}/Later.java`, content: '' });
      await S.getState().refreshExplorer();
      assert.ok(childNames(base).includes('Later.java'), 'precondition: the newer refresh saw the new file');
      release();
      await older;
    } finally {
      delete mockBridge.invoke;
    }
    assert.ok(childNames(base).includes('Later.java'), 'the late, older read put back a tree without the new file');
    assert.deepEqual(childNames(acme), ['App.java'], 'and the open folder is still full');
    assert.equal(S.getState().isLoadingTree, false);
  });

  test('ED-07: a folder opened while a refresh is reading keeps what was read for it', async () => {
    const { acme, base } = await javaTree();
    const other = `${base}/main/java/com/other`;
    await invoke('fs_create_dir', { path: other });
    await invoke('fs_write_file', { path: `${other}/O.java`, content: '' });
    await S.getState().refreshExplorer();
    await open(acme, 'App.java');

    // The refresh reads the root, then acme (open) — and acme's read is held
    // while `other` is opened and read in.
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const real = Object.getPrototypeOf(mockBridge).invoke;
    mockBridge.invoke = function (command, args) {
      const answer = real.call(mockBridge, command, args);
      return command === 'fs_read_dir' && args.path === acme ? gate.then(() => answer) : answer;
    };
    try {
      const refreshing = S.getState().refreshExplorer();
      await new Promise((r) => setTimeout(r, 20));
      await open(other, 'O.java');
      release();
      await refreshing;
    } finally {
      delete mockBridge.invoke;
    }
    assert.deepEqual(childNames(other), ['O.java'], 'the refresh dropped what was read for a folder opened meanwhile');
    assert.deepEqual(childNames(acme), ['App.java']);
  });
});

describe('Explorer: a folder reached through a link', () => {
  beforeEach(async () => {
    S.getState().dispose();
    S.setState({ rootPath: '/workspace', rootResolved: true, expandedFolders: new Set(['/workspace']), tabs: [], activeTabId: null });
  });

  test('ED-08: what is read in under a link is named under the link, as the tree reached it — and can be opened in turn', async () => {
    counter += 1;
    const base = `/workspace/_linked_${Date.now()}_${counter}`;
    const link = `${base}/packages/shared`;
    const target = `${base}/libs/shared`;
    // The tree as the backend reads it: `shared` a link to a folder, on the
    // last level, so read with no children.
    S.setState({
      fileTree: [
        {
          name: base.split('/').pop(), path: base, is_dir: true, children: [
            { name: 'packages', path: `${base}/packages`, is_dir: true, children: [
              { name: 'shared', path: link, is_dir: true, is_symlink: true, children: [] },
            ] },
          ],
        },
      ],
      expandedFolders: new Set(['/workspace', base, `${base}/packages`]),
    });
    // The backend resolves the folder it reads, so it names what is in a
    // linked folder by the link's target.
    const listing = {
      [link]: [
        { name: 'src', path: `${target}/src`, is_dir: true, children: [
          { name: 'deep', path: `${target}/src/deep`, is_dir: true, children: [] },
          { name: 'index.js', path: `${target}/src/index.js`, is_dir: false },
        ] },
        { name: 'package.json', path: `${target}/package.json`, is_dir: false },
      ],
      [`${link}/src/deep`]: [{ name: 'x.js', path: `${target}/src/deep/x.js`, is_dir: false }],
    };
    await readsDuring(async () => {
      await open(link, 'src');
      await open(`${link}/src/deep`, 'x.js');
    }, (args) => (listing[args.path] ? Promise.resolve(listing[args.path]) : undefined));

    const paths = flattenVisible(S.getState().fileTree, new Set([...S.getState().expandedFolders, `${link}/src`]))
      .map((r) => r.node.path)
      .filter((p) => p.startsWith(`${base}/packages/`) || p.startsWith(`${base}/libs/`));
    assert.deepEqual(paths, [
      link,
      `${link}/src`,
      `${link}/src/deep`,
      `${link}/src/deep/x.js`,
      `${link}/src/index.js`,
      `${link}/package.json`,
    ]);
  });
});

describe('Explorer tree helpers (pure)', () => {
  const tree = [
    { name: 'a', path: '/r/a', is_dir: true, children: [
      { name: 'b', path: '/r/a/b', is_dir: true, children: [] },
      { name: 'f', path: '/r/a/f', is_dir: false },
    ] },
    { name: 'c', path: '/r/c', is_dir: true, children: [] },
    { name: 'g', path: '/r/g', is_dir: false },
  ];

  test('ED-09: the folders a read left unread are the ones on its last level — files and shallower folders are not', () => {
    assert.deepEqual(frontierOf(tree, 2), ['/r/a/b']);
    assert.deepEqual(frontierOf(tree, 1), ['/r/a', '/r/c']);
    assert.deepEqual(frontierOf(tree, 3), [], 'nothing reaches a third level');
    assert.deepEqual(frontierOf([], 5), []);
    assert.deepEqual(frontierOf(undefined, 5), []);
  });

  test('ED-10: placing a listing under the folder it was read from — renamed where it was read by another name, kept as it is otherwise', () => {
    assert.equal(placeUnder(tree, '/r'), tree, 'a listing already under its folder is handed back as it is');
    const moved = placeUnder(
      [{ id: '/t/x', name: 'x', path: '/t/x', is_dir: true, children: [{ id: '/t/x/y.js', name: 'y.js', path: '/t/x/y.js', is_dir: false, children: null }] }],
      '/r/link'
    );
    assert.deepEqual(moved, [
      { id: '/r/link/x', name: 'x', path: '/r/link/x', is_dir: true, children: [{ id: '/r/link/x/y.js', name: 'y.js', path: '/r/link/x/y.js', is_dir: false, children: null }] },
    ]);
    // Windows: the folder's own separator.
    assert.deepEqual(
      placeUnder([{ name: 'App.jsx', path: 'C:\\real\\App.jsx', is_dir: false }], 'C:\\proj\\link').map((n) => n.path),
      ['C:\\proj\\link\\App.jsx']
    );
  });

  test('ED-11: a name is kept as the backend spelled it — a leading backslash is part of the name off Windows', () => {
    // Found in review: the path was rebuilt from the name with `join`, which
    // drops a leading separator. A folder named `\..` under `acme` became
    // `acme/..` — opening it showed `com`, and deleting it removed `com`.
    const listing = [
      { id: '/r/com/acme/\\..', name: '\\..', path: '/r/com/acme/\\..', is_dir: true, children: [] },
      { id: '/r/com/acme/\\notes.txt', name: '\\notes.txt', path: '/r/com/acme/\\notes.txt', is_dir: false },
      { id: '/r/com/acme/notes.txt', name: 'notes.txt', path: '/r/com/acme/notes.txt', is_dir: false },
    ];
    assert.equal(placeUnder(listing, '/r/com/acme'), listing, 'read where it is shown: untouched');
    assert.deepEqual(
      placeUnder(listing, '/r/link').map((n) => n.path),
      ['/r/link/\\..', '/r/link/\\notes.txt', '/r/link/notes.txt'],
      'read through a link: only the folder part changes'
    );
    // The root itself, with its separator kept.
    assert.deepEqual(placeUnder([{ name: 'etc', path: '/etc', is_dir: true }], '/').map((n) => n.path), ['/etc']);
  });
});
