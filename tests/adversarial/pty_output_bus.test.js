/**
 * Output a tab prints before its terminal exists is kept for it
 * (src/lib/ptyOutputBus.js).
 *
 * A tab's xterm is made the first time a TerminalView shows it, and until then
 * nothing wrote its shell's output anywhere. Measured in the macOS app
 * (2026-10-05): a layout template's background tab ran its startup command —
 * `fc -ln -1` in it printed the command — and showed only a fresh prompt when
 * brought forward. Every chunk now goes through one listener: into the
 * terminal when there is one, kept (the newest BACKLOG_LIMIT characters) when
 * there is not, and handed over in one synchronous step when it appears.
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  BACKLOG_LIMIT,
  attachOutput,
  backlogSize,
  deliver,
  forgetOutput,
  resetPtyOutputBus,
  startPtyOutputBus,
} from '../../src/lib/ptyOutputBus.js';

const { Terminal: HeadlessTerminal } = headless;

/** A stand-in for Tauri's `listen`: records handlers, lets the test emit. */
function fakeListen() {
  const handlers = [];
  const on = (event, handler) => {
    handlers.push({ event, handler });
    return Promise.resolve(() => {
      const i = handlers.findIndex((h) => h.handler === handler);
      if (i >= 0) handlers.splice(i, 1);
    });
  };
  const emit = (session_id, data) => {
    for (const h of handlers) if (h.event === 'pty-output') h.handler({ session_id, data });
  };
  return { on, emit, handlers };
}

describe('Output a tab printed before its terminal existed', () => {
  test('PB-01: kept until a terminal attaches, handed over in order, then live — nothing doubled', async () => {
    await resetPtyOutputBus();
    const bus = fakeListen();
    await startPtyOutputBus({ listen: bus.on });
    bus.emit('s1', 'one ');
    bus.emit('s1', 'two ');
    assert.equal(backlogSize('s1'), 8);
    const got = [];
    attachOutput('s1', (d) => got.push(d));
    assert.deepEqual(got, ['one ', 'two '], 'what was kept, first and in order');
    assert.equal(backlogSize('s1'), 0, 'and no longer kept');
    bus.emit('s1', 'three');
    assert.deepEqual(got, ['one ', 'two ', 'three'], 'then live, once');
  });

  test('PB-02: the newest BACKLOG_LIMIT characters are kept — oldest chunks out, a huge one by its tail', async () => {
    await resetPtyOutputBus();
    const half = 'a'.repeat(BACKLOG_LIMIT / 2);
    deliver('s2', 'OLD');
    deliver('s2', half);
    deliver('s2', half);
    assert.equal(backlogSize('s2'), BACKLOG_LIMIT, 'the oldest chunk went');
    const got = [];
    attachOutput('s2', (d) => got.push(d));
    assert.equal(got.join(''), half + half);

    deliver('s3', 'x'.repeat(BACKLOG_LIMIT) + 'TAIL');
    assert.equal(backlogSize('s3'), BACKLOG_LIMIT);
    const tail = [];
    attachOutput('s3', (d) => tail.push(d));
    assert.ok(tail.join('').endsWith('TAIL'), 'one chunk past the limit keeps its tail');
  });

  test('PB-03: taken away again, output is kept again — and goes to the next terminal attached', async () => {
    await resetPtyOutputBus();
    const first = [];
    const detach = attachOutput('s4', (d) => first.push(d));
    deliver('s4', 'a');
    detach();
    deliver('s4', 'b');
    assert.deepEqual(first, ['a']);
    assert.equal(backlogSize('s4'), 1);
    const second = [];
    attachOutput('s4', (d) => second.push(d));
    assert.deepEqual(second, ['b']);
  });

  test('PB-04: sessions are kept apart, and a forgotten one is gone', async () => {
    await resetPtyOutputBus();
    deliver('s5', 'five');
    deliver('s6', 'six');
    forgetOutput('s5');
    assert.equal(backlogSize('s5'), 0);
    assert.equal(backlogSize('s6'), 3);
    const got = [];
    attachOutput('s5', (d) => got.push(d));
    deliver('s6', '!');
    assert.deepEqual(got, [], 'nothing of s6 reaches s5');
  });

  test('PB-05: one listener however often it is started; a sink that throws loses its chunk, not the listener', async () => {
    await resetPtyOutputBus();
    const bus = fakeListen();
    await Promise.all([startPtyOutputBus({ listen: bus.on }), startPtyOutputBus({ listen: bus.on }), startPtyOutputBus({ listen: bus.on })]);
    assert.equal(bus.handlers.length, 1);
    const warn = console.warn;
    console.warn = () => {};
    try {
      attachOutput('s7', () => {
        throw new Error('boom');
      });
      const other = [];
      attachOutput('s8', (d) => other.push(d));
      bus.emit('s7', 'lost');
      bus.emit('s8', 'kept going');
      assert.deepEqual(other, ['kept going']);
    } finally {
      console.warn = warn;
    }
    // Empty, missing or non-string data is nothing.
    deliver('s9', '');
    deliver('s9', null);
    deliver(null, 'x');
    assert.equal(backlogSize('s9'), 0);
  });

  test('PB-06: real xterm made after the output came shows it', async () => {
    await resetPtyOutputBus();
    deliver('s10', 'printed before the terminal existed\r\n');
    deliver('s10', '\x1b[32mstill green\x1b[0m\r\n');
    const term = new HeadlessTerminal({ cols: 60, rows: 5, allowProposedApi: true });
    await new Promise((resolve) => {
      attachOutput('s10', (d) => term.write(d));
      term.write('', resolve);
    });
    const b = term.buffer.active;
    assert.equal(b.getLine(0).translateToString(true), 'printed before the terminal existed');
    assert.equal(b.getLine(1).translateToString(true), 'still green');
    assert.equal(b.getLine(1).getCell(0).getFgColor(), 2, 'escape sequences arrive intact');
    term.dispose();
  });

  test('PB-07: wired — the registry attaches through the bus, the store starts it first and forgets a closed tab', () => {
    const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(registry, /ptyUnlisten = attachOutput\(sessionId, \(data\) => entry\.term\.write\(data\)\);/);
    assert.doesNotMatch(registry, /listen\('pty-output'/, 'no listener of its own left to race the bus');
    assert.match(registry, /forgetOutput\(entry\.sessionId\)/, 'a rebound instance drops the old shell');
    const store = readFileSync(new URL('../../src/stores/terminalStore.js', import.meta.url), 'utf8');
    const attach = store.indexOf('attachListeners: async () => {');
    assert.ok(attach > 0);
    const startAt = store.indexOf('await startPtyOutputBus();', attach);
    const firstListen = store.indexOf("listen('pty-output'", attach);
    assert.ok(startAt > attach && startAt < firstListen, 'the bus starts before the other listeners, at bootstrap');
    assert.match(store, /forgetOutput\(tab\.sessionId\);/, 'closing a tab forgets its output');
  });

  test('PB-08: teardown — a fresh bus for whatever runs next', async () => {
    await resetPtyOutputBus();
    assert.equal(backlogSize('s1'), 0);
  });
});
