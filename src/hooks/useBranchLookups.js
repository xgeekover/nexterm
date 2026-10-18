import { useEffect } from 'react';
import { invoke } from '../lib/ipc.js';
import { onCommandEnded, onProgramSignal, useTerminalStore } from '../stores/terminalStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useGitStore } from '../stores/gitStore.js';
import { useSystemStore } from '../stores/systemStore.js';
import { createBranchLookups, folderForBranch, useBranchStore } from '../stores/branchStore.js';

/**
 * When the TERMINALS side bar's branches are looked up (src/stores/
 * branchStore.js keeps them, by folder, and paces the lookups).
 *
 * What can change the branch a terminal's folder is on, and a lookup follows
 * each of them and nothing else:
 *
 *   - the terminal's folder changes — it opened, it `cd`'d (OSC 7), the shell
 *     it runs became known — and that folder is looked up;
 *   - a command ends in it — a `git checkout`, a `git switch`, a rebase —
 *     and every folder in use in the same repository is looked up: the switch
 *     was made for all of them (`onCommandEnded` in terminalStore.js, and the
 *     backend's `repo`);
 *   - the workspace's git status refreshes — the watcher saw files change,
 *     which a checkout in any terminal does to the open folder — and every
 *     folder in use is looked up (`refreshes` in gitStore.js);
 *   - a program in it notifies or rings — an agent that switched branches
 *     says nothing else until it exits — and its repository is looked up
 *     (`onProgramSignal`);
 *   - it becomes the active tab — whoever looks at it sees it as it is — and
 *     its folder is looked up.
 *
 * The last two at most once in NUDGE_MS per folder: a bell storm, or tabs
 * clicked through, are not a lookup each.
 *
 * No timer: a terminal nobody touches keeps its branch. A folder no tab uses
 * any more is forgotten. With the Show Git Branch setting off nothing is
 * looked up at all and nothing is kept; turned on, every folder in use is
 * looked up.
 *
 * `startBranchLookups` does it and returns what stops it; `useBranchLookups`
 * is it as a hook, mounted once at the top of the app — twice, and every
 * folder would be looked up twice. The stores, the event sources, the lookup,
 * the clock and the pacing are arguments for the suites.
 */
export const NUDGE_MS = 5000;

const askBackend = (dir) => invoke('git_branch', { dir });

export function startBranchLookups({
  terminals = useTerminalStore,
  settings = useSettingsStore,
  git = useGitStore,
  system = useSystemStore,
  commandEnded = onCommandEnded,
  programSignal = onProgramSignal,
  store = useBranchStore,
  lookup = askBackend,
  now = () => Date.now(),
  ...pacing
} = {}) {
  const lookups = createBranchLookups({ lookup, store, now, ...pacing });
  const enabled = () => settings.getState().terminalsPanelBranch !== false;
  // tab id -> the folder it is looked up by, or null.
  let folderOfTab = new Map();
  // folder -> when a nudge last looked it up.
  const nudged = new Map();
  const inUse = () => new Set([...folderOfTab.values()].filter(Boolean));

  // Each tab's folder now: the ones that changed are looked up, the ones no
  // tab uses are forgotten. `tabs` is a new array for many reasons — a title,
  // a running command, an exit code — and only a folder that changed counts.
  const sync = () => {
    const os = system.getState().os;
    const next = new Map();
    for (const tab of terminals.getState().tabs || []) {
      if (tab) next.set(tab.id, folderForBranch(tab, os));
    }
    if (enabled()) {
      for (const [id, folder] of next) {
        if (folder && folderOfTab.get(id) !== folder) lookups.request(folder);
      }
    }
    folderOfTab = next;
    const used = inUse();
    for (const folder of lookups.known()) {
      if (!used.has(folder)) lookups.forget(folder);
    }
    for (const folder of nudged.keys()) {
      if (!used.has(folder)) nudged.delete(folder);
    }
  };

  // Every trigger but a folder changing only refreshes: a folder whose
  // lookup timed out a moment ago is left alone by these (`refresh`).
  const lookUpAll = () => {
    if (!enabled()) return;
    for (const folder of inUse()) lookups.refresh(folder);
  };

  // `folder`, and every folder in use that its last answer put in the same
  // repository.
  const lookUpRepository = (folder) => {
    lookups.refresh(folder);
    const repo = lookups.repoOf(folder);
    if (!repo) return;
    for (const other of inUse()) {
      if (other !== folder && lookups.repoOf(other) === repo) lookups.refresh(other);
    }
  };

  // A nudge — a program calling, the tab coming to the front — counts once in
  // NUDGE_MS per folder.
  const nudge = (tabId, look) => {
    if (!enabled()) return;
    const folder = folderOfTab.get(tabId);
    if (!folder) return;
    const at = now();
    const last = nudged.get(folder);
    if (last !== undefined && at - last < NUDGE_MS) return;
    nudged.set(folder, at);
    look(folder);
  };

  const stops = [
    terminals.subscribe((state, prev) => {
      if (state.tabs !== prev.tabs) sync();
      if (state.activeTabId !== prev.activeTabId && state.activeTabId) {
        nudge(state.activeTabId, (folder) => lookups.refresh(folder));
      }
    }),
    // The platform arrives from the backend after the first render; until
    // then a Git Bash folder is read as it is spelled. Every folder is read
    // again.
    system.subscribe((state, prev) => {
      if (state.os === prev.os) return;
      folderOfTab = new Map();
      sync();
    }),
    git.subscribe((state, prev) => {
      if (state.refreshes !== prev.refreshes) lookUpAll();
    }),
    settings.subscribe((state, prev) => {
      const on = state.terminalsPanelBranch !== false;
      if (on === (prev.terminalsPanelBranch !== false)) return;
      if (on) lookUpAll();
      else lookups.clear();
    }),
    commandEnded((tabIds) => {
      if (!enabled() || !Array.isArray(tabIds)) return;
      for (const id of tabIds) {
        const folder = folderOfTab.get(id);
        if (folder) lookUpRepository(folder);
      }
    }),
    programSignal((tabId) => nudge(tabId, lookUpRepository)),
  ];

  sync();
  if (!enabled()) lookups.clear();

  return () => {
    for (const stop of stops) stop();
    lookups.stop();
  };
}

/** `startBranchLookups` for the life of the component it is mounted in — App, once. */
export function useBranchLookups() {
  useEffect(() => startBranchLookups(), []);
}

export default useBranchLookups;
