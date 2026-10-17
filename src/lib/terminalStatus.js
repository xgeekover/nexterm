/**
 * What each row of the TERMINALS side bar says about its terminal: what it is
 * doing, as one state; which agent runs in it; the last thing it told you;
 * what a group of them adds up to; and the order "by attention".
 *
 * Every one of these is decided here and nowhere else. The side bar's rows,
 * its group rows and the group switcher's chips all describe the same
 * terminals, and two renderers that each worked out "waiting" for themselves
 * would sooner or later disagree about one of them. Each state has a word and
 * a glyph as well as whatever colour the renderer gives it: a colour alone is
 * not readable by a screen reader, nor by anyone who cannot tell the two
 * apart.
 *
 * The inputs are stage 1's: a tab's unread count (`unreadCountByTab`,
 * attention.js), its bar in the store's `progress` map (terminalProgress.js),
 * and the tab itself — `exited`, `running`, `lastExitCode` (tabActivity.js)
 * and `agent` (agents.js). Nothing new is recorded to answer any of it.
 *
 * Pure: no React, no stores.
 */
import { durationLabel, isFailure } from './tabActivity.js';
import { aggregateProgress } from './terminalProgress.js';
import { bellText } from './attention.js';
import { sanitizeText, BODY_MAX, TITLE_MAX } from './programNotifications.js';

// ---- One state per terminal --------------------------------------------------

/**
 * The glyph of each state the side bar can show, by state — 'paused' being a
 * progress bar in its warning state. Shapes from the Geometric Shapes block
 * and plain punctuation: every UI font has them, and none of them is an emoji,
 * which would bring a colour of its own and a different width per platform.
 */
export const STATUS_GLYPHS = Object.freeze({
  exited: '\u{25A0}',
  waiting: '\u{25C6}',
  error: '!',
  progress: '\u{25D1}',
  paused: '\u{2016}',
  working: '\u{25CC}',
  running: '\u{25B8}',
  failed: '\u{2715}',
});

const status = (state, word, glyph, extra = {}) => Object.freeze({ state, word, glyph, ...extra });

// The states without an amount are one object each, so the same state is the
// same object and a selector or a memo can compare it by identity.
const NONE = status('none', '', '');
const EXITED = status('exited', 'Exited', STATUS_GLYPHS.exited);
const WAITING = status('waiting', 'Waiting', STATUS_GLYPHS.waiting);
const ERROR = status('error', 'Error', STATUS_GLYPHS.error);
const PROGRESS = status('progress', 'In progress', STATUS_GLYPHS.progress);
const PAUSED = status('progress', 'Paused', STATUS_GLYPHS.paused, { paused: true });
const WORKING = status('working', 'Working', STATUS_GLYPHS.working);
const RUNNING = status('running', 'Running', STATUS_GLYPHS.running);
const FAILED = status('failed', 'Failed', STATUS_GLYPHS.failed);

/** A whole percentage, 0–100, or null when there is none to show. */
function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** `base` with the bar's amount, when it has one. */
function withValue(base, value) {
  const amount = percent(value);
  return amount === null ? base : Object.freeze({ ...base, value: amount });
}

/**
 * What terminal `tab` is doing, as one state — the first of these that holds:
 *
 *   exited    its shell is gone; the scrollback is all that is left
 *   waiting   it has unread entries in the bell — stage 1's signal, and
 *             nothing else ever means waiting
 *   error     its program's bar says error (with the amount it got to)
 *   progress  its program's bar, with its amount — "Paused" for a warning
 *   working   its program says it is busy, with no amount
 *   running   OSC 133 says a command is running
 *   failed    the last command exited with a code that is not 0
 *   none      a prompt
 *
 * A dead shell outranks what it was doing; someone being waited for outranks
 * everything a terminal can say about itself, which is why the side bar is
 * looked at at all; what the program says outranks what the shell knows, as
 * it is the more particular; and a command running again outranks the last
 * one's verdict, as on the tab strip (tabActivity.js).
 *
 * `unread` is the tab's unread count, `progress` its bar (`{ state, value }`,
 * or null). Returns `{ state, word, glyph }`, plus `value` (0–100) when a bar
 * has an amount and `paused: true` for a warning. Frozen.
 */
export function terminalStatus(tab, options) {
  if (!tab) return NONE;
  const unread = options?.unread ?? 0;
  const progress = options?.progress ?? null;
  if (tab.exited) return EXITED;
  if (typeof unread === 'number' && unread > 0) return WAITING;
  switch (progress?.state) {
    case 'error':
      return withValue(ERROR, progress.value);
    case 'normal':
      return withValue(PROGRESS, progress.value);
    case 'warning':
      return withValue(PAUSED, progress.value);
    case 'indeterminate':
      return WORKING;
    default:
      break;
  }
  if (tab.running) return RUNNING;
  if (isFailure(tab.lastExitCode)) return FAILED;
  return NONE;
}

/** A state in words, its amount included: "Paused 40%", "Running", '' for none. */
export function statusText(s) {
  if (!s?.word) return '';
  return typeof s.value === 'number' ? `${s.word} ${s.value}%` : s.word;
}

// ---- The agent ---------------------------------------------------------------

/**
 * What the side bar calls each agent. Not agents.js's `label`: that one is
 * also what a resume banner says, and "opencode" is how the command is typed,
 * not what the product is called.
 */
const AGENT_NAMES = Object.freeze({ claude: 'Claude Code', opencode: 'OpenCode' });

/**
 * Whether the agent recorded for `tab` is believed to be running now, by the
 * store's own records (terminalStore.js):
 *
 *   - `agent` — which agent, and which conversation. It outlives the agent in
 *     two cases, and neither is an agent running.
 *   - `agentResumeOffered` — the record was restored with the app and is
 *     offered back over a plain shell until Resume is pressed.
 *   - `agentTyped` — the agent was typed at a prompt into the shell that has
 *     `sessionId` (`recordAgent`: started by the app, resumed, or typed by
 *     hand), so its exit — the first command end while something runs —
 *     ends the record. Null when it was typed with no prompt to go by: the
 *     shell drew none in time, and nothing watches that line, which may never
 *     have started at all (`claude: command not found`) — the record would
 *     name the agent over a shell for good.
 *
 * So: a record, not an offer, typed at a prompt into this very shell, which
 * has not exited. When unsure, no — the side bar names no agent rather than
 * one that is not there.
 */
export function agentRuns(tab) {
  if (!tab?.agent || tab.agentResumeOffered || tab.exited) return false;
  const typedInto = tab.agentTyped?.sessionId;
  return typedInto !== undefined && typedInto !== null && typedInto === tab.sessionId;
}

/**
 * The agent running in `tab`, by name, or '': while it is believed to run
 * (`agentRuns`), and only for an agent this build knows.
 */
export function agentLabel(tab) {
  if (!agentRuns(tab)) return '';
  const kind = tab.agent.kind;
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(AGENT_NAMES, kind) ? AGENT_NAMES[kind] : '';
}

/**
 * Titles that only say which agent spoke — what OpenCode and Claude Code put
 * as a message's title — compared trimmed, in any case.
 */
const AGENT_TITLES = new Set(['claude code', 'claude', 'opencode']);

// ---- The last notification ---------------------------------------------------

/**
 * The newest entry of terminal `tabId` in `notifications`, read or unread, or
 * null. Read entries count: an entry being read does not make it any less the
 * last thing the terminal said. Newest by `at`; two at the same moment go by
 * their place in the list, which is newest first.
 */
export function lastNoteFor(notifications, tabId) {
  if (!Array.isArray(notifications) || tabId === undefined || tabId === null) return null;
  let best = null;
  for (const entry of notifications) {
    if (!entry || typeof entry !== 'object' || entry.tabId !== tabId) continue;
    if (!best || (entry.at ?? 0) > (best.at ?? 0)) best = entry;
  }
  return best;
}

/** Long enough for any title and message programNotifications.js keeps. */
const NOTE_MAX = TITLE_MAX + BODY_MAX + 3;
const DASH = ' \u{2014} ';

/** One line of shown text: no control or bidirectional character, no break. */
const oneLine = (text) => sanitizeText(text, NOTE_MAX);

/** What a finished command said, in words. */
function commandLine(entry) {
  const after = typeof entry.durationMs === 'number' && entry.durationMs >= 0 ? ` after ${durationLabel(entry.durationMs)}` : '';
  // A code of null — cmd's — is a command that finished, not one that
  // succeeded, and not a failure either (`isFailure`).
  return isFailure(entry.exitCode) ? `Command failed (exit ${entry.exitCode})${after}` : `Command finished${after}`;
}

/**
 * Entry `entry` as one line: "title — body" for a program's message, the
 * bell's "Bell ×3", a finished command in words; '' for none.
 *
 * A message whose title only says who spoke is its body alone when the row
 * already says it: its terminal's name — the store titles a program's
 * message after its terminal when the program gave none — which the row
 * always shows; and the agent's ("Claude Code", "OpenCode") when the line
 * names the agent too (`agentShown`), where it only pushed the message out of
 * sight. Where the agent is not named, its name is the one thing saying who
 * spoke, and stays. Compared trimmed, in any case; the tooltip keeps the
 * title (`noteTooltip`). The text was cleaned when it arrived
 * (programNotifications.js); it is cleaned again here, as this is where it
 * is drawn.
 */
export function noteLine(entry, { agentShown = false } = {}) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.kind === 'bell') return bellText(entry.count);
  if (entry.kind !== 'program') return commandLine(entry);
  const title = oneLine(entry.title);
  const body = oneLine(entry.body);
  if (!body) return title;
  const said = title.toLowerCase();
  if (!title || said === oneLine(entry.tabTitle).toLowerCase() || (agentShown === true && AGENT_TITLES.has(said))) return body;
  return `${title}${DASH}${body}`;
}

/** "just now", "3m ago", "2h ago", "4d ago" — '' for a time that is not one. */
export function agoLabel(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 45) return 'just now';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The tooltip of the line: the whole text — a program's title too, which the
 * line may leave out — and, under it, how long ago it came.
 */
export function noteTooltip(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return '';
  let text;
  if (entry.kind === 'program') {
    const title = oneLine(entry.title);
    const body = oneLine(entry.body);
    text = title && body ? `${title}${DASH}${body}` : title || body;
  } else {
    text = noteLine(entry);
  }
  const ago = typeof entry.at === 'number' && Number.isFinite(entry.at) ? agoLabel(now - entry.at) : '';
  return ago ? `${text}\n${ago}` : text;
}

// ---- A group -----------------------------------------------------------------

/**
 * What the terminals of a group add up to: how many are waiting, how many
 * are running — a command, a bar with an amount, a busy program — and how many
 * have failed — a command's code, or a program's bar in error — each terminal
 * counted once, by its own state (`terminalStatus`); and all of their bars as
 * one, by stage 1's rule (`aggregateProgress`). An exited terminal counts
 * nowhere: a group of dead shells is not an alarm.
 *
 * `unreadCounts` is `unreadCountByTab`'s, `progress` the store's map.
 */
export function groupStatus(tabs, unreadCounts, progress) {
  let waiting = 0;
  let running = 0;
  let failed = 0;
  const bars = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab) continue;
    const bar = progress?.[tab.id] ?? null;
    if (bar) bars.push(bar);
    const { state } = terminalStatus(tab, { unread: unreadCounts?.[tab.id] ?? 0, progress: bar });
    if (state === 'waiting') waiting += 1;
    else if (state === 'running' || state === 'progress' || state === 'working') running += 1;
    else if (state === 'failed' || state === 'error') failed += 1;
  }
  return { waiting, running, failed, progress: aggregateProgress(bars) };
}

const SUMMARY = Object.freeze([
  ['waiting', STATUS_GLYPHS.waiting],
  ['running', STATUS_GLYPHS.running],
  ['failed', STATUS_GLYPHS.failed],
]);

/**
 * A group's summary as the group row draws it: `{ key, glyph, count, label }`
 * for each count that is not zero — waiting, running, failed, in that order —
 * where `label` is the count in words ("2 waiting").
 */
export function groupSummaryItems(summary) {
  const items = [];
  for (const [key, glyph] of SUMMARY) {
    const count = summary?.[key];
    if (typeof count === 'number' && count > 0) items.push({ key, glyph, count, label: `${count} ${key}` });
  }
  return items;
}

/** The summary in words, for a tooltip and an accessible name: "2 waiting, 1 failed"; '' for nothing. */
export function groupSummaryLabel(summary) {
  return groupSummaryItems(summary).map((item) => item.label).join(', ');
}

// ---- Sorted by attention -----------------------------------------------------

/**
 * Where each state goes when the side bar is sorted by attention: what is
 * waiting for you first, then what went wrong, then what is still going,
 * then the idle ones, and the dead shells last.
 */
const RANK = Object.freeze({ waiting: 0, error: 1, failed: 1, running: 2, progress: 2, working: 2, none: 3, exited: 4 });
const IDLE_RANK = RANK.none;

/** The rank of a status (`terminalStatus`'s) or of a state by name; idle for anything else. */
export function attentionRank(s) {
  const state = typeof s === 'string' ? s : s?.state;
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(RANK, state) ? RANK[state] : IDLE_RANK;
}

/** The rank of a group: that of its most urgent terminal; idle when it has none. */
export function groupAttentionRank(tabs, unreadCounts, progress) {
  let best = null;
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab) continue;
    const rank = attentionRank(terminalStatus(tab, { unread: unreadCounts?.[tab.id] ?? 0, progress: progress?.[tab.id] ?? null }));
    if (best === null || rank < best) best = rank;
  }
  return best ?? IDLE_RANK;
}

/**
 * `items` in rank order, `rankOf(item)` giving each one's rank — a NEW array:
 * the order the store keeps is the user's, and turning the sort off has to
 * show it again exactly. Stable, by each item's place in `items`, so terminals
 * of the same rank stay in the user's order and nothing changes places
 * without a reason. A rank that is not a number is idle.
 *
 * `items` itself when that is already the order, so a memo built on it holds.
 */
export function sortByAttention(items, rankOf) {
  if (!Array.isArray(items)) return [];
  const ranked = items.map((item, index) => {
    const rank = rankOf(item);
    return { item, index, rank: typeof rank === 'number' && !Number.isNaN(rank) ? rank : IDLE_RANK };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.every((r, i) => r.index === i) ? items : ranked.map((r) => r.item);
}

// ---- A branch name -----------------------------------------------------------

/** The longest branch name shown, in characters; longer ones end in "…". */
export const BRANCH_NAME_MAX = 100;

/**
 * Characters a branch name may not hold: what git refuses in a ref name —
 * control characters, space, `~ ^ : ? * [ \` — and what does not show, or
 * changes how what is around it shows: C1 controls, the line and paragraph
 * separators, the bidirectional marks, embeddings, overrides and isolates,
 * and the invisible format characters (zero-width space, soft hyphen, word
 * joiner and invisible operators, the byte-order mark, the combining grapheme
 * joiner, Mongolian and Khmer invisibles, interlinear annotation, musical
 * formatting, tag characters, the Hangul fillers). Joiners and variation
 * selectors stay: emoji need them. The same set as `invisible` and
 * `ref_name_ok` in src-tauri/src/fs/git.rs, which checks the name before it
 * leaves the backend. Deliberately strict: tag characters (flag emoji),
 * Mongolian variation selectors, the combining grapheme joiner and RLM/ALM
 * refuse a name though some are legitimate text (decided in review).
 */
const BRANCH_REFUSED = /[\u{0000}-\u{001f}\u{007f}-\u{009f}\u{00ad}\u{034f}\u{061c}\u{115f}\u{1160}\u{17b4}\u{17b5}\u{180b}-\u{180f}\u{200b}\u{200e}\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{206f}\u{3164}\u{feff}\u{ffa0}\u{fff9}-\u{fffb}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f} ~^:?*[\\]/u;

/**
 * Whether `name` is a branch name git would take (`git check-ref-format`
 * for `refs/heads/<name>`, and no leading `-`, which `git branch` refuses)
 * and that shows as it is.
 */
function branchNameOk(name) {
  if (!name || name === '@' || /^[-/]/.test(name) || /[/.]$/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || BRANCH_REFUSED.test(name)) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * A branch name as it may be shown, or '' for none: a name git would refuse,
 * or one holding a character that does not show as it is, is no name — what
 * is shown has to be the name. Cut to BRANCH_NAME_MAX characters — by code
 * point, so an emoji is never split — ending in "…" when cut. '' for anything
 * that is not a string.
 *
 * A name is whatever a repository's HEAD says, and a repository can come in
 * an archive, so it is hostile text. Only the start of an absurdly long one is
 * looked at: the backend reads at most 4 KB of HEAD.
 */
export function cleanBranchName(name) {
  if (typeof name !== 'string') return '';
  const head = name.length > 4 * 1024 ? name.slice(0, 4 * 1024) : name;
  if (!branchNameOk(head)) return '';
  const chars = Array.from(head);
  if (chars.length <= BRANCH_NAME_MAX) return head;
  return `${chars.slice(0, BRANCH_NAME_MAX - 1).join('')}\u{2026}`;
}

/** What the row shows for a branch (`git_branch`'s `{ branch, detached }`): its name, or a detached head's commit; '' for none. */
export function branchLabel(info) {
  return cleanBranchName(info?.branch);
}

/** The branch in words, for a tooltip: "Branch main", "Detached HEAD at 1a2b3c4"; '' for none. */
export function branchTitle(info) {
  const name = branchLabel(info);
  if (!name) return '';
  return info.detached ? `Detached HEAD at ${name}` : `Branch ${name}`;
}
