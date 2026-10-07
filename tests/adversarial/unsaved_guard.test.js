/**
 * Closing the window, or quitting the app, asks about unsaved editor tabs.
 *
 * File ▸ Exit, Ctrl/⌘+Shift+W, the title bar's ✕ and Alt+F4 all ended the
 * window with nothing intercepting the close request, and every unsaved
 * buffer went with it — while closing a single tab asked. The window now
 * answers its close request (src/hooks/useUnsavedGuard.js) with the same
 * Save / Don't Save / Cancel prompt, and a macOS quit, which never closes the
 * window first, is stopped by the backend and asked the same way.
 *
 * The hook itself needs a real window. What it does with a close request is
 * here, driven with stand-ins shaped like Tauri's: a CloseRequestedEvent
 * (`preventDefault`), and a window whose `destroy` is counted. The hook
 * module is imported by each case, so that a missing export fails that case
 * rather than the whole file.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';

const S = useEditorStore;
const guard = () => import('../../src/hooks/useUnsavedGuard.js');
let counter = 0;

const emptyEditor = () => ({
  tabs: [],
  activeTabId: null,
  pendingClose: null,
  pendingOverwrite: null,
  editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
  activeEditorPaneId: 'editor-pane-root',
});

async function openFile(content, edited = content) {
  counter += 1;
  const path = `/workspace/_guard_${Date.now()}_${counter}.txt`;
  await invoke('fs_write_file', { path, content });
  const tab = await S.getState().openFile(path);
  S.getState().editBuffer(tab.id, edited);
  return { path, tab };
}

/** Tauri's CloseRequestedEvent, as far as a handler uses it. */
function closeEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

/** The window, as far as the guard uses it: closing it for good. */
function fakeWindow() {
  return {
    destroyed: 0,
    async destroy() {
      this.destroyed += 1;
    },
  };
}

describe('Closing the window with unsaved editor tabs', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('UG-01: nothing unsaved — the close goes ahead, untouched', async () => {
    const { answerCloseRequest } = await guard();
    await openFile('clean');
    const event = closeEvent();
    const win = fakeWindow();

    assert.equal(answerCloseRequest(event, win), false);

    // Tauri's onCloseRequested destroys the window itself when the handler
    // does not prevent it. Destroying it here as well would be twice.
    assert.equal(event.prevented, false);
    assert.equal(win.destroyed, 0);
    assert.equal(S.getState().pendingClose, null);
  });

  test('UG-02: an unsaved tab holds the close and asks', async () => {
    const { answerCloseRequest } = await guard();
    const { tab } = await openFile('on disk', 'edited');
    const event = closeEvent();
    const win = fakeWindow();

    assert.equal(answerCloseRequest(event, win), true);

    assert.equal(event.prevented, true, 'the window closed over an unsaved edit');
    assert.equal(win.destroyed, 0);
    const pending = S.getState().pendingClose;
    assert.equal(pending.kind, 'window');
    assert.deepEqual(pending.tabIds, [tab.id]);
  });

  test("UG-03: \"Don't Save\" closes the window and leaves the file as it was", async () => {
    const { answerCloseRequest } = await guard();
    const { path } = await openFile('on disk', 'edited');
    const win = fakeWindow();
    answerCloseRequest(closeEvent(), win);

    await S.getState().discardPendingClose();

    assert.equal(win.destroyed, 1);
    assert.equal(await invoke('fs_read_file', { path }), 'on disk');
  });

  test('UG-04: "Save All" writes every unsaved tab, then closes the window', async () => {
    const { answerCloseRequest } = await guard();
    const a = await openFile('a', 'a edited');
    await openFile('b');
    const c = await openFile('c', 'c edited');
    const win = fakeWindow();
    answerCloseRequest(closeEvent(), win);
    assert.equal(S.getState().pendingClose.tabIds.length, 2, 'only the unsaved tabs are listed');

    await S.getState().savePendingClose();

    assert.equal(await invoke('fs_read_file', { path: a.path }), 'a edited');
    assert.equal(await invoke('fs_read_file', { path: c.path }), 'c edited');
    assert.equal(win.destroyed, 1);
  });

  test('UG-05: Cancel keeps the window and the edits', async () => {
    const { answerCloseRequest } = await guard();
    const { tab } = await openFile('on disk', 'edited');
    const win = fakeWindow();
    answerCloseRequest(closeEvent(), win);

    S.getState().cancelPendingClose();

    assert.equal(win.destroyed, 0);
    assert.equal(S.getState().pendingClose, null);
    assert.equal(S.getState().tabs.find((t) => t.id === tab.id).isDirty, true);
  });

  test('UG-06: a save that fails keeps the window open and the question asked', async () => {
    const { answerCloseRequest } = await guard();
    await openFile('on disk', 'edited');
    const win = fakeWindow();
    answerCloseRequest(closeEvent(), win);

    const realSave = S.getState().saveFile;
    S.setState({ saveFile: async () => { throw new Error('disk full'); } });
    try {
      await assert.rejects(() => S.getState().savePendingClose(), /disk full/);
    } finally {
      S.setState({ saveFile: realSave });
    }

    assert.equal(win.destroyed, 0, 'the window closed over an edit that never reached disk');
    assert.equal(S.getState().pendingClose?.kind, 'window');
  });

  test('UG-07: a file changed on disk — its own question replaces this one, and the window stays', async () => {
    const { answerCloseRequest } = await guard();
    const { path, tab } = await openFile('on disk', 'edited');
    await invoke('fs_write_file', { path, content: 'changed by an agent' });
    const win = fakeWindow();
    answerCloseRequest(closeEvent(), win);

    await assert.rejects(() => S.getState().savePendingClose(), /changed on disk/);

    assert.equal(win.destroyed, 0);
    assert.equal(S.getState().pendingClose, null, 'two prompts open at once');
    assert.equal(S.getState().pendingOverwrite?.tabId, tab.id);
    assert.equal(await invoke('fs_read_file', { path }), 'changed by an agent');
  });
});

describe('Quitting the app with unsaved editor tabs (macOS ⌘Q, Dock ▸ Quit, logging out)', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('UG-08: nothing unsaved — quits straight away', async () => {
    const { answerQuitRequest } = await guard();
    await openFile('clean');
    let quits = 0;

    await answerQuitRequest(S.getState(), async () => {
      quits += 1;
    });

    assert.equal(quits, 1);
    assert.equal(S.getState().pendingClose, null);
  });

  test('UG-09: an unsaved tab asks first, and quits once answered', async () => {
    const { answerQuitRequest } = await guard();
    const { path } = await openFile('on disk', 'edited');
    let quits = 0;

    const answering = answerQuitRequest(S.getState(), async () => {
      quits += 1;
    });
    assert.equal(S.getState().pendingClose?.kind, 'quit');
    assert.equal(quits, 0, 'quit before anyone was asked');

    await S.getState().savePendingClose();
    await answering;

    assert.equal(quits, 1);
    assert.equal(await invoke('fs_read_file', { path }), 'edited');
  });

  test('UG-10: the backend is told when something becomes unsaved, and when nothing is', async () => {
    const { reportUnsaved } = await guard();
    const sent = [];
    const stop = reportUnsaved(S, async (unsaved) => {
      sent.push(unsaved);
    });
    try {
      const { tab } = await openFile('v0');
      S.getState().editBuffer(tab.id, 'v1');
      S.getState().editBuffer(tab.id, 'v12'); // still unsaved: nothing new to say
      await S.getState().saveFile(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(sent, [false, true, false]);
    } finally {
      stop();
    }
  });
});

describe('What the guard needs from the rest of the app', () => {
  test('UG-11: the window may destroy itself — without it, no window could close at all', () => {
    // Once the webview listens for close requests, the backend never closes
    // the window on its own; `onCloseRequested` destroys it.
    const caps = JSON.parse(readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    assert.ok(caps.permissions.includes('core:window:allow-destroy'));
  });

  test('UG-12: the backend registers the commands the guard calls', () => {
    const main = readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::app::app_set_unsaved,'), 'app_set_unsaved in generate_handler!');
    assert.ok(handler.includes('commands::app::app_quit,'), 'app_quit in generate_handler!');
  });

  test('UG-13: the browser mock answers them too', async () => {
    await invoke('app_set_unsaved', { unsaved: true });
    assert.equal(mockBridge.unsaved, true);
    await invoke('app_set_unsaved', { unsaved: false });
    assert.equal(mockBridge.unsaved, false);
    const before = mockBridge.quitRequests;
    await invoke('app_quit');
    assert.equal(mockBridge.quitRequests, before + 1);
  });

  test('UG-14: teardown', () => {
    S.setState(emptyEditor());
    assert.equal(S.getState().tabs.length, 0);
  });
});
