import { create } from 'zustand';
import { invoke, listen, revealInFileManager } from '../lib/ipc.js';
import { getLanguageFromPath } from '../lib/utils.js';
import {
  basename,
  collapseDots,
  dirname,
  isInside,
  join,
  reparent,
  samePath,
  stripTrailingSep,
  withSepOf,
} from '../lib/paths.js';
import { findNode, frontierOf, placeUnder, setChildrenAt } from '../components/explorer/treeRows.js';
import { loadState, saveState } from '../lib/persistence.js';
import {
  normalizeSessions,
  restoredLayout,
  serializeSession,
  sessionFiles,
  sessionFor,
  sessionsPayload,
  withSession,
} from '../lib/editorSession.js';
import { useGitStore } from './gitStore.js';
import { useSettingsStore } from './settingsStore.js';
import { useSystemStore } from './systemStore.js';

/** Folders whose read is in flight, so an impatient double-click reads once. */
const loadingDirs = new Set();

/**
 * How many levels `refreshExplorer` reads below the open folder, and how
 * many `readDir` reads below a folder being opened. A folder on the last
 * level of either comes back with no children, read or not (`frontierOf`).
 */
const TREE_LEVELS = 5;
const FOLDER_LEVELS = 2;

/**
 * Counts `refreshExplorer` calls. Each reads more than once now, and two can
 * overlap — the 300 ms one after a change and a direct one after a create —
 * so one that finishes after a newer one has started leaves its tree alone.
 */
let treeGeneration = 0;

let unlisteners = [];
let listening = false;
let refreshTimer = null;
// The init() still running, shared by every caller until it settles — see init.
let initInFlight = null;

// --- Editor split tree ------------------------------------------------------
// The same leaf/split tree each terminal group holds (src/stores/terminalStore.js),
// so the editor can be arranged the way a terminal group is:
//   { type: 'leaf', id, tabIds: [], activeTabId } |
//   { type: 'split', id, direction: 'horizontal'|'vertical', children: [...] }
// Each leaf is an editor group holding its own file tabs, so a tab can be
// dragged into another group or dropped on a group's edge to split it.

let editorPaneCounter = 1;
const makeEditorPaneId = () => `editor-pane-${editorPaneCounter++}`;

/**
 * Split ids for a restored layout. Splitting by hand names a split after the
 * millisecond it happened, and a restore builds every split of a saved
 * layout within one: siblings would share an id, which React keys them by.
 */
let restoredSplitCounter = 1;
const makeRestoredSplitId = () => `editor-split-restored-${restoredSplitCounter++}`;

/**
 * A tab's id. The counter is there because a restore opens up to fifty tabs
 * within one millisecond, and with four random characters alone two of fifty
 * would share an id about once in fourteen hundred such restores.
 */
let editorTabCounter = 1;
const makeEditorTabId = () =>
  `tab-edit-${Date.now()}-${editorTabCounter++}-${Math.random().toString(36).slice(2, 6)}`;

/** Walks a split-tree node and returns the id of its first leaf (DOM order). */
function firstLeafId(node) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id;
  return firstLeafId(node.children[0]);
}

/** Collects every leaf node of a split-tree, in DOM order. */
function collectLeaves(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') {
    acc.push(node);
    return acc;
  }
  for (const child of node.children) collectLeaves(child, acc);
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

/** The leaf that currently hosts `tabId`, or null. */
function leafHoldingTab(node, tabId) {
  return collectLeaves(node).find((leaf) => leaf.tabIds.includes(tabId)) || null;
}

/** Remove a tab from whichever leaf holds it, keeping that leaf's active tab valid. */
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
 * Drop leaves that hold no tabs and collapse splits left with a single child.
 * Returns null when the whole tree is empty.
 */
function pruneTree(node) {
  if (!node) return null;
  if (node.type === 'leaf') return node.tabIds.length > 0 ? node : null;
  const children = node.children.map(pruneTree).filter(Boolean);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/**
 * `pruneTree` for one leaf only: drop `leafId` if it holds no tabs, and
 * collapse the split that leaves with a single child.
 *
 * A tab moved out of a group can leave that group empty, and it goes the way
 * an emptied group always goes. But a group the user has just split off and
 * not filled yet is empty too, and moving a tab between two OTHER groups is
 * not the user asking for that one to disappear.
 */
function pruneLeafIfEmpty(node, leafId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === leafId && node.tabIds.length === 0 ? null : node;
  const children = node.children.map((child) => pruneLeafIfEmpty(child, leafId)).filter(Boolean);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** Append a tab to a pane (falling back to the first leaf) and make it active there. */
function addTabToPane(node, paneId, tabId) {
  let placed = false;
  const next = mapTree(node, (n) => {
    if (n.type !== 'leaf' || n.id !== paneId) return n;
    placed = true;
    return { ...n, tabIds: [...n.tabIds, tabId], activeTabId: tabId };
  });
  if (placed) return next;
  const first = collectLeaves(node)[0];
  if (!first) return { type: 'leaf', id: paneId || makeEditorPaneId(), tabIds: [tabId], activeTabId: tabId };
  return mapTree(node, (n) =>
    n.type === 'leaf' && n.id === first.id
      ? { ...n, tabIds: [...n.tabIds, tabId], activeTabId: tabId }
      : n
  );
}

/** How many folders "Open Recent" remembers. */
const RECENT_ROOT_LIMIT = 12;
const RECENT_ROOTS_KEY = 'nexterm.recentRoots';

/** An empty root, used when the last editor tab goes away. */
const emptyEditorTree = () => ({ type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null });

// --- Path helpers shared by the move/rename/duplicate flows below ---------

const parentDirOf = dirname;
const remapPathPrefix = reparent;

// After a move/rename from `fromPath` to `toPath`, re-point tabs, expanded
// folders and the current selection instead of silently orphaning them.
function remapAfterMove(state, fromPath, toPath) {
  const nextExpanded = new Set(
    Array.from(state.expandedFolders).map((p) => remapPathPrefix(p, fromPath, toPath))
  );
  const nextTabs = state.tabs.map((t) => {
    const newPath = remapPathPrefix(t.filePath, fromPath, toPath);
    if (newPath === t.filePath) return t;
    return { ...t, filePath: newPath, fileName: basename(newPath) };
  });
  const nextSelected = state.selectedPath
    ? remapPathPrefix(state.selectedPath, fromPath, toPath)
    : state.selectedPath;
  return { expandedFolders: nextExpanded, tabs: nextTabs, selectedPath: nextSelected };
}

function splitBaseExt(name, isDir) {
  const dotIndex = name.lastIndexOf('.');
  if (isDir || dotIndex <= 0) return [name, ''];
  return [name.slice(0, dotIndex), name.slice(dotIndex)];
}

/**
 * The name a paste of `name` into `dirPath` should take: `name` itself when
 * nothing there has it (and `mustDiffer` is false), else "<base> copy<ext>",
 * then "<base> copy 2<ext>" and so on, as VS Code does.
 *
 * The folder is listed afresh. The tree in memory is only a few levels deep
 * and as old as its last refresh, and a name missing from it is not a free
 * name: a paste into a folder the tree had not read kept the name and wrote
 * straight over the file of that name.
 *
 * Names are compared without case, because NTFS and APFS treat `Note.txt` and
 * `note.txt` as one file. The listing leaves out the folders the Explorer
 * hides (.git, node_modules, dist…), so a pasted folder of one of those names
 * can still meet one; `fs_copy_path` and `fs_rename_path` both refuse an
 * existing destination, so that ends in an error, never in a merge.
 */
async function freeNameIn(dirPath, name, isDir, mustDiffer) {
  const listing = (await invoke('fs_read_dir', { path: dirPath, max_depth: 1 })) || [];
  const taken = new Set(listing.map((node) => node.name.toLowerCase()));
  if (!mustDiffer && !taken.has(name.toLowerCase())) return name;

  const [base, ext] = splitBaseExt(name, isDir);
  let candidate = `${base} copy${ext}`;
  for (let attempt = 2; taken.has(candidate.toLowerCase()); attempt += 1) {
    candidate = `${base} copy ${attempt}${ext}`;
  }
  return candidate;
}

// --- The Explorer's tree ----------------------------------------------------

/**
 * `nodes`, a read `levels` deep, with every folder the user has open below
 * that read in as well — and the open folders below those, and so on.
 *
 * Everything is read before anything is shown, so a refresh puts the tree
 * on screen once, with every open folder full. `refreshExplorer` used to put
 * up its five-level read alone, and a folder the user had opened further
 * down — `src/main/java/com/acme` — stayed open and showed nothing until it
 * was closed and opened again; a refresh comes 300 ms after any change on
 * disk, saving the file being edited included. Folders open inside a closed
 * one are read too: opening the parent only shows what is already in the
 * tree, so it would show them empty.
 *
 * The folders at one level are read together; each level waits for the one
 * above it, as it must. Which folders are open is asked again after every
 * level, so one opened while the reads were out is read too, and once
 * nothing is left the caller has the tree before anything else can run.
 */
async function readOpenFolders(get, nodes, levels) {
  let tree = nodes;
  let unread = frontierOf(nodes, levels);
  for (;;) {
    const open = get().expandedFolders;
    const due = unread.filter((path) => open.has(path));
    if (due.length === 0) return tree;
    const listings = await Promise.all(due.map((path) => get().readDir(path)));
    const read = new Set(due);
    due.forEach((path, i) => {
      tree = setChildrenAt(tree, path, listings[i]);
    });
    unread = [
      ...unread.filter((path) => !read.has(path)),
      ...listings.flatMap((listing) => frontierOf(listing, FOLDER_LEVELS)),
    ];
  }
}

// --- Files the backend will not read ---------------------------------------

/** A failure's words: Tauri rejects with the command's own string, the browser mock with an Error. */
function errorText(err) {
  return typeof err === 'string' ? err : String(err?.message ?? err ?? '');
}

/**
 * Whether `fs_read_file` failed because nothing is at the path: the one
 * failure that the backend and the browser mock both word "File not found:
 * <path>".
 */
export function isFileNotFound(err) {
  return errorText(err).startsWith('File not found: ');
}

/**
 * The fixed words `read_file` refuses a file with (src-tauri/src/fs/mod.rs),
 * each followed by ": <path>" — the path as it resolved it, links followed
 * and in the disk's own case, which need not be how it was asked for.
 */
const READ_REFUSAL = /^(File not found|File is not UTF-8 text|File is too large to open \([^)]*\)): /;

/** The most `read_file` opens (`MAX_OPEN_BYTES` in src-tauri/src/fs/mod.rs). */
const MAX_OPEN_BYTES = 50 * 1024 * 1024;

/**
 * Whether the file of `tab` holds exactly the bytes the tab last saved, as
 * far as its size says — asked only of a file too large to read back, which
 * only the tab's own save can have made one (nothing past the limit opens).
 */
async function isOwnLastSave(tab) {
  const saved = utf8Length(tab.savedContent ?? '');
  if (saved <= MAX_OPEN_BYTES) return false;
  try {
    return (await invoke('fs_file_size', { path: tab.filePath })) === saved;
  } catch {
    return false;
  }
}

/** How many bytes `text` takes as UTF-8, counted without encoding it. */
function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Why `fs_read_file` would not read `path`, for the user to read: the
 * backend's own words — "File is too large to open (60.1 MB; the limit is
 * 50 MB)" — without the path they end with, which whatever shows them names
 * already.
 */
export function readFailureReason(err, path) {
  const text = errorText(err).trim();
  if (path && text.endsWith(`: ${path}`) && text.length > path.length + 2) {
    return text.slice(0, -(path.length + 2));
  }
  const refusal = READ_REFUSAL.exec(text);
  if (refusal) return refusal[1];
  const failed = /^Failed to read file '.*': (.+)$/s.exec(text);
  if (failed) return `Failed to read file: ${failed[1]}`;
  return text || 'Unknown error';
}

// --- Unsaved edits ---------------------------------------------------------

/**
 * Each tab's latest save, so that the next one waits for it.
 *
 * A save reads the file back first to see whether something else changed it,
 * and compares what it reads with what the tab last saved. A second Ctrl+S
 * that started while the first was still on its way compared against the
 * text from BEFORE the first, found the first save's own bytes on disk, and
 * called them an external change.
 */
const savesInFlight = new Map(); // tabId -> promise of its last save

/** The prompt whose Save is writing files right now — see `savePendingClose`. */
let savingClose = null;

/** What a prompt holds that ends the window, the app or the open folder. */
const LEAVING = new Set(['window', 'quit', 'root']);

/** How long leaving waits for saves still writing (`savesSettled`). */
const SAVE_SETTLE_MS = 5000;

/**
 * Every save still writing, settled: each tab's latest, which itself waits
 * for the ones before it. Leaving waits for them — an earlier prompt's Save
 * that a newer prompt replaced, a Ctrl+S — because a process that ends while
 * a write is under way can leave the file cut short, the old text and the new
 * both lost. Bounded, so that a write that never returns (a stalled network
 * drive) cannot keep the window open for good.
 */
function savesSettled() {
  const writing = [...savesInFlight.values()];
  if (writing.length === 0) return Promise.resolve();
  let timer = null;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, SAVE_SETTLE_MS);
  });
  return Promise.race([Promise.allSettled(writing), bound]).finally(() => clearTimeout(timer));
}

/**
 * Hold `proceed` behind the Save / Don't Save / Cancel prompt for `dirty`.
 *
 * Returns a promise of how it ended: what `proceed` resolved to once the user
 * saved the edits or gave them up, or null when they cancelled. It never
 * rejects: a failure belongs to whoever answered (`savePendingClose`,
 * `discardPendingClose`), and the code that asked has nothing to do with it.
 */
function holdForAnswer(set, get, { kind, id = null, dirty, proceed }) {
  // A newer question replaces an older one: the window closing covers the
  // tab that was closing.
  get().pendingClose?.abandon?.();
  return new Promise((resolve) => {
    set({
      pendingClose: {
        kind,
        id,
        tabIds: dirty.map((t) => t.id),
        names: dirty.map((t) => t.fileName),
        proceed: async () => {
          try {
            const result = await proceed();
            resolve(result ?? null);
            return result;
          } catch (err) {
            resolve(null);
            throw err;
          }
        },
        abandon: () => resolve(null),
      },
    });
  });
}

/**
 * Write one tab to disk. The body of `saveFile`, which queues it.
 *
 * What reaches the disk is the text as it stands when this starts, and that
 * is what counts as saved afterwards. Monaco reports every keystroke, and
 * typing goes on during the two round trips below: marking the text as it
 * stood at the END as saved hid whatever was typed in between, so the tab
 * closed without asking and the next save saw its own last write as an
 * external change.
 */
async function writeTab(set, get, targetId, { force = false } = {}) {
  const tab = get().tabs.find((t) => t.id === targetId);
  if (!tab) return;
  const written = tab.content;

  // The bytes on disk may not be the ones this tab read. git, a formatter,
  // or a command in the app's own terminal can all move them, and writing
  // `tab.content` over that silently destroys the newer version.
  if (!force) {
    let onDisk = null;
    let unreadable = null;
    try {
      onDisk = await invoke('fs_read_file', { path: tab.filePath });
    } catch (err) {
      // Only a file that is not there is saved without asking: writing
      // makes it again, which is what saving a deleted file should do. Any
      // other failure leaves what is on disk unknown. Every failure used to
      // count as gone: a log opened under the 50 MB the backend reads, and
      // appended to past it since, was refused here as too large and then
      // overwritten with the tab's older, shorter text, unasked.
      //
      // Except a file too large that this tab made so, and nobody has
      // touched since: what it last saved is itself past the limit, and the
      // file holds exactly as many bytes as that. Asked as if someone else
      // had grown it, a file the user's own edits took past 50 MB asked on
      // every save after; grown by anyone else, even by a line, it asks.
      const ownTooLarge =
        errorText(err).startsWith('File is too large to open ') && (await isOwnLastSave(tab));
      if (!isFileNotFound(err) && !ownTooLarge) unreadable = readFailureReason(err, tab.filePath);
    }
    if (unreadable !== null || (onDisk !== null && onDisk !== tab.savedContent)) {
      set({ pendingOverwrite: { tabId: tab.id, fileName: tab.fileName, diskContent: onDisk, unreadable } });
      const err = new Error(
        unreadable === null
          ? `${tab.fileName} has changed on disk since it was opened.`
          : `${tab.fileName} could not be read back to see whether it changed on disk: ${unreadable}`
      );
      err.code = 'EXTERNAL_CHANGE';
      throw err;
    }
  }

  try {
    await invoke('fs_write_file', {
      path: tab.filePath,
      content: written,
    });

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === targetId
          ? { ...t, savedContent: written, isDirty: t.content !== written }
          : t
      ),
    }));
  } catch (err) {
    console.error(`[EditorStore] Failed to save file ${tab.filePath}:`, err);
    throw err;
  }
}

/** A tab on `filePath`, whose text on disk is `content`. */
function newEditorTab(filePath, content) {
  return {
    id: makeEditorTabId(),
    filePath,
    fileName: basename(filePath),
    content: content || '',
    savedContent: content || '',
    isDirty: false,
    language: getLanguageFromPath(filePath),
  };
}

// --- The tabs each folder had open ------------------------------------------
//
// Per folder, the editor's groups and the file each tab shows, written behind
// every change and read back when that folder opens again — at launch, or by
// Open Folder / Open Recent. The shape, and why everything read back is
// treated as untrusted, is in src/lib/editorSession.js.

/** Where the sessions are kept. */
export const EDITOR_SESSIONS_KEY = 'nexterm.editor.sessions';

const SESSION_DEBOUNCE_MS = 300;
/** However busy the editor is, the saved tabs are never more than this stale. */
const SESSION_MAX_WAIT_MS = 2000;
/** How many files a restore reads at once: enough not to crawl, few enough not to crowd the backend. */
const RESTORE_READS_AT_ONCE = 4;

/**
 * How long a restore waits for one file. A read that has not answered by then
 * — a network drive gone away, a file another program holds — is left out for
 * now, and the restore goes on without it: one read that never answered used
 * to hold every other tab back for good.
 */
export const RESTORE_READ_TIMEOUT_MS = 5000;

/**
 * How long a restore waits for all of its files together. Reads go four at a
 * time, so on a drive that answers nothing fifty files took over a minute of
 * timeouts; past this, what has not been read is left for next time.
 */
export const RESTORE_DEADLINE_MS = 15000;

/**
 * How many launches in a row a saved file may fail to read — locked, not
 * allowed, a link to nothing, no answer — before it is forgotten. Kept for
 * good, such a file came back at every launch as a tab nobody could see or
 * close.
 */
const RESTORE_TRIES = 3;

/**
 * The saved files already counted as a failed launch in this run of the app
 * — from one init() to its dispose(). Opening another folder and coming back
 * reads them again, and counted each time, a locked file was forgotten after
 * three folder changes in as many seconds.
 */
const missedThisRun = new Set();

/**
 * Whether paths name the same file whatever their case, as the disks of
 * Windows and macOS compare names by default — by the backend's own account
 * of the machine (`systemStore`), the user agent's until it has given one.
 */
const caselessPaths = () => ['windows', 'macos'].includes(useSystemStore.getState().os);

/**
 * Whether two paths name one file: separator-blind as `samePath` is, and
 * case-blind where the disk is (`caselessPaths`). A saved tab comes back
 * spelled with the folder's own case, and compared by spelling alone it was
 * a second tab beside one the user had opened — two buffers of one file.
 * Nothing is respelled.
 */
function sameFile(a, b) {
  if (!caselessPaths()) return samePath(a, b);
  const fold = (path) => (typeof path === 'string' ? path.toLowerCase() : path);
  return samePath(fold(a), fold(b));
}

/**
 * The folder whose tabs are being saved: the open folder, from the moment it
 * opens. Null while none is, and from a dispose() to the next init().
 */
let sessionRoot = null;

/** Counts folder changes, so that a restore still reading for a folder the user has left is dropped. */
let restoreGeneration = 0;

/**
 * The open folder's saved tabs that are not open.
 *
 * While the restore reads them, that is every one. Once it has put in what it
 * could, it is the files it could not read for a reason that may pass — no
 * answer in time, a lock, a file too large for now (`readFailureIsFinal` says
 * which reasons do not).
 *
 * Saving starts the moment a folder opens, and every save carries these
 * along, where the restore puts them (`sessionToSave`). Saving used to wait
 * for the restore to land instead, and a restore that never landed — one read
 * that never answered — left the folder unsaved for the rest of the run: a
 * file opened and edited meanwhile was gone after a restart.
 *
 * `events` are the Explorer's moves and deletes since the folder opened, for
 * the saved files to follow (`followMoves`); `suspects`, the paths the watcher
 * saw deleted while the restore was reading; `misses`, how many launches in a
 * row have failed to read each file (RESTORE_TRIES).
 *
 *   { root, generation, session, waiting: Set of saved paths, applied,
 *     reading, events: [{ from, to } | { gone }], suspects: Set,
 *     misses: Map of saved path -> count }
 */
let carry = null;

/** The restore running, for `whenTabsRestored`. */
let restoreRun = Promise.resolve();

/**
 * When each tab was last the active one, for keeping the most recently used
 * past SESSION_TAB_LIMIT. Kept beside the store rather than in it: a tab
 * that carried it would be a new object at every switch, and every editor
 * group redraws when `tabs` changes.
 *
 * A restored tab gets a rank below zero, in the order it was last used in —
 * below every tab the user has touched since, which all count from one up:
 * restored as if just used, the tabs of the last session pushed out what the
 * user had opened while they were read.
 */
const tabRecency = new Map(); // tab id -> tick
let recencyTick = 0;
const touchTab = (tabId) => {
  if (tabId) tabRecency.set(tabId, ++recencyTick);
};

let sessionTimer = null;
let sessionDeadline = null;
let pendingSession = null; // { root, session } not written yet
let lastSessionKey = null;

/** Settings ▸ Text Editor ▸ Restore Open Editors. */
const restoreEnabled = () => useSettingsStore.getState().editorRestoreTabs !== false;

/** Every saved session, as safe to restore as `normalizeSessions` makes it. */
function loadSessions() {
  return normalizeSessions(loadState(EDITOR_SESSIONS_KEY, null), { caseless: caselessPaths() });
}

/** Write `root`'s session (null: none open), keeping the other folders'. */
function writeSession(root, session) {
  saveState(EDITOR_SESSIONS_KEY, sessionsPayload(withSession(loadSessions(), root, session)));
}

/** Write whatever is pending right now. Safe to call when nothing is. */
function flushSessionWrite() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  sessionDeadline = null;
  const pending = pendingSession;
  pendingSession = null;
  if (pending && restoreEnabled()) writeSession(pending.root, pending.session);
}

/**
 * Debounced write-behind with a ceiling, as the terminals' layout has (see
 * `schedulePersist` in terminalStore.js): typing changes `tabs` with every
 * key, but only a change to what is open reaches here.
 *
 * Another folder's session still waiting is written first rather than
 * replaced — one pending write per folder would otherwise lose the last
 * change made before the folder changed.
 */
function scheduleSessionWrite(root, session) {
  if (pendingSession && !samePath(pendingSession.root, root)) flushSessionWrite();
  pendingSession = { root, session };
  clearTimeout(sessionTimer);
  if (sessionDeadline === null) sessionDeadline = Date.now() + SESSION_MAX_WAIT_MS;
  const wait = Math.max(0, Math.min(SESSION_DEBOUNCE_MS, sessionDeadline - Date.now()));
  sessionTimer = setTimeout(flushSessionWrite, wait);
}

/** The files of a saved session in the order its groups show them. */
function filesShown(session) {
  const files = [];
  const walk = (node) => (node.type === 'leaf' ? files.push(...node.files) : node.children.forEach(walk));
  walk(session.tree);
  return files;
}

/**
 * Where a saved file of `carrying` is now, after the Explorer's moves and
 * deletes since its folder opened — null when one of them deleted it.
 */
function followMoves(carrying, path) {
  let current = path;
  for (const event of carrying.events) {
    if ('gone' in event) {
      if (sameFile(current, event.gone) || isInside(event.gone, current)) return null;
    } else {
      current = reparent(current, event.from, event.to);
    }
  }
  return current;
}

/**
 * What the Explorer moved (a rename, a cut and paste) or deleted, kept for
 * the saved files not open yet. The restore read them as they were, and put
 * a file deleted meanwhile back as a clean tab with its old text — which a
 * save then wrote back to disk, unasked, since saving a file that is not
 * there makes it again.
 */
function noteExplorerMove(from, to) {
  carry?.events.push({ from, to });
}

function noteExplorerDelete(path) {
  carry?.events.push({ gone: path });
}

/**
 * A deletion the watcher reported while the restore is reading. Not taken at
 * its word: a program saving a file can delete it and write it anew, and git
 * does so to every file it checks out. The file is looked at again before
 * it is put in (`readSession`).
 */
function noteDeletedOnDisk(path) {
  if (carry && !carry.applied && typeof path === 'string') carry.suspects.add(path);
}

/**
 * Whether a failed read is the file's own answer, which waiting will not
 * change: it is not there (or is a folder now), it is past what the editor
 * opens, it is not text — what opening it by hand would say too — or the
 * backend refuses the path itself: outside the folder, on another machine, a
 * name Windows reads as another (src-tauri/src/fs/mod.rs). A restore drops
 * such a file from the folder's saved tabs. Any other failure — no answer in
 * time, a lock, a permission, a link to nothing — may pass: the file is left
 * out of the editor but stays saved, for RESTORE_TRIES launches at most.
 */
const FINAL_READ_FAILURE =
  /^(File not found: |File is not UTF-8 text: |File is too large to open \(|Failed to read file '.*': it is not a file$|Path is outside the workspace root |Path is on another machine or a device: |Path is not one Windows reads as it is written: |Path has a name that ends in a dot or a space)/s;

export function readFailureIsFinal(err) {
  return FINAL_READ_FAILURE.test(errorText(err));
}

/** Whether `fs_file_size` failed because nothing is at the path, in the words of each OS. */
function sizeSaysGone(err) {
  return /No such file or directory|cannot find the (?:file|path) specified|\(os error 2\)/i.test(errorText(err));
}

/** `promise`, or a rejection once `ms` have passed without an answer. */
function withinTime(promise, ms) {
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Start the session of `root`, the folder that has just become the open one:
 * saved from now on, with what it had open last time carried along until the
 * restore has read it (`carry`). The reading is `readSession`'s, started once
 * the Explorer is up.
 */
function beginSession(root) {
  restoreGeneration += 1;
  sessionRoot = root || null;
  lastSessionKey = null;
  carry = null;
  if (!root || !restoreEnabled()) return;
  const session = sessionFor(loadSessions(), root);
  if (!session) return;
  carry = {
    root,
    generation: restoreGeneration,
    session,
    waiting: new Set(sessionFiles(session)),
    applied: false,
    reading: false,
    events: [],
    suspects: new Set(),
    misses: new Map(Object.entries(session.misses ?? {})),
  };
}

/** Read the open folder's saved tabs, if there are any and nothing reads them yet. */
function startReading(set, get) {
  if (!carry || carry.reading) return;
  carry.reading = true;
  restoreRun = readSession(set, get, carry);
}

/**
 * Whether the user has done anything in the editor since the folder opened —
 * opened a tab, split it, asked whether to close a group — so that a restore
 * landing now puts its tabs into the editor as it is, rather than in place of
 * it.
 *
 * Opening a tab counts. It used to take a split: a file the user had opened
 * and was typing in was moved into the saved layout's own group when the
 * restore landed, its editor drawn afresh, and the keyboard dropped to the
 * page — the next keys went nowhere.
 */
function userTouchedEditor(state) {
  const tree = state.editorSplitTree;
  return tree?.type !== 'leaf' || tree.tabIds.length > 0 || state.pendingClose?.kind === 'pane';
}

/** Whether the keyboard is in an editor group — its text, or its row of tabs. */
function editorHasKeyboard() {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  return Boolean(active?.closest?.('[data-editor-pane-body], [data-editor-tab-strip]'));
}

/**
 * The editor's groups with a saved session's files in them — `tabIdOf(path)`
 * names each one's tab, or none to leave it out — and the active group and
 * tab. Null when no file is left. Two ways:
 *
 *  - The saved layout. What a launch or a folder change gets when the user
 *    has not touched the editor yet: one empty group, replaced.
 *  - `intoLive`: the editor as it is, with the session's files added to its
 *    active group, and nothing already there moved — no group replaced, no
 *    tab taken out of its group, the active group and tab what they were.
 *    When the user has done anything in the editor (`userTouchedEditor`).
 *    The tabs never go into a group a "close this group?" question is about.
 */
function planLayout(state, session, tabIdOf, newId, intoLive) {
  const layout = restoredLayout(session, tabIdOf, newId);
  if (!layout) return null;
  const leaves = collectLeaves(state.editorSplitTree);

  if (intoLive) {
    const shownNow = new Set(leaves.flatMap((leaf) => leaf.tabIds));
    const incoming = collectLeaves(layout.tree)
      .flatMap((leaf) => leaf.tabIds)
      .filter((id) => !shownNow.has(id));
    const asked = state.pendingClose?.kind === 'pane' ? state.pendingClose.id : null;
    const target =
      leaves.find((leaf) => leaf.id === state.activeEditorPaneId && leaf.id !== asked) ??
      leaves.find((leaf) => leaf.id !== asked) ??
      leaves[0];
    const shown = target.tabIds.includes(target.activeTabId)
      ? target.activeTabId
      : (incoming.includes(layout.activeTabId) ? layout.activeTabId : incoming[0]) ?? null;
    const tree = mapTree(state.editorSplitTree, (n) =>
      n.type === 'leaf' && n.id === target.id ? { ...n, tabIds: [...n.tabIds, ...incoming], activeTabId: shown } : n
    );
    // The group the user was in stays the active one, and the active tab is
    // the one it shows, as a click in it makes it (`setActiveEditorPane`).
    const after = collectLeaves(tree);
    const pane =
      after.find((leaf) => leaf.id === state.activeEditorPaneId) ?? after.find((leaf) => leaf.id === target.id);
    const activeTabId =
      pane.activeTabId ?? (state.activeTabId && leafHoldingTab(tree, state.activeTabId) ? state.activeTabId : null);
    return { tree, activeEditorPaneId: pane.id, activeTabId };
  }

  return { tree: layout.tree, activeEditorPaneId: layout.activePaneId, activeTabId: layout.activeTabId };
}

/**
 * Once the restore has landed: the editor as it is, with each carried file
 * (`carriedIds`) put back into the group it was saved in — beside the tab of
 * that group it was saved next to, wherever that tab is now. A saved group
 * none of whose files is open comes back as a group of its own, beside the
 * rest; and when nothing at all is open, the saved layout is the answer.
 * Only what is saved: nothing on screen moves.
 *
 * Into the active group, as they went, the files that could not be read
 * this time came back next time in a group that was not theirs.
 */
function placeCarried(state, session, tabIdOf, carriedIds) {
  const rows = new Map(collectLeaves(state.editorSplitTree).map((leaf) => [leaf.id, [...leaf.tabIds]]));
  if ([...rows.values()].every((ids) => ids.length === 0)) {
    let minted = 0;
    return planLayout(state, session, (path) => tabIdOf.get(path) ?? null, (kind) => `kept-${kind}-${(minted += 1)}`, false);
  }
  const holderOf = (id) => [...rows].find(([, ids]) => ids.includes(id))?.[0] ?? null;
  const groups = []; // { tabIds, activeTabId }: saved groups with nothing open

  const walk = (node) => {
    if (node.type !== 'leaf') {
      node.children.forEach(walk);
      return;
    }
    let anchor = null; // { leafId, id }: where this group's last file went
    let before = []; // carried files waiting for an open one to go before
    for (const saved of node.files) {
      const id = tabIdOf.get(saved);
      if (!id) continue;
      if (carriedIds.has(id)) {
        if (anchor) {
          const row = rows.get(anchor.leafId);
          row.splice(row.indexOf(anchor.id) + 1, 0, id);
          anchor = { leafId: anchor.leafId, id };
        } else {
          before.push(id);
        }
        continue;
      }
      const leafId = holderOf(id);
      if (!leafId) continue;
      if (before.length > 0) {
        const row = rows.get(leafId);
        row.splice(row.indexOf(id), 0, ...before);
        before = [];
      }
      anchor = { leafId, id };
    }
    if (before.length > 0) {
      const active = tabIdOf.get(node.active);
      groups.push({ tabIds: before, activeTabId: before.includes(active) ? active : before[0] });
    }
  };
  walk(session.tree);

  let tree = mapTree(state.editorSplitTree, (n) => (n.type === 'leaf' ? { ...n, tabIds: rows.get(n.id) } : n));
  if (groups.length > 0) {
    const extra = groups.map((group, i) => ({ type: 'leaf', id: `kept-group-${i + 1}`, ...group }));
    tree =
      tree.type === 'split' && tree.direction === 'horizontal'
        ? { ...tree, children: [...tree.children, ...extra] }
        : { type: 'split', id: 'kept-split', direction: 'horizontal', children: [tree, ...extra] };
  }
  return { tree, activeEditorPaneId: state.activeEditorPaneId, activeTabId: state.activeTabId };
}

/**
 * What is saved for the editor's state: what is open, and the saved files
 * still to come (`carry`) — where the restore will put them while it reads,
 * in their own groups once it has landed (`placeCarried`) — ranked below
 * every tab of this run, each with its count of failed launches.
 */
function sessionToSave(state) {
  const recencyOf = (id) => tabRecency.get(id) ?? 0;
  const caseless = caselessPaths();
  if (!carry || carry.waiting.size === 0 || !samePath(carry.root, state.rootPath)) {
    return serializeSession(state, recencyOf, { caseless });
  }
  const { session } = carry;
  const rankOf = new Map(session.recent.map((saved, i) => [saved, -(i + 1)]));
  const placeholders = [];
  const ranks = new Map();
  const misses = new Map();
  const tabIdOf = new Map(); // saved path -> tab id, or a placeholder's
  for (const saved of filesShown(session)) {
    const path = followMoves(carry, saved);
    if (path === null) continue;
    const open = state.tabs.find((t) => sameFile(t.filePath, path));
    if (open) {
      tabIdOf.set(saved, open.id);
    } else if (carry.waiting.has(saved)) {
      const id = `carried-${placeholders.length}`;
      placeholders.push({ id, filePath: path });
      ranks.set(id, rankOf.get(saved) ?? 0);
      misses.set(id, carry.misses.get(saved) ?? 0);
      tabIdOf.set(saved, id);
    }
  }
  if (placeholders.length === 0) return serializeSession(state, recencyOf, { caseless });
  let minted = 0;
  const plan = carry.applied
    ? placeCarried(state, session, tabIdOf, new Set(placeholders.map((p) => p.id)))
    : planLayout(
        state,
        session,
        (path) => tabIdOf.get(path) ?? null,
        (kind) => `planned-${kind}-${(minted += 1)}`,
        userTouchedEditor(state)
      );
  if (!plan) return serializeSession(state, recencyOf, { caseless });
  return serializeSession(
    {
      rootPath: state.rootPath,
      tabs: [...state.tabs, ...placeholders],
      editorSplitTree: plan.tree,
      activeEditorPaneId: plan.activeEditorPaneId,
      activeTabId: plan.activeTabId,
    },
    (id) => (ranks.has(id) ? ranks.get(id) : recencyOf(id)),
    { missesOf: (id) => misses.get(id) ?? 0, caseless }
  );
}

/**
 * Save the open tabs if they differ from what was last saved — once the
 * store holds a folder (`sessionRoot`) and the setting asks for it.
 */
function noteSessionChange(state) {
  if (!restoreEnabled() || !sessionRoot || !samePath(sessionRoot, state.rootPath)) return;
  const session = sessionToSave(state);
  const key = JSON.stringify([sessionRoot, session]);
  if (key === lastSessionKey) return;
  lastSessionKey = key;
  scheduleSessionWrite(sessionRoot, session);
}

/**
 * Tabs closed in the folder that is open. A saved file the user closes while
 * the restore is reading it stays closed, rather than coming back when the
 * restore lands. And once it has landed, an editor the user empties is
 * nothing open: the files it could not read go from the saved tabs as well.
 */
function noteClosedTabs(state, prev) {
  if (!carry || state.rootPath !== prev.rootPath) return;
  if (carry.applied && state.tabs.length === 0 && prev.tabs.length > 0) {
    carry = null;
    return;
  }
  const open = new Set(state.tabs.map((t) => t.id));
  for (const tab of prev.tabs) {
    if (open.has(tab.id)) continue;
    for (const saved of carry.waiting) {
      if (sameFile(followMoves(carry, saved), tab.filePath)) carry.waiting.delete(saved);
    }
  }
}

/**
 * The setting turned off: nothing more is saved, and what was saved goes
 * too. Kept, it would come back the day the setting is turned on again —
 * files from a session long over — and until then it is a list of the files
 * someone worked on, in storage, for nothing.
 */
function forgetSessions() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  sessionDeadline = null;
  pendingSession = null;
  lastSessionKey = null;
  carry = null;
  saveState(EDITOR_SESSIONS_KEY, sessionsPayload([]));
}

/**
 * The editor's state with what a restore read put in — `contents` holding the
 * text of each saved file read, by saved path — or null when nothing can go
 * in. A file already open keeps its tab, buffer and all, so nothing is open
 * twice; a file the user closed, or the Explorer deleted, while it was read
 * stays out; one the Explorer moved opens where it is now.
 */
function mergeRestored(state, carrying, contents) {
  const { root, session } = carrying;
  const tabIdOf = new Map(); // saved path -> tab id
  const added = [];
  for (const saved of filesShown(session)) {
    const path = followMoves(carrying, saved);
    if (path === null) continue;
    const open = state.tabs.find((t) => sameFile(t.filePath, path));
    if (open) {
      tabIdOf.set(saved, open.id);
      continue;
    }
    if (!contents.has(saved) || !carrying.waiting.has(saved)) continue;
    const tab = newEditorTab(withSepOf(path, root), contents.get(saved));
    added.push(tab);
    tabIdOf.set(saved, tab.id);
  }
  const plan = planLayout(
    state,
    session,
    (path) => tabIdOf.get(path) ?? null,
    (kind) => (kind === 'pane' ? makeEditorPaneId() : makeRestoredSplitId()),
    userTouchedEditor(state)
  );
  if (!plan) return null;

  const fresh = new Set(added.map((tab) => tab.id));
  session.recent.forEach((saved, i) => {
    const id = tabIdOf.get(saved);
    if (fresh.has(id)) tabRecency.set(id, -(i + 1));
  });
  return {
    tabs: [...state.tabs, ...added],
    editorSplitTree: plan.tree,
    activeEditorPaneId: plan.activeEditorPaneId,
    activeTabId: plan.activeTabId,
  };
}

/**
 * Read one saved file where it is now (`followMoves`). A file the Explorer
 * moves while it is being read is read again where it went: the read asked
 * for the old name, found nothing there, and the tab was dropped for good.
 * Resolves to `{ text }`, or `{ deleted: true }` for a file the Explorer
 * deleted; rejects with why it would not read.
 */
async function readSaved(carrying, saved) {
  for (let attempt = 1; ; attempt += 1) {
    const path = followMoves(carrying, saved);
    if (path === null) return { deleted: true };
    try {
      const read = invoke('fs_read_file', { path: withSepOf(path, carrying.root) });
      return { text: await withinTime(read, RESTORE_READ_TIMEOUT_MS) };
    } catch (err) {
      const moved = followMoves(carrying, saved) !== path;
      if (moved && attempt < 3 && readFailureIsFinal(err)) continue;
      throw err;
    }
  }
}

/**
 * Read the saved tabs of `carrying.root`, the open folder, and put in what
 * could be read.
 *
 * Every file is read again through `fs_read_file`, which the backend confines
 * to the open folder: what is open is what is on disk now. Nothing waits on
 * this — `init` and `enterRoot` settle once the Explorer is up — and the
 * folder is saved meanwhile with these files carried along (`carry`).
 *
 * The tabs go in at once, when every read has answered or run out of time —
 * RESTORE_READ_TIMEOUT_MS each, RESTORE_DEADLINE_MS for them all — so the
 * layout never shows half built. A file not read is left out quietly — no
 * `openFailure`: nobody asked for it just now, and a notice per file would
 * greet a launch with a stack of them — and one line in the console names
 * each, and why. Its group keeps the rest; a group left with nothing goes.
 * One that may read next time is tried at most RESTORE_TRIES launches in a
 * row.
 */
async function readSession(set, get, carrying) {
  const { root, generation } = carrying;
  const current = () => carry === carrying && generation === restoreGeneration && samePath(get().rootPath, root);
  try {
    const files = [...carrying.waiting];
    const contents = new Map(); // saved path -> text
    const settled = new Set(); // saved paths read, failed, or deleted
    const gone = []; // { path, reason }: dropped from the saved tabs
    const notNow = []; // { path, reason, asked }: kept, to be tried again
    const asked = new Set(); // saved paths whose read was started
    let next = 0;
    let closed = false;
    const reader = async () => {
      while (!closed && next < files.length) {
        const saved = files[next];
        next += 1;
        asked.add(saved);
        try {
          const result = await readSaved(carrying, saved);
          if (closed) return;
          if ('text' in result) contents.set(saved, result.text);
        } catch (err) {
          if (closed) return;
          const failure = { path: saved, reason: readFailureReason(err, saved), asked: true };
          (readFailureIsFinal(err) ? gone : notNow).push(failure);
        }
        settled.add(saved);
      }
    };
    let deadline = null;
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(RESTORE_READS_AT_ONCE, files.length) }, reader)),
      new Promise((resolve) => {
        deadline = setTimeout(resolve, RESTORE_DEADLINE_MS);
      }),
    ]);
    clearTimeout(deadline);
    closed = true;
    // Past the deadline: a read under way had its chance; one never started
    // did not, and is not held against its file (below).
    const seconds = RESTORE_DEADLINE_MS / 1000;
    for (const saved of files) {
      if (settled.has(saved)) continue;
      const started = asked.has(saved);
      notNow.push({ path: saved, reason: started ? `no answer within ${seconds} s` : `not reached within ${seconds} s`, asked: started });
    }
    if (!current()) return;

    // What the watcher saw deleted while the files were read, looked at again.
    const suspected = [...contents.keys()].filter((saved) => {
      const path = followMoves(carrying, saved);
      return path !== null && [...carrying.suspects].some((s) => sameFile(s, path) || isInside(s, path));
    });
    await Promise.all(
      suspected.map(async (saved) => {
        try {
          const path = withSepOf(followMoves(carrying, saved), root);
          await withinTime(invoke('fs_file_size', { path }), RESTORE_READ_TIMEOUT_MS);
        } catch (err) {
          if (!sizeSaysGone(err)) return;
          contents.delete(saved);
          gone.push({ path: saved, reason: 'deleted while it was read' });
        }
      })
    );
    // Another folder opened, or the setting went off, while the files were read.
    if (!current() || !restoreEnabled()) return;

    // Tried once too often: forgotten like a file that is gone. A miss is
    // counted only for a read that was asked for, and once a run at most:
    // on a slow drive, files the deadline never reached were forgotten
    // without ever being read.
    const kept = [];
    for (const miss of notNow) {
      const counts = miss.asked && !missedThisRun.has(miss.path);
      const tries = (carrying.misses.get(miss.path) ?? 0) + (counts ? 1 : 0);
      if (tries >= RESTORE_TRIES) {
        gone.push({ path: miss.path, reason: `${miss.reason}; not read in ${tries} launches, forgotten` });
        continue;
      }
      if (counts) missedThisRun.add(miss.path);
      if (tries > 0) carrying.misses.set(miss.path, tries);
      kept.push(miss);
    }
    const missed = [...gone, ...kept];
    if (missed.length > 0) {
      const named = missed.map(({ path, reason }) => `${basename(path)} (${reason})`).join(', ');
      console.warn(`[EditorStore] Not reopened from the last session: ${named}`);
    }
    // Read and written with nothing awaited between: a file the user opens
    // now lands before or after this, never in the middle.
    const hadKeyboard = editorHasKeyboard();
    const merged = mergeRestored(get(), carrying, contents);
    for (const saved of settled) if (!kept.some((miss) => miss.path === saved)) carrying.waiting.delete(saved);
    for (const { path } of gone) carrying.waiting.delete(path);
    carrying.applied = true;
    if (carrying.waiting.size === 0) carry = null;
    if (merged) set(merged);
    // The keyboard stays in the editor if that is where it was: whatever the
    // tabs coming in redrew, the active one is handed it back.
    if (merged && hadKeyboard) get().focusEditor();
    // Saved even when nothing went in: the files that are gone leave.
    noteSessionChange(get());
  } catch (err) {
    console.error(`[EditorStore] Could not restore the editor tabs of ${root}:`, err);
  }
}

/**
 * The restore of the open folder's tabs: a promise that settles once it has
 * put them in or given up — at once when none is running. Nothing in the app
 * waits for it; the suites do.
 */
export function whenTabsRestored() {
  return restoreRun;
}

/**
 * Point the workspace at `root`, which the backend has already opened.
 *
 * Another folder closes every editor tab — they belong to the folder being
 * left, and the callers have asked about unsaved ones first — and then opens
 * the tabs that folder had last time (`readSession`), without waiting for
 * them: Open Recent hands the keyboard back when this settles, and a read
 * that never answered kept it for good. The folder that is already open
 * keeps its tabs: it is the first entry in Open Recent, and choosing it
 * again used to throw every tab away.
 */
async function enterRoot(set, get, root) {
  const another = !samePath(root, get().rootPath);
  if (!another) {
    set({ rootPath: root });
  } else {
    // The folder being left: its last change is written now, while it is
    // still the one pending. The new one is saved from here on.
    flushSessionWrite();
    beginSession(root);
    set({
      rootPath: root,
      expandedFolders: new Set([root]),
      tabs: [],
      activeTabId: null,
      editorSplitTree: emptyEditorTree(),
      activeEditorPaneId: 'editor-pane-root',
    });
  }
  get().rememberRoot(root);
  await get().refreshExplorer();
  useGitStore.getState().refreshNow();
  if (another) startReading(set, get);
  return root;
}

export const useEditorStore = create((set, get) => ({
  tabs: [],
  activeTabId: null,
  fileTree: [],
  rootPath: '/workspace',
  expandedFolders: new Set(['/workspace', '/workspace/src', '/workspace/tests']),
  isLoadingTree: false,
  // False until init() has asked the backend for the real root; until then
  // `rootPath` is only the browser mock's placeholder. See FileExplorer.
  rootResolved: false,

  // Split tree: { type: 'leaf', id, tabIds: [], activeTabId } | { type: 'split', id, direction, children }
  // See the "Editor split tree" comment near the top of this file.
  editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },

  // The pane currently focused for "open file lands here" / split-origin.
  activeEditorPaneId: 'editor-pane-root',

  // --- Context-menu-driven UI state ---------------------------------------
  selectedPath: null,   // row highlighted by click or right-click
  clipboard: null,      // { mode: 'copy' | 'cut', path, isDir } | null
  creatingEntry: null,  // { parentPath, type: 'file' | 'folder' } | null
  // A close the user asked for that would throw away unsaved edits, held
  // until they answer. `closeTab`/`closeEditorPane` stay unconditional; the
  // UI goes through `requestClose*`, and opening another folder, closing the
  // window and quitting go through `askBeforeLeaving`, so nothing is dropped
  // silently. `proceed` does what was asked once the edits are saved or
  // given up; `abandon` settles the asker's promise when nothing will be.
  pendingClose: null,   // { kind: 'tab' | 'pane' | 'root' | 'window' | 'quit', id, tabIds: [], names: [], proceed, abandon } | null
  // A save refused because the file changed on disk after this tab read it,
  // or could not be read back to tell (`unreadable`: why, else null — and
  // then there is no `diskContent` to take instead).
  pendingOverwrite: null, // { tabId, fileName, diskContent, unreadable } | null
  // The last file that would not open, and why — on screen until dismissed
  // or a file opens (OpenFailureNotice).
  openFailure: null, // { path, fileName, reason } | null
  renamingPath: null,   // path currently rendered as an inline rename input

  // Event listeners are attached once and can be torn down (HMR, unmount)
  // without losing the bootstrap state.
  attachListeners: async () => {
    if (listening) return;
    listening = true;
    unlisteners.push(await listen('fs-change', (payload) => {
      // Something deleted while the tabs of last time are being read.
      if (payload?.kind === 'delete') noteDeletedOnDisk(payload.path);
      // A build or install fires hundreds of events; refresh once they settle.
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => get().refreshExplorer(), 300);
      // Git's answer changes with the files. Its own debounce coalesces a
      // checkout's thousands of events into one `git status`.
      useGitStore.getState().refresh();
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
    // The tabs' last change is written out rather than dropped, as the
    // terminals' layout is. And the next init() — a remount, a reload —
    // reads the saved tabs again instead of taking this run's word that the
    // store holds them; a restore still reading puts nothing in.
    flushSessionWrite();
    sessionRoot = null;
    carry = null;
    // And the run is over: the next counts its own failed reads.
    missedThisRun.clear();
  },
  init: () => {
    // App's effect runs twice under React StrictMode in development, and the
    // second run arrives while the first is still waiting on the backend.
    // Share the run in flight rather than resolving the root and reading the
    // tree twice. Cleared once it settles, so a later init() runs afresh.
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      // The backend owns the workspace root and starts with none, as VS Code
      // does (the browser mock reports '/workspace').
      try {
        const rootPath = await invoke('fs_get_root');
        set(
          rootPath
            ? { rootPath, expandedFolders: new Set([rootPath]) }
            : { rootPath: null, expandedFolders: new Set(), fileTree: [] }
        );
      } catch (err) {
        console.error('[EditorStore] Failed to resolve workspace root:', err);
      }
      // As known as it will get: the placeholder stays if the backend could not say.
      set({ rootResolved: true, recentRoots: loadState(RECENT_ROOTS_KEY, []) || [] });
      useGitStore.getState().refreshNow();
      const opened = get().rootPath;
      if (opened) get().rememberRoot(opened);
      // This folder's tabs are saved from here on, with those it had open
      // last time carried along until they are read. Not when the store
      // already holds them: an init() after one that finished, with nothing
      // disposed between, would lay them out again.
      const fresh = !sessionRoot || !samePath(sessionRoot, opened);
      if (fresh) beginSession(opened);
      await get().refreshExplorer();

      // Listen to filesystem changes
      await get().attachListeners();

      // The tabs it had open last time, once the Explorer is up — and not
      // waited for: a read that never answered held this, and every init()
      // after it, for good (`readSession`).
      if (fresh) startReading(set, get);
    })().finally(() => {
      initInFlight = null;
    });
    return initInFlight;
  },

  /**
   * Read one directory's entries.
   *
   * `refreshExplorer` only walks a few levels deep, and a directory at that
   * limit comes back with an empty `children` that is indistinguishable from a
   * genuinely empty one. The tree calls this when such a folder is opened
   * instead of claiming it is empty, and a refresh for each one still open
   * (`readOpenFolders`).
   *
   * Named under `path`, the way the tree reached the folder, rather than
   * where the backend found it (see `placeUnder`): through a link, those
   * differ.
   */
  readDir: async (path) => {
    try {
      return placeUnder((await invoke('fs_read_dir', { path, max_depth: FOLDER_LEVELS })) || [], path);
    } catch (err) {
      console.error(`[EditorStore] Failed to read ${path}:`, err);
      return [];
    }
  },

  refreshExplorer: async () => {
    const generation = ++treeGeneration;
    // No folder open: there is no tree to read, and the backend would refuse.
    if (!get().rootPath) {
      set({ fileTree: [], isLoadingTree: false });
      return;
    }
    set({ isLoadingTree: true });
    try {
      const nodes = await invoke('fs_read_dir', {
        path: get().rootPath,
        max_depth: TREE_LEVELS,
      });
      const tree = await readOpenFolders(get, nodes || [], TREE_LEVELS);
      if (generation !== treeGeneration) return;
      set({ fileTree: tree, isLoadingTree: false });
    } catch (err) {
      console.error('[EditorStore] Failed to read directory:', err);
      if (generation === treeGeneration) set({ isLoadingTree: false });
    }
  },

  /**
   * Folders opened before, newest first.
   *
   * VS Code's "Open Recent". The app opens with no folder and the only way
   * back to one was the native dialog — which on Windows means clicking
   * through a tree to a path you have typed a hundred times in the terminal
   * below. Capped and persisted like everything else the user would be
   * annoyed to lose.
   */
  recentRoots: [],

  /** Remember a root, newest first, without duplicates. */
  rememberRoot: (rootPath) => {
    if (typeof rootPath !== 'string' || !rootPath) return;
    set((state) => {
      const next = [rootPath, ...state.recentRoots.filter((p) => !samePath(p, rootPath))]
        .slice(0, RECENT_ROOT_LIMIT);
      saveState(RECENT_ROOTS_KEY, next);
      return { recentRoots: next };
    });
  },

  /** Drop one — the folder is gone, or the user does not want it listed. */
  forgetRoot: (rootPath) => {
    set((state) => {
      const next = state.recentRoots.filter((p) => !samePath(p, rootPath));
      saveState(RECENT_ROOTS_KEY, next);
      return { recentRoots: next };
    });
  },

  /**
   * Open a folder from the recent list.
   *
   * A recent folder may have been moved, renamed or deleted since. The
   * backend refuses it (`set_root` canonicalises and checks it is a
   * directory), and rather than leaving a row that fails every time it is
   * clicked, the entry comes out of the list.
   *
   * Another folder closes every editor tab, so unsaved ones are asked about
   * first — before `fs_set_root`, which moves the backend's root for good.
   * Resolves to the folder opened, or null when none was (refused, or the
   * user cancelled).
   */
  openRoot: async (rootPath) => {
    const open = async () => {
      try {
        const resolved = await invoke('fs_set_root', { path: rootPath });
        return await enterRoot(set, get, resolved);
      } catch (err) {
        console.error(`[EditorStore] Could not open ${rootPath}:`, err);
        get().forgetRoot(rootPath);
        return null;
      }
    };
    // The folder already open keeps its tabs (see `enterRoot`): nothing to ask.
    if (samePath(rootPath, get().rootPath)) return open();
    return get().askBeforeLeaving('root', open) ?? open();
  },

  /**
   * Open a folder through the native picker.
   *
   * Unsaved tabs are asked about BEFORE the picker opens, not once a folder
   * has been chosen: `fs_pick_root` moves the backend's root as it returns,
   * and the tabs would by then belong to a folder that is no longer open.
   * Cancelling the picker after "Don't Save" gives nothing up — the tabs are
   * only closed when another folder actually opens.
   */
  pickRoot: async () => {
    const pick = async () => {
      try {
        const rootPath = await invoke('fs_pick_root');
        return rootPath ? await enterRoot(set, get, rootPath) : null;
      } catch (err) {
        console.error('[EditorStore] Failed to change workspace root:', err);
        return null;
      }
    };
    return get().askBeforeLeaving('root', pick) ?? pick();
  },

  /**
   * Open or close a folder.
   *
   * `refreshExplorer` only walks a few levels, so a directory at that limit
   * comes back with `children: []` — indistinguishable from a genuinely empty
   * one. Opening such a folder reads it and writes the result into `fileTree`,
   * so the tree stays the single source of truth. It used to be cached in the
   * row component instead, where a refresh could not reach it: a file created
   * inside a deep folder never appeared until the app restarted.
   */
  toggleFolder: (folderPath) => {
    const wasExpanded = get().expandedFolders.has(folderPath);
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (wasExpanded) next.delete(folderPath);
      else next.add(folderPath);
      return { expandedFolders: next };
    });
    if (!wasExpanded) get().ensureChildrenLoaded(folderPath);
  },

  setFolderExpanded: (folderPath, expanded) => {
    if (get().expandedFolders.has(folderPath) === expanded) return;
    get().toggleFolder(folderPath);
  },

  /**
   * Read a folder's entries into the tree if they are not there yet, with
   * whatever below it was left open when it was closed (`readOpenFolders`).
   */
  ensureChildrenLoaded: async (folderPath) => {
    const node = findNode(get().fileTree, folderPath);
    if (!node || !node.is_dir) return;
    if (Array.isArray(node.children) && node.children.length > 0) return;
    if (loadingDirs.has(folderPath)) return;
    loadingDirs.add(folderPath);
    try {
      const children = await readOpenFolders(get, await get().readDir(folderPath), FOLDER_LEVELS);
      set((state) => ({ fileTree: setChildrenAt(state.fileTree, folderPath, children) }));
    } finally {
      loadingDirs.delete(folderPath);
    }
  },

  /**
   * Where the editor should jump once the file is on screen.
   *
   * A click on `src/main.rs:10:5` in the terminal has to do two things that
   * cannot happen in one step: open the file (async, may fail) and move the
   * caret (only possible once Monaco has mounted that model). So the position
   * is parked here and `EditorPanel` applies it when its editor is ready,
   * which also means a file already open is handled by the same path.
   */
  pendingReveal: null,

  /** Open `filePath` and put the caret on that line. */
  openFileAt: async (filePath, line, column = null) => {
    const tab = await get().openFile(filePath);
    if (Number.isFinite(line) && line > 0) {
      // The tab's own spelling, which is what the editor compares against:
      // a link's `C:\proj\src/App.jsx` lands on the tab of `C:\proj\src\App.jsx`.
      set({ pendingReveal: { filePath: tab.filePath, line, column: Number.isFinite(column) ? column : 1 } });
    }
    return tab;
  },

  /** Applied — or abandoned, if nothing could show it. */
  clearReveal: () => set({ pendingReveal: null }),

  /**
   * Give the active tab's editor the keyboard, leaving its caret where it
   * is: a file picked in Go to File, or the keyboard handed back as a prompt
   * closes (src/lib/workspaceFocus.js). A file just opened has no editor
   * yet, so this too is parked in `pendingReveal` — with no line — for
   * EditorPanel to apply once it has one.
   */
  focusEditor: () => {
    const tab = get().getActiveTab();
    if (tab) set({ pendingReveal: { filePath: tab.filePath, line: null, column: null } });
  },

  openFile: async (requestedPath) => {
    // Written the way the backend writes the open folder, so that a link
    // printed in a terminal and a click in the Explorer name the same file
    // the same way (see `withSepOf`) — and with any `.` or `..` worked out,
    // as the backend works them out (`collapseDots`): `src/../README.md`
    // from a link was the Explorer's `README.md` in a second tab, and a
    // saved tab spelled that way was never reopened.
    const filePath = collapseDots(withSepOf(requestedPath, get().rootPath));
    // Check if already open — reveal it in whichever group already shows it
    // (VS Code's "revealIfOpen") rather than yanking it into the active
    // group, which would be surprising if the user deliberately split panes.
    // Compared separator-blind: on Windows `C:\p\a.js` and `C:\p/a.js` are
    // one file, and two tabs on it were two buffers of it, each taking the
    // other's saves for changes made on disk. And case-blind where the disk
    // is (`sameFile`): a link printed as `C:\PROJ\a.js` opened a second tab
    // on the Explorer's `C:\proj\a.js`.
    const openTab = () => get().tabs.find((t) => sameFile(t.filePath, filePath));
    const reveal = (existing) => {
      set((state) => {
        const holder = leafHoldingTab(state.editorSplitTree, existing.id);
        const paneId = holder ? holder.id : state.activeEditorPaneId;
        const tree = holder
          ? mapTree(state.editorSplitTree, (n) =>
              n.type === 'leaf' && n.id === holder.id ? { ...n, activeTabId: existing.id } : n
            )
          : addTabToPane(state.editorSplitTree, paneId, existing.id);
        return { activeTabId: existing.id, activeEditorPaneId: paneId, editorSplitTree: tree, openFailure: null };
      });
      return existing;
    };
    const existing = openTab();
    if (existing) return reveal(existing);

    try {
      const content = await invoke('fs_read_file', { path: filePath });
      // Opened by something else while this was reading — the restore of
      // the folder's last session bringing the same file back, or a second
      // click — and a second tab on one file is two buffers of it.
      const raced = openTab();
      if (raced) return reveal(raced);

      const newTab = newEditorTab(filePath, content);
      const tabId = newTab.id;

      set((state) => ({
        tabs: [...state.tabs, newTab],
        activeTabId: tabId,
        // A newly opened file joins the active group so it is visible immediately.
        editorSplitTree: addTabToPane(state.editorSplitTree, state.activeEditorPaneId, tabId),
        openFailure: null,
      }));

      return newTab;
    } catch (err) {
      console.error(`[EditorStore] Failed to open file ${filePath}:`, err);
      // Said on screen as well. Every way of opening a file comes through
      // here — the Explorer, Go to File, a link in a terminal, a search
      // result — and a file the backend would not read, a 60 MB log or a
      // binary, opened nothing and said nothing anywhere but the console.
      set({ openFailure: { path: filePath, fileName: basename(filePath), reason: readFailureReason(err, filePath) } });
      throw err;
    }
  },

  /** The notice of a file that would not open, closed. */
  dismissOpenFailure: () => set({ openFailure: null }),

  editBuffer: (tabId, newContent) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          content: newContent,
          isDirty: newContent !== tab.savedContent,
        };
      }),
    }));
  },

  /** Save a tab (the active one by default), after any save of it still under way. */
  saveFile: (tabId = null, options = {}) => {
    const targetId = tabId || get().activeTabId;
    const previous = savesInFlight.get(targetId);
    // The previous save's failure is its own caller's to report.
    const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() =>
      writeTab(set, get, targetId, options)
    );
    savesInFlight.set(targetId, run);
    const forget = () => {
      if (savesInFlight.get(targetId) === run) savesInFlight.delete(targetId);
    };
    run.then(forget, forget);
    return run;
  },

  saveAll: async () => {
    const dirtyTabs = get().tabs.filter((t) => t.isDirty);
    for (const tab of dirtyTabs) {
      await get().saveFile(tab.id);
    }
  },

  /** Close a tab, asking first if it has unsaved edits. */
  requestCloseTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !tab.isDirty) {
      get().closeTab(tabId);
      return;
    }
    holdForAnswer(set, get, {
      kind: 'tab',
      id: tabId,
      dirty: [tab],
      proceed: () => get().closeTab(tabId),
    });
  },

  /** Close a whole editor group, asking first about any unsaved tab in it. */
  requestCloseEditorPane: (paneId) => {
    const leaf = collectLeaves(get().editorSplitTree).find((l) => l.id === paneId);
    const dirty = (leaf?.tabIds || [])
      .map((id) => get().tabs.find((t) => t.id === id))
      .filter((t) => t && t.isDirty);
    if (dirty.length === 0) {
      get().closeEditorPane(paneId);
      return;
    }
    holdForAnswer(set, get, {
      kind: 'pane',
      id: paneId,
      dirty,
      proceed: () => get().closeEditorPane(paneId),
    });
  },

  /**
   * Ask about every unsaved tab before something that closes them all:
   * opening another folder (`kind` 'root'), closing the window ('window'),
   * quitting ('quit').
   *
   * Returns null when nothing is unsaved, and the caller goes ahead itself.
   * Otherwise `proceed` waits for the answer, and what is returned is the
   * promise of how it ended — `proceed`'s result, or null when cancelled.
   */
  askBeforeLeaving: (kind, proceed) => {
    const dirty = get().tabs.filter((t) => t.isDirty);
    if (dirty.length === 0) return null;
    return holdForAnswer(set, get, { kind, dirty, proceed });
  },

  cancelPendingClose: () => {
    const pending = get().pendingClose;
    set({ pendingClose: null });
    pending?.abandon?.();
  },

  cancelPendingOverwrite: () => set({ pendingOverwrite: null }),

  /** Write this tab over the newer bytes on disk, because the user said so. */
  confirmPendingOverwrite: async () => {
    const pending = get().pendingOverwrite;
    if (!pending) return;
    set({ pendingOverwrite: null });
    await get().saveFile(pending.tabId, { force: true });
  },

  /** Throw away the buffer and take what is on disk instead. */
  reloadFromDisk: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const content = await invoke('fs_read_file', { path: tab.filePath });
    set((state) => ({
      pendingOverwrite: null,
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, content, savedContent: content, isDirty: false } : t
      ),
    }));
  },

  /** Go ahead without saving. */
  discardPendingClose: async () => {
    const pending = get().pendingClose;
    // Not while Save is still writing: closing the window over a write that
    // has not finished can leave the file cut short.
    if (!pending || savingClose === pending) return;
    set({ pendingClose: null });
    if (LEAVING.has(pending.kind)) await savesSettled();
    await pending.proceed();
  },

  /**
   * Save every unsaved tab involved, then go ahead. A failed save keeps the
   * prompt open rather than closing over an edit that never reached disk.
   *
   * Except when the file changed on disk: `saveFile` has then asked its own
   * question (`pendingOverwrite`), and that one takes this one's place. Left
   * open together, one Enter answered both — a plain save and a forced
   * overwrite of the same file, racing.
   */
  savePendingClose: async () => {
    const pending = get().pendingClose;
    // A second click on Save while the first is still writing.
    if (!pending || savingClose === pending) return;
    savingClose = pending;
    try {
      for (const id of pending.tabIds) {
        // A tab closed some other way meanwhile has nothing left to save.
        if (!get().tabs.some((t) => t.id === id)) continue;
        await get().saveFile(id);
      }
    } catch (err) {
      if (err?.code === 'EXTERNAL_CHANGE' && get().pendingClose === pending) {
        set({ pendingClose: null });
        pending.abandon();
      }
      throw err;
    } finally {
      if (savingClose === pending) savingClose = null;
    }
    // Cancelled, or replaced by a newer question, while the files were being
    // written: the saves stand, and nothing else happens.
    if (get().pendingClose !== pending) return;
    set({ pendingClose: null });
    if (LEAVING.has(pending.kind)) await savesSettled();
    await pending.proceed();
  },

  closeTab: (tabId) => {
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.id !== tabId);
      // Drop it from its group too, collapsing the group if it was the last tab.
      const editorSplitTree = pruneTree(removeTabFromTree(state.editorSplitTree, tabId)) || emptyEditorTree();
      const paneStillThere = collectLeaves(editorSplitTree).some((l) => l.id === state.activeEditorPaneId);
      const activeEditorPaneId = paneStillThere
        ? state.activeEditorPaneId
        : firstLeafId(editorSplitTree) || 'editor-pane-root';
      // The tab the active group now shows, as `setActiveEditorPane` picks it.
      // The first tab of the whole list was another group's file as often as
      // not, or one no group shows: Save then wrote that one, and the
      // keyboard, given back after "Save X?", went to the other group.
      let nextActive = state.activeTabId;
      if (state.activeTabId === tabId) {
        const leaf = collectLeaves(editorSplitTree).find((l) => l.id === activeEditorPaneId);
        const open = (leaf?.tabIds ?? []).filter((id) => nextTabs.some((t) => t.id === id));
        nextActive = open.includes(leaf?.activeTabId) ? leaf.activeTabId : open[0] ?? null;
      }
      return {
        tabs: nextTabs,
        activeTabId: nextActive,
        editorSplitTree,
        activeEditorPaneId,
      };
    });
  },

  switchTab: (tabId) => {
    set({ activeTabId: tabId });
  },

  // --- Editor split tree: panes, drag-and-drop placement ------------------

  /**
   * Make a pane the active one — a click or focus anywhere in it — and the
   * tab it shows the active tab.
   *
   * Save (the keys and the menu) and the Explorer's highlight go by
   * `activeTabId`. This used to move only `activeEditorPaneId`, so after a
   * file was opened in a second group, typing in the first and pressing
   * Ctrl+S saved the file in the second, untouched, and left the edited one
   * unsaved. A group with no file leaves no tab active: there is nothing in
   * it to save. The tab is the one the group draws, its first when the one it
   * remembers is gone (see EditorPane).
   *
   * Runs on every mousedown in the editor, so a click that changes nothing
   * leaves the state alone rather than waking every subscriber.
   */
  setActiveEditorPane: (paneId) =>
    set((state) => {
      const leaf = collectLeaves(state.editorSplitTree).find((l) => l.id === paneId);
      if (!leaf) return state;
      const tabId = leaf.tabIds.includes(leaf.activeTabId) ? leaf.activeTabId : leaf.tabIds[0] ?? null;
      if (state.activeEditorPaneId === paneId && state.activeTabId === tabId) return state;
      return { activeEditorPaneId: paneId, activeTabId: tabId };
    }),

  /**
   * Split a leaf pane into two children (horizontal or vertical). The new
   * pane starts empty — unlike a terminal, a file tab can't be conjured up
   * out of thin air — and becomes active, so the next file opened (or tab
   * dragged in) lands there. Returns the new pane's id.
   */
  splitEditorPane: (paneId, direction = 'horizontal') => {
    const newPaneId = makeEditorPaneId();

    const splitNode = (node) => {
      if (node.type === 'leaf' && node.id === paneId) {
        return {
          type: 'split',
          id: `editor-split-${Date.now()}`,
          direction,
          children: [
            { ...node },
            { type: 'leaf', id: newPaneId, tabIds: [], activeTabId: null },
          ],
        };
      }
      if (node.type === 'split') {
        return { ...node, children: node.children.map(splitNode) };
      }
      return node;
    };

    set((state) => ({ editorSplitTree: splitNode(state.editorSplitTree), activeEditorPaneId: newPaneId }));
    return newPaneId;
  },

  /**
   * Close a pane (an editor group). The sibling takes over the parent split.
   * Every tab that pane held is closed too, UNLESS another remaining leaf
   * still shows that same tabId.
   */
  closeEditorPane: (paneId) => {
    const { editorSplitTree } = get();

    const closingLeaf = collectLeaves(editorSplitTree).find((leaf) => leaf.id === paneId);
    const closingTabIds = closingLeaf ? [...closingLeaf.tabIds] : [];

    let replacementLeafId = null;

    const removeNode = (node) => {
      if (node.type !== 'split') return node;

      const idx = node.children.findIndex(
        (child) => child.type === 'leaf' && child.id === paneId
      );

      if (idx !== -1) {
        const remaining = node.children.filter((_, i) => i !== idx);
        if (remaining.length === 1) {
          replacementLeafId = firstLeafId(remaining[0]);
          return remaining[0];
        }
        const neighbourIdx = Math.min(idx, remaining.length - 1);
        replacementLeafId = firstLeafId(remaining[neighbourIdx]);
        return { ...node, children: remaining };
      }

      return { ...node, children: node.children.map(removeNode) };
    };

    // Closing the only pane empties it rather than removing the root.
    const nextTree =
      editorSplitTree.type === 'leaf' && editorSplitTree.id === paneId
        ? emptyEditorTree()
        : removeNode(editorSplitTree);
    set({ editorSplitTree: nextTree });

    if (get().activeEditorPaneId === paneId && replacementLeafId) {
      set({ activeEditorPaneId: replacementLeafId });
    }

    for (const tabId of closingTabIds) {
      if (leafHoldingTab(get().editorSplitTree, tabId)) continue;
      get().closeTab(tabId);
    }
  },

  /**
   * Make `tabId` the visible tab of `paneId`. If the tab lives in another
   * group, move it here first (clicking a tab chip never splits).
   */
  bindEditorPaneToTab: (paneId, tabId) => {
    set((state) => {
      const holder = leafHoldingTab(state.editorSplitTree, tabId);
      let tree = state.editorSplitTree;
      if (!holder || holder.id !== paneId) {
        tree =
          pruneTree(addTabToPane(removeTabFromTree(tree, tabId), paneId, tabId)) || emptyEditorTree();
      } else {
        tree = mapTree(tree, (n) =>
          n.type === 'leaf' && n.id === paneId ? { ...n, activeTabId: tabId } : n
        );
      }
      return { editorSplitTree: tree, activeEditorPaneId: paneId, activeTabId: tabId };
    });
  },

  /**
   * Drag & drop a file tab onto a pane.
   *
   * `zone` is where inside the target pane it was dropped:
   *   'center'                  → move the tab into that group
   *   'left' | 'right'          → split the group horizontally, tab on that side
   *   'top'  | 'bottom'         → split the group vertically, tab on that side
   */
  dropEditorTabOnPane: (tabId, targetPaneId, zone = 'center') => {
    const state = get();
    const target = collectLeaves(state.editorSplitTree).find((l) => l.id === targetPaneId);
    if (!target || !state.tabs.some((t) => t.id === tabId)) return;

    const source = leafHoldingTab(state.editorSplitTree, tabId);

    // Dropping a tab back on its own group: just focus it. Splitting a group
    // off its only tab would leave the source empty and is a no-op too.
    if (source && source.id === targetPaneId) {
      if (zone === 'center' || source.tabIds.length === 1) {
        get().bindEditorPaneToTab(targetPaneId, tabId);
        return;
      }
    }

    const withoutTab = removeTabFromTree(state.editorSplitTree, tabId);

    if (zone === 'center') {
      const tree = pruneTree(addTabToPane(withoutTab, targetPaneId, tabId)) || emptyEditorTree();
      set({ editorSplitTree: tree, activeEditorPaneId: targetPaneId, activeTabId: tabId });
      return;
    }

    const newPaneId = makeEditorPaneId();
    const newLeaf = { type: 'leaf', id: newPaneId, tabIds: [tabId], activeTabId: tabId };
    const direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
    const insertFirst = zone === 'left' || zone === 'top';

    const split = mapTree(withoutTab, (n) =>
      n.type === 'leaf' && n.id === targetPaneId
        ? {
            type: 'split',
            id: `editor-split-${Date.now()}`,
            direction,
            children: insertFirst ? [newLeaf, n] : [n, newLeaf],
          }
        : n
    );

    set({
      editorSplitTree: pruneTree(split) || emptyEditorTree(),
      activeEditorPaneId: newPaneId,
      activeTabId: tabId,
    });
  },

  /**
   * Drag & drop a file tab onto a tab strip: reorder it within its own group,
   * or insert it into another group where it was dropped — not at the end, as
   * a drop on the group's body does.
   *
   * `index` is a GAP in the target strip as drawn when the drop happens, with
   * the dragged tab still in it if it lives there: 0 is before the first chip,
   * `tabIds.length` is after the last, and `i` is between chips `i - 1` and
   * `i`. That is what the pointer is measured against — the dragged chip stays
   * on screen, dimmed, for the whole gesture — so the caller passes it
   * straight through and the translation happens here, where it is tested.
   * Both gaps beside the tab's own chip leave it where it is, and every gap
   * to the right of it is one past the slot it lands in, because by then the
   * tab has left its old slot.
   *
   * A number outside the strip is clamped to the nearer end, and a fraction
   * rounds down. A gap that is not a number, an unknown tab or an unknown
   * group changes nothing.
   *
   * The tab becomes its group's visible tab and that group the active one,
   * as a click on the chip would make them. A group the tab leaves empty is
   * pruned; no other group is touched (see `pruneLeafIfEmpty`).
   *
   * A drop that asks for exactly what is already there changes no state at
   * all — not even a new state object, which every subscriber would take as
   * a change and re-render for.
   */
  moveEditorTabInStrip: (tabId, targetPaneId, index) => {
    if (typeof index !== 'number' || Number.isNaN(index)) return;
    const state = get();
    const target = collectLeaves(state.editorSplitTree).find((l) => l.id === targetPaneId);
    if (!target || !state.tabs.some((t) => t.id === tabId)) return;

    let slot = Math.min(Math.max(Math.floor(index), 0), target.tabIds.length);
    const from = target.tabIds.indexOf(tabId);
    if (from !== -1 && slot > from) slot -= 1;
    const tabIds = target.tabIds.filter((id) => id !== tabId);
    tabIds.splice(slot, 0, tabId);

    const source = leafHoldingTab(state.editorSplitTree, tabId);
    const nothingChanges =
      source?.id === targetPaneId &&
      tabIds.every((id, i) => id === target.tabIds[i]) &&
      target.activeTabId === tabId &&
      state.activeEditorPaneId === targetPaneId &&
      state.activeTabId === tabId;
    if (nothingChanges) return;

    const placed = mapTree(removeTabFromTree(state.editorSplitTree, tabId), (n) =>
      n.type === 'leaf' && n.id === targetPaneId ? { ...n, tabIds, activeTabId: tabId } : n
    );
    const vacated = source && source.id !== targetPaneId ? source.id : null;
    set({
      editorSplitTree: (vacated ? pruneLeafIfEmpty(placed, vacated) : placed) || emptyEditorTree(),
      activeEditorPaneId: targetPaneId,
      activeTabId: tabId,
    });
  },

  createFile: async (path) => {
    try {
      await invoke('fs_create_file', { path });
      await get().refreshExplorer();
      await get().openFile(path);
    } catch (err) {
      console.error(`[EditorStore] Failed to create file ${path}:`, err);
      throw err;
    }
  },

  createFolder: async (path) => {
    try {
      await invoke('fs_create_dir', { path });
      await get().refreshExplorer();
    } catch (err) {
      console.error(`[EditorStore] Failed to create dir ${path}:`, err);
      throw err;
    }
  },

  /** The open tabs at `path` or under it — what deleting `path` would close. */
  tabsUnder: (path) => get().tabs.filter((t) => samePath(t.filePath, path) || isInside(path, t.filePath)),

  /**
   * Delete `path`, and close the tabs of what went with it. `trash: true`
   * moves it to the Trash (the Recycle Bin on Windows) instead; a move that
   * cannot be made rejects with "Not moved to the …" and deletes nothing —
   * the Explorer then asks whether to delete it for good
   * (`trashFailureReason`, src/components/explorer/treeRows.js).
   */
  deletePath: async (path, recursive = false, { trash = false } = {}) => {
    try {
      await invoke('fs_delete_path', { path, recursive, trash: Boolean(trash) });
      noteExplorerDelete(path);
      await get().refreshExplorer();
      // Close every tab the delete removed. Matching only the exact path
      // left a deleted folder's files open, and saving one of those
      // recreated the directory the user had just deleted. Separator-blind:
      // a `${path}/` prefix never matched a Windows path, so on Windows,
      // where this app is mostly used, that still happened. The prompt
      // (FileExplorer, `deletePromptMessage`) has named the unsaved ones.
      get()
        .tabsUnder(path)
        .forEach((t) => get().closeTab(t.id));
    } catch (err) {
      console.error(`[EditorStore] Failed to delete ${path}:`, err);
      throw err;
    }
  },

  // --- Context menu: selection, inline create/rename, clipboard ----------

  setSelectedPath: (path) => set({ selectedPath: path }),

  setCreatingEntry: (entry) => {
    if (!entry) {
      set({ creatingEntry: null });
      return;
    }
    // The workspace root uses the always-visible pinned form instead, so it
    // never needs auto-expansion. Any other folder must be expanded for its
    // inline "new file/folder" row to actually be visible in the tree.
    if (entry.parentPath !== get().rootPath && !get().expandedFolders.has(entry.parentPath)) {
      const nextExpanded = new Set(get().expandedFolders);
      nextExpanded.add(entry.parentPath);
      set({ creatingEntry: entry, expandedFolders: nextExpanded });
      return;
    }
    set({ creatingEntry: entry });
  },

  beginRename: (path) => set({ renamingPath: path, selectedPath: path }),
  cancelRename: () => set({ renamingPath: null }),

  copyToClipboard: (path, isDir) => set({ clipboard: { mode: 'copy', path, isDir: Boolean(isDir) } }),

  /**
   * The name a paste is copying, while it copies; null otherwise. A big
   * folder takes minutes, with no sign of it, and the clipboard stays
   * armed — a second Paste started a second whole copy beside the first.
   */
  pasting: null,
  cutToClipboard: (path, isDir) => set({ clipboard: { mode: 'cut', path, isDir: Boolean(isDir) } }),
  clearClipboard: () => set({ clipboard: null }),

  // One `fs_rename_path` call, never copy-then-delete: the kernel decides
  // whether the old and new names are the same entry, which is what makes a
  // case-only or NFC/NFD change safe on a case-insensitive volume, and it
  // refuses to clobber an existing file instead of merging two into one.
  renamePath: async (oldPath, rawName) => {
    const trimmed = (rawName || '').trim();
    // A separator would make this a move into a folder, which the backend
    // creates on the way. '\' is one on Windows only, and a name that means a
    // different thing on each platform is refused on both.
    if (!trimmed || /[\\/]/.test(trimmed)) {
      throw new Error('Name cannot be empty or contain "/" or "\\"');
    }

    // In the separator the folder already uses: `${parent}/${name}` gave
    // `C:\proj\src/b.js`, which no Explorer click matched, so the file opened
    // a second time in a second tab.
    const newPath = join(parentDirOf(oldPath), trimmed);
    if (samePath(newPath, oldPath)) return;

    try {
      await invoke('fs_rename_path', { from: oldPath, to: newPath });
      noteExplorerMove(oldPath, newPath);
      set((state) => remapAfterMove(state, oldPath, newPath));
      await get().refreshExplorer();
    } catch (err) {
      console.error(`[EditorStore] Failed to rename ${oldPath} -> ${newPath}:`, err);
      throw err;
    }
  },

  // Copy+Paste duplicates a file/folder; Cut+Paste moves it. Neither ever
  // writes over something already in the destination: the name comes from a
  // fresh listing of it (see `freeNameIn`), and both backend commands refuse
  // an existing destination.
  pasteClipboard: async (targetFolderPathRaw) => {
    const clip = get().clipboard;
    if (!clip) return;
    if (get().pasting) throw new Error(`Still copying '${get().pasting}'.`);
    const { mode, path: srcPath, isDir } = clip;
    const targetBase = stripTrailingSep(targetFolderPathRaw);
    const name = basename(srcPath);
    const sameLocation = samePath(parentDirOf(srcPath), targetBase);

    if (isDir && (samePath(targetBase, srcPath) || isInside(srcPath, targetBase))) {
      throw new Error('Cannot paste a folder into itself or one of its own subfolders.');
    }

    if (mode === 'cut' && sameLocation) {
      // Moving something back into the folder it already lives in is a no-op.
      set({ clipboard: null });
      return;
    }

    // Taken before anything is awaited: finding a free name lists the
    // folder first, and a second Paste in that moment started a second copy.
    const copying = mode === 'copy';
    if (copying) set({ pasting: name });
    try {
      const destName = await freeNameIn(targetBase, name, isDir, mode === 'copy' && sameLocation);
      const destPath = join(targetBase, destName);

      if (mode === 'cut') {
        // A move is a rename: atomic, and it cannot drop part of a subtree
        // the way copy-then-delete does.
        await invoke('fs_rename_path', { from: srcPath, to: destPath });
        noteExplorerMove(srcPath, destPath);
        set((state) => remapAfterMove(state, srcPath, destPath));
        set({ clipboard: null });
      } else {
        // One backend command, for a file or a whole folder, copying bytes.
        // Copying through fs_read_dir/fs_read_file lost what the Explorer
        // hides (.git, node_modules, dist…) and stopped at the first file
        // that is not UTF-8 text, with half the folder already written.
        await invoke('fs_copy_path', { from: srcPath, to: destPath });
      }

      await get().refreshExplorer();
    } catch (err) {
      console.error(`[EditorStore] Failed to paste ${srcPath} into ${targetBase}:`, err);
      throw err;
    } finally {
      if (copying) set({ pasting: null });
    }
  },

  // Show `path` in the OS file manager — Finder, Explorer, the desktop's own:
  // a folder opened there, anything else selected in its folder and never
  // opened, which would run a program (`fs_reveal_path`,
  // src-tauri/src/fs/reveal.rs). A Cmd/Ctrl+click on a name in a terminal's
  // output comes here (src/lib/revealLinks.js). Rejects with the backend's
  // reason — gone, on another machine — for the caller to tell the user
  // where they are looking.
  revealPath: (path) => revealInFileManager(path),

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId) || null;
  },
}));

// Every change to what is open, wherever it came from — a click, a drag, a
// rename, a delete, a restore — passes here, so no action has to remember to
// save. Typing changes `tabs` too; `noteSessionChange` finds the session the
// same and writes nothing.
useEditorStore.subscribe((state, prev) => {
  if (state.activeTabId !== prev.activeTabId) touchTab(state.activeTabId);
  if (
    state.tabs === prev.tabs &&
    state.editorSplitTree === prev.editorSplitTree &&
    state.activeTabId === prev.activeTabId &&
    state.activeEditorPaneId === prev.activeEditorPaneId &&
    state.rootPath === prev.rootPath
  ) {
    return;
  }
  if (state.tabs !== prev.tabs) noteClosedTabs(state, prev);
  // Closed tabs' ticks, now and then.
  if (tabRecency.size > state.tabs.length + 100) {
    const open = new Set(state.tabs.map((t) => t.id));
    for (const id of tabRecency.keys()) if (!open.has(id)) tabRecency.delete(id);
  }
  noteSessionChange(state);
});

// Turned off: forget. Turned back on: start from what is open now, rather
// than waiting for the next change to save it.
useSettingsStore.subscribe((settings, prev) => {
  if ((settings.editorRestoreTabs !== false) === (prev.editorRestoreTabs !== false)) return;
  if (settings.editorRestoreTabs === false) {
    forgetSessions();
  } else {
    lastSessionKey = null;
    noteSessionChange(useEditorStore.getState());
  }
});

// The webview can go away without warning (quit, reload, a Windows update
// reboot). Write out whatever is pending rather than losing it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushSessionWrite);
  window.addEventListener('beforeunload', flushSessionWrite);
}

export default useEditorStore;
