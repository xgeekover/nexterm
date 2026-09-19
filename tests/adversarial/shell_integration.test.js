/**
 * Shell integration contract for the terminal store.
 *
 * The terminal UI is now a single persistent xterm per tab (see
 * `src/components/terminal/TerminalView.jsx`) — it writes raw PTY output
 * straight to the screen and is the store's only concern is bookkeeping:
 * `blocks` still records each command's output/exit code/duration for the
 * command palette, history and any future re-run/inspection UI, entirely
 * independent of what the live terminal is showing. These tests exercise
 * that bookkeeping layer directly against the real Zustand store (no
 * rendering involved): OSC 133's `pty-command-done` still closes the
 * running block with the right exit code, stray output never lands on a
 * finished block, PTY resizes are de-duplicated, and `writeRaw`/`closeTab`
 * behave. Registered with the shared runner.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const store = useTerminalStore;
const tab = () => store.getState().tabs.find((t) => t.id === store.getState().activeTabId);
const sessionId = () => tab().sessionId;

function seedRunningBlock(id) {
  store.setState((state) => ({
    tabs: state.tabs.map((t) =>
      t.id === state.activeTabId
        ? {
            ...t,
            blocks: [
              ...t.blocks,
              { id, command: 'sleep 1', cwd: t.cwd, output: '', exitCode: null, durationMs: 0, startTime: Date.now() - 50, status: 'running', pinned: false },
            ],
          }
        : t
    ),
  }));
}

describe('Shell integration: OSC 133 command boundaries (store bookkeeping)', () => {
  beforeEach(async () => {
    await store.getState().init();
  });

  test('SI-01: pty-command-done with exit 0 completes the running block and keeps its output', async () => {
    seedRunningBlock('blk-a');
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'hello\r\n' });
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    const b = tab().blocks.find((x) => x.id === 'blk-a');
    assert.equal(b.status, 'completed');
    assert.equal(b.exitCode, 0);
    assert.equal(b.output, 'hello\r\n');
    assert.ok(b.durationMs >= 50, `durationMs should be measured, got ${b.durationMs}`);
  });

  test('SI-02: non-zero exit code marks the block failed with that code', async () => {
    seedRunningBlock('blk-b');
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 127 });
    const b = tab().blocks.find((x) => x.id === 'blk-b');
    assert.equal(b.status, 'failed');
    assert.equal(b.exitCode, 127);
  });

  test('SI-03: output with no running block is dropped, never appended to a finished block', async () => {
    // This is a bookkeeping guarantee only — the live xterm always shows the
    // prompt/echo bytes regardless (osc.rs forwards everything but the OSC
    // 133 markers), but the `blocks` history must not misattribute them.
    const before = tab().blocks.map((b) => b.output);
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'user@host % ' });
    assert.deepEqual(tab().blocks.map((b) => b.output), before);
  });

  test('SI-04: command-done with no running block is a no-op', async () => {
    const before = JSON.stringify(tab().blocks);
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    assert.equal(JSON.stringify(tab().blocks), before);
  });

  test('SI-05: consecutive commands each keep their own output (attribution)', async () => {
    seedRunningBlock('blk-c1');
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'first\r\n' });
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    seedRunningBlock('blk-c2');
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'second\r\n' });
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    assert.equal(tab().blocks.find((x) => x.id === 'blk-c1').output, 'first\r\n');
    assert.equal(tab().blocks.find((x) => x.id === 'blk-c2').output, 'second\r\n');
  });

  test('SI-06: resizePty forwards cols/rows once per distinct size (dedupe)', async () => {
    const session = mockBridge.ptySessions.get(sessionId());
    await store.getState().resizePty(tab().id, 132, 40);
    assert.equal(session.cols, 132);
    assert.equal(session.rows, 40);
    session.cols = 0; // a redundant second call would overwrite this
    await store.getState().resizePty(tab().id, 132, 40);
    assert.equal(session.cols, 0, 'identical size must not be re-sent');
    await store.getState().resizePty(tab().id, 100, 30);
    assert.equal(session.cols, 100);
  });

  test('SI-10: a drag reaches the shell once, at the size it ended on', async () => {
    // Dragging a divider hands `resizePty` a new size every frame. Each one
    // used to be a `set` on `tabs` — re-rendering the terminals panel, the
    // split container and the tab strips — and a SIGWINCH the shell redrew
    // its prompt for. That storm is what the flicker was.
    const session = mockBridge.ptySessions.get(sessionId());
    let resizes = 0;
    const invoke = mockBridge.invoke.bind(mockBridge);
    mockBridge.invoke = async (cmd, args) => {
      if (cmd === 'pty_resize') resizes += 1;
      return invoke(cmd, args);
    };

    try {
      const frames = [];
      for (let cols = 100; cols <= 130; cols += 1) {
        frames.push(store.getState().resizePty(tab().id, cols, 30));
      }
      await Promise.all(frames);

      assert.equal(resizes, 1, `31 frames of a drag must be one pty_resize, not ${resizes}`);
      assert.equal(session.cols, 130, 'and it must be the size the drag ended on');
      assert.equal(session.rows, 30);
      assert.equal(tab().lastSize, '130x30', 'the status bar shows the settled size');
    } finally {
      mockBridge.invoke = invoke;
    }
  });

  test('SI-07: writeRaw sends bytes to the bound session without throwing', async () => {
    // This is what every keystroke in the live xterm goes through
    // (`term.onData(d => writeRaw(tabId, d))`).
    await store.getState().writeRaw(tab().id, '\x03');
    await store.getState().writeRaw(tab().id, '');
  });

  test('SI-08: setBlockOutput replaces a block\'s recorded output only', async () => {
    seedRunningBlock('blk-snap');
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'raw ansi bytes' });
    store.getState().setBlockOutput(tab().id, 'blk-snap', 'x');
    const b = tab().blocks.find((b2) => b2.id === 'blk-snap');
    assert.equal(b.output, 'x');
    // Only the output field changes — everything else on the block is untouched.
    assert.equal(b.status, 'running');
    assert.equal(b.command, 'sleep 1');
  });

  test('SI-09: closeTab kills the PTY, tears down bookkeeping, and never throws without a mounted terminal view', async () => {
    // `closeTab` also disposes the tab's persistent xterm instance (see
    // `terminalStore.js`'s guarded dynamic import of
    // `components/terminal/terminalRegistry.js`). Under this Node test
    // environment there is no `document`, so that dispose is a guarded
    // no-op — closeTab must still complete cleanly and drop the tab.
    const before = tab();
    const second = await store.getState().createTab('Closable');
    assert.equal(store.getState().tabs.length, 2);

    await store.getState().closeTab(second.id);

    assert.equal(store.getState().tabs.length, 1);
    assert.equal(store.getState().tabs.find((t) => t.id === second.id), undefined);
    assert.equal(mockBridge.ptySessions.has(second.sessionId), false, 'pty_kill must remove the session');
    assert.equal(store.getState().activeTabId, before.id);
  });
});
