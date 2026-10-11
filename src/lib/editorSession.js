/**
 * The editor tabs of an open folder, as they are remembered between launches.
 *
 * A restart brought every terminal back — layout, names, directories — and
 * every editor tab was gone. VS Code keeps the open editors per workspace,
 * and so does this: for each folder, the editor's split tree with each tab
 * written as the FILE it shows, which group is active and which tab.
 *
 * Only paths are kept, never text. A restored tab reads its file again, as it
 * is on disk now: unsaved edits are not carried over (closing over them asks
 * first, as it always has).
 *
 * Everything here is pure, so that the shape can be tested without a store:
 * `serializeSession` turns the editor's state into what is saved,
 * `normalizeSessions` turns whatever storage hands back into something safe
 * to restore — or into nothing — and `restoredLayout` turns a saved session
 * back into a split tree of tab ids.
 *
 * What storage hands back is untrusted. It may be from another build, edited
 * by hand, cut short, or name files outside the folder it is filed under. A
 * file outside the folder is dropped here, and the store reads every file it
 * keeps through `fs_read_file`, which the backend confines to the open folder
 * as well.
 *
 * `caseless` (the reading functions' option): compare paths without case, as
 * the disks of Windows and macOS do by default.
 */

import { collapseDots, samePath, stripTrailingSep, toPosix } from './paths.js';

/** Bumped when the saved shape changes; anything else is ignored. */
export const SESSION_FORMAT = 1;

/** How many folders are remembered: as many as Open Recent lists. */
export const SESSION_FOLDER_LIMIT = 12;

/** How many tabs one folder keeps — the most recently active. */
export const SESSION_TAB_LIMIT = 50;

/** The most failed launches a saved file's count is kept to (`misses`); the store gives up sooner. */
const MISSES_CAP = 99;

/**
 * How deep a saved split tree may nest. Far past anything a screen can show;
 * the bound is there so that a hand-made payload cannot recurse without end.
 */
const MAX_DEPTH = 32;

const DIRECTIONS = new Set(['horizontal', 'vertical']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * `text` in lower case, a character at a time and only where that keeps its
 * length — `İ` lowers to two — so that a position in it is a position in
 * `text`.
 */
function foldCase(text) {
  let out = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

/** One spelling per file, for telling two paths of one file apart from two files. */
function pathKey(path, caseless = false) {
  const key = toPosix(stripTrailingSep(path));
  return caseless ? foldCase(key) : key;
}

/**
 * The spelling a saved `path` is reopened under in `root`, or null when it may
 * not be. It must name a file strictly inside the folder once its `.` and
 * `..` are worked out by spelling (`collapseDots`) — as the backend works them
 * out before it opens anything, so `<root>/src/../README.md`, which a terminal
 * link resolved against `src` is spelled as, is the folder's README and
 * `<root>/../elsewhere` is not in the folder at all.
 *
 * `caseless`: `c:\proj\a.js` is in `C:\Proj`, and comes back spelled
 * `C:\Proj\a.js` — the folder's part as the folder is spelled, the rest as
 * saved. The read is confined by the backend all the same, so a disk that
 * does tell case apart refuses a file that is not there.
 *
 * A folder that is a filesystem root (`/`) is all separator, so what follows
 * it needs none of its own.
 */
export function restorablePath(root, path, { caseless = false } = {}) {
  if (typeof root !== 'string' || !root || root.includes('\u{0}')) return null;
  if (typeof path !== 'string' || !path || path.includes('\u{0}')) return null;
  const spelled = collapseDots(path);
  const base = pathKey(root, caseless);
  const key = pathKey(spelled, caseless);
  const inside =
    key.length > base.length && key.startsWith(base) && (base.endsWith('/') || key[base.length] === '/');
  if (!inside) return null;
  const folder = stripTrailingSep(root);
  return `${folder}${spelled.slice(folder.length)}`;
}

/**
 * Drop leaves with no files and collapse splits left with one child, keeping
 * any field a leaf carries. Null when nothing is left.
 */
function pruneEmpty(node) {
  if (node.type === 'leaf') return node.files.length > 0 ? node : null;
  const children = node.children.map(pruneEmpty).filter(Boolean);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

function leavesOf(node, acc = []) {
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((child) => leavesOf(child, acc));
  return acc;
}

/**
 * The finished session: `tree` pruned, the active group as an index into its
 * leaves (pane ids are minted afresh on every launch, so they mean nothing
 * saved), the active file, every file most recently active first, and
 * `misses` — for a file that launches have failed to read, how many in a
 * row. `marked` is the leaf that was active, if it survived. Null when no
 * file is left.
 */
function finish(root, tree, marked, activeFile, recent, misses = {}) {
  const pruned = tree ? pruneEmpty(tree) : null;
  if (!pruned) return null;
  const leaves = leavesOf(pruned);
  const files = new Set(leaves.flatMap((leaf) => leaf.files));
  let activePane = leaves.indexOf(marked);
  const file = files.has(activeFile) ? activeFile : null;
  if (activePane === -1) activePane = Math.max(0, leaves.findIndex((leaf) => leaf.files.includes(file)));
  const strip = (node) =>
    node.type === 'leaf'
      ? { type: 'leaf', files: node.files, active: node.active }
      : { type: 'split', direction: node.direction, children: node.children.map(strip) };
  return {
    root,
    tree: strip(pruned),
    activePane,
    activeFile: file ?? leaves[activePane].active,
    recent: recent.filter((path) => files.has(path)),
    misses: Object.fromEntries(
      Object.entries(misses).filter(([path, count]) => files.has(path) && Number.isInteger(count) && count > 0)
    ),
  };
}

/**
 * What is saved for the editor's state now: `rootPath`, `tabs`,
 * `editorSplitTree`, `activeEditorPaneId`, `activeTabId`. Null when no folder
 * is open or no tab is.
 *
 * `recencyOf(tabId)` says how recently a tab was the active one, larger being
 * later. Past SESSION_TAB_LIMIT tabs, the ones least recently active are left
 * out. A tab in no group is not on screen and is left out too; a tab in two
 * groups is kept in the first, and of two tabs on one file — `caseless`, two
 * spellings that differ only in case are one file — the one used last. Groups
 * left with no tab go, as an emptied group does on screen. `missesOf(tabId)`
 * is how many launches in a row have failed to read a tab's file.
 */
export function serializeSession(state, recencyOf = () => 0, { missesOf = () => 0, caseless = false } = {}) {
  const { rootPath, tabs, editorSplitTree, activeEditorPaneId, activeTabId } = state || {};
  if (typeof rootPath !== 'string' || !rootPath || !editorSplitTree || !Array.isArray(tabs)) return null;
  const pathOf = new Map(tabs.map((tab) => [tab.id, tab.filePath]));

  // Runs at every keystroke (typing changes `tabs`), so once over each tab.
  const shown = new Set();
  const walk = (node) => {
    if (node.type !== 'leaf') {
      node.children.forEach(walk);
      return;
    }
    for (const id of node.tabIds) {
      if (pathOf.has(id)) shown.add(id);
    }
  };
  walk(editorSplitTree);
  // A stable sort: tabs never active keep the order they are shown in.
  const files = new Set();
  const ranked = [...shown]
    .sort((a, b) => recencyOf(b) - recencyOf(a))
    .filter((id) => {
      const key = pathKey(pathOf.get(id), caseless);
      if (files.has(key)) return false;
      files.add(key);
      return true;
    })
    .slice(0, SESSION_TAB_LIMIT);
  const kept = new Set(ranked);

  const placed = new Set();
  let marked = null;
  const toNode = (node) => {
    if (node.type !== 'leaf') {
      return { type: 'split', direction: node.direction, children: node.children.map(toNode) };
    }
    const ids = node.tabIds.filter((id) => kept.has(id) && !placed.has(id));
    ids.forEach((id) => placed.add(id));
    const leaf = {
      type: 'leaf',
      files: ids.map((id) => pathOf.get(id)),
      active: pathOf.get(ids.includes(node.activeTabId) ? node.activeTabId : ids[0]) ?? null,
    };
    if (node.id === activeEditorPaneId) marked = leaf;
    return leaf;
  };
  const tree = toNode(editorSplitTree);
  const activeFile = kept.has(activeTabId) ? pathOf.get(activeTabId) : null;
  const misses = Object.fromEntries(ranked.map((id) => [pathOf.get(id), missesOf(id)]));
  return finish(rootPath, tree, marked, activeFile, ranked.map((id) => pathOf.get(id)), misses);
}

/**
 * A saved session made safe to restore, or null when nothing in it is.
 *
 * Every file must be a string strictly inside the folder the session is
 * filed under (`restorablePath`) and appear once in the whole tree; every
 * split must say which way it splits and hold a list of children. Anything
 * else is dropped and the rest kept, rather than the whole session thrown
 * away for one bad entry. The same caps as saving apply, so a payload from
 * a build with bigger ones cannot open more than this one would keep.
 */
export function normalizeSession(raw, { caseless = false } = {}) {
  if (!isRecord(raw) || typeof raw.root !== 'string' || !raw.root.trim() || raw.root.includes('\u{0}')) return null;
  const root = raw.root;

  const order = [];
  const firstSpelling = new Map(); // pathKey -> the spelling seen first
  const spellingOf = (path) => {
    const spelled = restorablePath(root, path, { caseless });
    return spelled === null ? null : { spelled, key: pathKey(spelled, caseless) };
  };
  /** The spelling a path already claimed goes by, or undefined. */
  const claimed = (path) => {
    const found = spellingOf(path);
    return found ? firstSpelling.get(found.key) : undefined;
  };
  const claim = (path) => {
    const found = spellingOf(path);
    if (!found || firstSpelling.has(found.key)) return null;
    firstSpelling.set(found.key, found.spelled);
    order.push(found.spelled);
    return found.spelled;
  };

  let leafIndex = 0;
  let marked = null;
  const read = (node, depth) => {
    if (!isRecord(node) || depth > MAX_DEPTH) return null;
    if (node.type === 'leaf') {
      const index = leafIndex++;
      const files = (Array.isArray(node.files) ? node.files : []).map(claim).filter(Boolean);
      const leaf = { type: 'leaf', files, active: typeof node.active === 'string' ? node.active : null };
      if (index === raw.activePane) marked = leaf;
      return leaf;
    }
    if (node.type === 'split' && DIRECTIONS.has(node.direction) && Array.isArray(node.children)) {
      const children = node.children.map((child) => read(child, depth + 1)).filter(Boolean);
      return children.length > 0 ? { type: 'split', direction: node.direction, children } : null;
    }
    return null;
  };
  const tree = read(raw.tree, 0);
  if (!tree) return null;

  // Most recently active first, as saved; a file the list does not name
  // ranks after every one it does, in the order the tree shows them.
  const named = (Array.isArray(raw.recent) ? raw.recent : []).map(claimed).filter(Boolean);
  const recent = [...new Set([...named, ...order])].slice(0, SESSION_TAB_LIMIT);
  const kept = new Set(recent);

  const cap = (node) => {
    if (node.type !== 'leaf') return { ...node, children: node.children.map(cap) };
    const files = node.files.filter((path) => kept.has(path));
    const named = claimed(node.active);
    const active = files.includes(named) ? named : files[0] ?? null;
    const leaf = { type: 'leaf', files, active };
    if (node === marked) marked = leaf;
    return leaf;
  };
  const capped = cap(tree);
  const activeFile = claimed(raw.activeFile);
  const misses = {};
  if (isRecord(raw.misses)) {
    for (const [path, count] of Object.entries(raw.misses)) {
      const file = claimed(path);
      if (file && Number.isInteger(count) && count > 0) misses[file] = Math.min(count, MISSES_CAP);
    }
  }
  return finish(root, capped, marked, kept.has(activeFile) ? activeFile : null, recent, misses);
}

/**
 * Every session in a stored payload that is safe to restore, most recently
 * used first: at most SESSION_FOLDER_LIMIT, one per folder (the first wins).
 * Anything that is not this format's payload is no sessions at all.
 */
export function normalizeSessions(data, options = {}) {
  if (!isRecord(data) || data.format !== SESSION_FORMAT || !Array.isArray(data.folders)) return [];
  const sessions = [];
  for (const raw of data.folders) {
    if (sessions.length >= SESSION_FOLDER_LIMIT) break;
    const session = normalizeSession(raw, options);
    if (session && !sessions.some((other) => samePath(other.root, session.root))) sessions.push(session);
  }
  return sessions;
}

/** The payload that stores `sessions`. */
export function sessionsPayload(sessions) {
  return { format: SESSION_FORMAT, folders: sessions };
}

/** The session saved for `root`, or null. */
export function sessionFor(sessions, root) {
  return sessions.find((session) => samePath(session.root, root)) ?? null;
}

/**
 * `sessions` with `root`'s replaced by `session` and moved to the front — the
 * folder used last — or taken out when `session` is null (no tab open). The
 * least recently used go past SESSION_FOLDER_LIMIT, as Open Recent's do.
 */
export function withSession(sessions, root, session) {
  const others = sessions.filter((other) => !samePath(other.root, root));
  return (session ? [session, ...others] : others).slice(0, SESSION_FOLDER_LIMIT);
}

/** Every file a session holds, most recently active first: the order to read them in. */
export function sessionFiles(session) {
  return session ? [...session.recent] : [];
}

/**
 * The editor's split tree for a saved session, each file replaced by the tab
 * `tabIdOf(path)` names. A file it names no tab for — one that could not be
 * read back — is left out; a group left with no file goes, as a group does
 * when its last tab is closed, and its split with it.
 *
 * `newId('pane' | 'split')` mints the ids. Returns `{ tree, activePaneId,
 * activeTabId }`, or null when no file is left to show.
 */
export function restoredLayout(session, tabIdOf, newId) {
  if (!session) return null;
  const used = new Set();
  let index = 0;
  let marked = null;
  const build = (node) => {
    if (node.type !== 'leaf') {
      return { type: 'split', id: newId('split'), direction: node.direction, children: node.children.map(build) };
    }
    const tabIds = [];
    for (const path of node.files) {
      const id = tabIdOf(path);
      if (id && !used.has(id)) {
        used.add(id);
        tabIds.push(id);
      }
    }
    const active = tabIdOf(node.active);
    const leaf = {
      type: 'leaf',
      id: newId('pane'),
      tabIds,
      activeTabId: tabIds.includes(active) ? active : tabIds[0] ?? null,
    };
    if (index++ === session.activePane) marked = leaf;
    return leaf;
  };

  const prune = (node) => {
    if (node.type === 'leaf') return node.tabIds.length > 0 ? node : null;
    const children = node.children.map(prune).filter(Boolean);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { ...node, children };
  };
  const tree = prune(build(session.tree));
  if (!tree) return null;

  const leaves = [];
  const collect = (node) => (node.type === 'leaf' ? leaves.push(node) : node.children.forEach(collect));
  collect(tree);
  const activeTab = tabIdOf(session.activeFile);
  const pane =
    (leaves.includes(marked) && marked) ||
    leaves.find((leaf) => leaf.tabIds.includes(activeTab)) ||
    leaves[0];
  return {
    tree,
    activePaneId: pane.id,
    activeTabId: pane.tabIds.includes(activeTab) ? activeTab : pane.activeTabId,
  };
}
