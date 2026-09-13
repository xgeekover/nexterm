/**
 * One place where a menu item id means something.
 *
 * The ids match `src-tauri/src/menu.rs`, so the native macOS menu bar and the
 * in-app menu NexTerm draws on Windows and Linux run exactly the same code —
 * the menu and the keyboard shortcuts cannot drift apart.
 */
import { isTauri } from './ipc.js';
import { chord } from './platform.js';
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
    case 'close-window':
      windowControls.close();
      break;
    default:
      break;
  }
}

/**
 * The menu NexTerm draws itself, mirroring the non-macOS half of `spec()` in
 * menu.rs. The shortcut strings are labels only — off macOS these chords are
 * served by useKeybindings.js rather than by a native accelerator, precisely
 * so the terminal can win them back when it has focus.
 */
export const MENU_BAR = [
  {
    title: 'File',
    items: [
      { id: 'open-folder', label: 'Open Folder…', shortcut: chord('mod', 'shift', 'o') },
      { id: 'new-terminal', label: 'New Terminal', shortcut: chord('ctrl', 'shift', '`') },
      { id: 'save', label: 'Save', shortcut: chord('mod', 's') },
      { type: 'separator' },
      { id: 'preferences', label: 'Settings…', shortcut: chord('mod', ',') },
      { type: 'separator' },
      { id: 'close-window', label: 'Exit', shortcut: chord('mod', 'shift', 'w') },
    ],
  },
  {
    title: 'View',
    items: [
      { id: 'command-palette', label: 'Command Palette…', shortcut: chord('mod', 'k') },
      { id: 'quick-open', label: 'Go to File…', shortcut: chord('mod', 'p') },
      { type: 'separator' },
      { id: 'toggle-sidebar', label: 'Toggle Primary Side Bar', shortcut: chord('mod', 'b') },
      { id: 'toggle-panel', label: 'Toggle Terminal Panel', shortcut: chord('ctrl', '`') },
      { id: 'toggle-secondary', label: 'Toggle Terminals Side Bar', shortcut: chord('mod', 'alt', 'b') },
    ],
  },
  {
    title: 'Terminal',
    items: [
      { id: 'split-right', label: 'Split Right', shortcut: chord('mod', 'd') },
      { id: 'split-down', label: 'Split Down', shortcut: chord('mod', 'shift', 'd') },
      { id: 'close-pane', label: 'Close Pane', shortcut: chord('mod', 'w') },
      { type: 'separator' },
      { id: 'clear-terminal', label: 'Clear Unpinned Blocks', shortcut: chord('mod', 'l') },
    ],
  },
];

export default { runMenuAction, MENU_BAR, windowControls };
