import React, { useCallback, useEffect, useState } from 'react';
import {
  FolderPlus,
  FolderOpen,
  FilePlus,
  RefreshCw,
  ChevronsDownUp,
  ChevronDown,
  ChevronRight,
  Check,
  X,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { FileTreeNode } from './FileTreeNode.jsx';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';

function parentPathOf(path) {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function relativeTo(rootPath, path) {
  const base = rootPath.replace(/\/+$/, '');
  if (path === base) return '.';
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path;
}

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
  const rootPath = useEditorStore((s) => s.rootPath);
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
  const clipboard = useEditorStore((s) => s.clipboard);
  const copyToClipboard = useEditorStore((s) => s.copyToClipboard);
  const cutToClipboard = useEditorStore((s) => s.cutToClipboard);
  const pasteClipboard = useEditorStore((s) => s.pasteClipboard);

  const [newItemName, setNewItemName] = useState('');
  const [explorerError, setExplorerError] = useState('');
  const [rootExpanded, setRootExpanded] = useState(true);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, target }
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { path, isDir, name }

  useEffect(() => {
    refreshExplorer();
  }, [refreshExplorer]);

  const isCreatingAtRoot = creatingEntry?.parentPath === rootPath;

  const handleCreateSubmit = async (e) => {
    e?.preventDefault();
    const trimmed = newItemName.trim();
    if (!trimmed) {
      setCreatingEntry(null);
      return;
    }

    const base = rootPath.replace(/\/+$/, '');
    const fullPath = `${base}/${trimmed.replace(/^\/+/, '')}`;
    try {
      if (creatingEntry.type === 'file') {
        await createFile(fullPath);
      } else if (creatingEntry.type === 'folder') {
        await createFolder(fullPath);
      }
      setNewItemName('');
      setCreatingEntry(null);
      setExplorerError('');
    } catch (err) {
      setExplorerError(`Could not create ${creatingEntry.type}: ${err.message}`);
    }
  };

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
    const newParent = isFile ? parentPathOf(target.path) : target.path;

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

  // Find root nodes (direct children of the workspace root)
  const rootPrefix = rootPath.replace(/\/+$/, '') + '/';
  const rootNodes = fileTree.filter((n) => {
    if (n.path === rootPath) return false;
    if (!n.path.startsWith(rootPrefix)) return false;
    return !n.path.slice(rootPrefix.length).includes('/');
  });

  const rootName = rootPath.replace(/\/+$/, '').split('/').filter(Boolean).pop() || rootPath;

  return (
    <div className="group flex flex-col h-full w-full bg-vsc-sidebar select-none overflow-hidden">
      {/* Section header */}
      <div className="h-[35px] flex items-center px-4 shrink-0">
        <span className="text-ui-sm uppercase tracking-wide text-vsc-fg font-semibold">
          Explorer
        </span>
      </div>

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
            onClick={() => {
              setNewItemName('');
              setCreatingEntry({ parentPath: rootPath, type: 'file' });
            }}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title="New File"
          >
            <FilePlus size={16} />
          </button>

          <button
            type="button"
            onClick={() => {
              setNewItemName('');
              setCreatingEntry({ parentPath: rootPath, type: 'folder' });
            }}
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

      {/* Inline Creation Input (workspace root only — nested folders get an
          inline row inside the tree itself, see FileTreeNode) */}
      {isCreatingAtRoot && (
        <form onSubmit={handleCreateSubmit} className="px-2 py-1 border-b border-vsc-border shrink-0">
          <div className="flex items-center gap-1 bg-vsc-input border border-vsc-focus rounded-sm px-2 py-1">
            <span className="text-ui-sm font-mono text-vsc-muted">/</span>
            <input
              type="text"
              autoFocus
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={`New ${creatingEntry.type} name…`}
              className="flex-1 bg-transparent border-none outline-none font-mono text-ui-sm text-vsc-fg placeholder-vsc-placeholder"
            />
            <button type="submit" className="text-vsc-ok hover:text-vsc-fg p-0.5">
              <Check size={14} />
            </button>
            <button
              type="button"
              onClick={() => setCreatingEntry(null)}
              className="text-vsc-muted hover:text-vsc-error p-0.5"
            >
              <X size={14} />
            </button>
          </div>
        </form>
      )}

      {/* Directory Tree */}
      {rootExpanded && (
        <div
          className="flex-1 overflow-y-auto"
          onClick={() => setSelectedPath(null)}
          onContextMenu={handleEmptyAreaContextMenu}
        >
          {explorerError && (
            <div role="alert" className="px-3 py-1 text-ui-sm text-vsc-error border-b border-vsc-border">
              {explorerError}
            </div>
          )}
          {rootNodes.length > 0 ? (
            rootNodes.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                allNodes={fileTree}
                onContextMenuRequest={handleTreeContextMenu}
              />
            ))
          ) : (
            <div className="px-4 py-3 text-center text-vsc-muted text-ui-sm italic">
              {isLoadingTree ? 'Loading files…' : 'No files found'}
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
