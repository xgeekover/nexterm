/**
 * A page written by hand that real React and react-dom can render into, for
 * the few cases that have to mount a component: what an effect, a listener or
 * focus does is out of reach of `renderToString`.
 *
 * The same idea as the page inside confirm_dialog.test.js, with what the
 * command palette needs on top: CSS selectors of the simple kind
 * (`[data-x="y"] .cls`, `textarea`), and the pointer arriving on a row.
 *
 * Typing into a field is not something it can do. react-dom is loaded before
 * any page exists (it reads `navigator` when it finds a DOM, which Node 20
 * lacks), so it takes text input to be IE's and listens for that, through
 * `attachEvent`. An input here has no `type`, so React leaves it alone.
 *
 * Nothing is installed process-wide: `onPage` makes `window` and `document`
 * this page for one case and puts back whatever was there after it.
 */
import ReactDOM from 'react-dom';
import ReactDOMClient from 'react-dom/client';
import { assert } from '../e2e/harness/testFramework.js';

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
  /** Elements below this one, document order, that match `selector`. */
  querySelectorAll(selector) {
    const chain = parseSelector(selector);
    const found = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 1 && matchesChain(c, chain)) found.push(c);
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
}

/**
 * `tag`, `.class`, `[attr]` and `[attr="value"]`, put together, and joined
 * by spaces for "somewhere inside". Anything else throws, so a component
 * that starts asking for more fails loudly instead of matching nothing.
 */
function parseSelector(selector) {
  return selector.trim().split(/\s+(?![^[]*\])/).map((part) => {
    const compound = { tag: null, classes: [], attrs: [] };
    const re = /^([a-z][a-z0-9-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gy;
    let rest = part;
    let m;
    re.lastIndex = 0;
    while (re.lastIndex < part.length && (m = re.exec(part))) {
      if (m[1]) compound.tag = m[1].toUpperCase();
      else if (m[2]) compound.classes.push(m[2]);
      else compound.attrs.push({ name: m[3], value: m[4] ?? null });
      rest = part.slice(re.lastIndex);
    }
    if (rest) throw new Error(`the test page does not understand the selector ${JSON.stringify(selector)}`);
    return compound;
  });
}

function matchesCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  const classes = (el.getAttribute('class') || '').split(/\s+/);
  if (!c.classes.every((cls) => classes.includes(cls))) return false;
  return c.attrs.every(({ name, value }) => el.hasAttribute(name) && (value === null || el.getAttribute(name) === value));
}

/** As in a browser, the ancestors a selector names may lie above where the search started. */
function matchesChain(el, chain) {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let n = el.parentNode; i >= 0 && n; n = n.parentNode) {
    if (n.nodeType === 1 && matchesCompound(n, chain[i])) i -= 1;
  }
  return i < 0;
}

/**
 * Dispatch as a browser does: capture from the window down to the target's
 * parent, the target's own listeners, then bubbling back up.
 * `stopPropagation` and `preventDefault` are honoured.
 */
export function dispatch(window, target, fields) {
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
    relatedTarget: null,
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

/** A page with an empty body and a React root ready to render into. */
export function makePage() {
  const document = new PageDocument();
  const window = Object.assign(new Target(), { document, HTMLIFrameElement: class {} });
  document.defaultView = window;
  const container = document.createElement('div');

  let root = null;
  const page = {
    window,
    document,
    /** Make an element, with attributes, inside `parent` (the body by default). */
    el(tag, attrs = {}, parent = document.body) {
      const node = document.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
      if (tag === 'textarea') Object.assign(node, { value: '', selectionStart: 0, selectionEnd: 0 });
      return parent.appendChild(node);
    },
    /** Render `element` in the root, effects and all, before returning. */
    render(element) {
      if (!container.parentNode) document.body.appendChild(container);
      root ??= ReactDOMClient.createRoot(container);
      ReactDOM.flushSync(() => root.render(element));
    },
    unmount() {
      root?.unmount();
      root = null;
    },
    /** Run `fn` and let React render whatever it set off before going on. */
    settled(fn) {
      let result;
      ReactDOM.flushSync(() => {
        result = fn();
      });
      return result;
    },
    /** A key going down where focus is. */
    keydown(key, fields = {}) {
      return page.settled(() => dispatch(window, document.activeElement, { type: 'keydown', key, ...fields }));
    },
    /**
     * The pointer arriving on `node` from outside it — React's `onMouseEnter`.
     * A pointer move is not a discrete event, so React renders what it set
     * off when it gets to it rather than at once: this waits for that.
     */
    async hover(node) {
      const event = dispatch(window, node, { type: 'mouseover', relatedTarget: null });
      await letItRun();
      return event;
    },
    click(node) {
      return page.settled(() => dispatch(window, node, { type: 'click', detail: 1 }));
    },
  };
  return page;
}

/** Long enough for React's scheduler, timers set for now and a few promise hops. */
export async function letItRun(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Run `fn` on a fresh page installed as `window` and `document`, then take it
 * down and put back whatever was there. React's warnings fail the case.
 */
export async function onPage(fn) {
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
