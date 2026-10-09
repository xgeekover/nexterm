/**
 * The xterm side of W12 — src/lib/revealLinks.js — driven with a stand-in
 * terminal over a real headless xterm buffer, and the wiring in
 * terminalRegistry.js.
 *
 * What must hold: with the modifier held a name that exists is underlined
 * with a pointer, and a click shows it in the file manager; without it
 * NOTHING is different — no underline, no pointer, a click does nothing new,
 * a double-click or a right-click still selects the word — and nothing is
 * looked up. xterm is never kept waiting on the disk, and one lookup at a
 * time goes to it per terminal.
 *
 * Node has no xterm that draws, so what xterm 6's link detection does with a
 * link (src/browser/Linkifier.ts) is restated here as `hoverLikeXterm`, and
 * the lines of xterm's own source that restatement depends on are checked in
 * the version installed (RL-09) — the same arrangement hyperlinks.test.js
 * has for OSC 8. reveal_links_headless.test.js drives the real thing.
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { createKindLookup } from '../../src/lib/outputPaths.js';
import { ALTGR_GRACE_MS, createModifierTracker, installRevealLinks } from '../../src/lib/revealLinks.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { useEditorStore } from '../../src/stores/editorStore.js';

const { Terminal: HeadlessTerminal } = headless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Where the tab is, on each platform, and what exists there. */
const PLACES = {
  macos: { cwd: '/home/me/proj', sep: '/' },
  windows: { cwd: 'C:\\proj', sep: '\\' },
};
const at = (os, name) => `${PLACES[os].cwd}${PLACES[os].sep}${name}`;
const fsFor = (os) => ({
  [at(os, 'My Folder')]: 'dir',
  [at(os, 'My')]: 'file',
  [at(os, 'build.sh')]: 'file',
  [at(os, 'src/a.js')]: 'file',
});
const LISTING = [
  "drwxr-xr-x 2 me me 4096 Oct  9 22:00 'My Folder'",
  '-rwxr-xr-x 1 me me    0 Oct  9 22:00  build.sh',
  'see https://example.com/x and src/a.js:3',
];
const ROW_HEIGHT = 20;

/** An event of `type` with the given fields — Node has no KeyboardEvent or MouseEvent. */
function event(type, fields = {}) {
  return Object.assign(new Event(type), { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...fields });
}

/** Timers run by hand: `run()` fires what is due. */
function manualTimers() {
  let next = 1;
  const due = new Map();
  return {
    set(fn) {
      due.set(next, fn);
      return next++;
    },
    clear(id) {
      due.delete(id);
    },
    run() {
      for (const [id, fn] of [...due]) {
        due.delete(id);
        fn();
      }
    },
    get pending() {
      return due.size;
    },
  };
}

/**
 * A terminal as `installRevealLinks` uses one: xterm's buffer (a real one),
 * `registerLinkProvider`, the screen element xterm's link detection listens
 * on — `ROW_HEIGHT` pixels a row — and the window it is in. `left` counts the
 * `mouseleave` events that element heard, `moves` the rows of the
 * `mousemove`s dispatched on it; each such move asks the provider about its
 * row, as xterm does when the pointer changes row.
 */
async function setUp({ os = 'macos', lines = LISTING, ask, tracking = 'none' } = {}) {
  const xterm = new HeadlessTerminal({ cols: 100, rows: 8, allowProposedApi: true });
  await write(xterm, `${lines.join('\r\n')}\r\n`);
  const fs = fsFor(os);
  const view = new EventTarget();
  const screen = new EventTarget();
  screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: ROW_HEIGHT * 8 });
  let left = 0;
  const moves = [];
  const answers = [];
  screen.addEventListener('mouseleave', () => {
    left += 1;
  });
  const term = {
    buffer: xterm.buffer,
    rows: 8,
    cols: 100,
    modes: { mouseTrackingMode: tracking },
    element: { ownerDocument: { defaultView: view }, querySelector: (selector) => (selector === '.xterm-screen' ? screen : null) },
    provider: null,
    disposed: false,
    registerLinkProvider(provider) {
      term.provider = provider;
      return {
        dispose() {
          term.disposed = true;
        },
      };
    },
  };
  screen.addEventListener('mousemove', (e) => {
    const row = Math.floor(e.clientY / ROW_HEIGHT) + 1;
    moves.push(row);
    let returned = false;
    term.provider.provideLinks(row, (links) => answers.push({ row, links, synchronous: !returned }));
    returned = true;
  });
  const window = new EventTarget();
  const container = new EventTarget();
  const calls = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const kinds = createKindLookup({
    ask:
      ask ||
      (async (paths) => {
        calls.push([...paths]);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await tick();
        inFlight -= 1;
        return paths.map((p) => fs[p] ?? null);
      }),
  });
  const revealed = [];
  const notices = [];
  let refuse = false;
  const timers = manualTimers();
  const modifier = createModifierTracker(window, () => os, timers);
  const links = installRevealLinks(term, container, {
    modifier,
    kinds,
    where: () => ({ os, home: null, msys: false }),
    cwdAt: () => PLACES[os].cwd,
    marks: () => [],
    reveal: async (path) => {
      if (refuse) throw new Error('gone');
      revealed.push(path);
    },
    notice: (message) => notices.push(message),
    timers,
  });
  const key = os === 'macos' ? { key: 'Meta', metaKey: true } : { key: 'Control', ctrlKey: true };
  return {
    xterm,
    term,
    window,
    view,
    container,
    screen,
    calls,
    revealed,
    notices,
    modifier,
    links,
    timers,
    moves,
    answers,
    get left() {
      return left;
    },
    get mostInFlight() {
      return mostInFlight;
    },
    refuse() {
      refuse = true;
    },
    /** The modifier down (and, on Windows, past AltGr's grace), or up. */
    hold() {
      window.dispatchEvent(event('keydown', key));
      timers.run();
    },
    release() {
      window.dispatchEvent(event('keyup', { key: key.key }));
    },
    /** The pointer over the terminal at `row`, as the browser would report it. */
    point(row) {
      container.dispatchEvent(event('mousemove', { clientX: 40, clientY: (row - 1) * ROW_HEIGHT + 5 }));
    },
  };
}

/** xterm asking for `row`: the links, and whether they came back before `provideLinks` returned. */
function provide(t, row) {
  return new Promise((resolve) => {
    let returned = false;
    t.term.provider.provideLinks(row, (links) => resolve({ links, synchronous: !returned }));
    returned = true;
  });
}

/**
 * What xterm 6's Linkifier does when the pointer comes onto `link`
 * (`_handleNewLink` and `_linkHover`): the state is read from the link's
 * decorations, drawn, `hover` called — and only then are the decorations
 * swapped for accessors whose setters redraw. `shown` is what is on screen.
 */
function hoverLikeXterm(link) {
  const state = {
    decorations: {
      underline: link.decorations === undefined ? true : link.decorations.underline,
      pointerCursor: link.decorations === undefined ? true : link.decorations.pointerCursor,
    },
    isHovered: true,
  };
  const shown = { underline: state.decorations.underline, pointer: state.decorations.pointerCursor };
  link.hover?.({}, link.text);
  link.decorations = {};
  Object.defineProperties(link.decorations, {
    pointerCursor: {
      get: () => state.decorations.pointerCursor,
      set: (v) => {
        if (state.decorations.pointerCursor !== v) {
          state.decorations.pointerCursor = v;
          if (state.isHovered) shown.pointer = v;
        }
      },
    },
    underline: {
      get: () => state.decorations.underline,
      set: (v) => {
        if (state.decorations.underline !== v) {
          state.decorations.underline = v;
          if (state.isHovered) shown.underline = v;
        }
      },
    },
  });
  return {
    shown,
    /** `_linkLeave`: what was drawn goes, then `leave`. */
    leave() {
      state.isHovered = false;
      shown.underline = false;
      shown.pointer = false;
      link.leave?.({}, link.text);
    },
  };
}

const press = (t, key, fields) => t.window.dispatchEvent(event('keydown', { key, ...fields }));
const release = (t, key, fields) => t.window.dispatchEvent(event('keyup', { key, ...fields }));

describe('Reveal links: what xterm is given, and what is asked', () => {
  test('RL-01: nothing looked up without the modifier; with it the names that exist, longest first', async () => {
    const t = await setUp();
    const idle = await provide(t, 1);
    assert.equal(idle.links, undefined, 'the modifier up: nothing here');
    assert.equal(idle.synchronous, true, 'and at once');
    assert.equal(t.calls.length, 0, 'and nothing asked');

    t.hold();
    const first = await provide(t, 1);
    assert.equal(first.synchronous, false, 'the first answer waits for the backend');
    assert.deepEqual(first.links.map((l) => l.text), ['My Folder'], '`My Folder`, not `My` which also exists');
    assert.deepEqual(first.links[0].range, { start: { x: 39, y: 1 }, end: { x: 47, y: 1 } });
    assert.equal(t.calls.length, 1, 'one call for the row');

    const again = await provide(t, 1);
    assert.equal(again.synchronous, true, 'remembered: answered before provideLinks returns');
    assert.equal(t.calls.length, 1);

    const url = await provide(t, 3);
    assert.equal(url.links, undefined, 'the URL and src/a.js:3 are links of their own; nothing else exists');
    assert.ok(!t.calls.flat().some((p) => p.includes('example.com') || p.endsWith('a.js:3')));
    const empty = await provide(t, 6);
    assert.equal(empty.links, undefined);
    assert.equal(empty.synchronous, true, 'a blank row costs no call');
    t.links.dispose();
    assert.equal(t.term.disposed, true);
  });

  test('RL-02: one lookup at a time; the newest row waits, those overtaken are never asked about or answered', async () => {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const asked = [];
    const t = await setUp({
      ask: async (paths) => {
        asked.push([...paths]);
        await gate;
        return paths.map((p) => fsFor('macos')[p] ?? null);
      },
    });
    t.hold();
    const handed = [];
    t.term.provider.provideLinks(1, (links) => handed.push(['row 1', links]));
    t.term.provider.provideLinks(3, (links) => handed.push(['row 3', links]));
    t.term.provider.provideLinks(2, (links) => handed.push(['row 2', links]));
    await tick();
    assert.equal(asked.length, 1, 'one call in flight; row 3 waits, then row 2 takes its place');
    open();
    for (let i = 0; i < 6; i += 1) await tick();
    assert.equal(asked.length, 2, 'row 1, then row 2: row 3 was overtaken while it waited');
    assert.ok(asked[1].some((p) => p.endsWith('/build.sh')), 'the second call is row 2\'s');
    assert.deepEqual(
      handed.map(([row, links]) => [row, links?.map((l) => l.text)]),
      [['row 2', ['build.sh']]],
      'xterm would file row 1\'s answer under row 2'
    );
  });

  test('RL-03: a backend that fails answers nothing, and xterm still gets its answer', async () => {
    const t = await setUp({ ask: async () => Promise.reject(new Error('no backend')) });
    t.hold();
    const { links } = await provide(t, 1);
    assert.equal(links, undefined);
  });
});

describe('Reveal links: drawn only while the modifier is down', () => {
  test('RL-04: drawn with the modifier, undrawn without, and the key followed while hovered', async () => {
    const t = await setUp();
    press(t, 'Meta', { metaKey: true });
    const [link] = (await provide(t, 1)).links;
    assert.deepEqual(link.decorations, { pointerCursor: true, underline: true });
    const hovered = hoverLikeXterm(link);
    await tick();
    assert.deepEqual(hovered.shown, { underline: true, pointer: true }, 'held: drawn');

    release(t, 'Meta', { metaKey: false });
    assert.deepEqual(hovered.shown, { underline: false, pointer: false }, '⌘ up: gone');
    press(t, 'Meta', { metaKey: true });
    assert.deepEqual(hovered.shown, { underline: true, pointer: true }, '⌘ down: back');
    release(t, 'Meta');

    press(t, 'Control', { ctrlKey: true });
    assert.deepEqual(hovered.shown, { underline: false, pointer: false }, 'Ctrl is not the modifier on macOS');
    release(t, 'Control');
    press(t, 'Meta', { metaKey: true });
    press(t, 'Shift', { metaKey: true, shiftKey: true });
    assert.deepEqual(hovered.shown, { underline: false, pointer: false }, '⌘⇧ is a selection, not a reveal');
    release(t, 'Shift', { metaKey: true });
    assert.equal(hovered.shown.underline, true);

    // Losing the window lets go: ⌘-Tab away sends no keyup.
    t.window.dispatchEvent(new Event('blur'));
    assert.deepEqual(hovered.shown, { underline: false, pointer: false });

    // Once the pointer has left, the key no longer touches the link.
    press(t, 'Meta', { metaKey: true });
    hovered.leave();
    release(t, 'Meta');
    press(t, 'Meta', { metaKey: true });
    assert.deepEqual(hovered.shown, { underline: false, pointer: false });
  });

  test('RL-05: held by the mouse alone — a key pressed while another window had the focus', async () => {
    const t = await setUp({ os: 'windows' });
    t.window.dispatchEvent(event('mousemove', { ctrlKey: true }));
    assert.equal(t.modifier.held, true);
    const [link] = (await provide(t, 2)).links;
    assert.equal(link.text, 'build.sh');
    const hovered = hoverLikeXterm(link);
    assert.deepEqual(hovered.shown, { underline: true, pointer: true });
    t.window.dispatchEvent(event('mousemove', {}));
    assert.deepEqual(hovered.shown, { underline: false, pointer: false });
  });

  test('RL-06: a link made while the key was down and hovered after it went up is put right as it is hovered', async () => {
    const t = await setUp();
    t.hold();
    const [link] = (await provide(t, 1)).links;
    t.release();
    // xterm reads the decorations it was given, made with the key down…
    const hovered = hoverLikeXterm(link);
    assert.equal(hovered.shown.underline, true);
    // …and `hover` corrects them once xterm's own accessors are in place.
    await tick();
    assert.deepEqual(hovered.shown, { underline: false, pointer: false });
  });

  test('RL-12: AltGr on Windows — Ctrl then Ctrl+Alt — never counts; a lone Ctrl does, a moment later', async () => {
    const t = await setUp({ os: 'windows' });
    press(t, 'Control', { ctrlKey: true });
    assert.equal(t.modifier.held, false, 'not yet: it may be AltGr');
    press(t, 'AltGraph', { ctrlKey: true, altKey: true });
    t.timers.run();
    assert.equal(t.modifier.held, false, 'it was AltGr');
    release(t, 'AltGraph');
    release(t, 'Control');
    press(t, 'Control', { ctrlKey: true });
    press(t, 'Control', { ctrlKey: true, repeat: true });
    assert.equal(t.timers.pending, 1, 'one wait, however the key repeats');
    t.timers.run();
    assert.equal(t.modifier.held, true, `a lone Ctrl, after ${ALTGR_GRACE_MS} ms`);
    // Not on macOS: ⌘ counts at once.
    const mac = await setUp();
    press(mac, 'Meta', { metaKey: true });
    assert.equal(mac.modifier.held, true);
  });
});

describe('Reveal links: looking again when the modifier goes down', () => {
  test('RL-13: ⌘ down over a row xterm already asked about: it is made to ask again — a row away and back', async () => {
    const t = await setUp();
    t.point(1);
    assert.equal((await provide(t, 1)).links, undefined, 'asked with nothing held');
    t.hold();
    assert.deepEqual(t.moves, [2, 1], 'moved a row away, then back');
    assert.equal(t.answers[0].links, undefined, 'the row away: nothing, and nothing asked');
    assert.equal(t.answers[0].synchronous, true);
    await tick();
    await tick();
    assert.deepEqual(t.answers[1].links?.map((l) => l.text), ['My Folder'], 'the row under the pointer, looked up now');
    assert.equal(t.calls.length, 1, 'only that row was looked up');

    // Not over this terminal: nothing moved.
    const away = await setUp();
    away.hold();
    assert.deepEqual(away.moves, []);
    // A full-screen program tracking the mouse would be told of the moves.
    const tracked = await setUp({ tracking: 'any' });
    tracked.point(1);
    tracked.hold();
    assert.deepEqual(tracked.moves, []);
    // The top row looks a row down instead.
    const top = await setUp();
    top.point(1);
    top.hold();
    assert.equal(top.moves[0], 2);
  });

  test('RL-14: after a press that let go of the link, ⌘ still down: looked again once the button is released', async () => {
    const t = await setUp();
    t.hold();
    t.point(1);
    t.moves.length = 0;
    const [link] = (await provide(t, 1)).links;
    hoverLikeXterm(link);
    // ⌘+right-click: the link is let go of, for the word to be selected.
    t.container.dispatchEvent(event('mousedown', { button: 2, metaKey: true, clientX: 40, clientY: 5 }));
    assert.equal(t.left, 1);
    link.leave();
    t.timers.run();
    assert.deepEqual(t.moves, [], 'not while the button is down: a move would drag the selection');
    t.view.dispatchEvent(event('mouseup', { button: 2, metaKey: true }));
    t.timers.run();
    assert.deepEqual(t.moves, [2, 1], 'released: looked again, the modifier still down');
  });

  test('RL-15: a ⌘-click where xterm holds no link: looked again before xterm hears the press', async () => {
    const t = await setUp();
    t.hold();
    t.moves.length = 0;
    t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, metaKey: true, clientX: 40, clientY: 25 }));
    assert.deepEqual(t.moves, [1, 2], 'row 2 under the pointer: a row up and back');
    t.moves.length = 0;
    t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, clientX: 40, clientY: 25 }));
    assert.deepEqual(t.moves, [], 'a plain click: nothing moved');
  });
});

describe('Reveal links: second review — the browser, the scrollbar, a hidden tab, a quick click, a held button', () => {
  /**
   * A browser's setTimeout and clearTimeout, which refuse to be called with
   * an object as `this` — Chromium and WebView2 throw "Illegal invocation".
   * Node's do not mind, which is how a default of `{ set: setTimeout }`
   * passed every case that handed in timers of its own.
   */
  async function withBrowserTimers(fn) {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const strict = (real) =>
      function strictTimer(...args) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
        return real(...args);
      };
    globalThis.setTimeout = strict(realSet);
    globalThis.clearTimeout = strict(realClear);
    try {
      return await fn();
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  }

  /** An event target that hands its listeners back, to be called where a throw can be seen. */
  function listenersOf() {
    const listeners = {};
    return {
      listeners,
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      removeEventListener() {},
    };
  }

  test('RL-16: the default timers — a lone Ctrl on Windows, and the look after a press — run in a browser', async () => {
    await withBrowserTimers(async () => {
      // A copy of the module made now, so whatever it keeps of the timers
      // when it loads is the browser's kind, not Node's.
      const { createModifierTracker, installRevealLinks } = await import(`../../src/lib/revealLinks.js?browser-timers=${Date.now()}`);
      const window = listenersOf();
      const tracker = createModifierTracker(window, () => 'windows');
      assert.doesNotThrow(() => window.listeners.keydown(event('keydown', { key: 'Control', ctrlKey: true })), 'a lone Ctrl');
      await new Promise((resolve) => setTimeout(resolve, ALTGR_GRACE_MS + 20));
      assert.equal(tracker.held, true, 'and it counts, after AltGr\'s grace');
      tracker.dispose();

      const view = listenersOf();
      const container = listenersOf();
      const screen = new EventTarget();
      screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 160 });
      const moves = [];
      screen.addEventListener('mousemove', (e) => moves.push(e.clientY));
      const term = {
        buffer: { active: { viewportY: 0 } },
        rows: 8,
        cols: 100,
        modes: { mouseTrackingMode: 'none' },
        element: { ownerDocument: { defaultView: view }, querySelector: () => screen },
        registerLinkProvider: () => ({ dispose() {} }),
      };
      const held = { held: true, subscribe: () => () => {} };
      installRevealLinks(term, container, {
        modifier: held,
        kinds: { known: () => null, kinds: async () => new Map() },
        where: () => ({ os: 'macos' }),
        reveal: async () => {},
        notice: () => {},
      });
      container.listeners.mousemove(event('mousemove', { clientX: 40, clientY: 25 }));
      // The modifier goes down mid-press: looked again once the button is up.
      container.listeners.mousemove(event('mousemove', { clientX: 40, clientY: 25, buttons: 1 }));
      assert.doesNotThrow(() => view.listeners.mouseup(event('mouseup', { buttons: 0 })), 'the release');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  test('RL-17: the pointer on the scrollbar — in the terminal\'s container, beside its cells — looks at nothing', async () => {
    const t = await setUp();
    // 800 px of cells; the scrollbar is to their right.
    t.container.dispatchEvent(event('mousemove', { clientX: 805, clientY: 5 }));
    t.hold();
    assert.deepEqual(t.moves, [], 'nothing moved, so nothing asked about the row beside it');
    t.release();
    t.point(1);
    t.hold();
    assert.deepEqual(t.moves, [2, 1], 'on the cells it does');
  });

  test('RL-18: a terminal taken off screen (a tab or group switched away) is not moved over', async () => {
    const t = await setUp();
    t.point(1);
    t.screen.isConnected = false;
    t.hold();
    assert.deepEqual(t.moves, []);
    t.release();
    t.screen.isConnected = true;
    t.hold();
    assert.deepEqual(t.moves, [], 'and it is no longer under the pointer until the pointer moves over it again');
    t.release();
    t.point(1);
    t.hold();
    assert.deepEqual(t.moves, [2, 1]);
  });

  test('RL-19: a ⌘-click quicker than its row\'s answer shows the name once both have happened — that click only', async () => {
    const slow = () => {
      let open;
      const gate = new Promise((resolve) => {
        open = resolve;
      });
      return {
        open: () => open(),
        ask: async (paths) => {
          await gate;
          return paths.map((p) => fsFor('macos')[p] ?? null);
        },
      };
    };
    // "drwxr-xr-x 2 me me 4096 Oct  9 22:00 'My Folder'": `My Folder` at columns 39–47.
    const atFolder = { clientX: 8 * 42 + 4, clientY: 5 };
    const cmdPress = (t, at = atFolder) => t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, metaKey: true, ...at }));
    const releaseAt = (t, at = atFolder) => t.view.dispatchEvent(event('mouseup', { button: 0, buttons: 0, metaKey: true, ...at }));
    const settle = async () => {
      for (let i = 0; i < 8; i += 1) await tick();
    };
    const fresh = async () => {
      const backend = slow();
      const t = await setUp({ ask: backend.ask });
      t.hold();
      return { t, backend };
    };

    let { t, backend } = await fresh();
    cmdPress(t);
    releaseAt(t);
    backend.open();
    await settle();
    assert.deepEqual(t.revealed, [at('macos', 'My Folder')], 'released, then answered: shown');

    ({ t, backend } = await fresh());
    cmdPress(t);
    backend.open();
    await settle();
    assert.deepEqual(t.revealed, [], 'answered while the button is still down: not yet');
    releaseAt(t);
    assert.deepEqual(t.revealed.length, 0, 'shown a task later, never thrown');
    await settle();
    assert.deepEqual(t.revealed, [at('macos', 'My Folder')], 'answered, then released on the same cell: shown');

    ({ t, backend } = await fresh());
    cmdPress(t);
    t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, clientX: 5, clientY: 5 }));
    backend.open();
    await settle();
    assert.deepEqual(t.revealed, [], 'another press came first');

    ({ t, backend } = await fresh());
    cmdPress(t);
    releaseAt(t);
    t.point(2);
    backend.open();
    await settle();
    assert.deepEqual(t.revealed, [], 'the pointer went to another row');

    ({ t, backend } = await fresh());
    cmdPress(t);
    releaseAt(t);
    t.container.dispatchEvent(new Event('mouseleave'));
    backend.open();
    await settle();
    assert.deepEqual(t.revealed, [], 'the pointer left the terminal');

    ({ t, backend } = await fresh());
    cmdPress(t, { clientX: 8 * 3 + 4, clientY: 5 });
    releaseAt(t, { clientX: 8 * 3 + 4, clientY: 5 });
    backend.open();
    await settle();
    assert.deepEqual(t.revealed, [], 'no link under that cell');
  });

  test('RL-21: a ⌘-press that turns into a drag along the row shows nothing, before the answer or after it', async () => {
    const atFolder = { clientX: 8 * 42 + 4, clientY: 5 };
    const along = { clientX: 8 * 45 + 4, clientY: 5 };
    for (const answeredFirst of [false, true]) {
      let open;
      const gate = new Promise((resolve) => {
        open = resolve;
      });
      const t = await setUp({
        ask: async (paths) => {
          await gate;
          return paths.map((p) => fsFor('macos')[p] ?? null);
        },
      });
      t.hold();
      t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, metaKey: true, ...atFolder }));
      if (answeredFirst) {
        open();
        for (let i = 0; i < 8; i += 1) await tick();
      }
      // Dragged three cells along the same row, the button held: a selection.
      t.container.dispatchEvent(event('mousemove', { buttons: 1, metaKey: true, ...along }));
      t.view.dispatchEvent(event('mouseup', { button: 0, buttons: 0, metaKey: true, ...along }));
      open();
      for (let i = 0; i < 8; i += 1) await tick();
      assert.deepEqual(t.revealed, [], answeredFirst ? 'answered, then dragged' : 'dragged, then answered');
    }
    // Released on another cell without a move between: not the click either.
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const t = await setUp({ ask: async (paths) => (await gate, paths.map((p) => fsFor('macos')[p] ?? null)) });
    t.hold();
    t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, metaKey: true, ...atFolder }));
    t.view.dispatchEvent(event('mouseup', { button: 0, buttons: 0, metaKey: true, ...along }));
    open();
    for (let i = 0; i < 8; i += 1) await tick();
    assert.deepEqual(t.revealed, [], 'released elsewhere');

    // Dragged away and back, released where it was pressed: still a drag.
    let reopen;
    const regate = new Promise((resolve) => {
      reopen = resolve;
    });
    const back = await setUp({ ask: async (paths) => (await regate, paths.map((p) => fsFor('macos')[p] ?? null)) });
    back.hold();
    back.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, metaKey: true, ...atFolder }));
    back.container.dispatchEvent(event('mousemove', { buttons: 1, metaKey: true, ...along }));
    back.container.dispatchEvent(event('mousemove', { buttons: 1, metaKey: true, ...atFolder }));
    back.view.dispatchEvent(event('mouseup', { button: 0, buttons: 0, metaKey: true, ...atFolder }));
    reopen();
    for (let i = 0; i < 8; i += 1) await tick();
    assert.deepEqual(back.revealed, [], 'dragged away and back');
  });

  test('RL-22: a waiting ⌘-click is forgotten when its terminal is taken off screen (a tab or group switch)', async () => {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const t = await setUp({ ask: async (paths) => (await gate, paths.map((p) => fsFor('macos')[p] ?? null)) });
    const atFolder = { clientX: 8 * 42 + 4, clientY: 5 };
    t.hold();
    t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, metaKey: true, ...atFolder }));
    t.view.dispatchEvent(event('mouseup', { button: 0, buttons: 0, metaKey: true, ...atFolder }));
    t.screen.isConnected = false;
    open();
    for (let i = 0; i < 8; i += 1) await tick();
    assert.deepEqual(t.revealed, [], 'not shown into a hidden tab');
  });

  test('RL-20: the modifier going down while a button is held moves nothing until the button is up', async () => {
    const t = await setUp();
    t.container.dispatchEvent(event('mousemove', { clientX: 40, clientY: 5, buttons: 1 }));
    t.hold();
    assert.deepEqual(t.moves, [], 'mid-drag: the moves would say the button is up');
    t.view.dispatchEvent(event('mouseup', { buttons: 0 }));
    t.timers.run();
    assert.deepEqual(t.moves, [2, 1], 'released: looked again');
  });
});

describe('Reveal links: what a click does', () => {
  const click = (fields) => ({ button: 0, detail: 1, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, ...fields });

  test('RL-07: only a single main-button click with the modifier shows the path; a failure is a notice, never a throw', async () => {
    const mac = await setUp();
    mac.hold();
    const [folder] = (await provide(mac, 1)).links;
    folder.activate(click({}));
    folder.activate(click({ ctrlKey: true }));
    folder.activate(click({ metaKey: true, button: 2 }));
    folder.activate(click({ metaKey: true, altKey: true }));
    folder.activate(click({ metaKey: true, shiftKey: true }));
    await tick();
    assert.deepEqual(mac.revealed, [], 'a plain click, Ctrl, the right button, ⌥, ⇧: nothing new');
    folder.activate(click({ metaKey: true }));
    folder.activate(click({ metaKey: true, detail: 2 }));
    folder.activate(click({ metaKey: true, detail: 3 }));
    await tick();
    assert.deepEqual(mac.revealed, [at('macos', 'My Folder')], 'once: the second and third press of a double or triple click show nothing');

    const win = await setUp({ os: 'windows', lines: ['2026-10-09  오후 10:00    <DIR>          My Folder'] });
    win.hold();
    // A Korean `dir` line, in C:\proj.
    const [onWindows] = (await provide(win, 1)).links;
    onWindows.activate(click({ metaKey: true }));
    onWindows.activate(click({ ctrlKey: true }));
    await tick();
    assert.deepEqual(win.revealed, [at('windows', 'My Folder')], 'Ctrl on Windows, and not the Windows key');

    win.refuse();
    assert.doesNotThrow(() => onWindows.activate(click({ ctrlKey: true })));
    await tick();
    assert.deepEqual(win.notices, [`could not show ${at('windows', 'My Folder')} in the file manager`]);
  });
});

describe('Reveal links: a double-click or a right-click still selects a word', () => {
  test('RL-08: a press that would select a word, over one of these links, takes the link from xterm first', async () => {
    const t = await setUp();
    t.hold();
    const [link] = (await provide(t, 1)).links;
    t.release();
    const down = (fields) => t.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, ...fields }));
    let hovered = hoverLikeXterm(link);

    down({ detail: 1 });
    assert.equal(t.left, 0, 'a single press is left alone: it selects nothing by itself');
    down({ detail: 2 });
    assert.equal(t.left, 1, 'the second press of a double-click: xterm is told the pointer left');
    hovered.leave();

    hovered = hoverLikeXterm(link);
    down({ button: 2 });
    assert.equal(t.left, 2, 'a right-click, which xterm answers on macOS by selecting the word');
    hovered.leave();

    hovered = hoverLikeXterm(link);
    down({ button: 2, metaKey: true });
    assert.equal(t.left, 3, 'a ⌘+right-click too: the modifier does not make a right-click a reveal');
    hovered.leave();

    hovered = hoverLikeXterm(link);
    down({ button: 0, ctrlKey: true });
    assert.equal(t.left, 4, 'a Ctrl-click: macOS\'s right-click');
    hovered.leave();

    hovered = hoverLikeXterm(link);
    t.container.dispatchEvent(event('contextmenu', { button: 2 }));
    assert.equal(t.left, 5, 'and the context menu itself, where a browser sends no press first');
    hovered.leave();

    hovered = hoverLikeXterm(link);
    down({ detail: 2, metaKey: true });
    assert.equal(t.left, 5, 'a ⌘+double-click means the link: left alone');
    hovered.leave();
    down({ detail: 2 });
    down({ button: 2 });
    assert.equal(t.left, 5, 'over no link of these: left alone');

    // On Windows a Ctrl-click is the reveal itself, not a right-click.
    const win = await setUp({ os: 'windows' });
    win.hold();
    const [onWindows] = (await provide(win, 1)).links;
    hoverLikeXterm(onWindows);
    win.container.dispatchEvent(event('mousedown', { button: 0, detail: 1, ctrlKey: true }));
    assert.equal(win.left, 0);
  });

  test('RL-09: the parts of xterm 6 this relies on are still there', () => {
    const src = (file) =>
      readFileSync(new URL(`../../node_modules/@xterm/xterm/src/browser/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const linkifier = src('Linkifier.ts');
    const newLink = linkifier.slice(linkifier.indexOf('private _handleNewLink('), linkifier.indexOf('protected _linkHover('));
    const hoverCall = newLink.indexOf('this._linkHover(this._element, linkWithState.link, this._lastMouseEvent);');
    const swap = newLink.indexOf('Object.defineProperties(linkWithState.link.decorations, {');
    assert.ok(hoverCall > 0 && swap > hoverCall, 'decorations are swapped for accessors after `hover` is called');
    assert.match(newLink, /this\._element\.classList\.toggle\('xterm-cursor-pointer', v\);/, 'the setter of pointerCursor redraws');
    assert.match(newLink, /this\._fireUnderlineEvent\(linkWithState\.link, v\);/, 'the setter of underline redraws');
    assert.match(
      linkifier,
      /addDisposableListener\(this\._element, 'mouseleave', \(\) => \{\n\s+this\._isMouseOut = true;\n\s+this\._clearCurrentLink\(\);/,
      'leaving the screen element lets go of the hovered link'
    );
    assert.match(linkifier, /this\._currentLink\.link\.activate\(event, this\._currentLink\.link\.text\);/, 'activated on any button');
    // It asks again only when the pointer changes row; on the same row it
    // reuses the answers it has.
    assert.match(linkifier, /if \(this\._activeLine !== position\.y \|\| this\._wasResized\) \{\n\s+this\._clearCurrentLink\(\);\n\s+this\._askForLink\(position, false\);/);
    // A late answer is dropped only when the pointer is out of the terminal.
    assert.match(linkifier, /linkProvider\.provideLinks\(position\.y, \(links: ILink\[\] \| undefined\) => \{\n\s+if \(this\._isMouseOut\) \{\n\s+return;\n\s+\}\n\s+const linksWithState[^\n]*\n\s+this\._activeProviderReplies\?\.set\(i, linksWithState\);/);
    const selection = src('services/SelectionService.ts');
    assert.match(
      selection,
      /private _selectWordAtCursor\([^)]*\): boolean \{\n\s+\/\/ Check if there is a link under the cursor first and select that if so\n\s+const range = this\._linkifier\.currentLink\?\.link\?\.range;/,
      'a double-click selects the hovered link before the word'
    );
    assert.match(selection, /public rightClickSelect\(ev: MouseEvent\): void \{\n\s+if \(!this\._isClickInSelection\(ev\)\) \{\n\s+if \(this\._selectWordAtCursor\(ev, false\)\)/, 'and so does a right-click');
    // While the button is down, a move drags the selection: no synthetic move then.
    assert.match(selection, /this\._screenElement\.ownerDocument\.addEventListener\('mousemove', this\._mouseMoveListener\);/);
    const core = src('CoreBrowserTerminal.ts');
    assert.match(core, /createInstance\(Linkifier, this\.screenElement\)/, 'link detection listens on .xterm-screen');
    assert.match(core, /this\.screenElement\.classList\.add\('xterm-screen'\)/);
  });
});

describe('Reveal links: wired into every terminal', () => {
  // As written, whatever line endings the checkout gave it.
  const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  test('RL-10: each terminal gets the provider, the directories its shell was in, and loses them with the terminal', () => {
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    assert.match(create, /const revealLinks = registerRevealLinks\(term, tabId, container\);/);
    assert.ok(create.indexOf('registerRevealLinks(') < create.indexOf('term.open(container)'), 'before xterm opens, beside registerLinks');
    const dispose = registry.slice(registry.indexOf('export function disposeTerminal('));
    assert.match(dispose, /entry\.revealLinks\?\.dispose\(\);/);
    const register = registry.slice(registry.indexOf('function registerRevealLinks('), registry.indexOf('function openWebLink('));
    assert.match(register, /reveal: \(path\) => useEditorStore\.getState\(\)\.revealPath\(path\)/);
    assert.match(register, /notice: \(message\) => writeNotice\(tabId, message\)/);
    assert.match(register, /const commandMarks = \(\) => instances\.get\(tabId\)\?\.commandMarks\?\.marks \?\? \[\];/, 'the shell\'s command marks');
    assert.match(register, /const dirs = trackDirectories\(term, \{ initial: startedIn, current: liveCwd, marks: commandMarks \}\);/, 'the directories, kept on this terminal, by command');
    assert.match(register, /if \(cwd && cwd !== tabOf\(prev\)\?\.cwd\) dirs\.note\(cwd\);/, 'each change of the tab\'s directory');
    assert.match(register, /cwdAt: \(line\) => dirs\.at\(line\) \|\| liveCwd\(\)/, 'the directory the row was printed in');
    assert.match(register, /marks: commandMarks,/, 'and the provider reads the same marks');
    assert.match(register, /msys: kind === 'msys' \|\| kind === 'cygwin'/, '/c/x read as C:\\x only in Git Bash or Cygwin');
    assert.match(register, /stopTrail\(\);\n\s+dirs\.dispose\(\);\n\s+links\.dispose\(\);/);
    assert.match(registry, /createKindLookup\(\{ ask: pathKinds \}\)/, 'one lookup, through fs_path_kinds');
  });

  test('RL-11: the editor store\'s revealPath asks fs_reveal_path, and rejects with its reason', async () => {
    const before = mockBridge.revealed.length;
    await useEditorStore.getState().revealPath('/workspace/src');
    await useEditorStore.getState().revealPath('/workspace/README.md');
    assert.deepEqual(mockBridge.revealed.slice(before), [
      { path: '/workspace/src', kind: 'dir' },
      { path: '/workspace/README.md', kind: 'file' },
    ]);
    await assert.rejects(() => useEditorStore.getState().revealPath('/workspace/nope.txt'), /Cannot show/);
    await assert.rejects(() => useEditorStore.getState().revealPath('\\\\host\\share\\x'), /another machine/);
  });
});
