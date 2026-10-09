/**
 * Which directory a name in a terminal's output is read against
 * (src/lib/outputContext.js) — the cases review found by running them:
 *
 *   - `ls src-tauri` run from the repository root underlined `src` and
 *     showed the root's `src`, not `src-tauri/src`;
 *   - under `ls -R`'s `./src:` heading, `index.js` linked to the top-level
 *     one;
 *   - output printed before a `cd` was read against the directory after it;
 *   - `ssh host ls` underlined the local folders that happened to share the
 *     remote ones' names.
 *
 * The terminal is a real headless xterm; the command marks are made on it
 * as stickyCommand.js makes them (a marker on the first row of a command's
 * output), and the backend is a set of paths said to exist.
 */
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  MAX_CWD_MARKS,
  blockAt,
  contextAt,
  createCwdTrail,
  headerOf,
  trackDirectories,
  parseCommand,
  planNames,
  promptOf,
} from '../../src/lib/outputContext.js';
import { chooseLinks, pathsAtRow } from '../../src/lib/outputPaths.js';

const { Terminal: HeadlessTerminal } = headless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

/** A marker that says where it is, as xterm's do. */
const marker = (line) => ({ line, isDisposed: false, disposed: 0, dispose() { this.isDisposed = true; this.disposed += 1; } });

/**
 * A terminal that ran `blocks` in turn — `{ command, cwd, lines }`, each a
 * command typed at a prompt in `cwd`, and its output — with a command mark
 * and a `pty-cwd` mark where the shell would have made them.
 */
async function session(blocks, { cols = 100, prompt = (cwd) => `me@mac ${cwd} % ` } = {}) {
  const term = new HeadlessTerminal({ cols, rows: 60, scrollback: 1000, allowProposedApi: true });
  const marks = [];
  const trail = createCwdTrail({ initial: blocks[0].cwd });
  for (const { command, cwd, lines } of blocks) {
    trail.note(term.registerMarker(0), cwd);
    await write(term, `${prompt(cwd)}${command}\r\n`);
    if (command !== null) marks.push({ marker: term.registerMarker(0), command });
    await write(term, lines.map((line) => `${line}\r\n`).join(''));
  }
  return { term, marks, trail };
}

/** The row (1-based) whose text starts with `text`. */
function rowOf(term, text) {
  const buffer = term.buffer.active;
  for (let y = 0; y < buffer.length; y += 1) if (buffer.getLine(y).translateToString(true).startsWith(text)) return y + 1;
  throw new Error(`no row starts with ${JSON.stringify(text)}`);
}

/**
 * The paths a hover on `row` would show, when `existing` exist: the
 * provider's pipeline (src/lib/revealLinks.js) with the backend's answer
 * standing in.
 */
function shown({ term, marks, trail }, row, existing, place = { os: 'macos' }) {
  const buffer = term.buffer.active;
  const candidates = pathsAtRow(buffer, row);
  const context = contextAt({ buffer, line: row - 1, cwdAt: (line) => trail.at(line), marks });
  const plan = planNames(candidates, context, place);
  const kinds = new Map(existing.map((p) => [p, p.endsWith('/') ? 'dir' : 'file']));
  for (const p of plan.paths) if (!kinds.has(p) && existing.includes(`${p}/`)) kinds.set(p, 'dir');
  return chooseLinks(plan.choose(kinds), kinds).map((c) => c.path);
}

describe('Output context: the directory a row was printed in', () => {
  test('OC-01: a directory change is marked where it happened; rows above keep the one before', () => {
    const trail = createCwdTrail({ initial: '/a' });
    assert.equal(trail.at(0), '/a', 'before anything was reported');
    trail.note(marker(10), '/b');
    trail.note(marker(20), '/c');
    assert.deepEqual([5, 10, 15, 20, 99].map((line) => trail.at(line)), ['/a', '/b', '/b', '/c', '/c']);
    const same = marker(30);
    trail.note(same, '/c');
    assert.equal(same.disposed, 1, 'no change: no mark kept');
    assert.equal(trail.size, 2);
  });

  test('OC-02: marks gone off the top leave their directory to the rows above the oldest left; bounded', () => {
    const trail = createCwdTrail({ initial: '/a' });
    const first = marker(10);
    trail.note(first, '/b');
    trail.note(marker(20), '/c');
    first.isDisposed = true;
    assert.equal(trail.at(5), '/b', 'printed after /b was reported, above the marks still alive');
    const bounded = createCwdTrail({ initial: '/0', limit: 3 });
    const markers = [1, 2, 3, 4, 5].map((n) => marker(n * 10));
    markers.forEach((m, i) => bounded.note(m, `/${i + 1}`));
    assert.equal(bounded.size, 3);
    assert.deepEqual(markers.map((m) => m.disposed), [1, 1, 0, 0, 0], 'the oldest let go');
    assert.equal(bounded.at(5), '/2', 'above everything kept: the newest let go');
    assert.ok(MAX_CWD_MARKS >= 100);
    bounded.dispose();
    assert.deepEqual(markers.map((m) => m.disposed), [1, 1, 1, 1, 1]);
  });

  test('OC-03: output from before a `cd` is read where it was printed (real terminal)', async () => {
    const s = await session([
      { command: 'ls', cwd: '/repo', lines: ['README.md  src'] },
      { command: 'cd docs', cwd: '/repo', lines: [] },
      { command: 'ls', cwd: '/repo/docs', lines: ['guide.md  src'] },
    ]);
    const existing = ['/repo/README.md', '/repo/src/', '/repo/docs/guide.md', '/repo/docs/src/'];
    const rows = s.term.buffer.active;
    const [first, second] = [0, 1].map((k) => {
      let n = 0;
      for (let y = 0; y < rows.length; y += 1) {
        if (rows.getLine(y).translateToString(true).endsWith('  src') && n++ === k) return y + 1;
      }
      return -1;
    });
    assert.deepEqual(shown(s, first, existing), ['/repo/README.md', '/repo/src'], 'printed in /repo');
    assert.deepEqual(shown(s, second, existing), ['/repo/docs/guide.md', '/repo/docs/src'], 'printed in /repo/docs');
    s.term.dispose();
  });
});

describe('Output context: the directory trail through what clears, trims and redraws a screen', () => {
  /**
   * A real terminal with the trail kept as terminalRegistry.js keeps it
   * (`trackDirectories`): a mark placed after the output before it is
   * written, where each mark is refreshed after every parse, an erased one
   * placed again, and a reset starting it over.
   */
  async function wired({ rows = 10, scrollback = 200, cols = 40 } = {}) {
    const term = new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
    let current = '/workspace';
    const trail = trackDirectories(term, { initial: '/workspace', current: () => current });
    const out = (data) => write(term, data);
    const cd = async (cwd) => {
      current = cwd;
      trail.note(cwd);
      await out('');
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const line = (text) => {
      const buffer = term.buffer.active;
      for (let y = 0; y < buffer.length; y += 1) if (buffer.getLine(y).translateToString(true) === text) return y;
      return -1;
    };
    return { term, trail, out, cd, settle, line };
  }
  const fill = (n, tag = 'filler') => Array.from({ length: n }, (_, i) => `${tag} ${i}\r\n`).join('');

  test('OC-14: a cleared screen (Ctrl+L, `clear`) leaves what scrolled above it in the directory it was printed in', async () => {
    // Review, 2026-10-10: README.md printed in /workspace, then `cd src` and
    // Ctrl+L — and the old README.md was read in /workspace/src.
    const w = await wired();
    await w.out(`README.md\r\n${fill(30)}`);
    await w.cd('/workspace/src');
    await w.out('$ ls\r\nApp.jsx\r\n');
    assert.equal(w.trail.at(w.line('README.md')), '/workspace');
    assert.equal(w.trail.at(w.line('App.jsx')), '/workspace/src');
    await w.out('\x1b[H\x1b[2J$ ');
    await w.settle();
    assert.equal(w.trail.at(w.line('README.md')), '/workspace', 'still above the clear: the directory it was printed in');
    assert.equal(w.trail.at(w.term.buffer.active.baseY), '/workspace/src', 'the cleared screen: the directory since the cd');
    await w.cd('/workspace/src/lib');
    await w.out('\r\nindex.js\r\n');
    assert.equal(w.trail.at(w.line('index.js')), '/workspace/src/lib', 'a change after the clear holds below it');
    assert.equal(w.trail.at(w.line('README.md')), '/workspace');
    w.term.dispose();
  });

  test('OC-15: a mark trimmed off the top still owns everything printed after it', async () => {
    const w = await wired({ scrollback: 20 });
    await w.out('old.txt\r\n');
    await w.cd('/workspace/src');
    await w.out(fill(60, 'later'));
    assert.equal(w.line('old.txt'), -1, 'premise: trimmed off the top');
    assert.equal(w.trail.at(0), '/workspace/src', 'the top row now was printed after the cd');
    w.term.dispose();
  });

  test('OC-16: a deleted line in a scroll region, reflow, ED3 and RIS — the trail stays where the changes were', async () => {
    // DL on the mark's own row disposes the mark: it is placed again, at the
    // top of the screen it was on, so rows above it keep their directory.
    const dl = await wired();
    await dl.out(`README.md\r\n${fill(30)}`);
    await dl.cd('/workspace/src');
    await dl.out('\x1b[1;10r\x1b[10;1H\x1b[M\x1b[r');
    await dl.settle();
    assert.equal(dl.trail.at(dl.line('README.md')), '/workspace');
    assert.equal(dl.trail.at(dl.term.buffer.active.baseY + dl.term.rows - 1), '/workspace/src');
    dl.term.dispose();

    // Reflow, ED3 and RIS keep xterm's markers: the answers stay right.
    for (const [what, act] of [
      ['reflow', (w) => w.term.resize(20, 10)],
      ['ED3', (w) => w.out('\x1b[3J')],
      ['RIS', (w) => w.out('\x1bc')],
    ]) {
      const w = await wired();
      await w.out(`README.md\r\n${fill(4)}`);
      await w.cd('/workspace/src');
      await w.out('App.jsx\r\n');
      const before = [w.trail.at(w.line('README.md')), w.trail.at(w.line('App.jsx'))];
      assert.deepEqual(before, ['/workspace', '/workspace/src'], `${what}: premise`);
      await act(w);
      await w.settle();
      const readme = w.line('README.md');
      if (readme >= 0) assert.equal(w.trail.at(readme), '/workspace', `${what}: README.md`);
      const app = w.line('App.jsx');
      if (app >= 0) assert.equal(w.trail.at(app), '/workspace/src', `${what}: App.jsx`);
      w.term.dispose();
    }
  });

  test('OC-18: after a reset (`reset`, `tput reset`, `printf \'\\ec\'`) the screen is read in the directory the tab is in', async () => {
    // Review, 2026-10-10: xterm keeps its markers alive through RIS at the
    // line numbers they had, so README.md printed at the top after a reset
    // was read in the directory of a stale mark below it.
    const w = await wired();
    await w.out(fill(9));
    await w.cd('/workspace/src');
    await w.out(fill(4, 'later'));
    await w.out('\x1bc');
    await w.out('README.md\r\n');
    assert.equal(w.line('README.md'), 0, 'premise: printed at the top, above where the old mark was');
    assert.equal(w.trail.at(0), '/workspace/src');
    // And xterm still did its reset.
    assert.equal(w.line('filler 0'), -1, 'the screen was reset');
    await w.cd('/workspace/src/lib');
    await w.out('index.js\r\n');
    assert.equal(w.trail.at(w.line('index.js')), '/workspace/src/lib', 'changes after the reset are marked again');
    assert.equal(w.trail.at(0), '/workspace/src');
    w.trail.dispose();
    w.term.dispose();
  });

  test('OC-17: without a buffer to place marks on, a dead mark counts as gone off the top, as before', () => {
    const trail = createCwdTrail({ initial: '/a' });
    const gone = marker(10);
    trail.note(gone, '/b');
    gone.isDisposed = true;
    assert.equal(trail.at(0), '/b');
  });
});

describe('Output context: a directory change holds from the start of the command that made it', () => {
  /**
   * A zsh with shell integration on a real terminal: each command typed at a
   * prompt, a command mark where its output starts (OSC 133 "C", as
   * stickyCommand.js marks it), its output, and then — only as the next
   * prompt is drawn — the directory it left the shell in (OSC 7), noted as
   * terminalRegistry.js notes it.
   */
  async function zsh(start = '/workspace') {
    const term = new HeadlessTerminal({ cols: 60, rows: 12, scrollback: 200, allowProposedApi: true });
    const marks = [];
    let current = start;
    const dirs = trackDirectories(term, { initial: start, current: () => current, marks: () => marks });
    const out = (data) => write(term, data);
    // The shell reporting its directory, without a command just run.
    const report = async (cwd) => {
      current = cwd;
      dirs.note(cwd);
      await out('');
    };
    const run = async (command, lines = [], after = null) => {
      await out(`me@mac % ${command}\r\n`);
      marks.push({ marker: term.registerMarker(0), command });
      await out(lines.map((line) => `${line}\r\n`).join(''));
      if (after && after !== current) await report(after);
    };
    const line = (text) => {
      const buffer = term.buffer.active;
      for (let y = 0; y < buffer.length; y += 1) if (buffer.getLine(y).translateToString(true) === text) return y;
      return -1;
    };
    return { term, dirs, out, run, report, line, marks };
  }

  test('OC-19: `cd src && ls` — the listing is read in src, though the shell says so only at the next prompt', async () => {
    // Found in the live app: `cd /x/reveal && clear && ls` was read in the
    // old directory, and `plainfolder`, there only in /x/reveal, got no link.
    const z = await zsh();
    await z.run('cd src && ls', ['App.jsx  index.js'], '/workspace/src');
    assert.equal(z.dirs.at(z.line('App.jsx  index.js')), '/workspace/src');
    await z.run('cd .. && ls -l', ['README.md'], '/workspace');
    assert.equal(z.dirs.at(z.line('README.md')), '/workspace', 'and back');
    assert.equal(z.dirs.at(z.line('App.jsx  index.js')), '/workspace/src', 'the first listing kept its own');
    z.term.dispose();
  });

  test('OC-20: a `cd` on its own line leaves the listings before it where they were', async () => {
    const z = await zsh();
    await z.run('ls', ['README.md  src']);
    await z.run('cd src', [], '/workspace/src');
    await z.run('ls', ['App.jsx']);
    assert.equal(z.dirs.at(z.line('README.md  src')), '/workspace');
    assert.equal(z.dirs.at(z.line('App.jsx')), '/workspace/src');
    z.term.dispose();
  });

  test('OC-21: `ls; cd src` typed as one line is read in src — the accepted trade-off', async () => {
    const z = await zsh();
    await z.run('ls; cd src', ['README.md  src'], '/workspace/src');
    assert.equal(z.dirs.at(z.line('README.md  src')), '/workspace/src', 'documented: the listing is read where the command ended');
    z.term.dispose();
  });

  test('OC-22: with command marks, a reset still starts again — and marks from before it are not where a change begins', async () => {
    const z = await zsh();
    for (let i = 0; i < 4; i += 1) await z.run(`ls ${i}`, [`row ${i}a`, `row ${i}b`]);
    await z.run('cd src', [], '/workspace/src');
    await z.out('\x1bc');
    await z.out('README.md\r\nlater 1\r\nlater 2\r\n');
    assert.equal(z.dirs.at(z.line('README.md')), '/workspace/src', 'after the reset: the directory the tab is in');
    // A change reported with no command since the reset: the marks of the
    // commands before it, still alive at their old lines, are not taken for
    // where it began.
    await z.report('/workspace/src/lib');
    assert.equal(z.dirs.at(z.line('later 2')), '/workspace/src', 'not moved back over the rows printed before it');
    assert.equal(z.dirs.at(z.line('README.md')), '/workspace/src');
    await z.run('cd .. && ls', ['index.js'], '/workspace/src');
    assert.equal(z.dirs.at(z.line('index.js')), '/workspace/src', 'a command after the reset is marked as before');
    z.term.dispose();
  });

  test('OC-23: without command marks (cmd), a change holds from the row the cursor was on, as before', async () => {
    const term = new HeadlessTerminal({ cols: 60, rows: 12, allowProposedApi: true });
    const dirs = trackDirectories(term, { initial: 'C:\\w', current: () => 'C:\\w\\src', marks: () => [] });
    await write(term, 'C:\\w>cd src && dir\r\nApp.jsx\r\n');
    dirs.note('C:\\w\\src');
    await write(term, '\r\nC:\\w\\src>');
    const buffer = term.buffer.active;
    let app = -1;
    for (let y = 0; y < buffer.length; y += 1) if (buffer.getLine(y).translateToString(true) === 'App.jsx') app = y;
    assert.equal(dirs.at(app), 'C:\\w', 'no block to start it from: the prompt line and dir\'s heading say where instead');
    term.dispose();
  });
});

describe('Output context: the command a row belongs to', () => {
  test('OC-04: listers, their one argument, and the commands that run elsewhere', () => {
    const cases = [
      ['ls -la src-tauri', { remote: false, listing: true, args: ['src-tauri'] }],
      ['ls', { remote: false, listing: true, args: [] }],
      ['ls a b', { remote: false, listing: true, args: ['a', 'b'] }],
      ["ls 'My Folder'", { remote: false, listing: true, args: ['My Folder'] }],
      ['dir /s /b /a:d docs', { remote: false, listing: true, args: ['docs'] }],
      ['gci -Path src -Recurse -Filter *.js', { remote: false, listing: true, args: ['src'] }],
      ['Get-ChildItem src', { remote: false, listing: true, args: ['src'] }],
      ['tree -L 2 src', { remote: false, listing: true, args: ['src'] }],
      ['eza -l --level 2 src', { remote: false, listing: true, args: ['src'] }],
      ['sudo ls /etc', { remote: false, listing: true, args: ['/etc'] }],
      ['LC_ALL=C ls x', { remote: false, listing: true, args: ['x'] }],
      ['\\ls src', { remote: false, listing: true, args: ['src'] }],
      ['ls src | grep a', { remote: false, listing: false, args: [] }],
      ['ls src > out.txt', { remote: false, listing: false, args: [] }],
      ['cat notes.txt', { remote: false, listing: false, args: [] }],
      ['ssh host ls', { remote: true, listing: false, args: [] }],
      ['mosh host', { remote: true, listing: false, args: [] }],
      ['docker exec -it web sh', { remote: true, listing: false, args: [] }],
      ['docker run --rm alpine ls', { remote: true, listing: false, args: [] }],
      ['docker ps', { remote: false, listing: false, args: [] }],
      ['kubectl exec -it pod -- ls', { remote: true, listing: false, args: [] }],
      ['wsl ls', { remote: true, listing: false, args: [] }],
      ['wsl.exe -d Ubuntu', { remote: true, listing: false, args: [] }],
      ['vagrant ssh', { remote: true, listing: false, args: [] }],
      ['vagrant up', { remote: false, listing: false, args: [] }],
      ['et host:8080', { remote: true, listing: false, args: [] }],
      ['cd x && ssh host', { remote: true, listing: false, args: [] }],
    ];
    for (const [command, expected] of cases) assert.deepEqual(parseCommand(command), expected, command);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand(null), null);
  });

  test('OC-05: the headers a listing prints, and the prompts a command is typed at', () => {
    const headers = [
      [' Directory of C:\\Users\\me\\project', 'C:\\Users\\me\\project'],
      [' C:\\Users\\me\\project 디렉터리', 'C:\\Users\\me\\project'],
      ['./src:', './src'],
      ['.:', '.'],
      ['src-tauri:', 'src-tauri'],
      ["'./My Folder':", './My Folder'],
      ["'it'\\''s':", "it's"],
      ['/etc:', '/etc'],
    ];
    for (const [line, dir] of headers) assert.equal(headerOf(line), dir, line);
    for (const line of ['Untracked files:', 'Changes not staged for commit:', 'C:', '  ./src:', 'a b:', '']) {
      assert.equal(headerOf(line), null, JSON.stringify(line));
    }
    assert.deepEqual(promptOf('C:\\Users\\me>dir src'), { cwd: 'C:\\Users\\me', command: 'dir src' });
    assert.deepEqual(promptOf('C:\\>'), { cwd: 'C:\\', command: '' });
    assert.deepEqual(promptOf('PS C:\\x> gci'), { cwd: 'C:\\x', command: 'gci' });
    assert.deepEqual(promptOf('PS /Users/me> ls'), { cwd: '/Users/me', command: 'ls' });
    for (const line of ['10/09/2026  10:00 PM    <DIR>          My Folder', ' Directory of C:\\x', 'a > b']) {
      assert.equal(promptOf(line), null, line);
    }
  });

  test('OC-06: blockAt — the newest command mark at or above a row', () => {
    const marks = [{ marker: marker(5), command: 'ls' }, { marker: marker(20), command: 'ls -R' }];
    assert.equal(blockAt(marks, 2), null);
    assert.deepEqual(blockAt(marks, 5), { line: 5, command: 'ls' });
    assert.deepEqual(blockAt(marks, 19), { line: 5, command: 'ls' });
    assert.deepEqual(blockAt(marks, 40), { line: 20, command: 'ls -R' });
    marks[1].marker.isDisposed = true;
    assert.deepEqual(blockAt(marks, 40), { line: 5, command: 'ls' }, 'an erased mark is no block');
  });
});

describe('Output context: names read where they were listed (real terminal)', () => {
  const REPO = ['/repo/src/', '/repo/src-tauri/', '/repo/src-tauri/src/', '/repo/src-tauri/Cargo.toml', '/repo/index.js', '/repo/src/index.js', '/repo/README.md'];

  test('OC-07: `ls src-tauri` from the root — its `src` is src-tauri\'s, though the root has one', async () => {
    const s = await session([{ command: 'ls src-tauri', cwd: '/repo', lines: ['Cargo.toml  src'] }]);
    assert.deepEqual(shown(s, rowOf(s.term, 'Cargo.toml'), REPO), ['/repo/src-tauri/Cargo.toml', '/repo/src-tauri/src']);
    s.term.dispose();
  });

  test('OC-08: `ls -R` — each name under its heading, the heading under the directory it was run in', async () => {
    const s = await session([{ command: 'ls -R', cwd: '/repo', lines: ['.:', 'index.js  src', '', './src:', 'index.js'] }]);
    const rows = s.term.buffer.active;
    const indexRows = [];
    for (let y = 0; y < rows.length; y += 1) if (rows.getLine(y).translateToString(true).startsWith('index.js')) indexRows.push(y + 1);
    assert.deepEqual(shown(s, indexRows[0], REPO), ['/repo/index.js', '/repo/src'], 'under `.:`');
    assert.deepEqual(shown(s, indexRows[1], REPO), ['/repo/src/index.js'], 'under `./src:`, not the top-level index.js');
    assert.deepEqual(shown(s, rowOf(s.term, './src:'), REPO), ['/repo/src'], 'the heading itself, read where ls ran');
    s.term.dispose();
  });

  test('OC-09: a header reaches no further than its own command\'s output', async () => {
    const s = await session([
      { command: 'ls -R src-tauri', cwd: '/repo', lines: ['src-tauri:', 'Cargo.toml  src'] },
      { command: 'cat list.txt', cwd: '/repo', lines: ['index.js'] },
    ]);
    assert.deepEqual(shown(s, rowOf(s.term, 'Cargo.toml'), REPO), ['/repo/src-tauri/Cargo.toml', '/repo/src-tauri/src']);
    assert.deepEqual(shown(s, rowOf(s.term, 'index.js'), REPO), ['/repo/index.js'], 'the next command: the tab\'s directory again');
    s.term.dispose();
  });

  test('OC-13: a bare `word:` line heads names only in a listing\'s output — not in a log', async () => {
    // Review, 2026-10-10: under `src:` in a build log, `index.js` revealed
    // src/index.js while the sentence meant the one beside it.
    const logged = await session([{ command: 'cat build.log', cwd: '/repo', lines: ['src:', 'compiled index.js ok'] }]);
    assert.deepEqual(shown(logged, rowOf(logged.term, 'compiled'), REPO), ['/repo/index.js'], 'a log line is no header');
    logged.term.dispose();
    const unknown = await session([{ command: null, cwd: '/repo', lines: ['src:', 'index.js'] }]);
    assert.deepEqual(shown(unknown, rowOf(unknown.term, 'index.js'), REPO), ['/repo/index.js'], 'nor is one in output no command is known for');
    unknown.term.dispose();
  });

  test('OC-10: a file or a glob as the one argument — only names with a separator are offered', async () => {
    const s = await session([
      { command: 'ls README.md', cwd: '/repo', lines: ['README.md'] },
      { command: 'ls src/*.js', cwd: '/repo', lines: ['src/index.js', 'index.js'] },
    ]);
    const existing = [...REPO, '/repo/README.md'];
    assert.deepEqual(shown(s, rowOf(s.term, 'README.md'), existing), [], 'the name alone: a file listed, no folder to read it in');
    assert.deepEqual(shown(s, rowOf(s.term, 'src/index.js'), existing), ['/repo/src/index.js']);
    assert.deepEqual(shown(s, rowOf(s.term, 'index.js'), existing), [], 'a bare name from a glob is not offered');
    s.term.dispose();
  });

  test('OC-11: in a block that logs in elsewhere, nothing is offered', async () => {
    const s = await session([
      { command: 'ssh build-box', cwd: '/repo', lines: ['me@build-box:~$ ls', 'README.md  src  /etc/hosts'] },
      { command: 'ls', cwd: '/repo', lines: ['README.md  src'] },
    ]);
    const rows = s.term.buffer.active;
    const listed = [];
    for (let y = 0; y < rows.length; y += 1) if (rows.getLine(y).translateToString(true).startsWith('README.md')) listed.push(y + 1);
    assert.deepEqual(shown(s, listed[0], [...REPO, '/etc/hosts']), [], 'the remote listing names that machine\'s files');
    assert.deepEqual(shown(s, listed[1], REPO), ['/repo/README.md', '/repo/src'], 'and the next local command is local again');
    s.term.dispose();
  });

  test('OC-12: Windows `dir` — the header names the folder; cmd\'s prompt is its command block', async () => {
    // cmd reports no command blocks: the prompt line is what says where a
    // command starts, what it was and where it ran.
    const term = new HeadlessTerminal({ cols: 100, rows: 40, allowProposedApi: true });
    const lines = [
      'C:\\Users\\me>dir C:\\data',
      ' Directory of C:\\data',
      '',
      '2026-10-09  오후 10:00    <DIR>          새 폴더',
      '',
      'C:\\Users\\me>dir docs',
      '2026-10-09  오후 10:00            12,345 보고서.txt',
      '',
      'C:\\Users\\me>type list.txt',
      '새 폴더',
    ];
    await write(term, `${lines.join('\r\n')}\r\n`);
    const s = { term, marks: [], trail: createCwdTrail({ initial: 'C:\\Users\\me' }) };
    const existing = ['C:\\data\\새 폴더\\'.replace(/\\$/, '/'), 'C:\\Users\\me\\docs/', 'C:\\Users\\me\\docs\\보고서.txt', 'C:\\Users\\me\\새 폴더/'];
    const win = { os: 'windows' };
    const rows = term.buffer.active;
    const folderRows = [];
    for (let y = 0; y < rows.length; y += 1) if (rows.getLine(y).translateToString(true).endsWith('새 폴더')) folderRows.push(y + 1);
    assert.deepEqual(shown(s, folderRows[0], existing, win), ['C:\\data\\새 폴더'], 'under ` Directory of C:\\data`');
    assert.deepEqual(shown(s, rowOf(term, '2026-10-09  오후 10:00            12,345'), existing, win), ['C:\\Users\\me\\docs\\보고서.txt'], '`dir docs`, typed at C:\\Users\\me>');
    assert.deepEqual(shown(s, folderRows[1], existing, win), ['C:\\Users\\me\\새 폴더'], 'the next command: no header, no listing');
    term.dispose();
  });
});
