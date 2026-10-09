/**
 * Which directory a name in a terminal's output is read against.
 *
 * `ls src-tauri` run from the repository root prints `src`, and that is
 * `src-tauri/src` — not the `src` in the root, which the tab's directory
 * would give and which also exists. Under `ls -R`'s `./src:` heading,
 * `index.js` is `src/index.js`. And output printed before a `cd` was printed
 * in the directory before it. Found in review, all three, on real runs.
 *
 * So a row is read in the context it was printed in, nearest first:
 *
 *   1. a listing's header above it, in the same command's output — Windows
 *      `dir`'s ` Directory of C:\x` (` C:\x 디렉터리` in Korean), and the
 *      `path:` line `ls -R` and `ls a b` print before each directory;
 *   2. the one argument of the listing command whose output it is (`ls
 *      src-tauri`, `dir docs`, `eza src`) — when the shell says which
 *      command that was (OSC 133, src/lib/stickyCommand.js) or the row above
 *      is a cmd or PowerShell prompt with the command after it;
 *   3. the tab's directory when the row was printed — the last `pty-cwd`
 *      at or above it (`createCwdTrail`, `trackDirectories`) — not the one it
 *      has now. A shell reports a change only with its next prompt, so a
 *      change is taken to hold from the start of the command that made it:
 *      `cd src && ls` lists src. `ls; cd src` typed as one line is the case
 *      that reads wrong — its listing is read in src.
 *
 * A name is looked for in the first of these and, failing that, in the
 * tab's: a name not in the listed folder cannot be part of its listing. And a
 * block whose command logs in somewhere else (`ssh`, `docker exec`, `wsl` —
 * `parseCommand`) offers nothing at all: what it prints names that machine's
 * files, and the same name here is another file.
 *
 * What stays a guess: cmd reports no command blocks, so its blocks are found
 * by its prompt (`C:\x>command`); a bash or zsh without shell integration
 * gives neither, and there a header's reach is bounded only by
 * MAX_CONTEXT_ROWS and the next header or prompt above. A header is used
 * only where the names under it exist in it.
 *
 * Pure: an xterm buffer is read (`getLine`, `translateToString`, `isWrapped`)
 * and markers are asked where they are (`line`, `isDisposed`); nothing is
 * looked up here, and only `trackDirectories` makes markers, on the
 * terminal it is handed.
 */
import { decodeShellQuoted, resolveOutputPath } from './outputPaths.js';

/** Directories remembered per terminal, the oldest let go first. */
export const MAX_CWD_MARKS = 200;

/** Rows above a name searched for its header or its command's prompt. */
export const MAX_CONTEXT_ROWS = 500;

/** Characters of a header or prompt line read, wrapped rows included. */
const MAX_CONTEXT_LINE = 4096;

const alive = (marker) => Boolean(marker) && !marker.isDisposed && marker.line >= 0;

/**
 * The directories a terminal's shell has been in, each from the row it was
 * reported at: `note(marker, cwd)` when the tab's directory changes, with a
 * marker on the row the cursor was on (xterm moves it as the buffer scrolls
 * and trims); `at(line)` the directory in force at a buffer line — that of
 * the change nearest above it. `initial` is the directory before the first
 * one noted; at most `limit` are kept, the oldest let go.
 *
 * A marker dies two ways, and xterm says neither (it sets `line` to -1
 * before it says it died):
 *
 *   - its line went off the top of a full buffer. Everything still in the
 *     buffer was printed after it, so its directory is the one above the
 *     oldest change still marked;
 *   - its line was erased — a cleared screen (`clear`, Ctrl+L), a line
 *     deleted in a scroll region. Its directory then holds from where the
 *     screen was cleared, not from above everything: found in review,
 *     README.md printed in /workspace, then `cd src` and Ctrl+L, and the old
 *     README.md was read in /workspace/src. It gets a new marker at the top
 *     of the screen it was erased from (stickyCommand.js places an erased
 *     command mark the same way).
 *
 * Which, is told by where the marker last was (`refresh`, after every
 * write xterm parses): below the top of the screen it was on screen, and
 * erased; above it, gone off the top. `view()` is the buffer (`baseY`,
 * `type`), `markAt(line)` makes a marker on a buffer line (null when it
 * cannot); without them every dead marker counts as gone off the top.
 */
export function createCwdTrail({ initial = null, limit = MAX_CWD_MARKS, view = null, markAt = null } = {}) {
  let entries = [];
  let before = initial;
  let closed = false;

  const watch = (entry) => {
    entry.marker?.onDispose?.(() => {
      if (closed || !entries.includes(entry)) return;
      const buffer = view?.();
      const top = buffer?.baseY ?? 0;
      if (!buffer || !markAt || buffer.type === 'alternate' || entry.lastLine < top) {
        entry.offTop = true;
        return;
      }
      // Erased, at or below `top`. Placed a moment later: a marker made while
      // xterm is still erasing rows would be erased in turn. Lines trimmed off
      // the top meanwhile move `top` up by as many, as they move every marker
      // still alive — measured on one of those.
      const reference = entries.find((other) => other !== entry && alive(other.marker));
      const referenceLine = reference ? reference.marker.line : null;
      entry.erasedAt = top;
      queueMicrotask(() => {
        if (closed || !entries.includes(entry)) return;
        const drift = reference && alive(reference.marker) ? referenceLine - reference.marker.line : 0;
        const marker = buffer.type === 'alternate' ? null : markAt(Math.max(0, top - drift));
        entry.erasedAt = undefined;
        if (!alive(marker)) {
          marker?.dispose?.();
          entry.offTop = true;
          return;
        }
        entry.marker = marker;
        entry.lastLine = marker.line;
        watch(entry);
      });
    });
  };

  // Where an entry is now: its marker's line; just erased, the top it was
  // erased from; gone off the top — or dead without saying how — above
  // every line (-1).
  const where = (entry) => {
    if (alive(entry.marker)) return entry.marker.line;
    if (entry.erasedAt !== undefined) return entry.erasedAt;
    return -1;
  };

  return {
    note(marker, cwd) {
      if (typeof cwd !== 'string' || !cwd || !alive(marker)) {
        marker?.dispose?.();
        return;
      }
      const last = entries[entries.length - 1];
      if ((last ? last.cwd : before) === cwd) {
        marker.dispose?.();
        return;
      }
      const entry = { marker, cwd, lastLine: marker.line, offTop: false, erasedAt: undefined };
      entries.push(entry);
      watch(entry);
      while (entries.length > limit) {
        const oldest = entries.shift();
        before = oldest.cwd;
        oldest.marker?.dispose?.();
      }
    },
    /** Where every marker is now: run after each write xterm has parsed. */
    refresh() {
      for (const entry of entries) if (alive(entry.marker)) entry.lastLine = entry.marker.line;
    },
    at(line) {
      // The change nearest above `line`; of two on one line, the later.
      let cwd = before;
      let best = -Infinity;
      for (const entry of entries) {
        const position = where(entry);
        if (position > line) continue;
        if (position >= best) {
          best = position;
          cwd = entry.cwd;
        }
      }
      return cwd;
    },
    /**
     * Everything marked is gone: a terminal reset (RIS) keeps xterm's markers
     * alive with the line numbers they had, which now name rows of a buffer
     * that has been emptied. From here every row was printed in `cwd`.
     */
    restart(cwd) {
      const old = entries;
      entries = [];
      for (const entry of old) entry.marker?.dispose?.();
      if (typeof cwd === 'string' && cwd) before = cwd;
    },
    /** Where the newest change is now (-1 above every line), or null when none is kept. */
    get newest() {
      return entries.length ? where(entries[entries.length - 1]) : null;
    },
    get size() {
      return entries.length;
    },
    dispose() {
      closed = true;
      for (const entry of entries) entry.marker?.dispose?.();
      entries = [];
    },
  };
}

/**
 * A `createCwdTrail` kept for one xterm terminal (`term`): `note(cwd)` when
 * the tab's directory changes, and `at(line)` as the trail answers it.
 * `initial` is the directory the terminal started in, `current()` the tab's
 * directory now, `marks()` the shell's command marks (stickyCommand.js:
 * `{ marker, command }`, the marker on the first row of a command's output).
 *
 * Where a change is marked: the shell reports its directory (OSC 7) when it
 * draws the NEXT prompt, after the output of the command that changed it —
 * so `cd /x && clear && ls` was read in the old directory, and a name in
 * /x that was not also in the old one got no link (found in the live app,
 * 2026-10-10). When a command started after the last change marked, the
 * change is marked where that command's output starts, the command that
 * ended with this prompt: `cd x && ls`, `cd .. && ls -l`, `pushd x; ls` all
 * list x, and a `cd` on its own line still leaves the listings before it
 * where they were. The one case this reads wrong is `ls; cd x` as one line,
 * its listing read in x — accepted: the other order is the common one. With
 * no command marks (cmd reports none; its `dir` heading and prompt line say
 * where instead), the change is marked on the row the cursor is on once the
 * output written before it has been parsed.
 *
 * Where each mark is, is read after every write xterm parses (`refresh`), and
 * an erased one is placed again on the buffer (`markAt`). A reset (`ESC c`:
 * `reset`, `tput reset`, `printf '\ec'`) empties the buffer and leaves
 * xterm's markers alive at the line numbers they had — output printed at the
 * top afterwards was read in the directory of a mark below it (review,
 * 2026-10-10) — so it is caught on its way to xterm, which still handles it,
 * and the trail starts again from the directory the tab is in.
 */
export function trackDirectories(term, { initial = null, current = () => null, marks = () => [] } = {}) {
  let disposed = false;
  // Command marks made before a reset: xterm keeps them, at lines that no
  // longer mean anything.
  let stale = new WeakSet();
  const trail = createCwdTrail({
    initial,
    view: () => term.buffer.active,
    // A marker on buffer line `line`: xterm places one relative to the cursor.
    markAt: (line) => {
      const buffer = term.buffer.active;
      if (buffer.type !== 'normal') return null;
      return term.registerMarker?.(line - (buffer.baseY + buffer.cursorY)) ?? null;
    },
  });
  const parsed = term.onWriteParsed?.(() => trail.refresh());
  // `false`: not handled here — xterm resets the terminal as it always does.
  const reset = term.parser?.registerEscHandler?.({ final: 'c' }, () => {
    if (disposed) return false;
    trail.restart(current());
    stale = new WeakSet((Array.isArray(marks()) ? marks() : []).map((mark) => mark?.marker).filter(Boolean));
    return false;
  });
  // The marker a change reported now is placed on: where the command that
  // ended with this prompt began, if it began after the last change marked;
  // else the row the cursor is on.
  const markForChange = () => {
    const buffer = term.buffer.active;
    const fresh = (Array.isArray(marks()) ? marks() : []).filter((mark) => mark?.marker && !stale.has(mark.marker));
    const block = blockAt(fresh, buffer.baseY + buffer.cursorY);
    const since = trail.newest;
    if (block && (since === null || block.line > since)) {
      const marker = term.registerMarker?.(block.line - (buffer.baseY + buffer.cursorY));
      if (marker) return marker;
    }
    return term.registerMarker?.(0);
  };
  return {
    note(cwd) {
      term.write('', () => {
        if (disposed || term.buffer.active.type === 'alternate') return;
        trail.note(markForChange(), cwd);
      });
    },
    at: (line) => trail.at(line),
    dispose() {
      disposed = true;
      parsed?.dispose?.();
      reset?.dispose?.();
      trail.dispose();
    },
  };
}

/**
 * The command block a buffer line is in: the newest of `marks` (oldest
 * first, `{ marker, command }` as src/lib/stickyCommand.js keeps them — the
 * marker on the first row of the command's output) at or above it, as
 * `{ line, command }`, or null.
 */
export function blockAt(marks, line) {
  let found = null;
  for (const mark of Array.isArray(marks) ? marks : []) {
    if (!alive(mark?.marker)) continue;
    if (mark.marker.line > line) break;
    found = { line: mark.marker.line, command: typeof mark.command === 'string' ? mark.command : '' };
  }
  return found;
}

/** Programs that list one directory's names: their one argument is where those names are. */
const LISTERS = new Set(['ls', 'll', 'la', 'l', 'dir', 'vdir', 'gci', 'get-childitem', 'eza', 'exa', 'lsd', 'tree']);

/**
 * Programs that run in another machine, a container or WSL: what their
 * output names is there. With the subcommand that does it, where there is
 * one.
 */
const REMOTE = new Map([
  ['ssh', null],
  ['slogin', null],
  ['mosh', null],
  ['et', null],
  ['rsh', null],
  ['telnet', null],
  ['wsl', null],
  ['vagrant', new Set(['ssh'])],
  ['docker', new Set(['exec', 'run', 'attach', 'compose', 'container'])],
  ['podman', new Set(['exec', 'run', 'attach', 'compose', 'container'])],
  ['nerdctl', new Set(['exec', 'run', 'attach', 'compose', 'container'])],
  ['kubectl', new Set(['exec', 'attach', 'debug', 'run'])],
  ['oc', new Set(['exec', 'attach', 'debug', 'rsh'])],
  ['multipass', new Set(['shell', 'exec'])],
  ['lxc', new Set(['exec', 'shell'])],
  ['gcloud', new Set(['compute', 'cloud-shell'])],
  ['az', new Set(['ssh'])],
]);

/** What runs another command, and so is skipped to find it: `sudo ls`, `env A=1 ls`. */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nocorrect', 'noglob', 'time', 'env', 'nice', 'nohup', 'caffeinate']);

/** Options of a lister that take the next word as their value. */
const VALUE_OPTIONS = {
  ls: new Set(['-I', '-w', '-T', '--ignore', '--hide', '--width', '--tabsize']),
  tree: new Set(['-L', '-I', '-P', '-o', '-H', '--filelimit', '--charset']),
  gci: new Set(['-filter', '-include', '-exclude', '-depth', '-attributes']),
  'get-childitem': new Set(['-filter', '-include', '-exclude', '-depth', '-attributes']),
  eza: new Set(['-L', '--level', '-I', '--ignore-glob', '--sort', '-s', '--color', '--colour', '--time-style']),
  exa: new Set(['-L', '--level', '-I', '--ignore-glob', '--sort', '-s', '--color', '--colour', '--time-style']),
  lsd: new Set(['--depth', '-I', '--ignore-glob', '--color', '--icon', '--date', '--blocks', '--sizesort']),
};

/** PowerShell's way of naming the directory to list. */
const PATH_OPTIONS = new Set(['-path', '-literalpath', '-lp']);

/** A shell word list, quotes and backslashes read as a POSIX shell reads them, and the operators that end a command. */
function shellWords(command) {
  const words = [];
  let word = null;
  let i = 0;
  const push = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  while (i < command.length) {
    const ch = command[i];
    if (/\s/.test(ch)) {
      push();
      i += 1;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      word = (word ?? '') + command.slice(i + 1, end < 0 ? command.length : end);
      i = end < 0 ? command.length : end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let piece = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && '"\\$`'.includes(command[j + 1] ?? '')) j += 1;
        piece += command[j] ?? '';
        j += 1;
      }
      word = (word ?? '') + piece;
      i = j + 1;
    } else if (ch === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[i + 1];
      i += 2;
    } else if ('|;&<>()'.includes(ch)) {
      push();
      let op = ch;
      while (i + op.length < command.length && '|&<>'.includes(command[i + op.length]) && op.length < 2) op += command[i + op.length];
      words.push({ op });
      i += op.length;
    } else {
      word = (word ?? '') + ch;
      i += 1;
    }
  }
  push();
  return words;
}

/** A program's name as typed: without its folder, a leading `\` (an alias bypass) or `.exe`, lower case. */
function programName(word) {
  return word.replace(/^\\/, '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
}

/**
 * What a command line says about the output under it:
 *   - `remote` — some command in it runs on another machine, in a container
 *     or in WSL (`REMOTE`): nothing it prints is a name here;
 *   - `listing` — it is ONE lister and nothing else (no pipe, no `;`, no
 *     redirection), and `args` are its operands: the paths it was asked to
 *     list, options and their values left out.
 * Null for no command.
 */
export function parseCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const words = shellWords(command.trim());
  const pipelines = [[]];
  for (const word of words) {
    if (typeof word === 'object') pipelines.push([]);
    else pipelines[pipelines.length - 1].push(word);
  }
  const compound = pipelines.length > 1;

  // Each command in the line, its wrappers and assignments skipped.
  const commands = pipelines
    .map((ws) => {
      let k = 0;
      while (k < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k]) || WRAPPERS.has(programName(ws[k])))) k += 1;
      return k < ws.length ? { program: programName(ws[k]), rest: ws.slice(k + 1) } : null;
    })
    .filter(Boolean);

  const remote = commands.some(({ program, rest }) => {
    if (!REMOTE.has(program)) return /^wsl\d*$/.test(program);
    const subcommands = REMOTE.get(program);
    return !subcommands || rest.some((w) => subcommands.has(w.toLowerCase()));
  });

  const first = commands[0];
  if (compound || !first || !LISTERS.has(first.program)) return { remote, listing: false, args: [] };

  const valued = VALUE_OPTIONS[first.program] ?? new Set();
  const args = [];
  for (let k = 0; k < first.rest.length; k += 1) {
    const word = first.rest[k];
    const lower = word.toLowerCase();
    if (PATH_OPTIONS.has(lower) && (first.program === 'gci' || first.program === 'get-childitem')) {
      if (k + 1 < first.rest.length) args.push(first.rest[(k += 1)]);
      continue;
    }
    if (valued.has(word) || valued.has(lower)) {
      k += 1;
      continue;
    }
    if (word.startsWith('-') && word !== '-') continue;
    // cmd's `dir /s /b /a:d /o:-d`: a switch, not a path.
    if (first.program === 'dir' && /^\/[A-Za-z?](?::?[-A-Za-z]*)?$/.test(word)) continue;
    args.push(word);
  }
  return { remote, listing: true, args };
}

/** A glob: the listing names what matched it, not what is in it. */
export const isGlob = (word) => /[*?[\]]/.test(word);

/** `dir`'s heading, in English or Korean: a header whatever printed it. */
const SPELLED_OUT_HEADER = /^\s*Directory of \S|^\s*(?:[A-Za-z]:[\\/]|\\\\).*?\s+디렉터리\s*$/;

/**
 * The header a line is, as the directory it names — or null.
 *
 *   - ` Directory of C:\x` (Windows `dir`) and ` C:\x 디렉터리` (in Korean);
 *   - `path:` alone on its line, as `ls -R` and `ls a b` print each
 *     directory before its names — GNU quotes one with a space in it
 *     (`'./My Folder':`), read as `decodeShellQuoted` reads a name.
 */
export function headerOf(line) {
  if (typeof line !== 'string') return null;
  const text = line.replace(/\s+$/, '');
  let match = /^\s*Directory of (.+)$/.exec(text);
  if (match) return match[1].trim();
  match = /^\s*((?:[A-Za-z]:[\\/]|\\\\).*?)\s+디렉터리$/.exec(text);
  if (match) return match[1].trim();
  match = /^(\S+):$/.exec(text);
  if (match) {
    const spelled = match[1];
    if (/^['"$]/.test(spelled)) return decodeShellQuoted(spelled);
    // A URL scheme or a drive is no directory header.
    if (/^[A-Za-z]+$/.test(spelled) && spelled.length === 1) return null;
    return spelled;
  }
  match = /^((?:'[^']*'|"[^"]*"|\$'[^']*')+):$/.exec(text);
  if (match) return decodeShellQuoted(match[1]);
  return null;
}

/**
 * The prompt a line is, with the command typed after it — cmd's
 * `C:\Users\me>dir src`, PowerShell's `PS C:\x> gci` — or null. The only
 * command blocks cmd has: it reports none (no OSC 133).
 */
export function promptOf(line) {
  if (typeof line !== 'string') return null;
  let match = /^([A-Za-z]:\\[^<>|"?*\r\n]*)>(.*)$/.exec(line);
  if (match) return { cwd: match[1], command: match[2].trim() };
  match = /^PS ((?:[A-Za-z]:[\\/]|\/)[^>]*)> ?(.*)$/.exec(line);
  if (match) return { cwd: match[1], command: match[2].trim() };
  return null;
}

/** The logical line starting at buffer line `y` — that row and those wrapped onto it — trimmed at the end. */
function logicalLine(buffer, y) {
  let text = buffer.getLine(y)?.translateToString(true) ?? '';
  for (let next = y + 1; text.length < MAX_CONTEXT_LINE; next += 1) {
    const line = next < buffer.length ? buffer.getLine(next) : undefined;
    if (!line?.isWrapped) break;
    text += line.translateToString(true);
  }
  return text;
}

/**
 * Where the names on buffer line `line` were printed, as
 * `{ cwd, header, command, commandCwd, remote, isHeader }`:
 *
 *   - `cwd` — the tab's directory then (`cwdAt(line)`), or the directory in
 *     the cmd prompt the command was typed at;
 *   - `header` — `{ dir, cwd }`: the nearest listing header above, in the
 *     same command's output (`headerOf`), and the directory a relative one
 *     is read against;
 *   - `command` — `parseCommand` of the command whose output this is, and
 *     `commandCwd` where it ran;
 *   - `remote` — that command runs elsewhere: offer nothing;
 *   - `isHeader` — this line is a header itself: its own path is read
 *     against `cwd`, never against a header above it.
 *
 * `marks` are the terminal's command marks (`blockAt`). Searched upward from
 * the line before, never past the start of its command's output, a prompt,
 * or MAX_CONTEXT_ROWS.
 */
export function contextAt({ buffer, line, cwdAt = () => null, marks = [], maxRows = MAX_CONTEXT_ROWS }) {
  const block = blockAt(marks, line);
  // A wrapped row is read with the row its line starts on.
  let start = line;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
  const isHeader = headerOf(logicalLine(buffer, start)) !== null;

  let header = null;
  let prompt = null;
  const stop = Math.max(block ? block.line : 0, start - maxRows);
  for (let y = start - 1; y >= stop; y -= 1) {
    if (buffer.getLine(y)?.isWrapped) continue;
    const text = logicalLine(buffer, y);
    const dir = headerOf(text);
    if (dir) {
      header = { dir, line: y, spelledOut: SPELLED_OUT_HEADER.test(text) };
      break;
    }
    const typed = promptOf(text);
    if (typed && (!block || y > block.line)) {
      prompt = { ...typed, line: y };
      break;
    }
  }

  const commandText = block && (!prompt || prompt.line < block.line) ? block.command : prompt?.command ?? null;
  const command = parseCommand(commandText);
  const cwd = prompt?.cwd ?? cwdAt(line);
  const commandCwd = prompt?.cwd ?? (block ? cwdAt(block.line) : cwd);
  // A bare `word:` line heads a listing only in a listing's output. Anywhere
  // else it is a log line, a YAML key or a Makefile target, and taking it for
  // a header pointed every name below it into a subfolder of the same name:
  // under `src:` in a build log, `index.js` revealed `src/index.js` when the
  // sentence meant the one beside it (review, 2026-10-10). `dir`'s own
  // heading says what it is, so it counts wherever it appears.
  const trusted = header && (header.spelledOut || command?.listing === true);
  return {
    cwd,
    header: trusted ? { dir: header.dir, cwd: prompt?.cwd ?? cwdAt(header.line) } : null,
    command,
    commandCwd,
    remote: Boolean(command?.remote),
    isHeader,
  };
}

/**
 * Where each of a row's candidates (`pathsAtRow`) may be, by `context`
 * (`contextAt`) and `place` (`{ os, home, msys }`, as `resolveOutputPath`
 * takes them): `paths` to ask the backend about, and `choose(kinds)` giving
 * the candidates with their `paths` in order of preference, for
 * `chooseLinks`.
 *
 * A name is looked for under the header above it, else in the one folder
 * its command listed, and then in the directory it was printed in. When
 * that one argument is a file or a glob, the listing names files that are
 * not in any one folder, and only a name with a separator in it — a path —
 * is offered. Nothing at all in a block that runs elsewhere (`remote`), and
 * a header line's own path is read against the directory it was printed in.
 */
export function planNames(candidates, context, place = {}) {
  if (!context || context.remote || !Array.isArray(candidates) || candidates.length === 0) {
    return { paths: [], choose: () => [] };
  }
  const at = (name, cwd) => resolveOutputPath(name, { ...place, cwd });
  let headerDir = null;
  let argDir = null;
  let argGlob = false;
  if (!context.isHeader) {
    if (context.header) {
      headerDir = at(context.header.dir, context.header.cwd);
    } else if (context.command?.listing && context.command.args.length === 1) {
      const [arg] = context.command.args;
      if (isGlob(arg)) argGlob = true;
      else argDir = at(arg, context.commandCwd);
    }
  }
  const rows = candidates.map((candidate) => ({
    candidate,
    viaHeader: headerDir ? at(candidate.text, headerDir) : null,
    viaArg: argDir ? at(candidate.text, argDir) : null,
    own: at(candidate.text, context.cwd),
  }));
  const paths = [...new Set([argDir, ...rows.flatMap((r) => [r.viaHeader, r.viaArg, r.own])].filter(Boolean))];
  const qualified = (name) => /[\\/]/.test(name) || name.startsWith('~');
  return {
    paths,
    choose(kinds) {
      const argKind = argDir ? kinds.get(argDir) : null;
      const onlyPaths = argGlob || argKind === 'file';
      return rows
        .filter((r) => !onlyPaths || qualified(r.candidate.text))
        .map((r) => ({ ...r.candidate, paths: [r.viaHeader, argKind === 'dir' ? r.viaArg : null, r.own].filter(Boolean) }))
        .filter((c) => c.paths.length > 0);
    },
  };
}

export default { createCwdTrail, trackDirectories, blockAt, parseCommand, isGlob, headerOf, promptOf, contextAt, planNames, MAX_CWD_MARKS, MAX_CONTEXT_ROWS };
