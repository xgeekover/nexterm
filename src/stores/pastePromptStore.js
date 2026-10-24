import { create } from 'zustand';
import { PASTE_CHOICES } from '../lib/pasteWarning.js';

/**
 * The question a multi-line paste is waiting on, if any — what
 * PasteWarningDialog.jsx draws (src/lib/pasteWarning.js decides when to ask).
 *
 * A store of its own, as pathDropStore.js is: it persists nothing and is no
 * part of the layout terminalStore keeps. The terminal's binding asks through
 * `ask`, which resolves with the answer; the dialog answers through `answer`.
 * The text itself stays with the binding that captured it — only what the
 * dialog shows is here.
 *
 * `prompt` is `{ id, tabId, lines, bracketed, escape }`, or null when nothing
 * is being asked.
 */

/** The question on screen: its id and the function its answer goes to. */
let waiting = null;
let nextId = 1;

export const usePastePromptStore = create((set, get) => ({
  prompt: null,

  /**
   * Ask about a paste of `lines` lines into `tabId`'s terminal. Resolves with
   * 'paste', 'oneLine' or 'cancel'. A question already up is answered
   * 'cancel' first: the dialog is modal, so a second paste can only come from
   * outside it, and the paste in front of the user is the newer one.
   */
  ask: (tabId, { lines = 0, bracketed = false, escape = false, markersLost = false } = {}) =>
    new Promise((resolve) => {
      waiting?.resolve('cancel');
      const id = nextId++;
      waiting = { id, resolve };
      set({ prompt: { id, tabId, lines, bracketed: Boolean(bracketed), escape: Boolean(escape), markersLost: Boolean(markersLost) } });
    }),

  /** Answer the question on screen; anything but 'paste' or 'oneLine' is 'cancel'. */
  answer: (choice) => {
    const current = waiting;
    waiting = null;
    set({ prompt: null });
    current?.resolve(PASTE_CHOICES.includes(choice) ? choice : 'cancel');
  },

  /**
   * Take back the question about `tabId`'s paste, if it is the one up: its
   * terminal has closed (Ctrl+W works while the dialog is open), and Paste
   * would paste into nothing without a word. Answered 'cancel'.
   */
  withdraw: (tabId) => {
    if (get().prompt?.tabId === tabId) get().answer('cancel');
  },
}));

export default usePastePromptStore;
