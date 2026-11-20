/**
 * Marks for the messages sent to OpenCode in mini mode
 * (src/lib/opencodeMiniMarks.js), apart from Claude Code's
 * (agent_message_marks.test.js, unchanged).
 *
 * The bytes real opencode-ai 1.18.34 (V1) drew for `opencode --mini
 * --no-replay` in a 120x40 pty, recorded by the Queen on 2026-11-19 and
 * sanitised (the work folder in the header and the session id at exit
 * replaced by ASCII of the same length; every escape sequence as it was),
 * are replayed through xterm's own headless build:
 * fixtures/opencode_mini/mini.bin and mini.events.json. The bytes are decoded
 * as UTF-8 first and written in whole characters, as the app's output path
 * does (src-tauri/src/pty/manager.rs holds back a split UTF-8 character):
 * @xterm/headless 6.0.0 drops U+203A when raw bytes split it after its
 * second byte (OMM-04). The tracker's submit hook is called where the user
 * pressed Enter, and a scan after every chunk — far more often than the
 * registry scans, so half-drawn frames are scanned too. The rest are
 * synthetic cases shaped like mini's output and the life of a mark.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { bufferReader, normaliseMessageText, noteTerminalInput, trackAgentMessageMarks } from '../../src/lib/agentMessageMarks.js';
import { trackPromptMarks } from '../../src/lib/promptMarks.js';
import { submitsLine } from '../../src/lib/tabActivity.js';
import {
  MAX_MINI_MARKS,
  MINI_GLYPH,
  findMiniComposer,
  isMiniCandidateRow,
  miniMessageTextsAt,
  trackOpencodeMiniMarks,
} from '../../src/lib/opencodeMiniMarks.js';

const { Terminal: HeadlessTerminal } = headless;

const fixture = (name) => new URL(`./fixtures/opencode_mini/${name}`, import.meta.url);
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const makeTerm = ({ cols = 120, rows = 40, scrollback = 5000 } = {}) =>
  new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
const lineText = (term, line) => term.buffer.active.getLine(line)?.translateToString(true).trimEnd() ?? null;
const markTexts = (term, tracker) => tracker.lines.map((line) => lineText(term, line));
const cursorRow = (term) => term.buffer.active.baseY + term.buffer.active.cursorY;

function fakeDecorations() {
  const made = [];
  const decorate = (marker, color) => {
    const decoration = {
      marker,
      color,
      options: { overviewRulerOptions: { color, position: 'full' } },
      isDisposed: false,
      dispose() {
        this.isDisposed = true;
      },
    };
    marker.onDispose?.(() => decoration.dispose());
    made.push(decoration);
    return decoration;
  };
  return { made, decorate, live: () => made.filter((d) => !d.isDisposed) };
}

const ALPHA = 'Reply with only the word ok. Token ALPHA7QX';
const BRAVO =
  'Reply with only the word ok. Token BRAVO8ZK and this message is long enough to wrap past the right edge of a 120 column terminal so the measurement covers a sent message that takes two rows on screen';

/** The recording as text, and each event at its offset in UTF-16 code units (each on a character boundary). */
function recording() {
  const raw = readFileSync(fixture('mini.bin'));
  const ev = JSON.parse(readFileSync(fixture('mini.events.json'), 'utf8'));
  const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const text = decode(raw);
  const events = ev.events.map((e) => {
    const at = decode(raw.subarray(0, e.offset)).length;
    assert.equal(Buffer.byteLength(text.slice(0, at), 'utf8'), e.offset, `${e.note}: on a character boundary`);
    return { ...e, at };
  });
  return { raw, text, events, cols: ev.cols, rows: ev.rows };
}

/** The end of a chunk of `size` code units from `pos`, never between the halves of a surrogate pair. */
function chunkEnd(text, pos, size, to) {
  let end = Math.min(to, pos + size);
  if (end < to && end > pos) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end += 1;
  }
  return end;
}

/**
 * Replays the recording: `chunk` code units at a time with a scan after
 * each; `noteTyped` at each "type" event and (unless `submit` is false)
 * `noteSubmit` at each "enter" one — and both at "exit", where `/exit\r`
 * was sent in one write, a submit like any other; `term.resize(90, 40)` at
 * "resize 90x40"; `onEvent(note)` after each event, `onScan()` after each
 * scan.
 */
async function replay({ chunk = 48, submit = true, onEvent = null, onScan = null, tracker: given = null } = {}) {
  const rec = recording();
  const term = makeTerm({ cols: rec.cols, rows: rec.rows });
  const decorations = fakeDecorations();
  const tracker = given?.(term) ?? trackOpencodeMiniMarks(term, { decorate: decorations.decorate, color: '#3794ff' });
  let pos = 0;
  // Every chunk up to the next event handed to xterm at once, each with a
  // scan in its write callback: xterm runs a callback right after parsing its
  // chunk and before the next one, so each scan sees exactly the screen that
  // chunk left — without a timer turn per chunk, which made 1 code unit at a
  // time take minutes.
  const feed = (to) =>
    new Promise((resolve, reject) => {
      if (pos >= to) {
        resolve();
        return;
      }
      let failure = null;
      while (pos < to) {
        const end = chunkEnd(rec.text, pos, chunk, to);
        const last = end >= to;
        term.write(rec.text.slice(pos, end), () => {
          try {
            if (!failure) {
              tracker.scan();
              onScan?.(term, tracker);
            }
          } catch (err) {
            failure = err;
          }
          if (last) {
            if (failure) reject(failure);
            else resolve();
          }
        });
        pos = end;
      }
    });
  for (const e of rec.events) {
    await feed(e.at);
    if (e.note.startsWith('type') || e.note === 'exit') tracker.noteTyped();
    if ((e.note.startsWith('enter') || e.note === 'exit') && submit) tracker.noteSubmit();
    if (e.note.startsWith('resize')) term.resize(90, 40);
    await onEvent?.(e.note, term, tracker);
  }
  return { term, tracker, decorations };
}

const CHUNKS = [1, 7, 48, 1024];

describe('Mini marks: the recorded opencode --mini --no-replay run (AC1, AC2, AC3)', () => {
  test('OMM-01: two messages, two marks, on their `›` echoes, at every chunk size, also after the resize and the exit', async () => {
    for (const chunk of CHUNKS) {
      const seen = {};
      let phase = 'before resize';
      const firstSeen = new Map();
      const { term, tracker, decorations } = await replay({
        chunk,
        onScan: (t, tr) => {
          // Only the two echo rows are ever marked: never the composer rows
          // at their Enter before the commit (5; 19-20), a footer band (7, 21,
          // 36, then 52), a `▣` row (17, 32; 26, 50), a Thinking row, the
          // header rows 1-4, or the session block (50-52).
          const allowed = phase === 'before resize' ? [5, 19] : [6, 28];
          for (const line of tr.lines) {
            assert.ok(allowed.includes(line), `chunk ${chunk}, ${phase}: a mark on row ${line} (${JSON.stringify(lineText(t, line))})`);
            if (!firstSeen.has(line)) {
              // Made only once the row is the committed echo, never on the composer row before it.
              firstSeen.set(line, lineText(t, line));
              assert.ok(lineText(t, line).startsWith(`${MINI_GLYPH} Reply with only the word ok. Token`), `chunk ${chunk}: made on ${JSON.stringify(lineText(t, line))}`);
            }
          }
        },
        onEvent: (note, t, tr) => {
          assert.equal(t.buffer.active.type, 'normal', `${note}: the normal screen`);
          if (note.startsWith('resize')) phase = 'after resize';
          seen[note] = { lines: [...tr.lines], texts: tr.marks.map((m) => m.text), rows: markTexts(t, tr), pending: tr.pending };
        },
      });
      // `/exit\r` read the composer empty after typing: whatever it queued is
      // gone by the time mini has exited, so nothing waits for a later row.
      assert.deepEqual(seen.exited.pending, [], `chunk ${chunk}: nothing pending at exited`);
      assert.deepEqual(seen.exited.texts, [normaliseMessageText(ALPHA), normaliseMessageText(BRAVO)], `chunk ${chunk}: the marks at exited`);
      assert.deepEqual(seen['enter ALPHA7QX'].lines, [], `chunk ${chunk}: nothing marked at the first Enter`);
      assert.deepEqual(seen['enter BRAVO8ZK'].lines, [5], `chunk ${chunk}: ALPHA only at the second Enter`);
      assert.deepEqual(seen['turn done BRAVO8ZK'].lines, [5, 19], `chunk ${chunk}: ${JSON.stringify(seen['turn done BRAVO8ZK'].rows)}`);
      assert.deepEqual(seen['turn done BRAVO8ZK'].texts, [normaliseMessageText(ALPHA), normaliseMessageText(BRAVO)], 'BRAVO\'s covers rows 19 and 20');
      for (const note of ['after resize', 'exited']) {
        assert.deepEqual(seen[note].lines, [6, 28], `chunk ${chunk}, ${note}: ${JSON.stringify(seen[note].rows)}`);
        for (const row of seen[note].rows) assert.ok(row.startsWith(`${MINI_GLYPH} `), row);
      }
      assert.equal(decorations.live().length, 2, 'one decoration per mark');
      assert.ok(decorations.live().every((d) => d.color === '#3794ff'));
      assert.ok(lineText(term, 50).startsWith('█▀▀█  Session'), 'the session block is on rows 50-52');
      tracker.dispose();
      term.dispose();
    }
  });

  test('OMM-02: the composer read at each Enter: top 5 and ALPHA, then top 19 and the whole of BRAVO with no footer on screen', async () => {
    for (const chunk of CHUNKS) {
      const reads = {};
      await replay({
        chunk,
        onEvent: (note, t) => {
          if (!note.startsWith('enter')) return;
          reads[note] = findMiniComposer(bufferReader(t), cursorRow(t));
          if (note === 'enter BRAVO8ZK') {
            const b = t.buffer.active;
            for (let y = b.baseY; y < b.baseY + t.rows; y += 1) {
              const line = b.getLine(y);
              assert.ok(!lineText(t, y).includes('ctrl+p'), `chunk ${chunk}: a footer text on row ${y}`);
              assert.ok(line.getCell(0).isBgDefault(), `chunk ${chunk}: a footer band on row ${y}`);
            }
          }
        },
      });
      assert.equal(reads['enter ALPHA7QX'].top, 5, `chunk ${chunk}`);
      assert.equal(normaliseMessageText(reads['enter ALPHA7QX'].text), normaliseMessageText(ALPHA));
      assert.equal(reads['enter BRAVO8ZK'].top, 19, `chunk ${chunk}`);
      assert.equal(normaliseMessageText(reads['enter BRAVO8ZK'].text), normaliseMessageText(BRAVO), 'both of its rows');
    }
  });

  test('OMM-03: with no submit, nothing is ever marked: rows OpenCode prints by itself (a resumed history) answer nothing', async () => {
    for (const chunk of [7, 1024]) {
      let scans = 0;
      const { tracker } = await replay({
        chunk,
        submit: false,
        onScan: (t, tr) => {
          scans += 1;
          assert.deepEqual(tr.lines, [], `chunk ${chunk}: a mark with no submit`);
        },
        onEvent: (note, t, tr) => assert.deepEqual(tr.lines, [], `${note}: a mark with no submit`),
      });
      assert.ok(scans > 60, 'scanned throughout');
      assert.deepEqual(tracker.pending, []);
    }
  });

  test('OMM-04: the harness pitfall: raw bytes split after the second byte of U+203A lose the glyph in @xterm/headless 6.0.0; decoded text keeps it', async () => {
    const glyph = Buffer.from(MINI_GLYPH, 'utf8');
    assert.deepEqual([...glyph], [0xe2, 0x80, 0xba]);
    const row0 = async (parts) => {
      const term = makeTerm({ cols: 20, rows: 3 });
      for (const part of parts) await write(term, part);
      const text = lineText(term, 0);
      term.dispose();
      return text;
    };
    // As measured: `E2 80 | BA` gives ' A', `E2 | 80 BA` the glyph.
    const split2 = await row0([Uint8Array.from([0xe2, 0x80]), Uint8Array.from([0xba, 0x41])]);
    assert.notEqual(split2, `${MINI_GLYPH}A`, 'if @xterm/headless no longer drops it, OMM-04 can be relaxed; chunking decoded text stays right');
    assert.equal(await row0([Uint8Array.from([0xe2]), Uint8Array.from([0x80, 0xba, 0x41])]), `${MINI_GLYPH}A`);
    assert.equal(await row0([`${MINI_GLYPH}`, 'A']), `${MINI_GLYPH}A`, 'decoded text, a character at a time');
    assert.equal(chunkEnd('a😀b', 0, 2, 4), 3, 'a chunk never ends inside a surrogate pair');
  });
});

// ---- Synthetic mini-shaped streams ------------------------------------------

const CSI = '\x1b[';
const at = (row, col = 0) => `${CSI}${row + 1};${col + 1}H`;
const EL = `${CSI}2K`;
const wide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/u.test(ch);
const widthOf = (text) => [...text].reduce((n, ch) => n + (wide(ch) ? 2 : 1), 0);

/** `text` broken into rows of at most `cols` columns, as OpenCode breaks its echo itself (a hard break). */
function breakRows(text, cols) {
  const rows = [];
  let row = '';
  for (const ch of text) {
    if (widthOf(row) + widthOf(ch) > cols) {
      rows.push(row);
      row = '';
    }
    row += ch;
  }
  rows.push(row);
  return rows;
}

/**
 * A tiny OpenCode mini: the conversation printed on the normal screen, and
 * the live area — the composer, a blank row and a footer band — redrawn
 * row by row (CUP and EL, as mini draws; no ED). A sent message becomes its
 * echo `› <text>` on the composer's rows, hard-broken at the width, then the
 * answer and the turn footer, and the live area below them. The screen
 * scrolls when the live area reaches the bottom.
 */
function fakeMini(term, { row = 2 } = {}) {
  let composer = row;
  let height = 1;
  const footer = () => `${CSI}48;2;29;37;55m BUILD${' '.repeat(Math.max(0, term.cols - 6))}${CSI}0m`;
  const room = async (needed) => {
    const overflow = composer + needed - term.rows;
    if (overflow <= 0) return;
    await write(term, `${at(term.rows - 1)}${'\n'.repeat(overflow)}`);
    composer -= overflow;
  };
  const drawLive = async (rows) => {
    await room(rows.length + 2);
    let out = '';
    for (let i = 0; i < Math.max(rows.length, height) + 2; i += 1) out += `${at(composer + i)}${EL}`;
    out += `${at(composer + rows.length + 1)}${footer()}`;
    rows.forEach((r, i) => {
      out += `${at(composer + i)}${r}`;
    });
    height = rows.length;
    await write(term, out);
  };
  return {
    get composer() {
      return composer;
    },
    /** What the composer shows: `text` from column 0, hard-broken; the cursor after it. */
    async type(text) {
      await drawLive(text === '' ? [''] : breakRows(text, term.cols));
    },
    /** The message committed: its echo on the composer's rows, then the answer, the turn footer and the live area. */
    async commit(text, { answer = ['ok'] } = {}) {
      const echo = breakRows(`${MINI_GLYPH} ${text}`, term.cols);
      const body = ['', ...answer, '', '▣ Build · Model default · 1.0s', ''];
      await room(echo.length + body.length + 3);
      let out = '';
      for (let i = 0; i < height + 2; i += 1) out += `${at(composer + i)}${EL}`;
      echo.forEach((r, i) => {
        out += `${at(composer + i)}${EL}${CSI}36m${r}${CSI}0m`;
      });
      body.forEach((r, i) => {
        out += `${at(composer + echo.length + i)}${EL}${r}`;
      });
      await write(term, out);
      composer += echo.length + body.length;
      height = 1;
      await drawLive(['']);
    },
    /** Rows printed by OpenCode itself, above the live area (a resumed history, an answer). */
    async print(rows) {
      await room(rows.length + 3);
      let out = '';
      rows.forEach((r, i) => {
        out += `${at(composer + i)}${EL}${r}`;
      });
      await write(term, out);
      composer += rows.length;
      await drawLive(['']);
    },
    /** ED 2 and the live area drawn again from `top` (a redraw after the screen was erased). */
    async eraseScreen(top = 1) {
      await write(term, `${CSI}2J`);
      composer = top;
      await drawLive(['']);
    },
  };
}

/** Type (noted unless `typed` is false), Enter (the hook), the commit of `echo`, a scan. */
async function send(mini, tracker, text, { echo = text, read = text, typed = true } = {}) {
  if (typed) tracker.noteTyped();
  await mini.type(read);
  tracker.scan();
  const queued = tracker.noteSubmit();
  if (echo !== null) await mini.commit(echo);
  tracker.scan();
  return queued;
}

describe('Mini marks: mini-shaped cases (AC4)', () => {
  test('OMM-05: a two-row echo, hard-broken by OpenCode, is marked once, on its first row; the second row alone is never a candidate', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    const text = 'a message long enough to take two rows of a sixty column terminal at least';
    await send(mini, tracker, text);
    for (let i = 0; i < 3; i += 1) tracker.scan();
    assert.deepEqual(tracker.lines, [2]);
    assert.equal(tracker.marks[0].text, normaliseMessageText(text));
    assert.ok(!isMiniCandidateRow(bufferReader(term), 3), 'the continuation row');
    assert.deepEqual(miniMessageTextsAt(bufferReader(term), 2, 10).at(-1), normaliseMessageText(text));
  });

  test('OMM-06: after a narrower and a wider resize the soft-wrapped and hard rows still read as the mark\'s text', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    const text = 'the second message is long enough to wrap past the right edge here and more';
    await send(mini, tracker, text);
    assert.deepEqual(tracker.lines, [2]);
    term.resize(40, 30);
    tracker.scan();
    assert.deepEqual(tracker.lines, [2], 'kept at 40 columns');
    assert.ok(term.buffer.active.getLine(3).isWrapped, 'the first row reflowed into a soft wrap');
    assert.deepEqual(tracker.marks.map((m) => m.text), [normaliseMessageText(text)]);
    term.resize(90, 30);
    tracker.scan();
    assert.deepEqual(tracker.lines, [2], 'kept at 90 columns');
    // A message sent after the resize is marked too.
    await send(mini, tracker, 'after the resize');
    assert.deepEqual(markTexts(term, tracker).map((t) => t.slice(0, 18)), [`${MINI_GLYPH} the second messa`, `${MINI_GLYPH} after the resize`]);
  });

  test('OMM-07: a Korean message that wraps without spaces is marked', async () => {
    const term = makeTerm({ cols: 40, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    const text = '한글메시지는공백없이도줄을넘겨야한다'.repeat(3);
    await send(mini, tracker, text);
    assert.deepEqual(tracker.lines, [2]);
    assert.equal(tracker.marks[0].text, normaliseMessageText(text));
    assert.ok(lineText(term, 3).length > 0 && !lineText(term, 3).startsWith(MINI_GLYPH), 'a hard-broken second row');
  });

  test('OMM-08: a composer read that lags behind the typing (a prefix of the echo) is marked, for the whole echo', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    const text = 'a message whose last words were not drawn yet';
    const queued = await send(mini, tracker, text, { read: text.slice(0, 20) });
    assert.deepEqual(queued, { positional: false, text: normaliseMessageText(text.slice(0, 20)) });
    assert.deepEqual(tracker.lines, [2]);
    assert.equal(tracker.marks[0].text, normaliseMessageText(text));
  });

  test('OMM-09: an empty Enter with nothing typed queues nothing and marks nothing, also a `› ` row printed after it', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await mini.type('');
    assert.equal(tracker.noteSubmit(), null);
    assert.deepEqual(tracker.pending, []);
    await mini.print([`${MINI_GLYPH} a row of the answer`]);
    tracker.scan();
    assert.deepEqual(tracker.lines, []);
  });

  test('OMM-10: typed keys, then an empty read (the draw lagged behind them): a positional entry, which takes the echo on its bound', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    // A `› ` row printed earlier (an answer's), above the bound: never taken.
    await mini.print([`${MINI_GLYPH} quoted in an answer`, '']);
    const queued = await send(mini, tracker, 'typed faster than mini drew', { read: '' });
    assert.deepEqual(queued, { positional: true, text: '' });
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} typed faster than mini drew`]);
    assert.deepEqual(tracker.pending, []);
  });

  test('OMM-11: a `› ` row in an answer is not marked, with nothing pending or with a text it does not match', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await send(mini, tracker, 'first', { echo: 'first' });
    await mini.print([`${MINI_GLYPH} a quoted line in the answer`, '']);
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} first`]);
    // A text pending that the quoted row does not answer.
    tracker.noteTyped();
    await mini.type('something else');
    tracker.noteSubmit();
    await mini.print([`${MINI_GLYPH} another quoted line`, '']);
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} first`]);
  });

  test('OMM-12: a `› ` shell prompt row above the floor is not marked; without the floor it would be', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const untold = trackOpencodeMiniMarks(term);
    // A shell prompt drawn as `› ` (a custom prompt) and the line that started mini.
    // Something drawn right under it, so the prompt row is within the row
    // of tolerance above the composer top.
    await write(term, `~/work\r\n${MINI_GLYPH} opencode --mini`);
    tracker.noteShellSubmit();
    await write(term, '\r\n');
    const mini = fakeMini(term, { row: 2 });
    for (const t of [tracker, untold]) t.noteTyped();
    await mini.type('opencode');
    // Mini has drawn (its footer band under the composer): both queue the
    // text, and the prompt row is the pending entry's row of tolerance (Y-05).
    for (const t of [tracker, untold]) assert.deepEqual(t.noteSubmit(), { positional: false, text: 'opencode' });
    // A scan before the echo: the prompt row is the only candidate then.
    for (const t of [tracker, untold]) t.scan();
    assert.deepEqual(tracker.lines, [], 'the floor keeps the prompt row out');
    assert.deepEqual(untold.lines, [1], 'without the floor the prompt row would have taken it');
    assert.deepEqual(tracker.pending, [{ positional: false, text: 'opencode' }], 'still waiting for its echo');
    await mini.commit('opencode');
    tracker.scan();
    assert.deepEqual(tracker.lines, [2], 'its own echo, on the composer row');
    // The next message is marked as usual, the prompt row still not.
    await send(mini, tracker, 'opencode');
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} opencode`, `${MINI_GLYPH} opencode`]);
    assert.ok(!tracker.lines.includes(1));
    assert.equal(tracker.floor, 2);
  });

  test('OMM-13: a composer that starts with `› ` is not marked while it is at or below the composer top; its echo is', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    tracker.noteTyped();
    await mini.type(`${MINI_GLYPH} quoted`);
    for (let i = 0; i < 3; i += 1) tracker.scan();
    assert.deepEqual(tracker.lines, [], 'the composer row');
    assert.deepEqual(findMiniComposer(bufferReader(term), cursorRow(term)), { top: 2, bottom: 2, text: `${MINI_GLYPH} quoted` });
    const queued = tracker.noteSubmit();
    assert.equal(queued.text, normaliseMessageText(`${MINI_GLYPH} quoted`));
    tracker.scan();
    assert.deepEqual(tracker.lines, [], 'still the composer row at Enter');
    await mini.commit(`${MINI_GLYPH} quoted`);
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} ${MINI_GLYPH} quoted`]);
  });

  test('OMM-14 (W-01 not copied): a pending `yes` whose bound ED 2 erased never marks a `› yes` history row; only the new echo', async () => {
    const term = makeTerm({ cols: 60, rows: 14 });
    const tracker = trackOpencodeMiniMarks(term);
    tracker.noteShellSubmit();
    await write(term, '\r\n');
    const mini = fakeMini(term, { row: 1 });
    // A resumed conversation's history, printed by OpenCode with no submit.
    await mini.print([`${MINI_GLYPH} yes`, '', 'ok', '']);
    await send(mini, tracker, 'first');
    await send(mini, tracker, 'second');
    await send(mini, tracker, 'third');
    assert.deepEqual(markTexts(term, tracker), ['first', 'second', 'third'].map((t) => `${MINI_GLYPH} ${t}`));
    assert.ok(term.buffer.active.baseY >= 12, 'the history and two of the marks are in the scrollback');
    tracker.noteTyped();
    await mini.type('yes');
    tracker.noteSubmit();
    assert.deepEqual(tracker.pending, [{ positional: false, text: 'yes' }]);
    // The screen erased (ED 2 takes the bound's row, and `third`'s), and mini draws again.
    await mini.eraseScreen(1);
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} first`, `${MINI_GLYPH} second`]);
    await mini.commit('yes');
    tracker.scan();
    const history = 1;
    assert.equal(lineText(term, history), `${MINI_GLYPH} yes`, 'the history row is still there');
    assert.ok(!tracker.lines.includes(history), 'the history row gets no mark');
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} first`, `${MINI_GLYPH} second`, `${MINI_GLYPH} yes`]);
    assert.ok(tracker.lines[2] >= term.buffer.active.baseY, 'the new echo, on the screen');
  });

  test('OMM-15 (W-02 not copied): a marked `yes` erased by ED 2 and printed again is not marked again', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await send(mini, tracker, 'yes');
    assert.deepEqual(tracker.lines, [2]);
    await write(term, `${CSI}2J`);
    assert.deepEqual(tracker.marks, [], 'the erased row took its mark');
    await mini.print([`${MINI_GLYPH} yes`, '']);
    for (let i = 0; i < 3; i += 1) tracker.scan();
    assert.deepEqual(tracker.lines, [], 'no lost pass: a reprint is not marked');
  });

  test('OMM-16: rows leaving a full scrollback take their marks and decorations with them', async () => {
    const term = makeTerm({ cols: 60, rows: 12, scrollback: 50 });
    const decorations = fakeDecorations();
    const tracker = trackOpencodeMiniMarks(term, { decorate: decorations.decorate, color: '#3794ff' });
    const mini = fakeMini(term);
    await send(mini, tracker, 'first');
    await send(mini, tracker, 'second');
    assert.equal(tracker.marks.length, 2);
    let rows = [];
    for (let i = 0; i < 120; i += 1) rows.push(`answer line ${i}`);
    await mini.print(rows);
    tracker.scan();
    assert.deepEqual(tracker.marks, []);
    assert.equal(decorations.live().length, 0);
    rows = null;
  });

  test('OMM-17: past the limit the oldest mini marks go; shell prompt marks and Claude Code marks are not touched', async () => {
    const term = makeTerm({ cols: 60, rows: 30, scrollback: 5000 });
    const prompts = trackPromptMarks(term);
    const claude = trackAgentMessageMarks(term);
    await write(term, '$ ');
    prompts.mark();
    const claudeMark = { marker: term.registerMarker(0), decoration: null, text: 'x' };
    claude.marks.push(claudeMark);
    await write(term, 'opencode\r\n');
    const tracker = trackOpencodeMiniMarks(term, { limit: 3 });
    tracker.noteShellSubmit();
    const mini = fakeMini(term, { row: 2 });
    for (const text of ['one', 'two', 'three', 'four', 'five']) await send(mini, tracker, text);
    assert.deepEqual(markTexts(term, tracker), ['three', 'four', 'five'].map((t) => `${MINI_GLYPH} ${t}`));
    assert.deepEqual(prompts.lines, [0], 'the shell mark stays');
    assert.equal(claude.marks.length, 1);
    assert.ok(!claudeMark.marker.isDisposed, 'the Claude Code mark stays');
    assert.equal(MAX_MINI_MARKS, 500);
    prompts.dispose();
    claude.dispose();
  });

  test('OMM-18: Terminal: Clear (`afterClear`) drops every mini mark and moves the floor to the cursor row', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const decorations = fakeDecorations();
    const tracker = trackOpencodeMiniMarks(term, { decorate: decorations.decorate });
    const mini = fakeMini(term);
    await send(mini, tracker, 'first');
    await send(mini, tracker, 'second');
    assert.equal(tracker.marks.length, 2);
    tracker.afterClear();
    assert.deepEqual(tracker.marks, []);
    assert.equal(decorations.live().length, 0);
    assert.equal(tracker.floor, cursorRow(term));
  });

  test('OMM-19: after `stop` nothing waits for an echo and no further marks are made; the marks made stay', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await send(mini, tracker, 'first');
    tracker.noteTyped();
    await mini.type('waiting');
    tracker.noteSubmit();
    assert.equal(tracker.pending.length, 1);
    tracker.stop();
    assert.deepEqual(tracker.pending, []);
    await mini.commit('waiting');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} first`]);
    tracker.dispose();
    assert.deepEqual(tracker.marks, []);
    tracker.scan();
    assert.equal(tracker.noteSubmit(), null, 'nothing after dispose');
  });
});

describe('Mini marks: no mark that no submit of this run asked for (X-01, X-02, X-05, X-06, Y-02 to Y-04)', () => {
  test('OMM-24 (X-01): `hello` marked, then typed, cleared and Enter: a `› quoted` row printed later on that composer row is not marked', async () => {
    // The draft seen drawn by a scan or not; the registry's scan after the Enter or not.
    for (const { seenDraft, scanAfterEnter } of [
      { seenDraft: true, scanAfterEnter: false },
      { seenDraft: false, scanAfterEnter: true },
      { seenDraft: true, scanAfterEnter: true },
    ]) {
      const what = `draft seen ${seenDraft}, scan after Enter ${scanAfterEnter}`;
      const term = makeTerm({ cols: 60, rows: 30 });
      const tracker = trackOpencodeMiniMarks(term);
      const mini = fakeMini(term);
      await send(mini, tracker, 'hello');
      assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} hello`]);
      const bound = mini.composer;
      tracker.noteTyped();
      await mini.type('a draft');
      if (seenDraft) tracker.scan();
      tracker.noteTyped(); // Ctrl+U, Backspace: typing too
      await mini.type('');
      tracker.noteSubmit();
      if (scanAfterEnter) tracker.scan();
      await mini.print([`${MINI_GLYPH} a quoted answer line`, '']);
      tracker.scan();
      assert.equal(lineText(term, bound), `${MINI_GLYPH} a quoted answer line`, `${what}: printed on the composer row of the empty Enter`);
      assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} hello`], what);
      assert.deepEqual(tracker.pending, [], `${what}: nothing left waiting`);
      // The next message is marked as usual.
      await send(mini, tracker, 'next');
      assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} hello`, `${MINI_GLYPH} next`], what);
    }
  });

  test('OMM-25 (X-01): a positional entry takes only the row it was read on, once the composer has left it; never a `› ` row further down', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await send(mini, tracker, 'hello');
    // An empty read after typing, no scan between: then mini prints an
    // answer row on that composer row and a `› ` row under it (a turn
    // streaming, a session switch).
    tracker.noteTyped();
    await mini.type('');
    assert.deepEqual(tracker.noteSubmit(), { positional: true, text: '' });
    await mini.print(['an answer row', `${MINI_GLYPH} a quoted answer line`, '']);
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} hello`]);
    assert.deepEqual(tracker.pending, [], 'decided on the first scan after the composer left its row');
    await mini.print([`${MINI_GLYPH} another quoted line`, '']);
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} hello`]);
  });

  test('OMM-26 (X-01): the recording\'s `/exit\\r` leaves nothing pending, and a `› ` shell prompt drawn after mini exited is not marked', async () => {
    for (const chunk of CHUNKS) {
      let atExited = null;
      const { term, tracker } = await replay({
        chunk,
        onEvent: (note, t, tr) => {
          if (note === 'exited') atExited = { pending: tr.pending, lines: [...tr.lines] };
        },
      });
      assert.deepEqual(atExited, { pending: [], lines: [6, 28] }, `chunk ${chunk}`);
      // A `› ` prompt (a custom one) and its command's output, before the registry stops the tracker.
      await write(term, `\r\n${MINI_GLYPH} ls -la\r\nREADME.md\r\n`);
      for (let i = 0; i < 3; i += 1) tracker.scan();
      assert.deepEqual(tracker.lines, [6, 28], `chunk ${chunk}: ${JSON.stringify(markTexts(term, tracker))}`);
      tracker.dispose();
      term.dispose();
    }
  });

  test('OMM-27 (X-02): `yes` typed ahead before mini has drawn: the history a resume prints (`› yes`) is never marked', async () => {
    for (const scanBetween of [true, false]) {
      const term = makeTerm({ cols: 60, rows: 30 });
      const tracker = trackOpencodeMiniMarks(term);
      await write(term, '$ opencode --mini --no-replay -s ses_0000');
      tracker.noteShellSubmit(); // NexTerm's launch observer, as the line is typed
      await write(term, '\r\n');
      // Mini has drawn nothing yet: the tty echoes the typeahead under the launch line.
      tracker.noteTyped();
      await write(term, 'yes');
      if (scanBetween) tracker.scan();
      tracker.noteSubmit();
      await write(term, '\r\n');
      // Mini's first frame: its header, the history `-s` printed, then the composer.
      const mini = fakeMini(term, { row: 2 });
      await mini.print(['█▀▀█  OpenCode', '', `${MINI_GLYPH} yes`, '', 'ok', '']);
      const history = 4;
      assert.equal(lineText(term, history), `${MINI_GLYPH} yes`);
      tracker.scan();
      assert.deepEqual(tracker.lines, [], `scan between ${scanBetween}: the history row`);
      // The typeahead's own echo, later.
      const echo = mini.composer;
      await mini.commit('yes');
      tracker.scan();
      assert.ok(!tracker.lines.includes(history), `scan between ${scanBetween}: the history row got a mark`);
      assert.ok(tracker.lines.every((line) => line === echo), `scan between ${scanBetween}: only the echo, or nothing`);
      // Once mini has drawn, a message is marked as usual.
      await send(mini, tracker, 'after the first frame');
      assert.deepEqual(markTexts(term, tracker).slice(-1), [`${MINI_GLYPH} after the first frame`]);
    }
  });

  test('OMM-27b (Y-02): a notice and a blank row before mini\'s first frame, or typeahead with an empty Enter, is not mini having drawn: no history row is marked', async () => {
    const before = {
      // (a) A line and a blank row printed before mini's first frame (a
      // preexec hook, a one-time migration notice), then `yes` typed ahead.
      notice: async (term, tracker, scan) => {
        await write(term, 'Performing one time database migration\r\n\r\n');
        scan();
        tracker.noteTyped();
        await write(term, 'yes');
        scan();
        return [tracker.noteSubmit()];
      },
      // (b) `hello` and Enter, an empty Enter, then `yes`, all typed ahead.
      typeahead: async (term, tracker, scan) => {
        const queued = [];
        for (const text of ['hello', '', 'yes']) {
          if (text) tracker.noteTyped();
          await write(term, text);
          scan();
          queued.push(tracker.noteSubmit());
          if (text !== 'yes') await write(term, '\r\n');
        }
        return queued;
      },
    };
    for (const [name, typeAhead] of Object.entries(before)) {
      for (const scanBetween of [true, false]) {
        const what = `${name}, scan between ${scanBetween}`;
        const term = makeTerm({ cols: 60, rows: 30 });
        const tracker = trackOpencodeMiniMarks(term);
        await write(term, '$ opencode --mini --no-replay -s ses_0000');
        tracker.noteShellSubmit(); // NexTerm's launch observer, as the line is typed
        await write(term, '\r\n');
        const queued = await typeAhead(term, tracker, () => scanBetween && tracker.scan());
        assert.deepEqual(queued.filter(Boolean), [], `${what}: queued before mini has drawn`);
        assert.deepEqual(tracker.pending, [], what);
        await write(term, '\r\n');
        // Mini's first frame: its header, the history `-s` printed, then the composer and the footer band.
        const mini = fakeMini(term, { row: cursorRow(term) });
        const top = cursorRow(term);
        await mini.print(['█▀▀█  OpenCode', '', `${MINI_GLYPH} yes`, '', 'ok', '']);
        const history = top + 2;
        assert.equal(lineText(term, history), `${MINI_GLYPH} yes`, what);
        tracker.scan();
        assert.deepEqual(tracker.lines, [], `${what}: the history row`);
        // The typeahead's own echo, later: nothing was queued for it.
        await mini.commit('yes');
        tracker.scan();
        assert.deepEqual(tracker.lines, [], `${what}: ${JSON.stringify(markTexts(term, tracker))}`);
        // Once mini has drawn, a message is marked as usual.
        await send(mini, tracker, 'after the first frame');
        assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} after the first frame`], what);
        tracker.dispose();
        term.dispose();
      }
    }
  });

  test('OMM-32 (X-02, Y-02): the recording with the floor set where NexTerm types the line: mini\'s first frame counts as drawn, the same two marks', async () => {
    for (const chunk of CHUNKS) {
      const reads = {};
      const { term, tracker } = await replay({
        chunk,
        tracker: (t) => {
          const tr = trackOpencodeMiniMarks(t);
          tr.noteShellSubmit(); // the launch observer, on the row the line is typed at
          return tr;
        },
        onEvent: (note, t, tr) => {
          if (note.startsWith('enter')) reads[note] = tr.pending.at(-1)?.text ?? null;
          if (note !== 'started') return;
          // The first frame has the signs only mini draws (Y-02): its header
          // block at cell 0 of row 1 and its footer band, full width, on row 7
          // under the composer (row 5).
          assert.ok(lineText(t, 1).startsWith('█▀▀█'), `chunk ${chunk}: ${JSON.stringify(lineText(t, 1))}`);
          assert.equal(findMiniComposer(bufferReader(t), cursorRow(t), tr.floor).top, 5, `chunk ${chunk}`);
          const band = t.buffer.active.getLine(7);
          for (let x = 0; x < t.cols; x += 1) assert.ok(!band.getCell(x).isBgDefault(), `chunk ${chunk}: cell ${x} of the band`);
        },
      });
      assert.equal(tracker.floor, 1, `chunk ${chunk}`);
      assert.equal(reads['enter ALPHA7QX'], normaliseMessageText(ALPHA), `chunk ${chunk}: queued at the first Enter`);
      assert.deepEqual(tracker.lines, [6, 28], `chunk ${chunk}`);
      assert.deepEqual(tracker.pending, []);
      tracker.dispose();
      term.dispose();
    }
  });

  test('OMM-28 (X-02): several rows match one entry in a scan: the lowest at or below its bound; two entries of one text take the two lowest', async () => {
    const term = makeTerm({ cols: 60, rows: 40 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await send(mini, tracker, 'first');
    tracker.noteTyped();
    await mini.type('yes');
    tracker.noteSubmit();
    // Before any scan: a `› yes` OpenCode printed by itself on the composer row, then the echo under it.
    const printed = mini.composer;
    await mini.print([`${MINI_GLYPH} yes`, '']);
    const echo = mini.composer;
    await mini.commit('yes');
    tracker.scan();
    assert.deepEqual(tracker.lines, [2, echo], `printed on ${printed}, echo on ${echo}`);
    // Two submits of one text, three matching rows in one scan: the two lowest.
    for (let i = 0; i < 2; i += 1) {
      tracker.noteTyped();
      await mini.type('again');
      tracker.noteSubmit();
      if (i === 0) await mini.print([`${MINI_GLYPH} again`, '']);
      await mini.commit('again');
    }
    tracker.scan();
    const rows = markTexts(term, tracker);
    assert.deepEqual(rows, ['first', 'yes', 'again', 'again'].map((t) => `${MINI_GLYPH} ${t}`));
    const againRows = [];
    for (let y = echo + 1; y < term.buffer.active.length; y += 1) if (lineText(term, y) === `${MINI_GLYPH} again`) againRows.push(y);
    assert.equal(againRows.length, 3);
    assert.deepEqual(tracker.lines.slice(2), againRows.slice(1), 'the printed one, the topmost, is not marked');
  });

  test('OMM-29 (X-05, OMM-14 with baseY 0): a pending `yes` whose bound ED 2 erased with no scrollback is dropped: a reprinted older `› yes` is not marked', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await send(mini, tracker, 'yes');
    await send(mini, tracker, 'first');
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} yes`, `${MINI_GLYPH} first`]);
    tracker.noteTyped();
    await mini.type('yes');
    tracker.noteSubmit();
    assert.equal(term.buffer.active.baseY, 0, 'no scrollback at Enter');
    assert.deepEqual(tracker.pending, [{ positional: false, text: 'yes' }]);
    // ED 2 takes the bound and both marks; with replay on, mini prints the conversation again.
    await mini.eraseScreen(1);
    assert.deepEqual(tracker.marks, []);
    tracker.scan();
    assert.deepEqual(tracker.pending, [], 'dropped: nothing to fall back to');
    await mini.print([`${MINI_GLYPH} yes`, '', 'ok', '', `${MINI_GLYPH} first`, '', 'ok', '']);
    tracker.scan();
    assert.deepEqual(tracker.lines, [], 'the reprinted older `› yes` is not marked');
  });

  test('OMM-29b (Y-04, OMM-29 with scrollback): a pending `yes` whose bound ED 2 erased, and its scrollback row ED 3, is dropped: a reprinted older `› yes` is not marked', async () => {
    for (const scanBetween of [true, false]) {
      const what = `scan between ${scanBetween}`;
      const term = makeTerm({ cols: 60, rows: 14 });
      const tracker = trackOpencodeMiniMarks(term);
      const mini = fakeMini(term);
      for (const text of ['yes', 'first', 'second', 'third']) await send(mini, tracker, text);
      assert.deepEqual(markTexts(term, tracker), ['yes', 'first', 'second', 'third'].map((t) => `${MINI_GLYPH} ${t}`));
      tracker.noteTyped();
      await mini.type('yes');
      tracker.noteSubmit();
      assert.ok(term.buffer.active.baseY > 0, `${what}: scrollback at Enter`);
      assert.deepEqual(tracker.pending, [{ positional: false, text: 'yes' }]);
      // ED 3 takes the scrollback (the row above the screen at Enter), ED 2
      // the bound and the marks; with replay on, mini prints the conversation again.
      await write(term, `${CSI}3J`);
      await mini.eraseScreen(1);
      assert.equal(term.buffer.active.baseY, 0, `${what}: no scrollback left`);
      assert.deepEqual(tracker.marks, [], what);
      if (scanBetween) {
        tracker.scan();
        assert.deepEqual(tracker.pending, [], `${what}: dropped: nothing left to fall back to`);
      }
      await mini.print([`${MINI_GLYPH} yes`, '', 'ok', '', `${MINI_GLYPH} first`, '', 'ok', '']);
      tracker.scan();
      assert.deepEqual(tracker.lines, [], `${what}: the reprinted older \`› yes\` is not marked`);
      assert.deepEqual(tracker.pending, [], what);
      tracker.dispose();
      term.dispose();
    }
  });

  test('OMM-30 (X-06): a bracketed paste alone is not typing, so a lagging empty read after it queues nothing; an image paste reads `[Image 1]` and is a text entry', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    const input = (data) => noteTerminalInput(tracker, data, { submits: submitsLine, agentRuns: () => true });
    await send(mini, tracker, 'first');
    assert.equal(input('\x1b[200~a pasted block\x1b[201~'), null, 'a paste starts with ESC');
    await mini.type(''); // the draw lagged behind the paste
    tracker.scan();
    assert.equal(input('\r'), 'submit');
    assert.deepEqual(tracker.pending, [], 'not queued as positional');
    await mini.commit('a pasted block');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} first`], 'fails towards no mark');
    // An image: an empty bracketed paste, which OpenCode shows as `[Image 1]`.
    assert.equal(input('\x1b[200~\x1b[201~'), null);
    await mini.type('[Image 1]');
    tracker.scan();
    assert.equal(input('\r'), 'submit');
    assert.deepEqual(tracker.pending, [{ positional: false, text: normaliseMessageText('[Image 1]') }]);
    await mini.commit('[Image 1]');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} first`, `${MINI_GLYPH} [Image 1]`]);
  });

  test('OMM-33 (Y-03, known behaviour): typed, read empty at Enter, and a `› ` row lands on that composer row before any scan: it is marked', async () => {
    // Accepted (review cycle 2): it cannot be told apart from the lagging
    // draw OMM-10 marks. With a scan that saw the draft, or one after the
    // Enter, it is not marked (OMM-24). A change that alters this should
    // be a decision, not an accident.
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackOpencodeMiniMarks(term);
    const mini = fakeMini(term);
    await send(mini, tracker, 'hello');
    const bound = mini.composer;
    tracker.noteTyped();
    await mini.type('');
    assert.deepEqual(tracker.noteSubmit(), { positional: true, text: '' }, 'no draft seen, no scan after the Enter');
    // A streamed answer pushes the live area down: a quoted `› ` row on the old composer row.
    await mini.print([`${MINI_GLYPH} a quoted answer line`, '']);
    tracker.scan();
    assert.equal(lineText(term, bound), `${MINI_GLYPH} a quoted answer line`);
    assert.deepEqual(markTexts(term, tracker), [`${MINI_GLYPH} hello`, `${MINI_GLYPH} a quoted answer line`], 'the known residual');
    assert.deepEqual(tracker.pending, []);
  });
});

// ---- The registry's wiring (AC6), cut from terminalRegistry.js and run -----

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** A fake clock and timer queue. */
function fakeTime() {
  let clock = 0;
  let timers = [];
  return {
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x !== t);
    },
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        clock = next.at;
        next.fn();
      }
      clock = until;
    },
    get timers() {
      return timers.length;
    },
  };
}

/**
 * The registry's own `allMarks` … `messageScanner`, run with what they close
 * over handed in: a store with one tab (`tab`), the real trackers on a
 * headless terminal with spies on their scans, the real scheduler on a fake
 * clock, and `afterOutputSoFar` as an empty write.
 */
async function registryWiring(tab) {
  const { mergeMarks } = await import('../../src/lib/promptMarks.js');
  const { createScanScheduler, noteTerminalInput } = await import('../../src/lib/agentMessageMarks.js');
  const { agentRuns } = await import('../../src/lib/terminalStatus.js');
  const { submitsLine } = await import('../../src/lib/tabActivity.js');
  const src = read('../../src/components/terminal/terminalRegistry.js');
  const from = src.indexOf('function allMarks(');
  const scanner = src.indexOf('function messageScanner(');
  const to = src.indexOf('\n}\n', scanner) + 3;
  assert.ok(from > 0 && scanner > from && to > scanner, 'the registry functions');
  const time = fakeTime();
  const term = makeTerm({ cols: 80, rows: 24, scrollback: 1000 });
  const spy = (tracker) => {
    const scan = tracker.scan.bind(tracker);
    tracker.scanned = 0;
    tracker.scan = () => {
      tracker.scanned += 1;
      return scan();
    };
    return tracker;
  };
  const entry = { tabId: tab.id, term, disposed: false, claudeRan: false, opencodeRan: false };
  entry.promptMarks = trackPromptMarks(term);
  entry.messageMarks = spy(trackAgentMessageMarks(term));
  entry.miniMarks = spy(trackOpencodeMiniMarks(term));
  const instances = new Map([[tab.id, entry]]);
  const store = { getState: () => ({ tabs: [tab] }) };
  const afterOutputSoFar = (e, fn) => {
    e.term.write('', () => fn(e));
    return true;
  };
  const make = new Function(
    'instances', 'useTerminalStore', 'agentRuns', 'mergeMarks', 'noteTerminalInput', 'submitsLine', 'createScanScheduler', 'afterOutputSoFar',
    `${src.slice(from, to)}\nreturn { allMarks, claudeRunsIn, opencodeRunsIn, marksAgentIn, noteMessageInput, messageScanner };`
  );
  const registry = make(instances, store, agentRuns, mergeMarks, noteTerminalInput, submitsLine, (o) => createScanScheduler({ ...o, ...time }), afterOutputSoFar);
  entry.messageScans = registry.messageScanner(entry);
  const parsed = term.onWriteParsed(() => entry.messageScans.parsed());
  const output = (data) => {
    entry.messageScans.wrote();
    return write(term, data);
  };
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const run = async (ms) => {
    for (let t = 0; t < ms; t += 50) {
      time.advance(50);
      await settle();
    }
  };
  const done = () => {
    parsed.dispose();
    entry.messageScans.dispose();
    term.dispose();
  };
  return { registry, entry, term, time, output, run, done };
}

const running = (kind, sessionId = 'pty-1') => ({ id: 'tab-1', sessionId, agent: { kind, sessionId: null }, agentTyped: { sessionId } });

describe('Mini marks: the registry routes by the running agent (AC6)', () => {
  test('OMM-20: a Claude Code terminal scans only Claude Code\'s tracker, an OpenCode one only the mini tracker, and input goes the same way', async () => {
    for (const kind of ['claude', 'opencode']) {
      const w = await registryWiring(running(kind));
      assert.equal(w.registry.marksAgentIn('tab-1'), kind);
      w.registry.noteMessageInput('tab-1', 'hello');
      w.registry.noteMessageInput('tab-1', '\r');
      await w.output('some output\r\n');
      await w.run(1000);
      const [own, other] = kind === 'claude' ? [w.entry.messageMarks, w.entry.miniMarks] : [w.entry.miniMarks, w.entry.messageMarks];
      assert.ok(own.scanned >= 1, `${kind}: its own tracker scanned`);
      assert.equal(other.scanned, 0, `${kind}: the other tracker never scanned`);
      assert.equal(other.stats.reads, 0, `${kind}: nor read`);
      assert.equal(w.registry.allMarks(w.entry).lines.length, 0);
      w.done();
    }
  });

  test('OMM-21: a terminal running neither scans and reads nothing over 10,000 lines; OpenCode on the alternate screen neither', async () => {
    const neither = await registryWiring({ id: 'tab-1', sessionId: 'pty-1', agent: null });
    for (let i = 0; i < 100; i += 1) {
      let chunk = '';
      for (let j = 0; j < 100; j += 1) chunk += `line ${i * 100 + j}\r\n`;
      await neither.output(chunk);
      neither.time.advance(16);
    }
    neither.registry.noteMessageInput('tab-1', '\r');
    await neither.run(2000);
    assert.equal(neither.time.timers, 0, 'no timer was ever left');
    for (const t of [neither.entry.messageMarks, neither.entry.miniMarks]) {
      assert.equal(t.scanned + t.stats.scans + t.stats.reads, 0);
    }
    assert.equal(neither.entry.miniMarks.floor, neither.term.buffer.active.baseY + neither.term.buffer.active.cursorY + 1, 'a shell Enter is the floor of both');
    neither.done();
    const alternate = await registryWiring(running('opencode'));
    await alternate.output('\x1b[?1049h');
    for (let i = 0; i < 50; i += 1) {
      await alternate.output(`\x1b[H\x1b[2J› full TUI frame ${i}\r\n`);
      alternate.registry.noteMessageInput('tab-1', 'x');
      alternate.registry.noteMessageInput('tab-1', '\r');
      alternate.time.advance(16);
    }
    await alternate.run(2000);
    assert.equal(alternate.term.buffer.active.type, 'alternate');
    for (const t of [alternate.entry.messageMarks, alternate.entry.miniMarks]) {
      assert.equal(t.scanned + t.stats.scans + t.stats.reads, 0, 'nothing on the alternate screen');
    }
    alternate.done();
  });

  test('OMM-22: a mini terminal fed 2 simulated seconds of continuous output scans at most 9 times; when OpenCode stops, its pending entries go', async () => {
    const tab = running('opencode');
    const w = await registryWiring(tab);
    for (let t = 0; t < 2000; t += 16) {
      await w.output(`streamed ${t}\r\n`);
      w.time.advance(16);
    }
    const scans = w.entry.miniMarks.scanned;
    assert.ok(scans <= 9 && scans >= 1, `${scans} scans`);
    assert.equal(w.entry.messageMarks.scanned, 0);
    w.entry.miniMarks.noteTyped();
    await w.output('\r\nhello');
    w.registry.noteMessageInput('tab-1', '\r');
    assert.equal(w.entry.miniMarks.pending.length, 1);
    tab.agent = null;
    w.entry.messageScans.poke();
    w.time.advance(1000);
    assert.deepEqual(w.entry.miniMarks.pending, [], 'stopped with OpenCode');
    w.done();
  });

  test('OMM-31 (X-07): an agent that ends between the scheduler\'s check and the scan itself gets no scan, of either tracker', async () => {
    for (const kind of ['opencode', 'claude']) {
      const tab = running(kind);
      const w = await registryWiring(tab);
      await w.output('some output\r\n');
      // The timer fires: `wanted` sees the agent run and the scan is asked
      // for; it runs once xterm has parsed what came before it.
      w.time.advance(1000);
      tab.agent = null;
      await w.run(100);
      assert.equal(w.entry.miniMarks.scanned + w.entry.messageMarks.scanned, 0, `${kind}: mini ${w.entry.miniMarks.scanned}, Claude Code ${w.entry.messageMarks.scanned}`);
      w.done();
    }
  });
});

describe('Mini marks: what stays, and the documents (AC11, AC12)', () => {
  test('OMM-23: OSC 99 for OpenTUI is still set for every shell, and the README and V50 say what mini mode does', () => {
    const manager = read('../../src-tauri/src/pty/manager.rs');
    assert.match(manager, /OPENTUI_NOTIFICATION_PROTOCOL/);
    const readme = read('../../README.md');
    const terminal = readme.slice(readme.indexOf('### Working in a terminal'));
    const section = terminal.slice(0, terminal.indexOf('\n### ', 5));
    assert.match(section, /\*\*OpenCode's messages on the scrollbar\.\*\*/);
    assert.match(section, /`opencode\s+--mini --no-replay`/);
    assert.match(section, /\*OpenCode in\s+Mini Mode\*/);
    assert.match(section, /1\.17\.10/);
    assert.match(section, /Typing `opencode` yourself always gives the\s+full TUI/);
    assert.match(section, /a message whose text has an empty\s+line in it may get no mark/);
    assert.match(section, /after a NexTerm restart it resumes through the\s+usual lookup/);
    // The kept answer and the PATH it is asked on (X-03); resumed history not claimed before O12 (X-02).
    assert.match(section, /upgraded or replaced while NexTerm runs \(to V2, say\), restart\s+NexTerm or turn the setting off/);
    assert.match(section, /nvm, mise, asdf\s+or volta, or from a PowerShell alias/);
    assert.match(section, /still to\s+be checked against a real resume \(WINDOWS_VERIFICATION\.md V50 O12\)/);
    assert.doesNotMatch(section, /history a resumed conversation prints\s+is not marked/);
    assert.match(section, /the reprint is not marked unless a message was still waiting for\s+its echo/);
    const settings = readme.slice(readme.indexOf('### Settings and themes'));
    assert.match(settings.slice(0, 1600), /\*OpenCode in Mini Mode\*/);
    const doc = read('../../WINDOWS_VERIFICATION.md');
    const v50 = doc.slice(doc.indexOf('### V50 — '));
    assert.ok(v50.length > 30, 'no V50');
    const body = v50.slice(0, v50.indexOf('\n## '));
    for (let i = 1; i <= 13; i += 1) assert.match(body, new RegExp(`\\*\\*O${i} `), `V50 has no O${i}`);
    assert.match(body, /On macOS: O1 to O3, O6, O8 and O10/);
    assert.match(body, /before mini has drawn: write down any mark on the history/);
    assert.match(body, /\*\*O13a upgraded mid-run\.\*\*/);
    assert.match(body, /\*\*O13b a folder-pinned version\.\*\*/);
    assert.match(doc.slice(doc.indexOf('### V49 — '), doc.indexOf('### V50 — ')), /\*\*C12 OpenCode\*\*: see V50/);
  });
});
