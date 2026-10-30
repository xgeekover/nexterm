/**
 * What performance mode watches in the page (stage 4): every chunk of
 * output as it arrives (src/lib/ptyOutputBus.js), every chunk as it goes
 * into xterm (terminalRegistry.js's `writeOutput`), and the page's frames.
 *
 * Loaded only when the app was started with NEXTERM_PERF (perfMode.js); the
 * two hooks are null otherwise, so the code a normal session runs is one
 * null check per chunk.
 *
 * Kept per window — `reset()` starts one, `snapshot()` reads it — because
 * the runner measures one scenario at a time.
 *
 * The hooks are handed in (`setDeliverObserver` from ptyOutputBus.js,
 * `setWriteObserver` from terminalRegistry.js) rather than imported: the
 * registry needs a browser, and the suites check the probe without one.
 *
 *   events, chars   pty-output events and their characters: how finely the
 *                   backend cut the output up, and how much there was
 *   deliverMs       the time spent handing chunks to their terminals — the
 *                   page's own share of every event, before xterm parses
 *   writeLag        how long a chunk waited between `term.write` and xterm
 *                   having read it: grows when a terminal falls behind.
 *                   Sampled — one chunk per terminal every WRITE_SAMPLE_MS
 *                   — so the measuring adds one callback, not one per chunk
 *   frames          the time between animation frames while the scenario
 *                   ran: what the user sees as smooth or stuck
 */
import { summarizeFrames, summarizeTimes } from './perfStats.js';

export const WRITE_SAMPLE_MS = 50;

const performanceNow = () => performance.now();

function freshWindow(now) {
  return {
    startedAt: now(),
    events: 0,
    chars: 0,
    deliverMs: 0,
    deliverMaxMs: 0,
    writes: 0,
    writeLags: [],
    sampledAt: new Map(),
    frames: [],
  };
}

export function createProbe({
  setDeliverObserver,
  setWriteObserver,
  raf = globalThis.requestAnimationFrame?.bind(globalThis),
  now = performanceNow,
} = {}) {
  let current = freshWindow(now);
  let frameLoop = null;

  const deliverObserver = {
    clock: now,
    delivered(_sessionId, data, startedAt) {
      const ms = now() - startedAt;
      current.events += 1;
      current.chars += data.length;
      current.deliverMs += ms;
      if (ms > current.deliverMaxMs) current.deliverMaxMs = ms;
    },
  };

  const writeObserver = (tabId) => {
    current.writes += 1;
    const at = now();
    if (at - (current.sampledAt.get(tabId) ?? -Infinity) < WRITE_SAMPLE_MS) return null;
    current.sampledAt.set(tabId, at);
    const window = current;
    return () => {
      window.writeLags.push(now() - at);
    };
  };

  return {
    install() {
      setDeliverObserver(deliverObserver);
      setWriteObserver(writeObserver);
    },
    uninstall() {
      setDeliverObserver(null);
      setWriteObserver(null);
      this.stopFrames();
    },
    reset() {
      current = freshWindow(now);
    },
    /** Time every animation frame from now until `stopFrames`. */
    startFrames() {
      if (frameLoop || typeof raf !== 'function') return;
      const loop = { last: null, stopped: false };
      frameLoop = loop;
      const tick = (t) => {
        if (loop.stopped) return;
        if (loop.last !== null) current.frames.push(t - loop.last);
        loop.last = t;
        raf(tick);
      };
      raf(tick);
    },
    stopFrames() {
      if (frameLoop) frameLoop.stopped = true;
      frameLoop = null;
    },
    snapshot() {
      const seconds = (now() - current.startedAt) / 1000;
      return {
        seconds: Number(seconds.toFixed(2)),
        events: current.events,
        chars: current.chars,
        eventsPerSecond: seconds > 0 ? Math.round(current.events / seconds) : null,
        charsPerEvent: current.events ? Math.round(current.chars / current.events) : null,
        deliverMs: Number(current.deliverMs.toFixed(1)),
        deliverMaxMs: Number(current.deliverMaxMs.toFixed(2)),
        writes: current.writes,
        writeLag: summarizeTimes(current.writeLags),
        frames: summarizeFrames(current.frames),
      };
    },
  };
}
