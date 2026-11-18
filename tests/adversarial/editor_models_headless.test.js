/**
 * One Monaco text model per open file, against the app's own EditorPanel and
 * REAL Monaco under headless Chromium: what Node and its stand-ins cannot
 * show. Drives tests/adversarial/fixtures/editor_models_harness.html.
 *
 * Each group used to remount its editor on every tab switch
 * (`<Editor key={activeTab.filePath}>`), and @monaco-editor/react disposes the
 * model of an editor it unmounts: undo history, caret and scroll went with
 * every switch, every move to another group and every time the editor region
 * was hidden. One file shown in two groups shared one model, and closing
 * either group disposed it under the other.
 *
 *   - MM-02…MM-06 (AC1): an edit in a.js survives a switch to another tab and
 *     back; a move to another group, by its body and by its tab strip; a
 *     split and the close of the new group (both remount a.js's group); every
 *     group switching its tab and back; the editor region unmounted and
 *     mounted again. After each, a.js has the model it had, that model can
 *     undo, one undo takes back exactly the last edit, and the caret is where
 *     it was (and the scroll, where the group's size has not changed).
 *   - MM-07: a terminal link or Go to File into a file of the group lands on
 *     its line in the editor that group already has.
 *   - MM-08…MM-12 (AC2): closing the last tab on a file disposes its model;
 *     one file in two groups keeps its model when either closes; a rename and
 *     a move leave one model, at the new path, holding the same text; Reload
 *     From Disk is an edit of the model, undone like any other; opening
 *     another folder disposes every model of the one left; and closing every
 *     tab leaves no model behind.
 *   - MM-13: a file with mixed CRLF and LF line endings, which a model holds
 *     with one kind: showing it, switching away and back, makes no undo step
 *     and leaves the tab clean; Reload From Disk is one step; Save writes the
 *     file as read until it is edited, then the text the editor shows. An
 *     all-CRLF and an all-LF file are held exactly as read.
 *   - MM-14: two files whose names differ only by a literal `%20` and the
 *     space it decodes to have a model each, and undo in one never brings in
 *     the other's text.
 *   - MM-15…MM-17: Reload From Disk on a tab in the background, with a model;
 *     a folder renamed with two open files in it; Cancel on the unsaved-close
 *     prompt keeps the model and its undo.
 *   - MM-18: a tab closed and a new tab on the same path, with other text,
 *     shown in its group in the same render: no exception, and the editor
 *     shows the new text in a model of its own.
 *   - MM-20: a file starting with a UTF-8 BOM, with CRLF and with LF, which
 *     the tab holds with the BOM and the model without: shown, switched away
 *     and back, saved untouched and reloaded with the same text, no undo
 *     step, no unsaved tab, no BOM in the model's text, and Save writes the
 *     same bytes; edited, the buffer and Save keep the BOM, and undone the
 *     tab is clean.
 *   - MM-21: Reload From Disk of a file converted outside the app from CRLF
 *     to LF, and back, gives the model the new line ending as one undo
 *     step, and Save after an edit keeps it.
 *   - MM-22: Reload From Disk with other lines and the other line ending, an
 *     LF file reloaded in CRLF and a CRLF file in LF: one undo step, which
 *     undone gives exactly the text and line ending from before, and redone
 *     exactly what is on disk, with the tab clean.
 *   - Every case: no exception thrown in the page and left uncaught.
 *
 * Needs agent-browser, and a Node with a global WebSocket (22 and later) for
 * the CDP session: skipped without either, or when the browser cannot start,
 * saying which. The agent-browser session is this process's own, so two runs
 * at once do not take each other's. MM-01 and MM-19 are setup and teardown,
 * as cases (MM-20 to MM-22 run before MM-19); teardown also runs from
 * `process.on('exit')`.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const NOT_INSTALLED = 'agent-browser is not installed — the real-Monaco model checks run locally only';
const NO_WEBSOCKET = 'this Node has no global WebSocket (Node 22 and later have one), which the CDP session needs';
const NO_HARNESS = 'the harness did not start: see MM-01';

const DIR = '/workspace/models';
const A = `${DIR}/a.js`;
const B = `${DIR}/b.js`;
const C = `${DIR}/c.js`;
const D = `${DIR}/d.js`;
const MIXED = '/other/mixed.js';
const MIXED_TEXT = 'const one = 1;\r\nconst two = 2;\nconst three = 3;\r\n';
const CRLF = '/other/crlf.js';
const CRLF_TEXT = 'const one = 1;\r\nconst two = 2;\r\n';
const ENCODED = '/other/a%20b.js';
const SPACED = '/other/a b.js';
const BOM = '\uFEFF';
const BOM_FILES = [
  ['/other/bom-crlf.js', `${BOM}const one = 1;\r\nconst two = 2;\r\n`],
  ['/other/bom-lf.js', `${BOM}export const bom = 1;\n`],
];
const EOL = '/other/eol.js';
const EOL_TEXT = 'const one = 1;\r\nconst two = 2;\r\n';
/** [path, the file as read, what Reload From Disk then finds]: other lines in the other line ending. */
const COMBINED = [
  ['/other/combined-lf.js', 'const a = 1;\nconst b = 2;\n', 'const x = 1;\r\nconst y = 2;\r\nconst z = 3;\r\n'],
  ['/other/combined-crlf.js', 'const a = 1;\r\nconst b = 2;\r\n', 'const x = 1;\nconst y = 2;\nconst z = 3;\n'],
];

/** Set by MM-01 once the page is up; every later case skips without it. */
let harness = null;
/** Set by MM-01 when the browser could not start: the reason every case skips. */
let unavailable = null;
const ids = {};
/** The two groups MM-02 sets up: a.js and c.js on the left, b.js and d.js on the right. */
const panes = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (fn, ...args) => harness.evalJs(`window.__m.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);

function needHarness() {
  if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
  if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
  if (unavailable) skip(unavailable);
  if (!harness) skip(NO_HARNESS);
}

function assertNoPageErrors() {
  assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
}

/** Until every group showing a tab has a live editor holding its file. */
async function settle(what = 'the editor') {
  const deadline = Date.now() + 15000;
  while (!(await call('settled'))) {
    if (Date.now() > deadline) throw new Error(`${what} never settled: ${JSON.stringify(await call('state'))}`);
    await sleep(50);
  }
  // Effects that run after the editor is there (a restored caret, a reveal).
  await sleep(80);
}

/** The group a tab is in, by id. */
async function paneOf(tabId) {
  const { leaves } = await call('state');
  return leaves.find((leaf) => leaf.tabIds.includes(tabId))?.id ?? null;
}

/**
 * An edit in a.js, then `step`. Afterwards a.js has the very model it had,
 * that model can undo, the caret is where it was before the step (and the
 * scroll, with `scroll`), and one undo restores the text from before the
 * edit. The edit is redone after, so that the next step starts from it.
 */
async function survives(label, step, { scroll = false } = {}) {
  const before = (await call('probe', A)).value;
  const typed = await call('type', A, `/*${label}*/`);
  await sleep(50);
  const ahead = await call('probe', A);
  assert.equal(ahead.same, true, `${label}: a.js already had another model before the step`);

  await step();
  await settle(label);

  const after = await call('probe', A);
  assert.equal(after.exists, true, `${label}: a.js has no model`);
  assert.equal(after.same, true, `${label}: a.js's model was replaced — its undo history went with the old one`);
  assert.equal(after.value, typed, `${label}: a.js's text changed`);
  assert.equal(after.canUndo, true, `${label}: a.js's model has nothing to undo`);
  assert.deepEqual(after.position, ahead.position, `${label}: the caret moved`);
  if (scroll) assert.equal(after.scrollTop, ahead.scrollTop, `${label}: the scroll moved`);
  assert.equal(await call('undo', A), before, `${label}: one undo did not take back exactly the last edit`);
  assert.equal(await call('redo', A), typed, `${label}: redo did not bring the edit back`);
  const { tabs } = await call('state');
  assert.equal(tabs.find((t) => t.id === ids.A).content, typed, `${label}: the tab's text is not the model's`);
  assertNoPageErrors();
}

describe('Editor models: one Monaco model per open file, under headless Chromium (CDP)', () => {
  test('MM-01: setup — the scratch vite server, the harness page, a raw CDP session onto it', async () => {
    if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
    if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
    try {
      harness = await openHarness('tests/adversarial/fixtures/editor_models_harness.html', {
        prefix: 'editor-models-headless',
        session: `editor-models-headless-${process.pid}`,
        readyExpression: 'window.__m ? window.__m.ready === true : false',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) {
        unavailable = `the browser could not start (${err.message})`;
        skip(unavailable);
      }
      throw err;
    }
    // A page the browser treats as focused, as the app's window is.
    await harness.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    assertNoPageErrors();
  });

  test('MM-02 (AC1): an edit survives a switch to another tab of the group and back — model, undo, caret, scroll', async () => {
    needHarness();
    ids.A = await call('open', A);
    ids.C = await call('open', C);
    ids.B = await call('open', B);
    await settle('three tabs in one group');
    // b.js split off to the right, d.js beside it: two groups of two.
    const root = await paneOf(ids.A);
    await call('act', 'dropEditorTabOnPane', ids.B, root, 'right');
    panes.right = await paneOf(ids.B);
    panes.left = await paneOf(ids.A);
    assert.notEqual(panes.right, panes.left, 'b.js did not split off');
    ids.D = await call('open', D);
    assert.equal(await paneOf(ids.D), panes.right, 'd.js did not open in the active (right) group');
    await call('act', 'bindEditorPaneToTab', panes.left, ids.A);
    await settle('two groups');
    assert.equal(await call('hold', A), true, 'a.js has no model to hold');
    // Mid-file, scrolled, so that a caret or scroll reset shows.
    const placed = await call('place', A, 150, 7);
    assert.ok(placed.scrollTop > 1000, `a.js is not scrolled down: ${placed.scrollTop}`);

    await survives(
      'switch',
      async () => {
        await call('act', 'bindEditorPaneToTab', panes.left, ids.C);
        await settle('c.js shown');
        assert.equal((await call('probe', C)).pane, panes.left, 'c.js is not shown in the left group');
        await call('act', 'bindEditorPaneToTab', panes.left, ids.A);
      },
      { scroll: true }
    );
  });

  test('MM-03 (AC1): an edit survives a move to another group — onto its body, and back by its tab strip', async () => {
    needHarness();
    await survives('move', async () => {
      await call('act', 'dropEditorTabOnPane', ids.A, panes.right, 'center');
      await settle('a.js moved right');
      assert.equal((await call('probe', A)).pane, panes.right, 'a.js is not in the right group');
    });
    await survives('strip', async () => {
      await call('act', 'moveEditorTabInStrip', ids.A, panes.left, 0);
      await settle('a.js moved back');
      assert.equal((await call('probe', A)).pane, panes.left, 'a.js is not back in the left group');
    });
  });

  test('MM-04 (AC1): an edit survives a split of its group and the close of the new one — both remount the group', async () => {
    needHarness();
    await survives(
      'split',
      async () => {
        const fresh = await call('act', 'splitEditorPane', panes.left, 'vertical').then(async () => {
          const { leaves } = await call('state');
          return leaves.find((leaf) => leaf.tabIds.length === 0)?.id;
        });
        assert.ok(fresh, 'the split made no new group');
        await settle('split');
        await call('act', 'closeEditorPane', fresh);
      },
      { scroll: true }
    );
    const { leaves } = await call('state');
    assert.deepEqual(leaves.map((leaf) => leaf.id), [panes.left, panes.right], 'the two groups are not back as they were');
  });

  test('MM-05 (AC1): an edit survives every group switching its tab and back', async () => {
    needHarness();
    await survives(
      'every-group',
      async () => {
        await call('act', 'bindEditorPaneToTab', panes.left, ids.C);
        await call('act', 'bindEditorPaneToTab', panes.right, ids.B);
        await settle('every group on another tab');
        assert.equal((await call('probe', A)).exists, true, 'a.js lost its model while no group showed it');
        await call('act', 'bindEditorPaneToTab', panes.right, ids.D);
        await call('act', 'bindEditorPaneToTab', panes.left, ids.A);
      },
      { scroll: true }
    );
  });

  test('MM-06 (AC1): an edit survives the editor region unmounted and mounted again', async () => {
    needHarness();
    await survives(
      'region',
      async () => {
        await call('hidePanel');
        const deadline = Date.now() + 5000;
        while ((await call('editorCount')) !== 0) {
          if (Date.now() > deadline) throw new Error('the editors outlived the region');
          await sleep(50);
        }
        assert.equal((await call('probe', A)).exists, true, 'a.js lost its model with the region');
        await call('showPanel');
      },
      { scroll: true }
    );
  });

  test('MM-07: a terminal link and Go to File into a file of the group land on its line, in the editor the group has', async () => {
    needHarness();
    const editors = await call('editorCount');
    // c.js is in a.js's group, not shown: the link switches the group to it.
    await call('act', 'openFileAt', C, 1, 8);
    await settle('the link into c.js');
    let c = await call('probe', C);
    assert.equal(c.pane, panes.left, 'c.js did not open where it is');
    assert.deepEqual(c.position, { lineNumber: 1, column: 8 }, 'the link did not land on its line and column');
    assert.equal(await call('editorCount'), editors, 'the group made itself a new editor');
    // Back to a.js by a link to its own line: the caret goes there, and a.js
    // still has its model and its undo.
    await call('act', 'openFileAt', A, 3, 2);
    await settle('the link into a.js');
    const a = await call('probe', A);
    assert.deepEqual(a.position, { lineNumber: 3, column: 2 }, 'the link into a.js did not land');
    assert.equal(a.same, true, 'a.js lost its model to the link');
    assert.equal(a.canUndo, true, 'a.js lost its undo to the link');
    // A second link into the file already shown moves only the caret.
    await call('act', 'openFileAt', A, 5, 1);
    await sleep(150);
    assert.deepEqual((await call('probe', A)).position, { lineNumber: 5, column: 1 }, 'a second link did not move the caret');
    // Go to File on c.js: the keyboard goes to the editor, the caret stays.
    await call('act', 'bindEditorPaneToTab', panes.left, ids.C);
    await settle('c.js shown');
    await call('place', C, 1, 3);
    await call('act', 'bindEditorPaneToTab', panes.left, ids.A);
    await settle('a.js shown');
    await call('act', 'openFile', C);
    await call('act', 'focusEditor');
    await settle('Go to File c.js');
    c = await call('probe', C);
    assert.deepEqual(c.position, { lineNumber: 1, column: 3 }, 'Go to File moved the caret');
    assert.equal((await call('state')).pendingReveal, null, 'the request for the keyboard was never applied');
    assert.equal(
      await harness.evalJs('document.activeElement?.closest?.(".monaco-editor") != null'),
      true,
      'Go to File did not give the editor the keyboard'
    );
    await call('act', 'bindEditorPaneToTab', panes.left, ids.A);
    await settle('a.js shown');
    assertNoPageErrors();
  });

  test('MM-08 (AC2): closing the last tab on a file disposes its model, and only that one', async () => {
    needHarness();
    assert.ok((await call('models')).includes(await call('uri', C)), 'c.js has no model to dispose');
    await call('act', 'closeTab', ids.C);
    await settle('c.js closed');
    const models = await call('models');
    assert.ok(!models.includes(await call('uri', C)), 'c.js was closed and its model is still there');
    assert.equal((await call('probe', A)).same, true, 'closing c.js disposed a.js');
    assert.equal((await call('probe', A)).canUndo, true);
    assertNoPageErrors();
  });

  test('MM-09 (AC2): one file in two groups shares one model, and closing either group leaves it alive and undoable', async () => {
    needHarness();
    await call('setTree', {
      type: 'split',
      id: 'editor-split-shared',
      direction: 'horizontal',
      children: [
        { type: 'leaf', id: panes.left, tabIds: [ids.A], activeTabId: ids.A },
        { type: 'leaf', id: panes.right, tabIds: [ids.A, ids.B, ids.D], activeTabId: ids.A },
      ],
    });
    await settle('a.js in both groups');
    const both = await call('probe', A);
    assert.equal(both.editors, 2, 'a.js is not shown by two editors');
    assert.equal(both.same, true, 'the two groups do not share a.js\'s model');

    await call('act', 'closeEditorPane', panes.right);
    await settle('the right group closed');
    const left = await call('probe', A);
    assert.equal(left.same, true, 'closing one of the two groups disposed the model under the other');
    assert.equal(left.pane, panes.left);
    const models = await call('models');
    assert.ok(!models.includes(await call('uri', B)), 'b.js closed with its group, its model did not');
    assert.ok(!models.includes(await call('uri', D)), 'd.js closed with its group, its model did not');
    const before = left.value;
    const typed = await call('type', A, '/*shared*/');
    assert.notEqual(typed, before);
    assert.equal(await call('undo', A), before, 'a.js does not undo after the other group closed');
    assertNoPageErrors();
  });

  test('MM-10 (AC2): a rename and a move of an open file leave one model, at the new path, holding the same text', async () => {
    needHarness();
    const text = (await call('probe', A)).value;
    const renamed = `${DIR}/renamed.js`;
    await call('act', 'renamePath', A, 'renamed.js');
    await settle('a.js renamed');
    let models = await call('models');
    assert.ok(!models.includes(await call('uri', A)), 'the old path still has a model');
    assert.equal(models.length, 1, `one model for one open file, not ${JSON.stringify(models)}`);
    assert.ok(models.includes(await call('uri', renamed)), 'the new path has no model');
    let probe = await call('probe', renamed);
    assert.equal(probe.value, text, 'the renamed file does not hold the text it had');
    assert.equal(probe.pane, panes.left, 'the renamed file is not shown where it was');

    const moved = `${DIR}/sub/renamed.js`;
    await call('act', 'cutToClipboard', renamed, false);
    await call('act', 'pasteClipboard', `${DIR}/sub`);
    await settle('renamed.js moved');
    models = await call('models');
    assert.ok(!models.includes(await call('uri', renamed)), 'the path moved from still has a model');
    assert.ok(models.includes(await call('uri', moved)), 'the path moved to has no model');
    probe = await call('probe', moved);
    assert.equal(probe.value, text, 'the moved file does not hold the text it had');
    assert.equal(probe.editors, 1);
    assert.equal(models.length, 1, `one model for one open file, not ${JSON.stringify(models)}`);
    assertNoPageErrors();
  });

  test('MM-11 (AC2): Reload From Disk replaces the text through the model, and one undo brings the buffer back', async () => {
    needHarness();
    const path = `${DIR}/sub/renamed.js`;
    assert.equal(await call('hold', path), true);
    const buffer = (await call('probe', path)).value;
    await call('setDisk', path, 'export const fromDisk = true;\n');
    const { tabs } = await call('state');
    await call('act', 'reloadFromDisk', tabs[0].id);
    await settle('reloaded');
    let probe = await call('probe', path);
    assert.equal(probe.value, 'export const fromDisk = true;\n', 'the model does not hold what is on disk');
    assert.equal(probe.same, true, 'Reload From Disk replaced the model rather than its text');
    assert.equal(probe.canUndo, true, 'Reload From Disk cannot be undone');
    let state = await call('state');
    assert.equal(state.tabs[0].isDirty, false, 'the reloaded tab is unsaved');
    assert.equal(await call('undo', path), buffer, 'one undo did not bring back the buffer from before the reload');
    await sleep(50);
    state = await call('state');
    assert.equal(state.tabs[0].content, buffer, 'the tab does not follow the undo');
    assert.equal(state.tabs[0].isDirty, true, 'the buffer brought back is not unsaved');
    probe = await call('probe', path);
    assert.equal(probe.same, true);
    assertNoPageErrors();
  });

  test('MM-12 (AC2): another folder disposes every model of the one left, and closing every tab leaves none', async () => {
    needHarness();
    await call('act', 'saveAll');
    await call('act', 'openRoot', '/other');
    await settle('the other folder');
    const { rootPath } = await call('state');
    assert.equal(rootPath, '/other', 'the other folder did not open');
    let models = await call('models');
    assert.deepEqual(models, [], `the folder left kept models: ${JSON.stringify(models)}`);

    // A link into a file not open yet, with no editor in the group: the
    // editor that mounts for it lands on the line (`onMount`).
    await call('act', 'openFileAt', '/other/x.js', 1, 4);
    await settle('x.js');
    assert.deepEqual((await call('probe', '/other/x.js')).position, { lineNumber: 1, column: 4 }, 'the link did not land in a new editor');
    models = await call('models');
    assert.deepEqual(models, [await call('uri', '/other/x.js')]);
    // And with one: the same editor takes the new file, and lands too.
    const editors = await call('editorCount');
    await call('act', 'openFileAt', '/other/y.js', 1, 6);
    await settle('y.js');
    assert.deepEqual((await call('probe', '/other/y.js')).position, { lineNumber: 1, column: 6 }, 'the link did not land in the editor the group had');
    assert.equal(await call('editorCount'), editors, 'the group made itself a new editor');

    const { tabs } = await call('state');
    for (const tab of tabs) await call('act', 'closeTab', tab.id);
    await settle('every tab closed');
    models = await call('models');
    assert.deepEqual(models, [], `a closed file kept its model: ${JSON.stringify(models)}`);
    assert.equal(await call('editorCount'), 0, 'an editor outlived the last tab');
    assertNoPageErrors();
  });

  test('MM-13: mixed CRLF and LF line endings make no undo step and no unsaved tab; Reload From Disk is one step', async () => {
    needHarness();
    ids.X = await call('open', '/other/x.js');
    await settle('x.js');
    // Opened into the editor the group has: the library makes its model there.
    ids.M = await call('open', MIXED);
    await settle('mixed.js');
    assert.equal(await call('hold', MIXED), true, 'mixed.js has no model');
    let probe = await call('probe', MIXED);
    assert.equal(probe.value, MIXED_TEXT.replace(/\r?\n/g, '\r\n'), 'the model does not hold the text with one kind of line ending');
    const tabOf = async (id) => (await call('state')).tabs.find((t) => t.id === id);
    const seen = { shown: { canUndo: probe.canUndo, isDirty: (await tabOf(ids.M)).isDirty } };

    const pane = await paneOf(ids.M);
    await call('act', 'bindEditorPaneToTab', pane, ids.X);
    await settle('x.js again');
    await call('act', 'bindEditorPaneToTab', pane, ids.M);
    await settle('mixed.js again');
    probe = await call('probe', MIXED);
    let tab = await tabOf(ids.M);
    seen.back = { canUndo: probe.canUndo, isDirty: tab.isDirty };
    // Undone, the step nobody made leaves the tab unsaved with nothing changed.
    if (probe.canUndo) {
      await call('undo', MIXED);
      await sleep(50);
      seen.undone = { isDirty: (await tabOf(ids.M)).isDirty };
      await call('redo', MIXED);
      await sleep(50);
    }
    assert.deepEqual(
      seen,
      { shown: { canUndo: false, isDirty: false }, back: { canUndo: false, isDirty: false } },
      `a mixed file made an undo step or an unsaved tab, shown and switched back to: ${JSON.stringify(seen)}`
    );
    assert.equal(probe.same, true, 'mixed.js lost its model to the switch');
    assert.equal(tab.content, MIXED_TEXT, 'the tab no longer holds the file as read');

    // Save, untouched: the file as read, byte for byte.
    await call('act', 'saveFile', ids.M);
    assert.equal(await call('disk', MIXED), MIXED_TEXT, 'Save of an untouched mixed file changed it');

    // Reload From Disk: one edit, one undo step.
    const reloaded = 'const one = 1;\r\nconst two = 22;\nconst three = 3;\r\n';
    await call('setDisk', MIXED, reloaded);
    await call('act', 'reloadFromDisk', ids.M);
    await settle('mixed.js reloaded');
    probe = await call('probe', MIXED);
    assert.equal(probe.value, reloaded.replace(/\r?\n/g, '\r\n'), 'the model does not hold what is on disk');
    assert.equal(probe.canUndo, true, 'Reload From Disk cannot be undone');
    tab = await tabOf(ids.M);
    assert.equal(tab.isDirty, false, 'the reloaded tab is unsaved');
    assert.equal(await call('undo', MIXED), MIXED_TEXT.replace(/\r?\n/g, '\r\n'), 'one undo did not take back the reload');
    assert.equal((await call('probe', MIXED)).canUndo, false, 'Reload From Disk was more than one undo step');
    await call('redo', MIXED);
    await sleep(50);

    // Edited, Save writes what the editor shows: one kind of line ending.
    const typed = await call('type', MIXED, '// edited\r\n');
    await sleep(50);
    await call('act', 'saveFile', ids.M);
    assert.equal(await call('disk', MIXED), typed, 'Save of an edited mixed file did not write what the editor shows');

    // All CRLF, and all LF: held exactly as read, as before.
    ids.CR = await call('open', CRLF);
    await settle('crlf.js');
    probe = await call('probe', CRLF);
    assert.equal(probe.value, CRLF_TEXT, 'an all-CRLF file is not held as read');
    assert.equal(probe.canUndo, false, 'showing an all-CRLF file made an undo step');
    await call('act', 'bindEditorPaneToTab', pane, ids.X);
    await settle('x.js once more');
    probe = await call('probe', '/other/x.js');
    assert.equal(probe.value, 'export const x = 0;\n', 'an all-LF file is not held as read');
    assert.equal(probe.canUndo, false, 'showing an all-LF file made an undo step');
    await call('act', 'bindEditorPaneToTab', pane, ids.CR);
    await settle('crlf.js again');
    assert.equal((await call('probe', CRLF)).canUndo, false, 'switching back to an all-CRLF file made an undo step');
    assert.equal((await tabOf(ids.CR)).isDirty, false);
    await call('act', 'saveFile', ids.CR);
    assert.equal(await call('disk', CRLF), CRLF_TEXT, 'Save of an untouched all-CRLF file changed it');
    assertNoPageErrors();
  });

  test('MM-14: a literal %20 and its decoded twin are two files with two models; undo in one never brings in the other', async () => {
    needHarness();
    ids.E = await call('open', ENCODED);
    await settle('a%20b.js');
    ids.SP = await call('open', SPACED);
    await settle('a b.js');
    const pane = await paneOf(ids.SP);
    await call('act', 'bindEditorPaneToTab', pane, ids.E);
    await settle('a%20b.js again');
    const typed = await call('type', ENCODED, '/*encoded*/');
    await sleep(50);
    await call('act', 'bindEditorPaneToTab', pane, ids.SP);
    await settle('a b.js again');
    const models = await call('models');
    assert.notEqual(await call('uri', ENCODED), await call('uri', SPACED), 'the two names have one URI');
    assert.ok(models.includes(await call('uri', ENCODED)), 'a%20b.js has no model of its own');
    assert.ok(models.includes(await call('uri', SPACED)), 'a b.js has no model of its own');
    const spaced = await call('probe', SPACED);
    assert.equal(spaced.value, 'export const spaced = 2;\n', 'a b.js does not hold its own text');
    assert.equal(spaced.canUndo, false, 'a b.js can undo an edit nobody made in it');
    await call('undo', SPACED);
    await sleep(50);
    const { tabs } = await call('state');
    const spacedTab = tabs.find((t) => t.id === ids.SP);
    assert.equal(spacedTab.content, 'export const spaced = 2;\n', 'undo in a b.js brought in another text');
    assert.equal(spacedTab.isDirty, false);
    assert.equal(tabs.find((t) => t.id === ids.E).content, typed, 'a%20b.js lost its edit');
    assertNoPageErrors();
  });

  test('MM-15: Reload From Disk on a tab in the background edits its model; shown again, one undo brings the buffer back', async () => {
    needHarness();
    ids.BG = await call('open', '/other/bg.js');
    await settle('bg.js');
    assert.equal(await call('hold', '/other/bg.js'), true);
    const buffer = await call('type', '/other/bg.js', '/*unsaved*/');
    await sleep(50);
    const pane = await paneOf(ids.BG);
    await call('act', 'bindEditorPaneToTab', pane, ids.X);
    await settle('bg.js in the background');
    assert.equal((await call('probe', '/other/bg.js')).editors, 0, 'bg.js is still shown');

    await call('setDisk', '/other/bg.js', 'export const bg = "disk";\n');
    await call('act', 'reloadFromDisk', ids.BG);
    let probe = await call('probe', '/other/bg.js');
    assert.equal(probe.same, true, 'Reload From Disk replaced the model of a background tab');
    assert.equal(probe.value, 'export const bg = "disk";\n', 'the background model does not hold what is on disk');
    let tab = (await call('state')).tabs.find((t) => t.id === ids.BG);
    assert.equal(tab.content, 'export const bg = "disk";\n');
    assert.equal(tab.isDirty, false);

    await call('act', 'bindEditorPaneToTab', pane, ids.BG);
    await settle('bg.js shown');
    probe = await call('probe', '/other/bg.js');
    assert.equal(probe.same, true);
    assert.equal(probe.value, 'export const bg = "disk";\n', 'shown again, bg.js does not show what is on disk');
    assert.equal(await call('undo', '/other/bg.js'), buffer, 'one undo did not bring back the buffer from before the reload');
    await sleep(50);
    tab = (await call('state')).tabs.find((t) => t.id === ids.BG);
    assert.equal(tab.content, buffer, 'the tab does not follow the undo');
    assert.equal(tab.isDirty, true);
    assertNoPageErrors();
  });

  test('MM-16: a folder renamed with two open files in it moves both models, text and all', async () => {
    needHarness();
    ids.M1 = await call('open', '/other/dir/m1.js');
    await settle('m1.js');
    const m1 = await call('type', '/other/dir/m1.js', '/*m1*/');
    ids.M2 = await call('open', '/other/dir/m2.js');
    await settle('m2.js');
    const m2 = (await call('probe', '/other/dir/m2.js')).value;
    const before = (await call('models')).length;

    await call('act', 'renamePath', '/other/dir', 'dir2');
    await settle('dir renamed');
    const models = await call('models');
    assert.ok(!models.includes(await call('uri', '/other/dir/m1.js')), 'm1.js kept a model at its old path');
    assert.ok(!models.includes(await call('uri', '/other/dir/m2.js')), 'm2.js kept a model at its old path');
    assert.equal(models.length, before, `not one model per open file: ${JSON.stringify(models)}`);
    assert.equal((await call('probe', '/other/dir2/m1.js')).value, m1, 'm1.js lost its unsaved text');
    assert.equal((await call('probe', '/other/dir2/m2.js')).value, m2, 'm2.js lost its text');
    assert.equal((await call('probe', '/other/dir2/m2.js')).editors, 1, 'm2.js is not shown where it was');
    assertNoPageErrors();
  });

  test('MM-17: Cancel on the unsaved-close prompt keeps the model and its undo', async () => {
    needHarness();
    const path = '/other/dir2/m2.js';
    const { tabs } = await call('state');
    const id = tabs.find((t) => t.filePath === path).id;
    assert.equal(await call('hold', path), true);
    const before = (await call('probe', path)).value;
    const typed = await call('type', path, '/*unsaved*/');
    await sleep(50);
    await call('act', 'requestCloseTab', id);
    assert.equal((await call('state')).pendingClose, 'tab', 'no prompt asked about the unsaved tab');
    await call('act', 'cancelPendingClose');
    await settle('the close cancelled');
    const probe = await call('probe', path);
    assert.equal(probe.same, true, 'Cancel left the file another model');
    assert.equal(probe.value, typed);
    assert.equal(probe.canUndo, true, 'Cancel took the undo history');
    assert.equal(await call('undo', path), before, 'one undo did not take back the edit');
    assertNoPageErrors();
  });

  test('MM-18: a tab closed and a new tab on its path, with other text, shown in one render: no exception, the new text', async () => {
    needHarness();
    ids.P = await call('open', '/other/p.js');
    ids.Q = await call('open', '/other/q.js');
    const pane = await paneOf(ids.P);
    await call('act', 'bindEditorPaneToTab', pane, ids.P);
    await settle('p.js');
    assert.equal(await call('hold', '/other/p.js'), true);
    const again = await call('reopenAtOnce', ids.P, 'export const p = "reopened";\n');
    // The exception first, if there was one: it is why nothing would settle.
    const unsettled = await settle('p.js reopened').then(() => null, (err) => err);
    assertNoPageErrors();
    if (unsettled) throw unsettled;
    const probe = await call('probe', '/other/p.js');
    assert.equal(probe.value, 'export const p = "reopened";\n', 'the editor does not show the new text');
    assert.equal(probe.editors, 1, 'no editor shows p.js');
    assert.equal(probe.pane, pane, 'p.js is not shown in its group');
    assert.equal(probe.same, false, 'the new tab took the closed tab\'s model');
    assert.equal(probe.canUndo, false, 'the new tab can undo into the closed tab\'s text');
    const tab = (await call('state')).tabs.find((t) => t.id === again);
    assert.equal(tab.content, 'export const p = "reopened";\n');
    assert.equal(tab.isDirty, false);
  });

  test('MM-20: a UTF-8 BOM file, CRLF or LF, makes no undo step and no unsaved tab; Save keeps its BOM', async () => {
    needHarness();
    ids.X = await call('open', '/other/x.js');
    await settle('x.js');
    const tabOf = async (id) => (await call('state')).tabs.find((t) => t.id === id);
    const seen = {};
    const want = {};
    for (const [path, text] of BOM_FILES) {
      ids[path] = await call('open', path);
      await settle(path);
      assert.equal(await call('hold', path), true, `${path} has no model`);
      const look = async () => {
        const probe = await call('probe', path);
        const tab = await tabOf(ids[path]);
        // A BOM in the model's text is an ordinary, invisible character: Monaco keeps a file's own apart.
        return { canUndo: probe.canUndo, isDirty: tab.isDirty, bomInText: probe.value.startsWith(BOM), same: probe.same };
      };
      const file = { shown: await look() };
      const pane = await paneOf(ids[path]);
      await call('act', 'bindEditorPaneToTab', pane, ids.X);
      await settle(`x.js, from ${path}`);
      await call('act', 'bindEditorPaneToTab', pane, ids[path]);
      await settle(`${path} again`);
      file.back = await look();
      // Undone, the step nobody made leaves the tab unsaved, holding what Save writes.
      if (file.back.canUndo) {
        await call('undo', path);
        await sleep(50);
        const tab = await tabOf(ids[path]);
        file.undone = { isDirty: tab.isDirty, saveKeepsBOM: tab.content.startsWith(BOM) };
        await call('redo', path);
        await sleep(50);
      }
      // Save, untouched: the same bytes.
      await call('act', 'saveFile', ids[path]);
      file.saved = (await call('disk', path)) === text;
      // Reload From Disk with the same text: no undo step.
      await call('act', 'reloadFromDisk', ids[path]);
      await settle(`${path} reloaded`);
      file.reloaded = await look();
      seen[path] = file;
      const clean = { canUndo: false, isDirty: false, bomInText: false, same: true };
      want[path] = { shown: clean, back: clean, saved: true, reloaded: clean };
    }
    assert.deepEqual(seen, want, `a BOM file made an undo step, an unsaved tab or a changed file: ${JSON.stringify(seen)}`);

    // Edited: the buffer, and so Save, keep the BOM; undone, the tab is clean again.
    for (const [path, text] of BOM_FILES) {
      await call('act', 'bindEditorPaneToTab', await paneOf(ids[path]), ids[path]);
      await settle(`${path} shown to edit`);
      const typed = await call('type', path, '/*edited*/');
      await sleep(50);
      let tab = await tabOf(ids[path]);
      assert.equal(tab.content, BOM + typed, `${path}: the edited buffer is not the BOM and the editor's text`);
      assert.equal(tab.isDirty, true);
      assert.equal(BOM + (await call('undo', path)), text, `${path}: one undo did not take back the edit`);
      await sleep(50);
      assert.equal((await tabOf(ids[path])).isDirty, false, `${path}: undone to the text as read, the tab is unsaved`);
      await call('redo', path);
      await sleep(50);
      await call('act', 'saveFile', ids[path]);
      assert.equal(await call('disk', path), BOM + typed, `${path}: Save of an edited BOM file did not write the BOM and the editor's text`);
      tab = await tabOf(ids[path]);
      assert.equal(tab.isDirty, false);
    }
    assertNoPageErrors();
  });

  test('MM-21: Reload From Disk takes line endings converted outside the app, as one undo step; Save then keeps them', async () => {
    needHarness();
    const tabOf = async (id) => (await call('state')).tabs.find((t) => t.id === id);
    ids.EOL = await call('open', EOL);
    await settle('eol.js');
    assert.equal(await call('hold', EOL), true, 'eol.js has no model');
    assert.equal((await call('probe', EOL)).eol, '\r\n');

    // CRLF to LF.
    const lf = EOL_TEXT.replace(/\r\n/g, '\n');
    await call('setDisk', EOL, lf);
    await call('act', 'reloadFromDisk', ids.EOL);
    await settle('eol.js reloaded as LF');
    let probe = await call('probe', EOL);
    assert.equal(probe.same, true, 'Reload From Disk replaced the model');
    assert.equal(probe.eol, '\n', 'the model kept CRLF where the disk now has LF');
    assert.equal(probe.value, lf);
    assert.equal(probe.canUndo, true, 'the new line ending cannot be undone');
    let tab = await tabOf(ids.EOL);
    assert.equal(tab.content, lf);
    assert.equal(tab.isDirty, false, 'the reloaded tab is unsaved');
    assert.equal(await call('undo', EOL), EOL_TEXT, 'one undo did not bring CRLF back');
    assert.equal((await call('probe', EOL)).canUndo, false, 'the new line ending was more than one undo step');
    await sleep(50);
    assert.equal((await tabOf(ids.EOL)).isDirty, true, 'undone, the tab does not differ from the disk');
    await call('redo', EOL);
    await sleep(50);
    assert.equal((await tabOf(ids.EOL)).isDirty, false);

    // Edited, Save writes LF throughout: what is on disk now, not what was.
    const typed = await call('type', EOL, '/*edited*/');
    await sleep(50);
    await call('act', 'saveFile', ids.EOL);
    const written = await call('disk', EOL);
    assert.equal(written, typed, 'Save did not write what the editor shows');
    assert.ok(!written.includes('\r'), `Save wrote CRLF back over the LF on disk: ${JSON.stringify(written)}`);

    // And LF to CRLF.
    const crlf = written.replace(/\n/g, '\r\n');
    await call('setDisk', EOL, crlf);
    await call('act', 'reloadFromDisk', ids.EOL);
    await settle('eol.js reloaded as CRLF');
    probe = await call('probe', EOL);
    assert.equal(probe.eol, '\r\n', 'the model kept LF where the disk now has CRLF');
    assert.equal(probe.value, crlf);
    tab = await tabOf(ids.EOL);
    assert.equal(tab.isDirty, false);
    assertNoPageErrors();
  });

  test('MM-22: Reload From Disk with other lines and another line ending is one step, undone and redone exactly, both ways', async () => {
    needHarness();
    const tabOf = async (id) => (await call('state')).tabs.find((t) => t.id === id);
    const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
    const seen = {};
    const want = {};
    for (const [path, text, disk] of COMBINED) {
      ids[path] = await call('open', path);
      await settle(path);
      assert.equal(await call('hold', path), true, `${path} has no model`);
      const read = await call('probe', path);
      assert.equal(read.value, text, `${path} is not held as read`);
      assert.equal(read.eol, eolOf(text));
      assert.equal(read.canUndo, false, `showing ${path} made an undo step`);
      const look = async () => {
        const probe = await call('probe', path);
        const tab = await tabOf(ids[path]);
        return { value: probe.value, eol: probe.eol, same: probe.same, canUndo: probe.canUndo, content: tab.content, isDirty: tab.isDirty };
      };
      await call('setDisk', path, disk);
      await call('act', 'reloadFromDisk', ids[path]);
      await settle(`${path} reloaded`);
      const file = { reloaded: await look() };
      await call('undo', path);
      await sleep(50);
      file.undone = await look();
      await call('redo', path);
      await sleep(50);
      file.redone = await look();
      seen[path] = file;
      const onDisk = { value: disk, eol: eolOf(disk), same: true, canUndo: true, content: disk, isDirty: false };
      want[path] = {
        reloaded: onDisk,
        // One undo: exactly the text and line ending from before, nothing left to undo, unsaved against the disk.
        undone: { value: text, eol: eolOf(text), same: true, canUndo: false, content: text, isDirty: true },
        // One redo: exactly what is on disk, and the tab clean again.
        redone: onDisk,
      };
    }
    assert.deepEqual(seen, want, `a reload with other lines and another line ending did not undo or redo exactly: ${JSON.stringify(seen)}`);
    assertNoPageErrors();
  });

  test('MM-19: teardown', () => {
    if (!harness) skip(NO_HARNESS);
    harness.teardown();
    harness = null;
  });
});
