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
import { invoke, listen, isTauri, mockBridge, pathKinds, revealInFileManager } from '../../src/lib/ipc.js';
import { readFileSync } from 'node:fs';

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

// The names in a terminal's output that Cmd/Ctrl+click shows in the file
// manager (src/lib/outputPaths.js). The mock answers by the backend's rules
// (src-tauri/src/fs/reveal.rs) — when the two disagree the mock wins the test
// and the user loses.
describe('IPC: fs_path_kinds and fs_reveal_path', () => {
  test('inside Tauri, the answer of the backend or its rejection — never one of the mock', async () => {
    await pretendingToBeInTauri(async () => {
      // The mock knows this folder; a fallback would answer 'dir'.
      await assert.rejects(() => pathKinds(['/workspace/src']));
      // And would record a reveal that never happened.
      const before = mockBridge.revealed.length;
      await assert.rejects(() => revealInFileManager('/workspace/src'));
      assert.equal(mockBridge.revealed.length, before);
    });
  });

  test('the mock answers kinds as the backend does: absolute, local, at most a row of them', async () => {
    const kinds = await pathKinds([
      '/workspace/src',
      '/workspace/README.md',
      '/workspace/src/',
      '/workspace/nope',
      'src',
      '',
      '\\\\host\\share\\x',
      '//host/share/x',
      '\\\\?\\UNC\\host\\share',
      `/workspace/${'x'.repeat(4096)}`,
      '/',
    ]);
    assert.deepEqual(kinds, ['dir', 'file', 'dir', null, null, null, null, null, null, null, 'dir']);
    assert.equal((await pathKinds(Array(64).fill('/workspace'))).length, 64);
    await assert.rejects(() => pathKinds(Array(65).fill('/workspace')), /At most 64/);
  });

  test('the mock refuses a reveal the backend refuses, and records the rest', async () => {
    const before = mockBridge.revealed.length;
    await revealInFileManager('/workspace/src');
    assert.deepEqual(mockBridge.revealed.slice(before), [{ path: '/workspace/src', kind: 'dir' }]);
    await assert.rejects(() => revealInFileManager('//host/share/x'), /another machine/);
    await assert.rejects(() => revealInFileManager('src'), /Not an absolute path/);
    await assert.rejects(() => revealInFileManager('/workspace/gone.txt'), /Cannot show/);
    assert.equal(mockBridge.revealed.length, before + 1);
  });
});

// The open folder's `.nexterm/commands.json` (src-tauri/src/fs/project_commands.rs).
// The mock and the backend are held to one shape and one set of words here,
// read from both sources: what the palette is built against in the browser
// suites is what the app gets.
describe('IPC: project_commands_read', () => {
  /** A source file of the repository, line endings as LF whatever the checkout made them. */
  const source = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const rust = () => source('../../src-tauri/src/fs/project_commands.rs');
  /** The backend's `const NAME: &str = "…";` sentences, by name, `\u{…}` read as Rust reads it. */
  const rustSentences = () => Object.fromEntries(
    [...rust().matchAll(/^const (\w+): &str = "([^"]*)";$/gm)].map(([, name, text]) => [
      name,
      text.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))),
    ])
  );

  test('inside Tauri, the backend answers or rejects — never the mock, which reads nothing', async () => {
    const before = mockBridge.projectCommandsReads.length;
    await pretendingToBeInTauri(async () => {
      await assert.rejects(() => invoke('project_commands_read'));
    });
    assert.equal(mockBridge.projectCommandsReads.length, before);
  });

  test('registered, takes nothing from the webview, and reads on the blocking pool', () => {
    const main = source('../../src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::fs::project_commands_read,'), 'in generate_handler!');
    const commands = source('../../src-tauri/src/commands/fs.rs');
    assert.match(
      commands,
      /#\[tauri::command\(rename_all = "snake_case"\)\]\npub async fn project_commands_read\(state: State<'_, AppState>\) -> Result<fs::project_commands::ProjectCommandsFile, String> \{\n\s*let root = state\.workspace\.root\(\);\n\s*tauri::async_runtime::spawn_blocking\(move \|\| fs::project_commands::read\(root\.as_deref\(\)\)\)/
    );
  });

  test('four answers, told apart by `status`, each with only its own fields and the folder read — in the backend and in the mock', async () => {
    const source = rust();
    const start = source.indexOf('#[serde(tag = "status", rename_all = "lowercase")]\npub enum ProjectCommandsFile {\n');
    assert.ok(start >= 0, 'internally tagged by `status`, the variant names in lower case');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const variants = body
      .split('\n')
      .slice(2)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('///'));
    assert.deepEqual(variants, [
      'None {',
      '#[serde(skip_serializing_if = "Option::is_none")]',
      'root: Option<String>,',
      '},',
      'Refused { root: String, reason: String },',
      'Error { root: String, reason: String },',
      'Ok { root: String, text: String, sha256: String },',
    ]);

    const keys = (answer) => Object.keys(answer).sort();
    const forced = mockBridge.projectCommandsAnswer;
    try {
      mockBridge.projectCommandsAnswer = null;
      const none = await invoke('project_commands_read');
      assert.equal(none.status, 'none');
      assert.deepEqual(keys(none), ['root', 'status'], 'the mock always has a folder open');
      assert.equal(none.root, await invoke('fs_get_root'), 'named as fs_get_root names it');
      mockBridge.files.set('/workspace/.nexterm/commands.json', '{}');
      assert.deepEqual(keys(await invoke('project_commands_read')), ['root', 'sha256', 'status', 'text']);
      mockBridge.files.set('/workspace/.nexterm/commands.json', 'x'.repeat(262145));
      assert.deepEqual(keys(await invoke('project_commands_read')), ['reason', 'root', 'status']);
    } finally {
      mockBridge.files.delete('/workspace/.nexterm/commands.json');
      mockBridge.projectCommandsAnswer = forced;
    }
  });

  test('the mock refuses in the backend\'s own words, at the backend\'s cap', async () => {
    assert.match(rust(), /^pub const MAX_BYTES: u64 = 256 \* 1024;$/m);
    assert.match(source('../../src/lib/ipc.js'), /^const MOCK_PROJECT_COMMANDS_MAX_BYTES = 256 \* 1024;$/m);
    const said = rustSentences();
    for (const name of ['DIR_NOT_A_FOLDER', 'NOT_A_FILE', 'TOO_LARGE', 'NOT_UTF8', 'OFF_MACHINE']) {
      assert.equal(typeof said[name], 'string', `the backend says ${name} in one sentence`);
    }
    const dir = '/workspace/.nexterm';
    const file = `${dir}/commands.json`;
    const reasonFor = async (arrange, undo) => {
      arrange();
      try {
        return (await invoke('project_commands_read')).reason;
      } finally {
        undo();
      }
    };
    assert.equal(
      await reasonFor(() => mockBridge.files.set(dir, '{}'), () => mockBridge.files.delete(dir)),
      said.DIR_NOT_A_FOLDER
    );
    assert.equal(
      await reasonFor(() => mockBridge.directories.add(file), () => mockBridge.directories.delete(file)),
      said.NOT_A_FILE
    );
    assert.equal(
      await reasonFor(() => mockBridge.files.set(file, 'x'.repeat(262145)), () => mockBridge.files.delete(file)),
      said.TOO_LARGE
    );
  });
});
