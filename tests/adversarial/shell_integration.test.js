/**
 * Shell integration contract: OSC 133 `pty-command-done` closes the running
 * block with the real exit code, stray output never lands on finished blocks,
 * and PTY resizes are de-duplicated. Registered with the shared runner.
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

describe('Shell integration: OSC 133 command boundaries', () => {
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
    const before = tab().blocks.map((b) => b.output);
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'user@host % ' });
    assert.deepEqual(tab().blocks.map((b) => b.output), before);
  });

  test('SI-04: command-done with no running block is a no-op', async () => {
    const before = JSON.stringify(tab().blocks);
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    assert.equal(JSON.stringify(tab().blocks), before);
  });

  test('SI-05: consecutive commands each keep their own output', async () => {
    seedRunningBlock('blk-c1');
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'first\r\n' });
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    seedRunningBlock('blk-c2');
    await mockBridge.emit('pty-output', { session_id: sessionId(), data: 'second\r\n' });
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    assert.equal(tab().blocks.find((x) => x.id === 'blk-c1').output, 'first\r\n');
    assert.equal(tab().blocks.find((x) => x.id === 'blk-c2').output, 'second\r\n');
  });

  test('SI-06: resizePty forwards cols/rows once per distinct size', async () => {
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

  test('SI-07: writeRaw sends bytes to the bound session without throwing', async () => {
    await store.getState().writeRaw(tab().id, '\x03');
    await store.getState().writeRaw(tab().id, '');
  });
});
