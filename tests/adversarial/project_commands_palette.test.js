/**
 * Stage 5: what the command palette offers of a folder's commands and the
 * user's (spec D10) — src/lib/paletteItems.js's `projectCommandRows` and
 * `buildPaletteGroups`, and the three commands that go with them in the
 * registry (src/lib/keybindings.js).
 *
 * Plain data, from what the project commands store holds: `{ status,
 * reason, trust, project, user }`, the files parsed by the real validator.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { buildPaletteGroups, focusAfterPalette, paletteCommands, projectCommandRows } from '../../src/lib/paletteItems.js';
import { COMMANDS, DEFAULT_RESOLVED, configurableCommands, findBinding, keysFor, menuIdOf, resolveKeybindings } from '../../src/lib/keybindings.js';
import { onMenuEvent } from '../../src/hooks/useMenuEvents.js';
import { holdModal, modalHeld } from '../../src/lib/modalLock.js';
import { parseCommandsFile } from '../../src/lib/projectCommands.js';

const file = (commands, source = 'project') => parseCommandsFile(JSON.stringify({ version: 1, commands }), { source });
const PROJECT = file([
  { name: 'Build', description: 'Compile everything', command: 'make all' },
  { name: 'Test one', command: 'npm test -- {{file}}' },
  { name: 'Lint', description: 'Look for test smells', command: 'npm run lint' },
  { name: 'Quoted', command: "echo '{{x}}'" },
]);
const USER = file([{ name: 'Build', description: 'My own build', command: 'make -j8' }, { name: 'Deploy', command: 'npm run deploy' }], 'user');

const state = (extra = {}) => ({ status: 'ok', reason: null, trust: 'trusted', project: PROJECT, user: null, ...extra });
const group = (groups) => groups.find((g) => g.label === 'project commands') ?? null;
const all = (projectCommands, query = '') => buildPaletteGroups({ mode: 'all', query, projectCommands });
const own = (projectCommands, query = '') => buildPaletteGroups({ mode: 'project-commands', query, projectCommands });

describe('Command palette: project commands, row by state', () => {
  test('PCP-01: nothing from the store — the palette is what it was: files and commands only', () => {
    assert.deepEqual(all(null).map((g) => g.label), ['commands']);
    assert.deepEqual(all({ status: 'none' }).map((g) => g.label), ['commands'], 'no file: no group');
    assert.deepEqual(all({ status: 'reading' }).map((g) => g.label), ['commands']);
  });

  test("PCP-02: a file read but not trusted is ONE row — Review This Folder's Commands… — after NexTerm's own commands, and none of its commands", () => {
    const groups = all(state({ trust: 'untrusted' }));
    assert.deepEqual(groups.map((g) => g.label), ['commands', 'project commands']);
    const { items } = group(groups);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'project-review');
    assert.equal(items[0].title, "Review This Folder's Commands…");
    assert.equal(items[0].subtitle, '3 commands (1 refused) in .nexterm/commands.json — not trusted yet');
    assert.equal(items[0].hint, 'Project');
    const changed = group(all(state({ trust: 'changed' }))).items[0];
    assert.equal(changed.subtitle, '3 commands (1 refused) in .nexterm/commands.json — changed since you trusted them');
    assert.equal(group(all(state({ trust: 'untrusted', project: file([]) }))), null, 'a file that lists nothing has nothing to review');
    // NexTerm's own commands never carry a project command.
    assert.ok(!groups.find((g) => g.label === 'commands').items.some((row) => row.type !== 'command'));
  });

  test('PCP-03: trusted, its commands are rows of their own group, hint Project; the subtitle is the description, or the line', () => {
    const { items } = group(all(state()));
    assert.deepEqual(
      items.map((row) => [row.type, row.title, row.subtitle, row.hint, row.commandKey]),
      [
        ['project-command', 'Build', 'Compile everything', 'Project', 'project:0'],
        ['project-command', 'Test one', 'npm test -- {{file}}', 'Project', 'project:1'],
        ['project-command', 'Lint', 'Look for test smells', 'Project', 'project:2'],
      ]
    );
  });

  test('PCP-04: the user\'s commands are listed whatever the folder\'s state, hint User — one sharing a project command\'s name shows beside it', () => {
    const rows = (s) => group(all(s))?.items.map((row) => `${row.title}/${row.hint}`) ?? [];
    assert.deepEqual(rows(state({ user: USER })), ['Build/Project', 'Test one/Project', 'Lint/Project', 'Build/User', 'Deploy/User']);
    assert.deepEqual(rows({ status: 'none', user: USER }), ['Build/User', 'Deploy/User'], 'no folder file at all');
    assert.deepEqual(
      rows(state({ trust: 'untrusted', user: USER })),
      ["Review This Folder's Commands…/Project", 'Build/User', 'Deploy/User'],
      'an untrusted file costs the user nothing of their own'
    );
    assert.equal(new Set(group(all(state({ user: USER }))).items.map((r) => r.id)).size, 5, 'every row its own id');
  });

  test('PCP-05: matched as the built-ins are — by name first, then by description, each in file order', () => {
    const titles = (q) => group(all(state({ user: USER }), q))?.items.map((row) => `${row.title}/${row.hint}`) ?? [];
    // "test": Test one by name; Lint only by its description ("…test smells").
    assert.deepEqual(titles('test'), ['Test one/Project', 'Lint/Project']);
    assert.deepEqual(titles('build'), ['Build/Project', 'Build/User']);
    // A line is what a command without a description is known by.
    assert.deepEqual(titles('npm run dep'), ['Deploy/User']);
    assert.deepEqual(titles('zzz'), []);
    assert.equal(group(all(state({ user: USER }), 'zzz')), null, 'no group for nothing matched');
  });

  test('PCP-06: a file the backend would not read: no row to open it, a note saying why — in the list of all only while nothing is typed', () => {
    const refused = { status: 'refused', reason: 'The folder is on a network drive.' };
    const g = group(all(refused));
    assert.deepEqual(g.items, []);
    assert.equal(g.note, "This folder's .nexterm/commands.json is not read: The folder is on a network drive.");
    assert.equal(group(all(refused, 'build')), null, 'typing for something else: the note steps aside');
    assert.equal(group(all({ status: 'error', reason: 'Not UTF-8.' })).note, "This folder's .nexterm/commands.json is not read: Not UTF-8.");
    assert.equal(group(own(refused, 'build')).note.includes('network drive'), true, 'in its own mode it stays');
  });

  test('PCP-07: a file that is no commands file: one row that opens it to be fixed, saying why', () => {
    const broken = parseCommandsFile('{ "version": 2, "commands": [] }');
    const [row] = group(all(state({ project: broken, trust: 'untrusted' }))).items;
    assert.equal(row.type, 'project-problem');
    assert.equal(row.command, 'open_project_commands_file');
    assert.equal(row.subtitle, '.nexterm/commands.json: It is version "2"; this NexTerm reads version 1.');
    assert.equal(focusAfterPalette(row), 'opener');
  });

  test('PCP-08: "Run Project Command…" is a mode of its own — only these rows; a note when there are none, saying how to add some', () => {
    const groups = own(state({ user: USER }));
    assert.deepEqual(groups.map((g) => g.label), ['project commands']);
    assert.equal(groups[0].items.length, 5);
    assert.equal(groups[0].note, "1 of .nexterm/commands.json's commands was refused — Open Project Commands File to see why.");
    const empty = own({ status: 'none', user: null });
    assert.equal(empty.length, 1);
    assert.deepEqual(empty[0].items, []);
    assert.match(empty[0].note, /No commands yet\. Put a folder's in \.nexterm\/commands\.json \(Open Project Commands File makes one with an example\), or your own in Settings ▸ Terminal ▸ User Commands\./);
    assert.equal(own({ status: 'none', user: USER }, 'zzz')[0].note, 'No project or user command matches.');
    // No file rows, no built-in commands.
    assert.ok(!own(state(), '').some((g) => g.label === 'files' || g.label === 'commands'));
  });

  test("PCP-09: names come display-safe from the file: a bidi control or a zero-width space never reaches a row", () => {
    const sneaky = file([{ name: 'Safe\u{202E}txt.exe', description: 'a\u{200B}b', command: 'echo hi' }]);
    const [row] = group(all(state({ project: sneaky }))).items;
    assert.equal(row.title, 'Safetxt.exe');
    assert.equal(row.subtitle, 'ab');
    assert.ok(!/[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(JSON.stringify(row)));
  });
});

describe('Command palette: the project commands in the registry', () => {
  const IDS = ['run-project-command', 'open-project-commands-file', 'stop-trusting-project-commands'];

  test('PCP-10: three palette commands — no chord as shipped, no menu entry, not claimed over a terminal, and a user can give each a key', () => {
    assert.deepEqual(IDS.map((id) => COMMANDS[id]?.title), ['Run Project Command…', 'Open Project Commands File', "Stop Trusting This Folder's Commands"]);
    for (const id of IDS) {
      assert.equal(menuIdOf(id), null, `${id}: no native menu entry`);
      assert.deepEqual(keysFor(id), [], `${id}: nothing taken from a shell as shipped`);
      assert.notEqual(COMMANDS[id].overTerminal, true, `${id}: not on KB-11's list`);
      assert.ok(configurableCommands().some((c) => c.id === id), `${id}: rebindable`);
    }
    const calls = [];
    const ctx = {
      isCommandPaletteOpen: true,
      setCommandPaletteOpen: (open, mode) => calls.push(['palette', open, mode]),
      openProjectCommandsFile: () => calls.push(['open']),
      stopTrustingProjectCommands: () => calls.push(['stop']),
    };
    for (const id of IDS) COMMANDS[id].run(ctx);
    assert.deepEqual(calls, [
      ['palette', true, 'project-commands'],
      ['palette', false, undefined],
      ['open'],
      ['palette', false, undefined],
      ['stop'],
    ]);
  });

  test('PCP-11: their palette rows — Run Project Command… opens the pick, keeping the palette; a key a user binds is the hint', () => {
    const rows = paletteCommands(DEFAULT_RESOLVED).filter((row) => /project/.test(row.command));
    assert.deepEqual(rows.map((row) => [row.command, row.opens ?? null, row.hint]), [
      ['run_project_command', 'project-commands', ''],
      ['open_project_commands_file', null, ''],
      ['stop_trusting_project_commands', null, ''],
    ]);
    const rebound = paletteCommands(resolveKeybindings({ 'run-project-command': 'mod+alt+r' }).bindings).find((r) => r.command === 'run_project_command');
    assert.ok(rebound.hint, 'a chord the user gave it is shown');
    for (const row of rows) assert.equal(focusAfterPalette(row), 'opener');
  });
});

describe('Command palette: project rows by state, from the store', () => {
  test('PCP-12: projectCommandRows counts what a trusted file refused, for the pick to say', () => {
    assert.equal(projectCommandRows(state()).refused, 1);
    assert.equal(projectCommandRows(state({ trust: 'untrusted' })).refused, 0, 'not trusted: its rows are the review, which says it');
  });
});

describe('Command palette: project commands, review round 1', () => {
  const ECHO = file([{ name: 'Echo hi', command: 'echo hi' }]);
  const labels = (q, extra = {}) => buildPaletteGroups({ mode: 'all', query: q, projectCommands: state({ project: ECHO, ...extra }) }).map((g) => g.label);

  test('PCP-13: a query that names a project command puts it first when no built-in is named by it — "Echo hi" no longer runs Swap Pane With…', () => {
    const groups = buildPaletteGroups({ mode: 'all', query: 'echo hi', projectCommands: state({ project: ECHO }) });
    assert.deepEqual(groups.map((g) => g.label), ['project commands', 'commands']);
    assert.equal(groups[0].items[0].title, 'Echo hi', 'the row Enter runs');
    assert.ok(groups[1].items.some((row) => row.title === 'Swap Pane With…'), 'setup: a built-in matched by its description');
    assert.deepEqual(labels('clear'), ['commands'], 'a built-in named by the query keeps its place');
    assert.deepEqual(labels(''), ['commands', 'project commands'], 'nothing typed: the order of the spec');
  });

  test("PCP-14: Stop Trusting This Folder's Commands is listed only while the folder's commands are trusted", () => {
    const listed = (s) => buildPaletteGroups({ mode: 'all', projectCommands: s }).find((g) => g.label === 'commands').items.some((row) => row.command === 'stop_trusting_project_commands');
    assert.equal(listed(state()), true);
    assert.equal(listed(state({ trust: 'untrusted' })), false);
    assert.equal(listed(state({ trust: 'changed' })), false);
    assert.equal(listed({ status: 'none' }), false);
    assert.equal(buildPaletteGroups({ mode: 'all' }).find((g) => g.label === 'commands').items.some((row) => row.command === 'stop_trusting_project_commands'), true, 'no word from the store: every built-in listed');
  });

  test('PCP-15: a command shown by its line is marked so the row draws it in the order it is typed', () => {
    const rows = group(all(state({ project: file([{ name: 'Copy', command: 'cp \u{5D0} \u{5D1}' }, { name: 'D', description: 'Has words', command: 'x' }]) }))).items;
    assert.deepEqual(rows.map((r) => Boolean(r.subtitleIsLine)), [true, false]);
  });

  test('PCP-16: a project command or the review hands the keyboard to the dialog it opens, not back to the terminal first', () => {
    const [review] = group(all(state({ trust: 'untrusted' }))).items;
    const [cmd] = group(all(state())).items;
    assert.equal(focusAfterPalette(review), 'dialog');
    assert.equal(focusAfterPalette(cmd), 'dialog');
  });

  test("PCP-17: while a dialog holds the app still, no chord and no menu item of the app's does anything — the reload guard still holds", () => {
    const key = (k, code, extra = {}) => ({ key: k, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
    // macOS: the app's modifier is ⌘.
    const ctx = (e, modal) => ({ isMod: e.metaKey, modalOpen: () => modal, blockReload: true });
    const cmdK = key('k', 'KeyK', { metaKey: true });
    const cmdW = key('w', 'KeyW', { metaKey: true });
    const focusNext = key('ArrowRight', 'ArrowRight', { metaKey: true, altKey: true });
    const chords = [cmdK, cmdW, focusNext, key('p', 'KeyP', { metaKey: true, shiftKey: true }), key(',', 'Comma', { metaKey: true })];
    for (const e of chords) assert.ok(findBinding(e, ctx(e, false)), `setup: ${e.code} is a chord of the app's`);
    for (const e of chords) assert.equal(findBinding(e, ctx(e, true)), null, `${e.code} answered behind the dialog`);
    const f5 = key('F5', 'F5');
    assert.equal(findBinding(f5, ctx(f5, true))?.command, 'reload-guard', 'a reload under a dialog still reaps every shell');

    const ran = [];
    assert.equal(onMenuEvent('close-pane', { run: (id) => ran.push(id), modalOpen: () => true }), false);
    assert.equal(onMenuEvent('new-terminal', { run: (id) => ran.push(id), modalOpen: () => false }), true);
    assert.deepEqual(ran, ['new-terminal']);

    // The lock: held by each dialog, let go once each.
    assert.equal(modalHeld(), false);
    const a = holdModal();
    const b = holdModal();
    a();
    a();
    assert.equal(modalHeld(), true, 'one release per hold');
    b();
    assert.equal(modalHeld(), false);
  });
});
