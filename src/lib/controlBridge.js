/**
 * The control API wired into the running page (stage 7): the dispatcher
 * (src/lib/controlDispatcher.js) listening for the backend's
 * `control-request`, with the terminal registry's real pieces, and the
 * backend kept told what Settings ▸ Terminal ▸ Control allows.
 *
 * Apart from the dispatcher because this is the one piece that imports the
 * terminal registry, and with it xterm: the suites drive the dispatcher with
 * their own terminals and never load this.
 */
import { listen } from './ipc.js';
import { CONTROL_REQUEST_EVENT, controlSettingsReported, createControlDispatcher, reportControlSettings } from './controlDispatcher.js';
import { terminalAfterOutput, terminalModes } from '../components/terminal/terminalRegistry.js';
import { holdSpawnsUntil, setProgramDesktopGate, useTerminalStore } from '../stores/terminalStore.js';

/**
 * Start answering control requests. Returns the stop, which stops listening
 * and reporting — and tells the backend nothing (see `reportControlSettings`):
 * React mounts the app's effects twice in development, and the second start
 * must find every shell's token still good.
 */
export function startControl() {
  const dispatcher = createControlDispatcher({
    readTerminal: (tabId) => terminalAfterOutput(tabId),
    modesOf: (tabId) => terminalModes(tabId),
  });
  let stopped = false;
  let unlisten = null;
  listen(CONTROL_REQUEST_EVENT, (payload) => {
    // Answered whatever happens (`handle` never rejects); nothing awaits it
    // here, so one slow request never holds the next one's event.
    dispatcher.handle(payload);
  })
    .then((off) => {
      if (stopped) off?.();
      else unlisten = off;
    })
    .catch((err) => console.error('[control] cannot answer control requests:', err));

  // What terminals opened through the API print as notifications counts
  // against the API's desktop cap too (re-verification F9).
  const previousGate = setProgramDesktopGate(dispatcher.desktopAllowedFor);
  // A closed terminal's children and rate limit go with it.
  const unsubscribe = useTerminalStore.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs) dispatcher.prune(state);
  });
  // Reported first, and every shell held until it is answered: the backend
  // gives each shell it spawns a token, and listens with the spec's defaults
  // until it is told the user's settings — a user who turned the API off
  // must not have the first terminals of a session get one. App.jsx starts
  // this before the terminal store's own start; the hold makes that order
  // a guarantee rather than a matter of which promise settles first.
  const stopReporting = reportControlSettings();
  holdSpawnsUntil(controlSettingsReported());

  return () => {
    stopped = true;
    setProgramDesktopGate(previousGate);
    unsubscribe();
    stopReporting();
    try {
      unlisten?.();
    } catch (err) {
      console.warn('[control] could not stop listening:', err);
    }
    unlisten = null;
  };
}
