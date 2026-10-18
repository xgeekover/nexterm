/**
 * What each row of the TERMINALS side bar says about its terminal (stage 2,
 * S2–S8): one state per terminal, the agent running in it, the last thing it
 * told you, a group's summary, the attention order and the branch name as it
 * may be shown. All of it pure, in src/lib/terminalStatus.js, so the side bar
 * and the group switcher cannot disagree about the same terminal.
 *
 * The branch itself is read by the backend (`git_branch`, src-tauri/src/fs/
 * git.rs, with its own cases) and kept per folder by src/stores/
 * branchStore.js (branch_store.test.js).
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as statusLib from '../../src/lib/terminalStatus.js';
import { aggregateProgress } from '../../src/lib/terminalProgress.js';
import { useSettingsStore, SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import * as terminalStoreLib from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';

const {
  STATUS_GLYPHS,
  BRANCH_NAME_MAX,
  terminalStatus,
  statusText,
  agentLabel,
  agentRuns,
  lastNoteFor,
  noteLine,
  noteTooltip,
  agoLabel,
  groupStatus,
  groupSummaryItems,
  groupSummaryLabel,
  attentionRank,
  groupAttentionRank,
  sortByAttention,
  cleanBranchName,
  branchLabel,
  branchTitle,
} = statusLib;

const bar = (state, value = null) => ({ state, value });
const tab = (over = {}) => ({ id: 't1', title: 'Terminal 1', running: false, lastExitCode: null, exited: null, agent: null, ...over });
const stateOf = (t, opts) => terminalStatus(t, opts)?.state;

describe('Terminal status: one state per terminal (S2)', () => {
  test('TS-01: every state on its own', () => {
    assert.equal(stateOf(tab()), 'none', 'a prompt, waiting for nobody');
    assert.equal(stateOf(tab({ exited: { code: 0 } })), 'exited');
    assert.equal(stateOf(tab(), { unread: 2 }), 'waiting');
    assert.equal(stateOf(tab(), { progress: bar('error', 60) }), 'error');
    assert.equal(stateOf(tab(), { progress: bar('normal', 40) }), 'progress');
    assert.equal(stateOf(tab(), { progress: bar('warning', 40) }), 'progress', 'a warning is a paused bar');
    assert.equal(stateOf(tab(), { progress: bar('indeterminate') }), 'working');
    assert.equal(stateOf(tab({ running: true })), 'running');
    assert.equal(stateOf(tab({ lastExitCode: 1 })), 'failed');
    assert.equal(stateOf(tab({ lastExitCode: 0 })), 'none', 'a success is nothing to report');
    assert.equal(stateOf(tab({ lastExitCode: null })), 'none', "cmd's end without a code is no verdict");
  });

  test('TS-02: first match wins — exited, waiting, error, progress, working, running, failed', () => {
    // Every pair, the earlier one present alongside everything after it.
    const all = { exited: { code: 1 }, running: true, lastExitCode: 2 };
    const cases = [
      [tab(all), { unread: 1, progress: bar('error', 5) }, 'exited'],
      [tab({ running: true, lastExitCode: 2 }), { unread: 1, progress: bar('error', 5) }, 'waiting'],
      [tab(), { unread: 1, progress: bar('normal', 5) }, 'waiting'],
      [tab(), { unread: 1, progress: bar('warning', 5) }, 'waiting'],
      [tab(), { unread: 1, progress: bar('indeterminate') }, 'waiting'],
      [tab({ running: true }), { unread: 1 }, 'waiting'],
      [tab({ lastExitCode: 1 }), { unread: 1 }, 'waiting'],
      [tab({ lastExitCode: 1 }), { progress: bar('indeterminate') }, 'working'],
      [tab({ lastExitCode: 1 }), { progress: bar('normal', 5) }, 'progress'],
      [tab({ running: true, lastExitCode: 2 }), { unread: 0, progress: bar('error', 5) }, 'error'],
      [tab({ running: true, lastExitCode: 2 }), { progress: bar('normal', 5) }, 'progress'],
      [tab({ running: true, lastExitCode: 2 }), { progress: bar('warning', 5) }, 'progress'],
      [tab({ running: true, lastExitCode: 2 }), { progress: bar('indeterminate') }, 'working'],
      [tab({ running: true, lastExitCode: 2 }), {}, 'running'],
      [tab({ running: false, lastExitCode: 2 }), {}, 'failed'],
      // A dead shell with unread entries is still dead: its scrollback is all
      // that is left, and the entries are waiting in the bell anyway.
      [tab({ exited: { code: null } }), { unread: 9 }, 'exited'],
      // Waiting is the stage 1 signal and nothing else: a failure, a bar or a
      // running command never means waiting.
      [tab({ lastExitCode: 1 }), { unread: 0 }, 'failed'],
    ];
    for (const [t, opts, want] of cases) {
      assert.equal(stateOf(t, opts), want, `${JSON.stringify({ t, opts })}`);
    }
  });

  test('TS-03: no tab, no options, nonsense in them — never a throw, never a made-up state', () => {
    assert.equal(stateOf(null), 'none');
    assert.equal(stateOf(undefined, undefined), 'none');
    assert.equal(stateOf(tab(), null), 'none');
    assert.equal(stateOf(tab(), { unread: NaN }), 'none');
    assert.equal(stateOf(tab(), { unread: -3 }), 'none');
    assert.equal(stateOf(tab(), { unread: '2' }), 'none', 'a count is a number');
    assert.equal(stateOf(tab(), { progress: bar('remove') }), 'none', 'a removal is never a bar');
    assert.equal(stateOf(tab(), { progress: { state: 'toString' } }), 'none');
    assert.equal(stateOf(tab(), { progress: 'normal' }), 'none');
    assert.equal(stateOf(tab({ lastExitCode: '1' })), 'none', 'not a code the shell gave');
    const none = terminalStatus(null);
    assert.equal(none.word, '');
    assert.equal(none.glyph, '');
    assert.equal('value' in none, false);
  });

  test('TS-04: each state has a word and a glyph — the colour never carries it alone', () => {
    const shown = {
      exited: terminalStatus(tab({ exited: { code: 0 } })),
      waiting: terminalStatus(tab(), { unread: 1 }),
      error: terminalStatus(tab(), { progress: bar('error') }),
      progress: terminalStatus(tab(), { progress: bar('normal', 1) }),
      paused: terminalStatus(tab(), { progress: bar('warning', 1) }),
      working: terminalStatus(tab(), { progress: bar('indeterminate') }),
      running: terminalStatus(tab({ running: true })),
      failed: terminalStatus(tab({ lastExitCode: 3 })),
    };
    const words = Object.values(shown).map((s) => s.word);
    const glyphs = Object.values(shown).map((s) => s.glyph);
    for (const [name, s] of Object.entries(shown)) {
      assert.ok(typeof s.word === 'string' && /^[A-Z][a-z ]+$/.test(s.word), `${name}: an English word, got ${JSON.stringify(s.word)}`);
      assert.ok(typeof s.glyph === 'string' && s.glyph.length > 0, `${name}: a glyph`);
      // No emoji: a colour emoji would carry a colour of its own, and its
      // width differs per platform.
      assert.equal(/\p{Extended_Pictographic}/u.test(s.glyph) && !/^[\u{25A0}-\u{25FF}\u{2010}-\u{2027}!]$/u.test(s.glyph), false, `${name}: ${s.glyph}`);
    }
    assert.equal(new Set(words).size, words.length, `the words differ: ${words}`);
    assert.equal(new Set(glyphs).size, glyphs.length, `the glyphs differ: ${glyphs}`);
    assert.equal(shown.paused.word, 'Paused', 'a warning reads "paused"');
    assert.equal(shown.paused.paused, true);
    assert.equal(shown.progress.paused, undefined);
    // The table the side bar draws its legend from says the same.
    for (const [state, glyph] of Object.entries(STATUS_GLYPHS)) {
      const s = state === 'paused' ? shown.paused : shown[state];
      assert.ok(s, `STATUS_GLYPHS has an unknown state ${state}`);
      assert.equal(s.glyph, glyph, state);
    }
    assert.deepEqual(Object.keys(STATUS_GLYPHS).sort(), Object.keys(shown).sort());
    // The same state comes back the same object, so a selector of it can
    // compare by identity.
    assert.equal(terminalStatus(tab({ running: true })), terminalStatus(tab({ running: true, title: 'x' })));
    assert.equal(Object.isFrozen(shown.running), true);
  });

  test('TS-05: a bar carries its amount; an indeterminate one has none', () => {
    assert.equal(terminalStatus(tab(), { progress: bar('normal', 42) }).value, 42);
    assert.equal(terminalStatus(tab(), { progress: bar('warning', 7) }).value, 7);
    assert.equal(terminalStatus(tab(), { progress: bar('error', 60) }).value, 60, 'a build failing at 60% stays at 60%');
    assert.equal('value' in terminalStatus(tab(), { progress: bar('error') }), false, 'no amount, no value');
    assert.equal('value' in terminalStatus(tab(), { progress: bar('warning', null) }), false);
    assert.equal('value' in terminalStatus(tab(), { progress: bar('indeterminate', 50) }), false);
    assert.equal(terminalStatus(tab(), { progress: bar('normal', 250) }).value, 100, 'held at 100');
    assert.equal(terminalStatus(tab(), { progress: bar('normal', -5) }).value, 0);
    assert.equal(terminalStatus(tab(), { progress: bar('normal', 33.6) }).value, 34);
    assert.equal('value' in terminalStatus(tab(), { progress: bar('normal', NaN) }), false);
    // In words, for a tooltip and a screen reader.
    assert.equal(statusText(terminalStatus(tab(), { progress: bar('normal', 42) })), 'In progress 42%');
    assert.equal(statusText(terminalStatus(tab(), { progress: bar('warning', 7) })), 'Paused 7%');
    assert.equal(statusText(terminalStatus(tab({ running: true }))), 'Running');
    assert.equal(statusText(terminalStatus(tab())), '');
    assert.equal(statusText(null), '');
  });
});

describe('Terminal status: the agent (S2)', () => {
  // An agent typed at a prompt into the shell the tab has now: what the
  // store records for one it started, resumed, or saw typed by hand.
  const running = (kind, over = {}) =>
    tab({ sessionId: 's1', agent: { kind, sessionId: null }, agentResumeOffered: false, agentTyped: { sessionId: 's1' }, ...over });

  test('TS-06: named while the agent is believed to run, and only for the agents this build knows', () => {
    assert.equal(agentLabel(running('claude')), 'Claude Code');
    assert.equal(agentLabel(running('opencode')), 'OpenCode');
    assert.equal(agentLabel(running('claude', { agent: null })), '', 'the record ended with the agent');
    assert.equal(agentLabel(running('aider')), '');
    for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(agentLabel(running(kind)), '', kind);
    }
    assert.equal(agentLabel(null), '');
    assert.equal(agentLabel({}), '');
  });

  test('TS-18: not believed to run — offered back after a restart, typed with no prompt to go by, in an old shell, in a dead one', () => {
    assert.equal(agentRuns(running('claude')), true, 'premise');
    // Restored with the app: the record is what WAS running, offered back over
    // a plain shell until Resume is pressed.
    assert.equal(agentLabel(running('claude', { agentResumeOffered: true })), '', 'offered back');
    assert.equal(agentLabel(running('claude', { agentResumeOffered: true, agentTyped: undefined })), '', 'offered back, as restored');
    // `startAgent` whose shell drew no prompt in time: typed blind, nothing
    // watches it end — it may never have started (exit 127) and the record
    // would say "Claude Code" over a shell for good.
    assert.equal(agentLabel(running('claude', { agentTyped: null })), '', 'typed with no prompt to go by');
    assert.equal(agentLabel(running('claude', { agentTyped: undefined })), '');
    // Typed into a shell that has since been replaced.
    assert.equal(agentLabel(running('claude', { agentTyped: { sessionId: 's0' } })), '', 'an older shell');
    assert.equal(agentLabel(running('claude', { exited: { code: 0 } })), '', 'the shell is gone');
    assert.equal(agentRuns(running('claude', { agentTyped: null })), false);
    assert.equal(agentRuns(null), false);
  });
});

describe('Terminal status: the last notification (S3)', () => {
  const list = [
    { id: 'n4', tabId: 't2', kind: 'program', title: 'Other', body: '', at: 400, read: false },
    { id: 'n3', tabId: 't1', kind: 'program', title: 'Session done', body: 'Build finished', at: 300, read: true },
    { id: 'n2', tabId: 't1', kind: 'bell', title: 'Terminal 1', tabTitle: 'Terminal 1', count: 3, at: 200, read: false },
    { id: 'n1', tabId: 't1', exitCode: 1, title: 'Terminal 1', durationMs: 65_000, at: 100, read: false },
  ];

  test('TS-07: the newest entry of the tab, read or unread', () => {
    assert.equal(lastNoteFor(list, 't1')?.id, 'n3', 'read entries count: it is still the last thing said');
    assert.equal(lastNoteFor(list, 't2')?.id, 'n4');
    assert.equal(lastNoteFor(list, 't3'), null);
    // By time, not by place: an entry filed later under an earlier time.
    const shuffled = [list[3], list[1], list[2]];
    assert.equal(lastNoteFor(shuffled, 't1')?.id, 'n3');
    // Two at the same moment: the one higher in the list (newest first).
    const tie = [
      { id: 'a', tabId: 't1', at: 5 },
      { id: 'b', tabId: 't1', at: 5 },
    ];
    assert.equal(lastNoteFor(tie, 't1').id, 'a');
    assert.equal(lastNoteFor(null, 't1'), null);
    assert.equal(lastNoteFor([null, undefined, 3], 't1'), null);
    assert.equal(lastNoteFor(list, undefined), null);
  });

  test('TS-08: one line — "title — body", the bell and a finished command in words', () => {
    const dash = '\u{2014}';
    assert.equal(noteLine(list[1]), `Session done ${dash} Build finished`);
    assert.equal(noteLine({ kind: 'program', title: 'Permission needs input', body: '' }), 'Permission needs input');
    // A program that gave no title is titled after its terminal, which the
    // row already shows on its first line.
    assert.equal(noteLine({ kind: 'program', title: 'Terminal 1', tabTitle: 'Terminal 1', body: 'Ready' }), 'Ready');
    assert.equal(noteLine({ kind: 'program', title: 'Terminal 1', tabTitle: 'Terminal 1', body: '' }), 'Terminal 1');
    assert.equal(noteLine({ kind: 'program', title: ' terminal 1 ', tabTitle: 'Terminal 1', body: 'Ready' }), 'Ready', 'trimmed, any case');
    // Nor is the agent's own name news on a line that already names the
    // agent (`agentShown`): it pushed the message out of sight. On a line
    // that does not, it is the only thing saying who spoke, and stays.
    const shown = { agentShown: true };
    for (const name of ['Claude Code', 'claude code', ' OpenCode ', 'opencode', 'Claude']) {
      const note = { kind: 'program', title: name, tabTitle: 'Terminal 1', body: 'Permission needs input' };
      assert.equal(noteLine(note, shown), 'Permission needs input', name);
      assert.equal(noteLine(note), `${name.trim()} \u{2014} Permission needs input`, `${name}: the agent is named nowhere else on the line`);
      assert.equal(noteLine(note, { agentShown: false }), `${name.trim()} \u{2014} Permission needs input`);
    }
    assert.equal(noteLine({ kind: 'program', title: 'Claude Code', body: '' }, shown), 'Claude Code', 'with nothing else to say, the name is the line');
    assert.equal(noteLine({ kind: 'program', title: 'Claude Codex', body: 'x' }, shown), 'Claude Codex \u{2014} x', 'only the name itself');
    assert.equal(noteLine({ kind: 'program', title: 'Terminal 1', tabTitle: 'Terminal 1', body: 'Ready' }, { agentShown: false }), 'Ready', "the terminal's own name goes either way");
    assert.equal(noteLine(list[2]), 'Bell \u{00d7}3');
    assert.equal(noteLine({ kind: 'bell', count: 1 }), 'Bell');
    assert.equal(noteLine(list[3]), 'Command failed (exit 1) after 1m 5s');
    assert.equal(noteLine({ exitCode: 0, durationMs: 12_000 }), 'Command finished after 12s');
    assert.equal(noteLine({ exitCode: null, durationMs: 12_000 }), 'Command finished after 12s', "cmd's end is no verdict");
    assert.equal(noteLine({ exitCode: 0 }), 'Command finished');
    assert.equal(noteLine(null), '');
    // Cleaned again, whatever put it there: no control or bidirectional
    // character, one line.
    const hostile = noteLine({ kind: 'program', title: 'a\u{202e}b\u{0007}', body: 'x\ny\u{2066}z' });
    assert.equal(hostile, `ab ${dash} x yz`);
  });

  test('TS-09: the tooltip carries the whole text and how long ago it came', () => {
    const now = 1_000_000;
    assert.equal(
      noteTooltip({ kind: 'program', title: 'Terminal 1', tabTitle: 'Terminal 1', body: 'Ready', at: now - 3 * 60_000 }, now),
      `Terminal 1 \u{2014} Ready\n3m ago`,
      'the whole text: the title too'
    );
    assert.equal(noteTooltip({ kind: 'bell', count: 2, at: now - 2_000 }, now), 'Bell \u{00d7}2\njust now');
    assert.equal(noteTooltip({ kind: 'program', title: 'T', body: '', at: undefined }, now), 'T', 'no time, no age');
    assert.equal(noteTooltip(null, now), '');
    assert.equal(agoLabel(0), 'just now');
    assert.equal(agoLabel(44_000), 'just now');
    assert.equal(agoLabel(60_000), '1m ago');
    assert.equal(agoLabel(59 * 60_000), '59m ago');
    assert.equal(agoLabel(2 * 3_600_000), '2h ago');
    assert.equal(agoLabel(3 * 86_400_000), '3d ago');
    assert.equal(agoLabel(-5), 'just now', 'a clock that moved back is not the future');
    assert.equal(agoLabel(NaN), '');
  });
});

describe('Terminal status: a group in one line (S6)', () => {
  const tabs = [
    tab({ id: 'a' }),
    tab({ id: 'b', running: true }),
    tab({ id: 'c', lastExitCode: 1 }),
    tab({ id: 'd' }),
    tab({ id: 'e' }),
    tab({ id: 'f', exited: { code: 0 } }),
    tab({ id: 'g' }),
    tab({ id: 'h', running: true }),
  ];
  const unread = { a: 2, h: 1, f: 4 };
  const progress = { d: bar('normal', 30), e: bar('indeterminate'), g: bar('error', 80), b: bar('normal', 10) };

  test('TS-10: waiting, running (with progress and working) and failed (with error), each terminal once', () => {
    const s = groupStatus(tabs, unread, progress);
    // a: waiting; h: waiting over running; b: progress; d: progress; e: working;
    // c: failed; g: error; f: exited — counted nowhere.
    assert.equal(s.waiting, 2);
    assert.equal(s.running, 3);
    assert.equal(s.failed, 2);
    assert.deepEqual(s.progress, aggregateProgress(Object.values(progress)), "stage 1's rule");
    assert.deepEqual(s.progress, bar('error', 80));
    assert.deepEqual(groupStatus([], {}, {}), { waiting: 0, running: 0, failed: 0, progress: null });
    assert.deepEqual(groupStatus(null, null, null), { waiting: 0, running: 0, failed: 0, progress: null });
    assert.deepEqual(groupStatus([null, tab({ id: 'z' })], undefined, undefined), { waiting: 0, running: 0, failed: 0, progress: null });
  });

  test('TS-11: the summary shows the counts that are not zero, as glyph and number, in words for the tooltip', () => {
    const items = groupSummaryItems({ waiting: 2, running: 0, failed: 1 });
    assert.deepEqual(items.map((i) => [i.key, i.count]), [['waiting', 2], ['failed', 1]]);
    assert.equal(items[0].glyph, STATUS_GLYPHS.waiting);
    assert.equal(items[1].glyph, STATUS_GLYPHS.failed);
    assert.equal(items[0].label, '2 waiting');
    assert.equal(groupSummaryLabel({ waiting: 2, running: 3, failed: 1 }), '2 waiting, 3 running, 1 failed');
    assert.equal(groupSummaryLabel({ waiting: 0, running: 1, failed: 0 }), '1 running');
    assert.equal(groupSummaryLabel({ waiting: 0, running: 0, failed: 0 }), '');
    assert.equal(groupSummaryLabel(null), '');
    assert.deepEqual(groupSummaryItems(undefined), []);
  });
});

describe('Terminal status: sorted by attention (S7)', () => {
  test('TS-12: waiting, then error and failed, then running, progress and working, then idle, then exited', () => {
    const order = ['waiting', 'error', 'failed', 'running', 'progress', 'working', 'none', 'exited'];
    const ranks = order.map((s) => attentionRank(s));
    assert.deepEqual(ranks, [0, 1, 1, 2, 2, 2, 3, 4]);
    assert.equal(attentionRank(terminalStatus(tab(), { unread: 1 })), 0, 'a status object as well as its state');
    assert.equal(attentionRank(terminalStatus(tab({ exited: { code: 0 } }))), 4);
    assert.equal(attentionRank(null), 3, 'nothing known is idle');
    assert.equal(attentionRank('constructor'), 3);
  });

  test('TS-13: stable — ties keep the user order; the input is never reordered', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `t${i}`);
    // Every third waiting, every fifth exited, the rest idle: long runs of
    // ties on both sides of each rank.
    const rank = (id) => {
      const n = Number(id.slice(1));
      if (n % 3 === 0) return 0;
      if (n % 5 === 0) return 4;
      return 3;
    };
    const input = Object.freeze([...ids]);
    const sorted = sortByAttention(input, rank);
    assert.notEqual(sorted, input);
    assert.deepEqual(input, ids, 'the store order is left alone');
    const expected = [...ids.filter((id) => rank(id) === 0), ...ids.filter((id) => rank(id) === 3), ...ids.filter((id) => rank(id) === 4)];
    assert.deepEqual(sorted, expected);
    // Already in order: the same array back, so a memo of it holds.
    const inOrder = ['a', 'b', 'c'];
    assert.equal(sortByAttention(inOrder, () => 1), inOrder);
    assert.deepEqual(sortByAttention([], rank), []);
    assert.deepEqual(sortByAttention(null, rank), []);
    // A rank that is not a number is idle, not first or last.
    assert.deepEqual(sortByAttention(['x', 'y', 'z'], (id) => ({ x: undefined, y: 0, z: 4 })[id]), ['y', 'x', 'z']);
  });

  test('TS-14: a group ranks by its most urgent terminal', () => {
    const tabs = [tab({ id: 'a' }), tab({ id: 'b', lastExitCode: 1 }), tab({ id: 'c', exited: { code: 0 } })];
    assert.equal(groupAttentionRank(tabs, {}, {}), 1);
    assert.equal(groupAttentionRank(tabs, { a: 1 }, {}), 0);
    assert.equal(groupAttentionRank([tab({ id: 'c', exited: { code: 0 } })], {}, {}), 4, 'all exited');
    assert.equal(groupAttentionRank([], {}, {}), 3, 'an empty group is idle');
    assert.equal(groupAttentionRank(null), 3);
  });
});

describe('Terminal status: a branch name as it may be shown (S4)', () => {
  // The same vectors as `a_branch_name_must_pass_git_and_show_as_it_is` in
  // src-tauri/src/fs/git.rs: the backend checks the name before it leaves,
  // and the store checks what it is handed again, so the two must agree. A
  // name git would refuse, or one holding a character that does not show, is
  // no name; a long one is cut.
  const x = (n) => 'x'.repeat(n);
  const KEPT = [
    ['main', 'main'],
    ['feature/x', 'feature/x'],
    ['fix-1.2_b+c=d,e', 'fix-1.2_b+c=d,e'],
    ['\u{d55c}\u{ae00}/\u{bd84}\u{b79c}\u{ce58}', '\u{d55c}\u{ae00}/\u{bd84}\u{b79c}\u{ce58}'],
    ['zw\u{200d}j', 'zw\u{200d}j'],
    ['\u{1f600}', '\u{1f600}'],
    ['HEAD', 'HEAD'],
    [x(100), x(100)],
    [x(101), `${x(99)}\u{2026}`],
    ['\u{d55c}'.repeat(150), `${'\u{d55c}'.repeat(99)}\u{2026}`],
    ['\u{1f600}'.repeat(120), `${'\u{1f600}'.repeat(99)}\u{2026}`],
  ];
  const REFUSED = [
    '', 'a\u{0000}b', 'a\u{001b}[31mb', 'a\u{007f}b', 'x\u{0085}y', 'x\u{009f}y',
    'evil\u{202e}gnp.exe', '\u{2066}x\u{2069}', 'a\u{200e}b', 'a\u{200f}b', 'a\u{061c}b',
    'line\u{2028}sep', 'para\u{2029}sep',
    'a\u{200b}b', '\u{feff}main', 'soft\u{00ad}hyphen', 'word\u{2060}joiner', 'tag\u{e0041}',
    '\u{e0001}x', 'hangul\u{3164}', '\u{115f}x', 'x\u{1160}', 'half\u{ffa0}width',
    'a..b', 'a b', 'a\tb', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[0]', 'a\\b',
    '-x', '/x', 'x/', 'x.', 'x.lock', 'a.lock/b', 'a/.b', '.x', 'a@{1}', 'a//b', '@',
  ];

  test('TS-15: a name git would take and that shows as it is, 100 characters at most; anything else is none', () => {
    assert.equal(BRANCH_NAME_MAX, 100);
    for (const [given, want] of KEPT) assert.equal(cleanBranchName(given), want, JSON.stringify(given).slice(0, 60));
    for (const given of REFUSED) assert.equal(cleanBranchName(given), '', JSON.stringify(given));
    for (const nonsense of [null, undefined, 42, {}, ['main']]) assert.equal(cleanBranchName(nonsense), '');
    // Counted by code point: an emoji is never cut in half.
    const cut = cleanBranchName('\u{1f600}'.repeat(120));
    assert.equal(Array.from(cut).length, 100);
    assert.equal(/[\u{d800}-\u{dfff}]/u.test(cut), false);
    // Something absurd costs no more than something reasonable: only its
    // start is looked at, as the backend reads at most 4 KB of HEAD.
    assert.equal(Array.from(cleanBranchName('y'.repeat(5_000_000))).length, 100);
    assert.equal(cleanBranchName(`${'\u{0007}'.repeat(5_000)}tail`), '', 'what follows the first 4 KB is never read');
  });

  test('TS-16: a branch by name, a detached head by its commit', () => {
    assert.equal(branchLabel({ branch: 'main', detached: false }), 'main');
    assert.equal(branchLabel({ branch: 'abc1234', detached: true }), 'abc1234');
    assert.equal(branchTitle({ branch: 'main', detached: false }), 'Branch main');
    assert.equal(branchTitle({ branch: 'abc1234', detached: true }), 'Detached HEAD at abc1234');
    assert.equal(branchLabel({ branch: 'evil\u{202e}x', detached: false }), '', 'checked again: a name that does not show as it is, is none');
    assert.equal(branchTitle({ branch: 'evil\u{202e}x', detached: false }), '');
    assert.equal(branchLabel(null), '');
    assert.equal(branchTitle(null), '');
    assert.equal(branchLabel({ branch: 7 }), '');
    assert.equal(branchLabel({ branch: '\u{0007}' }), '');
  });
});

// ---- The agent, through the store's own records -------------------------------

const T = terminalStoreLib.useTerminalStore;
const backing = new Map();
const disk = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabNow = (id) => T.getState().tabs.find((t) => t.id === id);
/** The shell drew a prompt (OSC 133 D), or ended one with `code`. */
const promptIn = (t, code = 0) => mockBridge.emit('pty-command-done', { session_id: t.sessionId, exit_code: code });
const startedIn = (t) => mockBridge.emit('pty-command-started', { session_id: t.sessionId });

/**
 * What is typed into a terminal while `fn` runs, held as a busy shell holds a
 * line: the mock's own pretend shell would otherwise run `claude` at once and
 * end it.
 */
async function holdingWrites(fn) {
  const original = mockBridge.invoke;
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write') return Promise.resolve(null);
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
}

/** `fn` with this file's storage, a store started from `seed` (a saved workspace) or empty, all handed back after. */
async function withStore(seed, fn) {
  // Disposed first, with the storage it was using: disposing writes out a
  // save still pending from whoever used the store last, and written into
  // this file's storage it replaced the seed.
  T.getState().dispose();
  const borrowed = globalThis.localStorage;
  globalThis.localStorage = disk;
  backing.clear();
  if (seed) backing.set(terminalStoreLib.PERSIST_KEY, JSON.stringify({ version: SCHEMA_VERSION, data: seed }));
  const inferring = terminalStoreLib.__setSubmitInfersRunning?.(false);
  T.setState({ tabs: [], activeTabId: null, isInitialized: false, notifications: [], progress: {} });
  try {
    await T.getState().init();
    await holdingWrites(fn);
  } finally {
    T.getState().dispose();
    T.setState({ tabs: [], activeTabId: null, isInitialized: false, notifications: [], progress: {} });
    terminalStoreLib.__setSubmitInfersRunning?.(inferring);
    globalThis.localStorage = borrowed;
  }
}

describe('Terminal status: the agent, from what the store records (S2, revised)', () => {
  test('TS-19: restored with the app, an agent is offered back — and no agent is named over the plain shell', async () => {
    const agent = { kind: 'claude', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', startedAt: 1, title: null };
    const seed = {
      workspaceName: 'Default',
      activeGroupId: 'g',
      groups: [{ id: 'g', name: 'Agents', createdAt: 1, activePaneId: 'p', tree: { type: 'leaf', id: 'p', tabIds: ['t'], activeTabId: 't' } }],
      tabs: [{ id: 't', title: 'Terminal 1', cwd: '/workspace', agent }],
    };
    await withStore(seed, async () => {
      const [restored] = T.getState().tabs;
      assert.equal(restored.agentResumeOffered, true, 'premise: offered back');
      assert.equal(restored.agent?.kind, 'claude', 'premise: the record is kept');
      assert.equal(agentLabel(restored), '');
    });
  });

  test('TS-20: started with no prompt to go by, the agent is not named — not before, not after it fails', async () => {
    await withStore(null, async () => {
      const wait = terminalStoreLib.__setAgentPromptWaitMs(60);
      try {
        const opened = await T.getState().createTab();
        const agent = await T.getState().startAgent(opened.id, 'claude');
        assert.ok(agent, 'premise: typed once the wait was up');
        assert.equal(tabNow(opened.id).agent?.kind, 'claude', 'premise: the record is there');
        assert.equal(agentLabel(tabNow(opened.id)), '', 'nothing says it is running');
        await promptIn(tabNow(opened.id), 127);
        assert.equal(agentLabel(tabNow(opened.id)), '', 'and after `claude: command not found`, still nothing');
      } finally {
        terminalStoreLib.__setAgentPromptWaitMs(wait);
      }
    });
  });

  test('TS-21: started or typed at a prompt, the agent is named while it runs, and not once it has exited', async () => {
    await withStore(null, async () => {
      const opened = await T.getState().createTab();
      await promptIn(tabNow(opened.id));
      await T.getState().startAgent(opened.id, 'claude');
      assert.equal(agentLabel(tabNow(opened.id)), 'Claude Code', 'started by the app');
      await startedIn(tabNow(opened.id));
      assert.equal(agentLabel(tabNow(opened.id)), 'Claude Code');
      await promptIn(tabNow(opened.id), 0);
      assert.equal(agentLabel(tabNow(opened.id)), '', 'it exited');

      await T.getState().writeRaw(opened.id, 'opencode\r');
      await sleep(10);
      assert.equal(agentLabel(tabNow(opened.id)), 'OpenCode', 'typed by hand');
      await startedIn(tabNow(opened.id));
      await promptIn(tabNow(opened.id), 0);
      assert.equal(agentLabel(tabNow(opened.id)), '');
    });
  });
});

describe('Terminal status: an agent typed after one that could not be watched (S2, revised)', () => {
  test('TS-22: a record nothing watches does not stop an agent typed by hand at a real prompt from being recorded and named', async () => {
    // Found in review: a shell whose first prompt took longer than the wait
    // (conda, nvm) got its agent typed blind, unwatched; that agent exited,
    // and every agent typed by hand afterwards went unrecorded — the stale
    // record looked live — so none was ever named.
    await withStore(null, async () => {
      const wait = terminalStoreLib.__setAgentPromptWaitMs(60);
      try {
        const opened = await T.getState().createTab();
        await T.getState().startAgent(opened.id, 'claude');
        assert.equal(tabNow(opened.id).agentTyped, null, 'premise: typed blind, unwatched');
        // The late first prompt, the blind agent running and exiting.
        await promptIn(tabNow(opened.id));
        await startedIn(tabNow(opened.id));
        await promptIn(tabNow(opened.id), 0);
        assert.equal(tabNow(opened.id).agent?.kind, 'claude', 'premise: its record outlived it');
        assert.equal(agentLabel(tabNow(opened.id)), '');

        await T.getState().writeRaw(opened.id, 'opencode\r');
        await sleep(10);
        assert.equal(tabNow(opened.id).agent?.kind, 'opencode', 'the agent typed by hand is recorded');
        assert.equal(agentLabel(tabNow(opened.id)), 'OpenCode', 'and named');
        await startedIn(tabNow(opened.id));
        await promptIn(tabNow(opened.id), 0);
        assert.equal(tabNow(opened.id).agent, null, 'and its exit ends the record');
      } finally {
        terminalStoreLib.__setAgentPromptWaitMs(wait);
      }
    });
  });

  test('TS-23: a live agent, or one offered back, is not replaced by a line that starts no agent; an offer is by one that does', async () => {
    await withStore(null, async () => {
      const opened = await T.getState().createTab();
      await promptIn(tabNow(opened.id));
      await T.getState().startAgent(opened.id, 'claude');
      const live = tabNow(opened.id).agent;
      assert.equal(agentLabel(tabNow(opened.id)), 'Claude Code', 'premise');
      // The app's own typed line is seen as well: it must not replace the
      // record it was typed for.
      assert.equal(tabNow(opened.id).agent, live, 'the record the app made is kept');
      // Nor does an agent typed at a prompt replace one believed to be
      // running — the record is the store's word for what runs here.
      await promptIn(tabNow(opened.id));
      assert.equal(agentLabel(tabNow(opened.id)), 'Claude Code', 'premise: a D at a prompt is not the agent ending');
      await T.getState().writeRaw(opened.id, 'opencode\r');
      await sleep(10);
      assert.equal(tabNow(opened.id).agent, live, 'a live record is not replaced');

      const offered = { kind: 'claude', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', startedAt: 1, title: null };
      T.setState((st) => ({ tabs: st.tabs.map((t) => (t.id === opened.id ? { ...t, agent: offered, agentResumeOffered: true, agentTyped: null } : t)) }));
      await T.getState().writeRaw(opened.id, 'ls\r');
      await sleep(10);
      assert.equal(tabNow(opened.id).agent, offered, 'a line that starts no agent leaves the offer');
      assert.equal(tabNow(opened.id).agentResumeOffered, true);
      await promptIn(tabNow(opened.id));
      await T.getState().writeRaw(opened.id, 'opencode\r');
      await sleep(10);
      assert.equal(tabNow(opened.id).agent?.kind, 'opencode', 'typing an agent takes the offer’s place');
      assert.equal(tabNow(opened.id).agentResumeOffered, false);
    });
  });
});

describe('Terminal status: the settings (S8)', () => {
  test('TS-17: folder, branch, agent and last notification on; the attention sort off', () => {
    assert.equal(SETTINGS_DEFAULTS.terminalsPanelFolder, true, "today's behaviour");
    assert.equal(SETTINGS_DEFAULTS.terminalsPanelBranch, true);
    assert.equal(SETTINGS_DEFAULTS.terminalsPanelAgent, true);
    assert.equal(SETTINGS_DEFAULTS.terminalsPanelLastNote, true);
    assert.equal(SETTINGS_DEFAULTS.terminalsPanelSortAttention, false, 'the user order unless asked');
    const keys = Object.keys(SETTINGS_DEFAULTS);
    const at = keys.indexOf('terminalsPanelFolder');
    assert.deepEqual(
      keys.slice(at, at + 5),
      ['terminalsPanelFolder', 'terminalsPanelBranch', 'terminalsPanelAgent', 'terminalsPanelLastNote', 'terminalsPanelSortAttention'],
      'together, in the order Settings shows them'
    );
    assert.ok(at > keys.indexOf('terminalProgress'), 'after the notification rows');
  });
});

describe('Terminal status: teardown', () => {
  test('TS-99: this suite changed no setting — the side bar settings are still at their defaults', () => {
    // Read before anything is put back: what the next suite will see is what
    // this one left, and it only ever reads.
    const settings = useSettingsStore.getState();
    const panel = Object.keys(settings.settingsDefaults).filter((k) => k.startsWith('terminalsPanel'));
    assert.equal(panel.length, 5);
    const left = panel.filter((k) => settings[k] !== settings.settingsDefaults[k]);
    useSettingsStore.setState(Object.fromEntries(panel.map((k) => [k, settings.settingsDefaults[k]])));
    assert.deepEqual(left, [], 'left changed');
  });
});
