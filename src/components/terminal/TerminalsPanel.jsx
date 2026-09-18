import React, { useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  FolderPlus,
  Plus,
  Rows2,
  Save,
  SquareTerminal,
  Terminal as TermIcon,
  Layers,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { cn } from '../../lib/utils.js';

const ROW = 'h-[22px] flex items-center gap-1.5 pr-2 text-ui cursor-default select-none w-full text-left';
const INDENT = 10;

/**
 * Left padding for a row at tree depth `level` (0 = group). Level 1 lands at
 * 24px — where terminals already sat under a group — so an unsplit group reads
 * exactly as it did before panes existed.
 */
const padFor = (level) => (level === 0 ? 4 : 4 + INDENT * (level + 1));

/**
 * Collect one group's panes in DOM order, each tagged with the direction of
 * the split that contains it (null when the group was never split).
 */
function collectPanes(node, direction = null, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') {
    acc.push({ pane: node, direction });
    return acc;
  }
  for (const child of node.children) collectPanes(child, node.direction, acc);
  return acc;
}

function relativeTime(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const basename = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || p || '';

/** The indent guides a row at `level` sits behind, matching the Explorer tree. */
function IndentGuides({ level }) {
  if (level < 1) return null;
  return (
    <>
      {Array.from({ length: level }, (_, k) => (
        <span
          key={k}
          aria-hidden="true"
          className="absolute top-0 bottom-0 border-l border-vsc-indent-guide"
          style={{ left: 4 + INDENT * (k + 1) }}
        />
      ))}
    </>
  );
}

/**
 * The "Terminals" view: every group, the panes it is split into, and the
 * terminals inside them — plus the groups the user has saved by name.
 *
 * ROW STRUCTURE. The model is three levels deep (group → pane → terminal) but
 * the tree renders the pane level ONLY for a group that is actually split.
 * Most groups hold a single pane, and a sole "Pane 1" row under every group
 * would be pure indentation tax: it costs a row, a level of indent and a click
 * target while telling the user nothing they cannot see. So a one-pane group
 * lists its terminals directly (level 1, exactly where they used to sit) and a
 * split group grows a level of pane rows (level 1) with its terminals under
 * them (level 2). The panel is the group switcher first and a layout inspector
 * second; this keeps the common case flat and only pays for the structure when
 * the structure exists.
 *
 * Rows mirror the Explorer's density (22px, chevrons, indent guides) so the
 * two trees read the same.
 */
export function TerminalsPanel() {
  const groups = useTerminalStore((s) => s.groups);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const savedGroups = useTerminalStore((s) => s.savedGroups);
  const savedWorkspaces = useTerminalStore((s) => s.savedWorkspaces);
  const workspaceName = useTerminalStore((s) => s.workspaceName);

  const switchTab = useTerminalStore((s) => s.switchTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const setActiveGroup = useTerminalStore((s) => s.setActiveGroup);
  const createTab = useTerminalStore((s) => s.createTab);
  const createGroup = useTerminalStore((s) => s.createGroup);
  const duplicateTab = useTerminalStore((s) => s.duplicateTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const closePane = useTerminalStore((s) => s.closePane);
  const closeGroup = useTerminalStore((s) => s.closeGroup);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const renameGroup = useTerminalStore((s) => s.renameGroup);
  const closeOthersInGroup = useTerminalStore((s) => s.closeOthersInGroup);
  const closeTabsToTheRight = useTerminalStore((s) => s.closeTabsToTheRight);
  const moveTabToGroup = useTerminalStore((s) => s.moveTabToGroup);
  const moveTabToNewPane = useTerminalStore((s) => s.moveTabToNewPane);
  const moveTabToNewGroup = useTerminalStore((s) => s.moveTabToNewGroup);
  const saveGroup = useTerminalStore((s) => s.saveGroup);
  const loadSavedGroup = useTerminalStore((s) => s.loadSavedGroup);
  const renameSavedGroup = useTerminalStore((s) => s.renameSavedGroup);
  const deleteSavedGroup = useTerminalStore((s) => s.deleteSavedGroup);
  const saveWorkspace = useTerminalStore((s) => s.saveWorkspace);
  const loadWorkspace = useTerminalStore((s) => s.loadWorkspace);
  const renameSavedWorkspace = useTerminalStore((s) => s.renameSavedWorkspace);
  const deleteSavedWorkspace = useTerminalStore((s) => s.deleteSavedWorkspace);
  const renameWorkspace = useTerminalStore((s) => s.renameWorkspace);

  // Collapsed group ids AND pane ids share one set — pane ids are unique
  // across every group, so they cannot collide.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [savedOpen, setSavedOpen] = useState(true);
  const [menu, setMenu] = useState(null); // { x, y, kind, id, view? }
  const [draft, setDraft] = useState(null); // { kind: 'group'|'tab'|'saved'|'workspace', id, value }
  // Selecting a saved group is deliberately inert — see the row's comment.
  const [selectedSavedId, setSelectedSavedId] = useState(null);
  const listRef = useRef(null);

  const tabById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);

  /** [{ group, panes: [{ pane, direction }], tabCount }] in switcher order. */
  const layout = useMemo(
    () =>
      groups.map((group) => {
        const panes = collectPanes(group.tree);
        return {
          group,
          panes,
          tabCount: panes.reduce((n, { pane }) => n + pane.tabIds.length, 0),
        };
      }),
    [groups]
  );

  /** Which group and pane hold `tabId` right now. */
  const locate = (tabId) => {
    for (const { group, panes } of layout) {
      for (const { pane } of panes) {
        if (pane.tabIds.includes(tabId)) return { group, pane, paneCount: panes.length };
      }
    }
    return null;
  };

  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * Clicking a terminal has to bring its GROUP on screen before focusing
   * anything, or the user activates something they cannot see. `switchTab`
   * does all three steps in one update: it finds the owning group, makes it
   * the active group, focuses the pane holding the tab, and makes the tab that
   * pane's visible one.
   */
  const activateTab = (tabId) => switchTab(tabId);

  const commitDraft = () => {
    if (!draft) return;
    const value = draft.value.trim();
    if (draft.kind === 'group') renameGroup(draft.id, value);
    else if (draft.kind === 'tab') renameTab(draft.id, value);
    else if (draft.kind === 'saved') renameSavedGroup(draft.id, value);
    else if (draft.kind === 'workspace') renameSavedWorkspace(draft.id, value);
    else if (draft.kind === 'workspace-name') renameWorkspace(value);
    setDraft(null);
  };

  const startRename = (kind, id, current) => setDraft({ kind, id, value: current || '' });

  const renameInput = (
    <input
      autoFocus
      value={draft?.value ?? ''}
      onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
      onKeyDown={(e) => {
        // The input lives inside a row that also answers Enter (activate /
        // load). Without this the commit would immediately be followed by the
        // row's own action.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commitDraft();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(null);
        }
      }}
      onBlur={commitDraft}
      className="flex-1 min-w-0 h-[18px] px-1 bg-vsc-input border border-vsc-focus rounded-sm text-ui text-vsc-fg outline-none"
    />
  );

  // ---- context menus -------------------------------------------------
  const groupItems = (entry) => {
    const { group, panes, tabCount } = entry;
    const isActive = group.id === activeGroupId;
    const onlyGroup = groups.length <= 1;
    return [
      {
        key: 'switch',
        label: 'Switch to This Group',
        disabled: isActive,
        disabledReason: isActive ? 'This group is already on screen' : undefined,
        onSelect: () => setActiveGroup(group.id),
      },
      { key: 'new', label: 'New Terminal in Group', onSelect: () => createTab({ groupId: group.id }) },
      { type: 'separator', key: 's1' },
      {
        key: 'split-r',
        label: panes.length > 1 ? 'Split Active Pane Right' : 'Split Right',
        onSelect: () => splitPane(group.activePaneId, 'horizontal', group.id),
      },
      {
        key: 'split-d',
        label: panes.length > 1 ? 'Split Active Pane Down' : 'Split Down',
        onSelect: () => splitPane(group.activePaneId, 'vertical', group.id),
      },
      { type: 'separator', key: 's2' },
      { key: 'rename', label: 'Rename Group…', onSelect: () => startRename('group', group.id, group.name) },
      {
        key: 'save',
        label: 'Save Group…',
        disabled: tabCount === 0,
        disabledReason: tabCount === 0 ? 'This group has no terminals to save' : undefined,
        onSelect: () => {
          const saved = saveGroup(group.id, group.name);
          if (!saved) return;
          setSavedOpen(true);
          setSelectedSavedId(saved.id);
          startRename('saved', saved.id, saved.name);
        },
      },
      { type: 'separator', key: 's3' },
      {
        key: 'close',
        label: 'Close Group',
        danger: true,
        disabled: onlyGroup,
        disabledReason: onlyGroup ? 'The last group cannot be closed' : undefined,
        onSelect: () => closeGroup(group.id),
      },
    ];
  };

  const paneItems = (group, pane, index, paneCount) => [
    { key: 'focus', label: `Focus Pane ${index + 1}`, onSelect: () => setActivePane(pane.id, group.id) },
    {
      key: 'new',
      label: 'New Terminal in Pane',
      onSelect: () => createTab({ paneId: pane.id, groupId: group.id }),
    },
    { type: 'separator', key: 's1' },
    { key: 'split-r', label: 'Split Right', onSelect: () => splitPane(pane.id, 'horizontal', group.id) },
    { key: 'split-d', label: 'Split Down', onSelect: () => splitPane(pane.id, 'vertical', group.id) },
    { type: 'separator', key: 's2' },
    {
      key: 'close',
      label: 'Close Pane',
      danger: true,
      disabled: paneCount <= 1,
      disabledReason: paneCount <= 1 ? 'This group has only one pane' : undefined,
      onSelect: () => closePane(pane.id, group.id),
    },
  ];

  const tabItems = (group, pane, paneCount, tab, at) => {
    const idx = pane.tabIds.indexOf(tab.id);
    const others = pane.tabIds.length > 1;
    const toRight = idx >= 0 && idx < pane.tabIds.length - 1;
    const otherGroups = groups.filter((g) => g.id !== group.id);
    // `moveTabToNewGroup` refuses when the tab is a one-pane group's only
    // terminal: the move would just rename that group.
    const aloneInGroup = paneCount === 1 && pane.tabIds.length === 1;
    return [
      { key: 'open', label: 'Open', onSelect: () => activateTab(tab.id) },
      { type: 'separator', key: 's1' },
      { key: 'rename', label: 'Rename…', onSelect: () => startRename('tab', tab.id, tab.title) },
      { key: 'dup', label: 'Duplicate', onSelect: () => duplicateTab(tab.id) },
      {
        key: 'copy-path',
        label: 'Copy Path',
        disabled: !tab.cwd,
        disabledReason: !tab.cwd ? 'This terminal has no directory yet' : undefined,
        onSelect: () => navigator.clipboard?.writeText(tab.cwd || ''),
      },
      { type: 'separator', key: 's2' },
      {
        key: 'move-group',
        label: 'Move to Group ▸',
        disabled: otherGroups.length === 0,
        disabledReason: otherGroups.length === 0 ? 'There is no other group to move it to' : undefined,
        // Drill down in place. `ContextMenu` fires onClose BEFORE onSelect, so
        // this must hand back a whole new menu object (a functional update
        // would see the null the close just wrote).
        onSelect: () => setMenu({ ...at, kind: 'tab', id: tab.id, view: 'move' }),
      },
      {
        key: 'move-new-group',
        label: 'Move to New Group',
        disabled: aloneInGroup,
        disabledReason: aloneInGroup ? 'It is already the only terminal in its group' : undefined,
        onSelect: () => moveTabToNewGroup(tab.id),
      },
      {
        key: 'move-new-pane',
        label: 'Move to New Pane',
        disabled: !others,
        disabledReason: !others ? 'It is already the only terminal in its pane' : undefined,
        onSelect: () => moveTabToNewPane(tab.id, 'horizontal'),
      },
      { type: 'separator', key: 's3' },
      { key: 'close', label: 'Close', onSelect: () => closeTab(tab.id) },
      {
        key: 'close-others',
        label: 'Close Others in Pane',
        disabled: !others,
        disabledReason: !others ? 'There are no other terminals in this pane' : undefined,
        onSelect: () => closeOthersInGroup(tab.id),
      },
      {
        key: 'close-right',
        label: 'Close Terminals to the Right',
        disabled: !toRight,
        disabledReason: !toRight ? 'Nothing sits to the right of this terminal' : undefined,
        onSelect: () => closeTabsToTheRight(tab.id),
      },
    ];
  };

  /** The "Move to Group ▸" drill-down: every group except the tab's own. */
  const moveToGroupItems = (group, tab, at) => [
    {
      key: 'back',
      label: 'Back',
      icon: ChevronLeft,
      onSelect: () => setMenu({ ...at, kind: 'tab', id: tab.id }),
    },
    { type: 'separator', key: 's1' },
    ...layout
      .filter((entry) => entry.group.id !== group.id)
      .map(({ group: target, tabCount }) => ({
        key: target.id,
        label: `${target.name} (${tabCount})`,
        onSelect: () => moveTabToGroup(tab.id, target.id),
      })),
  ];

  const savedItems = (entry) => [
    { key: 'load', label: 'Load in New Group', onSelect: () => loadSavedGroup(entry.id, { mode: 'new-group' }) },
    {
      key: 'load-here',
      label: 'Load into Current Group',
      onSelect: () => loadSavedGroup(entry.id, { mode: 'replace' }),
    },
    { type: 'separator', key: 's1' },
    { key: 'rename', label: 'Rename…', onSelect: () => startRename('saved', entry.id, entry.name) },
    { key: 'delete', label: 'Delete', danger: true, onSelect: () => deleteSavedGroup(entry.id) },
  ];

  const workspaceItems = (entry) => [
    {
      key: 'restore',
      label: 'Restore Workspace',
      onSelect: () => loadWorkspace(entry.id, { mode: 'replace' }),
    },
    {
      key: 'add',
      label: 'Add Its Groups to This Session',
      onSelect: () => loadWorkspace(entry.id, { mode: 'append' }),
    },
    { type: 'separator', key: 's1' },
    { key: 'rename', label: 'Rename…', onSelect: () => startRename('workspace', entry.id, entry.name) },
    { key: 'delete', label: 'Delete', danger: true, onSelect: () => deleteSavedWorkspace(entry.id) },
  ];

  /**
   * The menu behind the workspace bar.
   *
   * Saved workspaces used to be their own section in the tree, which left the
   * session you were actually IN nameless and unlisted. The live session is
   * the workspace now; saved ones are alternatives you switch to from here.
   */
  const workspaceBarItems = (at) => [
    { key: 'rename', label: 'Rename Workspace…', onSelect: () => startRename('workspace-name', 'current', workspaceName) },
    {
      key: 'save',
      label: 'Save Workspace',
      disabled: tabs.length === 0,
      disabledReason: tabs.length === 0 ? 'There are no terminals to save' : undefined,
      onSelect: saveAllGroups,
    },
    { type: 'separator', key: 's1' },
    {
      key: 'switch',
      label: `Open Saved Workspace${savedWorkspaces.length ? ` (${savedWorkspaces.length})` : ''}…`,
      disabled: savedWorkspaces.length === 0,
      disabledReason: savedWorkspaces.length === 0 ? 'Nothing saved yet' : undefined,
      onSelect: () => setMenu({ ...at, kind: 'workspace-list', id: null }),
    },
  ];

  const savedWorkspaceListItems = (at) => [
    { key: 'back', label: '‹ Back', icon: ChevronLeft, onSelect: () => setMenu({ ...at, kind: 'workspace-bar', id: null }) },
    { type: 'separator', key: 's0' },
    ...savedWorkspaces.map((entry) => ({
      key: entry.id,
      label: `${entry.name} (${entry.groups.length}g · ${entry.groups.reduce((n, g) => n + (g.tabs?.length || 0), 0)}t)`,
      onSelect: () => loadWorkspace(entry.id, { mode: 'replace' }),
    })),
  ];

  /** Snapshot every group at once, then open its name for editing. */
  const saveAllGroups = () => {
    const entry = saveWorkspace();
    if (!entry) return;
    // Saving under the name you are already working in is the common case;
    // renaming is one menu item away.
    startRename('workspace-name', 'current', entry.name);
  };

  const emptyItems = () => [
    { key: 'new-term', label: 'New Terminal', onSelect: () => createTab() },
    { key: 'new-group', label: 'New Group', onSelect: () => createGroup() },
    { type: 'separator', key: 's1' },
    {
      key: 'save-all',
      label: 'Save All Groups…',
      disabled: tabs.length === 0,
      disabledReason: tabs.length === 0 ? 'There are no terminals to save' : undefined,
      onSelect: saveAllGroups,
    },
  ];

  const openMenu = (e, kind, id) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, kind, id });
  };

  const menuItems = () => {
    if (!menu) return [];
    const at = { x: menu.x, y: menu.y };
    if (menu.kind === 'group') {
      const entry = layout.find((l) => l.group.id === menu.id);
      return entry ? groupItems(entry) : [];
    }
    if (menu.kind === 'pane') {
      const entry = layout.find((l) => l.panes.some((p) => p.pane.id === menu.id));
      if (!entry) return [];
      const index = entry.panes.findIndex((p) => p.pane.id === menu.id);
      return paneItems(entry.group, entry.panes[index].pane, index, entry.panes.length);
    }
    if (menu.kind === 'tab') {
      const found = locate(menu.id);
      const tab = tabById.get(menu.id);
      if (!found || !tab) return [];
      return menu.view === 'move'
        ? moveToGroupItems(found.group, tab, at)
        : tabItems(found.group, found.pane, found.paneCount, tab, at);
    }
    if (menu.kind === 'saved') {
      const entry = savedGroups.find((x) => x.id === menu.id);
      return entry ? savedItems(entry) : [];
    }
    if (menu.kind === 'workspace-bar') return workspaceBarItems(at);
    if (menu.kind === 'workspace-list') return savedWorkspaceListItems(at);
    if (menu.kind === 'workspace') {
      const entry = savedWorkspaces.find((x) => x.id === menu.id);
      return entry ? workspaceItems(entry) : [];
    }
    return emptyItems();
  };

  // Arrow-key navigation across every row the tree renders.
  const onKeyDown = (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const rows = Array.from(listRef.current?.querySelectorAll('[data-row]') || []);
    const i = rows.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    next?.focus();
  };

  /** One terminal row, rendered at `level` (1 in a flat group, 2 in a split one). */
  const renderTab = (tab, level, isActiveGroup, paneActiveTabId) => {
    const editing = draft?.kind === 'tab' && draft.id === tab.id;
    const isActive = isActiveGroup && tab.id === activeTabId;
    // A tab that is its pane's visible one, in a group that is off screen.
    const isPaneVisible = !isActive && tab.id === paneActiveTabId;
    return (
      <div
        key={tab.id}
        data-row
        role="button"
        tabIndex={0}
        onClick={() => activateTab(tab.id)}
        onDoubleClick={() => startRename('tab', tab.id, tab.title)}
        onContextMenu={(e) => openMenu(e, 'tab', tab.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') activateTab(tab.id);
          else if (e.key === 'F2') {
            e.preventDefault();
            startRename('tab', tab.id, tab.title);
          }
        }}
        style={{ paddingLeft: padFor(level) }}
        title={tab.cwd || tab.title}
        className={cn(
          ROW,
          'relative',
          isActive
            ? 'bg-vsc-selection text-vsc-selection-fg'
            : cn('hover:bg-vsc-hover', isPaneVisible ? 'text-vsc-fg-bright' : 'text-vsc-fg')
        )}
      >
        <IndentGuides level={level} />
        <TermIcon size={14} className="shrink-0 text-vsc-muted" />
        {editing ? (
          renameInput
        ) : (
          <>
            <span className="truncate">{tab.title}</span>
            {tab.cwd && (
              <span className="ml-auto text-ui-sm text-vsc-muted shrink-0 truncate max-w-[45%]">
                {basename(tab.cwd)}
              </span>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="h-full w-full flex flex-col bg-vsc-sidebar overflow-hidden">
      <div className="h-panel-header shrink-0 flex items-center justify-between px-3 border-b border-vsc-border select-none">
        <span className="text-ui-sm uppercase tracking-wide font-semibold text-vsc-fg">Terminals</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => createGroup()}
            title="New Group"
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover"
          >
            <FolderPlus size={16} />
          </button>
          <button
            type="button"
            onClick={() => createTab()}
            title="New Terminal"
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      {/* The session you are in. Groups below belong to it. */}
      <div
        data-row
        role="button"
        tabIndex={0}
        title={`Workspace "${workspaceName}" — ${layout.length} groups, ${tabs.length} terminals\nClick for save / rename / open another`}
        onClick={(e) => setMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom, kind: 'workspace-bar', id: null })}
        onContextMenu={(e) => openMenu(e, 'workspace-bar', null)}
        onKeyDown={(e) => {
          if (e.key === 'F2') {
            e.preventDefault();
            startRename('workspace-name', 'current', workspaceName);
          }
        }}
        className={cn(
          'shrink-0 flex items-center gap-2 h-[26px] px-3 border-b border-vsc-border',
          'text-ui-sm text-vsc-fg hover:bg-vsc-hover cursor-default select-none'
        )}
      >
        <Layers size={14} className="shrink-0 text-vsc-muted" />
        {draft?.kind === 'workspace-name' ? (
          renameInput
        ) : (
          <>
            <span className="truncate font-medium">{workspaceName}</span>
            <span className="ml-auto shrink-0 text-vsc-muted">
              {layout.length}g · {tabs.length}t
            </span>
            <ChevronDown size={14} className="shrink-0 text-vsc-muted" />
          </>
        )}
      </div>

      <div
        ref={listRef}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => openMenu(e, 'empty', null)}
        className="flex-1 overflow-y-auto py-1"
      >
        {layout.map(({ group, panes, tabCount }, gi) => {
          const groupCollapsed = collapsed.has(group.id);
          const isActiveGroup = group.id === activeGroupId;
          const isSplit = panes.length > 1;
          const editingGroup = draft?.kind === 'group' && draft.id === group.id;
          // The pane level only exists on screen when the group is split.
          const tabLevel = isSplit ? 2 : 1;

          return (
            <div key={group.id}>
              <div
                data-row
                role="button"
                tabIndex={0}
                onClick={() => setActiveGroup(group.id)}
                onDoubleClick={() => startRename('group', group.id, group.name)}
                onContextMenu={(e) => openMenu(e, 'group', group.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setActiveGroup(group.id);
                  else if (e.key === 'F2') {
                    e.preventDefault();
                    startRename('group', group.id, group.name);
                  } else if (e.key === 'ArrowLeft' && !groupCollapsed) toggle(group.id);
                  else if (e.key === 'ArrowRight' && groupCollapsed) toggle(group.id);
                }}
                style={{ paddingLeft: padFor(0) }}
                title={
                  isActiveGroup
                    ? `${group.name} — on screen`
                    : `${group.name} — click to switch to this group`
                }
                aria-current={isActiveGroup ? 'true' : undefined}
                className={cn(
                  ROW,
                  'relative',
                  isActiveGroup
                    ? 'bg-vsc-selection text-vsc-selection-fg font-semibold'
                    : 'hover:bg-vsc-hover text-vsc-fg'
                )}
              >
                {/* The group that fills the terminal area gets an accent bar as
                    well as the selection fill — "which group am I in" is the
                    one thing this tree must never leave ambiguous. */}
                {isActiveGroup && (
                  <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-[2px] bg-vsc-accent" />
                )}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(group.id);
                  }}
                  className={cn('shrink-0', isActiveGroup ? '' : 'text-vsc-muted')}
                >
                  {groupCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </span>
                <SquareTerminal size={14} className={cn('shrink-0', isActiveGroup ? '' : 'text-vsc-muted')} />
                {editingGroup ? (
                  renameInput
                ) : (
                  <>
                    <span className="truncate">{group.name || `Group ${gi + 1}`}</span>
                    <span
                      className={cn(
                        'ml-auto flex items-center gap-1 text-ui-sm shrink-0',
                        isActiveGroup ? '' : 'text-vsc-muted'
                      )}
                    >
                      {isSplit && (
                        <Columns2 size={12} className="shrink-0" aria-label={`${panes.length} panes`} />
                      )}
                      {tabCount}
                    </span>
                  </>
                )}
              </div>

              {!groupCollapsed && tabCount === 0 && (
                <button
                  type="button"
                  onClick={() => createTab({ groupId: group.id })}
                  className="w-full text-left text-ui-sm text-vsc-muted hover:text-vsc-fg py-0.5"
                  style={{ paddingLeft: padFor(1) }}
                >
                  No terminals — add one
                </button>
              )}

              {!groupCollapsed &&
                panes.map(({ pane, direction }, pi) => {
                  const paneTabs = pane.tabIds.map((id) => tabById.get(id)).filter(Boolean);

                  // A group with a single pane folds that level away entirely.
                  if (!isSplit) {
                    return (
                      <React.Fragment key={pane.id}>
                        {paneTabs.map((tab) => renderTab(tab, tabLevel, isActiveGroup, pane.activeTabId))}
                      </React.Fragment>
                    );
                  }

                  const paneCollapsed = collapsed.has(pane.id);
                  const isActivePane = isActiveGroup && group.activePaneId === pane.id;
                  const PaneIcon = direction === 'vertical' ? Rows2 : Columns2;
                  return (
                    <React.Fragment key={pane.id}>
                      <div
                        data-row
                        role="button"
                        tabIndex={0}
                        onClick={() => setActivePane(pane.id, group.id)}
                        onContextMenu={(e) => openMenu(e, 'pane', pane.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setActivePane(pane.id, group.id);
                          else if (e.key === 'ArrowLeft' && !paneCollapsed) toggle(pane.id);
                          else if (e.key === 'ArrowRight' && paneCollapsed) toggle(pane.id);
                        }}
                        style={{ paddingLeft: padFor(1) }}
                        title={`Pane ${pi + 1} · ${paneTabs.length} terminal${paneTabs.length === 1 ? '' : 's'}`}
                        className={cn(
                          ROW,
                          'relative',
                          isActivePane
                            ? 'bg-vsc-inactive-selection text-vsc-fg-bright'
                            : 'hover:bg-vsc-hover text-vsc-muted'
                        )}
                      >
                        <IndentGuides level={1} />
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(pane.id);
                          }}
                          className="shrink-0"
                        >
                          {paneCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </span>
                        <PaneIcon size={13} className="shrink-0" />
                        <span className="truncate">Pane {pi + 1}</span>
                        <span className="ml-auto text-ui-sm shrink-0">{paneTabs.length}</span>
                      </div>

                      {!paneCollapsed &&
                        paneTabs.map((tab) => renderTab(tab, tabLevel, isActiveGroup, pane.activeTabId))}
                    </React.Fragment>
                  );
                })}
            </div>
          );
        })}

        {/* ---- saved groups ---- */}
        <div className="mt-2 border-t border-vsc-border pt-1">
          <div
            data-row
            role="button"
            tabIndex={0}
            onClick={() => setSavedOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSavedOpen((v) => !v);
            }}
            style={{ paddingLeft: padFor(0) }}
            className={cn(ROW, 'hover:bg-vsc-hover text-vsc-muted')}
          >
            <span className="shrink-0">{savedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
            <Archive size={14} className="shrink-0" />
            <span className="text-ui-sm uppercase tracking-wide font-semibold">Saved</span>
            <span className="ml-auto text-ui-sm shrink-0">{savedGroups.length}</span>
          </div>

          {savedOpen && savedGroups.length === 0 && (
            <p className="px-3 py-1 text-ui-sm text-vsc-muted">
              Right-click a group → Save Group… to keep its terminals here.
            </p>
          )}

          {savedOpen &&
            savedGroups.map((entry) => {
              const editing = draft?.kind === 'saved' && draft.id === entry.id;
              const selected = selectedSavedId === entry.id;
              return (
                <div
                  key={entry.id}
                  data-row
                  role="button"
                  tabIndex={0}
                  // Loading a saved group spawns real PTYs, so it must never be
                  // one stray click away — and it CANNOT be the click action at
                  // all while double-click renames, because a double-click
                  // delivers two clicks first and would load the group twice.
                  // Single click only selects; double-click loads; rename moved
                  // to F2 / the context menu.
                  onClick={() => setSelectedSavedId(entry.id)}
                  onDoubleClick={() => {
                    setSelectedSavedId(entry.id);
                    loadSavedGroup(entry.id, { mode: 'new-group' });
                  }}
                  onContextMenu={(e) => openMenu(e, 'saved', entry.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setSelectedSavedId(entry.id);
                      loadSavedGroup(entry.id, { mode: 'new-group' });
                    } else if (e.key === 'F2') {
                      e.preventDefault();
                      startRename('saved', entry.id, entry.name);
                    }
                  }}
                  style={{ paddingLeft: padFor(1) }}
                  title={`${entry.tabs.length} terminals · saved ${relativeTime(
                    entry.savedAt
                  )}\nDouble-click to load in a new group · right-click for more`}
                  className={cn(
                    ROW,
                    'relative',
                    selected ? 'bg-vsc-inactive-selection text-vsc-fg-bright' : 'hover:bg-vsc-hover text-vsc-fg'
                  )}
                >
                  <IndentGuides level={1} />
                  <Save size={14} className="shrink-0 text-vsc-muted" />
                  {editing ? (
                    renameInput
                  ) : (
                    <>
                      <span className="truncate">{entry.name}</span>
                      <span className="ml-auto text-ui-sm text-vsc-muted shrink-0">
                        {entry.tabs.length} · {relativeTime(entry.savedAt)}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      <ContextMenu
        // Remounting on a drill-down re-runs ContextMenu's placement pass, so a
        // taller "Move to Group" list still flips off the window edge.
        key={`${menu?.kind ?? 'none'}:${menu?.view ?? 'root'}`}
        open={Boolean(menu)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={menuItems()}
      />
    </div>
  );
}

export default TerminalsPanel;
