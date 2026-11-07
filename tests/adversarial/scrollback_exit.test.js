/**
 * Closing the window and quitting save the terminals' scrollback first
 * (stage 6, spec D6; src/hooks/useUnsavedGuard.js).
 *
 * The backend holds a window close while it was told scrollback is pending
 * and asks the page; the page says it heard, saves — bounded, 1.5 s — and
 * only then closes. A macOS quit is not held for it, but the quit the page
 * answers (an unsaved editor tab asked) saves first too. What is held:
 *
 *   - the close and the quit wait for the save, and not past its bound
 *   - a save that throws or rejects still leaves
 *   - "pending" reaches the backend as the saver reports it, in order, and
 *     "nothing pending" when the guard goes — nobody is left to answer
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { EXIT_FLUSH_MS } from '../../src/lib/scrollbackSaver.js';

const guard = () => import('../../src/hooks/useUnsavedGuard.js');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const emptyEditor = () => ({
  tabs: [],
  activeTabId: null,
  pendingClose: null,
  pendingOverwrite: null,
  editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
  activeEditorPaneId: 'editor-pane-root',
});

/** The backend and the page's save, as the guard calls them: everything, in order. */
function fakeBackend(flush) {
  const calls = [];
  return {
    calls,
    async ack(id) {
      calls.push(`ack ${id}`);
    },
    async closeWindow() {
      calls.push('closeWindow');
    },
    async quit() {
      calls.push('quit');
    },
    flush: () => {
      calls.push('flush');
      return flush();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Leaving saves the scrollback first', () => {
  beforeEach(() => useEditorStore.setState(emptyEditor()));

  test('SX-01: a close waits for the save, then closes — heard first', async () => {
    const { answerCloseRequest } = await guard();
    const saving = deferred();
    const backend = fakeBackend(() => saving.promise);
    assert.equal(answerCloseRequest(4, useEditorStore.getState(), backend), false);
    await wait(5);
    assert.deepEqual(backend.calls, ['ack 4', 'flush'], 'closed before the scrollback was saved');
    saving.resolve(true);
    await wait(5);
    assert.deepEqual(backend.calls, ['ack 4', 'flush', 'closeWindow']);
  });

  test('SX-02: the quit the page answers saves first too', async () => {
    const { answerQuitRequest } = await guard();
    const saving = deferred();
    const backend = fakeBackend(() => saving.promise);
    answerQuitRequest(5, useEditorStore.getState(), backend);
    await wait(5);
    assert.deepEqual(backend.calls, ['ack 5', 'flush']);
    saving.resolve(false);
    await wait(5);
    assert.deepEqual(backend.calls, ['ack 5', 'flush', 'quit'], 'a save that ran out of time kept the app open');
  });

  test('SX-03: a save that never ends holds the close for its bound only', async () => {
    const { answerCloseRequest } = await guard();
    const backend = fakeBackend(() => new Promise(() => {}));
    const started = Date.now();
    answerCloseRequest(6, useEditorStore.getState(), backend);
    await wait(EXIT_FLUSH_MS - 200);
    assert.equal(backend.calls.includes('closeWindow'), false, 'did not wait for the save at all');
    const deadline = started + EXIT_FLUSH_MS + 1500;
    while (!backend.calls.includes('closeWindow') && Date.now() < deadline) await wait(20);
    assert.ok(backend.calls.includes('closeWindow'), 'a save that never ends kept the window open');
    assert.ok(Date.now() - started < EXIT_FLUSH_MS + 600, `closed only after ${Date.now() - started} ms`);
  });

  test('SX-04: a save that throws, or rejects, still closes and quits', async () => {
    const { answerCloseRequest, answerQuitRequest } = await guard();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const throwing = fakeBackend(() => {
        throw new Error('saver gone');
      });
      answerCloseRequest(7, useEditorStore.getState(), throwing);
      const rejecting = fakeBackend(() => Promise.reject(new Error('disk full')));
      answerQuitRequest(8, useEditorStore.getState(), rejecting);
      await wait(10);
      assert.deepEqual(throwing.calls, ['ack 7', 'flush', 'closeWindow']);
      assert.deepEqual(rejecting.calls, ['ack 8', 'flush', 'quit']);
    } finally {
      console.warn = warn;
    }
  });

  test('SX-05: an unsaved editor tab is asked about first; the answer then saves, then closes', async () => {
    const { answerCloseRequest } = await guard();
    const saving = deferred();
    const backend = fakeBackend(() => saving.promise);
    const asked = [];
    const editor = {
      askBeforeLeaving: (kind, leave) => {
        asked.push({ kind, leave });
        return true;
      },
    };
    assert.equal(answerCloseRequest(9, editor, backend), true);
    await wait(5);
    assert.deepEqual(backend.calls, ['ack 9'], 'saved before the user answered');
    asked[0].leave();
    await wait(5);
    assert.deepEqual(backend.calls, ['ack 9', 'flush']);
    saving.resolve(true);
    await wait(5);
    assert.deepEqual(backend.calls, ['ack 9', 'flush', 'closeWindow']);
  });

  test('SX-06: "pending" reaches the backend as the saver says it, in order — and "nothing pending" when the guard goes', async () => {
    const { reportPendingSave } = await guard();
    let listener = null;
    const saver = {
      pending: true,
      onPending: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    };
    const heard = [];
    let calls = 0;
    let release;
    const firstHeld = new Promise((resolve) => {
      release = resolve;
    });
    const send = async (pending) => {
      calls += 1;
      if (calls === 1) await firstHeld;
      heard.push(pending);
    };
    const stop = reportPendingSave(saver, send);
    listener(true);
    listener(false);
    listener(false);
    listener(true);
    stop();
    assert.equal(listener, null, 'still listening after the guard went');
    release();
    await wait(10);
    assert.deepEqual(heard, [true, false, true, false], 'out of order, repeated, or the last word was not "nothing pending"');
  });
});
