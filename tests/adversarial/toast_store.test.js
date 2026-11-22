/**
 * Toasts (bundle 3, U6-F1/F2): src/stores/toastStore.js and
 * src/components/common/ToastHost.jsx.
 *
 * The store runs on fake timers handed in (`fakeTimers`, through
 * `setToastTimers`), which count the timers alive and fire them as the clock
 * is moved on, so no real timer is ever set and nothing waits 3 s. Every case
 * ends with `resetToasts`, and TO-99 checks the store is back as it started.
 * The host is mounted with real React on the hand-written page of
 * react_page.js (TO-9, TO-10, TO-11): what focus, a press on Dismiss, a window
 * resize and a notice's size do is out of reach of a server render. The page
 * lays nothing out, so TO-11 gives it a window width and stand-in notices
 * with a height, and a ResizeObserver of its own (put back afterwards, TO-99
 * checks). RN-239 (tests/render/runner.js) draws it in the app and reads
 * index.css.
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { dispatch, onPage } from './react_page.js';
import { MAX_TOASTS, TOAST_MS, resetToasts, setToastTimers, useToastStore } from '../../src/stores/toastStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';

// ---- The host, bundled ---------------------------------------------------------
//
// Node cannot import a .jsx file, so ToastHost is bundled with esbuild and
// imported from a data: URL, as in confirm_dialog.test.js. React, lucide and
// the stores stay outside the bundle: the stores it reads must be the very
// ones this suite sets, not copies of them.

const COMMON_DIR = fileURLToPath(new URL('../../src/components/common/', import.meta.url));
const REAL = new Set(['react', 'react/jsx-runtime', 'lucide-react']);

let loading = null;
function loadHost() {
  loading ??= build({
    stdin: { contents: "export * from './ToastHost.jsx';", resolveDir: COMMON_DIR, sourcefile: 'toast-host-under-test.js', loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'real-modules',
        setup(b) {
          b.onResolve({ filter: /\/stores\/\w+Store\.js$/ }, (args) => ({
            path: pathToFileURL(resolve(args.resolveDir || dirname(args.importer), args.path)).href,
            external: true,
          }));
          b.onResolve({ filter: /.*/ }, (args) =>
            REAL.has(args.path) ? { path: import.meta.resolve(args.path), external: true } : undefined
          );
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loading;
}

/**
 * Timers on a clock of their own: `live` is how many are set and not yet
 * fired or cleared, `delays` every delay asked for, `cleared` every handle
 * cleared, `advance(ms)` moves the clock on, firing each timer due on the
 * way, earliest first.
 */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const delays = [];
  const cleared = [];
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      delays.push(ms);
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      cleared.push(id);
      timers.delete(id);
    },
    get live() {
      return timers.size;
    },
    delays,
    cleared,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) if (timer.at <= target && (!due || timer.at < due[1].at)) due = [id, timer];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** What was there before TO-11 put in its ResizeObserver: TO-99 checks it is back. */
const RESIZE_OBSERVER_BEFORE = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');

/**
 * A ResizeObserver for one case, installed as the global: `live` the ones
 * observing something and not disconnected, `fire()` calls every live one's
 * callback as a notice's resize would. `restore()` puts the global back.
 */
function fakeResizeObservers() {
  const all = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      all.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    unobserve(target) {
      this.targets = this.targets.filter((t) => t !== target);
    }
    disconnect() {
      this.targets = [];
      this.disconnected = true;
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: FakeResizeObserver, configurable: true, writable: true });
  return {
    all,
    get live() {
      return all.filter((o) => !o.disconnected && o.targets.length > 0);
    },
    fire() {
      for (const o of all) if (!o.disconnected) o.callback([], o);
    },
    restore() {
      if (RESIZE_OBSERVER_BEFORE) Object.defineProperty(globalThis, 'ResizeObserver', RESIZE_OBSERVER_BEFORE);
      else delete globalThis.ResizeObserver;
    },
  };
}

const store = () => useToastStore.getState();
const texts = () => store().toasts.map((t) => t.text);
const START = { ...useToastStore.getState() };

/**
 * A case that ends clean whether it passes or fails (the framework runs no
 * afterEach after a failure): no toast, no timer, the global timers back and
 * no corner notice, so a failing case cannot leak into the next one or into
 * the suites after this one.
 */
const cleanly = (body) => async () => {
  try {
    await body();
  } finally {
    resetToasts();
    useEditorStore.setState({ openFailure: null });
    useTerminalStore.setState({ agentHistoryNotice: null });
  }
};

/** Fake timers installed for one case; `resetToasts` (in `cleanly`) puts the real ones back. */
function onFakeTime() {
  const time = fakeTimers();
  setToastTimers(time);
  return time;
}

describe('Toasts (bundle 3, U6)', () => {
  test('TO-1: a confirmation is up until TOAST_MS (3000) and then taken away, by one timer of TOAST_MS', cleanly(() => {
    assert.equal(TOAST_MS, 3000);
    const time = onFakeTime();
    const id = store().show({ text: 'Path copied' });
    assert.equal(typeof id, 'number');
    assert.deepEqual(store().toasts, [{ id, kind: 'confirm', text: 'Path copied' }], 'the default kind is a confirmation');
    assert.deepEqual(time.delays, [TOAST_MS]);
    time.advance(TOAST_MS - 1);
    assert.deepEqual(texts(), ['Path copied'], 'still up 1 ms before TOAST_MS');
    time.advance(1);
    assert.deepEqual(store().toasts, [], 'gone at TOAST_MS');
    assert.equal(time.live, 0, 'no timer left behind');
  }));

  test('TO-2: an error is never taken away by a timer, however long it is up; dismiss takes it away', cleanly(() => {
    const time = onFakeTime();
    const id = store().show({ kind: 'error', text: 'Path not copied' });
    assert.deepEqual(store().toasts, [{ id, kind: 'error', text: 'Path not copied' }]);
    assert.equal(time.live, 0, 'an error sets no timer');
    time.advance(TOAST_MS * 100);
    assert.deepEqual(texts(), ['Path not copied'], 'still up after 300 s');
    store().dismiss(id);
    assert.deepEqual(store().toasts, []);
  }));

  test('TO-3: dismissing a confirmation early clears its timer; a dismiss of an unknown id changes nothing', cleanly(() => {
    const time = onFakeTime();
    const a = store().show({ text: 'A' });
    const b = store().show({ text: 'B' });
    assert.equal(time.live, 2);
    store().dismiss(a);
    assert.deepEqual(texts(), ['B']);
    assert.equal(time.live, 1, "A's timer went with it");
    const before = store().toasts;
    store().dismiss(9999);
    store().dismiss(a);
    assert.ok(store().toasts === before, 'the same list: nothing was set');
    time.advance(TOAST_MS);
    assert.deepEqual(store().toasts, [], 'B still went at its time');
    assert.ok(b > a, 'ids grow');
  }));

  test('TO-4: at most MAX_TOASTS (3), newest last; a 4th drops the oldest and clears its timer', cleanly(() => {
    assert.equal(MAX_TOASTS, 3);
    const time = onFakeTime();
    const first = store().show({ text: 'one' });
    store().show({ kind: 'error', text: 'two' });
    store().show({ text: 'three' });
    assert.deepEqual(texts(), ['one', 'two', 'three']);
    store().show({ text: 'four' });
    assert.deepEqual(texts(), ['two', 'three', 'four'], 'the oldest dropped');
    assert.ok(time.cleared.includes(1) && !store().toasts.some((t) => t.id === first), "the oldest's timer cleared");
    assert.equal(time.live, 2, 'only three and four are timed (two is an error)');
    store().show({ text: 'five' });
    assert.deepEqual(texts(), ['three', 'four', 'five'], 'an error is dropped as the oldest too');
    time.advance(TOAST_MS);
    assert.deepEqual(store().toasts, []);
    assert.equal(time.live, 0);
  }));

  test('TO-5: the same text twice leaves one toast, at the bottom, with a new id and its TOAST_MS started again', cleanly(() => {
    const time = onFakeTime();
    const first = store().show({ text: 'Path copied' });
    store().show({ text: 'Session ID copied' });
    time.advance(2000);
    const second = store().show({ text: 'Path copied' });
    assert.deepEqual(texts(), ['Session ID copied', 'Path copied'], 'one Path copied, now the newest');
    assert.ok(second !== first, 'a new toast, so it is drawn (and fades in) afresh');
    assert.ok(time.cleared.includes(1), "the older one's timer is cleared");
    assert.equal(time.live, 2);
    time.advance(1000);
    assert.deepEqual(texts(), ['Path copied'], 'Session ID copied went at its 3 s; Path copied did not go at the old 3 s');
    time.advance(TOAST_MS - 1000 - 1);
    assert.deepEqual(texts(), ['Path copied'], 'still up 1 ms before its restarted TOAST_MS');
    time.advance(1);
    assert.deepEqual(store().toasts, [], 'gone TOAST_MS after the repeat');
    assert.equal(time.live, 0);
  }));

  test('TO-6: a repeated text never takes a 4th place: three up and a repeat of the middle one leaves all three, none dropped', cleanly(() => {
    onFakeTime();
    store().show({ text: 'one' });
    store().show({ text: 'two' });
    store().show({ text: 'three' });
    store().show({ text: 'two' });
    assert.deepEqual(texts(), ['one', 'three', 'two'], 'the oldest is kept: the repeat took the old place, not a 4th');
    assert.equal(new Set(store().toasts.map((t) => t.id)).size, 3);
  }));

  test('TO-7: a repeated text takes the new kind: an error repeated as a confirmation goes by itself, and the other way round stays', cleanly(() => {
    const time = onFakeTime();
    store().show({ kind: 'error', text: 'Nothing to copy' });
    store().show({ text: 'Nothing to copy' });
    assert.deepEqual(store().toasts.map((t) => t.kind), ['confirm']);
    store().show({ kind: 'error', text: 'Nothing to copy' });
    assert.deepEqual(store().toasts.map((t) => t.kind), ['error']);
    assert.equal(time.live, 0, "the confirmation's timer went with it");
    time.advance(TOAST_MS * 2);
    assert.deepEqual(texts(), ['Nothing to copy']);
  }));

  test('TO-8: nothing to say shows nothing; an unknown kind is a confirmation; the text is trimmed', cleanly(() => {
    const time = onFakeTime();
    for (const text of ['', '   ', null, undefined]) assert.equal(store().show({ text }), null, JSON.stringify(text));
    assert.equal(store().show(), null, 'no argument at all');
    assert.equal(store().show({ kind: 'error' }), null, 'an error with no text');
    assert.deepEqual(store().toasts, []);
    assert.equal(time.live, 0);
    store().show({ kind: 'warning', text: '  Copied 1 line (secrets masked)  ' });
    assert.deepEqual(store().toasts.map((t) => [t.kind, t.text]), [['confirm', 'Copied 1 line (secrets masked)']]);
    store().show({ text: 42 });
    assert.deepEqual(texts(), ['Copied 1 line (secrets masked)', '42']);
  }));

  test('TO-9: ToastHost mounted: with no toasts only an empty hidden polite region, always there; roles; newest at the bottom; never takes focus; Dismiss keeps focus and dismisses', cleanly(async () => {
    const { ToastHost } = await loadHost();
    onFakeTime();
    await onPage(async (p) => {
      const terminal = p.el('textarea', { 'data-terminal': '' });
      terminal.focus();
      p.render(React.createElement(ToastHost));
      assert.ok(p.document.querySelector('[data-toast-host]') === null, 'no host with no toasts');
      assert.equal(p.document.querySelectorAll('[data-toast]').length, 0, 'no toast drawn');
      // The polite region is there before the first toast, so a screen
      // reader that only hears regions it already knows still says it.
      const live = p.document.querySelector('[data-toast-live]');
      assert.ok(live, 'the polite region is mounted with no toast up');
      assert.equal(live.getAttribute('role'), 'status');
      assert.equal(live.getAttribute('aria-live'), 'polite');
      assert.equal(live.getAttribute('aria-atomic'), 'false', 'each confirmation is said as it is added, not the whole list');
      const liveClasses = live.getAttribute('class').split(/\s+/);
      assert.ok(liveClasses.includes('sr-only'), 'the region is visually hidden: drawn nowhere, taking no room');
      assert.ok(liveClasses.includes('pointer-events-none'), 'the region takes no clicks');
      assert.equal(live.textContent, '', 'the region is empty with no toast');
      assert.equal(live.childNodes.length, 0);
      p.settled(() => {
        store().show({ text: 'Path copied' });
        store().show({ kind: 'error', text: 'Path not copied' });
      });
      assert.ok(p.document.querySelector('[data-toast-live]') === live, 'the confirmation landed in the region that was already there');
      assert.equal(live.textContent, 'Path copied', 'the region says the confirmation and not the error (an alert of its own)');
      const host = p.document.querySelector('[data-toast-host]');
      assert.ok(host, 'the host is drawn');
      assert.ok(/(^|\s)pointer-events-none(\s|$)/.test(host.getAttribute('class')), 'the host lets clicks through');
      const [confirm, error] = host.querySelectorAll('[data-toast]');
      // The drawn confirmation's words are for the eye only: the polite region
      // is their one accessible copy, so browse mode does not read them twice.
      // An error's words are read where they are drawn (its own alert).
      const wordsOf = (toast) => toast.childNodes.filter((c) => c.nodeType === 1 && c.tagName === 'DIV');
      assert.equal(wordsOf(confirm).length, 1);
      assert.equal(wordsOf(confirm)[0].textContent, 'Path copied');
      assert.equal(wordsOf(confirm)[0].getAttribute('aria-hidden'), 'true', "the drawn confirmation's words are read besides the region's");
      assert.equal(wordsOf(error)[0].textContent, 'Path not copied');
      assert.equal(wordsOf(error)[0].getAttribute('aria-hidden'), null, "an error's words are hidden from a screen reader");
      for (const toast of [confirm, error]) {
        assert.equal(toast.getAttribute('aria-hidden'), null, 'a whole toast is hidden, its Dismiss with it');
        assert.equal(toast.querySelector('button').getAttribute('aria-hidden'), null, 'Dismiss is hidden from a screen reader');
      }
      assert.equal(confirm.getAttribute('role'), null, 'the drawn confirmation is not a second live region: said once');
      assert.equal(confirm.getAttribute('aria-live'), null);
      assert.equal(host.querySelectorAll('[role="status"]').length + host.querySelectorAll('[aria-live]').length, 0, 'no live region inside the host');
      assert.equal(p.document.querySelectorAll('[role="status"]').length, 1, 'one polite region in all');
      assert.equal(error.getAttribute('role'), 'alert');
      assert.equal(error.getAttribute('aria-live'), null, 'an alert is assertive by its role');
      assert.ok(confirm.textContent.includes('Path copied') && error.textContent.includes('Path not copied'), 'newest at the bottom');
      assert.ok(/(^|\s)pointer-events-auto(\s|$)/.test(confirm.getAttribute('class')), 'a toast takes its own clicks');
      assert.ok(p.document.activeElement === terminal, 'showing a toast took no focus');
      const dismiss = error.querySelector('button');
      assert.equal(dismiss.getAttribute('title'), 'Dismiss');
      const press = p.settled(() => dispatch(p.window, dismiss, { type: 'mousedown' }));
      assert.ok(press.defaultPrevented, 'a press on Dismiss does not take focus');
      p.click(dismiss);
      assert.deepEqual(texts(), ['Path copied'], 'Dismiss took the error away');
      assert.ok(p.document.activeElement === terminal, 'focus is still in the terminal');
      // A second confirmation is a line of its own in the same region.
      p.settled(() => store().show({ text: 'Session ID copied' }));
      assert.deepEqual(live.childNodes.filter((c) => c.nodeType === 1).map((c) => c.textContent), ['Path copied', 'Session ID copied']);
      p.settled(() => {
        for (const t of [...store().toasts]) store().dismiss(t.id);
      });
      assert.ok(p.document.querySelector('[data-toast-host]') === null, 'the host goes with the last toast');
      assert.ok(p.document.querySelector('[data-toast-live]') === live, 'the polite region stays mounted after the last toast');
      assert.equal(live.textContent, '', 'and is empty again');
      assert.ok(p.document.activeElement === terminal, 'focus is still in the terminal');
    });
  }));

  test('TO-10: ToastHost mounted: right-2 with no corner notice, right-[416px] with one (either), right-[824px] with both', cleanly(async () => {
    const { ToastHost } = await loadHost();
    onFakeTime();
    await onPage(async (p) => {
      store().show({ text: 'Path copied' });
      p.render(React.createElement(ToastHost));
      const offset = () => {
        const cls = p.document.querySelector('[data-toast-host]').getAttribute('class').split(/\s+/);
        return cls.filter((c) => c.startsWith('right-'));
      };
      assert.deepEqual(offset(), ['right-2']);
      p.settled(() => useEditorStore.setState({ openFailure: { path: '/w/a.bin', fileName: 'a.bin', reason: 'Binary file' } }));
      assert.deepEqual(offset(), ['right-[416px]'], 'beside the open failure');
      p.settled(() => useTerminalStore.setState({ agentHistoryNotice: { kind: 'gone', text: 'x', key: null, tabId: null, seq: 1 } }));
      assert.deepEqual(offset(), ['right-[824px]'], 'beside both');
      p.settled(() => useEditorStore.setState({ openFailure: null }));
      assert.deepEqual(offset(), ['right-[416px]'], 'beside the agent session notice alone');
      p.settled(() => useTerminalStore.setState({ agentHistoryNotice: null }));
      assert.deepEqual(offset(), ['right-2']);
    });
  }));

  test('TO-11: ToastHost mounted in a narrow window — right-2 just above the notices when their column does not fit (960px and 1100px with both, 800px with one), the AC16 classes when it does (1300px with both, 960px with one); measured from the notices; nothing left behind', cleanly(async () => {
    const { ToastHost, CORNER_NOTICE_SELECTOR } = await loadHost();
    assert.equal(CORNER_NOTICE_SELECTOR, '[data-corner-notice]');
    onFakeTime();
    const observers = fakeResizeObservers();
    try {
      await onPage(async (p) => {
        const heights = { failure: 60, agent: 90 };
        /** A stand-in for a corner notice's root: the attribute the real ones carry, and a height. */
        const notice = (which) => {
          const el = p.el('div', { 'data-corner-notice': '' });
          el.getBoundingClientRect = () => ({ width: 400, height: heights[which] });
          return el;
        };
        const resizeListeners = () => p.window.listeners.filter((l) => l.type === 'resize');
        const resizeTo = (width) =>
          p.settled(() => {
            p.window.innerWidth = width;
            for (const l of resizeListeners()) l.fn.call(p.window, { type: 'resize' });
          });
        const host = () => p.document.querySelector('[data-toast-host]');
        const placed = () => ({
          offset: host().getAttribute('class').split(/\s+/).filter((c) => c.startsWith('right-')),
          marginBottom: host().style.marginBottom || '',
        });
        let commits = 0;
        p.window.innerWidth = 960;
        store().show({ text: 'Path copied' });
        p.render(React.createElement(React.Profiler, { id: 'toasts', onRender: () => (commits += 1) }, React.createElement(ToastHost)));
        assert.deepEqual(placed(), { offset: ['right-2'], marginBottom: '' }, 'no notice: right-2, as before');
        assert.equal(resizeListeners().length, 0, 'nothing listens with no notice up');
        assert.equal(observers.all.length, 0, 'nothing observes with no notice up');

        // Both notices in a 960px window (the smallest NexTerm allows): the
        // third column would start 264px off screen, so right-2 above them,
        // the taller one's 90px and the 8px gap over mb-2's 8px.
        const failureEl = notice('failure');
        const agentEl = notice('agent');
        p.settled(() => {
          useEditorStore.setState({ openFailure: { path: '/w/a.bin', fileName: 'a.bin', reason: 'Binary file' } });
          useTerminalStore.setState({ agentHistoryNotice: { kind: 'gone', text: 'x', key: null, tabId: null, seq: 1 } });
        });
        assert.deepEqual(placed(), { offset: ['right-2'], marginBottom: '106px' }, '960px, both notices');
        assert.equal(resizeListeners().length, 1, 'one resize listener');
        assert.equal(observers.live.length, 1, 'one observer');
        assert.deepEqual(observers.live[0].targets, [failureEl, agentEl], 'it observes both notices');
        resizeTo(1100);
        assert.deepEqual(placed(), { offset: ['right-2'], marginBottom: '106px' }, '1100px, both notices');
        resizeTo(1300);
        assert.deepEqual(placed(), { offset: ['right-[824px]'], marginBottom: '' }, '1300px, both notices: the AC16 class');
        resizeTo(1232);
        assert.deepEqual(placed(), { offset: ['right-[824px]'], marginBottom: '' }, '1232px: the column just fits');
        resizeTo(1231);
        assert.deepEqual(placed(), { offset: ['right-2'], marginBottom: '106px' }, '1231px: it does not');
        // A resize that changes nothing draws nothing again.
        const before = commits;
        resizeTo(1200);
        resizeTo(1000);
        assert.equal(commits, before, 'a resize within the same room re-rendered the host');

        // A notice grows: the toasts move up with it, from the observer, no polling.
        heights.agent = 130;
        p.settled(() => observers.fire());
        assert.deepEqual(placed(), { offset: ['right-2'], marginBottom: '146px' }, 'above the grown notice');
        const settledCommits = commits;
        p.settled(() => observers.fire());
        assert.equal(commits, settledCommits, 'the same height again re-rendered the host');

        // One notice left, in a window narrower than 824px: right-2 above it;
        // at 824px and over, beside it (right-[416px]).
        p.settled(() => {
          agentEl.parentNode.removeChild(agentEl);
          useTerminalStore.setState({ agentHistoryNotice: null });
        });
        assert.equal(observers.live.length, 1, 'the old observer went, a new one came');
        assert.deepEqual(observers.live[0].targets, [failureEl], 'it observes the notice still up');
        assert.equal(resizeListeners().length, 1, 'still one resize listener');
        assert.deepEqual(placed(), { offset: ['right-[416px]'], marginBottom: '' }, '1000px, one notice: the AC16 class');
        resizeTo(960);
        assert.deepEqual(placed(), { offset: ['right-[416px]'], marginBottom: '' }, '960px, one notice: the AC16 class');
        resizeTo(800);
        assert.deepEqual(placed(), { offset: ['right-2'], marginBottom: '76px' }, '800px, one notice: above it');
        resizeTo(824);
        assert.deepEqual(placed(), { offset: ['right-[416px]'], marginBottom: '' }, '824px, one notice: beside it');

        // The last toast goes: the listener and the observer go with it.
        resizeTo(800);
        p.settled(() => {
          for (const t of [...store().toasts]) store().dismiss(t.id);
        });
        assert.ok(host() === null);
        assert.equal(resizeListeners().length, 0, 'the resize listener outlived the toasts');
        assert.equal(observers.live.length, 0, 'the observer outlived the toasts');
        // Back with a toast, then unmounted: nothing left behind either.
        p.settled(() => store().show({ kind: 'error', text: 'Not copied: the clipboard refused it' }));
        assert.deepEqual(placed(), { offset: ['right-2'], marginBottom: '76px' }, 'an error is placed the same way');
        assert.equal(resizeListeners().length, 1);
        p.unmount();
        assert.equal(resizeListeners().length, 0, 'the resize listener outlived the host');
        assert.equal(observers.live.length, 0, 'the observer outlived the host');
        assert.ok(observers.all.every((o) => o.disconnected), 'an observer was never disconnected');
      });
    } finally {
      observers.restore();
    }
  }));

  test('TO-12: columnsThatFit and toastPlacement — the AC16 offset while its column fits, else right-2 lifted by the tallest notice and 8px', async () => {
    const { columnsThatFit, toastPlacement } = await loadHost();
    for (const [width, columns] of [[1232, 3], [1231, 2], [1300, 3], [1100, 2], [960, 2], [824, 2], [823, 1], [800, 1], [416, 1], [415, 0]]) {
      assert.equal(columnsThatFit(width), columns, `${width}px`);
    }
    for (const width of [undefined, null, NaN, Infinity, '960']) assert.equal(columnsThatFit(width), Infinity, `${String(width)}: fits all`);
    assert.deepEqual(toastPlacement(0, 1, 0), { offset: 'right-2', lift: 0 });
    assert.deepEqual(toastPlacement(0, 0, 50), { offset: 'right-2', lift: 0 }, 'no notice: never lifted');
    assert.deepEqual(toastPlacement(1, 2, 60), { offset: 'right-[416px]', lift: 0 });
    assert.deepEqual(toastPlacement(1, 1, 60), { offset: 'right-2', lift: 68 });
    assert.deepEqual(toastPlacement(2, 3, 90), { offset: 'right-[824px]', lift: 0 });
    assert.deepEqual(toastPlacement(2, 2, 90), { offset: 'right-2', lift: 98 });
    assert.deepEqual(toastPlacement(2, Infinity, 90), { offset: 'right-[824px]', lift: 0 }, 'unmeasured width');
    for (const height of [0, NaN, undefined, -5]) {
      assert.deepEqual(toastPlacement(2, 2, height), { offset: 'right-[824px]', lift: 0 }, `no notice height (${String(height)}): beside, never over`);
    }
  });

  test('TO-99: teardown — no toast, no timer, the global timers back, the store as it started', cleanly(() => {
    const time = onFakeTime();
    store().show({ text: 'left behind' });
    assert.equal(time.live, 1);
    resetToasts();
    assert.equal(time.live, 0, 'resetToasts cleared the timer it was handed');
    assert.deepEqual(store().toasts, []);
    assert.deepEqual(Object.keys(store()).sort(), Object.keys(START).sort());
    assert.equal(store().show, START.show);
    assert.equal(store().dismiss, START.dismiss);
    // setToastTimers hands back the timers it replaced.
    const restore = setToastTimers(fakeTimers());
    restore();
    const later = fakeTimers();
    const restoreLater = setToastTimers(later);
    store().show({ text: 'x' });
    assert.equal(later.live, 1, 'the timers handed in are the ones used');
    restoreLater();
    resetToasts();
    assert.equal(useEditorStore.getState().openFailure, null);
    assert.equal(useTerminalStore.getState().agentHistoryNotice, null);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'), RESIZE_OBSERVER_BEFORE, 'TO-11 left its ResizeObserver behind');
  }));
});

