import { create } from 'zustand';
import { invoke } from '../lib/ipc.js';

/**
 * What git says about the open folder.
 *
 * Deliberately narrow: the branch, how far it is from upstream, and which
 * files have changed. No staging, no committing, no diff — that is a second
 * application, and this one is a terminal with git already in it.
 *
 * `status` is null whenever there is nothing to say: no folder open, not a
 * repository, or no `git` on the machine. The UI shows nothing in all three
 * cases, which is the honest answer and the reason the status bar's old
 * hard-coded "main" was removed rather than replaced.
 *
 * Refreshed on demand rather than polled: the file watcher already fires on
 * every change under the root, and `refresh` coalesces so a `git checkout`
 * touching four thousand files costs one `git status`, not four thousand.
 */
const REFRESH_DEBOUNCE_MS = 400;

export const useGitStore = create((set, get) => {
  let timer = null;
  let inFlight = null;

  const read = async () => {
    try {
      const status = await invoke('git_status');
      set({ status: status ?? null, isLoaded: true });
      return status ?? null;
    } catch (err) {
      // Not an error worth showing: a backend that cannot answer is the same
      // as a folder that is not a repository.
      console.warn('[git] could not read status:', err);
      set({ status: null, isLoaded: true });
      return null;
    }
  };

  return {
    status: null,
    isLoaded: false,

    /** Read now, coalescing with anything already running. */
    refreshNow: async () => {
      if (inFlight) return inFlight;
      inFlight = read().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    /**
     * Read soon.
     *
     * A checkout or a branch switch rewrites thousands of files and the
     * watcher reports every one of them; asking git per event would spawn a
     * process per file. The last call in a burst wins.
     */
    refresh: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        get().refreshNow();
      }, REFRESH_DEBOUNCE_MS);
    },

    /** Forget everything — the folder changed, or none is open. */
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      set({ status: null, isLoaded: false });
    },
  };
});

/**
 * The status of one file, or null.
 *
 * A map is built once per status rather than scanning the list per row: the
 * Explorer asks this for every visible node on every render, and a repository
 * mid-rebase can carry thousands of entries.
 */
let cachedFiles = null;
let cachedIndex = null;

export function fileStatusIn(status, path) {
  if (!status || !path) return null;
  if (status.files !== cachedFiles) {
    cachedFiles = status.files;
    cachedIndex = new Map(status.files.map((f) => [f.path, f]));
  }
  return cachedIndex.get(path) ?? null;
}

export default useGitStore;
