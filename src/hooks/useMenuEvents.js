import { useEffect } from 'react';
import { listen } from '../lib/ipc.js';
import { runMenuAction } from '../lib/menuActions.js';

/**
 * Native menu items arrive from Rust as a `menu` event carrying the item id
 * (see src-tauri/src/menu.rs). Only macOS has a native menu; everywhere else
 * the app draws its own, and both go through `runMenuAction` so the menu and
 * the keyboard shortcuts cannot drift apart.
 */
export function useMenuEvents() {
  useEffect(() => {
    let unlisten = null;
    let cancelled = false;

    listen('menu', (id) => runMenuAction(id)).then((off) => {
      if (cancelled) off?.();
      else unlisten = off;
    });

    return () => {
      cancelled = true;
      if (typeof unlisten === 'function') unlisten();
    };
  }, []);
}

export default useMenuEvents;
