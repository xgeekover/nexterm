/**
 * The terminal's inline suggestion layer, decided here and drawn by
 * TerminalView.jsx.
 *
 * Pure: no React, no xterm, no stores. The view reads the facts (is a program
 * running, is the alternate buffer up, is a Korean syllable still being
 * composed) and hands them in, so every rule is checked in Node
 * (tests/adversarial/suggestion_layer.test.js).
 *
 * The layer is a guess at the shell's input line, built from the bytes typed
 * into the terminal. Each rule below exists because the guess went wrong in a
 * way somebody saw:
 *
 *   - Inside a running program — Claude Code, a REPL, vim — what is typed is
 *     not a shell command. The layer drew `git status` over Claude's input,
 *     ate its Tab, Esc and arrows, typed history into it with →, and recorded
 *     `git stfixplease refactor the auth module` as a command. While a program
 *     runs (OSC 133 "C" until "D") or the alternate buffer is up, nothing is
 *     ranked, drawn or intercepted, and Enter records nothing.
 *   - A key the layer takes never reaches the program, so after it the guess
 *     can no longer be trusted: the line is dropped (see `lineAfterKey`).
 *   - A key the layer cannot follow — Tab completion, an arrow, Esc, ^U —
 *     changes the line in ways the bytes do not say. The line is dropped too,
 *     rather than recording `git che` + `main` as `git chemain`.
 *
 * A dropped line is untracked until the next one starts (Enter, ^C, or the
 * shell's own end-of-command marker): nothing is ranked or recorded for it.
 */
import { completionFor } from './commandIndex.js';

/** A fresh input line, followed from its first key. */
export const NEW_LINE = Object.freeze({ buffer: '', tracked: true });

/** A line the layer has lost track of: nothing is suggested or recorded for it. */
export const LOST_LINE = Object.freeze({ buffer: '', tracked: false });

/**
 * Whether the layer may rank or draw anything at all right now.
 *
 * `composing`: a Korean syllable is still being composed (see
 * hangulInlineIme.js) and its preview sits where a ghost would go.
 */
export function suggestionsAllowed({ enabled = true, running = false, alternate = false, composing = false } = {}) {
  return Boolean(enabled) && !running && !alternate && !composing;
}

/**
 * Follow one chunk of typed input (xterm's `onData`).
 *
 * Returns the new `line`, the command to `record` (or null), and whether to
 * `rank` suggestions for the new line — when false the caller clears them.
 */
export function trackInput(line, data, { running = false } = {}) {
  const current = line && typeof line.buffer === 'string' ? line : NEW_LINE;
  if (!data) return { line: current, record: null, rank: false };

  // A program owns the keyboard: nothing typed here is a shell command, and
  // nothing typed here may feed the next prompt's line either.
  if (running) return { line: LOST_LINE, record: null, rank: false };

  if (data.length > 1) {
    // A paste or a finished IME syllable. One line of plain text extends the
    // line; anything with a newline or a control byte in it — an arrow key's
    // escape sequence included — cannot be followed.
    if (/[\x00-\x1f\x7f]/.test(data)) return { line: LOST_LINE, record: null, rank: false };
    if (!current.tracked) return { line: current, record: null, rank: false };
    return { line: { buffer: current.buffer + data, tracked: true }, record: null, rank: true };
  }

  switch (data) {
    case '\r':
    case '\n': {
      const command = current.tracked ? current.buffer.trim() : '';
      return { line: NEW_LINE, record: command || null, rank: false };
    }
    case '\x7f':
    case '\b':
      if (!current.tracked) return { line: current, record: null, rank: false };
      return { line: { buffer: current.buffer.slice(0, -1), tracked: true }, record: null, rank: true };
    case '\x03': // ^C: the shell abandons the line and prints a new prompt.
      return { line: NEW_LINE, record: null, rank: false };
    default:
      // Tab (completion), Esc (a meta prefix, or vi's command mode), ^U, ^W,
      // ^A…: the shell edits the line itself.
      if (data.charCodeAt(0) < 0x20) return { line: LOST_LINE, record: null, rank: false };
      if (!current.tracked) return { line: current, record: null, rank: false };
      return { line: { buffer: current.buffer + data, tracked: true }, record: null, rank: true };
  }
}

/**
 * What a ranking puts in the suggestion state for `typed`: the candidates, the
 * ghost (the rest of the top one, only when it literally continues what was
 * typed), and `typed` itself — the text the ranking, its position on screen
 * and an accept are all measured against.
 */
export function rankedSuggestions(typed, candidates) {
  const items = Array.isArray(candidates) ? candidates : [];
  const top = items[0];
  const ghost =
    typeof top === 'string' && typeof typed === 'string' && top.length > typed.length &&
    top.toLowerCase().startsWith(typed.toLowerCase())
      ? top.slice(typed.length)
      : '';
  return { typed: typeof typed === 'string' ? typed : '', ghost, items, selectedIndex: 0, moved: false };
}

/** What the overlay actually puts on screen for `state`. */
export function drawnSuggestion(state) {
  const visible = Boolean(state?.visible);
  return {
    ghost: visible && Boolean(state.ghost),
    popup: visible && Array.isArray(state.items) && state.items.length > 1,
  };
}

const PASS = Object.freeze({ action: 'pass', consume: false });

/**
 * What a key does to the suggestion layer.
 *
 *   pass     not the layer's — the key goes to the terminal untouched.
 *   accept   type `text`, the rest of the chosen suggestion; the key is taken.
 *   move     highlight `selectedIndex` in the popup; the key is taken.
 *   dismiss  hide the suggestion; the key is taken.
 *   clear    hide the suggestion, and let the key go on.
 *
 * Rules:
 *   - Nothing while a program runs or the alternate buffer is up.
 *   - Nothing unless a ghost or the popup is actually drawn: Esc used to be
 *     swallowed with nothing on screen.
 *   - Tab is never taken. It is the shell's completion key, and zsh's
 *     completion never ran while a ghost was showing.
 *   - → takes the highlighted popup item when ↑/↓ moved the highlight,
 *     otherwise the ghost — by typing the part not yet typed. Only a
 *     candidate that CONTINUES what was typed can be taken: `suggest()` also
 *     ranks subsequence matches (`gs` matches `git push`), and slicing those
 *     wrote the tail of a different string onto the line — `gs` became
 *     `gst push`. For one of those the key goes on, and nothing is typed.
 *   - ↑/↓ move the highlight only while the popup is drawn — otherwise they
 *     are the shell's history keys.
 *   - Enter runs what is on the line; it never accepts. Taking the
 *     highlighted item instead meant typing `opencode`, being offered a stale
 *     `opencoded` from history, and having it typed for you.
 */
export function suggestionKeyAction(state, event, { running = false, alternate = false } = {}) {
  if (!event || event.type !== 'keydown') return PASS;
  if (running || alternate) return PASS;
  const drawn = drawnSuggestion(state);
  if (!drawn.ghost && !drawn.popup) return PASS;

  switch (event.key) {
    case 'Tab':
      return PASS;
    case 'ArrowRight': {
      let index = -1;
      if (drawn.popup && state.moved) index = state.selectedIndex;
      else if (drawn.ghost) index = 0;
      if (index < 0) return PASS;
      const text = completionFor(state.typed ?? '', state.items[index]);
      if (text === null) return { action: 'clear', consume: false };
      return { action: 'accept', text, index, consume: true };
    }
    case 'ArrowDown':
    case 'ArrowUp': {
      if (!drawn.popup) return PASS;
      const count = state.items.length;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      return { action: 'move', selectedIndex: (state.selectedIndex + step + count) % count, consume: true };
    }
    case 'Enter':
      return drawn.popup ? { action: 'clear', consume: false } : PASS;
    case 'Escape':
      return { action: 'dismiss', consume: true };
    default:
      return PASS;
  }
}

/**
 * The input line after a key decision: a key the layer took never reached the
 * program, so the line it was guessing at is dropped.
 */
export function lineAfterKey(line, decision) {
  return decision?.consume ? LOST_LINE : line;
}

export default {
  NEW_LINE,
  LOST_LINE,
  suggestionsAllowed,
  trackInput,
  rankedSuggestions,
  drawnSuggestion,
  suggestionKeyAction,
  lineAfterKey,
};
