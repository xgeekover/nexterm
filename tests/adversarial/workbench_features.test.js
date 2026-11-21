/**
 * Terminal-only features beside editor panes (editor placement, sibling C2,
 * FC12; AC-C11). One group holds a mixed tree — files above, terminals below,
 * a file pane between two terminal panes — and every terminal-only reader is
 * asked about it against the same group without its editor leaves: editor
 * leaves must add nothing.
 *
 *   - WF-N1: the status board's counts and statuses (statusBoardModel.js),
 *     attention's `unreadIn` and `latestUnread`, the secret-input guard
 *     (`typingHidden`) and the group's progress (`groupProgress`).
 *   - WF-N2: the TERMINALS side bar, mounted on a page (TerminalsPanel.jsx):
 *     the same terminal rows in the same order, the same group count, the
 *     same AGENT SESSIONS count, and no file named anywhere in it.
 *   - WF-N3: the workbench's group chip says how many terminals the group
 *     has, not how many panes or tabs (server render of TerminalSplitContainer).
 *   - WF-N4: what the session save writes for the scrollback — the `tabs`
 *     a relaunch hands `startScrollbackSession` — is the terminals alone.
 *
 * The real-browser half — prompt marks, the hidden-strip handle and the
 * attention ring of a terminal pane beside a file pane — is WF-05 in
 * workbench_focus_headless.test.js. The control API beside editor panes is
 * CD-C2-01..03 in control_dispatcher.test.js.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore, setEditorBridge, __editorBridge, PERSIST_KEY } from '../../src/stores/terminalStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { summaryCounts, terminalStatusIn } from '../../src/components/terminal/statusBoardModel.js';
import { latestUnread, unreadCountByTab, unreadIn } from '../../src/lib/attention.js';
import { groupProgress } from '../../src/lib/terminalProgress.js';
import { typingHidden } from '../../src/lib/secretInput.js';
import { tabIdsOfKind } from '../../src/components/terminal/splitLayout.js';
import { drawWorkbench, loadWorkbench } from './workbench_bundle.js';
import { onPage, letItRun } from './react_page.js';

const T = useTerminalStore;
const E = useEditorStore;
const h = React.createElement;

const fileTab = (id) => ({ id, filePath: `/workspace/${id}.js`, fileName: `${id}.js`, content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' });
const termTab = (id) => ({ id, title: `shell ${id}`, cwd: '/workspace', sessionId: `s-${id}` });
const editorLeaf = (id, tabIds) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId: tabIds[0] ?? null });
const terminalLeaf = (id, tabIds) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });

/** [files e1 e2 above | t1 | file e3 | t2 t3 below], and the same group without its files. */
const MIXED = {
  type: 'split', id: 'split-root', direction: 'vertical', sizes: [60, 40],
  children: [
    editorLeaf('pane-e1', ['e1', 'e2']),
    {
      type: 'split', id: 'split-bottom', direction: 'horizontal', sizes: [34, 33, 33],
      children: [terminalLeaf('pane-t1', ['t1']), editorLeaf('pane-e3', ['e3']), terminalLeaf('pane-t2', ['t2', 't3'])],
    },
  ],
};
const TERMINALS_ONLY = {
  type: 'split', id: 'split-bottom', direction: 'horizontal', sizes: [50, 50],
  children: [terminalLeaf('pane-t1', ['t1']), terminalLeaf('pane-t2', ['t2', 't3'])],
};
const FILES = ['e1', 'e2', 'e3'];
const TERMINALS = ['t1', 't2', 't3'];

function groupsWith(tree) {
  return [
    { id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-t1', editorPaneId: tree === MIXED ? 'pane-e1' : undefined, tree },
    { id: 'group-2', name: 'Group 2', createdAt: 0, activePaneId: 'pane-t4', tree: terminalLeaf('pane-t4', ['t4']) },
  ];
}

const NOTES = [
  { id: 'n1', tabId: 't2', read: false, kind: 'bell', title: 'Bell', body: '', createdAt: 3 },
  { id: 'n2', tabId: 'e1', read: false, kind: 'bell', title: 'stray', body: '', createdAt: 4 },
  { id: 'n3', tabId: 't1', read: true, kind: 'bell', title: 'Bell', body: '', createdAt: 1 },
];

let saved = null;
let bridge = null;

describe('Terminal-only features beside editor panes (C2, FC12)', () => {
  beforeEach(() => {
    saved = { t: T.getState(), e: E.getState() };
    bridge = __editorBridge();
    setEditorBridge({ tabIds: () => new Set(FILES), closeTabs: () => {} });
  });
  afterEach(() => {
    T.setState(saved.t, true);
    E.setState(saved.e, true);
    setEditorBridge(bridge);
  });

  test('WF-N1: status counts, unread, the latest unread, the secret-input guard and progress see the terminals only', () => {
    const terminalIds = tabIdsOfKind(MIXED, 'terminal');
    assert.deepEqual(terminalIds, TERMINALS, 'the mixed tree\u{2019}s terminals, in screen order');
    assert.deepEqual(tabIdsOfKind(MIXED, 'editor'), FILES);
    T.setState({ tabs: [...TERMINALS, 't4'].map(termTab), groups: groupsWith(MIXED), activeGroupId: 'group-1', notifications: NOTES });
    const state = T.getState();
    assert.deepEqual(summaryCounts(state, [...TERMINALS, ...FILES]), summaryCounts(state, TERMINALS), 'a file is not a terminal to count');
    for (const id of FILES) assert.equal(terminalStatusIn(state, id), terminalStatusIn(state, 'no-such-tab'), `${id} has no terminal status`);
    const counts = unreadCountByTab(state.notifications);
    assert.equal(unreadIn(counts, terminalIds), 1, 'the terminals\u{2019} unread');
    assert.equal(unreadIn(counts, tabIdsOfKind(TERMINALS_ONLY, 'terminal')), 1, 'the same without the files');
    assert.equal(latestUnread(state.notifications, terminalIds)?.id, 'n1', 'the jump goes to a terminal');
    for (const id of FILES) assert.equal(typingHidden(state, id), false, `${id} is never a password prompt`);
    const progress = { t1: { state: 'normal', value: 40 }, t2: { state: 'normal', value: 80 }, e1: { state: 'error', value: 10 } };
    assert.deepEqual(groupProgress(progress, terminalIds), groupProgress(progress, ['t1', 't2', 't3']), 'a file adds nothing to the bar');
  });

  test('WF-N2: the TERMINALS side bar lists the same terminals, counts and agent sessions with the files as without them', async () => {
    const ui = await loadPanel();
    const read = async (tree) => {
      let seen = null;
      await onPage(async (p) => {
        const proto = Object.getPrototypeOf(p.document.createElement('div'));
        proto.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 30, right: 200, width: 190, height: 20 });
        Object.assign(p.window, { innerWidth: 1600, innerHeight: 900 });
        ui.useTerminalStore.setState({ tabs: [...TERMINALS, 't4'].map(termTab), groups: groupsWith(tree), activeGroupId: 'group-1', activeTabId: 't1', notifications: NOTES });
        p.render(h(ui.TerminalsPanel));
        await letItRun();
        const all = (sel, attr) => [...p.document.querySelectorAll(sel)].map((el) => el.getAttribute(attr));
        seen = {
          rows: all('[data-terminal-row]', 'data-terminal-row'),
          groups: all('[data-group-row]', 'data-group-row'),
          groupText: [...p.document.querySelectorAll('[data-group-row]')].map((el) => el.textContent),
          agentSessions: all('[data-agent-sessions-count]', 'data-agent-sessions-count'),
          text: p.document.body.textContent,
        };
      });
      return seen;
    };
    const mixed = await read(MIXED);
    const plain = await read(TERMINALS_ONLY);
    assert.deepEqual(mixed.rows, [...TERMINALS, 't4'], 'the terminal rows, in screen order');
    assert.deepEqual(mixed.rows, plain.rows);
    assert.deepEqual(mixed.groups, plain.groups);
    assert.deepEqual(mixed.groupText, plain.groupText, 'the group rows, their counts included, read the same');
    assert.deepEqual(mixed.agentSessions, plain.agentSessions, 'AGENT SESSIONS counts the same');
    for (const id of FILES) assert.equal(mixed.text.includes(`${id}.js`), false, `${id}.js is named in the side bar`);
  });

  test('WF-N3: the group chip counts the group\u{2019}s terminals, not its panes or files', async () => {
    await loadWorkbench();
    E.setState({ tabs: FILES.map(fileTab), activeTabId: 'e1', rootPath: '/workspace', pendingReveal: null });
    T.setState({ tabs: [...TERMINALS, 't4'].map(termTab), groups: groupsWith(MIXED), activeGroupId: 'group-1', activeTabId: 't1', notifications: [] });
    const html = await drawWorkbench();
    const chip = /data-group-chip="group-1"[^>]*title="([^"]*)"|title="([^"]*)"[^>]*data-group-chip="group-1"/.exec(html);
    assert.ok(chip, 'the group switcher draws group 1\u{2019}s chip');
    const title = (chip[1] ?? chip[2]).replace(/&#x27;/g, "'");
    assert.match(title, /^Group 1 \u2014 3 terminals\./, `the chip says three terminals: ${title}`);
  });

  test('WF-N4: the session save writes the terminals alone as the tabs whose scrollback comes back', async () => {
    const backing = new Map();
    const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k) => (backing.has(k) ? backing.get(k) : null), setItem: (k, v) => backing.set(k, String(v)), removeItem: (k) => backing.delete(k), clear: () => backing.clear() },
      configurable: true,
      writable: true,
    });
    try {
      useSettingsStore.setState({ terminalRestoreScrollback: true });
      T.setState({ tabs: [...TERMINALS, 't4'].map(termTab), groups: groupsWith(MIXED), activeGroupId: 'group-1', activeTabId: 't1', isInitialized: true });
      // A change the store saves, as any layout change is saved.
      T.getState().setActivePane('pane-t2');
      // Polled for, not waited a fixed time: the save is debounced, and a
      // loaded machine runs the timer late (C2 review S-03).
      const deadline = Date.now() + 10000;
      while (!backing.has(PERSIST_KEY) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const text = backing.get(PERSIST_KEY);
      assert.ok(text, 'setup: the session was saved');
      const payload = JSON.parse(text);
      assert.deepEqual(payload.data.tabs.map((t) => t.id), [...TERMINALS, 't4'], 'the terminals, and no file');
      for (const id of FILES) assert.equal(text.includes(`"id":"${id}","title"`), false, `${id} is saved as a terminal`);
    } finally {
      if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
      else delete globalThis.localStorage;
    }
  });
});

// --- TerminalsPanel bundled for a page (as agent_sessions_rename_mounted.test.js does) ---

const TERMINAL_DIR = fileURLToPath(new URL('../../src/components/terminal/', import.meta.url));
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'zustand']);

function lucideStandIn(file) {
  const names = new Set();
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return `const Icon = () => null; ${[...names].map((n) => `export const ${n} = Icon;`).join(' ')}`;
}

let loadingPanel = null;
function loadPanel() {
  loadingPanel ??= build({
    stdin: {
      contents: ["export { TerminalsPanel } from './TerminalsPanel.jsx';", "export { useTerminalStore } from '../../stores/terminalStore.js';"].join('\n'),
      resolveDir: TERMINAL_DIR,
      sourcefile: 'features-panel-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'panel-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            return args.path === 'lucide-react' ? { path: args.importer, namespace: 'lucide' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'lucide' }, (args) => ({ contents: lucideStandIn(args.path), loader: 'js' }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loadingPanel;
}
