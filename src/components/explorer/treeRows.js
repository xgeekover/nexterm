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
