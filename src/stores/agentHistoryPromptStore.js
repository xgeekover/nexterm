import { create } from 'zustand';
import { dialogReturn } from '../lib/dialogReturn.js';
import { useAgentHistoryStore } from './agentHistoryStore.js';

/**
 * "Clear Agent Session History?" — the question asked before the AGENT
 * SESSIONS list is emptied, from the side bar's menu or the palette — and
 * what AgentHistoryClearDialog.jsx draws.
 *
 * A store of its own, as pastePromptStore.js is: it persists nothing. The
 * history store's `clear({ confirm })` (agentHistoryStore.js) waits on
 * `ask`, which resolves with the answer; the dialog answers through `answer`.
 *
 * `prompt` is `{ id, count, returnTo }`, or null when nothing is being asked:
 * `count` the entries listed when it was asked, `returnTo` what had the
 * keyboard before the palette, when the question came from there
 * (src/lib/dialogReturn.js), for the dialog to give it back to.
 */

/** The question on screen: its id and the function its answer goes to. */
let waiting = null;
let nextId = 1;

/** What the dialog says, for `count` entries. */
export function clearAgentHistoryQuestion(count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  const listed = n === 1 ? '1 entry' : `${n} entries`;
  return {
    title: 'Clear Agent Session History?',
    message:
      `${listed} will be removed from AGENT SESSIONS, with the damaged copies of the list NexTerm kept aside. ` +
      'The conversations themselves stay with Claude Code and OpenCode; one still running is listed again the next time it does something.',
    confirmLabel: 'Clear',
  };
}

export const useAgentHistoryPromptStore = create((set) => ({
  prompt: null,

  /**
   * Ask whether to clear. Resolves true for Clear, false for anything else.
   * A question already up is answered no first: the dialog is modal, so a
   * second one can only come from outside it, and the newer one is in front.
   */
  ask: () =>
    new Promise((resolve) => {
      waiting?.resolve(false);
      const id = nextId++;
      waiting = { id, resolve };
      set({ prompt: { id, count: useAgentHistoryStore.getState().entries.length, returnTo: dialogReturn() } });
    }),

  /** Answer the question on screen: true clears, anything else does not. */
  answer: (yes) => {
    const current = waiting;
    waiting = null;
    set({ prompt: null });
    current?.resolve(yes === true);
  },
}));

/**
 * Empty the agent session history after asking — what the side bar's
 * "Clear Agent Session History…" and the palette's run. Resolves as the
 * history store's `clear` does: how many entries went, or null when the
 * answer was no or the clear failed.
 */
export function clearAgentHistory() {
  return useAgentHistoryStore.getState().clear({ confirm: () => useAgentHistoryPromptStore.getState().ask() });
}

export default useAgentHistoryPromptStore;
