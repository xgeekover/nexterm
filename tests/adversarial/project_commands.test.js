/**
 * Project commands, the pure core (src/lib/projectCommands.js), stage 5.
 *
 * What a repository's `.nexterm/commands.json` may say, what is refused and
 * why, how a blank's value is quoted for each shell — and, where the shells
 * are installed, that a quoted value handed through the real shell arrives
 * as one argument equal to what was typed (sh, bash, zsh, fish here and on
 * Linux CI; cmd and Windows PowerShell 5.1 / PowerShell 7 on Windows CI).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import {
  parseCommandsFile,
  renderCommand,
  quoteValue,
  blanksIn,
  displayText,
  lineProblem,
  shellLabel,
  normalizeTrust,
  trustOf,
  trusting,
  forgetting,
  LIMITS,
  TRUST_LIMIT,
  EXAMPLE_COMMANDS_FILE,
} from '../../src/lib/projectCommands.js';

const file = (commands, extra = {}) => JSON.stringify({ version: 1, commands, ...extra });
const one = (command) => parseCommandsFile(file([command]));
const reasonOf = (command) => one(command).refused[0]?.reason ?? null;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('Project commands: reading a commands file', () => {
  test('PC-01: a good file gives its commands, in order, with their blanks in the order the line uses them', () => {
    const read = parseCommandsFile(
      file([
        { name: 'Build', command: 'npm run build' },
        {
          name: 'Test one',
          description: 'One file',
          command: 'npm test -- {{file}} --reporter {{reporter}} {{file}}',
          placeholders: {
            reporter: { label: 'Reporter', choices: ['dot', 'spec'], default: 'spec' },
            file: { label: 'Test file', default: 'src/a.test.js' },
            unused: { label: 'never asked' },
          },
        },
      ])
    );
    assert.equal(read.ok, true);
    assert.deepEqual(read.refused, []);
    assert.deepEqual(read.commands.map((c) => c.name), ['Build', 'Test one']);
    assert.equal(read.commands[0].key, 'project:0');
    assert.equal(read.commands[1].source, 'project');
    assert.deepEqual(
      read.commands[1].placeholders.map((p) => [p.name, p.label, p.default, p.choices]),
      [
        ['file', 'Test file', 'src/a.test.js', null],
        ['reporter', 'Reporter', 'spec', ['dot', 'spec']],
      ],
      'used once each, in the order of the line; the one never used is not asked for'
    );
  });

  test('PC-02: what is no commands file at all is refused whole, with the reason', () => {
    const cases = [
      ['{ "version": 1, "commands": [ }', /not valid JSON/],
      ['[]', /must be an object/],
      ['null', /must be an object/],
      ['"x"', /must be an object/],
      [JSON.stringify({ commands: [] }), /no "version": 1/],
      [JSON.stringify({ version: 2, commands: [] }), /version "2"; this NexTerm reads version 1/],
      [JSON.stringify({ version: '1', commands: [] }), /version "1"; this NexTerm reads version 1/],
      [JSON.stringify({ version: 1, commands: {} }), /"commands" must be a list/],
      [JSON.stringify({ version: 1, commands: [], extra: true }), /does not know at the top: "extra"/],
      [file(Array.from({ length: LIMITS.commands + 1 }, (_, i) => ({ name: `c${i}`, command: 'x' }))), /more than 200 commands/],
    ];
    for (const [text, reason] of cases) {
      const read = parseCommandsFile(text);
      assert.equal(read.ok, false, text.slice(0, 60));
      assert.match(read.reason, reason, text.slice(0, 60));
    }
    assert.equal(parseCommandsFile(JSON.stringify({ $schema: 'x', version: 1, commands: [] })).ok, true, '$schema is allowed');
    assert.equal(parseCommandsFile(file(Array.from({ length: LIMITS.commands }, (_, i) => ({ name: `c${i}`, command: 'x' })))).commands.length, 200);
    assert.equal(parseCommandsFile(undefined).ok, false);
    assert.equal(parseCommandsFile('x'.repeat(11), { maxLength: 10 }).ok, false, 'the Settings field has a cap');
  });

  test('PC-03: a JSON error that quotes the file is shown without its control or bidi characters', () => {
    const read = parseCommandsFile('{ "version": 1, \u{202E}evil }');
    assert.equal(read.ok, false);
    assert.doesNotMatch(read.reason, /[\u{202E}\u{0}-\u{1F}]/u);
  });

  test('PC-04: nesting a hundred thousand deep is read (or refused) without overflowing anything', () => {
    const deep = `{"version":1,"commands":[{"name":"x","command":"x","placeholders":{"a":{"label":${'['.repeat(100000)}${']'.repeat(100000)}}}}]}`;
    const read = parseCommandsFile(deep);
    assert.equal(read.ok, true);
    assert.match(read.refused[0].reason, /"label" must be text/);
  });

  test('PC-05: a key NexTerm does not know refuses that command — a typo is never silent — and only that one', () => {
    const read = parseCommandsFile(
      file([
        { name: 'Typo', comand: 'rm -rf build' },
        { name: 'Fine', command: 'ls' },
        { name: 'Blank typo', command: 'x {{a}}', placeholders: { a: { defualt: 'y' } } },
      ])
    );
    assert.deepEqual(read.commands.map((c) => c.name), ['Fine']);
    assert.match(read.refused[0].reason, /does not know: "comand"/);
    assert.equal(read.refused[0].name, 'Typo');
    assert.match(read.refused[1].reason, /blank a has a key NexTerm does not know: "defualt"/);
  });

  test('PC-06: wrong types and missing fields refuse the command, saying which', () => {
    const cases = [
      [null, /not an object/],
      ['ls', /not an object/],
      [[], /not an object/],
      [{ command: 'ls' }, /"name" is missing/],
      [{ name: '   ', command: 'ls' }, /"name" is empty/],
      [{ name: 7, command: 'ls' }, /"name" is missing or not text/],
      [{ name: 'x' }, /"command" is missing/],
      [{ name: 'x', command: ['ls'] }, /"command" is missing or not text/],
      [{ name: 'x', command: '   ' }, /the command is empty/],
      [{ name: 'x', command: 'ls', description: 3 }, /"description" must be text/],
      [{ name: 'x', command: 'ls', placeholders: [] }, /"placeholders" must be an object/],
      [{ name: 'x', command: 'ls {{a}}', placeholders: { a: 'text' } }, /the blank a must be an object/],
      [{ name: 'x', command: 'ls {{a}}', placeholders: { a: { default: 3000 } } }, /"default" must be text/],
      [{ name: 'x', command: 'ls {{a}}', placeholders: { a: { choices: 'dot' } } }, /"choices" must be a list of at least one/],
      [{ name: 'x', command: 'ls {{a}}', placeholders: { a: { choices: [] } } }, /"choices" must be a list of at least one/],
      [{ name: 'x', command: 'ls {{a}}', placeholders: { a: { choices: [1] } } }, /a choice must be text/],
      [{ name: 'x', command: 'ls {{a}}', placeholders: { a: { choices: ['a'], default: 'b' } } }, /"default" is not one of its choices/],
      [{ name: 'x', command: 'ls {{a}}', placeholders: { 'a b': {} } }, /"a b" is not a blank's name/],
    ];
    for (const [entry, reason] of cases) assert.match(reasonOf(entry) ?? '(loaded)', reason, JSON.stringify(entry));
    const firstChoice = one({ name: 'x', command: 'ls {{a}}', placeholders: { a: { choices: ['dot', 'spec'] } } });
    assert.equal(firstChoice.commands[0].placeholders[0].default, 'dot', 'with choices and no default, the first choice');
  });

  test('PC-07: every limit holds at its edge and refuses past it', () => {
    const at = (n) => 'x'.repeat(n);
    assert.equal(reasonOf({ name: at(LIMITS.name), command: 'ls' }), null);
    assert.match(reasonOf({ name: at(LIMITS.name + 1), command: 'ls' }), /longer than 80/);
    assert.equal(reasonOf({ name: 'x', command: at(LIMITS.command) }), null);
    assert.match(reasonOf({ name: 'x', command: at(LIMITS.command + 1) }), /longer than 2000/);
    assert.equal(reasonOf({ name: 'x', command: 'ls', description: at(LIMITS.description) }), null);
    assert.match(reasonOf({ name: 'x', command: 'ls', description: at(LIMITS.description + 1) }), /longer than 300/);
    const blanks = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i}`, {}]));
    const line = (n) => `x ${Array.from({ length: n }, (_, i) => `{{b${i}}}`).join(' ')}`;
    assert.equal(reasonOf({ name: 'x', command: line(20), placeholders: blanks(20) }), null);
    assert.match(reasonOf({ name: 'x', command: 'x', placeholders: blanks(21) }), /more than 20 blanks/);
    assert.match(reasonOf({ name: 'x', command: line(21) }), /more than 20 blanks/, 'undeclared blanks count too');
    assert.match(reasonOf({ name: 'x', command: 'x {{a}}', placeholders: { a: { default: at(LIMITS.value + 1) } } }), /longer than 1000/);
    assert.match(reasonOf({ name: 'x', command: 'x {{a}}', placeholders: { a: { choices: Array(51).fill('a') } } }), /more than 50 choices/);
    assert.match(reasonOf({ name: 'x', command: 'x {{a}}', placeholders: { a: { label: at(LIMITS.label + 1) } } }), /"label" is longer than 80/);
    // Code points, not UTF-16 units: an emoji is one character.
    assert.equal(reasonOf({ name: '😀'.repeat(LIMITS.name), command: 'ls' }), null);
  });

  test('PC-08: names are one each, compared as shown — case, surrounding spaces and invisible characters do not make another', () => {
    const read = parseCommandsFile(
      file([
        { name: 'Deploy', command: 'deploy prod' },
        { name: ' deploy ', command: 'deploy evil' },
        { name: 'DEPLOY', command: 'deploy evil' },
        { name: 'De\u{200B}ploy', command: 'deploy evil' },
        { name: 'Deploy staging', command: 'deploy staging' },
      ])
    );
    assert.deepEqual(read.commands.map((c) => c.template), ['deploy prod', 'deploy staging']);
    assert.equal(read.refused.length, 3);
    assert.ok(read.refused.every((r) => /comes before it/.test(r.reason)));
  });

  test('PC-09: a command line that would not read as what it runs is refused, not cleaned', () => {
    const cases = [
      ['npm install\nnpm run dev', /more than one line/],
      ['npm install\r\nrm -rf ~', /more than one line/],
      ['a\u{2028}b', /more than one line/],
      ['a\u{85}b', /more than one line/],
      ['ls\tx', /a tab/],
      ['ls \u{1B}[2J', /control character \(U\+001B\)/],
      ['ls \u{7F}', /control character/],
      ['ls \u{9B}', /control character/],
      ['echo \u{202E}gnp.exe', /bidirectional control \(U\+202E\) at character 6/],
      ['echo \u{2066}x\u{2069}', /bidirectional control/],
      ['echo \u{200F}x', /bidirectional control/],
      ['r\u{200B}m -rf x', /invisible character \(U\+200B\)/],
      ['ls\u{FEFF}x', /invisible character/],
      ['ls \u{3164}x', /invisible character \(U\+3164\)/],
      ['ls\u{AD}x', /invisible character/],
    ];
    for (const [command, reason] of cases) assert.match(reasonOf({ name: 'x', command }) ?? '(loaded)', reason, JSON.stringify(command));
    // Text around the line is not part of it: a trailing newline is not a second line.
    assert.equal(one({ name: 'x', command: '  npm test\n' }).commands[0].template, 'npm test');
    // An emoji with its variation selector is text, not a hidden character.
    assert.equal(reasonOf({ name: 'x', command: 'echo ❤️' }), null);
  });

  test('PC-10: names, descriptions and labels are someone else\'s text — shown without what could disguise them', () => {
    const read = one({
      name: 'Build\u{202E}tset',
      description: 'line one\nline\u{200B} two\u{1B}[31m',
      command: 'x {{a}}',
      placeholders: { a: { label: 'File\u{2066}', description: 'd\u{0}' } },
    });
    const [c] = read.commands;
    assert.equal(c.name, 'Buildtset');
    assert.equal(c.description, 'line one line two[31m');
    assert.equal(c.placeholders[0].label, 'File');
    assert.equal(c.placeholders[0].description, 'd');
    assert.equal(displayText('x'.repeat(10), 5), 'xxxx\u{2026}');
    assert.equal(displayText(null), '');
  });
});

describe('Project commands: blanks', () => {
  test('PC-11: only {{name}} is a blank — Go, Docker and Helm templates pass through as text', () => {
    assert.deepEqual(blanksIn('docker ps --format {{.Names}} {{ x }} {{json .}} {{a}} {{_b-2}} {{9x}} {{}}').map((b) => b.name), ['a', '_b-2']);
    assert.deepEqual(blanksIn(`{{${'a'.repeat(40)}}} {{${'a'.repeat(41)}}}`).map((b) => b.name.length), [40], 'a name is at most 40');
    const c = one({ name: 'x', command: "docker ps --format '{{.Names}}' {{n}}" }).commands[0];
    assert.equal(renderCommand(c, { n: 'web' }, 'posix').line, "docker ps --format '{{.Names}}' web");
  });

  test('PC-12: a blank beside a quote or another blank refuses the command — NexTerm quotes values itself', () => {
    assert.match(reasonOf({ name: 'x', command: 'git commit -m "{{msg}}"' }), /{{msg}} has a quote right beside it/);
    assert.match(reasonOf({ name: 'x', command: "echo '{{msg}}'" }), /quote right beside/);
    assert.match(reasonOf({ name: 'x', command: 'echo `{{msg}}`' }), /quote right beside/);
    assert.match(reasonOf({ name: 'x', command: 'echo {{a}}{{b}}' }), /{{a}} and {{b}} touch/);
    assert.equal(reasonOf({ name: 'x', command: 'run --name={{a}} {{b}}x {{c}}/{{d}}' }), null, 'other neighbours are fine');
  });

  test('PC-13: values go in in one pass — a value holding {{x}} is text, never another blank', () => {
    const c = one({ name: 'x', command: 'echo {{a}} {{b}}', placeholders: { b: { default: 'B' } } }).commands[0];
    const out = renderCommand(c, { a: '{{b}}' }, 'posix');
    assert.equal(out.ok, true);
    assert.equal(out.line, "echo '{{b}}' B");
  });

  test('PC-14: an undeclared blank is a plain field; a repeated one is asked once and typed everywhere it is used', () => {
    const c = one({ name: 'x', command: 'cp {{f}} {{f}}.bak' }).commands[0];
    assert.deepEqual(c.placeholders, [{ name: 'f', label: 'f', description: '', default: '', choices: null }]);
    assert.equal(renderCommand(c, { f: 'a b' }, 'posix').line, "cp 'a b' 'a b'.bak");
  });

  test('PC-15: an empty value types nothing, so an optional argument can be left out', () => {
    const c = one({ name: 'x', command: 'npm test {{extra}}' }).commands[0];
    assert.equal(renderCommand(c, { extra: '' }, 'cmd').line, 'npm test ');
    assert.equal(renderCommand(c, {}, 'powershell').ok, true, 'a blank with no value takes its default, here empty');
  });

  test('PC-16: a value outside its choices is refused; a refused value leaves the line unusable and says why', () => {
    const c = one({ name: 'x', command: 'build {{mode}} {{v}}', placeholders: { mode: { choices: ['debug', 'release'] } } }).commands[0];
    const bad = renderCommand(c, { mode: 'evil; rm -rf ~', v: '%PATH%' }, 'cmd');
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.mode, 'pick one of its choices');
    assert.match(bad.errors.v, /cmd expands %…% even inside quotes/);
    assert.equal(bad.line, 'build {{mode}} {{v}}', 'nothing half-typed');
    const good = renderCommand(c, { mode: 'release', v: 'x' }, 'cmd');
    assert.deepEqual(good.parts, [{ text: 'build ' }, { text: 'release', blank: 'mode' }, { text: ' ' }, { text: 'x', blank: 'v' }]);
  });
});

describe('Project commands: quoting a value for each shell', () => {
  const q = (value, kind) => {
    const out = quoteValue(value, kind);
    return out.ok ? out.text : null;
  };

  test('PC-17: every shell refuses what cannot be typed as part of a value', () => {
    for (const kind of ['posix', 'fish', 'cmd', 'powershell', 'msys', 'wsl', 'unknown']) {
      for (const value of ['a\nb', 'a\rb', 'a\tb', 'a\u{1B}b', 'a\u{202E}b', 'a\u{200B}b', 'a\u{2028}b', 'a\u{3164}b']) {
        assert.equal(q(value, kind), null, `${kind} ${JSON.stringify(value)}`);
      }
      assert.equal(q('x'.repeat(LIMITS.value + 1), kind), null);
      assert.equal(q(42, kind), null);
      assert.equal(q('', kind), '', 'empty is nothing');
    }
  });

  test('PC-18: cmd — bare when nothing needs quotes, else "…" with a trailing backslash doubled; " % ! refused', () => {
    assert.equal(q('src\\app.js', 'cmd'), 'src\\app.js');
    assert.equal(q('two words', 'cmd'), '"two words"');
    assert.equal(q('a&b|c<d>e^f(g)', 'cmd'), '"a&b|c<d>e^f(g)"');
    assert.equal(q('C:\\my dir\\', 'cmd'), '"C:\\my dir\\\\"');
    assert.equal(q('C:\\dir\\', 'cmd'), 'C:\\dir\\', 'bare: no quote for the backslash to escape');
    assert.match(quoteValue('say "hi"', 'cmd').reason, /no way to put a " inside/);
    assert.match(quoteValue('%PATH%', 'cmd').reason, /expands %…%/);
    assert.match(quoteValue('100%', 'cmd').reason, /expands %…%/);
    assert.match(quoteValue('hi!', 'cmd').reason, /delayed expansion/);
    assert.equal(q('한글 경로', 'cmd'), '"한글 경로"');
  });

  test('PC-19: PowerShell — bare only for a plain word; else \'…\' with every kind of single quote doubled; double quotes refused', () => {
    assert.equal(q('release', 'powershell'), 'release');
    assert.equal(q('src/app.test.js', 'powershell'), 'src/app.test.js');
    assert.equal(q('-x', 'powershell'), "'-x'", 'an option-looking word is quoted, as is…');
    assert.equal(q('1e3', 'powershell'), "'1e3'", '…a number…');
    assert.equal(q('$env:PATH', 'powershell'), "'$env:PATH'", '…a variable…');
    assert.equal(q('@args', 'powershell'), "'@args'", '…a splat…');
    assert.equal(q('a,b', 'powershell'), "'a,b'", '…and an array');
    assert.equal(q('--%', 'powershell'), "'--%'", 'never the bare stop-parsing token');
    assert.equal(q("it's", 'powershell'), "'it''s'");
    assert.equal(q('it\u{2019}s', 'powershell'), "'it\u{2019}\u{2019}s'", 'a typographic single quote is a quote to PowerShell');
    for (const value of ['say "hi"', 'say \u{201C}hi\u{201D}', '\u{201E}x']) {
      assert.match(quoteValue(value, 'powershell').reason, /double quote|Windows hands some programs as a "/, value);
    }
    assert.match(quoteValue('C:\\my dir\\', 'powershell').reason, /ends in \\/);
    assert.equal(q('C:\\dir\\', 'powershell'), 'C:\\dir\\');
  });

  test('PC-20: POSIX shells — bare, "…" for a value with a \' and nothing to expand, else \'…\'; history, globs, tilde and = never bare', () => {
    for (const kind of ['posix', 'msys', 'cygwin']) {
      assert.equal(q('src/app.test.js', kind), 'src/app.test.js');
      assert.equal(q("it's", kind), '"it\'s"');
      assert.equal(q("it's $HOME", kind), "'it'\\''s $HOME'");
      assert.equal(q('$(whoami)', kind), "'$(whoami)'");
      assert.equal(q('hi!', kind), "'hi!'", 'never inside "…" — bash and zsh expand ! there');
      assert.equal(q("it's hi!", kind), "'it'\\''s hi!'", 'even with a quote that "…" would have avoided');
      assert.equal(q("it's `x`", kind), "'it'\\''s `x`'");
      for (const value of ['*.js', 'a?', '[ab]', '{a,b}', '~', '~/x', '=ls', '-x', '#x', 'a b', '100%', 'a\\b']) {
        assert.ok(q(value, kind).startsWith("'"), `${kind}: ${value} quoted`);
      }
    }
    assert.equal(q('C:\\dir', 'msys'), "'C:\\dir'", 'a value is not translated as a path');
  });

  test('PC-21: fish — as POSIX, but in \'…\' a backslash and a quote are escaped', () => {
    assert.equal(q('a\\b', 'fish'), "'a\\\\b'");
    assert.equal(q("it's \\x", 'fish'), "'it\\'s \\\\x'");
    assert.equal(q("it's", 'fish'), '"it\'s"');
  });

  test('PC-22: a shell NexTerm does not know is given only words that need no quoting anywhere', () => {
    assert.equal(q('src/app-1.js', 'unknown'), 'src/app-1.js');
    assert.match(quoteValue('two words', 'unknown').reason, /does not know how this shell reads quotes/);
    assert.equal(q('x', 'tcsh-or-anything'), 'x', 'any kind not in SHELL_KINDS is unknown');
    assert.equal(q('a b', 'tcsh-or-anything'), null);
  });

  test('PC-23: the shell is named the way a person knows it', () => {
    assert.equal(shellLabel('cmd', 'C:\\Windows\\System32\\cmd.exe'), 'cmd');
    assert.equal(shellLabel('powershell', 'powershell.exe'), 'PowerShell');
    assert.equal(shellLabel('powershell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'PowerShell 7');
    assert.equal(shellLabel('posix', '/bin/zsh'), 'zsh');
    assert.equal(shellLabel('msys', 'C:\\Program Files\\Git\\bin\\bash.exe'), 'Git Bash');
    assert.equal(shellLabel('wsl', 'wsl.exe'), 'WSL');
    assert.equal(shellLabel('unknown', ''), 'an unknown shell');
  });
});

/**
 * Values whose round trip through a real shell is checked: each must arrive
 * as ONE argument equal to itself — or be refused for that shell.
 */
const ROUND_TRIP_VALUES = [
  'plain', 'two words', "it's", "''", "'", 'it\u{2019}s', '$HOME', '`date`', '$(echo hi)', 'a^b', 'a&b', 'a|b', '<x>', '(x)', 'a;b',
  'C:\\dir\\', 'C:\\my dir\\', 'trailing\\', 'back\\slash', '\\\\server\\share', '한글 경로', '😀 emoji', '❤️', 'a*b', '*', '?', '[ab]',
  '~', '~/x', '-x', '--flag=value', '--%', '=x', '#x', 'x#y', '{a,b}', ' lead', 'trail ', 'a,b', '@x', '1e3', 'a=b c',
  'quote\'s "mixed"', '%PATH%', '100%', 'hi!', '', '/api/v1', 'x y\u{20A9}', '\u{FF02}q',
];

/** What each shell refuses of ROUND_TRIP_VALUES — exactly these, so a quoting that refused everything could not pass. */
const REFUSED_BY = {
  posix: [],
  fish: [],
  cmd: ['--%', 'quote\'s "mixed"', '%PATH%', '100%', 'hi!', 'x y\u{20A9}', '\u{FF02}q'],
  powershell: ['C:\\my dir\\', 'quote\'s "mixed"', 'x y\u{20A9}', '\u{FF02}q'],
  msys: ['/api/v1'],
};

/** The command each round trip runs: node, a script that appends its arguments to a file, the index, the value. */
const SCRIPT =
  'require(process.env.RT_FS).appendFileSync(process.env.RT_OUT,JSON.stringify(process.argv.slice(1))+String.fromCharCode(10))';

/**
 * Run every value of ROUND_TRIP_VALUES through `run(lines)` — a shell given
 * the lines `renderCommand` makes for `kind` — and compare what arrived.
 * Returns the mismatches as text, or null when the shell is missing.
 */
function roundTrip(kind, prefix, run) {
  const command = one({ name: 'rt', command: `${prefix}{{node}} -e {{script}} {{i}} {{v}}` }).commands[0];
  assert.ok(command, 'the round-trip command itself is a valid command');
  const dir = mkdtempSync(join(tmpdir(), 'nexterm-pc-'));
  const out = join(dir, 'out.txt');
  try {
    const expected = new Map();
    const lines = [];
    const refused = [];
    ROUND_TRIP_VALUES.forEach((value, i) => {
      const rendered = renderCommand(command, { node: process.execPath, script: SCRIPT, i: String(i), v: value }, kind);
      if (!rendered.ok) {
        assert.deepEqual(Object.keys(rendered.errors), ['v'], `${kind}: only the value may be refused (${JSON.stringify(rendered.errors)})`);
        refused.push(value);
        return;
      }
      expected.set(String(i), value);
      lines.push(rendered.line);
    });
    assert.deepEqual(refused, REFUSED_BY[kind], `${kind}: refused exactly these`);
    assert.equal(expected.size, ROUND_TRIP_VALUES.length - REFUSED_BY[kind].length);
    const ran = run(lines, { ...process.env, RT_FS: 'fs', RT_OUT: out });
    if (ran === null) return null;
    const got = new Map();
    if (existsSync(out)) {
      for (const row of readFileSync(out, 'utf8').split('\n').filter(Boolean)) {
        const [i, ...rest] = JSON.parse(row);
        got.set(i, rest);
      }
    }
    const wrong = [];
    for (const [i, value] of expected) {
      const want = value === '' ? [] : [value];
      if (JSON.stringify(got.get(i)) !== JSON.stringify(want)) {
        wrong.push(`${JSON.stringify(value)} → ${JSON.stringify(got.get(i) ?? '(nothing arrived)')}`);
      }
    }
    if (wrong.length) wrong.push(`(shell said: ${String(ran).slice(0, 400)})`);
    return wrong;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A shell found on this machine, or null. */
function found(name) {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.split(/\r?\n/u)[0].trim() : null;
}

/** Runs the lines with `shell <args> <script>`; the script is the lines, one per line. */
const posixRunner = (shell, args) => (lines, env) => {
  const r = spawnSync(shell, [...args, lines.join('\n')], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  return `${r.stderr ?? ''}${r.error ?? ''}`;
};

describe('Project commands: a quoted value through the real shell arrives as typed', () => {
  const posixShells = [
    ['sh', ['-c']],
    ['bash', ['--norc', '--noprofile', '-c']],
    ['zsh', ['-f', '-c']],
  ];
  posixShells.forEach(([name, args], n) => {
    test(`PC-${24 + n}: ${name}`, () => {
      if (process.platform === 'win32') skip('the POSIX shells are checked on macOS and Linux');
      const shell = found(name);
      if (!shell) skip(`${name} is not installed here`);
      const wrong = roundTrip('posix', '', posixRunner(shell, args));
      assert.deepEqual(wrong, [], `${name}: ${wrong.join('\n')}`);
    });
  });

  test('PC-27: fish', () => {
    if (process.platform === 'win32') skip('fish is checked on macOS and Linux');
    const shell = found('fish');
    if (!shell) skip('fish is not installed here');
    // Plain -c: --no-config is fish 3.6 and later, and a CI runner has no fish config to skip.
    const wrong = roundTrip('fish', '', posixRunner(shell, ['-c']));
    assert.deepEqual(wrong, [], wrong.join('\n'));
  });

  test('PC-28: cmd', () => {
    if (process.platform !== 'win32') skip('cmd is checked on Windows (CI)');
    // In batches: cmd's line is at most 8191 characters. `/s /c "…"` takes
    // the outer quotes off and runs the rest exactly as typed at a prompt.
    const wrong = roundTrip('cmd', '', (lines, env) => {
      let said = '';
      for (let i = 0; i < lines.length; i += 10) {
        const line = lines.slice(i, i + 10).join(' & ');
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 30000, windowsHide: true });
        said += `${r.stderr ?? ''}${r.error ?? ''}`;
      }
      return said;
    });
    assert.deepEqual(wrong, [], wrong.join('\n'));
  });

  const powershells = [
    ['PC-29', 'Windows PowerShell 5.1', 'powershell.exe'],
    ['PC-30', 'PowerShell 7', 'pwsh'],
  ];
  for (const [id, label, exe] of powershells) {
    test(`${id}: ${label}`, () => {
      if (process.platform !== 'win32') skip(`${label} is checked on Windows (CI)`);
      if (!found(exe)) skip(`${exe} is not installed here`);
      // -EncodedCommand: the script reaches PowerShell as it is, with no
      // quoting of its own in between, and no execution policy applies.
      const wrong = roundTrip('powershell', '& ', (lines, env) => {
        let said = '';
        for (let i = 0; i < lines.length; i += 15) {
          const script = lines.slice(i, i + 15).join('\n');
          const encoded = Buffer.from(script, 'utf16le').toString('base64');
          const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
          said += `${r.stderr ?? ''}${r.error ?? ''}`;
        }
        return said;
      });
      assert.deepEqual(wrong, [], wrong.join('\n'));
    });
  }
});

describe('Project commands: review round 1 (security)', () => {
  test('PC-35: every control, format, separator and default-ignorable character is refused — by property, not a list; variation selectors pass', () => {
    const variation = (cp) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
    const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
    const leaked = [];
    let checked = 0;
    for (let cp = 0; cp <= 0xe0fff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (!hidden.test(char) || variation(cp)) continue;
      checked += 1;
      const inLine = lineProblem(`echo a${char}b`) !== null;
      const inValue = !quoteValue(`a${char}b`, 'posix').ok && !quoteValue(`a${char}b`, 'cmd').ok;
      const inFile = reasonOf({ name: 'x', command: `echo a${char}b` }) !== null;
      if (!(inLine && inValue && inFile)) leaked.push(cp.toString(16));
    }
    assert.ok(checked > 4000, `the sweep looked at ${checked} characters`);
    assert.deepEqual(leaked, [], 'none of them gets through');
    for (const char of ['\u{FE0F}', '\u{E0101}']) {
      assert.equal(lineProblem(`echo a${char}`), null, `${char.codePointAt(0).toString(16)} is allowed`);
    }
    assert.match(reasonOf({ name: 'x', command: './build\u{E0062}.sh' }), /invisible character \(U\+E0062\)/, 'a tag character the browser draws as nothing');
    assert.match(reasonOf({ name: 'x', command: 'ls \u{2800}x' }), /U\+2800/, 'the braille blank');
    assert.equal(displayText('De\u{E0062}ploy'), 'Deploy', 'and names are shown, and compared, without them');
  });

  test('PC-36: a space that is not U+0020 refuses the command — it reads as a word break and is none', () => {
    for (const cp of [0xa0, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000]) {
      assert.match(reasonOf({ name: 'x', command: `./build.sh${String.fromCodePoint(cp)}--dry-run` }) ?? '(loaded)', /not a plain space/, cp.toString(16));
    }
    assert.equal(quoteValue('a\u{3000}b', 'cmd').text, '"a\u{3000}b"', 'in a value it is quoted, so the value stays one word and looks it');
    assert.equal(quoteValue('a\u{A0}b', 'posix').text, "'a\u{A0}b'");
  });

  test('PC-37: a blank must sit where a word starts for every shell — not in quotes, not after an escape, $ or --%', () => {
    const refused = [
      ['echo "note: {{m}} end"', /inside quotes/],
      ["echo 'a {{v}} b'", /inside quotes/],
      ['echo "$(cat {{f}})"', /inside quotes/],
      ['echo `ls {{f}}`', /inside quotes|quote right beside/],
      ['echo `ls {{f}} -l`', /inside quotes/],
      ['echo \u{201C}a {{v}}\u{201D}', /inside quotes/],
      ['echo \u{2018}a {{v}}\u{2019}', /inside quotes/],
      ['printf x \\{{a}}', /right after \\/],
      ['echo ^{{v}}', /right after \^/],
      ['echo a`{{v}}', /quote right beside|right after `/],
      ['echo ${{v}}', /right after \$/],
      ['x --% {{v}}', /after --%/],
      // cmd has no \" escape: "a\" closes, b" opens again — the blank is inside quotes for cmd.
      ['echo "a\\"b" {{v}}', /inside quotes/],
    ];
    for (const [command, reason] of refused) assert.match(reasonOf({ name: 'x', command }) ?? '(loaded)', reason, command);
    const fine = [
      "docker ps --format '{{.Names}}' {{n}}",
      'echo "done" {{v}}',
      "echo 'it''s' {{v}}",
      'run --name={{a}} {{b}}x {{c}}/{{d}}',
      'echo {{v}} --% rest',
      'cmd /c "echo hi" && type {{f}}',
    ];
    for (const command of fine) assert.equal(reasonOf({ name: 'x', command }), null, command);
  });

  test('PC-38: what interactive bash and zsh would rewrite by history is refused; what they leave alone is not', () => {
    // `!"` too: checked at real interactive prompts, bash 3.2 rewrote `echo "Done!"` to `echo "Done"`
    // and zsh read `!"` as history and waited at a dquote> continuation.
    for (const command of ['echo "again: !!"', 'echo !$', 'echo !-2', 'echo !git', 'echo !?x?', 'echo a!b', '^old^new', '  ^a^b', 'git commit -m "fix!"', 'echo !"x"']) {
      assert.ok(reasonOf({ name: 'x', command }), command);
    }
    for (const command of ['test ! -f x', '[ a != b ]', "echo '!!'", 'echo \\!!', 'echo done!', 'rm !(keep)', 'echo a^b']) {
      assert.equal(reasonOf({ name: 'x', command }), null, command);
    }
  });

  test('PC-39: WSL is given only what bash, zsh and fish read alike; Git Bash no POSIX-looking path; Windows shells no best-fit quote or backslash', () => {
    assert.equal(quoteValue('a b', 'wsl').text, "'a b'");
    assert.equal(quoteValue('src/x.js', 'wsl').text, 'src/x.js');
    for (const value of ["it's", 'C:\\dir\\', 'a\\b']) assert.match(quoteValue(value, 'wsl').reason, /cannot tell which shell WSL starts/, value);
    for (const value of ['/api/v1', '--prefix=/usr']) assert.match(quoteValue(value, 'msys').reason, /Git Bash turns that into a Windows path/, value);
    assert.equal(quoteValue('src/api/v1', 'msys').text, 'src/api/v1');
    assert.equal(quoteValue('/api/v1', 'posix').text, '/api/v1', 'only Git Bash rewrites it');
    for (const kind of ['cmd', 'powershell']) {
      for (const char of ['\u{FF02}', '\u{FF3C}', '\u{A5}', '\u{20A9}', '\u{2033}', '\u{3003}', '\u{201D}']) {
        assert.match(quoteValue(`x y${char}`, kind).reason ?? '(typed)', /Windows hands some programs as a " or a \\/, `${kind} ${char.codePointAt(0).toString(16)}`);
      }
    }
    assert.equal(quoteValue('\u{20A9}1000', 'posix').ok, true, 'not a problem anywhere else');
  });

  test('PC-41: the finished line is capped where cmd stops taking it', () => {
    const blanks = Array.from({ length: 9 }, (_, i) => `{{b${i}}}`).join(' ');
    const c = one({ name: 'x', command: `echo ${blanks}` }).commands[0];
    const values = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`b${i}`, 'v'.repeat(LIMITS.value)]));
    const out = renderCommand(c, values, 'cmd');
    assert.equal(out.ok, false);
    assert.match(out.lineError, /longer than 8000/);
    assert.deepEqual(out.errors, {}, 'no single value is wrong');
    assert.equal(renderCommand(c, {}, 'cmd').lineError, null);
    assert.match(lineProblem('x'.repeat(LIMITS.line + 1)), /longer than 8000/);
    assert.equal(lineProblem('x'.repeat(LIMITS.line)), null);
  });
});

describe('Project commands: Git Bash on Windows', () => {
  test('PC-40: Git Bash — values reach a Windows program (node) as typed, through MSYS argument conversion', () => {
    if (process.platform !== 'win32') skip('Git Bash is checked on Windows (CI)');
    const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'];
    const bash = candidates.find((path) => existsSync(path));
    if (!bash) skip('Git for Windows is not installed here');
    const wrong = roundTrip('msys', '', posixRunner(bash, ['--norc', '--noprofile', '-c']));
    assert.deepEqual(wrong, [], wrong.join('\n'));
  });
});

describe('Project commands: trust', () => {
  test('PC-31: trust is of one content in one folder — another hash is "changed", another folder "untrusted"', () => {
    const entries = trusting([], '/p/one', SHA_A, 10);
    assert.equal(trustOf(entries, '/p/one', SHA_A), 'trusted');
    assert.equal(trustOf(entries, '/p/one', SHA_B), 'changed');
    assert.equal(trustOf(entries, '/p/two', SHA_A), 'untrusted', 'the same file elsewhere is asked about again');
    assert.equal(trustOf([], '/p/one', SHA_A), 'untrusted');
    const again = trusting(entries, '/p/one', SHA_B, 20);
    assert.equal(again.length, 1, 'one entry per folder');
    assert.equal(trustOf(again, '/p/one', SHA_B), 'trusted');
    assert.equal(trustOf(forgetting(again, '/p/one'), '/p/one', SHA_B), 'untrusted');
  });

  test('PC-32: what storage hands back is not trusted to be what was written', () => {
    const raw = [
      { root: '/ok', sha256: SHA_A, at: 5 },
      { root: '/ok', sha256: SHA_B, at: 1 },
      { root: '/bad-hash', sha256: 'abc', at: 1 },
      { root: '', sha256: SHA_A, at: 1 },
      { root: '/bad-at', sha256: SHA_A, at: 'x' },
      { root: '/upper', sha256: SHA_A.toUpperCase(), at: 1 },
      null,
      'x',
      { root: 'x'.repeat(5000), sha256: SHA_A, at: 1 },
    ];
    assert.deepEqual(normalizeTrust(raw), [{ root: '/ok', sha256: SHA_A, at: 5 }], 'newest per folder; junk dropped');
    for (const junk of [null, undefined, {}, 'x', 7]) assert.deepEqual(normalizeTrust(junk), []);
    assert.equal(trusting([], '/p', 'not-a-hash').length, 0, 'nothing is trusted under a hash that is not one');
  });

  test(`PC-33: at most ${TRUST_LIMIT} folders are remembered, the oldest forgotten first`, () => {
    let entries = [];
    for (let i = 0; i < TRUST_LIMIT + 5; i += 1) entries = trusting(entries, `/p/${i}`, SHA_A, i);
    assert.equal(entries.length, TRUST_LIMIT);
    assert.equal(trustOf(entries, '/p/0', SHA_A), 'untrusted');
    assert.equal(trustOf(entries, `/p/${TRUST_LIMIT + 4}`, SHA_A), 'trusted');
  });

  test('PC-34: the example file NexTerm writes is a valid commands file', () => {
    const read = parseCommandsFile(EXAMPLE_COMMANDS_FILE);
    assert.equal(read.ok, true);
    assert.deepEqual(read.refused, []);
    assert.equal(read.commands.length, 2);
    assert.equal(renderCommand(read.commands[1], {}, 'cmd').line, 'npm test -- src/app.test.js');
  });
});
