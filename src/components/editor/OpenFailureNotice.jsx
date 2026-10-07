import React from 'react';
import { CircleAlert, X } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';

/**
 * Why the file last asked for did not open.
 *
 * Every way of opening a file — the Explorer, Go to File, a link in a
 * terminal, a search result — ends in `openFile`, and a refusal from the
 * backend went to the console and nowhere else: a click on a 60 MB log, a
 * binary file or a link that leads nowhere did nothing at all, as if it had
 * not been clicked. The backend says why it will not read something
 * (src-tauri/src/fs/mod.rs, read_file), and this puts its words on screen.
 *
 * Over the corner of the window, above the status bar, and not in the
 * editor: with no file open there is no editor on screen to put it in, and
 * a terminal is not pushed about to make room for it. It stays until it is
 * dismissed or a file opens.
 */
export function OpenFailureNotice() {
  const failure = useEditorStore((s) => s.openFailure);
  const dismiss = useEditorStore((s) => s.dismissOpenFailure);
  if (!failure) return null;

  return (
    <div
      role="alert"
      className="fixed right-2 bottom-statusbar mb-2 z-40 w-[400px] max-w-[calc(100vw-16px)] flex items-start gap-2 px-3 py-2 bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] text-ui text-vsc-fg"
    >
      <CircleAlert size={16} className="shrink-0 mt-px text-vsc-error" />
      <div className="min-w-0 flex-1">
        <div className="truncate" title={failure.path}>
          Could not open {failure.fileName}
        </div>
        <div className="text-ui-sm text-vsc-muted break-words">{failure.reason}</div>
      </div>
      <button
        type="button"
        title="Dismiss"
        aria-label="Dismiss"
        // Keep focus where it is (usually the terminal): a button that takes
        // it and then goes, as this one does, leaves the keyboard on the page.
        onMouseDown={(e) => e.preventDefault()}
        onClick={dismiss}
        className="shrink-0 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default OpenFailureNotice;
