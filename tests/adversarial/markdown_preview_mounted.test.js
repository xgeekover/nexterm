/**
 * The Markdown preview (src/components/editor/MarkdownPreview.jsx), mounted
 * (Orca bundle 5, B3, step P7).
 *
 * What the document draws is pinned in tests/render/runner.js (RN-256 to
 * RN-262). What its links, images and renderer DO lives in handlers and
 * effects that `renderToString` never runs, so the preview is rendered here
 * with real React on the hand-written page (react_page.js) and used as a
 * user uses it:
 *
 *   AC-B3-9  an http(s) link asks first, in the app's own dialog, showing
 *            the cleaned address; only Open calls openExternal, once, with
 *            the address; Cancel and Escape call nothing; a file link opens
 *            with openFile and no dialog; an anchor or footnote link scrolls
 *            this preview's own scroller and navigates nowhere; an inert
 *            link does nothing; nothing uses the browser's own confirm or
 *            alert boxes (MV-09 reads the sources)
 *   F-B3-5   images are read through fs_file_size and fs_read_image only,
 *            for the document's own local images, at most 4 at once, and
 *            stop when the preview goes; a remote image asks nothing
 *   AC-B3-5  the renderer: one per preview, disposed when it goes; a result
 *            after a newer text, or after the unmount, is dropped; a file
 *            past the limit is never sent; the time limit shows "Too
 *            complex to preview" with Open as Text; "Rendering preview…"
 *            only for a slow first render; past the drawing cap — the
 *            worker's refusal, or an 'ok' tree past it, which the window
 *            counts again — the same notice, and nothing drawn (MV-12,
 *            reviewer A R2)
 *   R3       a link whose host is past 253 characters is inert, and the
 *            confirmation always shows the whole origin, only the path cut
 *            (MV-13, reviewer A R3)
 *
 * Node cannot import a .jsx file, so the component is bundled with esbuild
 * and imported from a data: URL, as palette_mounted.test.js does. Stood in:
 * the editor store (openFile counted), the IPC bridge (answers what a case
 * says, and counts what is in flight), openExternal (counted; the address
 * helpers are the real ones), the worker factory (a fake worker that the
 * case answers, here with the real worker's `answerMarkdownRequest`, so no
 * worker is spun), and lucide's icons.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun, dispatch } from './react_page.js';
import { answerMarkdownRequest } from '../../src/lib/markdownWorker.js';
import { MARKDOWN_PARSE_TIMEOUT_MS } from '../../src/lib/markdownRenderClient.js';
import { MARKDOWN_MAX_ELEMENTS, MARKDOWN_TOO_COMPLEX_ERROR } from '../../src/lib/markdownPreview.js';

const h = React.createElement;

// ---- The component, bundled with stand-ins -----------------------------------

const EDITOR_DIR = fileURLToPath(new URL('../../src/components/editor/', import.meta.url));
const OPEN_EXTERNAL = fileURLToPath(new URL('../../src/lib/openExternal.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Kept real: the React the page renders with must be the one the component calls. */
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'zustand', 'hast-util-to-jsx-runtime']);

const STAND_INS = {
  calls: `export const calls = [];`,
  editorStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useEditorStore = create(() => ({
      rootPath: '/w',
      openFile: async (path) => {
        calls.push(['openFile', path]);
        return { id: 'tab-x', filePath: path };
      },
    }));`,
  ipc: `
    import { calls } from 'stand-in:calls';
    export const bridge = { answer: null, inFlight: {}, most: {} };
    export function isTauri() {
      return false;
    }
    export async function invoke(command, args) {
      calls.push(['invoke', command, args]);
      bridge.inFlight[command] = (bridge.inFlight[command] ?? 0) + 1;
      bridge.most[command] = Math.max(bridge.most[command] ?? 0, bridge.inFlight[command]);
      try {
        if (!bridge.answer) throw new Error('Unknown IPC command: ' + command);
        return await bridge.answer(command, args);
      } finally {
        bridge.inFlight[command] -= 1;
      }
    }
    // The preview follows the watcher for its images (step P8); nothing here emits.
    export async function listen(event, callback) {
      if (event !== 'fs-change') throw new Error('Unknown event: ' + event);
      return () => {};
    }`,
  // Only MarkdownPreview.jsx's own import is stood in; markdownPreview.js keeps the real module.
  openExternal: `
    import { calls } from 'stand-in:calls';
    export { addressToOpen, hyperlinkTitle, isOpenable } from ${JSON.stringify(OPEN_EXTERNAL)};
    export async function openExternal(url) {
      calls.push(['openExternal', url]);
      return true;
    }`,
  workerFactory: `
    export const workers = [];
    export const host = { answer: null };
    class FakeWorker {
      constructor() {
        this.listeners = {};
        this.posted = [];
        this.terminated = false;
      }
      addEventListener(type, fn) {
        (this.listeners[type] ??= []).push(fn);
      }
      postMessage(data) {
        this.posted.push(data);
        host.answer?.(this, data);
      }
      terminate() {
        this.terminated = true;
      }
      emit(type, event) {
        if (this.terminated) return;
        for (const fn of this.listeners[type] ?? []) fn(event);
      }
      reply(data) {
        setTimeout(() => this.emit('message', { data }), 0);
      }
    }
    export function createMarkdownWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }`,
  lucide: `export const X = () => null;`,
};

/** Which stand-in a module the component imports is replaced by, if any. */
function standInFor(path, importer) {
  if (path === 'stand-in:calls') return 'calls';
  if (path === 'lucide-react') return 'lucide';
  if (/\/stores\/editorStore\.js$/.test(path)) return 'editorStore';
  if (/(?:^|\/)ipc\.js$/.test(path)) return 'ipc';
  if (/(?:^|\/)markdownWorkerFactory\.js$/.test(path)) return 'workerFactory';
  if (/(?:^|\/)openExternal\.js$/.test(path) && /MarkdownPreview\.jsx$/.test(importer ?? '')) return 'openExternal';
  return null;
}

let loading = null;
function loadPreview() {
  loading ??= build({
    stdin: {
      contents: [
        "export * from './MarkdownPreview.jsx';",
        "export { useEditorStore } from '../../stores/editorStore.js';",
        "export { bridge } from '../../lib/ipc.js';",
        "export { workers, host } from '../../lib/markdownWorkerFactory.js';",
        "export { calls } from 'stand-in:calls';",
      ].join('\n'),
      resolveDir: EDITOR_DIR,
      sourcefile: 'markdown-preview-under-test.js',
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
        name: 'markdown-preview-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            const standIn = standInFor(args.path, args.importer);
            return standIn ? { path: standIn, namespace: 'stand-in' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({
            contents: STAND_INS[args.path],
            loader: 'js',
            resolveDir: EDITOR_DIR,
          }));
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

let ui = null;

/** The worker answering every text as the real one does. */
const answerAsTheWorker = (worker, data) => worker.reply(answerMarkdownRequest(data));

/** Every case starts with nothing called, no worker made, and a worker that answers. */
async function fresh() {
  ui = await loadPreview();
  ui.useEditorStore.setState(ui.useEditorStore.getInitialState(), true);
  ui.calls.length = 0;
  ui.workers.length = 0;
  ui.host.answer = answerAsTheWorker;
  ui.bridge.answer = null;
  ui.bridge.inFlight = {};
  ui.bridge.most = {};
}

const DOC = [
  '# Install',
  '',
  'Go [external](https://user:pw@example.com/a?b=1) or [file](docs/guide.md) or [anchor](#install) or [inert](javascript:alert(1)).',
  '',
  'A note[^n].',
  '',
  '[^n]: The body.',
].join('\n');

const markdownTab = (extra = {}) => ({
  id: 'md1',
  kind: 'markdown',
  filePath: '/w/README.md',
  fileName: 'README.md',
  isDirty: false,
  deleted: false,
  text: DOC,
  bytes: DOC.length,
  tooLarge: false,
  ...extra,
});

/** Waits, a few ms at a time, until `ready()` holds. */
async function until(ready, what, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (ready()) return;
    await letItRun(2);
  }
  assert.fail(`never happened: ${what}`);
}

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const called = (name) => ui.calls.filter(([n]) => n === name).map(([, ...args]) => args);
const opened = () => called('openExternal').map(([url]) => url);
const filesOpened = () => called('openFile').map(([path]) => path);
const invoked = (command) => called('invoke').filter(([c]) => c === command).map(([, args]) => args);
const dialogOn = (p) => p.document.body.querySelector('[role="alertdialog"]');
const buttonIn = (node, words) => node.querySelectorAll('button').find((b) => b.textContent === words);
const articlesOn = (p) => p.document.querySelectorAll('article');

/** The preview of `tab`, mounted and drawn from the worker's first answer. */
async function mount(p, tab = markdownTab()) {
  p.render(h(ui.MarkdownPreview, { tab }));
  await until(() => articlesOn(p).length > 0, 'the document is drawn');
}

/** Stands in for the layout: `node`'s top edge at `top` px. */
const placeAt = (node, top) => {
  node.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20 });
};

describe('Markdown preview, mounted: an external link asks first (AC-B3-9)', () => {
  beforeEach(fresh);

  test('MV-01: a click on an http(s) link opens the in-app confirmation with the cleaned address and opens nothing; Open calls openExternal once, with the address', async () => {
    await onPage(async (p) => {
      await mount(p);
      const link = p.document.querySelector('[data-link="external"]');
      assert.ok(link, 'the external link is drawn');
      assert.ok(!link.hasAttribute('href'), 'the external link has an href');
      const click = p.click(link);
      assert.ok(click.defaultPrevented, 'the click is left to the webview');
      await letItRun();
      const dialog = dialogOn(p);
      assert.ok(dialog, 'no in-app confirmation opened');
      assert.equal(dialog.querySelector('[data-confirm-address]')?.textContent, 'https://example.com/a?b=1', 'the confirmation does not show the cleaned address');
      assert.ok(!dialog.textContent.includes('pw'), 'the confirmation shows the user name and password');
      assert.deepEqual(opened(), [], 'openExternal was called before Open');
      assert.ok(buttonIn(dialog, 'Cancel'), 'no Cancel');

      p.click(buttonIn(dialog, 'Open'));
      await letItRun();
      assert.deepEqual(opened(), ['https://example.com/a?b=1'], 'Open did not open the address once');
      assert.ok(!dialogOn(p), 'the confirmation stays after Open');
      assert.deepEqual(filesOpened(), [], 'a file was opened');
    });
  });

  test('MV-02: Cancel and Escape each close the confirmation and call nothing', async () => {
    await onPage(async (p) => {
      await mount(p);
      const link = p.document.querySelector('[data-link="external"]');
      p.click(link);
      await letItRun();
      p.click(buttonIn(dialogOn(p), 'Cancel'));
      await letItRun();
      assert.ok(!dialogOn(p), 'Cancel left the confirmation open');

      p.click(link);
      await letItRun();
      assert.ok(dialogOn(p), 'the confirmation does not open again');
      const escape = p.keydown('Escape');
      assert.ok(escape.defaultPrevented, 'Escape was not taken by the confirmation');
      await letItRun();
      assert.ok(!dialogOn(p), 'Escape left the confirmation open');
      assert.deepEqual(opened(), [], 'Cancel or Escape opened the address');
    });
  });

  test('MV-03: the keyboard reaches the links: Enter on an external link asks, Enter on a file link opens it; a file link opens with openFile and no confirmation', async () => {
    await onPage(async (p) => {
      await mount(p);
      const external = p.document.querySelector('[data-link="external"]');
      assert.equal(external.getAttribute('tabindex'), '0', 'the external link cannot take the keyboard');
      external.focus();
      p.keydown('Enter', { isComposing: true });
      await letItRun();
      assert.ok(!dialogOn(p), 'an Enter that ends an IME composition asked');
      p.keydown('Enter');
      await letItRun();
      assert.ok(dialogOn(p), 'Enter on the external link does not ask');
      p.keydown('Escape');
      await letItRun();

      const file = p.document.querySelector('[data-link="file"]');
      assert.ok(file && !file.hasAttribute('href') && file.getAttribute('tabindex') === '0', 'the file link is not a focusable link without href');
      const click = p.click(file);
      assert.ok(click.defaultPrevented, 'the file link\u{2019}s click is left to the webview');
      await letItRun();
      assert.deepEqual(filesOpened(), ['/w/docs/guide.md'], 'the file link did not open its file');
      assert.ok(!dialogOn(p), 'a file link asks');
      file.focus();
      p.keydown('Enter');
      await letItRun();
      assert.deepEqual(filesOpened(), ['/w/docs/guide.md', '/w/docs/guide.md'], 'Enter on the file link does not open it');
      assert.deepEqual(opened(), [], 'a file link opened an address');
    });
  });
});

describe('Markdown preview, mounted: the confirmation shows the whole origin (reviewer A, R3)', () => {
  beforeEach(fresh);

  test('MV-13: the reviewer\u{2019}s long-host probe is inert; a long path is cut in the confirmation after the whole origin; externalLinkLabel never cuts an origin', async () => {
    const probe = `https://accounts.google.com.${'signin-secure-session-verify.'.repeat(10)}evil.example/login`;
    const longPath = `https://example.com/${'docs/'.repeat(100)}end?q=1`;
    // A host of exactly 253 characters: three labels of 60, one of 57, then evil.example.
    const host253 = `${`${'h'.repeat(60)}.`.repeat(3)}${'h'.repeat(57)}.evil.example`;
    const bigOrigin = `https://${host253}`;
    assert.equal(new URL(bigOrigin).hostname.length, 253, 'setup: a host of 253');
    const text = `[probe](${probe}) [long](${longPath}) [big](${bigOrigin}/${'p'.repeat(400)})`;
    await onPage(async (p) => {
      await mount(p, markdownTab({ text }));
      const links = p.document.querySelectorAll('[data-link]');
      assert.deepEqual(links.map((link) => link.getAttribute('data-link')), ['inert', 'external', 'external'], 'the probe is a link');
      assert.equal(links[0].tagName, 'SPAN');
      p.click(links[0]);
      await letItRun();
      assert.ok(!dialogOn(p), 'the probe asks to open');

      for (const [link, origin] of [[links[1], 'https://example.com'], [links[2], bigOrigin]]) {
        p.click(link);
        await letItRun();
        const shown = dialogOn(p)?.querySelector('[data-confirm-address]')?.textContent ?? '';
        assert.ok(shown.startsWith(`${origin}/`), `the confirmation cuts the origin: ${shown}`);
        assert.ok(shown.endsWith('\u{2026}') && shown.length <= 300, `the path is not cut: ${shown.length}`);
        p.click(buttonIn(dialogOn(p), 'Cancel'));
        await letItRun();
      }
      assert.deepEqual(opened(), [], 'something was opened');
    });
    // The label itself, for an address no link would carry: the whole origin, never cut.
    const label = ui.externalLinkLabel(probe);
    assert.ok(label.startsWith(new URL(probe).origin) && label.includes('evil.example'), `the label cuts the origin: ${label}`);
    assert.ok(!ui.externalLinkLabel(longPath).slice(0, 20).includes('\u{2026}') && ui.externalLinkLabel(longPath).endsWith('\u{2026}'));
  });
});

describe('Markdown preview, mounted: anchors and inert links (AC-B3-9)', () => {
  beforeEach(fresh);

  test('MV-04: an anchor or footnote link scrolls its own preview\u{2019}s scroller to the id inside it — two previews of one file share ids — and navigates nowhere', async () => {
    await onPage(async (p) => {
      const escaped = [];
      const hadCss = Object.hasOwn(globalThis, 'CSS');
      const css = globalThis.CSS;
      globalThis.CSS = {
        escape: (value) => {
          escaped.push(value);
          return String(value);
        },
      };
      try {
        p.render(h(React.Fragment, null, h(ui.MarkdownPreview, { tab: markdownTab({ id: 'a' }) }), h(ui.MarkdownPreview, { tab: markdownTab({ id: 'b' }) })));
        await until(() => articlesOn(p).length === 2, 'both previews are drawn');
        const [first, second] = p.document.querySelectorAll('[data-markdown-scroller]');
        placeAt(first, 0);
        placeAt(second, 100);
        placeAt(first.querySelector('[id="md-install"]'), 777);
        placeAt(second.querySelector('[id="md-install"]'), 460);
        placeAt(second.querySelector('[id="user-content-fn-n"]'), 900);
        first.scrollTop = 0;
        second.scrollTop = 40;

        const anchor = second.querySelector('[data-link="anchor"]');
        assert.equal(anchor.getAttribute('href'), '#md-install', 'the anchor\u{2019}s href');
        const click = p.click(anchor);
        assert.ok(click.defaultPrevented, 'the anchor\u{2019}s click is left to navigate');
        assert.equal(second.scrollTop, 400, 'the preview did not scroll its heading to the top');
        assert.equal(first.scrollTop, 0, 'the other preview of the file scrolled');
        assert.deepEqual(escaped, ['md-install'], 'the id is not looked up through CSS.escape');

        const ref = second.querySelector('[data-footnote-ref]');
        assert.equal(ref.getAttribute('href'), '#user-content-fn-n', 'the footnote reference\u{2019}s href');
        assert.ok(p.click(ref).defaultPrevented, 'the footnote link\u{2019}s click is left to navigate');
        assert.equal(second.scrollTop, 1200, 'the footnote link did not scroll to its footnote');
        const aux = p.settled(() => dispatch(p.window, anchor, { type: 'auxclick', button: 1, detail: 1 }));
        assert.ok(aux.defaultPrevented, 'a middle click on an anchor is left to the webview');

        assert.deepEqual(p.document.scrolledIntoView, [], 'scrollIntoView moved the page as well');
        assert.deepEqual([filesOpened(), opened()], [[], []], 'an anchor opened something');
        assert.ok(!dialogOn(p), 'an anchor asks');
      } finally {
        if (hadCss) globalThis.CSS = css;
        else delete globalThis.CSS;
      }
    });
  });

  test('MV-05: an inert link is text: no href, no tab stop, and a click on it does nothing', async () => {
    await onPage(async (p) => {
      await mount(p);
      const inert = p.document.querySelector('[data-link="inert"]');
      assert.ok(inert, 'the inert link is drawn');
      assert.equal(inert.tagName, 'SPAN', 'an inert link is a link');
      assert.ok(!inert.hasAttribute('href') && !inert.hasAttribute('tabindex') && !inert.hasAttribute('role'), 'an inert link is focusable or has an href');
      const click = p.click(inert);
      await letItRun();
      assert.ok(!click.defaultPrevented, 'an inert link handles its click');
      assert.deepEqual([filesOpened(), opened()], [[], []], 'an inert link opened something');
      assert.ok(!dialogOn(p), 'an inert link asks');
      // No href in the document but #…
      const hrefs = p.document.querySelectorAll('[href]').map((a) => a.getAttribute('href'));
      assert.ok(hrefs.length === 3 && hrefs.every((href) => href.startsWith('#')), `hrefs: ${JSON.stringify(hrefs)}`);
    });
  });
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAF0lEQVR42mOQk9P737nl138QDcIMBAUANcIWVJdRDv4AAAAASUVORK5CYII=';
const LOCAL = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `/w/img/${name}.png`);
const IMAGES_DOC = [
  ...LOCAL.map((path, i) => `![local ${i}](img/${path.slice(7)})`),
  '![again](img/a.png)',
  '![remote](https://img.example/r.png) ![proto](//img.example/p.png) ![outside](../x.png) ![data](data:image/png;base64,AAAA)',
].join('\n\n');

describe('Markdown preview, mounted: images (F-B3-5)', () => {
  beforeEach(fresh);

  test('MV-06: only the document\u{2019}s local images are sized and read, through fs_file_size and fs_read_image, 4 at once; each is drawn from its data: URI, a failed read is a box, a remote image asks nothing', async () => {
    await onPage(async (p) => {
      ui.bridge.answer = async (command, args) => {
        await later(5);
        if (command === 'fs_file_size') return 80;
        if (command === 'fs_read_image') {
          if (args.path.endsWith('/f.png')) throw new Error(`File not found: ${args.path}`);
          return { mime: 'image/png', data: PNG, bytes: 80, width: 4, height: 3 };
        }
        throw new Error(`Unknown IPC command: ${command}`);
      };
      await mount(p, markdownTab({ text: IMAGES_DOC }));
      await until(() => !p.document.querySelector('[data-image-placeholder="loading"]'), 'every image is read');

      const commands = [...new Set(called('invoke').map(([command]) => command))].sort();
      assert.deepEqual(commands, ['fs_file_size', 'fs_read_image'], 'another backend command was asked');
      assert.deepEqual(invoked('fs_file_size').map((a) => a.path).sort(), LOCAL, 'the sizes asked');
      assert.deepEqual(invoked('fs_read_image').map((a) => a.path).sort(), LOCAL, 'the reads (a.png twice in the document, read once)');
      assert.ok(ui.bridge.most.fs_file_size <= 4 && ui.bridge.most.fs_read_image === 4, `in flight at once: ${JSON.stringify(ui.bridge.most)}`);
      const asked = JSON.stringify(called('invoke'));
      assert.ok(!/img\.example|x\.png|data:/.test(asked), `a remote, outside or data: image was asked for: ${asked}`);

      const imgs = p.document.querySelectorAll('img');
      assert.equal(imgs.length, 7, 'local images drawn (7 local, f.png failed, a.png twice)');
      assert.ok(imgs.every((img) => img.getAttribute('src') === `data:image/png;base64,${PNG}`), 'an image is drawn from something other than its data: URI');
      const boxes = p.document.querySelectorAll('[data-image-placeholder]').map((box) => box.getAttribute('data-image-placeholder'));
      assert.deepEqual(boxes, ['failed', 'remote', 'remote', 'outside', 'unsupported'], 'the image boxes');
      assert.ok(p.document.body.textContent.includes('https://img.example/r.png'), 'the remote image\u{2019}s box does not name its address');
    });
  });

  test('MV-07: when the preview goes, the reads still waiting are never started and the worker is stopped', async () => {
    await onPage(async (p) => {
      const waiting = [];
      ui.bridge.answer = (command) => {
        if (command === 'fs_file_size') return 80;
        return new Promise((resolve) => waiting.push(() => resolve({ mime: 'image/png', data: PNG, bytes: 80, width: 4, height: 3 })));
      };
      await mount(p, markdownTab({ text: IMAGES_DOC }));
      await until(() => waiting.length === 4, 'four reads in flight');
      p.unmount();
      for (const release of waiting) release();
      await letItRun(20);
      assert.equal(invoked('fs_read_image').length, 4, 'reads started after the preview went');
      assert.ok(ui.workers.length === 1 && ui.workers[0].terminated, 'the worker outlived its preview');
    });
  });
});

describe('Markdown preview, mounted: the renderer (AC-B3-5)', () => {
  beforeEach(fresh);

  test('MV-08: an answer to an older text, or one after the preview went, is dropped; the deleted line keeps the document; a file past the limit is never sent', async () => {
    await onPage(async (p) => {
      const held = [];
      ui.host.answer = (worker, data) => held.push([worker, data]);
      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '# First' }) }));
      await until(() => held.length === 1, 'the first text is sent');
      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '# Second' }) }));
      await letItRun();
      const [worker, first] = held[0];
      worker.reply(answerMarkdownRequest(first));
      await until(() => held.length === 2, 'the second text is sent once the first is answered');
      assert.ok(articlesOn(p).length === 0, 'the answer to the older text is drawn');
      worker.reply(answerMarkdownRequest(held[1][1]));
      await until(() => articlesOn(p).length === 1, 'the newer text is drawn');
      assert.equal(articlesOn(p)[0].textContent, 'Second', 'the wrong text is drawn');
      assert.equal(ui.workers.length, 1, 'more than one renderer for one preview');

      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '# Second', deleted: true }) }));
      await letItRun();
      assert.equal(articlesOn(p)[0]?.textContent, 'Second', 'the document went with its file');
      assert.equal(p.document.querySelector('[data-markdown-deleted]')?.textContent, 'Deleted on disk', 'the file is not said to be gone');
      assert.equal(ui.workers[0].posted.length, 2, 'the same text was sent again');

      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '# Third' }) }));
      await until(() => held.length === 3, 'the third text is sent');
      p.unmount();
      assert.ok(ui.workers[0].terminated, 'the worker outlived its preview');
      held[2][0].listeners.message?.forEach((fn) => fn({ data: answerMarkdownRequest(held[2][1]) }));
      await letItRun();
    });

    await onPage(async (p) => {
      ui.workers.length = 0;
      ui.calls.length = 0;
      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: null, bytes: 3 * 1024 * 1024, tooLarge: true }) }));
      await letItRun(20);
      assert.equal(ui.workers.length, 0, 'a file past the limit was sent to a worker');
      assert.equal(p.document.querySelector('[data-markdown-notice]')?.getAttribute('data-markdown-notice'), 'too-large', 'no too-large notice');
      p.click(buttonIn(p.document.body, 'Open as Text'));
      await letItRun();
      assert.deepEqual(filesOpened(), ['/w/README.md'], 'Open as Text did not open the source');
    });
  });

  test('MV-10: past the time limit the worker is stopped and "Too complex to preview" offers Open as Text; the next text gets a new worker; a worker error is said, cleaned', async () => {
    const realSetTimeout = globalThis.setTimeout;
    // The client's 5 s limit, fired at once; every other timer as it was.
    globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === MARKDOWN_PARSE_TIMEOUT_MS ? 1 : ms, ...rest);
    try {
      await onPage(async (p) => {
        ui.host.answer = () => {};
        p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '[a](\n'.repeat(10) }) }));
        await until(() => p.document.querySelector('[data-markdown-notice="too-complex"]'), 'the time limit is said');
        assert.equal(p.document.querySelector('[data-markdown-notice] p')?.textContent, 'Too complex to preview', 'the words');
        assert.ok(ui.workers[0].terminated, 'the worker was not stopped');
        p.click(buttonIn(p.document.body, 'Open as Text'));
        await letItRun();
        assert.deepEqual(filesOpened(), ['/w/README.md'], 'Open as Text did not open the source');

        ui.host.answer = (worker) => realSetTimeout(() => worker.emit('error', { message: 'boom\u{202e} \u{1b}[31mcrash\u{7}' }), 0);
        p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '# Next' }) }));
        await until(() => p.document.querySelector('[data-markdown-notice="error"]'), 'the error is said');
        assert.equal(ui.workers.length, 2, 'the next text did not get a new worker');
        assert.equal(p.document.querySelector('[data-markdown-notice] p')?.textContent, 'boom [31mcrash', 'the error is not shown cleaned');
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('MV-12: past the drawing cap — the worker\u{2019}s refusal, or an ok tree one element past it — "Too complex to preview" with Open as Text, nothing drawn and no image asked for', async () => {
    /** An ok answer of `n` paragraphs, each with a local image: `n` + `n` elements. */
    const answerOf = (n) => ({
      ok: true,
      hast: { type: 'root', children: Array.from({ length: n }, (_, i) => ({ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'element', tagName: 'img', properties: { alt: 'a', dataImage: 'load', dataImageIndex: i }, children: [] }] })) },
      images: Array.from({ length: n }, (_, i) => ({ kind: 'load', path: `/w/img/${i}.png`, address: `img/${i}.png` })),
    });
    await onPage(async (p) => {
      ui.bridge.answer = async () => 80;
      // The worker's own refusal.
      ui.host.answer = (worker, data) => worker.reply({ id: data.id, ok: false, error: { name: MARKDOWN_TOO_COMPLEX_ERROR, message: 'The Markdown makes more than 100000 elements to draw' } });
      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '*a*\n\n'.repeat(3) }) }));
      await until(() => p.document.querySelector('[data-markdown-notice]'), 'the refusal is said');
      assert.equal(p.document.querySelector('[data-markdown-notice]').getAttribute('data-markdown-notice'), 'too-complex', 'the refusal is not too-complex');
      assert.equal(p.document.querySelector('[data-markdown-notice] p')?.textContent, 'Too complex to preview');
      assert.equal(ui.workers[0].terminated, false, 'the worker was stopped for an answer');

      // An ok tree one element past the cap, as a worker that did not count would send it.
      ui.host.answer = (worker, data) => worker.reply({ id: data.id, ...answerOf(MARKDOWN_MAX_ELEMENTS / 2 + 1) });
      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: 'past the cap' }) }));
      await until(() => ui.workers[0].posted.length === 2, 'the second text is sent');
      await letItRun(20);
      assert.equal(p.document.querySelector('[data-markdown-notice]')?.getAttribute('data-markdown-notice'), 'too-complex', 'a tree past the cap is drawn');
      assert.equal(articlesOn(p).length, 0, 'a document is drawn');
      assert.equal(p.document.querySelectorAll('img').length + p.document.querySelectorAll('[data-image-placeholder]').length, 0, 'its images are drawn');
      assert.deepEqual(invoked('fs_file_size'), [], 'its images were asked for');
      p.click(buttonIn(p.document.body, 'Open as Text'));
      await letItRun();
      assert.deepEqual(filesOpened(), ['/w/README.md'], 'Open as Text did not open the source');

      // A small tree is drawn again.
      ui.host.answer = answerAsTheWorker;
      p.render(h(ui.MarkdownPreview, { tab: markdownTab({ text: '# Small again' }) }));
      await until(() => articlesOn(p).length === 1, 'the small document is drawn');
      assert.equal(articlesOn(p)[0].textContent, 'Small again');
    });
  });

  test('MV-11: nothing is said while a first render is quick; "Rendering preview…" once it has taken a second', async () => {
    await onPage(async (p) => {
      ui.host.answer = () => {};
      p.render(h(ui.MarkdownPreview, { tab: markdownTab() }));
      await letItRun(100);
      assert.ok(p.document.querySelector('[data-markdown-scroller]'), 'no frame while waiting');
      assert.ok(!p.document.querySelector('[data-markdown-rendering]'), '"Rendering preview…" flashed on a quick render');
      await letItRun(1000);
      assert.equal(p.document.querySelector('[data-markdown-rendering]')?.textContent, 'Rendering preview\u{2026}', 'a slow first render is not said');
    });
  });
});

describe('Markdown preview: no browser dialogs (AC-B3-9)', () => {
  test('MV-09: the preview and the pane use no window.confirm, confirm( or alert(; the confirmation is ConfirmDialog', () => {
    const forbidden = /\bwindow\s*\.\s*(?:confirm|alert|prompt)\b|(?<![\w$.])(?:confirm|alert|prompt)\s*\(/;
    for (const file of ['src/components/editor/MarkdownPreview.jsx', 'src/components/editor/EditorPane.jsx']) {
      const text = readFileSync(`${ROOT}${file}`, 'utf8');
      assert.ok(!forbidden.test(text), `${file}: ${forbidden.exec(text)?.[0]}`);
    }
    assert.ok(forbidden.test('if (window.confirm("x")) {}') && forbidden.test('alert(1)') && !forbidden.test('onConfirm(e)'), 'setup: the check');
    assert.match(readFileSync(`${ROOT}src/components/editor/MarkdownPreview.jsx`, 'utf8'), /import \{ ConfirmDialog \} from '\.\.\/common\/ConfirmDialog\.jsx';/);
  });
});
