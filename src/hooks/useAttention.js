import { useEffect } from 'react';
import { invoke } from '../lib/ipc.js';
import { isWindows } from '../lib/platform.js';
import { createTaskbarDriver } from '../lib/terminalProgress.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';

/**
 * The two pieces of the attention model that need the window, not the store.
 *
 *   - Seen: a terminal is seen while it is the active tab and the window has
 *     focus. The store marks it read when the active tab CHANGES in a focused
 *     window; what it cannot hear by itself is the window coming back to the
 *     front, or out of being minimised, with a terminal already active. So
 *     the window's `focus`, and `visibilitychange` to visible, call
 *     `noteWindowFocused`. And a pointer button held down anywhere in the
 *     window holds the rule until it is let go (`notePointer`).
 *   - The taskbar, on Windows only: every terminal's progress bar, added up
 *     (`taskbarProgress`), to `set_taskbar_progress` — told once per change,
 *     never twice the same, at most four times a second, and only once a bar
 *     is in use (`createTaskbarDriver`); 'none' while `terminalProgress` is
 *     off. Elsewhere nothing is sent and nothing listened for: on macOS
 *     tao's Dock bar replaces the app's Dock icon with a picture of its own
 *     (see src-tauri/src/commands/taskbar.rs).
 *
 * `startAttention` does both and returns what stops them; `useAttention` is
 * it as a hook, mounted once at the top of the app. The window, the document,
 * the stores and the sender are arguments for the suites.
 */
let warnedTaskbar = false;

const sendToTaskbar = (bar) =>
  invoke('set_taskbar_progress', { status: bar.status, progress: bar.progress }).catch((err) => {
    // Said once — a taskbar that keeps refusing would otherwise say so four
    // times a second — and handed on: the driver forgets what it sent and
    // tries once more (`createTaskbarDriver`).
    if (!warnedTaskbar) {
      warnedTaskbar = true;
      console.warn('[Attention] could not set the taskbar progress:', err);
    }
    throw err;
  });

export function startAttention({
  win = globalThis.window,
  doc = globalThis.document,
  terminals = useTerminalStore,
  settings = useSettingsStore,
  send = sendToTaskbar,
  taskbar = isWindows,
  driverOptions = {},
} = {}) {
  const seen = () => {
    try {
      terminals.getState().noteWindowFocused?.();
    } catch (err) {
      console.warn('[Attention] could not mark the active terminal read:', err);
    }
  };
  const onVisibility = () => {
    if (doc?.visibilityState === 'visible') seen();
  };
  win?.addEventListener?.('focus', seen);
  doc?.addEventListener?.('visibilitychange', onVisibility);

  // A pointer button down anywhere in the window holds the seen rule until
  // it is let go (`notePointer` in terminalStore.js): a press that makes a
  // tab active must not take its pill away, and move every chip after it,
  // before the click is over. In the capture phase, ahead of whatever the
  // press lands on; the window losing focus lets go too, its up going
  // elsewhere.
  const pointer = (pressed) => () => {
    try {
      terminals.getState().notePointer?.(pressed);
    } catch (err) {
      console.warn('[Attention] could not follow the pointer:', err);
    }
  };
  const pressed = pointer(true);
  const released = pointer(false);
  win?.addEventListener?.('pointerdown', pressed, true);
  win?.addEventListener?.('pointerup', released, true);
  win?.addEventListener?.('pointercancel', released, true);
  win?.addEventListener?.('blur', released);

  // The setting needs no listener of its own: turned off, it empties the
  // store's map (terminalStore's settings subscription), which is heard here.
  const driver = taskbar ? createTaskbarDriver({ send, ...driverOptions }) : null;
  const update = () => driver?.update(terminals.getState().progress, settings.getState().terminalProgress !== false);
  const stopProgress = driver
    ? terminals.subscribe((state, prev) => {
        if (state.progress !== prev.progress) update();
      })
    : () => {};
  // Whatever is true now. With no bar — the rule at launch — that sends
  // nothing at all.
  update();

  return () => {
    win?.removeEventListener?.('focus', seen);
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    win?.removeEventListener?.('pointerdown', pressed, true);
    win?.removeEventListener?.('pointerup', released, true);
    win?.removeEventListener?.('pointercancel', released, true);
    win?.removeEventListener?.('blur', released);
    stopProgress();
    driver?.dispose();
  };
}

/** `startAttention` for the life of the component it is mounted in — App, once. */
export function useAttention() {
  useEffect(() => startAttention(), []);
}

export default useAttention;
