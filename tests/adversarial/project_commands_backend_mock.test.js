/**
 * `project_commands_read` as the browser mock answers it (src/lib/ipc.js) —
 * the open folder's `.nexterm/commands.json` for the command palette.
 *
 * The backend reads the file off the disk (src-tauri/src/fs/project_commands.rs,
 * whose own tests cover links, FIFOs, other machines and network drives). The
 * mock answers from its virtual tree in the same shapes and words, with a
 * SHA-256 that is the real one: the trust the palette keeps is keyed by it,
 * and a mock that made one up would let a suite pass on a hash the backend
 * never gives. Where the mock cannot be the disk — a link, a network drive, a
 * file that is not UTF-8 — a suite says what the backend answers with
 * `projectCommandsAnswer`.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { invoke, listen, mockBridge } from '../../src/lib/ipc.js';

const DIR = '/workspace/.nexterm';
const FILE = `${DIR}/commands.json`;

/** SHA-256 of `{}`, as `sha256sum` prints it. */
const EMPTY_OBJECT = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

const read = () => invoke('project_commands_read');

/** Run `fn` with the mock's `.nexterm` and its read state as the suite found them, put back after. */
async function aside(fn) {
  const hadRoot = Object.prototype.hasOwnProperty.call(mockBridge, 'root');
  const root = mockBridge.root;
  const forced = mockBridge.projectCommandsAnswer;
  const reads = mockBridge.projectCommandsReads.length;
  const clear = () => {
    for (const key of [...mockBridge.files.keys()]) if (key === DIR || key.startsWith(`${DIR}/`)) mockBridge.files.delete(key);
    for (const key of [...mockBridge.directories]) if (key === DIR || key.startsWith(`${DIR}/`)) mockBridge.directories.delete(key);
  };
  clear();
  try {
    return await fn();
  } finally {
    clear();
    mockBridge.projectCommandsAnswer = forced;
    mockBridge.projectCommandsReads.length = reads;
    if (hadRoot) mockBridge.root = root;
    else delete mockBridge.root;
  }
}

/** Run `fn` while the runtime has no Web Crypto, as a page served over plain http from another address has none. */
async function withoutWebCrypto(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(globalThis.crypto?.subtle, undefined, 'premise: no Web Crypto');
    return await fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    else delete globalThis.crypto;
  }
}

describe('Project commands: the mock backend', () => {
  test('PCM-01: no `.nexterm`, or no file in it, is none — and every read is counted with its folder', async () => {
    await aside(async () => {
      const before = mockBridge.projectCommandsReads.length;
      assert.deepEqual(await read(), { status: 'none', root: '/workspace' });
      mockBridge.directories.add(DIR);
      assert.deepEqual(await read(), { status: 'none', root: '/workspace' }, 'a folder with nothing in it');
      mockBridge.files.set(`${DIR}/other.json`, '{}');
      assert.deepEqual(await read(), { status: 'none', root: '/workspace' }, 'another file there');
      assert.deepEqual(mockBridge.projectCommandsReads.slice(before), ['/workspace', '/workspace', '/workspace']);
    });
  });

  test('PCM-02: the file written through the file commands is read with its real SHA-256, and says so with fs-change', async () => {
    await aside(async () => {
      const changes = [];
      const stop = await listen('fs-change', (payload) => changes.push(payload));
      try {
        await invoke('fs_create_dir', { path: DIR });
        await invoke('fs_write_file', { path: FILE, content: '{}' });
      } finally {
        stop();
      }
      assert.deepEqual(changes, [
        { path: DIR, kind: 'create_dir' },
        { path: FILE, kind: 'modify' },
      ]);
      assert.deepEqual(await read(), { status: 'ok', root: '/workspace', text: '{}', sha256: EMPTY_OBJECT });
      const text = '{"version":1,"commands":[{"name":"\u{d55c}\u{ae00}","command":"echo {{x}}"}]}';
      await invoke('fs_write_file', { path: FILE, content: text });
      assert.deepEqual(await read(), {
        status: 'ok',
        root: '/workspace',
        text,
        sha256: '7f9e9399e1681c913e8a296af6c7ed344447542bca200079094b6476417a6160',
      }, 'of the UTF-8 bytes, not of the UTF-16 the page holds');
    });
  });

  test('PCM-03: one byte-order mark is dropped from the text and kept in the hash', async () => {
    await aside(async () => {
      mockBridge.files.set(FILE, '\u{feff}{}');
      assert.deepEqual(await read(), {
        status: 'ok',
        root: '/workspace',
        text: '{}',
        sha256: 'aa25e978046d680ef8740d837e6de5bc1e2a2dc6089dbda1012544b538d53f65',
      });
      mockBridge.files.set(FILE, '\u{feff}\u{feff}{}');
      assert.deepEqual(await read(), {
        status: 'ok',
        root: '/workspace',
        text: '\u{feff}{}',
        sha256: '4f9d81b2dff7fd7f64fecdfdc6d0292ed97f903d46a3fd2a51260eab4655eaa8',
      }, 'only the first one is the mark');
    });
  });

  test('PCM-04: 256 KB of UTF-8 is read and a byte more is not, counted in bytes as the backend counts', async () => {
    await aside(async () => {
      mockBridge.files.set(FILE, 'a'.repeat(262144));
      const fits = await read();
      assert.equal(fits.status, 'ok');
      assert.equal(fits.text.length, 262144);
      assert.equal(fits.sha256, 'dd3dde87623d9a6b354c68c943d189c89c63652d945e7bbdf0986cae91a49521');
      const tooLarge = { status: 'error', root: '/workspace', reason: '`.nexterm/commands.json` is larger than 256 KB.' };
      mockBridge.files.set(FILE, 'a'.repeat(262145));
      assert.deepEqual(await read(), tooLarge);
      // 87 382 characters, three bytes each: 262 146 bytes.
      mockBridge.files.set(FILE, '\u{d55c}'.repeat(87382));
      assert.deepEqual(await read(), tooLarge, 'fewer characters than the cap, more bytes');
    });
  });

  test('PCM-05: a `.nexterm` that is a file, or a `commands.json` that is a folder, is an error in the backend\'s words', async () => {
    await aside(async () => {
      mockBridge.files.set(DIR, '{}');
      assert.deepEqual(await read(), { status: 'error', root: '/workspace', reason: '`.nexterm` is not a folder.' });
      mockBridge.files.delete(DIR);
      mockBridge.directories.add(FILE);
      assert.deepEqual(await read(), { status: 'error', root: '/workspace', reason: '`.nexterm/commands.json` is not a regular file.' });
      mockBridge.directories.delete(FILE);
      mockBridge.files.set(`${FILE}/inside.json`, '{}');
      assert.deepEqual(await read(), { status: 'error', root: '/workspace', reason: '`.nexterm/commands.json` is not a regular file.' }, 'a folder known only by a file in it');
    });
  });

  test('PCM-06: the file read is the one in the open folder', async () => {
    await aside(async () => {
      mockBridge.files.set(FILE, '{}');
      mockBridge.files.set('/workspace/tests/.nexterm/commands.json', 'abc');
      try {
        assert.equal(await invoke('fs_set_root', { path: '/workspace/tests' }), '/workspace/tests');
        assert.deepEqual(await read(), {
          status: 'ok',
          root: '/workspace/tests',
          text: 'abc',
          sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        });
        assert.equal(mockBridge.projectCommandsReads.at(-1), '/workspace/tests');
        mockBridge.files.delete('/workspace/tests/.nexterm/commands.json');
        assert.deepEqual(await read(), { status: 'none', root: '/workspace/tests' }, 'not the one above it');
      } finally {
        mockBridge.files.delete('/workspace/tests/.nexterm/commands.json');
      }
    });
  });

  test('PCM-07: `projectCommandsAnswer` answers instead — an answer, or one per folder, or null to read the file', async () => {
    await aside(async () => {
      mockBridge.files.set(FILE, '{}');
      const refused = () => ({ status: 'refused', reason: '`.nexterm` is a link \u{2014} NexTerm does not follow it.' });
      mockBridge.projectCommandsAnswer = refused();
      const answer = await read();
      assert.deepEqual(answer, { ...refused(), root: '/workspace' }, 'named for the folder read, as the backend names it');
      answer.reason = 'changed by the caller';
      assert.deepEqual(await read(), { ...refused(), root: '/workspace' }, 'each read gets its own copy');
      assert.deepEqual(mockBridge.projectCommandsAnswer, refused(), 'and the setting is left as it was');
      mockBridge.projectCommandsAnswer = { ...refused(), root: '/elsewhere' };
      assert.deepEqual(await read(), { ...refused(), root: '/elsewhere' }, 'a root of its own is kept: a stale answer');
      mockBridge.projectCommandsAnswer = { status: 'none', root: undefined };
      assert.deepEqual(await read(), { status: 'none' }, '`root: undefined` is no root: no folder open');
      const asked = [];
      mockBridge.projectCommandsAnswer = (root) => {
        asked.push(root);
        return root === '/workspace' ? null : { status: 'error', root, reason: 'x' };
      };
      assert.deepEqual(await read(), { status: 'ok', root: '/workspace', text: '{}', sha256: EMPTY_OBJECT }, 'null reads the file');
      assert.deepEqual(asked, ['/workspace']);
      mockBridge.projectCommandsAnswer = null;
      assert.deepEqual(await read(), { status: 'ok', root: '/workspace', text: '{}', sha256: EMPTY_OBJECT });
    });
  });

  test('PCM-08: without Web Crypto the hash is computed here, and is the same', async () => {
    await aside(async () => {
      const messages = [
        '',
        'abc',
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '\u{1f600} \u{d55c}\u{ae00} \u{e9}',
        '\u{feff}{}',
        // Either side of where the length no longer fits the last block.
        ...[55, 56, 57, 63, 64, 65, 119, 120, 128, 1000].map((n) => 'a'.repeat(n)),
        'a'.repeat(262144),
      ];
      const hashed = async () => {
        const out = [];
        for (const message of messages) {
          mockBridge.files.set(FILE, message);
          out.push(await read());
        }
        return out;
      };
      assert.equal(typeof globalThis.crypto?.subtle?.digest, 'function', 'premise: this runtime has Web Crypto');
      const withIt = await hashed();
      const withoutIt = await withoutWebCrypto(hashed);
      assert.deepEqual(withoutIt, withIt);
      assert.deepEqual(withoutIt.slice(0, 3).map((answer) => answer.sha256), [
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      ], 'the FIPS 180-4 examples');
      assert.equal(withoutIt.at(-1).sha256, 'dd3dde87623d9a6b354c68c943d189c89c63652d945e7bbdf0986cae91a49521');
      for (const answer of withoutIt) assert.match(answer.sha256, /^[0-9a-f]{64}$/);
    });
  });
});
