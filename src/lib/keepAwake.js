/**
 * Keep the computer awake while a coding agent works (bundle 1, A4; F12).
 *
 * Settings ▸ Terminal ▸ Keep the Computer Awake While an Agent Works
 * (`terminalKeepAwakeWhileAgentsWork`, off by default). On, the computer is
 * kept from going to sleep on its own while a Claude Code terminal is
 * Working, and let go as soon as none is. The holding itself is the
 * backend's (src-tauri/src/power.rs): `power_set_keep_awake(on)` answers
 * true while held, false when nothing is held (where it is unsupported), and
 * rejects when a hold failed; `power_keep_awake_support()` answers
 * `{ supported, method }`. Never the display: it may still turn off and lock.
 *
 * Working is what the TERMINALS side bar calls Working, and only that
 * (terminalStatus.js): Claude Code, believed to run in that very shell
 * (`agentRuns`), whose own title says it is working (the store's
 * `agentActivity`). OpenCode says no such thing, and a progress bar is any
 * program's — neither ever keeps the computer awake.
 *
 * The backend is told only when what is wanted changes, in order, and told
 * "off" when this stops. A hold that failed or holds nothing is not held:
 * it is not asked again until the wanted state changes, never in a loop.
 *
 * The backend outlives the page: after a webview reload (⌘R) it still holds
 * what the page before asked for, and the reload has reaped every shell. So
 * the first thing told, once, is "off" — where supported, and before
 * anything else. Letting go of nothing does nothing, and it is not a hold.
 */
import { invoke as ipcInvoke } from './ipc.js';
import { agentRuns } from './terminalStatus.js';

/** The setting, in settingsStore.js's SETTINGS_DEFAULTS. */
export const KEEP_AWAKE_SETTING = 'terminalKeepAwakeWhileAgentsWork';

/** What the support question answers when it cannot be answered. */
const NOT_SUPPORTED = Object.freeze({ supported: false, method: 'none' });

/**
 * Whether `tab` is a Claude Code terminal that is Working: its agent is
 * Claude Code, believed to run in this shell (`agentRuns`: not a restored
 * offer, not exited, typed into this very session), and its `agentActivity`
 * entry says working. Idle, unknown, another agent or no agent: no.
 */
export function agentWorks(tab, agentActivity) {
  if (!tab || tab.agent?.kind !== 'claude' || !agentRuns(tab)) return false;
  return agentActivity?.[tab.id]?.state === 'working';
}

/**
 * Whether the computer should be kept awake now: the setting is on and at
 * least one open terminal is a Claude Code terminal that is Working.
 * `terminalState` is the terminal store's state (`tabs`, `agentActivity`),
 * `settings` the settings store's. Pure.
 */
export function keepAwakeWanted(terminalState, settings) {
  if (settings?.[KEEP_AWAKE_SETTING] !== true) return false;
  const tabs = terminalState?.tabs;
  if (!Array.isArray(tabs)) return false;
  const activity = terminalState.agentActivity ?? {};
  return tabs.some((tab) => agentWorks(tab, activity));
}

/** The backend's support answer, held to its shape; anything else is unsupported. */
export function supportFrom(answer) {
  if (!answer || typeof answer !== 'object' || answer.supported !== true) {
    return answer && typeof answer.method === 'string' ? Object.freeze({ supported: false, method: answer.method }) : NOT_SUPPORTED;
  }
  return Object.freeze({ supported: true, method: typeof answer.method === 'string' ? answer.method : 'none' });
}

/** Asks `power_keep_awake_support` through `ask`. Never rejects: a failure is unsupported. */
export function askKeepAwakeSupport(ask = ipcInvoke) {
  return Promise.resolve()
    .then(() => ask('power_keep_awake_support'))
    .then(supportFrom, () => NOT_SUPPORTED);
}

let sharedSupport = null;

/**
 * The app's one support question (the Settings row and the page logic both
 * read it): asked the first time, the same answer after.
 */
export function keepAwakeSupport() {
  sharedSupport ??= askKeepAwakeSupport(ipcInvoke);
  return sharedSupport;
}

/**
 * The Settings row's description, `support` being the backend's answer, or
 * null while it is not known yet.
 */
export function keepAwakeDescription(support) {
  const base =
    'While a Claude Code terminal is working, keeps the computer from going to sleep on its own, and lets it sleep again as soon as no agent works, the agent ends or the terminal closes. The display may still turn off and lock. OpenCode terminals and progress bars do not count.';
  if (support && support.supported === false) return `${base} Not available on this system.`;
  return base;
}

/**
 * Start telling the backend whether to keep the computer awake. `store` is
 * the terminal store, `settings` the settings store (zustand: `getState`,
 * `subscribe`), `invoke` the IPC call. Asks support once, at start, and
 * where supported first tells the backend "off" once, to let go of a hold
 * a reloaded page left behind; where unsupported, the backend is never
 * told anything. Returns the stop function: it tells the backend "off" if
 * anything was held. The function's `settled()` is a promise for every call
 * made so far (tests).
 */
export function startKeepAwake({ store, settings, invoke = ipcInvoke } = {}) {
  let stopped = false;
  // What was last wanted, and what the backend holds by its answers.
  let wanted = false;
  let held = false;
  let support = null;
  // One call at a time, in the order they were wanted.
  let queue = Promise.resolve();

  // The app's one question when this is the app's own IPC (the Settings row
  // reads the same answer); a question of its own for an injected `invoke`.
  const supported = () => {
    support ??= invoke === ipcInvoke ? keepAwakeSupport() : askKeepAwakeSupport(invoke);
    return support;
  };

  const letGo = async () => {
    held = false;
    try {
      await invoke('power_set_keep_awake', { on: false });
    } catch (err) {
      console.warn('[keep-awake] could not let the computer sleep again:', err);
    }
  };

  // Brings the backend in line with what is wanted NOW, not when this step
  // was queued: a burst of changes while one call is out ends in one call.
  const sync = async () => {
    if (wanted === held) return;
    if (wanted) {
      if (!(await supported()).supported) return;
      if (!wanted) return; // let go while support was being asked
      try {
        held = (await invoke('power_set_keep_awake', { on: true })) === true;
      } catch (err) {
        held = false;
        console.warn('[keep-awake] could not keep the computer awake:', err);
      }
      return;
    }
    await letGo();
  };

  // The first step, once: let go of whatever a reloaded page left held.
  // Nothing is held here yet, so nothing is lost; stopped first, it is not sent.
  queue = queue.then(async () => {
    if ((await supported()).supported && !stopped) await letGo();
  });

  const update = () => {
    const next = !stopped && keepAwakeWanted(store.getState(), settings.getState());
    if (next === wanted) return;
    wanted = next;
    queue = queue.then(sync);
  };

  const unsubscribeTerminals = store.subscribe(update);
  const unsubscribeSettings = settings.subscribe(update);
  update();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribeTerminals();
    unsubscribeSettings();
    update();
  };
  stop.settled = () => queue;
  return stop;
}
