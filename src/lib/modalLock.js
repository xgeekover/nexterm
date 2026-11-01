/**
 * Whether a dialog that must keep the app still is open: the run dialog of
 * a project command and the review that trusts a folder's commands.
 *
 * While one is, the app's own chords and its native menu do nothing. Behind
 * the run dialog ⌘⌥→ made another pane active — the dialog's "This
 * terminal" became another terminal and the next keys went to its shell —
 * ⌘W closed the terminal the line was for, and the menu's Close Pane and New
 * Terminal put a new terminal of the same name where Run then typed. ⌘⇧P and
 * ⌘, opened the palette and Settings under the dialog. Text editing in the
 * dialog's fields is the browser's own (⌘C, ⌘V, ⌘Z, arrows), never a chord
 * of the app's, and the reload guard stays in force (see `findBinding`).
 *
 * A count, not a flag: each dialog holds the lock while it is mounted and
 * lets go of its own hold once, however often it is asked to.
 */
let holds = 0;

/** Hold the lock; returns what lets go of this hold. */
export function holdModal() {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

/** Whether any dialog holds the lock now. */
export function modalHeld() {
  return holds > 0;
}
