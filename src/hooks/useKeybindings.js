import { useEffect } from 'react';
import { hasMod } from '../lib/platform.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useEditorStore } from '../stores/editorStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';

export function useKeybindings() {
  const setCommandPaletteOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const isCommandPaletteOpen = useSettingsStore((s) => s.isCommandPaletteOpen);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const saveFile = useEditorStore((s) => s.saveFile);
  const activeEditorTabId = useEditorStore((s) => s.activeTabId);

  // Terminal actions live in the TERMINAL worker's store — select them
  // individually so a not-yet-implemented action is simply `undefined`
  // rather than throwing.
  const splitActivePane = useTerminalStore((s) => s.splitActivePane);
  const closeActivePane = useTerminalStore((s) => s.closeActivePane);
  const focusNextPane = useTerminalStore((s) => s.focusNextPane);
  const createTerminalTab = useTerminalStore((s) => s.createTab);
  const clearBlocks = useTerminalStore((s) => s.clearBlocks);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // The app modifier is ⌘ on macOS and Ctrl elsewhere — never both.
      // Treating Ctrl as a modifier on macOS stole ^K/^B/^A from every text
      // field in the app; treating only ⌘ as one on Windows meant half these
      // shortcuts never fired at all.
      //
      // Nothing here needs a "is the terminal focused?" test: xterm binds its
      // own keydown on the textarea in the capture phase and calls
      // preventDefault + stopPropagation for any chord it turns into a control
      // byte, so a window-level listener like this one simply never sees it.
      const isMod = hasMod(e);
      const isInMonacoEditor = Boolean(e.target && e.target.closest && e.target.closest('.monaco-editor'));

      // ⌘P: Go to File (quick open) · ⌘⇧P: all commands
      if (isMod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setCommandPaletteOpen(true, e.shiftKey ? 'all' : 'files');
        return;
      }

      // ⌘K / Ctrl+K: Command Palette
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!isCommandPaletteOpen);
        return;
      }

      // ⌘S / Ctrl+S: Save active file
      if (isMod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (activeEditorTabId) {
          saveFile(activeEditorTabId);
        }
        return;
      }

      // ⌘Shift+D: Split active terminal pane down (vertical)
      if (isMod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        splitActivePane?.('vertical');
        return;
      }

      // ⌘D: Split active terminal pane right (horizontal)
      // Monaco binds ⌘D to "add selection to next find match" — don't fight it.
      if (isMod && !e.shiftKey && e.key.toLowerCase() === 'd') {
        if (isInMonacoEditor) return;
        e.preventDefault();
        splitActivePane?.('horizontal');
        return;
      }

      // ⌘W: Close the active terminal pane. Guarded so it doesn't hijack
      // whatever ⌘W does while focus is inside Monaco.
      if (isMod && !e.shiftKey && e.key.toLowerCase() === 'w') {
        if (isInMonacoEditor) return;
        e.preventDefault();
        closeActivePane?.();
        return;
      }

      // ⌥⌘→ / ⌥⌘←: Focus next / previous terminal pane
      if (isMod && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        focusNextPane?.(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }

      // ⌃⇧` : New terminal tab — checked before plain ⌃` (e.code avoids the
      // US-layout ambiguity where shift+backtick reports key === '~').
      if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') {
        e.preventDefault();
        createTerminalTab?.();
        return;
      }

      // ⌃` : Toggle the bottom panel
      if (e.ctrlKey && !e.shiftKey && e.code === 'Backquote') {
        e.preventDefault();
        togglePanel();
        return;
      }

      // ⌘B: Toggle primary sidebar
      if (isMod && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⌘L: Clear unpinned terminal blocks
      if (isMod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        clearBlocks?.();
        return;
      }

      // Escape: Close modals
      if (e.key === 'Escape') {
        if (isCommandPaletteOpen) {
          setCommandPaletteOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isCommandPaletteOpen,
    activeEditorTabId,
    saveFile,
    setCommandPaletteOpen,
    toggleSidebar,
    togglePanel,
    splitActivePane,
    closeActivePane,
    focusNextPane,
    createTerminalTab,
    clearBlocks,
  ]);
}

export default useKeybindings;
