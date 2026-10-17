/**
 * The branch each terminal's folder is on (stage 2, S5): a store keyed by
 * folder (src/stores/branchStore.js), and what drives it
 * (src/hooks/useBranchLookups.js, mounted once in App.jsx).
 *
 * A lookup is `git_branch` — a file read in the backend (src-tauri/src/fs/
 * git.rs, with its own cases) — and happens only when a tab's folder
 * changes, when a command ends in a tab (every folder of its repository),
 * when the workspace's git status refreshes, when a program in a tab
 * notifies or rings, and when a tab becomes the active one (those two at
 * most every 5 s per folder). Never on a timer. Per folder: 300 ms of quiet
 * first, one lookup at a time, and a request while it runs means one more
 * after it; two lookups at most in all, each given 3 s; a folder no tab uses
 * is forgotten; nothing at all while the Show Git Branch setting is off.
 *
 * Most cases drive the scheduler and the triggers with a clock moved by hand
 * and answers given by hand; the wired ones go through the real stores and
 * the browser mock's `git_branch`.
 */
import { readFileSync } from 'node:fs';
import { createStore } from 'zustand/vanilla';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import * as branchLib from '../../src/stores/branchStore.js';
import * as hookLib from '../../src/hooks/useBranchLookups.js';
import * as terminalStoreLib from '../../src/stores/terminalStore.js';
import { useTerminalStore as T } from '../../src/stores/terminalStore.js';
import { useSettingsStore, SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import { useGitStore } from '../../src/stores/gitStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const { useBranchStore: B } = branchLib;

// What the mock held before any case here ran — read, never replaced, at
// load: the teardown checks the cases left it so.
const GIT_BRANCHES_AT_LOAD = JSON.parse(JSON.stringify(mockBridge.gitBranches ?? {}));
const OS_AT_LOAD = mockBridge.systemInfo.os;

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let promise callbacks run. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** A clock and timers the case moves by hand. */
function manualTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    /** Move the clock to `t`, running each timer due by then, in order. */
    advance(t) {
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = t;
    },
    get pending() {
      return timers.size;
    },
  };
}

/** A lookup answered by hand: `calls` in order, each with `answer(value)` / `fail(err)`. */
function manualLookup() {
  const calls = [];
  let running = 0;
  let most = 0;
  const lookup = (dir) => {
    running += 1;
    most = Math.max(most, running);
    let answer;
    let fail;
    const promise = new Promise((resolve, reject) => {
      answer = (v) => {
        running -= 1;
        resolve(v);
      };
      fail = (e) => {
        running -= 1;
        reject(e);
      };
    });
    calls.push({ dir, answer, fail });
    return promise;
  };
  return {
    lookup,
    calls,
    dirs: () => calls.map((c) => c.dir),
    get running() {
      return running;
    },
    get most() {
      return most;
    },
  };
}

const info = (branch, detached = false) => ({ branch, detached });
const branches = () => B.getState().branches;

/** Stores shaped like the app's, for the triggers. */
function fakeStores({ tabs = [], os = 'macos', branch = true } = {}) {
  return {
    terminals: createStore(() => ({ tabs })),
    settings: createStore(() => ({ terminalsPanelBranch: branch })),
    git: createStore(() => ({ refreshes: 0 })),
    system: createStore(() => ({ os })),
  };
}

/** A command-end source the case fires by hand. */
function manualCommandEnds() {
  const listeners = new Set();
  return {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire: (tabIds) => {
      for (const fn of listeners) fn(tabIds);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

const tab = (id, cwd, over = {}) => ({ id, title: id, cwd, shell: null, running: false, ...over });

/** The scheduler on its own, with a clock and answers by hand. */
function scheduler(over = {}) {
  const time = manualTime();
  const lk = manualLookup();
  const s = branchLib.createBranchLookups({
    lookup: lk.lookup,
    store: B,
    debounceMs: 300,
    maxConcurrent: 2,
    timeoutMs: 3000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    ...over,
  });
  return { time, lk, s };
}

/** The triggers and the scheduler together, over fake stores. */
function driven({ tabs, os, branch } = {}) {
  const time = manualTime();
  const lk = manualLookup();
  const stores = fakeStores({ tabs, os, branch });
  const ends = manualCommandEnds();
  const signals = manualCommandEnds();
  const stop = hookLib.startBranchLookups({
    ...stores,
    commandEnded: ends.subscribe,
    programSignal: signals.subscribe,
    now: time.now,
    store: B,
    lookup: lk.lookup,
    debounceMs: 300,
    maxConcurrent: 2,
    timeoutMs: 3000,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { time, lk, stores, ends, signals, stop };
}

describe('Branch store: the scheduler (S5)', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test('BS-01: 300 ms of quiet per folder, then one lookup; the answer lands under the folder', async () => {
    assert.equal(branchLib.BRANCH_DEBOUNCE_MS, 300);
    assert.equal(branchLib.BRANCH_MAX_CONCURRENT, 2);
    const { time, lk, s } = scheduler();
    try {
      for (let t = 0; t <= 200; t += 50) {
        time.advance(t);
        s.request('/repo');
      }
      time.advance(499);
      assert.deepEqual(lk.dirs(), [], 'a burst is still settling 299 ms after its last request');
      time.advance(500);
      assert.deepEqual(lk.dirs(), ['/repo'], 'one lookup for the burst, 300 ms after its last request');
      lk.calls[0].answer(info('main'));
      await settle();
      assert.deepEqual(branches()['/repo'], info('main'));
    } finally {
      s.stop();
    }
  });

  test('BS-02: one lookup in flight per folder; a request meanwhile is answered too — what it found is shown, then the folder is looked up once more', async () => {
    const { time, lk, s } = scheduler();
    try {
      s.request('/repo');
      time.advance(300);
      assert.equal(lk.calls.length, 1);
      s.request('/repo');
      time.advance(600);
      assert.equal(lk.calls.length, 1, 'not a second lookup of the same folder while one runs');
      lk.calls[0].answer(info('old'));
      await settle();
      assert.deepEqual(branches()['/repo'], info('old'), 'what it found is shown');
      assert.equal(lk.calls.length, 2, 'and the folder is looked at once more');
      lk.calls[1].answer(info('new'));
      await settle();
      assert.deepEqual(branches()['/repo'], info('new'));
      time.advance(10_000);
      assert.equal(lk.calls.length, 2, 'once more, not on and on');
    } finally {
      s.stop();
    }
  });

  test('BS-03: a folder asked about again and again is still answered — every lookup that ends is shown', async () => {
    // Found in review: an answer was dropped whenever a request had come in
    // while it ran, so lookups that take a little longer than the requests
    // are apart never showed anything.
    const { time, lk, s } = scheduler({ debounceMs: 10 });
    const shown = [];
    const unsub = B.subscribe((state) => shown.push(state.branches['/busy']?.branch));
    try {
      for (let round = 0; round < 15; round += 1) {
        s.request('/busy');
        time.advance(time.now() + 100);
        const call = lk.calls.at(-1);
        s.request('/busy');
        time.advance(time.now() + 20);
        call.answer(info(`b${round}`));
        await settle();
      }
      assert.deepEqual(branches()['/busy'], info('b14'));
      assert.equal(new Set(shown.filter(Boolean)).size, 15, `every answer shown: ${shown}`);
    } finally {
      unsub();
      s.stop();
    }
  });

  test('BS-04: two lookups at most in all; the rest wait their turn', async () => {
    const { time, lk, s } = scheduler();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const folders = ['/a', '/b', '/c', '/d', '/e'];
      for (const f of folders) s.request(f);
      time.advance(300);
      assert.deepEqual(lk.dirs(), ['/a', '/b'], 'two at once');
      lk.calls[0].answer(info('a'));
      await settle();
      assert.deepEqual(lk.dirs(), ['/a', '/b', '/c'], 'the next as one ends');
      lk.calls[1].fail(new Error('refused'));
      lk.calls[2].answer(null);
      await settle();
      assert.deepEqual(lk.dirs(), folders);
      lk.calls[3].answer(info('d'));
      lk.calls[4].answer(info('e'));
      await settle();
      assert.equal(lk.most, 2, 'never more than two running');
      assert.deepEqual(branches(), { '/a': info('a'), '/b': null, '/c': null, '/d': info('d'), '/e': info('e') });
    } finally {
      console.warn = warn;
      s.stop();
    }
  });

  test('BS-05: a forgotten folder — its wait cancelled, its answer dropped, its entry gone', async () => {
    const { time, lk, s } = scheduler();
    try {
      s.request('/kept');
      s.request('/gone');
      time.advance(300);
      lk.calls[0].answer(info('main'));
      lk.calls[1].answer(info('main'));
      await settle();
      assert.deepEqual(Object.keys(branches()).sort(), ['/gone', '/kept']);
      s.forget('/gone');
      assert.deepEqual(Object.keys(branches()), ['/kept'], 'forgotten at once');

      s.request('/gone');
      s.forget('/gone');
      time.advance(1000);
      assert.equal(lk.calls.length, 2, 'a wait for a forgotten folder never runs');

      s.request('/late');
      time.advance(1300);
      s.forget('/late');
      lk.calls[2].answer(info('main'));
      await settle();
      assert.equal('/late' in branches(), false, 'an answer for a forgotten folder is dropped');
    } finally {
      s.stop();
    }
  });

  test('BS-06: an answer is checked again — a name git would refuse, or that does not show as it is, is no branch', async () => {
    const { time, lk, s } = scheduler();
    try {
      const cases = [
        [info('evil\u{202e}gnp'), null],
        [info('a..b'), null],
        [info('x.lock'), null],
        [info('zero\u{200b}width'), null],
        [{ branch: 'main', detached: false, repo: '/r/.git' }, info('main')],
        [info('abc1234', true), info('abc1234', true)],
        [{ branch: 'x', detached: 'yes' }, info('x')],
        [info(''), null],
        [info('\u{0007}'), null],
        ['main', null],
        [42, null],
        [{ detached: true }, null],
        [undefined, null],
      ];
      for (const [i, [given]] of cases.entries()) {
        s.request(`/f${i}`);
        time.advance(300 * (i + 1));
        lk.calls.at(-1).answer(given);
        await settle();
      }
      for (const [i, [, want]] of cases.entries()) {
        assert.deepEqual(branches()[`/f${i}`], want, JSON.stringify(cases[i][0]));
      }
      assert.deepEqual(branchLib.normalizeBranchAnswer(info('main')), info('main'));
    } finally {
      s.stop();
    }
  });

  test('BS-07: an answer that changes nothing changes nothing — the same object, no store update', async () => {
    const { time, lk, s } = scheduler();
    try {
      s.request('/repo');
      time.advance(300);
      lk.calls[0].answer(info('main'));
      await settle();
      const before = B.getState().branches;
      let updates = 0;
      const unsub = B.subscribe(() => {
        updates += 1;
      });
      s.request('/repo');
      time.advance(600);
      lk.calls[1].answer(info('main'));
      await settle();
      unsub();
      assert.equal(updates, 0);
      assert.equal(B.getState().branches, before);
    } finally {
      s.stop();
    }
  });

  test('BS-08: a lookup that fails is no branch, said once, and the next request tries again', async () => {
    const { time, lk, s } = scheduler();
    const warned = [];
    const warn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      s.request('/repo');
      time.advance(300);
      lk.calls[0].fail(new Error('backend away'));
      await settle();
      assert.equal(branches()['/repo'], null);
      s.request('/repo');
      time.advance(600);
      assert.equal(lk.calls.length, 2, 'not stuck');
      lk.calls[1].fail(new Error('backend away'));
      await settle();
      assert.equal(warned.filter((w) => /branch/i.test(w)).length, 1, 'said once');
      // A lookup that throws as it is called is the same.
      const thrower = branchLib.createBranchLookups({
        lookup: () => {
          throw new Error('no bridge');
        },
        store: B,
        debounceMs: 300,
        maxConcurrent: 2,
        setTimer: time.setTimer,
        clearTimer: time.clearTimer,
      });
      thrower.request('/thrown');
      time.advance(900);
      await settle();
      assert.equal(branches()['/thrown'], null);
      thrower.stop();
    } finally {
      console.warn = warn;
      s.stop();
    }
  });

  test('BS-09: stopped, it does nothing more — no wait runs, no late answer lands', async () => {
    const { time, lk, s } = scheduler();
    s.request('/a');
    time.advance(300);
    s.request('/b');
    s.stop();
    assert.equal(time.pending, 0, 'nothing left waiting');
    time.advance(5000);
    assert.equal(lk.calls.length, 1);
    lk.calls[0].answer(info('main'));
    await settle();
    assert.equal('/a' in branches(), false);
    s.request('/c');
    time.advance(9000);
    assert.equal(lk.calls.length, 1, 'a request after stop is ignored');
  });
});

describe('Branch store: lookups that never answer (S5)', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test('BS-22: a lookup is given 3 s — then its slot is free, the folder keeps what it showed, and an answer that comes late is still shown', async () => {
    assert.equal(branchLib.BRANCH_TIMEOUT_MS, 3000);
    const { time, lk, s } = scheduler();
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      s.request('/known');
      time.advance(300);
      lk.calls[0].answer(info('main'));
      await settle();
      s.request('/known');
      s.request('/hung');
      s.request('/fine');
      time.advance(600);
      assert.deepEqual(lk.dirs(), ['/known', '/known', '/hung'], 'two at once');
      time.advance(3599);
      assert.equal(lk.calls.length, 3, 'both still running just before 3 s');
      time.advance(3600);
      assert.deepEqual(lk.dirs().at(-1), '/fine', 'their slots given back');
      assert.deepEqual(branches()['/known'], info('main'), 'a lookup that timed out does not wipe what the folder showed');
      assert.equal(branches()['/hung'], undefined, 'nor invent anything for one that showed nothing');
      lk.calls[3].answer(info('main'));
      await settle();
      assert.deepEqual(branches()['/fine'], info('main'));
      lk.calls[1].answer(info('dev'));
      lk.calls[2].answer(info('topic'));
      await settle();
      assert.deepEqual(branches()['/known'], info('dev'), 'an answer late but valid, for a folder still in use, is shown');
      assert.deepEqual(branches()['/hung'], info('topic'));
      assert.equal(warned.filter((w) => /branch/i.test(w)).length, 1, 'said once');
    } finally {
      console.warn = warn;
      s.stop();
    }
  });

  test('BS-23: a lookup given up on — its folder forgotten, everything cleared — gives its slot back at once', async () => {
    const { time, lk, s } = scheduler();
    try {
      s.request('/h1');
      s.request('/h2');
      s.request('/next');
      time.advance(300);
      assert.deepEqual(lk.dirs(), ['/h1', '/h2']);
      s.forget('/h1');
      assert.deepEqual(lk.dirs(), ['/h1', '/h2', '/next'], 'the forgotten folder’s slot, at once');
      s.clear();
      s.request('/a');
      s.request('/b');
      time.advance(600);
      assert.deepEqual(lk.dirs().slice(3), ['/a', '/b'], 'cleared: both slots free');
      for (const c of lk.calls.slice(0, 3)) c.answer(info('late'));
      lk.calls[3].answer(info('a'));
      lk.calls[4].answer(info('b'));
      await settle();
      assert.deepEqual(branches(), { '/a': info('a'), '/b': info('b') }, 'no answer given up on lands');
      assert.equal(s.running, 0);
    } finally {
      s.stop();
    }
  });

  test('BS-24: which repository each folder is in, from its answer — kept beside the store, never in it', async () => {
    const { time, lk, s } = scheduler();
    try {
      s.request('/r/a');
      s.request('/r/b');
      time.advance(300);
      lk.calls[0].answer({ branch: 'main', detached: false, repo: '/r/.git' });
      lk.calls[1].answer({ branch: 'main', detached: false, repo: '/r/.git' });
      await settle();
      assert.equal(s.repoOf('/r/a'), '/r/.git');
      assert.equal(s.repoOf('/r/b'), '/r/.git');
      assert.deepEqual(branches()['/r/a'], info('main'), 'the store holds what is shown, no more');
      s.request('/r/a');
      time.advance(600);
      lk.calls[2].answer(null);
      await settle();
      assert.equal(s.repoOf('/r/a'), null, 'no branch, no repository');
      s.forget('/r/b');
      assert.equal(s.repoOf('/r/b'), null, 'forgotten with its folder');
      assert.equal(s.repoOf('/never'), null);
      s.request('/r/c');
      time.advance(900);
      lk.calls[3].answer({ branch: 'main', detached: false, repo: 42 });
      await settle();
      assert.equal(s.repoOf('/r/c'), null, 'a repository that is not a name is none');
    } finally {
      s.stop();
    }
  });
});

describe('Branch store: a backend that is slow to give up (S5, revised)', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test('BS-31: a folder whose backend call never returns holds that one call — it is asked again only once the call has settled', async () => {
    // Found in review (sched.mjs C): each timeout freed the slot and the next
    // trigger asked the same folder again — seven calls held in the backend
    // after twenty refreshes, each a blocked thread.
    const { time, lk, s } = scheduler();
    const warn = console.warn;
    console.warn = () => {};
    try {
      s.request('/stuck');
      time.advance(300);
      time.advance(3300);
      assert.equal(branches()['/stuck'], undefined, 'timed out with nothing known: nothing shown, nothing made up');
      for (let i = 1; i <= 20; i += 1) {
        s.request('/stuck');
        time.advance(3300 + i * 1000);
      }
      const stuck = () => lk.calls.filter((c) => c.dir === '/stuck');
      assert.equal(stuck().length, 1, 'one backend call held, however often the folder is asked about');
      s.request('/other');
      time.advance(30_000);
      assert.deepEqual(lk.dirs().filter((d) => d === '/other'), ['/other'], 'every other folder goes on');

      // Forgotten and asked for again while its call still hangs: still that
      // one call.
      s.forget('/stuck');
      s.request('/stuck');
      time.advance(31_000);
      assert.equal(stuck().length, 1, 'forgetting the folder does not end the call it left in the backend');

      // The call settles at last: its answer is dropped — it was given up on
      // — and the folder, asked about meanwhile, is looked up afresh.
      stuck()[0].answer(info('late'));
      await settle();
      assert.equal(branches()['/stuck'], undefined, 'the late answer never shows');
      assert.equal(stuck().length, 2, 'asked meanwhile: looked up now');
      stuck()[1].answer(info('main'));
      await settle();
      assert.deepEqual(branches()['/stuck'], info('main'));
    } finally {
      console.warn = warn;
      s.stop();
    }
  });

  test('BS-32: asked about every 100 ms, a folder is still looked up — the 300 ms of quiet waits 1 s at most', async () => {
    // Found in review (sched.mjs A): the quiet started over with every
    // request, so a steady stream of them meant no lookup at all.
    assert.equal(branchLib.BRANCH_MAX_WAIT_MS, 1000);
    const { time, lk, s } = scheduler();
    try {
      const at = [];
      for (let t = 0; t <= 3000; t += 100) {
        const before = lk.calls.length;
        time.advance(t);
        if (lk.calls.length > before) at.push(t);
        s.request('/r');
        for (const c of lk.calls) c.answer(info('main'));
        await settle();
      }
      assert.deepEqual(at, [1000, 2000, 3000], 'once a second, from the first request of each run');
      assert.deepEqual(branches()['/r'], info('main'));
    } finally {
      s.stop();
    }
  });
});

describe('Branch store: folders that time out wait behind the rest (S5, revised)', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test('BS-34: a folder whose lookup timed out is suspect — asked after every other, one at a time, and not on a refresh for 30 s', async () => {
    assert.equal(branchLib.BRANCH_SUSPECT_MS, 30_000);
    const { time, lk, s } = scheduler();
    const warn = console.warn;
    console.warn = () => {};
    try {
      s.request('/dead/a');
      s.request('/dead/b');
      time.advance(300);
      time.advance(3300);
      for (const c of lk.calls) c.answer(null);
      await settle();
      assert.equal(s.isSuspect('/dead/a'), true);
      assert.equal(s.isSuspect('/local'), false);
      // Asked again with healthy folders: those first; the suspects one at a time.
      const base = lk.calls.length;
      s.request('/dead/a');
      s.request('/dead/b');
      s.request('/l1');
      s.request('/l2');
      time.advance(3600);
      assert.deepEqual(lk.dirs().slice(base), ['/l1', '/l2'], 'the healthy ones first');
      for (const c of lk.calls.slice(base)) c.answer(info('main'));
      await settle();
      assert.deepEqual(lk.dirs().slice(base + 2), ['/dead/a'], 'then one suspect, not two');
      time.advance(6600);
      assert.deepEqual(lk.dirs().slice(base + 2), ['/dead/a', '/dead/b'], 'the next once that one is done');
      for (const c of lk.calls.slice(base + 2)) c.answer(null);
      await settle();

      // A refresh leaves a suspect alone for 30 s from its timeout; asked for
      // because its folder changed, it is asked all the same.
      const before = lk.calls.length;
      s.refresh('/dead/a');
      s.refresh('/l1');
      time.advance(10_000);
      assert.deepEqual(lk.dirs().slice(before), ['/l1'], 'refreshed: only the healthy one');
      lk.calls.at(-1).answer(info('main'));
      await settle();
      s.request('/dead/a');
      time.advance(10_300);
      assert.deepEqual(lk.dirs().slice(before + 1), ['/dead/a'], 'its folder changed: asked');
      lk.calls.at(-1).answer(info('fixed'));
      await settle();
      assert.equal(s.isSuspect('/dead/a'), false, 'answered in time: no longer suspect');
      time.advance(40_000);
      s.refresh('/dead/b');
      time.advance(40_300);
      assert.equal(lk.dirs().at(-1), '/dead/b', '30 s on, a refresh asks again');
    } finally {
      console.warn = warn;
      s.stop();
    }
  });

  test('BS-35: eight terminals on a dead share and one at home — the one at home is answered within one timeout, not after all of them', async () => {
    // Found in review (branch-sim.mjs S2): 12.3 s for the local folder.
    const time = manualTime();
    const asked = [];
    const answers = new Map();
    const s = branchLib.createBranchLookups({
      lookup: (dir) => {
        asked.push([time.now(), dir]);
        if (dir.startsWith('/dead')) return new Promise(() => {});
        return new Promise((resolve) => answers.set(dir, resolve));
      },
      store: B,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 8; i += 1) s.request(`/dead/sub${i}`);
      s.request('/local');
      time.advance(300);
      time.advance(3300);
      const local = asked.find(([, dir]) => dir === '/local');
      assert.ok(local, `not asked once the first two timed out: ${asked.map(([, d]) => d)}`);
      assert.equal(local[0], 3300, 'asked as soon as a slot came free');
      answers.get('/local')(info('main'));
      await settle();
      assert.deepEqual(branches()['/local'], info('main'));
      // The rest of the share from then on: one at a time, a timeout apart.
      time.advance(40_000);
      const dead = asked.filter(([, dir]) => dir.startsWith('/dead')).map(([at]) => at);
      assert.equal(dead.length, 8, 'each dead folder asked once — their calls never return');
      for (let i = 3; i < dead.length; i += 1) {
        assert.ok(dead[i] - dead[i - 1] >= 3000, `two suspects at once: ${dead}`);
      }
    } finally {
      console.warn = warn;
      s.stop();
    }
  });
});

describe('Branch store: a suspect is left alone by refreshes for 30 s (S5)', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test('BS-36: refreshed within 30 s of its timeout, a suspect is not asked; asked for, or 30 s on, it is', async () => {
    const { time, lk, s } = scheduler();
    const warn = console.warn;
    console.warn = () => {};
    try {
      s.request('/slow');
      time.advance(300);
      time.advance(3300);
      assert.equal(s.isSuspect('/slow'), true);
      lk.calls[0].answer(info('main'));
      await settle();
      assert.deepEqual(branches()['/slow'], info('main'), 'late, and shown');
      assert.equal(s.isSuspect('/slow'), true, 'but it did time out');
      // It timed out at 3300.
      s.refresh('/slow');
      time.advance(33_299);
      s.refresh('/slow');
      time.advance(33_299);
      assert.equal(lk.calls.length, 1, 'a refresh within 30 s of the timeout asks nothing');
      time.advance(33_300);
      s.refresh('/slow');
      time.advance(33_600);
      assert.equal(lk.calls.length, 2, '30 s on, a refresh asks');
      lk.calls[1].answer(info('main'));
      await settle();
      assert.equal(s.isSuspect('/slow'), false, 'answered in time');
    } finally {
      console.warn = warn;
      s.stop();
    }
  });

  test('BS-37: the triggers that only refresh leave a folder that timed out alone; its folder changing does not', async () => {
    const time = manualTime();
    const asked = [];
    const answers = [];
    const stores = fakeStores({ tabs: [tab('a', '/slow'), tab('b', '/fine')] });
    const ends = manualCommandEnds();
    const signals = manualCommandEnds();
    const stop = hookLib.startBranchLookups({
      ...stores,
      commandEnded: ends.subscribe,
      programSignal: signals.subscribe,
      now: time.now,
      store: B,
      lookup: (dir) => {
        asked.push(dir);
        return new Promise((resolve) => answers.push({ dir, resolve }));
      },
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      time.advance(300);
      answers.find((x) => x.dir === '/fine').resolve(info('main'));
      await settle();
      time.advance(3300);
      answers.find((x) => x.dir === '/slow').resolve(info('main'));
      await settle();
      const base = asked.length;
      stores.git.setState({ refreshes: 1 });
      ends.fire(['a']);
      signals.fire('a');
      stores.terminals.setState({ activeTabId: 'a' });
      time.advance(10_000);
      assert.deepEqual(asked.slice(base), ['/fine'], 'only the folder that answers in time');
      answers.at(-1).resolve(info('main'));
      await settle();
      // Its tab coming to the front, past the 5 s between nudges but within
      // 30 s of the timeout: still left alone.
      stores.terminals.setState({ activeTabId: 'b' });
      stores.terminals.setState({ activeTabId: 'a' });
      time.advance(10_300);
      assert.deepEqual(asked.slice(base), ['/fine'], 'brought to the front: still left alone');
      stores.terminals.setState({ tabs: [tab('a', '/elsewhere'), tab('b', '/fine')] });
      time.advance(10_600);
      stores.terminals.setState({ tabs: [tab('a', '/slow'), tab('b', '/fine')] });
      time.advance(10_900);
      assert.deepEqual(asked.slice(base + 1), ['/elsewhere', '/slow'], 'its tab went there: asked');
    } finally {
      console.warn = warn;
      stop();
    }
  });
});

describe('Branch store: what reads it', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test('BS-10: the folder a tab is looked up by is where a new shell could start — network refused, Git Bash read as its drive', () => {
    const { folderForBranch } = branchLib;
    assert.equal(folderForBranch(tab('a', '/Users/me/repo'), 'macos'), '/Users/me/repo');
    assert.equal(folderForBranch(tab('a', '  /Users/me/repo '), 'macos'), '/Users/me/repo');
    assert.equal(folderForBranch(tab('a', '\\\\server\\share\\repo'), 'windows'), null, 'another machine');
    assert.equal(folderForBranch(tab('a', '//server/share'), 'macos'), null);
    assert.equal(folderForBranch(tab('a', '\\\\wsl$\\Ubuntu\\home\\me'), 'windows'), null, 'a WSL folder is another machine to Windows');
    assert.equal(folderForBranch(tab('a', '/c/Users/me/repo', { shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }), 'windows'), 'C:\\Users\\me\\repo');
    assert.equal(folderForBranch(tab('a', ''), 'macos'), null);
    assert.equal(folderForBranch(tab('a', null), 'macos'), null);
    assert.equal(folderForBranch(null, 'macos'), null);
  });

  test("BS-11: a folder's branch, read narrowly — the same object while anything else changes", () => {
    const { branchOf } = branchLib;
    const main = info('main');
    B.setState({ branches: { '/a': main, '/b': null } });
    const state1 = B.getState();
    assert.equal(branchOf(state1, '/a'), main);
    assert.equal(branchOf(state1, '/b'), null);
    assert.equal(branchOf(state1, '/missing'), null);
    assert.equal(branchOf(state1, null), null);
    assert.equal(branchOf(state1, 'constructor'), null, 'no prototype keys');
    B.setState((s) => ({ branches: { ...s.branches, '/c': info('dev') } }));
    assert.equal(branchOf(B.getState(), '/a'), main, 'unchanged by another folder');
    assert.equal(typeof branchLib.useFolderBranch, 'function');
  });
});

describe('Branch store: the triggers (S5)', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test('BS-12: at start, each folder in use once; tabs sharing a folder share the lookup', async () => {
    const { time, lk, stop } = driven({ tabs: [tab('a', '/r1'), tab('b', '/r1'), tab('c', '/r2/sub'), tab('d', null), tab('e', '//host/share')] });
    try {
      time.advance(299);
      assert.equal(lk.calls.length, 0);
      time.advance(300);
      assert.deepEqual(lk.dirs().sort(), ['/r1', '/r2/sub']);
      lk.calls[0].answer(info('main'));
      lk.calls[1].answer(info('dev'));
      await settle();
      assert.deepEqual(Object.keys(branches()).sort(), ['/r1', '/r2/sub']);
    } finally {
      stop();
    }
  });

  test('BS-13: only the triggers — nothing else a terminal does looks anything up, and nothing runs on a timer', async () => {
    const { time, lk, stores, ends, stop } = driven({ tabs: [tab('a', '/r1'), tab('b', '/r2')] });
    try {
      time.advance(300);
      for (const c of lk.calls) c.answer(info('main'));
      await settle();
      const base = lk.calls.length;
      assert.equal(base, 2);

      // A title, a running command, an exit code, a progress bar: no.
      const { terminals } = stores;
      terminals.setState({ tabs: terminals.getState().tabs.map((t) => ({ ...t, title: `${t.title}!`, running: true })) });
      terminals.setState({ tabs: terminals.getState().tabs.map((t) => ({ ...t, running: false, lastExitCode: 1 })) });
      terminals.setState({ progress: { a: { state: 'normal', value: 3 } }, notifications: [] });
      time.advance(60_000);
      assert.equal(lk.calls.length, base, 'nothing but the triggers, and no polling');

      // 1. The folder changes: that folder.
      terminals.setState({ tabs: terminals.getState().tabs.map((t) => (t.id === 'a' ? { ...t, cwd: '/r3' } : t)) });
      time.advance(60_300);
      assert.deepEqual(lk.dirs().slice(base), ['/r3']);
      lk.calls.at(-1).answer(info('x'));
      await settle();

      // 2. A command ends: that tab's folder, and no other.
      ends.fire(['b']);
      time.advance(60_600);
      assert.deepEqual(lk.dirs().slice(base), ['/r3', '/r2']);
      lk.calls.at(-1).answer(info('y'));
      await settle();
      ends.fire(['no-such-tab']);
      time.advance(60_900);
      assert.equal(lk.calls.length, base + 2);

      // 3. The workspace's git status refreshed: every folder in use.
      stores.git.setState({ refreshes: 1 });
      time.advance(61_200);
      assert.deepEqual(lk.dirs().slice(base + 2).sort(), ['/r2', '/r3']);
      for (const c of lk.calls.slice(base + 2)) c.answer(info('z'));
      await settle();
      stores.git.setState({ status: { branch: 'main' } });
      time.advance(70_000);
      assert.equal(lk.calls.length, base + 4, 'a git store change that is not a refresh is not one');
    } finally {
      stop();
    }
  });

  test('BS-14: a folder no tab uses any more is forgotten; a new tab in a known folder looks again', async () => {
    const { time, lk, stores, stop } = driven({ tabs: [tab('a', '/r1'), tab('b', '/r2')] });
    try {
      time.advance(300);
      for (const c of lk.calls) c.answer(info('main'));
      await settle();
      stores.terminals.setState({ tabs: [tab('a', '/r1')] });
      assert.deepEqual(Object.keys(branches()), ['/r1'], 'the closed tab took its folder along');
      stores.terminals.setState({ tabs: [tab('a', '/r1'), tab('c', '/r1')] });
      time.advance(600);
      assert.deepEqual(lk.dirs().slice(2), ['/r1']);
      lk.calls[2].answer(info('main'));
      await settle();
      // A folder changed while its lookup runs: the old one is forgotten, and
      // its answer with it.
      stores.terminals.setState({ tabs: [tab('a', '/r4')] });
      time.advance(900);
      stores.terminals.setState({ tabs: [tab('a', '/r5')] });
      lk.calls.at(-1).answer(info('stale'));
      await settle();
      assert.equal('/r4' in branches(), false);
      assert.equal('/r1' in branches(), false);
    } finally {
      stop();
    }
  });

  test('BS-15: Show Git Branch off — no lookup at all, whatever happens; on again, every folder', async () => {
    const { time, lk, stores, ends, stop } = driven({ tabs: [tab('a', '/r1'), tab('b', '/r2')], branch: false });
    try {
      time.advance(10_000);
      stores.terminals.setState({ tabs: [tab('a', '/r3'), tab('b', '/r2')] });
      ends.fire(['a', 'b']);
      stores.git.setState({ refreshes: 5 });
      time.advance(20_000);
      assert.equal(lk.calls.length, 0, 'not one lookup');
      assert.deepEqual(branches(), {});

      stores.settings.setState({ terminalsPanelBranch: true });
      time.advance(20_300);
      assert.deepEqual(lk.dirs().sort(), ['/r2', '/r3']);
      lk.calls[0].answer(info('main'));
      await settle();
      // Off while one runs and another waits: the store empties, the wait is
      // cancelled, the late answer is dropped.
      ends.fire(['a']);
      stores.settings.setState({ terminalsPanelBranch: false });
      assert.deepEqual(branches(), {}, 'nothing stays shown');
      time.advance(30_000);
      lk.calls[1].answer(info('late'));
      await settle();
      assert.equal(lk.calls.length, 2);
      assert.deepEqual(branches(), {});
    } finally {
      stop();
    }
  });

  test("BS-16: the machine's platform arriving re-reads the folders — a Git Bash folder is a drive on Windows", async () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const { time, lk, stores, stop } = driven({ tabs: [tab('a', '/c/work/repo', { shell: bash })], os: 'linux' });
    try {
      time.advance(300);
      assert.deepEqual(lk.dirs(), ['/c/work/repo']);
      lk.calls[0].answer(null);
      await settle();
      stores.system.setState({ os: 'windows' });
      time.advance(600);
      assert.deepEqual(lk.dirs(), ['/c/work/repo', 'C:\\work\\repo']);
      assert.equal('/c/work/repo' in branches(), false, 'the old spelling is forgotten');
    } finally {
      stop();
    }
  });

  test('BS-17: stopped, it listens to nothing', async () => {
    const { time, lk, stores, ends, signals, stop } = driven({ tabs: [tab('a', '/r1')] });
    stop();
    assert.equal(ends.listeners, 0);
    assert.equal(signals.listeners, 0);
    stores.terminals.setState({ activeTabId: 'a' });
    signals.fire('a');
    stores.terminals.setState({ tabs: [tab('a', '/r2')] });
    stores.git.setState({ refreshes: 3 });
    stores.settings.setState({ terminalsPanelBranch: false });
    stores.settings.setState({ terminalsPanelBranch: true });
    time.advance(10_000);
    assert.equal(lk.calls.length, 0);
  });
});

describe('Branch store: the triggers, revised after review (S5)', () => {
  beforeEach(() => B.setState({ branches: {} }));
  const answerWithRepos = (lk, repos) => {
    for (const c of lk.calls) c.answer({ branch: 'main', detached: false, repo: repos[c.dir] });
  };

  test('BS-25: a command ending in a terminal looks again at every folder of its repository — and of no other', async () => {
    const { time, lk, ends, stop } = driven({ tabs: [tab('a', '/r'), tab('b', '/r/sub'), tab('c', '/r/wt'), tab('d', '/q')] });
    try {
      time.advance(300);
      time.advance(300);
      answerWithRepos(lk, { '/r': '/r/.git', '/r/sub': '/r/.git', '/r/wt': '/r/.git/worktrees/wt', '/q': '/q/.git' });
      await settle();
      time.advance(600);
      answerWithRepos(lk, { '/r': '/r/.git', '/r/sub': '/r/.git', '/r/wt': '/r/.git/worktrees/wt', '/q': '/q/.git' });
      await settle();
      const before = lk.calls.length;
      assert.equal(before, 4);
      ends.fire(['b']);
      time.advance(1000);
      assert.deepEqual(lk.dirs().slice(before).sort(), ['/r', '/r/sub'], 'a `git switch` in one folder is a switch for all of them');
    } finally {
      stop();
    }
  });

  test('BS-26: a program in a terminal notifying or ringing looks its repository up again — at most once in 5 s per folder', async () => {
    const { time, lk, stores, signals, stop } = driven({ tabs: [tab('a', '/r'), tab('b', '/r/sub'), tab('c', '/q')] });
    try {
      time.advance(300);
      answerWithRepos(lk, { '/r': '/r/.git', '/r/sub': '/r/.git', '/q': '/q/.git' });
      await settle();
      time.advance(600);
      answerWithRepos(lk, { '/r': '/r/.git', '/r/sub': '/r/.git', '/q': '/q/.git' });
      await settle();
      const base = lk.calls.length;
      signals.fire('a');
      time.advance(1000);
      assert.deepEqual(lk.dirs().slice(base).sort(), ['/r', '/r/sub'], 'an agent that switched branches says nothing else until it exits');
      for (const c of lk.calls.slice(base)) c.answer(info('dev'));
      await settle();
      // The nudge was at 600.
      signals.fire('a');
      time.advance(5_599);
      signals.fire('a');
      time.advance(5_599);
      assert.equal(lk.calls.length, base + 2, 'not again within 5 s');
      time.advance(5_600);
      signals.fire('a');
      time.advance(6_000);
      assert.deepEqual(lk.dirs().slice(base + 2).sort(), ['/r'], '5 s on, again (its repository unknown since)');
      signals.fire('nobody');
      stores.settings.setState({ terminalsPanelBranch: false });
      signals.fire('c');
      time.advance(20_000);
      assert.equal(lk.calls.length, base + 3, 'not for a tab that is gone, nor with the setting off');
    } finally {
      stop();
    }
  });

  test('BS-27: a terminal becoming the active one looks its folder up again — at most once in 5 s per folder', async () => {
    const { time, lk, stores, stop } = driven({ tabs: [tab('a', '/r'), tab('b', '/q')] });
    try {
      time.advance(300);
      for (const c of lk.calls) c.answer(info('main'));
      await settle();
      stores.terminals.setState({ activeTabId: 'b' });
      time.advance(600);
      assert.deepEqual(lk.dirs().slice(2), ['/q']);
      lk.calls.at(-1).answer(info('main'));
      await settle();
      stores.terminals.setState({ activeTabId: 'a' });
      time.advance(900);
      assert.deepEqual(lk.dirs().slice(2), ['/q', '/r']);
      lk.calls.at(-1).answer(info('main'));
      await settle();
      stores.terminals.setState({ activeTabId: 'b' });
      time.advance(1200);
      assert.equal(lk.calls.length, 4, 'switching back and forth is not a lookup each time');
      // '/q' was nudged at 300, '/r' at 600.
      time.advance(5_599);
      stores.terminals.setState({ activeTabId: 'a' });
      time.advance(5_599);
      assert.equal(lk.calls.length, 4, 'not again within 5 s');
      time.advance(5_600);
      stores.terminals.setState({ activeTabId: 'b' });
      stores.terminals.setState({ activeTabId: 'a' });
      time.advance(5_900);
      assert.deepEqual(lk.dirs().slice(4).sort(), ['/q', '/r'], '5 s on, again');
    } finally {
      stop();
    }
  });

  test('BS-28: terminals whose lookups hang hold nothing up — closed, their slots are free; left open, 3 s later', async () => {
    // Found in review (js/hung.mjs): two lookups that never answered held
    // both slots until the app restarted.
    const time = manualTime();
    const asked = [];
    const lookup = (dir) => {
      asked.push(dir);
      return dir.startsWith('/evil') ? new Promise(() => {}) : Promise.resolve(info('main'));
    };
    const stores = fakeStores({ tabs: [tab('a', '/evil/a'), tab('b', '/evil/b')] });
    const warn = console.warn;
    console.warn = () => {};
    const stop = hookLib.startBranchLookups({
      ...stores,
      commandEnded: () => () => {},
      programSignal: () => () => {},
      now: time.now,
      store: B,
      lookup,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    try {
      time.advance(300);
      assert.deepEqual(asked, ['/evil/a', '/evil/b']);
      stores.terminals.setState({ tabs: [tab('c', '/fine/repo')] });
      time.advance(600);
      await settle();
      assert.deepEqual(asked, ['/evil/a', '/evil/b', '/fine/repo'], 'closed: their slots given back at once');
      assert.deepEqual(branches(), { '/fine/repo': info('main') });

      stores.terminals.setState({ tabs: [tab('d', '/evil/d'), tab('e', '/evil/e'), tab('f', '/other')] });
      time.advance(900);
      assert.equal(asked.includes('/other'), false, 'premise: both slots taken');
      time.advance(900 + 3000);
      await settle();
      assert.equal(asked.includes('/other'), true, '3 s later, the next one runs');
      assert.deepEqual(branches()['/other'], info('main'));
    } finally {
      console.warn = warn;
      stop();
    }
  });
});

describe('Branch store: one nudge per folder (S5)', () => {
  beforeEach(() => B.setState({ branches: {} }));

  test("BS-33: the 5 s between nudges is the folder's, whatever nudged it — becoming active, a bell, a message", async () => {
    const { time, lk, stores, signals, stop } = driven({ tabs: [tab('a', '/r'), tab('b', '/r'), tab('c', '/q')] });
    try {
      time.advance(300);
      for (const c of lk.calls) c.answer(info('main'));
      await settle();
      const base = lk.calls.length;
      stores.terminals.setState({ activeTabId: 'a' });
      time.advance(600);
      assert.deepEqual(lk.dirs().slice(base), ['/r'], 'premise: the activation nudged it');
      lk.calls.at(-1).answer(info('main'));
      await settle();
      // Within 5 s of that: a bell in the same terminal, a message in another
      // terminal in the same folder, that one becoming active.
      signals.fire('a');
      signals.fire('b');
      stores.terminals.setState({ activeTabId: 'b' });
      time.advance(5_000);
      assert.equal(lk.calls.length, base + 1, 'the folder was nudged once already');
      // Another folder has a 5 s of its own.
      signals.fire('c');
      time.advance(5_300);
      assert.deepEqual(lk.dirs().slice(base + 1), ['/q']);
    } finally {
      stop();
    }
  });
});

// ---- Wired: the real stores and the browser mock -----------------------------

const backing = new Map();
let previousLocalStorage;
let shimInstalled = false;

function installStorageShim() {
  if (!shimInstalled) {
    previousLocalStorage = globalThis.localStorage;
    shimInstalled = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

function giveStorageBack() {
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

async function freshStart() {
  T.getState().dispose();
  installStorageShim();
  backing.clear();
  T.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [], notifications: [], progress: {} });
  await T.getState().init();
}

// The lookups a wired case started, stopped after it — and by the teardown,
// should a case have failed before its own `afterEach` could.
let stop = () => {};

describe('Branch store: wired', () => {
  beforeEach(async () => {
    B.setState({ branches: {} });
    useSettingsStore.setState({ terminalsPanelBranch: true });
    await freshStart();
    mockBridge.branchLookups.length = 0;
  });
  afterEach(() => {
    stop();
    stop = () => {};
    T.getState().dispose();
    giveStorageBack();
    useSettingsStore.setState({ terminalsPanelBranch: SETTINGS_DEFAULTS.terminalsPanelBranch });
  });

  test('BS-18: a command ending in a terminal looks its folder up again, through `git_branch`', async () => {
    assert.equal(typeof terminalStoreLib.onCommandEnded, 'function', 'terminalStore says when a command ends');
    stop = hookLib.startBranchLookups({ debounceMs: 5 });
    const [first] = T.getState().tabs;
    await mockBridge.emit('pty-cwd', { session_id: first.sessionId, cwd: '/workspace/src' });
    await wait(40);
    assert.deepEqual(mockBridge.branchLookups, ['/workspace/src'], 'the folder, as it changed');
    assert.deepEqual(B.getState().branches['/workspace/src'], info('main'), "the mock's repository");

    mockBridge.gitBranches['/workspace'] = info('topic');
    await mockBridge.emit('pty-command-done', { session_id: first.sessionId, exit_code: 0 });
    await wait(40);
    assert.deepEqual(mockBridge.branchLookups, ['/workspace/src', '/workspace/src']);
    assert.deepEqual(B.getState().branches['/workspace/src'], info('topic'), 'a `git checkout` shows after the command');
    mockBridge.gitBranches['/workspace'] = info('main');

    useGitStore.getState().refreshNow();
    await wait(40);
    assert.equal(mockBridge.branchLookups.length, 3, 'the workspace status refreshed');
  });

  test('BS-19: Show Git Branch off — not one `git_branch` call', async () => {
    useSettingsStore.setState({ terminalsPanelBranch: false });
    stop = hookLib.startBranchLookups({ debounceMs: 5 });
    const [first] = T.getState().tabs;
    await mockBridge.emit('pty-cwd', { session_id: first.sessionId, cwd: '/workspace/tests' });
    await mockBridge.emit('pty-command-done', { session_id: first.sessionId, exit_code: 0 });
    await useGitStore.getState().refreshNow();
    await wait(40);
    assert.deepEqual(mockBridge.branchLookups, []);
    assert.deepEqual(B.getState().branches, {});
  });

  test('BS-20: the mock answers as the backend does — refused by spelling, walked up, checked, shaped like BranchInfo', async () => {
    const gitRs = read('../../src-tauri/src/fs/git.rs');
    const start = gitRs.indexOf('pub struct BranchInfo {');
    assert.notEqual(start, -1, 'BranchInfo is gone from git.rs');
    const fields = [...gitRs.slice(start, gitRs.indexOf('\n}', start)).matchAll(/pub (\w+):/g)].map((m) => m[1]).sort();
    const answer = await mockBridge.invoke('git_branch', { dir: '/workspace/src' });
    assert.deepEqual(Object.keys(answer).sort(), fields);
    assert.deepEqual(answer, { branch: 'main', detached: false, repo: '/workspace/.git' });

    // `//workspace/src` would walk up to the mock's repository: refused by
    // its spelling, as the backend refuses it, before anything is looked at.
    for (const dir of ['', 'relative/path', '\\\\host\\share\\x', '//host/share', '//workspace/src', '\\\\?\\UNC\\host\\x', '\\\\wsl$\\Ubuntu\\home', '/workspace/src/../src', `/workspace/${'x'.repeat(4096)}`, '/workspace/a\u{0000}b', 'C:\\workspace']) {
      assert.equal(await mockBridge.invoke('git_branch', { dir }), null, JSON.stringify(dir.slice(0, 40)));
    }
    await assert.rejects(() => mockBridge.invoke('git_branch', {}), /invalid args `dir` for command `git_branch`/);
    await assert.rejects(() => mockBridge.invoke('git_branch', { dir: 5 }), /expected a string/);

    const added = ['/deep', '/bad', '/zw', '/long'];
    try {
      mockBridge.gitBranches['/deep'] = info('deep');
      const deep = `/deep${'/d'.repeat(63)}`;
      assert.deepEqual(await mockBridge.invoke('git_branch', { dir: deep }), { ...info('deep'), repo: '/deep/.git' }, '64 folders looked in');
      assert.equal(await mockBridge.invoke('git_branch', { dir: `${deep}/d` }), null, 'and no more');
      // Names checked as the backend checks them.
      mockBridge.gitBranches['/bad'] = info('a..b');
      mockBridge.gitBranches['/zw'] = info('evil\u{202e}x');
      mockBridge.gitBranches['/long'] = info('y'.repeat(150));
      assert.equal(await mockBridge.invoke('git_branch', { dir: '/bad' }), null);
      assert.equal(await mockBridge.invoke('git_branch', { dir: '/zw' }), null);
      assert.equal((await mockBridge.invoke('git_branch', { dir: '/long' })).branch, `${'y'.repeat(99)}\u{2026}`);
    } finally {
      for (const key of added) delete mockBridge.gitBranches[key];
    }

    // A mock that plays Windows takes what Rust takes there.
    const os = mockBridge.systemInfo.os;
    mockBridge.systemInfo.os = 'windows';
    mockBridge.gitBranches['C:\\work'] = info('win');
    try {
      const win = { ...info('win'), repo: 'C:\\work\\.git' };
      assert.deepEqual(await mockBridge.invoke('git_branch', { dir: 'C:\\work\\src' }), win);
      assert.deepEqual(await mockBridge.invoke('git_branch', { dir: 'c:/work/src' }), win, 'either separator, either case of the drive');
      assert.deepEqual(await mockBridge.invoke('git_branch', { dir: '\\\\?\\C:\\work' }), win, 'the verbatim spelling of a local drive');
      assert.equal(await mockBridge.invoke('git_branch', { dir: '/workspace/src' }), null, 'not absolute on Windows');
      assert.equal(await mockBridge.invoke('git_branch', { dir: '/work/src' }), null, 'not absolute on Windows, nor read as a drive');
      assert.equal(await mockBridge.invoke('git_branch', { dir: 'C:work' }), null, "a drive's current folder");
    } finally {
      mockBridge.systemInfo.os = os;
      delete mockBridge.gitBranches['C:\\work'];
    }
  });

  test('BS-29: `onCommandEnded` — once per end, after the store has taken it in, and a listener that throws stops nothing', async () => {
    const { onCommandEnded } = terminalStoreLib;
    const [first] = T.getState().tabs;
    const tabNow = () => T.getState().tabs.find((t) => t.id === first.id);
    const heard = [];
    const warn = console.warn;
    console.warn = () => {};
    const stops = [
      onCommandEnded(() => {
        throw new Error('a listener that throws');
      }),
      onCommandEnded((ids) => heard.push({ ids, running: tabNow().running, code: tabNow().lastExitCode })),
    ];
    try {
      await mockBridge.emit('pty-command-started', { session_id: first.sessionId });
      assert.equal(tabNow().running, true, 'premise');
      await mockBridge.emit('pty-command-done', { session_id: first.sessionId, exit_code: 3 });
      assert.deepEqual(heard, [{ ids: [first.id], running: false, code: 3 }], 'once, with the end already taken in');
      await mockBridge.emit('pty-command-done', { session_id: first.sessionId, exit_code: 0 });
      assert.equal(heard.length, 2, 'the listener after one that threw still hears');
      assert.equal(tabNow().lastExitCode, 0, 'and the store still did its part');
      await mockBridge.emit('pty-command-done', { session_id: 'no-such-shell', exit_code: 0 });
      assert.equal(heard.length, 2, 'a shell no tab holds ends nothing anyone hears');
      stops[1]();
      await mockBridge.emit('pty-command-done', { session_id: first.sessionId, exit_code: 0 });
      assert.equal(heard.length, 2, 'stopped');
    } finally {
      console.warn = warn;
      for (const stopIt of stops) stopIt();
    }
  });

  test('BS-30: `onProgramSignal` — a program in a terminal notifying or ringing, once each; never a note from replayed output', async () => {
    const { onProgramSignal } = terminalStoreLib;
    assert.equal(typeof onProgramSignal, 'function', 'terminalStore says when a program in a terminal calls');
    const [first] = T.getState().tabs;
    const away = { focused: false, visible: false };
    const heard = [];
    const warn = console.warn;
    console.warn = () => {};
    const stops = [
      onProgramSignal(() => {
        throw new Error('a listener that throws');
      }),
      onProgramSignal((id) => heard.push(id)),
    ];
    try {
      T.getState().notifyFromProgram(first.id, { title: 'Done', body: 'all of it' }, away);
      assert.deepEqual(heard, [first.id]);
      assert.equal(T.getState().notifications.filter((n) => n.kind === 'program').length, 1, 'the note is recorded all the same');
      T.getState().notifyFromProgram(first.id, { title: 'Old', body: '' }, away, { keptAt: 5 });
      assert.deepEqual(heard, [first.id], 'not for a note read from output kept from before');
      T.getState().bellFromTerminal(first.id, away);
      assert.deepEqual(heard, [first.id, first.id]);
      // The bell turned off is ignored, as it always was: nothing to hear.
      const bell = useSettingsStore.getState().terminalBellAttention;
      useSettingsStore.setState({ terminalBellAttention: false });
      try {
        T.getState().bellFromTerminal(first.id, away);
      } finally {
        useSettingsStore.setState({ terminalBellAttention: bell });
      }
      assert.deepEqual(heard, [first.id, first.id], 'not while the bell is off');
      T.getState().notifyFromProgram('no-such-tab', { title: 'x', body: '' }, away);
      T.getState().bellFromTerminal('no-such-tab', away);
      assert.deepEqual(heard, [first.id, first.id], 'nothing for a tab that is gone');
      stops[1]();
      T.getState().bellFromTerminal(first.id, away);
      assert.equal(heard.length, 2, 'stopped');
    } finally {
      console.warn = warn;
      for (const stopIt of stops) stopIt();
    }
  });

  test('BS-21: the backend has `git_branch(dir)`, registered, on the blocking pool; the hook is mounted once in App', () => {
    const main = read('../../src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::fs::git_branch,'), 'in generate_handler!');
    const commands = read('../../src-tauri/src/commands/fs.rs');
    assert.match(commands, /#\[tauri::command\(rename_all = "snake_case"\)\]\npub async fn git_branch\(dir: String\) -> Result<Option<fs::git::BranchInfo>, String> \{\n\s*tauri::async_runtime::spawn_blocking\(move \|\| fs::git::branch_of\(&dir\)\)/);
    const hook = read('../../src/hooks/useBranchLookups.js');
    assert.ok(hook.includes("invoke('git_branch', { dir })"), 'the hook asks the backend by that name, with `dir`');
    const app = read('../../src/App.jsx');
    assert.equal(app.match(/useBranchLookups\(\);/g)?.length, 1, 'mounted exactly once');
  });
});

describe('Branch store: teardown', () => {
  test('BS-99: the stores, the storage and the mock as the next suite expects them', () => {
    // What the cases left, read before anything is put back: each puts back
    // what it changes in the mock, and a case that failed half way did not.
    const left = [];
    if (JSON.stringify(mockBridge.gitBranches) !== JSON.stringify(GIT_BRANCHES_AT_LOAD)) left.push('gitBranches');
    if (mockBridge.systemInfo.os !== OS_AT_LOAD) left.push('systemInfo.os');
    stop();
    stop = () => {};
    T.getState().dispose();
    giveStorageBack();
    B.setState({ branches: {} });
    mockBridge.gitBranches = JSON.parse(JSON.stringify(GIT_BRANCHES_AT_LOAD));
    mockBridge.systemInfo.os = OS_AT_LOAD;
    mockBridge.branchLookups.length = 0;
    const settings = useSettingsStore.getState();
    useSettingsStore.setState({ terminalsPanelBranch: settings.settingsDefaults.terminalsPanelBranch });

    assert.deepEqual(left, [], 'left changed by a case');
    assert.equal(shimInstalled, false);
    if (previousLocalStorage === undefined) assert.equal('localStorage' in globalThis, false, 'the storage the suite found');
    else assert.equal(globalThis.localStorage, previousLocalStorage, 'the storage the suite found');
  });
});
