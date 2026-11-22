/**
 * The Explorer menu's items that hand a row to something outside the tree
 * (bundle 2, A12-1 to A12-3): Reveal in Finder / File Explorer / File
 * Manager, Open Terminal Here, and Open in External Editor.
 *
 * Pure, so the menu's choices can be checked from Node with fakes for what
 * they call (tests/adversarial/explorer_open_actions.test.js): FileExplorer
 * passes the real ones — the `fs_reveal_path` and `fs_open_in_external_editor`
 * wrappers, the terminal store's `createTab`, the terminal focus, the
 * Explorer's error line.
 *
 * Reveal only reveals (src-tauri/src/fs/reveal.rs): a file is selected in its
 * folder, a folder is opened on macOS and Windows and selected in its parent
 * elsewhere, a package is shown and never launched. Nothing here opens a file
 * with the OS default app: Open in External Editor runs the program the user
 * set (`externalEditorCommand`), and is not in the menu while none is set
 * (src-tauri/src/fs/external_editor.rs).
 */
import { dirname } from '../../lib/paths.js';
import { failureText } from './treeRows.js';

/** What the file manager is called where NexTerm runs (`useSystemStore`'s `os`). */
export function revealLabel(os) {
  if (os === 'macos') return 'Reveal in Finder';
  if (os === 'windows') return 'Reveal in File Explorer';
  return 'Reveal in File Manager';
}

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * What a Reveal shows for `target`: the row's own path, or the open folder
 * for the empty area below the rows. Null when there is nothing to show.
 */
export function revealPathFor(target, rootPath) {
  const path = target?.type === 'empty' ? rootPath : target?.path;
  return hasText(path) ? path : null;
}

/**
 * The folder Open Terminal Here starts in: a folder row's own path, a file's
 * folder, the open folder for the empty area. Null when there is none.
 */
export function terminalFolderFor(target, rootPath) {
  if (!target) return null;
  const folder = target.type === 'empty' ? rootPath : target.type === 'file' ? dirname(target.path ?? '') : target.path;
  return hasText(folder) ? folder : null;
}

/** The Explorer's line for a terminal that could not start in `folder`. */
export function terminalFailedText(folder, err = null) {
  const why = err ? failureText(err) : '';
  return `No terminal could be started in ${folder}${why ? `: ${why}` : '.'}`;
}

/**
 * The external editor command to run, trimmed, or null while none is set
 * (the `externalEditorCommand` setting: empty or only whitespace is none).
 */
export function externalEditorCommandOf(setting) {
  return hasText(setting) ? setting.trim() : null;
}

/**
 * The items, in menu order, for `target` (FileExplorer's menu target:
 * `{ type: 'file' | 'folder' | 'empty', path, isDir, name }`): Reveal, Open
 * Terminal Here, and Open in External Editor only while an editor is set.
 *
 * `deps`:
 *  - `os`: 'macos' | 'windows' | 'linux', for Reveal's label;
 *  - `rootPath`: the open folder, what the empty area stands for;
 *  - `reveal(path)`: shows `path` in the file manager (`fs_reveal_path`);
 *  - `createTab(options)`: the terminal store's, resolving with the new tab or
 *    null when no shell could start there (`strictCwd`: there or nowhere);
 *  - `focusTerminal()`: gives the terminal on screen the keyboard;
 *  - `externalEditorCommand`: the setting, as saved;
 *  - `openInExternalEditor(command, path)`: runs `command` with `path` added
 *    as its last argument (`fs_open_in_external_editor`);
 *  - `setError(text)`: the Explorer's error line.
 *
 * Each item's `onSelect` returns its promise, which never rejects: a failure
 * goes to `setError`.
 */
export function buildOpenActionItems(target, deps) {
  const { os, rootPath, reveal, createTab, focusTerminal, setError } = deps;
  const revealPath = revealPathFor(target, rootPath);
  const folder = terminalFolderFor(target, rootPath);
  const editorCommand = externalEditorCommandOf(deps.externalEditorCommand);
  const noFolder = 'No folder is open';
  const items = [
    {
      key: 'reveal',
      label: revealLabel(os),
      disabled: revealPath === null,
      disabledReason: revealPath === null ? noFolder : undefined,
      onSelect: () =>
        Promise.resolve()
          .then(() => reveal(revealPath))
          .then(
            () => undefined,
            (err) => setError(failureText(err))
          ),
    },
    {
      key: 'open-terminal-here',
      label: 'Open Terminal Here',
      disabled: folder === null,
      disabledReason: folder === null ? noFolder : undefined,
      // In that folder or nowhere (`strictCwd`): a terminal that started
      // somewhere else would look as if it had worked. The user picked it,
      // so it goes where a new terminal goes and takes the keyboard.
      onSelect: () =>
        Promise.resolve()
          .then(() => createTab({ cwd: folder, strictCwd: true }))
          .then(
            (tab) => {
              if (!tab) setError(terminalFailedText(folder));
              else focusTerminal?.();
            },
            (err) => setError(terminalFailedText(folder, err))
          ),
    },
  ];
  // Only while the user has set an editor: without one there is nothing to
  // run, and the OS default app is never the fallback. It gets what Reveal
  // would show — the row, or the open folder for the empty area — and the
  // backend's refusal, in its words, is the Explorer's error.
  if (editorCommand !== null) {
    items.push({
      key: 'open-in-external-editor',
      label: 'Open in External Editor',
      disabled: revealPath === null,
      disabledReason: revealPath === null ? noFolder : undefined,
      onSelect: () =>
        Promise.resolve()
          .then(() => deps.openInExternalEditor(editorCommand, revealPath))
          .then(
            () => undefined,
            (err) => setError(failureText(err))
          ),
    });
  }
  return items;
}
