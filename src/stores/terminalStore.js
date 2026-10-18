import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { forgetOutput, startPtyOutputBus } from '../lib/ptyOutputBus.js';
import { notifyTerminal } from '../lib/terminalNotice.js';
import { parseSize, restartsShell, sessionIsGone } from '../lib/shellExit.js';
// `loadState` is deliberately NOT used for reads any more: it treats any older
// schema as absent, which for this store's keys would mean silently bootstrapping
// over the user's workspace. Reads go through `loadVersionedState` + an explicit
// version branch; writes still use `saveState` (always the current version).
import { saveState, loadVersionedState, SCHEMA_VERSION } from '../lib/persistence.js';
import { isViewShown, useSettingsStore } from './settingsStore.js';
import { useSystemStore } from './systemStore.js';
import { notificationFor, submitsLine } from '../lib/tabActivity.js';
import { agentRuns } from '../lib/terminalStatus.js';
import { createRateLimiter, routeProgramNotification, windowAttention } from '../lib/programNotifications.js';
import { PROGRESS_INTERVAL_MS, createLatestThrottle, nextProgress, sameProgress } from '../lib/terminalProgress.js';
import {
  addBell,
  capNotifications,
  foldRings,
  insertNewestFirst,
  isUnread,
  latestUnread,
  markRead,
} from '../lib/attention.js';
import { isWindows } from '../lib/platform.js';
import { withoutVerbatimPrefix } from '../lib/terminalCompat.js';
import { resolveStartDir, splitStartFor, startableCwd } from '../lib/terminalCwd.js';
import { createBatchJobReplies } from '../lib/batchJobReply.js';
import { shellKindFor } from '../lib/dropPaths.js';
import { shellPathOf } from '../lib/terminalFileDrop.js';
import {
  agentFromCommandLine,
  agentLabel,
  cleanAgentTitle,
  isKnownAgent,
  isSessionIdFor,
  opencodeTitleMatches,
  opencodeTitleOf,
  opencodeTitlesAlike,
  pickOpencodeSession,
  planOpencodeResume,
  resumeCommand,
  serializeAgent,
  startCommand,
} from '../lib/agents.js';
import { stripTrailingSep, toPosix } from '../lib/paths.js';
import { isNetworkPath } from '../lib/terminalLinks.js';
import {
  followCommandLine,
  normalizeSlotCommand,
  sanitizeStartupCommand,
  startupCommandOf,
  suggestStartupCommand,
  withStartupCommands,
} from '../lib/startupCommands.js';

/**
 * How long a terminal's size has to hold still before the shell is told about
 * it. Short enough that letting go of a divider feels instant, long enough
 * that a drag is one SIGWINCH instead of one per frame.
 */
const RESIZE_SETTLE_MS = 80;

/** tabId -> the resize waiting to be sent: {key, timer, resolve}. */
const pendingResizes = new Map();

// ---------------------------------------------------------------------------
// The two-level layout model
// ---------------------------------------------------------------------------
// The workspace holds several GROUPS. Each group owns ITS OWN split tree of
// PANES, and exactly one group (`activeGroupId`) fills the whole terminal area
// at a time. Switching groups swaps the entire arrangement; every group is
// remembered exactly as it was last left, across switches and restarts.
// Terminals in inactive groups keep running — only their view is unmounted.
//
//   Pane  = { type: 'leaf',  id, tabIds: [], activeTabId }
//   Split = { type: 'split', id, direction, children: [], sizes: [] }
//   Group = { id, name, createdAt, tree: Pane|Split, activePaneId, zoomedPaneId? }
//
// This replaces the previous model, where `splitTree` was ONE tree whose
// LEAVES were the groups (all on screen at once) and a `groupViewMode` /
// `focusedPaneId` pair faked "show only one of them". Both are gone: the model
// is permanently "one group fills the area", so a leaf is now a pane *inside*
// a group rather than a group itself.
//
// `zoomedPaneId` is tmux's zoom (`Prefix z`), iTerm2's "Maximize Active Pane":
// that one pane fills the group's whole area while its siblings are hidden —
// hidden, not closed, their programs still running — and the tree itself is
// untouched, so unzooming puts back exactly the layout that was there. Present
// only while a group IS zoomed, and `settle` drops it the moment it stops
// making sense (see `zoomedPaneOf`). Never persisted: a zoom is a way of
// looking at a layout, not part of it.

let paneCounter = 1;
const makePaneId = () => `pane-${paneCounter++}`;

let groupCounter = 1;
const makeGroupId = () => `group-${groupCounter++}`;

// Split ids are counter-based, not `Date.now()`-based: two splits created in
// the same millisecond used to share an id, and `setPaneSizes` addresses a
// split by id.
let splitCounter = 1;
const makeSplitId = () => `split-${splitCounter++}`;

// Same reason, and the same bug: tab ids used to be
// `tab-term-${Date.now()}-${tabs.length + 1}`. `tabs.length` REWINDS when a
// terminal is closed, so a terminal spawned in the same millisecond as an
// earlier one could inherit its id — and everything that keys on a tab id
// (the xterm registry, `settle`'s placement sweep, `closeTab`, PTY reaping)
// then acts on the wrong terminal. Counters do not rewind.
let tabCounter = 1;
const makeTabId = () => `tab-term-${tabCounter++}`;

function bumpTabCounter(tabId) {
  const match = /^tab-term-(\d+)$/.exec(typeof tabId === 'string' ? tabId : '');
  if (!match) return;
  const next = Number(match[1]) + 1;
  if (next > tabCounter) tabCounter = next;
}

/**
 * Push the id counters past anything that came back from disk (or out of a
 * saved group), so a freshly created pane/split can never collide with a
 * restored one.
 */
function bumpNodeCounters(node) {
  walkNodes(node, (n) => {
    const match = /^(pane|split)-(\d+)$/.exec(typeof n.id === 'string' ? n.id : '');
    if (!match) return;
    const next = Number(match[2]) + 1;
    if (match[1] === 'pane') {
      if (next > paneCounter) paneCounter = next;
    } else if (next > splitCounter) {
      splitCounter = next;
    }
  });
}

function bumpGroupCounter(groupId) {
  const match = /^group-(\d+)$/.exec(typeof groupId === 'string' ? groupId : '');
  if (!match) return;
  const next = Number(match[1]) + 1;
  if (next > groupCounter) groupCounter = next;
}

// --- Tree helpers (all operate on ONE group's tree) ----------------------

/** Visit every node (splits included) of a tree. */
function walkNodes(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  if (node.type === 'split' && Array.isArray(node.children)) {
    for (const child of node.children) walkNodes(child, fn);
  }
}

/** Walks a tree and returns the id of its first pane (DOM order). */
function firstLeafId(node) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id;
  return firstLeafId(node.children[0]);
}

/** Collects every pane of a tree, in DOM order. */
function collectLeaves(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') {
    acc.push(node);
    return acc;
  }
  for (const child of node.children) collectLeaves(child, acc);
  return acc;
}

/** Collects every split node of a tree, in DOM order. */
function collectSplits(node, acc = []) {
  if (!node || node.type !== 'split') return acc;
  acc.push(node);
  for (const child of node.children) collectSplits(child, acc);
  return acc;
}

/**
 * Rebuild a tree, letting `fn` replace any node. A leaf that `fn` turns into a
 * split is returned as-is (we must not recurse into the replacement, which
 * still contains the original leaf).
 */
function mapTree(node, fn) {
  if (!node) return null;
  if (node.type === 'leaf') return fn(node);
  const replaced = fn(node);
  if (replaced !== node) return replaced;
  return { ...node, children: node.children.map((child) => mapTree(child, fn)) };
}

/**
 * Replace exactly the node carrying `id`. Unlike `mapTree` this keeps
 * recursing past non-matching splits, so it is safe for nested layouts.
 */
function replaceNode(node, id, fn) {
  if (!node) return null;
  if (node.id === id) return fn(node);
  if (node.type !== 'split') return node;
  return { ...node, children: node.children.map((child) => replaceNode(child, id, fn)) };
}

const round2 = (value) => Math.round(value * 100) / 100;

/** An even percentage split across `count` children, summing to exactly 100. */
function evenSizes(count) {
  if (count <= 0) return [];
  const each = round2(100 / count);
  const sizes = new Array(count).fill(each);
  sizes[count - 1] = round2(100 - each * (count - 1));
  return sizes;
}

/**
 * Coerce `values` into `count` positive percentages summing to 100. Anything
 * missing, non-finite or non-positive makes the whole row fall back to an even
 * split — a zero-width pane is never a layout the user asked for.
 */
function normalizeSizes(values, count = values?.length ?? 0) {
  if (!Array.isArray(values) || values.length !== count || count === 0) return evenSizes(count);
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return evenSizes(count);
  const total = values.reduce((a, b) => a + b, 0);
  const scaled = values.map((v) => round2((v / total) * 100));
  scaled[count - 1] = round2(100 - scaled.slice(0, -1).reduce((a, b) => a + b, 0));
  return scaled;
}

/** The sizes of `node` restricted to the children at `keptIndexes`, renormalized. */
function keepSizes(node, keptIndexes) {
  const has = Array.isArray(node.sizes) && node.sizes.length === node.children.length;
  return normalizeSizes(has ? keptIndexes.map((i) => node.sizes[i]) : null, keptIndexes.length);
}

/**
 * Enforce the structural invariants of a tree: a split has ≥2 children (one
 * child collapses into it, none removes it), `sizes` has exactly one entry per
 * child, and a pane's `activeTabId` is one of its own `tabIds` (null iff empty).
 */
function normalizeTree(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'leaf') {
    const tabIds = Array.isArray(node.tabIds) ? node.tabIds : [];
    const activeTabId = tabIds.includes(node.activeTabId) ? node.activeTabId : tabIds[0] ?? null;
    if (tabIds === node.tabIds && activeTabId === node.activeTabId) return node;
    return { ...node, tabIds, activeTabId };
  }
  if (node.type !== 'split' || !Array.isArray(node.children)) return null;
  const kept = [];
  node.children.forEach((child, i) => {
    const next = normalizeTree(child);
    if (next) kept.push({ node: next, i });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].node;
  return {
    ...node,
    id: typeof node.id === 'string' && node.id ? node.id : makeSplitId(),
    direction: node.direction === 'vertical' ? 'vertical' : 'horizontal',
    children: kept.map((k) => k.node),
    sizes: keepSizes(node, kept.map((k) => k.i)),
  };
}

/** The pane that currently hosts `tabId` inside one tree, or null. */
function leafHoldingTab(node, tabId) {
  return collectLeaves(node).find((leaf) => leaf.tabIds.includes(tabId)) || null;
}

// --- Zoom ----------------------------------------------------------------

/**
 * The pane `group` is zoomed on — the one filling the group's whole area while
 * its siblings are hidden — or null when it is not zoomed.
 *
 * Read defensively rather than trusted: a zoom only means something on a pane
 * that is still in the tree, in a tree that still has other panes to hide. A
 * group whose zoom outlived either is shown whole. `settle` drops such a zoom
 * as well; this is what keeps a group that never went through it — a test's
 * hand-made state, a render from an arranged store — from drawing nothing.
 */
export function zoomedPaneOf(group) {
  const id = group?.zoomedPaneId;
  if (!id) return null;
  const leaves = collectLeaves(group.tree);
  if (leaves.length < 2) return null;
  return leaves.find((leaf) => leaf.id === id) || null;
}

/**
 * What of `group`'s tree is drawn: the zoomed pane alone, or the whole tree.
 *
 * The one place that decides which panes are on screen. TerminalSplitContainer
 * renders exactly this, so a hidden pane is not mounted at all — its terminal
 * stays alive in the registry, as the terminals of a group that is not on
 * screen do, and its program keeps running.
 */
export function treeOnScreen(group) {
  return zoomedPaneOf(group) ?? group?.tree ?? null;
}

/** The panes of `group` that are drawn, in DOM order — see `treeOnScreen`. */
export function panesOnScreen(group) {
  return collectLeaves(treeOnScreen(group));
}

/** `group` with no zoom: the key goes, rather than staying behind as null. */
function withoutZoom(group) {
  if (!group || !('zoomedPaneId' in group)) return group;
  const { zoomedPaneId: _unzoomed, ...rest } = group;
  return rest;
}

/**
 * Whether `tabId` is drawn right now: the tab a pane of the group on screen
 * is showing. Every pane shows its active tab, so a split shows several — and
 * a zoomed group only the zoomed pane's.
 */
function tabOnScreen(state, tabId) {
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  return Boolean(group) && panesOnScreen(group).some((leaf) => leaf.activeTabId === tabId);
}

/** Remove a tab from whichever pane holds it, keeping that pane's active tab valid. */
function removeTabFromTree(node, tabId) {
  return mapTree(node, (n) => {
    if (n.type !== 'leaf' || !n.tabIds.includes(tabId)) return n;
    const tabIds = n.tabIds.filter((id) => id !== tabId);
    return {
      ...n,
      tabIds,
      activeTabId: n.activeTabId === tabId ? tabIds[0] ?? null : n.activeTabId,
    };
  });
}

/**
 * Drop panes that hold no tabs and collapse splits left with a single child,
 * carrying the surviving children's `sizes` through. Returns null when the
 * whole tree is empty.
 */
function pruneTree(node) {
  if (!node) return null;
  if (node.type === 'leaf') return node.tabIds.length > 0 ? node : null;
  const kept = [];
  node.children.forEach((child, i) => {
    const pruned = pruneTree(child);
    if (pruned) kept.push({ node: pruned, i });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].node;
  return {
    ...node,
    children: kept.map((k) => k.node),
    sizes: keepSizes(node, kept.map((k) => k.i)),
  };
}

/** Remove one pane by id, collapsing the split it leaves behind. */
function removePane(node, paneId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === paneId ? null : node;
  const kept = [];
  node.children.forEach((child, i) => {
    const next = removePane(child, paneId);
    if (next) kept.push({ node: next, i });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].node;
  return {
    ...node,
    children: kept.map((k) => k.node),
    sizes: keepSizes(node, kept.map((k) => k.i)),
  };
}

/** Append a tab to a pane (falling back to the first pane) and make it active there. */
function addTabToPane(node, paneId, tabId) {
  let placed = false;
  const next = replaceNode(node, paneId, (n) => {
    if (n.type !== 'leaf') return n;
    placed = true;
    return { ...n, tabIds: [...n.tabIds, tabId], activeTabId: tabId };
  });
  if (placed) return next;
  const first = collectLeaves(node)[0];
  if (!first) return { type: 'leaf', id: paneId || makePaneId(), tabIds: [tabId], activeTabId: tabId };
  return replaceNode(node, first.id, (n) => ({
    ...n,
    tabIds: [...n.tabIds, tabId],
    activeTabId: tabId,
  }));
}

/** Turn the pane `paneId` into a split of itself and `newLeaf`. */
function splitAt(node, paneId, newLeaf, direction, insertFirst) {
  return replaceNode(node, paneId, (n) => ({
    type: 'split',
    id: makeSplitId(),
    direction,
    children: insertFirst ? [newLeaf, n] : [n, newLeaf],
    sizes: evenSizes(2),
  }));
}

/**
 * `ids` with `id` moved to SLOT `index`, or null when `index` is not a number.
 *
 * A slot is counted in `ids` as it is BEFORE the move, `id` included: slot i
 * is "just before whatever is at position i now", and slot `ids.length` is
 * "after the last". That is the number a drag produces — the dragged chip
 * stays in its row, faded, until it is let go, so the pointer is measured
 * against the row as it stands — and it means the slots either side of `id`
 * both leave it where it is, and one place to the right is two slots on.
 *
 * `id` need not be in `ids` (a tab dropped on another pane's strip); it is
 * then simply inserted at the slot. A slot outside the row is clamped into it
 * and a fraction rounds down. Anything that is not a number is refused rather
 * than read as "the end": a caller that lost track of where the pointer was
 * must not move something to a place the user never pointed at.
 */
function moveToSlot(ids, id, index) {
  if (typeof index !== 'number' || Number.isNaN(index)) return null;
  const from = ids.indexOf(id);
  const slot = Math.min(Math.max(Math.floor(index), 0), ids.length);
  // Lifting `id` out of the row first shifts everything after it one place left.
  const at = from !== -1 && slot > from ? slot - 1 : slot;
  const rest = from === -1 ? ids : ids.filter((x) => x !== id);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Whether two id lists hold the same ids in the same order. */
const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** An empty pane, used when the last group loses its last terminal. */
const emptyPane = () => ({ type: 'leaf', id: makePaneId(), tabIds: [], activeTabId: null });

/** A brand-new single-pane group holding `tabIds`. */
function makeGroup({ name, tabIds = [], createdAt = Date.now() } = {}) {
  const paneId = makePaneId();
  return {
    id: makeGroupId(),
    name: name || 'Group',
    createdAt,
    tree: { type: 'leaf', id: paneId, tabIds: [...tabIds], activeTabId: tabIds[0] ?? null },
    activePaneId: paneId,
  };
}

// --- Group-level helpers -------------------------------------------------

/**
 * Replace one group, ALWAYS returning a brand-new `groups` array.
 *
 * The persist subscription at the bottom of this file compares `groups` by
 * reference; an action that rebuilt a group's tree but handed back the same
 * array would silently stop being saved. Every group write goes through here
 * (or through `settle`, which also rebuilds the array) so that cannot happen.
 * Accepts either the store state or a bare groups array, so two group edits in
 * one action can be chained.
 */
function updateGroup(stateOrGroups, groupId, fn) {
  const groups = Array.isArray(stateOrGroups) ? stateOrGroups : stateOrGroups.groups;
  return groups.map((group) => (group.id === groupId ? fn(group) || group : group));
}

/** The group that owns `paneId` (pane ids are unique across all groups), or null. */
function groupOfPane(state, paneId) {
  if (!paneId) return null;
  return state.groups.find((g) => collectLeaves(g.tree).some((l) => l.id === paneId)) || null;
}

/** The group whose tree currently holds `tabId`, or null. */
function groupOfTab(state, tabId) {
  if (!tabId) return null;
  return state.groups.find((g) => leafHoldingTab(g.tree, tabId)) || null;
}

/**
 * Which group an action should act on: an explicit `groupId` wins, else the
 * group that owns `paneId`, else the active group. Every pane-addressed action
 * takes an optional trailing `groupId` for callers that already know it.
 */
function resolveGroup(state, groupId, paneId) {
  if (groupId) return state.groups.find((g) => g.id === groupId) || null;
  const byPane = groupOfPane(state, paneId);
  if (byPane) return byPane;
  return state.groups.find((g) => g.id === state.activeGroupId) || state.groups[0] || null;
}

/**
 * Repair the whole layout slice so every invariant holds, whatever the caller
 * did. EVERY structural action funnels through here.
 *
 *  - a tab id lives in exactly one pane of exactly one group (duplicates and
 *    ids with no matching tab are dropped — so removing a tab from `tabs` is
 *    enough to sweep it out of all groups)
 *  - empty panes are pruned; a group that prunes to nothing is removed, except
 *    the last group, which is emptied instead
 *  - a split has ≥2 children and one `sizes` entry per child
 *  - `pane.activeTabId ∈ pane.tabIds` (null iff empty)
 *  - `group.activePaneId` names a pane in THAT group's tree
 *  - a group is zoomed on its ACTIVE pane or not at all, and only while it
 *    has more than one pane (see below)
 *  - `activeGroupId` names an existing group
 *  - `activeTabId` is real and lives in the ACTIVE group
 *
 * The zoom rule is how a zoom ends whenever it would stop being true, without
 * every action having to remember it — tmux's behaviour, stated once:
 *
 *  - the zoomed pane closed, or lost its last tab and was pruned: the active
 *    pane moves to one that survived, so the zoom goes;
 *  - focus moved to another pane — Focus Next/Previous Pane, a click on a
 *    hidden pane's terminal in the TERMINALS panel, a tab moved into a hidden
 *    pane: the active pane is no longer the zoomed one, so the zoom goes, and
 *    the user sees the whole layout with the pane they went to;
 *  - the other panes all closed: there is nothing left to hide.
 *
 * A split is the one thing this cannot see — the active pane may stay where
 * it was — so `splitPane` and `dropTabOnPane` drop the zoom themselves.
 *
 * Returns a partial state ready to hand to `set()`. `groups` is always a fresh
 * array, so the persist subscription always sees the change.
 */
function settle(state, patch = {}) {
  const tabs = patch.tabs ?? state.tabs;
  const inputGroups = patch.groups ?? state.groups;
  const validTabIds = new Set(tabs.map((t) => t.id));
  const claimed = new Set();

  let groups = inputGroups.map((group) => {
    let tree = mapTree(group.tree, (n) => {
      if (n.type !== 'leaf') return n;
      const tabIds = (Array.isArray(n.tabIds) ? n.tabIds : []).filter((id) => {
        if (!validTabIds.has(id) || claimed.has(id)) return false;
        claimed.add(id);
        return true;
      });
      if (tabIds.length === n.tabIds?.length) return n;
      return { ...n, tabIds, activeTabId: tabIds.includes(n.activeTabId) ? n.activeTabId : tabIds[0] ?? null };
    });
    tree = normalizeTree(pruneTree(tree));
    return tree === group.tree ? group : { ...group, tree };
  });

  const wantedActiveGroupId = patch.activeGroupId ?? state.activeGroupId;

  // A group with nothing left in it disappears — unless it is the only one,
  // which is emptied so there is always somewhere to put a terminal.
  const surviving = groups.filter((g) => g.tree);
  if (surviving.length === 0) {
    const foundIdx = groups.findIndex((g) => g.id === wantedActiveGroupId);
    const idx = foundIdx === -1 ? 0 : foundIdx;
    const base = groups[idx];
    // Reuse the pane that is already sitting there (it pruned away precisely
    // because it is empty) rather than minting a fresh pane id on every settle.
    const existing = inputGroups[idx] ? collectLeaves(inputGroups[idx].tree)[0] : null;
    const pane = existing && existing.tabIds.length === 0 ? { ...existing, activeTabId: null } : emptyPane();
    groups = [base ? { ...base, tree: pane, activePaneId: pane.id } : makeGroup({ name: 'Group 1' })];
  } else {
    groups = surviving;
  }

  groups = groups.map((group) => {
    const leaves = collectLeaves(group.tree);
    const activePaneId = leaves.some((l) => l.id === group.activePaneId)
      ? group.activePaneId
      : firstLeafId(group.tree);
    const name = typeof group.name === 'string' && group.name ? group.name : 'Group';
    // Checked against the REPAIRED active pane: a zoomed pane that was pruned
    // has just handed `activePaneId` to a survivor, which it is not.
    const zoomHolds =
      Boolean(group.zoomedPaneId) && group.zoomedPaneId === activePaneId && leaves.length > 1;
    const zoomSettled = zoomHolds || !('zoomedPaneId' in group);
    if (activePaneId === group.activePaneId && name === group.name && zoomSettled) return group;
    const next = { ...group, name, activePaneId };
    return zoomHolds ? next : withoutZoom(next);
  });

  const activeGroupId = groups.some((g) => g.id === wantedActiveGroupId) ? wantedActiveGroupId : groups[0].id;
  const activeGroup = groups.find((g) => g.id === activeGroupId);

  // The active tab must be one the active group actually shows — switching
  // group therefore moves it.
  const activeLeaves = collectLeaves(activeGroup.tree);
  const inActiveGroup = new Set(activeLeaves.flatMap((l) => l.tabIds));
  let activeTabId = patch.activeTabId !== undefined ? patch.activeTabId : state.activeTabId;
  if (!activeTabId || !inActiveGroup.has(activeTabId)) {
    const activePane = activeLeaves.find((l) => l.id === activeGroup.activePaneId);
    activeTabId = activePane?.activeTabId ?? activeLeaves.find((l) => l.tabIds.length > 0)?.tabIds[0] ?? null;
  }

  const next = { tabs, groups, activeGroupId, activeTabId };
  if (patch.cwd !== undefined) next.cwd = patch.cwd;
  return next;
}

// --- Persistence ---------------------------------------------------------
//
// We persist only what can be meaningfully restored: every group (id, name,
// creation time, its split tree's shape — pane ids, tab order, each pane's
// active tab, each split's direction and `sizes`) plus each tab's
// `title`/`cwd` and the agent it was running. PTY sessions and scrollback are
// process state and cannot survive a relaunch — `init()` spawns a *fresh* PTY
// per saved tab.
export const PERSIST_KEY = 'nexterm.terminal.workspace';
/** The pre-upgrade payload, kept once so a failed migration is recoverable. */
export const PERSIST_BACKUP_KEY = 'nexterm.terminal.workspace.v1.bak';
/** Named group snapshots the user saves explicitly (separate from the live layout). */
export const SAVED_GROUPS_KEY = 'nexterm.terminal.savedGroups';
/** Snapshots of the WHOLE workspace — every group, its layout and its cwds. */
export const SAVED_WORKSPACES_KEY = 'nexterm.terminal.savedWorkspaces';

const PERSIST_DEBOUNCE_MS = 300;
/** However busy the terminals are, the layout is never more than this stale. */
const PERSIST_MAX_WAIT_MS = 2000;

let persistTimer = null;
let persistDeadline = null;
let pendingPersistState = null;

/** Strip a tree node down to the fields worth persisting. */
function serializeTreeForPersist(node) {
  if (!node) return null;
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      id: node.id,
      tabIds: [...node.tabIds],
      activeTabId: node.activeTabId,
    };
  }
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: node.children.map(serializeTreeForPersist),
    ...(Array.isArray(node.sizes) ? { sizes: [...node.sizes] } : {}),
  };
}

/**
 * Field by field, on purpose. `zoomedPaneId` is left out: a relaunch comes back
 * with every pane in view rather than with panes nobody remembers hiding, and
 * since this payload is also the persist subscription's key, zooming and
 * unzooming never schedule a write.
 */
function serializeGroupForPersist(group) {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    activePaneId: group.activePaneId,
    tree: serializeTreeForPersist(group.tree),
  };
}

function buildPersistedPayload(state) {
  return {
    workspaceName: state.workspaceName,
    groups: state.groups.map(serializeGroupForPersist),
    activeGroupId: state.activeGroupId,
    // `agent` rides along so a restored terminal can offer to pick the
    // conversation back up. `serializeAgent` drops anything unrecognised — an
    // unknown agent, a session id that is not a UUID — so a payload from
    // another build cannot put a command on a shell.
    //
    // A terminal's startup command does NOT ride along, nor the line it last
    // ran: a relaunch brings the shells back and runs nothing in them, as it
    // offers an agent rather than starting one. Templates are opened on
    // purpose (`loadSavedGroup`, `loadWorkspace`).
    tabs: state.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      agent: serializeAgent(t.agent),
    })),
  };
}

/**
 * Debounced write-behind, with a ceiling.
 *
 * A plain restart-on-every-change debounce is starvable, and a terminal was
 * exactly the thing that starved it: `pty-output` used to rebuild `state.tabs`
 * on every chunk, so a shell printing more often than the debounce (a dev
 * server, `tail -f`, a test watcher) pushed the save out forever. Renaming a
 * group or rearranging panes then never reached disk until the output stopped
 * — and if the app was quit while it was still streaming, all of it was lost.
 *
 * So: coalesce bursts as before, but never go longer than PERSIST_MAX_WAIT_MS
 * without writing.
 */
function schedulePersist(state) {
  pendingPersistState = state;
  clearTimeout(persistTimer);
  if (persistDeadline === null) persistDeadline = Date.now() + PERSIST_MAX_WAIT_MS;
  const wait = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, persistDeadline - Date.now()));
  persistTimer = setTimeout(flushPersist, wait);
}

/** Write whatever is pending right now. Safe to call when nothing is. */
function flushPersist() {
  clearTimeout(persistTimer);
  persistTimer = null;
  persistDeadline = null;
  const state = pendingPersistState;
  pendingPersistState = null;
  if (state) saveState(PERSIST_KEY, buildPersistedPayload(state));
}

/** Tolerantly collect the leaves of an untrusted (possibly hand-edited) tree. */
function collectRawLeaves(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'split' && Array.isArray(node.children)) {
    for (const child of node.children) collectRawLeaves(child, acc);
    return acc;
  }
  if (node.type === 'leaf') acc.push(node);
  return acc;
}

/**
 * v1 → v2 workspace migration.
 *
 * v1 persisted ONE split tree whose leaves WERE the groups, all rendered side
 * by side, plus a `groupViewMode`/`focusedPaneId` pair that faked showing only
 * one of them. Because a v1 leaf already was a group, the migration is total:
 * every leaf becomes a v2 group with a single pane — the leaf's `name` becomes
 * the group's name, the leaf's id stays the pane id (so ids keep matching what
 * was saved), and sibling order is preserved so the group switcher lists the
 * groups exactly as they were laid out left-to-right.
 *
 * The split nodes BETWEEN v1 leaves are dropped: with groups never rendered
 * side by side they have no referent any more.
 *
 * The active group is the old focus target (only meaningful when v1 was in
 * 'focus' mode), else the group holding `activePaneId`, else the first.
 *
 * Returns a v2 workspace payload (`{ groups, activeGroupId, tabs }`) — i.e.
 * exactly what `restoreSavedLayout` consumes — or null when there is nothing
 * worth restoring.
 */
export function migrateV1Workspace(v1) {
  if (!v1 || typeof v1 !== 'object') return null;

  const tabs = (Array.isArray(v1.tabs) ? v1.tabs : [])
    .filter((t) => t && typeof t.id === 'string' && t.id)
    .map((t) => ({ id: t.id, title: t.title, cwd: t.cwd }));
  const leaves = collectRawLeaves(v1.splitTree);
  if (tabs.length === 0 || leaves.length === 0) return null;

  const createdAt = Date.now();
  const groups = leaves.map((leaf, i) => {
    const paneId = typeof leaf.id === 'string' && leaf.id ? leaf.id : `pane-migrated-${i + 1}`;
    const tabIds = (Array.isArray(leaf.tabIds) ? leaf.tabIds : []).filter((id) => typeof id === 'string');
    return {
      // A distinct prefix keeps migrated ids clear of every `group-N` the
      // counter will ever mint.
      id: `group-migrated-${i + 1}`,
      name: (typeof leaf.name === 'string' && leaf.name.trim()) || `Group ${i + 1}`,
      createdAt,
      activePaneId: paneId,
      tree: {
        type: 'leaf',
        id: paneId,
        tabIds,
        activeTabId: tabIds.includes(leaf.activeTabId) ? leaf.activeTabId : tabIds[0] ?? null,
      },
    };
  });

  const byPaneId = (paneId) => (paneId ? groups.find((g) => g.tree.id === paneId) : null);
  const active =
    (v1.groupViewMode === 'focus' ? byPaneId(v1.focusedPaneId) : null) ||
    byPaneId(v1.activePaneId) ||
    groups[0];

  return { groups, activeGroupId: active.id, tabs };
}

/**
 * Copy the pre-upgrade payload aside before this version can write over it.
 *
 * The upgrade launch is the one launch where the saved workspace is
 * irreplaceable: if the restore fails for any reason the write-behind replaces
 * it with a fresh single-terminal v2 payload, and rolling back does not help
 * because the older build rejects v2. Cheap insurance, written once.
 */
function backUpPreUpgradePayload() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return;
    if (localStorage.getItem(PERSIST_BACKUP_KEY) != null) return;
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw != null) localStorage.setItem(PERSIST_BACKUP_KEY, raw);
  } catch (_) {
    // storage unavailable or full — the restore still goes ahead
  }
}

/**
 * Read the live workspace payload, migrating an older schema instead of
 * throwing it away.
 *
 * `loadState` deliberately returns the fallback for ANY version mismatch,
 * which for this key would mean: bootstrap a single terminal, then let the
 * 300ms write-behind overwrite the user's real workspace. So this goes through
 * `loadVersionedState` and branches on the version explicitly; anything
 * unrecognised (including a *newer* schema written by a future build) returns
 * null, which bootstraps but — because nothing is understood — is the only
 * safe reading.
 */
function loadWorkspacePayload() {
  const stored = loadVersionedState(PERSIST_KEY);
  if (!stored) return null;
  if (stored.version === SCHEMA_VERSION) {
    return stored.data && typeof stored.data === 'object' ? stored.data : null;
  }
  if (stored.version === 1) {
    backUpPreUpgradePayload();
    return migrateV1Workspace(stored.data);
  }
  return null;
}

/** Give a v1 saved group (a flat tab list, no layout) the single-pane tree v2 expects. */
function migrateV1SavedGroup(entry, index) {
  const tabs = (Array.isArray(entry.tabs) ? entry.tabs : [])
    .filter(Boolean)
    .map((t, i) => ({ slotId: `slot-${i}`, title: t.title, cwd: t.cwd }));
  if (tabs.length === 0) return null;
  const paneId = `saved-pane-${index + 1}`;
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : 'Saved group',
    savedAt: typeof entry.savedAt === 'number' ? entry.savedAt : Date.now(),
    tabs,
    activePaneId: paneId,
    tree: {
      type: 'leaf',
      id: paneId,
      tabIds: tabs.map((t) => t.slotId),
      activeTabId: tabs[0].slotId,
    },
  };
}

/**
 * A saved group carries a layout but cannot carry live tab ids, so its tree
 * references stable SLOT ids (`slot-0`, `slot-1`, …) that `loadSavedGroup`
 * maps onto freshly spawned tabs. `tabs` stays a flat array — the Terminals
 * panel renders `entry.tabs.length`.
 *
 * A slot may carry a startup command (`command`, see src/lib/startupCommands.js
 * — what makes a saved group a layout template). It is optional, so every
 * entry saved before it existed reads exactly as it did, and it is cleaned on
 * the way in: a command a hand edit made multi-line is dropped here, never
 * typed into a shell.
 */
function normalizeSavedEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id !== 'string' || !Array.isArray(entry.tabs) || entry.tabs.length === 0) return null;
  const hasSlots = entry.tabs.every((t) => t && typeof t.slotId === 'string' && t.slotId);
  if (!hasSlots || !entry.tree) return migrateV1SavedGroup(entry, index);
  const slotIds = new Set(entry.tabs.map((t) => t.slotId));
  const tree = normalizeTree(pruneTree(sanitizeRestoredTree(entry.tree, slotIds, new Set())));
  if (!tree) return migrateV1SavedGroup(entry, index);
  return { ...entry, tabs: entry.tabs.map(normalizeSlotCommand), tree };
}

/** The same cleaning for every group a saved workspace holds. */
function normalizeWorkspaceCommands(workspace) {
  return {
    ...workspace,
    groups: workspace.groups.map((group) =>
      group && Array.isArray(group.tabs) ? { ...group, tabs: group.tabs.map(normalizeSlotCommand) } : group
    ),
  };
}

/**
 * Read the saved-group list, tolerating a corrupt or stale payload.
 *
 * v1 entries are migrated on READ and deliberately not written back: the
 * on-disk payload is only rewritten when the user next saves, renames or
 * deletes a group, so a bad migration can never eat the list on its own.
 */
function loadSavedWorkspaces() {
  const stored = loadVersionedState(SAVED_WORKSPACES_KEY);
  if (!stored || stored.version !== SCHEMA_VERSION) return [];
  const list = Array.isArray(stored.data) ? stored.data : [];
  return list
    .filter((w) => w && typeof w.id === 'string' && Array.isArray(w.groups) && w.groups.length > 0)
    .map(normalizeWorkspaceCommands);
}

function loadSavedGroups() {
  const stored = loadVersionedState(SAVED_GROUPS_KEY);
  if (!stored) return [];
  if (stored.version !== SCHEMA_VERSION && stored.version !== 1) return [];
  const list = Array.isArray(stored.data) ? stored.data : [];
  return list.map(normalizeSavedEntry).filter(Boolean);
}

/**
 * Rebuild a saved tree, dropping any reference to a tab that failed to restore
 * and to any tab already claimed by an earlier group (a tab lives in exactly
 * one pane of exactly one group). `pruneTree` then removes any pane that ends
 * up empty and collapses single-child splits.
 */
function sanitizeRestoredTree(node, validTabIds, claimed) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'leaf') {
    const tabIds = (Array.isArray(node.tabIds) ? node.tabIds : []).filter((id) => {
      if (!validTabIds.has(id) || claimed.has(id)) return false;
      claimed.add(id);
      return true;
    });
    const activeTabId = tabIds.includes(node.activeTabId) ? node.activeTabId : tabIds[0] ?? null;
    return {
      type: 'leaf',
      id: typeof node.id === 'string' && node.id ? node.id : makePaneId(),
      tabIds,
      activeTabId,
    };
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    const children = node.children
      .map((c) => sanitizeRestoredTree(c, validTabIds, claimed))
      .filter(Boolean);
    return {
      type: 'split',
      id: typeof node.id === 'string' && node.id ? node.id : makeSplitId(),
      direction: node.direction === 'vertical' ? 'vertical' : 'horizontal',
      children,
      // Sizes only survive intact when nothing was dropped; `normalizeTree`
      // and `pruneTree` renormalize whenever a child disappears.
      ...(Array.isArray(node.sizes) && node.sizes.length === children.length
        ? { sizes: [...node.sizes] }
        : {}),
    };
  }
  return null;
}

/** Rewrite every tabId in a tree through `map`, dropping unmapped ones. */
function remapTreeTabIds(node, map) {
  if (!node) return null;
  if (node.type === 'leaf') {
    const tabIds = node.tabIds.map((id) => map.get(id)).filter(Boolean);
    return {
      ...node,
      tabIds,
      activeTabId: map.get(node.activeTabId) && tabIds.includes(map.get(node.activeTabId))
        ? map.get(node.activeTabId)
        : tabIds[0] ?? null,
    };
  }
  return { ...node, children: node.children.map((c) => remapTreeTabIds(c, map)) };
}

/**
 * The layout a start puts in place — the restored one, or a fresh start's
 * first terminal — with every terminal already in the store kept in it.
 *
 * A start begins with no terminals, and its layout used to replace `tabs`
 * along with the placeholder group: a terminal made while it ran vanished
 * from the screen with its shell still running. New terminals now wait for
 * the start (see `spawnTab`); this keeps one made before it began, or any
 * that gets past that wait, rather than dropping it. It goes into the active
 * pane of the group on screen and is shown, as a new terminal is.
 *
 * A restore keeps the tab ids it saved, and the counter starts from one on
 * every launch, so a terminal made before the restore can hold an id a
 * restored one is about to take. Two tabs with one id would share one xterm
 * (the registry keys on it), so the restored terminal takes a new id instead.
 *
 * `layout` is `{ tabs, groups, activeGroupId, activeTabId }`; so is what
 * comes back, ready for `set()`.
 */
function keepTabsMadeMeanwhile(state, layout) {
  const kept = state.tabs;
  if (kept.length === 0) return layout;

  const taken = new Set(kept.map((t) => t.id));
  const ids = new Map(layout.tabs.map((t) => [t.id, taken.has(t.id) ? makeTabId() : t.id]));
  const layoutTabs = layout.tabs.map((t) => ({ ...t, id: ids.get(t.id) }));
  const groups = layout.groups.map((g) => ({ ...g, tree: remapTreeTabIds(g.tree, ids) }));
  const active = groups.find((g) => g.id === layout.activeGroupId) || groups[0];
  const tree = kept.reduce((t, tab) => addTabToPane(t, active.activePaneId, tab.id), active.tree);
  return settle(state, {
    tabs: [...layoutTabs, ...kept],
    groups: groups.map((g) => (g === active ? { ...g, tree } : g)),
    activeGroupId: active.id,
    activeTabId: kept[kept.length - 1].id,
  });
}

/** Give every pane in a tree a brand-new id, so the same layout can be loaded twice. */
function regeneratePaneIds(node, idMap = new Map()) {
  if (!node) return null;
  if (node.type === 'leaf') {
    const id = makePaneId();
    idMap.set(node.id, id);
    return { ...node, id };
  }
  return {
    ...node,
    id: makeSplitId(),
    children: node.children.map((c) => regeneratePaneIds(c, idMap)),
  };
}

let unlisteners = [];
let listening = false;

/**
 * session id -> how many command ends (OSC 133 "D") that shell has reported.
 *
 * Kept per SESSION, outside the tabs, because a shell can report its first
 * one before any tab holds it. A light zsh draws its first prompt within tens
 * of milliseconds of being spawned and cmd sooner: while `createTab` is still
 * waiting for `pty_spawn` to return, or while a restore spawns the next
 * terminal. Counted on the tab, that D had nowhere to go, and the shell then
 * looked like one that never reports an end — no inference for its commands
 * (`noteSubmittedLine`), and an agent typed into it only after the whole
 * wait, and never watched (`untilPromptReady`). Dropped when the shell exits.
 */
const commandEndsBySession = new Map();

/** How many command ends `sessionId` has reported so far. */
const endsOf = (sessionId) => commandEndsBySession.get(sessionId) ?? 0;

/**
 * Who wants to hear that a command ended (`onCommandEnded`).
 *
 * An event rather than a field of the store: what hears it — the side bar's
 * branch lookups (src/hooks/useBranchLookups.js), as a `git checkout` changes
 * the branch — needs the moment, not a value to render, and a counter in the
 * state would be one more thing every subscriber of the store compares.
 */
const commandEndListeners = new Set();

/**
 * Call `listener(tabIds)` each time a command ends — the shell's OSC 133 "D"
 * (`pty-command-done`) — with the ids of the tabs holding that shell, once
 * the store has taken the end in. Returns what stops it. A listener that
 * throws is reported and the rest still hear it.
 */
export function onCommandEnded(listener) {
  if (typeof listener !== 'function') return () => {};
  commandEndListeners.add(listener);
  return () => {
    commandEndListeners.delete(listener);
  };
}

function commandEnded(tabIds) {
  if (tabIds.length === 0) return;
  for (const listener of [...commandEndListeners]) {
    try {
      listener(tabIds);
    } catch (err) {
      console.warn('[TerminalStore] a command-end listener failed:', err);
    }
  }
}

/**
 * Who wants to hear that a program in a terminal called for the user
 * (`onProgramSignal`) — for the same reason as `commandEndListeners`: an
 * agent that switched branches says nothing else until it exits, and its
 * message is the moment to look at the branch again.
 */
const programSignalListeners = new Set();

/**
 * Call `listener(tabId)` each time a program in terminal `tabId` notifies
 * (`notifyFromProgram` — not for a note read from output kept from before
 * the terminal was shown, which is old news) or rings its bell
 * (`bellFromTerminal`, unless the bell is turned off), whatever becomes of
 * it. Returns what stops it. A listener that throws is reported and the rest
 * still hear it.
 */
export function onProgramSignal(listener) {
  if (typeof listener !== 'function') return () => {};
  programSignalListeners.add(listener);
  return () => {
    programSignalListeners.delete(listener);
  };
}

function programSignalled(tabId) {
  for (const listener of [...programSignalListeners]) {
    try {
      listener(tabId);
    } catch (err) {
      console.warn('[TerminalStore] a program-signal listener failed:', err);
    }
  }
}

/**
 * tab id -> the line being typed at its prompt, followed from every write
 * (`followCommandLine` in src/lib/startupCommands.js). Kept out of the store:
 * it changes with every key and nothing draws it. What it yields is: a tab's
 * `commandLine`, the last line it submitted, which is what a saved group
 * offers as that terminal's startup command while it is still running.
 */
const typedLines = new Map();

/**
 * tab id -> the conversation title its opencode shows now (`OC | <title>`),
 * as shown — cut to 37 characters past 40. What `resolveAgentSession` looks
 * up; kept out of the store because only the lookup reads it.
 */
const shownTitles = new Map();

/** tab id -> the pending lookup of its opencode conversation. */
const resolveTimers = new Map();

/**
 * tab id -> `{ shown, count }`: how many lookups in a row for the title it
 * shows (`shown`) failed or found nothing. A lookup is tried again after
 * each, AGENT_RESOLVE_RETRY_MS apart, while that title still shows: one
 * failure used to be final for the title, and a terminal whose only lookup
 * failed resumed "the most recent" conversation after a restart.
 */
const resolveMisses = new Map();

/**
 * tab id -> the conversation id its record held before opencode showed a new
 * title (`noteAgentTitle`). The record lets go of an id the moment the title
 * changes — the title may be another conversation's — but a conversation
 * renamed is still the same conversation: two terminals that knew their ids
 * and were then retitled alike had them dealt out again, swapped. So the
 * lookup keeps the old id when it fits the new title (`pickOpencodeSession`'s
 * `currentId`), and until it has decided, no other terminal may take it —
 * not by a lookup, nor by a Resume (`holdersElsewhere`, `needsLookup`). It
 * goes when the lookup decides, the agent exits, the terminal closes, or a
 * new record starts.
 */
const idHints = new Map();

/**
 * tab id -> the folder (`folderKey`) of a terminal that typed opencode by
 * Resume since the workspace was restored, and of those that typed
 * `--continue`. `--continue` opens the most recent conversation in its
 * folder or below it (opencode keeps each conversation's place in its
 * project), so it is only for a terminal with no other opencode terminal
 * within that reach (`aloneInReach`); and a second one there, chosen from a
 * list, would be the same conversation as the first. Kept while the
 * terminal is open, its agent exited or not — the conversation it had is
 * still its own — and dropped when it closes (`forgetTerminal`).
 */
const opencodeResumers = new Map();
const continuedLatest = new Map();

/**
 * Whether `--continue` in one of two folders (`folderKey` spellings) could
 * open the other's conversation: the same folder, or one inside the other.
 * Siblings do not reach each other. A folder not known is taken to reach
 * everything — the side that asks rather than guesses.
 */
function foldersOverlap(a, b) {
  if (!a || !b || a === b) return true;
  const within = (inner, outer) => inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`);
  return within(a, b) || within(b, a);
}

/** Tab ids whose new shell is being started (`restartShell`): one at a time. */
const restarting = new Set();

/**
 * Tab ids on their way out (`closeTab`, `killTabIfOrphaned`). Each holds the
 * session it read before awaiting the kill, so a new shell `restartShell`
 * installed meanwhile would outlive the tab, running with nothing to show it.
 */
const closingTabs = new Set();

/**
 * Whether `tabId` is on its way out (see `closingTabs`), for code outside the
 * store that must not hand anything to a terminal about to go — a drop of
 * file paths, for one: pasted into a shell being killed, it would be lost
 * with no sign it had gone anywhere. Read-only on purpose: only `closeTab`
 * and `killTabIfOrphaned` decide what is closing.
 */
export function isTabClosing(tabId) {
  return closingTabs.has(tabId);
}

/**
 * How long a title has to stay before its conversation is looked up. opencode
 * sends the same title two or three times in a row as it draws (measured),
 * and switching conversations quickly should cost one lookup, not five.
 */
export const AGENT_RESOLVE_DELAY_MS = 400;
let agentResolveDelayMs = AGENT_RESOLVE_DELAY_MS;

/** Test hook: how long a title holds still before it is looked up. Returns what it replaced. */
export function __setAgentResolveDelayMs(ms) {
  const previous = agentResolveDelayMs;
  agentResolveDelayMs = ms;
  return previous;
}

/**
 * How long after a lookup that failed or found nothing it is tried again,
 * attempt by attempt, while the same title shows; then it is left until the
 * title changes or Resume asks. A cold start of a large CLI on a slow disk,
 * a database another opencode holds for a moment, a conversation not yet
 * written when its title first showed — each of these clears up by itself.
 */
export const AGENT_RESOLVE_RETRY_MS = Object.freeze([15_000, 60_000, 300_000]);
let agentResolveRetryMs = AGENT_RESOLVE_RETRY_MS;

/** Test hook: the retry schedule. Returns what it replaced. */
export function __setAgentResolveRetryMs(delays) {
  const previous = agentResolveRetryMs;
  agentResolveRetryMs = Array.isArray(delays) ? delays : AGENT_RESOLVE_RETRY_MS;
  return previous;
}

/** Numbers each resume notice, so one that repeats the last is still new to the banner. */
let noticeSeq = 0;

/** Why lookups failed, as reported to the console this run: each reason once. */
const reportedLookupFailures = new Set();

/** The reason a failed `agent_sessions` gave, as one line of text. */
function lookupFailureOf(err) {
  const text = String(err?.message ?? err ?? '').replace(/\s+/g, ' ').trim();
  return text || 'no reason given';
}

/** Say on the console why a lookup failed — once for each reason, however often it is retried. */
function reportLookupFailure(reason) {
  if (reportedLookupFailures.has(reason)) return;
  reportedLookupFailures.add(reason);
  console.warn('[TerminalStore] could not look up the opencode conversation:', reason);
}

/**
 * A directory as two terminals' spellings of it compare: one kind of
 * separator, no trailing one, one case. Folding case on a filesystem that
 * keeps it apart can only make two folders look shared, which makes the
 * resume ask rather than guess — the safe side.
 */
const folderKey = (path) => toPosix(stripTrailingSep(typeof path === 'string' ? path.trim() : '')).toLowerCase();

/**
 * How long a submitted line may go unanswered before it counts as a running
 * command, where that inference is made at all (see `noteSubmittedLine`).
 *
 * Long enough that a line the shell answers at once — an empty Enter, a
 * builtin — is answered first and never flickers as running; short enough
 * that nobody reaches the Resume button inside it.
 */
export const SUBMIT_GRACE_MS = 300;

/**
 * Whether a submitted line is taken as a running command before OSC 133 "C"
 * says so. Only on Windows, where ConPTY can hold the C back; see
 * `noteSubmittedLine`.
 */
let submitInfersRunning = isWindows;

/** Test hook: scope `noteSubmittedLine` to a platform. Returns what it replaced. */
export function __setSubmitInfersRunning(on) {
  const previous = submitInfersRunning;
  submitInfersRunning = Boolean(on);
  return previous;
}

/**
 * How long a new shell has to draw its first prompt before an agent is typed
 * into it anyway (see `startAgent`).
 *
 * The prompt is recognised by its OSC 133 "D": every shell NexTerm integrates
 * sends one with every prompt, the first included. One with no integration —
 * fish, sh — never will, and is typed into once this is up, as it always was.
 * Counted from when the shell started, so it is only ever waited out on a
 * terminal that has just opened. Long enough for most shells to load their rc
 * files and a PowerShell its profile; one slower than that is typed into
 * early, which is how every agent was typed before there was a wait.
 */
export const AGENT_PROMPT_WAIT_MS = 3000;
let agentPromptWaitMs = AGENT_PROMPT_WAIT_MS;

/** Test hook: how long an agent waits for a first prompt. Returns what it replaced. */
export function __setAgentPromptWaitMs(ms) {
  const previous = agentPromptWaitMs;
  agentPromptWaitMs = Number.isFinite(ms) && ms >= 0 ? ms : AGENT_PROMPT_WAIT_MS;
  return previous;
}

/**
 * True for the auto-generated `Terminal N` names.
 *
 * The distinction matters wherever a title is handed in rather than chosen: a
 * default name is a NUMBER the app gave out and may give out differently,
 * while anything else is a name the user typed and is theirs to keep,
 * duplicate or not.
 */
const isDefaultTitle = (name) => /^Terminal \d+$/.test(name || '');

/**
 * The name a new terminal gets when the user has not chosen one.
 *
 * Numbered by the lowest number nothing is using, not by how many terminals
 * there are. `Terminal ${tabs.length + 1}` reused a number the moment a tab in
 * the middle was closed: open three, close "Terminal 2", open one more, and
 * two tabs are both called "Terminal 3".
 *
 * A number counts as taken when EITHER name uses it:
 *
 *  - `defaultTitle`, because a renamed terminal still holds its number.
 *    Clearing a rename puts `defaultTitle` back (see `renameTab`), so two tabs
 *    handed the same one would collide the moment both were cleared — long
 *    after anything could explain why.
 *  - the visible `title`, because a restored layout carries the titles it was
 *    saved with while their `defaultTitle`s are renumbered from one. Saved
 *    "Terminal 1" and "Terminal 3" come back as defaults 1 and 2, and the next
 *    new terminal would then be shown as "Terminal 3" beside the restored one.
 */
function nextDefaultTitle(tabs, preferred = null) {
  const numberIn = (name) => {
    const match = /^Terminal (\d+)$/.exec(name || '');
    return match ? Number(match[1]) : null;
  };

  const taken = new Set();
  for (const tab of tabs || []) {
    for (const name of [tab?.defaultTitle, tab?.title]) {
      const n = numberIn(name);
      if (n !== null) taken.add(n);
    }
  }

  // A caller restoring a saved terminal asks to keep the number it had.
  const wanted = numberIn(preferred);
  if (wanted !== null && !taken.has(wanted)) return `Terminal ${wanted}`;

  let n = 1;
  while (taken.has(n)) n += 1;
  return `Terminal ${n}`;
}

/**
 * The default name for group `groupId` when its name is cleared: a "Group N"
 * no OTHER group is called, the way `nextDefaultTitle` numbers terminals.
 *
 * It used to be `Group ${position + 1}`, which reads its number off where the
 * group sits now — and groups move. Drag "Group 3" to the front, clear the
 * name of the group now second, and there were two "Group 2"s.
 *
 * A group already called "Group N" keeps N when nothing else uses it, so
 * clearing a default name leaves it as it was; otherwise it gets the lowest
 * number nobody uses.
 *
 * A group being made has no id yet (`null`), so every group there is counts
 * and it gets the lowest free number. New groups were numbered by how many
 * groups there were, which reused a number the moment one in the middle
 * closed: with Group 1, 2 and 3, close Group 2, make a new one, and there
 * were two "Group 3"s.
 */
function nextDefaultGroupName(groups, groupId) {
  const numberIn = (name) => {
    const match = /^Group (\d+)$/.exec(name || '');
    return match ? Number(match[1]) : null;
  };

  const taken = new Set();
  let own = null;
  for (const group of groups || []) {
    const n = numberIn(group?.name);
    if (group?.id === groupId) own = n;
    else if (n !== null) taken.add(n);
  }

  if (own !== null && !taken.has(own)) return `Group ${own}`;
  let n = 1;
  while (taken.has(n)) n += 1;
  return `Group ${n}`;
}

// The bootstrap still running, shared by every init() until it settles — see init.
let initInFlight = null;

/**
 * Drop the persistent xterm instance a closed tab owned (see
 * `components/terminal/terminalRegistry.js`). Guarded by `document` so this
 * store — imported directly by Node-run tests — never eagerly pulls in
 * `@xterm/addon-fit`, which throws (`self is not defined`) when evaluated
 * outside a browser-like environment.
 */
async function disposeTerminalView(tabId) {
  if (typeof document === 'undefined') return;
  try {
    const { disposeTerminal } = await import('../components/terminal/TerminalView.jsx');
    disposeTerminal(tabId);
  } catch (_) {
    // Terminal view module unavailable — nothing to dispose.
  }
}

/**
 * Clear a tab's xterm (`clearTerminal` in the registry). False where there is
 * none to clear — no document, as in the Node-run tests, or no view yet.
 */
async function clearTerminalView(tabId) {
  if (typeof document === 'undefined') return false;
  try {
    const { clearTerminal } = await import('../components/terminal/terminalRegistry.js');
    return clearTerminal(tabId);
  } catch (_) {
    return false;
  }
}

/**
 * Whether a tab's shell is cmd: the shell it reported, else the one it would
 * have been given (`shellPathOf`), named as the platform names it.
 */
function runsCmd(tab) {
  if (!tab) return false;
  const system = useSystemStore.getState();
  const shell = shellPathOf(tab, {
    defaultShell: useSettingsStore.getState().terminalDefaultShell,
    systemShell: system.defaultShell,
  });
  return shellKindFor(shell, system.os) === 'cmd';
}

/**
 * cmd's "Terminate batch job (Y/N)?" after a Ctrl+C, answered Y — the rules
 * and the reasons are src/lib/batchJobReply.js. Armed by `writeRaw`, which
 * every input to a shell goes through; the registry asks after each chunk of
 * output it writes (`awaitsBatchJobPrompt`, `answerBatchJobPrompt`). The
 * answer is typed like any key, through `writeRaw`. Everything is read as
 * each event comes: the setting, the tab's shell, the tab itself.
 */
const batchJobReplies = createBatchJobReplies({
  enabled: () => useSettingsStore.getState().terminalAutoReplyBatchJob !== false,
  isCmd: (tabId) => runsCmd(useTerminalStore.getState().tabs.find((t) => t.id === tabId)),
  reply: (tabId, text) => useTerminalStore.getState().writeRaw(tabId, text),
});

/** A machine left running overnight must not grow this without bound. */
const NOTIFICATION_LIMIT = 50;

/** Tells apart two program notifications for one tab in the same millisecond. */
let programNoteCounter = 0;

// ---------------------------------------------------------------------------
// Attention: which terminal is waiting for you (src/lib/attention.js)
// ---------------------------------------------------------------------------

/**
 * Whether the window has the keyboard and can be seen, asked whenever a rule
 * needs to know whether the user is looking — `windowAttention`, unless a
 * suite has said otherwise (`__setAttentionSource`).
 */
let attentionSource = () => windowAttention();

/** The window's focus and visibility now, never throwing. */
function currentAttention() {
  try {
    return attentionSource() || { focused: false, visible: false };
  } catch {
    return { focused: false, visible: false };
  }
}

/** For the suites: what the store takes the window's focus to be. Returns the previous source. */
export function __setAttentionSource(source) {
  const previous = attentionSource;
  attentionSource = typeof source === 'function' ? source : () => windowAttention();
  return previous;
}

const monotonicNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * How long a pane's ring flashes when a notification or a bell is aimed at
 * the terminal being typed into and `terminalAttentionFlashFocused` is on:
 * once, about this long, and nothing recorded.
 */
export const ATTENTION_FLASH_MS = 1200;
let attentionFlashMs = ATTENTION_FLASH_MS;

/** For the suites: a shorter flash. Returns the previous length. */
export function __setAttentionFlashMs(ms) {
  const previous = attentionFlashMs;
  attentionFlashMs = ms;
  return previous;
}

/** tab id -> the timer that ends its flash. */
const flashTimers = new Map();
/** Each flash is numbered, so a second one restarts the first rather than being taken for it. */
let flashCounter = 0;

/**
 * tab id -> its bell's rate limit (`createRateLimiter`, the program
 * notifications' own numbers): a program ringing in a loop — or a file of
 * BELs `cat`-ed — costs one entry at most every two seconds, ten a minute.
 */
const bellLimiters = new Map();
/**
 * tab id -> the rate limit of its bell's flashes (`terminalAttentionFlashFocused`),
 * an allowance of its own: what a shell rings at the terminal being typed
 * into must not use up what the bell needs once you are elsewhere.
 */
const flashLimiters = new Map();
/** Tells apart two bell entries for one tab in the same millisecond. */
let bellCounter = 0;

/**
 * How long rings the rate limit refused wait before they are added to their
 * bell entry's count, in one update (`foldRings`): the rate limit's own two
 * seconds, so a terminal ringing nonstop costs one write for the rings it
 * was let through and one for the rest, every two seconds at most.
 */
export const BELL_FOLD_MS = 2000;
let bellFoldMs = BELL_FOLD_MS;

/** For the suites: a shorter wait. Returns the previous one. */
export function __setBellFoldMs(ms) {
  const previous = bellFoldMs;
  bellFoldMs = ms;
  return previous;
}

/**
 * tab id -> rings refused by its bell's rate limit, held rather than lost:
 * `{ id, rings, at, timer }`. With `id`, they rang while that entry was
 * unread and are added to its count; with `id` null, nothing was waiting to
 * be seen when they rang, and they are listed as an entry of their own at
 * the next moment the limit allows. "Bell ×2" for six rings was a count of
 * what got through the limit, not of what rang; and a ring just after the
 * entry was read went nowhere at all.
 */
const bellFolds = new Map();

/** The bell's rate-limit clock: monotonic. The suites put their own in (`__setBellClock`). */
let bellClock = () => monotonicNow();

/** For the suites: the bell's clock. Returns the previous one. */
export function __setBellClock(clock) {
  const previous = bellClock;
  bellClock = typeof clock === 'function' ? clock : () => monotonicNow();
  return previous;
}

/**
 * Whether a pointer button is down anywhere in the window (`notePointer`,
 * from src/hooks/useAttention.js). While it is, the seen rule holds what it
 * would mark read until the button is let go: a press on a chip or a pane
 * makes its tab active on the way DOWN, and reading it then took its pill
 * away and moved every chip after it before the button came UP — the click
 * landed on the neighbour. Explicit actions — the jump, an entry clicked,
 * Mark All Read — are not held.
 */
let pointerPressed = false;
/** Whether the seen rule wanted to read the active tab during the press. */
let seenOnRelease = false;
let pointerSafetyTimer = null;

/**
 * How long a press may last before its release is assumed: an up the window
 * never heard (it went to another application, the webview lost it) must
 * not hold the seen rule for good.
 */
export const POINTER_SAFETY_MS = 1500;
let pointerSafetyMs = POINTER_SAFETY_MS;

/** For the suites: a shorter wait for a lost release. Returns the previous one. */
export function __setPointerSafetyMs(ms) {
  const previous = pointerSafetyMs;
  pointerSafetyMs = ms;
  return previous;
}

/** The unread bell entry of `tabId`, or undefined. */
const unreadBellOf = (notifications, tabId) =>
  notifications.find((n) => n?.kind === 'bell' && n.tabId === tabId && isUnread(n));

/** `tabId`'s bell rate limit, made on first use. */
function bellLimiterOf(tabId) {
  let limiter = bellLimiters.get(tabId);
  if (!limiter) {
    limiter = createRateLimiter();
    bellLimiters.set(tabId, limiter);
  }
  return limiter;
}

/**
 * tab id -> the pacing of its progress bar (`createLatestThrottle`): at most
 * ten updates a second, the last report winning.
 */
const progressThrottles = new Map();
let progressIntervalMs = PROGRESS_INTERVAL_MS;

/** For the suites: another pace for progress bars made from now on. Returns the previous one. */
export function __setProgressIntervalMs(ms) {
  const previous = progressIntervalMs;
  progressIntervalMs = ms;
  return previous;
}

/**
 * For the suites: how many tabs the attention state keeps something for
 * outside the store — flash timers, bell rate limits, progress pacing —
 * which the store's own state cannot show.
 */
export function __attentionKept() {
  return {
    flashTimers: flashTimers.size,
    bellLimiters: bellLimiters.size,
    flashLimiters: flashLimiters.size,
    bellFolds: bellFolds.size,
    progressThrottles: progressThrottles.size,
  };
}

/** Stop whatever bar update `tabId` is holding back. */
function cancelProgress(tabId) {
  progressThrottles.get(tabId)?.cancel();
}

/**
 * Run `fn` once `tabId`'s terminal has read all the output it has been
 * handed so far — set by the registry (`setTerminalOutputBarrier`); at once
 * where there is no terminal, as in the Node-run suites.
 *
 * The end of a command is the backend's to report (OSC 133 never reaches
 * xterm), and it reports it right after the output that came before it. But
 * xterm reads what it is given a task later, so a progress report in that
 * last output — `printf '\e]9;4;1;50\a'`, a program killed mid-bar — was
 * read only after the bar had been taken down, and put it back up over the
 * prompt for good. Taken down behind the output instead, it goes after
 * everything the command printed and before anything the next one does.
 */
let afterTerminalOutput = (_tabId, fn) => fn();

/**
 * For the registry: how to wait for a terminal to have read its output (see
 * `afterTerminalOutput`). Returns the previous one, for the suites.
 */
export function setTerminalOutputBarrier(barrier) {
  const previous = afterTerminalOutput;
  afterTerminalOutput = typeof barrier === 'function' ? barrier : (_tabId, fn) => fn();
  return previous;
}

/** Take `tabId`'s bar down, and drop any update it is holding back. */
function dropProgress(tabId) {
  cancelProgress(tabId);
  useTerminalStore.setState((s) => {
    const progress = withoutProgress(s.progress, [tabId]);
    return progress === s.progress ? s : { progress };
  });
}

/** Take the bars of `tabIds` down once each terminal has read what it was given. */
function dropProgressAfterOutput(tabIds) {
  for (const tabId of tabIds) {
    try {
      afterTerminalOutput(tabId, () => dropProgress(tabId));
    } catch {
      dropProgress(tabId);
    }
  }
}

/** `progress` without the bars of `tabIds` — the same object when none of them had one. */
function withoutProgress(progress, tabIds) {
  const ids = [...tabIds].filter((id) => progress && Object.prototype.hasOwnProperty.call(progress, id));
  if (ids.length === 0) return progress;
  const next = { ...progress };
  for (const id of ids) delete next[id];
  return next;
}

/**
 * Give `tabId`'s terminal the keyboard: the registry's `focusTerminalView`,
 * through a dynamic import as `disposeTerminalView` is, so this store never
 * loads xterm in Node. The suites put their own in (`__setTerminalFocus`).
 */
let focusTerminalOf = (tabId) => {
  if (typeof document === 'undefined') return;
  import('../components/terminal/terminalRegistry.js')
    .then(({ focusTerminalView }) => focusTerminalView?.(tabId))
    .catch(() => {
      // No terminal view to focus — nothing else to do.
    });
};

/** For the suites: what gives a terminal the keyboard. Returns the previous one. */
export function __setTerminalFocus(focus) {
  const previous = focusTerminalOf;
  focusTerminalOf = focus;
  return previous;
}

/**
 * Give `tabId`'s terminal the keyboard once the switch to it has been drawn
 * — a frame later, when its pane is on the page; TerminalView focuses a pane
 * that BECOMES active by itself, but not one that already was, in a window
 * that was elsewhere. Left alone when the find bar is open on that terminal
 * (it owns the caret, as TerminalView leaves it), and when something else
 * became the active tab meanwhile.
 */
function focusTerminalSoon(tabId) {
  const later = typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 0);
  later(() => {
    const { activeTabId, find } = useTerminalStore.getState();
    if (activeTabId !== tabId || (find?.open && find.tabId === tabId)) return;
    try {
      focusTerminalOf(tabId);
    } catch (err) {
      console.warn('[TerminalStore] could not focus the terminal:', err);
    }
  });
}

export const useTerminalStore = create((set, get, api) => {
  /**
   * Where a new terminal starts, for EVERY way of making one: the directory
   * asked for, else the `terminal.integrated.cwd` setting, else `null` for
   * the backend's own fallback — see `resolveStartDir`. New Group and the
   * first terminal of a fresh start used to decide for themselves, and never
   * saw the setting.
   *
   * The home directory comes from the backend, which the status bar asks at
   * startup in a race with the first terminal — a race the terminal can win.
   * `resolveStartDir` then falls back rather than guess, and a `home` or
   * `~/…` setting quietly opened somewhere else. So when the answer depends on
   * the home directory and it has not arrived yet, it is asked for first.
   * Whether it depends is put to `resolveStartDir` itself — does a different
   * home give a different answer? — rather than restated here, and nothing
   * else waits: the default `workspace` setting never costs a round trip.
   */
  const startDirFor = async (requested) => {
    const settings = useSettingsStore.getState();
    const input = {
      requested,
      mode: settings.terminalDefaultCwd,
      customPath: settings.terminalDefaultCwdPath,
      activeCwd: get().getActiveTab()?.cwd ?? null,
    };
    const resolveWith = (homeDir) => resolveStartDir({ ...input, homeDir });
    if (!useSystemStore.getState().homeDir && resolveWith('/a') !== resolveWith('/b')) {
      await useSystemStore.getState().init();
    }
    return resolveWith(useSystemStore.getState().homeDir);
  };

  /**
   * Spawn a PTY-backed tab and register it in `tabs`, WITHOUT placing it
   * anywhere in any group — callers decide where it goes. Keeping placement
   * out of tab creation is what makes two-level placement easy: `splitPane`
   * can put the new tab only in the freshly-created pane of one group,
   * instead of it also lingering wherever focus happened to be when the PTY
   * finished spawning.
   */
  const spawnTab = async (title = null, cwd = null, shell = null) => {
    // A terminal asked for while the store is starting — the empty pane's New
    // Terminal, a shortcut, the menu — is made once the start is over. Made
    // beside it, it was dropped when the restore put its layout in place, its
    // shell left running; it could take the id of a terminal being restored,
    // as the counter moves past the saved ids only once they are all back;
    // and one asked for before the start had reaped the previous page's
    // shells was reaped with them. A start that fails lets it through all
    // the same.
    if (initInFlight) await initInFlight.catch(() => {});
    try {
      // Nothing asked for a directory -> the `terminal.integrated.cwd`
      // setting decides, and `null` hands it back to the backend's own
      // fallback (open folder, then home). A directory that WAS asked for —
      // which is what restoring a session does for every terminal — wins over
      // both. See `startDirFor`.
      const startDir = await startDirFor(cwd);
      // A profile picked for THIS terminal wins over the default setting.
      // `resolve_shell` takes a name or a path, so a profile is just a spec.
      const shellSpec = shell || useSettingsStore.getState().terminalDefaultShell;
      const spawnAt = (dir) => invoke('pty_spawn', { cols: 80, rows: 24, cwd: dir, shell: shellSpec });

      let ptySession;
      try {
        ptySession = await spawnAt(startDir);
      } catch (err) {
        // A directory can exist and still refuse the shell — no permission to
        // enter it, a path too long for Windows. The backend only checks that
        // it IS a directory, so the spawn is where that surfaces. A missing
        // directory already falls back; an unusable one does the same, rather
        // than a setting pointing there costing every new terminal.
        if (startDir === null) throw err;
        console.warn(`[TerminalStore] Could not start a terminal in "${startDir}" — using the default directory:`, err);
        ptySession = await spawnAt(null);
      }

      // A caller may ask for a title: `materializeGroup` and `loadSavedGroup`
      // pass the one the terminal had when it was saved. When that title is a
      // default `Terminal N` name its number is a PREFERENCE, not a claim —
      // the tab keeps it while it is free and takes the next free number when
      // it is not. Loading a saved group beside a live "Terminal 1" used to
      // put a SECOND visible "Terminal 1" in the strip, because uniqueness was
      // only ever enforced on `defaultTitle` while `title` was forced through
      // untouched. A title the user typed is never renumbered.
      const wantedNumber = isDefaultTitle(title) ? title : null;
      const defaultTitle = nextDefaultTitle(get().tabs, wantedNumber);
      const newTab = {
        id: makeTabId(),
        title: wantedNumber ? defaultTitle : title || defaultTitle,
        defaultTitle,
        sessionId: ptySession.session_id,
        cwd: ptySession.cwd || get().cwd,
        agent: null,
        agentResumeOffered: false,
        // What the backend actually ran, not what was asked for. The status
        // bar names the active terminal's shell, and once terminals can differ
        // a bar reading the global SETTING would be wrong for every terminal
        // but one — the same way it once claimed a git branch it never read.
        shell: ptySession.shell || null,
        // Stated rather than left undefined: `tabActivity` reads both, and a
        // restored tab gets a NEW shell, so neither may survive a respawn.
        running: false,
        lastExitCode: null,
        // When this shell started: how long an agent waits for its first
        // prompt is counted from here (see `untilPromptReady`).
        spawnedAt: Date.now(),
      };

      set((state) => ({ tabs: [...state.tabs, newTab] }));
      return newTab;
    } catch (err) {
      console.error('[TerminalStore] Failed to create terminal tab:', err);
      return null;
    }
  };

  /**
   * Wait until `tabId`'s shell has drawn its first prompt, which it says with
   * the first OSC 133 "D" its session reports. Resolves with:
   *
   *   'ready'   it has, now or earlier
   *   'timeout' it has not, AGENT_PROMPT_WAIT_MS after the shell started —
   *             for fish or sh, which send no D, that is every time
   *   'gone'    the tab closed, or its shell exited or was replaced, first
   */
  const untilPromptReady = (tabId) =>
    new Promise((resolve) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      const sessionId = tab?.sessionId;
      const readiness = (state) => {
        const now = state.tabs.find((t) => t.id === tabId);
        if (!now || now.sessionId !== sessionId || now.exited) return 'gone';
        return endsOf(sessionId) > 0 ? 'ready' : null;
      };
      const already = readiness(get());
      const left = (tab?.spawnedAt ?? 0) + agentPromptWaitMs - Date.now();
      if (already || left <= 0) {
        resolve(already || 'timeout');
        return;
      }
      const finish = (result) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const timer = setTimeout(() => finish('timeout'), left);
      const unsubscribe = api.subscribe((state) => {
        const result = readiness(state);
        if (result) finish(result);
      });
    });

  /**
   * Remember that `agent` is being typed into `tabId`, right before it is.
   *
   * With `atPrompt` — the shell has drawn a prompt, so the line runs as soon
   * as it arrives — the agent is watched: the first D after this write that
   * arrives while the terminal is running something is the agent exiting,
   * and ends the record (see `pty-command-done`). The watch goes on HERE,
   * right before the write and with nothing that can come between them, so
   * every D it sees is one that came after the write. Without a prompt to go
   * by, nothing says where the typed line stands, so nothing is watched and
   * the record stays, as it always did.
   */
  const recordAgent = (tabId, agent, atPrompt) => {
    // A new record has seen no title yet (`noteAgentTitle`).
    shownTitles.delete(tabId);
    resolveMisses.delete(tabId);
    idHints.delete(tabId);
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              agent,
              agentResumeOffered: false,
              agentResumeNotice: null,
              agentTyped: atPrompt ? { sessionId: t.sessionId } : null,
            }
          : t
      ),
    }));
  };

  /**
   * Follow one write to `tab`'s terminal (`followCommandLine`) and, when it
   * submits a line at the prompt, remember it as the tab's `commandLine` —
   * null for a line that cannot be read back. Only a submission touches the
   * store, and only when it changes something: this runs for every key.
   */
  const followTyping = (tab, data) => {
    const { line, submitted } = followCommandLine(typedLines.get(tab.id), data, {
      running: Boolean(tab.running),
    });
    typedLines.set(tab.id, line);
    if (submitted === undefined) return;
    if (typeof submitted === 'string') noteTypedAgent(tab, submitted);
    if ((tab.commandLine ?? null) === submitted) return;
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, commandLine: submitted } : t)),
    }));
  };

  /**
   * An agent typed by hand at the prompt — `opencode`, `claude`, a layout
   * template's `opencode -c` — remembered exactly as if NexTerm had started
   * it: watched from this line on, so its exit ends the record, and offered
   * back after a restart if it is still running when the app closes.
   *
   * Not over a record that is live — believed to be running (`agentRuns`):
   * NexTerm records its own agents (`startAgent`, `resumeAgent`) before
   * typing them, and this sees that line too. A record still being OFFERED is
   * replaced — the user started the agent themselves instead of pressing
   * Resume. So is one nothing watches: typed blind into a shell whose first
   * prompt came too late (conda, nvm), that agent's exit could never end its
   * record, and every agent typed by hand after it went unrecorded and
   * unnamed. And not in a shell that has never reported a command's end
   * (fish, sh): nothing could ever end the record, and an agent long gone
   * would be offered back on every launch.
   */
  const noteTypedAgent = (tab, line) => {
    if (tab.agent && !tab.agentResumeOffered && agentRuns(tab)) return;
    if (endsOf(tab.sessionId) === 0) return;
    const typed = agentFromCommandLine(line);
    if (!typed) return;
    recordAgent(tab.id, { kind: typed.kind, sessionId: typed.sessionId, startedAt: Date.now(), title: null }, true);
  };

  /**
   * The directory `tab`'s conversations are listed for: its own, spelled so
   * Windows can open it (`startableCwd` — Git Bash's `/c/x` is `C:\x`, which
   * is what opencode keeps), or '' for none. One on another machine is
   * handed over as it is: the backend compares it by its spelling and never
   * runs anything there (`run_dir` in src-tauri/src/commands/agent.rs).
   */
  const lookupFolder = (tab) => {
    const cwd = typeof tab?.cwd === 'string' ? tab.cwd.trim() : '';
    return isNetworkPath(cwd) ? cwd : startableCwd(tab, useSystemStore.getState().os) || '';
  };

  /** The same folder, by `folderKey`, for telling which terminals share one. */
  const sameFolder = (a, b) => {
    const key = folderKey(lookupFolder(a) || a?.cwd);
    return key !== '' && key === folderKey(lookupFolder(b) || b?.cwd);
  };

  /** Whether `tab` runs, or offers back, an opencode that does not know its conversation's id. */
  const unsureOpencode = (tab) => tab?.agent?.kind === 'opencode' && !isSessionIdFor('opencode', tab.agent.sessionId);

  /** `opencode session list` for `cwd`, the conversations with ids that may be typed. Rejects with the reason. */
  const listOpencodeSessions = async (cwd) => {
    const sessions = await invoke('agent_sessions', { kind: 'opencode', cwd });
    return Array.isArray(sessions) ? sessions.filter((x) => isSessionIdFor('opencode', x?.id)) : [];
  };

  /**
   * The conversation ids other terminals hold, each with the terminal that
   * holds it: in its record — running there, or offered back there — or as
   * the id its record let go of on a new title (`idHints`). By id alone,
   * whatever the folder: ids are opencode's own and unique.
   */
  const holdersElsewhere = (state, tabId) => {
    const holders = new Map();
    const hold = (id, ownerId) => {
      if (ownerId === tabId || holders.has(id)) return;
      holders.set(id, state.tabs.find((t) => t.id === ownerId) ?? null);
    };
    for (const t of state.tabs) {
      if (t.agent?.kind === 'opencode' && isSessionIdFor('opencode', t.agent.sessionId)) hold(t.agent.sessionId, t.id);
    }
    for (const [ownerId, id] of idHints) hold(id, ownerId);
    return holders;
  };

  /** The ids no pick for `tabId` may take (`holdersElsewhere`). */
  const sessionsHeldElsewhere = (state, tabId) => new Set(holdersElsewhere(state, tabId).keys());

  /** What to call a terminal that holds something, in a message. */
  const nameOf = (tab) => tab?.title || tab?.defaultTitle || 'another terminal';

  /**
   * How many terminals in `tab`'s folder show `title` (or offer it back)
   * without knowing which conversation it is — `tab` included. More than
   * one, and `pickOpencodeSession` picks none.
   */
  const contendersFor = (state, tab, title) =>
    state.tabs.filter(
      (t) => t.id === tab.id || (unsureOpencode(t) && sameFolder(t, tab) && opencodeTitlesAlike(t.agent.title, title))
    ).length;

  /** `tab`'s folder as `foldersOverlap` compares them. */
  const folderKeyOf = (tab) => folderKey(lookupFolder(tab) || tab?.cwd);

  /**
   * Whether `tabId` is the one opencode terminal within `--continue`'s
   * reach: no other one in its folder, a folder above it or one below it
   * (`foldersOverlap`) offers a conversation back, runs one, or was resumed
   * there since the workspace came back. Only then may `--continue` be typed
   * for it: that is the most recent conversation in the folder or below — a
   * whole repository from its root — so such a terminal could be the one
   * whose conversation it is. Terminals in unrelated folders do not count.
   */
  const aloneInReach = (state, tabId) => {
    const here = folderKeyOf(state.tabs.find((t) => t.id === tabId));
    return (
      !state.tabs.some((t) => t.id !== tabId && t.agent?.kind === 'opencode' && foldersOverlap(here, folderKeyOf(t))) &&
      ![...opencodeResumers].some(([id, folder]) => id !== tabId && foldersOverlap(here, folder))
    );
  };

  /**
   * Look again, later, for the conversation of a title whose lookup failed
   * or found nothing — on AGENT_RESOLVE_RETRY_MS, while that record still
   * shows that title. A new title starts its own count (`noteAgentTitle`);
   * the agent exiting, the terminal closing or a new record ends it.
   */
  const retryResolve = (tabId, agent, shown) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || tab.agent !== agent || tab.agentResumeOffered || shownTitles.get(tabId) !== shown) return;
    const misses = resolveMisses.get(tabId);
    const count = misses?.shown === shown ? misses.count : 0;
    if (count >= agentResolveRetryMs.length) return;
    resolveMisses.set(tabId, { shown, count: count + 1 });
    clearTimeout(resolveTimers.get(tabId));
    resolveTimers.set(
      tabId,
      setTimeout(() => {
        resolveTimers.delete(tabId);
        resolveAgentSession(tabId);
      }, agentResolveRetryMs[count])
    );
  };

  /**
   * Find the opencode conversation `tabId` shows, from the title it shows
   * (`shownTitles`): `opencode session list`, narrowed to the terminal's
   * directory by the backend, then `pickOpencodeSession` — never one another
   * terminal holds, and none at all while another terminal that does not
   * know its conversation shows a title like it. Written onto the record
   * only if it is still the one the lookup was made for and that title still
   * shows — a quicker switch, or the agent exiting, wins. Failed or
   * empty-handed, it is tried again (`retryResolve`).
   *
   * Everything after the answer — what is held, the rivals, the write — is
   * one synchronous step, so two lookups answered together cannot both take
   * the same conversation.
   */
  const resolveAgentSession = async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const agent = tab?.agent;
    const shown = shownTitles.get(tabId);
    const cwd = tab ? lookupFolder(tab) : '';
    if (!agent || agent.kind !== 'opencode' || tab.agentResumeOffered || !shown || !cwd) return;
    let sessions;
    try {
      sessions = await listOpencodeSessions(cwd);
    } catch (err) {
      // opencode not found from here, a CLI that changed its output, a
      // database busy for a moment. Said once per reason, and tried again;
      // a restart that still has no id looks again when Resume is pressed.
      reportLookupFailure(lookupFailureOf(err));
      retryResolve(tabId, agent, shown);
      return;
    }
    const state = get();
    const now = state.tabs.find((t) => t.id === tabId);
    if (!now || now.agent !== agent || shownTitles.get(tabId) !== shown) return;
    const picked = pickOpencodeSession(sessions, {
      title: shown,
      // Its own id, or the one it let go of on this new title (`idHints`):
      // still its conversation if that is renamed to it.
      currentId: agent.sessionId ?? idHints.get(tabId) ?? null,
      taken: sessionsHeldElsewhere(state, tabId),
      contenders: contendersFor(state, now, shown),
    });
    if (!picked) {
      retryResolve(tabId, agent, shown);
      return;
    }
    resolveMisses.delete(tabId);
    idHints.delete(tabId);
    const title = cleanAgentTitle(picked.title) ?? agent.title;
    if (agent.sessionId === picked.id && agent.title === title) return;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId && t.agent === agent ? { ...t, agent: { ...agent, sessionId: picked.id, title } } : t)),
    }));
  };

  /**
   * The resume a pick from the banner's list asks for, or null for none:
   * `{ sessionId, title }` that conversation — its id held to the same
   * standard as a remembered one before it reaches the shell — `{ latest:
   * true }` the folder's most recent (`--continue`), `{ fresh: true }` a new
   * one. With `continued` for `--continue`.
   */
  const chosenResume = (agent, choice) => {
    if (!choice || !agent || !isKnownAgent(agent.kind)) return null;
    if (choice.fresh === true) return startCommand(agent.kind);
    if (choice.latest === true) {
      const next = { ...agent, sessionId: null };
      return { agent: next, command: resumeCommand(next), continued: true };
    }
    if (!isSessionIdFor(agent.kind, choice.sessionId)) return null;
    const next = { ...agent, sessionId: choice.sessionId, title: cleanAgentTitle(choice.title) };
    return { agent: next, command: resumeCommand(next) };
  };

  /**
   * Who already has what a pick from the list asks for — the terminal, for
   * the banner to name — or undefined when nobody does. A conversation open
   * in another terminal (`holdersElsewhere`), or, for `{ latest: true }`,
   * the most recent one another terminal within reach continued this run
   * (`foldersOverlap`): either typed
   * here would put two terminals in one conversation. A list picks on Enter,
   * and one pressed in the wrong list did exactly that (review, 2026-10-13).
   */
  const takenByOther = (state, tabId, choice) => {
    if (choice?.latest === true) {
      const here = folderKeyOf(state.tabs.find((t) => t.id === tabId));
      const other = [...continuedLatest].find(([id, folder]) => id !== tabId && foldersOverlap(here, folder));
      return other === undefined ? undefined : nameOf(state.tabs.find((t) => t.id === other[0]));
    }
    if (!isSessionIdFor('opencode', choice?.sessionId)) return undefined;
    const holders = holdersElsewhere(state, tabId);
    return holders.has(choice.sessionId) ? nameOf(holders.get(choice.sessionId)) : undefined;
  };

  /**
   * Whether Resume in `tab` has to look its opencode conversation up first:
   * the record has no id, or another terminal has its id — running it now,
   * resumed into it already, or holding it while a new title is looked up
   * (`holdersElsewhere`); not one merely offering it back too. Two records
   * with one id are what the same-title pick of earlier builds left on disk:
   * the first to resume keeps it, and the other finds its own by title.
   * claude never does.
   */
  const needsLookup = (state, tab) => {
    const agent = tab?.agent;
    if (agent?.kind !== 'opencode') return false;
    if (!isSessionIdFor('opencode', agent.sessionId)) return true;
    const holder = holdersElsewhere(state, tab.id).get(agent.sessionId);
    return Boolean(holder) && !holder.agentResumeOffered;
  };

  /**
   * Take the offer in `tabId` for `agent`, the record about to be typed: the
   * offer goes, and the record becomes that conversation — which other
   * terminals' picks then leave alone (`holdersElsewhere`) — or, for
   * `continued`, the folder's most recent (`continuedLatest`). One step,
   * made in the same turn as the decision it carries out: a Resume decided
   * in another terminal next, even one whose answer arrived together with
   * this one's, sees the conversation as taken.
   */
  const takeOffer = (tabId, agent, { continued = false } = {}) => {
    if (agent?.kind === 'opencode') {
      const folder = folderKeyOf(get().tabs.find((t) => t.id === tabId));
      opencodeResumers.set(tabId, folder);
      if (continued) continuedLatest.set(tabId, folder);
    }
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, agent, agentResumeOffered: false, agentResumeNotice: null } : t
      ),
    }));
  };

  /**
   * Decide Resume for an opencode terminal that has to look its conversation
   * up (`needsLookup`): read the folder's list, then `planOpencodeResume`.
   * Resolves with `{ agent, command, note? }` to type — `note` a line for
   * the terminal saying why it is the folder's most recent — or null with
   * nothing to type: the user is asked (the offer stays, with
   * `agentResumeNotice` saying why), or the terminal changed meanwhile —
   * dismissed, closed, something started in it, an agent typed by hand.
   *
   * While the list is read the banner says so and takes no second press
   * (`agentResumeLooking`). The decision after it is one synchronous step
   * with the read of what other terminals hold, as in `resolveAgentSession`:
   * Resume pressed in four terminals at once hands out four conversations.
   */
  const lookUpResume = async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const agent = tab?.agent;
    if (!agent) return null;
    const cwd = lookupFolder(tab);
    const mark = (fields) =>
      set((state) => ({ tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...fields } : t)) }));
    mark({ agentResumeLooking: true, agentResumeNotice: null });
    let sessions = null;
    let failure = null;
    try {
      if (!cwd) failure = 'this terminal is in no folder on this machine to look in';
      else sessions = await listOpencodeSessions(cwd);
    } catch (err) {
      failure = lookupFailureOf(err);
      reportLookupFailure(failure);
    } finally {
      mark({ agentResumeLooking: false });
    }

    const state = get();
    const now = state.tabs.find((t) => t.id === tabId);
    if (!now || now.agent !== agent || !now.agentResumeOffered || now.running) return null;
    const alone = aloneInReach(state, tabId);
    const plan = planOpencodeResume({
      title: agent.title,
      sessions,
      taken: sessionsHeldElsewhere(state, tabId),
      contenders: contendersFor(state, now, agent.title),
      alone,
    });
    if (plan.session) {
      const next = { ...agent, sessionId: plan.session.id, title: cleanAgentTitle(plan.session.title) ?? agent.title };
      takeOffer(tabId, next);
      return { agent: next, command: resumeCommand(next) };
    }
    const label = agentLabel(agent.kind);
    if (plan.latest) {
      const next = { ...agent, sessionId: null };
      // Said in the terminal: why it is the most recent rather than its own.
      const named = agent.title ? `\u{201C}${agent.title}\u{201D}` : null;
      let note = null;
      if (failure) {
        note = `${label}\u{2019}s conversations could not be listed (${failure}), so this continues the most recent one in this folder or below.`;
      } else if (sessions.length === 0) {
        note = `${label} lists no conversation for this folder (${cwd}), so this continues the most recent one in this folder or below.`;
      } else if (named) {
        note = `None of this folder\u{2019}s ${label} conversations is called ${named} any more, so this continues the most recent one in this folder or below.`;
      }
      takeOffer(tabId, next, { continued: true });
      return { agent: next, command: resumeCommand(next), note, continued: true };
    }
    mark({
      agentResumeNotice: {
        kind: plan.choose,
        reason: failure,
        shared: !alone,
        // A new notice each time, so the banner opens its list again for it.
        seq: (noticeSeq += 1),
      },
    });
    return null;
  };

  /**
   * Forget a closed terminal: its conversation bookkeeping, and that it was
   * resumed this run — closed, it reaches no conversation `--continue` could
   * take from it.
   */
  const forgetTerminal = (tabId) => {
    forgetAgentTitle(tabId);
    opencodeResumers.delete(tabId);
    continuedLatest.delete(tabId);
  };

  /** Forget a terminal's conversation bookkeeping: it closed, or its agent ended. */
  const forgetAgentTitle = (tabId) => {
    shownTitles.delete(tabId);
    resolveMisses.delete(tabId);
    idHints.delete(tabId);
    clearTimeout(resolveTimers.get(tabId));
    resolveTimers.delete(tabId);
  };

  /**
   * Freeze one group into something storable: its layout with the live tab
   * ids swapped for stable slot ids, and each terminal's title and CURRENT
   * directory (the live OSC 7 cwd, not the one it was opened at).
   *
   * And, where there is one, the command the terminal offers as its startup
   * command (`suggestStartupCommand`): the one it was opened with from a
   * template, else the agent or the command running in it right now — never
   * an idle shell's last command. That is the template's default; "Edit
   * Startup Commands…" changes it. A terminal with none keeps exactly the
   * slot shape every saved group always had.
   */
  const snapshotGroup = (state, group) => {
    const slotByTabId = new Map();
    const tabs = [];
    for (const leaf of collectLeaves(group.tree)) {
      for (const tabId of leaf.tabIds) {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab) continue;
        const slotId = `slot-${tabs.length}`;
        slotByTabId.set(tabId, slotId);
        const slot = { slotId, title: tab.title, cwd: tab.cwd };
        const command = suggestStartupCommand(tab);
        tabs.push(command ? { ...slot, command } : slot);
      }
    }
    if (tabs.length === 0) return null;
    return {
      name: group.name,
      tabs,
      activePaneId: group.activePaneId,
      tree: remapTreeTabIds(group.tree, slotByTabId),
    };
  };

  /**
   * Turn a snapshot back into a live group: one shell per slot, the saved
   * layout rebuilt around them, fresh pane ids so loading the same snapshot
   * twice cannot collide.
   *
   * `startups` is each new terminal's startup command, `{ tabId, command }`,
   * for the caller to hand to `runStartupCommands` once the group is in
   * place. Nothing is typed from here.
   */
  const materializeGroup = async (entry, fallbackName = 'Saved group') => {
    if (!entry || !Array.isArray(entry.tabs) || entry.tabs.length === 0) return null;

    const bySlot = new Map();
    const spawned = [];
    const startups = [];
    for (const saved of entry.tabs) {
      const tab = await spawnTab(saved.title, saved.cwd);
      if (!tab) continue;
      spawned.push(tab);
      if (saved.slotId) bySlot.set(saved.slotId, tab.id);
      const command = startupCommandOf(saved);
      if (command) startups.push({ tabId: tab.id, command });
    }
    if (spawned.length === 0) return null;

    let tree = entry.tree ? remapTreeTabIds(entry.tree, bySlot) : null;
    const paneIdMap = new Map();
    tree = tree ? regeneratePaneIds(tree, paneIdMap) : null;
    tree = normalizeTree(pruneTree(tree));
    if (!tree) {
      tree = {
        type: 'leaf',
        id: makePaneId(),
        tabIds: spawned.map((t) => t.id),
        activeTabId: spawned[0].id,
      };
    }

    // A slot the tree never referenced would leave a live shell with nowhere
    // to show — park it rather than leaking it.
    const placed = new Set(collectLeaves(tree).flatMap((l) => l.tabIds));
    for (const t of spawned) {
      if (!placed.has(t.id)) tree = addTabToPane(tree, firstLeafId(tree), t.id);
    }

    const activePaneId = paneIdMap.get(entry.activePaneId);
    const leaves = collectLeaves(tree);
    return {
      group: {
        id: makeGroupId(),
        name: entry.name || fallbackName,
        createdAt: Date.now(),
        tree,
        activePaneId: leaves.some((l) => l.id === activePaneId) ? activePaneId : firstLeafId(tree),
      },
      spawned,
      startups,
    };
  };

  /**
   * Start typing every startup command of a template just opened, each into
   * its own terminal and each on its own schedule (see `typeStartupCommand`).
   * Not awaited by the loaders: the terminals are on screen already, and one
   * shell that never reports a prompt must not hold up anything else.
   */
  const runStartupCommands = (startups) =>
    Promise.all(
      (startups || []).map(({ tabId, command }) =>
        get()
          .typeStartupCommand(tabId, command)
          .catch((err) => {
            console.warn('[TerminalStore] could not type a startup command:', err);
            return false;
          })
      )
    );

  /** Kill a tab's PTY and drop it, unless some pane in some group still shows it. */
  const killTabIfOrphaned = async (tabId) => {
    if (groupOfTab(get(), tabId)) return;
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    closingTabs.add(tabId);
    try {
      try {
        await invoke('pty_kill', { session_id: tab.sessionId });
      } catch (e) {
        console.warn('[TerminalStore] pty_kill failed:', e);
      }
      await disposeTerminalView(tabId);
      typedLines.delete(tabId);
      forgetTerminal(tabId);
      batchJobReplies.forget(tabId);
      // Whatever its shell printed that no terminal ever showed goes with it, as
      // in `closeTab`. Closing a pane, a group or the whole workspace comes this
      // way, and a tab of theirs never brought forward kept up to BACKLOG_LIMIT
      // characters for the life of the app.
      forgetOutput(tab.sessionId);
      set((state) => settle(state, { tabs: state.tabs.filter((t) => t.id !== tabId) }));
    } finally {
      closingTabs.delete(tabId);
    }
  };

  /**
   * Spawn one fresh PTY per saved tab (processes cannot be restored) and
   * rebuild every saved group around the new tab ids. Throws if nothing
   * usable could be restored — the caller falls back to the single-terminal
   * default in that case. Takes a v2 payload; a v1 one is migrated into that
   * shape first (see `migrateV1Workspace`).
   */
  const restoreSavedLayout = async (saved, rootPath) => {
    if (
      !saved ||
      !Array.isArray(saved.tabs) ||
      saved.tabs.length === 0 ||
      !Array.isArray(saved.groups) ||
      saved.groups.length === 0
    ) {
      throw new Error('No saved terminal layout to restore');
    }

    const shell = useSettingsStore.getState().terminalDefaultShell;

    // Only spawn PTYs for tabs some group actually shows — an orphaned tab id
    // in the payload must not cost a shell process.
    const referenced = new Set();
    for (const group of saved.groups) {
      for (const leaf of collectRawLeaves(group?.tree)) {
        for (const id of Array.isArray(leaf.tabIds) ? leaf.tabIds : []) referenced.add(id);
      }
    }

    const newTabs = [];
    for (const savedTab of saved.tabs) {
      if (!savedTab || !savedTab.id || !referenced.has(savedTab.id)) continue;
      // Layouts saved by older builds carry `\\?\D:\…` paths; show and use the plain form.
      const wantedCwd = withoutVerbatimPrefix(savedTab.cwd) || rootPath;

      let ptySession;
      try {
        ptySession = await invoke('pty_spawn', { cols: 80, rows: 24, cwd: wantedCwd, shell });
      } catch (_) {
        // The saved directory may no longer exist — retry at the workspace root.
        try {
          ptySession = await invoke('pty_spawn', { cols: 80, rows: 24, cwd: rootPath, shell });
        } catch (err) {
          // And if even that fails, skip this one terminal. Letting it throw
          // abandoned the ENTIRE restore and the write-behind then replaced the
          // saved workspace with a single fresh terminal — one flaky ConPTY
          // call costing the user every group they had.
          console.error(
            `[TerminalStore] Could not restore terminal "${savedTab.title || savedTab.id}" — skipping it:`,
            err
          );
          continue;
        }
      }

      // A terminal saved as "Terminal 3" keeps that as its default, so the
      // numbering a user arranged survives a restart and the next new terminal
      // takes the gap rather than counting past it. Only when the number is
      // already spoken for — a payload written by the version that handed out
      // duplicates — does it fall back to the next free one.
      const defaultTitle = nextDefaultTitle(newTabs, savedTab.title);
      newTabs.push({
        id: savedTab.id,
        // Same rule as `spawnTab`: a saved `Terminal N` title follows the
        // number it was actually given, so a payload written by the version
        // that handed out duplicates is restored WITHOUT them rather than
        // faithfully reproducing two tabs called "Terminal 3".
        title: isDefaultTitle(savedTab.title) ? defaultTitle : savedTab.title || defaultTitle,
        defaultTitle,
        sessionId: ptySession.session_id,
        cwd: ptySession.cwd || wantedCwd,
        // What was running here, and the fact that it is NOT running now.
        // The shell comes back empty and the conversation is offered rather
        // than taken: starting an agent costs tokens and hits an API, so it
        // waits for the user to ask. `resumeAgent` clears the flag.
        agent: serializeAgent(savedTab.agent),
        agentResumeOffered: Boolean(serializeAgent(savedTab.agent)),
        spawnedAt: Date.now(),
      });
    }

    if (newTabs.length === 0) throw new Error('No terminal tabs could be restored');

    const validIds = new Set(newTabs.map((t) => t.id));
    const claimed = new Set();
    const seenGroupIds = new Set();
    const groups = [];
    saved.groups.forEach((group, i) => {
      if (!group || typeof group !== 'object') return;
      const tree = normalizeTree(pruneTree(sanitizeRestoredTree(group.tree, validIds, claimed)));
      if (!tree) return;
      let id = typeof group.id === 'string' && group.id ? group.id : makeGroupId();
      while (seenGroupIds.has(id)) id = makeGroupId();
      seenGroupIds.add(id);
      const leaves = collectLeaves(tree);
      groups.push({
        id,
        name: (typeof group.name === 'string' && group.name.trim()) || `Group ${i + 1}`,
        createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now(),
        tree,
        activePaneId: leaves.some((l) => l.id === group.activePaneId)
          ? group.activePaneId
          : firstLeafId(tree),
      });
    });

    if (groups.length === 0) throw new Error('Saved layout had no valid panes once sanitized');

    for (const group of groups) {
      bumpNodeCounters(group.tree);
      bumpGroupCounter(group.id);
      walkNodes(group.tree, (n) => {
        if (n.type === 'leaf') (n.tabIds || []).forEach(bumpTabCounter);
      });
    }

    const activeGroupId = groups.some((g) => g.id === saved.activeGroupId)
      ? saved.activeGroupId
      : groups[0].id;
    const activeGroup = groups.find((g) => g.id === activeGroupId);
    const activePane =
      collectLeaves(activeGroup.tree).find((l) => l.id === activeGroup.activePaneId) ||
      collectLeaves(activeGroup.tree)[0];
    const activeTabId = activePane?.activeTabId || activePane?.tabIds?.[0] || newTabs[0].id;
    const activeTab = newTabs.find((t) => t.id === activeTabId) || newTabs[0];

    return {
      tabs: newTabs,
      groups,
      activeGroupId,
      activeTabId,
      cwd: activeTab.cwd || rootPath,
      workspaceName:
        typeof saved.workspaceName === 'string' && saved.workspaceName.trim()
          ? saved.workspaceName.trim()
          : 'Default',
    };
  };

  /**
   * Draw `tabId`'s pane's ring once (`attentionFlash`): on now, off again
   * after ATTENTION_FLASH_MS. A flash while one is showing starts over, and
   * the timer of the one it replaced ends nothing.
   */
  const flashTerminal = (tabId) => {
    flashCounter += 1;
    const number = flashCounter;
    clearTimeout(flashTimers.get(tabId));
    set((s) => ({ attentionFlash: { ...s.attentionFlash, [tabId]: number } }));
    flashTimers.set(
      tabId,
      setTimeout(() => {
        flashTimers.delete(tabId);
        set((s) => {
          if (s.attentionFlash[tabId] !== number) return s;
          const { [tabId]: _ended, ...rest } = s.attentionFlash;
          return { attentionFlash: rest };
        });
      }, attentionFlashMs)
    );
  };

  /** Add `fold`'s rings to entry `id`'s count (`foldRings`). */
  const addRingsTo = (id, fold) =>
    set((s) => {
      const notifications = foldRings(s.notifications, id, fold.rings, fold.at);
      return notifications === s.notifications ? s : { notifications };
    });

  /**
   * Let the rings held for `tabId` out (`bellFolds`):
   *
   *   - rung while an entry was unread: into that entry's count, read since
   *     or not; gone with it if it was dismissed;
   *   - rung with nothing waiting: into the tab's unread bell entry if one
   *     has appeared since; otherwise listed as a new entry — once the rate
   *     limit allows, the hold renewed until it does — unless the tab is
   *     being typed into by now, or the bell was turned off.
   */
  const releaseBellRings = (tabId) => {
    const fold = bellFolds.get(tabId);
    if (!fold) return;
    clearTimeout(fold.timer);
    fold.timer = null;
    if (fold.id !== null) {
      bellFolds.delete(tabId);
      addRingsTo(fold.id, fold);
      return;
    }
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || useSettingsStore.getState().terminalBellAttention === false) {
      bellFolds.delete(tabId);
      return;
    }
    const waiting = unreadBellOf(state.notifications, tabId);
    if (waiting) {
      bellFolds.delete(tabId);
      addRingsTo(waiting.id, fold);
      return;
    }
    if (state.activeTabId === tabId && currentAttention().focused) {
      bellFolds.delete(tabId);
      return;
    }
    if (!bellLimiterOf(tabId).allow(bellClock())) {
      fold.timer = setTimeout(() => releaseBellRings(tabId), bellFoldMs);
      return;
    }
    bellFolds.delete(tabId);
    bellCounter += 1;
    const tabTitle = tab.title || tab.defaultTitle || 'Terminal';
    const bell = { id: `bell-${tabId}-${fold.at}-${bellCounter}`, tabId, tabTitle, at: fold.at, count: fold.rings };
    set((s) => ({ notifications: addBell(s.notifications, bell, NOTIFICATION_LIMIT) }));
  };

  /**
   * One ring of `tabId`'s bell the rate limit refused: held — with the
   * unread entry it rang for (`entryId`), or with none — and let out by one
   * update once BELL_FOLD_MS has passed (`releaseBellRings`). No store write
   * per ring: a flood of BELs is a few writes in all.
   */
  const holdBellRing = (tabId, entryId) => {
    let fold = bellFolds.get(tabId);
    // Rings held for another entry, or for none, are let out first: those
    // rung for an entry since read and replaced stay that entry's.
    if (fold && fold.id !== entryId) {
      releaseBellRings(tabId);
      fold = bellFolds.get(tabId) ?? null;
      if (fold && fold.id !== entryId) {
        clearTimeout(fold.timer);
        bellFolds.delete(tabId);
        fold = null;
      }
    }
    if (!fold) {
      fold = { id: entryId, rings: 0, at: 0, timer: null };
      bellFolds.set(tabId, fold);
    }
    fold.rings += 1;
    fold.at = Date.now();
    if (fold.timer === null) fold.timer = setTimeout(() => releaseBellRings(tabId), bellFoldMs);
  };

  const initialGroup = makeGroup({ name: 'Group 1' });

  return {
    tabs: [],
    activeTabId: null,
    cwd: '/workspace',
    isInitialized: false,

    // The workspace's groups, in switcher order. Each owns its own split tree
    // of panes: { id, name, createdAt, tree, activePaneId }.
    groups: [initialGroup],

    // Exactly one group is on screen at a time and fills the terminal area.
    // (This replaces the old `focusedPaneId` *and* the whole `groupViewMode`
    // hack — there is no "show every group side by side" mode any more.)
    activeGroupId: initialGroup.id,

    // Named group snapshots the user saved explicitly. Unlike the live layout
    // (auto-persisted), these are kept until deleted and can be loaded any time.
    // Deliberately empty here and filled by `init()`. Reading localStorage
    // during module evaluation captured the list once, at import time, which
    // made the result depend on which module imported the store first.
    savedGroups: [],
    savedWorkspaces: [],
    // The session on screen is itself a workspace — groups live inside it.
    // It used to be nameless, with "workspaces" existing only as save slots
    // beside it, which left no answer to "which one am I in?".
    workspaceName: 'Default',

    // ---- What finished while you were looking elsewhere ------------------
    //
    // The status bar used to end in a Notifications bell with no handler at
    // all; it was removed rather than left lying. This is what puts one back,
    // now that there is something real to put in it: the shell says when a
    // command starts (OSC 133 "C") and when it ends, so the app can know that
    // a build in another group finished four minutes ago — which is the whole
    // point of running things in a terminal you are not watching.
    //
    // Three kinds: a command that finished (`notificationFor` in
    // tabActivity.js), what a program in a terminal asked to tell you
    // (`kind: 'program'`, see `notifyFromProgram`), and a terminal's bell
    // (`kind: 'bell'`, see `bellFromTerminal`).
    //
    // Every entry is made with `read: false`, and is marked read once its
    // terminal has been seen (see the attention subscription at the bottom of
    // this file and src/lib/attention.js): that is what rings a pane and
    // counts on a tab chip. An entry stays in the list, read, until it is
    // dismissed or cleared.
    //
    // Newest first. Capped, because a machine left running overnight would
    // otherwise grow this without bound — and past the cap the oldest READ
    // entries go first, so something seen never pushes out something still
    // waiting (`capNotifications`).
    notifications: [],

    dismissNotification: (id) =>
      set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),

    clearNotifications: () => set({ notifications: [] }),

    /**
     * Mark every entry of terminal `tabId` read. Nothing changes — not even
     * the list's identity — when none was unread.
     */
    markTabRead: (tabId) =>
      set((state) => {
        const notifications = markRead(state.notifications, (n) => n.tabId === tabId);
        return notifications === state.notifications ? state : { notifications };
      }),

    /** Mark All Read: every entry, every terminal. */
    markAllNotificationsRead: () =>
      set((state) => {
        const notifications = markRead(state.notifications);
        return notifications === state.notifications ? state : { notifications };
      }),

    /**
     * The window has just come to the front, or become visible again: the
     * terminal on screen as the active tab has now been seen. Called by
     * `useAttention` (src/hooks/useAttention.js) on the window's `focus` and
     * on `visibilitychange` to visible.
     */
    noteWindowFocused: () => {
      // A click into the window: held until the button is let go (`notePointer`).
      if (pointerPressed) {
        seenOnRelease = true;
        return;
      }
      const { activeTabId } = get();
      if (activeTabId) get().markTabRead(activeTabId);
    },

    /**
     * A pointer button went down (`pressed`) or up anywhere in the window —
     * `useAttention`'s capture listeners. While one is down, the seen rule
     * holds what it would read; let go, the terminal active then is read, if
     * the window still has the focus. A release the window never hears is
     * assumed after POINTER_SAFETY_MS.
     */
    notePointer: (pressed) => {
      clearTimeout(pointerSafetyTimer);
      pointerSafetyTimer = null;
      if (pressed) {
        pointerPressed = true;
        pointerSafetyTimer = setTimeout(() => get().notePointer(false), pointerSafetyMs);
        return;
      }
      if (!pointerPressed) return;
      pointerPressed = false;
      if (!seenOnRelease) return;
      seenOnRelease = false;
      const { activeTabId } = get();
      if (activeTabId && currentAttention().focused) get().markTabRead(activeTabId);
    },

    /**
     * Go to the terminal an entry is about — the bell list's click: show it
     * (`switchTab` brings its group on screen, its pane active, and ends a
     * zoom that hides it), give it the keyboard, and mark that terminal read.
     * The entry stays, read.
     *
     * The Terminal view is brought on screen first, wherever it was dragged:
     * its region shown, and the view chosen in it over the other views there
     * (`showView`). Showing the bottom panel alone left a Terminal view moved
     * into a side bar behind the Explorer — nothing on screen, the keyboard
     * nowhere, and the entry read all the same. So nothing happens, and
     * nothing is read, unless the view really is on screen by then; and it is
     * shown before the tab switches, as a switch in a focused window is itself
     * a reading (the attention subscription below).
     *
     * Only a terminal in a pane can be gone to — not one spawned and not yet
     * placed, nor one taken out of its pane on its way to being killed
     * (`killTabIfOrphaned`): switching to either shows nothing. And the
     * terminal is read only once it really is on screen after the switch, as
     * the active tab — not merely beside it, the keyboard kept elsewhere.
     *
     * False when the entry, or its terminal, is gone or in no pane, or there
     * is nowhere to show it.
     */
    goToNotification: (id) => {
      const entry = get().notifications.find((n) => n.id === id);
      if (!entry || !groupOfTab(get(), entry.tabId)) return false;
      useSettingsStore.getState().showView?.('terminal');
      if (!isViewShown(useSettingsStore.getState(), 'terminal')) return false;
      get().switchTab(entry.tabId);
      if (get().activeTabId !== entry.tabId || !tabOnScreen(get(), entry.tabId)) return false;
      focusTerminalSoon(entry.tabId);
      get().markTabRead(entry.tabId);
      return true;
    },

    /**
     * Go to Latest Unread Notification: the newest unread entry — by when it
     * happened — whose terminal is in a pane, as `goToNotification` goes to
     * one. Returns the tab gone to, or null — with nothing unread it does
     * nothing at all.
     */
    goToLatestUnread: () => {
      const state = get();
      const placed = new Set(state.groups.flatMap((g) => collectLeaves(g.tree).flatMap((leaf) => leaf.tabIds)));
      const entry = latestUnread(state.notifications, placed);
      if (!entry) return null;
      return get().goToNotification(entry.id) ? entry.tabId : null;
    },

    // ---- A terminal flashing, and a terminal's bell ----------------------
    //
    // tab id -> the number of its current flash: a pane whose terminal is
    // here draws its ring once, for ATTENTION_FLASH_MS (D4). Only for a
    // notification or a bell aimed at the terminal being typed into, with
    // `terminalAttentionFlashFocused` on — what is being looked at needs no
    // entry, and with the setting on it gets a glance instead. A second flash
    // restarts the first, under a new number, so the drawing can restart too.
    attentionFlash: {},

    /**
     * The terminal `tabId` rang its bell (xterm's `onBell`, wired in
     * terminalRegistry.js) — a BEL in its output: what a program does when it
     * wants you and knows nothing better, and what an agent's `\a` on
     * finishing is.
     *
     * Routed as a program notification with kitty's `always` occasion, but
     * only ever to the bell's list, never to the desktop: a BEL says nothing
     * worth an OS notification and arrives far too freely. So: an entry,
     * unless this is the terminal being typed into — the active tab in a
     * focused window — which flashes instead when the setting says to. A ring
     * while the tab's bell entry is still unread is added to that entry
     * (`addBell`). Rings past the tab's rate limit are not written as they
     * come, and not lost either: held, and added to that entry, or listed as
     * a new one once the limit allows, in one update a moment later
     * (`holdBellRing`).
     *
     * Off entirely with `terminalBellAttention` off. `attention` and `now`
     * (a monotonic clock, for the rate limit) are there for the suites.
     * Returns `{ inApp, flash }`, or null for a tab that is gone.
     */
    bellFromTerminal: (tabId, attention = currentAttention(), now = bellClock()) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return null;
      const settings = useSettingsStore.getState();
      if (settings.terminalBellAttention === false) return { inApp: false, flash: false };
      programSignalled(tabId);
      const route = routeProgramNotification({
        occasion: 'always',
        activeTab: state.activeTabId === tabId,
        onScreen: Boolean(attention?.visible) && tabOnScreen(state, tabId),
        focused: Boolean(attention?.focused),
      });
      const flash = !route.inApp && settings.terminalAttentionFlashFocused === true;
      if (!route.inApp && !flash) return { inApp: false, flash: false };
      // Counted only for a ring that would show, and a flash against an
      // allowance of its own: the bells a shell rings at the terminal you are
      // typing into (a failed completion) must not use up the allowance of
      // the next one, rung while you are elsewhere. A storm of them is one
      // flash, not a store update per BEL.
      let limiter = flash ? flashLimiters.get(tabId) : bellLimiterOf(tabId);
      if (!limiter) {
        limiter = createRateLimiter();
        flashLimiters.set(tabId, limiter);
      }
      if (!limiter.allow(now)) {
        // Refused, but not lost: held, and counted or listed in one update a
        // moment later (`holdBellRing`). A refused flash is just refused.
        if (!flash) holdBellRing(tabId, unreadBellOf(state.notifications, tabId)?.id ?? null);
        return { inApp: false, flash: false };
      }
      if (flash) {
        flashTerminal(tabId);
        return { inApp: false, flash: true };
      }
      const at = Date.now();
      bellCounter += 1;
      const tabTitle = tab.title || tab.defaultTitle || 'Terminal';
      set((s) => ({
        notifications: addBell(s.notifications, { id: `bell-${tabId}-${at}-${bellCounter}`, tabId, tabTitle, at }, NOTIFICATION_LIMIT),
      }));
      return { inApp: true, flash: false };
    },

    // ---- How far along each terminal's program says it is ----------------
    //
    // tab id -> `{ state, value }`: 'normal', 'error', 'indeterminate' or
    // 'warning', and a percentage or null (src/lib/terminalProgress.js). Its
    // own map and not a field of `tabs`, which every pane, the side bar and
    // the status bar subscribe to: a program reporting progress would
    // otherwise re-render all of them ten times a second.
    progress: {},

    /**
     * A progress report from `tabId`'s terminal (`parseProgress`'s shape).
     *
     * The bar it leaves is worked out from the bar before it — the one still
     * waiting to be shown, if one is — and an update that leaves the bar as it
     * was is dropped. A tab's bar changes at most ten times a second: past
     * that the latest bar waits, replacing any bar already waiting, and is
     * shown when the tenth of a second is up. Nothing with the `terminalProgress`
     * setting off, or for a tab that is gone. Returns whether the bar is
     * changing.
     */
    setTabProgress: (tabId, update) => {
      if (useSettingsStore.getState().terminalProgress === false) return false;
      if (!get().tabs.some((t) => t.id === tabId)) return false;
      let throttle = progressThrottles.get(tabId);
      const shown = get().progress[tabId] ?? null;
      const current = throttle?.holding ? throttle.held : shown;
      const next = nextProgress(current, update);
      if (sameProgress(next, current)) return false;
      if (!throttle) {
        // Nothing held is delivered for a tab that has gone or with the
        // setting off: both cancel what is held as they happen
        // (`pruneAttention`, and the settings subscription below).
        throttle = createLatestThrottle({
          intervalMs: progressIntervalMs,
          deliver: (bar) => {
            set((s) => {
              if (sameProgress(s.progress[tabId], bar)) return s;
              if (bar === null) return { progress: withoutProgress(s.progress, [tabId]) };
              return { progress: { ...s.progress, [tabId]: bar } };
            });
          },
        });
        progressThrottles.set(tabId, throttle);
      }
      throttle.push(next);
      return true;
    },


    /**
     * A program in terminal `tabId` asked to tell the user something —
     * OpenCode's "Session done" or "Permission needs input", Claude Code
     * waiting — and `note` is what it said, already cleaned and rate-limited
     * by src/lib/programNotifications.js, which also decides where it goes
     * (`routeProgramNotification`):
     *
     *   - an entry in the bell, beside the finished commands, unless this is
     *     the terminal being typed into — the active tab, in a focused window;
     *   - a desktop notification, from the backend, while the window is not
     *     focused: the reason a program asks at all is that nobody is looking.
     *
     * The program's own title when it gave one, else the terminal's: OSC 9
     * carries a message and nothing else. An entry is never a failure — the
     * badge turns red for an exit code, and this has none.
     *
     * Aimed at the terminal being typed into, with kitty's `always` occasion,
     * it flashes that pane instead when `terminalAttentionFlashFocused` is on
     * (`attentionFlash`). Not for `unfocused` or `invisible`: a program that
     * asked to be heard only while nobody is looking has not asked for a
     * glance from someone who is.
     *
     * `keptAt` says the note was read from output kept before the terminal was
     * first shown (`createHistoryMark` in ptyOutputBus.js), printed at that
     * time. Still listed — a permission request in a tab nobody had looked at
     * is usually still waiting — but as what it is: filed under when it was
     * printed, so it neither tops the list nor outranks newer news for the
     * jump; never on the desktop, as the moment for that has passed; never a
     * flash. Kitty's occasions describe the moment it was sent, when nobody
     * could see the terminal, so they let it through; only the terminal being
     * typed into now gets nothing, its screen showing what the note says.
     *
     * `attention` is the window's focus and visibility, read as the note
     * arrives; the suites hand theirs in. Returns where it went, or null for
     * a tab that is gone.
     */
    notifyFromProgram: (tabId, note, attention = currentAttention(), { keptAt } = {}) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab || !note) return null;
      const fromHistory = typeof keptAt === 'number' && Number.isFinite(keptAt);
      const typingInto = state.activeTabId === tabId && Boolean(attention?.focused);
      const route = fromHistory
        ? { inApp: !typingInto, desktop: false }
        : routeProgramNotification({
            occasion: note.occasion,
            activeTab: state.activeTabId === tabId,
            onScreen: Boolean(attention?.visible) && tabOnScreen(state, tabId),
            focused: Boolean(attention?.focused),
          });
      const tabTitle = tab.title || tab.defaultTitle || 'Terminal';
      const title = note.title || tabTitle;
      const body = note.body || '';
      if (route.inApp) {
        const at = fromHistory ? keptAt : Date.now();
        programNoteCounter += 1;
        const entry = { id: `program-${tabId}-${at}-${programNoteCounter}`, kind: 'program', tabId, tabTitle, title, body, at, read: false };
        set((s) => ({ notifications: capNotifications(insertNewestFirst(s.notifications, entry), NOTIFICATION_LIMIT) }));
      } else if (
        !fromHistory &&
        (note.occasion ?? 'always') === 'always' &&
        state.activeTabId === tabId &&
        Boolean(attention?.focused) &&
        useSettingsStore.getState().terminalAttentionFlashFocused === true
      ) {
        flashTerminal(tabId);
      }
      if (route.desktop) {
        // Denied by the OS is an answer, not an error: the backend says false.
        invoke('show_desktop_notification', { title, body }).catch((err) => {
          console.warn('[TerminalStore] could not show a desktop notification:', err);
        });
      }
      if (!fromHistory) programSignalled(tabId);
      return route;
    },

    // ---- Find in the terminal ------------------------------------------
    // One bar at a time, bound to whichever terminal had focus when it opened
    // — the shape VS Code's terminal find has, and the reason `tabId` is kept:
    // a search still settling in a background tab must not overwrite the count
    // the user is reading. The highlighting itself belongs to xterm's search
    // addon (see `searchInTerminal` in terminalRegistry.js); this is only what
    // the bar shows and what it asks for.
    find: {
      open: false,
      tabId: null,
      query: '',
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      resultIndex: -1,
      resultCount: 0,
    },

    openFind: (tabId = null) =>
      set((state) => ({
        find: { ...state.find, open: true, tabId: tabId ?? state.activeTabId },
      })),

    // The query survives a close, as it does in every editor: reopening and
    // pressing Enter repeats the last search instead of starting from nothing.
    closeFind: () =>
      set((state) => ({ find: { ...state.find, open: false, resultIndex: -1, resultCount: 0 } })),

    setFindQuery: (query) =>
      set((state) => ({ find: { ...state.find, query: typeof query === 'string' ? query : '' } })),

    toggleFindOption: (key) =>
      set((state) =>
        ['caseSensitive', 'wholeWord', 'regex'].includes(key)
          ? { find: { ...state.find, [key]: !state.find[key] } }
          : {}
      ),

    // Unchanged counts return the SAME object, not an equal one. xterm re-reports
    // its results freely — on every decoration refresh, and on selection changes
    // that move nothing — and a new object each time re-rendered the bar
    // continuously. That was not merely wasteful: it remounted the bar's option
    // buttons often enough to swallow real mouse clicks.
    setFindResults: (tabId, { resultIndex = -1, resultCount = 0 } = {}) =>
      set((state) => {
        if (state.find.tabId !== tabId) return {};
        if (state.find.resultIndex === resultIndex && state.find.resultCount === resultCount) return {};
        return { find: { ...state.find, resultIndex, resultCount } };
      }),

    // ---- cmd's "Terminate batch job (Y/N)?" ----------------------------
    // Asked by the registry for every chunk of output it writes, so these
    // are a Map lookup until a Ctrl+C has armed the tab. See
    // src/lib/batchJobReply.js.

    /**
     * A chunk of `tabId`'s output has arrived: whether the tab still waits
     * for cmd's question after a Ctrl+C — judged now, as it arrives — so its
     * screen is read once xterm has written it.
     */
    batchJobOutputArrived: (tabId) => batchJobReplies.outputArrived(tabId),

    /** A chunk of `tabId`'s output is on `term`'s screen: answer cmd's question if that is what it shows. Returns whether it did. */
    answerBatchJobPrompt: (tabId, term) => batchJobReplies.afterOutput(tabId, term),

    // ---- Reading the layout -------------------------------------------
    getActiveGroup: () => {
      const { groups, activeGroupId } = get();
      return groups.find((g) => g.id === activeGroupId) || groups[0] || null;
    },

    /** The active pane of the active group — what keyboard shortcuts act on. */
    getActivePaneId: () => get().getActiveGroup()?.activePaneId ?? null,

    // ---- Focus ---------------------------------------------------------
    /**
     * Mark a pane as the active one (called on click/focus of a pane). The
     * pane's own visible tab becomes the active tab, and if the pane belongs
     * to another group that group is brought on screen. A pane hidden by a
     * zoom can only be reached from outside the terminal area (the TERMINALS
     * panel); going to it unzooms its group, as selecting a pane does in tmux
     * — see `settle`.
     */
    setActivePane: (paneId, groupId = null) =>
      set((state) => {
        const group = resolveGroup(state, groupId, paneId);
        if (!group) return {};
        const pane = collectLeaves(group.tree).find((l) => l.id === paneId);
        if (!pane) return {};
        return settle(state, {
          groups: updateGroup(state, group.id, (g) => ({ ...g, activePaneId: paneId })),
          activeGroupId: group.id,
          activeTabId: pane.activeTabId ?? state.activeTabId,
        });
      }),

    /** Rename the session you are working in. */
    renameWorkspace: (name) => {
      const trimmed = (name || '').trim();
      if (trimmed) set({ workspaceName: trimmed });
    },

    /**
     * Bring a group on screen. Its arrangement is exactly as it was last left;
     * the active tab moves with it (an inactive group's terminals keep
     * running, so this is purely a view/focus change).
     */
    setActiveGroup: (groupId) =>
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId);
        if (!group) return {};
        const leaves = collectLeaves(group.tree);
        const pane = leaves.find((l) => l.id === group.activePaneId) || leaves[0];
        const nextTabId = pane?.activeTabId ?? pane?.tabIds?.[0] ?? null;
        const tab = state.tabs.find((t) => t.id === nextTabId);
        return settle(state, {
          activeGroupId: groupId,
          activeTabId: nextTabId,
          cwd: tab?.cwd ?? state.cwd,
        });
      }),

    /**
     * Move pane focus by `delta` (±1) through the ACTIVE group's panes in DOM
     * order, wrapping around at the ends. Other groups are off screen, so they
     * are never part of the cycle.
     *
     * In a zoomed group the cycle still runs over every pane, hidden ones
     * included, and landing on another pane unzooms the group (`settle`):
     * tmux's next-pane does the same, and it is the only way the keyboard
     * could ever reach a hidden pane.
     */
    focusNextPane: (delta = 1) =>
      set((state) => {
        const group = state.groups.find((g) => g.id === state.activeGroupId);
        if (!group) return {};
        const leaves = collectLeaves(group.tree);
        if (leaves.length === 0) return {};
        const currentIdx = leaves.findIndex((l) => l.id === group.activePaneId);
        const fromIdx = currentIdx === -1 ? 0 : currentIdx;
        const next = leaves[(fromIdx + delta + leaves.length) % leaves.length];
        return settle(state, {
          groups: updateGroup(state, group.id, (g) => ({ ...g, activePaneId: next.id })),
          activeTabId: next.activeTabId ?? state.activeTabId,
        });
      }),

    /**
     * Zoom a pane — make it fill its group's whole area, hiding the others —
     * or, when the group is already zoomed, unzoom it. tmux's `Prefix z`,
     * iTerm2's "Maximize Active Pane".
     *
     * `paneId` defaults to the active pane of the active group, which is what
     * the keyboard, the menu and the palette act on; a pane's own button
     * passes its id. Zooming makes that pane the active one and brings its
     * group on screen. A group with one pane has nothing to hide, and is left
     * as it is.
     *
     * The hidden panes are not closed or moved: the tree does not change at
     * all, so unzooming gives back the very layout that was zoomed, sizes
     * included. Their terminals stay alive in the registry — TerminalSplit-
     * Container simply does not mount them (see `treeOnScreen`) — and every
     * group keeps its own zoom across group switches. What ends a zoom besides
     * this toggle is listed at `settle`.
     *
     * Returns whether the group is zoomed afterwards.
     */
    togglePaneZoom: (paneId = null, groupId = null) => {
      const target = resolveGroup(get(), groupId, paneId);
      if (!target) return false;
      set((state) => {
        const group = state.groups.find((g) => g.id === target.id);
        if (!group) return {};
        if (zoomedPaneOf(group)) {
          // Nothing structural changes, so there is nothing for `settle` to
          // repair: the same tree, shown whole again.
          return { groups: updateGroup(state, group.id, withoutZoom) };
        }
        const leaves = collectLeaves(group.tree);
        if (leaves.length < 2) return {};
        const pane = leaves.find((l) => l.id === (paneId ?? group.activePaneId));
        if (!pane) return {};
        return settle(state, {
          groups: updateGroup(state, group.id, (g) => ({ ...g, activePaneId: pane.id, zoomedPaneId: pane.id })),
          activeGroupId: group.id,
          activeTabId: pane.activeTabId ?? state.activeTabId,
        });
      });
      return Boolean(zoomedPaneOf(get().groups.find((g) => g.id === target.id)));
    },

    // ---- Groups --------------------------------------------------------
    /**
     * Create a new group with one terminal in it and switch to it.
     * Returns the new group (or null if the PTY could not be spawned).
     *
     * Without a `cwd` the terminal starts where the setting says, as New
     * Terminal and Split do. It used to be handed the store's `cwd` — the
     * active terminal's directory — as though that had been asked for, and an
     * asked-for directory beats the setting, so New Group never saw it.
     * Starting beside the active terminal is what the `active` setting is for.
     */
    createGroup: async ({ name = null, cwd = null } = {}) => {
      const tab = await spawnTab(null, cwd);
      if (!tab) return null;
      const group = makeGroup({
        name: (typeof name === 'string' && name.trim()) || nextDefaultGroupName(get().groups, null),
        tabIds: [tab.id],
      });
      set((state) =>
        settle(state, {
          groups: [...state.groups, group],
          activeGroupId: group.id,
          activeTabId: tab.id,
        })
      );
      return group;
    },

    /**
     * Close a whole group: every terminal it owns (and no other group shows)
     * is killed. The last group is emptied rather than removed.
     */
    closeGroup: async (groupId) => {
      const group = get().groups.find((g) => g.id === groupId);
      if (!group) return;
      const owned = collectLeaves(group.tree).flatMap((l) => l.tabIds);

      set((state) => {
        const idx = state.groups.findIndex((g) => g.id === groupId);
        if (idx === -1) return {};
        if (state.groups.length === 1) {
          return settle(state, {
            groups: updateGroup(state, groupId, (g) => ({ ...g, tree: emptyPane() })),
          });
        }
        const groups = state.groups.filter((g) => g.id !== groupId);
        const activeGroupId =
          state.activeGroupId === groupId
            ? groups[Math.min(idx, groups.length - 1)].id
            : state.activeGroupId;
        return settle(state, { groups, activeGroupId });
      });

      for (const tabId of owned) await killTabIfOrphaned(tabId);
    },

    /**
     * Name (or rename) a group — reachable from a right-click on the group
     * switcher. A blank name resets it to a default "Group N" that no other
     * group is called (see `nextDefaultGroupName`).
     */
    renameGroup: (groupId, name) =>
      set((state) => {
        const idx = state.groups.findIndex((g) => g.id === groupId);
        if (idx === -1) return {};
        const trimmed = typeof name === 'string' ? name.trim() : '';
        return {
          groups: updateGroup(state, groupId, (g) => ({
            ...g,
            name: trimmed || nextDefaultGroupName(state.groups, groupId),
          })),
        };
      }),

    /**
     * Drop a group's chip along the switcher: put group `groupId` at slot
     * `index` of `groups` — the order the switcher shows, and the order that
     * is saved and comes back on relaunch.
     *
     * `index` is a slot counted the way `moveTabInStrip` counts one: among the
     * groups AS THEY ARE BEFORE THE MOVE, the dragged one included, so slot i
     * is "just before the group now at position i" and slot `groups.length`
     * is "after the last" (see `moveToSlot`).
     *
     * Only the order changes. Reordering is not switching: the group on
     * screen stays on screen wherever it now sits, so tidying the row never
     * swaps the whole terminal area out from under the user, and every group
     * keeps its panes, its focus and its name. A drop that leaves the order as
     * it is changes no state at all. An unknown group, or an index that is not
     * a number, is ignored.
     */
    reorderGroup: (groupId, index) =>
      set((state) => {
        const ids = state.groups.map((g) => g.id);
        if (!ids.includes(groupId)) return state;
        const order = moveToSlot(ids, groupId, index);
        if (!order || sameOrder(order, ids)) return state;
        // Not through `settle`: a new order cannot break anything it repairs —
        // no tree, pane or focus changes — so the very same group objects are
        // handed back, resequenced. The array is new, which is what schedules
        // the save (see the persist subscription at the bottom of this file).
        const byId = new Map(state.groups.map((g) => [g.id, g]));
        return { groups: order.map((id) => byId.get(id)) };
      }),

    /**
     * Persist the pane sizes of one split (percentages, one per child) so a
     * group's proportions survive being switched away from and relaunched.
     *
     * NOTE for the renderer: this is only the store half. `react-resizable-
     * panels` keeps layout in component state, and under the two-level model
     * EVERY group switch unmounts a tree, so the panel group must read these
     * back on mount (an `id` per Panel plus `defaultSize` from `sizes`, or an
     * `autoSaveId`) and call `setPaneSizes` on layout change. Without that
     * half, sizes are stored faithfully and still reset on screen.
     */
    setPaneSizes: (groupId, splitId, sizes) => {
      if (!Array.isArray(sizes) || sizes.length < 2) return;
      set((state) => {
        const group = resolveGroup(state, groupId, null);
        if (!group) return {};
        const target = collectSplits(group.tree).find((s) => s.id === splitId);
        if (!target || target.children.length !== sizes.length) return {};
        const next = normalizeSizes(sizes, sizes.length);
        if (
          Array.isArray(target.sizes) &&
          target.sizes.length === next.length &&
          target.sizes.every((v, i) => v === next[i])
        ) {
          return {};
        }
        return {
          groups: updateGroup(state, group.id, (g) => ({
            ...g,
            tree: replaceNode(g.tree, splitId, (n) => ({ ...n, sizes: next })),
          })),
        };
      });
    },

    // ---- Tab management used by the Terminals panel's context menus ----
    /** Close every other terminal in the pane that holds `tabId`. */
    closeOthersInGroup: async (tabId) => {
      const group = groupOfTab(get(), tabId);
      const pane = group && leafHoldingTab(group.tree, tabId);
      if (!pane) return;
      for (const id of pane.tabIds.filter((x) => x !== tabId)) {
        await get().closeTab(id);
      }
    },

    /** Close the terminals that sit after `tabId` in its pane. */
    closeTabsToTheRight: async (tabId) => {
      const group = groupOfTab(get(), tabId);
      const pane = group && leafHoldingTab(group.tree, tabId);
      if (!pane) return;
      const idx = pane.tabIds.indexOf(tabId);
      if (idx === -1) return;
      for (const id of pane.tabIds.slice(idx + 1)) {
        await get().closeTab(id);
      }
    },

    /**
     * Split a terminal out of its pane into a new pane beside it, inside the
     * same group. (This is what `moveTabToNewGroup` used to do, despite its
     * name.) Returns the new pane's id, or null when the tab is already alone.
     */
    moveTabToNewPane: (tabId, direction = 'horizontal') => {
      const state = get();
      const group = groupOfTab(state, tabId);
      const source = group && leafHoldingTab(group.tree, tabId);
      // A pane's only tab already "is" its own pane.
      if (!source || source.tabIds.length <= 1) return null;
      get().dropTabOnPane(tabId, source.id, direction === 'vertical' ? 'bottom' : 'right', group.id);
      return get().groups.find((g) => g.id === group.id)?.activePaneId ?? null;
    },

    /**
     * Move a terminal into a brand-new group of its own and switch to it.
     * Returns the new group's id, or null when the tab already is a group's
     * only terminal (moving it would just rename that group).
     */
    moveTabToNewGroup: (tabId, { name = null } = {}) => {
      const state = get();
      if (!state.tabs.some((t) => t.id === tabId)) return null;
      const source = groupOfTab(state, tabId);
      if (source) {
        const leaves = collectLeaves(source.tree);
        if (leaves.length === 1 && leaves[0].tabIds.length === 1) return null;
      }
      const group = makeGroup({
        name: (typeof name === 'string' && name.trim()) || nextDefaultGroupName(state.groups, null),
        tabIds: [tabId],
      });
      set((s) => {
        const groups = source
          ? [...updateGroup(s, source.id, (g) => ({ ...g, tree: removeTabFromTree(g.tree, tabId) })), group]
          : [...s.groups, group];
        return settle(s, { groups, activeGroupId: group.id, activeTabId: tabId });
      });
      return group.id;
    },

    /**
     * Move a terminal into another group — onto `targetPaneId` when given,
     * otherwise that group's active pane — and switch to it. The tab is
     * removed from its old group in the same update, so it is never listed in
     * two panes at once.
     */
    moveTabToGroup: (tabId, targetGroupId, targetPaneId = null) =>
      set((state) => {
        if (!state.tabs.some((t) => t.id === tabId)) return {};
        const target = state.groups.find((g) => g.id === targetGroupId);
        if (!target) return {};
        const source = groupOfTab(state, tabId);

        const paneId =
          targetPaneId && collectLeaves(target.tree).some((l) => l.id === targetPaneId)
            ? targetPaneId
            : target.activePaneId;

        let groups = state.groups;
        if (source) {
          groups = updateGroup(groups, source.id, (g) => ({
            ...g,
            tree: removeTabFromTree(g.tree, tabId),
          }));
        }
        groups = updateGroup(groups, target.id, (g) => ({
          ...g,
          tree: addTabToPane(g.tree, paneId, tabId),
          activePaneId: paneId,
        }));

        return settle(state, { groups, activeGroupId: target.id, activeTabId: tabId });
      }),

    // ---- Saved groups -------------------------------------------------
    /**
     * Snapshot a whole group — its terminals (titles + their live cwd) AND its
     * pane layout — under a name. A snapshot cannot hold live tab ids, so each
     * terminal gets a stable slot id and the saved tree references those.
     */
    saveGroup: (groupId, name) => {
      const state = get();
      const group = state.groups.find((g) => g.id === groupId) || state.getActiveGroup();
      if (!group) return null;

      const snapshot = snapshotGroup(state, group);
      if (!snapshot) return null;

      const entry = {
        ...snapshot,
        id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        // The caller's name wins over the group's own — snapshotGroup carries
        // `name` too, so the spread has to come first.
        name: (name || '').trim() || group.name || 'Saved group',
        savedAt: Date.now(),
      };

      const savedGroups = [...state.savedGroups, entry];
      set({ savedGroups });
      saveState(SAVED_GROUPS_KEY, savedGroups);
      return entry;
    },

    renameSavedGroup: (savedId, name) => {
      const next = get().savedGroups.map((g) =>
        g.id === savedId ? { ...g, name: (name || '').trim() || g.name } : g
      );
      set({ savedGroups: next });
      saveState(SAVED_GROUPS_KEY, next);
    },

    deleteSavedGroup: (savedId) => {
      const next = get().savedGroups.filter((g) => g.id !== savedId);
      set({ savedGroups: next });
      saveState(SAVED_GROUPS_KEY, next);
    },

    /**
     * Set the startup commands of a saved group's terminals — "Edit Startup
     * Commands…". `commands` maps a slot id to its command; a slot it leaves
     * out keeps what it had, and '' makes it just a shell again.
     *
     * All or nothing, and written through like a rename: if any command is
     * more than one line, nothing changes and `{ ok: false, errors }` says
     * which, by slot id, for the dialog to show beside each field. Otherwise
     * `{ ok: true, entry }`. See src/lib/startupCommands.js for what a command
     * may be.
     */
    setStartupCommands: (savedId, commands = {}) => {
      const entry = get().savedGroups.find((g) => g.id === savedId);
      if (!entry) return { ok: false, errors: {} };
      const result = withStartupCommands(entry, commands);
      if (!result.ok) return result;
      const next = get().savedGroups.map((g) => (g.id === savedId ? result.snapshot : g));
      set({ savedGroups: next });
      saveState(SAVED_GROUPS_KEY, next);
      return { ok: true, entry: result.snapshot };
    },

    /**
     * Snapshot EVERY group at once — each one's layout and each terminal's
     * current directory — under a single name. Saving groups one at a time
     * loses which arrangement they were part of; this keeps the whole desk.
     */
    saveWorkspace: (name) => {
      const state = get();
      const groups = state.groups
        .map((g) => snapshotGroup(state, g))
        .filter(Boolean);
      if (groups.length === 0) return null;

      const activeIndex = Math.max(
        0,
        state.groups.findIndex((g) => g.id === state.activeGroupId)
      );
      const entry = {
        id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: (name || '').trim() || state.workspaceName || `Workspace ${state.savedWorkspaces.length + 1}`,
        savedAt: Date.now(),
        groups,
        activeIndex: Math.min(activeIndex, groups.length - 1),
      };

      const savedWorkspaces = [...state.savedWorkspaces, entry];
      set({ savedWorkspaces });
      saveState(SAVED_WORKSPACES_KEY, savedWorkspaces);
      return entry;
    },

    renameSavedWorkspace: (savedId, name) => {
      const trimmed = (name || '').trim();
      const next = get().savedWorkspaces.map((w) =>
        w.id === savedId ? { ...w, name: trimmed || w.name } : w
      );
      set({ savedWorkspaces: next });
      saveState(SAVED_WORKSPACES_KEY, next);
    },

    deleteSavedWorkspace: (savedId) => {
      const next = get().savedWorkspaces.filter((w) => w.id !== savedId);
      set({ savedWorkspaces: next });
      saveState(SAVED_WORKSPACES_KEY, next);
    },

    /**
     * `setStartupCommands` for a saved workspace: the same per-terminal
     * commands, one map per group — `commandsByGroup[i]` is slot id → command
     * for `entry.groups[i]`, as slot ids only name a terminal within its own
     * group. All or nothing across every group; `errors` comes back the same
     * shape, one object per group.
     */
    setWorkspaceStartupCommands: (savedId, commandsByGroup = []) => {
      const entry = get().savedWorkspaces.find((w) => w.id === savedId);
      if (!entry) return { ok: false, errors: [] };
      const results = entry.groups.map((group, i) => withStartupCommands(group, commandsByGroup?.[i] ?? {}));
      if (results.some((r) => !r.ok)) {
        return { ok: false, errors: results.map((r) => (r.ok ? {} : r.errors)) };
      }
      const updated = { ...entry, groups: results.map((r) => r.snapshot) };
      const next = get().savedWorkspaces.map((w) => (w.id === savedId ? updated : w));
      set({ savedWorkspaces: next });
      saveState(SAVED_WORKSPACES_KEY, next);
      return { ok: true, entry: updated };
    },

    /**
     * Bring a whole workspace back.
     *
     * `replace` puts the session back the way it was — every saved group, and
     * the ones currently open are closed and their shells reaped. `append`
     * adds the saved groups alongside what is already there.
     *
     * Everything is spawned BEFORE anything is closed, so a failure partway
     * through leaves the user with what they already had rather than nothing.
     *
     * A workspace is a template of the whole desk: every terminal that has a
     * startup command types it once its shell is ready, in either mode (see
     * `typeStartupCommand`).
     */
    loadWorkspace: async (savedId, { mode = 'replace' } = {}) => {
      const entry = get().savedWorkspaces.find((w) => w.id === savedId);
      if (!entry || !Array.isArray(entry.groups) || entry.groups.length === 0) return null;

      const made = [];
      for (const snapshot of entry.groups) {
        const result = await materializeGroup(snapshot, `Group ${made.length + 1}`);
        if (result) made.push(result);
      }
      if (made.length === 0) return null;

      const doomed =
        mode === 'replace'
          ? get().groups.flatMap((g) => collectLeaves(g.tree).flatMap((l) => l.tabIds))
          : [];

      const newGroups = made.map((m) => m.group);
      const active = newGroups[Math.min(entry.activeIndex ?? 0, newGroups.length - 1)];

      set((state) => ({
        ...settle(state, {
          groups: mode === 'replace' ? newGroups : [...state.groups, ...newGroups],
          activeGroupId: active.id,
          activeTabId: collectLeaves(active.tree)[0]?.activeTabId ?? null,
        }),
        // Replacing the session means you are now IN that workspace. Beside
        // `settle`, not through it: it hands back the layout and nothing else,
        // so a name in its patch was dropped and the session kept its old one.
        ...(mode === 'replace' && entry.name ? { workspaceName: entry.name } : {}),
      }));

      runStartupCommands(made.flatMap((m) => m.startups));
      for (const tabId of doomed) await killTabIfOrphaned(tabId);
      return active.id;
    },

    /**
     * Re-open a saved group. `mode: 'new-group'` (default) rebuilds it as a
     * brand-new group, layout and all; `'replace'` drops its terminals into
     * the active group's active pane. Each terminal respawns at its saved cwd,
     * falling back to the workspace root when that directory is gone.
     *
     * Either way, a terminal whose slot has a startup command types it as soon
     * as its shell is ready — a saved group with commands is a layout
     * template. One without is just shells, as it always was.
     *
     * Returns the id of the group the terminals landed in, as soon as they are
     * on screen: the commands follow on their own (`runStartupCommands`).
     */
    loadSavedGroup: async (savedId, { mode = 'new-group' } = {}) => {
      const entry = get().savedGroups.find((g) => g.id === savedId);
      if (!entry || !Array.isArray(entry.tabs) || entry.tabs.length === 0) return null;

      // Merge into the group on screen: one shell per saved slot, dropped into
      // the active pane. The saved LAYOUT is deliberately ignored here — the
      // user asked for these terminals inside the arrangement they are looking
      // at, not for that arrangement to be replaced.
      if (mode === 'replace') {
        const spawned = [];
        const startups = [];
        for (const saved of entry.tabs) {
          const tab = await spawnTab(saved.title, saved.cwd);
          if (!tab) continue;
          spawned.push(tab);
          const command = startupCommandOf(saved);
          if (command) startups.push({ tabId: tab.id, command });
        }
        if (spawned.length === 0) return null;

        const groupId = get().activeGroupId;
        set((state) => {
          const group = state.groups.find((g) => g.id === groupId);
          if (!group) return {};
          const paneId = group.activePaneId;
          let tree = group.tree;
          for (const t of spawned) tree = addTabToPane(tree, paneId, t.id);
          return settle(state, {
            groups: updateGroup(state, groupId, (g) => ({ ...g, tree, activePaneId: paneId })),
            activeGroupId: groupId,
            activeTabId: spawned[0].id,
          });
        });
        runStartupCommands(startups);
        return groupId;
      }

      const made = await materializeGroup(entry);
      if (!made) return null;

      set((state) =>
        settle(state, {
          groups: [...state.groups, made.group],
          activeGroupId: made.group.id,
          activeTabId: made.spawned[0].id,
        })
      );
      runStartupCommands(made.startups);
      return made.group.id;
    },

    // ---- Panes ---------------------------------------------------------
    /**
     * Split a pane into two (horizontal or vertical) inside its group. The new
     * tab is spawned directly into the new pane, never into the pane being
     * split, so the same tab can never end up listed in two panes at once.
     * Returns the new pane's id (or null if the split could not be created).
     *
     * A split unzooms the group: a pane made only to be hidden at once would
     * be a terminal the user cannot see, which is why tmux unzooms too.
     */
    splitPane: async (paneId, direction = 'horizontal', groupId = null) => {
      const group = resolveGroup(get(), groupId, paneId);
      if (!group) return null;
      const targetPaneId = collectLeaves(group.tree).some((l) => l.id === paneId)
        ? paneId
        : group.activePaneId;

      // The split continues the terminal shown in the pane being split — its
      // directory and its shell — unless the Split Directory setting says to
      // start a new terminal like any other (`splitStartFor`).
      const sourceLeaf = collectLeaves(group.tree).find((l) => l.id === targetPaneId);
      const source = get().tabs.find((t) => t.id === sourceLeaf?.activeTabId) ?? null;
      const start = splitStartFor(source, {
        mode: useSettingsStore.getState().terminalSplitCwd,
        os: useSystemStore.getState().os,
      });
      const newTab = await spawnTab(null, start.cwd, start.shell);
      if (!newTab) return null;

      const newPaneId = makePaneId();
      set((state) => {
        // What was to be split can be gone by the time the shell is up: the
        // pane closed, its group with it, or — asked for while the store was
        // starting — the placeholder layout replaced by the restore. The split
        // then goes where it would with nothing asked for: beside the active
        // pane of that group, or of the group on screen once the group is
        // gone. Splitting a pane that was not there any more changed nothing
        // and left the new terminal in no pane, its shell running unseen.
        const target = state.groups.find((g) => g.id === group.id) ?? resolveGroup(state, null, null);
        if (!target) return {};
        const at = collectLeaves(target.tree).some((l) => l.id === targetPaneId)
          ? targetPaneId
          : target.activePaneId;
        const newLeaf = { type: 'leaf', id: newPaneId, tabIds: [newTab.id], activeTabId: newTab.id };
        return settle(state, {
          groups: updateGroup(state, target.id, (g) =>
            withoutZoom({
              ...g,
              tree: splitAt(g.tree, at, newLeaf, direction, false),
            })
          ),
        });
      });
      return newPaneId;
    },

    /**
     * Split the active group's active pane and focus the newly created one —
     * by the pane alone, which names its group: a split whose group went away
     * while its shell started lands in another one (see `splitPane`).
     */
    splitActivePane: async (direction = 'horizontal') => {
      const group = get().getActiveGroup();
      if (!group) return null;
      const newPaneId = await get().splitPane(group.activePaneId, direction, group.id);
      if (newPaneId) get().setActivePane(newPaneId);
      return newPaneId;
    },

    /**
     * Close a pane inside its group. The sibling takes over the parent split.
     * Kills the pane's PTYs and drops those tabs UNLESS another pane — in ANY
     * group — still references the same tab id.
     */
    closePane: async (paneId, groupId = null) => {
      const group = resolveGroup(get(), groupId, paneId);
      if (!group) return;
      const closing = collectLeaves(group.tree).find((l) => l.id === paneId);
      if (!closing) return;
      const closingTabIds = [...closing.tabIds];

      set((state) => {
        const idx = state.groups.findIndex((g) => g.id === group.id);
        if (idx === -1) return {};
        const tree = removePane(state.groups[idx].tree, paneId);
        if (tree) {
          return settle(state, { groups: updateGroup(state, group.id, (g) => ({ ...g, tree })) });
        }
        // That was the group's last pane: the group goes with it, unless it is
        // the only group — then it is emptied instead.
        if (state.groups.length === 1) {
          return settle(state, {
            groups: updateGroup(state, group.id, (g) => ({ ...g, tree: emptyPane() })),
          });
        }
        const groups = state.groups.filter((g) => g.id !== group.id);
        const activeGroupId =
          state.activeGroupId === group.id
            ? groups[Math.min(idx, groups.length - 1)].id
            : state.activeGroupId;
        return settle(state, { groups, activeGroupId });
      });

      for (const tabId of closingTabIds) await killTabIfOrphaned(tabId);
    },

    /**
     * Close whichever pane is active in the active group.
     */
    closeActivePane: () => {
      const group = get().getActiveGroup();
      if (!group) return Promise.resolve();
      return get().closePane(group.activePaneId, group.id);
    },

    /**
     * Make `tabId` the visible tab of `paneId`. If the tab lives in another
     * pane — or another group — move it here first (clicking a tab chip never
     * splits).
     */
    bindPaneToTab: (paneId, tabId, groupId = null) =>
      set((state) => {
        const group = resolveGroup(state, groupId, paneId);
        if (!group || !collectLeaves(group.tree).some((l) => l.id === paneId)) return {};
        const source = groupOfTab(state, tabId);
        const holder = source ? leafHoldingTab(source.tree, tabId) : null;

        let groups = state.groups;
        if (!holder || holder.id !== paneId) {
          if (source) {
            groups = updateGroup(groups, source.id, (g) => ({
              ...g,
              tree: removeTabFromTree(g.tree, tabId),
            }));
          }
          groups = updateGroup(groups, group.id, (g) => ({
            ...g,
            tree: addTabToPane(g.tree, paneId, tabId),
            activePaneId: paneId,
          }));
        } else {
          groups = updateGroup(groups, group.id, (g) => ({
            ...g,
            tree: replaceNode(g.tree, paneId, (n) => ({ ...n, activeTabId: tabId })),
            activePaneId: paneId,
          }));
        }

        return settle(state, { groups, activeGroupId: group.id, activeTabId: tabId });
      }),

    /**
     * Drag & drop a terminal tab onto a pane — possibly one in another group.
     *
     * `zone` is where inside the target pane it was dropped:
     *   'center'                  → move the tab into that pane
     *   'left' | 'right'          → split the pane horizontally, tab on that side
     *   'top'  | 'bottom'         → split the pane vertically, tab on that side
     *
     * In a zoomed group only the zoomed pane can be dropped on from the screen.
     * Into it, the zoom stays: the tab lands where the user is looking. An
     * edge splits, which unzooms (see `splitPane`); and a tab moved into a
     * hidden pane by any other route makes that pane the active one, which
     * unzooms through `settle`.
     */
    dropTabOnPane: (tabId, targetPaneId, zone = 'center', targetGroupId = null) => {
      const state0 = get();
      if (!state0.tabs.some((t) => t.id === tabId)) return;
      const targetGroup = resolveGroup(state0, targetGroupId, targetPaneId);
      if (!targetGroup) return;
      if (!collectLeaves(targetGroup.tree).some((l) => l.id === targetPaneId)) return;

      const sourceGroup = groupOfTab(state0, tabId);
      const sourcePane = sourceGroup ? leafHoldingTab(sourceGroup.tree, tabId) : null;

      // Dropping a tab back on its own pane: just focus it. Splitting a pane
      // off its only tab would leave the source empty and is a no-op too.
      if (sourcePane && sourcePane.id === targetPaneId) {
        if (zone === 'center' || sourcePane.tabIds.length === 1) {
          get().bindPaneToTab(targetPaneId, tabId, targetGroup.id);
          return;
        }
      }

      set((state) => {
        let groups = state.groups;
        if (sourceGroup) {
          groups = updateGroup(groups, sourceGroup.id, (g) => ({
            ...g,
            tree: removeTabFromTree(g.tree, tabId),
          }));
        }

        if (zone === 'center') {
          groups = updateGroup(groups, targetGroup.id, (g) => ({
            ...g,
            tree: addTabToPane(g.tree, targetPaneId, tabId),
            activePaneId: targetPaneId,
          }));
          return settle(state, { groups, activeGroupId: targetGroup.id, activeTabId: tabId });
        }

        const newPaneId = makePaneId();
        const newLeaf = { type: 'leaf', id: newPaneId, tabIds: [tabId], activeTabId: tabId };
        const direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
        const insertFirst = zone === 'left' || zone === 'top';

        groups = updateGroup(groups, targetGroup.id, (g) =>
          withoutZoom({
            ...g,
            tree: splitAt(g.tree, targetPaneId, newLeaf, direction, insertFirst),
            activePaneId: newPaneId,
          })
        );
        return settle(state, { groups, activeGroupId: targetGroup.id, activeTabId: tabId });
      });
    },

    /**
     * Drop a terminal tab on a TAB STRIP: put it at slot `index` of pane
     * `targetPaneId` — its own strip (a reorder) or another pane's, in this
     * group or another one (a move that lands where it was let go).
     *
     * `index` is a slot among the target strip's tabs AS THEY ARE BEFORE THE
     * MOVE, the dragged tab included when it is already there: slot i is "just
     * before the tab now at position i", slot `tabIds.length` is "after the
     * last". In a strip [a, b, c], `a` dropped at slot 2 gives [b, a, c], and
     * slots 0 and 1 both leave it where it is. Across panes the dragged tab is
     * not in the target strip, so the slot is simply where it goes. A slot
     * outside the strip is clamped into it (see `moveToSlot`).
     *
     * The tab then shows in that pane, the pane takes focus and its group comes
     * on screen — what a click on the chip does. A drop that would leave all of
     * that as it already is changes no state at all: no new `groups` array, so
     * nothing re-renders and nothing is saved.
     *
     * A drop on the strip used to be `dropTabOnPane(…, 'center')`, which always
     * appends: along its own strip a tab could not move at all, and onto
     * another one it went to the end wherever it was let go.
     *
     * An unknown tab or pane, a pane outside `targetGroupId`, or an index that
     * is not a number: ignored.
     */
    moveTabInStrip: (tabId, targetPaneId, index, targetGroupId = null) =>
      set((state) => {
        if (!state.tabs.some((t) => t.id === tabId)) return state;
        const targetGroup = resolveGroup(state, targetGroupId, targetPaneId);
        const targetPane = targetGroup && collectLeaves(targetGroup.tree).find((l) => l.id === targetPaneId);
        if (!targetPane) return state;
        const tabIds = moveToSlot(targetPane.tabIds, tabId, index);
        if (!tabIds) return state;

        const fromThisStrip = targetPane.tabIds.includes(tabId);
        if (
          fromThisStrip &&
          sameOrder(tabIds, targetPane.tabIds) &&
          targetPane.activeTabId === tabId &&
          targetGroup.activePaneId === targetPaneId &&
          state.activeGroupId === targetGroup.id &&
          state.activeTabId === tabId
        ) {
          return state;
        }

        let groups = state.groups;
        const sourceGroup = fromThisStrip ? null : groupOfTab(state, tabId);
        if (sourceGroup) {
          groups = updateGroup(groups, sourceGroup.id, (g) => ({
            ...g,
            tree: removeTabFromTree(g.tree, tabId),
          }));
        }
        groups = updateGroup(groups, targetGroup.id, (g) => ({
          ...g,
          tree: replaceNode(g.tree, targetPaneId, (n) => ({ ...n, tabIds, activeTabId: tabId })),
          activePaneId: targetPaneId,
        }));
        // `settle` prunes the pane the tab left if that emptied it, exactly as
        // a drop on a pane's body does.
        return settle(state, { groups, activeGroupId: targetGroup.id, activeTabId: tabId });
      }),

    /**
     * Rename a tab (double-click its chip, or "Rename" from its right-click
     * menu). An empty/whitespace-only name resets it to its auto-generated
     * default (`Terminal N`) rather than leaving a blank label.
     */
    renameTab: (tabId, title) => {
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const trimmed = typeof title === 'string' ? title.trim() : '';
          return { ...t, title: trimmed || t.defaultTitle || t.title };
        }),
      }));
    },

    // Event listeners are attached once and can be torn down (HMR, unmount)
    // without losing the bootstrap state.
    attachListeners: async () => {
      if (listening) return;
      listening = true;
      // Before any shell is spawned: output a tab prints before its terminal
      // exists is kept for it from the first byte (see ptyOutputBus.js).
      //
      // The bus hands output straight to each terminal; the store does not
      // listen for it at all. A handler here would run for every chunk a
      // shell prints, and one that built a new `tabs` array per chunk
      // re-rendered everything that subscribes to it — the terminals side
      // bar, the split panes, the status bar. Profiled `type`-ing 1 MB into a
      // terminal, React's re-renders were the top of the renderer's
      // JavaScript time, above anything xterm.js did.
      await startPtyOutputBus();
      // OSC 133 "C" (see src-tauri/src/pty/osc.rs): a command has begun. This
      // is the only signal that a terminal is BUSY rather than sitting at a
      // prompt, and without it the tab strip could report a verdict but never
      // that one was still coming.
      unlisteners.push(await listen('pty-command-started', (payload) => {
        const { session_id } = payload || {};
        if (!session_id) return;
        set((state) => {
          let changed = false;
          const tabs = state.tabs.map((tab) => {
            if (tab.sessionId !== session_id || tab.running) return tab;
            changed = true;
            // The previous command's verdict goes now rather than when the new
            // one lands: a red dot beside a terminal that is visibly working
            // again describes nothing that is still true.
            return { ...tab, running: true, runStartedAt: Date.now(), lastExitCode: null };
          });
          // A new `tabs` array re-renders the side bar, every pane and the
          // status bar, so it is only ever built when something actually
          // changed.
          return changed ? { tabs } : state;
        });
      }));
      unlisteners.push(await listen('pty-command-done', (payload) => {
        const { session_id, exit_code } = payload || {};
        if (!session_id) return;
        // Counted first, and whether or not a tab holds this session yet —
        // see `commandEndsBySession`.
        commandEndsBySession.set(session_id, endsOf(session_id) + 1);
        // A new prompt: whatever was being typed is gone with the old one,
        // and the next line is followed from its first key.
        for (const t of get().tabs) if (t.sessionId === session_id) typedLines.delete(t.id);
        // The command's progress bar goes with the command (below): a program
        // that ended — or was killed — without taking its bar down must not
        // leave it standing over the prompt.
        const ended = get().tabs.filter((t) => t.sessionId === session_id).map((t) => t.id);
        set((state) => {
          // Built inside the same update as the tabs it describes: a second
          // `set` from within an updater is how two writes to one store end up
          // racing each other.
          const raised = [];
          const nextTabs = state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            // An end with no code — cmd's, whose PROMPT has no way to say —
            // is a command that FINISHED, not one that succeeded. It stays
            // null, and null is no verdict anywhere it is read: no red dot,
            // nothing on the status bar, a notification that only says it
            // finished. `exit_code ?? 0` would call every one a success.
            const code = typeof exit_code === 'number' ? exit_code : null;
            const note = notificationFor(
              tab,
              code,
              state.activeTabId,
              (useSettingsStore.getState().terminalNotifyAfterSeconds ?? 0) * 1000
            );
            if (note) raised.push({ ...note, read: false });
            // The agent typed into this shell (see `recordAgent`) has exited
            // at the first end after it was typed that arrives while
            // something is RUNNING: a C came first, or on Windows its line
            // went unanswered long enough to count as running. `running` is
            // read here, before this D clears it. A D at a prompt is not a
            // command ending — a second integration in the user's rc prints
            // its own D beside NexTerm's, so does a D the user put in cmd's
            // PROMPT, and a transient prompt redrawn on Enter sends one
            // before the command's C — and none of those may end the record.
            //
            // Nothing is left running to pick back up, so the record goes,
            // and with it the offer to resume on the next launch — which for
            // a conversation that was never sent a message could only ever
            // fail. The user can still `claude --resume` by hand. Two ends
            // this cannot tell apart: Ctrl+Z suspending the agent counts as
            // it exiting, and on cmd, which sends no C, an agent gone within
            // SUBMIT_GRACE_MS — a resume that fails at once — is not counted,
            // so its record stays for one more offer.
            const agentExited = tab.running && tab.agentTyped?.sessionId === session_id;
            return {
              ...tab,
              lastExitCode: code,
              running: false,
              runStartedAt: null,
              ...(agentExited ? { agent: null, agentResumeOffered: false, agentTyped: null } : {}),
            };
          });
          return raised.length === 0
            ? { tabs: nextTabs }
            : {
                tabs: nextTabs,
                notifications: capNotifications([...raised, ...state.notifications], NOTIFICATION_LIMIT),
              };
        });
        // Behind the output the command printed, which may still be on its
        // way through xterm (`afterTerminalOutput`). An update still waiting
        // is dropped with it.
        dropProgressAfterOutput(ended);
        // An agent that ended has no conversation left to look up — a retry
        // waiting minutes for its title (`retryResolve`) goes with it — nor
        // one to keep from other terminals (`idHints`).
        for (const t of get().tabs) {
          if (t.sessionId === session_id && !t.agent) forgetAgentTitle(t.id);
        }
        commandEnded(ended);
      }));
      unlisteners.push(await listen('pty-exit', (payload) => {
        const { session_id, exit_code } = payload || {};
        if (!session_id) return;
        // Nothing more will come from this shell to count.
        commandEndsBySession.delete(session_id);

        // Nor to show, when no tab holds it: its output was kept for a
        // terminal that will never exist. A tab closed before its shell's end
        // got here — the backend drains the shell after the kill, so output
        // arrives after the close freed what was kept — or a shell left by a
        // previous page load, reaped at startup. Not while the store is still
        // starting: a restore spawns every shell before any tab holds one, and
        // a shell already gone (a missing WSL distro, a broken profile) left
        // its last words for the tab about to show them.
        const forgetIfUnheld = (state) => {
          if (!state.tabs.some((t) => t.sessionId === session_id)) forgetOutput(session_id);
        };
        if (get().isInitialized) {
          forgetIfUnheld(get());
        } else {
          const stop = api.subscribe((state) => {
            if (!state.isInitialized) return;
            stop();
            forgetIfUnheld(state);
          });
        }

        // Nothing is left running to finish what a bar was counting — taken
        // down behind the shell's last output, as at a command's end.
        const gone = get().tabs.filter((t) => t.sessionId === session_id).map((t) => t.id);
        dropProgressAfterOutput(gone);
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            // Remember that this shell is gone. Without it the tab looked
            // alive — blinking cursor, full scrollback — while every
            // keystroke went nowhere.
            return {
              ...tab,
              exited: { code: typeof exit_code === 'number' ? exit_code : null },
              // A shell killed mid-command never sends its "D" marker, so this
              // is the only thing that stops the tab pulsing forever.
              running: false,
              runStartedAt: null,
            };
          }),
        }));
      }));
      // OSC 7 (see src-tauri/src/pty/osc.rs / shell_integration.rs): the
      // shell reports its live working directory on every prompt. Update
      // only the tab that owns this session — and the store's own `cwd`
      // (used as the default spawn dir for new tabs/panes) only when that
      // tab happens to be the active one — so restoring/duplicating always
      // uses where the user actually is, not just where the tab started.
      unlisteners.push(await listen('pty-cwd', (payload) => {
        const { session_id, cwd } = payload || {};
        if (!session_id || typeof cwd !== 'string' || !cwd) return;
        set((state) => {
          const tab = state.tabs.find((t) => t.sessionId === session_id);
          if (!tab || tab.cwd === cwd) return {};
          return {
            tabs: state.tabs.map((t) => (t.sessionId === session_id ? { ...t, cwd } : t)),
            cwd: tab.id === state.activeTabId ? cwd : state.cwd,
          };
        });
      }));
      // A window title a program set (OSC 0 / 2), read by the backend whether
      // or not the terminal has been shown. Only an opencode terminal's means
      // anything here: the conversation it shows (`noteAgentTitle`).
      unlisteners.push(await listen('pty-title', (payload) => {
        const { session_id, title } = payload || {};
        if (!session_id || typeof title !== 'string') return;
        const tab = get().tabs.find((t) => t.sessionId === session_id);
        if (tab?.agent) get().noteAgentTitle(tab.id, title);
      }));
    },

    dispose: () => {
      for (const off of unlisteners) {
        try {
          if (typeof off === 'function') off();
        } catch (_) {
          // listener already gone
        }
      }
      unlisteners = [];
      listening = false;
      // Write the pending layout out rather than dropping it on the floor.
      flushPersist();
    },

    /**
     * Bring the terminals up. Safe to call while a call is still running.
     *
     * App calls this from its mount effect, which React StrictMode runs twice
     * in development — and the second call arrived while the first was still
     * spawning. `isInitialized` is only set once the shells are up, so both
     * calls restored the saved layout, and the second overwrote the first:
     * every restored tab left one shell running with no tab to show it (one
     * reload with two saved tabs: four new backend sessions, two terminals on
     * screen). Callers now share the run in flight. It is dropped once it
     * settles, so a later init() — a relaunch — runs from scratch.
     */
    init: () => {
      if (!initInFlight) {
        initInFlight = get().bootstrap().finally(() => {
          initInFlight = null;
        });
      }
      return initInFlight;
    },

    /** The work behind `init`. Call `init` — it keeps concurrent calls from spawning twice. */
    bootstrap: async () => {
      if (get().isInitialized) {
        await get().attachListeners();
        return;
      }
      // A workspace restored from disk starts a run: what was resumed in the
      // last one says nothing about the terminals coming back now.
      opencodeResumers.clear();
      continuedLatest.clear();

      try {
        // Listening before anything is spawned. A shell draws its first
        // prompt within tens of milliseconds of the spawn — sooner than the
        // restore below takes to spawn the rest and put them in the store —
        // and Tauri keeps no event for a listener that arrives after it. The
        // listeners used to go up last, and every restored shell's first D
        // was lost. Each handler already ignores a session no tab holds, and
        // command ends are counted per session for exactly that case.
        await get().attachListeners();

        // null while no folder is open: the backend then starts terminals in
        // the home directory and says where in `ptySession.cwd`.
        let rootPath = null;
        try {
          rootPath = await invoke('fs_get_root');
        } catch (_) {
          // backend unavailable — use the browser mock's virtual root
          rootPath = '/workspace';
        }
        set({ cwd: rootPath });

        // Reap whatever the backend is still holding before spawning anything.
        //
        // A webview reload (⌘R, or Vite replacing a module it cannot hot-swap)
        // restarts this store from nothing while the Rust side keeps its
        // session map, and the restore below always spawns a fresh PTY per tab
        // — the saved payload carries a title and a directory, never a session
        // id. So the previous set stayed alive with no tab to show it: one
        // leaked shell per reload, measured as 1 → 2 → 3 → 4 child shells over
        // three reloads with a single terminal on screen.
        //
        // We claim what this store holds, which is normally nothing: a page
        // load starts it with no terminals, and one asked for while this runs
        // waits for it (`spawnTab`). One made before the start began is kept
        // by it (`keepTabsMadeMeanwhile`), so its shell must not be reaped.
        try {
          const reaped = await invoke('pty_retain_only', {
            session_ids: get().tabs.map((t) => t.sessionId).filter(Boolean),
          });
          if (reaped) {
            console.info(`[TerminalStore] Reaped ${reaped} terminal session(s) left by a previous page load.`);
          }
        } catch (err) {
          // An older backend has no such command. Leaking is worse than
          // failing to start, so carry on.
          console.warn('[TerminalStore] Could not reap previous terminal sessions:', err);
        }

        // Try to bring back last session's groups/panes/tabs. Any failure here
        // (corrupt payload, every pty_spawn rejecting, ...) must fall back to
        // the plain single-terminal bootstrap below rather than leaving the
        // app with a half-built workspace. A v1 payload is migrated rather
        // than discarded — see `migrateV1Workspace`.
        set({ savedGroups: loadSavedGroups(), savedWorkspaces: loadSavedWorkspaces() });

        const saved = loadWorkspacePayload();
        // The session's name is saved with its layout, and comes back even
        // when the layout does not: a session closed down to no terminals at
        // all, or one whose every terminal fails to start, takes the fresh
        // start below — which kept "Default" and saved it over the name.
        const savedName =
          typeof saved?.workspaceName === 'string' && saved.workspaceName.trim() ? saved.workspaceName.trim() : null;
        let restored = null;
        if (saved) {
          try {
            restored = await restoreSavedLayout(saved, rootPath);
          } catch (err) {
            console.error(
              '[TerminalStore] Failed to restore saved terminal layout — falling back to a single terminal:',
              err
            );
            restored = null;
          }
        }

        if (restored) {
          set((state) => ({
            ...keepTabsMadeMeanwhile(state, {
              tabs: restored.tabs,
              groups: restored.groups,
              activeGroupId: restored.activeGroupId,
              activeTabId: restored.activeTabId,
            }),
            cwd: restored.cwd,
            isInitialized: true,
            // The session's name is saved with its layout and comes back with
            // it. It used to be read and dropped: every launch was "Default"
            // again, and the first save after it wrote that over the name the
            // user had given.
            workspaceName: restored.workspaceName,
          }));
          return;
        }

        // Nothing asked for a directory, so the setting decides, as it does
        // for every other new terminal. Where it has no answer this still asks
        // for `rootPath`, as it always did — the open folder, or null with
        // none open, which is where the backend's own fallback lands anyway.
        const firstDir = (await startDirFor(null)) ?? rootPath;
        const spawnFirst = (dir) =>
          invoke('pty_spawn', {
            cols: 80,
            rows: 24,
            cwd: dir,
            shell: useSettingsStore.getState().terminalDefaultShell,
          });
        let ptySession;
        try {
          ptySession = await spawnFirst(firstDir);
        } catch (err) {
          // The one terminal a fresh start has. A setting that names a
          // directory the shell cannot enter must not leave the app with
          // none, so it gets the open folder instead — which is all this ever
          // asked for before the setting existed.
          if (firstDir === rootPath) throw err;
          console.warn(`[TerminalStore] Could not start the first terminal in "${firstDir}" — using the open folder:`, err);
          ptySession = await spawnFirst(rootPath);
        }

        const defaultTitle = nextDefaultTitle(get().tabs);
        const initialTab = {
          id: makeTabId(),
          title: defaultTitle,
          defaultTitle,
          sessionId: ptySession.session_id,
          cwd: ptySession.cwd || rootPath,
          spawnedAt: Date.now(),
        };
        const group = makeGroup({ name: 'Group 1', tabIds: [initialTab.id] });

        set((state) => ({
          ...keepTabsMadeMeanwhile(state, {
            tabs: [initialTab],
            groups: [group],
            activeGroupId: group.id,
            activeTabId: initialTab.id,
          }),
          cwd: initialTab.cwd,
          isInitialized: true,
          ...(savedName ? { workspaceName: savedName } : {}),
        }));
      } catch (err) {
        console.error('[TerminalStore] Failed to initialize terminal session:', err);
      }
    },

    createTab: async (titleOrOptions = null, options = {}) => {
      // Backward/forward-compatible signature: createTab(), createTab('Title'),
      // createTab({ title, paneId, groupId }), or createTab('Title', { paneId,
      // groupId }). A caller-supplied paneId/groupId targets that pane (and
      // brings its group on screen) instead of whatever is active — see
      // TerminalSplitContainer's per-pane "+" button.
      let title = null;
      let paneId = null;
      let groupId = null;
      let shell = null;
      if (titleOrOptions && typeof titleOrOptions === 'object') {
        title = titleOrOptions.title ?? null;
        paneId = titleOrOptions.paneId ?? null;
        groupId = titleOrOptions.groupId ?? null;
        shell = titleOrOptions.shell ?? null;
      } else {
        title = titleOrOptions;
        paneId = options?.paneId ?? null;
        groupId = options?.groupId ?? null;
        shell = options?.shell ?? null;
      }

      const newTab = await spawnTab(title, null, shell);
      if (!newTab) return null;

      set((state) => {
        // The pane asked for can be gone by the time the shell is up — closed,
        // or, asked for while the store was starting, replaced along with the
        // whole placeholder layout — and its group with it. The terminal then
        // goes where one goes when nothing is asked for: the active pane of
        // the group on screen. It used to go nowhere, a shell running with no
        // pane to show it until the next launch reaped it.
        const group = resolveGroup(state, groupId, paneId) ?? resolveGroup(state, null, null);
        if (!group) return {};
        const targetPaneId = collectLeaves(group.tree).some((l) => l.id === paneId)
          ? paneId
          : group.activePaneId;
        return settle(state, {
          groups: updateGroup(state, group.id, (g) => ({
            ...g,
            tree: addTabToPane(g.tree, targetPaneId, newTab.id),
            activePaneId: targetPaneId,
          })),
          activeGroupId: group.id,
          activeTabId: newTab.id,
        });
      });

      return newTab;
    },

    /**
     * "Copy Tab": open a new terminal in the SAME (live) working directory as
     * `tabId`, placed in that same tab's pane, and make it the active tab
     * there. `tab.cwd` is kept current by the `pty-cwd` listener below (OSC
     * 7), so this lands wherever the user actually `cd`'d to — not just
     * where the original tab was first spawned.
     */
    duplicateTab: async (tabId) => {
      const source = get().tabs.find((t) => t.id === tabId);
      if (!source) return null;

      const sourceGroup = groupOfTab(get(), tabId);
      const holder = sourceGroup ? leafHoldingTab(sourceGroup.tree, tabId) : null;

      // Duplicate keeps the source's shell as well as its directory — a copy
      // of a Git Bash terminal that opens PowerShell is not a copy.
      // Its directory as a shell can be started there: a Git Bash `/c/x` is
      // `C:\x` (`startableCwd`), or the copy fell back to the workspace root.
      const newTab = await spawnTab(null, startableCwd(source, useSystemStore.getState().os), source.shell);
      if (!newTab) return null;

      set((state) => {
        const group =
          (sourceGroup && state.groups.find((g) => g.id === sourceGroup.id)) || state.getActiveGroup();
        if (!group) return {};
        const targetPaneId = collectLeaves(group.tree).some((l) => l.id === holder?.id)
          ? holder.id
          : group.activePaneId;
        return settle(state, {
          groups: updateGroup(state, group.id, (g) => ({
            ...g,
            tree: addTabToPane(g.tree, targetPaneId, newTab.id),
            activePaneId: targetPaneId,
          })),
          activeGroupId: group.id,
          activeTabId: newTab.id,
        });
      });

      return newTab;
    },

    /**
     * Show a terminal. Because only one group is on screen at a time, this
     * also switches to the group that owns the tab and focuses the pane
     * holding it.
     */
    switchTab: (tabId) => {
      const state0 = get();
      const tab = state0.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const owner = groupOfTab(state0, tabId);
      if (!owner) {
        // A spawned-but-unplaced tab (see `spawnTab`) belongs to no group yet.
        set({ activeTabId: tabId, cwd: tab.cwd });
        return;
      }
      const pane = leafHoldingTab(owner.tree, tabId);
      set((state) =>
        settle(state, {
          groups: updateGroup(state, owner.id, (g) => ({
            ...g,
            tree: replaceNode(g.tree, pane.id, (n) => ({ ...n, activeTabId: tabId })),
            activePaneId: pane.id,
          })),
          activeGroupId: owner.id,
          activeTabId: tabId,
          cwd: tab.cwd,
        })
      );
    },

    closeTab: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) return;

      closingTabs.add(tabId);
      try {
        try {
          await invoke('pty_kill', { session_id: tab.sessionId });
        } catch (e) {
          console.warn('[TerminalStore] pty_kill failed:', e);
        }
        await disposeTerminalView(tabId);
        typedLines.delete(tabId);
        forgetTerminal(tabId);
        batchJobReplies.forget(tabId);
        // Whatever its shell printed that no terminal ever showed goes with it.
        forgetOutput(tab.sessionId);

        // `settle` sweeps a dropped tab id out of EVERY group (not just one
        // tree), prunes whichever pane it emptied, and drops a group that ends
        // up with nothing — keeping the last group as an empty one.
        set((state) =>
          settle(state, {
            tabs: state.tabs.filter((t) => t.id !== tabId),
            activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
          })
        );
      } finally {
        closingTabs.delete(tabId);
      }
    },

    /**
     * Terminal: Clear — the palette's Clear Terminal, the Terminal menu, and
     * ⌘L / Ctrl+L outside a terminal (inside one, Ctrl+L is the shell's).
     * All of them used to clear "unpinned blocks", which nothing has shown
     * since the block view went, so every way in did nothing.
     */
    clearTerminal: async (tabId = null) => {
      const targetId = tabId || get().activeTabId;
      return targetId ? clearTerminalView(targetId) : false;
    },

    /**
     * Run an agent in a terminal, and remember which conversation it is.
     *
     * The command is TYPED into the shell rather than spawned in place of
     * one. That is how a person starts an agent, it leaves a working shell
     * when the agent exits, and it makes a terminal NexTerm started and a
     * terminal someone typed in the same kind of thing.
     *
     * Typed once the shell has drawn its first prompt, not the moment the
     * terminal exists — which is when New Claude Code Terminal calls this.
     * Typed earlier, the command was typeahead, echoed once by the tty and
     * again by the line editor. Typed at a prompt, the agent is watched, and
     * its exit ends the record (see `recordAgent`). A shell that never sends
     * a D gets the command once the wait is up and keeps the record, as
     * every shell did before.
     */
    startAgent: async (tabId, kind) => {
      const targetId = tabId || get().activeTabId;
      if (!get().tabs.some((t) => t.id === targetId)) return null;

      let started;
      try {
        started = startCommand(kind);
      } catch (err) {
        console.error('[TerminalStore] Unknown agent:', err);
        return null;
      }

      const readiness = await untilPromptReady(targetId);
      if (readiness === 'gone') return null;
      recordAgent(targetId, started.agent, readiness === 'ready');
      await get().writeRaw(targetId, `${started.command}\r`);
      return started.agent;
    },

    /**
     * Pick the conversation back up in a terminal that was restored.
     *
     * Only ever the RESUME form: `claude` refuses `--session-id` for an id it
     * already has ("Session ID … is already in use"), so re-running the start
     * command would kill the terminal on every relaunch.
     *
     * Refused, with the offer kept, while a command is running. The text is
     * typed, so it goes to whatever holds the terminal — quite possibly the
     * agent itself, started by hand while the offer was still up — and not to
     * a shell. `running` comes from shell integration (OSC 133), or on Windows
     * from a submitted line the shell has not answered (`noteSubmittedLine`);
     * a shell without integration never reports one and is typed into as
     * before.
     *
     * Pressed before a restored shell has drawn its first prompt, it waits
     * for that prompt, for the same reasons `startAgent` does. And the agent
     * it types ends its record the same way, when it exits — including a
     * resume that fails at once, like `claude --resume` for a conversation
     * that was never sent a message and so was never saved (#37).
     *
     * An opencode record with no id — its lookup failed while it ran, or
     * never ran — is looked up now, before anything is typed, and so is one
     * whose id another terminal has (`needsLookup`, `lookUpResume`). Typed by
     * id whenever the list says which conversation; never one another
     * terminal holds. When it cannot tell, nothing is typed: the offer stays
     * and says why, and the banner opens its list. `--continue` only for the
     * one opencode terminal within its reach (`aloneInReach`) when the list
     * cannot say, and the terminal says why first. Typed blind, it put three of four
     * terminals on one folder into the same conversation.
     *
     * `choice` is a pick from the banner's list (`chosenResume`): refused,
     * with a notice naming the terminal, when another terminal already has
     * it (`takenByOther`). Resolves with whether a command was typed.
     */
    resumeAgent: async (tabId, choice = null) => {
      const targetId = tabId || get().activeTabId;
      const tab = get().tabs.find((t) => t.id === targetId);
      if (!tab || tab.running || tab.agentResumeLooking) return false;

      let plan = chosenResume(tab.agent, choice);
      const heldBy = plan && tab.agent?.kind === 'opencode' ? takenByOther(get(), targetId, choice) : undefined;
      if (heldBy !== undefined) {
        // Refused, and said: the list may have been read before that
        // terminal took it.
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === targetId
              ? { ...t, agentResumeNotice: { kind: 'taken', heldBy, latest: choice.latest === true, seq: (noticeSeq += 1) } }
              : t
          ),
        }));
        return false;
      }
      if (!plan && needsLookup(get(), tab)) {
        plan = await lookUpResume(targetId);
        if (!plan) return false;
      }
      const { agent, command, note = null, continued = false } = plan ?? {
        agent: tab.agent,
        command: resumeCommand(tab.agent),
      };
      // The offer goes away either way: an agent we no longer recognise is
      // not something to keep asking about. And it goes before any wait for
      // a prompt, so it cannot be taken twice while that wait lasts — with
      // the record set to what is about to be typed (`takeOffer`; a
      // looked-up one was taken as it was decided).
      if (!command) {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === targetId ? { ...t, agentResumeOffered: false, agentResumeNotice: null } : t)),
        }));
        return false;
      }
      takeOffer(targetId, agent, { continued });

      const readiness = await untilPromptReady(targetId);
      if (readiness === 'gone') return false;
      if (note && !notifyTerminal(targetId, note)) console.warn(`[TerminalStore] ${note}`);
      recordAgent(targetId, agent, readiness === 'ready');
      await get().writeRaw(targetId, `${command}\r`);
      return true;
    },

    /**
     * The conversations the agent offered back in `tabId` keeps for that
     * terminal's directory, newest first — for the resume banner's list.
     * Only opencode keeps a list NexTerm can read (src-tauri/src/commands/
     * agent.rs); claude's resume is exact already. Rejects with the reason
     * when the list cannot be had. Each comes with `heldBy`: the name of the
     * other terminal that has it (`holdersElsewhere`), or null.
     */
    listAgentSessions: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab?.agent?.kind !== 'opencode') return [];
      const cwd = lookupFolder(tab);
      if (!cwd) throw new Error('this terminal is in no folder on this machine to look in');
      const sessions = await listOpencodeSessions(cwd);
      // Which other terminal each is open in, offered back in, or was
      // resumed into this run, by its name (`holdersElsewhere`): the list
      // shows it, and a pick of it is refused (`takenByOther`).
      const holders = holdersElsewhere(get(), tabId);
      return sessions.map((s) => ({ ...s, heldBy: holders.has(s.id) ? nameOf(holders.get(s.id)) : null }));
    },

    /**
     * What Resume in `tabId` does when its opencode conversation is not found
     * by name, for the offer to say: 'continue' — the most recent in the
     * folder or below, for the one opencode terminal within its reach
     * (`aloneInReach`) — or 'ask'. Null for anything but opencode.
     */
    resumeFallbackFor: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab?.agent?.kind !== 'opencode') return null;
      return aloneInReach(get(), tabId) ? 'continue' : 'ask';
    },

    /**
     * A window title the program in `tabId` set. While opencode runs there it
     * names its conversation that way (`OC | <title>`), and that is how the
     * terminal learns WHICH conversation to resume after a restart: the
     * title is looked up (`resolveAgentSession`) once it has held still for
     * AGENT_RESOLVE_DELAY_MS. Its home screen's `OpenCode` and the '' it
     * sets as it quits say nothing and change nothing.
     */
    noteAgentTitle: (tabId, windowTitle) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      const agent = tab?.agent;
      if (!agent || agent.kind !== 'opencode' || tab.agentResumeOffered) return;
      const shown = opencodeTitleOf(windowTitle);
      // opencode sends the same title again as it redraws; this record has
      // already made of it whatever there was to make.
      if (!shown || shownTitles.get(tabId) === shown) return;
      shownTitles.set(tabId, shown);
      // The conversation it is already known to be in, first shown after a
      // resume by id.
      if (agent.sessionId && agent.title && opencodeTitleMatches(shown, agent.title)) return;
      // Another conversation, or the first title of this one. An id stays
      // only while no title was ever known for it: one typed with `-s`, or a
      // record from before titles were kept — the lookup keeps it if it fits.
      // One let go of is kept aside (`idHints`): the same conversation,
      // renamed, is found again by it rather than dealt out anew.
      if (agent.sessionId && agent.title) idHints.set(tabId, agent.sessionId);
      const next = {
        ...agent,
        sessionId: agent.sessionId && !agent.title ? agent.sessionId : null,
        title: cleanAgentTitle(shown),
      };
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === tabId && t.agent === agent ? { ...t, agent: next } : t)),
      }));
      clearTimeout(resolveTimers.get(tabId));
      resolveTimers.set(
        tabId,
        setTimeout(() => {
          resolveTimers.delete(tabId);
          resolveAgentSession(tabId);
        }, agentResolveDelayMs)
      );
    },

    /**
     * Type a layout template's startup command into a terminal it opened.
     *
     * The same way, and on the same schedule, as `startAgent` types an agent:
     * nothing until the shell has drawn its first prompt — its first OSC 133
     * "D" (`untilPromptReady`) — or, for a shell that never sends one (fish,
     * sh), until AGENT_PROMPT_WAIT_MS after it started; then the line and an
     * Enter, `\r`, through `writeRaw`, exactly what pressing Enter sends. The
     * same on every platform and in every shell: PowerShell, cmd and the
     * POSIX shells all run a line on `\r`, and the command is the user's own
     * text, typed as they would type it — nothing is quoted for a shell.
     *
     * Typed earlier, the line would be typeahead, echoed once by the tty and
     * again by the line editor. Not typed at all when the terminal closed
     * first, or when something is already running in it by then — something
     * the user started during the wait, which the text would be typed INTO;
     * that terminal says so instead. Cleaned again here
     * (`sanitizeStartupCommand`), whoever passed it in: one line, nothing in
     * it that a line editor would take as a key.
     *
     * The terminal remembers the command from the start, so its group saved
     * again — even before its shell is ready — keeps it as this terminal's
     * startup command (`suggestStartupCommand`). Resolves with whether it was
     * typed.
     */
    typeStartupCommand: async (tabId, command) => {
      const { ok, command: line } = sanitizeStartupCommand(command);
      if (!ok || !line || !get().tabs.some((t) => t.id === tabId)) return false;
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, startupCommand: line } : t)),
      }));

      const readiness = await untilPromptReady(tabId);
      if (readiness === 'gone') return false;
      if (get().tabs.find((t) => t.id === tabId)?.running) {
        notifyTerminal(tabId, `startup command not typed — something is already running here: ${line}`);
        return false;
      }
      await get().writeRaw(tabId, `${line}\r`);
      return true;
    },

    /** Leave the terminal as a plain shell, and stop offering. */
    dismissAgentResume: (tabId) => {
      const targetId = tabId || get().activeTabId;
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === targetId ? { ...t, agentResumeOffered: false, agentResumeNotice: null, agent: null } : t
        ),
      }));
    },

    // Raw keystrokes for a running command (Ctrl-C, answers to prompts, arrows).
    writeRaw: async (tabId, data) => {
      const targetId = tabId || get().activeTabId;
      const tab = get().tabs.find((t) => t.id === targetId);
      if (!tab || !data) return;
      // A terminal whose shell has exited has nowhere to send keys. Enter
      // starts a new shell in its place (src/lib/shellExit.js); anything else
      // is dropped quietly — every key used to come back as one more
      // "PTY session not found" line.
      if (tab.exited) {
        if (restartsShell(data)) await get().restartShell(targetId);
        return;
      }
      // Every key and every line the app types goes through here, so this is
      // where the line being typed can be followed to the command it runs —
      // and where a Ctrl+C into cmd starts the wait for "Terminate batch job
      // (Y/N)?", and anything typed after it ends that wait.
      followTyping(tab, data);
      batchJobReplies.noteInput(targetId, data);
      // Both taken before the write: the shell's answer can arrive before
      // `invoke` resolves, and it must still count as an answer to this line.
      const submitted = { at: Date.now(), endsBefore: endsOf(tab.sessionId) };
      try {
        await invoke('pty_write', { session_id: tab.sessionId, data });
        if (submitsLine(data)) get().noteSubmittedLine(targetId, submitted);
      } catch (err) {
        // The backend refuses input the tty would silently discard — a paste
        // longer than one canonical-mode line, which the kernel drops whole.
        // Swallowing that to the console is how a pasted block could vanish
        // with nothing on screen to say it had.
        const message = typeof err === 'string' ? err : err?.message;
        // The shell is gone and its exit has not reached us yet (or never
        // will: a writer that died keeps the session but takes no input).
        // Say it once, in words, and treat the terminal as exited from here.
        if (sessionIsGone(message)) {
          let first = false;
          set((state) => ({
            tabs: state.tabs.map((t) => {
              if (t.id !== targetId || t.sessionId !== tab.sessionId || t.exited) return t;
              first = true;
              return { ...t, exited: { code: null }, running: false, runStartedAt: null };
            }),
          }));
          if (first && !notifyTerminal(targetId, 'The shell in this terminal has stopped. Press Enter to start a new one.')) {
            console.error('[TerminalStore] Raw write failed:', err);
          }
          return;
        }
        if (!notifyTerminal(targetId, message)) {
          console.error('[TerminalStore] Raw write failed:', err);
        }
      }
    },

    /**
     * Start a new shell in a terminal whose shell has exited — what Enter
     * does there (`writeRaw`), as Windows Terminal's "press Enter to
     * restart". The tab, its place in its pane and its scrollback stay; it
     * gets a fresh session in its last directory, with the shell it ran.
     *
     * A session that stopped taking input may still have a live shell
     * behind it (the writer died, the process did not), so it is ended
     * first rather than left running unseen. Its agent record goes: the
     * agent ended with the shell, and offering it back would be a guess.
     * Resolves with whether a new shell was started; on failure the terminal
     * stays exited, says why, and the next Enter tries again.
     */
    restartShell: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || !tab.exited || restarting.has(tabId) || closingTabs.has(tabId)) return false;
      restarting.add(tabId);
      try {
        try {
          await invoke('pty_kill', { session_id: tab.sessionId });
        } catch (_) {
          // Already gone, which is the usual case.
        }
        const startDir = await startDirFor(tab.cwd);
        const shellSpec = tab.shell || useSettingsStore.getState().terminalDefaultShell;
        // At the size the terminal last told its PTY, not 80×24 with a resize
        // to follow: ConPTY redraws on a resize from where it believes its
        // cursor is.
        const size = parseSize(tab.lastSize);
        const { cols, rows } = size ?? { cols: 80, rows: 24 };
        const spawnAt = (dir) => invoke('pty_spawn', { cols, rows, cwd: dir, shell: shellSpec });
        let ptySession;
        try {
          ptySession = await spawnAt(startDir);
        } catch (err) {
          if (startDir === null) throw err;
          ptySession = await spawnAt(null);
        }
        if (!get().tabs.some((t) => t.id === tabId) || closingTabs.has(tabId)) {
          // Closed, or being closed, while the new shell started: it must not
          // outlive the tab.
          invoke('pty_kill', { session_id: ptySession.session_id }).catch(() => {});
          return false;
        }
        typedLines.delete(tabId);
        forgetAgentTitle(tabId);
        // A bar from the shell that exited describes nothing in the new one.
        cancelProgress(tabId);
        set((state) => ({
          progress: withoutProgress(state.progress, [tabId]),
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  sessionId: ptySession.session_id,
                  cwd: ptySession.cwd || t.cwd,
                  shell: ptySession.shell || t.shell,
                  exited: null,
                  running: false,
                  runStartedAt: null,
                  lastExitCode: null,
                  commandLine: null,
                  agent: null,
                  agentResumeOffered: false,
                  agentTyped: null,
                  // What the new PTY was started at — 80×24 when the old one
                  // was never told a size — so `resizePty` sends what differs.
                  lastSize: size ? tab.lastSize : null,
                  spawnedAt: Date.now(),
                }
              : t
          ),
        }));
        return true;
      } catch (err) {
        const message = typeof err === 'string' ? err : err?.message;
        if (!notifyTerminal(tabId, `Could not start a new shell: ${message}`)) {
          console.error('[TerminalStore] Could not start a new shell:', err);
        }
        return false;
      } finally {
        restarting.delete(tabId);
      }
    },

    /**
     * A line was just sent to the shell. On Windows, count it as a running
     * command unless the shell answers first.
     *
     * `running` comes from OSC 133 "C". ConPTY (seen on Windows 10 19045)
     * forwards an escape sequence that changes nothing on screen only with the
     * next frame that does, and C is such a sequence. For the first command of
     * a PowerShell session it is written after the frame carrying the Enter has
     * already gone, so it arrived with the next prompt, beside D: the terminal
     * read as idle for the whole run, and Resume typed into whatever was
     * running. That is the very case the guard is for — a restored terminal
     * where something is started before the offer is taken.
     *
     * So a line the shell has not answered within SUBMIT_GRACE_MS counts as a
     * command that started when it was submitted. A C arriving later changes
     * nothing (`running` is already set) and D ends it as usual. Only:
     *
     * - for a session that has sent D at least once. fish and sh send none,
     *   and nothing would ever clear a `running` guessed for them.
     * - on Windows. Elsewhere C arrives on time, and a continuation line
     *   (`for …` + Enter) that the shell is still waiting on would read as busy.
     *
     * cmd reports a D with every prompt and never a C, so for cmd this is
     * the ONLY way a command reads as running. Its continuation prompt
     * (`More?`, after an open bracket or a `^`) is not its PROMPT and sends
     * no D, so a line left open there reads as running until it is finished
     * — as PowerShell's `>>` already does.
     */
    noteSubmittedLine: (tabId, { at = Date.now(), endsBefore } = {}) => {
      if (!submitInfersRunning) return;
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.running || tab.exited || endsOf(tab.sessionId) === 0) return;
      const sessionId = tab.sessionId;
      const ends = endsBefore ?? endsOf(sessionId);
      setTimeout(() => {
        set((state) => {
          let changed = false;
          const tabs = state.tabs.map((t) => {
            if (t.id !== tabId || t.sessionId !== sessionId || t.running || t.exited) return t;
            // A D since the line went out: the shell answered it, so it was
            // a prompt (or a command already over), not one still running.
            // Counted rather than timed — a clock cannot order two events
            // in the same millisecond.
            if (endsOf(sessionId) !== ends) return t;
            changed = true;
            return { ...t, running: true, runStartedAt: at, lastExitCode: null };
          });
          return changed ? { tabs } : state;
        });
      }, SUBMIT_GRACE_MS);
    },

    /**
     * Tell the shell how big its terminal is — once the size has stopped
     * changing.
     *
     * Dragging a divider produces a new size every frame, and each one used to
     * go straight through: a `set` on `tabs` (so every component watching
     * `tabs` re-rendered — the terminals panel, the split container, the tab
     * strips) and a `pty_resize` (so the shell got a SIGWINCH and redrew its
     * prompt). Sixty times a second, for as long as the drag lasted. That is
     * the flicker; xterm itself was keeping up fine.
     *
     * So the local terminal still follows the pointer — `fitAndReport` resizes
     * xterm on every frame, and it is cheap — but the shell and the store hear
     * about it once, when the drag settles. The returned promise resolves when
     * that has happened, and a superseded one resolves as soon as it is
     * superseded, so `await resizePty(...)` never hangs and never lies.
     */
    resizePty: (tabId, cols, rows) => {
      const tab = get().tabs.find((t) => t.id === (tabId || get().activeTabId));
      if (!tab || !cols || !rows) return Promise.resolve();
      const key = `${cols}x${rows}`;

      const pending = pendingResizes.get(tab.id);
      // Already on its way to exactly this size, or already there.
      if (pending ? pending.key === key : tab.lastSize === key) return Promise.resolve();
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve();
      }

      return new Promise((resolve) => {
        const timer = setTimeout(async () => {
          pendingResizes.delete(tab.id);
          set((state) => ({
            tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, lastSize: key } : t)),
          }));
          // The tab's session now: Enter may have started a new shell since
          // the size was asked for, and the old one is gone.
          const sessionId = get().tabs.find((t) => t.id === tab.id)?.sessionId ?? tab.sessionId;
          try {
            await invoke('pty_resize', { session_id: sessionId, cols, rows });
          } catch (err) {
            console.error('[TerminalStore] Resize failed:', err);
          }
          resolve();
        }, RESIZE_SETTLE_MS);
        pendingResizes.set(tab.id, { key, timer, resolve });
      });
    },

    getActiveTab: () => {
      const { tabs, activeTabId } = get();
      return tabs.find((t) => t.id === activeTabId) || tabs[0] || null;
    },
  };
});

// Debounced write-behind: any change to the groups, the tab list, or which
// group is on screen schedules a save. Guarded on `isInitialized` so the
// store's own bootstrap (or a restore) never immediately overwrites what it
// just loaded, and gated to changes that actually matter to the persisted
// shape so typing into a running command doesn't thrash localStorage.
//
// `groups` is compared BY REFERENCE, and every group write rebuilds that array
// (see `updateGroup` / `settle`) — a mutation deep inside a group, including
// one in a group that is NOT on screen, therefore still schedules a save.
// That reference check is only a shortcut past the key below, so it has to
// name every slice of state `buildPersistedPayload` reads.
/**
 * The payload itself, as text: whether anything worth saving changed is asked
 * of exactly what would be saved.
 *
 * Comparing `state.tabs` by reference used to schedule a save on every
 * `pty-output` chunk — the array was rebuilt per chunk, but none of the
 * persisted FIELDS changed — which is what kept the debounce permanently reset.
 * The cure for that was a fingerprint kept by hand beside the payload, and
 * the two drifted apart: `agent` went into the payload and never into the
 * fingerprint, so starting an agent or dismissing the offer to resume one
 * scheduled no save at all, and the record the resume offer is built from
 * never reached disk. A field added to the payload is now compared here
 * without anyone having to remember it.
 *
 * It runs on every change to `tabs` or `groups` — once per command start and
 * finish, once per settled resize. For 16 terminals in 4 groups that is under
 * 4 KB of JSON and about 5µs, measured; the fingerprint it replaces already
 * stringified every group's tree and took about 3µs. Scrollback is not in the
 * payload, so a busy terminal does not make it any dearer.
 */
function persistKeyOf(state) {
  return JSON.stringify(buildPersistedPayload(state));
}

let lastPersistKey = null;

useTerminalStore.subscribe((state, prevState) => {
  if (!state.isInitialized) return;
  if (
    state.groups === prevState.groups &&
    state.tabs === prevState.tabs &&
    state.activeGroupId === prevState.activeGroupId &&
    state.workspaceName === prevState.workspaceName
  ) {
    return;
  }
  const key = persistKeyOf(state);
  if (key === lastPersistKey) return;
  lastPersistKey = key;
  schedulePersist(state);
});

/** `map` keeping only the keys in `live` — the same object when it had no others. */
function keepLive(map, live) {
  if (!map) return map;
  const dead = Object.keys(map).filter((id) => !live.has(id));
  if (dead.length === 0) return map;
  const next = { ...map };
  for (const id of dead) delete next[id];
  return next;
}

/**
 * What the attention state keeps about terminals, for terminals that exist.
 *
 * ONE place for it, rather than a line in every action that removes a tab:
 * a tab goes when it is closed, when its pane or its group is, when a
 * workspace is loaded over it, when a saved group replaces it — and every one
 * of those ends in `tabs` losing it. So whenever `tabs` changes, the bell's
 * entries, the progress bars and the flashes of tabs that are not in it any
 * more are dropped, and with them the timers, rate limits and held-back
 * updates kept outside the store. Nothing is written when nothing is stale,
 * which is the usual case: `tabs` changes with every command a shell runs.
 */
function pruneAttention(state) {
  const live = new Set(state.tabs.map((t) => t.id));
  for (const [id, timer] of flashTimers) {
    if (live.has(id)) continue;
    clearTimeout(timer);
    flashTimers.delete(id);
  }
  for (const limiters of [bellLimiters, flashLimiters]) {
    for (const id of limiters.keys()) if (!live.has(id)) limiters.delete(id);
  }
  for (const [id, fold] of bellFolds) {
    if (live.has(id)) continue;
    clearTimeout(fold.timer);
    bellFolds.delete(id);
  }
  for (const [id, throttle] of progressThrottles) {
    if (live.has(id)) continue;
    throttle.cancel();
    progressThrottles.delete(id);
  }
  const notifications = state.notifications.some((n) => !live.has(n?.tabId))
    ? state.notifications.filter((n) => live.has(n?.tabId))
    : state.notifications;
  const progress = keepLive(state.progress, live);
  const attentionFlash = keepLive(state.attentionFlash, live);
  if (notifications === state.notifications && progress === state.progress && attentionFlash === state.attentionFlash) return;
  useTerminalStore.setState({ notifications, progress, attentionFlash });
}

// Attention upkeep, on every change to the store:
//
//   - a tab that went takes what was kept about it along (`pruneAttention`);
//   - a terminal that becomes the active tab while the window has focus has
//     been seen, and its entries are read. That covers every way the active
//     tab moves — a click on a chip, a pane, the side bar, a shortcut, a
//     group switch, a closed tab handing over to its neighbour — without each
//     of them having to remember. A switch while the window is in the
//     background marks nothing: nobody saw it. Typing needs no rule of its
//     own, as typing into a terminal means it is the active tab of a focused
//     window, which it was made when it got there.
//
// Read through `setState` rather than the state's own actions, which a suite
// may have swapped for recorders (menu_contract.test.js).
useTerminalStore.subscribe((state, prevState) => {
  if (state.tabs !== prevState.tabs) pruneAttention(state);
  const { activeTabId } = useTerminalStore.getState();
  if (activeTabId && activeTabId !== prevState.activeTabId && currentAttention().focused) {
    // Made active by a press: read when it is let go (`notePointer`).
    if (pointerPressed) {
      seenOnRelease = true;
      return;
    }
    useTerminalStore.setState((s) => {
      const notifications = markRead(s.notifications, (n) => n.tabId === s.activeTabId);
      return notifications === s.notifications ? s : { notifications };
    });
  }
});

// Progress bars off: every bar goes at once, not only the next report. The
// taskbar follows from the map emptying (src/hooks/useAttention.js).
useSettingsStore.subscribe((settings, prevSettings) => {
  if (settings.terminalProgress === false && prevSettings.terminalProgress !== false) {
    for (const throttle of progressThrottles.values()) throttle.cancel();
    useTerminalStore.setState((s) => (Object.keys(s.progress || {}).length === 0 ? s : { progress: {} }));
  }
});

// The webview can go away without warning (quit, reload, a Windows update
// reboot). Write out whatever is pending rather than losing it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
}

export default useTerminalStore;
