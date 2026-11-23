/**
 * The hover card of a terminal tab chip (bundle 4, B12): what it says, and
 * when it is shown.
 *
 * It replaced the chip's native `title` tooltip, which put everything on one
 * line the platform cut wherever it liked, showed after the platform's own
 * delay, and could not be styled or opened from the keyboard. The card is
 * the chip's one tooltip now: neither the chip nor anything on it that takes
 * the pointer (its ✕, the "controlled" badge) has a `title` (two tooltips
 * would show at once).
 *
 * WHAT IT SAYS, row by row, each only when it has something to say:
 *
 *   title    the terminal's full name (`displayTitle`, the chip's own), which
 *            the chip cuts at 120px
 *   status   glyph, agent, state and how long it has held, worked out by the
 *            very helpers the TERMINALS row uses (terminalStatus.js), so the
 *            two never disagree; an exited shell's or a failed command's code
 *   folder   the terminal's folder, shortened in the middle
 *   shell    the shell, as the platform names it (`shellLabel`)
 *   usage    what its programs use, 'CPU% · memory' — only with Settings ▸
 *            Terminal ▸ Show CPU and Memory on (bundle 4, B8), in the
 *            TERMINALS row's own words (resourceUsage.js); 'not measurable'
 *            for a WSL terminal
 *   flags    typing hidden, read-only, controlled by another terminal, N
 *            unread — the chip's badges in words
 *   note     the last notification, as the TERMINALS row draws it (`noteLine`)
 *   hint     how to use the chip: drag to reorder or move, double-click to rename
 *
 * What it NEVER says: anything of the terminal's screen, nor the command line
 * running in it (human decision OQ4). It reads the store only; nothing is
 * read from disk or from a process while it is shown. Its CPU and memory
 * are the sampler's last figures (src/hooks/useResourceSampler.js), which
 * the card keeps asking for while it is shown.
 *
 * Every row is someone else's text — a program titles its terminal, a shell
 * reports its folder, a program sends notifications — and is cleaned as the
 * palette and the dialogs clean it (`displayText`, projectCommands.js):
 * control characters (ESC, BEL, C1), bidirectional marks and overrides,
 * zero-width and other invisible characters, so that what is shown is what
 * the text holds. `displayTitle` itself does not clean (tabTitle.js); the
 * card does, where it draws.
 *
 * WHEN IT IS SHOWN (`createHoverCardController`): 600 ms after the pointer
 * comes onto a chip, or after keyboard focus (focus-visible) lands on one;
 * gone 100 ms after the pointer leaves, at once on Escape or a press (an
 * Escape while it is only about to show drops the wait and is not taken,
 * as nothing is on screen for it to close). Moving
 * to another chip while one is shown switches to it at once. Never during a
 * drag, a rename or an open menu, and not again after a press until the
 * pointer has left the chip. Timers are handed in, so the suites drive it
 * with fake ones.
 *
 * Pure: no React, no stores, no DOM.
 */
import { agentLabel, elapsedSince, elapsedWords, noteLine, statusText, terminalStatus } from './terminalStatus.js';
import { displayText, shellLabel } from './projectCommands.js';
import { shellKindFor } from './dropPaths.js';
import { displayTitle } from './tabTitle.js';
import { isFailure } from './tabActivity.js';
import { TYPING_HIDDEN_LABEL } from './secretInput.js';
import { READ_ONLY_LABEL } from './readOnly.js';
import { unreadLabel } from './attention.js';
import { resourceUsageLabel, resourceUsageWords } from './resourceUsage.js';

/** How long the pointer or keyboard focus has to stay on a chip before its card shows. */
export const HOVER_CARD_OPEN_MS = 600;

/** How long a shown card stays after the pointer leaves its chip — long enough to reach the next chip. */
export const HOVER_CARD_CLOSE_MS = 100;

/** The card's last line: what the old tooltip said when nothing else was to be said. */
export const HOVER_CARD_HINT = 'Drag to reorder or move \u{00B7} Double-click to rename';

/** The longest title shown, in characters; the card wraps it. */
export const CARD_TITLE_MAX = 200;

/** The longest folder shown, in characters; a longer one loses its middle. */
export const CARD_FOLDER_MAX = 56;

/** The longest notification line shown, in characters. */
export const CARD_NOTE_MAX = 160;

/** How much of any text is looked at at all, in UTF-16 units. */
const INPUT_MAX = 16_384;

const SEPARATOR = ' \u{00B7} ';

/**
 * `text` as the card may show it: no control, bidirectional or invisible
 * character (ESC, BEL, U+202E, U+200B, U+FEFF, ...), whitespace runs one
 * space, trimmed, cut at `max` characters with "…". '' for anything that is
 * not a string.
 */
export function cleanCardText(text, max) {
  if (typeof text !== 'string') return '';
  return displayText(text.length > INPUT_MAX ? text.slice(0, INPUT_MAX) : text, max);
}

/**
 * `path` cut to `max` characters by taking out its middle — "/Users/me/…/app/src"
 * — so both where it starts and the folder it ends in stay. The end keeps
 * the larger share: the last folder is the one that says which it is.
 * Counted by code point. Already clean text in, as `cleanCardText` gives.
 */
export function middleShorten(path, max = CARD_FOLDER_MAX) {
  if (typeof path !== 'string') return '';
  const chars = Array.from(path);
  if (!(max > 1) || chars.length <= max) return path;
  const keep = max - 1;
  const head = Math.floor(keep * 0.4);
  const tail = keep - head;
  return `${chars.slice(0, head).join('')}\u{2026}${chars.slice(chars.length - tail).join('')}`;
}

/**
 * The shell, named as the rest of the app names it (`shellLabel`), or '' when
 * NexTerm cannot tell which it is. `shellPath` is what `shellPathOf` gives;
 * `platform` the system store's `os`.
 */
export function shellName(shellPath, platform) {
  if (typeof shellPath !== 'string' || !shellPath.trim()) return '';
  const kind = shellKindFor(shellPath, platform);
  if (kind === 'unknown') return cleanCardText(shellPath.split(/[\\/]/u).pop(), 20);
  return cleanCardText(shellLabel(kind, shellPath), 20);
}

/**
 * What the chip's "controlled" badge says (HiddenStrip.jsx, ControlledBadge),
 * for its flag: "Controlled by Terminal 2 (send)" — a program in another
 * terminal just typed into this one, read its screen or focused it. The
 * caller's name is someone else's text, so it is cleaned. '' for no mark.
 */
export function controlledFlag(mark) {
  if (!mark || typeof mark !== 'object') return '';
  const by = cleanCardText(mark.byTitle, 60);
  if (!by) return '';
  const cmd = cleanCardText(mark.cmd, 20);
  return `Controlled by ${by}${cmd ? ` (${cmd})` : ''}`;
}

/** What the state's word leaves out that the old tooltip said: an exit code. */
function statusDetail(tab, status) {
  if (status.state === 'exited') {
    const code = tab?.exited?.code;
    return typeof code === 'number' ? `(code ${code})` : '';
  }
  if (status.state === 'failed' && isFailure(tab?.lastExitCode)) return `(exit ${tab.lastExitCode})`;
  return '';
}

/**
 * The rows of terminal `tab`'s card, in the order they are drawn, each
 * `{ key, text }` — `glyph` and `state` on the status row, `items` on the
 * flags row, `dim: true` on the rows drawn quieter — and only the rows with
 * something to say; [] when there is no tab.
 *
 * `options` is what the TERMINALS row is given for the same terminal:
 * `unread` (its unread count), `progress` (its bar), `activity` (its entry
 * in `agentActivity`), `note` (its newest notification, `lastNoteOf`), and
 * `now` for the elapsed time; plus `locked` (asking for a password),
 * `readOnly`, `shellPath` (`shellPathOf`) and `platform`; `controlled`, its
 * entry in the terminal store's `controlled` map (`{ byTitle, cmd }`: a
 * program in another terminal just controlled it, the chip's badge); and
 * `showUsage` (Show CPU and Memory, exactly true) with `usage`, the
 * terminal's entry in the resource usage store.
 *
 * The status row names the agent whenever one runs (`agentLabel`), whatever
 * Show Agent says — the card is asked for — and says how long its state has
 * held exactly where a TERMINALS row naming an agent would (`elapsedSince`),
 * in words ("for 3 minutes").
 */
export function tabHoverCardRows(tab, options = {}) {
  if (!tab) return [];
  const {
    unread = 0,
    progress = null,
    activity = null,
    note = null,
    now = Date.now(),
    locked = false,
    readOnly = false,
    shellPath = null,
    platform = null,
    showUsage = false,
    usage = null,
    controlled = null,
  } = options;
  const rows = [];

  const title = cleanCardText(displayTitle(tab), CARD_TITLE_MAX);
  if (title) rows.push({ key: 'title', text: title });

  const agent = agentLabel(tab);
  const status = terminalStatus(tab, { unread, progress, activity });
  const since = elapsedSince(tab, status, { activity, agentRow: Boolean(agent) });
  const state = [statusText(status), statusDetail(tab, status), since !== null ? elapsedWords(now - since) : '']
    .filter(Boolean)
    .join(' ');
  const said = [agent, state].filter(Boolean).join(SEPARATOR);
  if (said) rows.push({ key: 'status', text: said, glyph: status.glyph, state: status.state });

  const folder = middleShorten(cleanCardText(tab.cwd, INPUT_MAX), CARD_FOLDER_MAX);
  if (folder) rows.push({ key: 'folder', text: folder });

  const shell = shellName(shellPath, platform);
  if (shell) rows.push({ key: 'shell', text: shell });

  // Bundle 4's B8: its CPU and memory, between the shell and the flags — what
  // the terminal costs, next to what it runs. The short form is drawn, the
  // words ('… of one core …') are read out. A WSL terminal says it cannot be
  // measured while its shell runs; nothing while there is no sample yet.
  if (showUsage === true) {
    const wsl = !tab.exited && shellKindFor(shellPath, platform) === 'wsl';
    const text = resourceUsageLabel(usage, { wsl });
    if (text) rows.push({ key: 'usage', text, words: resourceUsageWords(usage, { wsl }) || text, wsl });
  }

  const flags = [
    locked ? TYPING_HIDDEN_LABEL : '',
    readOnly ? READ_ONLY_LABEL : '',
    controlledFlag(controlled),
    typeof unread === 'number' && unread > 0 ? unreadLabel(unread) : '',
  ].filter(Boolean);
  if (flags.length) rows.push({ key: 'flags', text: flags.join(SEPARATOR), items: flags });

  // The agent's name is on the card, so a message titled only with it is its
  // body alone, as on a TERMINALS row that names the agent.
  const noteText = note ? cleanCardText(noteLine(note, { agentShown: Boolean(agent) }), CARD_NOTE_MAX) : '';
  if (noteText) rows.push({ key: 'note', text: noteText, dim: true });

  rows.push({ key: 'hint', text: HOVER_CARD_HINT, dim: true });
  return rows;
}

// ---- When it is shown --------------------------------------------------------

/**
 * Whether a pane's chips may show no card right now: during a drag (of a
 * terminal or a file tab), a rename in the strip, or while one of its menus
 * is open — the pane's `holds` (stripReveal.js).
 */
export function hoverCardBlocked({ dragging = false, menuOpen = false, renaming = false } = {}) {
  return Boolean(dragging || menuOpen || renaming);
}

/**
 * The `aria-describedby` of chip `tabId`: the card's id `cardId` while its
 * card is the one shown (`shownId`), and nothing otherwise — a description
 * pointing at nothing would be read as empty.
 */
export function chipDescribedBy(shownId, tabId, cardId) {
  return shownId !== null && shownId !== undefined && shownId === tabId && cardId ? cardId : undefined;
}

/**
 * Where a card `width` × `height` goes for a chip at `anchor` (its client
 * rect) in a window `viewportWidth` × `viewportHeight`: `gap` px below the
 * chip, starting at its left edge, moved left as far as it takes to stay
 * `margin` px inside the window — and above the chip instead when there is
 * no room below.
 */
export function cardPosition(anchor, { width = 0, height = 0, viewportWidth = Infinity, viewportHeight = Infinity, gap = 4, margin = 4 } = {}) {
  if (!anchor) return { left: margin, top: margin };
  const left = Math.max(margin, Math.min(anchor.left, viewportWidth - margin - width));
  const below = anchor.bottom + gap;
  const fitsBelow = below + height <= viewportHeight - margin;
  const top = fitsBelow || anchor.top - gap - height < margin ? below : anchor.top - gap - height;
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * When the card of a row of chips shows, and for which chip; one card at a
 * time. `onChange(id)` hears each change — the chip whose card is shown, or
 * null. `setTimeout`/`clearTimeout` default to the global ones.
 *
 *   enter(id) / leave(id)   the pointer came onto / left chip `id`
 *   focus(id, visible)      keyboard focus came onto it; only a focus-visible
 *                           one (the keyboard's) opens the card
 *   blur(id)                focus left it
 *   press(id)               a press on it: the card goes, and stays away
 *                           until the pointer has left that chip
 *   escape()                hides a shown card, and is true then, so the key
 *                           is taken; a card only about to show is dropped
 *                           and it is false, so the key goes on: nothing on
 *                           screen was closed
 *   setBlocked(on)          a drag, a rename or a menu: no card while on
 *   hide()                  hides it now, timers and all (its chip went
 *                           away, the row unmounted)
 *   forget(id)              chip `id`'s element went away — its tab closed,
 *                           or the strip drew a new one in its place: the
 *                           pointer, the focus, a press and an Escape held
 *                           for it are let go, as a removed element hears no
 *                           leave and no blur, and its card goes if it is
 *                           the one shown or about to show. The next enter
 *                           or focus on that id starts afresh
 *
 * A card shown by focus stays while the pointer comes and goes over its chip,
 * and one shown by the pointer stays while that chip has focus.
 */
export function createHoverCardController({
  onChange = () => {},
  setTimeout: later = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = (id) => globalThis.clearTimeout(id),
  openMs = HOVER_CARD_OPEN_MS,
  closeMs = HOVER_CARD_CLOSE_MS,
} = {}) {
  let shown = null;
  let pending = null;
  let openTimer = null;
  let closeTimer = null;
  let hovered = null;
  let focused = null;
  let pressed = null;
  let dismissed = null;
  let blocked = false;

  const stopOpen = () => {
    if (openTimer !== null) cancel(openTimer);
    openTimer = null;
    pending = null;
  };
  const stopClose = () => {
    if (closeTimer !== null) cancel(closeTimer);
    closeTimer = null;
  };
  const set = (id) => {
    if (id === shown) return;
    shown = id;
    onChange(id);
  };
  const hideNow = () => {
    stopOpen();
    stopClose();
    set(null);
  };
  const refused = (id) => blocked || id === null || id === undefined || id === pressed || id === dismissed;

  /** Chip `id` wants its card: at once while another is shown, else after the delay. */
  const want = (id) => {
    if (refused(id)) return;
    stopClose();
    if (shown === id) return;
    if (shown !== null) {
      stopOpen();
      set(id);
      return;
    }
    if (pending === id) return;
    stopOpen();
    pending = id;
    openTimer = later(() => {
      openTimer = null;
      pending = null;
      if (!refused(id)) set(id);
    }, openMs);
  };
  /** Chip `id` no longer holds its card by pointer or focus: gone after the grace. */
  const release = (id) => {
    if (pending === id) stopOpen();
    if (shown !== id || closeTimer !== null) return;
    closeTimer = later(() => {
      closeTimer = null;
      set(null);
    }, closeMs);
  };

  return {
    get shown() {
      return shown;
    },
    get pending() {
      return pending;
    },
    enter(id) {
      hovered = id;
      want(id);
    },
    leave(id) {
      if (hovered === id) hovered = null;
      if (pressed === id) pressed = null;
      if (dismissed === id && focused !== id) dismissed = null;
      if (focused !== id) release(id);
    },
    focus(id, visible = false) {
      if (!visible) return;
      focused = id;
      want(id);
    },
    blur(id) {
      if (focused === id) focused = null;
      if (dismissed === id && hovered !== id) dismissed = null;
      if (hovered !== id) release(id);
    },
    press(id) {
      pressed = id;
      hideNow();
    },
    escape() {
      if (shown === null) {
        stopOpen();
        return false;
      }
      dismissed = shown;
      hideNow();
      return true;
    },
    setBlocked(on) {
      blocked = Boolean(on);
      if (blocked) hideNow();
    },
    hide() {
      hideNow();
    },
    forget(id) {
      if (id === null || id === undefined) return;
      if (hovered === id) hovered = null;
      if (focused === id) focused = null;
      if (pressed === id) pressed = null;
      if (dismissed === id) dismissed = null;
      if (shown === id || pending === id) hideNow();
    },
  };
}
