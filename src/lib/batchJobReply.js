/**
 * cmd's "Terminate batch job (Y/N)?", answered Y — VS Code's
 * `terminal.integrated.autoReplies`, whose one shipped reply is this one.
 *
 * Why: OpenCode runs in cmd through npm's `opencode.cmd`, a batch file, so a
 * Ctrl+C out of it makes cmd ask "Terminate batch job (Y/N)?" (in Korean,
 * "일괄 작업을 끝내시겠습니까 (Y/N)?") every time. A second Ctrl+C reaching
 * cmd while it asks appears to end cmd itself — the report behind
 * src/lib/shellExit.js, a terminal left dead after quitting OpenCode, with
 * STATUS_CONTROL_C_EXIT. Answering at once removes the question, and with it
 * the window for that second Ctrl+C. (A second Ctrl+C is never turned into
 * the answer: it cannot win that race, and it would turn a cancel into a
 * yes.)
 *
 * A Y typed into the wrong question is worse than none, so every condition
 * has to hold:
 *
 *   - a tab whose shell is cmd (`shellKindFor` in dropPaths.js), and an
 *     input to it that is exactly one Ctrl+C (`\x03`) — the store's
 *     `writeRaw`, where every input path meets. A paste with a Ctrl+C inside
 *     it is a paste;
 *   - nothing typed since: a key, a pasted block (bracketed or not), Enter,
 *     Alt+Enter, Shift+Enter as a program asked for it — a quick Ctrl+C at an
 *     idle prompt followed by `del *` must never have its "Are you sure
 *     (Y/N)?" answered. Only what the terminal itself reports (focus, the
 *     cursor position, its identity, a colour) and the arrow and paging keys
 *     are not typing (`isTerminalReport`);
 *   - within the window: BATCH_REPLY_WINDOW_MS after the Ctrl+C, longer
 *     while output keeps coming (up to BATCH_REPLY_LIMIT_MS — OpenCode can
 *     take a moment to wind down), restarted when the program leaves the
 *     alternate screen, and judged when a chunk ARRIVES, not when xterm gets
 *     round to parsing it. Armed while a full-screen program is up, it lasts
 *     until the limit: the question only comes once the program has gone;
 *   - the row the cursor is on — read off the screen once xterm has written
 *     the chunk, since ConPTY reorders and splits escape sequences, never in
 *     the alternate buffer — ends with `(Y/N)?` and is cmd's question: the
 *     `^C` cmd echoes is on it or on the row above, or it ends with the
 *     question's own words in English or Korean (`asksBatchJob`). A bare
 *     `(Y/N)?` is any program's;
 *   - and it is a NEW row: not the row, same place and same text, that was
 *     on screen when the Ctrl+C was pressed — a question the user was
 *     already looking at, and may have pressed Ctrl+C to get away from;
 *   - once: answering disarms.
 *
 * Every locale cmd ships that asks with (Y/N)? is covered, English and
 * Korean among them. A few translate the letters — German asks (J/N)?,
 * French (O/N) ? — and are deliberately not matched: the reply would have to
 * be the translated letter too.
 *
 * Terminals in groups not on screen are covered: their xterm instances live
 * in the registry and go on receiving output, so a Ctrl+C sent just before a
 * switch is still answered. A tab never shown has no xterm, but nothing can
 * have sent it a Ctrl+C either.
 *
 * Pure parts (`sendsCtrlC`, `isTerminalReport`, `typesSomething`,
 * `asksYesNo`, `asksBatchJob`, `screenRow`) and `createBatchJobReplies`, the
 * per-tab arming, which the terminal store owns (it knows the tabs, the
 * setting and how to type into a shell). The registry tells it when output
 * arrives and when xterm has written it (`writeOutput`), and lends it the
 * screen (`setBatchJobScreenReader`). Checked in
 * tests/adversarial/batch_job_reply.test.js.
 */

/** How long after a Ctrl+C — or after the last output, or leaving a full-screen program — cmd's question is answered. */
export const BATCH_REPLY_WINDOW_MS = 3000;

/** However much output keeps coming, the wait ends this long after the Ctrl+C (leaving a full-screen program aside). */
export const BATCH_REPLY_LIMIT_MS = 10000;

/** What is typed in answer: Y, and Enter. */
export const BATCH_REPLY = 'Y\r';

/** The question's own words, in the locales the target machines run: English and Korean. */
export const BATCH_JOB_QUESTIONS = Object.freeze([
  'Terminate batch job (Y/N)?',
  // "일괄 작업을 끝내시겠습니까 (Y/N)?"
  '\u{C77C}\u{AD04} \u{C791}\u{C5C5}\u{C744} \u{B05D}\u{B0B4}\u{C2DC}\u{ACA0}\u{C2B5}\u{B2C8}\u{AE4C} (Y/N)?',
]);

/** The most rows a wrapped question is read back over. */
const MAX_WRAPPED_ROWS = 4;

/** Whether input is a Ctrl+C, and only that — what arms. */
export function sendsCtrlC(data) {
  return data === '\x03';
}

/**
 * What xterm sends that the user did not type, or keys that only move: a
 * focus report, a cursor position or device attributes answer, a mode or
 * setting report (DECRPM, DCS — XTVERSION, DECRQSS), a colour or other OSC
 * answer, a mouse report, and the arrow, Home, End, Page Up and Page Down
 * keys, modified or not. One input may hold several of them.
 */
const REPORTS = [
  /\x1b\[[IO]/.source, // focus in / out
  /\x1b\[\??\d+;\d+R/.source, // cursor position
  /\x1b\[[?>=][\d;]*c/.source, // device attributes
  /\x1b\[\??[\d;]*\$y/.source, // DECRPM
  /\x1bP[^\x1b]*\x1b\\/.source, // DCS answers: XTVERSION, DECRQSS
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.source, // OSC answers: colours and the like
  /\x1b\[<\d+;\d+;\d+[Mm]/.source, // SGR mouse
  /\x1b\[M[\s\S]{3}/.source, // X10 mouse
  /\x1b\[(?:1;\d+)?[ABCDHF]/.source, // arrows, Home, End
  /\x1bO[ABCDHF]/.source, // the same in application mode
  /\x1b\[[56](?:;\d+)?~/.source, // Page Up, Page Down
];
const ONLY_REPORTS = new RegExp(`^(?:${REPORTS.join('|')})+$`);

/** Whether input is only the terminal reporting, or keys that only move (`REPORTS`). */
export function isTerminalReport(data) {
  return typeof data === 'string' && data !== '' && ONLY_REPORTS.test(data);
}

/**
 * Whether input is the user typing something after the Ctrl+C: anything but
 * a lone Ctrl+C and what `isTerminalReport` lets through. An escape sequence
 * is not exempt for starting with ESC — a bracketed paste does, and so do
 * Alt+Enter and Shift+Enter under modifyOtherKeys.
 */
export function typesSomething(data) {
  if (typeof data !== 'string' || data === '' || sendsCtrlC(data)) return false;
  return !isTerminalReport(data);
}

/** Whether a row of the screen ends with `(Y/N)?`, trailing spaces aside. */
export function asksYesNo(text) {
  return typeof text === 'string' && /\(Y\/N\)\?[ \t]*$/.test(text);
}

/**
 * Whether a row is cmd's own question: it ends with the question's own words
 * (`BATCH_JOB_QUESTIONS`), or it is cmd's `^C` echo with a `(Y/N)?` question
 * straight after it on the same row — `^CTerminate batch job (Y/N)?`, as cmd
 * prints it in a language not listed — with the `^C` at the start of the row
 * or right after the prompt's `>`. `row` is `{ text, above }`, as `screenRow`
 * reads it.
 *
 * A `^C` anywhere on the row, or on the row above, used to count, and with
 * the wait stretched while output keeps coming that answered other
 * programs: `[server] ^C received` on one row and `Run cleanup now (Y/N)?` on
 * the next got a Y (review, 2026-10-11). The row above is no longer read.
 */
export function asksBatchJob(row) {
  const text = row?.text;
  if (!asksYesNo(text)) return false;
  const asked = text.replace(/[ \t]+$/, '');
  if (BATCH_JOB_QUESTIONS.some((question) => asked.endsWith(question))) return true;
  return CMD_ECHO_THEN_QUESTION.test(asked);
}

/** cmd's `^C` echo with its question right after it: at the row's start, or after the prompt. */
const CMD_ECHO_THEN_QUESTION = /(?:^|>)\^C[^ \t^][^\n]*\(Y\/N\)\?$/;

/**
 * The screen at the cursor: `{ alternate: true }` while a full-screen
 * program has the alternate buffer, else `{ alternate: false, y, text,
 * above }` — the absolute row the cursor is on, its text with the rows it is
 * wrapped from, and the text of the row above those. Null with no buffer to
 * read (a disposed terminal, a test double).
 */
export function screenRow(term) {
  const buffers = term?.buffer;
  if (!buffers) return null;
  if (buffers.active?.type === 'alternate') return { alternate: true };
  const normal = buffers.normal ?? buffers.active;
  if (!normal || typeof normal.getLine !== 'function') return null;
  const y = normal.baseY + normal.cursorY;
  let line = normal.getLine(y);
  if (!line) return null;
  let text = line.translateToString(true);
  let top = y;
  for (let rows = 1; line.isWrapped && top > 0 && rows < MAX_WRAPPED_ROWS; rows += 1) {
    top -= 1;
    line = normal.getLine(top);
    if (!line) break;
    text = line.translateToString(false) + text;
  }
  const above = top > 0 ? normal.getLine(top - 1)?.translateToString(true) ?? null : null;
  return { alternate: false, y, text, above };
}

/** The text of the cursor's row, wrapped rows joined — null in the alternate buffer. */
export function cursorRowText(term) {
  const row = screenRow(term);
  return row && !row.alternate ? row.text : null;
}

/**
 * Where the arming reads a tab's screen as the Ctrl+C is pressed — set by
 * the registry, which has the terminals (`setBatchJobScreenReader`). The
 * store must not import it: it runs in Node under the suites, and xterm
 * brings a stylesheet with it. Returns `screenRow` of the tab's terminal, or
 * null when it has none.
 */
let screenReader = null;

/** Register the registry's reader. Returns an unregister function. */
export function setBatchJobScreenReader(fn) {
  screenReader = typeof fn === 'function' ? fn : null;
  return () => {
    if (screenReader === fn) screenReader = null;
  };
}

function readScreen(tabId) {
  try {
    return screenReader?.(tabId) ?? null;
  } catch {
    return null;
  }
}

/**
 * The arming, per tab. `isCmd(tabId)` says whether the tab's shell is cmd,
 * `enabled()` reads the setting, `reply(tabId, text)` types into the tab,
 * `now()` is the clock and `screen(tabId)` reads the tab's screen as
 * `screenRow` does — all read as each event comes, so the setting or a
 * restarted shell takes effect at once.
 */
export function createBatchJobReplies({
  isCmd = () => false,
  enabled = () => true,
  reply = () => {},
  now = () => Date.now(),
  screen = readScreen,
  windowMs = BATCH_REPLY_WINDOW_MS,
  limitMs = BATCH_REPLY_LIMIT_MS,
} = {}) {
  /**
   * tabId → `{ until, limit, before, alternate, left }`: when the wait ends
   * unless output extends it, the furthest output can extend it, the screen
   * row at the Ctrl+C, whether a full-screen program is up, and whether it
   * has been left since.
   */
  const armed = new Map();

  const check = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  return {
    /**
     * Input on its way to `tabId`'s shell. A lone Ctrl+C arms the tab — only
     * a cmd tab, with the setting on — and notes the row on screen then;
     * anything typed after it disarms it. Returns whether the tab is armed.
     */
    noteInput(tabId, data) {
      if (sendsCtrlC(data)) {
        if (!check(enabled, false) || !check(() => isCmd(tabId), false)) {
          armed.delete(tabId);
          return false;
        }
        const at = now();
        const before = check(() => screen(tabId), null);
        const alternate = Boolean(before?.alternate);
        armed.set(tabId, {
          // Up on a full-screen program, the question comes only once it has
          // gone: wait for that, up to the limit.
          until: at + (alternate ? limitMs : windowMs),
          limit: at + limitMs,
          before: before && !before.alternate ? before : null,
          alternate,
          left: false,
        });
        return true;
      }
      if (typesSomething(data)) armed.delete(tabId);
      return armed.has(tabId);
    },

    /**
     * A chunk of `tabId`'s output has arrived. Whether the tab still waits —
     * judged now, as it arrives, not when xterm has parsed it — and output
     * coming keeps the wait open a little longer, up to the limit.
     */
    outputArrived(tabId) {
      const state = armed.get(tabId);
      if (!state) return false;
      const at = now();
      if (at > state.until) {
        armed.delete(tabId);
        return false;
      }
      state.until = Math.max(state.until, Math.min(at + windowMs, state.limit));
      return true;
    },

    /** Whether `tabId` waits, by the time it was last judged — for the suites. */
    isArmed(tabId) {
      return armed.has(tabId);
    },

    /**
     * A chunk that arrived while `tabId` waited has been written into `term`.
     * Answers when the row the cursor is on is cmd's question, new since the
     * Ctrl+C, and says whether it did. The alternate buffer is never read;
     * leaving it starts the window again, since cmd asks only after the
     * program has gone.
     */
    afterOutput(tabId, term) {
      const state = armed.get(tabId);
      if (!state) return false;
      if (!check(enabled, false) || !check(() => isCmd(tabId), false)) {
        armed.delete(tabId);
        return false;
      }
      const row = check(() => screenRow(term), null);
      if (!row) return false;
      if (row.alternate) {
        state.alternate = true;
        return false;
      }
      if (state.alternate && !state.left) {
        state.alternate = false;
        state.left = true;
        const at = now();
        state.until = at + windowMs;
        state.limit = Math.max(state.limit, state.until);
      }
      if (!asksBatchJob(row)) return false;
      const before = state.before;
      if (before && before.y === row.y && before.text === row.text) return false;
      armed.delete(tabId);
      reply(tabId, BATCH_REPLY);
      return true;
    },

    /** Forget a tab — it closed. */
    forget(tabId) {
      armed.delete(tabId);
    },

    /** Forget every tab — for the suites. */
    reset() {
      armed.clear();
    },
  };
}

export default {
  BATCH_REPLY_WINDOW_MS,
  BATCH_REPLY_LIMIT_MS,
  BATCH_REPLY,
  BATCH_JOB_QUESTIONS,
  sendsCtrlC,
  isTerminalReport,
  typesSomething,
  asksYesNo,
  asksBatchJob,
  screenRow,
  cursorRowText,
  setBatchJobScreenReader,
  createBatchJobReplies,
};
