/**
 * The keyboard in ConfirmDialog (src/components/common/ConfirmDialog.jsx),
 * which asks the Explorer's "Delete Folder", the editor's "Save X?" and its
 * "File Changed on Disk".
 *
 * It answered EVERY Enter with its confirm action, from a listener on the
 * window that also cancelled the key, so the button with focus never saw it:
 * Shift+Tab to Cancel, Enter, and the folder was deleted anyway — for good,
 * the backend's `remove_dir_all` has no trash. Tab itself walked out of the
 * dialog, there being no focus trap. And the effect that put focus on the
 * confirm button ran on every render of the caller, not once: both callers
 * pass new arrows each render, and the Explorer renders again for every file
 * an agent writes, so focus slid back off Cancel by itself.
 *
 * What a key means is a pure function, held here as a table. Where the
 * component puts it to work — an effect, a window listener, focus — is what
 * the render suite cannot reach (`renderToString` runs no effect), so the
 * dialog is MOUNTED here: real React and react-dom, on a page written by
 * hand that dispatches like a browser and does what a browser does with a key
 * nobody cancelled — Enter on a button clicks it, Space clicks it on release,
 * Tab moves focus to the next control. Which button that click lands on, and
 * what then runs, is React's own doing.
 *
 * Node cannot import a .jsx file, so the component is bundled with esbuild
 * and imported from a data: URL, as in editor_tab_reorder_ui.test.js — nothing
 * is registered process-wide. The page is `window` and `document` for one case
 * at a time, and whatever was there before is put back after it.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
// Static, so react-dom is loaded before any page exists. It looks for a DOM
// once, at load, and finding one reads `navigator`, which Node 20 lacks.
import ReactDOM from 'react-dom';
import ReactDOMClient from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';

const h = React.createElement;

// ---- The component, bundled --------------------------------------------------

const COMMON_DIR = fileURLToPath(new URL('../../src/components/common/', import.meta.url));
/** Kept real: the React the page renders with must be the one the component calls. */
const REAL = new Set(['react', 'react/jsx-runtime', 'lucide-react']);

let loading = null;
function loadDialogModule() {
  loading ??= build({
    stdin: {
      contents: "export * from './ConfirmDialog.jsx';",
      resolveDir: COMMON_DIR,
      sourcefile: 'confirm-dialog-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'real-react',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            REAL.has(args.path) ? { path: import.meta.resolve(args.path), external: true } : undefined
          );
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

let ui = null;
const loadUi = async () => {
  ui = await loadDialogModule();
};

/** An export of ConfirmDialog.jsx, failing by name when it is not there. */
function exported(name) {
  const value = ui[name];
  assert.ok(value !== undefined, `ConfirmDialog.jsx does not export ${name}, so none of this is under test`);
  return value;
}
const keyMeaning = (...a) => exported('confirmDialogKey')(...a);
const nextButton = (...a) => exported('nextButton')(...a);

// ---- A page that dispatches like a browser -----------------------------------

const HTML = 'http://www.w3.org/1999/xhtml';

/** Listeners as a browser keeps them: one per type, function and phase. */
class Target {
  constructor() {
    this.listeners = [];
  }
  addEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    if (this.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return;
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
}

/** A node: a parent, children in order, and the text under it. */
class PageNode extends Target {
  constructor(ownerDocument, nodeType, nodeName) {
    super();
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, before) {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at === -1) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (text) this.appendChild(this.ownerDocument.createTextNode(String(text)));
  }
}

class PageText extends PageNode {
  constructor(ownerDocument, text) {
    super(ownerDocument, 3, '#text');
    this.nodeValue = text;
  }
  get textContent() {
    return this.nodeValue;
  }
  set textContent(text) {
    this.nodeValue = String(text);
  }
}

class PageElement extends PageNode {
  constructor(ownerDocument, tag, namespaceURI = HTML) {
    const name = namespaceURI === HTML ? tag.toUpperCase() : tag;
    super(ownerDocument, 1, name);
    this.tagName = name;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.style = {};
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  focus() {
    this.ownerDocument.focused = this;
  }
  blur() {
    if (this.ownerDocument.focused === this) this.ownerDocument.focused = null;
  }
  /** A click from script, dispatched as a browser dispatches it. */
  click() {
    dispatch(this.ownerDocument.defaultView, this, { type: 'click', detail: 0 });
  }
  /**
   * Tag selectors only (`button`). Anything else throws, so a component that
   * starts asking for more fails loudly instead of matching nothing.
   */
  querySelectorAll(selector) {
    if (!/^[a-z]+$/.test(selector)) throw new Error(`the test page knows tag selectors only, not ${selector}`);
    const found = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 1 && c.tagName.toLowerCase() === selector) found.push(c);
        walk(c);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class PageDocument extends PageNode {
  constructor() {
    super(null, 9, '#document');
    this.documentElement = this.appendChild(this.createElement('html'));
    this.body = this.documentElement.appendChild(this.createElement('body'));
    this.focused = null;
  }
  /** What has focus — the page itself once that element has left it, as in a browser. */
  get activeElement() {
    return this.focused && this.contains(this.focused) ? this.focused : this.body;
  }
  createElement(tag) {
    return new PageElement(this, tag);
  }
  createElementNS(namespaceURI, tag) {
    return new PageElement(this, tag, namespaceURI);
  }
  createTextNode(text) {
    return new PageText(this, text);
  }
  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

/**
 * Dispatch as a browser does: capture from the window down to the target's
 * parent, the target's own capture listeners then its others, then bubbling
 * back up. `stopPropagation`, `stopImmediatePropagation` and `preventDefault`
 * are honoured, and a listener removed by an earlier one is not called.
 */
function dispatch(window, target, fields) {
  let stopped = false;
  let immediate = false;
  const event = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    button: 0,
    ...fields,
    target,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    stopImmediatePropagation() {
      stopped = true;
      immediate = true;
    },
  };
  const path = [window];
  const up = [];
  for (let n = target; n; n = n.parentNode) up.push(n);
  path.push(...up.reverse());
  const run = (node, capture) => {
    event.currentTarget = node;
    for (const l of [...node.listeners]) {
      if (l.type !== event.type || l.capture !== capture || !node.listeners.includes(l)) continue;
      l.fn.call(node, event);
      if (immediate) return;
    }
  };
  for (const node of path.slice(0, -1)) {
    run(node, true);
    if (stopped) return event;
  }
  run(target, true);
  if (!stopped) run(target, false);
  if (stopped) return event;
  for (const node of path.slice(0, -1).reverse()) {
    run(node, false);
    if (stopped) return event;
  }
  return event;
}

const isButton = (node) => node?.tagName === 'BUTTON';

/**
 * A page with the dialog's React root between two things it is drawn over: a
 * terminal's input before it and a button after it, both focusable — what
 * Tab reaches once it leaves the dialog.
 */
function makePage() {
  const document = new PageDocument();
  const window = Object.assign(new Target(), { document, HTMLIFrameElement: class {} });
  document.defaultView = window;

  const terminal = document.body.appendChild(document.createElement('textarea'));
  Object.assign(terminal, { value: '', selectionStart: 0, selectionEnd: 0 });
  const container = document.body.appendChild(document.createElement('div'));
  const behind = document.body.appendChild(document.createElement('button'));
  behind.textContent = 'Behind';

  /** Every key that reached the terminal, as it reached it. */
  const heard = [];
  terminal.addEventListener('keydown', (e) => heard.push(e.key));

  const focusables = () => {
    const found = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (['BUTTON', 'TEXTAREA', 'INPUT'].includes(c.tagName)) found.push(c);
        walk(c);
      }
    };
    walk(document.body);
    return found;
  };
  /** The browser's own Tab: the next control in document order, round the ends. */
  const tabFrom = (from, backwards) => {
    const order = focusables();
    const at = order.indexOf(from);
    const to = at === -1
      ? order[backwards ? order.length - 1 : 0]
      : order[(at + (backwards ? order.length - 1 : 1)) % order.length];
    to?.focus();
  };
  // The click that Enter on a button, or Space released on it, dispatches.
  const click = (node) => dispatch(window, node, { type: 'click', detail: 1 });

  let root = null;
  /** Run `fn`, then let React render whatever it set off — effects included — before going on. */
  const settled = (fn) => {
    let result;
    ReactDOM.flushSync(() => {
      result = fn();
    });
    return result;
  };

  const page = {
    window,
    document,
    terminal,
    behind,
    heard,
    /** Render `element` in the root, effects and all, before returning. */
    render(element) {
      root ??= ReactDOMClient.createRoot(container);
      settled(() => root.render(element));
    },
    unmount() {
      root?.unmount();
      root = null;
    },
    /** A key going down where focus is, and what the browser then does with it. */
    keydown(key, fields = {}) {
      return settled(() => {
        const target = document.activeElement;
        const event = dispatch(window, target, { type: 'keydown', key, ...fields });
        if (event.defaultPrevented) return event;
        if (key === 'Enter' && !event.isComposing && isButton(target)) click(target);
        else if (key === ' ' && isButton(target)) target.pressed = true; // :active until released
        else if (key === 'Tab') tabFrom(target, event.shiftKey);
        return event;
      });
    },
    keyup(key, fields = {}) {
      return settled(() => {
        const target = document.activeElement;
        const event = dispatch(window, target, { type: 'keyup', key, ...fields });
        if (key === ' ' && isButton(target) && target.pressed && !event.defaultPrevented) click(target);
        for (const node of focusables()) node.pressed = false;
        return event;
      });
    },
    /** One press: down, then up. Returns the keydown. */
    press(key, fields = {}) {
      const event = page.keydown(key, fields);
      page.keyup(key, fields);
      return event;
    },
    /** The dialog's buttons, as drawn: ✕ first, by its title, then the rest by label. */
    buttons() {
      return document.querySelectorAll('button')
        .filter((b) => b !== behind)
        .map((b) => b.getAttribute('title') || b.textContent);
    },
    button(label) {
      const found = document.querySelectorAll('button').filter((b) => b !== behind && (b.getAttribute('title') || b.textContent) === label);
      assert.equal(found.length, 1, `exactly one "${label}" button on the page`);
      return found[0];
    },
    /** What has focus: a button's label, 'terminal', 'Behind', or 'page' for nothing. */
    focus() {
      const active = document.activeElement;
      if (active === terminal) return 'terminal';
      if (active === document.body) return 'page';
      return active.getAttribute('title') || active.textContent;
    },
  };
  return page;
}

/**
 * Run `fn` on a fresh page installed as `window` and `document`, then take it
 * down and put back whatever was there. React's warnings fail the case: a
 * dialog that renders but trips one is not working as written.
 */
async function onPage(fn) {
  const page = makePage();
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  globalThis.window = page.window;
  globalThis.document = page.document;
  try {
    await fn(page);
    page.unmount();
    assert.deepEqual(errors, [], 'React reported nothing');
  } finally {
    page.unmount();
    console.error = consoleError;
    for (const name of ['window', 'document']) {
      if (had[name]) globalThis[name] = before[name];
      else delete globalThis[name];
    }
  }
}

// ---- The dialogs the app asks, with every answer written down ----------------

/**
 * Props as a caller passes them: new arrows on every call, as FileExplorer
 * and EditorPanel write them inline. Each answer is recorded in `log`, named
 * by `tag`.
 */
function deleteFolder(log, tag = 'delete', extra = {}) {
  return {
    open: true,
    title: 'Delete Folder',
    message: "Are you sure you want to delete 'src'? Its contents will be deleted too.",
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => log.push(`${tag}:confirm`),
    onCancel: () => log.push(`${tag}:cancel`),
    ...extra,
  };
}
function fileChangedOnDisk(log, tag = 'overwrite', extra = {}) {
  return {
    open: true,
    title: 'File Changed on Disk',
    message: "a.js has changed on disk since you opened it. Saving now would replace those changes with this tab's version.",
    confirmLabel: 'Overwrite',
    danger: true,
    altLabel: 'Use Disk Version',
    cancelLabel: 'Cancel',
    onConfirm: () => log.push(`${tag}:confirm`),
    onAlt: () => log.push(`${tag}:alt`),
    onCancel: () => log.push(`${tag}:cancel`),
    ...extra,
  };
}
function saveBeforeClose(log, tag = 'save', extra = {}) {
  return {
    open: true,
    title: 'Save a.js?',
    message: "Your changes to a.js will be lost if you don't save them.",
    confirmLabel: 'Save',
    altLabel: "Don't Save",
    altDanger: true,
    cancelLabel: 'Cancel',
    onConfirm: () => log.push(`${tag}:confirm`),
    onAlt: () => log.push(`${tag}:alt`),
    onCancel: () => log.push(`${tag}:cancel`),
    ...extra,
  };
}

// ---- What a key means (pure) --------------------------------------------------

const key = (k, fields = {}) => ({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, ...fields });

describe('ConfirmDialog: what a key means (pure)', () => {
  beforeEach(loadUi);

  test('CD-01: Enter on one of the dialog\'s buttons is that button\'s — the dialog leaves it alone, modified or not', () => {
    assert.equal(keyMeaning(key('Enter'), true), 'pass');
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
      assert.equal(keyMeaning(key('Enter', { [mod]: true }), true), 'pass', mod);
    }
  });

  test('CD-02: Enter anywhere else confirms nothing and reaches nothing — off the buttons it is swallowed', () => {
    assert.equal(keyMeaning(key('Enter'), false), 'swallow');
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
      assert.equal(keyMeaning(key('Enter', { [mod]: true }), false), 'swallow', mod);
    }
  });

  test('CD-03: a key held down from before is not a press — Enter and Space repeats on a button are swallowed', () => {
    assert.equal(keyMeaning(key('Enter', { repeat: true }), true), 'swallow', 'Enter repeating on a button');
    assert.equal(keyMeaning(key(' ', { repeat: true }), true), 'swallow', 'Space repeating on a button');
    assert.equal(keyMeaning(key('Enter', { repeat: true }), false), 'swallow', 'Enter off the buttons, held or not');
    assert.equal(keyMeaning(key(' '), true), 'pass', 'a fresh Space is the button\'s');
    assert.equal(keyMeaning(key(' ', { repeat: true }), false), 'pass', 'Space held anywhere else is nobody\'s business here');
    assert.equal(keyMeaning(key(' '), false), 'pass');
    assert.equal(keyMeaning(key('Escape', { repeat: true }), true), 'cancel', 'a held Escape still cancels');
  });

  test('CD-04: Escape cancels from anywhere; Tab and Shift+Tab move among the buttons; chords and other keys pass', () => {
    for (const onButton of [true, false]) {
      assert.equal(keyMeaning(key('Escape'), onButton), 'cancel');
      assert.equal(keyMeaning(key('Escape', { shiftKey: true }), onButton), 'cancel');
      assert.equal(keyMeaning(key('Tab'), onButton), 'next');
      assert.equal(keyMeaning(key('Tab', { shiftKey: true }), onButton), 'previous');
      for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
        assert.equal(keyMeaning(key('Tab', { [mod]: true }), onButton), 'pass', `${mod}+Tab is an app chord, not focus`);
      }
      for (const other of ['a', 'Delete', 'ArrowLeft', 'F2', 'Backspace']) {
        assert.equal(keyMeaning(key(other), onButton), 'pass', other);
      }
    }
  });

  test('CD-05: a key ending or editing an IME composition (Korean) is the composition\'s — Enter, Escape and Tab alike', () => {
    for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const k of ['Enter', 'Escape', 'Tab']) {
        assert.equal(keyMeaning(key(k, composing), false), 'pass', `${k} ${JSON.stringify(composing)}`);
      }
    }
  });

  test('CD-06: Tab moves to the next button and round from the last to the first; from outside them, to the first or the last', () => {
    assert.deepEqual([0, 1, 2, 3].map((at) => nextButton(at, 4, false)), [1, 2, 3, 0]);
    assert.deepEqual([0, 1, 2, 3].map((at) => nextButton(at, 4, true)), [3, 0, 1, 2]);
    assert.equal(nextButton(-1, 4, false), 0, 'Tab from outside: the first button');
    assert.equal(nextButton(-1, 4, true), 3, 'Shift+Tab from outside: the last');
    assert.deepEqual([nextButton(0, 1, false), nextButton(0, 1, true)], [0, 0], 'one button keeps it');
    assert.equal(nextButton(-1, 0, false), -1, 'no buttons, nowhere to go');
  });
});

// ---- The dialog, mounted ------------------------------------------------------

describe('ConfirmDialog: mounted, on a page that dispatches like a browser', () => {
  beforeEach(loadUi);

  test('CD-07: it opens with focus on the confirm button, and Enter there confirms — once', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      assert.deepEqual(p.buttons(), ['Close', 'Cancel', 'Delete'], 'as drawn');
      assert.equal(p.focus(), 'Delete');
      p.press('Enter');
      assert.deepEqual(log, ['delete:confirm']);
    });
  });

  test('CD-08: Enter on Cancel cancels and deletes nothing — reached by Shift+Tab, as a keyboard user does', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      p.press('Tab', { shiftKey: true });
      assert.equal(p.focus(), 'Cancel');
      const enter = p.press('Enter');
      assert.deepEqual(log, ['delete:cancel'], 'the button with focus answered, and only it');
      assert.equal(enter.defaultPrevented, false, 'the key was left to the button');
    });
  });

  test('CD-09: Enter on the third choice runs it ("Use Disk Version" keeps the agent\'s edit), and on ✕ it cancels', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, fileChangedOnDisk(log)));
      assert.deepEqual(p.buttons(), ['Close', 'Use Disk Version', 'Cancel', 'Overwrite'], 'as drawn');
      p.button('Use Disk Version').focus();
      p.press('Enter');
      assert.deepEqual(log, ['overwrite:alt'], 'not Overwrite');

      log.length = 0;
      p.button('Close').focus();
      p.press('Enter');
      assert.deepEqual(log, ['overwrite:cancel']);

      log.length = 0;
      p.button('Cancel').focus();
      p.press(' ');
      assert.deepEqual(log, ['overwrite:cancel'], 'Space on Cancel, as ever');
    });
  });

  test('CD-10: a key held down from before the dialog opened presses nothing in it — not Enter, not Space', async () => {
    await onPage((p) => {
      const log = [];
      // Enter chose "Delete" in the Explorer's menu and is still held: the
      // dialog opens under it, and the key repeats on its focused Delete.
      p.terminal.focus();
      p.keydown('Enter');
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      assert.equal(p.focus(), 'Delete');
      for (let i = 0; i < 3; i += 1) p.keydown('Enter', { repeat: true });
      p.keyup('Enter');
      assert.deepEqual(log, [], 'no repeat deleted');

      // The same with Space, which presses a button on release.
      p.render(h(ui.ConfirmDialog, deleteFolder(log, 'delete', { open: false })));
      p.terminal.focus();
      p.keydown(' ');
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      for (let i = 0; i < 3; i += 1) p.keydown(' ', { repeat: true });
      p.keyup(' ');
      assert.deepEqual(log, [], 'its release did not delete either');

      // A press made in the dialog still works.
      p.press('Enter');
      assert.deepEqual(log, ['delete:confirm']);
    });
  });

  test('CD-11: focus is put on the confirm button once, when the dialog opens — the caller rendering again leaves it where the user put it', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      p.press('Tab', { shiftKey: true });
      assert.equal(p.focus(), 'Cancel');
      // The Explorer renders again for every file a build or an agent
      // writes, each time with new arrows for both callbacks.
      for (let i = 0; i < 5; i += 1) p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      assert.equal(p.focus(), 'Cancel', 'still on Cancel');
      p.press('Enter');
      assert.deepEqual(log, ['delete:cancel']);
    });
  });

  test('CD-12: Escape cancels from anywhere, with the onCancel the caller passed last', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, deleteFolder(log, 'first')));
      p.render(h(ui.ConfirmDialog, deleteFolder(log, 'latest')));
      const esc = p.press('Escape');
      assert.deepEqual(log, ['latest:cancel']);
      assert.equal(esc.defaultPrevented, true);

      log.length = 0;
      p.terminal.focus();
      p.press('Escape');
      assert.deepEqual(log, ['latest:cancel'], 'from the terminal behind it too');
      assert.deepEqual(p.heard, [], 'and the terminal did not also get it');
    });
  });

  test('CD-13: Tab and Shift+Tab go round the dialog\'s buttons and never leave it — and bring focus back into it from outside', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, fileChangedOnDisk(log)));
      const forward = [];
      for (let i = 0; i < 5; i += 1) forward.push((p.press('Tab'), p.focus()));
      assert.deepEqual(forward, ['Close', 'Use Disk Version', 'Cancel', 'Overwrite', 'Close']);
      const backward = [];
      for (let i = 0; i < 5; i += 1) backward.push((p.press('Tab', { shiftKey: true }), p.focus()));
      assert.deepEqual(backward, ['Overwrite', 'Cancel', 'Use Disk Version', 'Close', 'Overwrite']);

      p.terminal.focus();
      p.press('Tab');
      assert.equal(p.focus(), 'Close', 'from the terminal behind: the first button');
      p.terminal.focus();
      p.press('Tab', { shiftKey: true });
      assert.equal(p.focus(), 'Overwrite', 'Shift+Tab from it: the last');
      p.document.focused = null;
      p.press('Tab');
      assert.equal(p.focus(), 'Close', 'from nothing focused: the first');
      assert.deepEqual(p.heard, [], 'the terminal heard no Tab');
      assert.deepEqual(log, [], 'and nothing was answered');
    });
  });

  test('CD-14: Enter with focus off the dialog\'s buttons answers nothing, moves nothing, and does not reach the terminal behind', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      // Something behind the dialog took focus.
      p.terminal.focus();
      const enter = p.press('Enter');
      assert.deepEqual(log, [], 'nothing deleted');
      assert.equal(p.focus(), 'terminal', 'focus not moved onto Delete, where the next Enter would delete');
      assert.deepEqual(p.heard, [], 'the terminal did not run its line under the dialog');
      assert.equal(enter.defaultPrevented, true);

      // Focus fell to the page: the message was clicked.
      p.document.focused = null;
      p.press('Enter');
      p.press('Enter');
      assert.deepEqual(log, [], 'still nothing');
      assert.equal(p.focus(), 'page');
    });
  });

  test('CD-15: the Enter that finishes a Korean syllable in the terminal behind is the IME\'s — it reaches the terminal, and the dialog does nothing', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      p.terminal.focus();
      const enter = p.keydown('Enter', { isComposing: true, keyCode: 229 });
      assert.deepEqual(log, []);
      assert.deepEqual(p.heard, ['Enter']);
      assert.equal(enter.defaultPrevented, false);
    });
  });

  test('CD-16: two dialogs open ("Save a.js?" ran into a change on disk) — only the one on top answers keys, until it closes (under StrictMode, as the dev app runs)', async () => {
    await onPage((p) => {
      const log = [];
      const both = (overwrite) =>
        h(React.StrictMode, null,
          h(ui.ConfirmDialog, saveBeforeClose(log)),
          h(ui.ConfirmDialog, fileChangedOnDisk(log, 'overwrite', { open: overwrite })));
      p.render(both(false));
      assert.equal(p.focus(), 'Save');
      p.render(both(true));
      assert.equal(p.focus(), 'Overwrite', 'the new dialog on top took focus');

      p.press('Enter');
      assert.deepEqual(log, ['overwrite:confirm'], 'one Enter, one answer — not a Save racing the Overwrite');

      log.length = 0;
      const esc = p.press('Escape');
      assert.deepEqual(log, ['overwrite:cancel'], 'one Escape, one dialog');
      assert.equal(esc.defaultPrevented, true);

      p.press('Tab');
      assert.equal(p.focus(), 'Close');
      assert.ok(p.document.activeElement.parentNode.textContent.includes('File Changed on Disk'), 'the top dialog\'s ✕');
      p.press('Tab', { shiftKey: true });
      assert.equal(p.focus(), 'Overwrite', 'Shift+Tab stays in the top dialog too');

      // The top one closes; the one beneath has the keys back.
      log.length = 0;
      p.render(both(false));
      p.press('Escape');
      assert.deepEqual(log, ['save:cancel']);
    });
  });

  test('CD-17: closed, it listens for nothing — keys go where they always went', async () => {
    await onPage((p) => {
      const log = [];
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      p.render(h(ui.ConfirmDialog, deleteFolder(log, 'delete', { open: false })));
      assert.deepEqual(p.buttons(), [], 'nothing drawn');
      p.terminal.focus();
      const enter = p.press('Enter');
      const esc = p.press('Escape');
      const tab = p.press('Tab');
      assert.deepEqual(log, []);
      assert.deepEqual(p.heard, ['Enter', 'Escape', 'Tab']);
      assert.deepEqual([enter, esc, tab].map((e) => e.defaultPrevented), [false, false, false]);
    });
  });
});

// ---- Where the keyboard goes when it closes ------------------------------------

/**
 * A dialog that closes itself on any answer, as every caller's does: the
 * answer clears the state that draws it.
 */
function SelfClosing({ log, props }) {
  const [open, setOpen] = React.useState(true);
  const answer = (what) => () => {
    log.push(what);
    setOpen(false);
  };
  return h(ui.ConfirmDialog, { ...props, open, onConfirm: answer('confirm'), onCancel: answer('cancel'), onAlt: answer('alt') });
}

/**
 * Closing a dialog unmounted the button that had focus, and focus fell to
 * the page: the terminal it was asked over took no keys until it was
 * clicked, and on Windows and Linux the next Ctrl+W reached the app's Close
 * Pane instead of the shell.
 */
describe('ConfirmDialog: the keyboard goes back where it was when it closes', () => {
  beforeEach(loadUi);

  test('CD-19: answered with Enter, Escape or a click, it gives the keyboard back to the terminal it was asked over', async () => {
    await onPage((p) => {
      const log = [];
      for (const [how, answer] of [
        ['Enter on Delete', () => p.press('Enter')],
        ['Escape', () => p.press('Escape')],
        ['a click on Cancel', () => ReactDOM.flushSync(() => p.button('Cancel').click())],
      ]) {
        p.terminal.focus();
        p.render(h(SelfClosing, { key: how, log, props: deleteFolder(log) }));
        assert.equal(p.focus(), 'Delete', `${how}: precondition`);
        answer();
        assert.deepEqual(p.buttons(), [], `${how}: closed`);
        assert.equal(p.focus(), 'terminal', `${how}: the keyboard was left on the page`);
      }
      assert.deepEqual(log, ['confirm', 'cancel', 'cancel']);
    });
  });

  test('CD-20: two open — the one on top closing gives the keyboard to the one beneath, on the button that had it; that one closing, to the terminal', async () => {
    await onPage((p) => {
      const log = [];
      const dialogs = (save, overwrite) =>
        h(React.StrictMode, null,
          h(ui.ConfirmDialog, saveBeforeClose(log, 'save', { open: save })),
          h(ui.ConfirmDialog, fileChangedOnDisk(log, 'overwrite', { open: overwrite })));
      p.terminal.focus();
      p.render(dialogs(true, false));
      p.render(dialogs(true, true));
      assert.equal(p.focus(), 'Overwrite', 'precondition: the new dialog on top took focus');
      p.render(dialogs(true, false));
      assert.equal(p.focus(), 'Save', 'back to the dialog beneath');
      p.render(dialogs(false, false));
      assert.equal(p.focus(), 'terminal', 'and from it to the terminal');
    });
  });

  test('CD-21: the one beneath closing first leaves the keyboard in the one on top — which then gives it back to the terminal, not to a button that is gone', async () => {
    await onPage((p) => {
      const log = [];
      // "Save a.js?" ran into a change on disk: "File Changed on Disk" opens
      // over it, and the question beneath is withdrawn while it stays.
      const dialogs = (save, overwrite) =>
        h(React.StrictMode, null,
          h(ui.ConfirmDialog, saveBeforeClose(log, 'save', { open: save })),
          h(ui.ConfirmDialog, fileChangedOnDisk(log, 'overwrite', { open: overwrite })));
      p.terminal.focus();
      p.render(dialogs(true, false));
      p.render(dialogs(true, true));
      p.render(dialogs(false, true));
      assert.equal(p.focus(), 'Overwrite', 'the keyboard stays in the dialog still open');
      p.render(dialogs(false, false));
      assert.equal(p.focus(), 'terminal');
    });
  });

  test('CD-22: opened with nothing to give back — from a menu that has gone — the caller says where the keyboard goes', async () => {
    await onPage((p) => {
      const log = [];
      const props = deleteFolder(log, 'delete', { fallbackFocus: () => p.behind.focus() });
      p.document.focused = null;
      p.render(h(SelfClosing, { log, props }));
      p.press('Escape');
      assert.equal(p.focus(), 'Behind');

      // What had the keyboard went while the dialog was open.
      const gone = p.document.body.appendChild(p.document.createElement('button'));
      gone.focus();
      p.render(h(SelfClosing, { key: 'second', log, props }));
      p.document.body.removeChild(gone);
      p.press('Escape');
      assert.equal(p.focus(), 'Behind', 'what had it is not on the page any more');
    });
  });

  test('CD-23: something that took the keyboard on purpose while the dialog was open keeps it', async () => {
    await onPage((p) => {
      const log = [];
      p.terminal.focus();
      p.render(h(ui.ConfirmDialog, deleteFolder(log)));
      p.behind.focus();
      p.render(h(ui.ConfirmDialog, deleteFolder(log, 'delete', { open: false })));
      assert.equal(p.focus(), 'Behind', 'focus was moved back to the terminal behind its back');
    });
  });

  test('CD-24: under StrictMode, as the dev app runs, it still remembers the terminal and not its own button', async () => {
    await onPage((p) => {
      const log = [];
      p.terminal.focus();
      p.render(h(React.StrictMode, null, h(SelfClosing, { log, props: deleteFolder(log) })));
      assert.equal(p.focus(), 'Delete');
      p.press('Enter');
      assert.equal(p.focus(), 'terminal');
    });
  });

  test('CD-25: the keyboard is given back without scrolling what takes it into view — xterm\'s textarea follows the cursor', async () => {
    await onPage((p) => {
      const log = [];
      p.terminal.focus();
      const asked = [];
      const focusTerminal = p.terminal.focus.bind(p.terminal);
      p.terminal.focus = (options) => {
        asked.push(options);
        focusTerminal();
      };
      p.render(h(SelfClosing, { log, props: deleteFolder(log) }));
      p.press('Escape');
      assert.equal(p.focus(), 'terminal');
      assert.deepEqual(asked, [{ preventScroll: true }]);
    });
  });
});

/** An element, by name, for the pure cases: only ever compared. */
const element = (name) => ({ name });

/** A dialog as the stack holds it: its box holds its buttons, the confirm last. */
function openDialog(returnTo, buttons) {
  const box = { contains: (el) => buttons.includes(el) };
  return { returnTo, box, confirm: buttons[buttons.length - 1] };
}

describe('ConfirmDialog: where the keyboard goes as one closes (pure)', () => {
  beforeEach(loadUi);

  const body = element('page');
  const terminal = element('terminal');
  const elsewhere = element('the find bar');
  const gone = element('a menu that has closed');
  const onPage = (el) => el !== gone;
  const closing = (stack, entry, focused) => exported('focusOnClose')(stack, entry, { focused, body, onPage });

  test('CD-26: one open — back to what had it while that is on the page, else the caller\'s fallback; something that took it meanwhile keeps it', () => {
    const one = (returnTo) => openDialog(returnTo, [element('Cancel'), element('Delete')]);

    let d = one(terminal);
    let stack = [d];
    assert.equal(closing(stack, d, body), terminal, 'lost on the page');
    assert.deepEqual(stack, [], 'and it is off the stack');
    d = one(terminal);
    assert.equal(closing([d], d, null), terminal, 'nothing focused at all');
    d = one(terminal);
    assert.equal(closing([d], d, d.confirm), terminal, 'still on its own button: a close that left the button on the page (StrictMode)');
    d = one(terminal);
    assert.equal(closing([d], d, elsewhere), null, 'taken on purpose meanwhile: left there');

    for (const [what, returnTo] of [['gone from the page', gone], ['the page itself', body], ['nothing', null]]) {
      d = one(returnTo);
      assert.equal(closing([d], d, body), 'fallback', `what had it: ${what}`);
    }

    d = one(terminal);
    const other = one(terminal);
    stack = [other];
    assert.equal(closing(stack, d, body), null, 'not on the stack: closed already');
    assert.deepEqual(stack, [other], 'and the stack is left alone');
  });

  test('CD-27: two open — the top one gives the keyboard back into the one beneath; the one beneath closing first hands what it would have given back to the one on top', () => {
    const save = element('Save');
    const saveBox = [element("Don't Save"), element('Cancel'), save];
    const overwrite = element('Overwrite');
    const overwriteBox = [element('Use Disk Version'), element('Cancel'), overwrite];

    // "Save a.js?" asked over the terminal; Save ran into a change on disk.
    let beneath = openDialog(terminal, saveBox);
    let top = openDialog(save, overwriteBox);
    let stack = [beneath, top];
    assert.equal(closing(stack, top, body), save, 'back on the button beneath that had it');
    assert.deepEqual(stack, [beneath]);
    assert.equal(closing(stack, beneath, body), terminal, 'and from there to the terminal');

    // What the top one took it from left the page: the confirm beneath.
    beneath = openDialog(terminal, saveBox);
    top = openDialog(gone, overwriteBox);
    stack = [beneath, top];
    assert.equal(closing(stack, top, body), save);

    // The question beneath withdrawn first, the one on top staying.
    beneath = openDialog(terminal, saveBox);
    top = openDialog(save, overwriteBox);
    stack = [beneath, top];
    assert.equal(closing(stack, beneath, overwrite), null, 'the keyboard stays in the dialog on top');
    assert.deepEqual(stack, [top]);
    assert.equal(top.returnTo, terminal, 'its button beneath is going: it gives back what that dialog would have');
    assert.equal(closing(stack, top, body), terminal);
  });
});

// ---- As drawn ------------------------------------------------------------------

/** The buttons in the markup, in order: [label (✕ by its title), classes]. */
const drawnButtons = (html) =>
  [...html.matchAll(/<button type="button"(?: title="([^"]*)")? class="([^"]*)"[^>]*>(.*?)<\/button>/g)].map(
    ([, title, cls, inner]) => [title || inner, cls.split(/\s+/)]
  );

describe('ConfirmDialog: as drawn', () => {
  beforeEach(loadUi);

  test('CD-18: an alertdialog with the caller\'s title, message and buttons — ✕, the third choice, Cancel, then the confirm; danger in red — and nothing when closed', () => {
    const html = renderToString(h(ui.ConfirmDialog, fileChangedOnDisk([])));
    assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title"/);
    assert.match(html, /<h2 id="confirm-dialog-title"[^>]*>File Changed on Disk<\/h2>/);
    assert.ok(html.includes('has changed on disk since you opened it'), 'the message');
    const buttons = drawnButtons(html);
    assert.deepEqual(buttons.map(([label]) => label), ['Close', 'Use Disk Version', 'Cancel', 'Overwrite']);
    assert.ok(buttons[3][1].includes('bg-vsc-error'), 'a danger confirm is red');
    assert.ok(buttons[1][1].includes('text-vsc-fg'), 'a plain third choice is not');

    const save = drawnButtons(renderToString(h(ui.ConfirmDialog, saveBeforeClose([]))));
    assert.deepEqual(save.map(([label]) => label), ['Close', "Don&#x27;t Save", 'Cancel', 'Save']);
    assert.ok(save[1][1].includes('text-vsc-error'), "altDanger: Don't Save in red");
    assert.ok(save[3][1].includes('bg-vsc-accent'), 'Save in the accent colour');

    const plain = drawnButtons(renderToString(h(ui.ConfirmDialog, { open: true, title: 'T', message: 'M' })));
    assert.deepEqual(plain.map(([label]) => label), ['Close', 'Cancel', 'OK'], 'the default labels');

    assert.equal(renderToString(h(ui.ConfirmDialog, deleteFolder([], 'x', { open: false }))), '');
  });
});
