/**
 * The mouse goes to full-screen programs only — Warp's rule.
 *
 * Measured in NexTerm on macOS: Claude Code turns on mouse tracking "any"
 * (DECSET 1003) at its main prompt, in the NORMAL buffer, not on the alternate
 * screen. From then on every press, drag and release in that pane went to
 * Claude as a mouse report and xterm switched its own selection off: nothing
 * in the pane could be selected, so nothing could be copied. On macOS xterm
 * offers no way past it — its override (`shouldForceSelection`) is ⌥, and only
 * with `macOptionClickForcesSelection`, which was off.
 *
 * Warp forwards mouse events "only to full-screen apps", and so does this: a
 * program that owns the whole screen — vim, htop, tmux, `less --mouse`,
 * anything on the ALTERNATE buffer — gets the mouse when it asks for it. A
 * program writing into the scrollback — the shell, Claude Code, an inline
 * picker — does not, and a drag there selects text as it does at a prompt.
 * What a program asks for from the scrollback is remembered: it takes effect
 * the moment that SAME program switches to the alternate screen, exactly as
 * if it had asked again there. No further than that — leaving the alternate
 * screen forgets it too, the same as a DECRST or RIS would, so a program
 * killed without disabling its own tracking first (no clean exit, nothing
 * sent) cannot leave it for the NEXT full-screen program to inherit: `less`,
 * `man`, `git log` start clean. Inside a full-screen program, Shift-drag (and
 * ⌥-drag on macOS) still selects — see `pressForcesSelection` and
 * src/lib/terminalClipboard.js, which installs this.
 *
 * Only the TRACKING protocols are gated (9, 1000, 1002, 1003). The encodings
 * (1005, 1006, 1015, 1016) and focus reporting (1004) are not mouse events in
 * themselves and reach xterm untouched, so a program that asked for SGR
 * reports gets SGR reports the moment tracking takes effect.
 *
 * Known gap (L2): a refused request COMBINED with other modes in one
 * sequence ('pass-then-sync', e.g. `?1006;1000h`) still clears the user's
 * selection — xterm's own DECSET does that the moment ANY tracking mode is
 * set, before this puts the protocol back. The same combined sequence, mid a
 * held-button drag, could similarly cost that drag its motion reports for the
 * same reason (xterm's own transient assignment runs before `sync` corrects
 * it — see "never downgrade during a held button" below). Claude Code's own
 * sequences are never combined like that, so neither reaches it in practice.
 *
 * Mode set, highest wins: 9/1000/1002/1003 (X10/VT200/DRAG/ANY) are tracked as
 * INDEPENDENT flags, not xterm's own single `activeProtocol` — real X11 xterm
 * keeps them independent too and reports via the highest one enabled. xterm.js
 * instead keeps one variable and last-DECSET-wins, so a program that
 * (re)states its modes as separate sequences — `?1000h` then `?1002h` then
 * `?1003h`, which is exactly what Ink-based UIs like Claude Code's redraw as
 * — would otherwise walk xterm's protocol DOWN before it walks it back up.
 * That downgrade is the bug: xterm's `bindMouse` attaches its drag-motion
 * listener to the document only from inside the mousedown handler, and any
 * protocol change whose events lack DRAG removes it — so a transient dip
 * through VT200 while a button is held loses that listener for the REST of
 * the gesture; setting ANY back a moment later cannot re-attach it, only the
 * next mousedown can. Tracked as flags instead, that same repeated-enable
 * sequence only ever walks the highest flag UP, so the protocol xterm is
 * actually given only ever rises — see `requestedFromFlags` and
 * `planPrivateModes`. A genuine downgrade (a real DECRST of the currently-
 * highest flag, nothing re-asserting it) can still happen, which is what
 * "never downgrade during a held button" (below) is for.
 *
 * Never downgrade during a held button: even a genuine drop of the highest
 * flag is held back from xterm — not merely remembered differently — while
 * the primary button is down, if applying it now would cost xterm's `DRAG` or
 * `MOVE` event bit (`dropsMotion`). Deferred changes settle in one place
 * (`_applyToTerm`, reached from `sync`), so they apply exactly once, the
 * moment the button is let go, recomputed fresh rather than replayed — and
 * never at all once the binding is disposed, because disposing removes the
 * mouseup/blur listener that would have triggered that recompute.
 *
 * Two parts, both here:
 *
 *   - the decisions, pure: which protocol is in force (`effectiveProtocol`),
 *     the highest flag currently requested (`requestedFromFlags`), whether a
 *     transition would cost a held drag its motion (`dropsMotion`), and what
 *     to do with each DECSET / DECRST a program sends (`planPrivateModes`).
 *     No DOM, no xterm — tests/adversarial/mouse_reporting.test.js and
 *     mouse_reporting_drag.test.js check them one rule at a time.
 *   - `installMouseReporting(term, container)`: the binding, as an xterm
 *     addon so it is disposed with its terminal. `container` (the element
 *     passed to `term.open()`) is where the primary-button state is tracked,
 *     capture-phase, so it is known before xterm's OWN mousedown handler —
 *     registered bubble-phase on `term.element`, inside `container` — runs.
 */

/**
 * DEC private modes that choose a mouse TRACKING protocol, by the name
 * `term.modes.mouseTrackingMode` reports for each. Order here is rank order,
 * lowest first: a later entry reports more (X10 only presses, VT200 adds
 * releases, DRAG adds motion while a button is held, ANY adds motion with
 * none held) — see `requestedFromFlags` and `DRAG_CAPABLE` / `MOVE_CAPABLE`.
 */
export const TRACKING_MODES = Object.freeze({ 9: 'x10', 1000: 'vt200', 1002: 'drag', 1003: 'any' });

/** The mode numbers of `TRACKING_MODES`, lowest rank first — not relied on object key order. */
const MODE_RANK = Object.freeze([9, 1000, 1002, 1003]);

/** DEC private modes that switch screens: set → alternate, reset → normal. */
export const SCREEN_MODES = Object.freeze([47, 1047, 1049]);

const PROTOCOLS = new Set(['none', ...Object.values(TRACKING_MODES)]);
const SCREENS = new Set(SCREEN_MODES);

/** Protocols that report motion while a button is held (the DRAG event bit). */
const DRAG_CAPABLE = new Set(['drag', 'any']);
/** Protocols that report motion with no button held at all (the MOVE event bit). */
const MOVE_CAPABLE = new Set(['any']);

/** No flags set — the starting state, and what RIS and leaving the alternate screen (L1) reset to. */
const NO_FLAGS = Object.freeze({});

/**
 * The tracking protocol that should be in force.
 *
 * `requested` is the highest mode flag currently set (see `requestedFromFlags`),
 * `alternate` whether the alternate buffer is active, `enabled` the "Mouse
 * Reporting in Full-Screen Apps" setting. Anything but a full-screen program
 * asking, with the setting on, is 'none'.
 */
export function effectiveProtocol({ requested = 'none', alternate = false, enabled = true } = {}) {
  if (!enabled || !alternate) return 'none';
  return PROTOCOLS.has(requested) ? requested : 'none';
}

/**
 * The highest-ranked tracking mode currently set in an independent flag set
 * (`{ [mode]: true }`, as `planPrivateModes` carries and returns — absent or
 * false means not set). Real X11 xterm keeps 9/1000/1002/1003 as independent
 * flags this way and reports through the highest one enabled; see the file
 * doc for why that, rather than xterm.js's own single last-DECSET-wins
 * variable, is what a program restating its modes as separate sequences needs.
 */
export function requestedFromFlags(flags) {
  for (let i = MODE_RANK.length - 1; i >= 0; i -= 1) {
    const mode = MODE_RANK[i];
    if (flags && flags[mode]) return TRACKING_MODES[mode];
  }
  return 'none';
}

/**
 * Would moving from protocol `current` to `next` cost xterm's DRAG or MOVE
 * event bit — the condition "never downgrade during a held button" must hold
 * back while the primary button is down (see the file doc for why: xterm's
 * drag-motion listener, once removed, comes back only on the next mousedown).
 */
export function dropsMotion(current, next) {
  if ((DRAG_CAPABLE.has(current) && !DRAG_CAPABLE.has(next)) || (MOVE_CAPABLE.has(current) && !MOVE_CAPABLE.has(next))) {
    return true;
  }
  return false;
}

/**
 * The plain parameter values of a CSI as xterm's public parser API hands them
 * over (`params.toArray()`): a sub-parameter list follows its parameter as an
 * array, and xterm's own DECSET ignores those — so does this.
 */
function modeParams(params) {
  if (!Array.isArray(params)) return [];
  return params.filter((p) => typeof p === 'number');
}

/**
 * What to do with one `CSI ? Pm h` (final 'h') or `CSI ? Pm l` (final 'l').
 *
 * Walks the parameters in order — a sequence may switch screens and ask for
 * tracking in one go (`CSI ? 1049 ; 1003 h`). `flags` is the independent
 * tracking-mode flag set carried in from before this sequence (see
 * `requestedFromFlags`); a tracking mode in the params is ADDED to it on 'h'
 * and REMOVED on 'l', each independent of the others — unlike xterm's own
 * DECSET, which treats ANY mouse-mode reset as "tracking off" and ANY set as
 * "replace whatever was active." Returns:
 *
 *   flags      the new flag set (never mutates the one passed in)
 *   requested  the highest mode now set (`requestedFromFlags(flags)`)
 *   alternate  which screen is active once the sequence has run
 *   effective  the protocol that should then be in force
 *   action     'pass'            the sequence touches no tracking mode; xterm
 *                                applies it exactly as sent
 *              'drop'            tracking modes ONLY (maybe several, maybe a
 *                                screen switch alongside — no, see below);
 *                                xterm never sees it. The flag set is updated
 *                                and the binding settles the real protocol
 *                                itself (`sync`, on-change and held-button
 *                                aware) — never xterm's own last-wins DECSET,
 *                                on EITHER screen, which is what lets a
 *                                repeated `?1000h?1002h?1003h` only ever walk
 *                                the real protocol up (see the file doc)
 *              'pass-then-sync'  tracking modes alongside a screen switch or
 *                                another mode (`?1006;1000h`, ncurses' own
 *                                `?1006;1000h`, `?1049;1003h`): xterm applies
 *                                the whole sequence — including, transiently,
 *                                its own idea of the tracking part — and the
 *                                protocol is settled again (`sync`) once the
 *                                write is parsed
 *
 * A reset always at least updates the flag set; whether it reaches xterm
 * follows the same split as a set.
 */
export function planPrivateModes({ final, params, flags = NO_FLAGS, alternate = false, enabled = true } = {}) {
  const set = final === 'h';
  const nextFlags = { ...flags };
  let alt = Boolean(alternate);
  let tracking = 0;
  let others = 0;
  for (const mode of modeParams(params)) {
    if (SCREENS.has(mode)) {
      alt = set;
      others += 1;
    } else if (TRACKING_MODES[mode]) {
      if (set) nextFlags[mode] = true;
      else delete nextFlags[mode];
      tracking += 1;
    } else {
      others += 1;
    }
  }
  const requested = requestedFromFlags(nextFlags);
  const effective = effectiveProtocol({ requested, alternate: alt, enabled });
  let action = 'pass';
  if (tracking > 0) action = others > 0 ? 'pass-then-sync' : 'drop';
  return { flags: nextFlags, requested, alternate: alt, effective, action };
}

/**
 * Does this press select text even though the program is tracking the mouse?
 *
 * Windows and Linux: Shift, xterm's own rule. macOS: ⌥ — xterm's rule once
 * `macOptionClickForcesSelection` is on, which the binding turns on while a
 * program tracks the mouse (iTerm2's convention) — and Shift with the primary
 * button, which the binding turns into ⌥ for xterm (see terminalClipboard.js),
 * so Shift-drag selects on every platform.
 */
export function pressForcesSelection(event, { mac = false } = {}) {
  if (!event) return false;
  if (!mac) return Boolean(event.shiftKey);
  return Boolean(event.altKey) || (Boolean(event.shiftKey) && (event.button ?? 0) === 0);
}

/** Does this press reach the program as a mouse report? */
export function pressReachesProgram(event, { mac = false, tracking = false } = {}) {
  return Boolean(tracking) && !pressForcesSelection(event, { mac });
}

/** `term.modes.mouseTrackingMode` → the name xterm's mouse service uses. */
const SERVICE_PROTOCOL = Object.freeze({ none: 'NONE', x10: 'X10', vt200: 'VT200', drag: 'DRAG', any: 'ANY' });
/** The reverse of `TRACKING_MODES`, for seeding the flag set from an xterm already configured. */
const MODE_OF_NAME = Object.freeze(
  Object.fromEntries(Object.entries(TRACKING_MODES).map(([mode, name]) => [name, Number(mode)]))
);

/**
 * Put a protocol in force without writing anything into the terminal.
 *
 * xterm has no public setter for it. The public route would be to write
 * `CSI ? 1003 h` into the terminal — but `term.write` queues behind whatever
 * PTY output has already arrived, a PTY read can end in the middle of an
 * escape sequence, and bytes queued there would cut the program's sequence in
 * half (its tail then prints as text). xterm gives no way to know its parser
 * is between sequences. So this sets the protocol on the mouse service xterm's
 * own DECSET uses, synchronously, and reports whether the terminal now says
 * so. Null when this xterm has no such service: the binding then leaves the
 * protocol alone where it would have changed it (see `sync`) — a program asking
 * from the scrollback is still refused, which is the part that matters.
 */
function protocolSetter(term) {
  const service = term?._core?.coreMouseService;
  if (!service || typeof service.activeProtocol !== 'string') return null;
  return (name) => {
    try {
      service.activeProtocol = SERVICE_PROTOCOL[name];
    } catch {
      return false;
    }
    return term.modes?.mouseTrackingMode === name;
  };
}

const isAlternate = (term) => term?.buffer?.active?.type === 'alternate';

const installed = new WeakMap();

/** The binding. See `installMouseReporting`. */
class MouseReportingAddon {
  constructor({ isEnabled, container }) {
    this._isEnabled = isEnabled;
    this._container = container || null;
    this._term = null;
    this._flags = NO_FLAGS;
    this._syncAfterWrite = false;
    this._setProtocol = null;
    this._disposables = [];
    this._warned = false;
    this._warnedLabels = new Set();
    this._tracking = false;
    this._trackingListeners = new Set();
    this._buttonHeld = false;
  }

  activate(term) {
    this._term = term;
    const current = term.modes?.mouseTrackingMode;
    const seedMode = PROTOCOLS.has(current) && current !== 'none' ? MODE_OF_NAME[current] : null;
    this._flags = seedMode ? { [seedMode]: true } : {};
    this._setProtocol = protocolSetter(term);
    this._wasAlternate = isAlternate(term);

    const parser = term.parser;
    if (parser?.registerCsiHandler) {
      // Run before xterm's own DECSET/DECRST: custom handlers are tried first,
      // and returning true keeps the sequence from xterm entirely.
      this._disposables.push(
        parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) =>
          this._safeguard('tracking-mode handler', () => this._privateMode('h', params), false)
        ),
        parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) =>
          this._safeguard('tracking-mode handler', () => this._privateMode('l', params), false)
        )
      );
    }
    if (parser?.registerEscHandler) {
      // RIS (`ESC c`, what `reset` sends): xterm turns tracking off and goes
      // back to the normal screen; every flag goes with it.
      this._disposables.push(
        parser.registerEscHandler({ final: 'c' }, () =>
          this._safeguard(
            'RIS handler',
            () => {
              this._flags = NO_FLAGS;
              return false;
            },
            false
          )
        )
      );
    }
    // A switch of screen is when a remembered request starts or stops
    // applying. Fired synchronously, from inside xterm's own handling of the
    // switch, so the protocol changes with the screen and not a write later.
    if (term.buffer?.onBufferChange) {
      this._disposables.push(
        term.buffer.onBufferChange(() =>
          this._safeguard('buffer-change handler', () => {
            const alternate = isAlternate(term);
            // Leaving the alternate screen forgets every flag, same as a
            // DECRST or RIS would. Without this, a program killed without
            // disabling its own tracking first (no DECRST, no RIS — just
            // gone) leaves it for the NEXT full-screen program to inherit:
            // `less`, `man`, `git log` would get the mouse the moment they
            // draw their own first alternate-screen frame, though they never
            // asked for it — the wheel sends `ESC[<64;…M` instead of
            // scrolling, and a drag stops selecting. The shell's own OSC 133
            // "D" (next prompt ready) would be the more exact moment to
            // forget it, but that only reaches terminalStore.js, keyed by
            // session id over IPC from the backend — not this module, which
            // (on purpose) knows only the one `term` it was installed on.
            // Leaving the alternate screen catches the same case: nothing
            // stays full-screen without it.
            if (this._wasAlternate && !alternate) this._flags = NO_FLAGS;
            this._wasAlternate = alternate;
            this.sync();
          })
        )
      );
    }
    if (term.onWriteParsed) {
      this._disposables.push(
        term.onWriteParsed(() =>
          this._safeguard('write-parsed handler', () => {
            if (!this._syncAfterWrite) return;
            this._syncAfterWrite = false;
            this.sync();
          })
        )
      );
    }
    this._bindButtonTracking();
    this.sync();
  }

  /**
   * Run one of this binding's OWN callbacks — everything the parser or a
   * write calls synchronously, from inside xterm's own processing, rather
   * than from a browser event (`_bindButtonTracking`'s listeners aren't
   * routed through this; a DOM event handler throwing does not wedge xterm).
   *
   * Measured in the real app: a custom parser handler that threw wedged
   * xterm's WriteBuffer for good — no further output, ever, and write
   * callbacks that never fired again. None of this is worth that: on an
   * exception, xterm is told `fallback` instead (for a parser handler,
   * `false` — "not handled", so xterm applies the sequence itself) and the
   * write proceeds. Logged once, not on every write a recurring bug would
   * otherwise spam the console with.
   */
  _safeguard(label, fn, fallback) {
    try {
      return fn();
    } catch (err) {
      // Once per LABEL, not once ever: a recurring bug in one handler should
      // not bury a later, different one under "already warned".
      if (!this._warnedLabels.has(label)) {
        this._warnedLabels.add(label);
        console.warn(`[Terminal] mouse reporting's ${label} failed; ignoring it so the terminal keeps working:`, err);
      }
      return fallback;
    }
  }

  /**
   * Track the primary-button state so a real DECSET downgrade mid-drag can be
   * deferred (see `_applyToTerm`). Capture-phase on `container` — the element
   * passed to `term.open()`, an ancestor of xterm's own `term.element` — so
   * this always learns of a press before xterm's own mousedown handler runs
   * (bubble-phase, on `term.element`), regardless of install order. Release
   * is tracked on the container's window too: a drag may end anywhere, not
   * just back over this terminal, and any mouseup, anywhere, means the SAME
   * single pointer's button is now up, wherever its coordinates land.
   *
   * `blur` is the defensive last resort — losing the window itself (OS focus
   * leaving the browser, e.g. alt-tab) rather than a clean mouseup — so it is
   * checked against `e.target === view`: focus/blur do not bubble, but a
   * CAPTURING listener on `view` still sees one from any element on the page
   * (xterm calling `this.focus()` on mousedown, for instance) — restricted to
   * events actually targeting the window itself, that does not fire merely
   * because a SECOND terminal's own press moved focus to it (observed with
   * two terminals open: the second one's mousedown blurred the first one's
   * textarea, and without this check that falsely cleared the first one's
   * held-button state mid-gesture).
   */
  _bindButtonTracking() {
    const container = this._container;
    if (!container?.addEventListener) return;
    const view = container.ownerDocument?.defaultView ?? globalThis.window ?? null;
    const onDown = (e) => {
      if ((e?.button ?? 0) === 0) this._setButtonHeld(true);
    };
    const onUp = (e) => {
      if (!e || (e.button ?? 0) === 0 || !e.buttons) this._setButtonHeld(false);
    };
    const onBlur = (e) => {
      if (!e || e.target === view) this._setButtonHeld(false);
    };
    container.addEventListener('mousedown', onDown, true);
    this._disposables.push({ dispose: () => container.removeEventListener('mousedown', onDown, true) });
    if (view?.addEventListener) {
      view.addEventListener('mouseup', onUp, true);
      view.addEventListener('blur', onBlur, true);
      this._disposables.push({
        dispose: () => {
          view.removeEventListener('mouseup', onUp, true);
          view.removeEventListener('blur', onBlur, true);
        },
      });
    }
  }

  _setButtonHeld(value) {
    const next = Boolean(value);
    if (next === this._buttonHeld) return;
    this._buttonHeld = next;
    // Released: settle whatever was held back, recomputed fresh rather than
    // replayed, so it reflects anything that happened while the button was
    // down — not necessarily what was true at the moment it was deferred.
    if (!next) this.sync();
  }

  _enabled() {
    try {
      return this._isEnabled ? this._isEnabled() !== false : true;
    } catch {
      return true;
    }
  }

  _privateMode(final, params) {
    const plan = planPrivateModes({
      final,
      params,
      flags: this._flags,
      alternate: isAlternate(this._term),
      enabled: this._enabled(),
    });
    this._flags = plan.flags;
    // Recording it now, rather than waiting for the deferred write-end sync,
    // is what lets a listener react to a full-screen program's OWN enabling
    // sequence — `CSI ? 1003 h` right after it draws its first frame, the
    // common case (htop, tmux). `isTracking` always reflects the EFFECTIVE
    // target, never whether applying it to xterm was held back for the
    // button — see `_applyToTerm`.
    this._setTracking(plan.effective !== 'none');
    if (plan.action === 'pass') return false;
    // 'drop' and 'pass-then-sync' both settle the real protocol once this
    // write is fully parsed (`onWriteParsed`), not per sequence: several
    // tracking modes set across separate sequences in the SAME write (a
    // redraw restating `?1000h?1002h?1003h`) then reach xterm as at most one
    // real change, straight to the final one — never through the
    // intermediate ones last-wins would have produced.
    this._syncAfterWrite = true;
    return plan.action === 'drop';
  }

  /** What the program has asked for, whether or not it is in force. */
  get requested() {
    return requestedFromFlags(this._flags);
  }

  /** Whether this xterm lets the protocol be changed without a write. */
  get canSetProtocol() {
    return Boolean(this._setProtocol);
  }

  /** Whether a program is being given the mouse right now (tracking in force). */
  get isTracking() {
    return this._tracking;
  }

  /**
   * Called whenever `isTracking` changes — applied or removed — with the new
   * value. Never on a press or a release: only on a transition, so a
   * subscriber that sets `term.options` from it (addon-webgl re-uploads its
   * glyph atlas texture on every change of those) never does so needlessly.
   * Returns a function that unsubscribes.
   */
  onTrackingChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._trackingListeners.add(fn);
    return () => this._trackingListeners.delete(fn);
  }

  _setTracking(value) {
    const next = Boolean(value);
    if (next === this._tracking) return;
    this._tracking = next;
    for (const listener of [...this._trackingListeners]) {
      this._safeguard('onTrackingChange listener', () => listener(next), undefined);
    }
  }

  /**
   * Make the protocol in force the one that should be. Called on every switch
   * of screen, when the setting changes, once a write carrying tracking modes
   * has been fully parsed, and the moment the primary button is let go (to
   * settle anything held back — see `_applyToTerm`). Returns whether it now
   * is (false also for a change correctly held back, not yet due).
   */
  sync() {
    const term = this._term;
    if (!term) return false;
    const target = effectiveProtocol({
      requested: this.requested,
      alternate: isAlternate(term),
      enabled: this._enabled(),
    });
    this._setTracking(target !== 'none');
    return this._applyToTerm(target);
  }

  /**
   * Set only on change — re-settling an already-active protocol is a no-op,
   * never touching xterm (no `onProtocolChange`, so no spurious disable/
   * enable of the selection service either). And never downgrade during a
   * held button: if `target` would cost xterm's DRAG or MOVE event bit
   * relative to what is CURRENTLY in force (`dropsMotion`) while the primary
   * button is down, it is held back rather than applied — xterm's own
   * drag-motion listener, once removed by that transition, would not come
   * back until the NEXT mousedown, breaking the rest of the gesture even once
   * this corrects back a moment later. `sync()` is what settles it once the
   * button is let go, recomputed fresh at that point rather than replayed.
   */
  _applyToTerm(target) {
    const term = this._term;
    const current = term.modes?.mouseTrackingMode ?? 'none';
    if (target === current) return true;
    if (this._buttonHeld && dropsMotion(current, target)) return false;
    if (this._setProtocol && this._setProtocol(target)) return true;
    if (!this._warned) {
      this._warned = true;
      console.warn(
        `[Terminal] could not switch mouse tracking from ${current} to ${target}: this xterm has no mouse service to set`
      );
    }
    return false;
  }

  dispose() {
    for (const d of this._disposables.splice(0)) d?.dispose?.();
    this._term = null;
    this._trackingListeners.clear();
  }
}

/**
 * Install the binding on a terminal, once, after `term.open(container)`.
 * `container` is that same element — used only to learn the primary-button
 * state early enough to defer a downgrade mid-drag (see
 * `MouseReportingAddon#_bindButtonTracking`); omit it and that protection is
 * simply unavailable, as on 94ec8d6. `isEnabled` reads the "Mouse Reporting in
 * Full-Screen Apps" setting, at the moment each decision is made; call
 * `sync()` on the result when it changes.
 */
export function installMouseReporting(term, container = null, { isEnabled = () => true } = {}) {
  if (!term) return null;
  const existing = installed.get(term);
  if (existing) return existing;
  const addon = new MouseReportingAddon({ isEnabled, container });
  if (typeof term.loadAddon === 'function') term.loadAddon(addon);
  else addon.activate(term);
  installed.set(term, addon);
  return addon;
}

/** The binding installed on `term`, or null. */
export function mouseReportingFor(term) {
  return (term && installed.get(term)) || null;
}

export default {
  TRACKING_MODES,
  SCREEN_MODES,
  effectiveProtocol,
  requestedFromFlags,
  dropsMotion,
  planPrivateModes,
  pressForcesSelection,
  pressReachesProgram,
  installMouseReporting,
  mouseReportingFor,
};
