/**
 * The window's side of the Markdown worker (Orca bundle 5, B3; OQ-B3g,
 * 2026-11-24). The window never parses Markdown: it hands the text to the
 * worker (markdownWorker.js) and draws the tree that comes back.
 *
 *   const renderer = createMarkdownRenderer({ createWorker });
 *   const result = await renderer.render(text, { filePath, root });
 *   renderer.dispose();
 *
 * `render` resolves — it never rejects — to one of
 *   { status: 'ok', hast, images }   the safe tree and the images, as
 *       markdownPipeline.js `markdownToHast` gives them;
 *   { status: 'too-complex' }   no answer within `timeoutMs`
 *       (MARKDOWN_PARSE_TIMEOUT_MS): the worker was terminated, and the next
 *       render starts a fresh one; or the worker answered that the tree is
 *       past the drawing cap (an error named MARKDOWN_TOO_COMPLEX_ERROR,
 *       markdownPreview.js MARKDOWN_MAX_ELEMENTS), and the worker is kept.
 *       The preview says "Too complex to preview" and offers Open as Text;
 *   { status: 'error', name, message }   the worker threw (a RangeError past
 *       2 MB, …), failed to load, or reported an error or a message it could
 *       not read — the worker is then terminated as for a crash. `message`
 *       is the worker's words, not cleaned: clean before showing;
 *   { status: 'superseded' }   a newer render took this one's place before
 *       it started, or the renderer was disposed.
 *
 * One parse at a time. A render asked while one is in flight waits, and
 * only the newest waiting one is kept: live updates every 300 ms never pile
 * up behind a slow parse. A reply whose id is not the one in flight is
 * ignored, and so is anything a terminated worker still says.
 *
 * Pure, and imports nothing: `createWorker` is passed in. In the app it is
 * markdownWorkerFactory.js `createMarkdownWorker` (Vite's `?worker`); a test
 * passes a fake, or a node:worker_threads adapter. A worker is whatever has
 * `postMessage(data)`, `terminate()` and `addEventListener(type, listener)`
 * for 'message' (`event.data`), 'error' and 'messageerror'.
 */

/** How long one parse may take before its worker is stopped (the human's decision, 2026-11-24). */
export const MARKDOWN_PARSE_TIMEOUT_MS = 5000;

/**
 * The name of the error the worker answers with past the drawing cap: a copy
 * of markdownPreview.js MARKDOWN_TOO_COMPLEX_ERROR, since this module imports
 * nothing (MW-40). MW-60 pins the two to one value.
 */
export const TOO_COMPLEX_ERROR = 'MarkdownTooComplexError';

/** The longest error message a result carries. */
const MESSAGE_MAX = 500;

/** The words for a worker that stopped or failed to load without saying why. */
const WORKER_FAILED = 'The Markdown preview stopped unexpectedly';

/** `value` as a short message, or `fallback`. */
function messageOf(value, fallback) {
  const text = typeof value === 'string' ? value : '';
  return text ? text.slice(0, MESSAGE_MAX) : fallback;
}

/**
 * A renderer (see the top of this file). `setTimer` and `clearTimer` default
 * to the global setTimeout and clearTimeout, looked up on each call; a
 * `timeoutMs` that is not a positive number is MARKDOWN_PARSE_TIMEOUT_MS.
 */
export function createMarkdownRenderer({
  createWorker,
  timeoutMs = MARKDOWN_PARSE_TIMEOUT_MS,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : MARKDOWN_PARSE_TIMEOUT_MS;
  let worker = null;
  /** The parse in flight: { id, resolve, timer }. */
  let current = null;
  /** The newest render waiting for it: { text, options, resolve }. */
  let waiting = null;
  let nextId = 1;
  let disposed = false;

  /** Stops the worker, if there is one; the next parse makes a new one. */
  const stopWorker = () => {
    const old = worker;
    worker = null;
    try {
      old?.terminate();
    } catch {
      // Gone already.
    }
  };

  /** Ends the parse in flight with `result`, then starts the one waiting. */
  const finish = (result) => {
    const done = current;
    current = null;
    if (done) {
      if (done.timer !== undefined) clearTimer(done.timer);
      done.resolve(result);
    }
    startNext();
  };

  /** The worker, made now when there is none. Throws what `createWorker` throws. */
  const ensureWorker = () => {
    if (worker) return worker;
    const made = createWorker();
    if (!made || typeof made.postMessage !== 'function') throw new Error(WORKER_FAILED);
    worker = made;
    // Every listener checks that `made` is still the worker: a terminated
    // one, or one a time limit replaced, is not listened to.
    made.addEventListener('message', (event) => {
      if (worker !== made || !current) return;
      const data = event?.data;
      if (!data || data.id !== current.id) return;
      if (data.ok === true && data.hast?.type === 'root') finish({ status: 'ok', hast: data.hast, images: Array.isArray(data.images) ? data.images : [] });
      else if (data.ok === true) finish({ status: 'error', name: 'Error', message: WORKER_FAILED });
      else if (data.error?.name === TOO_COMPLEX_ERROR) finish({ status: 'too-complex' });
      else finish({ status: 'error', name: messageOf(data.error?.name, 'Error'), message: messageOf(data.error?.message, WORKER_FAILED) });
    });
    const crashed = (event) => {
      if (worker !== made) return;
      stopWorker();
      if (current) finish({ status: 'error', name: 'Error', message: messageOf(event?.message, WORKER_FAILED) });
    };
    made.addEventListener('error', crashed);
    made.addEventListener('messageerror', crashed);
    return made;
  };

  /** Starts the waiting render, when nothing is in flight. */
  const startNext = () => {
    if (current || !waiting || disposed) return;
    const { text, options, resolve } = waiting;
    waiting = null;
    const id = nextId;
    nextId += 1;
    current = { id, resolve, timer: undefined };
    try {
      ensureWorker().postMessage({ id, text, filePath: options?.filePath ?? null, root: options?.root ?? null });
    } catch (err) {
      stopWorker();
      finish({ status: 'error', name: 'Error', message: messageOf(err?.message, WORKER_FAILED) });
      return;
    }
    current.timer = setTimer(() => {
      if (!current || current.id !== id) return;
      stopWorker();
      finish({ status: 'too-complex' });
    }, limit);
  };

  return {
    /** `text` of the Markdown file `options.filePath` in the folder `options.root`, parsed in the worker. */
    render(text, options = {}) {
      return new Promise((resolve) => {
        if (disposed) {
          resolve({ status: 'superseded' });
          return;
        }
        waiting?.resolve({ status: 'superseded' });
        waiting = { text, options, resolve };
        startNext();
      });
    },
    /** Stops the worker; whatever is in flight or waiting resolves 'superseded'. */
    dispose() {
      disposed = true;
      stopWorker();
      const pending = [current, waiting];
      if (current?.timer !== undefined) clearTimer(current.timer);
      current = null;
      waiting = null;
      for (const entry of pending) entry?.resolve({ status: 'superseded' });
    },
  };
}
