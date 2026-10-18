import { useCallback, useEffect, useState } from 'react';

/**
 * When the TERMINALS side bar, sorted by attention, keeps its drawn order
 * still (spec S7, revised after review).
 *
 * WHY. Sorted, a row moves when its terminal's state changes. A row moving
 * while the user aims at another slides a third one under the pointer, and
 * the click lands on a terminal nobody pointed at. Two earlier rules failed:
 *
 *   - holding while the pointer was anywhere over the list kept an order
 *     stale for as long as the pointer rested in empty space;
 *   - holding only while the pointer MOVED (and a second after) let the
 *     re-sort land under a pointer that had come to rest on a row — hover a
 *     row, read its tooltip, click: the click hit another terminal. And a
 *     click let go at once, so the re-sort fell between the two clicks of a
 *     double-click and the rename opened on a different row.
 *
 * So the order holds while it is being aimed at, and only then:
 *
 *   - the pointer OVER a row (a terminal, a pane or a group), moving or not —
 *     never over empty space or another section, whose rows the sort does
 *     not move;
 *   - a PRESS on a row, until its click has landed and a double-click's
 *     interval has passed after it (`DOUBLE_CLICK_MS`), so the second click
 *     lands where the first one did. Touch included: a finger "leaves" the
 *     moment it lifts, before its click is dispatched. With no click at all
 *     (a press dragged away), `PRESS_GRACE_MS` after the press ended;
 *   - (the panel adds) a menu from the list open, a row being renamed.
 *
 * The pointer leaving the rows, leaving the window, the window losing focus
 * or being hidden, all let go. The side bar says when a newer order is
 * waiting (the dot on its sort button), so a held order never passes for a
 * current one.
 *
 * `createAimHold` is the rule with no DOM and no React, its timers given, so
 * the render suite can step through it. `useAimHold` wires it to the window.
 */

/** How long after a click on a row the order stays still: a double-click's second click lands where its first did. */
export const DOUBLE_CLICK_MS = 500;

/** How long after a press ends its click may still come (a finger's comes after it has lifted). */
export const PRESS_GRACE_MS = 600;

/** The rows whose place the sort can change — not the Saved section, whose rows stay put. */
export const SORTED_ROW = '[data-terminal-row], [data-group-row], [data-pane-row]';

/**
 * The hold's state: `pointerAt(onRow)` (where the pointer is now: over a
 * row or not), `pressed()`, `pressEnded()` (pointer up or cancelled,
 * anywhere), `clicked()` (a click landed), `release()` (the window was left),
 * `dispose()` (nothing more). `held` says whether the order is held now;
 * `onChange(held)` hears it change.
 */
export function createAimHold({
  onChange = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  doubleClickMs = DOUBLE_CLICK_MS,
  graceMs = PRESS_GRACE_MS,
} = {}) {
  let over = false;
  let pressing = false;
  let pressTimer = null;
  let last = false;

  const held = () => over || pressing;
  const emit = () => {
    const now = held();
    if (now !== last) {
      last = now;
      onChange(now);
    }
  };
  const stopPress = () => {
    if (pressTimer !== null) clearTimer(pressTimer);
    pressTimer = null;
  };
  const endPressIn = (ms) => {
    stopPress();
    pressTimer = setTimer(() => {
      pressTimer = null;
      pressing = false;
      emit();
    }, ms);
  };

  return {
    get held() {
      return held();
    },
    pointerAt(onRow) {
      over = Boolean(onRow);
      emit();
    },
    pressed() {
      stopPress();
      pressing = true;
      emit();
    },
    pressEnded() {
      if (pressing) endPressIn(graceMs);
    },
    clicked() {
      if (pressing) endPressIn(doubleClickMs);
    },
    release() {
      stopPress();
      over = false;
      pressing = false;
      emit();
    },
    // Nothing is told: whoever listened is going away.
    dispose() {
      stopPress();
      over = false;
      pressing = false;
      last = false;
    },
  };
}

const onRow = (el) => Boolean(el?.closest?.(SORTED_ROW));

/**
 * `createAimHold` for the side bar, while `enabled` (sorted): returns
 * `[held, recheck]`. Listens on the window, so a press that ends anywhere
 * ends, and the pointer leaving the window lets go.
 *
 * `frozen`: a menu from the list is open. The pointer moving over the menu
 * is not the pointer leaving the rows; what it is over once the menu has
 * gone is asked then (`recheck`), so closing a menu over a row does not let
 * a re-sort land under the pointer.
 *
 * `recheck()`: ask again what is under the pointer's last place — after the
 * list was drawn again, a row may have gone from under a pointer that did
 * not move (a terminal closed), or a menu that covered the rows closed.
 */
export function useAimHold(enabled, frozen = false) {
  const [held, setHeld] = useState(false);
  const [aim] = useState(() => createAimHold({ onChange: setHeld }));
  // Where a hovering pointer was last seen; null when it left the window, or
  // was a finger that lifted (a finger does not hover).
  const [where] = useState(() => ({ at: null, frozen: false }));
  where.frozen = frozen;

  useEffect(() => {
    if (!enabled) {
      where.at = null;
      aim.release();
      return undefined;
    }
    const move = (e) => {
      if (e.pointerType === 'touch') return;
      where.at = { x: e.clientX, y: e.clientY };
      if (!where.frozen) aim.pointerAt(onRow(e.target));
    };
    // The primary button, a finger or a pen: a right-click sends no click
    // to end its press with, and opens a menu, which holds on its own.
    const down = (e) => {
      if (e.button === 0 && onRow(e.target)) aim.pressed();
    };
    const up = (e) => {
      aim.pressEnded();
      if (e.pointerType !== 'mouse') {
        where.at = null;
        aim.pointerAt(false);
      }
    };
    const click = () => aim.clicked();
    const out = (e) => {
      if (e.relatedTarget) return;
      where.at = null;
      aim.pointerAt(false);
    };
    const leave = () => {
      where.at = null;
      aim.release();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    window.addEventListener('pointermove', move, { capture: true, passive: true });
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('click', click, true);
    window.addEventListener('pointerout', out, true);
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointermove', move, { capture: true });
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('pointerout', out, true);
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', hidden);
      aim.dispose();
      setHeld(false);
    };
  }, [enabled, aim, where]);

  const recheck = useCallback(() => {
    if (!enabled || where.frozen || !where.at) return;
    aim.pointerAt(onRow(document.elementFromPoint(where.at.x, where.at.y)));
  }, [enabled, aim, where]);

  return [held, recheck];
}
