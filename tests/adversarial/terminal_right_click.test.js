/**
 * A right-click copies or pastes, Windows Terminal's way (src/lib/terminalRightClick.js).
 *
 * Claude Code 2.1.289 leaves right-click paste to a terminal that names itself
 * xterm.js, as NexTerm does through XTVERSION — so from v0.9.0 a right-click in
 * its full-screen view did nothing on Windows. These cases hold the decision
 * table, the clipboard as the backend answers it, the paste through xterm, and
 * the binding: that a handled right-click never reaches xterm (no mouse report
 * to a program tracking the mouse, no word selected, no context menu) and that
 * Shift+right-click reaches it whole.
 *
 * The terminal is real xterm where Node can have it: `@xterm/headless` — the
 * same core as the app's `@xterm/xterm` — parses what a program sends
 * (bracketed paste, mouse tracking, the alternate screen), encodes the mouse
 * reports, and carries the app's own mouse-reporting gate and copy-on-select
 * binding exactly as terminalRegistry.js installs them. Headless has no
 * browser half, so its listeners on the page, its selection, focus and
 * `paste` are restated here from xterm 6's source; the headless-browser file
 * (terminal_right_click_headless.test.js) runs the real ones under real mouse
 * events.
 */
import { readFileSync } from 'node:fs';
// Static, as in program_notifications.test.js: other files in this runner
// register module hooks that turn `@xterm/*` into test doubles.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  RIGHT_CLICK_BEHAVIORS,
  defaultRightClick,
  installTerminalRightClick,
  pasteClipboard,
  readClipboard,
  rightClickAction,
  terminalRightClickFor,
} from '../../src/lib/terminalRightClick.js';
import { currentPlatform, installTerminalClipboard } from '../../src/lib/terminalClipboard.js';
import { installHangulInlineIme } from '../../src/lib/hangulInlineIme.js';
import { SETTINGS_DEFAULTS, useSettingsStore } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const { Terminal } = headless;

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
/** A full-screen program asking for SGR mouse reports and bracketed paste, as OpenCode and vim do. */
const FULL_SCREEN = `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h`;
/** What Claude Code sends at its prompt: tracking on the NORMAL screen, which the app holds back. */
const CLAUDE_PROMPT = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?2004h`;
const SGR_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]/;

// ---- a page that dispatches like a browser -----------------------------------

/** A DOM node: listeners, a parent, and nothing else. */
class FakeNode {
  constructor(name, parent = null) {
    this.name = name;
    this.parentNode = parent;
    this.listeners = [];
  }
  addEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
  get listenerCount() {
    return this.listeners.length;
  }
}

/**
 * Dispatch as a browser does: capture from the window down to the target's
 * parent, the target itself, then bubbling back up — `stopPropagation`,
 * `stopImmediatePropagation` and `preventDefault` honoured. Returns the event.
 */
function dispatch(target, fields) {
  const event = { button: 0, buttons: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...fields };
  const path = [];
  for (let node = target; node; node = node.parentNode) path.unshift(node);
  let stopped = false;
  let immediate = false;
  event.target = target;
  event.defaultPrevented = false;
  event.preventDefault = () => {
    event.defaultPrevented = true;
  };
  event.stopPropagation = () => {
    stopped = true;
  };
  event.stopImmediatePropagation = () => {
    stopped = true;
    immediate = true;
  };
  const run = (node, phase) => {
    for (const l of [...node.listeners]) {
      if (l.type !== event.type) continue;
      if (phase === 'capture' && !l.capture) continue;
      if (phase === 'bubble' && l.capture) continue;
      l.fn(event);
      if (immediate) return;
    }
  };
  for (const node of path.slice(0, -1)) {
    run(node, 'capture');
    if (stopped) return event;
  }
  run(target, 'target');
  if (stopped) return event;
  for (const node of path.slice(0, -1).reverse()) {
    run(node, 'bubble');
    if (stopped) return event;
  }
  return event;
}

/**
 * A terminal on a page. The core is real xterm; the page around it, and what
 * xterm's browser half does with a mouse event that reaches its element, are
 * restated from xterm 6 (CoreBrowserTerminal, SelectionService, Linkifier,
 * Clipboard.ts):
 *
 *   - mousedown on its element: cancelled, the textarea focused, and — while
 *     a program tracks the mouse and no modifier forces selection (Shift off
 *     macOS, ⌥ with `macOptionClickForcesSelection` on it) — reported, with
 *     the release then reported from the document;
 *   - contextmenu on its element: `rightClickHandler`, which readies the
 *     webview's menu (and selects the word under the pointer on macOS);
 *   - mousedown/mouseup on its screen: the link provider, which opens a link
 *     on ANY button's release;
 *   - copy on its element: the selection, when there is one;
 *   - `paste`: `\r?\n` to `\r`, bracketed while the program asked, sent as
 *     user input.
 *
 * `settings` is a plain object read through a store's `getState`.
 */
function page({ platform = 'windows', settings = { terminalRightClick: 'copyPaste' }, ime = false, findOpen = false, clipboard = { text: 'echo pasted', image: false } } = {}) {
  const mac = platform === 'mac';
  const view = new FakeNode('window');
  const document = new FakeNode('document', view);
  const body = new FakeNode('body', document);
  const container = new FakeNode('container', body);
  const element = new FakeNode('xterm', container);
  const screen = new FakeNode('xterm-screen', element);
  const textarea = new FakeNode('textarea', element);
  textarea.value = '';
  textarea.selectionStart = 0;
  textarea.selectionEnd = 0;
  document.defaultView = view;
  container.ownerDocument = document;
  document.activeElement = body;

  const core = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const sent = [];
  core.onData((data) => sent.push(data));
  const seen = [];
  const system = { clipboard: '', reads: 0 };
  const store = { getState: () => settings };

  const term = {
    core,
    textarea,
    element,
    selection: null,
    addons: [],
    get parser() {
      return core.parser;
    },
    get buffer() {
      return core.buffer;
    },
    get modes() {
      return core.modes;
    },
    get rows() {
      return core.rows;
    },
    get options() {
      return core.options;
    },
    get _core() {
      return core._core;
    },
    onWriteParsed: (fn) => core.onWriteParsed(fn),
    loadAddon(addon) {
      this.addons.push(addon);
      addon.activate(this);
    },
    dispose() {
      for (const addon of this.addons) addon.dispose();
    },
    input: (data, wasUserInput) => core.input(data, wasUserInput),
    focus() {
      document.activeElement = textarea;
    },
    /** `term.select` stood in for: absolute buffer rows, 0-based, as xterm 6 reports them. */
    select(text, row = core.buffer.active.viewportY) {
      this.selection = { text, startY: row, endY: row };
    },
    hasSelection() {
      return Boolean(this.selection);
    },
    getSelection() {
      return this.selection?.text ?? '';
    },
    getSelectionPosition() {
      const s = this.selection;
      return s ? { start: { x: 0, y: s.startY }, end: { x: s.text.length, y: s.endY } } : undefined;
    },
    clearSelection() {
      this.selection = null;
    },
    paste(data) {
      let text = data.replace(/\r?\n/g, '\r');
      if (core.modes.bracketedPasteMode) text = `${PASTE_START}${text}${PASTE_END}`;
      core.input(text, true);
    },
  };

  // ---- xterm's browser half, as far as a mouse event is concerned ----
  const forcesSelection = (e) =>
    mac ? Boolean(e.altKey && core.options.macOptionClickForcesSelection) : Boolean(e.shiftKey);
  const report = (e, action) =>
    core._core.coreMouseService.triggerMouseEvent({
      col: 4,
      row: 2,
      x: 0,
      y: 0,
      button: e.button,
      action,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
    });
  element.addEventListener('mousedown', (e) => {
    seen.push(`mousedown:${e.button}`);
    e.preventDefault();
    term.focus();
    if (!core._core.coreMouseService.areMouseEventsActive || forcesSelection(e)) return;
    report(e, 1);
    const release = (up) => {
      report(up, 0);
      document.removeEventListener('mouseup', release);
    };
    document.addEventListener('mouseup', release);
  });
  element.addEventListener('contextmenu', (e) => {
    seen.push(`contextmenu:${e.button}`);
  });
  element.addEventListener('auxclick', (e) => {
    seen.push(`auxclick:${e.button}`);
  });
  element.addEventListener('copy', (e) => {
    if (!term.hasSelection()) return;
    e.clipboardData.setData('text/plain', term.getSelection());
    e.preventDefault();
  });
  screen.addEventListener('mousedown', (e) => seen.push(`link:mousedown:${e.button}`));
  screen.addEventListener('mouseup', (e) => seen.push(`link:mouseup:${e.button}`));

  // The webview's copy command: a copy event at the focused element.
  document.execCommand = (command) => {
    if (command !== 'copy') return false;
    const data = {};
    const event = dispatch(document.activeElement, {
      type: 'copy',
      clipboardData: { setData: (k, v) => (data[k] = v), getData: (k) => data[k] ?? '' },
    });
    if (event.defaultPrevented) system.clipboard = data['text/plain'];
    return true;
  };

  // ---- the app's own bindings, in the order terminalRegistry.js installs them ----
  if (ime) installHangulInlineIme(term, container, { mac: true });
  installTerminalClipboard(term, container, {
    platform,
    settings: { getState: () => ({ terminalCopyOnSelect: false, terminalMouseReporting: true }), subscribe: () => () => {} },
  });
  const binding = installTerminalRightClick(term, container, {
    settings: store,
    platform,
    isFindOpen: typeof findOpen === 'function' ? findOpen : () => findOpen,
    read: async () => {
      system.reads += 1;
      return { ...clipboard };
    },
  });

  const write = (data) => new Promise((resolve) => core.write(data, resolve));
  /** One whole right-click on the screen, in the order the platform fires it. */
  const rightClick = (mods = {}) => {
    const events = {};
    events.down = dispatch(screen, { type: 'mousedown', button: 2, buttons: 2, ...mods });
    if (platform !== 'windows') events.menu = dispatch(screen, { type: 'contextmenu', button: 2, ...mods });
    events.up = dispatch(screen, { type: 'mouseup', button: 2, buttons: 0, ...mods });
    events.aux = dispatch(screen, { type: 'auxclick', button: 2, ...mods });
    if (platform === 'windows') events.menu = dispatch(screen, { type: 'contextmenu', button: 2, ...mods });
    return events;
  };
  /** Whatever the right-click started has landed. */
  const settled = async () => {
    await binding.pasting;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { term, core, view, document, container, element, screen, textarea, sent, seen, system, binding, settings, write, rightClick, settled, dispatch };
}

const everyPartCancelled = (events) => ['down', 'up', 'aux', 'menu'].every((k) => events[k].defaultPrevented);

// ---- the decisions --------------------------------------------------------------

describe('Right-click: what a press does (pure)', () => {
  test('RC-01: copyPaste copies a selection or pastes; Shift, another button or any other setting leaves it alone', () => {
    const press = (fields) => ({ button: 2, shiftKey: false, ...fields });
    assert.deepEqual(rightClickAction(press(), { behavior: 'copyPaste', hasSelection: false }), { action: 'paste' });
    assert.deepEqual(rightClickAction(press(), { behavior: 'copyPaste', hasSelection: true }), { action: 'copy' });
    for (const hasSelection of [false, true]) {
      assert.deepEqual(
        rightClickAction(press({ shiftKey: true }), { behavior: 'copyPaste', hasSelection }),
        { action: 'pass' },
        `Shift is the way to the program (selected: ${hasSelection})`
      );
      for (const behavior of ['default', undefined, 'paste', 'nothing', '']) {
        assert.deepEqual(rightClickAction(press(), { behavior, hasSelection }), { action: 'pass' }, `setting ${behavior}`);
      }
      for (const button of [0, 1, 3, 4, undefined]) {
        assert.deepEqual(rightClickAction(press({ button }), { behavior: 'copyPaste', hasSelection }), { action: 'pass' }, `button ${button}`);
      }
      // Ctrl, Alt or ⌘ change nothing: only Shift is the escape hatch.
      for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
        assert.equal(rightClickAction(press({ [mod]: true }), { behavior: 'copyPaste', hasSelection }).action, hasSelection ? 'copy' : 'paste', mod);
      }
    }
    assert.deepEqual(rightClickAction(null, { behavior: 'copyPaste' }), { action: 'pass' });
    assert.deepEqual(rightClickAction(press()), { action: 'pass' }, 'no setting given: the untouched behaviour');
  });

  test('RC-02: the default is copyPaste on Windows only — and it is what the settings store starts from here', () => {
    assert.equal(defaultRightClick('windows'), 'copyPaste');
    assert.equal(defaultRightClick('mac'), 'default');
    assert.equal(defaultRightClick('linux'), 'default');
    assert.deepEqual([...RIGHT_CLICK_BEHAVIORS], ['copyPaste', 'default']);
    // Whatever platform this suite runs on (Node 20 has no `navigator`, so it
    // reads as Linux there): the store's default is that platform's.
    assert.equal(SETTINGS_DEFAULTS.terminalRightClick, defaultRightClick(currentPlatform()));
    assert.equal(useSettingsStore.getState().settingsDefaults.terminalRightClick, defaultRightClick(currentPlatform()));
    // And it is decided there, not written down: a literal 'default' would
    // pass everywhere but Windows, the one platform it is for.
    const store = readFileSync(new URL('../../src/stores/settingsStore.js', import.meta.url), 'utf8');
    assert.match(store, /^ {2}terminalRightClick: defaultRightClick\(\),$/m);
  });
});

// ---- the clipboard ----------------------------------------------------------------

describe('Right-click: the clipboard, as the backend answers it', () => {
  test('RC-03: readClipboard reads `clipboard_read` — the browser mock answers from `mockBridge.clipboard`', async () => {
    const saved = mockBridge.clipboard;
    try {
      mockBridge.clipboard = { text: 'git status\n', has_image: false };
      assert.deepEqual(await mockBridge.invoke('clipboard_read'), { text: 'git status\n', has_image: false });
      assert.deepEqual(await readClipboard(), { text: 'git status\n', image: false }, 'through ipc.js, in browser mode');
      mockBridge.clipboard = { text: '', has_image: true };
      assert.deepEqual(await readClipboard(), { text: '', image: true }, 'an image alone');
      mockBridge.clipboard = { text: 42, has_image: 'yes' };
      assert.deepEqual(await readClipboard(), { text: '', image: false }, 'nothing malformed is trusted');
      mockBridge.clipboard = null;
      assert.deepEqual(await mockBridge.invoke('clipboard_read'), { text: '', has_image: false }, 'an empty clipboard');
    } finally {
      mockBridge.clipboard = saved;
    }
    // What the real backend sends, handed straight in.
    const asked = [];
    const call = async (command) => {
      asked.push(command);
      return { text: 'a', has_image: true };
    };
    assert.deepEqual(await readClipboard({ invoke: call }), { text: 'a', image: true });
    assert.deepEqual(asked, ['clipboard_read']);
    for (const answer of [{ text: 42, has_image: 'yes' }, { text: null, has_image: 1 }, null, 'text']) {
      assert.deepEqual(
        await readClipboard({ invoke: async () => answer }),
        { text: '', image: false },
        `an answer of the wrong shape is no clipboard: ${JSON.stringify(answer)}`
      );
    }
    await assert.rejects(() => readClipboard({ invoke: async () => Promise.reject(new Error('occupied')) }), /occupied/);
  });

  test('RC-04: text goes through xterm\'s paste — bracketed only once the program asked, line breaks as Enter', async () => {
    const { term, sent, write } = page();
    assert.equal(pasteClipboard(term, { text: 'ls\n-la\r\nx' }), 'text');
    assert.deepEqual(sent, ['ls\r-la\rx'], 'a shell that did not ask: the text, with `\\n` sent as `\\r`');
    await write(`${ESC}[?2004h`);
    sent.length = 0;
    assert.equal(pasteClipboard(term, { text: 'two\nlines' }), 'text');
    assert.deepEqual(sent, [`${PASTE_START}two\rlines${PASTE_END}`], 'bracketed, so it is not run line by line');
    sent.length = 0;
    assert.equal(pasteClipboard(term, { text: 'text wins', image: true }), 'text', 'text and an image: the text');
    assert.deepEqual(sent, [`${PASTE_START}text wins${PASTE_END}`]);
    await write(`${ESC}[?2004l`);
    sent.length = 0;
    pasteClipboard(term, { text: 'plain again' });
    assert.deepEqual(sent, ['plain again'], 'and plain once it turned bracketed paste off');
  });

  test('RC-05: an image alone is an EMPTY bracketed paste — what Ctrl+V sends, and what OpenCode reads as "attach the image"', async () => {
    const { term, sent, write } = page();
    await write(FULL_SCREEN);
    assert.equal(term.modes.bracketedPasteMode, true);
    assert.equal(pasteClipboard(term, { text: '', image: true }), 'image');
    assert.deepEqual(sent, [`${PASTE_START}${PASTE_END}`]);

    sent.length = 0;
    await write(`${ESC}[?2004l`);
    assert.equal(pasteClipboard(term, { text: '', image: true }), 'nothing', 'to a program that never asked, nothing at all');
    assert.equal(pasteClipboard(term, { text: '', image: false }), 'nothing', 'an empty clipboard');
    assert.equal(pasteClipboard(term, {}), 'nothing');
    assert.deepEqual(sent, [], 'not one byte — not even an unbracketed empty paste');
  });

  test('RC-06: the backend command is registered, reads text without decoding images, and answers in the shape read here', () => {
    const main = readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::clipboard::clipboard_read,'), 'in generate_handler!');
    const mod = readFileSync(new URL('../../src-tauri/src/commands/mod.rs', import.meta.url), 'utf8');
    assert.match(mod, /^pub mod clipboard;$/m);
    const command = readFileSync(new URL('../../src-tauri/src/commands/clipboard.rs', import.meta.url), 'utf8');
    assert.match(
      command,
      /#\[tauri::command\(async, rename_all = "snake_case"\)\]\s*pub fn clipboard_read\(\) -> Result<ClipboardContents, String>/,
      'off the event loop: Windows makes a clipboard read wait for whoever has it open'
    );
    assert.match(command, /pub text: String,/);
    assert.match(command, /pub has_image: bool,/);
    const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');
    assert.match(cargo, /^arboard = \{ version = "3\.6", default-features = false \}$/m, 'no image-data: nothing is decoded to say an image is there');
  });
});

// ---- the binding -------------------------------------------------------------------

describe('Right-click: the binding, on a page that dispatches like a browser', () => {
  test('RC-07: at a prompt, a right-click pastes — and xterm hears nothing: no press, no release, no menu, no link', async () => {
    for (const platform of ['windows', 'linux', 'mac']) {
      const p = page({ platform });
      const events = p.rightClick();
      await p.settled();
      assert.deepEqual(p.seen, [], `${platform}: nothing reached xterm's element or its screen`);
      assert.ok(everyPartCancelled(events), `${platform}: every part cancelled — no webview menu, no focus change`);
      assert.deepEqual(p.sent, ['echo pasted'], `${platform}: the clipboard's text, once`);
      assert.equal(p.system.reads, 1);
      assert.equal(p.document.activeElement, p.textarea, `${platform}: focused, as xterm's own press would have`);
    }
  });

  test('RC-08: inside a full-screen program that tracks the mouse, not a single report byte — the paste, bracketed', async () => {
    for (const platform of ['windows', 'mac']) {
      const p = page({ platform });
      await p.write(FULL_SCREEN);
      assert.equal(p.term.modes.mouseTrackingMode, 'vt200', 'the program has the mouse');
      p.rightClick();
      await p.settled();
      assert.deepEqual(p.sent, [`${PASTE_START}echo pasted${PASTE_END}`], `${platform}: the paste, and nothing else`);
      assert.ok(!p.sent.some((d) => SGR_REPORT.test(d)), `${platform}: no mouse report`);
      assert.deepEqual(p.seen, []);

      // The control: the same right-click with the setting at 'default'
      // reaches xterm, which reports it to the program — real xterm's bytes.
      p.settings.terminalRightClick = 'default';
      p.sent.length = 0;
      p.rightClick();
      await p.settled();
      assert.match(p.sent.join(''), /^\x1b\[<2;5;3M\x1b\[<2;5;3m$/, `${platform}: press and release reported, as before`);
      assert.equal(p.system.reads, 1, 'and the clipboard was not read for it');
    }
  });

  test('RC-09: Claude Code\'s prompt (tracking asked for on the normal screen) and the alternate screen without tracking — the same paste', async () => {
    const p = page();
    await p.write(CLAUDE_PROMPT);
    assert.equal(p.term.modes.mouseTrackingMode, 'none', 'held back by the app on the normal screen');
    p.rightClick();
    await p.settled();
    assert.deepEqual(p.sent, [`${PASTE_START}echo pasted${PASTE_END}`]);

    const q = page();
    await q.write(`${ESC}[?1049h`);
    q.rightClick();
    await q.settled();
    assert.deepEqual(q.sent, ['echo pasted'], 'a full-screen program that asked for neither');
    assert.deepEqual([...p.seen, ...q.seen], []);
  });

  test('RC-10: with a selection on screen, a right-click copies it through xterm\'s copy event and clears it — nothing pasted', async () => {
    for (const tracking of [false, true]) {
      const p = page();
      if (tracking) await p.write(FULL_SCREEN);
      p.term.select('selected output');
      const events = p.rightClick();
      await p.settled();
      assert.equal(p.system.clipboard, 'selected output', `tracking ${tracking}: on the clipboard`);
      assert.equal(p.term.hasSelection(), false, 'cleared, as Windows Terminal clears it — the next right-click pastes');
      assert.deepEqual(p.sent, [], 'nothing pasted, nothing reported');
      assert.equal(p.system.reads, 0, 'the clipboard not even read');
      assert.deepEqual(p.seen, []);
      assert.ok(everyPartCancelled(events));

      p.rightClick();
      await p.settled();
      assert.deepEqual(p.sent, [tracking ? `${PASTE_START}echo pasted${PASTE_END}` : 'echo pasted'], 'and the next one pastes');
    }
  });

  test('RC-11: a selection the user cannot see, or the find bar\'s match, is not one to copy — the right-click pastes', async () => {
    const p = page();
    let lines = '';
    for (let i = 0; i < 100; i += 1) lines += `line ${i}\r\n`;
    await p.write(lines);
    assert.ok(p.core.buffer.active.viewportY > 0, 'scrolled: the top rows are off screen');
    p.term.select('line 0', 0);
    p.rightClick();
    await p.settled();
    assert.deepEqual(p.sent, ['echo pasted'], 'off screen: pasted');
    assert.equal(p.system.clipboard, '', 'and not copied');

    const f = page({ findOpen: true });
    f.term.select('the match');
    f.rightClick();
    await f.settled();
    assert.deepEqual(f.sent, ['echo pasted'], 'the find bar\'s highlighted match: pasted');
    assert.equal(f.system.clipboard, '', 'and not copied');
  });

  test('RC-12: Shift+right-click reaches xterm whole — press, menu, release, auxclick, and the report where xterm makes one', async () => {
    for (const platform of ['windows', 'mac']) {
      const p = page({ platform });
      await p.write(FULL_SCREEN);
      p.term.select('kept');
      const events = p.rightClick({ shiftKey: true });
      await p.settled();
      assert.deepEqual(
        [...p.seen].sort(),
        ['auxclick:2', 'contextmenu:2', 'link:mousedown:2', 'link:mouseup:2', 'mousedown:2'].sort(),
        `${platform}: every part reached xterm's element and screen`
      );
      assert.equal(events.menu.defaultPrevented, false, `${platform}: the webview's menu opens, as before`);
      assert.equal(events.up.defaultPrevented, false);
      assert.equal(p.system.reads, 0, 'nothing read');
      assert.equal(p.system.clipboard, '', 'nothing copied');
      assert.equal(p.term.getSelection(), 'kept', 'the selection left alone');
      if (platform === 'mac') {
        // xterm's own rule on macOS: Shift does not force selection, so the
        // program gets the click — Shift in its modifier bits (2 + 4).
        assert.match(p.sent.join(''), /^\x1b\[<6;5;3M\x1b\[<6;5;3m$/, 'reported to the program');
      } else {
        // Off macOS xterm itself never reports a Shift-click: Shift is its
        // "select instead" key. Untouched means exactly that.
        assert.deepEqual(p.sent, [], 'xterm\'s rule, not this binding\'s');
      }
    }
  });

  test('RC-13: the setting is read at every press — and \'default\' is exactly as if the binding were not there', async () => {
    const p = page({ settings: { terminalRightClick: 'default' } });
    const events = p.rightClick();
    await p.settled();
    assert.deepEqual([...p.seen].sort(), ['auxclick:2', 'contextmenu:2', 'link:mousedown:2', 'link:mouseup:2', 'mousedown:2'].sort());
    assert.equal(events.menu.defaultPrevented, false);
    assert.deepEqual(p.sent, []);
    assert.equal(p.system.reads, 0);

    p.settings.terminalRightClick = 'copyPaste';
    p.seen.length = 0;
    p.rightClick();
    await p.settled();
    assert.deepEqual(p.sent, ['echo pasted'], 'switched on: the very next right-click pastes');
    assert.deepEqual(p.seen, []);

    const absent = page({ settings: {}, platform: 'windows' });
    absent.rightClick();
    await absent.settled();
    assert.deepEqual(absent.sent, ['echo pasted'], 'no saved value on Windows: its default, copyPaste');
    const absentMac = page({ settings: {}, platform: 'mac' });
    absentMac.rightClick();
    await absentMac.settled();
    assert.deepEqual(absentMac.sent, [], 'and on macOS, default');
  });

  test('RC-14: only its own gesture is stopped — the left button, the middle one and a later keyboard menu are xterm\'s', async () => {
    const p = page();
    for (const button of [0, 1]) {
      dispatch(p.screen, { type: 'mousedown', button });
      dispatch(p.screen, { type: 'mouseup', button });
      dispatch(p.screen, { type: 'auxclick', button });
    }
    assert.deepEqual(
      [...p.seen].sort(),
      ['auxclick:0', 'auxclick:1', 'link:mousedown:0', 'link:mousedown:1', 'link:mouseup:0', 'link:mouseup:1', 'mousedown:0', 'mousedown:1'],
      'the left and middle buttons reach xterm, every part of them'
    );
    assert.equal(p.system.reads, 0);
    p.seen.length = 0;

    p.rightClick();
    await p.settled();
    assert.deepEqual(p.seen, []);
    // The context-menu key, or Shift+F10, after the gesture is over.
    const keyboardMenu = dispatch(p.textarea, { type: 'contextmenu', button: 0 });
    assert.deepEqual(p.seen, ['contextmenu:0'], 'a menu asked for from the keyboard is not this binding\'s');
    assert.equal(keyboardMenu.defaultPrevented, false);
    // A release with no press of its own (the press landed elsewhere).
    dispatch(p.screen, { type: 'mousedown', button: 0 });
    p.seen.length = 0;
    dispatch(p.screen, { type: 'mouseup', button: 2 });
    assert.deepEqual(p.seen, ['link:mouseup:2'], 'not claimed: it was not this binding\'s press');

    // A handled press whose context menu an engine reports as button 0: still
    // the press's own menu, and cancelled with it.
    const q = page({ platform: 'mac' });
    dispatch(q.screen, { type: 'mousedown', button: 2, buttons: 2 });
    const menu = dispatch(q.screen, { type: 'contextmenu', button: 0 });
    assert.equal(menu.defaultPrevented, true, 'no webview menu after a paste');
    assert.deepEqual(q.seen, []);

    // A handled press released outside the terminal leaves its release
    // unclaimed; the next press — a left click — starts afresh, so a later
    // right button let go over the terminal, pressed elsewhere, is xterm's.
    const r = page();
    dispatch(r.screen, { type: 'mousedown', button: 2, buttons: 2 });
    dispatch(r.document, { type: 'mouseup', button: 2 });
    dispatch(r.screen, { type: 'mousedown', button: 0 });
    dispatch(r.screen, { type: 'mouseup', button: 0 });
    dispatch(r.document, { type: 'mousedown', button: 2, buttons: 2 });
    r.seen.length = 0;
    dispatch(r.screen, { type: 'mouseup', button: 2 });
    assert.deepEqual(r.seen, ['link:mouseup:2'], 'the old gesture is over: this release is not its');
  });

  test('RC-15: a Korean syllable still being composed (macOS) goes to the program before the paste', async () => {
    const p = page({ platform: 'mac', ime: true });
    p.textarea.value = '한';
    p.textarea.selectionStart = 1;
    p.textarea.selectionEnd = 1;
    dispatch(p.textarea, { type: 'input', inputType: 'insertText', data: '한', isComposing: false });
    assert.deepEqual(p.sent, [], 'held by the IME binding, not yet sent');
    p.rightClick();
    await p.settled();
    assert.deepEqual(p.sent, ['한', 'echo pasted'], 'the syllable first, then the paste');
  });

  test('RC-16: a failure is contained — a broken setting leaves the click to xterm, a failed read pastes nothing, and the next one still works', async () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const broken = page({ settings: null });
      broken.binding._behavior = () => {
        throw new Error('the store is gone');
      };
      const events = broken.rightClick();
      await broken.settled();
      assert.ok(broken.seen.includes('mousedown:2') && broken.seen.includes('contextmenu:2'), 'the click went to xterm, as before');
      assert.equal(events.menu.defaultPrevented, false);
      assert.ok(warnings.some((w) => w.includes('the store is gone')), 'and said why, once');

      let fail = true;
      const p = page();
      p.binding._read = async () => {
        if (fail) throw new Error('clipboard occupied');
        return { text: 'second try', image: false };
      };
      p.rightClick();
      await p.settled();
      assert.deepEqual(p.sent, [], 'nothing pasted');
      assert.deepEqual(p.seen, [], 'and nothing leaked to xterm either: the click was claimed');
      assert.ok(warnings.some((w) => w.includes('clipboard occupied')));
      fail = false;
      p.rightClick();
      await p.settled();
      assert.deepEqual(p.sent, ['second try'], 'the next right-click reads again');

      const f = page({
        findOpen: () => {
          throw new Error('no store yet');
        },
      });
      f.term.select('copied anyway');
      f.rightClick();
      await f.settled();
      assert.equal(f.system.clipboard, 'copied anyway', 'a find bar that cannot be asked counts as closed');

      const q = page();
      q.term.focus = () => {
        throw new Error('no textarea');
      };
      q.rightClick();
      await q.settled();
      assert.deepEqual(q.sent, ['echo pasted'], 'a focus that fails does not cost the paste');
    } finally {
      console.warn = warn;
    }
  });

  test('RC-17: one binding per terminal; disposed, every listener goes and a paste still in flight is dropped', async () => {
    const p = page();
    assert.equal(installTerminalRightClick(p.term, p.container), p.binding, 'installed once');
    assert.equal(terminalRightClickFor(p.term), p.binding);
    assert.equal(installTerminalRightClick(null, p.container), null);
    assert.equal(installTerminalRightClick(p.term, null), null, 'no container, nothing to listen on');

    let release;
    p.binding._read = () => new Promise((resolve) => {
      release = resolve;
    });
    const before = { container: p.container.listenerCount, view: p.view.listenerCount };
    p.rightClick();
    p.term.dispose();
    release({ text: 'too late', image: false });
    await p.settled();
    assert.deepEqual(p.sent, [], 'disposed before the clipboard answered: nothing sent');
    assert.ok(p.container.listenerCount < before.container && p.view.listenerCount < before.view, 'listeners removed');
    p.seen.length = 0;
    p.rightClick();
    assert.ok(p.seen.includes('mousedown:2'), 'a disposed binding stops nothing');
  });

  test('RC-18: every terminal gets it, after the clipboard binding, with the store and a find bar of its own tab', () => {
    // The registry's own call, cut from terminalRegistry.js and run with what
    // it closes over handed in — as PN-49 runs the notifications call.
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    const start = src.indexOf('installTerminalRightClick(term, container, {');
    const end = src.indexOf('});', start) + 3;
    assert.ok(start > 0 && end > start, 'getOrCreateTerminal installs it on every terminal');
    assert.ok(src.indexOf('installHangulInlineIme(term, container);') < start, 'after the IME');
    assert.ok(src.indexOf('installTerminalClipboard(term, container, { settings: useSettingsStore });') < start, 'after copy on select and mouse reporting');
    assert.ok(src.indexOf('term.open(container);') < start, 'after open');

    let installed = null;
    const store = { find: { open: false, tabId: null } };
    const run = new Function('installTerminalRightClick', 'term', 'container', 'tabId', 'useSettingsStore', 'useTerminalStore', src.slice(start, end));
    const settingsStore = { getState: () => ({}) };
    run(
      (t, c, options) => {
        installed = { t, c, options };
      },
      'the-term',
      'the-container',
      'tab-7',
      settingsStore,
      { getState: () => store }
    );
    assert.equal(installed.t, 'the-term');
    assert.equal(installed.c, 'the-container');
    assert.equal(installed.options.settings, settingsStore, 'the settings store, read at every press');
    assert.equal(installed.options.isFindOpen(), false);
    store.find = { open: true, tabId: 'tab-other' };
    assert.equal(installed.options.isFindOpen(), false, 'a find bar over another terminal is not this one\'s');
    store.find = { open: true, tabId: 'tab-7' };
    assert.equal(installed.options.isFindOpen(), true);
  });

  test('RC-19: a press the terminal keeps to itself still closes the app\'s popups — their outside-click listeners capture', () => {
    // A handled right-click stops at the terminal's container and never
    // bubbles to the window. A menu or popover that closes on "a click
    // anywhere else" has to hear it on the way down instead, as the menus'
    // own listeners always have.
    const files = [
      'src/components/common/ContextMenu.jsx',
      'src/components/layout/MenuBar.jsx',
      'src/components/layout/NotificationCenter.jsx',
    ];
    for (const file of files) {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const calls = [...src.matchAll(/window\.addEventListener\('mousedown', (\w+)(, true)?\)/g)];
      assert.ok(calls.length > 0, `${file} closes on an outside press`);
      for (const [call, handler, capture] of calls) {
        assert.ok(capture, `${file}: \`${call}\` listens in the bubble phase — a right-click in a terminal never reaches ${handler}`);
      }
    }
  });

  test('RC-20: teardown — the browser mock\'s clipboard is left empty for whatever runs next', () => {
    mockBridge.clipboard = { text: '', has_image: false };
    assert.deepEqual(mockBridge.clipboard, { text: '', has_image: false });
  });
});
