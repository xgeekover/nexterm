/**
 * Saved scrollback (stage 6): what src/lib/scrollbackSnapshot.js writes to a
 * file, what it lets back out of one, and what it hides on the way in.
 *
 * Real terminals throughout: `@xterm/headless` with the grapheme widths the
 * app uses, so a round trip is checked cell by cell — characters, widths and
 * attributes — rather than as text. A file is written to a real temporary
 * folder and read back before it is parsed.
 *
 * The restore filter is checked against what a terminal DOES with the
 * dangerous sequences (a reply to the shell, a clipboard write, a title),
 * and each such check also runs the same bytes unfiltered to show that the
 * terminal would have acted — a filter test that passes because nothing was
 * dangerous in the first place proves nothing.
 *
 * Masking sentinels sit where a rule is most likely to miss them: right after
 * an SGR, with a colour change inside the token, across a soft wrap, after an
 * escaped `\n` in JSON, after `%3D`, and at the line where the size cap cuts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  HIDDEN,
  MAX_FILE_BYTES,
  SNAPSHOT_MAGIC,
  encodeLine,
  maskLines,
  maskStats,
  parseSnapshot,
  readLogicalLines,
  restoreText,
  sanitizeForRestore,
  separatorLine,
  snapshotTerminal,
  utf8Length,
} from '../../src/lib/scrollbackSnapshot.js';
import { activateGraphemeWidths } from '../../src/lib/terminalCompat.js';

const { Terminal } = headless;
const { UnicodeGraphemesAddon } = loadGraphemesAddonAsInBrowser();

/** As output_paths.test.js loads it: the shipped bundle with no `Buffer` in scope (unicode_widths.test.js says why). */
function loadGraphemesAddonAsInBrowser() {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('@xterm/addon-unicode-graphemes'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'Buffer', source)(mod, mod.exports, undefined);
  return mod.exports;
}

/**
 * Secret fixtures are written with a `·` inside the word a secret scanner
 * keys on (`cu·rl`, `PASS·WORD`, `hv·s.`) and joined back by `fx`: the
 * repository is public, and GitGuardian and GitHub's push protection take
 * these fakes for leaked credentials (21 of them on PR #61). The tests get
 * exactly the strings written, minus the dots.
 */
const fx = (text) => text.replace(/\u{b7}/gu, '');
const fxCases = (cases) => cases.map(([output, bodies]) => [fx(output), bodies.map(fx)]);

const TAB = 'tab-term-7';
const NOW = Date.UTC(2026, 10, 6, 10, 42);

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

function terminal({ cols = 40, rows = 10, scrollback = 1000 } = {}) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  assert.equal(activateGraphemeWidths(term, UnicodeGraphemesAddon), true, 'grapheme widths on');
  return term;
}

/** Every attribute the public API shows, as one string, for comparing cells. */
function attrs(cell) {
  return [
    cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isBlink(), cell.isInverse(),
    cell.isInvisible(), cell.isStrikethrough(), cell.isOverline(),
    cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
  ].join(',');
}

/** Rows `[from, to)` of the normal buffer, cell by cell, with each row's wrap flag. Trailing blank cells left out. */
function cells(term, from, to) {
  const buffer = term.buffer.normal;
  const out = [];
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y);
    const row = [];
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      row.push(`${c.getChars()}|${c.getWidth()}|${c.getChars() === '' ? '' : attrs(c)}`);
    }
    while (row.length && /^\|1\|$/.test(row[row.length - 1])) row.pop();
    out.push(`${line.isWrapped ? 'W' : '-'} ${row.join(' ')}`);
  }
  return out;
}

const plainLines = (term) => readLogicalLines(term).map((l) => l.runs.map((r) => r.text).join(''));

/** Snapshot → a real file → read back → parsed. */
function throughAFile(term, options = {}) {
  const snap = snapshotTerminal(term, { tabId: TAB, now: NOW, ...options });
  assert.ok(snap, 'something to save');
  const dir = mkdtempSync(join(tmpdir(), 'nexterm-scrollback-'));
  try {
    const file = join(dir, `${TAB}.scrollback`);
    writeFileSync(file, snap.text, 'utf8');
    const back = readFileSync(file, 'utf8');
    assert.equal(back, snap.text, 'the file holds what was written');
    return { snap, parsed: parseSnapshot(back, { tabId: TAB, now: NOW + 1000 }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fake secrets of the right shape — the rules must actually match these.
const GHP = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const GHP_BODY = GHP.slice(4);
const SK = `sk-${'q9W8e7R6t5Y4u3I2o1P0'.repeat(2)}`;
const SK_BODY = SK.slice(3);
const AKIA = 'AKIAZ7Q3XW8RT2LMNB6K';
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'}`;

const RICH = [
  'plain ascii line',
  '\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m \x1b[5mblink\x1b[0m',
  '\x1b[7minverse\x1b[0m \x1b[8mhidden\x1b[0m \x1b[9mstrike\x1b[0m \x1b[53mover\x1b[0m',
  '\x1b[31mred\x1b[0m \x1b[92mbright\x1b[0m \x1b[38;5;208m208\x1b[0m \x1b[48;5;17mbg17\x1b[0m',
  '\x1b[38;2;255;128;0mrgb\x1b[48;2;1;2;3m both\x1b[0m',
  '한글 텍스트 줄 \x1b[32m초록\x1b[0m',
  'emoji 😀 family 👨\u{200d}👩\u{200d}👧 heart ❤\u{fe0f} flag 🇰🇷',
  '',
  'after an empty line',
  // A long line, wrapped at 40 — with a wide character landing at the wrap.
  `${'w'.repeat(39)}한${'z'.repeat(30)}`,
  // A space exactly at the wrap.
  `${'a'.repeat(39)} ${'b'.repeat(10)}`,
];

describe('Scrollback: saved and restored as it was', () => {
  test('SB-01: a round trip through a real file gives the same cells — characters, widths, colours, styles, wraps', async () => {
    const source = terminal();
    await write(source, `${RICH.join('\r\n')}\r\n`);
    const { snap, parsed } = throughAFile(source);
    assert.ok(snap.text.startsWith(`${SNAPSHOT_MAGIC}\n`), 'format line first');
    assert.ok(parsed, 'parsed back');

    const restored = terminal();
    await write(restored, `${parsed.content}\x1b[0m\r\n`);
    const rows = source.buffer.normal.baseY + source.buffer.normal.cursorY;
    assert.ok(rows > RICH.length, 'the long lines wrapped');
    assert.deepEqual(cells(restored, 0, rows), cells(source, 0, rows));
  });

  test('SB-02: lines are kept whole, so a restore at another width wraps them there and reflows later', async () => {
    const source = terminal({ cols: 40 });
    await write(source, `${RICH.join('\r\n')}\r\n`);
    const { parsed } = throughAFile(source);
    const narrow = terminal({ cols: 23 });
    await write(narrow, `${parsed.content}\r\n`);
    assert.deepEqual(plainLines(narrow), plainLines(source), 'the same logical lines at 23 columns');
    narrow.resize(70, 10);
    assert.deepEqual(plainLines(narrow), plainLines(source), 'and after growing to 70');
  });

  test('SB-03: the cell left empty before a wide character that wrapped is not saved as a space', async () => {
    const source = terminal({ cols: 10 });
    await write(source, `${'x'.repeat(9)}한글\r\n`);
    assert.equal(source.buffer.normal.getLine(1).isWrapped, true, 'the wide character went to the next row');
    assert.deepEqual(plainLines(source), [`${'x'.repeat(9)}한글`]);
  });

  test('SB-04: a space at the wrap is a space between two words, and is kept', async () => {
    const source = terminal({ cols: 10 });
    await write(source, `${'a'.repeat(9)} next\r\n`);
    assert.deepEqual(plainLines(source), [`${'a'.repeat(9)} next`]);
  });

  test('SB-05: only the normal buffer is saved — not what a full-screen program shows', async () => {
    const source = terminal();
    await write(source, 'shell output before\r\n$ opencode\r\n');
    await write(source, '\x1b[?1049h\x1b[HALTERNATE SCREEN CONTENT\r\nmore tui');
    assert.equal(source.buffer.active.type, 'alternate');
    const snap = snapshotTerminal(source, { tabId: TAB, now: NOW });
    assert.ok(snap.text.includes('shell output before'));
    assert.ok(!snap.text.includes('ALTERNATE'), 'nothing of the alternate screen');
  });

  test('SB-06: blank lines at the start and end are dropped, and a blank buffer saves nothing', async () => {
    const source = terminal();
    await write(source, '\r\n\r\n\r\nmiddle one\r\n\r\nmiddle two\r\n\r\n\r\n');
    assert.deepEqual(plainLines(source), ['middle one', '', 'middle two']);
    const blank = terminal();
    await write(blank, '\r\n   \r\n');
    assert.equal(snapshotTerminal(blank, { tabId: TAB, now: NOW }), null, 'null means: delete the file');
    await write(source, '\x1b[H\x1b[2J\x1b[3J');
    assert.equal(snapshotTerminal(source, { tabId: TAB, now: NOW }), null, 'a cleared terminal does not come back');
  });

  test('SB-07: CR LF in the output and a restored terminal saved again keep their lines; separators pile up as text', async () => {
    const first = terminal();
    await write(first, 'one\r\ntwo\r\n');
    const { parsed } = throughAFile(first);
    const second = terminal();
    await write(second, restoreText(parsed, { locale: 'en-US' }));
    await write(second, 'three\r\n');
    const again = parseSnapshot(snapshotTerminal(second, { tabId: TAB, now: NOW + 5000 }).text, { tabId: TAB, now: NOW + 9000 });
    const lines = again.content.split('\r\n').map((l) => l.replace(/\x1b\[[0-9;:]*m/g, ''));
    assert.equal(lines[0], 'one');
    assert.equal(lines[1], 'two');
    assert.ok(lines[2].includes('Previous output'), 'the first separator, as text');
    assert.equal(lines[3], 'three');
  });

  test('SB-08: the file never exceeds MAX_FILE_BYTES, header included, however much the terminal holds', async () => {
    const source = terminal({ cols: 200, rows: 5, scrollback: 30_000 });
    const line = `\x1b[38;2;1;2;3m${'한'.repeat(90)}\x1b[0m\r\n`;
    await write(source, line.repeat(30_000));
    const snap = snapshotTerminal(source, { tabId: TAB, now: NOW });
    assert.ok(snap.bytes <= MAX_FILE_BYTES, `${snap.bytes} bytes`);
    assert.equal(snap.bytes, new TextEncoder().encode(snap.text).length, 'bytes counted as UTF-8');
    assert.ok(snap.lines < 30_000, 'the oldest lines went');
  });

  test('SB-10: a save reads only what can be in the file, not the whole scrollback — and saves the same', async () => {
    const term = terminal({ cols: 80, rows: 10, scrollback: 30_000 });
    let out = '';
    for (let i = 0; i < 30_000; i++) out += `\x1b[32mline\x1b[0m ${i} some log text here\r\n`;
    await write(term, out);
    const buffer = term.buffer.normal;
    const getLine = buffer.getLine.bind(buffer);
    let visits = 0;
    buffer.getLine = (y) => {
      visits += 1;
      return getLine(y);
    };
    try {
      const snap = snapshotTerminal(term, { tabId: TAB, now: NOW, maxBytes: 64 * 1024 });
      assert.ok(snap.bytes <= 64 * 1024);
      // Reading all of it visits every row twice (60 000); the budget is about 2 200 rows.
      assert.ok(visits < 12_000, `rows read: ${visits} of ${buffer.length}`);
      // The same lines as reading everything and cutting would give.
      const all = readLogicalLines(term).map(encodeLine);
      const kept = parseSnapshot(snap.text, { tabId: TAB, now: NOW }).content.split('\r\n');
      assert.deepEqual(kept, all.slice(all.length - kept.length));
    } finally {
      buffer.getLine = getLine;
    }
  });

  test('SB-11: the read is bounded by what the lines cost in the file — a colour per cell costs more than its text', async () => {
    const term = terminal({ cols: 80, rows: 10, scrollback: 20_000 });
    let out = '';
    for (let i = 0; i < 20_000; i++) {
      for (let x = 0; x < 40; x++) out += `\x1b[38;2;${x};${i % 256};9m#`;
      out += '\x1b[0m\r\n';
    }
    await write(term, out);
    const buffer = term.buffer.normal;
    const getLine = buffer.getLine.bind(buffer);
    let visits = 0;
    buffer.getLine = (y) => {
      visits += 1;
      return getLine(y);
    };
    try {
      const snap = snapshotTerminal(term, { tabId: TAB, now: NOW, maxBytes: 64 * 1024 });
      assert.ok(snap.bytes <= 64 * 1024);
      // About 64 KB / 800 bytes a line = 80 lines; row text alone would have read 1 600.
      assert.ok(visits < 1500, `rows read: ${visits}`);
    } finally {
      buffer.getLine = getLine;
    }
  });

  test('SB-12: the line above the first one kept is read for masking — the rest of a token the margin cut there is hidden', async () => {
    const cols = 80;
    const head = `${'y'.repeat(cols - 18)}sk-ant-api03-Xq9Zk`;
    const term = terminal({ cols, rows: 6 });
    await write(term, `${head}\r\nAbCdEfGhIjKlMnOpQrStUvWxYz0123456789 then run it\r\n`);
    const snap = snapshotTerminal(term, { tabId: TAB, now: NOW, maxLines: 1 });
    assert.ok(!snap.text.includes('sk-ant'), 'the cut line is not in the file');
    assert.ok(!snap.text.includes('AbCdEfGhIjKlMnOpQrSt'), 'and the rest of its token is hidden');
    assert.ok(snap.text.includes(' then run it'));
  });

  test('SB-09: utf8Length agrees with TextEncoder, lone surrogates included', () => {
    for (const s of ['', 'abc', 'é', '한글', '😀', '👨\u{200d}👩', 'a\u{d800}b', '\u{dfff}', 'x\u{d83d}']) {
      assert.equal(utf8Length(s), new TextEncoder().encode(s).length, JSON.stringify(s));
    }
  });
});

describe('Scrollback: the caps keep the newest lines', () => {
  test('SC-01: maxLines keeps the newest lines and drops the oldest', async () => {
    const source = terminal();
    for (let i = 0; i < 50; i++) await write(source, `line ${i}\r\n`);
    const parsed = parseSnapshot(snapshotTerminal(source, { tabId: TAB, now: NOW, maxLines: 10 }).text, { tabId: TAB, now: NOW });
    assert.deepEqual(parsed.content.split('\r\n'), Array.from({ length: 10 }, (_, i) => `line ${40 + i}`));
  });

  test('SC-02: the byte cap drops whole lines from the top — a line too big alone ends the file there', async () => {
    const source = terminal({ cols: 80 });
    await write(source, `old ${'o'.repeat(3000)}\r\nnew one\r\nnew two\r\n`);
    const snap = snapshotTerminal(source, { tabId: TAB, now: NOW, maxBytes: 600 });
    const parsed = parseSnapshot(snap.text, { tabId: TAB, now: NOW });
    assert.deepEqual(parsed.content.split('\r\n'), ['new one', 'new two']);
    assert.ok(snap.bytes <= 600);
  });

  test('SC-03: parseSnapshot keeps only the newest maxLines (the setting may have been lowered since)', async () => {
    const source = terminal();
    for (let i = 0; i < 20; i++) await write(source, `l${i}\r\n`);
    const text = snapshotTerminal(source, { tabId: TAB, now: NOW }).text;
    assert.deepEqual(parseSnapshot(text, { tabId: TAB, now: NOW, maxLines: 3 }).content.split('\r\n'), ['l17', 'l18', 'l19']);
  });
});

describe('Scrollback: a file nobody should trust', () => {
  const header = (h) => `${SNAPSHOT_MAGIC}\n${JSON.stringify(h)}\nhello`;
  const good = { tabId: TAB, savedAt: NOW, cols: 80, lines: 1, hidden: 0 };

  test('SF-01: anything but this app\'s file for this tab is skipped', () => {
    assert.ok(parseSnapshot(header(good), { tabId: TAB, now: NOW }), 'the good one parses');
    const bad = {
      'no format line': `{"tabId":"${TAB}","savedAt":${NOW}}\nhello`,
      'another version': header(good).replace(SNAPSHOT_MAGIC, 'NEXTERM-SCROLLBACK 2'),
      'no newline after the header (truncated)': `${SNAPSHOT_MAGIC}\n{"tabId":"${TAB}","savedAt":${NOW}`,
      'header not JSON': `${SNAPSHOT_MAGIC}\n{tabId: ${TAB}}\nhello`,
      'header an array': `${SNAPSHOT_MAGIC}\n[1,2]\nhello`,
      'header null': `${SNAPSHOT_MAGIC}\nnull\nhello`,
      'another tab': header({ ...good, tabId: 'tab-term-8' }),
      'no savedAt': header({ ...good, savedAt: undefined }),
      'savedAt a string': header({ ...good, savedAt: String(NOW) }),
      'savedAt fractional': header({ ...good, savedAt: NOW + 0.5 }),
      'savedAt before 2020': header({ ...good, savedAt: Date.UTC(2019, 0, 1) }),
      'savedAt two days ahead': header({ ...good, savedAt: NOW + 2 * 86_400_000 }),
      'header over 1 KB': `${SNAPSHOT_MAGIC}\n${JSON.stringify({ ...good, pad: 'x'.repeat(2000) })}\nhello`,
      'nothing but blanks': header(good).replace('hello', '\n   \n\x1b[31m  \x1b[0m\n'),
      'not a string': 42,
    };
    for (const [why, text] of Object.entries(bad)) {
      assert.equal(parseSnapshot(text, { tabId: TAB, now: NOW }), null, why);
    }
    assert.equal(parseSnapshot(header(good), { tabId: '../tab-term-7', now: NOW }), null, 'an id that is not a tab id');
    assert.equal(snapshotTerminal(terminal(), { tabId: 'tab-term-0' }), null, 'nor saved under one');
  });

  test('SF-05: a layout restored since before v0.1.2 still has `tab-term-<ms>-<n>` ids — saved and read like the rest', async () => {
    const term = terminal();
    await write(term, 'old layout\r\n');
    for (const id of ['tab-term-1696512345678-2', 'tab-term-1726000000000-1']) {
      const snap = snapshotTerminal(term, { tabId: id, now: NOW });
      assert.ok(snap, id);
      assert.equal(parseSnapshot(snap.text, { tabId: id, now: NOW }).content, 'old layout');
    }
    for (const id of ['tab-term-1696512345678-0', 'tab-term-169651234567-2', 'tab-term-1696512345678-2-3', 'tab-term-1-2']) {
      assert.equal(snapshotTerminal(term, { tabId: id, now: NOW }), null, id);
    }
  });

  test('SF-02: the filter keeps text, SGR and line breaks, and drops every other sequence whole', () => {
    const cases = [
      ['\x1b[31mred\x1b[0m', '\x1b[31mred\x1b[0m'],
      ['\x1b[38:2::1:2:3mx', '\x1b[38:2::1:2:3mx'],
      ['a\x1b]52;c;aGVsbG8=\x07b', 'ab'],
      ['a\x1b]52;c;aGVsbG8=\x1b\\b', 'ab'],
      ['a\x1b]8;;https://evil.example\x07link\x1b]8;;\x07b', 'alinkb'],
      ['a\x1b]7;file://host/etc\x07b', 'ab'],
      ['a\x1b]133;A\x07b\x1b]133;D;0\x07', 'ab'],
      ['a\x1b]0;new title\x07b\x1b]2;t2\x1b\\c', 'abc'],
      ['a\x1bP$qm\x1b\\b', 'ab'],
      ['a\x1bP1;2|payload\x1b\\b', 'ab'],
      ['a\x1b_apc\x1b\\b\x1b^pm\x1b\\c\x1bXsos\x1b\\d', 'abcd'],
      ['a\x1b[cb\x1b[>0cc\x1b[5nd\x1b[6ne', 'abcde'],
      ['a\x1b[>qb', 'ab'],
      ['a\x1b[?1049hb\x1b[2Jc\x1b[Hd\x1b[10;10He', 'abcde'],
      ['a\x1b[31;1Hb', 'ab'],
      ['a\x1b[1 qb', 'ab'],
      ['a\x1b[?25mb', 'ab'],
      ['a\x1bcb\x1b7c\x1b8d\x1b(Be\x1b#8f', 'abcdef'],
      ['a\x9b31mb\x9d52;c;x\x07c\x90q\x9cd\x85e', 'abcde'],
      ['a\x07b\x08c\x09d\x0be\x0cf\x0dg\x7fh\x00i', 'abcdefghi'],
      ['line1\nline2', 'line1\nline2'],
      ['unterminated \x1b]52;c;aaaa\nnext line', 'unterminated \nnext line'],
      ['trailing escape\x1b', 'trailing escape'],
      [`\x1b[${'1;'.repeat(40)}mlong`, 'long'],
      ['한글 😀 ❤\u{fe0f}', '한글 😀 ❤\u{fe0f}'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(sanitizeForRestore(input), expected, JSON.stringify(input));
    }
  });

  /** A file whose content was edited to hold `payload`, parsed and restored into a terminal that reports what it did. */
  async function restoredFrom(payload, { filtered = true } = {}) {
    const term = terminal();
    const seen = { replies: [], osc: [], dcs: [], titles: [] };
    term.onData((d) => seen.replies.push(d));
    term.onTitleChange((t) => seen.titles.push(t));
    for (const id of [52, 8, 7, 133, 1337]) {
      term.parser.registerOscHandler(id, (data) => {
        seen.osc.push(`${id};${data}`);
        return true;
      });
    }
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, (data) => {
      seen.dcs.push(data);
      return true;
    });
    const file = `${SNAPSHOT_MAGIC}\n${JSON.stringify({ tabId: TAB, savedAt: NOW })}\nbefore${payload}after`;
    if (filtered) {
      const parsed = parseSnapshot(file, { tabId: TAB, now: NOW });
      await write(term, restoreText(parsed, { locale: 'en-US' }));
    } else {
      await write(term, file.split('\n').slice(2).join('\n'));
    }
    return seen;
  }

  const QUERIES = '\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[>0q\x1bP$qm\x1b\\\x1b[?996n';

  test('SF-03: queries in a restored file get no answer — nothing is typed into the new shell', async () => {
    const unfiltered = await restoredFrom(QUERIES, { filtered: false });
    assert.ok(unfiltered.replies.length >= 3, `unfiltered, the terminal answers: ${JSON.stringify(unfiltered.replies)}`);
    const filtered = await restoredFrom(QUERIES);
    assert.deepEqual(filtered.replies, [], 'restored: silent');
  });

  test('SF-04: clipboard writes, links, marks, titles and DCS in a restored file do nothing', async () => {
    const payload =
      '\x1b]52;c;cm0gLXJmIH4=\x07\x1b]8;;https://evil.example\x07x\x1b]8;;\x07\x1b]7;file://h/\x07' +
      '\x1b]133;A\x07\x1b]0;pwned\x07\x1b]2;pwned\x1b\\\x1bP$qm\x1b\\\x1b]1337;SetMark\x07';
    const unfiltered = await restoredFrom(payload, { filtered: false });
    assert.ok(unfiltered.osc.length >= 4 && unfiltered.titles.length >= 1 && unfiltered.dcs.length === 1, 'unfiltered, they act');
    const filtered = await restoredFrom(payload);
    assert.deepEqual(filtered, { replies: [], osc: [], dcs: [], titles: [] });
  });
});

describe('Scrollback: secrets are hidden before the file is written', () => {
  async function saved(output, { cols = 60, maxBytes } = {}) {
    const term = terminal({ cols, rows: 6 });
    await write(term, output);
    return snapshotTerminal(term, { tabId: TAB, now: NOW, ...(maxBytes ? { maxBytes } : {}) });
  }

  const assertHidden = (snap, bodies, why) => {
    for (const body of bodies) {
      assert.ok(!snap.text.includes(body), `${why}: the secret is not in the file`);
      // Nor any 12-character piece of it (a half-masked token is a leak).
      for (let i = 0; i + 12 <= body.length; i += 6) {
        assert.ok(!snap.text.includes(body.slice(i, i + 12)), `${why}: no piece of it either (${body.slice(i, i + 12)})`);
      }
    }
    assert.ok(snap.text.includes(HIDDEN), `${why}: marked as hidden`);
    assert.ok(snap.hidden >= 1, `${why}: counted`);
  };

  test('SM-01: a token right after an SGR, with a colour change inside it, after JSON\'s \\n and after %3D', async () => {
    const cases = {
      'right after an SGR': `token: \x1b[32m${GHP}\x1b[0m\r\n`,
      'colour change inside': `${GHP.slice(0, 15)}\x1b[31m${GHP.slice(15, 30)}\x1b[1;34m${GHP.slice(30)}\x1b[0m\r\n`,
      'after an escaped newline in JSON': `{"log":"line\\n${GHP}"}\r\n`,
      'after %3D in a URL': `https://x.example/?t%3D${GHP}\r\n`,
      'glued to the word before': `abc${GHP}\r\n`,
    };
    for (const [why, output] of Object.entries(cases)) assertHidden(await saved(output), [GHP_BODY], why);
  });

  test('SM-02: a token wrapped across two rows is still one token', async () => {
    const snap = await saved(`${'x'.repeat(45)}${GHP} end\r\n`, { cols: 60 });
    assertHidden(snap, [GHP_BODY], 'across the wrap');
    assert.ok(snap.text.includes(' end'), 'what follows it stays');
  });

  test('SM-03: generic sk- keys where they land, and not inside ordinary words', async () => {
    assertHidden(await saved(`OPENAI_KEY ${SK}\r\n`), [SK_BODY], 'after a space');
    assertHidden(await saved(`task\x1b[1m${SK}\x1b[0m\r\n`), [SK_BODY], 'right after a colour change');
    assertHidden(await saved(`"\\n${SK}"\r\n`), [SK_BODY], 'after \\n');
    const word = `task-${'abcdefghij'.repeat(3)}`;
    const snap = await saved(`${word}\r\n`);
    assert.ok(snap.text.includes(word) && snap.hidden === 0, 'task-… is a word, not a key');
  });

  test('SM-04: every shape the rules know', async () => {
    const shapes = fxCases([
      [`${AKIA}\r\n`, [AKIA.slice(4)]],
      [`${JWT}\r\n`, [JWT.slice(3)]],
      [`xoxb-1234567890-abcdefghijkl\r\n`, ['1234567890-abcdefghijkl']],
      [`github_pat_${'11ABCDEFG0'.repeat(4)}\r\n`, ['11ABCDEFG0'.repeat(4)]],
      [`sk-ant-api03-${'Zx9'.repeat(10)}\r\n`, [`api03-${'Zx9'.repeat(10)}`]],
      [`AIza${'Sy0123456789abcdefghijklmnopqrstuvw'}\r\n`, ['Sy0123456789abcdefghijklmnopqrstuvw']],
      [`glpat-${'abcDEF123_'.repeat(3)}\r\n`, ['abcDEF123_'.repeat(3)]],
      [`npm_${'a1B2c3D4e5'.repeat(3)}a1B2c3\r\n`, [`${'a1B2c3D4e5'.repeat(3)}a1B2c3`]],
      [`sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}\r\n`, ['4eC39HqLyjWDarjtT1zdp7dc']],
      ['Authorization: Bear·er abcdef123456.ghijk\r\n', ['abcdef123456.ghijk']],
      ['export DB_PASS·WORD=hunter2hunter2\r\n', ['hunter2hunter2']],
      ['AWS_SEC·RET_ACCESS_KEY=wJalrXUtn·FEMI/K7MDENG/bPxRfiCY\r\n', ['wJalrXUtn·FEMI/K7MDENG/bPxRfiCY']],
      ['{"api_key": "abcd1234efgh5678"}\r\n', ['abcd1234efgh5678']],
      ['client_sec·ret: s3cr3t-v4lu3-here\r\n', ['s3cr3t-v4lu3-here']],
    ]);
    for (const [output, bodies] of shapes) assertHidden(await saved(output), bodies, JSON.stringify(output));
  });

  test('SM-05: a private key block is hidden line by line, and on one line', async () => {
    const body = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'];
    const snap = await saved(
      `-----BEGIN PRIVATE KEY-----\r\n${body.join('\r\n')}\r\n-----END PRIVATE KEY-----\r\nafter the key\r\n`,
      { cols: 80 }
    );
    assertHidden(snap, body, 'line by line');
    assert.ok(snap.text.includes('after the key') && snap.text.includes('-----END PRIVATE KEY-----'), 'the rest stays');
    const one = await saved(`{"k":"-----BEGIN RSA PRIVATE KEY-----\\n${body[0]}\\n-----END RSA PRIVATE KEY-----"}\r\n`, { cols: 200 });
    assertHidden(one, [body[0]], 'one line of JSON');
  });

  test('SM-06: ordinary output is left alone', async () => {
    const output = [
      'PWD=/Users/me/project',
      'max_tokens=4096',
      'Input tokens: 1234',
      'git commit -m "fix password reset flow"',
      'task-runner-abcdefghijklmnopqrstuvwxyz',
      'eyJhbGciOi is not a whole JWT',
      'Done in 3.2s',
    ];
    const snap = await saved(`${output.join('\r\n')}\r\n`, { cols: 80 });
    assert.equal(snap.hidden, 0, snap.text);
    for (const line of output) assert.ok(snap.text.includes(line), line);
  });

  test('SM-07: at the line the size cap cuts, a secret is either whole-and-masked or gone — never in part', async () => {
    const term = terminal({ cols: 120, rows: 4 });
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(i % 3 === 0 ? `${i} key ${GHP}${i}` : `${i} ${'filler '.repeat(8)}`);
    await write(term, `${lines.join('\r\n')}\r\n`);
    const full = snapshotTerminal(term, { tabId: TAB, now: NOW });
    for (let maxBytes = 300; maxBytes < full.bytes; maxBytes += 37) {
      const snap = snapshotTerminal(term, { tabId: TAB, now: NOW, maxBytes });
      if (!snap) continue;
      assert.ok(snap.bytes <= maxBytes);
      for (let i = 0; i + 10 <= GHP_BODY.length; i += 5) {
        assert.ok(!snap.text.includes(GHP_BODY.slice(i, i + 10)), `cap ${maxBytes}: no piece of the token`);
      }
    }
  });

  test('SM-09: two rules on one secret hide it once — `GITHUB_TOKEN=ghp_…` is one secret, not two', async () => {
    const snap = await saved(`GITHUB_TOKEN=${GHP}\r\n`);
    assert.equal(snap.hidden, 1);
    assert.ok(snap.text.endsWith(`GITHUB_TOKEN=${HIDDEN}`), snap.text);
  });

  test('SM-10: what review found leaking — .env names, URLs, headers, quoted passphrases, bare tokens, command lines', async () => {
    const B = (x) => Buffer.from(x).toString('base64');
    const cases = fxCases([
      ['DATABASE_URL=postgres://admin:Sup3rS3cretPw@db.internal:5432/app', ['Sup3rS3cretPw']],
      ['MONGODB_URI=mongo·db+srv://svc:Qx7f·K2pLm9@cluster0.mongodb.net/prod', ['Qx7f·K2pLm9']],
      ['DB_PASS=hunter2hunter2', ['hunter2hunter2']],
      ['SMTP_PASS=mailPw-8812xx', ['mailPw-8812xx']],
      ['SECRET_KEY_BASE=9f1c2a7e4b5d6c8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b', ['9f1c2a7e4b5d6c8f']],
      ['APP_KEY=base64:Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5', ['Zm9vYmFyYmF6']],
      ['ENCRYP·TION_KEY=6b1f0c3e9a7d2b4c8e5f1a3d7c9b2e4f', ['6b1f0c3e9a7d2b4c']],
      ['DB_PASS·WORD_PROD=Pr0dPass·w0rd!', ['Pr0dPass·w0rd']],
      // Assembled here so that no whole token shape sits in the source:
      // GitHub's push protection takes these fakes for leaked secrets.
      [`SLACK_WEBHOOK_URL=https://hooks.${'slack'}.com/services/${['T0123ABCD', 'B0456EFGH', 'abcdEFGHijklMNOPqrstUVWX'].join('/')}`, ['abcdEFGHijklMNOPqrstUVWX']],
      ['SENTRY_DSN=https://3f2a9b1c4d5e6f708192a3b4c5d6e7f8@o12345.ingest.sentry.io/678', ['3f2a9b1c4d5e6f70']],
      ["cu·rl -H 'x-api·-key: 7c4a8d09ca3762af61e59520943dc26494f8941b' https://api.example.com", ['7c4a8d09ca3762af']],
      ['sec·ret-key: Zx81kLmQ0pRt5uVw', ['Zx81kLmQ0pRt5uVw']],
      ["curl -H 'authorization: bearer 0a1b2c3d4e5f60718293a4b5c6d7e8f9' x", ['0a1b2c3d4e5f6071']],
      ['"password": "correct horse battery staple"', ['horse battery staple', 'correct']],
      ["PASSWORD=abc'defghij", ['defghij']],
      ['ya29.a0AfB_byC1mN2oP3qR4sT5uV6wX7yZ8aB9cD0eF1gH2iJ3kL4mN5oP6qR7sT8uV9w', ['a0AfB_byC1mN2oP3qR4s']],
      ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMI/K7MDENG']],
      ['token                hv·s.CAESIJ4kQyY3rW0x9dUu2pQn1mS7aBcDeFgHiJkLmNoPqRsT', ['CAESIJ4kQyY3rW0x9dUu2pQn']],
      [`  tls.key: ${B('-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0t')}`, [B('-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0t').slice(20, 50)]],
      [`      "auth": "${B('user:Sup3rS3cretPw')}"`, [B('user:Sup3rS3cretPw')]],
      [`_auth=${B('user:Sup3rS3cretPw')}`, [B('user:Sup3rS3cretPw')]],
      ['machine api.example.com login me password Sup3rS3cretPw', ['Sup3rS3cretPw']],
      ['hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', ['IjKlMnOpQrStUvWx']],
      ['gsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij', ['IjKlMnOpQrStUvWx']],
      ['wh·sec_AbCdEfGhIjKlMnOpQrStUvWxYz012345', ['IjKlMnOpQrStUvWx']],
      [['SG', 'AbCdEfGhIjKlMnOpQrStUv', 'WxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz012'].join('.'), ['IjKlMnOpQrStUv']],
      ['https://alice:Sup3rS3cretPw@git.example.com/repo.git', ['Sup3rS3cretPw']],
      ['https://acct.blob.core.windows.net/c/f?sv=2022-11-02&ss=b&sig=AbCdEf%2BGhIjKlMn0pQrStUvWxYz%3D', ['AbCdEf%2BGhIjKlMn0pQr']],
      ['$ mysql -u root -pS3cretPw1 mydb', ['S3cretPw1']],
      ['$ cu·rl -u alice·:S3cretPw1 https://api.example.com', ['S3cretPw1']],
      ['$ sshpass -p S3cretPw1 ssh host', ['S3cretPw1']],
      ['$ docker login -u me -p S3cretPw1 registry.example.com', ['S3cretPw1']],
      ['$ openssl rsa -in k.pem -passin pass:S3cretPw1', ['S3cretPw1']],
      ['$ deploy --token=S3cretPw1abc --env prod', ['S3cretPw1abc']],
    ]);
    for (const [output, bodies] of cases) {
      const snap = await saved(`${output}\r\n`, { cols: 200 });
      for (const body of bodies) assert.ok(!snap.text.includes(body), `${output}: ${body} is not in the file`);
      assert.ok(snap.hidden >= 1, output);
    }
  });

  test('SM-11: and what it must leave alone', async () => {
    const output = [
      ' --basic          Use HTTP Basic Authentication',
      'const password = req.body.password;',
      'export PASSWORD=${DB_PASSWORD}',
      'password: null',
      'Done in 3.2s',
      'src/index.js:12:5 error TS2345',
      'certs/test.pem:1:-----BEGIN RSA PRIVATE KEY-----',
      '$ ls',
      'README.md  package.json  src',
      'sha256:3f2a9b1c4d5e6f708192a3b4c5d6e7f83f2a9b1c4d5e6f708192a3b4c5d6e7f8',
    ];
    const snap = await saved(`${output.join('\r\n')}\r\n`, { cols: 120 });
    assert.equal(snap.hidden, 0, snap.text);
    for (const line of output) assert.ok(snap.text.includes(line), line);
  });

  test('SM-12: a key block whose BEGIN is gone — scrolled out, or above the cut — is hidden all the same', async () => {
    const body = ['MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun', 'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK', 'LxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo'];
    const key = ['-----BEGIN RSA PRIVATE KEY-----', ...body, ...body, ...body, '-----END RSA PRIVATE KEY-----'];
    // Scrolled out: a scrollback so short that BEGIN and the first body line leave it.
    const term = terminal({ cols: 80, rows: 4, scrollback: 6 });
    await write(term, `${key.join('\r\n')}\r\n$ \r\n`);
    const top = term.buffer.normal.getLine(0).translateToString(true);
    assert.ok(!top.includes('BEGIN'), `BEGIN is gone: ${top}`);
    const snap = snapshotTerminal(term, { tabId: TAB, now: NOW });
    for (const line of body) assert.ok(!snap.text.includes(line), 'no body line survives');
    // Above the cut: the file's budget ends inside a block with no END in the
    // file either (`head -4 key.pem`), so only the rows above can tell.
    const big = terminal({ cols: 80, rows: 4, scrollback: 200 });
    await write(big, `-----BEGIN RSA PRIVATE KEY-----\r\n${body.join('\r\n')}\r\n`);
    const cut = snapshotTerminal(big, { tabId: TAB, now: NOW, maxLines: 2 });
    assert.ok(!cut.text.includes('BEGIN'), 'the cut is below BEGIN');
    for (const line of body) assert.ok(!cut.text.includes(line), 'and the body under it is still hidden');
  });

  test('SM-13: a token a program broke over two lines at the margin, or onto a line of its own', async () => {
    const tail = 'StUvWxYz0123456789AbCdEfGhIjKlMnOpQr';
    const full = await saved(`OPENAI_API_KEY=sk-proj-${'AbCdEfGhIj'.repeat(6)}\r\n${tail} and more words\r\nnext line\r\n`, { cols: 83 });
    assert.ok(!full.text.includes(tail), 'the rest of a line that reached the margin');
    assert.ok(full.text.includes(' and more words') && full.text.includes('next line'), 'and nothing after it');
    const alone = await saved(`GITHUB_TOKEN=${GHP.slice(0, 30)}\r\n23456789AbCdEf\r\nDone\r\n`, { cols: 120 });
    assert.ok(!alone.text.includes('23456789AbCdEf'), 'a line that is nothing but the rest');
    assert.ok(alone.text.includes('Done'), 'a word after a token is not');
  });

  test('SM-14: a soft-wrapped line whose first row left the scrollback is not saved — its tail may be a token', async () => {
    // 20 columns: `export GITHUB_TOKEN=` is the first row, `ghp_` and 16 more the
    // second; both leave the scrollback, so what is left has no prefix to match.
    const term = terminal({ cols: 20, rows: 3, scrollback: 3 });
    await write(term, `export GITHUB_TOKEN=${GHP}\r\n${['l0', 'l1', 'l2'].join('\r\n')}\r\n`);
    const first = term.buffer.normal.getLine(0);
    assert.equal(first.isWrapped, true, 'the buffer starts with a continuation row');
    assert.ok(!first.translateToString(true).includes('ghp_'), 'with no prefix left in it');
    const snap = snapshotTerminal(term, { tabId: TAB, now: NOW });
    for (let i = 0; i + 8 <= GHP_BODY.length; i += 4) assert.ok(!snap.text.includes(GHP_BODY.slice(i, i + 8)), GHP_BODY.slice(i, i + 8));
  });

  test('SM-15: lines built to make a pattern backtrack — a megabyte of hex, of spaces, of eyJ, of password= — are masked in one pass', () => {
    // No timing here: a pattern that backtracks over these takes hours, and the
    // harness's per-test limit fails it.
    const lines = [
      'a'.repeat(1_000_000),
      `token${' '.repeat(200_000)}x`,
      'eyJ'.repeat(200_000),
      'password='.repeat(50_000),
      `${'-'.repeat(300_000)}p`,
      `${':'.repeat(300_000)}`,
      `${' '.repeat(1_000_000)}x`,
      `${'zip '.repeat(200_000)} -P x`,
      `${'-----END PRIVATE KEY----- AAAA '.repeat(30_000)}`,
      `x://${'a'.repeat(300_000)}`,
    ].map((text) => ({ runs: [{ sgr: '', text }] }));
    const counts = maskLines(lines, { cols: 80 });
    assert.equal(counts.length, lines.length);
  });

  test('SM-16: a key printed with something in front of each line — git log -p, cat -n, bat, grep -r, log time stamps', () => {
    const body = ['MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaRbIhoGcd8BMFbi', 'q8vCtiWcrUu2DtnEdUPwiQt6Dq9TqVgm2VmhNyTTBbzMzVtRV8E3/BKbFmVwb2Q7', 'Lb/5KhsCAwEAAQ=='];
    const ways = {
      'git log -p': (l) => `-${l}`,
      'cat -n': (l, i) => `${String(i + 1).padStart(6)}\t${l}`,
      bat: (l, i) => `${String(i + 1).padStart(4)} \u{2502} ${l}`,
      'grep -r': (l) => `/home/u/.ssh/id_rsa:${l}`,
      'kubectl logs --timestamps': (l) => `2026-11-07T10:00:00.000Z ${l}`,
    };
    for (const [how, f] of Object.entries(ways)) {
      for (const withBegin of [true, false]) {
        const text = [...(withBegin ? ['-----BEGIN RSA PRIVATE KEY-----'] : []), ...body, '-----END RSA PRIVATE KEY-----'].map(f);
        const lines = text.map((t) => ({ runs: [{ sgr: '', text: t }] }));
        maskLines(lines);
        const out = lines.map(encodeLine).join('\n');
        for (const b of body) assert.ok(!out.includes(b.slice(0, 12)), `${how}${withBegin ? '' : ' (BEGIN gone)'}: ${b.slice(0, 12)}`);
      }
    }
  });

  test('SM-17: and code, test reports and usage numbers are not secrets', async () => {
    const output = [
      '--- PASS: TestParseConfig (0.00s)',
      'PASS: tests/test_parse',
      '"totalTokenCount": 1234,',
      '"auth_method": "oauth2",',
      '"auth": "required",',
      'password: string;',
      'def check_password(password: str) -> bool:',
      'credential.helper=store',
      'password = String;',
    ];
    const snap = await saved(`${output.join('\r\n')}\r\n`, { cols: 120 });
    for (const line of output) assert.ok(snap.text.includes(line), line);
    // After a real token — one that reaches the margin, and one that does not
    // — the lines of an `env` listing stay as they are.
    const env = ['NODE_VERSION=20.11.0', 'TERM=xterm-256color', 'LANG=en_US.UTF-8', 'node-v20.11.0'];
    const tokenLine = `GITHUB_TOKEN=${GHP}`;
    for (const cols of [tokenLine.length, 120]) {
      const after = await saved(`${tokenLine}\r\n${env.join('\r\n')}\r\n`, { cols });
      assert.ok(!after.text.includes(GHP_BODY.slice(0, 12)), `cols ${cols}: the token is hidden`);
      for (const line of env) assert.ok(after.text.includes(line), `cols ${cols}: ${line}`);
    }
  });

  test('SM-18: more forms review found — YAML with spaces, escaped quotes, @ in a password, program flags, short names, Atlassian, plain bearer', async () => {
    const cases = fxCases([
      ['password: correct horse battery staple', ['horse battery staple']],
      ['{"api_key":"abc\\"def1234567890"}', ['def1234567890']],
      ['postgres://app:p@ssw0rd@db:5432/app', ['ssw0rd']],
      ['$ mongosh -u admin -p S3cretPw1 mongodb://h', ['S3cretPw1']],
      ['$ redis-cli -a S3cretPw1 ping', ['S3cretPw1']],
      ['$ sqlcmd -S srv -U sa -P S3cretPw1', ['S3cretPw1']],
      ['$ zip -P S3cretPw1 out.zip f', ['S3cretPw1']],
      ['$ 7z a -pS3cretPw1 out.7z f', ['S3cretPw1']],
      ['$ openssl enc -aes-256-cbc -k S3cretPw1 -in a', ['S3cretPw1']],
      ['$ smbclient //srv/share -U alice%S3cretPw1', ['S3cretPw1']],
      ['$ cu·rl --user=alice·:S3cretPw1 https://x', ['S3cretPw1']],
      ['$ cu·rl -ualice·:S3cretPw1 https://x', ['S3cretPw1']],
      ['DB_P·WD=S3cretPw1', ['S3cretPw1']],
      ['ADMIN_PW=S3cretPw1', ['S3cretPw1']],
      [`ATATT3xFfGF0${'AbCdEfGhIj'.repeat(4)}`, ['AbCdEfGhIjAbCd']],
      ['Authorization: Bear·er abcdefghijklmnopqrstuvwxyzABCD', ['abcdefghijklmnopqrst']],
    ]);
    for (const [output, bodies] of cases) {
      const snap = await saved(`${output}\r\n`, { cols: 200 });
      for (const body of bodies) assert.ok(!snap.text.includes(body), `${output}: ${body}`);
    }
  });

  test('SM-19: a token cut by the margin before it could be recognised — and nothing after a token turns into [hidden]', async () => {
    const cols = 80;
    const head = `${'y'.repeat(cols - 18)}sk-ant-api03-Xq9Zk`;
    assert.equal(head.length, cols);
    const snap = await saved(`${head}\r\nAbCdEfGhIjKlMnOpQrStUvWxYz0123456789 then run it\r\n`, { cols });
    assert.ok(!snap.text.includes('Xq9Zk'), 'what the margin left of it');
    assert.ok(!snap.text.includes('AbCdEfGhIjKlMnOpQrSt'), 'the rest, on the next line');
    assert.ok(snap.text.includes(' then run it'), 'and only the rest');
    // Claude Code indents what it wraps by five columns.
    const indented = await saved(`${head}\r\n     AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 then run it\r\n`, { cols });
    assert.ok(!indented.text.includes('AbCdEfGhIjKlMnOpQrSt'), 'behind a five-column indent too');
  });

  test('SM-20: a cut that would split an emoji keeps the file well-formed — a lone surrogate makes the backend refuse every save', async () => {
    // The mask itself never cuts a character in two…
    const line = { runs: [{ sgr: '', text: `PASSWORD=${'a'.repeat(511)}\u{1f600}tail` }] };
    maskLines([line]);
    const masked = encodeLine(line);
    assert.equal(masked, masked.toWellFormed(), `the mask ends between characters: ${JSON.stringify(masked.slice(0, 40))}`);
    assert.ok(!masked.includes('aaaaaaaa'), 'and the value is hidden');
    // …and a lone surrogate xterm was handed (it keeps them) does not reach the file.
    const term = terminal();
    await write(term, 'before \u{d83d} after\r\n');
    assert.ok(term.buffer.normal.getLine(0).translateToString(true).includes('\u{d83d}'), 'xterm kept it');
    const snap = snapshotTerminal(term, { tabId: TAB, now: NOW });
    assert.equal(snap.text, snap.text.toWellFormed(), 'the file is well-formed');
  });

  test('SM-21: a key the way viewers show it — cat -A, cat -v, a JSON or Python list, a table, word-diff, a long grep path, hard-wrapped JSON', () => {
    const body = ['MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaRbIhoGcd8BMFbi', 'q8vCtiWcrUu2DtnEdUPwiQt6Dq9TqVgm2VmhNyTTBbzMzVtRV8E3/BKbFmVwb2Q7', 'Lb/5KhsCAwEAAQ=='];
    const path = '/Users/dev/work/acme-platform/infrastructure/terraform/keys/deploy_id_rsa:';
    const ways = {
      'cat -A': (l) => `${l}$`,
      'cat -v': (l) => `${l}^M`,
      'JSON list': (l) => `  "${l}",`,
      'Python list': (l) => `  '${l}',`,
      table: (l) => `| ${l} |`,
      'word-diff': (l) => `[-${l}-]`,
      'long grep path': (l) => `${path}${l}`,
    };
    for (const [how, f] of Object.entries(ways)) {
      for (const withBegin of [true, false]) {
        const text = [...(withBegin ? ['-----BEGIN RSA PRIVATE KEY-----'] : []), ...body, '-----END RSA PRIVATE KEY-----'].map(f);
        const lines = text.map((x) => ({ runs: [{ sgr: '', text: x }] }));
        maskLines(lines);
        const out = lines.map(encodeLine).join('\n');
        for (const b of body) assert.ok(!out.includes(b.slice(0, 12)), `${how}${withBegin ? '' : ' (BEGIN gone)'}: ${b.slice(0, 12)}`);
      }
    }
    // BEGIN and no END (`head -3 key.pem` through grep -r): only BEGIN's own prefix tells.
    const headOnly = ['-----BEGIN RSA PRIVATE KEY-----', ...body].map((l) => ({ runs: [{ sgr: '', text: `${path}${l}` }] }));
    maskLines(headOnly);
    for (const b of body) assert.ok(!headOnly.map(encodeLine).join('\n').includes(b.slice(0, 12)), `long grep path, no END: ${b.slice(0, 12)}`);
    // A service-account JSON key, `\n` escapes and all, wrapped by the program at 80 with an indent.
    const json = `{"private_key": "-----BEGIN PRIVATE KEY-----\\n${body.join('\\n')}\\n-----END PRIVATE KEY-----\\n"}`;
    const rows = [];
    for (let i = 0; i < json.length; i += 75) rows.push(`${i ? '     ' : ''}${json.slice(i, i + 75)}`);
    for (const b of body) assert.ok(rows.join('\n').includes(b.slice(2, 12)), `the piece is whole in a row before masking: ${b.slice(2, 12)}`);
    const wrapped = rows.map((x) => ({ runs: [{ sgr: '', text: x }] }));
    maskLines(wrapped, { cols: 80 });
    const out = wrapped.map(encodeLine).join('\n');
    // Pieces from inside each line (the program's wrap may fall anywhere in it).
    for (const b of body) assert.ok(!out.includes(b.slice(2, 12)), `hard-wrapped JSON: ${b.slice(2, 12)}`);
  });

  test('SM-22: openssl rsa -text — the private numbers are hidden, the public ones are not', () => {
    const hex = '    00:c3:4f:9a:2b:11:de:ad:be:ef:01:23:45:67:89:ab:cd:ef:';
    const text = ['Private-Key: (2048 bit, 2 primes)', 'modulus:', '    00:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:', 'publicExponent: 65537 (0x10001)', 'privateExponent:', hex, hex, 'prime1:', hex, 'coefficient:', hex, 'writing RSA key'];
    const lines = text.map((x) => ({ runs: [{ sgr: '', text: x }] }));
    maskLines(lines);
    const out = lines.map(encodeLine);
    assert.ok(out[2].includes('00:aa:bb'), 'modulus stays');
    for (const i of [5, 6, 8, 10]) assert.ok(!out[i].includes('c3:4f'), `line ${i} hidden`);
    assert.equal(out[11], 'writing RSA key');
  });

  test('SM-23: compiler locations, typed code, structures and log words are not secrets', async () => {
    const output = [
      '  --> src/auth.rs:12:5',
      "src/auth.ts:10:3 - error TS2322: Type 'string' is not assignable",
      'tests/test_auth.py:42: AssertionError',
      'main.(*Server).auth(0xc000) /app/token.go:45 +0x1d',
      '    authService: AuthService,',
      '    pub secret: &[u8],',
      '  password: PasswordHash,',
      '{"auth":{"method":"oidc","issuer":"x"}}',
      'auth:server listening on 3000',
      'a1b2c3d auth: refresh tokens on expiry',
      'INFO token: refreshed for user',
      "  DB_PASSWORD:  <set to the key 'password' in secret 'db'>",
      '      + auth_token = (known after apply)',
      '$ docker run -u 1000:1000 img',
      'src/password_reset.py: 3 errors found',
      'secrets:loader reading config v2',
      'let password = PasswordHash;',
      "      DB_PASSWORD:  <set to the key 'password' in secret 'db'>  Optional: false",
    ];
    const snap = await saved(`${output.join('\r\n')}\r\n`, { cols: 120 });
    assert.equal(snap.hidden, 0, snap.text);
    for (const line of output) assert.ok(snap.text.includes(line), line);
  });

  test('SM-24: after a BEGIN in a log line, words are words — and PuTTY lines need PuTTY', () => {
    const text = [
      '2026-11-07T10:00:00Z loading -----BEGIN PRIVATE KEY----- from env',
      'Compiling',
      'FAILED',
      'Done',
      'Private-Lines: 3',
      'build42',
      'v2release9',
      'step3done',
    ];
    const lines = text.map((x) => ({ runs: [{ sgr: '', text: x }] }));
    const counts = maskLines(lines);
    assert.deepEqual(lines.map(encodeLine), text);
    assert.equal(counts.reduce((a, b) => a + b, 0), 0);
  });

  test('SM-25: the END walk-back reads each line once — a log of END lines is not 400 lines of work each', () => {
    const lines = [];
    // END lines that themselves end in base64: without a floor, each walked the 400 above it.
    for (let i = 0; i < 5000; i++) lines.push({ runs: [{ sgr: '', text: '-----END PRIVATE KEY----- AbCdEf0123456789AbCdEf' }] });
    const before = maskStats.walkSteps;
    maskLines(lines);
    const steps = maskStats.walkSteps - before;
    assert.ok(steps <= 2 * lines.length, `walk steps ${steps} for ${lines.length} lines`);
  });

  test('SM-26: no pattern or loop shape that went quadratic before is back (they cannot be timed here)', () => {
    const source = readFileSync(new URL('../../src/lib/scrollbackSnapshot.js', import.meta.url), 'utf8');
    // `/\s+$/` scanned every run of spaces to its end (2 s a save on one wrapped line).
    assert.ok(!/\/\\s[+*]\$\//.test(source), 'no /\\s+$/ or /\\s*$/');
    // A list copied on every program name (12.7 s a save on `zip zip … -P`).
    assert.ok(/const takesP = new Set\(\)/.test(source) && !/\[\.\.\.takesP/.test(source), 'program flags in a set');
    // An unanchored lazy name in front of the keyword list (440 ms on one hex line).
    assert.ok(!/\[A-Za-z0-9_\.-\]\*\?\(\?:secret/.test(source), 'no lazy name before the keywords');
  });

  test('SM-27: what the code-and-type exceptions must not let through — values, not types', async () => {
    const cases = fxCases([
      ['{Name:bob Password:hunter2x Token:abc123def}', ['hunter2x', 'abc123def']],
      ['PASSWORD=Welcome', ['Welcome']],
      ['"password": "Summer"', ['Summer']],
      ['password: Welcome', ['Welcome']],
      ["DB_PASS·WORD='(9xK!mQ2zL'", ['9xK!mQ2zL']],
      ['ADMIN_PASS·WORD="&kL9pQ2xZ"', ['kL9pQ2xZ']],
      ['SECRET_KEY_BASE=[x9fK2mLq0', ['x9fK2mLq0']],
      ['API_TOKEN={a8f9c2d1e4}', ['a8f9c2d1e4']],
      ['DB_PASS=letmein', ['letmein']],
      ['REDIS_AUTH=foobared', ['foobared']],
      ['cu·rl -H "X-Api·-Key:9f8e7d6c5b4a"', ['9f8e7d6c5b4a']],
      ["curl -H 'Cookie:sid=abc123def456'", ['abc123def456']],
      ['{"user":"bob","pass":"sunshine"}', ['sunshine']],
      ['password: <9fK2mLq', ['9fK2mLq']],
      ['TOKEN=$(cu·rl -s -u alice·:s3cretPw https://x)', ['s3cretPw']],
      ['(cu·rl -u alice·:s3cretPw https://x)', ['s3cretPw']],
      ['echo hi;cu·rl -u alice·:s3cretPw https://x', ['s3cretPw']],
    ]);
    for (const [output, bodies] of cases) {
      const snap = await saved(`${output}\r\n`, { cols: 200 });
      for (const body of bodies) assert.ok(!snap.text.includes(body), `${output}: ${body}`);
    }
  });

  test('SM-28: a cut below PuTTY\'s header or openssl\'s name, a CRLF key under cat -A, and git blame across commits', async () => {
    const ppkBody = ['nv5FTj1Jf3RtLrNxX/pVDzlZPHB9779BHPZlzDVp/XxNrLtR3fJ1jTF5vnhdbbdh', '08GSgwCWsEe6Y4a+kM2iQAymcUOKIIKOUcmyAQi2Mk+a4Y6eEsWCwgSG80uqooqu'];
    const ppk = ['PuTTY-User-Key-File-3: ssh-rsa', 'Encryption: none', 'Public-Lines: 1', 'AAAAB3NzaC1yc2EAAAADAQABAAAB', 'Private-Lines: 2', ...ppkBody, 'Private-MAC: abab'];
    for (const maxLines of [5, 4, 3, 2]) {
      const term = terminal({ cols: 80, rows: 12, scrollback: 50 });
      await write(term, `${ppk.join('\r\n')}\r\n`);
      const snap = snapshotTerminal(term, { tabId: TAB, now: NOW, maxLines });
      for (const b of ppkBody) assert.ok(!snap.text.includes(b.slice(0, 16)), `PuTTY, ${maxLines} lines kept`);
    }
    const hex = '    00:c3:4f:9a:2b:11:de:ad:be:ef:01:23:45:67:89:ab:cd:ef:';
    const ossl = terminal({ cols: 80, rows: 12, scrollback: 50 });
    await write(ossl, `privateExponent:\r\n${hex}\r\n${hex}\r\n${hex}\r\nprime1:\r\n${hex}\r\n`);
    const cut = snapshotTerminal(ossl, { tabId: TAB, now: NOW, maxLines: 3 });
    assert.ok(!cut.text.includes('c3:4f'), 'openssl hex under a name above the cut');
    const body = ['MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaRbIhoGcd8BMFbi', 'Lb/5KhsCAwEAAQ=='];
    const crlf = ['-----BEGIN RSA PRIVATE KEY-----', ...body, '-----END RSA PRIVATE KEY-----'].map((l) => ({ runs: [{ sgr: '', text: `${l}^M$` }] }));
    maskLines(crlf);
    for (const b of body) assert.ok(!crlf.map(encodeLine).join('\n').includes(b.slice(0, 12)), `cat -A on CRLF: ${b.slice(0, 12)}`);
    const blame = ['-----BEGIN RSA PRIVATE KEY-----', ...body, '-----END RSA PRIVATE KEY-----'].map((l, i) => ({
      runs: [{ sgr: '', text: `${i % 2 ? '^1a2b3c4' : 'e5f6a7b8'} (Dev 2026-11-07 10:00:00 +0000 ${String(i + 1).padStart(2)}) ${l}` }],
    }));
    maskLines(blame);
    for (const b of body) assert.ok(!blame.map(encodeLine).join('\n').includes(b.slice(0, 12)), `git blame across commits: ${b.slice(0, 12)}`);
  });

  test('SM-08: masking works on the runs: what surrounds the token keeps its colour', () => {
    const line = { runs: [{ sgr: '32', text: 'ok ' }, { sgr: '31', text: GHP.slice(0, 20) }, { sgr: '', text: `${GHP.slice(20)} tail` }] };
    const [n] = maskLines([line]);
    assert.equal(n, 1);
    assert.deepEqual(line.runs, [
      { sgr: '32', text: 'ok ' },
      { sgr: '31', text: `ghp_${HIDDEN}` },
      { sgr: '', text: ' tail' },
    ]);
    assert.equal(encodeLine(line), `\x1b[0;32mok \x1b[0;31mghp_${HIDDEN}\x1b[0m tail`);
  });
});

describe('Scrollback: what goes into the new terminal', () => {
  test('SR-01: the separator is a dim English line with the time in the given locale', () => {
    const line = separatorLine(NOW, 'en-US');
    assert.ok(line.startsWith('\x1b[0;2m') && line.endsWith('\x1b[0m'), 'dim, then reset');
    assert.match(line, /\u{2500}\u{2500} Previous output \u{00b7} Nov 6, 2026/u);
    assert.equal(sanitizeForRestore(line), line, 'nothing in it the filter would drop');
  });

  test('SR-02: on macOS and Linux the restored lines and the separator stay on screen above the prompt', async () => {
    const source = terminal({ cols: 80, rows: 10 });
    await write(source, 'old one\r\nold two\r\n');
    const parsed = parseSnapshot(snapshotTerminal(source, { tabId: TAB, now: NOW }).text, { tabId: TAB, now: NOW });
    const term = terminal({ cols: 80, rows: 10 });
    await write(term, restoreText(parsed, { rows: 10, locale: 'en-US' }));
    await write(term, '$ ');
    const screen = cells(term, 0, 4).map((r) => r.replace(/\|[^ ]*/g, ''));
    assert.equal(term.buffer.normal.baseY, 0, 'nothing scrolled away');
    assert.ok(plainLines(term)[2].includes('Previous output'));
    assert.equal(plainLines(term)[3], '$');
    assert.equal(term.buffer.normal.cursorY, 3, `prompt right under the separator: ${screen.join(' / ')}`);
  });

  test('SR-03: on Windows they go into the scrollback, so ConPTY clearing and painting its screen cannot touch them', async () => {
    const source = terminal({ cols: 80, rows: 8 });
    await write(source, 'old one\r\nold two\r\n');
    const parsed = parseSnapshot(snapshotTerminal(source, { tabId: TAB, now: NOW }).text, { tabId: TAB, now: NOW });
    const term = terminal({ cols: 80, rows: 8 });
    await write(term, restoreText(parsed, { pushIntoScrollback: true, rows: 8, locale: 'en-US' }));
    const buffer = term.buffer.normal;
    assert.equal(buffer.cursorY, 0, 'cursor home');
    assert.equal(buffer.cursorX, 0);
    for (let y = 0; y < 8; y++) assert.equal(buffer.getLine(buffer.baseY + y).translateToString(true), '', `screen row ${y} empty`);
    assert.ok(buffer.getLine(buffer.baseY - 1).translateToString(true).includes('Previous output'), 'the separator just above the screen');
    // What ConPTY may send as it starts: clear, home, paint a prompt by position.
    await write(term, '\x1b[2J\x1b[H\x1b[1;1HC:\\Users\\me>\x1b[3;1H');
    const kept = [];
    for (let y = 0; y < buffer.baseY; y++) kept.push(buffer.getLine(y).translateToString(true));
    assert.deepEqual(kept.filter((l) => l !== ''), ['old one', 'old two', kept.find((l) => l.includes('Previous output'))]);
  });

  test('SR-04: restoreText of nothing writes nothing', () => {
    assert.equal(restoreText(null), '');
    assert.equal(restoreText({}), '');
  });
});
