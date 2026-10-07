/**
 * Closing the window, or quitting the app, asks about unsaved editor tabs.
 *
 * File ▸ Exit, Ctrl/⌘+Shift+W, the title bar's ✕ and Alt+F4 all ended the
 * window with nothing intercepting the close request, and every unsaved
 * buffer went with it — while closing a single tab asked. A macOS quit, which
 * never closes the window first, did the same.
 *
 * The backend decides now (src-tauri/src/commands/app.rs). With nothing
 * unsaved a close goes ahead without the page being involved at all.
 * Otherwise the backend holds it and asks the page, which says at once that
 * it heard (`app_close_ack`) and then puts the same Save / Don't Save /
 * Cancel prompt as closing a tab (src/hooks/useUnsavedGuard.js). A page that
 * does not say it heard is taken for dead, and the close goes ahead.
 *
 * The first version did it the other way round: the page listened for the
 * window's close request. Once a window has such a listener, Tauri prevents
 * EVERY close of it and leaves the window to the page, so a webview that had
 * crashed or hung left a window that nothing but Task Manager could close.
 *
 * What the guard does with a question is driven here with stand-ins for the
 * backend. The hook itself is mounted with real React, on a page whose
 * Tauri bridge (`window.__TAURI_INTERNALS__`) is a stand-in that writes down
 * what the page asks of the backend — which is what the backend itself sees.
 * The hook module is imported by each case, so that a missing export fails
 * that case rather than the whole file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import React from 'react';
// Static, so react-dom is loaded before any page exists. It looks for a DOM
// once, at load, and finding one reads `navigator`, which Node 20 lacks.
import ReactDOM from 'react-dom';
import ReactDOMClient from 'react-dom/client';
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

/** The backend, as far as the guard calls it: everything asked of it, in order. */
function fakeBackend() {
  const calls = [];
  return {
    calls,
    count: (what) => calls.filter(([name]) => name === what).length,
    async ack(id) {
      calls.push(['ack', id]);
    },
    async closeWindow() {
      calls.push(['closeWindow']);
    },
    async quit() {
      calls.push(['quit']);
    },
  };
}

/** Wait a turn at a time until `ready()` holds, for a second at most. */
async function until(ready, what) {
  const deadline = Date.now() + 1000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Let whatever is under way land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('Closing the window with unsaved editor tabs', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('UG-01: nothing unsaved — the question is acknowledged, and the window closed', async () => {
    const { answerCloseRequest } = await guard();
    await openFile('clean');
    const backend = fakeBackend();

    assert.equal(answerCloseRequest(7, S.getState(), backend), false);

    // The backend only asks when it was last told something is unsaved, and
    // it is holding the window until it hears back. Saved since: close.
    assert.deepEqual(backend.calls, [['ack', 7], ['closeWindow']]);
    assert.equal(S.getState().pendingClose, null);
  });

  test('UG-02: an unsaved tab — acknowledged, held, and asked', async () => {
    const { answerCloseRequest } = await guard();
    const { tab } = await openFile('on disk', 'edited');
    const backend = fakeBackend();

    assert.equal(answerCloseRequest(7, S.getState(), backend), true);

    assert.deepEqual(backend.calls, [['ack', 7]], 'the window closed over an unsaved edit, or the backend never heard the page has the question');
    const pending = S.getState().pendingClose;
    assert.equal(pending.kind, 'window');
    assert.deepEqual(pending.tabIds, [tab.id]);
  });

  test("UG-03: \"Don't Save\" closes the window and leaves the file as it was", async () => {
    const { answerCloseRequest } = await guard();
    const { path } = await openFile('on disk', 'edited');
    const backend = fakeBackend();
    answerCloseRequest(7, S.getState(), backend);

    await S.getState().discardPendingClose();

    assert.equal(backend.count('closeWindow'), 1);
    assert.equal(await invoke('fs_read_file', { path }), 'on disk');
  });

  test('UG-04: "Save All" writes every unsaved tab, then closes the window', async () => {
    const { answerCloseRequest } = await guard();
    const a = await openFile('a', 'a edited');
    await openFile('b');
    const c = await openFile('c', 'c edited');
    const backend = fakeBackend();
    answerCloseRequest(7, S.getState(), backend);
    assert.equal(S.getState().pendingClose.tabIds.length, 2, 'only the unsaved tabs are listed');

    await S.getState().savePendingClose();

    assert.equal(await invoke('fs_read_file', { path: a.path }), 'a edited');
    assert.equal(await invoke('fs_read_file', { path: c.path }), 'c edited');
    assert.equal(backend.count('closeWindow'), 1);
  });

  test('UG-05: Cancel keeps the window and the edits', async () => {
    const { answerCloseRequest } = await guard();
    const { tab } = await openFile('on disk', 'edited');
    const backend = fakeBackend();
    answerCloseRequest(7, S.getState(), backend);

    S.getState().cancelPendingClose();

    assert.equal(backend.count('closeWindow'), 0);
    assert.equal(S.getState().pendingClose, null);
    assert.equal(S.getState().tabs.find((t) => t.id === tab.id).isDirty, true);
  });

  test('UG-06: a save that fails keeps the window open and the question asked', async () => {
    const { answerCloseRequest } = await guard();
    await openFile('on disk', 'edited');
    const backend = fakeBackend();
    answerCloseRequest(7, S.getState(), backend);

    const realSave = S.getState().saveFile;
    S.setState({ saveFile: async () => { throw new Error('disk full'); } });
    try {
      await assert.rejects(() => S.getState().savePendingClose(), /disk full/);
    } finally {
      S.setState({ saveFile: realSave });
    }

    assert.equal(backend.count('closeWindow'), 0, 'the window closed over an edit that never reached disk');
    assert.equal(S.getState().pendingClose?.kind, 'window');
  });

  test('UG-07: a file changed on disk — its own question replaces this one, and the window stays', async () => {
    const { answerCloseRequest } = await guard();
    const { path, tab } = await openFile('on disk', 'edited');
    await invoke('fs_write_file', { path, content: 'changed by an agent' });
    const backend = fakeBackend();
    answerCloseRequest(7, S.getState(), backend);

    await assert.rejects(() => S.getState().savePendingClose(), /changed on disk/);

    assert.equal(backend.count('closeWindow'), 0);
    assert.equal(S.getState().pendingClose, null, 'two prompts open at once');
    assert.equal(S.getState().pendingOverwrite?.tabId, tab.id);
    assert.equal(await invoke('fs_read_file', { path }), 'changed by an agent');
  });

  test('UG-14: a check that throws still answers — heard, and the window closed rather than held for nothing', async () => {
    const { answerCloseRequest } = await guard();
    const backend = fakeBackend();
    const broken = {
      askBeforeLeaving() {
        throw new Error('the store is gone');
      },
    };
    const logged = [];
    const consoleError = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    try {
      assert.equal(answerCloseRequest(3, broken, backend), false);
    } finally {
      console.error = consoleError;
    }

    assert.deepEqual(backend.calls, [['ack', 3], ['closeWindow']]);
    assert.equal(logged.length, 1, 'and the failure is logged');
  });
});

describe('Quitting the app with unsaved editor tabs (macOS ⌘Q, Dock ▸ Quit, logging out)', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('UG-08: nothing unsaved — acknowledged, and quits straight away', async () => {
    const { answerQuitRequest } = await guard();
    await openFile('clean');
    const backend = fakeBackend();

    assert.equal(answerQuitRequest(8, S.getState(), backend), false);

    assert.deepEqual(backend.calls, [['ack', 8], ['quit']]);
    assert.equal(S.getState().pendingClose, null);
  });

  test('UG-09: an unsaved tab asks first, and quits once answered', async () => {
    const { answerQuitRequest } = await guard();
    const { path } = await openFile('on disk', 'edited');
    const backend = fakeBackend();

    assert.equal(answerQuitRequest(8, S.getState(), backend), true);
    assert.equal(S.getState().pendingClose?.kind, 'quit');
    assert.deepEqual(backend.calls, [['ack', 8]], 'quit before anyone was asked');

    await S.getState().savePendingClose();

    assert.equal(backend.count('quit'), 1);
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
  test("UG-11: the webview cannot destroy its window — closing it for good is the backend's", () => {
    // Destroy skips the close request, and so the backend's question. The
    // page asks the backend to finish a close (`app_close_window`) instead.
    const dir = new URL('../../src-tauri/capabilities/', import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(files.length > 0, 'no capability files found');
    for (const name of files) {
      const caps = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
      const granted = caps.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
      assert.ok(!granted.includes('core:window:allow-destroy'), `${name} lets the webview destroy the window`);
    }
    // A close stays a request: the frameless title bar's ✕ and File ▸ Exit
    // ask for one, and the backend decides.
    const caps = JSON.parse(readFileSync(new URL('default.json', dir), 'utf8'));
    assert.ok(caps.permissions.includes('core:window:allow-close'));
  });

  test('UG-12: the backend registers the commands the guard calls, and decides every close itself', () => {
    const main = readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    for (const command of ['app_set_unsaved', 'app_close_ack', 'app_close_window', 'app_quit']) {
      assert.ok(handler.includes(`commands::app::${command},`), `${command} in generate_handler!`);
    }
    assert.ok(main.includes('.on_window_event('), 'no window event handler in main.rs');
    assert.ok(main.includes('commands::app::hold_close(window)'), 'close requests do not reach the gate');
    assert.ok(main.includes('api.prevent_close()'), 'the gate cannot hold a close');
  });

  test('UG-13: the browser mock answers them too', async () => {
    await invoke('app_set_unsaved', { unsaved: true });
    assert.equal(mockBridge.unsaved, true);
    await invoke('app_set_unsaved', { unsaved: false });
    assert.equal(mockBridge.unsaved, false);

    const acks = mockBridge.closeAcks.length;
    await invoke('app_close_ack', { id: 5 });
    assert.deepEqual(mockBridge.closeAcks.slice(acks), [5]);

    const closes = mockBridge.windowCloses;
    await invoke('app_close_window');
    assert.equal(mockBridge.windowCloses, closes + 1);

    const quits = mockBridge.quitRequests;
    await invoke('app_quit');
    assert.equal(mockBridge.quitRequests, quits + 1);
  });

  test('UG-17: the backend asks on the events the hook listens to', async () => {
    const { CLOSE_REQUESTED_EVENT, QUIT_REQUESTED_EVENT } = await guard();
    const app = readFileSync(new URL('../../src-tauri/src/commands/app.rs', import.meta.url), 'utf8');
    assert.ok(
      app.includes(`pub const CLOSE_REQUESTED: &str = "${CLOSE_REQUESTED_EVENT}";`),
      `app.rs does not ask about a close on ${CLOSE_REQUESTED_EVENT}`
    );
    assert.ok(
      app.includes(`pub const QUIT_REQUESTED: &str = "${QUIT_REQUESTED_EVENT}";`),
      `app.rs does not ask about a quit on ${QUIT_REQUESTED_EVENT}`
    );
  });
});

// ---- The hook, mounted -------------------------------------------------------

/** Listeners as a browser keeps them: one per type, function and phase. */
class Listeners {
  constructor() {
    this.listeners = [];
  }
  addEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    if (this.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return;
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
  /** `event` at this target, to every listener it has for that type. */
  dispatch(event) {
    for (const l of [...this.listeners]) if (l.type === event.type) l.fn.call(this, event);
    return event;
  }
}

/**
 * Tauri's bridge in the page, `window.__TAURI_INTERNALS__`, as far as
 * @tauri-apps/api uses it. Every command the page sends is written down, and
 * a subscription (`plugin:event|listen`) lasts until it is dropped, so that
 * `emit` can play the backend. Tauri keys its own behaviour off exactly
 * these subscriptions: a window with one to `tauri://close-requested` is a
 * window whose every close it prevents.
 */
function tauriBridge() {
  const sent = [];
  const callbacks = new Map();
  const subscriptions = new Map(); // eventId -> { event, handler }
  let next = 1;
  return {
    sent,
    internals: {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
      transformCallback(callback) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      async invoke(cmd, args = {}) {
        sent.push({ cmd, args });
        if (cmd === 'plugin:event|listen') {
          const eventId = next++;
          subscriptions.set(eventId, { event: args.event, handler: args.handler });
          return eventId;
        }
        if (cmd === 'plugin:event|unlisten') subscriptions.delete(args.eventId);
        return null;
      },
    },
    eventInternals: { unregisterListener() {} },
    /** Every event the page ever subscribed to, in order. */
    subscribedTo: () => sent.filter((c) => c.cmd === 'plugin:event|listen').map((c) => c.args.event),
    /** The events the page is subscribed to now. */
    listening: () => [...subscriptions.values()].map((s) => s.event),
    /** What the page sent with `cmd`, oldest first. */
    sentWith: (cmd) => sent.filter((c) => c.cmd === cmd).map((c) => c.args),
    /** The backend emitting `event`: every subscription to it hears `payload`. */
    emit(event, payload) {
      for (const s of [...subscriptions.values()]) {
        if (s.event === event) callbacks.get(s.handler)?.({ event, id: next++, payload });
      }
    },
  };
}

/**
 * The page the hook runs in: `window` with the bridge on it, `document`, and
 * an element for React's root. As much of a DOM as rendering a component
 * that draws nothing reaches.
 */
function appPage(bridge) {
  const document = Object.assign(new Listeners(), { nodeType: 9, nodeName: '#document' });
  const element = (tag) =>
    Object.assign(new Listeners(), {
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      ownerDocument: document,
      textContent: '',
    });
  document.body = element('body');
  document.activeElement = document.body;
  const window = Object.assign(new Listeners(), {
    document,
    HTMLIFrameElement: class {},
    __TAURI_INTERNALS__: bridge.internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: bridge.eventInternals,
  });
  document.defaultView = window;
  return { window, document, container: element('div') };
}

/**
 * Run `fn` inside the desktop app, as far as the hook can tell: the page
 * above installed as `window` and `document`, and put back afterwards. `fn`
 * gets the bridge, the page, and `mount` / `unmount` for a component that
 * runs the hook — real React, effects and all, as main.jsx renders App.
 *
 * Nothing the page started is left in flight when the page goes: a call that
 * landed after it would reach the browser mock, or throw where nothing
 * catches it. React's warnings fail the case.
 */
async function insideTheApp(fn) {
  const { useUnsavedGuard } = await guard();
  const Host = () => {
    useUnsavedGuard();
    return null;
  };
  const bridge = tauriBridge();
  const page = appPage(bridge);
  const saved = ['window', 'document'].map((name) => [name, Object.hasOwn(globalThis, name), globalThis[name]]);
  const warnings = [];
  const consoleError = console.error;
  console.error = (...args) => warnings.push(args.map(String).join(' '));
  globalThis.window = page.window;
  globalThis.document = page.document;
  let root = null;
  const unmount = () => {
    if (!root) return;
    root.unmount();
    root = null;
  };
  try {
    await fn({
      bridge,
      page,
      mount() {
        root = ReactDOMClient.createRoot(page.container);
        ReactDOM.flushSync(() => root.render(React.createElement(Host)));
      },
      unmount,
    });
    unmount();
    assert.deepEqual(warnings, [], 'nothing was reported');
  } finally {
    unmount();
    await until(() => bridge.listening().length === 0, 'the page to drop its subscriptions').catch(() => {});
    await settled();
    console.error = consoleError;
    for (const [name, had, value] of saved) {
      if (had) globalThis[name] = value;
      else delete globalThis[name];
    }
  }
}

describe('The guard as the app runs it', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test("UG-15: the hook never subscribes to the window's own close request — Tauri would hold every close for the page", async () => {
    await insideTheApp(async ({ bridge, mount }) => {
      mount();
      await until(() => bridge.subscribedTo().length >= 2, 'the hook to subscribe');
      await settled(); // and anything else it was going to subscribe to

      const events = bridge.subscribedTo();
      assert.ok(
        !events.includes('tauri://close-requested'),
        `subscribed to tauri://close-requested: a page that crashes or hangs leaves a window nothing can close (${events.join(', ')})`
      );
      assert.deepEqual([...events].sort(), ['app-close-requested', 'app-quit-requested']);
    });
  });

  test('UG-16: a question from the backend is acknowledged with its id — a page that says nothing is taken for dead', async () => {
    await insideTheApp(async ({ bridge, mount }) => {
      mount();
      await until(() => bridge.listening().length === 2, 'the hook to subscribe');

      bridge.emit('app-close-requested', 7);
      await until(() => bridge.sentWith('app_close_window').length === 1, 'the window to be closed');
      assert.deepEqual(bridge.sentWith('app_close_ack'), [{ id: 7 }]);
      assert.deepEqual(
        bridge.sent.map((c) => c.cmd).filter((cmd) => cmd.startsWith('app_close')),
        ['app_close_ack', 'app_close_window'],
        'heard first, then closed'
      );

      bridge.emit('app-quit-requested', 8);
      await until(() => bridge.sentWith('app_quit').length === 1, 'the app to quit');
      assert.deepEqual(bridge.sentWith('app_close_ack'), [{ id: 7 }, { id: 8 }]);
    });
  });

  test('UG-99: teardown', () => {
    S.setState(emptyEditor());
    assert.equal(S.getState().tabs.length, 0);
  });
});
