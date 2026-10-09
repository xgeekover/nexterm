/**
 * A press on an Explorer row: a click that opens the row, or the start of
 * dragging it onto a terminal pane, which inserts its path there
 * (src/lib/terminalFileDrop.js does the inserting).
 *
 * Pointer events, never HTML5 drag and drop: Tauri's drag-drop handler takes
 * HTML5 drags on Windows, and WKWebView will not start a native drag inside a
 * `user-select: none` subtree — the Explorer is one. The terminal's tab
 * reorder is pointer events for the same reasons (TerminalSplitContainer.jsx).
 *
 * The press selects its row, as it always has. What happens next is decided
 * by the press's OWN release, not by the click the browser sends after it:
 *
 *   - never past `EXPLORER_DRAG_THRESHOLD_PX`: a click — the row that was
 *     PRESSED opens (a file in the editor, a folder in the tree), wherever
 *     the release lands;
 *   - past it: a drag, and the release drops the path;
 *   - called off — Escape, a cancelled pointer, the window losing focus, a
 *     context menu — nothing, however late the release comes.
 *
 * The browser's click is no good for this, and every way it fails was seen
 * in a real Chromium: after a drag the row still holds the pointer, so the
 * click lands on it however long after an Escape the button comes up; text
 * dragged out of the rename input onto its row clicks the row; a press that
 * closes the New File box shifts every row below it, and the release, on
 * another row now, clicks only their common parent — the press opened
 * nothing; a few pixels across a row's edge did the same; a press on a
 * folder's twisty slid onto its row clicked the row and toggled the folder
 * straight back. So a row's DOM click opens it only when no pointer is behind
 * it (`clickActivates`): the keyboard, or assistive technology.
 *
 * A press that is not the row's own — on its twisty, in the rename input, a
 * button other than the primary one, Ctrl+click on a Mac — is no gesture at
 * all (`pressArmsDrag`), and opens nothing.
 *
 * The decisions and the listeners are both here, apart from React, because
 * the suites never mount a component: src/hooks/useExplorerPathDrag.js only
 * hands `followExplorerPress` what to do. tests/adversarial/terminal_file_drop.test.js.
 */

/** Pointer travel before a press on a row becomes a drag (the tab strip's is 4). */
export const EXPLORER_DRAG_THRESHOLD_PX = 5;

/**
 * Elements inside a row that keep their own press: the inline rename input,
 * and anything marked as a control of the row (a folder's twisty).
 */
const NOT_A_DRAG_HANDLE = 'input, textarea, select, button, [contenteditable], [data-no-path-drag]';

/**
 * Whether a press on a row is the row's own — one that may open it or drag
 * it: the primary button, with the row not being renamed and the press not
 * on one of the row's controls. On macOS Ctrl+click is the secondary click
 * and opens the context menu.
 *
 * @param {{button: number, isPrimary?: boolean, ctrlKey?: boolean}} event
 * @param {{closest?: Function}|null} target  the element pressed
 * @param {{renaming?: boolean, platform?: string}} options
 */
export function pressArmsDrag(event, target, { renaming = false, platform = null } = {}) {
  if (!event || event.button !== 0 || event.isPrimary === false || renaming) return false;
  if (event.ctrlKey && platform === 'macos') return false;
  return !target?.closest?.(NOT_A_DRAG_HANDLE);
}

/**
 * Whether a DOM click on a row should open it: only a click no pointer made
 * — Enter on a focused control, assistive technology — whose `detail` (the
 * click count) is 0. A pointer's press is opened by its own release
 * (`followExplorerPress`).
 */
export function clickActivates(event) {
  return Boolean(event) && event.button === 0 && event.detail === 0;
}

/**
 * One press at a time, as a small state machine:
 *
 *   idle ──press──▶ pressed ──move past the threshold──▶ dragging
 *     ▲               │ release: 'click'                   │ release: 'drop'
 *     └───────────────┴───────────── cancel ───────────────┘
 *
 * `move` answers 'start' once, when the press becomes a drag, then 'move';
 * 'none' while it is still a press, or for another pointer. `release` and
 * `cancel` end the gesture; a release after a cancel finds it idle and is
 * 'none'.
 */
export function createExplorerDrag({ threshold = EXPLORER_DRAG_THRESHOLD_PX } = {}) {
  let phase = 'idle';
  let item = null;
  let origin = null;
  let pointerId = null;

  /** Whether `id` is the pointer this gesture follows (any, when either is unknown). */
  const owns = (id) => phase !== 'idle' && (pointerId === null || id === undefined || id === pointerId);

  const finish = () => {
    const ended = { phase, item };
    phase = 'idle';
    item = null;
    origin = null;
    pointerId = null;
    return ended;
  };

  return {
    get phase() {
      return phase;
    },
    get item() {
      return item;
    },
    owns,

    press(pressed, { x, y, pointerId: id = null }) {
      phase = 'pressed';
      item = pressed;
      origin = { x, y };
      pointerId = id;
    },

    move({ x, y, pointerId: id }) {
      if (!owns(id)) return 'none';
      if (phase === 'dragging') return 'move';
      if (Math.hypot(x - origin.x, y - origin.y) <= threshold) return 'none';
      phase = 'dragging';
      return 'start';
    },

    /** The pointer was let go: 'drop' after a drag, 'click' after a press, 'none' when there was neither. */
    release() {
      const ended = finish();
      if (ended.phase === 'dragging') return { type: 'drop', item: ended.item };
      if (ended.phase === 'pressed') return { type: 'click', item: ended.item };
      return { type: 'none', item: null };
    },

    /** Called off. True when it was a drag. */
    cancel() {
      return finish().phase === 'dragging';
    },
  };
}

/**
 * Follow a press on `row` that `pressArmsDrag` let through, from its
 * pointerdown to its end, with listeners on `win`:
 *
 *   onActivate(row)    released without ever becoming a drag: open `row`
 *   onDragStart(point) the press became a drag (capture the pointer, draw the chip)
 *   onDragMove(point)  the drag moved — the start included
 *   onDrop(point)      released after a drag
 *   onEnd()            over, in whichever way: clear what the drag drew
 *
 * The listeners go on the window, attached by the press itself rather than
 * by an effect: a quick flick delivers its moves and its release before
 * React would have committed anything (TerminalSplitContainer's
 * `trackGesture` learned that). Returns the function that calls the press
 * off — for a new press while this one is still listening (its release went
 * somewhere the window never heard), or the Explorer going away mid-drag.
 */
export function followExplorerPress(
  event,
  row,
  {
    win = globalThis.window,
    gesture,
    onActivate = () => {},
    onDragStart = () => {},
    onDragMove = () => {},
    onDrop = () => {},
    onEnd = () => {},
  }
) {
  gesture.press(row, { x: event.clientX, y: event.clientY, pointerId: event.pointerId });
  const point = (ev) => ({ x: ev.clientX, y: ev.clientY });
  let ended = false;

  const onMove = (ev) => {
    const step = gesture.move({ ...point(ev), pointerId: ev.pointerId });
    if (step === 'none') return;
    if (step === 'start') onDragStart(point(ev));
    onDragMove(point(ev));
  };

  const onUp = (ev) => {
    if (!gesture.owns(ev.pointerId)) return;
    const outcome = gesture.release();
    end();
    if (outcome.type === 'click') onActivate(outcome.item);
    else if (outcome.type === 'drop') onDrop(point(ev));
  };

  // A focus loss carries no pointer; a context menu may (Chromium's is a
  // pointer event), and then it has to be this gesture's own pointer.
  const onCancel = (ev) => {
    if (ev?.pointerId !== undefined && !gesture.owns(ev.pointerId)) return;
    gesture.cancel();
    end();
  };

  const onKeyDown = (ev) => {
    if (ev.key !== 'Escape') return;
    // Only a drag keeps the key to itself; while it is still a press,
    // Escape goes on to whatever else it means — and the press is over.
    if (gesture.phase === 'dragging') {
      ev.preventDefault();
      ev.stopPropagation();
    }
    gesture.cancel();
    end();
  };

  const listeners = [
    ['pointermove', onMove, false],
    ['pointerup', onUp, false],
    ['pointercancel', onCancel, false],
    ['keydown', onKeyDown, true],
    ['blur', onCancel, false],
    ['contextmenu', onCancel, true],
  ];

  function end() {
    if (ended) return;
    ended = true;
    for (const [type, fn, capture] of listeners) win.removeEventListener(type, fn, capture);
    onEnd();
  }

  for (const [type, fn, capture] of listeners) win.addEventListener(type, fn, capture);

  return function stop() {
    if (ended) return;
    gesture.cancel();
    end();
  };
}
