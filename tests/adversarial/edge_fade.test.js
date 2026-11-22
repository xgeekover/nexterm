/**
 * The fade at the edge of an overflowing tab strip (bundle 3, U3-F1/F2): see
 * src/lib/edgeFade.js and src/hooks/useEdgeFade.js.
 *
 * `edgeFadeSides` is pure and run on numbers. `watchEdgeFade` is run on a
 * fake scroller (its three numbers, a listener list and an attribute map that
 * counts its writes) with fake ResizeObserver and MutationObserver classes
 * passed in, or none. `followEdgeFade`, the hook's per-render step, is run
 * with a fake watcher. The hook is mounted with real React on the
 * hand-written page of react_page.js (EDGE-17) and read as source, with the
 * CSS; RN-237 (tests/render/runner.js) checks the four strips carry it.
 *
 * Nothing here sets a DOM global for longer than one test (`onPage` and
 * `withGlobal` put back what they found).
 */
import { readFileSync } from 'node:fs';
import React, { useRef } from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage, dispatch } from './react_page.js';
import { useEdgeFade } from '../../src/hooks/useEdgeFade.js';
import {
  EDGE_FADE_ATTRIBUTE,
  EDGE_FADE_SIDES,
  EDGE_FADE_TOLERANCE,
  edgeFadeSides,
  followEdgeFade,
  watchEdgeFade,
} from '../../src/lib/edgeFade.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/** A strip 200px wide holding `content` px of tabs, scrolled to `left`. */
const box = (left, content = 500, width = 200) => ({ scrollLeft: left, scrollWidth: content, clientWidth: width });

const captureOf = (options) => options === true || Boolean(options && options.capture);

/** A scroller: the numbers `edgeFadeSides` reads, listeners, children and attributes. */
function fakeScroller({ left = 0, content = 500, width = 200, children = 3 } = {}) {
  const el = {
    scrollLeft: left,
    scrollWidth: content,
    clientWidth: width,
    nodeType: 1,
    children: Array.from({ length: children }, (_, i) => ({ nodeType: 1, name: `chip-${i}` })),
    attributes: {},
    writes: [],
    removed: [],
    listeners: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
    },
    setAttribute(name, value) {
      el.writes.push([name, value]);
      el.attributes[name] = String(value);
    },
    removeAttribute(name) {
      el.removed.push(name);
      delete el.attributes[name];
    },
    addEventListener(type, fn, options) {
      el.listeners.push({ type, fn, capture: captureOf(options), options });
    },
    removeEventListener(type, fn, options) {
      const at = el.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === captureOf(options));
      if (at !== -1) el.listeners.splice(at, 1);
    },
    scrollTo(left) {
      el.scrollLeft = left;
      for (const l of [...el.listeners]) if (l.type === 'scroll') l.fn({ type: 'scroll' });
    },
  };
  return el;
}

/** A ResizeObserver class that records what it observes and fires on demand. */
function fakeResizeObserver() {
  const made = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      this.disconnected = false;
      made.push(this);
    }
    observe(target) {
      this.observed.add(target);
    }
    unobserve(target) {
      this.observed.delete(target);
    }
    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }
    fire() {
      this.callback([], this);
    }
  }
  return { FakeResizeObserver, made };
}

/** A MutationObserver class that records its options and fires records on demand. */
function fakeMutationObserver() {
  const made = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      made.push(this);
    }
    observe(target, options) {
      this.targets.push({ target, options });
    }
    disconnect() {
      this.disconnected = true;
    }
    fire(records) {
      this.callback(records, this);
    }
  }
  return { FakeMutationObserver, made };
}

const fadeOf = (el) => el.getAttribute(EDGE_FADE_ATTRIBUTE);

/** Runs `body` with `globalThis[name]` set to `value`, then puts back what was there. */
function withGlobal(name, value, body) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const before = globalThis[name];
  globalThis[name] = value;
  try {
    return body();
  } finally {
    if (had) globalThis[name] = before;
    else delete globalThis[name];
  }
}

describe('Edge fade on overflowing tab strips (bundle 3, U3): which sides fade', () => {
  test("EDGE-1: a strip that does not overflow, or by no more than the 1px tolerance, fades nowhere", () => {
    assert.equal(EDGE_FADE_TOLERANCE, 1);
    assert.equal(edgeFadeSides(box(0, 200)), 'none', 'content as wide as the strip');
    assert.equal(edgeFadeSides(box(0, 120)), 'none', 'content narrower than the strip');
    assert.equal(edgeFadeSides(box(0, 201)), 'none', 'one pixel over is within the tolerance');
    assert.equal(edgeFadeSides(box(1, 201)), 'none', 'one pixel over, scrolled to it');
    assert.equal(edgeFadeSides(box(0, 0, 0)), 'none', 'a strip not laid out yet (display: none)');
  });

  test("EDGE-2: at the start the end fades ('end'), fractional positions within 1px included", () => {
    for (const left of [0, 0.25, 0.5, 0.99, 1]) {
      assert.equal(edgeFadeSides(box(left)), 'end', `scrollLeft ${left}`);
    }
    // Just past the tolerance the start has something to show too.
    assert.equal(edgeFadeSides(box(1.01)), 'both');
    assert.equal(edgeFadeSides(box(1.5)), 'both');
  });

  test("EDGE-3: in the middle both sides fade ('both')", () => {
    for (const left of [2, 50, 150, 298]) {
      assert.equal(edgeFadeSides(box(left)), 'both', `scrollLeft ${left} of 300`);
    }
  });

  test("EDGE-4: at the end the start fades ('start'), a zoomed window stopping short by under 1px included", () => {
    // 500 - 200: the furthest the strip scrolls is 300.
    for (const left of [300, 299.5, 299.01, 299]) {
      assert.equal(edgeFadeSides(box(left)), 'start', `scrollLeft ${left}`);
    }
    assert.equal(edgeFadeSides(box(298.99)), 'both', 'just short of the tolerance is still in the middle');
  });

  test('EDGE-5: an elastic overscroll past either end counts as that end', () => {
    assert.equal(edgeFadeSides(box(-12)), 'end', 'pulled past the start');
    assert.equal(edgeFadeSides(box(340)), 'start', 'pulled past the end');
  });

  test("EDGE-6: suspended (a drag over the strip) fades nowhere, at every position", () => {
    for (const left of [0, 0.5, 150, 299.5, 300, -5, 400]) {
      assert.equal(edgeFadeSides(box(left), true), 'none', `scrollLeft ${left}, suspended`);
      assert.notEqual(edgeFadeSides(box(left), false), 'none', `scrollLeft ${left}, not suspended, does fade`);
    }
  });

  test('EDGE-7: a missing box or a number that is not one fades nowhere, never throws', () => {
    assert.equal(edgeFadeSides(null), 'none');
    assert.equal(edgeFadeSides(undefined), 'none');
    assert.equal(edgeFadeSides({}), 'none');
    assert.equal(edgeFadeSides(box(Number.NaN)), 'none');
    assert.equal(edgeFadeSides(box(0, Number.POSITIVE_INFINITY)), 'none');
    assert.equal(edgeFadeSides({ scrollLeft: '0', scrollWidth: '500', clientWidth: '200' }), 'none');
    // And every answer is one of the four values the CSS knows.
    assert.deepEqual([...EDGE_FADE_SIDES], ['none', 'start', 'end', 'both']);
    assert.ok(Object.isFrozen(EDGE_FADE_SIDES));
  });
});

describe('Edge fade on overflowing tab strips (bundle 3, U3): keeping a scroller up to date', () => {
  test('EDGE-8: watching writes the value at once and again on each scroll, only when it changes', () => {
    const el = fakeScroller();
    const { FakeResizeObserver } = fakeResizeObserver();
    const { FakeMutationObserver } = fakeMutationObserver();
    const watcher = watchEdgeFade(el, { ResizeObserver: FakeResizeObserver, MutationObserver: FakeMutationObserver });
    assert.equal(EDGE_FADE_ATTRIBUTE, 'data-edge-fade');
    assert.equal(fadeOf(el), 'end');
    assert.equal(el.writes.length, 1);

    // One passive scroll listener on the scroller itself.
    const scrolls = el.listeners.filter((l) => l.type === 'scroll');
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].capture, false);
    assert.equal(scrolls[0].options?.passive, true, 'the scroll listener is not passive');

    // Scrolling within the start, then through the middle: one write per change.
    el.scrollTo(0.5);
    assert.equal(el.writes.length, 1, 'a scroll that changes nothing wrote the attribute');
    for (const left of [10, 20, 30, 40, 150, 200]) el.scrollTo(left);
    assert.equal(fadeOf(el), 'both');
    assert.equal(el.writes.length, 2, `the middle wrote more than once: ${JSON.stringify(el.writes)}`);
    el.scrollTo(300);
    assert.equal(fadeOf(el), 'start');
    el.scrollTo(0);
    assert.equal(fadeOf(el), 'end');
    assert.deepEqual(el.writes.map(([, v]) => v), ['end', 'both', 'start', 'end']);
    watcher.stop();
  });

  test('EDGE-9: a resize of the strip or of a tab, and a tab added or removed, update it', () => {
    const el = fakeScroller({ content: 200 });
    const { FakeResizeObserver, made: resizers } = fakeResizeObserver();
    const { FakeMutationObserver, made: mutations } = fakeMutationObserver();
    const watcher = watchEdgeFade(el, { ResizeObserver: FakeResizeObserver, MutationObserver: FakeMutationObserver });
    assert.equal(fadeOf(el), 'none', 'nothing overflows yet');
    assert.equal(resizers.length, 1);
    const ro = resizers[0];
    assert.ok(ro.observed.has(el), 'the scroller is not observed');
    for (const child of el.children) assert.ok(ro.observed.has(child), `${child.name} is not observed`);
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].targets, [{ target: el, options: { childList: true } }], 'not watching the tabs come and go');

    // The window narrows: the strip now overflows.
    el.clientWidth = 120;
    ro.fire();
    assert.equal(fadeOf(el), 'end');

    // A tab added: observed from now on, and the value checked again.
    const added = { nodeType: 1, name: 'chip-new' };
    el.scrollWidth = 260;
    el.scrollLeft = 140;
    mutations[0].fire([{ addedNodes: [added, { nodeType: 3 }], removedNodes: [] }]);
    assert.ok(ro.observed.has(added), 'a new tab is not observed');
    assert.equal(fadeOf(el), 'start');

    // A tab removed: no longer observed, and the strip fits again.
    el.scrollWidth = 120;
    el.scrollLeft = 0;
    mutations[0].fire([{ addedNodes: [], removedNodes: [added] }]);
    assert.ok(!ro.observed.has(added), 'a removed tab is still observed');
    assert.equal(fadeOf(el), 'none');
    watcher.stop();
  });

  test('EDGE-10: no ResizeObserver or MutationObserver (an old WebView): nothing throws and scrolling still updates it', () => {
    const el = fakeScroller();
    const watcher = watchEdgeFade(el, { ResizeObserver: null, MutationObserver: null });
    assert.equal(fadeOf(el), 'end');
    el.scrollTo(300);
    assert.equal(fadeOf(el), 'start');
    watcher.stop();

    // Missing as globals too: the defaults are looked up, not assumed.
    withGlobal('ResizeObserver', undefined, () =>
      withGlobal('MutationObserver', undefined, () => {
        const other = fakeScroller({ left: 150 });
        const w = watchEdgeFade(other);
        assert.equal(fadeOf(other), 'both');
        w.stop();
      })
    );
    // And present as globals, they are used.
    const { FakeResizeObserver, made } = fakeResizeObserver();
    withGlobal('ResizeObserver', FakeResizeObserver, () =>
      withGlobal('MutationObserver', undefined, () => {
        const other = fakeScroller();
        const w = watchEdgeFade(other);
        assert.equal(made.length, 1, 'the global ResizeObserver was not used');
        assert.ok(made[0].observed.has(other));
        w.stop();
        assert.ok(made[0].disconnected);
      })
    );
  });

  test('EDGE-11: the suspend flag turns the fade off and back on, writing only when the value changes', () => {
    const el = fakeScroller({ left: 150 });
    const watcher = watchEdgeFade(el, { suspended: true, ResizeObserver: null, MutationObserver: null });
    assert.equal(fadeOf(el), 'none', 'a strip watched mid-drag fades');
    el.scrollTo(10);
    el.scrollTo(300);
    assert.equal(fadeOf(el), 'none', 'the auto-scroller moving the strip during a drag brought the fade back');
    assert.equal(el.writes.length, 1);

    watcher.setSuspended(false);
    assert.equal(fadeOf(el), 'start', 'the drag ended and the fade did not come back');
    const writes = el.writes.length;
    watcher.setSuspended(false);
    watcher.setSuspended(0);
    assert.equal(el.writes.length, writes, 'the same flag again wrote the attribute');
    watcher.setSuspended(true);
    assert.equal(fadeOf(el), 'none');
    watcher.stop();
  });

  test('EDGE-12: stop removes the listener, disconnects both observers and the attribute; twice is harmless', () => {
    const el = fakeScroller();
    const { FakeResizeObserver, made: resizers } = fakeResizeObserver();
    const { FakeMutationObserver, made: mutations } = fakeMutationObserver();
    const watcher = watchEdgeFade(el, { ResizeObserver: FakeResizeObserver, MutationObserver: FakeMutationObserver });
    watcher.stop();
    assert.equal(el.listeners.length, 0, 'the scroll listener is still there');
    assert.ok(resizers[0].disconnected, 'the ResizeObserver is still connected');
    assert.ok(mutations[0].disconnected, 'the MutationObserver is still connected');
    assert.equal(fadeOf(el), null, 'a stopped watcher left its fade behind');
    const writes = el.writes.length;
    resizers[0].fire();
    mutations[0].fire([]);
    watcher.update();
    watcher.setSuspended(true);
    assert.equal(el.writes.length, writes, 'a stopped watcher still wrote');
    watcher.stop();
    assert.deepEqual(el.removed, [EDGE_FADE_ATTRIBUTE], 'stopped twice removed twice');
  });

  test('EDGE-13: no element, or something that is not one, is watched by a watcher that does nothing', () => {
    for (const el of [null, undefined, {}, { addEventListener() {} }]) {
      const watcher = watchEdgeFade(el);
      watcher.update();
      watcher.setSuspended(true);
      watcher.stop();
    }
  });
});

describe('Edge fade on overflowing tab strips (bundle 3, U3): the hook and the stylesheet', () => {
  /** A watcher factory that records what it was asked for. */
  const recordingWatch = () => {
    const made = [];
    const watch = (el, options) => {
      const watcher = { el, options, flags: [], stopped: 0, setSuspended: (v) => watcher.flags.push(v), stop: () => watcher.stopped++ };
      made.push(watcher);
      return watcher;
    };
    return { watch, made };
  };

  test('EDGE-14: each render keeps the watcher of the same element and passes it the flag; a new element gets a new one', () => {
    const { watch, made } = recordingWatch();
    const a = { name: 'inline strip' };
    const b = { name: 'the same strip in its overlay' };
    let slot = followEdgeFade(null, a, false, watch);
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].options, { suspended: false });
    assert.equal(slot.el, a);

    slot = followEdgeFade(slot, a, true, watch);
    slot = followEdgeFade(slot, a, false, watch);
    assert.equal(made.length, 1, 'a render of the same element started another watcher');
    assert.deepEqual(made[0].flags, [true, false]);

    slot = followEdgeFade(slot, b, true, watch);
    assert.equal(made[0].stopped, 1, 'the old element\u{2019}s watcher was not stopped');
    assert.equal(made.length, 2);
    assert.equal(made[1].el, b);
    assert.deepEqual(made[1].options, { suspended: true });

    slot = followEdgeFade(slot, null, false, watch);
    assert.equal(slot, null);
    assert.equal(made[1].stopped, 1, 'no element (unmounted) did not stop the watcher');
    assert.equal(followEdgeFade(null, null, false, watch), null);
    assert.equal(made.length, 2);
  });

  test('EDGE-15: the hook keeps no state, watches from an effect after every render and stops on unmount', () => {
    const hook = code(read('../../src/hooks/useEdgeFade.js'));
    assert.match(hook, /^import \{ useEffect, useRef \} from 'react';/m, 'the hook imports more than useEffect and useRef');
    assert.match(hook, /import \{ followEdgeFade \} from '\.\.\/lib\/edgeFade\.js';/);
    assert.match(hook, /export function useEdgeFade\(ref, suspended = false\)/);
    assert.ok(!/useState|useReducer|useLayoutEffect|setState/.test(hook), 'the hook renders on its own (state) or runs in layout');
    // One effect with no dependency list (the element or the flag may change
    // on any render), and one mount-only effect whose cleanup lets go.
    assert.match(hook, /useEffect\(\(\) => \{\s*watched\.current = followEdgeFade\(watched\.current, ref\?\.current \?\? null, held\);\s*\}\);/);
    assert.match(hook, /useEffect\(\s*\(\) => \(\) => \{\s*watched\.current = followEdgeFade\(watched\.current, null, false\);\s*\},\s*\[\]\s*\);/);
    // Neither file draws anything: the fade is the attribute and the mask.
    const lib = code(read('../../src/lib/edgeFade.js'));
    for (const [name, text] of [['the hook', hook], ['edgeFade.js', lib]]) {
      assert.ok(!/createElement|appendChild|insertBefore|innerHTML|\.style\b|<[a-z]/.test(text), `${name} adds an element or styles one`);
    }
    assert.ok(!/\bdocument\b|\bwindow\b/.test(lib), 'edgeFade.js reaches for a DOM global other than the observers');
  });

  test('EDGE-16: the three masks fade 20px from black to transparent, with no colour token, transition or pseudo-element', () => {
    const css = read('../../src/styles/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].trim(), body: m[2] }))
      .filter((r) => r.selector.includes('data-edge-fade'));
    const bySide = Object.fromEntries(rules.map((r) => [/data-edge-fade="(\w+)"/.exec(r.selector)?.[1], r]));
    assert.deepEqual(Object.keys(bySide).sort(), ['both', 'end', 'start'], `rules: ${rules.map((r) => r.selector).join(', ')}`);
    const expected = {
      start: 'linear-gradient(to right, transparent, black 20px)',
      end: 'linear-gradient(to right, black calc(100% - 20px), transparent)',
      both: 'linear-gradient(to right, transparent, black 20px, black calc(100% - 20px), transparent)',
    };
    for (const [side, gradient] of Object.entries(expected)) {
      const { selector, body } = bySide[side];
      assert.equal(selector, `[data-edge-fade="${side}"]`, `${side}: the rule is scoped to more than the attribute`);
      assert.ok(body.includes(`-webkit-mask-image: ${gradient};`), `${side}: no -webkit-mask-image ${gradient}`);
      assert.ok(new RegExp(`(^|[\\s;])mask-image: ${gradient.replace(/[()]/g, '\\$&')};`).test(body), `${side}: no mask-image ${gradient}`);
      assert.ok(!/var\(|#[0-9a-f]{3}|rgb|hsl/i.test(body), `${side}: the mask names a colour: ${body}`);
      assert.ok(!/transition|animation/.test(body), `${side}: the mask animates: ${body}`);
    }
    assert.ok(!/data-edge-fade[^{]*::?(before|after)/.test(css), 'a fade is drawn as a pseudo-element');
    assert.ok(!/data-edge-fade[^{]*\{[^}]*pointer-events/.test(css), 'a fade rule touches pointer events');
  });

  test('EDGE-17: mounted, the hook fades a scroller, follows its scroll, the flag and a new element, and lets go on unmount', async () => {
    const h = React.createElement;
    await onPage(async (p) => {
      const scrollers = [];
      // The page lays nothing out: each scroller gets its numbers as it mounts.
      const measured = (ref) => (node) => {
        if (node && !scrollers.includes(node)) {
          Object.assign(node, { scrollLeft: 0, scrollWidth: 500, clientWidth: 200 });
          scrollers.push(node);
        }
        ref.current = node;
      };
      function Strip({ suspended, which }) {
        const ref = useRef(null);
        useEdgeFade(ref, suspended);
        return h(
          'div',
          { className: 'strip' },
          h('div', { key: which, ref: measured(ref), className: 'overflow-x-auto no-scrollbar' }, h('span', null, 'tab'))
        );
      }
      const scrollListeners = (node) => node.listeners.filter((l) => l.type === 'scroll').length;

      p.render(h(Strip, { suspended: false, which: 'inline' }));
      const [first] = scrollers;
      assert.equal(first.getAttribute(EDGE_FADE_ATTRIBUTE), 'end', 'a strip at its start does not fade its end');
      assert.equal(scrollListeners(first), 1);

      first.scrollLeft = 150;
      p.settled(() => dispatch(p.window, first, { type: 'scroll' }));
      assert.equal(first.getAttribute(EDGE_FADE_ATTRIBUTE), 'both');

      p.render(h(Strip, { suspended: true, which: 'inline' }));
      assert.equal(first.getAttribute(EDGE_FADE_ATTRIBUTE), 'none', 'a drag over the strip left it faded');
      p.render(h(Strip, { suspended: false, which: 'inline' }));
      assert.equal(first.getAttribute(EDGE_FADE_ATTRIBUTE), 'both', 'the drag ended and the fade did not come back');
      assert.equal(scrollListeners(first), 1, 'a render added another scroll listener');

      // The same strip drawn as a new element (a hidden strip into its overlay).
      p.render(h(Strip, { suspended: false, which: 'overlay' }));
      assert.equal(scrollers.length, 2);
      const [, second] = scrollers;
      assert.equal(scrollListeners(first), 0, 'the old element is still listened to');
      assert.equal(second.getAttribute(EDGE_FADE_ATTRIBUTE), 'end');
      assert.equal(scrollListeners(second), 1);

      p.unmount();
      assert.equal(scrollListeners(second), 0, 'unmounted, the strip is still listened to');
    });
  });
});
