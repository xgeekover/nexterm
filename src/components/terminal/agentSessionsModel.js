/**
 * AGENT SESSIONS in the side bar, as plain data (F25-F27, F30): which rows
 * each part of the section draws, and the items of its three menus — a row's,
 * a group header's and the section header's — with the reason each disabled
 * item gives. TerminalsPanel.jsx only wires these to the history store
 * (src/stores/agentHistoryStore.js) and the questions
 * (src/stores/agentHistoryPromptStore.js); nothing here writes anything.
 *
 * The menu builders return what `ContextMenu` takes: `{ key, label, icon?,
 * danger?, disabled?, disabledReason?, onSelect }` and `{ type: 'separator',
 * key }`. What an item does comes in `on`, one callback per action, so the
 * builders can be exercised without React or a store.
 */
import { HISTORY_MAX_GROUPS, agentSessionSections, entryGroupId, forkedFromText, historyDisplay, historyTitle } from '../../lib/agentHistory.js';
import { isKnownAgent, isSessionIdFor } from '../../lib/agents.js';

/**
 * How many rows the ungrouped list, and the Archived sub-list, draw before
 * "Show all (N)…", which opens the palette's Resume Agent Session… on every
 * entry.
 */
export const AGENT_SESSIONS_SHOWN = 15;

/** Why every curation item is off for a list a newer NexTerm wrote (F30). */
export const READ_ONLY_REASON = 'A newer NexTerm wrote this list; this version only reads it';
/** Why Copy Session ID is off for an entry without an id (F26). */
export const NO_SESSION_ID_REASON = "NexTerm does not know this session's id";
/**
 * Why Delete… is off while a terminal of this window runs the entry (F26):
 * the recorder would list it again at its next event, which a live title
 * makes immediate.
 */
export const RUNNING_HERE_REASON = 'It is running in a terminal of this window; end the agent first';
/** Why the entry's own group is off in Move to Group ▸ (F26). */
export const SAME_GROUP_REASON = 'It is already in this group';
/**
 * Why Fork Conversation is off for an OpenCode entry (F5): only Claude Code
 * forks a conversation by id here (`claude --resume <id> --fork-session`).
 */
export const FORK_OPENCODE_REASON = 'OpenCode conversations cannot be forked here';
/** Why it is off for an entry of an agent this build does not know. */
export const FORK_UNKNOWN_REASON = 'Only Claude Code conversations can be forked here';
/** Why Remove from Group is off for an entry in no group (F26). */
export const NOT_GROUPED_REASON = 'It is not in a group';
/** Why New Group… is off at the backend's limit (F27; the backend's TOO_MANY_GROUPS says the same). */
export const TOO_MANY_GROUPS_REASON = `There can be at most ${HISTORY_MAX_GROUPS} agent session groups`;
/** Why Resume Agent Session… is off with nothing listed. */
export const NO_SESSIONS_REASON = 'There are no agent sessions yet';
/** Why Clear Agent Session History… is off with no entry and no group. */
export const NOTHING_TO_CLEAR_REASON = 'There are no agent sessions to clear';

/** How many recent agent sessions an empty terminal pane offers (bundle 1, A2, F8). */
export const LAUNCHER_SESSIONS_SHOWN = 3;

/**
 * The agent sessions an empty terminal pane offers to resume (A2, F8): at
 * most `max` entries of the store's `entries`, newest `lastUsedAt` first
 * (entries used at the same time keep the order they came in), leaving out
 * archived ones, agents this build does not know and anything without a
 * key. Pinned and grouped entries count like the rest. The list is not
 * changed. Nothing here runs or reads anything.
 */
export function launcherSessions(entries, max = LAUNCHER_SESSIONS_SHOWN) {
  const limit = Number.isInteger(max) && max > 0 ? max : 0;
  if (limit === 0 || !Array.isArray(entries)) return [];
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e && typeof e === 'object' && typeof e.key === 'string' && e.key !== '' && e.archived !== true && isKnownAgent(e.kind))
    .sort((a, b) => (Number(b.e.lastUsedAt) || 0) - (Number(a.e.lastUsedAt) || 0) || a.i - b.i)
    .slice(0, limit)
    .map(({ e }) => e);
}

/** `item`, off with `reason` when there is one. */
const off = (item, reason) => (reason ? { ...item, disabled: true, disabledReason: reason } : item);
/** `item` with `icon` when one is given. */
const withIcon = (item, icon) => (icon ? { ...item, icon } : item);

/** Whether `holder` (the history store's `holders[key]`) is a terminal of this window running the entry. */
export function isRunningHere(holder) {
  return holder?.state === 'open';
}

/** The group `entry` is in, among `groups` (the store's `{ id, name, collapsed }`), or null. */
export function groupOfEntry(entry, groups) {
  const id = entryGroupId(entry);
  if (id === null || !Array.isArray(groups)) return null;
  return groups.find((g) => g?.id === id) ?? null;
}

/**
 * The tooltip of `entry`'s AGENT SESSIONS row, line by line: the agent and
 * what the row is called, the agent's own title of a renamed row, the
 * conversation a fork was forked from (`forkedFromText`, by `entries`, the
 * history's), its group (among `groups`), its folder, when it was last used
 * (`when`, already in words), whether a terminal of this window holds it
 * (`holder`, the history store's `holders[key]`), and what a double-click
 * does.
 */
export function agentSessionTooltip(entry, { entries = [], groups = [], holder = null, when = '' } = {}) {
  const shown = historyDisplay(entry);
  const group = groupOfEntry(entry, groups);
  const forked = forkedFromText(entry, entries);
  return [
    `${shown.label}: ${shown.title}`,
    // A renamed row still tells what the agent calls it.
    ...(shown.name && shown.autoTitle && shown.autoTitle !== shown.name ? [`Its own title: ${shown.autoTitle}`] : []),
    ...(forked ? [forked] : []),
    ...(group ? [`In the group ${group.name}`] : []),
    shown.folderPath,
    `Last used ${when}`,
    ...(holder ? [`${holder.state === 'open' ? 'Open' : 'Offered for resuming'} in a terminal of this window`] : []),
    `${holder ? 'Double-click to show its terminal' : 'Double-click to resume in a new terminal'} · right-click for more`,
  ].join('\n');
}

/**
 * What Rename… puts in the editor for `entry` (F26): the title the row shows
 * when it has a name or an automatic title, else nothing — a short id or
 * "most recent in folder" is not a name to edit.
 */
export function renamePrefill(entry) {
  const shown = historyDisplay(entry);
  return shown.titled ? shown.title : '';
}

/**
 * What the AGENT SESSIONS section draws (F25), from the store's `entries`
 * and `groups`:
 *
 * - `count`, the entries that are not archived (the header's count, and the
 *   N of the ungrouped list's "Show all (N)…");
 * - `pinned`, every pinned entry that is not archived;
 * - `groups`, one `{ group, entries, count, collapsed, rows }` per group in
 *   stored order: `collapsed` the group's own, or for a list this version
 *   only reads, what `folded` (`{ [groupId]: bool }`, the panel's state) says
 *   — `rows` its members, or none while collapsed;
 * - `ungrouped`, the first `limit` of the rest, and `ungroupedMore` whether
 *   there are more;
 * - `archived`, `{ count, open, rows, more }`: the archived entries, drawn
 *   only while the sub-list is open (`archivedOpen`; closed by default);
 * - `empty`, whether the hint is drawn: no entry that is not archived, and no
 *   group.
 */
export function agentSessionsView(entries, groups, { archivedOpen = false, folded = null, limit = AGENT_SESSIONS_SHOWN } = {}) {
  const s = agentSessionSections(entries, groups);
  const own = (id) => folded && Object.prototype.hasOwnProperty.call(folded, id);
  return {
    count: s.count,
    pinned: s.pinned,
    groups: s.groups.map(({ group, entries: members }) => {
      const collapsed = own(group.id) ? folded[group.id] === true : group.collapsed === true;
      return { group, entries: members, count: members.length, collapsed, rows: collapsed ? [] : members };
    }),
    ungrouped: s.ungrouped.slice(0, limit),
    ungroupedMore: s.ungrouped.length > limit,
    archived: {
      count: s.archived.length,
      open: archivedOpen === true,
      rows: archivedOpen === true ? s.archived.slice(0, limit) : [],
      more: archivedOpen === true && s.archived.length > limit,
    },
    empty: s.count === 0 && s.groups.length === 0,
  };
}

/**
 * The keys of the entries AGENT SESSIONS draws a row for, from
 * `agentSessionsView`'s result and whether the section is open (`open`): the
 * pinned entries, the rows of each group that is not folded, the ungrouped
 * rows shown (not those past "Show all (N)…") and the archived rows while
 * Archived is open. None while the section is closed.
 */
export function drawnAgentSessionKeys(view, open) {
  const keys = new Set();
  if (!open || !view) return keys;
  const add = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const entry of rows) if (typeof entry?.key === 'string') keys.add(entry.key);
  };
  add(view.pinned);
  if (Array.isArray(view.groups)) for (const group of view.groups) add(group?.rows);
  add(view.ungrouped);
  add(view.archived?.rows);
  return keys;
}

/**
 * The 'curationFailed' notice's words for a rename whose editor closed
 * because its session left the list, or its row was no longer drawn, while
 * it was being typed (C-03). `value` is what was typed: quoted as the list
 * would keep it as a name (`historyTitle`: cleaned, secrets masked), or, when
 * nothing of it would be kept, not quoted at all.
 */
export function renameNotSavedText(value) {
  const typed = typeof value === 'string' ? value.trim() : '';
  const name = typed ? historyTitle(typed) : null;
  const lost = name
    ? `the name “${name}” was not saved`
    : typed
      ? 'the new name was not saved'
      : 'clearing its name was not saved';
  return `The list changed while this session was being renamed, and ${lost}. If the session is still listed, rename it again.`;
}

/**
 * What the panel says as it drops `draft` (its inline editor: `{ kind, id,
 * value, initial }`) for a row no longer drawn: an agent session's editor
 * whose key is not among `drawn` (`drawnAgentSessionKeys`), its text changed
 * from what the editor opened with, gets the notice's text. Anything else
 * gets null: an editor of another kind, one whose row is drawn, and one
 * dropped unchanged, which loses nothing.
 */
export function droppedRenameNotice(draft, drawn) {
  if (draft?.kind !== 'agent-session' || drawn?.has?.(draft.id)) return null;
  const typed = typeof draft.value === 'string' ? draft.value.trim() : '';
  const opened = typeof draft.initial === 'string' ? draft.initial.trim() : '';
  return typed === opened ? null : renameNotSavedText(draft.value);
}

/**
 * A row's menu (F26), for `entry` as listed. `holder` is the history store's
 * `holders[entry.key]` (a terminal of this window holding it, or null),
 * `readOnly` the store's (a newer file), `icons.resume` and `icons.fork` the
 * Resume and Fork items' icons. `on`: `resume(key)`, `fork(entry)` (Fork
 * Conversation: on for a Claude Code entry with an id — not curation, so a
 * read-only list and a held one fork too — off with a reason otherwise),
 * `copyId(sessionId)`, `pin(key)`, `unpin(key)`,
 * `rename(entry)`, `moveMenu(entry)` (the drill-down), `archive(key)`,
 * `unarchive(key)`, `remove(key)` (Delete…, which asks first).
 */
export function agentSessionRowItems(entry, { holder = null, readOnly = false, icons = {}, on = {} } = {}) {
  const shown = historyDisplay(entry);
  const key = entry?.key ?? null;
  const sessionId = typeof entry?.sessionId === 'string' && entry.sessionId ? entry.sessionId : null;
  const ro = readOnly ? READ_ONLY_REASON : null;
  const notForked =
    entry?.kind === 'claude'
      ? isSessionIdFor('claude', sessionId)
        ? null
        : NO_SESSION_ID_REASON
      : entry?.kind === 'opencode'
        ? FORK_OPENCODE_REASON
        : FORK_UNKNOWN_REASON;
  return [
    withIcon(
      { key: 'resume', label: holder ? 'Show Its Terminal' : 'Resume in New Terminal', onSelect: () => on.resume?.(key) },
      icons.resume
    ),
    withIcon(off({ key: 'fork', label: 'Fork Conversation', onSelect: () => on.fork?.(entry) }, notForked), icons.fork),
    { type: 'separator', key: 's1' },
    off({ key: 'copy-id', label: 'Copy Session ID', onSelect: () => on.copyId?.(sessionId) }, sessionId ? null : NO_SESSION_ID_REASON),
    { type: 'separator', key: 's2' },
    off(
      shown.pinned
        ? { key: 'unpin', label: 'Unpin', onSelect: () => on.unpin?.(key) }
        : { key: 'pin', label: 'Pin', onSelect: () => on.pin?.(key) },
      ro
    ),
    off({ key: 'rename', label: 'Rename…', onSelect: () => on.rename?.(entry) }, ro),
    off({ key: 'move-group', label: 'Move to Group ▸', onSelect: () => on.moveMenu?.(entry) }, ro),
    { type: 'separator', key: 's3' },
    off(
      shown.archived
        ? { key: 'unarchive', label: 'Unarchive', onSelect: () => on.unarchive?.(key) }
        : { key: 'archive', label: 'Archive', onSelect: () => on.archive?.(key) },
      ro
    ),
    off({ key: 'delete', label: 'Delete…', danger: true, onSelect: () => on.remove?.(key) }, ro ?? (isRunningHere(holder) ? RUNNING_HERE_REASON : null)),
  ];
}

/**
 * The row menu's Move to Group ▸, drilled down in place (F26): Back, every
 * group as "name (n)" — n the rows under its header — with the entry's own
 * off, New Group… (the entry goes into a new group, in one write), and
 * Remove from Group (off for an entry in no group). `groupRows` is
 * `agentSessionsView(...).groups` (or `agentSessionSections`'), `icons.back`
 * Back's icon. `on`: `back()`, `moveToGroup(key, groupId)`,
 * `newGroup(key)`, `removeFromGroup(key)`.
 */
export function agentSessionMoveItems(entry, { groupRows = [], readOnly = false, icons = {}, on = {} } = {}) {
  const key = entry?.key ?? null;
  const ro = readOnly ? READ_ONLY_REASON : null;
  const rows = Array.isArray(groupRows) ? groupRows : [];
  const ownId = entryGroupId(entry);
  const grouped = ownId !== null && rows.some(({ group }) => group?.id === ownId);
  return [
    withIcon({ key: 'back', label: 'Back', onSelect: () => on.back?.() }, icons.back),
    { type: 'separator', key: 's1' },
    ...rows.map(({ group, entries }) =>
      off(
        {
          key: `group-${group.id}`,
          label: `${group.name} (${Array.isArray(entries) ? entries.length : 0})`,
          onSelect: () => on.moveToGroup?.(key, group.id),
        },
        ro ?? (group.id === ownId ? SAME_GROUP_REASON : null)
      )
    ),
    ...(rows.length > 0 ? [{ type: 'separator', key: 's2' }] : []),
    off({ key: 'new-group', label: 'New Group…', onSelect: () => on.newGroup?.(key) }, ro ?? (rows.length >= HISTORY_MAX_GROUPS ? TOO_MANY_GROUPS_REASON : null)),
    off({ key: 'remove-group', label: 'Remove from Group', onSelect: () => on.removeFromGroup?.(key) }, ro ?? (grouped ? null : NOT_GROUPED_REASON)),
  ];
}

/** A group header's menu (F27). `on`: `rename(group)` (the inline editor), `remove(groupId)` (Delete Group…, which asks first). */
export function agentGroupItems(group, { readOnly = false, on = {} } = {}) {
  const ro = readOnly ? READ_ONLY_REASON : null;
  return [
    off({ key: 'rename-group', label: 'Rename Group…', onSelect: () => on.rename?.(group) }, ro),
    off({ key: 'delete-group', label: 'Delete Group…', danger: true, onSelect: () => on.remove?.(group?.id ?? null) }, ro),
  ];
}

/**
 * The AGENT SESSIONS header's menu (F27), from the store's `entries`,
 * `groups` and `readOnly`. Clear stays on while there is any entry or group:
 * it deletes entries of every state and every group; it is off, as every
 * write is, for a list a newer NexTerm wrote. `on`: `pick()` (the
 * palette's Resume Agent Session…), `newGroup()` (an empty group, then the
 * inline editor), `clear()` (which asks first).
 */
export function agentSessionsHeaderItems({ entries = [], groups = [], readOnly = false, on = {} } = {}) {
  const listed = Array.isArray(entries) ? entries.length : 0;
  const made = Array.isArray(groups) ? groups.length : 0;
  return [
    off({ key: 'resume-pick', label: 'Resume Agent Session…', onSelect: () => on.pick?.() }, listed > 0 ? null : NO_SESSIONS_REASON),
    off(
      { key: 'new-group', label: 'New Group…', onSelect: () => on.newGroup?.() },
      readOnly ? READ_ONLY_REASON : made >= HISTORY_MAX_GROUPS ? TOO_MANY_GROUPS_REASON : null
    ),
    { type: 'separator', key: 's1' },
    off(
      { key: 'clear', label: 'Clear Agent Session History…', danger: true, onSelect: () => on.clear?.() },
      readOnly ? READ_ONLY_REASON : listed > 0 || made > 0 ? null : NOTHING_TO_CLEAR_REASON
    ),
  ];
}
