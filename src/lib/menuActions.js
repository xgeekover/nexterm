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
 * One menu entry. `keys` is the chord itself, not just the label it renders
 * to: `tests/adversarial/keybinding_table.test.js` builds the event a real
 * keypress would produce from it and checks that a binding actually claims it.
 * A menu that advertises a shortcut nothing listens for is the bug this
 * shape exists to make impossible.
 */
const item = (id, label, ...keys) => ({ id, label, keys, shortcut: chord(...keys) });

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
      item('open-folder', 'Open Folder…', 'mod', 'shift', 'o'),
      item('new-terminal', 'New Terminal', 'ctrl', 'shift', '`'),
      item('save', 'Save', 'mod', 's'),
      { type: 'separator' },
      item('preferences', 'Settings…', 'mod', ','),
      { type: 'separator' },
      item('close-window', 'Exit', 'mod', 'shift', 'w'),
    ],
  },
  {
    title: 'View',
    items: [
      item('command-palette', 'Command Palette…', 'mod', 'k'),
      item('quick-open', 'Go to File…', 'mod', 'p'),
      { type: 'separator' },
      item('toggle-sidebar', 'Toggle Primary Side Bar', 'mod', 'b'),
      item('toggle-panel', 'Toggle Terminal Panel', 'ctrl', '`'),
      item('toggle-secondary', 'Toggle Terminals Side Bar', 'mod', 'alt', 'b'),
    ],
  },
  {
    title: 'Terminal',
    items: [
      item('split-right', 'Split Right', 'mod', 'd'),
      item('split-down', 'Split Down', 'mod', 'shift', 'd'),
      item('close-pane', 'Close Pane', 'mod', 'w'),
      { type: 'separator' },
      item('clear-terminal', 'Clear Unpinned Blocks', 'mod', 'l'),
    ],
  },
];

export default { runMenuAction, MENU_BAR, windowControls };
