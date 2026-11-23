/**
 * The tab hover card (Orca bundle 4, B12): what it says (src/lib/tabHoverCard.js,
 * `tabHoverCardRows`), what it cleans out of someone else's text, and when it
 * shows (`createHoverCardController`, on fake timers handed in) — and that
 * the chip it replaced the native tooltip of is wired to it.
 *
 *   AC-B12-1  the rows for a plain shell, a running command, a Claude Code tab
 *             working for minutes, an exited tab, and the three flags (HC-01..09)
 *   AC-B12-2  600 ms to show, 100 ms to go, an immediate switch, nothing during
 *             a drag, a rename or a menu, nor after a press (HC-20..29)
 *   AC-B12-3  keyboard focus, Escape, aria-describedby only while shown
 *             (HC-30..35; on a real chip in a browser, split_lock_headless
 *             HS-16), and a removed chip element's pointer, focus and
 *             Escape let go (`forget`, HC-36..39)
 *   AC-B12-4  no native title on the chip, the old hint gone from the source,
 *             its meaning in the card (HC-40..42; the render suite draws it)
 *   AC-B12-5  ESC, BEL, bidi overrides and zero-width characters never reach
 *             the card (HC-50..53)
 *
 * And mounted on the hand-written page of react_page.js (HC-60..64), with
 * TabHoverCard.jsx bundled by esbuild (Node cannot import JSX) around the
 * real stores: a card whose chip element is replaced goes (the strip
 * moving into or out of Hide Single Tab Strip's overlay), and so does the
 * focus that element held; the chip elements of closed tabs are let go, and
 * so is what a tab that left the row held; and a card that grows is placed
 * again.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { dispatch, letItRun, onPage } from './react_page.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  CARD_FOLDER_MAX,
  CARD_TITLE_MAX,
  controlledFlag,
  HOVER_CARD_CLOSE_MS,
  HOVER_CARD_HINT,
  HOVER_CARD_OPEN_MS,
  cardPosition,
  chipDescribedBy,
  cleanCardText,
  createHoverCardController,
  hoverCardBlocked,
  middleShorten,
  shellName,
  tabHoverCardRows,
} from '../../src/lib/tabHoverCard.js';
import {
  STATUS_GLYPHS,
  agentLabel,
  elapsedSince,
  elapsedWords,
  statusText,
  terminalStatus,
} from '../../src/lib/terminalStatus.js';
import { TYPING_HIDDEN_LABEL } from '../../src/lib/secretInput.js';
import { READ_ONLY_LABEL } from '../../src/lib/readOnly.js';

const source = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const MINUTE = 60 * 1000;
const NOW = 1_800_000_000_000;

/** A terminal tab as the store keeps one. */
const tab = (extra = {}) => ({
  id: 't1',
  sessionId: 'sess-1',
  title: 'Terminal 1',
  defaultTitle: 'Terminal 1',
  cwd: '/Users/me/work/app',
  running: false,
  lastExitCode: null,
  exited: null,
  ...extra,
});

/** A Claude Code tab whose agent is believed to run (`agentRuns`). */
const claudeTab = (extra = {}) =>
  tab({ agent: { kind: 'claude', sessionId: 'c-1' }, agentTyped: { sessionId: 'sess-1' }, ...extra });

const keys = (rows) => rows.map((r) => r.key);
const row = (rows, key) => rows.find((r) => r.key === key) ?? null;

/** Fake setTimeout/clearTimeout with a clock that only moves when told to. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    get live() {
      return timers.size;
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) if (timer.at <= target && (!due || timer.at < due[1].at)) due = [id, timer];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** A controller on fake timers, and every change it reported. */
function controller() {
  const time = fakeTimers();
  const changes = [];
  const card = createHoverCardController({
    onChange: (id) => changes.push(id),
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  return { card, time, changes };
}

// ---- What it says (AC-B12-1) ---------------------------------------------------

describe('The tab hover card: its rows (B12-F1, AC-B12-1)', () => {
  test('HC-01: a plain shell — its name, folder, shell and the hint, no state and no flags', () => {
    const rows = tabHoverCardRows(tab(), { shellPath: '/bin/zsh', platform: 'macos', now: NOW });
    assert.deepEqual(keys(rows), ['title', 'folder', 'shell', 'hint']);
    assert.equal(row(rows, 'title').text, 'Terminal 1');
    assert.equal(row(rows, 'folder').text, '/Users/me/work/app');
    assert.equal(row(rows, 'shell').text, 'zsh');
    assert.equal(row(rows, 'hint').text, 'Drag to reorder or move \u{00B7} Double-click to rename');
    assert.equal(row(rows, 'hint').dim, true, 'the hint is drawn quieter');
  });

  test('HC-02: a running command — "Running" with its glyph, and no time: the row names no agent', () => {
    const t = tab({ running: true, runStartedAt: NOW - 5 * MINUTE });
    const rows = tabHoverCardRows(t, { now: NOW });
    const status = row(rows, 'status');
    assert.deepEqual({ text: status.text, glyph: status.glyph, state: status.state }, { text: 'Running', glyph: STATUS_GLYPHS.running, state: 'running' });
    assert.deepEqual(keys(rows), ['title', 'status', 'folder', 'hint'], 'no shell row without a shell path');
  });

  test('HC-03: Claude Code working for 3 minutes — agent, state and time in words, as the TERMINALS row works them out', () => {
    const t = claudeTab();
    const activity = { state: 'working', since: NOW - 3 * MINUTE - 20_000 };
    const rows = tabHoverCardRows(t, { activity, now: NOW });
    const status = row(rows, 'status');
    assert.equal(status.text, 'Claude Code \u{00B7} Working for 3 minutes');
    assert.equal(status.glyph, STATUS_GLYPHS.working);
    // The very helpers of TerminalStatusLine (StatusBoard.jsx), so the two agree.
    const st = terminalStatus(t, { unread: 0, progress: null, activity });
    const since = elapsedSince(t, st, { activity, agentRow: Boolean(agentLabel(t)) });
    assert.equal(status.text, `${agentLabel(t)} \u{00B7} ${statusText(st)} ${elapsedWords(NOW - since)}`);
    // Under a minute it says only what it is, as the row does.
    const fresh = tabHoverCardRows(t, { activity: { state: 'working', since: NOW - 30_000 }, now: NOW });
    assert.equal(row(fresh, 'status').text, 'Claude Code \u{00B7} Working');
  });

  test('HC-04: Claude Code waiting on you — Waiting since it went idle, and the unread count as a flag', () => {
    const t = claudeTab();
    const rows = tabHoverCardRows(t, { unread: 1, activity: { state: 'idle', since: NOW - 12 * MINUTE }, now: NOW });
    assert.equal(row(rows, 'status').text, 'Claude Code \u{00B7} Waiting for 12 minutes');
    assert.equal(row(rows, 'status').glyph, STATUS_GLYPHS.waiting);
    assert.deepEqual(row(rows, 'flags').items, ['1 unread notification']);
  });

  test('HC-05: an exited tab — "Exited" with its code, as the old tooltip said; without a code, "Exited"', () => {
    const rows = tabHoverCardRows(tab({ exited: { code: 1 } }), { now: NOW });
    assert.deepEqual({ text: row(rows, 'status').text, glyph: row(rows, 'status').glyph }, { text: 'Exited (code 1)', glyph: STATUS_GLYPHS.exited });
    assert.equal(row(tabHoverCardRows(tab({ exited: { code: null } }), { now: NOW }), 'status').text, 'Exited');
    // A failed last command keeps its code too.
    assert.equal(row(tabHoverCardRows(tab({ lastExitCode: 2 }), { now: NOW }), 'status').text, 'Failed (exit 2)');
    // An exited Claude Code tab names no agent: it is not running.
    const gone = tabHoverCardRows(claudeTab({ exited: { code: 0 } }), { activity: { state: 'working', since: NOW - 9 * MINUTE }, now: NOW });
    assert.equal(row(gone, 'status').text, 'Exited (code 0)');
  });

  test('HC-06: typing hidden, read-only and 3 unread — each flag in the words its badge says, in that order', () => {
    const rows = tabHoverCardRows(tab(), { locked: true, readOnly: true, unread: 3, now: NOW });
    assert.deepEqual(row(rows, 'flags').items, [TYPING_HIDDEN_LABEL, READ_ONLY_LABEL, '3 unread notifications']);
    assert.equal(row(rows, 'status').text, 'Waiting', 'unread entries are what waiting is');
    // None of them, no flags row.
    assert.equal(row(tabHoverCardRows(tab(), { unread: 0, now: NOW }), 'flags'), null);
  });

  test('HC-14: another terminal controlling it — the chip badge\'s words as a flag, before the unread count; the caller\'s name cleaned', () => {
    const controlled = { by: 't2', byTitle: 'agent', cmd: 'send', at: NOW, n: 1 };
    const rows = tabHoverCardRows(tab(), { readOnly: true, unread: 2, controlled, now: NOW });
    assert.deepEqual(row(rows, 'flags').items, [READ_ONLY_LABEL, 'Controlled by agent (send)', '2 unread notifications']);
    assert.equal(controlledFlag({ byTitle: 'agent', cmd: '' }), 'Controlled by agent');
    assert.equal(controlledFlag({ byTitle: '\u202Eevil\u200B\u0007', cmd: 'send\u001b' }), 'Controlled by evil (send)');
    for (const none of [null, undefined, {}, { byTitle: '' }, { byTitle: '\u200B' }, 'agent']) {
      assert.equal(controlledFlag(none), '', JSON.stringify(none));
    }
    assert.equal(row(tabHoverCardRows(tab(), { controlled: null, now: NOW }), 'flags'), null, 'no mark, no flag');
    // The card reads the mark the chip's badge draws.
    const card = source('src/components/terminal/TabHoverCard.jsx');
    assert.match(card, /const controlled = useTerminalStore\(\(s\) => s\.controlled\?\.\[tabId\] \?\? null\);/);
  });

  test('HC-07: the rows come in their order, and the last notification is dimmed — its body alone when the agent is named', () => {
    const note = { kind: 'program', title: 'Claude Code', body: 'Session done', tabTitle: 'Terminal 1', at: NOW - MINUTE, read: false };
    const rows = tabHoverCardRows(claudeTab(), {
      activity: { state: 'idle', since: NOW - 2 * MINUTE },
      unread: 1,
      locked: true,
      note,
      shellPath: '/bin/bash',
      platform: 'linux',
      now: NOW,
    });
    assert.deepEqual(keys(rows), ['title', 'status', 'folder', 'shell', 'flags', 'note', 'hint']);
    assert.deepEqual({ text: row(rows, 'note').text, dim: row(rows, 'note').dim }, { text: 'Session done', dim: true });
    // No agent named on the card: who spoke stays in the line.
    assert.equal(row(tabHoverCardRows(tab(), { note, now: NOW }), 'note').text, 'Claude Code \u{2014} Session done');
    assert.equal(row(tabHoverCardRows(tab(), { note: { kind: 'command', exitCode: 2, durationMs: 4000, at: NOW }, now: NOW }), 'note').text, 'Command failed (exit 2) after 4s');
  });

  test("HC-08: the title is the chip's own (displayTitle) in full — a program's title, the user's name over it — cut only past 200 characters", () => {
    assert.equal(row(tabHoverCardRows(tab({ programTitle: 'vim notes.md' }), { now: NOW }), 'title').text, 'vim notes.md');
    assert.equal(row(tabHoverCardRows(tab({ title: 'build', programTitle: 'vim notes.md' }), { now: NOW }), 'title').text, 'build');
    const long = 'x'.repeat(150) + 'y'.repeat(100);
    const shown = row(tabHoverCardRows(tab({ title: long }), { now: NOW }), 'title').text;
    assert.equal(Array.from(shown).length, CARD_TITLE_MAX);
    assert.ok(shown.endsWith('\u{2026}') && shown.startsWith('x'.repeat(150)), 'longer than the chip, cut at its end');
    assert.deepEqual(tabHoverCardRows(null), [], 'no tab, no card');
  });

  test('HC-09: never the screen nor the command line (OQ4): text the tab carries elsewhere is not on the card', () => {
    const t = tab({ running: true, lastCommand: 'SECRET-CMD --token=abc', commandLine: 'SECRET-CMD', screen: 'SECRET-SCREEN', scrollback: 'SECRET-SCREEN' });
    const rows = tabHoverCardRows(t, { shellPath: '/bin/zsh', platform: 'macos', now: NOW });
    for (const r of rows) assert.ok(!r.text.includes('SECRET'), `the card says ${JSON.stringify(r.text)}`);
    // And the card's source reads none of it.
    const model = source('src/lib/tabHoverCard.js');
    assert.doesNotMatch(model, /\b(lastCommand|commandLine|scrollback|readScreen|buffer)\b/);
  });

  test('HC-10: the folder loses its middle past 56 characters, keeping its start and the folder it ends in', () => {
    const path = '/Users/someone/Projects/clients/acme/very-long-repository-name/packages/web-app';
    const shown = middleShorten(path);
    assert.equal(Array.from(shown).length, CARD_FOLDER_MAX);
    assert.ok(shown.includes('\u{2026}') && shown.startsWith('/Users/someone') && shown.endsWith('packages/web-app'), shown);
    assert.equal(middleShorten('/short/path'), '/short/path');
    assert.equal(middleShorten(null), '');
    assert.equal(row(tabHoverCardRows(tab({ cwd: path }), { now: NOW }), 'folder').text, shown);
    assert.equal(row(tabHoverCardRows(tab({ cwd: null }), { now: NOW }), 'folder'), null, 'no folder yet, no row');
  });

  test('HC-11: the shell as the app names it, on each platform; nothing for no shell', () => {
    assert.equal(shellName('/bin/zsh', 'macos'), 'zsh');
    assert.equal(shellName('/usr/bin/fish', 'linux'), 'fish');
    assert.equal(shellName('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'windows'), 'PowerShell');
    assert.equal(shellName('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'windows'), 'PowerShell 7');
    assert.equal(shellName('C:\\Windows\\System32\\cmd.exe', 'windows'), 'cmd');
    assert.equal(shellName('wsl.exe', 'windows'), 'WSL');
    assert.equal(shellName('/opt/bin/xonsh', 'macos'), 'xonsh', 'one it does not know, by its name');
    assert.equal(shellName('', 'macos'), '');
    assert.equal(shellName(null, 'macos'), '');
  });

  test("HC-12: Show CPU and Memory on — 'CPU% · memory' between the shell and the flags, its words saying 'of one core'; measuring, partial and WSL (B8-F4)", () => {
    const MIB = 1024 * 1024;
    const usage = { sessionId: 'sess-1', cpuPercent: 12.4, memoryBytes: 340 * MIB, processes: 3, partial: false };
    const on = { showUsage: true, shellPath: '/bin/zsh', platform: 'macos', readOnly: true, now: NOW };
    const rows = tabHoverCardRows(tab(), { ...on, usage });
    assert.deepEqual(keys(rows), ['title', 'folder', 'shell', 'usage', 'flags', 'hint']);
    assert.deepEqual(row(rows, 'usage'), {
      key: 'usage',
      text: '12% \u{00B7} 340 MB',
      words: 'CPU 12% of one core, memory 340 MB, in 3 processes.',
      wsl: false,
    });
    assert.equal(row(tabHoverCardRows(tab(), { ...on, usage: { ...usage, cpuPercent: null } }), 'usage').text, 'measuring \u{00B7} 340 MB');
    const partial = row(tabHoverCardRows(tab(), { ...on, usage: { ...usage, cpuPercent: 140, memoryBytes: 1.2 * 1024 * MIB, partial: true } }), 'usage');
    assert.equal(partial.text, '140% \u{00B7} 1.2 GB \u{00B7} partial');
    assert.match(partial.words, /could not be read/);
    // A WSL terminal: no figures to wait for, and none asked for.
    const wsl = row(tabHoverCardRows(tab({ shell: 'wsl.exe' }), { ...on, shellPath: 'wsl.exe', platform: 'windows' }), 'usage');
    assert.deepEqual({ text: wsl.text, wsl: wsl.wsl }, { text: 'not measurable', wsl: true });
    assert.match(wsl.words, /WSL/);
    assert.equal(row(tabHoverCardRows(tab({ exited: { code: 0 } }), { ...on, shellPath: 'wsl.exe', platform: 'windows' }), 'usage'), null, 'an exited WSL shell has nothing to say');
    assert.equal(row(tabHoverCardRows(tab(), { ...on, shellPath: 'wsl.exe', platform: 'macos', usage }), 'usage').wsl, false, 'WSL only on Windows');
    // No sample yet, or one that is not a figure: no row, no placeholder.
    assert.equal(row(tabHoverCardRows(tab(), on), 'usage'), null);
    assert.equal(row(tabHoverCardRows(tab(), { ...on, usage: { cpuPercent: '<b>9</b>', memoryBytes: '340' } }), 'usage'), null);
  });

  test('HC-13: Show CPU and Memory off — no usage row, nor any figure, even with a sample or for a WSL terminal; only an exact true turns it on', () => {
    const usage = { sessionId: 'sess-1', cpuPercent: 12, memoryBytes: 340 * 1024 * 1024, processes: 3, partial: true };
    for (const showUsage of [false, undefined, null, 1, 'true', {}]) {
      for (const [t, shellPath, platform] of [[tab(), '/bin/zsh', 'macos'], [tab({ shell: 'wsl.exe' }), 'wsl.exe', 'windows']]) {
        const rows = tabHoverCardRows(t, { showUsage, usage, shellPath, platform, now: NOW });
        assert.equal(row(rows, 'usage'), null, `a usage row with showUsage ${JSON.stringify(showUsage)}`);
        const text = rows.map((r) => r.text).join('\n');
        assert.doesNotMatch(text, /%|\bMB\b|measuring|measurable|partial/, `a figure with showUsage ${JSON.stringify(showUsage)}: ${text}`);
      }
    }
  });
});

// ---- When it shows (AC-B12-2) --------------------------------------------------

describe('The tab hover card: when it shows (B12-F2, AC-B12-2)', () => {
  test('HC-20: nothing before 600 ms on a chip; the card at 600 ms', () => {
    const { card, time, changes } = controller();
    assert.equal(HOVER_CARD_OPEN_MS, 600);
    card.enter('a');
    time.advance(599);
    assert.equal(card.shown, null, 'shown before 600 ms');
    time.advance(1);
    assert.equal(card.shown, 'a');
    assert.deepEqual(changes, ['a']);
  });

  test('HC-21: gone within 150 ms of leaving — 100 ms of grace, then nothing; a pointer only passing never shows it', () => {
    const { card, time, changes } = controller();
    assert.equal(HOVER_CARD_CLOSE_MS, 100);
    card.enter('a');
    time.advance(600);
    card.leave('a');
    time.advance(99);
    assert.equal(card.shown, 'a', 'gone before the grace ended');
    time.advance(1);
    assert.equal(card.shown, null, 'still shown 100 ms after leaving');
    card.enter('b');
    time.advance(300);
    card.leave('b');
    time.advance(2000);
    assert.equal(card.shown, null, 'a pass over a chip showed its card');
    assert.deepEqual(changes, ['a', null]);
    assert.equal(time.live, 0, 'a timer left running');
  });

  test('HC-22: moving to the next chip while one is shown switches at once, with no second wait', () => {
    const { card, time, changes } = controller();
    card.enter('a');
    time.advance(600);
    card.leave('a');
    time.advance(20);
    card.enter('b');
    assert.equal(card.shown, 'b', 'the neighbour waited');
    time.advance(500);
    assert.equal(card.shown, 'b', 'the grace of the first chip closed the second');
    assert.deepEqual(changes, ['a', 'b']);
    // Once it has gone, the next chip waits again.
    card.leave('b');
    time.advance(100);
    card.enter('c');
    time.advance(599);
    assert.equal(card.shown, null);
    time.advance(1);
    assert.equal(card.shown, 'c');
  });

  test('HC-23: coming back onto the chip within the grace keeps the card', () => {
    const { card, time, changes } = controller();
    card.enter('a');
    time.advance(600);
    card.leave('a');
    time.advance(50);
    card.enter('a');
    time.advance(1000);
    assert.equal(card.shown, 'a');
    assert.deepEqual(changes, ['a']);
  });

  test('HC-24: during a drag, a rename or an open menu: no card, and a shown one goes at once', () => {
    for (const holds of [{ dragging: true }, { renaming: true }, { menuOpen: true }]) {
      const { card, time } = controller();
      assert.equal(hoverCardBlocked(holds), true, JSON.stringify(holds));
      card.enter('a');
      time.advance(600);
      card.setBlocked(hoverCardBlocked(holds));
      assert.equal(card.shown, null, `shown with ${JSON.stringify(holds)}`);
      card.leave('a');
      card.enter('b');
      time.advance(2000);
      assert.equal(card.shown, null, `a card came during ${JSON.stringify(holds)}`);
      // A wait already running when it began is dropped.
      const later = controller();
      later.card.enter('a');
      later.time.advance(300);
      later.card.setBlocked(true);
      later.time.advance(1000);
      assert.equal(later.card.shown, null);
    }
    assert.equal(hoverCardBlocked({}), false);
    assert.equal(hoverCardBlocked({ dragging: false, renaming: false, menuOpen: false }), false);
  });

  test('HC-25: after it is over, the next hover shows it again', () => {
    const { card, time } = controller();
    card.setBlocked(true);
    card.enter('a');
    card.setBlocked(false);
    time.advance(1000);
    assert.equal(card.shown, null, 'the hover from during the drag came back');
    card.leave('a');
    card.enter('a');
    time.advance(600);
    assert.equal(card.shown, 'a');
  });

  test('HC-26: a press puts it away at once, and it stays away until the pointer has left that chip', () => {
    const { card, time } = controller();
    card.enter('a');
    time.advance(600);
    card.press('a');
    assert.equal(card.shown, null, 'a press left the card up');
    card.enter('a');
    time.advance(2000);
    assert.equal(card.shown, null, 'it came back with the pointer still on the pressed chip');
    card.focus('a', true);
    time.advance(2000);
    assert.equal(card.shown, null, 'it came back through focus after the press');
    card.leave('a');
    card.enter('a');
    time.advance(600);
    assert.equal(card.shown, 'a', 'gone for good');
  });

  test('HC-27: a press before the 600 ms drops the wait', () => {
    const { card, time } = controller();
    card.enter('a');
    time.advance(400);
    card.press('a');
    time.advance(2000);
    assert.equal(card.shown, null);
    assert.equal(time.live, 0);
    // Another chip is not held by it.
    card.enter('b');
    time.advance(600);
    assert.equal(card.shown, 'b');
  });

  test('HC-28: the chip going away takes its card (hide)', () => {
    const { card, time } = controller();
    card.enter('a');
    time.advance(600);
    card.hide();
    assert.equal(card.shown, null);
    assert.equal(time.live, 0);
  });

  test('HC-29: it goes below its chip, inside the window — above it when there is no room below', () => {
    const chip = { left: 100, right: 190, top: 40, bottom: 62 };
    assert.deepEqual(cardPosition(chip, { width: 240, height: 90, viewportWidth: 1200, viewportHeight: 800 }), { left: 100, top: 66 });
    assert.deepEqual(cardPosition({ ...chip, left: 1100, right: 1190 }, { width: 240, height: 90, viewportWidth: 1200, viewportHeight: 800 }), { left: 956, top: 66 }, 'kept 4 px inside the right edge');
    assert.deepEqual(cardPosition({ left: 10, right: 90, top: 700, bottom: 722 }, { width: 200, height: 120, viewportWidth: 1200, viewportHeight: 800 }), { left: 10, top: 576 });
    assert.deepEqual(cardPosition(null), { left: 4, top: 4 });
  });
});

// ---- The keyboard (AC-B12-3) ---------------------------------------------------

describe('The tab hover card: the keyboard (B12-F3, AC-B12-3)', () => {
  test('HC-30: keyboard focus (focus-visible) opens it after the same delay; a click\'s focus does not', () => {
    const { card, time } = controller();
    card.focus('a', false);
    time.advance(2000);
    assert.equal(card.shown, null, "a click's focus opened it");
    card.blur('a');
    card.focus('a', true);
    time.advance(599);
    assert.equal(card.shown, null);
    time.advance(1);
    assert.equal(card.shown, 'a');
  });

  test('HC-31: Escape hides it and is taken; with nothing to hide it is not; the chip keeps focus, so no blur', () => {
    const { card, time } = controller();
    assert.equal(card.escape(), false, 'Escape taken with no card');
    card.focus('a', true);
    time.advance(600);
    assert.equal(card.escape(), true);
    assert.equal(card.shown, null);
    time.advance(5000);
    assert.equal(card.shown, null, 'it came back while focus stayed on the chip');
    assert.equal(card.escape(), false, 'a second Escape is not the card\'s');
    // Focus leaving and coming back opens it again.
    card.blur('a');
    card.focus('a', true);
    time.advance(600);
    assert.equal(card.shown, 'a');
  });

  test('HC-32: Escape during the wait drops it, and is not taken: nothing on screen was closed', () => {
    const { card, time, changes } = controller();
    card.focus('a', true);
    time.advance(300);
    assert.equal(card.pending, 'a');
    assert.equal(card.escape(), false, 'Escape taken while no card was shown');
    assert.equal(card.pending, null, 'the wait goes on');
    assert.equal(time.live, 0);
    time.advance(1000);
    assert.equal(card.shown, null);
    assert.deepEqual(changes, [], 'a card came');
    // The pointer coming back onto the chip waits again, as on any chip.
    card.enter('a');
    time.advance(600);
    assert.equal(card.shown, 'a');
    assert.equal(card.escape(), true, 'a shown card: taken');
  });

  test('HC-33: a card opened by focus stays while the pointer comes and goes; one opened by the pointer stays while focused', () => {
    const { card, time } = controller();
    card.focus('a', true);
    time.advance(600);
    card.enter('a');
    card.leave('a');
    time.advance(500);
    assert.equal(card.shown, 'a', 'the pointer leaving closed a focused chip\'s card');
    card.blur('a');
    time.advance(100);
    assert.equal(card.shown, null, 'focus leaving left it');
  });

  test("HC-34: aria-describedby names the card only while that chip's card is shown", () => {
    assert.equal(chipDescribedBy('a', 'a', 'card-1'), 'card-1');
    assert.equal(chipDescribedBy('a', 'b', 'card-1'), undefined, 'another chip described by it');
    assert.equal(chipDescribedBy(null, 'a', 'card-1'), undefined, 'described with no card');
    assert.equal(chipDescribedBy(undefined, undefined, 'card-1'), undefined);
    // The hook hands the chip exactly that, and the card carries the same id.
    const hook = source('src/components/terminal/TabHoverCard.jsx');
    assert.match(hook, /'aria-describedby': chipDescribedBy\(gone \? null : shownId, tabId, cardId\)/);
    assert.match(hook, /<TabHoverCard key=\{shownId\} tabId=\{shownId\} anchor=\{anchors\.current\.get\(shownId\)\} id=\{cardId\} \/>/);
    assert.match(hook, /\n\s+id=\{id\}\n\s+role="tooltip"\n/);
  });

  test('HC-35: the chip wires Escape to the card first, and the hidden strip leaves Escape to a chip whose card is shown', () => {
    const split = source('src/components/terminal/TerminalSplitContainer.jsx');
    assert.match(split, /if \(e\.key === 'Escape' && hoverCard\.escape\(\)\) \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*return;\s*\}\s*if \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
    assert.match(split, /onPointerDown=\{\(e\) => \{[\s\S]{0,240}hoverCard\.press\(tab\.id\);\s*if \(e\.button !== 0\) return;\s*beginDrag\(tab, e\);/, 'a press of any button puts it away');
    assert.match(split, /useTabHoverCard\(\{ blocked: hoverCardBlocked\(holds\), tabIds: node\.tabIds \}\)/);
    const strip = source('src/components/terminal/stripReveal.js');
    assert.match(strip, /if \(e\.key !== 'Escape' \|\| heldRef\.current\) return;\n\s*if \(document\.activeElement\?\.closest\?\.\('\[data-tab-chip\]'\)\?\.hasAttribute\('aria-describedby'\)\) return;/);
  });

  test('HC-36: forget — a chip element gone while the pointer was on it: focus on its new element, then blur, closes the card after the grace', () => {
    const { card, time, changes } = controller();
    card.enter('b');
    card.forget('b');
    card.focus('b', true);
    time.advance(600);
    assert.equal(card.shown, 'b', 'setup: focus opens it');
    card.blur('b');
    time.advance(99);
    assert.equal(card.shown, 'b', 'gone before the grace ended');
    time.advance(1);
    assert.equal(card.shown, null, 'the pointer on the removed element kept the card up');
    assert.deepEqual(changes, ['b', null]);
    assert.equal(time.live, 0, 'a timer left running');
  });

  test('HC-37: forget — a chip element gone while it had focus (no blur): the pointer on its new element, then leaving, closes the card after the grace', () => {
    const { card, time } = controller();
    card.focus('b', true);
    card.forget('b');
    assert.equal(card.pending, null, 'the wait for the removed element goes on');
    card.enter('b');
    time.advance(600);
    assert.equal(card.shown, 'b', 'setup: the pointer opens it');
    card.leave('b');
    time.advance(100);
    assert.equal(card.shown, null, 'the focus of the removed element kept the card up');
    assert.equal(time.live, 0);
  });

  test('HC-38: forget — a chip element gone after Escape closed its card: the pointer on its new element opens the card after 600 ms', () => {
    const { card, time } = controller();
    card.focus('b', true);
    time.advance(600);
    assert.equal(card.escape(), true, 'setup');
    card.forget('b');
    card.enter('b');
    time.advance(599);
    assert.equal(card.shown, null, 'shown before 600 ms');
    time.advance(1);
    assert.equal(card.shown, 'b', 'the Escape on the removed element still kept the card away');
  });

  test('HC-39: forget hides only its own chip\'s card, shown or about to show; another chip, or no id, keeps everything', () => {
    const { card, time } = controller();
    card.enter('a');
    time.advance(600);
    card.forget('b');
    card.forget(null);
    card.forget(undefined);
    assert.equal(card.shown, 'a', "another chip's forget closed the card");
    card.forget('a');
    assert.equal(card.shown, null, 'the shown card stayed after its chip was forgotten');
    assert.equal(time.live, 0);
    card.enter('c');
    time.advance(300);
    card.forget(null);
    assert.equal(card.pending, 'c', 'forget with no id dropped a wait');
    card.forget('c');
    assert.equal(card.pending, null);
    time.advance(1000);
    assert.equal(card.shown, null, 'a forgotten chip opened its card');
  });
});

// ---- No native tooltip (AC-B12-4) ----------------------------------------------

describe('The tab hover card: the one tooltip (B12-F4, AC-B12-4)', () => {
  test('HC-40: the old hint is gone from the chip; its meaning is the card\'s last line', () => {
    const split = source('src/components/terminal/TerminalSplitContainer.jsx');
    assert.equal(split.includes('drag along the tabs to reorder'), false);
    assert.ok(/reorder/i.test(HOVER_CARD_HINT) && /move/i.test(HOVER_CARD_HINT) && /double-click to rename/i.test(HOVER_CARD_HINT));
    assert.equal(row(tabHoverCardRows(tab(), { now: NOW }), 'hint').text, HOVER_CARD_HINT);
  });

  test('HC-41: the terminal chip has no title attribute, and nothing the card hands it adds one', () => {
    const split = source('src/components/terminal/TerminalSplitContainer.jsx');
    const chip = split.slice(split.indexOf('data-tab-chip={tab.id}'), split.indexOf("'relative group flex items-center px-2 h-[22px]"));
    assert.ok(chip.includes('{...hoverCard.chipProps(tab.id)}'), 'the chip is not wired to its card');
    assert.doesNotMatch(chip, /\btitle=/, 'the chip still has a native title');
    const hook = source('src/components/terminal/TabHoverCard.jsx');
    const props = hook.slice(hook.indexOf('const chipProps = (tabId) => ({'), hook.indexOf('return {\n    shownId'));
    assert.ok(props.length > 0 && !/\btitle\b/.test(props), 'chipProps carries a title');
  });

  test("HC-42: the activity the title used to say is still read out — after the chip's name, hidden from the eye", () => {
    const split = source('src/components/terminal/TerminalSplitContainer.jsx');
    assert.match(split, /const activity = activityLabel\(tab\);/);
    assert.match(split, /\{displayTitle\(tab\)\}\n\s*<\/span>\n\s*\{activity && <span className="sr-only">, \{activity\}<\/span>\}/);
    const card = source('src/components/terminal/TabHoverCard.jsx');
    assert.match(card, /role="tooltip"/);
    assert.match(card, /pointer-events-none/);
  });
});

// ---- Someone else's text (AC-B12-5) --------------------------------------------

const HOSTILE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;

describe('The tab hover card: hostile text (B12-F4, AC-B12-5)', () => {
  test('HC-50: a title with ESC, BEL, a bidi override and zero-width characters is shown without them', () => {
    const title = 'ok\u001b]0;evil\u0007 \u202Egnp.exe\u200B\u200D\uFEFF\u2066x\u2069\u2060y';
    const shown = row(tabHoverCardRows(tab({ title }), { now: NOW }), 'title').text;
    assert.equal(HOSTILE.test(shown), false, JSON.stringify(shown));
    assert.equal(shown, 'ok]0;evil gnp.exexy');
  });

  test('HC-51: so is a folder, before it is shortened', () => {
    const cwd = '/tmp/\u202Eevil\u200B/\u001b[31mred\u0007/\u2067dir\u2069\uFEFF';
    const shown = row(tabHoverCardRows(tab({ cwd }), { now: NOW }), 'folder').text;
    assert.equal(HOSTILE.test(shown), false, JSON.stringify(shown));
    assert.equal(shown, '/tmp/evil/[31mred/dir');
  });

  test('HC-52: a program title and a notification too; every row of a hostile tab is clean', () => {
    const t = claudeTab({ title: 'Terminal 1', programTitle: '\u202Ehijack\u200B\u0007' , cwd: '\u001b/x\u200E' });
    const note = { kind: 'program', title: 'Build\u202E', body: 'done\u200B\u0007\u001b[2J', tabTitle: 'Terminal 1', at: NOW };
    const rows = tabHoverCardRows(t, { note, activity: { state: 'working', since: NOW - 2 * MINUTE }, now: NOW });
    for (const r of rows) assert.equal(HOSTILE.test(r.text), false, `${r.key}: ${JSON.stringify(r.text)}`);
    assert.equal(row(rows, 'title').text, 'hijack');
    assert.equal(row(rows, 'note').text, 'Build \u{2014} done[2J');
  });

  test('HC-53: cleanCardText — whitespace runs one space, emoji kept, nothing for what is not a string', () => {
    assert.equal(cleanCardText('a\t\n  b\r\nc', 50), 'a b c');
    assert.equal(cleanCardText('build \u{1F680}\u{FE0F}', 50), 'build \u{1F680}\u{FE0F}');
    assert.equal(cleanCardText(42, 50), '');
    assert.equal(cleanCardText('\u200B\u202E\u0007', 50), '');
    assert.equal(cleanCardText('x'.repeat(40_000), 10), `${'x'.repeat(9)}\u{2026}`);
  });
});

// ---- Mounted (B12 review: R1, R5, R6) ----------------------------------------

const h = React.createElement;
const TERMINAL_DIR = fileURLToPath(new URL('../../src/components/terminal/', import.meta.url));

/** TabHoverCard.jsx bundled alone; every other module imported from where it is, so the stores are this file's. */
let loadingCard = null;
function loadCard() {
  loadingCard ??= build({
    stdin: {
      contents: "export { TabHoverCard, useTabHoverCard } from './TabHoverCard.jsx';",
      resolveDir: TERMINAL_DIR,
      sourcefile: 'tab-hover-card-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'real-modules',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (/^[^./]/.test(args.path)) return { path: import.meta.resolve(args.path), external: true };
            if (args.path.endsWith('.jsx')) return undefined;
            return { path: pathToFileURL(resolvePath(args.resolveDir, args.path)).href, external: true };
          });
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loadingCard;
}

/** Run `fn` on a page with terminals `tabs` in the real terminal store, put back afterwards. */
async function withTabs(tabs, fn) {
  const before = useTerminalStore.getState();
  try {
    useTerminalStore.setState({ tabs, notifications: [], progress: {}, agentActivity: {}, secretInput: {}, readOnly: {}, controlled: {} });
    await onPage(fn);
  } finally {
    useTerminalStore.setState(before, true);
  }
}

/**
 * A row of chips as a pane draws them, wired to `useTabHoverCard`. Bumping
 * `epoch` replaces every chip element, as the strip moving between the
 * pane's top and its overlay does.
 */
function stripOf(ui, seen) {
  return function Strip({ ids, epoch = 0 }) {
    const hoverCard = ui.useTabHoverCard({ tabIds: ids });
    seen.current = hoverCard;
    return h(
      'div',
      null,
      ids.map((id) => h('div', { key: `${id}:${epoch}`, 'data-tab-chip': id, ...hoverCard.chipProps(id) }, id)),
      hoverCard.card
    );
  };
}

/** The pointer coming onto chip `id` from outside it (React's onPointerEnter). */
async function pointTo(p, id) {
  dispatch(p.window, p.document.querySelector(`[data-tab-chip="${id}"]`), { type: 'pointerover', pointerType: 'mouse', relatedTarget: null });
  await letItRun();
}

const cardOn = (p, id) => p.document.querySelector(`[data-hover-card="${id}"]`) !== null;

describe('The tab hover card, mounted (B12 review)', () => {
  test("HC-60: a shown card goes when its chip element is replaced — the strip moving into Hide Single Tab Strip's overlay — and its chip's description with it", async () => {
    const ui = await loadCard();
    const seen = { current: null };
    const Strip = stripOf(ui, seen);
    await withTabs([tab({ id: 'a' }), tab({ id: 'b', sessionId: 'sess-2' })], async (p) => {
      p.render(h(Strip, { ids: ['a', 'b'] }));
      await pointTo(p, 'b');
      await letItRun(HOVER_CARD_OPEN_MS + 50);
      assert.equal(cardOn(p, 'b'), true, 'setup: the card shows after 600 ms');
      const id = p.document.querySelector('[data-hover-card="b"]').getAttribute('id');
      assert.equal(p.document.querySelector('[data-tab-chip="b"]').getAttribute('aria-describedby'), id);
      // Terminal a closed by the keyboard: the pane's one chip moves into the overlay, a new element.
      p.render(h(Strip, { ids: ['b'], epoch: 1 }));
      await letItRun();
      assert.equal(cardOn(p, 'b'), false, 'the card stayed where the old chip was');
      assert.equal(seen.current.shownId, null);
      assert.equal(p.document.querySelector('[data-tab-chip="b"]').hasAttribute('aria-describedby'), false, 'the new chip is described by no card');
      // And back, while a card waits to open: it never opens over a chip that is gone.
      p.render(h(Strip, { ids: ['a', 'b'], epoch: 1 }));
      await pointTo(p, 'b');
      await letItRun(200);
      p.render(h(Strip, { ids: ['a', 'b'], epoch: 2 }));
      await letItRun(HOVER_CARD_OPEN_MS);
      assert.equal(p.document.querySelector('[data-hover-card]'), null, 'a card opened for a chip element no longer there');
      // A chip of the new strip shows its card as any does.
      await pointTo(p, 'a');
      await letItRun(HOVER_CARD_OPEN_MS + 50);
      assert.equal(cardOn(p, 'a'), true, 'the new chip shows no card');
      p.unmount();
    });
  });

  test('HC-63: a chip element replaced while it had keyboard focus (it hears no blur): the new chip\'s card, opened by the pointer, goes when the pointer leaves', async () => {
    const ui = await loadCard();
    const seen = { current: null };
    const Strip = stripOf(ui, seen);
    await withTabs([tab({ id: 'a' }), tab({ id: 'b', sessionId: 'sess-2' })], async (p) => {
      p.render(h(Strip, { ids: ['a', 'b'] }));
      // Tab onto chip b: focus the keyboard's way (the page has no :focus-visible of its own).
      const old = p.document.querySelector('[data-tab-chip="b"]');
      old.matches = (selector) => selector === ':focus-visible';
      old.focus();
      dispatch(p.window, old, { type: 'focusin', relatedTarget: null });
      await letItRun(HOVER_CARD_OPEN_MS + 50);
      assert.equal(cardOn(p, 'b'), true, 'setup: keyboard focus shows the card after 600 ms');
      // The strip draws new chip elements; the focused one is gone, and no blur comes.
      p.render(h(Strip, { ids: ['a', 'b'], epoch: 1 }));
      await letItRun();
      assert.ok(!p.document.querySelector('[data-hover-card]'), 'the card stayed where the old chip was');
      // The pointer onto the new chip b shows its card; leaving it takes the card after the grace.
      await pointTo(p, 'b');
      await letItRun(HOVER_CARD_OPEN_MS + 50);
      assert.equal(cardOn(p, 'b'), true, 'the new chip shows no card');
      dispatch(p.window, p.document.querySelector('[data-tab-chip="b"]'), { type: 'pointerout', pointerType: 'mouse', relatedTarget: null });
      await letItRun(HOVER_CARD_CLOSE_MS + 100);
      assert.ok(!p.document.querySelector('[data-hover-card]'), 'the focus of the removed chip kept the card up after the pointer left');
      assert.equal(seen.current.shownId, null);
      p.unmount();
    });
  });

  test('HC-64: a tab that leaves the row is forgotten even with no chip element held — a tap pressed it (a finger has no hover) — so when it comes back the pointer shows its card', async () => {
    const ui = await loadCard();
    const seen = { current: null };
    const Strip = stripOf(ui, seen);
    await withTabs([tab({ id: 'a' }), tab({ id: 'b', sessionId: 'sess-2' })], async (p) => {
      p.render(h(Strip, { ids: ['a', 'b'] }));
      seen.current.press('b');
      assert.deepEqual(seen.current.anchored(), [], 'setup: a tap holds no chip element');
      // Terminal b dragged to another pane, and back.
      p.render(h(Strip, { ids: ['a'] }));
      await letItRun();
      p.render(h(Strip, { ids: ['a', 'b'] }));
      await letItRun();
      await pointTo(p, 'b');
      await letItRun(HOVER_CARD_OPEN_MS + 50);
      assert.equal(cardOn(p, 'b'), true, 'the press from before it left still keeps its card away');
      p.unmount();
    });
  });

  test('HC-61: the chip elements of closed tabs and of a replaced strip are let go; the shown chip\'s is kept', async () => {
    const ui = await loadCard();
    const seen = { current: null };
    const Strip = stripOf(ui, seen);
    await withTabs([tab({ id: 'a' }), tab({ id: 'b', sessionId: 'sess-2' }), tab({ id: 'c', sessionId: 'sess-3' })], async (p) => {
      p.render(h(Strip, { ids: ['a', 'b', 'c'] }));
      for (const id of ['a', 'b', 'c']) await pointTo(p, id);
      assert.deepEqual(seen.current.anchored().sort(), ['a', 'b', 'c'], 'setup: each chip pointed at is held');
      await letItRun(HOVER_CARD_OPEN_MS + 50);
      assert.equal(cardOn(p, 'c'), true, 'setup');
      p.render(h(Strip, { ids: ['b', 'c'] }));
      await letItRun();
      assert.deepEqual(seen.current.anchored().sort(), ['b', 'c'], 'a closed tab\'s chip is still held');
      assert.equal(cardOn(p, 'c'), true, 'the shown card went with another tab');
      p.render(h(Strip, { ids: ['b', 'c'], epoch: 1 }));
      await letItRun();
      assert.deepEqual(seen.current.anchored(), [], 'chip elements no longer on the page are still held');
      p.unmount();
    });
  });

  test('HC-62: a card that grows is placed again — above its chip near the window\'s bottom, it never covers the chip', async () => {
    const ui = await loadCard();
    const had = Object.hasOwn(globalThis, 'ResizeObserver');
    const before = globalThis.ResizeObserver;
    const observers = [];
    globalThis.ResizeObserver = class {
      constructor(fn) {
        this.fn = fn;
        this.watched = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(el) {
        this.watched.push(el);
      }
      disconnect() {
        this.disconnected = true;
      }
    };
    try {
      await withTabs([tab()], async (p) => {
        Object.assign(p.window, { innerWidth: 1200, innerHeight: 800 });
        const anchor = { getBoundingClientRect: () => ({ left: 10, right: 90, top: 700, bottom: 722 }) };
        p.render(h(ui.TabHoverCard, { tabId: 't1', anchor, id: 'card' }));
        const card = p.document.querySelector('[data-hover-card="t1"]');
        assert.ok(card !== null, 'setup: the card is drawn');
        assert.equal(card.style.top, '726px', 'small, it fits below the chip');
        assert.equal(observers.length, 1, 'its size is watched');
        assert.equal(observers[0].watched[0] === card, true, 'the card itself is watched');
        // Its usage row arrives: taller, no room below any more.
        Object.assign(card, { offsetWidth: 240, offsetHeight: 120 });
        p.settled(() => observers[0].fn([]));
        // 700 - 4 - 120: above the chip, 4 px clear of its top edge.
        assert.equal(card.style.top, '576px', 'grown, it stayed below the window\'s edge or over its chip');
        p.render(null);
        assert.equal(observers[0].disconnected, true, 'closed: no longer watched');
      });
      // Where there is no ResizeObserver it is placed once, and nothing throws.
      delete globalThis.ResizeObserver;
      await withTabs([tab()], async (p) => {
        const anchor = { getBoundingClientRect: () => ({ left: 10, right: 90, top: 40, bottom: 62 }) };
        p.render(h(ui.TabHoverCard, { tabId: 't1', anchor, id: 'card' }));
        assert.equal(p.document.querySelector('[data-hover-card="t1"]').style.top, '66px');
        p.render(null);
      });
    } finally {
      if (had) globalThis.ResizeObserver = before;
      else delete globalThis.ResizeObserver;
    }
  });
});
