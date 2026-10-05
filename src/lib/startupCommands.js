/**
 * Startup commands: what turns a saved group into a layout template.
 *
 * tmuxinator's idea — open a project and the dev server, the test watcher and
 * the agent start at once. A saved group (and a saved workspace, which is
 * every group at once) may give each of its terminals a command, kept on the
 * terminal's slot as `command`. When it is opened, each new terminal types its
 * command as soon as its shell is ready, the way an agent is started
 * (`typeStartupCommand` in terminalStore.js, which waits exactly as
 * `startAgent` does). A slot with no command is just a shell, which is all a
 * saved group ever was.
 *
 * The command is the user's own text, typed into their own shell — exactly
 * what they could type themselves, and nothing is quoted or rewritten for a
 * shell. What is enforced is the line: a startup command is ONE line, typed
 * and then run with one Enter, and nothing in it may do what a key would do
 * instead of being text.
 *
 * Pure: no React, no stores.
 */
import { NEW_LINE, trackInput } from './suggestionLayer.js';
import { submitsLine } from './tabActivity.js';
import { AGENTS } from './agents.js';

/** Line breaks of every kind. Any of them inside a command would run what comes before it. */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

/**
 * Control characters: C0 (a tab aside, handled first), DEL and C1.
 *
 * Typed into a line editor these are keys, not text: ESC starts a key
 * sequence — or ends a bracketed paste early — ^U and ^W erase, ^O runs the
 * line in bash, ^C abandons it. The one a command line needs, the Enter that
 * runs it, is added when it is typed (`\r`), never stored.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g;

/**
 * Bidirectional overrides and isolates. Not keys, but they make a command
 * read differently from what it runs ("Trojan Source"), and a startup command
 * is run without anyone looking at it.
 */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

export const MULTI_LINE_REASON =
  'A startup command is one line — it is typed into the shell and run with one Enter. Join several with && or ;, or put them in a script.';

/**
 * What `value` is as a startup command.
 *
 * Returns `{ ok: true, command }` — `command` is '' for "just a shell" — or
 * `{ ok: false, reason }` for something that cannot be one: more than one
 * line. Text around the line is trimmed first, so a pasted command that kept
 * its trailing newline is still one line. A tab becomes a space: typed into a
 * shell it would complete rather than insert itself. Every other control
 * character, and every bidirectional override, is dropped.
 *
 * Anything that is not a string is "nothing": a hand-edited file is read as
 * having no command rather than refused whole.
 */
export function sanitizeStartupCommand(value) {
  if (typeof value !== 'string') return { ok: true, command: '' };
  const text = value.trim();
  if (LINE_BREAK.test(text)) return { ok: false, reason: MULTI_LINE_REASON };
  const command = text.replace(/\t/g, ' ').replace(CONTROL, '').replace(BIDI, '').trim();
  return { ok: true, command };
}

/** Whether pasted `text` would be more than one line once trimmed (see `sanitizeStartupCommand`). */
export function isMultiLine(text) {
  return typeof text === 'string' && LINE_BREAK.test(text.trim());
}

/**
 * The command a saved terminal slot runs when it opens: its own, cleaned —
 * or '' when it has none, or one that is not a single line. Read this way
 * every time a slot comes off disk or is about to be typed, so that a file
 * edited by hand, or written by another build, can never put more than one
 * line on a shell.
 */
export function startupCommandOf(slot) {
  const result = sanitizeStartupCommand(slot?.command);
  return result.ok ? result.command : '';
}

/**
 * A slot as it should be kept: `command` cleaned, or gone when there is none
 * (a slot without one is exactly the shape every saved group had before).
 */
export function normalizeSlotCommand(slot) {
  if (!slot || typeof slot !== 'object' || !('command' in slot)) return slot;
  const command = startupCommandOf(slot);
  const { command: _raw, ...rest } = slot;
  return command ? { ...rest, command } : rest;
}

/**
 * The startup command a terminal offers when its group is saved — the default
 * the template starts with, which "Edit Startup Commands…" can change:
 *
 *  1. the command it was itself opened with, from a template: saving again
 *     keeps the template's choice, whatever the terminal ran since;
 *  2. an agent NexTerm started there and is still running — as the plain
 *     command (`claude`, `opencode`), which starts a conversation. The line
 *     NexTerm typed carries the session id, and `--session-id` with an id
 *     already in use is an error;
 *  3. the command running in it right now, as typed at the prompt;
 *  4. nothing.
 *
 * Deliberately NOT the last command of an idle shell. A finished command —
 * `git push`, `rm -rf dist` — is what the terminal did, not what it is for, and
 * opening the template would run it again without anyone asking.
 */
export function suggestStartupCommand(tab) {
  if (!tab || typeof tab !== 'object') return '';
  const own = sanitizeStartupCommand(tab.startupCommand);
  if (own.ok && own.command) return own.command;
  if (tab.exited) return '';
  const agent = tab.agent && !tab.agentResumeOffered ? AGENTS[tab.agent.kind] : null;
  if (agent) return agent.command;
  if (tab.running) {
    const running = sanitizeStartupCommand(tab.commandLine);
    if (running.ok && running.command) return running.command;
  }
  return '';
}

/**
 * Follow what is written to a terminal, to know the command line it submits.
 *
 * `line` is the line so far (the suggestion layer's own shape, `NEW_LINE` to
 * start), `data` one write — a key, a paste, or a whole line the app types.
 * Returns the next `line` and `submitted`:
 *
 *   undefined  nothing was submitted at the prompt
 *   string     a line was, and this is it
 *   null       a line was, and what it says cannot be known — edited with an
 *              arrow, completed with Tab, recalled from history
 *
 * The keys are followed by `trackInput`, the suggestion layer's rules for the
 * same guess. A whole line written at once and ended with Enter is what the
 * app types — an agent, a startup command — or a paste the shell is not
 * bracketing, and its text is what runs. While a program has the keyboard
 * (`running`), nothing typed is a command line.
 */
export function followCommandLine(line, data, { running = false } = {}) {
  const current = line && typeof line.buffer === 'string' ? line : NEW_LINE;
  if (typeof data !== 'string' || data === '') return { line: current, submitted: undefined };
  if (running) return { line: trackInput(current, data, { running }).line, submitted: undefined };

  if (data.length > 1 && submitsLine(data) && !/[\x00-\x1f\x7f]/.test(data.slice(0, -1))) {
    const text = current.tracked ? `${current.buffer}${data.slice(0, -1)}`.trim() : '';
    return { line: NEW_LINE, submitted: text || (current.tracked ? undefined : null) };
  }

  const { line: next, record } = trackInput(current, data, { running });
  const enter = data === '\r' || data === '\n';
  if (!enter) return { line: next, submitted: undefined };
  // An empty Enter submits nothing; an untracked one submits a line nobody
  // can read back.
  if (record) return { line: next, submitted: record };
  return { line: next, submitted: current.tracked ? undefined : null };
}

/**
 * A saved group (or one group of a saved workspace) with its terminals'
 * startup commands set from `commands` — slot id → text. A slot `commands`
 * does not mention keeps what it had; '' clears it.
 *
 * All or nothing: when any command is not a single line, nothing changes and
 * the reasons come back by slot id, for the dialog to show beside each field.
 *
 * @returns {{ ok: true, snapshot } | { ok: false, errors: Record<string, string> }}
 */
export function withStartupCommands(snapshot, commands = {}) {
  const errors = {};
  const given = commands && typeof commands === 'object' ? commands : {};
  const tabs = (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).map((slot) => {
    if (!slot || typeof slot.slotId !== 'string' || !Object.prototype.hasOwnProperty.call(given, slot.slotId)) {
      return slot;
    }
    const result = sanitizeStartupCommand(given[slot.slotId]);
    if (!result.ok) {
      errors[slot.slotId] = result.reason;
      return slot;
    }
    const { command: _old, ...rest } = slot;
    return result.command ? { ...rest, command: result.command } : rest;
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, snapshot: { ...snapshot, tabs } };
}

/** How many of a saved group's terminals run something when it opens. */
export function startupCount(snapshot) {
  return (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).filter((slot) => startupCommandOf(slot)).length;
}
