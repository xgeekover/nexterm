import { create } from 'zustand';
import { usageEntry } from '../lib/resourceUsage.js';

/**
 * The CPU and memory of each terminal's programs (bundle 4, B8), as the last
 * sample found them, for Settings ▸ Terminal ▸ Show CPU and Memory.
 *
 * The latest sample only, never a history: each answer replaces the last
 * one whole, so a terminal the backend left out of it is gone too. Kept by
 * tab id (`byTab`), each entry with the PTY session it was measured in, so a
 * terminal whose shell was restarted, has exited or was closed loses its
 * figures at once (`prune`) rather than showing its old shell's.
 * `sampledAt` is when the answer came, or null for none.
 *
 * Its own store, not the terminal store's: the terminal store is read by
 * every pane and chip, and a sample every 5 s must not redraw them. Only
 * what shows the figures reads `byTab`.
 *
 * `cardsShown` counts the tab hover cards showing the figures now: the
 * sampler asks while one is (src/hooks/useResourceSampler.js). A card holds
 * one with `noteCardShown()` and lets go with what that returns.
 */
export const useResourceUsageStore = create((set, get) => ({
  /** tabId → `{ sessionId, cpuPercent, memoryBytes, processes, partial }` (`usageEntry`). */
  byTab: {},
  /** When the figures in `byTab` were sampled (ms since the epoch), or null. */
  sampledAt: null,
  /** How many hover cards showing the figures are on screen. */
  cardsShown: 0,

  /**
   * Keep one answer of `pty_resource_usage`: `answer` is its list, `tabBySession`
   * says which tab each session asked about is (a session in neither is
   * dropped), `at` when it came. `measuring`: show every CPU as measuring
   * (`usageEntry`). An answer that is not a list changes nothing.
   */
  apply: (answer, tabBySession, { at = Date.now(), measuring = false } = {}) => {
    if (!Array.isArray(answer)) return;
    const byTab = {};
    for (const item of answer) {
      const entry = usageEntry(item, { measuring });
      const tabId = entry && tabBySession?.get?.(entry.sessionId);
      if (tabId && !(tabId in byTab)) byTab[tabId] = entry;
    }
    set({ byTab, sampledAt: at });
  },

  /**
   * Drop the figures of every terminal that is gone: `live` maps each
   * running terminal's tab id to its session id; an entry whose tab is not
   * there, or runs another session now, goes.
   */
  prune: (live) => {
    const { byTab } = get();
    const ids = Object.keys(byTab);
    if (ids.length === 0) return;
    const kept = ids.filter((tabId) => live?.get?.(tabId) === byTab[tabId].sessionId);
    if (kept.length === ids.length) return;
    set({ byTab: Object.fromEntries(kept.map((tabId) => [tabId, byTab[tabId]])) });
  },

  /** Forget every figure (the setting was turned off): nothing stale can show. */
  clear: () => {
    const { byTab, sampledAt } = get();
    if (sampledAt === null && Object.keys(byTab).length === 0) return;
    set({ byTab: {}, sampledAt: null });
  },

  /** A hover card showing the figures is on screen; returns its let-go, which counts once. */
  noteCardShown: () => {
    set((s) => ({ cardsShown: s.cardsShown + 1 }));
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      set((s) => ({ cardsShown: Math.max(0, s.cardsShown - 1) }));
    };
  },
}));

export default useResourceUsageStore;
