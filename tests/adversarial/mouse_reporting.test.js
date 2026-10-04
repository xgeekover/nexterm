/**
 * The mouse goes to full-screen programs only, a drag anywhere else selects,
 * and a selection is copied as it is made (src/lib/mouseReporting.js,
 * src/lib/terminalClipboard.js).
 *
 * Measured in the real app on macOS: Claude Code turns on mouse tracking "any"
 * (DECSET 1003) at its main prompt, in the NORMAL buffer. Every drag in that
 * pane then went to Claude and xterm's selection was off — nothing could be
 * selected, so nothing could be copied — and on macOS xterm had no override.
 *
 * Three layers, each checked here:
 *
 *   MR  the decisions, pure — which protocol is in force, what each DECSET /
 *       DECRST a program sends does
 *   MB  the binding against a stand-in xterm that does what xterm 5.5 does
 *       with those sequences (InputHandler.setModePrivate / resetModePrivate,
 *       CoreMouseService, BufferSet), so the wiring — parser handlers tried
 *       before xterm's own, the switch of screen, the end of a write — is
 *       exercised in Node. The real xterm is driven headless, see the PR.
 *   CS  selection and copy on select, against fake DOM events
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  TRACKING_MODES,
  effectiveProtocol,
  planPrivateModes,
  pressForcesSelection,
  pressReachesProgram,
  installMouseReporting,
  mouseReportingFor,
} from '../../src/lib/mouseReporting.js';
import {
  pressSelects,
  shouldCopyOnSelect,
  copyTerminalSelection,
  installTerminalClipboard,
  terminalClipboardFor,
} from '../../src/lib/terminalClipboard.js';

// ---- a stand-in for xterm 5.5 ------------------------------------------------

const SCREEN = [47, 1047, 1049];
const SERVICE_NAMES = { NONE: 'none', X10: 'x10', VT200: 'vt200', DRAG: 'drag', ANY: 'any' };

/** `CSI ? 1003 ; 1006 h` → [1003, 1006]; `1003:1` → 1003, [1] — as `params.toArray()`. */
function parseParams(text) {
  const out = [];
  for (const part of text.split(';')) {
    const [head, ...subs] = part.split(':');
    out.push(head === '' ? 0 : Number(head));
    if (subs.length) out.push(subs.map((s) => (s === '' ? -1 : Number(s))));
  }
  return out;
}

/**
 * What the binding touches of an xterm: the public parser API (custom handlers
 * tried newest first, xterm's own last), `modes`, `buffer.onBufferChange`,
 * `onWriteParsed`, the mouse service behind `_core`, and selection. The
 * built-in handling is xterm's: one tracking protocol at a time, any DECRST of
 * one turns tracking off, turning tracking on clears the selection
 * (SelectionService.disable), a switch of screen clears it too and fires
 * onBufferChange synchronously — only when the screen actually changes.
 */
class FakeXterm {
  constructor({ mouseService = true } = {}) {
    this.protocol = 'none';
    this.encoding = 'DEFAULT';
    this.bracketed = false;
    this.screen = 'normal';
    this.selection = '';
    this.selectionClears = 0;
    this.csi = { h: [], l: [] };
    this.esc = [];
    this.bufferListeners = new Set();
    this.parsedListeners = new Set();
    this.addons = [];
    this.options = {};
    this.textarea = { tagName: 'TEXTAREA' };
    this.element = { tagName: 'DIV' };
    const self = this;
    this.parser = {
      registerCsiHandler(id, fn) {
        const list = self.csi[id.final];
        list.push(fn);
        return { dispose: () => list.splice(list.indexOf(fn), 1) };
      },
      registerEscHandler(id, fn) {
        self.esc.push(fn);
        return { dispose: () => self.esc.splice(self.esc.indexOf(fn), 1) };
      },
    };
    this.buffer = {
      get active() {
        return { type: self.screen };
      },
      onBufferChange(fn) {
        self.bufferListeners.add(fn);
        return { dispose: () => self.bufferListeners.delete(fn) };
      },
    };
    if (mouseService) {
      this._core = {
        coreMouseService: {
          get activeProtocol() {
            return Object.keys(SERVICE_NAMES).find((k) => SERVICE_NAMES[k] === self.protocol);
          },
          set activeProtocol(name) {
            if (!SERVICE_NAMES[name]) throw new Error(`unknown protocol "${name}"`);
            self._setProtocol(SERVICE_NAMES[name]);
          },
        },
      };
    }
  }

  get modes() {
    return { mouseTrackingMode: this.protocol, bracketedPasteMode: this.bracketed };
  }

  onWriteParsed(fn) {
    this.parsedListeners.add(fn);
    return { dispose: () => this.parsedListeners.delete(fn) };
  }

  loadAddon(addon) {
    this.addons.push(addon);
    addon.activate(this);
  }

  dispose() {
    for (const addon of this.addons) addon.dispose();
  }

  hasSelection() {
    return this.selection !== '';
  }

  getSelection() {
    return this.selection;
  }

  clearSelection() {
    this.selection = '';
  }

  _setProtocol(name) {
    this.protocol = name;
    if (name !== 'none' && this.selection) {
      this.selection = '';
      this.selectionClears += 1;
    }
  }

  _switch(screen) {
    if (this.screen === screen) return;
    this.screen = screen;
    this.selection = '';
    for (const fn of [...this.bufferListeners]) fn();
  }

  _builtinPrivateMode(final, params) {
    const set = final === 'h';
    for (const p of params) {
      if (Array.isArray(p)) continue;
      if (TRACKING_MODES[p]) this._setProtocol(set ? TRACKING_MODES[p] : 'none');
      else if (p === 1006) this.encoding = set ? 'SGR' : 'DEFAULT';
      else if (p === 2004) this.bracketed = set;
      else if (SCREEN.includes(p)) this._switch(set ? 'alternate' : 'normal');
    }
  }

  /** Parse one write: `CSI ? Pm h|l` and `ESC c`; anything else is text. */
  write(data, callback) {
    const re = /\x1b\[\?([0-9;:]*)([hl])|\x1bc/g;
    let m;
    while ((m = re.exec(data))) {
      if (m[0] === '\x1bc') {
        if (![...this.esc].reverse().some((fn) => fn() === true)) {
          this._setProtocol('none');
          this.encoding = 'DEFAULT';
          this.bracketed = false;
          this._switch('normal');
        }
        continue;
      }
      const params = parseParams(m[1]);
      const handlers = this.csi[m[2]];
      let handled = false;
      for (let i = handlers.length - 1; i >= 0 && !handled; i -= 1) handled = handlers[i](params) === true;
      if (!handled) this._builtinPrivateMode(m[2], params);
    }
    callback?.();
    for (const fn of [...this.parsedListeners]) fn();
  }
}

/** A terminal with mouse reporting installed, the setting read from `setting.on`. */
function withBinding(options = {}) {
  const term = new FakeXterm(options);
  const setting = { on: true };
  const binding = installMouseReporting(term, { isEnabled: () => setting.on });
  return { term, binding, setting };
}

describe('Mouse reporting: which protocol is in force (pure)', () => {
  test('MR-01: only a full-screen program that asked, with the setting on', () => {
    for (const requested of ['x10', 'vt200', 'drag', 'any']) {
      assert.equal(effectiveProtocol({ requested, alternate: true }), requested, `${requested} on the alternate screen`);
      assert.equal(effectiveProtocol({ requested, alternate: false }), 'none', `${requested} in the scrollback`);
      assert.equal(effectiveProtocol({ requested, alternate: true, enabled: false }), 'none', `${requested}, setting off`);
    }
    assert.equal(effectiveProtocol({ requested: 'none', alternate: true }), 'none');
    assert.equal(effectiveProtocol({ requested: 'bogus', alternate: true }), 'none', 'an unknown name is not a protocol');
    assert.equal(effectiveProtocol(), 'none');
  });

  test('MR-02: Claude Code\'s 1003 at its prompt (normal buffer) is dropped — and remembered', () => {
    assert.deepEqual(planPrivateModes({ final: 'h', params: [1003] }), {
      requested: 'any',
      alternate: false,
      effective: 'none',
      action: 'drop',
    });
    for (const [mode, name] of Object.entries(TRACKING_MODES)) {
      const plan = planPrivateModes({ final: 'h', params: [Number(mode)] });
      assert.equal(plan.action, 'drop', `?${mode}h in the scrollback`);
      assert.equal(plan.requested, name);
    }
  });

  test('MR-03: on the alternate screen it passes to xterm untouched', () => {
    for (const [mode, name] of Object.entries(TRACKING_MODES)) {
      const plan = planPrivateModes({ final: 'h', params: [Number(mode)], alternate: true });
      assert.deepEqual(plan, { requested: name, alternate: true, effective: name, action: 'pass' }, `?${mode}h`);
    }
    // …unless the setting is off.
    assert.equal(planPrivateModes({ final: 'h', params: [1000], alternate: true, enabled: false }).action, 'drop');
  });

  test('MR-04: a refused request carrying other modes passes, to be put back once parsed', () => {
    // Claude-style and ncurses-style (XM is ?1006;1000h) — the SGR encoding
    // and bracketed paste in the same sequence must still reach xterm.
    for (const params of [[1003, 1006], [1006, 1000], [2004, 1003], [1002, 1004]]) {
      const plan = planPrivateModes({ final: 'h', params });
      assert.equal(plan.action, 'pass-then-sync', JSON.stringify(params));
      assert.equal(plan.effective, 'none');
    }
  });

  test('MR-05: a sequence that switches screens decides by where the tracking ends up', () => {
    // Entering the alternate screen in the same breath: allowed, either order.
    for (const params of [[1049, 1003], [1003, 1049], [47, 1000], [1047, 1002]]) {
      const plan = planPrivateModes({ final: 'h', params });
      assert.equal(plan.action, 'pass', JSON.stringify(params));
      assert.equal(plan.alternate, true);
      assert.equal(plan.effective, plan.requested);
    }
    // With the setting off, the screen switch still has to happen: pass, then put back.
    assert.equal(planPrivateModes({ final: 'h', params: [1049, 1003], enabled: false }).action, 'pass-then-sync');
  });

  test('MR-06: a reset always passes; ANY tracking reset ends tracking, as xterm does', () => {
    for (const mode of [9, 1000, 1002, 1003]) {
      for (const alternate of [false, true]) {
        const plan = planPrivateModes({ final: 'l', params: [mode], requested: 'any', alternate });
        assert.equal(plan.action, 'pass', `?${mode}l`);
        assert.equal(plan.requested, 'none', `?${mode}l ends a 1003 as well`);
      }
    }
    // Leaving the alternate screen forgets nothing: the program never said so.
    const leave = planPrivateModes({ final: 'l', params: [1049], requested: 'vt200', alternate: true });
    assert.deepEqual(leave, { requested: 'vt200', alternate: false, effective: 'none', action: 'pass' });
  });

  test('MR-07: encodings, focus and every other mode are never touched', () => {
    for (const mode of [1004, 1005, 1006, 1015, 1016, 2004, 25, 1, 7, 12]) {
      for (const final of ['h', 'l']) {
        for (const alternate of [false, true]) {
          const plan = planPrivateModes({ final, params: [mode], requested: 'drag', alternate });
          assert.equal(plan.action, 'pass', `?${mode}${final}`);
          assert.equal(plan.requested, 'drag', `?${mode}${final} leaves the request alone`);
        }
      }
    }
  });

  test('MR-08: the last tracking mode wins, and sub-parameters are ignored like xterm does', () => {
    assert.equal(planPrivateModes({ final: 'h', params: [1000, 1002, 1003], alternate: true }).requested, 'any');
    assert.equal(planPrivateModes({ final: 'h', params: [1003, 1000], alternate: true }).requested, 'vt200');
    const withSubs = planPrivateModes({ final: 'h', params: [1003, [1, 2]] });
    assert.deepEqual(withSubs, { requested: 'any', alternate: false, effective: 'none', action: 'drop' });
    assert.equal(planPrivateModes({ final: 'h', params: [] }).action, 'pass');
    assert.equal(planPrivateModes({ final: 'h' }).action, 'pass');
  });

  test('MR-09: which presses select instead of reaching a tracking program', () => {
    const press = (fields) => ({ button: 0, shiftKey: false, altKey: false, ...fields });
    // Windows and Linux: Shift, xterm's own rule.
    assert.equal(pressForcesSelection(press({ shiftKey: true })), true);
    assert.equal(pressForcesSelection(press({ altKey: true })), false, 'Alt is column selection there, not an override');
    assert.equal(pressForcesSelection(press({ shiftKey: true, button: 2 })), true, 'xterm checks no button');
    // macOS: ⌥ (any button), and Shift with the primary button.
    assert.equal(pressForcesSelection(press({ altKey: true }), { mac: true }), true);
    assert.equal(pressForcesSelection(press({ shiftKey: true }), { mac: true }), true);
    assert.equal(pressForcesSelection(press({ shiftKey: true, button: 2 }), { mac: true }), false);
    assert.equal(pressForcesSelection(press({}), { mac: true }), false);
    assert.equal(pressForcesSelection(null), false);
    // Reaching the program needs tracking AND no override.
    assert.equal(pressReachesProgram(press({}), { tracking: true }), true);
    assert.equal(pressReachesProgram(press({}), { tracking: false }), false);
    assert.equal(pressReachesProgram(press({ shiftKey: true }), { tracking: true, mac: true }), false);
    assert.equal(pressReachesProgram(press({ altKey: true }), { tracking: true, mac: true }), false);
  });
});

describe('Mouse reporting: the binding, against xterm\'s own handling', () => {
  test('MB-01: Claude Code — 1003 in the scrollback is refused, and a selection survives it', () => {
    const { term, binding } = withBinding();
    term.selection = 'copy this';
    term.write('\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'none', 'not in force');
    assert.equal(binding.requested, 'any', 'remembered');
    assert.equal(term.selection, 'copy this', 'xterm never saw it, so it never cleared the selection');
    assert.equal(term.selectionClears, 0);
    // A program asking again (Ink redraws) changes nothing.
    term.write('\x1b[?1003h\x1b[?1003h');
    assert.equal(term.selection, 'copy this');
  });

  test('MB-02: …and takes effect the moment that program goes full-screen, and stops when it leaves', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1003h');
    term.write('\x1b[?1049h');
    assert.equal(term.modes.mouseTrackingMode, 'any', 'in force on the alternate screen');
    term.write('\x1b[?1049l');
    assert.equal(term.modes.mouseTrackingMode, 'none', 'off again in the scrollback');
    assert.equal(binding.requested, 'any', 'still what the program asked for');
    term.write('\x1b[?1003l');
    assert.equal(binding.requested, 'none');
  });

  test('MB-03: vim — enters the alternate screen, asks for 1000 + SGR, gets both; leaves clean', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
    assert.equal(term.encoding, 'SGR');
    term.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    assert.equal(binding.requested, 'none');
    assert.equal(term.screen, 'normal');
  });

  test('MB-04: a program that dies on the alternate screen with tracking on leaves the scrollback selectable', () => {
    const { term } = withBinding();
    term.write('\x1b[?1049h\x1b[?1002h');
    assert.equal(term.modes.mouseTrackingMode, 'drag');
    term.write('\x1b[?1049l'); // `reset`-less recovery: just the screen switch
    assert.equal(term.modes.mouseTrackingMode, 'none');
    term.write('\x1b[?1049h'); // the next full-screen program inherits it, as in any terminal
    assert.equal(term.modes.mouseTrackingMode, 'drag');
  });

  test('MB-05: one sequence that enters the alternate screen and asks for tracking, either order', () => {
    for (const seq of ['\x1b[?1049;1003h', '\x1b[?1003;1049h']) {
      const { term } = withBinding();
      term.write(seq);
      assert.equal(term.screen, 'alternate', seq);
      assert.equal(term.modes.mouseTrackingMode, 'any', seq);
    }
  });

  test('MB-06: a refused request mixed with other modes: the others apply, tracking is back off by the end of the write', () => {
    const { term, binding } = withBinding();
    let seenDuringWrite = null;
    term.write('\x1b[?2004;1003;1006h', () => {
      seenDuringWrite = term.modes.mouseTrackingMode;
    });
    assert.equal(term.bracketed, true, 'bracketed paste applied');
    assert.equal(term.encoding, 'SGR', 'SGR applied');
    assert.equal(seenDuringWrite, 'any', 'xterm applied the whole sequence…');
    assert.equal(term.modes.mouseTrackingMode, 'none', '…and the protocol was put back once it was parsed');
    assert.equal(binding.requested, 'any');
  });

  test('MB-07: the setting — off takes the mouse away at once, on gives back what was asked', () => {
    const { term, binding, setting } = withBinding();
    term.write('\x1b[?1049h\x1b[?1002h');
    setting.on = false;
    binding.sync();
    assert.equal(term.modes.mouseTrackingMode, 'none');
    // Asked again while off: refused.
    term.write('\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    setting.on = true;
    binding.sync();
    assert.equal(term.modes.mouseTrackingMode, 'any', 'the latest request');
  });

  test('MB-08: RIS (`reset`) forgets the request along with everything else', () => {
    const { term, binding } = withBinding();
    term.write('\x1b[?1003h');
    term.write('\x1bc');
    assert.equal(binding.requested, 'none');
    term.write('\x1b[?1049h');
    assert.equal(term.modes.mouseTrackingMode, 'none', 'nothing comes back on the next full-screen program');
  });

  test('MB-09: an xterm without the mouse service still refuses requests from the scrollback; transitions are left alone', () => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const { term, binding } = withBinding({ mouseService: false });
      assert.equal(binding.canSetProtocol, false);
      term.write('\x1b[?1003h');
      assert.equal(term.modes.mouseTrackingMode, 'none', 'still refused — the part that matters');
      term.write('\x1b[?1049h');
      assert.equal(term.modes.mouseTrackingMode, 'none', 'cannot be put in force without a write');
      term.write('\x1b[?1049l\x1b[?1049h');
      assert.equal(warnings.length, 1, 'said so, once');
    } finally {
      console.warn = warn;
    }
  });

  test('MB-10: installed once per terminal, and disposed with it', () => {
    const term = new FakeXterm();
    const first = installMouseReporting(term);
    assert.equal(installMouseReporting(term), first);
    assert.equal(mouseReportingFor(term), first);
    assert.equal(term.csi.h.length, 1);
    term.dispose();
    assert.equal(term.csi.h.length + term.csi.l.length + term.esc.length, 0, 'parser handlers gone');
    assert.equal(term.bufferListeners.size + term.parsedListeners.size, 0, 'listeners gone');
    term.write('\x1b[?1003h');
    assert.equal(term.modes.mouseTrackingMode, 'any', 'xterm alone again');
    assert.equal(installMouseReporting(null), null);
  });
});

// ---- selection and copy on select -------------------------------------------

/** Capture-phase listeners only, dispatched in registration order — what the bindings use. */
class FakeTarget {
  constructor() {
    this.listeners = [];
  }
  addEventListener(type, fn, capture) {
    this.listeners.push({ type, fn, capture: capture === true });
  }
  removeEventListener(type, fn, capture) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === (capture === true)));
  }
  dispatch(event) {
    for (const l of this.listeners.filter((x) => x.type === event.type && x.capture)) l.fn(event);
  }
}

function mouseEvent(type, fields = {}) {
  return {
    type,
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...fields,
  };
}

/** A fake page: a window, a container inside it, a document with focus and execCommand. */
function page(term) {
  const view = new FakeTarget();
  const container = new FakeTarget();
  container.ownerDocument = { defaultView: view };
  const doc = {
    activeElement: term.textarea,
    listeners: [],
    allowCopy: true,
    clipboard: null,
    xtermStandsAside: false,
    addEventListener(type, fn) {
      this.listeners.push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners = this.listeners.filter((l) => l !== fn);
    },
    // Chromium/WebKit: a copy event at the focused element, xterm's listener on
    // its element first (it fills the data and cancels), then the document's.
    execCommand(cmd) {
      if (cmd !== 'copy' || !this.allowCopy) return false;
      const data = {};
      const e = {
        type: 'copy',
        defaultPrevented: false,
        clipboardData: { setData: (k, v) => (data[k] = v), getData: (k) => data[k] },
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      if (!this.xtermStandsAside && term.hasSelection()) {
        e.clipboardData.setData('text/plain', term.getSelection());
        e.preventDefault();
      }
      for (const fn of [...this.listeners]) fn(e);
      if (e.defaultPrevented) this.clipboard = data['text/plain'];
      return true;
    },
  };
  return { view, container, doc };
}

/** What xterm 5.5 does with a press: select (forced or not) or report it. */
function xtermVerdict(term, e, { mac }) {
  const tracking = term.modes.mouseTrackingMode !== 'none';
  if (!tracking) return 'select';
  const forced = mac ? Boolean(e.altKey && term.options.macOptionClickForcesSelection) : Boolean(e.shiftKey);
  return forced ? 'select' : 'report';
}

describe('Selection and copy on select', () => {
  test('CS-01: which presses select, and when a release copies', () => {
    assert.equal(pressSelects({ button: 0 }), true, 'no tracking: every primary press selects');
    assert.equal(pressSelects({ button: 2 }), false, 'never the right button');
    assert.equal(pressSelects({ button: 0 }, { tracking: true }), false, 'the program gets it');
    assert.equal(pressSelects({ button: 0, shiftKey: true }, { tracking: true }), true);
    assert.equal(pressSelects({ button: 0, altKey: true }, { tracking: true }), false, 'Alt is no override off macOS');
    assert.equal(pressSelects({ button: 0, altKey: true }, { tracking: true, mac: true }), true);
    assert.equal(pressSelects({ button: 0, shiftKey: true }, { tracking: true, mac: true }), true);
    assert.equal(pressSelects(null), false);

    assert.equal(shouldCopyOnSelect({ selecting: true, hasSelection: true }), true);
    assert.equal(shouldCopyOnSelect({ selecting: true, hasSelection: true, enabled: false }), false, 'setting off');
    assert.equal(shouldCopyOnSelect({ selecting: false, hasSelection: true }), false, 'a click the program got');
    assert.equal(shouldCopyOnSelect({ selecting: true, hasSelection: false }), false, 'a plain click clears');
  });

  test('CS-02: macOS, a program tracking the mouse — Shift-press becomes xterm\'s ⌥ override', () => {
    const term = new FakeXterm();
    const { view, container, doc } = page(term);
    installTerminalClipboard(term, container, { platform: 'mac' });
    term.write('\x1b[?1049h\x1b[?1000h');

    const shift = mouseEvent('mousedown', { shiftKey: true });
    view.dispatch(shift);
    container.dispatch(shift);
    assert.equal(term.options.macOptionClickForcesSelection, true, '⌥ forces selection while tracking');
    assert.equal(shift.altKey, true, 'relabelled for xterm');
    assert.equal(xtermVerdict(term, shift, { mac: true }), 'select');

    const plain = mouseEvent('mousedown');
    container.dispatch(plain);
    assert.equal(xtermVerdict(term, plain, { mac: true }), 'report', 'a plain press still goes to the program');

    const right = mouseEvent('mousedown', { shiftKey: true, button: 2 });
    container.dispatch(right);
    assert.equal(right.altKey, false, 'only the primary button is relabelled');

    // Back in the scrollback, ⌥-drag is xterm's column selection again.
    term.write('\x1b[?1000l\x1b[?1049l');
    const option = mouseEvent('mousedown', { altKey: true });
    container.dispatch(option);
    assert.equal(term.options.macOptionClickForcesSelection, false);
    const shiftAtPrompt = mouseEvent('mousedown', { shiftKey: true });
    container.dispatch(shiftAtPrompt);
    assert.equal(shiftAtPrompt.altKey, false, 'Shift-click extends the selection at a prompt — untouched');
    assert.ok(doc);
  });

  test('CS-03: Windows and Linux leave Shift to xterm — it already forces selection there', () => {
    for (const platform of ['windows', 'linux']) {
      const term = new FakeXterm();
      const { container } = page(term);
      installTerminalClipboard(term, container, { platform });
      term.write('\x1b[?1049h\x1b[?1003h');
      const shift = mouseEvent('mousedown', { shiftKey: true });
      container.dispatch(shift);
      assert.equal(shift.altKey, false, platform);
      assert.equal(term.options.macOptionClickForcesSelection, undefined, `${platform}: no macOS option set`);
      assert.equal(xtermVerdict(term, shift, { mac: false }), 'select', platform);
    }
  });

  /** Press in the terminal, let "xterm" select, release on the window. */
  function gesture(env, { press = {}, selectionAfter = 'copy this', mac = false } = {}) {
    const { term, view, container } = env;
    const down = mouseEvent('mousedown', press);
    view.dispatch(down);
    container.dispatch(down);
    if (xtermVerdict(term, down, { mac }) === 'select' && (down.button ?? 0) === 0) term.selection = selectionAfter;
    view.dispatch(mouseEvent('mouseup', { button: press.button ?? 0 }));
  }

  function clipboardEnv(platform = 'linux', settingsState = {}) {
    const term = new FakeXterm();
    const { view, container, doc } = page(term);
    const state = { terminalCopyOnSelect: true, terminalMouseReporting: true, ...settingsState };
    const settings = { getState: () => state, subscribe: () => () => {} };
    const realDocument = globalThis.document;
    globalThis.document = doc;
    installTerminalClipboard(term, container, { platform, settings });
    return {
      term,
      view,
      container,
      doc,
      state,
      restore: () => {
        globalThis.document = realDocument;
      },
    };
  }

  test('CS-04: a drag copies on release; a click the program got does not copy an old selection again', () => {
    const env = clipboardEnv('linux');
    try {
      gesture(env, { selectionAfter: 'copy this sentence' });
      assert.equal(env.doc.clipboard, 'copy this sentence', 'copied by the release');

      // A full-screen program tracking the mouse; the user Shift-selects…
      env.term.write('\x1b[?1049h\x1b[?1000h');
      gesture(env, { press: { shiftKey: true }, selectionAfter: 'full screen' });
      assert.equal(env.doc.clipboard, 'full screen');
      // …copies something else elsewhere, then clicks in the program.
      env.doc.clipboard = 'from another app';
      gesture(env, { selectionAfter: 'never selected' });
      assert.equal(env.term.selection, 'full screen', 'the old selection still stands');
      assert.equal(env.doc.clipboard, 'from another app', 'and was not copied back over the clipboard');
    } finally {
      env.restore();
    }
  });

  test('CS-05: no copy for the right button, a press outside the terminal, or with the setting off', () => {
    const env = clipboardEnv('windows');
    try {
      gesture(env, { press: { button: 2 } });
      assert.equal(env.doc.clipboard, null, 'right button');

      env.term.selection = 'standing';
      env.view.dispatch(mouseEvent('mousedown')); // a press elsewhere in the window
      env.view.dispatch(mouseEvent('mouseup'));
      assert.equal(env.doc.clipboard, null, 'not this terminal\'s gesture');

      env.state.terminalCopyOnSelect = false;
      gesture(env, { selectionAfter: 'selected, not copied' });
      assert.equal(env.term.selection, 'selected, not copied');
      assert.equal(env.doc.clipboard, null, 'setting off');
    } finally {
      env.restore();
    }
  });

  test('CS-06: the mouse-reporting setting reaches a running terminal at once', () => {
    const term = new FakeXterm();
    const { container } = page(term);
    let state = { terminalMouseReporting: true };
    const subscribers = new Set();
    const settings = {
      getState: () => state,
      subscribe: (fn) => {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    };
    installTerminalClipboard(term, container, { platform: 'linux', settings });
    term.write('\x1b[?1049h\x1b[?1000h');
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
    const set = (next) => {
      const prev = state;
      state = { ...state, ...next };
      for (const fn of subscribers) fn(state, prev);
    };
    set({ terminalMouseReporting: false });
    assert.equal(term.modes.mouseTrackingMode, 'none');
    set({ terminalMouseReporting: true });
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
    term.dispose();
    assert.equal(subscribers.size, 0, 'unsubscribed with the terminal');
    assert.equal(terminalClipboardFor(term), terminalClipboardFor(term), 'one binding per terminal');
  });

  test('CS-07: copying — the copy event xterm handles; the Clipboard API only when that cannot happen', () => {
    const calls = [];
    const clipboard = { writeText: (t) => (calls.push(t), Promise.resolve()) };
    const term = new FakeXterm();
    const { doc } = page(term);

    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'empty');

    term.selection = 'copy this';
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'copied');
    assert.equal(doc.clipboard, 'copy this');
    assert.equal(calls.length, 0, 'no Clipboard API when the copy event did it');

    doc.xtermStandsAside = true; // xterm's handler declined: the binding fills the data itself
    doc.clipboard = null;
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'copied');
    assert.equal(doc.clipboard, 'copy this');

    doc.allowCopy = false; // no user activation left: execCommand refuses, no event
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'async');
    assert.deepEqual(calls, ['copy this']);

    doc.allowCopy = true;
    doc.activeElement = { tagName: 'INPUT' }; // focus is not in the terminal: no execCommand at all
    doc.clipboard = null;
    assert.equal(copyTerminalSelection(term, { document: doc, clipboard }), 'async');
    assert.equal(doc.clipboard, null);
    assert.deepEqual(calls, ['copy this', 'copy this']);

    assert.equal(copyTerminalSelection(term, { document: doc, clipboard: null }), 'failed');
    assert.equal(doc.listeners.length, 0, 'no listener left behind');
  });
});
