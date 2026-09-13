/**
 * Where NexTerm's own messages to the user go.
 *
 * The store needs to put a line in front of the user — a paste the kernel
 * refused, say — but the thing that can draw it is the xterm instance, and the
 * store must not import a component module: it is loaded in Node by the test
 * suites, and xterm pulls in a stylesheet. So the renderer registers a sink
 * here at startup and the store just calls `notifyTerminal`.
 */

let sink = null;

/** Register the renderer's writer. Returns an unregister function. */
export function setTerminalNoticeSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
  return () => {
    if (sink === fn) sink = null;
  };
}

/**
 * Show `message` in terminal `tabId`. Returns whether it was actually
 * displayed, so callers can fall back to the console when no renderer is
 * attached (Node, or a tab with no live instance).
 */
export function notifyTerminal(tabId, message) {
  if (!sink || !message) return false;
  try {
    return Boolean(sink(tabId, message));
  } catch (_) {
    return false;
  }
}
