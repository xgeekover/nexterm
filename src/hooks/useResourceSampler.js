import { useEffect } from 'react';
import { invoke as ipcInvoke } from '../lib/ipc.js';
import { RESOURCE_FOLLOW_UP_MS, RESOURCE_SAMPLE_MS, RESOURCE_SETTING, documentVisible, isWslTerminal, shouldSample } from '../lib/resourceUsage.js';
import { useResourceUsageStore } from '../stores/resourceUsageStore.js';
import { isViewShown, useSettingsStore } from '../stores/settingsStore.js';
import { useSystemStore } from '../stores/systemStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';

/**
 * The page side of Show CPU and Memory (bundle 4, B8-F3): every
 * RESOURCE_SAMPLE_MS (5 s) it asks the backend `pty_resource_usage` for the
 * terminals running now, and keeps the answer in the resource usage store —
 * only while `shouldSample` (src/lib/resourceUsage.js) says so: the setting
 * is on, the window can be seen, and the TERMINALS panel or a tab's hover
 * card is on screen.
 *
 * - It stops the moment that turns false (the setting, the document's
 *   `visibilitychange`, the panel's region or view, the last card going),
 *   and starts again when it turns true. A run starts with a sample at once;
 *   that first answer's CPU is shown as measuring, as the backend measured
 *   it since its last call, before the pause, which is not what the
 *   terminal does now. RESOURCE_FOLLOW_UP_MS (1 s) after that answer comes
 *   it asks once more, so a real CPU figure shows 1 s later rather than 5 s
 *   later (human decision, 2026-11-24); then every 5 s from the start of the
 *   run. A tick of the 5 s that comes first makes the follow-up needless.
 * - Stopped, it forgets every figure, so none from an earlier run can show
 *   when it starts again: until the run's first answer a terminal shows no
 *   figure, as one with no sample yet does.
 * - Never two calls at once: a tick while one is out is skipped, whichever
 *   run it belongs to, and so is the follow-up. A run that starts while an
 *   earlier run's call is out asks as soon as that call is back. An answer
 *   that comes after a stop is dropped.
 * - A call that fails leaves the figures as they were, and is said once
 *   (until one succeeds again), never thrown.
 * - A WSL terminal is not asked about: what runs in it cannot be seen
 *   (`isWslTerminal`). Nor is one whose shell has exited.
 * - A terminal that is gone, has exited or runs another shell now loses its
 *   figures as soon as the terminal store says so (`prune`).
 *
 * `startResourceSampler` returns its stop; `stop.settled()` is the last call
 * (for the suites). Everything it reads, and the clock, can be handed in.
 */
export function startResourceSampler({
  store = useTerminalStore,
  settings = useSettingsStore,
  system = useSystemStore,
  usage = useResourceUsageStore,
  invoke = ipcInvoke,
  doc = globalThis.document,
  setInterval: every = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: stopEvery = (id) => globalThis.clearInterval(id),
  setTimeout: later = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancelLater = (id) => globalThis.clearTimeout(id),
  now = () => Date.now(),
  intervalMs = RESOURCE_SAMPLE_MS,
  followUpMs = RESOURCE_FOLLOW_UP_MS,
} = {}) {
  let stopped = false;
  // Non-null while sampling.
  let timer = null;
  // Bumped at every start and stop: an answer from an earlier run is dropped.
  let run = 0;
  // Whether a call is out, whichever run asked it.
  let busy = false;
  // The next answer is the first of its run: its CPU is shown as measuring.
  let measuring = false;
  // The one more sample after a run's first answer, while it waits.
  let followUp = null;
  // The run's first call is still to be made: it started while a call was out.
  let owed = false;
  let warned = false;
  let last = Promise.resolve();

  /** Running terminals: tab id → session id. */
  const live = () => {
    const running = new Map();
    for (const tab of store.getState().tabs ?? []) {
      if (!tab?.id || typeof tab.sessionId !== 'string' || !tab.sessionId || tab.exited) continue;
      running.set(tab.id, tab.sessionId);
    }
    return running;
  };

  /** The terminals to ask about: session id → tab id, WSL left out. */
  const measured = () => {
    const sys = system.getState();
    const options = { defaultShell: settings.getState().terminalDefaultShell, systemShell: sys.defaultShell, platform: sys.os };
    const tabs = new Map((store.getState().tabs ?? []).map((tab) => [tab?.id, tab]));
    const bySession = new Map();
    for (const [tabId, sessionId] of live()) {
      if (!isWslTerminal(tabs.get(tabId), options)) bySession.set(sessionId, tabId);
    }
    return bySession;
  };

  const cancelFollowUp = () => {
    if (followUp !== null) cancelLater(followUp);
    followUp = null;
  };

  const tick = () => {
    if (timer === null) return;
    if (busy) {
      if (measuring) owed = true;
      return;
    }
    owed = false;
    // Whichever sample comes next after the first answer gives the real CPU.
    cancelFollowUp();
    const tabBySession = measured();
    if (tabBySession.size === 0) return;
    const mine = run;
    const first = measuring;
    measuring = false;
    busy = true;
    let call;
    try {
      call = Promise.resolve(invoke('pty_resource_usage', { session_ids: [...tabBySession.keys()] }));
    } catch (err) {
      call = Promise.reject(err);
    }
    last = call
      .then(
        (answer) => {
          if (mine !== run) return;
          warned = false;
          const kept = usage.getState();
          kept.apply(answer, tabBySession, { at: now(), measuring: first });
          // The terminals may have changed while the call was out.
          kept.prune(live());
          if (first && timer !== null) {
            followUp = later(() => {
              followUp = null;
              tick();
            }, followUpMs);
          }
        },
        (err) => {
          if (mine !== run) return;
          if (first) measuring = true;
          if (warned) return;
          warned = true;
          console.warn('[resources] could not measure the terminals:', err);
        }
      )
      .finally(() => {
        busy = false;
        // A run that started while this call was out has not asked yet.
        if (owed && timer !== null) tick();
      });
  };

  const update = () => {
    const state = settings.getState();
    const on = !stopped && state[RESOURCE_SETTING] === true;
    const want =
      on &&
      shouldSample({
        settingOn: true,
        windowVisible: documentVisible(doc),
        panelVisible: isViewShown(state, 'terminals'),
        cardShown: usage.getState().cardsShown > 0,
      });
    if (want && timer === null) {
      run += 1;
      measuring = true;
      timer = every(tick, intervalMs);
      tick();
    } else if (!want && timer !== null) {
      run += 1;
      stopEvery(timer);
      timer = null;
      cancelFollowUp();
      owed = false;
      // Nothing from this run is shown when the next one starts: no figure
      // until its first answer.
      usage.getState().clear();
    }
    if (!on) usage.getState().clear();
  };

  const unsubscribeSettings = settings.subscribe(update);
  const unsubscribeUsage = usage.subscribe((s, prev) => {
    if (s.cardsShown !== prev?.cardsShown) update();
  });
  const unsubscribeTerminals = store.subscribe((s, prev) => {
    if (s.tabs !== prev?.tabs) usage.getState().prune(live());
  });
  doc?.addEventListener?.('visibilitychange', update);
  update();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribeSettings();
    unsubscribeUsage();
    unsubscribeTerminals();
    doc?.removeEventListener?.('visibilitychange', update);
    update();
  };
  stop.settled = () => last;
  return stop;
}

/** Starts the sampler once for the app (App.jsx), and stops it on unmount / HMR. */
export function useResourceSampler() {
  useEffect(() => startResourceSampler(), []);
}

/**
 * For a hover card that shows the figures: while `shown`, it counts as a card
 * on screen, so the sampler asks even with the TERMINALS panel hidden.
 */
export function useResourceCardShown(shown = true) {
  useEffect(() => (shown ? useResourceUsageStore.getState().noteCardShown() : undefined), [shown]);
}
