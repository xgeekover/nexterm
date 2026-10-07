/**
 * Copy and paste from the keyboard, per platform (src/lib/terminalClipboard.js).
 *
 * On Windows xterm turned Ctrl+V into ^V and Ctrl+C into ^C and cancelled
 * both, so WebView2 never pasted or copied — and in Claude Code ^V means
 * "paste an image". There is no Edit menu off macOS to fall back on. On macOS
 * ⌘C / ⌘V already work through the native Edit menu, and nothing here may add
 * a second path (a paste would arrive twice).
 *
 * TerminalView's custom key handler asks `handleClipboardKey` first; these
 * cases hold the table, the contract with xterm (false, and a paste NOT
 * cancelled so the browser performs it), the shortcuts NexTerm itself claims,
 * and the wiring.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { clipboardKeyAction, handleClipboardKey, hasVisibleSelection } from '../../src/lib/terminalClipboard.js';
import { findBinding, dispatchKeydownOverTerminal, DEFAULT_RESOLVED } from '../../src/lib/keybindings.js';

/** A keydown as the browser reports it on a US layout unless told otherwise. */
function key(spec, fields = {}) {
  const parts = spec.split('+');
  const name = parts.pop();
  const mods = new Set(parts);
  const letter = /^[a-z]$/i.test(name);
  const shift = mods.has('shift');
  return {
    type: 'keydown',
    key: letter ? (shift ? name.toUpperCase() : name.toLowerCase()) : name,
    code: letter ? `Key${name.toUpperCase()}` : name,
    keyCode: letter ? name.toUpperCase().charCodeAt(0) : name === 'Insert' ? 45 : 0,
    ctrlKey: mods.has('ctrl'),
    shiftKey: shift,
    altKey: mods.has('alt'),
    metaKey: mods.has('meta'),
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...fields,
  };
}

const act = (spec, platform, hasSelection = false, fields) =>
  clipboardKeyAction(key(spec, fields), { platform, hasSelection });

// Paste chords, and the ones nothing here claims: do not care whether
// anything is selected.
const TABLE = {
  //                    windows                       linux                          mac
  'ctrl+v': [{ action: 'paste' }, { action: 'pass' }, { action: 'pass' }],
  'ctrl+shift+v': [{ action: 'paste' }, { action: 'paste' }, { action: 'pass' }],
  'shift+Insert': [{ action: 'paste' }, { action: 'paste' }, { action: 'pass' }],
  'meta+v': [{ action: 'pass' }, { action: 'pass' }, { action: 'pass' }],
  'meta+c': [{ action: 'pass' }, { action: 'pass' }, { action: 'pass' }],
};

// Copy chords, selected: windows clears what it copies (so the NEXT Ctrl+C
// can interrupt again), linux and mac do not.
const COPY_TABLE = {
  'ctrl+shift+c': [{ action: 'copy', clearSelection: true }, { action: 'copy', clearSelection: false }],
  'ctrl+Insert': [{ action: 'copy', clearSelection: true }, { action: 'copy', clearSelection: false }],
};

describe('Clipboard keys: the table', () => {
  test('KC-01: paste chords per platform, selected or not', () => {
    for (const [spec, [windows, linux, mac]] of Object.entries(TABLE)) {
      for (const hasSelection of [false, true]) {
        assert.deepEqual(act(spec, 'windows', hasSelection), windows, `windows ${spec} sel=${hasSelection}`);
        assert.deepEqual(act(spec, 'linux', hasSelection), linux, `linux ${spec} sel=${hasSelection}`);
        assert.deepEqual(act(spec, 'mac', hasSelection), mac, `mac ${spec} sel=${hasSelection}`);
      }
    }
  });

  test('KC-01b (L3): Ctrl+Shift+C and Ctrl+Insert copy only with a selection, same as plain Ctrl+C', () => {
    for (const [spec, [windows, linux]] of Object.entries(COPY_TABLE)) {
      assert.deepEqual(act(spec, 'windows', true), windows, `windows ${spec}, selected`);
      assert.deepEqual(act(spec, 'linux', true), linux, `linux ${spec}, selected`);
      assert.deepEqual(act(spec, 'mac', true), { action: 'pass' }, `mac ${spec}`);
      // fails on f8a757d: these copied (nothing) even with nothing selected.
      assert.deepEqual(act(spec, 'windows', false), { action: 'pass' }, `windows ${spec}, nothing selected: passed through`);
      assert.deepEqual(act(spec, 'linux', false), { action: 'pass' }, `linux ${spec}, nothing selected: passed through`);
      assert.deepEqual(act(spec, 'mac', false), { action: 'pass' }, `mac ${spec}, nothing selected`);
    }
  });

  test('KC-02: Ctrl+C copies only on Windows and only with a selection — otherwise it is ^C', () => {
    assert.deepEqual(act('ctrl+c', 'windows', true), { action: 'copy', clearSelection: true });
    assert.deepEqual(act('ctrl+c', 'windows', false), { action: 'pass' }, 'nothing selected: interrupt');
    assert.deepEqual(act('ctrl+c', 'linux', true), { action: 'pass' }, 'Linux terminals keep Ctrl+C for the shell');
    assert.deepEqual(act('ctrl+c', 'mac', true), { action: 'pass' });
  });

  test('KC-03: never a clipboard chord — keyup, mid-composition, AltGr, ⌘, other letters', () => {
    for (const platform of ['windows', 'linux']) {
      assert.equal(act('ctrl+v', platform, false, { type: 'keyup' }).action, 'pass', 'keyup');
      assert.equal(act('ctrl+shift+v', platform, false, { type: 'keypress' }).action, 'pass', 'keypress');
      assert.equal(act('ctrl+shift+v', platform, false, { isComposing: true }).action, 'pass', 'composing');
      assert.equal(act('ctrl+shift+v', platform, false, { keyCode: 229, key: 'Process' }).action, 'pass', 'IME key');
      // Windows reports AltGr as Ctrl+Alt: AltGr+V types a character on many layouts.
      assert.equal(act('ctrl+alt+v', platform, true).action, 'pass', 'AltGr+V');
      assert.equal(act('ctrl+alt+c', platform, true).action, 'pass', 'AltGr+C');
      assert.equal(act('ctrl+meta+v', platform, true).action, 'pass');
      for (const spec of ['v', 'shift+v', 'ctrl+x', 'ctrl+a', 'Insert', 'ctrl+shift+Insert', 'shift+c']) {
        assert.equal(act(spec, platform, true).action, 'pass', `${platform} ${spec}`);
      }
    }
    assert.equal(clipboardKeyAction(null).action, 'pass');
  });

  test('KC-04: the letter on the key counts — non-Latin layouts by position, Latin ones by letter', () => {
    // Russian: Ctrl+V reports 'м' on KeyV. Korean (2-Set) may report a jamo.
    assert.equal(act('ctrl+v', 'windows', false, { key: 'м' }).action, 'paste');
    assert.equal(act('ctrl+v', 'windows', false, { key: 'ㅍ' }).action, 'paste');
    assert.equal(act('ctrl+c', 'windows', true, { key: 'с' }).action, 'copy');
    assert.equal(act('ctrl+shift+v', 'linux', false, { key: 'М' }).action, 'paste');
    // Dvorak: the V key sits on code 'Period'; the key on code KeyV is K.
    assert.equal(act('ctrl+v', 'windows', false, { code: 'Period' }).action, 'paste', 'the key printed V');
    assert.equal(act('ctrl+v', 'windows', false, { key: 'k' }).action, 'pass', 'K, wherever it sits');
  });
});

describe('Clipboard keys: what the custom key handler does', () => {
  /** Enough of an xterm for the handler. */
  function term(selection = '') {
    return {
      selection,
      cleared: 0,
      hasSelection() {
        return this.selection !== '';
      },
      getSelection() {
        return this.selection;
      },
      clearSelection() {
        this.selection = '';
        this.cleared += 1;
      },
    };
  }

  test('KC-05: a paste chord returns false and is NOT cancelled — the browser\'s own paste does it', () => {
    for (const [platform, spec] of [['windows', 'ctrl+v'], ['windows', 'ctrl+shift+v'], ['windows', 'shift+Insert'], ['linux', 'ctrl+shift+v'], ['linux', 'shift+Insert']]) {
      const copied = [];
      const event = key(spec);
      const t = term('standing selection');
      assert.equal(handleClipboardKey(t, event, { platform, copy: (x) => copied.push(x) }), false, `${platform} ${spec}`);
      assert.equal(event.defaultPrevented, false, `${platform} ${spec}: left for the browser to paste`);
      assert.deepEqual(copied, []);
      assert.equal(t.selection, 'standing selection', 'a paste leaves the selection alone');
    }
  });

  test('KC-06: a copy chord copies, is cancelled, and clears the selection on Windows only', () => {
    for (const [platform, spec, cleared] of [
      ['windows', 'ctrl+c', true],
      ['windows', 'ctrl+shift+c', true],
      ['windows', 'ctrl+Insert', true],
      ['linux', 'ctrl+shift+c', false],
      ['linux', 'ctrl+Insert', false],
    ]) {
      const copied = [];
      const event = key(spec);
      const t = term('some output');
      assert.equal(handleClipboardKey(t, event, { platform, copy: (x) => copied.push(x.getSelection()) }), false);
      assert.deepEqual(copied, ['some output'], `${platform} ${spec}: copied while still selected`);
      assert.equal(event.defaultPrevented, true, `${platform} ${spec}: cancelled`);
      assert.equal(t.selection === '', cleared, `${platform} ${spec}: selection ${cleared ? 'cleared' : 'kept'}`);
    }
  });

  test('KC-07: anything else is left to the rest of the handler — and Ctrl+C with nothing selected reaches xterm as ^C', () => {
    for (const [platform, spec] of [
      ['windows', 'ctrl+c'],
      ['linux', 'ctrl+c'],
      ['linux', 'ctrl+v'],
      ['mac', 'meta+v'],
      ['windows', 'ArrowRight'],
      // L3: these used to copy (nothing) even with no selection.
      ['windows', 'ctrl+shift+c'],
      ['windows', 'ctrl+Insert'],
      ['linux', 'ctrl+shift+c'],
      ['linux', 'ctrl+Insert'],
    ]) {
      const event = key(spec);
      const t = term('');
      assert.equal(handleClipboardKey(t, event, { platform, copy: () => assert.fail('copied') }), undefined, `${platform} ${spec}`);
      assert.equal(event.defaultPrevented, false);
    }
  });
});

describe('Clipboard keys: a selection must be on screen to count (L3)', () => {
  /**
   * A terminal whose selection sits at absolute buffer rows `startY`..`endY`
   * — 0-based, as xterm 6's `getSelectionPosition()` really reports them,
   * whatever its typings say (measured in Chromium: a drag over the top row of
   * a fresh terminal reports y 0; see KC-14) — while the viewport shows buffer
   * rows `viewportY`..`viewportY + rows - 1` (0-based too, as
   * `IBuffer.viewportY` reports it; the top one otherwise defaults to the
   * start of the buffer).
   */
  function termAt({ startY, endY, viewportY = 0, rows = 24, selection = 'found it' } = {}) {
    return {
      selection,
      cleared: 0,
      hasSelection() {
        return this.selection !== '';
      },
      getSelection() {
        return this.selection;
      },
      clearSelection() {
        this.selection = '';
        this.cleared += 1;
      },
      getSelectionPosition() {
        return this.selection === '' ? undefined : { start: { x: 1, y: startY }, end: { x: 80, y: endY } };
      },
      buffer: { active: { viewportY } },
      rows,
    };
  }

  test('KC-10 (L3): a selection scrolled out of the viewport does not count', () => {
    // The viewport showing buffer rows 50..73.
    assert.equal(
      hasVisibleSelection(termAt({ startY: 5, endY: 5, viewportY: 50, rows: 24 })),
      false,
      'fails on f8a757d: copies instead of interrupting'
    );
    assert.equal(hasVisibleSelection(termAt({ startY: 200, endY: 200, viewportY: 50, rows: 24 })), false, 'scrolled below');
    assert.equal(hasVisibleSelection(termAt({ startY: 60, endY: 60, viewportY: 50, rows: 24 })), true, 'inside the viewport');
    assert.equal(
      hasVisibleSelection(termAt({ startY: 40, endY: 50, viewportY: 50, rows: 24 })),
      true,
      "ends on the viewport's own top row"
    );
    assert.equal(
      hasVisibleSelection(termAt({ startY: 40, endY: 49, viewportY: 50, rows: 24 })),
      false,
      'one row short of the viewport'
    );
    assert.equal(
      hasVisibleSelection(termAt({ startY: 73, endY: 90, viewportY: 50, rows: 24 })),
      true,
      "starts on the viewport's own bottom row"
    );
    assert.equal(
      hasVisibleSelection(termAt({ startY: 74, endY: 90, viewportY: 50, rows: 24 })),
      false,
      'one row past the bottom — counted as on screen when rows were read as 1-based'
    );
  });

  test("KC-11 (L3): the find bar's own highlighted match does not count, however it sits on screen", () => {
    const term = termAt({ startY: 60, endY: 60, viewportY: 50, rows: 24 });
    assert.equal(hasVisibleSelection(term), true, 'a real selection, on screen');
    assert.equal(hasVisibleSelection(term, { findOpen: true }), false, 'the find bar is open: not counted');
  });

  test('KC-14: a selection on the top row of a fresh terminal is on screen — Ctrl+C copies it instead of interrupting', () => {
    // What xterm 6 reports for a drag over the first row, viewport at the top.
    const top = termAt({ startY: 0, endY: 0, viewportY: 0, rows: 24, selection: 'hello' });
    assert.equal(hasVisibleSelection(top), true, 'read as 1-based, row 0 was "above" the viewport');
    const copied = [];
    assert.equal(handleClipboardKey(top, key('ctrl+c'), { platform: 'windows', copy: (t) => copied.push(t.getSelection()) }), false);
    assert.deepEqual(copied, ['hello'], 'copied, not ^C');
    assert.equal(hasVisibleSelection(termAt({ startY: 23, endY: 23, viewportY: 0, rows: 24 })), true, 'and the bottom row too');
    assert.equal(hasVisibleSelection(termAt({ startY: 24, endY: 24, viewportY: 0, rows: 24 })), false, 'but not the row below it');
  });

  test('KC-12 (L3): without position information (an older xterm, a simpler test double) a plain selection still counts', () => {
    assert.equal(hasVisibleSelection({ hasSelection: () => true }), true);
    assert.equal(hasVisibleSelection({ hasSelection: () => false }), false);
    assert.equal(hasVisibleSelection(null), false);
    assert.equal(hasVisibleSelection(undefined, { findOpen: true }), false);
  });

  test('KC-13 (L3): handleClipboardKey end to end — an off-screen selection interrupts instead of copying', () => {
    const term = termAt({ startY: 5, endY: 5, viewportY: 50, rows: 24 });
    const copied = [];
    const copy = () => copied.push('copied');
    assert.equal(
      handleClipboardKey(term, key('ctrl+c'), { platform: 'windows', copy }),
      undefined,
      'fails on f8a757d: copied the off-screen selection instead of sending ^C'
    );
    assert.equal(
      handleClipboardKey(term, key('ctrl+shift+c'), { platform: 'windows', copy }),
      undefined,
      'Ctrl+Shift+C too'
    );
    assert.deepEqual(copied, []);

    const onScreen = termAt({ startY: 60, endY: 60, viewportY: 50, rows: 24 });
    assert.equal(
      handleClipboardKey(onScreen, key('ctrl+c'), { platform: 'windows', findOpen: true, copy }),
      undefined,
      "on screen, but it is the find bar's match"
    );
    assert.deepEqual(copied, []);
    assert.equal(
      handleClipboardKey(onScreen, key('ctrl+c'), { platform: 'windows', copy }),
      false,
      'the same selection copies once the find bar is not the reason it exists'
    );
    assert.deepEqual(copied, ['copied']);
  });
});

describe('Clipboard keys: nothing else claims them', () => {
  test('KC-08: no NexTerm shortcut is bound to a clipboard chord on Windows or Linux', () => {
    for (const spec of ['ctrl+v', 'ctrl+shift+v', 'shift+Insert', 'ctrl+c', 'ctrl+shift+c', 'ctrl+Insert']) {
      const event = key(spec);
      // Off macOS the app modifier IS Ctrl.
      const ctx = { bindings: DEFAULT_RESOLVED, isMod: Boolean(event.ctrlKey) };
      assert.equal(findBinding(event, ctx), null, `${spec} is bound to a command`);
      assert.equal(dispatchKeydownOverTerminal(event, ctx), null, `${spec} is claimed ahead of xterm`);
      assert.equal(event.defaultPrevented, false);
    }
  });

  test('KC-09: TerminalView asks the clipboard first, before the suggestion layer can take a key', () => {
    const source = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
    const start = source.indexOf('const handleKeyEvent = (event) => {');
    assert.ok(start > 0, 'the custom key handler is where it was');
    const body = source.slice(start, source.indexOf('entry.term.attachCustomKeyEventHandler(handleKeyEvent)', start));
    const clipboard = body.indexOf('handleClipboardKey(entry.term, event,');
    const suggestions = body.indexOf('suggestionKeyAction(');
    assert.ok(clipboard > 0, 'handleKeyEvent calls handleClipboardKey');
    assert.ok(clipboard < suggestions, 'and before suggestionKeyAction');
    assert.match(body, /if \(clipboard !== undefined\) return clipboard;/);
  });
});

describe('Copy Path (copyText)', () => {
  // Found in the audit (A4): the Explorer, the terminal list and the tab chip
  // each copied a path their own way; the terminal list's had no fallback and
  // no error handling. One helper now does it for all three.
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  async function withPage({ writeText, execCommand }, fn) {
    const saved = { navigator: globalThis.navigator, document: globalThis.document };
    const focused = [];
    const made = [];
    const editorBox = { focus: (opts) => focused.push(['editor', opts]) };
    const doc = {
      activeElement: editorBox,
      body: { appendChild: (el) => made.push(el) },
      createElement: () => {
        const el = { style: {}, focus: () => focused.push(['area']), select() {}, remove() { el.removed = true; } };
        return el;
      },
      execCommand,
    };
    set('navigator', writeText === undefined ? {} : { clipboard: { writeText } });
    set('document', doc);
    try {
      return await fn({ focused, made });
    } finally {
      set('navigator', saved.navigator);
      set('document', saved.document);
    }
  }

  test('KC-10: the Clipboard API first; where it refuses, the old copy, and the focus goes back', async () => {
    const { copyText } = await import('../../src/lib/copyText.js');
    const written = [];
    await withPage({ writeText: async (t) => written.push(t), execCommand: () => assert.fail('no fallback needed') }, async () => {
      assert.equal(await copyText('/Users/me/proj'), true);
    });
    assert.deepEqual(written, ['/Users/me/proj']);

    const commands = [];
    await withPage(
      { writeText: async () => { throw new Error('denied'); }, execCommand: (c) => (commands.push(c), true) },
      async ({ focused, made }) => {
        assert.equal(await copyText('C:\\Users\\me'), true);
        assert.equal(made.length, 1);
        assert.equal(made[0].value, 'C:\\Users\\me');
        assert.equal(made[0].removed, true, 'the textarea goes again');
        assert.deepEqual(focused.at(-1), ['editor', { preventScroll: true }], 'what had the focus has it back');
      }
    );
    assert.deepEqual(commands, ['copy']);

    await withPage({ writeText: undefined, execCommand: () => { throw new Error('no'); } }, async () => {
      assert.equal(await copyText('x'), false, 'nothing copied, nothing thrown');
    });
    assert.equal(await copyText(''), false);
    assert.equal(await copyText(null), false);

    for (const file of ['../../src/components/terminal/TerminalsPanel.jsx', '../../src/components/terminal/TerminalSplitContainer.jsx', '../../src/components/explorer/FileExplorer.jsx']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.match(src, /import \{ copyText \} from '\.\.\/\.\.\/lib\/copyText\.js';/, file);
      assert.doesNotMatch(src, /navigator\.clipboard|execCommand/, `${file} copies on its own`);
    }
  });
});
