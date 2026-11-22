/**
 * The Ctrl+Tab switcher of the terminals most recently used (Bundle 2, A5-3;
 * AC4: MRU-01 to MRU-05).
 *
 * The chords go through `dispatchKeydownOverTerminal` — the capture-phase
 * listener a focused terminal's keys reach first — with the context
 * useKeybindings builds (`workbenchContext`, `heldModifiersOf`), over the
 * app's real terminal store arranged with two groups:
 *
 *   group-1 "Group 1"  [ pane-a (a1, a2) | pane-e (e1, a file) ]
 *   group-2 "Work"     [ pane-c (c1) ]
 *   u1: a spawned terminal no group holds yet
 *
 * A fake window carries the switcher's own listeners (keydown, keyup, blur),
 * which exist only while it is open; a fake page stands for the DOM, so where
 * the keyboard lands is read off `document.activeElement`.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore, __forgetClosedTerminals } from '../../src/stores/terminalStore.js';
import {
  COMMANDS,
  DEFAULT_RESOLVED,
  dispatchKeydown,
  dispatchKeydownOverTerminal,
  findConflicts,
  keysFor,
  resolveKeybindings,
} from '../../src/lib/keybindings.js';
import { workbenchContext } from '../../src/lib/workbenchCommands.js';
import {
  __resetTabMru,
  __tabMru,
  ensureTabMruStarted,
  heldModifiersOf,
  recentTerminalTabs,
  switcherOwnsKey,
  useTabSwitcherStore,
} from '../../src/stores/tabSwitcherStore.js';
import { createTabMru, folderName, placedTerminalTabs, switcherOrder } from '../../src/lib/tabMru.js';

const T = useTerminalStore;
const S = useTabSwitcherStore;

const PLATFORMS = ['macos', 'windows', 'linux'];

// Ids of the shape the app gives a terminal (`tab-term-N`): closing one asks
// the backend to delete its saved scrollback, and the mock refuses any other.
const A1 = 'tab-term-801';
const A2 = 'tab-term-802';
const C1 = 'tab-term-803';
const U1 = 'tab-term-804';

const termTab = (id, cwd = `/home/me/${id}`) => ({ id, title: `shell ${id}`, cwd, sessionId: `s-${id}` });
const terminalLeaf = (id, tabIds, activeTabId = tabIds[0]) => ({ type: 'leaf', id, tabIds, activeTabId });
const editorLeaf = (id, tabIds) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId: tabIds[0] ?? null });

/** The two groups above; `single` leaves one terminal (a1) and the unplaced u1. */
function arrange({ single = false } = {}) {
  T.setState(original.state, true);
  const groups = single
    ? [{ id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-a', tree: terminalLeaf('pane-a', [A1]) }]
    : [
        {
          id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-a', editorPaneId: 'pane-e',
          tree: {
            type: 'split', id: 'split-1', direction: 'horizontal', sizes: [50, 50],
            children: [terminalLeaf('pane-a', [A1, A2]), editorLeaf('pane-e', ['e1'])],
          },
        },
        { id: 'group-2', name: 'Work', createdAt: 0, activePaneId: 'pane-c', tree: terminalLeaf('pane-c', [C1]) },
      ];
  T.setState({
    tabs: (single ? [A1, U1] : [A1, A2, C1, U1]).map((id) => termTab(id)),
    activeTabId: A1,
    activeGroupId: 'group-1',
    notifications: [],
    groups,
  });
  ensureTabMruStarted();
}

const active = () => T.getState().activeTabId;
const activeGroup = () => T.getState().activeGroupId;

// --- the fake page and window ---------------------------------------------------
// What the suite found, taken once: a case that fails skips afterEach, and
// must not become what the next one restores.
let original = null;
let page = null;
let win = null;
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
  const xterms = new Map(['pane-a', 'pane-c'].map((id) => [id, xterm(id)]));
  p.querySelector = (sel) => {
    const match = /^\[data-pane-body="([^"]+)"\] \.xterm-helper-textarea$/.exec(sel);
    return match ? xterms.get(match[1]) ?? null : null;
  };
  return p;
}
function fakeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture: Boolean(capture) });
    },
    removeEventListener(type, fn, capture) {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === Boolean(capture));
      if (at >= 0) listeners.splice(at, 1);
    },
    dispatch(type, event = {}) {
      for (const l of [...listeners]) if (l.type === type) l.fn(event);
      return event;
    },
  };
}
function install() {
  page = fakePage();
  globalThis.document = page;
  win = fakeWindow();
  globalThis.window = win;
}
/** Everything back as the suite found it — run before each case as well as after. */
function restore() {
  S.getState().cancel();
  S.setState({ open: false, items: [], selectedIndex: 0, modifiers: null });
  __resetTabMru();
  __forgetClosedTerminals();
  T.setState(original.state, true);
  if (original.hadDocument) globalThis.document = original.document;
  else delete globalThis.document;
  if (original.hadWindow) globalThis.window = original.window;
  else delete globalThis.window;
}

// --- keys ---------------------------------------------------------------------------
/** A key event as the browser reports it, with what was done to it. */
function keyEvent(fields) {
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

const CTRL_TAB = { ctrlKey: true, key: 'Tab', code: 'Tab' };
const CTRL_SHIFT_TAB = { ctrlKey: true, shiftKey: true, key: 'Tab', code: 'Tab' };
// Letting go of Control: the browser reports the key, its flag already down.
const CONTROL_UP = { key: 'Control', code: 'ControlLeft' };

/** The context useKeybindings builds for a key pressed in a focused terminal. */
function ctxFor(e, platform, { bindings = DEFAULT_RESOLVED, inTerminal = true, dialog = false, menu = false, palette = false } = {}) {
  return {
    bindings,
    isMod: platform === 'macos' ? e.metaKey : e.ctrlKey,
    isInMonacoEditor: false,
    isInTerminal: inTerminal,
    isWindows: platform === 'windows',
    isCommandPaletteOpen: palette,
    isDialogOpen: () => dialog,
    isMenuOpen: () => menu,
    modalOpen: () => false,
    heldModifiers: heldModifiersOf(e),
    ...workbenchContext({ isInMonacoEditor: false }),
  };
}

/** Press `fields` over a focused terminal on `platform`. */
function press(fields, platform = 'macos', opts = {}) {
  const e = keyEvent(fields);
  const fired = dispatchKeydownOverTerminal(e, ctxFor(e, platform, opts));
  return { fired, e };
}
/** A key the switcher's window listener hears (Escape, Enter, the arrows). */
const windowKey = (key, fields = {}) => win.dispatch('keydown', keyEvent({ key, code: key, ...fields }));
const keyUp = (fields) => win.dispatch('keyup', keyEvent(fields));
const switcher = () => S.getState();
const listening = () => win.listeners.map((l) => `${l.type}${l.capture ? ':capture' : ''}`).sort();

/** a1 -> c1 -> a2: the list is then a2, c1, a1 and a2 is on screen. */
function visitThree() {
  T.getState().switchTab(C1);
  T.getState().switchTab(A2);
  assert.deepEqual(recentTerminalTabs(), [A2, C1, A1], 'the list, most recent first');
}

describe('Ctrl+Tab: the terminals most recently used, across groups (A5-3)', () => {
  beforeEach(() => {
    if (!original) {
      original = {
        state: T.getState(),
        hadDocument: 'document' in globalThis,
        document: globalThis.document,
        hadWindow: 'window' in globalThis,
        window: globalThis.window,
      };
    }
    restore();
    install();
  });
  afterEach(() => restore());

  test('MRU-01: switchTab and a pane taking focus put a terminal first, across groups; files and unplaced tabs are never listed; a closed tab leaves the list', async () => {
    arrange();
    assert.deepEqual(__tabMru(), [A1], 'the terminal on screen when it started');
    T.getState().switchTab(C1);
    assert.equal(activeGroup(), 'group-2', 'switchTab went to the other group');
    assert.deepEqual(recentTerminalTabs(), [C1, A1, A2], 'c1 first, a1 next, a2 never used after them');
    // A click in a pane: the store's `setActivePane`, which every pane focus ends in.
    T.getState().setActivePane('pane-a', 'group-1');
    assert.deepEqual(recentTerminalTabs(), [A1, C1, A2], 'focusing pane-a puts its terminal first');
    T.getState().switchTab(A2);
    assert.deepEqual(recentTerminalTabs(), [A2, A1, C1]);
    // A spawned tab no group holds is the active tab for a moment, never listed.
    T.getState().switchTab(U1);
    assert.equal(active(), U1);
    assert.equal(__tabMru()[0], U1, 'the raw list follows activeTabId');
    assert.deepEqual(recentTerminalTabs(), [A2, A1, C1], 'but the switcher lists placed terminals only');
    assert.ok(!recentTerminalTabs().includes('e1'), 'a file in an editor pane is not a terminal');

    T.getState().switchTab(C1);
    await T.getState().closeTab(A1);
    assert.ok(!T.getState().tabs.some((t) => t.id === A1), 'a1 closed');
    assert.ok(!__tabMru().includes(A1), 'a closed tab leaves the list');
    assert.deepEqual(recentTerminalTabs(), [C1, A2]);
    // A switch to a tab already shown changes nothing.
    T.getState().switchTab(C1);
    assert.deepEqual(recentTerminalTabs(), [C1, A2]);
  });

  test('MRU-02: Ctrl+Tab opens it with index 1 selected; Ctrl+Tab, Ctrl+Shift+Tab, Up and Down move with wrapping; letting go of Control switches; Escape and blur call it off', () => {
    for (const platform of PLATFORMS) {
      arrange();
      visitThree();
      assert.deepEqual(listening(), [], `${platform}: no listener while closed`);

      let { fired, e } = press(CTRL_TAB, platform);
      assert.equal(fired, 'switch-recent-tab', `${platform}: Ctrl+Tab runs the switcher`);
      assert.ok(e.prevented && e.stopped, `${platform}: claimed ahead of xterm, so no Tab reaches the shell`);
      assert.equal(switcher().open, true, `${platform}: open`);
      assert.deepEqual(switcher().items, [A2, C1, A1], `${platform}: every group's terminals`);
      assert.equal(switcher().selectedIndex, 1, `${platform}: the previous terminal selected`);
      assert.equal(active(), A2, `${platform}: nothing switched yet`);
      assert.deepEqual(listening(), ['blur', 'keydown:capture', 'keyup:capture'], `${platform}: its listeners, while open`);

      const seen = [];
      for (const chord of [CTRL_TAB, CTRL_TAB, CTRL_SHIFT_TAB, CTRL_SHIFT_TAB]) {
        ({ fired, e } = press(chord, platform));
        assert.ok(e.prevented && e.stopped, `${platform}: ${fired} claimed`);
        seen.push(switcher().selectedIndex);
      }
      assert.deepEqual(seen, [2, 0, 2, 1], `${platform}: forward round the end, back round the start`);
      assert.equal(fired, 'switch-recent-tab-back', `${platform}: Ctrl+Shift+Tab is the back command`);

      const down = windowKey('ArrowDown', { ctrlKey: true });
      assert.equal(switcher().selectedIndex, 2, `${platform}: Down moves on`);
      assert.ok(down.prevented && down.stopped, `${platform}: Down is the switcher's, not the shell's history`);
      assert.ok(switcherOwnsKey(down), `${platform}: and useKeybindings leaves it alone`);
      windowKey('ArrowDown', { ctrlKey: true });
      assert.equal(switcher().selectedIndex, 0, `${platform}: Down wraps`);
      windowKey('ArrowUp', { ctrlKey: true });
      windowKey('ArrowUp', { ctrlKey: true });
      assert.equal(switcher().selectedIndex, 1, `${platform}: Up wraps back`);
      const other = windowKey('x', { ctrlKey: true });
      assert.ok(!other.prevented && !switcherOwnsKey(other), `${platform}: any other key is left alone`);

      keyUp({ ctrlKey: true, key: 'Tab', code: 'Tab' });
      keyUp({ ctrlKey: true, key: 'Shift', code: 'ShiftLeft' });
      assert.equal(switcher().open, true, `${platform}: still open while Control is held`);
      assert.equal(active(), A2, `${platform}: still nothing switched`);

      keyUp(CONTROL_UP);
      assert.equal(switcher().open, false, `${platform}: letting go of Control closes it`);
      assert.equal(active(), C1, `${platform}: and switches to the one selected`);
      assert.equal(activeGroup(), 'group-2', `${platform}: in its own group`);
      assert.equal(page.activeElement?.paneId, 'pane-c', `${platform}: the keyboard is in that terminal`);
      assert.deepEqual(listening(), [], `${platform}: its listeners gone`);

      // Escape: nothing switched, and the keyboard never left.
      press(CTRL_TAB, platform);
      assert.equal(switcher().open, true);
      const focusBefore = page.focusLog.length;
      const esc = windowKey('Escape', { ctrlKey: true });
      assert.ok(esc.prevented && esc.stopped, `${platform}: Escape is the switcher's, not the shell's`);
      assert.equal(switcher().open, false, `${platform}: Escape closes it`);
      assert.equal(active(), C1, `${platform}: Escape switches nothing`);
      keyUp(CONTROL_UP);
      assert.equal(active(), C1, `${platform}: nor does letting go after it`);
      assert.equal(page.focusLog.length, focusBefore, `${platform}: nor moves the keyboard`);
      assert.deepEqual(listening(), [], `${platform}: no listener after Escape`);

      // The window losing focus.
      press(CTRL_TAB, platform);
      press(CTRL_TAB, platform);
      win.dispatch('blur', {});
      assert.equal(switcher().open, false, `${platform}: blur closes it`);
      assert.equal(active(), C1, `${platform}: blur switches nothing`);
      keyUp(CONTROL_UP);
      assert.equal(active(), C1, `${platform}: nor a Control that comes up after it`);
      assert.deepEqual(listening(), [], `${platform}: no listener after blur`);

      // Enter picks the selection too.
      press(CTRL_TAB, platform);
      press(CTRL_TAB, platform);
      const target = switcher().items[switcher().selectedIndex];
      const enter = windowKey('Enter', { ctrlKey: true });
      assert.ok(enter.prevented && enter.stopped, `${platform}: Enter does not reach the shell`);
      assert.equal(active(), target, `${platform}: Enter switches to the selection`);
      assert.equal(switcher().open, false);

      assert.deepEqual(
        findConflicts(DEFAULT_RESOLVED, { isMac: platform === 'macos', isWindows: platform === 'windows' })
          .filter((c) => c.commands.some((id) => id.startsWith('switch-recent-tab'))),
        [],
        `${platform}: neither chord is taken from or by another binding`
      );
      restore();
      install();
    }
  });

  test('MRU-03: a quick Ctrl+Tab goes straight to the previous terminal, in another group, and a second one comes back', () => {
    for (const platform of PLATFORMS) {
      arrange();
      T.getState().switchTab(C1);
      assert.equal(activeGroup(), 'group-2');

      press(CTRL_TAB, platform);
      keyUp(CONTROL_UP);
      assert.equal(active(), A1, `${platform}: the previous terminal`);
      assert.equal(activeGroup(), 'group-1', `${platform}: its group on screen`);
      assert.equal(page.activeElement?.paneId, 'pane-a', `${platform}: the keyboard in it`);
      assert.equal(switcher().open, false);

      press(CTRL_TAB, platform);
      keyUp(CONTROL_UP);
      assert.equal(active(), C1, `${platform}: and back again`);
      assert.equal(page.activeElement?.paneId, 'pane-c');

      // Ctrl+Shift+Tab, let go: the one used longest ago.
      press(CTRL_SHIFT_TAB, platform);
      assert.equal(switcher().selectedIndex, 2, `${platform}: back from the start is the end`);
      keyUp({ ctrlKey: true, key: 'Shift', code: 'ShiftLeft' });
      assert.equal(switcher().open, true, `${platform}: Control still down`);
      keyUp(CONTROL_UP);
      assert.equal(active(), A2, `${platform}: the one used longest ago`);
      restore();
      install();
    }
  });

  test('MRU-04: with one terminal there is nothing to switch to and nothing opens', () => {
    for (const platform of PLATFORMS) {
      arrange({ single: true });
      for (const chord of [CTRL_TAB, CTRL_SHIFT_TAB]) {
        const { fired, e } = press(chord, platform);
        assert.ok(fired === 'switch-recent-tab' || fired === 'switch-recent-tab-back', `${platform}: the chord is the switcher's`);
        assert.ok(e.prevented, `${platform}: and still no Tab sent to the shell`);
        assert.equal(switcher().open, false, `${platform}: nothing opens`);
        assert.deepEqual(listening(), [], `${platform}: and nothing listens`);
      }
      // The unplaced u1 is not a second terminal.
      T.getState().switchTab(U1);
      press(CTRL_TAB, platform);
      assert.equal(switcher().open, false, `${platform}: an unplaced tab is not one to switch to`);
      keyUp(CONTROL_UP);
      assert.equal(active(), U1, `${platform}: nothing switched`);
      restore();
      install();
    }
    // Nothing at all.
    T.setState({ tabs: [], activeTabId: null, groups: [] });
    assert.equal(S.getState().step(1, { ctrl: true }), false);
    assert.equal(switcher().open, false);
  });

  test('MRU-05: rebound to Alt+Q, Alt+Q walks the list and letting go of Alt switches', () => {
    const { bindings, problems } = resolveKeybindings({ 'switch-recent-tab': 'alt+q' });
    assert.deepEqual(problems, []);
    assert.deepEqual(keysFor('switch-recent-tab', bindings), ['alt+q']);
    const ALT_Q = { altKey: true, key: 'q', code: 'KeyQ' };
    for (const platform of PLATFORMS) {
      arrange();
      visitThree();
      let { fired } = press(CTRL_TAB, platform, { bindings });
      assert.equal(fired, null, `${platform}: Ctrl+Tab is no longer the switcher's`);
      assert.equal(switcher().open, false);

      ({ fired } = press(ALT_Q, platform, { bindings }));
      assert.equal(fired, 'switch-recent-tab', `${platform}: Alt+Q is`);
      assert.equal(switcher().selectedIndex, 1);
      assert.deepEqual(switcher().modifiers, { ctrl: false, alt: true, meta: false, shift: false }, `${platform}: Alt is what must come up`);
      press(ALT_Q, platform, { bindings });
      assert.equal(switcher().selectedIndex, 2, `${platform}: Alt+Q again moves on`);
      keyUp({ altKey: true, key: 'q', code: 'KeyQ' });
      keyUp({ altKey: true, ...CONTROL_UP });
      assert.equal(switcher().open, true, `${platform}: Control coming up is not Alt`);
      keyUp({ key: 'Alt', code: 'AltLeft' });
      assert.equal(switcher().open, false, `${platform}: letting go of Alt picks`);
      assert.equal(active(), A1, `${platform}: the third terminal`);
      assert.equal(page.activeElement?.paneId, 'pane-a');
      restore();
      install();
    }
  });

  test('MRU-06: the commands, their defaults and the bytes xterm would have sent', () => {
    for (const id of ['switch-recent-tab', 'switch-recent-tab-back']) {
      assert.equal(COMMANDS[id].menuId, null, `${id}: keyboard only`);
      assert.equal(COMMANDS[id].overTerminal, true, `${id}: claimed over a terminal`);
      assert.equal(COMMANDS[id].passThrough, undefined, `${id}: nothing lets it through`);
    }
    assert.deepEqual(keysFor('switch-recent-tab'), ['ctrl+tab'], 'literal Ctrl, macOS too');
    assert.deepEqual(keysFor('switch-recent-tab-back'), ['ctrl+shift+tab']);
    // ⌘Tab is the OS's app switcher, and is never this.
    const cmdTab = press({ metaKey: true, key: 'Tab', code: 'Tab' }, 'macos');
    assert.equal(cmdTab.fired, null);
    // A plain Tab and Shift+Tab stay the shell's.
    assert.equal(press({ key: 'Tab', code: 'Tab' }, 'windows').fired, null);
    assert.equal(press({ shiftKey: true, key: 'Tab', code: 'Tab' }, 'linux').fired, null);

    // Outside a terminal (a field, Monaco) the bubble-phase listener runs it.
    arrange();
    visitThree();
    const e = keyEvent(CTRL_TAB);
    assert.equal(dispatchKeydown(e, ctxFor(e, 'windows', { inTerminal: false })), 'switch-recent-tab');
    assert.equal(switcher().open, true);
    S.getState().cancel();

    // xterm 6 sends Ctrl+Tab as Tab (HT) and Ctrl+Shift+Tab as Shift+Tab
    // (CSI Z): its key 9 case never asks for Ctrl, so the shell loses nothing.
    const source = readFileSync(new URL('../../node_modules/@xterm/xterm/src/common/input/Keyboard.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    const tabCase = /case 9:\n([\s\S]*?)\n\s*case 13:/.exec(source)?.[1] ?? '';
    assert.ok(tabCase.includes("C0.ESC + '[Z'") && tabCase.includes('C0.HT'), 'Shift+Tab is CSI Z and Tab is HT');
    assert.ok(!/ctrlKey/.test(tabCase), 'Ctrl changes nothing for Tab');
  });

  test('MRU-07: the pure list, order and folder name', () => {
    const mru = createTabMru();
    mru.touch(null);
    mru.touch('a');
    mru.touch('b');
    mru.touch('a');
    assert.deepEqual(mru.order(), ['a', 'b'], 'touched again moves to the front, once');
    const copy = mru.order();
    copy.push('x');
    assert.deepEqual(mru.order(), ['a', 'b'], 'order() is a copy');
    mru.prune(['b', 'z']);
    assert.deepEqual(mru.order(), ['b']);
    mru.prune(null);
    assert.deepEqual(mru.order(), []);

    const groups = [
      { id: 'g1', name: 'One', tree: { type: 'split', children: [terminalLeaf('p1', ['t1', 't2']), editorLeaf('e', ['f1'])] } },
      { id: 'g2', name: 'Two', tree: terminalLeaf('p2', ['t3']) },
      { id: 'g3', tree: null },
    ];
    assert.deepEqual(placedTerminalTabs(groups), [
      { tabId: 't1', groupId: 'g1', groupName: 'One' },
      { tabId: 't2', groupId: 'g1', groupName: 'One' },
      { tabId: 't3', groupId: 'g2', groupName: 'Two' },
    ]);
    assert.deepEqual(placedTerminalTabs(null), []);
    assert.deepEqual(switcherOrder(['t3', 'gone', 'f1', 't3', 't1'], groups), ['t3', 't1', 't2'], 'recent first, unknown and files out, the rest after');
    assert.deepEqual(switcherOrder(null, groups), ['t1', 't2', 't3']);

    assert.equal(folderName('/home/me/project/'), 'project');
    assert.equal(folderName('C:\\Users\\me\\work'), 'work');
    assert.equal(folderName('/'), '/');
    assert.equal(folderName(''), '');
    assert.equal(folderName(null), '');
  });

  test('MRU-08: a terminal closed while the switcher is open leaves it; fewer than two left, it closes', async () => {
    arrange();
    visitThree();
    press(CTRL_TAB, 'windows');
    press(CTRL_TAB, 'windows');
    assert.equal(switcher().items[switcher().selectedIndex], A1);
    await T.getState().closeTab(C1);
    assert.deepEqual(switcher().items, [A2, A1], 'c1 gone from the open list');
    assert.equal(switcher().items[switcher().selectedIndex], A1, 'the selection stays on its terminal');
    await T.getState().closeTab(A1);
    assert.equal(switcher().open, false, 'one left: closed');
    assert.deepEqual(listening(), [], 'and its listeners gone');
    // A commit to a tab that went meanwhile switches nothing.
    T.setState({
      tabs: [A1, A2, C1].map((id) => termTab(id)),
      groups: [{ id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-a', tree: terminalLeaf('pane-a', [A1, A2, C1], A2) }],
      activeGroupId: 'group-1',
      activeTabId: A2,
    });
    S.setState({ open: true, items: [A2, 'zz'], selectedIndex: 1, modifiers: { ctrl: true } });
    assert.equal(S.getState().commit(), null);
    assert.equal(active(), A2);
    assert.equal(switcher().open, false);
  });

  test('MRU-09: not over a dialog, a menu that took the keyboard or the command palette, whose Escape and Enter it would take', () => {
    arrange();
    visitThree();
    for (const over of [{ dialog: true }, { menu: true }, { palette: true }]) {
      for (const chord of [CTRL_TAB, CTRL_SHIFT_TAB]) {
        const e = keyEvent(chord);
        assert.equal(dispatchKeydown(e, ctxFor(e, 'windows', { inTerminal: false, ...over })), null, `${JSON.stringify(over)}: nothing runs`);
        assert.ok(!e.prevented, `${JSON.stringify(over)}: the key is left to what is on top`);
        assert.equal(switcher().open, false);
        assert.deepEqual(listening(), []);
      }
    }
    assert.equal(active(), A2, 'nothing switched');
    // Open already, the chord still moves it: the switcher is no dialog.
    press(CTRL_TAB, 'windows');
    press(CTRL_TAB, 'windows');
    assert.equal(switcher().selectedIndex, 2);
  });

  test('MRU-10: a start returns its stop, which App\u{2019}s effect hands back; a second start subscribes nothing again and stops nothing (B-R4)', async () => {
    arrange();
    __resetTabMru();
    // Count the subscriptions to the terminal store the list makes and ends.
    const realSubscribe = T.subscribe;
    let made = 0;
    let live = 0;
    T.subscribe = (listener) => {
      made += 1;
      live += 1;
      const off = realSubscribe(listener);
      let ended = false;
      return () => {
        if (!ended) live -= 1;
        ended = true;
        off();
      };
    };
    try {
      const stop = ensureTabMruStarted();
      assert.equal(typeof stop, 'function', 'a stop, for the effect to return');
      assert.deepEqual([made, live], [1, 1]);
      const again = ensureTabMruStarted();
      recentTerminalTabs();
      assert.deepEqual([made, live], [1, 1], 'started twice, subscribed once');
      again();
      assert.equal(live, 1, 'the second start\u{2019}s stop leaves the first one\u{2019}s subscription');
      T.getState().switchTab(C1);
      assert.equal(__tabMru()[0], C1, 'still followed');

      stop();
      assert.equal(live, 0, 'stopped: nothing left subscribed');
      T.getState().switchTab(A2);
      assert.equal(__tabMru()[0], C1, 'and no longer followed');
      stop();
      assert.equal(live, 0, 'a second stop is harmless');
      await T.getState().closeTab(C1);

      // Started again (React's StrictMode, a hot reload): followed again, once.
      const restarted = ensureTabMruStarted();
      assert.deepEqual([made, live], [2, 1]);
      assert.equal(__tabMru()[0], A2, 'from the terminal on screen');
      assert.ok(!__tabMru().includes(C1), 'a tab closed while stopped is not kept');
      stop();
      assert.equal(live, 1, 'an old stop does not end a later start\u{2019}s subscription');
      T.getState().switchTab(A1);
      assert.equal(__tabMru()[0], A1);
      restarted();
      assert.equal(live, 0);
    } finally {
      T.subscribe = realSubscribe;
      __resetTabMru();
    }
    // App's effect is the arrow that returns it, so React runs it as the cleanup.
    // CRLF made LF: a Windows checkout (CI) has CRLF line endings.
    const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(app, /\n\s*useEffect\(\(\) => ensureTabMruStarted\(\), \[\]\);\n/, 'the effect returns the stop');
  });

  test('MRU-99: teardown \u{2014} the stores, the page and the window as the next suite expects', () => {
    restore();
    assert.equal(T.getState(), original.state);
    assert.equal(switcher().open, false);
    assert.deepEqual(__tabMru(), []);
    assert.equal(globalThis.document, original.hadDocument ? original.document : undefined);
    assert.equal(globalThis.window, original.hadWindow ? original.window : undefined);
  });
});
