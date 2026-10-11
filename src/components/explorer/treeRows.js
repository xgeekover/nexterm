/**
 * The explorer's tree, as the flat list of rows actually on screen.
 *
 * VS Code's tree is a list, not a nest of components: what you see is the
 * visible rows in order, each knowing its depth. Modelling it that way is what
 * makes arrow-key navigation, focus and (later) virtualization simple — "the
 * next row" is `rows[i + 1]`, wherever it sits in the hierarchy.
 *
 * Pure functions only: no React, no store.
 */

import { samePath, stripTrailingSep } from '../../lib/paths.js';

/**
 * The rows to render, top to bottom.
 *
 * A folder contributes its children only while it is expanded. `children` of
 * `undefined` means "not fetched yet" and `[]` means "known to be empty" —
 * the difference is what lets a folder show a twisty before its contents have
 * been read.
 */
export function flattenVisible(nodes, expanded, depth = 0, acc = []) {
  if (!Array.isArray(nodes)) return acc;
  for (const node of nodes) {
    const isFolder = Boolean(node.is_dir);
    const isExpanded = isFolder && expanded.has(node.path);
    acc.push({ node, depth, isFolder, isExpanded });
    if (isExpanded && Array.isArray(node.children)) {
      flattenVisible(node.children, expanded, depth + 1, acc);
    }
  }
  return acc;
}

/**
 * The tree narrowed to what matches `query`, with the folders that lead to it.
 *
 * A filter that only kept matching nodes would hide every match that lives in
 * a folder whose own name does not match — which is most of them. So a folder
 * is kept when it matches OR when anything beneath it does, and the result is
 * a real tree rather than a flat list of hits: where a file sits is half of
 * what identifies it in a project.
 *
 * Matching is on the entry's NAME, not its path. Filtering for `test` in a
 * project checked out under `~/tests/` would otherwise match everything, and
 * the path is already visible in the rows around it.
 *
 * Case-insensitive and plain substring, deliberately: this narrows a tree you
 * are looking at. Fuzzy matching belongs to the command palette, which is what
 * ⌘P is for.
 *
 * A folder whose children have not been fetched yet (`children: undefined`)
 * can only be judged on its own name — there is nothing else to look at, and
 * reading the disk to answer a keystroke is not this function's job.
 */
export function filterTree(nodes, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle) return { nodes, matches: 0, expand: [] };

  const expand = [];
  let matches = 0;

  const walk = (list) => {
    if (!Array.isArray(list)) return [];
    const kept = [];
    for (const node of list) {
      const self = String(node.name || '').toLowerCase().includes(needle);
      const children = node.is_dir ? walk(node.children) : [];
      const keepsChildren = children.length > 0;

      if (!self && !keepsChildren) continue;
      if (self && !node.is_dir) matches += 1;
      if (self && node.is_dir) matches += 1;

      if (node.is_dir && keepsChildren) {
        // Anything with a surviving child is opened: a filter whose results
        // are hidden behind closed twisties has not narrowed anything.
        expand.push(node.path);
        kept.push({ ...node, children });
      } else {
        kept.push(node);
      }
    }
    return kept;
  };

  return { nodes: walk(nodes), matches, expand };
}

/** Replace one directory's `children`, returning a new tree. */
export function setChildrenAt(nodes, path, children) {
  if (!Array.isArray(nodes)) return nodes;
  let changed = false;
  const next = nodes.map((node) => {
    if (samePath(node.path, path)) {
      changed = true;
      return { ...node, children };
    }
    if (node.is_dir && Array.isArray(node.children) && node.children.length > 0) {
      const sub = setChildrenAt(node.children, path, children);
      if (sub !== node.children) {
        changed = true;
        return { ...node, children: sub };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

/** Find one node anywhere in the tree. */
export function findNode(nodes, path) {
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (samePath(node.path, path)) return node;
    if (node.is_dir && Array.isArray(node.children)) {
      const hit = findNode(node.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The folders a read `levels` deep left unread: those on its last level.
 *
 * The backend stops at the depth it is asked for and hands each folder there
 * back with `children: []`, whether or not it has anything in it, so the
 * tree cannot tell them from empty folders by looking. Their paths, in tree
 * order. A folder on a shallower level was read, empty or not.
 */
export function frontierOf(nodes, levels) {
  const unread = [];
  const walk = (list, level) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node?.is_dir) continue;
      if (level >= levels) unread.push(node.path);
      else walk(node.children, level + 1);
    }
  };
  if (levels >= 1) walk(nodes, 1);
  return unread;
}

/**
 * A listing read from the folder at `folderPath`, with every entry named
 * under `folderPath`.
 *
 * The backend resolves the folder it is asked to read, links included, and
 * names what it finds by where that really is. For a folder reached through
 * a link — `packages/shared` leading to `libs/shared` — that is the link's
 * target, so `libs/shared/src` landed in the tree under `packages/shared`:
 * a path the tree had never shown, which it could not find again to open,
 * keep open or refresh. Each entry is named by the path the tree reached it
 * by instead. For any other folder that is the path the backend gave, and
 * the listing comes back as it was.
 *
 * Only the part before the folder is swapped; each name stays exactly as the
 * backend spelled it. Rebuilding the path from the name with `join` dropped a
 * leading `\` — a legal character in a name off Windows — so a folder named
 * `\..` became `<folder>/..`, and deleting it removed the folder above.
 */
export function placeUnder(nodes, folderPath) {
  if (!Array.isArray(nodes)) return nodes;
  const from = folderReadBy(nodes);
  const to = stripTrailingSep(folderPath);
  if (from === null || from === to) return nodes;
  return reroot(nodes, from, to);
}

/** The folder a listing's entries are named under: each path is it, then a name. */
function folderReadBy(nodes) {
  for (const node of nodes) {
    if (node && typeof node.path === 'string' && typeof node.name === 'string' && node.name && node.path.endsWith(node.name)) {
      return stripTrailingSep(node.path.slice(0, node.path.length - node.name.length));
    }
  }
  return null;
}

/** `nodes` with the leading `from` of every path, at any depth, made `to`. */
function reroot(nodes, from, to) {
  return nodes.map((node) => {
    if (!node || typeof node !== 'object' || typeof node.path !== 'string' || !node.path.startsWith(from)) return node;
    const path = to + node.path.slice(from.length);
    const children = Array.isArray(node.children) ? reroot(node.children, from, to) : node.children;
    return { ...node, ...(node.id === undefined ? {} : { id: path }), path, ...(children === undefined ? {} : { children }) };
  });
}

/**
 * Where the keyboard should land after `key`, given the visible rows.
 *
 * Returns `{ index }` to move focus, `{ expand }` / `{ collapse }` to open or
 * close a folder, `{ open }` to activate a row, or null when the key is not
 * ours. Mirrors VS Code: Right on a collapsed folder opens it and on an open
 * one steps into the first child; Left closes an open folder and otherwise
 * jumps to the parent.
 */
export function navigate(rows, index, key) {
  if (rows.length === 0) return null;
  const row = rows[index];

  switch (key) {
    case 'ArrowDown':
      return { index: Math.min(index + 1, rows.length - 1) };
    case 'ArrowUp':
      return { index: Math.max(index - 1, 0) };
    case 'Home':
      return { index: 0 };
    case 'End':
      return { index: rows.length - 1 };
    case 'ArrowRight': {
      if (!row) return null;
      if (row.isFolder && !row.isExpanded) return { expand: row.node.path };
      if (row.isFolder && row.isExpanded && index + 1 < rows.length) {
        // Only step in if the next row really is this folder's child.
        if (rows[index + 1].depth > row.depth) return { index: index + 1 };
      }
      return null;
    }
    case 'ArrowLeft': {
      if (!row) return null;
      if (row.isFolder && row.isExpanded) return { collapse: row.node.path };
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < row.depth) return { index: i };
      }
      return null;
    }
    case 'Enter':
    case ' ':
      return row ? { open: row.node } : null;
    default:
      return null;
  }
}

/**
 * What the Explorer's delete prompt says about `target` ({ name, isDir,
 * isLink }), given the names of the open files under it that have unsaved
 * changes.
 *
 * Deleting closes the tabs of everything deleted, and their unsaved changes
 * went with them without a word — nothing said so, and on Windows they had
 * survived until paths were matched there too. So the prompt says so, and
 * Cancel keeps them.
 *
 * A link is deleted as a link, and what it points to is still there — but a
 * tab opened through it names its file by the link's path, which is gone. Kept
 * open, its Save made a new folder or file where the link had been, and the
 * file the user meant to edit never got the edits. So those tabs close too,
 * and the prompt says to save first to keep the edits where the link leads.
 *
 * With `trash` (the `files.enableTrash` setting) it asks about moving to the
 * Trash — the Recycle Bin on Windows (`os`) — instead, in words that say it
 * can be got back; the unsaved changes are lost all the same, since the tabs
 * close, and it says so in the same words.
 */
export function deletePromptMessage(target, unsavedNames = [], { trash = false, os = null } = {}) {
  const unsaved = unsavedChangesIn(unsavedNames);
  const lostThroughLink = unsaved
    ? ` Unsaved changes in ${unsaved} will be lost; save them first to keep them in what it points to.`
    : '';
  const lost = unsaved ? ` Unsaved changes in ${unsaved} will be lost.` : '';
  if (trash) {
    const bin = trashName(os);
    if (target.isLink) {
      return `Move the link '${target.name}' to the ${bin}? What it points to is not touched.${lostThroughLink}`;
    }
    const contents = target.isDir ? ' Its contents go with it.' : '';
    return `Move '${target.name}' to the ${bin}?${contents} You can restore it from the ${bin}.${lost}`;
  }
  if (target.isLink) {
    return `Are you sure you want to delete the link '${target.name}'? What it points to is not touched.${lostThroughLink}`;
  }
  const contents = target.isDir ? ' Its contents will be deleted too.' : '';
  return `Are you sure you want to delete '${target.name}'?${contents}${lost}`;
}

/**
 * Whether a delete of `target` goes to the Trash: with the setting on, and —
 * for a link — only on macOS. Windows and Linux remove a link as a link
 * instead (src-tauri/src/fs/trash.rs, `LINKS_GO_TO_BIN`, says why), and
 * then the question is the plain one about deleting a link: what it points
 * to is not touched, which is all there is to say.
 */
export function deletesToTrash({ enabled = true, isLink = false, os = null } = {}) {
  return Boolean(enabled) && (!isLink || os === 'macos');
}

let permanentIds = 0;

/**
 * The "Delete Permanently?" questions waiting, oldest first, with `target`
 * added — unless one for the same path is already waiting. Each gets an id
 * of its own, which keys its dialog.
 *
 * A queue, not one slot: two moves to the Trash can fail one after the
 * other, and the second used to rewrite the question already open — same
 * dialog, focus where the user had put it, its button now deleting the
 * other file. Each question opens only once the one before has closed, as
 * a new dialog with Cancel focused.
 */
export function queuePermanent(queue, target) {
  const waiting = Array.isArray(queue) ? queue : [];
  if (!target || waiting.some((t) => t.path === target.path)) return waiting;
  permanentIds += 1;
  return [...waiting, { ...target, id: `permanent-${permanentIds}` }];
}

/** What the bin a delete moves to is called on `os`: the Recycle Bin on Windows, the Trash elsewhere. */
export function trashName(os) {
  return os === 'windows' ? 'Recycle Bin' : 'Trash';
}

/** The delete prompt's button: what it will do, in its own words. */
export function deleteConfirmLabel({ trash = false, os = null } = {}) {
  return trash ? `Move to ${trashName(os)}` : 'Delete';
}

/**
 * Why a move to the bin failed — the backend's words after "Not moved to the
 * Trash: " (or "…Recycle Bin: ", src-tauri/src/fs/trash.rs) — or null for
 * any other failure. Only a failure of the move leads to the question about
 * a permanent delete: a path refused for being outside the folder, on
 * another machine or already gone would be refused by a permanent delete
 * just the same, and asking would only offer to try.
 */
export function trashFailureReason(message) {
  const match = /^Not moved to the (?:Trash|Recycle Bin): ([\s\S]*)$/.exec(typeof message === 'string' ? message : '');
  return match ? match[1].trim() : null;
}

/**
 * The second question, after a move to the bin failed: whether to delete
 * `target` for good instead, saying why it could not be moved — on Windows
 * most often a drive with no Recycle Bin (a network drive, a USB stick),
 * where the shell would otherwise have deleted it permanently without a
 * word. Unsaved changes are named as in the first question.
 */
export function permanentDeletePromptMessage(target, reason, unsavedNames = [], { os = null } = {}) {
  const unsaved = unsavedChangesIn(unsavedNames);
  const bin = trashName(os);
  const why = reason ? `: ${String(reason).replace(/[.\s]+$/, '')}.` : '.';
  // Listed as a folder, a link now (made a junction since): the backend
  // refused to move it (`link_not_moved` in src-tauri/src/fs/trash.rs), and
  // a permanent delete removes the link alone — so it is asked about as one.
  if (target.isLink || /^It is a link\b/.test(String(reason ?? ''))) {
    const lost = unsaved ? ` Unsaved changes in ${unsaved} will be lost; save them first to keep them in what it points to.` : '';
    return `The link '${target.name}' could not be moved to the ${bin}${why} Delete the link permanently instead? What it points to is not touched.${lost}`;
  }
  const contents = target.isDir ? ' Its contents will be deleted too.' : '';
  const lost = unsaved ? ` Unsaved changes in ${unsaved} will be lost.` : '';
  return `'${target.name}' could not be moved to the ${bin}${why} Delete it permanently instead? This cannot be undone.${contents}${lost}`;
}

/** A failure's words: Tauri rejects with the command's own string, the browser mock with an Error. */
export function failureText(err) {
  return typeof err === 'string' ? err : String(err?.message ?? err ?? '');
}

/** "a.js", "a.js and b.js", "a.js, b.js and 3 other files". */
function unsavedChangesIn(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} other files`;
}
