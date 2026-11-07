/**
 * What a terminal's scrollback saver needs to hear from its xterm (stage 6):
 * that the normal buffer changed, and that it was cleared.
 *
 *   changed()  output parsed while the normal buffer is up — the alternate
 *              screen is never saved, so a full-screen program redrawing 60
 *              times a second costs nothing here — or a switch between the
 *              two buffers. xterm reports at most once per batch it parses,
 *              so this is cheap; when to save is the saver's.
 *   cleared()  the output cleared the normal buffer — `clear` (CSI 2 J and
 *              CSI 3 J), Ctrl+L (CSI H, CSI 2 J), their selective forms
 *              (DECSED, CSI ? 2 J and CSI ? 3 J), a reset (ESC c) — and the
 *              batch it was in has been parsed: what is left is to be saved
 *              at once (the saver's `saveCleared`), because a macOS quit is
 *              never held for a save (spec D6) and one inside the wait
 *              brought back what was cleared at the next start.
 *   quiet()    true while what is parsed is not a change: a restore writing
 *              what the file already holds.
 *
 * Clears are heard from xterm's parser, as it meets them: handlers for CSI J
 * and ESC c that note the clear and return false, so xterm still does it.
 * The normal buffer's length used to be watched for a drop instead, and that
 * cannot see most clears (review, round 3): Ctrl+L and a `clear` with less
 * than a screen of output above it leave the length as it was, and a clear
 * followed by more output in the same batch ends longer than it began. Only
 * CSI 2 J and 3 J count, and their DECSED forms (`?`), which erase the same
 * screen and only spare cells a program protected (review, round 4) — with
 * the normal buffer up: CSI J and CSI 1 J erase
 * part of a screen, and every full-screen program clears its own alternate
 * one — and a reset always does, whichever screen was up: it resets the
 * normal one too. A resize is never a clear: it sends xterm nothing.
 *
 * Every handler runs inside xterm's parser or its write loop, where a throw
 * would stop the terminal parsing for good: none of them throws. Pure: the
 * suites drive it with a headless xterm. A terminal with no parser (a test
 * double) hears changes and no clears.
 */

/** Whether CSI J's parameters ask for the whole screen (2) or the scrollback (3). */
function erasesAll(params) {
  const first = params?.[0];
  const mode = Array.isArray(first) ? first[0] : first;
  return mode === 2 || mode === 3;
}

export function watchScrollbackChanges(term, { changed, cleared, quiet = () => false, warn = (...args) => console.warn(...args) } = {}) {
  // A clear met in the batch being parsed, saved once the batch is.
  let clearing = false;
  const safely = (fn, fallback) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      warn('[Terminal] could not note a change to save:', err);
      return fallback;
    }
  };
  const disposables = [];
  const parser = term.parser;
  if (typeof parser?.registerCsiHandler === 'function') {
    const noteErase = safely((params) => {
      if (term.buffer.active.type === 'normal' && erasesAll(params)) clearing = true;
      return false;
    }, false);
    // ED, and DECSED (`CSI ? Ps J`), its selective form.
    disposables.push(parser.registerCsiHandler({ final: 'J' }, noteErase));
    disposables.push(parser.registerCsiHandler({ prefix: '?', final: 'J' }, noteErase));
  }
  if (typeof parser?.registerEscHandler === 'function') {
    disposables.push(
      parser.registerEscHandler(
        { final: 'c' },
        safely(() => {
          clearing = true;
          return false;
        }, false)
      )
    );
  }
  disposables.push(
    term.onWriteParsed(
      safely(() => {
        const wasCleared = clearing;
        clearing = false;
        if (quiet()) return;
        if (wasCleared) cleared();
        else if (term.buffer.active.type === 'normal') changed();
      })
    ),
    term.buffer.onBufferChange(
      safely(() => {
        if (!quiet()) changed();
      })
    )
  );
  return {
    dispose() {
      for (const disposable of disposables.splice(0)) disposable?.dispose?.();
    },
  };
}
