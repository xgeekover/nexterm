/**
 * A read-only terminal (bundle 4, A3; Windows Terminal's `toggleReadOnlyMode`):
 * the user's keys, pastes, drops, Korean syllables and mouse reports no longer
 * reach its program, and nothing NexTerm or another program would type there
 * does either (`nexterm-cli send`, startup and project commands, an agent
 * launched or resumed). What the terminal itself answers its program — DA,
 * cursor position reports, DECRQM, focus reports, XTVERSION, XTQMODKEYS and
 * the kitty keyboard query — still goes: a program waiting for one of those
 * would otherwise hang.
 *
 * xterm.js hands both kinds to `onData`. They are told apart by xterm's own
 * word for it: `CoreService.triggerDataEvent(data, wasUserInput)` fires
 * `onUserInput` synchronously, right before `onData`, for user input only —
 * keys, IME text, pastes, mouse reports, and `term.input(data, true)`. That
 * signal is private (`term._core.coreService.onUserInput`), so it is
 * presence-checked, as mouseReporting.js checks `coreMouseService`, and the
 * gate fails closed without it: every chunk counts as the user's, and read-only
 * cannot be turned on at all (`setReadOnly` in terminalStore.js).
 *
 * The state is per terminal, in a map of the store's own beside `secretInput`
 * (`readOnly`: tab id -> true), never saved: a restart brings every terminal
 * back writable. These are the map's rules, the gate and the words, with no
 * store in them.
 */

/** What the badge and the TERMINALS row say, and what a screen reader reads. */
export const READ_ONLY_LABEL = 'Read-only: keys, pastes and drops do not reach this terminal';

/** The in-pane strip's words, beside its Turn Off button. */
export const READ_ONLY_STRIP_TEXT = 'Read-only: what you type does not reach this terminal';

/** The menu items, by the state they would change. */
export const TURN_ON_READ_ONLY = 'Turn On Read-Only';
export const TURN_OFF_READ_ONLY = 'Turn Off Read-Only';

/** The command's name in the Command Palette and Settings (keybindings.js's `toggle-read-only`). */
export const TOGGLE_READ_ONLY_TITLE = 'Terminal: Toggle Read-Only';

/** The in-pane strip's button, and what its tooltip says it does. */
export const READ_ONLY_TURN_OFF = 'Turn Off';
export const READ_ONLY_TURN_OFF_HINT = 'Turn read-only off: what you type reaches this terminal again';

/** How often, at most, one terminal says that it dropped the user's input. */
export const READ_ONLY_NOTICE_MS = 3000;

/** Where read-only is turned off — named wherever input is refused. */
const HOW_TO_TURN_OFF = 'turn it off with Turn Off in the pane, its tab menu, its TERMINALS row or the Command Palette (Terminal: Toggle Read-Only)';

/** The toast for input dropped by a read-only terminal (keys, a paste, a drop, an accepted suggestion). */
export function readOnlyInputRefused(title = '') {
  const name = typeof title === 'string' && title.trim() ? `${title.trim()} is` : 'This terminal is';
  return `Not typed: ${name} read-only — ${HOW_TO_TURN_OFF}`;
}

/** The error when read-only cannot be turned on for a terminal never shown: there is no xterm to gate yet. */
export const READ_ONLY_NEVER_SHOWN = 'Read-only not turned on: this terminal has not been shown yet — open it once first';

/** The error when xterm gives no word on what the user typed (fail closed): read-only stays off. */
export const READ_ONLY_UNAVAILABLE =
  'Read-only not turned on: this terminal cannot tell your keys from its own replies, so it would either let them through or stop its program';

/** `nexterm-cli send`'s refusal (code `refused`, exit 4). */
export const READ_ONLY_SEND_REFUSED = 'that terminal is read-only: nothing was typed — its user has to turn read-only off first';

/** A startup or project command's notice in the terminal, in their wording. */
export function readOnlyCommandNotice(kind, line) {
  return `${kind} not typed — this terminal is read-only: ${line}`;
}

/** Why a project command may not go into a read-only terminal, as the run dialog and `projectCommandBlock` say it (projectCommandRun.js's reasons). */
export const READ_ONLY_REASON = 'it is read-only — turn read-only off there first, or use New split';

/** An agent launch's notice in the terminal, in `startAgent`'s wording. */
export function readOnlyAgentNotice(label) {
  return `${label} not started — this terminal is read-only, and NexTerm types nothing into it. Turn read-only off, then start ${label} here yourself, or open a new ${label} terminal.`;
}

/** An agent resume's notice in the terminal, in `resumeAgent`'s wording. */
export const READ_ONLY_RESUME_NOTICE = 'Not resumed — this terminal is read-only. Turn read-only off, then resume.';

/** `map` with `tabId` read-only or not — the same object when that is what it already said. */
export function withReadOnly(map, tabId, on) {
  const current = map ?? {};
  if (!tabId || Boolean(current[tabId]) === Boolean(on)) return map ?? current;
  const next = { ...current };
  if (on) next[tabId] = true;
  else delete next[tabId];
  return next;
}

/** `map` without `tabIds` — the same object when it held none of them. */
export function withoutReadOnly(map, tabIds) {
  if (!map || !tabIds?.some((id) => map[id])) return map;
  const next = { ...map };
  for (const id of tabIds) delete next[id];
  return next;
}

/** Whether `tabId`'s terminal is read-only, in a store state. */
export function isReadOnly(state, tabId) {
  return Boolean(tabId && state?.readOnly?.[tabId]);
}

/** Whether a terminal that last said it dropped input at `lastAt` may say so again at `now`. */
export function readOnlyNoticeDue(lastAt, now) {
  return !(typeof lastAt === 'number' && now - lastAt < READ_ONLY_NOTICE_MS && now >= lastAt);
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);

/**
 * What TerminalView does with a key while its terminal is read-only, once
 * the window-close chord and copy have had it (both still work) — the app's
 * shortcuts ran before xterm, in the capture phase, and are not asked here:
 *
 *   'xterm'   handed to xterm, which sends nothing for it: Shift+PageUp and
 *             Shift+PageDown scroll the scrollback, ⌘A selects all on macOS,
 *             and a key of an IME composition goes on so the composition
 *             stays whole (what it ends in is dropped by the gate);
 *   'ignore'  kept from xterm and left alone: a modifier by itself, a ⌘
 *             chord on macOS (xterm sends nothing for them; ⌘V's paste is
 *             refused where it lands);
 *   'cancel'  kept from xterm and cancelled, so it neither reaches the
 *             program nor clears the selection, scrolls or moves the focus
 *             (Tab) — and, on keydown, the terminal says it is read-only.
 */
export function readOnlyKeyAction(event, { mac = false } = {}) {
  const key = event?.key;
  const only = (mod) => ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'].every((m) => Boolean(event?.[m]) === (m === mod));
  if (event?.type === 'keydown' && only('shiftKey') && (key === 'PageUp' || key === 'PageDown')) return 'xterm';
  if (mac && only('metaKey') && (event?.code === 'KeyA' || key === 'a')) return 'xterm';
  if (event?.isComposing || event?.keyCode === 229) return 'xterm';
  if (MODIFIER_KEYS.has(key)) return 'ignore';
  if (mac && event?.metaKey) return 'ignore';
  return 'cancel';
}

/** What the writeRaw forwarder hands on with a chunk the terminal itself sent. */
export const AUTOMATIC = Object.freeze({ automatic: true });

/**
 * The menu item that turns `tabId`'s read-only on or off, for the tab chip
 * and the TERMINALS row: off, with its reason, for a terminal never shown
 * (there is nothing to gate yet). `toggle` is the store's `toggleReadOnly`.
 */
export function readOnlyItem({ tabId, readOnly = false, shown = true, toggle, icon } = {}) {
  const item = {
    key: 'read-only',
    label: readOnly ? TURN_OFF_READ_ONLY : TURN_ON_READ_ONLY,
    onSelect: () => toggle?.(tabId),
  };
  if (icon) item.icon = icon;
  if (!readOnly && !shown) {
    item.disabled = true;
    item.disabledReason = 'This terminal has not been shown yet';
  }
  return item;
}

/** xterm's private user-input event, or null when this xterm has none (a test double, a later release). */
function userInputEvent(term) {
  try {
    const service = term?._core?.coreService;
    const event = service?.onUserInput;
    return typeof event === 'function' ? { service, event } : null;
  } catch {
    return null;
  }
}

/**
 * The input gate of one terminal: told by xterm which `onData` chunk is the
 * user's, and asked by every `onData` listener after it whether to drop it.
 * Install it right after the terminal is made, before any other `onData`
 * listener (an addon's included): xterm fires them in the order they were
 * added, so this one classifies a chunk before anything else hears it.
 *
 * `readOnly()` says whether the terminal is read-only now, read for each
 * chunk; `onBlocked()` is told each user chunk dropped. Neither may throw into
 * xterm: both are caught.
 *
 * Returns `{ available, blocks(data), automatic(data), unlessBlocked(fn),
 * forward(fn), dispose() }`. `available` is false when xterm gave no
 * user-input signal: every chunk then counts as the user's (fail closed), and
 * read-only must not be turned on. With read-only off nothing is ever blocked,
 * whatever the signal says.
 */
export function installInputGate(term, { readOnly = () => false, onBlocked = null } = {}) {
  const disposables = [];
  const source = userInputEvent(term);
  let available = false;
  // Set by onUserInput, taken by the next onData chunk.
  let pendingUser = false;
  // The chunk being delivered now: `{ data, user, blocked }`.
  let current = null;
  const readOnlyNow = () => {
    try {
      return Boolean(readOnly());
    } catch (err) {
      console.warn('[Terminal] could not read whether the terminal is read-only; treating it as read-only:', err);
      return true;
    }
  };
  if (source) {
    try {
      const disposable = source.event.call(source.service, () => {
        pendingUser = true;
      });
      disposables.push(disposable);
      available = true;
    } catch (err) {
      console.warn('[Terminal] could not follow user input; read-only is unavailable here:', err);
    }
  }
  if (typeof term?.onData === 'function') {
    try {
      disposables.push(
        term.onData((data) => {
          // Inside xterm's event: a throw here would reach whoever typed.
          try {
            const user = available ? pendingUser : true;
            pendingUser = false;
            const blocked = user && readOnlyNow();
            const seen = { data, user, blocked };
            current = seen;
            // xterm hands a chunk to every listener in one synchronous call;
            // after it, the record says nothing about the next chunk — even
            // one with the same bytes, which a listener ahead of the gate
            // must not take for this one.
            queueMicrotask(() => {
              if (current === seen) current = null;
            });
            if (blocked) onBlocked?.();
          } catch (err) {
            console.warn('[Terminal] the read-only gate failed on a chunk:', err);
          }
        })
      );
    } catch (err) {
      available = false;
      console.warn('[Terminal] could not install the read-only gate:', err);
    }
  } else {
    available = false;
  }
  const record = (data) => (current && current.data === data ? current : null);
  const gate = {
    get available() {
      return available;
    },
    /**
     * Whether the chunk `data`, being delivered now, is dropped. A chunk the
     * gate did not see (a listener ahead of it, or xterm firing inside a
     * listener) is dropped while read-only — fail closed — and never
     * otherwise.
     */
    blocks(data) {
      const seen = record(data);
      return seen ? seen.blocked : readOnlyNow();
    },
    /** Whether the chunk `data` is one the terminal sent by itself (a reply), not the user's. */
    automatic(data) {
      const seen = record(data);
      return Boolean(seen && !seen.user);
    },
    /** `fn` as an onData listener that never hears a dropped chunk. */
    unlessBlocked(fn) {
      return (data) => {
        if (gate.blocks(data)) return;
        fn(data);
      };
    },
    /**
     * The writeRaw forwarder as an onData listener: a dropped chunk goes
     * nowhere; a reply goes with AUTOMATIC, so writeRaw lets it through a
     * read-only terminal; the user's goes as it always went.
     */
    forward(fn) {
      return (data) => {
        if (gate.blocks(data)) return;
        if (gate.automatic(data)) fn(data, AUTOMATIC);
        else fn(data);
      };
    },
    dispose() {
      for (const d of disposables.splice(0)) {
        try {
          d?.dispose?.();
        } catch {
          // the terminal is going anyway
        }
      }
      available = false;
      current = null;
    },
  };
  return gate;
}
