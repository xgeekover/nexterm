/**
 * Next/Previous Tab, Go to Tab 1-8 and Go to Last Tab (Bundle 2, A5-1 and
 * A5-2; AC1 and AC2's TN-07).
 *
 * The keys go through `dispatchKeydownOverTerminal` — the capture-phase
 * listener a focused terminal's keys reach first — with the context
 * useKeybindings builds (`workbenchContext`), over the app's real terminal
 * store arranged with one group:
 *
 *   [ pane-a (a1, a2, a3) | pane-b (b1) ]   terminals
 *   [ pane-e (e1)                        ]   a file pane
 *
 * A fake page stands for the DOM, so where the keyboard lands is read off
 * `document.activeElement`: an xterm textarea per terminal pane.
 *
 * The events are built field by field, as a browser reports the keys, not
 * from the chords: the matcher stays free to be wrong about them.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import {
  COMMANDS,
  DEFAULT_RESOLVED,
  commandsOverTerminal,
  configurableCommands,
  dispatchKeydown,
  dispatchKeydownOverTerminal,
  findBinding,
  findConflicts,
  keysFor,
  resolveKeybindings,
  shortcutLabel,
} from '../../src/lib/keybindings.js';
import { workbenchContext } from '../../src/lib/workbenchCommands.js';
import { paneTabs, tabTarget } from '../../src/lib/tabNavigation.js';

const T = useTerminalStore;

const NEW_COMMANDS = [
  'next-tab',
  'previous-tab',
  'go-to-tab-1',
  'go-to-tab-2',
  'go-to-tab-3',
  'go-to-tab-4',
  'go-to-tab-5',
  'go-to-tab-6',
  'go-to-tab-7',
  'go-to-tab-8',
  'go-to-last-tab',
];

const PLATFORMS = ['macos', 'windows', 'linux'];

const termTab = (id) => ({ id, title: `shell ${id}`, cwd: '/workspace', sessionId: `s-${id}` });
const terminalLeaf = (id, tabIds, activeTabId = tabIds[0]) => ({ type: 'leaf', id, tabIds, activeTabId });
const editorLeaf = (id, tabIds) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId: tabIds[0] ?? null });

/** One group: pane-a holds `aTabs`, pane-b holds b1, pane-e is a file pane. */
function arrange({ aTabs = ['a1', 'a2', 'a3'], kind = 'terminal' } = {}) {
  if (saved) T.setState(saved, true);
  T.setState({
    tabs: [...aTabs, 'b1'].map(termTab),
    activeTabId: aTabs[0],
    activeGroupId: 'group-1',
    notifications: [],
    groups: [
      {
        id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-a', editorPaneId: 'pane-e',
        ...(kind === 'editor' ? { activeKind: 'editor' } : {}),
        tree: {
          type: 'split', id: 'split-root', direction: 'vertical', sizes: [70, 30],
          children: [
            { type: 'split', id: 'split-t', direction: 'horizontal', sizes: [50, 50], children: [terminalLeaf('pane-a', aTabs), terminalLeaf('pane-b', ['b1'])] },
            editorLeaf('pane-e', ['e1']),
          ],
        },
      },
    ],
  });
}

const leaf = (id) => {
  const walk = (node) => {
    if (node?.type === 'leaf') return node.id === id ? node : null;
    for (const child of node?.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(T.getState().groups[0].tree);
};
const active = () => T.getState().activeTabId;

// --- the fake page ----------------------------------------------------------
// The store and the page as the suite found them, taken once: a case that
// fails skips afterEach, and must not become what the next one restores.
let original = null;
let saved = null;
let page = null;
function fakePage() {
  const body = { tagName: 'BODY', closest: () => null, focus() {}, blur() {} };
  const p = { activeElement: body, body, focusLog: [] };
  const xterm = (paneId) => ({
    tagName: 'TEXTAREA',
    paneId,
    closest: (sel) => (sel === '.xterm' ? p.activeElement : null),
    focus() {
      p.activeElement = this;
      p.focusLog.push(paneId);
    },
    blur() {
      if (p.activeElement === this) p.activeElement = body;
    },
  });
  const xterms = new Map(['pane-a', 'pane-b'].map((id) => [id, xterm(id)]));
  p.querySelector = (sel) => {
    const match = /^\[data-pane-body="([^"]+)"\] \.xterm-helper-textarea$/.exec(sel);
    return match ? xterms.get(match[1]) ?? null : null;
  };
  return p;
}
function installPage() {
  page = fakePage();
  globalThis.document = page;
}
function restore() {
  T.setState(original.state, true);
  if (original.hadDocument) globalThis.document = original.document;
  else delete globalThis.document;
}

// --- keys -------------------------------------------------------------------
/** A keydown as the browser reports it, with what the dispatcher did to it. */
function keydown(fields) {
  const e = {
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '',
    prevented: false, stopped: false, ...fields,
  };
  e.preventDefault = () => {
    e.prevented = true;
  };
  e.stopPropagation = () => {
    e.stopped = true;
  };
  return e;
}

const CTRL_PAGE_DOWN = { ctrlKey: true, key: 'PageDown', code: 'PageDown' };
const CTRL_PAGE_UP = { ctrlKey: true, key: 'PageUp', code: 'PageUp' };
// Shift turns ] into } on a US layout; the chord is matched on `code`.
const CMD_SHIFT_RIGHT_BRACKET = { metaKey: true, shiftKey: true, key: '}', code: 'BracketRight' };
const CMD_SHIFT_LEFT_BRACKET = { metaKey: true, shiftKey: true, key: '{', code: 'BracketLeft' };
const cmdDigit = (n) => ({ metaKey: true, key: String(n), code: `Digit${n}` });

/** The context useKeybindings builds for a key pressed in a focused terminal. */
function ctxFor(e, platform, { inMonaco = false, inTerminal = true, bindings = DEFAULT_RESOLVED } = {}) {
  return {
    bindings,
    isMod: platform === 'macos' ? e.metaKey : e.ctrlKey,
    isInMonacoEditor: inMonaco,
    isInTerminal: inTerminal,
    isWindows: platform === 'windows',
    isCommandPaletteOpen: false,
    modalOpen: () => false,
    ...workbenchContext({ isInMonacoEditor: inMonaco }),
  };
}

/** Press `fields` over a focused terminal on `platform`. */
function overTerminal(fields, platform = 'macos', opts = {}) {
  const e = keydown(fields);
  const fired = dispatchKeydownOverTerminal(e, ctxFor(e, platform, opts));
  return { fired, e };
}

describe('Next/Previous Tab and Go to Tab N, over a focused terminal (A5-1, A5-2)', () => {
  beforeEach(() => {
    if (!original) original = { state: T.getState(), hadDocument: 'document' in globalThis, document: globalThis.document };
    saved = original.state;
    installPage();
  });
  afterEach(() => restore());

  test('TN-01: Ctrl+PageDown and Ctrl+PageUp cycle the active pane\u{2019}s tabs and wrap at both ends, on every platform', () => {
    for (const platform of PLATFORMS) {
      arrange();
      const seen = [];
      for (let i = 0; i < 3; i += 1) {
        const { fired, e } = overTerminal(CTRL_PAGE_DOWN, platform);
        assert.equal(fired, 'next-tab', `${platform}: Ctrl+PageDown runs Next Tab`);
        assert.ok(e.prevented && e.stopped, `${platform}: claimed ahead of xterm, so no CSI 6;5~ reaches the pty`);
        seen.push(active());
      }
      assert.deepEqual(seen, ['a2', 'a3', 'a1'], `${platform}: next, next, and round to the first`);
      assert.equal(leaf('pane-a').activeTabId, 'a1', `${platform}: the pane shows the tab switched to`);
      assert.equal(T.getState().groups[0].activePaneId, 'pane-a', `${platform}: the active pane stays`);

      const back = [];
      for (let i = 0; i < 3; i += 1) {
        const { fired, e } = overTerminal(CTRL_PAGE_UP, platform);
        assert.equal(fired, 'previous-tab', `${platform}: Ctrl+PageUp runs Previous Tab`);
        assert.ok(e.prevented && e.stopped, `${platform}: no CSI 5;5~ reaches the pty`);
        back.push(active());
      }
      assert.deepEqual(back, ['a3', 'a2', 'a1'], `${platform}: back round the last, then down`);
      assert.ok(!seen.includes('b1') && !back.includes('b1'), `${platform}: the other pane\u{2019}s tab is never one of them`);
      assert.equal(page.activeElement.paneId, 'pane-a', `${platform}: the keyboard is in the terminal switched to`);
      assert.equal(page.focusLog.length, 6, `${platform}: each switch handed the keyboard over (focusActivePane)`);
      page.focusLog.length = 0;
    }
  });

  test('TN-01b: a pane of one tab is left as it is, and so is the keyboard', () => {
    arrange({ aTabs: ['a1'] });
    for (const fields of [CTRL_PAGE_DOWN, CTRL_PAGE_UP]) {
      const { fired } = overTerminal(fields, 'windows');
      assert.ok(fired === 'next-tab' || fired === 'previous-tab', 'the chord is still the command\u{2019}s');
      assert.equal(active(), 'a1');
    }
    assert.deepEqual(page.focusLog, [], 'nothing switched, nothing focused');
  });

  test('TN-02: on macOS \u{2318}\u{21E7}] and \u{2318}\u{21E7}[ do the same; off macOS the Windows/Super key spelling runs nothing', () => {
    arrange();
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const { fired, e } = overTerminal(CMD_SHIFT_RIGHT_BRACKET, 'macos');
      assert.equal(fired, 'next-tab');
      assert.ok(e.prevented && e.stopped);
      seen.push(active());
    }
    assert.deepEqual(seen, ['a2', 'a3', 'a1'], '\u{2318}\u{21E7}] wraps past the last');
    const back = [];
    for (let i = 0; i < 3; i += 1) {
      assert.equal(overTerminal(CMD_SHIFT_LEFT_BRACKET, 'macos').fired, 'previous-tab');
      back.push(active());
    }
    assert.deepEqual(back, ['a3', 'a2', 'a1'], '\u{2318}\u{21E7}[ wraps past the first');
    assert.equal(page.activeElement.paneId, 'pane-a');

    // A cmd default is macOS's alone (`macOnly`): off macOS its \u{2318} is the
    // Windows or Super key, and the press is left untouched.
    for (const platform of ['windows', 'linux']) {
      arrange();
      for (const fields of [CMD_SHIFT_RIGHT_BRACKET, CMD_SHIFT_LEFT_BRACKET]) {
        const { fired, e } = overTerminal(fields, platform);
        assert.equal(fired, null, `${platform}: Win+Shift+${fields.code} runs nothing`);
        assert.ok(!e.prevented && !e.stopped, `${platform}: and is neither swallowed nor stopped`);
      }
      assert.equal(active(), 'a1');
    }
  });

  test('TN-03: \u{2318}1..\u{2318}8 select the Nth tab, \u{2318}9 the last; \u{2318}5 in a 3-tab pane changes nothing', () => {
    // Ten tabs, so the last is not the ninth: \u{2318}9 is "last", as in browsers.
    const ten = Array.from({ length: 10 }, (_, i) => `a${i + 1}`);
    arrange({ aTabs: ten });
    for (let n = 1; n <= 8; n += 1) {
      // From another tab each time, so every press is a real switch.
      T.getState().switchTab(n === 1 ? 'a10' : 'a1');
      const { fired, e } = overTerminal(cmdDigit(n), 'macos');
      assert.equal(fired, `go-to-tab-${n}`);
      assert.ok(e.prevented && e.stopped);
      assert.equal(active(), `a${n}`, `\u{2318}${n} selects tab ${n}`);
      assert.equal(leaf('pane-a').activeTabId, `a${n}`);
    }
    assert.equal(overTerminal(cmdDigit(9), 'macos').fired, 'go-to-last-tab');
    assert.equal(active(), 'a10', '\u{2318}9 is the last tab, not the ninth');
    assert.equal(page.activeElement.paneId, 'pane-a', 'the keyboard is in the terminal shown');

    arrange();
    page.focusLog.length = 0;
    const { fired } = overTerminal(cmdDigit(5), 'macos');
    assert.equal(fired, 'go-to-tab-5', 'the chord is the command\u{2019}s');
    assert.equal(active(), 'a1', 'past the last tab: nothing changes');
    assert.equal(leaf('pane-a').activeTabId, 'a1');
    assert.deepEqual(page.focusLog, [], 'nor is anything focused');
    assert.equal(overTerminal(cmdDigit(9), 'macos').fired, 'go-to-last-tab');
    assert.equal(active(), 'a3', '\u{2318}9 in a 3-tab pane is the third');
    assert.equal(overTerminal(cmdDigit(3), 'macos').fired, 'go-to-tab-3');
    assert.equal(active(), 'a3', 'the tab shown already: nothing to do');
  });

  test('TN-04: off macOS, Alt+1, Ctrl+Alt+1 and Win+1 run no command, over a terminal or anywhere else', () => {
    const chords = {
      'Alt+1': { altKey: true, key: '1', code: 'Digit1' },
      'Ctrl+Alt+1': { ctrlKey: true, altKey: true, key: '1', code: 'Digit1' },
      'Win+1': { metaKey: true, key: '1', code: 'Digit1' },
    };
    for (const platform of ['windows', 'linux']) {
      arrange();
      for (const [name, fields] of Object.entries(chords)) {
        const { fired, e } = overTerminal(fields, platform);
        assert.equal(fired, null, `${platform}: ${name} over a terminal is the terminal\u{2019}s`);
        assert.ok(!e.prevented && !e.stopped, `${platform}: ${name} is neither swallowed nor stopped`);
        const outside = keydown(fields);
        assert.equal(findBinding(outside, ctxFor(outside, platform, { inTerminal: false })), null, `${platform}: ${name} names no binding`);
        assert.equal(dispatchKeydown(outside, ctxFor(outside, platform, { inTerminal: false })), null, `${platform}: ${name} runs nothing outside a terminal either`);
      }
      assert.equal(active(), 'a1', `${platform}: no tab moved`);
      assert.equal(shortcutLabel('go-to-tab-1', DEFAULT_RESOLVED, { isMac: false }), '', `${platform}: no chord to print`);
    }
    assert.equal(shortcutLabel('go-to-tab-1', DEFAULT_RESOLVED, { isMac: true }), '\u{2318}1');
    assert.equal(shortcutLabel('go-to-last-tab', DEFAULT_RESOLVED, { isMac: true }), '\u{2318}9');
    assert.equal(shortcutLabel('next-tab', DEFAULT_RESOLVED, { isMac: false }), 'Ctrl+PageDown');

    // A Win-key chord a user records off macOS is theirs, and works: only the
    // shipped \u{2318} defaults are macOS's alone.
    const { bindings, problems } = resolveKeybindings({ 'go-to-tab-2': 'cmd+2' });
    assert.deepEqual(problems, []);
    arrange();
    assert.equal(overTerminal({ metaKey: true, key: '2', code: 'Digit2' }, 'linux', { bindings }).fired, 'go-to-tab-2');
    assert.equal(active(), 'a2');
  });

  test('TN-05: with an editor pane active, every new tab command leaves activeTabId unchanged', () => {
    const presses = {
      'next-tab': [CTRL_PAGE_DOWN, 'windows'],
      'previous-tab': [CTRL_PAGE_UP, 'linux'],
      'go-to-last-tab': [cmdDigit(9), 'macos'],
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`go-to-tab-${n}`, [cmdDigit(n), 'macos']])),
    };
    for (const id of NEW_COMMANDS) {
      // From a terminal of that group, whose store says the file pane is THE
      // active pane.
      arrange({ kind: 'editor' });
      const before = { tab: active(), shown: leaf('pane-a').activeTabId };
      const [fields, platform] = presses[id];
      assert.equal(overTerminal(fields, platform).fired, id, `${id}: the chord is the command\u{2019}s`);
      COMMANDS[id].run(ctxFor(keydown(fields), platform));
      assert.equal(active(), before.tab, `${id}: activeTabId unchanged`);
      assert.equal(leaf('pane-a').activeTabId, before.shown, `${id}: the terminal pane shows what it showed`);
      assert.equal(T.getState().groups[0].activeKind, 'editor', `${id}: the file pane stays the active one`);

      // Inside Monaco the key is the editor's: Next/Previous Tab let it
      // through (its suggest list pages with Ctrl+PageUp/Down off macOS),
      // Go to Tab N does nothing.
      const inMonaco = keydown(fields);
      const fired = dispatchKeydown(inMonaco, ctxFor(inMonaco, platform, { inMonaco: true, inTerminal: false }));
      if (id === 'next-tab' || id === 'previous-tab') {
        assert.equal(fired, `pass:${id}`, `${id}: Monaco keeps the key`);
        assert.ok(!inMonaco.prevented);
      } else {
        assert.equal(fired, id);
      }
      assert.equal(active(), before.tab, `${id}: nothing moved from inside Monaco either`);
    }
    assert.deepEqual(page.focusLog, [], 'no terminal took the keyboard');

    // The keyboard decides first (`commandKind`): pressed inside Monaco while
    // the store still names the terminal pane, the key is the editor's, and
    // Go to Tab N does nothing.
    arrange();
    for (const n of [2, 3, 9]) {
      const e = keydown(cmdDigit(n));
      const fired = dispatchKeydown(e, ctxFor(e, 'macos', { inMonaco: true, inTerminal: false }));
      assert.equal(fired, n === 9 ? 'go-to-last-tab' : `go-to-tab-${n}`);
    }
    assert.equal(active(), 'a1', 'inside Monaco no terminal tab moves');
    assert.deepEqual(page.focusLog, []);
  });

  test('TN-06: every new command is rebindable and claimed over a terminal, and an override rebinds or unbinds it', () => {
    const configurable = configurableCommands().map((c) => c.id);
    const claimed = commandsOverTerminal().map((c) => c.id);
    for (const id of NEW_COMMANDS) {
      assert.ok(COMMANDS[id], `${id} exists`);
      assert.ok(configurable.includes(id), `${id} is in configurableCommands()`);
      assert.ok(claimed.includes(id), `${id} is in commandsOverTerminal()`);
      assert.equal(COMMANDS[id].menuId, null, `${id} has no menu entry`);
    }
    assert.equal(COMMANDS['go-to-tab-4'].title, 'Go to Tab 4');

    for (const id of NEW_COMMANDS) {
      // Rebound: the new chord runs it, from a focused terminal.
      const { bindings, problems } = resolveKeybindings({ [id]: 'ctrl+alt+shift+f9' });
      assert.deepEqual(problems, [], `${id}: the override is taken`);
      assert.deepEqual(keysFor(id, bindings), ['ctrl+alt+shift+f9']);
      const e = keydown({ ctrlKey: true, altKey: true, shiftKey: true, key: 'F9', code: 'F9' });
      assert.equal(dispatchKeydownOverTerminal(e, ctxFor(e, 'windows', { bindings })), id, `${id}: rebound`);
      // Unbound: no chord, and the default no longer runs it.
      const none = resolveKeybindings({ [id]: null }).bindings;
      assert.deepEqual(keysFor(id, none), [], `${id}: unbound`);
    }

    arrange();
    const unbound = resolveKeybindings({ 'next-tab': null, 'go-to-tab-2': null }).bindings;
    assert.equal(overTerminal(CTRL_PAGE_DOWN, 'windows', { bindings: unbound }).fired, null, 'Ctrl+PageDown is the terminal\u{2019}s again');
    assert.equal(overTerminal(CMD_SHIFT_RIGHT_BRACKET, 'macos', { bindings: unbound }).fired, null, 'and so is \u{2318}\u{21E7}]');
    assert.equal(overTerminal(cmdDigit(2), 'macos', { bindings: unbound }).fired, null, '\u{2318}2 is unbound');
    assert.equal(active(), 'a1');
    const moved = resolveKeybindings({ 'previous-tab': 'mod+alt+pageup' }).bindings;
    assert.equal(overTerminal(CTRL_PAGE_UP, 'linux', { bindings: moved }).fired, null, 'the old chord is free');
    assert.equal(overTerminal({ ctrlKey: true, altKey: true, key: 'PageUp', code: 'PageUp' }, 'linux', { bindings: moved }).fired, 'previous-tab');
    assert.equal(active(), 'a3', 'and switches, wrapping');
  });

  test('TN-07: the shipped defaults share no keypress on macOS, Windows or Linux', () => {
    for (const [name, platform] of [['macOS', { isMac: true }], ['Windows', { isMac: false, isWindows: true }], ['Linux', { isMac: false }]]) {
      assert.deepEqual(findConflicts(DEFAULT_RESOLVED, platform), [], `${name}: two commands share a chord out of the box`);
    }
    // What Settings reports is what the keyboard does, for a user's chord on
    // a macOS-only default as well. On macOS \u{2318}1 is Go to Tab 1's, so the
    // user's \u{2318}1 never runs, and that is reported. Off macOS the same keys
    // are Win+1, Go to Tab 1's default never ran there, and the user's chord
    // takes nothing from it: no conflict, not one naming Go to Tab 1 (B-R1).
    const { bindings } = resolveKeybindings({ 'toggle-sidebar': 'cmd+1' });
    for (const [platform, opts] of [['macos', { isMac: true }], ['windows', { isMac: false, isWindows: true }], ['linux', { isMac: false }]]) {
      const conflicts = findConflicts(bindings, opts);
      const e = keydown(cmdDigit(1));
      const runs = findBinding(e, ctxFor(e, platform, { bindings, inTerminal: false }))?.command;
      assert.equal(runs, platform === 'macos' ? 'go-to-tab-1' : 'toggle-sidebar', `${platform}: \u{2318}/Win+1 runs ${runs}`);
      if (platform === 'macos') {
        const reported = conflicts.find((c) => c.command === 'toggle-sidebar' && c.key === 'cmd+1');
        assert.equal(reported?.winner, 'go-to-tab-1', 'macos: the user\u{2019}s \u{2318}1 is reported as never running, Go to Tab 1 instead');
        assert.equal(reported?.winnerKey, 'cmd+1');
      } else {
        assert.ok(!conflicts.some((c) => c.commands.includes('go-to-tab-1')), `${platform}: Go to Tab 1 is in no conflict`);
        assert.deepEqual(conflicts, [], `${platform}: nothing to report, Win+1 is the user\u{2019}s`);
      }
    }
    // The same for the macOS-only Next Tab chord, \u{2318}\u{21E7}]: on macOS the two
    // share it (Split Right, earlier in the table, runs), off macOS they do not.
    const { bindings: onBracket } = resolveKeybindings({ 'split-right': 'cmd+shift+bracketright' });
    assert.deepEqual(
      findConflicts(onBracket, { isMac: true }).map((c) => [c.winner, c.command]),
      [['split-right', 'next-tab']],
      'macos: \u{2318}\u{21E7}] is in one conflict, Split Right running and Next Tab never'
    );
    for (const opts of [{ isMac: false, isWindows: true }, { isMac: false }]) {
      assert.deepEqual(findConflicts(onBracket, opts), [], `${JSON.stringify(opts)}: Next Tab\u{2019}s macOS chord takes nothing`);
    }
  });

  test('TN-07b: off macOS a settings row lists no macOS-only \u{2318} chord; on macOS and for the menus it does', () => {
    for (const [name, opts] of [['Windows', { isMac: false }], ['Linux', { isMac: false }]]) {
      for (let n = 1; n <= 8; n++) assert.deepEqual(keysFor(`go-to-tab-${n}`, DEFAULT_RESOLVED, opts), [], `${name}: Go to Tab ${n}`);
      assert.deepEqual(keysFor('go-to-last-tab', DEFAULT_RESOLVED, opts), [], `${name}: Go to Last Tab`);
      assert.deepEqual(keysFor('next-tab', DEFAULT_RESOLVED, opts), ['ctrl+pagedown'], `${name}: Next Tab keeps Ctrl+PageDown only`);
      assert.deepEqual(keysFor('previous-tab', DEFAULT_RESOLVED, opts), ['ctrl+pageup'], `${name}: Previous Tab keeps Ctrl+PageUp only`);
    }
    assert.deepEqual(keysFor('go-to-tab-1', DEFAULT_RESOLVED, { isMac: true }), ['cmd+1']);
    assert.deepEqual(keysFor('next-tab', DEFAULT_RESOLVED, { isMac: true }), ['ctrl+pagedown', 'cmd+shift+bracketright']);
    // No platform given: every chord, as before (a caller that picks its own).
    assert.deepEqual(keysFor('go-to-tab-1'), ['cmd+1']);
    assert.deepEqual(keysFor('previous-tab'), ['ctrl+pageup', 'cmd+shift+bracketleft']);
    // A \u{2318} chord the user recorded is theirs, and in force off macOS too.
    const { bindings } = resolveKeybindings({ 'go-to-tab-1': 'cmd+1' });
    assert.deepEqual(keysFor('go-to-tab-1', bindings, { isMac: false }), ['cmd+1'], 'the user\u{2019}s Win+1 is listed');
    // And a plain chord is never dropped.
    assert.deepEqual(keysFor('split-right', DEFAULT_RESOLVED, { isMac: false }), keysFor('split-right'));
  });

  test('TN-08: the tab math (tabNavigation.js)', () => {
    const tree = {
      type: 'split', id: 's', direction: 'horizontal', sizes: [50, 50],
      children: [terminalLeaf('p1', ['x', 'y', 'z'], 'y'), editorLeaf('pe', ['f']), terminalLeaf('p0', []), terminalLeaf('pq', ['q'], 'gone')],
    };
    assert.deepEqual(paneTabs(tree, 'p1'), { tabIds: ['x', 'y', 'z'], activeTabId: 'y' });
    assert.equal(paneTabs(tree, 'pe'), null, 'an editor pane has no terminal tabs');
    assert.equal(paneTabs(tree, 'p0'), null, 'nor has an empty pane');
    assert.equal(paneTabs(tree, 'nowhere'), null);
    assert.equal(paneTabs(null, 'p1'), null);
    assert.deepEqual(paneTabs(tree, 'pq'), { tabIds: ['q'], activeTabId: 'q' }, 'a stale active tab reads as the first');

    const pane = paneTabs(tree, 'p1');
    assert.equal(tabTarget(pane, 'next'), 'z');
    assert.equal(tabTarget(pane, 'previous'), 'x');
    assert.equal(tabTarget({ ...pane, activeTabId: 'z' }, 'next'), 'x', 'wraps past the last');
    assert.equal(tabTarget({ ...pane, activeTabId: 'x' }, 'previous'), 'z', 'wraps past the first');
    assert.equal(tabTarget(pane, 1), 'x');
    assert.equal(tabTarget(pane, 3), 'z');
    assert.equal(tabTarget(pane, 4), null, 'past the last tab');
    assert.equal(tabTarget(pane, 0), null);
    assert.equal(tabTarget(pane, 2), null, 'the tab shown already');
    assert.equal(tabTarget(pane, 'last'), 'z');
    assert.equal(tabTarget(pane, 'sideways'), null);
    assert.equal(tabTarget(paneTabs(tree, 'pq'), 'next'), null, 'one tab: nowhere to go');
    assert.equal(tabTarget(null, 'next'), null);
  });

  test('TN-99: teardown \u{2014} the store and the page as the next suite expects', () => {
    // afterEach runs only after a case that passed; this one puts back what
    // a failing case may have left.
    restore();
    assert.equal(T.getState(), original.state);
    assert.equal(globalThis.document, original.hadDocument ? original.document : undefined);
  });
});
