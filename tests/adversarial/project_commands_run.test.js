/**
 * Stage 5: running a project command (spec D7) — where the run dialog
 * offers to type it and for which shell (src/lib/projectCommandRun.js), what
 * a key means in it, and how the terminal store types the line
 * (`runProjectCommand`, `typeProjectCommand`, and `typeWhenSafe`, which it
 * shares with `typeStartupCommand`).
 *
 * The store is the real one on the browser mock: a shell that has drawn its
 * prompt, a password prompt the backend reports, a program running.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { parseCommandsFile, renderCommand } from '../../src/lib/projectCommands.js';
import {
  ACTIVATION_GRACE_MS,
  BUSY_REASON,
  EXITED_REASON,
  GONE_REASON,
  PENDING_REASON,
  RESTARTED_REASON,
  TYPED_REASON,
  UNKNOWN_LINE_REASON,
  UNTOLD_REASON,
  activationCounts,
  pinTarget,
  runDialogKey,
  runTargetView,
  runTargets,
  targetShell,
} from '../../src/lib/projectCommandRun.js';
import { useSystemStore } from '../../src/stores/systemStore.js';
import { useProjectCommandsStore } from '../../src/stores/projectCommandsStore.js';

const S = terminalStore.useTerminalStore;
const { untypableLine } = terminalStore;

// ---- the run dialog's targets, as data ----------------------------------------

const leaf = (id, tabIds) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });
const terminalState = (tabs, { activeTabId = tabs[0]?.id ?? null } = {}) => ({
  tabs,
  activeTabId,
  activeGroupId: 'g1',
  groups: [{ id: 'g1', activePaneId: 'p1', tree: leaf('p1', tabs.map((t) => t.id)) }],
});
const targetsOf = (tabs, env = {}, { block = null } = {}) => {
  const state = { ...terminalState(tabs), projectCommandBlock: () => block };
  return runTargets(runTargetView(state, pinTarget(state)), { os: 'macos', ...env });
};

describe('Run dialog: where the line can go', () => {
  test('PCR-01: this terminal while it can take the line; not while something runs in it — a new split then — nor once its shell has exited', () => {
    const idle = targetsOf([{ id: 't1', title: 'api', shell: '/bin/zsh' }]);
    assert.equal(idle.initial, 'split', 'a fresh shell, where the line can be run, whenever there is one');
    assert.deepEqual([idle.this.tabId, idle.this.title, idle.this.busy, idle.this.kind, idle.this.label], ['t1', 'api', null, 'posix', 'zsh']);
    assert.ok(idle.split, 'a new split is offered too');
    assert.equal(idle.newTab, null);

    const busy = targetsOf([{ id: 't1', title: 'claude', shell: '/bin/zsh', running: true }]);
    assert.equal(busy.this.busy, BUSY_REASON);
    assert.equal(busy.initial, 'split', 'typed into Claude Code, the line would be its input');
    assert.equal(targetShell(busy, 'this').busy, BUSY_REASON, 'chosen anyway, it says why it cannot take the line');
    // What the store says of its prompt — text typed there, a shell that
    // never says where its prompt is — is said the same way.
    for (const block of [TYPED_REASON, UNKNOWN_LINE_REASON, UNTOLD_REASON]) {
      const blocked = targetsOf([{ id: 't1', title: 'x', shell: '/bin/zsh' }], {}, { block });
      assert.deepEqual([blocked.this.busy, blocked.initial], [block, 'split']);
    }

    const exited = targetsOf([{ id: 't1', title: 'x', shell: '/bin/zsh', exited: { code: 0 } }]);
    assert.equal(exited.this.busy, EXITED_REASON);
    assert.equal(exited.initial, 'split');

    const none = targetsOf([]);
    assert.deepEqual([none.this, none.split, none.initial], [null, null, 'new-tab']);
    assert.equal(pinTarget(terminalState([])), null);
    assert.equal(none.newTab.kind, 'posix');
    // A title a program set is someone else's text.
    assert.equal(targetsOf([{ id: 't1', title: 'a\u{202E}b', shell: 'zsh' }]).this.title, 'ab');
  });

  test('PCR-14: the terminal is pinned as the dialog opens — another one made active, or this one closed or restarted, never takes its place', () => {
    const tabs = [{ id: 't1', title: 'api', shell: 'zsh', sessionId: 's1' }, { id: 't2', title: 'web', shell: 'zsh', sessionId: 's2' }];
    const opened = terminalState(tabs, { activeTabId: 't1' });
    const pinned = pinTarget(opened);
    assert.deepEqual(pinned, { tabId: 't1', sessionId: 's1' });
    const env = { os: 'macos' };
    // ⌘⌥→ behind the dialog: t2 is active now; the dialog still means t1.
    const moved = runTargets(runTargetView({ ...opened, activeTabId: 't2' }, pinned), env);
    assert.deepEqual([moved.this.tabId, moved.this.title, moved.this.busy], ['t1', 'api', null]);
    // ⌘W: t1 closed, and a new terminal of the same name made — not taken for it.
    const closed = runTargets(runTargetView({ ...opened, tabs: [{ id: 't3', title: 'api', shell: 'zsh', sessionId: 's3' }], activeTabId: 't3' }, pinned), env);
    assert.equal(closed.this.tabId, 't1');
    assert.equal(closed.this.busy, GONE_REASON);
    assert.match(closed.split.busy, /has closed/);
    // Its shell restarted: another session, not the terminal the line was for.
    const restarted = runTargets(runTargetView({ ...opened, tabs: [{ ...tabs[0], sessionId: 's9' }, tabs[1]] }, pinned), env);
    assert.equal(restarted.this.busy, RESTARTED_REASON);
  });

  test('PCR-15: nothing runs before the line could be read — Run, Type Only and Enter count only ACTIVATION_GRACE_MS after the dialog opens', () => {
    assert.equal(ACTIVATION_GRACE_MS, 500);
    assert.equal(activationCounts(1000, 1060), false, 'a second Enter 60 ms after the one that opened it');
    assert.equal(activationCounts(1000, 1499), false);
    assert.equal(activationCounts(1000, 1500), true);
    assert.equal(activationCounts(1000, 1600), true);
    assert.equal(activationCounts(null, 5000), false, 'not open yet');
  });

  test("PCR-02: a new split's shell is the one splitStartFor gives it — and the preview is quoted for that shell, not this terminal's", () => {
    const cmd = { id: 't1', title: 'cmd', shell: 'C:\\Windows\\System32\\cmd.exe', cwd: 'C:\\proj' };
    const windows = { os: 'windows', defaultShell: 'pwsh.exe', systemShell: 'C:\\Windows\\System32\\cmd.exe' };
    const inherited = targetsOf([cmd], { ...windows, splitCwd: 'inherited' });
    assert.equal(inherited.this.kind, 'cmd');
    assert.equal(inherited.split.kind, 'cmd', 'inherited: the split continues the shell being split');
    const fresh = targetsOf([cmd], { ...windows, splitCwd: 'default' });
    assert.equal(fresh.split.kind, 'powershell', 'a new terminal like any other: the Default Shell setting');
    assert.equal(fresh.split.label, 'PowerShell 7');

    const command = parseCommandsFile(
      JSON.stringify({ version: 1, commands: [{ name: 'Grep', command: 'findstr {{word}} *.txt' }] })
    ).commands[0];
    const forThis = renderCommand(command, { word: 'two words' }, targetShell(fresh, 'this').kind);
    const forSplit = renderCommand(command, { word: 'two words' }, targetShell(fresh, 'split').kind);
    assert.equal(forThis.line, 'findstr "two words" *.txt');
    assert.equal(forSplit.line, "findstr 'two words' *.txt");
    // `default` is what the backend resolves it to — the system's shell —
    // named and quoted as that shell, not as an unknown one called "default".
    const mac = targetsOf([{ id: 't1', title: 'x', shell: 'default' }], { os: 'macos', systemShell: '/opt/homebrew/bin/fish' });
    assert.deepEqual([mac.this.kind, mac.this.label, mac.split.kind, mac.split.label], ['fish', 'fish', 'fish', 'fish']);
    const win = targetsOf([{ id: 't1', title: 'x', shell: 'default' }], { os: 'windows', systemShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
    assert.equal(win.this.kind, 'powershell', 'not cmd, the fallback for a name it does not know');
    // And what cmd cannot be given, PowerShell can.
    assert.equal(renderCommand(command, { word: '50%' }, 'cmd').ok, false);
    assert.equal(renderCommand(command, { word: '50%' }, 'powershell').line, "findstr '50%' *.txt");
  });

  test('PCR-03: the keys — Enter in a field runs, Enter on a button is that button, a held Enter runs nothing, Escape cancels', () => {
    const key = (k, extra = {}) => ({ key: k, repeat: false, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
    assert.equal(runDialogKey(key('Enter'), 'field'), 'run');
    assert.equal(runDialogKey(key('Enter'), 'button'), 'pass', 'the native button answers it: Enter on Cancel cancels');
    assert.equal(runDialogKey(key('Enter'), 'other'), 'swallow', 'aimed at nothing the dialog shows');
    for (const where of ['field', 'button', 'other']) {
      assert.equal(runDialogKey(key('Enter', { repeat: true }), where), 'swallow', `a held Enter on ${where}`);
    }
    assert.equal(runDialogKey(key(' ', { repeat: true }), 'button'), 'swallow', 'a held Space does not arm a button');
    assert.equal(runDialogKey(key('Enter', { shiftKey: true }), 'field'), 'swallow');
    assert.equal(runDialogKey(key('Enter', { metaKey: true }), 'field'), 'swallow');
    assert.equal(runDialogKey(key('Escape'), 'field'), 'cancel');
    assert.equal(runDialogKey(key('Escape'), 'other'), 'cancel');
    assert.equal(runDialogKey(key('Tab'), 'field'), 'next');
    assert.equal(runDialogKey(key('Tab', { shiftKey: true }), 'button'), 'previous');
    assert.equal(runDialogKey(key('Tab', { ctrlKey: true }), 'field'), 'pass');
    assert.equal(runDialogKey(key('Enter', { isComposing: true }), 'field'), 'pass', 'a Korean composition ends, nothing runs');
    assert.equal(runDialogKey({ ...key('Enter'), keyCode: 229 }, 'field'), 'pass');
    assert.equal(runDialogKey(key('a'), 'field'), 'pass');
    // Chrome on Windows: keydown 229 for the Enter that commits a Hangul
    // syllable, then a plain keydown 13 — the commit's, not a Run.
    assert.equal(runDialogKey(key('Enter'), 'field', { msSinceCompositionEnd: 4 }), 'swallow');
    assert.equal(runDialogKey(key('Enter'), 'field', { msSinceCompositionEnd: 99 }), 'swallow');
    assert.equal(runDialogKey(key('Enter'), 'field', { msSinceCompositionEnd: 150 }), 'run', 'a later Enter runs');
    assert.equal(runDialogKey(key('Enter'), 'button', { msSinceCompositionEnd: 4 }), 'pass');
  });

  test('PCR-04: what is checked right before typing is what the validator refuses — no more, no less', () => {
    const refusedByFile = (char) =>
      parseCommandsFile(JSON.stringify({ version: 1, commands: [{ name: 'x', command: `echo a${char}b` }] })).refused.length === 1;
    const disagreements = [];
    for (let cp = 0; cp <= 0x3200; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (char === '{' || char === '}' || char === '"' || char === "'" || char === '`') continue;
      // Refused in a command for where they stand, not for what they are
      // (history expansion; a space that is not one) — a typed line holds
      // them inside the quotes NexTerm put there.
      if (char === '!' || /[\u{A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/u.test(char)) continue;
      if (refusedByFile(char) !== (untypableLine(`echo a${char}b`) !== null)) disagreements.push(cp.toString(16));
    }
    for (const cp of [0xfeff, 0xffa0, 0x3164, 0x1f600, 0xfe0f]) {
      const char = String.fromCodePoint(cp);
      if (refusedByFile(char) !== (untypableLine(`echo a${char}b`) !== null)) disagreements.push(cp.toString(16));
    }
    assert.deepEqual(disagreements, []);
    assert.match(untypableLine('echo a\nrm -rf ~'), /line break \(U\+000A\)/);
    assert.match(untypableLine('echo \u{202E}'), /not text \(U\+202E\)/);
    assert.equal(untypableLine('   '), 'there is no line to type');
    assert.equal(untypableLine('echo \u{d55c}\u{ae00} \u{1F600}'), null, 'Hangul and emoji are text');
  });
});

// ---- typing it, through the store ---------------------------------------------

let previousWait = null;
let previousInfers = null;
let unsink = null;
const notices = [];
const backing = new Map();
let previousStorage;
let hadStorage = false;

async function freshStart() {
  S.getState().dispose();
  hadStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  previousStorage = globalThis.localStorage;
  backing.clear();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  previousWait = terminalStore.__setAgentPromptWaitMs(400);
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
  if (hadStorage) globalThis.localStorage = previousStorage;
  else delete globalThis.localStorage;
}

const tabById = (id) => S.getState().tabs.find((t) => t.id === id);
const sessionOf = (tabId) => tabById(tabId).sessionId;
const prompt = (tabId) => mockBridge.emit('pty-command-done', { session_id: sessionOf(tabId), exit_code: 0 });
const echo = (tabId, secret) => mockBridge.emit('pty-echo', { session_id: sessionOf(tabId), secret });

/** Every write to a terminal while `fn` runs, as `[sessionId, data]`, held unanswered. */
async function writes(fn) {
  const original = mockBridge.invoke;
  const typed = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write') {
      typed.push([args?.session_id, args?.data]);
      return Promise.resolve(null);
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
  return typed;
}

async function inStore(fn) {
  await freshStart();
  try {
    await fn();
  } finally {
    teardown();
  }
}

describe('Run dialog: typing the line', () => {
  test('PCR-05: into a terminal already open the line is typed and left at its prompt — never an Enter, whatever was asked; Run with Enter is for a fresh shell', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const typed = await writes(async () => {
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: "npm test -- 'a b'", enter: true }), true);
        await S.getState().writeRaw(tab, '\x03'); // the user clears it again
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: 'npm run lint', enter: false }), true);
      });
      assert.deepEqual(typed, [
        [sessionOf(tab), "npm test -- 'a b'"],
        [sessionOf(tab), '\x03'],
        [sessionOf(tab), 'npm run lint'],
      ]);
    });
  });

  test('PCR-06: never into a password prompt — nothing typed, and the terminal says why', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      await echo(tab, true);
      const typed = await writes(async () => {
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: 'npm test', enter: true }), false);
      });
      assert.deepEqual(typed, []);
      assert.match(notices.at(-1)?.message ?? '', /^project command not typed — this terminal is asking for a password, and typing is hidden: npm test$/);
      await echo(tab, false);
    });
  });

  test('PCR-07: a terminal that started something by the time it would be typed takes nothing, and says why', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab ? { ...t, running: true } : t)) }));
      const typed = await writes(async () => {
        assert.equal(await S.getState().typeProjectCommand(tab, 'npm test'), false);
      });
      assert.deepEqual(typed, []);
      assert.match(notices.at(-1)?.message ?? '', /^project command not typed — something is already running here: npm test$/);
    });
  });

  test('PCR-08: a new split is made, and typed into once its shell is ready — not the terminal it was split from', async () => {
    await inStore(async () => {
      const first = S.getState().activeTabId;
      await prompt(first);
      let result;
      const typed = await writes(async () => {
        const run = S.getState().runProjectCommand({ target: 'split', tabId: first, line: 'npm run dev', enter: true });
        // The new terminal's shell draws its prompt.
        for (let i = 0; i < 50 && S.getState().tabs.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
        const second = S.getState().tabs.find((t) => t.id !== first);
        assert.ok(second, 'a new terminal was made');
        await prompt(second.id);
        result = await run;
      });
      const second = S.getState().tabs.find((t) => t.id !== first);
      assert.equal(result, true);
      assert.deepEqual(typed, [[second.sessionId, 'npm run dev\r']]);
      const group = S.getState().getActiveGroup();
      assert.equal(group.tree.type, 'split', 'beside the one it was split from');
    });
  });

  test('PCR-09: a line quoted for one shell is not typed into another — the new terminal says so', async () => {
    const system = useSystemStore.getState();
    await inStore(async () => {
      useSystemStore.setState({ os: 'windows' });
      const first = S.getState().activeTabId;
      S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === first ? { ...t, shell: 'pwsh.exe' } : t)) }));
      await prompt(first);
      const typed = await writes(async () => {
        const run = S.getState().runProjectCommand({ target: 'split', tabId: first, line: 'findstr "two words"', enter: true, kind: 'cmd', label: 'cmd', quoted: true });
        for (let i = 0; i < 50 && S.getState().tabs.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
        const second = S.getState().tabs.find((t) => t.id !== first);
        await prompt(second.id);
        assert.equal(await run, false);
      });
      assert.deepEqual(typed, []);
      assert.match(notices.at(-1)?.message ?? '', /its values were quoted for cmd, and this terminal runs PowerShell 7: findstr "two words"$/);
      // No value in it: nothing depends on the shell, and it goes.
      const plain = await writes(async () => {
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: first, line: 'dir', enter: true, kind: 'cmd', quoted: false }), true);
      });
      assert.equal(plain.length, 1);
    }).finally(() => useSystemStore.setState({ os: system.os }));
  });

  test('PCR-10: a line with a line break is not typed, whoever built it — right before typing, the store asks again', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const typed = await writes(async () => {
        assert.equal(await S.getState().typeProjectCommand(tab, 'echo ok\nrm -rf ~'), false);
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: 'echo \u{202E}gnp.exe' }), false);
      });
      assert.deepEqual(typed, []);
      assert.match(notices[0]?.message ?? '', /project command not typed — the line holds a line break/);
    });
  });

  test('PCR-11: Run pressed twice on one opening — a double-click, Enter while it types — types once', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const P = useProjectCommandsStore;
      const before = P.getState().running;
      const command = parseCommandsFile(JSON.stringify({ version: 1, commands: [{ name: 'T', command: 'npm test' }] }), { source: 'user' }).commands[0];
      P.setState({ running: { id: 9001, command } });
      try {
        const plan = { target: 'this', tabId: tab, line: 'npm test', enter: true };
        const typed = await writes(async () => {
          const results = await Promise.all([P.getState().submitRun(9001, plan), P.getState().submitRun(9001, plan), P.getState().submitRun(9001, plan)]);
          assert.deepEqual(results, [true, false, false]);
        });
        assert.deepEqual(typed, [[sessionOf(tab), 'npm test']]);
      } finally {
        P.setState({ running: before });
      }
    });
  });

  test("PCR-12: a startup command still types as it did, with its own words — the wait is the one they share", async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const typed = await writes(async () => {
        assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), true);
      });
      assert.deepEqual(typed, [[sessionOf(tab), 'npm run dev\r']]);
      S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab ? { ...t, running: true } : t)) }));
      assert.equal(await S.getState().typeStartupCommand(tab, 'npm run dev'), false);
      assert.equal(notices.at(-1)?.message, 'startup command not typed — something is already running here: npm run dev');
    });
  });

  test('PCR-13: the run dialog reads only primitives of the terminal store — output and retitles elsewhere do not redraw it', () => {
    const tabs = [{ id: 't1', title: 'a', shell: 'zsh', cwd: '/w' }, { id: 't2', title: 'b', shell: 'zsh' }];
    const view = runTargetView(terminalState(tabs));
    assert.ok(Object.values(view).every((v) => v === null || ['string', 'boolean'].includes(typeof v)), JSON.stringify(view));
    const later = runTargetView(terminalState(tabs.map((t) => (t.id === 't2' ? { ...t, title: 'renamed', running: true } : t))));
    assert.deepEqual(later, view, 'another terminal changing is nothing to this one');
  });
});

describe('Run dialog: never onto a line already there, never into another terminal', () => {
  test('PCR-16: text half-typed at the prompt — the line is not typed onto it; cleared, it is', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const typed = await writes(async () => {
        await S.getState().writeRaw(tab, 'git push --force ');
        assert.equal(S.getState().projectCommandBlock(tab), TYPED_REASON);
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: 'echo hi', enter: true }), false);
      });
      assert.deepEqual(typed.map(([, d]) => d), ['git push --force '], 'nothing typed onto it');
      assert.match(notices.at(-1)?.message ?? '', /^project command not typed — something is typed at its prompt — clear it, or use New split: echo hi$/);
      // Erased key by key: an empty prompt again.
      await writes(async () => {
        for (let i = 0; i < 'git push --force '.length; i += 1) await S.getState().writeRaw(tab, '\x7f');
      });
      assert.equal(S.getState().projectCommandBlock(tab), null);
      const after = await writes(async () => {
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: 'echo hi', enter: true }), true);
      });
      assert.deepEqual(after.map(([, d]) => d), ['echo hi'], 'typed, and left for the user to run');
    });
  });

  test("PCR-17: a line edited with keys NexTerm cannot follow, or a shell that never says where its prompt is: not typed — it cannot tell what is there", async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      // No OSC 133 "D" yet: fish, sh, WSL look like this for good.
      assert.equal(S.getState().projectCommandBlock(tab), UNTOLD_REASON);
      assert.equal(S.getState().projectCommandBlock(tab, { fresh: true }), null, 'a terminal NexTerm has just started for the line is not asked that');
      await prompt(tab);
      assert.equal(S.getState().projectCommandBlock(tab), null);
      await writes(() => S.getState().writeRaw(tab, '\x1b[A')); // ↑: a line from history
      assert.equal(S.getState().projectCommandBlock(tab), UNKNOWN_LINE_REASON);
      const typed = await writes(async () => {
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: 'echo hi' }), false);
      });
      assert.deepEqual(typed, []);
      await writes(() => S.getState().writeRaw(tab, '\x03')); // ^C: the shell drops the line
      assert.equal(S.getState().projectCommandBlock(tab), null);
    });
  });

  test('PCR-18: a new split the user typed into while its shell started takes nothing; nor does any terminal once the caller says no right before typing', async () => {
    await inStore(async () => {
      const first = S.getState().activeTabId;
      await prompt(first);
      const typed = await writes(async () => {
        const run = S.getState().runProjectCommand({ target: 'split', tabId: first, line: 'npm run dev' });
        for (let i = 0; i < 50 && S.getState().tabs.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
        const second = S.getState().tabs.find((t) => t.id !== first);
        await S.getState().writeRaw(second.id, 'ls');
        await prompt(second.id);
        assert.equal(await run, false);
      });
      assert.deepEqual(typed.map(([, d]) => d), ['ls'], 'nothing typed onto what the user typed');
      // Typed before the shell's first prompt, it shows at that prompt: what
      // is there is not known, and nothing is typed onto it.
      assert.match(notices.at(-1)?.message ?? '', /cannot tell what is typed at its prompt.*: npm run dev$/);
      // The caller's own last word (the folder's commands no longer trusted).
      const refused = await writes(async () => {
        assert.equal(
          await S.getState().runProjectCommand({ target: 'this', tabId: first, line: 'echo hi', check: () => "this folder's commands are no longer trusted" }),
          false
        );
      });
      assert.deepEqual(refused, []);
      assert.match(notices.at(-1)?.message ?? '', /no longer trusted: echo hi$/);
    });
  });

  test('PCR-19: the terminal the dialog was opened over, or nothing — another made active, or this one restarted, is not typed into', async () => {
    await inStore(async () => {
      const first = S.getState().activeTabId;
      await prompt(first);
      const sessionId = S.getState().tabs.find((t) => t.id === first).sessionId;
      const second = (await S.getState().createTab()).id;
      await prompt(second);
      assert.equal(S.getState().activeTabId, second, 'setup: another terminal is active now');
      const typed = await writes(async () => {
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: first, sessionId, line: 'echo hi' }), true);
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: first, sessionId: 'pty-old', line: 'echo hi' }), false);
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: 'tab-gone', line: 'echo hi' }), false);
      });
      assert.deepEqual(typed, [[sessionId, 'echo hi']], 'only into the pinned terminal, once');
      assert.match(notices.at(-1)?.message ?? '', /that terminal has closed: echo hi$/);
      assert.ok(notices.some((n) => /its shell was restarted since this opened/.test(n.message)));
      // A split goes beside the pinned terminal, not beside the active one.
      const before = S.getState().getActiveGroup();
      const firstPane = before && JSON.stringify(before.tree).includes(first);
      assert.ok(firstPane, 'setup');
    });
  });
});

describe('Run dialog: what the shell may still hold (review rounds 2 and 3)', () => {
  const started = (tabId) => mockBridge.emit('pty-command-started', { session_id: sessionOf(tabId) });
  const typeKeys = async (tabId, text) => {
    for (const ch of text) await S.getState().writeRaw(tabId, ch);
  };

  test('PCR-20: keys typed into a program on the normal screen (a password, a REPL) leave the next line followed as before — an agent typed at that prompt is recorded', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      await writes(async () => {
        await typeKeys(tab, 'sudo -k true\r');
        await started(tab);
        await typeKeys(tab, 'hunter2\r'); // the password, on the normal screen
        await prompt(tab);
        await typeKeys(tab, 'opencode\r');
        await started(tab);
      });
      const t = tabById(tab);
      assert.equal(t.commandLine, 'opencode', 'the line typed at that prompt is followed');
      assert.equal(t.agent?.kind, 'opencode', 'and the agent typed there is recorded — so it is offered back after a restart');
    });
  });

  test("PCR-21: what xterm sends in reply — device attributes, XTVERSION, DECRQSS, the cursor's position, focus and mouse reports — is not text at the prompt", async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      const replies = [
        '\x1b[?62;22c',
        '\x1b[>0;276;0c',
        '\x1bP>|xterm.js(6.0.0)\x1b\\',
        '\x1bP1$r0m\x1b\\',
        '\x1b[12;1R',
        '\x1b[I',
        '\x1b[O',
        '\x1b[<0;10;5M',
        '\x1b[M !!',
        '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\',
      ];
      // Before the first prompt (a fresh shell asks, xterm answers) and at it.
      await writes(async () => {
        for (const r of replies) await S.getState().writeRaw(tab, r);
      });
      await prompt(tab);
      assert.equal(S.getState().projectCommandBlock(tab), null, 'a reply before the first prompt read as typeahead');
      await writes(async () => {
        for (const r of replies) await S.getState().writeRaw(tab, r);
      });
      assert.equal(S.getState().projectCommandBlock(tab), null, 'a reply at the prompt read as typed text');
      // A key is still a key: an arrow recalls history.
      await writes(() => S.getState().writeRaw(tab, '\x1b[A'));
      assert.equal(S.getState().projectCommandBlock(tab), UNKNOWN_LINE_REASON);
    });
  });

  test('PCR-22: a line left open — `echo "abc` and Enter — has the shell waiting for the rest: not typed into until it starts the line or draws a prompt', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const typed = await writes(async () => {
        await S.getState().writeRaw(tab, 'echo "abc\r'); // dquote> — no C, no D
        assert.equal(S.getState().projectCommandBlock(tab), PENDING_REASON);
        assert.equal(await S.getState().runProjectCommand({ target: 'this', tabId: tab, line: 'echo BBB', enter: true }), false);
      });
      assert.deepEqual(typed.map(([, d]) => d), ['echo "abc\r'], 'typed into the open quote');
      // The rest of it, and the command starts: answered.
      await writes(() => S.getState().writeRaw(tab, 'def"\r'));
      await started(tab);
      await prompt(tab);
      assert.equal(S.getState().projectCommandBlock(tab), null);
      // An empty Enter at a prompt is answered with a prompt (every hook draws a D).
      await writes(() => S.getState().writeRaw(tab, '\r'));
      assert.equal(S.getState().projectCommandBlock(tab), PENDING_REASON);
      await prompt(tab);
      assert.equal(S.getState().projectCommandBlock(tab), null);
    });
  });

  test('PCR-23: a new shell after the old one exited keeps nothing of what was known about the old one — text at its prompt, a line it waited on', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      await writes(async () => {
        await S.getState().writeRaw(tab, 'echo "abc\r'); // pending
        await S.getState().writeRaw(tab, 'git '); // and text at the prompt
      });
      assert.equal(S.getState().projectCommandBlock(tab), PENDING_REASON);
      S.setState((st) => ({ tabs: st.tabs.map((t) => (t.id === tab ? { ...t, exited: { code: 0 } } : t)) }));
      assert.equal(await S.getState().restartShell(tab), true);
      assert.equal(S.getState().projectCommandBlock(tab, { fresh: true }), null, 'the new shell still waits on the old one\'s line');
      await prompt(tab);
      assert.equal(S.getState().projectCommandBlock(tab), null, "the old shell's text at the new prompt");
    });
  });

  test('PCR-24: a new split takes the keyboard only once its line is typed — nothing the user types goes into the shell as it starts — and not when the user went elsewhere', async () => {
    await inStore(async () => {
      const first = S.getState().activeTabId;
      await prompt(first);
      const fromPane = S.getState().getActivePaneId();
      let newPane = null;
      const typed = await writes(async () => {
        const run = S.getState().runProjectCommand({ target: 'split', tabId: first, line: 'npm run dev' });
        for (let i = 0; i < 50 && S.getState().tabs.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
        const second = S.getState().tabs.find((t) => t.id !== first);
        assert.equal(S.getState().getActivePaneId(), fromPane, 'the new pane took the keyboard while its shell started');
        await prompt(second.id);
        assert.equal(await run, true);
        newPane = S.getState().getActivePaneId();
      });
      assert.equal(typed.length, 1);
      assert.notEqual(newPane, fromPane, 'and once it is typed, the new terminal has the keyboard');

      // Gone elsewhere meanwhile: left there.
      await writes(async () => {
        const run = S.getState().runProjectCommand({ target: 'split', tabId: first, line: 'npm test' });
        for (let i = 0; i < 50 && S.getState().tabs.length < 3; i += 1) await new Promise((r) => setTimeout(r, 5));
        S.getState().setActivePane(fromPane);
        const third = S.getState().tabs.find((t) => t.id !== first && !S.getState().tabs.slice(0, 2).some((x) => x.id === t.id));
        await prompt(third.id);
        await run;
      });
      assert.equal(S.getState().getActivePaneId(), fromPane, 'the keyboard was taken from where the user went');
    });
  });
});

describe('Run dialog: NexTerm\'s own line', () => {
  test('PCR-25: the line NexTerm types into a new shell before its first prompt is not typeahead — that prompt stays free', async () => {
    await inStore(async () => {
      const first = S.getState().activeTabId;
      await prompt(first);
      // No first prompt reported within the wait (a slow rc): typed anyway —
      // and the shell answers at once, before the write is even done (the
      // way the browser mock answers).
      const original = mockBridge.invoke;
      mockBridge.invoke = async function (command, args, ...rest) {
        if (command !== 'pty_write') return original.call(this, command, args, ...rest);
        await mockBridge.emit('pty-command-started', { session_id: args.session_id });
        await mockBridge.emit('pty-command-done', { session_id: args.session_id, exit_code: 0 });
        return null;
      };
      let second = null;
      try {
        assert.equal(await S.getState().runProjectCommand({ target: 'split', tabId: first, line: 'npm run dev' }), true);
        second = S.getState().tabs.find((t) => t.id !== first).id;
      } finally {
        mockBridge.invoke = original;
      }
      assert.equal(S.getState().projectCommandBlock(second), null, "NexTerm's own line read as the user's typeahead");
    });
  });
});
