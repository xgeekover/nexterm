import { useEffect } from 'react';
import { hasMod } from '../lib/platform.js';
import { dispatchKeydown, dispatchKeydownOverTerminal } from '../lib/keybindings.js';
import { windowControls } from '../lib/menuActions.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useEditorStore } from '../stores/editorStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';

/**
 * Wire the keyboard to `KEYBINDINGS`.
 *
 * The chords themselves live in src/lib/keybindings.js as data, so the menu's
 * advertised shortcut and the code that answers it can be compared by a test
 * instead of by eye — four menu entries were showing a shortcut nothing
 * listened for. All this hook does is decide what "the app modifier" means on
 * this platform, hand the stores over, and let the table match.
 */
export function useKeybindings() {
  const setCommandPaletteOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const isCommandPaletteOpen = useSettingsStore((s) => s.isCommandPaletteOpen);
  const setSettingsModalOpen = useSettingsStore((s) => s.setSettingsModalOpen);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const toggleSecondarySidebar = useSettingsStore((s) => s.toggleSecondarySidebar);
  const saveFile = useEditorStore((s) => s.saveFile);
  const activeEditorTabId = useEditorStore((s) => s.activeTabId);
  const pickRoot = useEditorStore((s) => s.pickRoot);

  // Terminal actions live in the TERMINAL worker's store — select them
  // individually so a not-yet-implemented action is simply `undefined`
  // rather than throwing.
  const splitActivePane = useTerminalStore((s) => s.splitActivePane);
  const closeActivePane = useTerminalStore((s) => s.closeActivePane);
  const focusNextPane = useTerminalStore((s) => s.focusNextPane);
  const createTerminalTab = useTerminalStore((s) => s.createTab);
  const clearBlocks = useTerminalStore((s) => s.clearBlocks);

  useEffect(() => {
    // The app modifier is ⌘ on macOS and Ctrl elsewhere — never both.
    // Treating Ctrl as a modifier on macOS stole ^K/^B/^A from every text
    // field in the app; treating only ⌘ as one on Windows meant half these
    // shortcuts never fired at all.
    const contextFor = (e) => ({
      isMod: hasMod(e),
      isInMonacoEditor: Boolean(e.target?.closest?.('.monaco-editor')),
      // Reloading is a development tool. In a packaged build it silently
      // destroys every running shell — see the `reload-guard` binding.
      blockReload: !import.meta.env.DEV,
      isCommandPaletteOpen,
      activeEditorTabId,
      setCommandPaletteOpen,
      setSettingsModalOpen,
      toggleSidebar,
      togglePanel,
      toggleSecondarySidebar,
      saveFile,
      pickRoot,
      splitActivePane,
      closeActivePane,
      focusNextPane,
      createTerminalTab,
      clearBlocks,
      closeWindow: windowControls.close,
    });

    // Bubble phase, as before: xterm has already swallowed anything it turns
    // into a control byte by the time an event gets here, which is what leaves
    // ^C and ^D to the shell.
    const handleKeyDown = (e) => {
      dispatchKeydown(e, contextFor(e));
    };

    // Capture phase, and only while a terminal has focus: runs BEFORE xterm's
    // own textarea handler so the handful of bindings marked `overTerminal`
    // can be claimed at all. Ctrl+B is the reason — the side bar toggle the
    // menu advertises did nothing whenever a terminal was focused, because
    // xterm turned it into ^B first. Everything not marked falls through here
    // untouched and still reaches the shell.
    const handleKeyDownCapture = (e) => {
      if (!e.target?.closest?.('.xterm')) return;
      dispatchKeydownOverTerminal(e, contextFor(e));
    };

    window.addEventListener('keydown', handleKeyDownCapture, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDownCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    isCommandPaletteOpen,
    activeEditorTabId,
    saveFile,
    pickRoot,
    setCommandPaletteOpen,
    setSettingsModalOpen,
    toggleSidebar,
    togglePanel,
    toggleSecondarySidebar,
    splitActivePane,
    closeActivePane,
    focusNextPane,
    createTerminalTab,
    clearBlocks,
  ]);
}

export default useKeybindings;
