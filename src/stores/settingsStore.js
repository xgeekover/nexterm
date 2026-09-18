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
  /**
   * Tell me when a command finishes in a terminal I am not looking at, once it
   * has run at least this long. 0 turns it off.
   *
   * Ten seconds because that is roughly the point where you stop watching: a
   * notification per `ls` would have the whole feature switched off within a
   * minute, and one per two-minute build is the entire reason it exists.
   */
  terminalNotifyAfterSeconds: 10,
  editorFontSize: 12,
  editorTabSize: 2,
  editorWordWrap: false,
  editorMinimap: true,
  reducedMotion: false,
  /**
   * Shortcut overrides, `{ [commandId]: 'mod+shift+b' | ['a','b'] | null }`.
   * Only what the user changed — the defaults live in src/lib/keybindings.js,
   * so a command that gains a shortcut later gets it without anyone having to
   * migrate a saved file. `null` unbinds a command outright.
   */
  keybindings: {},
};

/**
 * The font sizes the app will accept, in pixels.
 *
 * One range, used by the Settings window's number fields AND by the zoom
 * commands — a user who holds ⌘- must not be able to reach a size the settings
 * UI refuses to show.
 */
export const FONT_SIZE_RANGE = { min: 8, max: 32 };

const clampFontSize = (size) =>
  Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, Math.round(size)));

/** Saved values, ignoring anything that is not a setting we know about. */
function loadSettings() {
  const saved = loadState(SETTINGS_KEY, null);
  if (!saved || typeof saved !== 'object') return {};
  const out = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (key === 'keybindings') {
      // An object, and nothing else: a saved `null` or an array here would
      // reach `resolveKeybindings` as garbage and cost the user every
      // shortcut rather than the one they mistyped.
      if (saved[key] && typeof saved[key] === 'object' && !Array.isArray(saved[key])) {
        out[key] = saved[key];
      }
      continue;
    }
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
    search: 'left',
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

  /**
   * Bring one view on screen and make it the visible one in its region.
   *
   * The activity bar lives outside `PanelLayout`, which owns "which tab of a
   * region is showing" as local state — so this is the one line of it that
   * has to be shared. `requestedView` is a request, not a second source of
   * truth: the layout honours it when that view is in that region and forgets
   * about it otherwise.
   */
  showView: (view) =>
    set((state) => {
      const region = state.viewLocations[view];
      if (!region) return {};
      const visibility =
        region === 'left'
          ? { sidebarVisible: true }
          : region === 'right'
            ? { secondarySidebarVisible: true }
            : { panelVisible: true };
      return { ...visibility, requestedView: { view, region, at: Date.now() } };
    }),

  /** The last `showView` request, or null. Cleared once the layout applies it. */
  requestedView: null,
  clearRequestedView: () => set({ requestedView: null }),

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

  /**
   * Make the text one step bigger or smaller.
   *
   * Terminal and editor move together, because "make it bigger" is about the
   * window rather than about whichever surface happens to have focus — a zoom
   * that depended on focus would be a hidden mode, and the user would have to
   * know which half they were in before pressing a key. The two sizes stay
   * independent in Settings; this only nudges both.
   *
   * Nothing else is needed to make it show: `terminalFontSize` is one of the
   * live keys terminalRegistry.js subscribes to, so every open terminal
   * re-lays out and re-reports its size to the shell on the same tick.
   */
  zoomFont: (delta) => {
    const state = get();
    set({
      terminalFontSize: clampFontSize((state.terminalFontSize ?? SETTINGS_DEFAULTS.terminalFontSize) + delta),
      editorFontSize: clampFontSize((state.editorFontSize ?? SETTINGS_DEFAULTS.editorFontSize) + delta),
    });
    persistSettings(get());
  },

  /** Both font sizes back to their defaults — the ⌘0 of every editor. */
  resetZoom: () => {
    set({
      terminalFontSize: SETTINGS_DEFAULTS.terminalFontSize,
      editorFontSize: SETTINGS_DEFAULTS.editorFontSize,
    });
    persistSettings(get());
  },

  /** Restore every setting to its default, and remember that too. */
  resetSettings: () => {
    set({ ...SETTINGS_DEFAULTS });
    persistSettings(get());
  },
}));

export default useSettingsStore;
