/**
 * Send to Agent (bundle 4, A4): the entry points — the editor's context menu
 * (EditorPanel.jsx), the Command Palette's Send Selection to Agent and Send
 * File to Agent (rebindable, no default chord), the Explorer's Send to Agent
 * on a file or folder row — and the target they type into.
 *
 * The reference is src/lib/agentReference.js's; the typing, with every
 * refusal, the store's (`typeAgentReference`). Here: which terminal. Only one
 * running Claude Code or OpenCode is ever typed into; with one, that one;
 * with several, the Command Palette lists them (mode 'send-to-agent'), the
 * most recently focused first (tabMru.js); with none, every item is greyed
 * out with NO_AGENT_REASON — and a bound chord says it in an error toast.
 *
 * The editor's selection is read from the Monaco editor last focused
 * (`trackAgentEditor`, called as each mounts); this module imports no Monaco.
 * The recency is the Ctrl+Tab switcher's (tabSwitcherStore.js's
 * `recentTerminalTabs`) and the keyboard goes to the terminal through
 * workspaceFocus.js's `focusTerminal`, both handed in by workbenchCommands.js
 * (`wireSendToAgent`): imported here, they would bring the whole terminal
 * view into every module that offers Send to Agent (the Explorer's suites
 * draw it with stand-in stores).
 */
import { useTerminalStore } from '../stores/terminalStore.js';
import { useEditorStore } from '../stores/editorStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useToastStore } from '../stores/toastStore.js';
import { displayTitle } from './tabTitle.js';
import { agentLabel } from './terminalStatus.js';
import {
  NO_AGENT_REASON,
  NO_EDITOR_FILE_REASON,
  SAVE_FIRST_REASON,
  SEND_FILE_TITLE,
  SEND_SELECTION_TITLE,
  agentTerminals,
  editorSendProblem,
  notSentText,
  referenceForPath,
  referenceForSelection,
  referencePathProblem,
  targetChoice,
} from './agentReference.js';

/** The palette mode that lists the agent terminals to choose from. */
export const SEND_TO_AGENT_MODE = 'send-to-agent';

/** The terminal tab ids, the most recently focused first; none until the switcher's are handed in. */
let recentSource = () => [];
/** Give the terminal on screen the keyboard; nothing until it is handed in. */
let focusSource = () => false;

/**
 * Read the recency from `recent` (tabSwitcherStore.js's `recentTerminalTabs`)
 * and focus the terminal with `focus` (workspaceFocus.js's `focusTerminal`).
 * Returns the undo.
 */
export function wireSendToAgent({ recent = null, focus = null } = {}) {
  const previous = { recentSource, focusSource };
  recentSource = typeof recent === 'function' ? recent : () => [];
  focusSource = typeof focus === 'function' ? focus : () => false;
  return () => {
    ({ recentSource, focusSource } = previous);
  };
}

/** The editor focused last: `{ editor, pathOf }`, or null. */
let lastEditor = null;
/** The reference waiting for the user to pick a terminal, or null. */
let pending = null;

const showError = (reason) => useToastStore.getState().show({ kind: 'error', text: notSentText(reason) });

/**
 * Keep `editor` (a Monaco editor) as the one whose selection Send Selection
 * to Agent reads while it is the editor focused last; `pathOf()` is the file
 * it shows now. Let go when it is disposed.
 */
export function trackAgentEditor(editor, pathOf) {
  if (!editor) return;
  const entry = { editor, pathOf };
  if (!lastEditor) lastEditor = entry;
  editor.onDidFocusEditorWidget?.(() => {
    lastEditor = entry;
  });
  editor.onDidDispose?.(() => {
    if (lastEditor === entry) lastEditor = null;
  });
}

/** The ids of the actions `addAgentEditorActions` gives each Monaco editor. */
export const SEND_SELECTION_ACTION_ID = 'nexterm.sendSelectionToAgent';
export const SEND_FILE_ACTION_ID = 'nexterm.sendFileToAgent';

/**
 * The editor's context menu entries, Send Selection to Agent and Send File
 * to Agent, for `editor` (a Monaco editor) showing the file `pathOf()`.
 * No keybinding of their own: the commands are rebound in Settings ▸
 * Keyboard (keybindings.js). Monaco's menu cannot say why an entry is
 * greyed out, so they are always offered and say it in an error toast.
 */
export function addAgentEditorActions(editor, pathOf) {
  if (typeof editor?.addAction !== 'function') return [];
  return [
    editor.addAction({
      id: SEND_SELECTION_ACTION_ID,
      label: SEND_SELECTION_TITLE,
      contextMenuGroupId: '9_nexterm_agent',
      contextMenuOrder: 1,
      run: (ed) => sendSelectionToAgent(ed ?? editor, pathOf()),
    }),
    editor.addAction({
      id: SEND_FILE_ACTION_ID,
      label: SEND_FILE_TITLE,
      contextMenuGroupId: '9_nexterm_agent',
      contextMenuOrder: 2,
      run: (ed) => sendFileToAgent(pathOf(), ed ?? editor),
    }),
  ];
}

/** The terminals Send to Agent may type into now, the most recently focused first. */
export function agentTargetsNow(state = useTerminalStore.getState()) {
  let recent = [];
  try {
    recent = recentSource() ?? [];
  } catch (_) {
    recent = [];
  }
  return agentTerminals(state.tabs, recent);
}

/**
 * The editor tab showing `path` as text, or — with no path — the active one
 * when it does. Never a preview tab — any tab with a `kind`, an image or a
 * Markdown preview (`isPreviewTab` in editorStore.js, not imported: the
 * Explorer's and the palette's suites draw this with a stand-in store): it
 * has no lines to select and no buffer to check, and a README's preview
 * listed before its modified text tab let the file go out as if it were
 * saved. A preview active is no file open in the editor.
 */
function editorTabOf(path = null) {
  const { tabs, activeTabId } = useEditorStore.getState();
  const list = (Array.isArray(tabs) ? tabs : []).filter((t) => t && t.kind == null);
  if (path) return list.find((t) => t.filePath === path) ?? null;
  return list.find((t) => t.id === activeTabId) ?? null;
}

/**
 * The editor tab a given `editor` shows, strictly by its `path` — never the
 * active tab in its place: an untitled buffer's lines went out under another
 * pane's file name (review B-R3) — and why it cannot be sent, `{ tab,
 * problem }`. No model shown: NO_EDITOR_FILE_REASON; no path (an untitled
 * buffer): SAVE_FIRST_REASON.
 */
function shownEditorFile(editor, path) {
  if (typeof editor?.getModel === 'function' && !editor.getModel()) return { tab: null, problem: NO_EDITOR_FILE_REASON };
  if (!path) return { tab: null, problem: SAVE_FIRST_REASON };
  const tab = editorTabOf(path);
  return { tab, problem: editorSendProblem(tab) };
}

/** The active editor file, and the selection of the editor showing it when that is the one focused last. */
function activeEditorSelection() {
  const tab = editorTabOf();
  if (!tab) return { tab: null, selection: null };
  const editor = lastEditor && lastEditor.pathOf?.() === tab.filePath ? lastEditor.editor : null;
  return { tab, selection: editor?.getSelection?.() ?? null };
}

/**
 * Why the palette's two commands cannot send now, or null each when they
 * can: `{ selection, file }`. The terminal first — with none, nothing can be
 * sent — then the file: none open, modified or untitled.
 */
export function sendCommandState() {
  if (agentTargetsNow().length === 0) return { selection: NO_AGENT_REASON, file: NO_AGENT_REASON };
  const { tab, selection } = activeEditorSelection();
  const file = editorSendProblem(tab);
  return { file, selection: file ?? (selection ? null : 'Select lines in the editor first') };
}

/** Why the Explorer's Send to Agent cannot send `path`, or null when it can. */
export function explorerSendProblem(path) {
  if (agentTargetsNow().length === 0) return NO_AGENT_REASON;
  const problem = referencePathProblem(path);
  return problem ? `Cannot be sent: ${problem}` : null;
}

/** Type `text` into `tabId` (the store's checks), and give that terminal the keyboard once it is typed. */
async function deliver(tabId, text) {
  const outcome = await useTerminalStore.getState().typeAgentReference(tabId, text);
  if (outcome?.status === 'typed') {
    useSettingsStore.getState().setActiveView?.('terminal');
    const focus = () => {
      try {
        focusSource();
      } catch (_) {
        // No page to focus in (the suites).
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else focus();
  }
  return outcome;
}

/**
 * Send `reference` (`{ text }` or `{ error }`): refused with an error toast
 * when there is no text or no agent terminal, typed into the one there is,
 * or — with several — the palette opens on the list to choose from.
 */
export async function sendReference(reference) {
  if (!reference || reference.error || !reference.text) {
    showError(reference?.error ?? 'there is nothing to send');
    return { status: 'refused' };
  }
  const choice = targetChoice(agentTargetsNow());
  if (choice.kind === 'none') {
    showError(choice.reason);
    return { status: 'none' };
  }
  if (choice.kind === 'one') return deliver(choice.tabId, reference.text);
  pending = { text: reference.text };
  useSettingsStore.getState().setCommandPaletteOpen(true, SEND_TO_AGENT_MODE);
  return { status: 'pick' };
}

/** What the palette's pick lists: the text waiting and the agent terminals, most recent first. */
export function pendingAgentPick() {
  if (!pending) return { text: null, targets: [] };
  const targets = agentTargetsNow().map((tab) => ({
    tabId: tab.id,
    title: displayTitle(tab),
    agent: agentLabel(tab),
    cwd: tab.cwd ?? '',
  }));
  return { text: pending.text, targets };
}

/** The palette's pick chose `tabId`: the reference waiting is typed there. */
export async function sendPendingTo(tabId) {
  const waiting = pending;
  pending = null;
  if (!waiting) return { status: 'refused' };
  return deliver(tabId, waiting.text);
}

/** The pick was closed without a choice: nothing waits any more. */
export function forgetPendingSend() {
  pending = null;
}

/**
 * Send Selection to Agent: the lines selected in `editor` (by default the
 * editor focused last), in the file it shows (`path`). Greyed out — said in
 * an error toast — for no file, a modified or an untitled one.
 */
export async function sendSelectionToAgent(editor = null, path = null) {
  const shown = editor ? { ...shownEditorFile(editor, path), selection: editor.getSelection?.() ?? null } : activeEditorSelection();
  if (agentTargetsNow().length === 0) return sendReference({ error: NO_AGENT_REASON });
  const problem = editor ? shown.problem : editorSendProblem(shown.tab);
  if (problem) return sendReference({ error: problem });
  return sendReference(referenceForSelection(shown.tab.filePath, shown.selection));
}

/**
 * Send File to Agent: the file `path` shows in the editor (by default the
 * active editor tab's). From a given `editor` (its context menu) it is that
 * editor's file, strictly, as for a selection (`shownEditorFile`).
 */
export async function sendFileToAgent(path = null, editor = null) {
  const shown = editor ? shownEditorFile(editor, path) : { tab: editorTabOf(path) };
  if (agentTargetsNow().length === 0) return sendReference({ error: NO_AGENT_REASON });
  const problem = editor ? shown.problem : editorSendProblem(shown.tab);
  if (problem) return sendReference({ error: problem });
  return sendReference(referenceForPath(shown.tab.filePath));
}

/** The Explorer's Send to Agent: a file or a folder, as it is on disk. */
export async function sendPathToAgent(path) {
  return sendReference(referenceForPath(path));
}
