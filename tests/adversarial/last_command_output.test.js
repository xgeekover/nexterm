/**
 * Copy Last Command Output (Secrets Masked) — bundle 4, A2 (AC13, AC14).
 *
 * The tracker on xterm markers, the range it reads (src/lib/lastCommandOutput.js,
 * controlScreen.js `readRows`), why the item is off, the toasts, and where the
 * item is. Terminals are `@xterm/headless`; a C or a D is applied once xterm
 * has parsed what came before it, as the registry does (`afterOutputSoFar`).
 * LCO-99 puts the lookups, the globals and the toasts back.
 */

import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { readScreen, READ_MAX_BYTES } from '../../src/lib/controlScreen.js';
import { contextTerminalOf, NEVER_SHOWN_REASON, setContextTerminalSource } from '../../src/lib/copyContext.js';
import { lastOutputCopiedText, NOT_COPIED } from '../../src/lib/copyFeedback.js';
import {
  CMD_REASON,
  COMMAND_IN_TOAST_MAX,
  COMMAND_RUNNING_REASON,
  commandForToast,
  LAST_COMMAND_OUTPUT_LABEL,
  NO_FINISHED_COMMAND_REASON,
  OUTPUT_GONE_REASON,
  PRINTED_NOTHING_REASON,
  lastCommandOutputItem,
  lastOutputUnavailableOfTab,
  listenForCommands,
  readCommandOutput,
  setLastOutputSource,
  trackLastCommandOutput,
} from '../../src/lib/lastCommandOutput.js';
import { buildPaletteGroups, paletteCommands } from '../../src/lib/paletteItems.js';
import { resetToasts, useToastStore } from '../../src/stores/toastStore.js';

const { Terminal } = headless;

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const source = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const toasts = () => useToastStore.getState().toasts.map((t) => [t.kind, t.text]);
const SECRET = `sk-${'A1b2C3d4E5'.repeat(4)}`;

const makeTerm = (opts = {}) => new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true, ...opts });

/**
 * One command as a shell runs it: the prompt and the typed line (already on
 * screen), then C, its output, D, and the next prompt — each marker applied
 * after what came before it, as the backend now delivers it.
 */
async function runCommand(term, tracker, { command, output, prompt, code = 0 }) {
  await write(term, `${command}\r\n`);
  tracker.started(command);
  await write(term, output);
  tracker.finished(code);
  await write(term, prompt);
}

describe('Copy Last Command Output: the range (AC13)', () => {
  test('LCO-01: a one-line prompt copies exactly the output lines', async () => {
    const term = makeTerm();
    const tracker = trackLastCommandOutput(term);
    await write(term, 'user@host % ');
    await runCommand(term, tracker, { command: 'ls', output: 'README.md  src\r\npackage.json\r\n', prompt: 'user@host % ' });
    const got = readCommandOutput(term, tracker.block);
    assert.equal(got.ok, true);
    assert.equal(got.text, 'README.md  src\npackage.json');
    assert.equal(got.lines, 2);
    assert.equal(got.command, 'ls');
    assert.equal(got.truncated, false);
    assert.equal(got.startGone, false);
  });

  test('LCO-02: a two-line prompt copies exactly the output lines', async () => {
    const term = makeTerm();
    const tracker = trackLastCommandOutput(term);
    await write(term, '~/work on main\r\n❯ ');
    await runCommand(term, tracker, {
      command: 'git status',
      output: 'On branch main\r\nnothing to commit\r\n',
      prompt: '~/work on main\r\n❯ ',
    });
    assert.equal(readCommandOutput(term, tracker.block).text, 'On branch main\nnothing to commit');
  });

  test('LCO-03: printf abc with no newline copies "abc" and not the prompt after it', async () => {
    const term = makeTerm();
    const tracker = trackLastCommandOutput(term);
    await write(term, 'user@host % ');
    await runCommand(term, tracker, { command: 'printf abc', output: 'abc', prompt: 'user@host % ' });
    assert.equal(tracker.block.column, 3, 'the D after "abc"');
    const got = readCommandOutput(term, tracker.block);
    assert.equal(got.text, 'abc');
    assert.equal(got.lines, 1);
  });

  test('LCO-04: a wrapped long line is joined; blank lines at both ends are trimmed', async () => {
    const term = makeTerm();
    const tracker = trackLastCommandOutput(term);
    const long = `${'x'.repeat(70)}END`;
    await write(term, '$ ');
    await runCommand(term, tracker, { command: 'cat long', output: `\r\n\r\n${long}\r\nnext\r\n\r\n\r\n`, prompt: '$ ' });
    const got = readCommandOutput(term, tracker.block);
    assert.equal(got.text, `${long}\nnext`, 'one line for the 73 characters over two rows, no blank edges');
  });

  test('LCO-05: a secret in the output becomes [hidden] exactly as readScreen masks it', async () => {
    const term = makeTerm({ cols: 80 });
    const tracker = trackLastCommandOutput(term);
    await write(term, '$ ');
    const output = `export OPENAI_API_KEY=${SECRET}\r\nplain line\r\ntoken: ${SECRET} tail\r\n`;
    await runCommand(term, tracker, { command: 'env | grep KEY', output, prompt: '$ ' });
    const got = readCommandOutput(term, tracker.block);
    assert.ok(!got.text.includes(SECRET), 'no secret copied');
    assert.ok(got.text.includes('[hidden]'));
    // readScreen's last 4 lines are these 3 and the prompt.
    const screen = readScreen(term, { lines: 4, mask: true });
    assert.deepEqual(got.text.split('\n'), screen.lines.slice(0, 3), 'the same masking as read-screen');
    assert.equal(got.hidden, 2);
  });

  test('LCO-06: output beyond READ_MAX_BYTES is cut oldest first and flagged', async () => {
    const term = makeTerm({ cols: 120, scrollback: 8000 });
    const tracker = trackLastCommandOutput(term);
    await write(term, '$ ');
    const line = (i) => `${String(i).padStart(6, '0')} ${'y'.repeat(93)}`; // 100 bytes
    let output = '';
    for (let i = 1; i <= 6000; i += 1) output += `${line(i)}\r\n`;
    await runCommand(term, tracker, { command: 'big', output, prompt: '$ ' });
    const got = readCommandOutput(term, tracker.block);
    assert.equal(got.truncated, true, 'flagged');
    assert.ok(Buffer.byteLength(got.text) + 1 <= READ_MAX_BYTES, `${Buffer.byteLength(got.text)} B`);
    const lines = got.text.split('\n');
    assert.equal(lines[lines.length - 1], line(6000), 'the newest kept');
    assert.ok(!got.text.includes(line(1)), 'the oldest dropped');
    assert.equal(lines.length, Math.floor(READ_MAX_BYTES / 101));
    // A small cap, the same rule.
    const small = readCommandOutput(term, tracker.block, { maxBytes: 250 });
    assert.deepEqual(small.text.split('\n'), [line(5999), line(6000)]);
    assert.equal(small.truncated, true);
  });

  test('LCO-07: a D with no open C is ignored; a second C replaces an open block', async () => {
    const term = makeTerm();
    const tracker = trackLastCommandOutput(term);
    await write(term, '$ ');
    assert.equal(tracker.finished(0), false, 'a stray D');
    assert.equal(tracker.block, null);
    assert.equal(tracker.running, false);
    await write(term, 'first\r\n');
    assert.equal(tracker.started('first'), true);
    const firstStart = tracker.markers()[0];
    await write(term, 'partial\r\nsecond\r\n');
    tracker.started('second');
    assert.equal(firstStart.isDisposed, true, 'the replaced block lets its marker go');
    await write(term, 'only this\r\n');
    tracker.finished(1);
    const got = readCommandOutput(term, tracker.block);
    assert.equal(got.text, 'only this');
    assert.equal(got.command, 'second');
    assert.equal(tracker.block.exitCode, 1);
    // And a D after it, with no C between (a transient prompt): nothing changes.
    assert.equal(tracker.finished(0), false);
    assert.equal(readCommandOutput(term, tracker.block).text, 'only this');
  });

  test('LCO-08: only the newest finished block and the open one are kept (three markers at most)', async () => {
    const term = makeTerm({ scrollback: 100 });
    const tracker = trackLastCommandOutput(term);
    const old = [];
    for (let i = 0; i < 30; i += 1) {
      await runCommand(term, tracker, { command: `echo ${i}`, output: `out ${i}\r\n`, prompt: '$ ' });
      old.push(...tracker.markers());
      assert.ok(tracker.markers().length <= 2);
    }
    tracker.started('sleep 9');
    assert.equal(tracker.markers().length, 3, 'open start, finished start and end');
    assert.ok(term.markers.length <= 4, `${term.markers.length} xterm markers`);
    assert.equal(readCommandOutput(term, tracker.block).text, 'out 29');
    tracker.dispose();
    assert.equal(term.markers.length, 0, 'every marker goes with the terminal');
    assert.ok(old.every((m) => m.isDisposed));
  });

  test('LCO-09: no marker on the alternate screen; a start gone with its end alive copies what is left and says so', async () => {
    const term = makeTerm();
    const tracker = trackLastCommandOutput(term);
    await write(term, '\x1b[?1049h');
    assert.equal(tracker.started('vim'), false, 'no C on the alternate screen');
    assert.equal(term.markers.length, 0);
    await write(term, '\x1b[?1049l');

    const small = makeTerm({ rows: 5, scrollback: 10 });
    const t2 = trackLastCommandOutput(small);
    let output = '';
    for (let i = 1; i <= 40; i += 1) output += `row ${i}\r\n`;
    await runCommand(small, t2, { command: 'seq', output, prompt: '$ ' });
    const got = readCommandOutput(small, t2.block);
    assert.equal(got.ok, true);
    assert.equal(got.startGone, true);
    assert.ok(got.text.endsWith('row 40') && !got.text.includes('row 1\n'), got.text);
    assert.match(lastOutputCopiedText(got), /its start is no longer in the scrollback/);
  });

  test('LCO-10: a terminal in no pane still gets its blocks (one app-level listener)', async () => {
    const handlers = {};
    const listen = (event, fn) => {
      handlers[event] = fn;
      return Promise.resolve(() => {});
    };
    const term = makeTerm();
    const entry = { sessionId: 's1', term, lastOutput: trackLastCommandOutput(term), disposed: false };
    const other = { sessionId: 's2', term: makeTerm(), lastOutput: null, disposed: false };
    const entries = new Map([['tab-a', entry], ['tab-b', other]]);
    const commands = [];
    await listenForCommands({
      listen,
      entries: () => entries.entries(),
      started: (tabId, e) => {
        commands.push(tabId);
        e.lastOutput.started('make');
      },
      finished: (_tabId, e, code) => e.lastOutput.finished(code),
    });
    await write(term, 'make\r\n');
    handlers['pty-command-started']({ session_id: 's1' });
    await write(term, 'built\r\n');
    handlers['pty-command-done']({ session_id: 's1', exit_code: 2 });
    handlers['pty-command-done']({ session_id: 'nobody', exit_code: 0 });
    assert.deepEqual(commands, ['tab-a'], 'only the terminal of that session');
    assert.equal(entry.lastOutput.block.exitCode, 2);
    assert.equal(readCommandOutput(term, entry.lastOutput.block).text, 'built');
    // The registry runs it for every entry, mounted or not.
    const registry = source('src/components/terminal/terminalRegistry.js');
    assert.match(registry, /lastOutput: trackLastCommandOutput\(term\),/);
    assert.match(registry, /\nensureLastCommandOutputListening\(\);\n/, 'started when the registry loads');
    assert.match(registry, /entries: \(\) => instances\.entries\(\),/, 'every entry in the registry, in a pane or not');
    assert.match(registry, /afterOutputSoFar\(entry, \(e\) => e\.lastOutput\?\.started\(command\)\)/);
    assert.match(registry, /afterOutputSoFar\(entry, \(e\) => e\.lastOutput\?\.finished\(exitCode\)\)/);
    assert.match(registry, /entry\.lastOutput\?\.dispose\(\);/);
  });

  test('LCO-11: when one of the two listens fails, the other is taken back before it rejects — a retry listens to each once (review A-R4)', async () => {
    const live = { 'pty-command-started': 0, 'pty-command-done': 0 };
    const unlistened = [];
    const listenFailing = (failing, how = 'reject') => (event, _fn) => {
      if (event === failing) {
        if (how === 'throw') throw new Error(`no ${event}`);
        return Promise.reject(new Error(`no ${event}`));
      }
      live[event] += 1;
      return Promise.resolve(() => {
        live[event] -= 1;
        unlistened.push(event);
      });
    };
    const noop = { entries: () => [].values(), started: () => {}, finished: () => {} };
    for (const [failing, how] of [['pty-command-done', 'reject'], ['pty-command-started', 'reject'], ['pty-command-done', 'throw']]) {
      unlistened.length = 0;
      let error = null;
      try {
        await listenForCommands({ listen: listenFailing(failing, how), ...noop });
      } catch (err) {
        error = err;
      }
      assert.match(error?.message ?? '', new RegExp(`no ${failing}`), `${failing} (${how}): it rejects with the failure`);
      const other = failing === 'pty-command-done' ? 'pty-command-started' : 'pty-command-done';
      assert.deepEqual(unlistened, [other], `${failing} (${how}): the one that succeeded is taken back`);
      assert.deepEqual(live, { 'pty-command-started': 0, 'pty-command-done': 0 }, 'nothing left listening');
    }
    // The retry, once both work: each listened to exactly once.
    const unlisten = await listenForCommands({ listen: listenFailing(null), ...noop });
    assert.deepEqual(live, { 'pty-command-started': 1, 'pty-command-done': 1 });
    assert.equal(unlisten.length, 2);
    for (const fn of unlisten) fn();
    // The registry resets its guard only on that rejection.
    const registry = source('src/components/terminal/terminalRegistry.js');
    assert.match(registry, /lastOutputListening = listenForCommands\(\{[\s\S]*?\}\)\.catch\(\(err\) => \{\s*lastOutputListening = null;/);
  });
});

describe('Copy Last Command Output: reasons and feedback (AC14)', () => {
  /** Terminals by tab id for both lookups: `shown` (terminal + tracker), `cmd`, `never`. */
  async function setUp() {
    const term = makeTerm({ cols: 80 });
    const tracker = trackLastCommandOutput(term);
    const cmdTerm = makeTerm();
    const shells = { shown: { term, tracker, isCmd: false }, cmd: { term: cmdTerm, tracker: trackLastCommandOutput(cmdTerm), isCmd: true } };
    setContextTerminalSource((tabId) => shells[tabId]?.term ?? null);
    setLastOutputSource((tabId) => (shells[tabId] ? { tracker: shells[tabId].tracker, isCmd: shells[tabId].isCmd } : null));
    resetToasts();
    return { term, tracker };
  }
  const recorder = () => {
    const written = [];
    return { written, copy: (text) => { written.push(text); return Promise.resolve(true); } };
  };

  test('LCO-20: off with the reason for never shown, cmd, no finished command and running', async () => {
    const { term, tracker } = await setUp();
    assert.equal(contextTerminalOf('never'), null);
    const reason = (tabId) => lastCommandOutputItem({ tabId }).disabledReason;
    assert.equal(reason('never'), NEVER_SHOWN_REASON);
    assert.equal(reason('cmd'), CMD_REASON);
    assert.match(CMD_REASON, /use Copy Last N Lines/);
    assert.equal(reason('shown'), NO_FINISHED_COMMAND_REASON);
    await write(term, 'sleep 5\r\n');
    tracker.started('sleep 5');
    assert.equal(reason('shown'), COMMAND_RUNNING_REASON);
    assert.match(COMMAND_RUNNING_REASON, /Copy Last N Lines copies what it has printed so far/);
    await write(term, 'done\r\n');
    tracker.finished(0);
    const item = lastCommandOutputItem({ tabId: 'shown' });
    assert.equal(item.disabled, false);
    assert.equal(item.disabledReason, undefined);
    assert.equal(item.label, LAST_COMMAND_OUTPUT_LABEL);
    assert.equal(lastCommandOutputItem({ tabId: 'never' }).disabled, true);
  });

  test('LCO-21: copied inside the click, before anything is awaited; the toast names the masked, shortened command', async () => {
    const { term, tracker } = await setUp();
    const command = `curl -H "Authorization: Bearer ${SECRET}" https://example.invalid/${'p'.repeat(60)}`;
    await runCommand(term, tracker, { command, output: 'a\r\nb\r\nc\r\n', prompt: '$ ' });
    const { written, copy } = recorder();
    const done = lastCommandOutputItem({ tabId: 'shown', copy }).onSelect();
    assert.equal(written.length, 1, 'the clipboard was written inside the click');
    assert.equal(written[0], 'a\nb\nc');
    assert.equal(await done, true);
    const [[kind, text]] = toasts();
    assert.equal(kind, 'confirm');
    assert.ok(!text.includes(SECRET), text);
    const named = commandForToast(command);
    assert.ok(named.includes('[hidden]'), named);
    assert.equal(Array.from(named).length, COMMAND_IN_TOAST_MAX);
    assert.ok(named.endsWith('…'));
    assert.equal(text, `Copied 3 lines of the output of "${named}" (secrets masked)`);
    resetToasts();
  });

  test('LCO-22: a generic wording when the command text is unknown; one line singular', async () => {
    const { term, tracker } = await setUp();
    await write(term, '\r\n');
    tracker.started(null);
    await write(term, 'only\r\n');
    tracker.finished(0);
    const { copy } = recorder();
    await lastCommandOutputItem({ tabId: 'shown', copy }).onSelect();
    assert.deepEqual(toasts(), [['confirm', "Copied 1 line of the last command's output (secrets masked)"]]);
    resetToasts();
  });

  test('LCO-23: click-time errors: printed nothing; no longer in the scrollback after Terminal: Clear; clipboard refused', async () => {
    const { term, tracker } = await setUp();
    await runCommand(term, tracker, { command: 'true', output: '', prompt: '$ ' });
    const { written, copy } = recorder();
    assert.equal(await lastCommandOutputItem({ tabId: 'shown', copy }).onSelect(), false);
    assert.deepEqual(toasts(), [['error', 'Not copied: the last command printed nothing to the scrollback']]);
    assert.equal(written.length, 0);
    resetToasts();

    await runCommand(term, tracker, { command: 'ls', output: 'x\r\n', prompt: '$ ' });
    // Terminal: Clear as the registry runs it (`clearTerminal`): xterm's
    // clear() leaves markers where they were, on rows it blanked, so the
    // tracker is told.
    term.clear();
    tracker.cleared();
    assert.equal(readCommandOutput(term, tracker.block).reason, OUTPUT_GONE_REASON);
    assert.match(source('src/components/terminal/terminalRegistry.js'), /entry\.term\.clear\(\);\n[\s\S]{0,400}?entry\.lastOutput\?\.cleared\(\);/);
    assert.equal(await lastCommandOutputItem({ tabId: 'shown', copy }).onSelect(), false);
    assert.deepEqual(toasts(), [['error', "Not copied: the last command's output is no longer in the scrollback"]]);
    assert.equal(written.length, 0);
    resetToasts();

    await runCommand(term, tracker, { command: 'ls', output: 'y\r\n', prompt: '$ ' });
    assert.equal(await lastCommandOutputItem({ tabId: 'shown', copy: () => Promise.reject(new Error('no')) }).onSelect(), false);
    assert.deepEqual(toasts(), [['error', NOT_COPIED]]);
    assert.equal(PRINTED_NOTHING_REASON, 'The last command printed nothing to the scrollback');
    resetToasts();
  });

  test('LCO-24: next to Copy Last N Lines in the tab chip menu, the TERMINALS row menu and the Command Palette', () => {
    for (const file of ['src/components/terminal/TerminalSplitContainer.jsx', 'src/components/terminal/TerminalsPanel.jsx']) {
      const src = source(file);
      const context = src.indexOf('copyContextItem({');
      const item = src.indexOf('lastCommandOutputItem({', context);
      const readOnly = src.indexOf('readOnlyItem({', context);
      assert.ok(context > 0 && item > context && item < readOnly, `${file}: right after Copy Last N Lines`);
      assert.match(src, /import \{ lastCommandOutputItem \} from '\.\.\/\.\.\/lib\/lastCommandOutput\.js';/, file);
      assert.doesNotMatch(src.slice(item, readOnly), /onSelect/, `${file}: the default copy inside the click`);
    }
    const commands = paletteCommands();
    const at = commands.findIndex((c) => c.command === 'copy_terminal_context');
    assert.equal(commands[at + 1]?.command, 'copy_last_command_output', 'right after Copy Last N Lines');
    assert.equal(commands[at + 1].title, LAST_COMMAND_OUTPUT_LABEL);
    const listed = (copyContext) =>
      buildPaletteGroups({ mode: 'commands', query: '', copyContext })
        .flatMap((g) => g.items)
        .some((i) => i.command === 'copy_last_command_output');
    assert.equal(listed({ lines: 200 }), true, 'listed for a terminal shown');
    assert.equal(listed(null), false, 'not for one never shown');
    // The palette copies before it awaits anything (H9).
    const palette = source('src/components/command/CommandPalette.jsx');
    const start = palette.indexOf("case 'copy_last_command_output':");
    assert.ok(start > 0);
    const body = palette.slice(start, palette.indexOf('return;', start));
    assert.doesNotMatch(body.replace(/\/\/[^\n]*/g, ''), /\bawait\b/);
    assert.match(body, /copyLastOutputOfTabAndConfirm\(useTerminalStore\.getState\(\)\.activeTabId\);/);
  });

  test('LCO-25: the Command Palette greys the row out with its reason, as Send to Agent is — cmd, none finished, running — and lists it as before once it can copy (review B-R4)', async () => {
    const { term, tracker } = await setUp();
    const row = (lastOutput) =>
      buildPaletteGroups({ mode: 'all', query: '', copyContext: { lines: 200 }, lastOutput })
        .flatMap((g) => g.items)
        .find((i) => i.command === 'copy_last_command_output');
    const plain = paletteCommands().find((c) => c.command === 'copy_last_command_output');
    for (const [tabId, reason] of [['cmd', CMD_REASON], ['shown', NO_FINISHED_COMMAND_REASON]]) {
      const greyed = row(lastOutputUnavailableOfTab(tabId));
      assert.equal(greyed?.disabledReason, reason, `${tabId}: greyed out`);
      assert.equal(greyed.subtitle, reason, `${tabId}: the row says why`);
      assert.equal(greyed.title, LAST_COMMAND_OUTPUT_LABEL);
    }
    await write(term, 'sleep 5\r\n');
    tracker.started('sleep 5');
    assert.equal(row(lastOutputUnavailableOfTab('shown'))?.disabledReason, COMMAND_RUNNING_REASON);
    await write(term, 'done\r\n');
    tracker.finished(0);
    assert.equal(lastOutputUnavailableOfTab('shown'), null);
    assert.deepEqual(row(lastOutputUnavailableOfTab('shown')), plain, 'it can copy: listed as it is, not greyed');
    assert.deepEqual(row(undefined), plain, 'a caller that says nothing lists it as it is');
    // The palette asks for the active terminal as it opens, passes the
    // reason on, and a greyed-out row does nothing — no toast.
    const palette = source('src/components/command/CommandPalette.jsx');
    assert.match(palette, /isOpen && paletteMode === 'all' && activeTabId \? lastOutputUnavailableOfTab\(activeTabId\) : undefined/);
    assert.match(palette, /lastOutput: lastOutputState,/);
    assert.ok(palette.includes('if (item.disabledReason) return;'));
  });

  test('LCO-99: the lookups, the globals and the toasts as they were', () => {
    setContextTerminalSource(null);
    setLastOutputSource(null);
    resetToasts();
    assert.equal(contextTerminalOf('shown'), null);
    assert.deepEqual(useToastStore.getState().toasts, []);
  });
});
