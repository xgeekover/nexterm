/**
 * Opening a terminal with a particular shell.
 *
 * The Settings window used to offer a fixed list per platform — "PowerShell 7"
 * on every Windows box whether or not it was installed, and never Git Bash or
 * WSL. The list is found on the real machine now (`src-tauri/src/pty/
 * shells.rs`, which has its own cases for "everything offered exists").
 *
 * What is pinned here is the half that lives in the frontend: a terminal
 * remembers the shell it was actually given, so the status bar can name the
 * one you are looking at rather than the global setting — which, once
 * terminals may differ, would be right for at most one of them.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';

const { useTerminalStore: S } = await import('../../src/stores/terminalStore.js');
const { useSettingsStore } = await import('../../src/stores/settingsStore.js');

const tabs = () => S.getState().tabs;
const last = () => tabs()[tabs().length - 1];

describe('Terminal profiles', () => {
  beforeEach(async () => {
    await S.getState().init();
  });

  test('TP-01: a terminal remembers the shell it was actually given', async () => {
    await S.getState().createTab({ shell: '/bin/bash' });
    assert.equal(last().shell, '/bin/bash');
  });

  test('TP-02: without a profile it takes the default setting', async () => {
    useSettingsStore.getState().setSetting('terminalDefaultShell', '/usr/local/bin/fish');
    await S.getState().createTab();
    assert.equal(last().shell, '/usr/local/bin/fish');
    useSettingsStore.getState().setSetting('terminalDefaultShell', 'default');
  });

  test('TP-03: a profile beats the default setting', async () => {
    useSettingsStore.getState().setSetting('terminalDefaultShell', '/bin/zsh');
    await S.getState().createTab({ shell: '/bin/bash' });
    assert.equal(last().shell, '/bin/bash', 'the terminal asked for bash');
    useSettingsStore.getState().setSetting('terminalDefaultShell', 'default');
  });

  test('TP-04: terminals in one window may differ', async () => {
    // The reason the status bar had to stop reading the global setting.
    await S.getState().createTab({ shell: '/bin/bash' });
    const bashTab = last();
    await S.getState().createTab({ shell: '/bin/zsh' });
    const zshTab = last();
    assert.equal(bashTab.shell, '/bin/bash');
    assert.equal(zshTab.shell, '/bin/zsh');
    assert.notEqual(bashTab.shell, zshTab.shell);
  });

  test('TP-05: duplicating keeps the shell, not just the directory', async () => {
    // A copy of a Git Bash terminal that opens PowerShell is not a copy.
    await S.getState().createTab({ shell: '/bin/bash' });
    const source = last();
    await S.getState().duplicateTab(source.id);
    assert.equal(last().shell, '/bin/bash');
    assert.notEqual(last().id, source.id);
  });

  test('TP-06: teardown — leave the store as the next suite expects it', () => {
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null });
    assert.equal(tabs().length, 0);
  });
});
