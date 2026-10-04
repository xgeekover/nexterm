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

  test('DT-00b: requestedFromFlags — the highest mode set, real X11 xterm\'s own rule', () => {
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
    term.write('\x1b[?1003l'); // a real DECRST: any → vt200 (1000 is still set)
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
});
