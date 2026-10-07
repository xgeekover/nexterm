/**
 * A terminal whose shell has exited says so once and takes Enter to start a
 * new one (src/lib/shellExit.js, the store's `restartShell`).
 *
 * Reported from Windows on 2026-10-07: after quitting OpenCode with Ctrl+C
 * in cmd, a terminal sometimes printed "[NexTerm] PTY session not found:
 * pty-5" for every key and took no commands. cmd itself had exited (the
 * backend drops a session only when its shell ends; why cmd went is not
 * known yet), and each keystroke after the one easily-missed
 * "[process exited]" line went to a session that was gone. The mock bridge answers a write to a missing session with the
 * backend's own words, and `pty_kill` emits the exit as the backend does.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { CTRL_C_EXIT, describeExitCode, exitNotice, restartsShell, sessionIsGone } from '../../src/lib/shellExit.js';
import { useTerminalStore as T } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';

const tabById = (id) => T.getState().tabs.find((t) => t.id === id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `fn` with every invoke recorded (and optionally some answered by `answer`). */
async function recording(fn, answer = null) {
  const original = mockBridge.invoke;
  const calls = [];
  mockBridge.invoke = async function (command, args, ...rest) {
    calls.push({ command, args: { ...args } });
    if (answer) {
      const handled = await answer(command, args, calls);
      if (handled !== undefined) return handled.value;
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(calls);
  } finally {
    mockBridge.invoke = original;
  }
  return calls;
}

/** `fn` with the terminal notices captured instead of drawn. */
async function capturingNotices(fn) {
  const notices = [];
  const sink = (tabId, message) => {
    notices.push({ tabId, message });
    return true;
  };
  const off = setTerminalNoticeSink(sink);
  try {
    await fn(notices);
  } finally {
    off();
  }
  return notices;
}

async function liveTerminal() {
  await T.getState().init();
  const tab = await T.getState().createTab();
  assert.ok(tab, 'setup: a terminal');
  return tabById(tab.id);
}

const exits = (tab, code) => mockBridge.emit('pty-exit', { session_id: tab.sessionId, exit_code: code });

describe('The words for a shell that has exited', () => {
  test('SR-01: an exit code reads as Windows documents it, and Ctrl+C\'s is named', () => {
    assert.equal(CTRL_C_EXIT, 3221225786);
    assert.equal(describeExitCode(3221225786), '3221225786 (0xC000013A, ended by Ctrl+C)');
    assert.equal(describeExitCode(-1073741510), '3221225786 (0xC000013A, ended by Ctrl+C)', 'PowerShell reports it signed');
    assert.equal(describeExitCode(3221225477), '3221225477 (0xC0000005)', 'an access violation in hex too');
    assert.equal(describeExitCode(0), '0');
    assert.equal(describeExitCode(1), '1');
    assert.equal(describeExitCode(130), '130');
    for (const none of [null, undefined, NaN, 1.5, '1']) assert.equal(describeExitCode(none), null);
    const notice = exitNotice(3221225786);
    assert.ok(notice.includes('[process exited with code 3221225786 (0xC000013A, ended by Ctrl+C)]'));
    assert.ok(notice.includes('Press Enter to start a new shell in this terminal.'));
    assert.ok(exitNotice(null).includes('[process exited]'), 'no code, no number');
  });

  test('SR-02: Enter starts a new shell; a gone session is recognised by the backend\'s words', () => {
    for (const enter of ['\r', '\n', '\r\n']) assert.equal(restartsShell(enter), true);
    for (const other of ['a', 'ls\r', '\x03', '\x1b[A', ' ', '']) assert.equal(restartsShell(other), false, JSON.stringify(other));
    assert.equal(sessionIsGone('PTY session not found: pty-5'), true);
    assert.equal(sessionIsGone('PTY session is closed: pty-5'), true);
    assert.equal(sessionIsGone('PTY session is no longer accepting input: pty-5'), true);
    assert.equal(sessionIsGone('2048 bytes were not sent: the program reading this terminal takes at most 1023 bytes'), false);
    assert.equal(sessionIsGone(undefined), false);
  });
});

describe('A terminal whose shell has exited', () => {
  test('SR-03: keys after the exit go nowhere and say nothing', async () => {
    const tab = await liveTerminal();
    try {
      await exits(tab, 3221225786);
      assert.deepEqual(tabById(tab.id).exited, { code: 3221225786 });
      const notices = await capturingNotices(async () => {
        const calls = await recording(async () => {
          for (const key of ['l', 's', '\x03', '\x1b[A']) await T.getState().writeRaw(tab.id, key);
        });
        assert.deepEqual(calls.filter((c) => c.command === 'pty_write'), [], 'nothing was sent to a session that is gone');
      });
      assert.deepEqual(notices, [], 'and no line per key');
    } finally {
      await T.getState().closeTab(tab.id);
    }
  });

  test('SR-04: Enter starts a new shell in its place — same shell, same directory, a fresh size', async () => {
    const tab = await liveTerminal();
    try {
      T.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, cwd: '/workspace/src', shell: '/bin/zsh', lastSize: '120x40', agent: { kind: 'opencode', sessionId: null, startedAt: 1, title: null }, commandLine: 'opencode' }
            : t
        ),
      }));
      await exits(tab, 3221225786);
      const old = tabById(tab.id).sessionId;
      const calls = await recording(async () => {
        await T.getState().writeRaw(tab.id, '\r');
      });
      assert.deepEqual(calls.find((c) => c.command === 'pty_kill')?.args, { session_id: old }, 'the old session ended first');
      const spawn = calls.find((c) => c.command === 'pty_spawn');
      assert.ok(spawn, 'a new shell was started');
      assert.equal(spawn.args.shell, '/bin/zsh');
      assert.equal(spawn.args.cwd, '/workspace/src');
      assert.equal(calls.some((c) => c.command === 'pty_write'), false, 'the Enter itself is not typed into the new shell');
      const now = tabById(tab.id);
      assert.notEqual(now.sessionId, old);
      assert.equal(now.exited, null);
      assert.equal(now.lastSize, null, 'resizePty must not think the new PTY already has the old size');
      assert.equal(now.agent, null);
      assert.equal(now.commandLine, null);

      // The new shell takes keys.
      const typed = await recording(async () => {
        await T.getState().writeRaw(tab.id, 'echo hi\r');
      });
      assert.deepEqual(typed.filter((c) => c.command === 'pty_write').map((c) => c.args.session_id), [now.sessionId]);
    } finally {
      await T.getState().closeTab(tab.id);
    }
  });

  test('SR-05: a write that finds the session gone before its exit arrives says so once, in words', async () => {
    const tab = await liveTerminal();
    try {
      // The backend lost the session; no exit event has come.
      mockBridge.ptySessions.delete(tab.sessionId);
      const notices = await capturingNotices(async () => {
        await T.getState().writeRaw(tab.id, 'x');
        await T.getState().writeRaw(tab.id, 'y');
        await T.getState().writeRaw(tab.id, 'z');
      });
      assert.deepEqual(notices.map((n) => n.message), ['The shell in this terminal has stopped. Press Enter to start a new one.']);
      assert.ok(!notices.some((n) => /PTY session/.test(n.message)), 'not the backend\'s words, once per key');
      assert.deepEqual(tabById(tab.id).exited, { code: null });
      const calls = await recording(async () => {
        await T.getState().writeRaw(tab.id, '\r');
      });
      assert.ok(calls.some((c) => c.command === 'pty_spawn'), 'Enter starts a new shell here too');
      assert.equal(tabById(tab.id).exited, null);
    } finally {
      await T.getState().closeTab(tab.id);
    }
  });

  test('SR-06: Enter pressed twice while the new shell starts starts one shell', async () => {
    const tab = await liveTerminal();
    try {
      await exits(tab, 1);
      const calls = await recording(
        async () => {
          await Promise.all([T.getState().writeRaw(tab.id, '\r'), T.getState().writeRaw(tab.id, '\r')]);
        },
        async (command) => {
          if (command === 'pty_spawn') await sleep(20);
          return undefined;
        }
      );
      assert.equal(calls.filter((c) => c.command === 'pty_spawn').length, 1);
    } finally {
      await T.getState().closeTab(tab.id);
    }
  });

  test('SR-07: a new shell that cannot start leaves the terminal exited, says why, and the next Enter tries again', async () => {
    const tab = await liveTerminal();
    try {
      await exits(tab, 1);
      const notices = await capturingNotices(async () => {
        await recording(
          async () => {
            assert.equal(await T.getState().restartShell(tab.id), false);
          },
          async (command) => (command === 'pty_spawn' ? Promise.reject(new Error('Failed to spawn shell')) : undefined)
        );
      });
      assert.ok(notices.some((n) => n.message.startsWith('Could not start a new shell')), JSON.stringify(notices));
      assert.ok(tabById(tab.id).exited, 'still exited');
      await T.getState().writeRaw(tab.id, '\r');
      assert.equal(tabById(tab.id).exited, null, 'the next Enter worked');
    } finally {
      await T.getState().closeTab(tab.id);
    }
  });

  test('SR-08: a terminal closed while its new shell starts takes that shell with it', async () => {
    const tab = await liveTerminal();
    await exits(tab, 1);
    let spawned = null;
    const calls = await recording(
      async () => {
        const restart = T.getState().restartShell(tab.id);
        await sleep(5);
        await T.getState().closeTab(tab.id);
        await restart;
        await sleep(5);
      },
      async (command, args, seen) => {
        if (command === 'pty_spawn') {
          await sleep(20);
          return undefined;
        }
        if (command === 'pty_kill' && spawned === null) {
          const spawn = seen.find((c) => c.command === 'pty_spawn');
          if (spawn) spawned = true;
        }
        return undefined;
      }
    );
    assert.equal(tabById(tab.id), undefined);
    const kills = calls.filter((c) => c.command === 'pty_kill').map((c) => c.args.session_id);
    const spawnedIds = [...mockBridge.ptySessions.keys()];
    assert.ok(kills.length >= 2, `the old session and the new one were both ended: ${JSON.stringify(kills)}`);
    assert.ok(!spawnedIds.some((id) => kills.includes(id)), 'no session the test ended is still alive');
  });

  test('SR-09: wired — the terminal prints the exit notice, also for a tab first shown after its shell exited', () => {
    const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(registry, /entry\.term\.write\(exitNotice\(/, 'on the exit event');
    assert.match(registry, /if \(exited && sessionId\) \{\s*entry\.exited = true;\s*term\.write\(exitNotice\(/, 'and when the tab is first shown');
  });

  // Found in review (R3): closing reads the tab's session before it awaits the
  // kill, so a new shell the restart installed meanwhile went on running with
  // no tab to show it.
  const leaves = (node) => (node.children ? node.children.flatMap(leaves) : [node]);
  for (const [id, how, setup] of [
    [
      'SR-10',
      'closed',
      async () => {
        const tab = await liveTerminal();
        return { tab, close: () => T.getState().closeTab(tab.id) };
      },
    ],
    [
      'SR-11',
      'taken with its pane',
      async () => {
        await T.getState().init();
        const group = T.getState().getActiveGroup();
        const paneId = await T.getState().splitPane(group.activePaneId, 'horizontal', group.id);
        const pane = leaves(T.getState().groups.find((g) => g.id === group.id).tree).find((l) => l.id === paneId);
        assert.equal(pane?.tabIds.length, 1, 'setup: a pane holding only this terminal');
        return { tab: tabById(pane.tabIds[0]), close: () => T.getState().closePane(paneId, group.id) };
      },
    ],
  ]) {
    test(`${id}: a terminal ${how} while it is still ending its old shell takes the new one with it`, async () => {
      const { tab, close } = await setup();
      await exits(tab, 1);
      const old = tab.sessionId;
      const before = new Set(mockBridge.ptySessions.keys());
      const calls = await recording(
        async () => {
          const restart = T.getState().writeRaw(tab.id, '\r');
          await sleep(35);
          // The restart's spawn resolves while this close still waits on its kill.
          const closing = close();
          await restart;
          await closing;
          // A shell ended in passing is ended without waiting for it.
          await sleep(60);
        },
        async (command) => {
          if (command === 'pty_kill') await sleep(30);
          if (command === 'pty_spawn') await sleep(10);
          return undefined;
        }
      );
      assert.equal(tabById(tab.id), undefined, 'the terminal is gone');
      assert.equal(calls.filter((c) => c.command === 'pty_spawn').length, 1, 'setup: a new shell was started');
      const alive = [...mockBridge.ptySessions.keys()];
      assert.ok(!alive.includes(old), 'the old session is gone');
      const started = alive.filter((sid) => !before.has(sid));
      const orphans = started.filter((sid) => !T.getState().tabs.some((t) => t.sessionId === sid));
      assert.deepEqual(orphans, [], `no shell runs without a terminal: ${JSON.stringify(orphans)}`);
    });
  }
});
