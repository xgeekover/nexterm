/**
 * A pointer press on a split divider leaves it focused; this lets it go.
 *
 * react-resizable-panels v4 focuses a separator from its own capture
 * pointerdown on the document (`element.focus({ focusVisible: false })`)
 * whenever a press lands in a separator's hit area, and nothing blurs it
 * afterwards. A focused separator reports `data-separator="focus"` instead of
 * `"hover"`, so from the first drag on only the line's own 1px turned violet
 * under the pointer, not the 10px hit area around it (the "stuck" highlight).
 *
 * The rule: when a press ends, the separator that this press focused is
 * blurred, and no other. `installSeparatorFocusRelease(doc)` adds three
 * capture listeners:
 *
 * - `pointerdown` on the window (`doc.defaultView`) remembers
 *   `doc.activeElement`, the focus before the press. Window capture runs
 *   before every listener on the document, so before the library's focus,
 *   and before the engine's own focus on mousedown.
 * - `pointerup` and `pointercancel` on the document: if `doc.activeElement`
 *   is a separator and is not the element focused before the press, its
 *   `blur()` is called, back to `"hover"`/`"inactive"`. Then the press is
 *   forgotten.
 *
 * So a separator focused by Tab keeps its 3px ring and its arrow keys when a
 * press that moves no focus (a menu item, a Dismiss) ends somewhere else, and
 * when a press on it ends (a drag of a divider the user tabbed to: they chose
 * keyboard focus). This asks nothing of the engine: it does not depend on
 * `:focus-visible`, or on the engine honouring `focusVisible: false`.
 *
 * A press of a mouse button other than the main one arms nothing, as the
 * library ignores it (it does not focus for one). A press that ends with
 * another button reported (a chord) is still the main button's press.
 *
 * The blur waits for the release rather than happening on the focus: the
 * library is starting a drag then, and the drag ends on the release (or on a
 * cancel, when the engine takes the pointer over).
 *
 * A document with no window (`defaultView` null) gets its pointerdown on the
 * document instead. There it runs in registration order with the library's:
 * installed before the library it still sees the focus before the press;
 * installed after it, a pressed separator already counts as focused before,
 * and is kept focused (the stuck highlight, never a lost keyboard focus).
 *
 * Nothing here touches a DOM global: the document is passed in (PanelLayout
 * passes `document` from an effect), and the window is the document's own,
 * so a test hands it a fake one.
 */

/** What the library puts on every separator, in every state. */
export const SEPARATOR_SELECTOR = '[data-separator]';

/**
 * Blurs, when a pointer press ends, the separator that press focused.
 *
 * @param {Document | { addEventListener: Function, removeEventListener: Function, activeElement?: Element | null, defaultView?: { addEventListener: Function, removeEventListener: Function } | null } | null | undefined} doc
 * @returns {() => void} removes the listeners again; calling it twice is harmless.
 */
export function installSeparatorFocusRelease(doc) {
  if (!doc || typeof doc.addEventListener !== 'function') return () => {};
  const view = doc.defaultView;
  const pressTarget = view && typeof view.addEventListener === 'function' ? view : doc;

  // The press under way, and what had focus before it.
  let pressed = false;
  let focusedBefore = null;

  const onPointerDown = (event) => {
    // The library focuses only for the main button of a mouse (and for any
    // touch or pen press); a press of another button is none of ours.
    if (event && event.pointerType === 'mouse' && event.button > 0) return;
    pressed = true;
    focusedBefore = doc.activeElement ?? null;
  };

  const onPressEnd = () => {
    if (!pressed) return;
    const before = focusedBefore;
    pressed = false;
    focusedBefore = null;
    const active = doc.activeElement;
    // Focused before the press (Tab, then a press anywhere): not the press's to undo.
    if (!active || active === before) return;
    if (typeof active.matches !== 'function' || typeof active.blur !== 'function') return;
    if (!active.matches(SEPARATOR_SELECTOR)) return;
    active.blur();
  };

  pressTarget.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerup', onPressEnd, true);
  doc.addEventListener('pointercancel', onPressEnd, true);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    pressTarget.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointerup', onPressEnd, true);
    doc.removeEventListener('pointercancel', onPressEnd, true);
  };
}
