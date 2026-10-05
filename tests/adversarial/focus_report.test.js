/**
 * The focus-out a terminal taken off screen never sent (src/lib/focusReport.js).
 *
 * WebKit drops the focus of a hidden textarea without a `blur`, so xterm never
 * tells the program its terminal went out of sight. Measured in the macOS app
 * (2026-10-05): with OpenCode running, Ctrl+Shift+` (New Terminal) hid its tab
 * and OpenCode heard nothing, so it held back the notification it sends only
 * while you are elsewhere. A click on another tab's chip did send `CSI O`.
 *
 * The tracker is checked against real xterm (`@xterm/headless`): the program
 * turns focus reporting on with `CSI ? 1004 h`, xterm reports `CSI I` /
 * `CSI O` through `onData`, and `reportOut` sends what xterm would have.
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { installFocusReports } from '../../src/lib/focusReport.js';

const { Terminal: HeadlessTerminal } = headless;

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

async function setup({ focusMode = true } = {}) {
  const term = new HeadlessTerminal({ cols: 40, rows: 5, allowProposedApi: true });
  const sent = [];
  term.onData((d) => sent.push(d));
  const reports = installFocusReports(term);
  if (focusMode) await write(term, '\x1b[?1004h');
  return { term, sent, reports };
}

const NO_FOCUS = { activeElement: null };

describe('Focus reports: the CSI O a hidden terminal never sent', () => {
  test('FR-01: nothing before the program has been told anything', async () => {
    const { term, sent, reports } = await setup();
    assert.equal(reports.reported, null);
    assert.equal(reports.reportOut(NO_FOCUS), false);
    assert.deepEqual(sent, []);
    term.dispose();
  });

  test('FR-02: told it had focus, then hidden — CSI O, once', async () => {
    const { term, sent, reports } = await setup();
    term.input('\x1b[I', false); // what xterm sends as the textarea takes the focus
    assert.equal(reports.reported, 'in');
    assert.equal(reports.reportOut(NO_FOCUS), true);
    assert.deepEqual(sent, ['\x1b[I', '\x1b[O']);
    assert.equal(reports.reported, 'out');
    // Taken off screen again before it came back: already told.
    assert.equal(reports.reportOut(NO_FOCUS), false);
    assert.deepEqual(sent, ['\x1b[I', '\x1b[O']);
    term.dispose();
  });

  test('FR-03: a real blur already reported it — nothing more', async () => {
    const { term, sent, reports } = await setup();
    term.input('\x1b[I', false);
    term.input('\x1b[O', false); // xterm's own, from a blur that did fire
    assert.equal(reports.reportOut(NO_FOCUS), false);
    assert.deepEqual(sent, ['\x1b[I', '\x1b[O']);
    term.dispose();
  });

  test('FR-04: a program that never asked for focus reports hears nothing', async () => {
    const { term, sent, reports } = await setup({ focusMode: false });
    term.input('\x1b[I', false);
    assert.equal(reports.reportOut(NO_FOCUS), false);
    assert.deepEqual(sent, ['\x1b[I']);
    term.dispose();
  });

  test('FR-05: turned off again (CSI ? 1004 l) — nothing', async () => {
    const { term, sent, reports } = await setup();
    term.input('\x1b[I', false);
    await write(term, '\x1b[?1004l');
    assert.equal(reports.reportOut(NO_FOCUS), false);
    assert.deepEqual(sent, ['\x1b[I']);
    term.dispose();
  });

  test('FR-06: back on screen, xterm says CSI I again, and the next hide is told', async () => {
    const { term, sent, reports } = await setup();
    term.input('\x1b[I', false);
    reports.reportOut(NO_FOCUS);
    term.input('\x1b[I', false);
    assert.equal(reports.reportOut(NO_FOCUS), true);
    assert.deepEqual(sent, ['\x1b[I', '\x1b[O', '\x1b[I', '\x1b[O']);
    term.dispose();
  });

  test('FR-07: on screen with the focus, xterm will report the blur itself; off screen, report even if it is still activeElement', () => {
    const textarea = { tag: 'textarea' };
    const listeners = [];
    const inputs = [];
    const element = { isConnected: true, offsetParent: {} };
    const term = {
      textarea,
      element,
      modes: { sendFocusMode: true },
      onData: (fn) => {
        listeners.push(fn);
        return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) };
      },
      input: (d) => {
        inputs.push(d);
        listeners.forEach((fn) => fn(d));
      },
      loadAddon(addon) {
        addon.activate(this);
      },
    };
    const reports = installFocusReports(term);
    term.input('\x1b[I');
    // React's development double run of the cleanup: still on screen and focused.
    assert.equal(reports.reportOut({ activeElement: textarea }), false);
    assert.deepEqual(inputs, ['\x1b[I']);
    // The pane switched: hidden (`display: none` above it), though WebKit still
    // names the textarea activeElement — no blur will come, so report.
    element.offsetParent = null;
    assert.equal(reports.reportOut({ activeElement: textarea }), true);
    assert.deepEqual(inputs, ['\x1b[I', '\x1b[O']);
    // Back on screen, told again, then detached altogether.
    element.offsetParent = {};
    term.input('\x1b[I');
    element.isConnected = false;
    assert.equal(reports.reportOut({ activeElement: textarea }), true);
    assert.deepEqual(inputs, ['\x1b[I', '\x1b[O', '\x1b[I', '\x1b[O']);
  });

  test('FR-08: never throws, and nothing once disposed', async () => {
    const { term, sent, reports } = await setup();
    term.input('\x1b[I', false);
    reports.dispose();
    assert.equal(reports.reportOut(NO_FOCUS), false);
    assert.deepEqual(sent, ['\x1b[I']);
    const broken = installFocusReports({
      modes: { sendFocusMode: true },
      onData: (fn) => {
        fn('\x1b[I');
        return { dispose() {} };
      },
      input: () => {
        throw new Error('boom');
      },
      loadAddon(addon) {
        addon.activate(this);
      },
    });
    assert.equal(broken.reportOut(NO_FOCUS), false);
    assert.equal(installFocusReports(null), null);
    assert.equal(installFocusReports({}), null);
    term.dispose();
  });

  test('FR-09: wired — every terminal follows its reports, and TerminalView reports a terminal it takes off screen', () => {
    const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(registry, /const focusReports = installFocusReports\(term\);/);
    assert.match(registry, /export function reportFocusOut\(tabId\)/);
    const view = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
    // Another tab bound to the pane, or the pane gone: the cleanup of the old tabId.
    assert.match(view, /useEffect\(\(\) => \(\) => reportFocusOut\(tabId\), \[tabId\]\);/);
    // The pane no longer the active one.
    assert.match(view, /if \(!active\) reportFocusOut\(tabId\);/);
  });
});
