/**
 * Preview tabs (Orca bundle 5, step P3): tabs that show a file rather than
 * edit it, in src/stores/editorStore.js. A text tab has no `kind`, as it
 * never had; an image tab is kind 'image', a Markdown preview kind
 * 'markdown'. A tab is a kind and a path.
 *
 *   AC-B4-5 (first half)  openFile on an image sends `fs_read_image`, never
 *           `fs_read_file`, and makes a kind 'image' tab; opening it again
 *           reveals that tab; a refusal for what the file is stays on the
 *           tab as its reason; Save and Save All never write it, it is
 *           never dirty, and closing it never asks (EP-01..06)
 *   AC-B3-7 (first half)  openMarkdownPreview makes a kind 'markdown' tab
 *           in a split to the right of the source, beside the source's
 *           own tab on the same path; a second call reveals it; it is not
 *           dirty and not saved; anything but .md / .markdown does nothing
 *           (EP-05, EP-06, EP-07..11)
 *   Text tabs are unchanged (EP-12).
 *
 * Step P4, the second half: preview tabs kept out of the text-only machinery
 * and following their file.
 *
 *   AC-B4-5, AC-B3-7  no Monaco model is made or kept for a preview; the
 *           text tab of the same file keeps its own (EP-14); Send to Agent
 *           does not see a preview (EP-15)
 *   Session  previews are not saved and not restored; a preview never
 *           takes its text tab's place in the session or the restore; a
 *           session from before, or a crafted one with a kind, restores
 *           text tabs only (EP-16..19)
 *   AC-B3-7  a rename or a move takes previews along (EP-20); a delete
 *           keeps them, marked deleted on disk, with what they last showed;
 *           text tabs are closed as before (EP-21)
 *   AC-B3-8 (disk half)  with no source tab, a modify of the file is one
 *           read 300 ms after the last change, a change elsewhere none;
 *           an image is read again the same way; reads are cancelled and
 *           late answers dropped (EP-22..25, fake timers)
 *   Focus    no reveal is parked for a preview (EP-26)
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  useEditorStore,
  registerEditorBridge,
  isPreviewTab,
  isMarkdownPath,
  whenTabsRestored,
  EDITOR_SESSIONS_KEY,
  MARKDOWN_PREVIEW_MAX_BYTES,
  PREVIEW_FOLLOW_MS,
  PREVIEW_FOLLOW_MAX_MS,
  PREVIEW_KINDS,
  __previewReadsPending,
  __previewChecksPending,
} from '../../src/stores/editorStore.js';
import { useTerminalStore, __editorBridge } from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useToastStore } from '../../src/stores/toastStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';
import { SESSION_FORMAT, normalizeSessions, serializeSession } from '../../src/lib/editorSession.js';
import { showFile, trackEditor, watchEditorModels } from '../../src/lib/editorModels.js';
import { sendCommandState, sendFileToAgent, sendSelectionToAgent } from '../../src/lib/sendToAgent.js';
import { NO_EDITOR_FILE_REASON, SAVE_FIRST_REASON, notSentText } from '../../src/lib/agentReference.js';
import { leafKind, leavesOfKind } from '../../src/components/terminal/splitLayout.js';
import { findLinks, resolveLinkPath } from '../../src/lib/terminalLinks.js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { onPage, letItRun } from './react_page.js';

const E = useEditorStore;
const T = useTerminalStore;

const LOGO_PNG = '/workspace/assets/logo.png';
const LOGO_SVG = '/workspace/assets/logo.svg';
const NOT_AN_IMAGE_FORMAT = 'File is not an image NexTerm can show (it is no PNG, JPEG, GIF, WebP or SVG)';

// --- storage, IPC recording ---------------------------------------------------
const backing = new Map();
let previousStorage;
let hadStorage = false;
let installed = false;
const calls = [];
/** A stand-in for some commands: `(args, real) => answer`; anything else goes to the mock. */
let answers = {};
/** Mock images a case added, taken out again afterwards. */
const addedImages = [];

function installStorage() {
  if (!installed) {
    hadStorage = 'localStorage' in globalThis;
    previousStorage = globalThis.localStorage;
    installed = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

function recordIpc() {
  calls.length = 0;
  const real = Object.getPrototypeOf(mockBridge).invoke;
  mockBridge.invoke = function recording(command, args, ...rest) {
    calls.push({ command, args });
    const answer = answers[command];
    const own = () => real.call(mockBridge, command, args, ...rest);
    return answer ? answer(args, own) : own();
  };
}

async function setUp() {
  T.getState().dispose();
  backing.clear();
  installStorage();
  useSettingsStore.getState().resetSettings();
  answers = {};
  recordIpc();
  registerEditorBridge();
  E.setState({ tabs: [], activeTabId: null, pendingClose: null, pendingOverwrite: null, openFailure: null, pendingReveal: null, rootPath: '/workspace' });
  T.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    groups: [{ id: 'group-1', name: 'Group 1', createdAt: 1, tree: { type: 'leaf', id: 'pane-1', tabIds: [], activeTabId: null }, activePaneId: 'pane-1' }],
    activeGroupId: 'group-1',
  });
  await T.getState().init();
  calls.length = 0;
}

function teardown() {
  delete mockBridge.invoke;
  answers = {};
  for (const path of addedImages.splice(0)) mockBridge.images.delete(path);
  E.setState({ tabs: [], activeTabId: null, pendingClose: null, openFailure: null, pendingReveal: null });
  T.getState().dispose();
  useSettingsStore.getState().resetSettings();
  if (installed) {
    if (hadStorage) globalThis.localStorage = previousStorage;
    else delete globalThis.localStorage;
    installed = false;
  }
}

let counter = 0;
/** A new file in the mock, named `<name>_<unique>.<ext>`. */
async function file(name, ext, content = 'on disk') {
  counter += 1;
  const path = `/workspace/_ep_${name}_${Date.now()}_${counter}.${ext}`;
  await invoke('fs_write_file', { path, content });
  calls.length = 0;
  return path;
}

/** A mock image at a path of its own: `entry` as MOCK_IMAGES holds one. */
function image(name, ext, entry) {
  counter += 1;
  const path = `/workspace/assets/_ep_${name}_${counter}.${ext}`;
  mockBridge.images.set(path, entry);
  addedImages.push(path);
  return path;
}

/** What `promise` rejected with; a case fails if it did not. The store's console report is kept out of the output. */
async function failureOf(promise) {
  const report = console.error;
  console.error = () => {};
  try {
    await promise;
  } catch (err) {
    return err;
  } finally {
    console.error = report;
  }
  throw new Error('it did not fail');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const commands = () => calls.map((c) => c.command);
const reads = () => calls.filter((c) => c.command === 'fs_read_file' || c.command === 'fs_read_image' || c.command === 'fs_file_size');
const writes = () => calls.filter((c) => c.command === 'fs_write_file');
const tabById = (id) => E.getState().tabs.find((t) => t.id === id);
const active = () => T.getState().getActiveGroup();
const groupById = (id) => T.getState().groups.find((g) => g.id === id);
const editorLeafCount = () => T.getState().groups.reduce((n, g) => n + leavesOfKind(g.tree, 'editor').length, 0);
const holderOf = (tabId) => {
  for (const g of T.getState().groups) {
    const leaf = leavesOfKind(g.tree, 'editor').find((l) => l.tabIds.includes(tabId));
    if (leaf) return { group: g, leaf };
  }
  return null;
};
/** The split that holds leaf `id` as a child, and where. */
function parentOf(node, id) {
  if (!node || node.type === 'leaf') return null;
  const at = node.children.findIndex((c) => c.id === id);
  if (at >= 0) return { split: node, at };
  for (const child of node.children) {
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}
/** Whether `tabId`'s leaf sits right of `leftLeafId`, the next of one side-by-side split. */
function rightOf(tabId, leftLeafId) {
  const holder = holderOf(tabId);
  if (!holder) return false;
  const parent = parentOf(holder.group.tree, leftLeafId);
  return Boolean(parent) && parent.split.direction === 'horizontal' && parent.split.children[parent.at + 1]?.id === holder.leaf.id;
}
/** Mark tabs as dirty in the state itself, as no action of the store ever would for a preview. */
function forceDirty(ids) {
  E.setState((s) => ({ tabs: s.tabs.map((t) => (ids.includes(t.id) ? { ...t, isDirty: true } : t)) }));
}

// ---- Image tabs ----------------------------------------------------------------

describe('Preview tabs: an image opens as an image tab (AC-B4-5)', () => {
  beforeEach(setUp);
  afterEach(teardown);

  test('EP-01: openFile on an image sends fs_read_image with its path, never fs_read_file, and makes a kind \'image\' tab holding the answer', async () => {
    const tab = await E.getState().openFile(LOGO_PNG);
    assert.deepEqual(reads(), [{ command: 'fs_read_image', args: { path: LOGO_PNG } }], 'one image read and no text read');
    assert.equal(tab.kind, 'image');
    assert.equal(tab.filePath, LOGO_PNG);
    assert.equal(tab.fileName, 'logo.png');
    assert.equal(tab.isDirty, false);
    assert.equal(tab.failure, null);
    assert.deepEqual(
      { mime: tab.image.mime, bytes: tab.image.bytes, width: tab.image.width, height: tab.image.height, data: tab.image.data },
      { mime: 'image/png', bytes: 80, width: 4, height: 3, data: mockBridge.images.get(LOGO_PNG).data }
    );
    assert.ok(!('content' in tab) && !('savedContent' in tab), 'it holds no text');
    assert.ok(isPreviewTab(tab));
    assert.equal(E.getState().activeTabId, tab.id);
    assert.equal(E.getState().openFailure, null);
    assert.equal(leafKind(holderOf(tab.id).leaf), 'editor', 'placed as a new file is');

    // An SVG is UTF-8 text the text read would take: it must still be an image tab.
    calls.length = 0;
    const svg = await E.getState().openFile(LOGO_SVG);
    assert.deepEqual(commands().filter((c) => c.startsWith('fs_read')), ['fs_read_image']);
    assert.equal(svg.kind, 'image');
    assert.equal(svg.image.mime, 'image/svg+xml');
    assert.equal(svg.image.width, null);
    assert.ok(!('content' in svg));
  });

  test('EP-02: opening an image again reveals the same tab, where it is, without reading it again; two opens at once make one tab', async () => {
    const one = active().id;
    const two = await T.getState().createGroup({ name: 'Two' });
    const tab = await E.getState().openFile(LOGO_PNG);
    assert.equal(holderOf(tab.id).group.id, two.id);
    T.getState().setActiveGroup(one);
    calls.length = 0;
    const again = await E.getState().openFile(LOGO_PNG);
    assert.equal(again.id, tab.id);
    assert.equal(E.getState().tabs.length, 1, 'no second tab');
    assert.deepEqual(reads(), [], 'not read again');
    assert.equal(T.getState().activeGroupId, two.id, 'its group comes on screen');
    assert.equal(holderOf(tab.id).leaf.activeTabId, tab.id);
    assert.equal(E.getState().activeTabId, tab.id);

    E.getState().closeTab(tab.id);
    const [x, y] = await Promise.all([E.getState().openFile(LOGO_SVG), E.getState().openFile(LOGO_SVG)]);
    assert.equal(x.id, y.id, 'the second open finds the first one\'s tab when its read comes back');
    assert.equal(E.getState().tabs.filter((t) => t.filePath === LOGO_SVG).length, 1);
  });

  test('EP-03: an image refused for what it is opens its tab with the reason — the backend\'s words without the path, cleaned — and no notice', async () => {
    // A text file named .png, and one named .WEBP: an image tab whatever the case.
    for (const ext of ['png', 'WEBP']) {
      const path = await file('fake', ext, 'not really an image');
      const notices = [];
      const stop = E.subscribe((s) => {
        if (s.openFailure) notices.push(s.openFailure);
      });
      let tab;
      try {
        tab = await E.getState().openFile(path);
      } finally {
        stop();
      }
      assert.equal(tab.kind, 'image', ext);
      assert.equal(tab.image, null);
      assert.equal(tab.failure, NOT_AN_IMAGE_FORMAT);
      assert.ok(!commands().includes('fs_read_file'), 'never read as text first');
      assert.equal(E.getState().openFailure, null, 'the tab says why; no notice');
      assert.deepEqual(notices, [], 'not even for a moment');
      calls.length = 0;
      assert.equal((await E.getState().openFile(path)).id, tab.id, 'and opening it again reveals it');
      assert.deepEqual(reads(), []);
    }

    const big = image('big', 'png', { mime: 'image/png', data: '', bytes: 25 * 1024 * 1024, width: 10, height: 10 });
    const bigTab = await E.getState().openFile(big);
    assert.equal(bigTab.failure, 'Image is too large to preview (25.0 MB; the limit is 20 MB)');
    assert.equal(bigTab.image, null);

    const wide = image('wide', 'gif', { mime: 'image/gif', data: 'R0lGODlh', width: 100000, height: 10 });
    assert.match((await E.getState().openFile(wide)).failure, /^Image is too large to preview \(100000 × 10; the limit is 32768 px per side and 32 Mi pixels\)$/);

    // Tauri rejects with the command's own string; hostile characters go.
    const hostile = '/workspace/assets/_ep_hostile.jpg';
    answers.fs_read_image = (args) => Promise.reject(`File is not an image NexTerm can show (its header is not valid‮​\u001b): ${args.path}`);
    const hostileTab = await E.getState().openFile(hostile);
    assert.equal(hostileTab.failure, 'File is not an image NexTerm can show (its header is not valid)');
    assert.equal(E.getState().openFailure, null);
  });

  test('EP-04: an image that is not there, or outside what may be read, opens no tab and says why, as a text file does', async () => {
    const missing = '/workspace/assets/_ep_nope.png';
    const err = await failureOf(E.getState().openFile(missing));
    assert.match(String(err?.message ?? err), /^File not found: /);
    assert.deepEqual(E.getState().tabs, []);
    assert.deepEqual(E.getState().openFailure, { path: missing, fileName: '_ep_nope.png', reason: 'File not found' });
    assert.ok(!commands().includes('fs_read_file'));

    answers.fs_read_image = () => Promise.reject('No folder is open');
    await failureOf(E.getState().openFile('/elsewhere/x.webp'));
    assert.deepEqual(E.getState().tabs, []);
    assert.equal(E.getState().openFailure?.reason, 'No folder is open');

    answers.fs_read_image = (args) => Promise.reject(`Failed to read file '${args.path}': Permission denied (os error 13)`);
    await failureOf(E.getState().openFile('/workspace/assets/_ep_locked.gif'));
    assert.deepEqual(E.getState().tabs, []);
    assert.equal(E.getState().openFailure?.reason, 'Failed to read file: Permission denied (os error 13)');
  });
});

// ---- Nothing to save, nothing to ask ----------------------------------------------

describe('Preview tabs: never dirty, never saved, closed without a question (AC-B4-5, AC-B3-7)', () => {
  beforeEach(setUp);
  afterEach(teardown);

  test('EP-05: Save and Save All never write an image or Markdown preview, and no edit makes one dirty', async () => {
    const mdPath = await file('notes', 'md', '# Notes');
    const img = await E.getState().openFile(LOGO_PNG);
    const md = await E.getState().openMarkdownPreview(mdPath);
    const textPath = await file('text', 'txt', 'before');
    const text = await E.getState().openFile(textPath);
    E.getState().editBuffer(text.id, 'after');
    E.getState().editBuffer(img.id, 'typed into an image');
    E.getState().editBuffer(md.id, 'typed into a preview');
    assert.deepEqual(tabById(img.id), img, 'an edit changes nothing on a preview tab');
    assert.deepEqual(tabById(md.id), md);
    assert.ok(E.getState().tabs.filter(isPreviewTab).every((t) => t.isDirty === false));

    calls.length = 0;
    await E.getState().saveFile(img.id);
    await E.getState().saveFile(md.id);
    E.getState().switchTab(img.id);
    assert.equal(E.getState().activeTabId, img.id);
    await E.getState().saveFile();
    assert.deepEqual(calls, [], 'Save on a preview tab reads nothing and writes nothing');

    await E.getState().saveAll();
    assert.deepEqual(writes().map((c) => c.args.path), [textPath], 'Save All writes the text tab and nothing else');

    // A preview tab that says it is dirty is still none of Save All's business.
    forceDirty([img.id, md.id]);
    calls.length = 0;
    await E.getState().saveAll();
    await E.getState().saveFile(md.id);
    assert.deepEqual(writes(), []);
  });

  test('EP-06: closing a preview tab, its pane, its group or the window never asks — whatever its isDirty says', async () => {
    const one = active().id;
    const two = await T.getState().createGroup({ name: 'Two' });
    const mdPath = await file('close', 'markdown', 'text');
    const img = await E.getState().openFile(LOGO_PNG);
    const md = await E.getState().openMarkdownPreview(mdPath);
    forceDirty([img.id, md.id]);

    assert.equal(E.getState().askBeforeLeaving('window', () => 'gone'), null, 'nothing unsaved: the window closes unasked');
    assert.deepEqual(__editorBridge().dirtyTabIds([img.id, md.id]), [], 'the workbench hears of no unsaved file');

    // The group: the bridge asks terminalStore's closeGroup nothing.
    const closing = T.getState().closeGroup(two.id);
    const outcome = await Promise.race([closing, sleep(200).then(() => 'still asking')]);
    assert.equal(outcome, true, 'the group closed without a question');
    assert.equal(E.getState().pendingClose, null);
    assert.equal(groupById(two.id), undefined);
    assert.deepEqual(E.getState().tabs, []);

    T.getState().setActiveGroup(one);
    const img2 = await E.getState().openFile(LOGO_SVG);
    const md2 = await E.getState().openMarkdownPreview(mdPath);
    forceDirty([img2.id, md2.id]);
    E.getState().requestCloseTab(img2.id);
    assert.equal(E.getState().pendingClose, null);
    assert.equal(tabById(img2.id), undefined, 'closed at once');
    const pane = holderOf(md2.id).leaf.id;
    E.getState().requestCloseEditorPane(pane);
    assert.equal(E.getState().pendingClose, null);
    assert.equal(tabById(md2.id), undefined);
  });
});

// ---- Markdown previews --------------------------------------------------------------

describe('Preview tabs: a Markdown preview opens beside its source (AC-B3-7)', () => {
  beforeEach(setUp);
  afterEach(teardown);

  test('EP-07: with the source open, the preview is a kind \'markdown\' tab in a new leaf right of the source\'s, showing its buffer; both tabs stay; a second call reveals it', async () => {
    const path = await file('readme', 'md', '# Title\n\nbody');
    const source = await E.getState().openFile(path);
    E.getState().editBuffer(source.id, '# Edited');
    const sourceLeaf = holderOf(source.id).leaf.id;
    const leaves = editorLeafCount();
    calls.length = 0;

    const preview = await E.getState().openMarkdownPreview(path);
    assert.equal(preview.kind, 'markdown');
    assert.equal(preview.filePath, path);
    assert.equal(preview.isDirty, false);
    assert.deepEqual({ text: preview.text, bytes: preview.bytes, tooLarge: preview.tooLarge }, { text: '# Edited', bytes: 8, tooLarge: false }, 'the source\'s buffer, unsaved edit and all');
    assert.deepEqual(reads(), [], 'the open buffer is used; nothing is read');
    assert.deepEqual(E.getState().tabs.filter((t) => t.filePath === path).map((t) => t.id), [source.id, preview.id], 'two tabs of one file');
    assert.equal(editorLeafCount(), leaves + 1);
    assert.ok(rightOf(preview.id, sourceLeaf), 'in a split to the right of the source');
    assert.equal(holderOf(source.id).leaf.id, sourceLeaf, 'the source stays where it was');
    assert.equal(holderOf(source.id).leaf.activeTabId, source.id);
    assert.equal(E.getState().activeTabId, preview.id);
    assert.equal(tabById(source.id).content, '# Edited');

    const again = await E.getState().openMarkdownPreview(path);
    assert.equal(again.id, preview.id);
    assert.equal(E.getState().tabs.length, 2);
    assert.equal(editorLeafCount(), leaves + 1, 'no further split');
    assert.deepEqual(reads(), []);

    // And the source is still the source: openFile reveals the text tab, not the preview.
    const text = await E.getState().openFile(path);
    assert.equal(text.id, source.id);
    assert.equal(E.getState().activeTabId, source.id);
    assert.equal(E.getState().tabs.length, 2);

    // A preview a layout change left in no leaf is put back beside its source, not where a new file goes.
    T.getState().removeEditorTabs([preview.id]);
    assert.equal(holderOf(preview.id), null);
    const back = await E.getState().openMarkdownPreview(path);
    assert.equal(back.id, preview.id);
    assert.ok(rightOf(preview.id, sourceLeaf), 'back to the right of the source');
    assert.equal(E.getState().activeTabId, preview.id);
  });

  test('EP-08: with no source open, the file is read once (size first) and the preview opens right of the editor pane; the source then opens as a tab of its own', async () => {
    const other = await E.getState().openFile(await file('other', 'txt', 'x'));
    const otherLeaf = holderOf(other.id).leaf.id;
    const path = await file('guide', 'markdown', '# Guide');
    const preview = await E.getState().openMarkdownPreview(path);
    assert.deepEqual(reads(), [
      { command: 'fs_file_size', args: { path } },
      { command: 'fs_read_file', args: { path } },
    ]);
    assert.equal(preview.text, '# Guide');
    assert.equal(preview.tooLarge, false);
    assert.ok(rightOf(preview.id, otherLeaf), 'right of the editor pane of the group on screen');
    assert.equal(E.getState().tabs.filter((t) => t.filePath === path).length, 1, 'no text tab was opened');

    const source = await E.getState().openFile(path);
    assert.notEqual(source.id, preview.id);
    assert.equal(source.kind, undefined);
    assert.equal(source.content, '# Guide');
    assert.equal(E.getState().tabs.filter((t) => t.filePath === path).length, 2);

    // A second call while the first is reading: one preview.
    const later = await file('race', 'md', '# Race');
    const [x, y] = await Promise.all([E.getState().openMarkdownPreview(later), E.getState().openMarkdownPreview(later)]);
    assert.equal(x.id, y.id);
    assert.equal(E.getState().tabs.filter((t) => t.filePath === later).length, 1);
  });

  test('EP-09: an editor leaf already right of the source takes the preview; with no editor at all it goes where a new file goes', async () => {
    const path = await file('beside', 'md', '# Beside');
    const source = await E.getState().openFile(path);
    const left = holderOf(source.id).leaf.id;
    const right = E.getState().splitEditorPane(left, 'horizontal');
    const other = await E.getState().openFile(await file('right', 'txt', 'r'));
    assert.equal(holderOf(other.id).leaf.id, right);
    const leaves = editorLeafCount();

    const preview = await E.getState().openMarkdownPreview(path);
    assert.equal(holderOf(preview.id).leaf.id, right, 'into the leaf to the right, as VS Code\'s "to the side"');
    assert.equal(editorLeafCount(), leaves, 'no split each time');
    assert.equal(holderOf(source.id).leaf.id, left);

    // The editor pane split off empty, and no source open: the preview fills that pane.
    const empty = E.getState().splitEditorPane(right, 'horizontal');
    const unopened = await file('unopened', 'md', '# Unopened');
    const into = await E.getState().openMarkdownPreview(unopened);
    assert.equal(holderOf(into.id).leaf.id, empty, 'into the empty pane, not a split beside it');

    // A group with no editor leaf: [editor 60 | terminals 40], as for any file.
    const two = await T.getState().createGroup({ name: 'Two' });
    const lone = await file('lone', 'md', '# Lone');
    const lonePreview = await E.getState().openMarkdownPreview(lone);
    const g = groupById(two.id);
    assert.equal(holderOf(lonePreview.id).group.id, two.id);
    assert.equal(g.tree.type, 'split');
    assert.deepEqual(g.tree.sizes, [60, 40]);
    assert.deepEqual(g.tree.children[0].tabIds, [lonePreview.id]);
  });

  test('EP-10: .md and .markdown in any case open a preview; any other path does nothing, reads nothing and resolves to null', async () => {
    assert.deepEqual([...PREVIEW_KINDS], ['image', 'markdown']);
    for (const ext of ['MD', 'Markdown']) {
      const path = await file('case', ext, '# Case');
      const preview = await E.getState().openMarkdownPreview(path);
      assert.equal(preview?.kind, 'markdown', ext);
      assert.ok(isMarkdownPath(path));
    }
    const before = E.getState().tabs;
    calls.length = 0;
    const txt = await file('plain', 'txt', 'x');
    calls.length = 0;
    for (const path of [txt, '/workspace/a.mdx', '/workspace/README', '/workspace/a.md.txt', '/workspace/.md', LOGO_PNG, '', null, undefined, 42, {}, ['/workspace/a.md']]) {
      assert.equal(await E.getState().openMarkdownPreview(path), null, String(path));
      assert.ok(!isMarkdownPath(path), String(path));
    }
    assert.deepEqual(calls, [], 'not one call');
    assert.equal(E.getState().tabs, before, 'no tab');
    assert.equal(E.getState().openFailure, null);
  });

  test('EP-11: a file past 2 MB opens a too-large preview without being read; one that will not read opens nothing and says why', async () => {
    const big = await file('big', 'md', 'x'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1));
    const tooLarge = await E.getState().openMarkdownPreview(big);
    assert.deepEqual({ text: tooLarge.text, bytes: tooLarge.bytes, tooLarge: tooLarge.tooLarge }, { text: null, bytes: MARKDOWN_PREVIEW_MAX_BYTES + 1, tooLarge: true });
    assert.deepEqual(commands().filter((c) => c.startsWith('fs_')), ['fs_file_size'], 'its size is asked; it is never read');

    const edge = await file('edge', 'md', 'y'.repeat(MARKDOWN_PREVIEW_MAX_BYTES));
    const atLimit = await E.getState().openMarkdownPreview(edge);
    assert.equal(atLimit.tooLarge, false);
    assert.equal(atLimit.text.length, MARKDOWN_PREVIEW_MAX_BYTES);

    // The source's buffer, counted in UTF-8 bytes: 1 Mi 'é' is 2 MB and one more byte goes past.
    const small = await file('small', 'md', 'small');
    const source = await E.getState().openFile(small);
    E.getState().editBuffer(source.id, `${'é'.repeat(MARKDOWN_PREVIEW_MAX_BYTES / 2)}x`);
    const fromBuffer = await E.getState().openMarkdownPreview(small);
    assert.equal(fromBuffer.tooLarge, true);
    assert.equal(fromBuffer.bytes, MARKDOWN_PREVIEW_MAX_BYTES + 1);
    assert.equal(fromBuffer.text, null);

    // A size the backend does not give: the read decides, and says why.
    const count = E.getState().tabs.length;
    const missing = '/workspace/_ep_missing.md';
    await failureOf(E.getState().openMarkdownPreview(missing));
    assert.equal(E.getState().tabs.length, count, 'no tab');
    assert.deepEqual(E.getState().openFailure, { path: missing, fileName: '_ep_missing.md', reason: 'File not found' });

    const binary = await file('binary', 'md', 'x');
    answers.fs_read_file = (args) => Promise.reject(`File is not UTF-8 text: ${args.path}`);
    await failureOf(E.getState().openMarkdownPreview(binary));
    assert.equal(E.getState().tabs.length, count);
    assert.equal(E.getState().openFailure?.reason, 'File is not UTF-8 text');
  });
});

// ---- Text tabs as they were --------------------------------------------------------

describe('Preview tabs: text tabs are as they were', () => {
  beforeEach(setUp);
  afterEach(teardown);

  test('EP-12: a text tab — a Markdown file included — has no kind and the shape it always had, and is edited and saved as before', async () => {
    const path = await file('plain', 'md', '# Plain');
    const tab = await E.getState().openFile(path);
    assert.deepEqual(reads(), [{ command: 'fs_read_file', args: { path } }]);
    assert.deepEqual(Object.keys(tab).sort(), ['content', 'fileName', 'filePath', 'id', 'isDirty', 'language', 'savedContent']);
    assert.ok(!isPreviewTab(tab));
    E.getState().editBuffer(tab.id, '# Changed');
    assert.equal(tabById(tab.id).isDirty, true);
    calls.length = 0;
    E.getState().requestCloseTab(tab.id);
    assert.equal(E.getState().pendingClose?.kind, 'tab', 'a dirty text tab still asks');
    E.getState().cancelPendingClose();
    await E.getState().saveFile(tab.id);
    assert.deepEqual(writes().map((c) => c.args), [{ path, content: '# Changed' }]);
    assert.equal(tabById(tab.id).isDirty, false);
  });

  test('EP-13: a line asked for on an image parks no reveal, and reloading a preview tab from disk reads nothing', async () => {
    const tab = await E.getState().openFileAt(LOGO_PNG, 12, 3);
    assert.equal(tab.kind, 'image');
    assert.equal(E.getState().pendingReveal, null, 'no editor would ever take it');

    const mdPath = await file('reload', 'md', '# Reload');
    const md = await E.getState().openMarkdownPreview(mdPath);
    const before = E.getState().tabs;
    calls.length = 0;
    await E.getState().reloadFromDisk(tab.id);
    await E.getState().reloadFromDisk(md.id);
    assert.deepEqual(calls, []);
    assert.equal(E.getState().tabs, before);
  });
});

// ==== Step P4: out of the text-only machinery, and following the file ==============

const SVG_A = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
const SVG_B = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>';

/** P4's cases also stop the store listening to `fs-change`, so that no later case sees a read it did not ask for. */
function teardownP4() {
  E.getState().dispose();
  teardown();
}

/** Monaco as far as editorModels.js uses it, counting every model made (`made`, by path). */
function fakeMonaco() {
  const models = new Map(); // URI string -> model
  const made = [];
  const editors = [];
  const Uri = { file: (path) => ({ path, toString: () => `file://${path}` }) };
  const createModel = (value, language, uri) => {
    const key = uri.toString();
    made.push(uri.path);
    const model = {
      uri,
      value,
      language,
      disposed: false,
      getValue: () => model.value,
      getLanguageId: () => model.language,
      isDisposed: () => model.disposed,
      dispose() {
        model.disposed = true;
        models.delete(key);
      },
    };
    models.set(key, model);
    return model;
  };
  return {
    Uri,
    editor: { getModel: (uri) => models.get(uri.toString()) ?? null, getModels: () => [...models.values()], getEditors: () => editors, createModel },
    made,
    editors,
    /** What the library does when an editor is handed `path`: its model, or a new one. */
    show: (path, content = '') => models.get(Uri.file(path).toString()) ?? createModel(content, 'markdown', Uri.file(path)),
    paths: () => [...models.values()].map((m) => m.uri.path).sort(),
  };
}

/** A Monaco editor as far as editorModels.js uses it, counting the models it is handed. */
function fakeEditor(model = null) {
  const changed = [];
  const disposed = [];
  const editor = {
    model,
    sets: 0,
    getModel: () => editor.model,
    setModel(next) {
      editor.model = next;
      editor.sets += 1;
      changed.forEach((cb) => cb());
    },
    onDidChangeModel: (cb) => changed.push(cb),
    onDidDispose: (cb) => disposed.push(cb),
    dispose: () => disposed.forEach((cb) => cb()),
    restoreViewState() {},
    saveViewState: () => null,
  };
  return editor;
}

/**
 * setTimeout and clearTimeout on a clock that moves only when told
 * (`advance`). Each timer that comes due runs, and the promises it starts
 * settle (on real turns of the event loop) before the next one does.
 */
function fakeClock() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Map(); // id -> { at, seq, fn, args }
  let now = 0;
  let seq = 0;
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => realSet(resolve, 0));
  };
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    seq += 1;
    const id = { fakeTimer: seq };
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), seq, fn, args });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (!timers.delete(id)) realClear(id);
  };
  return {
    settle,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const entry of timers) {
          const t = entry[1];
          if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && t.seq < next[1].seq))) next = entry;
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn(...next[1].args);
        await settle();
      }
      now = end;
      await settle();
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

/** The open folder's saved session as the store reads it back, or null. */
function savedSession() {
  const raw = backing.get(EDITOR_SESSIONS_KEY);
  if (raw == null) return null;
  return normalizeSessions(JSON.parse(raw).data).find((s) => s.root === '/workspace') ?? null;
}
const savedFiles = () => [...(savedSession()?.recent ?? [])].sort();

/**
 * Close the app and start it again on /workspace: only storage survives.
 * `folder`, when given, is stored first as the folder's saved session.
 */
async function relaunch(folder = undefined) {
  E.getState().dispose();
  T.getState().clearEditorLeaves();
  E.setState({ tabs: [], activeTabId: null, pendingClose: null, openFailure: null, pendingReveal: null });
  if (folder !== undefined) {
    backing.set(EDITOR_SESSIONS_KEY, JSON.stringify({ version: SCHEMA_VERSION, data: { format: SESSION_FORMAT, folders: [folder] } }));
  }
  await E.getState().init();
}

// ---- Models, Send to Agent, focus ----------------------------------------------------

describe('Preview tabs: no Monaco model, not seen by Send to Agent, no reveal parked (AC-B4-5, AC-B3-7)', () => {
  beforeEach(setUp);
  afterEach(teardownP4);

  test('EP-14: no Monaco model is made or kept for an image or a Markdown preview; the text tab of the same file keeps its own', async () => {
    const monaco = fakeMonaco();
    const mdPath = await file('models', 'md', '# Models');
    await E.getState().openFile(LOGO_PNG);
    const preview = await E.getState().openMarkdownPreview(mdPath);
    const stop = watchEditorModels(monaco, E);
    try {
      const svg = await E.getState().openFile(LOGO_SVG);
      E.getState().closeTab(svg.id);
      const editor = fakeEditor();
      for (const tab of E.getState().tabs) showFile(editor, tab, 'plaintext');
      assert.deepEqual(monaco.made, [], 'no model for an image or a preview: opened, closed or shown');
      assert.equal(editor.sets, 0, 'and none handed to an editor');

      // The README's text tab has the model, made as the library makes it.
      const text = await E.getState().openFile(mdPath);
      const model = monaco.show(mdPath, '# Models');
      E.getState().closeTab(preview.id);
      assert.equal(model.disposed, false, 'closing the preview leaves the text tab\'s model alone');
      const again = await E.getState().openMarkdownPreview(mdPath);
      E.getState().closeTab(text.id);
      assert.equal(model.disposed, true, 'the preview still open does not keep the file\'s model alive');
      assert.deepEqual(monaco.paths(), []);

      // Shown in an editor when its text tab closes, the model goes once that editor moves on, the preview open or not.
      const text3 = await E.getState().openFile(mdPath);
      const model3 = monaco.show(mdPath, '# Models');
      const viewer = fakeEditor(model3);
      monaco.editors.push(viewer);
      trackEditor(viewer);
      E.getState().closeTab(text3.id);
      assert.equal(model3.disposed, false, 'kept while an editor shows it');
      viewer.setModel(null);
      await sleep(0); // the editor lets go in a microtask
      assert.equal(model3.disposed, true, 'gone once the editor moved on, though the preview is open');
      monaco.editors.splice(monaco.editors.indexOf(viewer), 1);
      viewer.dispose();

      // A text tab shown in an editor, replaced by a preview of its file in one update: no model for the preview.
      E.getState().closeTab(again.id);
      const text2 = await E.getState().openFile(mdPath);
      const shown = fakeEditor(monaco.show(mdPath, '# Models'));
      monaco.editors.push(shown);
      const made = monaco.made.length;
      E.setState((s) => ({
        tabs: [
          ...s.tabs.filter((t) => t.id !== text2.id),
          { id: 'tab-edit-p4-preview', kind: 'markdown', filePath: mdPath, fileName: 'models.md', isDirty: false, deleted: false, text: '# Models', bytes: 8, tooLarge: false },
        ],
      }));
      assert.equal(monaco.made.length, made, 'no model made for the preview that took its place');
      assert.equal(shown.sets, 0, 'and none handed to the editor that showed the file');
    } finally {
      stop();
    }
  });

  test('EP-15: Send to Agent does not see a preview: an active preview is no file open, and a README\'s preview never stands in for its modified text tab', async () => {
    const typed = [];
    const original = T.getState().typeAgentReference;
    T.setState({
      tabs: [{ id: 'tab-agent', sessionId: 'session-agent', agent: { kind: 'claude' }, agentTyped: { sessionId: 'session-agent' }, exited: false }],
      typeAgentReference: async (tabId, text) => {
        typed.push({ tabId, text });
        return { status: 'refused' };
      },
    });
    useToastStore.setState({ toasts: [] });
    const toasts = () => useToastStore.getState().toasts.map((t) => t.text);
    try {
      const path = await file('agent', 'md', '# Agent');
      const preview = await E.getState().openMarkdownPreview(path);
      assert.equal(E.getState().activeTabId, preview.id);
      assert.deepEqual(sendCommandState(), { file: NO_EDITOR_FILE_REASON, selection: NO_EDITOR_FILE_REASON }, 'a preview active is no file open');
      await sendFileToAgent();
      await sendSelectionToAgent();
      await sendFileToAgent(path);
      await E.getState().openFile(LOGO_PNG);
      assert.equal(sendCommandState().file, NO_EDITOR_FILE_REASON, 'nor is an image');
      await sendFileToAgent();
      await sendFileToAgent(LOGO_PNG);
      assert.deepEqual(typed, [], 'nothing typed from a preview');
      assert.deepEqual(toasts(), [notSentText(NO_EDITOR_FILE_REASON)]);

      // The README's text tab, opened after its preview and modified: not saved, so not sent.
      const text = await E.getState().openFile(path);
      E.getState().editBuffer(text.id, '# Edited');
      assert.deepEqual(E.getState().tabs.filter((t) => t.filePath === path).map((t) => t.id), [preview.id, text.id], 'the preview comes first');
      await sendFileToAgent(path);
      assert.deepEqual(typed, []);
      assert.equal(toasts().at(-1), notSentText(SAVE_FIRST_REASON));

      // Saved, it goes, from its own tab.
      await E.getState().saveFile(text.id);
      assert.equal(sendCommandState().file, null);
      await sendFileToAgent();
      assert.deepEqual(typed, [{ tabId: 'tab-agent', text: `@${path} ` }]);
    } finally {
      T.setState({ typeAgentReference: original, tabs: [] });
      useToastStore.setState({ toasts: [] });
    }
  });

  test('EP-26: focusEditor and focusEditorPane park no reveal for an image or a Markdown preview; a text tab still gets its request', async () => {
    const img = await E.getState().openFile(LOGO_PNG);
    E.getState().focusEditor();
    assert.equal(E.getState().pendingReveal, null);
    assert.equal(E.getState().focusEditorPane(holderOf(img.id).leaf.id), false, 'false: the pane\'s body takes the keyboard');
    assert.equal(E.getState().pendingReveal, null);

    const md = await E.getState().openMarkdownPreview(await file('focus', 'md', '# Focus'));
    E.getState().focusEditor();
    assert.equal(E.getState().pendingReveal, null);
    assert.equal(E.getState().focusEditorPane(holderOf(md.id).leaf.id, { find: true }), false);
    assert.equal(E.getState().pendingReveal, null);

    const text = await E.getState().openFile(await file('focus', 'txt', 'x'));
    E.getState().focusEditor();
    assert.deepEqual(E.getState().pendingReveal, { filePath: text.filePath, line: null, column: null });
    E.getState().clearReveal();
    assert.equal(E.getState().focusEditorPane(holderOf(text.id).leaf.id), true);
    assert.equal(E.getState().pendingReveal?.filePath, text.filePath);
  });
});

// ---- The session ----------------------------------------------------------------------

describe('Preview tabs: not saved, not restored, never in a text tab\'s place (the human\'s decision)', () => {
  beforeEach(async () => {
    await setUp();
    E.getState().dispose();
  });
  afterEach(teardownP4);

  test('EP-16: serializeSession writes text tabs only: a preview used last never takes its text tab\'s place, and an image is not saved', () => {
    const R = '/proj';
    const tabs = [
      { id: 'a', filePath: `${R}/README.md` },
      { id: 'p', kind: 'markdown', filePath: `${R}/README.md` },
      { id: 'i', kind: 'image', filePath: `${R}/logo.png` },
      { id: 'b', filePath: `${R}/b.js` },
    ];
    const editorTree = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        { type: 'leaf', id: 'pane-1', tabIds: ['a', 'b'], activeTabId: 'a' },
        { type: 'leaf', id: 'pane-2', tabIds: ['p', 'i'], activeTabId: 'p' },
      ],
    };
    const recency = { a: 1, b: 2, i: 3, p: 4 };
    const session = serializeSession({ rootPath: R, tabs, editorTree, editorPane: 'pane-2', activeTabId: 'p' }, (id) => recency[id] ?? 0);
    assert.deepEqual(session.tree, { type: 'leaf', files: [`${R}/README.md`, `${R}/b.js`], active: `${R}/README.md`, pane: 'pane-1' });
    assert.deepEqual(session.recent, [`${R}/b.js`, `${R}/README.md`]);
    assert.equal(session.activeFile, `${R}/README.md`);
    const previewsOnly = { type: 'leaf', id: 'pane-2', tabIds: ['p', 'i'], activeTabId: 'p' };
    assert.equal(serializeSession({ rootPath: R, tabs: tabs.filter(isPreviewTab), editorTree: previewsOnly, editorPane: 'pane-2', activeTabId: 'p' }), null, 'previews alone: nothing to save');
  });

  test('EP-17: the store saves a folder\'s text tabs and none of its previews; after a restart only the text tab is back, and no image is read', async () => {
    await relaunch();
    await whenTabsRestored();
    const kept = await file('kept', 'txt', 'kept');
    const notes = await file('notes', 'md', '# Notes');
    await E.getState().openFile(kept);
    await E.getState().openMarkdownPreview(notes);
    await E.getState().openFile(LOGO_PNG);
    await E.getState().openFile(LOGO_SVG);
    assert.equal(E.getState().tabs.length, 4);
    E.getState().dispose(); // writes out what is pending, as the page going away does
    assert.deepEqual(savedFiles(), [kept], 'only the text tab is saved');

    calls.length = 0;
    await relaunch();
    await whenTabsRestored();
    assert.deepEqual(E.getState().tabs.map((t) => [t.filePath, t.kind]), [[kept, undefined]]);
    assert.ok(!commands().includes('fs_read_image'), 'no image read');
    assert.ok(!reads().some((c) => c.args.path === notes), 'the preview\'s file is not read');
  });

  test('EP-18: a session saved before previews existed restores as it did; a crafted entry with a kind is read as a plain text tab or ignored, never as a preview', async () => {
    const md = await file('old', 'md', '# Old');
    const svg = await file('drawn', 'svg', SVG_A);
    const js = await file('code', 'js', 'let x = 1;');
    await relaunch({
      root: '/workspace',
      kind: 'markdown',
      tree: {
        type: 'split',
        direction: 'horizontal',
        children: [
          { type: 'leaf', files: [md, js], active: md },
          { type: 'leaf', kind: 'image', files: [svg, { path: js, kind: 'markdown' }, { kind: 'image', filePath: LOGO_PNG }], active: svg },
        ],
      },
      tabs: [{ id: 'tab-crafted', kind: 'image', filePath: LOGO_PNG, image: { mime: 'image/png', data: '' } }],
      activePane: 1,
      activeFile: svg,
      recent: [svg, md, js, LOGO_PNG],
    });
    await whenTabsRestored();
    const tabs = E.getState().tabs;
    assert.deepEqual(tabs.map((t) => t.filePath).sort(), [md, svg, js].sort(), 'the three files, each once; the crafted entries are dropped');
    assert.ok(tabs.every((t) => !isPreviewTab(t) && !('kind' in t)), 'every one a plain text tab');
    assert.equal(tabs.find((t) => t.filePath === svg).content, SVG_A, 'an SVG of an old session is the text tab it was');
    assert.ok(!commands().includes('fs_read_image'), 'never read as an image');
    assert.deepEqual(reads().map((c) => `${c.command} ${c.args.path}`).sort(), [md, svg, js].map((p) => `fs_read_file ${p}`).sort());
    assert.ok(tabs.every((t) => holderOf(t.id)), 'all on screen');
  });

  test('EP-19: while the restore reads the README, its preview opened, kept or closed never takes the place of the README\'s text tab', async () => {
    const readme = await file('readme', 'md', '# Readme');
    const folder = { root: '/workspace', tree: { type: 'leaf', files: [readme], active: readme }, activePane: 0, activeFile: readme, recent: [readme] };
    /** Hold the restore's read of the README — the first one — until the case lets it go. */
    const park = () => {
      let release;
      let parked = false;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      answers.fs_read_file = (args, real) => {
        if (args.path !== readme || parked) return real();
        parked = true;
        return gate.then(real);
      };
      return { release: () => release(), parked: () => parked };
    };

    // Opened and kept open: the session still carries the README, and the restore brings its text tab beside the preview.
    let gate = park();
    await relaunch(folder);
    assert.ok(gate.parked(), 'the restore is reading');
    const preview = await E.getState().openMarkdownPreview(readme);
    await sleep(450); // the session is written 300 ms behind
    assert.deepEqual(savedFiles(), [readme], 'the session still carries the README while it is read');
    gate.release();
    await whenTabsRestored();
    const text = E.getState().tabs.find((t) => !isPreviewTab(t) && t.filePath === readme);
    assert.ok(text, 'the README came back as its text tab');
    assert.equal(text.content, '# Readme');
    assert.ok(holderOf(text.id), 'on screen');
    assert.equal(tabById(preview.id)?.kind, 'markdown', 'beside its preview');

    // Opened and closed while the README is read: the README still comes back.
    gate = park();
    await relaunch(folder);
    assert.ok(gate.parked());
    const brief = await E.getState().openMarkdownPreview(readme);
    E.getState().closeTab(brief.id);
    gate.release();
    await whenTabsRestored();
    assert.deepEqual(E.getState().tabs.map((t) => [t.filePath, t.kind]), [[readme, undefined]]);
  });
});

// ---- Rename, move, delete -------------------------------------------------------------

describe('Preview tabs follow their file: rename, move, delete (AC-B3-7)', () => {
  beforeEach(setUp);
  afterEach(teardownP4);

  test('EP-20: a renamed Markdown file takes its text tab and its preview along; a moved image keeps its tab; a renamed folder takes the previews in it', async () => {
    const path = await file('rename', 'md', '# Rename');
    const text = await E.getState().openFile(path);
    const preview = await E.getState().openMarkdownPreview(path);
    counter += 1;
    const name = `Renamed_${counter}.md`;
    const renamed = `/workspace/${name}`;
    calls.length = 0;
    await E.getState().renamePath(path, name);
    assert.deepEqual(
      [tabById(text.id), tabById(preview.id)].map((t) => [t.filePath, t.fileName, t.kind]),
      [[renamed, name, undefined], [renamed, name, 'markdown']]
    );
    assert.equal(tabById(preview.id).text, '# Rename', 'what it shows stays');
    assert.equal(tabById(preview.id).deleted, false);
    assert.equal(E.getState().tabs.length, 2);
    assert.deepEqual(reads(), [], 'nothing is read again');
    assert.equal((await E.getState().openMarkdownPreview(renamed)).id, preview.id, 'each reveals its own tab under the new name');
    assert.equal((await E.getState().openFile(renamed)).id, text.id);

    // A moved image (cut, paste into a folder): the same tab, at its new path.
    const svg = await file('moved', 'svg', SVG_A);
    const img = await E.getState().openFile(svg);
    const dest = `/workspace/_ep_dest_${counter}`;
    mockBridge.directories.add(dest);
    E.getState().cutToClipboard(svg, false);
    await E.getState().pasteClipboard(dest);
    const moved = `${dest}/${svg.split('/').pop()}`;
    assert.deepEqual([tabById(img.id).filePath, tabById(img.id).kind, tabById(img.id).deleted], [moved, 'image', false]);
    assert.equal(tabById(img.id).image, img.image, 'the picture it showed');
    calls.length = 0;
    assert.equal((await E.getState().openFile(moved)).id, img.id, 'opening it at its new path reveals it');
    assert.deepEqual(reads(), []);

    // A folder renamed: the preview and the image in it go with it.
    const dir = `/workspace/_ep_dir_${counter}`;
    mockBridge.directories.add(dir);
    await invoke('fs_write_file', { path: `${dir}/inner.md`, content: '# Inner' });
    await invoke('fs_write_file', { path: `${dir}/inner.svg`, content: SVG_B });
    const inner = await E.getState().openMarkdownPreview(`${dir}/inner.md`);
    const innerImg = await E.getState().openFile(`${dir}/inner.svg`);
    await E.getState().renamePath(dir, `_ep_dir_${counter}_renamed`);
    assert.equal(tabById(inner.id).filePath, `${dir}_renamed/inner.md`);
    assert.equal(tabById(innerImg.id).filePath, `${dir}_renamed/inner.svg`);
  });

  test('EP-21: deleting a file or its folder in the Explorer closes its text tab as before, and keeps its previews, marked deleted on disk, showing what they showed', async () => {
    counter += 1;
    const dir = `/workspace/_ep_gone_${Date.now()}_${counter}`;
    mockBridge.directories.add(dir);
    const md = `${dir}/notes.md`;
    const svg = `${dir}/pic.svg`;
    await invoke('fs_write_file', { path: md, content: '# Notes' });
    await invoke('fs_write_file', { path: svg, content: SVG_A });
    const elsewhere = await file('kept', 'md', '# Kept');
    const text = await E.getState().openFile(md);
    const preview = await E.getState().openMarkdownPreview(md);
    const img = await E.getState().openFile(svg);
    const other = await E.getState().openMarkdownPreview(elsewhere);
    assert.equal(preview.deleted, false);
    assert.equal(img.deleted, false);
    assert.deepEqual(E.getState().tabsUnder(dir).map((t) => t.id), [text.id], 'what deleting it closes: its text tab');
    const picture = img.image;

    calls.length = 0;
    await E.getState().deletePath(dir, true);
    assert.equal(tabById(text.id), undefined, 'the text tab is closed, as it always was');
    assert.deepEqual(
      [tabById(preview.id).kind, tabById(preview.id).deleted, tabById(preview.id).text],
      ['markdown', true, '# Notes'],
      'the preview stays, deleted on disk, with its last text'
    );
    assert.equal(tabById(img.id).deleted, true);
    assert.equal(tabById(img.id).image, picture, 'the image keeps its last picture');
    assert.equal(tabById(other.id).deleted, false, 'a preview of another file is left alone');
    assert.ok(holderOf(preview.id) && holderOf(img.id), 'both still on screen');
    assert.deepEqual(reads(), [], 'nothing is read for it');

    // A file deleted on its own, its text tab not open.
    const single = await file('single', 'md', '# Single');
    const lone = await E.getState().openMarkdownPreview(single);
    await E.getState().deletePath(single);
    assert.deepEqual([tabById(lone.id).deleted, tabById(lone.id).text], [true, '# Single']);
  });
});

// ---- fs-change: the disk half of AC-B3-8 ----------------------------------------------

/**
 * Run `fn(clock)` with the store listening to `fs-change` and the fake clock
 * in place, put back however `fn` ends: a case that fails skips afterEach,
 * and a clock left in place would hold every case after it.
 */
async function withClock(fn) {
  await E.getState().attachListeners();
  const clock = fakeClock();
  try {
    await fn(clock);
  } finally {
    clock.restore();
  }
}

describe('Preview tabs follow the disk through fs-change (AC-B3-8, disk half; fake timers)', () => {
  beforeEach(setUp);
  afterEach(teardownP4);

  test('EP-22: with no source tab, a modify of the file is exactly one read 300 ms after the last change; a change elsewhere is none', () =>
    withClock(async (clock) => {
      assert.equal(PREVIEW_FOLLOW_MS, 300);
      const path = await file('follow', 'md', '# One');
      const other = await file('other', 'md', '# Other');
      const preview = await E.getState().openMarkdownPreview(path);
      const textReads = () => reads().filter((c) => c.command === 'fs_read_file');
      calls.length = 0;
      await invoke('fs_write_file', { path, content: '# Two' });
      await clock.advance(PREVIEW_FOLLOW_MS - 1);
      assert.deepEqual(reads(), [], 'nothing before 300 ms');
      assert.equal(tabById(preview.id).text, '# One');
      await clock.advance(1);
      assert.deepEqual(reads(), [{ command: 'fs_file_size', args: { path } }, { command: 'fs_read_file', args: { path } }], 'one read, its size first');
      const after = tabById(preview.id);
      assert.deepEqual([after.text, after.bytes, after.tooLarge, after.deleted], ['# Two', 5, false, false]);
      await clock.advance(PREVIEW_FOLLOW_MS * 5);
      assert.equal(textReads().length, 1, 'and only one');

      // A burst of changes 100 ms apart: one read, 300 ms after the last.
      calls.length = 0;
      for (const n of [3, 4, 5]) {
        await invoke('fs_write_file', { path, content: `# ${n}` });
        await clock.advance(100);
      }
      assert.deepEqual(reads(), [], 'still changing');
      await clock.advance(PREVIEW_FOLLOW_MS - 100);
      assert.deepEqual(textReads().map((c) => c.args.path), [path]);
      assert.equal(tabById(preview.id).text, '# 5');

      // Another file, a name that only begins the same, an access, no path: none. (A change of the
      // folder it is in is one read: EP-27.)
      calls.length = 0;
      await invoke('fs_write_file', { path: other, content: '# Changed' });
      await mockBridge.emit('fs-change', { path: `${path}.bak`, kind: 'modify' });
      await mockBridge.emit('fs-change', { path: '/workspace/_ep_follo', kind: 'modify' });
      await mockBridge.emit('fs-change', { path, kind: 'other' });
      await mockBridge.emit('fs-change', { path: null, kind: 'modify' });
      await mockBridge.emit('fs-change', null);
      assert.equal(__previewReadsPending(), 0, 'no read waits');
      await clock.advance(PREVIEW_FOLLOW_MS * 3);
      assert.deepEqual(reads(), []);
      assert.equal(tabById(preview.id).text, '# 5');

      // Past 2 MB on disk: its size is asked, it is not read.
      calls.length = 0;
      await invoke('fs_write_file', { path, content: 'x'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1) });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(reads().map((c) => c.command), ['fs_file_size']);
      const big = tabById(preview.id);
      assert.deepEqual([big.text, big.bytes, big.tooLarge], [null, MARKDOWN_PREVIEW_MAX_BYTES + 1, true]);
      await invoke('fs_write_file', { path, content: '# Small again' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual([tabById(preview.id).text, tabById(preview.id).tooLarge], ['# Small again', false]);
    }));

  test('EP-23: with the text tab of the file open, the preview reads nothing from disk: it follows that buffer (step P8)', () =>
    withClock(async (clock) => {
      const path = await file('sourced', 'md', '# Disk one');
      const preview = await E.getState().openMarkdownPreview(path);
      const source = await E.getState().openFile(path);
      calls.length = 0;
      await invoke('fs_write_file', { path, content: '# Disk two' });
      await clock.advance(PREVIEW_FOLLOW_MS * 3);
      assert.deepEqual(reads(), []);
      assert.equal(tabById(preview.id).text, '# Disk one');

      // The text tab opened again while a read waited: none either.
      E.getState().closeTab(source.id);
      await invoke('fs_write_file', { path, content: '# Disk three' });
      await clock.advance(100);
      const again = await E.getState().openFile(path);
      calls.length = 0;
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(reads(), []);
      assert.equal(tabById(preview.id).text, '# Disk one');

      // Closed: the disk again.
      E.getState().closeTab(again.id);
      await invoke('fs_write_file', { path, content: '# Disk four' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.equal(tabById(preview.id).text, '# Disk four');
    }));

  test('EP-24: an image tab reads its file again with fs_read_image, once, 300 ms after the last change; deleted on disk it keeps its picture until the file is back', () =>
    withClock(async (clock) => {
      const path = await file('pic', 'svg', SVG_A);
      const elsewhere = await file('pic_other', 'svg', SVG_A);
      const img = await E.getState().openFile(path);
      assert.equal(img.image.bytes, SVG_A.length);
      calls.length = 0;
      await invoke('fs_write_file', { path, content: SVG_B });
      await invoke('fs_write_file', { path: elsewhere, content: SVG_B });
      await clock.advance(PREVIEW_FOLLOW_MS - 1);
      assert.deepEqual(reads(), []);
      await clock.advance(1);
      assert.deepEqual(reads(), [{ command: 'fs_read_image', args: { path } }], 'its own path, as an image, never as text');
      assert.deepEqual([tabById(img.id).image.bytes, tabById(img.id).failure, tabById(img.id).deleted], [SVG_B.length, null, false]);

      // No image any more: the tab says why; an image again: shown.
      await invoke('fs_write_file', { path, content: 'plain text now' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual([tabById(img.id).image, tabById(img.id).failure], [null, NOT_AN_IMAGE_FORMAT]);
      await invoke('fs_write_file', { path, content: SVG_A });
      await clock.advance(PREVIEW_FOLLOW_MS);
      const picture = tabById(img.id).image;
      assert.deepEqual([picture?.bytes, tabById(img.id).failure], [SVG_A.length, null]);

      // Deleted by another program: the watcher's word is checked by a read, and the tab stays, picture and all.
      calls.length = 0;
      mockBridge.files.delete(path);
      await mockBridge.emit('fs-change', { path, kind: 'delete' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(reads(), [{ command: 'fs_read_image', args: { path } }]);
      assert.equal(tabById(img.id).deleted, true);
      assert.equal(tabById(img.id).image, picture, 'its last picture');
      // Back on disk: shown again.
      await invoke('fs_write_file', { path, content: SVG_B });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual([tabById(img.id).deleted, tabById(img.id).image.bytes], [false, SVG_B.length]);

      // Deleted and written anew within the wait (an atomic save): one read, never marked.
      calls.length = 0;
      mockBridge.files.delete(path);
      await mockBridge.emit('fs-change', { path, kind: 'delete' });
      await clock.advance(50);
      await invoke('fs_write_file', { path, content: SVG_A });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.equal(reads().length, 1);
      assert.equal(tabById(img.id).deleted, false);

      // A Markdown preview deleted by another program: marked, its last text kept. A text tab: as it always was, untouched.
      const md = await file('gone', 'md', '# Last words');
      const preview = await E.getState().openMarkdownPreview(md);
      const textPath = await file('textgone', 'txt', 'text');
      const text = await E.getState().openFile(textPath);
      const textBefore = tabById(text.id);
      mockBridge.files.delete(md);
      mockBridge.files.delete(textPath);
      await mockBridge.emit('fs-change', { path: md, kind: 'delete' });
      await mockBridge.emit('fs-change', { path: textPath, kind: 'delete' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual([tabById(preview.id).deleted, tabById(preview.id).text], [true, '# Last words']);
      assert.equal(tabById(text.id), textBefore, 'the text tab is not touched');
      await invoke('fs_write_file', { path: md, content: '# Back' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual([tabById(preview.id).deleted, tabById(preview.id).text], [false, '# Back'], 'back on disk, shown again');

      // A folder deleted by another program: the watcher names the folder, and the previews in it are looked at.
      counter += 1;
      const dir = `/workspace/_ep_watched_${counter}`;
      mockBridge.directories.add(dir);
      await invoke('fs_write_file', { path: `${dir}/a.md`, content: '# A' });
      await invoke('fs_write_file', { path: `${dir}/b.svg`, content: SVG_A });
      const inA = await E.getState().openMarkdownPreview(`${dir}/a.md`);
      const inB = await E.getState().openFile(`${dir}/b.svg`);
      calls.length = 0;
      mockBridge.files.delete(`${dir}/a.md`);
      mockBridge.files.delete(`${dir}/b.svg`);
      mockBridge.directories.delete(dir);
      await mockBridge.emit('fs-change', { path: dir, kind: 'delete' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(
        reads().map((c) => `${c.command} ${c.args.path}`).sort(),
        [`fs_file_size ${dir}/a.md`, `fs_file_size ${dir}/a.md`, `fs_read_file ${dir}/a.md`, `fs_file_size ${dir}/b.svg`, `fs_read_image ${dir}/b.svg`].sort(),
        'each one\u{2019}s size asked and, gone, read once (a Markdown file: size, then text)'
      );
      assert.deepEqual([tabById(inA.id).deleted, tabById(inA.id).text, tabById(inB.id).deleted], [true, '# A', true]);
    }));

  test('EP-25: a read waiting is cancelled when its tab closes; an answer that comes after the tab closed, was renamed, or was deleted in the Explorer is dropped', () =>
    withClock(async (clock) => {
      // Closed before the read: none is made.
      const path = await file('closing', 'md', '# Closing');
      const preview = await E.getState().openMarkdownPreview(path);
      calls.length = 0;
      await invoke('fs_write_file', { path, content: '# Changed' });
      assert.equal(__previewReadsPending(), 1);
      E.getState().closeTab(preview.id);
      assert.equal(__previewReadsPending(), 0, 'the read waiting is cancelled');
      await clock.advance(PREVIEW_FOLLOW_MS * 2);
      assert.deepEqual(reads(), []);

      /** Hold every `command` until the case lets it go; `early`: the answer is read at once, delivered later. */
      const hold = (command, { early = false } = {}) => {
        const held = [];
        answers[command] = (args, real) => {
          const answer = early ? real() : null;
          return new Promise((resolve, reject) => held.push(() => (answer ?? real()).then(resolve, reject)));
        };
        return held;
      };

      // Closed while its read is under way: the answer is dropped, nothing comes back.
      const second = await E.getState().openMarkdownPreview(path);
      let held = hold('fs_read_file');
      await invoke('fs_write_file', { path, content: '# While closing' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.equal(held.length, 1, 'the read is under way');
      E.getState().closeTab(second.id);
      const tabsNow = E.getState().tabs;
      held[0]();
      await clock.settle();
      assert.equal(E.getState().tabs, tabsNow, 'nothing changed');
      delete answers.fs_read_file;

      // Renamed while its read is under way: the old path's answer ('File not found') is not the renamed tab's.
      const svg = await file('renaming', 'svg', SVG_A);
      const img = await E.getState().openFile(svg);
      held = hold('fs_read_image');
      await invoke('fs_write_file', { path: svg, content: SVG_B });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.equal(held.length, 1);
      counter += 1;
      await E.getState().renamePath(svg, `_ep_renamed_${counter}.svg`);
      held[0]();
      await clock.settle();
      assert.equal(tabById(img.id).filePath, `/workspace/_ep_renamed_${counter}.svg`);
      assert.equal(tabById(img.id).deleted, false, 'not marked deleted by an answer for the old name');
      assert.equal(tabById(img.id).image.bytes, SVG_A.length, 'nor given it');
      delete answers.fs_read_image;

      // Deleted in the Explorer while a read of the file as it was is under way: it stays deleted.
      const md = await file('deleting', 'md', '# Before');
      const third = await E.getState().openMarkdownPreview(md);
      held = hold('fs_read_file', { early: true });
      await invoke('fs_write_file', { path: md, content: '# Just before' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.equal(held.length, 1);
      await E.getState().deletePath(md);
      assert.equal(tabById(third.id).deleted, true);
      held[0]();
      await clock.settle();
      assert.deepEqual([tabById(third.id).deleted, tabById(third.id).text], [true, '# Before'], 'the late answer is dropped');
      delete answers.fs_read_file;
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.equal(tabById(third.id).deleted, true, 'and the read the delete set off agrees');
    }));

  // Reviewer B R1: the watcher sends a rename as a 'modify' of both names (src-tauri/src/fs/watcher.rs), never 'rename'.
  test('EP-27: a folder above a preview\u{2019}s file renamed outside the Explorer — a modify of the folder — has that preview look at its file once; gone, it is deleted on disk; there still, shown as it is', () =>
    withClock(async (clock) => {
      counter += 1;
      const docs = `/workspace/_ep_docs_${counter}`;
      mockBridge.directories.add(docs);
      await invoke('fs_write_file', { path: `${docs}/README.md`, content: '# Docs' });
      await invoke('fs_write_file', { path: `${docs}/logo.svg`, content: SVG_A });
      await invoke('fs_write_file', { path: `${docs}-other.md`, content: '# Beside' });
      const md = await E.getState().openMarkdownPreview(`${docs}/README.md`);
      const pic = await E.getState().openFile(`${docs}/logo.svg`);
      const beside = await E.getState().openMarkdownPreview(`${docs}-other.md`);
      await clock.advance(PREVIEW_FOLLOW_MS * 2);

      // Something writes into the folder: the watcher names only the folder. Each size asked once, 300 ms on;
      // the same as shown, so nothing is read (reviewer B2 F1).
      calls.length = 0;
      await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
      await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
      await clock.advance(PREVIEW_FOLLOW_MS - 1);
      assert.deepEqual(reads(), [], 'nothing before 300 ms');
      await clock.advance(1);
      const readOf = () => reads().map((c) => `${c.command} ${c.args.path}`).sort();
      assert.deepEqual(readOf(), [`fs_file_size ${docs}/README.md`, `fs_file_size ${docs}/logo.svg`].sort(), 'each preview under the folder has its size asked, and reads nothing; one beside it, not');
      assert.deepEqual([tabById(md.id).deleted, tabById(md.id).text, tabById(pic.id).deleted], [false, '# Docs', false]);
      await clock.advance(PREVIEW_FOLLOW_MS * 3);
      assert.equal(reads().length, 2, 'and only once');

      // `mv docs docs-old` in a terminal: a modify of each name, and nothing for the files in it.
      calls.length = 0;
      for (const key of [...mockBridge.files.keys()]) {
        if (!key.startsWith(`${docs}/`)) continue;
        mockBridge.files.set(`${docs}-old${key.slice(docs.length)}`, mockBridge.files.get(key));
        mockBridge.files.delete(key);
      }
      mockBridge.directories.delete(docs);
      mockBridge.directories.add(`${docs}-old`);
      await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
      await mockBridge.emit('fs-change', { path: `${docs}-old`, kind: 'modify' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(
        readOf(),
        [`fs_file_size ${docs}/README.md`, `fs_file_size ${docs}/README.md`, `fs_read_file ${docs}/README.md`, `fs_file_size ${docs}/logo.svg`, `fs_read_image ${docs}/logo.svg`].sort(),
        'each size asked, and gone, one read each, of the old names'
      );
      assert.deepEqual([tabById(md.id).deleted, tabById(md.id).text], [true, '# Docs'], 'the README preview: deleted on disk, its last text kept');
      assert.equal(tabById(pic.id).deleted, true, 'the picture too');
      assert.equal(tabById(beside.id).deleted, false, 'the file beside the folder is untouched');

      // Moved back: the folder's modify reads them again, and they are back.
      for (const key of [...mockBridge.files.keys()]) {
        if (!key.startsWith(`${docs}-old/`)) continue;
        mockBridge.files.set(`${docs}${key.slice(docs.length + 4)}`, mockBridge.files.get(key));
        mockBridge.files.delete(key);
      }
      await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual([tabById(md.id).deleted, tabById(md.id).text, tabById(pic.id).deleted], [false, '# Docs', false]);

      // 'rename' is no kind the watcher sends: nothing follows it.
      calls.length = 0;
      await mockBridge.emit('fs-change', { path: docs, kind: 'rename' });
      assert.equal(__previewReadsPending(), 0);
      assert.equal(__previewChecksPending(), 0);
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(reads(), []);
    }));

  // Reviewer B2 F1: a folder that never goes quiet neither holds a preview back nor has it read again and again.
  test('EP-31: a folder above the file changed every 100 ms never puts off the read of the file\u{2019}s own change, 300 ms after it, and reads nothing itself; a file changed every 100 ms is shown within PREVIEW_FOLLOW_MAX_MS', () =>
    withClock(async (clock) => {
      assert.equal(PREVIEW_FOLLOW_MAX_MS, 1000);
      counter += 1;
      const docs = `/workspace/_ep_busy_${counter}`;
      mockBridge.directories.add(docs);
      const path = `${docs}/README.md`;
      await invoke('fs_write_file', { path, content: '# One' });
      const preview = await E.getState().openMarkdownPreview(path);
      await clock.advance(PREVIEW_FOLLOW_MS * 2);
      const count = (command) => calls.filter((c) => c.command === command).length;

      // A log beside the file, written every 100 ms: the watcher names the folder each time. The file changes at 500 ms.
      calls.length = 0;
      for (let t = 0; t < 2000; t += 100) {
        if (t === 500) await invoke('fs_write_file', { path, content: '# Two' });
        await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
        await clock.advance(100);
        if (t === 600) assert.equal(tabById(preview.id).text, '# One', 'not before 300 ms');
        if (t === 700) assert.equal(tabById(preview.id).text, '# Two', 'shown 300 ms after its own change, the folder busy all along');
      }
      await clock.advance(PREVIEW_FOLLOW_MS * 2);
      assert.equal(count('fs_read_file'), 1, 'the folder\u{2019}s changes read nothing');
      assert.equal(count('fs_file_size'), 3, 'the size: asked once a PREVIEW_FOLLOW_MAX_MS while the folder is busy, and once by the read');

      // The file itself written every 100 ms for 1.5 s: shown 1 s after the first change, and 300 ms after the last.
      calls.length = 0;
      for (let n = 0; n < 15; n += 1) {
        await invoke('fs_write_file', { path, content: `# Line ${n}` });
        await clock.advance(100);
        if (n === 8) assert.equal(count('fs_read_file'), 0, 'nothing before PREVIEW_FOLLOW_MAX_MS');
        if (n === 9) assert.deepEqual([count('fs_read_file'), tabById(preview.id).text], [1, '# Line 9'], 'read PREVIEW_FOLLOW_MAX_MS after the first change, the changes still coming');
      }
      await clock.advance(PREVIEW_FOLLOW_MS - 101);
      assert.equal(count('fs_read_file'), 1);
      await clock.advance(1);
      assert.deepEqual([count('fs_read_file'), tabById(preview.id).text], [2, '# Line 14'], 'and 300 ms after the last');
      await clock.advance(PREVIEW_FOLLOW_MAX_MS * 2);
      assert.equal(count('fs_read_file'), 2);
    }));

  test('EP-32: a folder above an image changed: its size is asked; the same, nothing is read; another, it is read again; gone, it is deleted on disk with its picture kept, and asked again, still gone, nothing is read', () =>
    withClock(async (clock) => {
      counter += 1;
      const assets = `/workspace/_ep_assets_${counter}`;
      mockBridge.directories.add(assets);
      const svg = `${assets}/logo.svg`;
      await invoke('fs_write_file', { path: svg, content: SVG_A });
      const pic = await E.getState().openFile(svg);
      await clock.advance(PREVIEW_FOLLOW_MS * 2);
      const readOf = () => reads().map((c) => `${c.command} ${c.args.path}`);

      // Written into beside it: its size, the same as shown; nothing read.
      calls.length = 0;
      await mockBridge.emit('fs-change', { path: assets, kind: 'modify' });
      assert.deepEqual([__previewChecksPending(), __previewReadsPending()], [1, 0], 'a look at the file waits, no read of it');
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(readOf(), [`fs_file_size ${svg}`], 'its size asked, nothing read');
      assert.deepEqual([tabById(pic.id).image.bytes, tabById(pic.id).deleted], [SVG_A.length, false]);

      // Swapped for a file of another size, the watcher naming only the folder: read again.
      calls.length = 0;
      mockBridge.files.set(svg, SVG_B);
      await mockBridge.emit('fs-change', { path: assets, kind: 'modify' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(readOf(), [`fs_file_size ${svg}`, `fs_read_image ${svg}`]);
      assert.deepEqual([tabById(pic.id).image.bytes, tabById(pic.id).deleted], [SVG_B.length, false]);

      // Gone with its folder: deleted on disk, its last picture kept.
      const picture = tabById(pic.id).image;
      calls.length = 0;
      mockBridge.files.delete(svg);
      mockBridge.directories.delete(assets);
      await mockBridge.emit('fs-change', { path: assets, kind: 'delete' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(readOf(), [`fs_file_size ${svg}`, `fs_read_image ${svg}`]);
      assert.deepEqual([tabById(pic.id).deleted, tabById(pic.id).image], [true, picture]);

      // Asked again, still gone: nothing read, still deleted on disk.
      calls.length = 0;
      await mockBridge.emit('fs-change', { path: assets, kind: 'modify' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(readOf(), [`fs_file_size ${svg}`]);
      assert.equal(tabById(pic.id).deleted, true);
    }));

  // Reviewer C3 R3: the paths of checkPreview that EP-24/27/31/32 do not reach.
  /** A folder of its own in the mock, `/workspace/_ep_<name>_<n>`. */
  const folder = (name) => {
    counter += 1;
    const dir = `/workspace/_ep_${name}_${counter}`;
    mockBridge.directories.add(dir);
    return dir;
  };
  const count = (command) => calls.filter((c) => c.command === command).length;

  test('EP-34: a folder\u{2019}s look that comes while a read of the file\u{2019}s own change waits does nothing: the file changed at 900 ms under folder events from 0 ms is read once, 300 ms after its change (C3 R3 a)', () =>
    withClock(async (clock) => {
      const docs = folder('own');
      const path = `${docs}/README.md`;
      await invoke('fs_write_file', { path, content: '# One' });
      const preview = await E.getState().openMarkdownPreview(path);
      await clock.advance(PREVIEW_FOLLOW_MS * 2);

      // The folder written into every 100 ms; its look is due at 1000 ms, PREVIEW_FOLLOW_MAX_MS after the first.
      // The file itself changes at 900 ms, to another size: its own read is due at 1200 ms.
      calls.length = 0;
      for (let t = 0; t < 1500; t += 100) {
        if (t === 900) await invoke('fs_write_file', { path, content: '# Two, a longer text' });
        await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
        await clock.advance(100);
        if (t === 900) assert.deepEqual([count('fs_file_size'), count('fs_read_file'), tabById(preview.id).text], [1, 0, '# One'], 'at 1000 ms the look asked the size, and read nothing: the own read is coming');
        if (t === 1100) assert.equal(tabById(preview.id).text, '# Two, a longer text', 'shown 300 ms after its own change');
      }
      await clock.advance(PREVIEW_FOLLOW_MAX_MS * 2);
      assert.equal(count('fs_read_file'), 1, 'the file was read once: by its own change, not by the folder\u{2019}s look too');
      assert.equal(tabById(preview.id).text, '# Two, a longer text');
    }));

  test('EP-35: an image tab refused for what it is knows no size: each burst of a folder\u{2019}s changes reads it once in full, at most once a PREVIEW_FOLLOW_MAX_MS, and it stays refused, not deleted (C3 R3 b)', () =>
    withClock(async (clock) => {
      const assets = folder('refused');
      const png = `${assets}/fake.png`;
      await invoke('fs_write_file', { path: png, content: 'not really an image' });
      const pic = await E.getState().openFile(png);
      assert.deepEqual([pic.kind, pic.image, pic.failure, pic.deleted], ['image', null, NOT_AN_IMAGE_FORMAT, false], 'setup: refused for what it is');
      await clock.advance(PREVIEW_FOLLOW_MS * 2);
      const readOf = () => reads().map((c) => `${c.command} ${c.args.path}`);

      // Two bursts of three events, 100 ms apart: one size and one full read each, 300 ms after its last event.
      for (const burst of [1, 2]) {
        calls.length = 0;
        for (let t = 0; t < 300; t += 100) {
          await mockBridge.emit('fs-change', { path: assets, kind: 'modify' });
          await clock.advance(100);
        }
        assert.deepEqual(readOf(), [], `burst ${burst}: nothing before 300 ms after its last event`);
        await clock.advance(PREVIEW_FOLLOW_MS - 100);
        assert.deepEqual(readOf(), [`fs_file_size ${png}`, `fs_read_image ${png}`], `burst ${burst}: its size, and with no size known, one full read`);
        await clock.advance(PREVIEW_FOLLOW_MS * 3);
        assert.equal(readOf().length, 2, `burst ${burst}: and only one`);
        const now = tabById(pic.id);
        assert.deepEqual([now.image, now.failure, now.deleted], [null, NOT_AN_IMAGE_FORMAT, false], `burst ${burst}: still refused, not deleted`);
      }

      // A folder busy for 2 s: read once a PREVIEW_FOLLOW_MAX_MS, not once an event.
      calls.length = 0;
      for (let t = 0; t < 2000; t += 100) {
        await mockBridge.emit('fs-change', { path: assets, kind: 'modify' });
        await clock.advance(100);
      }
      assert.equal(count('fs_read_image'), 2, 'twice in 2 s');
    }));

  test('EP-36: a Markdown preview whose text tab is open, its folder changed and the file with it: no read while the text tab is open; once it closes, one read shows the disk (C3 R3 c)', () =>
    withClock(async (clock) => {
      const docs = folder('sourced');
      const path = `${docs}/README.md`;
      await invoke('fs_write_file', { path, content: '# Disk one' });
      const preview = await E.getState().openMarkdownPreview(path);
      const source = await E.getState().openFile(path);
      await clock.advance(PREVIEW_FOLLOW_MS * 2);

      // Written to another size with only the folder named (a rename into place, say).
      calls.length = 0;
      mockBridge.files.set(path, '# Disk two, a longer text');
      await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(reads().map((c) => c.command), ['fs_file_size'], 'its size asked, nothing read: the preview follows the open buffer');
      await clock.advance(PREVIEW_FOLLOW_MAX_MS * 2);
      assert.equal(count('fs_read_file'), 0);
      assert.equal(tabById(preview.id).text, '# Disk one');

      // The text tab closes: the file is read once, 300 ms on, and shown.
      calls.length = 0;
      E.getState().closeTab(source.id);
      assert.equal(tabById(preview.id).text, '# Disk one', 'at once: the text the editor last read');
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.equal(count('fs_read_file'), 1, 'read once the text tab closed: the folder\u{2019}s look had found it behind the disk');
      assert.equal(tabById(preview.id).text, '# Disk two, a longer text');
      await clock.advance(PREVIEW_FOLLOW_MAX_MS * 2);
      assert.equal(count('fs_read_file'), 1, 'and only once');
    }));

  test('EP-37: a tab closed, or renamed, while its look\u{2019}s fs_file_size is out: the answer changes nothing and reads nothing (C3 R3 d)', () =>
    withClock(async (clock) => {
      /** Hold every fs_file_size until the case lets it go. */
      const holdSizes = () => {
        const held = [];
        answers.fs_file_size = (args, real) => new Promise((resolve, reject) => held.push(() => real().then(resolve, reject)));
        return held;
      };
      const errors = [];
      const report = console.error;
      console.error = (...args) => errors.push(args.map(String).join(' '));
      try {
        // Closed: a Markdown preview whose file grew, its folder changed.
        const docs = folder('closed');
        const md = `${docs}/README.md`;
        await invoke('fs_write_file', { path: md, content: '# Docs' });
        const preview = await E.getState().openMarkdownPreview(md);
        await clock.advance(PREVIEW_FOLLOW_MS * 2);
        calls.length = 0;
        let held = holdSizes();
        mockBridge.files.set(md, '# Docs, and more of them');
        await mockBridge.emit('fs-change', { path: docs, kind: 'modify' });
        await clock.advance(PREVIEW_FOLLOW_MS);
        assert.equal(held.length, 1, 'setup: the look asked the size');
        E.getState().closeTab(preview.id);
        const tabsClosed = E.getState().tabs;
        held[0]();
        await clock.settle();
        await clock.advance(PREVIEW_FOLLOW_MS * 2);
        assert.equal(E.getState().tabs, tabsClosed, 'closed: nothing changed');
        assert.deepEqual(reads().map((c) => c.command), ['fs_file_size'], 'closed: nothing read');
        delete answers.fs_file_size;

        // Renamed: the answer is for the old name, which is gone; the renamed tab is not marked deleted, nor read.
        const assets = folder('renamed');
        const svg = `${assets}/logo.svg`;
        await invoke('fs_write_file', { path: svg, content: SVG_A });
        const pic = await E.getState().openFile(svg);
        await clock.advance(PREVIEW_FOLLOW_MS * 2);
        calls.length = 0;
        held = holdSizes();
        await mockBridge.emit('fs-change', { path: assets, kind: 'modify' });
        await clock.advance(PREVIEW_FOLLOW_MS);
        assert.equal(held.length, 1, 'setup: the look asked the size');
        await E.getState().renamePath(svg, 'renamed.svg');
        const renamed = tabById(pic.id);
        assert.equal(renamed.filePath, `${assets}/renamed.svg`, 'setup: the tab took the new name');
        const tabsRenamed = E.getState().tabs;
        held[0]();
        await clock.settle();
        assert.equal(E.getState().tabs, tabsRenamed, 'renamed: nothing changed');
        assert.equal(tabById(pic.id).deleted, false, 'not deleted on disk by the old name\u{2019}s answer');
        assert.deepEqual(reads().filter((c) => c.command !== 'fs_file_size'), [], 'renamed: nothing read');
        delete answers.fs_file_size;
      } finally {
        console.error = report;
      }
      assert.deepEqual(errors, [], 'no look failed');
    }));
});

// ---- An SVG is a picture, and its source is text (OQ-B4d) --------------------------

const registrySource = () => readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
const searchSource = () => readFileSync(new URL('../../src/components/search/SearchPanel.jsx', import.meta.url), 'utf8');
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">\n  <rect width="1" height="1"/>\n</svg>\n';

/**
 * ImagePreview.jsx, bundled with esbuild — Node cannot import a .jsx file —
 * with the app's plain modules kept by file URL, so that its store is the
 * very store these cases arrange.
 */
const EDITOR_COMPONENTS = fileURLToPath(new URL('../../src/components/editor/', import.meta.url));
let imagePreviewLoading = null;
function loadImagePreview() {
  imagePreviewLoading ??= build({
    stdin: { contents: "export { ImagePreview } from './ImagePreview.jsx';", resolveDir: EDITOR_COMPONENTS, sourcefile: 'image-preview-under-test.js', loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'image-preview-real-store',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return undefined;
            if (args.path.startsWith('.') && /\.jsx$/.test(args.path)) return undefined;
            if (args.path.startsWith('.') && args.resolveDir) return { path: pathToFileURL(resolvePath(args.resolveDir, args.path)).href, external: true };
            return { path: import.meta.resolve(args.path), external: true };
          });
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return imagePreviewLoading;
}

describe('Preview tabs: an SVG opens as a picture, with Open as Text, and at a line as text (OQ-B4d)', () => {
  beforeEach(setUp);
  afterEach(teardownP4);

  test('EP-28: openFile (the Explorer, Go to File) opens the picture; openFileAsText opens or reveals the text tab, and the two coexist; openFileAt with a line, a terminal link path:line or path:line:col and a search result open the text at that line; a PNG keeps its picture', async () => {
    const path = await file('icon', 'svg', ICON_SVG);
    const picture = await E.getState().openFile(path);
    assert.equal(picture.kind, 'image', 'a click in the Explorer opens the picture');
    assert.deepEqual(reads(), [{ command: 'fs_read_image', args: { path } }]);

    // Open as Text: read as text, never as an image; a text tab, the picture left open.
    calls.length = 0;
    const text = await E.getState().openFileAsText(path);
    assert.ok(!isPreviewTab(text) && text.kind === undefined, `a text tab: ${text.kind}`);
    assert.deepEqual([text.filePath, text.content, text.isDirty], [path, ICON_SVG, false]);
    assert.deepEqual(reads(), [{ command: 'fs_read_file', args: { path } }]);
    assert.deepEqual(E.getState().tabs.filter((t) => t.filePath === path).map((t) => t.id), [picture.id, text.id], 'both tabs of the file');
    assert.equal(E.getState().activeTabId, text.id);
    assert.ok(holderOf(text.id) && holderOf(picture.id), 'both on the workbench');

    // Again: each revealed where it is, nothing read.
    calls.length = 0;
    assert.equal((await E.getState().openFileAsText(path)).id, text.id);
    assert.equal((await E.getState().openFile(path)).id, picture.id, 'the Explorer still reveals the picture');
    assert.equal(E.getState().activeTabId, picture.id);
    assert.equal(E.getState().tabs.length, 2);
    assert.deepEqual(reads(), []);

    // A line asked for: the text tab, the caret parked at it.
    assert.equal((await E.getState().openFileAt(path, 12)).id, text.id);
    assert.deepEqual(E.getState().pendingReveal, { filePath: path, line: 12, column: 1 });
    assert.equal(E.getState().activeTabId, text.id);

    // No text tab open: openFileAt opens one, reads it as text, and parks the line.
    E.getState().closeTab(text.id);
    E.getState().clearReveal();
    calls.length = 0;
    const opened = await E.getState().openFileAt(path, 12);
    assert.ok(!isPreviewTab(opened), 'openFileAt(x.svg, 12) opened the picture');
    assert.deepEqual(reads(), [{ command: 'fs_read_file', args: { path } }]);
    assert.deepEqual(E.getState().pendingReveal, { filePath: path, line: 12, column: 1 });

    // With no line, or none to go to: the picture, nothing parked.
    for (const line of [undefined, null, 0, Number.NaN]) {
      E.getState().clearReveal();
      assert.equal((await E.getState().openFileAt(path, line)).id, picture.id, `line ${line}`);
      assert.equal(E.getState().pendingReveal, null);
    }

    // A terminal link, opened as terminalRegistry.js opens one, and a search result (SearchPanel.jsx).
    assert.match(registrySource(), /editor\.openFileAt\(resolved, match\.line, match\.column\)/);
    assert.match(searchSource(), /onClick=\{\(\) => openFileAt\(file\.path, match\.line, match\.column\)\}/);
    const rel = path.slice('/workspace/'.length);
    for (const [printed, line, column] of [[`${rel}:12`, 12, 1], [`./${rel}:7:5`, 7, 5]]) {
      E.getState().clearReveal();
      const links = findLinks(`error: ${printed} bad attribute`).filter((l) => l.kind === 'path');
      assert.equal(links.length, 1, `the link in ${printed}`);
      const tab = await E.getState().openFileAt(resolveLinkPath(links[0].path, '/workspace'), links[0].line, links[0].column);
      assert.equal(tab.id, opened.id, `${printed} opened the text tab`);
      assert.deepEqual(E.getState().pendingReveal, { filePath: path, line, column });
    }
    // A terminal file link always carries a line: a path printed without one is no link (terminalLinks.js).
    assert.deepEqual(findLinks(`see ./${rel} here`), []);

    // Whatever the extension's case.
    const upper = await file('UPPER', 'SVG', ICON_SVG);
    assert.ok(!isPreviewTab(await E.getState().openFileAt(upper, 2)), '.SVG at a line is text too');
    assert.equal((await E.getState().openFile(upper)).kind, 'image');

    // Any other image: the picture, its line dropped, as before (EP-13); there is no text of it to open.
    E.getState().clearReveal();
    calls.length = 0;
    const png = await E.getState().openFileAt(LOGO_PNG, 12, 3);
    assert.equal(png.kind, 'image');
    assert.equal(E.getState().pendingReveal, null);
    assert.deepEqual(commands(), ['fs_read_image']);
  });

  test('EP-29: an SVG\u{2019}s text tab is an ordinary text tab: edited it is dirty, Save writes it, Send to Agent sends it, it has a Monaco model, and the session keeps it and brings it back as text', async () => {
    const typed = [];
    const original = T.getState().typeAgentReference;
    await relaunch();
    await whenTabsRestored();
    const monaco = fakeMonaco();
    const stop = watchEditorModels(monaco, E);
    try {
      const path = await file('edited', 'svg', ICON_SVG);
      const picture = await E.getState().openFile(path);
      const text = await E.getState().openFileAsText(path);

      // Dirty, asked about on close, saved.
      E.getState().editBuffer(text.id, ICON_SVG.replace('width="1" height="1"/>', 'width="2" height="1"/>'));
      assert.equal(tabById(text.id).isDirty, true);
      assert.equal(tabById(picture.id).isDirty, false, 'the picture is never dirty');
      E.getState().requestCloseTab(text.id);
      assert.equal(E.getState().pendingClose?.kind, 'tab', 'closing it with edits asks');
      E.getState().cancelPendingClose();
      calls.length = 0;
      await E.getState().saveAll();
      assert.deepEqual(writes().map((c) => c.args.path), [path], 'Save All writes the text tab');
      assert.equal(tabById(text.id).isDirty, false);

      // The picture follows the save: the watcher's modify of the file, one read PREVIEW_FOLLOW_MS on (reviewer B2 F2).
      const saved = tabById(text.id).content;
      const imageReads = () => reads().filter((c) => c.command === 'fs_read_image');
      for (let i = 0; i < 100 && imageReads().length === 0; i += 1) await sleep(20);
      await sleep(PREVIEW_FOLLOW_MS * 2);
      assert.deepEqual(imageReads(), [{ command: 'fs_read_image', args: { path } }], 'the picture is read again, once');
      assert.equal(Buffer.from(tabById(picture.id).image.data, 'base64').toString('utf8'), saved, 'the picture of the text saved');
      assert.notEqual(saved, ICON_SVG);

      // A Monaco model, as a text tab has.
      const editor = fakeEditor();
      showFile(editor, tabById(text.id), 'xml');
      assert.deepEqual(monaco.made, [path], 'a model for the SVG\u{2019}s text');
      showFile(editor, tabById(picture.id), 'plaintext');
      assert.deepEqual(monaco.made, [path], 'and none for its picture');

      // Send to Agent: the text tab is the file open.
      T.setState({
        tabs: [{ id: 'tab-agent', sessionId: 'session-agent', agent: { kind: 'claude' }, agentTyped: { sessionId: 'session-agent' }, exited: false }],
        typeAgentReference: async (tabId, value) => {
          typed.push({ tabId, text: value });
          return { status: 'refused' };
        },
      });
      E.setState({ activeTabId: text.id });
      assert.equal(sendCommandState().file, null, 'the SVG\u{2019}s text tab can be sent');
      await sendFileToAgent();
      assert.deepEqual(typed, [{ tabId: 'tab-agent', text: `@${path} ` }]);

      // The session keeps it, and a restart brings it back as text, its picture not.
      E.getState().dispose();
      assert.deepEqual(savedFiles(), [path], 'the text tab is saved, the picture is not');
      calls.length = 0;
      await relaunch();
      await whenTabsRestored();
      assert.deepEqual(E.getState().tabs.map((t) => [t.filePath, t.kind]), [[path, undefined]], 'back as a text tab');
      assert.ok(!commands().includes('fs_read_image'), 'no picture read');
    } finally {
      stop();
      T.setState({ typeAgentReference: original, tabs: [] });
      useToastStore.setState({ toasts: [] });
    }
  });

  test('EP-30: the SVG tab\u{2019}s Open as Text button, clicked, opens the text tab with the real store, and reveals it the next time; a PNG tab has no such button', async () => {
    const { ImagePreview } = await loadImagePreview();
    const path = await file('clicked', 'svg', ICON_SVG);
    const picture = await E.getState().openFile(path);
    await onPage(async (p) => {
      const Body = ({ id }) => {
        const tab = useEditorStore((st) => st.tabs.find((t) => t.id === id));
        return tab ? React.createElement(ImagePreview, { tab }) : null;
      };
      p.render(React.createElement(Body, { id: picture.id }));
      await letItRun(5);
      const button = () => [...p.document.querySelectorAll('button')].find((b) => b.textContent === 'Open as Text');
      assert.ok(button(), 'no Open as Text on the SVG tab');
      calls.length = 0;
      p.click(button());
      for (let i = 0; i < 50 && E.getState().tabs.length < 2; i += 1) await letItRun(2);
      const text = E.getState().tabs.find((t) => t.filePath === path && !isPreviewTab(t));
      assert.ok(text, 'the click opened no text tab');
      assert.deepEqual([text.content, E.getState().activeTabId], [ICON_SVG, text.id]);
      assert.deepEqual(reads(), [{ command: 'fs_read_file', args: { path } }], 'read as text');
      assert.ok(tabById(picture.id), 'the picture stays open');

      // Clicked again from the picture: the same text tab, revealed, nothing read.
      E.setState({ activeTabId: picture.id });
      calls.length = 0;
      p.click(button());
      await letItRun(10);
      assert.equal(E.getState().activeTabId, text.id);
      assert.equal(E.getState().tabs.length, 2);
      assert.deepEqual(reads(), []);
      p.unmount();
    });

    const png = await E.getState().openFile(LOGO_PNG);
    await onPage(async (p) => {
      p.render(React.createElement(ImagePreview, { tab: tabById(png.id) }));
      await letItRun(5);
      assert.ok(p.document.querySelector('[role="toolbar"]'), 'setup: the PNG is drawn with its toolbar');
      assert.ok(![...p.document.querySelectorAll('button')].some((b) => /Open as Text/.test(b.textContent)), 'a PNG offers Open as Text');
      p.unmount();
    });
  });

  test('EP-33: New File of an .svg, in any case, opens its text tab, never a refused picture; any other new file opens as before (OQ-B4e)', async () => {
    counter += 1;
    const tabsOf = (path) => E.getState().tabs.filter((t) => t.filePath === path);
    for (const path of [`/workspace/_ep_icon_${counter}.svg`, `/workspace/_ep_LOGO_${counter}.SVG`]) {
      calls.length = 0;
      await E.getState().createFile(path);
      const made = tabsOf(path);
      assert.deepEqual(made.map((t) => [t.kind, t.content]), [[undefined, '']], `${path}: one text tab, empty`);
      assert.equal(E.getState().activeTabId, made[0].id);
      assert.deepEqual(reads(), [{ command: 'fs_read_file', args: { path } }], `${path}: read as text, never as a picture`);
    }
    const notes = `/workspace/_ep_notes_${counter}.md`;
    calls.length = 0;
    await E.getState().createFile(notes);
    assert.deepEqual(tabsOf(notes).map((t) => [t.kind, t.content]), [[undefined, '']], 'a .md: its text tab, as before');
    assert.deepEqual(reads(), [{ command: 'fs_read_file', args: { path: notes } }]);
    const png = `/workspace/_ep_new_${counter}.png`;
    calls.length = 0;
    await E.getState().createFile(png);
    assert.deepEqual(tabsOf(png).map((t) => t.kind), ['image'], 'a .png: its image tab, as before');
    assert.deepEqual(reads(), [{ command: 'fs_read_image', args: { path: png } }]);
  });
});
