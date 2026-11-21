import React, { Suspense, lazy } from 'react';
import { ChevronRight } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { PaneFrame } from '../terminal/AttentionIndicators.jsx';
import { EditorTabs } from './EditorTabs.jsx';
import { cn } from '../../lib/utils.js';
import { segmentsBelow } from '../../lib/paths.js';
import { useShortcuts } from '../../hooks/useShortcuts.js';

/*
 * One editor pane of the workbench (editor placement, sibling C, FC2): drawn
 * by TerminalSplitContainer's SplitNode for an editor leaf, wherever in the
 * group's tree that leaf is — beside a terminal, above it, under it.
 *
 * This module is loaded with the workbench and imports no Monaco: the frame,
 * the tab strip, the breadcrumb and the `data-editor-pane-body` box a drop is
 * aimed at are drawn at once, and only the Monaco editor inside the body
 * arrives later, from EditorPanel.jsx through `React.lazy`. Monaco is the
 * largest part of the app's JavaScript and stays out of the first chunk
 * (PanelLayout used to load the whole editor area this way).
 */
const EditorBody = lazy(() => import('./EditorPanel.jsx'));

/**
 * Whether a press makes the pane it lands in the active one — and so its
 * shown tab what Save writes. Only the main button: a middle-click closes a
 * tab in another group without the focus leaving the one being typed in, and
 * it made that group active all the same, so the next Ctrl+S saved a file the
 * user was not editing and left the edited one unsaved.
 */
export function pressActivatesGroup(e) {
  return e?.button === 0;
}

/**
 * One editor leaf: its own tab strip plus, in its body, the Monaco editor for
 * whichever of *its* tabs is active, or "No file open". Tabs are dragged
 * through the workbench's one drag (TerminalSplitContainer.jsx).
 *
 * - `showActiveLine`: draw the active line, decided by the workbench with the
 *   terminal's rule (FC6): this is THE active pane, more than one pane is on
 *   screen, and the group is not zoomed. The same `PaneFrame` draws it, so
 *   exactly one active line is ever on screen across both kinds.
 * - `headerExtra`: the workbench's controls for this pane (its zoom).
 * - `bodyOverlay`: what the workbench lays over the body while a tab is
 *   dragged: a sheet that keeps Monaco from eating the pointer, and the drop
 *   indicator.
 */
export function EditorPane({ node, canClose = false, showActiveLine = false, headerExtra = null, bodyOverlay = null }) {
  const { shortcut } = useShortcuts();
  const paneId = node.id;
  const tabs = useEditorStore((s) => s.tabs);
  const setActiveEditorPane = useEditorStore((s) => s.setActiveEditorPane);
  const splitEditorPane = useEditorStore((s) => s.splitEditorPane);
  const requestCloseEditorPane = useEditorStore((s) => s.requestCloseEditorPane);
  const saveFile = useEditorStore((s) => s.saveFile);
  const rootPath = useEditorStore((s) => s.rootPath);

  // Only the tabs that belong to this pane, in its own order.
  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const activeTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;
  const segments = activeTab ? segmentsBelow(rootPath, activeTab.filePath) : [];

  return (
    <div
      onMouseDown={(e) => {
        if (pressActivatesGroup(e)) setActiveEditorPane(paneId);
      }}
      onFocusCapture={() => setActiveEditorPane(paneId)}
      // Which pane is active is drawn in the body's frame (`PaneFrame`), as a
      // terminal pane's is — not as a ring on this box, which was always on.
      className="flex flex-col h-full w-full bg-vsc-editor overflow-hidden"
    >
      <EditorTabs
        node={node}
        onSplitH={() => splitEditorPane(paneId, 'horizontal')}
        onSplitV={() => splitEditorPane(paneId, 'vertical')}
        onClose={() => requestCloseEditorPane(paneId)}
        canClose={canClose}
        extra={headerExtra}
      />

      {activeTab ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Breadcrumb row */}
          <div className="flex items-center justify-between h-[22px] px-3 border-b border-vsc-border bg-vsc-editor text-ui-sm text-vsc-muted select-none shrink-0">
            <div className="flex items-center gap-1 min-w-0 overflow-hidden">
              {segments.map((seg, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <ChevronRight size={12} className="shrink-0" />}
                  <span className={cn('truncate', i === segments.length - 1 && 'text-vsc-fg')}>{seg}</span>
                </React.Fragment>
              ))}
            </div>

            {activeTab.isDirty && (
              <button
                type="button"
                onClick={() => saveFile(activeTab.id)}
                className="shrink-0 ml-2 text-vsc-link hover:underline"
                title={`Save (${shortcut('save')})`}
              >
                Save
              </button>
            )}
          </div>

          {/* The drop target is drawn at once; Monaco arrives inside it. */}
          <div data-editor-pane-body={paneId} className="relative flex-1 overflow-hidden">
            <Suspense fallback={null}>
              <EditorBody activeTab={activeTab} paneId={paneId} />
            </Suspense>
            <PaneFrame active={showActiveLine} />
            {bodyOverlay}
          </div>
        </div>
      ) : (
        <div
          data-editor-pane-body={paneId}
          // Focusable from code only: Focus Next Pane landing here takes the
          // keyboard out of the terminal it was in (workspaceFocus.js), so
          // keys typed next reach no shell (C1 review M-01).
          tabIndex={-1}
          className="relative flex-1 flex flex-col items-center justify-center gap-2 text-ui-sm text-vsc-muted select-none outline-none"
        >
          {/* "No file open" on its own is a statement, not help. The two ways
              to put a file here are named, and the shortcut is read from the
              bindings rather than written beside them — the same rule the
              menus follow, so a rebind cannot leave this printing a dead key. */}
          <p className="m-0">No file open</p>
          <p className="m-0 text-center">
            Pick one in the Explorer, or press{' '}
            <kbd className="px-1 py-0.5 rounded-sm bg-vsc-button-secondary text-vsc-fg font-mono">
              {shortcut('quick-open')}
            </kbd>
          </p>
          <PaneFrame active={showActiveLine} />
          {bodyOverlay}
        </div>
      )}
    </div>
  );
}

export default EditorPane;
