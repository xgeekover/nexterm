import React, { useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  SquareTerminal,
  Terminal as TermIcon,
  Plus,
  Save,
  Archive,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { cn } from '../../lib/utils.js';

const ROW = 'h-[22px] flex items-center gap-1.5 pr-2 text-ui cursor-default select-none w-full text-left';
const INDENT = 10;

/** Collect the split tree's groups in DOM order. */
function collectGroups(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => collectGroups(c, acc));
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

/**
 * The "Terminals" view: every terminal group with its terminals nested under
 * it, plus the groups the user has saved by name. Rows mirror the Explorer's
 * density (22px, chevrons, indent guides) so the two trees read the same.
 */
export function TerminalsPanel() {
  const splitTree = useTerminalStore((s) => s.splitTree);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const groupViewMode = useTerminalStore((s) => s.groupViewMode);
  const focusedPaneId = useTerminalStore((s) => s.focusedPaneId);
  const savedGroups = useTerminalStore((s) => s.savedGroups);

  const bindPaneToTab = useTerminalStore((s) => s.bindPaneToTab);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const createTab = useTerminalStore((s) => s.createTab);
  const duplicateTab = useTerminalStore((s) => s.duplicateTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const closePane = useTerminalStore((s) => s.closePane);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const renameGroup = useTerminalStore((s) => s.renameGroup);
  const focusGroup = useTerminalStore((s) => s.focusGroup);
  const showAllGroups = useTerminalStore((s) => s.showAllGroups);
  const closeOthersInGroup = useTerminalStore((s) => s.closeOthersInGroup);
  const closeTabsToTheRight = useTerminalStore((s) => s.closeTabsToTheRight);
  const moveTabToNewGroup = useTerminalStore((s) => s.moveTabToNewGroup);
  const saveGroup = useTerminalStore((s) => s.saveGroup);
  const loadSavedGroup = useTerminalStore((s) => s.loadSavedGroup);
  const renameSavedGroup = useTerminalStore((s) => s.renameSavedGroup);
  const deleteSavedGroup = useTerminalStore((s) => s.deleteSavedGroup);

  const [collapsed, setCollapsed] = useState(() => new Set());
  const [savedOpen, setSavedOpen] = useState(true);
  const [menu, setMenu] = useState(null); // { x, y, kind, id }
  const [draft, setDraft] = useState(null); // { kind: 'group'|'tab'|'saved', id, value }
  const listRef = useRef(null);

  const groups = useMemo(() => collectGroups(splitTree), [splitTree]);
  const tabById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);

  const toggleGroup = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const activateTab = (groupId, tabId) => {
    bindPaneToTab(groupId, tabId);
    switchTab(tabId);
    setActivePane(groupId);
    // Following a terminal into a group that focus mode is hiding would
    // otherwise activate something the user cannot see.
    if (groupViewMode === 'focus' && focusedPaneId !== groupId) focusGroup(groupId);
  };

  const commitDraft = () => {
    if (!draft) return;
    const value = draft.value.trim();
    if (draft.kind === 'group') renameGroup(draft.id, value);
    else if (draft.kind === 'tab') renameTab(draft.id, value);
    else if (draft.kind === 'saved') renameSavedGroup(draft.id, value);
    setDraft(null);
  };

  const startRename = (kind, id, current) => setDraft({ kind, id, value: current || '' });

  const renameInput = (
    <input
      autoFocus
      value={draft?.value ?? ''}
      onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
      onKeyDown={(e) => {
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
  const groupItems = (group) => {
    const onlyGroup = groups.length <= 1;
    const focused = groupViewMode === 'focus' && focusedPaneId === group.id;
    return [
      { key: 'new', label: 'New Terminal in Group', onSelect: () => { setActivePane(group.id); createTab(); } },
      { key: 'split-r', label: 'Split Right', onSelect: () => splitPane(group.id, 'horizontal') },
      { key: 'split-d', label: 'Split Down', onSelect: () => splitPane(group.id, 'vertical') },
      { type: 'separator', key: 's1' },
      { key: 'rename', label: 'Rename Group…', onSelect: () => startRename('group', group.id, group.name) },
      {
        key: 'save',
        label: 'Save Group…',
        disabled: group.tabIds.length === 0,
        disabledReason: group.tabIds.length === 0 ? 'This group has no terminals to save' : undefined,
        onSelect: () => {
          const entry = saveGroup(group.id, group.name);
          if (entry) startRename('saved', entry.id, entry.name);
        },
      },
      { type: 'separator', key: 's2' },
      focused
        ? { key: 'all', label: 'Show All Groups', onSelect: () => showAllGroups() }
        : { key: 'focus', label: 'Focus This Group', disabled: onlyGroup, disabledReason: onlyGroup ? 'There is only one group' : undefined, onSelect: () => focusGroup(group.id) },
      { type: 'separator', key: 's3' },
      {
        key: 'close',
        label: 'Close Group',
        disabled: onlyGroup,
        disabledReason: onlyGroup ? 'The last group cannot be closed' : undefined,
        onSelect: () => closePane(group.id),
      },
    ];
  };

  const tabItems = (group, tab) => {
    const idx = group.tabIds.indexOf(tab.id);
    const others = group.tabIds.length > 1;
    const toRight = idx >= 0 && idx < group.tabIds.length - 1;
    return [
      { key: 'open', label: 'Open', onSelect: () => activateTab(group.id, tab.id) },
      { type: 'separator', key: 's1' },
      { key: 'rename', label: 'Rename…', onSelect: () => startRename('tab', tab.id, tab.title) },
      { key: 'dup', label: 'Duplicate', onSelect: () => duplicateTab(tab.id) },
      { key: 'copy-path', label: 'Copy Path', disabled: !tab.cwd, disabledReason: !tab.cwd ? 'This terminal has no directory yet' : undefined, onSelect: () => navigator.clipboard?.writeText(tab.cwd || '') },
      { type: 'separator', key: 's2' },
      {
        key: 'move-new',
        label: 'Move to New Group',
        disabled: !others,
        disabledReason: !others ? 'It is already the only terminal in its group' : undefined,
        onSelect: () => moveTabToNewGroup(tab.id),
      },
      { type: 'separator', key: 's3' },
      { key: 'close', label: 'Close', onSelect: () => closeTab(tab.id) },
      {
        key: 'close-others',
        label: 'Close Others in Group',
        disabled: !others,
        disabledReason: !others ? 'There are no other terminals in this group' : undefined,
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

  const savedItems = (entry) => [
    { key: 'load', label: 'Load in New Group', onSelect: () => loadSavedGroup(entry.id) },
    { key: 'load-here', label: 'Load into Current Group', onSelect: () => loadSavedGroup(entry.id, { mode: 'replace' }) },
    { type: 'separator', key: 's1' },
    { key: 'rename', label: 'Rename…', onSelect: () => startRename('saved', entry.id, entry.name) },
    { key: 'delete', label: 'Delete', onSelect: () => deleteSavedGroup(entry.id) },
  ];

  const emptyItems = () => [
    { key: 'new-term', label: 'New Terminal', onSelect: () => createTab() },
    { key: 'new-group', label: 'New Group', onSelect: () => splitPane(activePaneId, 'horizontal') },
    { type: 'separator', key: 's1' },
    { key: 'all', label: 'Show All Groups', disabled: groupViewMode !== 'focus', disabledReason: groupViewMode !== 'focus' ? 'Already showing every group' : undefined, onSelect: () => showAllGroups() },
  ];

  const openMenu = (e, kind, id) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, kind, id });
  };

  const menuItems = () => {
    if (!menu) return [];
    if (menu.kind === 'group') {
      const g = groups.find((x) => x.id === menu.id);
      return g ? groupItems(g) : [];
    }
    if (menu.kind === 'tab') {
      const g = groups.find((x) => x.tabIds.includes(menu.id));
      const t = tabById.get(menu.id);
      return g && t ? tabItems(g, t) : [];
    }
    if (menu.kind === 'saved') {
      const e = savedGroups.find((x) => x.id === menu.id);
      return e ? savedItems(e) : [];
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

  return (
    <div className="h-full w-full flex flex-col bg-vsc-sidebar overflow-hidden">
      <div className="h-panel-header shrink-0 flex items-center justify-between px-3 border-b border-vsc-border select-none">
        <span className="text-ui-sm uppercase tracking-wide font-semibold text-vsc-fg">Terminals</span>
        <button
          type="button"
          onClick={() => createTab()}
          title="New Terminal"
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover"
        >
          <Plus size={16} />
        </button>
      </div>

      <div
        ref={listRef}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => openMenu(e, 'empty', null)}
        className="flex-1 overflow-y-auto py-1"
      >
        {groups.map((group, gi) => {
          const isCollapsed = collapsed.has(group.id);
          const isActiveGroup = group.id === activePaneId;
          const groupTabs = group.tabIds.map((id) => tabById.get(id)).filter(Boolean);
          const editingGroup = draft?.kind === 'group' && draft.id === group.id;

          return (
            <div key={group.id}>
              <div
                data-row
                role="button"
                tabIndex={0}
                onClick={() => setActivePane(group.id)}
                onDoubleClick={() => startRename('group', group.id, group.name)}
                onContextMenu={(e) => openMenu(e, 'group', group.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setActivePane(group.id);
                  else if (e.key === 'ArrowLeft' && !isCollapsed) toggleGroup(group.id);
                  else if (e.key === 'ArrowRight' && isCollapsed) toggleGroup(group.id);
                }}
                style={{ paddingLeft: 4 }}
                className={cn(
                  ROW,
                  isActiveGroup ? 'bg-vsc-selection text-vsc-selection-fg' : 'hover:bg-vsc-hover text-vsc-fg'
                )}
              >
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGroup(group.id);
                  }}
                  className="shrink-0 text-vsc-muted"
                >
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </span>
                <SquareTerminal size={14} className="shrink-0 text-vsc-muted" />
                {editingGroup ? (
                  renameInput
                ) : (
                  <>
                    <span className="truncate">{group.name || `Group ${gi + 1}`}</span>
                    <span className="ml-auto text-ui-sm text-vsc-muted shrink-0">{groupTabs.length}</span>
                  </>
                )}
              </div>

              {!isCollapsed &&
                groupTabs.map((tab) => {
                  const editingTab = draft?.kind === 'tab' && draft.id === tab.id;
                  const isActive = tab.id === activeTabId;
                  return (
                    <div
                      key={tab.id}
                      data-row
                      role="button"
                      tabIndex={0}
                      onClick={() => activateTab(group.id, tab.id)}
                      onDoubleClick={() => startRename('tab', tab.id, tab.title)}
                      onContextMenu={(e) => openMenu(e, 'tab', tab.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') activateTab(group.id, tab.id);
                      }}
                      style={{ paddingLeft: 4 + INDENT * 2 }}
                      title={tab.cwd || tab.title}
                      className={cn(
                        ROW,
                        'relative',
                        isActive ? 'bg-vsc-selection text-vsc-selection-fg' : 'hover:bg-vsc-hover text-vsc-fg'
                      )}
                    >
                      {/* indent guide, matching the Explorer tree */}
                      <span
                        aria-hidden="true"
                        className="absolute top-0 bottom-0 border-l border-vsc-indent-guide"
                        style={{ left: 4 + INDENT }}
                      />
                      <TermIcon size={14} className="shrink-0 text-vsc-muted" />
                      {editingTab ? (
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
            style={{ paddingLeft: 4 }}
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
              return (
                <div
                  key={entry.id}
                  data-row
                  role="button"
                  tabIndex={0}
                  onClick={() => loadSavedGroup(entry.id)}
                  onDoubleClick={() => startRename('saved', entry.id, entry.name)}
                  onContextMenu={(e) => openMenu(e, 'saved', entry.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') loadSavedGroup(entry.id);
                  }}
                  style={{ paddingLeft: 4 + INDENT * 2 }}
                  title={`${entry.tabs.length} terminals · saved ${relativeTime(entry.savedAt)}`}
                  className={cn(ROW, 'hover:bg-vsc-hover text-vsc-fg')}
                >
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
