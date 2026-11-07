/**
 * `nexterm-cli send` (stage 7): key names and text as the bytes the program
 * in the target terminal expects (src/lib/controlKeys.js).
 *
 * The modes come from the target's xterm — application cursor keys (DECCKM),
 * modifyOtherKeys, bracketed paste — and each one changes what a key or a
 * multi-line text must become. Shift+Enter is checked against the encoder
 * the keyboard itself uses (modifyOtherKeys.js), so the two cannot drift.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { MAX_KEYS, MAX_TEXT_BYTES, encodeKey, encodeKeys, encodeText } from '../../src/lib/controlKeys.js';
import { encodeModifiedEnter } from '../../src/lib/modifyOtherKeys.js';

const ESC = '\x1b';
const data = (r) => {
  assert.ok(!r.error, JSON.stringify(r.error));
  return r.data;
};

describe('Control API: keys', () => {
  test('CK-01: the plain keys', () => {
    const table = {
      Enter: '\r',
      Tab: '\t',
      Backspace: '\x7f',
      Escape: ESC,
      Space: ' ',
      PageUp: `${ESC}[5~`,
      PageDown: `${ESC}[6~`,
      Insert: `${ESC}[2~`,
      Delete: `${ESC}[3~`,
      F1: `${ESC}OP`,
      F4: `${ESC}OS`,
      F5: `${ESC}[15~`,
      F12: `${ESC}[24~`,
    };
    for (const [name, bytes] of Object.entries(table)) assert.equal(data(encodeKey(name)), bytes, name);
  });

  test('CK-02: arrows, Home and End follow the target\'s application cursor mode (DECCKM)', () => {
    for (const [name, final] of [['Up', 'A'], ['Down', 'B'], ['Right', 'C'], ['Left', 'D'], ['Home', 'H'], ['End', 'F']]) {
      assert.equal(data(encodeKey(name, { applicationCursorKeys: false })), `${ESC}[${final}`, `${name} normal`);
      assert.equal(data(encodeKey(name, { applicationCursorKeys: true })), `${ESC}O${final}`, `${name} application`);
    }
  });

  test('CK-03: arrows with modifiers carry xterm\'s modifier parameter, in either mode', () => {
    assert.equal(data(encodeKey('Ctrl+Up', { applicationCursorKeys: true })), `${ESC}[1;5A`);
    assert.equal(data(encodeKey('Shift+Left')), `${ESC}[1;2D`);
    assert.equal(data(encodeKey('Alt+Right')), `${ESC}[1;3C`);
    assert.equal(data(encodeKey('Ctrl+Shift+End')), `${ESC}[1;6F`);
  });

  test('CK-04: modified Enter is what the keyboard sends at each modifyOtherKeys level', () => {
    const combos = [
      ['Shift+Enter', { shiftKey: true }],
      ['Ctrl+Enter', { ctrlKey: true }],
      ['Ctrl+Shift+Enter', { ctrlKey: true, shiftKey: true }],
      ['Alt+Shift+Enter', { altKey: true, shiftKey: true }],
      ['Ctrl+Alt+Enter', { ctrlKey: true, altKey: true }],
    ];
    for (const level of [1, 2]) {
      for (const [name, mods] of combos) {
        const keyboard = encodeModifiedEnter({ type: 'keydown', key: 'Enter', ...mods }, level);
        assert.equal(data(encodeKey(name, { modifyOtherKeys: level })), keyboard, `${name} at level ${level}`);
      }
    }
    for (const level of [1, 2]) {
      assert.equal(encodeModifiedEnter({ type: 'keydown', key: 'Enter', altKey: true }, level), null, 'the keyboard leaves Alt+Enter alone');
      assert.equal(data(encodeKey('Alt+Enter', { modifyOtherKeys: level })), `${ESC}\r`, `Alt+Enter at level ${level} stays ESC CR`);
    }
    assert.equal(data(encodeKey('Shift+Enter', { modifyOtherKeys: 0 })), '\r', 'level 0: a plain CR, as a keyboard sends');
    assert.equal(data(encodeKey('Alt+Enter', { modifyOtherKeys: 0 })), `${ESC}\r`);
  });

  test('CK-05: Ctrl with a letter or [ \\ ] ^ _ ? is the control code; anything else is refused, NUL included', () => {
    assert.equal(data(encodeKey('Ctrl+C')), '\x03');
    assert.equal(data(encodeKey('ctrl+a')), '\x01');
    assert.equal(data(encodeKey('Ctrl+Z')), '\x1a');
    assert.equal(data(encodeKey('Ctrl+[')), ESC);
    assert.equal(data(encodeKey('Ctrl+\\')), '\x1c');
    assert.equal(data(encodeKey('Ctrl+]')), '\x1d');
    assert.equal(data(encodeKey('Ctrl+^')), '\x1e');
    assert.equal(data(encodeKey('Ctrl+_')), '\x1f');
    assert.equal(data(encodeKey('Ctrl+?')), '\x7f');
    for (const name of ['Ctrl+1', 'Ctrl+@', 'Ctrl+한', 'Ctrl++']) {
      assert.equal(encodeKey(name).error?.code, 'bad_request', name);
    }
  });

  test('CK-06: Alt is ESC first, Shift a capital or a back-tab, and names have their aliases in any case', () => {
    assert.equal(data(encodeKey('Alt+x')), `${ESC}x`);
    assert.equal(data(encodeKey('Alt+Backspace')), `${ESC}\x7f`);
    assert.equal(data(encodeKey('Shift+a')), 'A');
    assert.equal(data(encodeKey('Shift+Tab')), `${ESC}[Z`);
    assert.equal(data(encodeKey('+')), '+');
    assert.equal(data(encodeKey('한')), '한');
    for (const [alias, name] of [['Return', 'Enter'], ['esc', 'Escape'], ['ArrowUp', 'Up'], ['PgDn', 'PageDown'], ['DEL', 'Delete'], ['option+x', 'Alt+x']]) {
      assert.equal(data(encodeKey(alias)), data(encodeKey(name)), alias);
    }
  });

  test('CK-07: what is not a key is said so, and the message shows the name harmlessly', () => {
    const bad = ['', 'Hyper+x', 'Ctrl+', 'NoSuchKey', 'Ctrl+F5', 'Shift+PageUp', 'x'.repeat(41), 7, null, '\x1b[31m', 'Ctrl+\x07'];
    for (const name of bad) {
      const r = encodeKey(name);
      assert.equal(r.error?.code, 'bad_request', JSON.stringify(name));
      assert.ok(!/[\u{0}-\u{1f}\u{7f}]/u.test(r.error.message), `printable message for ${JSON.stringify(name)}`);
      assert.ok(r.error.message.length < 120);
    }
    assert.equal(encodeKeys([]).error?.code, 'bad_request');
    assert.equal(encodeKeys('Enter').error?.code, 'bad_request');
    assert.equal(encodeKeys(Array(MAX_KEYS + 1).fill('Enter')).error?.code, 'bad_request');
    assert.equal(data(encodeKeys(Array(MAX_KEYS).fill('Enter'))), '\r'.repeat(MAX_KEYS));
    assert.equal(encodeKeys(['Enter', 'Nope', 'Enter']).error?.code, 'bad_request', 'the first bad key fails the call');
    assert.equal(data(encodeKeys(['Ctrl+C', 'Up', 'Enter'], { applicationCursorKeys: true })), `\x03${ESC}OA\r`);
  });
  test('CK-08: keys may not spell an escape sequence — Escape then [ ] P O, or Alt with one of them', () => {
    for (const keys of [['Escape', '['], ['Escape', 'Shift+]'], ['Esc', 'P'], ['Escape', 'O'], ['Alt+['], ['Alt+]'], ['Escape', '_'], ['Escape', '^']]) {
      assert.equal(encodeKeys(keys).error?.code, 'bad_request', JSON.stringify(keys));
    }
    // What a user does: leave insert mode and move, Alt chords, the arrows' own sequences.
    assert.equal(data(encodeKeys(['Escape', 'j', 'Escape', ':'])), `${ESC}j${ESC}:`);
    assert.equal(data(encodeKeys(['Alt+b', 'Alt+f'])), `${ESC}b${ESC}f`);
    assert.equal(data(encodeKeys(['Escape', 'Up'])), `${ESC}${ESC}[A`, 'Up after Escape is a whole key');
    assert.equal(data(encodeKeys(['Escape', 'Escape'])), `${ESC}${ESC}`);
  });
  test('CK-09: Alt+Escape is two ESCs, and an Escape that ended the last call still counts', () => {
    assert.equal(encodeKeys(['Alt+Escape', '[', '2', '0', '1', '~']).error?.code, 'bad_request', 'ESC ESC [ …');
    assert.equal(encodeKeys(['Ctrl+Alt+[', ']']).error?.code, 'bad_request', 'Ctrl+Alt+[ is ESC ESC');
    const first = encodeKeys(['Escape']);
    assert.equal(first.endsWithEscape, true);
    assert.equal(encodeKeys(['['], {}, { afterEscape: first.endsWithEscape }).error?.code, 'bad_request', 'across calls');
    assert.equal(encodeKeys(['j'], {}, { afterEscape: true }).data, 'j', 'an ordinary key after Escape is fine');
    assert.equal(encodeKeys(['Up']).endsWithEscape, false);
    assert.equal(encodeText('[201~', { afterEscape: true }).error?.code, 'refused', 'text after an Escape key');
    assert.equal(data(encodeText('[201~', { afterEscape: false })), '[201~', 'and fine on its own');
  });
});



describe('Control API: text', () => {
  test('CT-01: one line goes as it is — no Enter added', () => {
    assert.equal(data(encodeText('npm test')), 'npm test');
    assert.equal(data(encodeText('echo 한글 😀 👨\u{200d}👩\u{200d}👧 ❤\u{fe0f}')), 'echo 한글 😀 👨\u{200d}👩\u{200d}👧 ❤\u{fe0f}', 'Hangul, emoji and the ZWJ of an emoji');
    assert.equal(data(encodeText('a\tb')), 'a\tb', 'a tab is text');
  });

  test('CT-02: several lines are one bracketed paste where the program asked, line breaks as CR', () => {
    assert.equal(data(encodeText('one\ntwo\r\nthree', { bracketedPaste: true })), `${ESC}[200~one\rtwo\rthree${ESC}[201~`);
  });

  test('CT-03: where it did not, several lines are refused — unless raw, which types them as keys', () => {
    const r = encodeText('one\ntwo');
    assert.equal(r.error?.code, 'refused');
    assert.match(r.error.message, /bracketed paste/);
    assert.equal(data(encodeText('one\ntwo', { raw: true })), 'one\rtwo');
  });

  test('CT-06: one line break at the end is Enter, typed after the text and outside any paste', () => {
    assert.equal(data(encodeText('npm test\n')), 'npm test\r', 'no bracketed paste needed (cmd.exe)');
    assert.equal(data(encodeText('npm test\r\n')), 'npm test\r');
    assert.equal(data(encodeText('a\nb\n', { bracketedPaste: true })), `${ESC}[200~a\rb${ESC}[201~\r`, 'after the paste, not inside it');
    assert.equal(encodeText('a\nb\n').error?.code, 'refused', 'still several lines without bracketed paste');
    assert.equal(data(encodeText('a\nb\n', { raw: true })), 'a\rb\r');
    assert.equal(data(encodeText('\n')), '\r', 'a lone line break is Enter');
  });

  test('CT-04: controls, ESC above all (it would end a paste early), and direction characters are refused', () => {
    const refused = [
      `${ESC}[201~rm -rf ~`,
      'a\x07b',
      'a\u{0}b',
      'a\x7fb',
      'a\u{9b}31m',
      'safe \u{202e}txt.exe',
      'a\u{2067}b\u{2069}',
      'a\u{200f}b',
      'a\u{61c}b',
      '\u{feff}bom',
      'a\u{2028}b',
      'a\u{2029}b',
      'a\u{d83d}b',
    ];
    for (const text of refused) {
      const r = encodeText(text, { bracketedPaste: true, raw: true });
      assert.ok(r.error, JSON.stringify(text));
    }
    assert.equal(encodeText('').error?.code, 'bad_request');
    assert.equal(encodeText(5).error?.code, 'bad_request');
  });

  test('CT-05: at most 16 KiB of UTF-8 — counted in bytes, so Hangul counts three', () => {
    assert.ok(data(encodeText('a'.repeat(MAX_TEXT_BYTES))));
    assert.equal(encodeText('a'.repeat(MAX_TEXT_BYTES + 1)).error?.code, 'bad_request');
    const hangul = '한'.repeat(Math.floor(MAX_TEXT_BYTES / 3));
    assert.ok(data(encodeText(hangul)));
    assert.equal(encodeText(`${hangul}한`).error?.code, 'bad_request');
  });
});
