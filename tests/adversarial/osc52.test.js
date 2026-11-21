/**
 * OSC 52 (bundle 2, A8): a program putting text on the clipboard, off by
 * default. Writes only, to the one system clipboard; reads and clears are
 * refused, more than 128 KiB is refused whole, output kept from before the
 * terminal was shown is ignored, and while writes are off the first attempt
 * in a terminal prints one notice naming the setting — after the alternate
 * screen is gone, never into it. See src/lib/osc52.js.
 *
 * Run through real xterm (`@xterm/headless`, the same parser as the app's)
 * with the installer and a mock invoke: no test reaches the system clipboard.
 * O52-10 checks the registry's wiring and the IPC wrapper; O52-99 puts the
 * console and the mock bridge back.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import {
  decideOsc52,
  installOsc52,
  MAX_OSC52_BASE64,
  MAX_OSC52_BYTES,
  OSC52_DISABLED_NOTICE,
  OSC52_SETTING,
  OSC52_SIZE_NOTICE,
} from '../../src/lib/osc52.js';
import { mockBridge, writeClipboardText } from '../../src/lib/ipc.js';

const { Terminal } = headless;
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const b64Bytes = (bytes) => Buffer.from(bytes).toString('base64');
const osc52 = (pc, pd, end = BEL) => `${ESC}]52;${pc};${pd}${end}`;
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const realConsole = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));
function restoreConsole() {
  for (const m of CONSOLE_METHODS) console[m] = realConsole[m];
}
/** Every console call from now on, as the strings it was given, until `restoreConsole`. */
function spyConsole() {
  const records = [];
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args) => records.push({ method: m, text: args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ') });
  }
  return records;
}

function resetBridge() {
  mockBridge.lastClipboardWrite = null;
  mockBridge.clipboardWrites = 0;
  mockBridge.clipboard = { text: '', has_image: false };
}

/**
 * A real xterm with the OSC 52 addon. `invoke` is the mock the writes go
 * through (`clipboard_write_text`, as the registry wires it); `enabled` and
 * `kept` are read at each sequence, as the setting and `history.reading` are.
 */
function terminal({ enabled = true, kept = false, told = new Set(), noticeKey = 'tab-1', invoke, before } = {}) {
  const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
  const calls = [];
  const notices = [];
  const replies = [];
  const state = { enabled, kept };
  const fakeInvoke =
    invoke ??
    ((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
  // Something xterm would otherwise hand the sequence to: registered first,
  // so it runs only when the addon's handler declines.
  const fallthrough = [];
  if (before !== false) term.parser.registerOscHandler(52, (data) => (fallthrough.push(data), false));
  term.onData((data) => replies.push(data));
  const addon = installOsc52(term, {
    enabled: () => (typeof state.enabled === 'function' ? state.enabled() : state.enabled),
    keptHistory: () => state.kept,
    write: (text) => fakeInvoke('clipboard_write_text', { text }),
    notice: (message) => notices.push(message),
    noticeKey,
    // null: none of its own, so the session's count by tab id applies.
    told: told ?? undefined,
  });
  return { term, calls, notices, replies, state, addon, fallthrough };
}

describe('OSC 52: a program setting the clipboard', () => {
  beforeEach(() => {
    restoreConsole();
    resetBridge();
  });

  test('O52-01: enabled, a write puts the decoded text on the clipboard once, for c, an empty Pc, s and the rest', async () => {
    const t = terminal();
    await write(t.term, osc52('c', b64('hi')));
    assert.deepEqual(t.calls, [['clipboard_write_text', { text: 'hi' }]]);
    for (const pc of ['', 's']) {
      t.calls.length = 0;
      await write(t.term, osc52(pc, b64('hi')));
      assert.deepEqual(t.calls, [['clipboard_write_text', { text: 'hi' }]], `Pc '${pc}'`);
    }
    for (const pc of ['p', 'q', '0', '7', 'cs', 'c0']) {
      t.calls.length = 0;
      await write(t.term, osc52(pc, b64('hi'), ST));
      assert.deepEqual(t.calls, [['clipboard_write_text', { text: 'hi' }]], `Pc '${pc}', ended by ST`);
    }
    // Text as it was: other scripts, emoji, new lines, no padding.
    t.calls.length = 0;
    const text = '한글 ✓ 🙂\nline two\r\n';
    await write(t.term, osc52('c', b64(text)));
    await write(t.term, osc52('c', b64('ab').replace(/=+$/, '')));
    assert.deepEqual(t.calls.map(([, args]) => args.text), [text, 'ab']);
    assert.deepEqual(decideOsc52(`c;${b64('hi')}`, { enabled: true }), { action: 'write', text: 'hi' });
    // Any other target is not ours to answer.
    t.calls.length = 0;
    for (const data of [osc52('x', b64('hi')), osc52('c8', b64('hi')), `${ESC}]52;${b64('hi')}${BEL}`]) await write(t.term, data);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.notices, []);
    assert.deepEqual(decideOsc52('x;aGk=', { enabled: true }), { action: 'refuse-target' });
    assert.deepEqual(decideOsc52('aGk=', { enabled: true }), { action: 'refuse-target' });
  });

  test('O52-02: a read is refused — nothing is written, nothing answered, no notice — on or off', async () => {
    for (const enabled of [true, false]) {
      const t = terminal({ enabled });
      for (const pc of ['c', '', 'p', 's0']) {
        await write(t.term, osc52(pc, '?'));
        await write(t.term, osc52(pc, '?', ST));
      }
      await settle();
      assert.deepEqual(t.calls, [], `enabled ${enabled}`);
      assert.deepEqual(t.replies, [], 'onData emits nothing: no answer reaches the program');
      assert.deepEqual(t.notices, []);
      assert.deepEqual(decideOsc52('c;?', { enabled }), { action: 'refuse-read' });
    }
  });

  test('O52-03: a clear — empty, or not base64 — is refused, without a notice', async () => {
    for (const enabled of [true, false]) {
      const t = terminal({ enabled });
      for (const pd of ['', '!!!!', 'abcde', 'ab=c', '====', 'aGk=é', 'a b=', 'aGk==']) {
        await write(t.term, osc52('c', pd));
        assert.equal(decideOsc52(`c;${pd}`, { enabled }).action, 'refuse-clear', JSON.stringify(pd));
      }
      assert.deepEqual(t.calls, [], `enabled ${enabled}`);
      assert.deepEqual(t.notices, []);
    }
  });

  test('O52-04: 128 KiB decoded is written; one byte more, over-long base64 and bytes that are not UTF-8 are refused whole', async () => {
    assert.equal(MAX_OSC52_BYTES, 131072);
    assert.equal(MAX_OSC52_BASE64, 174764);
    const t = terminal();
    const exact = 'a'.repeat(131072);
    await write(t.term, osc52('c', b64(exact)));
    assert.equal(t.calls.length, 1, 'exactly 128 KiB goes');
    assert.equal(t.calls[0][1].text, exact, 'whole');
    t.calls.length = 0;
    const over = 'a'.repeat(131073);
    assert.equal(b64(over).length, 174764, 'one byte over still fits the base64 limit, so the decoded size is what refuses it');
    await write(t.term, osc52('c', b64(over)));
    await write(t.term, osc52('c', 'A'.repeat(174765)));
    await write(t.term, osc52('c', b64('한'.repeat(43691))));
    await write(t.term, osc52('c', b64Bytes([0x68, 0xff, 0x69])));
    await write(t.term, osc52('c', b64Bytes([0xe2, 0x82])));
    assert.deepEqual(t.calls, [], 'nothing is cut short to fit');
    assert.deepEqual(decideOsc52(`c;${b64(over)}`, { enabled: true }), { action: 'refuse-size' });
    assert.deepEqual(decideOsc52(`c;${'A'.repeat(174765)}`, { enabled: true }), { action: 'refuse-size' });
    assert.deepEqual(decideOsc52(`c;${b64Bytes([0xff])}`, { enabled: true }), { action: 'refuse-size' });
    assert.equal(decideOsc52(`c;${b64('한'.repeat(43690))}`, { enabled: true }).action, 'write', '131070 bytes of Hangul go');
    // While on, the first refusal for size says so once, without the text.
    assert.deepEqual(t.notices, [OSC52_SIZE_NOTICE]);
    assert.ok(!OSC52_SIZE_NOTICE.includes('aaaa'));
  });

  test('O52-05: output kept from before the terminal was shown is ignored — no write, no notice', async () => {
    for (const enabled of [true, false]) {
      const t = terminal({ enabled, kept: true });
      await write(t.term, osc52('c', b64('from an hour ago')));
      await write(t.term, osc52('c', 'A'.repeat(174765)));
      await write(t.term, osc52('c', '?'));
      assert.deepEqual(t.calls, [], `enabled ${enabled}`);
      assert.deepEqual(t.notices, []);
      // Read at each sequence: live output after it is handled.
      t.state.kept = false;
      await write(t.term, osc52('c', b64('now')));
      assert.deepEqual(t.calls, enabled ? [['clipboard_write_text', { text: 'now' }]] : []);
      assert.equal(t.notices.length, enabled ? 0 : 1);
    }
  });

  test('O52-06: disabled, the first attempt prints one notice naming the setting; the next prints none; another terminal gets its own', async () => {
    assert.equal(OSC52_SETTING, 'Settings > Terminal > Let Programs Set the Clipboard (OSC 52)');
    const told = new Set();
    const a = terminal({ enabled: false, told, noticeKey: 'tab-a' });
    await write(a.term, osc52('c', b64('first')));
    assert.deepEqual(a.notices, [OSC52_DISABLED_NOTICE]);
    assert.ok(a.notices[0].includes(OSC52_SETTING), 'names the setting');
    assert.ok(!a.notices[0].includes('first'), 'never the text');
    await write(a.term, osc52('c', b64('second')));
    await write(a.term, osc52('c', 'A'.repeat(174765)));
    assert.equal(a.notices.length, 1, 'one per terminal');
    assert.deepEqual(a.calls, [], 'and nothing was written');
    const b = terminal({ enabled: false, told, noticeKey: 'tab-b' });
    await write(b.term, osc52('c', b64('other')));
    assert.deepEqual(b.notices, [OSC52_DISABLED_NOTICE], 'another terminal is told for itself');
    // The same tab again (its xterm made anew) was told already this session.
    const again = terminal({ enabled: false, told, noticeKey: 'tab-a' });
    await write(again.term, osc52('c', b64('third')));
    assert.deepEqual(again.notices, []);
    // The setting is read at each sequence: turned on, the write goes.
    a.state.enabled = true;
    await write(a.term, osc52('c', b64('allowed')));
    assert.deepEqual(a.calls, [['clipboard_write_text', { text: 'allowed' }]]);
    // Without a Set of its own, the count is the session's, by tab id.
    const key = `tab-session-${Math.random()}`;
    const one = terminal({ enabled: false, told: null, noticeKey: key });
    await write(one.term, osc52('c', b64('x')));
    const two = terminal({ enabled: false, told: null, noticeKey: key });
    await write(two.term, osc52('c', b64('x')));
    assert.deepEqual([one.notices.length, two.notices.length], [1, 0]);
  });

  test('O52-07: disabled on the alternate screen, the notice waits for the normal screen', async () => {
    const t = terminal({ enabled: false });
    await write(t.term, ALT_ON);
    assert.equal(t.term.buffer.active.type, 'alternate');
    await write(t.term, osc52('c', b64('from vim')));
    await write(t.term, osc52('c', b64('from vim again')));
    assert.deepEqual(t.notices, [], 'never into a full-screen program');
    await write(t.term, ALT_OFF);
    assert.equal(t.term.buffer.active.type, 'normal');
    assert.deepEqual(t.notices, [OSC52_DISABLED_NOTICE], 'once it is gone, exactly one');
    await write(t.term, ALT_ON + ALT_OFF);
    assert.equal(t.notices.length, 1, 'not again on the next switch');
    // The size notice waits the same way.
    const big = terminal({ enabled: true });
    await write(big.term, ALT_ON + osc52('c', 'A'.repeat(174765)));
    assert.deepEqual(big.notices, []);
    await write(big.term, ALT_OFF);
    assert.deepEqual(big.notices, [OSC52_SIZE_NOTICE]);
    // A terminal closed while one waits drops it.
    const closed = terminal({ enabled: false, noticeKey: 'tab-closed' });
    await write(closed.term, ALT_ON + osc52('c', b64('x')));
    closed.addon.dispose();
    await write(closed.term, ALT_OFF);
    assert.deepEqual(closed.notices, []);
  });

  test('O52-08: nothing a program wrote reaches the console — not on a write, a refusal, a failure or a throw', async () => {
    const records = spyConsole();
    const secret = 'S3CRET-payload-from-the-program';
    const encoded = b64(secret);
    try {
      const cases = [
        terminal({ enabled: true }),
        terminal({ enabled: false }),
        terminal({ enabled: true, kept: true }),
        terminal({ enabled: true, invoke: () => Promise.reject(new Error('could not write the clipboard: the OS said no')) }),
        terminal({
          enabled: true,
          invoke: () => {
            throw new Error('the bridge is gone');
          },
        }),
        terminal({
          enabled: () => {
            throw new Error('the store is gone');
          },
        }),
      ];
      for (const t of cases) {
        for (const data of [
          osc52('c', encoded),
          osc52('c', encoded, ST),
          osc52('c', '?'),
          osc52('c', ''),
          osc52('c', `${encoded}!`),
          osc52('x', encoded),
          osc52('c', b64(secret.repeat(5000))),
          osc52('c', b64Bytes([...Buffer.from(secret), 0xff])),
          ALT_ON + osc52('c', encoded) + ALT_OFF,
        ]) {
          await write(t.term, data);
        }
      }
      await settle();
      await settle();
      assert.deepEqual(cases[0].calls.map(([, args]) => args.text), [secret, secret, secret]);
      const logged = records.map((r) => r.text).join('\n');
      for (const fragment of [secret, encoded, 'S3CRET', encoded.slice(0, 12)]) {
        assert.ok(!logged.includes(fragment), `the console never shows ${fragment}`);
      }
      // A failed write is warned about, with the error alone.
      assert.ok(records.some((r) => r.method === 'warn' && r.text.includes('the OS said no')), 'the failure is reported');
      assert.ok(records.some((r) => r.method === 'warn' && r.text.includes('the bridge is gone')));
      const notices = cases.flatMap((t) => t.notices).join('\n');
      assert.ok(!notices.includes('S3CRET') && !notices.includes(encoded.slice(0, 12)), 'nor any notice');
    } finally {
      restoreConsole();
    }
    // The module itself logs only errors, never its data.
    const src = read('../../src/lib/osc52.js');
    const calls = [...src.matchAll(/console\.\w+\(([^;]*)\);/g)].map((m) => m[1]);
    assert.deepEqual(calls, [
      "'[Terminal] could not handle OSC 52:', err?.name || 'error'",
      "'[Terminal] could not set the clipboard (OSC 52):', err?.message ?? String(err)",
    ]);
  });

  test('O52-09: every OSC 52 is consumed — none reaches xterm\'s other handlers — and a throw never wedges the parser', async () => {
    const throwing = () => {
      throw new Error('boom');
    };
    // The throwing write is warned about (O52-08); kept off the run's output.
    spyConsole();
    const cases = [
      terminal({ enabled: true }),
      terminal({ enabled: false }),
      terminal({ enabled: true, kept: true }),
      terminal({ enabled: throwing }),
      terminal({ enabled: true, invoke: throwing }),
    ];
    // A notice that throws, too.
    const loud = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    const loudFallthrough = [];
    loud.parser.registerOscHandler(52, (data) => (loudFallthrough.push(data), false));
    installOsc52(loud, { enabled: () => false, notice: throwing, told: new Set(), noticeKey: 't' });
    for (const t of [...cases, { term: loud, fallthrough: loudFallthrough }]) {
      for (const data of [
        osc52('c', b64('hi')),
        osc52('c', '?'),
        osc52('c', ''),
        osc52('c', '***'),
        osc52('zz', b64('hi')),
        `${ESC}]52${BEL}`,
        osc52('c', 'A'.repeat(174765)),
      ]) {
        await write(t.term, data);
      }
      await write(t.term, 'still parsing');
      assert.deepEqual(t.fallthrough, [], 'the handler returned true for each');
      assert.ok(t.term.buffer.active.getLine(0).translateToString(true).includes('still parsing'), 'the write queue moved on');
    }
    // Once disposed, the handler is gone with the terminal's addons.
    const t = terminal({ enabled: true });
    t.addon.dispose();
    await write(t.term, osc52('c', b64('hi')));
    assert.deepEqual(t.calls, []);
    assert.equal(t.fallthrough.length, 1);
    assert.equal(installOsc52({}), null, 'nothing to install on a test double without a parser');
    restoreConsole();
  });

  test('O52-10: the registry installs it with the setting, kept history, clipboard_write_text and the notice; the wrapper calls the backend', async () => {
    const src = read('../../src/components/terminal/terminalRegistry.js');
    assert.match(src, /^import \{ installOsc52 \} from '\.\.\/\.\.\/lib\/osc52\.js';$/m);
    assert.match(
      src,
      /installOsc52\(term, \{\n\s*enabled: \(\) => useSettingsStore\.getState\(\)\.terminalOsc52Write === true,\n\s*keptHistory: \(\) => history\.reading,\n\s*write: \(text\) => writeClipboardText\(text\),\n\s*notice: \(message\) => notifyTerminal\(tabId, message\),\n\s*noticeKey: tabId,\n\s*\}\);/
    );
    // Inside getOrCreateTerminal, after `history` exists.
    const start = src.indexOf('export function getOrCreateTerminal(');
    const at = src.indexOf('installOsc52(term, {');
    assert.ok(start > 0 && at > src.indexOf('const history = createHistoryMark();', start), 'in getOrCreateTerminal, after history');
    assert.ok(at < src.indexOf('\nexport function', start + 10), 'and inside it');
    const ipc = read('../../src/lib/ipc.js');
    assert.match(ipc, /export function writeClipboardText\(text\) \{\n\s*return invoke\('clipboard_write_text', \{ text \}\);\n\}/);
    await writeClipboardText('copied by a program');
    assert.equal(mockBridge.lastClipboardWrite, 'copied by a program');
    assert.equal(mockBridge.clipboardWrites, 1);
    // No addon of xterm's own answers reads.
    const pkg = JSON.parse(read('../../package.json'));
    assert.ok(!('@xterm/addon-clipboard' in { ...pkg.dependencies, ...pkg.devDependencies }));
  });

  test('O52-99: teardown — the console and the mock bridge as the next suite expects', () => {
    restoreConsole();
    resetBridge();
    assert.equal(console.warn, realConsole.warn);
    assert.equal(mockBridge.lastClipboardWrite, null);
  });
});
