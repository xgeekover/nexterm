/**
 * A real browser for the cases Node cannot check: a page under
 * tests/adversarial/fixtures/, served by a scratch Vite dev server and opened
 * in its own agent-browser session, with a raw CDP session onto it. The same
 * plumbing as mouse_reporting_headless.test.js, for the files after it.
 *
 *   - The server runs on a free 127.0.0.1 port picked at runtime, from a
 *     config written outside the repo with its own cacheDir and
 *     `--strictPort` — never the app's own :1420/:1425, or a fixed port a
 *     concurrent run might hold.
 *   - agent-browser is used for lifecycle only (open the page, hand back its
 *     CDP WebSocket URL, close). Everything on the page — evaluation, mouse,
 *     wheel — goes over one raw `Target`-attached session, so the order of
 *     events is the order they were sent in.
 *   - Every CDP round trip and the server poll has its own timeout, so a hung
 *     browser or a dead target cannot hang the suite. A server that dies is a
 *     real failure, reported as such at once; a browser that cannot start
 *     (`BrowserUnavailable`) is for the caller to turn into a skip.
 *   - Teardown is synchronous, idempotent, and also runs from
 *     `process.on('exit')`, so it happens even when a case threw.
 *
 * Not a test file: the runner does not import it.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Whether there is a browser to drive: `agent-browser` (and the Chromium it
 * drives). CI machines and most checkouts have neither, so there every case
 * reports itself skipped rather than failing. `NEXTERM_SKIP_HEADLESS` skips
 * them where there is one.
 */
export const HEADLESS_AVAILABLE = (() => {
  if (process.env.NEXTERM_SKIP_HEADLESS) return false;
  try {
    const probe = spawnSync('agent-browser', ['--version'], { encoding: 'utf8', timeout: 10000 });
    return probe.status === 0;
  } catch {
    return false;
  }
})();

/** The browser itself could not start or be reached — a skip, not a failure. */
export class BrowserUnavailable extends Error {}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).trim();
}

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

/** Rejects the moment the vite child exits or fails to spawn — raced against `waitForServer`. */
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

/** Each poll gets its own short budget, so one hung request cannot stall the deadline. */
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

/** `(method, params, sessionId, timeoutMs) -> Promise<result>` over one CDP WebSocket, every call timed out. */
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

/**
 * Serve the repo, open `fixture` (a path from the repo root) in a session
 * named after `prefix`, and wait until `readyExpression` evaluates to true on
 * the page. Returns `{ evalJs, send, teardown }`: `evalJs(expression)` awaits
 * a promise and returns the value; `send(method, params)` is a raw CDP call on
 * the page's session.
 *
 * `session`, when given, is the agent-browser session to use instead of the
 * one agent-browser names for this worktree — which two runs at once share,
 * and the second then cannot start (found in review: both reported a
 * browser that was there as missing).
 *
 * `pageErrors()` lists every exception the page threw and nobody caught —
 * an event listener's included — since the harness attached
 * (`Runtime.exceptionThrown`). A suite that asserts it is empty fails on an
 * error the page swallowed into the console: one such error — a timer
 * called the way a browser refuses — passed every case in Node.
 */
export async function openHarness(fixture, { prefix, readyExpression, session = null }) {
  let viteChild = null;
  let scratchDir = null;
  let sessionName = null;
  let ws = null;
  let tornDown = false;

  const teardown = () => {
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
    try {
      viteChild?.kill();
    } catch {
      // best-effort
    }
    if (scratchDir) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  };
  process.on('exit', teardown);

  try {
    scratchDir = mkdtempSync(path.join(tmpdir(), `nexterm-${prefix}-`));
    const port = await getFreePort();
    const url = `http://127.0.0.1:${port}/${fixture}`;
    const configPath = writeScratchConfig(scratchDir, port);
    viteChild = spawn(path.join(REPO_ROOT, 'node_modules', '.bin', 'vite'), ['--config', configPath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    await Promise.race([waitForServer(url), waitForProcessExit(viteChild)]);

    // From here on a failure means "the browser could not start", not "the
    // code under test is broken".
    let sendRaw;
    let pageSessionId;
    try {
      sessionName = session || sh('agent-browser', ['session', 'id', '--scope', 'worktree', '--prefix', prefix]);
      sh('agent-browser', ['--session', sessionName, 'open', url]);
      sh('agent-browser', ['--session', sessionName, 'wait', '--load', 'networkidle']);
      ws = await connectWs(sh('agent-browser', ['--session', sessionName, 'get', 'cdp-url']));
      sendRaw = makeSender(ws);
      const { targetInfos } = await sendRaw('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(url));
      if (!page) throw new Error('the harness page is not the active tab of its own agent-browser session');
      pageSessionId = (await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    } catch (err) {
      throw new BrowserUnavailable(`agent-browser could not start: ${err.message}`);
    }

    const send = (method, params = {}) => sendRaw(method, params, pageSessionId);
    const errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method !== 'Runtime.exceptionThrown' || msg.sessionId !== pageSessionId) return;
      const details = msg.params?.exceptionDetails ?? {};
      errors.push(details.exception?.description ?? details.text ?? 'an exception');
    });
    await send('Runtime.enable');
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails)}`);
      return r.result.value;
    };

    // The harness module awaits its own setup; give it a few seconds.
    const deadline = Date.now() + 15000;
    while ((await evalJs(readyExpression)) !== true) {
      if (Date.now() > deadline) throw new Error('the harness module did not finish loading');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { evalJs, send, teardown, pageErrors: () => errors.slice() };
  } catch (err) {
    teardown();
    throw err;
  }
}
