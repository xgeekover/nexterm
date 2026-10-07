/**
 * Shell integration contract for the terminal store.
 *
 * The terminal UI is a single persistent xterm per tab (see
 * `src/components/terminal/TerminalView.jsx`), and a shell's output goes
 * from the output bus straight into it (src/lib/ptyOutputBus.js), never
 * through the store. What the store keeps of a command is what OSC 133 says
 * about it: `running` from its start ("C") and `lastExitCode` from its end
 * ("D"), which the tab strip, the status bar and the notifications read.
 * These cases drive that through the real Zustand store (no rendering
 * involved), with commands typed through `writeRaw` as every key is: the
 * verdict an end leaves on the tab, that output never touches the store,
 * that an end with nothing running finishes nothing, that each command's
 * verdict replaces the last; and that PTY resizes are de-duplicated and
 * `writeRaw`/`closeTab` behave. Registered with the shared runner.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const store = useTerminalStore;
const tab = () => store.getState().tabs.find((t) => t.id === store.getState().activeTabId);
const sessionId = () => tab().sessionId;

/** Type a line at the active terminal's prompt; the mock shell answers within the write. */
async function typeLine(line) {
  const id = tab().id;
  let sawRunning = false;
  const stop = store.subscribe((state) => {
    if (state.tabs.find((t) => t.id === id)?.running) sawRunning = true;
  });
  try {
    await store.getState().writeRaw(id, `${line}\r`);
  } finally {
    stop();
  }
  return { sawRunning };
}

describe('Shell integration: OSC 133 command boundaries (what the tab keeps)', () => {
  beforeEach(async () => {
    await store.getState().init();
  });

  test('SI-01: a command that exits 0 reads as running while it runs, then leaves the tab idle with its code', async () => {
    const { sawRunning } = await typeLine('echo hello');
    assert.equal(sawRunning, true, 'the shell said it started (C), and the tab never read as running');
    assert.equal(tab().running, false, 'the shell said it ended (D)');
    assert.equal(tab().runStartedAt, null);
    assert.equal(tab().lastExitCode, 0);
  });

  test('SI-02: a non-zero exit code is kept as the tab’s verdict', async () => {
    await typeLine('no-such-command');
    assert.equal(tab().lastExitCode, 127);
    assert.equal(tab().running, false);
  });

  test('SI-03: output never touches the store, even while a command runs', async () => {
    // Output goes from the bus into the terminal. A store update per chunk
    // re-rendered the side bar, every pane and the status bar as fast as a
    // shell could print.
    await mockBridge.emit('pty-command-started', { session_id: sessionId() });
    const before = store.getState();
    let updates = 0;
    const stop = store.subscribe(() => {
      updates += 1;
    });
    try {
      for (let i = 0; i < 5; i += 1) {
        await mockBridge.emit('pty-output', { session_id: sessionId(), data: `line ${i}\r\n` });
      }
    } finally {
      stop();
    }
    assert.equal(updates, 0, 'a chunk of output changed the store');
    assert.equal(store.getState(), before);
    await mockBridge.emit('pty-command-done', { session_id: sessionId(), exit_code: 0 });
    assert.equal(tab().running, false);
  });

  test('SI-04: an end with nothing running gives a verdict and finishes nothing', async () => {
    // Every prompt sends a D, so an empty Enter — or a second integration in
    // the user's rc — reports an end with no command behind it. In a
    // terminal in the background that must not say a command finished.
    const background = tab();
    assert.equal(background.running, false, 'setup: nothing is running there');
    const front = await store.getState().createTab('In front');
    try {
      assert.notEqual(store.getState().activeTabId, background.id, 'setup: the tab is in the background');
      const notes = store.getState().notifications.length;
      await mockBridge.emit('pty-command-done', { session_id: background.sessionId, exit_code: 0 });
      const after = store.getState().tabs.find((t) => t.id === background.id);
      assert.equal(after.lastExitCode, 0);
      assert.equal(after.running, false);
      assert.equal(store.getState().notifications.length, notes, 'a notification for a command that never ran');
    } finally {
      await store.getState().closeTab(front.id);
    }
  });

  test('SI-05: consecutive commands each leave their own verdict', async () => {
    await typeLine('no-such-command');
    assert.equal(tab().lastExitCode, 127, 'the first one failed');
    await typeLine('echo second');
    assert.equal(tab().lastExitCode, 0, 'the second one’s verdict, not the first one’s');
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
