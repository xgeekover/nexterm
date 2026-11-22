import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useSettingsStore, viewsIn, shownView } from '../../stores/settingsStore.js';
import { TerminalSplitContainer } from '../terminal/index.js';
import { TerminalsPanel } from '../terminal/index.js';
import { FileExplorer } from '../explorer/FileExplorer.jsx';
import { SearchPanel } from '../search/SearchPanel.jsx';
// Not lazy: the unsaved and overwrite prompts must be drawn whatever the group
// on screen holds, and this imports no Monaco.
import { EditorPrompts } from '../editor/EditorPrompts.jsx';
import { GripVertical, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { installSeparatorFocusRelease } from '../../lib/separatorFocus.js';
import { useEdgeFade } from '../../hooks/useEdgeFade.js';

// There is no editor area here any more (editor placement, sibling C, FC4):
// files open in editor panes inside the workbench, the `terminal` view, among
// its terminals. Monaco, the largest part of the app's JavaScript, still loads
// the first time a file is shown and not at launch: the editor pane
// (EditorPane.jsx) loads it lazily for its body.
//
// Measured (2026-09-18, production build, Chrome), because `dist/assets` is
// 15 MB and that number invites someone to "fix" it:
//
//   launch         2 files, 229 KB, first paint at 160 ms
//   first file     4 more files, ~1.1 MB — the Monaco chunk, one language, one worker
//
// So the 15 MB is INSTALL size, not start-up cost: nothing here is on the
// launch path, and Monaco fetches a language's worker only when a file of that
// language is opened (`ts.worker` is 6.7 MB of the total and a session that
// never opens TypeScript never sees it). Trimming languages would cut the
// download at the price of highlighting in files this app exists to open —
// there is nothing to win here, which is why this comment exists rather than a
// build-config change.

const panelButton =
  'w-6 h-6 flex items-center justify-center rounded text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover active:bg-vsc-item-active transition-colors';

// Regions/panels fade+scale in and out over this long (150-200ms, ease-out —
// see the .animate-panel-in/out keyframes in src/styles/index.css). Reduced
// to ~0 (see `usePanelPresence`) when motion is disabled so hidden content
// doesn't linger, invisible, for a whole transition just to reflow late.
const PANEL_TRANSITION_MS = 180;

// The draggable views, by id. Their order within a region is VIEW_ORDER in
// settingsStore.js, which also says which one a region shows.
const VIEW_META = {
  explorer: { title: 'Explorer', Component: FileExplorer },
  search: { title: 'Search', Component: SearchPanel },
  // The terminal renders its own tab strip, so the region chrome is merged
  // into it instead of stacking a second bar above it.
  terminal: { title: 'Terminal', Component: TerminalSplitContainer, providesOwnHeader: true },
  // The groups/terminals tree — its own header, so it absorbs the region chrome.
  terminals: { title: 'Terminals', Component: TerminalsPanel, providesOwnHeader: true },
};

const REGION_LABEL = { left: 'primary sidebar', right: 'secondary sidebar', bottom: 'panel' };

/** True while the OS-level "reduce motion" accessibility preference is on. */
function usePrefersReducedMotionOS() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e) => setReduced(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  return reduced;
}

/**
 * Keeps a conditionally-rendered region/panel mounted for a brief grace
 * period after it goes from visible to hidden, so an exit animation
 * (`.animate-panel-out`) can play instead of the content just popping out of
 * the tree. `durationMs` should already be 0 when motion is disabled — the
 * CSS keyframes are neutralized either way (see index.css), but a real 0ms
 * timer also avoids leaving invisible content mounted (and taking up layout
 * space) for no reason.
 */
function usePanelPresence(active, durationMs) {
  const [mounted, setMounted] = useState(active);
  const [exiting, setExiting] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(() => {
    window.clearTimeout(timeoutRef.current);
    if (active) {
      setExiting(false);
      setMounted(true);
      return undefined;
    }
    setExiting(true);
    if (durationMs <= 0) {
      setMounted(false);
      setExiting(false);
      return undefined;
    }
    timeoutRef.current = window.setTimeout(() => {
      setMounted(false);
      setExiting(false);
    }, durationMs);
    return () => window.clearTimeout(timeoutRef.current);
  }, [active, durationMs]);

  return { mounted, exiting };
}

// Header for a region hosting 2+ views: one draggable tab per view (the tab
// IS the drag handle), plus a hide button. This is the tab strip proper.
function RegionHeader({
  region,
  views,
  activeView,
  onSelectView,
  onHide,
  draggingView,
  onDragStartView,
  onDragEndView,
  extra,
}) {
  // The tabs scroll when the region is too narrow for them; the side with
  // more fades (useEdgeFade). Not while a view is dragged: the region is a
  // drop target then.
  const tabsRef = useRef(null);
  useEdgeFade(tabsRef, Boolean(draggingView));
  return (
    <div className="h-panel-header shrink-0 flex items-center justify-between border-b border-vsc-border pr-1.5 select-none">
      <div ref={tabsRef} className="h-full flex items-center overflow-x-auto no-scrollbar">
        {views.map((view) => {
          const meta = VIEW_META[view];
          const isActive = view === activeView;
          return (
            <div
              key={view}
              role="button"
              draggable
              tabIndex={0}
              title={`Drag to move ${meta.title}`}
              aria-grabbed={draggingView === view}
              aria-dropeffect="move"
              onDragStart={(e) => onDragStartView(e, view)}
              onDragEnd={onDragEndView}
              onClick={() => onSelectView(view)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelectView(view);
              }}
              className={cn(
                'h-full flex items-center px-3 text-ui-sm font-medium tracking-wide cursor-grab select-none border-b -mb-px whitespace-nowrap',
                isActive
                  ? 'text-vsc-fg border-vsc-accent'
                  : 'text-vsc-muted border-transparent hover:text-vsc-fg'
              )}
            >
              <span className="uppercase">{meta.title}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {extra}
        <button
          type="button"
          className={panelButton}
          title={`Hide ${REGION_LABEL[region]}`}
          onClick={onHide}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

// Header for a region hosting exactly ONE view: no tab row (there is nothing
// to switch between), just a compact bar carrying the region's chrome — a
// drag handle (still the same draggable contract as a RegionHeader tab, so
// drag & drop keeps working) plus whatever actions the region needs. This is
// what replaces the old redundant "TERMINAL" tab that sat directly above the
// terminal's own Terminal 1 / Terminal 2 tab strip.
function CompactRegionHeader({ region, view, onHide, draggingView, onDragStartView, onDragEndView, extra }) {
  const meta = VIEW_META[view];
  return (
    <div className="h-panel-header shrink-0 flex items-center justify-between border-b border-vsc-border pl-1.5 pr-1.5 select-none">
      <div
        draggable
        title={`Drag to move ${meta.title}`}
        aria-grabbed={draggingView === view}
        aria-dropeffect="move"
        onDragStart={(e) => onDragStartView(e, view)}
        onDragEnd={onDragEndView}
        className="h-full flex items-center gap-1.5 px-1.5 -ml-1.5 cursor-grab select-none text-ui-sm font-medium tracking-wide text-vsc-muted hover:text-vsc-fg transition-colors"
      >
        <GripVertical size={14} className="shrink-0 opacity-70" />
        <span className="uppercase truncate">{meta.title}</span>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {extra}
        <button
          type="button"
          className={panelButton}
          title={`Hide ${REGION_LABEL[region]}`}
          onClick={onHide}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

// Body for a region: header (tab row or compact, depending on view count) +
// active view's content + a drop-target overlay while any view is dragged.
/**
 * The region's own controls (drag handle + actions + hide), without a bar of
 * their own. Views that already have a header row render this inside it so the
 * user never sees two stacked bars for one view.
 */
function RegionChrome({ region, view, onHide, draggingView, onDragStartView, onDragEndView, extra }) {
  const meta = VIEW_META[view];
  return (
    <>
      <div
        draggable
        title={`Drag to move ${meta.title}`}
        aria-grabbed={draggingView === view}
        onDragStart={(e) => onDragStartView(e, view)}
        onDragEnd={onDragEndView}
        className="h-full flex items-center px-1 cursor-grab text-vsc-muted hover:text-vsc-fg shrink-0"
      >
        <GripVertical size={14} className="opacity-70" />
      </div>
      {extra}
      <button type="button" className={panelButton} title={`Hide ${REGION_LABEL[region]}`} onClick={onHide}>
        <X size={16} />
      </button>
    </>
  );
}

function RegionBody({
  region,
  views,
  activeView,
  onSelectView,
  onHide,
  extra,
  draggingView,
  isOver,
  onDragStartView,
  onDragEndView,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  className,
}) {
  const meta = activeView ? VIEW_META[activeView] : null;
  const ActiveComponent = meta ? meta.Component : null;
  const isDragActive = Boolean(draggingView);
  const isSingleView = views.length === 1;
  // A single view that owns its header (the terminal) absorbs the region
  // chrome rather than getting a second bar stacked above it.
  const mergesChrome = isSingleView && Boolean(meta?.providesOwnHeader);

  return (
    <div
      className={cn('relative h-full w-full flex flex-col overflow-hidden', className)}
      aria-dropeffect={isDragActive ? (isOver ? 'move' : 'none') : undefined}
      onDragEnter={isDragActive ? onDragEnter : undefined}
      onDragOver={isDragActive ? onDragOver : undefined}
      onDragLeave={isDragActive ? onDragLeave : undefined}
      onDrop={isDragActive ? onDrop : undefined}
    >
      {mergesChrome ? null : isSingleView ? (
        <CompactRegionHeader
          region={region}
          view={views[0]}
          onHide={onHide}
          draggingView={draggingView}
          onDragStartView={onDragStartView}
          onDragEndView={onDragEndView}
          extra={extra}
        />
      ) : (
        <RegionHeader
          region={region}
          views={views}
          activeView={activeView}
          onSelectView={onSelectView}
          onHide={onHide}
          draggingView={draggingView}
          onDragStartView={onDragStartView}
          onDragEndView={onDragEndView}
          extra={extra}
        />
      )}
      <div className="flex-1 overflow-hidden">
        {ActiveComponent ? (
          <ActiveComponent
            headerSlot={
              mergesChrome ? (
                <RegionChrome
                  region={region}
                  view={views[0]}
                  onHide={onHide}
                  draggingView={draggingView}
                  onDragStartView={onDragStartView}
                  onDragEndView={onDragEndView}
                  extra={extra}
                />
              ) : null
            }
          />
        ) : null}
      </div>

      {isDragActive && (
        <div
          className={cn(
            'absolute inset-0 z-10 pointer-events-none outline outline-1 animate-overlay-in drop-zone-fade',
            isOver
              ? 'outline-vsc-accent bg-[color-mix(in_srgb,var(--vsc-accent)_10%,transparent)]'
              : 'outline-vsc-border'
          )}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

// Minimal drop zone shown at a screen edge while dragging, for a region that
// currently renders nothing (no views assigned, or hidden) so it can still
// receive a dropped view.
function EdgeDropZone({ region, edgeClassName, isOver, onDragEnter, onDragOver, onDragLeave, onDrop }) {
  return (
    <div
      role="button"
      aria-label={`Drop here to show ${REGION_LABEL[region]}`}
      aria-dropeffect={isOver ? 'move' : 'none'}
      className={cn(
        'absolute z-20 outline outline-1 animate-overlay-in drop-zone-fade',
        isOver
          ? 'outline-vsc-accent bg-[color-mix(in_srgb,var(--vsc-accent)_10%,transparent)]'
          : 'outline-vsc-border bg-[color-mix(in_srgb,var(--vsc-fg)_4%,transparent)]',
        edgeClassName
      )}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    />
  );
}

export function PanelLayout() {
  const sidebarVisible = useSettingsStore((s) => s.sidebarVisible);
  const panelVisible = useSettingsStore((s) => s.panelVisible);
  const secondarySidebarVisible = useSettingsStore((s) => s.secondarySidebarVisible);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const toggleSecondarySidebar = useSettingsStore((s) => s.toggleSecondarySidebar);
  const viewLocations = useSettingsStore((s) => s.viewLocations);
  const moveView = useSettingsStore((s) => s.moveView);
  const reducedMotionSetting = useSettingsStore((s) => s.reducedMotion);

  // Two independent "reduce motion" gates: the OS accessibility preference
  // and the Workbench setting. Either one disables motion. The OS query also
  // neutralizes animation/transition durations directly in CSS (see
  // index.css); reflecting the setting onto <html> as a class does the same
  // for the JS-only half of that gate.
  const prefersReducedMotionOS = usePrefersReducedMotionOS();
  const motionDisabled = reducedMotionSetting || prefersReducedMotionOS;
  const presenceDuration = motionDisabled ? 0 : PANEL_TRANSITION_MS;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('reduce-motion', reducedMotionSetting);
  }, [reducedMotionSetting]);

  // Every split divider in the app (the regions here, the terminal and editor
  // splits) is a react-resizable-panels separator, which the library focuses
  // on a press and never blurs; a focused one stops highlighting across its
  // hit area. A window and a document listener, for the life of the
  // workbench, let go of it when the press ends (src/lib/separatorFocus.js).
  // Keyboard focus is left alone.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    return installSeparatorFocusRelease(document);
  }, []);

  // Which view a region shows when it hosts more than one (tabs) lives in the
  // store, so the activity bar lights the view this draws: a tab clicked here,
  // an activity-bar icon or a shortcut all set it, and a region nobody chose
  // for shows its first view (see `shownView`).
  const chosenViews = useSettingsStore((s) => s.chosenViews);
  const chooseView = useSettingsStore((s) => s.chooseView);

  const regionViews = useMemo(
    () => ({
      left: viewsIn(viewLocations, 'left'),
      right: viewsIn(viewLocations, 'right'),
      bottom: viewsIn(viewLocations, 'bottom'),
    }),
    [viewLocations]
  );

  const activeViewFor = useCallback(
    (region) => shownView({ viewLocations, chosenViews }, region),
    [viewLocations, chosenViews]
  );

  const handleSelectView = useCallback((region, view) => chooseView(region, view), [chooseView]);

  // `showView` has already made the view its region's choice; the request
  // that came with it is dropped once drawn.
  const requestedView = useSettingsStore((s) => s.requestedView);
  const clearRequestedView = useSettingsStore((s) => s.clearRequestedView);
  useEffect(() => {
    if (requestedView) clearRequestedView();
  }, [requestedView, clearRequestedView]);

  // --- Drag & drop -----------------------------------------------------
  const [draggingView, setDraggingView] = useState(null);
  const [dragOverRegion, setDragOverRegion] = useState(null);

  const handleDragStartView = useCallback((e, view) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', view);
    setDraggingView(view);
  }, []);

  const handleDragEndView = useCallback(() => {
    setDraggingView(null);
    setDragOverRegion(null);
  }, []);

  const makeRegionDragHandlers = useCallback(
    (region) => ({
      onDragEnter: (e) => {
        e.preventDefault();
        setDragOverRegion(region);
      },
      onDragOver: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverRegion((prev) => (prev === region ? prev : region));
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setDragOverRegion((prev) => (prev === region ? null : prev));
      },
      onDrop: (e) => {
        e.preventDefault();
        const view = e.dataTransfer.getData('text/plain') || draggingView;
        if (view) moveView(view, region);
        setDraggingView(null);
        setDragOverRegion(null);
      },
    }),
    [draggingView, moveView]
  );

  const leftHandlers = useMemo(() => makeRegionDragHandlers('left'), [makeRegionDragHandlers]);
  const rightHandlers = useMemo(() => makeRegionDragHandlers('right'), [makeRegionDragHandlers]);
  const bottomHandlers = useMemo(() => makeRegionDragHandlers('bottom'), [makeRegionDragHandlers]);

  // There is no Maximize Panel (sibling C, FC4): with the editor area gone the
  // region holding the `terminal` view fills the centre column, and Toggle
  // Pane Zoom gives one pane of the workbench the whole of it.
  const bottomHasViews = regionViews.bottom.length > 0;
  const bottomRendered = panelVisible && bottomHasViews;

  const leftActive = activeViewFor('left');
  const rightActive = activeViewFor('right');
  const bottomActive = activeViewFor('bottom');

  const leftRendered = sidebarVisible && regionViews.left.length > 0;
  const rightRendered = secondarySidebarVisible && regionViews.right.length > 0;

  const leftPresence = usePanelPresence(leftRendered, presenceDuration);
  const rightPresence = usePanelPresence(rightRendered, presenceDuration);
  const bottomPresence = usePanelPresence(bottomRendered, presenceDuration);

  const presenceClass = (presence) => (presence.exiting ? 'animate-panel-out' : 'animate-panel-in');

  return (
    <div className="relative flex-1 h-full w-full overflow-hidden">
      <Group orientation="horizontal" className="h-full w-full overflow-hidden">
        {leftPresence.mounted && (
          <>
            <Panel
              id="primary-sidebar"
              defaultSize={260}
              minSize={170}
              className={cn('h-full overflow-hidden bg-vsc-sidebar', presenceClass(leftPresence))}
            >
              <RegionBody
                region="left"
                views={regionViews.left}
                activeView={leftActive}
                onSelectView={(view) => handleSelectView('left', view)}
                onHide={toggleSidebar}
                draggingView={draggingView}
                isOver={dragOverRegion === 'left'}
                onDragStartView={handleDragStartView}
                onDragEndView={handleDragEndView}
                {...leftHandlers}
              />
            </Panel>
            <Separator className="w-px" />
          </>
        )}

        <Panel id="center" minSize="20" className="h-full overflow-hidden">
          {bottomPresence.mounted ? (
            <Group orientation="vertical" className="h-full w-full overflow-hidden">
                <Panel
                  id="bottom-panel"
                  defaultSize="40"
                  minSize={128}
                  className={cn(
                    'h-full overflow-hidden bg-vsc-panel flex flex-col',
                    presenceClass(bottomPresence)
                  )}
                >
                  <RegionBody
                    region="bottom"
                    views={regionViews.bottom}
                    activeView={bottomActive}
                    onSelectView={(view) => handleSelectView('bottom', view)}
                    onHide={togglePanel}
                    draggingView={draggingView}
                    isOver={dragOverRegion === 'bottom'}
                    onDragStartView={handleDragStartView}
                    onDragEndView={handleDragEndView}
                    {...bottomHandlers}
                  />
                </Panel>
            </Group>
          ) : (
            <div className="h-full w-full overflow-hidden bg-vsc-editor" />
          )}
        </Panel>

        {rightPresence.mounted && (
          <>
            <Separator className="w-px" />
            <Panel
              id="secondary-sidebar"
              defaultSize={320}
              minSize={220}
              className={cn(
                'h-full overflow-hidden bg-vsc-sidebar flex flex-col',
                presenceClass(rightPresence)
              )}
            >
              <RegionBody
                region="right"
                views={regionViews.right}
                activeView={rightActive}
                onSelectView={(view) => handleSelectView('right', view)}
                onHide={() => toggleSecondarySidebar()}
                draggingView={draggingView}
                isOver={dragOverRegion === 'right'}
                onDragStartView={handleDragStartView}
                onDragEndView={handleDragEndView}
                {...rightHandlers}
              />
            </Panel>
          </>
        )}
      </Group>

      {/* Edge drop zones for regions that currently render no Panel at all
          (empty or hidden), so a dragged view can still be dropped there. */}
      {draggingView && !leftRendered && (
        <EdgeDropZone
          region="left"
          edgeClassName="left-0 top-0 bottom-0 w-3"
          isOver={dragOverRegion === 'left'}
          {...leftHandlers}
        />
      )}
      {draggingView && !rightRendered && (
        <EdgeDropZone
          region="right"
          edgeClassName="right-0 top-0 bottom-0 w-3"
          isOver={dragOverRegion === 'right'}
          {...rightHandlers}
        />
      )}
      {draggingView && !bottomRendered && (
        <EdgeDropZone
          region="bottom"
          edgeClassName="left-0 right-0 bottom-0 h-3"
          isOver={dragOverRegion === 'bottom'}
          {...bottomHandlers}
        />
      )}

      {/* The editor's Save / Don't Save / Cancel and "File Changed on Disk"
          prompts, onto <body>. Mounted whatever the layout: the editor panes
          are drawn only in the group on screen, and only while the terminal
          view is, and a window close, Quit, a folder switch or closing
          another group asks about files in any group. */}
      <EditorPrompts />
    </div>
  );
}

export default PanelLayout;
