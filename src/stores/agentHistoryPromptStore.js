import { create } from 'zustand';
import { dialogReturn } from '../lib/dialogReturn.js';
import { agentLabel } from '../lib/agents.js';
import { HISTORY_CAP, historyDisplay, unprotectedAfterUngrouping } from '../lib/agentHistory.js';
import { READ_ONLY_REASON } from '../components/terminal/agentSessionsModel.js';
import { useAgentHistoryStore } from './agentHistoryStore.js';
import { useTerminalStore } from './terminalStore.js';

/**
 * The questions asked before AGENT SESSIONS loses something — "Clear Agent
 * Session History?" (the side bar's menu or the palette), "Delete Agent
 * Session?" (a row's Delete…) and "Delete Group?" (a group's Delete
 * Group…) — and what the dialog draws.
 *
 * A store of its own, as pastePromptStore.js is: it persists nothing. The
 * history store's `clear`, `deleteEntry` and `deleteGroup` (agentHistoryStore.js)
 * take a `confirm` that waits on `ask`, which resolves with the answer; the
 * dialog answers through `answer`.
 *
 * `prompt` is null when nothing is being asked, else `{ id, kind, count,
 * returnTo, question }` and what the kind adds:
 *
 * - `kind` 'clear' — `count` the entries listed when it was asked;
 * - `kind` 'delete' — `key` the entry's, `count` 1;
 * - `kind` 'deleteGroup' — `groupId`, `count` its members;
 *
 * `question` is `{ title, message, confirmLabel }`, the words to draw
 * (`clearAgentHistoryQuestion`, `deleteAgentSessionQuestion`,
 * `deleteAgentGroupQuestion`), and `returnTo` what had the keyboard before
 * the palette, when the question came from there (src/lib/dialogReturn.js),
 * for the dialog to give it back to. The Clear dialog of 0.26.0 reads only
 * `id`, `count` and `returnTo`, as it always did.
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
      `${listed} will be removed from AGENT SESSIONS, with the damaged copies of the list NexTerm kept aside, and every group goes too. ` +
      'The conversations themselves stay with Claude Code and OpenCode; one still running is listed again the next time it does something.',
    confirmLabel: 'Clear',
  };
}

/** The agents' own names, as the questions say them. */
const AGENT_NAMES = { claude: 'Claude Code', opencode: 'OpenCode' };

/** What the dialog says before `entry` (as listed) is deleted from AGENT SESSIONS (F27). */
export function deleteAgentSessionQuestion(entry) {
  const shown = historyDisplay(entry);
  const label = AGENT_NAMES[entry?.kind] ?? agentLabel(entry?.kind);
  return {
    title: 'Delete Agent Session?',
    message:
      `\u{201C}${shown.title}\u{201D} (${shown.label}, ${shown.folder || shown.folderPath}) will be removed from AGENT SESSIONS. ` +
      `The conversation itself stays with ${label}, and NexTerm deletes none of its files.`,
    confirmLabel: 'Delete',
  };
}

/**
 * What the dialog says before `group` (`{ id, name }`) is deleted (F27):
 * its `members` sessions go back to the list and none is deleted. With
 * `staying` — how many of them are pinned or archived, which stay in the
 * pinned area or under Archived — it says that they leave the group and
 * that those stay where they are. With `beyondCap` — ungrouping them
 * leaves more than 200 entries the cap may drop
 * (`unprotectedAfterUngrouping`) — it adds that the oldest of those leave
 * the list at the next recorded session event (the Queen's decision 1).
 */
export function deleteAgentGroupQuestion(group, { members = 0, beyondCap = false, staying = 0 } = {}) {
  const n = Number.isInteger(members) && members > 0 ? members : 0;
  let sessions;
  if (!(Number.isInteger(staying) && staying > 0)) {
    sessions = `${n === 1 ? 'Its 1 session goes' : `Its ${n} sessions go`} back to the list; none is deleted.`;
  } else if (n === 1) {
    sessions = 'Its 1 session leaves the group and stays where it is; none is deleted.';
  } else {
    sessions = `Its ${n} sessions leave the group; pinned and archived ones stay where they are, and none is deleted.`;
  }
  return {
    title: 'Delete Group?',
    message:
      `The group \u{201C}${group?.name ?? ''}\u{201D} will be deleted. ${sessions}` +
      (beyondCap
        ? ` The oldest sessions beyond the ${HISTORY_CAP} most recently used leave the list the next time NexTerm records a session event.`
        : ''),
    confirmLabel: 'Delete',
  };
}

/** The prompt for a question of `kind`, with the history as the store holds it now. */
function promptFor(id, kind, target) {
  const { entries, groups } = useAgentHistoryStore.getState();
  if (kind === 'delete') {
    const entry = entries.find((e) => e.key === target) ?? { key: target };
    return { id, kind, key: target, count: 1, question: deleteAgentSessionQuestion(entry) };
  }
  if (kind === 'deleteGroup') {
    const group = groups.find((g) => g.id === target) ?? { id: target, name: '' };
    const inGroup = entries.filter((e) => e.groupId === target);
    const members = inGroup.length;
    const staying = inGroup.filter((e) => e.pinned === true || e.archived === true).length;
    const beyondCap = unprotectedAfterUngrouping(entries, target) > HISTORY_CAP;
    return {
      id,
      kind,
      groupId: target,
      count: members,
      question: deleteAgentGroupQuestion(group, { members, beyondCap, staying }),
    };
  }
  return { id, kind: 'clear', count: entries.length, question: clearAgentHistoryQuestion(entries.length) };
}

export const useAgentHistoryPromptStore = create((set) => ({
  prompt: null,

  /**
   * Ask a question: with no argument, whether to clear; `{ kind: 'delete',
   * key }` whether to delete that entry; `{ kind: 'deleteGroup', groupId }`
   * whether to delete that group. Resolves true for the confirming button,
   * false for anything else. A question already up is answered no first:
   * the dialog is modal, so a second one can only come from outside it, and
   * the newer one is in front.
   */
  ask: (what = null) =>
    new Promise((resolve) => {
      waiting?.resolve(false);
      const id = nextId++;
      waiting = { id, resolve };
      const kind = what?.kind === 'delete' || what?.kind === 'deleteGroup' ? what.kind : 'clear';
      const target = kind === 'delete' ? String(what.key ?? '') : kind === 'deleteGroup' ? String(what.groupId ?? '') : null;
      set({ prompt: { ...promptFor(id, kind, target), returnTo: dialogReturn() } });
    }),

  /** Answer the question on screen: true goes ahead, anything else does not. */
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
 *
 * For a list a newer NexTerm wrote (the store's `readOnly`), which this
 * build cannot clear, it asks nothing and sends nothing: the 'clearFailed'
 * notice says why (`READ_ONLY_REASON`, the words the side bar's disabled
 * item gives), and it resolves null, as a no does. The palette has no
 * disabled rows, so its command stays listed and lands here.
 */
export function clearAgentHistory() {
  if (useAgentHistoryStore.getState().readOnly) {
    useTerminalStore.getState().showAgentHistoryNotice?.('clearFailed', READ_ONLY_REASON);
    return Promise.resolve(null);
  }
  return useAgentHistoryStore.getState().clear({ confirm: () => useAgentHistoryPromptStore.getState().ask() });
}

/**
 * Delete the entry under `key` from AGENT SESSIONS after asking — a row's
 * Delete…. Resolves as the history store's `deleteEntry` does: true when it
 * went, false when there was none or it failed, null when the answer was no.
 */
export function deleteAgentSession(key) {
  return useAgentHistoryStore
    .getState()
    .deleteEntry(key, { confirm: () => useAgentHistoryPromptStore.getState().ask({ kind: 'delete', key }) });
}

/**
 * Delete the group `groupId` after asking — a group header's Delete Group….
 * Resolves as the history store's `deleteGroup` does: how many entries were
 * ungrouped, or null when the answer was no, there was no such group, or it
 * failed.
 */
export function deleteAgentGroup(groupId) {
  return useAgentHistoryStore
    .getState()
    .deleteGroup(groupId, { confirm: () => useAgentHistoryPromptStore.getState().ask({ kind: 'deleteGroup', groupId }) });
}

export default useAgentHistoryPromptStore;
