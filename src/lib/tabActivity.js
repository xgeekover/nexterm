/**
 * What a terminal is doing, as one word.
 *
 * Two places show it — the tab strip above each pane and the TERMINALS side
 * bar — and they must never disagree about the same terminal, so the decision
 * lives here rather than in either renderer. The status bar answers a
 * different question (what is the terminal I am LOOKING at doing), which is
 * why it stays in statusInfo.js.
 *
 * The information has been arriving all along: the shell reports OSC 133 "C"
 * when a command starts and "D" with the exit code when it ends. Until now the
 * backend dropped "C", so the app could say what a command finished with but
 * never that one was still running — and the whole point of an indicator is
 * the terminals you are not looking at.
 *
 * Pure: no React, no stores.
 */

/**
 * @returns one of:
 *   'exited'  the shell itself is gone; the scrollback is all that is left
 *   'running' a command is running right now
 *   'failed'  the last command exited non-zero, and nothing is running since
 *   'idle'    a prompt, waiting
 *
 * Order matters. A dead shell outranks whatever it was doing when it died, and
 * a new command outranks the last one's verdict — starting something is
 * exactly when the old red dot should go.
 */
export function tabActivity(tab) {
  if (!tab) return 'idle';
  if (tab.exited) return 'exited';
  if (tab.running) return 'running';
  if (typeof tab.lastExitCode === 'number' && tab.lastExitCode !== 0) return 'failed';
  return 'idle';
}

/**
 * The sentence a tab's tooltip should carry for that state, or '' when there
 * is nothing worth saying.
 *
 * Written out rather than left to a coloured dot alone: a dot is not readable
 * by a screen reader, and "why is this one orange" should be answerable by
 * hovering rather than by reading the source.
 */
export function activityLabel(tab) {
  switch (tabActivity(tab)) {
    case 'exited':
      return tab?.exited?.code === null || tab?.exited?.code === undefined
        ? 'this shell has exited'
        : `this shell has exited (code ${tab.exited.code})`;
    case 'running':
      return 'running a command';
    case 'failed':
      return `the last command exited with code ${tab.lastExitCode}`;
    default:
      return '';
  }
}

/**
 * The same question for a whole group.
 *
 * A group is a whole screen: switching to another one replaces the entire
 * arrangement, so a command failing over there is more thoroughly hidden than
 * one in a tab beside you. `running` wins over `failed` for the same reason it
 * does on a tab — work still going is the more current fact.
 *
 * An exited shell contributes nothing: a group full of dead terminals is not
 * an alarm, and the tabs inside already say so individually.
 */
export function groupActivity(tabs = []) {
  let failed = false;
  for (const tab of tabs) {
    const state = tabActivity(tab);
    if (state === 'running') return 'running';
    if (state === 'failed') failed = true;
  }
  return failed ? 'failed' : 'idle';
}

/** Whether a state is worth drawing a dot for at all. */
export function hasActivityDot(tab) {
  const state = tabActivity(tab);
  return state === 'running' || state === 'failed';
}

/**
 * Should a finished command be reported, and as what?
 *
 * Two conditions, and both matter:
 *
 *   - the terminal was NOT the one on screen. Someone watching a command
 *     finish does not need to be told that it finished.
 *   - it ran for at least `afterMs`. A command that takes half a second is not
 *     something you walked away from, and a notification per `ls` would make
 *     the whole thing worth turning off within a minute.
 *
 * `afterMs` of 0 means the user turned notifications off, which is checked
 * here rather than at the call site so there is one place that decides.
 *
 * Returns null when there is nothing to say, or the notification to raise.
 */
export function notificationFor(tab, exitCode, activeTabId, afterMs, now = Date.now()) {
  if (!tab || !afterMs || afterMs <= 0) return null;
  if (tab.id === activeTabId) return null;
  if (!tab.runStartedAt) return null;
  const durationMs = now - tab.runStartedAt;
  if (durationMs < afterMs) return null;
  return {
    id: `note-${tab.id}-${now}`,
    tabId: tab.id,
    title: tab.title || tab.defaultTitle || 'Terminal',
    exitCode: typeof exitCode === 'number' ? exitCode : 0,
    durationMs,
    at: now,
  };
}

/**
 * Whether `data`, written to a terminal, asks the shell to run a line.
 *
 * The Enter key and a command the app types (`startAgent`, `resumeAgent`) both
 * end in "\r". Two things that also contain one run nothing: a bracketed paste,
 * which the shell holds until the user presses Enter, and Alt+Enter ("\x1b\r"),
 * which PSReadLine takes as a newline inside the line being edited. Neither the
 * Enter key nor anything the app types contains an escape, so any input that
 * does is not a submitted line.
 */
export function submitsLine(data) {
  return typeof data === 'string' && data.endsWith('\r') && !data.includes('\x1b');
}

/** "4m 12s", "38s" — a duration as a person would say it. */
export function durationLabel(ms) {
  const seconds = Math.max(0, Math.round((ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default { tabActivity, activityLabel, hasActivityDot, groupActivity, notificationFor, submitsLine, durationLabel };
