import { useEffect } from 'react';
import { isTauri, listen } from '../lib/ipc.js';
import { dropPointToClient } from '../lib/dropPaths.js';
import { paneIdAtPoint, startOsFileDrop } from '../lib/terminalFileDrop.js';
import { useSystemStore } from '../stores/systemStore.js';
import { usePathDropStore } from '../stores/pathDropStore.js';
import { insertPathsIntoPane, planPathsIntoPane } from '../components/terminal/insertPathsIntoPane.js';

/**
 * Files dragged in from Windows Explorer or Finder and dropped on a terminal
 * pane go into that pane's terminal as their paths, quoted for its shell.
 *
 * Tauri already takes every OS file drop on the window — its drag-drop
 * handler is on by default, and tauri.conf.json leaves it on — and reports it
 * as `tauri://drag-*` events with the paths and the pointer's position. This
 * follows them (`startOsFileDrop` has the order of events and the reasons),
 * with the highlight showing where a drop would go. Only in the desktop app:
 * a browser has no such events.
 *
 * Mounted once, by App, beside the other window-wide listeners: the terminal
 * view remounts whenever it is moved to another region or hidden and shown
 * again, and which region the panes are in has nothing to do with the drop.
 */
export function useTerminalFileDrop() {
  useEffect(() => {
    if (!isTauri()) return undefined;
    return startOsFileDrop({
      listen,
      toClient: (position) =>
        dropPointToClient(position, {
          platform: useSystemStore.getState().os,
          devicePixelRatio: window.devicePixelRatio,
        }),
      paneAt: (x, y) => paneIdAtPoint(x, y, document),
      plan: planPathsIntoPane,
      insert: insertPathsIntoPane,
      setTarget: (target) => usePathDropStore.getState().setTarget(target),
    });
  }, []);
}

export default useTerminalFileDrop;
