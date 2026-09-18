/**
 * Does the app actually render?
 *
 * The other three suites cannot answer that. `tests/e2e/` and
 * `tests/adversarial/` exercise stores and pure functions in Node; nothing
 * mounts a component. So a mistake inside a render produced a clean build, a
 * clean `cargo test`, several hundred green cases — and a white screen the
 * moment that branch was drawn:
 *
 *   - `GroupSwitcher` read the `tabs` binding of a different component
 *   - `FileExplorer` used `cn` without importing it
 *
 * `npm run lint` now catches that exact shape before anything runs, and is the
 * cheaper net. This suite catches what lint cannot see: a render that throws
 * for a reason no static rule can know — reading `.length` off a prop that is
 * undefined in one state, a helper returning null where the JSX assumes an
 * object, a branch that only exists when a list is empty.
 *
 * Which is why the cases here are STATES, not components. Rendering a
 * component with no props proves very little; putting the stores into the
 * state a user reaches and rendering the whole tree is what found the bug.
 *
 * `renderToString` runs each component's body but no effects, which is the
 * right depth: effects are where the real backend would be needed, and that
 * is what driving the app is for (see TEST_INFRA.md).
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./jsxLoader.mjs', pathToFileURL(new URL('.', import.meta.url).pathname));

// The app reads these at module scope. jsdom would provide them; the point of
// this suite is that it does not need jsdom.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

/**
 * The narrowest `window` and `document` the module bodies need.
 *
 * Deliberately NOT jsdom. Anything a component reads from the DOM DURING a
 * render is a thing this suite should make visible, not paper over — the one
 * case that already exists (`getComputedStyle` for the terminal palette) is
 * read inside effects, which `renderToString` never runs.
 */
globalThis.window = {
  location: { search: '', href: 'app://nexterm/' },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: globalThis.matchMedia,
  localStorage: globalThis.localStorage,
  open() {},
};
globalThis.document = {
  documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: {} },
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, replaceChildren() {} }),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild() {}, removeChild() {} },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { default: React } = await import('react');
const { renderToString } = await import('react-dom/server');

const { useTerminalStore } = await import('../../src/stores/terminalStore.js');
const { useEditorStore } = await import('../../src/stores/editorStore.js');
const { useSettingsStore } = await import('../../src/stores/settingsStore.js');
const { default: App } = await import('../../src/App.jsx');

const results = [];
let failed = 0;

/** Put the stores in a state, render the whole app, and expect no throw. */
function scenario(id, description, arrange) {
  const started = Date.now();
  try {
    arrange();
    renderToString(React.createElement(App));
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

/** A terminal tab in whatever state the case needs. */
const tab = (id, extra = {}) => ({
  id,
  sessionId: `sess-${id}`,
  title: id,
  defaultTitle: id,
  cwd: '/workspace',
  blocks: [],
  running: false,
  lastExitCode: null,
  ...extra,
});

const baseGroups = (tabIds) => [
  {
    id: 'group-1',
    name: 'Group 1',
    createdAt: 0,
    tree: { type: 'leaf', id: 'pane-1', tabIds, activeTabId: tabIds[0] ?? null },
    activePaneId: 'pane-1',
  },
];

/** Back to a plain one-terminal workspace before each case. */
function reset() {
  useSettingsStore.getState().resetSettings();
  useSettingsStore.setState({ isCommandPaletteOpen: false, isSettingsModalOpen: false });
  useEditorStore.setState({ tabs: [], activeTabId: null, rootPath: '/workspace', rootResolved: true });
  useTerminalStore.setState({
    tabs: [tab('t1')],
    activeTabId: 't1',
    groups: baseGroups(['t1']),
    activeGroupId: 'group-1',
    isInitialized: true,
  });
}

scenario('RN-01', 'the app renders at all', () => {
  reset();
});

scenario('RN-02', 'no folder opened — the Explorer offers to open one', () => {
  reset();
  useEditorStore.setState({ rootPath: null, rootResolved: true });
});

scenario('RN-03', 'a pane holding no terminal', () => {
  // The state a split reaches when its last tab is closed. Renders the pane's
  // empty branch AND the group switcher's aggregate over zero tabs.
  reset();
  useTerminalStore.setState({ tabs: [], activeTabId: null, groups: baseGroups([]) });
});

scenario('RN-04', 'an editor pane holding no file', () => {
  reset();
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
  });
});

scenario('RN-05', 'several groups, one of them running and one failed', () => {
  // The activity dots, including the group-chip aggregate — the exact tree
  // that white-screened, because the chips are rendered by a component that
  // does not hold the pane tree.
  reset();
  useTerminalStore.setState({
    tabs: [tab('t1', { running: true }), tab('t2', { lastExitCode: 127 })],
    activeTabId: 't1',
    groups: [
      ...baseGroups(['t1']),
      {
        id: 'group-2',
        name: 'Group 2',
        createdAt: 0,
        tree: { type: 'leaf', id: 'pane-2', tabIds: ['t2'], activeTabId: 't2' },
        activePaneId: 'pane-2',
      },
    ],
  });
});

scenario('RN-06', 'a shell that has exited', () => {
  reset();
  useTerminalStore.setState({ tabs: [tab('t1', { exited: { code: 137 } })] });
});

scenario('RN-07', 'the find bar, open over a terminal', () => {
  reset();
  useTerminalStore.setState({
    find: { open: true, tabId: 't1', query: 'error', caseSensitive: true, wholeWord: false, regex: false, resultIndex: 0, resultCount: 3 },
  });
});

scenario('RN-08', 'the command palette, open', () => {
  reset();
  useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'all' });
});

scenario('RN-09', 'the settings window, open', () => {
  reset();
  useSettingsStore.setState({ isSettingsModalOpen: true });
});

scenario('RN-10', 'zoomed, so the status bar carries its chip', () => {
  reset();
  useSettingsStore.getState().zoomFont(4);
});

scenario('RN-11', 'every panel hidden at once', () => {
  reset();
  useSettingsStore.setState({ sidebarVisible: false, panelVisible: false, secondarySidebarVisible: false });
});

scenario('RN-12', 'a file open in the editor', () => {
  reset();
  useEditorStore.setState({
    tabs: [{ id: 'e1', filePath: '/workspace/a.js', fileName: 'a.js', content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' }],
    activeTabId: 'e1',
    editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: ['e1'], activeTabId: 'e1' },
  });
});

console.log('====================================================');
console.log('  NexTerm — Render Suite (does the tree draw?)      ');
console.log('====================================================\n');
for (const r of results) {
  if (r.ok) {
    console.log(`  ✔ ${r.id}: ${r.description} (${r.ms}ms)`);
  } else {
    console.log(`  ✖ ${r.id}: ${r.description}`);
    console.log(`      ${r.error?.stack?.split('\n').slice(0, 4).join('\n      ') ?? r.error}`);
  }
}
console.log('\n----------------------------------------------------');
console.log(`  Tests:    ${results.length} total`);
console.log(`  Passed:   ${results.length - failed}`);
console.log(`  Failed:   ${failed}`);
console.log('----------------------------------------------------');

if (failed > 0) {
  console.log('\n❌ THE APP DOES NOT RENDER IN ONE OF THESE STATES');
  process.exit(1);
}
console.log('\n✅ EVERY STATE RENDERS');
