/**
 * DEC 2026, synchronized output: a program says "the screen is half written"
 * (`CSI ? 2026 h`) and "done" (`CSI ? 2026 l`), and the terminal draws nothing
 * in between, so a big repaint is never seen half done.
 *
 * xterm 6 implements it (xterm.js #5453); 5.5 answered the probe for it as
 * "not recognized" and drew every half-written frame. But xterm 6.0 does not
 * answer XTVERSION (`CSI > q`), and Claude Code 2.1.289 sends its 2026 probe
 * only to a terminal that answered XTVERSION — its own log line reads
 * "DECRQM 2026 not asked (no XTVERSION reply)" — then guesses from
 * TERM_PROGRAM, which nothing sets for a shell here. So the app answers
 * XTVERSION exactly as xterm.js 6.1 will (#5502): `DCS > | xterm.js(6.0.0) ST`.
 *
 * These cases run real xterm (`@xterm/headless`, the same core and release as
 * the app's `@xterm/xterm`, see UW-04). What a headless terminal cannot show —
 * that nothing is DRAWN inside a block — was measured in the real app under
 * headless Chromium with the WebGL renderer, and the one draw the app makes
 * itself is held back too (GL-27).
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { XTERM_VERSION, xtVersionReply, installXtVersionReply } from '../../src/lib/terminalCompat.js';

const { Terminal } = headless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const XTVERSION_REPLY = `\x1bP>|xterm.js(${XTERM_VERSION})\x1b\\`;

/** A real xterm 6, with every reply it sends collected. */
function terminal({ answerXtVersion = true } = {}) {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies = [];
  term.onData((data) => replies.push(data));
  if (answerXtVersion) installXtVersionReply(term);
  return { term, replies };
}

describe('Synchronized output: the probe Claude Code makes, answered', () => {
  test('SO-01: XTVERSION is answered as xterm.js answers it from 6.1 — and only for Ps 0', () => {
    assert.equal(xtVersionReply([]), XTVERSION_REPLY, '`CSI > q`');
    assert.equal(xtVersionReply([0]), XTVERSION_REPLY, '`CSI > 0 q`');
    assert.equal(xtVersionReply([1]), null);
    assert.equal(xtVersionReply([2]), null);
    assert.equal(xtVersionReply(undefined), XTVERSION_REPLY);
    assert.equal(xtVersionReply([0], '9.9.9'), '\x1bP>|xterm.js(9.9.9)\x1b\\');
  });

  test('SO-02: the version reported is the release installed — and the move to 6.1 drops the backport', () => {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    const installed = lock.packages['node_modules/@xterm/xterm'].version;
    assert.equal(XTERM_VERSION, installed, 'XTERM_VERSION follows @xterm/xterm');
    assert.match(installed, /^6\.0\./, 'xterm.js answers XTVERSION itself from 6.1 (#5502): remove installXtVersionReply then');
  });

  test('SO-03: real xterm 6.0 alone does not answer XTVERSION — so Claude Code never asked for 2026', async () => {
    const { term, replies } = terminal({ answerXtVersion: false });
    try {
      await write(term, '\x1b[>q\x1b[>0q');
      assert.deepEqual(replies, [], 'no reply at all');
    } finally {
      term.dispose();
    }
  });

  test('SO-04: with the app\'s handler, Claude Code\'s probe sequence gets both replies, in order', async () => {
    const { term, replies } = terminal();
    try {
      // XTVERSION first; DECRQM 2026 only once it has an answer — as Claude Code does.
      await write(term, '\x1b[>0q');
      assert.deepEqual(replies, [XTVERSION_REPLY]);
      await write(term, '\x1b[?2026$p');
      assert.deepEqual(replies, [XTVERSION_REPLY, '\x1b[?2026;2$y'], '2: recognised, currently reset — "supported"');
      await write(term, '\x1b[>1q');
      assert.equal(replies.length, 2, 'Ps 1 is not a version request');
    } finally {
      term.dispose();
    }
  });

  test('SO-05: inside a block the mode reads set, and it ends with the block', async () => {
    const { term, replies } = terminal();
    try {
      assert.equal(term.modes.synchronizedOutputMode, false);
      await write(term, '\x1b[?2026h');
      assert.equal(term.modes.synchronizedOutputMode, true, 'what drawWebglNow reads (GL-27)');
      await write(term, '\x1b[?2026$p');
      assert.deepEqual(replies, ['\x1b[?2026;1$y']);
      await write(term, 'half a frame\x1b[?2026l');
      assert.equal(term.modes.synchronizedOutputMode, false);
      assert.equal(term.buffer.active.getLine(0).translateToString(true), 'half a frame', 'the text itself is never held back');
    } finally {
      term.dispose();
    }
  });

  test('SO-06: every terminal the app makes answers it, from the moment it is created', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    const install = create.indexOf('installXtVersionReply(term);');
    const open = create.indexOf('term.open(container);');
    assert.ok(install > 0 && install < open, 'before the shell can ask');
  });
});
