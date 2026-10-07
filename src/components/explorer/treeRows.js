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

import { join, samePath } from '../../lib/paths.js';

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
 */
export function placeUnder(nodes, folderPath) {
  if (!Array.isArray(nodes)) return nodes;
  let moved = false;
  const placed = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const path = join(folderPath, node.name);
    const children = Array.isArray(node.children) ? placeUnder(node.children, path) : node.children;
    if (path === node.path && children === node.children) return node;
    moved = true;
    return { ...node, ...(node.id === undefined ? {} : { id: path }), path, ...(children === undefined ? {} : { children }) };
  });
  return moved ? placed : nodes;
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
 * Cancel keeps them. A link is deleted as a link: what it points to is still
 * there, and a file opened through it with unsaved changes stays open
 * (`deletePath`'s `keepUnsaved`).
 */
export function deletePromptMessage(target, unsavedNames = []) {
  const unsaved = unsavedChangesIn(unsavedNames);
  if (target.isLink) {
    const kept = unsaved ? ` Unsaved changes in ${unsaved} stay open.` : '';
    return `Are you sure you want to delete the link '${target.name}'? What it points to is not touched.${kept}`;
  }
  const contents = target.isDir ? ' Its contents will be deleted too.' : '';
  const lost = unsaved ? ` Unsaved changes in ${unsaved} will be lost.` : '';
  return `Are you sure you want to delete '${target.name}'?${contents}${lost}`;
}

/** "a.js", "a.js and b.js", "a.js, b.js and 3 other files". */
function unsavedChangesIn(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} other files`;
}
