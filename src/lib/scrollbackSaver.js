/**
 * When each terminal's scrollback goes to disk (stage 6, spec D5 and D6).
 *
 * Pure and injected — the clock, the timers, the snapshot, the backend and
 * the page's storage are all handed in — so the suites drive it with a clock
 * they move by hand. The app's instance, wired to the registry and the IPC,
 * is src/lib/scrollbackSession.js.
 *
 * Only a terminal whose normal buffer changed since its last save is saved
 * (`markDirty`, called by the registry). When:
 *
 *   - 1 s after its last change (SAVE_DEBOUNCE_MS) — a burst is one save;
 *   - but never sooner than 5 s after its own last save (SAVE_MIN_INTERVAL_MS):
 *     a terminal printing a line every second or so (a log, a progress line,
 *     a watcher) was otherwise serialized and rewritten whole after every
 *     line — 55 full saves a minute at one line every 1.1 s (review, round 2);
 *   - and never later than 10 s after its first unsaved change
 *     (SAVE_MAX_WAIT_MS), however busy — the shape of the layout's own
 *     write-behind (`schedulePersist` in terminalStore.js): a plain debounce
 *     is starved by exactly the terminals worth saving, the ones that never
 *     stop printing.
 *
 * Marking is O(1) and arms no timer once a terminal is already waiting: one
 * timer for all of them, which looks again when it fires, because the
 * registry marks on every batch xterm parses.
 *
 * Three saves skip that wait. A clear must reach disk before a macOS quit
 * that nothing holds (spec D6), or what was cleared comes back at the next
 * start: Terminal: Clear (`saveNow`) at once, every time; a clear in the
 * output — `clear`, Ctrl+L, a reset — at once too, but at most once every
 * 2 s a terminal (`saveCleared`: `watch -n1` clears its screen every second,
 * and would otherwise be serialized every second). And closing or quitting
 * (`flushAll`).
 *
 * Serializing 5000 lines takes milliseconds, so one terminal is serialized
 * per task: four due at once never make one long task the keyboard waits
 * behind. Every call that changes the files goes through ONE queue in the
 * order it was made, so a delete is never overtaken by a write of the same
 * tab (a file would come back for a closed tab) and a clear is never
 * overtaken by a write queued before it. A read does not wait in that queue
 * (`read`).
 *
 * When saves fail:
 *
 *   - one that fails is tried again at the terminal's next interval, quietly;
 *   - the backend refusing because another running NexTerm keeps the folder
 *     (src-tauri/src/scrollback.rs) stops everything for the session: those
 *     files are the other window's, and fine;
 *   - three calls failing in a row — any cause, any terminal: a lock file that
 *     is a link, a network home with no file locking, but also an antivirus
 *     holding a few renames at once (review, rounds 4 and 5) — open a breaker.
 *     Said once, with the error. While it is open nothing is serialized or
 *     reported unsaved, and nothing is restored; once a minute it lets one
 *     save through — a clear waiting first, else the terminal longest
 *     overdue — and the first call that succeeds closes it. Tripping also
 *     leaves a note in the page's storage (UNTRUSTED_KEY) that the files may
 *     be stale — a clear may never have reached them — so the next start
 *     restores nothing and deletes them (`untrusted`, scrollbackSession.js);
 *     the next save that succeeds takes the note away.
 *
 * `pending` — anything dirty, waiting for its task or in flight — is what
 * the backend holds a window close for (spec D6, `app_set_pending_save`),
 * so it is reported whenever it changes and only then.
 */

/** How long a terminal must be quiet before it is saved. */
export const SAVE_DEBOUNCE_MS = 1000;
/** The least time between two saves of one terminal (but the clears' and `flushAll`). */
export const SAVE_MIN_INTERVAL_MS = 5000;
/** However busy a terminal is, what it shows is never more than this stale on disk. */
export const SAVE_MAX_WAIT_MS = 10_000;
/** The least time between two saves of one terminal for clears in its output (`saveCleared`). */
export const CLEAR_SAVE_GAP_MS = 2000;
/** How long closing or quitting waits for the last saves (spec D6). */
export const EXIT_FLUSH_MS = 1500;
/** Backend calls failing in a row — any terminal, any cause — that open the breaker. */
export const FAILURES_BEFORE_STOP = 3;
/** How often an open breaker lets one save through. */
export const BREAKER_PROBE_MS = 60_000;
/** Where the page notes that the saved files may be stale (the breaker tripped): when, as epoch ms. */
export const UNTRUSTED_KEY = 'nexterm.scrollback.untrustedSince';

/**
 * Whether a backend's refusal says another running NexTerm keeps the saved
 * scrollback (src-tauri/src/scrollback.rs, `ANOTHER_INSTANCE`). Tauri hands
 * a command's error over as its string.
 */
export function isAnotherInstance(err) {
  return /another nexterm/i.test(String(err?.message ?? err ?? ''));
}

/**
 * The page's storage, as src/lib/persistence.js reads it: every look in a
 * try — a webview can throw on the mere access — and nothing thrown back.
 */
export const pageStorage = {
  get(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // nowhere to keep it: the next start will restore as usual
    }
  },
  remove(key) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // nothing to take away
    }
  },
};

/**
 * `snapshot(tabId)` answers what to save: `{ text }` to write, `null` to
 * delete the file (nothing worth keeping — a cleared terminal must not come
 * back with what was cleared), `undefined` to leave the file alone (no
 * terminal any more to read). `backend` is `{ write(tabId, text),
 * delete(tabId), retainOnly(tabIds), clear(), read(tabId), setPending(bool) }`;
 * a call that rejects is logged and the queue goes on. `storage` is
 * `{ get, set, remove }` (`pageStorage`).
 */
export function createScrollbackSaver({
  snapshot,
  backend = {},
  enabled = () => true,
  now = () => Date.now(),
  setTimeout: setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: clearTimer = (id) => clearTimeout(id),
  storage = pageStorage,
  debounceMs = SAVE_DEBOUNCE_MS,
  minIntervalMs = SAVE_MIN_INTERVAL_MS,
  maxWaitMs = SAVE_MAX_WAIT_MS,
  clearGapMs = CLEAR_SAVE_GAP_MS,
  probeMs = BREAKER_PROBE_MS,
  warn = (...args) => console.warn(...args),
} = {}) {
  /** tabId → `{ first, last }`: when it first changed since its last save, and when it last did. */
  const dirty = new Map();
  /** tabId → when it was last saved (its snapshot taken), for SAVE_MIN_INTERVAL_MS. */
  const lastSaved = new Map();
  /** tabId → when a clear in its output was last saved, for CLEAR_SAVE_GAP_MS. */
  const lastCleared = new Map();
  /** tabId → the timer of the one save a clear inside that gap waits for. */
  const clearTimers = new Map();
  /** Tabs cleared while the breaker is open: the first saved when it lets one through, in order. */
  const clearsWaiting = new Set();
  /**
   * Tabs whose file could not be read at the start (`keepFile`): never
   * written or deleted by a save this session, so a read that was only slow
   * never costs the file — the next start tries again.
   */
  const kept = new Set();
  /** Tabs closed (`forget`): a write of theirs that failed is not tried again. Tab ids are never reused. */
  const closed = new Set();
  /** Due, each waiting for a task of its own, oldest first. Still in `dirty` until serialized. */
  const due = [];
  let checkTimer = null;
  let checkAt = Infinity;
  let stepTimer = null;
  let probeTimer = null;
  /** The one queue every call that changes the files goes through; never rejects. */
  let chain = Promise.resolve();
  /** Backend calls that change the files, queued and not settled. */
  let inFlight = 0;
  let pending = false;
  /** Every `clearAll` counts one: a read, or a failed write, from before a clear is let go. */
  let clears = 0;
  /** Another running NexTerm keeps the folder: nothing more is done this session. */
  let refused = false;
  /** The breaker is open: nothing is saved but its once-a-minute try (`probe`). */
  let tripped = false;
  /** Calls that changed the files and failed, in a row; any call that succeeds starts it again. */
  let failuresInARow = 0;
  /** `flushAll`s waiting: the tabs each still waits to see queued, and what it does then. */
  const flushes = [];

  const isEnabled = () => {
    try {
      return !refused && enabled() !== false;
    } catch {
      return false;
    }
  };

  /** Whether saves run as usual: on, not refused, and the breaker closed. */
  const saving = () => !tripped && isEnabled();

  function reportPending() {
    // With the breaker open nothing is going to be saved before a close, so
    // nothing is held for it.
    const next = !tripped && !refused && (dirty.size > 0 || due.length > 0 || inFlight > 0);
    if (next === pending) return;
    pending = next;
    try {
      backend.setPending?.(next);
    } catch (err) {
      warn('[scrollback] could not report unsaved scrollback:', err);
    }
  }

  function cancelClearTimer(tabId) {
    const timer = clearTimers.get(tabId);
    if (timer === undefined) return;
    clearTimer(timer);
    clearTimers.delete(tabId);
  }

  function cancelProbe() {
    if (probeTimer === null) return;
    clearTimer(probeTimer);
    probeTimer = null;
  }

  function cancelEveryTimer() {
    cancelCheck();
    if (stepTimer !== null) {
      clearTimer(stepTimer);
      stepTimer = null;
    }
    for (const tabId of [...clearTimers.keys()]) cancelClearTimer(tabId);
    cancelProbe();
  }

  /**
   * Another running NexTerm keeps the folder (it locked it first): every
   * save from here on would be refused the same way, so it is said once and
   * nothing more is tried this session — no snapshot, nothing reported
   * unsaved, not even the files' upkeep, and no restore of a tab not yet
   * shown (`takeRestore`). The other window's files are fine: no note that
   * they are stale.
   */
  function refuse(err) {
    if (refused) return;
    refused = true;
    tripped = false;
    warn(`[scrollback] not saving or restoring any scrollback in this window for the rest of the session: ${String(err?.message ?? err)}`);
    dirty.clear();
    due.length = 0;
    clearsWaiting.clear();
    cancelEveryTimer();
    for (const flush of flushes.splice(0)) flush.queued();
    reportPending();
  }

  /**
   * FAILURES_BEFORE_STOP calls in a row failed: open the breaker. Said once
   * — a probe that fails again says nothing — and noted in the page's
   * storage, since a save that never landed (a clear, most of all) leaves a
   * file older than what was on screen. What changes meanwhile is still
   * marked, so the probe knows what is owed; nothing is serialized.
   */
  function trip(err) {
    if (tripped || refused) return;
    tripped = true;
    warn(
      `[scrollback] ${failuresInARow} saves failed in a row; not saving scrollback, trying once a minute: ${String(err?.message ?? err)}`
    );
    storage.set(UNTRUSTED_KEY, String(now()));
    due.length = 0;
    cancelCheck();
    if (stepTimer !== null) {
      clearTimer(stepTimer);
      stepTimer = null;
    }
    for (const tabId of [...clearTimers.keys()]) {
      cancelClearTimer(tabId);
      clearsWaiting.add(tabId);
    }
    for (const flush of flushes.splice(0)) flush.queued();
    armProbe();
    reportPending();
  }

  /** A call succeeded: the backend works. The breaker closes and every terminal owed a save gets one. */
  function closeBreaker() {
    if (!tripped) return;
    tripped = false;
    cancelProbe();
    const clearsFirst = [...clearsWaiting];
    clearsWaiting.clear();
    for (const tabId of clearsFirst) saveImmediately(tabId);
    let next = Infinity;
    for (const [tabId, mark] of dirty) next = Math.min(next, dueAt(tabId, mark));
    if (next < Infinity) arm(next);
    reportPending();
  }

  function armProbe() {
    if (probeTimer !== null) return;
    probeTimer = setTimer(probe, probeMs);
  }

  /**
   * The open breaker's once-a-minute try: a clear waiting first, else the
   * terminal longest overdue. It goes through the queue like any save; its
   * success closes the breaker (`enqueue`), its failure leaves it open for
   * another minute, without a word.
   */
  function probe() {
    probeTimer = null;
    if (!tripped || refused) return;
    let tabId = clearsWaiting.values().next().value ?? null;
    if (tabId !== null) clearsWaiting.delete(tabId);
    else {
      let soonest = Infinity;
      for (const [id, mark] of dirty) {
        const at = dueAt(id, mark);
        if (at < soonest) {
          soonest = at;
          tabId = id;
        }
      }
    }
    const op = tabId === null || !isEnabled() ? null : save(tabId);
    Promise.resolve(op).then(() => {
      if (tripped && !refused) armProbe();
    });
  }

  /**
   * Queue a backend call that changes the files behind every one before it;
   * what it answered, or undefined when it failed.
   *
   * Success: the count of failures starts again, an open breaker closes, and
   * — for a save, or a clear of everything — the note that the files may be
   * stale goes (`fresh`). A refusal for another NexTerm stops everything
   * (`refuse`); the FAILURES_BEFORE_STOP-th failure in a row opens the
   * breaker (`trip`). A failure before that is handed to `failed`, which
   * tries again — quietly: a folder that keeps failing is said once, when the
   * breaker opens, and one that recovers needed no word. A call nothing tries
   * again (Clear, keep-only, a closed tab's delete) is logged, unless the
   * breaker already said why.
   */
  function enqueue(what, call, { failed = null, fresh = false } = {}) {
    inFlight += 1;
    reportPending();
    const run = chain
      .then(() => {
        if (refused) return undefined;
        return Promise.resolve(call()).then((answer) => {
          failuresInARow = 0;
          if (fresh) storage.remove(UNTRUSTED_KEY);
          closeBreaker();
          return answer;
        });
      })
      .catch((err) => {
        if (isAnotherInstance(err)) {
          refuse(err);
          return undefined;
        }
        failuresInARow += 1;
        if (failuresInARow >= FAILURES_BEFORE_STOP) trip(err);
        if (!failed) {
          if (!tripped) warn(`[scrollback] could not ${what}:`, err);
          return undefined;
        }
        try {
          failed(err);
        } catch {
          // a retry that cannot be arranged is only a lost retry
        }
        return undefined;
      });
    chain = run.then(() => {
      inFlight -= 1;
      reportPending();
    });
    return run;
  }

  /** `tabId` is queued (or will never be): every `flushAll` waiting for it hears so. */
  function settle(tabId) {
    for (const flush of [...flushes]) {
      flush.ids.delete(tabId);
      if (flush.ids.size === 0) {
        flushes.splice(flushes.indexOf(flush), 1);
        flush.queued();
      }
    }
  }

  function cancelCheck() {
    if (checkTimer === null) return;
    clearTimer(checkTimer);
    checkTimer = null;
    checkAt = Infinity;
  }

  function dropDue(tabId) {
    const at = due.indexOf(tabId);
    if (at !== -1) due.splice(at, 1);
  }

  /**
   * When `tabId`, changed as `mark` says, is due: quiet for a second, and
   * five past its own last save — but ten after its first unsaved change at
   * the latest. Its first unsaved change comes after its last save, so the
   * ceiling never undercuts the interval by more than it should.
   */
  function dueAt(tabId, mark) {
    const quiet = mark.last + debounceMs;
    const saved = lastSaved.get(tabId);
    const spaced = saved === undefined ? quiet : Math.max(quiet, saved + minIntervalMs);
    return Math.min(spaced, mark.first + maxWaitMs);
  }

  /** The one timer, for the earliest a terminal can be due; the check it runs sets the next. Not while the breaker is open. */
  function arm(at) {
    if (tripped) return;
    if (checkTimer !== null && checkAt <= at) return;
    cancelCheck();
    checkAt = at;
    checkTimer = setTimer(check, Math.max(0, at - now()));
  }

  function check() {
    checkTimer = null;
    checkAt = Infinity;
    if (tripped) return;
    const t = now();
    let next = Infinity;
    for (const [tabId, mark] of dirty) {
      if (due.includes(tabId)) continue;
      const at = dueAt(tabId, mark);
      if (at <= t) queue(tabId);
      else next = Math.min(next, at);
    }
    if (next < Infinity) arm(next);
  }

  function queue(tabId) {
    if (due.includes(tabId)) return;
    due.push(tabId);
    if (stepTimer === null) stepTimer = setTimer(step, 0);
  }

  /** One terminal per task. */
  function step() {
    stepTimer = null;
    const tabId = due.shift();
    if (tabId !== undefined && !tripped) save(tabId);
    if (due.length > 0) stepTimer = setTimer(step, 0);
    reportPending();
  }

  /**
   * `tabId`'s normal buffer changed. Nothing is recorded while saving is
   * off, or for a file kept. With the breaker open it is recorded — the
   * probe saves what is owed — but nothing is armed.
   */
  function markDirty(tabId) {
    if (!tabId || kept.has(tabId) || !isEnabled()) return;
    const t = now();
    const mark = dirty.get(tabId);
    if (mark) {
      mark.last = t;
      return;
    }
    const fresh = { first: t, last: t };
    dirty.set(tabId, fresh);
    arm(dueAt(tabId, fresh));
    reportPending();
  }

  /**
   * A save of `tabId` that failed — not refused for another NexTerm — is
   * tried again: the terminal is marked changed, so it is saved at its next
   * interval (its last save counts from the attempt). Not once it has
   * closed, nor across a clear of everything, which must not bring it back.
   */
  function retryLater(tabId, generation) {
    if (refused || generation !== clears || closed.has(tabId)) return;
    markDirty(tabId);
  }

  /**
   * Serialize `tabId` now and queue what it answered; the queued call, or
   * null when there was nothing to queue. Out of `dirty` first: a change
   * after this snapshot marks it again, and one before is in it — the
   * snapshot reads the buffer as xterm has parsed it, there and then.
   */
  function save(tabId) {
    dirty.delete(tabId);
    if (dirty.size === 0) cancelCheck();
    let shot;
    if (isEnabled() && !kept.has(tabId)) {
      try {
        shot = snapshot(tabId);
      } catch (err) {
        warn(`[scrollback] could not read the scrollback of ${tabId}:`, err);
        shot = undefined;
      }
    }
    const generation = clears;
    const failed = () => retryLater(tabId, generation);
    let op = null;
    if (shot === null || (shot !== undefined && typeof shot?.text !== 'string')) {
      lastSaved.set(tabId, now());
      op = enqueue(`delete the scrollback of ${tabId}`, () => backend.delete(tabId), { failed, fresh: true });
    } else if (shot !== undefined) {
      lastSaved.set(tabId, now());
      op = enqueue(`save the scrollback of ${tabId}`, () => backend.write(tabId, shot.text), { failed, fresh: true });
    }
    settle(tabId);
    return op;
  }

  /**
   * `tabId` saved now, past the debounce and the interval (see `saveNow`).
   * With the breaker open it waits for the probe instead, first in line.
   */
  function saveImmediately(tabId) {
    if (!tabId || kept.has(tabId) || !isEnabled()) return;
    if (tripped) {
      markDirty(tabId);
      clearsWaiting.add(tabId);
      return;
    }
    dropDue(tabId);
    save(tabId);
    reportPending();
  }

  return {
    /** Whether anything is unsaved: dirty, waiting for its task, or on its way to disk. */
    get pending() {
      return pending;
    },

    /** Whether another running NexTerm keeps the folder, so nothing is saved or restored this session. */
    get refused() {
      return refused;
    },

    /** Whether the breaker is open: nothing saved but a try a minute, and nothing restored meanwhile. */
    get tripped() {
      return tripped;
    },

    /** Whether the page noted that the saved files may be stale (UNTRUSTED_KEY): the next start must not restore them. */
    get untrusted() {
      return storage.get(UNTRUSTED_KEY) !== null;
    },

    markDirty,

    /** Whether `tabId` has changes not yet serialized. For the suites. */
    isDirty(tabId) {
      return dirty.has(tabId);
    },

    /**
     * `tabId` serialized now, in this task, and its write — or its delete,
     * when nothing is left — queued: past the debounce and the interval,
     * still behind every call before it. For Terminal: Clear, every time: a
     * macOS quit is never held (spec D6), and one inside the debounce would
     * bring back what was cleared at the next start. Nothing while saving is
     * off, or for a file kept.
     */
    saveNow(tabId) {
      saveImmediately(tabId);
    },

    /**
     * A clear in `tabId`'s output — `clear`, Ctrl+L, a reset — saved as
     * `saveNow` saves, but at most once every CLEAR_SAVE_GAP_MS for each
     * terminal: `watch -n1` clears its screen every second, and a clock or a
     * dashboard redrawn with one more often still. A clear inside that gap
     * waits for its end, and all of them there are one save then; the
     * terminal counts as unsaved meanwhile, so a close waits for it.
     */
    saveCleared(tabId) {
      if (!tabId || kept.has(tabId) || !isEnabled()) return;
      if (tripped) {
        saveImmediately(tabId);
        return;
      }
      const t = now();
      const last = lastCleared.get(tabId);
      if (last === undefined || t - last >= clearGapMs) {
        cancelClearTimer(tabId);
        lastCleared.set(tabId, t);
        saveImmediately(tabId);
        return;
      }
      markDirty(tabId);
      if (clearTimers.has(tabId)) return;
      clearTimers.set(
        tabId,
        setTimer(() => {
          clearTimers.delete(tabId);
          lastCleared.set(tabId, now());
          saveImmediately(tabId);
        }, Math.max(0, last + clearGapMs - t))
      );
    },

    /**
     * `tabId`'s file could not be read at the start — the read timed out or
     * failed, which is not the same as there being none: leave it alone for
     * the rest of this session, so the next start can try again. Closing the
     * tab still deletes it (`forget`), and Clear Saved Scrollback or turning
     * the setting off still clears it (`clearAll`).
     */
    keepFile(tabId) {
      if (!tabId) return;
      kept.add(tabId);
      dirty.delete(tabId);
      dropDue(tabId);
      clearsWaiting.delete(tabId);
      cancelClearTimer(tabId);
      if (dirty.size === 0) cancelCheck();
      settle(tabId);
      reportPending();
    },

    /** Whether `tabId`'s file is being left alone (`keepFile`). For the suites. */
    isKept(tabId) {
      return kept.has(tabId);
    },

    /**
     * `tabId` closed for good: whatever it had waiting is dropped and its
     * file deleted — behind any write of it already queued, never before.
     */
    forget(tabId) {
      if (!tabId) return Promise.resolve(undefined);
      closed.add(tabId);
      dirty.delete(tabId);
      dropDue(tabId);
      lastSaved.delete(tabId);
      lastCleared.delete(tabId);
      clearsWaiting.delete(tabId);
      cancelClearTimer(tabId);
      kept.delete(tabId);
      if (dirty.size === 0) cancelCheck();
      const op = enqueue(`delete the scrollback of ${tabId}`, () => backend.delete(tabId));
      settle(tabId);
      reportPending();
      return op;
    },

    /** Every file but those of `tabIds` deleted (the start, spec D4). */
    retainOnly(tabIds) {
      const ids = Array.isArray(tabIds) ? [...tabIds] : [];
      return enqueue('delete the scrollback of terminals that are gone', () => backend.retainOnly(ids));
    },

    /**
     * `tabId`'s file, as text, or null when there is none. Straight to the
     * backend, NOT behind the queue: a restored tab waits for this before it
     * shows its shell's output, and four tabs' writes (megabytes) ahead of it
     * made a restore time out and the file be overwritten a second later
     * (review, round 2). Nothing needs the order: a tab is never saved before
     * its own restore has finished. A clear that comes while it is on its
     * way wins — the read answers null — so nothing cleared comes back.
     * Rejects when the backend does (a read that failed is not "no file":
     * see `keepFile`).
     */
    read(tabId) {
      const before = clears;
      let reading;
      try {
        reading = Promise.resolve(backend.read(tabId));
      } catch (err) {
        return Promise.reject(err);
      }
      return reading.then((text) => (before === clears && typeof text === 'string' ? text : null));
    },

    /**
     * The setting turned off, Clear Saved Scrollback, or a start that finds
     * the files noted as stale: nothing waiting is saved and every file is
     * deleted — after whatever was already queued, so nothing written before
     * lands after it. Once it has succeeded no file is stale, so the note
     * goes. A file kept (`keepFile`) is gone too, so its terminal is saved
     * again from its next change.
     */
    clearAll() {
      clears += 1;
      dirty.clear();
      due.length = 0;
      lastSaved.clear();
      lastCleared.clear();
      clearsWaiting.clear();
      kept.clear();
      cancelCheck();
      if (stepTimer !== null) {
        clearTimer(stepTimer);
        stepTimer = null;
      }
      for (const tabId of [...clearTimers.keys()]) cancelClearTimer(tabId);
      const op = enqueue('delete the saved scrollback', () => backend.clear(), { fresh: true });
      for (const flush of flushes.splice(0)) flush.queued();
      reportPending();
      return op;
    },

    /**
     * Save every terminal that has changes now — past the debounce and the
     * interval — and resolve once those are written, or once `timeoutMs` has
     * passed, whichever is first. Never rejects: it resolves `true` when
     * everything it waited for is on disk, `false` when the time ran out.
     * What changes after the call is not waited for — a terminal still
     * printing would otherwise hold every close for the whole bound. With the
     * breaker open it saves nothing (the note in the page's storage keeps
     * the next start from trusting the files).
     *
     * `sync`: serialize them all in this task instead of one per task — for
     * a page being unloaded, which runs no task after this one.
     */
    flushAll({ timeoutMs = EXIT_FLUSH_MS, sync = false } = {}) {
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (complete) => {
          if (done) return;
          done = true;
          if (timer !== null) clearTimer(timer);
          resolve(complete);
        };
        try {
          const ids = saving() ? new Set(dirty.keys()) : new Set();
          // Everything queued so far — these tabs' writes and anything before
          // them, a delete or a clear — settled.
          const queued = () => {
            chain.then(() => finish(true));
          };
          timer = setTimer(() => finish(false), Math.max(0, Number(timeoutMs) || 0));
          if (ids.size === 0) {
            queued();
            return;
          }
          flushes.push({ ids, queued });
          for (const tabId of ids) {
            cancelClearTimer(tabId);
            queue(tabId);
          }
          if (sync) {
            if (stepTimer !== null) {
              clearTimer(stepTimer);
              stepTimer = null;
            }
            while (due.length > 0) save(due.shift());
            reportPending();
          }
        } catch (err) {
          warn('[scrollback] could not save before leaving:', err);
          finish(false);
        }
      });
    },

    /** For the suites: every timer stopped and everything forgotten — a refusal and an open breaker too — without a backend call. */
    stop() {
      dirty.clear();
      due.length = 0;
      lastSaved.clear();
      lastCleared.clear();
      clearsWaiting.clear();
      kept.clear();
      closed.clear();
      refused = false;
      tripped = false;
      failuresInARow = 0;
      cancelEveryTimer();
      for (const flush of flushes.splice(0)) flush.queued();
      reportPending();
    },
  };
}
