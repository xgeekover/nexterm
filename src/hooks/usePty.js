import { useEffect } from 'react';
import { useTerminalStore } from '../stores/terminalStore.js';

export function usePty() {
  const store = useTerminalStore();

  useEffect(() => {
    store.init();
  }, []);

  return {
    tabs: store.tabs,
    activeTab: store.getActiveTab(),
    activeTabId: store.activeTabId,
    cwd: store.cwd,
    history: store.history,
    createTab: store.createTab,
    switchTab: store.switchTab,
    closeTab: store.closeTab,
    executeCommand: store.executeCommand,
    pinBlock: store.pinBlock,
    clearBlocks: store.clearBlocks,
  };
}

export default usePty;
