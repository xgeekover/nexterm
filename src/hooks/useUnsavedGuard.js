import { useEffect } from 'react';
import { invoke, isTauri, listen } from '../lib/ipc.js';
import { useEditorStore } from '../stores/editorStore.js';

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

/** What the guard asks of the backend. The suites hand in stand-ins. */
const backend = {
  ack: (id) => invoke('app_close_ack', { id }),
  closeWindow: () => invoke('app_close_window'),
  quit: () => invoke('app_quit'),
};

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

/** Answer the backend's question about closing the window (CLOSE_REQUESTED_EVENT). */
export function answerCloseRequest(id, editor = useEditorStore.getState(), api = backend) {
  return answer('window', id, editor, api, () => api.closeWindow());
}

/** Answer the backend's question about quitting (QUIT_REQUESTED_EVENT). */
export function answerQuitRequest(id, editor = useEditorStore.getState(), api = backend) {
  return answer('quit', id, editor, api, () => api.quit());
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

  keep(reportUnsaved());

  return () => {
    disposed = true;
    offs.splice(0).forEach(undo);
  };
}

/**
 * Closing the window or quitting the app asks about unsaved editor tabs
 * first, as closing one tab always has. Only inside the desktop app: a
 * browser tab has no window of ours to hold.
 */
export function useUnsavedGuard() {
  useEffect(() => (isTauri() ? startUnsavedGuard() : undefined), []);
}

export default useUnsavedGuard;
