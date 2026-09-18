/**
 * A tab that says what its shell is doing.
 *
 * The point of the indicator is the terminals you are NOT looking at, so the
 * cases here are mostly about the states nobody watches happen: a shell killed
 * mid-command, a command whose start marker never arrives, a background tab
 * finishing while another is on screen.
 *
 * `pty-command-started` is new — the backend parsed OSC 133's "C" marker from
 * the beginning and dropped it (`manager.rs`, the arm that used to read
 * `PromptStart | CommandStart | CommandExecuted => {}`). These cases pin the
 * frontend half; `src-tauri` pins the marker itself.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { tabActivity, activityLabel, hasActivityDot, groupActivity } from '../../src/lib/tabActivity.js';

const { useTerminalStore: S } = await import('../../src/stores/terminalStore.js');

/** The store's own listeners, driven the way the backend would drive them. */
let emit;

describe('What a tab is doing, decided in one place', () => {
  test('TA-01: the four states, in the order that matters', () => {
    assert.equal(tabActivity({}), 'idle');
    assert.equal(tabActivity({ running: true }), 'running');
    assert.equal(tabActivity({ lastExitCode: 1 }), 'failed');
    assert.equal(tabActivity({ lastExitCode: 0 }), 'idle');

    // A new command outranks the last one's verdict: the red dot is about a
    // command that has been replaced.
    assert.equal(tabActivity({ running: true, lastExitCode: 1 }), 'running');

    // And a dead shell outranks whatever it was doing when it died, or every
    // killed terminal would pulse forever.
    assert.equal(tabActivity({ running: true, exited: { code: 137 } }), 'exited');
    assert.equal(tabActivity({ lastExitCode: 1, exited: { code: 0 } }), 'exited');
  });

  test('TA-02: nothing is missing, and nothing is invented', () => {
    assert.equal(tabActivity(null), 'idle');
    assert.equal(tabActivity(undefined), 'idle');
    // A tab restored from a saved layout has no exit code yet.
    assert.equal(tabActivity({ lastExitCode: null }), 'idle');
    assert.equal(tabActivity({ lastExitCode: undefined }), 'idle');
  });

  test('TA-03: only running and failed are worth a dot', () => {
    assert.equal(hasActivityDot({ running: true }), true);
    assert.equal(hasActivityDot({ lastExitCode: 2 }), true);
    assert.equal(hasActivityDot({}), false);
    // An exited shell already reads as dead — the name is struck through.
    // A second signal for the same fact is noise.
    assert.equal(hasActivityDot({ exited: { code: 0 } }), false);
  });

  test('TA-13: a group answers for every terminal inside it', () => {
    // A group is a whole screen — switching replaces the arrangement — so a
    // failure in one you are not looking at is invisible without this.
    assert.equal(groupActivity([]), 'idle');
    assert.equal(groupActivity([{}, {}]), 'idle');
    assert.equal(groupActivity([{}, { lastExitCode: 1 }]), 'failed');
    assert.equal(groupActivity([{ lastExitCode: 1 }, { running: true }]), 'running');
    // Dead shells are not an alarm; the tabs inside already say so each.
    assert.equal(groupActivity([{ exited: { code: 0 } }, { exited: { code: 1 } }]), 'idle');
  });

  test('TA-04: the state is also available as words, for the tooltip', () => {
    // A colour is not something a screen reader can read out, and both
    // renderers put this in the element's `title`.
    assert.equal(activityLabel({ running: true }), 'running a command');
    assert.equal(activityLabel({ lastExitCode: 127 }), 'the last command exited with code 127');
    assert.equal(activityLabel({ exited: { code: 137 } }), 'this shell has exited (code 137)');
    assert.equal(activityLabel({ exited: { code: null } }), 'this shell has exited');
    assert.equal(activityLabel({}), '');
  });
});

describe('The indicator follows the shell', () => {
  beforeEach(async () => {
    S.setState({
      tabs: [
        { id: 'a', sessionId: 'sess-a', title: 'A', blocks: [], running: false, lastExitCode: null },
        { id: 'b', sessionId: 'sess-b', title: 'B', blocks: [], running: false, lastExitCode: null },
      ],
      activeTabId: 'a',
    });
    await S.getState().attachListeners();
    const { mockBridge } = await import('../../src/lib/ipc.js');
    emit = (event, payload) => mockBridge.emit(event, payload);
  });

  const tab = (id) => S.getState().tabs.find((t) => t.id === id);

  test('TA-05: a command starting lights its own tab and no other', async () => {
    await emit('pty-command-started', { session_id: 'sess-a' });
    assert.equal(tabActivity(tab('a')), 'running');
    assert.equal(tabActivity(tab('b')), 'idle', 'the other terminal is not running anything');
  });

  test('TA-06: finishing clears it, and a non-zero code is kept', async () => {
    await emit('pty-command-started', { session_id: 'sess-a' });
    await emit('pty-command-done', { session_id: 'sess-a', exit_code: 1 });
    assert.equal(tabActivity(tab('a')), 'failed');
    assert.equal(tab('a').running, false);

    await emit('pty-command-started', { session_id: 'sess-a' });
    await emit('pty-command-done', { session_id: 'sess-a', exit_code: 0 });
    assert.equal(tabActivity(tab('a')), 'idle');
  });

  test('TA-07: starting the next command drops the last one’s red dot', async () => {
    await emit('pty-command-done', { session_id: 'sess-a', exit_code: 2 });
    assert.equal(tabActivity(tab('a')), 'failed');
    await emit('pty-command-started', { session_id: 'sess-a' });
    assert.equal(tabActivity(tab('a')), 'running');
    assert.equal(tab('a').lastExitCode, null, 'the old verdict describes nothing still true');
  });

  test('TA-08: a shell killed mid-command does not pulse forever', async () => {
    // The whole failure mode: no "D" marker ever arrives for a shell that was
    // killed, so `pty-exit` is the only thing that can stop it.
    await emit('pty-command-started', { session_id: 'sess-b' });
    assert.equal(tabActivity(tab('b')), 'running');
    await emit('pty-exit', { session_id: 'sess-b', exit_code: 137 });
    assert.equal(tab('b').running, false);
    assert.equal(tabActivity(tab('b')), 'exited');
  });

  test('TA-09: a background terminal finishing is visible from the other one', async () => {
    // This is the feature, stated as a test: `a` is on screen, `b` is not, and
    // b's failure has to be legible without switching to it.
    await emit('pty-command-started', { session_id: 'sess-b' });
    assert.equal(tabActivity(tab('b')), 'running');
    await emit('pty-command-done', { session_id: 'sess-b', exit_code: 1 });
    assert.equal(S.getState().activeTabId, 'a', 'nothing may steal focus');
    assert.equal(tabActivity(tab('b')), 'failed');
    assert.equal(activityLabel(tab('b')), 'the last command exited with code 1');
  });

  test('TA-10: a repeated start does not rebuild the tab list', async () => {
    // Every new `tabs` array re-renders the side bar, every pane and the
    // status bar — the reason the pty-output handler is written the way it is.
    await emit('pty-command-started', { session_id: 'sess-a' });
    const before = S.getState().tabs;
    await emit('pty-command-started', { session_id: 'sess-a' });
    assert.equal(S.getState().tabs, before, 'an unchanged state must be the same object');
  });

  test('TA-11: an event for a session nothing owns changes nothing', async () => {
    const before = S.getState().tabs;
    await emit('pty-command-started', { session_id: 'sess-gone' });
    await emit('pty-command-started', {});
    assert.equal(S.getState().tabs, before);
  });

  test('TA-12: teardown — leave the store as the next suite expects it', () => {
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null });
    assert.equal(S.getState().tabs.length, 0);
  });
});
