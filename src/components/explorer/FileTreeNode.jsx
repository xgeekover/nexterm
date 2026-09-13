import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode2,
  FileJson,
  FileText,
  File,
  Trash2,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';

const INDENT_SIZE = 8; // px per depth level
const ROW_PADDING = 4; // px base gutter before the guides/chevron start

function getFileIcon(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const className = 'text-vsc-muted shrink-0';
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return <FileCode2 size={16} className={className} />;
    case 'json':
      return <FileJson size={16} className={className} />;
    case 'md':
    case 'txt':
      return <FileText size={16} className={className} />;
    default:
      return <File size={16} className={className} />;
  }
}

// Inline "rename" editor — swaps the row label for a text input. Enter
// commits (awaiting the store's read+write+delete rename flow before
// closing so a failure can be shown next to the input), Escape cancels.
function RenameInput({ initialValue, onCommit, onFinish }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialValue) {
      onFinish();
      return;
    }
    try {
      await onCommit(trimmed);
      onFinish();
    } catch (err) {
      setError(err?.message || 'Rename failed');
    }
  };

  return (
    <div className="flex-1 min-w-0 flex items-center gap-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onFinish();
          }
        }}
        className="flex-1 min-w-0 bg-vsc-input border border-vsc-focus rounded-sm px-1 text-ui text-vsc-fg outline-none"
      />
      {error && <span className="text-ui-sm text-vsc-error truncate shrink-0">{error}</span>}
    </div>
  );
}

// Inline "new file/folder" row rendered as the first child of the target
// folder — reuses the same createFile/createFolder store actions the
// pinned root-level form uses.
function CreateEntryRow({ depth, parentPath, type, createFile, createFolder, onDone }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      onDone();
      return;
    }
    const base = parentPath.replace(/\/+$/, '');
    const fullPath = `${base}/${trimmed.replace(/^\/+/, '')}`;
    try {
      if (type === 'file') {
        await createFile(fullPath);
      } else {
        await createFolder(fullPath);
      }
      onDone();
    } catch (err) {
      setError(err?.message || `Could not create ${type}`);
    }
  };

  const paddingLeft = depth * INDENT_SIZE + ROW_PADDING + 20;

  return (
    <div>
      <div className="flex items-center gap-1 h-[22px] pr-2" style={{ paddingLeft: `${paddingLeft}px` }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onDone();
            }
          }}
          placeholder={type === 'file' ? 'New file name…' : 'New folder name…'}
          className="flex-1 min-w-0 bg-vsc-input border border-vsc-focus rounded-sm px-1 font-mono text-ui-sm text-vsc-fg placeholder-vsc-placeholder outline-none"
        />
      </div>
      {error && (
        <div role="alert" style={{ paddingLeft: `${paddingLeft}px` }} className="text-ui-sm text-vsc-error pr-2 pb-1">
          {error}
        </div>
      )}
    </div>
  );
}

export function FileTreeNode({ node, depth = 0, allNodes = [], onContextMenuRequest }) {
  const expandedFolders = useEditorStore((s) => s.expandedFolders);
  const toggleFolder = useEditorStore((s) => s.toggleFolder);
  const openFile = useEditorStore((s) => s.openFile);
  const readDir = useEditorStore((s) => s.readDir);
  const deletePath = useEditorStore((s) => s.deletePath);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const selectedPath = useEditorStore((s) => s.selectedPath);
  const setSelectedPath = useEditorStore((s) => s.setSelectedPath);
  const renamingPath = useEditorStore((s) => s.renamingPath);
  const cancelRename = useEditorStore((s) => s.cancelRename);
  const renamePath = useEditorStore((s) => s.renamePath);
  const creatingEntry = useEditorStore((s) => s.creatingEntry);
  const setCreatingEntry = useEditorStore((s) => s.setCreatingEntry);
  const createFile = useEditorStore((s) => s.createFile);
  const createFolder = useEditorStore((s) => s.createFolder);

  const isFolder = Boolean(node.is_dir);
  const isExpanded = expandedFolders.has(node.path);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isSelected = selectedPath === node.path || activeTab?.filePath === node.path;
  const isRenaming = renamingPath === node.path;

  // `fs_read_dir` returns a NESTED tree: a directory carries its own entries in
  // `children`, and the array the explorer holds is only the root's. Looking
  // for descendants by path prefix in that top-level array therefore found
  // nothing, so every folder opened empty — which is what made the explorer
  // look like it had no subfolders or files at all.
  const children = isFolder && Array.isArray(node.children) ? node.children : [];

  // A directory at the depth limit comes back with `children: []`, which is
  // indistinguishable from a genuinely empty one — so fetch on first expand
  // rather than telling the user it is empty when it is not.
  const [lazyChildren, setLazyChildren] = useState(null);
  const shownChildren = children.length > 0 ? children : lazyChildren || [];
  useEffect(() => {
    if (!isFolder || !isExpanded || children.length > 0 || lazyChildren) return;
    let cancelled = false;
    readDir(node.path)
      .then((nodes) => {
        if (!cancelled) setLazyChildren(nodes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isFolder, isExpanded, children.length, lazyChildren, node.path, readDir]);

  const openOrToggle = () => {
    if (isFolder) {
      toggleFolder(node.path);
    } else {
      openFile(node.path);
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    setSelectedPath(node.path);
    openOrToggle();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openOrToggle();
    } else if (e.key === 'ArrowRight') {
      if (isFolder && !isExpanded) {
        e.preventDefault();
        toggleFolder(node.path);
      }
    } else if (e.key === 'ArrowLeft') {
      if (isFolder && isExpanded) {
        e.preventDefault();
        toggleFolder(node.path);
      }
    }
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(node.path);
    onContextMenuRequest?.(e, {
      type: isFolder ? 'folder' : 'file',
      path: node.path,
      isDir: isFolder,
      name: node.name,
    });
  };

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleDelete = (e) => {
    e.stopPropagation();
    setConfirmingDelete(true);
  };

  const paddingLeft = depth * INDENT_SIZE + ROW_PADDING;
  const showCreateRow = isFolder && isExpanded && creatingEntry?.parentPath === node.path;

  return (
    <div>
      <ConfirmDialog
        open={confirmingDelete}
        title={isFolder ? 'Delete Folder' : 'Delete File'}
        message={`Are you sure you want to delete '${node.name}'?${isFolder ? ' Its contents will be deleted too.' : ''}`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          setConfirmingDelete(false);
          deletePath(node.path, isFolder);
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-selected={isSelected}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        style={{ paddingLeft: `${paddingLeft}px` }}
        className={cn(
          'group relative flex items-center gap-1 h-[22px] pr-2 text-ui cursor-pointer',
          isSelected
            ? 'bg-vsc-selection text-vsc-selection-fg'
            : 'text-vsc-fg hover:bg-vsc-hover'
        )}
      >
        {/* Indent guides — one per ancestor level */}
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="absolute top-0 bottom-0 border-l border-vsc-indent-guide pointer-events-none"
            style={{ left: `${ROW_PADDING + i * INDENT_SIZE + 4}px` }}
          />
        ))}

        {isFolder ? (
          isExpanded ? (
            <ChevronDown size={16} className="text-vsc-muted shrink-0" />
          ) : (
            <ChevronRight size={16} className="text-vsc-muted shrink-0" />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {isFolder ? (
          isExpanded ? (
            <FolderOpen size={16} className="text-vsc-muted shrink-0" />
          ) : (
            <Folder size={16} className="text-vsc-muted shrink-0" />
          )
        ) : (
          getFileIcon(node.name)
        )}

        {isRenaming ? (
          <RenameInput
            initialValue={node.name}
            onCommit={(newName) => renamePath(node.path, newName)}
            onFinish={cancelRename}
          />
        ) : (
          <span className="truncate flex-1 min-w-0 text-ui">{node.name}</span>
        )}

        {!isRenaming && (
          <button
            type="button"
            onClick={handleDelete}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-error hover:bg-vsc-item-hover transition shrink-0"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {isFolder && isExpanded && (
        <div role="group">
          {showCreateRow && (
            <CreateEntryRow
              depth={depth + 1}
              parentPath={node.path}
              type={creatingEntry.type}
              createFile={createFile}
              createFolder={createFolder}
              onDone={() => setCreatingEntry(null)}
            />
          )}
          {shownChildren.length > 0 ? (
            shownChildren.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                allNodes={allNodes}
                onContextMenuRequest={onContextMenuRequest}
              />
            ))
          ) : !showCreateRow ? (
            <div
              style={{ paddingLeft: `${(depth + 1) * INDENT_SIZE + ROW_PADDING + 20}px` }}
              className="h-[22px] flex items-center text-ui-sm text-vsc-muted italic"
            >
              Empty
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default FileTreeNode;
