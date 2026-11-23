/**
 * Send to Agent (bundle 4, A4): what is typed into a terminal running Claude
 * Code or OpenCode for a file, a folder or the lines selected in the editor,
 * and which terminal it goes to. Pure: the store types it
 * (`typeAgentReference` in terminalStore.js) and src/lib/sendToAgent.js wires
 * the entry points.
 *
 * WHAT IS TYPED. An `@` reference, the form Claude Code documents for
 * including a file or a folder ("Use @ to quickly include files or
 * directories"; "File paths can be relative or absolute"), always with the
 * ABSOLUTE path: the terminal's folder (OSC 7) is the shell's, and is stale
 * while an agent runs. Claude Code documents no line-range syntax, so none is
 * invented: a selection is named in plain words after the reference —
 * `@/a/b.js (lines 10-20) ` — and never as `#L10-20`. A space ends the
 * reference, so the user can go on typing the question.
 *
 * NOT SENT. A path holding a space or another blank, or a control character:
 * quoting inside an `@` reference is not documented, and a blank would end it
 * early. Typed as a paste (bracketed when the program asked for it), never
 * followed by Enter: what is sent, and when, is the user's to decide.
 */
import { encodeText } from './controlKeys.js';
import { agentLabel, agentRuns } from './terminalStatus.js';

/** The command titles (Command Palette, Settings ▸ Keyboard, the editor's menu). */
export const SEND_SELECTION_TITLE = 'Send Selection to Agent';
export const SEND_FILE_TITLE = 'Send File to Agent';
/** The Explorer row item, for a file or a folder. */
export const SEND_TO_AGENT_LABEL = 'Send to Agent';

/** Why every Send to Agent item is greyed out: no terminal to send to. */
export const NO_AGENT_REASON = 'No terminal is running Claude Code or OpenCode';
/** Why the editor's items are greyed out for a modified or untitled file. */
export const SAVE_FIRST_REASON = 'Save the file first: the agent reads it from disk';
/** Why the editor's items are greyed out with no file in the editor. */
export const NO_EDITOR_FILE_REASON = 'No file is open in the editor';

/** The Command Palette pick, when several terminals run an agent. */
export const PICK_AGENT_LABEL = 'send to';

const BLANK = /\s/u;
// C0, DEL and C1: never part of a path that is typed into a terminal.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** Whether `path` is absolute: `/a`, `C:\a`, `C:/a` or a UNC `\\server\share`. */
export function isAbsolutePath(path) {
  if (typeof path !== 'string' || path === '') return false;
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Why `path` cannot be sent as an `@` reference, in words, or null when it can. */
export function referencePathProblem(path) {
  if (typeof path !== 'string' || path === '') return 'there is no path to send';
  if (CONTROL.test(path)) return 'the path holds a control character';
  if (BLANK.test(path)) return 'the path holds a space or another blank, and an @ reference cannot quote one';
  if (!isAbsolutePath(path)) return 'only an absolute path is sent';
  return null;
}

/**
 * The first and last line a Monaco selection covers, 1-based, in order. A
 * selection that ends at column 1 of a line — a whole-line drag, Shift+Down —
 * does not include that line. An empty selection is its caret's line.
 */
export function selectionLines(selection) {
  const a = Number(selection?.startLineNumber);
  const b = Number(selection?.endLineNumber);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) return null;
  const start = Math.min(a, b);
  let end = Math.max(a, b);
  const endColumn = a <= b ? Number(selection?.endColumn) : Number(selection?.startColumn);
  if (end > start && endColumn === 1) end -= 1;
  return { start, end };
}

/** The words after a reference for `lines`: `(lines 10-20)` or `(line 12)`. */
export function linesText({ start, end }) {
  return start === end ? `(line ${start})` : `(lines ${start}-${end})`;
}

/** `{ text }`, the reference to a file or a folder — `@<absolute path> ` — or `{ error }` saying why not. */
export function referenceForPath(path) {
  const problem = referencePathProblem(path);
  if (problem) return { error: problem };
  return { text: `@${path} ` };
}

/** `{ text }`, the reference to the lines `selection` covers in file `path` — `@<path> (lines A-B) ` — or `{ error }`. */
export function referenceForSelection(path, selection) {
  const problem = referencePathProblem(path);
  if (problem) return { error: problem };
  const lines = selectionLines(selection);
  if (!lines) return { error: 'there is no selection to send' };
  return { text: `@${path} ${linesText(lines)} ` };
}

/**
 * Why the editor's items cannot send `tab`'s file (an editorStore tab), or
 * null when they can: no file, a modified one or one with no file on disk
 * (untitled) is greyed out — the agent reads the file from disk, not the
 * editor's buffer.
 */
export function editorSendProblem(tab) {
  if (!tab) return NO_EDITOR_FILE_REASON;
  if (tab.isDirty || !isAbsolutePath(tab.filePath)) return SAVE_FIRST_REASON;
  return null;
}

/**
 * The terminals Send to Agent may type into: those running an agent this
 * build knows (`agentRuns`, `agentLabel`: Claude Code or OpenCode) whose
 * shell has not exited — the most recently focused first, in `recentIds`'
 * order (tabMru.js's `switcherOrder`), then any other in `tabs`' order.
 */
export function agentTerminals(tabs, recentIds = []) {
  const running = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab && !tab.exited && agentRuns(tab) && agentLabel(tab) !== '');
  const rank = new Map();
  for (const id of Array.isArray(recentIds) ? recentIds : []) if (!rank.has(id)) rank.set(id, rank.size);
  return running
    .map((tab, at) => ({ tab, at }))
    .sort((x, y) => (rank.get(x.tab.id) ?? Infinity) - (rank.get(y.tab.id) ?? Infinity) || x.at - y.at)
    .map(({ tab }) => tab);
}

/**
 * Where a reference goes, from `targets` (`agentTerminals`): `{ kind: 'none',
 * reason }` with none, `{ kind: 'one', tabId }` with one, `{ kind: 'pick',
 * tabIds }` — the most recent first — with several.
 */
export function targetChoice(targets) {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return { kind: 'none', reason: NO_AGENT_REASON };
  if (list.length === 1) return { kind: 'one', tabId: list[0].id };
  return { kind: 'pick', tabIds: list.map((tab) => tab.id) };
}

/**
 * `{ data }`, `text` as it is typed: as a paste — between the bracketed-paste
 * markers when the program turned bracketed paste on, plain otherwise —
 * checked by `encodeText` (no control or direction character), and never
 * with a CR or LF: Enter is the user's. `{ error }` when it cannot be typed.
 */
export function referencePaste(text, { bracketedPaste = false } = {}) {
  if (typeof text !== 'string' || /[\r\n]/.test(text)) return { error: 'a reference is one line' };
  const encoded = encodeText(text, { bracketedPaste });
  if (encoded.error) return { error: encoded.error.message };
  if (/[\r\n]/.test(encoded.data)) return { error: 'a reference is one line' };
  return { data: bracketedPaste ? `\x1b[200~${encoded.data}\x1b[201~` : encoded.data };
}

/** Why typing into the target was refused (`typeAgentReference`'s status), in words. */
export function refusalReason(status, reason = null) {
  switch (status) {
    case 'hidden':
      return 'that terminal is asking for a password, and typing there is hidden';
    case 'starting':
      return 'the shell in that terminal has not drawn its first prompt yet — try again in a moment';
    case 'exited':
      return 'the shell in that terminal has exited';
    case 'gone':
      return 'that terminal has closed';
    case 'read-only':
      return 'that terminal is read-only — turn read-only off there first';
    case 'never-shown':
      return 'that terminal has not been shown yet, so what it is asking for cannot be checked — open it once first';
    case 'no-agent':
      return 'Claude Code or OpenCode no longer runs in that terminal';
    case 'late':
      return 'it took too long';
    default:
      return reason || 'it could not be typed';
  }
}

/** The error toast: nothing was typed, and why. */
export function notSentText(reason) {
  return `Not sent: ${reason}`;
}

/** The confirm toast: what was typed, and where — and that Enter was not pressed. */
export function sentText(text, where) {
  return `Typed ${String(text ?? '').trim()} into ${where} — Enter not pressed`;
}
