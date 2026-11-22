/**
 * Marks for the messages sent to Claude Code (src/lib/agentMessageMarks.js).
 *
 * The bytes real Claude Code 2.1.327 drew in a 120x40 pty, recorded by the
 * Queen on 2026-11-18 and sanitised (the scratch path, the usage-limit line,
 * the resume id and the plan name in the header, `Plan-A Std`, replaced by
 * ASCII of the same width; every escape sequence as it was), are replayed
 * through xterm's own headless build:
 * fixtures/claude_code/normal-screen.* with CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1,
 * fixtures/claude_code/fullscreen.* without it. The tracker's submit hook is
 * called where the user pressed Enter, and a scan after every small chunk —
 * far more often than the registry scans, so a half-drawn frame is scanned
 * too. The rest are synthetic cases shaped like Claude Code's output, the
 * life of a mark, and the scan scheduler with a fake clock.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  MAX_MESSAGE_MARKS,
  createScanScheduler,
  findLiveInputBox,
  bufferReader,
  ECHO_ROWS_ABOVE_BOX,
  isRuleRow,
  matchPending,
  normaliseMessageText,
  noteTerminalInput,
  trackAgentMessageMarks,
} from '../../src/lib/agentMessageMarks.js';
import { hitPromptMark, mergeMarks, promptJumpLine, trackPromptMarks } from '../../src/lib/promptMarks.js';
import { submitsLine } from '../../src/lib/tabActivity.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { PERSIST_KEY, setAgentLaunchObserver, useTerminalStore as T } from '../../src/stores/terminalStore.js';

if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

const { Terminal: HeadlessTerminal } = headless;

const fixture = (name) => new URL(`./fixtures/claude_code/${name}`, import.meta.url);
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const makeTerm = ({ cols = 120, rows = 40, scrollback = 5000 } = {}) =>
  new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
const lineText = (term, line) => term.buffer.active.getLine(line)?.translateToString(true).trimEnd() ?? null;
const markTexts = (term, tracker) => tracker.lines.map((line) => lineText(term, line));

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

/** Rows that are box or rule rows on the screen now. */
function liveRows(term) {
  const box = findLiveInputBox(bufferReader(term));
  const rules = [];
  const b = term.buffer.active;
  for (let y = 0; y < b.length; y += 1) if (isRuleRow(lineText(term, y) ?? '', term.cols)) rules.push(y);
  return { box, rules };
}

/**
 * Replays a recorded run: `chunk` bytes at a time with a scan after each;
 * `noteTyped` at each "type" event and `noteSubmit` at each "enter" one;
 * `onDump(note)` at each event.
 */
async function replay(name, { chunk = 48, onDump = null, onChunk = null, tracker: given = null, term: givenTerm = null } = {}) {
  const raw = readFileSync(fixture(`${name}.bin`));
  const ev = JSON.parse(readFileSync(fixture(`${name}.events.json`), 'utf8'));
  const term = givenTerm ?? makeTerm({ cols: ev.cols, rows: ev.rows });
  const decorations = fakeDecorations();
  const tracker = given ?? trackAgentMessageMarks(term, { decorate: decorations.decorate, color: '#3794ff' });
  let pos = 0;
  const feed = async (to) => {
    while (pos < to) {
      const end = Math.min(to, pos + chunk);
      await write(term, raw.subarray(pos, end));
      pos = end;
      onChunk?.(term, tracker);
      tracker.scan();
    }
  };
  for (const e of ev.events) {
    await feed(e.offset);
    if (e.note.startsWith('type')) tracker.noteTyped();
    if (e.note.startsWith('enter')) tracker.noteSubmit();
    await onDump?.(e.note, term, tracker);
  }
  const rest = async () => feed(raw.length);
  return { term, tracker, decorations, rest, events: ev.events };
}

describe('Message marks: the recorded Claude Code run on the normal screen (AC3)', () => {
  test('AMM-01: two messages, two marks, on their echoed rows; never the live box or a rule', async () => {
    const boxRows = { 'enter ALPHA7QX': [6], 'turn done ALPHA7QX': [12], 'enter BRAVO8ZK': [12, 13], 'turn done BRAVO8ZK': [19], exit: [19] };
    const seen = [];
    for (const chunk of [48, 7, 1024]) {
      const { term, tracker, decorations, rest } = await replay('normal-screen', {
        chunk,
        onDump: (note, t, tr) => {
          assert.equal(t.buffer.active.type, 'normal', `${note}: the normal screen`);
          const { box, rules } = liveRows(t);
          assert.ok(box, `${note}: the live box is found`);
          for (const row of boxRows[note] ?? []) assert.ok(!tr.lines.includes(row), `${note}: a mark on the live box row ${row}`);
          for (const row of tr.lines) {
            assert.ok(!rules.includes(row), `${note}: a mark on the rule row ${row}`);
            assert.ok(row < box.top, `${note}: a mark at or below the box top`);
          }
          if (note === 'exit') seen.push({ chunk, lines: tr.lines, texts: markTexts(t, tr), text: tr.marks.map((m) => m.text) });
        },
      });
      const exit = seen[seen.length - 1];
      assert.deepEqual(exit.lines, [5, 11], `chunk ${chunk}: marks at ${JSON.stringify(exit.texts)}`);
      assert.ok(exit.texts[0].startsWith(`❯ ${ALPHA}`), exit.texts[0]);
      assert.ok(exit.texts[1].startsWith('❯ Reply with only the word ok. Token BRAVO8ZK'), exit.texts[1]);
      assert.deepEqual(exit.text, [normaliseMessageText(ALPHA), normaliseMessageText(BRAVO)], 'the second covers both of its rows');
      assert.equal(decorations.live().length, 2, 'one decoration per mark');
      assert.ok(decorations.live().every((d) => d.color === '#3794ff'));
      // What Claude Code prints after /exit marks nothing more.
      await rest();
      assert.deepEqual(tracker.lines, [5, 11], `chunk ${chunk}: after the exit`);
      tracker.dispose();
      term.dispose();
    }
  });

  test('AMM-02: the echo is one row above where the box was at Enter (why the cursor row cannot be marked)', async () => {
    for (const chunk of [48, 7, 1024]) {
      let atEnter = null;
      const { tracker } = await replay('normal-screen', {
        chunk,
        onDump: (note, t) => {
          if (note === 'enter BRAVO8ZK') atEnter = findLiveInputBox(bufferReader(t));
        },
      });
      assert.deepEqual([atEnter.top, atEnter.promptRow, atEnter.bottom], [11, 12, 14], `chunk ${chunk}`);
      assert.equal(normaliseMessageText(atEnter.text), normaliseMessageText(BRAVO), 'the box text across its two rows');
      // On the box top read at Enter: within the rows its echo can be on (two above it, U-02).
      assert.equal(tracker.lines[1], 11, `chunk ${chunk}`);
      assert.ok(tracker.lines[1] >= atEnter.top - ECHO_ROWS_ABOVE_BOX);
    }
  });
});

describe('Message marks: Claude Code on the alternate screen (AC4)', () => {
  test('AMM-03: fullscreen: no mark, no read while the alternate buffer is up, and no jump', async () => {
    let alternateScans = 0;
    let readsWhileAlternate = 0;
    let checked = 0;
    const prompts = { lines: [], visible: true };
    const { tracker, term, rest } = await replay('fullscreen', {
      onChunk: (t, tr) => {
        if (t.buffer.active.type !== 'alternate') return;
        const before = tr.stats.reads;
        tr.scan();
        tr.noteSubmit();
        readsWhileAlternate += tr.stats.reads - before;
        alternateScans += 1;
        assert.equal(promptJumpLine(t.buffer.active, mergeMarks(prompts, tr), 'previous'), null);
        assert.equal(promptJumpLine(t.buffer.active, mergeMarks(prompts, tr), 'next'), null);
        checked += 1;
      },
    });
    await rest();
    assert.ok(alternateScans > 20 && checked > 20, 'the run is on the alternate screen');
    assert.equal(readsWhileAlternate, 0, 'nothing read on the alternate screen');
    assert.equal(tracker.marks.length, 0);
    assert.equal(term.buffer.active.type, 'normal', 'back on the normal screen after /exit');
  });
});

/** A Claude-shaped screen: the transcript, then the box between two rules and a status row. */
const rule = (cols) => '\u2500'.repeat(cols);
function claudeScreen(cols, transcript, boxRows = ['\u276F\u00A0']) {
  const out = [];
  for (const row of transcript) out.push(row);
  out.push(rule(cols));
  for (const row of boxRows) out.push(row);
  out.push(rule(cols));
  out.push('  ⏸ manual mode on');
  return out;
}

/**
 * A tiny Claude Code: the way the classic renderer draws (log-update style),
 * each row of the transcript printed once, as it comes, above the live
 * region — the box between its rules and the status row — which is redrawn
 * in place each time: the cursor goes back up over it, everything from there
 * down is erased, then the new transcript rows and the live region follow.
 * `out` is how its output reaches xterm (the registry's path, in AMM-24).
 */
function fakeClaude(term, { floorRow = 0, out = (data) => write(term, data) } = {}) {
  const transcript = [];
  let printed = 0;
  let liveHeight = null;
  let box = ['\u276F\u00A0'];
  const draw = async () => {
    let data = liveHeight === null ? `\x1b[${floorRow + 1};1H` : `\r\x1b[${liveHeight}A`;
    data += '\x1b[J';
    for (; printed < transcript.length; printed += 1) data += `${transcript[printed]}\r\n`;
    const live = claudeScreen(term.cols, [], box);
    data += live.join('\r\n');
    liveHeight = live.length - 1;
    await out(data);
  };
  const reset = () => {
    printed = 0;
    liveHeight = null;
  };
  const wrap = (text) => {
    const width = term.cols - 2;
    const rows = [];
    let rest = text;
    while (rest.length > width) {
      rows.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    rows.push(rest);
    return rows;
  };
  return {
    transcript,
    async type(text) {
      const rows = wrap(text);
      box = rows.map((r, i) => (i === 0 ? `\u276F\u00A0${r}` : `  ${r}`));
      await draw();
    },
    async placeholder(text) {
      box = [`\u276F\u00A0${text}`];
      await draw();
    },
    clearBox() {
      box = ['\u276F\u00A0'];
    },
    setBox(rows) {
      box = rows;
    },
    async echo(text, { rows = null } = {}) {
      const lines = rows ?? wrap(text);
      lines.forEach((r, i) => transcript.push(i === 0 ? `\u276F ${r}` : `  ${r}`));
      transcript.push('');
      transcript.push('⏺ ok');
      transcript.push('');
      await draw();
    },
    async say(row) {
      transcript.push(row);
      await draw();
    },
    draw,
    /** After the screen was erased: draw again from `row`, the whole transcript. */
    redrawFrom(row) {
      floorRow = row;
      reset();
    },
  };
}

/** Type, Enter (the hook), the box empties, Claude Code echoes; a scan after each draw. */
async function send(cc, tracker, text, { echo = text, echoRows = null } = {}) {
  tracker.noteTyped();
  await cc.type(text);
  tracker.scan();
  const queued = tracker.noteSubmit();
  cc.clearBox();
  if (echo !== null) await cc.echo(echo, { rows: echoRows });
  else await cc.draw();
  tracker.scan();
  return queued;
}

describe('Message marks: Claude-shaped cases (AC5)', () => {
  test('AMM-04: a wrapped message is marked once, on its first row', async () => {
    const term = makeTerm({ cols: 40, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    const long = 'please summarise the whole repository and list every module with its purpose';
    await send(cc, tracker, long);
    assert.equal(tracker.lines.length, 1);
    assert.ok(markTexts(term, tracker)[0].startsWith('❯ please summarise'), markTexts(term, tracker)[0]);
    assert.ok(lineText(term, tracker.lines[0] + 1).startsWith('  '), 'its second row is not marked');
    tracker.scan();
    assert.equal(tracker.lines.length, 1, 'a scan again marks nothing more');
  });

  test('AMM-05: a Korean message that wraps without spaces is marked', async () => {
    const term = makeTerm({ cols: 30, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    const korean = '이저장소의모든모듈을설명하고각모듈의역할을정리해줘그리고테스트도';
    // Wide characters: 14 per 28 columns, wrapped by Claude Code without spaces.
    const rows = [korean.slice(0, 14), korean.slice(14, 28), korean.slice(28)];
    tracker.noteTyped();
    await cc.placeholder(`${rows[0]}`);
    const reader = bufferReader(term);
    assert.ok(findLiveInputBox(reader), 'the box is found');
    tracker.noteSubmit();
    cc.clearBox();
    await cc.echo(korean, { rows });
    tracker.scan();
    assert.equal(tracker.lines.length, 1, JSON.stringify(markTexts(term, tracker)));
    assert.equal(tracker.marks[0].text, normaliseMessageText(korean));
  });

  test('AMM-06: a paste placeholder in the box is matched by position; an echoed /model is marked', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    await send(cc, tracker, 'first message');
    tracker.noteTyped();
    await cc.placeholder('[Pasted text #1 +40 lines]');
    const queued = tracker.noteSubmit();
    assert.deepEqual(queued, { positional: true, text: '' });
    cc.clearBox();
    await cc.echo('line one of the paste', { rows: ['line one of the paste', 'line two of the paste'] });
    tracker.scan();
    await send(cc, tracker, '/model');
    const texts = markTexts(term, tracker);
    assert.deepEqual(texts.map((t) => t.slice(0, 12)), ['❯ first mess', '❯ line one o', '❯ /model'], JSON.stringify(texts));
  });

  test('AMM-07: two submits while Claude Code works, echoed later and in order, are both marked in order', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    await send(cc, tracker, 'start the long task', { echo: null });
    await send(cc, tracker, 'and then run the tests', { echo: null });
    assert.equal(tracker.pending.length, 2, 'both wait for their echo');
    assert.equal(tracker.lines.length, 0);
    await cc.echo('start the long task');
    tracker.scan();
    await cc.echo('and then run the tests');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ start the long task', '❯ and then run the tests']);
    assert.equal(tracker.pending.length, 0);
  });

  test('AMM-08: an empty Enter and a submit with no box make no mark', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    await cc.draw();
    assert.equal(tracker.noteSubmit(), null, 'an empty Enter queues nothing');
    // A menu has the screen: no box.
    await write(term, '\x1b[H\x1b[2J Select model\r\n ❯ 1. Default\r\n   2. Opus\r\n');
    tracker.noteTyped();
    assert.equal(tracker.noteSubmit(), null, 'no box, nothing queued');
    tracker.scan();
    assert.equal(tracker.lines.length, 0);
    assert.equal(tracker.pending.length, 0);
  });

  test('AMM-09: a `❯ ` row inside the live box is never marked, even with a pending text that matches it', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    await send(cc, tracker, 'earlier message');
    tracker.noteTyped();
    await cc.type('hello there');
    assert.deepEqual(tracker.noteSubmit(), { positional: false, text: 'hellothere' });
    // Claude Code has not taken the text out of its box yet, and draws it
    // with a plain space, as an echo; and a second row in the box that starts
    // with the glyph too.
    cc.setBox(['❯ hello there', '❯ hello there']);
    await cc.draw();
    const box = findLiveInputBox(bufferReader(term));
    assert.ok(box && lineText(term, box.promptRow).startsWith('❯ hello there'), 'the box is there, with the text');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ earlier message'], 'nothing in the box is marked');
    assert.ok(tracker.lines.every((l) => l < box.top));
    assert.equal(tracker.pending.length, 1, 'still waiting for its echo');
    // A mark that ends up at or below the box top goes at the next scan.
    cc.clearBox();
    await cc.echo('hello there');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ earlier message', '❯ hello there']);
    await write(term, `\x1b[${tracker.lines[1] + 1};1H\x1b[J${rule(60)}\r\n❯\u00A0\r\n${rule(60)}`);
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ earlier message'], 'the box moved up over it');
  });

  test('AMM-10: a starship `❯ claude` row above the floor is not marked; a `❯` row that matches nothing is not either', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    // The shell: a starship prompt, then `claude` typed at it and Enter (no agent yet).
    await write(term, '~/work\r\n❯ claude');
    tracker.noteShellSubmit();
    await write(term, '\r\n');
    assert.equal(tracker.floor, 2, 'the floor is the row after the submit');
    const cc = fakeClaude(term, { floorRow: 2 });
    // The first message is "claude" too: only Claude Code's echo is marked.
    await send(cc, tracker, 'claude');
    assert.deepEqual(tracker.lines.map((l) => l >= 2), [true]);
    assert.deepEqual(markTexts(term, tracker), ['❯ claude']);
    assert.ok(tracker.lines[0] > 1, 'not the shell prompt row');
    // A row Claude Code draws that nobody sent (a tool's output, a menu).
    await cc.say('❯ some row nobody sent');
    tracker.scan();
    assert.equal(tracker.lines.length, 1);
  });

  test('AMM-25: reports, focus events and escape keys are not typing: an empty Enter after them queues nothing and marks nothing (U-03)', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    // A `❯` row nobody sent this session (a resumed conversation's).
    await cc.say('❯ yes, go ahead');
    await cc.say('');
    // The registry's path: every onData of the terminal, while Claude Code runs.
    const input = (data) => noteTerminalInput(tracker, data, { submits: submitsLine, agentRuns: () => true });
    // What xterm sends by itself once Claude Code has asked (CSI ? 1004 h,
    // CSI c, CSI > 0 q, CSI ? u): focus in, the DA1, XTVERSION and kitty
    // keyboard replies; then a focus out and an arrow key.
    const reports = ['\x1b[I', '\x1b[?1;2c', '\x1bP>|xterm.js(6.0.0)\x1b\\', '\x1b[?0u', '\x1b[O', '\x1b[A'];
    const kinds = reports.map((data) => input(data));
    assert.equal(input('\r'), 'submit', 'an Enter while Claude Code runs');
    assert.deepEqual(tracker.pending, [], 'an empty Enter queues nothing');
    await cc.draw();
    tracker.scan();
    assert.equal(tracker.lines.length, 0, 'and marks nothing');
    assert.deepEqual(kinds, reports.map(() => null), 'none of them is typing');
    // Real typing still counts: typed, then Enter before Claude Code has drawn it.
    assert.equal(input('y'), 'typed');
    assert.equal(input('\r'), 'submit');
    assert.deepEqual(tracker.pending, [{ positional: true, text: '' }]);
    cc.clearBox();
    await cc.echo('y');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ y'], 'its echo, not the older row');
  });

  test('AMM-26: a resumed conversation: its `❯ yes, go ahead` row answers neither an empty Enter nor a later `yes`; only the new echo is marked (U-02)', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    // The shell prompt, then NexTerm's resume line: the floor goes below the prompt first (resumeAgent).
    await write(term, '~/work\r\n❯ ');
    tracker.noteShellSubmit();
    await write(term, 'claude --resume 00000000-0000-4000-8000-000000000000\r\n');
    const cc = fakeClaude(term, { floorRow: term.buffer.active.cursorY });
    // Claude Code prints the conversation it resumes, then its box.
    cc.transcript.push('❯ yes, go ahead', '', '⏺ Done.', '', '❯ and run the tests', '', '⏺ All passed.', '');
    await cc.draw();
    tracker.scan();
    const history = [2, 6];
    assert.deepEqual(history.map((y) => lineText(term, y)), ['❯ yes, go ahead', '❯ and run the tests']);
    assert.deepEqual(tracker.lines, [], 'the resumed rows are not marked');
    // An Enter on an empty box with something typed before it (a positional
    // entry), with no mark yet: no older row takes it.
    tracker.noteTyped();
    assert.deepEqual(tracker.noteSubmit(), { positional: true, text: '' });
    tracker.scan();
    assert.deepEqual(tracker.lines, [], 'a positional entry takes no row from before its submit');
    // `yes`: the history row starts with it, but only the new echo is marked.
    assert.deepEqual(await send(cc, tracker, 'yes'), { positional: false, text: 'yes' });
    assert.deepEqual(markTexts(term, tracker), ['❯ yes']);
    assert.ok(tracker.lines[0] > history[1]);
    assert.deepEqual(tracker.pending, [], 'its own entry used, the older positional one dropped');
    // An empty Enter again, and Claude Code goes on printing: no history row is marked, now or later.
    tracker.noteTyped();
    tracker.noteSubmit();
    await cc.say('⏺ Sure.');
    tracker.scan();
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ yes']);
    // Exact matches before prefix matches, and an entry answers no row above where it can be.
    assert.equal(matchPending([{ text: 'yes' }, { text: 'yesgoahead' }], 'yesgoahead'), 1);
    assert.equal(matchPending([{ text: 'yes' }], 'yesgoahead'), 0, 'a prefix when nothing equals it');
    assert.equal(matchPending([{ text: 'yes', from: 10 }], 'yes', 9), -1);
    assert.equal(matchPending([{ text: 'yes', from: 10 }], 'yes', 10), 0);
  });

  test('AMM-30: `❯ yes, go ahead` two rows above the box top, then a `yes` submit: the exact new echo is marked, the history row is not (V-02)', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    // A message nobody answered, right above the box (a resumed conversation's last one).
    cc.transcript.push('❯ yes, go ahead', '');
    await cc.draw();
    tracker.scan();
    const box = findLiveInputBox(bufferReader(term));
    const history = box.top - ECHO_ROWS_ABOVE_BOX;
    assert.equal(lineText(term, history), '❯ yes, go ahead', 'on the highest row the echo of a submit now can be on');
    assert.deepEqual(await send(cc, tracker, 'yes'), { positional: false, text: 'yes' });
    assert.deepEqual(markTexts(term, tracker), ['❯ yes'], 'the exact echo, not the row it is a prefix of');
    assert.equal(tracker.lines[0], box.top, 'the echo on the box top read at Enter');
    assert.deepEqual(tracker.pending, []);
    tracker.scan();
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ yes'], 'and nothing more later');
    // An entry some candidate equals takes no prefix match in that scan; a prefix still answers when nothing equals it.
    assert.equal(matchPending([{ text: 'yes', exact: true }], 'yesgoahead'), -1);
    assert.equal(matchPending([{ text: 'yes', exact: true }], 'yes'), 0);
    assert.equal(matchPending([{ text: 'yes', exact: false }], 'yesgoahead'), 0);
  });

  test('AMM-28: a bash-mode box (`!`) and a full-width rule in the transcript above the echoes: no box, so no mark is lost (U-05)', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    cc.transcript.push(rule(60), '');
    await send(cc, tracker, 'first message');
    await send(cc, tracker, 'second message');
    assert.deepEqual(markTexts(term, tracker), ['❯ first message', '❯ second message']);
    // Bash mode: the box's row starts with `!`; the transcript rule and the box's upper rule enclose both echoes.
    cc.setBox(['! ls']);
    await cc.draw();
    assert.equal(findLiveInputBox(bufferReader(term)), null, 'the lowest pair of rules holds no `❯` row: no box at all');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ first message', '❯ second message'], 'no mark lost');
    cc.clearBox();
    await cc.draw();
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ first message', '❯ second message']);
  });
});

describe('Message marks: the life of a mark (AC6)', () => {
  test('AMM-11: ED 2 then a reprint: marks on changed rows go, reprinted messages are marked again, a row that no longer qualifies is not', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    await send(cc, tracker, 'alpha message');
    await send(cc, tracker, 'bravo message');
    assert.equal(tracker.lines.length, 2);
    // ED 2: the screen is erased; Claude Code reprints with the first message gone (compacted).
    await write(term, '\x1b[2J\x1b[H');
    cc.transcript.splice(0, cc.transcript.length);
    cc.redrawFrom(term.buffer.active.cursorY);
    cc.transcript.push('✻ Conversation compacted', '');
    await cc.echo('bravo message');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ bravo message'], JSON.stringify(markTexts(term, tracker)));
    for (const line of tracker.lines) assert.ok(lineText(term, line).startsWith('❯ '));
  });

  test('AMM-12: ED 3 then a reprint: the same', async () => {
    const term = makeTerm({ cols: 60, rows: 12, scrollback: 500 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    for (const word of ['one', 'two', 'three', 'four']) {
      await send(cc, tracker, `message ${word}`);
      await cc.say(`long answer for ${word}`);
      for (const n of [1, 2, 3]) await cc.say(`more output ${n}`);
    }
    assert.equal(tracker.lines.length, 4);
    // /clear: the scrollback and the screen go; Claude Code reprints its header and one message.
    await write(term, '\x1b[3J\x1b[2J\x1b[H');
    cc.transcript.splice(0, cc.transcript.length);
    cc.redrawFrom(0);
    await cc.echo('message four');
    tracker.scan();
    assert.deepEqual(markTexts(term, tracker), ['❯ message four']);
  });

  test('AMM-13: narrower then wider: every surviving mark is still on a `❯ ` row', async () => {
    const { term, tracker } = await replay('normal-screen');
    for (const cols of [80, 50, 120, 140]) {
      term.resize(cols, 40);
      await write(term, '');
      tracker.scan();
      for (const text of markTexts(term, tracker)) assert.ok(text.startsWith('❯ '), `${cols} columns: "${text}"`);
    }
  });

  test('AMM-14: a small scrollback that trims takes the marks of trimmed rows with their decorations', async () => {
    const term = makeTerm({ cols: 60, rows: 10, scrollback: 50 });
    const decorations = fakeDecorations();
    const tracker = trackAgentMessageMarks(term, { decorate: decorations.decorate });
    const cc = fakeClaude(term);
    await send(cc, tracker, 'early message');
    assert.equal(tracker.lines.length, 1);
    // Claude Code prints a long answer in its classic renderer: plain lines that scroll.
    for (let i = 0; i < 200; i += 1) cc.transcript.push(`output line ${i}`);
    await cc.draw();
    tracker.scan();
    assert.equal(tracker.marks.length, 0, 'trimmed with its line');
    assert.equal(decorations.live().length, 0);
  });

  test('AMM-15: each kind has its own limit: the oldest message marks go and the shell marks stay, and the other way round', async () => {
    const term = makeTerm({ cols: 60, rows: 40 });
    const messages = trackAgentMessageMarks(term, { limit: 2 });
    const prompts = trackPromptMarks(term, { limit: 2 });
    await write(term, 'PS C:\\> ');
    prompts.mark();
    await write(term, 'claude\r\n');
    messages.noteShellSubmit();
    const cc = fakeClaude(term, { floorRow: 1 });
    for (const word of ['a1', 'b2', 'c3']) await send(cc, messages, `message ${word}`);
    assert.deepEqual(markTexts(term, messages), ['❯ message b2', '❯ message c3']);
    assert.equal(prompts.lines.length, 1, 'the shell mark is untouched');
    assert.equal(MAX_MESSAGE_MARKS, 500);
    // Three more shell prompts below: the oldest shell mark goes, the message marks stay.
    await write(term, '\r\n');
    for (let i = 0; i < 3; i += 1) {
      await write(term, '\r\nPS C:\\> ');
      prompts.mark();
    }
    assert.equal(prompts.lines.length, 2);
    assert.equal(messages.lines.length, 2, 'message marks untouched by the shell limit');
  });

  test('AMM-16: Terminal: Clear drops every message mark (through the prompt marks\' onClear, as the registry wires it); the floor is the cursor row', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const decorations = fakeDecorations();
    const tracker = trackAgentMessageMarks(term, { decorate: decorations.decorate });
    const prompts = trackPromptMarks(term, { onClear: () => tracker.afterClear() });
    const cc = fakeClaude(term);
    await send(cc, tracker, 'one');
    await send(cc, tracker, 'two');
    assert.equal(tracker.marks.length, 2);
    // clearTerminal: cursorOnNewestMark, term.clear(), afterClear.
    const marked = prompts.cursorOnNewestMark();
    term.clear();
    prompts.afterClear(marked);
    assert.equal(tracker.marks.length, 0);
    assert.equal(decorations.live().length, 0);
    assert.equal(tracker.floor, term.buffer.active.baseY + term.buffer.active.cursorY);
  });

  test('AMM-17: once Claude Code stops, scans stop (the scheduler), pending goes, and the marks stay', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    await send(cc, tracker, 'kept message');
    tracker.noteTyped();
    await cc.type('never echoed');
    tracker.noteSubmit();
    let running = true;
    let scans = 0;
    let clock = 0;
    const timers = [];
    const scheduler = createScanScheduler({
      scan: () => {
        scans += 1;
        tracker.scan();
      },
      wanted: () => running,
      now: () => clock,
      setTimer: (fn, ms) => timers.push({ fn, at: clock + ms }),
      clearTimer: () => {},
    });
    running = false;
    tracker.stop();
    for (let i = 0; i < 50; i += 1) {
      scheduler.poke();
      clock += 100;
      for (const t of timers.splice(0)) t.fn();
    }
    assert.equal(scans, 0, 'no scan after the stop');
    assert.equal(tracker.pending.length, 0);
    assert.deepEqual(markTexts(term, tracker), ['❯ kept message']);
  });

  test('AMM-18: restored scrollback has no message marks', async () => {
    const term = makeTerm({ cols: 120, rows: 40 });
    const tracker = trackAgentMessageMarks(term);
    // What NexTerm writes back at a restart: the saved text as plain output.
    const saved = readFileSync(fixture('normal-screen.bin'));
    await write(term, saved);
    await write(term, '\r\n\x1b[2m── restored ──\x1b[22m\r\n');
    tracker.scan();
    assert.equal(tracker.marks.length, 0, 'nothing pending, nothing sent: nothing marked');
  });

  test('AMM-27: a row printed directly under a marked echo (an interrupt notice) keeps the mark, also on a reprint; another text on its row does not (U-04)', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    const cc = fakeClaude(term);
    const notice = '  ⎿  Interrupted · What should Claude do instead?';
    await send(cc, tracker, 'hello there');
    const [line] = tracker.lines;
    assert.equal(lineText(term, line), '❯ hello there');
    // The notice on the row right under the message, with no blank row between.
    await write(term, `\x1b7\x1b[${line + 2};1H\x1b[2K${notice}\x1b8`);
    tracker.scan();
    assert.deepEqual(tracker.lines, [line], 'the mark stays');
    // A redraw (ED 2) reprints the message, the notice under it, lower down: marked again (the reprint path, same rule).
    await write(term, '\x1b[2J\x1b[H');
    cc.transcript.splice(0, cc.transcript.length, '✻ Conversation compacted', '', '❯ hello there', notice, '');
    cc.redrawFrom(0);
    await cc.draw();
    tracker.scan();
    assert.deepEqual(tracker.lines, [2]);
    assert.deepEqual(markTexts(term, tracker), ['❯ hello there']);
    // Another text on its row: the mark goes, and nothing takes it back.
    await write(term, `\x1b7\x1b[3;1H\x1b[2K❯ hello there, and more\x1b8`);
    tracker.scan();
    assert.deepEqual(tracker.lines, [], 'a row that reads as another text loses it');
  });

  test('AMM-29: a resumed history with `❯ yes`, and `❯ continue` with an interrupt notice under it: sending `yes` and `continue` marks only the two new echoes, also after more scans (V-01)', async () => {
    const term = makeTerm({ cols: 60, rows: 30 });
    const tracker = trackAgentMessageMarks(term);
    // The shell prompt, then NexTerm's resume line: the floor goes below the prompt first (resumeAgent).
    await write(term, '~/work\r\n❯ ');
    tracker.noteShellSubmit();
    await write(term, 'claude --resume 00000000-0000-4000-8000-000000000000\r\n');
    const cc = fakeClaude(term, { floorRow: term.buffer.active.cursorY });
    const notice = '  ⎿  Interrupted · What should Claude do instead?';
    // The resumed conversation, at and below the floor: in the range every scan reads.
    cc.transcript.push('❯ yes', '', '⏺ Done.', '', '❯ continue', notice, '');
    await cc.draw();
    tracker.scan();
    const history = [2, 6];
    assert.equal(tracker.floor, history[0]);
    assert.deepEqual(history.map((y) => lineText(term, y)), ['❯ yes', '❯ continue']);
    assert.equal(lineText(term, history[1] + 1), notice);
    assert.deepEqual(tracker.lines, [], 'the resumed rows are not marked');
    // The same short replies again: each new echo takes its own submit.
    await send(cc, tracker, 'yes');
    await send(cc, tracker, 'continue');
    const echoes = tracker.lines;
    assert.deepEqual(markTexts(term, tracker), ['❯ yes', '❯ continue']);
    assert.ok(echoes.every((y) => y > history[1] + 1), JSON.stringify(echoes));
    // Claude Code answers and goes on printing; a scan after each draw, and more.
    for (let i = 0; i < 4; i += 1) {
      await cc.say(`⏺ streamed line ${i}`);
      tracker.scan();
      tracker.scan();
    }
    assert.deepEqual(tracker.lines, echoes, 'only the two new echoes are marked, the history rows never');
    assert.deepEqual(tracker.pending, []);
  });
});

describe('Message marks: Claude Code started by NexTerm itself (F7)', () => {
  test('AMM-23: NexTerm tells the tracker before it types `claude`; the starship `❯ claude` row it is typed at is never marked', async () => {
    const term = makeTerm({ cols: 80, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    // The same terminal as nobody told: what the floor prevents.
    const untold = trackAgentMessageMarks(term);
    const order = [];
    const previous = setAgentLaunchObserver((tabId) => {
      order.push(`launch ${tabId}`);
      tracker.noteShellSubmit();
    });
    const original = mockBridge.invoke;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_write') {
        order.push(`write ${args?.data}`);
        return Promise.resolve(null);
      }
      return original.call(this, command, args, ...rest);
    };
    let typed = null;
    try {
      T.getState().dispose();
      localStorage.removeItem(PERSIST_KEY);
      T.setState({ tabs: [], activeTabId: null, isInitialized: false });
      await T.getState().init();
      const tab = await T.getState().createTab();
      // The shell has drawn its prompt (starship's two lines), and said so.
      await write(term, '~/work\r\n❯ ');
      await mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: 0 });
      const agent = await T.getState().startAgent(tab.id, 'claude');
      assert.ok(agent, 'Claude Code was started');
      typed = order.filter((o) => o.startsWith('write ')).map((o) => o.slice(6));
      assert.deepEqual(order.slice(0, 2), [`launch ${tab.id}`, `write claude --session-id ${agent.sessionId}\r`], 'told first, then typed');
    } finally {
      mockBridge.invoke = original;
      setAgentLaunchObserver(previous);
      T.getState().dispose();
      localStorage.removeItem(PERSIST_KEY);
    }
    assert.equal(tracker.floor, 2, 'the floor is the row after the one it is typed at');
    // The shell echoes the line on the prompt row; Claude Code draws below it.
    await write(term, `${typed[0]}\n`);
    const cc = fakeClaude(term, { floorRow: term.buffer.active.cursorY });
    // The first message is `claude`, a prefix of the typed line.
    for (const t of [tracker, untold]) t.noteTyped();
    await cc.type('claude');
    for (const t of [tracker, untold]) t.noteSubmit();
    cc.clearBox();
    // A scan as Claude Code draws its empty box, before the echo: the prompt
    // row is the only candidate then (with the echo there, its exact match
    // would come first, V-02).
    await cc.draw();
    for (const t of [tracker, untold]) t.scan();
    await cc.echo('claude');
    for (const t of [tracker, untold]) t.scan();
    assert.ok(lineText(term, 1).startsWith('❯ claude --session-id'), lineText(term, 1));
    assert.deepEqual(markTexts(term, tracker), ['❯ claude'], 'only Claude Code\'s echo');
    assert.ok(!tracker.lines.includes(1));
    assert.deepEqual(untold.lines, [1], 'without the floor the prompt row would have taken it');
  });
});

describe('Message marks: both kinds on the click and the keys (AC7)', () => {
  test('AMM-19: previous, next and the hit test go to the nearest of either kind, in buffer order', () => {
    const shell = { lines: [10, 200], visible: true };
    const messages = { lines: [40, 120, 160], visible: true };
    const both = mergeMarks(shell, messages);
    assert.deepEqual(both.lines, [10, 40, 120, 160, 200]);
    assert.equal(both.previous(130), 120);
    assert.equal(both.previous(40), 10);
    assert.equal(both.next(10, 1000), 40);
    assert.equal(both.next(160, 1000), 200);
    assert.equal(both.next(200, 1000), 1000, 'past the newest, the bottom');
    // A press at the message at 120 of 400 lines on a 400px track.
    assert.equal(both.hit({ offsetY: 121, rulerHeight: 400, bufferLength: 400 }), 120);
    assert.equal(hitPromptMark({ offsetY: 121, rulerHeight: 400, bufferLength: 400, lines: shell.lines }), null, 'the shell marks alone have none there');
    // Hidden (the setting off): no hit, previous and next still answer.
    const hidden = mergeMarks({ ...shell, visible: false }, { ...messages, visible: false });
    assert.equal(hidden.hit({ offsetY: 121, rulerHeight: 400, bufferLength: 400 }), null);
    assert.equal(hidden.previous(130), 120);
    assert.equal(mergeMarks(null, undefined).next(0, 0), null);
  });

  test('AMM-20: promptJumpLine: none on the alternate screen, the merged lines on the normal one', () => {
    const marks = mergeMarks({ lines: [5], visible: true }, { lines: [11], visible: true });
    assert.equal(promptJumpLine({ type: 'normal', viewportY: 20, baseY: 20 }, marks, 'previous'), 11);
    assert.equal(promptJumpLine({ type: 'normal', viewportY: 11, baseY: 20 }, marks, 'previous'), 5);
    assert.equal(promptJumpLine({ type: 'alternate', viewportY: 0, baseY: 0 }, marks, 'previous'), null);
  });
});

describe('Message marks: the cost (AC12)', () => {
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

  test('AMM-21: no Claude Code: no scan, no timer, no read across 10,000 lines of output', async () => {
    const term = makeTerm({ cols: 80, rows: 24, scrollback: 1000 });
    const tracker = trackAgentMessageMarks(term);
    const time = fakeTime();
    let scans = 0;
    const scheduler = createScanScheduler({
      scan: () => {
        scans += 1;
        tracker.scan();
      },
      wanted: () => false,
      ...time,
    });
    const parsed = term.onWriteParsed(() => scheduler.poke());
    for (let i = 0; i < 100; i += 1) {
      let chunk = '';
      for (let j = 0; j < 100; j += 1) chunk += `line ${i * 100 + j}\r\n`;
      await write(term, chunk);
      time.advance(16);
    }
    time.advance(5000);
    parsed.dispose();
    assert.equal(scans, 0);
    assert.equal(time.timers, 0, 'no timer was ever left');
    assert.equal(tracker.stats.scans, 0);
    assert.equal(tracker.stats.reads, 0);
  });

  test('AMM-22: Claude Code fed output without a pause for 2 s: at most 9 scans, and one after it stops', () => {
    const time = fakeTime();
    let scans = 0;
    const scheduler = createScanScheduler({ scan: () => (scans += 1), wanted: () => true, ...time });
    for (let t = 0; t < 2000; t += 16) {
      scheduler.poke();
      time.advance(16);
    }
    time.advance(1000);
    assert.ok(scans <= 9 && scans >= 7, `${scans} scans`);
    const before = scans;
    scheduler.poke();
    time.advance(149);
    assert.equal(scans, before, 'not before the debounce');
    time.advance(400);
    assert.equal(scans, before + 1, 'one, once quiet');
    scheduler.dispose();
  });

  test('AMM-24: wired like the registry, an idle Claude Code terminal: after the last output at most one more scan, and no pacer flush while idle (U-01)', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const tracker = trackAgentMessageMarks(term);
    const time = fakeTime();
    // xterm parses on its own timers: let it run what was written.
    const settle = async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const run = async (ms) => {
      for (let t = 0; t < ms; t += 50) {
        time.advance(50);
        await settle();
      }
    };
    let scans = 0;
    let flushes = 0;
    const scheduler = createScanScheduler({
      wanted: () => true,
      // The registry's scan (`afterOutputSoFar`): the output pacer flushed,
      // then the scan in the callback of an empty write.
      scan: () => {
        flushes += 1;
        term.write('', () => {
          scans += 1;
          tracker.scan();
        });
      },
      ...time,
    });
    // The registry's wiring: its `writeOutput` counts what the shell sent, and xterm's onWriteParsed asks for a scan.
    const parsed = term.onWriteParsed(() => scheduler.parsed());
    const output = (data) => {
      scheduler.wrote();
      return write(term, data);
    };
    const cc = fakeClaude(term, { out: output });
    await cc.draw();
    for (let i = 0; i < 5; i += 1) {
      await cc.say(`⏺ streamed line ${i}`);
      await run(100);
    }
    const last = { scans, flushes };
    await run(5000);
    assert.ok(scans - last.scans <= 1, `${scans - last.scans} scans in the 5 s after the last output`);
    assert.ok(flushes - last.flushes <= 1, `${flushes - last.flushes} pacer flushes in the 5 s after the last output`);
    assert.ok(scans >= 1, 'the output was scanned');
    const idle = { scans, flushes };
    await run(5000);
    assert.deepEqual({ scans, flushes }, idle, 'nothing at all while idle');
    // Real output after the pause is still scanned: a message and its echo.
    tracker.noteTyped();
    await cc.type('hello');
    tracker.noteSubmit();
    scheduler.poke();
    cc.clearBox();
    await cc.echo('hello');
    await run(1000);
    assert.deepEqual(markTexts(term, tracker), ['❯ hello']);
    const marked = { scans, flushes };
    await run(5000);
    assert.deepEqual({ scans, flushes }, marked, 'idle again');
    parsed.dispose();
    scheduler.dispose();
    tracker.dispose();
    term.dispose();
  });
});
