/**
 * A hidden tab strip's overlay (spec P1), MOUNTED: `useStripOverlay` and
 * `useRefocusAfterMenu` (stripReveal.js) rendered with real React into the
 * hand-written page of react_page.js, and driven with the events a browser
 * sends — so what the listeners and the effects do is checked in CI, where
 * no browser runs (split_lock_headless.test.js does it in Chromium when one
 * is there).
 *
 *   - Escape is the strip's only while the keyboard is in the strip or on its
 *     handle; then it closes it and goes no further. With the keyboard in the
 *     terminal it is the program's, and the strip stays.
 *   - The window losing focus changes nothing; the strip closing with the
 *     keyboard in it hands the keyboard to the handle, so what is drawn and
 *     where the keyboard is always agree.
 *   - A hold letting go with the pointer on the handle keeps the strip open.
 *   - A pane menu closed with the keyboard left on the page gives it back to
 *     the terminal; one whose item put it somewhere leaves it there.
 */
import React, { useRef } from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage, dispatch, letItRun } from './react_page.js';
import { useStripOverlay, useRefocusAfterMenu } from '../../src/components/terminal/stripReveal.js';

const h = React.createElement;

/** The page's pieces and the hook's latest answer. */
function harness(p, { held = false } = {}) {
  const seen = { state: null };
  const terminal = p.el('textarea', { class: 'xterm-helper-textarea' });
  function Pane({ isHeld }) {
    const overlayRef = useRef(null);
    const handleRef = useRef(null);
    seen.state = useStripOverlay(true, { overlayRef, handleRef, held: isHeld });
    return h(
      'div',
      null,
      h('button', { ref: handleRef, 'data-handle': '' }),
      h('div', { ref: overlayRef, 'data-overlay': '' }, h('div', { 'data-chip': '', tabIndex: 0 }))
    );
  }
  const render = (isHeld) => p.render(h(Pane, { isHeld }));
  render(held);
  const handle = p.document.querySelector('[data-handle]');
  const chip = p.document.querySelector('[data-chip]');
  const overlay = p.document.querySelector('[data-overlay]');
  return { seen, terminal, handle, chip, overlay, render };
}

/**
 * Where the keyboard is, checked by identity. Not `assert.equal` on the
 * nodes: on a failure node:assert diffs both values, and a page node leads
 * through React's fibers to the whole page. That diff ran the process out of
 * memory before anything was printed, so a broken focus rule showed up as a
 * crashed run (counted as nothing failing) instead of as this case failing.
 */
function assertFocusOn(p, node, message) {
  const at = p.document.activeElement;
  if (at === node) return;
  assert.fail(`${message} (the keyboard is on ${nameOf(at)}, not ${nameOf(node)})`);
}

/** A page node in a few words: its tag and its data attributes. */
function nameOf(node) {
  if (!node) return 'nothing';
  const marks = [...(node.attributes?.keys?.() ?? [])].filter((name) => name.startsWith('data-') || name === 'class');
  return `<${node.tagName}${marks.map((name) => ` ${name}`).join('')}>`;
}

/** Escape at whatever has the keyboard, with a listener past the window's capture phase watching for it. */
function escape(p) {
  let reachedPage = false;
  const watch = () => {
    reachedPage = true;
  };
  p.window.addEventListener('keydown', watch);
  const event = p.settled(() => dispatch(p.window, p.document.activeElement, { type: 'keydown', key: 'Escape' }));
  p.window.removeEventListener('keydown', watch);
  return { event, reachedPage };
}

describe('Hidden strip, mounted: Escape, focus and holds (stripReveal.js)', () => {
  test("SO-01: Escape typed into the terminal is the program's — the strip stays, the key goes on, unprevented", async () => {
    await onPage(async (p) => {
      const { seen, terminal } = harness(p);
      p.settled(() => seen.state.handleClick({ detail: 1, pointerType: 'mouse' }));
      assert.equal(seen.state.open, true, 'setup');
      terminal.focus();
      const { event, reachedPage } = escape(p);
      assert.equal(seen.state.open, true, 'Escape typed into the terminal closed the strip');
      assert.equal(event.defaultPrevented, false, "Escape was taken from the program it was typed to");
      assert.equal(reachedPage, true, 'Escape was stopped before it reached the program');
    });
  });

  test("SO-02: Escape with the keyboard in the strip is the strip's: it closes it, goes no further, and the keyboard goes to the handle", async () => {
    await onPage(async (p) => {
      const { seen, chip, handle } = harness(p);
      p.settled(() => seen.state.handleClick({ detail: 0, pointerType: 'keyboard' }));
      chip.focus();
      const { event, reachedPage } = escape(p);
      assert.equal(seen.state.open, false, 'Escape with the keyboard in the strip left it up');
      assert.equal(event.defaultPrevented, true, 'the Escape the strip took was not cancelled');
      assert.equal(reachedPage, false, 'the Escape the strip took went on to the program');
      assertFocusOn(p, handle, 'the keyboard did not go back to the handle');
    });
  });

  test('SO-03: the window losing focus leaves the strip as it was; focus moving out closes it; closing with the keyboard in it hands the keyboard to the handle', async () => {
    await onPage(async (p) => {
      const { seen, chip, handle, terminal } = harness(p);
      p.settled(() => seen.state.handleClick({ detail: 0, pointerType: 'keyboard' }));
      chip.focus();
      // The window loses focus: a focusout that names no element.
      p.settled(() => dispatch(p.window, chip, { type: 'focusout', relatedTarget: null }));
      assert.equal(seen.state.open, true, 'the window losing focus closed the strip');
      // Back, Escape still works on it.
      const { reachedPage } = escape(p);
      assert.equal(seen.state.open, false, 'after the window came back, Escape did not close it');
      assert.equal(reachedPage, false);
      // Focus moving out to the terminal closes it.
      p.settled(() => seen.state.handleClick({ detail: 0, pointerType: 'keyboard' }));
      chip.focus();
      p.settled(() => dispatch(p.window, chip, { type: 'focusout', relatedTarget: terminal }));
      assert.equal(seen.state.open, false, 'focus left the strip and it stayed');
      // Closed from the handle with the keyboard still in the strip: the
      // keyboard does not stay on something nobody can see.
      p.settled(() => seen.state.handleClick({ detail: 0, pointerType: 'keyboard' }));
      chip.focus();
      p.settled(() => seen.state.handleClick({ detail: 1, pointerType: 'mouse' }));
      await letItRun();
      assert.equal(seen.state.open, false);
      assertFocusOn(p, handle, 'the strip closed with the keyboard left inside it');
    });
  });

  test('SO-04: a hold (its menu) letting go with the pointer on the HANDLE keeps the strip open; off both, it closes', async () => {
    await onPage(async (p) => {
      const { seen, handle, overlay, render } = harness(p);
      handle.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 6 });
      overlay.getBoundingClientRect = () => ({ left: 0, top: 6, right: 300, bottom: 34 });
      p.settled(() => seen.state.handleClick({ detail: 1, pointerType: 'mouse' }));
      render(true); // its menu opens (right-click on the handle)
      p.settled(() => dispatch(p.window, handle, { type: 'pointermove', clientX: 80, clientY: 3, pointerType: 'mouse' }));
      render(false); // the menu is dismissed with the pointer on the handle
      assert.equal(seen.state.open, true, 'dismissing the handle\u{2019}s own menu closed the strip');
      render(true);
      p.settled(() => dispatch(p.window, p.document.body, { type: 'pointermove', clientX: 80, clientY: 200, pointerType: 'mouse' }));
      render(false);
      assert.equal(seen.state.open, false, 'a hold let go off the strip and it stayed');
    });
  });
});

describe('Hidden strip, mounted: the keyboard after a pane menu (stripReveal.js)', () => {
  function MenuPane({ menuOpen, paneRef }) {
    useRefocusAfterMenu(menuOpen, paneRef);
    return null;
  }

  test('SO-05: a pane menu closed with the keyboard left on the page gives it back to the terminal', async () => {
    await onPage(async (p) => {
      const pane = p.el('div', {});
      const body = p.el('div', { 'data-pane-body': 'pane-1' }, pane);
      const terminal = p.el('textarea', { class: 'xterm-helper-textarea' }, body);
      const paneRef = { current: pane };
      const menu = p.el('div', { role: 'menu' });
      p.render(h(MenuPane, { menuOpen: true, paneRef }));
      menu.focus();
      // A press on a strip that goes away with the menu: the menu leaves the
      // page with the keyboard on it.
      p.document.body.removeChild(menu);
      p.render(h(MenuPane, { menuOpen: false, paneRef }));
      await letItRun();
      assertFocusOn(p, terminal, 'the keyboard was left on the page');
    });
  });

  test("SO-06: a menu item that put the keyboard somewhere (a rename's field) is left alone", async () => {
    await onPage(async (p) => {
      const pane = p.el('div', {});
      const body = p.el('div', { 'data-pane-body': 'pane-1' }, pane);
      p.el('textarea', { class: 'xterm-helper-textarea' }, body);
      const field = p.el('input', { 'data-rename-input': '' }, pane);
      const paneRef = { current: pane };
      p.render(h(MenuPane, { menuOpen: true, paneRef }));
      field.focus();
      p.render(h(MenuPane, { menuOpen: false, paneRef }));
      await letItRun();
      assertFocusOn(p, field, "the rename's field lost the keyboard to the terminal");
    });
  });
});
