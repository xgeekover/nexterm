/**
 * What the pane commands act on, decided in one place (editor placement,
 * sibling C2, FC10/FC11).
 *
 * One workbench draws files and terminals side by side, and a group has ONE
 * active pane of either kind (`activePaneOf`, `activeKindOf` in
 * terminalStore.js). Save, Close Pane, Split, Find and Toggle Pane Zoom go to
 * that pane: an editor pane's action when it is an editor pane, the
 * terminal's as before when it is a terminal pane. The keyboard decides
 * first: a key pressed inside Monaco is the editor's, and the pane's whose
 * body holds it, whatever the store says; with no editor pane to act on it
 * does nothing. A wrong guess can never close a shell from inside a file.
 *
 * The keys (useKeybindings.js builds its context from `workbenchContext`)
 * and the menus (menuActions.js) both call these, so the two cannot come
 * apart. New Terminal, Clear Terminal and the prompt jumps stay the
 * terminal's: they act on `activePaneId`/`activeTabId`, the terminal the
 * group shows, even while a file is THE active pane.
 *
 * Each command that moves the active pane without a pointer — Focus
 * Next/Previous Pane, a zoom, a split or a move — hands the keyboard to the
 * pane it lands on (`focusActivePane`, C1 review M-01): before, only the
 * store changed, and what was typed next went to the shell that still had
 * the keyboard.
 */
import { activeKindOf, activePaneOf, useTerminalStore } from '../stores/terminalStore.js';
import { useEditorStore } from '../stores/editorStore.js';
import { EDITOR_KIND, leafKind } from '../components/terminal/splitLayout.js';
import { focusActivePane } from './workspaceFocus.js';

function activeGroup() {
  const { groups, activeGroupId } = useTerminalStore.getState();
  return groups?.find((g) => g.id === activeGroupId) ?? null;
}

function leafIn(node, id) {
  if (!node || id == null) return null;
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const child of node.children ?? []) {
    const found = leafIn(child, id);
    if (found) return found;
  }
  return null;
}

/** The tab a leaf shows: its active one while it holds it, else its first. */
function shownTabOf(leaf) {
  if (!leaf) return null;
  const ids = Array.isArray(leaf.tabIds) ? leaf.tabIds : [];
  return ids.includes(leaf.activeTabId) ? leaf.activeTabId : ids[0] ?? null;
}

/** Whether the keyboard is inside a Monaco editor right now (the menus ask). */
export function keyboardInMonaco(doc = globalThis.document) {
  return Boolean(doc?.activeElement?.closest?.('.monaco-editor'));
}

/**
 * The editor pane whose body (`data-editor-pane-body`, EditorPane.jsx) holds
 * `el`, the element with the keyboard: its id, or null outside every one.
 */
export function editorPaneOfElement(el) {
  return el?.closest?.('[data-editor-pane-body]')?.getAttribute?.('data-editor-pane-body') ?? null;
}

/**
 * Where the keyboard is, as the pane commands take it (the menus ask): inside
 * Monaco or not, and the editor pane holding it.
 */
export function keyboardPlace(doc = globalThis.document) {
  return { inMonaco: keyboardInMonaco(doc), paneId: editorPaneOfElement(doc?.activeElement) };
}

/** The editor leaf of the group on screen the keyboard is in (`paneId`), or null. */
function heldEditorLeaf(group, paneId) {
  const leaf = paneId == null ? null : leafIn(group?.tree, paneId);
  return leaf && leafKind(leaf) === EDITOR_KIND ? leaf : null;
}

/**
 * The kind the pane commands act on: 'editor' when the keyboard is inside
 * Monaco (`inMonaco`), else the active group's active kind.
 */
export function commandKind({ inMonaco = false } = {}) {
  return inMonaco ? EDITOR_KIND : activeKindOf(activeGroup());
}

/**
 * The editor leaf the commands act on, or null when they act on a terminal:
 * with the keyboard inside Monaco, the editor pane whose body holds it
 * (`paneId`, C2 review N-03 — the store can name another one for a moment);
 * else THE active pane when it is an editor pane; with the keyboard inside
 * Monaco and the store not yet told, the group's editor pane.
 */
export function commandEditorLeaf({ inMonaco = false, paneId = null } = {}) {
  const group = activeGroup();
  if (!group) return null;
  const held = inMonaco ? heldEditorLeaf(group, paneId) : null;
  if (held) return held;
  if (activeKindOf(group) === EDITOR_KIND) return leafIn(group.tree, activePaneOf(group));
  if (inMonaco) return leafIn(group.tree, group.editorPaneId);
  return null;
}

/**
 * What Save writes: the file the active editor pane shows; from a terminal
 * pane, the editor's active tab as before (the file last edited). Null when
 * no file is open.
 */
export function saveTarget(opts = {}) {
  if (commandKind(opts) === EDITOR_KIND) {
    const leaf = commandEditorLeaf(opts);
    if (leaf) return shownTabOf(leaf);
  }
  return useEditorStore.getState().activeTabId ?? null;
}

export function saveActive(opts = {}) {
  const tabId = saveTarget(opts);
  if (tabId) useEditorStore.getState().saveFile?.(tabId);
  return tabId;
}

/**
 * Close Pane (Ctrl+W, the human's Q5): in an editor pane, its shown file tab
 * — asking first when it is unsaved — and, with no file in it, the empty
 * pane itself. In a terminal pane, the pane as before (`closeActivePane`).
 * Returns what it closed: 'tab', 'editor-pane' or 'terminal-pane' — null
 * for a key pressed inside Monaco with no editor pane to act on.
 */
export function closeActive(opts = {}) {
  const leaf = commandKind(opts) === EDITOR_KIND ? commandEditorLeaf(opts) : null;
  if (leaf) {
    const editor = useEditorStore.getState();
    const tabId = shownTabOf(leaf);
    if (tabId) editor.requestCloseTab?.(tabId);
    else editor.requestCloseEditorPane?.(leaf.id);
    // A clean close moved the active pane (FC9); a question keeps it, and
    // hands the keyboard back itself when answered (EditorPrompts).
    if (!useEditorStore.getState().pendingClose) focusActivePane();
    return tabId ? 'tab' : 'editor-pane';
  }
  // Pressed in a file, it is never a shell's to close (C2 review N-03).
  if (opts.inMonaco) return null;
  useTerminalStore.getState().closeActivePane?.();
  return 'terminal-pane';
}

/**
 * Split Right/Down: an editor pane gets an empty editor pane beside it,
 * which becomes the active one; a terminal pane splits as before. Inside
 * Monaco with no editor pane to act on, nothing.
 */
export function splitActive(direction = 'horizontal', opts = {}) {
  const leaf = commandKind(opts) === EDITOR_KIND ? commandEditorLeaf(opts) : null;
  if (leaf) {
    const paneId = useEditorStore.getState().splitEditorPane?.(leaf.id, direction) ?? null;
    focusActivePane();
    return paneId;
  }
  if (opts.inMonaco) return null;
  return useTerminalStore.getState().splitActivePane?.(direction);
}

/**
 * Find: inside Monaco the key is Monaco's own (keybindings.js passes it
 * through). With an editor pane active and the keyboard elsewhere, that
 * editor gets the keyboard and opens its find widget; in a terminal pane,
 * the terminal's find bar. An editor pane with no file has nothing to find
 * in, and nothing happens — nor does the menu's Find inside a Monaco with
 * no editor pane to act on.
 */
export function findActive(opts = {}) {
  const leaf = commandKind(opts) === EDITOR_KIND ? commandEditorLeaf(opts) : null;
  if (leaf) {
    useEditorStore.getState().focusEditorPane?.(leaf.id, { find: true });
    return shownTabOf(leaf) ? 'editor' : null;
  }
  if (opts.inMonaco) return null;
  useTerminalStore.getState().openFind?.();
  return 'terminal';
}

/** Toggle Pane Zoom on THE active pane (the store's default), the keyboard kept in it. */
export function toggleZoomActive() {
  const zoomed = useTerminalStore.getState().togglePaneZoom?.();
  focusActivePane();
  return zoomed;
}

/** Focus Next/Previous Pane over both kinds, the keyboard landing in the pane (FC11). */
export function focusNextActive(delta = 1) {
  useTerminalStore.getState().focusNextPane?.(delta);
  return focusActivePane();
}

/**
 * Move Editor to New Pane Right/Down: the file the active editor pane shows
 * (else the editor's active tab) split out beside its pane, as Move to New
 * Pane does for a terminal. Returns the new pane's id, or null when the
 * file is alone in its pane already or no file is open.
 */
export function moveEditorToNewPane(direction = 'horizontal', tabId = null) {
  const editor = useEditorStore.getState();
  const leaf = commandEditorLeaf();
  const id = tabId ?? (leaf ? shownTabOf(leaf) : editor.activeTabId);
  if (!id) return null;
  const paneId = editor.moveEditorTabToNewPane?.(id, direction) ?? null;
  if (paneId) focusActivePane();
  return paneId;
}

/**
 * The keybinding context's pane commands for one key press, under the names
 * keybindings.js calls them by. `isInMonacoEditor`: the press came from
 * inside Monaco; `editorPaneId`: the editor pane whose body holds the
 * element it was pressed in (`editorPaneOfElement` of the event's target).
 */
export function workbenchContext({ isInMonacoEditor = false, editorPaneId = null } = {}) {
  const opts = { inMonaco: Boolean(isInMonacoEditor), paneId: editorPaneId ?? null };
  const editor = useEditorStore.getState();
  return {
    activeEditorTabId: saveTarget(opts),
    saveFile: (tabId) => editor.saveFile?.(tabId),
    splitActivePane: (direction) => splitActive(direction, opts),
    closeActivePane: () => closeActive(opts),
    focusNextPane: (delta) => focusNextActive(delta),
    togglePaneZoom: () => toggleZoomActive(),
    openFind: () => findActive(opts),
    equalizeSplits: () => useTerminalStore.getState().equalizeSplits?.(),
  };
}
