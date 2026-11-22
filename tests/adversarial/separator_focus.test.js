/**
 * The press that left a split divider focused (bundle 3, U2-F2/F3; AC7 as
 * amended in cycle 3): see src/lib/separatorFocus.js.
 *
 * react-resizable-panels focuses a separator from its own capture
 * pointerdown on the document and never blurs it, and a focused separator
 * stops highlighting across its hit area. `installSeparatorFocusRelease(doc)`
 * remembers the focus before a press (a capture pointerdown on the window,
 * which runs before the library's) and, when the press ends (a capture
 * pointerup or pointercancel on the document), blurs the separator only if
 * this press focused it. Keyboard focus from before the press is left alone,
 * whatever the engine knows about `:focus-visible`.
 *
 * Run on a fake window and document: listeners per target, a dispatch in the
 * browser's order (window capture, document capture, then bubble, then the
 * engine's own focus on mousedown), an `activeElement`, and elements whose
 * `matches` knows `[data-separator]` only (it throws on anything else, and
 * logs every selector) and whose `blur` counts. A stand-in for the library's
 * pointerdown focuses the separator the way the library does. DV-99 puts
 * back the globals DV-8 trapped.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { installSeparatorFocusRelease, SEPARATOR_SELECTOR } from '../../src/lib/separatorFocus.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SOURCE = read('../../src/lib/separatorFocus.js');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

const captureOf = (options) => options === true || Boolean(options && options.capture);

/** Every selector a fake element was asked to match (DV-14). */
const queried = [];

/** An event target with nothing but listeners and a log of what was added and removed. */
function fakeTarget(name) {
  const target = {
    name,
    listeners: [],
    added: [],
    removed: [],
    addEventListener(type, fn, options) {
      const entry = { on: name, type, fn, capture: captureOf(options) };
      target.added.push(entry);
      target.listeners.push(entry);
    },
    removeEventListener(type, fn, options) {
      const capture = captureOf(options);
      target.removed.push({ on: name, type, fn, capture });
      const at = target.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (at !== -1) target.listeners.splice(at, 1);
    },
  };
  return target;
}

/**
 * A document and, unless `withWindow` is false, a window as its
 * `defaultView`. `dispatch` delivers an event aimed below the document as a
 * browser does: window capture, document capture, document bubble, window
 * bubble, each in the order the listeners were added; then, for a
 * pointerdown with `focuses`, the engine's own focus on mousedown (a press
 * on a text field).
 */
function fakeDocument({ withWindow = true } = {}) {
  const doc = fakeTarget('document');
  const view = withWindow ? fakeTarget('window') : null;
  doc.defaultView = view;
  doc.dispatch = (type, init = {}) => {
    const { focuses, ...rest } = init;
    const event = { type, pointerType: 'mouse', button: 0, ...rest };
    const phase = (target, capture) => {
      if (!target) return;
      for (const l of [...target.listeners]) if (l.type === type && l.capture === capture) l.fn(event);
    };
    phase(view, true);
    phase(doc, true);
    phase(doc, false);
    phase(view, false);
    if (type === 'pointerdown' && focuses) focuses.focus();
    return event;
  };
  doc.body = element(doc, 'body', {});
  doc.activeElement = doc.body;
  return doc;
}

/**
 * An element of `doc`: `focus` makes it the active element, `blur` gives
 * focus back to the body. Its `matches` knows `[data-separator]` and nothing
 * else: any other selector (`:focus-visible` included) throws out of the
 * listener and fails the test.
 */
function element(doc, name, attributes) {
  const el = {
    name,
    attributes,
    blurs: 0,
    focusCalls: [],
    matches(selector) {
      queried.push(selector);
      if (selector === SEPARATOR_SELECTOR) return Object.prototype.hasOwnProperty.call(attributes, 'data-separator');
      throw new Error(`the fake element knows no selector but ${SEPARATOR_SELECTOR}: ${selector}`);
    },
    focus(options) {
      el.focusCalls.push(options);
      // As in a browser, focusing the focused element changes nothing.
      if (doc.activeElement === el) return;
      doc.activeElement = el;
      if (el.attributes['data-separator'] !== undefined) el.attributes['data-separator'] = 'focus';
    },
    blur() {
      el.blurs += 1;
      if (doc.activeElement === el) doc.activeElement = doc.body;
      if (el.attributes['data-separator'] !== undefined) el.attributes['data-separator'] = 'inactive';
    },
  };
  return el;
}

/**
 * The library's own press handling, cut down: a capture pointerdown on the
 * document that focuses the separator under the press with
 * `focusVisible: false`, for the main mouse button or any touch or pen.
 */
function libraryStandIn(doc, separator) {
  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button > 0) return;
    if (!event.overSeparator) return;
    separator.focus({ focusVisible: false, preventScroll: true });
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.library = onPointerDown;
  return onPointerDown;
}

/** Keyboard focus on `el` (Tab): no pointer event at all. */
function tabTo(doc, el) {
  doc.activeElement = el;
  if (el.attributes['data-separator'] !== undefined) el.attributes['data-separator'] = 'focus';
}

/** A fake window and document with a separator, the library's press handling, and nothing of ours yet. */
function arrange(options) {
  const doc = fakeDocument(options);
  const separator = element(doc, 'separator', { 'data-separator': 'inactive', role: 'separator' });
  const textarea = element(doc, 'textarea', {});
  libraryStandIn(doc, separator);
  // Only what the release adds is counted from here.
  doc.added.length = 0;
  return { doc, view: doc.defaultView, separator, textarea };
}

/** The listeners the release left on the window and the document, as `target:type`: everything not the library's. */
const oursOn = (doc) =>
  [...(doc.defaultView?.listeners ?? []), ...doc.listeners].filter((l) => l.fn !== doc.library).map((l) => `${l.on}:${l.type}${l.capture ? ':capture' : ''}`);

const THREE_LISTENERS = ['window:pointerdown:capture', 'document:pointerup:capture', 'document:pointercancel:capture'];

describe('Divider focus after a press (bundle 3, U2; amended AC7): blur only the separator the press focused', () => {
  test('DV-1: a press and release on a separator the library focused blurs it, and it reports its hover/rest state again', () => {
    const { doc, separator } = arrange();
    const uninstall = installSeparatorFocusRelease(doc);
    doc.dispatch('pointerdown', { overSeparator: true });
    // The library focused it: the stuck state.
    assert.equal(doc.activeElement, separator);
    assert.deepEqual(separator.focusCalls, [{ focusVisible: false, preventScroll: true }]);
    assert.equal(separator.attributes['data-separator'], 'focus');
    assert.equal(separator.blurs, 0, 'nothing is blurred on the press itself: the drag is starting');
    doc.dispatch('pointerup');
    assert.equal(separator.blurs, 1);
    assert.equal(doc.activeElement, doc.body);
    assert.notEqual(separator.attributes['data-separator'], 'focus');
    // A second press and release does the same: nothing is spent on the first.
    doc.dispatch('pointerdown', { overSeparator: true });
    doc.dispatch('pointerup');
    assert.equal(separator.blurs, 2);
    // And from a text field (xterm's textarea), the most common path: type, then drag a divider.
    const { doc: doc2, separator: separator2, textarea } = arrange();
    const uninstall2 = installSeparatorFocusRelease(doc2);
    textarea.focus();
    doc2.dispatch('pointerdown', { overSeparator: true });
    assert.equal(doc2.activeElement, separator2, 'setup: the library took focus from the textarea');
    doc2.dispatch('pointerup');
    assert.equal(separator2.blurs, 1);
    assert.equal(doc2.activeElement, doc2.body);
    uninstall();
    uninstall2();
  });

  test('DV-2: keyboard focus only (Tab, then arrow keys, no pointer press) is never blurred', () => {
    const { doc, separator } = arrange();
    const uninstall = installSeparatorFocusRelease(doc);
    tabTo(doc, separator);
    for (const type of ['keydown', 'focusin', 'focus', 'keyup']) doc.dispatch(type, { key: 'ArrowLeft' });
    assert.equal(separator.blurs, 0);
    assert.equal(doc.activeElement, separator, 'the separator keeps keyboard focus, and its arrow keys');
    // The release listens to nothing a keyboard sends.
    assert.deepEqual(oursOn(doc), THREE_LISTENERS);
    uninstall();
  });

  test('DV-3: a press that ends with something other than a separator focused does nothing, and so does a release with no press', () => {
    const { doc, separator, textarea } = arrange();
    const uninstall = installSeparatorFocusRelease(doc);
    // A press on a text field: the engine focuses it.
    doc.dispatch('pointerdown', { overSeparator: false, focuses: textarea });
    assert.equal(doc.activeElement, textarea, 'setup');
    doc.dispatch('pointerup');
    assert.equal(textarea.blurs, 0);
    assert.equal(doc.activeElement, textarea);
    // Nothing focused at all (the body), before and after.
    doc.activeElement = doc.body;
    doc.dispatch('pointerdown', { overSeparator: false });
    doc.dispatch('pointerup');
    assert.equal(doc.body.blurs, 0);
    // No active element, an active element without `matches`/`blur` (an SVG
    // in an old engine, a stand-in), or one that matches but cannot blur:
    // still nothing, and nothing thrown.
    for (const odd of [null, { name: 'bare' }, { name: 'no blur', matches: () => true }]) {
      doc.dispatch('pointerdown', { overSeparator: false });
      doc.activeElement = odd;
      doc.dispatch('pointerup');
    }
    // A release with no press before it (one that began before the install):
    // nothing is known about that press, so nothing is undone.
    doc.activeElement = separator;
    doc.dispatch('pointerup');
    doc.dispatch('pointercancel');
    assert.equal(separator.blurs, 0);
    assert.equal(doc.activeElement, separator);
    uninstall();
  });

  test('DV-4: install adds exactly a capture pointerdown on the window and a capture pointerup and pointercancel on the document; uninstall removes exactly those', () => {
    const { doc, view, separator } = arrange();
    const uninstall = installSeparatorFocusRelease(doc);
    assert.deepEqual(view.added.map((l) => `${l.type}:${l.capture}`), ['pointerdown:true'], 'the pointerdown is on the window, capture, so it runs before the library\'s on the document');
    assert.deepEqual(doc.added.map((l) => `${l.type}:${l.capture}`), ['pointerup:true', 'pointercancel:true'], 'capture, so a component that stops the release cannot keep the separator focused');
    assert.deepEqual(oursOn(doc), THREE_LISTENERS);
    assert.equal(typeof uninstall, 'function');
    uninstall();
    assert.deepEqual(view.removed.map((l) => [l.type, l.fn, l.capture]), view.added.map((l) => [l.type, l.fn, l.capture]));
    assert.deepEqual(doc.removed.map((l) => [l.type, l.fn, l.capture]), doc.added.map((l) => [l.type, l.fn, l.capture]));
    assert.deepEqual(oursOn(doc), [], 'the listeners are gone');
    assert.equal(doc.listeners.length, 1, 'the library\'s own pointerdown is untouched');
    // Twice is harmless: nothing more is removed.
    uninstall();
    assert.equal(view.removed.length, 1);
    assert.equal(doc.removed.length, 2);
    // And gone means gone: a press and release now leaves the separator focused.
    doc.dispatch('pointerdown', { overSeparator: true });
    doc.dispatch('pointerup');
    assert.equal(separator.blurs, 0);
    assert.equal(doc.activeElement, separator);
  });

  test('DV-5: a press of a mouse button other than the main one arms nothing; a main press ending in a chord is still released', () => {
    const { doc, separator } = arrange();
    const uninstall = installSeparatorFocusRelease(doc);
    // Keyboard focus, then a right or middle click elsewhere, or on the
    // separator: the library does not focus for it, and the keyboard focus stays.
    tabTo(doc, separator);
    for (const button of [1, 2]) {
      for (const overSeparator of [false, true]) {
        doc.dispatch('pointerdown', { button, overSeparator });
        doc.dispatch('pointerup', { button });
      }
    }
    assert.equal(separator.blurs, 0);
    assert.equal(doc.activeElement, separator);
    // A right press after the separator lost focus: nothing is focused, nothing blurred.
    separator.blur();
    doc.dispatch('pointerdown', { button: 2, overSeparator: true });
    doc.dispatch('pointerup', { button: 2 });
    assert.equal(doc.activeElement, doc.body);
    assert.equal(separator.blurs, 1, 'only the setup blur');
    // A main press on the separator whose release reports another button (the
    // right one went down during the drag and came up last): the press is the
    // main button's, and the separator it focused is blurred.
    doc.dispatch('pointerdown', { overSeparator: true });
    doc.dispatch('pointerup', { button: 2 });
    assert.equal(separator.blurs, 2);
    assert.equal(doc.activeElement, doc.body);
    uninstall();
  });

  test('DV-6: a touch or pen press on a separator is released like a mouse one', () => {
    for (const pointerType of ['touch', 'pen']) {
      const { doc, separator } = arrange();
      const uninstall = installSeparatorFocusRelease(doc);
      doc.dispatch('pointerdown', { pointerType, overSeparator: true });
      assert.equal(doc.activeElement, separator, `${pointerType}: setup`);
      doc.dispatch('pointerup', { pointerType });
      assert.equal(separator.blurs, 1, pointerType);
      assert.equal(doc.activeElement, doc.body, pointerType);
      uninstall();
    }
  });

  test('DV-7: no document (a server render, a test without one) installs nothing and returns a harmless uninstall', () => {
    for (const doc of [null, undefined, {}, { addEventListener: 'not a function' }]) {
      const uninstall = installSeparatorFocusRelease(doc);
      assert.equal(typeof uninstall, 'function');
      uninstall();
      uninstall();
    }
  });

  // DV-8 traps these; DV-99 checks they are back.
  const TRAPPED = ['document', 'window', 'navigator'];
  const before = Object.fromEntries(TRAPPED.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

  test('DV-8: importing the module touches no DOM global; its code names none', async () => {
    const touched = [];
    const trapped = [];
    try {
      for (const name of TRAPPED) {
        if (before[name] && !before[name].configurable) continue;
        Object.defineProperty(globalThis, name, {
          configurable: true,
          get() {
            touched.push(name);
            return undefined;
          },
        });
        trapped.push(name);
      }
      assert.ok(trapped.includes('document') && trapped.includes('window'), `setup: could not trap ${TRAPPED.filter((n) => !trapped.includes(n)).join(', ')}`);
      const fresh = await import(new URL(`../../src/lib/separatorFocus.js?dv-8=${Date.now()}`, import.meta.url).href);
      assert.equal(typeof fresh.installSeparatorFocusRelease, 'function');
      // And installing it on a fake document reads only that document and its own window.
      const { doc } = arrange();
      const uninstall = fresh.installSeparatorFocusRelease(doc);
      doc.dispatch('pointerdown', { overSeparator: true });
      doc.dispatch('pointerup');
      uninstall();
      assert.deepEqual(touched, []);
    } finally {
      for (const name of trapped) {
        if (before[name]) Object.defineProperty(globalThis, name, before[name]);
        else delete globalThis[name];
      }
    }
    const moduleCode = code(SOURCE);
    for (const name of ['document', 'window', 'navigator', 'globalThis', 'self']) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(moduleCode), `separatorFocus.js names ${name}`);
    }
    // The selector is the attribute the library puts on every separator.
    assert.equal(SEPARATOR_SELECTOR, '[data-separator]');
  });

  test('DV-9: PanelLayout installs it once, from a mount-only effect that returns the uninstall', () => {
    const layout = code(read('../../src/components/layout/PanelLayout.jsx'));
    assert.match(layout, /import \{ installSeparatorFocusRelease \} from '\.\.\/\.\.\/lib\/separatorFocus\.js';/);
    assert.equal((layout.match(/installSeparatorFocusRelease\(/g) ?? []).length, 1);
    assert.match(layout, /useEffect\(\(\) => \{\s*if \(typeof document === 'undefined'\) return undefined;\s*return installSeparatorFocusRelease\(document\);\s*\}, \[\]\);/);
  });

  test('DV-10: a Tab-focused separator is not blurred when a press elsewhere that moves no focus ends (A-R4)', () => {
    const { doc, separator, textarea } = arrange();
    const uninstall = installSeparatorFocusRelease(doc);
    tabTo(doc, separator);
    // A ContextMenu item, the strip overlay, a Dismiss: the press keeps focus
    // where it is, and its release reaches our listener all the same.
    for (const pointerType of ['mouse', 'touch', 'pen']) {
      doc.dispatch('pointerdown', { pointerType, overSeparator: false });
      doc.dispatch('pointerup', { pointerType });
      assert.equal(separator.blurs, 0, pointerType);
      assert.equal(doc.activeElement, separator, `${pointerType}: the separator keeps keyboard focus, and its arrow keys`);
      assert.equal(separator.attributes['data-separator'], 'focus', pointerType);
    }
    // A press on a text field takes the focus itself; nothing is blurred by us.
    doc.dispatch('pointerdown', { overSeparator: false, focuses: textarea });
    doc.dispatch('pointerup');
    assert.equal(doc.activeElement, textarea);
    assert.equal(separator.blurs, 0);
    assert.equal(textarea.blurs, 0);
    // Then a press on the separator focuses it the library's way: that one
    // is blurred on release (DV-1).
    doc.dispatch('pointerdown', { overSeparator: true });
    assert.equal(doc.activeElement, separator);
    doc.dispatch('pointerup');
    assert.equal(separator.blurs, 1);
    assert.equal(doc.activeElement, doc.body);
    uninstall();
  });

  test('DV-11: a Tab-focused separator pressed and dragged keeps keyboard focus after the release (R2, by design)', () => {
    for (const pointerType of ['mouse', 'touch', 'pen']) {
      const { doc, separator } = arrange();
      const uninstall = installSeparatorFocusRelease(doc);
      tabTo(doc, separator);
      doc.dispatch('pointerdown', { pointerType, overSeparator: true });
      assert.equal(separator.focusCalls.length, 1, `${pointerType}: setup: the library focused it again (a no-op)`);
      for (const type of ['pointermove', 'pointerup']) doc.dispatch(type, { pointerType });
      assert.equal(separator.blurs, 0, `${pointerType}: the user chose keyboard focus, and the press did not move it`);
      assert.equal(doc.activeElement, separator, pointerType);
      // A second drag of it, still focused from the keyboard: the same.
      doc.dispatch('pointerdown', { pointerType, overSeparator: true });
      doc.dispatch('pointerup', { pointerType });
      assert.equal(separator.blurs, 0, pointerType);
      assert.equal(doc.activeElement, separator, pointerType);
      uninstall();
    }
  });

  test('DV-12: a pointercancel ends a focusing press like a pointerup, and the press is forgotten after either', () => {
    for (const pointerType of ['touch', 'pen', 'mouse']) {
      const { doc, separator } = arrange();
      const uninstall = installSeparatorFocusRelease(doc);
      doc.dispatch('pointerdown', { pointerType, overSeparator: true });
      assert.equal(doc.activeElement, separator, `${pointerType}: setup`);
      // The engine took the pointer over (a touch that became a scroll).
      doc.dispatch('pointercancel', { pointerType });
      assert.equal(separator.blurs, 1, pointerType);
      assert.equal(doc.activeElement, doc.body, pointerType);
      // Forgotten: a stray release after the cancel, with the separator now
      // focused from the keyboard, undoes nothing.
      tabTo(doc, separator);
      doc.dispatch('pointerup', { pointerType });
      doc.dispatch('pointercancel', { pointerType });
      assert.equal(separator.blurs, 1, `${pointerType}: the keyboard focus after the cancel stays`);
      assert.equal(doc.activeElement, separator, pointerType);
      uninstall();
    }
  });

  test('DV-13: a document with no window falls back to a capture pointerdown on the document', () => {
    for (const shape of ['no defaultView', 'a defaultView without addEventListener']) {
      const doc = fakeDocument({ withWindow: false });
      if (shape !== 'no defaultView') doc.defaultView = { name: 'odd window' };
      const separator = element(doc, 'separator', { 'data-separator': 'inactive' });
      // Installed before the library, as when PanelLayout mounts before a group.
      const uninstall = installSeparatorFocusRelease(doc);
      assert.deepEqual(doc.added.map((l) => `${l.type}:${l.capture}`), ['pointerdown:true', 'pointerup:true', 'pointercancel:true'], shape);
      libraryStandIn(doc, separator);
      doc.dispatch('pointerdown', { overSeparator: true });
      doc.dispatch('pointerup');
      assert.equal(separator.blurs, 1, `${shape}: the separator the press focused is blurred`);
      tabTo(doc, separator);
      doc.dispatch('pointerdown', { overSeparator: false });
      doc.dispatch('pointerup');
      assert.equal(doc.activeElement, separator, `${shape}: keyboard focus stays`);
      uninstall();
      assert.deepEqual(doc.removed.map((l) => `${l.type}:${l.capture}`), ['pointerdown:true', 'pointerup:true', 'pointercancel:true'], shape);
      assert.deepEqual(doc.listeners.map((l) => l.fn), [doc.library], `${shape}: only the library's listener is left`);
    }
    // Installed after the library on a document with no window, the
    // pointerdown runs after the library's focus: the pressed separator counts
    // as focused before, and is kept (the doc block says so). The failure is
    // the old stuck highlight, never a lost keyboard focus.
    const { doc, separator } = arrange({ withWindow: false });
    const uninstall = installSeparatorFocusRelease(doc);
    doc.dispatch('pointerdown', { overSeparator: true });
    doc.dispatch('pointerup');
    assert.equal(separator.blurs, 0);
    assert.equal(doc.activeElement, separator);
    uninstall();
  });

  test('DV-14: the rule never asks :focus-visible (or any selector but [data-separator]), and the code names no focus-visible', () => {
    queried.length = 0;
    const { doc, separator, textarea } = arrange();
    const uninstall = installSeparatorFocusRelease(doc);
    // Every path: a focusing press, a cancel, a Tab-focused press elsewhere and on it, a text field.
    doc.dispatch('pointerdown', { overSeparator: true });
    doc.dispatch('pointerup');
    doc.dispatch('pointerdown', { overSeparator: true });
    doc.dispatch('pointercancel');
    tabTo(doc, separator);
    doc.dispatch('pointerdown', { overSeparator: false });
    doc.dispatch('pointerup');
    doc.dispatch('pointerdown', { overSeparator: true });
    doc.dispatch('pointerup');
    doc.dispatch('pointerdown', { overSeparator: false, focuses: textarea });
    doc.dispatch('pointerup');
    uninstall();
    assert.equal(separator.blurs, 2, 'setup: the two focusing presses were released');
    assert.ok(queried.length > 0, 'setup: the rule asked something');
    assert.deepEqual([...new Set(queried)], [SEPARATOR_SELECTOR], `asked: ${[...new Set(queried)].join(', ')}`);
    assert.ok(!/focus-?visible/i.test(code(SOURCE)), 'separatorFocus.js still uses :focus-visible or focusVisible');
  });

  test('DV-99: teardown \u{2014} the DOM globals as the next suite expects', () => {
    for (const name of TRAPPED) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), before[name], `${name} is not back`);
    }
  });
});
