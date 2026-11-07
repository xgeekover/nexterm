import { useEffect } from 'react';
import { invoke, isTauri, listen } from '../lib/ipc.js';
import { useEditorStore } from '../stores/editorStore.js';
import { onScrollbackPending, scrollbackSaver } from '../lib/scrollbackSession.js';
import { EXIT_FLUSH_MS } from '../lib/scrollbackSaver.js';

/**
 * Sent by the backend when the window is asked to close — its ✕, File ▸
 * Exit, Ctrl/⌘+Shift+W, Alt+F4, the taskbar's Close — while it was last told
 * that an editor tab is unsaved. The backend holds the close meanwhile. The
 * payload is the question's id. See src-tauri/src/commands/app.rs.
 */
export const CLOSE_REQUESTED_EVENT = 'app-close-requested';

/**
 * The same for quitting on macOS: ⌘Q, the Dock's Quit, logging out. None of
 * those closes the window first.
 */
export const QUIT_REQUESTED_EVENT = 'app-quit-requested';

/**
 * What the guard asks of the backend — and, before it leaves, of the page:
 * that every terminal's scrollback is saved (`flush`, stage 6). The suites
 * hand in stand-ins; one without `flush` leaves at once.
 */
const backend = {
  ack: (id) => invoke('app_close_ack', { id }),
  closeWindow: () => invoke('app_close_window'),
  quit: () => invoke('app_quit'),
  flush: () => scrollbackSaver.flushAll({ timeoutMs: EXIT_FLUSH_MS }),
};

/**
 * `leave`, once the last scrollback is saved — or once EXIT_FLUSH_MS has
 * passed, whichever comes first. The backend holds the window for the page
 * after it heard the question, so a flush that never ends must not keep it:
 * the saver bounds its own wait, and this bounds it again rather than trust
 * that. A flush that throws or rejects only costs what it would have saved.
 */
function leaveAfterSaving(api, leave) {
  if (typeof api?.flush !== 'function') return leave();
  let flushing;
  try {
    flushing = Promise.resolve(api.flush()).catch((err) => console.warn('[unsaved] could not save the scrollback:', err));
  } catch (err) {
    console.warn('[unsaved] could not save the scrollback:', err);
    return leave();
  }
  let timer = null;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, EXIT_FLUSH_MS + 100);
  });
  return Promise.race([flushing, bound]).then(() => {
    clearTimeout(timer);
    return leave();
  });
}

/** Call the backend without waiting for it, and log a failure rather than throw it. */
function fire(what, call) {
  try {
    Promise.resolve(call()).catch((err) => console.error(`[unsaved] ${what}:`, err));
  } catch (err) {
    console.error(`[unsaved] ${what}:`, err);
  }
}

/**
 * Answer one of the backend's questions about leaving.
 *
 * First, that it was heard. The backend gives the page two seconds to say so
 * and then closes or quits anyway, because a page that has crashed or hung
 * cannot answer and must not be able to keep the window open.
 *
 * Then the Save / Don't Save / Cancel prompt that closing a tab asks, and
 * `leave` once the user has saved the edits or given them up. With nothing
 * unsaved by now (saved since the backend was last told), `leave` at once.
 * So too when the check itself throws: the backend is holding the window
 * for an answer, and a guard that cannot give one must not keep it.
 *
 * Returns whether the user is being asked.
 */
function answer(kind, id, editor, api, leave) {
  fire('could not tell the backend the question was heard', () => api.ack(id));
  let asking = null;
  try {
    asking = editor.askBeforeLeaving(kind, leave);
  } catch (err) {
    console.error('[unsaved] could not check for unsaved changes; leaving anyway:', err);
  }
  if (asking) return true;
  fire(kind === 'quit' ? 'could not quit' : 'could not close the window', leave);
  return false;
}

/**
 * Answer the backend's question about closing the window (CLOSE_REQUESTED_EVENT).
 * It is asked while an editor tab is unsaved, and while a terminal's
 * scrollback is (`reportPendingSave`): either way the scrollback is saved
 * first, after the user's answer when there is a question.
 */
export function answerCloseRequest(id, editor = useEditorStore.getState(), api = backend) {
  return answer('window', id, editor, api, () => leaveAfterSaving(api, () => api.closeWindow()));
}

/**
 * Answer the backend's question about quitting (QUIT_REQUESTED_EVENT) —
 * asked on macOS only for unsaved editor tabs, never held for scrollback
 * (spec D6: holding a quit cancels a logout); saved first all the same.
 */
export function answerQuitRequest(id, editor = useEditorStore.getState(), api = backend) {
  return answer('quit', id, editor, api, () => leaveAfterSaving(api, () => api.quit()));
}

/**
 * Every report to the backend, one after another in the order they were
 * made — every guard's, not each guard's own. In development React mounts
 * effects twice, so a guard going away and the one replacing it report in
 * the same moment, and the last word of the first must not land after the
 * first word of the second.
 */
let reports = Promise.resolve();

/**
 * Keep the backend told whether any editor tab is unsaved.
 *
 * It decides every close and every quit from this alone. With nothing
 * unsaved it lets them through without asking the page, and a macOS quit has
 * to be answered while AppKit waits, with no round trip to the page at all.
 * Sent only when it changes, not on every keystroke, and one at a time so
 * that the backend cannot hear them out of order.
 *
 * Returns the stop, which also tells the backend that nothing is unsaved.
 * Once this guard is gone nobody is left to answer the backend's questions —
 * a render that throws takes the whole React tree down, this guard with it —
 * and a backend still told "unsaved" would hold each close for an answer
 * that never comes, and on macOS call off each quit and logout.
 */
export function reportUnsaved(
  store = useEditorStore,
  send = (unsaved) => invoke('app_set_unsaved', { unsaved })
) {
  let last = null;
  const queue = (unsaved) => {
    reports = reports
      .then(() => send(unsaved))
      .catch((err) => console.warn('[unsaved] could not tell the backend about unsaved changes:', err));
  };
  const report = (state) => {
    const unsaved = state.tabs.some((t) => t.isDirty);
    if (unsaved === last) return;
    last = unsaved;
    queue(unsaved);
  };
  report(store.getState());
  const unsubscribe = store.subscribe(report);
  return () => {
    unsubscribe();
    queue(false);
  };
}

/**
 * Keep the backend told whether any terminal's scrollback is unsaved
 * (stage 6, spec D6): a window close is then held and asked about, and the
 * page saves (bounded) before it closes. A macOS quit is not held for it —
 * that is the backend's to decide, and why this must stay true to the saver:
 * it is the only thing the close gate knows.
 *
 * What the saver reports (`onScrollbackPending`), in the order it reports
 * it, through the same queue as `reportUnsaved`; sent only when it changes.
 * Returns the stop, which tells the backend nothing is pending — for the
 * reason `reportUnsaved` does: with this guard gone nobody answers the
 * backend's questions, and a backend still told "pending" would hold every
 * close for an answer that never comes.
 */
export function reportPendingSave(
  saver = { pending: scrollbackSaver.pending, onPending: onScrollbackPending },
  send = (pending) => invoke('app_set_pending_save', { pending })
) {
  let last = null;
  const queue = (pending) => {
    reports = reports
      .then(() => send(pending))
      .catch((err) => console.warn('[unsaved] could not tell the backend about unsaved scrollback:', err));
  };
  const report = (pending) => {
    const value = pending === true;
    if (value === last) return;
    last = value;
    queue(value);
  };
  report(saver.pending);
  const stop = saver.onPending(report);
  return () => {
    stop?.();
    queue(false);
  };
}

/**
 * `beforeunload`: hold a reload of the page while an editor tab is unsaved.
 *
 * Ctrl+R and F5 reload the page in WebView2, and a reload drops every editor
 * buffer without a word. It is not a close, so the backend never asks about
 * it. Cancelling the event is how a page asks the webview to confirm first.
 * Returns whether it held.
 */
export function holdReload(event, editor = useEditorStore.getState()) {
  if (!editor.tabs.some((t) => t.isDirty)) return false;
  event.preventDefault();
  // Chromium before 119 asked only when this was set as well.
  event.returnValue = true;
  return true;
}

/** Undo one thing the guard set up; an unsubscribe that fails is only logged. */
function undo(off) {
  try {
    Promise.resolve(off()).catch((err) => console.warn('[unsaved] could not stop listening:', err));
  } catch (err) {
    console.warn('[unsaved] could not stop listening:', err);
  }
}

/**
 * Everything the guard sets up, and its teardown.
 *
 * Nothing here listens for the window's own close request. Once a window has
 * such a listener, Tauri prevents every close of it and leaves the window to
 * the page — and a page that has crashed or hung leaves a window that nothing
 * but Task Manager can close. The backend decides instead, and asks.
 */
function startUnsavedGuard() {
  let disposed = false;
  const offs = [];
  const keep = (off) => {
    if (typeof off !== 'function') return;
    if (disposed) undo(off);
    else offs.push(off);
  };

  listen(CLOSE_REQUESTED_EVENT, (id) => {
    answerCloseRequest(id);
  })
    .then(keep)
    .catch((err) => console.error('[unsaved] cannot answer a close request:', err));

  listen(QUIT_REQUESTED_EVENT, (id) => {
    answerQuitRequest(id);
  })
    .then(keep)
    .catch((err) => console.error('[unsaved] cannot answer a quit request:', err));

  const onBeforeUnload = (event) => {
    holdReload(event);
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  keep(() => window.removeEventListener('beforeunload', onBeforeUnload));

  keep(reportUnsaved());
  keep(reportPendingSave());

  return () => {
    disposed = true;
    offs.splice(0).forEach(undo);
  };
}

/**
 * Closing the window, quitting the app or reloading the page asks about
 * unsaved editor tabs first, as closing one tab always has. Only inside the
 * desktop app: a browser tab has no window of ours to hold, and its files
 * live in the page and go with a reload anyway.
 */
export function useUnsavedGuard() {
  useEffect(() => (isTauri() ? startUnsavedGuard() : undefined), []);
}

export default useUnsavedGuard;
