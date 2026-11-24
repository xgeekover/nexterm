/**
 * Makes the Markdown worker (Orca bundle 5, B3; OQ-B3g): markdownWorker.js
 * built by Vite as a worker file of its own (`?worker`), as
 * src/lib/monaco.js has Monaco's built. Vite's build emits it as a classic
 * worker loaded from the app's own origin, which the CSP's
 * `worker-src 'self' blob:` allows.
 *
 * Its own module because the `?worker` import is Vite's alone: Node cannot
 * load it, so markdownRenderClient.js takes the factory as a parameter and
 * stays testable. Only the lazy MarkdownPreview.jsx (step P7) imports this;
 * nothing the first chunk holds may (WV-06b).
 */
import MarkdownWorker from './markdownWorker.js?worker';

/** A new Markdown worker, for `createMarkdownRenderer({ createWorker: createMarkdownWorker })`. */
export function createMarkdownWorker() {
  return new MarkdownWorker({ name: 'markdown-preview' });
}
