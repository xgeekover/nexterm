/**
 * The agent session history: the browser mock against the backend.
 *
 * `src-tauri/src/agent_history.rs::contract_tests` runs a list of operation
 * sequences against the real module, each on a folder of its own, and
 * writes what it answered — every result, the file left behind and the
 * files moved aside — to `tests/fixtures/agent-history.json`. AH-01 replays
 * every sequence through `BrowserMockBridge` (src/lib/ipc.js) and expects
 * exactly the same. The semantics are written twice, once in each language,
 * and either can be edited alone; TEST_INFRA.md says why a mock nothing
 * checks is how the explorer came up empty on Windows for two releases.
 *
 * The AH-1x cases hold the mock to the same rules without the fixture, so
 * that they also run when the JS suite is run on its own: the cap, one entry
 * per conversation, `replaces`, remove and clear across a restart, a kind
 * this build does not know, the deleted- and corrupt-file hooks, and
 * Tauri's own refusals; AH-22 what the user curates (format version 2);
 * AH-23 the `forkOf` of a forked conversation.
 * AH-20 checks the numbers and patterns against the Rust source and
 * src/lib/agents.js, and that the nine commands are registered; AH-21 does
 * the same on copies with a Windows checkout's CRLF line ends. AH-99 puts
 * the mock and the storage back.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mockBridge } from '../../src/lib/ipc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'agent-history.json');
const available = existsSync(FIXTURE);
const fixture = available ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
/**
 * A file of the repo as the checks read it: with LF line ends. Windows checks
 * the repo out with CRLF, and AH-20 looks for whole lines, so without this it
 * found none of them there. `as` changes the text first; AH-21 gives it a
 * Windows checkout's line ends.
 */
const source = (relative, as = (text) => text) =>
  as(readFileSync(path.join(here, relative), 'utf8')).replace(/\r\n/g, '\n');
/** Every line end as a Windows checkout has it. */
const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

const KEY = 'nexterm.mock.agentHistory';
const CLAUDE_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CLAUDE_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OPENCODE_A = 'ses_ef45006f5ffeAMtumN5ySj4VmT';

const utf8 = (text) => new TextEncoder().encode(text).length;
const call = (op, args) => mockBridge.invoke(`agent_history_${op}`, args);
const list = () => call('list');
const upsert = (entry, replaces) => call('upsert', replaces === undefined ? { entry } : { entry, replaces });
const entry = (kind, sessionId, cwd, title, startedAt, lastUsedAt) => ({
  kind, sessionId, cwd, title, startedAt, lastUsedAt, endedAt: null, endReason: null,
});
const keys = (entries) => entries.map((e) => e.key);

/** A page's storage: strings by key. */
class Storage {
  constructor() {
    this.items = new Map();
  }
  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }
  setItem(key, value) {
    this.items.set(key, String(value));
  }
  removeItem(key) {
    this.items.delete(key);
  }
}

/** What was there before this file's first case: AH-99 puts it back. */
let before = null;

/**
 * A mock with no history file and nothing moved aside, and the page's
 * storage `storage` — undefined for none, as in Node, which keeps the file
 * in the mock's memory. console.warn is caught for the case: the mock says
 * there when it moves a file aside, as the backend logs it.
 */
async function fresh(fn, storage = undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const warn = console.warn;
  const warned = [];
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  mockBridge.agentHistoryNewerSaid = false;
  if (storage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    return await fn(warned);
  } finally {
    console.warn = warn;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
}

async function replay(ops) {
  const results = [];
  for (const { op, args } of ops) {
    if (op === 'delete_file') {
      mockBridge.agentHistoryDeleteFile();
      results.push(null);
    } else if (op === 'write_file') {
      const pad = Math.max(0, (args.padTo ?? 0) - utf8(args.text));
      mockBridge.agentHistoryCorruptFile(args.text + ' '.repeat(pad));
      results.push(null);
    } else if (op === 'hold_asides') {
      mockBridge.agentHistoryHoldAsides();
      results.push(null);
    } else {
      try {
        results.push({ ok: await call(op, args) });
      } catch (err) {
        results.push({ error: err.message });
      }
    }
  }
  return results;
}

/** The files moved aside as the fixture holds them (`aside` in the Rust test). */
const asides = () => mockBridge.agentHistoryBad.map(({ text }) => ({
  bytes: utf8(text),
  text: utf8(text) <= 4096 && text.isWellFormed() ? text : null,
}));

const fileNow = () => {
  const text = mockBridge.agentHistoryFile();
  return text === null ? null : JSON.parse(text);
};

describe('Agent session history: the browser mock against the backend', () => {
  test('AH-00: the fixture exists — run `cargo test` first if this fails', () => {
    before = {
      memory: mockBridge.agentHistoryMemory,
      bad: mockBridge.agentHistoryBad,
      newerSaid: mockBridge.agentHistoryNewerSaid,
      storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    };
    if (!available) {
      const where = path.relative(process.cwd(), FIXTURE);
      // In CI `cargo test` always runs first, so a missing fixture there
      // means the contract went unchecked — a failure, not a skip.
      assert.equal(Boolean(process.env.CI), false, `${where} is missing in CI — the mock went unchecked against the backend`);
      skip(`no ${where} — run \`cd src-tauri && cargo test\` first`);
    }
    assert.ok(fixture.platform, 'the fixture says which platform produced it');
    assert.ok(Array.isArray(fixture.scenarios) && fixture.scenarios.length >= 10, 'and holds the sequences');
  });

  test('AH-01: every sequence the backend ran gives the same answers, file and asides in the mock', async () => {
    if (!available) skip('no tests/fixtures/agent-history.json — run `cd src-tauri && cargo test` first');
    for (const scenario of fixture.scenarios) {
      await fresh(async () => {
        const results = await replay(scenario.ops);
        for (let i = 0; i < scenario.ops.length; i += 1) {
          assert.deepEqual(results[i], scenario.results[i], `${scenario.name}: op ${i} (${scenario.ops[i].op})`);
        }
        // Parsed first, for a diff worth reading; then byte for byte.
        const expected = scenario.fileText === null ? null : JSON.parse(scenario.fileText);
        assert.deepEqual(fileNow(), expected, `${scenario.name}: the file left behind`);
        // Byte for byte: the size rules count the file's bytes, so the two
        // must write the same text for the same entries.
        assert.equal(mockBridge.agentHistoryFile(), scenario.fileText, `${scenario.name}: the file's exact text`);
        assert.deepEqual(asides(), scenario.bad, `${scenario.name}: the files moved aside`);
      });
    }
  });

  test('AH-02: the fixture covers what the mock is held to', () => {
    if (!available) skip('no tests/fixtures/agent-history.json — run `cd src-tauri && cargo test` first');
    const ops = fixture.scenarios.flatMap((s) => s.ops.map((o) => o.op));
    for (const op of [
      'list', 'upsert', 'remove', 'clear', 'delete_file', 'write_file',
      'groups', 'update', 'group_create', 'group_update', 'group_delete',
    ]) {
      assert.ok(ops.includes(op), `some sequence runs ${op}`);
    }
    const errors = fixture.scenarios.flatMap((s) => s.results).filter((r) => r?.error).map((r) => r.error);
    assert.ok(errors.some((e) => e.startsWith(fixture.constants.newerVersion)), 'a refused write of a newer file');
    assert.ok(errors.some((e) => e.startsWith(`${fixture.constants.invalid}: `)), 'a refused entry');
    // Format version 2: written only while something is curated.
    assert.equal(fixture.constants.version, 2);
    assert.equal(fixture.constants.uncuratedVersion, 1);
    const lazy = fixture.scenarios.find((s) => s.name.startsWith('an uncurated history is version 1'));
    assert.equal(JSON.parse(lazy.fileText).version, 1, 'curated, then not: version 1 again');
    assert.ok(lazy.results.some((r) => r?.ok?.version === 2) && lazy.results.some((r) => r?.ok?.version === 1), 'and both on the way');
    const curated = fixture.scenarios.find((s) => s.name === 'every curated field, written as version 2');
    assert.deepEqual(Object.keys(JSON.parse(curated.fileText)), ['version', 'entries', 'groups'], 'in that order');
    assert.deepEqual(
      Object.keys(JSON.parse(curated.fileText).entries[0]),
      ['key', 'kind', 'sessionId', 'cwd', 'title', 'startedAt', 'lastUsedAt', 'endedAt', 'endReason', 'name', 'pinned', 'archived', 'groupId']
    );
    assert.ok(errors.some((e) => e.startsWith(`${fixture.constants.invalidGroup}: `)), 'a refused group');
    assert.ok(errors.includes(fixture.constants.tooManyGroups), 'a group past the fiftieth refused');
    assert.ok(errors.includes(fixture.constants.tooManyCurated), 'a 201st protected entry refused');
    const listsOfGroups = fixture.scenarios.flatMap((s) => s.results).filter((r) => r?.ok && typeof r.ok === 'object' && 'readOnly' in r.ok);
    assert.ok(listsOfGroups.some((r) => r.ok.readOnly) && listsOfGroups.some((r) => !r.ok.readOnly), 'groups of a newer file, and of this one');
    const newer = fixture.scenarios.find((s) => s.name === 'a newer file is read and never written');
    assert.equal(JSON.parse(newer.ops[0].args.text).version, 3, 'version 3 is the newer one now');
    assert.equal(newer.results.filter((r) => r?.error?.startsWith(fixture.constants.newerVersion)).length, 9, 'every write refused');
    const kept = fixture.scenarios.find((s) => s.name.startsWith('the cap keeps every protected entry'));
    assert.equal(kept.results.at(-1).ok.length, 210, 'ten protected beside the newest two hundred');
    assert.ok(fixture.scenarios.some((s) => s.bad.length === fixture.constants.keepBad), 'a sequence that fills the asides');
    // Clear deletes the files moved aside, a refused one none: a sequence
    // with asides made before a clear, and one more after it.
    const cleared = fixture.scenarios.find((s) => s.name.startsWith('clear deletes the files moved aside'));
    assert.ok(cleared, 'a sequence that clears with files moved aside');
    const clearAt = cleared.ops.findIndex((o) => o.op === 'clear');
    assert.ok(cleared.ops.slice(0, clearAt).some((o) => o.op === 'write_file'), 'asides made before the clear');
    assert.equal(cleared.results[clearAt].ok, 2, 'the clear counts the entries');
    assert.ok(cleared.results.some((r) => r?.error?.startsWith(fixture.constants.newerVersion)), 'and a refused clear');
    assert.equal(cleared.bad.length, 1, 'only the file moved aside after the last clear is left');
    // Every refusal rule, through the command and inside a file; a clear
    // that leaves a copy; and what serde_json does not read.
    const refused = fixture.scenarios.find((s) => s.name === 'invalid entries are refused and nothing is made');
    const whys = new Set(refused.results.filter((r) => r?.error).map((r) => r.error));
    assert.ok(refused.results.filter((r) => r?.error).length >= 100 && whys.size >= 10, `${whys.size} reasons`);
    for (const c of ['\u001b', '\u007f', '\u0085', ' ', '‮', '⁦']) {
      assert.ok(refused.ops.some((o) => typeof o.args?.entry?.cwd === 'string' && o.args.entry.cwd.includes(c)), `a folder with U+${c.codePointAt(0).toString(16)}`);
    }
    const inFile = fixture.scenarios.find((s) => s.name.startsWith('entries that would be refused'));
    assert.deepEqual(inFile.results[1].ok.map((e) => e.kind), ['claude', 'opencode'], 'only the valid ones are read');
    const held = fixture.scenarios.find((s) => s.name.startsWith('a clear that cannot delete'));
    assert.ok(held.results.some((r) => r?.error?.startsWith(fixture.constants.copiesLeft)), 'a clear that left a copy');
    assert.ok(fixture.scenarios.some((s) => s.name.includes('lone surrogates') && s.bad.length > 0));
    const capped = fixture.scenarios.find((s) => s.ops.length > fixture.constants.cap);
    assert.equal(JSON.parse(capped?.fileText ?? '{}').entries?.length, fixture.constants.cap, 'and one that reaches the cap');
    const fitted = fixture.scenarios.find((s) => s.name.includes('larger than it may be read'));
    const listed = fitted?.results?.at(-1)?.ok;
    assert.ok(Array.isArray(listed) && listed.length > 1 && listed.length < 90, 'and one that is held under the read cap by size');
    assert.ok(utf8(fitted.fileText) <= fixture.constants.maxReadBytes && utf8(fitted.fileText) > fixture.constants.maxReadBytes * 0.9);
    // Fork Conversation: `forkOf` after the nine fields, only on a fork,
    // kept by later events and curation, version 1 by itself; one of the
    // wrong shape refused through the command and dropped from a file.
    const forked = fixture.scenarios.find((s) => s.name === 'a fork keeps the conversation it was forked from');
    assert.ok(forked, 'a sequence that records a fork');
    const forkKey = `claude:${CLAUDE_B}`;
    const firstList = forked.results[forked.ops.findIndex((o) => o.op === 'list')].ok;
    const theFork = firstList.find((e) => e.key === forkKey);
    assert.equal(theFork.forkOf, CLAUDE_A, 'kept through an end, a title and a resume that sent none');
    assert.equal(theFork.title, 'From the transcript');
    assert.ok(!('forkOf' in firstList.find((e) => e.key === `claude:${CLAUDE_A}`)), 'the source is left as it was');
    const pinnedAt = forked.ops.findIndex((o) => o.op === 'update' && o.args.changes.pinned === true);
    assert.equal(forked.results[pinnedAt].ok.forkOf, CLAUDE_A, 'and through a curation');
    // The answers are recorded with their keys sorted; the file is as written.
    const written = JSON.parse(forked.fileText);
    assert.equal(written.version, 1, 'a fork alone never makes version 2');
    assert.deepEqual(
      Object.keys(written.entries.find((e) => e.key === forkKey)),
      ['key', 'kind', 'sessionId', 'cwd', 'title', 'startedAt', 'lastUsedAt', 'endedAt', 'endReason', 'forkOf'],
      'after the nine fields'
    );
    assert.ok(written.entries.filter((e) => e.key !== forkKey).some((e) => Object.keys(e).length === 9), 'an entry without one is the nine');
    assert.ok(forked.results.some((r) => r?.error === `${fixture.constants.invalid}: its forkOf is not one that claude gives a conversation`));
    const forkWhys = [...whys].filter((w) => w.includes('its forkOf'));
    assert.ok(forkWhys.length >= 3, `the refusal rules of forkOf too: ${forkWhys}`);
  });
});

describe('Agent session history: the mock alone', () => {
  test('AH-10: the first list makes the file; it survives a restart in the page storage', async () => {
    const storage = new Storage();
    await fresh(async () => {
      assert.deepEqual(await list(), []);
      assert.deepEqual(JSON.parse(storage.getItem(KEY)), { version: 1, entries: [] }, 'made in the storage');
      const kept = await upsert(entry('claude', CLAUDE_A, '/work/app', null, 10, 20));
      assert.equal(kept.key, `claude:${CLAUDE_A}`);
      // A restart: nothing of the mock's but the storage carries over.
      mockBridge.agentHistoryMemory = null;
      assert.deepEqual(await list(), [kept], 'read back from the storage');
      kept.cwd = '/elsewhere';
      assert.equal((await list())[0].cwd, '/work/app', 'an answer is a copy');
    }, storage);
    await fresh(async () => {
      await upsert(entry('claude', CLAUDE_A, '/w', null, 1, 1));
      assert.equal(JSON.parse(mockBridge.agentHistoryMemory).entries.length, 1, 'no storage: kept in memory');
    });
  });

  test('AH-11: the newest 200 are kept, and the one just written always', async () => {
    await fresh(async () => {
      for (let n = 1; n <= 205; n += 1) {
        await upsert(entry('opencode', `ses_cap${String(n).padStart(5, '0')}`, '/w', null, n, 1000 + n));
      }
      let kept = await list();
      assert.equal(kept.length, 200);
      assert.equal(kept[0].key, 'opencode:ses_cap00205');
      assert.equal(kept[199].key, 'opencode:ses_cap00006', 'the five oldest went');
      await upsert(entry('opencode', 'ses_oldest00', '/w', null, 0, 1));
      kept = await list();
      assert.equal(kept.length, 200);
      assert.equal(kept[199].key, 'opencode:ses_oldest00', 'older than all, and kept');
      assert.ok(!keys(kept).includes('opencode:ses_cap00006'), 'the oldest other one went instead');
    });
  });

  test('AH-12: one conversation is one entry; replaces re-keys a provisional one', async () => {
    await fresh(async () => {
      await upsert(entry('opencode', OPENCODE_A, '/w', 'First', 100, 200));
      const merged = await upsert(entry('opencode', OPENCODE_A, '/w', null, 150, 300));
      assert.deepEqual([merged.startedAt, merged.lastUsedAt, merged.title], [100, 300, 'First']);
      const late = await upsert(entry('opencode', OPENCODE_A, '/w', 'Stale', 50, 250));
      assert.deepEqual([late.startedAt, late.lastUsedAt, late.title], [50, 300, 'First'], 'a late write changes no title');
      assert.equal((await list()).length, 1);

      await call('clear');
      const provisional = await upsert(entry('opencode', null, '/w', null, 1, 1));
      assert.equal(provisional.key, 'opencode:~/w\u0000');
      const titled = await upsert(entry('opencode', null, '/w', 'Fix it', 1, 2), provisional.key);
      const learned = await upsert(entry('opencode', OPENCODE_A, '/w', 'Fix it', 1, 3), titled.key);
      assert.deepEqual(keys(await list()), [learned.key], 'no provisional entry is left behind');
      // Never an entry with an id, nor one of another kind.
      const claude = await upsert(entry('claude', CLAUDE_A, '/w', null, 4, 4));
      await upsert(entry('opencode', 'ses_0123456789ab', '/w', null, 5, 5), claude.key);
      await upsert(entry('opencode', null, '/x', null, 6, 6), learned.key);
      assert.equal((await list()).length, 4);
    });
  });

  test('AH-13: remove takes exactly one, clear all; both survive a restart', async () => {
    const storage = new Storage();
    await fresh(async () => {
      await upsert(entry('claude', CLAUDE_A, '/w', null, 1, 1));
      await upsert(entry('claude', CLAUDE_B, '/w', null, 2, 2));
      assert.equal(await call('remove', { key: `claude:${CLAUDE_A}` }), true);
      assert.equal(await call('remove', { key: `claude:${CLAUDE_A}` }), false);
      assert.deepEqual(keys(JSON.parse(storage.getItem(KEY)).entries), [`claude:${CLAUDE_B}`], 'in the file');
      assert.equal(await call('clear'), 1);
      assert.deepEqual(JSON.parse(storage.getItem(KEY)), { version: 1, entries: [] });
      assert.deepEqual(await list(), []);
      // A cleared history leaves no copies: the files moved aside go too.
      mockBridge.agentHistoryCorruptFile();
      assert.deepEqual(await list(), []);
      assert.equal(mockBridge.agentHistoryBad.length, 1, 'premise: one file moved aside');
      assert.equal(await call('clear'), 0, 'the count is of the history, not of its copies');
      assert.deepEqual(mockBridge.agentHistoryBad, []);
    }, storage);
  });

  test('AH-14: a kind this build does not know survives other writes', async () => {
    await fresh(async () => {
      mockBridge.agentHistoryCorruptFile(JSON.stringify({ version: 1, entries: [
        { kind: 'agy', sessionId: 'a1', cwd: '/w', title: 'Plan', startedAt: 5, lastUsedAt: 5, agyOnly: true },
      ] }));
      await upsert(entry('claude', CLAUDE_A, '/w', null, 9, 9));
      assert.deepEqual(keys(await list()), [`claude:${CLAUDE_A}`, 'agy:a1'], 'the backend hands it back; the page leaves it out');
      assert.equal(mockBridge.agentHistoryBad.length, 0);
    });
  });

  test('AH-15: the deleted-file and corrupt-file hooks', async () => {
    await fresh(async (warned) => {
      await upsert(entry('claude', CLAUDE_A, '/w', null, 1, 1));
      mockBridge.agentHistoryDeleteFile();
      assert.equal(mockBridge.agentHistoryFile(), null, 'gone');
      assert.deepEqual(await list(), [], 'a deleted history is an empty one');
      assert.deepEqual(JSON.parse(mockBridge.agentHistoryFile()), { version: 1, entries: [] }, 'and the file is made again');

      await upsert(entry('claude', CLAUDE_A, '/w', null, 1, 1));
      mockBridge.agentHistoryCorruptFile();
      const garbage = mockBridge.agentHistoryFile();
      assert.deepEqual(await list(), []);
      assert.deepEqual(mockBridge.agentHistoryBad.map((b) => b.text), [garbage], 'moved aside as it was');
      assert.match(mockBridge.agentHistoryBad[0].name, /^agent-sessions\.json\.bad-\d+$/);
      assert.equal(warned.filter((w) => w.includes('moved aside')).length, 1, 'said once');

      for (let n = 0; n < 4; n += 1) {
        mockBridge.agentHistoryCorruptFile(`garbage ${n}`);
        await list();
      }
      assert.deepEqual(mockBridge.agentHistoryBad.map((b) => b.text), ['garbage 1', 'garbage 2', 'garbage 3'], 'the newest three');
      const times = mockBridge.agentHistoryBad.map((b) => Number(b.name.split('-').pop()));
      assert.ok(times[0] < times[1] && times[1] < times[2], 'named in order, even within one millisecond');

      mockBridge.agentHistoryCorruptFile('{"version":1,"entries":[],"x":"\ud800"}');
      assert.deepEqual(await list(), [], 'a lone surrogate stands in for bytes that are not UTF-8');
      assert.equal(mockBridge.agentHistoryBad.length, 3);
    });
  });

  test('AH-16: a newer file is read, never written, and the refusal is logged once', async () => {
    await fresh(async (warned) => {
      // Version 3: the first newer than this build's 2 (AC27).
      const text = JSON.stringify({ version: 3, entries: [entry('claude', CLAUDE_A, '/w', null, 1, 1)] });
      mockBridge.agentHistoryCorruptFile(text);
      assert.equal((await list()).length, 1);
      await assert.rejects(() => upsert(entry('claude', CLAUDE_B, '/w', null, 2, 2)), /^Error: The agent session history was written by a newer NexTerm \(format version 3\)/);
      await assert.rejects(() => call('clear'), /newer NexTerm/);
      assert.equal(mockBridge.agentHistoryFile(), text, 'byte for byte');
      assert.equal(warned.filter((w) => w.includes('newer NexTerm')).length, 1);
    });
  });

  test("AH-17: Tauri's own refusals, before the command runs", async () => {
    await fresh(async () => {
      await assert.rejects(() => call('upsert', {}), /invalid args `entry` for command `agent_history_upsert`: command agent_history_upsert missing required key entry/);
      await assert.rejects(() => upsert(entry('opencode', null, '/w', 'a \ud800 b', 1, 1)), /invalid args `entry`.*lone surrogate/);
      await assert.rejects(() => upsert(entry('claude', CLAUDE_A, '/w', null, 1, 1), 5), /invalid args `replaces`/);
      await assert.rejects(() => call('remove', {}), /invalid args `key`/);
      await assert.rejects(() => call('remove', { key: 7 }), /invalid args `key`/);
      // And the backend's: an invalid entry, with nothing made.
      await assert.rejects(() => upsert(entry('claude', 'x; curl a | sh', '/w', null, 1, 1)), /^Error: Not a valid agent session: its session id is not one that claude gives a conversation$/);
      await assert.rejects(() => upsert({ ...entry('claude', CLAUDE_A, '/w', null, 1, 1), startedAt: NaN }), /its startedAt is not a time/);
      assert.equal(mockBridge.agentHistoryFile(), null, 'a refused write makes no file');
      // undefined fields do not travel; missing nullable fields are null.
      const kept = await upsert({ kind: 'claude', sessionId: CLAUDE_A, cwd: '/w', startedAt: 1, lastUsedAt: 1, title: undefined });
      assert.deepEqual(kept, { key: `claude:${CLAUDE_A}`, kind: 'claude', sessionId: CLAUDE_A, cwd: '/w', title: null, startedAt: 1, lastUsedAt: 1, endedAt: null, endReason: null });
    });
  });

  test('AH-18: a clear that cannot delete a copy moved aside empties the history, keeps that copy and says so', async () => {
    await fresh(async () => {
      await upsert(entry('claude', CLAUDE_A, '/w', null, 1, 1));
      mockBridge.agentHistoryCorruptFile();
      await list();
      mockBridge.agentHistoryCorruptFile('[1]');
      await list();
      assert.equal(mockBridge.agentHistoryBad.length, 2, 'premise: two copies');
      mockBridge.agentHistoryHoldAsides();
      await upsert(entry('claude', CLAUDE_B, '/w', null, 2, 2));
      await assert.rejects(
        () => call('clear'),
        /^Error: The agent session history was emptied, but 2 damaged copies of it kept aside could not be deleted\. Try again; or delete agent-sessions\.json\.bad-\* in NexTerm's data folder$/
      );
      assert.deepEqual(await list(), [], 'emptied all the same');
      assert.equal(mockBridge.agentHistoryBad.length, 2, 'the copies held open are there');
      mockBridge.agentHistoryHoldAsides(false);
      assert.equal(await call('clear'), 0, 'let go of: cleared');
      assert.deepEqual(mockBridge.agentHistoryBad, []);
    });
  });

  test('AH-19: what serde_json does not read is not read here either; 5.0 and 1e3 are the difference left', async () => {
    await fresh(async () => {
      for (const text of ['{"version":1,"entries":[],"x":"\\ud800"}', '{"version":1,"\\udfff":0,"entries":[]}', `{"version":1,"entries":[],"x":${'['.repeat(127)}${']'.repeat(127)}}`]) {
        mockBridge.agentHistoryCorruptFile(text);
        assert.deepEqual(await list(), [], text.slice(0, 40));
        assert.equal(mockBridge.agentHistoryBad.at(-1).text, text, 'moved aside');
      }
      const lastAside = mockBridge.agentHistoryBad.at(-1).name;
      mockBridge.agentHistoryCorruptFile(`{"version":1,"entries":[],"x":${'['.repeat(126)}${']'.repeat(126)}}`);
      assert.deepEqual(await list(), []);
      assert.equal(mockBridge.agentHistoryBad.at(-1).name, lastAside, 'one level less is read, not moved aside');
      const at = (field, raw) => `{"version":1,"entries":[{"kind":"claude","sessionId":"${CLAUDE_A}","cwd":"/w","startedAt":1,"lastUsedAt":1,"${field}":${raw}}]}`;
      mockBridge.agentHistoryCorruptFile(at('startedAt', '-0'));
      assert.deepEqual(await list(), [], '-0 is no time');
      // The difference left, documented in ipc.js: kept here, dropped by the backend.
      mockBridge.agentHistoryCorruptFile(at('startedAt', '1e3'));
      assert.equal((await list())[0]?.startedAt, 1000);
    });
  });

  test('AH-22: version 2 only while something is curated, which no recorded event undoes', async () => {
    await fresh(async (warned) => {
      const claude = await upsert(entry('claude', CLAUDE_A, '/w', null, 1, 2));
      const v1 = mockBridge.agentHistoryFile();
      assert.equal(JSON.parse(v1).version, 1, 'nothing curated: version 1');
      assert.deepEqual(await call('groups'), { version: 1, readOnly: false, groups: [] });
      const pinned = await call('update', { key: claude.key, changes: { pinned: true } });
      assert.deepEqual(pinned, { ...claude, pinned: true });
      assert.deepEqual(Object.keys(JSON.parse(mockBridge.agentHistoryFile())), ['version', 'entries', 'groups']);
      await call('update', { key: claude.key, changes: { pinned: false } });
      assert.equal(mockBridge.agentHistoryFile(), v1, 'nothing curated again: version 1, byte for byte');

      const group = await call('group_create', { group: { id: 'g1', name: 'Work' }, move_key: claude.key });
      assert.deepEqual(group, { id: 'g1', name: 'Work', collapsed: false });
      await call('update', { key: claude.key, changes: { name: 'Mine', archived: true } });
      const later = await upsert({ ...entry('claude', CLAUDE_A, '/w', 'A title', 1, 9), name: 'Other', groupId: null });
      assert.deepEqual([later.title, later.name, later.archived, later.groupId], ['A title', 'Mine', true, 'g1'], 'a recorded event keeps it');
      const resumed = await call('upsert', { entry: entry('claude', CLAUDE_A, '/w', null, 10, 10), unarchive: true });
      assert.deepEqual([resumed.name, resumed.archived, resumed.groupId], ['Mine', undefined, 'g1'], 'unarchive clears archived, and only it');
      assert.deepEqual(await call('groups'), { version: 2, readOnly: false, groups: [group] });
      assert.deepEqual(await call('group_update', { id: 'g1', changes: { collapsed: true } }), { ...group, collapsed: true });
      assert.equal(await call('group_delete', { id: 'g1' }), 1);
      assert.equal(await call('update', { key: 'claude:nothing-here', changes: { pinned: true } }), null);
      assert.equal(await call('group_update', { id: 'g1', changes: { name: 'Gone' } }), null);
      await assert.rejects(() => call('update', { key: claude.key, changes: { title: 'x' } }), /^Error: Not a valid agent session: a change names something other than name, pinned, archived and groupId$/);
      await assert.rejects(() => call('update', { key: claude.key, changes: { groupId: 'g9' } }), /^Error: Not a valid agent session: its groupId names no group$/);
      await assert.rejects(() => call('group_create', { group: { id: 'has space', name: 'x' } }), /^Error: Not a valid agent session group: its id is not 1 to 64 ASCII letters, digits, - and _$/);
      // Tauri's own refusals, before the command runs.
      await assert.rejects(() => call('update', { key: claude.key }), /invalid args `changes` for command `agent_history_update`: command agent_history_update missing required key changes/);
      await assert.rejects(() => call('update', { changes: {} }), /invalid args `key`/);
      await assert.rejects(() => call('upsert', { entry: entry('claude', CLAUDE_A, '/w', null, 1, 1), unarchive: 'yes' }), /invalid args `unarchive`/);
      await assert.rejects(() => call('group_create', { group: { id: 'g2', name: 'x' }, move_key: 7 }), /invalid args `move_key`/);
      await assert.rejects(() => call('group_create', {}), /invalid args `group`/);
      await assert.rejects(() => call('group_update', { id: 'g1' }), /invalid args `changes`/);
      await assert.rejects(() => call('group_delete', {}), /invalid args `id`/);

      // A newer file: its groups read, and read only.
      const newer = JSON.stringify({ version: 3, entries: [], groups: [{ id: 'g1', name: 'Kept' }, { id: 'bad id', name: 'x' }] });
      mockBridge.agentHistoryCorruptFile(newer);
      assert.deepEqual(await call('groups'), { version: 3, readOnly: true, groups: [{ id: 'g1', name: 'Kept', collapsed: false }] });
      await assert.rejects(() => call('group_delete', { id: 'g1' }), /^Error: The agent session history was written by a newer NexTerm \(format version 3\)/);
      await assert.rejects(() => call('update', { key: claude.key, changes: { pinned: true } }), /newer NexTerm/);
      assert.equal(mockBridge.agentHistoryFile(), newer, 'byte for byte');
      assert.equal(warned.filter((w) => w.includes('newer NexTerm')).length, 1, 'said once');
    });
  });

  test('AH-23: a fork\u{2019}s forkOf — after the nine fields, kept by later events and curation, version 1 by itself, its shape checked', async () => {
    await fresh(async () => {
      const source = await upsert(entry('claude', CLAUDE_A, '/w', null, 1, 2));
      const fork = await upsert({ ...entry('claude', CLAUDE_B, '/w', null, 3, 4), forkOf: CLAUDE_A });
      assert.equal(fork.forkOf, CLAUDE_A);
      assert.deepEqual(Object.keys(fork), ['key', 'kind', 'sessionId', 'cwd', 'title', 'startedAt', 'lastUsedAt', 'endedAt', 'endReason', 'forkOf']);
      const text = mockBridge.agentHistoryFile();
      assert.equal(JSON.parse(text).version, 1, 'not curated');
      assert.ok(text.includes(`"endReason": null,\n      "forkOf": "${CLAUDE_A}"\n    }`), text);
      // A later event of the fork names none: kept.
      const later = await upsert({ ...entry('claude', CLAUDE_B, '/w', 'Its title', 3, 9), forkOf: null });
      assert.equal(later.forkOf, CLAUDE_A);
      const pinned = await call('update', { key: fork.key, changes: { pinned: true } });
      assert.equal(pinned.forkOf, CLAUDE_A);
      assert.ok(mockBridge.agentHistoryFile().includes(`"forkOf": "${CLAUDE_A}",\n      "pinned": true\n`), 'between the nine and the curated');
      await call('update', { key: fork.key, changes: { pinned: false } });
      assert.equal(JSON.parse(mockBridge.agentHistoryFile()).version, 1);
      const listed = await list();
      assert.deepEqual(listed.map((e) => [e.key, e.forkOf]), [[fork.key, CLAUDE_A], [source.key, undefined]], 'the source left as it was');
      for (const bad of ['x; curl a | sh', CLAUDE_A.toUpperCase(), OPENCODE_A, '', 7]) {
        await assert.rejects(
          () => upsert({ ...entry('claude', CLAUDE_B, '/w', null, 3, 10), forkOf: bad }),
          /^Error: Not a valid agent session: its forkOf is not one that claude gives a conversation$/,
          JSON.stringify(bad)
        );
      }
      await assert.rejects(
        () => upsert({ ...entry('opencode', OPENCODE_A, '/w', null, 3, 10), forkOf: CLAUDE_A }),
        /its forkOf is not one that opencode gives a conversation$/
      );
    });
  });

  /** AH-20's checks, on the five files as `read` gives them. */
  const theBackendsOwn = (read) => {
    const rust = read('../../src-tauri/src/agent_history.rs');
    const mock = read('../../src/lib/ipc.js');
    for (const [rustLine, mockLine] of [
      ['pub const CAP: usize = 200;', 'const MOCK_AGENT_HISTORY_CAP = 200;'],
      ['pub const MAX_READ_BYTES: u64 = 1024 * 1024;', 'const MOCK_AGENT_HISTORY_MAX_READ_BYTES = 1024 * 1024;'],
      ['pub const KEEP_BAD: usize = 3;', 'const MOCK_AGENT_HISTORY_KEEP_BAD = 3;'],
      ['pub const MAX_CWD_BYTES: usize = 4096;', 'const MOCK_AGENT_HISTORY_MAX_CWD_BYTES = 4096;'],
      ['pub const MAX_TITLE_CHARS: usize = 200;', 'const MOCK_AGENT_HISTORY_MAX_TITLE_CHARS = 200;'],
      ['pub const MAX_OTHER_ID_CHARS: usize = 128;', 'const MOCK_AGENT_HISTORY_MAX_OTHER_ID_CHARS = 128;'],
      ['pub const VERSION: u64 = 2;', 'const MOCK_AGENT_HISTORY_VERSION = 2;'],
      ['pub const UNCURATED_VERSION: u64 = 1;', 'const MOCK_AGENT_HISTORY_UNCURATED_VERSION = 1;'],
      ['pub const MAX_CURATED: usize = 200;', 'const MOCK_AGENT_HISTORY_MAX_CURATED = 200;'],
      ['pub const MAX_GROUPS: usize = 50;', 'const MOCK_AGENT_HISTORY_MAX_GROUPS = 50;'],
      ['pub const MAX_NAME_CHARS: usize = 200;', 'const MOCK_AGENT_HISTORY_MAX_NAME_CHARS = 200;'],
      ['pub const MAX_GROUP_NAME_CHARS: usize = 100;', 'const MOCK_AGENT_HISTORY_MAX_GROUP_NAME_CHARS = 100;'],
      ['pub const MAX_GROUP_ID_CHARS: usize = 64;', 'const MOCK_AGENT_HISTORY_MAX_GROUP_ID_CHARS = 64;'],
      ['pub const INVALID_GROUP: &str = "Not a valid agent session group";', "const MOCK_AGENT_HISTORY_INVALID_GROUP = 'Not a valid agent session group';"],
      ['pub const TOO_MANY_GROUPS: &str = "There can be at most 50 agent session groups";', "const MOCK_AGENT_HISTORY_TOO_MANY_GROUPS = 'There can be at most 50 agent session groups';"],
      [
        'pub const TOO_MANY_CURATED: &str = "At most 200 agent sessions can be pinned, renamed or in a group; unpin one, clear its name or take it out of its group first";',
        "const MOCK_AGENT_HISTORY_TOO_MANY_CURATED = 'At most 200 agent sessions can be pinned, renamed or in a group; unpin one, clear its name or take it out of its group first';",
      ],
      ['pub const FILE: &str = "agent-sessions.json";', "const MOCK_AGENT_HISTORY_FILE = 'agent-sessions.json';"],
      ['pub const NEWER_VERSION: &str = "The agent session history was written by a newer NexTerm";', "const MOCK_AGENT_HISTORY_NEWER = 'The agent session history was written by a newer NexTerm';"],
      ['pub const INVALID: &str = "Not a valid agent session";', "const MOCK_AGENT_HISTORY_INVALID = 'Not a valid agent session';"],
      ['pub const COPIES_LEFT: &str = "The agent session history was emptied, but";', "const MOCK_AGENT_HISTORY_COPIES_LEFT = 'The agent session history was emptied, but';"],
      ['const BAD_AHEAD_MS: u64 = 24 * 60 * 60 * 1000;', 'const MOCK_AGENT_HISTORY_BAD_AHEAD_MS = 24 * 60 * 60 * 1000;'],
    ]) {
      assert.ok(rust.includes(`\n${rustLine}\n`), `the backend: ${rustLine}`);
      assert.ok(mock.includes(`\n${mockLine}\n`), `and the mock: ${mockLine}`);
    }
    // The ids typed into a shell: the mock's patterns are agents.js's own,
    // and the backend's doc names those lines.
    const agents = read('../../src/lib/agents.js');
    for (const [name, kind] of [['CLAUDE_SESSION_ID', 'claude'], ['OPENCODE_SESSION_ID', 'opencode']]) {
      const pattern = new RegExp(`^const ${name} = (/.+/);$`, 'm').exec(agents)?.[1];
      assert.ok(pattern, `premise: agents.js has ${name}`);
      assert.ok(mock.includes(`['${kind}', ${pattern}]`), `the mock's ${kind} pattern is ${pattern}`);
      assert.ok(rust.includes(`\`${name}\``), `the backend says it mirrors ${name}`);
    }

    const main = read('../../src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    const commands = read('../../src-tauri/src/commands/agent_history.rs');
    const signatures = {
      agent_history_list: '(app: AppHandle) -> Result<Vec<Entry>, String>',
      agent_history_groups: '(app: AppHandle) -> Result<GroupList, String>',
      agent_history_upsert: '(app: AppHandle, entry: Value, replaces: Option<String>, unarchive: Option<bool>) -> Result<Entry, String>',
      agent_history_update: '(app: AppHandle, key: String, changes: Value) -> Result<Option<Entry>, String>',
      agent_history_group_create: '(app: AppHandle, group: Value, move_key: Option<String>) -> Result<Group, String>',
      agent_history_group_update: '(app: AppHandle, id: String, changes: Value) -> Result<Option<Group>, String>',
      agent_history_group_delete: '(app: AppHandle, id: String) -> Result<Option<u32>, String>',
      agent_history_remove: '(app: AppHandle, key: String) -> Result<bool, String>',
      agent_history_clear: '(app: AppHandle) -> Result<u32, String>',
    };
    for (const [name, signature] of Object.entries(signatures)) {
      assert.ok(handler.includes(`commands::agent_history::${name},`), `${name} is in generate_handler!`);
      assert.ok(
        commands.includes(`#[tauri::command(rename_all = "snake_case")]\npub async fn ${name}${signature} {`),
        `${name}: snake_case arguments, an async fn on the blocking pool, ${signature}`
      );
    }
    assert.equal((commands.match(/#\[tauri::command/g) ?? []).length, 9, 'no other command there');
    assert.ok(commands.includes('spawn_blocking'), 'the blocking pool');
  };
  const BACKEND_FILES = [
    '../../src-tauri/src/agent_history.rs',
    '../../src/lib/ipc.js',
    '../../src/lib/agents.js',
    '../../src-tauri/src/main.rs',
    '../../src-tauri/src/commands/agent_history.rs',
  ];

  test('AH-20: the numbers, the id patterns and the commands are the backend’s', () => {
    theBackendsOwn(source);
  });

  test('AH-21: the same on a Windows checkout, every line ending in CRLF', () => {
    for (const relative of BACKEND_FILES) {
      // Premise: the copy has Windows' line ends, and only those.
      const copy = crlf(readFileSync(path.join(here, relative), 'utf8'));
      assert.ok(copy.includes('\r\n'), `premise: ${relative} has CRLF`);
      assert.ok(!/(^|[^\r])\n/.test(copy), `premise: ${relative} has no LF on its own`);
    }
    const read = (relative) => source(relative, crlf);
    theBackendsOwn(read);
    for (const relative of BACKEND_FILES) {
      assert.equal(read(relative), source(relative), `${relative} reads as it does with LF`);
    }
  });

  test('AH-99: teardown — the mock and the storage as they were', () => {
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      mockBridge.agentHistoryNewerSaid = before.newerSaid;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    }
    assert.equal(mockBridge.agentHistoryMemory, null, 'no history is left for another suite');
    assert.deepEqual(mockBridge.agentHistoryBad, []);
  });
});
