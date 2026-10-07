/**
 * What the command palette lists (src/lib/paletteItems.js), as plain data.
 *
 * Go to File drew every file that matched, with no limit — an empty query
 * matches all of them — so a folder with a `vendor/` or a `.venv` put ten
 * thousand rows on screen and rebuilt them on every key. It matched against
 * the whole path, the open folder's own location included, so almost any
 * query matched almost every file, and what came first was whatever came
 * first in the tree. And it listed only the Explorer's tree, which stops five
 * levels down: nothing in `src/main/java/com/acme` was ever offered.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { buildPaletteGroups, canHaveFocusBack, focusAfterPalette, paletteCommands, FILE_RESULT_LIMIT } from '../../src/lib/paletteItems.js';
import { DEFAULT_RESOLVED, shortcutLabel } from '../../src/lib/keybindings.js';
import { mockBridge } from '../../src/lib/ipc.js';

describe('Command palette: what a row advertises', () => {
  test('PR-01: "Save All Files" shows no shortcut — Ctrl/Cmd+S saves one tab, not all of them', () => {
    const saveAll = paletteCommands(DEFAULT_RESOLVED).find((c) => c.command === 'save_all');
    assert.ok(saveAll, 'the palette offers Save All');
    const save = shortcutLabel('save', DEFAULT_RESOLVED, { isMac: false });
    assert.ok(save, 'precondition: Save has a chord');
    assert.ok(!saveAll.hint, `Save All advertises "${saveAll.hint}", the chord that saves only the active tab`);
  });
});

const ROOT = '/Users/me/proj';
const filesGroup = (groups) => groups.find((g) => g.label === 'files') ?? { items: [] };
const titles = (group) => group.items.map((i) => i.title);

/** `n` files, `src/gen/file-00000.js` … in path order. */
const generated = (n, root = ROOT) =>
  Array.from({ length: n }, (_, i) => `${root}/src/gen/file-${String(i).padStart(5, '0')}.js`);

/** Files as the Explorer's tree holds them — the one source the palette had. */
const asTree = (paths) => paths.map((path) => ({ name: path.split(/[\\/]/).pop(), path, is_dir: false }));

describe('Command palette: Go to File', () => {
  test('PR-02: an empty query lists at most a screenful of files, and says how many more there are', () => {
    const files = generated(5000);
    const group = filesGroup(buildPaletteGroups({ fileTree: asTree(files), rootPath: ROOT, mode: 'files' }));
    assert.equal(FILE_RESULT_LIMIT, 200);
    assert.equal(group.items.length, FILE_RESULT_LIMIT, `${group.items.length} rows for an empty query`);
    assert.equal(group.more, 5000 - FILE_RESULT_LIMIT, 'how many matched and are not shown');
    assert.deepEqual(group.items.slice(0, 2).map((i) => i.path), files.slice(0, 2), 'in the order they came');

    const few = filesGroup(buildPaletteGroups({ fileTree: asTree(files.slice(0, 3)), rootPath: ROOT, mode: 'files' }));
    assert.equal(few.items.length, 3);
    assert.equal(few.more, 0, 'nothing left out');
  });

  test('PR-03: the file named like the query comes first, ahead of hundreds whose paths merely contain its letters', () => {
    // 300 paths whose folders spell a-p-p, listed before the one file
    // actually named App: only a name match beats the order they came in.
    const noise = Array.from({ length: 300 }, (_, i) => `${ROOT}/a/p/p/note-${i}.txt`);
    const files = [...noise, `${ROOT}/lib/alpha-pipe.js`, `${ROOT}/src/happy.js`, `${ROOT}/src/App.jsx`];
    const group = filesGroup(buildPaletteGroups({ fileTree: asTree(files), rootPath: ROOT, query: 'app', mode: 'files' }));
    assert.deepEqual(titles(group).slice(0, 3), ['App.jsx', 'happy.js', 'alpha-pipe.js'],
      'name starting with it, then containing it, then its letters in order in the name');
    assert.equal(group.items.length, FILE_RESULT_LIMIT, 'still capped');
    assert.equal(group.more, files.length - FILE_RESULT_LIMIT);
  });

  test('PR-04: a query is matched below the open folder — not against the letters of where the folder is', () => {
    const fileTree = asTree([`${ROOT}/src/index.js`, `${ROOT}/README.md`]);
    assert.deepEqual(buildPaletteGroups({ fileTree, rootPath: ROOT, query: 'users', mode: 'files' }), [],
      '"users" matched every file under /Users');
    assert.deepEqual(titles(filesGroup(buildPaletteGroups({ fileTree, rootPath: ROOT, query: 'srcidx', mode: 'files' }))), ['index.js'],
      'the path below the folder still counts');
  });

  test('PR-05: the backend\'s list of every file is used when there is one — a file below the Explorer\'s five levels is offered', () => {
    const deep = `${ROOT}/src/main/java/com/acme/app/App.java`;
    const fileTree = [{ name: 'README.md', path: `${ROOT}/README.md`, is_dir: false }];
    const group = filesGroup(buildPaletteGroups({ fileTree, files: [deep, `${ROOT}/README.md`], rootPath: ROOT, query: 'app.java', mode: 'files' }));
    assert.deepEqual(group.items.map((i) => i.path), [deep]);
    assert.deepEqual(group.items[0], {
      type: 'file', id: `file-${deep}`, title: 'App.java', subtitle: deep, path: deep, hint: 'File',
    });
    // Without it — an older backend — the Explorer's tree is what there is.
    const fromTree = filesGroup(buildPaletteGroups({ fileTree, rootPath: ROOT, mode: 'files' }));
    assert.deepEqual(fromTree.items.map((i) => i.path), [`${ROOT}/README.md`]);
  });

  test('PR-06: on Windows, a path typed with "/" — or "\\" — finds the file the backend names with "\\"', () => {
    const root = 'C:\\proj';
    const fileTree = asTree(['C:\\proj\\lib\\app.js', 'C:\\proj\\src\\App.jsx']);
    for (const query of ['src/app', 'src\\app']) {
      const group = filesGroup(buildPaletteGroups({ fileTree, rootPath: root, query, mode: 'files' }));
      assert.deepEqual(group.items.map((i) => i.path), ['C:\\proj\\src\\App.jsx'], query);
    }
  });

  test('PR-07: a list the backend had to cut is said to be cut', () => {
    const group = filesGroup(buildPaletteGroups({ files: generated(3), filesTruncated: true, rootPath: ROOT, mode: 'files' }));
    assert.equal(group.truncated, true);
    assert.equal(filesGroup(buildPaletteGroups({ files: generated(3), rootPath: ROOT, mode: 'files' })).truncated, false);
  });

  test('PR-08: commands are listed as before alongside the files, and never cut', () => {
    const fileTree = asTree(generated(500));
    const groups = buildPaletteGroups({ fileTree, rootPath: ROOT, mode: 'all' });
    assert.deepEqual(groups.map((g) => g.label), ['files', 'commands']);
    assert.equal(groups[1].items.length, paletteCommands().length);
    assert.equal(buildPaletteGroups({ fileTree, rootPath: ROOT, mode: 'files' }).some((g) => g.label === 'commands'), false);
  });
});

describe('Command palette: where the keyboard goes when it closes', () => {
  test('PR-11: a command from history — the terminal it was typed into; a file — its editor; anything else, or nothing chosen — back where it was', () => {
    const groups = (mode, extra = {}) => buildPaletteGroups({ mode, rootPath: ROOT, ...extra });
    const [historyRow] = groups('history', { history: [{ command: 'npm test', count: 1 }] })[0].items;
    const [fileRow] = groups('files', { files: [`${ROOT}/a.js`] })[0].items;
    const [recentRow] = groups('recent', { recentRoots: ['/x/alpha'] })[0].items;
    assert.equal(focusAfterPalette(historyRow), 'terminal');
    assert.equal(focusAfterPalette(fileRow), 'editor');
    assert.equal(focusAfterPalette(recentRow), 'opener');
    for (const command of paletteCommands()) assert.equal(focusAfterPalette(command), 'opener', command.command);
    assert.equal(focusAfterPalette(null), 'opener', 'closed without a choice');
  });

  test('PR-12: what had the keyboard has it back while it is on the page — not the page itself, and not a button', () => {
    const body = { tagName: 'BODY' };
    const terminal = { tagName: 'TEXTAREA' };
    const rename = { tagName: 'INPUT' };
    const searchBox = { tagName: 'BUTTON' };
    const onPage = (el) => el !== rename; // the rename field closed meanwhile
    const back = (opener) => canHaveFocusBack(opener, { body, onPage });
    assert.equal(back(terminal), true);
    assert.equal(back(rename), false, 'it has left the page');
    assert.equal(back(body), false, 'nothing had it');
    assert.equal(back(null), false);
    // Chromium focuses a button that is clicked: the title bar's search box,
    // given it back, would open the palette again on the next Enter.
    assert.equal(back(searchBox), false);
  });
});

describe('Command palette: the backend\'s file list (browser mock)', () => {
  test('PR-09: fs_list_files lists every file below the open folder, path order, without the folders the Explorer skips', async () => {
    const base = `/workspace/_list_files_${Date.now()}`;
    const make = [
      `${base}/z.js`,
      `${base}/a/deep/er/still/deeper/x.js`,
      `${base}/node_modules/pkg/index.js`,
      `${base}/.git/HEAD`,
      `${base}/dist/bundle.js`,
      `${base}/src/dist.txt`,
    ];
    for (const path of make) await mockBridge.invoke('fs_write_file', { path, content: '' });
    const { files, truncated } = await mockBridge.invoke('fs_list_files', {});
    const mine = files.filter((p) => p.startsWith(`${base}/`));
    assert.deepEqual(mine, [`${base}/a/deep/er/still/deeper/x.js`, `${base}/src/dist.txt`, `${base}/z.js`]);
    assert.equal(truncated, false);
    assert.deepEqual(files, [...files].sort(), 'in path order');
  });

  test('PR-10: fs_list_files stops at `limit`, and says it did', async () => {
    const all = await mockBridge.invoke('fs_list_files', {});
    assert.ok(all.files.length > 3, 'precondition: the mock holds more than three files');
    const cut = await mockBridge.invoke('fs_list_files', { limit: 3 });
    assert.deepEqual(cut, { files: all.files.slice(0, 3), truncated: true });
  });
});

describe('Command palette: which command comes first', () => {
  // Enter runs the first row. A description matches loosely — Clear
  // Terminal's ("Clears the active terminal's screen and scrollback…")
  // spells "save all" — and declared first, it was the row Enter ran.
  test('PR-13: a command named by the query comes before one only its description matches', () => {
    const commands = (query) =>
      buildPaletteGroups({ fileTree: [], rootPath: ROOT, query, mode: 'commands' }).find((g) => g.label === 'commands')?.items ?? [];
    const clear = paletteCommands(DEFAULT_RESOLVED).find((c) => c.id === 'cmd-clear-terminal');
    assert.ok(clear.subtitle.length > 0, 'setup');

    const saveAll = commands('save all');
    assert.equal(saveAll[0]?.title, 'Save All Files', JSON.stringify(saveAll.map((c) => c.title)));
    assert.ok(saveAll.some((c) => c.id === 'cmd-clear-terminal'), 'setup: the description does match');
    // With nothing typed, every command, in the order they are declared.
    assert.deepEqual(commands('').map((c) => c.id), paletteCommands(DEFAULT_RESOLVED).map((c) => c.id));
  });
});
