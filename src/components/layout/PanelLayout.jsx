import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { TerminalSplitContainer } from '../terminal/index.js';
import { EditorPanel } from '../editor/EditorPanel.jsx';
import { FileExplorer } from '../explorer/FileExplorer.jsx';
import { GripVertical, Maximize2, Minimize2, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const panelButton =
  'w-6 h-6 flex items-center justify-center rounded text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover active:bg-vsc-item-active transition-colors';

// Fallback restore layout used the first time the panel is maximized in a
// session (before we have a captured "layout before maximize" to return to).
const DEFAULT_EDITOR_PANEL_LAYOUT = { 'editor-group': 60, 'bottom-panel': 40 };

// Regions/panels fade+scale in and out over this long (150-200ms, ease-out —
// see the .animate-panel-in/out keyframes in src/styles/index.css). Reduced
// to ~0 (see `usePanelPresence`) when motion is disabled so hidden content
// doesn't linger, invisible, for a whole transition just to reflow late.
const PANEL_TRANSITION_MS = 180;

// The three draggable views and where each one is allowed to render.
// Order here also controls tab order within a region.
const VIEW_ORDER = ['explorer', 'terminal'];

const VIEW_META = {
  explorer: { title: 'Explorer', Component: FileExplorer },
  // The terminal renders its own tab strip, so the region chrome is merged
  // into it instead of stacking a second bar above it.
  terminal: { title: 'Terminal', Component: TerminalSplitContainer, providesOwnHeader: true },
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

// Terminal-only toolbar for the region chrome. Split/new-tab are already on
// the terminal's own per-pane tab strip (TerminalSplitContainer), so the only
// action that still needs a home here is maximize — kept as its own
// component so it's the only part of the header subscribed to panelMaximized.
function TerminalExtraControls({ maximized, onToggleMaximize }) {
  return (
    <button
      type="button"
      className={panelButton}
      title={maximized ? 'Restore Panel Size' : 'Maximize Panel'}
      onClick={onToggleMaximize}
    >
      {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  );
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
  return (
    <div className="h-panel-header shrink-0 flex items-center justify-between border-b border-vsc-border pr-1.5 select-none">
      <div className="h-full flex items-center overflow-x-auto">
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
                  ? 'text-vsc-fg border-vsc-focus'
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
              ? 'outline-vsc-focus bg-[color-mix(in_srgb,var(--vsc-accent)_10%,transparent)]'
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
          ? 'outline-vsc-focus bg-[color-mix(in_srgb,var(--vsc-accent)_10%,transparent)]'
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

  // The editor area only exists once a file is open (task: workspace starts
  // empty, terminal fills the space until Explorer opens something).
  const editorTabCount = useEditorStore((s) => s.tabs.length);
  const hasEditorTabs = editorTabCount > 0;

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

  // Which view is shown when a region hosts more than one (tabs). Only
  // overridden explicitly by clicking a tab; otherwise falls back to the
  // first view assigned to that region.
  const [explicitActive, setExplicitActive] = useState({});

  const regionViews = useMemo(() => {
    const map = { left: [], right: [], bottom: [] };
    VIEW_ORDER.forEach((view) => {
      const region = viewLocations[view];
      if (map[region]) map[region].push(view);
    });
    return map;
  }, [viewLocations]);

  const activeViewFor = useCallback(
    (region) => {
      const views = regionViews[region];
      if (!views.length) return null;
      const explicit = explicitActive[region];
      return views.includes(explicit) ? explicit : views[0];
    },
    [regionViews, explicitActive]
  );

  const handleSelectView = useCallback(
    (region, view) => setExplicitActive((prev) => ({ ...prev, [region]: view })),
    []
  );

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

  // --- Maximize / restore the bottom panel ------------------------------
  // react-resizable-panels v4: `defaultSize` only applies at the panel's
  // initial mount — changing it afterwards is a no-op. The imperative
  // GroupImperativeHandle (getLayout/setLayout, percentages 0..100 keyed by
  // panel id) is the only way to resize a live Group, so we grab a ref to
  // the editor|panel vertical Group and drive it directly.
  const editorPanelGroupRef = useGroupRef();
  const preMaximizeLayoutRef = useRef(null);
  const [panelMaximized, setPanelMaximized] = useState(false);

  // Briefly true right after a programmatic setLayout (maximize/restore) so
  // the Group's direct Panel children pick up a flex-grow transition — see
  // .panel-maximize-transition in index.css. Never set during a live
  // Separator drag, so pointer-driven resize always stays 1:1.
  const [maximizeTransitioning, setMaximizeTransitioning] = useState(false);
  const maximizeTransitionTimeoutRef = useRef(null);

  const bottomHasViews = regionViews.bottom.length > 0;
  const bottomRendered = panelVisible && bottomHasViews;

  const handleToggleMaximize = useCallback(() => {
    const handle = editorPanelGroupRef.current;
    if (!handle) return;
    // With no file open the editor group is not rendered, so the vertical group
    // holds a single panel and setLayout with two ids throws
    // ("Invalid 1 panel layout"). There is nothing to maximize against anyway.
    if (!hasEditorTabs) return;

    const applyLayout = (layout) => {
      handle.setLayout(layout);
      if (presenceDuration <= 0) return;
      setMaximizeTransitioning(true);
      window.clearTimeout(maximizeTransitionTimeoutRef.current);
      maximizeTransitionTimeoutRef.current = window.setTimeout(() => {
        setMaximizeTransitioning(false);
      }, presenceDuration);
    };

    if (!panelMaximized) {
      preMaximizeLayoutRef.current = handle.getLayout();
      applyLayout({ 'editor-group': 0, 'bottom-panel': 100 });
      setPanelMaximized(true);
    } else {
      const restored = preMaximizeLayoutRef.current || DEFAULT_EDITOR_PANEL_LAYOUT;
      applyLayout(restored);
      preMaximizeLayoutRef.current = null;
      setPanelMaximized(false);
    }
  }, [panelMaximized, editorPanelGroupRef, presenceDuration, hasEditorTabs]);

  useEffect(() => () => window.clearTimeout(maximizeTransitionTimeoutRef.current), []);

  // If the bottom region gets hidden or emptied (Close Panel, or the
  // terminal view got dragged elsewhere) while maximized, drop the
  // maximized flag and any stale captured layout so a later maximize starts
  // clean instead of "restoring" into a panel that no longer exists.
  useEffect(() => {
    if (!bottomRendered && panelMaximized) {
      setPanelMaximized(false);
      preMaximizeLayoutRef.current = null;
    }
  }, [bottomRendered, panelMaximized]);

  const leftActive = activeViewFor('left');
  const rightActive = activeViewFor('right');
  const bottomActive = activeViewFor('bottom');

  const leftRendered = sidebarVisible && regionViews.left.length > 0;
  const rightRendered = secondarySidebarVisible && regionViews.right.length > 0;
  const showEditorGroup = hasEditorTabs;

  const leftPresence = usePanelPresence(leftRendered, presenceDuration);
  const rightPresence = usePanelPresence(rightRendered, presenceDuration);
  const bottomPresence = usePanelPresence(bottomRendered, presenceDuration);
  const editorPresence = usePanelPresence(showEditorGroup, presenceDuration);

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
          {editorPresence.mounted || bottomPresence.mounted ? (
            <Group
              orientation="vertical"
              groupRef={editorPanelGroupRef}
              className={cn('h-full w-full overflow-hidden', maximizeTransitioning && 'panel-maximize-transition')}
            >
              {editorPresence.mounted && (
                <Panel
                  id="editor-group"
                  minSize="20"
                  className={cn('h-full overflow-hidden bg-vsc-editor', presenceClass(editorPresence))}
                >
                  <EditorPanel />
                </Panel>
              )}

              {editorPresence.mounted && bottomPresence.mounted && <Separator className="h-px" />}

              {bottomPresence.mounted && (
                <Panel
                  id="bottom-panel"
                  defaultSize="40"
                  minSize="15"
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
                    extra={
                      bottomActive === 'terminal' && hasEditorTabs ? (
                        <TerminalExtraControls maximized={panelMaximized} onToggleMaximize={handleToggleMaximize} />
                      ) : null
                    }
                    draggingView={draggingView}
                    isOver={dragOverRegion === 'bottom'}
                    onDragStartView={handleDragStartView}
                    onDragEndView={handleDragEndView}
                    {...bottomHandlers}
                  />
                </Panel>
              )}
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
    </div>
  );
}

export default PanelLayout;
