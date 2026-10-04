/**
 * Korean typed into a terminal on macOS, sent one finished syllable at a time.
 *
 * WebKit's Korean input (macOS 2-Set, recorded in NexTerm's WKWebView, in a
 * plain textarea and in Safari alike) usually composes WITHOUT composition
 * events. The first jamo of a syllable arrives as `insertText` and every later
 * key rewrites it in place with `insertReplacementText`:
 *
 *     insertText 'ㅎ' → insertReplacementText '하' → '한' → (next key) '한' + insertText 'ㄱ' …
 *
 * all with `isComposing: false`, and the `input` event fires BEFORE the
 * keydown (keyCode 229) that caused it. xterm only reads `insertText`
 * (`_inputEvent`, the same code in 5.5 and 6.0), so the shell received `ㅎㄱ`
 * for `한글` — the first jamo of each syllable. Typed fast, keyups land
 * between the IME's events, xterm's `_keyDownSeen` goes stale and whole
 * syllables vanish (xterm #6144). No xterm release handles
 * `insertReplacementText`.
 *
 * So the text being composed is kept here, out of xterm's sight, and sent
 * whole when the syllable is finished — by the next syllable starting, or by
 * any key that is not part of composing (Space, Enter, Tab, punctuation,
 * digits, Esc, arrows, Ctrl+C, a letter after switching to ABC, ⌘V…), which
 * then goes on to xterm as usual. Nothing reaches the program mid-syllable:
 * not every intermediate jamo, and not a DEL to take one back.
 *
 * The same IME sometimes uses ordinary marked text instead (Safari flipped
 * mid-test). Composition events are left entirely to xterm's own
 * CompositionHelper; a syllable pending here is sent the moment one begins.
 *
 * Two parts, both in this file:
 *
 *   - `createHangulInlineIme` — the rules, as a state machine over plain
 *     objects describing each event and the textarea at that moment. No DOM,
 *     no xterm, so every rule is replayed against the recorded event streams
 *     in Node (tests/adversarial/hangul_inline_ime.test.js).
 *   - `installHangulInlineIme` — the binding: capture-phase listeners on the
 *     terminal's container, which hold xterm's helper textarea, so they run
 *     before xterm's own listeners on it. A consumed event is stopped there
 *     and xterm never sees it. macOS only; nothing is installed elsewhere.
 */
import { isMac } from './platform.js';
import { pressReachesProgram } from './mouseReporting.js';

/** Hangul jamo, compatibility jamo, extended jamo A/B and syllables. */
const HANGUL = /^[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]$/u;

/** One Hangul character — what the IME inserts to start a syllable. */
export function isHangulCharacter(text) {
  return typeof text === 'string' && HANGUL.test(text);
}

/** Text made only of Hangul — what the IME writes over a syllable it is still composing. */
function isHangulText(text) {
  return typeof text === 'string' && text.length > 0 && [...text].every((ch) => HANGUL.test(ch));
}

/**
 * Keys that only modify another one: Shift, Ctrl, Alt, CapsLock and ⌘ (left,
 * right, and the code some engines use). Shift in particular comes BEFORE the
 * jamo it shifts — ㄲ ㅃ ㅆ ㅉ ㅒ ㅖ — so treating it as the end of a syllable
 * would send ㄱ and then have to take it back to make 걔.
 */
const MODIFIER_KEY_CODES = new Set([16, 17, 18, 20, 91, 92, 93, 224]);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Meta', 'OS']);

const DEL = '\x7f';

/** What the binding does with the DOM event after the machine has seen it. */
const PASS = Object.freeze({ consume: false, preventDefault: false });
const CONSUME = Object.freeze({ consume: true, preventDefault: false });
const CONSUME_AND_PREVENT = Object.freeze({ consume: true, preventDefault: true });

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  // Never split a surrogate pair.
  if (i > 0 && i < a.length && /[\ud800-\udbff]/.test(a[i - 1])) i -= 1;
  return i;
}

const codePoints = (text) => [...text].length;

/**
 * The rules. `send(text)` delivers finished text to the program;
 * `onPreview(text, { flushed, retracted })` reports what is being composed
 * ('' when nothing is), with `flushed` the text that was just sent to make way
 * for it and `retracted` the number of sent characters just taken back.
 *
 * Every handler takes the event's own fields plus the textarea's `value`,
 * `selectionStart` and `selectionEnd` at that moment, and answers whether the
 * event is consumed (kept from xterm) and whether its default is prevented.
 *
 * State: `pending` is text in the textarea that has not been sent, starting at
 * `pendingStart` in the textarea's value. Everything before it has been sent —
 * by this, or by xterm.
 */
export function createHangulInlineIme({ send = () => {}, onPreview = () => {} } = {}) {
  let pending = '';
  let pendingStart = 0;
  /** The range the last `beforeinput insertReplacementText` is about to replace. */
  let replacement = null;
  /** An input was consumed and no keydown has come since: its keydown is next. */
  let consumedInput = false;
  /** Between compositionstart and compositionend: xterm's CompositionHelper owns it. */
  let composing = false;
  /** The textarea's value as last seen — for a replacement whose beforeinput went missing. */
  let lastValue = '';
  let reported = '';

  const report = (flushed = '', retracted = 0) => {
    if (pending === reported && !flushed && !retracted) return;
    reported = pending;
    onPreview(pending, { flushed, retracted });
  };

  const flush = () => {
    if (!pending) return '';
    const text = pending;
    pending = '';
    pendingStart += text.length;
    send(text);
    return text;
  };

  const caretOf = (e, value) =>
    Number.isInteger(e?.selectionStart) ? e.selectionStart : value.length;

  /**
   * `insertReplacementText`: the IME rewrote the syllable it is composing.
   *
   * WebKit has already put the replacement range in the textarea's selection
   * when `beforeinput` fires (`getTargetRanges()` is empty for a textarea), so
   * the range comes from there. Normally it starts inside the pending text and
   * the pending text simply becomes what the textarea now holds.
   *
   * If it starts EARLIER — in text already sent, because a syllable began
   * while nothing here was watching, or after a click sent it early and the
   * IME carried on composing — the sent characters that changed are taken
   * back with one DEL each and the rest becomes pending. A replacement that
   * leaves the sent text as it was (the IME re-affirming it) costs nothing.
   */
  const replaceText = (e, value, caret, recorded, before) => {
    const data = typeof e.data === 'string' ? e.data : '';
    const start = Number.isInteger(recorded?.start) ? recorded.start : Math.max(0, caret - data.length);
    let boundary = pendingStart;
    if (!pending) {
      // Nothing pending: everything up to the end of the replaced range has
      // been sent already.
      boundary = Number.isInteger(recorded?.end)
        ? recorded.end
        : start + Math.max(0, before.length - value.length + data.length);
    }
    let taken = 0;
    if (start < boundary) {
      const sent = before.slice(start, boundary);
      const keep = commonPrefixLength(sent, value.slice(start, caret));
      taken = codePoints(sent.slice(keep));
      if (taken > 0) send(DEL.repeat(taken));
      pendingStart = start + keep;
    } else if (!pending) {
      pendingStart = boundary;
    }
    pending = caret > pendingStart ? value.slice(pendingStart, caret) : '';
    return taken;
  };

  return {
    /** The syllable being composed, '' when there is none. */
    get pending() {
      return pending;
    },

    beforeInput(e) {
      const value = typeof e?.value === 'string' ? e.value : lastValue;
      lastValue = value;
      if (composing || e?.isComposing) return PASS;
      replacement =
        e?.inputType === 'insertReplacementText'
          ? { start: e.selectionStart, end: e.selectionEnd, oldValue: value }
          : null;
      return PASS;
    },

    input(e) {
      const value = typeof e?.value === 'string' ? e.value : lastValue;
      const recorded = replacement;
      replacement = null;
      const before = typeof recorded?.oldValue === 'string' ? recorded.oldValue : lastValue;
      lastValue = value;
      if (composing || e?.isComposing) return PASS;
      const caret = caretOf(e, value);

      if (e.inputType === 'insertReplacementText' && (pending || isHangulText(e.data))) {
        const retracted = replaceText(e, value, caret, recorded, before);
        consumedInput = true;
        report('', retracted);
        return CONSUME;
      }

      if (e.inputType === 'insertText' && isHangulCharacter(e.data)) {
        // A new syllable: the one before it is finished. xterm never sees
        // Hangul, so its stale `_keyDownSeen` cannot drop a syllable either.
        const flushed = flush();
        pending = e.data;
        pendingStart = Math.max(0, caret - e.data.length);
        consumedInput = true;
        report(flushed);
        return CONSUME;
      }

      // Anything else is xterm's, and it goes after the pending syllable.
      const flushed = flush();
      if (flushed) report(flushed);
      return PASS;
    },

    keyDown(e) {
      if (typeof e?.value === 'string') lastValue = e.value;
      const afterConsumedInput = consumedInput;
      consumedInput = false;
      if (composing || e?.isComposing) return PASS;

      // The IME's own keydown, arriving after the text it produced. Left to
      // xterm it would be read as "an IME key that inserted no composition"
      // and the textarea diffed a tick later — which, typing fast, sends the
      // whole textarea.
      if (e.keyCode === 229) return afterConsumedInput || pending ? CONSUME : PASS;

      if (!pending) return PASS;
      if (MODIFIER_KEY_CODES.has(e.keyCode) || MODIFIER_KEYS.has(e.key)) return PASS;

      if (e.keyCode === 8 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // The IME passes Backspace on once the syllable is down to its last
        // jamo (re-affirming it first). That jamo was never sent, so it goes
        // without a DEL — and without the textarea deleting a character xterm
        // would then never hear about.
        pending = '';
        report();
        return CONSUME_AND_PREVENT;
      }

      // Space, Enter, Tab, punctuation, digits, Esc, arrows, Ctrl+C, a letter
      // after switching to ABC, ⌘V…: the syllable is finished, and the key
      // follows it.
      const flushed = flush();
      report(flushed);
      return PASS;
    },

    compositionStart() {
      // The IME switched to marked text. The syllable it was building here is
      // done; composition from now on is xterm's.
      const flushed = flush();
      composing = true;
      report(flushed);
      return PASS;
    },

    compositionEnd() {
      composing = false;
      return PASS;
    },

    /** Focus left the terminal (another input, another app): send what is there. */
    blur() {
      const flushed = flush();
      composing = false;
      report(flushed);
      return PASS;
    },

    /**
     * A click in the terminal — finishes the syllable only when the program
     * is watching the mouse.
     *
     * xterm's SelectionService calls `preventDefault()` on mousedown, so the
     * textarea keeps focus and the IME keeps composing right through the
     * click: nothing here actually ended the syllable, so flushing anyway
     * made the IME's own next rewrite land on text this had already sent —
     * read by `replaceText` as the IME re-editing something final, and taken
     * back with a DEL that removes one byte for good under a C locale (HI-42:
     * `한`, click, `ㅏ` sent `한` + DEL + `하` + `나`, not `한` then `하`).
     *
     * `mouseTracking` is true only when THIS click is passed to the PROGRAM
     * (`term.modes.mouseTrackingMode !== 'none'`, and no Shift or ⌥ turning
     * it into a selection — see `pressReachesProgram` in mouseReporting.js) —
     * there, the click really does have to go out in order, ahead of whatever
     * is still being composed, the same as any other key composing cannot
     * absorb. Otherwise the pending syllable, and its preview, are left
     * exactly as they were; a real focus change away from the terminal is
     * already `blur`'s job.
     */
    mouseDown(e) {
      if (!e?.mouseTracking) return PASS;
      const flushed = flush();
      report(flushed);
      return PASS;
    },

    /** Send whatever is pending now. Returns what was sent. */
    flush() {
      const flushed = flush();
      report(flushed);
      return flushed;
    },
  };
}

const installed = new WeakMap();

/**
 * The DOM side, as an xterm addon so it is disposed with its terminal.
 *
 * Listeners go on `container` (an ancestor of xterm's helper textarea) in the
 * CAPTURE phase, so they run before xterm's own listeners on the textarea.
 * `stopImmediatePropagation()` keeps a consumed event from xterm.
 * `attachCustomKeyEventHandler` is not used: it has a single slot and
 * TerminalView owns it.
 */
class HangulInlineImeAddon {
  constructor(container) {
    this._container = container;
    this._listeners = new Set();
    this._removers = [];
    this._machine = null;
  }

  activate(term) {
    const machine = createHangulInlineIme({
      // As if typed: every onData consumer (the PTY, TerminalView's input
      // tracking) sees it exactly as a keystroke, and the view follows it to
      // the bottom.
      send: (text) => term.input(text, true),
      onPreview: (text, info) => {
        // xterm brings a scrolled-back view to the prompt on a composition
        // key; the keys consumed here never reach it, so do the same.
        if (text) scrollToPrompt();
        for (const listener of [...this._listeners]) listener(text, info);
      },
    });
    const scrollToPrompt = () => {
      if (term.options?.scrollOnUserInput === false) return;
      const buffer = term.buffer?.active;
      if (buffer && buffer.viewportY !== buffer.baseY) term.scrollToBottom?.();
    };
    this._machine = machine;

    const fromTextarea = (e) => Boolean(e?.target) && e.target === term.textarea;
    const textareaState = (el) => ({
      value: el.value,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    });
    const apply = (e, decision) => {
      if (decision?.preventDefault) e.preventDefault();
      if (decision?.consume) e.stopImmediatePropagation();
    };
    const on = (type, handler) => {
      this._container.addEventListener(type, handler, true);
      this._removers.push(() => this._container.removeEventListener(type, handler, true));
    };

    on('beforeinput', (e) => {
      if (!fromTextarea(e)) return;
      apply(e, machine.beforeInput({
        inputType: e.inputType,
        data: e.data,
        isComposing: e.isComposing,
        ...textareaState(e.target),
      }));
    });
    on('input', (e) => {
      if (!fromTextarea(e)) return;
      apply(e, machine.input({
        inputType: e.inputType,
        data: e.data,
        isComposing: e.isComposing,
        ...textareaState(e.target),
      }));
    });
    on('keydown', (e) => {
      if (!fromTextarea(e)) return;
      apply(e, machine.keyDown({
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        isComposing: e.isComposing,
        ...textareaState(e.target),
      }));
    });
    on('compositionstart', (e) => {
      if (fromTextarea(e)) apply(e, machine.compositionStart());
    });
    on('compositionend', (e) => {
      if (fromTextarea(e)) apply(e, machine.compositionEnd());
    });
    // `blur` does not bubble, but a capture listener on an ancestor still
    // sees it — before xterm's own handler empties the textarea.
    on('blur', (e) => {
      if (fromTextarea(e)) machine.blur();
    });
    on('mousedown', (e) => {
      // Whether THIS click goes to the program, in order, ahead of the
      // syllable — see the doc comment on `mouseDown` for why that is the
      // only time flushing here is safe. A Shift- or ⌥-press selects instead
      // (this binding is macOS-only, hence `mac`).
      machine.mouseDown({
        mouseTracking: pressReachesProgram(e, {
          mac: true,
          tracking: Boolean(term.modes && term.modes.mouseTrackingMode !== 'none'),
        }),
      });
    });
  }

  /** The syllable being composed, '' when there is none. */
  get pending() {
    return this._machine?.pending ?? '';
  }

  /**
   * Hear about the syllable being composed: `listener(text, { flushed })`,
   * with '' once there is none. Returns a disposable.
   */
  onPreview(listener) {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  flush() {
    return this._machine?.flush() ?? '';
  }

  dispose() {
    for (const remove of this._removers.splice(0)) remove();
    this._listeners.clear();
  }
}

/**
 * Install the binding on a terminal, once, right after `term.open(container)`.
 * macOS only: returns null — and touches nothing — anywhere else, where
 * WebView2 and WebKitGTK deliver composition events that xterm handles itself.
 */
export function installHangulInlineIme(term, container, { mac = isMac } = {}) {
  if (!mac || !term || !container) return null;
  const existing = installed.get(term);
  if (existing) return existing;
  const addon = new HangulInlineImeAddon(container);
  term.loadAddon(addon);
  installed.set(term, addon);
  return addon;
}

/** The binding installed on `term`, or null (always null off macOS). */
export function hangulImeFor(term) {
  return (term && installed.get(term)) || null;
}

export default { createHangulInlineIme, installHangulInlineIme, hangulImeFor, isHangulCharacter };
