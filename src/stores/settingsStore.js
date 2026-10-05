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
 *
 * Changing a default here reaches everyone who has not changed that setting
 * themselves, because storage holds only what differs from this list.
 * `persistSettings` says what that means for a payload saved by v0.6.x or
 * earlier, which holds every key.
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
  /**
   * The bar naming the command you are scrolled into.
   *
   * On by default because it is absent most of the time — it appears only
   * while the view is scrolled back, never over a full-screen program, and
   * never for a command the view did not see typed. The reason to turn it off
   * is that a sticky header covers the row it describes, as every sticky
   * header does, and that row is sometimes the one you scrolled up to read.
   */
  terminalStickyHeader: true,
  /**
   * Copy a selection to the clipboard the moment the mouse makes it — a drag,
   * a double- or triple-click. Warp's default, and the reason a selection can
   * be pasted elsewhere without a second key. Only mouse selections: a find
   * match is a selection too, and stepping through matches must not overwrite
   * the clipboard. See src/lib/terminalClipboard.js.
   */
  terminalCopyOnSelect: true,
  /**
   * Let a full-screen program (vim, htop, tmux — anything on the alternate
   * screen) have the mouse when it asks for it. A program in the scrollback —
   * the shell, Claude Code — never gets it, so a drag there always selects;
   * inside a full-screen program Shift-drag (and ⌥-drag on macOS) selects.
   * Off: no program gets the mouse, as in Warp with mouse reporting off. See
   * src/lib/mouseReporting.js.
   */
  terminalMouseReporting: true,
  terminalDefaultShell: 'default',
  /**
   * Where a NEW terminal starts, when nothing has asked for a directory.
   *
   * `workspace` is what the app has always done and stays the default. The
   * value is a keyword rather than a path so that `workspace` and `home`
   * follow the machine rather than being frozen the day they were chosen;
   * `custom` reads `terminalDefaultCwdPath`.
   *
   * This never overrules a directory that WAS asked for — restoring a session
   * hands each terminal its saved cwd, and that has to win. See `spawnTab`.
   */
  terminalDefaultCwd: 'workspace',
  /** The directory `terminalDefaultCwd: 'custom'` means. `~` is expanded. */
  terminalDefaultCwdPath: '',
  /**
   * Tell me when a command finishes in a terminal I am not looking at, once it
   * has run at least this long. 0 turns it off.
   *
   * Ten seconds because that is roughly the point where you stop watching: a
   * notification per `ls` would have the whole feature switched off within a
   * minute, and one per two-minute build is the entire reason it exists.
   */
  terminalNotifyAfterSeconds: 10,
  /**
   * Show what a program in a terminal asks to tell you — OpenCode's "Session
   * done" or "Permission needs input", Claude Code waiting for you — in the
   * status bar's bell, and as a desktop notification while NexTerm is in the
   * background. A program sends these only once it is set up to (see the
   * README), and never about the terminal you are typing into.
   *
   * Read as each one arrives, so turning it off takes effect at once: they
   * are dropped, and NexTerm stops answering OpenCode's question about which
   * kind it understands. See src/lib/programNotifications.js.
   */
  terminalProgramNotifications: true,
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

/**
 * Saved values, ignoring anything that is not a setting we know about.
 *
 * Most keys are absent — storage holds only what the user changed — and an
 * absent key keeps the default the store starts from.
 */
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

/**
 * Whether two setting values are the same, for deciding what counts as a change.
 *
 * Primitives compare with `Object.is`, the test the Settings window uses to
 * decide whether a row offers Reset — so a row that offers Reset is exactly a
 * setting that is saved. Objects and arrays compare by content, in any key
 * order. `keybindings` is the one object among the defaults, and the Keyboard
 * Shortcuts section builds a new map on every edit, so a map emptied one reset
 * at a time is `{}` like the default without ever being the default's own
 * object.
 */
function sameSetting(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameSetting(a[key], b[key]))
  );
}

/**
 * Save the settings that differ from their defaults, and only those.
 *
 * This used to write every key. A saved key wins over the default at the next
 * launch, so the first change anyone made to any setting froze every default
 * of that day into their storage, and a default changed by a later release
 * never reached them. Now a setting nobody changed is absent and follows the
 * release that is running, as in VS Code's settings.json, and one put back to
 * its default — by its row's Reset, by Reset All, by ⌘0 — leaves storage.
 *
 * A payload written by v0.6.x or earlier holds every key. It loads exactly as
 * it did and is left as written until the next save, which drops the values
 * equal to today's defaults. A value equal to an OLDER default but not today's
 * stays: nothing in the payload says whether the user chose it or never
 * touched it, and guessing wrong would take away a setting someone picked.
 *
 * The payload is built from the store rather than merged into what was saved,
 * so a key this build does not know, or one of the wrong type, is not carried
 * forward — the next save drops it, as it always has.
 */
function persistSettings(state) {
  const payload = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (!sameSetting(state[key], SETTINGS_DEFAULTS[key])) payload[key] = state[key];
  }
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

  /**
   * Restore every setting to its default, and remember that too — by saving
   * nothing at all, so from then on every setting follows the defaults of
   * whichever release is running.
   */
  resetSettings: () => {
    set({ ...SETTINGS_DEFAULTS });
    persistSettings(get());
  },
}));

export default useSettingsStore;
