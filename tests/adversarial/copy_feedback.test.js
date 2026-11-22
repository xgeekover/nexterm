/**
 * What a copy says once it is done (bundle 3, U6-F3, AC17):
 * src/lib/copyFeedback.js, Copy Context's default onSelect
 * (src/lib/copyContext.js), and where Copy Path (the TERMINALS row, the tab
 * chip, the Explorer), Copy Session ID (AGENT SESSIONS) and the palette's
 * Copy Context are wired to it.
 *
 * The copies are mocked (a `copy` handed in, or a stood-in
 * navigator.clipboard), the toast store runs on timers of its own and is
 * reset after every case, whether it passes or fails (`cleanly`), and CF-99
 * checks the teardown. The copy must begin inside the call, before anything
 * is awaited (macOS WebKit, release check H9); only the toast waits for it.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  NOTHING_TO_COPY,
  NOT_COPIED,
  NO_DIRECTORY_REASON,
  NO_DIRECTORY_YET,
  PATH_COPIED,
  SESSION_ID_COPIED,
  confirmContextCopy,
  contextCopiedText,
  copyAndConfirm,
  notCopiedBecause,
} from '../../src/lib/copyFeedback.js';
import {
  NEVER_SHOWN_REASON,
  NOTHING_PRINTED_REASON,
  contextTerminalOf,
  contextText,
  copyContextItem,
  setContextTerminalSource,
} from '../../src/lib/copyContext.js';
import { agentSessionRowItems } from '../../src/components/terminal/agentSessionsModel.js';
import { TOAST_MS, resetToasts, setToastTimers, useToastStore } from '../../src/stores/toastStore.js';

const { Terminal } = headless;

/** A file of the source tree, its line ends as LF whatever the checkout made them. */
const source = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const toasts = () => useToastStore.getState().toasts.map((t) => [t.kind, t.text]);
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

/** What was in place before this file: CF-99 checks it is back. */
const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
const putBack = (name) => {
  if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
  else delete globalThis[name];
};
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

/** Timers on a clock of their own: `live` how many are set and not yet fired or cleared. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    get live() {
      return timers.size;
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) if (timer.at <= target && (!due || timer.at < due[1].at)) due = [id, timer];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** A case that ends clean whether it passes or fails: no toast, no timer, no terminal source, the globals back. */
const cleanly = (body) => async () => {
  const time = fakeTimers();
  setToastTimers(time);
  try {
    await body(time);
  } finally {
    resetToasts();
    setContextTerminalSource(null);
    putBack('navigator');
    putBack('document');
  }
};

/** A copy that notes each text and answers `answer` (a value, or a function of the text). */
function mockCopy(answer) {
  const copied = [];
  const copy = (text) => {
    copied.push(text);
    return typeof answer === 'function' ? answer(text) : Promise.resolve(answer);
  };
  return { copied, copy };
}

/** A shown terminal holding `n` lines, `line 1` to `line n`, the cursor under the last one. */
async function terminalWith(n) {
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 2000, allowProposedApi: true });
  let data = '';
  for (let i = 1; i <= n; i += 1) data += `line ${i}\r\n`;
  await write(term, data);
  return term;
}

describe('Copy feedback: Copy Path, Copy Context and Copy Session ID say what they did (U6-F3, AC17)', () => {
  test('CF-1: a true copy — the text copied inside the call, then one confirmation that goes after TOAST_MS', cleanly(async (time) => {
    const { copied, copy } = mockCopy(true);
    const done = copyAndConfirm('/Users/me/proj', PATH_COPIED, { copy });
    assert.deepEqual(copied, ['/Users/me/proj'], 'copied before copyAndConfirm returned, nothing awaited first');
    assert.deepEqual(toasts(), [], 'the toast waits for the clipboard');
    assert.equal(await done, true, 'resolves with whether it was copied');
    assert.deepEqual(toasts(), [['confirm', 'Path copied']]);
    assert.equal(PATH_COPIED, 'Path copied');
    assert.equal(time.live, 1, "the confirmation's one timer");
    time.advance(TOAST_MS);
    assert.deepEqual(toasts(), [], 'gone after TOAST_MS');
    // A copy that answers synchronously is as good as one that answers later.
    assert.equal(await copyAndConfirm('id', SESSION_ID_COPIED, { copy: () => true }), true);
    assert.deepEqual(toasts(), [['confirm', 'Session ID copied']]);
  }));

  test('CF-2: a false copy — an error that stays until dismissed; a copy that throws or rejects is a false, never a throw', cleanly(async (time) => {
    const { copied, copy } = mockCopy(false);
    assert.equal(await copyAndConfirm('/Users/me/proj', PATH_COPIED, { copy }), false);
    assert.deepEqual(copied, ['/Users/me/proj']);
    assert.deepEqual(toasts(), [['error', NOT_COPIED]], 'no confirmation, an error');
    assert.match(NOT_COPIED, /^Not copied: the clipboard refused it$/);
    assert.equal(time.live, 0, 'an error has no timer');
    time.advance(TOAST_MS * 100);
    assert.deepEqual(toasts(), [['error', NOT_COPIED]], 'still up');
    useToastStore.getState().dismiss(useToastStore.getState().toasts[0].id);
    assert.deepEqual(toasts(), []);

    for (const bad of [() => { throw new Error('denied'); }, () => Promise.reject(new Error('denied')), () => undefined, () => Promise.resolve('yes')]) {
      resetToasts();
      setToastTimers(time);
      assert.equal(await copyAndConfirm('/x', PATH_COPIED, { copy: bad }), false, String(bad));
      assert.deepEqual(toasts(), [['error', NOT_COPIED]], String(bad));
    }
  }));

  test('CF-3: nothing to copy — nothing copied, an error that stays (a tab chip whose tab went before the pick says the terminal has no directory yet)', cleanly(async (time) => {
    const { copied, copy } = mockCopy(true);
    for (const text of ['', null, undefined]) {
      resetToasts();
      setToastTimers(time);
      assert.equal(await copyAndConfirm(text, PATH_COPIED, { copy }), false, JSON.stringify(text));
      assert.deepEqual(toasts(), [['error', NOTHING_TO_COPY]], JSON.stringify(text));
    }
    assert.deepEqual(copied, [], 'the clipboard is not touched');
    resetToasts();
    setToastTimers(time);
    assert.equal(await copyAndConfirm(undefined, PATH_COPIED, { copy, nothing: NO_DIRECTORY_YET }), false);
    assert.deepEqual(toasts(), [['error', 'Not copied: this terminal has no directory yet']]);
    time.advance(TOAST_MS * 10);
    assert.equal(toasts().length, 1, 'it stays');
  }));

  test('CF-4: Copy Path with the real copyText — the Clipboard API inside the call, "Path copied"; refused everywhere, the error', cleanly(async () => {
    const written = [];
    setGlobal('navigator', { clipboard: { writeText: async (text) => void written.push(text) } });
    const done = copyAndConfirm('/Users/me/proj', PATH_COPIED);
    assert.deepEqual(written, ['/Users/me/proj'], 'navigator.clipboard.writeText called inside the call');
    assert.equal(await done, true);
    assert.deepEqual(toasts(), [['confirm', 'Path copied']]);

    resetToasts();
    setToastTimers(fakeTimers());
    setGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    const area = { style: {}, focus() {}, select() {}, remove() {} };
    setGlobal('document', { activeElement: null, body: { appendChild() {} }, createElement: () => area, execCommand: () => false });
    assert.equal(await copyAndConfirm('C:\\Users\\me', PATH_COPIED), false);
    assert.deepEqual(toasts(), [['error', NOT_COPIED]]);
  }));

  test('CF-5: Copy Context (the default onSelect) — copied inside the pick, then "Copied 200 lines (secrets masked)", "1 line" singular', cleanly(async () => {
    const term = await terminalWith(300);
    setContextTerminalSource((tabId) => (tabId === 'shown' ? term : null));
    try {
      const { copied, copy } = mockCopy(true);
      const item = copyContextItem({ tabId: 'shown', lines: 200, copy });
      assert.equal(item.disabled, false);
      const done = item.onSelect();
      assert.equal(copied.length, 1, 'the clipboard write began before onSelect returned (nothing awaited before the copy)');
      assert.equal(copied[0], contextText(term, 200).text);
      assert.deepEqual(toasts(), [], 'only the toast waits');
      assert.equal(await done, true, 'onSelect hands back the promise of the toast');
      assert.deepEqual(toasts(), [['confirm', 'Copied 200 lines (secrets masked)']]);

      const one = copyContextItem({ tabId: 'shown', lines: 1, copy });
      const doneOne = one.onSelect();
      assert.equal(copied.length, 2, 'copied inside the pick');
      assert.equal(copied[1], 'line 300');
      await doneOne;
      assert.deepEqual(toasts().at(-1), ['confirm', 'Copied 1 line (secrets masked)']);

      // What is copied decides the count: fewer lines than asked for.
      const few = await terminalWith(2);
      setContextTerminalSource((tabId) => (tabId === 'few' ? few : null));
      await copyContextItem({ tabId: 'few', lines: 200, copy }).onSelect();
      assert.deepEqual(toasts().at(-1), ['confirm', 'Copied 2 lines (secrets masked)']);
      few.dispose();
    } finally {
      term.dispose();
    }
  }));

  test('CF-6: Copy Context refused, never shown or empty — an error that stays, "Not copied: " and the reason', cleanly(async (time) => {
    const term = await terminalWith(5);
    const empty = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    setContextTerminalSource((tabId) => ({ shown: term, empty })[tabId] ?? null);
    try {
      const refused = mockCopy(false);
      assert.equal(await copyContextItem({ tabId: 'shown', lines: 200, copy: refused.copy }).onSelect(), false);
      assert.equal(refused.copied.length, 1);
      assert.deepEqual(toasts(), [['error', NOT_COPIED]]);

      resetToasts();
      setToastTimers(time);
      const { copied, copy } = mockCopy(true);
      assert.equal(await copyContextItem({ tabId: 'empty', lines: 200, copy }).onSelect(), false);
      assert.deepEqual(toasts(), [['error', 'Not copied: this terminal has printed nothing yet']], 'shown but nothing printed');
      resetToasts();
      setToastTimers(time);
      assert.equal(await copyContextItem({ tabId: 'hidden', lines: 200, copy, available: true }).onSelect(), false);
      assert.deepEqual(
        toasts(),
        [['error', 'Not copied: this terminal has not been shown yet, so it has no screen to copy — open it once first']],
        'never shown (picked anyway)'
      );
      // The reasons themselves are as before: the menus show NEVER_SHOWN_REASON
      // as why the item is off, a sentence of its own.
      assert.equal(NOTHING_PRINTED_REASON, 'This terminal has printed nothing yet');
      assert.match(NEVER_SHOWN_REASON, /^This terminal has not been shown yet/);
      assert.equal(copyContextItem({ tabId: 'hidden', lines: 200 }).disabledReason, NEVER_SHOWN_REASON);
      assert.deepEqual(copied, [], 'nothing copied for either');
      time.advance(TOAST_MS * 10);
      assert.equal(toasts().length, 1, 'the error stays');

      // confirmContextCopy on its own: a missing result, and a copy that rejects.
      resetToasts();
      setToastTimers(time);
      assert.equal(await confirmContextCopy(null), false);
      assert.deepEqual(toasts(), [['error', NOTHING_TO_COPY]]);
      assert.equal(await confirmContextCopy({ ok: false, reason: '  ' }), false);
      assert.deepEqual(toasts(), [['error', NOTHING_TO_COPY]], 'a blank reason is the plain nothing-to-copy error');
      assert.equal(await confirmContextCopy({ ok: true, lines: 3, copied: Promise.reject(new Error('no')) }), false);
      assert.deepEqual(toasts().at(-1), ['error', NOT_COPIED]);
      // An onSelect handed in replaces the copy and its toast.
      resetToasts();
      setToastTimers(time);
      let picked = 0;
      copyContextItem({ tabId: 'shown', lines: 200, onSelect: () => { picked += 1; } }).onSelect();
      assert.equal(picked, 1);
      assert.deepEqual(toasts(), []);
    } finally {
      term.dispose();
      empty.dispose();
    }
  }));

  test('CF-7: the words — "Copied N lines (secrets masked)", "1 line" singular; the copy messages', () => {
    assert.equal(contextCopiedText(200), 'Copied 200 lines (secrets masked)');
    assert.equal(contextCopiedText(1), 'Copied 1 line (secrets masked)');
    assert.equal(contextCopiedText(2), 'Copied 2 lines (secrets masked)');
    assert.equal(contextCopiedText(10000), 'Copied 10000 lines (secrets masked)');
    assert.equal(PATH_COPIED, 'Path copied');
    assert.equal(SESSION_ID_COPIED, 'Session ID copied');
    const contextErrors = [NEVER_SHOWN_REASON, NOTHING_PRINTED_REASON].map(notCopiedBecause);
    for (const error of [NOT_COPIED, NOTHING_TO_COPY, NO_DIRECTORY_YET, ...contextErrors]) assert.match(error, /^Not copied: [a-z]/);
    assert.equal(notCopiedBecause(NOTHING_PRINTED_REASON), 'Not copied: this terminal has printed nothing yet');
    assert.equal(notCopiedBecause('Not copied: already said'), 'Not copied: already said', 'a reason with the prefix keeps it, once');
    for (const blank of ['', '   ', null, undefined, 42]) assert.equal(notCopiedBecause(blank), NOTHING_TO_COPY, String(blank));
    assert.equal(NO_DIRECTORY_REASON, 'This terminal has no directory yet');
  });

  test('CF-8: Copy Session ID (AGENT SESSIONS) as the panel wires it — the id copied inside the pick, then "Session ID copied"', cleanly(async () => {
    const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
    const entry = { key: `claude:${UUID}`, kind: 'claude', sessionId: UUID, cwd: '/workspace/src', title: 'Auto', startedAt: 1, lastUsedAt: 2 };
    const { copied, copy } = mockCopy(true);
    const item = agentSessionRowItems(entry, { on: { copyId: (sessionId) => copyAndConfirm(sessionId, SESSION_ID_COPIED, { copy }) } }).find((i) => i.key === 'copy-id');
    const done = item.onSelect();
    assert.deepEqual(copied, [UUID], 'exactly the id, inside the pick');
    assert.equal(await done, true);
    assert.deepEqual(toasts(), [['confirm', 'Session ID copied']]);

    resetToasts();
    setToastTimers(fakeTimers());
    const refused = mockCopy(false);
    await agentSessionRowItems(entry, { on: { copyId: (sessionId) => copyAndConfirm(sessionId, SESSION_ID_COPIED, { copy: refused.copy }) } })
      .find((i) => i.key === 'copy-id')
      .onSelect();
    assert.deepEqual(toasts(), [['error', NOT_COPIED]]);
  }));

  test('CF-9: wired — Copy Path in the TERMINALS row, the tab chip and the Explorer, Copy Session ID, and the palette\u{2019}s Copy Context', () => {
    const panel = source('src/components/terminal/TerminalsPanel.jsx');
    assert.match(panel, /import \{ PATH_COPIED, SESSION_ID_COPIED, copyAndConfirm \} from '\.\.\/\.\.\/lib\/copyFeedback\.js';/);
    assert.match(panel, /key: 'copy-path',[\s\S]{0,300}?onSelect: \(\) => copyAndConfirm\(tab\.cwd, PATH_COPIED\),/, 'the TERMINALS row');
    // Off while the tab has no directory, with the reason the chip gives too.
    const rowReason = /key: 'copy-path',[\s\S]{0,120}?disabled: !tab\.cwd,\s*disabledReason: !tab\.cwd \? '([^']+)' : undefined,/.exec(panel);
    assert.ok(rowReason, 'the TERMINALS row\u{2019}s Copy Path is not off without a directory');
    assert.equal(rowReason[1], NO_DIRECTORY_REASON, 'the row and the chip give the same reason');
    assert.match(panel, /copyId: \(sessionId\) => copyAndConfirm\(sessionId, SESSION_ID_COPIED\),/, 'AGENT SESSIONS');
    assert.match(panel, /copyContextItem\(\{ tabId: tab\.id, lines: copyContextLines \}\)/, 'the row\u{2019}s Copy Context keeps the default onSelect');

    const chip = source('src/components/terminal/TerminalSplitContainer.jsx');
    assert.match(chip, /import \{ NO_DIRECTORY_REASON, NO_DIRECTORY_YET, PATH_COPIED, copyAndConfirm \} from '\.\.\/\.\.\/lib\/copyFeedback\.js';/);
    // The chip's tab, looked up while the menu is drawn: off with the reason
    // while it has no directory, as the TERMINALS row is.
    assert.match(chip, /const chipTab = chipMenu \? paneTabs\.find\(\(t\) => t\.id === chipMenu\.tabId\) : null;\s*const chipNoDirectory = Boolean\(chipTab\) && !chipTab\.cwd;/);
    assert.match(
      chip,
      /key: 'copy-path',\s*label: 'Copy Path',\s*icon: Copy,\s*disabled: chipNoDirectory,\s*disabledReason: chipNoDirectory \? NO_DIRECTORY_REASON : undefined,/,
      'the tab chip\u{2019}s Copy Path is not off without a directory'
    );
    // Picked: looked up again, so a tab that went meanwhile gets the error.
    assert.match(
      chip,
      /key: 'copy-path',[\s\S]{0,600}?onSelect: \(\) => \{\s*const target = paneTabs\.find\(\(t\) => t\.id === chipMenu\.tabId\);\s*copyAndConfirm\(target\?\.cwd, PATH_COPIED, \{ nothing: NO_DIRECTORY_YET \}\);\s*\},/,
      'the tab chip'
    );
    assert.match(chip, /copyContextItem\(\{ tabId: chipMenu\.tabId, lines: copyContextLines, icon: ClipboardCopy \}\)/, 'the chip\u{2019}s Copy Context keeps the default onSelect');

    const explorer = source('src/components/explorer/FileExplorer.jsx');
    assert.match(explorer, /key: 'copy-path',[\s\S]{0,300}?onSelect: \(\) => copyAndConfirm\(target\.path, PATH_COPIED\),/, 'the Explorer');
    assert.match(explorer, /key: 'copy-relative-path',[\s\S]{0,300}?onSelect: \(\) => copyText\(relativeTo\(rootPath, target\.path\)\),/, 'Copy Relative Path is later work');

    // The palette: the copy first, inside the Enter, then the toast, nothing awaited.
    const palette = source('src/components/command/CommandPalette.jsx');
    assert.match(palette, /import \{ confirmContextCopy \} from '\.\.\/\.\.\/lib\/copyFeedback\.js';/);
    const at = palette.indexOf("case 'copy_terminal_context':");
    const body = palette.slice(at, palette.indexOf('return;', at));
    assert.match(body, /confirmContextCopy\(\s*copyContextOfTab\(useTerminalStore\.getState\(\)\.activeTabId, useSettingsStore\.getState\(\)\.terminalCopyContextLines\)\s*\);/);
    assert.doesNotMatch(body.replace(/\/\/[^\n]*/g, ''), /\bawait\b/, 'nothing awaited in the case, before the copy or for the toast');

    // The default onSelect: the copy, then confirmContextCopy, in one expression.
    const lib = source('src/lib/copyContext.js');
    assert.match(lib, /onSelect: onSelect \?\? \(\(\) => confirmContextCopy\(copyContextOfTab\(tabId, lines, copy \? \{ copy \} : undefined\)\)\),/);
    assert.doesNotMatch(source('src/lib/copyFeedback.js').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /\bawait\b|async /, 'copyFeedback awaits nothing before a copy');
  });

  test('CF-10: README and STYLEGUIDE.md say which copies show a toast, and that the others are later work', () => {
    const flat = (text) => text.replace(/\s+/g, ' ');
    const readme = flat(source('README.md'));
    const toastsPara = readme.slice(readme.indexOf('**Toasts.**'), readme.indexOf('**Toasts.**') + 1400);
    for (const words of ['Copy Path', 'Copy Context', 'Copy Session ID', 'Path copied', 'Copied 200 lines (secrets masked)', 'Session ID copied', 'later']) {
      assert.ok(toastsPara.includes(words), `README.md's Toasts paragraph does not say ${words}`);
    }
    const guide = flat(source('STYLEGUIDE.md'));
    const feedback = guide.slice(guide.indexOf('## In-flight feedback'), guide.indexOf('## Recorded decisions'));
    for (const words of ['Copy Path', 'Copy Context', 'Copy Session ID', 'Copy Relative Path', 'later work']) {
      assert.ok(feedback.includes(words), `STYLEGUIDE.md's In-flight feedback does not say ${words}`);
    }
  });

  test('CF-99: teardown — no toast, the global timers back, no terminal source, the globals as they were', () => {
    resetToasts();
    setContextTerminalSource(null);
    putBack('navigator');
    putBack('document');
    assert.deepEqual(useToastStore.getState().toasts, []);
    assert.equal(contextTerminalOf('shown'), null);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'navigator'), saved.navigator);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'document'), saved.document);
  });
});
