import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  FileCode,
  FolderOpen,
  History,
  Terminal,
  Save,
  Maximize2,
  BellRing,
  CheckCheck,
  Columns3,
  ArrowLeftRight,
  Pencil,
  X,
  PanelTop,
} from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { invoke, listen } from '../../lib/ipc.js';
import { cn } from '../../lib/utils.js';
import { buildPaletteGroups, canHaveFocusBack, focusAfterPalette } from '../../lib/paletteItems.js';
import { commandHistory } from '../../lib/commandIndex.js';
import { notifyTerminal } from '../../lib/terminalNotice.js';
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
  if (item.command === 'go_to_unread_notification') return <BellRing size={16} />;
  if (item.command === 'mark_notifications_read') return <CheckCheck size={16} />;
  if (item.command === 'equalize_splits') return <Columns3 size={16} />;
  if (item.command === 'swap_pane') return <ArrowLeftRight size={16} />;
  if (item.command === 'rename_terminal') return <Pencil size={16} />;
  if (item.command === 'close_terminal') return <X size={16} />;
  if (item.type === 'pane') return <PanelTop size={16} />;
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
 * Swallow the repeats of `key`, still held from the press that chose a row,
 * wherever the keyboard has gone since — until the key is let go, pressed
 * afresh (a keydown that is not a repeat), or the window loses focus. In
 * the capture phase, so a terminal never sees them.
 */
function swallowRepeatsOf(key) {
  const stop = () => {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', stop);
  };
  const onDown = (e) => {
    if (e.key !== key) return;
    if (!e.repeat) {
      stop();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onUp = (e) => {
    if (e.key === key) stop();
  };
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', stop);
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
  const goToLatestUnread = useTerminalStore((s) => s.goToLatestUnread);
  const markAllNotificationsRead = useTerminalStore((s) => s.markAllNotificationsRead);
  const writeRaw = useTerminalStore((s) => s.writeRaw);
  const equalizeSplits = useTerminalStore((s) => s.equalizeSplits);
  const swapActivePane = useTerminalStore((s) => s.swapActivePane);
  const requestTabRename = useTerminalStore((s) => s.requestTabRename);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const typingHiddenNow = useTerminalStore((s) => s.typingHiddenNow);

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

  // "Swap Pane With…": the other panes of the group on screen, or why there
  // are none (a zoomed group, a group of one pane). Read when the pick
  // opens, as the history is, for the same reason — a list that moves under
  // the selection is worse than one a moment old.
  const swap = useMemo(
    () =>
      isOpen && paletteMode === 'swap-pane'
        ? useTerminalStore.getState().swapTargets?.() ?? { panes: [], note: null }
        : null,
    [isOpen, paletteMode]
  );

  // Another mode while open — a row that opens a pick, a chord pressed over
  // the palette — starts its list from the top with nothing typed: what was
  // typed to find "Swap Pane With…" is not the name of a pane.
  // (Opening is the effect above's: this only answers a change while open.)
  const shownModeRef = useRef(null);
  useEffect(() => {
    if (!isOpen) {
      shownModeRef.current = null;
      return;
    }
    if (shownModeRef.current === null || shownModeRef.current === paletteMode) {
      shownModeRef.current = paletteMode;
      return;
    }
    shownModeRef.current = paletteMode;
    setQuery('');
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, [isOpen, paletteMode]);

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
            panes: swap?.panes ?? [],
            panesNote: swap?.note ?? null,
          })
        : [],
    [isOpen, fileTree, listing, rootPath, query, paletteMode, bindings, recentRoots, history, swap]
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
        setActiveView('terminal');
        // Never into a password prompt (spec P4): typed there, the command
        // would be taken as the password, shown nowhere. Asked of the
        // backend too, which reads the terminal now.
        if (await typingHiddenNow?.(tabId)) {
          notifyTerminal(tabId, 'Not typed — this terminal is asking for a password, and NexTerm types nothing into a password prompt. Answer the prompt first.');
          return;
        }
        writeRaw(tabId, item.command);
      }
      return;
    }
    if (item.type === 'file') {
      await openFile(item.path);
      setActiveView('editor');
      return;
    }
    if (item.type === 'pane') {
      // The active pane's terminals trade places with this pane's; the
      // keyboard follows the terminal it was in (see `swapPanes`).
      swapActivePane?.(item.paneId);
      setActiveView('terminal');
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
      case 'go_to_unread_notification':
        // As the shortcut does — the Terminal view brought on screen wherever
        // it is; with nothing unread, nothing happens.
        goToLatestUnread?.();
        return;
      case 'mark_notifications_read':
        markAllNotificationsRead?.();
        return;
      case 'equalize_splits':
        // The group on screen, nested splits included.
        equalizeSplits?.();
        setActiveView('terminal');
        return;
      case 'rename_terminal':
        // The pane showing the active terminal opens its tab's editor — over
        // the terminal, when that pane's strip is hidden (spec P1).
        setActiveView('terminal');
        requestTabRename?.();
        return;
      case 'close_terminal': {
        const tabId = useTerminalStore.getState().activeTabId;
        if (tabId) await closeTab(tabId);
        return;
      }
      case 'save_all':
        await saveAll();
        return;
      default:
        return;
    }
  };

  const handleSelect = async (item) => {
    if (!item) return;
    // A row that opens a pick ("Swap Pane With…") does not close the
    // palette: it becomes the pick, and what had the keyboard when the
    // palette opened still gets it back when the pick is done.
    if (item.opens) {
      setOpen(true, item.opens);
      return;
    }
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
      // A key held a moment too long repeats, and each repeat used to act on
      // whatever the palette showed next: "Swap Pane With…" swapped with the
      // first pane before anyone chose one. A repeat chooses nothing.
      if (e.repeat) return;
      if (allFiltered[current]) {
        // And once a row has closed the palette, the rest of the held key's
        // repeats would reach whatever has the keyboard then — the terminal,
        // as Enters that ran its half-typed line after Close Terminal.
        swallowRepeatsOf('Enter');
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
              placeholder={
                paletteMode === 'files'
                  ? 'Search files by name…'
                  : paletteMode === 'swap-pane'
                    ? 'Swap the active pane with…'
                    : 'Type a command or search files…'
              }
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
                {/* Why a list has nothing to choose from — a zoomed group
                    offers no pane to swap with — said where the rows would be. */}
                {group.note && (
                  <div data-palette-note className="px-2 py-1 text-ui-sm text-vsc-muted italic">
                    {group.note}
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
