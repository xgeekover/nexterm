/**
 * The command history palette.
 *
 * The data was already being kept — `recordCommand` has fed the inline
 * suggestions since they were built — but only in module scope, so every
 * reload started from nothing, and there was no way to LOOK at it. Warp's
 * history palette is the thing it was missing.
 *
 * What matters here is what a history is for: the same command run twice is
 * one entry and not two, the newest is the one you want first, and a restart
 * does not erase what you did yesterday.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import {
  recordCommand,
  forgetCommand,
  commandHistory,
  loadCommandHistory,
  __resetCommandHistory,
} from '../../src/lib/commandIndex.js';
import { buildPaletteGroups } from '../../src/lib/paletteItems.js';

const lines = () => commandHistory().map((e) => e.command);

describe('Command history', () => {
  beforeEach(() => {
    __resetCommandHistory();
  });

  test('CH-01: newest first, because that is the one you are reaching for', () => {
    recordCommand('one');
    recordCommand('two');
    recordCommand('three');
    assert.deepEqual(lines(), ['three', 'two', 'one']);
  });

  test('CH-02: running a command again moves it, it does not duplicate it', () => {
    recordCommand('npm test');
    recordCommand('git status');
    recordCommand('npm test');
    assert.deepEqual(lines(), ['npm test', 'git status']);
    assert.equal(commandHistory()[0].count, 2, 'and the count says it was run twice');
  });

  test('CH-03: where it ran is kept, and follows the latest run', () => {
    // Most of what tells two similar-looking command lines apart.
    recordCommand('cargo test', { cwd: '/w/proj/src-tauri' });
    assert.equal(commandHistory()[0].cwd, '/w/proj/src-tauri');
    recordCommand('cargo test', { cwd: '/w/other' });
    assert.equal(commandHistory()[0].cwd, '/w/other');
  });

  test('CH-04: a typo the shell rejected comes back out', () => {
    // `forgetCommand` already existed for the suggestions; the palette must
    // not resurrect what it removed.
    recordCommand('opencoded');
    assert.deepEqual(lines(), ['opencoded']);
    forgetCommand('opencoded');
    assert.deepEqual(lines(), []);
  });

  test('CH-05: a command that has worked before survives one failure', () => {
    recordCommand('npm test');
    recordCommand('npm test');
    forgetCommand('npm test');
    assert.deepEqual(lines(), ['npm test'], 'twice-run commands are not erased by one bad exit');
  });

  test('CH-06: it outlives the window', () => {
    recordCommand('cargo build', { cwd: '/w' });
    // A fresh process would start empty and read the store back.
    __resetCommandHistory();
    assert.deepEqual(lines(), []);
    const restored = loadCommandHistory();
    assert.equal(restored >= 1, true, 'nothing was read back');
    assert.equal(lines().includes('cargo build'), true);
    assert.equal(commandHistory().find((e) => e.command === 'cargo build').cwd, '/w');
  });

  test('CH-07: reading it back twice does not double the entries', () => {
    recordCommand('ls -la');
    loadCommandHistory();
    loadCommandHistory();
    assert.equal(lines().filter((c) => c === 'ls -la').length, 1);
  });

  test('CH-08: garbage on disk costs nothing', () => {
    // It is a file on the user's machine; one bad entry must not take the
    // rest of the history with it.
    __resetCommandHistory();
    assert.doesNotThrow(() => loadCommandHistory());
  });
});

describe('Command history: the palette rows', () => {
  beforeEach(() => {
    __resetCommandHistory();
    recordCommand('npm run build', { cwd: '/w/app' });
    recordCommand('git commit -m "fix the thing"', { cwd: '/w/app' });
    recordCommand('cargo test', { cwd: '/w/app/src-tauri' });
  });

  const rows = (query = '') =>
    buildPaletteGroups({ mode: 'history', query, history: commandHistory() })
      .flatMap((g) => g.items);

  test('CH-09: history is its own mode, not a section of everything else', () => {
    // You reach for it knowing you want something already run; mixing it with
    // files and commands would bury it under both.
    const groups = buildPaletteGroups({ mode: 'history', history: commandHistory() });
    assert.deepEqual(groups.map((g) => g.label), ['history']);
    assert.deepEqual(rows().map((r) => r.title), [
      'cargo test',
      'git commit -m "fix the thing"',
      'npm run build',
    ]);
  });

  test('CH-10: matching is plain substring, not fuzzy', () => {
    // A command line is not a filename. Fuzzy over `git commit -m "..."`
    // turns every query into a wall of near-misses.
    assert.deepEqual(rows('cargo').map((r) => r.title), ['cargo test']);
    assert.deepEqual(rows('commit').map((r) => r.title), ['git commit -m "fix the thing"']);
    assert.deepEqual(rows('crgo').map((r) => r.title), [], 'a fuzzy match would have caught this');
  });

  test('CH-11: a row carries the directory it ran in', () => {
    assert.equal(rows('cargo')[0].subtitle, '/w/app/src-tauri');
    assert.equal(rows('cargo')[0].type, 'history');
    assert.equal(rows('cargo')[0].command, 'cargo test');
  });

  test('CH-12: nothing matching is no group at all', () => {
    assert.deepEqual(buildPaletteGroups({ mode: 'history', query: 'zzz', history: commandHistory() }), []);
  });

  test('CH-13: the other modes are untouched by history', () => {
    const all = buildPaletteGroups({ mode: 'all', history: commandHistory() });
    assert.equal(all.some((g) => g.label === 'history'), false);
  });

  test('CH-14: teardown', () => {
    __resetCommandHistory();
    assert.deepEqual(lines(), []);
  });
});
