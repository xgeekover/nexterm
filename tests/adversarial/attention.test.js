/**
 * Which terminal is waiting for you, and getting there in one key.
 *
 * With several agents running in several terminals, an entry in the bell is
 * not enough: the user needs to see WHICH terminal wants them, and to go
 * there. Every entry now carries `read`, false when made; a terminal's unread
 * entries ring its pane and count on its chips; it is marked read when it is
 * seen — the active tab in a focused window — or by an explicit action. The
 * terminal's bell (a BEL) joins the program notifications and the finished
 * commands as a third source, coalesced and rate-limited. And whatever is
 * kept about a terminal goes when it does.
 *
 * The rules are src/lib/attention.js (pure) and terminalStore's actions and
 * its attention subscription; the window's half is src/hooks/useAttention.js.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  addBell,
  bellText,
  hasUnreadFailure,
  isUnread,
  latestUnread,
  markRead,
  unreadBadge,
  unreadCountByTab,
  unreadIn,
  unreadLabel,
  unreadTotal,
} from '../../src/lib/attention.js';
import { notificationSummary } from '../../src/lib/tabActivity.js';
// The whole module as well, for what the fix pass added: read inside each
// case, so a case fails on its own when one is missing rather than the file.
import * as attentionLib from '../../src/lib/attention.js';
import * as storeLib from '../../src/stores/terminalStore.js';
import * as focusLib from '../../src/lib/workspaceFocus.js';
import {
  useTerminalStore as S,
  __attentionKept,
  __setAttentionFlashMs,
  __setAttentionSource,
  __setTerminalFocus,
} from '../../src/stores/terminalStore.js';
import { useSettingsStore, SETTINGS_DEFAULTS, isViewShown } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { startAttention } from '../../src/hooks/useAttention.js';
import { RATE_LIMIT } from '../../src/lib/programNotifications.js';
import {
  COMMANDS,
  DEFAULT_RESOLVED,
  dispatchKeydown,
  dispatchKeydownOverTerminal,
  keysFor,
  menuIdOf,
  resolveKeybindings,
  shortcutLabel,
} from '../../src/lib/keybindings.js';
import { buildPaletteGroups, paletteCommands } from '../../src/lib/paletteItems.js';
import { isMac } from '../../src/lib/platform.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FOCUSED = { focused: true, visible: true };
const BACKGROUND = { focused: false, visible: true };

/** A command that finished, a program's message and a bell, as the store makes them. */
const command = (id, tabId, extra = {}) => ({ id, tabId, title: 'build', exitCode: 0, durationMs: 1, at: 1, read: false, ...extra });
const message = (id, tabId, extra = {}) => ({ id, kind: 'program', tabId, tabTitle: tabId, title: 'opencode', body: 'done', at: 1, read: false, ...extra });

describe('Attention: reading the list', () => {
  test('AT-01: a tab\'s unread count is its entries with `read === false` — nothing else counts', () => {
    const list = [
      command('n1', 'a'),
      message('n2', 'a'),
      command('n3', 'b', { read: true }),
      command('n4', 'b'),
      { id: 'n5', tabId: 'c', title: 'no read field at all', exitCode: 0, at: 1 },
      command('n6', 'c', { read: 'no' }),
      command('n7', undefined),
    ];
    assert.deepEqual({ ...unreadCountByTab(list) }, { a: 2, b: 1 });
    assert.equal(unreadTotal(list), 4, 'the entry with no tab is still unread, and counts in the total');
    assert.ok(isUnread(list[0]) && !isUnread(list[2]) && !isUnread(list[4]) && !isUnread(null));
    assert.equal(unreadIn(unreadCountByTab(list), ['a', 'b', 'c', 'x']), 3, 'a group or a pane sums its tabs');
    assert.equal(unreadIn(unreadCountByTab(list), []), 0);
    assert.deepEqual({ ...unreadCountByTab([]) }, {});
    assert.deepEqual({ ...unreadCountByTab(null) }, {});
    assert.equal(unreadTotal(undefined), 0);
  });

  test('AT-02: the counts of one list are one object — usable as a store selector without re-rendering', () => {
    const list = [command('n1', 'a')];
    const first = unreadCountByTab(list);
    assert.equal(unreadCountByTab(list), first, 'the same list, the same object');
    assert.ok(Object.isFrozen(first), 'and nobody can change it under the next reader');
    assert.notEqual(unreadCountByTab([...list]), first, 'a new list is counted afresh');
    assert.equal(unreadCountByTab([]), unreadCountByTab([command('x', 'a', { read: true })]), 'nothing unread is always the same empty object');
  });

  test('AT-03: the badge and the words — 1 to 9, then 9+; "N unread notifications"', () => {
    assert.deepEqual([0, 1, 9, 10, 57].map(unreadBadge), ['', '1', '9', '9+', '9+']);
    assert.deepEqual([-3, NaN, undefined, 2.7].map(unreadBadge), ['', '', '', '2']);
    assert.equal(unreadLabel(1), '1 unread notification');
    assert.equal(unreadLabel(3), '3 unread notifications');
    assert.equal(unreadLabel(0), '0 unread notifications');
    assert.equal(bellText(1), 'Bell');
    assert.equal(bellText(3), 'Bell \u{00d7}3');
    assert.equal(bellText(undefined), 'Bell');
  });

  test('AT-04: the bell turns red for an unread failure only — not a read one, not a message, not a bell, not cmd', () => {
    assert.equal(hasUnreadFailure([command('n1', 'a', { exitCode: 2 })]), true);
    assert.equal(hasUnreadFailure([command('n1', 'a', { exitCode: 2, read: true })]), false, 'seen, it is no longer news');
    assert.equal(hasUnreadFailure([command('n1', 'a', { exitCode: null })]), false, 'cmd gives no code');
    assert.equal(hasUnreadFailure([message('n1', 'a', { exitCode: 1 })]), false);
    assert.equal(hasUnreadFailure([{ id: 'b', kind: 'bell', tabId: 'a', exitCode: 1, read: false }]), false);
    assert.equal(hasUnreadFailure([command('n1', 'a'), command('n2', 'b', { exitCode: 1 })]), true);
    assert.equal(hasUnreadFailure(null), false);
  });

  test('AT-05: the latest unread — newest by time, its terminal still there; read ones and gone ones skipped', () => {
    const list = [
      message('new-but-gone', 'gone', { at: 50 }),
      command('read', 'a', { at: 40, read: true }),
      command('older', 'a', { at: 10 }),
      message('newest', 'b', { at: 30 }),
      command('same-time', 'a', { at: 30 }),
    ];
    assert.equal(latestUnread(list, ['a', 'b'])?.id, 'newest', 'a tie goes to the one higher in the list');
    assert.equal(latestUnread(list, new Set(['a']))?.id, 'same-time');
    assert.equal(latestUnread(list, ['zzz']), null);
    assert.equal(latestUnread([], ['a']), null);
    assert.equal(latestUnread(list.map((n) => ({ ...n, read: true })), ['a', 'b', 'gone']), null);
  });

  test('AT-06: marking read hands back the same list when nothing was unread, so nothing re-renders', () => {
    const list = [command('n1', 'a'), command('n2', 'b'), command('n3', 'a', { read: true })];
    const marked = markRead(list, (n) => n.tabId === 'a');
    assert.notEqual(marked, list);
    assert.deepEqual(marked.map((n) => n.read), [true, false, true]);
    assert.equal(marked[2], list[2], 'an entry already read is the same object');
    assert.equal(markRead(marked, (n) => n.tabId === 'a'), marked, 'nothing left to mark: the same array');
    assert.deepEqual(markRead(list).map((n) => n.read), [true, true, true]);
    assert.ok(list.every((n, i) => n.read === [false, false, true][i]), 'the list it was given is untouched');
  });

  test('AT-07: a bell rung again while its entry is unread is that entry, counted, moved to the top', () => {
    let list = [command('n1', 'b', { at: 5 })];
    list = addBell(list, { id: 'bell-1', tabId: 'a', tabTitle: 'Terminal 1', at: 10 }, 50);
    assert.deepEqual(list[0], { id: 'bell-1', kind: 'bell', tabId: 'a', tabTitle: 'Terminal 1', title: 'Terminal 1', body: '', count: 1, at: 10, read: false });
    list = addBell(list, { id: 'bell-x', tabId: 'b', tabTitle: 'Terminal 2', at: 20 }, 50);
    list = addBell(list, { id: 'bell-2', tabId: 'a', tabTitle: 'renamed', at: 30 }, 50);
    assert.deepEqual(list.map((n) => n.id), ['bell-1', 'bell-x', 'n1'], 'one row for a, at the top, under its first id');
    assert.equal(list[0].count, 2);
    assert.equal(list[0].at, 30, 'its time is now');
    assert.equal(list[0].title, 'renamed', 'and its terminal is called what it is called now');
    // Read, the next ring is news again.
    list = markRead(list, (n) => n.tabId === 'a');
    list = addBell(list, { id: 'bell-3', tabId: 'a', tabTitle: 'renamed', at: 40 }, 50);
    assert.deepEqual(list.map((n) => [n.id, n.count ?? null, n.read]), [
      ['bell-3', 1, false],
      ['bell-1', 2, true],
      ['bell-x', 1, false],
      ['n1', null, false],
    ]);
    // A program's message is not a bell to add to.
    assert.equal(addBell([message('m', 'a')], { id: 'bell-4', tabId: 'a', tabTitle: 'x', at: 1 }).length, 2);
    // Capped like everything else.
    let full = Array.from({ length: 50 }, (_, i) => command(`c${i}`, 'b'));
    full = addBell(full, { id: 'bell-5', tabId: 'a', tabTitle: 'x', at: 1 }, 50);
    assert.equal(full.length, 50);
    assert.equal(full[0].id, 'bell-5');
  });

  test('AT-09: past the cap, the oldest READ entries go first; unread ones only when nothing else is left', () => {
    const { capNotifications } = attentionLib;
    assert.equal(typeof capNotifications, 'function', 'attention.js has capNotifications');
    const read = (id, at) => message(id, 't', { at, read: true });
    const fresh = (id, at) => message(id, 't', { at });
    // Newest first, as the list is kept.
    const list = [fresh('n5', 5), read('r4', 4), fresh('n3', 3), read('r2', 2), fresh('n1', 1)];
    assert.equal(capNotifications(list, 5), list, 'within the cap: the same list');
    assert.deepEqual(capNotifications(list, 4).map((n) => n.id), ['n5', 'r4', 'n3', 'n1'], 'the oldest read entry goes, not the oldest');
    assert.deepEqual(capNotifications(list, 3).map((n) => n.id), ['n5', 'n3', 'n1'], 'every read one before any unread one');
    assert.deepEqual(capNotifications(list, 2).map((n) => n.id), ['n5', 'n3'], 'nothing read left: the oldest unread goes');
    // An entry with no `read` at all is not waiting for anyone.
    const legacy = [fresh('n2', 2), { id: 'old', tabId: 't', title: 'build', exitCode: 0, at: 1 }, fresh('n0', 0)];
    assert.deepEqual(capNotifications(legacy, 2).map((n) => n.id), ['n2', 'n0']);
  });

  test('AT-08: the bell\'s words name a terminal\'s bell for what it is, and commands and messages read as before', () => {
    const bell = { id: 'b1', kind: 'bell', tabId: 'a', count: 3, read: false };
    assert.deepEqual(notificationSummary([bell]), {
      label: '1 bell from a terminal',
      title: '1 bell from a terminal while you were elsewhere',
      heading: 'While you were elsewhere',
      dialog: 'Notifications',
    });
    assert.equal(
      notificationSummary([bell, { ...bell, id: 'b2' }, message('m', 'a'), command('c', 'a')]).label,
      '1 finished command, 1 message from a program and 2 bells from terminals'
    );
    assert.equal(notificationSummary([message('m', 'a'), command('c', 'a')]).label, '1 finished command and 1 message from a program');
    assert.equal(notificationSummary([command('c', 'a'), command('d', 'a')]).dialog, 'Finished commands');
  });
});

// ---- The store, arranged by hand -------------------------------------------------

const tab = (id) => ({ id, sessionId: `sess-${id}`, title: `Terminal ${id}`, defaultTitle: `Terminal ${id}` });
// Group 1 is on screen, split: pane 1 shows `a` (the active tab) over `b`,
// pane 2 shows `c`. Group 2 holds `d`.
const GROUPS = () => [
  {
    id: 'group-1',
    name: 'Group 1',
    createdAt: 0,
    tree: {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'pane-1', tabIds: ['a', 'b'], activeTabId: 'a' },
        { type: 'leaf', id: 'pane-2', tabIds: ['c'], activeTabId: 'c' },
      ],
    },
    activePaneId: 'pane-1',
  },
  { id: 'group-2', name: 'Group 2', createdAt: 0, tree: { type: 'leaf', id: 'pane-3', tabIds: ['d'], activeTabId: 'd' }, activePaneId: 'pane-3' },
];
/**
 * A stand-in for an element of the page: the selectors it or an ancestor of
 * it matches (`within`), how many boxes it draws, its computed style.
 */
const fakeEl = ({ within = [], rects = 1, visibility = 'visible', display = 'block', connected = true } = {}) => ({
  isConnected: connected,
  closest: (selector) => (selector.split(',').some((part) => within.includes(part.trim())) ? {} : null),
  getClientRects: () => ({ length: rects }),
  computed: { visibility, display },
});
const fakeDoc = (elements) => ({
  querySelectorAll: () => elements,
  defaultView: { getComputedStyle: (el) => el.computed },
});

const entries = () => S.getState().notifications;
const unread = () => ({ ...unreadCountByTab(entries()) });
const done = (title = 'opencode', body = 'Session done', occasion = 'always') => ({ title, body, occasion, urgency: 1 });

let saved = null;
let focused = false;
let previousSource = null;
let previousFlashMs = null;
let previousFocus = null;
let focusedTabs = [];

function arrange() {
  // No button held over from a case before.
  S.getState().notePointer?.(false);
  if (!saved) {
    const s = S.getState();
    saved = {
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      groups: s.groups,
      activeGroupId: s.activeGroupId,
      notifications: s.notifications,
      attentionFlash: s.attentionFlash,
      progress: s.progress,
      isInitialized: s.isInitialized,
    };
  }
  focused = false;
  previousSource ??= __setAttentionSource(() => (focused ? FOCUSED : BACKGROUND));
  previousFlashMs ??= __setAttentionFlashMs(40);
  focusedTabs = [];
  previousFocus ??= __setTerminalFocus((id) => focusedTabs.push(id));
  useSettingsStore.setState({
    terminalBellAttention: true,
    terminalAttentionFlashFocused: false,
    terminalProgress: true,
  });
  // Not initialised: nothing here is worth persisting.
  S.setState({
    tabs: [],
    notifications: [],
    attentionFlash: {},
    isInitialized: false,
  });
  S.setState({
    tabs: ['a', 'b', 'c', 'd'].map(tab),
    activeTabId: 'a',
    groups: GROUPS(),
    activeGroupId: 'group-1',
  });
  mockBridge.desktopNotifications.length = 0;
}

function giveBack() {
  if (previousSource) __setAttentionSource(previousSource);
  if (previousFlashMs !== null) __setAttentionFlashMs(previousFlashMs);
  if (previousFocus) __setTerminalFocus(previousFocus);
  previousSource = null;
  previousFlashMs = null;
  previousFocus = null;
  useSettingsStore.setState({
    terminalBellAttention: SETTINGS_DEFAULTS.terminalBellAttention,
    terminalAttentionFlashFocused: SETTINGS_DEFAULTS.terminalAttentionFlashFocused,
    terminalProgress: SETTINGS_DEFAULTS.terminalProgress,
  });
}

describe('Attention: the store marks what has been seen', () => {
  beforeEach(arrange);
  afterEach(giveBack);

  test('AT-10: every new entry is unread — a program\'s message, and a bell', () => {
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    S.getState().bellFromTerminal('d', BACKGROUND, 0);
    assert.deepEqual(entries().map((n) => [n.kind, n.tabId, n.read]), [
      ['bell', 'd', false],
      ['program', 'c', false],
    ]);
    assert.deepEqual(unread(), { c: 1, d: 1 });
  });

  test('AT-11: switching to a terminal in a focused window reads it; switching while the window is elsewhere does not', () => {
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    S.getState().notifyFromProgram('d', done(), BACKGROUND);
    focused = false;
    S.getState().switchTab('c');
    assert.equal(S.getState().activeTabId, 'c');
    assert.deepEqual(unread(), { c: 1, d: 1 }, 'nobody saw that switch');
    focused = true;
    S.getState().switchTab('d');
    assert.deepEqual(unread(), { c: 1 }, 'd was seen as it was switched to');
    // Any way the active tab moves: here, a group switch.
    S.getState().setActiveGroup('group-1');
    assert.equal(S.getState().activeTabId, 'c', 'setup: group 1 shows c, the pane last used');
    assert.deepEqual(unread(), {}, 'c, on screen again in a focused window');
  });

  test('AT-12: the window coming back reads the terminal that is active; a terminal that is not stays unread', () => {
    S.getState().notifyFromProgram('a', done(), BACKGROUND);
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    assert.deepEqual(unread(), { a: 1, c: 1 }, 'the active terminal, from the background, is news too');
    S.getState().noteWindowFocused();
    assert.deepEqual(unread(), { c: 1 });
    assert.equal(entries().length, 2, 'read, not gone');
  });

  test('AT-54: a switch made while a pointer button is down is read when it is let go — not before', () => {
    assert.equal(typeof S.getState().notePointer, 'function', 'the store has notePointer');
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    focused = true;
    // The press on c's chip, or on its pane, makes it the active tab.
    S.getState().notePointer(true);
    S.getState().switchTab('c');
    assert.equal(S.getState().activeTabId, 'c');
    assert.deepEqual(unread(), { c: 1 }, 'its pill stays while the button is down: nothing moves under the pointer');
    S.getState().notePointer(false);
    assert.deepEqual(unread(), {}, 'read once it is let go');
    // Without a press, as before: at once.
    S.getState().notifyFromProgram('d', done(), BACKGROUND);
    S.getState().switchTab('d');
    assert.deepEqual(unread(), {});
  });

  test('AT-55: a release that never comes is assumed after a moment; the window coming back waits for it too; one let go elsewhere reads nothing', async () => {
    const safety = storeLib.__setPointerSafetyMs(30);
    try {
      S.getState().notifyFromProgram('c', done(), BACKGROUND);
      focused = true;
      S.getState().notePointer(true);
      S.getState().switchTab('c');
      assert.deepEqual(unread(), { c: 1 });
      await wait(60);
      assert.deepEqual(unread(), {}, 'the up was lost: read all the same, a moment later');

      // The window coming to the front under a press — a click into it.
      S.getState().notifyFromProgram('c', done(), BACKGROUND);
      S.getState().notePointer(true);
      S.getState().noteWindowFocused();
      assert.deepEqual(unread(), { c: 1 });
      S.getState().notePointer(false);
      assert.deepEqual(unread(), {});

      // Let go after the window lost the focus: nobody was looking.
      S.getState().notifyFromProgram('d', done(), BACKGROUND);
      S.getState().notePointer(true);
      S.getState().switchTab('d');
      focused = false;
      S.getState().notePointer(false);
      assert.deepEqual(unread(), { d: 1 });
    } finally {
      storeLib.__setPointerSafetyMs(safety);
    }
  });

  test('AT-56: what is asked for explicitly is not held for a press — the jump, an entry clicked, Mark All Read', () => {
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    S.getState().notifyFromProgram('d', done(), BACKGROUND);
    S.getState().notifyFromProgram('b', done(), BACKGROUND);
    focused = true;
    S.getState().notePointer(true);
    try {
      assert.equal(S.getState().goToLatestUnread(), 'b');
      assert.deepEqual(unread(), { c: 1, d: 1 }, 'the jump reads at once');
      S.getState().goToNotification(entries().find((n) => n.tabId === 'd').id);
      assert.deepEqual(unread(), { c: 1 }, 'so does an entry clicked');
      S.getState().markAllNotificationsRead();
      assert.deepEqual(unread(), {});
    } finally {
      S.getState().notePointer(false);
    }
  });

  test('AT-13: typing is not an input hook — a key typed into the terminal changes nothing about what is read', () => {
    // The seen rule covers typing (to type into a terminal it must be the
    // active tab of a focused window, which it was marked read on becoming),
    // and `onData` also carries xterm's own replies, which must not clear a
    // ring. So writes to the shell are not read.
    const store = readFileSync(new URL('../../src/stores/terminalStore.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const writeRaw = store.slice(store.indexOf('    writeRaw: async (tabId, data) => {'), store.indexOf('    restartShell: async (tabId) => {'));
    assert.ok(writeRaw.length > 100, 'setup: found writeRaw');
    assert.doesNotMatch(writeRaw, /markTabRead|markRead|notifications/);
  });

  test('AT-14: marking read changes nothing when nothing was unread — not even the store', () => {
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    let changes = 0;
    const stop = S.subscribe(() => {
      changes += 1;
    });
    try {
      S.getState().markTabRead('d');
      S.getState().markTabRead('nope');
      assert.equal(changes, 0, 'no update at all');
      S.getState().markTabRead('c');
      assert.equal(changes, 1);
      S.getState().markTabRead('c');
      S.getState().markAllNotificationsRead();
      assert.equal(changes, 1);
    } finally {
      stop();
    }
  });

  test('AT-15: Mark All Read reads every terminal and keeps every entry', () => {
    S.getState().notifyFromProgram('b', done(), BACKGROUND);
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    S.getState().bellFromTerminal('d', BACKGROUND, 0);
    S.getState().markAllNotificationsRead();
    assert.deepEqual(unread(), {});
    assert.equal(entries().length, 3);
    assert.ok(entries().every((n) => n.read === true));
  });
});

describe('Attention: a note read from output kept before the terminal was shown', () => {
  beforeEach(arrange);
  afterEach(giveBack);

  test('AT-17: keeps the time it was printed — in the list and for the jump — and goes nowhere but the list', async () => {
    const hourAgo = Date.now() - 3_600_000;
    S.getState().notifyFromProgram('d', done('now', 'a real one'), BACKGROUND);
    const route = S.getState().notifyFromProgram('c', done('old', 'Permission needed'), BACKGROUND, { keptAt: hourAgo });
    assert.deepEqual(route, { inApp: true, desktop: false }, 'never the desktop, even with the window in the background');
    assert.deepEqual(entries().map((n) => n.title), ['now', 'old'], 'newest first, by when it was printed');
    assert.equal(entries()[1].at, hourAgo);
    assert.equal(entries()[1].read, false, 'still news: a question asked then may still be waiting');
    // Another one from history, printed in between, goes in between.
    S.getState().notifyFromProgram('b', done('mid'), BACKGROUND, { keptAt: hourAgo + 60_000 });
    assert.deepEqual(entries().map((n) => n.title), ['now', 'mid', 'old']);
    // What happens now goes above all of it: a bell, a finished command.
    S.getState().bellFromTerminal('b', BACKGROUND, 0);
    assert.equal(entries()[0].kind, 'bell');
    assert.deepEqual(entries().map((n) => n.at), [...entries().map((n) => n.at)].sort((x, y) => y - x), 'the list is in time order');
    // The jump takes the newest by time, not the one shown last.
    assert.equal(S.getState().goToLatestUnread(), 'b');
    assert.equal(S.getState().goToLatestUnread(), 'd');
    assert.equal(S.getState().goToLatestUnread(), 'c', 'the old question last');
    await wait(5);
    assert.deepEqual(mockBridge.desktopNotifications.map((n) => n.title), ['now'], 'only the live one reached the desktop');
  });

  test('AT-18: at the terminal being typed into, nothing — no entry, and no flash however the setting is', () => {
    useSettingsStore.setState({ terminalAttentionFlashFocused: true });
    assert.deepEqual(S.getState().notifyFromProgram('a', done(), FOCUSED, { keptAt: Date.now() - 1000 }), { inApp: false, desktop: false });
    assert.deepEqual(entries(), []);
    assert.deepEqual(S.getState().attentionFlash, {}, 'an old note is no reason to flash');
    // A live one does flash, as before.
    S.getState().notifyFromProgram('a', done(), FOCUSED);
    assert.ok(S.getState().attentionFlash.a > 0);
  });

  test('AT-19: kitty\'s occasions described a moment nobody could see the terminal — so a note from then is listed', () => {
    // `invisible`: c is on screen now, which live would say nothing about.
    assert.deepEqual(S.getState().notifyFromProgram('c', done('t', 'b', 'invisible'), FOCUSED), { inApp: false, desktop: false }, 'live: nothing');
    assert.deepEqual(S.getState().notifyFromProgram('c', done('t', 'b', 'invisible'), FOCUSED, { keptAt: Date.now() - 5000 }), { inApp: true, desktop: false });
    assert.deepEqual(S.getState().notifyFromProgram('c', done('t', 'b', 'unfocused'), FOCUSED, { keptAt: Date.now() - 5000 }), { inApp: true, desktop: false });
    assert.equal(entries().length, 2);
  });
});

describe('Attention: the cap keeps what is waiting', () => {
  beforeEach(arrange);
  afterEach(giveBack);

  test('AT-16: a new bell or message at the cap pushes out a read entry, never the one terminal still waiting', () => {
    // 49 read entries from b, newer than c's unread one, which is the oldest
    // in the list.
    const readOnes = Array.from({ length: 49 }, (_, i) => message(`r${i}`, 'b', { at: 100 + i, read: true })).reverse();
    S.setState({ notifications: [...readOnes, message('waiting', 'c', { at: 1 })] });
    S.getState().bellFromTerminal('d', BACKGROUND, 0);
    assert.equal(entries().length, 50);
    assert.ok(entries().some((n) => n.id === 'waiting'), 'c is still waiting');
    assert.ok(!entries().some((n) => n.id === 'r0'), 'the oldest read entry went');
    assert.deepEqual(unread(), { c: 1, d: 1 });
    S.getState().notifyFromProgram('d', done(), BACKGROUND);
    assert.equal(entries().length, 50);
    assert.ok(entries().some((n) => n.id === 'waiting'));
    assert.ok(!entries().some((n) => n.id === 'r1'));
    assert.deepEqual(unread(), { c: 1, d: 2 });
  });
});

describe('Attention: Go to Latest Unread Notification', () => {
  beforeEach(arrange);
  afterEach(giveBack);

  test('AT-20: goes to the newest unread terminal — its group, its pane — gives it the keyboard, and reads it', async () => {
    S.getState().notifyFromProgram('b', done(), BACKGROUND);
    await wait(2);
    S.getState().notifyFromProgram('d', done(), BACKGROUND);
    assert.equal(S.getState().goToLatestUnread(), 'd');
    assert.equal(S.getState().activeGroupId, 'group-2', 'its group came on screen');
    assert.equal(S.getState().activeTabId, 'd');
    assert.deepEqual(unread(), { b: 1 }, 'd is read — even though the window is in the background');
    await wait(5);
    assert.deepEqual(focusedTabs, ['d'], 'and has the keyboard, once its pane is drawn');

    assert.equal(S.getState().goToLatestUnread(), 'b');
    const group1 = S.getState().groups.find((g) => g.id === 'group-1');
    assert.equal(group1.activePaneId, 'pane-1');
    assert.equal(group1.tree.children[0].activeTabId, 'b', 'shown in its pane');
    assert.deepEqual(unread(), {});
    assert.equal(entries().length, 2, 'the entries stay, read');
  });

  test('AT-21: with nothing unread it does nothing at all', async () => {
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    S.getState().markAllNotificationsRead();
    const shown = useSettingsStore.getState().panelVisible;
    useSettingsStore.setState({ panelVisible: false });
    try {
      const before = S.getState();
      assert.equal(S.getState().goToLatestUnread(), null);
      assert.equal(S.getState(), before, 'not a single update');
      assert.equal(useSettingsStore.getState().panelVisible, false, 'and the panel left as it was');
      await wait(5);
      assert.deepEqual(focusedTabs, []);
    } finally {
      useSettingsStore.setState({ panelVisible: shown });
    }
  });

  test('AT-26: the Terminal view dragged into a side bar that shows something else is brought forward there', async () => {
    const layout = useSettingsStore.getState();
    const saved = {
      viewLocations: layout.viewLocations,
      chosenViews: layout.chosenViews,
      sidebarVisible: layout.sidebarVisible,
      panelVisible: layout.panelVisible,
      requestedView: layout.requestedView,
    };
    try {
      useSettingsStore.setState({
        viewLocations: { ...layout.viewLocations, terminal: 'left' },
        chosenViews: { left: 'explorer' },
        sidebarVisible: true,
        panelVisible: false,
      });
      assert.equal(isViewShown(useSettingsStore.getState(), 'terminal'), false, 'setup: the Explorer is showing');
      S.getState().notifyFromProgram('c', done(), BACKGROUND);
      assert.equal(S.getState().goToLatestUnread(), 'c');
      assert.equal(isViewShown(useSettingsStore.getState(), 'terminal'), true, 'the Terminal view is on screen');
      assert.deepEqual(unread(), {});
      await wait(5);
      assert.deepEqual(focusedTabs, ['c']);
    } finally {
      useSettingsStore.setState(saved);
    }
  });

  test('AT-27: a terminal that cannot be brought on screen is not read — nor gone to', async () => {
    const layout = useSettingsStore.getState();
    const saved = { viewLocations: layout.viewLocations, chosenViews: layout.chosenViews };
    try {
      // The Terminal view in no region at all: nothing can show it.
      const { terminal: _gone, ...rest } = layout.viewLocations;
      useSettingsStore.setState({ viewLocations: rest });
      S.getState().notifyFromProgram('c', done(), BACKGROUND);
      focused = true;
      assert.equal(S.getState().goToLatestUnread(), null);
      assert.equal(S.getState().goToNotification(entries()[0].id), false);
      assert.deepEqual(unread(), { c: 1 }, 'still waiting');
      assert.equal(S.getState().activeTabId, 'a', 'and the active terminal is the one it was');
      await wait(5);
      assert.deepEqual(focusedTabs, []);
    } finally {
      useSettingsStore.setState(saved);
    }
  });

  test('AT-28: a terminal in no pane — being closed, or not placed yet — is not gone to, nor read', async () => {
    // `e` is a tab with a shell, but in no group: spawned and not yet placed,
    // or taken out of its pane on the way to being killed.
    S.setState((s) => ({ tabs: [...s.tabs, tab('e')] }));
    S.getState().notifyFromProgram('c', done('older'), BACKGROUND);
    S.setState({ notifications: [message('unplaced', 'e', { at: Date.now() + 1000 }), ...entries()] });
    focused = true;
    assert.equal(S.getState().goToNotification('unplaced'), false);
    assert.equal(S.getState().activeTabId, 'a', 'not switched to');
    assert.equal(S.getState().goToLatestUnread(), 'c', 'the newest terminal that can be shown');
    assert.deepEqual(unread(), { e: 1 }, 'and e is still waiting');
    await wait(5);
    assert.deepEqual(focusedTabs, ['c']);
  });

  test('AT-29: read only once the terminal really is on screen after the switch', async () => {
    S.getState().notifyFromProgram('b', done(), BACKGROUND);
    const realSwitch = S.getState().switchTab;
    S.setState({ switchTab: () => {} }); // a switch that, for whatever reason, did not happen
    try {
      focused = true;
      assert.equal(S.getState().goToLatestUnread(), null);
      assert.deepEqual(unread(), { b: 1 }, 'b is behind a in its pane — not seen');
      await wait(5);
      assert.deepEqual(focusedTabs, []);
    } finally {
      S.setState({ switchTab: realSwitch });
    }
  });

  test('AT-29b: read only if the terminal gone to ends up the active one', () => {
    // c is on screen beside a; something kept the keyboard where it was —
    // a menu that took it back.
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    const realSwitch = S.getState().switchTab;
    S.setState({ switchTab: () => {} });
    try {
      focused = true;
      assert.equal(S.getState().goToLatestUnread(), null);
      assert.deepEqual(unread(), { c: 1 });
    } finally {
      S.setState({ switchTab: realSwitch });
    }
  });

  test('AT-25: a hidden terminal panel is shown — there is no pane to go to, nor a keyboard to give, without it', () => {
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    const shown = useSettingsStore.getState().panelVisible;
    useSettingsStore.setState({ panelVisible: false });
    try {
      assert.equal(S.getState().goToLatestUnread(), 'c');
      assert.equal(useSettingsStore.getState().panelVisible, true);
    } finally {
      useSettingsStore.setState({ panelVisible: shown });
    }
  });

  test('AT-22: an entry whose terminal has gone is skipped', () => {
    S.getState().notifyFromProgram('c', done(), BACKGROUND);
    // An entry left behind for a terminal that is not there — put straight
    // into the list, as the pruning would have taken it out with the tab.
    S.setState({ notifications: [message('ghost', 'gone', { at: Date.now() + 1000 }), ...entries()] });
    assert.equal(S.getState().goToLatestUnread(), 'c');
    assert.equal(S.getState().goToLatestUnread(), null, 'and nothing to go to after that');
    assert.equal(S.getState().goToNotification('ghost'), false);
  });

  test('AT-23: a terminal hidden by a zoom is shown — the zoom ends', () => {
    S.setState((s) => ({
      groups: s.groups.map((g) => (g.id === 'group-1' ? { ...g, activePaneId: 'pane-2', zoomedPaneId: 'pane-2' } : g)),
      activeTabId: 'c',
    }));
    S.getState().notifyFromProgram('b', done(), BACKGROUND);
    assert.equal(S.getState().goToLatestUnread(), 'b');
    const group1 = S.getState().groups.find((g) => g.id === 'group-1');
    assert.equal('zoomedPaneId' in group1, false, 'unzoomed, so b can be seen');
    assert.equal(group1.activePaneId, 'pane-1');
  });

  test('AT-24: clicking an entry goes to its terminal and reads that terminal; the find bar keeps the caret', async () => {
    S.getState().notifyFromProgram('c', done('one'), BACKGROUND);
    S.getState().notifyFromProgram('c', done('two'), BACKGROUND);
    S.getState().notifyFromProgram('d', done('three'), BACKGROUND);
    const older = entries().find((n) => n.title === 'one');
    S.setState({ find: { ...S.getState().find, open: true, tabId: 'c' } });
    try {
      assert.equal(S.getState().goToNotification(older.id), true);
      assert.equal(S.getState().activeTabId, 'c');
      assert.deepEqual(unread(), { d: 1 }, 'both of c\'s entries');
      await wait(5);
      assert.deepEqual(focusedTabs, [], 'the find bar open on c keeps the keyboard');
    } finally {
      S.setState({ find: { ...S.getState().find, open: false, tabId: null } });
    }
    assert.equal(S.getState().goToNotification('no-such-entry'), false);
  });
});

describe('Attention: the terminal bell', () => {
  beforeEach(arrange);
  afterEach(giveBack);

  test('AT-30: routed like an `always` notification — the bell list unless it is the terminal being typed into — never the desktop', async () => {
    assert.deepEqual(S.getState().bellFromTerminal('a', FOCUSED, 0), { inApp: false, flash: false }, 'typing into it');
    assert.deepEqual(S.getState().bellFromTerminal('c', FOCUSED, 0), { inApp: true, flash: false }, 'on screen, not typed into');
    assert.deepEqual(S.getState().bellFromTerminal('d', FOCUSED, 0), { inApp: true, flash: false });
    assert.deepEqual(S.getState().bellFromTerminal('a', BACKGROUND, 0), { inApp: true, flash: false }, 'the window is elsewhere');
    await wait(5);
    assert.deepEqual(entries().map((n) => n.tabId), ['a', 'd', 'c']);
    assert.ok(entries().every((n) => n.kind === 'bell' && n.title === `Terminal ${n.tabId}` && n.count === 1));
    assert.deepEqual(mockBridge.desktopNotifications, [], 'nothing on the desktop, ever');
    assert.equal(S.getState().bellFromTerminal('gone', BACKGROUND, 0), null);
  });

  test('AT-31: a ringing terminal costs one entry — written no more often than the rate limit lets through', () => {
    // The rings the limit refuses are counted, and added later in one go
    // (AT-37); what is written as they come is this.
    const r = (now) => S.getState().bellFromTerminal('c', BACKGROUND, now);
    assert.equal(r(0).inApp, true);
    assert.equal(r(RATE_LIMIT.intervalMs - 1).inApp, false, 'too soon: not written now');
    assert.equal(r(RATE_LIMIT.intervalMs).inApp, true);
    assert.equal(entries().length, 1, 'one row');
    assert.equal(entries()[0].count, 2);
    // Ten a minute at most, whatever the spacing.
    for (let i = 2; i < 30; i += 1) r(i * RATE_LIMIT.intervalMs);
    assert.equal(entries()[0].count, RATE_LIMIT.perMinute);
    // Another terminal has its own allowance.
    assert.equal(S.getState().bellFromTerminal('d', BACKGROUND, 5 * RATE_LIMIT.intervalMs).inApp, true);
    assert.deepEqual(entries().map((n) => [n.tabId, n.count]), [['d', 1], ['c', RATE_LIMIT.perMinute]]);
  });

  test('AT-32: read, the next ring is a new entry; turned off, the bell is ignored', () => {
    S.getState().bellFromTerminal('c', BACKGROUND, 0);
    S.getState().markTabRead('c');
    S.getState().bellFromTerminal('c', BACKGROUND, 10_000);
    assert.deepEqual(entries().map((n) => [n.count, n.read]), [[1, false], [1, true]]);
    useSettingsStore.setState({ terminalBellAttention: false });
    assert.deepEqual(S.getState().bellFromTerminal('d', BACKGROUND, 20_000), { inApp: false, flash: false });
    assert.equal(entries().length, 2);
  });

  test('AT-33: with the flash setting on, a bell or an `always` message at the terminal being typed into flashes it — once, briefly — and records nothing', async () => {
    useSettingsStore.setState({ terminalAttentionFlashFocused: true });
    const flashMs = __setAttentionFlashMs(60);
    try {
      assert.deepEqual(S.getState().bellFromTerminal('a', FOCUSED, 0), { inApp: false, flash: true });
      const first = S.getState().attentionFlash.a;
      assert.ok(first > 0, 'a is flashing');
      assert.deepEqual(entries(), [], 'nothing recorded');
      // Half way through, a message aimed at it flashes it again, under a new
      // number, so the ring restarts.
      await wait(30);
      S.getState().notifyFromProgram('a', done(), FOCUSED);
      const second = S.getState().attentionFlash.a;
      assert.ok(second > first);
      assert.deepEqual(entries(), []);
      // Past the end of the first flash, short of the second's.
      await wait(45);
      assert.equal(S.getState().attentionFlash.a, second, 'the first flash\'s timer ends nothing');
      assert.equal(__attentionKept().flashTimers, 1, 'and the second\'s is still known, to be cancelled with its tab');
      await wait(45);
      assert.deepEqual(S.getState().attentionFlash, {}, 'over');
      assert.equal(__attentionKept().flashTimers, 0);
    } finally {
      __setAttentionFlashMs(flashMs);
    }

    // Not for a program that asked to be heard only while nobody looks.
    S.getState().notifyFromProgram('a', done('t', 'b', 'unfocused'), FOCUSED);
    S.getState().notifyFromProgram('a', done('t', 'b', 'invisible'), FOCUSED);
    assert.deepEqual(S.getState().attentionFlash, {});
    // Not for a terminal that is not being typed into: that one gets an entry.
    S.getState().notifyFromProgram('c', done(), FOCUSED);
    assert.deepEqual(S.getState().attentionFlash, {});
    assert.equal(entries().length, 1);
  });

  test('AT-36: flashes at the terminal being typed into do not use up the bell allowance of that terminal', () => {
    useSettingsStore.setState({ terminalAttentionFlashFocused: true });
    // Typing in a: the shell rings at every failed completion.
    const flashes = [];
    for (let t = 0; t <= 18_000; t += 2_000) flashes.push(S.getState().bellFromTerminal('a', FOCUSED, t).flash);
    assert.ok(flashes.every(Boolean), 'each one flashes');
    // The user moves on to c; the build in a finishes and rings.
    focused = true;
    S.getState().switchTab('c');
    assert.deepEqual(S.getState().bellFromTerminal('a', FOCUSED, 25_000), { inApp: true, flash: false }, 'heard');
    assert.equal(entries().length, 1);
    // Flashes have an allowance of their own: a storm is one flash.
    S.getState().switchTab('a');
    let storm = 0;
    for (let i = 0; i < 200; i += 1) if (S.getState().bellFromTerminal('a', FOCUSED, 60_000 + i).flash) storm += 1;
    assert.equal(storm, 1, 'two hundred BELs in a fifth of a second flash once');
  });

  test('AT-37: rings past the rate limit still count while the entry is unread — folded in by one trailing update', async () => {
    assert.equal(typeof storeLib.__setBellFoldMs, 'function', 'the store has __setBellFoldMs');
    const foldMs = storeLib.__setBellFoldMs(40);
    try {
      // Five rings 200 ms apart, and one more a few seconds on.
      for (const t of [0, 200, 400, 600, 800]) S.getState().bellFromTerminal('c', BACKGROUND, t);
      assert.equal(entries()[0].count, 1, 'the refused ones are not written one by one');
      S.getState().bellFromTerminal('c', BACKGROUND, 3000);
      await wait(90);
      assert.equal(entries().length, 1);
      assert.equal(entries()[0].count, 6, 'every ring');
      assert.equal(bellText(entries()[0].count), 'Bell \u{00d7}6');
      assert.equal(storeLib.__attentionKept().bellFolds, 0, 'nothing left waiting');
    } finally {
      storeLib.__setBellFoldMs(foldMs);
    }
  });

  test('AT-38: a BEL flood costs a handful of store writes, and every ring is counted', async () => {
    const foldMs = storeLib.__setBellFoldMs(40);
    let writes = 0;
    const stop = S.subscribe((s, p) => {
      if (s.notifications !== p.notifications) writes += 1;
    });
    try {
      for (let i = 0; i < 100_000; i += 1) S.getState().bellFromTerminal('c', BACKGROUND, i / 100);
      await wait(90);
      assert.ok(writes <= 3, `${writes} store writes for 100k BELs`);
      assert.equal(entries()[0].count, 100_000);
    } finally {
      stop();
      storeLib.__setBellFoldMs(foldMs);
    }
  });

  test('AT-39: rings counted for an entry since read are added to it where it is; dismissed or gone, they are dropped with their timer', async () => {
    const foldMs = storeLib.__setBellFoldMs(40);
    try {
      S.getState().bellFromTerminal('c', BACKGROUND, 0);
      S.getState().notifyFromProgram('d', done('newer'), BACKGROUND);
      await wait(3);
      S.getState().bellFromTerminal('c', BACKGROUND, 100); // refused: counted, later than d's entry
      S.getState().markTabRead('c');
      await wait(90);
      assert.deepEqual(entries().map((n) => [n.tabId, n.count ?? null, n.read]), [['d', null, false], ['c', 2, true]], 'counted, still read, not moved');

      // Rings counted for an entry that was read and replaced by a new one
      // stay with the old one; the new one counts its own.
      S.getState().dismissNotification(entries().find((n) => n.tabId === 'd').id);
      S.getState().bellFromTerminal('c', BACKGROUND, 5_000); // a new entry: the old one is read
      const second = entries().find((n) => n.kind === 'bell' && n.read === false);
      S.getState().bellFromTerminal('c', BACKGROUND, 5_100); // refused: counted for the second
      S.getState().markTabRead('c');
      S.getState().bellFromTerminal('c', BACKGROUND, 8_000); // a third entry
      const third = entries().find((n) => n.kind === 'bell' && n.read === false);
      S.getState().bellFromTerminal('c', BACKGROUND, 8_100); // refused: counted for the third
      S.getState().bellFromTerminal('c', BACKGROUND, 8_200); // and again
      await wait(90);
      const countOf = (id) => entries().find((n) => n.id === id).count;
      assert.equal(countOf(second.id), 2, 'the second entry: its ring and the one refused');
      assert.equal(countOf(third.id), 3, 'the third: its own three');
      S.getState().dismissNotification(second.id);
      S.getState().dismissNotification(third.id);

      // Dismissed while rings wait to be folded in: they go with it.
      S.getState().bellFromTerminal('c', BACKGROUND, 20_000); // a new entry: the old one is read
      S.getState().bellFromTerminal('c', BACKGROUND, 20_100); // refused: counted
      const fresh = entries().find((n) => n.kind === 'bell' && n.read === false);
      S.getState().dismissNotification(fresh.id);
      await wait(90);
      assert.ok(!entries().some((n) => n.id === fresh.id));

      // A tab that goes takes its waiting rings and their timer along.
      S.getState().bellFromTerminal('d', BACKGROUND, 0);
      S.getState().bellFromTerminal('d', BACKGROUND, 100);
      assert.equal(storeLib.__attentionKept().bellFolds, 1);
      S.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== 'd') }));
      assert.equal(storeLib.__attentionKept().bellFolds, 0);
      await wait(90);
      assert.ok(!entries().some((n) => n.tabId === 'd'));
    } finally {
      storeLib.__setBellFoldMs(foldMs);
    }
  });

  test('AT-51: a ring refused right after its entry was read is not lost — it is the next entry, once the limit allows', async () => {
    assert.equal(typeof storeLib.__setBellClock, 'function', 'the store has __setBellClock');
    let now = 0;
    const clock = storeLib.__setBellClock(() => now);
    const foldMs = storeLib.__setBellFoldMs(30);
    try {
      S.getState().bellFromTerminal('c', BACKGROUND);
      S.getState().markTabRead('c');
      now = 500;
      S.getState().bellFromTerminal('c', BACKGROUND); // refused, and nothing unread to add it to
      assert.equal(entries().length, 1, 'not written as it came');
      now = 2_600;
      await wait(60);
      const waiting = entries().filter((n) => n.kind === 'bell' && n.read === false);
      assert.equal(waiting.length, 1, 'held, then listed');
      assert.equal(waiting[0].count, 1);
      assert.equal(storeLib.__attentionKept().bellFolds, 0);
    } finally {
      storeLib.__setBellClock(clock);
      storeLib.__setBellFoldMs(foldMs);
    }
  });

  test('AT-52: past the ten-a-minute allowance, rings wait for the next allowed moment, all of them', async () => {
    let now = 0;
    const clock = storeLib.__setBellClock(() => now);
    const foldMs = storeLib.__setBellFoldMs(30);
    try {
      for (let t = 0; t <= 18_000; t += 2_000) {
        now = t;
        S.getState().bellFromTerminal('c', BACKGROUND);
      }
      assert.equal(entries()[0].count, RATE_LIMIT.perMinute, 'setup: the allowance used up');
      S.getState().markTabRead('c');
      now = 30_000;
      S.getState().bellFromTerminal('c', BACKGROUND);
      now = 31_000;
      S.getState().bellFromTerminal('c', BACKGROUND);
      await wait(60);
      assert.equal(entries().filter((n) => n.read === false).length, 0, 'still inside the minute: held');
      now = 60_001;
      await wait(60);
      const waiting = entries().filter((n) => n.kind === 'bell' && n.read === false);
      assert.equal(waiting.length, 1, 'out at the first moment allowed');
      assert.equal(waiting[0].count, 2);
    } finally {
      storeLib.__setBellClock(clock);
      storeLib.__setBellFoldMs(foldMs);
    }
  });

  test('AT-53: a flood with nothing unread is still a write or two — and a terminal being typed into by then gets nothing', async () => {
    let now = 0;
    const clock = storeLib.__setBellClock(() => now);
    const foldMs = storeLib.__setBellFoldMs(30);
    let writes = 0;
    const stop = S.subscribe((s, p) => {
      if (s.notifications !== p.notifications) writes += 1;
    });
    try {
      S.getState().bellFromTerminal('c', BACKGROUND);
      S.getState().markTabRead('c');
      writes = 0;
      for (let i = 0; i < 100_000; i += 1) {
        now = 500 + i / 1000;
        S.getState().bellFromTerminal('c', BACKGROUND);
      }
      now = 2_600;
      await wait(60);
      assert.ok(writes <= 2, `${writes} store writes for 100k BELs`);
      assert.equal(entries().find((n) => n.read === false)?.count, 100_000);

      // Held while c was elsewhere; by the time they could be listed, c is
      // the terminal being typed into, which needs no entry.
      S.getState().markTabRead('c');
      now = 5_000;
      S.getState().bellFromTerminal('c', BACKGROUND); // a new entry…
      S.getState().markTabRead('c'); // …read at once
      now = 5_100;
      S.getState().bellFromTerminal('c', BACKGROUND); // refused, nothing unread: held
      focused = true;
      S.getState().switchTab('c');
      now = 8_000;
      await wait(60);
      assert.deepEqual(unread(), {}, 'nothing for the terminal being typed into');
      assert.equal(storeLib.__attentionKept().bellFolds, 0);
    } finally {
      stop();
      storeLib.__setBellClock(clock);
      storeLib.__setBellFoldMs(foldMs);
    }
  });

  test('AT-34: with the flash setting off (the default), the terminal being typed into gets nothing at all', () => {
    assert.equal(SETTINGS_DEFAULTS.terminalAttentionFlashFocused, false);
    S.getState().bellFromTerminal('a', FOCUSED, 0);
    S.getState().notifyFromProgram('a', done(), FOCUSED);
    assert.deepEqual(S.getState().attentionFlash, {});
    assert.deepEqual(entries(), []);
  });

  test('AT-35: every terminal hands its bell to the store, and a store that throws never reaches xterm\'s parser', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    const start = create.indexOf('const bellDisposable = term.onBell(');
    const end = create.indexOf('});', start) + 3;
    assert.ok(start > 0 && end > start, 'getOrCreateTerminal listens on every terminal');
    assert.ok(start < create.indexOf('term.open(container);'), 'from the first byte');
    assert.match(create.slice(create.indexOf('entry = {')), /^\s+bellDisposable,$/m, 'kept on the entry');
    const dispose = src.slice(src.indexOf('export function disposeTerminal('));
    assert.match(dispose, /entry\.bellDisposable\?\.dispose\(\);/, 'and let go with the terminal');

    let listener = null;
    const term = { onBell: (fn) => { listener = fn; return { dispose() {} }; } };
    const calls = [];
    const history = { reading: false };
    const run = new Function('term', 'tabId', 'useTerminalStore', 'history', `${create.slice(start, end)}\nreturn bellDisposable;`);
    let store = { getState: () => ({ bellFromTerminal: (...args) => calls.push(args) }) };
    const disposable = run(term, 'tab-term-4', { getState: () => store.getState() }, history);
    assert.equal(typeof disposable.dispose, 'function');
    listener();
    assert.deepEqual(calls, [['tab-term-4']], 'for its own tab, the store deciding the rest');
    // A BEL in output kept from before the terminal was shown rang long ago.
    history.reading = true;
    listener();
    assert.deepEqual(calls, [['tab-term-4']], 'not from the kept output');
    history.reading = false;
    store = { getState: () => ({ bellFromTerminal: () => { throw new Error('store gone'); } }) };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.doesNotThrow(() => listener());
    } finally {
      console.warn = warn;
    }
  });
});

// ---- The store, through real flows ------------------------------------------

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

function giveStorageBack() {
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

async function freshStart() {
  S.getState().dispose();
  installStorageShim();
  backing.clear();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [], notifications: [], progress: {}, attentionFlash: {} });
  await S.getState().init();
}

/** Everything the attention state keeps about `tabId`, in the store and outside it. */
function keptFor(tabId) {
  const s = S.getState();
  return {
    entries: s.notifications.filter((n) => n.tabId === tabId).length,
    progress: tabId in s.progress,
    flash: tabId in s.attentionFlash,
  };
}

/** Give `tabId` an entry, a bar and a flash, the three things kept about it. */
function makeNoise(tabId) {
  S.getState().notifyFromProgram(tabId, done(), BACKGROUND);
  S.getState().setTabProgress(tabId, { state: 'normal', value: 10 });
  S.getState().setTabProgress(tabId, { state: 'normal', value: 20 }); // held
  S.getState().bellFromTerminal(tabId, BACKGROUND, 0);
  // A flash is for the terminal being typed into; this puts one on `tabId`
  // whichever it is, as the store's own flash would.
  S.setState((s) => ({ attentionFlash: { ...s.attentionFlash, [tabId]: 1 } }));
  assert.deepEqual(keptFor(tabId), { entries: 2, progress: true, flash: true }, `setup: ${tabId} has all three`);
}

const NOTHING = { entries: 0, progress: false, flash: false };

describe('Attention: what a terminal leaves behind goes with it', () => {
  beforeEach(async () => {
    arrange();
    await freshStart();
  });
  afterEach(() => {
    S.getState().dispose();
    giveStorageBack();
    giveBack();
  });

  test('AT-40: closing a tab', async () => {
    const [a] = S.getState().tabs.map((t) => t.id);
    const b = (await S.getState().createTab()).id;
    makeNoise(a);
    makeNoise(b);
    const kept = __attentionKept();
    await S.getState().closeTab(b);
    assert.deepEqual(keptFor(b), NOTHING);
    assert.deepEqual(keptFor(a), { entries: 2, progress: true, flash: true }, 'the other terminal keeps its own');
    assert.equal(__attentionKept().progressThrottles, kept.progressThrottles - 1, 'its pacing');
    assert.equal(__attentionKept().bellLimiters, kept.bellLimiters - 1, 'and its bell\'s allowance');
    await wait(150);
    assert.deepEqual(keptFor(b), NOTHING, 'and nothing held back brings it back');
  });

  test('AT-41: closing a pane', async () => {
    const left = S.getState().getActivePaneId();
    const right = await S.getState().splitActivePane('horizontal');
    const inRight = S.getState().groups[0].tree.children.find((p) => p.id === right).tabIds[0];
    makeNoise(inRight);
    await S.getState().closePane(right);
    assert.ok(!S.getState().tabs.some((t) => t.id === inRight), 'setup: its terminal went');
    assert.deepEqual(keptFor(inRight), NOTHING);
    assert.equal(S.getState().getActivePaneId(), left);
  });

  test('AT-42: closing a group', async () => {
    const group = await S.getState().createGroup({});
    const inGroup = group.tree.tabIds[0];
    makeNoise(inGroup);
    await S.getState().closeGroup(group.id);
    assert.deepEqual(keptFor(inGroup), NOTHING);
  });

  test('AT-43: loading a workspace over the session', async () => {
    const entry = S.getState().saveWorkspace('Desk');
    const before = S.getState().tabs.map((t) => t.id);
    for (const id of before) makeNoise(id);
    await S.getState().loadWorkspace(entry.id, { mode: 'replace' });
    const after = S.getState().tabs.map((t) => t.id);
    assert.ok(before.every((id) => !after.includes(id)), 'setup: every terminal was replaced');
    for (const id of before) assert.deepEqual(keptFor(id), NOTHING, id);
    assert.deepEqual(S.getState().notifications, []);
    assert.deepEqual(S.getState().progress, {});
  });

  test('AT-44: a command that finished while you were elsewhere is an unread entry', async () => {
    const [a] = S.getState().tabs.map((t) => t.id);
    const b = (await S.getState().createTab()).id;
    S.getState().switchTab(a);
    const sessionOf = (id) => S.getState().tabs.find((t) => t.id === id).sessionId;
    // A message from b's output kept from an hour ago, filed under then.
    S.getState().notifyFromProgram(b, done('old'), BACKGROUND, { keptAt: Date.now() - 3_600_000 });
    S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === b ? { ...t, running: true, runStartedAt: Date.now() - 60_000 } : t)) }));
    await mockBridge.emit('pty-command-done', { session_id: sessionOf(b), exit_code: 1 });
    const note = S.getState().notifications.find((n) => n.tabId === b && n.kind !== 'program');
    assert.ok(note, 'setup: the finished command is in the bell');
    assert.equal(note.read, false);
    assert.equal(hasUnreadFailure(S.getState().notifications), true, 'and, unread and failed, the bell is red');
    assert.equal(S.getState().notifications[0], note, 'above the older message: the list stays in time order');
  });

  test('AT-45: a finished command at the cap pushes out a read entry, not an unread one', async () => {
    const [a] = S.getState().tabs.map((t) => t.id);
    const b = (await S.getState().createTab()).id;
    S.getState().switchTab(a);
    const readOnes = Array.from({ length: 49 }, (_, i) => message(`r${i}`, a, { at: 100 + i, read: true })).reverse();
    S.setState({ notifications: [...readOnes, message('waiting', a, { at: 1 })] });
    S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === b ? { ...t, running: true, runStartedAt: Date.now() - 60_000 } : t)) }));
    await mockBridge.emit('pty-command-done', { session_id: S.getState().tabs.find((t) => t.id === b).sessionId, exit_code: 0 });
    const list = S.getState().notifications;
    assert.equal(list.length, 50);
    assert.ok(list.some((n) => n.tabId === b && n.read === false), 'setup: the finished command is in');
    assert.ok(list.some((n) => n.id === 'waiting'), 'the waiting entry stays');
    assert.ok(!list.some((n) => n.id === 'r0'), 'the oldest read one went');
  });
});

describe('Attention: the window coming back', () => {
  beforeEach(arrange);
  afterEach(giveBack);

  test('AT-50: focus, and becoming visible, read the active terminal; becoming hidden does not', () => {
    const listeners = { focus: new Set(), visibilitychange: new Set() };
    const target = { addEventListener: (type, fn) => listeners[type]?.add(fn), removeEventListener: (type, fn) => listeners[type]?.delete(fn) };
    const doc = { ...target, visibilityState: 'hidden' };
    const stop = startAttention({ win: target, doc, send: () => {} });
    try {
      S.getState().notifyFromProgram('a', done(), BACKGROUND);
      for (const fn of listeners.visibilitychange) fn();
      assert.deepEqual(unread(), { a: 1 }, 'hidden is not looking');
      doc.visibilityState = 'visible';
      for (const fn of listeners.visibilitychange) fn();
      assert.deepEqual(unread(), {});
      S.getState().notifyFromProgram('a', done(), BACKGROUND);
      for (const fn of listeners.focus) fn();
      assert.deepEqual(unread(), {});
    } finally {
      stop();
    }
    assert.equal(listeners.focus.size + listeners.visibilitychange.size, 0);
  });
});

describe('Attention: the pointer', () => {
  test('AT-57: a button pressed anywhere in the window — and let go, or lost — reaches the store', () => {
    const listeners = new Map();
    const target = {
      addEventListener: (type, fn, capture) => listeners.set(type, { fn, capture }),
      removeEventListener: (type, fn) => {
        if (listeners.get(type)?.fn === fn) listeners.delete(type);
      },
    };
    const calls = [];
    const terminals = { getState: () => ({ notePointer: (pressed) => calls.push(pressed), noteWindowFocused: () => {} }), subscribe: () => () => {} };
    const stop = startAttention({ win: target, doc: { addEventListener() {}, removeEventListener() {} }, terminals, send: () => {}, taskbar: false });
    try {
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        assert.ok(listeners.has(type), `listens for ${type}`);
        assert.equal(listeners.get(type).capture, true, `${type} in the capture phase, before anything under the pointer acts on it`);
      }
      listeners.get('pointerdown').fn({ isPrimary: true });
      listeners.get('pointerup').fn({ isPrimary: true });
      listeners.get('pointerdown').fn({ isPrimary: true });
      listeners.get('pointercancel').fn({ isPrimary: true });
      listeners.get('pointerdown').fn({ isPrimary: true });
      listeners.get('blur').fn({});
      assert.deepEqual(calls, [true, false, true, false, true, false], 'the window losing focus lets go too');
    } finally {
      stop();
    }
    assert.ok(!['pointerdown', 'pointerup', 'pointercancel', 'blur'].some((type) => listeners.has(type)), 'and all are taken away');
  });
});

describe('Attention: the keyboard and the palette', () => {
  /** The keydown pressing ⌘⇧U / Ctrl+Shift+U makes. */
  const chord = (platform) => ({
    key: 'U',
    code: 'KeyU',
    shiftKey: true,
    altKey: false,
    ctrlKey: platform !== 'macos',
    metaKey: platform === 'macos',
  });
  const ctxFor = (e, platform, extra = {}) => ({ isMod: platform === 'macos' ? e.metaKey : e.ctrlKey, isInMonacoEditor: false, isCommandPaletteOpen: false, ...extra });

  test('AT-60: Go to Latest Unread Notification is ⌘⇧U / Ctrl+Shift+U, claimed over a terminal, keyboard and palette only', () => {
    assert.equal(COMMANDS['go-to-unread-notification'].title, 'Go to Latest Unread Notification');
    assert.deepEqual(keysFor('go-to-unread-notification'), ['mod+shift+u']);
    assert.equal(menuIdOf('go-to-unread-notification'), null, 'no menu item');
    assert.equal(menuIdOf('mark-notifications-read'), null);
    assert.deepEqual(keysFor('mark-notifications-read'), [], 'Mark All Read has no chord of its own');
    for (const platform of ['macos', 'windows']) {
      const calls = [];
      let prevented = false;
      let stopped = false;
      const e = { ...chord(platform), preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } };
      const fired = dispatchKeydownOverTerminal(e, ctxFor(e, platform, { goToLatestUnread: () => calls.push('go') }));
      assert.equal(fired, 'go-to-unread-notification', `${platform}: claimed over a terminal`);
      assert.deepEqual(calls, ['go']);
      assert.ok(prevented && stopped, `${platform}: and xterm never sees it`);
      // In the editor too: Monaco has nothing on this chord to step aside for.
      const inEditor = { ...chord(platform), preventDefault: () => {} };
      assert.equal(dispatchKeydown(inEditor, ctxFor(inEditor, platform, { isInMonacoEditor: true, goToLatestUnread: () => {} })), 'go-to-unread-notification');
    }
    // Ctrl+U alone is still the shell's (KB-12 holds every control byte).
    const ctrlU = { key: 'u', code: 'KeyU', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: () => assert.fail('swallowed'), stopPropagation: () => assert.fail('stopped') };
    assert.equal(dispatchKeydownOverTerminal(ctrlU, ctxFor(ctrlU, 'windows')), null);
    // Rebindable, and Mark All Read can be given a chord — which then works
    // with a terminal focused, like every chord of the bell's.
    const { bindings, problems } = resolveKeybindings({ 'mark-notifications-read': 'mod+alt+u' });
    assert.deepEqual(problems, []);
    assert.deepEqual(keysFor('mark-notifications-read', bindings), ['mod+alt+u']);
    assert.equal(COMMANDS['mark-notifications-read'].overTerminal, true);
    for (const platform of ['macos', 'windows']) {
      const marked = [];
      const e = { ...chord(platform), altKey: true, shiftKey: false, key: 'u', preventDefault: () => {}, stopPropagation: () => {} };
      const fired = dispatchKeydownOverTerminal(e, ctxFor(e, platform, { bindings, markAllNotificationsRead: () => marked.push(1) }));
      assert.equal(fired, 'mark-notifications-read', `${platform}: a bound chord is claimed over a terminal`);
      assert.deepEqual(marked, [1]);
    }
  });

  test('AT-64: over an open dialog the jump does nothing; over the command palette it closes the palette, then jumps', () => {
    for (const platform of ['macos', 'windows']) {
      // The palette open, its input focused.
      const calls = [];
      const e = { ...chord(platform), preventDefault: () => calls.push('prevented'), stopPropagation: () => {} };
      const fired = dispatchKeydown(e, ctxFor(e, platform, {
        isCommandPaletteOpen: true,
        setCommandPaletteOpen: (open) => calls.push(`palette ${open}`),
        goToLatestUnread: () => calls.push('go'),
        isDialogOpen: () => false,
      }));
      assert.equal(fired, 'go-to-unread-notification');
      assert.deepEqual(calls, ['prevented', 'palette false', 'go'], `${platform}: the palette closes first`);

      // A dialog open — Settings, a question, the bell's list: the key is left to it.
      for (const handler of [dispatchKeydown, dispatchKeydownOverTerminal]) {
        const seen = [];
        const d = { ...chord(platform), preventDefault: () => seen.push('prevented'), stopPropagation: () => seen.push('stopped') };
        const result = handler(d, ctxFor(d, platform, { isDialogOpen: () => true, goToLatestUnread: () => seen.push('go') }));
        assert.equal(result, null, `${platform}: not claimed over a dialog`);
        assert.deepEqual(seen, [], `${platform}: nothing done, nothing swallowed`);
      }
    }
  });

  test('AT-65: a dialog on screen is one the app draws as one and that can be seen — never Monaco\'s widgets, never the bell\'s list', () => {
    const { dialogOnScreen } = focusLib;
    assert.equal(dialogOnScreen(fakeDoc([fakeEl()])), true, 'Settings, a question, the startup commands');
    assert.equal(dialogOnScreen(fakeDoc([])), false);
    // Left in the page, hidden — Monaco's find widget after the first ⌘F —
    // it held the jump for the rest of the session.
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ rects: 0 })])), false, 'display: none, its own or an ancestor\'s');
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ display: 'none' })])), false);
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ visibility: 'hidden' })])), false);
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ within: ['[aria-hidden="true"]'] })])), false);
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ within: ['[inert]'] })])), false);
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ connected: false })])), false);
    // Monaco's widgets are the editor's own, not the app's modals, shown or
    // not; the bell's list closes itself when the jump moves the active tab.
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ within: ['.monaco-editor'] })])), false);
    assert.equal(dialogOnScreen(fakeDoc([fakeEl({ within: ['[data-bell-list]'] })])), false);
    assert.equal(
      dialogOnScreen(fakeDoc([fakeEl({ rects: 0 }), fakeEl({ within: ['.monaco-editor'] }), fakeEl()])),
      true,
      'one that can be seen among them is enough'
    );
    let asked = '';
    dialogOnScreen({ querySelectorAll: (selector) => ((asked = selector), []) });
    for (const part of ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]']) assert.ok(asked.includes(part), part);
    assert.equal(dialogOnScreen(undefined), false, 'no document, no dialog');
    assert.equal(dialogOnScreen({ querySelectorAll: () => { throw new Error('detached'); } }), false);
    // Every dialog the app has says it is one.
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(read('../../src/components/common/SettingsWindow.jsx'), /role="dialog"\s+aria-modal="true"/);
    assert.match(read('../../src/components/common/ConfirmDialog.jsx'), /role="alertdialog"\s+aria-modal="true"/, 'every question, the paste warning among them');
    assert.match(read('../../src/components/terminal/StartupCommandsDialog.jsx'), /role="dialog"\s+aria-modal="true"/);
    // And the keyboard asks it.
    const hook = read('../../src/hooks/useKeybindings.js').replace(/\r\n/g, '\n');
    assert.match(hook, /import \{ dialogOnScreen, menuOnScreen \} from '\.\.\/lib\/workspaceFocus\.js';/);
    assert.match(hook, /^\s+isDialogOpen: \(\) => dialogOnScreen\(\),$/m);
  });

  test('AT-66: a menu that took the keyboard holds the jump; one that opened by itself, waiting, does not', () => {
    const { menuOnScreen } = focusLib;
    assert.equal(typeof menuOnScreen, 'function', 'workspaceFocus.js has menuOnScreen');
    assert.equal(menuOnScreen(fakeDoc([fakeEl()])), true, 'a right-click menu, a menu of the menu bar');
    assert.equal(menuOnScreen(fakeDoc([fakeEl({ within: ['[data-opened-by-itself]'] })])), false, "the resume offer's list");
    assert.equal(menuOnScreen(fakeDoc([fakeEl({ visibility: 'hidden' })])), false, 'not placed yet');
    assert.equal(menuOnScreen(fakeDoc([fakeEl({ rects: 0 })])), false);
    assert.equal(menuOnScreen(fakeDoc([])), false);
    assert.equal(menuOnScreen(undefined), false);
    let asked = '';
    menuOnScreen({ querySelectorAll: (selector) => ((asked = selector), []) });
    assert.ok(asked.includes('[role="menu"]'));
    // ContextMenu says which of its menus opened by themselves.
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(read('../../src/components/common/ContextMenu.jsx'), /data-opened-by-itself=\{takeFocus \? undefined : ''\}/);
    const hook = read('../../src/hooks/useKeybindings.js');
    assert.match(hook, /^\s+isMenuOpen: \(\) => menuOnScreen\(\),$/m);
    // A menu open: the key is left to it, and nothing moves.
    for (const platform of ['macos', 'windows']) {
      for (const handler of [dispatchKeydown, dispatchKeydownOverTerminal]) {
        const seen = [];
        const e = { ...chord(platform), preventDefault: () => seen.push('prevented'), stopPropagation: () => seen.push('stopped') };
        const fired = handler(e, ctxFor(e, platform, { isMenuOpen: () => true, isDialogOpen: () => false, goToLatestUnread: () => seen.push('go') }));
        assert.equal(fired, null, `${platform}: not claimed over a menu`);
        assert.deepEqual(seen, []);
      }
    }
  });

  test('AT-61: the palette offers both, with the bound chord, and dispatches each to the store', () => {
    const rows = paletteCommands();
    const go = rows.find((c) => c.command === 'go_to_unread_notification');
    const mark = rows.find((c) => c.command === 'mark_notifications_read');
    assert.equal(go?.title, 'Go to Latest Unread Notification');
    assert.equal(mark?.title, 'Mark All Notifications Read');
    assert.equal(go.hint, shortcutLabel('go-to-unread-notification', DEFAULT_RESOLVED, { isMac }));
    assert.ok(go.hint, 'it advertises its chord');
    assert.equal(mark.hint, '', 'and Mark All Read none');
    const rebound = paletteCommands(resolveKeybindings({ 'mark-notifications-read': 'mod+alt+u' }).bindings);
    assert.ok(/U$/.test(rebound.find((c) => c.command === 'mark_notifications_read').hint), 'until one is bound');
    const found = buildPaletteGroups({ fileTree: [], query: 'unread', mode: 'all' }).find((g) => g.label === 'commands')?.items ?? [];
    assert.equal(found[0]?.command, 'go_to_unread_notification', 'typing "unread" finds it first');

    // CommandPalette.jsx is a component the suites cannot click; its dispatch
    // must name each row's command, or the row is one that does nothing.
    const palette = readFileSync(new URL('../../src/components/command/CommandPalette.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(palette, /case 'go_to_unread_notification':\n[^]*?goToLatestUnread\?\.\(\)/);
    assert.match(palette, /case 'mark_notifications_read':\n[^]*?markAllNotificationsRead\?\.\(\)/);
    assert.match(palette, /const goToLatestUnread = useTerminalStore\(\(s\) => s\.goToLatestUnread\);/);
    // And the keyboard hands both actions over.
    const hook = readFileSync(new URL('../../src/hooks/useKeybindings.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(hook, /const goToLatestUnread = useTerminalStore\(\(s\) => s\.goToLatestUnread\);/);
    assert.match(hook, /const markAllNotificationsRead = useTerminalStore\(\(s\) => s\.markAllNotificationsRead\);/);
    const ctx = hook.slice(hook.indexOf('const contextFor = (e) => ({'), hook.indexOf('});', hook.indexOf('const contextFor = (e) => ({')));
    assert.match(ctx, /^\s+goToLatestUnread,$/m);
    assert.match(ctx, /^\s+markAllNotificationsRead,$/m);
  });

  test('AT-62: the three settings, and their defaults', () => {
    assert.equal(SETTINGS_DEFAULTS.terminalAttentionFlashFocused, false);
    assert.equal(SETTINGS_DEFAULTS.terminalBellAttention, true);
    assert.equal(SETTINGS_DEFAULTS.terminalProgress, true);
  });
});

describe('Attention: focusing a terminal in the registry', () => {
  test('AT-70: the keyboard goes to a terminal on the page, and to nothing else', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('export function focusTerminalView(tabId) {');
    const end = src.indexOf('\n}\n', start) + 3;
    assert.ok(start > 0 && end > start, 'the registry has it');
    const focusTerminalView = new Function('instances', `${src.slice(start, end).replace('export ', '')}\nreturn focusTerminalView;`);
    const focused = [];
    const entry = (extra) => ({ term: { focus: () => focused.push(extra.name) }, container: { isConnected: true }, ...extra });
    const instances = new Map([
      ['on', entry({ name: 'on' })],
      ['off', entry({ name: 'off', container: { isConnected: false } })],
      ['gone', entry({ name: 'gone', disposed: true })],
    ]);
    const focus = focusTerminalView(instances);
    assert.equal(focus('on'), true);
    assert.equal(focus('off'), false, 'not in a pane');
    assert.equal(focus('gone'), false, 'disposed');
    assert.equal(focus('never'), false, 'never made');
    assert.deepEqual(focused, ['on']);
  });
});

describe('Attention: teardown', () => {
  test('AT-99: leave the store and the settings as the next suite expects them', () => {
    S.getState().dispose();
    giveStorageBack();
    giveBack();
    if (saved) S.setState(saved);
    mockBridge.desktopNotifications.length = 0;
    assert.equal(S.getState().notifications, saved?.notifications ?? S.getState().notifications);
  });
});
