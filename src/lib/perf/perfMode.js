/**
 * Performance mode's entry in the page (stage 4).
 *
 * Asks the backend once whether the app was started to be measured
 * (`perf_info`, src-tauri/src/perf.rs — NEXTERM_PERF in the environment).
 * Not, and nothing more happens: the probe and the runner are separate
 * chunks that are never loaded. Started, and the probe watches the output
 * path from then on; when NEXTERM_PERF_SCENARIOS names scenarios, they run
 * once the app's terminals are up, and the report is written.
 *
 * The probe hangs off `window.__nextermPerf` for whoever is driving the app
 * by hand (the dev bridge, the console).
 */
import { invoke, isTauri } from '../ipc.js';
import { setDeliverObserver } from '../ptyOutputBus.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { setWriteObserver } from '../../components/terminal/terminalRegistry.js';

let started = null;

/** Until the restored terminals all have their shells, or 30 s. */
async function appUp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { tabs, rootPath } = useTerminalStore.getState();
    if (tabs.length > 0 && tabs.every((t) => t.sessionId) && rootPath !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Once per page, whatever calls it (React's development double effects included). */
export function startPerfMode() {
  if (!started) started = start();
  return started;
}

async function start() {
  if (!isTauri()) return null;
  let info;
  try {
    info = await invoke('perf_info');
  } catch {
    // A backend without the command: an older build under a newer page.
    return null;
  }
  if (!info?.enabled) return null;
  const { createProbe } = await import('./perfProbe.js');
  const probe = createProbe({ setDeliverObserver, setWriteObserver });
  probe.install();
  window.__nextermPerf = { probe, info };
  console.info('[perf] performance mode is on', info);
  if (info.scenarios?.length) {
    const { runScenarios } = await import('./perfRunner.js');
    await appUp();
    try {
      const path = await runScenarios(info, probe);
      console.info('[perf] report written to', path);
    } catch (err) {
      console.error('[perf] the run failed:', err);
    }
  }
  return probe;
}
