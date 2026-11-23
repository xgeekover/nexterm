/**
 * A read-only terminal (bundle 4, A3; src/lib/readOnly.js): the user's keys,
 * pastes, IME text and mouse reports never reach its PTY, and neither does
 * anything NexTerm or a program would type there; the terminal's own replies
 * to its program (DA, CPR, DECRQM, focus reports, XTVERSION, XTQMODKEYS, the
 * kitty keyboard query) always do. With read-only off, everything goes as it
 * did before.
 *
 * The gate is real @xterm/headless — the same core as the app's xterm, whose
 * `CoreService.triggerDataEvent` fires `onUserInput` right before `onData`
 * for user input only — wired as getOrCreateTerminal wires it (the source
 * checks at the end hold the registry to that), into the real store on the
 * browser mock, with every pty_write counted.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useToastStore, resetToasts } from '../../src/stores/toastStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import {
  AUTOMATIC,
  READ_ONLY_NEVER_SHOWN,
  READ_ONLY_NOTICE_MS,
  READ_ONLY_RESUME_NOTICE,
  READ_ONLY_UNAVAILABLE,
  TURN_OFF_READ_ONLY,
  TURN_ON_READ_ONLY,
  installInputGate,
  isReadOnly,
  readOnlyItem,
  readOnlyNoticeDue,
  withReadOnly,
  withoutReadOnly,
} from '../../src/lib/readOnly.js';
import { installModifyOtherKeys } from '../../src/lib/modifyOtherKeys.js';
import { installKittyKeyboard } from '../../src/lib/kittyKeyboard.js';
import { installFocusReports } from '../../src/lib/focusReport.js';
import { installXtVersionReply } from '../../src/lib/terminalCompat.js';
import { NEW_LINE, trackInput } from '../../src/lib/suggestionLayer.js';
import { installPasteWarning } from '../../src/lib/pasteWarning.js';
import { installTerminalRightClick } from '../../src/lib/terminalRightClick.js';
import { readOnlyKeyAction } from '../../src/lib/readOnly.js';
import {
  READ_ONLY_LABEL,
  READ_ONLY_STRIP_TEXT,
  READ_ONLY_TURN_OFF,
  TOGGLE_READ_ONLY_TITLE,
  readOnlyInputRefused,
} from '../../src/lib/readOnly.js';
import { COMMANDS, dispatchKeydownOverTerminal, keysFor, menuIdOf, resolveKeybindings } from '../../src/lib/keybindings.js';
import { paletteCommands } from '../../src/lib/paletteItems.js';

const { Terminal } = headless;
const S = terminalStore.useTerminalStore;
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (rel) => lf(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

// ---- the store on the mock, started fresh --------------------------------------

const notices = [];
const backing = new Map();
let unsink = null;
let previousWait = null;
let hadStorage = false;
let previousStorage;

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
  previousWait = terminalStore.__setAgentPromptWaitMs(300);
  notices.length = 0;
  unsink = setTerminalNoticeSink((tabId, message) => {
    notices.push({ tabId, message });
    return true;
  });
  resetToasts();
  useSettingsStore.getState().resetSettings();
  S.getState().forgetInputHidden?.();
  S.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    secretInput: {},
    readOnly: {},
    notifications: [],
  });
  await S.getState().init();
}

function teardown() {
  S.getState().dispose();
  unsink?.();
  unsink = null;
  if (previousWait !== null) terminalStore.__setAgentPromptWaitMs(previousWait);
  previousWait = null;
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

/**
 * A shown terminal for store tab `tabId`, wired as getOrCreateTerminal wires
 * one: the gate first, then the reply addons, the message-mark listener
 * (`noted`), the view's forwarder into the store's writeRaw (`forwarded`,
 * with the options it was given) and the suggestion tracker (`line()`).
 */
function shownTerminal(tabId) {
  const term = new Terminal({ cols: 60, rows: 8, scrollback: 100, allowProposedApi: true });
  const gate = installInputGate(term, {
    readOnly: () => isReadOnly(S.getState(), tabId),
    onBlocked: () => S.getState().noteReadOnlyInput(tabId),
  });
  const detach = terminalStore.attachInputGate(tabId, gate);
  installXtVersionReply(term);
  installModifyOtherKeys(term);
  installKittyKeyboard(term, { enabled: () => true });
  const focus = installFocusReports(term);
  const noted = [];
  term.onData(gate.unlessBlocked((data) => noted.push(data)));
  const forwarded = [];
  term.onData(
    gate.forward((data, options) => {
      forwarded.push([data, options]);
      S.getState().writeRaw(tabId, data, options);
    })
  );
  let tracked = NEW_LINE;
  term.onData((data) => {
    if (gate.blocks(data)) return;
    tracked = trackInput(tracked, data, { running: false }).line;
  });
  return { term, gate, detach, focus, noted, forwarded, line: () => tracked };
}

/** A mouse press as xterm reports it — through its mouse service when it has one, else as xterm's own call does. */
async function mousePress(term) {
  await write(term, '\x1b[?1000h\x1b[?1006h');
  const service = term._core?.coreMouseService;
  if (typeof service?.triggerMouseEvent === 'function') {
    service.triggerMouseEvent({ col: 2, row: 1, button: 0, action: 1, ctrl: false, alt: false, shift: false });
  } else {
    term.input('\x1b[<0;3;2M', true);
  }
}

const DA = '\x1b[?1;2c';
const CPR = /^\x1b\[\d+;\d+R$/;

/** The user's input, then the program's queries, then a focus-out; resolves once all of it has been written. */
async function userThenQueries(shown) {
  const { term, focus } = shown;
  // A key, as `term.input(x, true)` sends one (the kitty keys, ⌥-arrows).
  term.input('ls', true);
  term.input('\r', true);
  // A paste: xterm's Clipboard.ts sends it through triggerDataEvent(text, true).
  term.input('\x1b[200~pasted\x1b[201~', true);
  // A Korean syllable, as hangulInlineIme.js sends it.
  term.input('한', true);
  await mousePress(term);
  // The program asks; the terminal answers.
  await write(term, '\x1b[c');
  await write(term, '\x1b[6n');
  await write(term, '\x1b[?2026$p');
  await write(term, '\x1b[>q');
  await write(term, '\x1b[?4m');
  await write(term, '\x1b[?u');
  // Focus reporting on, told 'in', then the focus-out a hidden terminal sends.
  await write(term, '\x1b[?1004h');
  term.input('\x1b[I', false);
  focus.reportOut({ activeElement: null });
  await sleep(5);
}

describe('Read-only: the state and its words', () => {
  test('RO-01: the map, its notice rate and its menu item', () => {
    const map = withReadOnly({}, 't1', true);
    assert.deepEqual(map, { t1: true });
    assert.equal(withReadOnly(map, 't1', true), map, 'unchanged: the same object');
    assert.deepEqual(withReadOnly(map, 't1', false), {});
    assert.equal(withoutReadOnly(map, ['t2']), map);
    assert.deepEqual(withoutReadOnly(map, ['t1']), {});
    assert.equal(isReadOnly({ readOnly: map }, 't1'), true);
    assert.equal(isReadOnly({ readOnly: map }, 't2'), false);
    assert.equal(isReadOnly(null, 't1'), false);
    assert.equal(readOnlyNoticeDue(undefined, 1000), true);
    assert.equal(readOnlyNoticeDue(1000, 1000 + READ_ONLY_NOTICE_MS - 1), false);
    assert.equal(readOnlyNoticeDue(1000, 1000 + READ_ONLY_NOTICE_MS), true);
    const toggled = [];
    const on = readOnlyItem({ tabId: 't1', readOnly: false, shown: true, toggle: (id) => toggled.push(id) });
    assert.equal(on.label, TURN_ON_READ_ONLY);
    assert.equal(on.disabled, undefined);
    on.onSelect();
    assert.deepEqual(toggled, ['t1']);
    assert.equal(readOnlyItem({ tabId: 't1', readOnly: true }).label, TURN_OFF_READ_ONLY);
    const never = readOnlyItem({ tabId: 't1', readOnly: false, shown: false });
    assert.equal(never.disabled, true);
    assert.match(never.disabledReason, /not been shown/);
    assert.equal(readOnlyItem({ tabId: 't1', readOnly: true, shown: false }).disabled, undefined, 'turning it off is never refused');
  });
});

describe('Read-only: the gate (AC8)', () => {
  test("RO-02: while read-only a key, a paste, an IME syllable and a mouse report write nothing; DA, CPR, DECRQM, XTVERSION, XTQMODKEYS, the kitty query and a focus-out are written", async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const shown = shownTerminal(tab);
      assert.equal(shown.gate.available, true, 'headless xterm gives the user-input signal');
      assert.equal(S.getState().setReadOnly(tab, true), true);
      assert.equal(isReadOnly(S.getState(), tab), true);
      const commandLineBefore = tabById(tab).commandLine ?? null;
      const typed = await writes(() => userThenQueries(shown));
      const data = typed.map(([, d]) => d);
      assert.ok(typed.every(([session]) => session === sessionOf(tab)));
      for (const blocked of ['ls', '\r', '\x1b[200~pasted\x1b[201~', '한']) {
        assert.ok(!data.includes(blocked), `${JSON.stringify(blocked)} reached the PTY`);
      }
      assert.ok(!data.some((d) => d.startsWith('\x1b[<0;')), `a mouse report reached the PTY: ${JSON.stringify(data)}`);
      assert.equal(data[0], DA, `DA first: ${JSON.stringify(data)}`);
      assert.match(data[1], CPR);
      assert.equal(data[2], '\x1b[?2026;2$y', 'DECRQM');
      assert.match(data[3], /^\x1bP>\|xterm\.js\(/, 'XTVERSION');
      assert.match(data[4], /^\x1b\[>4;\d+m$/, 'XTQMODKEYS');
      assert.equal(data[5], '\x1b[?0u', 'the kitty query');
      assert.deepEqual(data.slice(6), ['\x1b[I', '\x1b[O'], 'the focus reports');
      // Every reply went marked as one; nothing of the user's was handed on.
      assert.ok(shown.forwarded.every(([, options]) => options === AUTOMATIC));
      // Nothing dropped was seen: no message mark, no command line, no suggestion line.
      assert.ok(!shown.noted.some((d) => ['ls', '\r', '한'].includes(d)), 'noteMessageInput heard a dropped chunk');
      assert.equal(tabById(tab).commandLine ?? null, commandLineBefore, 'the store followed a dropped line');
      assert.equal(shown.line().buffer, NEW_LINE.buffer, 'the suggestion line followed a dropped key');
      // Said once, as an error that names how to turn it off.
      const said = toasts().filter((t) => /read-only/.test(t.text));
      assert.equal(said.length, 1, JSON.stringify(toasts()));
      assert.equal(said[0].kind, 'error');
      assert.match(said[0].text, /Turn Off/);
      shown.gate.dispose();
      shown.detach();
    });
  });

  test('RO-03: read-only off, the same input and replies all go, in order, exactly as before', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const shown = shownTerminal(tab);
      const typed = await writes(() => userThenQueries(shown));
      const data = typed.map(([, d]) => d);
      assert.deepEqual(data.slice(0, 4), ['ls', '\r', '\x1b[200~pasted\x1b[201~', '한']);
      assert.ok(data[4].startsWith('\x1b[<0;'), `the mouse report: ${JSON.stringify(data)}`);
      assert.equal(data[5], DA);
      assert.match(data[6], CPR);
      assert.equal(data.length, 13, JSON.stringify(data));
      // The user's chunks went without options, as the forwarder always sent them.
      assert.deepEqual(shown.forwarded.slice(0, 4).map(([, options]) => options), [undefined, undefined, undefined, undefined]);
      assert.equal(tabById(tab).commandLine, 'ls', 'the line typed is followed as before');
      assert.deepEqual(toasts(), []);
      shown.gate.dispose();
      shown.detach();
    });
  });

  test('RO-04: a gate bug never drops a reply while read-only is off — a chunk it did not see, a read that throws', async () => {
    const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
    const seen = [];
    // A listener ahead of the gate: it asks about chunks the gate has not classified yet.
    term.onData((data) => seen.push(['early', data, gateRef.blocks(data)]));
    let on = false;
    const gateRef = installInputGate(term, { readOnly: () => on });
    await write(term, '\x1b[c');
    assert.deepEqual(seen, [['early', DA, false]], 'read-only off: never blocked');
    on = true;
    await write(term, '\x1b[c');
    assert.equal(seen[1][2], true, 'read-only on: an unseen chunk is dropped (fail closed)');
    const throwing = installInputGate(new Terminal({ allowProposedApi: true }), {
      readOnly: () => {
        throw new Error('boom');
      },
    });
    assert.equal(throwing.blocks('x'), true, 'a read that throws counts as read-only');
    gateRef.dispose();
    throwing.dispose();
    term.dispose();
  });
});

describe('Read-only: fail closed (AC9)', () => {
  test('RO-05: a terminal without the user-input signal cannot be made read-only — an error toast, and it stays writable', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      const fake = { onData: () => ({ dispose() {} }) };
      const gate = installInputGate(fake);
      assert.equal(gate.available, false);
      const detach = terminalStore.attachInputGate(tab, gate);
      assert.equal(S.getState().setReadOnly(tab, true), false);
      assert.equal(isReadOnly(S.getState(), tab), false);
      assert.deepEqual(toasts().map((t) => [t.kind, t.text]), [['error', READ_ONLY_UNAVAILABLE]]);
      // Not even with a _core whose event throws when listened to.
      const throwing = installInputGate({
        onData: () => ({ dispose() {} }),
        _core: { coreService: { onUserInput: () => { throw new Error('private API moved'); } } },
      });
      assert.equal(throwing.available, false);
      detach();
      // And a terminal never shown has no gate at all.
      resetToasts();
      assert.equal(S.getState().toggleReadOnly(tab), false);
      assert.equal(isReadOnly(S.getState(), tab), false);
      assert.deepEqual(toasts().map((t) => t.text), [READ_ONLY_NEVER_SHOWN]);
      // Turning it off is never refused.
      assert.equal(S.getState().setReadOnly(tab, false), true);
    });
  });
});

describe('Read-only: programmatic typing refused (AC10)', () => {
  test('RO-06: writeRaw refuses all but a reply; typeForProgram answers read-only before any wait', async () => {
    await inStore(async () => {
      terminalStore.__setAgentPromptWaitMs(5000);
      const tab = S.getState().activeTabId;
      const shown = shownTerminal(tab);
      S.getState().setReadOnly(tab, true);
      let outcome;
      const typed = await writes(async () => {
        await S.getState().writeRaw(tab, 'rm -rf x\r');
        await S.getState().writeRaw(tab, '\x1b[?1;2c', AUTOMATIC);
        const started = Date.now();
        // No prompt drawn yet: typeForProgram would wait for one up to 5 s.
        outcome = await S.getState().typeForProgram(tab, 'echo hi\r');
        assert.ok(Date.now() - started < 200, 'answered without waiting');
      });
      assert.deepEqual(outcome, { status: 'read-only' });
      assert.deepEqual(typed, [[sessionOf(tab), '\x1b[?1;2c']]);
      // Off again: writable again.
      S.getState().setReadOnly(tab, false);
      await prompt(tab);
      const after = await writes(() => S.getState().writeRaw(tab, 'x'));
      assert.deepEqual(after, [[sessionOf(tab), 'x']]);
      shown.detach();
    });
  });

  test('RO-07: a project command, a startup command and an agent launch into a read-only terminal are not typed, and the terminal says why', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const shown = shownTerminal(tab);
      S.getState().setReadOnly(tab, true);
      let project;
      let startup;
      let agent;
      const typed = await writes(async () => {
        project = await S.getState().typeProjectCommand(tab, 'npm test');
        startup = await S.getState().typeStartupCommand(tab, 'make');
        agent = await S.getState().startAgent(tab, 'claude');
      });
      assert.deepEqual(typed, []);
      assert.equal(project, false);
      assert.equal(startup, false);
      assert.equal(agent, null);
      const said = notices.filter((n) => n.tabId === tab).map((n) => n.message);
      assert.ok(said.some((m) => /^project command not typed — this terminal is read-only: npm test$/.test(m)), JSON.stringify(said));
      assert.ok(said.some((m) => /^startup command not typed — this terminal is read-only: make$/.test(m)), JSON.stringify(said));
      assert.ok(said.some((m) => /^Claude Code not started — this terminal is read-only/.test(m)), JSON.stringify(said));
      assert.equal(tabById(tab).agent ?? null, null, 'no agent recorded');
      assert.match(S.getState().projectCommandBlock(tab), /read-only/, 'the run dialog says so too');
      shown.detach();
    });
  });

  // Resume (review B-R5): refused before the conversation lookup, and again
  // right before the write — each time the offer comes back and the
  // terminal says why; writeRaw is never reached.
  const CLAUDE_ID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
  const offerClaude = (tab) => {
    const agent = { kind: 'claude', sessionId: CLAUDE_ID, startedAt: 1, title: null };
    S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab ? { ...t, agent, agentResumeOffered: true } : t)) }));
    return agent;
  };

  test('RO-19: a resume offered in a read-only terminal is not typed — no pty_write, the offer given back as it was, the terminal says why', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const shown = shownTerminal(tab);
      const agent = offerClaude(tab);
      S.getState().setReadOnly(tab, true);
      resetToasts();
      let resumed;
      const asked = [];
      const typed = await writes(async () => {
        const inner = mockBridge.invoke;
        mockBridge.invoke = function (command, args, ...rest) {
          asked.push(command);
          return inner.call(this, command, args, ...rest);
        };
        try {
          resumed = await S.getState().resumeAgent(tab);
        } finally {
          mockBridge.invoke = inner;
        }
      });
      assert.equal(resumed, false);
      assert.deepEqual(typed, [], 'nothing written');
      assert.equal(asked.includes('claude_conversations'), false, 'refused before the conversation lookup');
      const now = tabById(tab);
      assert.equal(now.agentResumeOffered, true, 'the offer is given back');
      assert.deepEqual(now.agent, agent, 'with the record it had');
      assert.equal(READ_ONLY_RESUME_NOTICE, 'Not resumed — this terminal is read-only. Turn read-only off, then resume.');
      assert.deepEqual(notices.filter((n) => n.tabId === tab).map((n) => n.message), [READ_ONLY_RESUME_NOTICE]);
      assert.deepEqual(toasts().filter((t) => t.kind === 'error'), [], 'refused before writeRaw, which would toast');
      shown.detach();
    });
  });

  test('RO-20: read-only turned on while the conversation is looked up — checked again right before the write: nothing typed, the offer back, the same notice', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      await prompt(tab);
      const shown = shownTerminal(tab);
      const agent = offerClaude(tab);
      resetToasts();
      let resumed;
      let lookedUp = false;
      const typed = await writes(async () => {
        const inner = mockBridge.invoke;
        mockBridge.invoke = function (command, args, ...rest) {
          if (command === 'claude_conversations') {
            lookedUp = true;
            S.getState().setReadOnly(tab, true);
          }
          return inner.call(this, command, args, ...rest);
        };
        try {
          resumed = await S.getState().resumeAgent(tab);
        } finally {
          mockBridge.invoke = inner;
        }
      });
      assert.ok(lookedUp, 'premise: past the first check, into the lookup');
      assert.equal(resumed, false);
      assert.deepEqual(typed, [], 'nothing written');
      const now = tabById(tab);
      assert.equal(now.agentResumeOffered, true, 'the offer is given back');
      assert.deepEqual(now.agent, agent, 'with the record it had');
      assert.deepEqual(notices.filter((n) => n.tabId === tab).map((n) => n.message), [READ_ONLY_RESUME_NOTICE]);
      assert.deepEqual(toasts().filter((t) => t.kind === 'error'), [], 'refused before writeRaw, which would toast');
      // Off again, the offer resumes as before.
      S.getState().setReadOnly(tab, false);
      const again = await writes(() => S.getState().resumeAgent(tab));
      assert.deepEqual(again, [[sessionOf(tab), `claude --resume ${CLAUDE_ID}\r`]]);
      shown.detach();
    });
  });
});

describe('Read-only: feedback, persistence and closing (AC11, store side)', () => {
  test('RO-08: a blocked input says so at most once every 3 s per terminal', async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      const b = (await S.getState().createTab()).id;
      assert.equal(S.getState().noteReadOnlyInput(a, 10_000), true);
      assert.equal(S.getState().noteReadOnlyInput(a, 11_000), false);
      assert.equal(S.getState().noteReadOnlyInput(b, 11_000), true, 'another terminal has its own allowance');
      assert.equal(S.getState().noteReadOnlyInput(a, 10_000 + READ_ONLY_NOTICE_MS), true);
      // The same words again replace the toast up: never two of one terminal's.
      assert.equal(toasts().filter((t) => t.text === toasts()[toasts().length - 1].text).length, 1);
    });
  });

  test('RO-09: read-only is never saved, and goes with its terminal', async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      const b = (await S.getState().createTab()).id;
      const shownA = shownTerminal(a);
      const shownB = shownTerminal(b);
      S.getState().setReadOnly(a, true);
      S.getState().setReadOnly(b, true);
      S.getState().renameTab(a, 'Watched');
      await sleep(400);
      const saved = backing.get(terminalStore.PERSIST_KEY);
      assert.ok(saved && saved.includes('Watched'), 'setup: the layout was written');
      assert.equal(/readOnly|read-only/i.test(saved), false, 'the payload has no read-only in it');
      await S.getState().closeTab(b);
      assert.deepEqual(S.getState().readOnly, { [a]: true }, 'a closed terminal takes its read-only along');
      shownA.detach();
      shownB.detach();
    });
  });
});

describe('Read-only: refused where the user acts, with feedback (AC8, early refusals)', () => {
  /** A container that keeps its listeners, for the paste and right-click bindings. */
  const container = () => {
    const listeners = [];
    return { listeners, addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }), removeEventListener() {}, ownerDocument: { activeElement: null } };
  };

  test('RO-11: a paste into a read-only terminal is refused before any question — kept from xterm, never asked about — and goes as before when off', () => {
    const term = new Terminal({ allowProposedApi: true });
    const box = container();
    let refused = true;
    let refusals = 0;
    const asked = [];
    const addon = installPasteWarning(term, box, {
      settings: { getState: () => ({ terminalMultiLinePasteWarning: 'always' }) },
      ask: (question) => {
        asked.push(question);
        return new Promise(() => {});
      },
      refuse: () => {
        if (refused) refusals += 1;
        return refused;
      },
    });
    const onPaste = box.listeners.find((l) => l.type === 'paste' && l.capture === true)?.fn;
    assert.ok(onPaste, 'a capture listener for paste');
    const paste = (text) => {
      const event = { clipboardData: { getData: () => text }, prevented: false, stopped: false };
      event.preventDefault = () => (event.prevented = true);
      event.stopImmediatePropagation = () => (event.stopped = true);
      onPaste(event);
      return event;
    };
    for (const text of ['one line', 'two\nlines', '']) {
      const event = paste(text);
      assert.equal(event.prevented && event.stopped, true, `${JSON.stringify(text)}: kept from xterm and the webview`);
    }
    assert.equal(refusals, 3);
    assert.deepEqual(asked, [], 'no question about a paste that would be dropped');
    assert.equal(addon.hold('a\nb'), true, "the right-click's hold is taken, and pastes nothing");
    assert.deepEqual(asked, []);
    refused = false;
    const event = paste('two\nlines');
    assert.equal(asked.length, 1, 'off: asked as before');
    assert.equal(event.prevented, true);
    assert.equal(paste('one line').prevented, false, 'off: one line goes to xterm as it came');
    addon.dispose();
    term.dispose();
  });

  test('RO-12: a right-click paste into a read-only terminal reads nothing and pastes nothing', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const box = container();
    let reads = 0;
    let refused = true;
    const addon = installTerminalRightClick(term, box, {
      read: async () => {
        reads += 1;
        return { text: 'x', image: false };
      },
      refuse: () => refused,
    });
    addon._paste();
    await addon.pasting;
    assert.equal(reads, 0, 'the clipboard is not read');
    refused = false;
    addon._paste();
    await addon.pasting;
    assert.equal(reads, 1, 'off: read as before');
    addon.dispose();
    term.dispose();
  });

  test('RO-13: the keys — scrolling, ⌘A and an IME composition go to xterm; a modifier and a ⌘ chord are left alone; every other key is cancelled', () => {
    const k = (key, extra = {}) => ({ type: 'keydown', key, code: '', keyCode: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
    assert.equal(readOnlyKeyAction(k('PageUp', { shiftKey: true })), 'xterm');
    assert.equal(readOnlyKeyAction(k('PageDown', { shiftKey: true })), 'xterm');
    assert.equal(readOnlyKeyAction(k('PageUp')), 'cancel', 'PageUp alone is a key for the program');
    assert.equal(readOnlyKeyAction(k('PageUp', { shiftKey: true, ctrlKey: true })), 'cancel');
    assert.equal(readOnlyKeyAction(k('a', { metaKey: true, code: 'KeyA' }), { mac: true }), 'xterm');
    assert.equal(readOnlyKeyAction(k('Process', { keyCode: 229 })), 'xterm');
    assert.equal(readOnlyKeyAction(k('ㅎ', { isComposing: true })), 'xterm');
    for (const mod of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) assert.equal(readOnlyKeyAction(k(mod)), 'ignore', mod);
    assert.equal(readOnlyKeyAction(k('v', { metaKey: true }), { mac: true }), 'ignore', '⌘V: its paste is refused where it lands');
    assert.equal(readOnlyKeyAction(k('v', { metaKey: true }), { mac: false }), 'cancel', 'off macOS Meta is not ⌘');
    for (const key of ['a', 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'F5', ' ']) assert.equal(readOnlyKeyAction(k(key)), 'cancel', key);
    assert.equal(readOnlyKeyAction(k('c', { ctrlKey: true })), 'cancel', 'Ctrl+C (no selection: handleClipboardKey let it go)');
    assert.equal(readOnlyKeyAction(null), 'cancel', 'nothing to read: cancelled');
  });
});

describe('Read-only: the store decides the view\'s keys', () => {
  test('RO-14: readOnlyKey is null while writable; read-only, a cancelled keydown is said once per 3 s, keyup says nothing', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      const k = (type, key) => ({ type, key, code: '', keyCode: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
      assert.equal(S.getState().readOnlyKey(tab, k('keydown', 'a')), null, 'writable: as it always went');
      const shown = shownTerminal(tab);
      S.getState().setReadOnly(tab, true);
      assert.equal(S.getState().readOnlyKey(tab, k('keydown', 'a')), 'cancel');
      assert.equal(S.getState().readOnlyKey(tab, k('keyup', 'a')), 'cancel');
      assert.equal(S.getState().readOnlyKey(tab, k('keydown', 'b')), 'cancel');
      assert.equal(toasts().length, 1, 'said once');
      shown.detach();
    });
  });
});

describe('Read-only: the app is wired as these cases are', () => {
  test('RO-10: the registry installs the gate before every listener and addon, and every onData listener asks it', () => {
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    const gateAt = create.indexOf('const inputGate = installInputGate(term, {');
    assert.ok(gateAt > create.indexOf('const term = new Terminal({'), 'after the terminal is made');
    const firstOnData = create.indexOf('term.onData(');
    const firstAddon = create.indexOf('term.loadAddon(');
    assert.ok(gateAt < firstOnData && gateAt < firstAddon, 'ahead of every onData listener and addon');
    assert.match(create, /readOnly: \(\) => isReadOnly\(useTerminalStore\.getState\(\), tabId\),/);
    assert.match(create, /const detachInputGate = attachInputGate\(tabId, inputGate\);/);
    assert.match(create, /const messageInput = term\.onData\(inputGate\.unlessBlocked\(\(data\) => noteMessageInput\(tabId, data\)\)\);/);
    assert.match(create, /const dataDisposable = onData \? term\.onData\(inputGate\.forward\(onData\)\) : null;/);
    const dispose = registry.slice(registry.indexOf('export function disposeTerminal('));
    assert.ok(dispose.indexOf('entry.inputGate?.dispose();') > 0 && dispose.indexOf('entry.detachInputGate?.();') > 0);
    const paste = registry.slice(registry.indexOf('export function pasteIntoTerminal('));
    assert.match(paste.slice(0, 600), /if \(isReadOnly\(useTerminalStore\.getState\(\), tabId\)\) \{/);
    const view = read('../../src/components/terminal/TerminalView.jsx');
    assert.match(view, /onData: \(data, options\) => writeRaw\(tabId, data, options\),/);
    assert.match(view, /if \(entry\.inputGate\?\.blocks\(data\)\) return;\s*bufferHandler\(data\);/);
    // Paste, right-click and the palette's history refuse early; drops are TF-49's.
    assert.match(create, /installTerminalRightClick\(term, container, \{\s*settings: useSettingsStore,\s*refuse: refusePaste,/);
    assert.match(create, /installPasteWarning\(term, container, \{\s*settings: useSettingsStore,[^}]*refuse: refusePaste,/);
    const keys = view.slice(view.indexOf('const handleKeyEvent = (event) => {'));
    assert.ok(keys.indexOf("const readOnlyKey = useTerminalStore.getState().readOnlyKey?.(tabId, event, { mac: isMac }) ?? null;") > keys.indexOf('if (clipboard !== undefined) return clipboard;'), 'after the clipboard keys');
    assert.ok(keys.indexOf('readOnlyKey') < keys.indexOf('const decision = suggestionKeyAction('), 'before the suggestion layer and every key sent');
    const palette = read('../../src/components/command/CommandPalette.jsx');
    const history = palette.slice(palette.indexOf("if (item.type === 'history') {"), palette.indexOf("if (item.type === 'file') {"));
    assert.ok(history.indexOf('isReadOnly(useTerminalStore.getState(), tabId)') > 0, 'the history row asks first');
    assert.ok(history.indexOf('isReadOnly(') < history.indexOf('writeRaw(tabId, item.command);'));
    const dispatcher = read('../../src/lib/controlDispatcher.js');
    assert.match(dispatcher, /case 'read-only':\s*return fail\(REFUSED, READ_ONLY_SEND_REFUSED\);/);
  });
});

describe('Read-only: where it is turned on and off (AC11, UI side)', () => {
  // A keydown as the window's capture listener hands it over, `mod` being ⌘
  // on macOS and Ctrl elsewhere.
  const keydown = (platform, key, { shift = false, alt = false } = {}, calls = null) => ({
    type: 'keydown',
    key,
    code: `Key${key.toUpperCase()}`,
    metaKey: platform === 'macos',
    ctrlKey: platform !== 'macos',
    shiftKey: shift,
    altKey: alt,
    preventDefault: () => calls?.push('preventDefault'),
    stopPropagation: () => calls?.push('stopPropagation'),
  });
  const ctxFor = (e, platform, extra = {}) => ({
    isMod: platform === 'macos' ? e.metaKey : e.ctrlKey,
    isInTerminal: true,
    isInMonacoEditor: false,
    isCommandPaletteOpen: false,
    ...extra,
  });

  test('RO-15: Terminal: Toggle Read-Only is a rebindable command with no chord, claimed over a terminal — a chord the user gives it turns read-only off from inside the read-only terminal', async () => {
    const spec = COMMANDS['toggle-read-only'];
    assert.ok(spec, 'the command exists');
    assert.equal(spec.title, TOGGLE_READ_ONLY_TITLE);
    assert.equal(TOGGLE_READ_ONLY_TITLE, 'Terminal: Toggle Read-Only');
    assert.deepEqual(keysFor('toggle-read-only'), [], 'no default chord: nothing is taken from the shell as shipped');
    assert.equal(menuIdOf('toggle-read-only'), null, 'no native menu entry');
    assert.equal(spec.overTerminal, true);
    const { bindings, problems } = resolveKeybindings({ 'toggle-read-only': 'mod+alt+r' });
    assert.deepEqual(problems, [], 'a user chord is accepted');
    assert.deepEqual(keysFor('toggle-read-only', bindings), ['mod+alt+r']);
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      const shown = shownTerminal(tab);
      const toggleReadOnly = () => S.getState().toggleReadOnly();
      for (const platform of ['macos', 'windows']) {
        S.getState().setReadOnly(tab, true);
        assert.equal(isReadOnly(S.getState(), tab), true, 'setup: read-only');
        // As shipped the chord is nobody's: it goes to the terminal, which
        // drops it there (readOnlyKey), and read-only stays on.
        const unbound = keydown(platform, 'r', { alt: true });
        assert.equal(dispatchKeydownOverTerminal(unbound, ctxFor(unbound, platform, { toggleReadOnly })), null, `${platform}: no default chord is claimed`);
        assert.equal(isReadOnly(S.getState(), tab), true);
        // Bound, it is claimed ahead of xterm and turns read-only off.
        const calls = [];
        const e = keydown(platform, 'r', { alt: true }, calls);
        const fired = dispatchKeydownOverTerminal(e, ctxFor(e, platform, { bindings, toggleReadOnly }));
        assert.equal(fired, 'toggle-read-only', `${platform}: the bound chord runs over the read-only terminal`);
        assert.deepEqual(calls, ['preventDefault', 'stopPropagation'], `${platform}: xterm never sees it`);
        assert.equal(isReadOnly(S.getState(), tab), false, `${platform}: read-only is off`);
        // And on again: a toggle.
        const again = keydown(platform, 'r', { alt: true });
        assert.equal(dispatchKeydownOverTerminal(again, ctxFor(again, platform, { bindings, toggleReadOnly })), 'toggle-read-only');
        assert.equal(isReadOnly(S.getState(), tab), true, `${platform}: on again`);
        S.getState().setReadOnly(tab, false);
      }
      shown.detach();
    });
  });

  test('RO-16: an app shortcut dispatched by dispatchKeydownOverTerminal still runs while the terminal is read-only — the app asks nothing of read-only before xterm', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      const shown = shownTerminal(tab);
      S.getState().setReadOnly(tab, true);
      assert.equal(isReadOnly(S.getState(), tab), true, 'setup: read-only');
      for (const platform of ['macos', 'windows']) {
        // Go to Latest Unread Notification: ⌘⇧U / Ctrl+Shift+U by default.
        const ran = [];
        const e = keydown(platform, 'U', { shift: true });
        const fired = dispatchKeydownOverTerminal(e, ctxFor(e, platform, { goToLatestUnread: () => ran.push('unread') }));
        assert.equal(fired, 'go-to-unread-notification', `${platform}: the default chord is claimed over the read-only terminal`);
        assert.deepEqual(ran, ['unread'], `${platform}: and it ran`);
        // A user chord on another command, the same.
        const { bindings } = resolveKeybindings({ 'equalize-splits': 'mod+alt+e' });
        const eq = [];
        const k = keydown(platform, 'e', { alt: true });
        assert.equal(dispatchKeydownOverTerminal(k, ctxFor(k, platform, { bindings, equalizeSplits: () => eq.push(1) })), 'equalize-splits');
        assert.deepEqual(eq, [1]);
      }
      assert.equal(isReadOnly(S.getState(), tab), true, 'read-only is still on: the shortcuts did not touch it');
      shown.detach();
    });
    // The capture-phase dispatch and the keybinding table never consult
    // read-only: only TerminalView's key handler does, after the app's turn.
    const table = read('../../src/lib/keybindings.js');
    const dispatch = table.slice(table.indexOf('export function dispatchKeydownOverTerminal('), table.indexOf('export function menuIdOf('));
    assert.ok(dispatch.length > 0 && !/readOnly|isReadOnly/.test(dispatch), 'dispatchKeydownOverTerminal asks nothing of read-only');
    assert.equal(/readOnly|isReadOnly/.test(read('../../src/hooks/useKeybindings.js')), false, 'the capture listener asks nothing of read-only');
  });

  test('RO-17: the Command Palette lists Terminal: Toggle Read-Only (no hint until a chord is bound) and runs the store toggle on the active terminal', async () => {
    const item = paletteCommands().find((c) => c.id === 'cmd-terminal-toggle-read-only');
    assert.ok(item, 'listed');
    assert.equal(item.title, TOGGLE_READ_ONLY_TITLE);
    assert.equal(item.command, 'terminal_toggle_read_only');
    assert.ok(!item.hint, 'no chord, no hint');
    const { bindings } = resolveKeybindings({ 'toggle-read-only': 'mod+alt+r' });
    assert.ok(paletteCommands(bindings).find((c) => c.id === 'cmd-terminal-toggle-read-only').hint, 'a bound chord shows as its hint');
    const palette = read('../../src/components/command/CommandPalette.jsx');
    const run = palette.slice(palette.indexOf("case 'terminal_toggle_read_only':"));
    assert.ok(run.length > 0 && run.indexOf('useTerminalStore.getState().toggleReadOnly?.();') > 0 && run.indexOf('useTerminalStore.getState().toggleReadOnly?.();') < run.indexOf('return;'), 'the palette runs the store toggle');
    const workbench = read('../../src/lib/workbenchCommands.js');
    assert.match(workbench, /toggleReadOnly: \(\) => useTerminalStore\.getState\(\)\.toggleReadOnly\?\.\(\),/, 'a bound chord runs the same toggle');
    // The store toggle, with no tab named, is the active terminal's.
    await inStore(async () => {
      const a = S.getState().activeTabId;
      const shown = shownTerminal(a);
      assert.equal(S.getState().toggleReadOnly(), true);
      assert.equal(isReadOnly(S.getState(), a), true);
      assert.equal(S.getState().toggleReadOnly(), false);
      assert.equal(isReadOnly(S.getState(), a), false);
      shown.detach();
    });
  });

  test('RO-18: the tab chip menu and the TERMINALS row menu carry Turn On / Turn Off Read-Only; the refusal toast names exactly the places that exist', () => {
    const container = read('../../src/components/terminal/TerminalSplitContainer.jsx');
    const chipMenu = container.slice(container.indexOf("key: 'rename',"), container.indexOf("key: 'close-tab',"));
    assert.match(chipMenu, /readOnlyItem\(\{\s*tabId: chipMenu\.tabId,\s*readOnly: readOnlyOf\(chipMenu\.tabId\),\s*shown: contextTerminalOf\(chipMenu\.tabId\) !== null,\s*toggle: \(id\) => useTerminalStore\.getState\(\)\.toggleReadOnly\(id\),/, 'the chip menu');
    const panel = read('../../src/components/terminal/TerminalsPanel.jsx');
    const rowMenu = panel.slice(panel.indexOf('const tabItems = ('), panel.indexOf("key: 'move-group',"));
    assert.match(rowMenu, /readOnlyItem\(\{\s*tabId: tab\.id,\s*readOnly: Boolean\(readOnlyTabs\?\.\[tab\.id\]\),\s*shown: contextTerminalOf\(tab\.id\) !== null,\s*toggle: \(id\) => useTerminalStore\.getState\(\)\.toggleReadOnly\(id\),/, 'the row menu');
    // The badge and the strip are drawn where the render suite looks (RN-240).
    assert.ok(container.indexOf('<ReadOnlyBadge tabId={tab.id} />') > container.indexOf('<LockBadge tabId={tab.id} />'), 'the chip badge, beside the lock');
    assert.ok(container.indexOf('<ReadOnlyStrip tabId={boundTab.id} />') < container.indexOf('<TerminalView tabId={boundTab.id} active={isActivePane} />'), 'the strip, above the terminal');
    // What the toasts tell the user to use is what the UI calls it.
    const refused = readOnlyInputRefused('Build');
    for (const words of [`Turn Off in the pane`, 'its tab menu', 'its TERMINALS row', `Command Palette (${TOGGLE_READ_ONLY_TITLE})`]) {
      assert.ok(refused.includes(words), `the toast names ${words}: ${refused}`);
    }
    assert.equal(READ_ONLY_TURN_OFF, 'Turn Off', "the strip's button is the toast's Turn Off");
    assert.ok(READ_ONLY_STRIP_TEXT.startsWith('Read-only') && READ_ONLY_LABEL.startsWith('Read-only'));
  });
});
