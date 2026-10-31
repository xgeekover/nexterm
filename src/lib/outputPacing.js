/**
 * Output for a terminal the user is not typing in, written into xterm at a
 * pace (stage 4) — cmux 0.65 draws panes without focus at 30 Hz.
 *
 * Each terminal's chunks are held and written together at most every
 * `ms`, and at most `budget` characters at a time (one chunk at least, so
 * nothing can be held for ever); whoever asks `paced(target)` says which
 * terminals are paced at all — not the one typed in, not one whose cmd
 * waits to be answered (src/lib/batchJobReply.js judges every chunk as it
 * arrives). A chunk for a terminal that is not paced writes what was held
 * first, so order never changes.
 *
 * `read`, the output bus's acknowledgement for flow control, travels with
 * its chunk: called once xterm has read the write the chunk went out in, so
 * a terminal held back holds its program back too, instead of the page
 * piling it up. `drop` acknowledges what will never be written.
 *
 * No DOM, no store: terminalRegistry.js wires it to xterm and to focus, and
 * the suites run it with a fake clock.
 */
export const PACE_MS = 33;

export function createOutputPacer({ write, paced, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const settings = { ms: PACE_MS, budget: Infinity };
  const queues = new Map();

  function flush(target, budget = Infinity) {
    const queue = queues.get(target);
    if (!queue || queue.chunks.length === 0) return;
    let size = 0;
    let count = 0;
    while (count < queue.chunks.length && (count === 0 || size + queue.chunks[count].length <= budget)) {
      size += queue.chunks[count].length;
      count += 1;
    }
    const data = queue.chunks.splice(0, count).join('');
    const reads = queue.reads.splice(0, count);
    queue.lastAt = now();
    const acknowledge = () => {
      for (const read of reads) read?.();
    };
    try {
      write(target, data, acknowledge);
    } catch (err) {
      // Lost (xterm refuses a write past 50 M characters waiting): never to
      // be read, so not owed — and the next turn still comes.
      console.warn('[Terminal] could not write held output into its terminal:', err);
      acknowledge();
    }
  }

  function schedule(target) {
    const queue = queues.get(target);
    if (!queue || queue.timer !== null || queue.chunks.length === 0) return;
    const wait = Math.max(0, queue.lastAt + settings.ms - now());
    queue.timer = setTimer(() => {
      queue.timer = null;
      if (queues.get(target) !== queue) return;
      flush(target, settings.budget);
      schedule(target);
    }, wait);
  }

  return {
    /** A live chunk for `target`: written now, or held for its next turn. */
    deliver(target, data, read = null) {
      if (settings.ms <= 0 || !paced(target)) {
        flush(target);
        write(target, data, read);
        return;
      }
      let queue = queues.get(target);
      if (!queue) {
        queue = { chunks: [], reads: [], timer: null, lastAt: -Infinity };
        queues.set(target, queue);
      }
      queue.chunks.push(data);
      queue.reads.push(read);
      schedule(target);
    },
    /** Everything held for `target`, now — before something reads its screen. */
    flush(target) {
      flush(target);
    },
    /** `target` is gone: what is held is acknowledged and never written. */
    drop(target) {
      const queue = queues.get(target);
      if (!queue) return;
      clearTimer(queue.timer);
      queues.delete(target);
      for (const read of queue.reads) read?.();
    },
    /** `ms` 0 writes every chunk at once; `kb` 0 puts no limit on a write. */
    configure({ ms = PACE_MS, kb = 0 } = {}) {
      settings.ms = Number.isFinite(ms) && ms > 0 ? ms : 0;
      settings.budget = Number.isFinite(kb) && kb > 0 ? kb * 1024 : Infinity;
    },
    /** Characters held for `target` — for the suites. */
    held(target) {
      return queues.get(target)?.chunks.reduce((n, chunk) => n + chunk.length, 0) ?? 0;
    },
  };
}
