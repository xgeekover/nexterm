/**
 * Copy Context (bundle 1, A3; AC11): src/lib/copyContext.js.
 *
 * A terminal's last N logical lines go on the clipboard as plain text — a
 * wrapped line joined into one, no escape codes — with secrets masked the way
 * `nexterm-cli read-screen` masks them. N is the Copy Context Lines setting,
 * 1..10000, 200 by default. The menu label names N and says the secrets are
 * masked. A terminal never shown has no screen: the item is off and says why,
 * and nothing is copied. The text goes to copyText and nowhere else — no file,
 * no scrollback command, nothing through the backend — and it goes there
 * synchronously, inside the click or Enter (macOS WebKit, release check H9).
 *
 * Terminals are `@xterm/headless`. CC-99 puts the source, the globals and
 * the mock back.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { readScreen } from '../../src/lib/controlScreen.js';
import { SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import { buildPaletteGroups, paletteCommands } from '../../src/lib/paletteItems.js';
import {
  COPY_CONTEXT_DEFAULT_LINES,
  COPY_CONTEXT_MAX_LINES,
  COPY_CONTEXT_MIN_LINES,
  NEVER_SHOWN_REASON,
  NOTHING_PRINTED_REASON,
  clampContextLines,
  contextText,
  contextTerminalOf,
  copyContextItem,
  copyContextLabel,
  copyContextOfTab,
  copyTerminalContext,
  setContextTerminalSource,
} from '../../src/lib/copyContext.js';

const { Terminal } = headless;

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

/** A file of the source tree, its line ends as LF whatever the checkout made them. */
const source = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const COLS = 40;
// An old-style OpenAI key: masked by the generic `sk-` rule.
const SECRET = `sk-${'A1b2C3d4E5'.repeat(4)}`;
const WRAPPED = (i) => `line ${i} ${'w'.repeat(70)} end`;

/**
 * Line `i` (1-based) of the 300 the terminal is given: every 25th one wraps
 * over three rows, line 250 holds the secret (wrapped too), every 10th one is
 * coloured, and line 40 holds a second secret that N=200 leaves out.
 */
function plainLine(i) {
  if (i === 250) return `line ${i} key=${SECRET} after the key, wrapped`;
  if (i === 40) return `line ${i} ${SECRET}`;
  if (i % 25 === 0) return WRAPPED(i);
  return `line ${i}`;
}
const drawnLine = (i) => (i % 10 === 0 && i !== 250 ? `\x1b[1;31m${plainLine(i)}\x1b[0m` : plainLine(i));

/** A shown terminal with the 300 lines on it, the cursor under the last one. */
async function terminalWith300() {
  const term = new Terminal({ cols: COLS, rows: 10, scrollback: 2000, allowProposedApi: true });
  let data = '';
  for (let i = 1; i <= 300; i += 1) data += `${drawnLine(i)}\r\n`;
  await write(term, data);
  return term;
}

/** What was in place before this file: CC-99 puts it back. */
const saved = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  invoke: mockBridge.invoke,
};
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

/** Every backend command while `fn` runs, and every clipboard write. */
async function watched(fn) {
  const commands = [];
  const clipboard = [];
  const original = mockBridge.invoke;
  mockBridge.invoke = function (command, args, ...rest) {
    commands.push(command);
    return original.call(this, command, args, ...rest);
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  setGlobal('navigator', { clipboard: { writeText: async (text) => { clipboard.push(text); } } });
  try {
    await fn({ commands, clipboard });
  } finally {
    mockBridge.invoke = original;
    if (before) Object.defineProperty(globalThis, 'navigator', before);
    else delete globalThis.navigator;
  }
  return { commands, clipboard };
}

describe('Copy Context: the last N lines of a terminal, plain, secrets masked', () => {
  test('CC-01: N is a whole number from 1 to 10000, 200 by default — and the setting starts at 200', () => {
    assert.equal(COPY_CONTEXT_DEFAULT_LINES, 200);
    assert.equal(COPY_CONTEXT_MIN_LINES, 1);
    assert.equal(COPY_CONTEXT_MAX_LINES, 10000);
    assert.equal(SETTINGS_DEFAULTS.terminalCopyContextLines, 200, 'the Copy Context Lines setting');
    const cases = [
      [200, 200], [1, 1], [10000, 10000], [0, 1], [-5, 1], [10001, 10000], [1e9, 10000], [2.9, 2], [199.99, 199],
      [undefined, 200], [null, 200], [NaN, 200], [Infinity, 200], [-Infinity, 200], ['50', 200], ['', 200], [{}, 200], [true, 200],
    ];
    for (const [value, expected] of cases) assert.equal(clampContextLines(value), expected, `clampContextLines(${String(value)})`);
  });

  test('CC-02: 300 lines with wrapped ones and a secret, N=200 — exactly the last 200 logical lines, plain text, the secret [hidden]', async () => {
    const term = await terminalWith300();
    const context = contextText(term, 200);
    const lines = context.text.split('\n');
    assert.equal(lines.length, 200, 'exactly 200 lines');
    assert.equal(context.lines, 200);
    assert.equal(lines[0], 'line 101', 'the first is line 101: the 100 before it are left out');
    assert.equal(lines.at(-1), WRAPPED(300), 'the last is line 300, whole, and no blank row under it');
    for (let k = 0; k < 200; k += 1) {
      const i = 101 + k;
      if (i === 250) continue;
      assert.equal(lines[k], plainLine(i), `line ${i} as plain text, a wrapped one joined`);
    }
    assert.ok(!/\x1b|\u009b/.test(context.text), 'no escape codes');
    assert.ok(!context.text.includes(SECRET.slice(3)), 'the key is not in the text');
    assert.ok(lines[149].startsWith('line 250 key='), lines[149]);
    assert.ok(lines[149].includes('[hidden]'), lines[149]);
    assert.ok(lines[149].endsWith(' after the key, wrapped'), 'the words after the key are kept');
    assert.ok(context.hidden >= 1, 'one secret masked at least');
    assert.equal(context.truncated, false);
    assert.equal(context.alternate, false);
    // The same masking and the same lines as read-screen.
    assert.equal(context.text, readScreen(term, { lines: 200, mask: true }).lines.join('\n'));
    // The whole 300: the secret on line 40 is masked too.
    const all = contextText(term, 10000);
    assert.equal(all.lines, 300);
    assert.ok(!all.text.includes(SECRET.slice(3)));
    assert.equal(all.text.split('\n')[39], 'line 40 sk-[hidden]');
    term.dispose();
  });

  test('CC-03: N is clamped where it is read — 0 copies the last line, too many copies what there is, junk copies 200', async () => {
    const term = await terminalWith300();
    assert.deepEqual(contextText(term, 0).text.split('\n'), [WRAPPED(300)]);
    assert.deepEqual(contextText(term, -3).text.split('\n'), [WRAPPED(300)]);
    assert.deepEqual(contextText(term, 2.9).text.split('\n'), ['line 299', WRAPPED(300)]);
    assert.equal(contextText(term, 50000).lines, 300, '10000 asked, 300 there');
    assert.equal(contextText(term, 'abc').lines, 200);
    assert.equal(contextText(term, undefined).lines, 200);
    assert.equal(contextText(null, 200), null, 'no terminal, no text');
    // A full-screen program's screen while it is up, as read-screen reads it.
    await write(term, '\x1b[?1049h\x1b[Htop - 12:00\r\nPID USER');
    const alt = contextText(term, 200);
    assert.equal(alt.alternate, true);
    assert.equal(alt.text, 'top - 12:00\nPID USER');
    term.dispose();
  });

  test('CC-04: the label names N and says the secrets are masked', () => {
    assert.equal(copyContextLabel(200), 'Copy Last 200 Lines (Secrets Masked)');
    assert.equal(copyContextLabel(50), 'Copy Last 50 Lines (Secrets Masked)');
    assert.equal(copyContextLabel(1), 'Copy Last 1 Line (Secrets Masked)');
    assert.equal(copyContextLabel(0), 'Copy Last 1 Line (Secrets Masked)', 'clamped like the copy');
    assert.equal(copyContextLabel(99999), 'Copy Last 10000 Lines (Secrets Masked)');
    assert.equal(copyContextLabel(undefined), 'Copy Last 200 Lines (Secrets Masked)');
    const item = copyContextItem({ tabId: 't1', lines: 75, available: true });
    assert.equal(item.label, 'Copy Last 75 Lines (Secrets Masked)');
    assert.equal(item.key, 'copy-context');
    assert.equal(item.disabled, false);
    assert.equal(item.disabledReason, undefined);
  });

  test('CC-05: a terminal never shown — the item is off and says why, and nothing is copied', async () => {
    const copied = [];
    const copy = (text) => {
      copied.push(text);
      return Promise.resolve(true);
    };
    assert.deepEqual(copyTerminalContext(null, 200, { copy }), { ok: false, reason: NEVER_SHOWN_REASON });
    assert.match(NEVER_SHOWN_REASON, /not been shown/);

    // No registry (Node): every terminal reads as never shown.
    setContextTerminalSource(null);
    assert.equal(contextTerminalOf('t1'), null);
    const off = copyContextItem({ tabId: 't1', lines: 200, copy });
    assert.equal(off.disabled, true);
    assert.equal(off.disabledReason, NEVER_SHOWN_REASON);
    assert.equal(off.label, 'Copy Last 200 Lines (Secrets Masked)', 'the label still names N');
    off.onSelect();
    assert.deepEqual(copyContextOfTab('t1', 200, { copy }), { ok: false, reason: NEVER_SHOWN_REASON });

    // The registry knows the shown one; another tab, and a lookup that throws, are never shown.
    const term = await terminalWith300();
    const unregister = setContextTerminalSource((tabId) => {
      if (tabId === 'boom') throw new Error('gone');
      return tabId === 'shown' ? term : null;
    });
    try {
      assert.equal(copyContextItem({ tabId: 'hidden', lines: 200, copy }).disabled, true);
      assert.equal(copyContextItem({ tabId: 'boom', lines: 200, copy }).disabled, true);
      assert.equal(copyContextItem({ tabId: null, lines: 200, copy }).disabled, true);
      const on = copyContextItem({ tabId: 'shown', lines: 200, copy });
      assert.equal(on.disabled, false);
      assert.equal(copied.length, 0, 'nothing copied for the ones never shown');
      on.onSelect();
      assert.equal(copied.length, 1, 'copied as the item is picked, before anything is awaited');
      assert.equal(copied[0], contextText(term, 200).text);

      // Shown, but nothing printed: nothing to copy, said so.
      const empty = new Terminal({ cols: COLS, rows: 5, allowProposedApi: true });
      assert.deepEqual(copyTerminalContext(empty, 200, { copy }), { ok: false, reason: NOTHING_PRINTED_REASON });
      assert.equal(copied.length, 1);
      empty.dispose();
    } finally {
      unregister();
      term.dispose();
    }
    assert.equal(contextTerminalOf('shown'), null, 'unregistered');
  });

  test('CC-06: the text goes to copyText — the clipboard, in the same turn — and nothing goes through the backend, a file or the scrollback', async () => {
    const term = await terminalWith300();
    const unregister = setContextTerminalSource((tabId) => (tabId === 'shown' ? term : null));
    let result = null;
    let sync = null;
    try {
      const { commands, clipboard } = await watched(async ({ clipboard: written }) => {
        result = copyContextOfTab('shown', 200);
        sync = [...written];
        assert.equal(await result.copied, true, 'the clipboard took it');
      });
      assert.equal(sync.length, 1, 'navigator.clipboard.writeText was called before copyContextOfTab returned');
      assert.deepEqual(clipboard, [contextText(term, 200).text]);
      assert.equal(result.ok, true);
      assert.equal(result.lines, 200);
      assert.ok(result.hidden >= 1);
      assert.deepEqual(commands, [], 'no backend command at all — no fs_*, no scrollback_*');
    } finally {
      unregister();
      term.dispose();
    }
    // A copy that throws or refuses is a false, never a throw.
    const t2 = await terminalWith300();
    try {
      assert.equal(await copyTerminalContext(t2, 5, { copy: () => { throw new Error('no'); } }).copied, false);
      assert.equal(await copyTerminalContext(t2, 5, { copy: () => Promise.reject(new Error('no')) }).copied, false);
    } finally {
      t2.dispose();
    }
    // The module itself reaches nothing else: read-screen's reader and copyText.
    const src = source('src/lib/copyContext.js');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['./controlScreen.js', './copyText.js']);
    assert.doesNotMatch(src, /invoke\(|ipc\.js|writeFile|scrollback_|fs_/);
  });

  test('CC-07: listed in the palette — the label with N, off for a terminal never shown — and run without an await before the copy', () => {
    const find = (groups) => groups.flatMap((g) => g.items).find((i) => i.command === 'copy_terminal_context');
    const base = paletteCommands().find((c) => c.command === 'copy_terminal_context');
    assert.ok(base, 'a palette command copy_terminal_context');
    assert.equal(base.shortcut ?? null, null, 'no default chord');
    const listed = find(buildPaletteGroups({ query: 'copy last' }));
    assert.ok(listed, 'listed when the caller says nothing of it');
    assert.equal(listed.title, 'Copy Last 200 Lines (Secrets Masked)');
    const named = find(buildPaletteGroups({ query: 'copy last', copyContext: { lines: 350 } }));
    assert.equal(named.title, 'Copy Last 350 Lines (Secrets Masked)');
    assert.ok(find(buildPaletteGroups({ query: 'context', copyContext: { lines: 350 } })), '"context" finds it');
    assert.equal(find(buildPaletteGroups({ query: 'copy last', copyContext: null })), undefined, 'not listed for a terminal never shown, or none');
    assert.equal(base.title, 'Copy Last 200 Lines (Secrets Masked)', 'the list itself is not changed by a caller');

    const palette = source('src/components/command/CommandPalette.jsx');
    const at = palette.indexOf("case 'copy_terminal_context':");
    assert.ok(at > 0, "CommandPalette runs case 'copy_terminal_context'");
    const body = palette.slice(at, palette.indexOf('return;', at));
    assert.match(body, /copyContextOfTab\(useTerminalStore\.getState\(\)\.activeTabId, useSettingsStore\.getState\(\)\.terminalCopyContextLines\)/);
    assert.doesNotMatch(body, /\bawait\b/, 'nothing awaited before the copy');
    // The pick reaches runItem with nothing awaited on the way: an Enter or a
    // click calls handleSelect, which calls runItem before its first await.
    const select = palette.slice(palette.indexOf('const handleSelect = async'));
    const firstAwait = select.search(/\bawait\b/);
    assert.ok(firstAwait > 0 && select.slice(firstAwait).startsWith('await runItem(item)'), 'handleSelect awaits nothing before runItem');
    assert.match(palette, /copyContext: activeTabId && contextTerminalOf\(activeTabId\) \? \{ lines: copyContextLines \} : null/, 'buildPaletteGroups is told whether the active terminal was shown');
  });

  test('CC-08: wired — the registry registers its lookup; the chip menu and the TERMINALS row offer it after Copy Path, with the setting', () => {
    const registry = source('src/components/terminal/terminalRegistry.js');
    assert.match(registry, /import \{ setContextTerminalSource \} from '\.\.\/\.\.\/lib\/copyContext\.js';/);
    assert.match(registry, /\nsetContextTerminalSource\(existingTerminal\);/, 'read synchronously from the registry, not after output');

    for (const file of ['src/components/terminal/TerminalSplitContainer.jsx', 'src/components/terminal/TerminalsPanel.jsx']) {
      const src = source(file);
      const copyPath = src.indexOf("key: 'copy-path'");
      const item = src.indexOf('copyContextItem({', copyPath);
      assert.ok(copyPath > 0 && item > copyPath, `${file}: the item after Copy Path`);
      const next = src.indexOf("key: '", copyPath + 10);
      assert.ok(item < next, `${file}: right after Copy Path`);
      assert.match(src, /terminalCopyContextLines/, `${file}: N from the setting`);
      assert.match(src, /import \{ copyContextItem \} from '\.\.\/\.\.\/lib\/copyContext\.js';/, file);
    }
  });

  test('CC-99: the source, the globals and the mock as they were', () => {
    setContextTerminalSource(null);
    mockBridge.invoke = saved.invoke;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
    else delete globalThis.navigator;
    assert.equal(contextTerminalOf('shown'), null);
    assert.equal(mockBridge.invoke, saved.invoke);
  });
});
