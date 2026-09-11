import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { TerminalSplitContainer } from '../terminal/index.js';
import { EditorPanel } from '../editor/EditorPanel.jsx';
import { FileExplorer } from '../explorer/FileExplorer.jsx';
import { MissionControl } from '../agent/MissionControl.jsx';
import {
  SquareSplitHorizontal,
  SquareSplitVertical,
  Plus,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';

const panelButton =
  'w-6 h-6 flex items-center justify-center rounded text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover active:bg-vsc-item-active transition-colors';

// Fallback restore layout used the first time the panel is maximized in a
// session (before we have a captured "layout before maximize" to return to).
const DEFAULT_EDITOR_PANEL_LAYOUT = { 'editor-group': 60, 'bottom-panel': 40 };

// The three draggable views and where each one is allowed to render.
// Order here also controls tab order within a region.
const VIEW_ORDER = ['explorer', 'agents', 'terminal'];

const VIEW_META = {
  explorer: { title: 'Explorer', Component: FileExplorer },
  agents: { title: 'Agents', Component: MissionControl },
  terminal: { title: 'Terminal', Component: TerminalSplitContainer },
};

const REGION_LABEL = { left: 'primary sidebar', right: 'secondary sidebar', bottom: 'panel' };

// Terminal-only toolbar (split / new tab / maximize). Kept as its own
// component so it's the only part of the header subscribed to terminalStore.
function TerminalExtraControls({ maximized, onToggleMaximize }) {
  const splitActivePane = useTerminalStore((s) => s.splitActivePane);
  const createTab = useTerminalStore((s) => s.createTab);

  return (
    <>
      <button
        type="button"
        className={panelButton}
        title="Split Terminal Right"
        onClick={() => splitActivePane?.('horizontal')}
      >
        <SquareSplitHorizontal size={16} />
      </button>
      <button
        type="button"
        className={panelButton}
        title="Split Terminal Down"
        onClick={() => splitActivePane?.('vertical')}
      >
        <SquareSplitVertical size={16} />
      </button>
      <button type="button" className={panelButton} title="New Terminal" onClick={() => createTab?.()}>
        <Plus size={16} />
      </button>
      <button
        type="button"
        className={panelButton}
        title={maximized ? 'Restore Panel Size' : 'Maximize Panel'}
        onClick={onToggleMaximize}
      >
        {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
    </>
  );
}

// Header for a region: renders one draggable tab per view assigned to that
// region (the tab IS the drag handle), plus a hide button. Doubles as a tab
// strip when a region hosts more than one view.
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

// Body for a region: header + active view's content + a drop-target overlay
// while any view is being dragged.
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

  return (
    <div
      className={cn('relative h-full w-full flex flex-col overflow-hidden', className)}
      aria-dropeffect={isDragActive ? (isOver ? 'move' : 'none') : undefined}
      onDragEnter={isDragActive ? onDragEnter : undefined}
      onDragOver={isDragActive ? onDragOver : undefined}
      onDragLeave={isDragActive ? onDragLeave : undefined}
      onDrop={isDragActive ? onDrop : undefined}
    >
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
      <div className="flex-1 overflow-hidden">{ActiveComponent ? <ActiveComponent /> : null}</div>

      {isDragActive && (
        <div
          className={cn(
            'absolute inset-0 z-10 pointer-events-none outline outline-1',
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
        'absolute z-20 outline outline-1',
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

  const bottomHasViews = regionViews.bottom.length > 0;
  const bottomRendered = panelVisible && bottomHasViews;

  const handleToggleMaximize = useCallback(() => {
    const handle = editorPanelGroupRef.current;
    if (!handle) return;

    if (!panelMaximized) {
      preMaximizeLayoutRef.current = handle.getLayout();
      handle.setLayout({ 'editor-group': 0, 'bottom-panel': 100 });
      setPanelMaximized(true);
    } else {
      const restored = preMaximizeLayoutRef.current || DEFAULT_EDITOR_PANEL_LAYOUT;
      handle.setLayout(restored);
      preMaximizeLayoutRef.current = null;
      setPanelMaximized(false);
    }
  }, [panelMaximized, editorPanelGroupRef]);

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

  return (
    <div className="relative flex-1 h-full w-full overflow-hidden">
      <Group orientation="horizontal" className="h-full w-full overflow-hidden">
        {leftRendered && (
          <>
            <Panel id="primary-sidebar" defaultSize={260} minSize={170} className="h-full overflow-hidden bg-vsc-sidebar">
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
          <Group orientation="vertical" groupRef={editorPanelGroupRef} className="h-full w-full overflow-hidden">
            <Panel id="editor-group" minSize="20" className="h-full overflow-hidden bg-vsc-editor">
              <EditorPanel />
            </Panel>

            {bottomRendered && (
              <>
                <Separator className="h-px" />
                <Panel
                  id="bottom-panel"
                  defaultSize="40"
                  minSize="15"
                  className="h-full overflow-hidden bg-vsc-panel flex flex-col"
                >
                  <RegionBody
                    region="bottom"
                    views={regionViews.bottom}
                    activeView={bottomActive}
                    onSelectView={(view) => handleSelectView('bottom', view)}
                    onHide={togglePanel}
                    extra={
                      bottomActive === 'terminal' ? (
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
              </>
            )}
          </Group>
        </Panel>

        {rightRendered && (
          <>
            <Separator className="w-px" />
            <Panel id="secondary-sidebar" defaultSize={320} minSize={220} className="h-full overflow-hidden bg-vsc-sidebar flex flex-col">
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
