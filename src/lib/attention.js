/**
 * Which terminal is waiting for you: the unread entries in the bell, read as
 * counts per terminal, and the terminal bell coalesced into one entry.
 *
 * With several agents running in several terminals, the question is not
 * "what happened" — the bell's list already says — but "which one wants me
 * now". Every entry in `notifications` (terminalStore) carries `read`, false
 * when it is made. A terminal's unread count is how many of its entries say
 * `read === false`; a pane rings while a tab in it has any, and the tab chip,
 * the group chip and the side bar count them. Entries are marked read when
 * the terminal is seen — it becomes the active tab in a focused window, the
 * window comes back to the front with it active — or by an explicit action:
 * clicking its entry, Go to Latest Unread Notification, Mark All Read.
 *
 * Only `read === false` is unread. An entry with no `read` at all — one made
 * before entries had it, or put there by hand — is not.
 *
 * Pure: no React, no stores. terminalStore does the writing and keeps the
 * rules about WHEN; this is what the rules compute.
 */
import { isFailure } from './tabActivity.js';

/** Whether an entry is waiting to be seen. */
export function isUnread(entry) {
  return entry?.read === false;
}

const EMPTY_COUNTS = Object.freeze({});

/** Counts already worked out, by the list they came from. */
const countsCache = new WeakMap();

/**
 * `{ [tabId]: unread entries }`, for the tabs that have any. The same list
 * gives back the same (frozen) object, so it can be used as a store selector
 * — `useTerminalStore((s) => unreadCountByTab(s.notifications))` — without
 * re-rendering on every change elsewhere in the store.
 */
export function unreadCountByTab(notifications) {
  if (!Array.isArray(notifications)) return EMPTY_COUNTS;
  const cached = countsCache.get(notifications);
  if (cached) return cached;
  let counts = null;
  for (const entry of notifications) {
    if (!isUnread(entry) || entry.tabId === undefined || entry.tabId === null) continue;
    counts ??= {};
    counts[entry.tabId] = (counts[entry.tabId] ?? 0) + 1;
  }
  const result = counts ? Object.freeze(counts) : EMPTY_COUNTS;
  countsCache.set(notifications, result);
  return result;
}

/** How many entries are unread, in all. */
export function unreadTotal(notifications) {
  if (!Array.isArray(notifications)) return 0;
  let n = 0;
  for (const entry of notifications) if (isUnread(entry)) n += 1;
  return n;
}

/**
 * The unread entries of several tabs together — a group's, a pane's — from
 * `unreadCountByTab`'s `counts`.
 */
export function unreadIn(counts, tabIds) {
  if (!counts || !tabIds) return 0;
  let n = 0;
  for (const id of tabIds) n += counts[id] ?? 0;
  return n;
}

/**
 * Whether an unread entry is a failure: a command that finished with a code
 * that is not 0. A program's message and the bell carry no code, and cmd
 * gives none (see `isFailure`). The bell's button turns red for this.
 */
export function hasUnreadFailure(notifications) {
  if (!Array.isArray(notifications)) return false;
  return notifications.some(
    (entry) => isUnread(entry) && entry.kind !== 'program' && entry.kind !== 'bell' && isFailure(entry.exitCode)
  );
}

/** What a count pill shows: nothing for none, 1 to 9, then "9+". */
export function unreadBadge(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === 0) return '';
  return n > 9 ? '9+' : String(n);
}

/** What a pill's tooltip and accessible name say: "1 unread notification", "3 unread notifications". */
export function unreadLabel(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${n} unread notification${n === 1 ? '' : 's'}`;
}

/**
 * The newest unread entry whose terminal is still there, or null. `tabIds`
 * is the ids of the tabs that exist, as a Set or an array.
 *
 * Newest by `at`; two at the same moment go by their place in the list,
 * which is newest first. An entry for a terminal that has gone is skipped
 * rather than taken to nowhere — the store prunes those, and this does not
 * count on it having done so yet.
 */
export function latestUnread(notifications, tabIds) {
  if (!Array.isArray(notifications)) return null;
  const live = tabIds instanceof Set ? tabIds : new Set(tabIds || []);
  let best = null;
  for (const entry of notifications) {
    if (!isUnread(entry) || !live.has(entry.tabId)) continue;
    if (!best || (entry.at ?? 0) > (best.at ?? 0)) best = entry;
  }
  return best;
}

/**
 * `notifications` with every unread entry `which` picks marked read — the
 * SAME array when there was none, so that a store update that changes
 * nothing can say so and nothing re-renders.
 */
export function markRead(notifications, which = () => true) {
  if (!Array.isArray(notifications)) return notifications;
  let changed = false;
  const next = notifications.map((entry) => {
    if (!isUnread(entry) || !which(entry)) return entry;
    changed = true;
    return { ...entry, read: true };
  });
  return changed ? next : notifications;
}

/**
 * `notifications` (newest first) with `entry` where its time puts it: above
 * every entry no newer than it, below the rest. An entry made now goes on
 * top, as always — above one made in the same millisecond, too; one filed
 * under an earlier time — a message read from output kept before its
 * terminal was shown — goes among the entries of its time. The list stays in
 * time order, which is what the jump and the cap read.
 */
export function insertNewestFirst(notifications, entry) {
  const list = Array.isArray(notifications) ? notifications : [];
  const at = entry?.at ?? 0;
  const index = list.findIndex((n) => (n?.at ?? 0) <= at);
  if (index === -1) return [...list, entry];
  return [...list.slice(0, index), entry, ...list.slice(index)];
}

/**
 * `notifications` (newest first) held to `limit` entries.
 *
 * Read entries stay in the list now, dimmed, until they are dismissed — and
 * cutting the oldest whatever they were let a list full of things already
 * seen push out the one entry still waiting: the terminal asking for
 * permission vanished from the bell, its ring and its pill with it. So the
 * oldest READ entries go first; only a list that is all unread loses its
 * oldest unread ones. An entry with no `read` at all waits for nobody, and
 * goes with the read ones. The same list when nothing has to go.
 */
export function capNotifications(notifications, limit) {
  if (!Array.isArray(notifications) || notifications.length <= limit) return notifications;
  let excess = notifications.length - limit;
  const dropped = new Set();
  for (let i = notifications.length - 1; i >= 0 && excess > 0; i -= 1) {
    if (isUnread(notifications[i])) continue;
    dropped.add(i);
    excess -= 1;
  }
  const kept = notifications.filter((_, i) => !dropped.has(i));
  return kept.length > limit ? kept.slice(0, limit) : kept;
}

/**
 * `notifications` with one more ring of terminal `tabId`'s bell.
 *
 * A bell is a single byte, and a program that wants you rings it again and
 * again; a row per ring would push everything else out of a list that keeps
 * 50. So while a bell entry of that terminal is still unread, the ring is
 * added to it — its `count` goes up and its time is now — and it moves to the
 * top, where the newest is. Once read, the next ring starts a new entry. The
 * entry keeps its id, so the row drawn for it is the same row.
 *
 * `bell` is `{ id, tabId, tabTitle, at, count? }` — `count` rings, one
 * unless said, the last of them at `at`; `limit` is the list's cap
 * (`capNotifications`). Both go where their time puts them
 * (`insertNewestFirst`): rings held back by the rate limit are listed a
 * moment after they rang.
 */
export function addBell(notifications, bell, limit = Infinity) {
  const list = Array.isArray(notifications) ? notifications : [];
  const rings = Number.isFinite(bell.count) && bell.count > 0 ? Math.floor(bell.count) : 1;
  const index = list.findIndex((n) => n?.kind === 'bell' && n.tabId === bell.tabId && isUnread(n));
  if (index !== -1) {
    const existing = list[index];
    const at = Math.max(existing.at ?? 0, bell.at ?? 0);
    const updated = { ...existing, count: (existing.count ?? 1) + rings, at, tabTitle: bell.tabTitle, title: bell.tabTitle };
    return capNotifications(insertNewestFirst([...list.slice(0, index), ...list.slice(index + 1)], updated), limit);
  }
  const entry = {
    id: bell.id,
    kind: 'bell',
    tabId: bell.tabId,
    tabTitle: bell.tabTitle,
    title: bell.tabTitle,
    body: '',
    count: rings,
    at: bell.at,
    read: false,
  };
  return capNotifications(insertNewestFirst(list, entry), limit);
}

/**
 * `notifications` with `rings` more rings of the bell entry `id`, the last
 * of them at `at` — rings the rate limit kept from being written one by one
 * (`bellFromTerminal`). Still unread, the entry takes the newer time and the
 * place in the list that goes with it; read, only its count changes — what
 * was seen stays where it was seen. The same list when the entry is gone.
 */
export function foldRings(notifications, id, rings, at) {
  if (!Array.isArray(notifications) || !(rings > 0)) return notifications;
  const index = notifications.findIndex((n) => n?.id === id);
  if (index === -1) return notifications;
  const entry = notifications[index];
  const count = (entry.count ?? 1) + rings;
  if (isUnread(entry) && at > (entry.at ?? 0)) {
    const rest = [...notifications.slice(0, index), ...notifications.slice(index + 1)];
    return insertNewestFirst(rest, { ...entry, count, at });
  }
  return notifications.map((n, i) => (i === index ? { ...n, count } : n));
}

/** What a bell entry says happened: "Bell", "Bell ×3". */
export function bellText(count = 1) {
  const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  return n === 1 ? 'Bell' : `Bell \u{00d7}${n}`;
}
