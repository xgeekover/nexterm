/**
 * Pure unit tests for the terminal's inline-intellisense building blocks:
 * `src/lib/commandIndex.js` (ranking) and `src/lib/terminalThemes.js`
 * (palette registry shape). Neither module touches xterm/the DOM, so these
 * run as plain Node assertions — no terminal instance involved.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { suggest, recordCommand, __resetCommandHistory, completionFor} from '../../src/lib/commandIndex.js';
import { TERMINAL_THEMES, TERMINAL_THEME_IDS, DEFAULT_TERMINAL_THEME_ID } from '../../src/lib/terminalThemes.js';

describe('commandIndex: ranked command suggestions', () => {
  beforeEach(() => {
    __resetCommandHistory();
  });

  test('CI-01: empty (or whitespace-only) input returns nothing', () => {
    assert.deepEqual(suggest(''), []);
    assert.deepEqual(suggest('   '), []);
    assert.deepEqual(suggest(undefined), []);
  });

  test('CI-02: a prefix match outranks a subsequence-only match', () => {
    // Both recorded as history so they sit in the same ranking tier — this
    // isolates the prefix-vs-subsequence rule from the history-vs-static one.
    recordCommand('build-tool run');       // starts with "bui" -> prefix match
    recordCommand('submit-build report');  // contains b,u,i in order, not a prefix

    const results = suggest('bui');
    assert.ok(results.includes('build-tool run'), 'prefix candidate must be suggested');
    assert.ok(results.includes('submit-build report'), 'subsequence candidate must be suggested');
    const prefixRank = results.indexOf('build-tool run');
    const subseqRank = results.indexOf('submit-build report');
    assert.ok(prefixRank < subseqRank, 'prefix match must rank above subsequence match');
  });

  test('CI-03: a history match outranks a static-index match, even for the same query', () => {
    // "ssh" is in the static index and matches many static entries by
    // prefix; a freshly recorded history command that also prefix-matches
    // "ssh" must still come out on top.
    recordCommand('ssh myserver.example.com');
    const results = suggest('ssh');
    assert.equal(results[0], 'ssh myserver.example.com', 'history entry must rank first');
  });

  test('CI-04: recordCommand promotes a command into future suggestions', () => {
    const before = suggest('mycustomtool');
    assert.ok(!before.includes('mycustomtool --deploy'), 'must not exist before it is recorded');

    recordCommand('mycustomtool --deploy');
    const after = suggest('mycustomtool');
    assert.ok(after.includes('mycustomtool --deploy'), 'must appear once recorded');
    assert.equal(after[0], 'mycustomtool --deploy', 'the only match must be ranked first');
  });

  test('CI-05: repeated recordCommand calls do not duplicate a candidate', () => {
    recordCommand('dupe-check --flag');
    recordCommand('dupe-check --flag');
    recordCommand('dupe-check --flag');
    const results = suggest('dupe-check');
    const occurrences = results.filter((r) => r === 'dupe-check --flag').length;
    assert.equal(occurrences, 1, 'must appear exactly once, not once per recordCommand call');
  });

  test('CI-06: the static index alone can answer well-known commands', () => {
    const results = suggest('git co');
    assert.ok(results.length > 0, 'must suggest something for a well-known git prefix');
    assert.ok(
      results.some((r) => r.startsWith('git co')),
      'at least one suggestion must actually continue what was typed'
    );
  });

  test('CI-07: an exact full match is not suggested back to itself', () => {
    const results = suggest('git status');
    assert.ok(!results.includes('git status'), 'must not suggest the exact string already typed');
  });
});

describe('terminalThemes: theme registry shape', () => {
  const ANSI_KEYS = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ];

  test('TT-01: dark-modern follows the app theme and has no literal palette', () => {
    const entry = TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID];
    assert.ok(entry, 'default theme id must resolve to an entry');
    assert.equal(entry.followsAppTheme, true);
    assert.equal(entry.theme, null);
  });

  test('TT-02: every non-follows-app-theme entry has all 16 ANSI colours plus background/foreground', () => {
    for (const id of TERMINAL_THEME_IDS) {
      const entry = TERMINAL_THEMES[id];
      if (entry.followsAppTheme) continue;
      assert.ok(entry.theme, `"${id}" must carry a literal theme object`);
      assert.ok(typeof entry.theme.background === 'string' && entry.theme.background.length > 0, `"${id}" missing background`);
      assert.ok(typeof entry.theme.foreground === 'string' && entry.theme.foreground.length > 0, `"${id}" missing foreground`);
      for (const key of ANSI_KEYS) {
        assert.ok(
          typeof entry.theme[key] === 'string' && entry.theme[key].length > 0,
          `"${id}" missing ANSI colour "${key}"`
        );
      }
    }
  });

  test('TT-03: theme ids are unique and every entry has a human label', () => {
    const seen = new Set();
    for (const id of TERMINAL_THEME_IDS) {
      assert.ok(!seen.has(id), `duplicate theme id "${id}"`);
      seen.add(id);
      assert.ok(TERMINAL_THEMES[id].label && TERMINAL_THEMES[id].label.length > 0, `"${id}" missing a label`);
    }
    assert.equal(seen.size, TERMINAL_THEME_IDS.length);
  });

  test('TT-04: ships at least the 11 named themes the task called for', () => {
    const required = [
      'dark-modern', 'light-modern', 'monokai', 'material', 'dracula',
      'solarized-dark', 'solarized-light', 'nord', 'one-dark',
      'gruvbox-dark', 'tomorrow-night',
    ];
    for (const id of required) {
      assert.ok(TERMINAL_THEME_IDS.includes(id), `missing required theme "${id}"`);
    }
  });
});

describe('Accepting a suggestion never rewrites what is already typed', () => {
  // `suggest()` ranks subsequence matches as well as prefixes, which is useful
  // to show but dangerous to accept: slicing a candidate by the buffer's LENGTH
  // pasted the tail of a different string onto the command line. `gs` + Enter
  // used to produce `gst push` — and the Enter was swallowed, so the user was
  // left with a mangled line instead of a command that ran.
  const cases = ['gs', 'gc', 'dc', 'kg', 'ls -'];

  test('IS-20: a subsequence match is never treated as a completion', () => {
    for (const typed of cases) {
      for (const candidate of suggest(typed)) {
        const completion = completionFor(typed, candidate);
        if (completion === null) continue;
        assert.equal(
          (typed + completion).toLowerCase(),
          candidate.toLowerCase(),
          `accepting "${candidate}" after "${typed}" would not leave the candidate on the line`
        );
      }
    }
  });

  test('IS-21: the top suggestion for a common abbreviation is refused, not spliced', () => {
    const top = suggest('gs')[0];
    assert.ok(top, 'no suggestion for "gs" at all — the fixture has drifted');
    // It is still offered (subsequence matching is the point of the feature)…
    assert.equal(top.toLowerCase().startsWith('gs'), false, `"${top}" is a prefix match, pick another fixture`);
    // …but it cannot be accepted onto the line.
    assert.equal(completionFor('gs', top), null);
  });

  test('IS-22: a real prefix still completes, and an exact match completes to nothing', () => {
    assert.equal(completionFor('git pu', 'git push'), 'sh');
    assert.equal(completionFor('GIT PU', 'git push'), 'sh', 'case-insensitive, like the popup');
    assert.equal(completionFor('git push', 'git push'), '');
    assert.equal(completionFor('', 'git push'), 'git push');
    assert.equal(completionFor('git push', null), null);
  });
});
