/**
 * The status bar has to be true.
 *
 * It used to render a git branch of "main" and a shell of "zsh" regardless of
 * what was running — on a Windows machine in cmd.exe, wrong twice over. These
 * cases pin the two halves of the replacement: the per-platform conventions,
 * and the shell's own verdict on the last command.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import {
  buildStatusItems,
  platformOf,
  lineEndingFor,
  encodingFor,
  shellLabel,
  cwdLabel,
} from '../../src/lib/statusInfo.js';

// No localStorage shim, and no init(): these cases never persist anything.
// Swapping the global at module scope is what broke the terminal-groups
// suite — with top-level await, a module that yields mid-evaluation comes
// back to find another file has replaced the global underneath it.
const { useTerminalStore: S } = await import('../../src/stores/terminalStore.js');

const textOf = (items, id) => items.find((i) => i.id === id)?.text ?? null;

describe('Status bar: per-platform conventions', () => {
  test('SB-01: the platform key is read from whatever the backend calls itself', () => {
    assert.equal(platformOf('darwin'), 'macos');
    assert.equal(platformOf('macos'), 'macos');
    assert.equal(platformOf('windows'), 'windows');
    assert.equal(platformOf('win32'), 'windows');
    assert.equal(platformOf('linux'), 'linux');
    assert.equal(platformOf(''), 'unknown');
  });

  test('SB-02: line endings and encoding differ where the platforms differ', () => {
    assert.equal(lineEndingFor('windows'), 'CRLF');
    assert.equal(lineEndingFor('macos'), 'LF');
    assert.equal(lineEndingFor('linux'), 'LF');

    // Only Windows has a code page worth naming — a console still on 949
    // renders UTF-8 as mojibake, and that is the first thing to check.
    assert.equal(encodingFor('windows', { codePage: 949 }), 'UTF-8 (949)');
    assert.equal(encodingFor('windows'), 'UTF-8');
    assert.equal(encodingFor('macos', { codePage: 949 }), 'UTF-8', 'a code page means nothing off Windows');
  });

  test('SB-03: a shell is called what its own platform calls it', () => {
    assert.equal(shellLabel('C:\\Windows\\System32\\cmd.exe', 'windows'), 'Command Prompt');
    assert.equal(shellLabel('powershell.exe', 'windows'), 'Windows PowerShell');
    assert.equal(shellLabel('pwsh.exe', 'windows'), 'PowerShell');
    assert.equal(shellLabel('/bin/zsh', 'macos'), 'zsh');
    assert.equal(shellLabel('/usr/bin/fish', 'linux'), 'fish');
    // "default" means the platform's own, and each platform's own differs.
    assert.equal(shellLabel('default', 'windows'), 'Command Prompt');
    assert.equal(shellLabel('default', 'macos'), 'zsh');
    assert.equal(shellLabel('default', 'linux'), 'bash');
  });

  test('SB-04: `~` is a unix idea, so Windows keeps its real path', () => {
    assert.equal(
      cwdLabel('/Users/me/project', { platform: 'macos', homeDir: '/Users/me' }),
      '~/project'
    );
    const win = cwdLabel('C:\\Users\\me\\project', { platform: 'windows', homeDir: 'C:\\Users\\me' });
    assert.equal(win.includes('~'), false, `Windows must not show a tilde: ${win}`);
    assert.ok(win.includes('project'), `but it must still show where you are: ${win}`);
  });

  test('SB-05: the three platforms produce visibly different bars', () => {
    const common = { workspacePath: '/p', cwd: '/p', cols: 80, rows: 24, terminalCount: 1, groupCount: 1 };
    const mac = buildStatusItems({ ...common, os: 'macos', shell: '/bin/zsh' });
    const linux = buildStatusItems({ ...common, os: 'linux', shell: '/bin/bash' });
    const win = buildStatusItems({
      ...common,
      os: 'windows',
      shell: 'pwsh.exe',
      codePage: 949,
      workspacePath: 'C:\\p',
      cwd: 'C:\\p',
    });

    assert.equal(textOf(mac.right, 'eol'), 'LF');
    assert.equal(textOf(linux.right, 'eol'), 'LF');
    assert.equal(textOf(win.right, 'eol'), 'CRLF');

    assert.equal(textOf(mac.right, 'shell'), 'zsh');
    assert.equal(textOf(linux.right, 'shell'), 'bash');
    assert.equal(textOf(win.right, 'shell'), 'PowerShell');

    assert.equal(textOf(win.right, 'encoding'), 'UTF-8 (949)');
    assert.equal(textOf(mac.right, 'encoding'), 'UTF-8');

    assert.equal(textOf(mac.right, 'platform'), 'macOS');
    assert.equal(textOf(win.right, 'platform'), 'Windows');

    const signature = (b) => b.right.map((i) => i.text).join('|');
    assert.notEqual(signature(mac), signature(win), 'macOS and Windows must not read the same');
    assert.notEqual(signature(linux), signature(win), 'Linux and Windows must not read the same');
  });

  test('SB-06: nothing is invented when there is nothing to show', () => {
    const bar = buildStatusItems({ os: 'macos' });
    // No cwd, no size, no terminals — and no git branch, which is the item
    // that used to say "main" on every machine whether or not it was a repo.
    assert.equal(bar.left.find((i) => i.id === 'cwd'), undefined);
    assert.equal(bar.right.find((i) => i.id === 'size'), undefined);
    assert.equal(bar.right.find((i) => i.id === 'terminals'), undefined);
    assert.equal([...bar.left, ...bar.right].some((i) => /branch|main/i.test(i.text)), false);
  });

  test('SB-07: a failed command and a dead shell are both called out', () => {
    const failed = buildStatusItems({ os: 'linux', cwd: '/p', lastExitCode: 127 });
    const item = failed.left.find((i) => i.id === 'exit-code');
    assert.ok(item, 'a non-zero exit must be shown');
    assert.equal(item.kind, 'error', 'and shown as an error');
    assert.ok(item.text.includes('127'), `naming the code: ${item.text}`);

    assert.equal(
      buildStatusItems({ os: 'linux', cwd: '/p', lastExitCode: 0 }).left.find((i) => i.id === 'exit-code'),
      undefined,
      'a successful command says nothing'
    );

    const dead = buildStatusItems({ os: 'linux', cwd: '/p', shellExited: true, lastExitCode: 0 });
    assert.equal(dead.left.find((i) => i.id === 'exited')?.kind, 'error');
  });
});

describe('Status bar: the exit code comes from the shell, not from a block', () => {
  // Deliberately does NOT call init(): the store is a module singleton shared
  // with every other suite, and spinning it up here (PTYs, persistence timers,
  // id counters) corrupted the terminal-groups migration cases. Only the
  // handful of fields this behaviour needs are planted.
  const SESSION = 'sb-session-1';
  const TAB = 'sb-tab-1';

  beforeEach(async () => {
    await S.getState().attachListeners();
    S.setState({
      tabs: [
        {
          id: TAB,
          title: 'Terminal 1',
          sessionId: SESSION,
          cwd: '/workspace',
          blocks: [],
          activePrompt: '',
        },
      ],
      activeTabId: TAB,
    });
  });

  const tab = () => S.getState().tabs.find((t) => t.id === TAB);

  test('SB-08: a command typed straight into the terminal still records its code', async () => {
    const { mockBridge } = await import('../../src/lib/ipc.js');

    // Nothing called executeCommand, so there is no block — the normal case
    // for anyone who just types. Reading the code off `blocks`, as the bar
    // first did, found nothing here.
    assert.equal(tab().blocks.length, 0, 'precondition: no block is tracking this command');

    await mockBridge.emit('pty-command-done', { session_id: SESSION, exit_code: 127 });
    assert.equal(tab().lastExitCode, 127, 'the shell’s verdict is recorded on the tab');

    const failed = buildStatusItems({ os: 'macos', cwd: '/workspace', lastExitCode: tab().lastExitCode });
    assert.equal(failed.left.find((i) => i.id === 'exit-code')?.kind, 'error', 'and the bar shows it');

    await mockBridge.emit('pty-command-done', { session_id: SESSION, exit_code: 0 });
    assert.equal(tab().lastExitCode, 0, 'replaced by the next command’s verdict');
    assert.equal(
      buildStatusItems({ os: 'macos', cwd: '/workspace', lastExitCode: tab().lastExitCode })
        .left.find((i) => i.id === 'exit-code'),
      undefined,
      'and the bar goes quiet again'
    );
  });

  test('SB-09: another terminal’s result never lands on this one', async () => {
    const { mockBridge } = await import('../../src/lib/ipc.js');
    await mockBridge.emit('pty-command-done', { session_id: 'some-other-session', exit_code: 1 });
    assert.equal(tab().lastExitCode, undefined, 'an unrelated session changes nothing here');
  });

  test('SB-10: teardown — leave the store as the next suite expects it', () => {
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    assert.ok(true);
  });
});
