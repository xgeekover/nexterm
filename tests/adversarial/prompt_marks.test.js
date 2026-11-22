/**
 * Prompt marks on the terminal's scrollbar (src/lib/promptMarks.js, wired in
 * src/components/terminal/terminalRegistry.js).
 *
 * The tracker runs against xterm's own headless build, fed the way the
 * backend feeds a terminal: a read's output first, then the OSC 133 "D" that
 * came with it as `pty-command-done` (src-tauri/src/pty/manager.rs), which
 * the registry turns into a mark once xterm has parsed that output. Headless
 * draws nothing, so the decorations here come from a fake factory; the real
 * ruler, the click and the find colours are checked in a real browser
 * (prompt_marks_headless.test.js). The wiring the browser cannot see is
 * checked by reading the source.
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { listen, mockBridge } from '../../src/lib/ipc.js';
import {
  COMMANDS,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED,
  configurableCommands,
  dispatchKeydown,
  dispatchKeydownOverTerminal,
  findBinding,
} from '../../src/lib/keybindings.js';
import { paletteCommands } from '../../src/lib/paletteItems.js';
import {
  HIT_TOLERANCE_PX,
  MAX_PROMPT_MARKS,
  hitPromptMark,
  listenForPrompts,
  mergeMarks,
  nextPromptLine,
  previousPromptLine,
  trackPromptMarks,
} from '../../src/lib/promptMarks.js';
import { trackAgentMessageMarks } from '../../src/lib/agentMessageMarks.js';

const { Terminal: HeadlessTerminal } = headless;

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function makeTerm({ cols = 60, rows = 10, scrollback = 1000 } = {}) {
  return new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
}

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

/** A decoration factory that records what it made, as xterm's would be: disposed with its marker. */
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

const lineText = (term, line) => term.buffer.active.getLine(line)?.translateToString(true).trimEnd() ?? null;
const markTexts = (term, tracker) => tracker.lines.map((line) => lineText(term, line));

/** Each mark's row starts with its prompt (what was typed at it follows). */
function assertPrompts(term, tracker, prompts, message) {
  const texts = markTexts(term, tracker);
  assert.equal(texts.length, prompts.length, `${message ?? 'marks'}: ${JSON.stringify(texts)}`);
  texts.forEach((text, i) => assert.ok(text.startsWith(prompts[i]), `${message ?? 'mark'} ${i} reads "${text}", not "${prompts[i]}"`));
}

/** One read: the output, then the D that came with it. */
async function prompt(term, tracker, output) {
  await write(term, output);
  return tracker.mark();
}

describe('Prompt marks: where a prompt is (F1)', () => {
  test('PRM-01: cmd, D + OSC 7 + the prompt in one read, marks the prompt row; the first prompt too', async () => {
    const term = makeTerm();
    const tracker = trackPromptMarks(term);
    // cmd's PROMPT: `$E]133;D$E\\$E]7;file:///$P$E\\` + `$P$G`. The backend
    // strips the D; xterm ignores the OSC 7 it is handed.
    await prompt(term, tracker, '\x1b]7;file:///C:/work\x1b\\C:\\work>');
    assert.deepEqual(markTexts(term, tracker), ['C:\\work>'], 'the first prompt of the session is marked');
    await prompt(term, tracker, 'dir\r\n Volume in drive C has no label.\r\n\r\n\x1b]7;file:///C:/work\x1b\\C:\\work>');
    assertPrompts(term, tracker, ['C:\\work>dir', 'C:\\work>']);
    assert.equal(tracker.lines[1], 3, 'on the row the next command is typed on');
  });

  test('PRM-02: PowerShell, zsh and a two-line prompt that comes in the D\'s read (the mark is on its second line)', async () => {
    const ps = makeTerm();
    const psMarks = trackPromptMarks(ps);
    await prompt(ps, psMarks, 'PS C:\\work> ');
    await prompt(ps, psMarks, 'Get-Date\r\n\r\nTuesday, 18 November 2026 09:00:00\r\n\r\nPS C:\\work> ');
    assertPrompts(ps, psMarks, ['PS C:\\work> Get-Date', 'PS C:\\work>']);

    const zsh = makeTerm();
    const zshMarks = trackPromptMarks(zsh);
    await prompt(zsh, zshMarks, 'user@host % ');
    await prompt(zsh, zshMarks, 'ls\r\nREADME.md  src\r\nuser@host % ');
    assertPrompts(zsh, zshMarks, ['user@host % ls', 'user@host %']);

    const two = makeTerm();
    const twoMarks = trackPromptMarks(two);
    await prompt(two, twoMarks, '~/work on main\r\n❯ ');
    await prompt(two, twoMarks, 'git status\r\nnothing to commit\r\n~/work on main\r\n❯ ');
    assertPrompts(two, twoMarks, ['❯ git status', '❯'], 'the input row, the second line of the prompt');
    assert.equal(lineText(two, twoMarks.lines[1] - 1), '~/work on main');
  });

  test('PRM-03: a D on the row of the newest mark (a repaint) adds no second mark', async () => {
    const term = makeTerm();
    const tracker = trackPromptMarks(term);
    await prompt(term, tracker, 'user@host % ');
    assert.equal(tracker.mark(), null);
    await prompt(term, tracker, '\r\x1b[Kuser@host % ');
    assert.equal(tracker.marks.length, 1);
  });

  test('PRM-04: an empty Enter at the prompt is a prompt of its own (the human chose every prompt)', async () => {
    const term = makeTerm();
    const tracker = trackPromptMarks(term);
    await prompt(term, tracker, 'user@host % ');
    await prompt(term, tracker, '\r\nuser@host % ');
    assert.deepEqual(tracker.lines, [0, 1]);
  });

  test('PRM-26: zsh and bash, a prompt that comes in a read after its D: the mark is on the row the prompt starts on', async () => {
    // zsh's precmd and bash's PROMPT_COMMAND print the D with a printf of
    // their own (shell_integration.rs), and ZLE or readline draws the prompt
    // afterwards. The backend sends a read's output, then its D: when the
    // prompt text is in a later read, the D is marked before it is there.
    const split = async (term, tracker, before, promptText) => {
      const mark = await prompt(term, tracker, before);
      await write(term, promptText);
      return mark;
    };
    const two = makeTerm();
    const twoMarks = trackPromptMarks(two);
    await split(two, twoMarks, '', '~/work on main\r\n❯ ');
    await split(two, twoMarks, 'git status\r\nnothing to commit\r\n', '~/work on main\r\n❯ ');
    assert.deepEqual(twoMarks.lines, [0, 3]);
    assert.deepEqual(markTexts(two, twoMarks), ['~/work on main', '~/work on main'], 'the first line of a two-line prompt');
    assert.equal(lineText(two, twoMarks.lines[1] + 1), '❯', 'the row typed on is the one below the mark');

    // starship's default puts an empty line above the prompt: that empty line is marked.
    await split(two, twoMarks, 'ls\r\nREADME.md\r\n', '\r\n~/work on main\r\n❯ ');
    assert.deepEqual(twoMarks.lines, [0, 3, 6]);
    assert.equal(lineText(two, 6), '', 'the empty line the prompt starts with');
    assert.equal(lineText(two, 7), '~/work on main');

    // A one-line prompt is on its row either way.
    const one = makeTerm();
    const oneMarks = trackPromptMarks(one);
    await split(one, oneMarks, '', 'user@host % ');
    await split(one, oneMarks, 'ls\r\nREADME.md  src\r\n', 'user@host % ');
    assertPrompts(one, oneMarks, ['user@host % ls', 'user@host %']);
  });
});

describe('Prompt marks: what happens to a mark (F4)', () => {
  test('PRM-05: a small scrollback trims old prompts; every mark left still reads as its prompt', async () => {
    const term = makeTerm({ rows: 10, scrollback: 50 });
    const deco = fakeDecorations();
    const tracker = trackPromptMarks(term, { decorate: deco.decorate });
    const made = [];
    for (let i = 0; i < 40; i += 1) {
      let out = `cmd${i}\r\n`;
      for (let j = 0; j < 30; j += 1) out += `output ${i}.${j}\r\n`;
      const mark = await prompt(term, tracker, `${out}p${i}> `);
      made.push(mark);
      assert.ok(tracker.marks.length <= MAX_PROMPT_MARKS);
      for (const kept of tracker.marks) {
        const text = lineText(term, kept.marker.line);
        assert.match(text, /^p\d+>/, `mark at ${kept.marker.line} reads "${text}"`);
      }
    }
    const kept = new Set(tracker.marks);
    assert.ok(kept.size >= 1 && kept.size < 40, `some prompts were trimmed (${kept.size} left)`);
    assert.equal(lineText(term, tracker.lines.at(-1)), 'p39>');
    assert.ok(deco.made.length === 40 && deco.made.slice(0, 40 - kept.size).every((d) => d.isDisposed), 'trimmed prompts lose their decorations');
    for (const mark of made) {
      if (kept.has(mark)) continue;
      assert.ok(mark.marker.isDisposed, 'a trimmed prompt\'s marker is disposed');
    }
    assert.equal(deco.live().length, tracker.marks.length, 'one decoration per mark left');
  });

  test('PRM-06: the limit drops the oldest, its marker and decoration with it (a small limit, and 500)', async () => {
    const small = makeTerm({ rows: 5, scrollback: 1000 });
    const deco = fakeDecorations();
    const tracker = trackPromptMarks(small, { limit: 5, decorate: deco.decorate });
    const made = [];
    for (let i = 0; i < 12; i += 1) made.push(await prompt(small, tracker, `${i ? '\r\n' : ''}q${i}> `));
    assert.equal(tracker.marks.length, 5);
    assert.deepEqual(markTexts(small, tracker), ['q7>', 'q8>', 'q9>', 'q10>', 'q11>']);
    for (const mark of made.slice(0, 7)) assert.ok(mark.marker.isDisposed);
    assert.ok(deco.made.slice(0, 7).every((d) => d.isDisposed));
    assert.equal(deco.live().length, 5);

    assert.equal(MAX_PROMPT_MARKS, 500);
    const big = makeTerm({ rows: 5, scrollback: 5000 });
    const many = trackPromptMarks(big);
    let chunk = '';
    for (let i = 0; i < 620; i += 1) {
      chunk = `${i ? '\r\n' : ''}r${i}> `;
      await prompt(big, many, chunk);
      assert.ok(many.marks.length <= 500);
    }
    assert.equal(many.marks.length, 500);
    assert.equal(lineText(big, many.lines[0]), 'r120>');
  });

  test('PRM-07: ED 2 drops the marks on the erased rows, ED 3 the ones in the scrollback', async () => {
    const term = makeTerm({ rows: 5, scrollback: 100 });
    const tracker = trackPromptMarks(term);
    for (let i = 0; i < 8; i += 1) await prompt(term, tracker, `${i ? '\r\n' : ''}s${i}> `);
    const before = tracker.lines.slice();
    const top = term.buffer.active.baseY;
    await write(term, '\x1b[2J');
    assert.deepEqual(tracker.lines, before.filter((line) => line < top), 'the marks on screen went with it');
    await write(term, '\x1b[H');
    await prompt(term, tracker, 's8> ');
    assert.equal(lineText(term, tracker.lines.at(-1)), 's8>', 'the next prompt is marked');
    await write(term, '\x1b[3J');
    assert.deepEqual(markTexts(term, tracker), ['s8>'], 'ED 3 took the scrollback\'s marks');
  });

  test('PRM-08: Terminal: Clear, then the clear step, leaves one mark: the cursor\'s prompt', async () => {
    const term = makeTerm({ rows: 5 });
    const deco = fakeDecorations();
    const tracker = trackPromptMarks(term, { decorate: deco.decorate });
    for (let i = 0; i < 9; i += 1) await prompt(term, tracker, `${i ? '\r\nout\r\n' : ''}t${i}> `);
    assert.equal(tracker.cursorOnNewestMark(), true);
    const old = tracker.marks.slice();
    const was = tracker.cursorOnNewestMark();
    term.clear();
    tracker.afterClear(was);
    assert.equal(tracker.marks.length, 1);
    assert.deepEqual(markTexts(term, tracker), ['t8>']);
    assert.equal(tracker.lines[0], 0, 'the prompt moved to the top');
    for (const mark of old) assert.ok(mark.marker.isDisposed);
    assert.ok(deco.made.slice(0, 9).every((d) => d.isDisposed));
    assert.equal(deco.live().length, 1);

    // Typing had started below the prompt (no mark on the cursor row): nothing is marked.
    await write(term, '\r\nsome output');
    const was2 = tracker.cursorOnNewestMark();
    assert.equal(was2, false);
    term.clear();
    tracker.afterClear(was2);
    assert.equal(tracker.marks.length, 0);
  });

  test('PRM-09: no mark on the alternate screen; the marks are intact after leaving it', async () => {
    const term = makeTerm({ rows: 5 });
    const tracker = trackPromptMarks(term);
    await prompt(term, tracker, 'u0> ');
    await prompt(term, tracker, '\r\nvim\r\nu1> ');
    const before = tracker.lines.slice();
    await write(term, '\x1b[?1049h\x1b[H~\r\n~\r\n~');
    assert.equal(term.buffer.active.type, 'alternate');
    assert.equal(tracker.mark(), null);
    assert.equal(tracker.cursorOnNewestMark(), false);
    await write(term, '\x1b[?1049l');
    assert.deepEqual(tracker.lines, before);
    assert.deepEqual(markTexts(term, tracker), ['u0>', 'u1>']);
  });

  test('PRM-10: after a resize to fewer and to more columns every mark is on its prompt', async () => {
    const term = makeTerm({ cols: 60, rows: 6, scrollback: 500 });
    const tracker = trackPromptMarks(term);
    for (let i = 0; i < 12; i += 1) {
      await prompt(term, tracker, `${i ? `\r\n${'x'.repeat(50)} long output line ${i}\r\n` : ''}v${i}> `);
    }
    const expected = markTexts(term, tracker);
    term.resize(20, 6);
    await write(term, '');
    assert.deepEqual(markTexts(term, tracker), expected, 'narrower');
    term.resize(90, 6);
    await write(term, '');
    assert.deepEqual(markTexts(term, tracker), expected, 'wider');
  });

  test('PRM-11: dispose disposes every marker and decoration', async () => {
    const term = makeTerm();
    const deco = fakeDecorations();
    const tracker = trackPromptMarks(term, { decorate: deco.decorate });
    for (let i = 0; i < 4; i += 1) await prompt(term, tracker, `${i ? '\r\n' : ''}w${i}> `);
    const marks = tracker.marks.slice();
    tracker.dispose();
    assert.equal(tracker.marks.length, 0);
    for (const mark of marks) assert.ok(mark.marker.isDisposed);
    assert.equal(deco.live().length, 0);
    assert.equal(tracker.mark(), null, 'a disposed tracker marks nothing');
  });

  test('PRM-12: off takes every decoration away and keeps the marks; on puts one back per mark', async () => {
    const term = makeTerm();
    const deco = fakeDecorations();
    const tracker = trackPromptMarks(term, { decorate: deco.decorate, color: '#8b5cf6' });
    for (let i = 0; i < 3; i += 1) await prompt(term, tracker, `${i ? '\r\n' : ''}y${i}> `);
    const cols = term.cols;
    tracker.setVisible(false);
    assert.equal(tracker.marks.length, 3);
    assert.equal(deco.live().length, 0);
    // Transparent first: one xterm fails to delete draws nothing (PMB-11).
    assert.ok(deco.made.every((d) => d.options.overviewRulerOptions.color === 'rgba(0, 0, 0, 0)'));
    await prompt(term, tracker, '\r\ny3> ');
    assert.equal(tracker.marks.length, 4, 'marks are still tracked while hidden');
    assert.equal(deco.live().length, 0);
    tracker.setVisible(true);
    assert.equal(deco.live().length, 4);
    assert.ok(tracker.marks.every((mark) => mark.decoration && !mark.decoration.isDisposed));
    tracker.setColor('rgb(0, 120, 215)');
    assert.equal(deco.live().length, 4);
    assert.ok(deco.live().every((d) => d.color === 'rgb(0, 120, 215)'), 'redrawn in the new colour');
    assert.equal(term.cols, cols);
  });
});

describe('Prompt marks: previous, next and the click (F9, F10, F11)', () => {
  const lines = [10, 40, 90];

  test('PRM-13: previous is the newest mark above the top row; none above is null', () => {
    assert.equal(previousPromptLine(lines, 50), 40);
    assert.equal(previousPromptLine(lines, 40), 10, 'the mark on the top row is not above it');
    assert.equal(previousPromptLine(lines, 10), null);
    assert.equal(previousPromptLine([], 10), null);
  });

  test('PRM-14: next is the first mark below the top row; past the newest it is the bottom; at the bottom null', () => {
    assert.equal(nextPromptLine(lines, 0, 200), 10);
    assert.equal(nextPromptLine(lines, 40, 200), 90);
    assert.equal(nextPromptLine(lines, 90, 200), 200, 'past the newest goes to the bottom');
    assert.equal(nextPromptLine(lines, 200, 200), null, 'none below, already at the bottom');
    assert.equal(nextPromptLine([10, 205], 100, 200), 200, 'a prompt on the last screen is the bottom');
    assert.equal(nextPromptLine([205], 200, 200), null);
    assert.equal(nextPromptLine([], 0, 0), null);
  });

  test('PRM-15: the hit test takes the nearest mark within 4 px, the upper one on a tie', () => {
    // 1000 lines on 500 px: 2 lines a pixel, mark 100 at 50 px, 200 at 100 px.
    const base = { rulerHeight: 500, bufferLength: 1000, lines: [100, 200, 216], sliderTop: 400, sliderHeight: 50 };
    assert.equal(HIT_TOLERANCE_PX, 4);
    assert.equal(hitPromptMark({ ...base, offsetY: 50 }), 100);
    assert.equal(hitPromptMark({ ...base, offsetY: 53.9 }), 100, 'within 4 px');
    assert.equal(hitPromptMark({ ...base, offsetY: 46 }), 100);
    assert.equal(hitPromptMark({ ...base, offsetY: 54.5 }), null, 'outside the tolerance');
    assert.equal(hitPromptMark({ ...base, offsetY: 105 }), 216, 'the nearest of two in reach');
    assert.equal(hitPromptMark({ ...base, offsetY: 104 }), 200, 'a tie goes to the upper one');
    assert.equal(hitPromptMark({ ...base, offsetY: 300 }), null);
  });

  test('PRM-16: never on the slider, and nothing without a ruler', () => {
    const base = { rulerHeight: 500, bufferLength: 1000, lines: [800], sliderTop: 390, sliderHeight: 30 };
    assert.equal(hitPromptMark({ ...base, offsetY: 400 }), null, 'a press on the slider drags it, even over a mark');
    assert.equal(hitPromptMark({ ...base, sliderTop: 0, sliderHeight: 20, offsetY: 400 }), 800);
    assert.equal(hitPromptMark({ ...base, offsetY: 400, rulerHeight: 0, sliderHeight: 0 }), null);
    assert.equal(hitPromptMark({ ...base, offsetY: 400, bufferLength: 0, sliderHeight: 0 }), null);
    assert.equal(hitPromptMark({ ...base, offsetY: Number.NaN }), null);
  });

  test('PRM-17: the tracker answers from its live marks', async () => {
    const term = makeTerm({ rows: 5, scrollback: 200 });
    const tracker = trackPromptMarks(term);
    for (let i = 0; i < 6; i += 1) await prompt(term, tracker, `${i ? '\r\n1\r\n2\r\n3\r\n4\r\n' : ''}z${i}> `);
    const buffer = term.buffer.active;
    const [first, second] = tracker.lines;
    assert.equal(tracker.previous(buffer.baseY), tracker.lines.filter((l) => l < buffer.baseY).at(-1));
    assert.equal(tracker.next(first, buffer.baseY), second);
    assert.equal(tracker.next(buffer.baseY, buffer.baseY), null);
    assert.equal(tracker.hit({ offsetY: 0, rulerHeight: 100, bufferLength: buffer.length }), first);
  });

  test('PRM-27: while the marks are hidden no press takes one; previous and next still answer', async () => {
    const term = makeTerm({ rows: 5, scrollback: 200 });
    const deco = fakeDecorations();
    const tracker = trackPromptMarks(term, { decorate: deco.decorate });
    for (let i = 0; i < 4; i += 1) await prompt(term, tracker, `${i ? '\r\n1\r\n2\r\n' : ''}h${i}> `);
    const buffer = term.buffer.active;
    const press = { offsetY: 0, rulerHeight: 100, bufferLength: buffer.length };
    assert.equal(tracker.hit(press), tracker.lines[0]);
    tracker.setVisible(false);
    assert.equal(tracker.hit(press), null, 'a hidden mark takes no press');
    assert.equal(tracker.next(tracker.lines[0], buffer.baseY), tracker.lines[1], 'the keys work either way');
    assert.equal(tracker.previous(buffer.baseY), tracker.lines.filter((l) => l < buffer.baseY).at(-1));
    tracker.setVisible(true);
    assert.equal(tracker.hit(press), tracker.lines[0], 'shown again, it takes the press again');
  });
});


describe('Prompt marks: one listener for every live terminal (F3)', () => {
  test('PRM-18: a terminal alive in the registry but in no pane is marked for its session; another session marks nothing', async () => {
    // The registry's entries, as `getOrCreateTerminal` makes them: no view is
    // involved, only the instance and its session.
    const shown = { sessionId: 'pm-s1', disposed: false, term: makeTerm() };
    const unmounted = { sessionId: 'pm-s1', disposed: false, term: makeTerm() };
    const other = { sessionId: 'pm-s2', disposed: false, term: makeTerm() };
    const closed = { sessionId: 'pm-s1', disposed: true, term: makeTerm() };
    const entries = [shown, unmounted, other, closed];
    for (const entry of entries) entry.promptMarks = trackPromptMarks(entry.term);
    const pending = [];
    // The registry's `afterOutputSoFar`: once xterm has read what it was given.
    const mark = (entry) => {
      pending.push(new Promise((resolve) => entry.term.write('', () => resolve(entry.promptMarks.mark()))));
    };
    const unlisten = await listenForPrompts({ listen, entries: () => entries.values(), mark });
    try {
      for (const entry of entries) entry.term.write('PS C:\\work> ');
      await mockBridge.emit('pty-command-done', { session_id: 'pm-s1', exit_code: 0 });
      await Promise.all(pending.splice(0));
      for (const entry of entries) entry.term.write('Get-Date\r\nnow\r\nPS C:\\work> ');
      await mockBridge.emit('pty-command-done', { session_id: 'pm-s1', exit_code: 0 });
      await Promise.all(pending.splice(0));
      assertPrompts(unmounted.term, unmounted.promptMarks, ['PS C:\\work> Get-Date', 'PS C:\\work>'], 'unmounted');
      assert.deepEqual(shown.promptMarks.lines, unmounted.promptMarks.lines);
      assert.equal(other.promptMarks.marks.length, 0, 'another session\'s prompt marks nothing');
      assert.equal(closed.promptMarks.marks.length, 0, 'a disposed terminal is skipped');
      await mockBridge.emit('pty-command-done', { session_id: 'pm-s2', exit_code: 1 });
      await mockBridge.emit('pty-command-done', {});
      await Promise.all(pending.splice(0));
      assert.equal(other.promptMarks.marks.length, 1);
      assert.equal(unmounted.promptMarks.marks.length, 2);
    } finally {
      unlisten?.();
      for (const entry of entries) entry.promptMarks.dispose();
    }
  });

  test('PRM-19: the registry starts that listener at load, marks through afterOutputSoFar, and TerminalView has no part in it', () => {
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    assert.match(registry, /promptListening = listenForPrompts\(\{\s*listen,\s*entries: \(\) => instances\.values\(\),\s*mark: \(entry\) => afterOutputSoFar\(entry, \(e\) => e\.promptMarks\?\.mark\(\)\),/);
    assert.match(registry, /\n\}\nensurePromptMarksListening\(\);\n/, 'started when the module loads (bootstrap)');
    assert.match(registry, /promptMarks: trackPromptMarks\(term, \{/);
    const dispose = registry.slice(registry.indexOf('export function disposeTerminal('));
    assert.ok(dispose.indexOf('entry.promptMarks.dispose();') !== -1 && dispose.indexOf('entry.promptMarks.dispose();') < dispose.indexOf('entry.term.dispose();'), 'disposed with the terminal');
    assert.doesNotMatch(read('../../src/components/terminal/TerminalView.jsx'), /promptMarks/);
  });
});

describe('Prompt marks: the ruler, the colours and the CSS (F6, F7, F7a, F8)', () => {
  const registry = read('../../src/components/terminal/terminalRegistry.js');

  test('PRM-21: a 10px overview ruler, the slider colours from the tokens, and transparent find colours', () => {
    assert.match(registry, /export const SCROLLBAR_WIDTH = 10;/);
    const create = registry.slice(registry.indexOf('const term = new Terminal({'));
    assert.match(create.slice(0, create.indexOf('});')), /overviewRuler: \{ width: SCROLLBAR_WIDTH \},/);
    assert.match(registry, /return withScrollbarColours\(resolveTerminalTheme\(/, 'every theme handed to xterm carries them');
    const colours = registry.slice(registry.indexOf('function withScrollbarColours('));
    const body = colours.slice(0, colours.indexOf('\n}\n'));
    assert.match(body, /const slider = v\('--vsc-scrollbar', /);
    assert.match(body, /const hover = v\('--vsc-scrollbar-hover', /);
    assert.match(body, /scrollbarSliderBackground: slider,\s*scrollbarSliderHoverBackground: hover,\s*scrollbarSliderActiveBackground: hover,/);
    assert.match(body, /overviewRulerBorder: theme\?\.background \?\?/);
    const search = registry.slice(registry.indexOf('function searchDecorations('));
    const searchBody = search.slice(0, search.indexOf('\n}\n'));
    assert.match(searchBody, /matchOverviewRuler: 'rgba\(0, 0, 0, 0\)',/);
    assert.match(searchBody, /activeMatchColorOverviewRuler: 'rgba\(0, 0, 0, 0\)',/);
    assert.match(registry, /overviewRulerOptions: \{ color, position: 'full' \}/);
    assert.match(registry, /element\.style\.pointerEvents = 'none';/);
  });

  test('PRM-22: forced colours keep the slider visible and the Highlight probe opts out; both reduced-motion paths stop its fade; the F13 comment is right', () => {
    const css = read('../../src/styles/index.css');
    const forced = css.slice(css.indexOf('@media (forced-colors: active) {'));
    const forcedBlock = forced.slice(0, forced.indexOf('\n}\n'));
    assert.match(forcedBlock, /\.xterm \.xterm-scrollable-element > \.scrollbar > \.slider \{\s*forced-color-adjust: none;\s*outline: 1px solid CanvasText;/);
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce) {'));
    assert.match(reduced.slice(0, reduced.indexOf('\n}\n')), /\.xterm \.xterm-scrollable-element > \.scrollbar \{\s*transition-property: none !important;/);
    assert.match(css, /:root\.reduce-motion \.xterm \.xterm-scrollable-element > \.scrollbar \{\s*transition-property: none !important;/);
    const probe = registry.slice(registry.indexOf('function systemColour('));
    assert.match(probe.slice(0, probe.indexOf('\n}\n')), /probe\.style\.forcedColorAdjust = 'none';\s*probe\.style\.color = keyword;/, 'the Highlight probe opts out of forced colours');
    const head = css.slice(0, css.indexOf(':root {'));
    assert.match(head, /the terminal's scrollbar is xterm's own/);
    assert.match(head, /made 10px wide through `overviewRuler\.width`/);
  });
});

describe('Prompt marks: the previous/next commands (F11)', () => {
  const press = (key, { meta = false, ctrl = false } = {}) => {
    const calls = [];
    const e = {
      key,
      code: key,
      metaKey: meta,
      ctrlKey: ctrl,
      shiftKey: true,
      altKey: false,
      preventDefault: () => calls.push('prevented'),
      stopPropagation: () => calls.push('stopped'),
    };
    return { e, calls };
  };

  test('PRM-20: titled, configurable, over the terminal, Ctrl/Cmd+Shift+Up/Down, in the palette; not claimed on the alternate screen', () => {
    for (const [id, title, key] of [
      ['terminal-previous-prompt', 'Terminal: Go to Previous Prompt', 'mod+shift+up'],
      ['terminal-next-prompt', 'Terminal: Go to Next Prompt', 'mod+shift+down'],
    ]) {
      assert.equal(COMMANDS[id].title, title);
      assert.equal(COMMANDS[id].overTerminal, true);
      assert.ok(configurableCommands().some((c) => c.id === id), `${id} is rebindable`);
      assert.deepEqual(DEFAULT_KEYBINDINGS.filter((b) => b.command === id).map((b) => b.key), [key]);
    }
    const palette = paletteCommands(DEFAULT_RESOLVED);
    for (const command of ['terminal_previous_prompt', 'terminal_next_prompt']) {
      const row = palette.find((item) => item.command === command);
      assert.ok(row && row.hint, `${command} is in the palette, with its chord`);
    }

    for (const [platform, mods] of [['macos', { meta: true }], ['windows', { ctrl: true }]]) {
      const jumps = [];
      let normal = true;
      const ctx = {
        isMod: true,
        isInTerminal: true,
        terminalClaimsMarkKeys: () => normal,
        jumpToPrompt: (direction) => jumps.push(direction),
      };
      const up = press('ArrowUp', mods);
      assert.equal(findBinding(up.e, ctx)?.command, 'terminal-previous-prompt', platform);
      assert.equal(dispatchKeydownOverTerminal(up.e, ctx), 'terminal-previous-prompt');
      assert.deepEqual(up.calls, ['prevented', 'stopped'], `${platform}: claimed over a terminal on its normal screen`);
      const down = press('ArrowDown', mods);
      assert.equal(dispatchKeydownOverTerminal(down.e, ctx), 'terminal-next-prompt');
      assert.deepEqual(jumps, ['previous', 'next']);

      normal = false;
      const alt = press('ArrowUp', mods);
      assert.equal(dispatchKeydownOverTerminal(alt.e, ctx), 'pass:terminal-previous-prompt');
      assert.deepEqual(alt.calls, [], `${platform}: on the alternate screen the program keeps the key`);
      assert.equal(dispatchKeydown(alt.e, ctx), 'pass:terminal-previous-prompt');
      assert.deepEqual(alt.calls, []);
      assert.deepEqual(jumps, ['previous', 'next']);

      const outside = press('ArrowDown', mods);
      assert.equal(dispatchKeydown(outside.e, { ...ctx, isInTerminal: false, terminalClaimsMarkKeys: () => true }), 'pass:terminal-next-prompt');
      assert.deepEqual(outside.calls, [], `${platform}: outside a terminal the key is the field's`);
    }
  });
});

describe('Prompt marks: the setting (F12)', () => {
  const KEY = 'nexterm.settings';
  const backing = new Map();
  const ownStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  const launch = () => import(`../../src/stores/settingsStore.js?prompt-marks=${Math.random()}`);

  test('PRM-23: on by default, saved when turned off, and read back at the next start', async () => {
    const borrowed = globalThis.localStorage;
    globalThis.localStorage = ownStorage;
    backing.clear();
    try {
      const first = await launch();
      assert.equal(first.SETTINGS_DEFAULTS.terminalPromptMarks, true);
      assert.equal(first.useSettingsStore.getState().terminalPromptMarks, true);
      first.useSettingsStore.getState().setSetting('terminalPromptMarks', false);
      assert.equal(JSON.parse(backing.get(KEY)).data.terminalPromptMarks, false, 'saved');
      const second = await launch();
      assert.equal(second.useSettingsStore.getState().terminalPromptMarks, false, 'read back');
      second.useSettingsStore.getState().setSetting('terminalPromptMarks', true);
      assert.equal('terminalPromptMarks' in JSON.parse(backing.get(KEY)).data, false, 'the default is not stored');
    } finally {
      globalThis.localStorage = borrowed;
    }
  });

  test('PRM-24: the Settings row, and the registry turning only the decorations on and off', () => {
    const settings = read('../../src/components/common/SettingsWindow.jsx');
    const row = settings.slice(settings.indexOf("id: 'terminalPromptMarks',"));
    assert.match(row.slice(0, row.indexOf('},')), /section: 'terminal',\s*key: 'terminalPromptMarks',\s*settingKey: 'terminal\.integrated\.promptMarksOnScrollbar',\s*title: 'Prompt Marks on Scrollbar',/);
    assert.ok(settings.indexOf("id: 'terminalPromptMarks',") > settings.indexOf("id: 'terminalStickyHeader',"), 'next to the sticky header row');
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    // Both kinds: the shell prompts and the messages sent to Claude Code.
    assert.match(registry, /if \(state\.terminalPromptMarks !== prevState\.terminalPromptMarks\) \{\s*for \(const entry of instances\.values\(\)\) \{\s*entry\.promptMarks\?\.setVisible\(promptMarksShown\(state\)\);\s*entry\.messageMarks\?\.setVisible\(promptMarksShown\(state\)\);/);
    const live = /const LIVE_TERMINAL_SETTINGS_KEYS = \[([\s\S]*?)\];/.exec(registry)?.[1] ?? '';
    assert.ok(!live.includes('terminalPromptMarks'), 'turning it on or off refits the terminals');
    assert.match(registry, /visible: promptMarksShown\(settingsState\),/);
  });
});

describe('Prompt marks and the messages sent to Claude Code, together (F11, F12, F14 of the agent task)', () => {
  const registry = read('../../src/components/terminal/terminalRegistry.js');
  const body = (name) => {
    const from = registry.slice(registry.indexOf(name));
    return from.slice(0, from.indexOf('\n}\n'));
  };

  test('PRM-28: the click and the keys use both kinds, merged by line; the keys are claimed through one registry function', () => {
    assert.match(registry, /const promptMarkClicks = installPromptMarkClicks\(term, \(\) => allMarks\(instances\.get\(tabId\)\)\);/);
    // Shell prompts, Claude Code's and OpenCode mini's messages (opencode_mini_marks.test.js).
    assert.match(body('function allMarks('), /return mergeMarks\(entry\.promptMarks, entry\.messageMarks, entry\.miniMarks\);/);
    assert.match(body('export function jumpToPrompt('), /const line = promptJumpLine\(entry\.term\.buffer\.active, allMarks\(entry\), direction\);/);
    assert.match(body('export function terminalClaimsMarkKeys('), /return terminalShowsNormalBuffer\(tabId\);/);
    const hook = read('../../src/hooks/useKeybindings.js');
    assert.match(hook, /import \{ jumpToPrompt, terminalClaimsMarkKeys \} from '\.\.\/components\/terminal\/terminalRegistry\.js';/);
    assert.match(hook, /terminalClaimsMarkKeys: \(\) => terminalClaimsMarkKeys\(useTerminalStore\.getState\(\)\.activeTabId\),/);
    assert.doesNotMatch(hook, /terminalShowsNormalBuffer/);
    assert.match(read('../../src/lib/keybindings.js'), /function promptKeysClaimed\(ctx\) \{\s*return Boolean\(ctx\?\.isInTerminal\) && Boolean\(ctx\?\.terminalClaimsMarkKeys\?\.\(\)\);/);
    // The message marks' own listener comes before the view's, and both go with the terminal.
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    assert.ok(create.indexOf('const messageInput = term.onData(') < create.indexOf('const dataDisposable = onData ? term.onData(onData) : null;'));
    const dispose = body('export function disposeTerminal(');
    for (const part of ['entry.messageInput?.dispose();', 'entry.messageParsed?.dispose();', 'entry.messageScans?.dispose();', 'entry.messageMarks?.dispose();', 'entry.miniMarks?.dispose();']) {
      assert.ok(dispose.includes(part) && dispose.indexOf(part) < dispose.indexOf('entry.term.dispose();'), part);
    }
    // Terminal: Clear takes the message marks through the prompt marks' hook; clearTerminal keeps its shape.
    assert.match(registry, /onClear: \(\) => clearMessageMarks\(instances\.get\(tabId\)\),/);
    assert.match(body('function clearMessageMarks('), /entry\?\.messageMarks\?\.afterClear\(\);\s*entry\?\.miniMarks\?\.afterClear\(\);/);
    assert.doesNotMatch(body('export function clearTerminal('), /messageMarks/);
    // NexTerm's own start and resume lines set the floor (setAgentLaunchObserver).
    assert.match(registry, /setAgentLaunchObserver\(\(tabId\) => \{\s*afterOutputSoFar\(instances\.get\(tabId\), \(entry\) => \{\s*entry\.messageMarks\?\.noteShellSubmit\(\);\s*entry\.miniMarks\?\.noteShellSubmit\(\);/);
    const store = read('../../src/stores/terminalStore.js');
    assert.equal((store.match(/noteAgentLaunch\(targetId\);\n\s*await get\(\)\.writeRaw\(targetId, /g) ?? []).length, 2, 'startAgent and resumeAgent tell it right before they type');
  });

  test('PRM-29: the message marks are --vsc-info, LinkText in forced colours, and recoloured with the prompt marks', () => {
    const colour = body('function messageMarkColour(');
    assert.match(colour, /if \(forcedColours\(\)\) return systemColour\('LinkText'\);/);
    assert.match(colour, /getPropertyValue\('--vsc-info'\)/);
    assert.match(colour, /return value \|\| '#3794ff';/);
    assert.match(read('../../src/styles/index.css'), /--vsc-info:\s+#3794ff;/, 'the literal is the token');
    const refresh = body('function refreshPromptMarkColour(');
    assert.match(refresh, /entry\.promptMarks\?\.setColor\(colour\);\s*entry\.messageMarks\?\.setColor\(messageColour\);/);
    assert.match(registry, /messageMarks: trackAgentMessageMarks\(term, \{\s*decorate: promptMarkDecorator\(term\),\s*visible: promptMarksShown\(settingsState\),\s*color: messageMarkColour\(\),/);
  });

  test('PRM-30: with the setting off neither kind is drawn or takes a press, the keys still go to both; on, both are drawn again', async () => {
    const term = makeTerm({ cols: 60, rows: 20 });
    const decorations = fakeDecorations();
    const prompts = trackPromptMarks(term, { decorate: decorations.decorate, color: '#8B5CF6' });
    const messages = trackAgentMessageMarks(term, { decorate: decorations.decorate, color: '#3794ff' });
    await prompt(term, prompts, 'PS C:\\> ');
    await write(term, 'claude');
    messages.noteShellSubmit();
    const rule = '\u2500'.repeat(60);
    // Claude Code's box (rows 2 to 4) holds the message at Enter; then the echo goes above it.
    await write(term, `\r\n${rule}\r\n❯\u00A0hello there\r\n${rule}\r\n  status`);
    messages.noteTyped();
    assert.deepEqual(messages.noteSubmit(), { positional: false, text: 'hellothere' });
    await write(term, `\x1b[2;1H\x1b[J❯ hello there\r\n\r\n⏺ ok\r\n\r\n${rule}\r\n❯\u00A0\r\n${rule}\r\n  status`);
    messages.scan();
    assert.equal(messages.lines.length, 1, 'the message is marked');
    const both = () => mergeMarks(prompts, messages);
    const at = (line) => ({ offsetY: (line / term.buffer.active.length) * 200, rulerHeight: 200, bufferLength: term.buffer.active.length });
    assert.equal(both().hit(at(messages.lines[0])), messages.lines[0]);
    assert.deepEqual(decorations.live().map((d) => d.color).sort(), ['#3794ff', '#8B5CF6']);
    for (const tracker of [prompts, messages]) tracker.setVisible(false);
    assert.equal(decorations.live().length, 0, 'no decoration of either kind');
    assert.equal(both().hit(at(messages.lines[0])), null, 'the track is xterm\'s');
    assert.equal(both().hit(at(prompts.lines[0])), null);
    assert.equal(both().previous(term.buffer.active.length), messages.lines[0], 'the keys still reach a message');
    assert.equal(both().previous(messages.lines[0]), prompts.lines[0], 'and a prompt');
    for (const tracker of [prompts, messages]) tracker.setVisible(true);
    assert.deepEqual(decorations.live().map((d) => d.color).sort(), ['#3794ff', '#8B5CF6'], 'both drawn again');
    prompts.dispose();
    messages.dispose();
  });

  test('PRM-31: scans only while Claude Code runs on the normal screen, after parsed output, through afterOutputSoFar', () => {
    // Parsed output asks for a scan only if the shell's output came (`writeOutput`), never a scan's own empty write (U-01, AMM-24).
    assert.match(registry, /const messageParsed = term\.onWriteParsed\(\(\) => instances\.get\(tabId\)\?\.messageScans\?\.parsed\(\)\);/);
    assert.doesNotMatch(registry, /onWriteParsed\([^\n]*\.poke\(\)/);
    assert.match(body('function writeOutput('), /^function writeOutput\(entry, data, read = null\) \{\s*const \{ tabId, term \} = entry;\s*\/\/[^\n]*\n\s*entry\.messageScans\?\.wrote\(\);/);
    const scanner = body('function messageScanner(');
    // Claude Code's tracker while Claude Code runs, OpenCode mini's while OpenCode does (opencode_mini_marks.test.js OMM-20 to OMM-22).
    assert.match(scanner, /const kind = marksAgentIn\(entry\.tabId\);\s*const runs = kind === 'claude';/);
    assert.match(scanner, /return kind !== null && entry\.term\.buffer\.active\.type === 'normal';/);
    assert.match(scanner, /if \(!runs && entry\.claudeRan\) entry\.messageMarks\?\.stop\(\);/);
    assert.match(scanner, /scan: \(\) => afterOutputSoFar\(entry, \(e\) => tracker\(e\)\?\.scan\(\)\),/);
    // 'opencode' to the mini tracker, 'claude' to Claude Code's, no agent to no scan (OMM-31).
    assert.match(scanner, /const tracker = \(e\) => \{\s*const kind = marksAgentIn\(e\.tabId\);\s*if \(kind === 'opencode'\) return e\.miniMarks;\s*if \(kind === 'claude'\) return e\.messageMarks;\s*return null;\s*\};/);
    assert.match(body('function claudeRunsIn('), /return Boolean\(tab\) && tab\.agent\?\.kind === 'claude' && agentRuns\(tab\);/);
    assert.match(body('function marksAgentIn('), /if \(claudeRunsIn\(tabId\)\) return 'claude';\s*if \(opencodeRunsIn\(tabId\)\) return 'opencode';\s*return null;/);
    // Input through agentMessageMarks.js `noteTerminalInput` (AMM-25: reports and escape keys are not typing, U-03); a submit to Claude Code pokes a scan.
    const input = body('function noteMessageInput(');
    assert.match(input, /const kind = noteTerminalInput\(both, data, \{ submits: submitsLine, agentRuns: \(\) => \(running = marksAgentIn\(tabId\)\) !== null \}\);\s*if \(kind === 'submit'\) entry\.messageScans\?\.poke\(\);/);
    // Only the fan-out to the two trackers: the submit to the running agent's, the floor and typing to both.
    assert.match(input, /noteSubmit: \(\) => \(running === 'opencode' \? entry\.miniMarks\?\.noteSubmit\(\) : marks\.noteSubmit\(\)\),/);
    assert.equal((input.match(/noteTyped|noteSubmit|noteShellSubmit/g) ?? []).length, 9, 'no other use of the tracker hooks');
  });
});

describe('The scrollbar at rest, and the documents of the agent task (F13, F15)', () => {
  test('PRM-32: the scrollbar is shown at rest on the normal screen and hidden on the alternate one; forced colours and reduced motion untouched', () => {
    const css = read('../../src/styles/index.css');
    const block = (selector) => {
      const at = css.indexOf(selector);
      assert.ok(at !== -1, `no ${selector}`);
      const from = css.slice(at);
      return from.slice(0, from.indexOf('}') + 1);
    };
    const idle = block('.xterm .xterm-scrollable-element > .scrollbar.vertical.invisible {\n  opacity: 1;');
    assert.match(idle, /opacity: 1;\s*visibility: visible;\s*pointer-events: auto;\s*z-index: 11;/);
    assert.doesNotMatch(idle, /forced-color|outline|transition: opacity/);
    assert.match(css, /\.xterm \.xterm-scrollable-element > \.scrollbar\.vertical\.visible,\s*\.xterm \.xterm-scrollable-element > \.scrollbar\.vertical\.invisible \{\s*transition-property: none;\s*\}/, 'no fade at all');
    const alternate = block('.xterm.xterm-alternate-screen .xterm-scrollable-element > .scrollbar.vertical {');
    assert.match(alternate, /opacity: 0;\s*pointer-events: none;\s*transition-property: none;/);
    // Outside every @media and @layer block: at the top level, before the reduced-motion block.
    const at = css.indexOf('.xterm .xterm-scrollable-element > .scrollbar.vertical.invisible {\n  opacity: 1;');
    const before = css.slice(0, at);
    const opened = (before.match(/\{/g) ?? []).length;
    const closed = (before.match(/\}/g) ?? []).length;
    assert.equal(opened, closed, 'the idle rule is at the top level');
    // The forced-colours slider rule and both reduced-motion rules are still there (PRM-22 reads them too).
    assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*?\.xterm \.xterm-scrollable-element > \.scrollbar > \.slider \{\s*forced-color-adjust: none;\s*outline: 1px solid CanvasText;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.xterm \.xterm-scrollable-element > \.scrollbar \{\s*transition-property: none !important;/);
    assert.match(css, /:root\.reduce-motion \.xterm \.xterm-scrollable-element > \.scrollbar \{\s*transition-property: none !important;/);
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    assert.match(registry, /const bufferChange = term\.buffer\.onBufferChange\?\.\(\(buffer\) => showAlternateScreen\(term, buffer\?\.type === 'alternate'\)\);/);
    assert.match(registry, /term\.element\?\.classList\?\.toggle\('xterm-alternate-screen', Boolean\(alternate\)\);/);
  });

  test('PRM-33: the README says what is marked for Claude Code, the variable, the setting, fullscreen and OpenCode; V49 lists C1 to C13', () => {
    const readme = read('../../README.md');
    const terminal = readme.slice(readme.indexOf('### Working in a terminal'));
    const section = terminal.slice(0, terminal.indexOf('\n### ', 5));
    assert.match(section, /\*\*Claude Code's messages on the scrollbar\.\*\*/);
    assert.match(section, /`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`/);
    assert.match(section, /\*Claude Code on\s+the Normal Screen\*/);
    assert.match(section, /Fullscreen\s+Claude Code has no marks/);
    assert.match(section, /The\s+thin scrollbar and its box are always visible on a terminal's normal screen/);
    assert.match(section, /\*\*OpenCode's messages on the scrollbar\.\*\*/);
    assert.match(section, /The input box at the\s+bottom never has one/);
    const settings = readme.slice(readme.indexOf('### Settings and themes'));
    assert.match(settings.slice(0, 1200), /\*Claude Code on the Normal Screen\*/);
    assert.match(readme, /nor do the marks of messages sent to Claude\s+Code/);
    assert.match(readme, /\| `⌘⇧↑` \| Scroll the active terminal to the previous prompt or message sent to Claude Code/);
    const doc = read('../../WINDOWS_VERIFICATION.md');
    const v49 = doc.slice(doc.indexOf('### V49 — '));
    assert.ok(v49.length > 30, 'no V49');
    const body = v49.slice(0, v49.indexOf('\n## '));
    for (let i = 1; i <= 13; i += 1) assert.match(body, new RegExp(`\\*\\*C${i} `), `V49 has no C${i}`);
    assert.match(body, /On macOS: C1 to C6 with `⌘⇧↑` \/ `⌘⇧↓`, and the box at rest in WKWebView\./);
    const v48 = doc.slice(doc.indexOf('### V48 — '), doc.indexOf('### V49 — '));
    assert.match(v48, /\*\*H5 Claude Code\.\*\* The prompt Claude Code was launched from has a mark, and\s+so has each message sent to it/);
    assert.match(v48, /the box visible with its outline at rest/);
  });
});

describe('Prompt marks: the documents (F13)', () => {
  test('PRM-25: the README says what is marked, the keys and the setting; V48 lists H1 to H12', () => {
    const readme = read('../../README.md');
    const terminal = readme.slice(readme.indexOf('### Working in a terminal'));
    const marks = terminal.slice(0, terminal.indexOf('\n### ', 5));
    assert.match(marks, /\*\*Prompt marks on the scrollbar\.\*\*/);
    // Which row per shell (PRM-02, PRM-26), and whose keys the chords are.
    assert.match(marks, /In cmd and PowerShell the signal is part of the prompt\s+string, so the mark is on the row you type on/);
    assert.match(marks, /zsh and bash print the signal just before they draw the prompt: when\s+the prompt text arrives after it,[\s\S]*?the mark is on the row the prompt\s+starts on/);
    assert.match(marks, /On a terminal's normal screen these keys belong to NexTerm, also where there\s+are no marks \(fish, ssh, WSL\)/);
    assert.doesNotMatch(marks, /marked on its\s+second line/);
    const keys = readme.slice(readme.indexOf('### Keyboard shortcuts'));
    assert.match(keys, /\| `⌘⇧↑` \| Scroll the active terminal to the previous prompt/);
    assert.match(keys, /\| `⌘⇧↓` \| Scroll the active terminal to the next prompt/);
    const settings = readme.slice(readme.indexOf('### Settings and themes'));
    assert.match(settings.slice(0, 800), /\*Prompt Marks on Scrollbar\*/);
    assert.match(readme, /the sticky command line and the prompt marks on the\s+scrollbar do not come back/);
    const v48 = read('../../WINDOWS_VERIFICATION.md');
    const section = v48.slice(v48.indexOf('### V48 — prompt marks on the scrollbar'));
    assert.ok(section.length > 30, 'no V48');
    for (let i = 1; i <= 12; i += 1) assert.match(section.slice(0, section.indexOf('\n## ')), new RegExp(`\\*\\*H${i} `), `V48 has no H${i}`);
    assert.match(section.slice(0, section.indexOf('\n## ')), /On macOS with zsh:[\s\S]*?a two-line prompt, with\s+starship or powerlevel10k/);
  });
});
