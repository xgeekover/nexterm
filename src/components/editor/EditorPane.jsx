import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Eye } from 'lucide-react';
import { PREVIEW_FOLLOW_MS, isMarkdownPath, markdownFields, markdownSourceOf, useEditorStore } from '../../stores/editorStore.js';
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

/*
 * A preview tab (Orca bundle 5) shows its file rather than edit it, and is
 * drawn by a body of its own in place of Monaco, chosen by the tab's `kind`
 * (editorStore.js): no kind is a text tab, Monaco as before. Each of those
 * bodies is lazy as Monaco is, so that neither enters the first chunk either
 * (WV-06 checks that nothing imports them statically).
 */
const ImageBody = lazy(() => import('./ImagePreview.jsx'));
// The Markdown preview's renderer and its worker come with it, never before.
const MarkdownBody = lazy(() => import('./MarkdownPreview.jsx'));

/** Whether `tab` is a preview tab — any tab with a `kind` (editorStore.js `isPreviewTab`). */
function isPreview(tab) {
  return tab?.kind != null;
}

/**
 * `text` as it was when it last stopped changing for `delayMs`: a trailing
 * debounce, so a burst of edits is one update, `delayMs` after the last of
 * them, and nothing comes before. Null while `text` is null. A text that
 * appears (null before) is passed on as it is, and one that goes at once:
 * only changes wait.
 */
export function useSettledText(text, delayMs = PREVIEW_FOLLOW_MS) {
  const [settled, setSettled] = useState(text);
  // React's own pattern for state that follows a prop: set while rendering, drawn again before anything is shown.
  if (text === null && settled !== null) setSettled(null);
  if (text !== null && settled === null) setSettled(text);
  useEffect(() => {
    if (text === null || settled === null || text === settled) return undefined;
    const timer = setTimeout(() => setSettled(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, settled, delayMs]);
  return text === null ? null : (settled ?? text);
}

/**
 * The body of Markdown preview `tab` (F-B3-7, the human's decision
 * 2026-11-24). While the text tab of its file is open, the preview shows
 * that tab's buffer, unsaved edits and all, `PREVIEW_FOLLOW_MS` after the
 * last edit (`useSettledText`); the buffer is measured first, in UTF-8
 * bytes, and past `MARKDOWN_PREVIEW_MAX_BYTES` it goes nowhere and the
 * preview says it is too large (`markdownFields`). With no text tab open it
 * shows the tab's own text, which the store keeps to the disk (`followDisk`)
 * — and which, when the text tab closes, is the file as the editor last read
 * or wrote it, never the buffer (`previewsOffSource`).
 */
export function MarkdownPaneBody({ tab }) {
  const buffer = useEditorStore((s) => {
    const source = markdownSourceOf(s.tabs, tab.filePath);
    if (!source) return null;
    return typeof source.content === 'string' ? source.content : '';
  });
  const settled = useSettledText(buffer);
  const live = useMemo(() => (settled === null ? null : markdownFields(settled)), [settled]);
  const shown = useMemo(() => (live ? { ...tab, ...live } : tab), [tab, live]);
  if (!live) return <MarkdownBody tab={tab} />;
  return <MarkdownBody tab={shown} text={live.text} />;
}

/** What a kind this build does not know shows: that it cannot, and no Monaco. */
function PreviewPlaceholder({ tab }) {
  return (
    <div
      data-preview-placeholder={tab.kind}
      className="absolute inset-0 flex items-center justify-center text-ui-sm text-vsc-muted select-none"
    >
      This tab cannot be shown
    </div>
  );
}

/** The body of `activeTab`, by its kind: Monaco for a text tab, the picture for an image, the rendered document for Markdown. */
function PaneBody({ activeTab, paneId }) {
  if (!isPreview(activeTab)) return <EditorBody activeTab={activeTab} paneId={paneId} />;
  // Keyed by the tab: another image in the same pane starts at Fit again,
  // and another Markdown preview with a renderer of its own.
  if (activeTab.kind === 'image') return <ImageBody key={activeTab.id} tab={activeTab} />;
  if (activeTab.kind === 'markdown') return <MarkdownPaneBody key={activeTab.id} tab={activeTab} />;
  return <PreviewPlaceholder tab={activeTab} />;
}

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
 * whichever of *its* tabs is active — or that tab's preview — or "No file
 * open". Tabs are dragged through the workbench's one drag
 * (TerminalSplitContainer.jsx).
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
  const openMarkdownPreview = useEditorStore((s) => s.openMarkdownPreview);
  const rootPath = useEditorStore((s) => s.rootPath);

  // Only the tabs that belong to this pane, in its own order.
  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const activeTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;
  const segments = activeTab ? segmentsBelow(rootPath, activeTab.filePath) : [];
  const preview = isPreview(activeTab);
  // Open Preview (F-B3-8): on a Markdown file's text tab only — not on its preview, an image or any other file.
  const canPreview = Boolean(activeTab) && !preview && isMarkdownPath(activeTab.filePath);

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

            <div className="flex items-center gap-1 shrink-0">
              {/* The rendered file in a tab to the right of this one
                  (`openMarkdownPreview`); no key of its own (the human's
                  decision). A file that will not read says why in the
                  store's notice. */}
              {canPreview && (
                <button
                  type="button"
                  data-open-markdown-preview=""
                  onClick={() => {
                    Promise.resolve(openMarkdownPreview?.(activeTab.filePath)).catch(() => {});
                  }}
                  className="ml-2 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors"
                  title="Open Preview"
                  aria-label="Open Preview"
                >
                  <Eye size={14} />
                </button>
              )}

              {/* A preview tab has nothing to save (editorStore.js never writes one). */}
              {activeTab.isDirty && !preview && (
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
          </div>

          {/* The drop target is drawn at once; Monaco, or a preview, arrives
              inside it. A preview's box takes the keyboard from code, as the
              empty pane's does: no editor is there to take it
              (workspaceFocus.js `focusEditorPane`). */}
          <div
            data-editor-pane-body={paneId}
            data-preview={preview ? activeTab.kind : undefined}
            tabIndex={preview ? -1 : undefined}
            className={cn('relative flex-1 overflow-hidden', preview && 'outline-none')}
          >
            <Suspense fallback={null}>
              <PaneBody activeTab={activeTab} paneId={paneId} />
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
