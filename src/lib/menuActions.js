/**
 * One place where a menu item id means something.
 *
 * The ids match `src-tauri/src/menu.rs`, so the native macOS menu bar and the
 * in-app menu NexTerm draws on Windows and Linux run exactly the same code —
 * the menu and the keyboard shortcuts cannot drift apart.
 */
import { isTauri } from './ipc.js';
import { isMac } from './platform.js';
import { DEFAULT_RESOLVED, keysFor, shortcutLabel } from './keybindings.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useEditorStore } from '../stores/editorStore.js';

/** Drive the window we are drawing chrome for. No-op in a browser. */
async function window_(method) {
  if (!isTauri()) return undefined;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  return win[method]();
}

export const windowControls = {
  minimize: () => window_('minimize'),
  toggleMaximize: () => window_('toggleMaximize'),
  close: () => window_('close'),
  isMaximized: () => window_('isMaximized'),
};

/** Run the action behind a menu item id. Unknown ids are ignored. */
export function runMenuAction(id) {
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
    case 'find-in-terminal':
      terminal.openFind?.();
      break;
    case 'search-in-files':
      settings.showView?.('search');
    case 'command-history':
      settings.setCommandPaletteOpen(true, 'history');
      break;
    case 'zoom-in':
      settings.zoomFont?.(1);
      break;
    case 'zoom-out':
      settings.zoomFont?.(-1);
      break;
    case 'zoom-reset':
      settings.resetZoom?.();
      break;
    case 'close-window':
      windowControls.close();
      break;
    default:
      break;
  }
}

/**
 * The menu NexTerm draws itself, mirroring the non-macOS half of `spec()` in
 * menu.rs: ids and labels only. What each entry is called is fixed; which key
 * runs it is not, so the chord is filled in from the bindings by `menuBarFor`.
 */
const MENU_SPEC = [
  {
    title: 'File',
    items: [
      { id: 'open-folder', label: 'Open Folder…' },
      { id: 'new-terminal', label: 'New Terminal' },
      { id: 'save', label: 'Save' },
      { type: 'separator' },
      { id: 'preferences', label: 'Settings…' },
      { type: 'separator' },
      { id: 'close-window', label: 'Exit' },
    ],
  },
  {
    title: 'View',
    items: [
      { id: 'command-palette', label: 'Command Palette…' },
      { id: 'quick-open', label: 'Go to File…' },
      { id: 'search-in-files', label: 'Search in Files…' },
      { type: 'separator' },
      { id: 'toggle-sidebar', label: 'Toggle Primary Side Bar' },
      { id: 'toggle-panel', label: 'Toggle Terminal Panel' },
      { id: 'toggle-secondary', label: 'Toggle Terminals Side Bar' },
      { type: 'separator' },
      { id: 'zoom-in', label: 'Zoom In' },
      { id: 'zoom-out', label: 'Zoom Out' },
      { id: 'zoom-reset', label: 'Reset Zoom' },
    ],
  },
  {
    title: 'Terminal',
    items: [
      { id: 'split-right', label: 'Split Right' },
      { id: 'split-down', label: 'Split Down' },
      { id: 'close-pane', label: 'Close Pane' },
      { type: 'separator' },
      { id: 'find-in-terminal', label: 'Find…' },
      { id: 'command-history', label: 'Command History…' },
      { id: 'clear-terminal', label: 'Clear Unpinned Blocks' },
    ],
  },
];

/**
 * The menu with the shortcuts actually in force.
 *
 * `key` is the chord itself, not just the label it renders to:
 * `tests/adversarial/keybinding_table.test.js` builds the event a real
 * keypress would produce from it and checks that a binding claims it. A menu
 * that advertises a shortcut nothing listens for is the bug this shape exists
 * to make impossible — and since a user can now rebind, the label has to come
 * from the same place the handler does rather than from a string beside it.
 *
 * An unbound command keeps its menu row and shows no shortcut, exactly as the
 * native menu does (see `acceleratorOverrides` in nativeMenu.js).
 */
export function menuBarFor(bindings = DEFAULT_RESOLVED) {
  return MENU_SPEC.map((menu) => ({
    ...menu,
    items: menu.items.map((entry) => {
      if (!entry.id) return entry;
      return {
        ...entry,
        key: keysFor(entry.id, bindings)[0] ?? null,
        shortcut: shortcutLabel(entry.id, bindings, { isMac }),
      };
    }),
  }));
}

/** The menu as it stands with nobody having rebound anything. */
export const MENU_BAR = menuBarFor();

export default { runMenuAction, MENU_BAR, menuBarFor, windowControls };
