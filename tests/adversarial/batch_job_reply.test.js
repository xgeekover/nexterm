/**
 * cmd's "Terminate batch job (Y/N)?" is answered Y after a Ctrl+C
 * (src/lib/batchJobReply.js) — VS Code's `terminal.integrated.autoReplies`.
 *
 * OpenCode runs in cmd through npm's `opencode.cmd`, so every Ctrl+C out of
 * it ends in that question, and a second Ctrl+C reaching cmd while it asks
 * appears to end cmd itself (src/lib/shellExit.js). These cases hold the
 * pure parts — what arms, what disarms, what a row has to end with — and
 * then the whole path in the store: the Ctrl+C typed through `writeRaw`, the
 * question emitted by the mock bridge as cmd's output, written into real
 * xterm (`@xterm/headless`) by the registry's own `writeOutput`, cut from
 * terminalRegistry.js and run as it is, and the Y typed back through
 * `writeRaw`. In English and in Korean; and never without the Ctrl+C, in a
 * shell other than cmd, twice, after 3 s, after something else was typed,
 * or on the alternate screen.
 */
import { readFileSync } from 'node:fs';
// Static, as in program_notifications.test.js: other files in this runner
// register module hooks that turn `@xterm/*` into test doubles.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  BATCH_JOB_QUESTIONS,
  BATCH_REPLY,
  BATCH_REPLY_LIMIT_MS,
  BATCH_REPLY_WINDOW_MS,
  asksBatchJob,
  asksYesNo,
  createBatchJobReplies,
  cursorRowText,
  isTerminalReport,
  screenRow,
  sendsCtrlC,
  setBatchJobScreenReader,
  typesSomething,
} from '../../src/lib/batchJobReply.js';
import { useTerminalStore as T } from '../../src/stores/terminalStore.js';
import { useSettingsStore, SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import { useSystemStore } from '../../src/stores/systemStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { attachOutput, resetPtyOutputBus, startPtyOutputBus } from '../../src/lib/ptyOutputBus.js';

const { Terminal } = headless;

const ESC = '\x1b';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const ENGLISH = 'Terminate batch job (Y/N)? ';
// "일괄 작업을 끝내시겠습니까 (Y/N)? " — what cmd asks on a Korean Windows.
const KOREAN = '\u{C77C}\u{AD04} \u{C791}\u{C5C5}\u{C744} \u{B05D}\u{B0B4}\u{C2DC}\u{ACA0}\u{C2B5}\u{B2C8}\u{AE4C} (Y/N)? ';
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const written = (term, data) => new Promise((resolve) => term.write(data, resolve));

// ---- the pure parts ---------------------------------------------------------------

describe('cmd batch-job reply: what arms, what disarms, what is asked', () => {
  test('BJ-01: a row asks when it ends with (Y/N)? — and it is cmd\'s question only with cmd\'s ^C or its own words', () => {
    for (const row of [ENGLISH, ENGLISH.trimEnd(), `${ENGLISH}   `, KOREAN, `C:\\work>${ENGLISH}`, '(Y/N)?']) {
      assert.equal(asksYesNo(row), true, JSON.stringify(row));
    }
    for (const row of [`${ENGLISH}Y`, `${ENGLISH}N`, 'Terminate batch job (y/n)? ', 'Overwrite x? (Yes/No/All): ', '', null, '(Y/N)? done']) {
      assert.equal(asksYesNo(row), false, JSON.stringify(row));
    }
    // Review A2: a bare (Y/N)? is any program's question.
    const cmds = [
      { text: `^C${ENGLISH}` },
      { text: ENGLISH },
      { text: KOREAN },
      { text: `C:\\work>^C${KOREAN}` },
      { text: '^CSomething cmd asks (Y/N)? ' },
      { text: 'C:\\work>^CBatch-Auftrag beenden (Y/N)? ', above: '' },
    ];
    for (const row of cmds) assert.equal(asksBatchJob(row), true, JSON.stringify(row));
    const others = [
      { text: 'C:\\work\\*, Are you sure (Y/N)? ' },
      { text: 'Overwrite C:\\work\\a.txt (Y/N)? ', above: 'C:\\work>copy b.txt a.txt' },
      { text: '(Y/N)?' },
      { text: '^C', above: '' },
      // Review 2026-10-11: a ^C elsewhere — on the row above, or mid-row in a
      // program's own log — is not cmd asking.
      { text: 'Batchvorgang abbrechen? (Y/N)? ', above: 'Kompiliere…^C' },
      { text: 'Run cleanup now (Y/N)? ', above: '[server] ^C received' },
      { text: 'Deploy to prod (Y/N)? ', above: '^C' },
      { text: '[server] ^C received. Run cleanup now (Y/N)? ' },
      { text: '^C Discard (Y/N)? ' },
      null,
    ];
    for (const row of others) assert.equal(asksBatchJob(row), false, JSON.stringify(row));
    assert.deepEqual(BATCH_JOB_QUESTIONS, [ENGLISH.trimEnd(), KOREAN.trimEnd()]);
  });

  test('BJ-02: only a lone Ctrl+C arms; anything else typed disarms — a bracketed paste, Alt+Enter and Shift+Enter included; the terminal\'s own reports do not', () => {
    assert.equal(sendsCtrlC('\x03'), true);
    // Review A11: a paste with an ETX in it is a paste.
    for (const data of ['x\x03', '\x03\x03', '\x03\r', 'c', null]) assert.equal(sendsCtrlC(data), false, JSON.stringify(data));
    // Review A4: input that begins with ESC was never typing.
    const typing = [
      'd',
      'del *\r',
      '\r',
      '\x7f',
      'pasted line\r',
      'x\x03',
      `${ESC}[200~del *.*\r${ESC}[201~`,
      `${ESC}\r`,
      `${ESC}[27;2;13~`,
      ESC,
      `${ESC}[3~`,
      `${ESC}OP`,
      `${ESC}[A${ESC}[200~x${ESC}[201~`,
    ];
    for (const data of typing) assert.equal(typesSomething(data), true, JSON.stringify(data));
    const reports = [
      `${ESC}[I`,
      `${ESC}[O`,
      `${ESC}[12;5R`,
      `${ESC}[?12;5R`,
      `${ESC}[?1;2c`,
      `${ESC}[>0;276;0c`,
      `${ESC}[?2004;2$y`,
      `${ESC}P>|xterm.js(6.0.0)${ESC}\\`,
      `${ESC}]11;rgb:1818/1818/1818${ESC}\\`,
      `${ESC}]10;rgb:0/0/0\x07`,
      `${ESC}[<0;12;3M`,
      `${ESC}[A`,
      `${ESC}[1;5C`,
      `${ESC}OB`,
      `${ESC}[H`,
      `${ESC}[5~`,
      `${ESC}[O${ESC}[I`,
    ];
    for (const data of reports) {
      assert.equal(isTerminalReport(data), true, JSON.stringify(data));
      assert.equal(typesSomething(data), false, JSON.stringify(data));
    }
    for (const data of ['\x03', '', null]) assert.equal(typesSomething(data), false, JSON.stringify(data));
    assert.equal(BATCH_REPLY, 'Y\r');
    assert.equal(BATCH_REPLY_WINDOW_MS, 3000);
    assert.equal(BATCH_REPLY_LIMIT_MS, 10000);
    assert.equal(SETTINGS_DEFAULTS.terminalAutoReplyBatchJob, true);
  });

  test('BJ-03: the cursor row is read off the screen — wrapped rows joined, the row above too, never the alternate buffer', async () => {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    await written(term, `^C\r\n${ENGLISH}`);
    // The space cmd prints after the question is a written cell, and kept.
    assert.equal(cursorRowText(term), ENGLISH);
    assert.deepEqual(screenRow(term), { alternate: false, y: 1, text: ENGLISH, above: '^C' });
    await written(term, `\r\n${KOREAN}`);
    assert.equal(asksYesNo(cursorRowText(term)), true, 'two cells a syllable, read as text');

    // A pane so narrow the question wraps — even inside "(Y/N)?" itself.
    const narrow = new Terminal({ cols: 21, rows: 10, allowProposedApi: true });
    await written(narrow, `^C\r\n${ENGLISH}`);
    assert.equal(narrow.buffer.active.getLine(narrow.buffer.active.cursorY).isWrapped, true, 'setup: it wrapped');
    assert.equal(cursorRowText(narrow), ENGLISH);
    assert.equal(screenRow(narrow).above, '^C', 'the row above the question, not above its last piece');

    await written(term, `${ALT_ON}${ENGLISH}`);
    assert.equal(cursorRowText(term), null, 'a full-screen program\'s rows are not cmd\'s');
    assert.deepEqual(screenRow(term), { alternate: true });
    assert.equal(cursorRowText(null), null);
    term.dispose();
    narrow.dispose();
  });

  test('BJ-04: the arming — a cmd tab, the setting on, a new question, once, until something is typed', () => {
    let now = 0;
    const replies = [];
    const tabs = { cmd: true, pwsh: false };
    let enabled = true;
    let shown = screen(['C:\\work>']);
    const r = createBatchJobReplies({
      isCmd: (tabId) => tabs[tabId],
      enabled: () => enabled,
      reply: (tabId, text) => replies.push([tabId, text]),
      now: () => now,
      screen: () => screenRow(shown),
    });
    const asked = screen(['C:\\work>opencode', '^CTerminate batch job (Y/N)? ']);

    assert.equal(r.outputArrived('cmd'), false, 'no Ctrl+C, no wait');
    assert.equal(r.afterOutput('cmd', asked), false);
    assert.equal(r.noteInput('pwsh', '\x03'), false, 'not cmd: never armed');

    assert.equal(r.noteInput('cmd', '\x03'), true);
    assert.equal(r.outputArrived('cmd'), true);
    assert.equal(r.afterOutput('cmd', screen(['C:\\work>^C'])), false, 'not asked yet: still waiting');
    assert.equal(r.afterOutput('cmd', screen(['^CTerminate batch job (Y/N)? '], 'alternate')), false, 'the alternate screen is never read');
    // Review A2: any program's (Y/N)? in the window is not cmd's.
    assert.equal(r.afterOutput('cmd', screen(['Overwrite C:\\work\\a.txt (Y/N)? '])), false);
    assert.equal(r.isArmed('cmd'), true, '…and the wait goes on');
    assert.equal(r.afterOutput('cmd', asked), true);
    assert.deepEqual(replies, [['cmd', 'Y\r']]);
    assert.equal(r.afterOutput('cmd', asked), false, 'once per Ctrl+C');

    // Review A11: a paste with a Ctrl+C in it arms nothing, and ends a wait.
    r.noteInput('cmd', '\x03');
    assert.equal(r.noteInput('cmd', 'x\x03'), false);
    // Review A4: nor does a bracketed paste leave the wait open.
    r.noteInput('cmd', '\x03');
    r.noteInput('cmd', `${ESC}[O`);
    assert.equal(r.isArmed('cmd'), true, 'a focus report is not typing');
    r.noteInput('cmd', `${ESC}[200~del *.*\r${ESC}[201~`);
    assert.equal(r.afterOutput('cmd', asked), false, 'typed after the Ctrl+C: its question is the user\'s');

    r.noteInput('cmd', '\x03');
    enabled = false;
    assert.equal(r.afterOutput('cmd', asked), false, 'turned off meanwhile');
    assert.equal(r.isArmed('cmd'), false);
    assert.equal(r.noteInput('cmd', '\x03'), false, 'off: never armed');
    enabled = true;

    r.noteInput('cmd', '\x03');
    r.forget('cmd');
    assert.equal(r.isArmed('cmd'), false, 'a closed tab is forgotten');
    assert.deepEqual(replies, [['cmd', 'Y\r']]);
  });

  test('BJ-04b: a question already on screen when Ctrl+C is pressed is not the one answered — a new one is', () => {
    // Review A1: `del`'s "Are you sure (Y/N)?" up, Ctrl+C to get away from
    // it, and any chunk that left the cursor there answered Y.
    const replies = [];
    let shown = screen(['C:\\work>run.cmd', '^CTerminate batch job (Y/N)? ']);
    const r = createBatchJobReplies({
      isCmd: () => true,
      reply: (tabId, text) => replies.push(text),
      now: () => 0,
      screen: () => screenRow(shown),
    });
    r.noteInput('cmd', '\x03');
    r.outputArrived('cmd');
    assert.equal(r.afterOutput('cmd', shown), false, 'the same row, unchanged');
    shown = screen(['C:\\work>run.cmd', '^CTerminate batch job (Y/N)? ', '', '^CTerminate batch job (Y/N)? ']);
    assert.equal(r.afterOutput('cmd', shown), true, 'a new question, on a new row');
    assert.deepEqual(replies, ['Y\r']);
  });

  test('BJ-04c: the window — judged as output arrives, kept open while it flows (to a limit), started again on leaving a full-screen program', () => {
    // Review A6: the question could be missed.
    let now = 0;
    let replies = 0;
    let shown = screen(['C:\\work>']);
    const make = () =>
      createBatchJobReplies({
        isCmd: () => true,
        reply: () => {
          replies += 1;
        },
        now: () => now,
        screen: () => screenRow(shown),
      });
    const asked = screen(['C:\\work>', '^CTerminate batch job (Y/N)? ']);

    // Arrived within the window, written long after it — xterm busy with a
    // flood of output: still answered.
    let r = make();
    r.noteInput('cmd', '\x03');
    now = 2900;
    assert.equal(r.outputArrived('cmd'), true);
    now = 9000;
    assert.equal(r.afterOutput('cmd', asked), true, 'judged when it arrived, not when it was written');

    // Output flowing keeps it open, up to the limit.
    now = 0;
    r = make();
    r.noteInput('cmd', '\x03');
    for (const at of [2000, 4000, 6000, 8000, 9500]) {
      now = at;
      assert.equal(r.outputArrived('cmd'), true, `at ${at} ms`);
    }
    now = 10500;
    assert.equal(r.outputArrived('cmd'), false, 'never past the limit');
    now = 0;
    r = make();
    r.noteInput('cmd', '\x03');
    now = 3001;
    assert.equal(r.outputArrived('cmd'), false, 'and closed after 3 s of nothing');

    // Pressed while a full-screen program is up: open until it leaves, then 3 s more.
    now = 0;
    shown = screen([''], 'alternate');
    r = make();
    r.noteInput('cmd', '\x03');
    now = 6000;
    assert.equal(r.outputArrived('cmd'), true, 'OpenCode winding down');
    assert.equal(r.afterOutput('cmd', screen([''], 'alternate')), false);
    now = 9000;
    assert.equal(r.outputArrived('cmd'), true);
    assert.equal(r.afterOutput('cmd', screen(['C:\\work>'])), false, 'left it; not asked yet');
    now = 11500;
    assert.equal(r.outputArrived('cmd'), true, 'started again when it left');
    assert.equal(r.afterOutput('cmd', asked), true);
    assert.equal(replies, 2);
  });

  test('BJ-04d: where the alternate screen cannot be seen (Windows 10), a silent wind-down is waited out to the limit', () => {
    // V36: Windows 10's ConPTY never passed the switch to the alternate
    // screen on, so the buffer read normal throughout. A program going quiet
    // for 4 s on Ctrl+C before it left, cmd's question at +4.2 s: the 3 s
    // window had closed, and the question stayed unanswered.
    let now = 0;
    let replies = 0;
    const shown = screen(['FAKE-TUI']);
    const asked = screen(['SLOWQUIT-DONE', '일괄 작업을 끝내시겠습니까 (Y/N)? ']);
    const make = (unseen) =>
      createBatchJobReplies({
        isCmd: () => true,
        reply: () => {
          replies += 1;
        },
        now: () => now,
        screen: () => screenRow(shown),
        alternateUnseen: () => unseen,
      });

    // As measured: "quitting slowly…" at +8 ms, then nothing until +4.2 s.
    let r = make(true);
    r.noteInput('cmd', '\x03');
    now = 8;
    assert.equal(r.outputArrived('cmd'), true);
    assert.equal(r.afterOutput('cmd', screen(['quitting slowly...'])), false, 'not a question');
    now = 4200;
    assert.equal(r.outputArrived('cmd'), true, 'still waiting');
    assert.equal(r.afterOutput('cmd', asked), true, 'answered');
    assert.equal(replies, 1);

    // The limit still holds, and seen alternate screens behave as before.
    now = 0;
    r = make(true);
    r.noteInput('cmd', '\x03');
    now = 10500;
    assert.equal(r.outputArrived('cmd'), false, 'never past the limit');
    now = 0;
    r = make(false);
    r.noteInput('cmd', '\x03');
    now = 8;
    r.outputArrived('cmd');
    r.afterOutput('cmd', screen(['quitting slowly...']));
    now = 4200;
    assert.equal(r.outputArrived('cmd'), false, 'where it can be seen, 3 s of nothing still closes the window');
    assert.equal(replies, 1);
  });
});

/** A screen of `rows`, the cursor on the last; `type` 'alternate' for a full-screen program's. */
function screen(rows, type = 'normal') {
  return {
    buffer: {
      active: { type },
      normal: {
        baseY: 0,
        cursorY: rows.length - 1,
        getLine: (y) => (y >= 0 && y < rows.length ? { translateToString: () => rows[y], isWrapped: false } : undefined),
      },
    },
  };
}

// ---- the whole path, in the store ---------------------------------------------------

/** The registry's own `writeOutput`, cut from terminalRegistry.js and run with the store it reads. */
function registryWriteOutput() {
  const src = read('../../src/components/terminal/terminalRegistry.js');
  const start = src.indexOf('function writeOutput(entry, data, read = null) {');
  const length = src.slice(start).search(/\r?\n\}\r?\n/);
  assert.ok(start > 0 && length > 0, 'terminalRegistry.js writes output through writeOutput');
  // `writeObserver` is performance mode's hook (src/lib/perf/), off as in
  // every session that is not being measured.
  return new Function('useTerminalStore', 'writeObserver', `${src.slice(start, start + length)}\n}\nreturn writeOutput;`)(T, null);
}

/**
 * A terminal of the store's, its shell `shell`, on a Windows of `os`: real
 * xterm, attached to the output bus through the registry's `writeOutput`, and
 * every write to its shell recorded rather than run by the mock.
 */
// A Windows 11 build unless a case says otherwise: where the alternate
// screen is seen, the window is the 3 s the cases below were written for.
async function terminal({ shell = CMD, os = 'windows', osBuild = 22621 } = {}) {
  const system = useSystemStore.getState();
  const before = { os: system.os, osBuild: system.osBuild, defaultShell: system.defaultShell };
  useSystemStore.setState({ os, osBuild, defaultShell: CMD });
  await T.getState().init();
  // The bus as the app runs it: one listener on the bridge. Another suite may
  // have left it listening to a stand-in.
  await resetPtyOutputBus();
  await startPtyOutputBus();
  const tab = await T.getState().createTab();
  assert.ok(tab, 'setup: a terminal');
  T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, shell } : t)) }));
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const entry = { tabId: tab.id, term, disposed: false };
  const writeOutput = registryWriteOutput();
  const detach = attachOutput(tab.sessionId, (data) => writeOutput(entry, data));
  // The registry's reader, for this one terminal.
  const offReader = setBatchJobScreenReader((tabId) => (tabId === tab.id ? screenRow(term) : null));

  const typed = [];
  const original = mockBridge.invoke;
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write' && args?.session_id === tab.sessionId) {
      typed.push(args.data);
      return Promise.resolve(null);
    }
    return original.call(this, command, args, ...rest);
  };
  return {
    tab,
    term,
    typed,
    type: (data) => T.getState().writeRaw(tab.id, data),
    /** cmd printing `chunks`, each as its own `pty-output`, then xterm and the store done with them. */
    prints: async (...chunks) => {
      for (const data of chunks) await mockBridge.emit('pty-output', { session_id: tab.sessionId, data });
      await written(term, '');
      await settle();
    },
    async close() {
      mockBridge.invoke = original;
      offReader();
      detach();
      term.dispose();
      await T.getState().closeTab(tab.id);
      useSystemStore.setState(before);
    },
  };
}

describe('cmd batch-job reply: through the store, the bus and real xterm', () => {
  test('BJ-05: Ctrl+C, then cmd asks — in English, the question split across chunks as ConPTY sends it — Y is typed once', async () => {
    const t = await terminal();
    try {
      await t.type('\x03');
      await t.prints(`${ESC}[?25l^C\r\nTerminate batch`, ` job (Y/N)? ${ESC}[?25h`);
      assert.deepEqual(t.typed, ['\x03', 'Y\r']);
      // cmd echoes the answer and goes on; asked again, it is not answered again.
      await t.prints('Y\r\n\r\nC:\\work>', `\r\n${ENGLISH}`);
      assert.deepEqual(t.typed, ['\x03', 'Y\r'], 'once per Ctrl+C');
    } finally {
      await t.close();
    }
  });

  test('BJ-06: in Korean too', async () => {
    const t = await terminal();
    try {
      await t.type('\x03');
      await t.prints(`^C\r\n${KOREAN}`);
      assert.deepEqual(t.typed, ['\x03', 'Y\r']);
    } finally {
      await t.close();
    }
  });

  test('BJ-07: no Ctrl+C, no answer — the question a batch file asks of its own is the user\'s', async () => {
    const t = await terminal();
    try {
      await t.prints(`C:\\work>build.cmd\r\n${ENGLISH}`);
      assert.deepEqual(t.typed, []);
    } finally {
      await t.close();
    }
  });

  test('BJ-08: never in a shell other than cmd, nor off Windows', async () => {
    for (const setup of [{ shell: PWSH }, { shell: CMD, os: 'macos' }, { shell: '/bin/zsh', os: 'linux' }]) {
      const t = await terminal(setup);
      try {
        await t.type('\x03');
        await t.prints(`^C\r\n${ENGLISH}`);
        assert.deepEqual(t.typed, ['\x03'], JSON.stringify(setup));
      } finally {
        await t.close();
      }
    }
  });

  test('BJ-09: not after 3 s', async () => {
    const t = await terminal();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await t.type('\x03');
      now += BATCH_REPLY_WINDOW_MS + 1;
      await t.prints(`^C\r\n${ENGLISH}`);
      assert.deepEqual(t.typed, ['\x03']);
    } finally {
      Date.now = realNow;
      await t.close();
    }
  });

  test('BJ-10: never on the alternate screen — answered once the program has left it and cmd asks on its own', async () => {
    const t = await terminal();
    try {
      await t.type('\x03');
      await t.prints(`${ALT_ON}${ENGLISH}`);
      assert.deepEqual(t.typed, ['\x03'], 'a full-screen program\'s screen is not read');
      await t.prints(`${ALT_OFF}^C\r\n${ENGLISH}`);
      assert.deepEqual(t.typed, ['\x03', 'Y\r']);
    } finally {
      await t.close();
    }
  });

  test('BJ-11: anything typed after the Ctrl+C ends the wait — a quick `del` must never be answered', async () => {
    const t = await terminal();
    try {
      await t.type('\x03');
      await t.type('del *.*\r');
      await t.prints('C:\\work\\*.*, Are you sure (Y/N)? ');
      assert.deepEqual(t.typed, ['\x03', 'del *.*\r']);
    } finally {
      await t.close();
    }
  });

  test('BJ-12: with the setting off, nothing is answered', async () => {
    const t = await terminal();
    useSettingsStore.setState({ terminalAutoReplyBatchJob: false });
    try {
      await t.type('\x03');
      await t.prints(`^C\r\n${ENGLISH}`);
      assert.deepEqual(t.typed, ['\x03']);
    } finally {
      useSettingsStore.setState({ terminalAutoReplyBatchJob: SETTINGS_DEFAULTS.terminalAutoReplyBatchJob });
      await t.close();
    }
  });

  test('BJ-13: wired — every key goes through `writeRaw`, every chunk through `writeOutput`', () => {
    const view = read('../../src/components/terminal/TerminalView.jsx');
    assert.match(view, /onData: \(data\) => writeRaw\(tabId, data\),/, 'the keyboard types through the store');
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    // Every chunk, kept or live: kept ones are only marked as history around
    // the same write (TP-43).
    assert.match(registry, /attachOutput\(sessionId, \(data, kept, at, read\) => \{\s*if \(!kept\) \{\s*deliverLive\(entry, data, read\);[\s\S]*?writeOutput\(entry, data, read\);/);
    // Live chunks go through the pacer, which writes through `writeOutput`
    // and never paces a terminal whose cmd waits (output_pacing.test.js, OP-08).
    assert.match(registry, /const pacer = createOutputPacer\(\{\s*write: \(entry, data, read\) => writeOutput\(entry, data, read\),/);
    assert.match(registry, /!store\.batchJobWaiting\?\.\(entry\.tabId\)/);
    assert.match(registry, /const waiting = useTerminalStore\.getState\(\)\.batchJobOutputArrived\?\.\(tabId\);/, 'judged as each chunk arrives');
    assert.match(registry, /setBatchJobScreenReader\(\(tabId\) => \{\s*const entry = instances\.get\(tabId\);\s*return entry && !entry\.disposed \? screenRow\(entry\.term\) : null;/);
    const store = read('../../src/stores/terminalStore.js');
    const writeRaw = store.slice(store.indexOf('writeRaw: async (tabId, data) => {'));
    assert.match(writeRaw, /followTyping\(tab, data\);\s*batchJobReplies\.noteInput\(targetId, data\);/);
  });
});

describe('cmd batch-job reply: after review, through the store', () => {
  test('BJ-14: another program\'s (Y/N)? within the window gets no Y — only cmd\'s question does', async () => {
    const t = await terminal();
    try {
      await t.type('\x03');
      // No ^C on its row or the row above, and not cmd's words.
      await t.prints('^C\r\nCopying a.txt\r\n', 'Overwrite C:\\work\\a.txt (Y/N)? ');
      assert.deepEqual(t.typed, ['\x03']);
    } finally {
      await t.close();
    }
  });

  test('BJ-15: a question already up when Ctrl+C is pressed is left alone', async () => {
    const t = await terminal();
    useSettingsStore.setState({ terminalAutoReplyBatchJob: false });
    try {
      await t.type('\x03');
      await t.prints(`^C\r\n^C${ENGLISH}`);
      useSettingsStore.setState({ terminalAutoReplyBatchJob: true });
      // Ctrl+C again at the question; a chunk that only shows the cursor.
      await t.type('\x03');
      await t.prints(`${ESC}[?25h`);
      assert.deepEqual(t.typed, ['\x03', '\x03'], 'never turned into Y');
    } finally {
      useSettingsStore.setState({ terminalAutoReplyBatchJob: SETTINGS_DEFAULTS.terminalAutoReplyBatchJob });
      await t.close();
    }
  });

  test('BJ-16: a bracketed paste, Alt+Enter or Shift+Enter after the Ctrl+C ends the wait; a focus report does not', async () => {
    for (const typed of [`${ESC}[200~del *.*\r${ESC}[201~`, `${ESC}\r`, `${ESC}[27;2;13~`, 'x\x03']) {
      const t = await terminal();
      try {
        await t.type('\x03');
        await t.type(typed);
        await t.prints(`^C\r\n${ENGLISH}`);
        assert.deepEqual(t.typed, ['\x03', typed], JSON.stringify(typed));
      } finally {
        await t.close();
      }
    }
    const t = await terminal();
    try {
      await t.type('\x03');
      await t.type(`${ESC}[O`);
      await t.prints(`^C\r\n${ENGLISH}`);
      assert.deepEqual(t.typed, ['\x03', `${ESC}[O`, 'Y\r']);
    } finally {
      await t.close();
    }
  });

  test('BJ-17: Ctrl+C in OpenCode, which takes 6 s to go — cmd\'s question after it is still answered', async () => {
    const t = await terminal();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await t.prints(`${ALT_ON}OpenCode`);
      await t.type('\x03');
      now += 6000;
      await t.prints(`${ALT_OFF}^C${ENGLISH}`);
      assert.deepEqual(t.typed, ['\x03', 'Y\r']);
    } finally {
      Date.now = realNow;
      await t.close();
    }
  });

  test('BJ-18: Windows 10 — no alternate screen ever reaches xterm, and a program quiet for 4 s still has cmd\'s question answered', async () => {
    // V36, as measured on 19045: the full-screen program's switch never
    // arrived (ConPTY repaints instead), "quitting slowly" at +8 ms, then
    // nothing until cmd asked at +4.2 s — after the 3 s window.
    const t = await terminal({ osBuild: 19045 });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await t.prints('FAKE-TUI on the alternate screen - press Ctrl+C');
      await t.type('\x03');
      now += 8;
      await t.prints('\r\nquitting slowly...');
      now += 4200;
      await t.prints(`\r\nSLOWQUIT-DONE\r\n${KOREAN}`);
      assert.deepEqual(t.typed, ['\x03', 'Y\r']);
    } finally {
      Date.now = realNow;
      await t.close();
    }
  });
});
