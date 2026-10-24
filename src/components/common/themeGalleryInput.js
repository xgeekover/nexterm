/**
 * The theme gallery's input — keys, the pointer, focus, clicks — as the
 * browser delivers it, decided outside React (ThemeGallery.jsx wires each
 * handler to its event and supplies what it acts on).
 *
 * Kept here, not in the component, so that the suites CI runs can drive it
 * the way a browser does: CI has no browser to hold a key down in, and every
 * rule below once failed only in a real one — a held Delete wiped every
 * imported theme, a held Enter chose a theme it should only have put back,
 * the window coming back to the front previewed a theme, a card scrolled
 * under a still pointer previewed, a dismissed notice dropped the keyboard on
 * the page, a held Escape closed Settings, a second click on a trash button
 * deleted the card that slid under it.
 *
 * `fx`, what the controller acts on:
 *   dispatch(event)   an event for `previewAfter`
 *   focusCard(id)     focus that card and keep it in view; the browser fires
 *                     the card's focus event (`cardFocus`) as it does
 *   deleteCard(id)    delete that imported theme
 *   choose(id)        choose that theme
 *   keepInView(node)  scroll a focused element clear of the notice
 *   later(fn)         run fn once the current key's default action is over
 *   now()             the time, in milliseconds
 */
import { focusIsKeyboardMove, galleryMove, ignoresHeldKey, keyboardClickWhileHeld, pointerMoved, refocusAfterNotice } from './themeGalleryModel.js';

/**
 * How long after a delete a trash button's click is not taken, unless the
 * pointer has moved since: the next card slides into the deleted one's
 * place, its trash button under the pointer, and a second single click seven
 * tenths of a second later — no double-click, so `detail` is 1 — deleted it
 * too. Longer than a double-click; short enough that deleting a few on
 * purpose, the pointer moving between, never meets it.
 */
export const TRASH_GRACE_MS = 800;

export function createGalleryInput(fx) {
  // Where the pointer last was anywhere in the window, and whether the event
  // being handled moved it. Kept for the whole window: a pointermove at the
  // spot of the last one, after a scroll, is not the pointer moving.
  let lastPointer = null;
  let pointerReallyMoved = false;
  // What says a focus arriving on a card is the keyboard moving: the card an
  // arrow key is moving to, and a Tab pressed this moment.
  let arrowTarget = null;
  let tabKeyDown = false;
  // An activation key being held, noted from its repeats.
  let heldKey = null;
  // Whether the keyboard is in the notice, for when the notice goes away.
  let focusInNotice = false;
  // The last delete, and whether the pointer has moved since.
  let lastDeleteAt = -Infinity;
  let movedSinceDelete = true;

  const deleteNow = (id) => {
    lastDeleteAt = fx.now();
    movedSinceDelete = false;
    fx.deleteCard(id);
  };

  const input = {
    /** Every key, first (window, capture): Tab noted until the browser has moved focus for it; a held key noted until it comes up. */
    windowKeyDown(e) {
      if (ignoresHeldKey(e)) heldKey = e.key;
      if (e.key !== 'Tab') return;
      tabKeyDown = true;
      fx.later(() => {
        tabKeyDown = false;
      });
    },
    windowKeyUp(e) {
      if (e.key === heldKey) heldKey = null;
    },
    /** A key held as the window lost focus never comes up here. */
    windowBlur() {
      heldKey = null;
    },
    /** Every pointer move, first (window, capture). */
    windowPointerMove(e) {
      pointerReallyMoved = pointerMoved(lastPointer, e.clientX, e.clientY);
      lastPointer = { x: e.clientX, y: e.clientY };
      if (pointerReallyMoved) movedSinceDelete = true;
    },
    /**
     * The pointer moving over the cards previews the card it is on — only if
     * it really moved: a browser reports the pointer over whatever slid under
     * it after a scroll or a reflow, WebKit with a pointermove at the same
     * spot. Over the gap between two cards the last one stays.
     */
    gridPointerMove(e) {
      if (!pointerReallyMoved) return;
      const id = e.target?.closest?.('[data-theme-card]')?.getAttribute('data-theme-card');
      if (id) fx.dispatch({ type: 'point', id });
    },
    gridPointerLeave() {
      fx.dispatch({ type: 'pointer-left' });
    },
    /** Focus leaving the cards altogether (`relatedTarget` outside them). */
    gridBlur(leftTheCards) {
      if (leftTheCards) fx.dispatch({ type: 'focus-left' });
    },
    /** Focus arriving anywhere in the gallery: tabbed onto, it is kept clear of the notice; on a click or a window refocus nothing moves. */
    galleryFocus(e) {
      if (tabKeyDown) fx.keepInView(e.target);
    },
    /** Focus arriving on a card: a preview only when the keyboard moved it there. */
    cardFocus(id) {
      fx.dispatch({ type: 'focus', id, byKeyboard: focusIsKeyboardMove({ arrowTarget, tabKeyDown }, id) });
    },
    /**
     * A key on a card. A held key acts once: held Delete deleted every
     * imported theme in turn, the focus moving on to the next after each.
     * Delete (or Backspace) removes an imported theme; the arrows, Home and
     * End move — the user moving, so that focus previews.
     */
    cardKeyDown(e, choice, choices) {
      if (ignoresHeldKey(e)) {
        e.preventDefault();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && choice.custom) {
        e.preventDefault();
        deleteNow(choice.id);
        return;
      }
      const index = choices.findIndex((c) => c.id === choice.id);
      const next = galleryMove(index, e.key, choices.length);
      if (next === null) return;
      e.preventDefault();
      arrowTarget = choices[next].id;
      try {
        fx.focusCard(choices[next].id);
      } finally {
        arrowTarget = null;
      }
    },
    /**
     * A key anywhere in the gallery. A held key acts once — held Enter on
     * Undo put a theme back and then chose it — and a held Escape stops here
     * altogether: the first Escape ended a preview, and its repeats went on
     * to close Settings. Escape while a theme is previewed ends the preview
     * and lands on the chosen card.
     */
    galleryKeyDown(e, { preview, chosen }) {
      if (ignoresHeldKey(e)) {
        e.preventDefault();
        if (e.key === 'Escape') e.stopPropagation();
        return;
      }
      if (e.key !== 'Escape' || !preview) return;
      e.preventDefault();
      e.stopPropagation();
      fx.dispatch({ type: 'cancel' });
      fx.focusCard(chosen);
    },
    /** Whether a click counts: not one the keyboard makes while a key is held. */
    allowClick(e) {
      return !keyboardClickWhileHeld(e, heldKey);
    },
    /** A card's click: chooses it — not a double-click's second click, which lands on whatever slid under it. */
    cardClick(e, id) {
      if (e.detail > 1 || !input.allowClick(e)) return;
      fx.choose(id);
    },
    /**
     * A trash button's click: deletes its theme — not a double-click's second
     * click, nor a pointer click within TRASH_GRACE_MS of the last delete with
     * the pointer still where it was.
     */
    trashClick(e, id) {
      if (e.detail > 1 || !input.allowClick(e)) return;
      if (e.detail >= 1 && fx.now() - lastDeleteAt < TRASH_GRACE_MS && !movedSinceDelete) return;
      deleteNow(id);
    },
    noticeFocusIn() {
      focusInNotice = true;
    },
    noticeFocusOut() {
      focusInNotice = false;
    },
    /**
     * After each render: when the notice the keyboard was in has gone from
     * under it — dismissed, or replaced by a failed pick or undo — the
     * keyboard goes to the cards' Tab stop instead of the page.
     */
    afterRender({ focusLost, focusInNoticeNow, tabStop }) {
      const target = refocusAfterNotice({ focusWasInNotice: focusInNotice, focusLost, tabStop });
      if (target) {
        focusInNotice = false;
        fx.focusCard(target);
        return;
      }
      if (!focusInNoticeNow) focusInNotice = false;
    },
  };
  return input;
}
