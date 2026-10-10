import React from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { usePastePromptStore } from '../../stores/pastePromptStore.js';
import { pastePromptMessage, pastePromptTitle } from '../../lib/pasteWarning.js';
import { focusWorkspace } from '../../lib/workspaceFocus.js';

/**
 * "Paste N lines?" — asked before several lines go into a program that would
 * run each one as it arrives (src/lib/pasteWarning.js, which also says why).
 *
 * Paste sends the text as it was copied, Paste as One Line with its line
 * breaks made spaces, Cancel nothing. Cancel has the keyboard when it opens.
 * After a paste the terminal has the keyboard; after Cancel, whatever had it
 * before the paste — the binding sees to both.
 *
 * Portaled onto <body> like the Explorer's and the editor's dialogs, so no
 * panel's transform can clip it, and drawn only while a question is up: the
 * render suite draws the app with renderToString, which cannot draw a portal.
 * Keyed by the question, so a new one (a second paste from outside the modal
 * dialog) opens as a new dialog, its first button focused again.
 */
export function PasteWarningDialog() {
  const prompt = usePastePromptStore((s) => s.prompt);
  const answer = usePastePromptStore((s) => s.answer);
  if (!prompt) return null;
  return createPortal(
    <ConfirmDialog
      key={prompt.id}
      open
      title={pastePromptTitle(prompt.lines)}
      message={pastePromptMessage(prompt)}
      confirmLabel="Paste"
      altLabel="Paste as One Line"
      // Cancel first: Ctrl+V and then Enter out of habit must not paste
      // what the question is about.
      initialFocus="cancel"
      onAlt={() => answer('oneLine')}
      onConfirm={() => answer('paste')}
      onCancel={() => answer('cancel')}
      fallbackFocus={() => focusWorkspace('terminal')}
    />,
    document.body
  );
}

export default PasteWarningDialog;
