/**
 * The one check Node alone cannot do: that this actually changes what REAL
 * xterm (6.0; 5.5 before it) does with REAL mouse events, not just what our own model of it
 * says it should. Drives tests/adversarial/fixtures/mouse_drag_harness.html
 * — two genuine `@xterm/xterm` terminals, one with `installMouseReporting`
 * (src/lib/mouseReporting.js, this fix), one stock — over a scratch Vite dev
 * server on a free 127.0.0.1 port picked at runtime (its own cacheDir,
 * `--strictPort`, never the app's own :1420/:1425 or a fixed port a
 * concurrent run might already hold) inside a dedicated agent-browser
 * session. Needs a real browser locally — see `HEADLESS_AVAILABLE` and
 * `browserReady` for how a missing or non-starting one is told apart from
 * an actual failure.
 *
 * Mouse input is raw CDP `Input.dispatchMouseEvent`, not `agent-browser
 * mouse`/`press`: this needs a `buttons` bitmask on every `mouseMoved` (xterm
 * only treats one as a DRAG when `event.buttons` says a button is actually
 * down — see src/lib/mouseReporting.js's file doc), held across several
 * `term.write()` calls interleaved between moves, which only a single
 * CDP session this test drives itself can guarantee the order of.
 * `agent-browser` itself is used only for lifecycle (open the page, hand back
 * its CDP WebSocket URL, close); everything on the page — writes, reads,
 * mouse — goes over that one raw `Target`-attached session from here.
 *
 * HL-02 is the measured defect, reproduced as literally as a script can, down
 * to the timing: logged in the real macOS app (Claude Code v2.1.289, on the
 * branch head before this fix), the FIRST drag after Claude starts sent the
 * press, then ~3ms later — button still down — `?1000h`, `?1002h`, `?1003h`,
 * `?1006h` as separate CSI sequences; no `ESC[<32;…M` motion report ever
 * followed, only the eventual release, so Claude saw no drag and copied
 * nothing. Later drags, with no re-sent modes, carried motion and copied
 * every time. HL-02 replays exactly that — the resend lands WHILE the button
 * from the first press is still down, not between drags — and checks both
 * sides of it: `onData` must still show motion reports afterward, AND (the
 * real proof, not just an outward effect of it) xterm's own CoreMouseService
 * must report ZERO protocol changes for the whole gesture — the resend
 * restates modes already in force, so nothing should ever have asked xterm to
 * move at all. HL-03 is the same script against the STOCK terminal: the
 * control, proving the bug is xterm's, not a fixture artifact — no
 * mouseReporting.js, no surviving motion. HL-04 is the other half of the fix:
 * a GENUINE downgrade (a real DECRST, `?1003l?1000h`, not a redraw) arriving
 * mid-drag must still not cut that drag's motion — only settle once the
 * button is let go. HL-04b is MEDIUM 1 on real xterm: leaving the alternate
 * screen mid-drag (`?1003l?1002l?1000l?1049l`) must apply the downgrade AT
 * ONCE, not hold it for release.
 *
 * HL-01/HL-05 are setup/teardown as their own cases (no suite-level hook
 * exists in this harness — PR-09/PR-10 elsewhere in this runner do the same)
 * sharing module-scoped state; teardown (`teardownSync`) runs even if an
 * earlier case threw or the whole run aborted, via `process.on('exit')`, not
 * only from HL-05 itself. HL-01 tells "agent-browser could not start" apart
 * from "this fix is broken": the vite server dying is a real failure
 * (`waitForProcessExit` races `waitForServer` so that is reported with a
 * real error, not a 20s timeout), but a failure to open the browser itself
 * (or get a CDP session onto it) is caught and turned into a `skip`, with
 * `browserReady` staying false so HL-02–HL-04b skip too instead of each
 * failing on the same underlying cause. Every CDP round trip
 * (`connectWs`, `sendRaw`) and the server poll (`waitForServer`) has its own
 * timeout, so a hung browser or a dead target cannot hang the suite.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * A free TCP port on 127.0.0.1, picked at runtime — never a fixed one
 * (1495) that a concurrent run, or anything else on the machine, might
 * already hold.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * This file needs a real browser: `agent-browser` (and the Chromium it drives).
 * CI machines and most checkouts have neither, so there every case reports
 * itself skipped rather than failing — the Node-level drag tests
 * (`mouse_reporting_drag.test.js`) still run everywhere.
 */
const HEADLESS_AVAILABLE = (() => {
  if (process.env.NEXTERM_SKIP_HEADLESS) return false;
  try {
    const probe = spawnSync('agent-browser', ['--version'], { encoding: 'utf8', timeout: 10000 });
    return probe.status === 0;
  } catch {
    return false;
  }
})();
const NO_BROWSER = 'agent-browser is not installed — the real-browser drag check runs locally only';

let viteChild = null;
let scratchDir = null;
let sessionName = null;
let ws = null;
let sendRaw = null;
let pageSessionId = null;
let harnessUrl = null;
/** Set once HL-01 gets all the way through a real browser session. Guards
 * HL-02–HL-04 so a browser that could not start skips them instead of
 * failing them one by one with the same underlying cause. */
let browserReady = false;
let tornDown = false;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).trim();
}

/** A vite config living entirely outside the repo: its own cacheDir, nothing committed. */
function writeScratchConfig(dir, port) {
  const configPath = path.join(dir, 'vite.config.mjs');
  const config = {
    root: REPO_ROOT,
    clearScreen: false,
    cacheDir: path.join(dir, '.vite'),
    server: { port, strictPort: true, host: '127.0.0.1' },
  };
  writeFileSync(configPath, `export default ${JSON.stringify(config)};\n`, 'utf8');
  return configPath;
}

/** Rejects the moment the vite child exits or fails to spawn at all — raced
 * against `waitForServer` so a dead server is reported as that, immediately,
 * instead of as a 20s timeout with no explanation. */
function waitForProcessExit(child) {
  return new Promise((_resolve, reject) => {
    child.once('exit', (code, signal) => {
      reject(new Error(`the scratch vite server exited early (code=${code}, signal=${signal})`));
    });
    child.once('error', (err) => {
      reject(new Error(`the scratch vite server failed to start: ${err.message}`));
    });
  });
}

/** Best-effort, synchronous teardown — safe to call from `process.on('exit')`,
 * which cannot await anything, and idempotent so HL-05 calling it too (the
 * happy path) never double-closes anything. */
function teardownSync() {
  if (tornDown) return;
  tornDown = true;
  try {
    ws?.close();
  } catch {
    // best-effort
  }
  if (sessionName) {
    try {
      sh('agent-browser', ['--session', sessionName, 'close']);
    } catch {
      // best-effort — a daemon already gone is not a failure here
    }
  }
  if (viteChild) {
    try {
      viteChild.kill();
    } catch {
      // best-effort
    }
  }
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
process.on('exit', teardownSync);

/** Each poll gets its own short budget (`fetch` has no built-in timeout), so
 * one hung request cannot stall the overall `timeoutMs` deadline below it. */
async function waitForServer(url, timeoutMs = 20000, perRequestMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const perRequestTimer = setTimeout(() => controller.abort(), perRequestMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 200) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(perRequestTimer);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the scratch vite server never answered ${url}: ${lastErr}`);
}

function connectWs(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out opening the CDP socket at ${url} after ${timeoutMs}ms`)), timeoutMs);
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`could not open the CDP socket at ${url}`));
    });
  });
}

/** `(method, params, sessionId, timeoutMs) -> Promise<result>` over one CDP
 * WebSocket. Every call gets its own timeout: a browser-side crash or a
 * detached target otherwise leaves the promise pending forever, since
 * nothing would ever send back a matching response. */
function makeSender(socket, defaultTimeoutMs = 15000) {
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params = {}, sessionId, timeoutMs = defaultTimeoutMs) =>
    new Promise((resolve, reject) => {
      const thisId = ++id;
      const timer = setTimeout(() => {
        pending.delete(thisId);
        reject(new Error(`CDP call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(thisId, { resolve, reject, timer });
      const payload = { id: thisId, method, params };
      if (sessionId) payload.sessionId = sessionId;
      socket.send(JSON.stringify(payload));
    });
}

async function evalJs(expression) {
  const r = await sendRaw('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, pageSessionId);
  if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
}

/** A real left-button CDP mouse event against the harness page. */
async function mouseEvent(type, x, y, extra = {}) {
  await sendRaw('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }, pageSessionId);
}

/**
 * Did a motion report (DRAG — a button held — or plain MOVE) reach `onData`?
 * SGR mouse reports are `CSI < Cb ; Col ; Row M|m`; the final char is always
 * 'M' for a motion report (xterm's own encoder — see `c()` in @xterm/xterm's
 * bundle), and Cb has bit 32 set exactly for a motion report, never a plain
 * press or release. A press/release report never has bit 32, so checking it
 * is enough to tell "the drag kept reporting" from "only press and release
 * arrived" — the measured defect.
 */
function hasMotionReport(joinedOnData) {
  const re = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
  let m;
  while ((m = re.exec(joinedOnData))) {
    if (m[2] === 'M' && (Number(m[1]) & 32) !== 0) return true;
  }
  return false;
}

describe('Mouse reporting: real xterm under headless Chromium (CDP)', () => {
  test('HL-01: setup — the scratch vite server, the harness page, a raw CDP session onto it', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    scratchDir = mkdtempSync(path.join(tmpdir(), 'nexterm-mousedrag-'));
    const port = await getFreePort();
    harnessUrl = `http://127.0.0.1:${port}/tests/adversarial/fixtures/mouse_drag_harness.html`;
    const configPath = writeScratchConfig(scratchDir, port);
    const viteBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');
    viteChild = spawn(viteBin, ['--config', configPath], { cwd: REPO_ROOT, stdio: 'ignore' });
    // A real failure (the vite child dying) is reported as that, not as a
    // 20s "never answered" timeout with no explanation.
    await Promise.race([waitForServer(harnessUrl), waitForProcessExit(viteChild)]);

    // From here on, a failure means "the browser could not start", not "this
    // fix is broken" — skip the rest of the file instead of failing it, the
    // same as `!HEADLESS_AVAILABLE` does when agent-browser is missing
    // entirely.
    try {
      sessionName = sh('agent-browser', ['session', 'id', '--scope', 'worktree', '--prefix', 'mouse-drag-headless']);
      sh('agent-browser', ['--session', sessionName, 'open', harnessUrl]);
      sh('agent-browser', ['--session', sessionName, 'wait', '--load', 'networkidle']);
      const browserWsUrl = sh('agent-browser', ['--session', sessionName, 'get', 'cdp-url']);

      ws = await connectWs(browserWsUrl);
      sendRaw = makeSender(ws);
      const { targetInfos } = await sendRaw('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(harnessUrl));
      if (!page) throw new Error('the harness page is not the active tab of its own agent-browser session');
      const attached = await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      pageSessionId = attached.sessionId;

      const ready = await evalJs('window.__h ? window.__h.ready : null');
      if (ready !== true) throw new Error('the harness module did not finish loading');
      browserReady = true;
    } catch (err) {
      skip(`${NO_BROWSER} (agent-browser could not start: ${err.message})`);
    }
  });

  test('HL-02: the fix — a drag survives Claude\'s own `?1000h?1002h?1003h?1006h`, restated mid-drag', async () => {
    if (!HEADLESS_AVAILABLE || !browserReady) skip(NO_BROWSER);
    await evalJs(String.raw`window.__h.writeFixed('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')`);
    assert.equal(await evalJs("window.__h.protocolOf('fixed')"), 'any', 'ANY in force before the drag starts');

    // Matches the measured timing exactly: Claude restates its modes a few
    // ms after the FIRST press of a drag, while the button is already down
    // — not between drags. Reset the real protocol-change counter only once
    // the button is down, so what follows measures exactly that window.
    await mouseEvent('mousePressed', 100, 100, { buttons: 1, clickCount: 1 });
    await mouseEvent('mouseMoved', 105, 100, { buttons: 1 });
    await evalJs('window.__h.clearFixed()');
    await evalJs("window.__h.resetProtocolChangeCount('fixed')");

    // The exact shape of the measured bug: an Ink redraw restating modes
    // already in force, as separate writes, while the button is still down.
    for (const seq of [String.raw`\x1b[?1000h`, String.raw`\x1b[?1002h`, String.raw`\x1b[?1003h`, String.raw`\x1b[?1006h`]) {
      await evalJs(`window.__h.writeFixed('${seq}')`);
    }
    for (let i = 1; i <= 5; i += 1) await mouseEvent('mouseMoved', 105 + i * 10, 100 + i, { buttons: 1 });
    await mouseEvent('mouseReleased', 165, 105, { buttons: 0, clickCount: 1 });

    const data = await evalJs('window.__h.dataFixed().join("")');
    assert.ok(hasMotionReport(data), 'onData must contain motion reports after the re-sent modes');
    // The REAL proof, not just an outward effect of it: restating modes
    // already in force must never even ASK xterm's CoreMouseService to
    // change protocol — not once, including the final release, which (SGR)
    // never touches the protocol either. xterm.js's own last-DECSET-wins
    // would have fired this 3 times walking VT200 → DRAG → ANY again.
    assert.equal(await evalJs("window.__h.protocolChangeCount('fixed')"), 0, 'zero onProtocolChange events for the whole gesture');
  });

  test('HL-03: the bug, for real — the identical drag on a stock xterm loses them (the control)', async () => {
    if (!HEADLESS_AVAILABLE || !browserReady) skip(NO_BROWSER);
    await evalJs(String.raw`window.__h.writeControl('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')`);
    assert.equal(await evalJs("window.__h.protocolOf('control')"), 'any');

    await mouseEvent('mousePressed', 100, 420, { buttons: 1, clickCount: 1 });
    await mouseEvent('mouseMoved', 105, 420, { buttons: 1 });
    await evalJs('window.__h.clearControl()');

    for (const seq of [String.raw`\x1b[?1000h`, String.raw`\x1b[?1002h`, String.raw`\x1b[?1003h`, String.raw`\x1b[?1006h`]) {
      await evalJs(`window.__h.writeControl('${seq}')`);
    }
    for (let i = 1; i <= 5; i += 1) await mouseEvent('mouseMoved', 105 + i * 10, 420 + i, { buttons: 1 });
    await mouseEvent('mouseReleased', 165, 425, { buttons: 0, clickCount: 1 });

    const data = await evalJs('window.__h.dataControl().join("")');
    assert.equal(hasMotionReport(data), false, 'a stock xterm (no mouseReporting.js) loses motion after the same resend');
  });

  test('HL-04: a GENUINE downgrade mid-drag keeps its motion until release, and applies only after', async () => {
    if (!HEADLESS_AVAILABLE || !browserReady) skip(NO_BROWSER);
    // A clean slate: leaving the alternate screen forgets every flag (L1).
    await evalJs(String.raw`window.__h.writeFixed('\x1b[?1049l')`);
    // VT200 + ANY, deliberately WITHOUT the DRAG flag, so resetting ANY falls
    // all the way back to VT200 rather than stopping at DRAG.
    await evalJs(String.raw`window.__h.writeFixed('\x1b[?1049h\x1b[?1000h\x1b[?1003h\x1b[?1006h')`);
    assert.equal(await evalJs("window.__h.protocolOf('fixed')"), 'any');

    await mouseEvent('mousePressed', 100, 200, { buttons: 1, clickCount: 1 });
    await mouseEvent('mouseMoved', 105, 200, { buttons: 1 });
    await evalJs('window.__h.clearFixed()');

    // A real DECRST this time, not a redraw: ANY off, VT200 re-stated.
    await evalJs(String.raw`window.__h.writeFixed('\x1b[?1003l\x1b[?1000h')`);
    assert.equal(await evalJs("window.__h.protocolOf('fixed')"), 'any', 'held back — the button is still down');

    for (let i = 1; i <= 4; i += 1) await mouseEvent('mouseMoved', 105 + i * 10, 200 + i, { buttons: 1 });
    const whileHeld = await evalJs('window.__h.dataFixed().join("")');
    assert.ok(hasMotionReport(whileHeld), 'motion keeps flowing for the rest of THIS gesture');

    await mouseEvent('mouseReleased', 145, 204, { buttons: 0, clickCount: 1 });
    assert.equal(await evalJs("window.__h.protocolOf('fixed')"), 'vt200', 'the downgrade settles the instant the button is let go');
  });

  test('HL-04b (MEDIUM 1): leaving the alternate screen mid-drag applies the downgrade at once, on real xterm too', async () => {
    if (!HEADLESS_AVAILABLE || !browserReady) skip(NO_BROWSER);
    // A clean slate (L1), then a full-screen program with ANY in force.
    await evalJs(String.raw`window.__h.writeFixed('\x1b[?1049l')`);
    await evalJs(String.raw`window.__h.writeFixed('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h')`);
    assert.equal(await evalJs("window.__h.protocolOf('fixed')"), 'any');

    await mouseEvent('mousePressed', 100, 250, { buttons: 1, clickCount: 1 });
    await mouseEvent('mouseMoved', 105, 250, { buttons: 1 });
    await evalJs('window.__h.clearFixed()');

    // The full-screen program turns off its own tracking AND leaves the
    // alternate screen, mid-drag (e.g. `less --mouse`, 'q' while the button
    // is still down).
    await evalJs(String.raw`window.__h.writeFixed('\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l')`);
    assert.equal(await evalJs("window.__h.bufferOf('fixed')"), 'normal', 'real xterm really left the alternate screen');
    assert.equal(
      await evalJs("window.__h.protocolOf('fixed')"),
      'none',
      'fails before the MEDIUM-1 fix: real xterm stayed ANY on the normal buffer until release'
    );

    await mouseEvent('mouseReleased', 165, 255, { buttons: 0, clickCount: 1 });
    assert.equal(await evalJs("window.__h.protocolOf('fixed')"), 'none');
  });

  test('HL-05: teardown — close the browser session and stop the scratch server', async () => {
    // Not gated on `browserReady`: a PARTIAL HL-01 failure (vite up, browser
    // not) still leaves a vite child and a scratch dir to clean up. Only
    // `!HEADLESS_AVAILABLE` means nothing was ever started at all. The same
    // `teardownSync` also runs from `process.on('exit')`, so cleanup still
    // happens even if an earlier case threw instead of letting this run.
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    teardownSync();
  });
});
