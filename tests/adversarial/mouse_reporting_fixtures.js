/**
 * A stand-in for xterm 5.5 and 6.0 (whose mouse service, DECSET handling and
 * forced-selection rule are the same), shared by mouse_reporting.test.js (the policy —
 * which protocol is in force, selection, copy on select) and
 * mouse_reporting_drag.test.js (the held-button, pure-upgrade-only mechanics
 * that fix 94ec8d6's intermittent loss of drag motion — see
 * src/lib/mouseReporting.js).
 *
 * What the binding touches of a real xterm: the public parser API (custom
 * handlers tried newest first, xterm's own last), `modes`, `element` /
 * `buffer.onBufferChange`, `onWriteParsed`, the mouse service behind `_core`,
 * and selection. The built-in handling is xterm's own: one tracking protocol
 * at a time, any DECRST of one turns tracking off, turning tracking on clears
 * the selection (SelectionService.disable), a switch of screen clears it too
 * and fires onBufferChange synchronously — only when the screen actually
 * changes.
 */
import { TRACKING_MODES, installMouseReporting } from '../../src/lib/mouseReporting.js';

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

export class FakeXterm {
  constructor({ mouseService = true } = {}) {
    this.protocol = 'none';
    this.encoding = 'DEFAULT';
    this.bracketed = false;
    this.screen = 'normal';
    this.selection = '';
    this.selectionClears = 0;
    this.protocolSets = 0;
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
    // Counted even when `name` repeats the current value — real xterm's own
    // `CoreMouseService` setter fires `onProtocolChange` unconditionally too
    // (see src/lib/mouseReporting.js's file doc); a count that only went up
    // on a REAL change would hide the exact bug this stands in for.
    this.protocolSets += 1;
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

/**
 * A minimal capture-phase-dispatching event target — just enough DOM for
 * `installMouseReporting`'s button tracking (`container` for mousedown,
 * `view` for mouseup/blur).
 */
export function fakeContainer() {
  const listeners = [];
  return {
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture: capture === true });
    },
    removeEventListener(type, fn, capture) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === (capture === true));
      if (i !== -1) listeners.splice(i, 1);
    },
    dispatch(event) {
      for (const l of listeners.filter((x) => x.type === event.type && x.capture)) l.fn(event);
    },
  };
}

/**
 * A terminal with mouse reporting installed, the setting read from
 * `setting.on`. `container`/`view` are the fake DOM nodes the binding tracks
 * the primary-button state through (capture-phase mousedown on `container`,
 * mouseup/blur on `view`) — see `press` / `release`.
 */
export function withBinding(options = {}) {
  const term = new FakeXterm(options);
  const setting = { on: true };
  const container = fakeContainer();
  const view = fakeContainer();
  container.ownerDocument = { defaultView: view };
  const binding = installMouseReporting(term, container, { isEnabled: () => setting.on });
  return { term, binding, setting, container, view };
}

/** Press and release the primary button through `container`/`view`. */
export function press(container, fields = {}) {
  container.dispatch({ type: 'mousedown', button: 0, buttons: 1, ...fields });
}
export function release(view, fields = {}) {
  view.dispatch({ type: 'mouseup', button: 0, buttons: 0, ...fields });
}
