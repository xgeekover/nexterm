/**
 * The bug this file is about, measured in the real app: Claude Code (and
 * other Ink-based UIs) restate their mouse modes as separate DECSET
 * sequences on every redraw — `?1000h` then `?1002h` then `?1003h`. xterm.js
 * keeps a single last-DECSET-wins protocol variable, so a transient dip
 * through VT200 while the primary button is held removes its drag-motion
 * listener for the REST of that gesture — only the next mousedown restores
 * it, not a moment later re-asserting ANY. That is "drag to copy doesn't
 * work", intermittently, after Claude starts (src/lib/mouseReporting.js has
 * the full mechanics, including why xterm's own listener cannot recover).
 *
 * `mouse_reporting.test.js` (its MR-, MB- and CS- cases) covers the full policy — which
 * protocol is in force, selection, copy on select — including the two purest
 * cases of flag independence (MR-06b: `?1000l` with 1003 on stays ANY,
 * `?1003l` with 1000 still on falls back to VT200). This file is the rest of
 * what fixes 94ec8d6's intermittent loss of motion specifically:
 *
 *   DT-00  the pure building blocks directly: `dropsMotion`, `requestedFromFlags`
 *   DT-01  the exact trigger — the SAME two modes, as SEPARATE sequences,
 *          never walk the real protocol down before walking it back up
 *   DT-04  several modes restated across separate sequences in ONE write (an
 *          Ink redraw) reach xterm as at most one real change, straight to
 *          the final one — and repeating the same redraw is then a no-op
 *   DT-05  a GENUINE downgrade (a real DECRST, not a redraw) arriving while
 *          the primary button is held is deferred until it is let go
 *   DT-05b … but an upgrade is not: only a downgrade risks the drag listener
 *   DT-06  disposing while a change is held back cancels it, rather than
 *          applying it later from nowhere
 *   DT-09  leaving the alternate screen mid-drag applies the change AT ONCE,
 *          not at release — the protection is only for a program still
 *          asking from THAT screen (MEDIUM 1)
 *   DT-10  a lost mouseup that neither a mouseup nor a blur ever reports
 *          (e.g. a native context menu) is still recovered, from the next
 *          mousemove's own `buttons` or from `contextmenu` itself (LOW 3)
 *
 * All against `FakeXterm` (tests/adversarial/mouse_reporting_fixtures.js),
 * the same stand-in MB-* uses — `protocolSets` additionally counts every
 * assignment to its mouse service, same as xterm's own `CoreMouseService`
 * setter (unconditional, even for a repeated value — see its doc), which is
 * what lets DT-04 tell "one real change" apart from "none visibly wrong".
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { planPrivateModes, requestedFromFlags, dropsMotion } from '../../src/lib/mouseReporting.js';
import { withBinding, press, release } from './mouse_reporting_fixtures.js';

describe('Mouse reporting: the pure building blocks for "never downgrade during a held button"', () => {
  test('DT-00a: dropsMotion — only a transition that costs the DRAG or MOVE event bit counts', () => {
    // ANY has both DRAG (motion while a button is held) and MOVE (motion with
    // none held); DRAG alone has just the first; VT200/X10/NONE have neither.
    assert.equal(dropsMotion('any', 'drag'), true, 'loses MOVE');
    assert.equal(dropsMotion('any', 'vt200'), true, 'loses both');
    assert.equal(dropsMotion('any', 'x10'), true, 'loses both');
    assert.equal(dropsMotion('any', 'none'), true, 'loses both');
    assert.equal(dropsMotion('drag', 'vt200'), true, 'loses DRAG');
    assert.equal(dropsMotion('drag', 'x10'), true, 'loses DRAG');
    assert.equal(dropsMotion('drag', 'none'), true, 'loses DRAG');
    // VT200/X10/NONE never had either bit, so stepping between them costs a
    // held drag nothing — xterm's drag-motion listener was never there to lose.
    assert.equal(dropsMotion('vt200', 'x10'), false);
    assert.equal(dropsMotion('vt200', 'none'), false);
    assert.equal(dropsMotion('x10', 'none'), false);
    // Every upgrade, and holding still, is safe by construction.
    for (const [from, to] of [
      ['none', 'x10'], ['x10', 'vt200'], ['vt200', 'drag'], ['drag', 'any'], ['none', 'any'],
      ['any', 'any'], ['drag', 'drag'], ['vt200', 'vt200'], ['none', 'none'],
    ]) {
      assert.equal(dropsMotion(from, to), false, `${from} -> ${to}`);
    }
  });

  test('DT-00b: requestedFromFlags — the highest mode set (VTE/Alacritty/WezTerm-style for SETS; see MR-06b for RESETS)', () => {
    assert.equal(requestedFromFlags({}), 'none');
    assert.equal(requestedFromFlags({ 1000: true }), 'vt200');
    assert.equal(requestedFromFlags({ 9: true, 1000: true }), 'vt200');
    assert.equal(requestedFromFlags({ 9: true, 1002: true, 1003: false }), 'drag', '1003 present but false does not count');
    assert.equal(requestedFromFlags({ 1003: true, 1002: true, 1000: true, 9: true }), 'any');
  });

  test('DT-01: `?1003h` then `?1000h`, as SEPARATE sequences — the highest stays in force', () => {
    // The exact shape of the measured bug: a program (re)asks for a LOWER
    // mode without resetting the higher one it already has. xterm.js's own
    // last-wins would walk its real protocol down to VT200 here; this must
    // not, or a held-button drag loses its motion the moment this is next to
    // a mousemove (see DT-05 for the genuine-downgrade case, which DOES move
    // the real protocol, just never while a button is down).
    const first = planPrivateModes({ final: 'h', params: [1003], alternate: true });
    assert.equal(first.requested, 'any');
    assert.equal(first.effective, 'any');
    const second = planPrivateModes({ final: 'h', params: [1000], flags: first.flags, alternate: true });
    assert.equal(second.requested, 'any', 'restating a lower mode never walks the real protocol down');
    assert.equal(second.effective, 'any');
  });
});

describe('Mouse reporting: never downgrade during a held button', () => {
  test('DT-04: `?1000h?1002h?1003h`, and the same redraw again — one real protocol change, in total', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1049h'); // a full-screen program's own alternate screen
    const baseline = term.protocolSets;

    // Claude's own repeated-enable, one PTY chunk: three separate sequences,
    // each individually "the highest so far", climbing none → vt200 → drag →
    // any. Coalesced to the end of this write, xterm is only ever told 'any'.
    term.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'any');
    assert.equal(term.protocolSets - baseline, 1, 'straight to ANY — never through VT200 or DRAG');
    assert.equal(binding.requested, 'any');

    // An Ink redraw restating the exact same modes: already ANY, so nothing
    // happens at all — not even one more (unobservable) assignment.
    term.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h');
    assert.equal(term.protocolSets - baseline, 1, 'the repeat is a no-op, not a second change');
    assert.equal(term.modes.mouseTrackingMode, 'any');
  });

  test('DT-05: a GENUINE downgrade mid-drag is held back until the button is let go', () => {
    const { term, binding, container, view } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1003h'); // vt200, then any — any ends up in force
    assert.equal(term.modes.mouseTrackingMode, 'any');
    const baseline = term.protocolSets;

    press(container); // the primary button goes down — e.g. a drag begins
    // A real DECRST, not a redraw — `?1003l` alone would turn tracking fully
    // off (MR-06b: any ONE tracking DECRST clears every flag, xterm.js-
    // compatible), so the program re-asks for the lower mode it still wants
    // right after: any → off → vt200, the genuine downgrade `dropsMotion`
    // must catch.
    term.write('\x1b[?1003l\x1b[?1000h');
    assert.equal(term.modes.mouseTrackingMode, 'any', 'held back — xterm still believes ANY, so its drag listener survives');
    assert.equal(term.protocolSets, baseline, 'nothing applied yet');
    assert.equal(binding.requested, 'vt200', 'remembered correctly even though not yet applied to xterm');

    release(view); // the button comes back up
    assert.equal(term.modes.mouseTrackingMode, 'vt200', 'settles the instant the button is let go');
    assert.equal(term.protocolSets, baseline + 1, 'applied exactly once, not once per attempt while it was held back');
  });

  test('DT-05b: an UPGRADE mid-drag applies at once — only a downgrade is ever held back', () => {
    const { term, container } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h'); // vt200 in force
    assert.equal(term.modes.mouseTrackingMode, 'vt200');

    press(container);
    term.write('\x1b[?1002h\x1b[?1003h'); // vt200 → drag → any: both upgrades
    assert.equal(term.modes.mouseTrackingMode, 'any', 'an upgrade never costs the drag listener anything, so it is never deferred');
  });

  test('DT-06: disposing while a change is held back cancels it, not merely delays it', () => {
    const { term, container, view } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1003h');
    press(container);
    term.write('\x1b[?1003l'); // deferred, as in DT-05
    assert.equal(term.modes.mouseTrackingMode, 'any');

    term.dispose(); // the addon's disposables go, including the mouseup/blur listeners
    release(view); // nothing is left to hear this
    assert.equal(term.modes.mouseTrackingMode, 'any', 'the deferred downgrade never applied — dispose cancelled it');
  });

  test('DT-09 (MEDIUM 1): leaving the alternate screen mid-drag applies the downgrade at once, not at release', () => {
    const { term, binding, container, view } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h'); // any, full-screen
    assert.equal(term.modes.mouseTrackingMode, 'any');

    press(container); // a drag begins
    const baseline = term.protocolSets;
    // The full-screen program turns off its own tracking AND leaves the
    // alternate screen, all mid-drag (e.g. `less --mouse`, 'q' while the
    // button is still down) — unlike DT-05/DT-06, where the program stays on
    // the alternate screen throughout.
    term.write('\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l');
    assert.equal(term.screen, 'normal', 'xterm really left the alternate screen');
    assert.equal(
      term.modes.mouseTrackingMode,
      'none',
      'fails on 4fc2c7e: stayed ANY on the normal buffer until release — the rest of the drag would report into the shell instead of selecting'
    );
    assert.equal(term.protocolSets, baseline + 1, 'applied the moment the screen was left, not deferred to release');
    assert.equal(binding.requested, 'none');

    release(view);
    assert.equal(term.protocolSets, baseline + 1, 'nothing left to settle at release — already applied');
  });

  test('DT-09b (MEDIUM 1): switching the setting off mid-drag applies at once too, same as leaving the screen', () => {
    const { term, binding, setting, container } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'any');

    press(container);
    setting.on = false;
    binding.sync(); // the setting is read fresh by `_applyToTerm`, not cached
    assert.equal(
      term.modes.mouseTrackingMode,
      'none',
      'the setting turning off is not something a drag listener is worth protecting against either'
    );
  });
});

describe('Mouse reporting: recovering a lost mouseup', () => {
  test('DT-10 (LOW 3): a lost mouseup — e.g. macOS ctrl+click\'s context menu swallowing it — is still recovered', () => {
    const { term, binding, container, view } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'any');

    press(container); // the primary button goes down
    assert.equal(binding._buttonHeld, true);
    term.write('\x1b[?1003l\x1b[?1000h'); // a genuine downgrade, held back as in DT-05
    assert.equal(term.modes.mouseTrackingMode, 'any', 'deferred, same as DT-05');

    // No mouseup ever arrives — a native context menu ate it, with no blur
    // either (the window kept focus) — but the next mousemove the OS
    // actually delivers reports no button down any more.
    view.dispatch({ type: 'mousemove', buttons: 0 });
    assert.equal(binding._buttonHeld, false, 'fails on 4fc2c7e: recovered without a mouseup or a blur');
    assert.equal(term.modes.mouseTrackingMode, 'vt200', 'the deferred downgrade settles the moment it is recovered');

    // `contextmenu` itself also clears it, even before any further mousemove.
    term.write('\x1b[?1003h');
    press(container);
    assert.equal(binding._buttonHeld, true);
    view.dispatch({ type: 'contextmenu' });
    assert.equal(binding._buttonHeld, false, 'fails on 4fc2c7e: contextmenu alone never cleared it');

    // A mousemove reporting the primary button STILL down changes nothing —
    // only a cleared bit means the button is up.
    press(container);
    view.dispatch({ type: 'mousemove', buttons: 1 });
    assert.equal(binding._buttonHeld, true, 'still held: the OS says the primary button is still down');
  });
});

describe('Mouse reporting: a throwing internal step never wedges the terminal', () => {
  test('DT-07: the tracking-mode handler throwing is caught, logged once, and the terminal keeps working', () => {
    // Measured in the real app: a custom parser handler that threw wedged
    // xterm's WriteBuffer for good — no further output, ever, and write
    // callbacks that never fired again. This stands in for a bug inside
    // this binding's OWN handler and checks it cannot do that.
    const { term, binding } = withBinding();
    const originalPrivateMode = binding._privateMode.bind(binding);
    let callCount = 0;
    let shouldThrow = false;
    binding._privateMode = (final, params) => {
      callCount += 1;
      // What a registered registerCsiHandler callback actually receives,
      // through xterm's public API: a plain array (`params.toArray()`
      // already applied), never a Params object — matching FakeXterm's own
      // write(), which parses straight into one, same as the real thing.
      assert.ok(Array.isArray(params), 'the public API hands a plain array, not a Params object');
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('boom: a bug inside the handler itself');
      }
      return originalPrivateMode(final, params);
    };
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      shouldThrow = true;
      // Two sequences in one write: the first (1049) throws; the fallback
      // ('not handled') lets xterm apply THAT one natively, and the second
      // (1003), reached right after, goes through the handler normally.
      term.write('\x1b[?1049h\x1b[?1003h');
      assert.equal(warnings.length, 1, 'logged once');
      assert.ok(warnings[0].includes('tracking-mode handler'), 'names where it failed');
      assert.equal(term.screen, 'alternate', 'xterm still switched screens — the fallback let it apply that sequence itself');

      // The WriteBuffer is not wedged: later writes keep reaching the SAME
      // handler, now behaving normally again, and settle correctly.
      term.write('\x1b[?1049l'); // a clean slate: L1 clears every flag
      term.write('\x1b[?1049h\x1b[?1000h');
      assert.equal(term.modes.mouseTrackingMode, 'vt200', 'a later write reaches the terminal exactly as it should');
      assert.equal(warnings.length, 1, 'still just the one — not logged again for a handler that now behaves');
      assert.ok(callCount > 3, 'later sequences keep reaching the handler at all');
    } finally {
      console.warn = warn;
    }
  });

  test('DT-08: a throwing buffer-change or write-parsed step is caught the same way, by its own label', () => {
    const { term, binding } = withBinding();
    const originalSync = binding.sync.bind(binding);
    let shouldThrow = false;
    binding.sync = (...args) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('boom: a bug inside sync() itself');
      }
      return originalSync(...args);
    };
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      shouldThrow = true;
      term.write('\x1b[?1049h'); // onBufferChange fires, calls the (now throwing) sync()
      assert.equal(term.screen, 'alternate', 'the screen switch itself is unaffected — xterm did that before the listener ran');
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('buffer-change handler'));

      shouldThrow = true;
      term.write('\x1b[?1000h'); // onWriteParsed fires, calls the (again throwing) sync()
      assert.equal(warnings.length, 2, 'a DIFFERENT label gets its own one-time warning, not swallowed by the first');
      assert.ok(warnings[1].includes('write-parsed handler'));

      // Nothing wedged: an un-thrown sequence right after settles normally.
      term.write('\x1b[?1049l\x1b[?1049h\x1b[?1000h');
      assert.equal(term.modes.mouseTrackingMode, 'vt200', 'a later write still reaches the terminal');
      assert.equal(warnings.length, 2, 'no further warnings once sync() behaves again');
    } finally {
      console.warn = warn;
    }
  });
});
