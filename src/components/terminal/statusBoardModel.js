import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { unreadCountByTab } from '../../lib/attention.js';
import {
  attentionRank,
  groupAttentionRank,
  groupStatus,
  groupSummaryLabel,
  lastNoteFor,
  statusText,
  terminalStatus,
} from '../../lib/terminalStatus.js';

/**
 * Everything the TERMINALS side bar's status board needs that is not a
 * component: the narrow store readers, the ranks of the sort and the hold
 * on them, the words and sizes the rows are drawn with, and which menu items
 * a sorted view switches off.
 *
 * WHY NOT IN THE .jsx FILES. Vite's Fast Refresh swaps a module in place only
 * when everything it exports is a component; one exported constant or helper
 * and every edit to it reloads the whole app, terminals and all. So
 * StatusBoard.jsx and TerminalsPanel.jsx export components alone, and what
 * they share lives here (and in aimHold.js).
 *
 * WHY EVERY SELECTOR HERE IS SO NARROW. A program reporting progress moves
 * its bar up to ten times a second. The side bar panel subscribes to the
 * whole `tabs` list, and if it read the `progress` map too, every tick would
 * redraw every row of every group. So the panel never reads `progress`: the
 * one line that shows a bar's amount subscribes to that tab's entry alone, a
 * group's summary subscribes to COUNTS (plain numbers, which a bar moving
 * from 40% to 41% does not change), and the sort subscribes to RANKS
 * (likewise). A tick then redraws one 16px line.
 */

// ---- Reading the store narrowly ------------------------------------------------

const EMPTY_INDEX = new Map();
const tabIndexCache = new WeakMap();

/** `tabs` by id — built once per `tabs` array, however many selectors ask. */
function tabIndex(tabs) {
  if (!Array.isArray(tabs)) return EMPTY_INDEX;
  let index = tabIndexCache.get(tabs);
  if (!index) {
    index = new Map();
    for (const tab of tabs) if (tab) index.set(tab.id, tab);
    tabIndexCache.set(tabs, index);
  }
  return index;
}

const lastNoteCache = new WeakMap();

/**
 * `lastNoteFor(notifications, tabId)`, worked out once per list and tab.
 *
 * Every line's selector runs on every change to the store — a bar moving
 * included — and `lastNoteFor` walks the whole list. The list is replaced,
 * never edited in place, so its identity says whether the answer can differ.
 */
export function lastNoteOf(notifications, tabId) {
  if (!Array.isArray(notifications)) return null;
  let byTab = lastNoteCache.get(notifications);
  if (!byTab) {
    byTab = new Map();
    lastNoteCache.set(notifications, byTab);
  }
  if (!byTab.has(tabId)) byTab.set(tabId, lastNoteFor(notifications, tabId));
  return byTab.get(tabId);
}

/** The tabs of `tabIds` that exist in state `s`, in that order. */
function tabsIn(s, tabIds) {
  const byId = tabIndex(s.tabs);
  const out = [];
  for (const id of tabIds || []) {
    const tab = byId.get(id);
    if (tab) out.push(tab);
  }
  return out;
}

/**
 * What the terminals `tabIds` add up to in state `s` (`groupStatus`), as
 * numbers only: the aggregated bar `groupStatus` also returns is a new object
 * every time and is left out, so a selector built on this changes only when
 * a count does.
 */
export function summaryCounts(s, tabIds) {
  const { waiting, running, failed } = groupStatus(tabsIn(s, tabIds), unreadCountByTab(s.notifications), s.progress);
  return { waiting, running, failed };
}

/**
 * The summary in words (`groupSummaryLabel`) of each list in `tabIdLists` —
 * one per group chip, for the group switcher's tooltips and accessible
 * names. Strings compared one by one, so the switcher redraws when a count
 * changes, not when a bar moves.
 */
export function useGroupSummaryLabels(tabIdLists) {
  return useTerminalStore(useShallow((s) => tabIdLists.map((ids) => groupSummaryLabel(summaryCounts(s, ids)))));
}

/** No ranks: the side bar is in the user's order. One object, so "off" compares equal to itself. */
export const NO_RANKS = Object.freeze({});

/** `{ [tabId]: rank }` for every terminal in state `s` (`attentionRank`). */
function tabRanksOf(s) {
  const counts = unreadCountByTab(s.notifications);
  const ranks = {};
  for (const tab of s.tabs || []) {
    if (!tab) continue;
    ranks[tab.id] = attentionRank(terminalStatus(tab, { unread: counts[tab.id] ?? 0, progress: s.progress?.[tab.id] ?? null }));
  }
  return ranks;
}

/**
 * Each terminal's rank when the side bar is sorted by attention, or NO_RANKS
 * when it is not — in which case nothing is worked out at all and nothing
 * the ranks depend on redraws the panel.
 */
export function useTabRanks(enabled) {
  return useTerminalStore(useShallow((s) => (enabled ? tabRanksOf(s) : NO_RANKS)));
}

/**
 * Each group's rank (`groupAttentionRank`) — `entries` being `[{ group, tabIds }]`
 * — or NO_RANKS when the side bar is not sorted.
 */
export function useGroupRanks(enabled, entries) {
  return useTerminalStore(
    useShallow((s) => {
      if (!enabled) return NO_RANKS;
      const counts = unreadCountByTab(s.notifications);
      const ranks = {};
      for (const { group, tabIds } of entries) {
        ranks[group.id] = groupAttentionRank(tabsIn(s, tabIds), counts, s.progress);
      }
      return ranks;
    })
  );
}

/**
 * `ranks` as they were when `hold` became true, for as long as it stays true
 * — `hold` being what the side bar's drawn order holds still for (spec S7):
 * the pointer over a row, a press until its click and a double-click's worth
 * after it (aimHold.js), a menu from the list open, a row being renamed. The
 * second lines keep updating meanwhile; only the places wait.
 *
 * Turning the sort on or off is not held: it is what the user just asked for.
 * A ref written during render is safe here — a render React throws away
 * leaves at worst the newer ranks behind, which the next render reads anyway.
 */
export function useRanksHeldWhile(hold, ranks) {
  const held = useRef(ranks);
  if (!hold || ranks === NO_RANKS || held.current === NO_RANKS) held.current = ranks;
  return held.current;
}

// ---- Words and sizes ------------------------------------------------------------

/**
 * Secondary text on a row: muted, except on the active row, whose selection
 * colour leaves the muted grey at 4.4:1 — under the 4.5:1 that 11px text
 * needs. There the plain foreground (7.5:1) is the quieter of the two, the
 * selection's own white being the louder.
 */
export const secondaryText = (active) => (active ? 'text-vsc-fg' : 'text-vsc-muted');

/**
 * The summary in words as a group's row says it: what it counts is
 * TERMINALS ("terminals: 2 waiting, 1 failed"), where the unread pill beside
 * it counts NOTIFICATIONS — two numbers side by side that must not be read
 * as one.
 */
export const summaryWords = (label) => (label ? `terminals: ${label}` : '');

// ---- A sorted view and the user's order -------------------------------------------

/** Why a menu item that acts on the user's order is off while the side bar shows another. */
export const SORTED_REASON = 'Turn off Sort by Attention to use your own order';

/**
 * The keys of the menu items that act on the user's ORDER — "to the right"
 * of a terminal is a place in it. Sorted by attention, the side bar draws
 * another order, and "Close Terminals to the Right" closed terminals drawn
 * ABOVE the row it was opened on (and was off on a row with rows drawn
 * below it). Every other item acts on the terminal, pane or group itself.
 */
const ORDER_BOUND_ITEMS = new Set(['close-right']);

/** `items` as a menu from the list offers them: those acting on the user's order off, saying why, while `sorted`. */
export function keepUserOrderItems(items, sorted) {
  if (!sorted) return items;
  return items.map((item) =>
    ORDER_BOUND_ITEMS.has(item?.key) ? { ...item, disabled: true, disabledReason: SORTED_REASON } : item
  );
}

/** The menus opened from the list (not the workspace bar's), which hold a sorted order still while open. */
export const LIST_MENUS = new Set(['group', 'pane', 'tab', 'saved', 'empty']);

/**
 * Whether the subject of a menu opened from the side bar, or of a name being
 * edited in it, still exists: `kind` and `id` as the panel keeps them, `has`
 * the panel's lookups `{ tab(id), group(id), pane(id), saved(id),
 * workspace(id) }`. Kinds with no subject (the list's empty space, the
 * workspace bar and its lists, the workspace's own name) always do.
 *
 * WHY. Either one holds a sorted order still, and either one can lose its
 * subject without anything closing it: ⌘W closes the terminal whose name is
 * being edited, and the input is simply unmounted — no blur, no commit — so
 * the edit, and the hold, stayed on for the rest of the session. A menu whose
 * terminal closed under it drew empty and held the order the same way.
 */
export function subjectExists(kind, id, has) {
  switch (kind) {
    case 'tab':
      return Boolean(has.tab(id));
    case 'group':
      return Boolean(has.group(id));
    case 'pane':
      return Boolean(has.pane(id));
    case 'saved':
      return Boolean(has.saved(id));
    case 'workspace':
      return Boolean(has.workspace(id));
    default:
      return true;
  }
}

// ---- What a second line fits ----------------------------------------------------

/**
 * A state as its second line draws it: short. A bar's amount alone ("100%")
 * rather than "In progress 100%", which took 108 of a narrow side bar's 156
 * pixels and pushed everything else off the line; the other states are one
 * short word, or a word and an amount ("Paused 40%"). The full words
 * (`statusText`) stay in the line's tooltip and its accessible name.
 */
export function compactStatusText(status) {
  if (!status?.word) return '';
  if (status.state === 'progress' && !status.paused && typeof status.value === 'number') return `${status.value}%`;
  return statusText(status);
}

/** The share of a second line its last note is promised before an agent's name is drawn beside it. */
export const NOTE_SHARE = 0.4;

/** The least a branch shrinks to: its icon. */
export const BRANCH_MIN_PX = 10;

/**
 * Whether an agent's name, `agentPx` wide, fits on a second line `innerPx`
 * wide whose items are spaced `gapPx` apart, beside a state `statusPx` wide
 * (0 for none), a branch shrunk to its icon (`hasBranch`), and a note given
 * its `NOTE_SHARE` (`hasNote`).
 *
 * The name is drawn whole or not at all — cut down it was "Ope…", or a
 * sliver of 0 px with a gap after it — and goes, when it does not fit, into
 * the line's tooltip and accessible name. The state is never what gives way,
 * and the note keeps its share before the name is drawn.
 */
export function agentFits({ innerPx, gapPx = 0, agentPx, statusPx = 0, hasBranch = false, hasNote = false }) {
  if (!(innerPx > 0) || !(agentPx >= 0)) return false;
  let need = agentPx;
  if (statusPx > 0) need += gapPx + statusPx;
  if (hasBranch) need += gapPx + BRANCH_MIN_PX;
  if (hasNote) need += gapPx + innerPx * NOTE_SHARE;
  return need <= innerPx;
}
