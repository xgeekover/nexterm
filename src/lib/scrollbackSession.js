/**
 * This page's scrollback saving (stage 6): the one saver the app runs, the
 * tabs whose output the start brought back, and the setting.
 *
 * Kept apart from the registry so the store can reach it — closing a tab
 * forgets its file, the start says which tabs to restore — without loading
 * `@xterm/*` (see the note at the top of terminalRegistry.js). The registry
 * hands in how a terminal is read (`setScrollbackSnapshotSource`) as it
 * hands in the notice sink and the output barrier.
 */
import { invoke } from './ipc.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { createScrollbackSaver, EXIT_FLUSH_MS, pageStorage, UNTRUSTED_KEY } from './scrollbackSaver.js';
import { TAB_ID_PATTERN } from './scrollbackSnapshot.js';

/** Whether scrollback is saved and restored (Settings ▸ Terminal ▸ Restore Scrollback). */
export function scrollbackEnabled(state = useSettingsStore.getState()) {
  return state?.terminalRestoreScrollback !== false;
}

let snapshotSource = () => undefined;

/** The registry's reader: `(tabId) => snapshot | null | undefined` (see `createScrollbackSaver`). */
export function setScrollbackSnapshotSource(source) {
  snapshotSource = typeof source === 'function' ? source : () => undefined;
}

/**
 * Performance mode's view of every snapshot (src/lib/perf/perfRunner.js):
 * `(tabId, ms, snapshot)`. Null when the app is not being measured.
 */
let snapshotObserver = null;

export function setScrollbackSnapshotObserver(observer) {
  snapshotObserver = typeof observer === 'function' ? observer : null;
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function takeSnapshot(tabId) {
  const observe = snapshotObserver;
  if (!observe) return snapshotSource(tabId);
  const startedAt = clock();
  const shot = snapshotSource(tabId);
  try {
    observe(tabId, clock() - startedAt, shot);
  } catch {
    // a measurement is never worth a save
  }
  return shot;
}

const pendingListeners = new Set();

/** Every scrollback IPC call, in the backend's own argument names (`rename_all = "snake_case"`). */
export const scrollbackBackend = {
  write: (tabId, content) => invoke('scrollback_write', { tab_id: tabId, content }),
  delete: (tabId) => invoke('scrollback_delete', { tab_id: tabId }),
  retainOnly: (tabIds) => invoke('scrollback_retain_only', { tab_ids: tabIds }),
  clear: () => invoke('scrollback_clear', {}),
  read: (tabId) => invoke('scrollback_read', { tab_id: tabId }),
  setPending: (pending) => {
    for (const listener of [...pendingListeners]) {
      try {
        listener(pending);
      } catch (err) {
        console.warn('[scrollback] a listener for unsaved scrollback failed:', err);
      }
    }
  },
};

export const scrollbackSaver = createScrollbackSaver({
  snapshot: takeSnapshot,
  backend: scrollbackBackend,
  enabled: () => scrollbackEnabled(),
});

/**
 * Hear whether anything is unsaved, each time that changes — the unsaved
 * guard tells the backend (useUnsavedGuard.js). Returns the unsubscribe.
 */
export function onScrollbackPending(listener) {
  if (typeof listener !== 'function') return () => {};
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

// ---- The tabs to restore ---------------------------------------------------------

/**
 * Tabs the start brought back whose xterm has not been made yet. Filled by
 * the store's bootstrap only — never by a template, a saved group or
 * workspace, a new tab or a split — and each taken once, by the registry,
 * when it makes that tab's xterm: a remount or a move to another pane
 * reuses the xterm and never restores again.
 */
const toRestore = new Set();

/** The start restored these tabs (the store's bootstrap). */
export function markForRestore(tabIds) {
  for (const id of Array.isArray(tabIds) ? tabIds : []) {
    if (typeof id === 'string' && TAB_ID_PATTERN.test(id)) toRestore.add(id);
  }
}

/**
 * Whether `tabId`'s saved output is to be restored — true once, then never
 * again. Never while another running NexTerm keeps the saved scrollback (the
 * saver's `refused`: its files are its own, and this window saves none), nor
 * while the saver's breaker is open (`tripped`: the folder is failing).
 */
export function takeRestore(tabId) {
  return toRestore.delete(tabId) && !scrollbackSaver.refused && !scrollbackSaver.tripped;
}

/** Whether `tabId` is still waiting to be restored. For the suites. */
export function restorePending(tabId) {
  return toRestore.has(tabId);
}

/**
 * The start of the session (the store's bootstrap, after its restore or its
 * fresh start): with the setting on, the restored tabs are marked and every
 * other file is deleted — a tab that no longer exists keeps nothing on disk;
 * with it off, or with the files noted as stale, every file is. Returns the
 * tabs to restore.
 */
export function startScrollbackSession(restoredTabIds) {
  toRestore.clear();
  if (!scrollbackEnabled()) {
    scrollbackSaver.clearAll();
    return [];
  }
  // The last session's saves failed often enough to open the saver's
  // breaker, and it noted so (`untrusted`, UNTRUSTED_KEY): a clear may never
  // have reached the files, which may hold what was cleared. Nothing is
  // restored and every file is deleted — the note goes once that succeeds.
  if (scrollbackSaver.untrusted) {
    scrollbackSaver.clearAll();
    return [];
  }
  const ids = (Array.isArray(restoredTabIds) ? restoredTabIds : []).filter(
    (id) => typeof id === 'string' && TAB_ID_PATTERN.test(id)
  );
  markForRestore(ids);
  scrollbackSaver.retainOnly(ids);
  return ids;
}

/** `tabId` closed for good: not restored, and its file deleted. */
export function forgetScrollback(tabId) {
  toRestore.delete(tabId);
  return scrollbackSaver.forget(tabId);
}

/** Clear Saved Scrollback, and the setting turned off: every file deleted, nothing restored. */
export function clearSavedScrollback() {
  toRestore.clear();
  return scrollbackSaver.clearAll();
}

/** For the suites: nothing waiting to be restored or saved, no note that the files are stale, without a backend call. */
export function resetScrollbackSession() {
  toRestore.clear();
  scrollbackSaver.stop();
  pageStorage.remove(UNTRUSTED_KEY);
}

// Off: stop saving and delete every file (spec D9). Not when it turns on —
// the registry marks every terminal changed then, so what they show is
// saved (terminalRegistry.js).
useSettingsStore.subscribe((state, prev) => {
  if (scrollbackEnabled(prev) && !scrollbackEnabled(state)) clearSavedScrollback();
});

// A page going away runs no task after this one, and nothing here can make
// it wait: the flush is started, in this task (`sync`), and not awaited. The
// window's close and the quit wait for it properly (useUnsavedGuard.js);
// this is a reload, or a webview ending without either.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const flushNow = () => {
    scrollbackSaver.flushAll({ timeoutMs: EXIT_FLUSH_MS, sync: true });
  };
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', flushNow);
}
