/**
 * The IPC layer used to answer ANY failure from a Tauri command by returning
 * fabricated data from the in-browser mock bridge. Inside the packaged app
 * that turned a refused or failed command into a success: a save that could
 * not reach the disk reported OK and the user's edit was lost.
 *
 * The rule these tests pin down: only a failure to LOAD the bridge module may
 * fall back to the mock. A command's own rejection must reach the caller.
 */

import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { invoke, listen, isTauri, mockBridge } from '../../src/lib/ipc.js';

/** Run `fn` while the page claims to be inside Tauri, with no runtime behind it. */
async function pretendingToBeInTauri(fn) {
  globalThis.window = globalThis.window || {};
  const had = Object.prototype.hasOwnProperty.call(window, '__TAURI_INTERNALS__');
  const previous = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {};
  try {
    return await fn();
  } finally {
    if (had) window.__TAURI_INTERNALS__ = previous;
    else delete window.__TAURI_INTERNALS__;
  }
}

describe('IPC failure contract', () => {
  test('a failing command rejects instead of returning mock data', async () => {
    await pretendingToBeInTauri(async () => {
      assert.equal(isTauri(), true);
      // The mock happens to hold this file, so a fallback would look like a
      // perfectly ordinary success.
      await assert.rejects(() => invoke('fs_read_file', { path: '/workspace/README.md' }));
    });
  });

  test('a failing write rejects rather than reporting a save that never happened', async () => {
    await pretendingToBeInTauri(async () => {
      await assert.rejects(() =>
        invoke('fs_write_file', { path: '/workspace/README.md', content: 'x' })
      );
    });
  });

  test('a failing subscription rejects rather than silently simulating the stream', async () => {
    await pretendingToBeInTauri(async () => {
      await assert.rejects(() => listen('pty-output', () => {}));
    });
  });

  test('outside Tauri the mock still serves both invoke and listen', async () => {
    assert.equal(isTauri(), false);
    const content = await invoke('fs_read_file', { path: '/workspace/README.md' });
    assert.equal(typeof content, 'string');
    const unlisten = await listen('pty-output', () => {});
    assert.equal(typeof unlisten, 'function');
    unlisten();
  });

  test('an unknown command rejects on the mock path too', async () => {
    await assert.rejects(() => mockBridge.invoke('fs_definitely_not_a_command', {}), /Unknown IPC command/);
  });
});
