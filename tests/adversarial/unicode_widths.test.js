/**
 * Emoji are two cells wide to the programs that print them.
 *
 * xterm 5.5 measures with Unicode 6 tables, where every emoji is ONE cell.
 * Claude Code (`Bun.stringWidth`), Ink and most modern tools count two, and a
 * program that redraws with relative cursor moves then lands a column off for
 * every emoji to the left of the change: replayed in the app's own terminal,
 * Claude Code's repaint of `✅ 통과 13개 ❌ 실패 2개` came out
 * `✅ 통과 123  ❌ 실패 3 2`. With Unicode 11 it comes out as written.
 *
 * Of 82 characters measured against Claude Code, 56 agreed before and 75
 * agree with Unicode 11. Still different: an emoji made wide by VS16
 * (⚠️ ✔️ ❤️ ℹ️ ☑️ — 1 here, 2 in Claude Code), and skin-tone and ZWJ
 * sequences (👍🏽 👨‍💻), which go from 2 to 4 where Claude Code counts 2.
 * Those need xterm 6 and its grapheme-aware provider.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { activateUnicode11 } from '../../src/lib/terminalCompat.js';

/** xterm's unicode handling as a terminal exposes it: an unknown version is refused. */
function fakeTerminal({ proposedApi = true } = {}) {
  const versions = ['6'];
  let active = '6';
  const unicode = {
    get versions() {
      return versions.slice();
    },
    get activeVersion() {
      return active;
    },
    set activeVersion(v) {
      if (!versions.includes(v)) throw new Error(`unknown Unicode version "${v}"`);
      active = v;
    },
    register(provider) {
      versions.push(provider.version);
    },
  };
  return {
    addons: [],
    get unicode() {
      if (!proposedApi) throw new Error('You must set the allowProposedApi option to true to use proposed API');
      return unicode;
    },
    loadAddon(addon) {
      this.addons.push(addon);
      addon.activate(this);
    },
  };
}

class FakeUnicode11Addon {
  activate(terminal) {
    terminal.unicode.register({ version: '11' });
  }
}

describe('Unicode widths: emoji measured as the programs measure them', () => {
  test('UW-01: a new terminal measures with Unicode 11', () => {
    const t = fakeTerminal();
    assert.equal(activateUnicode11(t, FakeUnicode11Addon), true);
    assert.equal(t.unicode.activeVersion, '11');
    assert.equal(t.addons.length, 1, 'the addon is loaded, which is what registers the tables');
  });

  test('UW-02: a terminal that cannot have it keeps working with the default tables', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const noProposed = fakeTerminal({ proposedApi: false });
      assert.equal(activateUnicode11(noProposed, FakeUnicode11Addon), false);

      class Unregistered { activate() {} }
      const t = fakeTerminal();
      assert.equal(activateUnicode11(t, Unregistered), false, 'version 11 never registered');
      assert.equal(t.unicode.activeVersion, '6');
    } finally {
      console.warn = warn;
    }
  });

  test('UW-03: every terminal is created with it, before it is opened', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(src, /import \{ Unicode11Addon \} from '@xterm\/addon-unicode11';/);
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    const activate = create.indexOf('activateUnicode11(term, Unicode11Addon);');
    const open = create.indexOf('term.open(container);');
    assert.ok(activate > 0 && open > 0 && activate < open, 'in the creation path, ahead of the first output');
    assert.match(create, /allowProposedApi: true/, '`term.unicode` is proposed API in xterm 5');
  });

  test('UW-04: the addon is the line for xterm 5 — 0.9 needs xterm 6', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.dependencies['@xterm/addon-unicode11'], /^\^0\.8\./);
    assert.match(pkg.dependencies['@xterm/xterm'], /^\^5\./);
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    assert.match(lock.packages['node_modules/@xterm/addon-unicode11'].version, /^0\.8\./);
  });
});
