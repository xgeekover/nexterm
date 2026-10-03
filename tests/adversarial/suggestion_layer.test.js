/**
 * The inline suggestion layer keeps out of running programs and out of the
 * shell's own keys.
 *
 * Reproduced headless against the real TerminalView (render investigation,
 * H1), in a screen laid out like Claude Code's:
 *
 *   - Typing `git st` into Claude's input drew the ghost `ash` there and a
 *     popup of eight shell commands over its footer. Nothing checked whether a
 *     program was running.
 *   - Tab typed `ash` into Claude instead of sending `\t`; → typed history
 *     text; Esc and ↑/↓ never reached it. Esc was swallowed even with NOTHING
 *     on screen — `visible` with one candidate that is not a prefix match,
 *     which draws neither a ghost nor a popup.
 *   - A swallowed key left the layer's copy of the line as it was, so Enter in
 *     Claude recorded `git stfixplease refactor the auth module` as a shell
 *     command, later suggested at the zsh prompt and in Claude.
 *   - At the zsh prompt the same code took Tab whenever a ghost showed, so
 *     zsh's own completion never ran.
 *
 * The decisions now live in src/lib/suggestionLayer.js, pure, and are checked
 * here one rule at a time.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  NEW_LINE,
  LOST_LINE,
  suggestionsAllowed,
  trackInput,
  rankedSuggestions,
  drawnSuggestion,
  suggestionKeyAction,
  lineAfterKey,
} from '../../src/lib/suggestionLayer.js';

const keydown = (key, extra = {}) => ({ type: 'keydown', key, ...extra });

/** A suggestion state the way TerminalView keeps it, drawn unless told otherwise. */
function state(typed, items, extra = {}) {
  return { visible: true, ...rankedSuggestions(typed, items), ...extra };
}

/** Feed `keys` through `trackInput`, collecting what would be recorded. */
function typeInto(line, keys, ctx) {
  const recorded = [];
  let current = line;
  for (const key of keys) {
    const result = trackInput(current, key, ctx);
    current = result.line;
    if (result.record) recorded.push(result.record);
  }
  return { line: current, recorded };
}

const GIT_ST = ['git status', 'git stash', 'git stash pop'];
const KEYS = ['Tab', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Escape', 'Enter', 'a'];

describe('Suggestion layer: nothing inside a running program', () => {
  test('SL-01: no ranking or drawing while a program runs, in the alternate buffer, mid-syllable or switched off', () => {
    assert.equal(suggestionsAllowed({}), true, 'at a prompt, with the setting on');
    assert.equal(suggestionsAllowed({ running: true }), false, 'a program is running (OSC 133 C)');
    assert.equal(suggestionsAllowed({ alternate: true }), false, 'vim, less, htop');
    assert.equal(suggestionsAllowed({ composing: true }), false, 'a Korean syllable sits where the ghost goes');
    assert.equal(suggestionsAllowed({ enabled: false }), false, 'the setting is off');
  });

  test('SL-02: no key is taken while a program runs or the alternate buffer is up — even with both drawn', () => {
    const drawn = state('git st', GIT_ST, { selectedIndex: 1, moved: true });
    for (const ctx of [{ running: true }, { alternate: true }]) {
      for (const key of KEYS) {
        assert.deepEqual(
          suggestionKeyAction(drawn, keydown(key), ctx),
          { action: 'pass', consume: false },
          `${key} with ${JSON.stringify(ctx)}`
        );
      }
    }
  });

  test('SL-03: Enter inside a running program records nothing, and what was typed there never reaches a prompt', () => {
    // H1: `git st`, a swallowed key, then a prompt for Claude and Enter.
    const inClaude = typeInto(NEW_LINE, [...'git st', '\t', ...'fixplease refactor the auth module', '\r'], {
      running: true,
    });
    assert.deepEqual(inClaude.recorded, [], 'nothing typed into a running program is a shell command');
    assert.equal(trackInput({ buffer: 'git status', tracked: true }, '\r', { running: true }).record, null);
    // Claude exits; the shell's "D" starts a fresh line, and that one is recorded.
    const atPrompt = typeInto(NEW_LINE, [...'ls -la', '\r']);
    assert.deepEqual(atPrompt.recorded, ['ls -la']);
  });

  test('SL-04: typing into a running program ranks nothing', () => {
    for (const key of [...'git', '한']) {
      assert.equal(trackInput(NEW_LINE, key, { running: true }).rank, false, key);
    }
  });
});

describe('Suggestion layer: a key is taken only when something is drawn', () => {
  test('SL-10: Esc with nothing on screen goes to the program', () => {
    // `visible`, one candidate, not a prefix of what was typed: no ghost, and a
    // single item draws no popup.
    const nothing = state('gs', ['git push']);
    assert.deepEqual(drawnSuggestion(nothing), { ghost: false, popup: false });
    assert.equal(suggestionKeyAction(nothing, keydown('Escape')).action, 'pass');
    // Ranked but still waiting for the echo: not drawn either.
    const waiting = { ...state('git st', GIT_ST), visible: false };
    for (const key of KEYS) assert.equal(suggestionKeyAction(waiting, keydown(key)).action, 'pass', key);
  });

  test('SL-11: Esc dismisses a ghost or a popup that is actually drawn', () => {
    assert.deepEqual(suggestionKeyAction(state('git sta', ['git status']), keydown('Escape')), {
      action: 'dismiss',
      consume: true,
    });
    assert.equal(suggestionKeyAction(state('gs', ['git push', 'git stash']), keydown('Escape')).action, 'dismiss');
  });

  test('SL-12: ↑/↓ move the highlight only while the popup is drawn, wrapping at both ends', () => {
    const ghostOnly = state('git sta', ['git status']);
    assert.equal(suggestionKeyAction(ghostOnly, keydown('ArrowUp')).action, 'pass', 'history, not the layer');
    assert.equal(suggestionKeyAction(ghostOnly, keydown('ArrowDown')).action, 'pass');
    const popup = state('git st', GIT_ST);
    assert.deepEqual(suggestionKeyAction(popup, keydown('ArrowDown')), { action: 'move', selectedIndex: 1, consume: true });
    assert.deepEqual(suggestionKeyAction(popup, keydown('ArrowUp')), { action: 'move', selectedIndex: 2, consume: true });
    assert.equal(suggestionKeyAction({ ...popup, selectedIndex: 2 }, keydown('ArrowDown')).selectedIndex, 0);
  });

  test('SL-13: Tab is never taken — not with a ghost, a popup, or a moved highlight', () => {
    for (const s of [
      state('git sta', ['git status']),
      state('git st', GIT_ST),
      state('git st', GIT_ST, { selectedIndex: 2, moved: true }),
    ]) {
      assert.deepEqual(suggestionKeyAction(s, keydown('Tab')), { action: 'pass', consume: false });
      assert.deepEqual(suggestionKeyAction(s, keydown('Tab', { shiftKey: true })), { action: 'pass', consume: false });
    }
  });

  test('SL-14: Enter runs the line — it closes the popup and goes on, never accepting', () => {
    assert.deepEqual(suggestionKeyAction(state('git st', GIT_ST), keydown('Enter')), { action: 'clear', consume: false });
    assert.equal(suggestionKeyAction(state('git sta', ['git status']), keydown('Enter')).action, 'pass');
  });

  test('SL-15: keyups and keypresses are never the layer\'s', () => {
    const s = state('git st', GIT_ST);
    for (const type of ['keyup', 'keypress']) {
      assert.equal(suggestionKeyAction(s, { type, key: 'ArrowRight' }).action, 'pass', type);
    }
  });
});

describe('Suggestion layer: → accepts', () => {
  test('SL-20: → types the rest of the ghost when the highlight was not moved', () => {
    const s = state('git st', GIT_ST);
    assert.deepEqual(suggestionKeyAction(s, keydown('ArrowRight')), {
      action: 'accept',
      text: 'atus',
      index: 0,
      consume: true,
    });
  });

  test('SL-21: → types the highlighted item once ↑/↓ moved it — even with no ghost', () => {
    const s = state('git st', GIT_ST, { selectedIndex: 2, moved: true });
    assert.equal(suggestionKeyAction(s, keydown('ArrowRight')).text, 'ash pop');
    // A subsequence match on top draws no ghost; a prefix match further down
    // can still be chosen.
    const noGhost = state('gs', ['git push', 'gsutil ls'], { selectedIndex: 1, moved: true });
    assert.equal(noGhost.ghost, '');
    assert.deepEqual(suggestionKeyAction(noGhost, keydown('ArrowRight')), {
      action: 'accept',
      text: 'util ls',
      index: 1,
      consume: true,
    });
  });

  test('SL-22: → with no ghost and an unmoved highlight is the shell\'s cursor key', () => {
    assert.equal(suggestionKeyAction(state('gs', ['git push', 'git stash']), keydown('ArrowRight')).action, 'pass');
  });

  test('SL-23: → on a highlighted candidate that does not continue the line types nothing and goes on', () => {
    const s = state('gs', ['gsutil ls', 'git push'], { selectedIndex: 1, moved: true });
    assert.deepEqual(suggestionKeyAction(s, keydown('ArrowRight')), { action: 'clear', consume: false });
  });

  test('SL-24: the accept is measured against the text the items were ranked for', () => {
    // The live line was dropped by the ↓ that moved the highlight; the popup
    // still says what it was ranked against.
    const s = state('git st', GIT_ST, { selectedIndex: 1, moved: true });
    assert.equal(s.typed, 'git st');
    assert.equal(suggestionKeyAction(s, keydown('ArrowRight')).text, 'ash');
  });
});

describe('Suggestion layer: a taken key drops the line', () => {
  test('SL-30: every key the layer takes leaves the line empty and untracked', () => {
    const line = { buffer: 'git st', tracked: true };
    const decisions = [
      suggestionKeyAction(state('git st', GIT_ST), keydown('ArrowRight')),
      suggestionKeyAction(state('git st', GIT_ST), keydown('ArrowDown')),
      suggestionKeyAction(state('git st', GIT_ST), keydown('Escape')),
    ];
    for (const decision of decisions) {
      assert.equal(decision.consume, true, decision.action);
      assert.deepEqual(lineAfterKey(line, decision), LOST_LINE, decision.action);
    }
  });

  test('SL-31: a key that goes on leaves the line alone', () => {
    const line = { buffer: 'git st', tracked: true };
    for (const decision of [
      suggestionKeyAction(state('git st', GIT_ST), keydown('Tab')),
      suggestionKeyAction(state('git st', GIT_ST), keydown('Enter')),
      suggestionKeyAction(state('gs', ['gsutil ls', 'git push'], { selectedIndex: 1, moved: true }), keydown('ArrowRight')),
    ]) {
      assert.equal(lineAfterKey(line, decision), line, decision.action);
    }
  });

  test('SL-32: after a taken key nothing more is ranked or recorded for that line; the next line is followed again', () => {
    const after = typeInto(LOST_LINE, [...'atus', '\x7f']);
    assert.deepEqual(after.line, LOST_LINE);
    assert.equal(trackInput(LOST_LINE, 'x').rank, false);
    const { recorded } = typeInto(LOST_LINE, [...'atus', '\r', ...'pwd', '\r']);
    assert.deepEqual(recorded, ['pwd'], 'not `atus` — the line it belonged to was lost');
  });
});

describe('Suggestion layer: following the line', () => {
  test('SL-40: typing extends and ranks, Backspace shortens, Enter records the trimmed line, ^C starts over', () => {
    let r = trackInput(NEW_LINE, 'g');
    assert.deepEqual(r, { line: { buffer: 'g', tracked: true }, record: null, rank: true });
    r = trackInput(r.line, 'x');
    r = trackInput(r.line, '\x7f');
    assert.deepEqual(r.line, { buffer: 'g', tracked: true });
    assert.equal(r.rank, true);
    assert.deepEqual(typeInto(NEW_LINE, [...'  git status ', '\r']).recorded, ['git status']);
    assert.deepEqual(trackInput({ buffer: 'git', tracked: true }, '\x03'), { line: NEW_LINE, record: null, rank: false });
  });

  test('SL-41: Tab completion, Esc, ^U, an arrow or a bracketed paste lose the line instead of recording half of it', () => {
    for (const key of ['\t', '\x1b', '\x15', '\x17', '\x1b[D', '\x1b[A', '\x1b[200~ls\x1b[201~', 'a\tb']) {
      const { line, recorded } = typeInto(NEW_LINE, [...'git che', key, ...'main', '\r']);
      assert.deepEqual(recorded, [], `${JSON.stringify(key)}: \`git che…main\` is not what ran`);
      assert.deepEqual(line, NEW_LINE, 'and the next line is followed again');
    }
  });

  test('SL-42: Korean syllables from the IME binding are followed like any other key', () => {
    const { line, recorded } = typeInto(NEW_LINE, ['e', 'c', 'h', 'o', ' ', '한', '글']);
    assert.deepEqual(line, { buffer: 'echo 한글', tracked: true });
    assert.deepEqual(recorded, []);
    assert.equal(trackInput(line, '\x7f').line.buffer, 'echo 한', 'the binding\'s DEL takes one back');
    assert.deepEqual(typeInto(line, ['\r']).recorded, ['echo 한글']);
  });

  test('SL-43: a one-line paste of plain text extends the line', () => {
    assert.deepEqual(trackInput({ buffer: 'cd ', tracked: true }, '~/src/app'), {
      line: { buffer: 'cd ~/src/app', tracked: true },
      record: null,
      rank: true,
    });
  });
});

describe('Suggestion layer: what a ranking shows', () => {
  test('SL-50: the ghost is the rest of the top candidate, only when it continues the typed text', () => {
    assert.equal(rankedSuggestions('git st', GIT_ST).ghost, 'atus');
    assert.equal(rankedSuggestions('GIT ST', GIT_ST).ghost, 'atus', 'case-insensitive, as matching is');
    assert.equal(rankedSuggestions('gs', ['git push']).ghost, '', 'a subsequence match has no ghost');
    assert.deepEqual(rankedSuggestions('git st', GIT_ST), {
      typed: 'git st',
      ghost: 'atus',
      items: GIT_ST,
      selectedIndex: 0,
      moved: false,
    });
  });

  test('SL-51: a ghost and a popup are drawn only when visible', () => {
    assert.deepEqual(drawnSuggestion(state('git st', GIT_ST)), { ghost: true, popup: true });
    assert.deepEqual(drawnSuggestion(state('git sta', ['git status'])), { ghost: true, popup: false });
    assert.deepEqual(drawnSuggestion({ ...state('git st', GIT_ST), visible: false }), { ghost: false, popup: false });
    assert.deepEqual(drawnSuggestion(undefined), { ghost: false, popup: false });
  });
});
