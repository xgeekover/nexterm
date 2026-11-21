import React from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { clearAgentHistoryQuestion, useAgentHistoryPromptStore } from '../../stores/agentHistoryPromptStore.js';
import { focusBack } from '../../lib/dialogReturn.js';
import { focusWorkspace } from '../../lib/workspaceFocus.js';

/**
 * The AGENT SESSIONS questions (src/stores/agentHistoryPromptStore.js), each
 * drawn from the prompt's own `question` (title, message, confirmLabel):
 * "Clear Agent Session History?" before the list is emptied, from the side
 * bar's header menu or the palette; "Delete Agent Session?" before a row's
 * Delete…; "Delete Group?" before a group header's Delete Group….
 *
 * The guards of Settings' Clear Saved Scrollback: it cannot be undone, so
 * Cancel has the keyboard and the click that chose it cannot land on Clear.
 * Portaled onto <body> and drawn only while asked, as PasteWarningDialog is,
 * and keyed by the question, so a new one opens with Cancel focused again.
 * Asked from the palette, the keyboard goes back to what had it before the
 * palette; else to the terminal on screen.
 */
export function AgentHistoryClearDialog() {
  const prompt = useAgentHistoryPromptStore((s) => s.prompt);
  const answer = useAgentHistoryPromptStore((s) => s.answer);
  if (!prompt) return null;
  // A prompt without its words (none is made so) gets Clear's, as before.
  const question = prompt.question ?? clearAgentHistoryQuestion(prompt.count);
  const returnTo = prompt.returnTo;
  return createPortal(
    <ConfirmDialog
      key={prompt.id}
      open
      title={question.title}
      message={question.message}
      confirmLabel={question.confirmLabel}
      danger
      initialFocus="cancel"
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
      fallbackFocus={() => focusBack(returnTo, () => focusWorkspace('terminal'))}
    />,
    document.body
  );
}

export default AgentHistoryClearDialog;
