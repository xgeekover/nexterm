/**
 * What the command palette offers, as plain data.
 *
 * This lives outside the component so the matching rules can be exercised
 * without a renderer: `CommandPalette.jsx` calls `buildPaletteGroups` and only
 * decides how each descriptor is drawn and which store call its `command`
 * dispatches to.
 */

import { fuzzyMatch } from './utils.js';
import { basename, isInside, relativeTo, stripTrailingSep, toPosix } from './paths.js';
import { isMac } from './platform.js';
import { DEFAULT_RESOLVED, shortcutLabel } from './keybindings.js';
import { COMMANDS_FILE } from './projectCommands.js';
import { historyCwd, historyDisplay, historyMatches } from './agentHistory.js';
import { isSessionIdFor } from './agents.js';
import { COPY_CONTEXT_DEFAULT_LINES, copyContextLabel } from './copyContext.js';
import { TOGGLE_READ_ONLY_TITLE } from './readOnly.js';
import { LAST_COMMAND_OUTPUT_LABEL } from './lastCommandOutput.js';
import { NO_AGENT_REASON, PICK_AGENT_LABEL, SEND_FILE_TITLE, SEND_SELECTION_TITLE } from './agentReference.js';

/**
 * The most files the palette lists for one query. An empty query matches
 * every file, and every row drawn costs: ten thousand of them, in a folder
 * with a `vendor/` or a `.venv`, made each key and each move of the mouse
 * wait for all of them. More than a screenful is typed away, not scrolled
 * through; the rest are counted (`more`) so the list can say so.
 */
export const FILE_RESULT_LIMIT = 200;

/**
 * The most agent sessions the default palette lists for a query: a few, as
 * a pointer to the entry the query names. Resume Agent Session… lists them
 * all; the rest are counted (`more`).
 */
export const AGENT_SESSION_GROUP_LIMIT = 5;

/**
 * Every file in an explorer tree, at any depth.
 *
 * `fs_read_dir` returns a NESTED tree (each directory carries its own
 * `children`), so reading only the top level hides everything under `src/`,
 * `tests/`, and so on. The palette used to do exactly that, which is why ⌘P
 * could not find `src/App.jsx`.
 */
export function flattenFileNodes(nodes, acc = []) {
  if (!Array.isArray(nodes)) return acc;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.is_dir) {
      flattenFileNodes(node.children, acc);
    } else {
      acc.push(node);
    }
  }
  return acc;
}

/**
 * The built-in actions, independent of any query.
 *
 * The hints are read off the bindings rather than written beside each entry:
 * these keys are rebindable now, and a palette row showing the shortcut a user
 * replaced is the same lie a stale menu row is.
 */
export function paletteCommands(bindings = DEFAULT_RESOLVED) {
  const hint = (command) => shortcutLabel(command, bindings, { isMac });
  return [
    {
      type: 'command',
      id: 'cmd-new-terminal',
      command: 'new_terminal',
      title: 'New Terminal Tab',
      subtitle: 'Spawns a new independent PTY terminal session',
      hint: hint('new-terminal'),
    },
    {
      type: 'command',
      id: 'cmd-clear-terminal',
      command: 'clear_terminal',
      title: 'Clear Terminal',
      subtitle: 'Clears the active terminal\'s screen and scrollback; the line being typed stays',
      hint: hint('clear-terminal'),
    },
    {
      type: 'command',
      id: 'cmd-toggle-pane-zoom',
      command: 'toggle_pane_zoom',
      title: 'Toggle Pane Zoom',
      subtitle: 'Fill the group with the active pane, or show every pane again',
      hint: hint('toggle-pane-zoom'),
    },
    // Spec P2 and P3: no chord of their own, so no hint unless one is bound.
    {
      type: 'command',
      id: 'cmd-equalize-splits',
      command: 'equalize_splits',
      title: 'Equalize Splits',
      subtitle: 'Give every pane of the group on screen the same share, nested splits included',
      hint: hint('equalize-splits'),
    },
    {
      type: 'command',
      id: 'cmd-swap-pane',
      command: 'swap_pane',
      title: 'Swap Pane With…',
      subtitle: "Trade the active pane's terminals or files with another pane of this group",
      hint: hint('swap-pane'),
      // Picked, it does not run: the palette turns into the list of panes
      // to swap with (mode 'swap-pane'), keeping what had the keyboard.
      opens: 'swap-pane',
    },
    // The active terminal's tab, reachable without its strip — a hidden one
    // (spec P1), or a strip scrolled out of reach.
    {
      type: 'command',
      id: 'cmd-rename-terminal',
      command: 'rename_terminal',
      title: 'Rename Terminal…',
      subtitle: "Edit the active terminal's name in its tab",
    },
    {
      type: 'command',
      id: 'cmd-close-terminal',
      command: 'close_terminal',
      title: 'Close Terminal',
      subtitle: 'Close the active terminal and end its shell',
    },
    // The prompt marks on the scrollbar, one prompt at a time (F11).
    {
      type: 'command',
      id: 'cmd-terminal-previous-prompt',
      command: 'terminal_previous_prompt',
      title: 'Terminal: Go to Previous Prompt',
      subtitle: 'Scroll the active terminal to the prompt above the top of the view',
      hint: hint('terminal-previous-prompt'),
    },
    {
      type: 'command',
      id: 'cmd-terminal-next-prompt',
      command: 'terminal_next_prompt',
      title: 'Terminal: Go to Next Prompt',
      subtitle: 'Scroll the active terminal to the next prompt, or to the bottom past the last one',
      hint: hint('terminal-next-prompt'),
    },
    // Bundle 4, A3 (src/lib/readOnly.js): no chord of its own, so no hint
    // unless one is bound. The active terminal, as the keys do.
    {
      type: 'command',
      id: 'cmd-terminal-toggle-read-only',
      command: 'terminal_toggle_read_only',
      title: TOGGLE_READ_ONLY_TITLE,
      subtitle: "Keep the active terminal's keys, pastes and drops from its program, or let them through again",
      hint: hint('toggle-read-only'),
    },
    {
      type: 'command',
      id: 'cmd-go-to-unread-notification',
      command: 'go_to_unread_notification',
      title: 'Go to Latest Unread Notification',
      subtitle: 'Show the terminal that is waiting for you, and mark it read',
      hint: hint('go-to-unread-notification'),
    },
    // No hint unless the user bound one: it has no chord of its own.
    {
      type: 'command',
      id: 'cmd-mark-notifications-read',
      command: 'mark_notifications_read',
      title: 'Mark All Notifications Read',
      subtitle: 'Every terminal stops asking for attention; the bell keeps the list',
      hint: hint('mark-notifications-read'),
    },
    // No hint: nothing is bound to Save All. It used to show Save's chord,
    // which writes the active tab and leaves every other one unsaved.
    // The editor counterpart of a terminal's Move to New Pane (FC11): the
    // file the active editor pane shows, alone in a new pane beside it.
    {
      type: 'command',
      id: 'cmd-move-editor-new-pane-right',
      command: 'move_editor_new_pane_right',
      title: 'Move Editor to New Pane Right',
      subtitle: 'Split the open file out of its pane into a new pane on the right',
    },
    {
      type: 'command',
      id: 'cmd-move-editor-new-pane-down',
      command: 'move_editor_new_pane_down',
      title: 'Move Editor to New Pane Down',
      subtitle: 'Split the open file out of its pane into a new pane below',
    },
    {
      type: 'command',
      id: 'cmd-save-all',
      command: 'save_all',
      title: 'Save All Files',
      subtitle: 'Writes all dirty editor buffers to disk',
    },
    // Project commands (stage 5): palette commands with no chord of their
    // own and no menu entry, like the split polish pair.
    {
      type: 'command',
      id: 'cmd-run-project-command',
      command: 'run_project_command',
      title: 'Run Project Command…',
      subtitle: "Pick one of this folder's commands or your own, see the exact line, then type it",
      hint: hint('run-project-command'),
      // A pick of the commands, in the palette (mode 'project-commands').
      opens: 'project-commands',
    },
    {
      type: 'command',
      id: 'cmd-open-project-commands-file',
      command: 'open_project_commands_file',
      title: 'Open Project Commands File',
      subtitle: `Edit ${COMMANDS_FILE} in the open folder — made with an example when there is none`,
      hint: hint('open-project-commands-file'),
    },
    {
      type: 'command',
      id: 'cmd-stop-trusting-project-commands',
      command: 'stop_trusting_project_commands',
      title: "Stop Trusting This Folder's Commands",
      subtitle: `Forget that you trusted ${COMMANDS_FILE} here; it is reviewed again before it is offered`,
      hint: hint('stop-trusting-project-commands'),
    },
    // Stage 7 (spec D6): what programs in terminals asked of NexTerm through
    // nexterm-cli. A palette command only, like the project commands.
    {
      type: 'command',
      id: 'cmd-show-control-log',
      command: 'show_control_log',
      title: 'Show Control Log',
      subtitle: 'What programs in terminals asked NexTerm to do through nexterm-cli — the last 500 calls, never what was typed or read',
      // A dialog, which takes the keyboard as it opens (`focusAfterPalette`).
      opensDialog: true,
    },
    // The agent session history (AGENT SESSIONS in the side bar): palette
    // commands only, like the project commands.
    {
      type: 'command',
      id: 'cmd-resume-agent-session',
      command: 'resume_agent_session',
      title: 'Resume Agent Session…',
      subtitle: 'Pick a Claude Code or OpenCode conversation run in NexTerm and continue it in a new terminal',
      // A pick of the entries, in the palette (mode 'agent-sessions').
      opens: 'agent-sessions',
    },
    // Fork the active terminal's Claude Code conversation into a new one, in
    // a new terminal (`forkConversation`). Listed only while the active
    // terminal holds one (`forkTargetOfTab`); no default chord.
    {
      type: 'command',
      id: 'cmd-fork-conversation',
      command: 'fork_conversation',
      title: 'Fork Conversation',
      subtitle: "Continue the active terminal's Claude Code conversation as a new one in a new terminal; the original stays as it is",
    },
    // Copy Context (bundle 1, A3): the active terminal's last N lines on the
    // clipboard, plain, secrets masked (src/lib/copyContext.js). N is the
    // Copy Context Lines setting, named in the title (`buildPaletteGroups`);
    // listed only while the active terminal has been shown. No default chord.
    {
      type: 'command',
      id: 'cmd-copy-terminal-context',
      command: 'copy_terminal_context',
      title: copyContextLabel(COPY_CONTEXT_DEFAULT_LINES),
      subtitle:
        "Copy Context: the active terminal's last lines on the clipboard as plain text, wrapped lines joined, API keys, tokens and passwords replaced with [hidden]",
    },
    // Copy Last Command Output (bundle 4, A2; src/lib/lastCommandOutput.js):
    // what the active terminal's last command printed, masked. Listed with
    // Copy Context, while the active terminal has been shown; greyed out
    // with the reason (`buildPaletteGroups`' `lastOutput`) while it cannot
    // copy — cmd, a command running, none finished (review B-R4).
    {
      type: 'command',
      id: 'cmd-copy-last-command-output',
      command: 'copy_last_command_output',
      title: LAST_COMMAND_OUTPUT_LABEL,
      subtitle:
        "What the active terminal's last command printed, on the clipboard as plain text, wrapped lines joined, API keys, tokens and passwords replaced with [hidden]",
    },
    // Send to Agent (bundle 4, A4; src/lib/agentReference.js, sendToAgent.js):
    // an @ reference typed into the terminal running Claude Code or OpenCode,
    // as a paste, Enter not pressed. No chord of their own, so no hint until
    // one is bound. Greyed out with the reason (`buildPaletteGroups`'
    // `sendToAgent`) while there is no agent terminal or the file is modified.
    {
      type: 'command',
      id: 'cmd-send-selection-to-agent',
      command: 'send_selection_to_agent',
      title: SEND_SELECTION_TITLE,
      subtitle: 'Type @file (lines A-B) for the lines selected in the editor into the terminal running Claude Code or OpenCode; Enter is not pressed',
      hint: hint('send-selection-to-agent'),
    },
    {
      type: 'command',
      id: 'cmd-send-file-to-agent',
      command: 'send_file_to_agent',
      title: SEND_FILE_TITLE,
      subtitle: 'Type @file for the file in the editor into the terminal running Claude Code or OpenCode; Enter is not pressed',
      hint: hint('send-file-to-agent'),
    },
    {
      type: 'command',
      id: 'cmd-clear-agent-session-history',
      command: 'clear_agent_session_history',
      title: 'Clear Agent Session History…',
      subtitle: 'Empty the AGENT SESSIONS list after asking; the conversations themselves are not touched',
      // "Clear Agent Session History?" takes the keyboard as it opens.
      opensDialog: true,
    },
  ];
}

/**
 * `entries` of the agent session history (agentHistoryStore's, newest first
 * as the backend lists them — sorted again here, so a caller's order cannot
 * put an old one on top) that fit `query` (`historyMatches`: the user's
 * name, the title, the agent, the folder, the name of its group among
 * `groups` — the store's `{ id, name }` — and the id prefix), as palette rows
 * (F28). Enter on one resumes it (`resumeFromHistory`, by `historyKey`).
 *
 * The entries that are not archived, pinned ones first, the hint saying so;
 * with `archived`, only the archived ones, newest first. A grouped row's
 * subtitle names its group after the folder.
 */
export function agentSessionRows(entries, query = '', groups = null, { archived = false } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && typeof entry.key === 'string' && entry.key && (entry.archived === true) === archived
  );
  const known = Array.isArray(groups) ? groups : [];
  return list
    .map((entry, at) => ({ entry, at }))
    .sort(
      (a, b) =>
        (archived ? 0 : Number(b.entry.pinned === true) - Number(a.entry.pinned === true)) ||
        (Number(b.entry.lastUsedAt) || 0) - (Number(a.entry.lastUsedAt) || 0) ||
        a.at - b.at
    )
    .map(({ entry }) => entry)
    .filter((entry) => historyMatches(entry, query, known))
    .map((entry) => {
      const shown = historyDisplay(entry);
      const group = shown.groupId ? known.find((g) => g?.id === shown.groupId) : null;
      return {
        type: 'agent-session',
        id: `agent-session-${entry.key}`,
        historyKey: entry.key,
        title: shown.title,
        subtitle: group?.name ? `${shown.folderPath} · ${group.name}` : shown.folderPath,
        hint: shown.pinned && !archived ? `${shown.label} · pinned` : shown.label,
      };
    });
}

/** "1 command", "3 commands". */
const commandsCount = (n) => `${n} command${n === 1 ? '' : 's'}`;

/**
 * The palette's rows for the folder's commands and the user's (spec D10),
 * from what the project commands store holds: `{ status, reason, trust,
 * project, user }` (src/stores/projectCommandsStore.js).
 *
 * - The folder's commands, while they are trusted, and the user's: a row
 *   each, by name, hint *Project* or *User* — never in the commands group,
 *   so a command named "Clear Terminal" cannot pass for NexTerm's own —
 *   matched as the built-ins are, by name first and then by description.
 * - A file read but not trusted, or changed since it was: instead of its
 *   commands, one row that opens the review (`project-review`).
 * - A file that is not a commands file at all (broken JSON, a version this
 *   NexTerm does not read): a row that opens it to be fixed
 *   (`project-problem`).
 * - A file the backend would not read — a link, a network drive, a FIFO, too
 *   big: no row, which would open what the backend just refused to read;
 *   `note` says why instead.
 *
 * Returns `{ rows, note, refused }` — `refused` how many of the trusted
 * file's commands were left out.
 */
export function projectCommandRows({ status = 'idle', reason = null, trust = 'untrusted', project = null, user = null } = {}, query = '') {
  const q = (query || '').toLowerCase().trim();
  const fileRows = [];
  let note = null;
  let refused = 0;
  const matches = (row) => !q || fuzzyMatch(q, row.title) || fuzzyMatch(q, row.subtitle);

  if (status === 'ok' && project && !project.ok) {
    fileRows.push({
      type: 'project-problem',
      id: 'project-problem',
      command: 'open_project_commands_file',
      title: "Fix This Folder's Commands File",
      subtitle: `${COMMANDS_FILE}: ${project.reason}`,
      hint: 'Project',
    });
  } else if (status === 'ok' && project?.ok && trust !== 'trusted' && project.commands.length + project.refused.length > 0) {
    // (A file that lists nothing has nothing to review.)
    const n = project.commands.length;
    const left = project.refused.length;
    const what = `${commandsCount(n)}${left ? ` (${left} refused)` : ''} in ${COMMANDS_FILE}`;
    fileRows.push({
      type: 'project-review',
      id: 'project-review',
      title: "Review This Folder's Commands…",
      subtitle: trust === 'changed' ? `${what} — changed since you trusted them` : `${what} — not trusted yet`,
      hint: 'Project',
    });
  } else if (status === 'refused' || status === 'error') {
    note = `This folder's ${COMMANDS_FILE} is not read: ${reason}`;
  }

  const commandRow = (cmd) => ({
    type: 'project-command',
    id: `project-command-${cmd.key}`,
    commandKey: cmd.key,
    source: cmd.source,
    title: cmd.name,
    // The description when it has one; else the line itself, which is what
    // a command without one is known by — drawn in the order it is typed
    // (`subtitleIsLine`): a right-to-left word in it must not reorder it.
    subtitle: cmd.description || cmd.template,
    ...(cmd.description ? {} : { subtitleIsLine: true }),
    hint: cmd.source === 'user' ? 'User' : 'Project',
  });
  const commands = [];
  if (status === 'ok' && project?.ok && trust === 'trusted') {
    commands.push(...project.commands.map(commandRow));
    refused = project.refused.length;
  }
  if (user?.ok) commands.push(...user.commands.map(commandRow));

  return { rows: [...fileRows.filter(matches), ...matchingCommands(commands, q)], note, refused };
}

/**
 * The group of project and user commands, as mode 'all' and mode
 * 'project-commands' list it, or null when it has nothing to show. In
 * 'project-commands' mode — chosen to run one — an empty list says how to
 * make some, and a trusted file's refused commands are counted, so a typo
 * in the file does not read as a command that vanished.
 */
function projectCommandGroup(projectCommands, q, mode) {
  if (!projectCommands) return null;
  const { rows, note, refused } = projectCommandRows(projectCommands, q);
  const own = mode === 'project-commands';
  let shownNote = own || !q ? note : null;
  if (own && refused > 0) {
    const more = `${refused} of ${COMMANDS_FILE}'s commands ${refused === 1 ? 'was' : 'were'} refused — Open Project Commands File to see why.`;
    shownNote = shownNote ? `${shownNote} ${more}` : more;
  }
  if (own && rows.length === 0 && !shownNote) {
    shownNote = q
      ? 'No project or user command matches.'
      : `No commands yet. Put a folder's in ${COMMANDS_FILE} (Open Project Commands File makes one with an example), or your own in Settings ▸ Terminal ▸ User Commands.`;
  }
  if (rows.length === 0 && !shownNote) return null;
  return { label: 'project commands', items: rows, ...(shownNote ? { note: shownNote } : {}) };
}

/**
 * Where the keyboard goes once the palette has closed on `item`, or on
 * nothing (null: Escape, a click outside, its chord again):
 *
 *   'terminal'  a command line from history, typed into the active terminal:
 *               the Enter that runs it is the user's, and has to land there
 *               wherever the palette was opened from
 *   'editor'    a file: the editor it opens in
 *   'dialog'    a project command or the review: the dialog it opens, which
 *               gives it back to the opener when it closes
 *   'opener'    anything else, and nothing: back where it was when the
 *               palette opened (`canHaveFocusBack`)
 */
export function focusAfterPalette(item) {
  if (item?.type === 'history') return 'terminal';
  // The terminal it opens, or the one already holding it.
  if (item?.type === 'agent-session') return 'terminal';
  if (item?.type === 'file') return 'editor';
  // A project command's run dialog, or the review: the dialog takes the
  // keyboard as it opens, and gives it back to what had it before the
  // palette (src/lib/dialogReturn.js). Handed back to the terminal first, a
  // program there that asks to be told of focus heard it come and go.
  if (item?.type === 'project-command' || item?.type === 'project-review') return 'dialog';
  // A built-in that opens a dialog of its own — Show Control Log — the same.
  if (item?.type === 'command' && item.opensDialog === true) return 'dialog';
  return 'opener';
}

/**
 * Whether `opener`, what had the keyboard when the palette opened, can have
 * it back: an element still on the page (`onPage`), not the page itself
 * (`body`), and not a button. Chromium focuses a button that is clicked, so
 * the title bar's search box would have it back and the next Enter would
 * open the palette again; the terminal on screen takes it instead.
 */
export function canHaveFocusBack(opener, { body, onPage }) {
  return Boolean(opener) && opener !== body && opener.tagName !== 'BUTTON' && onPage(opener);
}

/**
 * What the palette's Fork Conversation forks for `tab`, the active terminal
 * (`forkConversation`'s argument): `{ sessionId, cwd }` when it runs or
 * offers back a Claude Code conversation by a valid id, in a folder the
 * history can keep (`historyCwd`, by `os`), else null — an OpenCode
 * terminal, a plain one, one whose Claude Code record has no id.
 */
export function forkTargetOfTab(tab, os = null) {
  const agent = tab?.agent;
  if (agent?.kind !== 'claude' || !isSessionIdFor('claude', agent.sessionId)) return null;
  const cwd = historyCwd(tab, os);
  return cwd ? { sessionId: agent.sessionId, cwd } : null;
}

/**
 * The palette's result groups for `query`, in display order.
 *
 * `mode` is 'all' (⌘K — files and commands), 'files' (⌘P — files only),
 * 'history' (⌘⇧H — command lines already run), 'swap-pane' (the panes
 * "Swap Pane With…" offers: `panes`, or `panesNote` saying why there are
 * none) or 'project-commands' ("Run Project Command…": the folder's and the
 * user's commands, from `projectCommands` — see `projectCommandRows`, which
 * also gives mode 'all' its group of them), and `bindings` decides which
 * shortcut each command advertises.
 * Empty groups are dropped so the rendered list and the keyboard selection
 * always run over exactly the same items.
 *
 * The files are `files` — every file under the open folder, as the backend
 * lists them (`fs_list_files`), `filesTruncated` when it stopped short —
 * or, while there is no such list, the files in the Explorer's `fileTree`,
 * which stops five levels down. At most `limit` are listed, best match
 * first; the files group says how many `more` matched, and whether the list
 * it came from was `truncated`.
 *
 * `forkTarget` is what Fork Conversation would fork (`forkTargetOfTab` of
 * the active terminal): the command is listed only when it is one. A caller
 * that says nothing of it (undefined) lists the built-ins as they are.
 *
 * `copyContext` is what Copy Context would copy: `{ lines }` (the Copy
 * Context Lines setting, named in its title) while the active terminal has
 * been shown, null while there is none or it never was — then it is not
 * listed. Undefined lists it as it is, with the default 200.
 *
 * `lastOutput` is why Copy Last Command Output cannot copy now
 * (lastCommandOutput.js `lastOutputUnavailableOfTab` of the active
 * terminal), or null: with a reason it is greyed out with it, as Send to
 * Agent is by `sendToAgent`. Undefined lists it as it is.
 */
export function buildPaletteGroups({
  fileTree = [],
  files = null,
  filesTruncated = false,
  rootPath = null,
  query = '',
  mode = 'all',
  bindings = DEFAULT_RESOLVED,
  recentRoots = [],
  history = [],
  panes = [],
  panesNote = null,
  projectCommands = null,
  agentSessions = [],
  agentGroups = [],
  forkTarget = undefined,
  copyContext = undefined,
  sendToAgent = undefined,
  lastOutput = undefined,
  agentTargets = [],
  agentText = null,
  limit = FILE_RESULT_LIMIT,
} = {}) {
  const q = (query || '').toLowerCase().trim();

  // Send to Agent's pick (bundle 4, A4): the terminals running Claude Code or
  // OpenCode (`agentTargets`, src/lib/sendToAgent.js's `pendingAgentPick`),
  // the most recently focused first, and what will be typed (`agentText`)
  // in the note. With none left, the note says why.
  if (mode === 'send-to-agent') {
    const rows = (Array.isArray(agentTargets) ? agentTargets : [])
      .filter((t) => !q || fuzzyMatch(q, t.title ?? '') || String(t.agent ?? '').toLowerCase().includes(q))
      .map((t, at) => ({
        type: 'agent-target',
        id: `agent-target-${t.tabId}`,
        tabId: t.tabId,
        title: t.title,
        subtitle: [t.agent, t.cwd].filter(Boolean).join(' · '),
        hint: at === 0 && !q ? 'Last used' : '',
      }));
    const note = !agentText
      ? 'Nothing is waiting to be sent.'
      : rows.length === 0 && !q
        ? NO_AGENT_REASON
        : `Types ${agentText.trim()} — Enter is not pressed`;
    return [{ label: PICK_AGENT_LABEL, items: rows, note }];
  }

  // "Resume Agent Session…" as a pick: every entry of the history, pinned
  // first and then newest first, the archived ones in a group of their own
  // after them (F28) — or a note saying how the list fills: an empty palette
  // reading "No matching commands or files" would not say what it is for.
  if (mode === 'agent-sessions') {
    const rows = agentSessionRows(agentSessions, q, agentGroups);
    const archivedRows = agentSessionRows(agentSessions, q, agentGroups, { archived: true });
    if (rows.length > 0 || archivedRows.length > 0) {
      return [
        ...(rows.length > 0 ? [{ label: 'agent sessions', items: rows }] : []),
        ...(archivedRows.length > 0 ? [{ label: 'archived agent sessions', items: archivedRows }] : []),
      ];
    }
    const none = (Array.isArray(agentSessions) ? agentSessions : []).length === 0;
    return [
      {
        label: 'agent sessions',
        items: [],
        note: none
          ? 'No agent sessions yet. Claude Code and OpenCode conversations run in a NexTerm terminal are listed here, newest first.'
          : 'No agent session matches.',
      },
    ];
  }

  // "Run Project Command…" as a pick: the folder's commands and the user's,
  // or the row that reviews them first, and nothing else to scroll past.
  if (mode === 'project-commands') {
    const group = projectCommandGroup(projectCommands ?? {}, q, mode);
    return group ? [group] : [];
  }

  // Its own mode rather than a section of "all": you reach for it knowing you
  // want a folder, and there is nothing to mix it with — with no folder open
  // there are no files to list in the first place.
  if (mode === 'recent') {
    const rows = recentRoots
      .filter((path) => typeof path === 'string' && path)
      .filter((path) => !q || path.toLowerCase().includes(q))
      .map((path) => ({
        type: 'recent',
        id: `recent-${path}`,
        title: basename(path) || path,
        subtitle: path,
        path,
        hint: 'Folder',
      }));
    return rows.length > 0 ? [{ label: 'recent folders', items: rows }] : [];
  }

  // History is its own mode rather than a section of "all": you reach for it
  // knowing you want something you have already run, and mixing it with files
  // and commands would bury it under both.
  if (mode === 'history') {
    const rows = history
      .filter((entry) => entry && typeof entry.command === 'string')
      // Plain substring, not fuzzy: a command line is not a filename, and
      // fuzzy matching over `git commit -m "..."` turns every query into a
      // wall of near-misses.
      .filter((entry) => !q || entry.command.toLowerCase().includes(q))
      .map((entry) => ({
        type: 'history',
        id: `history-${entry.command}`,
        title: entry.command,
        subtitle: entry.cwd || '',
        command: entry.command,
        hint: entry.count > 1 ? `${entry.count}×` : 'Ran once',
      }));
    return rows.length > 0 ? [{ label: 'history', items: rows }] : [];
  }

  // "Swap Pane With…" as a pick: the other panes of the group on screen
  // (`panes`, from `swapChoices` in splitLayout.js), each by the title of the
  // terminal it shows and where it is. When there is none to offer —
  // zoomed, or a group of one pane — `panesNote` says why, and the group is
  // kept for that note alone: an empty palette reading "No matching
  // commands or files" would not say what to do instead.
  if (mode === 'swap-pane') {
    const rows = (Array.isArray(panes) ? panes : [])
      .filter((pane) => !q || fuzzyMatch(q, pane.title ?? '') || String(pane.place ?? '').toLowerCase().includes(q))
      .map((pane) => ({
        type: 'pane',
        id: `pane-${pane.paneId}`,
        paneId: pane.paneId,
        title: pane.title,
        // An editor pane counts files, not terminals (FC11).
        subtitle: [pane.place, pane.terminals > 1 ? `${pane.terminals} ${pane.kind === 'editor' ? 'files' : 'terminals'}` : '']
          .filter(Boolean)
          .join(', '),
        hint: `Pane ${pane.index + 1} of ${pane.count}`,
      }));
    if (rows.length === 0 && !panesNote) return [];
    return [{ label: 'swap with', items: rows, ...(panesNote ? { note: panesNote } : {}) }];
  }

  // A path typed with either separator: the paths are matched with `/`.
  const found = matchFiles(
    fileCandidates(files ?? fileTree, files ? 'paths' : 'tree', rootPath),
    belowRoot(toPosix(q), rootPath),
    limit
  );
  const fileRows = found.entries.map((entry) => ({
    type: 'file',
    id: `file-${entry.path}`,
    title: entry.name,
    subtitle: entry.path,
    path: entry.path,
    hint: 'File',
  }));

  // "Stop Trusting This Folder's Commands" only while something is trusted
  // (spec D10). Without word from the store (`projectCommands`) — a caller
  // that lists the built-ins alone — every command is listed.
  const offered = paletteCommands(bindings).filter(
    (cmd) =>
      (cmd.command !== 'stop_trusting_project_commands' || !projectCommands || projectCommands.trust === 'trusted') &&
      // Fork Conversation only while the active terminal holds a conversation to fork.
      (cmd.command !== 'fork_conversation' || forkTarget === undefined || isSessionIdFor('claude', forkTarget?.sessionId)) &&
      // Copy Context only while the active terminal has a screen to copy.
      (cmd.command !== 'copy_terminal_context' || copyContext === undefined || Boolean(copyContext)) &&
      // Copy Last Command Output too: no screen, no output to copy.
      (cmd.command !== 'copy_last_command_output' || copyContext === undefined || Boolean(copyContext))
  ).map((cmd) =>
    // Its title names the N it copies.
    cmd.command === 'copy_terminal_context' && copyContext ? { ...cmd, title: copyContextLabel(copyContext.lines) } : cmd
  ).map((cmd) => {
    // Send to Agent, greyed out with the reason it cannot send now; Copy
    // Last Command Output with the reason it cannot copy.
    const reason =
      cmd.command === 'send_selection_to_agent'
        ? sendToAgent?.selection
        : cmd.command === 'send_file_to_agent'
          ? sendToAgent?.file
          : cmd.command === 'copy_last_command_output'
            ? lastOutput
            : null;
    return reason ? { ...cmd, subtitle: reason, disabledReason: reason } : cmd;
  });
  const commands = mode === 'files' ? [] : matchingCommands(offered, q);
  // After NexTerm's own commands, in a group of their own (spec D10) —
  // unless a query names one of them while it only loosely matches the
  // description of every built-in it finds: "echo hi" ran Swap Pane With…,
  // whose description happens to hold those letters. Enter runs the first
  // row, and the first row should be the command the query names.
  const projectGroup = mode === 'files' ? null : projectCommandGroup(projectCommands, q, mode);
  const commandGroup = { label: 'commands', items: commands };
  const projectFirst =
    Boolean(q) &&
    projectGroup?.items.some((row) => row.type === 'project-command' && fuzzyMatch(q, row.title)) &&
    !commands.some((cmd) => fuzzyMatch(q, cmd.title));
  // The entries a query names, after the commands, in a group of their own
  // as the project commands are — and only once something is typed: with
  // nothing typed every entry fits, and Resume Agent Session… lists them.
  // Never an archived one: those are for Resume Agent Session… (F28).
  const agentRows = mode === 'files' || !q ? [] : agentSessionRows(agentSessions, q, agentGroups);
  const agentGroup =
    agentRows.length > 0
      ? {
          label: 'agent sessions',
          items: agentRows.slice(0, AGENT_SESSION_GROUP_LIMIT),
          more: Math.max(0, agentRows.length - AGENT_SESSION_GROUP_LIMIT),
        }
      : null;

  return [
    { label: 'files', items: fileRows, more: found.more, truncated: files ? filesTruncated === true : false },
    ...(projectFirst ? [projectGroup, commandGroup] : [commandGroup, ...(projectGroup ? [projectGroup] : [])]),
    ...(agentGroup ? [agentGroup] : []),
    // A cut list keeps its group, rows or none, for the note that says it was
    // cut: with nothing matching, the note went with the group, and a file
    // past the cut read as no file at all. A group with a note keeps it too.
  ].filter((group) => group.items.length > 0 || group.truncated || group.note);
}

/**
 * The commands `q` matches: those whose title it matches first, then those
 * only their description does, each in the order they are declared. A loose
 * match on a description is easy — "Clears the active terminal's screen and
 * scrollback" spells "save all" — and the first row is the one Enter runs.
 */
function matchingCommands(all, q) {
  const byTitle = all.filter((cmd) => fuzzyMatch(q, cmd.title));
  const byDescription = all.filter((cmd) => !byTitle.includes(cmd) && fuzzyMatch(q, cmd.subtitle));
  return [...byTitle, ...byDescription];
}

/** Each source's files, readied for matching, kept until the source is replaced. */
const candidateCache = new WeakMap();

/**
 * Every file in `source` — the backend's list of paths, or the Explorer's
 * tree — with what matching needs worked out once per list rather than once
 * per file per key: the name, and the path below the open folder, both
 * lowercased, with `/` for a separator.
 */
function fileCandidates(source, kind, rootPath) {
  if (!Array.isArray(source)) return [];
  const cached = candidateCache.get(source);
  if (cached && cached.rootPath === rootPath) return cached.entries;
  const nodes =
    kind === 'paths'
      ? source.filter((path) => typeof path === 'string' && path).map((path) => ({ path, name: basename(path) }))
      : flattenFileNodes(source).filter((node) => typeof node.path === 'string');
  const entries = nodes.map(({ path, name }) => {
    const below = rootPath && isInside(rootPath, path) ? relativeTo(rootPath, path) : path;
    return { path, name, lowerName: String(name).toLowerCase(), lowerPath: toPosix(below).toLowerCase() };
  });
  candidateCache.set(source, { rootPath, entries });
  return entries;
}

/**
 * A query that is a whole path inside the open folder — Copy Path in the
 * Explorer, a path out of a terminal — as the part below the folder, which is
 * what a file's path is matched by (`fileCandidates`). Pasted whole it matched
 * nothing. `query` is lowercased and uses `/`.
 */
function belowRoot(query, rootPath) {
  if (!rootPath) return query;
  const root = toPosix(stripTrailingSep(rootPath)).toLowerCase();
  return query.startsWith(`${root}/`) ? query.slice(root.length + 1) : query;
}

/** Whether the letters of `needle` appear in `text` in order. Both already lowercased. */
function inOrder(needle, text) {
  let at = 0;
  for (let i = 0; i < text.length && at < needle.length; i += 1) {
    if (text[i] === needle[at]) at += 1;
  }
  return at === needle.length;
}

/**
 * How well a file answers `q`: 0 when its name starts with it, 1 when its
 * name has it, 2 when its name has its letters in order, 3 when only its
 * path below the folder does, -1 not at all.
 *
 * The whole path was matched before, the open folder's own location
 * included, so the letters of `/Users/me/projects` matched almost any query
 * against every file, and with every match equal the file actually called
 * `App.jsx` could come last.
 */
function fileRank(entry, q) {
  if (!q || entry.lowerName.startsWith(q) || entry.lowerPath === q) return 0;
  if (entry.lowerName.includes(q)) return 1;
  if (inOrder(q, entry.lowerName)) return 2;
  return inOrder(q, entry.lowerPath) ? 3 : -1;
}

/**
 * The best `limit` files for `q`, best first and otherwise in the order they
 * came (path order), and how many more matched. One pass, no sort: twenty
 * thousand files are ranked on every key.
 */
function matchFiles(candidates, q, limit) {
  const ranked = [[], [], [], []];
  let matched = 0;
  for (const entry of candidates) {
    const rank = fileRank(entry, q);
    if (rank < 0) continue;
    matched += 1;
    if (ranked[rank].length < limit) ranked[rank].push(entry);
  }
  const entries = ranked.flat().slice(0, limit);
  return { entries, more: matched - entries.length };
}
