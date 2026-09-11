import { useEffect } from 'react';
import { useEditorStore } from '../stores/editorStore.js';

export function useFileSystem() {
  const store = useEditorStore();

  useEffect(() => {
    store.init();
  }, []);

  return {
    fileTree: store.fileTree,
    expandedFolders: store.expandedFolders,
    isLoadingTree: store.isLoadingTree,
    refreshExplorer: store.refreshExplorer,
    toggleFolder: store.toggleFolder,
    openFile: store.openFile,
    createFile: store.createFile,
    createFolder: store.createFolder,
    deletePath: store.deletePath,
  };
}

export default useFileSystem;
