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
import { EditorTabs, EditorDragContext, markEditorDragEnded, stripSlotAt } from './EditorTabs.jsx';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { cn } from '../../lib/utils.js';
import { segmentsBelow } from '../../lib/paths.js';
import { focusWorkspace } from '../../lib/workspaceFocus.js';
import { useShortcuts } from '../../hooks/useShortcuts.js';

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
/** How near either end of a tab row a dragged tab starts scrolling it. */
const AUTO_SCROLL_ZONE_PX = 32;
/** Scrolling speed, in px per second, with the pointer at the very end of a row. */
const AUTO_SCROLL_PX_PER_S = 480;
/** Past the end — over the strip's own buttons — it keeps speeding up, to this many times that. */
const AUTO_SCROLL_MAX_FACTOR = 3;

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

/**
 * What a drop at this point would do.
 *
 * Over a pane's BODY, the centre moves the tab into that group and the edges
 * split it. Over a TAB STRIP — its row of chips or its own buttons — the tab
 * goes into that strip at a gap, which is how the order of the tabs is
 * changed at all. `stripSlotAt` picks the gap: before or after the chip under
 * the pointer, counting the dragged chip like any other (it stays in its
 * strip, dimmed, for the whole gesture), which is exactly how
 * `moveEditorTabInStrip` takes it. Only the part of the row that is on screen
 * counts: past the last chip that can be seen — over the buttons of a strip
 * with more tabs than fit, say — the gap is the last one in view, not the end
 * of the strip. The end is reached by scrolling the row, which holding the
 * drag near it does (`createStripAutoScroller`).
 *
 * `doc` is a parameter only so that a test can stand in for the page.
 */
export function dropTargetAtPoint(clientX, clientY, doc = document) {
  const el = doc.elementFromPoint(clientX, clientY);

  const strip = el?.closest?.('[data-editor-tab-strip]');
  if (strip) {
    const row = strip.querySelector('[data-editor-tab-row]') ?? strip;
    const chips = Array.from(strip.querySelectorAll('[data-tab-chip]'), (chip) => chip.getBoundingClientRect());
    return {
      paneId: strip.getAttribute('data-editor-tab-strip'),
      zone: 'tabs',
      index: stripSlotAt(chips, row.getBoundingClientRect(), clientX),
    };
  }

  const body = el?.closest?.('[data-editor-pane-body]');
  if (!body) return null;
  return {
    paneId: body.getAttribute('data-editor-pane-body'),
    zone: zoneFromPoint(body.getBoundingClientRect(), clientX, clientY),
    index: null,
  };
}

/**
 * How fast a tab row should scroll with a dragged tab held at `clientX`, in
 * px per second: negative toward its start, positive toward its end, 0
 * anywhere but near one of them. Within AUTO_SCROLL_ZONE_PX of an end the
 * speed grows in proportion to how near the pointer is, reaching
 * AUTO_SCROLL_PX_PER_S at the end itself, and past the end — over the strip's
 * own buttons — it keeps growing, up to AUTO_SCROLL_MAX_FACTOR times that. A
 * row too narrow for two zones is split between them.
 */
export function stripAutoScrollSpeed(row, clientX) {
  const zone = Math.min(AUTO_SCROLL_ZONE_PX, (row.right - row.left) / 2);
  if (!(zone > 0)) return 0;
  const towardEnd = (clientX - (row.right - zone)) / zone;
  if (towardEnd > 0) return AUTO_SCROLL_PX_PER_S * Math.min(towardEnd, AUTO_SCROLL_MAX_FACTOR);
  const towardStart = (row.left + zone - clientX) / zone;
  if (towardStart > 0) return -AUTO_SCROLL_PX_PER_S * Math.min(towardStart, AUTO_SCROLL_MAX_FACTOR);
  return 0;
}

/**
 * Scrolls a tab strip's row while a dragged tab is held near either end of
 * it, so that every gap of a strip with more tabs than fit can be reached —
 * a drop only ever goes into a gap that is on screen (see `stripSlotAt`).
 *
 * Call `follow(paneId, x)` whenever the pointer moves, with the pane whose
 * strip it is over (null for none), and `stop()` when the gesture ends,
 * however it ends. Between the two it runs at most one requestAnimationFrame
 * loop, which ends by itself as soon as there is nothing to do: the pointer
 * is not near an end, or the row is already as far as it goes. It only
 * scrolls; what is under the pointer is measured again by whoever listens for
 * the row's `scroll` events.
 *
 * `rowOf(paneId)` finds a strip's scrolling row. The frame functions are
 * parameters only so that a test can run the loop on a clock of its own.
 */
export function createStripAutoScroller({
  rowOf,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
}) {
  let pointer = null; // { paneId, x } while the pointer is over a tab strip
  let frame = 0;
  let lastTime = null;
  let owed = 0; // the part of a pixel not scrolled yet

  const idle = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
    lastTime = null;
    owed = 0;
  };

  const tick = (time) => {
    frame = 0;
    const row = pointer ? rowOf(pointer.paneId) : null;
    const speed = row ? stripAutoScrollSpeed(row.getBoundingClientRect(), pointer.x) : 0;
    const from = row ? row.scrollLeft : 0;
    const max = row ? row.scrollWidth - row.clientWidth : 0;
    if (speed === 0 || (speed < 0 ? from <= 0 : from >= max)) {
      idle();
      return;
    }

    // Per second, not per frame — a 120Hz screen scrolls no faster — and a
    // long wait between frames (a hidden window) is not made up in one jump.
    const elapsed = lastTime === null ? 1000 / 60 : Math.min(Math.max(time - lastTime, 0), 50);
    lastTime = time;
    owed += (speed * elapsed) / 1000;
    const step = Math.trunc(owed);
    owed -= step;
    // The next frame is asked for before scrolling, so that anything the
    // scroll sets off before this returns — a `follow` included — finds one
    // already asked for and never starts a second loop.
    frame = requestFrame(tick);
    if (step === 0) return;
    row.scrollLeft = Math.min(Math.max(from + step, 0), max);
    // A row that did not move is as far as it goes.
    if (row.scrollLeft === from) idle();
  };

  return {
    follow(paneId, x) {
      pointer = paneId == null ? null : { paneId, x };
      if (pointer && !frame) frame = requestFrame(tick);
    },
    stop() {
      pointer = null;
      idle();
    },
  };
}

/**
 * Follows one press on a tab chip from pointerdown to release, and returns
 * the function that ends it early: on an unmount, or on a second press while
 * this one is still listening.
 *
 * `onChange(drag)` is handed the drag state whenever it changes, and null
 * once the gesture is over: { tabId, title, startX, startY, x, y, active,
 * targetPaneId, zone, index }, where `zone` is 'tabs' over a tab strip and
 * `index` the gap the pointer is over, or else the body's move/split zone and
 * `index` null. A press only becomes a drag once it has travelled
 * DRAG_THRESHOLD_PX; until then it is a click. `onDrop(drag)` is handed the
 * state a drag was let go in, if that was over somewhere a tab can go — the
 * very state the marker was drawn from.
 *
 * What is under the pointer is measured again whenever anything scrolls, not
 * only when the pointer moves: a row scrolled by the wheel, or by its own
 * auto-scroll (`createStripAutoScroller`), moves its chips under a pointer
 * that stays put, and the gap — and the marker drawn in it — has to go with
 * them, or a release right after drops the tab in a gap the marker has left.
 *
 * Listeners are attached synchronously here rather than from an effect: a
 * quick flick delivers pointermove/up before React has committed anything, so
 * an effect-bound listener would miss the whole gesture. `win`, `doc` and the
 * frame functions are parameters only so that a test can drive a gesture
 * without a browser.
 */
export function trackTabDrag(tab, press, { onChange, onDrop, win = window, doc = document, requestFrame, cancelFrame }) {
  let drag = {
    tabId: tab.id,
    title: tab.fileName,
    startX: press.clientX,
    startY: press.clientY,
    x: press.clientX,
    y: press.clientY,
    active: false,
    targetPaneId: null,
    zone: null,
    index: null,
  };

  const scroller = createStripAutoScroller({
    rowOf: (paneId) => doc.querySelector(`[data-editor-tab-row="${paneId}"]`),
    requestFrame,
    cancelFrame,
  });

  const pointAt = (x, y) => {
    const hit = dropTargetAtPoint(x, y, doc);
    const next = {
      ...drag,
      active: true,
      x,
      y,
      targetPaneId: hit?.paneId ?? null,
      zone: hit?.zone ?? null,
      index: hit?.index ?? null,
    };
    if (!drag.active || ['x', 'y', 'targetPaneId', 'zone', 'index'].some((key) => next[key] !== drag[key])) {
      drag = next;
      onChange(next);
    }
    scroller.follow(next.zone === 'tabs' ? next.targetPaneId : null, x);
  };

  const detach = () => {
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    win.removeEventListener('pointercancel', onCancel);
    win.removeEventListener('scroll', onScroll, true);
    scroller.stop();
  };

  const onMove = (ev) => {
    const travelled = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY);
    if (!drag.active && travelled <= DRAG_THRESHOLD_PX) return;
    pointAt(ev.clientX, ev.clientY);
  };

  // `scroll` does not bubble, so the window hears it in the capture phase.
  // Any element's will do: whatever scrolled, the pointer may be over
  // something else now.
  const onScroll = () => {
    if (drag.active) pointAt(drag.x, drag.y);
  };

  const onUp = () => {
    detach();
    const last = drag;
    onChange(null);
    if (!last.active) return;
    markEditorDragEnded();
    if (last.targetPaneId) onDrop(last);
  };

  const onCancel = () => {
    detach();
    onChange(null);
  };

  onChange(drag);
  win.addEventListener('pointermove', onMove);
  win.addEventListener('pointerup', onUp);
  win.addEventListener('pointercancel', onCancel);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return detach;
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

/**
 * Keep `editor`, a group's Monaco editor, in `ref` for as long as it lives.
 *
 * Each tab a group shows gets an editor of its own (the `key` on <Editor>
 * below), and the one before is disposed. Left in the ref, it was handed the
 * next request meant for the new one — Go to File asking for the keyboard, a
 * terminal link's line — before the new one had mounted: a disposed editor
 * moves no caret and takes no focus, and the request was spent on it.
 * Let go, the request waits for the new editor's `onMount`.
 */
export function holdEditor(ref, editor) {
  ref.current = editor;
  editor.onDidDispose?.(() => {
    if (ref.current === editor) ref.current = null;
  });
}

/**
 * What the Save / Don't Save / Cancel prompt says. Opening another folder
 * also says why it is asking: nothing about choosing a folder suggests that
 * every editor tab is about to close.
 */
function unsavedPromptText({ kind, names }) {
  const many = names.length > 1;
  const reason = kind === 'root' ? 'Opening another folder closes every editor tab. ' : '';
  return {
    title: many ? 'Unsaved Changes' : `Save ${names[0]}?`,
    message: many
      ? `${names.join(', ')} have unsaved changes. ${reason}Your changes will be lost if you don't save them.`
      : `${reason}Your changes to ${names[0]} will be lost if you don't save them.`,
    confirmLabel: many ? 'Save All' : 'Save',
  };
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
 * One editor group (leaf of the split tree): its own tab strip plus the
 * Monaco editor for whichever of *its* tabs is active. Tabs can be dragged
 * along a strip to reorder them, into another group (at a position in its
 * strip, or onto its body), or onto a group's edge to split it.
 */
function EditorPane({ node, onSplitH, onSplitV, onClose, canClose }) {
  const { shortcut } = useShortcuts();
  const monacoOptions = useMonacoOptions();
  const paneId = node.id;
  const tabs = useEditorStore((s) => s.tabs);
  const activeEditorPaneId = useEditorStore((s) => s.activeEditorPaneId);
  const setActiveEditorPane = useEditorStore((s) => s.setActiveEditorPane);
  const editBuffer = useEditorStore((s) => s.editBuffer);
  const saveFile = useEditorStore((s) => s.saveFile);
  const rootPath = useEditorStore((s) => s.rootPath);

  const pendingReveal = useEditorStore((s) => s.pendingReveal);
  const clearReveal = useEditorStore((s) => s.clearReveal);
  const editorRef = useRef(null);

  const { drag } = useContext(EditorDragContext);

  const isActivePane = activeEditorPaneId === paneId;
  // Over this pane's tab strip the strip draws its own marker; the body's
  // overlay is only for the move and split zones.
  const dropZone =
    drag?.active && drag.targetPaneId === paneId && drag.zone !== 'tabs' ? drag.zone : null;

  /**
   * Put the caret where a terminal link asked for, if that link meant the file
   * THIS pane is showing.
   *
   * Every pane runs this, and the first one holding the file wins and clears
   * the request — the same file can be open in two groups, and jumping in both
   * would move a caret the user was not looking at.
   */
  const applyPendingReveal = useCallback(
    (editor, filePath) => {
      const reveal = useEditorStore.getState().pendingReveal;
      if (!editor || !reveal || reveal.filePath !== filePath) return;
      // Only the keyboard was asked for (`focusEditor`): the caret stays.
      if (reveal.line == null) {
        editor.focus();
        clearReveal();
        return;
      }
      const lineCount = editor.getModel()?.getLineCount?.() ?? reveal.line;
      // A stack trace can name a line past the end of a file that has since
      // been edited. Land on the last line rather than refusing to move.
      const line = Math.min(Math.max(1, reveal.line), Math.max(1, lineCount));
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: Math.max(1, reveal.column || 1) });
      editor.focus();
      clearReveal();
    },
    [clearReveal]
  );

  // Only the tabs that belong to this group, in its own order.
  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const activeTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;

  const segments = activeTab ? segmentsBelow(rootPath, activeTab.filePath) : [];

  // Clicking a second link into a file that is already open remounts nothing,
  // so `onMount` never fires again and this is the only thing that moves.
  useEffect(() => {
    if (!pendingReveal || !activeTab) return;
    applyPendingReveal(editorRef.current, activeTab.filePath);
  }, [pendingReveal, activeTab, applyPendingReveal]);

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
                title={`Save (${shortcut('save')})`}
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
              onMount={(editor) => {
                holdEditor(editorRef, editor);
                applyPendingReveal(editor, activeTab.filePath);
              }}
              options={monacoOptions}
            />
            {/* While dragging, swallow pointer events so Monaco cannot eat them. */}
            {drag?.active && <div aria-hidden="true" className="absolute inset-0 z-10" />}
            <DropIndicator zone={dropZone} />
          </div>
        </div>
      ) : (
        <div data-editor-pane-body={paneId} className="relative flex-1 flex flex-col items-center justify-center gap-2 text-ui-sm text-vsc-muted select-none">
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
  const moveEditorTabInStrip = useEditorStore((s) => s.moveEditorTabInStrip);

  // null while idle; while a tab is dragged, the state `trackTabDrag` reports.
  const [drag, setDrag] = useState(null);
  const cleanupRef = useRef(null);

  const beginDrag = useCallback(
    (tab, e) => {
      // A press while an earlier gesture is still listening — its release
      // went somewhere the window never heard — starts over, rather than
      // leaving that gesture's listeners and scrolling at work beside this one.
      cleanupRef.current?.();
      cleanupRef.current = trackTabDrag(tab, e, {
        onChange: setDrag,
        onDrop: (cur) => {
          if (cur.zone === 'tabs') {
            moveEditorTabInStrip(cur.tabId, cur.targetPaneId, cur.index);
          } else {
            dropEditorTabOnPane(cur.tabId, cur.targetPaneId, cur.zone || 'center');
          }
        },
      });
    },
    [dropEditorTabOnPane, moveEditorTabInStrip]
  );

  // Never leave listeners, or a strip still scrolling, behind if the editor
  // unmounts mid-gesture.
  useEffect(() => () => cleanupRef.current?.(), []);

  const handleSplit = useCallback((paneId, direction) => {
    splitEditorPane(paneId, direction);
  }, [splitEditorPane]);

  const handleClose = useCallback((paneId) => {
    requestCloseEditorPane(paneId);
  }, [requestCloseEditorPane]);

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
          console.error('[EditorPanel] Save before closing failed; nothing was closed:', err)
        );
      }}
      onAlt={() => {
        discardPendingClose().catch((err) =>
          console.error('[EditorPanel] Closing without saving failed:', err)
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
          console.error('[EditorPanel] Overwrite failed:', err)
        );
      }}
      onAlt={() => {
        reloadFromDisk(pendingOverwrite.tabId).catch((err) =>
          console.error('[EditorPanel] Reload from disk failed:', err)
        );
      }}
      onCancel={cancelPendingOverwrite}
      fallbackFocus={focusAfterPrompt}
    />
  ) : null;

  // Onto <body>, for the reason DragPreview is: inside this panel's
  // transformed ancestor a `fixed` overlay is confined to the editor's own
  // box. Closing the window and opening a folder ask here too, and with the
  // terminal panel maximised that box is zero high: a prompt nobody can see
  // is a window that will not close. The diff view replaces the editor, not
  // the question, so the prompts are drawn over it as well.
  // Drawn in the order they opened: see `inOpenOrder`.
  const promptOrder = useRef([]);
  promptOrder.current = inOpenOrder(
    promptOrder.current,
    [unsavedPrompt && 'unsaved', overwritePrompt && 'overwrite'].filter(Boolean)
  );
  const promptOf = { unsaved: unsavedPrompt, overwrite: overwritePrompt };
  const prompts =
    unsavedPrompt || overwritePrompt
      ? createPortal(
          <>
            {promptOrder.current.map((key) => (
              <React.Fragment key={key}>{promptOf[key]}</React.Fragment>
            ))}
          </>,
          document.body
        )
      : null;

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
      {prompts}
    </EditorDragContext.Provider>
  );
}

export default EditorPanel;
