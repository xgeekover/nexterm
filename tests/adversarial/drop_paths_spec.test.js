/**
 * W1 -- dropping files onto a terminal: black-box spec tests for
 * `src/lib/dropPaths.js`.
 *
 * Written from the W1 design note (section "Pure module: src/lib/dropPaths.js")
 * and from how the real shells read a command line, WITHOUT looking at the
 * implementation: this file is a second, independent reading of the spec.
 * Where the spec is silent the expectation follows the real shell and the case
 * carries a `// AMBIGUOUS:` comment, so a disagreement with the implementation
 * gets triaged instead of being "fixed" in whichever file is easier to edit.
 *
 * Why it matters: what this module returns is PASTED into a live shell. A path
 * quoted wrongly is not a cosmetic bug -- `$(...)`, a backtick, `;`, `&` or a
 * newline in a file name runs code the moment the user presses Enter (or, with
 * no bracketed paste, immediately). So the quoting cases are exhaustive per
 * character class, and the posix/fish ones are also round-tripped through the
 * real shells installed on this machine.
 *
 * Every non-ASCII code point is written as a \u escape on purpose: decomposed
 * Hangul, combining marks and the PowerShell quote look-alikes are invisible
 * or indistinguishable in review otherwise. NFD strings are built with
 * `.normalize('NFD')` so the source never carries them raw.
 */
import { spawnSync } from 'node:child_process';
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
// The namespace, not the names: a missing or renamed export fails its own
// cases one by one instead of the whole file failing to load.
import * as dp from '../../src/lib/dropPaths.js';

// Amended after review 2026-10-09: a shell nobody recognises is its own kind, 'unknown', never cmd's or posix's.
const KINDS = ['cmd', 'powershell', 'posix', 'fish', 'msys', 'cygwin', 'wsl', 'unknown'];
const UNIX = ['macos', 'linux'];
const show = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

function expectKinds(rows) {
  for (const [shellPath, platform, want] of rows) {
    assert.equal(
      dp.shellKindFor(shellPath, platform),
      want,
      `shellKindFor(${show(shellPath)}, '${platform}')`
    );
  }
}

function expectTranslate(kind, rows) {
  for (const [input, want] of rows) {
    assert.equal(dp.translatePath(input, kind), want, `translatePath(${show(input)}, '${kind}')`);
  }
}

function expectQuote(kind, rows) {
  for (const [input, want] of rows) {
    assert.equal(dp.quotePath(input, kind), want, `quotePath(${show(input)}, '${kind}')`);
  }
}

function expectBare(kind, inputs) {
  expectQuote(
    kind,
    inputs.map((p) => [p, p])
  );
}

function expectFormat(paths, ctx, wantText, wantSkipped = []) {
  const got = dp.formatDroppedPaths(paths, ctx);
  const label = `formatDroppedPaths(${show(paths)}, ${show(ctx)})`;
  assert.ok(got && typeof got === 'object', `${label} returned ${show(got)}`);
  assert.equal(got.text, wantText, `${label}.text`);
  assert.deepEqual(got.skipped, wantSkipped, `${label}.skipped`);
  return got;
}

/** Reference forms for the per-character loops; explicit literals elsewhere pin them. */
const posixQuoted = (s) => `'${s.split("'").join("'\\''")}'`;
const fishQuoted = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Code points the spec says make a path unusable (C0, DEL, C1), boundaries included.
const CONTROL_CODES = [
  0x00, 0x01, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f,
];

// Hangul "\uD55C\uAE00" and "\uBB38\uC11C", precomposed (NFC) and decomposed (NFD).
const HANGUL = '\uD55C\uAE00';
const HANGUL2 = '\uBB38\uC11C';
const HANGUL_NFD = HANGUL.normalize('NFD');
const HANGUL2_NFD = HANGUL2.normalize('NFD');

// ---------------------------------------------------------------------------
// shellKindFor
// ---------------------------------------------------------------------------

describe('W1 dropPaths spec: shellKindFor', () => {
  test('DPS-SK-01 windows: cmd by full path, bare name or spec id, any case, with or without .exe', () => {
    expectKinds([
      ['C:\\Windows\\System32\\cmd.exe', 'windows', 'cmd'],
      ['C:\\WINDOWS\\system32\\CMD.EXE', 'windows', 'cmd'],
      ['C:/Windows/System32/cmd.exe', 'windows', 'cmd'],
      ['cmd.exe', 'windows', 'cmd'],
      ['Cmd.Exe', 'windows', 'cmd'],
      ['cmd', 'windows', 'cmd'],
      ['CMD', 'windows', 'cmd'],
    ]);
  });

  test('DPS-SK-02 windows: Windows PowerShell and PowerShell 7 are both powershell', () => {
    expectKinds([
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'windows', 'powershell'],
      ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'windows', 'powershell'],
      ['C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe', 'windows', 'powershell'],
      ['powershell', 'windows', 'powershell'],
      ['pwsh', 'windows', 'powershell'],
      ['PowerShell.EXE', 'windows', 'powershell'],
      ['PWSH', 'windows', 'powershell'],
    ]);
  });

  test('DPS-SK-03 windows: wsl.exe and the wsl spec id are wsl', () => {
    expectKinds([
      ['C:\\Windows\\System32\\wsl.exe', 'windows', 'wsl'],
      ['C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsl.exe', 'windows', 'wsl'],
      ['wsl', 'windows', 'wsl'],
      ['WSL.EXE', 'windows', 'wsl'],
    ]);
  });

  test('DPS-SK-04 windows: git-bash and every listed shell outside System32 is msys', () => {
    expectKinds([
      ['git-bash', 'windows', 'msys'],
      ['GIT-BASH', 'windows', 'msys'],
      ['C:\\Program Files\\Git\\bin\\bash.exe', 'windows', 'msys'],
      ['C:\\Program Files (x86)\\Git\\bin\\bash.exe', 'windows', 'msys'],
      ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'windows', 'msys'],
      ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'windows', 'msys'],
      ['C:\\Program Files\\Git\\bin\\BASH.EXE', 'windows', 'msys'],
      ['C:/Program Files/Git/bin/bash.exe', 'windows', 'msys'],
      ['C:\\msys64\\usr\\bin\\bash.exe', 'windows', 'msys'],
      ['C:\\msys64\\usr\\bin\\zsh.exe', 'windows', 'msys'],
      ['C:\\msys64\\usr\\bin\\dash.exe', 'windows', 'msys'],
      ['C:\\msys64\\usr\\bin\\ksh.exe', 'windows', 'msys'],
      ['C:\\msys64\\usr\\bin\\mksh.exe', 'windows', 'msys'],
      // The table puts fish in the same row as bash for windows: msys, not fish.
      ['C:\\msys64\\usr\\bin\\fish.exe', 'windows', 'msys'],
    ]);
  });

  test('DPS-SK-05 windows: bash under \\Windows\\System32\\ or \\Windows\\Sysnative\\ is the legacy WSL launcher', () => {
    expectKinds([
      ['C:\\Windows\\System32\\bash.exe', 'windows', 'wsl'],
      ['C:\\Windows\\Sysnative\\bash.exe', 'windows', 'wsl'],
      ['C:\\Windows\\System32\\BASH.EXE', 'windows', 'wsl'],
      ['C:\\Windows\\System32\\bash', 'windows', 'wsl'],
    ]);
  });

  test('DPS-SK-06 windows: System32/Sysnative spelled in another case, or with forward slashes, is still WSL bash', () => {
    // AMBIGUOUS: the spec states case-insensitivity for the basename only.
    // Windows paths are case-insensitive and %SystemRoot% is very often spelled
    // `C:\WINDOWS\system32` (that is what COMSPEC holds on many machines), and
    // Win32 accepts `/` as a separator, so all of these name the same file.
    expectKinds([
      ['C:\\WINDOWS\\system32\\bash.exe', 'windows', 'wsl'],
      ['c:\\windows\\sysnative\\bash.exe', 'windows', 'wsl'],
      ['C:/Windows/System32/bash.exe', 'windows', 'wsl'],
    ]);
  });

  test('DPS-SK-07 windows: the System32 rule is for bash only, and only under \\Windows\\', () => {
    expectKinds([
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'windows', 'powershell'],
      ['C:\\Windows\\System32\\cmd.exe', 'windows', 'cmd'],
      ['C:\\Windows\\System32\\wsl.exe', 'windows', 'wsl'],
      // In \Windows\ but not in System32/Sysnative: "elsewhere".
      ['C:\\Windows\\bash.exe', 'windows', 'msys'],
      // A System32 that is not under \Windows\.
      ['D:\\System32\\bash.exe', 'windows', 'msys'],
    ]);
  });

  test('DPS-SK-08 windows: a listed shell with a path segment containing "cygwin" is cygwin', () => {
    expectKinds([
      ['C:\\cygwin64\\bin\\bash.exe', 'windows', 'cygwin'],
      ['C:\\cygwin\\bin\\bash.exe', 'windows', 'cygwin'],
      ['D:\\tools\\cygwin64\\bin\\zsh.exe', 'windows', 'cygwin'],
      ['C:\\cygwin64\\bin\\sh.exe', 'windows', 'cygwin'],
      ['C:\\cygwin64\\bin\\dash.exe', 'windows', 'cygwin'],
      ['C:\\cygwin64\\bin\\mksh.exe', 'windows', 'cygwin'],
      ['C:\\cygwin64\\bin\\fish.exe', 'windows', 'cygwin'],
      ['C:\\cygwin64\\bin\\BASH.EXE', 'windows', 'cygwin'],
      // MSYS2 is not Cygwin, though it descends from it.
      ['C:\\msys64\\usr\\bin\\bash.exe', 'windows', 'msys'],
    ]);
  });

  test('DPS-SK-09 windows: "cygwin" in another case or behind forward slashes is still cygwin', () => {
    // AMBIGUOUS: the spec says "a path segment contains `cygwin`" without
    // saying case-insensitive or which separators. Windows paths are
    // case-insensitive and accept `/`, so `C:\Cygwin64` is the same install.
    expectKinds([
      ['C:\\Cygwin64\\bin\\bash.exe', 'windows', 'cygwin'],
      ['C:\\CYGWIN\\bin\\bash.exe', 'windows', 'cygwin'],
      ['C:/cygwin64/bin/bash.exe', 'windows', 'cygwin'],
    ]);
  });

  test('DPS-SK-10 windows: default, empty, null, undefined and login-shell fall back to cmd', () => {
    expectKinds([
      ['default', 'windows', 'cmd'],
      ['DEFAULT', 'windows', 'cmd'],
      ['', 'windows', 'cmd'],
      [null, 'windows', 'cmd'],
      [undefined, 'windows', 'cmd'],
      ['login-shell', 'windows', 'cmd'],
    ]);
  });

  test('DPS-SK-11 windows: an unknown name is unknown, even inside a Cygwin or Git tree', () => {
    // Amended after review 2026-10-09: cmd's double quotes let a POSIX-like unknown shell (ubuntu.exe, tcsh, busybox) run `touch x`; unknown names are 'unknown'.
    expectKinds([
      ['C:\\tools\\nu.exe', 'windows', 'unknown'],
      ['nu', 'windows', 'unknown'],
      ['C:\\Python312\\python.exe', 'windows', 'unknown'],
      ['elvish.exe', 'windows', 'unknown'],
      ['C:\\Program Files\\Git\\bin\\git.exe', 'windows', 'unknown'],
      ['C:\\Windows\\System32\\conhost.exe', 'windows', 'unknown'],
      // tcsh is not in the table's list of names, so it is "unknown".
      ['C:\\cygwin64\\bin\\tcsh.exe', 'windows', 'unknown'],
    ]);
  });

  test('DPS-SK-12 windows: a bare bash with no directory is wsl; a bare zsh/sh name is msys', () => {
    // Amended after review 2026-10-09: the backend hands "bash" on unresolved and Windows finds System32\bash.exe (WSL) before Git's.
    expectKinds([
      ['bash', 'windows', 'wsl'],
      ['bash.exe', 'windows', 'wsl'],
      ['zsh', 'windows', 'msys'],
      ['sh.exe', 'windows', 'msys'],
    ]);
  });

  test('DPS-SK-13 macos/linux: spec ids', () => {
    for (const platform of UNIX) {
      expectKinds([
        ['cmd', platform, 'posix'],
        ['powershell', platform, 'powershell'],
        ['pwsh', platform, 'powershell'],
        ['wsl', platform, 'posix'],
        ['git-bash', platform, 'posix'],
        ['login-shell', platform, 'posix'],
        ['zsh', platform, 'posix'],
        ['bash', platform, 'posix'],
        ['sh', platform, 'posix'],
        ['fish', platform, 'fish'],
      ]);
    }
  });

  test('DPS-SK-14 macos/linux: default, empty, null and undefined fall back to posix', () => {
    for (const platform of UNIX) {
      expectKinds([
        ['default', platform, 'posix'],
        ['', platform, 'posix'],
        [null, platform, 'posix'],
        [undefined, platform, 'posix'],
      ]);
    }
  });

  test('DPS-SK-15 macos/linux: full paths of real shells', () => {
    for (const platform of UNIX) {
      expectKinds([
        ['/bin/zsh', platform, 'posix'],
        ['/usr/bin/zsh', platform, 'posix'],
        ['/bin/bash', platform, 'posix'],
        ['/opt/homebrew/bin/bash', platform, 'posix'],
        ['/bin/sh', platform, 'posix'],
        ['/bin/dash', platform, 'posix'],
        ['/bin/ksh', platform, 'posix'],
        ['/bin/mksh', platform, 'posix'],
        ['/usr/bin/fish', platform, 'fish'],
        ['/opt/homebrew/bin/fish', platform, 'fish'],
        ['/usr/local/bin/fish', platform, 'fish'],
        ['/usr/local/bin/pwsh', platform, 'powershell'],
        ['/opt/microsoft/powershell/7/pwsh', platform, 'powershell'],
        ['/snap/bin/powershell', platform, 'powershell'],
      ]);
    }
  });

  test('DPS-SK-16 macos/linux: the name is matched case-insensitively with .exe stripped', () => {
    for (const platform of UNIX) {
      expectKinds([
        ['/usr/bin/FISH', platform, 'fish'],
        ['/usr/bin/Fish.Exe', platform, 'fish'],
        ['fish.exe', platform, 'fish'],
        ['/usr/local/bin/Pwsh', platform, 'powershell'],
        ['PWSH.EXE', platform, 'powershell'],
        ['/bin/ZSH', platform, 'posix'],
      ]);
    }
  });

  test('DPS-SK-17 macos/linux: unknown shells are unknown; Windows paths (nonsense here) are posix, without throwing', () => {
    // Amended after review 2026-10-09: tcsh/csh expand ! even inside single quotes, nu/xonsh read escapes in quotes: unknown names are 'unknown'.
    for (const platform of UNIX) {
      expectKinds([
        ['/bin/tcsh', platform, 'unknown'],
        ['/bin/csh', platform, 'unknown'],
        ['/usr/local/bin/nu', platform, 'unknown'],
        ['/usr/bin/xonsh', platform, 'unknown'],
        ['/usr/bin/env', platform, 'unknown'],
        ['C:\\Windows\\System32\\cmd.exe', platform, 'posix'],
        ['C:\\Windows\\System32\\bash.exe', platform, 'posix'],
        ['C:\\Windows\\System32\\wsl.exe', platform, 'posix'],
        ['C:\\cygwin64\\bin\\bash.exe', platform, 'posix'],
        ['C:\\Program Files\\Git\\bin\\bash.exe', platform, 'posix'],
      ]);
    }
  });

  test('DPS-SK-18 garbage never throws, lands on the platform fallback or unknown, and every answer is one of the eight kinds', () => {
    // Amended after review 2026-10-09: an empty basename is still the platform fallback, but a name nobody recognises is now 'unknown'.
    const garbage = ['/', '\\', '.exe', '   '];
    for (const g of garbage) {
      expectKinds([
        [g, 'windows', 'cmd'],
        [g, 'macos', 'posix'],
        [g, 'linux', 'posix'],
      ]);
    }
    // Amended after review 2026-10-09: these have a basename ("C:", "System32", "share", "exe"), which is no shell anyone knows.
    const named = ['C:\\', 'C:\\Windows\\System32\\', '\\\\server\\share\\', 'exe'];
    for (const g of named) {
      expectKinds([
        [g, 'windows', 'unknown'],
        [g, 'macos', 'unknown'],
        [g, 'linux', 'unknown'],
      ]);
    }
    const sweep = [
      ...garbage,
      ...named,
      'cmd', 'powershell', 'pwsh', 'git-bash', 'wsl', 'login-shell', 'default', '', null, undefined,
      'C:\\Windows\\System32\\bash.exe', 'C:\\cygwin64\\bin\\fish.exe', '/usr/bin/fish', '/bin/zsh',
    ];
    for (const platform of ['windows', 'macos', 'linux']) {
      for (const s of sweep) {
        const kind = dp.shellKindFor(s, platform);
        assert.ok(KINDS.includes(kind), `shellKindFor(${show(s)}, '${platform}') = ${show(kind)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// translatePath
// ---------------------------------------------------------------------------

describe('W1 dropPaths spec: translatePath', () => {
  test('DPS-TP-01 cmd/powershell: Windows paths get backslashes, nothing else changes', () => {
    for (const kind of ['cmd', 'powershell']) {
      expectTranslate(kind, [
        ['C:\\Users\\me\\a b.txt', 'C:\\Users\\me\\a b.txt'],
        ['C:/Users/me/a.txt', 'C:\\Users\\me\\a.txt'],
        ['C:\\Users/me\\src/x.js', 'C:\\Users\\me\\src\\x.js'],
        ['c:/lower/case', 'c:\\lower\\case'],
        ['C:\\', 'C:\\'],
        ['D:/', 'D:\\'],
        ['\\\\server\\share\\dir/file.txt', '\\\\server\\share\\dir\\file.txt'],
        ['\\\\server\\share', '\\\\server\\share'],
        [`C:\\${HANGUL}/${HANGUL2}.txt`, `C:\\${HANGUL}\\${HANGUL2}.txt`],
        // Not Windows-looking: left exactly as it is.
        ['/usr/local/bin', '/usr/local/bin'],
        ['/c/Users/me', '/c/Users/me'],
      ]);
    }
  });

  test('DPS-TP-02 cmd/powershell: the \\\\?\\ and \\\\?\\UNC\\ long-path prefixes are stripped', () => {
    for (const kind of ['cmd', 'powershell']) {
      expectTranslate(kind, [
        ['\\\\?\\C:\\very\\long\\path', 'C:\\very\\long\\path'],
        ['\\\\?\\c:\\x', 'c:\\x'],
        ['\\\\?\\D:\\', 'D:\\'],
        ['\\\\?\\C:\\a/b', 'C:\\a\\b'],
        ['\\\\?\\UNC\\server\\share\\x', '\\\\server\\share\\x'],
        ['\\\\?\\UNC\\server\\share\\a/b', '\\\\server\\share\\a\\b'],
        // Neither of the two prefixes the spec names: not stripped.
        [
          '\\\\?\\Volume{b75e2c83-0000-0000-0000-602f00000000}\\x',
          '\\\\?\\Volume{b75e2c83-0000-0000-0000-602f00000000}\\x',
        ],
      ]);
    }
  });

  test('DPS-TP-03 every Windows-flavoured kind strips \\\\?\\unc\\ spelled in lower case', () => {
    // AMBIGUOUS: the spec writes `\\?\UNC\`. The object manager resolves the
    // `UNC` link case-insensitively, so `\\?\unc\srv\share` opens the same share.
    expectTranslate('cmd', [['\\\\?\\unc\\server\\share\\x', '\\\\server\\share\\x']]);
    expectTranslate('powershell', [['\\\\?\\unc\\server\\share\\x', '\\\\server\\share\\x']]);
    expectTranslate('msys', [['\\\\?\\unc\\server\\share\\x', '//server/share/x']]);
    expectTranslate('cygwin', [['\\\\?\\unc\\server\\share\\x', '//server/share/x']]);
    expectTranslate('wsl', [['\\\\?\\unc\\server\\share\\x', '\\\\server\\share\\x']]);
  });

  test('DPS-TP-04 msys: drives become X:/... with the letter as given, either separator', () => {
    // Amended after review 2026-10-09: mixed C:/a/b, which MSYS2 opens and so does a native program (OpenCode, node) run in a Git Bash tab; /c/a is no path to it.
    expectTranslate('msys', [
      ['C:\\Users\\me\\x', 'C:/Users/me/x'],
      ['C:/Users/me/x', 'C:/Users/me/x'],
      ['C:\\a/b\\c', 'C:/a/b/c'],
      ['c:\\a', 'c:/a'],
      ['Z:\\Data\\Mixed Case', 'Z:/Data/Mixed Case'],
      ['C:\\Program Files\\Git', 'C:/Program Files/Git'],
      ['D:\\', 'D:/'],
      ['D:/', 'D:/'],
      [`C:\\Users\\${HANGUL}\\${HANGUL2}.txt`, `C:/Users/${HANGUL}/${HANGUL2}.txt`],
    ]);
  });

  test('DPS-TP-05 msys: UNC becomes //server/share/..., long-path prefixes first', () => {
    expectTranslate('msys', [
      ['\\\\server\\share\\a', '//server/share/a'],
      ['\\\\server\\share\\a/b', '//server/share/a/b'],
      // Amended after review 2026-10-09: mixed C:/... paths for msys (see DPS-TP-04).
      ['\\\\?\\C:\\x\\y', 'C:/x/y'],
      ['\\\\?\\D:\\', 'D:/'],
      ['\\\\?\\UNC\\server\\share\\x', '//server/share/x'],
      // A WSL share is just another UNC share to Git Bash.
      ['\\\\wsl$\\Ubuntu\\home', '//wsl$/Ubuntu/home'],
    ]);
  });

  test('DPS-TP-06 msys: POSIX paths are left alone', () => {
    expectTranslate('msys', [
      ['/usr/bin/env', '/usr/bin/env'],
      ['/c/already/posix', '/c/already/posix'],
      ['/tmp/a b', '/tmp/a b'],
      ['/', '/'],
    ]);
  });

  test('DPS-TP-07 cygwin: drives become X:/..., UNC as msys', () => {
    // Amended after review 2026-10-09: mixed C:/a/b, which Cygwin opens and so does a native program run in a Cygwin tab; /cygdrive/c/a is no path to it.
    expectTranslate('cygwin', [
      ['C:\\a\\b', 'C:/a/b'],
      ['D:\\Users\\Me\\x y', 'D:/Users/Me/x y'],
      ['\\\\?\\C:\\x', 'C:/x'],
      ['\\\\server\\share\\a', '//server/share/a'],
      ['\\\\?\\UNC\\server\\share\\x', '//server/share/x'],
      ['/home/me', '/home/me'],
    ]);
  });

  test('DPS-TP-08 cygwin: forward slashes, mixed separators and a drive root', () => {
    // AMBIGUOUS: the spec only shows `X:\a\b` for cygwin. msys spells out `/`
    // and the root (`X:\` -> `/x/`); Cygwin's own cygpath gives the same shapes
    // under /cygdrive, so the same rules are expected here.
    // Amended after review 2026-10-09: mixed C:/... paths for cygwin (see DPS-TP-07).
    expectTranslate('cygwin', [
      ['C:/a/b', 'C:/a/b'],
      ['C:\\a/b', 'C:/a/b'],
      ['E:\\', 'E:/'],
    ]);
  });

  test('DPS-TP-09 wsl: drives become /mnt/x/... with the letter lower-cased', () => {
    expectTranslate('wsl', [
      ['C:\\a\\b', '/mnt/c/a/b'],
      ['D:\\Work\\x y', '/mnt/d/Work/x y'],
      ['c:\\Users\\Me', '/mnt/c/Users/Me'],
      ['\\\\?\\C:\\x', '/mnt/c/x'],
      [`C:\\${HANGUL}\\${HANGUL2}`, `/mnt/c/${HANGUL}/${HANGUL2}`],
    ]);
  });

  test('DPS-TP-10 wsl: forward slashes, mixed separators and a drive root', () => {
    // AMBIGUOUS: the spec only shows `X:\a\b` for wsl. `wslpath` maps all of
    // these the same way (`C:\` -> `/mnt/c/`).
    expectTranslate('wsl', [
      ['C:/a/b', '/mnt/c/a/b'],
      ['C:\\a/b', '/mnt/c/a/b'],
      ['C:\\', '/mnt/c/'],
    ]);
  });

  test('DPS-TP-11 wsl: \\\\wsl$\\ and \\\\wsl.localhost\\ shares map into the distro, host in any case', () => {
    expectTranslate('wsl', [
      ['\\\\wsl$\\Ubuntu\\home\\me\\x', '/home/me/x'],
      ['\\\\wsl.localhost\\Ubuntu\\home\\me', '/home/me'],
      ['\\\\WSL$\\Ubuntu\\a', '/a'],
      ['\\\\Wsl.LocalHost\\Ubuntu-22.04\\a\\b', '/a/b'],
      ['\\\\WSL.LOCALHOST\\Debian\\etc', '/etc'],
      ['\\\\wsl$\\Ubuntu', '/'],
      ['\\\\wsl.localhost\\Ubuntu', '/'],
      ['\\\\WsL$\\Ubuntu', '/'],
      ['\\\\?\\UNC\\wsl$\\Ubuntu\\home\\me', '/home/me'],
      ['\\\\?\\UNC\\wsl.localhost\\Ubuntu', '/'],
      [`\\\\wsl$\\Ubuntu\\home\\${HANGUL}`, `/home/${HANGUL}`],
    ]);
  });

  test('DPS-TP-12 wsl: a distro share with a trailing backslash or a forward slash inside', () => {
    // AMBIGUOUS: the spec gives `\\wsl$\<distro>\a\b` and `\\wsl$\Ubuntu`
    // alone; a trailing separator or a `/` in the tail is not mentioned. Both
    // name the same directory on Windows.
    expectTranslate('wsl', [
      ['\\\\wsl$\\Ubuntu\\', '/'],
      ['\\\\wsl$\\Ubuntu\\home/me', '/home/me'],
    ]);
  });

  test('DPS-TP-13 wsl: any other UNC share and POSIX paths are left unchanged', () => {
    expectTranslate('wsl', [
      ['\\\\server\\share\\a', '\\\\server\\share\\a'],
      ['\\\\nas\\share\\a b', '\\\\nas\\share\\a b'],
      // Hosts that merely look like the WSL ones.
      ['\\\\wslhost\\Ubuntu\\a', '\\\\wslhost\\Ubuntu\\a'],
      ['\\\\wsl.localhost.example\\Ubuntu\\a', '\\\\wsl.localhost.example\\Ubuntu\\a'],
      // Stripped of the long-path prefix, then left alone.
      ['\\\\?\\UNC\\server\\share\\x', '\\\\server\\share\\x'],
      ['/home/me/x', '/home/me/x'],
    ]);
  });

  test('DPS-TP-14 posix/fish: nothing is translated, not even a long-path prefix', () => {
    for (const kind of ['posix', 'fish']) {
      expectTranslate(kind, [
        ['C:\\a\\b', 'C:\\a\\b'],
        ['C:/a/b', 'C:/a/b'],
        ['\\\\?\\C:\\x', '\\\\?\\C:\\x'],
        ['\\\\server\\share', '\\\\server\\share'],
        ['/Users/me/a b', '/Users/me/a b'],
        ['~/x', '~/x'],
      ]);
    }
  });

  test('DPS-TP-15 translation never normalizes Unicode (only formatDroppedPaths does, on macos)', () => {
    const nfd = `${HANGUL_NFD}\\cafe\u0301`;
    const tail = `${HANGUL_NFD}/cafe\u0301`;
    expectTranslate('cmd', [[`C:\\${nfd}`, `C:\\${nfd}`]]);
    expectTranslate('powershell', [[`C:\\${nfd}`, `C:\\${nfd}`]]);
    // Amended after review 2026-10-09: mixed C:/... paths for msys and cygwin (see DPS-TP-04, DPS-TP-07).
    expectTranslate('msys', [[`C:\\${nfd}`, `C:/${tail}`]]);
    expectTranslate('cygwin', [[`C:\\${nfd}`, `C:/${tail}`]]);
    expectTranslate('wsl', [[`C:\\${nfd}`, `/mnt/c/${tail}`]]);
    expectTranslate('posix', [[`/${tail}`, `/${tail}`]]);
    expectTranslate('fish', [[`/${tail}`, `/${tail}`]]);
  });
});

// ---------------------------------------------------------------------------
// quotePath
// ---------------------------------------------------------------------------

const CMD_SPECIALS = ['&', '(', ')', '[', ']', '{', '}', '^', '=', ';', '!', "'", '+', ',', '`', '~', '<', '>', '|'];
const PS_SPECIALS = [
  ' ', '\u00A0', '`', '$', '&', '(', ')', '{', '}', '[', ']', ';', ',', '"', '@', '#', '|', '<', '>', '+', '=',
  '~', '!', '%', '^', '*', '?', '\u201C', '\u201D', '\u2013', '\u00A1', '\uD83D\uDE00',
];
const POSIX_SPECIALS = [
  ' ', '!', '"', '#', '$', '&', "'", '(', ')', '*', ';', '<', '>', '?', '[', '\\', ']', '^', '`', '{', '|', '}',
  '~', '\u00A0', '\u3000', '\u2013', '\u2019', '\u00A1', '\uFEFF', '\uD83D\uDE00',
];

describe('W1 dropPaths spec: quotePath', () => {
  // ---- cmd ----------------------------------------------------------------
  test('DPS-QP-01 cmd: bare when there is no whitespace and none of the listed characters', () => {
    expectBare('cmd', [
      'C:\\Users\\me\\file.txt',
      'C:\\',
      '\\\\server\\share\\x',
      'C:\\a@b#c$d',
      'C:\\a-b_c.d',
      'D:\\-dash',
      `C:\\${HANGUL}\\${HANGUL2}.txt`,
      'C:\\caf\u00E9',
      'C:\\cafe\u0301',
    ]);
    // Amended after review 2026-10-09: U+200B draws nothing (Default_Ignorable_Code_Point), so the path is quoted to keep its boundaries visible.
    expectQuote('cmd', [['C:\\a\u200Bb', '"C:\\a\u200Bb"']]);
  });

  test('DPS-QP-02 cmd: any /\\s/u whitespace means "..."', () => {
    expectQuote('cmd', [
      ['C:\\Program Files\\x', '"C:\\Program Files\\x"'],
      ['C:\\x ', '"C:\\x "'],
    ]);
    for (const ws of [' ', '\u00A0', '\u2003', '\u3000', '\u2028', '\uFEFF']) {
      expectQuote('cmd', [[`C:\\a${ws}b`, `"C:\\a${ws}b"`]]);
    }
    // TAB is whitespace to /\s/u but also a C0 control. Triage (Queen,
    // 2026-10-09): quotePath refuses control characters for every kind, the
    // same rule formatDroppedPaths applies, so the exported function is never
    // the one place a raw control character slips into a paste.
    expectQuote('cmd', [['C:\\a\tb', null]]);
  });

  test('DPS-QP-03 cmd: each of & ( ) [ ] { } ^ = ; ! \' + , ` ~ < > | means "..."', () => {
    for (const c of CMD_SPECIALS) {
      expectQuote('cmd', [[`C:\\a${c}b`, `"C:\\a${c}b"`]]);
    }
    expectQuote('cmd', [['C:\\R&D (old)\\x', '"C:\\R&D (old)\\x"']]);
  });

  test('DPS-QP-04 cmd: a double quote cannot be represented -> null', () => {
    for (const p of ['C:\\a"b', '"', 'C:\\x"', 'C:\\a "b" c', '\\\\?\\C:\\x"y']) {
      assert.equal(dp.quotePath(p, 'cmd'), null, `quotePath(${show(p)}, 'cmd')`);
    }
  });

  test('DPS-QP-05 cmd: % means "..."', () => {
    // Amended after review 2026-10-09: bare %VAR% expands and word-splits; inside quotes the expansion at least stays one word.
    expectQuote('cmd', [
      ['C:\\50%off\\x', '"C:\\50%off\\x"'],
      ['C:\\%PATH%\\x', '"C:\\%PATH%\\x"'],
    ]);
  });

  // ---- powershell -----------------------------------------------------------
  test('DPS-QP-06 powershell: bare when only letters, digits, marks and _ . : \\ / -', () => {
    expectBare('powershell', [
      'C:\\Users\\me\\file.txt',
      'C:\\',
      '\\\\server\\share\\x',
      'C:/a/b',
      '/Users/me/x.txt',
      'C:\\my-file_v2.0',
      `C:\\${HANGUL}\\${HANGUL2}.txt`,
      `C:\\${HANGUL_NFD}`,
      'C:\\caf\u00E9',
      'C:\\cafe\u0301',
      'C:\\\u0661\u0662',
    ]);
  });

  test('DPS-QP-07 powershell: anything outside that class means \'...\'', () => {
    expectQuote('powershell', [['C:\\Program Files\\x', "'C:\\Program Files\\x'"]]);
    for (const c of PS_SPECIALS) {
      expectQuote('powershell', [[`C:\\a${c}b`, `'C:\\a${c}b'`]]);
    }
  });

  test('DPS-QP-08 powershell: \' and U+2018..U+201B go in "..." when nothing expands there, else all doubled inside \'...\'', () => {
    // Amended after review 2026-10-09: OpenCode cannot open a doubled '' name; with no $ ` " U+201C..U+201E in it, "..." is the same string.
    expectQuote('powershell', [
      ["C:\\it's", `"C:\\it's"`],
      ['C:\\it\u2018s', '"C:\\it\u2018s"'],
      ['C:\\it\u2019s', '"C:\\it\u2019s"'],
      ['C:\\it\u201As', '"C:\\it\u201As"'],
      ['C:\\it\u201Bs', '"C:\\it\u201Bs"'],
      ["'", `"'"`],
      [
        "C:\\a b'\u2018\u2019\u201A\u201B",
        `"C:\\a b'\u2018\u2019\u201A\u201B"`,
      ],
    ]);
    // Amended after review 2026-10-09: with a $ in the name the single-quoted form, every single quote doubled, is still the one used.
    expectQuote('powershell', [
      ["C:\\$it's", "'C:\\$it''s'"],
      ['C:\\$it\u2018s', "'C:\\$it\u2018\u2018s'"],
      ['C:\\$it\u2019s', "'C:\\$it\u2019\u2019s'"],
      ['C:\\$it\u201As', "'C:\\$it\u201A\u201As'"],
      ['C:\\$it\u201Bs', "'C:\\$it\u201B\u201Bs'"],
      ["$'", "'$'''"],
      [
        "C:\\$a b'\u2018\u2019\u201A\u201B",
        "'C:\\$a b''\u2018\u2018\u2019\u2019\u201A\u201A\u201B\u201B'",
      ],
    ]);
  });

  test('DPS-QP-09 powershell: a leading - or U+2013/U+2014/U+2015 is quoted; a dash later is fine', () => {
    expectQuote('powershell', [
      ['-file', "'-file'"],
      ['-', "'-'"],
      ['--x', "'--x'"],
      ['\u2013file', "'\u2013file'"],
      ['\u2014file', "'\u2014file'"],
      ['\u2015file', "'\u2015file'"],
    ]);
    expectBare('powershell', ['C:\\a-b', '/a/-b']);
  });

  test('DPS-QP-10 powershell: double quotes, $ and backticks are literal inside \'...\' and are not escaped', () => {
    expectQuote('powershell', [
      ['C:\\a"b', "'C:\\a\"b'"],
      ['C:\\a\u201Cb\u201D', "'C:\\a\u201Cb\u201D'"],
      ['C:\\$env:USERPROFILE', "'C:\\$env:USERPROFILE'"],
      ['C:\\a`b', "'C:\\a`b'"],
    ]);
  });

  // ---- posix ------------------------------------------------------------------
  test('DPS-QP-11 posix: bare when only letters, digits, marks and _ . / + , : @ % = -', () => {
    expectBare('posix', [
      '/Users/me/file.txt',
      '/',
      '/a_b.c/d+e,f:g@h%i=j-k',
      '/a/-b',
      '/a/=b',
      '/mnt/c/x',
      `/Users/me/${HANGUL}.txt`,
      `/Users/me/${HANGUL_NFD}.txt`,
      '/tmp/caf\u00E9',
      '/tmp/cafe\u0301',
      '/\u0661',
    ]);
  });

  test('DPS-QP-12 posix: every other character means \'...\'', () => {
    expectQuote('posix', [['/Users/me/My File.txt', "'/Users/me/My File.txt'"]]);
    for (const c of POSIX_SPECIALS) {
      // Amended after review 2026-10-09: a name whose only special is ' goes in "..." (see DPS-QP-14).
      const want = c === "'" ? `"/a'b"` : posixQuoted(`/a${c}b`);
      expectQuote('posix', [[`/a${c}b`, want]]);
    }
    expectQuote('posix', [
      ['/a$(rm -rf ~)', "'/a$(rm -rf ~)'"],
      ['/a`id`', "'/a`id`'"],
      ['/a\\b', "'/a\\b'"],
      ['/a\\', "'/a\\'"],
    ]);
  });

  test('DPS-QP-13 posix: a leading -, = or ~ is quoted', () => {
    expectQuote('posix', [
      ['-rf', "'-rf'"],
      ['-', "'-'"],
      ['--help', "'--help'"],
      ['=cmd', "'=cmd'"],
      ['=', "'='"],
      ['~', "'~'"],
      ['~/x', "'~/x'"],
      ['~root', "'~root'"],
      ['\u2014x', "'\u2014x'"],
    ]);
  });

  test('DPS-QP-14 posix: an embedded \' goes in "..." when nothing expands there, else becomes \'\\\'\'', () => {
    // Amended after review 2026-10-09: OpenCode cannot open a name written '\\''; with no $ ` " \\ ! in it, "..." is the same string.
    expectQuote('posix', [
      ["/Users/me/it's", `"/Users/me/it's"`],
      ["'", `"'"`],
      ["/a b'c'd", `"/a b'c'd"`],
      ["/a''b", `"/a''b"`],
    ]);
    // Amended after review 2026-10-09: with any of $ ` " \\ ! in the name the '\\'' form is still the one used.
    expectQuote('posix', [
      ["/Users/me/it's$x", "'/Users/me/it'\\''s$x'"],
      ["'!", "''\\''!'"],
      ["/a b'c'd`", "'/a b'\\''c'\\''d`'"],
      ["/a''b\\", "'/a'\\'''\\''b\\'"],
    ]);
  });

  test('DPS-QP-15 msys/cygwin/wsl quote translated paths with the posix rules', () => {
    for (const kind of ['msys', 'cygwin', 'wsl']) {
      expectQuote(kind, [
        ['/c/Program Files/x', "'/c/Program Files/x'"],
        ['/cygdrive/c/x', '/cygdrive/c/x'],
        // Amended after review 2026-10-09: a name whose only special is ' goes in "..." (see DPS-QP-14).
        ["/mnt/c/it's", `"/mnt/c/it's"`],
        ['-x', "'-x'"],
        ['=x', "'=x'"],
        [`/mnt/c/${HANGUL}`, `/mnt/c/${HANGUL}`],
        // An untranslated UNC share (wsl leaves it alone): the backslashes survive.
        ['\\\\nas\\share\\a', "'\\\\nas\\share\\a'"],
        ['/a"b', "'/a\"b'"],
      ]);
    }
  });

  // ---- fish -------------------------------------------------------------------
  test('DPS-QP-16 fish: the same bare rule as posix', () => {
    expectBare('fish', [
      '/Users/me/file.txt',
      '/',
      '/a_b.c/d+e,f:g@h%i=j-k',
      '/a/-b',
      '/a/=b',
      `/Users/me/${HANGUL}.txt`,
      `/Users/me/${HANGUL_NFD}.txt`,
      '/tmp/cafe\u0301',
    ]);
  });

  test('DPS-QP-17 fish: inside \'...\' a backslash is \\\\ and a quote is \\\'', () => {
    expectQuote('fish', [
      ['/a b', "'/a b'"],
      ['/a\\b', "'/a\\\\b'"],
      ['/a\\\\b', "'/a\\\\\\\\b'"],
      ['\\', "'\\\\'"],
      ['/a\\', "'/a\\\\'"],
      // Amended after review 2026-10-09: a name whose only special is ' goes in "..."; with a $ the escaped single-quote form stays.
      ["/it's", `"/it's"`],
      ["'", `"'"`],
      ["/it's$x", "'/it\\'s$x'"],
      ["/a\\'b", "'/a\\\\\\'b'"],
      ['/a$b', "'/a$b'"],
      ['/a"b', "'/a\"b'"],
    ]);
  });

  test('DPS-QP-18 fish: every special character and a leading -, = or ~ means \'...\'', () => {
    for (const c of POSIX_SPECIALS) {
      // Amended after review 2026-10-09: a name whose only special is ' goes in "..." (see DPS-QP-17).
      const want = c === "'" ? `"/a'b"` : fishQuoted(`/a${c}b`);
      expectQuote('fish', [[`/a${c}b`, want]]);
    }
    expectQuote('fish', [
      ['-rf', "'-rf'"],
      ['=x', "'=x'"],
      ['~', "'~'"],
      ['~/x', "'~/x'"],
      ['/a{b,c}', "'/a{b,c}'"],
    ]);
  });

  test('DPS-QP-19 only cmd ever gives up: every printable path is representable for the other kinds', () => {
    const hard = ['/a"b', "/a'b", '/a\\b', '\\', "'", '"', '/a\u2019"\'\\`$b', ' ', '-', '=', '~'];
    for (const kind of ['powershell', 'posix', 'fish', 'msys', 'cygwin', 'wsl']) {
      for (const p of hard) {
        const q = dp.quotePath(p, kind);
        assert.equal(typeof q, 'string', `quotePath(${show(p)}, '${kind}') = ${show(q)}`);
        assert.ok(q.length > 0, `quotePath(${show(p)}, '${kind}') is empty`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// formatDroppedPaths
// ---------------------------------------------------------------------------

const WIN_CMD = { shellPath: 'C:\\Windows\\System32\\cmd.exe', platform: 'windows' };
const WIN_PS = { shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', platform: 'windows' };
const WIN_GITBASH = { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'windows' };
const WIN_CYGWIN = { shellPath: 'C:\\cygwin64\\bin\\bash.exe', platform: 'windows' };
const WIN_WSL = { shellPath: 'C:\\Windows\\System32\\wsl.exe', platform: 'windows' };
const MAC_ZSH = { shellPath: '/bin/zsh', platform: 'macos' };
const LINUX_BASH = { shellPath: '/bin/bash', platform: 'linux' };
const LINUX_FISH = { shellPath: '/usr/bin/fish', platform: 'linux' };

describe('W1 dropPaths spec: formatDroppedPaths', () => {
  test('DPS-FD-01 cmd: several paths, one space between, quoted only when needed, no trailing space', () => {
    const got = expectFormat(
      ['C:\\a.txt', 'C:\\Program Files\\b', 'D:\\', 'C:/fwd/slash'],
      WIN_CMD,
      'C:\\a.txt "C:\\Program Files\\b" D:\\ C:\\fwd\\slash'
    );
    assert.ok(!got.text.endsWith(' ') && !got.text.startsWith(' '), 'no leading/trailing space');
    expectFormat(['C:\\only.txt'], WIN_CMD, 'C:\\only.txt');
    expectFormat(['C:\\dup', 'C:\\dup'], WIN_CMD, 'C:\\dup C:\\dup');
  });

  test('DPS-FD-02 cmd: long-path prefixes are stripped before quoting', () => {
    expectFormat(
      ['\\\\?\\C:\\x y', '\\\\?\\UNC\\srv\\share\\z'],
      WIN_CMD,
      '"C:\\x y" \\\\srv\\share\\z'
    );
  });

  test('DPS-FD-03 cmd: a path with a double quote is skipped, the rest still go in, order kept', () => {
    expectFormat(['C:\\a"b', 'C:\\c d'], WIN_CMD, '"C:\\c d"', ['C:\\a"b']);
    expectFormat(['\\\\?\\C:\\x"y'], WIN_CMD, '', ['\\\\?\\C:\\x"y']);
    expectFormat(
      ['C:\\1', 'C:\\bad\nname', 'C:\\2', 'C:\\x"', 'C:\\3'],
      WIN_CMD,
      'C:\\1 C:\\2 C:\\3',
      ['C:\\bad\nname', 'C:\\x"']
    );
  });

  test('DPS-FD-04 powershell: \'...\' with doubled quotes, bare otherwise', () => {
    expectFormat(
      ['C:\\Program Files\\x', 'C:\\y', "C:\\it's", 'C:\\a\u2019b'],
      WIN_PS,
      // Amended after review 2026-10-09: a name whose only special is a single quote goes in "..." (see DPS-QP-08).
      `'C:\\Program Files\\x' C:\\y "C:\\it's" "C:\\a\u2019b"`
    );
    // A double quote is fine for PowerShell -- only cmd skips it.
    expectFormat(['C:\\a"b'], WIN_PS, "'C:\\a\"b'");
  });

  test('DPS-FD-05 Git Bash (path or git-bash id): drives and UNC translated, then posix-quoted', () => {
    const paths = ['C:\\Users\\me\\My Docs\\a.txt', 'D:\\', '\\\\server\\share\\x y', '\\\\?\\C:\\long\\p'];
    // Amended after review 2026-10-09: mixed C:/... paths for Git Bash (see DPS-TP-04).
    const want = "'C:/Users/me/My Docs/a.txt' D:/ '//server/share/x y' C:/long/p";
    expectFormat(paths, WIN_GITBASH, want);
    expectFormat(paths, { shellPath: 'git-bash', platform: 'windows' }, want);
  });

  test('DPS-FD-06 Cygwin: X:/, posix-quoted', () => {
    // Amended after review 2026-10-09: mixed C:/... paths for Cygwin (see DPS-TP-07).
    expectFormat(['C:\\a b\\c', 'C:\\d'], WIN_CYGWIN, "'C:/a b/c' C:/d");
  });

  test('DPS-FD-07 WSL (wsl.exe, wsl id, System32 bash): /mnt/x, distro shares, other UNC kept and quoted', () => {
    const paths = ['C:\\x', "\\\\wsl.localhost\\Ubuntu\\home\\me\\it's", '\\\\nas\\share\\a', '\\\\wsl$\\Ubuntu'];
    // Amended after review 2026-10-09: a name whose only special is ' goes in "..." (see DPS-QP-14).
    const want = `/mnt/c/x "/home/me/it's" '\\\\nas\\share\\a' /`;
    expectFormat(paths, WIN_WSL, want);
    expectFormat(paths, { shellPath: 'wsl', platform: 'windows' }, want);
    expectFormat(paths, { shellPath: 'C:\\Windows\\System32\\bash.exe', platform: 'windows' }, want);
  });

  test('DPS-FD-08 posix on macos/linux and fish on linux', () => {
    expectFormat(
      ['/Users/me/My File.txt', '/Users/me/b.txt', "/Users/me/it's"],
      MAC_ZSH,
      // Amended after review 2026-10-09: a name whose only special is ' goes in "..." (see DPS-QP-14, DPS-QP-17).
      `'/Users/me/My File.txt' /Users/me/b.txt "/Users/me/it's"`
    );
    expectFormat(['/a$(id)', '-rf', '/ok'], LINUX_BASH, "'/a$(id)' '-rf' /ok");
    expectFormat(['/a b\\c', "/it's", '/plain'], LINUX_FISH, `'/a b\\\\c' "/it's" /plain`);
  });

  test('DPS-FD-09 a default shell follows the platform: cmd on windows, posix elsewhere', () => {
    for (const shellPath of ['default', '', null, undefined]) {
      expectFormat(['C:\\a b', 'C:\\c'], { shellPath, platform: 'windows' }, '"C:\\a b" C:\\c');
      expectFormat(['/a b', '/c'], { shellPath, platform: 'linux' }, "'/a b' /c");
      expectFormat(['/a b', '/c'], { shellPath, platform: 'macos' }, "'/a b' /c");
    }
  });

  test('DPS-FD-10 non-string and empty entries never reach the text', () => {
    const got = dp.formatDroppedPaths([null, undefined, 42, {}, '', 'C:\\x'], WIN_CMD);
    assert.equal(got.text, 'C:\\x');
    assert.ok(Array.isArray(got.skipped), 'skipped is an array');
    assert.ok(got.skipped.includes(''), 'the empty string is reported as skipped');
  });

  test('DPS-FD-11 non-string entries are reported in skipped as the originals', () => {
    // AMBIGUOUS: the spec says "skip it (push the original to `skipped`)" but
    // also types `skipped` as `string[]`. Following the prose literally.
    const obj = {};
    const got = dp.formatDroppedPaths([null, undefined, 42, obj, '', 'C:\\x'], WIN_CMD);
    assert.equal(got.text, 'C:\\x');
    assert.deepEqual(got.skipped, [null, undefined, 42, obj, '']);
    assert.equal(got.skipped[3], obj, 'the very same object, not a copy');
  });

  test('DPS-FD-12 C0, DEL and C1 controls skip the path, reported as the original', () => {
    const contexts = [
      { ctx: WIN_CMD, ok: 'C:\\ok', okText: 'C:\\ok', bad: (ch) => `C:\\bad${ch}x` },
      { ctx: WIN_PS, ok: 'C:\\ok', okText: 'C:\\ok', bad: (ch) => `C:\\bad${ch}x` },
      // Amended after review 2026-10-09: mixed C:/... paths for Git Bash (see DPS-TP-04).
      { ctx: WIN_GITBASH, ok: 'C:\\ok', okText: 'C:/ok', bad: (ch) => `C:\\bad${ch}x` },
      { ctx: WIN_WSL, ok: '\\\\wsl$\\Ubuntu\\ok', okText: '/ok', bad: (ch) => `\\\\wsl$\\Ubuntu\\bad${ch}x` },
      { ctx: MAC_ZSH, ok: '/ok', okText: '/ok', bad: (ch) => `/bad${ch}x` },
      { ctx: LINUX_FISH, ok: '/ok', okText: '/ok', bad: (ch) => `/bad${ch}x` },
    ];
    for (const { ctx, ok, okText, bad } of contexts) {
      for (const code of CONTROL_CODES) {
        const b = bad(String.fromCharCode(code));
        expectFormat([ok, b], ctx, okText, [b]);
        // At the start, the end, alone.
        const lead = String.fromCharCode(code) + ok;
        const trail = ok + String.fromCharCode(code);
        expectFormat([lead, ok, trail], ctx, okText, [lead, trail]);
      }
    }
  });

  test('DPS-FD-13 the neighbours of the control ranges are NOT controls and are kept', () => {
    // U+0020 space, U+007E tilde, U+00A0 no-break space, U+00A1 inverted !.
    expectFormat(['/a b', '/a~b', '/a\u00A0b', '/a\u00A1b'], LINUX_BASH, "'/a b' '/a~b' '/a\u00A0b' '/a\u00A1b'");
    expectFormat(['C:\\a\u00A0b', 'C:\\a\u00A1b'], WIN_CMD, '"C:\\a\u00A0b" C:\\a\u00A1b');
    expectFormat(['C:\\a\u00A0b'], WIN_PS, "'C:\\a\u00A0b'");
  });

  test('DPS-FD-14 skipped holds the ORIGINAL string: not normalized, not translated, not quoted', () => {
    const nfdBad = `/Users/me/${HANGUL_NFD}\nrm -rf ~`;
    expectFormat([nfdBad], MAC_ZSH, '', [nfdBad]);
    assert.notEqual(nfdBad, nfdBad.normalize('NFC'), 'precondition: the original is NFD');
    expectFormat(['\\\\?\\C:\\a\nb'], WIN_WSL, '', ['\\\\?\\C:\\a\nb']);
    expectFormat(['C:\\a\u001Bb c'], WIN_GITBASH, '', ['C:\\a\u001Bb c']);
    expectFormat(['C:\\a\u009Bb'], WIN_CMD, '', ['C:\\a\u009Bb']);
  });

  test('DPS-FD-15 nothing usable -> text is the empty string', () => {
    expectFormat([], WIN_CMD, '', []);
    expectFormat([], MAC_ZSH, '', []);
    expectFormat(['', '\n'], LINUX_BASH, '', ['', '\n']);
    expectFormat(['C:\\"'], WIN_CMD, '', ['C:\\"']);
  });

  test('DPS-FD-16 skipped entries at either end leave no stray space', () => {
    expectFormat(['\n', 'C:\\a', '\r'], WIN_CMD, 'C:\\a', ['\n', '\r']);
    expectFormat(['\u0000', '/a', '/b c', '\u007F'], MAC_ZSH, "/a '/b c'", ['\u0000', '\u007F']);
  });

  test('DPS-FD-17 macos: decomposed Hangul from Finder is recomposed; a decomposed Latin accent is left as given', () => {
    const nfd = `/Users/me/${HANGUL_NFD}.txt`;
    assert.notEqual(nfd, nfd.normalize('NFC'), 'precondition: the input really is NFD');
    expectFormat([nfd], MAC_ZSH, `/Users/me/${HANGUL}.txt`);
    expectFormat(
      [`/Users/me/${HANGUL_NFD} ${HANGUL2_NFD}.txt`],
      MAC_ZSH,
      `'/Users/me/${HANGUL} ${HANGUL2}.txt'`
    );
    // Amended after review 2026-10-09: only Hangul runs are composed; whole-string NFC also rewrote CJK compatibility ideographs and the Angstrom/Kelvin/Ohm signs, which then did not open (or opened another file on HFS+). Latin NFD draws fine.
    expectFormat(['/tmp/cafe\u0301'], MAC_ZSH, '/tmp/cafe\u0301');
    // Any shell kind on macos.
    expectFormat([nfd], { shellPath: '/usr/local/bin/pwsh', platform: 'macos' }, `/Users/me/${HANGUL}.txt`);
    expectFormat([nfd], { shellPath: '/opt/homebrew/bin/fish', platform: 'macos' }, `/Users/me/${HANGUL}.txt`);
    expectFormat([nfd], { shellPath: 'default', platform: 'macos' }, `/Users/me/${HANGUL}.txt`);
  });

  test('DPS-FD-18 macos: NFC, not NFKC -- compatibility characters are left alone', () => {
    // U+FB01 (fi ligature, Ll) and U+2460 (circled 1, No) only change under
    // NFKC; both are in the bare class, so they come out exactly as given.
    expectFormat(['/a\uFB01b'], MAC_ZSH, '/a\uFB01b');
    expectFormat(['/a\u2460'], MAC_ZSH, '/a\u2460');
  });

  test('DPS-FD-19 windows and linux never normalize (byte-exact file systems)', () => {
    const nfd = `${HANGUL_NFD}\\cafe\u0301`;
    expectFormat([`C:\\${nfd}`], WIN_CMD, `C:\\${nfd}`);
    expectFormat([`C:\\${nfd}`], WIN_PS, `C:\\${nfd}`);
    // Amended after review 2026-10-09: mixed C:/... paths for Git Bash (see DPS-TP-04).
    expectFormat([`C:\\${nfd}`], WIN_GITBASH, `C:/${HANGUL_NFD}/cafe\u0301`);
    expectFormat([`C:\\${nfd}`], WIN_WSL, `/mnt/c/${HANGUL_NFD}/cafe\u0301`);
    expectFormat([`/home/me/${HANGUL_NFD}`], LINUX_BASH, `/home/me/${HANGUL_NFD}`);
    expectFormat([`/home/me/${HANGUL_NFD} x`], LINUX_FISH, `'/home/me/${HANGUL_NFD} x'`);
  });

  test('DPS-FD-20 a null or missing list yields empty text without throwing', () => {
    // AMBIGUOUS: the spec only describes an array. Tauri's payload carries
    // `paths: null` on drag-over, so a careless caller could pass it on.
    for (const paths of [null, undefined]) {
      const got = dp.formatDroppedPaths(paths, WIN_CMD);
      assert.equal(got.text, '', `formatDroppedPaths(${show(paths)}).text`);
      assert.ok(Array.isArray(got.skipped), `formatDroppedPaths(${show(paths)}).skipped is an array`);
    }
  });

  test('DPS-FD-21 the input array is not mutated', () => {
    const paths = ['/Users/me/a b', `/Users/me/${HANGUL_NFD}`, '/bad\n'];
    const copy = paths.slice();
    dp.formatDroppedPaths(paths, MAC_ZSH);
    assert.deepEqual(paths, copy);
  });
});

// ---------------------------------------------------------------------------
// dropPointToClient
// ---------------------------------------------------------------------------

const near = (a, b) => Math.abs(a - b) < 1e-9;

function expectPoint(position, opts, want) {
  const label = `dropPointToClient(${show(position)}, ${show(opts)})`;
  const got = dp.dropPointToClient(position, opts);
  assert.ok(got && typeof got.x === 'number' && typeof got.y === 'number', `${label} = ${show(got)}`);
  assert.ok(near(got.x, want.x) && near(got.y, want.y), `${label} = ${show(got)}, want ${show(want)}`);
}

describe('W1 dropPaths spec: dropPointToClient', () => {
  test('DPS-DP-01 windows: physical pixels are divided by devicePixelRatio', () => {
    expectPoint({ x: 200, y: 100 }, { platform: 'windows', devicePixelRatio: 2 }, { x: 100, y: 50 });
    expectPoint({ x: 300, y: 150 }, { platform: 'windows', devicePixelRatio: 1.5 }, { x: 200, y: 100 });
    expectPoint({ x: 125, y: 250 }, { platform: 'windows', devicePixelRatio: 1.25 }, { x: 100, y: 200 });
    expectPoint({ x: 101, y: 51 }, { platform: 'windows', devicePixelRatio: 2 }, { x: 50.5, y: 25.5 });
    expectPoint({ x: 0, y: 0 }, { platform: 'windows', devicePixelRatio: 3 }, { x: 0, y: 0 });
    expectPoint({ x: 40, y: 30 }, { platform: 'windows', devicePixelRatio: 1 }, { x: 40, y: 30 });
    // Dragging over the window edge reports points outside the webview.
    expectPoint({ x: -20, y: -10 }, { platform: 'windows', devicePixelRatio: 2 }, { x: -10, y: -5 });
  });

  test('DPS-DP-02 windows: a missing, null, 0 or NaN devicePixelRatio counts as 1', () => {
    expectPoint({ x: 200, y: 100 }, { platform: 'windows' }, { x: 200, y: 100 });
    for (const devicePixelRatio of [undefined, null, 0, NaN]) {
      expectPoint({ x: 200, y: 100 }, { platform: 'windows', devicePixelRatio }, { x: 200, y: 100 });
    }
  });

  test('DPS-DP-03 macos and linux: already logical, returned unchanged whatever the ratio', () => {
    for (const platform of UNIX) {
      for (const devicePixelRatio of [1, 2, 3, 1.5, 0, NaN, undefined]) {
        expectPoint({ x: 200, y: 100 }, { platform, devicePixelRatio }, { x: 200, y: 100 });
      }
      expectPoint({ x: 12.5, y: -3 }, { platform, devicePixelRatio: 2 }, { x: 12.5, y: -3 });
    }
  });

  test('DPS-DP-04 the result is always finite, even for NaN/Infinity input', () => {
    for (const platform of ['windows', 'macos', 'linux']) {
      for (const position of [{ x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: -Infinity, y: NaN }]) {
        for (const devicePixelRatio of [2, 1, 0, NaN, Infinity, undefined]) {
          const got = dp.dropPointToClient(position, { platform, devicePixelRatio });
          assert.ok(
            got && Number.isFinite(got.x) && Number.isFinite(got.y),
            `dropPointToClient(${show(position)}, ${show({ platform, devicePixelRatio })}) = ${show(got)}`
          );
        }
      }
    }
  });

  test('DPS-DP-05 a null, undefined or empty position does not throw and is finite', () => {
    // AMBIGUOUS: the spec says "always return finite numbers" but does not say
    // what a missing position is; a drag-leave carries nothing useful.
    for (const platform of ['windows', 'macos', 'linux']) {
      for (const position of [null, undefined, {}]) {
        const got = dp.dropPointToClient(position, { platform, devicePixelRatio: 2 });
        assert.ok(
          got && Number.isFinite(got.x) && Number.isFinite(got.y),
          `dropPointToClient(${show(position)}, '${platform}') = ${show(got)}`
        );
      }
    }
  });

  test('DPS-DP-06 the payload object is not mutated', () => {
    const position = { x: 200, y: 100 };
    dp.dropPointToClient(position, { platform: 'windows', devicePixelRatio: 2 });
    assert.deepEqual(position, { x: 200, y: 100 });
  });
});

// ---------------------------------------------------------------------------
// Round trip through the real shells
// ---------------------------------------------------------------------------
//
// The quoted text is spliced into `printf '%s\0' <text>` and run by the real
// shell; what printf receives must be exactly the original paths. This is the
// one check that does not depend on anyone's reading of quoting rules. POSIX
// shells only, never on Windows; a shell that is not installed is a SKIP.

const ON_WINDOWS = process.platform === 'win32';

/** Paths a shell would mangle (or execute) if quoted wrongly. No controls: those are skipped by design. */
const CORPUS = [
  '/Users/me/plain.txt',
  '/Users/me/My File.txt',
  "/Users/me/it's",
  "'",
  "/a/''/b",
  '/a"b',
  '/a\\b',
  '/a\\',
  '/$HOME',
  '/a$(echo pwned)',
  '/a`echo pwned`',
  '/a;b',
  '/a&b',
  '/a|b',
  '/a<b>c',
  '/a*b',
  '/a?b',
  '/a[b]',
  '/a{b,c}',
  '/a#b',
  '#start',
  '/a!b',
  '!start',
  '/a^b',
  '/a%b',
  '-rf',
  '--',
  '-',
  '=cmd',
  '=',
  '~',
  '~/x',
  '~root',
  '/a~b',
  '/a=b',
  '/a,b+c:d@e',
  '/a\u00A0b',
  `/${HANGUL} ${HANGUL2}.txt`,
  `/${HANGUL}.txt`.normalize('NFD'),
  '/caf\u00E9',
  '/cafe\u0301',
  '/\u2013dash',
  '\u2014lead',
  '/\u2018smart\u2019',
  '/a b  c',
  ' leading',
  'trailing ',
  '/emoji \uD83D\uDE00',
];

/** Windows-side drops and what a posix shell must see after translation. */
const WINDOWS_DROPS = [
  {
    ctx: WIN_GITBASH,
    paths: ['C:\\Program Files\\Git', '\\\\server\\share\\a&b', "D:\\it's (1)", '\\\\?\\C:\\x$y', `C:\\Users\\${HANGUL}\\${HANGUL2} 1.txt`],
    // Amended after review 2026-10-09: mixed C:/... paths for Git Bash (see DPS-TP-04).
    want: ['C:/Program Files/Git', '//server/share/a&b', "D:/it's (1)", 'C:/x$y', `C:/Users/${HANGUL}/${HANGUL2} 1.txt`],
  },
  {
    ctx: WIN_CYGWIN,
    paths: ['C:\\a b\\c', "C:\\it's", 'C:\\a;b'],
    // Amended after review 2026-10-09: mixed C:/... paths for Cygwin (see DPS-TP-07).
    want: ['C:/a b/c', "C:/it's", 'C:/a;b'],
  },
  {
    ctx: WIN_WSL,
    paths: ['C:\\Users\\me\\My File.txt', "\\\\wsl$\\Ubuntu\\home\\me\\it's", '\\\\nas\\share\\a b', '\\\\wsl.localhost\\Ubuntu'],
    want: ['/mnt/c/Users/me/My File.txt', "/home/me/it's", '\\\\nas\\share\\a b', '/'],
  },
];

const shellCache = new Map();
function hasCommand(name) {
  if (ON_WINDOWS) return false;
  if (!shellCache.has(name)) {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', timeout: 10000 });
    shellCache.set(name, r.status === 0 && r.stdout.trim() !== '');
  }
  return shellCache.get(name);
}

function shellEnv() {
  const env = { ...process.env };
  // A non-interactive shell still sources these; keep the user's rc out of it.
  delete env.BASH_ENV;
  delete env.ENV;
  return env;
}

/**
 * Run `<printf> <words>` in `shell`; returns the arguments printf received, or
 * null when the shell rejected the line. `sep` is the separator printf writes.
 */
function argvSeenBy(shell, args, words, sep) {
  const fmt = sep === '\0' ? "'%s\\0'" : "'%s\\n'";
  const r = spawnSync(shell, [...args, '-c', `printf ${fmt} ${words}`], {
    encoding: 'utf8',
    env: shellEnv(),
    timeout: 15000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) return { argv: null, stderr: r.stderr };
  const argv = r.stdout.split(sep);
  argv.pop();
  return { argv, stderr: r.stderr };
}

/** Compare the whole line first; on a mismatch, find the first path that does not survive. */
function assertRoundTrip(shell, args, sep, quoted, originals, what) {
  const { argv, stderr } = argvSeenBy(shell, args, quoted.join(' '), sep);
  if (argv && argv.length === originals.length && argv.every((a, i) => a === originals[i])) return;
  for (const [i, q] of quoted.entries()) {
    const one = argvSeenBy(shell, args, q, sep);
    assert.deepEqual(
      one.argv,
      [originals[i]],
      `${shell}: ${what} gave ${q} for ${show(originals[i])}, which reads back as ${show(one.argv)} ${one.stderr || ''}`
    );
  }
  assert.fail(`${shell}: the joined line read back as ${show(argv)} ${stderr || ''}`);
}

const POSIX_SHELLS = [
  { name: 'sh', args: [] },
  { name: 'bash', args: [] },
  { name: 'zsh', args: ['-f'] },
  { name: 'dash', args: [] },
  { name: 'ksh', args: [] },
  { name: 'mksh', args: [] },
];

describe('W1 dropPaths spec: round trip through real shells', () => {
  for (const { name, args } of POSIX_SHELLS) {
    test(`DPS-RT-01 [${name}]: quotePath(p, 'posix') reads back as exactly p`, () => {
      if (ON_WINDOWS) skip('POSIX shell round trip does not run on Windows');
      if (!hasCommand(name)) skip(`${name} is not installed`);
      const quoted = CORPUS.map((p) => dp.quotePath(p, 'posix'));
      for (const [i, q] of quoted.entries()) {
        assert.equal(typeof q, 'string', `quotePath(${show(CORPUS[i])}, 'posix') = ${show(q)}`);
      }
      assertRoundTrip(name, args, '\0', quoted, CORPUS, "quotePath(_, 'posix')");
    });

    test(`DPS-RT-02 [${name}]: formatDroppedPaths text reads back as the (translated) paths`, () => {
      if (ON_WINDOWS) skip('POSIX shell round trip does not run on Windows');
      if (!hasCommand(name)) skip(`${name} is not installed`);
      const linux = dp.formatDroppedPaths(CORPUS, LINUX_BASH);
      assert.deepEqual(linux.skipped, [], 'nothing in the corpus is unusable');
      const { argv, stderr } = argvSeenBy(name, args, linux.text, '\0');
      assert.deepEqual(argv, CORPUS, `${name} read the formatted line differently ${stderr || ''}`);
      for (const { ctx, paths, want } of WINDOWS_DROPS) {
        const out = dp.formatDroppedPaths(paths, ctx);
        assert.deepEqual(out.skipped, [], `${ctx.shellPath}: nothing skipped`);
        const seen = argvSeenBy(name, args, out.text, '\0');
        assert.deepEqual(seen.argv, want, `${name} reading ${ctx.shellPath}'s line ${show(out.text)} ${seen.stderr || ''}`);
      }
    });
  }

  test("DPS-RT-03 [fish]: quotePath(p, 'fish') and the formatted line read back exactly", () => {
    if (ON_WINDOWS) skip('fish round trip does not run on Windows');
    if (!hasCommand('fish')) skip('fish is not installed');
    // fish >= 3.3 has --no-config; older ones reject it, then run without.
    let args = ['--no-config'];
    const probe = spawnSync('fish', [...args, '-c', 'true'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status !== 0) args = [];
    const quoted = CORPUS.map((p) => dp.quotePath(p, 'fish'));
    for (const [i, q] of quoted.entries()) {
      assert.equal(typeof q, 'string', `quotePath(${show(CORPUS[i])}, 'fish') = ${show(q)}`);
    }
    // The corpus has no newlines, and every fish has `printf '%s\n'`.
    assertRoundTrip('fish', args, '\n', quoted, CORPUS, "quotePath(_, 'fish')");
    const out = dp.formatDroppedPaths(CORPUS, LINUX_FISH);
    assert.deepEqual(out.skipped, []);
    const { argv, stderr } = argvSeenBy('fish', args, out.text, '\n');
    assert.deepEqual(argv, CORPUS, `fish read the formatted line differently ${stderr || ''}`);
  });
});
