import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEditorStore } from '../../stores/editorStore.js';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { focusWorkspace } from '../../lib/workspaceFocus.js';

// The editor's two questions — Save / Don't Save / Cancel before files close,
// and "File Changed on Disk" before a save replaces what is there — drawn
// whatever the layout shows.
//
// Files belong to terminal groups (editor placement, sibling B), and the
// editor area is mounted only while the group on screen has an editor leaf.
// These used to be drawn by the editor area, so with a dirty file in another
// group, closing the window, Quit, opening a folder and closing that group
// all waited on a question nobody could see: a window that would not close.
// PanelLayout mounts this always, and it imports no Monaco, so it costs the
// launch nothing (see the note above PanelLayout's lazy EditorPanel).

/**
 * What the Save / Don't Save / Cancel prompt says. Opening another folder
 * also says why it is asking: nothing about choosing a folder suggests that
 * every editor tab is about to close.
 */
function unsavedPromptText({ kind, names }) {
  const many = names.length > 1;
  const reason =
    kind === 'root'
      ? 'Opening another folder closes every editor tab. '
      : kind === 'group'
        ? 'Closing the group closes the editor tabs in it. '
        : '';
  return {
    title: many ? 'Unsaved Changes' : `Save ${names[0]}?`,
    message: many
      ? `${names.join(', ')} have unsaved changes. ${reason}Your changes will be lost if you don't save them.`
      : `${reason}Your changes to ${names[0]} will be lost if you don't save them.`,
    confirmLabel: many ? 'Save All' : 'Save',
  };
}

/**
 * The editor's prompts in the order they opened — `previous`, the order last
 * drawn, with those now closed dropped and those newly `open` added at the
 * end.
 *
 * They share one portal, and the later in it is drawn on top. ConfirmDialog
 * gives the keyboard to the newest; drawn in a fixed order, a window-close
 * prompt that opened while "File Changed on Disk" was showing went under it
 * and still took Enter, Escape and Tab.
 */
export function inOpenOrder(previous, open) {
  return [...previous.filter((key) => open.includes(key)), ...open.filter((key) => !previous.includes(key))];
}

/**
 * What the prompt over a save that would replace the file on disk says.
 *
 * Usually the file has changed since the tab read it, and what is on disk
 * can be taken instead. When it could not be read back at all (`unreadable`)
 * — grown past the 50 MB the editor opens, a log appended to; no longer
 * text; behind a link that leads nowhere — whether it changed cannot be
 * known, and there is no version on disk to take: it says why, and offers
 * only to overwrite or not.
 */
export function overwritePromptText({ fileName, unreadable = null }) {
  if (unreadable == null) {
    return {
      title: 'File Changed on Disk',
      message: `${fileName} has changed on disk since you opened it. Saving now would replace those changes with this tab's version.`,
      altLabel: 'Use Disk Version',
    };
  }
  return {
    title: 'File on Disk Could Not Be Read',
    message: `${fileName} could not be read back to see whether it changed on disk since you opened it: ${String(unreadable).replace(/\.$/, '')}. Saving now would replace whatever is there with this tab's version.`,
    altLabel: null,
  };
}

/**
 * The unsaved and overwrite prompts, or nothing while neither is asked.
 * The group on screen is left as it is while asking: a window close, Quit
 * or folder switch can list files of several groups, and the prompt names
 * every file it is about.
 */
export function EditorPrompts() {
  const pendingClose = useEditorStore((s) => s.pendingClose);
  const cancelPendingClose = useEditorStore((s) => s.cancelPendingClose);
  const discardPendingClose = useEditorStore((s) => s.discardPendingClose);
  const savePendingClose = useEditorStore((s) => s.savePendingClose);
  const pendingOverwrite = useEditorStore((s) => s.pendingOverwrite);
  const cancelPendingOverwrite = useEditorStore((s) => s.cancelPendingOverwrite);
  const confirmPendingOverwrite = useEditorStore((s) => s.confirmPendingOverwrite);
  const reloadFromDisk = useEditorStore((s) => s.reloadFromDisk);

  // Where the keyboard goes when a prompt closes and what had it is gone —
  // the tab's own ✕, which Chromium focuses when it is clicked and which
  // goes with the tab it closed: the file now in front, or the terminal
  // when no file is left open.
  const focusAfterPrompt = () => focusWorkspace('editor');

  const unsavedText = pendingClose ? unsavedPromptText(pendingClose) : null;
  const unsavedPrompt = pendingClose ? (
    <ConfirmDialog
      open
      title={unsavedText.title}
      message={unsavedText.message}
      confirmLabel={unsavedText.confirmLabel}
      altLabel="Don't Save"
      altDanger
      cancelLabel="Cancel"
      onConfirm={() => {
        savePendingClose().catch((err) =>
          console.error('[EditorPrompts] Save before closing failed; nothing was closed:', err)
        );
      }}
      onAlt={() => {
        discardPendingClose().catch((err) =>
          console.error('[EditorPrompts] Closing without saving failed:', err)
        );
      }}
      onCancel={cancelPendingClose}
      fallbackFocus={focusAfterPrompt}
    />
  ) : null;

  const overwriteText = pendingOverwrite ? overwritePromptText(pendingOverwrite) : null;
  const overwritePrompt = pendingOverwrite ? (
    <ConfirmDialog
      open
      title={overwriteText.title}
      message={overwriteText.message}
      confirmLabel="Overwrite"
      danger
      altLabel={overwriteText.altLabel}
      cancelLabel="Cancel"
      onConfirm={() => {
        confirmPendingOverwrite().catch((err) =>
          console.error('[EditorPrompts] Overwrite failed:', err)
        );
      }}
      onAlt={() => {
        reloadFromDisk(pendingOverwrite.tabId).catch((err) =>
          console.error('[EditorPrompts] Reload from disk failed:', err)
        );
      }}
      onCancel={cancelPendingOverwrite}
      fallbackFocus={focusAfterPrompt}
    />
  ) : null;

  // Onto <body>, for the reason EditorPanel's DragPreview is: inside a
  // transformed ancestor a `fixed` overlay is confined to that ancestor's
  // box, and with the terminal panel maximised the editor's box is zero
  // high. The diff view replaces the editor, not the question, so the
  // prompts are drawn over it as well.
  // Drawn in the order they opened: see `inOpenOrder`.
  const promptOrder = useRef([]);
  promptOrder.current = inOpenOrder(
    promptOrder.current,
    [unsavedPrompt && 'unsaved', overwritePrompt && 'overwrite'].filter(Boolean)
  );
  const promptOf = { unsaved: unsavedPrompt, overwrite: overwritePrompt };
  if (!unsavedPrompt && !overwritePrompt) return null;
  return createPortal(
    <>
      {promptOrder.current.map((key) => (
        <React.Fragment key={key}>{promptOf[key]}</React.Fragment>
      ))}
    </>,
    document.body
  );
}

export default EditorPrompts;
