import { useEffect } from 'react';
import { listen } from '../lib/ipc.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useEditorStore } from '../stores/editorStore.js';

/**
 * Native menu items arrive from Rust as a `menu` event carrying the item id
 * (see src-tauri/src/menu.rs). Map each id onto the same store actions the
 * keyboard shortcuts use, so menu and keys never drift apart.
 */
export function useMenuEvents() {
  useEffect(() => {
    let unlisten = null;
    let cancelled = false;

    listen('menu', (id) => {
      const settings = useSettingsStore.getState();
      const terminal = useTerminalStore.getState();
      const editor = useEditorStore.getState();
      switch (id) {
        case 'preferences':
          settings.setSettingsModalOpen?.(true);
          break;
        case 'open-folder':
          editor.pickRoot?.();
          break;
        case 'new-terminal':
          terminal.createTab?.();
          break;
        case 'save':
          if (editor.activeTabId) editor.saveFile?.(editor.activeTabId);
          break;
        case 'command-palette':
          settings.setCommandPaletteOpen(true, 'all');
          break;
        case 'quick-open':
          settings.setCommandPaletteOpen(true, 'files');
          break;
        case 'toggle-sidebar':
          settings.toggleSidebar?.();
          break;
        case 'toggle-panel':
          settings.togglePanel?.();
          break;
        case 'toggle-secondary':
          settings.toggleSecondarySidebar?.();
          break;
        case 'toggle-theme':
          settings.toggleTheme?.();
          break;
        case 'split-right':
          terminal.splitActivePane?.('horizontal');
          break;
        case 'split-down':
          terminal.splitActivePane?.('vertical');
          break;
        case 'close-pane':
          terminal.closeActivePane?.();
          break;
        case 'clear-terminal':
          terminal.clearBlocks?.();
          break;
        default:
          break;
      }
    }).then((off) => {
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
