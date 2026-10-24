import { create } from 'zustand';
import { loadState, saveState } from '../lib/persistence.js';
import { defaultRightClick } from '../lib/terminalRightClick.js';
import { sanitizeCustomThemes } from '../lib/themeImport.js';

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
  /**
   * Terminal themes the user imported in the gallery (spec P5): at most 20
   * `{ id: 'custom:<slug>', label, theme }`, where `theme` holds only the
   * colours the file gave — the rest are the default theme's, as drawn. The
   * second object setting after `keybindings`, and checked as strictly on
   * load: see `sanitizeCustomThemes` in src/lib/themeImport.js.
   */
  terminalCustomThemes: [],
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
  /**
   * What a right-click in a terminal does. 'copyPaste': copy the selection
   * when one is on screen, paste otherwise — and the program under the
   * pointer never hears of it, full-screen ones included. Shift+right-click
   * stays the terminal's. 'default': left to xterm, the program and the
   * webview, as before.
   *
   * The one default that depends on the platform, because each platform's own
   * terminals disagree: Windows Terminal (and VS Code there) copy or paste,
   * Terminal.app and GNOME Terminal open a menu. 'copyPaste' on Windows,
   * 'default' elsewhere; like every default here it is not written to
   * storage, so an untouched setting follows the platform it runs on. See
   * src/lib/terminalRightClick.js.
   */
  terminalRightClick: defaultRightClick(),
  /**
   * Ask before pasting two or more lines (VS Code's
   * `terminal.integrated.enableMultiLinePasteWarning`). 'auto' asks only
   * while the program has not turned bracketed paste on, so each line would
   * run as it arrives — cmd never turns it on; zsh, OpenCode and Claude Code
   * do. 'always' asks for every such paste, 'never' for none. See
   * src/lib/pasteWarning.js.
   */
  terminalMultiLinePasteWarning: 'auto',
  /**
   * After a Ctrl+C in a cmd terminal, answer cmd's "Terminate batch job
   * (Y/N)?" with Y (VS Code's `terminal.integrated.autoReplies`, which ships
   * this one reply). OpenCode runs in cmd through npm's `opencode.cmd`, so
   * every Ctrl+C out of it ends in that question, and a second Ctrl+C reaching
   * cmd while it asks has ended cmd itself. Only cmd's own question, new
   * since the Ctrl+C, and nothing typed in between; once. See
   * src/lib/batchJobReply.js.
   */
  terminalAutoReplyBatchJob: true,
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
   * What a pane made by splitting starts as (VS Code's
   * `terminal.integrated.splitCwd`): `inherited` continues the terminal being
   * split — its directory and its shell — and `default` is a new terminal
   * like any other. See `splitStartFor` in src/lib/terminalCwd.js.
   */
  terminalSplitCwd: 'inherited',
  /**
   * A pane holding a single terminal draws no tab strip, and the terminal
   * gets its height (spec P1). The strip comes back over the terminal's top
   * edge when the pointer reaches it, during a drag (so a tab can still be
   * dropped there), and while its menu or a rename is open — laid over the
   * terminal, so it never resizes it. A second terminal in the pane brings
   * the real strip back. Off by default: the strip is where people look for
   * a terminal's name, and hiding it is a choice. See stripReveal.js.
   */
  terminalHideSingleTabStrip: false,
  /**
   * A new split gives every pane in its line the same share (spec P2) —
   * three panes side by side a third each, rather than the split pane halved
   * and the rest kept. Off by default, so sizes set by hand are kept; the
   * "Equalize Splits" command does it once, on demand. See splitLayout.js.
   */
  terminalEqualizeOnSplit: false,
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
  /**
   * Flash a pane's attention ring, once, when a notification or the bell is
   * aimed at the terminal you are typing into. Off by default: what you are
   * looking at needs no telling, and nothing is recorded for it either way —
   * this only adds a glance for those who want one. See `attentionFlash` in
   * terminalStore.js.
   */
  terminalAttentionFlashFocused: false,
  /**
   * A terminal's bell — a BEL a program prints when it wants you — rings that
   * terminal's pane and counts in the status bar's bell, as a notification
   * would; never on the desktop. Off: the bell is ignored, as it always was.
   * See `bellFromTerminal` in terminalStore.js.
   */
  terminalBellAttention: true,
  /**
   * Show the progress a program reports (ConEmu's OSC 9;4, which winget and
   * Claude Code send) as a bar on its tab, and on Windows on the taskbar
   * button — not on the macOS Dock (see src-tauri/src/commands/taskbar.rs).
   * Read as each report arrives; turning it off takes every bar down at once.
   * See src/lib/terminalProgress.js.
   */
  terminalProgress: true,
  /**
   * What each row of the TERMINALS side bar shows besides its title. With
   * any of the second-line items on, every row is two lines of the same
   * height, so nothing moves under the pointer when one of them changes; with
   * all of them off, rows are one line, as before. See src/lib/
   * terminalStatus.js.
   *
   * - Folder: where the terminal is, on the right of its first line — what
   *   the side bar has always shown.
   * - Git Branch: the branch that folder is on, read from the repository's
   *   `HEAD` by the backend (`git_branch`) when the folder changes, a command
   *   ends in the terminal, or the workspace's git status refreshes — never
   *   on a timer. Off: nothing is looked up at all (src/stores/
   *   branchStore.js).
   * - Agent and Status: which agent runs in it, and what it is doing as one
   *   state — waiting for you, failed, running, a program's progress.
   * - Last Notification: the last thing it told you, read or not.
   */
  terminalsPanelFolder: true,
  terminalsPanelBranch: true,
  terminalsPanelAgent: true,
  terminalsPanelLastNote: true,
  /**
   * Show the side bar's groups, and the terminals in each pane, most urgent
   * first: waiting for you, then failed, then still working, then idle, then
   * exited — the user's own order among equals. Only the side bar's: the
   * order the groups and tabs are kept in never changes, and turning this off
   * shows it again.
   */
  terminalsPanelSortAttention: false,
  editorFontSize: 12,
  editorTabSize: 2,
  editorWordWrap: false,
  editorMinimap: true,
  /**
   * Reopen the files a folder had open — its editor groups, which tab each
   * showed, which was active — when that folder opens again, at launch or
   * from Open Folder / Open Recent (VS Code keeps them per workspace). Only
   * the files: a reopened tab reads what is on disk, never unsaved edits.
   * Off: nothing is reopened, and what was remembered is forgotten. See
   * src/lib/editorSession.js.
   */
  editorRestoreTabs: true,
  /**
   * Delete in the Explorer moves to the Trash — the Recycle Bin on Windows
   * (VS Code's `files.enableTrash`). Where there is none, or the move fails,
   * nothing is deleted until a second question says it will be for good.
   * Off: the permanent delete, after one question, as before. See
   * src-tauri/src/fs/trash.rs.
   */
  filesEnableTrash: true,
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
    if (key === 'terminalCustomThemes') {
      // Entry by entry: one theme a hand edit broke is dropped, the rest
      // load. A list of anything else would reach the registry's resolver
      // and the gallery as colours nobody checked.
      if (key in saved) out[key] = sanitizeCustomThemes(saved[key]);
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

/** The views that can be dragged between regions, in the order a region lists them. */
const VIEW_ORDER = ['explorer', 'search', 'terminal', 'terminals'];

/** The flag that shows each region. */
const REGION_SHOWN = { left: 'sidebarVisible', right: 'secondarySidebarVisible', bottom: 'panelVisible' };

/** The views a region hosts, in tab order. */
export function viewsIn(viewLocations, region) {
  return VIEW_ORDER.filter((view) => viewLocations?.[view] === region);
}

/**
 * The view a region shows: the one last chosen there — by its tab, the
 * activity bar or a shortcut — while it is still there, or else the region's
 * first. Null for a region with no views.
 *
 * One answer, read by the layout that draws the region and by the activity
 * bar that lights the icon for it. The activity bar used to work it out from
 * the last `showView` request, which the layout drops as soon as it has
 * applied it: with Search on screen the Explorer was lit, and a click on the
 * Explorer hid the side bar instead of showing the Explorer.
 */
export function shownView({ viewLocations, chosenViews }, region) {
  const views = viewsIn(viewLocations, region);
  const chosen = chosenViews?.[region];
  return views.includes(chosen) ? chosen : views[0] ?? null;
}

/** Whether `view` is on screen: its region is showing, and showing it. */
export function isViewShown(state, view) {
  const region = state.viewLocations?.[view];
  return Boolean(region && state[REGION_SHOWN[region]] && shownView(state, region) === view);
}

export const useSettingsStore = create((set, get) => ({
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
  secondarySidebarVisible: true, // secondary sidebar (Terminals)

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

  // The view last chosen in each region that hosts more than one — the
  // primary side bar holds the Explorer and Search. Read through `shownView`,
  // which falls back to a region's first view. Not persisted either.
  chosenViews: {},
  chooseView: (region, view) =>
    set((state) => ({ chosenViews: { ...state.chosenViews, [region]: view } })),

  // Bring the region a view lives in on screen: the palette opens a file
  // ('editor') or a terminal ('terminal') where it can be seen.
  setActiveView: (view) => {
    switch (view) {
      case 'editor':
        set({ sidebarVisible: true });
        break;
      case 'terminal':
        set({ panelVisible: true });
        break;
      case 'all':
        set({ sidebarVisible: true, panelVisible: true, secondarySidebarVisible: true });
        break;
      default:
        break;
    }
  },

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),

  toggleSecondarySidebar: () => set((state) => ({ secondarySidebarVisible: !state.secondarySidebarVisible })),

  /**
   * Bring one view on screen and make it the visible one in its region.
   *
   * Which tab of a region is showing is `chosenViews`, here rather than in
   * `PanelLayout`, so the activity bar, which lives outside the layout, reads
   * the same answer the layout draws (see `shownView`).
   */
  showView: (view) =>
    set((state) => {
      const region = state.viewLocations[view];
      if (!region) return {};
      return {
        [REGION_SHOWN[region]]: true,
        chosenViews: { ...state.chosenViews, [region]: view },
        requestedView: { view, region, at: Date.now() },
      };
    }),

  /**
   * What an activity-bar icon does, as in VS Code: show its view, or hide the
   * view's region when that view is already the one on screen.
   */
  toggleView: (view) => {
    const state = get();
    const region = state.viewLocations[view];
    if (!region) return;
    if (isViewShown(state, view)) set({ [REGION_SHOWN[region]]: false });
    else state.showView(view);
  },

  /**
   * The last `showView` request, or null: that a view was asked for, and
   * when. Dropped once the layout has drawn it, so it never lingers as an
   * account of which view is showing — `chosenViews` is that.
   */
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

  /**
   * A terminal theme being tried in the Settings window's gallery, shown on
   * every terminal until it is chosen or let go — or null. Not a setting: it
   * is outside SETTINGS_DEFAULTS, so it is never saved, and a preview cannot
   * outlive the window that made it. Read through terminalThemes.js's
   * `shownTerminalThemeId`.
   */
  terminalThemePreview: null,
  previewTerminalTheme: (themeId) => {
    const next = themeId ?? null;
    if (get().terminalThemePreview !== next) set({ terminalThemePreview: next });
  },

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
