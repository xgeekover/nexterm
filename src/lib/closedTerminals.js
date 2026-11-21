/**
 * Reopen Closed Terminal (Bundle 2, A5-4): the terminals closed last, newest
 * first, and where one comes back.
 *
 * An entry is what a fresh shell needs to stand where the closed one stood:
 *
 *   { title, cwd, shell, groupId, paneId, index }
 *
 * `title` is the name the user typed, null for a default `Terminal N` (a
 * reopened tab takes a fresh default one), `cwd` the folder the shell was in
 * when it closed, `shell` the shell it actually ran, and the rest its place:
 * the group, the pane and the slot in that pane's strip.
 *
 * Memory only. Nothing here is saved, and an entry holds no scrollback, no
 * output, nothing typed and no agent: a reopened terminal is a NEW shell in
 * the old folder. AGENT SESSIONS is what resumes a conversation.
 */

/** How many closed terminals are remembered; the oldest goes first. */
export const CLOSED_TERMINALS_LIMIT = 10;

const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
const slot = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * One entry, with nothing in it but the six fields: a tab carries its
 * agent, its session id and its exit state, and none of them may ride along.
 */
export function closedTerminalEntry({ title = null, cwd = null, shell = null, groupId = null, paneId = null, index = null } = {}) {
  return {
    title: text(title),
    cwd: text(cwd),
    shell: text(shell),
    groupId: text(groupId),
    paneId: text(paneId),
    index: slot(index),
  };
}

/**
 * A last-in-first-out stack of at most `limit` entries. `record` puts one on
 * top and drops the oldest past the limit; `take` lifts the newest off, or
 * gives null when there is none.
 */
export function createClosedTerminals(limit = CLOSED_TERMINALS_LIMIT) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : CLOSED_TERMINALS_LIMIT;
  let entries = [];
  return {
    record(entry) {
      if (!entry || typeof entry !== 'object') return;
      entries = [...entries, closedTerminalEntry(entry)].slice(-max);
    },
    take() {
      if (entries.length === 0) return null;
      const newest = entries[entries.length - 1];
      entries = entries.slice(0, -1);
      return newest;
    },
    /** Newest first, as copies: for a test, never for the store to edit. */
    list() {
      return entries
        .slice()
        .reverse()
        .map((entry) => ({ ...entry }));
    },
    get size() {
      return entries.length;
    },
    clear() {
      entries = [];
    },
  };
}

function leavesOf(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'leaf') {
    acc.push(node);
    return acc;
  }
  for (const child of Array.isArray(node.children) ? node.children : []) leavesOf(child, acc);
  return acc;
}

const isTerminal = (leaf) => leaf?.kind !== 'editor';

/**
 * Where the entry's new terminal goes, over the groups as they are now:
 *
 *  1. its old pane, if that pane is still there, at its old slot (clamped to
 *     the strip as it is now);
 *  2. else the active terminal pane of its old group, if the group is still
 *     there and has one (the first terminal pane when the active pane is not
 *     one), at the end;
 *  3. else null: wherever a new terminal goes (`createTab`).
 *
 * `isTerminalLeaf` tells a terminal pane from a file pane; the store passes
 * its own test.
 */
export function reopenPlacement(entry, groups, { isTerminalLeaf = isTerminal } = {}) {
  if (!entry || !Array.isArray(groups)) return null;
  const group = entry.groupId ? groups.find((g) => g?.id === entry.groupId) : null;
  if (!group) return null;
  const terminals = leavesOf(group.tree).filter((leaf) => isTerminalLeaf(leaf));
  const old = entry.paneId ? terminals.find((leaf) => leaf.id === entry.paneId) : null;
  if (old) {
    const count = Array.isArray(old.tabIds) ? old.tabIds.length : 0;
    const index = entry.index == null ? count : Math.min(entry.index, count);
    return { groupId: group.id, paneId: old.id, index };
  }
  const pane = terminals.find((leaf) => leaf.id === group.activePaneId) ?? terminals[0];
  if (!pane) return null;
  return { groupId: group.id, paneId: pane.id, index: null };
}
