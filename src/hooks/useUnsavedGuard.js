import { useEffect } from 'react';
import { invoke, isTauri, listen } from '../lib/ipc.js';
import { useEditorStore } from '../stores/editorStore.js';

/**
 * Sent by the backend when macOS is asked to quit while an editor tab holds
 * unsaved changes: ⌘Q, the Dock's Quit, logging out. None of those closes the
 * window first, so the close guard below never hears of them. See
 * src-tauri/src/commands/app.rs.
 */
export const QUIT_REQUESTED_EVENT = 'app-quit-requested';

/**
 * Answer the window's close request: the title bar's ✕, File ▸ Exit,
 * Ctrl/⌘+Shift+W, Alt+F4, the taskbar's Close.
 *
 * With nothing unsaved the window closes. Otherwise the close is held behind
 * the Save / Don't Save / Cancel prompt that closing a tab asks, and the
 * window is closed once the user has answered.
 *
 * `event` is what Tauri's `onCloseRequested` hands its handler. Once any
 * handler is registered, the backend never closes the window on its own:
 * `onCloseRequested` destroys it when the handler returns without
 * `preventDefault()`, which is why capabilities/default.json has to grant
 * `core:window:allow-destroy` — without it, no window could close at all.
 * Returns whether the close was held.
 */
export function answerCloseRequest(event, win, editor = useEditorStore.getState()) {
  let held = null;
  try {
    held = editor.askBeforeLeaving('window', () => win.destroy());
  } catch (err) {
    // A guard that throws on every close would leave a window that cannot be
    // closed at all. Closing as before is the lesser harm.
    console.error('[unsaved] could not check for unsaved changes; closing anyway:', err);
  }
  if (held) event.preventDefault();
  return Boolean(held);
}

/**
 * Answer the backend's quit request (see QUIT_REQUESTED_EVENT): the same
 * prompt, then `app_quit`. The backend only asks when it was last told that
 * something is unsaved; if that has changed since, this quits straight away.
 */
export function answerQuitRequest(
  editor = useEditorStore.getState(),
  quit = () => invoke('app_quit')
) {
  return editor.askBeforeLeaving('quit', quit) ?? quit();
}

/**
 * Keep the backend told whether any editor tab is unsaved.
 *
 * A macOS quit has to be answered while AppKit waits, with no round trip to
 * the webview, and this is the one thing it needs to know. Sent only when it
 * changes, not on every keystroke, and one at a time so that the backend
 * cannot hear them out of order. Returns the unsubscribe.
 */
export function reportUnsaved(
  store = useEditorStore,
  send = (unsaved) => invoke('app_set_unsaved', { unsaved })
) {
  let last = null;
  let queue = Promise.resolve();
  const report = (state) => {
    const unsaved = state.tabs.some((t) => t.isDirty);
    if (unsaved === last) return;
    last = unsaved;
    queue = queue
      .then(() => send(unsaved))
      .catch((err) => console.warn('[unsaved] could not tell the backend about unsaved changes:', err));
  };
  report(store.getState());
  return store.subscribe(report);
}

/**
 * Closing the window or quitting the app asks about unsaved editor tabs
 * first, as closing one tab always has. Only inside the desktop app: a
 * browser tab has no window of ours to hold.
 */
export function useUnsavedGuard() {
  useEffect(() => {
    if (!isTauri()) return undefined;
    let disposed = false;
    const offs = [];
    const keep = (off) => {
      if (typeof off !== 'function') return;
      if (disposed) off();
      else offs.push(off);
    };

    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        return win.onCloseRequested((event) => {
          answerCloseRequest(event, win);
        });
      })
      .then(keep)
      .catch((err) => console.error('[unsaved] cannot hold the window open for unsaved changes:', err));

    listen(QUIT_REQUESTED_EVENT, () => {
      Promise.resolve(answerQuitRequest()).catch((err) =>
        console.error('[unsaved] could not quit:', err)
      );
    })
      .then(keep)
      .catch((err) => console.error('[unsaved] cannot answer a quit request:', err));

    keep(reportUnsaved());

    return () => {
      disposed = true;
      offs.splice(0).forEach((off) => off());
    };
  }, []);
}

export default useUnsavedGuard;
