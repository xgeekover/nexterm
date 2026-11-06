/**
 * The run dialog of a project command (spec D7), as plain data: where the
 * line can be typed, for which shell it is quoted there, why a terminal
 * cannot take it, and what a key means in the dialog.
 *
 * Kept out of the component so the rules can be held by the Node suites,
 * which never mount one: which terminal is offered and why one is not, the
 * shell a new split would get — and so the quoting the preview shows — and
 * that a held Enter, or one pressed before the line could be read, runs
 * nothing.
 *
 * Pure: no React, no stores.
 */
import { shellKindFor } from './dropPaths.js';
import { displayText, shellLabel } from './projectCommands.js';
import { splitStartFor } from './terminalCwd.js';
import { shellPathOf } from './terminalFileDrop.js';

/**
 * Why "This terminal" cannot take the line — each short, said on the
 * option's one line and under the buttons. The store gives the same words
 * when it refuses right before typing (`projectCommandBlock`).
 */
export const BUSY_REASON = 'something is running in it';
export const EXITED_REASON = 'its shell has exited';
export const GONE_REASON = 'that terminal has closed';
export const RESTARTED_REASON = 'its shell was restarted since this opened';
/** A shell that never said where its prompt is (no OSC 133: fish, sh, WSL, an unknown one): nothing tells whether it is busy. */
export const UNTOLD_REASON = 'NexTerm cannot tell what runs in this terminal';
/** Text at the prompt: the line would be typed onto the end of it, and run with it. */
export const TYPED_REASON = 'something is typed at its prompt — clear it, or use New split';
/** The line was edited with keys NexTerm cannot follow (arrows, Tab, history): what is there is not known. */
export const UNKNOWN_LINE_REASON = 'NexTerm cannot tell what is typed at its prompt — press Enter or Ctrl+C there first, or use New split';
/** A line was submitted and the shell has neither started it nor drawn a new prompt — it may be waiting for the rest (`dquote>`). */
export const PENDING_REASON = 'the shell has not shown a new prompt since the last line — it may be waiting for the rest of it; press Enter or Ctrl+C there first, or use New split';

/**
 * Why a terminal already open is given the line without its Enter (review
 * round 3): what its shell still holds — keys typed while a command ran, the
 * rest of a line it waits for — cannot be known from outside it. Typed and
 * left at the prompt, the line is on screen with whatever is there, and the
 * Enter is the user's.
 */
export const TYPE_ONLY_NOTE =
  'In a terminal that is already open the line is typed and left for you to press Enter — NexTerm cannot be sure its prompt is empty.';

/** What the busy reason means, said in full where there is room (the option's tooltip). */
export const BUSY_DETAIL = "Something is running in this terminal — an agent, a server. Typed there, the line would be that program's input, not a command.";

/**
 * How long after the dialog opens a press of Run, Type Only or Enter is
 * not taken: the line has not been read yet. ConfirmDialog's
 * BACKDROP_GRACE_MS, for the keyboard too — two quick Enters, one choosing
 * the command and one by habit, ran a line nobody had seen.
 */
export const ACTIVATION_GRACE_MS = 500;

/** Whether a Run (or Type Only) pressed at `now` counts, for a dialog opened at `openedAt`. */
export function activationCounts(openedAt, now) {
  return typeof openedAt === 'number' && now - openedAt >= ACTIVATION_GRACE_MS;
}

/**
 * How long after a field's IME composition ends an Enter is the composition's
 * own. Chrome on Windows sends one Enter that commits a Hangul syllable as a
 * keydown 229 and then a plain keydown 13: the second is the commit, not a
 * Run, and the field's value may not hold the syllable yet.
 */
export const COMPOSITION_ENTER_MS = 100;

/**
 * The shell a spec names, as the backend starts it: `default` (and
 * `login-shell`) is the system's own shell — `resolve_shell` in
 * src-tauri/src/pty/manager.rs — so it is named, and quoted for, as that
 * shell. The real backend reports the resolved path for a terminal it
 * started; a spec that still says `default` (a setting, the browser mock)
 * is taken the same way here.
 */
export function resolvedShellPath(spec, systemShell = null) {
  if (typeof spec !== 'string') return spec ?? null;
  const name = spec.trim().replace(/^"(.*)"$/su, '$1').split(/[\\/]/u).pop().toLowerCase();
  return (name === 'default' || name === 'login-shell') && systemShell ? systemShell : spec;
}

/**
 * The terminal the dialog is about, pinned as it opens: the active terminal
 * then, by tab and by shell session — `{ tabId, sessionId }`, or null with no
 * terminal at all. The dialog types into that terminal or splits beside it,
 * never into whichever happens to be active by the time Run is pressed: a
 * chord or a menu could make another one active behind the dialog.
 */
export function pinTarget(state) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  const active = tabs.find((t) => t.id === state?.activeTabId) ?? null;
  return active ? { tabId: active.id, sessionId: active.sessionId ?? null } : null;
}

/**
 * What the run dialog needs of the terminal store about its pinned terminal,
 * as primitives only, so a component can select it with `useShallow` and be
 * drawn again when one of them changes — not on every write to a store that
 * changes many times a second. `block` is the store's own word on whether
 * the line may be typed there now (`projectCommandBlock`), asked of the store
 * passed in.
 */
export function runTargetView(state, pinned) {
  if (!pinned?.tabId) return { pinnedId: null };
  const tab = (Array.isArray(state?.tabs) ? state.tabs : []).find((t) => t.id === pinned.tabId) ?? null;
  return {
    pinnedId: pinned.tabId,
    exists: Boolean(tab),
    sameSession: Boolean(tab) && (pinned.sessionId == null || tab.sessionId === pinned.sessionId),
    title: tab ? String(tab.title || tab.defaultTitle || '') : null,
    shell: typeof tab?.shell === 'string' ? tab.shell : null,
    cwd: typeof tab?.cwd === 'string' ? tab.cwd : null,
    running: Boolean(tab?.running),
    exited: Boolean(tab?.exited),
    block: tab && typeof state?.projectCommandBlock === 'function' ? state.projectCommandBlock(tab.id) ?? null : null,
  };
}

/**
 * Where a project command can be typed, from `runTargetView`'s answer and
 * the settings and system it is read against:
 *
 *   this    the pinned terminal — `{ tabId, title, busy, shellPath, kind,
 *           label }`, `busy` saying why it cannot take the line now (gone,
 *           restarted, exited, running something, a shell that says nothing
 *           of its prompt, text at its prompt), else null. Null with no
 *           terminal.
 *   split   a new split beside it — `{ shellPath, kind, label, busy }`: the
 *           shell `splitStartFor` gives it, so the preview is quoted for the
 *           shell the line will meet; `busy` when the terminal to split from
 *           has gone. Null with no terminal.
 *   newTab  a new terminal — only when there was no terminal at all.
 *   initial the choice the dialog opens with: the new split whenever there
 *           is one — a fresh shell, where the line can be run — else this
 *           terminal, else a new terminal. Into this terminal the line is
 *           only ever typed, never run (TYPE_ONLY_NOTE).
 */
export function runTargets(view, { defaultShell = null, systemShell = null, os = null, splitCwd = 'inherited' } = {}) {
  const shellOf = (tab) => {
    const shellPath = resolvedShellPath(shellPathOf(tab, { defaultShell, systemShell }), systemShell);
    const kind = shellKindFor(shellPath, os);
    return { shellPath, kind, label: shellLabel(kind, shellPath ?? '') };
  };
  if (!view?.pinnedId) {
    return { this: null, split: null, newTab: { ...shellOf(null), busy: null }, initial: 'new-tab' };
  }
  const busy = !view.exists
    ? GONE_REASON
    : !view.sameSession
      ? RESTARTED_REASON
      : view.exited
        ? EXITED_REASON
        : view.running
          ? BUSY_REASON
          : view.block ?? null;
  const start = splitStartFor({ shell: view.shell, cwd: view.cwd }, { mode: splitCwd, os });
  return {
    this: {
      tabId: view.pinnedId,
      title: displayText(view.title ?? '', 40) || 'Terminal',
      busy,
      ...shellOf({ shell: view.shell }),
    },
    split: { ...shellOf({ shell: start.shell }), busy: view.exists ? null : 'the terminal it would split beside has closed' },
    newTab: null,
    initial: view.exists ? 'split' : 'this',
  };
}

/** The target `choice` names: `{ shellPath, kind, label, busy, … }`, or null. */
export function targetShell(targets, choice) {
  if (choice === 'this') return targets?.this ?? null;
  if (choice === 'split') return targets?.split ?? null;
  if (choice === 'new-tab') return targets?.newTab ?? null;
  return null;
}

/**
 * What a key means to the run dialog, given where it was pressed — 'button'
 * (one of its buttons), 'field' (a value, a choice, the target) or 'other':
 *
 *   'pass'      not the dialog's; left to what has focus — typing, arrows
 *   'cancel'    Escape
 *   'run'       Enter in a field: Run, when the line can be typed
 *   'next' / 'previous'  Tab and Shift+Tab, kept inside the dialog
 *   'swallow'   kept from everything, nothing done
 *
 * Enter on a button is that button's (the native button answers it), so
 * Enter on Cancel cancels and on Type Only types without Enter. A key held
 * from before — the Enter that chose the command, still down — is not a
 * press: a repeat of Enter runs nothing, wherever it lands, and a repeated
 * Space does not arm a button. Enter with a modifier is not Run either. A
 * key that is part of an IME composition (Korean typed into a field)
 * belongs to the composition — and so does the plain Enter Chrome sends
 * right after one ends (`msSinceCompositionEnd` under COMPOSITION_ENTER_MS).
 */
export function runDialogKey(e, where, { msSinceCompositionEnd = Infinity } = {}) {
  if (e.isComposing || e.keyCode === 229) return 'pass';
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Tab') {
    if (e.ctrlKey || e.altKey || e.metaKey) return 'pass';
    return e.shiftKey ? 'previous' : 'next';
  }
  if (e.key === 'Enter') {
    if (e.repeat) return 'swallow';
    if (where === 'button') return 'pass';
    if (where === 'field' && msSinceCompositionEnd < COMPOSITION_ENTER_MS) return 'swallow';
    if (where === 'field' && !(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) return 'run';
    return 'swallow';
  }
  if (e.key === ' ' && e.repeat && where === 'button') return 'swallow';
  return 'pass';
}

/** `reason` as a sentence: its first letter capitalised. */
export function asSentence(reason) {
  const text = String(reason ?? '');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}
