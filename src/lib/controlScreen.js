/**
 * What `nexterm-cli read-screen` hands back (stage 7, spec D4): a terminal's
 * screen, or the last lines of its scrollback, as plain text — masked as the
 * saved scrollback is (stage 6) unless the caller may and does say otherwise.
 *
 * WHAT IS READ.
 * - By default the SCREEN: the rows the program draws on, from the top of the
 *   screen down, whatever the user has scrolled to — a program asking what is
 *   on its terminal means what it drew, not the user's place in the history.
 * - With `lines`, the last that many logical lines of the normal buffer,
 *   scrollback included: what an agent printed before.
 * - While a full-screen program has the alternate screen up (OpenCode, vim,
 *   less), that screen, whichever was asked: it is what the user sees, and
 *   the normal buffer under it is a shell nobody is looking at. `alternate`
 *   says so in the result. It has no scrollback, so `lines` only cuts it.
 *
 * Lines are LOGICAL: a line the terminal wrapped at its width comes back as
 * the one line the program printed, so a token cut by the margin is whole
 * again for masking, and a script reading it gets what was printed. Blank
 * lines above and below the text are left out, as the saved scrollback
 * leaves them out.
 *
 * MASKED by default with stage 6's `maskLines`, across the window's top edge
 * as a save is (`stateAbove`): what a hook reads back must not be a way
 * round what the saved file hides. The `mask: false` the scope rules allow
 * (src/lib/controlScope.js) hands the screen over as it is.
 *
 * Pure, given an xterm (or `@xterm/headless`) terminal: no store, no IPC.
 */
import { maskLines, readLogicalLines, stateAbove, utf8Length } from './scrollbackSnapshot.js';

/**
 * The most text one answer carries, in UTF-8 bytes. The backend refuses an
 * answer over 1 MiB (spec D3), and JSON can double what a line costs (every
 * `"` and `\` escaped), so half of it — the OLDEST lines go first.
 */
export const READ_MAX_BYTES = 512 * 1024;

/** How far above a row a wrapped line is followed back to where it starts. */
const MAX_WRAP_ROWS = 2000;

/** The row the logical line holding `row` starts on. */
function lineStart(buffer, row) {
  let y = Math.max(0, Math.min(row, buffer.length - 1));
  for (let steps = 0; y > 0 && steps < MAX_WRAP_ROWS; steps += 1) {
    if (!buffer.getLine(y)?.isWrapped) break;
    y -= 1;
  }
  return y;
}

/**
 * The row where the last `count` logical lines of `buffer` start — the blank
 * rows under the last output not counted, as `readLogicalLines` leaves them
 * out. Read from the bottom up, a row at a time, so a 100 000-line
 * scrollback costs what the lines asked for and no more.
 */
function startOfLast(buffer, count) {
  let y = buffer.length - 1;
  while (y > 0) {
    const line = buffer.getLine(y);
    if (!line || line.isWrapped || line.translateToString(true).trim() !== '') break;
    y -= 1;
  }
  let starts = 0;
  for (; y >= 0; y -= 1) {
    const line = buffer.getLine(y);
    if (!line || line.isWrapped) continue;
    starts += 1;
    if (starts >= count) return y;
  }
  return 0;
}

/** A logical line as plain text: its runs' characters, without their colours. */
const plainText = (line) => line.runs.map((run) => run.text).join('');

/**
 * `term`'s screen, or its last `lines` logical lines, as the answer to
 * `read-screen`:
 *
 *   { lines, alternate, cols, rows, masked, hidden, truncated }
 *
 * `lines` — the lines, oldest first, each plain text (what `nexterm-cli`
 * prints one to a line); `hidden` — how many secrets masking replaced with
 * `[hidden]`; `truncated` — older lines were left out to keep the answer
 * within READ_MAX_BYTES.
 */
export function readScreen(term, { lines = 0, mask = true, maxBytes = READ_MAX_BYTES } = {}) {
  const alternate = term.buffer.active?.type === 'alternate';
  const buffer = alternate ? term.buffer.alternate : term.buffer.normal;
  const wanted = Number.isInteger(lines) && lines > 0 ? lines : 0;
  // The screen starts at `baseY` (0 on the alternate one, which has no
  // scrollback); a line wrapped onto its first row is read from where it began.
  const fromRow = wanted > 0 && !alternate ? startOfLast(buffer, wanted) : lineStart(buffer, buffer.baseY);
  let logical = readLogicalLines(term, fromRow, buffer);
  if (wanted > 0 && logical.length > wanted) logical = logical.slice(logical.length - wanted);

  let hidden = 0;
  if (mask !== false) {
    // What the rows above the window leave masking in the middle of — a key
    // block begun above it — as a save reads it. The alternate screen has
    // nothing above.
    const above = alternate ? {} : stateAbove(buffer, fromRow);
    hidden = maskLines(logical, { cols: term.cols, ...above }).reduce((sum, n) => sum + n, 0);
  }

  const texts = logical.map(plainText);
  let first = 0;
  let bytes = texts.reduce((sum, t) => sum + utf8Length(t) + 1, 0);
  while (first < texts.length && bytes > maxBytes) {
    bytes -= utf8Length(texts[first]) + 1;
    first += 1;
  }
  const kept = first > 0 ? texts.slice(first) : texts;
  return {
    lines: kept,
    alternate,
    cols: term.cols,
    rows: term.rows,
    masked: mask !== false,
    hidden,
    truncated: first > 0,
  };
}

/**
 * A prompt asking for a secret, by its words, at the end of the line the
 * cursor is on (review F8, re-verification F3): `Password:`, `[sudo]
 * password for kim:`, `Password (again):`, `Enter passphrase for key '…':`,
 * openssl's `Enter pass phrase for …:` and `Enter PEM pass phrase:`, `Enter
 * PIN:`, `Enter PIN for 'SSH key':`, `Passcode:`, `Verification code:`,
 * `Enter secret:`, `Token:`, `OTP:`, `MFA code:`, `Authentication code:`,
 * `API key:`, the German, French, Spanish, Japanese, Chinese and Korean
 * words (`Kennwort:`, `Mot de passe :`, `パスワード:`, `[sudo] kim의 암호:`) —
 * in any case, the keyword anywhere before the line's last colon (or a `>`
 * after a password or passphrase: `Password>`), and after it nothing but
 * spaces and the stars or blanks some prompts echo (PowerShell's
 * -AsSecureString, sudo's pwfeedback, `Passphrase: ____`). `nexterm-cli send` refuses to type
 * into a terminal showing one.
 *
 * On macOS and Linux the backend also reads the terminal's echo, which is
 * off at every password prompt whatever it says (`secretInput`); on Windows
 * there is no such thing to read, and THIS is all there is — so it is asked
 * on every platform, as a second net there and the only one here. A false
 * alarm (`grep password:` typed at a prompt) only refuses a send; a miss
 * types into a secret.
 */
const SECRET_WORDS = [
  String.raw`\bpass(?:word|code|phrase)\b`,
  String.raw`\bpass phrase\b`,
  String.raw`\bpin\b`,
  String.raw`\b(?:verification|authentication|mfa) code\b`,
  String.raw`\bapi key\b`,
  String.raw`\bsecret\b`,
  String.raw`\btoken\b`,
  String.raw`\botp\b`,
  // German, French, Spanish, Japanese, Chinese, Korean: Windows' own
  // prompts and many a tool's are localised, and there the words are all
  // there is to go by.
  String.raw`\bpasswort\b`,
  String.raw`\bkennwort\b`,
  String.raw`\bmot de passe\b`,
  String.raw`\bcontraseña`,
  'パスワード',
  '密码',
  '密碼',
  '비밀번호',
  '암호',
].join('|');
/** After the prompt's colon, what may follow it on a prompt still waiting: spaces, and echoed stars or blanks. */
const PROMPT_TAIL = String.raw`[\s*_]*$`;
// The colon, or the full-width one Chinese and Japanese prompts end in (`密码：`).
const SECRET_PROMPT = new RegExp(`(?:${SECRET_WORDS}).*[:\u{ff1a}]${PROMPT_TAIL}`, 'iu');
/** `Password>` — a password or passphrase asked for with a `>` instead of a colon. */
const SECRET_ANGLE_PROMPT = new RegExp(String.raw`\bpass(?:word|phrase)\b.*>` + PROMPT_TAIL, 'iu');

/** How far back over wrapped rows the cursor's line is followed. */
const MAX_PROMPT_ROWS = 50;

/** Whether `term`'s cursor line — the whole logical line, wrapped rows joined — ends in a prompt for a secret. */
export function secretPromptOnScreen(term) {
  const buffer = term?.buffer?.active;
  if (!buffer) return false;
  const row = buffer.baseY + buffer.cursorY;
  let start = row;
  for (let steps = 0; start > 0 && steps < MAX_PROMPT_ROWS && buffer.getLine(start)?.isWrapped; steps += 1) start -= 1;
  let text = '';
  for (let y = start; y <= row; y += 1) text += buffer.getLine(y)?.translateToString(y === row) ?? '';
  const line = text.trim();
  return SECRET_PROMPT.test(line) || SECRET_ANGLE_PROMPT.test(line);
}
