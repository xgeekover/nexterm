/**
 * Files dropped on a terminal go in as their paths, written for that
 * terminal's shell (src/lib/dropPaths.js).
 *
 * The point of the module is that a path comes out the other end of the
 * shell as the same path. So beyond the tables — every kind of shell against
 * spaces, the characters each shell gives a meaning to, quotes straight and
 * curly, Unicode, decomposed Hangul, characters that draw nothing, control
 * characters, UNC paths, the verbatim prefix, WSL's shares, drive roots,
 * several paths at once — the POSIX quoting is put to every POSIX shell this
 * machine has: each word is handed to the shell as typed text, and the shell
 * has to print the original path back, byte for byte — non-interactively
 * (DP-30), and interactively with history expansion on, where a `!` inside
 * double quotes would run a history lookup (DP-31). cmd and PowerShell are
 * not run: the CI's Windows runner prints through a console code page that
 * would garble the Unicode cases for reasons that have nothing to do with
 * quoting.
 */
import { spawnSync } from 'node:child_process';
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import {
  SHELL_KINDS,
  dropPointToClient,
  formatDroppedPaths,
  quotePath,
  shellKindFor,
  translatePath,
} from '../../src/lib/dropPaths.js';

const PLATFORMS = ['windows', 'macos', 'linux'];

/** NFD spelling of a name — what Finder hands over for Hangul. */
const nfd = (s) => s.normalize('NFD');

/** Characters that draw nothing (Default_Ignorable_Code_Point), one of each family. */
const IGNORABLES = ['\u{3164}', '\u{115F}', '\u{1160}', '\u{FFA0}', '\u{200B}', '\u{200D}', '\u{202E}', '\u{2066}', '\u{2060}', '\u{FEFF}', '\u{AD}'];

describe('Which shell a terminal runs, for writing paths to it', () => {
  test('DP-01: the shells NexTerm finds or is told about, by full path, per platform', () => {
    const cases = [
      // [shellPath, windows, macos/linux]
      ['C:\\Windows\\System32\\cmd.exe', 'cmd', 'posix'],
      ['cmd', 'cmd', 'posix'],
      ['CMD.EXE', 'cmd', 'posix'],
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell', 'powershell'],
      ['powershell.exe', 'powershell', 'powershell'],
      ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell', 'powershell'],
      ['C:\\Program Files\\PowerShell\\7-preview\\pwsh-preview.exe', 'powershell', 'powershell'],
      ['/usr/local/bin/pwsh', 'powershell', 'powershell'],
      ['pwsh', 'powershell', 'powershell'],
      ['C:\\Windows\\System32\\wsl.exe', 'wsl', 'posix'],
      ['wsl', 'wsl', 'posix'],
      ['git-bash', 'msys', 'posix'],
      ['C:\\Program Files\\Git\\bin\\bash.exe', 'msys', 'posix'],
      ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'msys', 'posix'],
      ['C:\\msys64\\usr\\bin\\zsh.exe', 'msys', 'posix'],
      ['C:\\msys64\\usr\\bin\\fish.exe', 'msys', 'fish'],
      ['C:\\cygwin64\\bin\\bash.exe', 'cygwin', 'posix'],
      ['D:\\Tools\\Cygwin\\bin\\dash.exe', 'cygwin', 'posix'],
      ['C:\\Windows\\System32\\bash.exe', 'wsl', 'posix'],
      ['C:\\WINDOWS\\SYSNATIVE\\BASH.EXE', 'wsl', 'posix'],
      ['C:/Windows/System32/bash.exe', 'wsl', 'posix'],
      ['/bin/zsh', 'msys', 'posix'],
      ['/bin/bash', 'msys', 'posix'],
      ['/bin/ksh', 'msys', 'posix'],
      ['/bin/mksh', 'msys', 'posix'],
      ['/bin/dash', 'msys', 'posix'],
      ['/opt/homebrew/bin/fish', 'msys', 'fish'],
      ['fish', 'msys', 'fish'],
      ['"C:\\Program Files\\Git\\bin\\bash.exe"', 'msys', 'posix'],
    ];
    for (const [shell, onWindows, elsewhere] of cases) {
      assert.equal(shellKindFor(shell, 'windows'), onWindows, `${shell} on windows`);
      assert.equal(shellKindFor(shell, 'macos'), elsewhere, `${shell} on macos`);
      assert.equal(shellKindFor(shell, 'linux'), elsewhere, `${shell} on linux`);
    }
  });

  test("DP-02: no shell, \"default\" or the login shell is the platform's default", () => {
    for (const none of [undefined, null, '', '   ', 'default', 'Default', 'login-shell', 42, {}, []]) {
      assert.equal(shellKindFor(none, 'windows'), 'cmd', `${JSON.stringify(none)} on windows`);
      assert.equal(shellKindFor(none, 'macos'), 'posix', `${JSON.stringify(none)} on macos`);
      assert.equal(shellKindFor(none, 'linux'), 'posix', `${JSON.stringify(none)} on linux`);
    }
    assert.equal(shellKindFor('cmd', undefined), 'posix', 'an unknown platform is not Windows');
  });

  test('DP-03: bash in System32 or Sysnative — or bash with no directory, which Windows finds there first — is the WSL launcher', () => {
    assert.equal(shellKindFor('C:\\Windows\\System32\\zsh.exe', 'windows'), 'msys', 'only bash is the launcher');
    assert.equal(shellKindFor('C:\\Windows\\System32\\tools\\bash.exe', 'windows'), 'msys');
    assert.equal(shellKindFor('C:\\NotWindows\\System32\\bash.exe', 'windows'), 'msys');
    assert.equal(shellKindFor('\\\\?\\C:\\Windows\\System32\\bash.exe', 'windows'), 'wsl');
    for (const bare of ['bash', 'bash.exe', 'BASH.EXE', '"bash"']) {
      assert.equal(shellKindFor(bare, 'windows'), 'wsl', `${bare}: handed on unresolved, System32 comes before PATH`);
    }
    for (const bare of ['sh', 'zsh.exe', 'dash', 'ksh', 'mksh', 'fish.exe']) {
      assert.equal(shellKindFor(bare, 'windows'), 'msys', `${bare}: Windows ships no such launcher`);
    }
    assert.equal(shellKindFor('bash', 'linux'), 'posix');
  });

  test("DP-04: a WSL distro's own launcher is WSL — on Windows; elsewhere the name means nothing", () => {
    const launchers = [
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\ubuntu.exe',
      'ubuntu',
      'Ubuntu2204.exe',
      'ubuntu22.04',
      'ubuntu18.04.exe',
      'debian.exe',
      'kali',
      'opensuse-leap-15.5.exe',
      'openSUSE-Tumbleweed',
      'sles-15',
      'oraclelinux_9_1.exe',
      'almalinux9',
      'fedoraremix.exe',
      'archlinux',
      'alpine',
      'pengwin.exe',
    ];
    for (const launcher of launchers) {
      assert.equal(shellKindFor(launcher, 'windows'), 'wsl', launcher);
      assert.equal(shellKindFor(launcher, 'linux'), 'unknown', `${launcher} on linux`);
    }
    for (const notOne of ['ubuntux', 'ubuntu-tools.exe', 'debian2', 'opensuse', 'sles', 'alpine-shell']) {
      assert.equal(shellKindFor(notOne, 'windows'), 'unknown', notOne);
    }
  });

  test('DP-05a: the less common POSIX shells are POSIX, not unknown', () => {
    for (const shell of ['/bin/ash', '/usr/bin/yash', '/usr/bin/oksh', '/usr/bin/loksh', '/usr/bin/posh', '/bin/rbash', '/bin/ksh93']) {
      assert.equal(shellKindFor(shell, 'linux'), 'posix', shell);
      assert.equal(shellKindFor(shell, 'macos'), 'posix', shell);
    }
    assert.equal(shellKindFor('C:\\msys64\\usr\\bin\\ash.exe', 'windows'), 'msys');
  });

  test('DP-05: any other name is "unknown" — on every platform — tcsh and csh included', () => {
    const unknown = [
      'C:\\tools\\nu.exe',
      'C:\\cygwin64\\bin\\tcsh.exe',
      'C:\\tools\\busybox.exe',
      'elvish',
      '/usr/bin/xonsh',
      '/bin/tcsh',
      '/bin/csh',
      '/usr/bin/env',
      'C:\\Python312\\python.exe',
    ];
    for (const shell of unknown) {
      for (const platform of PLATFORMS) assert.equal(shellKindFor(shell, platform), 'unknown', `${shell} on ${platform}`);
    }
  });

  test('DP-06: whatever it is handed, the answer is one of the eight kinds', () => {
    assert.deepEqual([...SHELL_KINDS].sort(), ['cmd', 'cygwin', 'fish', 'msys', 'posix', 'powershell', 'unknown', 'wsl']);
    const odd = ['\\', '/', '.exe', 'C:\\', '\\\\server\\share\\bash.exe', '...', 'cmd.exe.exe', '\u{0}', 'bash\n'];
    for (const shell of odd) {
      for (const platform of [...PLATFORMS, undefined, 'plan9']) {
        assert.ok(SHELL_KINDS.includes(shellKindFor(shell, platform)), `${JSON.stringify(shell)} on ${platform}`);
      }
    }
    for (const empty of ['\\', '/', '.exe']) {
      assert.equal(shellKindFor(empty, 'windows'), 'cmd', `${empty}: no name at all is the default`);
    }
  });
});

describe('A path, as each shell has to see it', () => {
  test('DP-07: the verbatim prefix comes off for every Windows shell and an unknown one, a drive path and a UNC one alike', () => {
    const cases = {
      cmd: ['C:\\very\\long', '\\\\server\\share\\x'],
      powershell: ['C:\\very\\long', '\\\\server\\share\\x'],
      msys: ['C:/very/long', '//server/share/x'],
      cygwin: ['C:/very/long', '//server/share/x'],
      wsl: ['/mnt/c/very/long', '\\\\server\\share\\x'],
      unknown: ['C:\\very\\long', '\\\\server\\share\\x'],
    };
    for (const [kind, [drive, unc]] of Object.entries(cases)) {
      assert.equal(translatePath('\\\\?\\C:\\very\\long', kind), drive, `${kind}: drive`);
      assert.equal(translatePath('\\\\?\\UNC\\server\\share\\x', kind), unc, `${kind}: UNC`);
      assert.equal(translatePath('\\\\?\\unc\\server\\share\\x', kind), unc, `${kind}: unc in lower case`);
    }
    // A verbatim path to anything but a drive or a share is not the same path without it.
    assert.equal(translatePath('\\\\?\\Volume{0a1b}\\x', 'cmd'), '\\\\?\\Volume{0a1b}\\x');
  });

  test('DP-08: cmd and PowerShell get backslashes in a Windows path, and anything else as it was', () => {
    for (const kind of ['cmd', 'powershell']) {
      assert.equal(translatePath('C:/Users/me/a.txt', kind), 'C:\\Users\\me\\a.txt');
      assert.equal(translatePath('C:\\Users/me\\a.txt', kind), 'C:\\Users\\me\\a.txt');
      assert.equal(translatePath('//server/share/a', kind), '\\\\server\\share\\a');
      assert.equal(translatePath('C:\\', kind), 'C:\\');
      assert.equal(translatePath('/usr/local/bin', kind), '/usr/local/bin', 'not a Windows path');
      assert.equal(translatePath('relative/a', kind), 'relative/a');
    }
  });

  test('DP-09: Git Bash, MSYS2 and Cygwin get C:/a/b — what their shells and the native programs run there both open', () => {
    for (const kind of ['msys', 'cygwin']) {
      assert.equal(translatePath('C:\\Users\\me\\a b.txt', kind), 'C:/Users/me/a b.txt', kind);
      assert.equal(translatePath('D:/proj/src', kind), 'D:/proj/src', kind);
      assert.equal(translatePath('E:\\', kind), 'E:/', `${kind}: a drive root`);
      assert.equal(translatePath('z:\\x', kind), 'z:/x', `${kind}: the drive letter as given`);
      assert.equal(translatePath('C:', kind), 'C:', `${kind}: drive-relative, left as it came`);
      assert.equal(translatePath('C:foo', kind), 'C:foo', kind);
      assert.equal(translatePath('/home/me/x', kind), '/home/me/x', `${kind}: a POSIX path is left alone`);
      assert.equal(translatePath('\\\\server\\share\\a\\b', kind), '//server/share/a/b');
      assert.equal(translatePath('\\\\server\\share', kind), '//server/share');
    }
  });

  test('DP-10: WSL mounts a drive at /mnt/c, drive letter lower-cased', () => {
    assert.equal(translatePath('C:\\Users\\me\\a b.txt', 'wsl'), '/mnt/c/Users/me/a b.txt');
    assert.equal(translatePath('D:/proj/src', 'wsl'), '/mnt/d/proj/src');
    assert.equal(translatePath('E:\\', 'wsl'), '/mnt/e/');
    assert.equal(translatePath('/home/me/x', 'wsl'), '/home/me/x');
  });

  test("DP-11: a path into a WSL distro is that distro's own path; any other share is left for quoting", () => {
    assert.equal(translatePath('\\\\wsl$\\Ubuntu\\home\\me\\a.txt', 'wsl'), '/home/me/a.txt');
    assert.equal(translatePath('\\\\wsl.localhost\\Ubuntu-22.04\\etc\\hosts', 'wsl'), '/etc/hosts');
    assert.equal(translatePath('\\\\WSL.LOCALHOST\\Debian\\a', 'wsl'), '/a', 'the host is case-insensitive');
    assert.equal(translatePath('\\\\WSL$\\Debian\\a', 'wsl'), '/a');
    assert.equal(translatePath('//wsl$/Ubuntu/srv', 'wsl'), '/srv');
    assert.equal(translatePath('\\\\wsl$\\Ubuntu', 'wsl'), '/', 'the distro itself is its root');
    assert.equal(translatePath('\\\\wsl$\\Ubuntu\\', 'wsl'), '/');
    assert.equal(translatePath('\\\\?\\UNC\\wsl$\\Ubuntu\\home', 'wsl'), '/home');
    assert.equal(translatePath('\\\\server\\share\\a', 'wsl'), '\\\\server\\share\\a', 'WSL cannot address another share');
    assert.equal(translatePath('\\\\wsl$', 'wsl'), '\\\\wsl$', 'no distro named');
    // Elsewhere, the WSL share is a share like any other.
    assert.equal(translatePath('\\\\wsl$\\Ubuntu\\home', 'msys'), '//wsl$/Ubuntu/home');
    assert.equal(translatePath('\\\\wsl$\\Ubuntu\\home', 'cmd'), '\\\\wsl$\\Ubuntu\\home');
  });

  test('DP-12: POSIX shells and fish get every path unchanged — a Windows path included; an unknown one loses only the prefix', () => {
    for (const kind of ['posix', 'fish']) {
      for (const p of ['/Users/me/a b', 'C:\\Users\\me', '\\\\?\\C:\\x', '\\\\wsl$\\Ubuntu\\a', 'rel']) {
        assert.equal(translatePath(p, kind), p, `${kind}: ${p}`);
      }
    }
    assert.equal(translatePath('C:/a/b', 'unknown'), 'C:/a/b', 'no separator is turned');
    assert.equal(translatePath('/a/b', 'unknown'), '/a/b');
    assert.equal(translatePath('C:\\x', 'no-such-kind'), 'C:\\x');
    assert.equal(translatePath(null, 'cmd'), '');
    assert.equal(translatePath(42, 'posix'), '');
  });
});

describe('A path as one word of each shell', () => {
  test('DP-13: cmd — bare when it can be, double quotes for whitespace, % and every character cmd /? names', () => {
    assert.equal(quotePath('C:\\Users\\me\\a.txt', 'cmd'), 'C:\\Users\\me\\a.txt');
    assert.equal(quotePath('C:\\Users\\me\\문서\\파일.txt', 'cmd'), 'C:\\Users\\me\\문서\\파일.txt', 'letters of any script');
    assert.equal(quotePath('\\\\server\\share\\a-b_c.d', 'cmd'), '\\\\server\\share\\a-b_c.d');
    assert.equal(quotePath('C:\\Program Files\\x', 'cmd'), '"C:\\Program Files\\x"');
    for (const ch of [...'&()[]{}^=;!\'+,`~<>|%']) {
      assert.equal(quotePath(`C:\\a${ch}b`, 'cmd'), `"C:\\a${ch}b"`, `${ch} needs quotes`);
    }
    assert.equal(
      quotePath('C:\\x\\%ProgramFiles%.txt', 'cmd'),
      '"C:\\x\\%ProgramFiles%.txt"',
      'what %VAR% expands to stays one word'
    );
    for (const space of ['\u{A0}', '\u{3000}', '\u{2003}']) {
      assert.equal(quotePath(`C:\\a${space}b`, 'cmd'), `"C:\\a${space}b"`, `U+${space.codePointAt(0).toString(16)}`);
    }
    for (const plain of ['$', '@', '#', '.', '-', '_', '*', '?']) {
      assert.equal(quotePath(`C:\\a${plain}b`, 'cmd'), `C:\\a${plain}b`, `${plain} means nothing to cmd's parser`);
    }
  });

  test('DP-14: cmd cannot quote a double quote — such a path is refused, not mangled', () => {
    assert.equal(quotePath('C:\\a"b', 'cmd'), null);
    assert.equal(quotePath('"', 'cmd'), null);
    assert.equal(quotePath('C:\\a b"', 'cmd'), null);
  });

  test('DP-15: cmd — a backslash just before the closing quote is doubled, so no program reads \\" as a quote', () => {
    assert.equal(quotePath('\\\\?\\Volume{0a1b}\\', 'cmd'), '"\\\\?\\Volume{0a1b}\\\\"');
    assert.equal(quotePath('C:\\My Dir\\', 'cmd'), '"C:\\My Dir\\\\"');
    assert.equal(quotePath('C:\\My Dir\\\\', 'cmd'), '"C:\\My Dir\\\\\\\\"', 'every one of them');
    assert.equal(quotePath('C:\\', 'cmd'), 'C:\\', 'bare: no closing quote to protect');
    assert.equal(quotePath('C:\\a b\\c', 'cmd'), '"C:\\a b\\c"', 'only at the end');
  });

  test('DP-16: PowerShell — bare for letters, digits and path punctuation; single quotes for the rest', () => {
    assert.equal(quotePath('C:\\Users\\me\\a.txt', 'powershell'), 'C:\\Users\\me\\a.txt');
    assert.equal(quotePath('C:\\a-b_c.d\\x:y', 'powershell'), 'C:\\a-b_c.d\\x:y');
    assert.equal(quotePath('/home/me/x', 'powershell'), '/home/me/x');
    assert.equal(quotePath('C:\\사진\\é', 'powershell'), 'C:\\사진\\é');
    assert.equal(quotePath(`C:\\${nfd('한')}`, 'powershell'), `C:\\${nfd('한')}`, 'combining marks are letters too');
    for (const ch of [...' $`@#{}(),;&|<>"%!+=~[]*?']) {
      const p = `C:\\a${ch}b`;
      assert.equal(quotePath(p, 'powershell'), `'${p}'`, `${JSON.stringify(ch)} needs quotes`);
    }
  });

  test('DP-17: PowerShell — a leading dash of any kind would be a parameter, and is quoted', () => {
    assert.equal(quotePath('-x', 'powershell'), "'-x'");
    assert.equal(quotePath('\u{2013}x', 'powershell'), "'\u{2013}x'");
    assert.equal(quotePath('\u{2014}x', 'powershell'), "'\u{2014}x'");
    assert.equal(quotePath('\u{2015}x', 'powershell'), "'\u{2015}x'");
    assert.equal(quotePath('a-x', 'powershell'), 'a-x', 'a dash inside is fine');
  });

  test('DP-18: PowerShell — a name with a single quote goes in double quotes, when nothing in it expands there', () => {
    assert.equal(quotePath("C:\\it's", 'powershell'), '"C:\\it\'s"');
    for (const q of ["'", '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}']) {
      assert.equal(quotePath(`C:\\a ${q}b`, 'powershell'), `"C:\\a ${q}b"`, `U+${q.codePointAt(0).toString(16)}`);
    }
    assert.equal(quotePath("-it's", 'powershell'), '"-it\'s"', 'a quoted string is no parameter');
    // Any of these inside double quotes would expand, escape or end the string.
    for (const unsafe of ['$', '`', '"', '\u{201C}', '\u{201D}', '\u{201E}']) {
      const p = `C:\\it's${unsafe}x`;
      assert.equal(quotePath(p, 'powershell'), `'C:\\it''s${unsafe}x'`, `${JSON.stringify(unsafe)}: single quotes, doubled`);
    }
  });

  test('DP-19: PowerShell — in single quotes, every one of its five single quotes is doubled', () => {
    for (const q of ["'", '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}']) {
      assert.equal(quotePath(`C:\\$a${q}b`, 'powershell'), `'C:\\$a${q}${q}b'`, `U+${q.codePointAt(0).toString(16)}`);
    }
    assert.equal(
      quotePath("C:\\$'\u{2018}x\u{2019}'", 'powershell'),
      "'C:\\$''\u{2018}\u{2018}x\u{2019}\u{2019}'''",
      'several, and at the ends'
    );
    assert.equal(quotePath('C:\\a"b', 'powershell'), "'C:\\a\"b'", 'a double quote is plain inside single quotes');
    assert.equal(quotePath('C:\\$env:x `n', 'powershell'), "'C:\\$env:x `n'", 'no expansion, no escapes');
  });

  test('DP-20: POSIX — bare for letters, digits and harmless punctuation; anything else single-quoted', () => {
    assert.equal(quotePath('/usr/local/bin/x', 'posix'), '/usr/local/bin/x');
    assert.equal(quotePath('/a/b+c,d:e@f%g=h-i_j.k', 'posix'), '/a/b+c,d:e@f%g=h-i_j.k');
    assert.equal(quotePath('/Users/me/한글/파일.txt', 'posix'), '/Users/me/한글/파일.txt');
    assert.equal(quotePath(nfd('/Users/me/한글'), 'posix'), nfd('/Users/me/한글'));
    for (const ch of [...' $`*?[]{}()!&;|<>#"\\~^']) {
      const p = `/a${ch}b`;
      assert.equal(quotePath(p, 'posix'), `'${p}'`, `${JSON.stringify(ch)} needs quotes`);
    }
    assert.equal(quotePath('/a\u{A0}b', 'posix'), "'/a\u{A0}b'", 'a no-break space is not a letter');
    assert.equal(quotePath('/emoji 😀', 'posix'), "'/emoji 😀'");
  });

  test('DP-21: POSIX — a word may not start with -, = or ~ unquoted', () => {
    assert.equal(quotePath('-rf', 'posix'), "'-rf'");
    assert.equal(quotePath('=ls', 'posix'), "'=ls'", "zsh's =command");
    assert.equal(quotePath('~root', 'posix'), "'~root'");
    assert.equal(quotePath('a-b=c', 'posix'), 'a-b=c', 'inside a word they are plain');
  });

  test('DP-22: POSIX — a name with an apostrophe goes in double quotes, when nothing in it expands there', () => {
    assert.equal(quotePath("/it's", 'posix'), '"/it\'s"');
    assert.equal(quotePath("'", 'posix'), '"\'"');
    assert.equal(quotePath("/a''b c*", 'posix'), '"/a\'\'b c*"', 'glob characters are plain in double quotes');
    assert.equal(quotePath("-it's", 'posix'), '"-it\'s"');
    assert.equal(quotePath("~it's", 'posix'), '"~it\'s"', 'no tilde expansion in quotes');
    for (const unsafe of ['$', '`', '"', '\\', '!']) {
      const p = `/it's${unsafe}x`;
      assert.equal(quotePath(p, 'posix'), `'/it'\\''s${unsafe}x'`, `${JSON.stringify(unsafe)}: single quotes`);
    }
  });

  test("DP-23: POSIX — in single quotes, a single quote is closed, escaped and reopened", () => {
    assert.equal(quotePath("/it's$x", 'posix'), "'/it'\\''s$x'");
    assert.equal(quotePath("'!", 'posix'), "''\\''!'");
    assert.equal(quotePath("/a''b$", 'posix'), "'/a'\\'''\\''b$'");
    assert.equal(quotePath('/a\\b', 'posix'), "'/a\\b'", 'a backslash is plain inside single quotes');
  });

  test('DP-24: msys, cygwin and wsl quote as POSIX does, once translated', () => {
    for (const kind of ['msys', 'cygwin', 'wsl']) {
      assert.equal(quotePath('/c/a b', kind), quotePath('/c/a b', 'posix'), kind);
      assert.equal(quotePath('C:/a b', kind), "'C:/a b'", kind);
      assert.equal(quotePath("/c/it's", kind), '"/c/it\'s"', kind);
      assert.equal(quotePath("/c/it's$", kind), "'/c/it'\\''s$'", kind);
      assert.equal(quotePath('-x', kind), "'-x'", kind);
      assert.equal(quotePath('C:/plain', kind), 'C:/plain', kind);
    }
  });

  test("DP-25: fish — the same bare rule and the same double quotes; inside its single quotes \\ and ' are escaped", () => {
    assert.equal(quotePath('/usr/local/bin/x', 'fish'), '/usr/local/bin/x');
    assert.equal(quotePath('/a b', 'fish'), "'/a b'");
    assert.equal(quotePath("/it's", 'fish'), '"/it\'s"');
    assert.equal(quotePath('/a\\b', 'fish'), "'/a\\\\b'");
    assert.equal(quotePath("/a\\'b", 'fish'), "'/a\\\\\\'b'", 'a backslash: single quotes, the backslash first, then the quote');
    assert.equal(quotePath("/it's$x", 'fish'), "'/it\\'s$x'");
    assert.equal(quotePath('-x', 'fish'), "'-x'");
    assert.equal(quotePath('~x', 'fish'), "'~x'");
  });

  test('DP-26: a character that draws nothing is never left bare — quoted wherever a shell can quote, refused where it cannot', () => {
    for (const ch of IGNORABLES) {
      const label = `U+${ch.codePointAt(0).toString(16)}`;
      assert.equal(quotePath(`C:\\a${ch}b`, 'cmd'), `"C:\\a${ch}b"`, `cmd ${label}`);
      assert.equal(quotePath(`C:\\a${ch}b`, 'powershell'), `'C:\\a${ch}b'`, `powershell ${label}`);
      assert.equal(quotePath(`/a${ch}b`, 'posix'), `'/a${ch}b'`, `posix ${label}`);
      assert.equal(quotePath(`/a${ch}b`, 'fish'), `'/a${ch}b'`, `fish ${label}`);
      assert.equal(quotePath(`C:\\a${ch}b`, 'unknown'), null, `unknown ${label}`);
    }
    assert.equal(quotePath('/a\u{3164}', 'posix'), "'/a\u{3164}'", 'a Hangul filler is a letter to Unicode, and still quoted');
  });

  test('DP-27: a shell of unknown syntax gets a path only when it needs no quoting anywhere', () => {
    for (const bare of ['C:\\Users\\me\\a.txt', '/home/me/a-b_c.d', 'C:/x/y', '\\\\server\\share\\x', 'C:\\사진\\é']) {
      assert.equal(quotePath(bare, 'unknown'), bare, bare);
    }
    for (const refused of ['C:\\a b', "C:\\it's", 'C:\\a`touch x`', 'C:\\$(id)', '/a!b', '-rf', 'C:\\a%b', '/a~b']) {
      assert.equal(quotePath(refused, 'unknown'), null, refused);
    }
    const drop = ['C:\\Users\\me\\Downloads\\invoice `touch PWN`.pdf', 'C:\\Users\\me\\ok.pdf'];
    const out = formatDroppedPaths(drop, { shellPath: 'C:\\tools\\busybox.exe', platform: 'windows' });
    assert.deepEqual(out, { text: 'C:\\Users\\me\\ok.pdf', skipped: [drop[0]] }, 'never quoted in a syntax nobody knows');
    // A backslash outside a Windows path is part of a name; tcsh and dash read
    // it as an escape, and `/x/a\b` bare opened `/x/ab` (review, 2026-10-09).
    for (const named of ['/x/a\\b', '/x/a\\', '//x/a\\b']) assert.equal(quotePath(named, 'unknown'), null, named);
    for (const winPath of ['C:\\a\\b', 'c:\\', '\\\\server\\share\\x']) assert.equal(quotePath(winPath, 'unknown'), winPath, winPath);
    const tcsh = formatDroppedPaths(['/tmp/a!b', '/tmp/ok'], { shellPath: '/bin/tcsh', platform: 'linux' });
    assert.deepEqual(tcsh, { text: '/tmp/ok', skipped: ['/tmp/a!b'] }, 'tcsh expands ! even inside single quotes');
  });

  test('DP-28: a control character cannot be written safely for any shell; nor can nothing', () => {
    const controls = ['\u{0}', '\u{1}', '\t', '\n', '\r', '\u{1B}', '\u{1F}', '\u{7F}', '\u{80}', '\u{85}', '\u{9B}', '\u{9F}'];
    for (const kind of SHELL_KINDS) {
      for (const c of controls) {
        assert.equal(quotePath(`/a${c}b`, kind), null, `${kind}: U+${c.codePointAt(0).toString(16)}`);
      }
      assert.equal(quotePath('', kind), null, `${kind}: empty`);
      assert.equal(quotePath(null, kind), null, `${kind}: null`);
      assert.equal(quotePath(42, kind), null, `${kind}: a number`);
    }
    // Just past each range is a plain character.
    assert.equal(quotePath('/a\u{A0}b', 'cmd'), '"/a\u{A0}b"');
    assert.equal(quotePath('/a b', 'cmd'), '"/a b"', 'U+0020 is whitespace, not a control');
  });

  test('DP-29: nothing a shell is handed ends in a space it did not have', () => {
    const paths = ['C:\\a', 'C:\\a b', '/x', "/it's", 'C:\\$x', '-x', '/trailing ', '\\\\server\\share'];
    for (const kind of SHELL_KINDS) {
      for (const p of paths) {
        const word = quotePath(p, kind);
        if (word === null) continue;
        assert.ok(!/\s$/u.test(word), `${kind}: ${JSON.stringify(p)} -> ${JSON.stringify(word)}`);
        assert.ok(!/^\s/u.test(word), `${kind}: ${JSON.stringify(p)} -> ${JSON.stringify(word)}`);
      }
    }
  });
});

describe('What a drop pastes', () => {
  test('DP-40: several paths join with one space, none before, none after', () => {
    const out = formatDroppedPaths(['/a', '/b c', "/d'e"], { shellPath: '/bin/zsh', platform: 'macos' });
    assert.deepEqual(out, { text: '/a \'/b c\' "/d\'e"', skipped: [] });
    const one = formatDroppedPaths(['C:\\x'], { shellPath: 'C:\\Windows\\System32\\cmd.exe', platform: 'windows' });
    assert.deepEqual(one, { text: 'C:\\x', skipped: [] });
  });

  test('DP-41: the same drop from Windows Explorer, written for each shell a Windows tab can run', () => {
    const drop = ['C:\\Users\\me\\My Docs\\report.pdf', 'D:\\proj\\src', '\\\\?\\C:\\deep\\x.txt', 'E:\\'];
    const wsl = "'/mnt/c/Users/me/My Docs/report.pdf' /mnt/d/proj/src /mnt/c/deep/x.txt /mnt/e/";
    const expected = {
      'C:\\Windows\\System32\\cmd.exe': '"C:\\Users\\me\\My Docs\\report.pdf" D:\\proj\\src C:\\deep\\x.txt E:\\',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe':
        "'C:\\Users\\me\\My Docs\\report.pdf' D:\\proj\\src C:\\deep\\x.txt E:\\",
      'C:\\Program Files\\Git\\bin\\bash.exe': "'C:/Users/me/My Docs/report.pdf' D:/proj/src C:/deep/x.txt E:/",
      'C:\\cygwin64\\bin\\bash.exe': "'C:/Users/me/My Docs/report.pdf' D:/proj/src C:/deep/x.txt E:/",
      'C:\\Windows\\System32\\wsl.exe': wsl,
      'C:\\Windows\\System32\\bash.exe': wsl,
      bash: wsl,
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\ubuntu2204.exe': wsl,
      'C:\\tools\\nu.exe': 'D:\\proj\\src C:\\deep\\x.txt E:\\',
    };
    for (const [shellPath, text] of Object.entries(expected)) {
      const out = formatDroppedPaths(drop, { shellPath, platform: 'windows' });
      assert.equal(out.text, text, shellPath);
    }
    assert.deepEqual(
      formatDroppedPaths(drop, { shellPath: 'C:\\tools\\nu.exe', platform: 'windows' }).skipped,
      [drop[0]],
      'an unknown shell: the path that needs quoting is left out'
    );
  });

  test('DP-42: what cannot be written is skipped and returned as it was handed in, in order', () => {
    const weird = { not: 'a path' };
    const drop = ['/ok', '', null, 42, weird, '/new\nline', '/esc\u{1B}[31m', '/del\u{7F}', '/c1\u{85}', '/also ok'];
    const out = formatDroppedPaths(drop, { shellPath: '/bin/bash', platform: 'linux' });
    assert.equal(out.text, "/ok '/also ok'");
    assert.deepEqual(out.skipped, ['', null, 42, weird, '/new\nline', '/esc\u{1B}[31m', '/del\u{7F}', '/c1\u{85}']);
    assert.equal(out.skipped[3], weird, 'the very object, not a copy');
  });

  test('DP-43: a double quote is skipped for cmd and written for every other shell', () => {
    const drop = ['C:\\a"b', 'C:\\ok'];
    assert.deepEqual(formatDroppedPaths(drop, { shellPath: 'cmd', platform: 'windows' }), {
      text: 'C:\\ok',
      skipped: ['C:\\a"b'],
    });
    assert.deepEqual(formatDroppedPaths(drop, { shellPath: 'pwsh', platform: 'windows' }), {
      text: "'C:\\a\"b' C:\\ok",
      skipped: [],
    });
  });

  test('DP-44: nothing usable is an empty text, never a lone space', () => {
    assert.deepEqual(formatDroppedPaths([], { shellPath: 'cmd', platform: 'windows' }), { text: '', skipped: [] });
    assert.deepEqual(formatDroppedPaths(['\n'], { shellPath: 'cmd', platform: 'windows' }), { text: '', skipped: ['\n'] });
    assert.deepEqual(formatDroppedPaths(null, { shellPath: 'cmd', platform: 'windows' }), { text: '', skipped: [] });
    assert.deepEqual(formatDroppedPaths('C:\\not-a-list', { platform: 'windows' }), { text: '', skipped: [] });
    assert.deepEqual(formatDroppedPaths(['/a']), { text: '/a', skipped: [] }, 'no options: a POSIX shell');
  });

  test("DP-45: Finder's decomposed Hangul is composed on macOS — and only there", () => {
    const composed = '/Users/me/한글 파일.txt';
    const decomposed = nfd(composed);
    assert.notEqual(decomposed, composed, 'setup: NFD differs');
    const mac = formatDroppedPaths([decomposed], { shellPath: '/bin/zsh', platform: 'macos' });
    assert.equal(mac.text, `'${composed}'`);
    for (const platform of ['windows', 'linux']) {
      const out = formatDroppedPaths([decomposed], { shellPath: '/bin/bash', platform });
      assert.ok(out.text.includes(decomposed), `${platform}: byte-exact file systems keep the spelling`);
      assert.ok(!out.text.includes(composed), platform);
    }
    // A decomposed path that needs no quotes stays bare once composed.
    assert.equal(formatDroppedPaths([nfd('/한')], { platform: 'macos' }).text, '/한');
    // A syllable already composed, extended by a final jamo, is composed with it.
    assert.equal(formatDroppedPaths(['/\u{AC00}\u{11A8}'], { platform: 'macos' }).text, '/\u{AC01}');
    // What is skipped is what was handed in, not the composed spelling.
    const skipped = formatDroppedPaths([nfd('/한\n')], { platform: 'macos' }).skipped;
    assert.deepEqual(skipped, [nfd('/한\n')]);
  });

  test('DP-46: macOS composes ONLY Hangul — compatibility ideographs, the Angstrom, Kelvin and Ohm signs and Latin NFD stay as given', () => {
    // NFC would turn each of these into another character, and the file
    // spelled that way is not the one dropped (on HFS+, another one was).
    for (const ch of ['\u{F961}', '\u{F900}', '\u{FA6D}', '\u{212B}', '\u{212A}', '\u{2126}']) {
      assert.notEqual(ch.normalize('NFC'), ch, `setup: NFC changes U+${ch.codePointAt(0).toString(16)}`);
      const out = formatDroppedPaths([`/x/${ch}.txt`], { shellPath: '/bin/zsh', platform: 'macos' });
      assert.equal(out.text, `/x/${ch}.txt`, `U+${ch.codePointAt(0).toString(16)} survives`);
    }
    assert.equal(formatDroppedPaths(['/tmp/cafe\u{301}'], { platform: 'macos' }).text, '/tmp/cafe\u{301}', 'Latin NFD draws fine as it is');
    const mixed = formatDroppedPaths([`/\u{212B}/${nfd('한')}/cafe\u{301}`], { platform: 'macos' }).text;
    assert.equal(mixed, '/\u{212B}/한/cafe\u{301}', 'only the Hangul run changed');
  });

  test('DP-47: every kind × spaces, specials, quotes, Unicode — never a trailing space, always one word per path', () => {
    const shells = {
      cmd: 'cmd',
      powershell: 'pwsh',
      posix: '/bin/sh',
      fish: '/usr/bin/fish',
      msys: 'git-bash',
      cygwin: 'C:\\cygwin\\bin\\sh.exe',
      wsl: 'wsl',
    };
    const drop = ['C:\\a b', "C:\\it's", 'C:\\한글', 'C:\\x&y', '\\\\srv\\sh are\\q'];
    for (const [kind, shellPath] of Object.entries(shells)) {
      const platform = kind === 'posix' || kind === 'fish' ? 'linux' : 'windows';
      assert.equal(shellKindFor(shellPath, platform), kind, `setup: ${shellPath}`);
      const { text, skipped } = formatDroppedPaths(drop, { shellPath, platform });
      assert.deepEqual(skipped, [], kind);
      assert.ok(!/\s$/u.test(text) && !/^\s/u.test(text), `${kind}: ${JSON.stringify(text)}`);
      const words = drop.map((p) => quotePath(translatePath(p, kind), kind));
      assert.equal(text, words.join(' '), kind);
    }
  });
});

describe('The quoting, put to the shells themselves', () => {
  /** Paths chosen to break a quoting that is wrong in any of the usual ways. */
  const NASTY = [
    '/tmp/plain.txt',
    '/tmp/with space.txt',
    "/tmp/it's",
    "/tmp/''double''",
    "'",
    "/tmp/it's $HOME",
    "/tmp/it's!",
    '/tmp/$HOME and ${PATH}',
    '/tmp/`whoami`',
    '/tmp/$(id)',
    '/tmp/star*?[a-z]',
    '/tmp/{a,b}',
    '/tmp/!bang !!',
    '/tmp/semi;colon&amp|pipe',
    '/tmp/<in>out',
    '/tmp/#hash',
    '/tmp/back\\slash\\',
    "/tmp/\\'",
    '/tmp/"dq"',
    '-n',
    '-rf /',
    '=ls',
    '~root',
    'a~b',
    '/tmp/trailing space ',
    ' leading',
    '/tmp/한글 파일.txt',
    nfd('/tmp/é 한'),
    '/tmp/%s%d',
    '/tmp/emoji 😀',
    '/tmp/no-break\u{A0}space',
    '/tmp/filler\u{3164}here',
  ];

  /** Whether `shell` is on this machine. */
  const has = (shell) => !spawnSync(shell, ['-c', 'exit 0'], { encoding: 'utf8' }).error;

  test('DP-30: each POSIX shell here — and fish, if present — reads every word back as the path it was', () => {
    if (process.platform === 'win32') {
      skip("on Windows the `bash` on PATH may be WSL's launcher, which needs a distro the runner has not got");
    }
    const shells = [
      ['sh', 'posix'],
      ['bash', 'posix'],
      ['zsh', 'posix'],
      ['dash', 'posix'],
      ['ksh', 'posix'],
      ['fish', 'fish'],
    ].filter(([shell]) => has(shell));
    if (shells.length === 0) skip('no POSIX shell found');
    for (const [shell, kind] of shells) {
      const words = NASTY.map((p) => quotePath(p, kind));
      assert.ok(words.every((w) => w !== null), `${kind}: every one of these can be written`);
      const run = spawnSync(shell, ['-c', `printf '%s\\n' ${words.join(' ')}`], { encoding: 'utf8' });
      assert.equal(run.status, 0, `${shell} ran: ${run.stderr}`);
      const lines = run.stdout.split('\n').slice(0, -1);
      assert.deepEqual(lines, NASTY, `${shell} read the words back as the paths`);
    }
  });

  test('DP-31: typed at an interactive prompt with history expansion on, the double-quoted form reads back too', () => {
    if (process.platform === 'win32') skip('no interactive POSIX shell to drive on Windows');
    // Names with an apostrophe are the ones written in double quotes — and
    // the ones beside them that must not be, because something in them
    // expands there (`!` above all, in an interactive bash or zsh).
    const names = [
      "/tmp/it's",
      "/tmp/it's a b",
      "/tmp/'lead",
      "/tmp/a'b'c",
      "-it's",
      "~it's",
      "=it's",
      "/tmp/it's*?[x]",
      "/tmp/it's{a,b}",
      "/tmp/it's#x",
      "/tmp/it's^x",
      "/tmp/it's%1",
      "/tmp/it's!x",
      "/tmp/it's!!",
      "/tmp/it's$HOME",
      "/tmp/it's`id`",
      '/tmp/it\'s"q"',
      "/tmp/it's\\b",
      "/tmp/it's한글",
    ];
    const shells = [
      ['bash', ['--norc', '--noprofile', '-i'], 'set -o histexpand; set -o history'],
      ['zsh', ['-f', '-i'], 'setopt banghist'],
      ['dash', ['-i'], ''],
      ['ksh', ['-i'], ''],
    ].filter(([shell]) => has(shell));
    if (shells.length === 0) skip('no POSIX shell found');
    const doubled = names.filter((n) => quotePath(n, 'posix').startsWith('"'));
    assert.ok(doubled.length >= 10, `setup: ${doubled.length} of them are double-quoted`);
    for (const [shell, args, setup] of shells) {
      const input = `${setup}\necho warmup\n${names.map((n) => `printf '[%s]\\n' ${quotePath(n, 'posix')}`).join('\n')}\nexit\n`;
      const run = spawnSync(shell, args, {
        input,
        encoding: 'utf8',
        env: { ...process.env, HISTFILE: '/dev/null', PS1: '', ENV: '', BASH_ENV: '' },
      });
      const lines = run.stdout.split('\n').filter((l) => l.startsWith('['));
      assert.deepEqual(lines, names.map((n) => `[${n}]`), `${shell} -i: ${run.stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
    }
  });
});

describe('Where an OS drop lands, in CSS pixels', () => {
  test('DP-50: Windows reports physical pixels, so they are divided by the device pixel ratio', () => {
    assert.deepEqual(dropPointToClient({ x: 300, y: 150 }, { platform: 'windows', devicePixelRatio: 1.5 }), {
      x: 200,
      y: 100,
    });
    assert.deepEqual(dropPointToClient({ x: 401, y: 7 }, { platform: 'windows', devicePixelRatio: 2 }), {
      x: 200.5,
      y: 3.5,
    });
    assert.deepEqual(dropPointToClient({ x: 120, y: 80 }, { platform: 'windows', devicePixelRatio: 1 }), { x: 120, y: 80 });
  });

  test('DP-51: macOS and Linux report CSS pixels already — never divided, whatever the ratio', () => {
    for (const platform of ['macos', 'linux']) {
      assert.deepEqual(dropPointToClient({ x: 300, y: 150 }, { platform, devicePixelRatio: 2 }), { x: 300, y: 150 });
    }
    assert.deepEqual(dropPointToClient({ x: 300, y: 150 }, { devicePixelRatio: 2 }), { x: 300, y: 150 }, 'no platform');
  });

  test('DP-52: a ratio missing, zero, negative or not a number counts as 1', () => {
    for (const devicePixelRatio of [undefined, null, 0, -2, NaN, Infinity, '2']) {
      assert.deepEqual(
        dropPointToClient({ x: 300, y: 150 }, { platform: 'windows', devicePixelRatio }),
        { x: 300, y: 150 },
        String(devicePixelRatio)
      );
    }
    assert.deepEqual(dropPointToClient({ x: 300, y: 150 }, { platform: 'windows' }), { x: 300, y: 150 });
  });

  test('DP-53: always finite numbers, whatever the position is', () => {
    const odd = [null, undefined, {}, { x: NaN, y: Infinity }, { x: '5', y: null }, { x: -Infinity }, 42];
    for (const position of odd) {
      for (const platform of PLATFORMS) {
        const { x, y } = dropPointToClient(position, { platform, devicePixelRatio: 1.25 });
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${JSON.stringify(position)} on ${platform}`);
      }
    }
    assert.deepEqual(dropPointToClient(null, { platform: 'windows', devicePixelRatio: 2 }), { x: 0, y: 0 });
    assert.deepEqual(dropPointToClient({ x: -40, y: -10 }, { platform: 'windows', devicePixelRatio: 2 }), { x: -20, y: -5 });
  });
});
