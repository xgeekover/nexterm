/**
 * The Markdown preview follows its source (Orca bundle 5, B3, step P8):
 * F-B3-7, the buffer half of AC-B3-8, and the palette half of AC-B3-10.
 *
 *   AC-B3-8  While the text tab of the file is open, the preview shows its
 *            buffer, 300 ms after the last edit and not before; a burst of
 *            edits is one update (ML-01, ML-02; fake timers). With no text
 *            tab it shows the tab's own text, which the store keeps to the
 *            disk (ML-03; the read itself is EP-22). When the text tab
 *            closes, its edits given up or not, the preview shows the file
 *            as the editor last read or wrote it, in the same update, and
 *            reads it once more if it changed on disk meanwhile (ML-04,
 *            ML-05). A buffer past 2 MB, counted in UTF-8 bytes, goes
 *            nowhere and shows too-large (ML-06).
 *   F-B3-5   The images a preview read are kept by path while it is
 *            mounted: a new text reads none of them again, and only a
 *            change on disk under a path has that one read again (ML-07).
 *            Reads in flight are the preview's, not a round's: changes on
 *            disk while they are out never put more than four out at once or
 *            two of one path, and a read of a file that changed meanwhile is
 *            done again once it settled (ML-11, reviewer A R4). A change of
 *            one image leaves every other drawn, never a box for a frame
 *            (ML-12); a change of a folder above images asks their sizes
 *            again and reads none whose size is the same (ML-13), only the
 *            one whose size changed (ML-14) (reviewer B R3).
 *   AC-B3-10 Open Markdown Preview is listed only while the editor shows a
 *            Markdown file's text tab — not its preview, an image, another
 *            file or nothing — and has no chord (ML-08, ML-09, ML-10). The
 *            breadcrumb button is RN-263 (tests/render/runner.js), the
 *            Explorer's item EXO-07 (explorer_open_actions.test.js).
 *
 * Node cannot import a .jsx file, so EditorPane.jsx and MarkdownPreview.jsx
 * are bundled with esbuild and imported from a data: URL, as
 * workbench_bundle.js and markdown_preview_mounted.test.js do.
 *  - EditorPane's bundle keeps the app's own plain modules — the editor
 *    store above all — by file URL: the very store a case arranges. Its
 *    bodies are stood in, the Markdown one by a box that records each text
 *    it is handed.
 *  - MarkdownPreview's bundle stands in the editor store, the IPC bridge
 *    (which counts what is asked, and emits `fs-change` when a case says)
 *    and the worker factory (a fake worker answering as the real one does,
 *    with `answerMarkdownRequest`).
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun } from './react_page.js';
import {
  useEditorStore,
  MARKDOWN_PREVIEW_MAX_BYTES,
  PREVIEW_FOLLOW_MS,
  __previewReadsPending,
} from '../../src/stores/editorStore.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import { answerMarkdownRequest } from '../../src/lib/markdownWorker.js';
import { DEFAULT_RESOLVED } from '../../src/lib/keybindings.js';
import { buildPaletteGroups, paletteCommands } from '../../src/lib/paletteItems.js';
import { markdownPreviewTarget, openMarkdownPreviewActive } from '../../src/lib/workbenchCommands.js';

const h = React.createElement;
const E = useEditorStore;
const T = useTerminalStore;
const EDITOR_DIR = fileURLToPath(new URL('../../src/components/editor/', import.meta.url));
const OPEN_EXTERNAL = fileURLToPath(new URL('../../src/lib/openExternal.js', import.meta.url));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ---- EditorPane.jsx, with the store real and the bodies stood in ----------------

const PANE_REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'lucide-react', 'zustand', 'zustand/react/shallow']);
const PANE_STAND_INS = [
  [/\/EditorPanel\.jsx$/, "export default function EditorBody() { return null; }"],
  [/\/ImagePreview\.jsx$/, "export default function ImageBody() { return null; }"],
  [
    /\/MarkdownPreview\.jsx$/,
    [
      "import { createElement } from 'react';",
      'export const seen = [];',
      // The real preview's seam: its own text unless one is handed to it.
      'export default function MarkdownBody({ tab, text = tab?.text }) {',
      "  seen.push({ text: typeof text === 'string' ? text : null, tooLarge: tab?.tooLarge === true, bytes: tab?.bytes ?? null });",
      "  return createElement('div', { 'data-stand-in': 'MarkdownBody' });",
      '}',
    ].join('\n'),
  ],
];

let paneLoading = null;
function loadPane() {
  paneLoading ??= build({
    stdin: {
      contents: "export { MarkdownPaneBody, useSettledText } from './EditorPane.jsx';\nexport { seen } from './MarkdownPreview.jsx';",
      resolveDir: EDITOR_DIR,
      sourcefile: 'markdown-pane-under-test.js',
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
        name: 'markdown-pane-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            const index = PANE_STAND_INS.findIndex(([re]) => re.test(args.path));
            if (index !== -1) return { path: String(index), namespace: 'stand-in' };
            if (PANE_REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            if (args.path.startsWith('.') && /\.jsx$/.test(args.path)) return undefined;
            if (args.path.startsWith('.') && /\.js$/.test(args.path) && args.resolveDir) {
              return { path: pathToFileURL(resolvePath(args.resolveDir, args.path)).href, external: true };
            }
            if (args.kind === 'entry-point') return undefined;
            throw new Error(`EditorPane imports ${args.path}, which this suite has no stand-in for`);
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({
            contents: PANE_STAND_INS[Number(args.path)][1],
            loader: 'js',
            resolveDir: EDITOR_DIR,
          }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return paneLoading;
}

// ---- the fake clock, installed inside each case (a failed case skips afterEach) --

function fakeClock() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Map();
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

// ---- the store, arranged; IPC recorded ------------------------------------------

const calls = [];
function recordIpc() {
  calls.length = 0;
  const real = Object.getPrototypeOf(mockBridge).invoke;
  mockBridge.invoke = function recording(command, args, ...rest) {
    calls.push({ command, args });
    return real.call(mockBridge, command, args, ...rest);
  };
}
const textReads = () => calls.filter((c) => c.command === 'fs_read_file' || c.command === 'fs_file_size');

let counter = 0;
/** A Markdown file in the mock, holding `content`. */
async function mdFile(name, content) {
  counter += 1;
  const path = `/workspace/_ml_${name}_${Date.now()}_${counter}.md`;
  await invoke('fs_write_file', { path, content });
  return path;
}
const textTab = (id, filePath, content, savedContent = content) => ({
  id,
  filePath,
  fileName: filePath.split('/').pop(),
  content,
  savedContent,
  isDirty: content !== savedContent,
  language: 'markdown',
});
const previewTab = (id, filePath, text) => ({
  id,
  kind: 'markdown',
  filePath,
  fileName: filePath.split('/').pop(),
  isDirty: false,
  deleted: false,
  text,
  bytes: text.length,
  tooLarge: false,
});

let pane = null;
async function freshPane() {
  pane = await loadPane();
  pane.seen.length = 0;
  delete mockBridge.invoke;
  E.setState({ tabs: [], activeTabId: null, pendingClose: null, openFailure: null, rootPath: '/workspace' });
}

/** The preview tab `id`, as the store holds it now, drawn by the editor pane's Markdown body — lazy, as in the pane. */
function Body({ id }) {
  const tab = useEditorStore((s) => s.tabs.find((t) => t.id === id));
  return tab ? h(pane.MarkdownPaneBody, { tab }) : null;
}
const Host = ({ id }) => h(React.Suspense, { fallback: null }, h(Body, { id }));

/** `page` draws preview `id`, its lazy body arrived. */
async function show(page, clock, id) {
  page.render(h(Host, { id }));
  for (let i = 0; i < 20 && pane.seen.length === 0; i += 1) await clock.settle();
  assert.ok(pane.seen.length > 0, 'the Markdown body never arrived');
}
const lastShown = () => pane.seen[pane.seen.length - 1] ?? null;
const textsShown = () => pane.seen.map((s) => s.text);

/** Run `fn(page, clock)` on a page, with the fake clock installed and taken out again. */
async function withPage(fn) {
  await onPage(async (p) => {
    const clock = fakeClock();
    try {
      await fn(p, clock);
    } finally {
      clock.restore();
      p.unmount();
      delete mockBridge.invoke;
    }
  });
}

const utf8 = (text) => Buffer.byteLength(text, 'utf8');

describe('Markdown preview follows the source buffer (AC-B3-8, buffer half; fake timers)', () => {
  beforeEach(freshPane);

  test('ML-01: an edit in the text tab reaches the preview 300 ms after it, not before; the buffer is followed from the first frame', () =>
    withPage(async (p, clock) => {
      assert.equal(PREVIEW_FOLLOW_MS, 300);
      const path = '/workspace/live.md';
      E.setState({ tabs: [textTab('src', path, '# Buffer', '# Saved'), previewTab('pv', path, '# Open-time')] });
      await show(p, clock, 'pv');
      assert.equal(lastShown().text, '# Buffer', 'the buffer, unsaved edits and all, from the first frame');

      E.getState().editBuffer('src', '# Two');
      await clock.settle();
      await clock.advance(PREVIEW_FOLLOW_MS - 1);
      assert.ok(!textsShown().includes('# Two'), 'the edit was shown before 300 ms');
      assert.equal(lastShown().text, '# Buffer');
      await clock.advance(1);
      assert.equal(lastShown().text, '# Two', 'the edit was not shown at 300 ms');
      assert.equal(E.getState().tabs.find((t) => t.id === 'pv').text, '# Open-time', 'the store is not written per keystroke');
    }));

  test('ML-02: a burst of edits 100 ms apart is one update, 300 ms after the last; nothing in between is shown', () =>
    withPage(async (p, clock) => {
      const path = '/workspace/burst.md';
      E.setState({ tabs: [textTab('src', path, '# 0'), previewTab('pv', path, '# 0')] });
      await show(p, clock, 'pv');
      for (const n of [1, 2, 3, 4, 5]) {
        E.getState().editBuffer('src', `# ${n}`);
        await clock.settle();
        await clock.advance(100);
      }
      assert.deepEqual([...new Set(textsShown())], ['# 0'], 'an edit of the burst was shown while it went on');
      await clock.advance(PREVIEW_FOLLOW_MS - 100 - 1);
      assert.equal(lastShown().text, '# 0');
      await clock.advance(1);
      assert.deepEqual([...new Set(textsShown())], ['# 0', '# 5'], 'more than one update, or not the last edit');
      await clock.advance(PREVIEW_FOLLOW_MS * 5);
      assert.deepEqual([...new Set(textsShown())], ['# 0', '# 5']);
    }));

  test('ML-03: with no text tab open the preview shows its own text, which the store keeps to the disk (EP-22), at once', () =>
    withPage(async (p, clock) => {
      const path = '/workspace/disk.md';
      E.setState({ tabs: [textTab('other', '/workspace/other.md', '# Not this'), previewTab('pv', path, '# Disk one')] });
      await show(p, clock, 'pv');
      assert.equal(lastShown().text, '# Disk one');
      // What `followDisk` writes after its own 300 ms: shown with no second wait.
      E.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === 'pv' ? { ...t, text: '# Disk two', bytes: 10 } : t)) }));
      await clock.settle();
      assert.equal(lastShown().text, '# Disk two');
      // Another file's buffer is not followed.
      E.getState().editBuffer('other', '# Still not this');
      await clock.settle();
      await clock.advance(PREVIEW_FOLLOW_MS * 2);
      assert.ok(!textsShown().some((t) => /not this/i.test(t ?? '')), 'another file\u{2019}s buffer was shown');
    }));

  test('ML-04: the text tab closes with its edits given up: the preview shows the saved text in the same update, never the buffer or the stale text, and reads nothing', () =>
    withPage(async (p, clock) => {
      const path = '/workspace/discard.md';
      E.setState({ tabs: [textTab('src', path, '# Unsaved edit', '# Saved'), previewTab('pv', path, '# Open-time buffer')] });
      await show(p, clock, 'pv');
      assert.equal(lastShown().text, '# Unsaved edit');
      recordIpc();
      pane.seen.length = 0;
      E.getState().closeTab('src');
      await clock.settle();
      assert.equal(E.getState().tabs.find((t) => t.id === 'pv').text, '# Saved', 'the store did not take the saved text');
      assert.ok(pane.seen.length > 0 && pane.seen.every((s) => s.text === '# Saved'), `shown after the close: ${JSON.stringify(textsShown())}`);
      assert.equal(__previewReadsPending(), 0, 'a read was scheduled for a file that did not change');
      await clock.advance(PREVIEW_FOLLOW_MS * 3);
      assert.deepEqual(textReads(), [], 'the disk was read');
      assert.equal(lastShown().text, '# Saved');

      // And another text tab of another file closing leaves it alone.
      E.setState((s) => ({ tabs: [...s.tabs, textTab('x', '/workspace/x.md', '# X')] }));
      E.getState().closeTab('x');
      assert.equal(E.getState().tabs.find((t) => t.id === 'pv').text, '# Saved');
    }));

  test('ML-05: the file changed on disk while its text tab was open: after the close the preview reads it once, 300 ms on, and shows it', async () => {
    await E.getState().attachListeners();
    try {
      await followedAfterClose();
    } finally {
      // Nothing left listening for the next suite.
      E.getState().dispose();
    }
  });
});

async function followedAfterClose() {
  {
    await withPage(async (p, clock) => {
      const path = await mdFile('behind', '# Disk one');
      E.setState({ tabs: [textTab('src', path, '# Edited', '# Disk one'), previewTab('pv', path, '# Disk one')] });
      await show(p, clock, 'pv');
      recordIpc();
      await invoke('fs_write_file', { path, content: '# Disk two' });
      await clock.advance(PREVIEW_FOLLOW_MS * 2);
      assert.deepEqual(textReads(), [], 'read while the text tab was open');
      assert.equal(lastShown().text, '# Edited');

      calls.length = 0;
      E.getState().closeTab('src');
      await clock.settle();
      assert.equal(lastShown().text, '# Disk one', 'not the saved text at once');
      assert.equal(__previewReadsPending(), 1, 'no read scheduled');
      await clock.advance(PREVIEW_FOLLOW_MS - 1);
      assert.deepEqual(textReads(), []);
      await clock.advance(1);
      assert.deepEqual(textReads().map((c) => c.command), ['fs_file_size', 'fs_read_file'], 'one read, size first');
      assert.equal(lastShown().text, '# Disk two');
    });
  }
}

describe('Markdown preview follows the source buffer: the size limit (AC-B3-8; fake timers)', () => {
  beforeEach(freshPane);

  test('ML-06: a buffer past 2 MB in UTF-8 bytes shows too-large and is never handed on; back under the limit it is', () =>
    withPage(async (p, clock) => {
      const path = '/workspace/big.md';
      E.setState({ tabs: [textTab('src', path, '# Small'), previewTab('pv', path, '# Small')] });
      await show(p, clock, 'pv');
      // Fewer UTF-16 units than the limit, more UTF-8 bytes.
      const wide = '\u{e9}'.repeat(MARKDOWN_PREVIEW_MAX_BYTES / 2 + 1);
      assert.ok(wide.length < MARKDOWN_PREVIEW_MAX_BYTES && utf8(wide) > MARKDOWN_PREVIEW_MAX_BYTES, 'setup');
      E.getState().editBuffer('src', wide);
      await clock.settle();
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(lastShown(), { text: null, tooLarge: true, bytes: utf8(wide) }, 'not the too-large state, with its size');

      const ascii = 'x'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1);
      E.getState().editBuffer('src', ascii);
      await clock.settle();
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(lastShown(), { text: null, tooLarge: true, bytes: MARKDOWN_PREVIEW_MAX_BYTES + 1 });
      assert.ok(pane.seen.every((s) => s.text === null || utf8(s.text) <= MARKDOWN_PREVIEW_MAX_BYTES), 'a text past the limit was handed on');

      E.getState().editBuffer('src', '# Small again');
      await clock.settle();
      await clock.advance(PREVIEW_FOLLOW_MS);
      assert.deepEqual(lastShown(), { text: '# Small again', tooLarge: false, bytes: 13 });
    }));
});

// ---- MarkdownPreview.jsx, with the images cached ----------------------------------

const PREVIEW_REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'zustand', 'hast-util-to-jsx-runtime', 'lucide-react']);
const PREVIEW_STAND_INS = {
  calls: 'export const calls = [];',
  editorStore: `
    import { create } from 'zustand';
    export const useEditorStore = create(() => ({ rootPath: '/w', openFile: async () => null }));`,
  ipc: `
    import { calls } from 'stand-in:calls';
    export const bridge = { answer: null, listeners: new Set() };
    export function isTauri() {
      return false;
    }
    export async function invoke(command, args) {
      calls.push([command, args]);
      if (!bridge.answer) throw new Error('Unknown IPC command: ' + command);
      return bridge.answer(command, args);
    }
    export async function listen(event, callback) {
      if (event !== 'fs-change') throw new Error('Unknown event: ' + event);
      bridge.listeners.add(callback);
      return () => bridge.listeners.delete(callback);
    }
    export function emit(payload) {
      for (const fn of [...bridge.listeners]) fn(payload);
    }`,
  openExternal: `
    export { addressToOpen, hyperlinkTitle, isOpenable } from ${JSON.stringify(OPEN_EXTERNAL)};
    export async function openExternal() { return true; }`,
  workerFactory: `
    export const host = { answer: null };
    export function createMarkdownWorker() {
      const listeners = {};
      const worker = {
        terminated: false,
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        postMessage(data) { host.answer?.(worker, data); },
        terminate() { worker.terminated = true; },
        reply(data) { setTimeout(() => { if (!worker.terminated) for (const fn of listeners.message ?? []) fn({ data }); }, 0); },
      };
      return worker;
    }`,
};
function previewStandInFor(path, importer) {
  if (path === 'stand-in:calls') return 'calls';
  if (/\/stores\/editorStore\.js$/.test(path)) return 'editorStore';
  if (/(?:^|\/)ipc\.js$/.test(path)) return 'ipc';
  if (/(?:^|\/)markdownWorkerFactory\.js$/.test(path)) return 'workerFactory';
  if (/(?:^|\/)openExternal\.js$/.test(path) && /MarkdownPreview\.jsx$/.test(importer ?? '')) return 'openExternal';
  return null;
}
let previewLoading = null;
function loadPreview() {
  previewLoading ??= build({
    stdin: {
      contents: [
        "export { MarkdownPreview } from './MarkdownPreview.jsx';",
        "export { bridge, emit } from '../../lib/ipc.js';",
        "export { host } from '../../lib/markdownWorkerFactory.js';",
        "export { calls } from 'stand-in:calls';",
      ].join('\n'),
      resolveDir: EDITOR_DIR,
      sourcefile: 'markdown-preview-cache-under-test.js',
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
        name: 'markdown-preview-cache-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (PREVIEW_REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            const standIn = previewStandInFor(args.path, args.importer);
            return standIn ? { path: standIn, namespace: 'stand-in' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({ contents: PREVIEW_STAND_INS[args.path], loader: 'js', resolveDir: EDITOR_DIR }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return previewLoading;
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAF0lEQVR42mOQk9P737nl138QDcIMBAUANcIWVJdRDv4AAAAASUVORK5CYII=';
const IMAGE_DOC = (words) => [`# ${words}`, '', '![a](img/a.png) ![b](pics/b.png)'].join('\n');
const A = '/w/img/a.png';
const B = '/w/pics/b.png';

async function until(ready, what, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (ready()) return;
    await letItRun(2);
  }
  assert.fail(`never happened: ${what}`);
}

describe('Markdown preview keeps the images it read (F-B3-5, step P8)', () => {
  test('ML-07: a new text reads no image again and draws them from its first frame; a change on disk under a path reads that one only; an access reads nothing', async () => {
    const ui = await loadPreview();
    ui.calls.length = 0;
    ui.bridge.listeners.clear();
    ui.host.answer = (worker, data) => worker.reply(answerMarkdownRequest(data));
    const gone = new Set();
    ui.bridge.answer = async (command, args) => {
      if (gone.has(args.path)) throw new Error(`File not found: ${args.path}`);
      if (command === 'fs_file_size') return 80;
      if (command === 'fs_read_image') return { mime: 'image/png', data: PNG, bytes: 80, width: 4, height: 3 };
      throw new Error(`unexpected ${command}`);
    };
    const asked = (command) => ui.calls.filter(([c]) => c === command).map(([, args]) => args.path).sort();
    const tab = { id: 'md1', kind: 'markdown', filePath: '/w/README.md', fileName: 'README.md', isDirty: false, deleted: false, text: IMAGE_DOC('One'), bytes: 40, tooLarge: false };
    await onPage(async (p) => {
      const pictures = () => p.document.querySelectorAll('img[data-image="load"]').length;
      const heading = () => p.document.querySelector('h1')?.textContent ?? '';
      p.render(h(ui.MarkdownPreview, { tab, text: IMAGE_DOC('One') }));
      await until(() => pictures() === 2, 'both images drawn');
      assert.deepEqual([asked('fs_file_size'), asked('fs_read_image')], [[A, B], [A, B]], 'the first document reads each image once');
      assert.equal(ui.bridge.listeners.size, 1, 'one fs-change listener for the preview');

      // A keystroke later: a new text, the same images.
      ui.calls.length = 0;
      // Every box React writes, if only for one frame: a read image must not become one.
      const element = Object.getPrototypeOf(p.document.createElement('span'));
      const setAttribute = element.setAttribute;
      const boxes = [];
      element.setAttribute = function recording(name, value) {
        if (name === 'data-image-placeholder') boxes.push(String(value));
        return setAttribute.call(this, name, value);
      };
      try {
        p.render(h(ui.MarkdownPreview, { tab, text: IMAGE_DOC('Two') }));
        await until(() => heading() === 'Two', 'the new text drawn');
        await letItRun(20);
      } finally {
        element.setAttribute = setAttribute;
      }
      assert.deepEqual(ui.calls, [], 'the new text asked the backend again');
      assert.equal(pictures(), 2);
      assert.deepEqual(boxes, [], 'a read image was drawn as a box, if only for a frame');

      // A change of a.png on disk: that one, and only it, read again.
      ui.emit({ path: A, kind: 'modify' });
      await until(() => asked('fs_read_image').length === 1 && pictures() === 2, 'a.png read again');
      await letItRun(20);
      assert.deepEqual([asked('fs_file_size'), asked('fs_read_image')], [[A], [A]], 'what the change had read again');

      // An access (Linux reports the preview's own read so), another path: nothing.
      ui.calls.length = 0;
      ui.emit({ path: B, kind: 'other' });
      ui.emit({ path: '/w/img/a.png.bak', kind: 'modify' });
      ui.emit({ path: '/w/README.md', kind: 'modify' });
      ui.emit(null);
      await letItRun(20);
      assert.deepEqual(ui.calls, [], 'an access or another path read an image');

      // The folder of b.png renamed or deleted by another program: its size is asked again, and with
      // b.png gone it is a box, never read; a.png is drawn as it was (reviewer B R3).
      gone.add(B);
      ui.emit({ path: '/w/pics', kind: 'delete' });
      await until(() => pictures() === 1 && asked('fs_file_size').length === 1, 'b.png gone');
      await letItRun(20);
      assert.deepEqual([asked('fs_file_size'), asked('fs_read_image')], [[B], []]);
      assert.equal(p.document.querySelector('img[data-image="load"]')?.getAttribute('alt'), 'a');

      // Back (renamed back: a modify of the folder): its size is in again, and it is read again.
      gone.delete(B);
      ui.calls.length = 0;
      ui.emit({ path: '/w/pics', kind: 'modify' });
      await until(() => asked('fs_read_image').length === 1 && pictures() === 2, 'b.png read again');
      assert.deepEqual([asked('fs_file_size'), asked('fs_read_image')], [[B], [B]]);
      p.unmount();
      assert.equal(ui.bridge.listeners.size, 0, 'the listener stays after the unmount');
    });
  });
});

describe('Markdown preview: image reads in flight across changes on disk (reviewer A, R4)', () => {
  test('ML-11: with reads held and fs-change restarting the rounds, at most four fs_read_image are out and never two of one path; the reads out are taken by the next round, and one whose file changed is read again after it', async () => {
    const ui = await loadPreview();
    ui.calls.length = 0;
    ui.bridge.listeners.clear();
    ui.host.answer = (worker, data) => worker.reply(answerMarkdownRequest(data));
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const paths = names.map((name) => `/w/img/${name}.png`);
    const held = [];
    const out = new Map();
    let most = 0;
    let twice = 0;
    ui.bridge.answer = (command, args) => {
      if (command === 'fs_file_size') return 80;
      if (command !== 'fs_read_image') throw new Error(`unexpected ${command}`);
      out.set(args.path, (out.get(args.path) ?? 0) + 1);
      if (out.get(args.path) > 1) twice += 1;
      const total = [...out.values()].reduce((a, b) => a + b, 0);
      most = Math.max(most, total);
      return new Promise((resolve) => {
        held.push(() => {
          out.set(args.path, out.get(args.path) - 1);
          resolve({ mime: 'image/png', data: PNG, bytes: 80, width: 4, height: 3 });
        });
      });
    };
    const reads = () => ui.calls.filter(([c]) => c === 'fs_read_image').map(([, args]) => args.path);
    const text = names.map((name) => `![${name}](img/${name}.png)`).join(' ');
    const tab = { id: 'md1', kind: 'markdown', filePath: '/w/README.md', fileName: 'README.md', isDirty: false, deleted: false, text, bytes: text.length, tooLarge: false };
    await onPage(async (p) => {
      const pictures = () => p.document.querySelectorAll('img[data-image="load"]').length;
      p.render(h(ui.MarkdownPreview, { tab, text }));
      await until(() => held.length === 4, 'four reads out');
      assert.deepEqual(reads(), paths.slice(0, 4), 'the first four, in order');

      // Changes on disk restart the round, again and again, while all four are out: f (not out yet), then a (out).
      for (let i = 0; i < 3; i += 1) {
        ui.emit({ path: paths[5], kind: 'modify' });
        await letItRun(10);
      }
      ui.emit({ path: paths[0], kind: 'modify' });
      await letItRun(10);
      assert.equal(held.length, 4, `a restart sent reads of its own while four were out: ${reads().join(', ')}`);

      // Answered one at a time: each freed place takes the next read, a.png's again only once its first is in.
      for (let i = 0; i < 20 && pictures() < 6; i += 1) {
        held.shift()?.();
        await letItRun(10);
      }
      await until(() => pictures() === 6, 'every image drawn');
      assert.ok(most <= 4, `${most} reads out at once`);
      assert.equal(twice, 0, 'two reads of one path were out at once');
      const count = (path) => reads().filter((read) => read === path).length;
      // b, c and d were out through every restart and answered the last round; f changed before its read went out.
      assert.deepEqual(paths.map(count), [2, 1, 1, 1, 1, 1], 'reads per path, a.png read again once its first read was in');
      assert.deepEqual(reads().slice(4), [paths[0], paths[4], paths[5]], 'after the first four: a.png again, then e and f');
      p.unmount();
    });
  });
});

// ---- Reviewer C3 R1: an answer that lands between a change on disk and the round's stop ----

/** Another picture than PNG: what a.png holds once it changed. */
const PNG_NEW = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** A mebibyte (ML-15..18). */
const MB = 1024 * 1024;

/**
 * The preview of `text` on page `p`, every image read with `sizes` (what
 * fs_file_size answers, by path, and what each read says it brought in).
 * A read of a path in `hold` is held until `release()`; `picture` is what a
 * read of a.png answers when it goes out. Answers once `ready(p)` holds.
 */
async function heldReads(ui, p, text, sizes, ready) {
  ui.calls.length = 0;
  ui.bridge.listeners.clear();
  ui.host.answer = (worker, data) => worker.reply(answerMarkdownRequest(data));
  const state = { hold: new Set(), held: [], picture: PNG };
  ui.bridge.answer = async (command, args) => {
    if (command === 'fs_file_size') return sizes.get(args.path);
    if (command !== 'fs_read_image') throw new Error(`unexpected ${command}`);
    const answer = { mime: 'image/png', data: args.path === A ? state.picture : PNG, bytes: sizes.get(args.path), width: 4, height: 3 };
    if (state.hold.has(args.path)) return new Promise((resolve) => state.held.push(() => resolve(answer)));
    return answer;
  };
  const tab = { id: 'md17', kind: 'markdown', filePath: '/w/README.md', fileName: 'README.md', isDirty: false, deleted: false, text, bytes: text.length, tooLarge: false };
  p.render(h(ui.MarkdownPreview, { tab, text }));
  await until(() => ready(p), 'the first images drawn');
  await letItRun(20);
  return state;
}

describe('Markdown preview: a read answering after its image changed again (reviewer C3 R1)', () => {
  const askedOf = (ui, command, path) => ui.calls.filter(([c, a]) => c === command && a.path === path).length;
  const readsSince = (ui, from) => ui.calls.slice(from).filter(([c]) => c === 'fs_read_image').map(([, a]) => a.path).sort();
  const srcOf = (p, alt) => p.document.querySelector(`img[data-image="load"][alt="${alt}"]`)?.getAttribute('src') ?? null;

  /**
   * IMAGE_DOC drawn; a.png changes, and while its read is held, `change` comes
   * (a.png itself, or its folder) and a.png now holds PNG_NEW. The held read,
   * of the old picture, answers in the same tick (`beforeStop`: before React
   * stops the round) or once the next round runs. What was asked of a.png
   * after `change`, and the picture drawn for it.
   */
  async function answerAfterChange(change, beforeStop) {
    const ui = await loadPreview();
    let out;
    await onPage(async (p) => {
      const pictures = () => p.document.querySelectorAll('img[data-image="load"]').length;
      const state = await heldReads(ui, p, IMAGE_DOC('Changed'), new Map([[A, 80], [B, 80]]), () => pictures() === 2);
      state.hold.add(A);
      ui.emit({ path: A, kind: 'modify' });
      await until(() => state.held.length === 1, 'a.png read out');
      const reads = askedOf(ui, 'fs_read_image', A);
      const sizes = askedOf(ui, 'fs_file_size', A);
      state.picture = PNG_NEW;
      state.hold.clear();
      ui.emit({ path: change, kind: 'modify' });
      if (beforeStop) state.held[0]();
      else {
        await letItRun(20);
        state.held[0]();
      }
      await until(() => srcOf(p, 'a') === `data:image/png;base64,${PNG_NEW}`, `a.png drawn with its new picture (${change}, ${beforeStop ? 'race' : 'control'})`);
      await letItRun(20);
      out = { reads: askedOf(ui, 'fs_read_image', A) - reads, sizes: askedOf(ui, 'fs_file_size', A) - sizes, pictures: pictures() };
      p.unmount();
    });
    return out;
  }

  test('ML-17: an answer of an image that changed again is never kept, whether it comes after the round stopped or before: the image is sized again, read again and drawn new; a folder change above it in that window does the same; and a plan short of a forgotten size prunes no picture', async () => {
    assert.deepEqual(await answerAfterChange(A, false), { reads: 1, sizes: 1, pictures: 2 }, 'control: the answer comes after the next round started');
    assert.deepEqual(await answerAfterChange(A, true), { reads: 1, sizes: 1, pictures: 2 }, 'race: the answer came before React stopped the round, and was kept');
    assert.deepEqual(await answerAfterChange('/w/img', true), { reads: 1, sizes: 1, pictures: 2 }, 'race, folder: the answer of an image to be sized again was kept');

    // 20 + 11 + 15 MB drawn, three (20 MB) left out. While b.png's size is forgotten, a.png's answer
    // comes: a plan short of b.png would skip past it, keep three and leave out four, whose picture
    // would be read again once b.png's size is in.
    const ui = await loadPreview();
    await onPage(async (p) => {
      const FOUR = '# Four\n\n![one](img/a.png) ![two](pics/b.png) ![three](img/c.png) ![four](img/d.png)';
      const sizes = new Map([[A, 20 * MB], [B, 11 * MB], ['/w/img/c.png', 20 * MB], ['/w/img/d.png', 15 * MB]]);
      const shown = () => [...p.document.querySelectorAll('img[data-image="load"]')].map((img) => img.getAttribute('alt'));
      const state = await heldReads(ui, p, FOUR, sizes, () => shown().length === 3);
      assert.deepEqual(shown(), ['one', 'two', 'four'], 'setup: three left out for the 50 MB');
      state.hold.add(A);
      ui.emit({ path: A, kind: 'modify' });
      await until(() => state.held.length === 1, 'a.png read out');
      const from = ui.calls.length;
      state.hold.clear();
      ui.emit({ path: B, kind: 'modify' });
      state.held[0]();
      await until(() => readsSince(ui, from).includes(B) && shown().length === 3, 'b.png read again, and one, two and four drawn');
      await letItRun(20);
      assert.deepEqual(readsSince(ui, from), [B], 'after b.png changed, only it is read: four kept its picture');
      assert.deepEqual(shown(), ['one', 'two', 'four']);
      p.unmount();
    });
  });
});

// ---- Reviewer B R3: no flicker, and a folder's change reads only what changed ----

const THREE_DOC = '# Three\n\n![alpha](img/a.png) ![beta](pics/b.png) ![gamma](img/c.png)';
const C = '/w/img/c.png';

/** The preview of THREE_DOC on page `p`, its three images drawn; `sizes` is what fs_file_size answers, by path. */
async function threeImages(ui, p, sizes) {
  ui.calls.length = 0;
  ui.bridge.listeners.clear();
  ui.host.answer = (worker, data) => worker.reply(answerMarkdownRequest(data));
  ui.bridge.answer = async (command, args) => {
    if (command === 'fs_file_size') {
      if (!sizes.has(args.path)) throw new Error(`File not found: ${args.path}`);
      return sizes.get(args.path);
    }
    if (command === 'fs_read_image') return { mime: 'image/png', data: PNG, bytes: 80, width: 4, height: 3 };
    throw new Error(`unexpected ${command}`);
  };
  const tab = { id: 'md3', kind: 'markdown', filePath: '/w/README.md', fileName: 'README.md', isDirty: false, deleted: false, text: THREE_DOC, bytes: THREE_DOC.length, tooLarge: false };
  p.render(h(ui.MarkdownPreview, { tab, text: THREE_DOC }));
  await until(() => p.document.querySelectorAll('img[data-image="load"]').length === 3, 'the three images drawn');
  ui.calls.length = 0;
}

/**
 * Every image box React writes on page `p` from now on, if only for one
 * frame, by the words it names its image with (ML-07's recorder): `stop()`
 * puts setAttribute back and answers them.
 */
function recordBoxes(p) {
  const element = Object.getPrototypeOf(p.document.createElement('span'));
  const setAttribute = element.setAttribute;
  const boxes = [];
  element.setAttribute = function recording(name, value) {
    if (name === 'data-image-placeholder') boxes.push(this);
    return setAttribute.call(this, name, value);
  };
  return {
    stop() {
      element.setAttribute = setAttribute;
      return boxes.map((box) => box.getAttribute('aria-label') ?? '');
    },
  };
}

describe('Markdown preview: an image changed on disk, or a folder above it (reviewer B, R3)', () => {
  const asked = (ui, command) => ui.calls.filter(([c]) => c === command).map(([, args]) => args.path).sort();
  const pictures = (p) => [...p.document.querySelectorAll('img[data-image="load"]')].map((img) => img.getAttribute('alt'));

  test('ML-12: a change of one image reads that one again and leaves the others drawn: no box is written for them, not for one frame; only the changed one may wait', async () => {
    const ui = await loadPreview();
    await onPage(async (p) => {
      await threeImages(ui, p, new Map([[A, 80], [B, 80], [C, 80]]));
      const recorder = recordBoxes(p);
      let boxes;
      try {
        ui.emit({ path: A, kind: 'modify' });
        await until(() => asked(ui, 'fs_read_image').length === 1 && pictures(p).length === 3, 'a.png read again');
        await letItRun(20);
      } finally {
        boxes = recorder.stop();
      }
      assert.deepEqual([asked(ui, 'fs_file_size'), asked(ui, 'fs_read_image')], [[A], [A]], 'a.png only');
      assert.ok(boxes.some((words) => /alpha/.test(words)), `setup: the changed image\u{2019}s own wait was not recorded (${boxes.join(' | ')})`);
      assert.deepEqual(boxes.filter((words) => !/alpha/.test(words)), [], 'an image that did not change was drawn as a box');
      assert.deepEqual(pictures(p), ['alpha', 'beta', 'gamma']);
      p.unmount();
    });
  });

  test('ML-13: a folder above images changed with their sizes the same — written into, renamed and back — asks their sizes again and reads nothing; nothing turns into a box; a \'rename\' kind, which the watcher never sends, asks nothing', async () => {
    const ui = await loadPreview();
    await onPage(async (p) => {
      await threeImages(ui, p, new Map([[A, 80], [B, 80], [C, 80]]));
      const recorder = recordBoxes(p);
      let boxes;
      try {
        ui.emit({ path: '/w/img', kind: 'modify' });
        await until(() => asked(ui, 'fs_file_size').length === 2, 'the sizes under img/ asked');
        await letItRun(20);
        assert.deepEqual([asked(ui, 'fs_file_size'), asked(ui, 'fs_read_image')], [[A, C], []], 'img/: sizes only');

        ui.calls.length = 0;
        ui.emit({ path: '/W', kind: 'modify' });
        await until(() => asked(ui, 'fs_file_size').length === 3, 'every size asked');
        await letItRun(20);
        assert.deepEqual([asked(ui, 'fs_file_size'), asked(ui, 'fs_read_image')], [[A, C, B], []], 'the folder above all, whatever its case: sizes only');

        ui.calls.length = 0;
        ui.emit({ path: A, kind: 'rename' });
        ui.emit({ path: '/w/img', kind: 'rename' });
        await letItRun(20);
        assert.deepEqual(ui.calls, [], 'a rename kind asked the backend');
      } finally {
        boxes = recorder.stop();
      }
      assert.deepEqual(boxes, [], 'an image was drawn as a box');
      assert.deepEqual(pictures(p), ['alpha', 'beta', 'gamma']);
      p.unmount();
    });
  });

  test('ML-14: a folder changed where one image\u{2019}s size changed reads that one again, only it; the others stay drawn', async () => {
    const ui = await loadPreview();
    await onPage(async (p) => {
      const sizes = new Map([[A, 80], [B, 80], [C, 80]]);
      await threeImages(ui, p, sizes);
      sizes.set(C, 120);
      const recorder = recordBoxes(p);
      let boxes;
      try {
        ui.emit({ path: '/w/img', kind: 'modify' });
        await until(() => asked(ui, 'fs_read_image').length === 1 && pictures(p).length === 3, 'c.png read again');
        await letItRun(20);
      } finally {
        boxes = recorder.stop();
      }
      assert.deepEqual([asked(ui, 'fs_file_size'), asked(ui, 'fs_read_image')], [[A, C], [C]], 'c.png, whose size changed, only');
      assert.deepEqual(boxes.filter((words) => !/gamma/.test(words)), [], 'an image whose size is the same was drawn as a box');
      assert.deepEqual(pictures(p), ['alpha', 'beta', 'gamma']);

      // Asked again with nothing changed since: nothing read.
      ui.calls.length = 0;
      ui.emit({ path: '/w/img', kind: 'modify' });
      await until(() => asked(ui, 'fs_file_size').length === 2, 'asked again');
      await letItRun(20);
      assert.deepEqual(asked(ui, 'fs_read_image'), []);
      p.unmount();
    });
  });
});

// ---- Reviewer A2 R1 and B2 F5: the 50 MB of images bound what is read and kept, near the cap too ----

/** The state of each image box on page `p`, by the words it names its image with. */
const boxStates = (p) =>
  [...p.document.querySelectorAll('[data-image-placeholder]')].map((box) => `${box.getAttribute('aria-label')}: ${box.getAttribute('data-image-placeholder')}`);

/** Every state React writes into an image box on page `p` from now on, if only for one frame: `stop()` answers them, by the box's words. */
function recordBoxStates(p) {
  const element = Object.getPrototypeOf(p.document.createElement('span'));
  const setAttribute = element.setAttribute;
  const written = [];
  element.setAttribute = function recording(name, value) {
    if (name === 'data-image-placeholder') written.push([this, String(value)]);
    return setAttribute.call(this, name, value);
  };
  return {
    stop() {
      element.setAttribute = setAttribute;
      return written.map(([box, state]) => `${box.getAttribute('aria-label') ?? ''}: ${state}`);
    },
  };
}

describe('Markdown preview: what is read and kept stays within 50 MB (reviewer A2 R1, reviewer B2 F5)', () => {
  const asked = (ui, command) => ui.calls.filter(([c]) => c === command).map(([, args]) => args.path).sort();
  const pictures = (p) => [...p.document.querySelectorAll('img[data-image="load"]')].map((img) => img.getAttribute('alt'));

  test('ML-15: a read that brings in more bytes than its size said is planned again with them: the image it pushes past 50 MB is a box, never drawn', async () => {
    const ui = await loadPreview();
    ui.calls.length = 0;
    ui.bridge.listeners.clear();
    ui.host.answer = (worker, data) => worker.reply(answerMarkdownRequest(data));
    // 15 + 15 + 16 = 46 MB planned; a.png grew to 20 MB before its read, which would make it 51.
    const sizes = new Map([[A, 15 * MB], [B, 15 * MB], [C, 16 * MB]]);
    const read = new Map([[A, 20 * MB], [B, 15 * MB], [C, 16 * MB]]);
    ui.bridge.answer = async (command, args) => {
      if (command === 'fs_file_size') return sizes.get(args.path);
      if (command === 'fs_read_image') return { mime: 'image/png', data: PNG, bytes: read.get(args.path), width: 4, height: 3 };
      throw new Error(`unexpected ${command}`);
    };
    const tab = { id: 'md15', kind: 'markdown', filePath: '/w/README.md', fileName: 'README.md', isDirty: false, deleted: false, text: THREE_DOC, bytes: THREE_DOC.length, tooLarge: false };
    await onPage(async (p) => {
      p.render(h(ui.MarkdownPreview, { tab, text: THREE_DOC }));
      await until(() => asked(ui, 'fs_read_image').length === 3 && !boxStates(p).some((box) => /loading$/.test(box)), 'the three reads in');
      await letItRun(20);
      assert.deepEqual(pictures(p), ['alpha', 'beta'], 'drawn: 20 + 15 MB');
      assert.deepEqual(boxStates(p), ['Image not shown: gamma, img/c.png: bytes'], 'gamma would take the document past 50 MB');
      p.unmount();
    });
  });

  test('ML-16: a picture a later plan leaves out is not kept: drawn again only once it is read again; while an earlier image\u{2019}s size is asked again, its box keeps the over-budget reason, never loading', async () => {
    const ui = await loadPreview();
    await onPage(async (p) => {
      const sizes = new Map([[A, 15 * MB], [B, 15 * MB], [C, 16 * MB]]);
      await threeImages(ui, p, sizes);

      // a.png rewritten to 20 MB: 20 + 15 + 16 = 51 MB, so gamma is left out.
      sizes.set(A, 20 * MB);
      ui.emit({ path: A, kind: 'modify' });
      await until(() => pictures(p).length === 2 && boxStates(p).length === 1 && /bytes$/.test(boxStates(p)[0]), 'gamma left out');
      await letItRun(20);
      assert.deepEqual([asked(ui, 'fs_file_size'), asked(ui, 'fs_read_image')], [[A], [A]]);
      assert.deepEqual(pictures(p), ['alpha', 'beta']);

      // a.png rewritten again, its size held: gamma stays the over-budget box, not for one frame a loading one.
      ui.calls.length = 0;
      const answer = ui.bridge.answer;
      const held = [];
      ui.bridge.answer = (command, args) =>
        command === 'fs_file_size' && args.path === A ? new Promise((resolve) => held.push(() => resolve(answer(command, args)))) : answer(command, args);
      const recorder = recordBoxStates(p);
      let written;
      try {
        ui.emit({ path: A, kind: 'modify' });
        await until(() => held.length === 1, 'the size of a.png asked');
        await letItRun(20);
      } finally {
        written = recorder.stop();
      }
      assert.ok(written.some((box) => /alpha/.test(box)), `setup: a.png\u{2019}s own wait was not recorded (${written.join(' | ')})`);
      assert.deepEqual(written.filter((box) => /gamma/.test(box)), [], 'gamma\u{2019}s box changed while a size before it was asked');
      assert.ok(boxStates(p).includes('Image not shown: gamma, img/c.png: bytes'), boxStates(p).join(' | '));

      // Back to 15 MB: everything fits again, and gamma, whose picture was not kept, is read again.
      sizes.set(A, 15 * MB);
      held[0]();
      await until(() => pictures(p).length === 3, 'the three drawn');
      await letItRun(20);
      assert.deepEqual([asked(ui, 'fs_file_size'), asked(ui, 'fs_read_image')], [[A], [A, C]], 'gamma read again: its picture was not kept while it was left out');
      assert.deepEqual(pictures(p), ['alpha', 'beta', 'gamma']);
      p.unmount();
    });
  });

  test('ML-18: an image a grown read lets back in is read and drawn in that same round, not left a loading box (reviewer C3 R2)', async () => {
    const ui = await loadPreview();
    ui.calls.length = 0;
    ui.bridge.listeners.clear();
    ui.host.answer = (worker, data) => worker.reply(answerMarkdownRequest(data));
    // 10 + 20 + 19 = 49 MB planned, and delta's 2 MB would make 51: left out. a.png grew to 12 MB before its
    // read: 12 + 20 = 32, so gamma no longer fits and delta does (34 MB).
    const D = '/w/img/d.png';
    const sizes = new Map([[A, 10 * MB], [B, 20 * MB], [C, 19 * MB], [D, 2 * MB]]);
    const read = new Map([...sizes, [A, 12 * MB]]);
    ui.bridge.answer = async (command, args) => {
      if (command === 'fs_file_size') return sizes.get(args.path);
      if (command === 'fs_read_image') return { mime: 'image/png', data: PNG, bytes: read.get(args.path), width: 4, height: 3 };
      throw new Error(`unexpected ${command}`);
    };
    const text = `${THREE_DOC} ![delta](img/d.png)`;
    const tab = { id: 'md18', kind: 'markdown', filePath: '/w/README.md', fileName: 'README.md', isDirty: false, deleted: false, text, bytes: text.length, tooLarge: false };
    await onPage(async (p) => {
      p.render(h(ui.MarkdownPreview, { tab, text }));
      await until(() => pictures(p).length === 3 && !boxStates(p).some((box) => /loading$/.test(box)), `delta drawn, no box loading (${boxStates(p).join(' | ')})`);
      await letItRun(20);
      assert.deepEqual(pictures(p), ['alpha', 'beta', 'delta'], 'drawn: 12 + 20 + 2 MB');
      assert.deepEqual(boxStates(p), ['Image not shown: gamma, img/c.png: bytes'], 'gamma would take the document past 50 MB');
      assert.deepEqual(asked(ui, 'fs_read_image'), [A, B, C, D].sort(), 'each read once; delta in the same round, with no change on disk');
      p.unmount();
    });
  });
});

// ---- Open Markdown Preview in the palette (AC-B3-10) -----------------------------

const listed = (markdownPreview) =>
  (buildPaletteGroups({ fileTree: [], rootPath: '/workspace', query: '', mode: 'commands', markdownPreview }).find((g) => g.label === 'commands')?.items ?? []).some(
    (c) => c.command === 'open_markdown_preview'
  );

describe('Open Markdown Preview in the palette (AC-B3-10)', () => {
  beforeEach(async () => {
    delete mockBridge.invoke;
    E.setState({ tabs: [], activeTabId: null, pendingClose: null, openFailure: null, rootPath: '/workspace' });
    // One group, its one pane a terminal: the commands take the editor's active tab (`saveTarget`).
    T.setState({
      groups: [{ id: 'group-1', name: 'Group 1', createdAt: 1, tree: { type: 'leaf', id: 'pane-1', tabIds: [], activeTabId: null }, activePaneId: 'pane-1' }],
      activeGroupId: 'group-1',
    });
  });

  test('ML-08: listed only for a Markdown file (a path), not for null; a caller that says nothing lists every built-in; no chord', () => {
    assert.equal(listed('/workspace/README.md'), true);
    assert.equal(listed(null), false, 'listed with no Markdown file to preview');
    assert.equal(listed(''), false);
    assert.equal(listed(undefined), true);
    const entry = paletteCommands(DEFAULT_RESOLVED).find((c) => c.command === 'open_markdown_preview');
    assert.deepEqual([entry?.id, entry?.title, entry?.hint], ['cmd-open-markdown-preview', 'Open Markdown Preview', undefined]);
    assert.ok(!Object.keys(DEFAULT_RESOLVED).some((k) => /markdown/i.test(k)), 'a default binding');
    // Found by its words.
    const found = buildPaletteGroups({ fileTree: [], rootPath: '/workspace', query: 'markdown preview', mode: 'commands', markdownPreview: '/workspace/a.md' });
    assert.equal(found.find((g) => g.label === 'commands')?.items[0]?.command, 'open_markdown_preview');
  });

  test('ML-09: what it previews is the editor\u{2019}s active tab when that is a Markdown text tab: not its preview, an image, another file, or no tab', async () => {
    const text = textTab('t1', '/workspace/README.md', '# R');
    const upper = textTab('t2', '/workspace/NOTES.MARKDOWN', '# N');
    const other = textTab('t3', '/workspace/notes.txt', 'plain');
    const mdx = textTab('t4', '/workspace/page.mdx', 'x');
    const pv = previewTab('p1', '/workspace/README.md', '# R');
    const img = { id: 'i1', kind: 'image', filePath: '/workspace/logo.png', fileName: 'logo.png', isDirty: false, deleted: false, image: null, failure: null };
    E.setState({ tabs: [text, upper, other, mdx, pv, img] });
    const target = (id) => {
      E.setState({ activeTabId: id });
      return markdownPreviewTarget()?.id ?? null;
    };
    assert.equal(target('t1'), 't1');
    assert.equal(target('t2'), 't2', '.MARKDOWN, whatever its case');
    assert.equal(target('t3'), null, 'a .txt file');
    assert.equal(target('t4'), null, 'an .mdx file');
    assert.equal(target('p1'), null, 'the preview tab itself');
    assert.equal(target('i1'), null, 'an image tab');
    assert.equal(target(null), null, 'no tab');

    // Picked: the store's openMarkdownPreview, with the text tab's path; nothing for anything else.
    const asked = [];
    const real = E.getState().openMarkdownPreview;
    E.setState({ openMarkdownPreview: async (path) => (asked.push(path), { id: 'new' }) });
    try {
      E.setState({ activeTabId: 't1' });
      assert.deepEqual(await openMarkdownPreviewActive(), { id: 'new' });
      E.setState({ activeTabId: 'p1' });
      assert.equal(await openMarkdownPreviewActive(), null);
      E.setState({ activeTabId: 't1', openMarkdownPreview: async () => Promise.reject(new Error('File not found')) });
      assert.equal(await openMarkdownPreviewActive(), null, 'a refusal rejected the command');
    } finally {
      E.setState({ openMarkdownPreview: real });
    }
    assert.deepEqual(asked, ['/workspace/README.md']);
  });

  test('ML-10: the palette asks markdownPreviewTarget as it opens and runs the command through openMarkdownPreviewActive', () => {
    const palette = read('../../src/components/command/CommandPalette.jsx');
    assert.match(palette, /markdownPreview: markdownPreviewTarget\(\)\?\.filePath \?\? null,/);
    assert.match(palette, /case 'open_markdown_preview':\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*await openMarkdownPreviewActive\(\);/);
  });
});
