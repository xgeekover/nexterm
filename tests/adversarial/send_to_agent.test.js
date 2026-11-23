/**
 * Send to Agent (bundle 4, A4): the @ reference typed for a file, a folder
 * or the editor's selection (src/lib/agentReference.js, AC15), the terminal
 * it goes to and how it is typed (the store's `typeAgentReference`,
 * src/lib/sendToAgent.js, AC16) — into the real store on the browser mock,
 * a real @xterm/headless terminal as the shown one, every pty_write counted.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { useToastStore, resetToasts } from '../../src/stores/toastStore.js';
import { __resetTabMru, ensureTabMruStarted } from '../../src/stores/tabSwitcherStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { setContextAfterOutputSource, setContextTerminalSource } from '../../src/lib/copyContext.js';
import { withReadOnly } from '../../src/lib/readOnly.js';
import {
  NO_AGENT_REASON,
  NO_EDITOR_FILE_REASON,
  SAVE_FIRST_REASON,
  SEND_FILE_TITLE,
  SEND_SELECTION_TITLE,
  SEND_TO_AGENT_LABEL,
  agentTerminals,
  editorSendProblem,
  referenceForPath,
  referenceForSelection,
  referencePaste,
  selectionLines,
  targetChoice,
} from '../../src/lib/agentReference.js';
import {
  SEND_FILE_ACTION_ID,
  SEND_SELECTION_ACTION_ID,
  SEND_TO_AGENT_MODE,
  addAgentEditorActions,
  explorerSendProblem,
  pendingAgentPick,
  sendCommandState,
  sendFileToAgent,
  sendPathToAgent,
  sendPendingTo,
  sendSelectionToAgent,
  trackAgentEditor,
} from '../../src/lib/sendToAgent.js';
import { sendToAgentItem } from '../../src/components/explorer/explorerOpenActions.js';
import { COMMANDS, keysFor, menuIdOf, resolveKeybindings } from '../../src/lib/keybindings.js';
import { buildPaletteGroups, paletteCommands } from '../../src/lib/paletteItems.js';
import { workbenchContext } from '../../src/lib/workbenchCommands.js';

const { Terminal } = headless;
const S = terminalStore.useTerminalStore;
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (rel) => lf(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

const ABS = '/Users/dev/project/src/auth.js';
const DIR = '/Users/dev/project/src';
const sel = (startLineNumber, startColumn, endLineNumber, endColumn) => ({ startLineNumber, startColumn, endLineNumber, endColumn });

// ---- AC15: the reference text --------------------------------------------------

describe('Send to Agent: the @ reference (AC15)', () => {
  test('STA-01: a file gives "@<abs> ", a folder "@<abs dir> ", a Windows path the same', () => {
    assert.deepEqual(referenceForPath(ABS), { text: `@${ABS} ` });
    assert.deepEqual(referenceForPath(DIR), { text: `@${DIR} ` });
    assert.deepEqual(referenceForPath('C:\\work\\app\\main.rs'), { text: '@C:\\work\\app\\main.rs ' });
    assert.deepEqual(referenceForPath('D:/work/app'), { text: '@D:/work/app ' });
  });

  test('STA-02: a selection of lines 10-20 says "(lines 10-20)", one line "(line 12)", and one ending at column 1 of line 21 still says 10-20', () => {
    assert.deepEqual(referenceForSelection(ABS, sel(10, 3, 20, 7)), { text: `@${ABS} (lines 10-20) ` });
    assert.deepEqual(referenceForSelection(ABS, sel(12, 1, 12, 9)), { text: `@${ABS} (line 12) ` });
    // A whole-line drag ends at column 1 of the next line, which it does not include.
    assert.deepEqual(referenceForSelection(ABS, sel(10, 1, 21, 1)), { text: `@${ABS} (lines 10-20) ` });
    // Down to one line, it says so.
    assert.deepEqual(referenceForSelection(ABS, sel(20, 1, 21, 1)), { text: `@${ABS} (line 20) ` });
    // An empty selection is its caret's line.
    assert.deepEqual(referenceForSelection(ABS, sel(12, 5, 12, 5)), { text: `@${ABS} (line 12) ` });
    // Ending at column 2 of line 21 includes line 21.
    assert.deepEqual(selectionLines(sel(10, 1, 21, 2)), { start: 10, end: 21 });
    assert.equal(selectionLines(null), null);
    assert.ok(referenceForSelection(ABS, null).error, 'no selection, no reference');
  });

  test('STA-03: no output ever holds "#L"; a path with whitespace or a control character is refused with a reason', () => {
    const outputs = [
      referenceForPath(ABS),
      referenceForPath(DIR),
      referenceForSelection(ABS, sel(10, 1, 20, 4)),
      referenceForSelection(ABS, sel(12, 1, 12, 4)),
      referenceForSelection(ABS, sel(10, 1, 21, 1)),
    ];
    for (const out of outputs) {
      assert.ok(typeof out.text === 'string' && out.text.startsWith('@/'), JSON.stringify(out));
      assert.equal(out.text.includes('#L'), false, `${out.text} holds #L`);
      assert.equal(/[\r\n]/.test(out.text), false, `${out.text} holds a line break`);
      assert.ok(out.text.endsWith(' '), 'a space ends the reference');
    }
    for (const bad of ['/Users/dev/my project/a.js', '/a/b\u00a0c.js', '/a/b\u2028c.js', 'C:\\Program Files\\x.txt']) {
      const out = referenceForPath(bad);
      assert.equal(out.text, undefined, `${JSON.stringify(bad)} is not sent`);
      assert.match(out.error, /space or another blank/, 'the reason names the blank');
      assert.ok(referenceForSelection(bad, sel(1, 1, 2, 1)).error, 'nor as a selection');
    }
    // A tab is a blank too, and a control character: refused either way.
    for (const bad of ['/a/b\tc.js', '/a/b\u0007.js', '/a/\u001b[31m.js', '/a/b\u009b.js']) {
      assert.match(referenceForPath(bad).error, /control character/, JSON.stringify(bad));
    }
    assert.match(referenceForPath('src/auth.js').error, /absolute/, 'a relative path is refused');
    assert.ok(referenceForPath('').error);
    assert.ok(referenceForPath(null).error);
  });
});

// ---- AC16: the target and the typing -------------------------------------------

const agentTab = (id, extra = {}) => ({
  id,
  sessionId: `s-${id}`,
  exited: false,
  agent: { kind: 'claude', sessionId: null, startedAt: 0, title: null },
  agentTyped: { sessionId: `s-${id}` },
  agentResumeOffered: false,
  ...extra,
});

describe('Send to Agent: which terminal (AC16)', () => {
  test('STA-10: only terminals running Claude Code or OpenCode that have not exited; none, one, several (most recent first)', () => {
    const plain = { id: 'p', sessionId: 's-p', exited: false, agent: null };
    const exited = agentTab('x', { exited: true });
    const offered = agentTab('o', { agentResumeOffered: true });
    const unknown = agentTab('u', { agent: { kind: 'aider' } });
    const otherShell = agentTab('w', { agentTyped: { sessionId: 'an-older-shell' } });
    assert.deepEqual(agentTerminals([plain, exited, offered, unknown, otherShell]), []);
    assert.deepEqual(targetChoice([]), { kind: 'none', reason: NO_AGENT_REASON });
    assert.equal(NO_AGENT_REASON, 'No terminal is running Claude Code or OpenCode');

    const a = agentTab('a');
    const b = agentTab('b', { agent: { kind: 'opencode', sessionId: null, startedAt: 0, title: null } });
    const c = agentTab('c');
    assert.deepEqual(targetChoice(agentTerminals([plain, a, exited])), { kind: 'one', tabId: 'a' });
    // The most recently focused first; one never focused after those that were.
    const order = agentTerminals([a, plain, b, c], ['p', 'c', 'a']).map((t) => t.id);
    assert.deepEqual(order, ['c', 'a', 'b']);
    assert.deepEqual(targetChoice(agentTerminals([a, b, c], ['b', 'c'])), { kind: 'pick', tabIds: ['b', 'c', 'a'] });
  });

  test('STA-11: typed as a paste — bracketed only when the program asked for it — and never with a CR or LF', () => {
    const text = `@${ABS} (lines 10-20) `;
    assert.deepEqual(referencePaste(text), { data: text });
    assert.deepEqual(referencePaste(text, { bracketedPaste: false }), { data: text });
    assert.deepEqual(referencePaste(text, { bracketedPaste: true }), { data: `\x1b[200~${text}\x1b[201~` });
    for (const on of [false, true]) {
      const { data } = referencePaste(text, { bracketedPaste: on });
      assert.equal(/[\r\n]/.test(data), false, 'no Enter, no line feed');
      assert.ok(!data.endsWith('\r'));
    }
    assert.ok(referencePaste(`${text}\n`).error, 'a trailing newline is refused, not typed as Enter');
    assert.ok(referencePaste(`${text}\r`, { bracketedPaste: true }).error);
    assert.ok(referencePaste('@/a\u202e.js ').error, 'a direction character is refused (encodeText)');
  });
});

// ---- the store, on the mock ----------------------------------------------------

const backing = new Map();
let unsink = null;
let previousWait = null;
let hadStorage = false;
let previousStorage;
let previousEditor = null;
let unsource = null;

async function freshStart() {
  S.getState().dispose();
  // A suite that loads the real registry (terminal_file_drop) leaves its
  // after-output lookup registered, answering null for these tabs: the
  // terminals here are handed in, read through their own write queue.
  setContextAfterOutputSource(null);
  hadStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  previousStorage = globalThis.localStorage;
  backing.clear();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  previousWait = terminalStore.__setAgentPromptWaitMs(300);
  unsink = setTerminalNoticeSink(() => true);
  resetToasts();
  useSettingsStore.getState().resetSettings();
  S.getState().forgetInputHidden?.();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [], secretInput: {}, readOnly: {}, notifications: [] });
  previousEditor = { tabs: useEditorStore.getState().tabs, activeTabId: useEditorStore.getState().activeTabId };
  await S.getState().init();
  __resetTabMru();
}

function teardown() {
  unsource?.();
  unsource = null;
  __resetTabMru();
  S.getState().dispose();
  unsink?.();
  unsink = null;
  if (previousWait !== null) terminalStore.__setAgentPromptWaitMs(previousWait);
  previousWait = null;
  if (previousEditor) useEditorStore.setState(previousEditor);
  previousEditor = null;
  resetToasts();
  useSettingsStore.getState().resetSettings();
  if (hadStorage) globalThis.localStorage = previousStorage;
  else delete globalThis.localStorage;
}

async function inStore(fn) {
  await freshStart();
  try {
    await fn();
  } finally {
    teardown();
  }
}

const tabById = (id) => S.getState().tabs.find((t) => t.id === id);
const sessionOf = (tabId) => tabById(tabId).sessionId;
const prompt = (tabId) => mockBridge.emit('pty-command-done', { session_id: sessionOf(tabId), exit_code: 0 });
const toasts = () => useToastStore.getState().toasts;
const errors = () => toasts().filter((t) => t.kind === 'error').map((t) => t.text);
const confirms = () => toasts().filter((t) => t.kind === 'confirm').map((t) => t.text);

/** Every pty_write while `fn` runs, as `[sessionId, data]`, answered at once. */
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
    await sleep(5);
  } finally {
    mockBridge.invoke = original;
  }
  return typed;
}

/** Mark `tabId` as running `kind` (Claude Code by default), typed at a prompt into its own shell. */
function runAgent(tabId, kind = 'claude') {
  S.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tabId
        ? { ...t, agent: { kind, sessionId: null, startedAt: Date.now(), title: null }, agentTyped: { sessionId: t.sessionId }, agentResumeOffered: false }
        : t
    ),
  }));
}

/** Shown terminals by tab id, as the registry's `existingTerminal` hands them to Copy Context and Send to Agent. */
function showTerminals(map) {
  unsource?.();
  unsource = setContextTerminalSource((id) => map.get(id) ?? null);
}

const newTerm = () => new Terminal({ cols: 60, rows: 8, scrollback: 100, allowProposedApi: true });

describe('Send to Agent: typing into the agent terminal (AC16)', () => {
  test('STA-12: typed into the one agent terminal, plain or bracketed as its program asked, no CR or LF; the terminal is shown and a toast says what went where', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      runAgent(tab);
      const term = newTerm();
      const text = `@${ABS} (lines 10-20) `;
      let outcome;
      let typed = await writes(async () => {
        outcome = await S.getState().typeAgentReference(tab, text, { terminalOf: () => term });
      });
      assert.equal(outcome.status, 'typed');
      assert.deepEqual(typed, [[sessionOf(tab), text]], 'plain: the program did not ask for bracketed paste');
      assert.equal(S.getState().activeTabId, tab, 'the target is the active terminal');
      assert.equal(confirms().length, 1);
      assert.match(confirms()[0], /^Typed @\/Users\/dev\/project\/src\/auth\.js \(lines 10-20\) into Claude Code in “.+” — Enter not pressed$/);

      await write(term, '\x1b[?2004h');
      typed = await writes(async () => {
        outcome = await S.getState().typeAgentReference(tab, text, { terminalOf: () => term });
      });
      assert.equal(outcome.status, 'typed');
      assert.deepEqual(typed, [[sessionOf(tab), `\x1b[200~${text}\x1b[201~`]], 'bracketed: the program turned it on');
      for (const [, data] of typed) assert.equal(/[\r\n]/.test(data), false, 'Enter is never pressed');
      assert.deepEqual(errors(), []);
    });
  });

  test('STA-13: refused — nothing written, an error toast — for typing hidden, a password prompt on screen, read-only, exited, never shown, no agent, another user in the foreground', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      runAgent(tab);
      const text = `@${ABS} `;
      const attempt = async (label, setup, undo, terminalOf, expected) => {
        resetToasts();
        const term = newTerm();
        await setup?.(term);
        let outcome;
        const typed = await writes(async () => {
          outcome = await S.getState().typeAgentReference(tab, text, { terminalOf: terminalOf ?? (() => term), waitMs: 300 });
        });
        await undo?.();
        assert.deepEqual(typed, [], `${label}: no pty_write`);
        assert.ok(expected.includes(outcome.status), `${label}: ${outcome.status}`);
        assert.equal(errors().length, 1, `${label}: one error toast`);
        assert.match(errors()[0], /^Not sent: /, label);
        assert.deepEqual(confirms(), [], `${label}: no confirmation`);
        return errors()[0];
      };

      const hidden = await attempt(
        'typing hidden',
        () => S.getState().noteInputHidden(sessionOf(tab), true),
        () => S.getState().noteInputHidden(sessionOf(tab), false),
        null,
        ['hidden', 'starting']
      );
      assert.match(hidden, /password|prompt/);

      const password = await attempt('password prompt on screen', (term) => write(term, '[sudo] password for dev: '), null, null, ['refused']);
      assert.match(password, /password prompt/);

      const readOnly = await attempt(
        'read-only',
        () => S.setState((s) => ({ readOnly: withReadOnly(s.readOnly, tab, true) })),
        () => S.setState((s) => ({ readOnly: withReadOnly(s.readOnly, tab, false) })),
        null,
        ['read-only']
      );
      assert.match(readOnly, /read-only/);

      const neverShown = await attempt('never shown', null, null, () => null, ['never-shown']);
      assert.match(neverShown, /not been shown/);

      const session = mockBridge.ptySessions?.get(sessionOf(tab));
      assert.ok(session, 'setup: the mock holds the session');
      {
        const other = await attempt(
          'another user in the foreground',
          () => {
            session.foregroundSameUser = false;
          },
          () => {
            delete session.foregroundSameUser;
          },
          null,
          ['refused']
        );
        assert.match(other, /another user/);
      }

      const noAgent = await attempt(
        'no agent any more',
        () => S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab ? { ...t, agent: null } : t)) })),
        () => runAgent(tab),
        null,
        ['no-agent']
      );
      assert.match(noAgent, /no longer runs/);

      const exited = await attempt(
        'exited',
        () => S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab ? { ...t, exited: true } : t)) })),
        null,
        null,
        ['exited']
      );
      assert.match(exited, /exited/);
    });
  });

  test('STA-14: no agent terminal greys out every item with the reason; a modified or untitled editor greys out the editor items with "Save the file first"', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      useEditorStore.setState({ tabs: [{ id: 'e1', filePath: ABS, fileName: 'auth.js', isDirty: false }], activeTabId: 'e1' });
      // No agent anywhere.
      assert.deepEqual(sendCommandState(), { selection: NO_AGENT_REASON, file: NO_AGENT_REASON });
      assert.equal(explorerSendProblem(ABS), NO_AGENT_REASON);
      const groups = buildPaletteGroups({ mode: 'all', query: '', sendToAgent: sendCommandState() });
      const rows = groups.flatMap((g) => g.items).filter((i) => i.command === 'send_selection_to_agent' || i.command === 'send_file_to_agent');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.disabledReason, NO_AGENT_REASON);
        assert.equal(row.subtitle, NO_AGENT_REASON, 'the row says why');
      }
      const item = sendToAgentItem({ type: 'file', path: ABS }, { label: SEND_TO_AGENT_LABEL, problemOf: explorerSendProblem, send: () => {} });
      assert.equal(item.disabled, true);
      assert.equal(item.disabledReason, NO_AGENT_REASON);
      // A bound chord, or the editor's menu, says it in a toast and types nothing.
      resetToasts();
      const typed = await writes(async () => {
        await sendFileToAgent();
        await sendSelectionToAgent();
        await sendPathToAgent(DIR);
      });
      assert.deepEqual(typed, []);
      assert.ok(errors().every((t) => t === `Not sent: ${NO_AGENT_REASON}`) && errors().length >= 1);

      // An agent: the saved file can go, a modified or untitled one cannot.
      runAgent(tab);
      assert.equal(sendCommandState().file, null);
      assert.equal(explorerSendProblem(ABS), null);
      assert.match(explorerSendProblem('/Users/dev/my project/a.js'), /space/);
      assert.equal(SAVE_FIRST_REASON, 'Save the file first: the agent reads it from disk');
      assert.equal(editorSendProblem({ filePath: ABS, isDirty: true }), SAVE_FIRST_REASON);
      assert.equal(editorSendProblem({ filePath: '', isDirty: false }), SAVE_FIRST_REASON, 'untitled');
      assert.equal(editorSendProblem({ filePath: 'Untitled-1', isDirty: false }), SAVE_FIRST_REASON, 'untitled');
      assert.equal(editorSendProblem({ filePath: ABS, isDirty: false }), null);
      useEditorStore.setState({ tabs: [{ id: 'e1', filePath: ABS, fileName: 'auth.js', isDirty: true }], activeTabId: 'e1' });
      assert.deepEqual(sendCommandState(), { selection: SAVE_FIRST_REASON, file: SAVE_FIRST_REASON });
      const dirtyRows = buildPaletteGroups({ mode: 'all', query: 'agent', sendToAgent: sendCommandState() })
        .flatMap((g) => g.items)
        .filter((i) => i.command === 'send_file_to_agent' || i.command === 'send_selection_to_agent');
      assert.equal(dirtyRows.length, 2);
      assert.ok(dirtyRows.every((r) => r.disabledReason === SAVE_FIRST_REASON));
      resetToasts();
      const none = await writes(async () => {
        await sendFileToAgent();
        await sendSelectionToAgent({ getSelection: () => sel(1, 1, 2, 1) }, ABS);
      });
      assert.deepEqual(none, [], 'a modified file is not sent');
      assert.deepEqual(errors(), [`Not sent: ${SAVE_FIRST_REASON}`]);
    });
  });

  test('STA-15: one agent terminal is the target; several open the pick, the most recently focused first, and the one picked gets it', async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      await prompt(a);
      runAgent(a);
      const termA = newTerm();
      const terms = new Map([[a, termA]]);
      showTerminals(terms);
      useEditorStore.setState({ tabs: [{ id: 'e1', filePath: ABS, fileName: 'auth.js', isDirty: false }], activeTabId: 'e1' });

      // One: typed there, no pick.
      let typed = await writes(async () => {
        const outcome = await sendFileToAgent();
        assert.equal(outcome.status, 'typed');
      });
      assert.deepEqual(typed, [[sessionOf(a), `@${ABS} `]]);
      assert.equal(useSettingsStore.getState().isCommandPaletteOpen, false, 'no pick for one');

      // The selection of the editor focused last.
      let focusEditor = null;
      let disposeEditor = null;
      const editor = {
        getSelection: () => sel(10, 1, 21, 1),
        onDidFocusEditorWidget: (fn) => {
          focusEditor = fn;
        },
        onDidDispose: (fn) => {
          disposeEditor = fn;
        },
      };
      trackAgentEditor(editor, () => ABS);
      focusEditor();
      // Shown in no pane here, the file is no longer the editor store's
      // active tab once a terminal is switched to: it is again, as it is in
      // the app while the editor is used.
      useEditorStore.setState({ tabs: [{ id: 'e1', filePath: ABS, fileName: 'auth.js', isDirty: false }], activeTabId: 'e1' });
      assert.equal(sendCommandState().selection, null);
      typed = await writes(() => sendSelectionToAgent());
      assert.deepEqual(typed, [[sessionOf(a), `@${ABS} (lines 10-20) `]]);
      // Disposed, its selection is not read any more.
      disposeEditor();
      useEditorStore.setState({ tabs: [{ id: 'e1', filePath: ABS, fileName: 'auth.js', isDirty: false }], activeTabId: 'e1' });
      assert.equal(sendCommandState().selection, 'Select lines in the editor first');

      // Several: a second agent terminal, focused after the first.
      ensureTabMruStarted();
      const b = (await S.getState().createTab()).id;
      await prompt(b);
      runAgent(b, 'opencode');
      terms.set(b, newTerm());
      S.getState().switchTab(b);
      S.getState().switchTab(a);
      S.getState().switchTab(b);
      resetToasts();
      typed = await writes(async () => {
        const outcome = await sendPathToAgent(DIR);
        assert.equal(outcome.status, 'pick');
      });
      assert.deepEqual(typed, [], 'nothing typed before the pick');
      assert.equal(useSettingsStore.getState().isCommandPaletteOpen, true);
      assert.equal(useSettingsStore.getState().commandPaletteMode, SEND_TO_AGENT_MODE);
      const pick = pendingAgentPick();
      assert.equal(pick.text, `@${DIR} `);
      assert.deepEqual(pick.targets.map((t) => t.tabId), [b, a], 'the most recently focused first');
      assert.deepEqual(pick.targets.map((t) => t.agent), ['OpenCode', 'Claude Code']);
      const groups = buildPaletteGroups({ mode: SEND_TO_AGENT_MODE, agentTargets: pick.targets, agentText: pick.text });
      assert.deepEqual(groups[0].items.map((i) => [i.type, i.tabId]), [['agent-target', b], ['agent-target', a]]);
      assert.match(groups[0].note, /Enter is not pressed/);
      typed = await writes(async () => {
        const outcome = await sendPendingTo(a);
        assert.equal(outcome.status, 'typed');
      });
      assert.deepEqual(typed, [[sessionOf(a), `@${DIR} `]], 'typed into the one picked');
      assert.equal(S.getState().activeTabId, a, 'and that terminal is shown');
      assert.deepEqual(pendingAgentPick(), { text: null, targets: [] }, 'nothing waits any more');
      useSettingsStore.getState().setCommandPaletteOpen(false);
    });
  });

  test('STA-16: the editor context-menu actions, two palette commands and the Explorer item exist, rebindable, with no default chord', () => {
    for (const [id, title] of [
      ['send-selection-to-agent', SEND_SELECTION_TITLE],
      ['send-file-to-agent', SEND_FILE_TITLE],
    ]) {
      assert.ok(COMMANDS[id], `${id} exists`);
      assert.equal(COMMANDS[id].title, title);
      assert.deepEqual(keysFor(id), [], `${id}: no default chord`);
      assert.equal(menuIdOf(id), null, `${id}: no native menu entry`);
      assert.notEqual(COMMANDS[id].overTerminal, true, `${id}: never claimed from a terminal`);
      const { bindings, problems } = resolveKeybindings({ [id]: 'mod+alt+shift+y' });
      assert.deepEqual(problems, [], `${id}: a user chord is accepted`);
      assert.deepEqual(keysFor(id, bindings), ['mod+alt+shift+y']);
      const calls = [];
      COMMANDS[id].run({ sendSelectionToAgent: () => calls.push('selection'), sendFileToAgent: () => calls.push('file') });
      assert.deepEqual(calls, [id === 'send-selection-to-agent' ? 'selection' : 'file']);
    }
    const ctx = workbenchContext();
    assert.equal(typeof ctx.sendSelectionToAgent, 'function');
    assert.equal(typeof ctx.sendFileToAgent, 'function');

    const items = paletteCommands();
    const selection = items.find((c) => c.id === 'cmd-send-selection-to-agent');
    const file = items.find((c) => c.id === 'cmd-send-file-to-agent');
    assert.equal(selection?.title, SEND_SELECTION_TITLE);
    assert.equal(file?.title, SEND_FILE_TITLE);
    assert.ok(!selection.hint && !file.hint, 'no chord, no hint');
    const { bindings } = resolveKeybindings({ 'send-file-to-agent': 'mod+alt+shift+y' });
    assert.ok(paletteCommands(bindings).find((c) => c.id === 'cmd-send-file-to-agent').hint, 'a bound chord shows as its hint');

    // Monaco's context menu: two actions, no keybinding of their own.
    const added = [];
    addAgentEditorActions({ addAction: (spec) => added.push(spec) }, () => ABS);
    assert.deepEqual(added.map((a) => [a.id, a.label]), [
      [SEND_SELECTION_ACTION_ID, SEND_SELECTION_TITLE],
      [SEND_FILE_ACTION_ID, SEND_FILE_TITLE],
    ]);
    for (const a of added) {
      assert.ok(a.contextMenuGroupId, `${a.id} is in the context menu`);
      assert.equal(a.keybindings, undefined, `${a.id}: no chord`);
    }
    const panel = read('../../src/components/editor/EditorPanel.jsx');
    const mount = panel.slice(panel.indexOf('onMount={(editor) => {'));
    assert.ok(mount.indexOf('addAgentEditorActions(editor, shownPath);') > 0, 'every editor gets them as it mounts');
    assert.ok(mount.indexOf('trackAgentEditor(editor, shownPath);') > 0);

    // The Explorer: files and folders, never the empty area.
    const deps = { label: SEND_TO_AGENT_LABEL, problemOf: () => null, send: () => {} };
    assert.equal(sendToAgentItem({ type: 'file', path: ABS }, deps).label, 'Send to Agent');
    assert.equal(sendToAgentItem({ type: 'folder', path: DIR }, deps).disabled, false);
    assert.equal(sendToAgentItem({ type: 'empty' }, deps), null);
    const sent = [];
    sendToAgentItem({ type: 'folder', path: DIR }, { ...deps, send: (p) => sent.push(p) }).onSelect();
    assert.deepEqual(sent, [DIR]);
    const explorer = read('../../src/components/explorer/FileExplorer.jsx');
    assert.match(explorer, /sendToAgentItem\(target, \{ label: SEND_TO_AGENT_LABEL, problemOf: explorerSendProblem, send: sendPathToAgent \}\)/);

    // The palette runs both commands and the pick, and a greyed-out row does nothing.
    const palette = read('../../src/components/command/CommandPalette.jsx');
    assert.ok(palette.includes("case 'send_selection_to_agent':\n") && palette.includes('await sendSelectionToAgent();'));
    assert.ok(palette.includes("case 'send_file_to_agent':\n") && palette.includes('await sendFileToAgent();'));
    assert.ok(palette.includes('await sendPendingTo(item.tabId);'));
    assert.ok(palette.includes('if (item.disabledReason) return;'));
  });
});

// ---- review, cycle 2: A-R1, A-R2, B-R3 ------------------------------------------

/**
 * Run `fn` with `duringAsk()` called as the store asks the backend who owns
 * the foreground — the last wait before the write — and that answer given
 * at once (same user), so nothing but microtasks runs between it and the
 * check unless the store itself waits for the screen.
 */
async function withForegroundAsk(duringAsk, fn) {
  const original = mockBridge.invoke;
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_foreground_owner') {
      duringAsk();
      return Promise.resolve({ same_user: true });
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    return await fn();
  } finally {
    mockBridge.invoke = original;
  }
}

describe('Send to Agent: the last check reads the terminal as it is (review A-R1, A-R2)', () => {
  test('STA-17: a "Password:" still held by pacing is flushed onto the screen the password-prompt check reads: refused, no pty_write', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      runAgent(tab);
      const text = `@${ABS} `;
      // Held back by the registry's pacing: it reaches xterm only once
      // something flushes it, as the registered `terminalAfterOutput` does.
      const paced = newTerm();
      let held = '\r\nPassword: ';
      const asked = [];
      const unregister = setContextAfterOutputSource((id) => {
        asked.push(id);
        paced.write(held);
        held = '';
        return new Promise((resolve) => paced.write('', () => resolve(paced)));
      });
      try {
        resetToasts();
        let outcome;
        const typed = await writes(async () => {
          outcome = await S.getState().typeAgentReference(tab, text, { terminalOf: () => paced, waitMs: 300 });
        });
        assert.deepEqual(typed, [], 'held by pacing: no pty_write');
        assert.equal(outcome.status, 'refused');
        assert.deepEqual(errors(), ['Not sent: that terminal shows a password prompt']);
        assert.deepEqual(confirms(), []);
        assert.deepEqual(asked, [tab], 'the screen was read after the output so far');

        // The terminal closed while it was read: nothing typed either.
        setContextAfterOutputSource(() => Promise.resolve(null));
        resetToasts();
        const none = await writes(async () => {
          outcome = await S.getState().typeAgentReference(tab, text, { terminalOf: () => newTerm(), waitMs: 300 });
        });
        assert.deepEqual(none, []);
        assert.equal(outcome.status, 'never-shown');
      } finally {
        unregister();
        setContextAfterOutputSource(null);
      }
      // The app's registry is what the store reads through.
      const registry = read('../../src/components/terminal/terminalRegistry.js');
      assert.match(registry, /setContextAfterOutputSource\(\(tabId\) => terminalAfterOutput\(tabId\)\);/);
    });
  });

  test("STA-18: a password prompt still in xterm's write queue — it came while the foreground was asked about — is parsed before the check: refused, no pty_write", async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      runAgent(tab);
      const queued = newTerm();
      resetToasts();
      let outcome;
      const typed = await withForegroundAsk(
        () => queued.write('\r\n[sudo] password for dev: '),
        () =>
          writes(async () => {
            outcome = await S.getState().typeAgentReference(tab, `@${ABS} `, { terminalOf: () => queued, waitMs: 300 });
          })
      );
      assert.deepEqual(typed, [], 'in the write queue: no pty_write');
      assert.equal(outcome.status, 'refused');
      assert.match(outcome.reason, /password prompt/);
    });
  });

  test('STA-19: the agent is asked about again at the last check — one that exits during the wait gets nothing typed', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      runAgent(tab);
      const term = newTerm();
      resetToasts();
      let outcome;
      const typed = await withForegroundAsk(
        () => S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab ? { ...t, agent: null } : t)) })),
        () =>
          writes(async () => {
            outcome = await S.getState().typeAgentReference(tab, `@${ABS} `, { terminalOf: () => term, waitMs: 300 });
          })
      );
      assert.deepEqual(typed, [], 'the agent exited during the wait: no pty_write');
      assert.equal(outcome.status, 'no-agent');
      assert.deepEqual(errors(), ['Not sent: Claude Code or OpenCode no longer runs in that terminal']);
      assert.deepEqual(confirms(), []);
    });
  });

  test('STA-20: the paste is made at the last check — bracketed when the program turned bracketed paste on during the wait', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      runAgent(tab);
      const text = `@${ABS} `;
      const later = newTerm();
      resetToasts();
      let outcome;
      const typed = await withForegroundAsk(
        () => later.write('\x1b[?2004h'),
        () =>
          writes(async () => {
            outcome = await S.getState().typeAgentReference(tab, text, { terminalOf: () => later, waitMs: 300 });
          })
      );
      assert.deepEqual(typed, [[sessionOf(tab), `\x1b[200~${text}\x1b[201~`]], 'bracketed: the program turned it on during the wait');
      assert.equal(outcome.status, 'typed');
      assert.equal(outcome.data, `\x1b[200~${text}\x1b[201~`);
      assert.deepEqual(errors(), []);
    });
  });

  test('STA-23: nothing to type is never reported as typed — an empty reference is refused before any wait, and keys made at the last check that come out empty are refused (Queen check)', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      runAgent(tab);
      const term = newTerm();
      await write(term, '\x1b[?2004h');
      resetToasts();
      let outcome;
      let program;
      const typed = await writes(async () => {
        outcome = await S.getState().typeAgentReference(tab, '', { terminalOf: () => term, waitMs: 300 });
        program = await S.getState().typeForProgram(tab, () => '', { waitMs: 300 });
      });
      assert.deepEqual(typed, [], 'no pty_write, not even an empty bracketed paste');
      assert.equal(outcome.status, 'refused');
      assert.deepEqual(errors(), ['Not sent: there is no reference to type']);
      assert.deepEqual(confirms(), [], 'no confirm toast');
      assert.deepEqual(program, { status: 'refused', reason: 'there was nothing to type' });
      // A string, as every other caller gives it, behaves as before.
      assert.deepEqual(await S.getState().typeForProgram(tab, '', { waitMs: 300 }), { status: 'typed' });
    });
  });
});

describe('Send to Agent: a given editor sends its own file only (review B-R3)', () => {
  const OTHER = '/Users/dev/project/src/other.js';
  const untitled = { getSelection: () => sel(10, 1, 21, 1), getModel: () => ({}) };
  const noModel = { getSelection: () => null, getModel: () => null };

  /** An agent terminal, shown; the active editor tab a saved file, another an untitled buffer. */
  async function editorsAndAgent() {
    const tab = S.getState().activeTabId;
    await prompt(tab);
    runAgent(tab);
    showTerminals(new Map([[tab, newTerm()]]));
    useEditorStore.setState({
      tabs: [
        { id: 'e1', filePath: ABS, fileName: 'auth.js', isDirty: false },
        { id: 'e2', filePath: '', fileName: 'Untitled-1', isDirty: false },
        { id: 'e3', filePath: OTHER, fileName: 'other.js', isDirty: false },
      ],
      activeTabId: 'e1',
    });
    return tab;
  }

  const refusedWith = async (label, fn, reason) => {
    resetToasts();
    const typed = await writes(fn);
    assert.deepEqual(typed, [], `${label}: nothing typed`);
    assert.deepEqual(errors(), [`Not sent: ${reason}`], label);
  };

  test('STA-21: Send Selection from an untitled buffer is "Save the file first", from no model "No file is open" — never the active tab\'s file with this editor\'s lines; its own saved file still goes', async () => {
    await inStore(async () => {
      const tab = await editorsAndAgent();
      await refusedWith('selection, null path', () => sendSelectionToAgent(untitled, null), SAVE_FIRST_REASON);
      await refusedWith('selection, empty path', () => sendSelectionToAgent(untitled, ''), SAVE_FIRST_REASON);
      await refusedWith('selection, no model', () => sendSelectionToAgent(noModel, null), NO_EDITOR_FILE_REASON);
      await refusedWith('a path no editor tab shows', () => sendSelectionToAgent(untitled, '/Users/dev/project/gone.js'), NO_EDITOR_FILE_REASON);
      // Its own saved file, not the active one, with its lines.
      resetToasts();
      const typed = await writes(() => sendSelectionToAgent(untitled, OTHER));
      assert.deepEqual(typed, [[sessionOf(tab), `@${OTHER} (lines 10-20) `]]);
      assert.deepEqual(errors(), []);
    });
  });

  test('STA-22: Send File from a given editor, and both context-menu actions, follow the same rule; with no editor the palette still takes the active tab', async () => {
    await inStore(async () => {
      const tab = await editorsAndAgent();
      await refusedWith('file, null path', () => sendFileToAgent(null, untitled), SAVE_FIRST_REASON);
      await refusedWith('file, empty path', () => sendFileToAgent('', untitled), SAVE_FIRST_REASON);
      await refusedWith('file, no model', () => sendFileToAgent(null, noModel), NO_EDITOR_FILE_REASON);
      // The context-menu actions hand their editor on.
      const added = [];
      addAgentEditorActions({ addAction: (spec) => added.push(spec) }, () => null);
      assert.equal(added.length, 2);
      for (const action of added) await refusedWith(action.id, () => action.run(untitled), SAVE_FIRST_REASON);
      resetToasts();
      let typed = await writes(() => sendFileToAgent(OTHER, untitled));
      assert.deepEqual(typed, [[sessionOf(tab), `@${OTHER} `]]);
      // With no editor, the palette's commands still take the active tab
      // (made active again: a terminal switched to takes it, as in STA-15).
      useEditorStore.setState({ tabs: [{ id: 'e1', filePath: ABS, fileName: 'auth.js', isDirty: false }], activeTabId: 'e1' });
      typed = await writes(() => sendFileToAgent());
      assert.deepEqual(typed, [[sessionOf(tab), `@${ABS} `]]);
      assert.deepEqual(errors(), []);
    });
  });
});
