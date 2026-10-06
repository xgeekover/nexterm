import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * What a key means to the confirm dialog on top, given whether it was
 * pressed on one of the dialog's buttons:
 *
 *   'pass'      not the dialog's key; left to whatever has focus
 *   'cancel'    Escape, wherever focus is
 *   'next'      Tab: the next button, round from the last to the first
 *   'previous'  Shift+Tab: the other way round
 *   'swallow'   kept from everything, and nothing done
 *
 * Enter on a button belongs to that button, and the native button answers
 * it, so Enter on Cancel cancels. The dialog used to run its confirm action
 * on every Enter and keep the key from the button: Shift+Tab to Cancel, Enter,
 * and the folder was deleted anyway, with no trash to get it back from.
 *
 * An Enter that lands on none of the buttons was aimed at nothing the dialog
 * shows: focus fell to the page when the message was clicked, or something
 * behind the dialog took it. It does nothing. Confirming would delete or
 * overwrite in two of the three callers; moving focus onto the confirm button
 * would leave the next Enter, meant for wherever the user thought they were
 * typing, to do it; letting it through would have a terminal behind the
 * dialog run its line.
 *
 * A key held down from before is not a press. A native button takes each
 * repeat of Enter as a click, and a repeated Space arms it to click on
 * release, so holding the Enter that chose Delete in the Explorer's menu
 * would delete.
 *
 * A key that ends or edits an IME composition (Korean, typed in the terminal
 * behind) belongs to the composition.
 */
export function confirmDialogKey(e, onButton) {
  if (e.isComposing || e.keyCode === 229) return 'pass';
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Tab') {
    // Ctrl+Tab and the like are the app's chords, not focus moves.
    if (e.ctrlKey || e.altKey || e.metaKey) return 'pass';
    return e.shiftKey ? 'previous' : 'next';
  }
  if (e.key === 'Enter') return onButton && !e.repeat ? 'pass' : 'swallow';
  if (e.key === ' ' && e.repeat && onButton) return 'swallow';
  return 'pass';
}

/**
 * The button Tab moves to from button `at` of `count`: the next one, or the
 * previous for Shift+Tab, going round at the ends. From outside the buttons
 * (`at` -1) it is the first, or for Shift+Tab the last. -1 when there are none.
 */
export function nextButton(at, count, backwards) {
  if (count === 0) return -1;
  if (at === -1) return backwards ? count - 1 : 0;
  return (at + (backwards ? count - 1 : 1)) % count;
}

// The dialogs open now, oldest first. Only the newest answers keys. Two are
// open at once when EditorPanel's "Save X?" runs into a change on disk:
// "File Changed on Disk" opens over it, and one Enter used to confirm both,
// a plain save and a forced overwrite racing each other.
const openDialogs = [];

/**
 * VS Code-style modal confirmation. Replaces the native `confirm()` which
 * blocks the whole webview and cannot be styled.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  // Optional third choice, for the "Save / Don't Save / Cancel" shape where
  // neither confirming nor cancelling is the safe default.
  altLabel = null,
  onAlt = null,
  danger = false,
  altDanger = false,
  onConfirm,
  onCancel,
}) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  // Read by the key listener below, which is set up once per opening: the
  // callers pass a new arrow on every render.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Once per opening: the confirm button takes focus and the keys are
  // listened for. This used to run again whenever a callback changed, which
  // meant on every render of the callers, and each run put focus back on the
  // confirm button. The Explorer renders again for every file a build or an
  // agent writes, so focus slid off Cancel by itself.
  useEffect(() => {
    if (!open) return undefined;
    const self = {};
    openDialogs.push(self);
    confirmRef.current?.focus();

    // In the capture phase, ahead of the element the key was aimed at: a
    // terminal behind the dialog must not also get a key the dialog keeps.
    const onKey = (e) => {
      if (openDialogs[openDialogs.length - 1] !== self) return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll('button') ?? []);
      const at = buttons.indexOf(e.target);
      const action = confirmDialogKey(e, at !== -1);
      if (action === 'pass') return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'cancel') onCancelRef.current?.();
      else if (action === 'next' || action === 'previous') {
        buttons[nextButton(at, buttons.length, action === 'previous')]?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      openDialogs.splice(openDialogs.indexOf(self), 1);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[18vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-[440px] max-w-[92vw] bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] text-vsc-fg"
      >
        <div className="h-[35px] px-3 flex items-center justify-between border-b border-vsc-border">
          <h2 id="confirm-dialog-title" className="text-ui font-semibold m-0">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            title="Close"
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-3 py-3 text-ui text-vsc-fg">{message}</div>
        <div className="px-3 pb-3 flex items-center justify-end gap-2">
          {altLabel && (
            <button
              type="button"
              onClick={onAlt}
              className={cn(
                'h-[26px] px-3 text-ui rounded-[3px]',
                altDanger
                  ? 'bg-vsc-button-secondary text-vsc-error hover:bg-vsc-item-hover'
                  : 'bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover'
              )}
            >
              {altLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="h-[26px] px-3 text-ui rounded-[3px] bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              'h-[26px] px-3 text-ui rounded-[3px] text-vsc-accent-fg',
              danger ? 'bg-vsc-error hover:opacity-90' : 'bg-vsc-accent hover:bg-vsc-accent-hover'
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
