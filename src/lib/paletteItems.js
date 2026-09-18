/**
 * What the command palette offers, as plain data.
 *
 * This lives outside the component so the matching rules can be exercised
 * without a renderer: `CommandPalette.jsx` calls `buildPaletteGroups` and only
 * decides how each descriptor is drawn and which store call its `command`
 * dispatches to.
 */

import { fuzzyMatch } from './utils.js';
import { isMac } from './platform.js';
import { DEFAULT_RESOLVED, shortcutLabel } from './keybindings.js';

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

/**
 * The built-in actions, independent of any query.
 *
 * The hints are read off the bindings rather than written beside each entry:
 * these keys are rebindable now, and a palette row showing the shortcut a user
 * replaced is the same lie a stale menu row is.
 */
export function paletteCommands(bindings = DEFAULT_RESOLVED) {
  const hint = (command) => shortcutLabel(command, bindings, { isMac });
  return [
    {
      type: 'command',
      id: 'cmd-new-terminal',
      command: 'new_terminal',
      title: 'New Terminal Tab',
      subtitle: 'Spawns a new independent PTY terminal session',
      hint: hint('new-terminal'),
    },
    {
      type: 'command',
      id: 'cmd-clear-terminal',
      command: 'clear_terminal',
      title: 'Clear Terminal Output',
      subtitle: 'Purges unpinned blocks in current terminal tab',
      hint: hint('clear-terminal'),
    },
    {
      type: 'command',
      id: 'cmd-save-all',
      command: 'save_all',
      title: 'Save All Files',
      subtitle: 'Writes all dirty editor buffers to disk',
      hint: hint('save'),
    },
  ];
}

/**
 * The palette's result groups for `query`, in display order.
 *
 * `mode` is 'all' (⌘K — files and commands), 'files' (⌘P — files only) or
 * 'history' (⌘⇧H — command lines already run), and `bindings` decides which
 * shortcut each command advertises.
 * Empty groups are dropped so the rendered list and the keyboard selection
 * always run over exactly the same items.
 */
export function buildPaletteGroups({
  fileTree = [],
  query = '',
  mode = 'all',
  bindings = DEFAULT_RESOLVED,
  history = [],
} = {}) {
  const q = (query || '').toLowerCase().trim();

  // History is its own mode rather than a section of "all": you reach for it
  // knowing you want something you have already run, and mixing it with files
  // and commands would bury it under both.
  if (mode === 'history') {
    const rows = history
      .filter((entry) => entry && typeof entry.command === 'string')
      // Plain substring, not fuzzy: a command line is not a filename, and
      // fuzzy matching over `git commit -m "..."` turns every query into a
      // wall of near-misses.
      .filter((entry) => !q || entry.command.toLowerCase().includes(q))
      .map((entry) => ({
        type: 'history',
        id: `history-${entry.command}`,
        title: entry.command,
        subtitle: entry.cwd || '',
        command: entry.command,
        hint: entry.count > 1 ? `${entry.count}×` : 'Ran once',
      }));
    return rows.length > 0 ? [{ label: 'history', items: rows }] : [];
  }

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
      : paletteCommands(bindings).filter(
          (cmd) => fuzzyMatch(q, cmd.title) || fuzzyMatch(q, cmd.subtitle)
        );

  return [
    { label: 'files', items: files },
    { label: 'commands', items: commands },
  ].filter((group) => group.items.length > 0);
}
