/**
 * NexTerm is a terminal first, and on Windows and Linux the app modifier is
 * the same Ctrl the shell needs. Two rules keep the two from fighting:
 *
 *   1. The app modifier is ⌘ on macOS and Ctrl elsewhere — never both. Reading
 *      `metaKey || ctrlKey` stole ^K/^B/^A from every text field on macOS;
 *      reading only `metaKey` left half the shortcuts dead on Windows.
 *   2. No native menu accelerator may be a bare Ctrl+letter, because the
 *      window resolves its accelerator table before the webview and every one
 *      of those letters means something to readline. That half is enforced in
 *      src-tauri/src/menu.rs (`no_accelerator_claims_a_bare_ctrl_letter`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, assert } from '../e2e/harness/testFramework.js';

// import() takes a URL, not a path: `D:\…` reads as the scheme `d:` on Windows.
const PLATFORM_MODULE = new URL('../../src/lib/platform.js', import.meta.url).href;
const KEYBINDINGS = fileURLToPath(new URL('../../src/hooks/useKeybindings.js', import.meta.url));

const setNavigator = (value) =>
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

/** Load platform.js as if the app were running on `os`. */
async function platformAs(os) {
  const original = globalThis.navigator;
  setNavigator(
    os === 'mac'
      ? { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
      : { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  );
  try {
    return await import(`${PLATFORM_MODULE}?as=${os}-${Math.random()}`);
  } finally {
    setNavigator(original);
  }
}

describe('App modifier follows the platform', () => {
  test('Ctrl is the modifier on Windows and ⌘ is not', async () => {
    const p = await platformAs('win');
    assert.equal(p.isMac, false);
    assert.equal(p.hasMod({ ctrlKey: true }), true);
    assert.equal(p.hasMod({ metaKey: true }), false, 'Cmd must not act as the modifier on Windows');
    assert.equal(p.modLabel, 'Ctrl');
    assert.equal(p.chord('mod', 'shift', 'd'), 'Ctrl+Shift+D');
  });

  test('⌘ is the modifier on macOS and Ctrl is not', async () => {
    const p = await platformAs('mac');
    assert.equal(p.isMac, true);
    assert.equal(p.hasMod({ metaKey: true }), true);
    assert.equal(
      p.hasMod({ ctrlKey: true }),
      false,
      'Ctrl must stay with the terminal on macOS — ^K, ^A and ^B are readline'
    );
    assert.equal(p.modLabel, '⌘');
    assert.equal(p.chord('mod', 'shift', 'd'), '⌘⇧D');
  });

  test('hasMod answers with a boolean, not undefined', async () => {
    const p = await platformAs('win');
    assert.equal(p.hasMod({}), false);
  });
});

describe('Global shortcuts go through hasMod', () => {
  // useKeybindings is a React hook bound to a real window, so this reads the
  // source instead: the failure it guards against is a chord that silently
  // never fires on one platform, which no unit test would notice either.
  const source = readFileSync(KEYBINDINGS, 'utf8');

  test('no shortcut reads metaKey, and ctrlKey only for the Ctrl-on-every-platform chords', () => {
    // ⌃` and ⌃⇧` are Ctrl everywhere, macOS included — they match VS Code and
    // the accelerators in menu.rs. Everything else must go through hasMod.
    const offenders = source
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
        if (/\be\.metaKey\b/.test(line)) return true;
        return /\be\.ctrlKey\b/.test(line) && !/Backquote/.test(line);
      });
    assert.deepEqual(
      offenders,
      [],
      `these lines bypass hasMod and will misbehave on one platform:\n${offenders
        .map(([n, l]) => `  ${n}: ${l.trim()}`)
        .join('\n')}`
    );
  });

  test('it imports the platform helper', () => {
    assert.equal(/import \{[^}]*\bhasMod\b[^}]*\} from '\.\.\/lib\/platform\.js'/.test(source), true);
  });
});
