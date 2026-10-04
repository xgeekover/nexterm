/**
 * Korean typed at the terminal on macOS reaches the program whole, one
 * syllable at a time.
 *
 * Measured in the real app (WKWebView, real zsh, 2-Set Korean): typing 한글
 * gave the shell `ㅎㄱ`. WebKit composes by rewriting the textarea in place —
 * `insertText 'ㅎ'`, then `insertReplacementText '하'`, `'한'` — and xterm 5.5
 * reads only `insertText`, so each syllable arrived as its first jamo. Typed
 * fast, whole syllables vanished: keyups land between the IME's events and
 * xterm's `_keyDownSeen` goes stale (xterm #6144). Backspace mid-syllable sent
 * DELs for jamo the shell never had. See src/lib/hangulInlineIme.js.
 *
 * These cases replay the recorded event streams (hangul_ime_recordings.js)
 * through the real binding and its state machine, with a stand-in for the
 * part of xterm 5.5 that turns whatever the binding lets through into bytes.
 * The stand-in is checked first: with no binding it must send exactly what
 * xterm sent in each recording. The bytes every other case expects are the
 * "must become" column of the investigation's matrix (qa/ime/DESIGN.md).
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  createHangulInlineIme,
  installHangulInlineIme,
  hangulImeFor,
  isHangulCharacter,
} from '../../src/lib/hangulInlineIme.js';
import { isMac } from '../../src/lib/platform.js';
import { cursorCellAnchor } from '../../src/lib/suggestGeometry.js';
import { RECORDINGS } from './hangul_ime_recordings.js';

const INPUT_TYPES = {
  IT: 'insertText',
  IRT: 'insertReplacementText',
  ICT: 'insertCompositionText',
  DCT: 'deleteCompositionText',
  IFC: 'insertFromComposition',
};

/** xterm's helper textarea: a value and a selection. */
class FakeTextarea {
  constructor() {
    this.tagName = 'TEXTAREA';
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
}

/** The terminal's container: listeners, dispatched in the capture phase. */
class FakeContainer {
  constructor() {
    this.listeners = [];
  }
  addEventListener(type, fn, capture) {
    this.listeners.push({ type, fn, capture: capture === true });
  }
  removeEventListener(type, fn, capture) {
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.fn === fn && l.capture === (capture === true))
    );
  }
  dispatch(event) {
    for (const l of this.listeners.filter((x) => x.type === event.type && x.capture)) {
      l.fn(event);
      if (event.immediatePropagationStopped) break;
    }
  }
}

function domEvent(type, target, fields = {}) {
  return {
    type,
    target,
    ...fields,
    defaultPrevented: false,
    propagationStopped: false,
    immediatePropagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    stopImmediatePropagation() {
      this.propagationStopped = true;
      this.immediatePropagationStopped = true;
    },
  };
}

/** Enough of an xterm `Terminal` for the binding: a textarea, input(), addons. */
class FakeTerm {
  constructor(textarea) {
    this.textarea = textarea;
    this.addons = [];
    this.inputs = [];
    this.dataListeners = [];
    this.options = {};
    this.buffer = { active: { viewportY: 0, baseY: 0 } };
    this.scrolledToBottom = 0;
    // A fresh terminal has sent no CSI ?1000h (or similar): the program is
    // not watching the mouse until something turns it on.
    this.modes = { mouseTrackingMode: 'none' };
  }
  loadAddon(addon) {
    this.addons.push(addon);
    addon.activate(this);
  }
  input(data, wasUserInput) {
    this.inputs.push({ data, wasUserInput });
    for (const listener of this.dataListeners) listener(data);
  }
  scrollToBottom() {
    this.scrolledToBottom += 1;
    this.buffer.active.viewportY = this.buffer.active.baseY;
  }
  dispose() {
    for (const addon of this.addons) addon.dispose();
  }
}

/**
 * What xterm 5.5 makes of the events that reach it, for the keys the
 * recordings press: `Terminal._keyDown`, `_keyUp`, `_keyPress`,
 * `_inputEvent` and CompositionHelper (src/browser/Terminal.ts,
 * src/browser/input/CompositionHelper.ts, src/common/input/Keyboard.ts).
 */
function xtermStandIn(textarea, emit) {
  let keyDownSeen = false;
  let keyPressHandled = false;
  let composing = false;
  let compositionText = '';
  let diffFrom = null;

  // CompositionHelper._handleAnyTextareaChanges: a keydown with keyCode 229
  // outside a composition diffs the textarea one tick later — sending the
  // whole value when the length did not change.
  const settle = () => {
    if (diffFrom === null) return;
    const oldValue = diffFrom;
    diffFrom = null;
    if (composing) return;
    const newValue = textarea.value;
    if (newValue.length > oldValue.length) emit(newValue.replace(oldValue, ''));
    else if (newValue.length < oldValue.length) emit('\x7f');
    else if (newValue !== oldValue) emit(newValue);
  };

  // Keyboard.ts `evaluateKeyboardEvent`, normal cursor mode, macOS.
  const keyFor = (e) => {
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    switch (e.keyCode) {
      case 8:
        return (e.altKey ? '\x1b' : '') + (e.ctrlKey ? '\b' : '\x7f');
      case 9:
        return e.shiftKey ? '\x1b[Z' : '\t';
      case 13:
        return e.altKey ? '\x1b\r' : '\r';
      case 27:
        return e.altKey ? '\x1b\x1b' : '\x1b';
      case 37:
        return plain ? '\x1b[D' : undefined;
      case 38:
        return plain ? '\x1b[A' : undefined;
      case 39:
        return plain ? '\x1b[C' : undefined;
      case 40:
        return plain ? '\x1b[B' : undefined;
      default:
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          if (e.keyCode >= 65 && e.keyCode <= 90) return String.fromCharCode(e.keyCode - 64);
          if (e.keyCode === 32) return '\x00';
          return undefined;
        }
        if (e.key && !e.ctrlKey && !e.altKey && !e.metaKey && e.keyCode >= 48 && e.key.length === 1) {
          return e.key;
        }
        return undefined;
    }
  };

  return {
    settle,
    /** State left behind by a recording that ran before this one. */
    carry(state) {
      if (state === 'keyDownSeen') keyDownSeen = true;
      else throw new Error(`unknown carried state ${state}`);
    },
    keydown(e) {
      keyDownSeen = true;
      if (composing) {
        if (e.keyCode === 229 || e.keyCode === 16 || e.keyCode === 17 || e.keyCode === 18) return;
        composing = false;
        if (compositionText) emit(compositionText);
      }
      if (e.keyCode === 229) {
        diffFrom = textarea.value;
        return;
      }
      const key = keyFor(e);
      if (!key) return;
      // Capital A–Z are left to keypress (the caps-lock hack in `_keyDown`).
      const code = e.key?.length === 1 ? e.key.charCodeAt(0) : 0;
      if (!e.ctrlKey && !e.altKey && !e.metaKey && code >= 65 && code <= 90) return;
      if (key === '\r' || key === '\x03') textarea.value = '';
      emit(key);
      e.preventDefault();
    },
    keyup() {
      keyDownSeen = false;
      keyPressHandled = false;
    },
    keypress(e) {
      keyPressHandled = false;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      emit(e.key);
      keyPressHandled = true;
    },
    input(e) {
      if (e.data && e.inputType === 'insertText' && !keyDownSeen) {
        if (keyPressHandled) return;
        emit(e.data);
      }
    },
    compositionstart() {
      composing = true;
      compositionText = '';
    },
    compositionupdate(e) {
      compositionText = e.data;
    },
    compositionend(e) {
      composing = false;
      if (e.data) emit(e.data);
    },
    blur() {
      textarea.value = '';
    },
  };
}

/** Turn a recorded row into the DOM event the binding and xterm see. */
function eventFor(row, textarea) {
  const setTextarea = (value, start, end) => {
    textarea.value = value;
    textarea.selectionStart = start;
    textarea.selectionEnd = end;
  };
  const [kind] = row;
  switch (kind) {
    case 'bi':
    case 'in': {
      const [, it, data, value, start, end, composing] = row;
      setTextarea(value, start, end);
      return domEvent(kind === 'bi' ? 'beforeinput' : 'input', textarea, {
        inputType: INPUT_TYPES[it] ?? it,
        data,
        isComposing: Boolean(composing),
      });
    }
    case 'kd':
    case 'ku':
    case 'kp': {
      const [, key, keyCode, code = '', modifiers = '', composing] = row;
      return domEvent({ kd: 'keydown', ku: 'keyup', kp: 'keypress' }[kind], textarea, {
        key,
        keyCode,
        code,
        shiftKey: modifiers.includes('s'),
        ctrlKey: modifiers.includes('c'),
        altKey: modifiers.includes('a'),
        metaKey: modifiers.includes('m'),
        isComposing: Boolean(composing),
      });
    }
    case 'cs':
    case 'cu':
    case 'ce': {
      const [, data, value, start, end] = row;
      setTextarea(value, start, end);
      return domEvent({ cs: 'compositionstart', cu: 'compositionupdate', ce: 'compositionend' }[kind], textarea, {
        data,
      });
    }
    case 'blur':
    case 'focus': {
      const [, value, start, end] = row;
      setTextarea(value, start, end);
      return domEvent(kind, textarea);
    }
    case 'md': // a click on the terminal's screen, with any modifiers in row[1]
      return domEvent('mousedown', { tagName: 'CANVAS' }, { button: 0, shiftKey: false, altKey: false, ...(row[1] ?? {}) });
    default:
      throw new Error(`unknown row ${JSON.stringify(row)}`);
  }
}

/**
 * Play `rows` into a terminal. Every event is its own task unless a `['same']`
 * row says the next one is dispatched in the same task — which is what decides
 * when xterm's one-tick textarea diff runs.
 */
function replay(rows, { binding: withBinding = true, mac = true, mouseTracking = false } = {}) {
  const textarea = new FakeTextarea();
  const container = new FakeContainer();
  const term = new FakeTerm(textarea);
  term.modes.mouseTrackingMode = mouseTracking ? 'any' : 'none';
  const bytes = [];
  const today = [];
  const previews = [];
  const consumed = [];
  term.dataListeners.push((data) => bytes.push(data));
  const xterm = xtermStandIn(textarea, (data) => bytes.push(data));
  const binding = withBinding ? installHangulInlineIme(term, container, { mac }) : null;
  binding?.onPreview((text, info) => previews.push({ text, ...info }));

  let sameTask = false;
  for (const row of rows) {
    if (row[0] === 'sent') {
      today.push(row[1]);
      continue;
    }
    if (row[0] === 'same') {
      sameTask = true;
      continue;
    }
    if (row[0] === 'xterm') {
      xterm.carry(row[1]);
      continue;
    }
    if (!sameTask) xterm.settle();
    sameTask = false;
    const event = eventFor(row, textarea);
    container.dispatch(event);
    if (event.propagationStopped) {
      consumed.push({ row, prevented: event.defaultPrevented });
      continue;
    }
    xterm[event.type]?.(event);
  }
  xterm.settle();
  return { bytes, today, previews, consumed, binding, term, container, textarea };
}

const show = (bytes) => JSON.stringify(bytes.join(''));

/** The matrix's "must become" column, chunk by chunk: each syllable sent whole. */
const MUST_BECOME = {
  s01_clean_hangul_space: ['한', '글', ' '],
  s02_annyeong_enter: ['안', '녕', '하', '세', '요', '\r'],
  s03_gana_tab: ['가', '나', '\t'],
  s04_kka_dot: ['까', '.'],
  s05_wa_digit: ['와', '1'],
  s06_eops_esc: ['없', '\x1b'],
  s07_han_left: ['한', '\x1b[D'],
  s08_han_right: ['한', '\x1b[C'],
  s09_bs_mid: ['\x7f'],
  s10_bs_after: ['한', '\x7f', '\x7f', ' '],
  s11_han_ctrlc: ['한', '\x03'],
  s12a_ctrlspace_switch: ['하', 's', ' ', 'ㄴ', ' '],
  s13_deactivate: ['하', 'ㄴ', ' '],
  s14_focus_elsewhere: ['하', 'ㄴ', ' '],
  s15_fast_burst: ['한', '글', ' '],
  s16_rollover: ['한', '글', ' '],
  t_busy_mainthread: ['한', '글', ' '],
  t_dom_renderer_hangul: ['한', '글', ' '],
};

describe('Korean inline IME: the stand-in for xterm is faithful', () => {
  test('HI-01: with no binding, every recording sends exactly what xterm 5.5 sent', () => {
    for (const [name, rows] of Object.entries(RECORDINGS)) {
      const { bytes, today } = replay(rows, { binding: false });
      assert.deepEqual(bytes, today, `${name}: the stand-in disagrees with the recording`);
    }
  });

  test('HI-02: …which is the defect: 한글 reached the shell as ㅎ ㄱ', () => {
    assert.deepEqual(replay(RECORDINGS.s01_clean_hangul_space, { binding: false }).bytes, ['ㅎ', 'ㄱ', ' ']);
    assert.deepEqual(
      replay(RECORDINGS.s15_fast_burst, { binding: false }).bytes,
      ['ㅎ', ' '],
      'typed fast, a whole syllable vanished'
    );
  });
});

describe('Korean inline IME: every recorded scenario reaches the program whole', () => {
  const SCENARIOS = [
    ['HI-10', 's01_clean_hangul_space', '한글 + Space'],
    ['HI-11', 's02_annyeong_enter', '안녕하세요 + Enter'],
    ['HI-12', 's03_gana_tab', '가나 + Tab (간 rewritten to 가 as 나 begins)'],
    ['HI-13', 's04_kka_dot', 'Shift+ㄱ ㅏ + . (Shift pressed before the jamo)'],
    ['HI-14', 's05_wa_digit', '와 + 1'],
    ['HI-15', 's06_eops_esc', '없 + Esc'],
    ['HI-16', 's07_han_left', '한 + ←'],
    ['HI-17', 's08_han_right', '한 + →'],
    ['HI-18', 's09_bs_mid', '한 ⌫⌫⌫⌫ (three ⌫ inside the syllable, the fourth past it)'],
    ['HI-19', 's10_bs_after', '한ㄱ ⌫⌫⌫ Space'],
    ['HI-20', 's11_han_ctrlc', '한 + Ctrl+C (reported as key ㅊ)'],
    ['HI-21', 's12a_ctrlspace_switch', '하, switch to ABC, s Space, back, ㄴ Space'],
    ['HI-22', 's13_deactivate', '하, another app, back, ㄴ Space'],
    ['HI-23', 's14_focus_elsewhere', '하, another input, back, ㄴ Space'],
    ['HI-24', 's15_fast_burst', '한글 + Space typed in one burst'],
    ['HI-25', 's16_rollover', '한글 + Space with rolled-over keys'],
    ['HI-26', 't_busy_mainthread', '한글 + Space with the main thread busy'],
    ['HI-27', 't_dom_renderer_hangul', '한글 + Space under the DOM renderer'],
  ];
  for (const [id, name, what] of SCENARIOS) {
    test(`${id}: ${what} → ${show(MUST_BECOME[name])}`, () => {
      const { bytes, today, term } = replay(RECORDINGS[name]);
      assert.notDeepEqual(today, MUST_BECOME[name], 'the recording should show the defect');
      assert.deepEqual(bytes, MUST_BECOME[name]);
      for (const { wasUserInput } of term.inputs) {
        assert.equal(wasUserInput, true, 'sent as typed input');
      }
    });
  }

  test('HI-28: leaving the window or the field sends the syllable then, not with the next key', () => {
    for (const name of ['s13_deactivate', 's14_focus_elsewhere']) {
      const rows = RECORDINGS[name];
      const blur = rows.findIndex((r) => r[0] === 'blur');
      assert.ok(blur > 0, `${name} has a blur`);
      assert.deepEqual(replay(rows.slice(0, blur)).bytes, [], `${name}: nothing before the blur`);
      assert.deepEqual(replay(rows.slice(0, blur + 1)).bytes, ['하'], `${name}: 하 at the blur`);
    }
  });

  test('HI-29: ⌫ on the last jamo drops it without a DEL, and keeps the textarea as it was', () => {
    const { consumed } = replay(RECORDINGS.s09_bs_mid);
    const backspaces = consumed.filter(({ row }) => row[0] === 'kd' && row[2] === 8);
    assert.equal(backspaces.length, 1, 'exactly the one ⌫ the IME passed on (keyCode 8) is taken');
    assert.equal(backspaces[0].prevented, true, 'and its default is prevented, as xterm would have');
    // The other two ⌫ came as keyCode 229, after the IME had already shrunk
    // the syllable: kept from xterm, default untouched.
    const imeKeys = consumed.filter(({ row }) => row[0] === 'kd' && row[1] === 'Backspace' && row[2] === 229);
    assert.equal(imeKeys.length, 2);
    assert.ok(imeKeys.every(({ prevented }) => !prevented), 'never preventDefault an IME key');
  });
});

describe('Korean inline IME: the preview', () => {
  test('HI-30: 한 + ← previews ㅎ, 하, 한, then nothing once 한 is sent', () => {
    const { previews } = replay(RECORDINGS.s07_han_left);
    assert.deepEqual(previews.map((p) => p.text), ['ㅎ', '하', '한', '']);
    assert.equal(previews.at(-1).flushed, '한', 'the last report says what was sent');
  });

  test('HI-31: 안녕하세요 previews each syllable as the IME rewrites it', () => {
    const { previews } = replay(RECORDINGS.s02_annyeong_enter);
    assert.deepEqual(
      previews.map((p) => p.text),
      ['ㅇ', '아', '안', 'ㄴ', '녀', '녕', 'ㅎ', '하', '핫', '하', '세', '셍', '세', '요', '']
    );
    assert.deepEqual(
      previews.filter((p) => p.flushed).map((p) => [p.flushed, p.text]),
      [['안', 'ㄴ'], ['녕', 'ㅎ'], ['하', '세'], ['세', '요'], ['요', '']],
      'a syllable is reported sent exactly when the next one begins, or at Enter'
    );
  });

  test('HI-32: it is drawn over the cursor\'s own cell, and not at all while that row is scrolled away', () => {
    // The WebGL grid measured in the app: 102x36, 7px x 21px cells.
    const screenRect = { left: 309, top: 91, width: 714, height: 756 };
    const wrapperRect = { left: 309, top: 91, width: 737, height: 760 };
    const at = (fields) => cursorCellAnchor({ screenRect, wrapperRect, cols: 102, rows: 36, ...fields });
    // The prompt `% ` ends at column 32 on the bottom row: nothing typed has to
    // be on screen first — the syllable has not been sent.
    assert.deepEqual(at({ cursorX: 32, cursorY: 35, baseY: 100, viewportY: 100 }), {
      left: 224, top: 735, cellWidth: 7, cellHeight: 21,
    });
    // Parked past the last column: drawn in the last cell, as xterm draws its own.
    assert.equal(at({ cursorX: 102, cursorY: 0 }).left, 101 * 7);
    // Scrolled back so the cursor's row is out of view.
    assert.equal(at({ cursorX: 5, cursorY: 35, baseY: 100, viewportY: 60 }), null);
    // Not laid out.
    assert.equal(cursorCellAnchor({ screenRect: { ...screenRect, width: 0 }, wrapperRect, cols: 102, rows: 36, cursorX: 1, cursorY: 1 }), null);
  });

  test('HI-33: a view scrolled back comes to the prompt when a syllable begins', () => {
    const textarea = new FakeTextarea();
    const term = new FakeTerm(textarea);
    term.buffer.active = { viewportY: 3, baseY: 40 };
    const container = new FakeContainer();
    installHangulInlineIme(term, container, { mac: true });
    textarea.value = 'ㅎ';
    textarea.selectionStart = textarea.selectionEnd = 1;
    container.dispatch(domEvent('input', textarea, { inputType: 'insertText', data: 'ㅎ', isComposing: false }));
    assert.equal(term.scrolledToBottom, 1);
  });
});

describe('Korean inline IME: rules the recordings do not reach', () => {
  test('HI-40: Shift before ㅒ does not end the syllable — ㄱ + Shift+ㅒ is 걔', () => {
    const rows = [
      ['bi', 'IT', 'ㄱ', '', 0, 0],
      ['in', 'IT', 'ㄱ', 'ㄱ', 1, 1],
      ['kd', 'ㄱ', 229, 'KeyR'],
      ['ku', 'ㄱ', 82, 'KeyR'],
      ['kd', 'Shift', 16, 'ShiftLeft', 's'],
      ['bi', 'IRT', '걔', 'ㄱ', 0, 1],
      ['in', 'IRT', '걔', '걔', 1, 1],
      ['kd', 'ㅒ', 229, 'KeyO', 's'],
      ['ku', 'ㅒ', 79, 'KeyO', 's'],
      ['ku', 'Shift', 16, 'ShiftLeft'],
      ['bi', 'IRT', '걔', '걔', 0, 1],
      ['in', 'IRT', '걔', '걔', 1, 1],
      ['kd', ' ', 32, 'Space'],
      ['kp', ' ', 32, 'Space'],
      ['bi', 'IT', ' ', '걔', 1, 1],
      ['in', 'IT', ' ', '걔 ', 2, 2],
      ['ku', ' ', 32, 'Space'],
    ];
    const shift = rows.findIndex((r) => r[1] === 'Shift');
    assert.deepEqual(replay(rows.slice(0, shift + 1)).bytes, [], 'nothing is sent at Shift');
    assert.deepEqual(replay(rows).bytes, ['걔', ' ']);
  });

  test('HI-41: a syllable the IME re-opens after it was sent is fixed with a DEL (s01: 글 still composing)', () => {
    // The IME was still composing 글 from the previous run, so the first key
    // rewrote it to 긇 before anything here had seen it start.
    const { bytes, today } = replay(RECORDINGS.s01_hangul_space);
    assert.deepEqual(today, ['하', 'ㄱ', ' '], 'today: a jamo or a syllable at random');
    assert.deepEqual(bytes, ['\x7f', '글', '한', '글', ' ']);
  });

  // 한 composed, then a click sends it; the IME has not been told and goes on.
  const HAN_THEN_CLICK = [
    ['bi', 'IT', 'ㅎ', '', 0, 0],
    ['in', 'IT', 'ㅎ', 'ㅎ', 1, 1],
    ['kd', 'ㅎ', 229, 'KeyG'],
    ['ku', 'ㅎ', 71, 'KeyG'],
    ['bi', 'IRT', '하', 'ㅎ', 0, 1],
    ['in', 'IRT', '하', '하', 1, 1],
    ['kd', 'ㅏ', 229, 'KeyK'],
    ['ku', 'ㅏ', 75, 'KeyK'],
    ['bi', 'IRT', '한', '하', 0, 1],
    ['in', 'IRT', '한', '한', 1, 1],
    ['kd', 'ㄴ', 229, 'KeyS'],
    ['ku', 'ㄴ', 83, 'KeyS'],
    ['md'],
  ];
  const SPACE = (value, at) => [
    ['kd', ' ', 32, 'Space'],
    ['kp', ' ', 32, 'Space'],
    ['bi', 'IT', ' ', value, at, at],
    ['in', 'IT', ' ', `${value} `, at + 1, at + 1],
    ['ku', ' ', 32, 'Space'],
  ];

  test('HI-42: with no mouse tracking, a click leaves the syllable pending — the IME rewriting it is not a DEL (see HI-49 for mouse tracking on)', () => {
    const rows = [
      ...HAN_THEN_CLICK,
      // ㅏ: the IME moves ㄴ into a new syllable — 한 becomes 하 + 나.
      ['bi', 'IRT', '하', '한', 0, 1],
      ['in', 'IRT', '하', '하', 1, 1],
      ['bi', 'IT', '나', '하', 1, 1],
      ['in', 'IT', '나', '하나', 2, 2],
      ['kd', 'ㅏ', 229, 'KeyK'],
      ['ku', 'ㅏ', 75, 'KeyK'],
      ['bi', 'IRT', '나', '하나', 1, 2],
      ['in', 'IRT', '나', '하나', 2, 2],
      ...SPACE('하나', 2),
    ];
    // SelectionService calls preventDefault() on mousedown, so the textarea
    // keeps focus and the IME keeps composing right through the click — with
    // the program not watching the mouse, nothing here should either: the
    // click changes nothing, and 한 is still mid-syllable after it.
    assert.deepEqual(replay(HAN_THEN_CLICK).bytes, [], 'the click sends nothing — the syllable is still pending');
    // So the rest plays out exactly as if the click had never happened: 한
    // rewritten to 하 + 나, with no DEL anywhere.
    assert.deepEqual(replay(rows).bytes, ['하', '나', ' ']);
  });

  test('HI-43: …and when the IME merely re-affirms the sent syllable, nothing is taken back', () => {
    const rows = [
      ...HAN_THEN_CLICK,
      ['bi', 'IRT', '한', '한', 0, 1],
      ['in', 'IRT', '한', '한', 1, 1],
      ['bi', 'IT', 'ㄱ', '한', 1, 1],
      ['in', 'IT', 'ㄱ', '한ㄱ', 2, 2],
      ['kd', 'ㄱ', 229, 'KeyR'],
      ['ku', 'ㄱ', 82, 'KeyR'],
      ['bi', 'IRT', 'ㄱ', '한ㄱ', 1, 2],
      ['in', 'IRT', 'ㄱ', '한ㄱ', 2, 2],
      ...SPACE('한ㄱ', 2),
    ];
    assert.deepEqual(replay(rows).bytes, ['한', 'ㄱ', ' ']);
  });

  test('HI-44: an IME key that arrives before its own rewrite still never reaches xterm mid-syllable', () => {
    // Recorded WebKit always fired the input first. Were the keydown first,
    // xterm would diff the textarea a tick later and — the length unchanged —
    // send the WHOLE textarea: `ls 하`.
    const rows = [
      ['bi', 'IT', 'ㅎ', 'ls ', 3, 3],
      ['in', 'IT', 'ㅎ', 'ls ㅎ', 4, 4],
      ['kd', 'ㅎ', 229, 'KeyG'],
      ['ku', 'ㅎ', 71, 'KeyG'],
      ['kd', 'ㅏ', 229, 'KeyK'],
      ['same'],
      ['bi', 'IRT', '하', 'ls ㅎ', 3, 4],
      ['same'],
      ['in', 'IRT', '하', 'ls 하', 4, 4],
      ['ku', 'ㅏ', 75, 'KeyK'],
      ['bi', 'IRT', '하', 'ls 하', 3, 4],
      ['in', 'IRT', '하', 'ls 하', 4, 4],
      ...SPACE('ls 하', 4),
    ];
    assert.deepEqual(replay(rows, { binding: false }).bytes, ['ㅎ', 'ls 하', ' '], 'what xterm alone would do');
    assert.deepEqual(replay(rows).bytes, ['하', ' ']);
  });

  test('HI-45: anything else typed mid-syllable goes after the syllable', () => {
    const rows = [
      ['bi', 'IT', 'ㅎ', '', 0, 0],
      ['in', 'IT', 'ㅎ', 'ㅎ', 1, 1],
      ['kd', 'ㅎ', 229, 'KeyG'],
      ['ku', 'ㅎ', 71, 'KeyG'],
      ['bi', 'IRT', '하', 'ㅎ', 0, 1],
      ['in', 'IRT', '하', '하', 1, 1],
      ['kd', 'ㅏ', 229, 'KeyK'],
      ['ku', 'ㅏ', 75, 'KeyK'],
      // A character inserted with no keydown of its own (an emoji picker, a
      // dictation result): xterm's to send — after 하.
      ['bi', 'IT', '!', '하', 1, 1],
      ['in', 'IT', '!', '하!', 2, 2],
    ];
    assert.deepEqual(replay(rows).bytes, ['하', '!']);
  });

  test('HI-46: an IME key with nothing pending and nothing consumed is left to xterm', () => {
    const ime = createHangulInlineIme();
    assert.deepEqual(ime.keyDown({ keyCode: 229, key: 'Process', value: '' }), { consume: false, preventDefault: false });
    // So is every key while nothing is pending.
    for (const keyCode of [8, 13, 27, 37, 65]) {
      assert.equal(ime.keyDown({ keyCode, key: 'x', value: '' }).consume, false, `keyCode ${keyCode}`);
    }
  });

  test('HI-47: only the terminal\'s own textarea is watched', () => {
    const textarea = new FakeTextarea();
    const term = new FakeTerm(textarea);
    const container = new FakeContainer();
    installHangulInlineIme(term, container, { mac: true });
    const other = new FakeTextarea();
    other.value = 'ㅎ';
    other.selectionStart = other.selectionEnd = 1;
    const event = domEvent('input', other, { inputType: 'insertText', data: 'ㅎ', isComposing: false });
    container.dispatch(event);
    assert.equal(event.propagationStopped, false);
    assert.equal(hangulImeFor(term).pending, '');
  });

  test('HI-48: what counts as Hangul', () => {
    for (const ch of ['ㅎ', 'ㅏ', '한', '힣', 'ᄀ', 'ힰ', 'ꥠ']) assert.ok(isHangulCharacter(ch), ch);
    for (const ch of ['a', ' ', '1', '.', 'あ', '中', '한글', '', null]) {
      assert.equal(isHangulCharacter(ch), false, JSON.stringify(ch));
    }
  });

  test('HI-49: with mouse tracking ON, a click DOES send the syllable — the program needs it in order', () => {
    // Same click as HI-42, but the program has asked for mouse events (CSI
    // ?1000h or similar): the click is about to reach it, so the syllable
    // has to go out ahead of it, same as any other key composing cannot
    // absorb.
    assert.deepEqual(
      replay(HAN_THEN_CLICK, { mouseTracking: true }).bytes,
      ['한'],
      'the click sends it'
    );
    // The IME itself does not know anything was flushed early and carries on
    // composing regardless — unchanged from before this terminal cared about
    // mouse tracking at all: the DEL correction is this file's HI-42 of old.
    const rows = [
      ...HAN_THEN_CLICK,
      ['bi', 'IRT', '하', '한', 0, 1],
      ['in', 'IRT', '하', '하', 1, 1],
      ['bi', 'IT', '나', '하', 1, 1],
      ['in', 'IT', '나', '하나', 2, 2],
      ['kd', 'ㅏ', 229, 'KeyK'],
      ['ku', 'ㅏ', 75, 'KeyK'],
      ['bi', 'IRT', '나', '하나', 1, 2],
      ['in', 'IRT', '나', '하나', 2, 2],
      ...SPACE('하나', 2),
    ];
    assert.deepEqual(replay(rows, { mouseTracking: true }).bytes, ['한', '\x7f', '하', '나', ' ']);
  });

  test('HI-63: with mouse tracking ON, a Shift- or ⌥-click selects instead — nothing reaches the program, nothing is sent', () => {
    // src/lib/mouseReporting.js: inside a program that tracks the mouse, Shift
    // (and ⌥, macOS) turns a press into a selection. The click never reaches
    // the program, so there is nothing to go out ahead of — and flushing
    // anyway is HI-42's DEL all over again once the IME carries on composing.
    for (const mods of [{ shiftKey: true }, { altKey: true }, { shiftKey: true, altKey: true }]) {
      const click = [...HAN_THEN_CLICK.slice(0, -1), ['md', mods]];
      assert.deepEqual(replay(click, { mouseTracking: true }).bytes, [], `${JSON.stringify(mods)}: nothing sent`);
      const rows = [
        ...click,
        ['bi', 'IRT', '하', '한', 0, 1],
        ['in', 'IRT', '하', '하', 1, 1],
        ['bi', 'IT', '나', '하', 1, 1],
        ['in', 'IT', '나', '하나', 2, 2],
        ['kd', 'ㅏ', 229, 'KeyK'],
        ['ku', 'ㅏ', 75, 'KeyK'],
        ['bi', 'IRT', '나', '하나', 1, 2],
        ['in', 'IRT', '나', '하나', 2, 2],
        ...SPACE('하나', 2),
      ];
      assert.deepEqual(replay(rows, { mouseTracking: true }).bytes, ['하', '나', ' '], `${JSON.stringify(mods)}: no DEL`);
    }
    // A Shift-click with the RIGHT button is not a selection on macOS: it still reaches the program.
    assert.deepEqual(
      replay([...HAN_THEN_CLICK.slice(0, -1), ['md', { shiftKey: true, button: 2 }]], { mouseTracking: true }).bytes,
      ['한']
    );
  });
});

describe('Korean inline IME: composition events stay xterm\'s', () => {
  test('HI-50: Safari switching to composition mid-word: only the pending ㅎ is sent, at compositionstart', () => {
    const { bytes, today, term, consumed } = replay(RECORDINGS.t_c_safari_xterm);
    assert.deepEqual(bytes, today, 'the program receives what it does today');
    assert.deepEqual(term.inputs.map((i) => i.data), ['ㅎ'], 'the binding sent only the syllable it held');
    const cs = RECORDINGS.t_c_safari_xterm.findIndex((r) => r[0] === 'cs');
    assert.deepEqual(replay(RECORDINGS.t_c_safari_xterm.slice(0, cs)).bytes, [], 'held until then');
    assert.deepEqual(replay(RECORDINGS.t_c_safari_xterm.slice(0, cs + 1)).bytes, ['ㅎ']);
    for (const { row } of consumed) {
      assert.ok(row.length < 7 || !row[6], `a composition event was taken: ${JSON.stringify(row)}`);
      assert.ok(!['cs', 'cu', 'ce'].includes(row[0]), `a composition event was taken: ${JSON.stringify(row)}`);
    }
  });

  test('HI-51: composition from the first key passes through untouched', () => {
    for (const name of ['t_c_safari_xterm2', 't_c_safari_fresh_xterm']) {
      const { bytes, today, term, consumed } = replay(RECORDINGS[name]);
      assert.deepEqual(bytes, today, `${name}: the program receives what it does today`);
      assert.deepEqual(term.inputs, [], `${name}: the binding sent nothing`);
      assert.deepEqual(consumed, [], `${name}: the binding took no event`);
    }
  });
});

describe('Korean inline IME: installed on macOS only', () => {
  test('HI-60: off macOS nothing is installed and every recording behaves as it does today', () => {
    const textarea = new FakeTextarea();
    const term = new FakeTerm(textarea);
    const container = new FakeContainer();
    assert.equal(installHangulInlineIme(term, container, { mac: false }), null);
    assert.equal(container.listeners.length, 0, 'no listener added');
    assert.equal(term.addons.length, 0, 'no addon loaded');
    assert.equal(hangulImeFor(term), null);
    for (const [name, rows] of Object.entries(RECORDINGS)) {
      const { bytes, today } = replay(rows, { mac: false });
      assert.deepEqual(bytes, today, name);
    }
  });

  test('HI-61: by default it follows the platform the app runs on', () => {
    const term = new FakeTerm(new FakeTextarea());
    const container = new FakeContainer();
    const binding = installHangulInlineIme(term, container);
    assert.equal(Boolean(binding), isMac, `isMac is ${isMac} in this process`);
    assert.equal(container.listeners.length > 0, isMac);
  });

  test('HI-62: once per terminal, in the capture phase, and gone with the terminal', () => {
    const term = new FakeTerm(new FakeTextarea());
    const container = new FakeContainer();
    const first = installHangulInlineIme(term, container, { mac: true });
    const second = installHangulInlineIme(term, container, { mac: true });
    assert.equal(first, second, 'a second install is the same binding');
    assert.equal(term.addons.length, 1);
    assert.equal(hangulImeFor(term), first);
    const types = container.listeners.map((l) => l.type).sort();
    assert.deepEqual(
      types,
      ['beforeinput', 'blur', 'compositionend', 'compositionstart', 'input', 'keydown', 'mousedown'],
    );
    assert.ok(container.listeners.every((l) => l.capture), 'capture phase, ahead of xterm');
    term.dispose();
    assert.equal(container.listeners.length, 0, 'disposing the terminal removes every listener');
  });
});
