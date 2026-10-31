/**
 * Flow control, the page's half (src/lib/ptyOutputBus.js; the backend's is
 * src-tauri/src/pty/flow_gate.rs).
 *
 * Four terminals flooding at once left v0.21.0's page 18 s behind, froze the
 * window for 11 s at a time, grew it to 3 GB and lost output: xterm throws a
 * write away once 50 M characters wait to be read. The backend now stops
 * reading a shell whose output the page is too far behind with, and the page
 * says how far it has got: each chunk's `bytes`, once xterm has read it — or
 * at once when it is kept for a terminal that does not exist yet.
 *
 * Every chunk must be acknowledged exactly once. Twice, and the backend
 * thinks the page is further on than it is; never, and the shell is held
 * until the backend gives up on the page (two seconds).
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  ACK_DELAY_MS,
  ACK_EVERY,
  attachOutput,
  deliver,
  forgetOutput,
  resetPtyOutputBus,
  startPtyOutputBus,
} from '../../src/lib/ptyOutputBus.js';

const { Terminal: HeadlessTerminal } = headless;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The bus started on stand-ins: a listen the test can emit through, and every invoke recorded. */
async function bus() {
  await resetPtyOutputBus();
  const handlers = [];
  const calls = [];
  await startPtyOutputBus({
    listen: (event, handler) => {
      handlers.push({ event, handler });
      return Promise.resolve(() => {});
    },
    invoke: (command, args) => {
      calls.push({ command, args });
      return Promise.resolve(null);
    },
  });
  // The reset is sent once the listener is up, a task later.
  await sleep(0);
  const emitPayload = (payload) => {
    for (const h of handlers) if (h.event === 'pty-output') h.handler(payload);
  };
  const emit = (session_id, data, bytes = new TextEncoder().encode(data).length) => emitPayload({ session_id, data, bytes });
  const acks = (sessionId) =>
    calls.filter((c) => c.command === 'pty_ack' && (!sessionId || c.args.session_id === sessionId)).map((c) => c.args.bytes);
  return { emit, emitPayload, calls, acks };
}

describe('Flow control: the page says what it has read', () => {
  test('FC-01: starting to listen tells the backend that nothing sent to an earlier page is waited for', async () => {
    const b = await bus();
    assert.deepEqual(b.calls.map((c) => c.command), ['pty_flow_reset']);
    await resetPtyOutputBus();
  });

  test('FC-02: output kept for a terminal that does not exist yet is acknowledged at once', async () => {
    const b = await bus();
    b.emit('fc-02', 'hello', 5);
    assert.deepEqual(b.acks(), [], 'gathered, not one call per chunk');
    await sleep(ACK_DELAY_MS + 15);
    assert.deepEqual(b.acks('fc-02'), [5]);
    forgetOutput('fc-02');
    await resetPtyOutputBus();
  });

  test('FC-03: output written into a terminal is acknowledged when it has been read, not when it arrives — once', async () => {
    const b = await bus();
    const pending = [];
    attachOutput('fc-03', (data, kept, at, read) => pending.push(read));
    b.emit('fc-03', 'abc', 3);
    await sleep(ACK_DELAY_MS + 15);
    assert.deepEqual(b.acks(), [], 'written but not read: nothing acknowledged');
    pending[0]();
    pending[0]();
    await sleep(ACK_DELAY_MS + 15);
    assert.deepEqual(b.acks('fc-03'), [3], 'read: acknowledged, and only once however often it is said');
    forgetOutput('fc-03');
    await resetPtyOutputBus();
  });

  test('FC-04: a terminal that throws on a write does not hold its shell', async () => {
    const b = await bus();
    attachOutput('fc-04', () => {
      throw new Error('write data discarded');
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      b.emit('fc-04', 'x', 1);
    } finally {
      console.warn = warn;
    }
    await sleep(ACK_DELAY_MS + 15);
    assert.deepEqual(b.acks('fc-04'), [1]);
    forgetOutput('fc-04');
    await resetPtyOutputBus();
  });

  test('FC-05: acknowledgements are gathered per session — one call for many small chunks, at once for a big one', async () => {
    const b = await bus();
    for (let i = 0; i < 50; i += 1) b.emit('fc-05a', 'y', 1000);
    b.emit('fc-05b', 'z', 7);
    await sleep(ACK_DELAY_MS + 15);
    assert.deepEqual(b.acks('fc-05a'), [50_000]);
    assert.deepEqual(b.acks('fc-05b'), [7]);
    b.emit('fc-05a', 'big', ACK_EVERY);
    await sleep(0);
    assert.deepEqual(b.acks('fc-05a'), [50_000, ACK_EVERY], 'a chunk of ACK_EVERY goes without waiting');
    forgetOutput('fc-05a');
    forgetOutput('fc-05b');
    await resetPtyOutputBus();
  });

  test('FC-06: a session forgotten — its tab closed — has nothing acknowledged for it afterwards', async () => {
    const b = await bus();
    b.emit('fc-06', 'q', 9);
    forgetOutput('fc-06');
    await sleep(ACK_DELAY_MS + 15);
    assert.deepEqual(b.acks('fc-06'), []);
    await resetPtyOutputBus();
  });

  test('FC-07: a chunk without a size (the browser mock, an older backend) is never acknowledged', async () => {
    const b = await bus();
    b.emitPayload({ session_id: 'fc-07', data: 'old' });
    await sleep(ACK_DELAY_MS + 15);
    assert.deepEqual(b.acks(), []);
    forgetOutput('fc-07');
    await resetPtyOutputBus();
  });

  test('FC-08: the registry acknowledges from xterm\'s write callback, after the chunk is read', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('function writeOutput(entry, data, read = null) {');
    const length = src.slice(start).search(/\n\}\n/);
    assert.ok(start > 0 && length > 0, 'terminalRegistry.js writes output through writeOutput(entry, data, read)');
    const writeOutput = new Function('useTerminalStore', 'writeObserver', `${src.slice(start, start + length)}\n}\nreturn writeOutput;`)(
      { getState: () => ({ batchJobOutputArrived: () => false }) },
      null
    );
    const callbacks = [];
    let acked = 0;
    writeOutput({ tabId: 't', term: { write: (data, cb) => callbacks.push(cb) } }, 'data', () => (acked += 1));
    assert.equal(acked, 0, 'queued in xterm is not read');
    callbacks[0]();
    assert.equal(acked, 1);
    // The registry's sink passes the bus's `read` on.
    assert.match(src, /attachOutput\(sessionId, \(data, kept, at, read\) => \{[\s\S]*?writeOutput\(entry, data, read\)/);
  });

  test('FC-10: a window out of sight does not slow its programs — macOS neither naps the app nor suspends its page', () => {
    // Under flow control a program waits on the page; a napped app or a
    // suspended page would make every build and agent in it crawl while
    // NexTerm is behind another app or minimised (review round 1).
    const plist = readFileSync(new URL('../../src-tauri/Info.plist', import.meta.url), 'utf8');
    assert.match(plist, /<key>LSAppNapIsDisabled<\/key>\s*<true\/>/);
    const config = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    assert.equal(config.app.windows[0].backgroundThrottling, 'disabled');
  });

  test('FC-09: through a real xterm: every byte sent is acknowledged once xterm has read it all, and the text is all there', async () => {
    const b = await bus();
    const term = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 10_000, allowProposedApi: true });
    attachOutput('fc-09', (data, kept, at, read) => term.write(data, read ?? undefined));
    let sent = 0;
    for (let i = 0; i < 2000; i += 1) {
      const line = `#${String(i).padStart(8, '0')} 한글 🙂 line\r\n`;
      const bytes = new TextEncoder().encode(line).length;
      sent += bytes;
      b.emit('fc-09', line, bytes);
    }
    await new Promise((resolve) => term.write('', resolve));
    await sleep(ACK_DELAY_MS + 15);
    assert.equal(b.acks('fc-09').reduce((a, n) => a + n, 0), sent, 'acknowledged exactly what was sent');
    const buf = term.buffer.active;
    const last = buf.getLine(buf.baseY + buf.cursorY - 1)?.translateToString(true);
    assert.match(last, /^#00001999 /);
    term.dispose();
    forgetOutput('fc-09');
    await resetPtyOutputBus();
  });
});
