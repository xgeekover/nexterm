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
 * What a program asked for is remembered either way: it takes effect the
 * moment that program switches to the alternate screen and stops the moment
 * it leaves, exactly as if it had asked again. Inside a full-screen program,
 * Shift-drag (and ⌥-drag on macOS) still selects — see `pressForcesSelection`
 * and src/lib/terminalClipboard.js, which installs this.
 *
 * Only the TRACKING protocols are gated (9, 1000, 1002, 1003). The encodings
 * (1005, 1006, 1015, 1016) and focus reporting (1004) are not mouse events in
 * themselves and reach xterm untouched, so a program that asked for SGR
 * reports gets SGR reports the moment tracking takes effect.
 *
 * Two parts, both here:
 *
 *   - the decisions, pure: which protocol is in force (`effectiveProtocol`)
 *     and what to do with each DECSET / DECRST a program sends
 *     (`planPrivateModes`). No DOM, no xterm — tests/adversarial/
 *     terminal_clipboard.test.js checks them one rule at a time.
 *   - `installMouseReporting(term)`: the binding, as an xterm addon so it is
 *     disposed with its terminal.
 */

/**
 * DEC private modes that choose a mouse TRACKING protocol, by the name
 * `term.modes.mouseTrackingMode` reports for each.
 *
 * xterm keeps one protocol at a time: setting any of these replaces the
 * previous one, and resetting ANY of them turns tracking off (as xterm itself
 * does — `CSI ? 1000 l` ends a 1003 too).
 */
export const TRACKING_MODES = Object.freeze({ 9: 'x10', 1000: 'vt200', 1002: 'drag', 1003: 'any' });

/** DEC private modes that switch screens: set → alternate, reset → normal. */
export const SCREEN_MODES = Object.freeze([47, 1047, 1049]);

const PROTOCOLS = new Set(['none', ...Object.values(TRACKING_MODES)]);
const SCREENS = new Set(SCREEN_MODES);

/**
 * The tracking protocol that should be in force.
 *
 * `requested` is what the program last asked for, `alternate` whether the
 * alternate buffer is active, `enabled` the "Mouse Reporting in Full-Screen
 * Apps" setting. Anything but a full-screen program asking, with the setting
 * on, is 'none'.
 */
export function effectiveProtocol({ requested = 'none', alternate = false, enabled = true } = {}) {
  if (!enabled || !alternate) return 'none';
  return PROTOCOLS.has(requested) ? requested : 'none';
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
 * Walks the parameters in order, as xterm does — a sequence may switch screens
 * and ask for tracking in one go (`CSI ? 1049 ; 1003 h`), and which screen the
 * tracking lands on decides whether it may take effect. Returns:
 *
 *   requested  what the program has now asked for ('none' after a reset)
 *   alternate  which screen is active once the sequence has run
 *   effective  the protocol that should then be in force
 *   action     'pass'            xterm applies the sequence as sent — either
 *                                it touches no tracking mode, or what it asks
 *                                for may take effect
 *              'drop'            it only asks for tracking that must not take
 *                                effect here; xterm never sees it, so it does
 *                                not even clear the user's selection
 *              'pass-then-sync'  it asks for tracking that must not take
 *                                effect AND for other modes (`?1003;1006h`,
 *                                ncurses' `?1006;1000h`); xterm applies all of
 *                                it, and the protocol is put back as soon as
 *                                the write is parsed — before any mouse event
 *                                can reach the terminal
 *
 * A reset always passes: turning tracking off is right on either screen.
 */
export function planPrivateModes({ final, params, requested = 'none', alternate = false, enabled = true } = {}) {
  const set = final === 'h';
  let next = PROTOCOLS.has(requested) ? requested : 'none';
  let alt = Boolean(alternate);
  let tracking = 0;
  let others = 0;
  for (const mode of modeParams(params)) {
    if (SCREENS.has(mode)) {
      alt = set;
      others += 1;
    } else if (TRACKING_MODES[mode]) {
      next = set ? TRACKING_MODES[mode] : 'none';
      tracking += 1;
    } else {
      others += 1;
    }
  }
  const effective = effectiveProtocol({ requested: next, alternate: alt, enabled });
  // Run as sent, the sequence leaves xterm in `next`.
  let action = 'pass';
  if (tracking > 0 && next !== effective) action = others > 0 ? 'pass-then-sync' : 'drop';
  return { requested: next, alternate: alt, effective, action };
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
  constructor({ isEnabled }) {
    this._isEnabled = isEnabled;
    this._term = null;
    this._requested = 'none';
    this._syncAfterWrite = false;
    this._setProtocol = null;
    this._disposables = [];
    this._warned = false;
  }

  activate(term) {
    this._term = term;
    const current = term.modes?.mouseTrackingMode;
    this._requested = PROTOCOLS.has(current) ? current : 'none';
    this._setProtocol = protocolSetter(term);

    const parser = term.parser;
    if (parser?.registerCsiHandler) {
      // Run before xterm's own DECSET/DECRST: custom handlers are tried first,
      // and returning true keeps the sequence from xterm entirely.
      this._disposables.push(
        parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => this._privateMode('h', params)),
        parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => this._privateMode('l', params))
      );
    }
    if (parser?.registerEscHandler) {
      // RIS (`ESC c`, what `reset` sends): xterm turns tracking off and goes
      // back to the normal screen; the program's request goes with it.
      this._disposables.push(
        parser.registerEscHandler({ final: 'c' }, () => {
          this._requested = 'none';
          return false;
        })
      );
    }
    // A switch of screen is when a remembered request starts or stops
    // applying. Fired synchronously, from inside xterm's own handling of the
    // switch, so the protocol changes with the screen and not a write later.
    if (term.buffer?.onBufferChange) this._disposables.push(term.buffer.onBufferChange(() => this.sync()));
    if (term.onWriteParsed) {
      this._disposables.push(
        term.onWriteParsed(() => {
          if (!this._syncAfterWrite) return;
          this._syncAfterWrite = false;
          this.sync();
        })
      );
    }
    this.sync();
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
      requested: this._requested,
      alternate: isAlternate(this._term),
      enabled: this._enabled(),
    });
    this._requested = plan.requested;
    if (plan.action === 'drop') return true;
    if (plan.action === 'pass-then-sync') this._syncAfterWrite = true;
    return false;
  }

  /** What the program has asked for, whether or not it is in force. */
  get requested() {
    return this._requested;
  }

  /** Whether this xterm lets the protocol be changed without a write. */
  get canSetProtocol() {
    return Boolean(this._setProtocol);
  }

  /**
   * Make the protocol in force the one that should be. Called on every switch
   * of screen, when the setting changes, and after a sequence that carried a
   * refused request along with other modes. Returns whether it now is.
   */
  sync() {
    const term = this._term;
    if (!term) return false;
    const target = effectiveProtocol({
      requested: this._requested,
      alternate: isAlternate(term),
      enabled: this._enabled(),
    });
    const current = term.modes?.mouseTrackingMode ?? 'none';
    if (target === current) return true;
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
  }
}

/**
 * Install the binding on a terminal, once, after `term.open()`. `isEnabled`
 * reads the "Mouse Reporting in Full-Screen Apps" setting, at the moment each
 * decision is made; call `sync()` on the result when it changes.
 */
export function installMouseReporting(term, { isEnabled = () => true } = {}) {
  if (!term) return null;
  const existing = installed.get(term);
  if (existing) return existing;
  const addon = new MouseReportingAddon({ isEnabled });
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
  planPrivateModes,
  pressForcesSelection,
  pressReachesProgram,
  installMouseReporting,
  mouseReportingFor,
};
