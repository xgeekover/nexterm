/**
 * Project commands: what a repository's `.nexterm/commands.json` — and the
 * user's own list in Settings, in the same format — says can be typed into a
 * terminal, with blanks to fill in.
 *
 * The file is somebody else's text that ends up in the user's shell, so this
 * module is mostly refusals (spec: vault "NexTerm - 5단계 프로젝트별 사용자 명령
 * 설계", threat model and D1–D5, D9):
 *
 *   - A file is read strictly. A key NexTerm does not know refuses its
 *     command — `comand` for `command` must not pass silently — and a top
 *     level or a version it does not know refuses the file. One refused
 *     command does not take the others with it.
 *   - A command line is one line, and holds nothing that reads differently
 *     from what runs: no control character, no bidi control, no invisible
 *     character. It is refused, not cleaned: quietly changing someone else's
 *     command is worse than saying no.
 *   - A blank is `{{name}}` exactly; anything else between double braces is
 *     text, so Go, Docker and Helm templates pass through. Values are put in
 *     one pass and never searched for blanks again.
 *   - A value is the user's own text, quoted for the shell of the terminal it
 *     goes to so that it stays ONE word of what they meant. A value that shell
 *     cannot be given safely is refused, with the reason, the way a dropped
 *     path is (dropPaths.js).
 *   - Trust is of one content in one folder: (folder, SHA-256 of the file's
 *     bytes). Anything else — another folder, a changed byte — asks again.
 *
 * Pure: no React, no stores, no storage.
 */
import { CMD_NEEDS_QUOTES, SHELL_KINDS } from './dropPaths.js';

/** Where a folder keeps its commands, below the open folder. */
export const COMMANDS_FILE = '.nexterm/commands.json';

/** The only format version this NexTerm reads. */
export const FORMAT_VERSION = 1;

/**
 * Every limit, in code points. Generous for a real file, small enough that a
 * hostile one cannot fill the palette or a dialog with a wall of text.
 */
export const LIMITS = Object.freeze({
  commands: 200,
  name: 80,
  description: 300,
  command: 2000,
  placeholders: 20,
  label: 80,
  value: 1000,
  choices: 50,
  /**
   * The line as typed, values in: under cmd's 8191-character limit for what
   * can be typed at its prompt, with room to spare.
   */
  line: 8000,
  /** The Settings field, in characters (the backend caps the project file at 256 KB). */
  userText: 65536,
});

/**
 * Characters nothing may hold that is typed: every control character (Cc —
 * C0, tab included, DEL, C1), every format character (Cf — bidi controls,
 * zero-width space and joiners, word joiner, invisible operators, the byte
 * order mark, the tag characters), the line and paragraph separators, every
 * default-ignorable code point (what fonts draw as nothing: the Hangul
 * fillers, the Mongolian and Khmer invisible vowels, U+FFF0–FFF8 …) and the
 * braille blank, which draws as a space and is none.
 *
 * By property rather than by a list: a hand-written list let thousands
 * through (the tag block U+E0000–E007F among them, which a browser draws as
 * nothing, so `./build<U+E0062>.sh` showed as `./build.sh`). A line break
 * would run what comes before it on its own; a bidi control makes a line
 * read in another order than it runs (Trojan Source); an invisible character
 * makes two different words look the same, or hides a word boundary.
 * Variation selectors are allowed (`VARIATION_SELECTOR`): an emoji needs
 * them, and they cannot reorder or hide anything.
 */
const FORBIDDEN_CLASS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/gu;
const VARIATION_SELECTOR = /^[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]$/u;

/**
 * Spaces that are not U+0020: shells split words only at a plain space or a
 * tab, so `./build.sh<U+00A0>--dry-run` reads as a flag and runs as one file
 * name. Refused in a command line; in a value they are quoted like any other
 * character that is not plain.
 */
const ODD_SPACE = /[\u{A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/u;

/** A blank: `{{` + a name + `}}`, nothing else between the braces. */
const BLANK = /\{\{([A-Za-z_][A-Za-z0-9_-]{0,39})\}\}/gu;
const BLANK_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/u;

/** Quote characters a blank may not touch: NexTerm quotes values itself. */
const QUOTE_CHARS = new Set(["'", '"', '`']);

const TOP_KEYS = new Set(['$schema', 'version', 'commands']);
const COMMAND_KEYS = new Set(['name', 'description', 'command', 'placeholders']);
const PLACEHOLDER_KEYS = new Set(['label', 'description', 'default', 'choices']);

/** Length in code points, which is what a person counts. */
function length(text) {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `U+200B` for a character. */
function codeOf(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** What a forbidden character is, said plainly. */
function describeForbidden(char) {
  const cp = char.codePointAt(0);
  if (cp === 0x0a || cp === 0x0d || cp === 0x85 || cp === 0x2028 || cp === 0x2029) return `a line break (${codeOf(char)})`;
  if (cp === 0x09) return 'a tab';
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return `a control character (${codeOf(char)})`;
  if (cp === 0x61c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
    return `a bidirectional control (${codeOf(char)})`;
  }
  return `an invisible character (${codeOf(char)})`;
}

/** The first forbidden character in `text` and where (in code points), or null. */
function forbiddenIn(text) {
  for (const match of text.matchAll(FORBIDDEN_CLASS)) {
    if (VARIATION_SELECTOR.test(match[0])) continue;
    return { char: match[0], at: length(text.slice(0, match.index)) + 1 };
  }
  return null;
}

/**
 * Why `line` cannot be typed as one line of text, or null: empty, or holding
 * a character no command or value may hold (FORBIDDEN_CLASS), or too long. The check the store
 * makes right before it types a project command, whoever built the line.
 */
export function lineProblem(line) {
  if (typeof line !== 'string' || line.trim() === '') return 'there is no line to type';
  if (length(line) > LIMITS.line) return `the line is longer than ${LIMITS.line} characters — cmd takes no more at its prompt`;
  const bad = forbiddenIn(line);
  if (!bad) return null;
  const code = codeOf(bad.char);
  return describeForbidden(bad.char).startsWith('a line break')
    ? `the line holds a line break (${code}), which would run what comes before it on its own`
    : `the line holds a character that is not text (${code})`;
}

/**
 * `text` as one line of display: forbidden characters dropped, runs of white
 * space as one space, trimmed, and cut at `max` code points with an
 * ellipsis. For names, descriptions and labels — someone else's text shown
 * in the palette and the dialogs (spec D9). Anything not a string is ''.
 */
export function displayText(text, max = LIMITS.description) {
  if (typeof text !== 'string') return '';
  const flat = text
    .replace(/[\r\n\u{85}\u{2028}\u{2029}\t]+/gu, ' ')
    .replace(FORBIDDEN_CLASS, (char) => (VARIATION_SELECTOR.test(char) ? char : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}\u{2026}` : flat;
}

/** A name or key from the file, safe to put in a message. */
function shown(text, max = 40) {
  return JSON.stringify(displayText(String(text), max));
}

/**
 * The blanks of a command line, in order: `{ name, start, end }`, `start` and
 * `end` as string indexes of the whole `{{name}}`.
 */
export function blanksIn(template) {
  if (typeof template !== 'string') return [];
  const found = [];
  for (const match of template.matchAll(BLANK)) {
    found.push({ name: match[1], start: match.index, end: match.index + match[0].length });
  }
  return found;
}

/**
 * Why `template` cannot be a command line, or null. One line, within the
 * limit, nothing forbidden in it, and no blank touching a quote character or
 * another blank (spec D2: NexTerm quotes values itself, and on cmd `"a""b"`
 * reads as `a"b`).
 */
function commandProblem(template) {
  if (template === '') return 'the command is empty';
  if (length(template) > LIMITS.command) return `the command is longer than ${LIMITS.command} characters`;
  const bad = forbiddenIn(template);
  if (bad) {
    const what = describeForbidden(bad.char);
    return what.startsWith('a line break')
      ? 'the command is more than one line — typed into a shell, a second line goes to whatever the first one started. Join them with && or ;, or put them in a script'
      : `the command holds ${what} at character ${bad.at} — it would not read as what it runs`;
  }
  const odd = ODD_SPACE.exec(template);
  if (odd) {
    return `the command holds a space that is not a plain space (${codeOf(odd[0])}) at character ${length(template.slice(0, odd.index)) + 1} — a shell does not split words there, so it reads as two words and runs as one`;
  }
  const history = historyExpansionIn(template);
  if (history) return history;
  const blanks = blanksIn(template);
  for (let i = 0; i < blanks.length; i += 1) {
    const { name, start, end } = blanks[i];
    if (QUOTE_CHARS.has(template[start - 1]) || QUOTE_CHARS.has(template[end])) {
      return `{{${name}}} has a quote right beside it — NexTerm quotes the value itself; take the quotes away`;
    }
    if (i > 0 && blanks[i - 1].end === start) {
      return `{{${blanks[i - 1].name}}} and {{${name}}} touch — put something between them`;
    }
  }
  return blankPlacementProblem(template, blanks);
}

/**
 * How each shell family reads quotes and escapes, as far as where a blank
 * sits is concerned (`blankPlacementProblem`). A value is quoted to be one
 * word where a word may start: outside every quote, not escaped. One file
 * serves every shell, so a blank must be in such a place for all of them.
 *
 *   cmd         "…" only; ^ escapes the next character outside quotes
 *   posix       '…' (nothing inside is special), "…" (\ escapes inside),
 *               `…` (a command inside, with one round of \ taken off);
 *               \ escapes outside quotes
 *   powershell  '…' and "…" with their typographic kin, which it reads as
 *               the same quotes; ` escapes outside '…'
 */
const SINGLE = 'single';
const DOUBLE = 'double';
const BACKTICK = 'backtick';
const READERS = [
  { quotes: { '"': DOUBLE }, escape: '^', escapesInDouble: false },
  { quotes: { "'": SINGLE, '"': DOUBLE, '`': BACKTICK }, escape: '\\', escapesInDouble: true },
  {
    quotes: {
      "'": SINGLE, '\u{2018}': SINGLE, '\u{2019}': SINGLE, '\u{201A}': SINGLE, '\u{201B}': SINGLE,
      '"': DOUBLE, '\u{201C}': DOUBLE, '\u{201D}': DOUBLE, '\u{201E}': DOUBLE,
    },
    escape: '`',
    escapesInDouble: true,
  },
];

/**
 * Why a blank of `template` is somewhere its value's quoting would not hold,
 * or null: inside quotes of any shell (`echo "note: {{m}}"` — the value's
 * own quotes are then literal, or close the template's), right after an
 * escape character (`\{{v}}`, `^{{v}}`, `` `{{v}} ``), right after `$`
 * (bash reads `$'…'` with escapes in it), or after PowerShell's `--%`,
 * which passes the rest of the line on as it stands.
 */
function blankPlacementProblem(template, blanks) {
  if (blanks.length === 0) return null;
  const startsAt = new Map(blanks.map((b) => [b.start, b]));
  const inside = (b) => `{{${b.name}}} is inside quotes — NexTerm quotes the value itself; take the quotes from around it`;
  for (const reader of READERS) {
    let state = null;
    for (let i = 0; i < template.length; i += 1) {
      const blank = startsAt.get(i);
      if (blank) {
        if (state !== null) return inside(blank);
        i = blank.end - 1;
        continue;
      }
      const char = template[i];
      if (state === null) {
        if (char === reader.escape) {
          const next = startsAt.get(i + 1);
          if (next) return `{{${next.name}}} comes right after ${char}, which would change how its value is read — put a space between them`;
          i += 1;
        } else if (reader.quotes[char]) {
          state = reader.quotes[char];
        }
      } else if (state === DOUBLE && reader.escapesInDouble && char === reader.escape) {
        i += 1;
      } else if (reader.quotes[char] === state) {
        state = null;
      }
    }
  }
  for (const blank of blanks) {
    if (template[blank.start - 1] === '$') return `{{${blank.name}}} comes right after $ — bash reads $'…' with escapes in it; put a space between them`;
  }
  const stop = /(?:^|\s)--%(?:\s|$)/u.exec(template);
  if (stop && blanks.some((b) => b.start > stop.index)) {
    return 'a blank comes after --% — from there PowerShell passes the line on as it stands, quotes included';
  }
  return null;
}

/**
 * Why `template` would be changed by bash's or zsh's history expansion at
 * an interactive prompt, or null. Typed there, `!!`, `!$`, `!-2`, `!word`
 * and `!?word?` are replaced by earlier lines — which may hold anything,
 * secrets included — before the line runs, and `^old^new` at the start of a
 * line runs the last one changed. Only single quotes and a backslash stop
 * it; a `!` followed by a space, a tab, `=` or `(`, or at the end, is left
 * alone. Values never need this: a `!` in one is always single-quoted
 * (`quoteValue`), or refused for cmd.
 */
function historyExpansionIn(template) {
  if (/^\s*\^/u.test(template)) return 'the command starts with ^, which bash and zsh read as "run the last command, changed" at an interactive prompt';
  let single = false;
  for (let i = 0; i < template.length; i += 1) {
    const char = template[i];
    if (single) {
      if (char === "'") single = false;
    } else if (char === "'") {
      single = true;
    } else if (char === '\\') {
      i += 1;
    } else if (char === '!' && i + 1 < template.length && !/[\s=(]/u.test(template[i + 1])) {
      return `the command holds ${template.slice(i, i + 2)} at character ${length(template.slice(0, i)) + 1} — at an interactive bash or zsh prompt that is replaced by an earlier command before it runs. Put it in single quotes`;
    }
  }
  return null;
}

/** Why `value` cannot be a default or a choice, or null. */
function valueProblem(value, what) {
  if (typeof value !== 'string') return `${what} must be text (in quotes)`;
  if (length(value) > LIMITS.value) return `${what} is longer than ${LIMITS.value} characters`;
  const bad = forbiddenIn(value);
  return bad ? `${what} holds ${describeForbidden(bad.char)}` : null;
}

/** A text field of the file that is shown, not typed: a string within `max`, or absent. */
function shownProblem(value, key, max) {
  if (value === undefined) return null;
  if (typeof value !== 'string') return `"${key}" must be text`;
  return length(value) > max ? `"${key}" is longer than ${max} characters` : null;
}

/**
 * One declared blank, checked: `{ placeholder }` or `{ reason }`.
 */
function readPlaceholder(name, spec) {
  if (!BLANK_NAME.test(name)) return { reason: `${shown(name)} is not a blank's name — letters, digits, _ and -, starting with a letter or _` };
  if (!isPlainObject(spec)) return { reason: `the blank ${name} must be an object` };
  for (const key of Object.keys(spec)) {
    if (!PLACEHOLDER_KEYS.has(key)) return { reason: `the blank ${name} has a key NexTerm does not know: ${shown(key)}` };
  }
  const problem = shownProblem(spec.label, 'label', LIMITS.label) ?? shownProblem(spec.description, 'description', LIMITS.description);
  if (problem) return { reason: `the blank ${name}: ${problem}` };
  let choices = null;
  if (spec.choices !== undefined) {
    if (!Array.isArray(spec.choices) || spec.choices.length === 0) return { reason: `the blank ${name}: "choices" must be a list of at least one` };
    if (spec.choices.length > LIMITS.choices) return { reason: `the blank ${name} has more than ${LIMITS.choices} choices` };
    for (const choice of spec.choices) {
      const p = valueProblem(choice, 'a choice');
      if (p) return { reason: `the blank ${name}: ${p}` };
    }
    choices = [...spec.choices];
  }
  let fallback = '';
  if (spec.default !== undefined) {
    const p = valueProblem(spec.default, '"default"');
    if (p) return { reason: `the blank ${name}: ${p}` };
    if (choices && !choices.includes(spec.default)) return { reason: `the blank ${name}: "default" is not one of its choices` };
    fallback = spec.default;
  } else if (choices) {
    fallback = choices[0];
  }
  return {
    placeholder: {
      name,
      label: displayText(spec.label ?? '', LIMITS.label) || name,
      description: displayText(spec.description ?? '', LIMITS.description),
      default: fallback,
      choices,
    },
  };
}

/** One entry of `commands`, checked: `{ command }` or `{ reason, name }`. */
function readCommand(entry) {
  if (!isPlainObject(entry)) return { reason: 'not an object', name: null };
  const rawName = typeof entry.name === 'string' ? entry.name : null;
  const name = rawName === null ? null : displayText(rawName, LIMITS.name + 1);
  const refuse = (reason) => ({ reason, name: name || null });
  for (const key of Object.keys(entry)) {
    if (!COMMAND_KEYS.has(key)) return refuse(`a key NexTerm does not know: ${shown(key)}`);
  }
  if (rawName === null) return refuse('"name" is missing or not text');
  if (!name) return refuse('"name" is empty');
  if (length(rawName.trim()) > LIMITS.name) return refuse(`"name" is longer than ${LIMITS.name} characters`);
  const described = shownProblem(entry.description, 'description', LIMITS.description);
  if (described) return refuse(described);
  if (typeof entry.command !== 'string') return refuse('"command" is missing or not text');
  const template = entry.command.trim();
  const problem = commandProblem(template);
  if (problem) return refuse(problem);

  const declared = new Map();
  if (entry.placeholders !== undefined) {
    if (!isPlainObject(entry.placeholders)) return refuse('"placeholders" must be an object');
    const names = Object.keys(entry.placeholders);
    if (names.length > LIMITS.placeholders) return refuse(`more than ${LIMITS.placeholders} blanks`);
    for (const blankName of names) {
      const read = readPlaceholder(blankName, entry.placeholders[blankName]);
      if (read.reason) return refuse(read.reason);
      declared.set(blankName, read.placeholder);
    }
  }
  // The blanks are those the line uses, in the order it uses them; one it
  // uses without declaring is a plain field named after it, and one declared
  // but never used is nothing to ask for.
  const used = [];
  for (const { name: blankName } of blanksIn(template)) {
    if (used.some((p) => p.name === blankName)) continue;
    used.push(declared.get(blankName) ?? { name: blankName, label: blankName, description: '', default: '', choices: null });
  }
  if (used.length > LIMITS.placeholders) return refuse(`more than ${LIMITS.placeholders} blanks`);
  return {
    command: {
      name,
      description: displayText(entry.description ?? '', LIMITS.description),
      template,
      placeholders: used,
    },
  };
}

/**
 * The commands `text` defines.
 *
 * Returns `{ ok: false, reason }` for a text that is no commands file at all
 * — not JSON, not the top level this version reads, too many commands — and
 * otherwise `{ ok: true, commands, refused }`: each command as `{ key,
 * source, name, description, template, placeholders }` (placeholders as
 * `{ name, label, description, default, choices }`, in the order the line
 * uses them), and each refused entry as `{ index, name, reason }`, `name`
 * null when it had none worth showing.
 *
 * `source` ('project' or 'user') is carried on every command and keys it.
 * `maxLength` caps the text before it is parsed (the Settings field; the
 * backend caps the project file in bytes).
 *
 * @param {string} text
 * @param {{ source?: 'project'|'user', maxLength?: number }} options
 */
export function parseCommandsFile(text, { source = 'project', maxLength = Infinity } = {}) {
  if (typeof text !== 'string') return { ok: false, reason: 'There is no text to read.' };
  if (text.length > maxLength) return { ok: false, reason: `It is longer than ${maxLength} characters.` };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `It is not valid JSON: ${displayText(String(err?.message ?? err), 160)}` };
  }
  if (!isPlainObject(data)) return { ok: false, reason: `It must be an object: { "version": ${FORMAT_VERSION}, "commands": [ … ] }.` };
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.has(key)) return { ok: false, reason: `It has a key NexTerm does not know at the top: ${shown(key)} — only "version" and "commands" belong there.` };
  }
  if (data.version === undefined) return { ok: false, reason: `It has no "version": ${FORMAT_VERSION}.` };
  if (data.version !== FORMAT_VERSION) {
    return { ok: false, reason: `It is version ${shown(String(data.version), 20)}; this NexTerm reads version ${FORMAT_VERSION}.` };
  }
  if (!Array.isArray(data.commands)) return { ok: false, reason: '"commands" must be a list.' };
  if (data.commands.length > LIMITS.commands) return { ok: false, reason: `It has more than ${LIMITS.commands} commands.` };

  const commands = [];
  const refused = [];
  const seen = new Set();
  data.commands.forEach((entry, index) => {
    const read = readCommand(entry);
    if (read.reason) {
      refused.push({ index, name: read.name, reason: read.reason });
      return;
    }
    // Names are compared as they are shown, so two that look the same — a
    // zero-width space, a case, a space — are the same name.
    const identity = read.command.name.toLowerCase();
    if (seen.has(identity)) {
      refused.push({ index, name: read.command.name, reason: 'a command of this name comes before it' });
      return;
    }
    seen.add(identity);
    commands.push({ key: `${source}:${index}`, source, ...read.command });
  });
  return { ok: true, commands, refused };
}

/** A refusal from `quoteValue`. */
function refusal(reason) {
  return { ok: false, reason };
}

/**
 * Characters Windows turns into `"` or `\\` for a program that reads its
 * command line in the system code page ("best fit": the fullwidth quotation
 * mark and reverse solidus, the double prime, the ditto mark, the yen sign
 * under Japanese code page 932, the won sign under Korean 949 …). cmd and
 * PowerShell pass them on as they are, and such a program then finds a
 * quote or a backslash where NexTerm put none: `"x y₩"` arrives as
 * `"x y\\"`, its closing quote escaped. Refused in values for both.
 */
const WINDOWS_BEST_FIT = /[\u{FF02}\u{FF3C}\u{FE68}\u{2216}\u{A5}\u{20A9}\u{2033}\u{2036}\u{02BA}\u{02DD}\u{02EE}\u{030E}\u{3003}\u{201C}\u{201D}\u{201E}\u{201F}]/u;

/**
 * What cmd cannot be given inside a value: `"` (there is no way to write one
 * inside quotes), `%` (expanded even inside quotes), `!` (expanded when
 * delayed expansion is on).
 */
const CMD_REFUSED = [
  ['"', 'cmd has no way to put a " inside a quoted word'],
  ['%', 'cmd expands %…% even inside quotes'],
  ['!', 'cmd expands !…! when delayed expansion is on'],
];

/** PowerShell's double quotes, the typographic ones included (it reads them all as `"`). */
const POWERSHELL_DOUBLE = /["\u{201C}\u{201D}\u{201E}]/u;
/** PowerShell's single quotes, the typographic ones included; doubled inside '…'. */
const POWERSHELL_SINGLE = /['\u{2018}\u{2019}\u{201A}\u{201B}]/gu;
/** A word PowerShell reads as text as it stands: no sigil, no operator, not a number or an option. */
const POWERSHELL_BARE = /^[\p{L}_][\p{L}\p{N}\p{M}_.:\\/-]*$/u;

/**
 * A word bash, zsh and sh read as it stands: no glob, no expansion, no
 * operator. Not starting with `=` (zsh's `=cmd`), `~` (the home folder) or
 * `-`, and without `%` (fish's `%self`), which are quoted instead.
 */
const POSIX_BARE = /^[\p{L}\p{N}\p{M}_./+,:@=-]+$/u;
const POSIX_BAD_START = /^[-=~]/u;
/** What `"…"` would still expand in a POSIX shell (and `!`, bash's and zsh's history). */
const POSIX_DOUBLE_UNSAFE = /[$`"\\!]/u;

/** The only words a shell NexTerm does not know is given: nothing in them needs quoting anywhere. */
const UNKNOWN_BARE = /^[A-Za-z0-9._/:@+=,-]+$/u;

/**
 * `value` as one word of the shell of `kind` (one of SHELL_KINDS): `{ ok:
 * true, text }`, or `{ ok: false, reason }` for a value that shell cannot be
 * given safely. An empty value is nothing — '' — so an optional argument can
 * be left out (spec D2).
 *
 *   cmd         bare, or "…" with a trailing backslash doubled (programs split
 *               their command line by CommandLineToArgvW, where \" is a
 *               quote); refused: " % !
 *   powershell  bare when it starts with a letter or _ and holds nothing
 *               PowerShell reads; else '…', single quotes doubled. Refused:
 *               " and its typographic kin — Windows PowerShell 5.1 hands them
 *               to programs unescaped — and, with a space, a trailing \ (5.1
 *               quotes the argument and the \ escapes its closing quote)
 *   posix       bare, "…" when the value has a ' and nothing "…" expands,
 *               else '…' with ' as '\''; also msys, cygwin and wsl
 *   fish        as posix, but in '…' fish reads \\ and \'
 *   unknown     bare or refused
 *
 * @param {string} value
 * @param {string} kind
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function quoteValue(value, kind) {
  if (typeof value !== 'string') return refusal('it is not text');
  const bad = forbiddenIn(value);
  if (bad) return refusal(`it holds ${describeForbidden(bad.char)}, which cannot be typed as part of a value`);
  if (length(value) > LIMITS.value) return refusal(`it is longer than ${LIMITS.value} characters`);
  if (value === '') return { ok: true, text: '' };
  const known = SHELL_KINDS.includes(kind) ? kind : 'unknown';
  if (known === 'cmd' || known === 'powershell') {
    const fit = WINDOWS_BEST_FIT.exec(value);
    if (fit) {
      return refusal(`it holds ${fit[0]} (${codeOf(fit[0])}), which Windows hands some programs as a " or a \\ — it would end or escape the quotes around the value`);
    }
  }
  switch (known) {
    case 'cmd': {
      for (const [char, why] of CMD_REFUSED) {
        if (value.includes(char)) return refusal(`it holds ${char} — ${why}`);
      }
      if (!CMD_NEEDS_QUOTES.test(value)) return { ok: true, text: value };
      return { ok: true, text: `"${value.replace(/\\+$/u, '$&$&')}"` };
    }
    case 'powershell': {
      if (POWERSHELL_DOUBLE.test(value)) return refusal('it holds a double quote — Windows PowerShell passes one to programs unescaped');
      if (/\s/u.test(value) && value.endsWith('\\')) {
        return refusal('it has a space and ends in \\ — Windows PowerShell quotes it and the \\ escapes the closing quote');
      }
      if (POWERSHELL_BARE.test(value)) return { ok: true, text: value };
      return { ok: true, text: `'${value.replace(POWERSHELL_SINGLE, '$&$&')}'` };
    }
    case 'unknown':
      return UNKNOWN_BARE.test(value)
        ? { ok: true, text: value }
        : refusal('NexTerm does not know how this shell reads quotes — only letters, digits and . _ / : @ + = , - can be typed');
    case 'wsl':
      // WSL starts the distribution's own login shell, which NexTerm cannot
      // see — bash, zsh or fish. In '…' fish reads \\ and \' as escapes
      // and the others do not, so only a value that means the same to all
      // of them goes: no backslash, no single quote.
      if (/['\\]/u.test(value)) {
        return refusal("it holds a \\ or a ' — NexTerm cannot tell which shell WSL starts, and bash and fish read them differently in quotes");
      }
      if (POSIX_BARE.test(value) && !POSIX_BAD_START.test(value)) return { ok: true, text: value };
      return { ok: true, text: `'${value}'` };
    case 'msys':
      // Git Bash rewrites an argument that looks like a POSIX path — `/x`,
      // `--opt=/x` — into a Windows one when it starts a Windows program,
      // quoted or not, so the program would get something else than the
      // preview showed.
      if (/(?:^|=)\//u.test(value)) {
        return refusal('it starts with / (or has =/) — Git Bash turns that into a Windows path when it starts a Windows program');
      }
      return posixQuoted(value);
    case 'fish':
      if (POSIX_BARE.test(value) && !POSIX_BAD_START.test(value)) return { ok: true, text: value };
      if (value.includes("'") && !POSIX_DOUBLE_UNSAFE.test(value)) return { ok: true, text: `"${value}"` };
      return { ok: true, text: `'${value.replace(/[\\']/gu, '\\$&')}'` };
    default:
      return posixQuoted(value);
  }
}

/** `value` for bash, zsh and sh: bare, "…" for a ' with nothing to expand, else '…' with ' as '\\''. */
function posixQuoted(value) {
  if (POSIX_BARE.test(value) && !POSIX_BAD_START.test(value)) return { ok: true, text: value };
  if (value.includes("'") && !POSIX_DOUBLE_UNSAFE.test(value)) return { ok: true, text: `"${value}"` };
  return { ok: true, text: `'${value.replace(/'/gu, "'\\''")}'` };
}

/**
 * The line `command` makes with `values` (by blank name; a blank with no
 * value takes its default) for a terminal running a shell of `kind`.
 *
 * Returns `{ ok, line, parts, errors, lineError }`: `parts` is the line in pieces —
 * `{ text }` from the command, `{ text, blank }` for a value as typed — for a
 * preview that shows what came from where; `errors` maps a blank's name to
 * why its value cannot be typed (a value not among its choices, or one the
 * shell cannot be given); `lineError` says why the whole line cannot be
 * typed (too long), or is null. `ok` only when there is neither; `line` is
 * then what is typed. Values are put in one pass, never searched for blanks again.
 */
export function renderCommand(command, values = {}, kind = 'unknown') {
  const template = command?.template ?? '';
  const byName = new Map((command?.placeholders ?? []).map((p) => [p.name, p]));
  const parts = [];
  const errors = {};
  let at = 0;
  for (const { name, start, end } of blanksIn(template)) {
    if (start > at) parts.push({ text: template.slice(at, start) });
    at = end;
    const placeholder = byName.get(name);
    const given = Object.hasOwn(values, name) ? values[name] : placeholder?.default ?? '';
    if (placeholder?.choices && !placeholder.choices.includes(given)) {
      errors[name] = 'pick one of its choices';
      parts.push({ text: `{{${name}}}`, blank: name });
      continue;
    }
    const quoted = quoteValue(given, kind);
    if (!quoted.ok) {
      errors[name] = quoted.reason;
      parts.push({ text: `{{${name}}}`, blank: name });
      continue;
    }
    parts.push({ text: quoted.text, blank: name });
  }
  if (at < template.length) parts.push({ text: template.slice(at) });
  const line = parts.map((p) => p.text).join('');
  const lineError = length(line) > LIMITS.line ? `the line would be longer than ${LIMITS.line} characters — cmd takes no more at its prompt` : null;
  const ok = Object.keys(errors).length === 0 && lineError === null;
  return { ok, line, parts, errors, lineError };
}

/**
 * What to call the shell of `kind` in "typed for …": the name a person knows
 * it by. `shellPath` names a POSIX shell (zsh, bash).
 */
export function shellLabel(kind, shellPath = '') {
  const base = String(shellPath ?? '')
    .split(/[\\/]/u)
    .pop()
    .replace(/\.exe$/iu, '');
  switch (kind) {
    case 'cmd':
      return 'cmd';
    case 'powershell':
      return /^pwsh/iu.test(base) ? 'PowerShell 7' : 'PowerShell';
    case 'msys':
      return 'Git Bash';
    case 'cygwin':
      return 'Cygwin';
    case 'wsl':
      return 'WSL';
    case 'fish':
      return 'fish';
    case 'posix':
      return displayText(base, 20) || 'shell';
    default:
      return displayText(base, 20) || 'an unknown shell';
  }
}

// ---------------------------------------------------------------------------
// Trust (spec D5)

/** Where the folders whose commands are trusted are kept (localStorage, through persistence.js). */
export const TRUST_KEY = 'nexterm.projectCommandTrust';

/** How many folders are remembered; the oldest is forgotten first. */
export const TRUST_LIMIT = 100;

const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * `raw` from storage as a clean list of `{ root, sha256, at }`, newest
 * first, one per folder, at most TRUST_LIMIT. Anything else in it is
 * dropped: storage is not trusted to hold what was written.
 */
export function normalizeTrust(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = raw
    .filter(
      (e) =>
        isPlainObject(e) &&
        typeof e.root === 'string' &&
        e.root !== '' &&
        e.root.length <= 4096 &&
        typeof e.sha256 === 'string' &&
        SHA256.test(e.sha256) &&
        Number.isFinite(e.at)
    )
    .map(({ root, sha256, at }) => ({ root, sha256, at }))
    .sort((a, b) => b.at - a.at);
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.root) ? false : (seen.add(e.root), true))).slice(0, TRUST_LIMIT);
}

/**
 * Whether the commands with hash `sha256` in folder `root` are trusted:
 * 'trusted', 'changed' (this folder's were trusted, but not these), or
 * 'untrusted'.
 */
export function trustOf(entries, root, sha256) {
  const entry = normalizeTrust(entries).find((e) => e.root === root);
  if (!entry) return 'untrusted';
  return entry.sha256 === sha256 ? 'trusted' : 'changed';
}

/** `entries` with folder `root` trusting `sha256`, newest first. */
export function trusting(entries, root, sha256, at = Date.now()) {
  if (typeof root !== 'string' || root === '' || typeof sha256 !== 'string' || !SHA256.test(sha256)) return normalizeTrust(entries);
  return normalizeTrust([{ root, sha256, at }, ...normalizeTrust(entries).filter((e) => e.root !== root)]);
}

/** `entries` without folder `root`. */
export function forgetting(entries, root) {
  return normalizeTrust(entries).filter((e) => e.root !== root);
}

// ---------------------------------------------------------------------------

/**
 * The file *Open Project Commands File* writes when a folder has none: an
 * example that says how it works by working.
 */
export const EXAMPLE_COMMANDS_FILE = `${JSON.stringify(
  {
    version: FORMAT_VERSION,
    commands: [
      {
        name: 'Run the tests',
        description: 'An example: edit it or replace it. Picked in the command palette, a command is shown in full before it is typed.',
        command: 'npm test',
      },
      {
        name: 'Run one test file',
        description: 'A blank in double braces is asked for, and its value quoted for the shell of the terminal it goes to.',
        command: 'npm test -- {{file}}',
        placeholders: { file: { label: 'Test file', default: 'src/app.test.js' } },
      },
    ],
  },
  null,
  2
)}\n`;
