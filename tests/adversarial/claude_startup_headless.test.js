/**
 * Claude Code 2.1.319 starting in a NexTerm terminal, replayed from a
 * recording made in the macOS app (NexTerm 0.25.0): every chunk claude wrote,
 * in order, with its time (tests/adversarial/fixtures/claude-2.1.319-startup.json,
 * visible text replaced by placeholders, every control sequence as recorded).
 *
 * In the app the screen froze: NexTerm answered claude's first batch of
 * queries (focus in, XTVERSION, DA1) and nothing after it — not the DECRQM
 * 2026 and DA1 of the second batch, not the full-screen UI.
 *
 * Two halves, each claude's whole start-up and the queries it asks answered:
 *
 *   - CS-01…CS-03 — the parser alone: real @xterm/headless with every parser
 *     handler getOrCreateTerminal installs. Runs everywhere.
 *   - CS-10…CS-14 — the page: tests/adversarial/fixtures/claude_startup_harness.html
 *     mounts the app's own TerminalView in headless Chromium (real xterm 6,
 *     WebGL, focus, the store's writeRaw) and delivers the recording through
 *     ptyOutputBus.deliver, batched as the backend batches it and chunk by
 *     chunk. Needs agent-browser; skipped without it.
 *
 * Neither replay reproduces the freeze: both run xterm as it is published.
 * The app froze on xterm as `npm run build` bundles it — the first DECRQM
 * (`CSI ? 2026 $ p`, chunk #8) threw a ReferenceError inside xterm's write
 * loop (vite.config.js says why), found by running the release-style build in
 * the app. CS-04 builds xterm that way and asks it. These hold every stage to
 * answering claude's start-up.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Static imports on purpose: other files in this runner register module
// hooks that turn `@xterm/*` into test doubles, and a static import is
// resolved before any of them.
import headless from '@xterm/headless';
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';
import { activateGraphemeWidths, installXtVersionReply } from '../../src/lib/terminalCompat.js';
import { installModifyOtherKeys } from '../../src/lib/modifyOtherKeys.js';
import { installFocusReports } from '../../src/lib/focusReport.js';
import { installProgramNotifications } from '../../src/lib/programNotifications.js';
import { installTerminalProgress } from '../../src/lib/terminalProgress.js';
import { watchScrollbackChanges } from '../../src/lib/scrollbackWatch.js';
import { trackCommandMarks } from '../../src/lib/stickyCommand.js';
import { trackDirectories } from '../../src/lib/outputContext.js';
import { installMouseReporting } from '../../src/lib/mouseReporting.js';

const { Terminal: HeadlessTerminal } = headless;
const recording = JSON.parse(readFileSync(new URL('./fixtures/claude-2.1.319-startup.json', import.meta.url), 'utf8'));

// The size claude drew for (see the harness).
const COLS = 169;
const ROWS = 46;

const FOCUS_IN = '\x1b[I';
const XTVERSION = '\x1bP>|xterm.js(6.0.0)\x1b\\';
const DA1 = '\x1b[?1;2c';
const DECRQM_2026 = '\x1b[?2026;2$y';
const DECRQM_1016 = '\x1b[?1016;2$y';

/**
 * What a terminal answers each recorded chunk with, by its index in the
 * recording: the first batch (#2 – #4, answered in the app), the second
 * (#8 – #10, never answered there) and the third (#18). Focus reports only
 * where the terminal has the focus — not in Node.
 */
const ANSWERS = {
  2: [FOCUS_IN],
  3: [XTVERSION],
  4: [DA1],
  8: [DECRQM_2026],
  10: [DECRQM_1016, DA1],
  12: [FOCUS_IN],
  18: [XTVERSION, DA1],
};
const answersWithout = (drop) =>
  Object.fromEntries(
    Object.entries(ANSWERS)
      .map(([index, replies]) => [index, replies.filter((reply) => !drop.includes(reply))])
      .filter(([, replies]) => replies.length > 0)
  );
const ALL_ANSWERS = Object.values(ANSWERS).flat();

/** A reply as the page reports it: JSON-escaped, without the quotes. */
const esc = (s) => JSON.stringify(s).slice(1, -1);
const count = (list, item) => list.filter((x) => x === item).length;

/** The output chunks as the backend hands them on: whole characters (a character cut by a read waits for the rest). */
function outputChunks() {
  const decoder = new TextDecoder('utf-8');
  return recording.chunks
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.dir === 'o')
    .map((c) => ({ index: c.index, text: decoder.decode(Buffer.from(c.b64, 'base64'), { stream: true }) }));
}

/** `@xterm/addon-unicode-graphemes` as the WebView runs it — see unicode_widths.test.js. */
function loadGraphemesAddonAsInBrowser() {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('@xterm/addon-unicode-graphemes'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'Buffer', source)(mod, mod.exports, undefined);
  return mod.exports;
}

/** A headless terminal with the parser handlers getOrCreateTerminal installs, and what it answers. */
function nextermParser() {
  const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  const replies = [];
  term.onData((data) => replies.push(data));
  activateGraphemeWidths(term, loadGraphemesAddonAsInBrowser().UnicodeGraphemesAddon);
  installXtVersionReply(term);
  installModifyOtherKeys(term);
  installFocusReports(term);
  installProgramNotifications(term, { enabled: () => true, keptAt: () => null, onNotify: () => {} });
  installTerminalProgress(term, { enabled: () => true, onProgress: () => {} });
  term.onBell(() => {});
  watchScrollbackChanges(term, { changed: () => {}, cleared: () => {}, quiet: () => false });
  const marks = trackCommandMarks(term);
  trackDirectories(term, { initial: '/workspace', current: () => '/workspace', marks: () => marks.marks ?? [] });
  installMouseReporting(term, null, { isEnabled: () => true });
  return { term, replies };
}

/** `data` written; true once xterm has read it, false if it never does within `ms`. */
function written(term, data, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    term.write(data, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function screenOf(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = 0; y < buffer.length; y += 1) rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
  return { type: buffer.type, text: rows.join('\n') };
}

let node = null;

describe('Claude Code 2.1.319 starting: the parser with NexTerm\'s handlers (Node, real xterm)', () => {
  test('CS-01: every chunk of claude\'s start-up is parsed, and each query is answered by the chunk that asks it', async () => {
    const { term, replies } = nextermParser();
    const perChunk = {};
    const unparsed = [];
    for (const { index, text } of outputChunks()) {
      const before = replies.length;
      if (!(await written(term, text))) unparsed.push(index);
      if (replies.length > before) perChunk[index] = replies.slice(before);
    }
    node = { term, replies, unparsed };
    assert.deepEqual(unparsed, [], `xterm never read chunk(s) ${unparsed.join(', ')}: the terminal stopped parsing there`);
    assert.deepEqual(perChunk, answersWithout([FOCUS_IN]), 'the answers, chunk by chunk (no focus in Node)');
  });

  test('CS-02: it ends on claude\'s full-screen UI — the alternate screen, with Claude Code on it', () => {
    if (!node) skip('CS-01 did not run');
    const screen = screenOf(node.term);
    assert.equal(screen.type, 'alternate');
    assert.ok(screen.text.includes('Claude Code'), 'Claude Code is on the screen');
  });

  test('CS-03: afterwards the terminal still parses, and answers DA1', async () => {
    if (!node) skip('CS-01 did not run');
    const before = node.replies.length;
    assert.equal(await written(node.term, '\x1b[c'), true, 'a write after the start-up was never read');
    assert.deepEqual(node.replies.slice(before), [DA1]);
    node.term.dispose();
  });

  // The cause of the freeze (found in the app, a production build): xterm as
  // `npm run build` bundles it. Vite's default target lowered and minified
  // InputHandler.requestMode's `let r; (…)(r ||= {})` into
  // `(void 0 || (r = {}))` — `r` undeclared — so the first DECRQM threw a
  // ReferenceError inside xterm's write loop, and nothing was parsed after
  // it. Not WebKit's doing: any engine throws there in module code, which is
  // why this runs in Node. The dev server never bundles, so the app run with
  // `tauri dev` (and the page cases below) cannot show it. See vite.config.js.
  test('CS-04: xterm as the production build bundles it answers claude\'s DECRQM and goes on parsing', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'nexterm-cs04-'));
    const caught = [];
    const runnerHandlers = process.listeners('uncaughtException');
    // build() sets NODE_ENV=production when it is unset; left so, the page
    // cases' dev server below and every later file would run production React.
    const nodeEnv = process.env.NODE_ENV;
    try {
      const entry = join(dir, 'entry.js');
      const xtermModule = createRequire(join(root, 'package.json')).resolve('@xterm/xterm').replace(/xterm\.js$/, 'xterm.mjs');
      writeFileSync(entry, `import { Terminal } from ${JSON.stringify(xtermModule)};\nglobalThis.__nextermCs04Terminal = Terminal;\n`);
      const { build } = await import('vite');
      // The project's own config, as `npm run build` reads it; only what is
      // bundled (xterm alone) and where it goes differ.
      await build({
        configFile: join(root, 'vite.config.js'),
        root,
        logLevel: 'silent',
        build: { outDir: join(dir, 'out'), emptyOutDir: true, rollupOptions: { input: entry, output: { entryFileNames: 'xterm.js' } } },
      });
      await import(pathToFileURL(join(dir, 'out', 'xterm.js')).href);
      const Terminal = globalThis.__nextermCs04Terminal;
      assert.equal(typeof Terminal, 'function', 'the bundle exposes xterm\'s Terminal');
      // The throw comes from xterm's write timer; the runner would exit on it.
      process.removeAllListeners('uncaughtException');
      process.on('uncaughtException', (err) => caught.push(String(err?.message ?? err)));
      const term = new Terminal({ cols: COLS, rows: ROWS });
      const replies = [];
      term.onData((data) => replies.push(data));
      const asked = await written(term, '\x1b[?2026$p');
      const after = await written(term, '\x1b[c');
      term.dispose();
      assert.deepEqual(caught, [], 'nothing thrown inside xterm\'s write loop');
      assert.equal(asked, true, 'the DECRQM write was never read — the terminal stopped parsing');
      assert.equal(after, true, 'a write after the DECRQM was never read');
      assert.deepEqual(replies, [DECRQM_2026, DA1], 'DECRQM 2026 answered, then DA1');
    } finally {
      process.removeAllListeners('uncaughtException');
      for (const handler of runnerHandlers) process.on('uncaughtException', handler);
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      delete globalThis.__nextermCs04Terminal;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const NO_BROWSER = 'agent-browser is not installed — the real-browser Claude Code start-up runs locally only';

let harness = null;
const reports = {};

/** What a page run must show: every write read, every query answered and sent on, the UI drawn, nothing thrown. */
function checkRun(report) {
  assert.equal(report.size, `${COLS}x${ROWS}`, 'the terminal has the size claude drew for');
  assert.equal(report.focused, true, 'the terminal has the focus, as the one typed in does');
  assert.deepEqual(report.tab, { running: true, agent: 'claude', commandLine: 'claude' }, 'the store took the tab for a running Claude Code, as it does when one is typed');
  const unparsed = report.events.filter((e) => !e.parsed);
  assert.deepEqual(
    unparsed.map((e) => `event ${e.event} (chunks ${e.chunks.join(',')}) at ${e.t}s: ${e.head}`),
    [],
    'xterm never read these events — the terminal stopped parsing at the first'
  );
  assert.deepEqual(report.emitted, ALL_ANSWERS.map((r) => esc(r)), 'what the terminal answered, in order');
  assert.equal(count(report.emitted, esc(DA1)), 3, 'DA1 answered three times');
  assert.deepEqual(report.sent, report.emitted, 'every answer reached the program (the store\'s writeRaw sent it on)');
  assert.equal(report.acked, report.bytes, `every byte read and acknowledged to flow control (${report.acked} of ${report.bytes})`);
  assert.equal(report.screen.type, 'alternate', 'claude\'s full-screen UI: the alternate screen');
  assert.ok(report.screen.text.includes('Claude Code'), 'with Claude Code on it');
  assert.equal(report.probe.parsed, true, 'a write after the start-up was never read');
  assert.deepEqual(report.probe.replies, [esc(DA1)], 'and DA1 is still answered');
  // xterm's own idle-task note under load is not the page's.
  const said = report.console.filter((line) => !line.includes('task queue exceeded allotted deadline'));
  assert.deepEqual(said, [], 'nothing warned or failed on the console');
  assert.deepEqual(report.rejections, [], 'no promise was rejected unhandled');
}

describe('Claude Code 2.1.319 starting: the app\'s own terminal under headless Chromium', () => {
  test('CS-10: setup — the scratch vite server, the harness page, a raw CDP session onto it; both replays run', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    try {
      harness = await openHarness('tests/adversarial/fixtures/claude_startup_harness.html', {
        prefix: 'claude-startup-headless',
        readyExpression: 'window.__cc ? window.__cc.ready === true : false',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) skip(`${NO_BROWSER} (${err.message})`);
      throw err;
    }
    // A page the browser treats as focused, as the app's window is when the
    // user types `claude` into it: xterm then answers a focus-report request.
    await harness.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    reports.batched = await harness.evalJs("window.__cc.run('batched')");
    reports.chunks = await harness.evalJs("window.__cc.run('chunks')");
    assert.deepEqual(harness.pageErrors(), [], 'the page threw');
  });

  test('CS-11: batched as the backend sends it — every event read, every query answered, the UI drawn', () => {
    if (!HEADLESS_AVAILABLE || !reports.batched) skip(NO_BROWSER);
    const report = reports.batched;
    // output_batch.rs on the recorded clock: the first batch of queries in
    // one event, the second in the next — as the app received them.
    const firstTwo = report.events.filter((e) => e.chunks.some((i) => [2, 3, 4, 8, 9, 10].includes(i))).map((e) => e.chunks);
    assert.deepEqual(firstTwo, [[2, 3, 4], [8, 9, 10]], 'the events the first two batches of queries arrived in');
    checkRun(report);
  });

  test('CS-12: chunk by chunk — each query answered by the chunk that asks it', () => {
    if (!HEADLESS_AVAILABLE || !reports.chunks) skip(NO_BROWSER);
    const report = reports.chunks;
    const perChunk = {};
    for (const e of report.events) if (e.replies.length) perChunk[e.chunks[0]] = e.replies;
    const expected = Object.fromEntries(Object.entries(ANSWERS).map(([i, r]) => [i, r.map((x) => esc(x))]));
    assert.deepEqual(perChunk, expected, 'the answers, chunk by chunk');
    checkRun(report);
  });

  test('CS-13: the replay is the recording — every output byte, in its order', () => {
    if (!HEADLESS_AVAILABLE || !reports.chunks) skip(NO_BROWSER);
    const bytes = outputChunks().reduce((n, c) => n + Buffer.byteLength(c.text, 'utf8'), 0);
    assert.equal(bytes, 7006, 'the recording holds 7,006 bytes of output');
    assert.equal(reports.chunks.bytes, bytes, 'the page delivered all of it');
    assert.equal(reports.batched.bytes, bytes, 'batched too');
  });

  test('CS-14: teardown — close the browser session and stop the scratch server', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    harness?.teardown();
  });
});
