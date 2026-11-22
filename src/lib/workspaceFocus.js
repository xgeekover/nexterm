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
import { activeKindOf, activePaneOf, useTerminalStore } from '../stores/terminalStore.js';
import { useEditorStore } from '../stores/editorStore.js';
import { EDITOR_KIND } from '../components/terminal/splitLayout.js';

/**
 * The input of the terminal on screen: the active pane of the group shown.
 * Null when the terminal panel is hidden or that pane holds no terminal.
 */
export function activeTerminalInput() {
  const { groups, activeGroupId } = useTerminalStore.getState();
  const paneId = groups?.find((g) => g.id === activeGroupId)?.activePaneId;
  // No page to look in (the menus' unit tests run without one).
  if (!paneId || typeof document === 'undefined') return null;
  const quoted = String(paneId).replace(/["\\]/g, '\\$&');
  return document.querySelector(`[data-pane-body="${quoted}"] .xterm-helper-textarea`);
}

/**
 * Every dialog the app draws says it is one: the Settings window and the
 * startup commands (`role="dialog"`, `aria-modal`), every question asked
 * (ConfirmDialog — the paste warning among them — `role="alertdialog"`).
 */
const DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/**
 * What says "dialog" without being one of the app's, or is not there to be
 * seen: Monaco's widgets — its find widget is a `role="dialog"` that stays
 * in the page, hidden, after the first ⌘F, and held the jump for the rest of
 * the session — the bell's list, which closes itself when the jump moves
 * the active tab (`data-bell-list`), and anything hidden from the user.
 */
const NOT_MODAL = '.monaco-editor, [data-bell-list], [aria-hidden="true"], [inert]';

/**
 * Whether `el` can be seen: in the page, drawing a box — `display: none` on
 * it or on an ancestor draws none — and not `visibility: hidden`.
 */
function visible(el, doc) {
  if (!el?.isConnected) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  const style = doc?.defaultView?.getComputedStyle?.(el);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden');
}

/** Whether any element matching `selector`, outside `except`, can be seen. */
function anyShown(doc, selector, except) {
  try {
    const found = doc?.querySelectorAll?.(selector) ?? [];
    for (const el of found) {
      if (except && el.closest?.(except)) continue;
      if (visible(el, doc)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether one of the app's dialogs is open, and can be seen. A command that
 * moves the keyboard — Go to Latest Unread Notification — leaves the key
 * alone then: run behind Settings or a question, it sent the next keys to a
 * terminal under it. False with no document to ask.
 */
export function dialogOnScreen(doc = globalThis.document) {
  return anyShown(doc, DIALOGS, NOT_MODAL);
}

/**
 * Whether a menu that took the keyboard is open: a right-click menu, one of
 * the menu bar's. It keeps the keyboard while it is open — it takes focus
 * back whenever its owner draws again, and a pane that sees focus come in
 * becomes the active one — so the jump would land on a terminal and be
 * pulled straight back. The jump waits for it to close. A menu that opened
 * by itself and waits to be clicked (`data-opened-by-itself`, the resume
 * offer's list) takes nothing, and holds nothing up.
 */
export function menuOnScreen(doc = globalThis.document) {
  return anyShown(doc, '[role="menu"]', '[data-opened-by-itself], .monaco-editor, [aria-hidden="true"], [inert]');
}

/**
 * Give the terminal on screen the keyboard. False when there is none. Its
 * pane becomes THE active one as focus comes in (TerminalSplitContainer's
 * `onFocusCapture`), and with that an editor pane's focus request still
 * waiting for its Monaco goes (editorStore.js, C2 review N-02).
 */
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
 * Give editor pane `paneId` the keyboard (C1 review M-01): out of the
 * terminal that has it first — its program is told it lost focus when its
 * pane stops being the active one (TerminalView) — then into the pane's
 * editor, held by the store until that editor is mounted (a zoom remounts
 * it, Monaco may still be loading), or onto the body of a pane with no file.
 * False when the pane is not there.
 */
export function focusEditorPane(paneId, doc = globalThis.document) {
  const had = doc?.activeElement;
  if (had?.closest?.('.xterm')) had.blur?.();
  if (useEditorStore.getState().focusEditorPane?.(paneId)) return true;
  const quoted = String(paneId).replace(/["\\]/g, '\\$&');
  const body = doc?.querySelector?.(`[data-editor-pane-body="${quoted}"]`);
  body?.focus?.({ preventScroll: true });
  return Boolean(body);
}

/**
 * Give THE active pane of the group on screen the keyboard, of whichever
 * kind it is (FC11): its editor, or its terminal's input. What a command
 * that moved the active pane without a pointer calls (workbenchCommands.js).
 * A terminal pane that is being remounted takes it itself as it mounts
 * (TerminalView's focus effect). False when there is nothing to focus.
 */
export function focusActivePane() {
  const { groups, activeGroupId } = useTerminalStore.getState();
  const group = groups?.find((g) => g.id === activeGroupId);
  if (!group) return false;
  if (activeKindOf(group) === EDITOR_KIND) return focusEditorPane(activePaneOf(group));
  return focusTerminal();
}

/**
 * Give the keyboard back to the workspace: to THE active pane, of whichever
 * kind (FC11), then to the terminal on screen, then to the open file — the
 * open file first when `first` is 'editor', for what was asked about a file.
 * With a terminal as the active pane, as every group without files has,
 * 'terminal' (the default) is what it always was. False when there is
 * nothing to focus.
 */
export function focusWorkspace(first = 'terminal') {
  if (first === 'editor') return focusEditorTab() || focusTerminal();
  return focusActivePane() || focusTerminal() || focusEditorTab();
}
