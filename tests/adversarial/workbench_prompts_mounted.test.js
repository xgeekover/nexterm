/**
 * The unsaved and overwrite prompts are drawn whatever the group on screen
 * holds (editor placement, sibling B, review K-01 / K-05).
 *
 * Files belong to groups, and the editor area is mounted only while the group
 * on screen has an editor leaf. The Save / Don't Save / Cancel prompt used to
 * be drawn by the editor area alone, so with a dirty file in another group,
 * window close, Quit, a folder switch and closing that group waited on a
 * question nobody could see. These cases mount the real PanelLayout with the
 * real stores, ask each of those questions with a group on screen that has no
 * editor leaf, and look for the dialog on the page.
 *
 * Node cannot import a .jsx file, so PanelLayout is bundled with esbuild and
 * imported from a data: URL, as workbench_editor_area.test.js does. The
 * stores, the split-layout helpers and every other plain module are the app's
 * own, imported by file URL — the very instances the cases drive. React,
 * react-dom and the icons are real; the views PanelLayout lays out (terminals,
 * Explorer, Search, the editor area) and the resizable panels are stand-ins,
 * the editor area one marking where it is mounted. It is rendered with real
 * react-dom on the page written by hand in react_page.js.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun } from './react_page.js';
import { useEditorStore, registerEditorBridge } from '../../src/stores/editorStore.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import { leavesOfKind } from '../../src/components/terminal/splitLayout.js';

const h = React.createElement;
const E = useEditorStore;
const T = useTerminalStore;
const LAYOUT_DIR = fileURLToPath(new URL('../../src/components/layout/', import.meta.url));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Bundled as they are: the layout and what draws the prompts. */
const BUNDLED = [/^\.\/PanelLayout\.jsx$/, /\/editor\/EditorPrompts\.jsx$/, /\/common\/ConfirmDialog\.jsx$/];
/** Kept real. */
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'lucide-react']);
/** The views PanelLayout places, and the panel library: nothing these cases look at. */
const STAND_INS = [
  [
    /\/editor\/EditorPanel\.jsx$/,
    "import { createElement } from 'react';\nexport function EditorPanel() { return createElement('div', { 'data-stand-in': 'EditorPanel' }); }",
  ],
  [/\/terminal\/index\.js$/, 'export const TerminalSplitContainer = () => null;\nexport const TerminalsPanel = () => null;'],
  [/\/explorer\/FileExplorer\.jsx$/, 'export const FileExplorer = () => null;'],
  [/\/search\/SearchPanel\.jsx$/, 'export const SearchPanel = () => null;'],
  [
    /^react-resizable-panels$/,
    [
      "import { createElement, useRef } from 'react';",
      "export const Group = ({ children, className }) => createElement('div', { className }, children);",
      "export const Panel = ({ children, id, className }) => createElement('div', { id, className }, children);",
      'export const Separator = () => null;',
      'export const useGroupRef = () => useRef(null);',
    ].join('\n'),
  ],
];

let loading = null;
function loadLayout() {
  loading ??= build({
    stdin: {
      contents: "export { PanelLayout } from './PanelLayout.jsx';",
      resolveDir: LAYOUT_DIR,
      sourcefile: 'panel-layout-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'panel-layout-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            const index = STAND_INS.findIndex(([re]) => re.test(args.path));
            if (index !== -1) return { path: String(index), namespace: 'stand-in' };
            if (BUNDLED.some((re) => re.test(args.path))) return undefined;
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            // The app's plain modules — the stores above all — by file URL:
            // the instances this suite drives, not copies.
            if (args.path.startsWith('.') && /\.js$/.test(args.path) && args.resolveDir) {
              return { path: pathToFileURL(resolvePath(args.resolveDir, args.path)).href, external: true };
            }
            throw new Error(`PanelLayout imports ${args.path}, which this suite has no stand-in for`);
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({ contents: STAND_INS[Number(args.path)][1], loader: 'js', resolveDir: LAYOUT_DIR }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loading;
}

// --- storage, IPC recording, the stores (as workbench_editors.test.js) ---------
const backing = new Map();
let previousStorage;
let hadStorage = false;
let installed = false;
const calls = [];

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
    return real.call(mockBridge, command, args, ...rest);
  };
}

let ui = null;

async function setUp() {
  ui = await loadLayout();
  T.getState().dispose();
  backing.clear();
  installStorage();
  useSettingsStore.getState().resetSettings();
  recordIpc();
  registerEditorBridge();
  E.setState({ tabs: [], activeTabId: null, pendingClose: null, pendingOverwrite: null, openFailure: null, rootPath: '/workspace' });
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
  E.setState({ tabs: [], activeTabId: null, pendingClose: null, pendingOverwrite: null });
  T.getState().dispose();
  useSettingsStore.getState().resetSettings();
  if (installed) {
    if (hadStorage) globalThis.localStorage = previousStorage;
    else delete globalThis.localStorage;
    installed = false;
  }
}

let counter = 0;
async function file(name) {
  counter += 1;
  const path = `/workspace/_wp_${name}_${Date.now()}_${counter}.txt`;
  await invoke('fs_write_file', { path, content: 'on disk' });
  return path;
}

/** A dirty file in group 1, then a new group 2 on screen: no editor leaf in it. */
async function dirtyFileElsewhere() {
  const one = T.getState().activeGroupId;
  const tab = await E.getState().openFile(await file('dirty'));
  E.getState().editBuffer(tab.id, 'edited');
  const two = await T.getState().createGroup({ name: 'Two' });
  assert.equal(T.getState().activeGroupId, two.id, 'group 2 is on screen');
  assert.equal(leavesOfKind(two.tree, 'editor').length, 0, 'and has no editor leaf');
  assert.equal(leavesOfKind(T.getState().groups.find((g) => g.id === one).tree, 'editor').length, 1, 'the dirty file is in group 1');
  calls.length = 0;
  return { one, two: two.id, tab };
}

// --- the page ---------------------------------------------------------------------

/** What PanelLayout and the dialog reach for on `window` that the page lacks. */
function furnish(p) {
  Object.assign(p.window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  });
  p.document.documentElement.classList ??= { add() {}, remove() {}, toggle() {}, contains: () => false };
}

const dialogsOn = (p) => p.document.body.querySelectorAll('[role="alertdialog"]');
const editorAreaOn = (p) => p.document.body.querySelectorAll('[data-stand-in="EditorPanel"]');
function button(dialog, label) {
  const found = dialog.querySelectorAll('button').find((b) => b.textContent.trim() === label);
  assert.ok(found, `the dialog has a "${label}" button`);
  return found;
}

/** The one dialog on the page, after React has drawn what the store set off. */
async function theDialog(p, what) {
  await letItRun();
  const shown = dialogsOn(p);
  assert.equal(shown.length, 1, `${what}: the dialog is drawn, once, with no editor leaf on screen`);
  return shown[0];
}

async function mountLayout(p) {
  furnish(p);
  p.render(h(ui.PanelLayout));
  await letItRun();
}

describe('Workbench prompts: drawn whatever the group on screen holds (K-01, FX-1, FX-4)', () => {
  beforeEach(setUp);
  afterEach(teardown);

  test('WV-03: window close, Quit and a folder switch ask on screen with a dirty file in another group; Cancel and Don\u{2019}t Save each resolve it', async () => {
    const { tab } = await dirtyFileElsewhere();
    await onPage(async (p) => {
      await mountLayout(p);
      assert.equal(editorAreaOn(p).length, 0, 'group 2 has no editor leaf: no editor area is mounted');
      assert.equal(dialogsOn(p).length, 0, 'nothing asked yet');

      for (const kind of ['window', 'quit', 'root']) {
        let went = 0;
        const asked = p.settled(() => E.getState().askBeforeLeaving(kind, () => (went += 1)));
        assert.ok(asked, `${kind}: asked`);
        const dialog = await theDialog(p, kind);
        assert.match(dialog.textContent, new RegExp(tab.fileName.replace(/[.]/g, '\\.')), `${kind}: names the dirty file`);
        p.click(button(dialog, 'Cancel'));
        assert.equal(await asked, null, `${kind}: Cancel resolves it, as cancelled`);
        await letItRun();
        assert.equal(dialogsOn(p).length, 0, `${kind}: and the dialog goes`);
        assert.equal(went, 0, `${kind}: nothing went ahead`);
      }

      let closed = 0;
      const leaving = p.settled(() => E.getState().askBeforeLeaving('window', () => (closed += 1)));
      p.click(button(await theDialog(p, 'window, again'), "Don't Save"));
      assert.equal(await leaving, 1, "Don't Save resolves it: the window goes ahead");
      assert.equal(closed, 1);
      await letItRun();
      assert.equal(dialogsOn(p).length, 0);
      assert.equal(E.getState().pendingClose, null);
    });
  });

  test("WV-04: closing group 1 from group 2 asks on screen (kind 'group'); Cancel keeps it, Don\u{2019}t Save closes it; closeGroup settles both times", async () => {
    const { one, tab } = await dirtyFileElsewhere();
    await onPage(async (p) => {
      await mountLayout(p);
      assert.equal(editorAreaOn(p).length, 0, 'no editor area is mounted');

      const closing = T.getState().closeGroup(one);
      const dialog = await theDialog(p, 'closeGroup');
      assert.match(dialog.textContent, /Closing the group closes the editor tabs in it\./);
      p.click(button(dialog, 'Cancel'));
      assert.equal(await closing, false, 'Cancel: closeGroup settles, false');
      assert.ok(T.getState().groups.some((g) => g.id === one), 'group 1 is kept');
      assert.equal(calls.filter((c) => c.command === 'pty_kill').length, 0, 'no terminal killed');
      await letItRun();
      assert.equal(dialogsOn(p).length, 0);

      const again = T.getState().closeGroup(one);
      p.click(button(await theDialog(p, 'closeGroup, again'), "Don't Save"));
      assert.equal(await again, true, "Don't Save: closeGroup settles, true");
      assert.equal(T.getState().groups.some((g) => g.id === one), false, 'group 1 is gone');
      assert.equal(E.getState().tabs.some((t) => t.id === tab.id), false, 'with its file');
      await letItRun();
      assert.equal(dialogsOn(p).length, 0);
    });
  });

  test('WV-05: "File Changed on Disk" is drawn too; with the editor area mounted each prompt is drawn once, and the editor area draws none', async () => {
    const { one, tab } = await dirtyFileElsewhere();
    await onPage(async (p) => {
      await mountLayout(p);
      p.settled(() => E.setState({ pendingOverwrite: { tabId: tab.id, fileName: tab.fileName, diskContent: 'theirs', unreadable: null } }));
      const overwrite = await theDialog(p, 'overwrite');
      assert.match(overwrite.textContent, /File Changed on Disk/);
      p.click(button(overwrite, 'Cancel'));
      await letItRun();
      assert.equal(E.getState().pendingOverwrite, null);
      assert.equal(dialogsOn(p).length, 0);

      // Group 1 on screen: its editor area is mounted, and the prompt is still drawn once.
      p.settled(() => T.getState().setActiveGroup(one));
      await letItRun();
      assert.equal(editorAreaOn(p).length, 1, 'group 1 has an editor leaf: the editor area is mounted');
      const asked = p.settled(() => E.getState().askBeforeLeaving('window', () => true));
      p.click(button(await theDialog(p, 'window, group 1 on screen'), 'Cancel'));
      assert.equal(await asked, null);
    });
    // The editor area is a stand-in above, so it is read: it must not draw a second copy.
    assert.equal(/ConfirmDialog/.test(read('../../src/components/editor/EditorPanel.jsx')), false, 'EditorPanel.jsx draws no prompt of its own');
  });
});
