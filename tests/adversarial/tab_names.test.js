/**
 * Two terminals must never be called the same thing.
 *
 * The default name came from how many terminals there were —
 * `Terminal ${tabs.length + 1}` — so closing one in the middle dropped the
 * count and handed the next terminal a number still in use. Reproduced against
 * the real store: open three, close "Terminal 2", open one more, and the group
 * holds "Terminal 1", "Terminal 3", "Terminal 3".
 *
 * The number is now the lowest nothing is using, counting a number as taken
 * when EITHER name uses it. `defaultTitle`, because clearing a rename restores
 * it (see `renameTab`) and two tabs handed the same one would collide the
 * moment both renames were cleared. And the visible `title`, because a
 * restored layout keeps the titles it was saved with while their
 * `defaultTitle`s are renumbered from one — TN-02 caught exactly that, with a
 * new terminal shown as "Terminal 2" beside a restored one already called it.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';

const { useTerminalStore: S, PERSIST_KEY } = await import('../../src/stores/terminalStore.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tabs = () => S.getState().tabs;
const titles = () => tabs().map((t) => t.title);
const defaults = () => tabs().map((t) => t.defaultTitle);
const duplicatesIn = (list) => list.filter((v, i) => list.indexOf(v) !== i);

describe('Default terminal names stay unique', () => {
  beforeEach(async () => {
    S.getState().dispose();
    // Drop the persisted workspace as well: `init` restores it, so without
    // this each case would start from the tabs the previous one left behind.
    try {
      globalThis.localStorage?.removeItem(PERSIST_KEY);
    } catch (_) {
      // no storage in this environment — nothing to restore from either
    }
    S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
    await S.getState().init();
    await wait(50);
  });

  test('TN-01: closing one in the middle does not make the next a duplicate', async () => {
    await S.getState().createTab();
    await S.getState().createTab();
    await wait(50);
    assert.deepEqual(titles(), ['Terminal 1', 'Terminal 2', 'Terminal 3']);

    await S.getState().closeTab(tabs()[1].id);
    await wait(50);
    assert.deepEqual(titles(), ['Terminal 1', 'Terminal 3'], 'the middle one is gone');

    await S.getState().createTab();
    await wait(50);

    // Before the fix this was ['Terminal 1', 'Terminal 3', 'Terminal 3'].
    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `two terminals share a name: ${JSON.stringify(titles())}`
    );
    assert.equal(titles()[2], 'Terminal 2', 'and the freed number is reused rather than skipped');
  });

  test('TN-02: churn never produces a duplicate, however long it runs', async () => {
    for (let i = 0; i < 4; i++) await S.getState().createTab();
    await wait(60);

    for (let round = 0; round < 8; round++) {
      // Close something that is not the last one, so the count always drops
      // below the highest number in use — the shape that caused this.
      const list = tabs();
      const victim = list[Math.min(1, list.length - 1)];
      await S.getState().closeTab(victim.id);
      await wait(20);
      await S.getState().createTab();
      await wait(20);

      assert.deepEqual(
        duplicatesIn(titles()),
        [],
        `round ${round}: duplicate visible name in ${JSON.stringify(titles())}`
      );
      assert.deepEqual(
        duplicatesIn(defaults()),
        [],
        `round ${round}: duplicate defaultTitle in ${JSON.stringify(defaults())}`
      );
    }
  });

  test('TN-03: a renamed terminal keeps its number, so clearing the rename is safe', async () => {
    await S.getState().createTab();
    await S.getState().createTab();
    await wait(50);
    const second = tabs()[1];
    assert.equal(second.defaultTitle, 'Terminal 2');

    S.getState().renameTab(second.id, 'build');
    await wait(20);
    assert.equal(tabs()[1].title, 'build');

    // The number 2 is still spoken for, even though nothing shows it.
    await S.getState().createTab();
    await wait(50);
    assert.deepEqual(duplicatesIn(defaults()), [], `defaults collided: ${JSON.stringify(defaults())}`);

    // Clearing the rename brings "Terminal 2" back — and it must still be the
    // only one. This is what matching on the visible title alone would miss.
    S.getState().renameTab(second.id, '');
    await wait(20);
    assert.equal(tabs()[1].title, 'Terminal 2');
    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `clearing a rename revealed a duplicate: ${JSON.stringify(titles())}`
    );
  });

  test('TN-04: a restored layout does not get a duplicate from the next new terminal', async () => {
    // A layout saved after "Terminal 2" was closed: the titles have a gap, but
    // on restore the defaultTitles are renumbered from one. Matching only on
    // defaultTitle would then hand the next terminal the number 3, which the
    // restored tab is already showing.
    S.getState().dispose();
    globalThis.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        version: 2,
        data: {
          activeGroupId: 'group-tn',
          groups: [
            {
              id: 'group-tn',
              name: 'Restored',
              createdAt: 1,
              activePaneId: 'pane-tn',
              tree: { type: 'leaf', id: 'pane-tn', tabIds: ['t-1', 't-3'], activeTabId: 't-1' },
            },
          ],
          tabs: [
            { id: 't-1', title: 'Terminal 1', cwd: '/workspace' },
            { id: 't-3', title: 'Terminal 3', cwd: '/workspace' },
          ],
        },
      })
    );
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    await S.getState().init();
    await wait(60);

    assert.deepEqual(titles(), ['Terminal 1', 'Terminal 3'], 'the saved names come back as they were');

    await S.getState().createTab();
    await wait(60);
    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `the new terminal collided with a restored one: ${JSON.stringify(titles())}`
    );
    assert.equal(titles()[2], 'Terminal 2', 'and it takes the number the gap left free');
  });

  test('TN-05: a terminal the user named "Terminal 9" owns that number too', async () => {
    // Nothing stops someone typing a name that looks like a default one, and
    // once they have, the app must not hand the same name to a new terminal.
    // This is why a number counts as taken from the VISIBLE title as well.
    const first = tabs()[0];
    S.getState().renameTab(first.id, 'Terminal 9');
    await wait(20);
    assert.equal(tabs()[0].title, 'Terminal 9');

    // Open enough terminals to walk the numbering up to and past 9.
    for (let i = 0; i < 10; i++) await S.getState().createTab();
    await wait(120);

    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `a new terminal took a name already on screen: ${JSON.stringify(titles())}`
    );
    assert.equal(
      titles().filter((t) => t === 'Terminal 9').length,
      1,
      'only the one the user named is called that'
    );
  });

  test('TN-07: loading a saved group beside the names it saved does not duplicate them', async () => {
    // The gap TN-01..TN-05 left open. Those all go through `createTab()` with
    // no title, where the number is chosen fresh. `loadSavedGroup` instead
    // calls `spawnTab(saved.title, ...)`, and a saved title was forced through
    // as the VISIBLE name while only `defaultTitle` was renumbered — so a
    // group saved as "Terminal 1" loaded next to a live "Terminal 1" put two
    // tabs called "Terminal 1" in the strip.
    assert.deepEqual(titles(), ['Terminal 1'], 'one live terminal to collide with');

    S.setState({
      savedGroups: [
        {
          id: 'saved-collide',
          name: 'Saved',
          tabs: [
            { slotId: 'slot-0', title: 'Terminal 1', cwd: null },
            { slotId: 'slot-1', title: 'Terminal 2', cwd: null },
          ],
          tree: null,
          activePaneId: null,
        },
      ],
    });

    await S.getState().loadSavedGroup('saved-collide');
    await wait(120);

    assert.equal(tabs().length, 3, 'the two saved terminals really were created');
    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `loading a saved group duplicated a visible name: ${JSON.stringify(titles())}`
    );
    assert.deepEqual(
      duplicatesIn(defaults()),
      [],
      `...and the default names collided too: ${JSON.stringify(defaults())}`
    );
    // The first saved slot wanted a number already in use and had to move; the
    // second one asked for a number that was free and should have kept it.
    assert.ok(titles().includes('Terminal 2'), `"Terminal 2" was free and should be kept: ${JSON.stringify(titles())}`);
  });

  test('TN-08: a name the user typed is never renumbered, even when it repeats', async () => {
    // The other half of the rule: uniqueness is enforced on the numbers the
    // app hands out, not on names a person chose. Two panes both called
    // "build" is the user's business, and silently renaming one would be worse
    // than the duplicate.
    S.getState().renameTab(tabs()[0].id, 'build');
    await wait(20);

    S.setState({
      savedGroups: [
        { id: 'saved-named', name: 'Saved', tabs: [{ slotId: 'slot-0', title: 'build', cwd: null }], tree: null, activePaneId: null },
      ],
    });
    await S.getState().loadSavedGroup('saved-named');
    await wait(120);

    assert.equal(
      titles().filter((t) => t === 'build').length,
      2,
      `a user's own name was renumbered: ${JSON.stringify(titles())}`
    );
  });

  test('TN-06: teardown — leave the store as the next suite expects it', () => {
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    assert.ok(true);
  });
});

// ---- Who wins a terminal's label (AC16, F14) ------------------------------------
//
// Three names can claim a terminal: the one the user gave it (Rename), the one
// a program in it set (`nexterm-cli set-title`, kept as `programTitle`) and its
// default `Terminal N`. `displayTitle` (src/lib/tabTitle.js) picks in that
// order, and every place a terminal's name is drawn asks it — the chip and its
// strip, the TERMINALS row, the hidden strip's handle and `list`. RN-231 and
// RN-232 (tests/render/runner.js) and WN-09 draw those for real; here the rule,
// the store's side of it and the `list` answer, against the real store.

const { displayTitle, hasUserTitle, nexTermTitle } = await import('../../src/lib/tabTitle.js');
const { mockBridge } = await import('../../src/lib/ipc.js');
const { createControlDispatcher } = await import('../../src/lib/controlDispatcher.js');
const { setTerminalNoticeSink } = await import('../../src/lib/terminalNotice.js');
const { useSettingsStore } = await import('../../src/stores/settingsStore.js');
const { SAVED_GROUPS_KEY, SAVED_WORKSPACES_KEY } = await import('../../src/stores/terminalStore.js');

const tabById = (id) => tabs().find((t) => t.id === id);
const labelOf = (id) => displayTitle(tabById(id));
/** A source file as text, line endings made LF (a Windows checkout has CRLF). */
const source = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let requestId = 0;
/** Ask the real dispatcher `cmd` as the program in terminal `tabId`; resolves with its answer. */
function ask(tabId, cmd, args = {}) {
  const dispatcher = createControlDispatcher({ reply: async () => {}, later: (fn) => fn() });
  return dispatcher.handle({
    id: ++requestId,
    session_id: tabById(tabId).sessionId,
    cmd,
    args,
    type_and_read: false,
    other_terminals: false,
  });
}
/** `list` as `tabId`'s program sees it: id -> title. */
async function listedTitles(tabId) {
  const answer = await ask(tabId, 'list');
  assert.equal(answer.ok, true, `list answered ${JSON.stringify(answer.error ?? null)}`);
  return Object.fromEntries(answer.result.map((row) => [row.id, row.title]));
}

/** Two terminals, `Terminal 1` and `Terminal 2`, with the control API on: `[a, b]`. */
async function twoTerminals() {
  await S.getState().createTab();
  await wait(50);
  assert.deepEqual(titles(), ['Terminal 1', 'Terminal 2'], 'setup: two unnamed terminals');
  return tabs().map((t) => t.id);
}

describe("A terminal's label: the user's name, else a program's title, else its default (AC16)", () => {
  let controlWas;
  beforeEach(async () => {
    S.getState().dispose();
    try {
      globalThis.localStorage?.removeItem(PERSIST_KEY);
    } catch (_) {
      // no storage in this environment
    }
    S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
    await S.getState().init();
    await wait(50);
  });

  /** Run `fn` with the control API on, putting the setting back after. */
  async function withControl(fn) {
    controlWas = useSettingsStore.getState().terminalControl;
    useSettingsStore.getState().setSetting('terminalControl', true);
    try {
      await fn();
    } finally {
      useSettingsStore.getState().setSetting('terminalControl', controlWas);
    }
  }

  test('TN-09: the rule itself — a user name wins, then a program title, then the default; nothing else counts as a name', () => {
    const unnamed = { id: 'x', title: 'Terminal 2', defaultTitle: 'Terminal 2' };
    assert.equal(displayTitle({ ...unnamed, programTitle: 'vim notes.md' }), 'vim notes.md', 'an unnamed terminal shows its program title');
    assert.equal(displayTitle({ ...unnamed, title: 'build', programTitle: 'vim notes.md' }), 'build', "the user's name wins over it");
    assert.equal(displayTitle(unnamed), 'Terminal 2', 'no program title: the default');
    assert.equal(displayTitle({ ...unnamed, programTitle: '' }), 'Terminal 2', 'an empty program title is none');
    assert.equal(displayTitle({ ...unnamed, programTitle: null }), 'Terminal 2', 'a cleared program title is none');
    assert.equal(displayTitle({ ...unnamed, programTitle: 42 }), 'Terminal 2', 'only text is a title');
    assert.equal(displayTitle({ id: 'y', title: 'old build' }), 'old build', 'a name with no default beside it is a name');
    assert.equal(displayTitle({ id: 'z', defaultTitle: 'Terminal 4', programTitle: 'top' }), 'top', 'no title at all is unnamed');
    assert.equal(displayTitle({ id: 'z', defaultTitle: 'Terminal 4' }), 'Terminal 4');
    assert.equal(displayTitle({ id: 'w' }), 'Terminal', 'nothing at all: the fallback');
    assert.equal(displayTitle(null), 'Terminal');
    assert.equal(displayTitle(undefined, ''), '', 'the caller picks the fallback');
    assert.equal(displayTitle(null, 'another terminal'), 'another terminal');
    assert.equal(hasUserTitle({ ...unnamed, title: 'build' }), true);
    assert.equal(hasUserTitle(unnamed), false, 'a title equal to the default is no name');
    assert.equal(hasUserTitle({ ...unnamed, title: '' }), false);
    assert.equal(hasUserTitle(null), false);
    // NexTerm's own name, for what says who acted: never the program title.
    assert.equal(nexTermTitle({ ...unnamed, programTitle: 'Terminal 1' }), 'Terminal 2', 'a program title is never its own name');
    assert.equal(nexTermTitle({ ...unnamed, title: 'build', programTitle: 'x' }), 'build', "the user's name is");
    assert.equal(nexTermTitle({ id: 'z', defaultTitle: 'Terminal 4', programTitle: 'top' }), 'Terminal 4');
    assert.equal(nexTermTitle({ id: 'w', programTitle: 'top' }), 'Terminal', 'nothing of its own: the fallback');
    assert.equal(nexTermTitle(null, 'another terminal'), 'another terminal');
  });

  test('TN-10: an unnamed terminal shows the title its program set, in `list` too; its stored name stays its default', async () => {
    await withControl(async () => {
      const [a, b] = await twoTerminals();
      const answer = await ask(a, 'set-title', { text: 'vim notes.md' });
      assert.equal(answer.ok, true, `set-title answered ${JSON.stringify(answer.error ?? null)}`);
      assert.equal(tabById(a).programTitle, 'vim notes.md', 'kept as the program title');
      assert.equal(tabById(a).title, 'Terminal 1', 'the name Rename keeps is not touched');
      assert.equal(labelOf(a), 'vim notes.md', 'and it is what the terminal is called');
      assert.equal(labelOf(b), 'Terminal 2', 'the other one keeps its default');
      assert.deepEqual(await listedTitles(b), { [a]: 'vim notes.md', [b]: 'Terminal 2' }, "list calls it what its chip does");
    });
  });

  test('TN-11: the chip, its strip, the TERMINALS row, the hidden-strip handle and `list` all draw `displayTitle`; what says who acted (the mark, the control log) uses `nexTermTitle`', () => {
    const split = source('src/components/terminal/TerminalSplitContainer.jsx');
    assert.match(split, /import \{ displayTitle \} from '\.\.\/\.\.\/lib\/tabTitle\.js';/);
    assert.match(split, /tab\.exited && 'line-through opacity-60'\n\s*\)\}\n\s*>\n\s*\{displayTitle\(tab\)\}\n\s*<\/span>/, 'the chip draws displayTitle');
    // The chip's tooltip is its hover card now (bundle 4, B12): no native
    // title on the chip, and the card's title row is displayTitle.
    const chipProps = split.slice(split.indexOf('data-tab-chip={tab.id}'), split.indexOf("'relative group flex items-center px-2 h-[22px]"));
    assert.ok(chipProps.includes('onPointerDown') && !/\btitle=/.test(chipProps), 'the chip has no native title');
    assert.match(split, /data-tab-chip=\{tab\.id\}[\s\S]{0,600}\{\.\.\.hoverCard\.chipProps\(tab\.id\)\}/, 'the chip carries its hover card');
    const card = source('src/lib/tabHoverCard.js');
    assert.match(card, /import \{ displayTitle \} from '\.\/tabTitle\.js';/);
    assert.match(card, /const title = cleanCardText\(displayTitle\(tab\), CARD_TITLE_MAX\);/, "the chip's tooltip names it so");
    assert.match(split, /aria-label=\{`Close \$\{displayTitle\(tab\)\}`\}/, 'and its ✕');
    assert.match(split, /<StripHandle[\s\S]{0,120}title=\{displayTitle\(boundTab\)\}/, 'the hidden-strip handle is handed displayTitle');
    assert.match(split, /tabId: tab\.id,\n\s*title: displayTitle\(tab\),/, 'a dragged chip carries it');
    assert.doesNotMatch(split, /\{tab\.title\}|\$\{tab\.title\}|boundTab\?\.title/, 'no draw of the stored name is left on the strip');
    const panel = source('src/components/terminal/TerminalsPanel.jsx');
    assert.equal(panel.split('<span className="truncate">{displayTitle(tab)}</span>').length - 1, 2, 'both TERMINALS row layouts draw displayTitle');
    assert.doesNotMatch(panel, /<span className="truncate">\{tab\.title\}<\/span>/, 'no row draws the stored name');
    assert.match(panel, /title=\{status \? `\$\{tab\.cwd \|\| displayTitle\(tab\)\} — \$\{status\}` : tab\.cwd \|\| displayTitle\(tab\)\}/, "the row's tooltip too");
    const strip = source('src/components/terminal/HiddenStrip.jsx');
    assert.match(strip, /title: displayTitle\(tabs\.find\(\(t\) => t\.id === id\), id\)/, 'the handle names a controlled terminal so');
    const dispatcher = source('src/lib/controlDispatcher.js');
    assert.match(dispatcher, /import \{ displayTitle, nexTermTitle \} from '\.\/tabTitle\.js';/);
    assert.match(dispatcher, /const listedTitle = \(tab\) => \(tab \? displayTitle\(tab\) : ''\);/, 'list names it so');
    assert.match(dispatcher, /title: listedTitle\(tab\),/, '`list` uses it');
    // Who asked and of whom: NexTerm's own name, which no program can set
    // (review A-R1). CD-57 drives it.
    assert.match(dispatcher, /const loggedTitle = \(tab\) => \(tab \? nexTermTitle\(tab\) : ''\);/, 'the control log names it by its own name');
    assert.equal(dispatcher.split('entry.targetTitle = loggedTitle(').length - 1, 2, 'both targets the log names');
    assert.match(dispatcher, /entry\.callerTitle = loggedTitle\(caller\);/, 'and the caller');
    assert.doesNotMatch(dispatcher, /(callerTitle|targetTitle) = (?!loggedTitle\()/, 'no other name goes into the log');
    assert.equal((dispatcher.match(/displayTitle\(/g) ?? []).length, 1, 'displayTitle only in listedTitle');
    const store = source('src/stores/terminalStore.js');
    assert.match(store, /const byTitle = nexTermTitle\(caller, 'another terminal'\);/, 'the "Controlled by" mark names the caller by its own name');
    assert.doesNotMatch(store, /byTitle = displayTitle/);
    assert.match(strip, /Controlled by \$\{mark\.byTitle\}/, 'and the mark draws that');
  });

  test("TN-12: a renamed terminal keeps the user's name whatever set-title sends; clearing the rename shows the program title, else the default", async () => {
    await withControl(async () => {
      const [a, b] = await twoTerminals();
      S.getState().renameTab(b, 'build');
      for (const text of ['npm test', 'vim notes.md', 'cargo build']) {
        assert.equal((await ask(b, 'set-title', { text })).ok, true);
        assert.equal(labelOf(b), 'build', `set-title "${text}" covered the user's name`);
        assert.equal(tabById(b).title, 'build', 'the stored name is still what the user typed');
      }
      assert.equal(tabById(b).programTitle, 'cargo build', 'the program title is kept behind it');
      assert.equal((await listedTitles(a))[b], 'build', 'list says the user name too');
      // Renaming again stores only the name.
      S.getState().renameTab(b, 'release');
      assert.equal(tabById(b).title, 'release');
      assert.equal(tabById(b).programTitle, 'cargo build', 'Rename neither stores nor drops the program title');
      // Clearing the rename brings the program title back.
      S.getState().renameTab(b, '   ');
      assert.equal(tabById(b).title, 'Terminal 2', 'the cleared rename stores the default, as before');
      assert.equal(labelOf(b), 'cargo build', 'and the program title shows again');
      assert.equal((await listedTitles(a))[b], 'cargo build');
      // set-title --clear: back to the default.
      assert.equal((await ask(b, 'set-title', { text: null })).ok, true);
      assert.equal('programTitle' in tabById(b) || 'programTitleAt' in tabById(b), false, '--clear leaves no program title');
      assert.equal(labelOf(b), 'Terminal 2', '--clear returns to the default');
      assert.equal((await listedTitles(a))[b], 'Terminal 2');
      // A rename cleared with no program title: the default.
      S.getState().renameTab(a, 'logs');
      S.getState().renameTab(a, '');
      assert.equal(labelOf(a), 'Terminal 1');
    });
  });

  test('TN-13: the shell ending (pty-exit), a write that finds it gone and a new shell (restartShell) each clear the program title', async () => {
    const notices = [];
    const unsink = setTerminalNoticeSink((tabId, message) => {
      notices.push({ tabId, message });
      return true;
    });
    try {
      await S.getState().createTab();
      await S.getState().createTab();
      await wait(50);
      const [a, b, c] = tabs().map((t) => t.id);
      for (const [id, text] of [[a, 'vim notes.md'], [b, 'npm test'], [c, 'top']]) S.getState().setProgramTitle(id, text);
      assert.deepEqual([a, b, c].map(labelOf), ['vim notes.md', 'npm test', 'top'], 'setup: each shows its program title');

      // pty-exit.
      const sessionA = tabById(a).sessionId;
      await mockBridge.emit('pty-exit', { session_id: sessionA, exit_code: 0 });
      assert.ok(tabById(a).exited, 'setup: a has exited');
      assert.equal('programTitle' in tabById(a) || 'programTitleAt' in tabById(a), false, 'pty-exit clears it');
      assert.equal(labelOf(a), 'Terminal 1', 'and the default shows again');
      assert.equal(labelOf(b), 'npm test', 'the others keep theirs');

      // A write that finds the shell gone, before any exit event says so.
      mockBridge.ptySessions.delete(tabById(c).sessionId);
      await S.getState().writeRaw(c, 'x');
      assert.ok(tabById(c).exited, 'setup: the failed write exited c');
      assert.equal('programTitle' in tabById(c) || 'programTitleAt' in tabById(c), false, 'the write-failure exit clears it');
      assert.equal(labelOf(c), 'Terminal 3');

      // restartShell: a title left on an exited terminal (no program could
      // set one there, the store must still not carry it into a new shell).
      S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === a ? { ...t, programTitle: 'stale', programTitleAt: 1 } : t)) }));
      mockBridge.ptySessions.delete(sessionA);
      assert.equal(await S.getState().restartShell(a), true, 'setup: restarted');
      assert.equal(tabById(a).exited, null, 'setup: a runs a new shell');
      assert.equal('programTitle' in tabById(a) || 'programTitleAt' in tabById(a), false, 'restartShell clears it');
      assert.equal(labelOf(a), 'Terminal 1');
      assert.equal(labelOf(b), 'npm test', 'b was never touched');
      // A user name is not a program title: the shell ending keeps it.
      S.getState().renameTab(b, 'build');
      await mockBridge.emit('pty-exit', { session_id: tabById(b).sessionId, exit_code: 0 });
      assert.equal(tabById(b).title, 'build', "the user's name outlives the shell");
      assert.equal(labelOf(b), 'build');
    } finally {
      unsink();
    }
  });

  test('TN-14: no workspace, saved group or saved workspace ever holds a program title', async () => {
    // The suite runner puts a storage in place (appEnvironment.js); run on its
    // own this file has none, so it brings one and takes it away after.
    const ownStorage = !globalThis.localStorage;
    if (ownStorage) {
      const backing = new Map();
      globalThis.localStorage = {
        getItem: (k) => (backing.has(k) ? backing.get(k) : null),
        setItem: (k, v) => backing.set(k, String(v)),
        removeItem: (k) => backing.delete(k),
        clear: () => backing.clear(),
      };
    }
    const storage = globalThis.localStorage;
    const before = [SAVED_GROUPS_KEY, SAVED_WORKSPACES_KEY].map((k) => [k, storage.getItem(k)]);
    try {
      const [a, b] = await twoTerminals();
      S.getState().setProgramTitle(a, 'vim notes.md');
      S.getState().setProgramTitle(b, 'npm test');
      // A rename, so the workspace has something to write.
      S.getState().renameTab(b, 'build');
      assert.ok(S.getState().saveGroup(S.getState().activeGroupId, 'With titles'), 'setup: group saved');
      assert.ok(S.getState().saveWorkspace('With titles'), 'setup: workspace saved');
      const kept = [
        ['saved groups', JSON.stringify(S.getState().savedGroups)],
        ['saved workspaces', JSON.stringify(S.getState().savedWorkspaces)],
        ['stored saved groups', storage.getItem(SAVED_GROUPS_KEY)],
        ['stored saved workspaces', storage.getItem(SAVED_WORKSPACES_KEY)],
      ];
      // `dispose` writes the pending workspace out.
      S.getState().dispose();
      kept.push(['workspace', storage.getItem(PERSIST_KEY)]);
      for (const [what, json] of kept) {
        assert.ok(typeof json === 'string' && json.includes('build'), `${what}: nothing was written (${String(json).slice(0, 80)})`);
        for (const word of ['programTitle', 'vim notes.md', 'npm test']) {
          assert.equal(json.includes(word), false, `${what} holds ${word}: ${json.slice(0, 300)}`);
        }
      }
    } finally {
      for (const [k, v] of before) {
        if (v === null) storage.removeItem(k);
        else storage.setItem(k, v);
      }
      if (ownStorage) delete globalThis.localStorage;
    }
  });

  test("TN-16: the pane menu's swap choices and a project command's run target name a terminal by the same rule", async () => {
    const { swapChoices } = await import('../../src/components/terminal/splitLayout.js');
    const { runTargetView } = await import('../../src/lib/projectCommandRun.js');
    const leaf = (id, tabIds) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });
    const tree = { type: 'split', id: 's', direction: 'horizontal', sizes: [34, 33, 33], children: [leaf('p1', ['x']), leaf('p2', ['y']), leaf('p3', ['z'])] };
    const named = [
      { id: 'x', title: 'Terminal 1', defaultTitle: 'Terminal 1' },
      { id: 'y', title: 'Terminal 2', defaultTitle: 'Terminal 2', programTitle: 'vim notes.md' },
      { id: 'z', title: 'build', defaultTitle: 'Terminal 3', programTitle: 'npm test' },
    ];
    const choices = Object.fromEntries(swapChoices(tree, named, 'p1').map((c) => [c.paneId, c.title]));
    assert.deepEqual(choices, { p2: 'vim notes.md', p3: 'build' });
    const bare = Object.fromEntries(swapChoices(tree, [{ id: 'y' }], 'p1').map((c) => [c.paneId, c.title]));
    assert.deepEqual(bare, { p2: 'No terminal', p3: 'No terminal' }, 'a terminal with no name at all, or none, reads as before');
    assert.equal(runTargetView({ tabs: named }, { tabId: 'y' }).title, 'vim notes.md');
    assert.equal(runTargetView({ tabs: named }, { tabId: 'z' }).title, 'build');
    assert.equal(runTargetView({ tabs: named }, { tabId: 'x' }).title, 'Terminal 1');
  });

  test('TN-15: teardown — leave the store as the next suite expects it', () => {
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
    assert.ok(true);
  });
});
