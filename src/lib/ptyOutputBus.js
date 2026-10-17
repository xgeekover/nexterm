/**
 * Every shell's output on its way to its terminal — kept for a terminal that
 * does not exist yet.
 *
 * A tab's xterm is made the first time a TerminalView shows it
 * (`getOrCreateTerminal`). Until then nothing wrote that session's output
 * anywhere, so everything a tab printed before it was first shown was lost:
 * the second tab of a pane, a group opened in the background, and — with
 * layout templates — the startup command typed into a tab nobody had looked
 * at yet. Measured in the macOS app (2026-10-05): a template's background tab
 * had run its command (`fc -ln -1` in it printed it), and showed nothing but
 * a fresh prompt when brought forward. The prompt only came back because a
 * shell redraws it when the terminal is resized.
 *
 * So all output goes through here, by ONE `pty-output` listener started at
 * bootstrap (`startPtyOutputBus`, from the store's `attachListeners`, before
 * any shell is spawned). A session with a terminal attached gets each chunk
 * written straight into it; one without has the chunks kept, the newest
 * `BACKLOG_LIMIT` characters of them. `attachOutput` writes what was kept into
 * the terminal and from then on delivers live — in one synchronous step, so
 * no chunk can arrive in between, be written twice, or be overtaken: there is
 * only the one listener, and JavaScript runs one event at a time.
 *
 * A tail is enough: a program that redraws its screen (a TUI, a progress bar)
 * repaints whatever an older part held, and a log keeps its latest lines. A cut
 * may land inside an escape sequence; the first chunk kept then starts with a
 * few stray characters, which is the price of a bounded buffer.
 */
import { listen } from './ipc.js';

/** Characters of output kept per session while it has no terminal: the newest ones. */
export const BACKLOG_LIMIT = 1_000_000;

/** sessionId → the function writing into that session's terminal. */
const sinks = new Map();

/**
 * sessionId → `{ chunks, size }` — output waiting for a terminal, each chunk
 * as `{ data, at }`: what arrived, and when (`Date.now()`), which is when it
 * happened as far as anyone can tell.
 */
const backlogs = new Map();

/** The one `pty-output` listener, once started (a promise of its unlisten). */
let listening = null;

function keep(sessionId, data, at) {
  let backlog = backlogs.get(sessionId);
  if (!backlog) {
    backlog = { chunks: [], size: 0 };
    backlogs.set(sessionId, backlog);
  }
  backlog.chunks.push({ data, at });
  backlog.size += data.length;
  // Oldest first out, down to the limit. A single chunk past it on its own
  // keeps only its tail.
  while (backlog.size > BACKLOG_LIMIT && backlog.chunks.length > 1) {
    backlog.size -= backlog.chunks.shift().data.length;
  }
  if (backlog.size > BACKLOG_LIMIT) {
    const only = backlog.chunks[0];
    backlog.chunks[0] = { data: only.data.slice(only.data.length - BACKLOG_LIMIT), at: only.at };
    backlog.size = backlog.chunks[0].data.length;
  }
}

/**
 * One chunk of one session's output: into its terminal, or kept until there
 * is one, with the time it arrived (`at`, now unless a suite says otherwise).
 * Never throws — a sink that does is reported, and the chunk is lost rather
 * than the listener.
 */
export function deliver(sessionId, data, at = Date.now()) {
  if (!sessionId || typeof data !== 'string' || data === '') return;
  const sink = sinks.get(sessionId);
  if (!sink) {
    keep(sessionId, data, at);
    return;
  }
  try {
    sink(data);
  } catch (err) {
    console.warn('[Terminal] could not write output into its terminal:', err);
  }
}

/**
 * Give `sessionId`'s output to `sink` from now on, after first handing it
 * whatever was kept, in order. Returns the function that takes the sink away
 * again; output after that is kept, as before there was a terminal.
 *
 * A kept chunk is handed on as `sink(chunk, true, at)` — `at` being when it
 * arrived — a live one as `sink(chunk)`: what was kept happened before anyone
 * could see it, and is history (`createHistoryMark`).
 */
export function attachOutput(sessionId, sink) {
  if (!sessionId || typeof sink !== 'function') return () => {};
  const backlog = backlogs.get(sessionId);
  backlogs.delete(sessionId);
  sinks.set(sessionId, sink);
  if (backlog) {
    for (const chunk of backlog.chunks) {
      try {
        sink(chunk.data, true, chunk.at);
      } catch (err) {
        console.warn('[Terminal] could not write kept output into its terminal:', err);
      }
    }
  }
  return () => {
    if (sinks.get(sessionId) === sink) sinks.delete(sessionId);
  };
}

/**
 * Whether what a terminal is reading right now is history: output kept for
 * it before it was first shown, written into it as it is made.
 *
 * Kept output is drawn as it always was — the screen and the scrollback are
 * the point of keeping it — but what it announces is over: a progress bar
 * of a command that has since ended (its end came and went while there was
 * no terminal to wait for), a BEL rung minutes ago. Taken live, the bar came
 * back over the prompt for good, and the bell made a fresh entry for news
 * that was old. So the terminal's progress handler and its bell ask
 * `reading` and let it pass.
 *
 * xterm reads a write a task later, so a flag set around the writes would be
 * down again long before the reading. Each kept chunk is counted instead:
 * `before()` just ahead of writing it — xterm reads the first write after a
 * key at once, inside the write — and `after(term)` just behind it, an empty
 * write whose callback xterm runs once the chunk before it has been read.
 * Live output written later is read after those callbacks, as history no
 * more. A terminal that cannot be written to counts nothing.
 *
 * `before(at)` takes the time the chunk arrived, and `at` is that time for
 * the chunk being read — null when none is: xterm reads the chunks in the
 * order they were written, so the oldest still counted is the one it is
 * reading. A message a program left in kept output is filed under it
 * (`notifyFromProgram`), not under the moment the tab was first shown.
 */
export function createHistoryMark() {
  // When each kept chunk written and not yet read arrived, oldest first.
  const unread = [];
  const done = () => {
    unread.shift();
  };
  return {
    before(at = null) {
      unread.push(typeof at === 'number' ? at : null);
    },
    after(term) {
      try {
        term.write('', done);
      } catch {
        done();
      }
    },
    get reading() {
      return unread.length > 0;
    },
    get at() {
      return unread.length > 0 ? unread[0] : null;
    },
  };
}

/** Drop everything about a session — its tab is gone. */
export function forgetOutput(sessionId) {
  if (!sessionId) return;
  sinks.delete(sessionId);
  backlogs.delete(sessionId);
}

/** How many characters are waiting for `sessionId`'s terminal (0 when none). */
export function backlogSize(sessionId) {
  return backlogs.get(sessionId)?.size ?? 0;
}

/**
 * Start the one `pty-output` listener. Idempotent: the store calls it at
 * bootstrap, the registry before it attaches a terminal (so a terminal made
 * without the store's bootstrap — a test, the browser build — still gets its
 * output). `on` is for the suites.
 */
export function startPtyOutputBus({ listen: on = listen } = {}) {
  if (!listening) {
    listening = Promise.resolve(
      on('pty-output', (payload) => {
        deliver(payload?.session_id, payload?.data);
      })
    ).catch((err) => {
      listening = null;
      console.warn('[Terminal] could not listen for shell output:', err);
      return () => {};
    });
  }
  return listening;
}

/** For the suites: back to a fresh start. */
export async function resetPtyOutputBus() {
  const unlisten = await listening?.catch?.(() => null);
  try {
    unlisten?.();
  } catch {
    // nothing to stop
  }
  listening = null;
  sinks.clear();
  backlogs.clear();
}
