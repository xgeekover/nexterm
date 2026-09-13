import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
// `loadState` is deliberately NOT used for reads any more: it treats any older
// schema as absent, which for this store's keys would mean silently bootstrapping
// over the user's workspace. Reads go through `loadVersionedState` + an explicit
// version branch; writes still use `saveState` (always the current version).
import { saveState, loadVersionedState, SCHEMA_VERSION } from '../lib/persistence.js';
import { useSettingsStore } from './settingsStore.js';

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
//   Group = { id, name, createdAt, tree: Pane|Split, activePaneId }
//
// This replaces the previous model, where `splitTree` was ONE tree whose
// LEAVES were the groups (all on screen at once) and a `groupViewMode` /
// `focusedPaneId` pair faked "show only one of them". Both are gone: the model
// is permanently "one group fills the area", so a leaf is now a pane *inside*
// a group rather than a group itself.

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
 *  - `activeGroupId` names an existing group
 *  - `activeTabId` is real and lives in the ACTIVE group
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
    if (activePaneId === group.activePaneId && name === group.name) return group;
    return { ...group, name, activePaneId };
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
// `title`/`cwd`. PTY sessions and scrollback are process state and cannot
// survive a relaunch — `init()` spawns a *fresh* PTY per saved tab.
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
    tabs: state.tabs.map((t) => ({ id: t.id, title: t.title, cwd: t.cwd })),
  };
}

/**
 * Debounced write-behind, with a ceiling.
 *
 * A plain restart-on-every-change debounce is starvable, and a terminal is
 * exactly the thing that starves it: `pty-output` rebuilds `state.tabs` on
 * every chunk, so a shell printing more often than the debounce (a dev server,
 * `tail -f`, a test watcher) pushed the save out forever. Renaming a group or
 * rearranging panes then never reached disk until the output stopped — and if
 * the app was quit while it was still streaming, all of it was lost.
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
 */
function normalizeSavedEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id !== 'string' || !Array.isArray(entry.tabs) || entry.tabs.length === 0) return null;
  const hasSlots = entry.tabs.every((t) => t && typeof t.slotId === 'string' && t.slotId);
  if (!hasSlots || !entry.tree) return migrateV1SavedGroup(entry, index);
  const slotIds = new Set(entry.tabs.map((t) => t.slotId));
  const tree = normalizeTree(pruneTree(sanitizeRestoredTree(entry.tree, slotIds, new Set())));
  if (!tree) return migrateV1SavedGroup(entry, index);
  return { ...entry, tree };
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
  return list.filter(
    (w) => w && typeof w.id === 'string' && Array.isArray(w.groups) && w.groups.length > 0
  );
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

export const useTerminalStore = create((set, get) => {
  /**
   * Spawn a PTY-backed tab and register it in `tabs`, WITHOUT placing it
   * anywhere in any group — callers decide where it goes. Keeping placement
   * out of tab creation is what makes two-level placement easy: `splitPane`
   * can put the new tab only in the freshly-created pane of one group,
   * instead of it also lingering wherever focus happened to be when the PTY
   * finished spawning.
   */
  const spawnTab = async (title = null, cwd = null) => {
    try {
      const ptySession = await invoke('pty_spawn', {
        cols: 80,
        rows: 24,
        cwd: cwd || get().cwd || '/workspace',
        shell: useSettingsStore.getState().terminalDefaultShell,
      });

      const defaultTitle = `Terminal ${get().tabs.length + 1}`;
      const newTab = {
        id: makeTabId(),
        title: title || defaultTitle,
        defaultTitle,
        sessionId: ptySession.session_id,
        cwd: ptySession.cwd || get().cwd,
        blocks: [],
        activePrompt: '',
      };

      set((state) => ({ tabs: [...state.tabs, newTab] }));
      return newTab;
    } catch (err) {
      console.error('[TerminalStore] Failed to create terminal tab:', err);
      return null;
    }
  };

  /** Kill a tab's PTY and drop it, unless some pane in some group still shows it. */
  /**
   * Freeze one group into something storable: its layout with the live tab
   * ids swapped for stable slot ids, and each terminal's title and CURRENT
   * directory (the live OSC 7 cwd, not the one it was opened at).
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
        tabs.push({ slotId, title: tab.title, cwd: tab.cwd });
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
   */
  const materializeGroup = async (entry, fallbackName = 'Saved group') => {
    if (!entry || !Array.isArray(entry.tabs) || entry.tabs.length === 0) return null;

    const bySlot = new Map();
    const spawned = [];
    for (const saved of entry.tabs) {
      const tab = await spawnTab(saved.title, saved.cwd);
      if (!tab) continue;
      spawned.push(tab);
      if (saved.slotId) bySlot.set(saved.slotId, tab.id);
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
    };
  };

  const killTabIfOrphaned = async (tabId) => {
    if (groupOfTab(get(), tabId)) return;
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    try {
      await invoke('pty_kill', { session_id: tab.sessionId });
    } catch (e) {
      console.warn('[TerminalStore] pty_kill failed:', e);
    }
    await disposeTerminalView(tabId);
    set((state) => settle(state, { tabs: state.tabs.filter((t) => t.id !== tabId) }));
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
      const wantedCwd = savedTab.cwd || rootPath;

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

      const defaultTitle = `Terminal ${newTabs.length + 1}`;
      newTabs.push({
        id: savedTab.id,
        title: savedTab.title || defaultTitle,
        defaultTitle,
        sessionId: ptySession.session_id,
        cwd: ptySession.cwd || wantedCwd,
        blocks: [],
        activePrompt: '',
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

  const initialGroup = makeGroup({ name: 'Group 1' });

  return {
    tabs: [],
    activeTabId: null,
    history: [],
    historyIndex: -1,
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
     * to another group that group is brought on screen.
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

    /**
     * Bring a group on screen. Its arrangement is exactly as it was last left;
     * the active tab moves with it (an inactive group's terminals keep
     * running, so this is purely a view/focus change).
     */
    /** Rename the session you are working in. */
    renameWorkspace: (name) => {
      const trimmed = (name || '').trim();
      if (trimmed) set({ workspaceName: trimmed });
    },

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

    // ---- Groups --------------------------------------------------------
    /**
     * Create a new group with one terminal in it and switch to it.
     * Returns the new group (or null if the PTY could not be spawned).
     */
    createGroup: async ({ name = null, cwd = null } = {}) => {
      const tab = await spawnTab(null, cwd || get().cwd);
      if (!tab) return null;
      const group = makeGroup({
        name: (typeof name === 'string' && name.trim()) || `Group ${get().groups.length + 1}`,
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
     * switcher. A blank name resets it to the positional default.
     */
    renameGroup: (groupId, name) =>
      set((state) => {
        const idx = state.groups.findIndex((g) => g.id === groupId);
        if (idx === -1) return {};
        const trimmed = typeof name === 'string' ? name.trim() : '';
        return {
          groups: updateGroup(state, groupId, (g) => ({ ...g, name: trimmed || `Group ${idx + 1}` })),
        };
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
        name: (typeof name === 'string' && name.trim()) || `Group ${state.groups.length + 1}`,
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
     * Re-open a saved group. `mode: 'new-group'` (default) rebuilds it as a
     * brand-new group, layout and all; `'replace'` drops its terminals into
     * the active group's active pane. Each terminal respawns at its saved cwd,
     * falling back to the workspace root when that directory is gone.
     *
     * Returns the id of the group the terminals landed in.
     */
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
     * Bring a whole workspace back.
     *
     * `replace` puts the session back the way it was — every saved group, and
     * the ones currently open are closed and their shells reaped. `append`
     * adds the saved groups alongside what is already there.
     *
     * Everything is spawned BEFORE anything is closed, so a failure partway
     * through leaves the user with what they already had rather than nothing.
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

      set((state) =>
        settle(state, {
          groups: mode === 'replace' ? newGroups : [...state.groups, ...newGroups],
          activeGroupId: active.id,
          activeTabId: collectLeaves(active.tree)[0]?.activeTabId ?? null,
          // Replacing the session means you are now IN that workspace.
          ...(mode === 'replace' && entry.name ? { workspaceName: entry.name } : {}),
        })
      );

      for (const tabId of doomed) await killTabIfOrphaned(tabId);
      return active.id;
    },

    loadSavedGroup: async (savedId, { mode = 'new-group' } = {}) => {
      const entry = get().savedGroups.find((g) => g.id === savedId);
      if (!entry || !Array.isArray(entry.tabs) || entry.tabs.length === 0) return null;

      // Merge into the group on screen: one shell per saved slot, dropped into
      // the active pane. The saved LAYOUT is deliberately ignored here — the
      // user asked for these terminals inside the arrangement they are looking
      // at, not for that arrangement to be replaced.
      if (mode === 'replace') {
        const spawned = [];
        for (const saved of entry.tabs) {
          const tab = await spawnTab(saved.title, saved.cwd);
          if (tab) spawned.push(tab);
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
      return made.group.id;
    },

    // ---- Panes ---------------------------------------------------------
    /**
     * Split a pane into two (horizontal or vertical) inside its group. The new
     * tab is spawned directly into the new pane, never into the pane being
     * split, so the same tab can never end up listed in two panes at once.
     * Returns the new pane's id (or null if the split could not be created).
     */
    splitPane: async (paneId, direction = 'horizontal', groupId = null) => {
      const group = resolveGroup(get(), groupId, paneId);
      if (!group) return null;
      const targetPaneId = collectLeaves(group.tree).some((l) => l.id === paneId)
        ? paneId
        : group.activePaneId;

      const newTab = await spawnTab();
      if (!newTab) return null;

      const newPaneId = makePaneId();
      set((state) => {
        // The group can have gone away while the PTY was spawning.
        if (!state.groups.some((g) => g.id === group.id)) return {};
        const newLeaf = { type: 'leaf', id: newPaneId, tabIds: [newTab.id], activeTabId: newTab.id };
        return settle(state, {
          groups: updateGroup(state, group.id, (g) => ({
            ...g,
            tree: splitAt(g.tree, targetPaneId, newLeaf, direction, false),
          })),
        });
      });
      return newPaneId;
    },

    /**
     * Split the active group's active pane and focus the newly created one.
     */
    splitActivePane: async (direction = 'horizontal') => {
      const group = get().getActiveGroup();
      if (!group) return null;
      const newPaneId = await get().splitPane(group.activePaneId, direction, group.id);
      if (newPaneId) get().setActivePane(newPaneId, group.id);
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

        groups = updateGroup(groups, targetGroup.id, (g) => ({
          ...g,
          tree: splitAt(g.tree, targetPaneId, newLeaf, direction, insertFirst),
          activePaneId: newPaneId,
        }));
        return settle(state, { groups, activeGroupId: targetGroup.id, activeTabId: tabId });
      });
    },

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
      unlisteners.push(await listen('pty-output', (payload) => {
        const { session_id, data } = payload || {};
        if (!session_id || !data) return;

        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            const blocks = [...tab.blocks];
            const runningIdx = blocks.findIndex((b) => b.status === 'running');
            if (runningIdx !== -1) {
              blocks[runningIdx] = {
                ...blocks[runningIdx],
                output: blocks[runningIdx].output + data,
              };
            }
            // No running block: this is prompt/banner noise — never append it
            // to a finished (possibly pinned) block.
            return { ...tab, blocks };
          }),
        }));
      }));
      unlisteners.push(await listen('pty-command-done', (payload) => {
        const { session_id, exit_code } = payload || {};
        if (!session_id) return;
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            const idx = tab.blocks.findIndex((b) => b.status === 'running');
            if (idx === -1) return tab;
            const blocks = [...tab.blocks];
            const running = blocks[idx];
            const ok = exit_code === null || exit_code === undefined || exit_code === 0;
            blocks[idx] = {
              ...running,
              // zsh pads the last line to the terminal width before the prompt;
              // drop that trailing whitespace so blocks end cleanly.
              output: running.output.replace(/[ \t]+\r?$/, ''),
              status: ok ? 'completed' : 'failed',
              exitCode: exit_code ?? 0,
              durationMs: Date.now() - (running.startTime || Date.now()),
            };
            return { ...tab, blocks };
          }),
        }));
      }));
      unlisteners.push(await listen('pty-exit', (payload) => {
        const { session_id, exit_code } = payload || {};
        if (!session_id) return;

        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            // Remember that this shell is gone. Without it the tab looked
            // alive — blinking cursor, full scrollback — while every
            // keystroke went nowhere.
            tab = { ...tab, exited: { code: typeof exit_code === 'number' ? exit_code : null } };
            const blocks = [...tab.blocks];
            const runningIdx = blocks.findIndex((b) => b.status === 'running');
            if (runningIdx !== -1) {
              const blk = blocks[runningIdx];
              blocks[runningIdx] = {
                ...blk,
                status: exit_code === 0 ? 'completed' : 'failed',
                exitCode: exit_code,
                durationMs: Math.max(1, Date.now() - (blk.startTime || Date.now())),
              };
            }
            return { ...tab, blocks };
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

    init: async () => {
      if (get().isInitialized) {
        await get().attachListeners();
        return;
      }

      try {
        let rootPath = '/workspace';
        try {
          rootPath = (await invoke('fs_get_root')) || rootPath;
        } catch (_) {
          // browser mock or backend unavailable — keep the virtual default
        }
        set({ cwd: rootPath });

        // Try to bring back last session's groups/panes/tabs. Any failure here
        // (corrupt payload, every pty_spawn rejecting, ...) must fall back to
        // the plain single-terminal bootstrap below rather than leaving the
        // app with a half-built workspace. A v1 payload is migrated rather
        // than discarded — see `migrateV1Workspace`.
        set({ savedGroups: loadSavedGroups(), savedWorkspaces: loadSavedWorkspaces() });

        const saved = loadWorkspacePayload();
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
          set({
            tabs: restored.tabs,
            activeTabId: restored.activeTabId,
            cwd: restored.cwd,
            isInitialized: true,
            groups: restored.groups,
            activeGroupId: restored.activeGroupId,
          });
          await get().attachListeners();
          return;
        }

        const ptySession = await invoke('pty_spawn', {
          cols: 80,
          rows: 24,
          cwd: rootPath,
          shell: useSettingsStore.getState().terminalDefaultShell,
        });

        const defaultTitle = 'Terminal 1';
        const initialTab = {
          id: makeTabId(),
          title: defaultTitle,
          defaultTitle,
          sessionId: ptySession.session_id,
          cwd: ptySession.cwd || rootPath,
          blocks: [],
          activePrompt: '',
        };
        const group = makeGroup({ name: 'Group 1', tabIds: [initialTab.id] });

        set({
          tabs: [initialTab],
          activeTabId: initialTab.id,
          cwd: initialTab.cwd,
          isInitialized: true,
          groups: [group],
          activeGroupId: group.id,
        });

        await get().attachListeners();
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
      if (titleOrOptions && typeof titleOrOptions === 'object') {
        title = titleOrOptions.title ?? null;
        paneId = titleOrOptions.paneId ?? null;
        groupId = titleOrOptions.groupId ?? null;
      } else {
        title = titleOrOptions;
        paneId = options?.paneId ?? null;
        groupId = options?.groupId ?? null;
      }

      const newTab = await spawnTab(title);
      if (!newTab) return null;

      set((state) => {
        const group = resolveGroup(state, groupId, paneId);
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

      const newTab = await spawnTab(null, source.cwd);
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

      try {
        await invoke('pty_kill', { session_id: tab.sessionId });
      } catch (e) {
        console.warn('[TerminalStore] pty_kill failed:', e);
      }
      await disposeTerminalView(tabId);

      // `settle` sweeps a dropped tab id out of EVERY group (not just one
      // tree), prunes whichever pane it emptied, and drops a group that ends
      // up with nothing — keeping the last group as an empty one.
      set((state) =>
        settle(state, {
          tabs: state.tabs.filter((t) => t.id !== tabId),
          activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
        })
      );
    },

    executeCommand: async (commandText, tabId = null) => {
      const trimmed = (commandText || '').trim();
      if (!trimmed) return null;

      const targetTabId = tabId || get().activeTabId;
      const tab = get().tabs.find((t) => t.id === targetTabId);
      if (!tab) return null;

      const blockId = `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const block = {
        id: blockId,
        command: trimmed,
        cwd: tab.cwd || get().cwd,
        output: '',
        exitCode: null,
        durationMs: 0,
        startTime: Date.now(),
        status: 'running',
        pinned: false,
      };

      set((state) => {
        const nextTabs = state.tabs.map((t) => {
          if (t.id !== targetTabId) return t;
          return {
            ...t,
            blocks: [...t.blocks, block],
          };
        });
        const nextHistory = [...state.history, trimmed];
        return {
          tabs: nextTabs,
          history: nextHistory,
          historyIndex: nextHistory.length,
        };
      });

      try {
        await invoke('pty_write', {
          session_id: tab.sessionId,
          data: `${trimmed}\n`,
        });
      } catch (err) {
        console.error('[TerminalStore] Failed to write to PTY:', err);
        set((state) => ({
          tabs: state.tabs.map((t) => {
            if (t.id !== targetTabId) return t;
            return {
              ...t,
              blocks: t.blocks.map((b) =>
                b.id === blockId ? { ...b, status: 'failed', exitCode: 1, output: `Error: ${err.message}\n` } : b
              ),
            };
          }),
        }));
      }

      return block;
    },

    pinBlock: (blockId) => {
      let resultPinned = false;
      set((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          blocks: tab.blocks.map((b) => {
            if (b.id === blockId) {
              resultPinned = !b.pinned;
              return { ...b, pinned: resultPinned };
            }
            return b;
          }),
        })),
      }));
      return resultPinned;
    },

    clearBlocks: (tabId = null) => {
      const targetTabId = tabId || get().activeTabId;
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.id !== targetTabId) return tab;
          return {
            ...tab,
            blocks: tab.blocks.filter((b) => b.pinned),
          };
        }),
      }));
    },

    // Replace a block's recorded output outright. No other field changes.
    // (Bookkeeping only — the live terminal surface renders straight from PTY
    // output and never reads `blocks`; this exists for callers that want to
    // overwrite a block's history entry wholesale, e.g. a future re-run.)
    setBlockOutput: (tabId, blockId, output) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          return {
            ...tab,
            blocks: tab.blocks.map((b) => (b.id === blockId ? { ...b, output } : b)),
          };
        }),
      }));
    },

    // Raw keystrokes for a running command (Ctrl-C, answers to prompts, arrows).
    writeRaw: async (tabId, data) => {
      const tab = get().tabs.find((t) => t.id === (tabId || get().activeTabId));
      if (!tab || !data) return;
      try {
        await invoke('pty_write', { session_id: tab.sessionId, data });
      } catch (err) {
        console.error('[TerminalStore] Raw write failed:', err);
      }
    },

    // Keep the backend PTY's window size in step with the pane (debounced by the caller).
    resizePty: async (tabId, cols, rows) => {
      const tab = get().tabs.find((t) => t.id === (tabId || get().activeTabId));
      if (!tab || !cols || !rows) return;
      const key = `${cols}x${rows}`;
      if (tab.lastSize === key) return;
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, lastSize: key } : t)),
      }));
      try {
        await invoke('pty_resize', { session_id: tab.sessionId, cols, rows });
      } catch (err) {
        console.error('[TerminalStore] Resize failed:', err);
      }
    },

    setCwd: (cwd) => set({ cwd }),

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
/**
 * What the persisted payload is actually made of. Comparing `state.tabs` by
 * reference used to schedule a save on every `pty-output` chunk — the array is
 * rebuilt per chunk, but none of the persisted FIELDS change — which is what
 * kept the debounce permanently reset.
 */
function persistKeyOf(state) {
  return `${state.workspaceName}|${state.activeGroupId}|${state.groups
    .map((g) => `${g.id}:${g.name}:${JSON.stringify(serializeTreeForPersist(g.tree))}:${g.activePaneId}`)
    .join(';')}|${state.tabs.map((t) => `${t.id}:${t.title}:${t.cwd}`).join(';')}`;
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

// The webview can go away without warning (quit, reload, a Windows update
// reboot). Write out whatever is pending rather than losing it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
}

export default useTerminalStore;
