import { useEffect } from 'react';
import { listen } from '../lib/ipc.js';
import { runMenuAction } from '../lib/menuActions.js';
import { syncNativeMenu } from '../lib/nativeMenu.js';
import { useShortcuts } from './useShortcuts.js';
import { modalHeld } from '../lib/modalLock.js';

/**
 * What an item of the native menu does when it arrives (`menu` event): its
 * action — or nothing while a dialog that keeps the app still is open
 * (src/lib/modalLock.js). Behind the run dialog of a project command, Close
 * Pane and New Terminal put a new terminal where the line was going. The
 * Edit menu's Copy, Paste, Undo and Select All are the OS's own items, not
 * these, and keep working in the dialog's fields.
 */
export function onMenuEvent(id, { run = runMenuAction, modalOpen = modalHeld } = {}) {
  if (modalOpen()) return false;
  run(id);
  return true;
}

/**
 * Both directions of the native menu.
 *
 * Coming back: items arrive from Rust as a `menu` event carrying the item id
 * (see src-tauri/src/menu.rs). Only macOS has a native menu; everywhere else
 * the app draws its own, and both go through `runMenuAction` so the menu and
 * the keyboard shortcuts cannot drift apart.
 *
 * Going out: the menu is built in Rust with hardcoded accelerators, but which
 * key runs a command is the frontend's to decide now that Settings can change
 * it — so the resolved shortcuts are pushed down at startup and again whenever
 * they change. Without this a rebind changed what the key DID while the menu
 * carried on printing the old one.
 */
export function useMenuEvents() {
  useEffect(() => {
    let unlisten = null;
    let cancelled = false;

    listen('menu', (id) => onMenuEvent(id)).then((off) => {
      if (cancelled) off?.();
      else unlisten = off;
    });

    return () => {
      cancelled = true;
      if (typeof unlisten === 'function') unlisten();
    };
  }, []);

  const { bindings } = useShortcuts();

  useEffect(() => {
    // Fire and forget: the menu is chrome, and a window that came up is worth
    // more than one that refused to because its shortcuts could not be set.
    syncNativeMenu(bindings);
  }, [bindings]);
}

export default useMenuEvents;
