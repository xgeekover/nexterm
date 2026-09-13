import { create } from 'zustand';
import { loadState, saveState } from '../lib/persistence.js';

/** Where the Settings window's values live between sessions. */
export const SETTINGS_KEY = 'nexterm.settings';

/**
 * Every setting the Settings window edits, and its default.
 *
 * This is the single list: the store spreads it for its initial state, reads
 * the saved values over it, and `resetSettings` puts it back. Adding a setting
 * here is all that is needed for it to be persisted.
 */
export const SETTINGS_DEFAULTS = {
  terminalFontFamily: '',
  terminalFontSize: 12,
  terminalLineHeight: 1.5,
  terminalCursorStyle: 'bar',
  terminalCursorBlink: true,
  terminalScrollback: 5000,
  terminalTheme: 'dark-modern',
  terminalSuggestions: true,
  terminalDefaultShell: 'default',
  editorFontSize: 12,
  editorTabSize: 2,
  editorWordWrap: false,
  editorMinimap: true,
  reducedMotion: false,
};

/** Saved values, ignoring anything that is not a setting we know about. */
function loadSettings() {
  const saved = loadState(SETTINGS_KEY, null);
  if (!saved || typeof saved !== 'object') return {};
  const out = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (key in saved && typeof saved[key] === typeof SETTINGS_DEFAULTS[key]) {
      out[key] = saved[key];
    }
  }
  return out;
}

function persistSettings(state) {
  const payload = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) payload[key] = state[key];
  saveState(SETTINGS_KEY, payload);
}

export const useSettingsStore = create((set, get) => ({
  activeView: 'terminal', // 'terminal' | 'editor' | 'agents' | 'chat' | 'all' — legacy, mapped onto shell flags below
  layoutMode: 'split', // 'split' | 'single'
  isCommandPaletteOpen: false,
  commandPaletteMode: 'all', // 'all' | 'files' (⌘P quick open)
  isSettingsModalOpen: false,

  // ---- Workspace settings (the Settings window edits these) ----
  // Shapes and defaults live in SETTINGS_DEFAULTS above; whatever the user
  // last chose is read over them here. These used to live only in memory, so
  // every setting silently reverted on the next launch.
  ...SETTINGS_DEFAULTS,
  ...loadSettings(),

  // VS Code Dark Modern shell regions
  sidebarVisible: true, // primary sidebar (Explorer)
  panelVisible: true, // bottom panel (terminal)
  secondarySidebarVisible: true, // secondary sidebar (Agents)
  secondaryTab: 'agents', // 'agents' (AI Chat was removed)

  // Which region ('left' | 'right' | 'bottom') each draggable view currently
  // lives in. Not persisted — resets to the default VS Code-style layout on
  // reload. Region visibility is still governed by sidebarVisible /
  // panelVisible / secondarySidebarVisible above; this map only controls
  // which view(s) render inside whichever region is shown.
  viewLocations: {
    explorer: 'left',
    terminal: 'bottom',
    terminals: 'right',
  },

  // Legacy view switcher — kept because other subsystems still call it to
  // bring their own region into view. It no longer hides everything else;
  // it just maps the old view name onto the new shell flags.
  setActiveView: (activeView) => {
    set({ activeView });
    switch (activeView) {
      case 'editor':
        set({ sidebarVisible: true });
        break;
      case 'terminal':
        set({ panelVisible: true });
        break;
      case 'chat':
        set({ secondarySidebarVisible: true, secondaryTab: 'agents' });
        break;
      case 'agents':
        set({ secondarySidebarVisible: true, secondaryTab: 'agents' });
        break;
      case 'all':
        set({ sidebarVisible: true, panelVisible: true, secondarySidebarVisible: true });
        break;
      default:
        break;
    }
  },
  setLayoutMode: (layoutMode) => set({ layoutMode }),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),

  // No tab: plain visibility toggle. With a tab: open on that tab if closed,
  // switch to that tab if open on a different one, or close if already open
  // on that exact tab (VS Code's activity-bar-click behaviour).
  toggleSecondarySidebar: (tab) => {
    set((state) => {
      if (!tab) {
        return { secondarySidebarVisible: !state.secondarySidebarVisible };
      }
      if (state.secondarySidebarVisible && state.secondaryTab === tab) {
        return { secondarySidebarVisible: false };
      }
      return { secondarySidebarVisible: true, secondaryTab: tab };
    });
  },
  setSecondaryTab: (tab) => set({ secondaryTab: tab }),

  // Drag & drop layout: move a view ('explorer' | 'agents' | 'terminal') to
  // a region ('left' | 'right' | 'bottom'). Dropping onto the region a view
  // already occupies is a harmless no-op.
  moveView: (view, region) =>
    set((state) => ({
      viewLocations: { ...state.viewLocations, [view]: region },
    })),

  setCommandPaletteOpen: (open, mode = 'all') =>
    set({ isCommandPaletteOpen: open, commandPaletteMode: open ? mode : 'all' }),
  setSettingsModalOpen: (open) => set({ isSettingsModalOpen: open }),

  /** Defaults for every key the Settings window exposes. */
  settingsDefaults: SETTINGS_DEFAULTS,

  /** Update one setting by key, and remember it. */
  setSetting: (key, value) => {
    set({ [key]: value });
    persistSettings(get());
  },

  /** Restore every setting to its default, and remember that too. */
  resetSettings: () => {
    set({ ...SETTINGS_DEFAULTS });
    persistSettings(get());
  },
}));

export default useSettingsStore;
