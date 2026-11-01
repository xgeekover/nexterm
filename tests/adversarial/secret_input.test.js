/**
 * Stage 3, part B: the password lock (spec P4).
 *
 * The backend reads each terminal's line discipline after output and says
 * `pty-echo { session_id, secret }` when "echo off, canonical on" changes —
 * what sudo, ssh and `read -s` leave a terminal in (src-tauri/src/pty/
 * echo_watch.rs, tested there on a real pty). These cases hold the frontend
 * half:
 *
 *   - the map's rules (src/lib/secretInput.js), and the store keeping one
 *     boolean per terminal from the events — only for the terminal holding
 *     the session, and gone with the shell (exit, restart) and the terminal;
 *   - the browser mock telling it the way the backend does (`setEcho`,
 *     `sudo`, `read -s`, a closing `false` before `pty-exit`);
 *   - the typing guard: a startup command, an agent started or resumed wait
 *     while the terminal asks for a password, within the wait they already
 *     had, and are never typed into the prompt — the terminal says why —
 *     while what the user types and pastes goes straight through.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { startCommand } from '../../src/lib/agents.js';
import { TYPING_HIDDEN_LABEL, typingHidden, withSecret, withoutSecret } from '../../src/lib/secretInput.js';

const S = terminalStore.useTerminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// --- a disk of this file's own ----------------------------------------------
const backing = new Map();
let previousLocalStorage;
let shimInstalled = false;
let previousWait = null;
let previousInfers = null;
let unsink = null;
const notices = [];

function installStorageShim() {
  if (!shimInstalled) {
    previousLocalStorage = globalThis.localStorage;
    shimInstalled = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

async function freshStart({ promptWaitMs = 2000 } = {}) {
  S.getState().dispose();
  installStorageShim();
  backing.clear();
  previousWait = terminalStore.__setAgentPromptWaitMs(promptWaitMs);
  previousInfers = terminalStore.__setSubmitInfersRunning(false);
  notices.length = 0;
  unsink = setTerminalNoticeSink((tabId, message) => {
    notices.push({ tabId, message });
    return true;
  });
  S.getState().forgetInputHidden();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [], secretInput: {} });
  await S.getState().init();
}

function teardown() {
  S.getState().dispose();
  unsink?.();
  unsink = null;
  if (previousWait !== null) terminalStore.__setAgentPromptWaitMs(previousWait);
  if (previousInfers !== null) terminalStore.__setSubmitInfersRunning(previousInfers);
  previousWait = null;
  previousInfers = null;
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

// --- the shell, as the backend reports it -------------------------------------
const tabById = (id) => S.getState().tabs.find((t) => t.id === id);
const sessionOf = (tabId) => tabById(tabId).sessionId;
/** The shell drew a prompt: the D its integration sends with every one. */
const prompt = (tabId, code = 0) => mockBridge.emit('pty-command-done', { session_id: sessionOf(tabId), exit_code: code });
/** The terminal's typing hidden or not, said as the backend says it. */
const echo = (tabId, secret) => mockBridge.emit('pty-echo', { session_id: sessionOf(tabId), secret });
const hidden = (tabId) => typingHidden(S.getState(), tabId);

/** Everything written to any terminal while `fn` runs, held unanswered: `[data]` for `tabId`. */
async function holdingWrites(tabId, fn) {
  const original = mockBridge.invoke;
  const typed = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write') {
      if (args?.session_id === tabById(tabId)?.sessionId) typed.push(args?.data);
      return Promise.resolve(null);
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(typed);
  } finally {
    mockBridge.invoke = original;
  }
  return typed;
}

/** Every `pty-echo` and `pty-exit` the mock tells, in order, while `fn` runs. */
async function told(fn) {
  const heard = [];
  const offEcho = mockBridge.listen('pty-echo', ({ payload }) => heard.push(['echo', payload.session_id, payload.secret]));
  const offExit = mockBridge.listen('pty-exit', ({ payload }) => heard.push(['exit', payload.session_id]));
  try {
    await fn();
  } finally {
    offEcho();
    offExit();
  }
  return heard;
}

describe('Password lock: the rules of the map (secretInput.js)', () => {
  test('SI-01: one boolean per terminal, the same object when nothing changes', () => {
    const none = {};
    assert.equal(withSecret(none, 't1', false), none, 'false for one not secret: nothing to do');
    const one = withSecret(none, 't1', true);
    assert.deepEqual(one, { t1: true });
    assert.notEqual(one, none, 'a new object when it changed');
    assert.equal(withSecret(one, 't1', true), one, 'secret again: the same object');
    assert.deepEqual(withSecret(one, 't1', false), {}, 'false drops the key rather than keeping it false');
    assert.equal(withoutSecret(one, ['t2']), one);
    assert.deepEqual(withoutSecret({ t1: true, t2: true }, ['t1', 't9']), { t2: true });
    assert.equal(typingHidden({ secretInput: one }, 't1'), true);
    assert.equal(typingHidden({ secretInput: one }, 't2'), false);
    assert.equal(typingHidden({}, 't1'), false);
    assert.equal(TYPING_HIDDEN_LABEL, 'Typing is hidden (password prompt)');
  });
});

describe('Password lock: the store follows pty-echo', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  test('SI-02: the terminal holding the session is locked and unlocked; nothing else is', async () => {
    const a = S.getState().activeTabId;
    const b = (await S.getState().createTab()).id;
    await echo(a, true);
    assert.equal(hidden(a), true);
    assert.equal(hidden(b), false, 'another terminal stays as it was');
    const map = S.getState().secretInput;
    await echo(a, true);
    assert.equal(S.getState().secretInput, map, 'said twice: no new state, nothing redrawn');
    await mockBridge.emit('pty-echo', { session_id: 'pty-999', secret: true });
    await mockBridge.emit('pty-echo', { session_id: sessionOf(b), secret: 'yes' });
    await mockBridge.emit('pty-echo', null);
    assert.deepEqual(Object.keys(S.getState().secretInput), [a], 'a session no tab holds, or a malformed payload, changes nothing');
    await echo(a, false);
    assert.equal(hidden(a), false);
    assert.deepEqual(S.getState().secretInput, {});
  });

  test("SI-03: a shell's end, a restart and a closed terminal each take the lock away", async () => {
    const a = S.getState().activeTabId;
    const b = (await S.getState().createTab()).id;
    const c = (await S.getState().createTab()).id;
    await echo(a, true);
    await echo(b, true);
    await echo(c, true);
    // The shell exits without a closing false (a backend that died, say).
    await mockBridge.emit('pty-exit', { session_id: sessionOf(a), exit_code: 1 });
    assert.equal(hidden(a), false, 'the shell ended, and the lock stayed');
    // From here the kills say nothing back — a backend whose session was
    // already gone — so the restart and the close must take the lock
    // themselves, not leave it to an exit that never comes.
    const original = mockBridge.invoke;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_kill') return Promise.resolve(null);
      return original.call(this, command, args, ...rest);
    };
    try {
      // A restart replaces the shell (one that ended with its lock somehow
      // still up: the restart does not trust the exit to have taken it).
      S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === b ? { ...t, exited: { code: 0 } } : t)) }));
      assert.equal(hidden(b), true, 'setup');
      assert.equal(await S.getState().restartShell(b), true, 'setup: restarted');
      assert.equal(hidden(b), false, 'the new shell inherited the old one\'s prompt');
      // Closing the terminal.
      await S.getState().closeTab(c);
      assert.ok(!tabById(c), 'setup: closed');
      assert.ok(!(c in S.getState().secretInput), 'a closed terminal kept its lock');
    } finally {
      mockBridge.invoke = original;
    }
  });
});

describe('Password lock: a prompt that comes before the terminal holds its shell', () => {
  afterEach(teardown);

  test('SI-04: pty-echo for a session no tab holds yet is kept, and the tab that takes it is locked', async () => {
    await freshStart({ promptWaitMs: 600 });
    // The shell's rc reaches `ssh-add` / `sudo -v` as it starts: told before
    // `pty_spawn`'s answer reaches the store — what restore, Open Workspace and
    // Open Saved Group meet.
    const original = mockBridge.invoke;
    mockBridge.invoke = async function (command, args, ...rest) {
      const out = await original.call(this, command, args, ...rest);
      if (command === 'pty_spawn') await mockBridge.setEcho(out.session_id, true);
      return out;
    };
    let tab;
    try {
      tab = (await S.getState().createTab()).id;
    } finally {
      mockBridge.invoke = original;
    }
    assert.equal(hidden(tab), true, 'the terminal holding a shell that is asking was not locked');
    const typed = await holdingWrites(tab, async () => {
      assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), false);
    });
    assert.deepEqual(typed, [], 'a startup command was typed into a password prompt');
    await echo(tab, false);
    assert.equal(hidden(tab), false);
  });

  test('SI-05: right before typing, the guard asks the backend — a prompt no event has told of yet still stops it', async () => {
    await freshStart({ promptWaitMs: 400 });
    const tab = (await S.getState().createTab()).id;
    await prompt(tab);
    // The backend's terminal is on a password prompt; the watch has not
    // said so yet (it reads at most every 250 ms).
    mockBridge.ptySessions.get(sessionOf(tab)).secret = true;
    assert.equal(hidden(tab), false, 'setup: the store does not know');
    const typed = await holdingWrites(tab, async () => {
      assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), false);
    });
    assert.deepEqual(typed, [], 'typed into a prompt the backend reported');
    assert.match(notices.at(-1)?.message ?? '', /asking for a password/);
    assert.equal(await S.getState().typingHiddenNow(tab), true, 'the store asks the backend as well');
  });

  test('SI-07: while it waits, the guard asks the backend at most every 250 ms, however busy the store is', async () => {
    await freshStart({ promptWaitMs: 1200 });
    const tab = (await S.getState().createTab()).id;
    await prompt(tab);
    mockBridge.ptySessions.get(sessionOf(tab)).secret = true; // only the backend knows
    const original = mockBridge.invoke;
    let asks = 0;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_input_hidden') asks += 1;
      if (command === 'pty_write') return Promise.resolve(null);
      return original.call(this, command, args, ...rest);
    };
    // A program retitling its terminal many times a second: a store write
    // every 10 ms, none of them about the password prompt.
    let n = 0;
    const churn = setInterval(() => S.setState({ churn: (n += 1) }), 10);
    const started = Date.now();
    try {
      assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), false);
    } finally {
      clearInterval(churn);
      mockBridge.invoke = original;
    }
    const most = Math.floor((Date.now() - started) / 250) + 2;
    assert.ok(asks <= most, `${asks} asks in ${Date.now() - started} ms — at most ${most} allowed`);
    assert.ok(asks >= 2, `asked ${asks} time(s): it stopped asking while it waited`);
  });

  test('SI-07b: the events saying yes and no in quick turns while the backend says yes: still at most one ask every 250 ms', async () => {
    await freshStart({ promptWaitMs: 1200 });
    const tab = (await S.getState().createTab()).id;
    await prompt(tab);
    mockBridge.ptySessions.get(sessionOf(tab)).secret = true;
    const original = mockBridge.invoke;
    let asks = 0;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_input_hidden') asks += 1;
      if (command === 'pty_write') return Promise.resolve(null);
      return original.call(this, command, args, ...rest);
    };
    let on = false;
    const flap = setInterval(() => S.getState().noteInputHidden(sessionOf(tab), (on = !on)), 10);
    const started = Date.now();
    try {
      assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), false);
    } finally {
      clearInterval(flap);
      mockBridge.invoke = original;
      S.getState().noteInputHidden(sessionOf(tab), false);
    }
    const most = Math.floor((Date.now() - started) / 250) + 2;
    assert.ok(asks <= most, `${asks} asks in ${Date.now() - started} ms — at most ${most} allowed`);
  });

  test('SI-07c: while it waits, the guard looks again only when the events change or an ask is due — not on every store write', async () => {
    await freshStart({ promptWaitMs: 1200 });
    const tab = (await S.getState().createTab()).id;
    await prompt(tab);
    // The events say the terminal is asking: nothing to ask the backend, so
    // nothing but the wait itself paces the guard.
    S.getState().noteInputHidden(sessionOf(tab), true);
    let looks = 0;
    const previous = terminalStore.__setTypingGuardProbe(() => (looks += 1));
    let n = 0;
    const churn = setInterval(() => S.setState({ churn: (n += 1) }), 10);
    const started = Date.now();
    try {
      await S.getState().typeStartupCommand(tab, 'npm run dev');
    } finally {
      clearInterval(churn);
      terminalStore.__setTypingGuardProbe(previous);
      S.getState().noteInputHidden(sessionOf(tab), false);
    }
    const most = Math.floor((Date.now() - started) / 250) + 3;
    assert.ok(looks <= most, `${looks} looks in ${Date.now() - started} ms of store writes — at most ${most}`);
  });

  test('SI-08: a backend that never answers holds nothing up for long: the ask gives up after a second and the events decide', async () => {
    await freshStart({ promptWaitMs: 400 });
    const tab = (await S.getState().createTab()).id;
    await prompt(tab);
    const original = mockBridge.invoke;
    const typed = [];
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_input_hidden') return new Promise(() => {}); // hangs
      if (command === 'pty_write') {
        typed.push(args.data);
        return Promise.resolve(null);
      }
      return original.call(this, command, args, ...rest);
    };
    const started = Date.now();
    let result;
    try {
      result = await Promise.race([
        S.getState().typeStartupCommand(tab, 'npm run dev'),
        sleep(3000).then(() => 'still waiting'),
      ]);
    } finally {
      mockBridge.invoke = original;
    }
    assert.notEqual(result, 'still waiting', 'a startup command hung on an ask the backend never answered');
    assert.equal(result, true, 'the events said nothing was hidden, and it was not typed');
    assert.deepEqual(typed, ['npm run dev\r']);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  test("SI-09: Windows answers null (it cannot tell): every startup command and agent start goes ahead as before", async () => {
    await freshStart({ promptWaitMs: 400 });
    const tab = (await S.getState().createTab()).id;
    await prompt(tab);
    const original = mockBridge.invoke;
    const typed = [];
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_input_hidden') return Promise.resolve(null);
      if (command === 'pty_write') {
        typed.push(args.data);
        return Promise.resolve(null);
      }
      return original.call(this, command, args, ...rest);
    };
    try {
      assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), true, 'refused on Windows');
      assert.ok(await S.getState().startAgent(tab, 'claude'), 'an agent was not started on Windows');
      assert.equal(await S.getState().typingHiddenNow(tab), false);
    } finally {
      mockBridge.invoke = original;
    }
    assert.equal(typed.length, 2, JSON.stringify(typed));
    assert.deepEqual(notices, []);
  });

  test('SI-06: the backend command is there, registered, and the mock answers it as the backend does', async () => {
    await freshStart();
    const tab = S.getState().activeTabId;
    assert.equal(await mockBridge.invoke('pty_input_hidden', { session_id: sessionOf(tab) }), false);
    await mockBridge.setEcho(sessionOf(tab), true);
    assert.equal(await mockBridge.invoke('pty_input_hidden', { session_id: sessionOf(tab) }), true);
    await assert.rejects(() => mockBridge.invoke('pty_input_hidden', { session_id: 'pty-999' }), /not found/);
    const main = read('../../src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::pty::pty_input_hidden,'), 'not in generate_handler!');
    const commands = read('../../src-tauri/src/commands/pty.rs');
    assert.match(commands, /#\[tauri::command\(rename_all = "snake_case"\)\]\npub fn pty_input_hidden\(state: State<AppState>, session_id: String\) -> Result<Option<bool>, String> \{/);
  });
});

describe('Password lock: the browser mock tells it as the backend does', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  test('SI-10: setEcho says only changes; sudo asks, the next line answers unseen', async () => {
    const a = S.getState().activeTabId;
    const session = sessionOf(a);
    const heard = await told(async () => {
      assert.equal(await mockBridge.setEcho(session, false), false, 'not secret already: nothing said');
      assert.equal(await mockBridge.setEcho(session, true), true);
      assert.equal(await mockBridge.setEcho(session, true), false);
      await mockBridge.setEcho(session, false);
    });
    assert.deepEqual(heard, [['echo', session, true], ['echo', session, false]]);

    const output = [];
    const off = mockBridge.listen('pty-output', ({ payload }) => output.push(payload.data));
    try {
      await S.getState().writeRaw(a, 'sudo ls\r');
      assert.equal(hidden(a), true, 'sudo asks for a password');
      assert.ok(output.join('').includes('password for'), `no prompt: ${JSON.stringify(output)}`);
      await S.getState().writeRaw(a, 'hunter2\r');
      assert.equal(hidden(a), false, 'a line answers it');
      assert.ok(!output.join('').includes('hunter2'), 'the password was echoed');
      await S.getState().writeRaw(a, 'read -s secret\r');
      assert.equal(hidden(a), true, '`read -s` asks too');
    } finally {
      off();
    }
  });

  test('SI-11: a session killed while asking is told false before it is told it ended', async () => {
    const a = S.getState().activeTabId;
    const session = sessionOf(a);
    await mockBridge.setEcho(session, true);
    const heard = await told(() => mockBridge.invoke('pty_kill', { session_id: session }));
    assert.deepEqual(heard, [['echo', session, false], ['exit', session]]);
  });
});

describe('Password lock: nothing is typed into a hidden prompt on the user\'s behalf', () => {
  afterEach(teardown);

  test('SI-20: a startup command waits while the terminal asks, and is typed once it stops asking', async () => {
    await freshStart({ promptWaitMs: 1500 });
    const tab = (await S.getState().createTab()).id;
    const typed = await holdingWrites(tab, async (writes) => {
      await prompt(tab);
      await echo(tab, true);
      const pending = S.getState().typeStartupCommand(tab, 'npm run dev');
      await sleep(150);
      assert.deepEqual(writes, [], 'typed into a password prompt');
      await echo(tab, false);
      assert.equal(await pending, true, 'not typed once the prompt was answered');
    });
    assert.deepEqual(typed, ['npm run dev\r']);
    assert.deepEqual(notices, []);
  });

  test('SI-21: still asking when the wait is up: not typed, and the terminal says why', async () => {
    await freshStart({ promptWaitMs: 300 });
    const tab = (await S.getState().createTab()).id;
    const typed = await holdingWrites(tab, async () => {
      await prompt(tab);
      await echo(tab, true);
      assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), false);
    });
    assert.deepEqual(typed, [], 'typed into a password prompt');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].tabId, tab);
    assert.match(notices[0].message, /startup command not typed — this terminal is asking for a password, and typing is hidden: npm run dev/);
  });

  test('SI-22: an agent is not started into a password prompt, and is not recorded as started', async () => {
    await freshStart({ promptWaitMs: 300 });
    const tab = (await S.getState().createTab()).id;
    let result;
    const typed = await holdingWrites(tab, async () => {
      await prompt(tab);
      await echo(tab, true);
      result = await S.getState().startAgent(tab, 'claude');
    });
    assert.equal(result, null);
    assert.deepEqual(typed, []);
    assert.equal(tabById(tab).agent ?? null, null, 'recorded as running an agent it never got');
    // What it says is what happened: nothing typed, the terminal a plain
    // shell, and how to get the agent after all.
    assert.equal(
      notices[0]?.message,
      'Claude Code not started — this terminal was asking for a password, and NexTerm types nothing into a password prompt. Answer the prompt, then start Claude Code here yourself, or open a new Claude Code terminal.'
    );

    // Answered within the wait, it goes ahead.
    await freshStart({ promptWaitMs: 1500 });
    const next = (await S.getState().createTab()).id;
    const typedNext = await holdingWrites(next, async () => {
      await prompt(next);
      await echo(next, true);
      const pending = S.getState().startAgent(next, 'claude');
      await sleep(100);
      await echo(next, false);
      assert.ok(await pending, 'not started once the prompt was answered');
    });
    assert.equal(typedNext.length, 1);
    assert.match(typedNext[0], /^claude /);
  });

  test('SI-23: Resume into a password prompt types nothing and gives the offer back', async () => {
    await freshStart({ promptWaitMs: 300 });
    const tab = (await S.getState().createTab()).id;
    const { agent } = startCommand('claude');
    S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab ? { ...t, agent, agentResumeOffered: true } : t)) }));
    let resumed;
    const typed = await holdingWrites(tab, async () => {
      await prompt(tab);
      await echo(tab, true);
      resumed = await S.getState().resumeAgent(tab);
    });
    assert.equal(resumed, false);
    assert.deepEqual(typed, []);
    assert.equal(tabById(tab).agentResumeOffered, true, 'the offer went with nothing typed');
    assert.deepEqual(tabById(tab).agent, agent);
    assert.match(notices[0]?.message ?? '', /Not resumed — this terminal is asking for a password/);
  });

  test('SI-24: what the user types and pastes goes straight through a password prompt', async () => {
    await freshStart();
    const tab = (await S.getState().createTab()).id;
    await echo(tab, true);
    const typed = await holdingWrites(tab, async () => {
      await S.getState().writeRaw(tab, 'h');
      await S.getState().writeRaw(tab, 'correct horse battery staple');
      await S.getState().writeRaw(tab, '\r');
    });
    assert.deepEqual(typed, ['h', 'correct horse battery staple', '\r']);
  });

  test("SI-25: cmd's batch-job answer is held to the same rule; nothing else writes on the user's behalf", () => {
    const store = read('../../src/stores/terminalStore.js');
    assert.match(store, /reply: \(tabId, text\) => \{\n\s*if \(typingHidden\(useTerminalStore\.getState\(\), tabId\)\) return undefined;/);
    // Every write the app makes for the user goes through the guard: the
    // three that type a line, each after `untilTypingSafe` — an agent
    // started, one resumed, and `typeWhenSafe`, which types a startup
    // command and a project command (stage 5) alike.
    const lines = [...store.matchAll(/await get\(\)\.writeRaw\([^\n]*\\r`\)|get\(\)\.writeRaw\(tabId, data\)/g)].map((m) => m.index);
    assert.equal(lines.length, 3, 'a new writer on the user\'s behalf: put it behind untilTypingSafe and count it here');
    for (const typer of ['typeStartupCommand', 'typeProjectCommand']) {
      assert.match(store, new RegExp(`${typer}: async[\\s\\S]{0,1500}?return typeWhenSafe\\(`), `${typer} types through typeWhenSafe`);
    }
    for (const at of lines) {
      const before = store.slice(Math.max(0, at - 1500), at);
      assert.ok(before.includes('await untilTypingSafe('), `a write without the guard before it: ${store.slice(at, at + 80)}`);
    }
  });

  test('SI-27: a command picked from the palette\'s history is not typed into a password prompt, and the terminal says why', () => {
    const palette = read('../../src/components/command/CommandPalette.jsx');
    const at = palette.indexOf("if (item.type === 'history') {");
    const branch = palette.slice(at, palette.indexOf('return;\n    }', at));
    assert.match(branch, /await typingHiddenNow\?\.\(tabId\)/, 'the history row does not ask whether typing is hidden');
    assert.match(branch, /notifyTerminal\(tabId, /, 'and does not say why nothing was typed');
    assert.ok(branch.indexOf('typingHiddenNow') < branch.indexOf('writeRaw('), 'it asks before it types');
  });

  test('SI-99: teardown — nothing left locked or hooked', async () => {
    await freshStart();
    assert.deepEqual(S.getState().secretInput, {});
  });
});
