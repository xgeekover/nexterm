import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * When a pane's hidden tab strip comes back over its terminal (spec P1).
 *
 * WHY. With "Hide the Tab Strip of a Single Terminal" on, a pane holding one
 * terminal draws a thin HANDLE along its top edge instead of the strip (6 px
 * of real layout, always the same height, so the terminal never resizes for
 * anything that happens to it), and the strip itself comes back in an
 * overlay laid over the top of the terminal, directly BELOW the handle, when
 * it is asked for.
 *
 * What the reviews taught, each a rule here:
 *
 *   - Never on hover. A hand moving down onto the terminal's first row, the
 *     find bar's ✕ or the resume offer's buttons crossed the pane's top edge,
 *     a strip slid in under the pointer, and the click closed a pane.
 *   - Never over its own handle. Laid over the handle, the strip took the
 *     second click on the handle — Close Pane killed the shell. Below it, the
 *     handle stays the handle: a TOGGLE (`aria-expanded`), a second click
 *     puts the strip away, and a double-click's second click (`detail` 2) is
 *     ignored, so it does not undo the first. Nothing ever covers the handle,
 *     so there is no window in which the strip must ignore the pointer.
 *   - Escape is the strip's only while the keyboard is in the strip or on its
 *     handle — then it closes it and goes no further. With the keyboard in
 *     the terminal, Escape is the program's (it interrupts an agent's turn),
 *     and the strip stays.
 *   - Touch and pen do not hover: their pointer "leaves" as the finger lifts,
 *     before the tap's click. Only a MOUSE leaving it closes it.
 *
 * So the overlay is up while it was opened (a click or Enter on the handle),
 * and while a drag, its menu or a rename in it holds it. Opened, it goes on:
 * the handle again; Escape with the keyboard in it; the keyboard tabbing out
 * of it; a press anywhere outside it and its handle; a mouse leaving it and
 * its handle after having been on them; a hold letting go with the pointer
 * off it.
 *
 * `createStripOverlay` is the rule with no DOM and no React, so the suites
 * can step through it; `useStripOverlay` wires it to a pane.
 */

/** The overlay's rule. `onChange(open)` hears it change. */
export function createStripOverlay({ onChange = () => {} } = {}) {
  let open = false;
  // A mouse has been on the strip or its handle since it opened.
  let entered = false;

  const set = (next) => {
    if (next === open) return;
    open = next;
    if (!open) entered = false;
    onChange(open);
  };

  return {
    get open() {
      return open;
    },
    /**
     * A click on the handle — or Enter/Space on it (`detail` 0). A toggle;
     * the second click of a double-click (`detail` > 1) changes nothing.
     * Returns whether the strip is open after it.
     */
    handleClick({ detail = 1, pointerType = 'mouse' } = {}) {
      if (detail > 1) return open;
      if (open) {
        set(false);
        return false;
      }
      set(true);
      // Clicked with a mouse, the mouse is on the handle already.
      entered = pointerType === 'mouse';
      return true;
    },
    /** Escape. Taken — closing the strip, going no further — only with the keyboard in the strip or on its handle. */
    escape(focusInside) {
      if (!open || !focusInside) return false;
      set(false);
      return true;
    },
    /**
     * The keyboard moved: `to` 'inside' the strip or its handle, 'outside'
     * them (Tab, a click on something focusable), or 'nowhere' — the window
     * lost focus, and no element took it. Only 'outside' closes the strip;
     * the window coming back finds it as it was, with the keyboard in it.
     */
    focusMoved({ to, held = false } = {}) {
      if (open && to === 'outside' && !held) set(false);
    },
    /** Where a pointer is now: on the strip or its handle (`inside`), or not. Only a mouse counts. */
    pointerAt({ inside, pointerType = 'mouse', held = false } = {}) {
      if (!open || pointerType !== 'mouse') return;
      if (inside) {
        entered = true;
        return;
      }
      if (entered && !held) set(false);
    },
    /** A press outside the strip and its handle. */
    pressOutside(held = false) {
      if (open && !held) set(false);
    },
    /** A hold (drag, menu, rename) let go, with the pointer on the strip or not. */
    holdEnded(pointerOnIt) {
      if (open && !pointerOnIt) set(false);
    },
    close() {
      set(false);
    },
  };
}

/** After a press on the handle, how long nothing in the opened strip is activated. */
export const STRIP_QUIET_AFTER_HANDLE_MS = 500;
/** How far below the handle a finger may land and still be a tap meant for the handle… */
export const TOUCH_SLOP_BELOW_HANDLE_PX = 12;
/** …and for how long after the handle's tap. */
export const TOUCH_SECOND_TAP_MS = 650;

/**
 * What the opened strip refuses, by geometry and timing (review, stage 3).
 *
 * The strip lies right below the 6 px handle, so a second click or tap meant
 * for the handle — a double-click whose second click drifts a few pixels
 * down, a finger that lands 10 px lower the second time — falls on the strip
 * instead. The strip carries nothing that destroys (no tab ✕, no Close
 * Pane); what it does carry ("+", Split, Zoom, a chip) refuses:
 *
 *   - any click with `detail` past one (the second click of a double-click);
 *   - anything within STRIP_QUIET_AFTER_HANDLE_MS of a press on the handle;
 *   - a touch or pen tap whose press landed within TOUCH_SLOP_BELOW_HANDLE_PX
 *     below the handle, within TOUCH_SECOND_TAP_MS of the handle's tap.
 *
 * A double-click on a chip (a rename) is a `dblclick`, not a click, and is
 * the strip's once the handle's quiet time is over. Enter on a chip is a
 * click with `detail` 0, and always the strip's.
 */
export function createStripClickGuard({ now = () => Date.now() } = {}) {
  let handlePressAt = -Infinity;
  let handleTapAt = -Infinity;
  let lastPress = null;
  return {
    /** A press (pointerdown) on the handle. */
    handlePressed() {
      handlePressAt = now();
    },
    /** The handle's click, by a mouse, a finger or a pen. */
    handleClicked({ pointerType = 'mouse' } = {}) {
      if (pointerType === 'touch' || pointerType === 'pen') handleTapAt = now();
    },
    /** A press in the strip: by what, and how many pixels below the handle's bottom edge. */
    stripPressed({ pointerType = 'mouse', below = Infinity } = {}) {
      lastPress = { pointerType, below, at: now() };
    },
    /** Whether a `click` (with its `detail`) or a `dblclick` on the strip is refused now. */
    refuses({ type = 'click', detail = 1 } = {}) {
      if (type === 'click' && detail > 1) return true;
      if (now() - handlePressAt < STRIP_QUIET_AFTER_HANDLE_MS) return true;
      if (
        lastPress &&
        lastPress.pointerType !== 'mouse' &&
        lastPress.below <= TOUCH_SLOP_BELOW_HANDLE_PX &&
        lastPress.at - handleTapAt < TOUCH_SECOND_TAP_MS
      ) {
        return true;
      }
      return false;
    },
  };
}

/** Whether the point `at` is on the opened strip or on its handle — boxes in client pixels. */
export function pointOnStrip(at, overlayBox, handleBox) {
  if (!at) return false;
  const within = (box) => Boolean(box) && at.x >= box.left && at.x < box.right && at.y >= box.top && at.y < box.bottom;
  return within(overlayBox) || within(handleBox);
}

/** Whether the overlay strip is on screen: opened, or held by the pane. */
export function stripShown({ open, dragging, menuOpen, renaming }) {
  return Boolean(open || dragging || menuOpen || renaming);
}

/**
 * The ways a pane's header offers to close its terminal or the pane itself:
 * the ✕ on a chip, a middle-click on a chip, the Close Pane button, and the
 * Close Terminal / Close Pane rows of the pane's menu. The opened strip of a
 * hidden one carries none of the first three. It opens just under a 6 px
 * handle, so a second click or tap meant for the handle lands on a chip, and
 * a ✕, a middle-click or Close Pane there killed a shell nobody meant to
 * close. Closing is in the menus then (the handle opens the pane's menu):
 * two deliberate clicks. A chip's own right-click menu always has Close
 * Terminal, so it is not decided here.
 */
export function headerCloseGestures({ stripHidden, canClose }) {
  const inline = !stripHidden;
  const paneCloses = Boolean(canClose);
  return {
    chipButton: inline,
    chipMiddleClick: inline,
    paneButton: inline && paneCloses,
    menuCloseTerminal: !inline,
    menuClosePane: !inline && paneCloses,
  };
}

/**
 * `createStripOverlay` for one pane, while `enabled` (its strip is hidden).
 * `overlayRef` and `handleRef` are the overlay's and the handle's elements;
 * `held` whether a drag, a menu or a rename holds the strip up (Escape,
 * presses and the pointer are theirs then).
 *
 * Returns `{ open, handleClick, handlePointerDown, overlayGuard }`:
 * `handleClick({ detail, pointerType })` for the handle's clicks, returning
 * whether the strip is open after it; `handlePointerDown` for its presses;
 * `overlayGuard`, capture-phase handlers for the overlay that refuse what
 * `createStripClickGuard` refuses.
 */
export function useStripOverlay(enabled, { overlayRef, handleRef, held }) {
  const [open, setOpen] = useState(false);
  const [overlay] = useState(() => createStripOverlay({ onChange: setOpen }));
  const [guard] = useState(() => createStripClickGuard());
  const heldRef = useRef(held);
  heldRef.current = held;
  const pointer = useRef(null);

  useEffect(() => {
    if (!enabled) overlay.close();
  }, [enabled, overlay]);

  // Closed with the keyboard still in it, the strip would be gone with the
  // keyboard on something nobody can see: the handle takes it.
  useEffect(() => {
    if (open || !enabled) return;
    const at = document.activeElement;
    if (at && overlayRef.current?.contains(at)) handleRef.current?.focus({ preventScroll: true });
  }, [open, enabled, overlayRef, handleRef]);

  // While open: Escape, presses, the pointer and the keyboard leaving.
  useEffect(() => {
    if (!enabled || !open) return undefined;
    const inside = (target) =>
      Boolean(target && (overlayRef.current?.contains(target) || handleRef.current?.contains(target)));
    // In the capture phase, before anything else on the page hears it. Taken
    // only with the keyboard in the strip or on its handle — then it goes no
    // further. With the keyboard in the terminal it is the program's, and
    // the strip stays. While a menu, a rename or a drag holds the strip,
    // Escape is theirs.
    const onKey = (e) => {
      if (e.key !== 'Escape' || heldRef.current) return;
      const focusInside = inside(document.activeElement);
      if (!overlay.escape(focusInside)) return;
      e.preventDefault();
      e.stopPropagation();
      // Back to the handle that opened it.
      handleRef.current?.focus({ preventScroll: true });
    };
    const onDown = (e) => {
      if (!inside(e.target)) overlay.pressOutside(heldRef.current);
    };
    const onMove = (e) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      overlay.pointerAt({ inside: inside(e.target), pointerType: e.pointerType, held: heldRef.current });
    };
    // Where the keyboard went: into the strip or its handle, out of them, or
    // nowhere (the window lost focus — no element took it).
    const onFocusOut = (e) => {
      if (!inside(e.target)) return;
      const to = !e.relatedTarget ? 'nowhere' : inside(e.relatedTarget) ? 'inside' : 'outside';
      overlay.focusMoved({ to, held: heldRef.current });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('focusout', onFocusOut, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('focusout', onFocusOut, true);
    };
  }, [enabled, open, overlay, overlayRef, handleRef]);

  // A hold let go: an opened strip stays only with the pointer on it — or
  // on its handle, whose own menu it may have been. Measured, not
  // hit-tested; before paint, so one that stays never blinks.
  const wasHeld = useRef(held);
  useLayoutEffect(() => {
    if (wasHeld.current && !held && enabled) {
      overlay.holdEnded(
        pointOnStrip(pointer.current, overlayRef.current?.getBoundingClientRect?.(), handleRef.current?.getBoundingClientRect?.())
      );
    }
    wasHeld.current = held;
  }, [held, enabled, overlay, overlayRef, handleRef]);

  const handleClick = useCallback(
    (info) => {
      guard.handleClicked(info);
      return overlay.handleClick(info);
    },
    [overlay, guard]
  );
  const handlePointerDown = useCallback(() => guard.handlePressed(), [guard]);
  const [overlayGuard] = useState(() => {
    const refuse = (e, type) => {
      if (!guard.refuses({ type, detail: e.detail })) return;
      e.preventDefault();
      e.stopPropagation();
    };
    return {
      onPointerDownCapture: (e) => {
        const bottom = handleRef.current?.getBoundingClientRect?.().bottom;
        guard.stripPressed({ pointerType: e.pointerType, below: typeof bottom === 'number' ? e.clientY - bottom : Infinity });
      },
      onClickCapture: (e) => refuse(e, 'click'),
      onDoubleClickCapture: (e) => refuse(e, 'dblclick'),
    };
  });

  return { open: enabled && open, handleClick, handlePointerDown, overlayGuard };
}

/**
 * A pane menu closed by a press elsewhere — on a strip that goes away with
 * it, say — leaves the keyboard on the page (the menu had it), and the next
 * keys reach nothing. Back to the pane's terminal then; a menu item that put
 * the keyboard somewhere (a rename's field) is left alone.
 */
export function useRefocusAfterMenu(menuOpen, paneRef) {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !menuOpen) {
      const at = document.activeElement;
      if (!at || at === document.body) {
        paneRef.current?.querySelector('[data-pane-body] .xterm-helper-textarea')?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = menuOpen;
  }, [menuOpen, paneRef]);
}
