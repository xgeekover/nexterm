/**
 * Files dropped onto a terminal, written so that terminal's shell reads them
 * back as the same files.
 *
 * The reference is Windows Terminal: the dropped paths go in as ONE paste,
 * joined by single spaces, each quoted only when it has to be, and with no
 * trailing space — what comes after the paths is the user's to type. Being a
 * paste matters too: xterm brackets it when the program asked for that, so
 * an agent's input box takes the whole thing as text instead of a run of keys.
 *
 * The quoting is the tab's own shell's. Double quotes, right for cmd, are
 * wrong for the rest — a POSIX shell expands `$`, backquotes and `!` inside
 * them, PowerShell expands `$` and treats the backtick as an escape — and a
 * WSL shell cannot open `C:\Users\me` at all. So the shell decides
 * (`shellKindFor`), the path is first rewritten into the form that shell's
 * file system speaks (`translatePath`), and only then quoted by that shell's
 * own rules (`quotePath`). A shell this module does not know gets no quoting
 * at all: a path goes in only when it needs none in any shell, and is left
 * out otherwise — quoting by the rules of the wrong shell is how a file name
 * holding a backquote runs as a command (cmd's double quotes, handed to a
 * WSL distro's own launcher, still run `` `touch x` ``).
 *
 * What cannot be written safely is left out and reported, never mangled: a
 * newline in a name would run whatever follows it in a shell that did not
 * ask for bracketed paste, and cmd has no way at all to quote a `"`.
 *
 * Known limitations, both out of this module's reach:
 *
 *   - A path into a WSL distro (`\\wsl$\<distro>\…`) is translated as if it
 *     were into the tab's own distro. Which distro a tab runs is not known
 *     to the frontend; a path into ANOTHER distro comes out naming a file of
 *     this one.
 *   - PowerShell's own cmdlets read `[` and `]` in a path as a wildcard
 *     (`Get-Item 'a[1].txt'` finds nothing; `-LiteralPath` would). A native
 *     program — OpenCode, node, git — receives exactly the path.
 *
 * Pure: no store, no DOM. tests/adversarial/drop_paths.test.js.
 */
import { basename } from './paths.js';

/**
 * Every kind of shell NexTerm writes paths for, sorted by how a path has to
 * be written for it:
 *
 *   cmd         Windows paths, double quotes
 *   powershell  Windows paths, single quotes — double ones for a name with an
 *               apostrophe (Windows PowerShell and pwsh, on any platform)
 *   posix       POSIX paths, single quotes — double ones for a name with an
 *               apostrophe (bash, zsh, sh … off Windows)
 *   fish        POSIX paths, fish's quotes, as posix
 *   msys        Git Bash and MSYS2: `C:\a` is `C:/a`, posix quoting
 *   cygwin      Cygwin: `C:\a` is `C:/a`, posix quoting
 *   wsl         a Linux distro under WSL: `C:\a` is `/mnt/c/a`, posix quoting
 *   unknown     a shell not listed here: a path only when it needs no quoting
 */
export const SHELL_KINDS = Object.freeze(['cmd', 'powershell', 'posix', 'fish', 'msys', 'cygwin', 'wsl', 'unknown']);

/** The kinds whose shell runs on Windows and is handed Windows paths. */
const WINDOWS_KINDS = new Set(['cmd', 'powershell', 'msys', 'cygwin', 'wsl']);

/** Windows PowerShell, PowerShell 7, and 7's preview build. */
const POWERSHELL_NAMES = new Set(['powershell', 'pwsh', 'pwsh-preview']);

/**
 * POSIX shells, by name. On Windows each of them is an MSYS2 or Cygwin build.
 * Every one of them reads `'…'` the POSIX way, so leaving one out would only
 * cost its users every path with a space or an apostrophe.
 */
const POSIX_SHELL_NAMES = new Set([
  'bash', 'rbash', 'sh', 'zsh', 'dash', 'ash', 'ksh', 'ksh93', 'mksh', 'oksh', 'loksh', 'yash', 'posh',
]);

/**
 * Names that mean nothing off Windows — the backend's spec ids and Windows'
 * own shells — and were always taken there for the platform's POSIX shell.
 */
const WINDOWS_ONLY_NAMES = new Set(['cmd', 'wsl', 'git-bash']);

/**
 * The launchers the Microsoft Store's WSL distros install (`ubuntu.exe`,
 * `ubuntu2204.exe`, `debian.exe`, `kali.exe`, `opensuse-leap-15.5.exe` …):
 * each starts its distro's login shell, so its paths are WSL's.
 */
const WSL_LAUNCHER =
  /^(?:ubuntu(?:\d[\d.]*)?|debian|kali|opensuse-.+|sles-.+|oraclelinux.*|almalinux.*|fedoraremix|archlinux|alpine|pengwin)$/u;

/**
 * The bash.exe Windows itself ships, in System32 (or Sysnative, which is how
 * a 32-bit process sees System32): not a Unix build at all but the legacy
 * launcher of the default WSL distro, so its paths are WSL's.
 */
const LEGACY_WSL_BASH = /(?:^|[\\/])windows[\\/](?:system32|sysnative)[\\/]bash(?:\.exe)?$/iu;

/**
 * C0 controls, DEL and C1 controls. A path holding one is never inserted: a
 * newline (or a CR, which a terminal sends for Enter) would run whatever
 * follows it the moment it reached a shell that had not asked for bracketed
 * paste, and the rest are invisible on screen.
 */
const CONTROL = /[\u{0}-\u{1F}\u{7F}-\u{9F}]/u;

/**
 * Characters that draw nothing — the Hangul fillers (U+3164, U+115F, U+1160,
 * U+FFA0), zero-width spaces and joiners, the bidi controls, the byte order
 * mark. Left bare, a name holding one shows a word boundary where there is
 * none, or hides one where there is; every shell that can quote gets such a
 * path quoted, so where the path begins and ends stays visible.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * What makes cmd read a path as more than one word, or as an operator: the
 * characters `cmd /?` lists as needing quotes, whitespace, the redirections
 * and pipe — and `%`, because cmd expands `%VAR%` in what is typed at its
 * prompt. Quotes do not stop that expansion, but they keep what it expands to
 * one word: `C:\x\%ProgramFiles%.txt` bare is two arguments.
 */
const CMD_NEEDS_QUOTES = /[\s&()[\]{}^=;!'+,`~<>|%]/u;

/**
 * A word PowerShell passes on as it is in argument mode: letters, digits,
 * marks, and the punctuation a Windows path is made of. Anything else — a
 * space, `$`, a backtick, `@`, `#`, `{`, a comma (an array!) — is quoted.
 * The same class is all a shell this module does not know is trusted with.
 */
const WINDOWS_BARE = /^[\p{L}\p{N}\p{M}_.:\\/-]+$/u;

/**
 * A leading dash makes PowerShell read the word as a parameter name, and its
 * tokenizer takes the en dash, em dash and horizontal bar as dashes too.
 */
const POWERSHELL_DASH_START = /^[-\u{2013}\u{2014}\u{2015}]/u;

/**
 * PowerShell ends a single-quoted string at any of five characters — the
 * ASCII apostrophe and the four typographic single quotes — and each is
 * escaped by doubling it. A name typed on a Mac or copied from a document
 * holds the curly ones as often as the straight one.
 */
const POWERSHELL_SINGLE_QUOTES = /['\u{2018}\u{2019}\u{201A}\u{201B}]/gu;
const HAS_POWERSHELL_SINGLE_QUOTE = /['\u{2018}\u{2019}\u{201A}\u{201B}]/u;

/**
 * What PowerShell reads inside double quotes: `$` expands, the backtick
 * escapes, and four characters end the string. A name with none of these is
 * the same inside double quotes as it is.
 */
const POWERSHELL_DOUBLE_UNSAFE = /[$`"\u{201C}\u{201D}\u{201E}]/u;

/**
 * A word every POSIX shell — and fish — leaves alone: no globbing, no
 * expansion, no word splitting, no history. Letters of any script stay bare,
 * so a Korean or accented name is not wrapped in quotes for nothing.
 */
const POSIX_BARE = /^[\p{L}\p{N}\p{M}_./+,:@%=-]+$/u;

/**
 * …except at the start of a word, where `-` reads as an option, `~` as a home
 * directory and `=` as zsh's command lookup (`=ls` is `/bin/ls`).
 */
const POSIX_BAD_START = /^[-=~]/u;

/**
 * What a POSIX shell, or fish, reads inside double quotes: `$` and the
 * backquote expand, the backslash escapes, `"` ends the string, and `!` is
 * history expansion in an interactive bash or zsh. A name with none of these
 * is the same inside double quotes as it is.
 */
const POSIX_DOUBLE_UNSAFE = /[$`"\\!]/u;

/**
 * Which kind of shell `shellPath` is, for writing paths to it.
 *
 * `shellPath` is a tab's resolved shell (`C:\Windows\System32\cmd.exe`,
 * `/bin/zsh`), a spec id from the backend's shell list (`cmd`, `pwsh`,
 * `git-bash`, `wsl`, `login-shell`), or nothing / `default`, which is what the
 * backend falls back to: cmd on Windows, a POSIX login shell elsewhere. Only
 * the name counts — case-insensitively and without `.exe` — except for bash
 * on Windows, where the directory tells Git Bash and Cygwin from the WSL
 * launcher. A bare `bash` with no directory is the WSL launcher too: the
 * backend hands the name on unresolved and portable-pty walks PATH, where a
 * stock Windows lists System32 (the WSL launcher's folder) early and Git for
 * Windows adds only its `cmd` folder. Without WSL installed a bare `bash` that
 * is MSYS2's is misread as WSL; the git-bash spec id, recorded as a full
 * path, is not affected.
 *
 * A name nobody knows is `unknown` — never a guess. tcsh and csh are among
 * them on purpose: they expand `!` even inside single quotes.
 *
 * @param {string|null|undefined} shellPath
 * @param {'windows'|'macos'|'linux'} platform
 * @returns {'cmd'|'powershell'|'posix'|'fish'|'msys'|'cygwin'|'wsl'|'unknown'}
 */
export function shellKindFor(shellPath, platform) {
  const onWindows = platform === 'windows';
  const fallback = onWindows ? 'cmd' : 'posix';
  // A spec typed by hand may carry the quotes a path with spaces needs.
  const spec = typeof shellPath === 'string' ? shellPath.trim().replace(/^"(.*)"$/s, '$1').trim() : '';
  if (!spec) return fallback;

  const name = basename(spec).toLowerCase().replace(/\.exe$/, '');
  if (!name || name === 'default' || name === 'login-shell') return fallback;
  if (POWERSHELL_NAMES.has(name)) return 'powershell';

  if (!onWindows) {
    if (name === 'fish') return 'fish';
    if (POSIX_SHELL_NAMES.has(name) || WINDOWS_ONLY_NAMES.has(name)) return 'posix';
    return 'unknown';
  }

  if (name === 'cmd') return 'cmd';
  if (name === 'wsl' || WSL_LAUNCHER.test(name)) return 'wsl';
  if (name === 'git-bash') return 'msys';
  if (name === 'bash' && (LEGACY_WSL_BASH.test(spec) || !/[\\/]/.test(spec))) return 'wsl';
  if (POSIX_SHELL_NAMES.has(name) || name === 'fish') {
    const cygwin = spec.split(/[\\/]/).some((segment) => segment.toLowerCase().includes('cygwin'));
    return cygwin ? 'cygwin' : 'msys';
  }
  return 'unknown';
}

/**
 * `path` without Windows' verbatim prefix, which the shells cannot read:
 * `\\?\C:\x` is `C:\x` and `\\?\UNC\server\share\x` is `\\server\share\x`.
 * terminalCompat.js's `withoutVerbatimPrefix` is the same rule; this one
 * also takes `unc` in lower case, as Windows does. A verbatim path to
 * anything else (`\\?\Volume{…}\`) keeps its prefix — without it, it is not
 * the same path.
 */
function withoutLongPathPrefix(path) {
  if (/^\\\\\?\\unc\\/iu.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:/u.test(path)) return path.slice(4);
  return path;
}

/** `C:` followed by nothing or by a separator — an absolute drive path. */
const DRIVE_PATH = /^([A-Za-z]):((?:[\\/].*)?)$/su;
/** Two separators up front: `\\server\share`, or the same with slashes. */
const UNC_PATH = /^[\\/]{2}/u;
/** A path into a WSL distro, as Windows names it, and the part inside it. */
const WSL_SHARE = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/isu;

const forwardSlashes = (s) => s.replace(/\\/g, '/');

/**
 * `path` as the shell of `kind` has to see it.
 *
 * cmd and PowerShell take Windows paths, and get backslashes (`C:/a` names
 * the same file, but cmd's own commands read a `/` as a switch).
 *
 * Git Bash, MSYS2 and Cygwin get the mixed form, `C:/a/b`: their shells and
 * tools open it as they open `/c/a/b` or `/cygdrive/c/a/b`, and so does a
 * native Windows program run there — OpenCode or node in a Git Bash tab is
 * who most often takes the paste, and for it `/c/a/b` is no path at all. A
 * share is `//server/share` to them.
 *
 * WSL mounts the drives at `/mnt/c`, and a path into a WSL distro
 * (`\\wsl$\Ubuntu\home\me`) is that distro's own `/home/me` — see the header
 * for the distro that is not this tab's. WSL cannot address any other share,
 * so one is left as Windows wrote it, and quoting keeps its backslashes.
 *
 * A shell this module does not know only loses the verbatim prefix. A POSIX
 * path, or a POSIX shell, gets the path unchanged.
 *
 * @param {string} path
 * @param {string} kind  one of SHELL_KINDS
 * @returns {string}
 */
export function translatePath(path, kind) {
  if (typeof path !== 'string') return '';
  if (kind === 'unknown') return withoutLongPathPrefix(path);
  if (!WINDOWS_KINDS.has(kind)) return path;

  const p = withoutLongPathPrefix(path);
  const drive = DRIVE_PATH.exec(p);
  const unc = !drive && UNC_PATH.test(p);

  switch (kind) {
    case 'cmd':
    case 'powershell':
      return drive || unc ? p.replace(/\//g, '\\') : p;
    case 'msys':
    case 'cygwin':
      // `C:` alone means "the current directory of drive C", which no
      // translation keeps; it is left as it came.
      if (drive) return drive[2] ? `${drive[1]}:${forwardSlashes(drive[2])}` : p;
      return unc ? forwardSlashes(p) : p;
    case 'wsl': {
      if (drive) return `/mnt/${drive[1].toLowerCase()}${forwardSlashes(drive[2])}`;
      if (!unc) return p;
      const share = WSL_SHARE.exec(forwardSlashes(p));
      if (!share) return p;
      return share[1] || '/';
    }
    default:
      return p;
  }
}

/**
 * `path` as one word of the shell of `kind`: bare when nothing in it means
 * anything to that shell, quoted when something does. Never a trailing
 * space. null when the path cannot be written safely at all — a control
 * character anywhere, a `"` for cmd, which has no escape for one inside
 * quotes (no Windows file name holds one anyway), or anything that would
 * need quoting for a shell of unknown syntax.
 *
 *   cmd         "…" around the whole path; a trailing backslash doubled
 *   powershell  '…', every single-quote character doubled — or "…" when the
 *               path has a single quote and nothing "…" would expand
 *   posix       '…', every ' written '\'' (close, escaped quote, reopen) — or
 *               "…" when the path has a ' and nothing "…" would expand; also
 *               msys, cygwin and wsl, once translated
 *   fish        as posix, but in '…' fish reads \\ and \', so \ and ' are
 *               escaped there
 *   unknown     bare or nothing
 *
 * The double-quoted forms are for OpenCode, which takes a dropped image by
 * its path: it strips quotes from the ends of what was pasted, and a path
 * holding `'\''` or a doubled `''` is then no file it can find.
 *
 * @param {string} path
 * @param {string} kind  one of SHELL_KINDS
 * @returns {string|null}
 */
export function quotePath(path, kind) {
  if (typeof path !== 'string' || path === '' || CONTROL.test(path)) return null;
  const ignorable = IGNORABLE.test(path);
  switch (kind) {
    case 'cmd':
      if (path.includes('"')) return null;
      if (!ignorable && !CMD_NEEDS_QUOTES.test(path)) return path;
      // Programs split their command line by CommandLineToArgvW's rules,
      // where `\"` is a literal quote: a backslash just before the closing
      // quote has to be doubled, or the quote is eaten and the next word
      // joins this one.
      return `"${path.replace(/\\+$/u, '$&$&')}"`;
    case 'powershell':
      if (!ignorable && WINDOWS_BARE.test(path) && !POWERSHELL_DASH_START.test(path)) return path;
      if (HAS_POWERSHELL_SINGLE_QUOTE.test(path) && !POWERSHELL_DOUBLE_UNSAFE.test(path)) return `"${path}"`;
      return `'${path.replace(POWERSHELL_SINGLE_QUOTES, '$&$&')}'`;
    case 'unknown':
      // A backslash is a separator only in a Windows path. In any other path
      // it is part of a name, and the POSIX-like shells this kind covers
      // (tcsh, ash, busybox) read it as an escape: `/x/a\b` bare opened `/x/ab`.
      if (path.includes('\\') && !DRIVE_PATH.test(path) && !path.startsWith('\\\\')) return null;
      return !ignorable && WINDOWS_BARE.test(path) && !path.startsWith('-') ? path : null;
    case 'fish':
      if (!ignorable && POSIX_BARE.test(path) && !POSIX_BAD_START.test(path)) return path;
      if (path.includes("'") && !POSIX_DOUBLE_UNSAFE.test(path)) return `"${path}"`;
      return `'${path.replace(/[\\']/g, '\\$&')}'`;
    default:
      if (!ignorable && POSIX_BARE.test(path) && !POSIX_BAD_START.test(path)) return path;
      if (path.includes("'") && !POSIX_DOUBLE_UNSAFE.test(path)) return `"${path}"`;
      return `'${path.replace(/'/g, "'\\''")}'`;
  }
}

/**
 * A run of Hangul as Finder hands it over — conjoining jamo, perhaps after a
 * syllable they extend — which composing turns into syllables.
 */
const HANGUL_RUN = /[\u{AC00}-\u{D7A3}]?[\u{1100}-\u{11FF}\u{A960}-\u{A97F}\u{D7B0}-\u{D7FF}]+/gu;

/**
 * `path` with its decomposed Hangul composed, and nothing else changed.
 *
 * Finder hands over Hangul decomposed into jamo (NFD — "자소 분리"), which a
 * terminal draws as loose letters and an agent reads as a different word;
 * APFS and HFS+ look the composed spelling up as the same file. Only Hangul:
 * composing the whole path (NFC) also rewrites characters that have a
 * canonical equivalent of their own — CJK compatibility ideographs
 * (U+F900–U+FAFF) and the Angstrom, Kelvin and Ohm signs — and a name holding
 * one was then not found, or on HFS+ found ANOTHER file (measured on HFS+,
 * exFAT and FAT32 images). A decomposed Latin accent is left as it is; it
 * draws correctly either way.
 */
function composeHangul(path) {
  return path.replace(HANGUL_RUN, (run) => run.normalize('NFC'));
}

/**
 * The text a drop of `paths` pastes into a terminal running `shellPath`.
 *
 * Each path is translated for that shell, then quoted for it, and the words
 * are joined with one space. A path that is not a non-empty string, holds a
 * control character, or cannot be written for this shell is left out and
 * returned in `skipped`, as it was handed in; `text` is '' when nothing was
 * left.
 *
 * On macOS only, decomposed Hangul is composed first (`composeHangul`).
 * Windows and Linux compare names byte for byte, and there a composed
 * spelling could name a different file, or none.
 *
 * @param {string[]} paths
 * @param {{ shellPath?: string|null, platform?: string }} options
 * @returns {{ text: string, skipped: Array<unknown> }}
 */
export function formatDroppedPaths(paths, { shellPath = null, platform = null } = {}) {
  const kind = shellKindFor(shellPath, platform);
  const words = [];
  const skipped = [];
  for (const original of Array.isArray(paths) ? paths : []) {
    if (typeof original !== 'string' || original === '' || CONTROL.test(original)) {
      skipped.push(original);
      continue;
    }
    const spelled = platform === 'macos' ? composeHangul(original) : original;
    const word = quotePath(translatePath(spelled, kind), kind);
    if (word === null) {
      skipped.push(original);
      continue;
    }
    words.push(word);
  }
  return { text: words.join(' '), skipped };
}

/**
 * Where a `tauri://drag-*` event's `position` is, in the CSS pixels
 * `document.elementFromPoint` takes.
 *
 * Tauri passes on wry's raw value as a `PhysicalPosition` without converting
 * it (tauri-runtime-wry 2.11.4, lib.rs ≈4867), so what it means is whatever
 * each webview reported:
 *
 *   - Windows: physical pixels from the webview's top-left — WebView2's
 *     screen point through `ScreenToClient` (wry 0.55.1,
 *     webview2/drag_drop.rs) — so it is divided by the device pixel ratio;
 *   - macOS: points from the webview's top-left (wkwebview/drag_drop.rs:40-42),
 *     which at the page zoom NexTerm never changes ARE CSS pixels — so,
 *     although Tauri labels them physical, they must not be divided;
 *   - Linux: GTK widget coordinates, logical already.
 *
 * A ratio that is missing, zero or not a number counts as 1, and a missing
 * coordinate as 0: the answer is always a point, if a useless one.
 *
 * @param {{x: number, y: number}} position
 * @param {{ platform?: string, devicePixelRatio?: number }} options
 * @returns {{ x: number, y: number }}
 */
export function dropPointToClient(position, { platform = null, devicePixelRatio = 1 } = {}) {
  const coordinate = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const x = coordinate(position?.x);
  const y = coordinate(position?.y);
  if (platform !== 'windows') return { x, y };
  const ratio =
    typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return { x: x / ratio, y: y / ratio };
}
