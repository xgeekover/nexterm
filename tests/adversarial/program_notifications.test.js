/**
 * What a program in the terminal asks to tell the user — OpenCode saying a
 * session is done or needs permission, Claude Code waiting — reaches the bell,
 * and the desktop while the window is in the background.
 *
 * Measured with OpenCode 1.18.34 in a PTY harness (2026-10-05): its TUI asks
 * kitty's capability query as it starts and notifies over OSC 99 only once a
 * terminal answers; xterm.js 6.0 answers nothing and drops OSC 9, 99 and 777
 * alike, so OpenCode sent nothing and nothing would have been shown. The
 * sequences below are what it sent once answered, byte for byte, and Claude
 * Code 2.1.289's three channels as its own code writes them. See
 * src/lib/programNotifications.js.
 *
 * The parsing runs through real xterm (`@xterm/headless`, the same core and
 * release as the app's `@xterm/xterm`, see UW-04); where a notification goes
 * runs through the real store, against the browser mock's desktop.
 */
import { readFileSync } from 'node:fs';
// Static, as in unicode_widths.test.js: other files in this runner register
// module hooks that turn `@xterm/*` into test doubles.
import headless from '@xterm/headless';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import {
  BODY_MAX,
  KITTY_CAPABILITIES,
  KittyNotifications,
  RATE_LIMIT,
  TITLE_MAX,
  createRateLimiter,
  installProgramNotifications,
  kittyQueryReply,
  parseKittyChunk,
  parseOsc777,
  parseOsc9,
  routeProgramNotification,
  sanitizeText,
  windowAttention,
} from '../../src/lib/programNotifications.js';
import { isFailure, notificationSummary } from '../../src/lib/tabActivity.js';
import { useTerminalStore as S } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const { Terminal } = headless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

const ESC = '\x1b';
const ST = `${ESC}\\`;
const BEL = '\x07';

/** OpenTUI's start-up question, and the answer that makes it pick OSC 99. */
const OPENTUI_QUERY = `${ESC}]99;i=opentui-notifications:p=?;${ST}`;
const OPENTUI_ANSWER = `${ESC}]99;i=opentui-notifications:p=?;a=focus:o=always,unfocused,invisible:p=title,body,?:u=0,1,2${ST}`;

/** What OpenCode then sent for a finished session titled "Hello from the mock.", over OSC 99 ... */
const OPENCODE_OSC99 =
  `${ESC}]99;i=opentui-1:p=title:e=1:d=0;SGVsbG8gZnJvbSB0aGUgbW9jay4=${ST}` +
  `${ESC}]99;i=opentui-1:p=body:e=1:d=1;U2Vzc2lvbiBkb25l${ST}`;
/** ... and with OPENTUI_NOTIFICATION_PROTOCOL=osc9. */
const OPENCODE_OSC9 = `${ESC}]9;Hello from the mock.: Session done${ST}`;

/** Claude Code 2.1.289's channels, as its `notifyKitty` / `notifyITerm2` / `notifyGhostty` write them (BEL-terminated). */
const claudeKitty = (id, title, message) =>
  `${ESC}]99;i=${id}:d=0:p=title;${title}${BEL}` +
  `${ESC}]99;i=${id}:p=body;${message}${BEL}` +
  `${ESC}]99;i=${id}:d=1:a=focus;${BEL}`;
const claudeITerm2 = (title, message) => `${ESC}]9;${title ? `${title}: ${message}` : message}${BEL}`;
const claudeGhostty = (title, message) => `${ESC}]777;notify;${title};${message}${BEL}`;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const note = (title, body, occasion = 'always', urgency = 1) => ({ title, body, occasion, urgency });

/** A real xterm 6 with the addon (or without it), every reply and notification collected. */
function terminal({ addon = true, enabled = () => true, clock } = {}) {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies = [];
  const notes = [];
  term.onData((data) => replies.push(data));
  let now = 0;
  const pn = addon
    ? installProgramNotifications(term, {
        onNotify: (n) => notes.push(n),
        enabled,
        // Ten seconds a notification unless a case says otherwise: past the
        // rate limit, which PN-35 checks on its own.
        clock: clock ?? (() => (now += 10_000)),
      })
    : null;
  const screen = () => {
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
    return lines.join('\n').trim();
  };
  return { term, pn, replies, notes, screen };
}

describe('Program notifications: kitty (OSC 99), assembled from its chunks', () => {
  test("PN-01: OpenCode's chunks — base64, one id, d=0 then d=1 — are one notification, and nothing before the last", () => {
    const kitty = new KittyNotifications();
    const [first, second] = OPENCODE_OSC99.split(ST).filter(Boolean).map((s) => s.slice(`${ESC}]99;`.length));
    assert.deepEqual(kitty.push(first, 0), {}, 'the title alone is held, not shown');
    assert.equal(kitty.pending, 1);
    assert.deepEqual(kitty.push(second, 1), { notification: note('Hello from the mock.', 'Session done') });
    assert.equal(kitty.pending, 0, 'and nothing is kept once it is shown');
  });

  test('PN-02: the chunk rules — p defaults to title, d to done, e to text; parts concatenate; o and u from any chunk', () => {
    const kitty = new KittyNotifications();
    // The simplest notification kitty documents: no metadata at all.
    assert.deepEqual(kitty.push(';Hello world', 0), { notification: note('Hello world', '') });
    // Plain text, the title in two pieces and the body in two.
    assert.deepEqual(kitty.push('i=x:d=0;Build ', 0), {});
    assert.deepEqual(kitty.push('i=x:d=0;finished', 0), {});
    assert.deepEqual(kitty.push('i=x:p=body:d=0;3 warnings,', 0), {});
    assert.deepEqual(kitty.push('i=x:p=body:o=invisible:u=2; 0 errors', 0), {
      notification: note('Build finished', '3 warnings, 0 errors', 'invisible', 2),
    });
    // The last occasion and urgency win; one kitty does not define is ignored.
    kitty.push('i=y:o=unfocused:u=0:d=0;T', 0);
    assert.deepEqual(kitty.push('i=y:p=body:o=sometimes:u=7;B', 0), { notification: note('T', 'B', 'unfocused', 0) });
    // Interleaved ids stay apart.
    kitty.push('i=a:d=0;A title', 0);
    kitty.push('i=b:d=0;B title', 0);
    assert.deepEqual(kitty.push('i=b:p=body;B body', 0), { notification: note('B title', 'B body') });
    assert.deepEqual(kitty.push('i=a:p=body;A body', 0), { notification: note('A title', 'A body') });
  });

  test('PN-03: base64 is decoded as UTF-8 once the part is complete, so a character split across chunks survives', () => {
    const kitty = new KittyNotifications();
    const han = Buffer.from('한글 OK', 'utf8'); // 한 is ED 95 9C
    kitty.push(`i=k:e=1:d=0;${b64(han.subarray(0, 2))}`, 0);
    kitty.push(`i=k:e=1:d=0;${b64(han.subarray(2, 4))}`, 0);
    assert.deepEqual(kitty.push(`i=k:e=1;${b64(han.subarray(4))}`, 0), { notification: note('한글 OK', '') });
    // Unpadded and URL-safe base64 both decode.
    assert.equal(kitty.push(`e=1:p=body;${b64(Buffer.from('ok?>')).replace(/=+$/, '')}`, 0).notification.body, 'ok?>');
    assert.equal(kitty.push(`e=1:p=body;${b64(Buffer.from('??>>')).replace(/\+/g, '-').replace(/\//g, '_')}`, 0).notification.body, '??>>');
  });

  test("PN-04: an empty notification is no notification — Claude Code's closing `d=1:a=focus` chunk among them", () => {
    const kitty = new KittyNotifications();
    assert.deepEqual(kitty.push('i=42:d=0:p=title;Claude Code', 0), {});
    assert.deepEqual(kitty.push('i=42:p=body;Claude is waiting for your input', 0), {
      notification: note('Claude Code', 'Claude is waiting for your input'),
    });
    assert.deepEqual(kitty.push('i=42:d=1:a=focus;', 0), { notification: null }, 'taken, and nothing to show');
    assert.deepEqual(kitty.push('', 0), { notification: null });
    assert.deepEqual(kitty.push('i=e:p=body;   \t ', 0), { notification: null }, 'whitespace is nothing to show');
    assert.equal(kitty.pending, 0);
  });

  test('PN-05: garbage is not taken, and never throws', () => {
    const kitty = new KittyNotifications();
    for (const data of [undefined, null, 42, {}, ['i=1;x']]) assert.equal(kitty.push(data, 0), null, `${String(data)}`);
    // An id that is not one: it could be echoed back to the program. (A `;`
    // cannot be in one: it ends the metadata.)
    for (const id of ['a b', 'x/y', '$(id)', 'a=b', 'x'.repeat(129), 'é']) {
      assert.equal(kitty.push(`i=${id}:d=0;title`, 0), null, `i=${id}`);
      assert.equal(kitty.push(`i=${id}:p=?;`, 0), null, `a query from i=${id} is not answered`);
    }
    assert.equal(kitty.push(`${'k=v:'.repeat(400)};x`, 0), null, 'metadata past any real one');
    // Base64 that is not: the chunk adds nothing, and its `d` still counts.
    kitty.push('i=b:d=0;Title', 0);
    assert.deepEqual(kitty.push('i=b:p=body:e=1;%%% not base64 %%%', 0), { notification: note('Title', '') });
    // Pairs that are not single-letter keys are skipped; the rest still parse.
    assert.deepEqual(parseKittyChunk('i=1:pp=body:=x:p:d=0;payload;with;semicolons'), {
      meta: { i: '1', d: '0' },
      payload: 'payload;with;semicolons',
    });
    assert.equal(kitty.pending, 0, 'nothing malformed is held');
    for (const data of [';;;', ':::;', '=;=', 'i=:d=0;', 'p=?', 'd=0', 'e=1;', `e=1;${'A'.repeat(4097)}`]) {
      const result = kitty.push(data, 0);
      assert.ok(result === null || typeof result === 'object', JSON.stringify(data));
    }
  });

  test('PN-06: types other than title and body — a query answered, close and alive, an icon that completes', () => {
    const kitty = new KittyNotifications();
    // An icon or buttons on their own are no notification, and are not taken...
    assert.equal(kitty.push('i=z:p=icon;AAAA', 0), null);
    assert.equal(kitty.push('i=z:p=buttons;Yes', 0), null);
    // ... but the last chunk of one being assembled completes it.
    kitty.push('i=z:d=0;With an icon', 0);
    assert.deepEqual(kitty.push('i=z:p=icon:e=1;AAAA', 0), { notification: note('With an icon', '') });
    // close drops what is held; alive is not implemented, and not advertised.
    kitty.push('i=c:d=0;Never finished', 0);
    assert.deepEqual(kitty.push('i=c:p=close;', 0), {});
    assert.equal(kitty.push('i=c:p=close;', 0), null, 'nothing left to close');
    assert.equal(kitty.pending, 0);
    assert.equal(kitty.push('i=c:p=alive;', 0), null);
    assert.deepEqual(kitty.push('i=q1:p=?;', 0), { reply: kittyQueryReply('q1') });
  });

  test('PN-07: bounded — 16 held at most, 4 KB of title and body each, nothing held past a minute', () => {
    const kitty = new KittyNotifications();
    for (let i = 0; i < 20; i += 1) kitty.push(`i=n${i}:d=0;Title ${i}`, 0);
    assert.equal(kitty.pending, 16, 'the oldest four went');
    assert.deepEqual(kitty.push('i=n0:p=body;late', 0), { notification: note('', 'late') }, 'n0 was dropped: its title is gone');
    assert.deepEqual(kitty.push('i=n19:p=body;kept', 0), { notification: note('Title 19', 'kept') });

    // A title streamed a megabyte at a time: the store never holds more than
    // the cap, and what is shown is cut to TITLE_MAX.
    const big = new KittyNotifications();
    const megabyte = 'x'.repeat(1 << 20);
    for (let i = 0; i < 8; i += 1) big.push(`i=big:d=0;${megabyte}`, 0);
    big.push(`i=big:d=0:e=1;${b64(Buffer.alloc(1 << 20, 0x41))}`, 0);
    const held = big._pending.get('big');
    assert.ok(held.title.bytes <= 4096, `held ${held.title.bytes} bytes of title`);
    const done = big.push('i=big:p=body;the end', 0).notification;
    assert.equal(Array.from(done.title).length, TITLE_MAX);
    assert.ok(done.title.endsWith('…'));
    assert.equal(done.body, 'the end');

    // Abandoned half-way: a minute later it is gone, and the id starts afresh.
    const stale = new KittyNotifications({ staleMs: 60_000 });
    stale.push('i=s:d=0;Old title', 1_000);
    stale.push('i=t:d=0;Another', 61_001);
    assert.equal(stale.pending, 1, 'the one opened a minute ago is dropped');
    assert.deepEqual(stale.push('i=s:p=body;New body', 61_002), { notification: note('', 'New body') });
  });

  test('PN-08: the answer to the query — the id echoed, only what is implemented advertised', () => {
    assert.equal(kittyQueryReply('opentui-notifications'), OPENTUI_ANSWER);
    assert.equal(kittyQueryReply(''), `${ESC}]99;p=?;${KITTY_CAPABILITIES}${ST}`, 'no id asked, none answered');
    assert.equal(kittyQueryReply(), `${ESC}]99;p=?;${KITTY_CAPABILITIES}${ST}`);
    for (const id of ['a b', 'a:b', 'a;b', `a${ESC}b`, 'x'.repeat(129), 42, null]) assert.equal(kittyQueryReply(id), null, JSON.stringify(id));
    // Nothing can tell when a desktop notification is clicked, so no click is
    // ever reported back, and `report` must not be offered.
    assert.ok(!KITTY_CAPABILITIES.includes('report'));
    assert.match(KITTY_CAPABILITIES, /(^|:)a=focus(:|$)/);
    assert.match(KITTY_CAPABILITIES, /(^|:)p=title,body,\?(:|$)/, 'only the types implemented');
  });
});

describe('Program notifications: OSC 9 and OSC 777', () => {
  test("PN-10: OSC 9's payload is the message, whole — a colon in it stays where it is", () => {
    assert.deepEqual(parseOsc9('Build finished'), note('', 'Build finished'));
    assert.deepEqual(parseOsc9('Hello from the mock.: Session done'), note('', 'Hello from the mock.: Session done'));
    assert.deepEqual(parseOsc9('Claude Code: Claude needs your permission to use Bash'), note('', 'Claude Code: Claude needs your permission to use Bash'));
    assert.deepEqual(parseOsc9('build;deploy done'), note('', 'build;deploy done'), 'a semicolon after a word is still a message');
    assert.deepEqual(parseOsc9('4x4 build done'), note('', '4x4 build done'));
    for (const data of ['', '   ', undefined, null, 9]) assert.equal(parseOsc9(data), null, JSON.stringify(data));
  });

  test("PN-11: ConEmu's and Windows Terminal's OSC 9 commands are not messages — progress, the cwd PowerShell sends at every prompt", () => {
    for (const data of [
      '4;1;50', // progress, 50%
      '4;0;', // progress cleared — Claude Code sends this as it works
      '4;3;', // indeterminate
      '9;C:\\Users\\me\\src', // the working directory, oh-my-posh / PowerShell
      '9;"C:\\Program Files"',
      '1;250', // sleep
      '12', // prompt start
      '4',
      '10;1',
    ]) {
      assert.equal(parseOsc9(data), null, JSON.stringify(data));
    }
  });

  test('PN-12: OSC 777 is `notify;title;body`, the body running to the end; nothing else of urxvt’s is a notification', () => {
    assert.deepEqual(parseOsc777('notify;Claude Code;Claude needs your permission'), note('Claude Code', 'Claude needs your permission'));
    assert.deepEqual(parseOsc777('notify;Build;done; 3 warnings; 0 errors'), note('Build', 'done; 3 warnings; 0 errors'));
    assert.deepEqual(parseOsc777('notify;Only a title'), note('Only a title', ''));
    assert.deepEqual(parseOsc777('notify;;Only a body'), note('', 'Only a body'));
    for (const data of ['notify', 'notify;', 'notify;;', 'preexec', 'precmd', 'NOTIFY;a;b', 'notify-send;a;b', 'notification;a;b', '', null]) {
      assert.equal(parseOsc777(data), null, JSON.stringify(data));
    }
  });
});

describe('Program notifications: cleaned, and rate-limited', () => {
  const RLO = String.fromCharCode(0x202e); // right-to-left override
  const LRI = String.fromCharCode(0x2066); // left-to-right isolate
  const PDI = String.fromCharCode(0x2069);
  const ZWJ = String.fromCharCode(0x200d);
  const NEL = String.fromCharCode(0x85);
  const CSI8 = String.fromCharCode(0x9b); // C1 CSI

  test('PN-20: control and bidirectional characters go, whitespace collapses, joiners stay', () => {
    assert.equal(sanitizeText('a\x00b\x07c\x7fd', 50), 'abcd', 'C0 and DEL');
    assert.equal(sanitizeText(`a${CSI8}31mb`, 50), 'a31mb', 'C1');
    assert.equal(sanitizeText('line one\r\nline two\ttabbed', 50), 'line one line two tabbed');
    assert.equal(sanitizeText(`  many   ${NEL}  spaces  `, 50), 'many spaces');
    assert.equal(sanitizeText(`invoice${RLO}fdp.exe`, 50), 'invoicefdp.exe', 'an override cannot reorder what is shown');
    assert.equal(sanitizeText(`${LRI}x${PDI}`, 50), 'x');
    const coder = String.fromCodePoint(0x1f468) + ZWJ + String.fromCodePoint(0x1f4bb);
    assert.equal(sanitizeText(`${coder} done`, 50), `${coder} done`, 'an emoji sequence keeps its joiner');
    for (const v of [undefined, null, 42, {}]) assert.equal(sanitizeText(v, 50), '');
    assert.equal(sanitizeText('text', 0), '');
  });

  test(`PN-21: cut at ${TITLE_MAX} characters of title and ${BODY_MAX} of message, by code point, ending in "…"`, () => {
    const title = 'T'.repeat(TITLE_MAX);
    assert.equal(sanitizeText(title, TITLE_MAX), title, 'exactly the limit is kept whole');
    const cut = sanitizeText(`${title}X`, TITLE_MAX);
    assert.equal(Array.from(cut).length, TITLE_MAX);
    assert.equal(cut, `${'T'.repeat(TITLE_MAX - 1)}…`);
    const emoji = String.fromCodePoint(0x1f680).repeat(BODY_MAX + 5);
    const body = sanitizeText(emoji, BODY_MAX);
    assert.equal(Array.from(body).length, BODY_MAX, 'counted in characters, not UTF-16 units');
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(body), 'no emoji cut in half');
    // Through every parser.
    assert.equal(Array.from(parseOsc9('m'.repeat(5000)).body).length, BODY_MAX);
    assert.equal(Array.from(parseOsc777(`notify;${'t'.repeat(500)};b`).title).length, TITLE_MAX);
    // xterm hands a handler up to 10 MB; it is looked at only as far as it
    // could matter.
    const started = Date.now();
    assert.equal(parseOsc9(' '.repeat(10 << 20)), null);
    assert.deepEqual(parseOsc9(`done${' '.repeat(10 << 20)}`), note('', 'done'));
    assert.deepEqual(parseOsc777(`notify;T;${'b'.repeat(10 << 20)}`).title, 'T');
    assert.ok(Date.now() - started < 1000, `and quickly: ${Date.now() - started} ms`);
  });

  test(`PN-22: one terminal notifies at most once in ${RATE_LIMIT.intervalMs / 1000} s and ${RATE_LIMIT.perMinute} times a minute`, () => {
    assert.deepEqual({ ...RATE_LIMIT }, { intervalMs: 2000, perMinute: 10 }, 'the numbers the README states');
    const limiter = createRateLimiter();
    assert.equal(limiter.allow(0), true);
    assert.equal(limiter.allow(1), false, 'one right after');
    assert.equal(limiter.allow(1999), false);
    assert.equal(limiter.allow(2000), true, 'two seconds later');
    // Eight more, two seconds apart: ten in the minute.
    for (let i = 2; i <= 9; i += 1) assert.equal(limiter.allow(i * 2000), true, `#${i + 1}`);
    assert.equal(limiter.allow(20_000), false, 'the eleventh in a minute');
    assert.equal(limiter.allow(59_999), false);
    assert.equal(limiter.allow(60_000), true, 'the first has left the minute');
    assert.equal(limiter.allow(60_001), false, 'and the interval still holds');
  });
});

describe('Program notifications: through real xterm', () => {
  test('PN-30: xterm.js 6.0 alone answers nothing and shows nothing — the defect', async () => {
    const { term, replies, screen } = terminal({ addon: false });
    try {
      await write(term, OPENTUI_QUERY + OPENCODE_OSC99 + OPENCODE_OSC9 + claudeGhostty('T', 'B'));
      assert.deepEqual(replies, [], "OpenTUI's query goes unanswered, so it never notifies");
      assert.equal(screen(), '', 'and every sequence is dropped');
    } finally {
      term.dispose();
    }
  });

  test("PN-31: OpenCode, replayed — its query is answered, so it notifies over OSC 99, and that reaches the app", async () => {
    const { term, replies, notes, screen } = terminal();
    try {
      await write(term, OPENTUI_QUERY);
      assert.deepEqual(replies, [OPENTUI_ANSWER], 'answered once, exactly, through onData');
      await write(term, OPENCODE_OSC99);
      assert.deepEqual(notes, [note('Hello from the mock.', 'Session done')]);
      for (const message of ['Permission needs input', 'Question needs input', 'Session error', 'Model stopped responding']) {
        await write(term, `${ESC}]99;i=opentui-2:p=title:e=1:d=0;${b64(Buffer.from('opencode'))}${ST}`);
        await write(term, `${ESC}]99;i=opentui-2:p=body:e=1:d=1;${b64(Buffer.from(message))}${ST}`);
        assert.deepEqual(notes.at(-1), note('opencode', message));
      }
      // And with OPENTUI_NOTIFICATION_PROTOCOL=osc9.
      await write(term, OPENCODE_OSC9);
      assert.deepEqual(notes.at(-1), note('', 'Hello from the mock.: Session done'));
      assert.equal(notes.length, 6);
      assert.equal(replies.length, 1, 'nothing else answered');
      assert.equal(screen(), '', 'nothing printed');
      await write(term, 'still drawing');
      assert.equal(screen(), 'still drawing');
    } finally {
      term.dispose();
    }
  });

  test("PN-32: Claude Code's three channels — kitty, iTerm2, Ghostty — each make one notification", async () => {
    const { term, notes, screen } = terminal();
    try {
      await write(term, claudeKitty(4821, 'Claude Code', 'Claude needs your permission to use Bash'));
      assert.deepEqual(notes, [note('Claude Code', 'Claude needs your permission to use Bash')]);
      await write(term, claudeITerm2('', 'Claude is waiting for your input'));
      await write(term, claudeITerm2('Claude Code', 'Claude is waiting for your input'));
      await write(term, claudeGhostty('Claude Code', 'Claude is waiting for your input'));
      assert.deepEqual(notes.slice(1), [
        note('', 'Claude is waiting for your input'),
        note('', 'Claude Code: Claude is waiting for your input'),
        note('Claude Code', 'Claude is waiting for your input'),
      ]);
      // Its progress reports and PowerShell's cwd are not.
      await write(term, `${ESC}]9;4;1;40${BEL}${ESC}]9;4;0;${BEL}${ESC}]9;9;C:\\Users\\me${ST}${ESC}]777;precmd${BEL}`);
      assert.equal(notes.length, 4);
      assert.equal(screen(), '');
    } finally {
      term.dispose();
    }
  });

  test('PN-33: what xterm hands on — taken sequences end there, the rest go on to any other handler', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      // Registered first, so xterm asks the addon before these.
      const reached = [];
      for (const ident of [9, 99, 777]) {
        term.parser.registerOscHandler(ident, (data) => {
          reached.push(`${ident};${data}`);
          return false;
        });
      }
      const notes = [];
      let now = 0;
      installProgramNotifications(term, { onNotify: (n) => notes.push(n), clock: () => (now += 10_000) });
      await write(term, `${ESC}]9;hello${BEL}${ESC}]777;notify;a;b${BEL}${ESC}]99;;kitty${BEL}${ESC}]99;i=q:p=?;${BEL}`);
      assert.deepEqual(reached, [], 'all four were taken');
      await write(term, `${ESC}]9;4;1;5${BEL}${ESC}]9;${BEL}${ESC}]777;preexec${BEL}${ESC}]99;i=a b;x${BEL}${ESC}]99;i=z:p=alive;${BEL}`);
      assert.deepEqual(reached, ['9;4;1;5', '9;', '777;preexec', '99;i=a b;x', '99;i=z:p=alive;']);
      assert.equal(notes.length, 3);
    } finally {
      term.dispose();
    }
  });

  test('PN-34: turned off, nothing is answered or shown — read as each sequence arrives', async () => {
    let on = false;
    const { term, replies, notes } = terminal({ enabled: () => on });
    try {
      await write(term, OPENTUI_QUERY + OPENCODE_OSC99 + OPENCODE_OSC9 + claudeGhostty('T', 'B'));
      assert.deepEqual(replies, [], 'no answer, so OpenCode does not pick OSC 99');
      assert.deepEqual(notes, []);
      on = true;
      await write(term, OPENTUI_QUERY + OPENCODE_OSC99);
      assert.deepEqual(replies, [OPENTUI_ANSWER], 'on again without reinstalling');
      assert.equal(notes.length, 1);
    } finally {
      term.dispose();
    }

    // A setting that cannot be read is off, and the parser carries on.
    const broken = terminal({
      enabled: () => {
        throw new Error('settings gone');
      },
    });
    try {
      await write(broken.term, OPENTUI_QUERY + OPENCODE_OSC99 + 'after');
      assert.deepEqual(broken.replies, []);
      assert.deepEqual(broken.notes, []);
      assert.equal(broken.screen(), 'after');
    } finally {
      broken.term.dispose();
    }
  });

  test('PN-35: a flood from one terminal is cut down to the rate limit; another terminal has its own', async () => {
    let now = 0;
    const one = terminal({ clock: () => now });
    const two = terminal({ clock: () => now });
    try {
      const burst = Array.from({ length: 50 }, (_, i) => `${ESC}]9;spam ${i}${BEL}`).join('');
      await write(one.term, burst);
      await write(two.term, `${ESC}]9;from two${BEL}`);
      assert.deepEqual(one.notes.map((n) => n.body), ['spam 0'], 'one in the same instant');
      assert.deepEqual(two.notes.map((n) => n.body), ['from two']);
      now = 2_000;
      await write(one.term, burst);
      assert.deepEqual(one.notes.map((n) => n.body), ['spam 0', 'spam 0'], 'one more two seconds later');
      for (let i = 2; i <= 12; i += 1) {
        now = i * 2_000;
        await write(one.term, `${ESC}]9;tick ${i}${BEL}`);
      }
      assert.equal(one.notes.length, 10, 'ten in the minute, then nothing');
      assert.equal(one.screen(), '', 'the dropped ones are still not printed');
    } finally {
      one.term.dispose();
      two.term.dispose();
    }
  });

  test('PN-36: disposed with its terminal', async () => {
    const { term, pn, replies, notes, screen } = terminal();
    try {
      pn.dispose();
      await write(term, OPENTUI_QUERY + OPENCODE_OSC99 + 'after');
      assert.deepEqual(replies, [], 'its handlers are gone');
      assert.deepEqual(notes, []);
      assert.equal(screen(), 'after');
    } finally {
      term.dispose();
    }

    // Through `loadAddon`: the terminal's own dispose reaches it.
    const other = terminal();
    other.term.dispose();
    assert.equal(other.pn._disposables.length, 0);

    assert.equal(installProgramNotifications({}), null, 'a terminal without a parser (a test double) gets nothing');
    assert.equal(installProgramNotifications(null), null);
    assert.equal(installProgramNotifications({ parser: {} }), null);
  });

  test('PN-37: never throws inside the parser — a handler that throws wedges xterm for good', async () => {
    // Every handler, called with anything at all while the store throws and
    // the pty is gone, answers true or false. Asked of the handlers straight
    // first: a throw out of real xterm's parser does not fail a case, it
    // takes the whole run down with it.
    const handlers = new Map();
    const fake = {
      parser: {
        registerOscHandler: (ident, fn) => {
          handlers.set(ident, fn);
          return { dispose() {} };
        },
      },
      input() {
        throw new Error('pty gone');
      },
      loadAddon(addon) {
        addon.activate(this);
      },
    };
    const onNotify = () => {
      throw new Error('store gone');
    };
    let now = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.ok(installProgramNotifications(fake, { onNotify, clock: () => (now += 10_000) }), 'a parser is all it needs');
      for (const ident of [9, 99, 777]) {
        for (const data of [undefined, null, 42, '', ';', 'i=x:p=?;', {}, 'notify;a;b', 'a message', 'i=1;a title']) {
          let result;
          assert.doesNotThrow(() => {
            result = handlers.get(ident)(data);
          }, `${ident};${JSON.stringify(data)}`);
          assert.equal(typeof result, 'boolean', `${ident};${JSON.stringify(data)}`);
        }
      }
      assert.equal(handlers.get(99)('i=x:p=?;'), false, 'an answer that cannot be sent');

      // And through real xterm: it carries on writing after both.
      const failing = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      try {
        installProgramNotifications(failing, { onNotify, clock: () => (now += 10_000) });
        failing.input = () => {
          throw new Error('pty gone');
        };
        await write(failing, OPENTUI_QUERY + OPENCODE_OSC99 + OPENCODE_OSC9 + 'still alive');
        assert.equal(failing.buffer.active.getLine(0).translateToString(true), 'still alive');
      } finally {
        failing.dispose();
      }
    } finally {
      console.warn = warn;
    }
  });
});

describe('Program notifications: where one goes', () => {
  test('PN-40: the route — the bell unless typing into it, the desktop only from the background, kitty’s occasions', () => {
    const route = (occasion, activeTab, focused, onScreen) => routeProgramNotification({ occasion, activeTab, focused, onScreen });
    const BOTH = { inApp: true, desktop: true };
    const BELL = { inApp: true, desktop: false };
    const NOWHERE = { inApp: false, desktop: false };
    // occasion, the active tab, window focused, on screen -> where.
    const table = [
      ['always', true, true, true, NOWHERE], // the terminal being typed into
      ['always', false, true, true, BELL], // another pane on screen
      ['always', false, true, false, BELL], // another group
      ['always', true, false, true, BOTH], // in the background
      ['always', false, false, false, BOTH],
      ['unfocused', true, true, true, NOWHERE],
      ['unfocused', false, true, true, BELL],
      ['unfocused', true, false, true, BOTH],
      ['invisible', true, true, true, NOWHERE],
      ['invisible', false, true, true, NOWHERE], // on screen, though not focused
      ['invisible', false, false, true, NOWHERE], // window behind another, still visible
      ['invisible', false, true, false, BELL],
      ['invisible', true, false, false, BOTH], // minimised
    ];
    for (const [occasion, activeTab, focused, onScreen, expected] of table) {
      assert.deepEqual(route(occasion, activeTab, focused, onScreen), expected, JSON.stringify({ occasion, activeTab, focused, onScreen }));
    }
    assert.deepEqual(routeProgramNotification(), { inApp: true, desktop: true }, 'knowing nothing, it is said');
    assert.deepEqual(route('nonsense', false, true, false), BELL, 'an unknown occasion is always');
  });

  test("PN-41: the window's focus and visibility, from the document", () => {
    assert.deepEqual(windowAttention({ hasFocus: () => true, visibilityState: 'visible' }), { focused: true, visible: true });
    assert.deepEqual(windowAttention({ hasFocus: () => false, visibilityState: 'visible' }), { focused: false, visible: true });
    assert.deepEqual(windowAttention({ hasFocus: () => false, visibilityState: 'hidden' }), { focused: false, visible: false });
    assert.deepEqual(windowAttention({ hasFocus: () => false, hidden: true }), { focused: false, visible: false });
    assert.deepEqual(windowAttention({ hasFocus: () => true, visibilityState: 'hidden' }), { focused: true, visible: true }, 'focused is seen');
    assert.deepEqual(windowAttention(null), { focused: false, visible: false }, 'no document: nobody is shown to be looking');
    assert.deepEqual(
      windowAttention({
        hasFocus() {
          throw new Error('gone');
        },
      }),
      { focused: false, visible: false }
    );
  });
});

describe('Program notifications: the store puts them in the bell and on the desktop', () => {
  let saved = null;
  const tab = (id) => ({ id, sessionId: `sess-${id}`, title: `Terminal ${id}`, defaultTitle: `Terminal ${id}` });
  // Group 1 is on screen, split: pane 1 shows `a` (the active tab) over `b`,
  // pane 2 shows `c`. Group 2 holds `d`.
  const GROUPS = [
    {
      id: 'group-1',
      name: 'Group 1',
      createdAt: 0,
      tree: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-1', tabIds: ['a', 'b'], activeTabId: 'a' },
          { type: 'leaf', id: 'pane-2', tabIds: ['c'], activeTabId: 'c' },
        ],
      },
      activePaneId: 'pane-1',
    },
    { id: 'group-2', name: 'Group 2', createdAt: 0, tree: { type: 'leaf', id: 'pane-3', tabIds: ['d'], activeTabId: 'd' }, activePaneId: 'pane-3' },
  ];
  const FOCUSED = { focused: true, visible: true };
  const BACKGROUND = { focused: false, visible: true };
  const MINIMISED = { focused: false, visible: false };
  const done = (title = 'opencode', body = 'Session done', occasion = 'always') => ({ title, body, occasion, urgency: 1 });
  const entries = () => S.getState().notifications;
  const desktop = () => mockBridge.desktopNotifications;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    if (!saved) {
      const s = S.getState();
      saved = {
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        groups: s.groups,
        activeGroupId: s.activeGroupId,
        notifications: s.notifications,
        isInitialized: s.isInitialized,
      };
    }
    // Not initialised: nothing here is worth persisting.
    S.setState({
      tabs: ['a', 'b', 'c', 'd'].map(tab),
      activeTabId: 'a',
      groups: GROUPS,
      activeGroupId: 'group-1',
      notifications: [],
      isInitialized: false,
    });
    mockBridge.desktopNotifications.length = 0;
  });

  test('PN-42: from a terminal you are not typing into, in a focused window: the bell, not the desktop', async () => {
    assert.deepEqual(S.getState().notifyFromProgram('c', done(), FOCUSED), { inApp: true, desktop: false });
    assert.deepEqual(S.getState().notifyFromProgram('d', done('t', 'from another group'), FOCUSED), { inApp: true, desktop: false });
    await settle();
    const [fromD, fromC] = entries();
    assert.equal(fromC.kind, 'program');
    assert.equal(fromC.tabId, 'c');
    assert.equal(fromC.tabTitle, 'Terminal c');
    assert.equal(fromC.title, 'opencode');
    assert.equal(fromC.body, 'Session done');
    assert.equal(typeof fromC.at, 'number');
    assert.equal(fromD.body, 'from another group', 'newest first');
    assert.notEqual(fromC.id, fromD.id);
    assert.deepEqual(desktop(), [], 'nothing on the desktop while the window is in front');
  });

  test('PN-43: from the terminal being typed into, in a focused window: nothing at all', async () => {
    assert.deepEqual(S.getState().notifyFromProgram('a', done(), FOCUSED), { inApp: false, desktop: false });
    await settle();
    assert.deepEqual(entries(), []);
    assert.deepEqual(desktop(), []);
  });

  test('PN-44: with the window in the background, the desktop as well — the active tab included', async () => {
    assert.deepEqual(S.getState().notifyFromProgram('a', done('Hello from the mock.', 'Session done'), BACKGROUND), { inApp: true, desktop: true });
    S.getState().notifyFromProgram('d', done('opencode', 'Permission needs input'), MINIMISED);
    await settle();
    assert.equal(entries().length, 2);
    assert.deepEqual(desktop(), [
      { title: 'Hello from the mock.', body: 'Session done' },
      { title: 'opencode', body: 'Permission needs input' },
    ]);
  });

  test('PN-45: a message with no title — OSC 9 carries none — is titled after its terminal, here and on the desktop', async () => {
    S.getState().notifyFromProgram('c', done('', 'Hello from the mock.: Session done'), BACKGROUND);
    await settle();
    assert.equal(entries()[0].title, 'Terminal c');
    assert.equal(entries()[0].body, 'Hello from the mock.: Session done');
    assert.deepEqual(desktop(), [{ title: 'Terminal c', body: 'Hello from the mock.: Session done' }]);
    // And a title with no message.
    S.getState().notifyFromProgram('c', done('Only a title', ''), BACKGROUND);
    await settle();
    assert.deepEqual(desktop().at(-1), { title: 'Only a title', body: '' });
  });

  test('PN-46: occasions against the real layout — on screen means shown in a pane of the group on screen', async () => {
    const invisible = (id, attention) => S.getState().notifyFromProgram(id, done(id, 'invisible', 'invisible'), attention);
    assert.deepEqual(invisible('c', BACKGROUND), { inApp: false, desktop: false }, 'c is in the other pane, on screen');
    assert.deepEqual(invisible('a', FOCUSED), { inApp: false, desktop: false });
    assert.deepEqual(invisible('b', BACKGROUND), { inApp: true, desktop: true }, 'b is behind a in its pane');
    assert.deepEqual(invisible('d', FOCUSED), { inApp: true, desktop: false }, 'd is in the other group');
    assert.deepEqual(invisible('c', MINIMISED), { inApp: true, desktop: true }, 'nothing is on screen in a minimised window');
    const unfocused = (id, attention) => S.getState().notifyFromProgram(id, done(id, 'unfocused', 'unfocused'), attention);
    assert.deepEqual(unfocused('a', FOCUSED), { inApp: false, desktop: false });
    assert.deepEqual(unfocused('c', FOCUSED), { inApp: true, desktop: false }, 'on screen, but not the one being typed into');
    assert.deepEqual(unfocused('a', BACKGROUND), { inApp: true, desktop: true });
    await settle();
    assert.deepEqual(entries().map((e) => e.tabId), ['a', 'c', 'c', 'd', 'b']);
    assert.equal(desktop().length, 3);
  });

  test('PN-47: one list with the finished commands — capped at 50, never a failure, and the bell says what it holds', () => {
    S.setState({ notifications: [{ id: 'n1', tabId: 'b', title: 'build', exitCode: 1, durationMs: 252_000, at: 1 }] });
    for (let i = 0; i < 60; i += 1) S.getState().notifyFromProgram('c', done('t', `message ${i}`), FOCUSED);
    const list = entries();
    assert.equal(list.length, 50, 'the same cap as the finished commands');
    assert.equal(list[0].body, 'message 59');
    assert.ok(!list.some((n) => n.id === 'n1'), 'the oldest went, whatever its kind');
    assert.ok(list.every((n) => !isFailure(n.exitCode)), 'a message is never a failure');

    S.setState({ notifications: [] });
    S.getState().notifyFromProgram('c', done(), FOCUSED);
    assert.deepEqual(notificationSummary(entries()), {
      label: '1 message from a program',
      title: '1 message from a program while you were elsewhere',
      heading: 'While you were elsewhere',
      dialog: 'Notifications',
    });
    S.setState({ notifications: [...entries(), { id: 'n2', tabId: 'b', title: 'tests', exitCode: 0, durationMs: 1, at: 2 }, { id: 'n3', tabId: 'b', title: 'x', exitCode: 2, durationMs: 1, at: 3 }] });
    S.getState().notifyFromProgram('d', done(), FOCUSED);
    assert.deepEqual(notificationSummary(entries()), {
      label: '2 finished commands and 2 messages from programs',
      title: '2 commands finished and 2 messages from programs while you were elsewhere',
      heading: 'While you were elsewhere',
      dialog: 'Notifications',
    });
    // Finished commands alone read exactly as they always have.
    assert.deepEqual(notificationSummary([{ exitCode: 0 }]), {
      label: '1 finished command',
      title: '1 command finished while you were elsewhere',
      heading: 'Finished while you were elsewhere',
      dialog: 'Finished commands',
    });
    assert.equal(notificationSummary([{}, {}]).label, '2 finished commands');
  });

  test('PN-48: a terminal that has gone, or no note, changes nothing', async () => {
    assert.equal(S.getState().notifyFromProgram('gone', done(), BACKGROUND), null);
    assert.equal(S.getState().notifyFromProgram('a', null, BACKGROUND), null);
    await settle();
    assert.deepEqual(entries(), []);
    assert.deepEqual(desktop(), []);
  });

  test('PN-49: every terminal is wired to the store, with the setting read as each one arrives', () => {
    // The registry's own call, cut from terminalRegistry.js and run with what
    // it closes over handed in — as TC-14 runs TerminalView's key handler.
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    const start = src.indexOf('installProgramNotifications(term, {');
    const end = src.indexOf('});', start) + 3;
    assert.ok(start > 0 && end > start, 'getOrCreateTerminal installs it on every terminal');
    let installed = null;
    const settings = { terminalProgramNotifications: true };
    const calls = [];
    const run = new Function('installProgramNotifications', 'term', 'tabId', 'useSettingsStore', 'useTerminalStore', src.slice(start, end));
    const term = { id: 'the-term' };
    run(
      (t, options) => {
        installed = { t, options };
      },
      term,
      'tab-term-7',
      { getState: () => settings },
      { getState: () => ({ notifyFromProgram: (...args) => calls.push(args) }) }
    );
    assert.equal(installed.t, term);
    assert.equal(installed.options.enabled(), true);
    settings.terminalProgramNotifications = false;
    assert.equal(installed.options.enabled(), false, 'turned off after the terminal was made, it is off');
    delete settings.terminalProgramNotifications;
    assert.equal(installed.options.enabled(), true, 'a setting not there yet is the default, on');
    const n = done();
    installed.options.onNotify(n);
    assert.deepEqual(calls, [['tab-term-7', n]], 'to the store, for its own tab');
  });

  test('PN-50: the backend answers `show_desktop_notification` — the command is registered, and the mock stands in', async () => {
    // The browser mock: nothing can be shown, so false; what was asked is kept.
    assert.equal(await mockBridge.invoke('show_desktop_notification', { title: 'T', body: 'B' }), false);
    assert.deepEqual(desktop().at(-1), { title: 'T', body: 'B' });
    for (let i = 0; i < 60; i += 1) await mockBridge.invoke('show_desktop_notification', { title: `${i}`, body: '' });
    assert.equal(desktop().length, 50, 'the mock keeps the last 50');

    // The real one: the plugin is registered, the command is in the handler,
    // and it takes exactly the arguments the store sends.
    const main = readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
    assert.match(main, /\.plugin\(tauri_plugin_notification::init\(\)\)/);
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::notification::show_desktop_notification,'), 'in generate_handler!');
    const command = readFileSync(new URL('../../src-tauri/src/commands/notification.rs', import.meta.url), 'utf8');
    assert.match(command, /pub async fn show_desktop_notification\(\s*app: tauri::AppHandle,\s*title: String,\s*body: String,?\s*\)/);
    const store = readFileSync(new URL('../../src/stores/terminalStore.js', import.meta.url), 'utf8');
    assert.ok(store.includes("invoke('show_desktop_notification', { title, body })"), 'the store sends title and body');
  });

  test('PN-51: teardown — leave the store as the next suite expects it', () => {
    S.setState(saved);
    mockBridge.desktopNotifications.length = 0;
    assert.equal(S.getState().groups, saved.groups);
  });
});
