/**
 * Cmd/Ctrl+click on a file or folder name in a terminal's output shows it in
 * the file manager — the xterm side of it. Which words are names is
 * src/lib/outputPaths.js, which directory they are in src/lib/outputContext.js;
 * showing one is the backend's `fs_reveal_path`, which never opens a file.
 *
 * Without the modifier nothing may change, and nothing is asked: no
 * underline, no pointer, a click does what it did, a double-click or a
 * right-click selects the word it selected, and no name is looked up — the
 * pointer resting over streaming output, or the prompt being typed on, used
 * to cost a lookup per row per moment (182 in three seconds, measured), and
 * a lookup touches whatever drive a word names. So:
 *
 *   - the provider answers "nothing here" until the modifier is down, and
 *     then looks the row up — one lookup in flight per terminal, the newest
 *     row waiting, an overtaken answer dropped;
 *   - when the modifier goes down with the pointer still, xterm is made to
 *     ask again (`relook`): it asks only when the pointer moves to another
 *     row, so it is moved there and back by synthetic events;
 *   - links are drawn only while the modifier is down — VS Code's
 *     `TerminalLink` model: decorations follow the key while hovered;
 *   - xterm activates a link on the release of any press over it, so
 *     `activate` takes only a single main-button click with the modifier;
 *   - a press that would select a word — a double-click, a right-click, and
 *     on macOS a Ctrl-click, which is one — would select the hovered link
 *     instead (`_selectWordAtCursor` takes its range first), so xterm is
 *     made to let go of the link before the press reaches it, and to find it
 *     again after.
 *
 * Kept apart from terminalRegistry.js, which wires it, so the suites can drive
 * it with a stand-in terminal: no xterm, no stores and no IPC here.
 */
import { chooseLinks, isRevealClick, isRevealModifier, pathsAtRow } from './outputPaths.js';
import { contextAt, planNames } from './outputContext.js';

/**
 * How long a lone Ctrl pressed on Windows waits before it counts. AltGr
 * arrives as Ctrl and then Ctrl+Alt a moment later; taken at once, the first
 * drew the underline for a frame on every AltGr character typed.
 */
export const ALTGR_GRACE_MS = 40;

/**
 * The browser's timers, called as plain functions. Stored as they are — `{
 * set: setTimeout }` — and called as `timers.set(…)`, they run with the
 * object as `this`, and a browser's setTimeout refuses that ("Illegal
 * invocation"): every lone Ctrl on Windows threw, and the modifier never
 * counted from the keyboard (review, 2026-10-10). Node does not mind, which
 * is how the suites, handing in timers of their own, missed it.
 */
const BROWSER_TIMERS = Object.freeze({
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
});

/**
 * Whether the reveal modifier is down, as the last key or mouse event in the
 * window said, and who to tell when it changes.
 *
 * One for the whole window. Listened for in the capture phase, so no handler
 * underneath — xterm's on its textarea, the app's key bindings — can keep an
 * event from it; it only reads. The mouse counts as well as the keyboard: a
 * key pressed while another window had the focus reaches nobody, and the
 * next movement over the terminal still says it is down. Losing the focus
 * lets go of it, as ⌘-Tab away does without a keyup.
 *
 * `target` is the window (anything without `addEventListener`, as under
 * Node, gives a tracker that is never held); `platform()` the system store's
 * `os`, read at each event. `timers` stand in for setTimeout/clearTimeout.
 */
export function createModifierTracker(target, platform, timers = BROWSER_TIMERS) {
  let held = false;
  let pending = null;
  const subscribers = new Set();
  const set = (next) => {
    if (next === held) return;
    held = next;
    for (const fn of [...subscribers]) fn(held);
  };
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  const fromEvent = (event) => {
    const next = isRevealModifier(event, platform());
    if (next && !held && event.type === 'keydown' && event.key === 'Control' && platform() === 'windows') {
      if (pending === null) {
        pending = timers.set(() => {
          pending = null;
          set(true);
        }, ALTGR_GRACE_MS);
      }
      return;
    }
    cancel();
    set(next);
  };
  const letGo = () => {
    cancel();
    set(false);
  };
  const INPUT = ['keydown', 'keyup', 'mousemove', 'mousedown'];
  const listening = typeof target?.addEventListener === 'function';
  if (listening) {
    for (const type of INPUT) target.addEventListener(type, fromEvent, { capture: true, passive: true });
    target.addEventListener('blur', letGo);
  }
  return {
    get held() {
      return held;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    dispose() {
      cancel();
      subscribers.clear();
      if (!listening) return;
      for (const type of INPUT) target.removeEventListener(type, fromEvent, { capture: true });
      target.removeEventListener('blur', letGo);
    },
  };
}

/** A mouse event of `type` at `init`'s point: a real MouseEvent where there is one (a browser), a plain Event carrying the same fields under Node. */
function mouseEvent(type, init) {
  if (typeof MouseEvent === 'function') return new MouseEvent(type, init);
  return Object.assign(new Event(type, init), init);
}

/**
 * Give `term` the links to names in its output, for as long as the returned
 * disposable lives.
 *
 * `deps`:
 *   - `modifier` — a `createModifierTracker`;
 *   - `kinds` — a `createKindLookup` (outputPaths.js), shared by every
 *     terminal: a path is a path whichever terminal printed it;
 *   - `where()` — `{ os, home, msys }` now: the platform, the home folder,
 *     and whether the tab's shell is Git Bash's or Cygwin's (only there is
 *     `/c/x` a path);
 *   - `cwdAt(line)` — the tab's directory when buffer line `line` was
 *     printed (`createCwdTrail`);
 *   - `marks()` — the terminal's command marks (src/lib/stickyCommand.js);
 *   - `reveal(path)` — shows it, rejecting when it cannot;
 *   - `notice(message)` — says so in the terminal.
 *   - `timers` — setTimeout/clearTimeout, for the suites.
 */
export function installRevealLinks(term, container, deps) {
  const {
    modifier,
    kinds,
    where,
    cwdAt = () => null,
    marks = () => [],
    reveal,
    notice,
    timers = BROWSER_TIMERS,
  } = deps;
  // The newest question; an answer to an older one is dropped.
  let asked = 0;
  // The link of ours under the pointer, and what stops it following the key.
  let hovered = null;
  let stopFollowing = null;
  // One lookup at a time; the newest question waiting behind it.
  let looking = false;
  let waiting = null;
  // Where the pointer is over this terminal, from its own movements, and
  // which buttons are down.
  const pointer = { inside: false, x: null, y: null, buttons: 0 };
  // Set while this module moves the pointer itself (`relook`).
  let dispatching = false;
  let suppress = false;
  // Look again once the buttons are up (`afterPress`), and the timer that will.
  let relookOnRelease = false;
  let releaseTimer = null;
  // A modifier-click made before its row's answer came (`pendingClick`).
  let pendingClick = null;
  let disposed = false;

  const unhover = () => {
    hovered = null;
    stopFollowing?.();
    stopFollowing = null;
  };

  // xterm 6 swaps `link.decorations` for an object of its own once the link
  // is hovered, whose setters redraw: `underline` fires the link-underline
  // event the renderer draws from, `pointerCursor` toggles the
  // `xterm-cursor-pointer` class (src/browser/Linkifier.ts, `_handleNewLink`).
  // Read through `link` every time, never kept, for that reason.
  const decorate = (link, held) => {
    link.decorations.pointerCursor = held;
    link.decorations.underline = held;
  };

  // A name can be deleted between the hover and the click, and the backend
  // refuses what it will not show. Said where the user is looking, and never
  // thrown: a click must not take the window down.
  const show = (candidate) => {
    Promise.resolve()
      .then(() => reveal(candidate.path))
      .catch(() => notice(`could not show ${candidate.path} in the file manager`));
  };
  const linkCandidates = new WeakMap();

  const linkFor = (candidate) => {
    const held = modifier.held;
    const link = {
      range: candidate.range,
      text: candidate.drawn ?? candidate.text,
      // As they are when this answer is made. xterm reads them as the
      // pointer comes onto the link, which may be a while later — `hover`
      // puts them right.
      decorations: { pointerCursor: held, underline: held },
      hover: () => {
        unhover();
        hovered = link;
        stopFollowing = modifier.subscribe((down) => decorate(link, down));
        // After xterm has swapped in its own decorations, which happens once
        // `hover` returns: set before then, they are lost.
        queueMicrotask(() => {
          if (hovered === link) decorate(link, modifier.held);
        });
      },
      leave: () => {
        if (hovered === link) unhover();
      },
      activate: (event) => {
        const { os } = where();
        // One click, one reveal: the second and third press of a double or
        // triple click are activations too.
        if (!isRevealClick(event, os) || (event.detail ?? 1) > 1) return;
        event.preventDefault?.();
        show(candidate);
      },
    };
    linkCandidates.set(link, candidate);
    return link;
  };

  const run = (job) => {
    if (job.question !== asked) {
      // Overtaken while it waited: nobody wants its answer.
      const next = waiting;
      waiting = null;
      if (next) run(next);
      return;
    }
    looking = true;
    kinds
      .kinds(job.paths)
      .then(job.settle, () => job.settle(new Map()))
      .finally(() => {
        looking = false;
        const next = waiting;
        waiting = null;
        if (next && !disposed) run(next);
      });
  };

  const disposable = term.registerLinkProvider({
    provideLinks(row, callback) {
      asked += 1;
      const question = asked;
      const answer = (links) => {
        if (question === asked) callback(links.length ? links : undefined);
      };
      // Nothing is looked up unless the modifier is down — see the header.
      if (suppress || !modifier.held) {
        answer([]);
        return;
      }
      const buffer = term.buffer.active;
      const candidates = pathsAtRow(buffer, row);
      if (candidates.length === 0) {
        answer([]);
        return;
      }
      const { os, home, msys } = where();
      const context = contextAt({ buffer, line: row - 1, cwdAt, marks: marks() });
      const plan = planNames(candidates, context, { os, home, msys });
      if (plan.paths.length === 0) {
        answer([]);
        return;
      }
      const settle = (found) => {
        const links = chooseLinks(plan.choose(found), found).map(linkFor);
        answer(links);
        if (question === asked) clickWhenAnswered(row, links);
      };
      const known = kinds.known(plan.paths);
      if (known) {
        settle(known);
        return;
      }
      const job = { question, paths: plan.paths, settle };
      if (looking) waiting = job;
      else run(job);
    },
  });

  const screen = () => term.element?.querySelector?.('.xterm-screen') ?? null;
  const view = () => container?.ownerDocument?.defaultView ?? term.element?.ownerDocument?.defaultView ?? null;

  /**
   * The cell at a point of the screen, as xterm counts for a link — 1-based
   * column, 1-based buffer row — or null when the point is not on the
   * screen's cells: the scrollbar beside them is in this terminal's
   * container as well.
   */
  /**
   * Whether this terminal has been taken off screen — a tab or group
   * switched away keeps its element, detached, and hears no `mouseleave`.
   * The pointer is then over another terminal, whatever was last seen here.
   */
  const offScreen = () => {
    if (screen()?.isConnected !== false && container?.isConnected !== false) return false;
    pointer.inside = false;
    pendingClick = null;
    return true;
  };

  const cellAt = (x, y) => {
    const rect = screen()?.getBoundingClientRect?.();
    if (!rect || !term.rows || !term.cols || typeof x !== 'number' || typeof y !== 'number') return null;
    if (x < rect.left || y < rect.top || x >= rect.left + rect.width || y >= rect.top + rect.height) return null;
    return {
      col: Math.floor((x - rect.left) / (rect.width / term.cols)) + 1,
      row: Math.floor((y - rect.top) / (rect.height / term.rows)) + 1 + (term.buffer.active.viewportY ?? 0),
    };
  };

  /**
   * Make xterm ask about the row under the pointer again. It asks only when
   * the pointer moves onto another row — and its answer for this one was
   * "nothing" while the modifier was up — so the pointer is moved a row away
   * and back, with this module's own answer for the row away kept empty.
   *
   * Only for a pointer on this terminal's cells (not its scrollbar), in a
   * terminal on screen (a tab switched away keeps its element, detached,
   * and hears no `mouseleave`), and not while a program tracks the mouse —
   * those movements would be reported to it. Not while a button is down
   * either: the moves say no button is, which reads as a release to mouse
   * reporting, and a move drags xterm's selection — looked again once the
   * buttons are up instead. `duringPress` is the one exception: the press
   * that is about to happen, before xterm or anything else has heard it.
   */
  const relook = ({ duringPress = false } = {}) => {
    const el = screen();
    if (!el || !pointer.inside || disposed) return;
    if (offScreen()) return;
    const tracking = term.modes?.mouseTrackingMode;
    if (tracking && tracking !== 'none') return;
    if (pointer.buttons && !duringPress) {
      relookOnRelease = true;
      return;
    }
    const rect = el.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height || !cellAt(pointer.x, pointer.y)) return;
    const cell = rect.height / term.rows;
    const row = Math.floor((pointer.y - rect.top) / cell);
    const away = row > 0 ? pointer.y - cell : pointer.y + cell;
    const held = modifier.held;
    const init = (y) => ({
      clientX: pointer.x,
      clientY: y,
      metaKey: held && where().os === 'macos',
      ctrlKey: held && where().os !== 'macos',
    });
    dispatching = true;
    try {
      suppress = true;
      try {
        el.dispatchEvent(mouseEvent('mousemove', init(away)));
      } finally {
        suppress = false;
      }
      el.dispatchEvent(mouseEvent('mousemove', init(pointer.y)));
    } finally {
      dispatching = false;
    }
  };

  const stopRelooking = modifier.subscribe((down) => {
    if (down) relook();
  });

  /**
   * A click with the modifier made before its row's answer came — a quick
   * Cmd+click, faster than the lookup: xterm heard the press with no link
   * under it, and lets the answer pass. The link under the click's cell is
   * shown once both have happened, in either order: the answer has come,
   * and the button was released on that same cell — a press that turned
   * into a drag shows nothing. That click only, only with the pointer still
   * in this terminal and the terminal still on screen, and not once another
   * press, or a move to another row, or to another cell with the button
   * down, came first.
   */
  const finishClick = () => {
    const click = pendingClick;
    if (!click?.released || !click.candidate) return;
    pendingClick = null;
    if (pointer.inside && !offScreen()) show(click.candidate);
  };
  const clickWhenAnswered = (row, links) => {
    const click = pendingClick;
    if (!click || click.candidate) return;
    if (click.row !== row || !term.cols) {
      pendingClick = null;
      return;
    }
    const at = (y, x) => y * term.cols + x;
    const spot = at(click.row, click.col);
    const hit = links.find((link) => at(link.range.start.y, link.range.start.x) <= spot && spot <= at(link.range.end.y, link.range.end.x));
    if (!hit) {
      pendingClick = null;
      return;
    }
    click.candidate = linkCandidates.get(hit);
    finishClick();
  };

  // Where the pointer is, and its buttons, from its own movements over this
  // terminal.
  const onMove = (event) => {
    if (dispatching) return;
    pointer.inside = true;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (typeof event.buttons === 'number') pointer.buttons = event.buttons;
    if (pendingClick) {
      const cell = cellAt(pointer.x, pointer.y);
      const dragged = pointer.buttons && !pendingClick.released && cell?.col !== pendingClick.col;
      if (cell?.row !== pendingClick.row || dragged) pendingClick = null;
    }
  };
  const onLeave = () => {
    pointer.inside = false;
    pendingClick = null;
  };

  /** Tell xterm the pointer left, so it lets go of the hovered link (Linkifier's `mouseleave`). */
  const releaseLink = () => {
    const el = screen();
    if (el && typeof Event === 'function') el.dispatchEvent(new Event('mouseleave'));
  };

  /**
   * Buttons up, anywhere in the window: and when a look was put off for
   * them — a press that let go of the link, or the modifier going down
   * mid-press — look now, a task later, so xterm has finished with the
   * release. With the modifier still down, a Cmd+click on the same cell
   * would otherwise find no link: xterm looks only when the pointer changes
   * cell.
   */
  const onRelease = (event) => {
    pointer.buttons = typeof event.buttons === 'number' ? event.buttons : 0;
    if (pendingClick && !pendingClick.released) {
      const cell = cellAt(event.clientX, event.clientY);
      if (cell && cell.row === pendingClick.row && cell.col === pendingClick.col) {
        pendingClick.released = true;
        finishClick();
      } else {
        pendingClick = null;
      }
    }
    if (!relookOnRelease || pointer.buttons) return;
    relookOnRelease = false;
    if (releaseTimer !== null) timers.clear(releaseTimer);
    releaseTimer = timers.set(() => {
      releaseTimer = null;
      if (modifier.held) relook();
    }, 0);
  };
  const afterPress = () => {
    relookOnRelease = true;
  };

  // A press that would select a word — the second of a double-click
  // without the modifier, or a right-click (on macOS also a Ctrl-click,
  // which is one), with the modifier or not — over one of these links:
  // xterm would select the link instead (`_selectWordAtCursor` takes the
  // hovered link's range first). Its link detection lets go of the hovered
  // link when the pointer leaves the screen element, so that is what it is
  // told, before the press reaches it. In the capture phase on the
  // container, so it is heard before xterm's own handlers on the element
  // inside it. `contextmenu` too, which is where xterm answers a right-click
  // in a browser that sends no right-button press first.
  const keepWordSelection = (event) => {
    const { os } = where();
    // Any press ends a click still waiting for its answer.
    pendingClick = null;
    pointer.buttons = typeof event.buttons === 'number' && event.buttons ? event.buttons : 1;
    if (!hovered) {
      // A click with the modifier where xterm holds no link — its last look
      // at this row was without the modifier, or a press since let go of it:
      // looked again now, before xterm hears the press, so a known name is
      // its link by the time the press is (its kinds remembered, the answer
      // comes at once) — and if the answer is still on its way, the click
      // waits for it.
      if (event.button === 0 && (event.detail ?? 1) <= 1 && modifier.held && isRevealModifier(event, os)) {
        pointer.inside = true;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        relook({ duringPress: true });
        const cell = !hovered && cellAt(event.clientX, event.clientY);
        if (cell) pendingClick = { ...cell, released: false, candidate: null };
      }
      return;
    }
    const secondary = event.button === 2 || (os === 'macos' && event.button === 0 && Boolean(event.ctrlKey));
    if (!secondary && ((event.detail ?? 0) < 2 || isRevealModifier(event, os))) return;
    releaseLink();
    afterPress();
  };
  const keepWordOnMenu = () => {
    if (!hovered) return;
    releaseLink();
    afterPress();
  };
  container?.addEventListener?.('mousedown', keepWordSelection, true);
  container?.addEventListener?.('contextmenu', keepWordOnMenu, true);
  container?.addEventListener?.('mousemove', onMove, true);
  container?.addEventListener?.('mouseleave', onLeave);
  const releases = view();
  releases?.addEventListener?.('mouseup', onRelease, true);

  return {
    /** For the suites: re-ask about the row under the pointer. */
    relook,
    dispose() {
      disposed = true;
      unhover();
      stopRelooking();
      pendingClick = null;
      if (releaseTimer !== null) timers.clear(releaseTimer);
      disposable?.dispose?.();
      container?.removeEventListener?.('mousedown', keepWordSelection, true);
      container?.removeEventListener?.('contextmenu', keepWordOnMenu, true);
      container?.removeEventListener?.('mousemove', onMove, true);
      container?.removeEventListener?.('mouseleave', onLeave);
      releases?.removeEventListener?.('mouseup', onRelease, true);
    },
  };
}

export default { createModifierTracker, installRevealLinks, ALTGR_GRACE_MS };
