/**
 * Characters are as wide on screen as the programs that print them say.
 *
 * xterm measures with Unicode 6 tables by default, where every emoji is ONE
 * cell. Claude Code (`Bun.stringWidth`), Ink and most modern tools count two,
 * and a program that redraws with relative cursor moves then lands a column
 * off for every emoji to the left of the change: replayed in the app's own
 * terminal, Claude Code's repaint of `✅ 통과 13개 ❌ 실패 2개` came out
 * `✅ 통과 123  ❌ 실패 3 2`.
 *
 * Of 82 characters measured against Claude Code, 56 agreed with the default
 * tables and 75 with Unicode 11, which still measured an emoji made wide by
 * VS16 (⚠️ ✔️ ❤️ ℹ️ ☑️) as one cell and a skin-tone or ZWJ sequence (👍🏽 👨‍💻)
 * as four. xterm 6 with `@xterm/addon-unicode-graphemes` measures a grapheme
 * cluster as one character: all 82 agree. UW-05 and UW-06 run that through
 * real xterm — `@xterm/headless`, the same core as `@xterm/xterm` from the
 * same commit (UW-04 keeps the two in step) — with the very function the app
 * uses to switch the widths on.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// Static imports on purpose: other files in this runner register module hooks
// that turn `@xterm/*` into test doubles, and a static import is resolved
// before any of them runs.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { activateGraphemeWidths, GRAPHEME_WIDTHS } from '../../src/lib/terminalCompat.js';

const { Terminal: HeadlessTerminal } = headless;
const { UnicodeGraphemesAddon } = loadGraphemesAddonAsInBrowser();

/**
 * `@xterm/addon-unicode-graphemes` as the app's WebView runs it: the shipped
 * bundle, evaluated with no `Buffer` in scope.
 *
 * The addon decodes its Unicode table from base64 as it loads — with `atob`
 * in a browser, a fresh array, but with `Buffer.from(…, 'base64')` wherever a
 * `Buffer` exists, and Node hands a table this size (3 KB) out of its shared
 * 8 KB pool, at whatever offset the pool has reached. The addon then reads the
 * table's header through `new DataView(data.buffer)` — from the start of the
 * POOL, not of its own bytes — and gets what an earlier buffer left there.
 * Where that says the table ends early, every code point above U+FFFF looks
 * up as a plain narrow character: 🔧 🚀 👍 one cell, while ✅ ⚠️ 한 stay right
 * (and 👍🏽 is two by accident, one plus one). Under Node 20 that failed UW-05
 * on all three CI platforms; here the same run passed, the pool holding other
 * leftovers. The app never takes that path — a WebView has no `Buffer` — and
 * neither does this test.
 *
 * Read from disk rather than imported, so no module hook another test file
 * registers can stand in for it, and no import order has to be right.
 */
function loadGraphemesAddonAsInBrowser() {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('@xterm/addon-unicode-graphemes'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'Buffer', source)(mod, mod.exports, undefined);
  return mod.exports;
}

/**
 * Claude Code's own measure, `Bun.stringWidth(s, { ambiguousIsNarrow: true })`
 * (Claude Code 2.1.289 embeds Bun 1.4.3; measured with Bun 1.4.2): its UI
 * glyphs, the emoji model answers use most, emoji sequences, Hangul (the
 * precomposed form, the compatibility jamo the IME sends, and NFD as macOS
 * spells file names) and CJK punctuation.
 */
const CLAUDE_WIDTHS = [
  ['⏺', 1], ['●', 1], ['✻', 1], ['✽', 1], ['✢', 1], ['✳', 1], ['✶', 1], ['·', 1], ['⎿', 1], ['✔', 1],
  ['✓', 1], ['✗', 1], ['✘', 1], ['★', 1], ['↓', 1], ['↑', 1], ['→', 1], ['⚠', 1], ['⧉', 1], ['❯', 1],
  ['›', 1], ['⏵', 1], ['⏸', 1], ['◆', 1], ['■', 1], ['☐', 1], ['☒', 1], ['…', 1], ['─', 1], ['│', 1],
  ['╭', 1], ['╯', 1], ['▐', 1], ['▛', 1], ['█', 1], ['▜', 1], ['▌', 1], ['▝', 1], ['▘', 1], ['░', 1],
  ['✅', 2], ['❌', 2], ['⚡', 2], ['⏳', 2], ['✨', 2], ['⭐', 2], ['❓', 2], ['❗', 2], ['➕', 2], ['🔧', 2],
  ['📝', 2], ['🚀', 2], ['💡', 2], ['🎉', 2], ['👍', 2], ['🤖', 2], ['📁', 2], ['🔍', 2], ['🧪', 2], ['🟢', 2],
  ['🔴', 2],
  ['⚠️', 2], ['✔️', 2], ['❤️', 2], ['ℹ️', 2], ['☑️', 2], ['👍🏽', 2], ['👨‍💻', 2], ['🇰🇷', 2],
  ['한', 2], ['글', 2], ['ㅎ', 2], ['ㄱ', 2], ['한글', 4], ['한', 2], ['글', 2],
  ['「', 2], ['」', 2], ['、', 2], ['。', 2], ['Ａ', 2], ['〈', 2],
];

const known = new Map(CLAUDE_WIDTHS);

/** Claude's width of one grapheme cluster: from the table, or a rule the table agrees with. */
function graphemeWidth(g) {
  if (known.has(g)) return known.get(g);
  if (/^[\x20-\x7e]$/.test(g)) return 1;
  if (/^[가-힣]$/.test(g)) return 2; // precomposed Hangul syllables
  throw new Error(`no recorded width for ${JSON.stringify(g)}`);
}

const segmenter = new Intl.Segmenter();
const claudeWidth = (s) => [...segmenter.segment(s)].reduce((w, { segment }) => w + graphemeWidth(segment), 0);

function headlessTerminal({ cols = 60, rows = 8, widths = true } = {}) {
  const term = new HeadlessTerminal({ cols, rows, allowProposedApi: true });
  if (widths) assert.equal(activateGraphemeWidths(term, UnicodeGraphemesAddon), true, 'grapheme widths switched on');
  return term;
}

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

/** How far the cursor moves when `s` is printed at column 0 — what the terminal really did. */
async function advance(s, { widths = true } = {}) {
  const term = headlessTerminal({ widths });
  try {
    await write(term, `\x1b[H${s}`);
    return term.buffer.active.cursorX;
  } finally {
    term.dispose();
  }
}

/** xterm's unicode handling as a terminal exposes it: an unknown version is refused. */
function fakeTerminal({ proposedApi = true } = {}) {
  const versions = ['6'];
  let active = '6';
  const unicode = {
    get versions() {
      return versions.slice();
    },
    get activeVersion() {
      return active;
    },
    set activeVersion(v) {
      if (!versions.includes(v)) throw new Error(`unknown Unicode version "${v}"`);
      active = v;
    },
    register(provider) {
      versions.push(provider.version);
    },
  };
  return {
    addons: [],
    get unicode() {
      if (!proposedApi) throw new Error('You must set the allowProposedApi option to true to use proposed API');
      return unicode;
    },
    loadAddon(addon) {
      this.addons.push(addon);
      addon.activate(this);
    },
  };
}

/** What the real addon does as it loads: registers '15' and '15-graphemes', then switches. */
class FakeGraphemesAddon {
  activate(terminal) {
    terminal.unicode.register({ version: '15' });
    terminal.unicode.register({ version: '15-graphemes' });
    terminal.unicode.activeVersion = '15-graphemes';
  }
}

/** A version of it that registers the provider and leaves the switch to the caller. */
class RegisterOnlyAddon {
  activate(terminal) {
    terminal.unicode.register({ version: '15-graphemes' });
  }
}

/**
 * A main-screen renderer the way Claude Code's works: it keeps a cell model
 * measured with ITS widths and, between frames, writes only the runs that
 * changed, reaching each with RELATIVE cursor moves from where it believes the
 * cursor is, then parks the cursor at the input caret.
 */
class ClaudeStyleRenderer {
  constructor(cols) {
    this.cols = cols;
    this.prev = null;
    this.at = { x: 0, y: 0 };
  }

  cells(line) {
    const cells = [];
    for (const { segment } of segmenter.segment(line)) {
      const w = graphemeWidth(segment);
      cells.push({ g: segment, w });
      for (let i = 1; i < w; i += 1) cells.push({ g: '', w: 0 });
    }
    while (cells.length < this.cols) cells.push({ g: ' ', w: 1 });
    return cells.slice(0, this.cols);
  }

  static move(dx, dy) {
    const h = dx < 0 ? `\x1b[${-dx}D` : dx > 0 ? `\x1b[${dx}C` : '';
    const v = dy < 0 ? `\x1b[${-dy}A` : dy > 0 ? `\x1b[${dy}B` : '';
    return h + v;
  }

  frame(lines, caret) {
    const next = lines.map((line) => this.cells(line));
    let out = '';
    if (!this.prev) {
      out += lines.join('\r\n');
      this.at = { x: claudeWidth(lines[lines.length - 1]), y: lines.length - 1 };
    } else {
      for (let y = 0; y < next.length; y += 1) {
        const same = (x) => this.prev[y][x].g === next[y][x].g && this.prev[y][x].w === next[y][x].w;
        let x = 0;
        while (x < this.cols) {
          if (same(x)) {
            x += 1;
            continue;
          }
          let start = x;
          while (start > 0 && next[y][start].w === 0) start -= 1;
          let end = x;
          while (end < this.cols && !(same(end) && next[y][end].w !== 0)) end += 1;
          let text = '';
          for (let i = start; i < end; i += 1) if (next[y][i].w > 0) text += next[y][i].g;
          out += ClaudeStyleRenderer.move(start - this.at.x, y - this.at.y) + text;
          this.at = { x: start + claudeWidth(text), y };
          x = end;
        }
      }
    }
    out += ClaudeStyleRenderer.move(caret.x - this.at.x, caret.y - this.at.y);
    this.at = { ...caret };
    this.prev = next;
    return out;
  }
}

/** Each row as text. A space the program wrote counts as content to xterm, hence the trim. */
const screenOf = (term, rows) =>
  Array.from({ length: rows }, (_, y) =>
    term.buffer.active.getLine(term.buffer.active.baseY + y).translateToString(true).trimEnd()
  );

describe('Unicode widths: characters measured as the programs measure them', () => {
  test('UW-01: a new terminal measures by grapheme cluster', () => {
    const t = fakeTerminal();
    assert.equal(activateGraphemeWidths(t, FakeGraphemesAddon), true);
    assert.equal(t.unicode.activeVersion, GRAPHEME_WIDTHS);
    assert.equal(GRAPHEME_WIDTHS, '15-graphemes', "the addon's id for its grapheme-aware provider");
    assert.equal(t.addons.length, 1, 'the addon is loaded, which is what registers the provider');

    const registerOnly = fakeTerminal();
    assert.equal(activateGraphemeWidths(registerOnly, RegisterOnlyAddon), true, 'switched even if the addon does not');
    assert.equal(registerOnly.unicode.activeVersion, GRAPHEME_WIDTHS);
  });

  test('UW-02: a terminal that cannot have them keeps working with the default tables', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const noProposed = fakeTerminal({ proposedApi: false });
      assert.equal(activateGraphemeWidths(noProposed, FakeGraphemesAddon), false);

      class Unregistered {
        activate() {}
      }
      const t = fakeTerminal();
      assert.equal(activateGraphemeWidths(t, Unregistered), false, 'the provider never registered');
      assert.equal(t.unicode.activeVersion, '6');
    } finally {
      console.warn = warn;
    }
  });

  test('UW-03: every terminal is created with them, before it is opened', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(src, /import \{ UnicodeGraphemesAddon \} from '@xterm\/addon-unicode-graphemes';/);
    assert.doesNotMatch(src, /addon-unicode11/);
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    const activate = create.indexOf('activateGraphemeWidths(term, UnicodeGraphemesAddon);');
    const open = create.indexOf('term.open(container);');
    assert.ok(activate > 0 && open > 0 && activate < open, 'in the creation path, ahead of the first output');
    assert.match(create, /allowProposedApi: true/, '`term.unicode` is proposed API');
  });

  test('UW-04: xterm 6 with the grapheme addon — and the headless core checked here is the same release', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.dependencies['@xterm/xterm'], /^\^6\./);
    assert.match(pkg.dependencies['@xterm/addon-unicode-graphemes'], /^\^0\.4\./);
    assert.equal(pkg.dependencies['@xterm/addon-unicode11'], undefined, 'Unicode 11 is gone, not left beside it');
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    const version = (name) => lock.packages[`node_modules/${name}`]?.version;
    assert.match(version('@xterm/xterm'), /^6\./);
    assert.equal(version('@xterm/headless'), version('@xterm/xterm'), 'UW-05/06 measure the release the app ships');
  });

  test('UW-05: real xterm agrees with Claude Code on all 82 characters', async () => {
    assert.equal(CLAUDE_WIDTHS.length, 82);
    const wrong = [];
    for (const [s, width] of CLAUDE_WIDTHS) {
      const got = await advance(s);
      if (got !== width) wrong.push(`${JSON.stringify(s)}: ${got}, Claude Code ${width}`);
    }
    assert.deepEqual(wrong, [], 'every character as wide as Claude Code counts it');

    // The control: xterm's own default tables measure an emoji, and an emoji
    // made wide by VS16, as one cell. (They count 👍🏽 and 👨‍💻 as 1 + 1 — two,
    // right by accident — and Unicode 11 as four.)
    for (const s of ['✅', '⚠️', '✔️', '❤️', 'ℹ️', '☑️']) {
      assert.equal(await advance(s, { widths: false }), 1, `${s} by default`);
    }
  });

  test("UW-06: Claude Code's relative-move repaint lands where it means to, sequences and all", async () => {
    const cols = 60;
    const frame1 = [
      '⏺ 빌드 결과: ✅ 통과 12개 ❌ 실패 3개 ⚠️ 경고 1개',
      '  ⎿  👨‍💻 리뷰어 👍🏽 승인 대기 중… (esc to interrupt)',
      '─'.repeat(cols),
      '> 커밋해줘 ❤️',
    ];
    const frame2 = [
      '⏺ 빌드 결과: ✅ 통과 13개 ❌ 실패 2개 ⚠️ 경고 0개',
      '  ⎿  👨‍💻 리뷰어 👍🏽 승인 완료 ✔️ (esc to interrupt)',
      '─'.repeat(cols),
      '> 커밋해줘 ❤️ ℹ️ ☑️',
    ];
    // The model's widths are Bun's: measured whole-line, with Bun 1.4.2.
    assert.deepEqual([frame1[0], frame1[1], frame2[1], frame1[3], frame2[3]].map(claudeWidth), [49, 50, 49, 13, 19]);

    const renderer = new ClaudeStyleRenderer(cols);
    const bytes1 = renderer.frame(frame1, { x: claudeWidth(frame1[3]), y: 3 });
    const caret = { x: claudeWidth(frame2[3]), y: 3 };
    const bytes2 = renderer.frame(frame2, caret);
    assert.doesNotMatch(bytes2, /\x1b\[\d+;\d+H/, 'relative moves only, as Claude Code redraws');

    const replay = async (widths) => {
      const term = headlessTerminal({ cols, rows: 6, widths });
      try {
        await write(term, bytes1);
        await write(term, bytes2);
        const b = term.buffer.active;
        return { screen: screenOf(term, frame2.length), cursor: { x: b.cursorX, y: b.cursorY } };
      } finally {
        term.dispose();
      }
    };

    const got = await replay(true);
    assert.deepEqual(got.screen, frame2.map((line) => line.trimEnd()), 'the screen reads exactly what Claude Code drew');
    assert.deepEqual(got.cursor, caret, 'and the cursor is parked where Claude Code believes it is');

    const control = await replay(false);
    assert.notDeepEqual(control.screen, got.screen, 'with the default tables the same bytes land a column off');
  });
});
