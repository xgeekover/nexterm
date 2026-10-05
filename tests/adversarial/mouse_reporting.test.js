/**
 * The mouse goes to full-screen programs only, a drag anywhere else selects,
 * and a selection is copied as it is made (src/lib/mouseReporting.js,
 * src/lib/terminalClipboard.js).
 *
 * Measured in the real app on macOS: Claude Code turns on mouse tracking "any"
 * (DECSET 1003) at its main prompt, in the NORMAL buffer. Every drag in that
 * pane then went to Claude and xterm's selection was off — nothing could be
 * selected, so nothing could be copied — and on macOS xterm had no override.
 *
 * Three layers, each checked here:
 *
 *   MR  the decisions, pure — which protocol is in force, what each DECSET /
 *       DECRST a program sends does
 *   MB  the binding against a stand-in xterm that does what xterm 5.5 and 6.0 do
 *       with those sequences (InputHandler.setModePrivate / resetModePrivate,
 *       CoreMouseService, BufferSet), so the wiring — parser handlers tried
 *       before xterm's own, the switch of screen, the end of a write — is
 *       exercised in Node. The real xterm is driven headless, see the PR.
 *   CS  selection and copy on select, against fake DOM events
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  TRACKING_MODES,
  effectiveProtocol,
  planPrivateModes,
  pressForcesSelection,
  pressReachesProgram,
  installMouseReporting,
  mouseReportingFor,
} from '../../src/lib/mouseReporting.js';
import {
  pressSelects,
  shouldCopyOnSelect,
  copyTerminalSelection,
  installTerminalClipboard,
  terminalClipboardFor,
} from '../../src/lib/terminalClipboard.js';
import { FakeXterm, withBinding } from './mouse_reporting_fixtures.js';

// `FakeXterm` and `withBinding` (a FakeXterm with mouse reporting installed,
// plus the fake container/view its button-tracking listens on) are shared
// with mouse_reporting_drag.test.js — see mouse_reporting_fixtures.js.

describe('Mouse reporting: which protocol is in force (pure)', () => {
  test('MR-01: only a full-screen program that asked, with the setting on', () => {
    for (const requested of ['x10', 'vt200', 'drag', 'any']) {
      assert.equal(effectiveProtocol({ requested, alternate: true }), requested, `${requested} on the alternate screen`);
      assert.equal(effectiveProtocol({ requested, alternate: false }), 'none', `${requested} in the scrollback`);
      assert.equal(effectiveProtocol({ requested, alternate: true, enabled: false }), 'none', `${requested}, setting off`);
    }
    assert.equal(effectiveProtocol({ requested: 'none', alternate: true }), 'none');
    assert.equal(effectiveProtocol({ requested: 'bogus', alternate: true }), 'none', 'an unknown name is not a protocol');
    assert.equal(effectiveProtocol(), 'none');
  });

  test('MR-02: Claude Code\'s 1003 at its prompt (normal buffer) is dropped — and remembered', () => {
    assert.deepEqual(planPrivateModes({ final: 'h', params: [1003] }), {
      flags: { 1003: true },
      requested: 'any',
      alternate: false,
      effective: 'none',
      action: 'drop',
    });
    for (const [mode, name] of Object.entries(TRACKING_MODES)) {
      const plan = planPrivateModes({ final: 'h', params: [Number(mode)] });
      assert.equal(plan.action, 'drop', `?${mode}h in the scrollback`);
      assert.equal(plan.requested, name);
    }
  });

  test('MR-03: on the alternate screen a request is still handled here — but now takes effect', () => {
    // xterm's own DECSET never sees a tracking mode, on EITHER screen — only
    // that way can this (not xterm's last-wins) decide what stays in force
    // when a program restates its modes as separate sequences. See MR-08.
    for (const [mode, name] of Object.entries(TRACKING_MODES)) {
      const plan = planPrivateModes({ final: 'h', params: [Number(mode)], alternate: true });
      assert.deepEqual(plan, { flags: { [mode]: true }, requested: name, alternate: true, effective: name, action: 'drop' }, `?${mode}h`);
    }
    // The setting being off still means this handles it (xterm never sees a
    // tracking mode either way) — just refused once settled.
    const off = planPrivateModes({ final: 'h', params: [1000], alternate: true, enabled: false });
    assert.equal(off.action, 'drop');
    assert.equal(off.effective, 'none');
  });

  test('MR-04: a refused request carrying other modes passes, to be put back once parsed', () => {
    // Claude-style and ncurses-style (XM is ?1006;1000h) — the SGR encoding
    // and bracketed paste in the same sequence must still reach xterm.
    for (const params of [[1003, 1006], [1006, 1000], [2004, 1003], [1002, 1004]]) {
      const plan = planPrivateModes({ final: 'h', params });
      assert.equal(plan.action, 'pass-then-sync', JSON.stringify(params));
      assert.equal(plan.effective, 'none');
    }
  });

  test('MR-05: a sequence that switches screens together with a tracking request settles once parsed', () => {
    // Entering the alternate screen in the same breath: allowed, either
    // order — but xterm has to see the screen-switch param itself, so this
    // can only settle the tracking part afterward, not swallow it outright.
    for (const params of [[1049, 1003], [1003, 1049], [47, 1000], [1047, 1002]]) {
      const plan = planPrivateModes({ final: 'h', params });
      assert.equal(plan.action, 'pass-then-sync', JSON.stringify(params));
      assert.equal(plan.alternate, true);
      assert.equal(plan.effective, plan.requested);
    }
    // With the setting off, same shape: xterm still has to see the screen switch.
    assert.equal(planPrivateModes({ final: 'h', params: [1049, 1003], enabled: false }).action, 'pass-then-sync');
  });

  test('MR-06: a reset clears only its OWN flag, independent of the others, and is handled here too', () => {
    for (const mode of [9, 1000, 1002, 1003]) {
      for (const alternate of [false, true]) {
        const plan = planPrivateModes({ final: 'l', params: [mode], flags: { [mode]: true }, alternate });
        assert.equal(plan.action, 'drop', `?${mode}l`);
        assert.equal(plan.requested, 'none', `?${mode}l, nothing else was set`);
        assert.deepEqual(plan.flags, {}, `?${mode}l clears its own flag`);
      }
    }
    // Leaving the alternate screen alone (no tracking mode in THIS sequence)
    // is untouched, same as any other screen switch, and remembers nothing —
    // the program never reset anything itself. (Forgetting on L1 — because
    // the alternate screen was left — is the binding's job, not this pure
    // per-sequence plan: see MB-04.)
    const leave = planPrivateModes({ final: 'l', params: [1049], flags: { 1000: true }, alternate: true });
    assert.deepEqual(leave, { flags: { 1000: true }, requested: 'vt200', alternate: false, effective: 'none', action: 'pass' });
  });

  test('MR-06b: independent flags for a SET — but a RESET of any one clears every flag, xterm.js-compatible', () => {
    // Claude resends `?1000h` alone (an Ink redraw) while 1003 is already on:
    // a SET is still independent/additive — nothing is cleared, and the
    // highest of the two stays in force. VTE/Alacritty/WezTerm-style, not
    // xterm.js's own "replace whatever was active" — see the file doc.
    const resend = planPrivateModes({ final: 'h', params: [1000], flags: { 1003: true }, alternate: true });
    assert.equal(resend.requested, 'any', '?1000h with 1003 already on → still any');
    assert.deepEqual(resend.flags, { 1000: true, 1003: true });

    // A RESET is NOT independent, though: turning off any ONE of
    // 9/1000/1002/1003 turns tracking off outright, same as xterm's own
    // DECRST — not just that one mode's own flag. Otherwise a program that
    // turns the mouse off with a single DECRST (the common case) would keep
    // getting reports merely because it had set a higher mode earlier and
    // never explicitly reset THAT one too.
    const resetLower = planPrivateModes({ final: 'l', params: [1000], flags: { 1000: true, 1003: true }, alternate: true });
    assert.equal(resetLower.requested, 'none', '?1000l, even with 1003 also on, turns tracking off entirely');
    assert.deepEqual(resetLower.flags, {}, 'every flag clears, not just 1000\'s own');

    // Same when it is the currently-highest one that is reset directly —
    // a genuine downgrade (what "never downgrade during a held button", in
    // src/lib/mouseReporting.js, exists for).
    const resetHigher = planPrivateModes({ final: 'l', params: [1003], flags: { 1000: true, 1003: true }, alternate: true });
    assert.equal(resetHigher.requested, 'none', '?1003l, even with 1000 also on, turns tracking off entirely');
    assert.deepEqual(resetHigher.flags, {});
  });

  test('MR-07: encodings, focus and every other mode are never touched', () => {
    for (const mode of [1004, 1005, 1006, 1015, 1016, 2004, 25, 1, 7, 12]) {
      for (const final of ['h', 'l']) {
        for (const alternate of [false, true]) {
          const plan = planPrivateModes({ final, params: [mode], flags: { 1002: true }, alternate });
          assert.equal(plan.action, 'pass', `?${mode}${final}`);
          assert.equal(plan.requested, 'drag', `?${mode}${final} leaves the flags alone`);
          assert.deepEqual(plan.flags, { 1002: true });
        }
      }
    }
  });

  test('MR-08: every listed mode is set together — not last-wins — and sub-parameters are ignored like xterm does', () => {
    assert.equal(planPrivateModes({ final: 'h', params: [1000, 1002, 1003], alternate: true }).requested, 'any');
    // DECSET sets EVERYTHING it lists, together — 1000 and 1003 both end up
    // on, so the highest of the two is requested, not whichever came last.
    assert.equal(planPrivateModes({ final: 'h', params: [1003, 1000], alternate: true }).requested, 'any');
    const withSubs = planPrivateModes({ final: 'h', params: [1003, [1, 2]] });
    assert.deepEqual(withSubs, { flags: { 1003: true }, requested: 'any', alternate: false, effective: 'none', action: 'drop' });
    assert.equal(planPrivateModes({ final: 'h', params: [] }).action, 'pass');
    assert.equal(planPrivateModes({ final: 'h' }).action, 'pass');
  });

  test('MR-09: which presses select instead of reaching a tracking program', () => {
    const press = (fields) => ({ button: 0, shiftKey: false, altKey: false, ...fields });
    // Windows and Linux: Shift, xterm's own rule.
    assert.equal(pressForcesSelection(press({ shiftKey: true })), true);
    assert.equal(pressForcesSelection(press({ altKey: true })), false, 'Alt is column selection there, not an override');
    assert.equal(pressForcesSelection(press({ shiftKey: true, button: 2 })), true, 'xterm checks no button');
    // macOS: ⌥ (any button), and Shift with the primary button.
    assert.equal(pressForcesSelection(press({ altKey: true }), { mac: true }), true);
    assert.equal(pressForcesSelection(press({ shiftKey: true }), { mac: true }), true);
    assert.equal(pressForcesSelection(press({ shiftKey: true, button: 2 }), { mac: true }), false);
    assert.equal(pressForcesSelection(press({}), { mac: true }), false);
    assert.equal(pressForcesSelection(null), false);
    // Reaching the program needs tracking AND no override.
    assert.equal(pressReachesProgram(press({}), { tracking: true }), true);
    assert.equal(pressReachesProgram(press({}), { tracking: false }), false);
    assert.equal(pressReachesProgram(press({ shiftKey: true }), { tracking: true, mac: true }), false);
    assert.equal(pressReachesProgram(press({ altKey: true }), { tracking: true, mac: true }), false);
  });
});

describe('Mouse reporting: the binding, against xterm\'s own handling', () => {
  test('MB-01: Claude Code — 1003 in the scrollback is refused, and a selection survives it', () => {
    const { term, binding } = withBinding();
    term.selection = 'copy this';
    term.write('\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'none', 'not in force');
    assert.equal(binding.requested, 'any', 'remembered');
    assert.equal(term.selection, 'copy this', 'xterm never saw it, so it never cleared the selection');
    assert.equal(term.selectionClears, 0);
    // A program asking again (Ink redraws) changes nothing.
    term.write('\x1b[?1003h\x1b[?1003h');
    assert.equal(term.selection, 'copy this');
  });

  test('MB-02: …and takes effect the moment that program goes full-screen, and stops when it leaves', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1003h');
    term.write('\x1b[?1049h');
    assert.equal(term.modes.mouseTrackingMode, 'any', 'in force on the alternate screen');
    term.write('\x1b[?1049l');
    assert.equal(term.modes.mouseTrackingMode, 'none', 'off again in the scrollback');
    // L1: forgotten the moment the alternate screen is left, same as a DECRST
    // or RIS — see MB-04 for why.
    assert.equal(binding.requested, 'none', 'not remembered past leaving the alternate screen');
    term.write('\x1b[?1003l');
    assert.equal(binding.requested, 'none');
  });

  test('MB-03: vim — enters the alternate screen, asks for 1000 + SGR, gets both; leaves clean', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
    assert.equal(term.encoding, 'SGR');
    term.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    assert.equal(binding.requested, 'none');
    assert.equal(term.screen, 'normal');
  });

  test('MB-04 (L1): a program that dies on the alternate screen with tracking on leaves the scrollback selectable, and the next program starts clean', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1049h\x1b[?1002h');
    assert.equal(term.modes.mouseTrackingMode, 'drag');
    term.write('\x1b[?1049l'); // `reset`-less recovery: just the screen switch — killed, not exited
    assert.equal(term.modes.mouseTrackingMode, 'none');
    assert.equal(binding.requested, 'none', 'forgotten along with the screen, not just suspended');
    // fails on f8a757d: the next full-screen program used to inherit it —
    // `less`, `man`, `git log` would get the mouse (the wheel as `ESC[<64;…M`
    // instead of scrolling, a drag not selecting) though none of them ever
    // asked for it themselves.
    term.write('\x1b[?1049h');
    assert.equal(term.modes.mouseTrackingMode, 'none', 'the next program starts clean, not inheriting a dead one\'s request');
    term.write('\x1b[?1000h'); // but asking for its own still works, same as any program
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
  });

  test('MB-05: one sequence that enters the alternate screen and asks for tracking, either order', () => {
    for (const seq of ['\x1b[?1049;1003h', '\x1b[?1003;1049h']) {
      const { term } = withBinding();
      term.write(seq);
      assert.equal(term.screen, 'alternate', seq);
      assert.equal(term.modes.mouseTrackingMode, 'any', seq);
    }
  });

  test('MB-06: a refused request mixed with other modes: the others apply, tracking is back off by the end of the write', () => {
    const { term, binding } = withBinding();
    let seenDuringWrite = null;
    term.write('\x1b[?2004;1003;1006h', () => {
      seenDuringWrite = term.modes.mouseTrackingMode;
    });
    assert.equal(term.bracketed, true, 'bracketed paste applied');
    assert.equal(term.encoding, 'SGR', 'SGR applied');
    assert.equal(seenDuringWrite, 'any', 'xterm applied the whole sequence…');
    assert.equal(term.modes.mouseTrackingMode, 'none', '…and the protocol was put back once it was parsed');
    assert.equal(binding.requested, 'any');
  });

  test('MB-07: the setting — off takes the mouse away at once, on gives back what was asked', () => {
    const { term, binding, setting } = withBinding();
    term.write('\x1b[?1049h\x1b[?1002h');
    setting.on = false;
    binding.sync();
    assert.equal(term.modes.mouseTrackingMode, 'none');
    // Asked again while off: refused.
    term.write('\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    setting.on = true;
    binding.sync();
    assert.equal(term.modes.mouseTrackingMode, 'any', 'the latest request');
  });

  test('MB-08: RIS (`reset`) forgets the request along with everything else', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1003h');
    term.write('\x1bc');
    assert.equal(binding.requested, 'none');
    term.write('\x1b[?1049h');
    assert.equal(term.modes.mouseTrackingMode, 'none', 'nothing comes back on the next full-screen program');
  });

  test('MB-09 (LOW 4): no settable mouse service — falls back to passing every tracking sequence straight to xterm', () => {
    // `_applyToTerm` has no setter to call once a sequence is intercepted on
    // an xterm like this, so dropping it here (the normal gating) would
    // refuse every full-screen program's request FOR GOOD. Fails on
    // 4fc2c7e: used to stay 'none' forever instead, meaning a full-screen
    // program never got the mouse at all on such a terminal.
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const { term, binding } = withBinding({ mouseService: false });
      assert.equal(binding.canSetProtocol, false);

      term.write('\x1b[?1003h');
      assert.equal(term.modes.mouseTrackingMode, 'any', 'ungated: xterm applied it natively, as it would have before this file existed');
      assert.equal(binding.requested, 'any');

      term.write('\x1b[?1049h'); // full-screen too — same ungated passthrough, no special casing
      assert.equal(term.modes.mouseTrackingMode, 'any');
      term.write('\x1b[?1003l\x1b[?1049l');
      assert.equal(term.modes.mouseTrackingMode, 'none');
      assert.equal(warnings.length, 0, 'never even tries to call a setter that does not exist');
    } finally {
      console.warn = warn;
    }
  });

  test('MB-09b (LOW 4): FakeXterm lacking `_core` entirely — `canSetProtocol` is false, not merely unset', () => {
    const term = new FakeXterm({ mouseService: false });
    assert.equal(term._core, undefined);
    const binding = installMouseReporting(term, null, { isEnabled: () => true });
    assert.equal(binding.canSetProtocol, false);
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    assert.equal(term.modes.mouseTrackingMode, 'any', 'every mode applied natively, including the non-tracking ones');
    assert.equal(term.encoding, 'SGR');
  });

  test('MB-10: installed once per terminal, and disposed with it', () => {
    const term = new FakeXterm();
    const first = installMouseReporting(term);
    assert.equal(installMouseReporting(term), first);
    assert.equal(mouseReportingFor(term), first);
    assert.equal(term.csi.h.length, 1);
    term.dispose();
    assert.equal(term.csi.h.length + term.csi.l.length + term.esc.length, 0, 'parser handlers gone');
    assert.equal(term.bufferListeners.size + term.parsedListeners.size, 0, 'listeners gone');
    term.write('\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'any', 'xterm alone again');
    assert.equal(installMouseReporting(null), null);
  });

  test('MB-11 (M1/L4b): onTrackingChange fires exactly on a real transition, never on a no-op write', () => {
    const { term, binding, setting } = withBinding();
    const seen = [];
    binding.onTrackingChange((v) => seen.push(v));
    assert.equal(binding.isTracking, false);

    // htop/tmux: switch to the alternate screen, THEN ask for the mouse as a
    // separate sequence — a plain "pass" (MR-03), the common real-world case
    // and the one a check made only at the next click would miss until then.
    term.write('\x1b[?1049h');
    assert.deepEqual(seen, [], 'the screen switch alone asked for no tracking');
    term.write('\x1b[?1000h');
    assert.deepEqual(seen, [true]);
    assert.equal(binding.isTracking, true);

    // Asking again (an Ink-style redraw) changes nothing.
    term.write('\x1b[?1000h');
    assert.deepEqual(seen, [true], 'no second notification for an unchanged state');

    // The program dies without disabling tracking first (MB-04).
    term.write('\x1b[?1049l');
    assert.deepEqual(seen, [true, false]);

    // A request refused in the scrollback (MB-01) notifies only once it takes
    // effect — the moment the screen switches to alternate, not before.
    seen.length = 0;
    term.write('\x1b[?1003h');
    assert.deepEqual(seen, [], 'refused throughout: no transition');
    term.write('\x1b[?1049h');
    assert.deepEqual(seen, [true], 'the remembered request took effect');

    // The setting is the third way tracking can stop applying, and resume.
    seen.length = 0;
    setting.on = false;
    binding.sync();
    assert.deepEqual(seen, [false]);
    setting.on = true;
    binding.sync();
    assert.deepEqual(seen, [false, true]);
    binding.sync(); // already settled: no further notification
    assert.deepEqual(seen, [false, true]);

    // A refused request mixed with other modes (MB-06), entirely in the
    // scrollback: applied then put right back before anything else can run
    // — never effective, so never a transition.
    term.write('\x1b[?1049l');
    seen.length = 0;
    term.write('\x1b[?2004;1003;1006h');
    assert.deepEqual(seen, [], 'pass-then-sync, but never effective');

    assert.equal(typeof binding.onTrackingChange(() => {}), 'function', 'always returns an unsubscribe function');
    assert.equal(binding.onTrackingChange(null)(), undefined, 'a non-function listener is ignored, harmlessly');
  });

  test('MB-12 (LOW 6): a second onTrackingChange listener\'s own failure is still logged, under its own label', () => {
    const { term, binding } = withBinding();
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      binding.onTrackingChange(function listenerA() {
        throw new Error('boom from A');
      });
      const seenB = [];
      binding.onTrackingChange(function listenerB(v) {
        seenB.push(v);
        throw new Error('boom from B');
      });

      // Both listeners run on the same transition; both throw.
      term.write('\x1b[?1049h\x1b[?1000h');
      assert.deepEqual(seenB, [true], 'B still ran, despite A throwing first');
      // Fails on 4fc2c7e: every listener shared ONE generic label, so only
      // the FIRST failure ever got logged — B's own, distinct failure never
      // did, silently, forever.
      assert.equal(warnings.length, 2, 'A and B are each logged once, under their own label');
      assert.ok(warnings.some((w) => w.includes('listener 0') && w.includes('listenerA')), warnings.join(' | '));
      assert.ok(warnings.some((w) => w.includes('listener 1') && w.includes('listenerB')), warnings.join(' | '));

      // Each recurs on a later transition: already warned under its OWN
      // label, so silent again — same "once per bug source" rule as any
      // other `_safeguard` label.
      term.write('\x1b[?1049l');
      assert.equal(warnings.length, 2, 'no further warnings for the SAME listeners repeating the SAME failure');
    } finally {
      console.warn = warn;
    }
  });
});

// ---- selection and copy on select -------------------------------------------

/** Capture-phase listeners only, dispatched in registration order — what the bindings use. */
class FakeTarget {
  constructor() {
    this.listeners = [];
  }
  addEventListener(type, fn, capture) {
    this.listeners.push({ type, fn, capture: capture === true });
  }
  removeEventListener(type, fn, capture) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === (capture === true)));
  }
  dispatch(event) {
    for (const l of this.listeners.filter((x) => x.type === event.type && x.capture)) l.fn(event);
  }
}

function mouseEvent(type, fields = {}) {
  return {
    type,
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...fields,
  };
}

/** A fake page: a window, a container inside it, a document with focus and execCommand. */
function page(term) {
  const view = new FakeTarget();
  const container = new FakeTarget();
  container.ownerDocument = { defaultView: view };
  const doc = {
    activeElement: term.textarea,
    listeners: [],
    allowCopy: true,
    clipboard: null,
    xtermStandsAside: false,
    addEventListener(type, fn) {
      this.listeners.push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners = this.listeners.filter((l) => l !== fn);
    },
    // Chromium/WebKit: a copy event at the focused element, xterm's listener on
    // its element first (it fills the data and cancels), then the document's.
    execCommand(cmd) {
      if (cmd !== 'copy' || !this.allowCopy) return false;
      const data = {};
      const e = {
        type: 'copy',
        defaultPrevented: false,
        clipboardData: { setData: (k, v) => (data[k] = v), getData: (k) => data[k] },
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      if (!this.xtermStandsAside && term.hasSelection()) {
        e.clipboardData.setData('text/plain', term.getSelection());
        e.preventDefault();
      }
      for (const fn of [...this.listeners]) fn(e);
      if (e.defaultPrevented) this.clipboard = data['text/plain'];
      return true;
    },
  };
  return { view, container, doc };
}

/** What xterm (5.5 and 6.0 alike) does with a press: select (forced or not) or report it. */
function xtermVerdict(term, e, { mac }) {
  const tracking = term.modes.mouseTrackingMode !== 'none';
  if (!tracking) return 'select';
  const forced = mac ? Boolean(e.altKey && term.options.macOptionClickForcesSelection) : Boolean(e.shiftKey);
  return forced ? 'select' : 'report';
}

describe('Selection and copy on select', () => {
  test('CS-01: which presses select, and when a release copies', () => {
    assert.equal(pressSelects({ button: 0 }), true, 'no tracking: every primary press selects');
    assert.equal(pressSelects({ button: 2 }), false, 'never the right button');
    assert.equal(pressSelects({ button: 0 }, { tracking: true }), false, 'the program gets it');
    assert.equal(pressSelects({ button: 0, shiftKey: true }, { tracking: true }), true);
    assert.equal(pressSelects({ button: 0, altKey: true }, { tracking: true }), false, 'Alt is no override off macOS');
    assert.equal(pressSelects({ button: 0, altKey: true }, { tracking: true, mac: true }), true);
    assert.equal(pressSelects({ button: 0, shiftKey: true }, { tracking: true, mac: true }), true);
    assert.equal(pressSelects(null), false);

    assert.equal(shouldCopyOnSelect({ selecting: true, hasSelection: true }), true);
    assert.equal(shouldCopyOnSelect({ selecting: true, hasSelection: true, enabled: false }), false, 'setting off');
    assert.equal(shouldCopyOnSelect({ selecting: false, hasSelection: true }), false, 'a click the program got');
    assert.equal(shouldCopyOnSelect({ selecting: true, hasSelection: false }), false, 'a plain click clears');
  });

  test('CS-02: macOS, a program tracking the mouse — Shift-press becomes xterm\'s ⌥ override', () => {
    const term = new FakeXterm();
    const { view, container, doc } = page(term);
    installTerminalClipboard(term, container, { platform: 'mac' });
    term.write('\x1b[?1049h\x1b[?1000h');

    const shift = mouseEvent('mousedown', { shiftKey: true });
    view.dispatch(shift);
    container.dispatch(shift);
    assert.equal(term.options.macOptionClickForcesSelection, true, '⌥ forces selection while tracking');
    assert.equal(shift.altKey, true, 'relabelled for xterm');
    assert.equal(xtermVerdict(term, shift, { mac: true }), 'select');

    const plain = mouseEvent('mousedown');
    container.dispatch(plain);
    assert.equal(xtermVerdict(term, plain, { mac: true }), 'report', 'a plain press still goes to the program');

    const right = mouseEvent('mousedown', { shiftKey: true, button: 2 });
    container.dispatch(right);
    assert.equal(right.altKey, false, 'only the primary button is relabelled');

    // Back in the scrollback, ⌥-drag is xterm's column selection again.
    term.write('\x1b[?1000l\x1b[?1049l');
    const option = mouseEvent('mousedown', { altKey: true });
    container.dispatch(option);
    assert.equal(term.options.macOptionClickForcesSelection, false);
    const shiftAtPrompt = mouseEvent('mousedown', { shiftKey: true });
    container.dispatch(shiftAtPrompt);
    assert.equal(shiftAtPrompt.altKey, false, 'Shift-click extends the selection at a prompt — untouched');
    assert.ok(doc);
  });

  test('CS-03: Windows and Linux leave Shift to xterm — it already forces selection there', () => {
    for (const platform of ['windows', 'linux']) {
      const term = new FakeXterm();
      const { container } = page(term);
      installTerminalClipboard(term, container, { platform });
      term.write('\x1b[?1049h\x1b[?1003h');
      const shift = mouseEvent('mousedown', { shiftKey: true });
      container.dispatch(shift);
      assert.equal(shift.altKey, false, platform);
      assert.equal(term.options.macOptionClickForcesSelection, undefined, `${platform}: no macOS option set`);
      assert.equal(xtermVerdict(term, shift, { mac: false }), 'select', platform);
    }
  });

  /** Press in the terminal, let "xterm" select, release on the window. */
  function gesture(env, { press = {}, selectionAfter = 'copy this', mac = false } = {}) {
    const { term, view, container } = env;
    const down = mouseEvent('mousedown', press);
    view.dispatch(down);
    container.dispatch(down);
    if (xtermVerdict(term, down, { mac }) === 'select' && (down.button ?? 0) === 0) term.selection = selectionAfter;
    view.dispatch(mouseEvent('mouseup', { button: press.button ?? 0 }));
  }

  function clipboardEnv(platform = 'linux', settingsState = {}) {
    const term = new FakeXterm();
    const { view, container, doc } = page(term);
    const state = { terminalCopyOnSelect: true, terminalMouseReporting: true, ...settingsState };
    const settings = { getState: () => state, subscribe: () => () => {} };
    const realDocument = globalThis.document;
    globalThis.document = doc;
    installTerminalClipboard(term, container, { platform, settings });
    return {
      term,
      view,
      container,
      doc,
      state,
      restore: () => {
        globalThis.document = realDocument;
      },
    };
  }

  test('CS-04: a drag copies on release; a click the program got does not copy an old selection again', () => {
    const env = clipboardEnv('linux');
    try {
      gesture(env, { selectionAfter: 'copy this sentence' });
      assert.equal(env.doc.clipboard, 'copy this sentence', 'copied by the release');

      // A full-screen program tracking the mouse; the user Shift-selects…
      env.term.write('\x1b[?1049h\x1b[?1000h');
      gesture(env, { press: { shiftKey: true }, selectionAfter: 'full screen' });
      assert.equal(env.doc.clipboard, 'full screen');
      // …copies something else elsewhere, then clicks in the program.
      env.doc.clipboard = 'from another app';
      gesture(env, { selectionAfter: 'never selected' });
      assert.equal(env.term.selection, 'full screen', 'the old selection still stands');
      assert.equal(env.doc.clipboard, 'from another app', 'and was not copied back over the clipboard');
    } finally {
      env.restore();
    }
  });

  test('CS-05: no copy for the right button, a press outside the terminal, or with the setting off', () => {
    const env = clipboardEnv('windows');
    try {
      gesture(env, { press: { button: 2 } });
      assert.equal(env.doc.clipboard, null, 'right button');

      env.term.selection = 'standing';
      env.view.dispatch(mouseEvent('mousedown')); // a press elsewhere in the window
      env.view.dispatch(mouseEvent('mouseup'));
      assert.equal(env.doc.clipboard, null, 'not this terminal\'s gesture');

      env.state.terminalCopyOnSelect = false;
      gesture(env, { selectionAfter: 'selected, not copied' });
      assert.equal(env.term.selection, 'selected, not copied');
      assert.equal(env.doc.clipboard, null, 'setting off');
    } finally {
      env.restore();
    }
  });

  test('CS-06: the mouse-reporting setting reaches a running terminal at once', () => {
    const term = new FakeXterm();
    const { container } = page(term);
    let state = { terminalMouseReporting: true };
    const subscribers = new Set();
    const settings = {
      getState: () => state,
      subscribe: (fn) => {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    };
    installTerminalClipboard(term, container, { platform: 'linux', settings });
    term.write('\x1b[?1049h\x1b[?1000h');
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
    const set = (next) => {
      const prev = state;
      state = { ...state, ...next };
      for (const fn of subscribers) fn(state, prev);
    };
    set({ terminalMouseReporting: false });
    assert.equal(term.modes.mouseTrackingMode, 'none');
    set({ terminalMouseReporting: true });
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
    term.dispose();
    assert.equal(subscribers.size, 0, 'unsubscribed with the terminal');
    assert.equal(terminalClipboardFor(term), terminalClipboardFor(term), 'one binding per terminal');
  });

  test('CS-07: copying — the copy event xterm handles; the Clipboard API only when that cannot happen', () => {
    const calls = [];
    const clipboard = { writeText: (t) => (calls.push(t), Promise.resolve()) };
    const term = new FakeXterm();
    const { doc } = page(term);

    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'empty');

    term.selection = 'copy this';
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'copied');
    assert.equal(doc.clipboard, 'copy this');
    assert.equal(calls.length, 0, 'no Clipboard API when the copy event did it');

    doc.xtermStandsAside = true; // xterm's handler declined: the binding fills the data itself
    doc.clipboard = null;
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'copied');
    assert.equal(doc.clipboard, 'copy this');

    doc.allowCopy = false; // no user activation left: execCommand refuses, no event
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'async');
    assert.deepEqual(calls, ['copy this']);

    doc.allowCopy = true;
    doc.activeElement = { tagName: 'INPUT' }; // focus is not in the terminal: no execCommand at all
    doc.clipboard = null;
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'async');
    assert.equal(doc.clipboard, null);
    assert.deepEqual(calls, ['copy this', 'copy this']);

    assert.equal(copyTerminalSelection(term, { document: doc, clipboard: null }), 'failed');
    assert.equal(doc.listeners.length, 0, 'no listener left behind');
  });

  test('CS-08 (M1/L4b): altClickMovesCursor is off whenever ⌥ forces selection, written only by the transition', () => {
    // A quick ⌥-click, with `macOptionClickForcesSelection` on but
    // xterm's own `altClickMovesCursor` (default: on) left alone, still runs
    // ITS mouseup handling underneath the forced selection and sends
    // `moveToCellSequence` — on the alternate screen, cursor-key presses (a
    // tmux pane recalls old commands, htop's bar moves). No mousedown is
    // dispatched anywhere in this test: everything here must follow from the
    // mouse's own tracking transitions, not from a click.
    const term = new FakeXterm();
    const { container } = page(term);
    let forceWrites = 0;
    let moveWrites = 0;
    let forceValue;
    let moveValue;
    Object.defineProperty(term.options, 'macOptionClickForcesSelection', {
      configurable: true,
      get: () => forceValue,
      set(v) {
        forceWrites += 1;
        forceValue = v;
      },
    });
    Object.defineProperty(term.options, 'altClickMovesCursor', {
      configurable: true,
      get: () => moveValue,
      set(v) {
        moveWrites += 1;
        moveValue = v;
      },
    });

    installTerminalClipboard(term, container, { platform: 'mac' });
    assert.equal(term.options.altClickMovesCursor, true, "xterm's own default, at rest");
    assert.equal(term.options.macOptionClickForcesSelection, false);

    // htop/tmux: the alternate screen, then the mouse.
    term.write('\x1b[?1049h\x1b[?1000h');
    assert.equal(term.options.macOptionClickForcesSelection, true, '⌥ forces selection while tracking');
    assert.equal(
      term.options.altClickMovesCursor,
      false,
      'fails on f8a757d: xterm would still send moveToCellSequence on the ⌥-click release'
    );
    assert.equal(forceWrites, 2, 'one write to settle at rest, one for this transition — nothing more');
    assert.equal(moveWrites, 2);

    term.write('\x1b[?1000l\x1b[?1049l');
    assert.equal(term.options.macOptionClickForcesSelection, false);
    assert.equal(term.options.altClickMovesCursor, true, 'restored once the program lets go of the screen');
    assert.equal(forceWrites, 3, 'exactly one more write for this transition');
    assert.equal(moveWrites, 3);
  });

  test('CS-09 (L4b): off macOS, neither option is ever touched', () => {
    for (const platform of ['windows', 'linux']) {
      const term = new FakeXterm();
      const { container } = page(term);
      installTerminalClipboard(term, container, { platform });
      term.write('\x1b[?1049h\x1b[?1000h');
      assert.equal(term.options.macOptionClickForcesSelection, undefined, platform);
      assert.equal(term.options.altClickMovesCursor, undefined, platform);
    }
  });
});
