/**
 * Dropping paths on a terminal pane, bound to the live app: the terminal
 * store's layout, the settings and the machine the shells run on, and the
 * xterm registry that takes the paste. What a drop DOES is decided in
 * src/lib/terminalFileDrop.js, where Node can test it; this file only hands
 * that the real things. Shared by both ways of dropping — files from the OS
 * (src/hooks/useTerminalFileDrop.js) and a row of NexTerm's own Explorer
 * (src/hooks/useExplorerPathDrag.js).
 */
import { useTerminalStore, isTabClosing } from '../../stores/terminalStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { performPathInsert, planPathInsert, showTabInPane } from '../../lib/terminalFileDrop.js';
import { pasteIntoTerminal } from './terminalRegistry.js';

/** What `planPathInsert` needs to know besides the layout, read as it is now. */
function dropEnvironment() {
  const system = useSystemStore.getState();
  return {
    platform: system.os,
    defaultShell: useSettingsStore.getState().terminalDefaultShell,
    systemShell: system.defaultShell,
    isClosing: isTabClosing,
  };
}

/**
 * What dropping `paths` on `paneId` would do now, without doing it — what the
 * highlight shows while a drag is over the pane. See `planPathInsert`.
 */
export function planPathsIntoPane(paneId, paths) {
  return planPathInsert(useTerminalStore.getState(), paneId, paths, dropEnvironment());
}

/**
 * Insert `paths` into the terminal `paneId` is showing: the pane becomes the
 * active one, as a click on it would make it, with the tab that takes the
 * paths as its active tab (`showTabInPane`), and the paths are pasted into
 * that terminal, which takes the keyboard. Returns what happened (see
 * `performPathInsert`).
 */
export function insertPathsIntoPane(paneId, paths) {
  return performPathInsert(planPathsIntoPane(paneId, paths), {
    activate: (targetPaneId, tabId) => showTabInPane(useTerminalStore, targetPaneId, tabId),
    paste: pasteIntoTerminal,
  });
}
