/**
 * The image and Markdown previews (Orca bundle 5, B4 and B3, step P9) in a
 * real browser: the BUILT app in dist/, served from 127.0.0.1 by a static
 * server of this file's own, once with the production CSP of
 * src-tauri/tauri.conf.json (`app.security.csp`, verbatim) as a response
 * header on every file it serves, and once with no CSP at all. The browser
 * is the Chromium that agent-browser drives (headless_browser.js), the
 * engine WebView2 is built on; PH-01 prints its version.
 *
 * A listener on another 127.0.0.1 port counts every request that reaches
 * it. Every hostile input below points at it, so "no request" is a count of
 * zero on a server that, as the controls show, does get hit when something
 * is allowed to reach it. Besides the count, CDP reports every request the
 * page starts (Network), every JavaScript dialog (each one dismissed), every
 * main-frame navigation and every window a page tries to open (Page), and
 * every dedicated worker (Target auto-attach).
 *
 *   - PH-01 (setup, with the CSP): the app loads with `?debug`, and the CSP
 *     is in force: the page's own fetch to the listener is refused
 *     (connect-src) and never reaches it.
 *   - PH-02 (AC-B4-H2, with the CSP): a hostile SVG — <script>, onload=,
 *     <image href> and xlink:href, CSS @import and url(), <foreignObject>
 *     with an <iframe>, <use href>, an <a href="javascript:"> — opened as an
 *     image tab is drawn by ImagePreview as `<img src="data:image/svg+xml;
 *     base64,…">`, decodes (64 × 64), and, clicked and double-clicked, runs
 *     nothing, asks for nothing and goes nowhere. No <svg>, <object>,
 *     <embed> or <iframe> is in the image view.
 *   - PH-03 (AC-B3-H2, with the CSP): a hostile Markdown document — raw
 *     HTML (<script>, <img onerror>, <iframe>, <a href=javascript:>,
 *     <style>, <link>, <meta refresh>, <details>, a comment), javascript:
 *     in three spellings, data:, vbscript:, file:, mailto:, //host,
 *     a link out of the folder (../../), http links four ways (inline,
 *     autolink, reference, GFM literal), images remote, ../../, absolute,
 *     file: and data:, and a hostile SVG inside the folder — is drawn, every
 *     link and image in it is clicked with the real mouse (and the anchor
 *     and an external link with Shift, Cmd/Ctrl and the middle button), and
 *     nothing reaches the listener, no dialog opens, the page does not
 *     navigate and opens no window. Only the http links ask (five: GFM's
 *     literal autolink also takes the address out of an unquoted raw
 *     `<img src=http://…>`, which is a link that asks, never an image), in the
 *     app's own confirmation, showing their address; Cancel does nothing,
 *     and only Open hands the address over (window.open, which is
 *     openExternal's browser fallback, spied). The folder link opens its
 *     file in a text tab; the link out of the folder opens nothing.
 *   - PH-04 (OQ-B3g, with the CSP): the Markdown worker is the built
 *     /assets/markdownWorker-*.js from the page's own origin, and it
 *     answered (PH-03's document was drawn by it). A document of '[a]('
 *     repeated, which takes micromark far past 5 s, shows "Too complex to
 *     preview" with Open as Text after the 5 s limit, its worker is gone
 *     (terminated), and the window stays responsive meanwhile. An update
 *     from the disk (fs-change) starts a fresh worker, which draws it.
 *   - PH-05 (without the CSP): the controls first — the page's own fetch
 *     reaches the listener, and the same hostile SVG loaded as a document
 *     (an <iframe>, not an <img>) runs its script and loads its <image>, so
 *     the payload is live. Then PH-02's and PH-03's checks again, with
 *     nothing reaching the listener: the SVG-as-image rule and the Markdown
 *     rules hold without the CSP behind them.
 *   - PH-99: teardown; no exception thrown in either page and left uncaught.
 *
 * The hostile inputs are built here, with the listener's port in them; no
 * fixture file is committed. Files reach the app through its browser mock
 * (src/lib/ipc.js), as in every other browser suite.
 *
 * What this cannot show, left to the human checks (README "Human checks",
 * WINDOWS_VERIFICATION.md V75; AC-B4-H1..H3, AC-B3-H1..H2): WKWebView
 * (macOS) and WebKitGTK (Linux) at all; WebView2 itself, its
 * `http://tauri.localhost` origin and the nonces and hashes Tauri adds to
 * the CSP at run time; the real backend (fs_read_image, confinement,
 * backslash paths, junctions); the system browser opening a link.
 *
 * Needs a build in dist/ (`npm run build`, which the gate runs before the
 * suites; a dist/ older than the sources tests the older code), agent-
 * browser, and a Node with a global WebSocket: skipped without any of them,
 * saying which.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');
const NOT_INSTALLED = 'agent-browser is not installed — the preview checks in a real browser run locally only';
const NO_WEBSOCKET = 'this Node has no global WebSocket (Node 22 and later have one), which the CDP session needs';
const NO_BUILD = 'there is no build in dist/ to serve — run `npm run build` first (the gate does)';
const NO_HARNESS = 'the harness did not start: see PH-01 / PH-05';

const PRODUCTION_CSP = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).app.security.csp;
const DIR = '/workspace/hostile';
const DOC = `${DIR}/doc.md`;
const OTHER = `${DIR}/other.md`;
const SVG_PATH = `${DIR}/hostile.svg`;
const COMPLEX = `${DIR}/complex.md`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * The static server, as a child process of its own: openHarness drives
 * agent-browser with execFileSync, which blocks this process's event loop,
 * so a server living here could not answer the page it waits for (found
 * here: `agent-browser open` hung until its timeout). It serves dist/ as the
 * app's own origin, every response carrying PH_CSP when it is set, and
 * prints each path asked for.
 */
const SERVER_SOURCE = `
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
const DIST = process.env.PH_DIST;
const CSP = process.env.PH_CSP || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  process.stdout.write('served ' + url.pathname + '\\n');
  const file = path.join(DIST, url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname));
  const headers = CSP ? { 'Content-Security-Policy': CSP } : {};
  if (!file.startsWith(DIST + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
}).listen(Number(process.env.PH_PORT), '127.0.0.1');
`;

/** `serve` for openHarness: dist/ on 127.0.0.1:port, with `csp` on every response when given; `served` gets each path. */
function serveDist(csp, served) {
  return async (port) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', SERVER_SOURCE], {
      env: { ...process.env, PH_DIST: DIST, PH_PORT: String(port), PH_CSP: csp ?? '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let rest = '';
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) if (line.startsWith('served ')) served.push(line.slice(7));
    });
    return () => child.kill();
  };
}

/** The listener every hostile input points at: it counts what reaches it. */
const hits = [];
let listener = null;
let LISTEN = '';
function startListener() {
  return new Promise((resolve, reject) => {
    listener = http.createServer((req, res) => {
      hits.push(req.url);
      // A 1 × 1 GIF for anything, so an image that is let through loads.
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Access-Control-Allow-Origin': '*' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    });
    listener.on('error', reject);
    listener.unref();
    listener.listen(0, '127.0.0.1', () => {
      LISTEN = `http://127.0.0.1:${listener.address().port}`;
      resolve();
    });
  });
}

/** The hostile SVG: every way an SVG document can run script, load or go somewhere. */
const hostileSvg = () =>
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64" viewBox="0 0 64 64"'
  + ` onload="fetch('${LISTEN}/svg-onload')">`
  + `<script>fetch('${LISTEN}/svg-script'); new Image().src = '${LISTEN}/svg-script-img'; alert(1);</script>`
  + `<style>@import url(${LISTEN}/svg-style-import); .p { fill: url(${LISTEN}/svg-style-fill#p); }</style>`
  + '<rect width="64" height="64" fill="#1e1e2e"/>'
  + `<image href="${LISTEN}/svg-image" width="8" height="8"/>`
  + `<image xlink:href="${LISTEN}/svg-image-xlink" x="8" width="8" height="8"/>`
  + `<use href="${LISTEN}/svg-use#x"/>`
  + `<foreignObject width="16" height="16" y="16"><iframe xmlns="http://www.w3.org/1999/xhtml" src="${LISTEN}/svg-foreign"></iframe></foreignObject>`
  + `<a href="javascript:fetch('${LISTEN}/svg-a')"><rect class="p" x="24" y="24" width="32" height="32" fill="#89b4fa"/></a>`
  + '</svg>\n';

/** The hostile Markdown document (AC-B3-H2), with the listener in every address. */
const hostileMarkdown = () => [
  '# Hostile document',
  '',
  `<script>fetch('${LISTEN}/raw-script')</script>`,
  '',
  `<img src="${LISTEN}/raw-img" onerror="fetch('${LISTEN}/raw-onerror')">`,
  '',
  `<iframe src="${LISTEN}/raw-iframe"></iframe>`,
  '',
  `<a href="javascript:fetch('${LISTEN}/raw-a')">raw anchor</a>`,
  '',
  `<style>body { background: url(${LISTEN}/raw-style); }</style>`,
  '',
  `<link rel="stylesheet" href="${LISTEN}/raw-link">`,
  '',
  `<meta http-equiv="refresh" content="0;url=${LISTEN}/raw-meta">`,
  '',
  '<details open><summary>raw details</summary>inside</details>',
  '',
  '<!-- a raw comment -->',
  '',
  `Inline raw: <img src=${LISTEN}/raw-inline-img> and <b onclick="fetch('${LISTEN}/raw-b')">bold</b>.`,
  '',
  `- [javascript link](javascript:fetch('${LISTEN}/md-js'))`,
  `- [mixed case](JaVaScRiPt:fetch('${LISTEN}/md-js-case'))`,
  `- [entity](&#106;avascript:fetch('${LISTEN}/md-js-entity'))`,
  '- [data link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '- [vbscript link](vbscript:msgbox(1))',
  '- [file link](file:///etc/passwd)',
  '- [mailto link](mailto:someone@example.invalid)',
  `- [protocol relative](//127.0.0.1:${new URL(LISTEN).port}/md-protocol-relative)`,
  '- [outside the folder](../../outside.md)',
  '- [inside the folder](./other.md)',
  '- [anchor](#hostile-document)',
  `- [external](${LISTEN}/md-external)`,
  `- autolink <${LISTEN}/md-autolink>`,
  '- [reference][ref]',
  `- literal ${LISTEN}/md-literal`,
  '',
  `[ref]: ${LISTEN}/md-reference`,
  '',
  `![remote](${LISTEN}/md-remote-img)`,
  '![escapes](../../escape.png)',
  '![absolute](/etc/escape.png)',
  '![file scheme](file:///etc/escape.png)',
  '![data scheme](data:image/svg+xml;base64,PHN2Zy8+)',
  '![local hostile svg](./hostile.svg)',
  '',
].join('\n');

// The fifth is GFM's literal autolink taking `http://…` out of the unquoted
// `<img src=http://…>` (with its `>`): a link that asks, never an image.
const EXTERNAL_PATHS = ['/md-external', '/md-autolink', '/md-reference', '/md-literal', '/raw-inline-img%3E'];

/** One app in one browser, with everything this suite records about it. */
function makeRun() {
  return { harness: null, served: [], network: [], dialogs: [], navigations: [], windows: [], workers: [], gone: [], origin: '' };
}
const csp = makeRun();
const bare = makeRun();
let skipReason = null;

async function openRun(run, policy, prefix) {
  if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
  if (typeof WebSocket === 'undefined') skip(NO_WEBSOCKET);
  if (!existsSync(path.join(DIST, 'index.html'))) skip(NO_BUILD);
  if (!listener) await startListener();
  try {
    run.harness = await openHarness('?debug', {
      prefix,
      readyExpression: 'window.__nexterm?.useTerminalStore?.getState().isInitialized === true',
      serve: serveDist(policy, run.served),
    });
  } catch (err) {
    if (err instanceof BrowserUnavailable) skip(`agent-browser could not start (${err.message})`);
    throw err;
  }
  const h = run.harness;
  run.origin = await h.evalJs('location.origin');
  h.onEvent('Network.requestWillBeSent', (p) => run.network.push(p.request.url));
  h.onEvent('Page.javascriptDialogOpening', (p) => {
    run.dialogs.push(`${p.type}: ${p.message}`);
    h.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
  });
  h.onEvent('Page.frameNavigated', (p) => {
    if (!p.frame.parentId) run.navigations.push(p.frame.url);
  });
  h.onEvent('Page.frameRequestedNavigation', (p) => run.navigations.push(`requested: ${p.url}`));
  h.onEvent('Page.windowOpen', (p) => run.windows.push(p.url));
  h.onEvent('Target.attachedToTarget', (p) => {
    if (p.targetInfo.type === 'worker') run.workers.push({ id: p.sessionId, url: p.targetInfo.url });
  });
  // Named by its session: the event's targetId is deprecated, and not always sent.
  h.onEvent('Target.detachedFromTarget', (p) => run.gone.push(p.sessionId));
  await h.send('Page.enable');
  await h.send('Network.enable');
  await h.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await h.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  // openExternal's browser fallback is window.open: recorded here, never opened.
  await h.evalJs(`(() => {
    window.__ph = { opened: [], invoked: [] };
    window.open = (url) => { window.__ph.opened.push(String(url)); return null; };
    const mb = window.__nexterm.mockBridge;
    const invoke = mb.invoke;
    mb.invoke = function (command, ...rest) { window.__ph.invoked.push(command); return invoke.call(this, command, ...rest); };
    mb.directories.add(${JSON.stringify(DIR)});
    mb.files.set(${JSON.stringify(DOC)}, ${JSON.stringify(hostileMarkdown())});
    mb.files.set(${JSON.stringify(OTHER)}, '# Other\\n');
    mb.files.set(${JSON.stringify(SVG_PATH)}, ${JSON.stringify(hostileSvg())});
    mb.files.set('/outside.md', '# Outside\\n');
    return true;
  })()`);
}

/** Requests the page started that are neither its own origin nor data:/blob:. */
const offOrigin = (run) => run.network.filter((u) => !u.startsWith(`${run.origin}/`) && !/^(data|blob):/.test(u));

async function waitFor(run, expression, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await run.harness.evalJs(expression)) === true) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

const mouse = (run, type, x, y, extra = {}) =>
  run.harness.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', pointerType: 'mouse', ...extra });
/** A real click at (x, y): `button` left or middle, `modifiers` the CDP bit mask (Alt 1, Ctrl 2, Meta 4, Shift 8). */
async function clickAt(run, x, y, { button = 'left', modifiers = 0, clickCount = 1 } = {}) {
  const buttons = button === 'middle' ? 4 : 1;
  await mouse(run, 'mouseMoved', x, y, { modifiers });
  await mouse(run, 'mousePressed', x, y, { button, buttons, clickCount, modifiers });
  await mouse(run, 'mouseReleased', x, y, { button, buttons: 0, clickCount, modifiers });
}
/** The centre of the first box of the element marked `data-ph="<n>"`, scrolled into view. */
async function centreOf(run, n) {
  return JSON.parse(
    await run.harness.evalJs(`(() => {
      const el = document.querySelector('[data-ph="${n}"]');
      if (!el) return 'null';
      el.scrollIntoView({ block: 'center' });
      const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + Math.min(r.width / 2, 20)), y: Math.round(r.top + r.height / 2) });
    })()`)
  );
}
const dialogShown = (run) => run.harness.evalJs(`document.querySelector('[role="alertdialog"]') ? document.querySelector('[data-confirm-address]')?.textContent ?? '' : null`);
async function pressDialogButton(run, label) {
  const box = JSON.parse(
    await run.harness.evalJs(`(() => {
      const b = [...document.querySelectorAll('[role="alertdialog"] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return 'null';
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`)
  );
  assert.ok(box, `the confirmation has no ${label} button`);
  await clickAt(run, box.x, box.y);
  await waitFor(run, `!document.querySelector('[role="alertdialog"]')`, `the confirmation to close on ${label}`, 3000);
}

/** Nothing reached the listener, nothing went off the origin, no dialog, no navigation, no window. */
async function assertNothingLeft(run, what) {
  await sleep(1200);
  assert.deepEqual(hits, [], `${what}: requests reached the listener`);
  assert.deepEqual(offOrigin(run), [], `${what}: the page asked for addresses off its own origin`);
  assert.deepEqual(run.dialogs, [], `${what}: a JavaScript dialog opened`);
  assert.deepEqual(run.navigations, [], `${what}: the page navigated`);
  assert.deepEqual(run.windows, [], `${what}: the page tried to open a window`);
  assert.equal(await run.harness.evalJs('location.href'), `${run.origin}/?debug`, `${what}: the page is no longer where it was`);
}

/** PH-02 / PH-05: the hostile SVG as an image tab. */
async function hostileSvgAsImageTab(run, what) {
  const h = run.harness;
  hits.length = 0;
  run.network.length = 0;
  await h.evalJs(`window.__nexterm.useEditorStore.getState().openFile(${JSON.stringify(SVG_PATH)}).then(() => true)`);
  await waitFor(
    run,
    `(() => { const img = document.querySelector('[data-image-preview] img'); return !!img && img.src.startsWith('data:image/svg+xml;base64,') && img.complete && img.naturalWidth > 0; })()`,
    'the SVG drawn as an <img> from a data: URI'
  );
  const drawn = JSON.parse(
    await h.evalJs(`(() => {
      const view = document.querySelector('[data-image-preview]');
      const img = view.querySelector('img');
      const r = img.getBoundingClientRect();
      return JSON.stringify({
        natural: [img.naturalWidth, img.naturalHeight],
        imgs: view.querySelectorAll('img').length,
        live: view.querySelectorAll('svg, object, embed, iframe').length,
        anywhere: document.querySelectorAll('object, embed, iframe').length,
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      });
    })()`)
  );
  assert.deepEqual(drawn.natural, [64, 64], `${what}: the SVG did not decode as a 64 × 64 image`);
  assert.equal(drawn.imgs, 1, `${what}: the image view draws one <img>`);
  assert.equal(drawn.live, 0, `${what}: the image view holds <svg>, <object>, <embed> or <iframe>`);
  assert.equal(drawn.anywhere, 0, `${what}: an <object>, <embed> or <iframe> is in the page`);
  // The <a href="javascript:"> is in the middle of the picture.
  await clickAt(run, drawn.x, drawn.y);
  await sleep(100);
  await clickAt(run, drawn.x, drawn.y, { clickCount: 2 });
  await clickAt(run, drawn.x, drawn.y, { button: 'middle' });
  await assertNothingLeft(run, what);
}

/** PH-03 / PH-05: the hostile Markdown preview, every link and image clicked. */
async function hostileMarkdownClicked(run, what) {
  const h = run.harness;
  hits.length = 0;
  run.network.length = 0;
  await h.evalJs(`window.__nexterm.useEditorStore.getState().openMarkdownPreview(${JSON.stringify(DOC)}).then(() => true)`);
  await waitFor(run, `!!document.querySelector('[data-markdown-preview] article.markdown-preview h1')`, 'the hostile document drawn');
  await waitFor(
    run,
    `(() => { const img = document.querySelector('article.markdown-preview img[data-image="load"]'); return !!img && img.src.startsWith('data:image/svg+xml;base64,') && img.complete && img.naturalWidth > 0; })()`,
    'the local SVG inlined as a data: URI'
  );
  const shape = JSON.parse(
    await h.evalJs(`(() => {
      const doc = document.querySelector('article.markdown-preview');
      const marked = [...doc.querySelectorAll('a, [data-link], [role="link"], img, [data-image-placeholder]')];
      marked.forEach((el, i) => el.setAttribute('data-ph', String(i)));
      return JSON.stringify({
        count: marked.length,
        live: doc.querySelectorAll('script, iframe, object, embed, style, link, meta, details, svg, form, input:not([type="checkbox"])').length,
        hrefs: [...doc.querySelectorAll('[href]')].map((el) => el.getAttribute('href')),
        srcs: [...doc.querySelectorAll('[src]')].map((el) => el.getAttribute('src').slice(0, 26)),
        raw: doc.querySelectorAll('.md-raw-html').length,
        placeholders: [...doc.querySelectorAll('[data-image-placeholder]')].map((el) => el.getAttribute('data-image-placeholder')),
        links: [...doc.querySelectorAll('[data-link]')].map((el) => el.getAttribute('data-link')),
        anchors: doc.querySelectorAll('a:not([data-link])').length,
        text: doc.textContent.includes('fetch('),
      });
    })()`)
  );
  assert.equal(shape.live, 0, `${what}: raw HTML became elements`);
  assert.ok(shape.raw >= 10, `${what}: the raw HTML is not shown as text (${shape.raw})`);
  assert.ok(shape.text, `${what}: the raw HTML's text is not shown`);
  assert.ok(shape.hrefs.every((href) => href.startsWith('#')), `${what}: an href other than #…: ${JSON.stringify(shape.hrefs)}`);
  assert.ok(shape.srcs.every((src) => src.startsWith('data:image/svg+xml;base64,')), `${what}: an image source other than the inlined SVG: ${JSON.stringify(shape.srcs)}`);
  assert.equal(shape.placeholders.length, 5, `${what}: five images are placeholders: ${JSON.stringify(shape.placeholders)}`);
  const kinds = shape.links.reduce((acc, kind) => ({ ...acc, [kind]: (acc[kind] ?? 0) + 1 }), {});
  // javascript: three ways, data:, vbscript:, file:, mailto:, //host and ../../ are inert.
  assert.deepEqual(kinds, { inert: 9, file: 1, anchor: 1, external: EXTERNAL_PATHS.length }, `${what}: the links are not classified as expected`);
  assert.equal(shape.anchors, 0, `${what}: an <a> without a link class`);

  const asked = [];
  for (let n = 0; n < shape.count; n += 1) {
    const at = await centreOf(run, n);
    if (!at) continue;
    const isFile = await h.evalJs(`document.querySelector('[data-ph="${n}"]').getAttribute('data-link') === 'file'`);
    if (isFile) continue; // last: it opens a text tab, which may take the preview's place
    await clickAt(run, at.x, at.y);
    await sleep(150);
    const address = await dialogShown(run);
    if (address !== null) {
      asked.push(address);
      await pressDialogButton(run, 'Cancel');
    }
  }
  assert.deepEqual(
    asked.slice().sort(),
    EXTERNAL_PATHS.map((p) => `${LISTEN}${p}`).sort(),
    `${what}: the confirmation asked for other links than the http ones`
  );
  assert.deepEqual(await h.evalJs('window.__ph.opened'), [], `${what}: Cancel handed an address over`);

  // The anchor and an external link with Shift, Cmd/Ctrl and the middle button.
  const special = JSON.parse(
    await h.evalJs(`JSON.stringify({
      anchor: document.querySelector('article.markdown-preview a[data-link="anchor"]')?.getAttribute('data-ph') ?? null,
      external: document.querySelector('article.markdown-preview [data-link="external"]')?.getAttribute('data-ph') ?? null,
      file: document.querySelector('article.markdown-preview [data-link="file"]')?.getAttribute('data-ph') ?? null,
    })`)
  );
  assert.ok(special.anchor && special.external && special.file, `${what}: the anchor, external or file link is missing`);
  for (const n of [special.anchor, special.external]) {
    for (const opts of [{ modifiers: 8 }, { modifiers: 4 }, { modifiers: 2 }, { button: 'middle' }]) {
      const at = await centreOf(run, n);
      await clickAt(run, at.x, at.y, opts);
      await sleep(120);
      if ((await dialogShown(run)) !== null) await pressDialogButton(run, 'Cancel');
    }
  }

  // Open, and only Open, hands the address over — the cleaned one.
  const ext = await centreOf(run, special.external);
  await clickAt(run, ext.x, ext.y);
  await waitFor(run, `!!document.querySelector('[role="alertdialog"]')`, 'the confirmation', 3000);
  await pressDialogButton(run, 'Open');
  const opened = await h.evalJs('window.__ph.opened');
  assert.equal(opened.length, 1, `${what}: Open handed over ${JSON.stringify(opened)}`);
  assert.ok(EXTERNAL_PATHS.some((p) => opened[0] === `${LISTEN}${p}`), `${what}: Open handed over ${opened[0]}`);

  // Last, the folder link: its file opens in a text tab; nothing outside does.
  const file = await centreOf(run, special.file);
  await clickAt(run, file.x, file.y);
  await waitFor(
    run,
    `window.__nexterm.useEditorStore.getState().tabs.some((t) => t.filePath === ${JSON.stringify(OTHER)} && !t.kind)`,
    'the folder link to open its file in a text tab',
    5000
  );
  const tabs = await h.evalJs(`window.__nexterm.useEditorStore.getState().tabs.map((t) => (t.kind ?? 'text') + ' ' + t.filePath)`);
  assert.ok(!tabs.some((t) => t.endsWith('/outside.md') || t.includes('escape')), `${what}: a file outside the folder opened: ${JSON.stringify(tabs)}`);
  const invoked = await h.evalJs('window.__ph.invoked');
  assert.ok(!invoked.includes('plugin:opener|open_url'), `${what}: the backend's opener was asked`);
  await assertNothingLeft(run, what);
}

describe('Image and Markdown previews in a real browser, the built app (Orca bundle 5, P9)', () => {
  test('PH-01: setup — the built app under the production CSP, and the CSP in force', async () => {
    try {
      await openRun(csp, PRODUCTION_CSP, 'preview-headless-csp');
    } catch (err) {
      // A skip (no browser, no build) is said again by every case after this one.
      if (err?.constructor?.name === 'SkippedTest') skipReason = err.message;
      throw err;
    }
    const engine = await csp.harness.evalJs('navigator.userAgent');
    console.log(`    browser: ${engine}`);
    assert.ok(/Chrome\/\d+/.test(engine), `not a Chromium: ${engine}`);
    hits.length = 0;
    const refused = await csp.harness.evalJs(`(async () => {
      let violated = null;
      document.addEventListener('securitypolicyviolation', (e) => { violated = e.effectiveDirective; }, { once: true });
      try { await fetch(${JSON.stringify(`${LISTEN}/csp-probe`)}, { mode: 'no-cors' }); return 'fetched'; }
      catch { await new Promise((r) => setTimeout(r, 100)); return 'refused ' + violated; }
    })()`);
    assert.equal(refused, 'refused connect-src', 'the production CSP is not in force');
    await sleep(300);
    assert.deepEqual(hits, [], 'the CSP probe reached the listener');
    csp.network.length = 0;
  });

  test('PH-02: a hostile SVG in an image tab runs nothing, asks for nothing, goes nowhere (AC-B4-H2, with the CSP)', async () => {
    if (!csp.harness) skip(skipReason ?? NO_HARNESS);
    await hostileSvgAsImageTab(csp, 'with the CSP');
  });

  test('PH-03: a hostile Markdown preview, every link and image clicked, makes no request and no navigation (AC-B3-H2, with the CSP)', async () => {
    if (!csp.harness) skip(skipReason ?? NO_HARNESS);
    await hostileMarkdownClicked(csp, 'with the CSP');
  });

  test('PH-04: the built Markdown worker loads from the page\u{2019}s origin under the CSP, answers, and is stopped after 5 s on a hostile parse (OQ-B3g)', async () => {
    if (!csp.harness) skip(skipReason ?? NO_HARNESS);
    const h = csp.harness;
    const built = readdirSync(path.join(DIST, 'assets')).filter((n) => /^markdownWorker-[^.]+\.js$/.test(n));
    assert.equal(built.length, 1, `dist/assets holds one markdownWorker-*.js: ${JSON.stringify(built)}`);
    const md = csp.workers.filter((w) => /markdownWorker/.test(w.url));
    assert.ok(md.length >= 1, `no Markdown worker was started: ${JSON.stringify(csp.workers)}`);
    for (const w of md) assert.equal(w.url, `${csp.origin}/assets/${built[0]}`, 'the worker is not the built file from the page\u{2019}s own origin');
    assert.ok(csp.served.includes(`/assets/${built[0]}`), 'the worker file was not served (with the CSP header) by the app\u{2019}s origin');

    // '[a](' repeated: micromark takes far past 5 s on it (decision-OQ-B3g.md).
    const before = csp.workers.length;
    await h.evalJs(`(() => { window.__nexterm.mockBridge.files.set(${JSON.stringify(COMPLEX)}, '[a]('.repeat(300000)); return true; })()`);
    const started = Date.now();
    await h.evalJs(`window.__nexterm.useEditorStore.getState().openMarkdownPreview(${JSON.stringify(COMPLEX)}).then(() => true)`);
    let slowest = 0;
    let notice = false;
    while (Date.now() - started < 20000) {
      const t0 = Date.now();
      notice = await h.evalJs(`!!document.querySelector('[data-markdown-notice="too-complex"]')`);
      slowest = Math.max(slowest, Date.now() - t0);
      if (notice) break;
      await sleep(200);
    }
    const elapsed = Date.now() - started;
    assert.ok(notice, 'no "Too complex to preview" within 20 s');
    assert.ok(elapsed >= 4500, `the notice came after ${elapsed} ms, before the 5 s limit`);
    assert.ok(slowest < 1000, `the window answered slowly while the worker parsed (${slowest} ms)`);
    const words = await h.evalJs(`document.querySelector('[data-markdown-notice="too-complex"]').textContent`);
    assert.ok(words.includes('Too complex to preview') && words.includes('Open as Text'), `the notice says ${words}`);
    const hostileWorker = csp.workers.slice(before).find((w) => /markdownWorker/.test(w.url));
    assert.ok(hostileWorker, 'the complex document got no worker of its own');
    for (let i = 0; i < 50 && !csp.gone.includes(hostileWorker.id); i += 1) await sleep(100);
    assert.ok(csp.gone.includes(hostileWorker.id), `the worker that ran past the limit is still there (not terminated): ${JSON.stringify({ workers: csp.workers, gone: csp.gone })}`);

    // A later update (the disk changed) starts a fresh worker, which draws it.
    const afterLimit = csp.workers.length;
    await h.evalJs(`(async () => {
      const mb = window.__nexterm.mockBridge;
      mb.files.set(${JSON.stringify(COMPLEX)}, '# Fresh after the limit\\n');
      await mb.emit('fs-change', { path: ${JSON.stringify(COMPLEX)}, kind: 'modify' });
      return true;
    })()`);
    await waitFor(csp, `[...document.querySelectorAll('article.markdown-preview h1')].some((h) => h.textContent === 'Fresh after the limit')`, 'the fresh worker to draw the update', 8000);
    assert.ok(csp.workers.slice(afterLimit).some((w) => /markdownWorker/.test(w.url) && !csp.gone.includes(w.id)), 'the update was not parsed by a fresh worker');
    assert.deepEqual(hits, [], 'requests reached the listener');
  });

  test('PH-05: without any CSP — the controls reach the listener, and the image and Markdown rules still let nothing out', async () => {
    if (!csp.harness) skip(skipReason ?? NO_HARNESS);
    csp.harness.teardown();
    await openRun(bare, null, 'preview-headless-bare');
    const h = bare.harness;
    // Control 1: the listener does count what reaches it.
    hits.length = 0;
    await h.evalJs(`fetch(${JSON.stringify(`${LISTEN}/control-fetch`)}, { mode: 'no-cors' }).then(() => true, () => false)`);
    await sleep(300);
    assert.deepEqual(hits, ['/control-fetch'], 'the control fetch did not reach the listener: the page has a CSP after all');
    // Control 2: the same SVG as a document (not an image) runs its script and loads its <image>.
    hits.length = 0;
    await h.evalJs(`(() => {
      const frame = document.createElement('iframe');
      frame.id = 'ph-control';
      frame.src = 'data:image/svg+xml;base64,' + btoa(${JSON.stringify(hostileSvg())});
      document.body.appendChild(frame);
      return true;
    })()`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(hits.includes('/svg-script') && hits.includes('/svg-image'))) await sleep(100);
    assert.ok(hits.includes('/svg-script'), `the control SVG document ran no script: ${JSON.stringify(hits)}`);
    assert.ok(hits.includes('/svg-image'), `the control SVG document loaded no <image>: ${JSON.stringify(hits)}`);
    await h.evalJs(`(document.getElementById('ph-control').remove(), true)`);
    await sleep(1000);
    hits.length = 0;
    bare.network.length = 0;
    bare.dialogs.length = 0;
    bare.navigations.length = 0;
    bare.windows.length = 0;

    await hostileSvgAsImageTab(bare, 'without the CSP');
    await hostileMarkdownClicked(bare, 'without the CSP');
  });

  test('PH-99: teardown — no exception left uncaught in either page', async () => {
    if (!csp.harness && !bare.harness) skip(skipReason ?? NO_HARNESS);
    const errors = [...(csp.harness?.pageErrors() ?? []), ...(bare.harness?.pageErrors() ?? [])];
    csp.harness?.teardown();
    bare.harness?.teardown();
    listener?.close();
    assert.deepEqual(errors, [], 'the pages threw and nobody caught it');
  });
});
