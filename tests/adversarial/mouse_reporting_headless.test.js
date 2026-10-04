/**
 * The one check Node alone cannot do: that this actually changes what REAL
 * xterm 5.5 does with REAL mouse events, not just what our own model of it
 * says it should. Drives tests/adversarial/fixtures/mouse_drag_harness.html
 * — two genuine `@xterm/xterm` terminals, one with `installMouseReporting`
 * (src/lib/mouseReporting.js, this fix), one stock — over a scratch Vite dev
 * server on 127.0.0.1:1495 (its own cacheDir, `--strictPort`, never the
 * app's own :1420/:1425) inside a dedicated agent-browser session.
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
 * button is let go.
 *
 * HL-01/HL-05 are setup/teardown as their own cases (no suite-level hook
 * exists in this harness — PR-09/PR-10 elsewhere in this runner do the same)
 * sharing module-scoped state; teardown runs even if an earlier case failed,
 * since the runner does not bail.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = 1495;
const HARNESS_URL = `http://127.0.0.1:${PORT}/tests/adversarial/fixtures/mouse_drag_harness.html`;

let viteChild = null;
let scratchDir = null;
let sessionName = null;
let ws = null;
let sendRaw = null;
let pageSessionId = null;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).trim();
}

/** A vite config living entirely outside the repo: its own cacheDir, nothing committed. */
function writeScratchConfig(dir) {
  const configPath = path.join(dir, 'vite.config.mjs');
  const config = {
    root: REPO_ROOT,
    clearScreen: false,
    cacheDir: path.join(dir, '.vite'),
    server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  };
  writeFileSync(configPath, `export default ${JSON.stringify(config)};\n`, 'utf8');
  return configPath;
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the scratch vite server never answered ${url}: ${lastErr}`);
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', () => reject(new Error(`could not open the CDP socket at ${url}`)));
  });
}

/** `(method, params, sessionId) -> Promise<result>` over one CDP WebSocket. */
function makeSender(socket) {
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const thisId = ++id;
      pending.set(thisId, { resolve, reject });
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

describe('Mouse reporting: real xterm 5.5 under headless Chromium (CDP)', () => {
  test('HL-01: setup — the scratch vite server, the harness page, a raw CDP session onto it', async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), 'nexterm-mousedrag-'));
    const configPath = writeScratchConfig(scratchDir);
    const viteBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');
    viteChild = spawn(viteBin, ['--config', configPath], { cwd: REPO_ROOT, stdio: 'ignore' });
    await waitForServer(HARNESS_URL);

    sessionName = sh('agent-browser', ['session', 'id', '--scope', 'worktree', '--prefix', 'mouse-drag-headless']);
    sh('agent-browser', ['--session', sessionName, 'open', HARNESS_URL]);
    sh('agent-browser', ['--session', sessionName, 'wait', '--load', 'networkidle']);
    const browserWsUrl = sh('agent-browser', ['--session', sessionName, 'get', 'cdp-url']);

    ws = await connectWs(browserWsUrl);
    sendRaw = makeSender(ws);
    const { targetInfos } = await sendRaw('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(HARNESS_URL));
    assert.ok(page, 'the harness page is the active tab of its own agent-browser session');
    const attached = await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    pageSessionId = attached.sessionId;

    assert.equal(await evalJs('window.__h ? window.__h.ready : null'), true, 'the harness module finished loading');
  });

  test('HL-02: the fix — a drag survives Claude\'s own `?1000h?1002h?1003h?1006h`, restated mid-drag', async () => {
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

  test('HL-05: teardown — close the browser session and stop the scratch server', async () => {
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
  });
});
