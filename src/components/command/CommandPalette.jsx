import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  FileCode,
  FolderOpen,
  History,
  Terminal,
  Save,
  Maximize2,
} from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { invoke, listen } from '../../lib/ipc.js';
import { cn } from '../../lib/utils.js';
import { buildPaletteGroups, canHaveFocusBack, focusAfterPalette } from '../../lib/paletteItems.js';
import { commandHistory } from '../../lib/commandIndex.js';
import { focusTerminal, focusWorkspace } from '../../lib/workspaceFocus.js';
import { useShortcuts } from '../../hooks/useShortcuts.js';

/** How many files Go to File asks the backend for — its own default, said out loud. */
const FILE_LIST_LIMIT = 20000;

/** How long changes on disk are let settle before the list is asked for again, as the Explorer waits. */
const RELIST_DELAY_MS = 300;

const count = (n) => n.toLocaleString('en-US');

function iconFor(item) {
  if (item.type === 'recent') return <FolderOpen size={16} />;
  if (item.type === 'history') return <History size={16} />;
  if (item.type === 'file') return <FileCode size={16} />;
  if (item.command === 'save_all') return <Save size={16} />;
  if (item.command === 'toggle_pane_zoom') return <Maximize2 size={16} />;
  return <Terminal size={16} />;
}

/**
 * Every file under the open folder, as the backend lists it, while `wanted`.
 *
 * Go to File listed the Explorer's tree, which stops five levels down, so
 * `src/main/java/com/acme/App.java` was never offered. The list is asked for
 * each time the palette opens to list files and, while it is open, again once
 * changes on disk settle. The last one is kept for the next opening, so the
 * rows do not start over from the tree each time.
 *
 * Null until the backend has answered for this folder, and whenever it
 * cannot — a backend without `fs_list_files` — so the tree stands in.
 */
function useFileListing(wanted, rootPath) {
  const [listing, setListing] = useState(null); // { root, files, truncated }

  useEffect(() => {
    if (!wanted || !rootPath) return undefined;
    let live = true;
    let asked = 0;
    let timer = null;
    let unlisten = null;
    const ask = () => {
      const turn = ++asked;
      invoke('fs_list_files', { limit: FILE_LIST_LIMIT }).then(
        (result) => {
          if (!live || turn !== asked) return;
          setListing(
            Array.isArray(result?.files)
              ? { root: rootPath, files: result.files, truncated: result.truncated === true }
              : null
          );
        },
        (err) => {
          if (!live || turn !== asked) return;
          console.warn('[CommandPalette] No file list from the backend; listing the Explorer\'s tree instead:', err);
          setListing(null);
        }
      );
    };
    ask();
    listen('fs-change', () => {
      clearTimeout(timer);
      timer = setTimeout(ask, RELIST_DELAY_MS);
    }).then(
      (off) => {
        if (live) unlisten = off;
        else off();
      },
      () => {}
    );
    return () => {
      live = false;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [wanted, rootPath]);

  return listing?.root === rootPath ? listing : null;
}

/**
 * Give the keyboard back to `opener`, what had it when the palette opened —
 * or, when that cannot have it (`canHaveFocusBack`), to the terminal on
 * screen, or the open file when there is no terminal.
 */
function giveFocusBack(opener) {
  if (canHaveFocusBack(opener, { body: document.body, onPage: (el) => document.contains(el) })) {
    opener.focus({ preventScroll: true });
  } else {
    focusWorkspace('terminal');
  }
}

/**
 * One result. Kept as it is while its own props are: moving the mouse over
 * the list changes which row is selected and nothing else, and used to draw
 * every row again for each row the pointer crossed.
 */
const PaletteRow = memo(function PaletteRow({ item, index, selected, onPick, onHover }) {
  return (
    <div
      data-palette-row={index}
      onClick={() => onPick(item)}
      onMouseEnter={() => onHover(index)}
      className={cn(
        'h-[22px] px-2 flex items-center gap-2 text-ui cursor-pointer',
        selected ? 'bg-vsc-selection text-vsc-selection-fg' : 'text-vsc-fg'
      )}
    >
      <span className="flex-shrink-0">{iconFor(item)}</span>
      <span className="truncate">{item.title}</span>
      {item.subtitle && (
        <span
          className={cn(
            'truncate text-ui-sm flex-shrink',
            selected ? 'text-vsc-selection-fg' : 'text-vsc-muted'
          )}
        >
          {item.subtitle}
        </span>
      )}
      <span className="flex-1" />
      {item.hint && (
        <kbd className="flex-shrink-0 bg-vsc-button-secondary border border-vsc-border rounded-sm px-1 font-mono text-ui-sm text-vsc-muted">
          {item.hint}
        </kbd>
      )}
    </div>
  );
});

export function CommandPalette() {
  const isOpen = useSettingsStore((s) => s.isCommandPaletteOpen);
  const setOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const setActiveView = useSettingsStore((s) => s.setActiveView);

  const fileTree = useEditorStore((s) => s.fileTree);
  const rootPath = useEditorStore((s) => s.rootPath);
  const openFile = useEditorStore((s) => s.openFile);
  const focusEditor = useEditorStore((s) => s.focusEditor);
  const recentRoots = useEditorStore((s) => s.recentRoots);
  const openRoot = useEditorStore((s) => s.openRoot);
  const saveAll = useEditorStore((s) => s.saveAll);

  const createTerminalTab = useTerminalStore((s) => s.createTab);
  const clearTerminal = useTerminalStore((s) => s.clearTerminal);
  const togglePaneZoom = useTerminalStore((s) => s.togglePaneZoom);
  const writeRaw = useTerminalStore((s) => s.writeRaw);

  const [query, setQuery] = useState('');

  const paletteMode = useSettingsStore((st) => st.commandPaletteMode);
  // So a row never advertises a shortcut the user has rebound.
  const { bindings } = useShortcuts();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  // What had the keyboard when the palette opened, and whether the palette
  // closed itself — `close` hands the keyboard on then.
  const openerRef = useRef(null);
  const closedItselfRef = useRef(false);

  const listing = useFileListing(isOpen && (paletteMode === 'all' || paletteMode === 'files'), rootPath);

  // Closing the palette unmounts its input, and the keyboard fell to the
  // page: a command picked from history was typed into the prompt and Enter
  // then ran nothing until the terminal was clicked, and on Windows and
  // Linux the next Ctrl+W — a word erased in the shell — reached the app's
  // Close Pane instead. So it goes back where it was (`close`), or to where
  // what was chosen put it (`handleSelect`).
  useEffect(() => {
    if (!isOpen) return undefined;
    openerRef.current = document.activeElement;
    closedItselfRef.current = false;
    setQuery('');
    setSelectedIndex(0);
    const focusInput = setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      clearTimeout(focusInput);
      // Closed by something else — its own chord, pressed again — with the
      // keyboard left on the page.
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!closedItselfRef.current && lost) giveFocusBack(openerRef.current);
    };
  }, [isOpen]);

  /**
   * Close, handing the keyboard back where it was — at once, before the
   * chosen item runs, so that a question it asks (Open Recent's "Save
   * a.js?") remembers the right place to give it back to — unless the item
   * puts it somewhere itself (`focusAfterPalette`).
   */
  const close = (handOff = 'opener') => {
    closedItselfRef.current = true;
    if (handOff === 'opener') giveFocusBack(openerRef.current);
    setOpen(false);
  };

  // Read when the palette opens, not subscribed to: history changes on every
  // Enter in every terminal, and a list that reshuffles under the cursor while
  // you are choosing from it is worse than a stale one.
  const history = useMemo(
    () => (isOpen && paletteMode === 'history' ? commandHistory() : []),
    [isOpen, paletteMode]
  );

  // The result rows and the order the arrow keys walk them both come from
  // `buildPaletteGroups` (src/lib/paletteItems.js), so the selection can never
  // run past the last visible row onto an item the user cannot see. Worked
  // out again only when something it reads changes — not when the selection
  // moves.
  const groups = useMemo(
    () =>
      isOpen
        ? buildPaletteGroups({
            fileTree,
            files: listing?.files ?? null,
            filesTruncated: listing?.truncated,
            rootPath,
            query,
            mode: paletteMode,
            bindings,
            recentRoots,
            history,
          })
        : [],
    [isOpen, fileTree, listing, rootPath, query, paletteMode, bindings, recentRoots, history]
  );
  const allFiltered = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // The list can change while it is open — the backend's file list arrives,
  // or files change on disk — and the selection must stay on a row.
  const current = Math.min(selectedIndex, allFiltered.length - 1);

  const runItem = async (item) => {
    if (item.type === 'recent') {
      await openRoot(item.path);
      return;
    }
    if (item.type === 'history') {
      // Typed into the terminal rather than executed behind the user's back:
      // a command from yesterday may want editing, and the newline is the
      // user's to press.
      const tabId = useTerminalStore.getState().activeTabId;
      if (tabId) {
        writeRaw(tabId, item.command);
        setActiveView('terminal');
      }
      return;
    }
    if (item.type === 'file') {
      await openFile(item.path);
      setActiveView('editor');
      return;
    }
    switch (item.command) {
      case 'new_terminal':
        await createTerminalTab();
        setActiveView('terminal');
        return;
      case 'clear_terminal':
        clearTerminal();
        return;
      case 'toggle_pane_zoom':
        // The active pane of the group on screen, as the shortcut does.
        togglePaneZoom?.();
        setActiveView('terminal');
        return;
      case 'save_all':
        await saveAll();
        return;
      default:
        return;
    }
  };

  const handleSelect = async (item) => {
    if (!item) return;
    const handOff = focusAfterPalette(item);
    close(handOff);
    try {
      await runItem(item);
      if (handOff === 'terminal') {
        // Hidden, the terminal panel is shown again and its terminal takes
        // the keyboard as it mounts; with no terminal at all, back it goes.
        if (!focusTerminal()) giveFocusBack(openerRef.current);
      } else if (handOff === 'editor') {
        focusEditor?.();
      }
    } catch (err) {
      console.error('Error executing palette item:', err);
      // Nothing opened to take the keyboard.
      if (handOff !== 'opener') giveFocusBack(openerRef.current);
    }
  };

  // The rows are drawn once per change of the list, so what they call has to
  // stay the same function from one render to the next.
  const selectRef = useRef(handleSelect);
  selectRef.current = handleSelect;
  const pickRow = useCallback((item) => selectRef.current(item), []);
  const hoverRow = useCallback((index) => setSelectedIndex(index), []);

  if (!isOpen) return null;

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((Math.max(current, -1) + 1) % Math.max(1, allFiltered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((Math.max(current, 0) - 1 + allFiltered.length) % Math.max(1, allFiltered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (allFiltered[current]) {
        handleSelect(allFiltered[current]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  let runningIndex = -1;

  return (
    <div
      onClick={() => close()}
      className="fixed inset-0 z-50 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute top-[8px] left-1/2 -translate-x-1/2 w-[600px] max-w-[90vw] bg-vsc-quickinput border border-vsc-widget-border shadow-widget rounded-[6px] overflow-hidden"
      >
        {/* Search Input Bar */}
        <div className="p-2 border-b border-vsc-widget-border">
          <div className="flex items-center gap-2 h-[30px] px-2 rounded-[3px] bg-vsc-input border border-vsc-input-border focus-within:border-vsc-focus transition-colors">
            <Search size={16} className="text-vsc-muted flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={paletteMode === 'files' ? 'Search files by name…' : 'Type a command or search files…'}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-ui text-vsc-fg placeholder:text-vsc-placeholder"
            />
          </div>
        </div>

        {/* Results List */}
        <div className="max-h-[400px] overflow-auto py-1">
          {groups.length > 0 ? (
            groups.map((group) => (
              <div key={group.label}>
                <div className="px-2 h-[22px] flex items-center text-ui-sm text-vsc-muted uppercase tracking-wide">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  runningIndex += 1;
                  return (
                    <PaletteRow
                      key={item.id}
                      item={item}
                      index={runningIndex}
                      selected={runningIndex === current}
                      onPick={pickRow}
                      onHover={hoverRow}
                    />
                  );
                })}
                {/* Not rows: nothing to choose, so the arrow keys pass them by. */}
                {group.more > 0 && (
                  <div data-palette-more className="px-2 h-[22px] flex items-center text-ui-sm text-vsc-muted italic">
                    {`${count(group.more)} more — keep typing to narrow the list`}
                  </div>
                )}
                {group.truncated && (
                  <div data-palette-truncated className="px-2 h-[22px] flex items-center text-ui-sm text-vsc-muted italic">
                    {`Only the first ${count(FILE_LIST_LIMIT)} files in this folder are searched`}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="py-8 text-center text-vsc-muted text-ui-sm italic">
              No matching commands or files.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
