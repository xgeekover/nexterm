/**
 * Dropping files on a terminal pane: which terminal takes them, and the order
 * of events that gets them there.
 *
 * Two gestures end here. Files dragged in from Windows Explorer or Finder
 * arrive as Tauri's `tauri://drag-*` events (`startOsFileDrop`); a row dragged
 * out of NexTerm's own Explorer is a pointer drag (src/lib/explorerDrag.js).
 * Both ask the same question of the pane under the pointer — would a drop
 * there insert anything? — to decide what to highlight, and both end in
 * `insertPathsIntoPane`, which pastes the paths into the terminal that pane
 * is showing (src/components/terminal/insertPathsIntoPane.js binds what this
 * file decides to the stores and the xterm registry).
 *
 * Everything here is pure or takes what it acts on as arguments: the suites
 * run in Node and never mount a component, so what could only be seen by
 * mounting one would go untested. tests/adversarial/terminal_file_drop.test.js.
 */
import { formatDroppedPaths } from './dropPaths.js';

/** The events Tauri sends for an OS drag over the window, in the order they come. */
export const OS_DRAG_EVENTS = Object.freeze({
  enter: 'tauri://drag-enter',
  over: 'tauri://drag-over',
  drop: 'tauri://drag-drop',
  leave: 'tauri://drag-leave',
});

/** What the highlight over a pane says a drop will do. */
export function pathDropLabel(count) {
  return count > 1 ? `Insert ${count} paths` : 'Insert path';
}

/**
 * The terminal pane at a point of the page, by its id, or null.
 *
 * A pane is its body (`data-pane-body`, the terminal and anything drawn over
 * it) and its tab strip (`data-tab-strip`) — dropped on the strip, the paths
 * still belong to the terminal the pane is showing. TerminalSplitContainer's
 * `dropTargetAtPoint` answers a bigger question, where along the strip a
 * dragged TAB would go in, and measures every chip of the strip to do it;
 * an OS drag reports its position many times a second, and only the pane
 * matters here.
 */
export function paneIdAtPoint(x, y, doc = globalThis.document) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const el = doc?.elementFromPoint?.(x, y);
  const strip = el?.closest?.('[data-tab-strip]');
  if (strip) return strip.getAttribute('data-tab-strip') || null;
  const body = el?.closest?.('[data-pane-body]');
  return body ? body.getAttribute('data-pane-body') || null : null;
}

/** Every pane (leaf) of one group's tree, in order. */
function panesOf(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'leaf') acc.push(node);
  else if (node.type === 'split' && Array.isArray(node.children)) {
    for (const child of node.children) panesOf(child, acc);
  }
  return acc;
}

/**
 * The tab a pane is showing — chosen as TerminalPane chooses the one it
 * draws, so the terminal that takes the paths is the one under the pointer:
 * the pane's active tab, else its first.
 */
function shownTabOf(pane, tabs) {
  const own = (Array.isArray(pane.tabIds) ? pane.tabIds : [])
    .map((id) => (Array.isArray(tabs) ? tabs.find((t) => t.id === id) : null))
    .filter(Boolean);
  return own.find((t) => t.id === pane.activeTabId) || own[0] || null;
}

/**
 * Which shell a tab's paths are written for.
 *
 * The tab's own, as the backend reported it when the shell started — the
 * only answer that is certainly right. A tab without one falls back to the
 * Default Shell setting, and where that is "default", to what the backend
 * says its default is (`system_get_info`): on macOS and Linux that is the
 * login shell, and when that is fish its paths need fish's quoting, not the
 * POSIX shell "default" would otherwise be taken for.
 */
export function shellPathOf(tab, { defaultShell = null, systemShell = null } = {}) {
  if (typeof tab?.shell === 'string' && tab.shell.trim()) return tab.shell;
  const setting = typeof defaultShell === 'string' ? defaultShell.trim() : '';
  if (setting && setting !== 'default') return setting;
  return systemShell || setting || null;
}

/**
 * What dropping `paths` on `paneId` would do, decided from the terminal
 * store's state and nothing else.
 *
 * The pane is looked for in the group on screen — the only panes the pointer
 * can be over — and the paths go to the tab it is showing. Nothing is
 * inserted into a pane with no terminal, a terminal whose shell has exited
 * (nothing reads what is typed there — the store drops it, and only Enter
 * does anything, starting a new shell), or one being closed (its shell is
 * being killed; the paste would vanish with it). Neither is highlighted
 * either: a drop there would look taken and do nothing.
 *
 * Returns `{ ok: true, paneId, tabId, text, count, skipped }` — `count` being
 * how many paths `text` holds — or `{ ok: false, reason, paneId, tabId,
 * skipped }`, `reason` one of 'no-pane', 'no-tab', 'closing', 'exited',
 * 'nothing-to-insert'.
 */
export function planPathInsert(
  state,
  paneId,
  paths,
  { platform = null, defaultShell = null, systemShell = null, isClosing = () => false } = {}
) {
  const refuse = (reason, tabId = null, skipped = []) => ({ ok: false, reason, paneId: paneId ?? null, tabId, skipped });

  const groups = Array.isArray(state?.groups) ? state.groups : [];
  const group = groups.find((g) => g.id === state.activeGroupId) || groups[0] || null;
  const pane = group && paneId ? panesOf(group.tree).find((leaf) => leaf.id === paneId) : null;
  if (!pane) return refuse('no-pane');

  const tab = shownTabOf(pane, state.tabs);
  if (!tab) return refuse('no-tab');
  // Closing first: killing a shell makes it exit, so a tab on its way out is
  // usually both by the time its exit arrives, and 'closing' says why.
  if (isClosing(tab.id)) return refuse('closing', tab.id);
  if (tab.exited) return refuse('exited', tab.id);

  const list = Array.isArray(paths) ? paths : [];
  const { text, skipped } = formatDroppedPaths(list, {
    shellPath: shellPathOf(tab, { defaultShell, systemShell }),
    platform,
  });
  if (!text) return refuse('nothing-to-insert', tab.id, skipped);
  return { ok: true, paneId, tabId: tab.id, text, count: list.length - skipped.length, skipped };
}

/**
 * Make `paneId` the active pane and `tabId` its active tab, through the
 * terminal store's own actions (`store` is `useTerminalStore`).
 *
 * The pane becomes active as a click on it would make it (`setActivePane`),
 * which shows whatever tab the pane had on top. That is the tab a plan picks
 * — the one the pane draws — but should the two ever differ, the paste must
 * not land in a tab the store does not show as the active one: `switchTab`
 * brings that tab forward in its pane.
 */
export function showTabInPane(store, paneId, tabId) {
  store.getState().setActivePane(paneId);
  if (tabId && store.getState().activeTabId !== tabId) store.getState().switchTab(tabId);
}

/**
 * Carry out a plan from `planPathInsert`: make its pane the active one, then
 * paste its text into the tab's terminal (which focuses it). `activate` and
 * `paste` are the store's action and the registry's `pasteIntoTerminal`.
 *
 * Returns what happened, for the tests and nothing else to read:
 * `{ inserted, reason, paneId, tabId, text, count, skipped }`, where
 * `reason` is null when the paths went in, the plan's reason when it was
 * refused, and 'no-terminal' when the tab had no live xterm to take them.
 */
export function performPathInsert(plan, { activate, paste }) {
  const outcome = {
    inserted: false,
    reason: null,
    paneId: plan?.paneId ?? null,
    tabId: plan?.tabId ?? null,
    text: '',
    count: 0,
    skipped: Array.isArray(plan?.skipped) ? plan.skipped : [],
  };
  if (!plan?.ok) return { ...outcome, reason: plan?.reason ?? 'no-pane' };
  activate(plan.paneId, plan.tabId);
  const pasted = Boolean(paste(plan.tabId, plan.text));
  return {
    ...outcome,
    inserted: pasted,
    reason: pasted ? null : 'no-terminal',
    text: plan.text,
    count: plan.count,
  };
}

/**
 * Follow drags of files from the OS over the window: highlight the pane a
 * drop would go to, and insert the paths into it when they are dropped.
 *
 *   enter  carries the paths. Kept for the rest of the drag: `over` carries
 *          none, and the highlight says how many will go in.
 *   over   the pointer moved; the highlight follows it.
 *   drop   carries the paths again, and where they landed.
 *   leave  the drag left the window, or was called off.
 *
 * Positions are wry's raw ones; `toClient` turns them into CSS pixels
 * (`dropPointToClient`) and `paneAt` finds the pane there (`paneIdAtPoint`).
 * `plan(paneId, paths)` and `insert(paneId, paths)` are `planPathsIntoPane`
 * and `insertPathsIntoPane`; `setTarget` is the highlight store's.
 *
 * `listen` is ipc.js's: each subscription resolves to its unlisten function
 * LATER. Stopped before that — React's development double mount does it
 * every time — a subscription is let go the moment it arrives, and a stopped
 * drop handler acts on nothing in the meantime: a listener left behind would
 * insert every drop twice for the rest of the session.
 *
 * Returns the function that stops it all.
 */
export function startOsFileDrop({
  listen,
  toClient,
  paneAt,
  plan,
  insert,
  setTarget,
  onError = (err) => console.warn('[drop] could not follow file drags:', err),
}) {
  let stopped = false;
  let carried = null;
  let highlighted = false;
  const unlisteners = [];

  const highlight = (target) => {
    highlighted = Boolean(target);
    setTarget(target);
  };

  const paneUnder = (payload) => {
    const { x, y } = toClient(payload?.position);
    return paneAt(x, y);
  };

  const aim = (payload) => {
    const paneId = paneUnder(payload);
    const decided = paneId && carried ? plan(paneId, carried) : null;
    highlight(decided?.ok ? { paneId, count: decided.count } : null);
  };

  const pathsIn = (payload) => (Array.isArray(payload?.paths) ? payload.paths : null);

  const handlers = {
    [OS_DRAG_EVENTS.enter]: (payload) => {
      carried = pathsIn(payload);
      aim(payload);
    },
    [OS_DRAG_EVENTS.over]: (payload) => aim(payload),
    [OS_DRAG_EVENTS.drop]: (payload) => {
      const paths = pathsIn(payload) ?? carried;
      carried = null;
      highlight(null);
      const paneId = paneUnder(payload);
      if (paneId && paths && paths.length > 0) insert(paneId, paths);
    },
    [OS_DRAG_EVENTS.leave]: () => {
      carried = null;
      highlight(null);
    },
  };

  for (const [event, handle] of Object.entries(handlers)) {
    let subscribed;
    try {
      subscribed = Promise.resolve(
        listen(event, (payload) => {
          if (!stopped) handle(payload);
        })
      );
    } catch (err) {
      subscribed = Promise.reject(err);
    }
    subscribed.then(
      (off) => {
        if (typeof off !== 'function') return;
        if (stopped) off();
        else unlisteners.push(off);
      },
      (err) => onError(err)
    );
  }

  return function stop() {
    if (stopped) return;
    stopped = true;
    for (const off of unlisteners.splice(0)) off();
    carried = null;
    if (highlighted) highlight(null);
  };
}
