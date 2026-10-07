/**
 * What the command palette offers, as plain data.
 *
 * This lives outside the component so the matching rules can be exercised
 * without a renderer: `CommandPalette.jsx` calls `buildPaletteGroups` and only
 * decides how each descriptor is drawn and which store call its `command`
 * dispatches to.
 */

import { fuzzyMatch } from './utils.js';
import { basename, isInside, relativeTo, toPosix } from './paths.js';
import { isMac } from './platform.js';
import { DEFAULT_RESOLVED, shortcutLabel } from './keybindings.js';

/**
 * The most files the palette lists for one query. An empty query matches
 * every file, and every row drawn costs: ten thousand of them, in a folder
 * with a `vendor/` or a `.venv`, made each key and each move of the mouse
 * wait for all of them. More than a screenful is typed away, not scrolled
 * through; the rest are counted (`more`) so the list can say so.
 */
export const FILE_RESULT_LIMIT = 200;

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
      title: 'Clear Terminal',
      subtitle: 'Clears the active terminal\'s screen and scrollback; the line being typed stays',
      hint: hint('clear-terminal'),
    },
    {
      type: 'command',
      id: 'cmd-toggle-pane-zoom',
      command: 'toggle_pane_zoom',
      title: 'Toggle Pane Zoom',
      subtitle: 'Fill the group with the active pane, or show every pane again',
      hint: hint('toggle-pane-zoom'),
    },
    // No hint: nothing is bound to Save All. It used to show Save's chord,
    // which writes the active tab and leaves every other one unsaved.
    {
      type: 'command',
      id: 'cmd-save-all',
      command: 'save_all',
      title: 'Save All Files',
      subtitle: 'Writes all dirty editor buffers to disk',
    },
  ];
}

/**
 * Where the keyboard goes once the palette has closed on `item`, or on
 * nothing (null: Escape, a click outside, its chord again):
 *
 *   'terminal'  a command line from history, typed into the active terminal:
 *               the Enter that runs it is the user's, and has to land there
 *               wherever the palette was opened from
 *   'editor'    a file: the editor it opens in
 *   'opener'    anything else, and nothing: back where it was when the
 *               palette opened (`canHaveFocusBack`)
 */
export function focusAfterPalette(item) {
  if (item?.type === 'history') return 'terminal';
  if (item?.type === 'file') return 'editor';
  return 'opener';
}

/**
 * Whether `opener`, what had the keyboard when the palette opened, can have
 * it back: an element still on the page (`onPage`), not the page itself
 * (`body`), and not a button. Chromium focuses a button that is clicked, so
 * the title bar's search box would have it back and the next Enter would
 * open the palette again; the terminal on screen takes it instead.
 */
export function canHaveFocusBack(opener, { body, onPage }) {
  return Boolean(opener) && opener !== body && opener.tagName !== 'BUTTON' && onPage(opener);
}

/**
 * The palette's result groups for `query`, in display order.
 *
 * `mode` is 'all' (⌘K — files and commands), 'files' (⌘P — files only) or
 * 'history' (⌘⇧H — command lines already run), and `bindings` decides which
 * shortcut each command advertises.
 * Empty groups are dropped so the rendered list and the keyboard selection
 * always run over exactly the same items.
 *
 * The files are `files` — every file under the open folder, as the backend
 * lists them (`fs_list_files`), `filesTruncated` when it stopped short —
 * or, while there is no such list, the files in the Explorer's `fileTree`,
 * which stops five levels down. At most `limit` are listed, best match
 * first; the files group says how many `more` matched, and whether the list
 * it came from was `truncated`.
 */
export function buildPaletteGroups({
  fileTree = [],
  files = null,
  filesTruncated = false,
  rootPath = null,
  query = '',
  mode = 'all',
  bindings = DEFAULT_RESOLVED,
  recentRoots = [],
  history = [],
  limit = FILE_RESULT_LIMIT,
} = {}) {
  const q = (query || '').toLowerCase().trim();

  // Its own mode rather than a section of "all": you reach for it knowing you
  // want a folder, and there is nothing to mix it with — with no folder open
  // there are no files to list in the first place.
  if (mode === 'recent') {
    const rows = recentRoots
      .filter((path) => typeof path === 'string' && path)
      .filter((path) => !q || path.toLowerCase().includes(q))
      .map((path) => ({
        type: 'recent',
        id: `recent-${path}`,
        title: basename(path) || path,
        subtitle: path,
        path,
        hint: 'Folder',
      }));
    return rows.length > 0 ? [{ label: 'recent folders', items: rows }] : [];
  }

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

  // A path typed with either separator: the paths are matched with `/`.
  const found = matchFiles(fileCandidates(files ?? fileTree, files ? 'paths' : 'tree', rootPath), toPosix(q), limit);
  const fileRows = found.entries.map((entry) => ({
    type: 'file',
    id: `file-${entry.path}`,
    title: entry.name,
    subtitle: entry.path,
    path: entry.path,
    hint: 'File',
  }));

  const commands = mode === 'files' ? [] : matchingCommands(paletteCommands(bindings), q);

  return [
    { label: 'files', items: fileRows, more: found.more, truncated: files ? filesTruncated === true : false },
    { label: 'commands', items: commands },
  ].filter((group) => group.items.length > 0);
}

/**
 * The commands `q` matches: those whose title it matches first, then those
 * only their description does, each in the order they are declared. A loose
 * match on a description is easy — "Clears the active terminal's screen and
 * scrollback" spells "save all" — and the first row is the one Enter runs.
 */
function matchingCommands(all, q) {
  const byTitle = all.filter((cmd) => fuzzyMatch(q, cmd.title));
  const byDescription = all.filter((cmd) => !byTitle.includes(cmd) && fuzzyMatch(q, cmd.subtitle));
  return [...byTitle, ...byDescription];
}

/** Each source's files, readied for matching, kept until the source is replaced. */
const candidateCache = new WeakMap();

/**
 * Every file in `source` — the backend's list of paths, or the Explorer's
 * tree — with what matching needs worked out once per list rather than once
 * per file per key: the name, and the path below the open folder, both
 * lowercased, with `/` for a separator.
 */
function fileCandidates(source, kind, rootPath) {
  if (!Array.isArray(source)) return [];
  const cached = candidateCache.get(source);
  if (cached && cached.rootPath === rootPath) return cached.entries;
  const nodes =
    kind === 'paths'
      ? source.filter((path) => typeof path === 'string' && path).map((path) => ({ path, name: basename(path) }))
      : flattenFileNodes(source).filter((node) => typeof node.path === 'string');
  const entries = nodes.map(({ path, name }) => {
    const below = rootPath && isInside(rootPath, path) ? relativeTo(rootPath, path) : path;
    return { path, name, lowerName: String(name).toLowerCase(), lowerPath: toPosix(below).toLowerCase() };
  });
  candidateCache.set(source, { rootPath, entries });
  return entries;
}

/** Whether the letters of `needle` appear in `text` in order. Both already lowercased. */
function inOrder(needle, text) {
  let at = 0;
  for (let i = 0; i < text.length && at < needle.length; i += 1) {
    if (text[i] === needle[at]) at += 1;
  }
  return at === needle.length;
}

/**
 * How well a file answers `q`: 0 when its name starts with it, 1 when its
 * name has it, 2 when its name has its letters in order, 3 when only its
 * path below the folder does, -1 not at all.
 *
 * The whole path was matched before, the open folder's own location
 * included, so the letters of `/Users/me/projects` matched almost any query
 * against every file, and with every match equal the file actually called
 * `App.jsx` could come last.
 */
function fileRank(entry, q) {
  if (!q || entry.lowerName.startsWith(q)) return 0;
  if (entry.lowerName.includes(q)) return 1;
  if (inOrder(q, entry.lowerName)) return 2;
  return inOrder(q, entry.lowerPath) ? 3 : -1;
}

/**
 * The best `limit` files for `q`, best first and otherwise in the order they
 * came (path order), and how many more matched. One pass, no sort: twenty
 * thousand files are ranked on every key.
 */
function matchFiles(candidates, q, limit) {
  const ranked = [[], [], [], []];
  let matched = 0;
  for (const entry of candidates) {
    const rank = fileRank(entry, q);
    if (rank < 0) continue;
    matched += 1;
    if (ranked[rank].length < limit) ranked[rank].push(entry);
  }
  const entries = ranked.flat().slice(0, limit);
  return { entries, more: matched - entries.length };
}
