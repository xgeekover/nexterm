/**
 * The control API as the browser mock serves it (src/lib/ipc.js): the
 * commands `control_reply` and `control_set_settings`, and
 * `mockBridge.controlRequest`, which hands the page a `control-request` the
 * way the backend does once it has checked the caller
 * (src-tauri/src/control/bridge.rs, whose own tests cover the socket, the
 * pipe, the tokens and the limits). The mock follows the backend's rules
 * where the page can see them — the payload's shape, the refusals made
 * without asking the page, the error codes, the 3 s wait, Tauri's refusal
 * of a missing or mistyped argument — so a page written against it is not
 * surprised by the app. The shared numbers and codes are held to the Rust
 * source at the end.
 */
import { describe, test, assert, beforeEach } from '../e2e/harness/testFramework.js';
import { readFileSync } from 'node:fs';
import { invoke, listen, mockBridge } from '../../src/lib/ipc.js';

const settings = (enabled, type_and_read, other_terminals) =>
  invoke('control_set_settings', { enabled, type_and_read, other_terminals });

/** A page that answers each request with `answer(payload)`, recording what it was handed. */
async function page(answer) {
  const seen = [];
  const unlisten = await listen('control-request', async (payload) => {
    seen.push(payload);
    const reply = answer(payload);
    if (reply) await invoke('control_reply', { id: payload.id, ...reply });
  });
  return { seen, unlisten };
}

/** The backend's defaults, nothing replied, nothing waiting — before every case (the harness runs a hook only inside its `describe`). */
async function reset() {
  await settings(true, false, false);
  mockBridge.controlReplies = [];
  mockBridge.controlWaiting.clear();
}

describe('control mock: the request the page is handed', () => {
  beforeEach(reset);

  test('the shape the backend sends, with the settings of the moment and no token', async () => {
    await settings(true, true, true);
    const { seen, unlisten } = await page(() => ({ ok: true, result: { shown: true } }));
    try {
      const before = Date.now();
      const answer = await mockBridge.controlRequest({ session_id: 'pty-4', cmd: 'notify', args: { title: 'Done' } });
      const after = Date.now();
      assert.deepEqual(answer, { ok: true, result: { shown: true } });
      assert.equal(seen.length, 1);
      assert.deepEqual(Object.keys(seen[0]).sort(), ['args', 'cmd', 'deadline_at', 'id', 'other_terminals', 'session_id', 'type_and_read']);
      assert.ok(seen[0].deadline_at >= before + 3000 && seen[0].deadline_at <= after + 3000, 'when the backend stops waiting');
      assert.equal(seen[0].session_id, 'pty-4');
      assert.deepEqual(seen[0].args, { title: 'Done' });
      assert.equal(seen[0].type_and_read, true);
      assert.equal(seen[0].other_terminals, true);
      assert.ok(Number.isInteger(seen[0].id) && seen[0].id > 0);
    } finally {
      unlisten();
    }
  });

  test('no args is {}, and every request has an id of its own', async () => {
    const { seen, unlisten } = await page(() => ({ ok: true }));
    try {
      await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'list' });
      await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'list' });
      assert.deepEqual(seen[0].args, {});
      assert.notEqual(seen[0].id, seen[1].id);
    } finally {
      unlisten();
    }
  });
});

describe('control mock: what the backend refuses without asking the page', () => {
  beforeEach(reset);

  test('the API off: disabled, and the page never hears', async () => {
    await settings(false, true, true);
    const { seen, unlisten } = await page(() => ({ ok: true }));
    try {
      const answer = await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'notify', args: { title: 'x' } });
      assert.equal(answer.ok, false);
      assert.equal(answer.error.code, 'disabled');
      assert.equal(seen.length, 0);
    } finally {
      unlisten();
    }
  });

  test('typing and reading off: send and read-screen are disabled, the rest goes', async () => {
    await settings(true, false, true);
    const { seen, unlisten } = await page(() => ({ ok: true }));
    try {
      for (const cmd of ['send', 'read-screen']) {
        const answer = await mockBridge.controlRequest({ session_id: 'pty-1', cmd, args: {} });
        assert.equal(answer.error?.code, 'disabled', cmd);
      }
      const split = await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'new-split', args: { command: 'npm test' } });
      assert.equal(split.error?.code, 'disabled', 'a split that types a command is typing');
      assert.equal(seen.length, 0);
      assert.equal((await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'focus' })).ok, true);
      assert.equal((await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'new-split', args: { direction: 'down' } })).ok, true);
      assert.equal(seen.length, 2);
    } finally {
      unlisten();
    }
  });

  test('raw: exactly what is given reaches the page, for testing its own checks', async () => {
    await settings(true, false, false);
    const { seen, unlisten } = await page(() => ({ ok: false, error: { code: 'disabled', message: 'page says no' } }));
    try {
      const answer = await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'send', args: { text: 'ls' }, type_and_read: false }, { raw: true });
      assert.deepEqual(answer, { ok: false, error: { code: 'disabled', message: 'page says no' } });
      assert.equal(seen[0].cmd, 'send');
      assert.equal(seen[0].other_terminals, undefined, 'nothing added but an id');
    } finally {
      unlisten();
    }
  });

  test('64 waiting: the next is rate_limited at once', async () => {
    const pending = [];
    for (let i = 0; i < 64; i += 1) pending.push(mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'list' }, { timeoutMs: 50 }));
    const over = await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'list' });
    assert.equal(over.error?.code, 'rate_limited');
    for (const answer of await Promise.all(pending)) assert.equal(answer.error?.code, 'not_responding');
    assert.equal(mockBridge.controlWaiting.size, 0);
  });
});

describe('control mock: the page\'s reply', () => {
  beforeEach(reset);

  test('no reply in time is not_responding, and a late one is ignored', async () => {
    const { seen, unlisten } = await page(() => null);
    try {
      const answer = await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'list' }, { timeoutMs: 20 });
      assert.equal(answer.error?.code, 'not_responding');
      assert.equal(await invoke('control_reply', { id: seen[0].id, ok: true, result: 'late' }), null);
      assert.equal(mockBridge.controlReplies.length, 1, 'kept for the suites');
      assert.equal(mockBridge.controlWaiting.size, 0);
    } finally {
      unlisten();
    }
  });

  test('an error code outside the set is internal, a long message is cut, a missing one is said', async () => {
    const cases = [
      [{ code: 'forbidden', message: 'not yours' }, { code: 'forbidden', message: 'not yours' }],
      [{ code: 'sudo', message: 'x' }, { code: 'internal', message: 'x' }],
      [null, { code: 'internal', message: 'NexTerm refused the request (internal)' }],
      [{ code: 'refused', message: 'm'.repeat(5000) }, { code: 'refused', message: 'm'.repeat(1000) }],
    ];
    for (const [error, expected] of cases) {
      const { unlisten } = await page(() => ({ ok: false, error }));
      try {
        const answer = await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'list' });
        assert.deepEqual(answer, { ok: false, error: expected });
      } finally {
        unlisten();
      }
    }
  });

  test('ok without a result is null', async () => {
    const { unlisten } = await page(() => ({ ok: true }));
    try {
      assert.deepEqual(await mockBridge.controlRequest({ session_id: 'pty-1', cmd: 'list' }), { ok: true, result: null });
    } finally {
      unlisten();
    }
  });

  test('control_reply is refused as Tauri refuses a missing or mistyped id or ok', async () => {
    await assert.rejects(() => invoke('control_reply', { ok: true }), /missing required key id/);
    await assert.rejects(() => invoke('control_reply', { id: '1', ok: true }), /invalid args `id`/);
    await assert.rejects(() => invoke('control_reply', { id: -1, ok: true }), /invalid args `id`/);
    await assert.rejects(() => invoke('control_reply', { id: 1.5, ok: true }), /invalid args `id`/);
    await assert.rejects(() => invoke('control_reply', { id: 1 }), /missing required key ok/);
    await assert.rejects(() => invoke('control_reply', { id: 1, ok: 'yes' }), /invalid args `ok`/);
  });
});

describe('control mock: control_set_settings', () => {
  beforeEach(reset);

  test('three booleans, all required, and the answer says there is no listener here', async () => {
    assert.deepEqual(await settings(true, true, false), { enabled: true, listening: false, error: null });
    assert.deepEqual(mockBridge.controlSettings, { enabled: true, type_and_read: true, other_terminals: false });
    await assert.rejects(() => invoke('control_set_settings', { enabled: true, type_and_read: true }), /missing required key other_terminals/);
    await assert.rejects(() => invoke('control_set_settings', { enabled: 1, type_and_read: true, other_terminals: false }), /invalid args `enabled`/);
    await assert.rejects(() => invoke('control_set_settings', { enabled: true, typeAndRead: true, other_terminals: false }), /missing required key type_and_read/);
    assert.deepEqual(mockBridge.controlSettings, { enabled: true, type_and_read: true, other_terminals: false }, 'a refused call changes nothing');
  });
});

describe('control mock: pty_foreground_owner', () => {
  test('the user\'s own by default, false or null when a test says so, refused for no session', async () => {
    const { session_id } = await invoke('pty_spawn', { cols: 80, rows: 24 });
    assert.deepEqual(await invoke('pty_foreground_owner', { session_id }), { same_user: true });
    assert.equal(mockBridge.setForegroundOwner(session_id, false), true);
    assert.deepEqual(await invoke('pty_foreground_owner', { session_id }), { same_user: false });
    mockBridge.setForegroundOwner(session_id, null);
    assert.deepEqual(await invoke('pty_foreground_owner', { session_id }), { same_user: null });
    await assert.rejects(() => invoke('pty_foreground_owner', { session_id: 'pty-none' }), /PTY session not found/);
    await assert.rejects(() => invoke('pty_foreground_owner', { sessionId: session_id }), /missing required key session_id/);
    assert.equal(mockBridge.setForegroundOwner('pty-none', false), false);
    await invoke('pty_kill', { session_id });
  });

  test('the same command and answer as commands/pty.rs', () => {
    const source = readFileSync(new URL('../../src-tauri/src/commands/pty.rs', import.meta.url), 'utf8');
    assert.match(source, /pub fn pty_foreground_owner\(state: State<AppState>, session_id: String\) -> Result<ForegroundOwner, String>/);
    assert.match(source, /pub struct ForegroundOwner \{[\s\S]*?pub same_user: Option<bool>,\s*\}/);
  });
});

describe('control mock: held to the backend', () => {
  const rust = (path) => readFileSync(new URL(`../../src-tauri/src/control/${path}`, import.meta.url), 'utf8');

  test('the same error codes as protocol.rs', () => {
    const source = rust('protocol.rs');
    const fn = source.slice(source.indexOf('pub fn as_str(self)'), source.indexOf('pub fn parse(text: &str) -> Option<Code>'));
    const codes = [...fn.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]).sort();
    const ipc = readFileSync(new URL('../../src/lib/ipc.js', import.meta.url), 'utf8');
    const block = ipc.slice(ipc.indexOf('const MOCK_CONTROL_CODES'), ipc.indexOf(']);', ipc.indexOf('const MOCK_CONTROL_CODES')));
    const mock = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    assert.equal(codes.length, 12);
    assert.deepEqual(mock, codes);
  });

  test('the same 64 waiting, 3 s, event name and payload keys as bridge.rs', () => {
    const source = rust('bridge.rs');
    assert.match(source, /pub const MAX_WAITING: usize = 64;/);
    assert.match(source, /pub const REPLY_TIMEOUT: Duration = Duration::from_secs\(3\);/);
    assert.match(source, /pub const REQUEST_EVENT: &str = "control-request";/);
    const struct = source.slice(source.indexOf('pub struct PageRequest {'), source.indexOf('}', source.indexOf('pub struct PageRequest {')));
    const keys = [...struct.matchAll(/pub ([a-z_]+):/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, ['args', 'cmd', 'deadline_at', 'id', 'other_terminals', 'session_id', 'type_and_read']);
  });

  test('the same command names and arguments as commands/control.rs', () => {
    const source = readFileSync(new URL('../../src-tauri/src/commands/control.rs', import.meta.url), 'utf8');
    assert.match(source, /pub fn control_reply\(state: State<AppState>, id: u64, ok: bool, result: Option<Value>, error: Option<Value>\)/);
    assert.match(source, /pub async fn control_set_settings\(\s*state: State<'_, AppState>,\s*enabled: bool,\s*type_and_read: bool,\s*other_terminals: bool,\s*\) -> Result<Status, String>/);
    assert.match(source, /rename_all = "snake_case"/);
  });
});
