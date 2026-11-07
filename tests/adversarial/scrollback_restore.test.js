/**
 * A restored terminal's saved output, written before its new shell's
 * (stage 6, spec D7; src/lib/scrollbackRestore.js and the registry's
 * `bindSession`).
 *
 * The registry cannot be imported in Node (xterm brings a stylesheet and a
 * canvas), so its `bindSession` is cut from the source and run — as TP-43
 * runs it — with the real output bus, a real headless xterm, and the real
 * restore. What is held:
 *
 *   - the restored text and its separator come first, then everything the
 *     shell printed while the file was read (kept by the bus), then live
 *     output — never one inside the other
 *   - a restore that fails in any way — no file, a foreign file, a read
 *     that never answers, a terminal that throws — still attaches the
 *     shell's output, and restores nothing
 *   - it waits for the first fit, and not forever
 *   - on Windows the restored lines go into the scrollback and the prompt
 *     starts on an empty screen, the separator just above it
 *   - what the restore writes is not a change to save; the shell's output after it is
 *   - an exit notice comes after the restored text and the shell's output
 *   - a tab is restored once: taken on creation, never on reuse
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  attachOutput,
  createHistoryMark,
  deliver,
  forgetOutput,
  resetPtyOutputBus,
} from '../../src/lib/ptyOutputBus.js';
import { exitNotice, freshScreen } from '../../src/lib/shellExit.js';
import { SNAPSHOT_MAGIC } from '../../src/lib/scrollbackSnapshot.js';
import { RESTORE_READ_WAIT_MS, restoreScrollback } from '../../src/lib/scrollbackRestore.js';
import { watchScrollbackChanges } from '../../src/lib/scrollbackWatch.js';
import {
  markForRestore,
  restorePending,
  takeRestore,
  resetScrollbackSession,
  scrollbackBackend,
  scrollbackSaver,
} from '../../src/lib/scrollbackSession.js';
import { createScrollbackSaver } from '../../src/lib/scrollbackSaver.js';

const { Terminal } = headless;

const registrySource = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n'
);

/** The registry's own `bindSession`, run with what it is handed here. */
function compileBindSession({ listen }) {
  const start = registrySource.indexOf('function bindSession(entry, sessionId) {');
  const end = registrySource.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start, 'bindSession not found in terminalRegistry.js');
  const make = new Function(
    'startPtyOutputBus',
    'attachOutput',
    'writeOutput',
    'listen',
    'forgetOutput',
    'freshScreen',
    'exitNotice',
    'deliverLive',
    'flushPaced',
    `${registrySource.slice(start, end)}\nreturn bindSession;`
  );
  return make(
    () => {},
    attachOutput,
    // What the registry's writeOutput does with a chunk, short of flow control.
    (entry, data, read) => {
      entry.term.write(data);
      read?.();
    },
    listen,
    forgetOutput,
    freshScreen,
    exitNotice,
    (entry, data, read) => {
      entry.term.write(data);
      read?.();
    },
    () => {}
  );
}

/** A stand-in for Tauri's `listen`: handlers kept, `emit` plays the backend. */
function fakeListen() {
  const handlers = [];
  return {
    listen: (event, handler) => {
      handlers.push({ event, handler });
      return Promise.resolve(() => {});
    },
    emit: (event, payload) => {
      for (const h of handlers) if (h.event === event) h.handler(payload);
    },
  };
}

const SAVED_AT = Date.UTC(2026, 10, 6, 9, 42);

/** A file as the app writes it, for `tabId`. */
function fileFor(tabId, lines, { savedAt = SAVED_AT } = {}) {
  return `${SNAPSHOT_MAGIC}\n${JSON.stringify({ tabId, savedAt, cols: 60, lines: lines.length, hidden: 0 })}\n${lines.join('\r\n')}`;
}

/**
 * Every row of the normal buffer, wrapped rows joined, trailing blanks
 * dropped — spaces written at a row's end too (`translateToString(true)`
 * keeps those: a prompt's `$ ` ends in one).
 */
function rows(term) {
  const buf = term.buffer.normal;
  const out = [];
  for (let y = 0; y < buf.length; y += 1) {
    const line = buf.getLine(y);
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  for (let i = 0; i < out.length; i += 1) out[i] = out[i].trimEnd();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Until xterm has parsed everything written so far. */
const parsed = (term) => new Promise((resolve) => term.write('', resolve));
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A terminal as `getOrCreateTerminal` makes one, as far as `bindSession` and
 * the restore use it: an xterm, its history mark, and the quiet flag the
 * registry's change tracking reads — with each parsed batch recorded as a
 * change unless it was quiet then.
 */
function makeEntry({ cols = 60, rows: height = 8 } = {}) {
  const term = new Terminal({ cols, rows: height, scrollback: 1000, allowProposedApi: true });
  const entry = { tabId: 'tab-term-1', term, history: createHistoryMark(), sessionId: null, restoring: null, scrollbackQuiet: false };
  entry.changes = 0;
  term.onWriteParsed(() => {
    if (!entry.scrollbackQuiet && term.buffer.active.type === 'normal') entry.changes += 1;
  });
  return entry;
}

/** The registry's `restoreSavedOutput`, with the read and the fit handed in. */
function startRestore(entry, { read, waitForFit, pushIntoScrollback = false, ...rest }) {
  const done = () => {
    entry.restoring = null;
  };
  entry.restoring = restoreScrollback({
    term: entry.term,
    tabId: entry.tabId,
    read,
    waitForFit,
    history: entry.history,
    quiet: (on) => {
      entry.scrollbackQuiet = on;
    },
    pushIntoScrollback,
    locale: 'en-GB',
    warn: () => {},
    ...rest,
  }).then(done, done);
  return entry.restoring;
}

describe('Scrollback restore: before the shell, whatever happens', () => {
  test('RS-01: the restored text and its separator first, then what the shell printed meanwhile, then live output', async () => {
    await resetPtyOutputBus();
    const bindSession = compileBindSession(fakeListen());
    const entry = makeEntry();
    let answer;
    const read = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    deliver('rs-01', 'prompt-before-restore$ ');
    startRestore(entry, { read, waitForFit: () => Promise.resolve() });
    bindSession(entry, 'rs-01');
    deliver('rs-01', 'typed-during-read\r\n');
    await tick(5);
    await parsed(entry.term);
    assert.deepEqual(rows(entry.term), [], 'the shell was written before its terminal knew what it had last time');
    answer(fileFor('tab-term-1', ['\x1b[32mgreen line\x1b[0m', 'second saved line']));
    await entry.restoring;
    deliver('rs-01', 'live\r\n');
    await parsed(entry.term);
    const got = rows(entry.term);
    assert.equal(got[0], 'green line');
    assert.equal(got[1], 'second saved line');
    assert.match(got[2], /^── Previous output · .+ ──$/, `no separator: ${got[2]}`);
    assert.deepEqual(got.slice(3), ['prompt-before-restore$ typed-during-read', 'live'], got.join('\n'));
    assert.equal(entry.term.buffer.normal.getLine(0).getCell(0).getFgColor(), 2, 'its colours lost');
    forgetOutput('rs-01');
  });

  test('RS-02: no file, a foreign file, a read that rejects — nothing restored, and the output still attached', async () => {
    for (const [what, read] of [
      ['no file', () => Promise.resolve(null)],
      ['another tab\'s file', () => Promise.resolve(fileFor('tab-term-2', ['not yours']))],
      ['not a file of ours', () => Promise.resolve('#!/bin/sh\nrm -rf ~\n')],
      ['a read that rejects', () => Promise.reject(new Error('disk gone'))],
      ['a read that throws', () => {
        throw new Error('no backend');
      }],
    ]) {
      await resetPtyOutputBus();
      const bindSession = compileBindSession(fakeListen());
      const entry = makeEntry();
      deliver('rs-02', 'kept\r\n');
      startRestore(entry, { read, waitForFit: () => Promise.resolve() });
      bindSession(entry, 'rs-02');
      await entry.restoring;
      deliver('rs-02', 'live\r\n');
      await parsed(entry.term);
      assert.deepEqual(rows(entry.term), ['kept', 'live'], `${what}: ${rows(entry.term).join(' | ')}`);
      assert.equal(entry.scrollbackQuiet, false, `${what}: change tracking left off`);
      forgetOutput('rs-02');
    }
  });

  test('RS-03: a terminal that throws on the restore still gets its shell\'s output', async () => {
    await resetPtyOutputBus();
    const bindSession = compileBindSession(fakeListen());
    const entry = makeEntry();
    const realWrite = entry.term.write.bind(entry.term);
    let refused = false;
    entry.term.write = (data, cb) => {
      if (!refused && typeof data === 'string' && data.includes('saved')) {
        refused = true;
        throw new Error('write discarded');
      }
      return realWrite(data, cb);
    };
    deliver('rs-03', 'kept\r\n');
    startRestore(entry, { read: () => Promise.resolve(fileFor('tab-term-1', ['saved'])), waitForFit: () => Promise.resolve() });
    bindSession(entry, 'rs-03');
    await entry.restoring;
    await parsed(entry.term);
    assert.ok(refused, 'the restore was not written at all');
    assert.deepEqual(rows(entry.term), ['kept']);
    assert.equal(entry.scrollbackQuiet, false);
    forgetOutput('rs-03');
  });

  test('RS-04: a read that never answers holds the output back for a bounded time only', async () => {
    await resetPtyOutputBus();
    const bindSession = compileBindSession(fakeListen());
    const entry = makeEntry();
    deliver('rs-04', 'kept\r\n');
    const started = Date.now();
    startRestore(entry, { read: () => new Promise(() => {}), waitForFit: () => Promise.resolve(), readWaitMs: 60 });
    bindSession(entry, 'rs-04');
    await entry.restoring;
    assert.ok(Date.now() - started >= 55, 'gave up on the read before its time');
    await parsed(entry.term);
    assert.deepEqual(rows(entry.term), ['kept']);
    forgetOutput('rs-04');
  });

  test('RS-05: it waits for the first fit — and writes anyway when none comes', async () => {
    const entry = makeEntry();
    let fitted;
    const written = [];
    const write = entry.term.write.bind(entry.term);
    entry.term.write = (data, cb) => {
      written.push(data);
      return write(data, cb);
    };
    const restoring = startRestore(entry, {
      read: () => Promise.resolve(fileFor('tab-term-1', ['after the fit'])),
      waitForFit: () =>
        new Promise((resolve) => {
          fitted = resolve;
        }),
    });
    await tick(10);
    assert.deepEqual(written, [], 'written before the pane gave the terminal its size');
    entry.term.resize(40, 6);
    fitted();
    await restoring;
    assert.equal(rows(entry.term)[0], 'after the fit');

    const unfitted = makeEntry();
    const started = Date.now();
    await startRestore(unfitted, {
      read: () => Promise.resolve(fileFor('tab-term-1', ['no fit came'])),
      waitForFit: () => new Promise(() => {}),
      fitWaitMs: 50,
    });
    assert.ok(Date.now() - started >= 45, 'did not wait for the fit at all');
    assert.equal(rows(unfitted.term)[0], 'no fit came', 'a fit that never came lost the restore');
  });

  test('RS-06: Windows — the restored lines and the separator in the scrollback, the prompt on an empty screen just below', async () => {
    await resetPtyOutputBus();
    const bindSession = compileBindSession(fakeListen());
    const entry = makeEntry({ cols: 60, rows: 5 });
    deliver('rs-06', 'C:\\Users\\dev>');
    startRestore(entry, {
      read: () => Promise.resolve(fileFor('tab-term-1', ['one', 'two', 'three'])),
      waitForFit: () => Promise.resolve(),
      pushIntoScrollback: true,
    });
    bindSession(entry, 'rs-06');
    await entry.restoring;
    await parsed(entry.term);
    const buf = entry.term.buffer.normal;
    const at = (y) => buf.getLine(y).translateToString(true);
    assert.equal(at(buf.baseY), 'C:\\Users\\dev>', 'the prompt is not at the top of the screen ConPTY thinks is empty');
    assert.match(at(buf.baseY - 1), /^── Previous output · /, 'the separator is not the line just above the screen');
    assert.deepEqual([at(buf.baseY - 4), at(buf.baseY - 3), at(buf.baseY - 2)], ['one', 'two', 'three']);
    for (let y = buf.baseY + 1; y < buf.baseY + entry.term.rows; y += 1) assert.equal(at(y), '', `row ${y} of the screen is not empty`);
    forgetOutput('rs-06');
  });

  test('RS-07: what the restore writes is not a change to save; the shell\'s output after it is', async () => {
    await resetPtyOutputBus();
    const bindSession = compileBindSession(fakeListen());
    const entry = makeEntry();
    startRestore(entry, {
      read: () => Promise.resolve(fileFor('tab-term-1', Array.from({ length: 200 }, (_, i) => `saved ${i}`))),
      waitForFit: () => Promise.resolve(),
    });
    bindSession(entry, 'rs-07');
    await entry.restoring;
    // Counted before anything else is written: an empty write of the test's
    // own (`parsed`) is a parsed batch too.
    await tick(5);
    assert.equal(entry.changes, 0, 'the restored text was counted as a change, and would be saved straight back');
    assert.ok(rows(entry.term).length > 200, 'nothing was restored, so nothing was tested');
    deliver('rs-07', 'new output\r\n');
    await parsed(entry.term);
    await tick(5);
    assert.ok(entry.changes > 0, 'the shell\'s first output after a restore is not a change');
    forgetOutput('rs-07');
  });

  test('RS-08: a shell that exits while the file is read: its notice after the restored text and its output', async () => {
    await resetPtyOutputBus();
    const backend = fakeListen();
    const bindSession = compileBindSession(backend);
    const entry = makeEntry();
    let answer;
    startRestore(entry, {
      read: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      waitForFit: () => Promise.resolve(),
    });
    bindSession(entry, 'rs-08');
    deliver('rs-08', 'zsh: bad rc\r\n');
    backend.emit('pty-exit', { session_id: 'rs-08', exit_code: 1 });
    await tick(5);
    answer(fileFor('tab-term-1', ['saved']));
    await entry.restoring;
    await tick(0);
    await parsed(entry.term);
    const got = rows(entry.term);
    assert.equal(got[0], 'saved', got.join(' | '));
    const bad = got.indexOf('zsh: bad rc');
    const notice = got.findIndex((r) => r.startsWith('[process exited'));
    assert.ok(bad > 1 && notice > bad, `out of order: ${got.join(' | ')}`);
    forgetOutput('rs-08');
  });

  test('RS-09: written as history, filed under when it was saved', async () => {
    const entry = makeEntry();
    const seen = [];
    const before = entry.history.before.bind(entry.history);
    entry.history.before = (at) => {
      seen.push(at);
      before(at);
    };
    const reading = [];
    entry.term.onWriteParsed(() => reading.push(entry.history.reading));
    await startRestore(entry, { read: () => Promise.resolve(fileFor('tab-term-1', ['saved'])), waitForFit: () => Promise.resolve() });
    await parsed(entry.term);
    assert.deepEqual(seen, [SAVED_AT]);
    assert.equal(entry.history.reading, false, 'history left up: every later bell would be taken for an old one');
  });
});

describe('Scrollback restore: once, and only what the start brought back', () => {
  test('RS-10: a tab marked by the start is restored once, then never again; a bad id never', () => {
    resetScrollbackSession();
    markForRestore(['tab-term-3', '../../etc/hosts', 'tab-term-0', 7]);
    assert.equal(restorePending('../../etc/hosts'), false);
    assert.equal(restorePending('tab-term-0'), false);
    assert.equal(takeRestore('tab-term-3'), true);
    assert.equal(takeRestore('tab-term-3'), false, 'restored twice — a remount or a pane move wrote it again');
    resetScrollbackSession();
  });

  test('RS-11: wired — taken only when the xterm is made, never when it is reused; the output waits for it', () => {
    const create = registrySource.slice(registrySource.indexOf('export function getOrCreateTerminal('));
    const reuseEnd = create.indexOf('return entry;\n  }');
    const take = create.indexOf('if (takeRestore(tabId)) entry.restoring = restoreSavedOutput(tabId, entry);');
    const bind = create.indexOf('bindSession(entry, sessionId);', reuseEnd);
    assert.ok(reuseEnd > 0 && take > reuseEnd, 'the restore is taken on the path that reuses a terminal');
    assert.ok(bind > take, 'the shell is bound before the restore was started');
    assert.match(create, /const noticeExited = \(\) => \{[\s\S]*?\};\s*if \(entry\.restoring\) entry\.restoring\.then\(noticeExited, noticeExited\);\s*else noticeExited\(\);/);
    // The pane's first fit is what the restore waits for, and the reader is the saver's queued read.
    assert.match(registrySource, /read: \(id\) => scrollbackSaver\.read\(id\),\s*waitForFit: \(\) => firstFit\(entry\),/);
    assert.match(registrySource, /pushIntoScrollback: os \? os === 'windows' : isWindows,/);
    assert.match(registrySource, /keepFile: \(id\) => scrollbackSaver\.keepFile\(id\),/, 'a read that failed does not keep the file');
  });

  test('RS-12: wired — a change and a shell clear heard through the watcher; Terminal: Clear saves at once; the watcher goes with the terminal', () => {
    const create = registrySource.slice(registrySource.indexOf('export function getOrCreateTerminal('));
    assert.match(
      create,
      /const scrollbackWatch = watchScrollbackChanges\(term, \{\s*changed: \(\) => scrollbackSaver\.markDirty\(tabId\),\s*cleared: \(\) => scrollbackSaver\.saveCleared\(tabId\),\s*quiet: \(\) => Boolean\(entry\?\.scrollbackQuiet\),/
    );
    assert.match(create.slice(create.indexOf('entry = {')), /^\s+scrollbackWatch,$/m, 'kept on the entry');
    const clear = registrySource.slice(registrySource.indexOf('export function clearTerminal(tabId) {'));
    assert.match(clear, /entry\.term\.clear\(\);\s*noteCleared\(entry\);/);
    // Terminal: Clear is saved at once every time — never through the clears' 2 s gap.
    assert.match(registrySource, /function noteCleared\(entry\) \{\s*scrollbackSaver\.saveNow\(entry\.tabId\);\s*\}/);
    const dispose = registrySource.slice(registrySource.indexOf('export function disposeTerminal('));
    assert.match(dispose, /entry\.scrollbackWatch\?\.dispose\(\);/);
    // A tab with no xterm is never read: the snapshot source answers undefined, and the file stays.
    assert.match(registrySource, /setScrollbackSnapshotSource\(\(tabId\) => \{\s*const entry = instances\.get\(tabId\);\s*if \(!entry \|\| entry\.disposed\) return undefined;/);
    // The folder's mark waits for a restore too (RS-17 to RS-20 for the rest).
    assert.match(registrySource, /const note = \(\) => \{\s*flushPacedOutput\(tabId\);\s*dirs\.note\(cwd\);\s*\};\s*afterRestore\(instances\.get\(tabId\), note\);/);
  });

  test('RS-13: teardown — a fresh bus, nothing waiting to be restored', async () => {
    await resetPtyOutputBus();
    resetScrollbackSession();
    assert.equal(restorePending('tab-term-1'), false);
  });
});

// ---- Review round 2 ------------------------------------------------------------

/**
 * The registry's writers, cut from its source and run together — the
 * restore wait (`afterRestore`), `afterOutputSoFar`, Terminal: Clear and its
 * save (`clearTerminal`, `noteCleared`), `writeNotice`, `bindSession` and the
 * progress bar's barrier — around a headless xterm and the real output bus.
 */
function compileRegistryKit({ listen, saver }) {
  const cut = (header, end = '\n}\n') => {
    const start = registrySource.indexOf(header);
    assert.ok(start >= 0, `${header} not found in terminalRegistry.js`);
    return registrySource.slice(start, registrySource.indexOf(end, start) + end.length).replace(/^export /, '');
  };
  const body = [
    cut('function afterRestore(entry, fn) {'),
    cut('function afterOutputSoFar(entry, fn) {'),
    cut('export function clearTerminal(tabId) {'),
    cut('function noteCleared(entry) {'),
    cut('export function writeNotice(tabId, message) {'),
    cut('function bindSession(entry, sessionId) {'),
    cut('setTerminalOutputBarrier((tabId, fn) => {', '\n});\n'),
    'return { afterOutputSoFar, clearTerminal, writeNotice, bindSession };',
  ].join('\n');
  const instances = new Map();
  let barrier = null;
  const write = (entry, data, read) => {
    entry.term.write(data);
    read?.();
  };
  const kit = new Function(
    'instances', 'flushPaced', 'scrollbackSaver', 'setTerminalOutputBarrier', 'startPtyOutputBus', 'attachOutput',
    'writeOutput', 'listen', 'forgetOutput', 'freshScreen', 'exitNotice', 'deliverLive',
    body
  )(instances, () => {}, saver, (b) => {
    barrier = b;
  }, () => {}, attachOutput, write, listen, forgetOutput, freshScreen, exitNotice, write);
  return { ...kit, instances, barrier: (tabId, fn) => barrier(tabId, fn) };
}

/** A terminal mid-restore: its read held until `answer(lines)`. */
function restoringEntry(kit, sessionId) {
  const entry = makeEntry({ cols: 60, rows: 6 });
  kit.instances.set(entry.tabId, entry);
  let answer;
  startRestore(entry, {
    read: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    waitForFit: () => Promise.resolve(),
  });
  kit.bindSession(entry, sessionId);
  return { entry, answer: (lines) => answer(fileFor('tab-term-1', lines)) };
}

/** Until the restore has settled, the callbacks waiting for it have run, and xterm has read it all. */
async function landed(entry, restoring) {
  await restoring;
  await tick(0);
  await parsed(entry.term);
  await tick(0);
  await parsed(entry.term);
}

describe('Scrollback restore: a slow read keeps the file (review round 2)', () => {
  test('RS-14: a read slower than two seconds still restores — the wait is five', async () => {
    assert.ok(RESTORE_READ_WAIT_MS >= 5000, `the read is given ${RESTORE_READ_WAIT_MS} ms`);
    const entry = makeEntry();
    const waits = [];
    const timers = [];
    let answer;
    const restoring = startRestore(entry, {
      read: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      waitForFit: () => Promise.resolve(),
      // A clock of the test's: the read's wait is asked for, and never runs out here.
      setTimeout: (fn, ms) => {
        waits.push(ms);
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => {},
    });
    await tick(0);
    assert.equal(waits[0], RESTORE_READ_WAIT_MS, 'the read is not given the five seconds');
    answer(fileFor('tab-term-1', ['answered after three seconds']));
    await restoring;
    assert.equal(rows(entry.term)[0], 'answered after three seconds');
  });

  test('RS-15: a read that times out, rejects or throws keeps the file; no file, or one not ours, does not', async () => {
    for (const [what, read, kept] of [
      ['a read that times out', () => new Promise(() => {}), true],
      ['a read that rejects', () => Promise.reject(new Error('disk busy')), true],
      ['a read that throws', () => {
        throw new Error('no backend');
      }, true],
      ['no file', () => Promise.resolve(null), false],
      ['a file not ours', () => Promise.resolve('not a scrollback file'), false],
      ['a file of ours', () => Promise.resolve(fileFor('tab-term-1', ['fine'])), false],
    ]) {
      const entry = makeEntry();
      const keptIds = [];
      const result = await restoreScrollback({
        term: entry.term,
        tabId: 'tab-term-1',
        read,
        readWaitMs: 30,
        keepFile: (id) => keptIds.push(id),
        warn: () => {},
      });
      assert.deepEqual(keptIds, kept ? ['tab-term-1'] : [], `${what}: ${JSON.stringify(result)}`);
      assert.equal(result.reason === 'unread', kept, `${what}: ${result.reason}`);
    }
  });
});

describe('Scrollback restore: what is done to a terminal waits for its restore (review round 2)', () => {
  test('RS-16: Terminal: Clear during the wait clears the restored text too — and is saved at once, after it', async () => {
    await resetPtyOutputBus();
    const saves = [];
    let target = null;
    const kit = compileRegistryKit({
      listen: fakeListen().listen,
      saver: { saveNow: (id) => saves.push({ id, rows: rows(target.term) }) },
    });
    const { entry, answer } = restoringEntry(kit, 'rs-16');
    target = entry;
    deliver('rs-16', 'prompt$ ');
    assert.equal(kit.clearTerminal('tab-term-1'), true);
    await tick(5);
    assert.deepEqual(saves, [], 'cleared (and saved) before the restored text was written — which then came back');
    const restoring = entry.restoring;
    answer(['OPENAI_API_KEY=[hidden]', 'secret build log']);
    await landed(entry, restoring);
    assert.deepEqual(rows(entry.term), ['prompt$'], `the restored text survived the clear: ${rows(entry.term).join(' | ')}`);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].id, 'tab-term-1');
    assert.ok(!saves[0].rows.some((r) => r.includes('secret build log')), 'saved with the cleared text still in it');
    forgetOutput('rs-16');
  });

  test('RS-17: a NexTerm notice during the wait goes below the restored text, not above it', async () => {
    await resetPtyOutputBus();
    const kit = compileRegistryKit({ listen: fakeListen().listen, saver: { saveNow() {} } });
    const { entry, answer } = restoringEntry(kit, 'rs-17');
    deliver('rs-17', 'prompt$ \r\n');
    assert.equal(kit.writeNotice('tab-term-1', 'could not open /x'), true);
    await tick(5);
    assert.deepEqual(rows(entry.term), [], 'written before the restore');
    const restoring = entry.restoring;
    answer(['saved line']);
    await landed(entry, restoring);
    const got = rows(entry.term);
    const separator = got.findIndex((r) => r.startsWith('── Previous output'));
    const notice = got.indexOf('[NexTerm] could not open /x');
    assert.equal(got[0], 'saved line', got.join(' | '));
    assert.ok(separator > 0 && notice > separator, `out of order: ${got.join(' | ')}`);
    forgetOutput('rs-17');
  });

  test('RS-18: a shell restarted during the wait: its fresh screen comes after the restored text, which goes up into the scrollback with the old output', async () => {
    await resetPtyOutputBus();
    const kit = compileRegistryKit({ listen: fakeListen().listen, saver: { saveNow() {} } });
    const { entry, answer } = restoringEntry(kit, 'rs-18a');
    deliver('rs-18a', 'old shell$ ');
    kit.bindSession(entry, 'rs-18b');
    deliver('rs-18b', 'new shell$ ');
    await tick(5);
    assert.deepEqual(rows(entry.term), [], 'the fresh screen was written before the restore');
    const restoring = entry.restoring;
    answer(['saved one', 'saved two']);
    await landed(entry, restoring);
    const buf = entry.term.buffer.normal;
    const at = (y) => buf.getLine(y).translateToString(true);
    assert.equal(at(buf.baseY + buf.cursorY).trimEnd(), 'new shell$', 'the new shell is not on the screen the fresh screen made');
    assert.equal(buf.cursorY, 0, 'the new shell does not start at the top of an empty screen');
    const scrollback = Array.from({ length: buf.baseY }, (_, y) => at(y));
    assert.ok(scrollback.includes('saved one') && scrollback.includes('saved two'), `the restored text is not in the scrollback: ${scrollback.join(' | ')}`);
    assert.ok(!rows(entry.term).some((r) => r.includes('old shell')), 'the replaced shell\'s output was written');
    forgetOutput('rs-18a');
    forgetOutput('rs-18b');
  });

  test('RS-19: a command\'s mark and the progress bar\'s barrier during the wait act on the screen after the restored text', async () => {
    await resetPtyOutputBus();
    const kit = compileRegistryKit({ listen: fakeListen().listen, saver: { saveNow() {} } });
    const { entry, answer } = restoringEntry(kit, 'rs-19');
    deliver('rs-19', 'prompt$ ');
    const seen = [];
    assert.equal(kit.afterOutputSoFar(entry, (e) => seen.push(['mark', rows(e.term)])), true);
    kit.barrier('tab-term-1', () => seen.push(['barrier', rows(entry.term)]));
    await tick(5);
    assert.deepEqual(seen, [], 'ran on the empty terminal before the restore');
    const restoring = entry.restoring;
    answer(['saved line']);
    await landed(entry, restoring);
    assert.deepEqual(seen.map(([what]) => what), ['mark', 'barrier']);
    for (const [what, screen] of seen) {
      assert.equal(screen[0], 'saved line', `${what}: ran before the restored text was read`);
      assert.equal(screen[screen.length - 1], 'prompt$', `${what}: ran before the shell's output held for the restore`);
    }
    forgetOutput('rs-19');
  });
});

describe('Scrollback restore: a clear in the output is heard (review rounds 2 and 3)', () => {
  /** A headless terminal with the watcher on it, and what it heard. */
  function watched({ cols = 40, rows: height = 5 } = {}) {
    const term = new Terminal({ cols, rows: height, scrollback: 1000, allowProposedApi: true });
    const heard = [];
    let quiet = false;
    const watch = watchScrollbackChanges(term, {
      changed: () => heard.push('changed'),
      cleared: () => heard.push('cleared'),
      quiet: () => quiet,
    });
    const write = async (data) => {
      heard.length = 0;
      await new Promise((resolve) => term.write(data, resolve));
      await tick(0);
      return [...new Set(heard)];
    };
    return { term, watch, write, setQuiet: (on) => (quiet = on) };
  }

  test('RS-20: Ctrl+L and `clear` with less than a screen of output are clears — the buffer is no shorter for them', async () => {
    const { term, write } = watched({ rows: 10 });
    assert.deepEqual(await write('$ export TOKEN=hunter2\r\n$ '), ['changed']);
    const before = term.buffer.normal.length;
    assert.deepEqual(await write('\x1b[H\x1b[2J'), ['cleared'], 'Ctrl+L went unheard: a quit within the wait brings the screen back');
    assert.equal(term.buffer.normal.length, before, 'the length changed, so this did not test what the old rule missed');
    // Heard, and still done: the handlers return false, so xterm erases as ever.
    const screen = Array.from({ length: term.rows }, (_, y) => term.buffer.normal.getLine(term.buffer.normal.baseY + y).translateToString(true));
    assert.ok(screen.every((row) => !row.includes('hunter2')), `the clear was swallowed: ${screen.join(' | ')}`);
    assert.deepEqual(await write('$ '), ['changed']);
    assert.deepEqual(await write('\x1b[H\x1b[2J\x1b[3J'), ['cleared'], '`clear`');
    assert.deepEqual(await write('\x1b[3J'), ['cleared'], 'CSI 3 J alone');
    term.dispose();
  });

  test('RS-21: a clear followed by 400 lines in one write, and a reset, are clears; erasing part of the screen is not', async () => {
    const { term, write } = watched();
    await write(Array.from({ length: 50 }, (_, i) => `before ${i}\r\n`).join(''));
    const refill = Array.from({ length: 400 }, (_, i) => `after ${i}\r\n`).join('');
    assert.deepEqual(await write(`\x1b[H\x1b[2J\x1b[3J${refill}`), ['cleared'], 'a clear and a refill in one write went unheard — the buffer ended longer');
    // A reset also switches to the normal buffer, heard as a change: the clear is what matters.
    assert.ok((await write('\x1bc')).includes('cleared'), 'a reset');
    assert.ok(!rows(term).some((r) => r.startsWith('after')), 'the reset was swallowed');
    for (const partial of ['\x1b[J', '\x1b[0J', '\x1b[1J', '\x1b[K', '\x1b[2K']) {
      assert.deepEqual(await write(partial), ['changed'], `${JSON.stringify(partial)} taken for a clear`);
    }
    term.dispose();
  });

  test('RS-22: on the alternate screen CSI 2 J and 3 J are not clears, nor changes; a reset there still is a clear', async () => {
    const { term, write } = watched();
    await write('$ vim notes.txt\r\n');
    assert.deepEqual(await write('\x1b[?1049h'), ['changed'], 'a switch of buffers is a change');
    assert.deepEqual(await write('\x1b[H\x1b[2Jfull-screen frame\x1b[3J'), [], 'a full-screen program clearing its own screen was taken for a clear');
    assert.ok((await write('\x1bc')).includes('cleared'), 'a reset clears the normal screen too, whichever is up');
    term.dispose();
  });

  test('RS-23: a resize is never a clear — even one that takes lines away — and a clear right after one still is', async () => {
    const { term, write } = watched({ cols: 20, rows: 5 });
    await write(`${'x'.repeat(50)}\r\n`.repeat(20));
    const before = term.buffer.normal.length;
    term.resize(80, 5);
    assert.ok(term.buffer.normal.length < before, 'the resize took no lines away, so this tested nothing');
    assert.deepEqual(await write('after the resize\r\n'), ['changed'], 'a wider pane was taken for a clear');
    term.resize(30, 5);
    assert.deepEqual(await write('\x1b[H\x1b[2J'), ['cleared'], 'a clear just after a resize went unheard');
    term.dispose();
  });

  test('RS-24: quiet — a restore writing — is neither a change nor a clear, and leaves no clear behind for later', async () => {
    const { term, write, setQuiet } = watched();
    setQuiet(true);
    assert.deepEqual(await write(Array.from({ length: 30 }, (_, i) => `restored ${i}\r\n`).join('')), []);
    assert.deepEqual(await write('\x1b[3J'), []);
    setQuiet(false);
    assert.deepEqual(await write('$ '), ['changed'], 'a clear met while quiet was heard later as a clear');
    term.dispose();
  });

  test('RS-25: `watch`-like — a clear every 300 ms for 10 s — is saved at most six times, the last screen included', async () => {
    const term = new Terminal({ cols: 40, rows: 5, scrollback: 1000, allowProposedApi: true });
    let t = 1_700_000_000_000;
    const timers = new Map();
    let seq = 0;
    const shots = [];
    const saver = createScrollbackSaver({
      snapshot: () => {
        shots.push(term.buffer.normal.getLine(term.buffer.normal.baseY).translateToString(true));
        return { text: 'x' };
      },
      backend: { write: async () => {}, delete: async () => {} },
      now: () => t,
      setTimeout: (fn, ms) => {
        seq += 1;
        timers.set(seq, { at: t + ms, fn });
        return seq;
      },
      clearTimeout: (id) => timers.delete(id),
    });
    const advance = async (ms) => {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await tick(0);
      }
      t = end;
    };
    const watch = watchScrollbackChanges(term, {
      changed: () => saver.markDirty('tab-term-1'),
      cleared: () => saver.saveCleared('tab-term-1'),
    });
    const frame = (i) => new Promise((resolve) => term.write(`\x1b[H\x1b[2JEvery 1.0s: date  frame ${i}`, resolve));
    await frame(0);
    await tick(0);
    assert.equal(shots.length, 1, 'the first clear was not saved at once');
    let i = 1;
    for (; i * 300 < 10_000; i += 1) {
      await advance(300);
      await frame(i);
      await tick(0);
    }
    const last = `Every 1.0s: date  frame ${i - 1}`;
    await advance(2000);
    assert.ok(shots.length <= 6, `${shots.length} immediate saves in 10 s`);
    assert.ok(shots.length >= 5, `only ${shots.length}: clears inside the gap were dropped rather than saved at its end`);
    assert.equal(shots[shots.length - 1], last, 'the screen as it was left was never saved');
    watch.dispose();
    saver.stop();
    term.dispose();
  });

  test('RS-26: another NexTerm keeps the folder — nothing is restored for the rest of the session', async () => {
    const real = scrollbackBackend.retainOnly;
    const warn = console.warn;
    console.warn = () => {};
    try {
      resetScrollbackSession();
      markForRestore(['tab-term-5']);
      scrollbackBackend.retainOnly = () => Promise.reject('Another NexTerm is using the saved scrollback; this one saves and restores none until it is started again');
      await scrollbackSaver.retainOnly([]);
      assert.equal(scrollbackSaver.refused, true);
      assert.equal(takeRestore('tab-term-5'), false, 'restored while another NexTerm keeps the files');
    } finally {
      scrollbackBackend.retainOnly = real;
      console.warn = warn;
      resetScrollbackSession();
    }
    assert.equal(scrollbackSaver.refused, false, 'the suites cannot start afresh');
  });

  test('RS-28: a folder that fails three times in a row — any cause — stops the restore of tabs not yet shown too', async () => {
    const real = scrollbackBackend.retainOnly;
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      resetScrollbackSession();
      markForRestore(['tab-term-6']);
      scrollbackBackend.retainOnly = () => Promise.reject('The scrollback folder is a link');
      for (let i = 0; i < 3; i += 1) await scrollbackSaver.retainOnly([]);
      assert.equal(scrollbackSaver.tripped, true, 'three failures in a row did not open the breaker');
      assert.equal(takeRestore('tab-term-6'), false, 'restored from a folder given up on');
      assert.ok(warned.some((w) => w.includes('is a link')), warned.join('\n'));
    } finally {
      scrollbackBackend.retainOnly = real;
      console.warn = warn;
      resetScrollbackSession();
    }
  });

  test('RS-29: DECSED — CSI ? 2 J and CSI ? 3 J — is a clear too, on the normal screen only; its partial forms are not', async () => {
    const { term, write } = watched({ rows: 6 });
    assert.deepEqual(await write('$ cat .env\r\nAPI_TOKEN=abc\r\n$ '), ['changed']);
    assert.deepEqual(await write('\x1b[?2J'), ['cleared'], 'a selective erase of the screen went unheard');
    const screen = Array.from({ length: term.rows }, (_, y) => term.buffer.normal.getLine(term.buffer.normal.baseY + y).translateToString(true));
    assert.ok(screen.every((row) => !row.includes('API_TOKEN')), `swallowed: ${screen.join(' | ')}`);
    assert.deepEqual(await write('\x1b[?3J'), ['cleared']);
    for (const partial of ['\x1b[?J', '\x1b[?0J', '\x1b[?1J']) {
      assert.deepEqual(await write(partial), ['changed'], `${JSON.stringify(partial)} taken for a clear`);
    }
    await write('\x1b[?1049h');
    assert.deepEqual(await write('\x1b[?2J'), [], 'a full-screen program\'s selective erase taken for a clear');
    term.dispose();
  });

  test('RS-27: teardown — a fresh bus, nothing waiting to be restored', async () => {
    await resetPtyOutputBus();
    resetScrollbackSession();
    assert.equal(restorePending('tab-term-1'), false);
  });
});
