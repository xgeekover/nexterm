/**
 * Where the keyboard goes when what had it is gone.
 *
 * Closing the command palette or a dialog unmounts the control that had
 * focus, and focus falls to the page. Keys then reach only the window's
 * listeners: nothing types anywhere until something is clicked, and on
 * Windows and Linux the app's chords answer keys meant for the shell —
 * Ctrl+W, a word erased in bash, closed the pane. So each gives the keyboard
 * back to what had it when it opened, and when that has gone too — the menu
 * it was chosen from, a button that went with what it closed — to the
 * terminal or the editor on screen.
 */
import { useTerminalStore } from '../stores/terminalStore.js';
import { useEditorStore } from '../stores/editorStore.js';

/**
 * The input of the terminal on screen: the active pane of the group shown.
 * Null when the terminal panel is hidden or that pane holds no terminal.
 */
export function activeTerminalInput() {
  const { groups, activeGroupId } = useTerminalStore.getState();
  const paneId = groups?.find((g) => g.id === activeGroupId)?.activePaneId;
  if (!paneId) return null;
  const quoted = String(paneId).replace(/["\\]/g, '\\$&');
  return document.querySelector(`[data-pane-body="${quoted}"] .xterm-helper-textarea`);
}

/** Give the terminal on screen the keyboard. False when there is none. */
export function focusTerminal() {
  const input = activeTerminalInput();
  // Without scrolling, as xterm's own focus() does: the textarea follows the
  // cursor, and bringing it into view would move the terminal's box.
  input?.focus({ preventScroll: true });
  return Boolean(input);
}

/**
 * Give the active editor tab the keyboard, its caret where it was. False
 * when no file is open. Through the store (`focusEditor`), which holds the
 * request until the tab's editor is there to take it.
 */
export function focusEditorTab() {
  const editor = useEditorStore.getState();
  if (!editor.getActiveTab?.()) return false;
  editor.focusEditor();
  return true;
}

/**
 * Give the keyboard to the terminal on screen, or to the open file when
 * there is no terminal — the other way round when `first` is 'editor', for
 * what was asked about a file. False when there is neither.
 */
export function focusWorkspace(first = 'terminal') {
  return first === 'editor' ? focusEditorTab() || focusTerminal() : focusTerminal() || focusEditorTab();
}
