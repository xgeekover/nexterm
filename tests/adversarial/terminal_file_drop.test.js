/**
 * Dropping files on a terminal pane, past the quoting (drop_paths.test.js has
 * that): which terminal takes the paths, the order of Tauri's drag events and
 * what each one does, a press on an Explorer row — a click opened by its own
 * release, or a drag — the highlight both drags share, and the paste itself.
 *
 * Node mounts no component, so every decision lives in a module that can be
 * handed fakes: src/lib/terminalFileDrop.js (the pane, the plan, the event
 * sequencing) and src/lib/explorerDrag.js (when a press becomes a drag). What
 * binds them to the page is thin, and is checked here where it can be without
 * a browser: the glue against the real terminal store over the browser mock
 * (TF-40…), TreeRow's handlers by calling the component as the function it is
 * (TF-50…), the registry's `pasteIntoTerminal` cut out of its source and run
 * against a stand-in terminal (TF-60…), and a press on a row followed through
 * a stand-in window from pointerdown to its end (TF-70…) — every way the
 * browser's own click once opened the wrong row, or a row after a drag, is
 * one of those cases. The highlight itself is drawn by the render suite
 * (tests/render/runner.js, RN-64…).
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  OS_DRAG_EVENTS,
  paneIdAtPoint,
  pathDropLabel,
  performPathInsert,
  planPathInsert,
  shellPathOf,
  showTabInPane,
  startOsFileDrop,
} from '../../src/lib/terminalFileDrop.js';
import {
  EXPLORER_DRAG_THRESHOLD_PX,
  clickActivates,
  createExplorerDrag,
  followExplorerPress,
  pressArmsDrag,
} from '../../src/lib/explorerDrag.js';
import { dropPointToClient } from '../../src/lib/dropPaths.js';
import { usePathDropStore } from '../../src/stores/pathDropStore.js';
import { useTerminalStore as T, isTabClosing } from '../../src/stores/terminalStore.js';
import { useSystemStore } from '../../src/stores/systemStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

// The glue imports the xterm registry, and TreeRow is JSX: the render suite's
// loader stands in for `@xterm/*` and parses JSX, as tab_reorder_ui does.
register('../render/jsxLoader.mjs', import.meta.url);
const glue = await import('../../src/components/terminal/insertPathsIntoPane.js');
const { TreeRow } = await import('../../src/components/explorer/TreeRow.jsx');

/** A source file as written, whatever line endings the checkout gave it. */
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// --- a layout, by hand ------------------------------------------------------

const leaf = (id, tabIds, activeTabId = tabIds[0] ?? null) => ({ type: 'leaf', id, tabIds, activeTabId });
const split = (id, children) => ({
  type: 'split',
  id,
  direction: 'horizontal',
  children,
  sizes: children.map(() => 100 / children.length),
});

/**
 * Two groups. On screen, g1: pane p1 shows t2 (Git Bash) with t1 (cmd)
 * behind it, p2 shows an exited cmd, p3 is empty, p4 names a tab that is
 * gone and then a live PowerShell. g2, off screen, has p9.
 */
const LAYOUT = {
  activeGroupId: 'g1',
  groups: [
    {
      id: 'g1',
      tree: split('s1', [
        leaf('p1', ['t1', 't2'], 't2'),
        split('s2', [leaf('p2', ['t3']), leaf('p3', []), leaf('p4', ['gone', 't4'], 'gone')]),
      ]),
      activePaneId: 'p1',
    },
    { id: 'g2', tree: leaf('p9', ['t9']), activePaneId: 'p9' },
  ],
  tabs: [
    { id: 't1', shell: 'C:\\Windows\\System32\\cmd.exe' },
    { id: 't2', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    { id: 't3', shell: 'C:\\Windows\\System32\\cmd.exe', exited: { code: 0 } },
    { id: 't4', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    { id: 't9', shell: 'C:\\Windows\\System32\\cmd.exe' },
  ],
};
const WINDOWS = { platform: 'windows' };

describe('Which terminal a drop goes to', () => {
  test('TF-01: the tab a pane is showing takes the paths, written for ITS shell', () => {
    const plan = planPathInsert(LAYOUT, 'p1', ['C:\\My Docs\\a.txt', 'D:\\b'], WINDOWS);
    assert.deepEqual(plan, {
      ok: true,
      paneId: 'p1',
      tabId: 't2',
      text: "'C:/My Docs/a.txt' D:/b",
      count: 2,
      skipped: [],
    });
    const deep = planPathInsert(LAYOUT, 'p4', ['C:\\My Docs\\a.txt'], WINDOWS);
    assert.equal(deep.tabId, 't4', 'a pane deep in the tree; its active tab is gone, so the one it draws');
    assert.equal(deep.text, "'C:\\My Docs\\a.txt'", 'PowerShell quoting');
  });

  test('TF-02: only a pane of the group on screen can take a drop', () => {
    for (const paneId of ['p9', 'p-unknown', null, undefined, '']) {
      const plan = planPathInsert(LAYOUT, paneId, ['C:\\a'], WINDOWS);
      assert.equal(plan.ok, false, String(paneId));
      assert.equal(plan.reason, 'no-pane', String(paneId));
    }
    assert.equal(planPathInsert({}, 'p1', ['C:\\a'], WINDOWS).reason, 'no-pane', 'no layout at all');
    assert.equal(planPathInsert(null, 'p1', ['C:\\a'], WINDOWS).reason, 'no-pane');
    const switched = { ...LAYOUT, activeGroupId: 'g2' };
    assert.equal(planPathInsert(switched, 'p9', ['C:\\a'], WINDOWS).tabId, 't9', 'once its group is on screen');
    assert.equal(planPathInsert(switched, 'p1', ['C:\\a'], WINDOWS).reason, 'no-pane');
  });

  test('TF-03: an empty pane takes nothing', () => {
    assert.deepEqual(planPathInsert(LAYOUT, 'p3', ['C:\\a'], WINDOWS), {
      ok: false,
      reason: 'no-tab',
      paneId: 'p3',
      tabId: null,
      skipped: [],
    });
    const orphaned = { ...LAYOUT, tabs: LAYOUT.tabs.filter((t) => t.id !== 't4') };
    assert.equal(planPathInsert(orphaned, 'p4', ['C:\\a'], WINDOWS).reason, 'no-tab', 'every tab it names is gone');
  });

  test('TF-04: nor does a terminal whose shell exited, or one being closed', () => {
    assert.deepEqual(planPathInsert(LAYOUT, 'p2', ['C:\\a'], WINDOWS), {
      ok: false,
      reason: 'exited',
      paneId: 'p2',
      tabId: 't3',
      skipped: [],
    });
    const asked = [];
    const closing = planPathInsert(LAYOUT, 'p1', ['C:\\a'], {
      ...WINDOWS,
      isClosing: (id) => {
        asked.push(id);
        return id === 't2';
      },
    });
    assert.equal(closing.reason, 'closing');
    assert.equal(closing.tabId, 't2');
    assert.deepEqual(asked, ['t2'], 'only the tab the paths would go to is asked about');
  });

  test('TF-05: what cannot be written is left out; with nothing left, nothing is inserted', () => {
    const cmdPane = { ...LAYOUT, groups: [{ id: 'g1', tree: leaf('p1', ['t1']) }], activeGroupId: 'g1' };
    const some = planPathInsert(cmdPane, 'p1', ['C:\\a', 'C:\\b"c', 'C:\\d\ne', 'C:\\f g'], WINDOWS);
    assert.equal(some.ok, true);
    assert.equal(some.text, 'C:\\a "C:\\f g"');
    assert.equal(some.count, 2, 'the highlight says how many will go in');
    assert.deepEqual(some.skipped, ['C:\\b"c', 'C:\\d\ne']);
    const none = planPathInsert(cmdPane, 'p1', ['C:\\b"c'], WINDOWS);
    assert.deepEqual(none, { ok: false, reason: 'nothing-to-insert', paneId: 'p1', tabId: 't1', skipped: ['C:\\b"c'] });
    assert.equal(planPathInsert(cmdPane, 'p1', [], WINDOWS).reason, 'nothing-to-insert');
    assert.equal(planPathInsert(cmdPane, 'p1', null, WINDOWS).reason, 'nothing-to-insert');
  });

  test('TF-06: a tab with no shell recorded falls back to the setting, then to the backend\'s default', () => {
    assert.equal(shellPathOf({ shell: '/bin/zsh' }, { defaultShell: 'pwsh', systemShell: '/bin/bash' }), '/bin/zsh');
    assert.equal(shellPathOf({ shell: '  ' }, { defaultShell: 'pwsh' }), 'pwsh');
    assert.equal(shellPathOf({}, { defaultShell: 'default', systemShell: '/usr/bin/fish' }), '/usr/bin/fish');
    assert.equal(shellPathOf({}, { defaultShell: '', systemShell: null }), null);
    assert.equal(shellPathOf({}, { defaultShell: 'default' }), 'default');
    assert.equal(shellPathOf(null), null);

    const fishy = { activeGroupId: 'g', groups: [{ id: 'g', tree: leaf('p', ['t']) }], tabs: [{ id: 't' }] };
    const plan = planPathInsert(fishy, 'p', ['/a b\\c'], {
      platform: 'linux',
      defaultShell: 'default',
      systemShell: '/usr/bin/fish',
    });
    assert.equal(plan.text, "'/a b\\\\c'", "fish's quoting, from the login shell the backend reported");
  });
});

describe('Carrying a drop out', () => {
  const recorder = (pasted = true) => {
    const calls = [];
    return {
      calls,
      activate: (...args) => calls.push(['activate', ...args]),
      paste: (...args) => {
        calls.push(['paste', ...args]);
        return pasted;
      },
    };
  };

  test('TF-07: the pane is made active first, then the text is pasted into its tab', () => {
    const r = recorder(true);
    const outcome = performPathInsert(planPathInsert(LAYOUT, 'p1', ['C:\\a b'], WINDOWS), r);
    assert.deepEqual(r.calls, [
      ['activate', 'p1', 't2'],
      ['paste', 't2', "'C:/a b'"],
    ]);
    assert.deepEqual(outcome, {
      inserted: true,
      reason: null,
      paneId: 'p1',
      tabId: 't2',
      text: "'C:/a b'",
      count: 1,
      skipped: [],
    });
  });

  test('TF-08: a refused drop touches nothing — no focus moved, nothing pasted', () => {
    for (const [paneId, reason] of [
      ['p2', 'exited'],
      ['p3', 'no-tab'],
      ['p9', 'no-pane'],
    ]) {
      const r = recorder(true);
      const outcome = performPathInsert(planPathInsert(LAYOUT, paneId, ['C:\\a'], WINDOWS), r);
      assert.deepEqual(r.calls, [], paneId);
      assert.equal(outcome.inserted, false, paneId);
      assert.equal(outcome.reason, reason, paneId);
      assert.equal(outcome.text, '', paneId);
    }
    const r = recorder(true);
    assert.equal(performPathInsert(null, r).reason, 'no-pane');
    assert.deepEqual(r.calls, []);
  });

  test('TF-09: a tab with no live terminal to take the paste says so', () => {
    const r = recorder(false);
    const outcome = performPathInsert(planPathInsert(LAYOUT, 'p1', ['C:\\a'], WINDOWS), r);
    assert.equal(outcome.inserted, false);
    assert.equal(outcome.reason, 'no-terminal');
    assert.equal(outcome.tabId, 't2');
  });
});

describe('The pane under the pointer, and what its highlight says', () => {
  /** A page small enough to write by hand: elements know their ancestors' attributes. */
  function fakePage(map) {
    const asked = [];
    const element = (attrs) => ({
      closest: (selector) => {
        const name = /^\[(data-[a-z-]+)\]$/.exec(selector)?.[1];
        return name && name in attrs ? { getAttribute: (n) => attrs[n] ?? null } : null;
      },
    });
    return {
      asked,
      elementFromPoint: (x, y) => {
        asked.push([x, y]);
        const hit = map(x, y);
        return hit ? element(hit) : null;
      },
    };
  }

  test('TF-10: a pane is its body and its tab strip; anything else is no pane', () => {
    const page = fakePage((x) => {
      if (x < 100) return { 'data-tab-strip': 'p1', 'data-pane-body': 'never-both' };
      if (x < 200) return { 'data-pane-body': 'p2' };
      if (x < 300) return { 'data-pane-body': '' };
      return { 'data-explorer': 'x' };
    });
    assert.equal(paneIdAtPoint(50, 5, page), 'p1', 'the strip');
    assert.equal(paneIdAtPoint(150, 5, page), 'p2', 'the body');
    assert.equal(paneIdAtPoint(250, 5, page), null, 'a body with no id');
    assert.equal(paneIdAtPoint(350, 5, page), null, 'not a pane');
    assert.equal(paneIdAtPoint(5, 5, { elementFromPoint: () => null }), null, 'outside the page');
    const before = page.asked.length;
    for (const [x, y] of [[NaN, 1], [1, Infinity], [undefined, 2]]) {
      assert.equal(paneIdAtPoint(x, y, page), null);
    }
    assert.equal(page.asked.length, before, 'elementFromPoint throws on a non-finite point and is not asked');
    assert.equal(paneIdAtPoint(1, 1, null), null, 'no document');
  });

  test('TF-11: "Insert path" for one, "Insert N paths" for more', () => {
    assert.equal(pathDropLabel(1), 'Insert path');
    assert.equal(pathDropLabel(2), 'Insert 2 paths');
    assert.equal(pathDropLabel(12), 'Insert 12 paths');
    assert.equal(pathDropLabel(0), 'Insert path');
  });

  test('TF-12: the highlight store writes only what changed, and only a real target', () => {
    const S = usePathDropStore;
    S.setState({ target: null });
    let writes = 0;
    const off = S.subscribe(() => {
      writes += 1;
    });
    try {
      S.getState().setTarget({ paneId: 'p1', count: 2 });
      S.getState().setTarget({ paneId: 'p1', count: 2 });
      assert.equal(writes, 1, 'a move within the same pane writes nothing');
      assert.deepEqual(S.getState().target, { paneId: 'p1', count: 2 });
      S.getState().setTarget({ paneId: 'p1', count: 3 });
      S.getState().setTarget({ paneId: 'p2', count: 3 });
      assert.equal(writes, 3);
      for (const nothing of [null, undefined, {}, { paneId: '', count: 1 }, { paneId: 'p1', count: 0 }, { paneId: 7, count: 1 }]) {
        S.getState().setTarget({ paneId: 'p5', count: 1 });
        S.getState().setTarget(nothing);
        assert.equal(S.getState().target, null, JSON.stringify(nothing));
      }
      const before = writes;
      S.getState().setTarget(null);
      S.getState().clearTarget();
      assert.equal(writes, before, 'clearing nothing writes nothing');
      S.getState().setTarget({ paneId: 'p1', count: 1, extra: 'dropped' });
      assert.deepEqual(S.getState().target, { paneId: 'p1', count: 1 });
      S.getState().clearTarget();
      assert.equal(S.getState().target, null);
    } finally {
      off();
      S.setState({ target: null });
    }
  });
});

// --- Tauri's drag events, faked ---------------------------------------------

/**
 * A stand-in for ipc.js's `listen`: handlers are live from the moment
 * `listen` is called — the harsher case, since an event can then reach a
 * listener whose subscription has not resolved — and each subscription
 * resolves only when the test says so.
 */
function fakeTauri() {
  const handlers = new Map();
  const pending = [];
  const unlistened = [];
  const listen = (event, callback) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(callback);
    let resolve;
    const subscribed = new Promise((r) => {
      resolve = r;
    });
    pending.push(() =>
      resolve(() => {
        handlers.get(event).delete(callback);
        unlistened.push(event);
      })
    );
    return subscribed;
  };
  return {
    listen,
    unlistened,
    async resolveAll() {
      for (const settle of pending.splice(0)) settle();
      await flush();
    },
    emit(event, payload) {
      for (const callback of [...(handlers.get(event) || [])]) callback(payload);
    },
    listeners(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

/**
 * Three panes side by side, 100 CSS px each, under a Windows display at 200%:
 * Tauri's positions are physical pixels, twice the CSS ones.
 */
function osDrop({ plan = null, listen = null } = {}) {
  const tauri = fakeTauri();
  const highlights = [];
  const inserts = [];
  const errors = [];
  const stop = startOsFileDrop({
    listen: listen ?? tauri.listen,
    toClient: (position) => dropPointToClient(position, { platform: 'windows', devicePixelRatio: 2 }),
    paneAt: (x) => (x < 0 ? null : x < 100 ? 'p1' : x < 200 ? 'p2' : x < 300 ? 'p3' : null),
    plan: plan ?? ((paneId, paths) => ({ ok: paneId !== 'p3', count: paths.length })),
    insert: (paneId, paths) => {
      inserts.push([paneId, paths]);
      return { inserted: true };
    },
    setTarget: (target) => highlights.push(target),
    onError: (err) => errors.push(err),
  });
  return { tauri, stop, highlights, inserts, errors };
}
const at = (cssX) => ({ x: cssX * 2, y: 40 });

describe("Files dragged in from the OS: Tauri's events, in order", () => {
  test('TF-20: it listens to the four drag events and nothing else', async () => {
    const { tauri, stop } = osDrop();
    assert.deepEqual(
      Object.values(OS_DRAG_EVENTS),
      ['tauri://drag-enter', 'tauri://drag-over', 'tauri://drag-drop', 'tauri://drag-leave']
    );
    for (const event of Object.values(OS_DRAG_EVENTS)) assert.equal(tauri.listeners(event), 1, event);
    await tauri.resolveAll();
    stop();
  });

  test('TF-21: enter highlights the pane under it, with the count; over follows; a drop inserts once and clears', async () => {
    const { tauri, stop, highlights, inserts } = osDrop();
    await tauri.resolveAll();
    const paths = ['C:\\a', 'C:\\b'];
    tauri.emit(OS_DRAG_EVENTS.enter, { paths, position: at(50) });
    assert.deepEqual(highlights.at(-1), { paneId: 'p1', count: 2 }, 'physical 100 is CSS 50: the first pane');
    tauri.emit(OS_DRAG_EVENTS.over, { position: at(150) });
    assert.deepEqual(highlights.at(-1), { paneId: 'p2', count: 2 }, 'over carries no paths; enter\'s are kept');
    tauri.emit(OS_DRAG_EVENTS.over, { paths: null, position: at(400) });
    assert.equal(highlights.at(-1), null, 'over no pane');
    tauri.emit(OS_DRAG_EVENTS.over, { position: at(120) });
    tauri.emit(OS_DRAG_EVENTS.drop, { paths, position: at(120) });
    assert.deepEqual(inserts, [['p2', paths]]);
    assert.equal(highlights.at(-1), null, 'the highlight goes with the drop');
    stop();
  });

  test('TF-22: a pane that would refuse the paths is not highlighted', async () => {
    const { tauri, stop, highlights } = osDrop();
    await tauri.resolveAll();
    tauri.emit(OS_DRAG_EVENTS.enter, { paths: ['C:\\a'], position: at(250) });
    assert.equal(highlights.at(-1), null, 'p3 refuses');
    stop();
  });

  test('TF-23: the drop goes where it lands, with the paths it carries', async () => {
    const { tauri, stop, inserts } = osDrop();
    await tauri.resolveAll();
    tauri.emit(OS_DRAG_EVENTS.enter, { paths: ['C:\\entered'], position: at(50) });
    tauri.emit(OS_DRAG_EVENTS.drop, { paths: ['C:\\dropped'], position: at(250) });
    assert.deepEqual(inserts, [['p3', ['C:\\dropped']]], 'the pane decides whether it takes them');
    stop();
  });

  test('TF-24: dropped outside every pane, or with no paths, nothing is inserted', async () => {
    const { tauri, stop, inserts, highlights } = osDrop();
    await tauri.resolveAll();
    tauri.emit(OS_DRAG_EVENTS.enter, { paths: ['C:\\a'], position: at(50) });
    tauri.emit(OS_DRAG_EVENTS.drop, { paths: ['C:\\a'], position: at(900) });
    tauri.emit(OS_DRAG_EVENTS.drop, { paths: [], position: at(50) });
    tauri.emit(OS_DRAG_EVENTS.drop, { position: at(50) });
    tauri.emit(OS_DRAG_EVENTS.drop, null);
    assert.deepEqual(inserts, []);
    assert.equal(highlights.at(-1), null);
    stop();
  });

  test('TF-25: leave clears the highlight and forgets the paths', async () => {
    const { tauri, stop, highlights, inserts } = osDrop();
    await tauri.resolveAll();
    tauri.emit(OS_DRAG_EVENTS.enter, { paths: ['C:\\a'], position: at(50) });
    tauri.emit(OS_DRAG_EVENTS.leave, null);
    assert.equal(highlights.at(-1), null);
    tauri.emit(OS_DRAG_EVENTS.over, { position: at(50) });
    assert.equal(highlights.at(-1), null, 'an over with no enter before it knows no paths to count');
    tauri.emit(OS_DRAG_EVENTS.drop, { paths: ['C:\\b'], position: at(50) });
    assert.deepEqual(inserts, [['p1', ['C:\\b']]], 'a drop still carries its own');
    stop();
  });

  test('TF-26: stopped before its subscriptions arrive (StrictMode) — nothing leaks, nothing is inserted twice', async () => {
    const tauri = fakeTauri();
    const inserts = [];
    const options = {
      listen: tauri.listen,
      toClient: (p) => dropPointToClient(p, { platform: 'macos' }),
      paneAt: () => 'p1',
      plan: () => ({ ok: true, count: 1 }),
      insert: (paneId, paths) => inserts.push([paneId, paths]),
      setTarget: () => {},
    };
    // Mount, unmount, mount again — what React does to every effect in development.
    const first = startOsFileDrop(options);
    first();
    const second = startOsFileDrop(options);
    tauri.emit(OS_DRAG_EVENTS.drop, { paths: ['/a'], position: { x: 1, y: 1 } });
    assert.deepEqual(inserts, [['p1', ['/a']]], 'the stopped one heard it too, and did nothing');

    await tauri.resolveAll();
    assert.equal(tauri.unlistened.length, 4, "the first one's four, let go the moment they arrived");
    for (const event of Object.values(OS_DRAG_EVENTS)) assert.equal(tauri.listeners(event), 1, `${event}: one listener left`);
    tauri.emit(OS_DRAG_EVENTS.drop, { paths: ['/b'], position: { x: 1, y: 1 } });
    assert.deepEqual(inserts, [['p1', ['/a']], ['p1', ['/b']]]);

    second();
    assert.equal(tauri.unlistened.length, 8);
    for (const event of Object.values(OS_DRAG_EVENTS)) assert.equal(tauri.listeners(event), 0, event);
    second();
    assert.equal(tauri.unlistened.length, 8, 'stopping twice lets go of nothing twice');
  });

  test('TF-27: a subscription that fails is reported, not thrown', async () => {
    const boom = new Error('event module failed to load');
    const rejecting = osDrop({ listen: () => Promise.reject(boom) });
    await flush();
    assert.deepEqual(rejecting.errors, [boom, boom, boom, boom]);
    rejecting.stop();
    const throwing = osDrop({
      listen: () => {
        throw boom;
      },
    });
    await flush();
    assert.equal(throwing.errors.length, 4);
    throwing.stop();
  });

  test("TF-28: stopping clears a highlight it drew, and leaves alone one it did not", async () => {
    const drew = osDrop();
    await drew.tauri.resolveAll();
    drew.tauri.emit(OS_DRAG_EVENTS.enter, { paths: ['C:\\a'], position: at(50) });
    drew.stop();
    assert.equal(drew.highlights.at(-1), null);

    const idle = osDrop();
    await idle.tauri.resolveAll();
    idle.stop();
    assert.deepEqual(idle.highlights, [], "the Explorer's drag may own the highlight; it is not this one's to clear");
  });
});

describe('A row dragged out of the Explorer', () => {
  const press = { button: 0, isPrimary: true, ctrlKey: false };
  const element = (matches = false) => ({ closest: (selector) => (matches ? { selector } : null) });

  test('TF-30: only a plain primary press on the row itself may become a drag', () => {
    assert.equal(pressArmsDrag(press, element()), true);
    assert.equal(pressArmsDrag(press, null), true, 'no element to ask: the row itself');
    assert.equal(pressArmsDrag({ ...press, button: 2 }, element()), false, 'the context menu');
    assert.equal(pressArmsDrag({ ...press, button: 1 }, element()), false);
    assert.equal(pressArmsDrag({ ...press, isPrimary: false }, element()), false, 'a second finger');
    assert.equal(pressArmsDrag(press, element(true)), false, 'the rename input or a control of the row');
    assert.equal(pressArmsDrag(press, element(), { renaming: true }), false, 'a row being renamed');
    assert.equal(pressArmsDrag({ ...press, ctrlKey: true }, element(), { platform: 'macos' }), false, 'Ctrl+click is a right click on a Mac');
    assert.equal(pressArmsDrag({ ...press, ctrlKey: true }, element(), { platform: 'windows' }), true);
    assert.equal(pressArmsDrag(null, element()), false);

    const asked = [];
    pressArmsDrag(press, { closest: (selector) => (asked.push(selector), null) });
    for (const handle of ['input', 'button', '[data-no-path-drag]']) {
      assert.ok(asked[0].split(',').map((s) => s.trim()).includes(handle), `${handle} keeps its own press`);
    }
  });

  test(`TF-31: a press becomes a drag only past ${EXPLORER_DRAG_THRESHOLD_PX}px, once; the release is a drop`, () => {
    const gesture = createExplorerDrag();
    const item = { path: 'C:\\proj\\a.txt', name: 'a.txt', isFolder: false };
    gesture.press(item, { x: 10, y: 10, pointerId: 1 });
    assert.equal(gesture.phase, 'pressed');
    assert.equal(gesture.move({ x: 13, y: 14, pointerId: 1 }), 'none', 'exactly 5px: still a click');
    assert.equal(gesture.move({ x: 10, y: 10, pointerId: 1 }), 'none');
    assert.equal(gesture.move({ x: 14, y: 14, pointerId: 1 }), 'start', '5.7px');
    assert.equal(gesture.phase, 'dragging');
    assert.equal(gesture.move({ x: 11, y: 11, pointerId: 1 }), 'move', 'back near the start, still a drag');
    assert.deepEqual(gesture.release(), { type: 'drop', item });
    assert.equal(gesture.phase, 'idle');
    assert.equal(gesture.item, null);
  });

  test('TF-32: released without crossing the threshold, the press is a click on the row PRESSED; after a drag, a drop', () => {
    const gesture = createExplorerDrag();
    const pressed = { path: '/a' };
    gesture.press(pressed, { x: 0, y: 0, pointerId: 1 });
    gesture.move({ x: 3, y: 4, pointerId: 1 });
    const click = gesture.release();
    assert.deepEqual(click, { type: 'click', item: pressed });
    assert.equal(click.item, pressed, 'the very row pressed — the release says nothing about where it landed');

    gesture.press(pressed, { x: 0, y: 0, pointerId: 1 });
    gesture.move({ x: 40, y: 0, pointerId: 1 });
    assert.deepEqual(gesture.release(), { type: 'drop', item: pressed }, 'a drag is never also a click');
  });

  test('TF-33: cancelled, a press or a drag is over — a release however late is nothing', () => {
    const gesture = createExplorerDrag();
    gesture.press({ path: '/a' }, { x: 0, y: 0, pointerId: 1 });
    gesture.move({ x: 40, y: 0, pointerId: 1 });
    assert.equal(gesture.cancel(), true, 'it was a drag');
    assert.equal(gesture.phase, 'idle');
    assert.equal(gesture.move({ x: 80, y: 0, pointerId: 1 }), 'none', 'moving on starts nothing');
    assert.deepEqual(gesture.release(), { type: 'none', item: null }, 'and the release opens and drops nothing');

    gesture.press({ path: '/a' }, { x: 0, y: 0, pointerId: 1 });
    assert.equal(gesture.cancel(), false, 'it was still a press');
    assert.deepEqual(gesture.release(), { type: 'none', item: null });
    assert.equal(gesture.cancel(), false, 'cancelling nothing');
  });

  test('TF-34: a press that never began — not armed — releases as nothing', () => {
    const gesture = createExplorerDrag();
    assert.deepEqual(gesture.release(), { type: 'none', item: null });
    assert.equal(gesture.owns(1), false);
  });

  test('TF-35: another pointer\'s moves are not this gesture\'s', () => {
    const gesture = createExplorerDrag();
    gesture.press({ path: '/a' }, { x: 0, y: 0, pointerId: 7 });
    assert.equal(gesture.owns(7), true);
    assert.equal(gesture.owns(8), false);
    assert.equal(gesture.move({ x: 90, y: 0, pointerId: 8 }), 'none');
    assert.equal(gesture.phase, 'pressed');
    assert.equal(gesture.move({ x: 90, y: 0, pointerId: 7 }), 'start');
    gesture.release();
    assert.equal(gesture.owns(7), false, 'nothing is owned once it is over');
    const loose = createExplorerDrag();
    loose.press({ path: '/a' }, { x: 0, y: 0 });
    assert.equal(loose.move({ x: 90, y: 0, pointerId: 3 }), 'start', 'no pointer id at the press: any pointer');
  });
});

// --- a press followed through the window --------------------------------------

/**
 * A window as far as `followExplorerPress` uses one: listeners by type and
 * phase, and events handed to them in the order they were added.
 */
function fakeWindow() {
  const listeners = [];
  return {
    addEventListener(type, fn, capture = false) {
      listeners.push({ type, fn, capture: Boolean(capture) });
    },
    removeEventListener(type, fn, capture = false) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === Boolean(capture));
      if (i !== -1) listeners.splice(i, 1);
    },
    dispatch(type, fields = {}) {
      const ev = {
        type,
        defaultPrevented: false,
        propagationStopped: false,
        ...fields,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
      };
      for (const l of listeners.filter((x) => x.type === type)) l.fn(ev);
      return ev;
    },
    get listening() {
      return listeners.length;
    },
  };
}

/** Rows 22px high, as the Explorer draws them: a.txt at y 0..22, b.txt below it. */
const ROW_A = { node: { path: 'C:\\proj\\a.txt', name: 'a.txt' }, isFolder: false };

/** A press on `row` at (x, y), followed, with every callback recorded. */
function pressRow(row = ROW_A, { x = 50, y = 11, pointerId = 1 } = {}) {
  const win = fakeWindow();
  const calls = [];
  const gesture = createExplorerDrag();
  const stop = followExplorerPress({ clientX: x, clientY: y, pointerId, button: 0 }, row, {
    win,
    gesture,
    onActivate: (r) => calls.push(['activate', r]),
    onDragStart: (p) => calls.push(['drag-start', p]),
    onDragMove: (p) => calls.push(['drag-move', p]),
    onDrop: (p) => calls.push(['drop', p]),
    onEnd: () => calls.push(['end']),
  });
  const pointer = (type, px, py, id = pointerId) => win.dispatch(type, { clientX: px, clientY: py, pointerId: id });
  const names = () => calls.map((c) => c[0]);
  return { win, calls, stop, pointer, names, gesture };
}

/** The click a mouse sends after its release: `detail` counts the clicks. */
const mouseClick = { button: 0, detail: 1 };

describe('A press on an Explorer row, followed to its own release', () => {
  test('TF-70: a press let go where it was opens the row pressed, once, and leaves no listener behind', () => {
    const p = pressRow();
    assert.equal(p.win.listening, 6, 'move, up, cancel, Escape, blur, context menu');
    p.pointer('pointerup', 50, 11);
    assert.deepEqual(p.names(), ['end', 'activate']);
    assert.equal(p.calls[1][1], ROW_A);
    assert.equal(p.win.listening, 0);
    p.pointer('pointerup', 50, 11);
    assert.deepEqual(p.names(), ['end', 'activate'], 'a second release is nobody\'s');
    assert.equal(clickActivates(mouseClick), false, "and the browser's click after it opens nothing more");
  });

  test('TF-71 (A4): pressed 2px above the bottom edge, let go 4px lower on the next row — the row PRESSED opens', () => {
    const p = pressRow(ROW_A, { y: 20 });
    p.pointer('pointermove', 50, 24);
    p.pointer('pointerup', 50, 24);
    assert.deepEqual(p.names(), ['end', 'activate']);
    assert.equal(p.calls[1][1], ROW_A, 'not b.txt, under the release; not nothing, as the DOM click gave');
  });

  test('TF-72 (A3): the rows shift between press and release (the New File box closed) — the row PRESSED opens', () => {
    // Nothing moved: the pointer is still where it was pressed, and the row
    // under it is now another. The release asks nothing of the page.
    const p = pressRow(ROW_A, { y: 33 });
    p.pointer('pointerup', 50, 33);
    assert.deepEqual(p.names(), ['end', 'activate']);
    assert.equal(p.calls[1][1], ROW_A);
  });

  test('TF-73 (A1): Escape mid-drag, the button let go long after — nothing opens, nothing drops', () => {
    const p = pressRow();
    p.pointer('pointermove', 90, 11);
    p.pointer('pointermove', 450, 100);
    assert.deepEqual(p.names(), ['drag-start', 'drag-move', 'drag-move']);
    const escape = p.win.dispatch('keydown', { key: 'Escape' });
    assert.ok(escape.defaultPrevented && escape.propagationStopped, 'a drag keeps its Escape');
    assert.equal(p.names().at(-1), 'end');
    assert.equal(p.win.listening, 0);
    assert.equal(p.gesture.phase, 'idle', 'the drag itself is over, not only its listeners');
    p.pointer('pointerup', 450, 100);
    assert.ok(!p.names().includes('activate') && !p.names().includes('drop'));
    assert.equal(clickActivates(mouseClick), false, 'the click the captured row then gets opens nothing either');
  });

  test('TF-74 (A1): a lost focus, a context menu or a cancelled pointer calls it off the same way', () => {
    for (const [type, fields] of [
      ['blur', {}],
      ['contextmenu', { pointerId: 1 }],
      ['contextmenu', {}],
      ['pointercancel', { pointerId: 1 }],
    ]) {
      for (const dragging of [true, false]) {
        const p = pressRow();
        if (dragging) p.pointer('pointermove', 450, 100);
        p.win.dispatch(type, fields);
        assert.equal(p.names().at(-1), 'end', `${type}${dragging ? ' mid-drag' : ' mid-press'}`);
        assert.equal(p.gesture.phase, 'idle', `${type}: the gesture is over`);
        p.pointer('pointerup', 50, 11);
        assert.ok(!p.names().includes('activate') && !p.names().includes('drop'), `${type}: the late release`);
      }
    }
    const other = pressRow();
    other.win.dispatch('pointercancel', { pointerId: 9 });
    assert.equal(other.win.listening, 6, "another pointer's cancel is not this press's");
    other.stop();
  });

  test('TF-75: Escape while still a press ends it, and goes on to whatever else it means', () => {
    const p = pressRow();
    const escape = p.win.dispatch('keydown', { key: 'Escape' });
    assert.ok(!escape.defaultPrevented && !escape.propagationStopped);
    p.pointer('pointerup', 50, 11);
    assert.deepEqual(p.names(), ['end']);
    const other = pressRow();
    other.win.dispatch('keydown', { key: 'Enter' });
    assert.equal(other.win.listening, 6, 'another key changes nothing');
    other.stop();
  });

  test('TF-76 (A2, A5): a press that is not the row\'s own is never followed, so its release opens nothing', () => {
    const press = { button: 0, isPrimary: true, ctrlKey: false };
    const inside = (selector) => ({ closest: (sel) => (sel.split(',').map((s) => s.trim()).includes(selector) ? {} : null) });
    assert.equal(pressArmsDrag(press, inside('input')), false, 'text dragged out of the rename input onto its row');
    assert.equal(pressArmsDrag(press, inside('[data-no-path-drag]')), false, "a press on a folder's twisty slid onto the row");
    // The browser still clicks the row both times; a mouse click opens nothing.
    assert.equal(clickActivates(mouseClick), false);
  });

  test('TF-77: dragged and let go — the path drops where it was let go, and the row does not open', () => {
    const p = pressRow();
    p.pointer('pointermove', 52, 11);
    assert.deepEqual(p.names(), [], 'within the threshold: still a press');
    p.pointer('pointermove', 450, 100);
    p.pointer('pointermove', 460, 120);
    p.pointer('pointerup', 470, 130);
    assert.deepEqual(p.names(), ['drag-start', 'drag-move', 'drag-move', 'end', 'drop']);
    assert.deepEqual(p.calls.at(-1)[1], { x: 470, y: 130 });
  });

  test("TF-78: another pointer's moves and release are not this press's", () => {
    const p = pressRow(ROW_A, { pointerId: 1 });
    p.pointer('pointermove', 450, 100, 2);
    p.pointer('pointerup', 450, 100, 2);
    assert.deepEqual(p.names(), []);
    p.pointer('pointerup', 50, 11, 1);
    assert.deepEqual(p.names(), ['end', 'activate']);
  });

  test('TF-79: stopped — a new press, or the Explorer going — ends it once, and its release is nothing', () => {
    const p = pressRow();
    p.pointer('pointermove', 450, 100);
    p.stop();
    p.stop();
    assert.equal(p.names().filter((n) => n === 'end').length, 1);
    assert.equal(p.win.listening, 0);
    p.pointer('pointerup', 450, 100);
    assert.ok(!p.names().includes('drop') && !p.names().includes('activate'));
  });

  test('TF-80: only a click no pointer made opens a row from the DOM — the keyboard, assistive technology', () => {
    assert.equal(clickActivates({ button: 0, detail: 0 }), true);
    assert.equal(clickActivates({ button: 0, detail: 1 }), false);
    assert.equal(clickActivates({ button: 0, detail: 2 }), false, 'the second click of a double click');
    assert.equal(clickActivates({ button: 1, detail: 0 }), false);
    assert.equal(clickActivates({ button: 0 }), false, 'no count given: not known to be pointerless');
    assert.equal(clickActivates(null), false);
  });

  test('TF-81: a double click is two presses: two activations, as before — a file already open is revealed, a folder toggles twice', () => {
    const opened = [];
    for (let i = 0; i < 2; i += 1) {
      const p = pressRow();
      p.pointer('pointerup', 50, 11);
      opened.push(...p.calls.filter((c) => c[0] === 'activate').map((c) => c[1]));
      assert.equal(clickActivates({ button: 0, detail: i + 1 }), false, `click ${i + 1} of the double click`);
    }
    assert.deepEqual(opened, [ROW_A, ROW_A], 'two presses, two activations: openFile reveals a file already open');
  });
});

describe('Bound to the live app', () => {
  /** The real store over the browser mock, on a platform chosen by the case. */
  async function withTerminals(fn) {
    const system = useSystemStore.getState();
    const before = new Set(T.getState().tabs.map((t) => t.id));
    useSystemStore.setState({ os: 'linux', defaultShell: null });
    try {
      await T.getState().init();
      const first = await T.getState().createTab();
      assert.ok(first, 'setup: a terminal');
      const firstPane = T.getState().getActivePaneId();
      const secondPane = await T.getState().splitPane(firstPane, 'horizontal');
      assert.ok(secondPane, 'setup: a second pane');
      await fn({ firstPane, secondPane });
    } finally {
      for (const tab of T.getState().tabs.filter((t) => !before.has(t.id))) await T.getState().closeTab(tab.id);
      useSystemStore.setState({ os: system.os, defaultShell: system.defaultShell });
      usePathDropStore.setState({ target: null });
    }
  }

  const shownTab = (paneId) => {
    const group = T.getState().getActiveGroup();
    const find = (node) =>
      node.type === 'leaf' ? (node.id === paneId ? node : null) : node.children.map(find).find(Boolean) ?? null;
    return find(group.tree)?.activeTabId ?? null;
  };

  test('TF-40: a drop on a pane plans against the real layout, with the tab\'s own shell and the setting', async () => {
    await withTerminals(async ({ secondPane }) => {
      const tabId = shownTab(secondPane);
      const plan = glue.planPathsIntoPane(secondPane, ['/workspace/a b.txt', '/workspace/c']);
      assert.equal(plan.ok, true, JSON.stringify(plan));
      assert.equal(plan.tabId, tabId);
      assert.equal(plan.text, "'/workspace/a b.txt' /workspace/c", "the mock's /bin/zsh, on linux");
      assert.equal(plan.count, 2);
    });
  });

  test('TF-41: inserting makes that pane the active one; with no xterm in Node, nothing is pasted, and it says so', async () => {
    await withTerminals(async ({ firstPane, secondPane }) => {
      T.getState().setActivePane(firstPane);
      assert.equal(T.getState().getActivePaneId(), firstPane, 'setup');
      const outcome = glue.insertPathsIntoPane(secondPane, ['/workspace/x']);
      assert.equal(T.getState().getActivePaneId(), secondPane, 'the pane dropped on is now the active one');
      assert.equal(T.getState().activeTabId, shownTab(secondPane), 'and its tab the active tab');
      assert.equal(outcome.inserted, false);
      assert.equal(outcome.reason, 'no-terminal');
      assert.equal(outcome.text, '/workspace/x');
    });
  });

  test('TF-42: a terminal being closed takes nothing — the store says so while its shell is killed', async () => {
    await withTerminals(async ({ secondPane }) => {
      const tabId = shownTab(secondPane);
      assert.equal(isTabClosing(tabId), false);
      const closing = T.getState().closeTab(tabId);
      assert.equal(isTabClosing(tabId), true, 'from the moment closeTab starts');
      assert.equal(glue.planPathsIntoPane(secondPane, ['/workspace/x']).reason, 'closing');
      await closing;
      assert.equal(isTabClosing(tabId), false, 'and not once it is gone');
      assert.equal(glue.planPathsIntoPane(secondPane, ['/workspace/x']).reason, 'no-pane', 'its pane went with it');
    });
  });

  test('TF-43: nor does a terminal whose shell has exited', async () => {
    await withTerminals(async ({ secondPane }) => {
      const tab = T.getState().tabs.find((t) => t.id === shownTab(secondPane));
      await mockBridge.emit('pty-exit', { session_id: tab.sessionId, exit_code: 0 });
      assert.ok(T.getState().tabs.find((t) => t.id === tab.id).exited, 'setup: the store saw the exit');
      const before = T.getState().getActivePaneId();
      const outcome = glue.insertPathsIntoPane(secondPane, ['/workspace/x']);
      assert.equal(outcome.reason, 'exited');
      assert.equal(T.getState().getActivePaneId(), before, 'and focus did not move to it');
    });
  });

  test('TF-44: a Default Shell setting speaks for a tab that has no shell recorded', async () => {
    await withTerminals(async ({ secondPane }) => {
      const tabId = shownTab(secondPane);
      const setting = useSettingsStore.getState().terminalDefaultShell;
      T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, shell: null } : t)) }));
      useSettingsStore.setState({ terminalDefaultShell: 'pwsh' });
      try {
        assert.equal(glue.planPathsIntoPane(secondPane, ['/a b']).text, "'/a b'");
        assert.equal(glue.planPathsIntoPane(secondPane, ['-x']).text, "'-x'");
        assert.equal(glue.planPathsIntoPane(secondPane, ["/it's$x"]).text, "'/it''s$x'", "PowerShell's quoting");
        assert.equal(glue.planPathsIntoPane(secondPane, ["/it's"]).text, '"/it\'s"', 'its double quotes, for a name with an apostrophe');
      } finally {
        useSettingsStore.setState({ terminalDefaultShell: setting });
      }
    });
  });

  test('TF-45: the tab that takes the paste is made its pane\'s active tab — through the store\'s own actions', async () => {
    // A store whose pane, once active, shows another tab than the plan's.
    const calls = [];
    let activeTabId = 't-old';
    let paneShows = 't-shown';
    const fake = {
      getState: () => ({
        activeTabId,
        setActivePane: (paneId) => {
          calls.push(['setActivePane', paneId]);
          activeTabId = paneShows;
        },
        switchTab: (tabId) => {
          calls.push(['switchTab', tabId]);
          activeTabId = tabId;
          paneShows = tabId;
        },
      }),
    };
    showTabInPane(fake, 'p1', 't-paste');
    assert.deepEqual(calls, [['setActivePane', 'p1'], ['switchTab', 't-paste']]);
    calls.length = 0;
    showTabInPane(fake, 'p1', 't-paste');
    assert.deepEqual(calls, [['setActivePane', 'p1']], 'already shown: no switch');

    await withTerminals(async ({ secondPane }) => {
      const first = shownTab(secondPane);
      const second = await T.getState().createTab(null, { paneId: secondPane });
      assert.ok(second, 'setup: a second tab in that pane');
      T.getState().switchTab(first);
      assert.equal(shownTab(secondPane), first, 'setup: the pane shows its first tab');
      showTabInPane(T, secondPane, second.id);
      assert.equal(T.getState().getActivePaneId(), secondPane);
      assert.equal(shownTab(secondPane), second.id, 'the pane now shows the tab the paste goes to');
      assert.equal(T.getState().activeTabId, second.id);
    });
  });
});

describe('The Explorer row, as it is wired', () => {
  const rowOf = (isFolder) => ({
    node: { path: isFolder ? '/w/src' : '/w/a.txt', name: isFolder ? 'src' : 'a.txt' },
    depth: 0,
    isFolder,
    isExpanded: false,
  });

  function renderRow(isFolder, { renaming = false } = {}) {
    const calls = [];
    const row = rowOf(isFolder);
    const element = TreeRow({
      row,
      gitStatus: null,
      isSelected: false,
      isFocused: false,
      isCut: false,
      onSelect: (r) => calls.push(['select', r.node.path]),
      onActivate: (r) => calls.push(['activate', r.node.path]),
      onToggle: (r) => calls.push(['toggle', r.node.path]),
      onContextMenu: () => calls.push(['menu']),
      onPathDragPress: (e, r, options) => calls.push(['press', r.node.path, options]),
      renaming,
      onRenameCommit: () => {},
      onRenameCancel: () => {},
    });
    const children = [element.props.children].flat(Infinity).filter(Boolean);
    const twisty = children.find((child) => child?.props?.style?.width === 16);
    return { calls, element, twisty };
  }

  const event = (extra = {}) => {
    const e = { button: 0, stopped: false, prevented: false, ...extra };
    e.stopPropagation = () => {
      e.stopped = true;
    };
    e.preventDefault = () => {
      e.prevented = true;
    };
    return e;
  };

  test('TF-50: the press selects and may start a drag; a mouse click opens nothing — only a click with no pointer behind it', () => {
    const { calls, element } = renderRow(false);
    element.props.onPointerDown(event());
    element.props.onMouseDown(event());
    assert.deepEqual(calls, [
      ['press', '/w/a.txt', { renaming: false }],
      ['select', '/w/a.txt'],
    ]);
    element.props.onClick(event({ detail: 1 }));
    assert.deepEqual(calls.at(-1), ['select', '/w/a.txt'], "the mouse's click: its press's own release opens the row");
    element.props.onClick(event({ detail: 0 }));
    assert.deepEqual(calls.at(-1), ['activate', '/w/a.txt'], 'a click from the keyboard or assistive technology');
    calls.length = 0;
    element.props.onMouseDown(event({ button: 2 }));
    element.props.onClick(event({ button: 1, detail: 0 }));
    assert.deepEqual(calls, [], 'other buttons neither select nor open');
  });

  test("TF-51: a folder's twisty toggles on its press and is no gesture of the row's", () => {
    const { calls, twisty, element } = renderRow(true);
    assert.ok(twisty, 'setup: the twisty');
    assert.equal(twisty.props['data-no-path-drag'], '', 'marked as a control of its own: its press is never followed');
    const down = event();
    twisty.props.onMouseDown(down);
    assert.ok(down.stopped && down.prevented);
    assert.deepEqual(calls, [['toggle', '/w/src']]);
    assert.equal(twisty.props.onClick, undefined, 'its click goes on to the row…');
    element.props.onClick(event({ detail: 1 }));
    assert.deepEqual(calls, [['toggle', '/w/src']], '…where a mouse click toggles nothing back');
  });

  test("TF-52: a file's twisty is only padding: its press is the row's", () => {
    const { calls, twisty } = renderRow(false);
    assert.equal(twisty.props['data-no-path-drag'], undefined);
    assert.equal(twisty.props.onClick, undefined);
    const down = event();
    twisty.props.onMouseDown(down);
    assert.equal(down.stopped, false);
    assert.deepEqual(calls, []);
  });

  test('TF-53: a row being renamed tells the drag so', () => {
    const { calls, element } = renderRow(false, { renaming: true });
    element.props.onPointerDown(event());
    assert.deepEqual(calls, [['press', '/w/a.txt', { renaming: true }]]);
  });

  test('TF-54: the Explorer opens a row from its press\'s release, and the app listens for OS drops once', () => {
    const explorer = source('src/components/explorer/FileExplorer.jsx');
    assert.match(explorer, /onSelect=\{selectRow\}/);
    assert.match(explorer, /onActivate=\{activateRow\}/, 'a click with no pointer behind it');
    assert.match(explorer, /onPathDragPress=\{onRowPointerDown\}/);
    assert.match(explorer, /useExplorerPathDrag\(\{ onActivate: activatePressedRow \}\)/, "the press's own release");
    // A row the tree no longer lists (deleted by the watcher between press and
    // release) is not opened: that only reported a file that cannot be read.
    assert.match(explorer, /if \(rows\.some\(\(r\) => samePath\(r\.node\.path, row\.node\.path\)\)\) activateRow\(row\);/, 'only a row still listed');
    assert.doesNotMatch(explorer, /takeClick/, 'no timed guard on the click is left');
    const hook = source('src/hooks/useExplorerPathDrag.js');
    assert.match(hook, /followExplorerPress\(e, row, \{/);
    assert.match(hook, /onActivate: \(pressed\) => activateRef\.current\?\.\(pressed\)/);
    const app = source('src/App.jsx');
    assert.equal(app.match(/useTerminalFileDrop\(\);/g)?.length, 1, 'App mounts it, once');
    const panes = source('src/components/terminal/TerminalSplitContainer.jsx');
    assert.equal(panes.match(/useTerminalFileDrop\(/g), null, 'not the terminal view, which remounts');
    assert.match(panes, /<DropIndicator zone=\{dropZone\} \/>\s*<PathDropHighlight paneId=\{paneId\} \/>\s*<\/div>/, 'the highlight is drawn in the pane body');
  });
});

describe("The registry's paste", () => {
  /** `pasteIntoTerminal`, cut from terminalRegistry.js and run against `instances`. */
  function pasteWith(instances) {
    const registry = source('src/components/terminal/terminalRegistry.js');
    const start = registry.indexOf('export function pasteIntoTerminal(');
    assert.ok(start > 0, 'the registry has pasteIntoTerminal');
    const end = registry.indexOf('\n}\n', start) + 3;
    const fn = new Function('instances', `${registry.slice(start + 'export '.length, end)}\nreturn pasteIntoTerminal;`);
    return fn(instances);
  }

  const terminal = () => {
    const seen = [];
    return { seen, term: { paste: (text) => seen.push(['paste', text]), focus: () => seen.push(['focus']) } };
  };

  test('TF-60: through xterm\'s own paste, then the keyboard goes to the terminal', () => {
    const live = terminal();
    const paste = pasteWith(new Map([['t1', { term: live.term, disposed: false }]]));
    assert.equal(paste('t1', "'/a b' /c"), true);
    assert.deepEqual(live.seen, [['paste', "'/a b' /c"], ['focus']]);
  });

  test('TF-61: no live terminal, a disposed one, or nothing to paste: nothing sent, false', () => {
    const live = terminal();
    const gone = terminal();
    const paste = pasteWith(
      new Map([
        ['t1', { term: live.term, disposed: false }],
        ['t2', { term: gone.term, disposed: true }],
      ])
    );
    assert.equal(paste('nope', '/a'), false);
    assert.equal(paste('t2', '/a'), false);
    assert.equal(paste('t1', ''), false, 'an empty bracketed paste is what attaches the clipboard image in OpenCode');
    assert.equal(paste('t1', null), false);
    assert.deepEqual(live.seen, []);
    assert.deepEqual(gone.seen, []);
  });
});
