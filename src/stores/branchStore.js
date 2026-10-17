import { create } from 'zustand';
import { startableCwd } from '../lib/terminalCwd.js';
import { cleanBranchName } from '../lib/terminalStatus.js';

/**
 * The branch each terminal's folder is on, for the TERMINALS side bar.
 *
 * Kept by FOLDER, not by tab: four terminals in one repository are one
 * lookup, and a terminal that `cd`s elsewhere simply reads another folder's
 * entry. `branches` is `{ [folder]: { branch, detached } | null }` — null for
 * a folder that is no repository, has no branch, or could not be asked about.
 * A folder with no entry has not been answered yet. The folder is the one a
 * new shell could start in (`folderForBranch`): never one on another machine,
 * and Git Bash's `/c/x` read as the drive it names.
 *
 * A lookup is `git_branch`, which reads the repository's `HEAD` in the
 * backend (src-tauri/src/fs/git.rs). `createBranchLookups` paces them; what
 * asks for one, and when, is src/hooks/useBranchLookups.js — a tab's folder
 * changing, a command ending, the workspace's git status refreshing, a
 * program notifying or ringing, a tab becoming the active one. Never on a
 * timer.
 */
export const useBranchStore = create(() => ({ branches: {} }));

/** How long a folder must go without a new request before it is looked up. */
export const BRANCH_DEBOUNCE_MS = 300;

/**
 * The longest a request waits for BRANCH_DEBOUNCE_MS of quiet: a folder
 * asked about every 100 ms — a terminal printing, the watcher seeing files
 * change — is still looked up once a second, not never.
 */
export const BRANCH_MAX_WAIT_MS = 1000;

/**
 * How long a folder whose lookup timed out is left alone by the triggers that
 * only refresh (a command ending, the workspace's status, a program calling,
 * a tab coming to the front). Its own folder changing still asks.
 */
export const BRANCH_SUSPECT_MS = 30_000;

/** How many lookups may run at once, across every folder. */
export const BRANCH_MAX_CONCURRENT = 2;

/**
 * How long a lookup is waited for. A folder on a drive that has gone away —
 * a disconnected share behind a link the backend did not catch — can hold
 * the backend's read for as long as Windows retries; two of them held both
 * slots, and every other folder waited until the app restarted.
 */
export const BRANCH_TIMEOUT_MS = 3000;

/**
 * The folder terminal `tab` is looked up by: where a new shell could start
 * (`startableCwd` — another machine refused, Git Bash and Cygwin spellings
 * read as their drive on Windows), or null for none. A WSL terminal's folder
 * is `\\wsl$\…` to Windows, another machine, so it has no branch.
 */
export function folderForBranch(tab, os) {
  return startableCwd(tab, os) || null;
}

/** `state`'s entry for `folder`: `{ branch, detached }`, or null. The same object while it is unchanged. */
export function branchOf(state, folder) {
  if (typeof folder !== 'string' || !folder) return null;
  const branches = state?.branches;
  return branches && Object.prototype.hasOwnProperty.call(branches, folder) ? branches[folder] ?? null : null;
}

/**
 * `folder`'s branch, for a component: it re-renders when that folder's entry
 * changes, and for nothing else in the store.
 */
export function useFolderBranch(folder) {
  return useBranchStore((state) => branchOf(state, folder));
}

/**
 * What `git_branch` answered, as the store keeps it: `{ branch, detached }`
 * with the name checked again (`cleanBranchName`), or null for anything else.
 * The backend checks before it answers; this is where the name is shown from.
 * Its `repo` is not kept here: nothing shows it (`createBranchLookups` keeps
 * it).
 */
export function normalizeBranchAnswer(answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.branch !== 'string') return null;
  const branch = cleanBranchName(answer.branch);
  return branch ? { branch, detached: answer.detached === true } : null;
}

const sameAnswer = (a, b) => (a ?? null) === (b ?? null) || (a && b && a.branch === b.branch && a.detached === b.detached);

/**
 * Lookups of folders' branches, paced, written into `store`.
 *
 *   - `request(folder)`: look `folder` up once it has gone `debounceMs`
 *     without another request, or `maxWaitMs` after the first request still
 *     waiting, whichever is sooner. A `git checkout` touching thousands of
 *     files refreshes the workspace's status in a burst, and a burst is one
 *     lookup.
 *   - At most one lookup of a folder runs at a time, and `maxConcurrent` in
 *     all; the rest wait, in the order they became due. A folder that comes
 *     due while its lookup runs is marked, and looked up once more when the
 *     answer has landed: the answer is shown either way. (Dropping it instead
 *     starved a folder asked about a little more often than a lookup takes —
 *     no answer ever showed.)
 *   - Each lookup is given `timeoutMs`. Then its slot is free and its folder
 *     keeps what it showed — a slow disk is no reason to wipe a branch that
 *     was right a moment ago — and an answer that comes after all is shown,
 *     while the folder is still in use. The backend is still at it meanwhile —
 *     a thread blocked on a drive that has gone away — so the folder is not
 *     asked again until that call has settled, however often it is requested
 *     (it is marked, and looked up once it has): a stuck folder holds one
 *     backend call, never more.
 *   - A folder whose lookup timed out is suspect until one answers in time,
 *     and so are the folders beside it (the same parent folder, a root
 *     aside): eight terminals in the folders of one dead share are not eight
 *     timeouts in front of the folder at home. Suspects are asked after every
 *     other folder, one at a time; and for `suspectMs` after its timeout a
 *     suspect is not asked by `refresh` — only by `request`.
 *   - `refresh(folder)`: `request`, unless the folder timed out within
 *     `suspectMs` — what the triggers that only refresh call.
 *   - `forget(folder)`: its wait is cancelled, a lookup of it given up on —
 *     its slot freed at once, its answer dropped — and its entry removed.
 *     `clear()` forgets everything.
 *   - `repoOf(folder)`: which repository the last answer put it in (the
 *     backend's `repo`), or null. Kept here, not in the store: nothing shows
 *     it; what reads it is which folders to look at again together.
 *   - `stop()`: nothing more, ever; the store is left as it is.
 *
 * A lookup that fails, throws or times out answers null — no branch — and is
 * said once. `lookup(folder)` returns the answer or a promise of it;
 * `setTimer` and `clearTimer` are there for the suites.
 */
export function createBranchLookups({
  lookup,
  store = useBranchStore,
  debounceMs = BRANCH_DEBOUNCE_MS,
  maxConcurrent = BRANCH_MAX_CONCURRENT,
  timeoutMs = BRANCH_TIMEOUT_MS,
  maxWaitMs = BRANCH_MAX_WAIT_MS,
  suspectMs = BRANCH_SUSPECT_MS,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  // folder -> { timer, since, dirty, queued }
  const entries = new Map();
  // folder -> the lookup of it being waited for: { entry, timer, done }.
  const jobs = new Map();
  // folder -> the last call the backend was given for it, until it settles —
  // waited for or not. Apart from `jobs`: a lookup given up on frees its slot
  // at once, but not the backend's thread.
  const busy = new Map();
  // folder -> the repository its last answer named.
  const repos = new Map();
  // folder -> when its last lookup timed out, until one answers in time.
  const suspects = new Map();
  const queue = [];
  let running = 0;
  // Lookups running for a suspect folder: one at most.
  let suspectsRunning = 0;
  let pumpTimer = null;
  let stopped = false;
  // Said once: a backend that keeps refusing would otherwise say so for
  // every folder after every command.
  let warned = false;
  const warn = (why, err) => {
    if (warned) return;
    warned = true;
    console.warn(`[Branch] could not look up a branch (${why}):`, err ?? '');
  };

  const write = (update) => {
    store.setState((state) => {
      const branches = update(state.branches || {});
      return branches === state.branches ? state : { branches };
    });
  };

  const apply = (folder, answer, repo) => {
    if (answer && repo) repos.set(folder, repo);
    else repos.delete(folder);
    write((branches) => {
      const had = Object.prototype.hasOwnProperty.call(branches, folder);
      if (had && sameAnswer(branches[folder], answer)) return branches;
      return { ...branches, [folder]: answer };
    });
  };

  const remove = (folders) =>
    write((branches) => {
      const gone = folders.filter((f) => Object.prototype.hasOwnProperty.call(branches, f));
      if (gone.length === 0) return branches;
      const next = { ...branches };
      for (const f of gone) delete next[f];
      return next;
    });

  // The lookup is no longer waited for — answered, timed out or given up
  // on — and its slot is free. False when it already was not.
  const release = (folder, job) => {
    if (job.done) return false;
    job.done = true;
    if (job.timer !== null) clearTimer(job.timer);
    running -= 1;
    if (job.suspect) suspectsRunning -= 1;
    if (jobs.get(folder) === job) jobs.delete(folder);
    return true;
  };

  // The folder `folder` is in, for telling which folders are beside one
  // another — '' for one at the root of a disk or a drive, beside which
  // everything is.
  const parentOf = (folder) => {
    const trimmed = folder.replace(/[\\/]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (cut <= 0) return '';
    const parent = trimmed.slice(0, cut);
    return /^[A-Za-z]:$/.test(parent) ? '' : parent;
  };

  // Suspect: its own lookup timed out, or one beside it did.
  const suspect = (folder) => {
    if (suspects.has(folder)) return true;
    const parent = parentOf(folder);
    if (!parent) return false;
    for (const other of suspects.keys()) if (parentOf(other) === parent) return true;
    return false;
  };

  // Its lookup over, a folder marked meanwhile is due again.
  const again = (folder) => {
    const entry = entries.get(folder);
    if (!stopped && entry?.dirty) {
      entry.dirty = false;
      due(folder);
    }
  };

  // The place in the queue of what runs next: the first folder that is not
  // suspect; else, with `withSuspects` and none running, the first that is.
  // -1 for nothing. What was forgotten while it waited leaves the queue here.
  const nextToRun = (withSuspects) => {
    let first = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const entry = entries.get(queue[i]);
      if (!entry || !entry.queued) {
        queue.splice(i, 1);
        i -= 1;
        continue;
      }
      if (!suspect(queue[i])) return i;
      if (first === -1) first = i;
    }
    return withSuspects && suspectsRunning === 0 ? first : -1;
  };

  // Start what can start. A suspect only `withSuspects`: not straight from a
  // folder coming due, as others coming due at the same moment go first
  // (`due` leaves the suspects to a pump a moment later).
  const pump = (withSuspects = true) => {
    while (!stopped && running < maxConcurrent) {
      const at = nextToRun(withSuspects);
      if (at === -1) return;
      const [folder] = queue.splice(at, 1);
      const entry = entries.get(folder);
      entry.queued = false;
      run(folder, entry);
    }
  };

  const pumpSoon = () => {
    if (pumpTimer !== null || stopped) return;
    pumpTimer = setTimer(() => {
      pumpTimer = null;
      pump();
    }, 0);
  };

  function due(folder) {
    const entry = entries.get(folder);
    if (!entry || stopped) return;
    if (jobs.has(folder) || busy.has(folder)) {
      entry.dirty = true;
      return;
    }
    if (!entry.queued) {
      entry.queued = true;
      queue.push(folder);
    }
    if (suspect(folder)) pumpSoon();
    else pump(false);
  }

  function run(folder, entry) {
    const job = { entry, timer: null, done: false, suspect: suspect(folder) };
    jobs.set(folder, job);
    busy.set(folder, job);
    running += 1;
    if (job.suspect) suspectsRunning += 1;
    job.timer = setTimer(() => {
      job.timer = null;
      if (!release(folder, job)) return;
      warn('no answer in time');
      // What it showed stays; the folder is suspect from now.
      suspects.set(folder, now());
      again(folder);
      pump();
    }, timeoutMs);
    let pending;
    try {
      pending = Promise.resolve(lookup(folder));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending
      .then(
        (raw) => ({ answer: normalizeBranchAnswer(raw), repo: typeof raw?.repo === 'string' && raw.repo ? raw.repo : null }),
        (err) => {
          warn('refused', err);
          return { answer: null, repo: null };
        }
      )
      .then(({ answer, repo }) => {
        if (busy.get(folder) === job) busy.delete(folder);
        // In time, the folder is above suspicion again. Late — it timed out —
        // the answer is shown all the same while the folder is in use: no
        // other lookup of it has run since (`busy`). Forgotten, cleared or
        // stopped, it is dropped. Either way the folder may be asked again.
        if (release(folder, job)) suspects.delete(folder);
        if (!stopped && entries.get(folder) === entry) apply(folder, answer, repo);
        again(folder);
        pump();
      });
  }

  const forgetEntry = (folder) => {
    const entry = entries.get(folder);
    if (entry) {
      if (entry.timer !== null) clearTimer(entry.timer);
      // Its place in the queue goes with it.
      entry.queued = false;
      entries.delete(folder);
    }
    const job = jobs.get(folder);
    if (job) release(folder, job);
    repos.delete(folder);
    suspects.delete(folder);
  };

  const request = (folder) => {
    if (stopped || typeof folder !== 'string' || !folder) return;
    let entry = entries.get(folder);
    if (!entry) {
      entry = { timer: null, since: 0, dirty: false, queued: false };
      entries.set(folder, entry);
    }
    const at = now();
    if (entry.timer === null) entry.since = at;
    else clearTimer(entry.timer);
    const wait = Math.max(0, Math.min(debounceMs, entry.since + maxWaitMs - at));
    entry.timer = setTimer(() => {
      entry.timer = null;
      due(folder);
    }, wait);
  };

  return {
    request,
    refresh(folder) {
      const timedOut = suspects.get(folder);
      if (timedOut !== undefined && now() - timedOut < suspectMs) return;
      request(folder);
    },
    /** Whether `folder`'s own last lookup timed out (it is suspect until one answers in time). */
    isSuspect(folder) {
      return suspects.has(folder);
    },
    forget(folder) {
      forgetEntry(folder);
      remove([folder]);
      pump();
    },
    /** Every folder the store has an entry for or a lookup is pending for. */
    known() {
      return [...new Set([...entries.keys(), ...Object.keys(store.getState().branches || {})])];
    },
    /** The repository `folder`'s last answer named, or null. */
    repoOf(folder) {
      return repos.get(folder) ?? null;
    },
    clear() {
      for (const folder of new Set([...entries.keys(), ...jobs.keys()])) forgetEntry(folder);
      queue.length = 0;
      write((branches) => (Object.keys(branches).length === 0 ? branches : {}));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (pumpTimer !== null) clearTimer(pumpTimer);
      pumpTimer = null;
      for (const folder of new Set([...entries.keys(), ...jobs.keys()])) forgetEntry(folder);
      queue.length = 0;
    },
    get running() {
      return running;
    },
  };
}

export default useBranchStore;
