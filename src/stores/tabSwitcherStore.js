/**
 * The Ctrl+Tab switcher (Bundle 2, A5-3): the terminals most recently used,
 * across every group, in an overlay (TabSwitcher.jsx) walked while the
 * chord's modifier is held, as VS Code's, Windows Terminal's and the
 * browsers' are.
 *
 * - `switch-recent-tab` (Ctrl+Tab) and `switch-recent-tab-back`
 *   (Ctrl+Shift+Tab) open it with the previous terminal selected (`step`),
 *   or the one used longest ago going back; pressed again while it is open
 *   they move the selection, wrapping at both ends. So do Up and Down.
 * - Releasing every modifier the opening chord held (`modifiers`), Enter or
 *   a click picks the selected terminal: `switchTab`, then the keyboard goes
 *   to it (`commit`). A quick press and release is therefore a straight
 *   switch to the previous terminal, in whichever group it is.
 * - Escape or the window losing focus closes it with nothing switched.
 * - With fewer than two terminals there is nothing to switch to and it does
 *   not open.
 *
 * The overlay never takes the keyboard: it stays in the terminal (or field)
 * it was in, and the keys the switcher answers are taken from it here, by
 * listeners on the window that exist only while it is open.
 *
 * The list itself is memory only (tabMru.js): nothing is saved.
 */
import { create } from 'zustand';
import { useTerminalStore } from './terminalStore.js';
import { focusActivePane } from '../lib/workspaceFocus.js';
import { createTabMru, switcherOrder } from '../lib/tabMru.js';

// --- the most-recently-used list ---------------------------------------------

const mru = createTabMru();
let mruSubscription = null;

/** What a start that found the list already followed returns: it subscribed nothing, so it stops nothing. */
const NOT_STARTED_HERE = () => {};

/**
 * Follow the terminal store: the active terminal goes to the front of the
 * list, a closed one leaves it — and leaves an open switcher too. Once, like
 * terminalRegistry's `ensureFocusSubscriptionStarted`: App starts it, and
 * the switcher's first use does when App has not (the suites).
 *
 * Returns how to stop following, which App's effect hands back as its
 * cleanup, so an unmount or a hot reload leaves no subscription behind. A
 * call while it is followed already subscribes nothing a second time, and
 * what it returns does nothing: the start that subscribed owns the stop.
 * The list itself is kept; a later start drops the tabs closed meanwhile.
 */
export function ensureTabMruStarted() {
  if (mruSubscription) return NOT_STARTED_HERE;
  const first = useTerminalStore.getState();
  let active = first.activeTabId;
  let tabs = first.tabs;
  // Started again after a stop: a tab closed meanwhile is not kept.
  mru.prune((tabs ?? []).map((t) => t.id));
  mru.touch(active);
  const unsubscribe = useTerminalStore.subscribe((state) => {
    if (state.tabs !== tabs) {
      tabs = state.tabs;
      const live = (tabs ?? []).map((t) => t.id);
      mru.prune(live);
      useTabSwitcherStore.getState().forget(live);
    }
    if (state.activeTabId !== active) {
      active = state.activeTabId;
      mru.touch(active);
    }
  });
  mruSubscription = unsubscribe;
  return () => {
    // Only the subscription this start made: after a reset or another start
    // it is not ours to remove.
    if (mruSubscription !== unsubscribe) return;
    unsubscribe();
    mruSubscription = null;
  };
}

/** The ids the switcher would list now, most recent first (`switcherOrder`). */
export function recentTerminalTabs() {
  ensureTabMruStarted();
  return switcherOrder(mru.order(), useTerminalStore.getState().groups);
}

/** For the suites: the raw list, most recent first. */
export function __tabMru() {
  return mru.order();
}

/** For the suites: stop following the store and forget the list. */
export function __resetTabMru() {
  mruSubscription?.();
  mruSubscription = null;
  mru.clear();
}

// --- the keys ------------------------------------------------------------------

/** The modifiers held for a key press, as the switcher compares them. */
export function heldModifiersOf(e) {
  return {
    ctrl: Boolean(e?.ctrlKey),
    alt: Boolean(e?.altKey),
    meta: Boolean(e?.metaKey),
    shift: Boolean(e?.shiftKey),
  };
}

const MODIFIER_KEY = { ctrl: 'Control', alt: 'Alt', meta: 'Meta', shift: 'Shift' };
const MODIFIER_FLAG = { ctrl: 'ctrlKey', alt: 'altKey', meta: 'metaKey', shift: 'shiftKey' };

/**
 * Whether any of the opening chord's modifiers is still down after `e`. The
 * key released is counted as up even if the browser still reports its flag.
 */
function anyStillHeld(modifiers, e) {
  return Object.keys(MODIFIER_KEY).some(
    (name) => modifiers[name] && Boolean(e[MODIFIER_FLAG[name]]) && e.key !== MODIFIER_KEY[name]
  );
}

/** The keys an open switcher answers itself, whatever else is bound to them. */
const SWITCHER_KEYS = new Set(['Escape', 'Enter', 'ArrowUp', 'ArrowDown']);

/**
 * Whether the switcher is open and answers `e` itself — useKeybindings then
 * leaves it alone, so no binding of the app's runs on top of it.
 */
export function switcherOwnsKey(e) {
  return useTabSwitcherStore.getState().open && SWITCHER_KEYS.has(e?.key);
}

const later = (fn) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 0);

// --- the store -------------------------------------------------------------------

let attachedTo = null;
let listeners = null;

function attach(get) {
  const win = globalThis.window;
  if (!win?.addEventListener || attachedTo) return;
  const swallow = (e) => {
    e.preventDefault?.();
    e.stopPropagation?.();
  };
  listeners = {
    // Capture, so a terminal's xterm never sees the key: Escape would reach
    // the shell, Enter would run its line, the arrows would walk its history.
    keydown: (e) => {
      if (!get().open || !SWITCHER_KEYS.has(e.key)) return;
      swallow(e);
      if (e.key === 'Escape') get().cancel();
      else if (e.key === 'Enter') get().commit();
      else get().move(e.key === 'ArrowDown' ? 1 : -1);
    },
    keyup: (e) => {
      const { open, modifiers } = get();
      if (!open || !modifiers) return;
      // Opened with no modifier at all (an F-key a user bound): nothing to
      // let go of, so it stays until Enter, a click or Escape.
      if (!Object.keys(MODIFIER_KEY).some((name) => modifiers[name])) return;
      if (anyStillHeld(modifiers, e)) return;
      get().commit();
    },
    // The window losing focus: the modifier may come up where this page
    // never hears it, so the switch is called off rather than guessed.
    blur: () => {
      if (get().open) get().cancel();
    },
  };
  win.addEventListener('keydown', listeners.keydown, true);
  win.addEventListener('keyup', listeners.keyup, true);
  win.addEventListener('blur', listeners.blur);
  attachedTo = win;
}

function detach() {
  if (!attachedTo || !listeners) return;
  attachedTo.removeEventListener('keydown', listeners.keydown, true);
  attachedTo.removeEventListener('keyup', listeners.keyup, true);
  attachedTo.removeEventListener('blur', listeners.blur);
  attachedTo = null;
  listeners = null;
}

const CLOSED = { open: false, items: [], selectedIndex: 0, modifiers: null };

export const useTabSwitcherStore = create((set, get) => {
  const close = () => {
    detach();
    set({ ...CLOSED });
  };

  return {
    ...CLOSED,

    /**
     * The chord pressed: open the switcher one step from the terminal on
     * screen (`delta` 1 forward, -1 back), or move the selection when it is
     * open already. `modifiers` are those held for the opening press
     * (`heldModifiersOf`). Returns whether the switcher is open after it.
     */
    step: (delta = 1, modifiers = null) => {
      if (get().open) {
        get().move(delta);
        return true;
      }
      const items = recentTerminalTabs();
      if (items.length < 2) return false;
      const n = items.length;
      set({
        open: true,
        items,
        selectedIndex: (((delta < 0 ? -1 : 1) % n) + n) % n,
        modifiers: modifiers ? { ...heldModifiersOf({}), ...modifiers } : null,
      });
      attach(get);
      return true;
    },

    /** Move the selection by `delta`, wrapping at both ends. */
    move: (delta = 1) => {
      const { open, items, selectedIndex } = get();
      if (!open || items.length === 0) return;
      const n = items.length;
      set({ selectedIndex: (((selectedIndex + delta) % n) + n) % n });
    },

    /**
     * Switch to the selected terminal (or the one at `index`, a click) and
     * hand it the keyboard. Returns its id, or null when nothing switched.
     */
    commit: (index) => {
      const { open, items, selectedIndex } = get();
      if (!open) return null;
      const tabId = items[Number.isInteger(index) ? index : selectedIndex] ?? null;
      close();
      const terminal = useTerminalStore.getState();
      if (!tabId || !terminal.tabs.some((t) => t.id === tabId)) return null;
      terminal.switchTab(tabId);
      // A terminal in another group is put on the page a render later;
      // TerminalView focuses a pane that becomes active, and this asks again
      // a frame later for one that already was.
      if (!focusActivePane()) {
        later(() => {
          if (useTerminalStore.getState().activeTabId === tabId) focusActivePane();
        });
      }
      return tabId;
    },

    /** Close it with nothing switched; the keyboard never left where it was. */
    cancel: () => {
      if (get().open) close();
    },

    /**
     * Tabs closed while the switcher is open leave it (`liveIds`: the tabs
     * that are left). Fewer than two left, it closes.
     */
    forget: (liveIds) => {
      const { open, items, selectedIndex } = get();
      if (!open) return;
      const live = new Set(liveIds ?? []);
      const kept = items.filter((id) => live.has(id));
      if (kept.length === items.length) return;
      if (kept.length < 2) {
        close();
        return;
      }
      const selected = items[selectedIndex];
      const at = kept.indexOf(selected);
      set({ items: kept, selectedIndex: at >= 0 ? at : Math.min(selectedIndex, kept.length - 1) });
    },
  };
});
