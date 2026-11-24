/**
 * The Markdown worker (Orca bundle 5, B3; OQ-B3g, 2026-11-24): the one
 * place Markdown is parsed. Built by Vite as a worker of its own
 * (markdownWorkerFactory.js, `?worker`, as src/lib/monaco.js builds
 * Monaco's) and driven by markdownRenderClient.js, which stops it when a
 * parse runs past MARKDOWN_PARSE_TIMEOUT_MS.
 *
 * Each message `{ id, text, filePath, root }` gets one answer:
 *   { id, ok: true, hast, images }       markdownToHast's tree and images;
 *   { id, ok: false, error: { name, message } }   what it threw (a
 *       RangeError past 2 MB or from a stack the input overflowed, …) —
 *       name and message only, never a stack. Past MARKDOWN_MAX_ELEMENTS the
 *       name is MARKDOWN_TOO_COMPLEX_ERROR ('MarkdownTooComplexError',
 *       markdownPreview.js), which the client answers as 'too-complex'.
 *
 * Only markdownWorkerFactory.js names this file, and only this file imports
 * markdownPipeline.js (MW-40, WV-06b): the window's thread never parses.
 */
import { markdownToHast } from './markdownPipeline.js';

/** The longest error message posted back. */
const MESSAGE_MAX = 500;

/** A path or root as the pipeline takes it: a string, or null. */
const pathOrNull = (value) => (typeof value === 'string' && value ? value : null);

/** The answer to one request `data` (see the top of this file). Never throws. */
export function answerMarkdownRequest(data) {
  const id = data?.id;
  try {
    const { hast, images } = markdownToHast(data?.text, { filePath: pathOrNull(data?.filePath), root: pathOrNull(data?.root) });
    return { id, ok: true, hast, images };
  } catch (err) {
    const name = typeof err?.name === 'string' ? err.name.slice(0, 64) : 'Error';
    const message = String(err?.message ?? err ?? 'The Markdown could not be read').slice(0, MESSAGE_MAX);
    return { id, ok: false, error: { name, message } };
  }
}

// In a worker, `globalThis` is the worker's scope: answer its messages. In
// Node (the tests import this module to call answerMarkdownRequest) there is
// no such scope, and nothing is listened to.
const scope = globalThis;
if (typeof scope.addEventListener === 'function' && typeof scope.postMessage === 'function') {
  scope.addEventListener('message', (event) => {
    scope.postMessage(answerMarkdownRequest(event?.data));
  });
}
