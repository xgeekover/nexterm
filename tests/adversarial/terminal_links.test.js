/**
 * The clickable things in terminal output.
 *
 * Two ways this feature can be worse than not having it: claiming text that is
 * not a link (every word with a slash in it turns blue and the output becomes
 * unreadable), and resolving a real link to the wrong file (a click opens
 * something unrelated, which is worse than a click doing nothing).
 *
 * So most of these cases are about what must NOT match, and about the cwd a
 * relative path is read against. The samples are real output shapes — rustc,
 * node, python, eslint, tsc, cmd.exe — rather than invented ones.
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  MAX_LINK_LENGTH,
  findLinks,
  isNetworkPath,
  linksAtRow,
  resolveLinkPath,
} from '../../src/lib/terminalLinks.js';
import { isOpenable } from '../../src/lib/openExternal.js';

const { Terminal: HeadlessTerminal } = headless;

const only = (text) => {
  const links = findLinks(text);
  assert.equal(links.length, 1, `expected exactly one link in ${JSON.stringify(text)}, got ${links.length}`);
  return links[0];
};

describe('Terminal links: what is a link', () => {
  test('LK-01: the shapes real tools print', () => {
    // rustc
    let l = only('  --> src/main.rs:10:5');
    assert.equal(l.path, 'src/main.rs');
    assert.equal(l.line, 10);
    assert.equal(l.column, 5);

    // node / jest / vitest
    l = only('    at Object.<anonymous> tests/unit/app.test.js:42:13');
    assert.equal(l.path, 'tests/unit/app.test.js');
    assert.equal(l.line, 42);

    // tsc and eslint, which stop at the line
    l = only('src/lib/paths.ts:88 - error TS2345');
    assert.equal(l.path, 'src/lib/paths.ts');
    assert.equal(l.line, 88);
    assert.equal(l.column, null);

    // python
    l = only('  File "src/app.py", line 42');
    assert.equal(l.path, 'src/app.py');
    assert.equal(l.line, 42);
  });

  test('LK-02: explicitly relative and absolute paths', () => {
    assert.equal(only('./src/a.js:1').path, './src/a.js');
    assert.equal(only('../shared/b.ts:2:3').path, '../shared/b.ts');
    assert.equal(only('/Users/me/p/c.rs:9').path, '/Users/me/p/c.rs');
  });

  test('LK-03: Windows, both spellings, drive letter and all', () => {
    // The colon in `C:` is why the position is read from the end of the match
    // rather than counted from the front.
    let l = only('C:\\work\\proj\\src\\main.rs:10:5');
    assert.equal(l.path, 'C:\\work\\proj\\src\\main.rs');
    assert.equal(l.line, 10);
    assert.equal(l.column, 5);

    l = only('src\\components\\App.jsx:7');
    assert.equal(l.path, 'src\\components\\App.jsx');
    assert.equal(l.line, 7);

    // A tool under cmd.exe may still print forward slashes.
    assert.equal(only('C:/work/proj/src/main.rs:3').path, 'C:/work/proj/src/main.rs');
  });

  test('LK-04: a line number is required, so prose is left alone', () => {
    // Without this rule every word with a slash lights up.
    assert.deepEqual(findLinks('see src/main.rs for details'), []);
    assert.deepEqual(findLinks('cd src/components && npm test'), []);
    assert.deepEqual(findLinks('total 24 drwxr-xr-x  5 me staff'), []);
  });

  test('LK-05: an extension is required, so a printed PATH is not a link', () => {
    assert.deepEqual(findLinks('/usr/bin:/usr/local/bin:/opt/homebrew/bin'), []);
    assert.deepEqual(findLinks('warning: 3 problems:12 fixable'), []);
  });

  test('LK-06: timestamps and versions are not files', () => {
    assert.deepEqual(findLinks('[12:34:56] build finished'), []);
    assert.deepEqual(findLinks('listening on 0.0.0.0:3000'), []);
    assert.deepEqual(findLinks('node v22.14.0:1'), [], 'a version is not a path');
  });

  test('LK-07: several links on one line, in order', () => {
    const links = findLinks('src/a.js:1 and src/b.js:22:3');
    assert.equal(links.length, 2);
    assert.equal(links[0].path, 'src/a.js');
    assert.equal(links[1].path, 'src/b.js');
    assert.equal(links[1].column, 3);
    assert.ok(links[0].start < links[1].start);
  });

  test('LK-08: the offsets point at the text that was matched', () => {
    const text = 'error in src/lib/x.ts:14:2 — undefined';
    const l = only(text);
    assert.equal(text.slice(l.start, l.start + l.length), 'src/lib/x.ts:14:2');
  });
});

describe('Terminal links: URLs', () => {
  test('LK-09: http and https only — nothing that could run', () => {
    assert.equal(only('see https://example.com/docs').href, 'https://example.com/docs');
    assert.equal(only('http://localhost:5173/').href, 'http://localhost:5173/');
    // `file:` reads the disk and `javascript:` runs; neither is offered.
    assert.deepEqual(findLinks('file:///etc/passwd'), []);
    assert.deepEqual(findLinks('javascript:alert(1)'), []);
    assert.deepEqual(findLinks('ftp://host/x'), []);
  });

  test('LK-10: trailing prose punctuation is not part of the address', () => {
    assert.equal(only('open https://example.com/x.').href, 'https://example.com/x');
    assert.equal(only('(see https://example.com/x)').href, 'https://example.com/x');
    // …but a bracket the URL itself opened is.
    assert.equal(only('https://en.wikipedia.org/wiki/Foo_(bar)').href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  test('LK-11: a path-shaped tail inside a URL stays part of the URL', () => {
    // The failure this prevents: half a URL turning into a file link, so a
    // click opens nothing and the address is no longer clickable either.
    const l = only('http://localhost:8080/static/app.js:3');
    assert.equal(l.kind, 'url');
    assert.equal(l.href, 'http://localhost:8080/static/app.js:3');
  });
});

describe('Terminal links: where a relative path points', () => {
  test('LK-12: resolved against the shell’s cwd, not the workspace root', () => {
    // A `cargo` run inside src-tauri/ prints `src/main.rs`, which is
    // src-tauri/src/main.rs — resolving it against the workspace root opens
    // the wrong file, or nothing.
    assert.equal(
      resolveLinkPath('src/main.rs', '/work/proj/src-tauri'),
      '/work/proj/src-tauri/src/main.rs'
    );
    assert.equal(resolveLinkPath('./src/a.js', '/work/proj'), '/work/proj/src/a.js');
  });

  test('LK-13: an absolute path is already the answer', () => {
    assert.equal(resolveLinkPath('/etc/hosts.conf', '/work'), '/etc/hosts.conf');
    assert.equal(resolveLinkPath('C:\\work\\a.rs', 'C:\\other'), 'C:\\work\\a.rs');
  });

  test('LK-14: Windows keeps its own separator', () => {
    assert.equal(resolveLinkPath('src\\main.rs', 'C:\\work\\proj'), 'C:\\work\\proj\\src\\main.rs');
    // A forward-slash relative path under a Windows cwd still joins with `\`,
    // because the backend is handed a Windows path either way.
    assert.equal(resolveLinkPath('src/main.rs', 'C:\\work\\proj'), 'C:\\work\\proj\\src/main.rs');
    // Trailing separators on the cwd must not double up.
    assert.equal(resolveLinkPath('a.js', 'C:\\work\\'), 'C:\\work\\a.js');
    assert.equal(resolveLinkPath('a.js', '/work/'), '/work/a.js');
  });

  test('LK-15: nothing to resolve against is null, not a guess', () => {
    assert.equal(resolveLinkPath('src/a.js', null), null);
    assert.equal(resolveLinkPath('src/a.js', ''), null);
    assert.equal(resolveLinkPath(null, '/work'), null);
  });
});

describe('Terminal links: what may be handed to the system browser', () => {
  test('LK-16: http and https, and nothing else, whoever asks', () => {
    // The matcher already refuses to OFFER anything else, but this function is
    // exported and the next caller may not come through the matcher. Three
    // independent gates guard one action the terminal's own output can reach:
    // the matcher, this, and the backend capability's url scope.
    assert.equal(isOpenable('https://example.com'), true);
    assert.equal(isOpenable('http://localhost:1425/'), true);

    assert.equal(isOpenable('file:///etc/passwd'), false, 'reads the disk');
    assert.equal(isOpenable('javascript:alert(1)'), false, 'runs');
    assert.equal(isOpenable('data:text/html,<script>x</script>'), false);
    assert.equal(isOpenable('vscode://x/y'), false, 'hands off to another app');
    assert.equal(isOpenable('ftp://host/x'), false);
  });

  test('LK-17: anything that is not a URL at all is not openable', () => {
    assert.equal(isOpenable('not a url'), false);
    assert.equal(isOpenable(''), false);
    assert.equal(isOpenable(null), false);
    assert.equal(isOpenable(undefined), false);
    assert.equal(isOpenable(42), false);
    // A scheme-relative address has no scheme to check, so it is refused.
    assert.equal(isOpenable('//example.com'), false);
  });
});

// ---------------------------------------------------------------------------
// The link provider runs when the pointer moves onto another row, on the UI
// thread. One long line without a newline — a base64 blob, a hex dump, an
// inline source map — took seconds per row: the provider joined every row of
// the wrapped line, and the path pattern was quadratic on such text (1.5 s for
// 32,000 characters of `a.a.a…`, 3 s for 131,000 of base64, measured).

/** Milliseconds `fn` takes, the best of a few runs — the first compiles the patterns. */
function timed(fn) {
  let best = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Bytes that look random to a regex, the same every run. */
function noise(n) {
  const out = Buffer.alloc(n);
  let x = 2463534242;
  for (let i = 0; i < n; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** An xterm-shaped buffer of one line wrapped over `rows` rows, counting the rows read. */
function wrappedBuffer(text, cols) {
  const rows = [];
  for (let i = 0; i < text.length; i += cols) rows.push(text.slice(i, i + cols).padEnd(cols, ' '));
  const buffer = {
    reads: 0,
    length: rows.length,
    getLine(y) {
      if (y < 0 || y >= rows.length) return undefined;
      buffer.reads += 1;
      return { isWrapped: y > 0, translateToString: () => rows[y] };
    },
  };
  return buffer;
}

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

describe('Terminal links: a long line costs what a short one does', () => {
  test('LK-18: path-like runs of 64,000 characters are scanned in a few milliseconds', () => {
    const N = 64000;
    const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    const shapes = {
      'a.a.a…': fill('a.'),
      base64: noise((N * 3) / 4).toString('base64'),
      hex: noise(N / 2).toString('hex'),
      'ab/ab/…': fill('ab/'),
      'src/a.b/…': fill('src/a.b/'),
      'dots (a test reporter)': '.'.repeat(N),
      'a URL and a run of `)`': `https://example.com/${')'.repeat(N)}`,
      'a.b:1 a.b:1 … (thousands of links)': fill('a.b:1 '),
    };
    for (const [name, text] of Object.entries(shapes)) {
      const ms = timed(() => findLinks(text));
      assert.ok(ms < 30, `${name}: ${ms.toFixed(1)} ms for ${text.length} characters`);
    }
  });

  test('LK-19: a row of a wrapped line 20,000 rows long reads a bounded stretch of it', () => {
    const cols = 80;
    const buffer = wrappedBuffer(noise(1_200_000).toString('base64').slice(0, 1_600_000), cols);
    assert.equal(buffer.length, 20000);
    let links;
    const ms = timed(() => {
      buffer.reads = 0;
      links = linksAtRow(buffer, 10000);
    });
    assert.deepEqual(links, []);
    const bound = 2 * (Math.ceil(MAX_LINK_LENGTH / cols) + 1) + 1;
    assert.ok(buffer.reads <= bound, `${buffer.reads} rows read for one row, at most ${bound} expected`);
    assert.ok(ms < 10, `${ms.toFixed(1)} ms for a hover`);
  });

  test('LK-20: a link across the edge of two rows is found from either, with xterm’s ranges', async () => {
    const term = new HeadlessTerminal({ cols: 40, rows: 10, allowProposedApi: true });
    await write(term, `${'x'.repeat(30)} src/components/terminal/Thing.jsx:42:7 tail\r\n`);
    const buffer = term.buffer.active;
    assert.equal(buffer.getLine(1).isWrapped, true, 'the line wrapped');
    for (const row of [1, 2]) {
      const [link, extra] = linksAtRow(buffer, row);
      assert.equal(extra, undefined, `one link from row ${row}`);
      assert.equal(link.path, 'src/components/terminal/Thing.jsx');
      assert.equal(link.line, 42);
      assert.equal(link.column, 7);
      // 1-based, inclusive at both ends.
      assert.deepEqual(link.range, { start: { x: 32, y: 1 }, end: { x: 29, y: 2 } });
    }
    assert.deepEqual(linksAtRow(buffer, 3), [], 'nothing on the row after');
    assert.deepEqual(linksAtRow(buffer, 99), [], 'nor past the end of the buffer');
    term.dispose();
  });

  test('LK-21: only the links touching the row asked about, and never a piece of a longer one', () => {
    const cols = 40;
    // Row 1 has a link, row 2 none, row 3 another.
    const text = `see a.js:1${' '.repeat(30)}${'-'.repeat(40)}and b.js:2${' '.repeat(30)}`;
    const buffer = wrappedBuffer(text, cols);
    assert.deepEqual(linksAtRow(buffer, 1).map((l) => l.path), ['a.js']);
    assert.deepEqual(linksAtRow(buffer, 2), []);
    assert.deepEqual(linksAtRow(buffer, 3).map((l) => l.path), ['b.js']);

    // A path longer than MAX_LINK_LENGTH, ending on the row asked about: what
    // was read starts in the middle of it, and that piece must not be offered
    // as a path of its own. A short link on the same row still is.
    const huge = `${'segment/'.repeat(600)}deep.js:12 ok.js:3`;
    const long = wrappedBuffer(huge, cols);
    const last = Math.ceil(huge.length / cols);
    assert.deepEqual(linksAtRow(long, last).map((l) => l.path), ['ok.js']);
    const whole = findLinks(huge);
    assert.equal(whole.length, 2, 'the whole line, read at once, has both');
    assert.ok(whole[0].path.endsWith('segment/deep.js') && whole[0].path.startsWith('segment/'));
  });

  test('LK-22: a real terminal holding a 200,000-character base64 line answers a hover at once', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const blob = noise(150000).toString('base64');
    await write(term, `${blob} src/after/the/blob.ts:7\r\n`);
    const buffer = term.buffer.active;
    let lastRow = buffer.length;
    while (lastRow > 1 && !buffer.getLine(lastRow - 1).translateToString(true)) lastRow -= 1;
    const middle = Math.floor(lastRow / 2);
    assert.ok(buffer.getLine(middle - 1).isWrapped, 'the middle row is part of the wrapped line');
    const ms = timed(() => linksAtRow(buffer, middle));
    assert.ok(ms < 10, `${ms.toFixed(1)} ms for a hover in the middle of the line`);
    assert.deepEqual(linksAtRow(buffer, lastRow).map((l) => l.path), ['src/after/the/blob.ts']);
    term.dispose();
  });

  test('LK-23: wired — the provider asks linksAtRow, and joins no whole line of its own', () => {
    const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(registry, /linksAtRow\(term\.buffer\.active, row\)/);
    assert.doesNotMatch(registry, /logicalLineAt|findLinks\(/);
  });
});

// ---------------------------------------------------------------------------
// Opening `\\host\share\x.py` on Windows connects to `host` and signs in with
// the user's credentials — and the backend's canonicalize does that on its way
// to refusing a path outside the workspace. Terminal output is not trusted.

describe('Terminal links: never a path on another machine', () => {
  test('LK-24: a network path is not offered, however it is spelled', () => {
    for (const path of [
      '\\\\host.example\\share\\x.py',
      '//host.example/share/x.py',
      '/\\host\\share\\x.py',
      '\\/host/share/x.py',
      '\\\\?\\UNC\\host\\share\\x.py',
      '\\??\\UNC\\host\\share\\x.py',
      '\\\\.\\pipe\\x.py',
    ]) {
      assert.deepEqual(findLinks(`  File "${path}", line 1, in <module>`), [], `a traceback naming ${path}`);
      for (const link of findLinks(`${path}:1:2`)) {
        assert.ok(!isNetworkPath(link.path), `${path}:1:2 offered ${link.path}`);
      }
    }
    // Nor its tail, read as a local path: `//host/share/x.py:1` used to give
    // `/host/share/x.py`.
    assert.deepEqual(findLinks('//host/share/x.py:1'), []);
    assert.deepEqual(findLinks('\\\\host\\share\\x.py:1'), []);
  });

  test('LK-25: local paths are offered as before, the verbatim spelling of a drive included', () => {
    assert.equal(only('  File "C:\\work\\app.py", line 3').path, 'C:\\work\\app.py');
    assert.equal(only('  File "/home/me/app.py", line 3').path, '/home/me/app.py');
    assert.equal(only('  File "\\\\?\\C:\\work\\app.py", line 3').path, '\\\\?\\C:\\work\\app.py');
    // Rust's canonicalize prints this spelling; the drive letter starts the path.
    assert.equal(only('error at \\\\?\\C:\\work\\src\\main.rs:10:5').path, 'C:\\work\\src\\main.rs');
  });

  test('LK-26: resolving never answers with a network path — from the link, or from the cwd', () => {
    assert.equal(resolveLinkPath('\\\\host\\share\\x.py', '/work'), null);
    assert.equal(resolveLinkPath('//host/share/x.py', '/work'), null);
    assert.equal(resolveLinkPath('/\\host\\share\\x.py', 'C:\\work'), null);
    assert.equal(resolveLinkPath('\\\\?\\UNC\\host\\share\\x.py', 'C:\\work'), null);
    assert.equal(resolveLinkPath('\\??\\UNC\\host\\share\\x.py', 'C:\\work'), null);
    // The cwd is reported by the shell with OSC 7, and anything printed can
    // print an OSC 7.
    assert.equal(resolveLinkPath('src\\x.py', '\\\\host\\share\\proj'), null);
    assert.equal(resolveLinkPath('src/x.py', '//host/share/proj'), null);
    assert.equal(resolveLinkPath('./x.py', '\\\\?\\UNC\\host\\share'), null);

    assert.equal(resolveLinkPath('\\\\?\\C:\\work\\a.py', null), 'C:\\work\\a.py', 'a verbatim local path is local');
    assert.equal(resolveLinkPath('src\\a.py', '\\\\?\\C:\\work'), 'C:\\work\\src\\a.py');
    assert.equal(resolveLinkPath('\\work\\a.py', 'C:\\x'), '\\work\\a.py', 'rooted on the current drive is local');
  });

  test('LK-27: what counts as another machine', () => {
    for (const path of ['\\\\h\\s', '//h/s', '\\/h/s', '/\\h\\s', '\\\\?\\UNC\\h\\s', '\\\\.\\pipe\\p', '\\??\\C:\\x', '/??/x']) {
      assert.equal(isNetworkPath(path), true, path);
    }
    for (const path of ['C:\\x', 'C:/x', '/x', '\\x', 'x\\\\y', '\\\\?\\C:\\x', 'src/a.py', '', null, undefined]) {
      assert.equal(isNetworkPath(path), false, String(path));
    }
  });
});
