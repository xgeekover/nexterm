/**
 * What the user curates in AGENT SESSIONS (F18-F30), through the history
 * store (src/stores/agentHistoryStore.js) and the browser mock's file:
 * pin, rename, groups, archive, delete, and the questions asked first
 * (src/stores/agentHistoryPromptStore.js).
 *
 * AC32 — every store action changes the file as asked, survives a restart
 * (the stores started again from the mock's storage), and a write the
 * recorder queued just before it is sent first, so it cannot undo it.
 * AC33 (store part) — a name beats every automatic title, which keeps
 * changing underneath it. AC34 — a pinned, named or grouped Claude Code
 * entry never saved is kept at load, and a Resume that starts a new
 * conversation in its place carries its name, pin and group over (F22).
 * AC39 (store part) — the Delete, Delete Group and Clear questions. AC41
 * (store part) — archived entries come back when resumed. F30 — refusals
 * are said in the AGENT SESSIONS notice.
 *
 * Writes to the terminals are held; every backend call is logged with its
 * answer. AHG-99 puts the stores, the storage, the hooks and the mock back.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { ENTRY_GONE_TEXT, NOT_MOVED_TEXT, useAgentHistoryStore } from '../../src/stores/agentHistoryStore.js';
import {
  clearAgentHistory,
  clearAgentHistoryQuestion,
  deleteAgentGroup,
  deleteAgentGroupQuestion,
  deleteAgentSession,
  deleteAgentSessionQuestion,
  useAgentHistoryPromptStore,
} from '../../src/stores/agentHistoryPromptStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { isSessionIdFor } from '../../src/lib/agents.js';
import {
  HISTORY_CAP,
  agentSessionSections,
  carriedCuration,
  claudeHistoryChanges,
  historyDisplay,
  historyGroupName,
  historyMatches,
  isProtectedEntry,
  nextGroupName,
  queueUpsert,
  renameChange,
  unprotectedAfterUngrouping,
} from '../../src/lib/agentHistory.js';
import { CLAUDE_LOOKUP_TIMEOUT_MS, __setClaudeLookupTimeoutMs } from '../../src/lib/claudeConversations.js';

const T = terminalStore.useTerminalStore;
const H = useAgentHistoryStore;
const P = useAgentHistoryPromptStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const OTHER = '60a62d81-6923-4289-9d6d-7ce3f8f44043';
const THIRD = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FOURTH = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SES_A = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const KEY = `claude:${UUID}`;
/** The recorder's write delay here: long enough that a write is still queued when an action starts. */
const DELAY = 40;

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
const showTitle = (tab, title) => mockBridge.emit('pty-title', { session_id: tab.sessionId, title });
const titled = showTitle;
const aiTitle = (title, sessionId = UUID) => ({ type: 'ai-title', aiTitle: title, sessionId });

async function typeLine(tabId, text) {
  for (const key of text) await T.getState().writeRaw(tabId, key);
  await T.getState().writeRaw(tabId, '\r');
}

async function until(check, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function readyTerminal(cwd = null) {
  await T.getState().init();
  const tab = await T.getState().createTab(cwd ? { cwd } : {});
  assert.ok(tab, 'setup: a terminal');
  await prompt(tab);
  return tabById(tab.id);
}

const entry = (kind, sessionId, cwd = '/workspace/src', title = null, lastUsedAt = 2000) => ({
  kind, sessionId, cwd, title, startedAt: 1000, lastUsedAt, endedAt: lastUsedAt, endReason: 'closed',
});
/** Put `e` in the history straight through the mock; its key, as the backend made it. */
const remember = async (e) => (await mockBridge.invoke('agent_history_upsert', { entry: e })).key;
const fileText = () => mockBridge.agentHistoryFile() ?? '';
const fileDoc = () => JSON.parse(fileText());
const fileEntry = (key) => fileDoc().entries.find((e) => e.key === key);
const storeEntry = (key) => H.getState().entries.find((e) => e.key === key);
const keysListed = async () => (await mockBridge.invoke('agent_history_list')).map((e) => e.key);

// ---- A disk of our own, every backend call logged, everything put back --------

const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
let before = null;
/** Every backend call of the case, in order: `{ command, args, answer }`. Terminal writes are held. */
const log = [];
/** When set, `(command, args)` answers a call itself with `{ value }`; undefined lets the mock answer. */
let override = null;
const emptyStore = () => ({ entries: [], loaded: false, error: null, holders: {}, groups: [], readOnly: false, version: null });

async function fresh(fn, { record = true } = {}) {
  if (!before) {
    before = {
      storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      memory: mockBridge.agentHistoryMemory,
      bad: mockBridge.agentHistoryBad,
      transcripts: mockBridge.claudeTranscripts,
      markers: mockBridge.claudeSessionMarkers,
    };
  }
  backing.clear();
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  mockBridge.claudeTranscripts = null;
  mockBridge.claudeSessionMarkers = [];
  T.setState({ agentHistoryNotice: null });
  H.setState(emptyStore());
  log.length = 0;
  override = null;
  const unsink = setTerminalNoticeSink(() => true);
  const original = mockBridge.invoke;
  mockBridge.invoke = async function (command, args, ...rest) {
    const item = { command, args: args === undefined ? undefined : structuredClone(args) };
    log.push(item);
    if (command === 'pty_write') return null;
    const own = override ? await override(command, args) : undefined;
    const value = own ? own.value : await original.call(this, command, args, ...rest);
    item.answer = value === undefined ? undefined : structuredClone(value);
    return value;
  };
  try {
    if (record) {
      H.getState().start({ delayMs: DELAY });
      await H.getState().load();
    }
    await fn();
  } finally {
    override = null;
    await H.getState().stop();
    mockBridge.invoke = original;
    unsink();
    P.getState().answer(false);
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    mockBridge.agentSessions = [];
    mockBridge.claudeTranscripts = null;
    mockBridge.claudeSessionMarkers = [];
    __setClaudeLookupTimeoutMs(CLAUDE_LOOKUP_TIMEOUT_MS);
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  }
}

/** A restart of the page: the recorder stops, the store forgets, both come back from the mock's storage. */
async function relaunch() {
  await H.getState().stop();
  H.setState(emptyStore());
  mockBridge.agentHistoryMemory = null;
  H.getState().start({ delayMs: DELAY });
  await H.getState().load();
}

/** What was typed into the terminals since `mark`. */
const writesSince = (mark) =>
  log.slice(mark).filter((c) => c.command === 'pty_write').map((c) => ({ session: c.args?.session_id, data: c.args?.data }));

/** Resume `key` from the history in a new terminal, drawing its first prompt once it is there. */
async function resumeNew(key) {
  const tabsBefore = T.getState().tabs.length;
  const mark = log.length;
  const pending = T.getState().resumeFromHistory(key);
  await until(() => T.getState().tabs.length > tabsBefore && tabById(T.getState().activeTabId)?.agentHistoryKey === key, 'the new terminal');
  const tab = tabById(T.getState().activeTabId);
  await sleep(20);
  assert.deepEqual(writesSince(mark), [], 'nothing typed before the shell’s first prompt');
  await prompt(tab);
  const result = await pending;
  return { result, tab: tabById(tab.id) ?? tab, writes: writesSince(mark) };
}

/** The id of the new conversation typed in place of one never saved. */
function freshConversationTyped(writes, tab, oldId) {
  assert.equal(writes.length, 1, `one line typed: ${JSON.stringify(writes)}`);
  const match = /^claude --session-id ([0-9a-f-]{36})\r$/.exec(writes[0].data);
  assert.ok(match, `exactly \`claude --session-id <uuid>\\r\`: ${JSON.stringify(writes[0].data)}`);
  assert.equal(writes[0].session, tab.sessionId);
  assert.ok(isSessionIdFor('claude', match[1]) && match[1] !== oldId);
  return match[1];
}

// ---- AC32: the store actions -------------------------------------------------

describe('Agent session history: what the user curates (F18-F30)', () => {
  test('AHG-01: pin, unpin, rename, rename to empty, groups, archive, delete — each in the file, after a restart, and not undone by a write queued just before (AC32)', async () => {
    await fresh(async () => {
      const tab = await readyTerminal('/workspace/src');
      const agent = await T.getState().startAgent(tab.id, 'claude');
      await H.getState().flush();
      const K = `claude:${agent.sessionId}`;
      const O = await remember(entry('claude', OTHER, '/workspace/tests', 'Other one'));
      await H.getState().load();
      assert.ok(storeEntry(K) && storeEntry(O), 'premise: both listed');
      const groups = {};
      let n = 0;

      /**
       * A live title queues an upsert of K; `action` runs at once; `command`
       * (the action's backend call, or null for none) must come after that
       * upsert. `check(result, when)` runs before and after a restart.
       */
      const step = async (what, command, action, check) => {
        n += 1;
        const title = `Step ${n}`;
        const mark = log.length;
        await showTitle(tab, `\u2733 ${title}`);
        const result = await action();
        // A declined action sends nothing, and the queued write goes when its
        // wait is over; one that went ahead sent it first.
        await H.getState().flush();
        const sent = log.slice(mark).map((c) => c.command);
        const up = log.slice(mark).findIndex((c) => c.command === 'agent_history_upsert' && c.args?.entry?.title === title);
        assert.ok(up !== -1, `${what}: the queued write was sent: ${sent}`);
        if (command) {
          const at = sent.indexOf(command);
          assert.ok(at > up, `${what}: after the write queued before it: ${sent}`);
        }
        const kept = fileEntry(K);
        if (kept) assert.equal(kept.title, title, `${what}: the queued write is in the file`);
        check(result, what);
        await relaunch();
        check(result, `${what}, after a restart`);
        return sent;
      };

      await step('pin', 'agent_history_update', () => H.getState().pin(K), (r, w) => {
        assert.equal(r?.pinned, true, w);
        assert.equal(fileEntry(K).pinned, true, w);
        assert.equal(fileDoc().version, 2, `${w}: version 2`);
        assert.equal(storeEntry(K).pinned, true, w);
        assert.equal(H.getState().version, 2, w);
      });
      await step('unpin', 'agent_history_update', () => H.getState().unpin(K), (r, w) => {
        assert.ok(!('pinned' in fileEntry(K)), w);
        assert.equal(fileDoc().version, 1, `${w}: nothing curated, version 1 again`);
        assert.equal(storeEntry(K).pinned, undefined, w);
      });
      await step('rename', 'agent_history_update', () => H.getState().rename(K, '  Launch plan  '), (r, w) => {
        assert.equal(fileEntry(K).name, 'Launch plan', w);
        assert.equal(historyDisplay(storeEntry(K)).title, 'Launch plan', w);
      });
      await step('rename to empty', 'agent_history_update', () => H.getState().rename(K, '   '), (r, w) => {
        assert.ok(!('name' in fileEntry(K)), w);
        assert.equal(historyDisplay(storeEntry(K)).title, fileEntry(K).title, `${w}: the automatic title shows`);
      });
      await step('New Group with the entry', 'agent_history_group_create', () => H.getState().createGroup({ moveKey: K }), (r, w) => {
        groups.first = r;
        assert.equal(r?.name, 'New Group', w);
        assert.deepEqual(fileDoc().groups, [{ id: r.id, name: 'New Group', collapsed: false }], w);
        assert.equal(fileEntry(K).groupId, r.id, w);
        assert.deepEqual(H.getState().groups, [{ id: r.id, name: 'New Group', collapsed: false }], w);
      });
      await step('New Group, empty', 'agent_history_group_create', () => H.getState().createGroup(), (r, w) => {
        groups.second = r;
        assert.equal(r?.name, 'New Group 2', `${w}: the first free name`);
        assert.deepEqual(H.getState().groups.map((g) => g.name), ['New Group', 'New Group 2'], w);
        assert.equal(fileEntry(K).groupId, groups.first.id, w);
      });
      await step('move to an existing group', 'agent_history_update', () => H.getState().moveToGroup(K, groups.second.id), (r, w) => {
        assert.equal(fileEntry(K).groupId, groups.second.id, w);
        assert.equal(storeEntry(K).groupId, groups.second.id, w);
      });
      await step('remove from group', 'agent_history_update', () => H.getState().removeFromGroup(K), (r, w) => {
        assert.ok(!('groupId' in fileEntry(K)), w);
        assert.equal(H.getState().groups.length, 2, `${w}: the groups stay`);
      });
      await step('archive', 'agent_history_update', () => H.getState().archive(K), (r, w) => {
        assert.equal(fileEntry(K).archived, true, w);
        const sections = agentSessionSections(H.getState().entries, H.getState().groups);
        assert.deepEqual(sections.archived.map((e) => e.key), [K], w);
        assert.equal(sections.count, 1, `${w}: the count leaves it out`);
      });
      await step('unarchive', 'agent_history_update', () => H.getState().unarchive(K), (r, w) => {
        assert.ok(!('archived' in fileEntry(K)), w);
      });
      await step('rename group', 'agent_history_group_update', () => H.getState().renameGroup(groups.first.id, '  Work  '), (r, w) => {
        assert.equal(r?.name, 'Work', w);
        assert.equal(fileDoc().groups[0].name, 'Work', w);
      });
      const sentForEmpty = await step('rename group to empty', null, () => H.getState().renameGroup(groups.first.id, '  '), (r, w) => {
        assert.equal(fileDoc().groups[0].name, 'Work', `${w}: the old name kept`);
        assert.equal(H.getState().groups[0].name, 'Work', w);
      });
      assert.ok(!sentForEmpty.includes('agent_history_group_update'), 'nothing sent for an empty name');
      await step('collapse group', 'agent_history_group_update', () => H.getState().setGroupCollapsed(groups.first.id, true), (r, w) => {
        assert.equal(fileDoc().groups[0].collapsed, true, w);
        assert.equal(H.getState().groups[0].collapsed, true, w);
      });
      await step('move the other one in', 'agent_history_update', () => H.getState().moveToGroup(O, groups.first.id), (r, w) => {
        assert.equal(fileEntry(O).groupId, groups.first.id, w);
      });
      const sentDeclined = await step('delete group, declined', null, () => H.getState().deleteGroup(groups.first.id, { confirm: async () => false }), (r, w) => {
        assert.equal(r, null, w);
        assert.equal(fileEntry(O).groupId, groups.first.id, w);
        assert.equal(fileDoc().groups.length, 2, w);
      });
      assert.ok(!sentDeclined.includes('agent_history_group_delete'), 'declined: nothing sent');
      await step('delete group', 'agent_history_group_delete', () => H.getState().deleteGroup(groups.first.id, { confirm: async () => true }), (r, w) => {
        assert.equal(r, 1, `${w}: one entry ungrouped`);
        assert.deepEqual(fileDoc().groups.map((g) => g.id), [groups.second.id], w);
        assert.ok(fileEntry(O) && !('groupId' in fileEntry(O)), `${w}: the member stays, ungrouped`);
      });
      await step('delete, declined', null, () => H.getState().deleteEntry(K, { confirm: async () => false }), (r, w) => {
        assert.equal(r, null, w);
        assert.ok(fileEntry(K), w);
      });
      await step('delete', 'agent_history_remove', () => H.getState().deleteEntry(K, { confirm: async () => true }), (r, w) => {
        assert.equal(r, true, w);
        assert.equal(fileEntry(K), undefined, w);
        assert.equal(storeEntry(K), undefined, w);
        assert.ok(fileEntry(O), `${w}: only that one`);
      });
      assert.equal(T.getState().agentHistoryNotice, null, 'nothing was refused');
    });
  });

  test('AHG-02: refused or failed — 51st group, a newer file — said in the AGENT SESSIONS notice with the backend’s words, the list read again (F30)', async () => {
    await fresh(async () => {
      const k = await remember(entry('claude', UUID));
      for (let i = 0; i < 50; i += 1) {
        await mockBridge.invoke('agent_history_group_create', { group: { id: `g${i}`, name: `G ${i}` } });
      }
      await H.getState().load();
      assert.equal(H.getState().groups.length, 50);
      assert.equal(await H.getState().createGroup({ moveKey: k }), null);
      const notice = T.getState().agentHistoryNotice;
      assert.equal(notice?.kind, 'curationFailed');
      assert.equal(notice.text, 'There can be at most 50 agent session groups');
      assert.equal(H.getState().groups.length, 50, 'read again: still 50');
      assert.equal(storeEntry(k).groupId, undefined, 'and the entry was not moved');

      const doc = fileDoc();
      mockBridge.agentHistoryCorruptFile(JSON.stringify({ ...doc, version: 3 }));
      const text = fileText();
      await H.getState().load();
      assert.equal(H.getState().readOnly, true, 'a newer file: read only');
      assert.equal(H.getState().version, 3);
      T.setState({ agentHistoryNotice: null });
      assert.equal(await H.getState().pin(k), null);
      assert.match(T.getState().agentHistoryNotice?.text ?? '', /^The agent session history was written by a newer NexTerm \(format version 3\)/);
      assert.equal(await H.getState().deleteEntry(k), false, 'delete refused too');
      assert.equal(fileText(), text, 'the newer file is untouched');
      assert.ok(storeEntry(k), 'and still listed');
    });
  });

  test('AHG-03: a groups read that fails leaves the list read working; entries and groups are set together (F20)', async () => {
    await fresh(async () => {
      const k = await remember(entry('claude', UUID));
      await mockBridge.invoke('agent_history_group_create', { group: { id: 'g1', name: 'One' }, move_key: k });
      await H.getState().load();
      assert.deepEqual(H.getState().groups, [{ id: 'g1', name: 'One', collapsed: false }]);
      override = (command) => {
        if (command === 'agent_history_groups') throw new Error('not answered');
        return undefined;
      };
      await remember(entry('claude', OTHER));
      await H.getState().load();
      assert.deepEqual(H.getState().entries.map((e) => e.key).sort(), [KEY, `claude:${OTHER}`].sort(), 'the list was read');
      assert.deepEqual(H.getState().groups, [{ id: 'g1', name: 'One', collapsed: false }], 'the groups it had stay');
      override = null;
      const seen = [];
      const stop = H.subscribe((s) => seen.push(`${s.entries.length}/${s.groups.length}`));
      await remember(entry('claude', THIRD));
      await mockBridge.invoke('agent_history_group_create', { group: { id: 'g2', name: 'Two' } });
      await H.getState().load();
      stop();
      assert.ok(seen.includes('3/2'), `read: ${seen}`);
      assert.ok(seen.every((x) => x === '2/1' || x === '3/2'), `never new entries with old groups, nor the reverse: ${seen}`);
    });
  });

  test('AHG-04: a change to an entry re-keyed while it waited is said in the notice, not lost silently; New Group… makes the group all the same (FX-4)', async () => {
    const previousDelay = terminalStore.__setAgentResolveDelayMs(5);
    const previousRetry = terminalStore.__setAgentResolveRetryMs([]);
    const SES_B = 'ses_bbbbbbbbbbbbBBBBBBBBBBBBBB';
    /**
     * OpenCode in a new terminal in `cwd`: its provisional entry written and
     * listed, then its id `id` learned — that write (an `idLearned` with
     * `replaces`) left queued. The provisional key, and the one it becomes.
     */
    const learnedButQueued = async (cwd, id) => {
      const tab = await readyTerminal(cwd);
      await typeLine(tab.id, 'opencode');
      await H.getState().flush();
      const oldKey = `opencode:~${cwd}\u0000`;
      assert.ok(storeEntry(oldKey), `premise: the provisional entry ${JSON.stringify(oldKey)} is listed`);
      mockBridge.agentSessions = [{ id, title: 'Fix the build', updated: 200, created: 100, directory: cwd }];
      const mark = log.length;
      await started(tab);
      await titled(tab, 'OC | Fix the build');
      await until(() => tabById(tab.id).agent?.sessionId === id, 'the id learned');
      assert.ok(!log.slice(mark).some((c) => c.command === 'agent_history_upsert'), 'premise: its write is still queued');
      return { oldKey, newKey: `opencode:${id}` };
    };
    const sentSince = (mark, command) => log.slice(mark).filter((c) => c.command === command);
    try {
      await fresh(
        async () => {
          // The queue waits until it is sent, so the re-keying write is surely queued.
          H.getState().start({ delayMs: 60_000 });
          await H.getState().load();
          const { oldKey, newKey } = await learnedButQueued('/workspace/src', SES_A);
          await mockBridge.invoke('agent_history_group_create', { group: { id: 'g1', name: 'Work' } });

          T.setState({ agentHistoryNotice: null });
          let mark = log.length;
          assert.equal(await H.getState().pin(oldKey), null, 'pin: no entry to answer with');
          const [upsert] = sentSince(mark, 'agent_history_upsert');
          assert.ok(upsert?.args?.replaces, 'the queued idLearned went first, with replaces');
          const [update] = sentSince(mark, 'agent_history_update');
          assert.ok(log.indexOf(upsert) < log.indexOf(update), 'and only then the pin');
          assert.deepEqual([update.args.key, update.answer], [oldKey, null], 'the pin found no entry under the old key');
          assert.deepEqual(T.getState().agentHistoryNotice?.kind, 'curationFailed');
          assert.equal(
            T.getState().agentHistoryNotice.text,
            'The list changed before this could be done. If the session is still listed, try again.'
          );
          assert.equal(storeEntry(oldKey), undefined, 'the list was read again');
          assert.ok(storeEntry(newKey), 'the entry is listed under its new key');
          assert.notEqual(storeEntry(newKey).pinned, true, 'and is not pinned');
          assert.notEqual(fileEntry(newKey).pinned, true, 'nor in the file');

          // Every other change to the entry under a key that is gone: the same.
          for (const [what, act] of [
            ['unpin', () => H.getState().unpin(oldKey)],
            ['archive', () => H.getState().archive(oldKey)],
            ['unarchive', () => H.getState().unarchive(oldKey)],
            ['move to a group', () => H.getState().moveToGroup(oldKey, 'g1')],
            ['remove from its group', () => H.getState().removeFromGroup(oldKey)],
            ['rename', () => H.getState().rename(oldKey, 'Mine')],
          ]) {
            T.setState({ agentHistoryNotice: null });
            mark = log.length;
            assert.equal(await act(), null, what);
            assert.equal(sentSince(mark, 'agent_history_update').length, 1, `${what}: sent`);
            assert.equal(T.getState().agentHistoryNotice?.text, ENTRY_GONE_TEXT, `${what}: said`);
          }
          // A rename that changes nothing sends nothing and says nothing, the
          // entry gone or not; nor does a fold of a group that is gone.
          T.setState({ agentHistoryNotice: null });
          mark = log.length;
          assert.equal(await H.getState().rename(oldKey, '  '), null);
          assert.equal((await H.getState().rename(newKey, ''))?.key, newKey, 'nothing to change: the entry as listed');
          assert.equal(sentSince(mark, 'agent_history_update').length, 0, 'nothing sent');
          assert.equal(await H.getState().setGroupCollapsed('gone', true), null);
          assert.equal(T.getState().agentHistoryNotice, null, 'and nothing said');
          assert.deepEqual(Object.keys(fileEntry(newKey)).filter((f) => ['name', 'pinned', 'archived', 'groupId'].includes(f)), [], 'nothing curated on the way');

          // New Group… on a row re-keyed while it waited.
          const second = await learnedButQueued('/workspace/tests', SES_B);
          T.setState({ agentHistoryNotice: null });
          mark = log.length;
          const group = await H.getState().createGroup({ moveKey: second.oldKey });
          assert.deepEqual(sentSince(mark, 'agent_history_group_create').map((c) => c.args.move_key), [second.oldKey]);
          assert.ok(group && group.name === 'New Group' && group.collapsed === false, `the group is resolved: ${JSON.stringify(group)}`);
          assert.ok(H.getState().groups.some((g) => g.id === group.id), 'and stays');
          assert.equal(T.getState().agentHistoryNotice?.kind, 'curationFailed');
          assert.equal(
            T.getState().agentHistoryNotice.text,
            'The group was made, but the list changed first and the session is not in it. If the session is still listed, move it to the group.'
          );
          assert.equal(T.getState().agentHistoryNotice.text, NOT_MOVED_TEXT);
          assert.deepEqual(H.getState().entries.filter((e) => e.groupId === group.id), [], 'a group with no member');
          assert.ok(storeEntry(second.newKey) && fileEntry(second.newKey).groupId === undefined, 'the session is listed, in no group');

          // And New Group… whose session is moved says nothing.
          T.setState({ agentHistoryNotice: null });
          const moved = await H.getState().createGroup({ moveKey: second.newKey });
          assert.equal(storeEntry(second.newKey).groupId, moved.id);
          assert.equal(T.getState().agentHistoryNotice, null);
        },
        { record: false }
      );
    } finally {
      terminalStore.__setAgentResolveDelayMs(previousDelay);
      terminalStore.__setAgentResolveRetryMs(previousRetry);
    }
  });

  // ---- AC33 (store part): the name beats every automatic title -----------------

  test('AHG-10: a renamed Claude Code entry keeps its name after the F16 lookup at load, at agent end and after a restart; the title changes underneath; an empty name shows the newest title (AC33)', async () => {
    await fresh(async () => {
      await remember(entry('claude', UUID, '/workspace/src', 'Old title'));
      await H.getState().load();
      await H.getState().rename(KEY, 'My name');
      mockBridge.claudeTranscripts = { [UUID]: [aiTitle('Fresh title')] };
      await H.getState().load();
      assert.deepEqual([fileEntry(KEY).name, fileEntry(KEY).title], ['My name', 'Fresh title'], 'the lookup at load: title underneath');
      const shown = historyDisplay(storeEntry(KEY));
      assert.deepEqual([shown.title, shown.name, shown.autoTitle, shown.titled], ['My name', 'My name', 'Fresh title', true], 'the side bar data');
      await relaunch();
      assert.equal(historyDisplay(storeEntry(KEY)).title, 'My name', 'after a restart');

      // At agent end.
      const tab = await readyTerminal('/workspace/src');
      const agent = await T.getState().startAgent(tab.id, 'claude');
      await H.getState().flush();
      const K = `claude:${agent.sessionId}`;
      await H.getState().rename(K, 'Kept');
      mockBridge.claudeTranscripts = { [agent.sessionId]: [aiTitle('From the transcript', agent.sessionId)] };
      await T.getState().closeTab(tab.id);
      await H.getState().flush();
      await until(() => storeEntry(K)?.title === 'From the transcript', 'the lookup at the end');
      assert.equal(fileEntry(K).name, 'Kept', 'the name stays');
      assert.equal(historyDisplay(storeEntry(K)).title, 'Kept');
      await relaunch();
      assert.equal(historyDisplay(storeEntry(K)).title, 'Kept', 'after a restart');
      assert.equal(storeEntry(K).title, 'From the transcript');

      // Renaming to empty shows the newest automatic title.
      await H.getState().rename(K, '');
      assert.equal(historyDisplay(storeEntry(K)).title, 'From the transcript');
      // The automatic title as the name while none is set: nothing to change.
      const mark = log.length;
      await H.getState().rename(K, ' From the transcript ');
      assert.ok(!log.slice(mark).some((c) => c.command === 'agent_history_update'), 'nothing sent');
      assert.equal(storeEntry(K).name, undefined);
    });
  });

  test('AHG-11: a renamed OpenCode entry keeps its name after a titled event; the title changes underneath (AC33)', async () => {
    const previousDelay = terminalStore.__setAgentResolveDelayMs(5);
    const previousRetry = terminalStore.__setAgentResolveRetryMs([]);
    try {
      await fresh(async () => {
        const tab = await readyTerminal('/workspace/src');
        mockBridge.agentSessions = [{ id: SES_A, title: 'Fix the build', updated: 200, created: 100, directory: tab.cwd }];
        await typeLine(tab.id, 'opencode');
        await started(tab);
        await titled(tab, 'OC | Fix the build');
        await sleep(40);
        await H.getState().flush();
        const K = `opencode:${SES_A}`;
        assert.ok(storeEntry(K), 'premise: the id was learned and recorded');
        await H.getState().rename(K, 'Mine');
        mockBridge.agentSessions = [{ id: SES_A, title: 'Fix the build on Windows', updated: 300, created: 100, directory: tab.cwd }];
        await titled(tab, 'OC | Fix the build on Windows');
        await sleep(40);
        await H.getState().flush();
        assert.deepEqual([fileEntry(K).name, fileEntry(K).title], ['Mine', 'Fix the build on Windows']);
        assert.equal(historyDisplay(storeEntry(K)).title, 'Mine');
        await relaunch();
        assert.equal(historyDisplay(storeEntry(K)).title, 'Mine', 'after a restart');
      });
    } finally {
      terminalStore.__setAgentResolveDelayMs(previousDelay);
      terminalStore.__setAgentResolveRetryMs(previousRetry);
    }
  });

  // ---- AC34: never saved, and curated (F22) ---------------------------------------

  test('AHG-20: at load, a pinned, renamed or grouped Claude Code entry reported never saved stays; an unprotected one goes (AC34)', async () => {
    await fresh(async () => {
      await remember(entry('claude', UUID));
      await remember(entry('claude', OTHER));
      await remember(entry('claude', THIRD));
      await remember(entry('claude', FOURTH));
      await H.getState().load();
      await H.getState().pin(KEY);
      await H.getState().rename(`claude:${OTHER}`, 'Named');
      const g = await H.getState().createGroup({ name: 'Keep', moveKey: `claude:${THIRD}` });
      assert.ok(g);
      mockBridge.claudeTranscripts = {};
      mockBridge.claudeSessionMarkers = [UUID, OTHER, THIRD, FOURTH];
      await H.getState().load();
      const keys = await keysListed();
      assert.ok(keys.includes(KEY), 'pinned: kept');
      assert.ok(keys.includes(`claude:${OTHER}`), 'named: kept');
      assert.ok(keys.includes(`claude:${THIRD}`), 'grouped: kept');
      assert.ok(!keys.includes(`claude:${FOURTH}`), 'unprotected: removed, as before');
    });
  });

  test('AHG-21: resuming a protected never-saved entry starts a new conversation that takes its name, pin and group; the old entry goes, after the new one answered (AC34, F22)', async () => {
    await fresh(async () => {
      await readyTerminal();
      await remember(entry('claude', UUID, '/workspace/src'));
      await H.getState().load();
      const g = await H.getState().createGroup({ name: 'Keep', moveKey: KEY });
      await H.getState().rename(KEY, 'Named one');
      await H.getState().pin(KEY);
      mockBridge.claudeTranscripts = { [OTHER]: [aiTitle('Someone else', OTHER)] };
      mockBridge.claudeSessionMarkers = [UUID];
      const mark = log.length;
      const { result, tab, writes } = await resumeNew(KEY);
      const id = freshConversationTyped(writes, tab, UUID);
      assert.equal(result.notice?.kind, 'newConversation', 'prior AC24: the pick says so');
      await H.getState().flush();
      const NEW = `claude:${id}`;
      const kept = fileEntry(NEW);
      assert.ok(kept, 'the new conversation is recorded');
      assert.deepEqual([kept.name, kept.pinned, kept.groupId], ['Named one', true, g.id], 'with the old one’s name, pin and group');
      assert.equal(fileEntry(KEY), undefined, 'the old entry is gone');
      const after = log.slice(mark);
      const upNew = after.findIndex((c) => c.command === 'agent_history_upsert' && c.args?.entry?.sessionId === id);
      const update = after.findIndex((c) => c.command === 'agent_history_update' && c.args?.key === NEW);
      const removal = after.findIndex((c) => c.command === 'agent_history_remove' && c.args?.key === KEY);
      assert.ok(upNew !== -1 && upNew < update && update < removal, `the new entry written, then the update, then the removal: ${upNew} ${update} ${removal}`);
      assert.equal(after[update].answer?.key, NEW, 'the update found the new entry');
      assert.deepEqual(after[update].args.changes, { name: 'Named one', pinned: true, groupId: g.id });
      assert.equal(historyDisplay(storeEntry(NEW)).title, 'Named one', 'the side bar shows the name');
      await relaunch();
      assert.deepEqual([storeEntry(NEW)?.name, storeEntry(NEW)?.pinned, storeEntry(NEW)?.groupId], ['Named one', true, g.id], 'after a restart');
    });
  });

  test('AHG-22: when the new conversation’s entry is not there to take them, the old one stays with its name (F22)', async () => {
    await fresh(async () => {
      await readyTerminal();
      await remember(entry('claude', UUID, '/workspace/src'));
      await H.getState().load();
      await H.getState().rename(KEY, 'Named one');
      mockBridge.claudeTranscripts = { [OTHER]: [aiTitle('Someone else', OTHER)] };
      mockBridge.claudeSessionMarkers = [UUID];
      override = (command, args) => (command === 'agent_history_update' && args?.key !== KEY ? { value: null } : undefined);
      const { tab, writes } = await resumeNew(KEY);
      const id = freshConversationTyped(writes, tab, UUID);
      await H.getState().flush();
      assert.equal(fileEntry(KEY)?.name, 'Named one', 'the old one stays, named');
      assert.ok(fileEntry(`claude:${id}`), 'beside the new one');
      assert.ok(!log.some((c) => c.command === 'agent_history_remove' && c.args?.key === KEY), 'never removed');
    });
  });

  // ---- AC41 (store part): archived, and resumed ----------------------------------

  test('AHG-30: resuming an archived entry no terminal holds opens it; the resumed write unarchives it and keeps its name, pin and group (AC41)', async () => {
    await fresh(async () => {
      await readyTerminal();
      await remember(entry('claude', UUID, '/workspace/src'));
      await H.getState().load();
      const g = await H.getState().createGroup({ name: 'Keep', moveKey: KEY });
      await H.getState().rename(KEY, 'Named');
      await H.getState().pin(KEY);
      await H.getState().archive(KEY);
      assert.equal(fileEntry(KEY).archived, true, 'premise');
      const mark = log.length;
      const { result, writes } = await resumeNew(KEY);
      assert.equal(result.outcome, 'opened');
      assert.equal(writes[0]?.data, `claude --resume ${UUID}\r`);
      await H.getState().flush();
      const kept = fileEntry(KEY);
      assert.ok(!('archived' in kept), 'no longer archived');
      assert.deepEqual([kept.name, kept.pinned, kept.groupId], ['Named', true, g.id]);
      const resumed = log.slice(mark).find((c) => c.command === 'agent_history_upsert' && c.args?.entry?.sessionId === UUID);
      assert.equal(resumed?.args?.unarchive, true, 'the resumed write says unarchive');
    });
  });

  test('AHG-31: picking an archived entry a terminal holds focuses that terminal and unarchives it (AC41, prior AC14)', async () => {
    await fresh(async () => {
      const tab = await readyTerminal('/workspace/src');
      const agent = await T.getState().startAgent(tab.id, 'claude');
      await H.getState().flush();
      const K = `claude:${agent.sessionId}`;
      await H.getState().archive(K);
      await readyTerminal();
      const tabsBefore = T.getState().tabs.length;
      const result = await T.getState().resumeFromHistory(K);
      assert.equal(result.outcome, 'focused');
      assert.equal(result.tabId, tab.id);
      assert.equal(T.getState().activeTabId, tab.id, 'that terminal is the active one');
      assert.equal(T.getState().tabs.length, tabsBefore, 'no new terminal');
      await H.getState().flush();
      assert.ok(!('archived' in fileEntry(K)), 'unarchived');
      assert.ok(log.some((c) => c.command === 'agent_history_update' && c.args?.key === K && c.args?.changes?.archived === false));
      // Not archived: a focus writes nothing more.
      const mark = log.length;
      await T.getState().resumeFromHistory(K);
      await H.getState().flush();
      assert.ok(!log.slice(mark).some((c) => c.command === 'agent_history_update'), 'nothing to unarchive');
    });
  });

  test('AHG-32: an agent that starts again under an archived id-less key unarchives it; its end never does (AC41, F29)', async () => {
    await fresh(async () => {
      const tab = await readyTerminal('/workspace/tests');
      await typeLine(tab.id, 'claude');
      await started(tab);
      await H.getState().flush();
      const key = H.getState().entries.find((e) => e.kind === 'claude' && e.sessionId === null)?.key;
      assert.ok(key, 'premise: an id-less entry');
      await H.getState().archive(key);
      const mark = log.length;
      await prompt(tab);
      await H.getState().flush();
      assert.equal(fileEntry(key).endReason, 'exited', 'premise: it ended');
      assert.equal(fileEntry(key).archived, true, 'an end never unarchives');
      const ended = log.slice(mark).find((c) => c.command === 'agent_history_upsert');
      assert.equal(ended?.args?.unarchive, undefined);
      await typeLine(tab.id, 'claude');
      await started(tab);
      await H.getState().flush();
      assert.ok(!('archived' in fileEntry(key)), 'started again: unarchived');
    });
  });

  // ---- AC39 (store part): the questions -------------------------------------------

  test('AHG-40: Delete… and Delete Group… ask first; No changes nothing; Clear’s question keeps its words and names the groups; the transcripts are never touched (AC39)', async () => {
    await fresh(async () => {
      const K1 = await remember(entry('claude', UUID, '/workspace/src', 'First'));
      const K2 = await remember(entry('opencode', SES_A, '/workspace/tests', 'Second'));
      await H.getState().load();
      mockBridge.claudeTranscripts = { [UUID]: [aiTitle('First')] };
      const transcripts = structuredClone(mockBridge.claudeTranscripts);

      const textBefore = fileText();
      let pending = deleteAgentSession(K1);
      let asked = P.getState().prompt;
      assert.equal(asked?.kind, 'delete');
      assert.equal(asked.key, K1);
      assert.equal(asked.question.title, 'Delete Agent Session?');
      assert.equal(asked.question.confirmLabel, 'Delete');
      assert.match(asked.question.message, /\u201CFirst\u201D/, 'names the entry');
      assert.match(asked.question.message, /stays with Claude Code, and NexTerm deletes none of its files/);
      P.getState().answer(false);
      assert.equal(await pending, null, 'Cancel');
      assert.equal(fileText(), textBefore, 'Cancel changes nothing');
      pending = deleteAgentSession(K1);
      P.getState().answer(true);
      assert.equal(await pending, true);
      assert.deepEqual(await keysListed(), [K2], 'only that entry went');
      assert.deepEqual(mockBridge.claudeTranscripts, transcripts, 'the transcripts are untouched by a delete');
      assert.match(deleteAgentSessionQuestion(storeEntry(K2)).message, /stays with OpenCode, and NexTerm deletes none of its files/);

      const g = await H.getState().createGroup({ name: 'Work', moveKey: K2 });
      pending = deleteAgentGroup(g.id);
      asked = P.getState().prompt;
      assert.equal(asked?.kind, 'deleteGroup');
      assert.equal(asked.groupId, g.id);
      assert.equal(asked.count, 1);
      assert.equal(asked.question.title, 'Delete Group?');
      assert.match(asked.question.message, /\u201CWork\u201D will be deleted\. Its 1 session goes back to the list; none is deleted\.$/);
      P.getState().answer(false);
      assert.equal(await pending, null);
      assert.equal(fileEntry(K2).groupId, g.id, 'No: still grouped');
      pending = deleteAgentGroup(g.id);
      P.getState().answer(true);
      assert.equal(await pending, 1);
      assert.deepEqual(H.getState().groups, []);
      assert.ok(fileEntry(K2) && !('groupId' in fileEntry(K2)), 'the member went back to the list');

      await H.getState().createGroup({ name: 'Again' });
      const q = clearAgentHistoryQuestion(2);
      assert.match(q.message, /^2 entries will be removed from AGENT SESSIONS, with the damaged copies/);
      assert.match(q.message, /every group goes too/);
      pending = clearAgentHistory();
      asked = P.getState().prompt;
      assert.equal(asked?.kind, 'clear');
      assert.equal(asked.count, 1);
      assert.equal(asked.question.title, 'Clear Agent Session History?');
      P.getState().answer(true);
      assert.equal(await pending, 1);
      assert.deepEqual(fileDoc(), { version: 1, entries: [] }, 'entries and groups gone');
      assert.deepEqual(H.getState().groups, []);
      assert.deepEqual(mockBridge.claudeTranscripts, transcripts, 'and by a clear');

      const beyond = deleteAgentGroupQuestion({ name: 'G' }, { members: 3, beyondCap: true }).message;
      assert.match(beyond, /Its 3 sessions go back to the list; none is deleted\. The oldest sessions beyond the 200 most recently used leave the list the next time NexTerm records a session event\.$/);
    });
  });

  test('AHG-41: Delete Group…’s question stays true for a group with a pinned and an archived member: they leave the group and stay where they are (FX-5)', async () => {
    await fresh(async () => {
      const plain = await remember(entry('claude', UUID, '/workspace/src', 'Plain', 2000));
      const pinned = await remember(entry('claude', OTHER, '/workspace/src', 'Pinned', 2100));
      const archived = await remember(entry('claude', THIRD, '/workspace/src', 'Archived', 2200));
      await H.getState().load();
      const g = await H.getState().createGroup({ name: 'Work', moveKey: plain });
      await H.getState().moveToGroup(pinned, g.id);
      await H.getState().moveToGroup(archived, g.id);
      await H.getState().pin(pinned);
      await H.getState().archive(archived);
      assert.deepEqual(
        [plain, pinned, archived].map((k) => [storeEntry(k).groupId, storeEntry(k).pinned === true, storeEntry(k).archived === true]),
        [[g.id, false, false], [g.id, true, false], [g.id, false, true]],
        'premise: one plain, one pinned and one archived member'
      );
      assert.equal(T.getState().agentHistoryNotice, null, 'premise: nothing refused');

      const pending = deleteAgentGroup(g.id);
      const asked = P.getState().prompt;
      assert.deepEqual([asked?.kind, asked?.groupId, asked?.count], ['deleteGroup', g.id, 3], 'the number: every entry the delete ungroups');
      assert.equal(
        asked.question.message,
        'The group “Work” will be deleted. Its 3 sessions leave the group; pinned and archived ones stay where they are, and none is deleted.'
      );
      assert.ok(!/back to the list/.test(asked.question.message), 'it does not say they all go back to the list');
      P.getState().answer(true);
      assert.equal(await pending, 3);
      // What it said is what happened: none deleted, the pinned one still pinned, the archived one still archived.
      assert.deepEqual(
        [plain, pinned, archived].map((k) => [fileEntry(k).groupId, fileEntry(k).pinned === true, fileEntry(k).archived === true]),
        [[undefined, false, false], [undefined, true, false], [undefined, false, true]]
      );

      // The pure question: the plain form unchanged, the other with either count, and the cap sentence after either.
      const words = (options) => deleteAgentGroupQuestion({ name: 'G' }, options).message;
      assert.equal(words({ members: 3 }), 'The group “G” will be deleted. Its 3 sessions go back to the list; none is deleted.');
      assert.equal(words({ members: 3, staying: 0 }), words({ members: 3 }), 'none pinned or archived: the words as they were');
      assert.equal(words({ members: 1, staying: 1 }), 'The group “G” will be deleted. Its 1 session leaves the group and stays where it is; none is deleted.');
      assert.equal(words({ members: 2, staying: 2 }), 'The group “G” will be deleted. Its 2 sessions leave the group; pinned and archived ones stay where they are, and none is deleted.');
      const cap = ' The oldest sessions beyond the 200 most recently used leave the list the next time NexTerm records a session event.';
      assert.equal(words({ members: 3, staying: 1, beyondCap: true }), `${words({ members: 3, staying: 1 })}${cap}`);
      assert.equal(words({ members: 3, beyondCap: true }), `${words({ members: 3 })}${cap}`);
    });
  });

  // ---- The pure parts -----------------------------------------------------------

  test('AHG-50: renameChange, historyGroupName, nextGroupName, isProtectedEntry, carriedCuration', () => {
    const e = { key: KEY, kind: 'claude', sessionId: UUID, title: 'Auto' };
    assert.deepEqual(renameChange(e, '  New  '), { name: 'New' });
    assert.equal(renameChange(e, ' Auto '), null, 'the automatic title while no name is set');
    assert.equal(renameChange(e, '   '), null, 'empty with no name: nothing');
    assert.deepEqual(renameChange({ ...e, name: 'Mine' }, ''), { name: null }, 'empty clears');
    assert.equal(renameChange({ ...e, name: 'Mine' }, 'Mine'), null);
    assert.deepEqual(renameChange({ ...e, name: 'Mine' }, 'Auto'), { name: 'Auto' }, 'with a name set, the title text is a name');
    const masked = renameChange(e, `Rotate ${TOKEN}\u202e\u0007 now`).name;
    assert.ok(masked.includes('[hidden]') && !masked.includes(TOKEN.slice(4)), `masked: ${masked}`);
    assert.ok(!/[\u0000-\u001f\u202a-\u202e]/.test(masked) && masked.startsWith('Rotate ') && masked.endsWith(' now'), `cleaned: ${masked}`);
    assert.equal(renameChange(e, '\u0007\u202e'), null, 'only control characters: empty');
    assert.equal(Array.from(renameChange(e, 'x'.repeat(500)).name).length, 200);

    assert.equal(historyGroupName('  Work  '), 'Work');
    assert.equal(historyGroupName(''), null);
    assert.equal(historyGroupName('\u202e'), null);
    assert.ok(historyGroupName(`Keys ${TOKEN}`).includes('[hidden]') && !historyGroupName(`Keys ${TOKEN}`).includes(TOKEN.slice(4)));
    assert.equal(Array.from(historyGroupName('가'.repeat(150))).length, 100, 'at most 100 characters');
    const cutThrough = historyGroupName(`${'a'.repeat(90)} ${TOKEN}`);
    assert.ok(cutThrough.endsWith('[hidden]') && Array.from(cutThrough).length <= 100, `never cut through [hidden]: ${cutThrough}`);
    assert.ok(!historyGroupName(`${'b'.repeat(95)} ${TOKEN}`).includes(TOKEN.slice(4)), 'nothing of the secret at the cut');

    assert.equal(nextGroupName([]), 'New Group');
    assert.equal(nextGroupName([{ name: 'New Group' }]), 'New Group 2');
    assert.equal(nextGroupName([{ name: 'New Group' }, { name: 'New Group 2' }, { name: 'New Group 4' }]), 'New Group 3');
    assert.equal(nextGroupName([{ name: 'New Group 2' }]), 'New Group');

    assert.equal(isProtectedEntry({ pinned: true }), true);
    assert.equal(isProtectedEntry({ name: 'x' }), true);
    assert.equal(isProtectedEntry({ groupId: 'g' }), true);
    assert.equal(isProtectedEntry({ archived: true }), false, 'archived alone does not protect');
    assert.equal(isProtectedEntry({ name: null, groupId: null, pinned: false }), false);
    assert.deepEqual(carriedCuration({ name: 'n', pinned: true, archived: true, groupId: 'g' }), { name: 'n', pinned: true, groupId: 'g' });
    assert.deepEqual(carriedCuration({ groupId: 'g' }), { groupId: 'g' });
    assert.equal(carriedCuration({ archived: true }), null);

    const listed = [{ ...e, pinned: true }, { key: `claude:${OTHER}`, kind: 'claude', sessionId: OTHER }];
    const answers = new Map([[UUID, { saved: false, title: null }], [OTHER, { saved: false, title: null }]]);
    assert.deepEqual(claudeHistoryChanges(listed, answers).removed, [`claude:${OTHER}`], 'only the unprotected one');
  });

  test('AHG-51: agentSessionSections — pinned, groups in order, ungrouped, archived, the count; unprotectedAfterUngrouping', () => {
    const at = (key, lastUsedAt, more = {}) => ({ key, kind: 'claude', sessionId: null, lastUsedAt, ...more });
    const entries = [
      at('a', 10),
      at('b', 50, { pinned: true, groupId: 'g1' }),
      at('c', 40, { groupId: 'g1' }),
      at('d', 30, { groupId: 'g2' }),
      at('e', 60, { archived: true, pinned: true }),
      at('f', 20, { groupId: 'gone' }),
      at('g', 70, { groupId: 'g1', archived: true }),
      at('h', 45, { pinned: true }),
      at('i', 40, { groupId: 'g1' }),
    ];
    const groups = [{ id: 'g2', name: 'Two', collapsed: false }, { id: 'g1', name: 'One', collapsed: true }, { id: 'g3', name: 'Empty', collapsed: false }];
    const s = agentSessionSections(entries, groups);
    assert.deepEqual(s.pinned.map((x) => x.key), ['b', 'h'], 'pinned, any group, newest first');
    assert.deepEqual(s.groups.map((x) => [x.group.id, x.entries.map((y) => y.key)]), [['g2', ['d']], ['g1', ['c', 'i']], ['g3', []]], 'stored order; members neither pinned nor archived; ties keep their order');
    assert.deepEqual(s.ungrouped.map((x) => x.key), ['f', 'a'], 'a group that is not there: ungrouped');
    assert.deepEqual(s.archived.map((x) => x.key), ['g', 'e']);
    assert.equal(s.count, 7, 'archived left out');
    assert.deepEqual(agentSessionSections(null, null), { pinned: [], groups: [], ungrouped: [], archived: [], count: 0 });

    // Unprotected now: a only (e is pinned). Ungrouping g1 makes c, g and i unprotected; b stays pinned.
    assert.equal(unprotectedAfterUngrouping(entries, 'g1'), 4);
    assert.equal(unprotectedAfterUngrouping(entries, 'g3'), 1);
    assert.equal(HISTORY_CAP, 200);
    const many = Array.from({ length: 199 }, (_, i) => at(`u${i}`, i));
    many.push(at('m1', 500, { groupId: 'gx' }), at('m2', 501, { groupId: 'gx', name: 'kept' }), at('m3', 502, { groupId: 'gx' }));
    assert.ok(unprotectedAfterUngrouping(many, 'gx') > HISTORY_CAP, 'more than the cap: the question says so');
  });

  test('AHG-52: historyDisplay and historyMatches with the name and the group’s name; queueUpsert keeps unarchive when it folds', () => {
    const e = { key: KEY, kind: 'claude', sessionId: UUID, cwd: '/w/app', title: 'Auto title', name: 'My name', groupId: 'g1', pinned: true };
    const shown = historyDisplay(e);
    assert.deepEqual(
      [shown.title, shown.titled, shown.name, shown.autoTitle, shown.pinned, shown.archived, shown.groupId, shown.shortId],
      ['My name', true, 'My name', 'Auto title', true, false, 'g1', 'd4bef4d0']
    );
    const plain = historyDisplay({ ...e, name: undefined, title: null, groupId: undefined, pinned: undefined });
    assert.deepEqual([plain.title, plain.titled, plain.name, plain.autoTitle, plain.groupId], ['d4bef4d0', false, null, null, null]);
    assert.equal(historyDisplay({ kind: 'claude', sessionId: null, title: null, name: 'Named' }).titled, true, 'a name is titled');
    const groups = [{ id: 'g1', name: 'Release work' }];
    assert.ok(historyMatches(e, 'my name'), 'the name');
    assert.ok(historyMatches(e, 'auto'), 'the title still');
    assert.ok(historyMatches(e, 'release', groups), 'the group’s name');
    assert.ok(!historyMatches(e, 'release'), 'no groups given: none matched');
    assert.ok(!historyMatches({ ...e, groupId: 'g2' }, 'release', groups));

    const op = (title, unarchive, key = KEY) => ({
      entry: { kind: 'claude', sessionId: UUID, cwd: '/w', title, startedAt: 1, lastUsedAt: 2, endedAt: null, endReason: null },
      key, replaces: null, tabId: 't', ...(unarchive ? { unarchive: true } : {}),
    });
    let q = queueUpsert([], op(null, true));
    q = queueUpsert(q, op('Live', false));
    assert.equal(q.length, 1);
    assert.equal(q[0].unarchive, true, 'a start folded with a title still unarchives');
    assert.equal(q[0].entry.title, 'Live');
    q = queueUpsert([], op('Live', false));
    assert.ok(!('unarchive' in q[0]), 'a title alone never unarchives');
    q = queueUpsert(queueUpsert([], op('Live', false)), op(null, true));
    assert.equal(q[0].unarchive, true);
  });

  test('AHG-99: teardown — the stores, the storage, the hooks and the mock as the next suite expects', async () => {
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ agentHistoryNotice: null });
    H.setState(emptyStore());
    P.getState().answer(false);
    __setClaudeLookupTimeoutMs(CLAUDE_LOOKUP_TIMEOUT_MS);
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      mockBridge.claudeTranscripts = before.transcripts;
      mockBridge.claudeSessionMarkers = before.markers;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    } else {
      mockBridge.claudeTranscripts = null;
    }
    assert.equal(P.getState().prompt, null);
    assert.equal(H.getState().isRecording(), false);
  });
});
