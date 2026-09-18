import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Filter,
  FolderPlus,
  FolderOpen,
  FilePlus,
  RefreshCw,
  ChevronsDownUp,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { TreeRow, NameInput, indentFor, ROW_HEIGHT } from './TreeRow.jsx';
import { filterTree, flattenVisible, navigate } from './treeRows.js';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { basename, dirname, join, relativeTo, samePath } from '../../lib/paths.js';
import { cn } from '../../lib/utils.js';

async function writeToSystemClipboard(text) {
  try {
    await navigator?.clipboard?.writeText?.(text);
  } catch (err) {
    console.error('[FileExplorer] Failed to write to the system clipboard:', err);
  }
}

export function FileExplorer() {
  const fileTree = useEditorStore((s) => s.fileTree);
  const isLoadingTree = useEditorStore((s) => s.isLoadingTree);
  const refreshExplorer = useEditorStore((s) => s.refreshExplorer);
  // Until the backend has been asked, `rootPath` is only a placeholder; showing
  // it would flash a folder that is not open.
  const rootPath = useEditorStore((s) => (s.rootResolved ? s.rootPath : null));
  const pickRoot = useEditorStore((s) => s.pickRoot);
  const createFile = useEditorStore((s) => s.createFile);
  const createFolder = useEditorStore((s) => s.createFolder);
  const deletePath = useEditorStore((s) => s.deletePath);
  const expandedFolders = useEditorStore((s) => s.expandedFolders);
  const toggleFolder = useEditorStore((s) => s.toggleFolder);
  const openFile = useEditorStore((s) => s.openFile);
  const setSelectedPath = useEditorStore((s) => s.setSelectedPath);
  const creatingEntry = useEditorStore((s) => s.creatingEntry);
  const setCreatingEntry = useEditorStore((s) => s.setCreatingEntry);
  const beginRename = useEditorStore((s) => s.beginRename);
  const cancelRename = useEditorStore((s) => s.cancelRename);
  const renamingPath = useEditorStore((s) => s.renamingPath);
  const renamePath = useEditorStore((s) => s.renamePath);
  const setFolderExpanded = useEditorStore((s) => s.setFolderExpanded);
  const selectedPath = useEditorStore((s) => s.selectedPath);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const clipboard = useEditorStore((s) => s.clipboard);
  const copyToClipboard = useEditorStore((s) => s.copyToClipboard);
  const cutToClipboard = useEditorStore((s) => s.cutToClipboard);
  const pasteClipboard = useEditorStore((s) => s.pasteClipboard);

  const [explorerError, setExplorerError] = useState('');
  const [rootExpanded, setRootExpanded] = useState(true);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, target }
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { path, isDir, name }

  // A remount (the side bar reopened) re-reads the tree. The FIRST mount runs
  // before App has asked the backend for the workspace root — a child's
  // effects run before its parent's — so reading then meant reading the
  // placeholder '/workspace', which the backend refuses. editorStore.init
  // loads the tree itself as soon as the real root is known.
  useEffect(() => {
    if (useEditorStore.getState().rootResolved) refreshExplorer();
  }, [refreshExplorer]);


  const handleCollapseAll = () => {
    Array.from(expandedFolders).forEach((path) => toggleFolder(path));
  };

  // A single context menu instance lives here (rather than per-row) so only
  // one can ever be open, and it can see clipboard/rootPath state directly.
  const handleTreeContextMenu = useCallback((e, target) => {
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  const handleEmptyAreaContextMenu = (e) => {
    // Rows call stopPropagation() on their own context menu, so this only
    // fires for a right-click on the empty space below the tree.
    e.preventDefault();
    setSelectedPath(null);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      target: { type: 'empty', path: rootPath, isDir: true, name: rootPath },
    });
  };

  const buildMenuItems = (target) => {
    const isEmpty = target.type === 'empty';
    const isFile = target.type === 'file';
    const isFolderish = !isFile; // folder row or the empty area (== workspace root)
    const newParent = isFile ? dirname(target.path) : target.path;

    const items = [];
    const pushSeparator = () => {
      if (items.length > 0 && items[items.length - 1].type !== 'separator') {
        items.push({ type: 'separator', key: `sep-${items.length}` });
      }
    };
    const noSelectionReason = isEmpty ? 'No file or folder selected' : undefined;

    items.push({
      key: 'new-file',
      label: 'New File…',
      onSelect: () => setCreatingEntry({ parentPath: newParent, type: 'file' }),
    });
    items.push({
      key: 'new-folder',
      label: 'New Folder…',
      onSelect: () => setCreatingEntry({ parentPath: newParent, type: 'folder' }),
    });

    if (isFile) {
      pushSeparator();
      items.push({
        key: 'open',
        label: 'Open',
        onSelect: () => openFile(target.path),
      });
    }

    pushSeparator();
    items.push({
      key: 'cut',
      label: 'Cut',
      disabled: isEmpty,
      disabledReason: noSelectionReason,
      onSelect: () => cutToClipboard(target.path, target.isDir),
    });
    items.push({
      key: 'copy',
      label: 'Copy',
      disabled: isEmpty,
      disabledReason: noSelectionReason,
      onSelect: () => copyToClipboard(target.path, target.isDir),
    });
    const canPaste = Boolean(clipboard) && isFolderish;
    items.push({
      key: 'paste',
      label: 'Paste',
      disabled: !canPaste,
      disabledReason: !clipboard
        ? 'Nothing to cut or copy yet'
        : !isFolderish
          ? 'Cannot paste into a file'
          : undefined,
      onSelect: () => {
        pasteClipboard(target.path).catch((err) => setExplorerError(err.message));
      },
    });

    pushSeparator();
    items.push({
      key: 'copy-path',
      label: 'Copy Path',
      disabled: isEmpty,
      disabledReason: noSelectionReason,
      onSelect: () => writeToSystemClipboard(target.path),
    });
    items.push({
      key: 'copy-relative-path',
      label: 'Copy Relative Path',
      disabled: isEmpty,
      disabledReason: noSelectionReason,
      onSelect: () => writeToSystemClipboard(relativeTo(rootPath, target.path)),
    });

    pushSeparator();
    items.push({
      key: 'rename',
      label: 'Rename…',
      disabled: isEmpty,
      disabledReason: noSelectionReason,
      onSelect: () => beginRename(target.path),
    });
    items.push({
      key: 'delete',
      label: 'Delete',
      disabled: isEmpty,
      disabledReason: noSelectionReason,
      danger: true,
      onSelect: () => setDeleteConfirm({ path: target.path, isDir: target.isDir, name: target.name }),
    });

    return items;
  };

  // --- the visible rows, and the keyboard that walks them ----------------
  // Narrowing the tree you are looking at, which is a different question from
  // the one ⌘P answers ("find me this file anywhere"). Kept out of the store:
  // nothing else needs to know, and it must not survive a reload as a tree
  // that silently hides most of the project.
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);

  const filtered = useMemo(() => filterTree(fileTree, filter), [fileTree, filter]);

  const rows = useMemo(() => {
    if (!filter.trim()) return flattenVisible(fileTree, expandedFolders);
    // Every folder leading to a match is opened for the duration, without
    // touching what the user had expanded — clearing the filter puts their own
    // tree back exactly as it was.
    const opened = new Set([...expandedFolders, ...filtered.expand]);
    return flattenVisible(filtered.nodes, opened);
  }, [fileTree, expandedFolders, filter, filtered]);

  const [focusIndex, setFocusIndex] = useState(0);
  const [treeFocused, setTreeFocused] = useState(false);
  const treeRef = useRef(null);

  const activeFilePath = tabs.find((t) => t.id === activeTabId)?.filePath || null;

  // Where the inline "new file/folder" input goes: the first child of the
  // folder being added to, or the top of the tree for the workspace root.
  const createIndex = useMemo(() => {
    if (!creatingEntry) return -1;
    if (samePath(creatingEntry.parentPath, rootPath)) return 0;
    const parent = rows.findIndex((r) => samePath(r.node.path, creatingEntry.parentPath));
    return parent === -1 ? -1 : parent + 1;
  }, [creatingEntry, rows, rootPath]);

  const createDepth = useMemo(() => {
    if (createIndex <= 0) return 0;
    return (rows[createIndex - 1]?.depth ?? 0) + 1;
  }, [createIndex, rows]);

  // A row that scrolls out of view under the arrow keys is a row the user
  // cannot see they have selected.
  useEffect(() => {
    if (!treeFocused) return;
    const path = rows[focusIndex]?.node.path;
    if (!path) return;
    treeRef.current
      ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, rows, treeFocused]);

  // Keep the focused row pointing at the selection when it changes by mouse.
  useEffect(() => {
    if (!selectedPath) return;
    const idx = rows.findIndex((r) => samePath(r.node.path, selectedPath));
    if (idx !== -1) setFocusIndex(idx);
  }, [selectedPath, rows]);

  const activateRow = useCallback(
    (row) => {
      setSelectedPath(row.node.path);
      if (row.isFolder) toggleFolder(row.node.path);
      else openFile(row.node.path);
    },
    [setSelectedPath, toggleFolder, openFile]
  );

  const handleTreeKeyDown = (e) => {
    // While an inline input is open it owns the keyboard.
    if (creatingEntry || renamingPath) return;
    if (e.key === 'F2' && selectedPath) {
      e.preventDefault();
      beginRename(selectedPath);
      return;
    }
    const action = navigate(rows, focusIndex, e.key);
    if (!action) return;
    e.preventDefault();
    if (action.index !== undefined) {
      setFocusIndex(action.index);
      setSelectedPath(rows[action.index].node.path);
    } else if (action.expand) {
      setFolderExpanded(action.expand, true);
    } else if (action.collapse) {
      setFolderExpanded(action.collapse, false);
    } else if (action.open) {
      const row = rows[focusIndex];
      if (row) activateRow(row);
    }
  };

  const renderCreateRow = () => (
    <div
      className="flex items-center gap-1 pr-2"
      style={{ height: ROW_HEIGHT, paddingLeft: indentFor(createDepth) + 16 }}
    >
      <NameInput
        initialValue=""
        placeholder={creatingEntry?.type === 'folder' ? 'Folder name' : 'File name'}
        onCommit={async (name) => {
          const full = join(creatingEntry.parentPath, name);
          if (creatingEntry.type === 'folder') await createFolder(full);
          else await createFile(full);
        }}
        onCancel={() => setCreatingEntry(null)}
      />
    </div>
  );

  if (!rootPath) {
    return (
      <div className="flex flex-col h-full w-full bg-vsc-sidebar select-none overflow-hidden">
        <div className="h-[35px] flex items-center px-4 shrink-0">
          <span className="text-ui-sm uppercase tracking-wide text-vsc-fg font-semibold">
            Explorer
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-ui-sm text-vsc-muted">No folder opened</p>
          <button
            type="button"
            onClick={() => pickRoot()}
            className="px-3 py-1 rounded-sm text-ui-sm bg-vsc-accent hover:bg-vsc-accent-hover text-vsc-accent-fg transition"
          >
            Open Folder
          </button>
        </div>
      </div>
    );
  }

  // NOTE: `fs_read_dir` already returns exactly the root's direct children,
  // each carrying its own `children` — so `fileTree` IS the root listing and
  // nothing here re-derives it. The old code did, by matching a "<root>/"
  // prefix against every path, which on Windows compared `C:\\proj\\src`
  // against `C:\\proj/` and discarded every entry, leaving the explorer
  // permanently empty.
  const rootName = basename(rootPath) || rootPath;

  return (
    <div className="group flex flex-col h-full w-full bg-vsc-sidebar select-none overflow-hidden">
      {/* Section header */}
      <div className="h-[35px] flex items-center justify-between pl-4 pr-1 shrink-0">
        <span className="text-ui-sm uppercase tracking-wide text-vsc-fg font-semibold">
          Explorer
        </span>
        <button
          type="button"
          aria-pressed={filterOpen}
          onClick={() => {
            setFilterOpen((open) => {
              if (open) setFilter('');
              return !open;
            });
          }}
          className={cn(
            'p-1 rounded-sm transition',
            filterOpen
              ? 'bg-vsc-item-active text-vsc-fg'
              : 'text-vsc-muted hover:bg-vsc-item-hover hover:text-vsc-fg'
          )}
          title="Filter the tree"
        >
          <Filter size={14} />
        </button>
      </div>

      {filterOpen && (
        <div className="px-2 pb-1 shrink-0">
          <div className="flex items-center gap-1 px-1 bg-vsc-input border border-vsc-input-border rounded-[2px] focus-within:border-vsc-focus">
            <input
              autoFocus
              type="text"
              value={filter}
              placeholder="Filter by name"
              aria-label="Filter the tree by name"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // The field owns these: Escape would otherwise also read as
                // "dismiss whatever is on screen", and the arrows belong to
                // the tree only while the tree has focus.
                e.stopPropagation();
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (filter) setFilter('');
                  else setFilterOpen(false);
                }
              }}
              className="flex-1 min-w-0 h-[22px] px-1 bg-transparent text-ui-sm text-vsc-fg outline-none placeholder:text-vsc-placeholder"
            />
            {filter.trim() && (
              <span
                data-filter-count
                className={cn('shrink-0 pr-1 text-ui-sm tabular-nums', filtered.matches === 0 ? 'text-vsc-error' : 'text-vsc-muted')}
              >
                {filtered.matches === 0 ? 'none' : filtered.matches}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Folder header row */}
      <div className="h-[22px] flex items-center justify-between pl-2 pr-1 shrink-0">
        <button
          type="button"
          onClick={() => setRootExpanded((v) => !v)}
          className="flex items-center gap-1 min-w-0 text-ui-sm font-semibold text-vsc-fg hover:text-vsc-fg-bright"
        >
          {rootExpanded ? (
            <ChevronDown size={16} className="text-vsc-muted shrink-0" />
          ) : (
            <ChevronRight size={16} className="text-vsc-muted shrink-0" />
          )}
          <span className="truncate uppercase">{rootName}</span>
        </button>

        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            type="button"
            onClick={() => pickRoot()}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title={`Open Folder… (current: ${rootPath})`}
          >
            <FolderOpen size={16} />
          </button>

          <button
            type="button"
            onClick={() => setCreatingEntry({ parentPath: rootPath, type: 'file' })}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title="New File"
          >
            <FilePlus size={16} />
          </button>

          <button
            type="button"
            onClick={() => setCreatingEntry({ parentPath: rootPath, type: 'folder' })}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title="New Folder"
          >
            <FolderPlus size={16} />
          </button>

          <button
            type="button"
            onClick={() => refreshExplorer()}
            disabled={isLoadingTree}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition disabled:opacity-50"
            title="Refresh Explorer"
          >
            <RefreshCw size={16} className={isLoadingTree ? 'animate-spin' : ''} />
          </button>

          <button
            type="button"
            onClick={handleCollapseAll}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title="Collapse All"
          >
            <ChevronsDownUp size={16} />
          </button>
        </div>
      </div>

      {/* Directory tree — a flat list of the rows actually on screen, which
          is how VS Code models it: "the next row" is the next entry, whatever
          its depth, so arrow keys, focus and scrolling are all one dimension. */}
      {rootExpanded && (
        <div
          ref={treeRef}
          role="tree"
          aria-label="Files"
          tabIndex={0}
          onFocus={() => setTreeFocused(true)}
          onBlur={() => setTreeFocused(false)}
          onKeyDown={handleTreeKeyDown}
          className="flex-1 overflow-auto outline-none"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelectedPath(null);
          }}
          onContextMenu={handleEmptyAreaContextMenu}
        >
          {explorerError && (
            <div role="alert" className="px-3 py-1 text-ui-sm text-vsc-error border-b border-vsc-border">
              {explorerError}
            </div>
          )}

          {rows.length === 0 && createIndex === -1 ? (
            <div className="px-4 py-3 text-vsc-muted text-ui-sm">
              {isLoadingTree ? 'Loading…' : 'This folder is empty'}
            </div>
          ) : (
            <div className="min-w-max">
              {rows.map((row, i) => (
                <React.Fragment key={row.node.path}>
                  {i === createIndex && renderCreateRow()}
                  <TreeRow
                    row={row}
                    isSelected={
                      samePath(selectedPath || '', row.node.path) ||
                      (!selectedPath && samePath(activeFilePath || '', row.node.path))
                    }
                    isFocused={treeFocused}
                    isCut={clipboard?.mode === 'cut' && samePath(clipboard.path, row.node.path)}
                    onActivate={activateRow}
                    onToggle={(r) => toggleFolder(r.node.path)}
                    onContextMenu={(e, r) =>
                      handleTreeContextMenu(e, {
                        type: r.isFolder ? 'folder' : 'file',
                        path: r.node.path,
                        isDir: r.isFolder,
                        name: r.node.name,
                      })
                    }
                    renaming={samePath(renamingPath || '', row.node.path)}
                    onRenameCommit={(name) => renamePath(row.node.path, name)}
                    onRenameCancel={cancelRename}
                  />
                </React.Fragment>
              ))}
              {createIndex >= rows.length && renderCreateRow()}
            </div>
          )}
        </div>
      )}

      <ContextMenu
        open={Boolean(contextMenu)}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={contextMenu ? buildMenuItems(contextMenu.target) : []}
        onClose={() => setContextMenu(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteConfirm)}
        title={deleteConfirm?.isDir ? 'Delete Folder' : 'Delete File'}
        message={`Are you sure you want to delete '${deleteConfirm?.name}'?${deleteConfirm?.isDir ? ' Its contents will be deleted too.' : ''}`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const target = deleteConfirm;
          setDeleteConfirm(null);
          if (!target) return;
          deletePath(target.path, target.isDir).catch((err) => setExplorerError(err.message));
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}

export default FileExplorer;
