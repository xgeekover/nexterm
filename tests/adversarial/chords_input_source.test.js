/**
 * Shortcuts keep working while a non-Latin input source is active.
 *
 * Recorded in the real app on macOS with the 2-Set Korean input source:
 * Ctrl+C arrives as `key: 'ㅊ', code: 'KeyC'`. `chordMatches` compared
 * `e.key`, so every letter shortcut matched in JS — ⌘B, ⌘K, ⌘P, ⌘F, ⌘L… —
 * did nothing while Korean was the input source, and recording a shortcut in
 * Settings stored `mod+ㅊ`, a chord nothing could ever press with the Latin
 * layout on. A letter or digit key now reads as the character its `code`
 * stands for whenever `e.key` is not ASCII; an ASCII `e.key` is untouched.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { parseChord, stringifyChord, chordMatches, chordFromEvent } from '../../src/lib/chords.js';
import { DEFAULT_RESOLVED } from '../../src/lib/keybindings.js';

const ev = (o = {}) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '', ...o });

/** What the 2-Set Korean input source reports as `e.key` for each letter key. */
const KOREAN = {
  q: 'ㅂ', w: 'ㅈ', e: 'ㄷ', r: 'ㄱ', t: 'ㅅ', y: 'ㅛ', u: 'ㅕ', i: 'ㅑ', o: 'ㅐ', p: 'ㅔ',
  a: 'ㅁ', s: 'ㄴ', d: 'ㅇ', f: 'ㄹ', g: 'ㅎ', h: 'ㅗ', j: 'ㅓ', k: 'ㅏ', l: 'ㅣ',
  z: 'ㅋ', x: 'ㅌ', c: 'ㅊ', v: 'ㅍ', b: 'ㅠ', n: 'ㅜ', m: 'ㅡ',
};
const KOREAN_SHIFTED = { ...KOREAN, q: 'ㅃ', w: 'ㅉ', e: 'ㄸ', r: 'ㄲ', t: 'ㅆ', o: 'ㅒ', p: 'ㅖ' };

/** The keypress for a letter chord on macOS with the Korean input source on. */
function koreanEventFor(chord) {
  const letter = chord.key;
  return ev({
    metaKey: Boolean(chord.mod || chord.cmd),
    ctrlKey: Boolean(chord.ctrl),
    shiftKey: Boolean(chord.shift),
    altKey: Boolean(chord.alt),
    key: (chord.shift ? KOREAN_SHIFTED : KOREAN)[letter],
    code: `Key${letter.toUpperCase()}`,
  });
}

describe('Shortcuts under a non-Latin input source', () => {
  test('CH-01: every default letter shortcut fires with the Korean input source on', () => {
    const letters = DEFAULT_RESOLVED.filter((b) => /^[a-z]$/.test(b.chord.key ?? ''));
    assert.ok(letters.length >= 10, `expected the letter shortcuts, found ${letters.length}`);
    for (const binding of letters) {
      const e = koreanEventFor(binding.chord);
      assert.ok(
        chordMatches(binding.chord, e, e.metaKey),
        `${binding.key} (${binding.command}) pressed as ${JSON.stringify(e.key)} / ${e.code}`
      );
    }
  });

  test('CH-02: Ctrl+C exactly as recorded — key ㅊ, code KeyC — is ctrl+c', () => {
    const recorded = ev({ ctrlKey: true, key: 'ㅊ', code: 'KeyC' });
    assert.ok(chordMatches(parseChord('ctrl+c'), recorded, false), 'macOS: Ctrl is not the app modifier');
    assert.ok(chordMatches(parseChord('mod+c'), recorded, true), 'Windows/Linux: mod is Ctrl');
    assert.equal(chordMatches(parseChord('ctrl+x'), recorded, false), false, 'and only ctrl+c');
  });

  test('CH-03: other scripts and digits as well', () => {
    assert.ok(chordMatches(parseChord('mod+c'), ev({ metaKey: true, key: 'с', code: 'KeyC' }), true), 'Cyrillic');
    assert.ok(chordMatches(parseChord('mod+c'), ev({ metaKey: true, key: 'ψ', code: 'KeyC' }), true), 'Greek');
    assert.ok(chordMatches(parseChord('mod+0'), ev({ metaKey: true, key: 'à', code: 'Digit0' }), true), 'AZERTY 0');
  });

  test('CH-04: an ASCII key is matched exactly as before, wherever it sits', () => {
    // AZERTY puts A where QWERTY has Q; QWERTZ swaps Y and Z. The letter on
    // the key is the one that was bound.
    const azertyA = ev({ metaKey: true, key: 'a', code: 'KeyQ' });
    assert.ok(chordMatches(parseChord('mod+a'), azertyA, true));
    assert.equal(chordMatches(parseChord('mod+q'), azertyA, true), false);
    const qwertzZ = ev({ ctrlKey: true, key: 'z', code: 'KeyY' });
    assert.ok(chordMatches(parseChord('mod+z'), qwertzZ, true));
    assert.equal(chordMatches(parseChord('mod+y'), qwertzZ, true), false);
    // Shifted digits report their symbol and stay unmatched by the digit.
    assert.equal(chordMatches(parseChord('mod+1'), ev({ metaKey: true, key: '!', code: 'Digit1' }), true), false);
    // Punctuation was always matched on `code`.
    assert.ok(chordMatches(parseChord('mod+backslash'), ev({ metaKey: true, key: '₩', code: 'Backslash' }), true));
  });

  test('CH-05: a non-ASCII key on a key that is not a letter or digit is left as reported', () => {
    assert.equal(chordMatches(parseChord('mod+a'), ev({ metaKey: true, key: 'ㅁ', code: '' }), true), false);
    assert.equal(chordMatches(parseChord('mod+a'), ev({ metaKey: true, key: 'ä', code: 'Quote' }), true), false);
  });

  test('CH-08: a character typed with AltGr or ⌥ is typed — never read as its key\'s letter', () => {
    // Windows reports AltGr as Ctrl+Alt: Polish ó is AltGr+O, Hungarian Đ is
    // AltGr+D — the very keys of `mod+alt+o` (Open Recent) and `ctrl+alt+d`
    // (Split Right) there.
    const polishO = ev({ ctrlKey: true, altKey: true, key: 'ó', code: 'KeyO' });
    assert.equal(chordMatches(parseChord('mod+alt+o'), polishO, true), false, 'Polish ó');
    const hungarianD = ev({ ctrlKey: true, altKey: true, key: 'Đ', code: 'KeyD' });
    assert.equal(chordMatches(parseChord('ctrl+alt+d'), hungarianD, true), false, 'Hungarian Đ');
    // Linux reports AltGr as its own modifier, with Ctrl and Alt up.
    const linuxAltGr = ev({ key: 'ó', code: 'KeyO', getModifierState: (m) => m === 'AltGraph' });
    assert.equal(chordMatches(parseChord('o'), linuxAltGr, false), false, 'Linux AltGr');
    // macOS ⌥ types ø, ∂ — and π and Ω, which are Greek.
    assert.equal(chordMatches(parseChord('alt+o'), ev({ altKey: true, key: 'ø', code: 'KeyO' }), false), false, '⌥O');
    assert.equal(chordMatches(parseChord('alt+p'), ev({ altKey: true, key: 'π', code: 'KeyP' }), false), false, '⌥P');
    // …and none of them is recorded as the letter either.
    assert.equal(stringifyChord(chordFromEvent(polishO, { isMod: true })), 'mod+alt+ó');
    // No Alt layer types Hangul, so a jamo with ⌥ held still names its key.
    assert.ok(chordMatches(parseChord('mod+alt+o'), ev({ metaKey: true, altKey: true, key: 'ㅐ', code: 'KeyO' }), true));
  });

  test('CH-06: recording a shortcut in Settings stores the Latin key, not the jamo', () => {
    const cases = [
      [ev({ metaKey: true, key: 'ㅊ', code: 'KeyC' }), true, 'mod+c'],
      [ev({ metaKey: true, shiftKey: true, key: 'ㅠ', code: 'KeyB' }), true, 'mod+shift+b'],
      [ev({ metaKey: true, shiftKey: true, key: 'ㅃ', code: 'KeyQ' }), true, 'mod+shift+q'],
      [ev({ ctrlKey: true, key: 'ㅊ', code: 'KeyC' }), false, 'ctrl+c'],
      [ev({ metaKey: true, key: 'с', code: 'KeyC' }), true, 'mod+c'],
    ];
    for (const [e, isMod, expected] of cases) {
      const chord = chordFromEvent(e, { isMod });
      assert.equal(stringifyChord(chord), expected, `${JSON.stringify(e.key)} / ${e.code}`);
      assert.ok(chordMatches(chord, e, isMod), `${expected}: what was pressed is what gets bound`);
    }
  });

  test('CH-07: recording an ASCII key is unchanged', () => {
    assert.equal(stringifyChord(chordFromEvent(ev({ metaKey: true, key: 'a', code: 'KeyQ' }), { isMod: true })), 'mod+a');
    assert.equal(
      stringifyChord(chordFromEvent(ev({ metaKey: true, shiftKey: true, key: 'B', code: 'KeyB' }), { isMod: true })),
      'mod+shift+b'
    );
    assert.equal(stringifyChord(chordFromEvent(ev({ key: 'F5', code: 'F5' }), { isMod: false })), 'f5');
    assert.equal(chordFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), { isMod: false }), null);
  });
});
