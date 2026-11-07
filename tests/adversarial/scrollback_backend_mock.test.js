/**
 * The saved scrollback as the browser mock keeps it (src/lib/ipc.js): the
 * `scrollback_*` commands, and `app_set_pending_save`.
 *
 * The backend keeps one file per terminal tab in the app's local data folder
 * (src-tauri/src/scrollback.rs, whose own tests cover links, FIFOs, the
 * folder's permissions, the atomic replace and files that are not UTF-8).
 * The mock keeps the same text under one key of the page's storage, with the
 * backend's rules — one shape of tab id, 2 MiB of UTF-8 a file, 50 MiB in all
 * with the least recently written going first — and with Tauri's own refusal
 * of a missing or mistyped argument, so that a page written against the mock
 * is not refused by the app. The numbers are held to the Rust constants and
 * to the page's own copy at the end.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { readFileSync } from 'node:fs';
import { invoke, mockBridge } from '../../src/lib/ipc.js';

const KEY = 'nexterm.mock.scrollback';
const MiB = 1024 * 1024;

const write = (tab_id, content) => invoke('scrollback_write', { tab_id, content });
const read = (tab_id) => invoke('scrollback_read', { tab_id });
const remove = (tab_id) => invoke('scrollback_delete', { tab_id });
const retainOnly = (tab_ids) => invoke('scrollback_retain_only', { tab_ids });
const clear = () => invoke('scrollback_clear');

/** What the mock holds in memory, by tab id, sorted. */
const kept = () => Object.keys(mockBridge.scrollbackMemory).sort();

/** A page's storage: strings by key — or one that throws on a look, or has room for only so many characters. */
class Storage {
  constructor({ throwsOnAccess = false, room = Infinity } = {}) {
    this.items = new Map();
    this.throwsOnAccess = throwsOnAccess;
    this.room = room;
  }
  getItem(key) {
    if (this.throwsOnAccess) throw new Error('SecurityError');
    return this.items.has(key) ? this.items.get(key) : null;
  }
  setItem(key, value) {
    if (this.throwsOnAccess) throw new Error('SecurityError');
    if (String(value).length > this.room) throw new Error('QuotaExceededError');
    this.items.set(key, String(value));
  }
  removeItem(key) {
    this.items.delete(key);
  }
}

/**
 * Run `fn` with the page's storage `storage` — undefined for none, as in
 * Node — and the mock's memory empty; both put back after.
 */
async function withStorage(storage, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const memory = mockBridge.scrollbackMemory;
  mockBridge.scrollbackMemory = {};
  if (storage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    assert.equal(globalThis.localStorage, storage, 'premise: the storage is the one asked for');
    return await fn(storage);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
    mockBridge.scrollbackMemory = memory;
  }
}

/** `fn` with console.warn caught; what it was given, each call's arguments joined. */
async function warnings(fn) {
  const original = console.warn;
  const said = [];
  console.warn = (...args) => said.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return said;
}

describe('Saved scrollback: the mock backend', () => {
  test('SBM-01: what is written is read back; nothing saved is null; a delete forgets it, and deleting nothing is fine', async () => {
    await withStorage(undefined, async () => {
      assert.equal(await read('tab-term-1'), null);
      const text = 'NEXTERM-SCROLLBACK 1\n{"tabId":"tab-term-1"}\n\u{1b}[1;38;2;1;2;3mbold\u{1b}[0m \u{d55c}\u{ae00} \u{1f600}\u{200d}\u{1f525}\r\nnext';
      assert.equal(await write('tab-term-1', text), null);
      assert.equal(await read('tab-term-1'), text);
      assert.equal(await write('tab-term-2', ''), null);
      assert.equal(await read('tab-term-2'), '', 'an empty file is a file');
      assert.equal(await read('tab-term-3'), null, "another tab's is not");
      await write('tab-term-1', 'new');
      assert.equal(await read('tab-term-1'), 'new', 'replaced whole');
      assert.equal(await remove('tab-term-1'), null);
      assert.equal(await read('tab-term-1'), null);
      assert.equal(await remove('tab-term-1'), null, 'nothing saved is fine');
      assert.equal(await read('tab-term-2'), '', 'and the other is still there');
    });
  });

  test("SBM-02: only `tab-term-<n>` (and the old `tab-term-<ms>-<n>`) names anything — every command refuses the rest in the backend's words, and keeps nothing for it", async () => {
    await withStorage(undefined, async () => {
      const good = ['tab-term-1', 'tab-term-10', 'tab-term-1696512345678-2', 'tab-term-999999999'];
      for (const id of good) {
        await write(id, id);
        assert.equal(await read(id), id);
      }
      const bad = [
        '',
        'tab-term-',
        'tab-term-0',
        'tab-term-01',
        'tab-term-1234567890',
        'tab-term-1/../x',
        'tab-term-1\\..\\x',
        '../tab-term-1',
        'tab-term-\u{0661}',
        'tab-term-1\u{0661}',
        'tab-term-\u{ff11}',
        'tab-term-1\u{0000}',
        'tab-term-1\n',
        ' tab-term-1',
        'TAB-TERM-1',
        'tab-term-1.5',
        'tab-term-1-2',
        'tab-term-169651234567-2',
        'tab-term-1696512345678-0',
        'tab-term-1696512345678-12345',
        'tab-term-1696512345678-2-3',
        `tab-term-1${'/..'.repeat(1000)}`,
      ];
      for (const id of bad) {
        for (const call of [() => write(id, 'x'), () => read(id), () => remove(id)]) {
          await assert.rejects(call, (err) => {
            assert.match(err.message, /^Not a terminal tab's id: "/);
            assert.ok(err.message.length < 100, `shown cut short: ${err.message.length}`);
            assert.ok(!/[\u{0000}-\u{001f}]/u.test(err.message), 'and escaped');
            return true;
          }, JSON.stringify(id));
        }
      }
      assert.deepEqual(kept(), good);
    });
  });

  test('SBM-03: the arguments as Tauri takes them — snake_case, of their types, and text the IPC can carry', async () => {
    await withStorage(undefined, async () => {
      await assert.rejects(
        () => invoke('scrollback_write', { tabId: 'tab-term-1', content: 'x' }),
        { message: 'invalid args `tab_id` for command `scrollback_write`: command scrollback_write missing required key tab_id' },
        'camelCase is how Tauri takes arguments by default; these commands are told snake_case'
      );
      await assert.rejects(() => invoke('scrollback_read', { tabId: 'tab-term-1' }), /invalid args `tab_id` for command `scrollback_read`/);
      await assert.rejects(() => invoke('scrollback_delete', {}), /invalid args `tab_id` for command `scrollback_delete`/);
      await assert.rejects(() => invoke('scrollback_read'), /missing required key tab_id/);
      await assert.rejects(() => invoke('scrollback_write', { tab_id: 'tab-term-1' }), {
        message: 'invalid args `content` for command `scrollback_write`: command scrollback_write missing required key content',
      });
      await assert.rejects(() => invoke('scrollback_write', { tab_id: 'tab-term-1', content: 42 }), /invalid args `content` for command `scrollback_write`: invalid type: expected a string/);
      await assert.rejects(() => invoke('scrollback_write', { tab_id: 1, content: 'x' }), /invalid args `tab_id`.*expected a string/);
      await assert.rejects(() => invoke('scrollback_write', { tab_id: '../x' }), /invalid args `content`/, 'every argument is taken before the command looks at any');
      await assert.rejects(() => invoke('scrollback_retain_only', { tabIds: [] }), /invalid args `tab_ids` for command `scrollback_retain_only`: command scrollback_retain_only missing required key tab_ids/);
      await assert.rejects(() => invoke('scrollback_retain_only', { tab_ids: 'tab-term-1' }), /invalid args `tab_ids`.*expected a sequence of strings/);
      await assert.rejects(() => invoke('scrollback_retain_only', { tab_ids: ['tab-term-1', 2] }), /invalid args `tab_ids`/);
      // A lone surrogate: a cut between the two halves of an emoji. JSON
      // carries it as `\ud800`, and serde_json refuses that.
      for (const broken of ['ab\u{d800}', '\u{dc00}x', `${'\u{1f600}'.slice(0, 1)}`]) {
        await assert.rejects(() => write('tab-term-1', broken), /invalid args `content` for command `scrollback_write`/, JSON.stringify(broken));
      }
      assert.equal(await write('tab-term-1', '\u{d83d}\u{de00}'), null, 'the two halves together are a character');
      assert.equal(await read('tab-term-1'), '\u{1f600}');
      assert.deepEqual(kept(), ['tab-term-1'], 'nothing refused was kept');
    });
  });

  test('SBM-04: 2 MiB of UTF-8 a file, counted in bytes; a larger write is refused and changes nothing, and a larger entry is not read', async () => {
    await withStorage(undefined, async () => {
      const atCap = 'a'.repeat(2 * MiB);
      assert.equal(await write('tab-term-1', atCap), null);
      assert.equal((await read('tab-term-1')).length, 2 * MiB);
      await assert.rejects(() => write('tab-term-1', 'a'.repeat(2 * MiB + 1)), {
        message: 'The scrollback of tab-term-1 is 2097153 bytes; at most 2097152 are saved',
      });
      // 699 051 characters, three bytes each: 2 097 153 bytes.
      const hangul = '\u{d55c}'.repeat(699051);
      assert.ok(hangul.length < 2 * MiB, 'premise: fewer characters than the cap');
      await assert.rejects(() => write('tab-term-1', hangul), /is 2097153 bytes/);
      // Four bytes in two UTF-16 units.
      await assert.rejects(() => write('tab-term-1', `${'a'.repeat(2 * MiB - 3)}\u{1f600}`), /is 2097153 bytes/);
      assert.equal(await read('tab-term-1'), atCap, 'the refused writes changed nothing');
      const fits = `${'\u{d55c}'.repeat(699050)}aa`;
      await write('tab-term-1', fits);
      assert.equal(await read('tab-term-1'), fits, 'exactly 2 MiB of UTF-8');

      mockBridge.scrollbackMemory['tab-term-2'] = { content: 'a'.repeat(2 * MiB + 1), at: Date.now() };
      let answer;
      const said = await warnings(async () => {
        answer = await read('tab-term-2');
      });
      assert.equal(answer, null, 'an entry over the cap, however it got there, is nothing to restore');
      assert.deepEqual(said, ['[IPC Mock] The saved scrollback of tab-term-2 is not restored: it is larger than 2097152 bytes']);
    });
  });

  test('SBM-05: 50 MiB in all — the least recently written go first, by when each was last written, and never the one just written', async () => {
    await withStorage(undefined, async () => {
      const full = 'a'.repeat(2 * MiB);
      const now = Date.now();
      // Twenty-five at the cap, 50 MiB — at the total, not over it —
      // written in another order than their ids: tab-term-(i + 1) was
      // written order[i]-th.
      const order = Array.from({ length: 25 }, (_, i) => ((i * 7 + 3) % 25) + 1);
      assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1), 'premise: every place once');
      const nth = (n) => `tab-term-${order.indexOf(n) + 1}`;
      assert.notEqual(nth(1), 'tab-term-1', 'premise: the oldest is not the first in the store');
      const fill = (at) => Object.fromEntries(order.map((n, i) => [`tab-term-${i + 1}`, { content: full, at: at(n) }]));
      const all = Array.from({ length: 25 }, (_, i) => `tab-term-${i + 1}`);
      const expect = (gone, added) => [...all.filter((id) => !gone.includes(id)), ...added].sort();

      mockBridge.scrollbackMemory = fill((n) => now - 100_000 + n * 1000);
      await write('tab-term-26', full);
      assert.deepEqual(kept(), expect([nth(1)], ['tab-term-26']), '52 MiB: the oldest went');
      await write(nth(2), full);
      assert.deepEqual(kept(), expect([nth(1)], ['tab-term-26']), 'a rewrite of the same size: 50 MiB, nothing goes');
      await write('tab-term-27', full);
      assert.deepEqual(kept(), expect([nth(1), nth(3)], ['tab-term-26', 'tab-term-27']), 'the second oldest counts from its rewrite, so the third goes');
      await write('tab-term-28', 'a'.repeat(MiB));
      assert.deepEqual(kept(), expect([nth(1), nth(3), nth(4)], ['tab-term-26', 'tab-term-27', 'tab-term-28']), '51 MiB: one was enough');

      // A clock set back since the others were written: every one of them
      // is newer than the write that just happened, which still stays.
      mockBridge.scrollbackMemory = fill((n) => now + 10 ** 9 + n);
      await write('tab-term-30', full);
      assert.deepEqual(kept(), expect([nth(1)], ['tab-term-30']), 'the oldest of the others went, not the one just written');
      assert.equal((await read('tab-term-30')).length, 2 * MiB);
    });
  });

  test("SBM-06: kept in the page's storage, so that a reload finds it — the mock holds nothing of its own between calls", async () => {
    const storage = new Storage();
    await withStorage(storage, async () => {
      await write('tab-term-1', 'one');
      await write('tab-term-2', 'two');
      const stored = JSON.parse(storage.getItem(KEY));
      assert.deepEqual(Object.keys(stored), ['tab-term-1', 'tab-term-2']);
      assert.deepEqual(Object.keys(stored['tab-term-1']), ['content', 'at']);
      assert.equal(stored['tab-term-1'].content, 'one');
      assert.ok(Number.isFinite(stored['tab-term-1'].at) && Math.abs(stored['tab-term-1'].at - Date.now()) < 60_000, 'the time of the write');
      assert.deepEqual(mockBridge.scrollbackMemory, {}, 'nothing in memory while there is storage');

      // What the page before the reload left, entries it could not have
      // written among them.
      storage.setItem(KEY, JSON.stringify({
        'tab-term-7': { content: 'from before the reload', at: 1 },
        'tab-term-0': { content: 'no tab id', at: 1 },
        'tab-term-8': { content: 5, at: 1 },
        'tab-term-9': { content: 'no time' },
        __proto__: { content: 'x', at: 1 },
      }));
      assert.equal(await read('tab-term-7'), 'from before the reload');
      assert.equal(await read('tab-term-1'), null, 'the storage is the record');
      assert.equal(await read('tab-term-8'), null);
      assert.equal(await read('tab-term-9'), null);
      assert.equal(await retainOnly(['tab-term-7']), 0, 'what is not ours is not counted');

      for (const raw of ['{not json', '[]', 'null', '"x"', '42']) {
        storage.setItem(KEY, raw);
        assert.equal(await read('tab-term-7'), null, raw);
      }
      await write('tab-term-3', 'three');
      const after = JSON.parse(storage.getItem(KEY));
      assert.deepEqual(after, { 'tab-term-3': { content: 'three', at: after['tab-term-3'].at } }, 'what could not be read is not carried on');
    });
  });

  test('SBM-07: a storage that throws on a look is not used, memory is; one without room refuses the write and keeps what it had', async () => {
    await withStorage(new Storage({ throwsOnAccess: true }), async () => {
      await write('tab-term-1', 'one');
      assert.equal(await read('tab-term-1'), 'one');
      assert.deepEqual(kept(), ['tab-term-1']);
      assert.equal(await clear(), 1);
    });
    await withStorage(new Storage({ room: 200 }), async (storage) => {
      await write('tab-term-1', 'small');
      await assert.rejects(() => write('tab-term-2', 'x'.repeat(500)), { message: 'The saved scrollback could not be written: QuotaExceededError' });
      assert.equal(await read('tab-term-1'), 'small');
      assert.equal(await read('tab-term-2'), null, 'nothing of the refused write');
      assert.deepEqual(Object.keys(JSON.parse(storage.getItem(KEY))), ['tab-term-1']);
      assert.deepEqual(mockBridge.scrollbackMemory, {}, 'and nothing of it in memory either');
    });
  });

  test('SBM-08: retain_only keeps the listed tabs and says how many went, ids that name nothing passed over; clear takes all', async () => {
    await withStorage(undefined, async () => {
      assert.equal(await retainOnly([]), 0, 'nothing saved yet');
      assert.equal(await clear(), 0);
      for (const id of ['tab-term-1', 'tab-term-2', 'tab-term-3', 'tab-term-4']) await write(id, id);
      assert.equal(await retainOnly(['tab-term-1', 'tab-term-3', '../tab-term-2', 'tab-term-02', 'tab-term-4/', '', 'notes.txt']), 2);
      assert.deepEqual(kept(), ['tab-term-1', 'tab-term-3']);
      assert.equal(await read('tab-term-1'), 'tab-term-1');
      assert.equal(await read('tab-term-3'), 'tab-term-3');
      assert.equal(await retainOnly(['tab-term-1', 'tab-term-3']), 0, 'again: nothing more to do');
      assert.equal(await clear(), 2);
      assert.deepEqual(kept(), []);
      assert.equal(await clear(), 0);
      assert.equal(await read('tab-term-1'), null);
    });
  });

  test('SBM-09: app_set_pending_save takes a boolean `pending`, as the backend does, and changes nothing else here', async () => {
    const state = () => JSON.stringify({
      unsaved: mockBridge.unsaved,
      closes: mockBridge.windowCloses,
      quits: mockBridge.quitRequests,
      acks: mockBridge.closeAcks.length,
    });
    const before = state();
    assert.equal(await invoke('app_set_pending_save', { pending: true }), null);
    assert.equal(await invoke('app_set_pending_save', { pending: false }), null);
    await assert.rejects(
      () => invoke('app_set_pending_save', { pendingSave: true }),
      { message: 'invalid args `pending` for command `app_set_pending_save`: command app_set_pending_save missing required key pending' }
    );
    await assert.rejects(() => invoke('app_set_pending_save', { pending: 'yes' }), /invalid args `pending`.*expected a boolean/);
    await assert.rejects(() => invoke('app_set_pending_save'), /missing required key pending/);
    assert.equal(state(), before);
  });

  test("SBM-10: the backend registers all six, takes their arguments in snake_case off the event-loop thread, and has the mock's caps — and so does the page", () => {
    const source = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const main = source('../../src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    for (const name of ['scrollback_write', 'scrollback_read', 'scrollback_delete', 'scrollback_retain_only', 'scrollback_clear']) {
      assert.ok(handler.includes(`commands::scrollback::${name},`), `${name} in generate_handler!`);
    }
    assert.ok(handler.includes('commands::app::app_set_pending_save,'), 'app_set_pending_save in generate_handler!');

    const commands = source('../../src-tauri/src/commands/scrollback.rs');
    const signatures = {
      scrollback_write: '(app: AppHandle, tab_id: String, content: String) -> Result<(), String>',
      scrollback_read: '(app: AppHandle, tab_id: String) -> Result<Option<String>, String>',
      scrollback_delete: '(app: AppHandle, tab_id: String) -> Result<(), String>',
      scrollback_retain_only: '(app: AppHandle, tab_ids: Vec<String>) -> Result<u32, String>',
      scrollback_clear: '(app: AppHandle) -> Result<u32, String>',
    };
    for (const [name, signature] of Object.entries(signatures)) {
      assert.ok(
        commands.includes(`#[tauri::command(rename_all = "snake_case")]\npub async fn ${name}${signature} {`),
        `${name}: snake_case arguments, an async fn (off the event-loop thread), ${signature}`
      );
    }
    assert.equal((commands.match(/#\[tauri::command/g) ?? []).length, 5, 'no other command there');
    assert.ok(
      source('../../src-tauri/src/commands/app.rs').includes('#[tauri::command(rename_all = "snake_case")]\npub fn app_set_pending_save(pending: bool) {'),
      'app_set_pending_save(pending: bool)'
    );

    const rust = source('../../src-tauri/src/scrollback.rs');
    assert.ok(rust.includes('\npub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;\n'), 'the backend refuses more than 2 MiB a file, as SBM-04 holds the mock to');
    assert.ok(rust.includes('\npub const TOTAL_MAX_BYTES: u64 = 50 * 1024 * 1024;\n'), 'and keeps 50 MiB in all, as SBM-05 holds the mock to');
    assert.match(source('../../src/lib/scrollbackSnapshot.js'), /^export const MAX_FILE_BYTES = 2 \* 1024 \* 1024;$/m, "the page cuts to the backend's cap");

    // A close held only for the scrollback goes FLUSH_TIMEOUT after the
    // request, heard or not: the page's own save has to end well before.
    const app = source('../../src-tauri/src/commands/app.rs');
    const flushSeconds = Number(/^pub const FLUSH_TIMEOUT: Duration = Duration::from_secs\((\d+)\);$/m.exec(app)?.[1]);
    const ackSeconds = Number(/^pub const ACK_TIMEOUT: Duration = Duration::from_secs\((\d+)\);$/m.exec(app)?.[1]);
    const pageFlushMs = Number(/^export const EXIT_FLUSH_MS = (\d+);$/m.exec(source('../../src/lib/scrollbackSaver.js'))?.[1]);
    assert.ok(Number.isFinite(flushSeconds) && Number.isFinite(ackSeconds) && Number.isFinite(pageFlushMs), 'premise: the three bounds were found');
    assert.ok(flushSeconds > ackSeconds, 'an unheard question goes first');
    assert.ok(pageFlushMs + 1000 <= flushSeconds * 1000, `the page's save (${pageFlushMs} ms) ends a second or more before the backend's bound (${flushSeconds} s)`);
  });
});
