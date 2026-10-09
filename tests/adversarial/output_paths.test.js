/**
 * Cmd/Ctrl+click on a file or folder name in a terminal's output shows it in
 * the file manager (W12): which words are names, where they point, where on
 * screen they sit, and what the backend is asked.
 *
 * Three ways this feature is worse than not having it, and so what most of
 * these cases are about:
 *
 *   - a word offered that is not a name, or a name offered as the wrong one
 *     (`My` of `My Folder`, `backup` of `[backup]`), so a click shows
 *     something unrelated;
 *   - a name underlined a cell or two away from where it is drawn — what the
 *     old `translateToString` reading did after every wide character, Hangul
 *     included, for the `path:line` links too;
 *   - a path on another machine looked at, which on Windows signs in to it.
 *
 * Nothing here can say which words exist, so most cases ask `offered`: the
 * links chosen when the backend says the names given exist — every column of
 * the row among them where it matters, to show a column is never mistaken
 * for a name. The samples are real output: GNU coreutils `ls` as it prints on
 * a tty (names with spaces quoted), macOS `ls` captured on the build machine
 * (`@` for extended attributes, tabs between columns), `ls -F`, Windows `dir`
 * in English and in Korean, `find`, and `git status` captured from a
 * repository.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { linksAtRow, rowCells } from '../../src/lib/terminalLinks.js';
import {
  MAX_CANDIDATES,
  MAX_CANDIDATE_LENGTH,
  MAX_KIND_PATHS,
  chooseLinks,
  createKindLookup,
  decodeCQuoted,
  decodeShellQuoted,
  fromMsysPath,
  isRevealClick,
  isRevealModifier,
  pathCandidates,
  pathsAtRow,
  resolveOutputPath,
} from '../../src/lib/outputPaths.js';
import { activateGraphemeWidths } from '../../src/lib/terminalCompat.js';

const { Terminal: HeadlessTerminal } = headless;
const { UnicodeGraphemesAddon } = loadGraphemesAddonAsInBrowser();

/**
 * `@xterm/addon-unicode-graphemes` as the app's WebView runs it — the shipped
 * bundle with no `Buffer` in scope. unicode_widths.test.js says why: under
 * Node the addon reads its table from a shared pool and can measure emoji as
 * one cell.
 */
function loadGraphemesAddonAsInBrowser() {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('@xterm/addon-unicode-graphemes'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'Buffer', source)(mod, mod.exports, undefined);
  return mod.exports;
}

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

/** A headless xterm showing `lines`, measuring widths as the app does. */
async function screenOf(lines, { cols = 100 } = {}) {
  const term = new HeadlessTerminal({ cols, rows: lines.length + 2, allowProposedApi: true });
  assert.equal(activateGraphemeWidths(term, UnicodeGraphemesAddon), true, 'grapheme widths switched on');
  await write(term, `${lines.join('\r\n')}\r\n`);
  return term;
}

/** What is drawn in a single-row range's cells, as xterm reads them. */
function drawnIn(term, range) {
  assert.equal(range.start.y, range.end.y, 'one row');
  return term.buffer.active.getLine(range.start.y - 1).translateToString(true, range.start.x - 1, range.end.x);
}

/**
 * The names offered on `line` when exactly `existing` exist — names in the
 * tab's folder, or absolute paths — as `[name, as drawn]`, in order.
 */
function offered(line, existing, { os = 'macos', msys = false } = {}) {
  const cwd = os === 'windows' ? 'C:\\w' : '/w';
  const sep = os === 'windows' ? '\\' : '/';
  const absolute = (n) => n.startsWith('/') || /^[A-Za-z]:\\/.test(n);
  const kinds = new Map(existing.map((n) => [absolute(n) ? n : `${cwd}${sep}${n}`, 'dir']));
  const candidates = pathCandidates(line)
    .map((c) => ({ ...c, path: resolveOutputPath(c.text, { cwd, os, msys }) }))
    .filter((c) => c.path);
  return chooseLinks(candidates, kinds).map((c) => [c.text, c.drawn]);
}
const offeredNames = (...args) => offered(...args).map(([name]) => name);

/** Every candidate on `line` is drawn where it says. */
function assertOffsetsMatch(line) {
  for (const c of pathCandidates(line)) {
    assert.equal(line.slice(c.start, c.start + c.length), c.drawn, `${JSON.stringify(line)}: ${JSON.stringify(c)}`);
  }
}

/**
 * Every whitespace-separated token of `lines` — so every column — as if it
 * existed as a folder: a column offered then is a column mistaken for a
 * name.
 */
const everyToken = (lines) => [...new Set(lines.join(' ').split(/\s+/).filter(Boolean))];

// GNU coreutils 9 on a tty: a name with a space in it is quoted, and the
// other names get a space in front so the column still lines up.
const GNU_LS_L = [
  'total 24',
  "drwxr-xr-x 2 me me 4096 Oct  9 22:00 'My Folder'",
  '-rwxr-xr-x 1 me me    0 Oct  9 22:00  build.sh',
  "lrwxrwxrwx 1 me me    9 Oct  9 22:00 'my link' -> 'My Folder'",
  '-rw-r--r-- 1 me me 1234 Oct  9  2025  report.txt',
  '-rw-r--r--. 1 me me 512 Oct  9 22:00  selinux.conf',
  'lrwxrwxrwx 1 me me   10 Oct  9 22:00  rlink -> report.txt',
  "drwxr-xr-x 2 me me 4096 Oct  9 22:00 '새 폴더'",
];

// macOS 26 /bin/ls -l, captured: `@` after the mode for extended attributes,
// and `ls -lF` marking a link's name with `@` too.
const MAC_LS_L = [
  'total 0',
  'drwxr-xr-x@ 2 geekover  wheel  64 Oct  9 23:13 My Folder',
  '-rwxr-xr-x@ 1 geekover  wheel   0 Oct  9 23:13 build.sh',
  'lrwxr-xr-x@ 1 geekover  wheel   9 Oct  9 23:13 my link -> My Folder',
  'lrwxr-xr-x@ 1 geekover  wheel   9 Oct  9 23:13 my link@ -> My Folder',
  '-rw-r--r--@ 1 geekover  wheel   0 Oct  9 23:13 보고서.txt',
  'drwxr-xr-x@ 2 geekover  wheel  64 Oct  9 23:13 새 폴더/',
];

const DIR_EN = [
  ' Volume in drive C has no label.',
  ' Volume Serial Number is 1A2B-3C4D',
  '',
  ' Directory of C:\\Users\\me\\project',
  '',
  '10/09/2026  10:00 PM    <DIR>          .',
  '10/09/2026  10:00 PM    <DIR>          ..',
  '10/09/2026  10:00 PM    <DIR>          My Folder',
  '10/09/2026  09:58 PM             1,234 report.txt',
  '10/09/2026  09:58 PM    <JUNCTION>     Docs [C:\\Users\\me\\Documents]',
  '               1 File(s)          1,234 bytes',
  '               4 Dir(s)  100,000,000,000 bytes free',
];

const DIR_KO = [
  ' C 드라이브의 볼륨에는 이름이 없습니다.',
  ' 볼륨 일련 번호: 1A2B-3C4D',
  '',
  ' C:\\Users\\me\\project 디렉터리',
  '',
  '2026-10-09  오후 10:00    <DIR>          .',
  '2026-10-09  오후 10:00    <DIR>          ..',
  '2026-10-09  오후 10:00    <DIR>          새 폴더',
  '2026-10-09  오후 10:00    <DIR>          새 폴더 - 복사본',
  '2026-10-09  오후 10:00    <DIR>          10월',
  '2026-10-09  오후 09:58             1,234 보고서.txt',
  '               1개 파일               1,234 바이트',
  '               3개 디렉터리  100,000,000,000 바이트 남음',
];

describe('Output paths: the names offered in real output', () => {
  test('OP-01: GNU ls -l — the name column only, quoted names whole, both sides of an arrow', () => {
    // Every token exists as a folder — `me`, `4096`, `Oct`, `22:00`, `2025`
    // — and still only the names are offered.
    const existing = [...everyToken(GNU_LS_L), 'My Folder', 'my link', '새 폴더'];
    const rows = GNU_LS_L.map((line) => offeredNames(line, existing));
    assert.deepEqual(rows, [
      [],
      ['My Folder'],
      ['build.sh'],
      ['my link', 'My Folder'],
      ['report.txt'],
      ['selinux.conf'],
      ['rlink', 'report.txt'],
      ['새 폴더'],
    ]);
    // The quotes are not underlined.
    assert.deepEqual(offered(GNU_LS_L[1], existing).map(([, drawn]) => drawn), ['My Folder']);
    for (const line of GNU_LS_L) assertOffsetsMatch(line);
  });

  test('OP-02: macOS ls -l — the `@` of extended attributes and of `-F` is no part of anything', () => {
    const existing = [...everyToken(MAC_LS_L), 'My Folder', 'my link', '새 폴더'];
    assert.deepEqual(MAC_LS_L.map((line) => offeredNames(line, existing)), [
      [],
      ['My Folder'],
      ['build.sh'],
      ['my link', 'My Folder'],
      ['my link', 'My Folder'],
      ['보고서.txt'],
      ['새 폴더'],
    ]);
    for (const line of MAC_LS_L) assertOffsetsMatch(line);
  });

  test('OP-03: several columns — every name, never across a column gap of spaces or a tab', () => {
    const gnu = "'My Folder'   build.sh  'my link'   report.txt   rlink   src   보고서.txt  '새 폴더'";
    const existing = ['My', 'Folder', 'My Folder', 'build.sh', 'my link', 'report.txt', 'rlink', 'src', '보고서.txt', '새 폴더', 'build.sh  \'my link\''];
    assert.deepEqual(offeredNames(gnu, existing), ['My Folder', 'build.sh', 'my link', 'report.txt', 'rlink', 'src', '보고서.txt', '새 폴더']);
    // macOS 26 `ls -C`, captured: the columns are tabs.
    const bsd = 'My Folder\tmy link\t\trlink\t\t보고서.txt';
    assert.deepEqual(offeredNames(bsd, existing), ['My Folder', 'my link', 'rlink', '보고서.txt']);
    for (const line of [gnu, bsd]) {
      assertOffsetsMatch(line);
      for (const c of pathCandidates(line)) assert.ok(!/ {2}|\t/.test(c.drawn), `${JSON.stringify(c.drawn)} crosses a column gap`);
    }
    // Columns that look like data are names too, where they are a whole column.
    assert.deepEqual(offeredNames('2026-10-01  2026-10-02  42  4K  Oct', ['2026-10-01', '2026-10-02', '42', '4K', 'Oct']), [
      '2026-10-01',
      '2026-10-02',
      '42',
      '4K',
      'Oct',
    ]);
  });

  test('OP-04: ls -F — the marker after a name is not part of it, quoted or not; a name that ends in one is found as it is', () => {
    const line = "'My Folder'/   build.sh*  'my link'@   src/   fifo|  sock=  report.txt";
    const names = ['My Folder', 'build.sh', 'my link', 'src', 'fifo', 'sock', 'report.txt'];
    assert.deepEqual(offered(line, names), names.map((n) => [n, n]));
    assertOffsetsMatch(line);
    // A file really called `star*`, `x=` or `trail.`: as written.
    assert.deepEqual(offeredNames('star*  x=  trail.', ['star*', 'star', 'x=', 'trail.', 'trail']), ['star*', 'x=', 'trail.']);
    // The root alone is no name, and `./` is the folder `.`.
    assert.deepEqual(offeredNames('/', ['/']), []);
    assert.deepEqual(offeredNames('./', ['.']), ['.']);
  });

  test('OP-05: Windows dir, English — the folder it lists, its names, and nothing from the columns', () => {
    // Every column of the listing's rows exists; the header's words are words.
    // (`[C:\\…]` is no name a folder can have on Windows.)
    const existing = [...everyToken(DIR_EN.slice(5)).filter((t) => !t.startsWith('[')), 'My Folder', 'C:\\Users\\me\\project', 'C:\\Users\\me\\Documents'];
    const rows = DIR_EN.map((line) => offeredNames(line, existing, { os: 'windows' }));
    assert.deepEqual(rows[3], ['C:\\Users\\me\\project'], 'the folder listed');
    assert.deepEqual(rows.slice(5, 10), [['.'], ['..'], ['My Folder'], ['report.txt'], ['Docs', 'C:\\Users\\me\\Documents']]);
    for (const row of rows) {
      for (const column of ['10/09/2026', '10:00', 'PM', '<DIR>', '1,234', '<JUNCTION>']) assert.ok(!row.includes(column), column);
    }
    for (const line of DIR_EN) assertOffsetsMatch(line);
  });

  test('OP-06: Windows dir, Korean — 오후, <DIR> and the sizes are columns; 새 폴더 - 복사본 and 10월 are names', () => {
    const existing = [...everyToken(DIR_KO.slice(5)), '새 폴더', '새 폴더 - 복사본', 'C:\\Users\\me\\project'];
    const rows = DIR_KO.map((line) => offeredNames(line, existing, { os: 'windows' }));
    assert.ok(rows[3].includes('C:\\Users\\me\\project'), 'the folder listed, before 디렉터리');
    assert.deepEqual(rows.slice(5, 11), [['.'], ['..'], ['새 폴더'], ['새 폴더 - 복사본'], ['10월'], ['보고서.txt']]);
    for (const row of rows) for (const column of ['2026-10-09', '오후', '10:00', '<DIR>', '1,234']) assert.ok(!row.includes(column), column);
    for (const line of DIR_KO) assertOffsetsMatch(line);
  });

  test('OP-07: find — every path, ./ and all', () => {
    // Captured from a repository with a folder whose name has a space.
    const out = ['.', './새 파일.txt', './My Folder', './src', './My Folder/notes.txt', './src/lib', './src/lib/a.js'];
    const existing = ['.', '새 파일.txt', 'My Folder', 'src', 'My Folder/notes.txt', 'src/lib', 'src/lib/a.js'];
    assert.deepEqual(out.map((line) => offeredNames(line, existing)), [
      ['.'],
      ['./새 파일.txt'],
      ['./My Folder'],
      ['./src'],
      ['./My Folder/notes.txt'],
      ['./src/lib'],
      ['./src/lib/a.js'],
    ]);
  });

  test('OP-08: git status — the paths, git\'s quoting read, a Korean name decoded from its octal bytes', () => {
    // Captured: git 2 with a modified file, an untracked folder and a file
    // named 새 파일.txt, which git prints as its UTF-8 bytes in octal.
    const existing = ['src/lib/a.js', 'My Folder', '새 파일.txt'];
    assert.deepEqual(offeredNames('\tmodified:   src/lib/a.js', existing), ['src/lib/a.js']);
    assert.deepEqual(offeredNames('\tMy Folder/', existing), ['My Folder']);
    assert.deepEqual(offeredNames(' M src/lib/a.js', existing), ['src/lib/a.js']);
    assert.deepEqual(offeredNames('?? "My Folder/"', existing), ['My Folder']);
    const quoted = '\t"\\354\\203\\210 \\355\\214\\214\\354\\235\\274.txt"';
    assert.deepEqual(offered(quoted, existing), [['새 파일.txt', quoted.trim()]], 'underlined as printed, quotes and all');
    assert.equal(decodeCQuoted('"\\355\\225\\234.txt"'), '한.txt');
    assert.equal(decodeCQuoted('"tab\\there \\"q\\" back\\\\slash"'), 'tab\there "q" back\\slash');
    assert.equal(decodeCQuoted('"no escapes"'), null, 'nothing to decode: the quotes are trimmed elsewhere');
    assert.equal(decodeCQuoted('"\\377\\376"'), null, 'not UTF-8: no name');
  });

  test('OP-09: a name with spaces — any tokens, up to eight, one space apart', () => {
    const cases = [
      ['10/09/2026  10:00 PM    <DIR>          Program Files (x86)', 'Program Files (x86)'],
      ['10/09/2026  10:00 PM    <DIR>          Microsoft Visual Studio 2022 Preview', 'Microsoft Visual Studio 2022 Preview'],
      ['2026-10-09  오후 10:00    <DIR>          Tom & Jerry', 'Tom & Jerry'],
      ['2026-10-09  오후 10:00                 0 report - Copy.txt', 'report - Copy.txt'],
      ['2026-10-09  오후 10:00                 0 새 텍스트 문서 - 복사본.txt', '새 텍스트 문서 - 복사본.txt'],
      ['10/09/2026  10:00 PM    <DIR>          New folder - Copy', 'New folder - Copy'],
      ['2026-10-09  오후 10:00    <DIR>          📁 Projects', '📁 Projects'],
      ['2026-10-09  오후 10:00            12,345 10월 보고서.xlsx', '10월 보고서.xlsx'],
      ['a b c d e f g h', 'a b c d e f g h'],
    ];
    for (const [line, name] of cases) {
      // Its shorter parts exist too: the longest that exists wins.
      const parts = name.split(' ');
      const existing = [name, parts[0], parts[parts.length - 1], parts.slice(0, 2).join(' ')];
      assert.deepEqual(offeredNames(line, existing, { os: 'windows' }), [name], line);
    }
    assert.deepEqual(offeredNames('a b c d e f g h i', ['a b c d e f g h i']), [], 'not nine');
    assert.deepEqual(offeredNames('My  Folder', ['My  Folder']), [], 'never across two spaces');
    assert.deepEqual(offeredNames('My\tFolder', ['My\tFolder']), [], 'nor a tab');
  });

  test('OP-10: what is never a name — a column on its own, the arrow, the punctuation', () => {
    for (const word of ['drwxr-xr-x', '-rw-r--r--@', '<DIR>', '<JUNCTION>', '22:00', '10:00:01', '->', '|', '├──', '+0900', 'd----', '-a---', '-', '&']) {
      assert.deepEqual(offeredNames(word, [word]), [], JSON.stringify(word));
    }
    // `total N` is ls's count of blocks, whatever exists.
    assert.deepEqual(offeredNames('total 24', ['24', 'total 24', 'total']), []);
    assert.deepEqual(offeredNames('합계 48', ['48']), []);
    // Prose around a path: a sentence's full stop, brackets, backticks.
    assert.deepEqual(offeredNames('Created src/foo.js.', ['src/foo.js']), ['src/foo.js']);
    assert.deepEqual(offeredNames('(see src/bar.js)', ['src/bar.js']), ['src/bar.js']);
    assert.deepEqual(offeredNames('edit `docs/x.md` next', ['docs/x.md']), ['docs/x.md']);
    assert.deepEqual(offeredNames('ls -R: ./src:', ['src']), ['./src']);
    // A version is a folder name (`ls ~/.pyenv/versions`).
    assert.deepEqual(offeredNames('3.12.10  3.11.9  2.7.18', ['3.12.10', '3.11.9', '2.7.18']), ['3.12.10', '3.11.9', '2.7.18']);
  });
});

describe('Output paths: which of them are offered', () => {
  test('OP-11: the name as written first — `[backup]` is not the folder `backup`, Next.js\'s `[slug]` is found', () => {
    assert.deepEqual(offered('[backup]', ['[backup]', 'backup']), [['[backup]', '[backup]']]);
    assert.deepEqual(offered('[backup]', ['backup']), [['backup', 'backup']], 'and the name inside only when that is what exists');
    assert.deepEqual(offeredNames('app/blog/[slug]/page.tsx', ['app/blog/[slug]/page.tsx']), ['app/blog/[slug]/page.tsx']);
    assert.deepEqual(offeredNames('    10/09/2026  10:00 PM    <JUNCTION>     Docs [C:\\x]', ['C:\\x'], { os: 'windows' }), ['C:\\x']);
    // GNU's quoting of awkward names, read as the shell would read it.
    assert.deepEqual(offeredNames("-rw-r--r-- 1 me me    0 Oct  9 22:00 '[1]'", ['[1]', '1']), ['[1]']);
    assert.deepEqual(offeredNames("-rw-r--r-- 1 me me    0 Oct  9 22:00 'it'\\''s a.txt'", ["it's a.txt"]), ["it's a.txt"]);
    assert.deepEqual(offeredNames('-rw-r--r-- 1 me me    0 Oct  9 22:00 "it\'s a.txt"', ["it's a.txt"]), ["it's a.txt"]);
    assert.deepEqual(offeredNames("-rw-r--r-- 1 me me    0 Oct  9 22:00 'a'$'\\n''b'", ['a\nb']), ['a\nb']);
    assert.equal(decodeShellQuoted("'it'\\''s'"), "it's");
    assert.equal(decodeShellQuoted("$'\\303\\251t\\303\\251'"), 'été', 'octal bytes, read as UTF-8');
    assert.equal(decodeShellQuoted("'a' 'b'"), null, 'two names');
    assert.equal(decodeShellQuoted('plain'), null, 'nothing quoted');
    assert.equal(decodeShellQuoted("'open"), null);
  });

  test('OP-12: only what exists, and where two overlap the longer; paths tried in order', () => {
    const line = "drwxr-xr-x 2 me me 4096 Oct  9 22:00 'My Folder'";
    assert.deepEqual(offeredNames(line, ['My Folder', 'My']), ['My Folder'], '`My Folder` over `My`');
    assert.deepEqual(offeredNames(line, ['My', 'Folder']), ['My', 'Folder'], 'two that do not overlap');
    assert.deepEqual(offeredNames('ab cd ef', ['ab cd', 'cd ef']), ['ab cd'], 'the same length: the earlier');
    // A candidate with several places it may be: the first that exists.
    const kinds = new Map([['/listed/src', 'dir'], ['/root/src', 'dir']]);
    const [one] = chooseLinks([{ start: 0, length: 3, text: 'src', paths: ['/listed/src', '/root/src'] }], kinds);
    assert.equal(one.path, '/listed/src');
    const [other] = chooseLinks([{ start: 0, length: 3, text: 'src', paths: ['/gone/src', '/root/src'] }], kinds);
    assert.equal(other.path, '/root/src');
  });

  test('OP-13: a URL and a path:line stay the links they were', async () => {
    const term = await screenOf([
      'see https://example.com/docs/a.md and src/lib/a.js:12:3 next to src/lib/b.js',
      '  File "src/app.py", line 42',
    ]);
    const first = pathsAtRow(term.buffer.active, 1).map((c) => c.text);
    assert.ok(first.includes('src/lib/b.js'), 'a bare path is a candidate');
    for (const c of first) {
      assert.ok(!c.includes('example.com') && !c.includes('a.js'), `${c} overlaps a link that is already one`);
    }
    assert.ok(!pathsAtRow(term.buffer.active, 2).some((c) => c.text.includes('app.py')), 'a Python traceback is a link already');
    term.dispose();
  });

  test('OP-25: bounded — a row of many words, a word too long, a blob without a newline', async () => {
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    const term = await screenOf([words], { cols: 600 });
    const found = pathsAtRow(term.buffer.active, 1);
    assert.equal(found.length, MAX_CANDIDATES, 'no more than a row is asked about');
    // Those ending where their column does first: the name a listing prints last.
    assert.ok(found.some((c) => c.text.endsWith('w79')), 'the end of the column');
    term.dispose();

    assert.deepEqual(pathCandidates('x'.repeat(MAX_CANDIDATE_LENGTH + 1)), []);
    assert.deepEqual(pathCandidates('x'.repeat(MAX_CANDIDATE_LENGTH)).map((c) => c.text), ['x'.repeat(MAX_CANDIDATE_LENGTH)]);

    // A hover in the middle of a 200,000-character line, which is one token.
    const blob = Buffer.alloc(150000, 7).toString('base64');
    const big = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    await write(big, `${blob} src/after.ts\r\n`);
    const buffer = big.buffer.active;
    let last = buffer.length;
    while (last > 1 && !buffer.getLine(last - 1).translateToString(true)) last -= 1;
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      assert.deepEqual(pathsAtRow(buffer, Math.floor(last / 2)), []);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 10, `${best.toFixed(1)} ms for a hover in the middle of the blob`);
    assert.deepEqual(pathsAtRow(buffer, last).map((c) => c.text), ['src/after.ts'], 'and the name after it, on the last row');
    big.dispose();

    // As many words as a line can hold, and the shapes that cost most to
    // trim — a bracket counted for every one dropped was 8 ms a hover.
    for (const unit of ['a ', '한 ', '(x) ', "'a' ", 'a.b:1 ', '(', ')', "'"]) {
      const dense = new HeadlessTerminal({ cols: 120, rows: 24, scrollback: 5000, allowProposedApi: true });
      await write(dense, `${unit.repeat(Math.ceil(100000 / unit.length))}\r\n`);
      const rows = dense.buffer.active;
      let fastest = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now();
        pathsAtRow(rows, Math.floor(rows.length / 2));
        fastest = Math.min(fastest, performance.now() - t0);
      }
      assert.ok(fastest < 10, `${JSON.stringify(unit)} repeated: ${fastest.toFixed(1)} ms for a hover`);
      dense.dispose();
    }
  });
});

describe('Output paths: where a name points', () => {
  test('OP-14: relative against the tab\'s directory, absolute as it is, ~ at home', () => {
    const mac = { cwd: '/Users/me/proj', os: 'macos', home: '/Users/me' };
    assert.equal(resolveOutputPath('My Folder', mac), '/Users/me/proj/My Folder');
    assert.equal(resolveOutputPath('./src', mac), '/Users/me/proj/src');
    assert.equal(resolveOutputPath('..', mac), '/Users/me/proj/..');
    assert.equal(resolveOutputPath('/etc/hosts', mac), '/etc/hosts');
    assert.equal(resolveOutputPath('~', mac), '/Users/me');
    assert.equal(resolveOutputPath('~/Downloads/a.zip', mac), '/Users/me/Downloads/a.zip');
    assert.equal(resolveOutputPath('src', { ...mac, cwd: null }), null, 'nothing to resolve against');
    assert.equal(resolveOutputPath('C:\\x', mac), null, 'not a path on this machine at all');

    const win = { cwd: 'C:\\Users\\me\\proj', os: 'windows', home: 'C:\\Users\\me' };
    assert.equal(resolveOutputPath('새 폴더', win), 'C:\\Users\\me\\proj\\새 폴더');
    assert.equal(resolveOutputPath('C:\\Users\\me\\Documents', win), 'C:\\Users\\me\\Documents');
    assert.equal(resolveOutputPath('~\\Desktop', win), 'C:\\Users\\me\\Desktop');
    assert.equal(resolveOutputPath('\\\\?\\C:\\work', win), 'C:\\work', 'the verbatim spelling of a drive is local');
    assert.equal(resolveOutputPath('\\work', win), null, 'rooted on no drive in particular: the backend would not look');
  });

  test('OP-15: /c/… and /cygdrive/c/… are C:\\… only in a Git Bash or Cygwin tab, and a bare /c never', () => {
    assert.equal(fromMsysPath('/c/Users/me'), 'C:\\Users\\me');
    assert.equal(fromMsysPath('/c'), 'C:\\', 'a directory a shell reports: the drive');
    assert.equal(fromMsysPath('/c', { bare: false }), '/c', 'a word in the output: a switch, more often');
    assert.equal(fromMsysPath('/d/', { bare: false }), '/d/');
    assert.equal(fromMsysPath('/cygdrive/c/work/a.txt'), 'C:\\work\\a.txt');
    for (const other of ['/cache/x', '/usr/bin', '/mnt/c/x', 'c/x', '//c/x']) assert.equal(fromMsysPath(other), other, other);

    // Git Bash reports its cwd as /c/Users/me (OSC 7, kept as it came).
    const gitBash = { cwd: '/c/Users/me/proj', os: 'windows', home: 'C:\\Users\\me', msys: true };
    assert.equal(resolveOutputPath('src', gitBash), 'C:\\Users\\me\\proj\\src');
    assert.equal(resolveOutputPath('src', { ...gitBash, cwd: '/c' }), 'C:\\src', 'the drive itself, as a directory');
    assert.equal(resolveOutputPath('/c/Users/me/notes.txt', gitBash), 'C:\\Users\\me\\notes.txt');
    assert.equal(resolveOutputPath('/cygdrive/d/data', gitBash), 'D:\\data');
    assert.equal(resolveOutputPath('/c', gitBash), null, 'a bare /c is no name');
    assert.equal(resolveOutputPath('/usr/bin', gitBash), null, 'inside Git Bash\'s own install, which only it knows');
    // In cmd or PowerShell `/s` is a switch and `/c/x` no path at all.
    const cmd = { cwd: 'C:\\Users\\me', os: 'windows', home: 'C:\\Users\\me' };
    assert.equal(resolveOutputPath('/c/Users/me/notes.txt', cmd), null);
    for (const line of ['C:\\Users\\me>xcopy src dst /s /e /h /d', 'C:\\Users\\me>cmd /c build.bat']) {
      for (const tab of [cmd, gitBash]) {
        const paths = pathCandidates(line).map((c) => resolveOutputPath(c.text, tab)).filter(Boolean);
        for (const path of paths) assert.ok(!/^[A-Za-z]:\\$/.test(path), `${line} in ${tab.msys ? 'Git Bash' : 'cmd'}: ${path}, a drive`);
      }
    }
    // Not on macOS or Linux, where /c is a folder like any other.
    assert.equal(resolveOutputPath('/c/x', { cwd: '/w', os: 'macos', msys: true }), '/c/x');
    assert.equal(resolveOutputPath('src', { cwd: '/c/proj', os: 'linux' }), '/c/proj/src');
  });

  test('OP-16: never a path on another machine — from the name, or from the directory', () => {
    const win = { cwd: 'C:\\proj', os: 'windows' };
    for (const name of ['\\\\host\\share\\x', '//host/share/x', '\\\\?\\UNC\\host\\share', '\\??\\UNC\\host\\share', '\\\\.\\pipe\\p', '//c/x']) {
      assert.equal(resolveOutputPath(name, win), null, name);
      assert.equal(resolveOutputPath(name, { cwd: '/w', os: 'macos' }), null, `${name} on macOS`);
    }
    for (const cwd of ['\\\\host\\share\\proj', '//host/share/proj', '\\\\?\\UNC\\host\\share']) {
      assert.equal(resolveOutputPath('src', { cwd, os: 'windows' }), null, cwd);
    }
    // A dir listing of a share: the share's path is found and refused by
    // resolving, and what else resolves is inside the tab's own folder.
    const line = ' Directory of \\\\host\\share\\proj';
    assert.ok(pathCandidates(line).some((c) => c.text === '\\\\host\\share\\proj'));
    assert.equal(resolveOutputPath('\\\\host\\share\\proj', win), null);
    for (const c of pathCandidates(line)) {
      const resolved = resolveOutputPath(c.text, win);
      assert.ok(resolved === null || resolved.startsWith('C:\\proj\\'), `${c.text} -> ${resolved}`);
    }
  });
});

describe('Output paths: where on screen, counted in cells', () => {
  test('OP-17: Hangul and emoji before a name — the name is underlined where it is drawn', async () => {
    const lines = [
      '2026-10-09  오후 10:00    <DIR>          새 폴더',
      '📁 👨\u{200D}💻 \u{E9} 보고서.txt',
      '수정함: src/lib/a.js 와 My Folder',
    ];
    const term = await screenOf(lines);
    for (let row = 1; row <= lines.length; row += 1) {
      for (const c of pathsAtRow(term.buffer.active, row)) {
        assert.equal(drawnIn(term, c.range), c.drawn, `row ${row}: ${c.drawn} at ${JSON.stringify(c.range)}`);
      }
      // The text is read cell by cell and still says what xterm says.
      const line = term.buffer.active.getLine(row - 1);
      assert.equal(rowCells(line).text, line.translateToString(false));
    }
    // The last character of 새 폴더 is wide: both of its cells are covered.
    const folder = pathsAtRow(term.buffer.active, 1).find((c) => c.text === '새 폴더');
    assert.equal(folder.range.end.x - folder.range.start.x + 1, 7, '새 폴더 is seven cells');
    const report = pathsAtRow(term.buffer.active, 2).find((c) => c.text === '보고서.txt');
    // 📁 is two cells, the man-technologist emoji (a ZWJ sequence) one cluster of two, é one, and three spaces: 보고서.txt
    // starts at cell 9 — at string offset 11, which the old reading would have used.
    assert.equal(report.range.start.x, 9);
    assert.equal(report.range.end.x, 9 + 3 * 2 + 4 - 1, '보고서 six cells, .txt four');
    term.dispose();
  });

  test('OP-18: rowCells — a wide character is one character over two cells, a cluster one cell group', async () => {
    const term = await screenOf(['가a👍🏽b']);
    const { text, cells } = rowCells(term.buffer.active.getLine(0));
    assert.equal(text.slice(0, 7), '가a👍🏽b');
    // 가 at 0 (two cells), a at 2, the four code units of 👍🏽 at 3, b at 5.
    assert.deepEqual(cells.slice(0, 8), [0, 2, 3, 3, 3, 3, 5, 6]);
    assert.equal(cells[text.length], term.buffer.active.getLine(0).length, 'the column after the last cell read');
    term.dispose();
  });

  test('OP-19: the old bug — a path:line after Korean text was linked a cell left per Hangul character', async () => {
    // `translateToString` gives 오후 as two characters over four cells, and the
    // link was placed by string offset: two cells early, its tail cut off.
    const lines = ['2026-10-09  오후 10:00  src\\main.rs:10', '수정함: src/lib/terminalLinks.js:42 완료'];
    const term = await screenOf(lines);
    const [first] = linksAtRow(term.buffer.active, 1);
    assert.equal(drawnIn(term, first.range), 'src\\main.rs:10');
    assert.deepEqual(first.range.start, { x: 25, y: 1 }, 'string offset 22 is cell 24 (0-based), after the two wide 오후');
    const [second] = linksAtRow(term.buffer.active, 2);
    assert.equal(drawnIn(term, second.range), 'src/lib/terminalLinks.js:42');
    term.dispose();

    // Across the edge of two rows, wide characters on both.
    const wrapped = new HeadlessTerminal({ cols: 20, rows: 6, allowProposedApi: true });
    activateGraphemeWidths(wrapped, UnicodeGraphemesAddon);
    await write(wrapped, '한글한글한글 src/components/a.js:7 끝\r\n');
    const buffer = wrapped.buffer.active;
    assert.ok(buffer.getLine(1).isWrapped);
    for (const row of [1, 2]) {
      const [link] = linksAtRow(buffer, row);
      assert.equal(link.path, 'src/components/a.js', `from row ${row}`);
      // 한글한글한글 is twelve cells, the space one: the path starts at cell 14,
      // seven of its 21 characters on the first row and fourteen on the next.
      assert.deepEqual(link.range.start, { x: 14, y: 1 });
      assert.deepEqual(link.range.end, { x: 14, y: 2 });
    }
    wrapped.dispose();
  });
});

describe('Output paths: a wide character at the edge of a row', () => {
  test('OP-26: the empty cell a wide character leaves when it wraps is no space in a name', async () => {
    // Found in review: `ab보고서.txt` in five columns read `ab보 고서.txt` —
    // 고 did not fit in the last cell, went to the next row, and the empty
    // cell it left was read as a space.
    for (const cols of [5, 6, 7, 11]) {
      const term = new HeadlessTerminal({ cols, rows: 6, allowProposedApi: true });
      activateGraphemeWidths(term, UnicodeGraphemesAddon);
      await write(term, 'ab보고서.txt\r\n');
      const buffer = term.buffer.active;
      for (let row = 1; buffer.getLine(row - 1)?.translateToString(true); row += 1) {
        const names = pathsAtRow(buffer, row).map((c) => c.text);
        assert.ok(names.includes('ab보고서.txt'), `${cols} columns, row ${row}: ${JSON.stringify(names)}`);
        assert.ok(!names.some((n) => n.includes(' ')), `${cols} columns, row ${row}: a space read into ${JSON.stringify(names)}`);
      }
      term.dispose();
    }
    // A real space at the edge stays one.
    const spaced = new HeadlessTerminal({ cols: 4, rows: 4, allowProposedApi: true });
    activateGraphemeWidths(spaced, UnicodeGraphemesAddon);
    await write(spaced, 'ab 보고서\r\n');
    assert.ok(pathsAtRow(spaced.buffer.active, 1).some((c) => c.text === 'ab 보고서'), 'two words, one space');
    spaced.dispose();
    // And a path:line link across such an edge is placed by cell.
    const linked = new HeadlessTerminal({ cols: 11, rows: 6, allowProposedApi: true });
    activateGraphemeWidths(linked, UnicodeGraphemesAddon);
    await write(linked, '한글 src/a.js:3\r\n');
    const [link] = linksAtRow(linked.buffer.active, 1);
    assert.equal(link.path, 'src/a.js');
    linked.dispose();
  });
});

describe('Output paths: the modifier', () => {
  test('OP-20: ⌘ on macOS, Ctrl elsewhere — never with Alt or Shift, never the other platform\'s key', () => {
    const e = (mods) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, button: 0, ...mods });
    assert.equal(isRevealModifier(e({ metaKey: true }), 'macos'), true);
    assert.equal(isRevealModifier(e({ ctrlKey: true }), 'macos'), false, 'a Ctrl-click is a right-click on macOS');
    assert.equal(isRevealModifier(e({ metaKey: true, ctrlKey: true }), 'macos'), false);
    for (const os of ['windows', 'linux']) {
      assert.equal(isRevealModifier(e({ ctrlKey: true }), os), true, os);
      assert.equal(isRevealModifier(e({ metaKey: true }), os), false, `${os}: the Windows key`);
      assert.equal(isRevealModifier(e({ ctrlKey: true, altKey: true }), os), false, `${os}: AltGr arrives as Ctrl+Alt`);
    }
    for (const os of ['macos', 'windows']) {
      const mod = os === 'macos' ? { metaKey: true } : { ctrlKey: true };
      assert.equal(isRevealModifier(e({ ...mod, shiftKey: true }), os), false, `${os}: Shift selects`);
      assert.equal(isRevealModifier(e({ ...mod, altKey: true }), os), false, `${os}: Alt selects columns`);
      assert.equal(isRevealModifier(e({}), os), false);
      assert.equal(isRevealClick(e(mod), os), true);
      assert.equal(isRevealClick(e({ ...mod, button: 2 }), os), false, 'xterm activates on the release of any button');
      assert.equal(isRevealClick(e({ ...mod, button: 1 }), os), false);
    }
    assert.equal(isRevealModifier(null, 'macos'), false);
    assert.equal(isRevealClick(undefined, 'windows'), false);
  });
});

describe('Output paths: asking the backend as little as possible', () => {
  /** A backend that knows `fs`, counting what it is asked. */
  function backend(fs) {
    const calls = [];
    let release = null;
    const ask = async (paths) => {
      calls.push([...paths]);
      if (release) await release;
      return paths.map((p) => fs[p] ?? null);
    };
    return {
      calls,
      ask,
      hold() {
        let open;
        release = new Promise((resolve) => {
          open = resolve;
        });
        return () => {
          release = null;
          open();
        };
      },
    };
  }

  test('OP-21: one call for a row, answered from memory after it, asked again once stale', async () => {
    let now = 0;
    const b = backend({ '/w/a': 'file', '/w/b': 'dir' });
    const kinds = createKindLookup({ ask: b.ask, ttlMs: 5000, now: () => now });
    assert.equal(kinds.known(['/w/a', '/w/b', '/w/c']), null, 'nothing known yet');
    const found = await kinds.kinds(['/w/a', '/w/b', '/w/c', '/w/a']);
    assert.deepEqual([...found], [['/w/a', 'file'], ['/w/b', 'dir'], ['/w/c', null]]);
    assert.deepEqual(b.calls, [['/w/a', '/w/b', '/w/c']], 'one call, each path once');
    assert.deepEqual([...kinds.known(['/w/c', '/w/a'])], [['/w/c', null], ['/w/a', 'file']], 'known at once, a missing one too');
    now = 5001;
    assert.equal(kinds.known(['/w/a']), null, 'stale');
    await kinds.kinds(['/w/a']);
    assert.equal(b.calls.length, 2);
  });

  test('OP-22: a path being asked about is waited for, not asked again', async () => {
    const b = backend({ '/w/a': 'dir' });
    const kinds = createKindLookup({ ask: b.ask });
    const open = b.hold();
    const first = kinds.kinds(['/w/a', '/w/b']);
    const second = kinds.kinds(['/w/a', '/w/c']);
    open();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.get('/w/a'), 'dir');
    assert.equal(two.get('/w/a'), 'dir');
    assert.deepEqual(b.calls, [['/w/a', '/w/b'], ['/w/c']], '/w/a asked once');
  });

  test('OP-23: bounded — calls of at most MAX_KIND_PATHS, memory of at most maxEntries', async () => {
    const b = backend({});
    const kinds = createKindLookup({ ask: b.ask, maxEntries: 100 });
    const paths = Array.from({ length: 150 }, (_, i) => `/w/${i}`);
    await kinds.kinds(paths);
    assert.deepEqual(b.calls.map((c) => c.length), [MAX_KIND_PATHS, MAX_KIND_PATHS, 150 - 2 * MAX_KIND_PATHS]);
    assert.equal(kinds.known(paths.slice(-100)) !== null, true, 'the newest hundred are kept');
    assert.equal(kinds.known(paths.slice(0, 1)), null, 'the oldest went first');
  });

  test('OP-24: a failed or malformed answer is null for now and remembered for nothing', async () => {
    let fail = true;
    const kinds = createKindLookup({
      ask: async (paths) => {
        if (fail) throw new Error('backend refused');
        return paths.map(() => 'file');
      },
    });
    assert.deepEqual([...(await kinds.kinds(['/w/a']))], [['/w/a', null]]);
    assert.equal(kinds.known(['/w/a']), null, 'not remembered');
    fail = false;
    assert.deepEqual([...(await kinds.kinds(['/w/a']))], [['/w/a', 'file']]);

    const odd = createKindLookup({ ask: async () => ['file'] });
    assert.deepEqual([...(await odd.kinds(['/w/a', '/w/b']))], [['/w/a', null], ['/w/b', null]], 'an answer of the wrong length');
    assert.equal(odd.known(['/w/a']), null);
    const weird = createKindLookup({ ask: async () => ['symlink'] });
    assert.deepEqual([...(await weird.kinds(['/w/a']))], [['/w/a', null]], 'only file and dir are kinds');
  });
});
