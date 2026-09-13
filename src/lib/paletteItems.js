/**
 * What the command palette offers, as plain data.
 *
 * This lives outside the component so the matching rules can be exercised
 * without a renderer: `CommandPalette.jsx` calls `buildPaletteGroups` and only
 * decides how each descriptor is drawn and which store call its `command`
 * dispatches to.
 */

import { fuzzyMatch } from './utils.js';
import { chord } from './platform.js';

/**
 * Every file in an explorer tree, at any depth.
 *
 * `fs_read_dir` returns a NESTED tree (each directory carries its own
 * `children`), so reading only the top level hides everything under `src/`,
 * `tests/`, and so on. The palette used to do exactly that, which is why ⌘P
 * could not find `src/App.jsx`.
 */
export function flattenFileNodes(nodes, acc = []) {
  if (!Array.isArray(nodes)) return acc;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.is_dir) {
      flattenFileNodes(node.children, acc);
    } else {
      acc.push(node);
    }
  }
  return acc;
}

/** The built-in actions, independent of any query. */
export function paletteCommands() {
  return [
    {
      type: 'command',
      id: 'cmd-new-terminal',
      command: 'new_terminal',
      title: 'New Terminal Tab',
      subtitle: 'Spawns a new independent PTY terminal session',
      hint: chord('ctrl', 'shift', '`'),
    },
    {
      type: 'command',
      id: 'cmd-clear-terminal',
      command: 'clear_terminal',
      title: 'Clear Terminal Output',
      subtitle: 'Purges unpinned blocks in current terminal tab',
      hint: chord('mod', 'l'),
    },
    {
      type: 'command',
      id: 'cmd-save-all',
      command: 'save_all',
      title: 'Save All Files',
      subtitle: 'Writes all dirty editor buffers to disk',
      hint: chord('mod', 's'),
    },
  ];
}

/**
 * The palette's result groups for `query`, in display order.
 *
 * `mode` is 'all' (⌘K — files and commands) or 'files' (⌘P — files only).
 * Empty groups are dropped so the rendered list and the keyboard selection
 * always run over exactly the same items.
 */
export function buildPaletteGroups({ fileTree = [], query = '', mode = 'all' } = {}) {
  const q = (query || '').toLowerCase().trim();

  const files = flattenFileNodes(fileTree)
    .filter((node) => fuzzyMatch(q, node.path) || fuzzyMatch(q, node.name))
    .map((node) => ({
      type: 'file',
      id: `file-${node.path}`,
      title: node.name,
      subtitle: node.path,
      path: node.path,
      hint: 'File',
    }));

  const commands =
    mode === 'files'
      ? []
      : paletteCommands().filter(
          (cmd) => fuzzyMatch(q, cmd.title) || fuzzyMatch(q, cmd.subtitle)
        );

  return [
    { label: 'files', items: files },
    { label: 'commands', items: commands },
  ].filter((group) => group.items.length > 0);
}
