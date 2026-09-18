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

import { samePath } from '../../lib/paths.js';

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
