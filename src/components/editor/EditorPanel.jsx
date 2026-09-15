import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Panel, Group, Separator } from 'react-resizable-panels';
import Editor from '@monaco-editor/react';
// Monaco itself, its workers and its themes arrive with this panel rather than
// with the app: imported from main.jsx they were part of the JavaScript every
// launch loaded before anyone had opened a file. PanelLayout loads this module
// lazily.
import '../../lib/monaco.js';
import { ChevronRight, FileCode2 } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { EditorTabs, EditorDragContext, markEditorDragEnded } from './EditorTabs.jsx';
import { DiffViewer } from './DiffViewer.jsx';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

// The app is dark-only (light mode was removed from settingsStore), so the
// Monaco theme is a fixed constant instead of a live settingsStore read.
const MONACO_THEME = 'nexterm-dark';

// Everything here is fixed; the four the Settings window offers are merged in
// per render by `useMonacoOptions`. They used to be hardcoded HERE, so Font
// Size, Tab Size, Word Wrap and Minimap changed the settings window and
// nothing else.
const MONACO_OPTIONS = {
  fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace',
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  bracketPairColorization: { enabled: true },
  padding: { top: 8 },
  automaticLayout: true,
};

/** MONACO_OPTIONS plus the four settings the user can actually change. */
function useMonacoOptions() {
  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const tabSize = useSettingsStore((s) => s.editorTabSize);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const minimap = useSettingsStore((s) => s.editorMinimap);
  return useMemo(
    () => ({
      ...MONACO_OPTIONS,
      fontSize,
      lineHeight: Math.round(fontSize * 1.5),
      tabSize,
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: minimap },
    }),
    [fontSize, tabSize, wordWrap, minimap]
  );
}

/** Pointer travel before a press turns into a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How deep into a pane counts as an edge (split) rather than the centre (move). */
const EDGE_FRACTION = 0.25;

/**
 * Dragging is done with pointer events rather than HTML5 drag & drop — same
 * reasoning as TerminalSplitContainer.jsx: WKWebView (what Tauri uses on
 * macOS) refuses to start a native drag on an element inside a
 * `user-select: none` subtree, which the tab strip is. Pointer events behave
 * the same in every webview and let us draw our own preview and drop zones.
 */

/** Which edge (or the centre) of a rect the point is in. */
function zoneFromPoint(rect, clientX, clientY) {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const candidates = [
    { zone: 'left', d: x },
    { zone: 'right', d: 1 - x },
    { zone: 'top', d: y },
    { zone: 'bottom', d: 1 - y },
  ].sort((a, b) => a.d - b.d);
  return candidates[0].d < EDGE_FRACTION ? candidates[0].zone : 'center';
}

/** Resolve the editor pane body under the pointer, if any. */
function paneAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const body = el?.closest?.('[data-editor-pane-body]');
  if (!body) return null;
  return { paneId: body.getAttribute('data-editor-pane-body'), rect: body.getBoundingClientRect() };
}

/** Translucent overlay showing where the dropped tab will land. */
function DropIndicator({ zone }) {
  if (!zone) return null;
  const box = {
    center: 'inset-0',
    left: 'left-0 top-0 bottom-0 w-1/2',
    right: 'right-0 top-0 bottom-0 w-1/2',
    top: 'left-0 right-0 top-0 h-1/2',
    bottom: 'left-0 right-0 bottom-0 h-1/2',
  }[zone];
  return (
    <div
      aria-hidden="true"
      className={cn(
        'absolute z-20 pointer-events-none border border-vsc-focus',
        'bg-[color-mix(in_srgb,var(--vsc-accent)_18%,transparent)]',
        box
      )}
    />
  );
}

/**
 * The chip that follows the cursor while dragging. Portaled straight onto
 * <body> — this pane is a descendant of a panel that keeps a permanent
 * non-`none` `transform` on itself after its mount animation finishes
 * (`.animate-panel-in` + `animation-fill-mode: both`, see index.css), which
 * makes that panel the containing block for `position: fixed` descendants
 * and would otherwise offset this chip away from the actual cursor.
 */
function DragPreview({ drag }) {
  if (!drag?.active) return null;
  return createPortal(
    <div
      aria-hidden="true"
      className="fixed z-50 pointer-events-none flex items-center gap-1 px-2 h-[22px] rounded-sm text-ui-sm
                 bg-vsc-tab-active text-vsc-tab-active-fg border border-vsc-focus shadow-widget"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      <FileCode2 size={12} />
      <span className="truncate max-w-[140px]">{drag.title}</span>
    </div>,
    document.body
  );
}

/** Breadcrumb segments = file path relative to the workspace root. */
function relativeSegments(filePath, rootPath) {
  const base = (rootPath || '').replace(/\/+$/, '');
  let relativePath = base && filePath.startsWith(base) ? filePath.slice(base.length) : filePath;
  relativePath = relativePath.replace(/^\/+/, '');
  return relativePath ? relativePath.split('/').filter(Boolean) : [];
}

/**
 * One editor group (leaf of the split tree): its own tab strip plus the
 * Monaco editor for whichever of *its* tabs is active. Tabs can be dragged
 * between groups, or onto a group's edge to split it.
 */
function EditorPane({ node, onSplitH, onSplitV, onClose, canClose }) {
  const monacoOptions = useMonacoOptions();
  const paneId = node.id;
  const tabs = useEditorStore((s) => s.tabs);
  const activeEditorPaneId = useEditorStore((s) => s.activeEditorPaneId);
  const setActiveEditorPane = useEditorStore((s) => s.setActiveEditorPane);
  const editBuffer = useEditorStore((s) => s.editBuffer);
  const saveFile = useEditorStore((s) => s.saveFile);
  const rootPath = useEditorStore((s) => s.rootPath);

  const { drag } = useContext(EditorDragContext);

  const isActivePane = activeEditorPaneId === paneId;
  const dropZone = drag?.active && drag.targetPaneId === paneId ? drag.zone : null;

  // Only the tabs that belong to this group, in its own order.
  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const activeTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;

  const segments = activeTab ? relativeSegments(activeTab.filePath, rootPath) : [];

  return (
    <div
      onMouseDown={() => setActiveEditorPane(paneId)}
      onFocusCapture={() => setActiveEditorPane(paneId)}
      className={cn(
        'flex flex-col h-full w-full bg-vsc-editor overflow-hidden',
        isActivePane && 'ring-1 ring-inset ring-vsc-focus'
      )}
    >
      <EditorTabs node={node} onSplitH={onSplitH} onSplitV={onSplitV} onClose={onClose} canClose={canClose} />

      {activeTab ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Breadcrumb row */}
          <div className="flex items-center justify-between h-[22px] px-3 border-b border-vsc-border bg-vsc-editor text-ui-sm text-vsc-muted select-none shrink-0">
            <div className="flex items-center gap-1 min-w-0 overflow-hidden">
              {segments.map((seg, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <ChevronRight size={12} className="shrink-0" />}
                  <span className={cn('truncate', i === segments.length - 1 && 'text-vsc-fg')}>
                    {seg}
                  </span>
                </React.Fragment>
              ))}
            </div>

            {activeTab.isDirty && (
              <button
                type="button"
                onClick={() => saveFile(activeTab.id)}
                className="shrink-0 ml-2 text-vsc-link hover:underline"
                title={`Save (${chord('mod', 's')})`}
              >
                Save
              </button>
            )}
          </div>

          {/* Monaco Editor — one instance per visible group, keyed by that
              group's active tab path. Remounting on tab switch is cheap and
              lossless: @monaco-editor/react caches text models by `path` at
              module scope, so moving a tab between groups (or switching back
              to it) reuses its model — undo history, scroll position, and
              all — instead of losing it. */}
          <div data-editor-pane-body={paneId} className="relative flex-1 overflow-hidden">
            <Editor
              key={activeTab.filePath}
              path={activeTab.filePath}
              height="100%"
              language={activeTab.language || 'javascript'}
              theme={MONACO_THEME}
              value={activeTab.content}
              onChange={(value) => editBuffer(activeTab.id, value ?? '')}
              options={monacoOptions}
            />
            {/* While dragging, swallow pointer events so Monaco cannot eat them. */}
            {drag?.active && <div aria-hidden="true" className="absolute inset-0 z-10" />}
            <DropIndicator zone={dropZone} />
          </div>
        </div>
      ) : (
        <div data-editor-pane-body={paneId} className="relative flex-1 flex items-center justify-center text-ui-sm text-vsc-muted select-none">
          No file open
          {drag?.active && <div aria-hidden="true" className="absolute inset-0 z-10" />}
          <DropIndicator zone={dropZone} />
        </div>
      )}
    </div>
  );
}

/**
 * Recursively renders the split tree: a "leaf" is an editor group, a "split"
 * is a resizable row/column of children.
 */
function SplitNode({ node, onSplit, onClose, canClose }) {
  if (node.type === 'leaf') {
    return (
      <EditorPane
        node={node}
        onSplitH={() => onSplit(node.id, 'horizontal')}
        onSplitV={() => onSplit(node.id, 'vertical')}
        onClose={() => onClose(node.id)}
        canClose={canClose}
      />
    );
  }

  const direction = node.direction; // 'horizontal' | 'vertical'
  return (
    <Group orientation={direction} className="h-full w-full">
      {node.children.map((child, i) => (
        <React.Fragment key={child.id}>
          {i > 0 && <Separator className={direction === 'horizontal' ? 'w-px' : 'h-px'} />}
          <Panel minSize="15" defaultSize={String(100 / node.children.length)}>
            <SplitNode node={child} onSplit={onSplit} onClose={onClose} canClose={true} />
          </Panel>
        </React.Fragment>
      ))}
    </Group>
  );
}

/**
 * Top-level container for the editor split system. Owns the drag gesture so
 * every pane can render the drop indicator for the pointer's current target
 * — mirrors TerminalSplitContainer.jsx exactly (see its comments for the
 * WKWebView/pointer-events rationale).
 */
export function EditorPanel() {
  const diffView = useEditorStore((s) => s.diffView);
  const editorSplitTree = useEditorStore((s) => s.editorSplitTree);
  const splitEditorPane = useEditorStore((s) => s.splitEditorPane);
  const requestCloseEditorPane = useEditorStore((s) => s.requestCloseEditorPane);
  const pendingClose = useEditorStore((s) => s.pendingClose);
  const cancelPendingClose = useEditorStore((s) => s.cancelPendingClose);
  const discardPendingClose = useEditorStore((s) => s.discardPendingClose);
  const savePendingClose = useEditorStore((s) => s.savePendingClose);
  const pendingOverwrite = useEditorStore((s) => s.pendingOverwrite);
  const cancelPendingOverwrite = useEditorStore((s) => s.cancelPendingOverwrite);
  const confirmPendingOverwrite = useEditorStore((s) => s.confirmPendingOverwrite);
  const reloadFromDisk = useEditorStore((s) => s.reloadFromDisk);
  const dropEditorTabOnPane = useEditorStore((s) => s.dropEditorTabOnPane);

  // null while idle; { tabId, title, startX, startY, x, y, active, targetPaneId, zone }
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const cleanupRef = useRef(null);

  /**
   * Listeners are attached synchronously here rather than from an effect: a
   * quick flick delivers pointermove/up before React has committed the state
   * change, so an effect-bound listener would miss the whole gesture.
   */
  const beginDrag = useCallback(
    (tab, e) => {
      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        cleanupRef.current = null;
      };

      const onMove = (ev) => {
        const cur = dragRef.current;
        if (!cur) return;
        const movedEnough =
          cur.active ||
          Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY) > DRAG_THRESHOLD_PX;
        if (!movedEnough) return;

        const hit = paneAtPoint(ev.clientX, ev.clientY);
        const next = {
          ...cur,
          active: true,
          x: ev.clientX,
          y: ev.clientY,
          targetPaneId: hit?.paneId ?? null,
          zone: hit ? zoneFromPoint(hit.rect, ev.clientX, ev.clientY) : null,
        };
        dragRef.current = next;
        setDrag(next);
      };

      const onUp = () => {
        const cur = dragRef.current;
        detach();
        dragRef.current = null;
        setDrag(null);
        if (cur?.active) markEditorDragEnded();
        if (!cur?.active || !cur.targetPaneId) return;
        dropEditorTabOnPane(cur.tabId, cur.targetPaneId, cur.zone || 'center');
      };

      const onCancel = () => {
        detach();
        dragRef.current = null;
        setDrag(null);
      };

      const started = {
        tabId: tab.id,
        title: tab.fileName,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        targetPaneId: null,
        zone: null,
      };
      dragRef.current = started;
      setDrag(started);

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      cleanupRef.current = detach;
    },
    [dropEditorTabOnPane]
  );

  // Never leave listeners behind if the editor unmounts mid-gesture.
  useEffect(() => () => cleanupRef.current?.(), []);

  const handleSplit = useCallback((paneId, direction) => {
    splitEditorPane(paneId, direction);
  }, [splitEditorPane]);

  const handleClose = useCallback((paneId) => {
    requestCloseEditorPane(paneId);
  }, [requestCloseEditorPane]);

  const unsavedPrompt = pendingClose ? (
    <ConfirmDialog
      open
      title={pendingClose.names.length > 1 ? 'Unsaved Changes' : `Save ${pendingClose.names[0]}?`}
      message={
        pendingClose.names.length > 1
          ? `${pendingClose.names.join(', ')} have unsaved changes. Your changes will be lost if you don't save them.`
          : `Your changes to ${pendingClose.names[0]} will be lost if you don't save them.`
      }
      confirmLabel="Save"
      altLabel="Don't Save"
      altDanger
      cancelLabel="Cancel"
      onConfirm={() => {
        savePendingClose().catch((err) =>
          console.error('[EditorPanel] Save before close failed; keeping the tab open:', err)
        );
      }}
      onAlt={discardPendingClose}
      onCancel={cancelPendingClose}
    />
  ) : null;

  const overwritePrompt = pendingOverwrite ? (
    <ConfirmDialog
      open
      title="File Changed on Disk"
      message={`${pendingOverwrite.fileName} has changed on disk since you opened it. Saving now would replace those changes with this tab's version.`}
      confirmLabel="Overwrite"
      danger
      altLabel="Use Disk Version"
      cancelLabel="Cancel"
      onConfirm={() => {
        confirmPendingOverwrite().catch((err) =>
          console.error('[EditorPanel] Overwrite failed:', err)
        );
      }}
      onAlt={() => {
        reloadFromDisk(pendingOverwrite.tabId).catch((err) =>
          console.error('[EditorPanel] Reload from disk failed:', err)
        );
      }}
      onCancel={cancelPendingOverwrite}
    />
  ) : null;

  if (diffView && diffView.open) {
    return <DiffViewer />;
  }

  if (!editorSplitTree) return null;

  const canClose = editorSplitTree.type !== 'leaf';

  return (
    <EditorDragContext.Provider value={{ drag, beginDrag }}>
      <div className={cn('h-full w-full flex flex-col overflow-hidden bg-vsc-editor', drag?.active && 'cursor-grabbing')}>
        <div className="flex-1 overflow-hidden">
          <SplitNode node={editorSplitTree} onSplit={handleSplit} onClose={handleClose} canClose={canClose} />
        </div>
        <DragPreview drag={drag} />
      </div>
      {unsavedPrompt}
      {overwritePrompt}
    </EditorDragContext.Provider>
  );
}

export default EditorPanel;
