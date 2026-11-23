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
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';

// `import.meta.url` straight through, never via `.pathname`. On Windows that
// property is `/D:/a/nexterm/...` — a URL path, leading slash and all — and
// feeding it back to `pathToFileURL` makes it relative, so the drive letter
// gets prepended twice and the loader is looked for at `D:\D:\a\nexterm`.
// CI caught it on windows-latest while macOS and Linux passed, which is this
// project's recurring shape: a path fix verified on one platform is not
// verified.
register('./jsxLoader.mjs', import.meta.url);

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
const { setEditorLayout } = await import('../e2e/harness/workbench.js');
const { useSettingsStore } = await import('../../src/stores/settingsStore.js');
const { useGitStore } = await import('../../src/stores/gitStore.js');
const { usePathDropStore } = await import('../../src/stores/pathDropStore.js');
const { useBranchStore } = await import('../../src/stores/branchStore.js');
const { useProjectCommandsStore } = await import('../../src/stores/projectCommandsStore.js');
const { useSystemStore } = await import('../../src/stores/systemStore.js');
const { useControlLogStore } = await import('../../src/stores/controlLogStore.js');
const { useAgentHistoryStore } = await import('../../src/stores/agentHistoryStore.js');
const { useAgentHistoryPromptStore } = await import('../../src/stores/agentHistoryPromptStore.js');
const { useTabSwitcherStore } = await import('../../src/stores/tabSwitcherStore.js');
const { useToastStore, setToastTimers, resetToasts, TOAST_MS } = await import('../../src/stores/toastStore.js');
const { default: App } = await import('../../src/App.jsx');
const TERMINAL_THEMES_MODULE = await import('../../src/lib/terminalThemes.js');

const STORES = [useTerminalStore, useEditorStore, useSettingsStore, useGitStore, usePathDropStore, useBranchStore, useProjectCommandsStore, useSystemStore, useControlLogStore, useAgentHistoryStore, useAgentHistoryPromptStore, useTabSwitcherStore, useToastStore];

/**
 * Every store as the app created it, taken before any case touches it.
 *
 * `reset` puts these back wholesale. It used to set a handful of keys and
 * leave the rest to whichever case ran last, which went unnoticed only while
 * no arranged state reached the render (see `renderArranged`): RN-11 hides
 * every panel, and every case after it then rendered with no terminal at all.
 */
const PRISTINE = STORES.map((s) => ({ ...s.getState() }));

const results = [];
let failed = 0;

/**
 * Render the app from the state a case arranged — which is not what a server
 * render does on its own.
 *
 * zustand answers `renderToString` from the state each store was CREATED
 * with (its `getServerSnapshot` is `getInitialState()`), never from what
 * `setState` put there since. So every case here used to draw the empty
 * startup state, whatever it arranged, and pass: the resume-offer cases found
 * it by coming out with no offer on screen. Nothing in the app reads
 * `getInitialState`, so pointing it at the arranged state changes what is
 * drawn and nothing else.
 */
function renderArranged() {
  for (const s of STORES) Object.assign(s.getInitialState(), s.getState());
  return renderToString(React.createElement(App));
}

/**
 * Put the stores in a state, render the whole app, and expect no throw.
 *
 * `check`, where a case has one, is handed the markup and throws when what
 * the user should be reading is not in it. Not throwing only proves the tree
 * drew; a banner can draw perfectly well and still say the wrong thing.
 */
function scenario(id, description, arrange, check) {
  const started = Date.now();
  try {
    arrange();
    const html = renderArranged();
    check?.(html);
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
  STORES.forEach((s, i) => s.setState({ ...PRISTINE[i] }, true));
  useGitStore.setState({ status: null, isLoaded: false });
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

scenario('RN-14', 'no folder open, with recent ones to offer', () => {
  reset();
  useEditorStore.setState({
    rootPath: null,
    rootResolved: true,
    recentRoots: ['/w/alpha', '/w/beta'],
  });
});

scenario('RN-15', 'a repository with a branch and changed files', () => {
  reset();
  useGitStore.setState({
    isLoaded: true,
    status: {
      branch: 'main',
      ahead: 2,
      behind: 1,
      truncated: false,
      files: [{ path: '/workspace/src/App.jsx', status: 'modified', staged: false }],
    },
  });
});

scenario('RN-16', 'the sticky command header turned off', () => {
  reset();
  useSettingsStore.getState().setSetting('terminalStickyHeader', false);
});

scenario('RN-16b', 'a terminal pane with prompt marks on the scrollbar (the default)', () => {
  reset();
  useSettingsStore.getState().setSetting('terminalPromptMarks', true);
});

scenario('RN-16c', 'a terminal pane with prompt marks turned off', () => {
  reset();
  useSettingsStore.getState().setSetting('terminalPromptMarks', false);
});

scenario(
  'RN-16d',
  'the settings window offers Prompt Marks on Scrollbar, on and off',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    expectText(html, 'Prompt Marks on Scrollbar');
    expectThat(html.includes('terminal.integrated.promptMarksOnScrollbar'), 'the row has no setting key');
    useSettingsStore.getState().setSetting('terminalPromptMarks', false);
    expectText(renderArranged(), 'Prompt Marks on Scrollbar');
  }
);

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
  });
  setEditorLayout();
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

scenario('RN-13', 'notifications waiting in the status bar', () => {
  reset();
  useTerminalStore.setState({
    notifications: [
      { id: 'n1', tabId: 't1', title: 'build', exitCode: 1, durationMs: 252000, at: 1, read: false },
      { id: 'n2', tabId: 't1', title: 'tests', exitCode: 0, durationMs: 38000, at: 2, read: false },
    ],
  });
});

scenario('RN-12', 'a file open in the editor', () => {
  reset();
  useEditorStore.setState({
    tabs: [{ id: 'e1', filePath: '/workspace/a.js', fileName: 'a.js', content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' }],
    activeTabId: 'e1',
  });
  setEditorLayout({ type: 'leaf', id: 'editor-pane-root', tabIds: ['e1'], activeTabId: 'e1' });
});

// ---- The releasability bridge (editor placement, sibling B, AC-B9) ---------
// Each view draws its own kind's projection of the group on screen.

const fileTab = (id) => ({ id, filePath: `/workspace/${id}.js`, fileName: `${id}.js`, content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' });
const editorLeaf = (id, tabIds) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId: tabIds[0] ?? null });
const terminalTree = () => ({
  type: 'split', id: 'split-t', direction: 'horizontal', sizes: [50, 50],
  children: [{ type: 'leaf', id: 'pane-t1', tabIds: ['t1'], activeTabId: 't1' }, { type: 'leaf', id: 'pane-t2', tabIds: ['t2'], activeTabId: 't2' }],
});

/** Two groups: group-1 [editors e1 | e2 above its terminals], group-2 [editor e3 above its own]; `active` on screen. */
function arrangeWorkbench(active = 'group-1', { wrapped = true } = {}) {
  reset();
  useEditorStore.setState({ tabs: ['e1', 'e2', 'e3'].map(fileTab), activeTabId: 'e1' });
  const editors = { type: 'split', id: 'split-e', direction: 'horizontal', sizes: [50, 50], children: [editorLeaf('pane-e1', ['e1']), editorLeaf('pane-e2', ['e2'])] };
  useTerminalStore.setState({
    tabs: [tab('t1'), tab('t2'), tab('t3')],
    activeTabId: active === 'group-1' ? 't1' : 't3',
    groups: [
      {
        id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-t1',
        ...(wrapped ? { editorPaneId: 'pane-e1', tree: { type: 'split', id: 'split-w', direction: 'vertical', sizes: [60, 40], children: [editors, terminalTree()] } } : { tree: terminalTree() }),
      },
      {
        id: 'group-2', name: 'Group 2', createdAt: 0, activePaneId: 'pane-t3', editorPaneId: 'pane-e3',
        tree: { type: 'split', id: 'split-w2', direction: 'vertical', sizes: [60, 40], children: [editorLeaf('pane-e3', ['e3']), { type: 'leaf', id: 'pane-t3', tabIds: ['t3'], activeTabId: 't3' }] },
      },
      { id: 'group-3', name: 'Group 3', createdAt: 0, activePaneId: 'pane-t4', tree: { type: 'leaf', id: 'pane-t4', tabIds: [], activeTabId: null } },
    ],
    activeGroupId: active,
  });
}

// The workbench draws the whole tree (editor placement, sibling C, FC2): its
// editor panes are drawn at once, with only their Monaco body lazy, so a
// server render of the app shows every pane of both kinds. The same checks,
// with TerminalSplitContainer bundled on its own, are in
// tests/adversarial/workbench_render.test.js (AC-C2).
const editorPanesIn = (html) => [...html.matchAll(/data-editor-pane-body="([^"]+)"/g)].map((m) => m[1]);
const terminalPanesIn = (html) => [...html.matchAll(/data-pane-body="([^"]+)"/g)].map((m) => m[1]);
/** Every pane body, of either kind, in the order drawn: `kind:id`. */
const panesInOrder = (html) =>
  [...html.matchAll(/data-(editor-pane-body|pane-body)="([^"]+)"/g)].map((m) => `${m[1] === 'pane-body' ? 'terminal' : 'editor'}:${m[2]}`);
/** The pane whose body holds the active line, or null; throws if there are two. */
function activeLineOf(html) {
  const at = [...html.matchAll(/data-active-pane=""/g)].map((m) => m.index);
  if (at.length === 0) return null;
  expectThat(at.length === 1, `${at.length} active lines on screen`);
  const before = [...html.slice(0, at[0]).matchAll(/data-(editor-pane-body|pane-body)="([^"]+)"/g)];
  return before.length ? before[before.length - 1][2] : null;
}

// Rewritten for sibling C (FC4): RN-B9b asserted that PanelLayout drew an
// `editor-group` Panel exactly while the group on screen had an editor leaf.
// The centre editor area is retired, so it now asserts that there is no
// editor-group and no Maximize Panel whatever the group holds, and that the
// files of the group on screen are drawn inside the terminal view instead.
scenario(
  'RN-B9b',
  'PanelLayout draws no editor-group and no Maximize Panel; the files of the group on screen are drawn in the workbench',
  () => arrangeWorkbench('group-1'),
  (html) => {
    expectThat(!html.includes('id="editor-group"'), 'a group with editor leaves still draws an editor-group');
    expectThat(!/Maximize Panel|Restore Panel Size/.test(html), 'the region header still offers Maximize Panel');
    expectThat(JSON.stringify(editorPanesIn(html)) === JSON.stringify(['pane-e1', 'pane-e2']), `the workbench draws the editor panes ${JSON.stringify(editorPanesIn(html))}`);
    arrangeWorkbench('group-3');
    const none = renderArranged();
    expectThat(!none.includes('id="editor-group"'), 'a group with no editor leaf draws an editor-group');
    expectThat(editorPanesIn(none).length === 0, 'and no editor pane, though files are open in other groups');
  }
);

// Rewritten for sibling C (FC2): RN-B9c asserted the bridge, that the terminal
// view drew the terminal PROJECTION of the group and the same panes with or
// without editor leaves wrapped in. The view now draws the full tree, so it
// asserts that both kinds are drawn in tree order, each by its own attributes
// (an editor pane never carries `data-pane-body`), and that a terminal-only
// group draws exactly its terminal panes, as before.
scenario(
  'RN-B9c',
  'the workbench draws both kinds in tree order, an editor pane with its own strip and body and never as a terminal pane',
  () => arrangeWorkbench('group-1', { wrapped: false }),
  (html) => {
    const plain = terminalPanesIn(html);
    expectThat(JSON.stringify(plain) === JSON.stringify(['pane-t1', 'pane-t2']), `without editors: ${JSON.stringify(plain)}`);
    expectThat(editorPanesIn(html).length === 0, 'an editor pane without an editor leaf');
    arrangeWorkbench('group-1', { wrapped: true });
    const wrapped = renderArranged();
    const order = panesInOrder(wrapped);
    expectThat(JSON.stringify(order) === JSON.stringify(['editor:pane-e1', 'editor:pane-e2', 'terminal:pane-t1', 'terminal:pane-t2']), `tree order: ${JSON.stringify(order)}`);
    expectThat(!terminalPanesIn(wrapped).some((id) => id.startsWith('pane-e')), 'an editor leaf is drawn as a terminal pane');
    for (const pane of ['pane-e1', 'pane-e2']) {
      expectThat(wrapped.includes(`data-editor-tab-strip="${pane}"`), `${pane} has no tab strip of its own`);
      expectThat(!wrapped.includes(`data-tab-strip="${pane}"`), `${pane} carries a terminal strip`);
    }
  }
);

// FC6 (AC-C6): one active line across both kinds, by the terminal's rule.
scenario(
  'RN-C6',
  'one active line across kinds: on the terminal pane, or on the file pane once a file is active; none while zoomed',
  () => arrangeWorkbench('group-1'),
  (html) => {
    expectThat(activeLineOf(html) === 'pane-t1', `terminal-active: the line is on ${activeLineOf(html)}`);
    const st = useTerminalStore.getState();
    useTerminalStore.setState({ groups: st.groups.map((g) => (g.id === 'group-1' ? { ...g, activeKind: 'editor', editorPaneId: 'pane-e2' } : g)) });
    const editorActive = renderArranged();
    expectThat(activeLineOf(editorActive) === 'pane-e2', `editor-active: the line is on ${activeLineOf(editorActive)}`);
    useTerminalStore.setState({ groups: useTerminalStore.getState().groups.map((g) => (g.id === 'group-1' ? { ...g, zoomedPaneId: 'pane-e2' } : g)) });
    const zoomed = renderArranged();
    expectThat(activeLineOf(zoomed) === null, 'a zoomed editor pane, alone on screen, is marked active');
    expectThat(JSON.stringify(panesInOrder(zoomed)) === JSON.stringify(['editor:pane-e2']), `the zoom hides both kinds: ${JSON.stringify(panesInOrder(zoomed))}`);
  }
);

// ---- Reading the markup back -----------------------------------------------

/**
 * The words a reader would see: tags out, entities back.
 *
 * `renderToString` puts `<!-- -->` between adjacent text nodes, so
 * `Resume {label}?` comes out as `Resume <!-- -->Claude Code<!-- -->?`, and a
 * plain `includes` on the markup misses text that is on the screen. `&amp;`
 * goes last so an escaped entity is not decoded twice.
 */
function visibleText(html) {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, '\n')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every `<button>` in the markup — enough to ask whether one is disabled and what its tooltip says. */
function buttonsIn(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({
    text: visibleText(inner).trim(),
    disabled: /\sdisabled=""/.test(attrs),
    title: visibleText(/\stitle="([^"]*)"/.exec(attrs)?.[1] ?? ''),
    label: /\saria-label="([^"]*)"/.exec(attrs)?.[1] ?? null,
  }));
}

/** A failed expectation, worded as what went wrong on screen. */
function expectThat(ok, wrong) {
  if (!ok) throw new Error(wrong);
}

function expectText(html, words) {
  expectThat(visibleText(html).includes(words), `rendered without ${JSON.stringify(words)}`);
}

/** The class list of the resume offer's own box, or null when it is not drawn. */
function resumeBannerClass(html) {
  return /<div\b[^>]*\sdata-agent-resume=""[^>]*\sclass="([^"]*)"/.exec(html)?.[1] ?? null;
}

/** A terminal restored from a workspace in which it was running an agent. */
const offering = (agent, extra = {}) =>
  tab('t1', { agent: { startedAt: Date.now() - 3 * 3600e3, ...agent }, agentResumeOffered: true, ...extra });

const CLAUDE = { kind: 'claude', sessionId: 'd4bef4d0-c043-40ef-b157-640fb31ac0ea' };

// ---- The offer to resume an agent -------------------------------------------

scenario(
  'RN-17',
  'a restored terminal offers its Claude Code conversation back',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering(CLAUDE)] });
  },
  (html) => {
    expectText(html, 'Resume Claude Code?');
    // `startedAt` is when the agent was started; resuming never moves it, so
    // "last used" was a claim nothing recorded.
    expectText(html, 'Picks up the conversation this terminal had, started 3h ago.');
    expectText(html, 'The terminal’s own scrollback is not restored.');
    expectThat(!visibleText(html).includes('last used'), 'still says "last used"');
    // Laid over the terminal it hid the prompt; it is a row above it now.
    const cls = resumeBannerClass(html);
    expectThat(cls !== null, 'the offer is not drawn');
    expectThat(!/\babsolute\b/.test(cls), `the offer is positioned over the terminal again: "${cls}"`);
    const resume = buttonsIn(html).find((b) => b.text === 'Resume');
    expectThat(resume, 'no Resume button');
    expectThat(!resume.disabled, 'Resume is disabled with nothing running');
  }
);

scenario(
  'RN-18',
  'opencode that never learned its conversation, the run\u{2019}s only one: the most recent in this folder or below, said as such',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering({ kind: 'opencode', sessionId: null })] });
  },
  (html) => {
    expectText(html, 'Resume opencode?');
    // What Resume then types is `opencode --continue`, which opens the most
    // recent conversation in the folder or BELOW it — the offer says so,
    // and says the time is this terminal's, not that conversation's.
    expectText(
      html,
      'Picks up the most recent opencode conversation in this folder or below; opencode was started in this terminal 3h ago.'
    );
    expectThat(
      !visibleText(html).includes('the conversation this terminal had'),
      'promises opencode the exact conversation, which it does not know'
    );
  }
);

scenario(
  'RN-74',
  'opencode that never learned its conversation, beside another opencode terminal: it asks \u{2014} no "most recent"',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        offering({ kind: 'opencode', sessionId: null }),
        tab('t2', { agent: { kind: 'opencode', sessionId: null, startedAt: 1, title: 'Other' }, agentResumeOffered: true }),
      ],
    });
  },
  (html) => {
    expectText(
      html,
      'Asks which of this folder\u{2019}s opencode conversations this terminal had \u{2014} it never learned its name; opencode was started in this terminal 3h ago.'
    );
    expectThat(!visibleText(html).includes('most recent'), 'offers "the most recent", which Resume will not type here');
  }
);

scenario(
  'RN-19',
  'the offer while a program is in the foreground — Resume waits, Dismiss does not',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering(CLAUDE, { running: true })] });
  },
  (html) => {
    // Still offered: hiding it would look like the offer was gone for good.
    expectText(html, 'Resume Claude Code?');
    const buttons = buttonsIn(html);
    const resume = buttons.find((b) => b.text === 'Resume');
    expectThat(resume, 'Resume is hidden while running — it should be there, disabled');
    expectThat(resume.disabled, 'Resume can be clicked while a program is running, and would type into it');
    expectThat(
      resume.title.includes('still running in this terminal') && resume.title.includes('Resume would type into it'),
      `Resume's tooltip does not say why: ${JSON.stringify(resume.title)}`
    );
    const dismiss = buttons.find((b) => b.label === 'Dismiss');
    expectThat(dismiss, 'no Dismiss button');
    expectThat(!dismiss.disabled, 'Dismiss is disabled while running');
  }
);

const OPENCODE_KNOWN = { kind: 'opencode', sessionId: 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA', title: 'Fix the login bug' };

scenario(
  'RN-40',
  'an opencode terminal that learned its conversation offers that one back, by name',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering(OPENCODE_KNOWN)] });
  },
  (html) => {
    expectText(html, 'Resume opencode?');
    expectText(html, 'Picks up \u201cFix the login bug\u201d, the conversation this terminal had, started 3h ago.');
    const buttons = buttonsIn(html);
    const choose = buttons.find((b) => b.text === 'Choose…');
    expectThat(choose, 'no Choose… to pick another of the folder\'s conversations');
    expectThat(!choose.disabled, 'Choose… is disabled with nothing running');
    expectThat(buttons.find((b) => b.text === 'Resume'), 'no Resume button');
  }
);

scenario(
  'RN-41',
  'an opencode terminal that saw a title but no id looks it up by name \u{2014} alone in the run, the most recent if not found',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering({ ...OPENCODE_KNOWN, sessionId: null })] });
  },
  (html) => {
    expectText(
      html,
      'Looks up \u{201C}Fix the login bug\u{201D}, the conversation this terminal had, by its name \u{2014} or, not found, the most recent opencode conversation in this folder or below; opencode was started in this terminal 3h ago.'
    );
    expectThat(!visibleText(html).includes('Picks up \u{201C}'), 'promises the exact conversation without its id');
    expectThat(buttonsIn(html).find((b) => b.text === 'Choose\u{2026}'), 'no Choose\u{2026} when the resume cannot be exact');
    expectThat(!/data-agent-resume-notice/.test(html), 'a notice with nothing to say');
  }
);

scenario(
  'RN-75',
  'the same beside another opencode terminal: by name, and it asks if it cannot tell \u{2014} no "most recent"',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        offering({ ...OPENCODE_KNOWN, sessionId: null }),
        tab('t2', { agent: { kind: 'opencode', sessionId: 'ses_bbbbbbbbbbbbBBBBBBBBBBBBBB', startedAt: 1, title: 'B' } }),
      ],
    });
  },
  (html) => {
    expectText(
      html,
      'Looks up \u{201C}Fix the login bug\u{201D}, the conversation this terminal had, by its name, and asks if it cannot tell; opencode was started in this terminal 3h ago.'
    );
    expectThat(!visibleText(html).includes('most recent'), 'offers "the most recent", which Resume will not type here');
  }
);

scenario(
  'RN-76',
  'a conversation picked from the list that another terminal already has \u{2014} refused, and the banner says where it is',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        offering(
          { kind: 'opencode', sessionId: null },
          { agentResumeNotice: { kind: 'taken', heldBy: 'Terminal 2', latest: false, seq: 4 } }
        ),
      ],
    });
  },
  (html) => {
    expectText(html, 'That conversation is open in Terminal 2 already \u{2014} choose another.');
  }
);

scenario(
  'RN-77',
  'the most recent picked from the list after another terminal continued it \u{2014} refused, and said',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        offering(
          { kind: 'opencode', sessionId: null },
          { agentResumeNotice: { kind: 'taken', heldBy: 'Terminal 3', latest: true, seq: 5 } }
        ),
      ],
    });
  },
  (html) => {
    expectText(html, 'Terminal 3 already continued the most recent conversation \u{2014} choose another.');
  }
);

scenario(
  'RN-69',
  'Resume looking up the conversation says so, and neither button can be pressed again meanwhile',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [offering({ ...OPENCODE_KNOWN, sessionId: null }, { agentResumeLooking: true })],
    });
  },
  (html) => {
    expectText(html, 'Looking for this terminal\u{2019}s conversation\u{2026}');
    const buttons = buttonsIn(html);
    for (const name of ['Resume', 'Choose\u{2026}']) {
      const button = buttons.find((b) => b.text === name);
      expectThat(button, `no ${name} button`);
      expectThat(button.disabled, `${name} can be pressed again while the conversation is looked up`);
      expectThat(button.title.includes('Looking for this terminal'), `${name} does not say why it waits`);
    }
    expectThat(!buttons.find((b) => b.label === 'Dismiss').disabled, 'Dismiss is disabled while it looks');
  }
);

scenario(
  'RN-70',
  'Resume could not tell which conversation this terminal had \u{2014} it says so, and both ways on stay open',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        offering({ kind: 'opencode', sessionId: null }, { agentResumeNotice: { kind: 'unsure', reason: null, shared: true, seq: 1 } }),
      ],
    });
  },
  (html) => {
    expectText(html, 'Could not tell which conversation this terminal had \u{2014} choose one below.');
    expectThat(/data-agent-resume-notice=""[^>]*class="[^"]*text-vsc-warn/.test(html), 'the notice is not drawn as a warning');
    const buttons = buttonsIn(html);
    expectThat(buttons.find((b) => b.text === 'Choose\u{2026}') && !buttons.find((b) => b.text === 'Choose\u{2026}').disabled, 'Choose\u{2026} is not there to choose with');
    expectThat(!buttons.find((b) => b.text === 'Resume').disabled, 'Resume cannot be tried again');
  }
);

scenario(
  'RN-71',
  'the list could not be read in a folder another opencode shares \u{2014} the backend\u{2019}s reason word for word, and why nothing was typed',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        offering(
          { ...OPENCODE_KNOWN, sessionId: null },
          {
            agentResumeNotice: {
              kind: 'unreadable',
              reason: "opencode session list failed: 'node' is not recognized as an internal or external command,",
              shared: true,
              seq: 2,
            },
          }
        ),
      ],
    });
  },
  (html) => {
    expectText(
      html,
      "Could not list opencode\u{2019}s conversations: opencode session list failed: 'node' is not recognized as an internal or external command. Another opencode terminal is in this folder, above it or below it, so the most recent conversation may be that terminal\u{2019}s \u{2014} choose below."
    );
  }
);

scenario(
  'RN-72',
  'opencode not found: the reason ends the sentence once, however the backend punctuated it',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        offering(
          { kind: 'opencode', sessionId: null },
          { agentResumeNotice: { kind: 'unreadable', reason: 'opencode was not found on PATH.', shared: true, seq: 3 } }
        ),
      ],
    });
  },
  (html) => {
    expectText(html, 'Could not list opencode\u{2019}s conversations: opencode was not found on PATH. Another opencode terminal');
    expectThat(!visibleText(html).includes('PATH..'), 'the reason ends in two full stops');
    expectThat(/data-agent-resume-notice=""[^>]*class="[^"]*text-vsc-warn/.test(html), 'the notice is not drawn as a warning');
  }
);

scenario(
  'RN-73',
  'Claude Code with no id is still offered as the folder\u{2019}s most recent \u{2014} nothing about it changed',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering({ kind: 'claude', sessionId: null })] });
  },
  (html) => {
    expectText(
      html,
      'Picks up the most recent Claude Code conversation in this folder; Claude Code was started in this terminal 3h ago.'
    );
    expectThat(!buttonsIn(html).some((b) => b.text === 'Choose\u{2026}'), 'a Choose\u{2026} with nothing behind it');
  }
);

scenario(
  'RN-42',
  'Claude Code is offered without a list — its resume is exact already',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering(CLAUDE)] });
  },
  (html) => {
    expectText(html, 'Resume Claude Code?');
    expectThat(!buttonsIn(html).some((b) => b.text === 'Choose…'), 'a Choose… with nothing behind it');
  }
);

scenario(
  'RN-43',
  'Choose… waits like Resume while a program is in the foreground',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering(OPENCODE_KNOWN, { running: true })] });
  },
  (html) => {
    const choose = buttonsIn(html).find((b) => b.text === 'Choose…');
    expectThat(choose, 'Choose… is hidden while running — it should be there, disabled');
    expectThat(choose.disabled, 'Choose… can be clicked while a program is running, and would type into it');
    expectThat(choose.title.includes('Resume would type into it'), `no reason given: ${JSON.stringify(choose.title)}`);
  }
);

// ---- Go to File in a big folder ---------------------------------------------

scenario(
  'RN-44',
  'Go to File in a folder of 1,000 files draws a screenful of rows and says how many more matched',
  () => {
    reset();
    useEditorStore.setState({
      fileTree: Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}.js`, path: `/workspace/f${i}.js`, is_dir: false })),
    });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'files' });
  },
  (html) => {
    // Every file row ends in its "File" hint.
    const rows = html.match(/>File<\/kbd>/g)?.length ?? 0;
    expectThat(rows === 200, `${rows} file rows drawn for an empty query`);
    expectText(html, '800 more — keep typing to narrow the list');
    expectText(html, 'f0.js');
  }
);

// ---- A file that would not open ----------------------------------------------

scenario(
  'RN-45',
  'a file the backend would not open says which and why, over the corner of the window',
  () => {
    reset();
    useEditorStore.setState({
      openFailure: {
        path: '/workspace/logs/app.log',
        fileName: 'app.log',
        reason: 'File is too large to open (60.1 MB; the limit is 50 MB)',
      },
    });
  },
  (html) => {
    expectText(html, 'Could not open app.log');
    expectText(html, 'File is too large to open (60.1 MB; the limit is 50 MB)');
    expectThat(/<div\b[^>]*\srole="alert"/.test(html), 'the reason is not announced');
    expectThat(buttonsIn(html).some((b) => b.title === 'Dismiss'), 'nothing to close it with');
  }
);

// ---- A command that finished without a code --------------------------------

/** The class list of the status bar's notification badge, or null when it is not drawn. */
function notificationBadgeClass(html) {
  // The attribute holds the unread count.
  return /<span\b[^>]*\sdata-notification-count="[^"]*"[^>]*\sclass="([^"]*)"/.exec(html)?.[1] ?? null;
}

scenario(
  'RN-20',
  'cmd commands that finished while you were elsewhere are not called failures',
  () => {
    reset();
    // cmd's prompt can say a command ended but not how, so its notifications
    // carry no code at all. Unread, as every entry is made, so the badge counts them.
    useTerminalStore.setState({
      notifications: [
        { id: 'n1', tabId: 't1', title: 'ping -n 15 localhost', exitCode: null, durationMs: 14000, at: 1, read: false },
        { id: 'n2', tabId: 't1', title: 'build.cmd', exitCode: null, durationMs: 61000, at: 2, read: false },
      ],
    });
  },
  (html) => {
    const cls = notificationBadgeClass(html);
    expectThat(cls !== null, 'the notification badge is not drawn');
    expectThat(!/\bbg-vsc-error\b/.test(cls), `two finished commands are counted as failures: "${cls}"`);
    expectText(html, '2');
  }
);

// ---- What a program asked to tell you ---------------------------------------

/**
 * The list inside the bell opens only on a click, which a server render never
 * makes, so RN-29 draws the list itself — as RN-21 draws an editor tab strip.
 */
const { NotificationList } = await import('../../src/components/layout/NotificationCenter.jsx');

/** The bell's own button — the one that opens the list — as `{ label, title, state, cls, count }`, or null. */
function bellButton(html) {
  // Found by its own attribute — not the first button with `aria-expanded`:
  // off macOS the title bar's Application Menu comes first, and the suite
  // decides "off macOS" from `navigator.platform`, which Node 20 (CI, on every
  // OS) does not have and Node 24 does. Nor by the count inside it, which a
  // bell with nothing unread does not draw.
  const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, attrs]) =>
    /\sdata-notification-bell="/.test(attrs)
  );
  if (!button) return null;
  const [, attrs, inner] = button;
  return {
    label: visibleText(/\saria-label="([^"]*)"/.exec(attrs)?.[1] ?? ''),
    title: visibleText(/\stitle="([^"]*)"/.exec(attrs)?.[1] ?? ''),
    state: /\sdata-notification-bell="([^"]*)"/.exec(attrs)?.[1] ?? null,
    cls: /\sclass="([^"]*)"/.exec(attrs)?.[1] ?? '',
    count: /\sdata-notification-count="([^"]*)"/.exec(inner)?.[1] ?? null,
  };
}

/** A program's message, as `notifyFromProgram` puts it in the list: unread. */
const programNote = (id, extra = {}) => ({
  id,
  kind: 'program',
  tabId: 't1',
  tabTitle: 't1',
  title: 'opencode',
  body: 'Session done',
  at: 1,
  read: false,
  ...extra,
});

scenario(
  'RN-27',
  "a program's message in the status bar is counted as one, and is no failure",
  () => {
    reset();
    useTerminalStore.setState({ notifications: [programNote('p1')] });
  },
  (html) => {
    const cls = notificationBadgeClass(html);
    expectThat(cls !== null, 'the notification badge is not drawn');
    expectThat(!/\bbg-vsc-error\b/.test(cls), `a message from a program is counted as a failure: "${cls}"`);
    const bell = bellButton(html);
    expectThat(bell, 'no bell button');
    expectThat(
      bell.label === '1 message from a program \u{2014} 1 unread notification',
      `the bell is called ${JSON.stringify(bell.label)}`
    );
    expectThat(
      bell.title === '1 message from a program while you were elsewhere \u{2014} 1 unread notification',
      `the bell's tooltip says ${JSON.stringify(bell.title)}`
    );
  }
);

scenario(
  'RN-28',
  'messages beside a failed command — the badge is red for the command, and the bell names both',
  () => {
    reset();
    useTerminalStore.setState({
      notifications: [
        programNote('p1'),
        programNote('p2', { title: 'Claude Code', body: 'Claude is waiting for your input' }),
        { id: 'n1', tabId: 't1', title: 'build', exitCode: 1, durationMs: 252000, at: 1, read: false },
      ],
    });
  },
  (html) => {
    expectThat(/\bbg-vsc-error\b/.test(notificationBadgeClass(html) ?? ''), 'a failed command no longer turns the badge red');
    const bell = bellButton(html);
    // The red, in words: a colour is not something a screen reader reads out.
    expectThat(
      bell?.label === '1 finished command and 2 messages from programs \u{2014} 3 unread notifications, 1 of them a failed command',
      `the bell is called ${JSON.stringify(bell?.label)}`
    );
    expectThat(bell.title.endsWith('3 unread notifications, 1 of them a failed command'), `the bell's tooltip says ${JSON.stringify(bell.title)}`);
    expectText(html, '3');
  }
);

{
  const id = 'RN-29';
  const description = "the list draws a program's title over its message, and still a command's exit code";
  const started = Date.now();
  try {
    reset();
    const long = `Permission needs input: ${'run the migration script against staging, '.repeat(6)}then report back`;
    const html = renderToString(
      React.createElement(NotificationList, {
        notifications: [
          programNote('p1', { tabId: 't2', tabTitle: 'Terminal 2', title: 'Hello from the mock.', body: 'Session done' }),
          programNote('p2', { title: 'Only a title', body: '' }),
          programNote('p3', { title: 'opencode', body: long }),
          { id: 'n1', tabId: 't1', title: 'build', exitCode: 1, durationMs: 252000, at: 1 },
        ],
        onGo() {},
        onDismiss() {},
      })
    );
    const kinds = [...html.matchAll(/\sdata-notification-entry="([^"]+)"/g)].map((m) => m[1]);
    expectThat(
      JSON.stringify(kinds) === JSON.stringify(['program', 'program', 'program', 'command']),
      `the entries are drawn as ${JSON.stringify(kinds)}`
    );
    expectText(html, 'Hello from the mock.');
    expectText(html, 'Session done');
    expectText(html, 'exit 1');
    const go = buttonsIn(html).filter((b) => b.title.startsWith('Go to '));
    expectThat(go[0]?.title === 'Go to Terminal 2', `the first entry goes to ${JSON.stringify(go[0]?.title)}, not its terminal`);
    expectThat(go[3]?.title === 'Go to build', `the command's entry goes to ${JSON.stringify(go[3]?.title)}`);
    // Cut to one line by CSS; the whole message is still there, and on hover.
    expectThat(visibleText(html).includes(long), 'the long message is not in the markup whole');
    expectThat(html.includes(`title="${long}"`), 'the long message has no tooltip of its own');
    // A program's entry has no exit code and no duration, and no empty second line.
    const programRows = html.split('data-notification-entry="program"').slice(1, 4).map((s) => s.split('data-notification-entry=')[0]);
    for (const row of programRows) expectThat(!/exit \d|\d+m \d+s/.test(visibleText(row)), 'a program entry shows a verdict');
    expectThat(!/<span[^>]*text-vsc-muted[^>]*><\/span>/.test(programRows[1]), 'an empty message draws an empty line');
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

scenario(
  'RN-30',
  'the settings window offers notifications from programs',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    expectText(html, 'Notifications from Programs');
  }
);

// ---- What a right-click does ------------------------------------------------

/** The Right Click row's select: the values it offers, and the one drawn as chosen. */
function rightClickSelect(html) {
  const at = html.indexOf('terminal.integrated.rightClickBehavior');
  if (at === -1) return null;
  const select = /<select\b[^>]*>([\s\S]*?)<\/select>/.exec(html.slice(at))?.[1];
  if (select === undefined) return null;
  const options = [...select.matchAll(/<option\b([^>]*)>/g)].map(([, attrs]) => ({
    value: /\svalue="([^"]*)"/.exec(attrs)?.[1] ?? null,
    selected: /\sselected=""/.test(attrs),
  }));
  return { values: options.map((o) => o.value), chosen: options.filter((o) => o.selected).map((o) => o.value) };
}

for (const [id, value] of [
  ['RN-31', 'copyPaste'],
  ['RN-32', 'default'],
]) {
  scenario(
    id,
    `the settings window offers the right-click, with ${value} drawn as chosen`,
    () => {
      reset();
      useSettingsStore.setState({ isSettingsModalOpen: true });
      useSettingsStore.getState().setSetting('terminalRightClick', value);
    },
    (html) => {
      expectText(html, 'Right Click');
      const select = rightClickSelect(html);
      expectThat(select, 'the Right Click row draws no select');
      expectThat(select.values.join() === 'copyPaste,default', `it offers ${JSON.stringify(select.values)}`);
      expectThat(select.chosen.join() === value, `it draws ${JSON.stringify(select.chosen)} as chosen, not ${value}`);
    }
  );
}

// ---- The three safety settings ---------------------------------------------

scenario(
  'RN-67',
  'the settings window offers the trash, the multi-line paste warning and the batch-job reply, at their defaults',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    expectText(html, 'Files');
    expectText(html, 'Enable Trash');
    expectText(html, 'files.enableTrash');
    expectText(html, 'Multi-Line Paste Warning');
    expectText(html, 'terminal.integrated.enableMultiLinePasteWarning');
    expectText(html, 'terminal.integrated.autoReplies');
    expectText(html, 'Terminate batch job (Y/N)?');
    const at = html.indexOf('terminal.integrated.enableMultiLinePasteWarning');
    const select = /<select\b[^>]*>([\s\S]*?)<\/select>/.exec(html.slice(at))?.[1] ?? '';
    const options = [...select.matchAll(/<option\b([^>]*)>/g)].map(([, attrs]) => ({
      value: /\svalue="([^"]*)"/.exec(attrs)?.[1] ?? null,
      selected: /\sselected=""/.test(attrs),
    }));
    expectThat(options.map((o) => o.value).join() === 'auto,always,never', `it offers ${JSON.stringify(options)}`);
    expectThat(options.filter((o) => o.selected).map((o) => o.value).join() === 'auto', 'auto is drawn as chosen');
  }
);

scenario(
  'RN-68',
  'the settings window offers Restore Open Editors among the editor settings, on by default',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    expectText(html, 'Restore Open Editors');
    const at = html.indexOf('workbench.editor.restoreOpenEditors');
    expectThat(at !== -1, 'rendered without its setting key');
    expectThat(
      html.indexOf('editor.minimap.enabled') < at && at < html.indexOf('files.enableTrash'),
      'it is not drawn with the editor settings'
    );
    const box = /<input\b[^>]*type="checkbox"[^>]*>/.exec(html.slice(at))?.[0] ?? '';
    expectThat(/\schecked=""/.test(box), `drawn unchecked: ${box}`);
  }
);

// ---- Keyboard Shortcuts -----------------------------------------------------

scenario(
  'RN-60',
  'a keypress bound to two commands is reported, naming the one that runs',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
    // Open Folder's chord given to Open Recent too. Open Folder comes first in
    // the bindings, so it is the one the keypress runs — though Open Recent
    // is listed above it, and the banner used to say "whichever is listed
    // first wins".
    useSettingsStore.getState().setSetting('keybindings', { 'open-recent': 'mod+shift+o' });
  },
  (html) => {
    expectText(html, 'One shortcut never runs');
    expectText(html, 'runs Open Folder…, never Open Recent…');
    expectThat(!visibleText(html).includes('Whichever is listed first wins'), 'the banner still names no winner');
    // Both rows' chords are marked, and each says what happens.
    const marked = [...html.matchAll(/<kbd\b[^>]*\stitle="([^"]*)"[^>]*\sclass="[^"]*border-vsc-error/g)]
      .map((m) => visibleText(m[1]));
    expectThat(
      marked.length === 2 && marked.every((t) => t.includes('runs Open Folder…, never Open Recent…')),
      `the marked chords say ${JSON.stringify(marked)}`
    );
  }
);

const { COMMANDS, configurableCommands, keysFor } = await import('../../src/lib/keybindings.js');
// The platform the Settings note is drawn for: KeybindingSettings takes it
// from `navigator`, which Node 20 (CI, on every OS) does not have and Node 24
// does. Off macOS a macOS-only chord (Go to Tab 1's ⌘1) takes nothing, and
// the note leaves the command out, so the keys counted here are that
// platform's too.
const { isMac: noteIsMac } = await import('../../src/lib/platform.js');

scenario(
  'RN-61',
  'Settings names every bound shortcut a focused terminal never sees, and only those',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    // It said only the two side-bar toggles were claimed over a terminal,
    // while ten commands were.
    const note = visibleText(html).split('\n').find((line) => line.startsWith('Over a focused terminal'));
    expectThat(note, 'no note about what a focused terminal never sees');
    // A command claimed over a terminal takes keys from the shell only when
    // it has some: one with no chord (Mark All Notifications Read, as
    // shipped) takes nothing, and naming it would say otherwise.
    let unbound = 0;
    for (const { id, title } of configurableCommands()) {
      const named = note.includes(title);
      const bound = keysFor(id, undefined, { isMac: noteIsMac }).length > 0;
      if (COMMANDS[id].overTerminal && bound) expectThat(named, `${title} is taken ahead of the terminal, and the note does not say so`);
      else if (COMMANDS[id].overTerminal) {
        unbound += 1;
        expectThat(!named, `the note says ${title} is taken ahead of the terminal; it has no keys to take`);
      } else expectThat(!named, `the note says ${title} is taken ahead of the terminal; it is not`);
    }
    // Otherwise the case above checks nothing.
    expectThat(unbound > 0, 'setup: every command claimed over a terminal has keys, so an unbound one is never tried');
  }
);

// ---- The activity bar ---------------------------------------------------------

/** Whether the activity bar draws its icon called `title` lit. */
function activityLit(html, title) {
  const icon = new RegExp(`<button\\b[^>]*\\stitle="${title}"[^>]*\\sclass="([^"]*)"`).exec(html);
  expectThat(icon, `no activity-bar icon called ${title}`);
  return !icon[1].includes('text-vsc-activitybar-muted');
}

const SEARCH_VIEW = /\saria-label="Search across files"/;

scenario(
  'RN-62',
  'with Search on screen, the activity bar lights Search and not the Explorer',
  () => {
    reset();
    useSettingsStore.getState().showView('search');
    // What the layout does once it has drawn the request. The activity bar
    // used to read the request, so from here on it lit the Explorer.
    useSettingsStore.getState().clearRequestedView();
  },
  (html) => {
    expectThat(!activityLit(html, 'Explorer'), 'the Explorer is lit while Search is on screen');
    expectThat(activityLit(html, 'Search'), 'Search is on screen and its icon is not lit');
    expectThat(SEARCH_VIEW.test(html), 'the side bar does not draw Search');
  }
);

scenario(
  'RN-63',
  'with the Explorer on screen, the Explorer is lit and not Search',
  () => {
    reset();
  },
  (html) => {
    expectThat(!SEARCH_VIEW.test(html), 'the side bar draws Search');
    expectThat(activityLit(html, 'Explorer'), 'the Explorer is on screen and its icon is not lit');
    expectThat(!activityLit(html, 'Search'), 'Search is lit while the Explorer is on screen');
  }
);

// ---- Dragging an editor tab over a tab strip ---------------------------------

/**
 * The editor is the one part of the app the whole-App render cannot reach:
 * PanelLayout loads it lazily, and `renderToString` draws a lazy component's
 * Suspense fallback instead. So these cases render the tab strip itself,
 * inside the drag context EditorPanel provides, in the state a drag is in
 * while the pointer is over a strip.
 */
const { EditorTabs, EditorDragContext } = await import('../../src/components/editor/EditorTabs.jsx');

const editorTab = (id) => ({
  id,
  filePath: `/workspace/${id}.js`,
  fileName: `${id}.js`,
  content: '',
  savedContent: '',
  isDirty: false,
  language: 'javascript',
});

/** A drag that has crossed the threshold, with the pointer over `targetPaneId`. */
const draggingOver = (targetPaneId, zone, index) => ({
  tabId: 'e1', title: 'e1.js', startX: 0, startY: 0, x: 100, y: 10,
  active: true, targetPaneId, zone, index,
});

/** The root group's tab strip holding `tabIds`, drawn while `drag` is in progress. */
function renderStrip(tabIds, drag) {
  const node = { type: 'leaf', id: 'editor-pane-root', tabIds, activeTabId: tabIds[0] ?? null };
  return renderToString(
    React.createElement(
      EditorDragContext.Provider,
      { value: { drag, beginDrag() {} } },
      React.createElement(EditorTabs, { node })
    )
  );
}

/** The strip read left to right: chip ids, with MARK where the drop marker is drawn. */
const stripSequence = (html) =>
  [...html.matchAll(/data-tab-chip="([^"]+)"|data-tab-drop-marker=""/g)].map((m) => m[1] ?? 'MARK');

function stripCase(id, description, check) {
  const started = Date.now();
  try {
    reset();
    useEditorStore.setState({ tabs: ['e1', 'e2', 'e3', 'e4'].map(editorTab) });
    for (const s of STORES) Object.assign(s.getInitialState(), s.getState());
    check();
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

const ALL = ['e1', 'e2', 'e3', 'e4'];

stripCase('RN-21', 'a tab dragged over its own strip draws one marker, in the gap the pointer is over', () => {
  const seq = stripSequence(renderStrip(ALL, draggingOver('editor-pane-root', 'tabs', 2)));
  expectThat(
    JSON.stringify(seq) === JSON.stringify(['e1', 'e2', 'MARK', 'e3', 'e4']),
    `gap 2 is between e2 and e3, but the strip reads ${JSON.stringify(seq)}`
  );
});

stripCase('RN-22', 'the first and last gaps draw the marker at the ends of the strip', () => {
  for (const [gap, expected] of [
    [0, ['MARK', ...ALL]],
    [ALL.length, [...ALL, 'MARK']],
  ]) {
    // A tab from another group: beside a tab's own chip a drop moves nothing, and draws no marker.
    const seq = stripSequence(renderStrip(ALL, { ...draggingOver('editor-pane-root', 'tabs', gap), tabId: 'x9' }));
    expectThat(JSON.stringify(seq) === JSON.stringify(expected), `gap ${gap}: the strip reads ${JSON.stringify(seq)}`);
  }
});

stripCase('RN-23', "an empty group's strip draws the marker, with a height of its own", () => {
  const html = renderStrip([], draggingOver('editor-pane-root', 'tabs', 0));
  const seq = stripSequence(html);
  expectThat(JSON.stringify(seq) === '["MARK"]', `the empty strip reads ${JSON.stringify(seq)}`);
  // Stretched to the chips' height instead, it was zero pixels tall in a
  // strip with no chips — found by dragging into a freshly split group.
  const cls = /<div\b[^>]*\sdata-tab-drop-marker=""[^>]*\sclass="([^"]*)"/.exec(html)?.[1] ?? '';
  expectThat(/\bh-tab\b/.test(cls), `the marker takes its height from its neighbours again: "${cls}"`);
});

stripCase('RN-24', 'a strip the pointer is not over draws no marker', () => {
  for (const [where, drag] of [
    ["another group's strip", draggingOver('editor-pane-2', 'tabs', 1)],
    ["this group's body", draggingOver('editor-pane-root', 'center', null)],
    ['a press still under the drag threshold', { ...draggingOver('editor-pane-root', 'tabs', 1), active: false }],
  ]) {
    const seq = stripSequence(renderStrip(ALL, drag));
    expectThat(!seq.includes('MARK'), `a marker is drawn with the pointer over ${where}: ${JSON.stringify(seq)}`);
  }
});

// ---- The order a drag leaves behind ------------------------------------------

/** The values of one attribute, in the order the markup lists them. */
const attrOrder = (html, attr) => [...html.matchAll(new RegExp(`\\s${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);

scenario(
  'RN-25',
  "a pane draws its tabs in the pane's own order, not the order the terminals were opened",
  () => {
    reset();
    // Opened t1, t2, t3; dragged into t3, t1, t2. The pane's `tabIds` is the
    // only place that order lives, and what is saved — a strip drawn from
    // `tabs` would put every reorder back on screen while keeping it on disk.
    useTerminalStore.setState({
      tabs: [tab('t1'), tab('t2'), tab('t3')],
      activeTabId: 't2',
      groups: [
        { ...baseGroups([])[0], tree: { type: 'leaf', id: 'pane-1', tabIds: ['t3', 't1', 't2'], activeTabId: 't2' } },
      ],
    });
  },
  (html) => {
    const chips = attrOrder(html, 'data-tab-chip');
    expectThat(
      JSON.stringify(chips) === JSON.stringify(['t3', 't1', 't2']),
      `the strip draws ${JSON.stringify(chips)}, not the pane's order ["t3","t1","t2"]`
    );
  }
);

scenario(
  'RN-26',
  'the switcher draws the groups in the order they were dragged into, the one on screen included',
  () => {
    reset();
    const group = (id, tabId) => ({
      id,
      name: id,
      createdAt: Number(id.slice(-1)),
      tree: { type: 'leaf', id: `pane-${id}`, tabIds: [tabId], activeTabId: tabId },
      activePaneId: `pane-${id}`,
    });
    // Created 1, 2, 3; dragged into 3, 1, 2 — with the one on screen no
    // longer first, so drawing it first would show as a reorder undone.
    useTerminalStore.setState({
      tabs: [tab('t1'), tab('t2'), tab('t3')],
      activeTabId: 't2',
      groups: [group('group-3', 't3'), group('group-1', 't1'), group('group-2', 't2')],
      activeGroupId: 'group-2',
    });
  },
  (html) => {
    const chips = attrOrder(html, 'data-group-chip');
    expectThat(
      JSON.stringify(chips) === JSON.stringify(['group-3', 'group-1', 'group-2']),
      `the switcher draws ${JSON.stringify(chips)}, not the order the groups are in: ["group-3","group-1","group-2"]`
    );
  }
);

// ---- A zoomed pane ----------------------------------------------------------

/** One group split into three panes side by side, each holding one terminal. */
function threePaneGroup(extra = {}) {
  return {
    id: 'group-1',
    name: 'Group 1',
    createdAt: 0,
    tree: {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 30, 20],
      children: ['a', 'b', 'c'].map((p) => ({ type: 'leaf', id: `pane-${p}`, tabIds: [`t-${p}`], activeTabId: `t-${p}` })),
    },
    activePaneId: 'pane-b',
    ...extra,
  };
}

function arrangeThreePanes(groupExtra = {}) {
  reset();
  useTerminalStore.setState({
    tabs: [tab('t-a'), tab('t-b'), tab('t-c')],
    activeTabId: 't-b',
    groups: [threePaneGroup(groupExtra)],
    activeGroupId: 'group-1',
  });
}

/** Markup of the zoomed-pane chip, or null when it is not drawn. */
const zoomedChip = (html) => /<button\b[^>]*\sdata-zoomed-chip=""[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? null;

scenario(
  'RN-33',
  'a zoomed group draws its zoomed pane alone, with a chip that says so',
  () => arrangeThreePanes({ zoomedPaneId: 'pane-b' }),
  (html) => {
    // The hidden panes are not mounted: neither their strips nor their bodies
    // are in the markup at all — which is also why their terminals are told
    // they lost focus, and keep their WebGL renderers, as another group's do.
    const strips = attrOrder(html, 'data-tab-strip');
    expectThat(JSON.stringify(strips) === '["pane-b"]', `the panes drawn are ${JSON.stringify(strips)}, not just pane-b`);
    const chips = attrOrder(html, 'data-tab-chip');
    expectThat(JSON.stringify(chips) === '["t-b"]', `the tab chips drawn are ${JSON.stringify(chips)}`);
    const chip = zoomedChip(html);
    expectThat(chip, 'no "Zoomed" chip on the zoomed pane');
    expectText(chip, 'Zoomed');
    const title = visibleText(/\stitle="([^"]*)"/.exec(chip)?.[1] ?? '');
    expectThat(
      title.includes('2 other panes hidden, still running') && title.includes('Click to show every pane'),
      `the chip's tooltip does not say what is hidden or how to get it back: ${JSON.stringify(title)}`
    );
    expectThat(/\saria-pressed="true"/.test(chip), 'the chip is not marked as a pressed toggle');
    // The group's chip in the switcher says it too: every group keeps its zoom.
    expectThat(/aria-label="one pane zoomed"/.test(html), "the group's switcher chip does not mark it zoomed");
  }
);

scenario(
  'RN-34',
  'the same group unzoomed draws every pane, each with a zoom button and no chip',
  () => arrangeThreePanes(),
  (html) => {
    const strips = attrOrder(html, 'data-tab-strip');
    expectThat(
      JSON.stringify(strips) === '["pane-a","pane-b","pane-c"]',
      `the panes drawn are ${JSON.stringify(strips)}`
    );
    expectThat(zoomedChip(html) === null, 'a "Zoomed" chip is drawn with nothing zoomed');
    const zoomButtons = buttonsIn(html).filter((b) => b.title.startsWith('Zoom Pane'));
    expectThat(zoomButtons.length === 3, `${zoomButtons.length} zoom buttons for three panes`);
    expectThat(!/aria-label="one pane zoomed"/.test(html), 'the switcher marks an unzoomed group as zoomed');
  }
);

scenario(
  'RN-35',
  'a group with one pane offers no zoom at all',
  () => reset(),
  (html) => {
    expectThat(zoomedChip(html) === null, 'a chip is drawn for a pane with nothing to hide');
    const zoomButtons = buttonsIn(html).filter((b) => b.title.startsWith('Zoom Pane'));
    expectThat(zoomButtons.length === 0, 'a lone pane offers to zoom');
  }
);

scenario(
  'RN-36',
  'a zoom that names a pane no longer there draws the whole group rather than nothing',
  () => arrangeThreePanes({ zoomedPaneId: 'pane-gone' }),
  (html) => {
    const strips = attrOrder(html, 'data-tab-strip');
    expectThat(strips.length === 3, `drew ${JSON.stringify(strips)}`);
    expectThat(zoomedChip(html) === null, 'a chip for a zoom that cannot be');
  }
);

// ---- Files dropped on a terminal ------------------------------------------------

/** Markup of the pane body for `paneId`, up to the next pane's strip or body. */
function paneBody(html, paneId) {
  const start = html.indexOf(`data-pane-body="${paneId}"`);
  if (start === -1) return null;
  const rest = html.slice(start + 1);
  const next = rest.search(/data-(?:pane-body|tab-strip)="/);
  return next === -1 ? rest : rest.slice(0, next);
}

scenario(
  'RN-64',
  'files dragged over one pane of three: that pane alone says it will insert them, and how many',
  () => {
    arrangeThreePanes();
    usePathDropStore.setState({ target: { paneId: 'pane-c', count: 3 } });
  },
  (html) => {
    const targets = attrOrder(html, 'data-path-drop-target');
    expectThat(JSON.stringify(targets) === '["pane-c"]', `highlighted ${JSON.stringify(targets)}, not just pane-c`);
    expectThat(paneBody(html, 'pane-c')?.includes('data-path-drop-target="pane-c"'), 'the highlight is not inside the pane body');
    expectText(html, 'Insert 3 paths');
    const overlay = /<div\b[^>]*\sdata-path-drop-target="pane-c"[^>]*>/.exec(html)?.[0] ?? '';
    expectThat(/pointer-events-none/.test(overlay), 'the highlight takes the pointer — the pane under it could no longer be found');
    expectThat(/aria-hidden="true"/.test(overlay), 'the highlight is read out');
  }
);

scenario(
  'RN-65',
  'one path dragged over a pane reads "Insert path"',
  () => {
    reset();
    usePathDropStore.setState({ target: { paneId: 'pane-1', count: 1 } });
  },
  (html) => {
    expectText(html, 'Insert path');
    expectThat(!visibleText(html).includes('Insert 1 paths'), 'counted one path as many');
  }
);

scenario(
  'RN-66',
  'a highlight for a pane that is not on screen draws nothing',
  () => {
    arrangeThreePanes({ zoomedPaneId: 'pane-b' });
    usePathDropStore.setState({ target: { paneId: 'pane-a', count: 2 } });
  },
  (html) => {
    expectThat(attrOrder(html, 'data-path-drop-target').length === 0, 'a hidden pane drew a highlight');
    expectThat(!visibleText(html).includes('Insert 2 paths'), 'the label is on screen');
  }
);

// ---- Layout templates: startup commands ----------------------------------------

/** A saved group whose first terminal starts the dev server when it opens. */
const savedTemplate = {
  id: 'saved-dev',
  name: 'Dev',
  savedAt: Date.now() - 60e3,
  tabs: [
    { slotId: 'slot-0', title: 'server', cwd: '/workspace/api', command: 'npm run dev' },
    { slotId: 'slot-1', title: 'shell', cwd: '/workspace' },
  ],
  activePaneId: 'saved-pane-1',
  tree: { type: 'leaf', id: 'saved-pane-1', tabIds: ['slot-0', 'slot-1'], activeTabId: 'slot-0' },
};

/** Markup of the TERMINALS panel's row for a saved group, found by its name. */
function savedRow(html, name) {
  // React writes the bare `data-row` out as `data-row="true"`.
  const rows = [...html.matchAll(/<div\b[^>]*\sdata-row="[^"]*"[^>]*>[\s\S]*?<\/div>/g)].map((m) => m[0]);
  return rows.find((row) => visibleText(row).includes(name) && /Double-click to load/.test(row)) ?? null;
}

scenario(
  'RN-37',
  'a saved group with a startup command says so, and its tooltip says what will run',
  () => {
    reset();
    useTerminalStore.setState({ savedGroups: [savedTemplate, { ...savedTemplate, id: 'saved-plain', name: 'Plain', tabs: [savedTemplate.tabs[1]] }] });
  },
  (html) => {
    const row = savedRow(html, 'Dev');
    expectThat(row, 'the saved group "Dev" is not listed');
    expectThat(/\sdata-startup-count="1"/.test(row), 'the row does not show that one terminal starts something');
    const title = visibleText(/\stitle="([^"]*)"/.exec(row)?.[1] ?? '');
    expectThat(
      title.includes('Runs when opened:') && title.includes('server: npm run dev'),
      `the tooltip does not say what opening it runs: ${JSON.stringify(title)}`
    );
    const plain = savedRow(html, 'Plain');
    expectThat(plain && !/data-startup-count/.test(plain), 'a group with no command is marked as starting one');
    expectThat(!/Runs when opened/.test(plain ?? ''), 'a group with no command has a "runs" tooltip');
  }
);

/**
 * The dialog opens from a right-click, which a server render never makes, so
 * these draw it directly — as RN-29 draws the bell's list.
 */
const { StartupCommandsDialog, StartupCommandField } = await import(
  '../../src/components/terminal/StartupCommandsDialog.jsx'
);

{
  const id = 'RN-38';
  const description = 'Edit Startup Commands lists every terminal with its directory and command, grouped for a workspace';
  const started = Date.now();
  try {
    reset();
    const html = renderToString(
      React.createElement(StartupCommandsDialog, {
        title: 'Startup Commands — Desk',
        intro: 'Each terminal types its command as soon as its shell is ready.',
        sections: [
          {
            key: 'group-0',
            label: 'Backend',
            terminals: [
              { key: '0/slot-0', title: 'server', cwd: '~/api', command: 'npm run dev' },
              { key: '0/slot-1', title: 'repl', cwd: '~/api', command: '' },
            ],
          },
          { key: 'group-1', label: 'Agents', terminals: [{ key: '1/slot-0', title: 'agent', cwd: '~', command: 'claude' }] },
        ],
        onSave() {},
        onCancel() {},
      })
    );
    expectThat(/\srole="dialog"/.test(html) && /\saria-modal="true"/.test(html), 'not drawn as a modal dialog');
    expectText(html, 'Startup Commands — Desk');
    for (const words of ['Backend', 'Agents', 'server', 'repl', 'agent', '~/api']) expectText(html, words);
    const fields = attrOrder(html, 'data-startup-field');
    expectThat(
      JSON.stringify(fields) === JSON.stringify(['0/slot-0', '0/slot-1', '1/slot-0']),
      `the fields are drawn as ${JSON.stringify(fields)}`
    );
    const values = [...html.matchAll(/<input\b[^>]*\svalue="([^"]*)"/g)].map((m) => m[1]);
    expectThat(
      JSON.stringify(values) === JSON.stringify(['npm run dev', '', 'claude']),
      `the fields hold ${JSON.stringify(values)}`
    );
    expectThat(/placeholder="just a shell"/.test(html), 'an empty field does not say it means just a shell');
    const buttons = buttonsIn(html).map((b) => b.text);
    expectThat(buttons.includes('Save') && buttons.includes('Cancel'), `the buttons are ${JSON.stringify(buttons)}`);
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

{
  const id = 'RN-39';
  const description = 'a refused command says why, under its own field';
  const started = Date.now();
  try {
    reset();
    const reason = 'A startup command is one line — it is typed into the shell and run with one Enter.';
    const html = renderToString(
      React.createElement(StartupCommandField, {
        id: 'slot-0',
        title: 'server',
        cwd: '~/api',
        value: 'npm install',
        error: reason,
        onChange() {},
      })
    );
    expectText(html, reason);
    expectThat(/\srole="alert"/.test(html), 'the reason is not announced');
    expectThat(/\saria-invalid="true"/.test(html), 'the field is not marked invalid');
    expectThat(/\saria-describedby="startup-slot-0-error"/.test(html), 'the field does not point at its reason');
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

// ---- Which terminal is waiting for you ----------------------------------------

/**
 * Every attention ring drawn, in order, as `{ kind, pane, tag }`. A ring is
 * the last thing in its pane, after the pane's strip and body, so the pane it
 * belongs to is the strip drawn last before it.
 */
function attentionRings(html) {
  return [...html.matchAll(/<div\b[^>]*\sdata-attention-ring="([^"]+)"[^>]*>/g)].map((m) => ({
    kind: m[1],
    pane: [...html.slice(0, m.index).matchAll(/\sdata-tab-strip="([^"]+)"/g)].at(-1)?.[1] ?? null,
    tag: m[0],
  }));
}

/** The markup of a chip: spans, an icon and a button inside, never a div, so up to its own closing tag. */
const chipMarkup = (html, attr, id) =>
  new RegExp(`<div\\b[^>]*\\s${attr}="${id}"[^>]*>[\\s\\S]*?</div>`).exec(html)?.[0] ?? null;
const tabChip = (html, id) => chipMarkup(html, 'data-tab-chip', id);
const groupChip = (html, id) => chipMarkup(html, 'data-group-chip', id);

/** The TERMINALS side bar's row whose name is `name` — a terminal's title or a group's name. */
function sideRow(html, name) {
  const rows = [...html.matchAll(/<div\b[^>]*\sdata-row="[^"]*"[^>]*>[\s\S]*?<\/div>/g)].map((m) => m[0]);
  // `Pane {n}` comes out as `Pane <!-- -->1`.
  return rows.find((row) => row.replace(/<!-- -->/g, '').includes(`<span class="truncate">${name}</span>`)) ?? null;
}

/** The unread pill in some markup, as `{ count, text, label }`, or null when there is none. */
function pillIn(markup) {
  const m = /<span\b([^>]*)\sdata-unread-count="([^"]*)"([^>]*)>([^<]*)<\/span>/.exec(markup ?? '');
  if (!m) return null;
  return { count: m[2], text: m[4], label: /\saria-label="([^"]*)"/.exec(m[1] + m[3])?.[1] ?? null, tag: m[0] };
}

/** The progress bar in some markup, as `{ state, value, width, fill }`, or null when there is none. */
function progressIn(markup) {
  const m = /<span\b([^>]*)\sdata-progress-state="([^"]+)"([^>]*)>(<span\b[^>]*>)<\/span><\/span>/.exec(markup ?? '');
  if (!m) return null;
  return {
    state: m[2],
    value: /\sdata-progress-value="([^"]*)"/.exec(m[1] + m[3])?.[1] ?? null,
    width: /\sstyle="width:\s*([^;"]+)/.exec(m[4])?.[1] ?? null,
    fill: /\sclass="([^"]*)"/.exec(m[4])?.[1] ?? '',
  };
}

/** `n` entries for `tabId`, as the store makes them; `read` as given. */
const entriesFor = (tabId, n, read = false) =>
  Array.from({ length: n }, (_, i) => programNote(`${tabId}-${read ? 'r' : 'u'}${i}`, { tabId, tabTitle: tabId, read }));

scenario(
  'RN-78',
  'a terminal waiting in a pane that is not the active one: that pane rings, and only that one',
  () => {
    arrangeThreePanes();
    useTerminalStore.setState({
      // t-a waits; t-c's entry has been read, which rings nothing.
      notifications: [...entriesFor('t-a', 1), ...entriesFor('t-c', 1, true)],
    });
  },
  (html) => {
    const rings = attentionRings(html);
    expectThat(
      JSON.stringify(rings.map((r) => [r.kind, r.pane])) === '[["unread","pane-a"]]',
      `rings drawn: ${JSON.stringify(rings.map((r) => [r.kind, r.pane]))}, not one unread ring on pane-a`
    );
    // Over the pane, and never in the way: drops find their pane with
    // elementFromPoint, which must go straight through it.
    expectThat(/pointer-events-none/.test(rings[0].tag), 'the ring takes the pointer');
    expectThat(/aria-hidden="true"/.test(rings[0].tag), 'the ring is read out');
    expectThat(/\bring-vsc-attention\b/.test(rings[0].tag), `the ring is not drawn in the attention colour: ${rings[0].tag}`);
    expectThat(/\banimate-attention-pulse\b/.test(rings[0].tag), 'the ring does not pulse');
    // Inside the pane body, in the margin it keeps round the terminal: laid
    // over the whole pane it cut the first column of every row in half.
    expectThat((paneBody(html, 'pane-a') ?? '').includes('data-attention-ring="unread"'), 'the ring is not drawn in the pane body');
    expectThat(/\binset-px\b/.test(rings[0].tag) && /\bring-2\b/.test(rings[0].tag), `the ring is not 2px, one in: ${rings[0].tag}`);
    const title = visibleText(/\stitle="([^"]*)"/.exec(tabChip(html, 't-a') ?? '')?.[1] ?? '');
    expectThat(title.endsWith('1 unread notification'), `the tab's tooltip does not say it is waiting: ${JSON.stringify(title)}`);
  }
);

scenario(
  'RN-79',
  'the counts on the tab chip, the group chips and the side bar \u{2014} "9+" past nine, nothing for what was read',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [tab('t1', { title: 'alpha' }), tab('t2', { title: 'bravo' }), tab('t3', { title: 'charlie' }), tab('t4', { title: 'delta' })],
      activeTabId: 't1',
      groups: [
        { ...baseGroups([])[0], tree: { type: 'leaf', id: 'pane-1', tabIds: ['t1', 't4'], activeTabId: 't1' } },
        {
          id: 'group-2',
          name: 'Group 2',
          createdAt: 0,
          tree: { type: 'leaf', id: 'pane-2', tabIds: ['t2', 't3'], activeTabId: 't2' },
          activePaneId: 'pane-2',
        },
      ],
      notifications: [
        ...entriesFor('t4', 12),
        ...entriesFor('t2', 2),
        ...entriesFor('t2', 1, true),
        ...entriesFor('t3', 1),
        ...entriesFor('t1', 1, true),
      ],
    });
  },
  (html) => {
    const expect = (where, markup, text, count) => {
      expectThat(markup, `${where} is not drawn`);
      const pill = pillIn(markup);
      if (text === null) {
        expectThat(pill === null, `${where} has a pill for entries already read: ${JSON.stringify(pill)}`);
        return;
      }
      expectThat(pill, `${where} has no unread pill`);
      expectThat(pill.text === text, `${where}'s pill says ${JSON.stringify(pill.text)}, not ${text}`);
      const words = `${count} unread notification${count === 1 ? '' : 's'}`;
      expectThat(pill.label === words, `${where}'s pill is read out as ${JSON.stringify(pill.label)}, not "${words}"`);
    };
    expect('the tab chip "delta"', tabChip(html, 't4'), '9+', 12);
    expect('the tab chip "alpha"', tabChip(html, 't1'), null);
    expect('the chip of the group on screen', groupChip(html, 'group-1'), '9+', 12);
    expect('the chip of the group off screen', groupChip(html, 'group-2'), '3', 3);
    expect('the side bar row "delta"', sideRow(html, 'delta'), '9+', 12);
    expect('the side bar row "bravo"', sideRow(html, 'bravo'), '2', 2);
    expect('the side bar row "charlie"', sideRow(html, 'charlie'), '1', 1);
    expect('the side bar row "alpha"', sideRow(html, 'alpha'), null);
    expect('the side bar row "Group 2"', sideRow(html, 'Group 2'), '3', 3);
    // In line, right after the title and before the \u{2715}. Laid over the
    // chip's corner it covered the \u{2715} and sat against the next tab's
    // title, reading as that one's.
    for (const [where, markup, title] of [
      ['the tab chip', tabChip(html, 't4'), '<span class="truncate max-w-[120px]">delta</span>'],
      ['the group chip', groupChip(html, 'group-2'), '<span class="truncate max-w-[140px]">Group 2</span>'],
    ]) {
      const tag = pillIn(markup).tag;
      expectThat(markup.includes(`${title}${tag}`), `${where}'s count is not right after its title`);
      expectThat(!/\babsolute\b/.test(tag), `${where}'s count is laid over the chip again: ${tag}`);
      // Fixed height under the chip's; gives no ground to a long title; one line.
      for (const cls of ['h-[14px]', 'shrink-0', 'whitespace-nowrap']) {
        expectThat(tag.includes(cls), `${where}'s count has no ${cls}: ${tag}`);
      }
    }
    expectThat(!/\babsolute\b/.test(pillIn(sideRow(html, 'delta')).tag), 'the side bar count is laid over its row');
    const groupTitle = visibleText(/\stitle="([^"]*)"/.exec(groupChip(html, 'group-2'))?.[1] ?? '');
    expectThat(groupTitle.includes(', 3 unread notifications. Click to switch'), `the group's tooltip: ${JSON.stringify(groupTitle)}`);
    // The dot is about what the terminal is doing, and stays out of this.
    expectThat(!/data-activity=/.test(tabChip(html, 't4')), 'a dot drawn for unread entries');
  }
);

/** A group of one pane holding `tabIds`. */
const groupOf = (id, tabIds) => ({
  id,
  name: id,
  createdAt: 0,
  tree: { type: 'leaf', id: `pane-${id}`, tabIds, activeTabId: tabIds[0] },
  activePaneId: `pane-${id}`,
});

const PROGRESS = {
  t1: { state: 'normal', value: 40 },
  t2: { state: 'error', value: null },
  t5: { state: 'warning', value: 55 },
  t3: { state: 'indeterminate', value: null },
  t4: { state: 'normal', value: 70 },
  t6: { state: 'indeterminate', value: null },
};

function arrangeProgress() {
  reset();
  useTerminalStore.setState({
    tabs: ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => tab(id)),
    activeTabId: 't1',
    groups: [groupOf('group-1', ['t1', 't2', 't5']), groupOf('group-2', ['t3', 't4']), groupOf('group-3', ['t6'])],
    activeGroupId: 'group-1',
    progress: PROGRESS,
  });
}

scenario(
  'RN-80',
  'progress along the bottom of each tab chip, and each group chip showing its tabs as one',
  arrangeProgress,
  (html) => {
    const expect = (where, markup, state, width, colour) => {
      const bar = progressIn(markup);
      expectThat(bar, `${where} draws no progress bar`);
      expectThat(bar.state === state, `${where}'s bar is ${bar.state}, not ${state}`);
      expectThat(bar.width === width, `${where}'s bar is ${bar.width} wide, not ${width}`);
      expectThat(new RegExp(`\\b${colour}\\b`).test(bar.fill), `${where}'s bar is not ${colour}: ${bar.fill}`);
    };
    expect('the tab at 40%', tabChip(html, 't1'), 'normal', '40%', 'bg-vsc-accent');
    // An error with no amount is a full bar.
    expect('the failed tab', tabChip(html, 't2'), 'error', '100%', 'bg-vsc-error');
    expect('the paused tab', tabChip(html, 't5'), 'warning', '55%', 'bg-vsc-warn');
    // An error beats a warning beats a normal bar beats an indeterminate one.
    expect('the group with an error', groupChip(html, 'group-1'), 'error', '100%', 'bg-vsc-error');
    expect('the group at 70% and busy', groupChip(html, 'group-2'), 'normal', '70%', 'bg-vsc-accent');
    const busy = progressIn(groupChip(html, 'group-3'));
    expectThat(busy?.state === 'indeterminate', `the busy group's bar is ${JSON.stringify(busy)}`);
    expectThat(busy.width === null && /\bw-\[30%\]/.test(busy.fill) && /\banimate-progress-indeterminate\b/.test(busy.fill), `an indeterminate bar is not a sliding segment: ${JSON.stringify(busy)}`);
    expectThat(!/\sdata-progress-state=/.test(paneBody(html, 'pane-group-1') ?? ''), 'a bar drawn over the terminal');
    // The same in words, for a screen reader: a chip is named from its content.
    const words = (markup) => /<span data-progress-words="" class="sr-only">([^<]*)<\/span>/.exec(markup ?? '')?.[1] ?? null;
    for (const [where, markup, said] of [
      ['the tab at 40%', tabChip(html, 't1'), '40% done'],
      ['the failed tab', tabChip(html, 't2'), 'error'],
      ['the paused tab', tabChip(html, 't5'), 'paused at 55%'],
      ['the group at 70% and busy', groupChip(html, 'group-2'), '70% done'],
      ['the busy group', groupChip(html, 'group-3'), 'working'],
    ]) {
      expectThat(words(markup) === said, `${where} says ${JSON.stringify(words(markup))}, not "${said}"`);
    }
  }
);

scenario(
  'RN-81',
  'with Progress Bars off, no bar is drawn even from bars the store still has',
  () => {
    arrangeProgress();
    // Turning it off empties the map (terminalStore's settings subscription);
    // the bars are put back behind it, as a report already on its way could
    // be. What is left is what a component must not draw.
    useSettingsStore.getState().setSetting('terminalProgress', false);
    useTerminalStore.setState({ progress: PROGRESS });
  },
  (html) => {
    expectThat(Object.keys(useTerminalStore.getState().progress).length === 6, 'setup: the store no longer has the bars');
    expectThat(!/\sdata-progress-state=/.test(html), 'a bar is drawn with Progress Bars off');
  }
);

scenario(
  'RN-82',
  'every entry read: the bell stays, muted and without a number',
  () => {
    reset();
    useTerminalStore.setState({
      notifications: [
        programNote('p1', { read: true }),
        { id: 'n1', tabId: 't1', title: 'build', exitCode: 1, durationMs: 252000, at: 1, read: true },
      ],
    });
  },
  (html) => {
    const bell = bellButton(html);
    expectThat(bell, 'the bell is gone with entries still in it');
    expectThat(bell.state === 'read', `the bell says ${JSON.stringify(bell.state)}`);
    expectThat(bell.count === null, `the bell still counts ${bell.count}`);
    expectThat(/\btext-vsc-muted\b/.test(bell.cls), `the bell is not muted: ${bell.cls}`);
    expectThat(bell.label.endsWith('\u{2014} all read'), `the bell is called ${JSON.stringify(bell.label)}`);
  }
);

scenario(
  'RN-83',
  'the bell counts what is unread, and a failure already read does not turn it red',
  () => {
    reset();
    useTerminalStore.setState({
      notifications: [
        programNote('p1'),
        programNote('p2', { title: 'Claude Code', body: 'Claude is waiting for your input' }),
        { id: 'n1', tabId: 't1', title: 'build', exitCode: 1, durationMs: 252000, at: 1, read: true },
      ],
    });
  },
  (html) => {
    const bell = bellButton(html);
    expectThat(bell?.count === '2', `the bell counts ${bell?.count}, not the 2 unread of 3`);
    expectThat(bell.state === 'unread' && !/\btext-vsc-muted\b/.test(bell.cls), `the bell is muted with 2 unread: ${bell.cls}`);
    const cls = notificationBadgeClass(html);
    expectThat(!/\bbg-vsc-error\b/.test(cls ?? ''), `a failure already read turns the badge red: "${cls}"`);
    expectThat(bell.label.endsWith('\u{2014} 2 unread notifications'), `the bell is called ${JSON.stringify(bell.label)}`);
  }
);

{
  const id = 'RN-84';
  const description = 'the list draws unread entries bold with a dot, read ones dimmed, and a bell with its count';
  const started = Date.now();
  try {
    reset();
    const html = renderToString(
      React.createElement(NotificationList, {
        notifications: [
          programNote('p1', { title: 'Permission needed' }),
          { id: 'n1', tabId: 't1', title: 'tests', exitCode: 0, durationMs: 38000, at: 1, read: true },
          { id: 'b1', kind: 'bell', tabId: 't2', tabTitle: 'Terminal 2', title: 'Terminal 2', body: '', count: 3, at: 3, read: false },
          { id: 'b2', kind: 'bell', tabId: 't3', tabTitle: 'Terminal 3', title: 'Terminal 3', body: '', count: 1, at: 2, read: true },
        ],
        onGo() {},
        onDismiss() {},
      })
    );
    const rows = html.split(/(?=<div\b[^>]*\sdata-notification-entry=)/).slice(1);
    const kinds = rows.map((r) => /\sdata-notification-entry="([^"]+)"/.exec(r)?.[1]);
    expectThat(JSON.stringify(kinds) === '["program","command","bell","bell"]', `the entries are drawn as ${JSON.stringify(kinds)}`);
    const unread = rows.map((r) => /\sdata-unread="([^"]+)"/.exec(r)?.[1]);
    expectThat(JSON.stringify(unread) === '["true","false","true","false"]', `read and unread are drawn as ${JSON.stringify(unread)}`);
    rows.forEach((row, i) => {
      const isUnreadRow = unread[i] === 'true';
      const dot = /<span aria-hidden="true"(?: data-unread-dot="")? class="([^"]*rounded-full[^"]*)"><\/span>/.exec(row)?.[1] ?? '';
      expectThat(/\bbg-vsc-attention\b/.test(dot) === isUnreadRow, `row ${i + 1}: the dot is ${isUnreadRow ? 'missing' : 'drawn on a read entry'}`);
      expectThat(/font-semibold/.test(row) === isUnreadRow, `row ${i + 1}: ${isUnreadRow ? 'not bold while unread' : 'bold once read'}`);
      // Read is said by colour, not by fading: faded, the 11px lines were 3:1.
      expectThat(!/opacity-60/.test(row), `row ${i + 1}: faded`);
      const title = /<span class="(truncate text-ui [^"]*)">/.exec(row)?.[1] ?? '';
      expectThat(
        isUnreadRow ? /\btext-vsc-fg font-semibold\b/.test(title) : /^truncate text-ui text-vsc-muted\b/.test(title),
        `row ${i + 1}: the title is ${JSON.stringify(title)} while ${isUnreadRow ? 'unread' : 'read'}`
      );
      // A muted line under the row's highlight would be under 4.5:1; it brightens there.
      for (const [, cls] of row.matchAll(/class="([^"]*text-vsc-muted[^"]*)"/g)) {
        if (/text-ui/.test(cls)) expectThat(/group-hover\/note:text-vsc-fg/.test(cls) && /group-focus-within\/note:text-vsc-fg/.test(cls), `row ${i + 1}: a muted line stays muted highlighted: ${cls}`);
      }
      // The \u{2715} is there for the keyboard, not only for the pointer.
      const dismissCls = /<button\b[^>]*\saria-label="Dismiss"[^>]*\sclass="([^"]*)"/.exec(row)?.[1] ?? '';
      expectThat(
        /group-focus-within\/note:opacity-100/.test(dismissCls) && /focus-visible:opacity-100/.test(dismissCls),
        `row ${i + 1}: the Dismiss button stays invisible with the keyboard on it: ${dismissCls}`
      );
      expectThat(/<button\b[^>]*\sdata-notification-go=""/.test(row), `row ${i + 1}: no entry button for the keyboard to land on`);
      expectThat(visibleText(row).includes('Unread:') === isUnreadRow, `row ${i + 1}: the unread state is not said in words`);
    });
    // A bell is the terminal's name, its own icon, and how many times it rang.
    expectThat(/lucide-bell-ring/.test(rows[2]) && /lucide-bell-ring/.test(rows[3]), 'a bell entry has no bell icon');
    expectThat(visibleText(rows[2]).includes('Bell \u{00d7}3'), `the bell that rang three times says ${JSON.stringify(visibleText(rows[2]).trim())}`);
    expectThat(/\bBell\b/.test(visibleText(rows[3])) && !visibleText(rows[3]).includes('\u{00d7}'), 'a bell that rang once shows a count');
    const go = buttonsIn(html).filter((b) => b.title.startsWith('Go to '));
    expectThat(go[2]?.title === 'Go to Terminal 2', `the bell's entry goes to ${JSON.stringify(go[2]?.title)}`);
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

scenario(
  'RN-85',
  'a flash on the terminal being typed into draws the ring once, with nothing unread',
  () => {
    reset();
    useTerminalStore.setState({ attentionFlash: { t1: 7 } });
  },
  (html) => {
    const rings = attentionRings(html);
    expectThat(
      JSON.stringify(rings.map((r) => [r.kind, r.pane])) === '[["flash","pane-1"]]',
      `rings drawn: ${JSON.stringify(rings.map((r) => [r.kind, r.pane]))}`
    );
    expectThat(/\banimate-attention-flash\b/.test(rings[0].tag) && /pointer-events-none/.test(rings[0].tag), `the flash: ${rings[0].tag}`);
  }
);

scenario(
  'RN-86',
  'files dragged over a waiting pane: the drop says what it will do, and the ring steps aside',
  () => {
    arrangeThreePanes();
    useTerminalStore.setState({ notifications: [...entriesFor('t-a', 1), ...entriesFor('t-c', 1)] });
    usePathDropStore.setState({ target: { paneId: 'pane-a', count: 2 } });
  },
  (html) => {
    expectText(html, 'Insert 2 paths');
    const rings = attentionRings(html);
    expectThat(
      JSON.stringify(rings.map((r) => r.pane)) === '["pane-c"]',
      `rings drawn on ${JSON.stringify(rings.map((r) => r.pane))}, not only on pane-c`
    );
    // The count is still on the tab: stepping aside is the ring's alone.
    expectThat(pillIn(tabChip(html, 't-a'))?.text === '1', 'the waiting tab lost its count');
  }
);

scenario(
  'RN-87',
  'the settings window offers the terminal bell, the focused flash and progress bars, at their defaults',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const rows = [
      ['terminal.integrated.bellAttention', 'Terminal Bell', true],
      ['terminal.integrated.attentionFlashFocused', 'Flash the Terminal You Are In', false],
      ['terminal.integrated.progress', 'Progress Bars', true],
    ];
    const notify = html.indexOf('terminal.integrated.programNotifications');
    const next = html.indexOf('terminal.integrated.suggestions');
    for (const [key, title, checked] of rows) {
      expectText(html, title);
      const at = html.indexOf(key);
      expectThat(at !== -1, `rendered without ${key}`);
      expectThat(notify < at && at < next, `${key} is not with the terminal's notifications`);
      const box = /<input\b[^>]*type="checkbox"[^>]*>/.exec(html.slice(at))?.[0] ?? '';
      expectThat(/\schecked=""/.test(box) === checked, `${title} is drawn ${checked ? 'unchecked' : 'checked'}: ${box}`);
    }
  }
);

scenario(
  'RN-88',
  'the same three rows draw what was chosen, each one turned from its default',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
    // A row that drew its default whatever the value would pass RN-87; the
    // flash, off by default, would pass it with no value at all.
    useSettingsStore.getState().setSetting('terminalBellAttention', false);
    useSettingsStore.getState().setSetting('terminalAttentionFlashFocused', true);
    useSettingsStore.getState().setSetting('terminalProgress', false);
  },
  (html) => {
    for (const [key, checked] of [
      ['terminal.integrated.bellAttention', false],
      ['terminal.integrated.attentionFlashFocused', true],
      ['terminal.integrated.progress', false],
    ]) {
      const box = /<input\b[^>]*type="checkbox"[^>]*>/.exec(html.slice(html.indexOf(key)))?.[0] ?? '';
      expectThat(/\schecked=""/.test(box) === checked, `${key} is drawn ${checked ? 'unchecked' : 'checked'}: ${box}`);
    }
  }
);

// ---- The frame round a terminal --------------------------------------------------

/** The opening tag of a pane body, or null. */
const paneBodyTag = (html, paneId) => new RegExp(`<div\\b[^>]*\\sdata-pane-body="${paneId}"[^>]*>`).exec(html)?.[0] ?? null;

{
  const id = 'RN-89';
  const description = "a pane body keeps the same 3px margin with the ring and without it, in the terminal theme's own colour";
  const started = Date.now();
  try {
    // Without and with a waiting terminal: a margin that came with the ring
    // would resize the terminal each time, and a shell told it lost a column
    // redraws its prompt. Laid over the terminal instead, the ring cut the
    // first column in half.
    reset();
    useSettingsStore.getState().setSetting('terminalTheme', 'monokai');
    const quiet = paneBodyTag(renderArranged(), 'pane-1');
    useTerminalStore.setState({ tabs: [tab('t1'), tab('t2')], groups: baseGroups(['t1', 't2']), notifications: entriesFor('t2', 1) });
    const html = renderArranged();
    const ringing = paneBodyTag(html, 'pane-1');
    expectThat(attentionRings(html).length === 1, 'setup: the pane does not ring');
    expectThat(quiet === ringing, `the body changes with the ring:\n  ${quiet}\n  ${ringing}`);
    expectThat(/\sstyle="[^"]*padding:3px/.test(ringing ?? ''), `no 3px margin round the terminal: ${ringing}`);
    // Monokai's background, so the margin reads as the terminal's, not as a border.
    expectThat(/background-color:#272822/.test(ringing ?? ''), `the margin is not in the terminal's colour: ${ringing}`);
    reset();
    expectThat(!/background-color/.test(paneBodyTag(renderArranged(), 'pane-1') ?? ''), 'the default theme paints a background of its own over the pane');
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

{
  const id = 'RN-90';
  const description = 'the active pane is marked in the frame, outermost, only where there is another pane to tell it from';
  const started = Date.now();
  try {
    const activeIn = (html) => attrOrder(html, 'data-tab-strip').filter((pane) => /data-active-pane=""/.test(paneBody(html, pane) ?? ''));
    arrangeThreePanes();
    useTerminalStore.setState({ notifications: entriesFor('t-b', 1) });
    const three = renderArranged();
    expectThat(JSON.stringify(activeIn(three)) === '["pane-b"]', `the active line is on ${JSON.stringify(activeIn(three))}, not pane-b alone`);
    const line = /<div\b[^>]*\sdata-active-pane=""[^>]*>/.exec(three)[0];
    expectThat(/\binset-0\b/.test(line) && /\bring-1\b/.test(line) && /\bring-vsc-accent\b/.test(line), `not a 1px accent line on the edge: ${line}`);
    expectThat(/pointer-events-none/.test(line) && /aria-hidden="true"/.test(line), `the line is in the way: ${line}`);
    // Both on one pane: the ring one pixel in, so the two read as two things.
    expectThat(/data-attention-ring="unread"/.test(paneBody(three, 'pane-b') ?? ''), 'setup: pane-b does not ring');
    // Painted under the strip and the terminal, a ring on the pane's own box never showed.
    expectThat(!/<div\b[^>]*class="[^"]*ring-vsc-accent[^"]*"[^>]*>\s*<div\b[^>]*data-tab-strip/.test(three), 'the pane box still carries the ring the strip hid');
    reset();
    expectThat(activeIn(renderArranged()).length === 0, 'a lone pane is marked active');
    arrangeThreePanes({ zoomedPaneId: 'pane-b' });
    expectThat(activeIn(renderArranged()).length === 0, 'a zoomed pane, alone on screen, is marked active');
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

scenario(
  'RN-91',
  'zoomed, with terminals waiting in the hidden panes: the zoom chip says how many, and the side bar which pane',
  () => {
    arrangeThreePanes({ zoomedPaneId: 'pane-b' });
    // Two in pane-a, one in pane-c, both hidden; one in pane-b, on screen.
    useTerminalStore.setState({ notifications: [...entriesFor('t-a', 2), ...entriesFor('t-c', 1), ...entriesFor('t-b', 1)] });
  },
  (html) => {
    const chip = zoomedChip(html);
    expectThat(chip, 'no zoom chip');
    expectThat(/\sdata-hidden-unread="3"/.test(chip), `the chip counts ${/\sdata-hidden-unread="([^"]*)"/.exec(chip)?.[1] ?? 'nothing'} waiting in hidden panes, not 3`);
    expectThat(/\bring-vsc-attention\b/.test(chip), 'the chip is not in the attention colour');
    const pill = pillIn(chip);
    expectThat(pill?.text === '3' && pill.label === '3 unread notifications in hidden panes', `the chip's count: ${JSON.stringify(pill)}`);
    expectThat(chip.includes(`<span>Zoomed</span>${pill.tag}`), 'the count is not right after "Zoomed"');
    const title = visibleText(/\stitle="([^"]*)"/.exec(chip)?.[1] ?? '');
    expectThat(title.includes('still running; 3 unread notifications in hidden panes.'), `the chip's tooltip: ${JSON.stringify(title)}`);
    for (const [pane, n] of [['Pane 1', '2'], ['Pane 2', '1'], ['Pane 3', '1']]) {
      const got = pillIn(sideRow(html, pane))?.text ?? null;
      expectThat(got === n, `the side bar's ${pane} row counts ${got}, not ${n}`);
    }
  }
);

scenario(
  'RN-92',
  'zoomed, with only the pane on screen waiting: the zoom chip stays as it was',
  () => {
    arrangeThreePanes({ zoomedPaneId: 'pane-b' });
    useTerminalStore.setState({ notifications: entriesFor('t-b', 1) });
  },
  (html) => {
    const chip = zoomedChip(html);
    expectThat(!/data-hidden-unread/.test(chip) && !pillIn(chip), 'the chip counts the pane on screen as hidden');
    expectThat(/\bring-vsc-accent\b/.test(chip), 'the chip is in the attention colour with nothing hidden waiting');
  }
);

// ---- The bell's list from the keyboard ------------------------------------------

const { escapeFocusTarget, neighbourEntry, entryButtonIn } = await import('../../src/components/layout/NotificationCenter.jsx');

{
  const id = 'RN-93';
  const description = "the bell's list keeps the keyboard: Escape gives it to the bell, Mark all read and Dismiss to an entry";
  const started = Date.now();
  try {
    // What decides where the keyboard goes is a function each; where it is
    // used is an effect and a click, which a server render never runs — so
    // that part is read from the source, as SW-13 reads the settings window's.
    const bell = { name: 'bell' };
    const inside = { contains: () => true };
    const outside = { contains: () => false };
    expectThat(escapeFocusTarget(inside, {}, bell) === bell, 'Escape from inside the list leaves the keyboard on a control that is going');
    expectThat(escapeFocusTarget(outside, {}, bell) === null, 'Escape takes the keyboard from a terminal beside the open list');
    expectThat(escapeFocusTarget(null, {}, bell) === null && escapeFocusTarget(inside, null, bell) === null, 'no list or no focus, and still somewhere to go');
    const go = (name) => ({ querySelector: (sel) => (sel === '[data-notification-go]' ? { name } : null) });
    expectThat(neighbourEntry({ nextElementSibling: go('next'), previousElementSibling: go('prev') })?.name === 'next', 'a dismissed entry hands the keyboard to the one after it');
    expectThat(neighbourEntry({ nextElementSibling: null, previousElementSibling: go('prev') })?.name === 'prev', 'the last entry dismissed hands it to the one before');
    expectThat(neighbourEntry({ nextElementSibling: null, previousElementSibling: null }) === null, 'the only entry dismissed names an entry');
    expectThat(entryButtonIn(go('first'))?.name === 'first' && entryButtonIn(null) === null, 'the first entry is not found');
    const src = readFileSync(new URL('../../src/components/layout/NotificationCenter.jsx', import.meta.url), 'utf8');
    for (const [what, pattern] of [
      ['Escape gives the keyboard back', /const back = escapeFocusTarget\(rootRef\.current, document\.activeElement, bellRef\.current, openerRef\.current\);\s*setOpen\(false\);\s*back\?\.focus\(\);/],
      ['Mark all read moves the keyboard before it disables itself', /if \(document\.activeElement === e\.currentTarget\) entryButtonIn\(dialogRef\?\.current\)\?\.focus\(\);\s*onMarkAllRead\?\.\(\);/],
      ['Dismiss hands the keyboard on', /const next = neighbourEntry\(row\);\s*if \(next\) next\.focus\(\);\s*else leaveIfInside\(\);\s*\}\s*dismiss\(note\.id\);/],
      ['Clear all gives the keyboard to the workspace', /leaveIfInside\(\);\s*clearAll\(\);/],
    ]) {
      expectThat(pattern.test(src), `not wired: ${what}`);
    }
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

scenario(
  'RN-95',
  "the only group's chip: its count in line after the name, and no empty slot where a \u{2715} would be",
  () => {
    reset();
    useTerminalStore.setState({ tabs: [tab('t1'), tab('t2')], groups: baseGroups(['t1', 't2']), notifications: entriesFor('t2', 2) });
  },
  (html) => {
    const chip = groupChip(html, 'group-1');
    const pill = pillIn(chip);
    expectThat(pill?.text === '2', `the group chip counts ${JSON.stringify(pill?.text)}`);
    expectThat(chip.includes(`<span class="truncate max-w-[140px]">Group 1</span>${pill.tag}`), 'the count is not right after the name');
    // A blank \u{2715}-sized slot kept the badge off the terminal count while
    // the badge sat over the corner; in line, there is nothing to keep it off.
    expectThat(!/<button\b/.test(chip), 'setup: the only group has a \u{2715}');
    expectThat(!/data-close-room/.test(chip) && !/<span aria-hidden="true"[^>]*class="w-\[15px\]/.test(chip), 'the empty slot is back');
  }
);

{
  const id = 'RN-96';
  const description = 'a press on the frame round a terminal gives that terminal the keyboard, and the page never takes it';
  const started = Date.now();
  try {
    const { pressOnPaneFrame } = await import('../../src/components/terminal/AttentionIndicators.jsx');
    const focused = [];
    const input = { focus: (opts) => focused.push(opts) };
    const body = { querySelector: (sel) => (sel === '.xterm-helper-textarea' ? input : null) };
    let prevented = 0;
    const press = (target, currentTarget = body) => ({ target, currentTarget, preventDefault: () => (prevented += 1) });
    // On the margin itself (and on the lines drawn in it, which the pointer
    // goes through): focus stays put, and goes to the terminal.
    expectThat(pressOnPaneFrame(press(body)) === true, 'a press on the frame is not taken');
    expectThat(prevented === 1, 'the press on the frame still lets the browser move focus to the page');
    expectThat(focused.length === 1 && focused[0]?.preventScroll === true, `the terminal is not focused, or scrolls to: ${JSON.stringify(focused)}`);
    // Anything inside the body handles its own press.
    expectThat(pressOnPaneFrame(press({ inside: true })) === false && prevented === 1 && focused.length === 1, 'a press on the terminal itself is taken from it');
    // No terminal in the pane: nothing to give it to, nothing held.
    const empty = { querySelector: () => null };
    expectThat(pressOnPaneFrame({ target: empty, currentTarget: empty, preventDefault: () => (prevented += 1) }) === false && prevented === 1, 'an empty pane holds the press');
    const src = readFileSync(new URL('../../src/components/terminal/TerminalSplitContainer.jsx', import.meta.url), 'utf8');
    expectThat(/data-pane-body=\{paneId\}\s*onMouseDown=\{pressOnPaneFrame\}/.test(src), 'not wired: the pane body does not take a press on its frame');
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

const { focusBackTarget, NotificationPopover } = await import('../../src/components/layout/NotificationCenter.jsx');

{
  const id = 'RN-97';
  const description = 'closed from inside, the list gives the keyboard back to what had it before it opened \u{2014} the editor too';
  const started = Date.now();
  try {
    const root = { contains: (el) => el?.inList === true };
    const editor = { focus() {}, isConnected: true, name: 'editor' };
    const bell = { focus() {}, isConnected: true, inList: true, name: 'bell' };
    expectThat(focusBackTarget(editor, root) === editor, 'what had the keyboard before the list is not given it back');
    expectThat(focusBackTarget({ ...editor, isConnected: false }, root) === null, 'focus is given to something no longer on the page');
    expectThat(focusBackTarget(bell, root) === null, 'the bell, going with the list, is given the keyboard back');
    expectThat(focusBackTarget(null, root) === null, 'nothing remembered, and still somewhere to go');
    // Escape: back to the editor while it is there, else to the bell.
    const inside = { inList: true };
    expectThat(escapeFocusTarget(root, inside, bell, editor) === editor, 'Escape does not give the editor its keyboard back');
    expectThat(escapeFocusTarget(root, inside, bell, { ...editor, isConnected: false }) === bell, 'Escape with the editor gone does not fall back to the bell');
    const src = readFileSync(new URL('../../src/components/layout/NotificationCenter.jsx', import.meta.url), 'utf8');
    for (const [what, pattern] of [
      // As the bell is pressed: a click in Chromium focuses the bell first.
      ['remembered as the bell is pressed', /onPointerDown=\{rememberOpener\}/],
      ['remembered as the bell is pressed from the keyboard', /onKeyDown=\{\(e\) => \{\s*if \(e\.key === 'Enter' \|\| e\.key === ' '\) rememberOpener\(\);/],
      ['only as the list opens', /const rememberOpener = \(\) => \{\s*if \(!open\) openerRef\.current = document\.activeElement;/],
      ['Clear all and the last Dismiss give it back first', /const back = focusBackTarget\(openerRef\.current, rootRef\.current\);\s*if \(back\) back\.focus\(\);\s*else focusWorkspace\(\);/],
    ]) {
      expectThat(pattern.test(src), `not wired: ${what}`);
    }
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

{
  const id = 'RN-98';
  const description = "the open list says it is the bell's, and a jump to another terminal closes it";
  const started = Date.now();
  try {
    reset();
    const notifications = [programNote('p1'), { id: 'n1', tabId: 't1', title: 'build', exitCode: 0, durationMs: 1000, at: 0, read: true }];
    const html = renderToString(
      React.createElement(NotificationPopover, {
        dialogRef: { current: null },
        anchor: { right: 4, bottom: 26 },
        summary: { dialog: 'Notifications', heading: 'While you were elsewhere' },
        unread: 1,
        notifications,
        onMarkAllRead() {},
        onClearAll() {},
        onGo() {},
        onDismiss() {},
      })
    );
    // What looks for open dialogs before moving the keyboard leaves this one
    // out by this name (workspaceFocus.js): it is not modal.
    const root = /^<div\b[^>]*>/.exec(html)?.[0] ?? '';
    expectThat(/\sdata-bell-list=""/.test(root) && /\srole="dialog"/.test(root), `the list's own box: ${root}`);
    expectThat(attrOrder(html, 'data-notification-entry').length === 2, 'the entries are not in it');
    const buttons = buttonsIn(html).map((b) => b.text);
    expectThat(buttons.includes('Mark all read') && buttons.includes('Clear all'), `the header has ${JSON.stringify(buttons.slice(0, 2))}`);
    const src = readFileSync(new URL('../../src/components/layout/NotificationCenter.jsx', import.meta.url), 'utf8');
    expectThat(/const activeTabId = useTerminalStore\(\(s\) => s\.activeTabId\);/.test(src), 'not wired: the list does not follow the active terminal');
    expectThat(/useEffect\(\(\) => \{\s*setOpen\(false\);\s*\}, \[activeTabId\]\);/.test(src), 'not wired: another terminal becoming active leaves the list open');
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

// ---- The TERMINALS side bar's status board (stage 2) ----------------------------

/** A terminal row of the side bar, from its opening tag to its own end — it holds spans only, never a div. */
function terminalRow(html, tabId) {
  return new RegExp(`<div\\b[^>]*\\sdata-terminal-row="${tabId}"[^>]*>[\\s\\S]*?</div>`).exec(html)?.[0] ?? null;
}

/** The opening tag of `markup`'s first element. */
const openingTag = (markup) => /^<[^>]*>/.exec(markup ?? '')?.[0] ?? '';

/** The class list of a tag. */
const classOf = (tag) => /\sclass="([^"]*)"/.exec(tag ?? '')?.[1] ?? '';

/** The opening tag of the first element in `markup` carrying `attr` (any value), or null. */
const tagWith = (markup, attr) => new RegExp(`<[a-z]+\\b[^>]*\\s${attr}(?:="[^"]*")?[^>]*>`).exec(markup ?? '')?.[0] ?? null;

/** The value of `attr` in `tag`, entities decoded, or null. */
const attrOf = (tag, attr) => {
  const m = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag ?? '');
  return m ? visibleText(m[1]) : null;
};

/** The lucide icon an `<svg>` tag draws ("bell-ring"), or null. */
const iconOf = (tag) => /\bclass="lucide lucide-([a-z0-9-]+)/.exec(tag ?? '')?.[1] ?? null;

/**
 * The state on a row's second line: `{ tag, state, value, icon, iconTag,
 * shown, words }`, or null — `shown` what is drawn (short), `words` what is
 * read out (whole); the same when the short form is the whole one.
 */
function statusIn(markup) {
  const m = /<span\b([^>]*\sdata-status-state="([^"]*)"[^>]*)>(?:(<svg\b[^>]*>)[\s\S]*?<\/svg>)?(?:<span class="tabular-nums">([^<]*)<\/span>|<span aria-hidden="true" class="tabular-nums">([^<]*)<\/span><span class="sr-only">([^<]*)<\/span>)<\/span>/.exec(markup ?? '');
  if (!m) return null;
  return {
    tag: `<span${m[1]}>`,
    state: m[2],
    value: /\sdata-status-value="([^"]*)"/.exec(m[1])?.[1] ?? null,
    iconTag: m[3] ?? '',
    icon: iconOf(m[3]),
    shown: m[4] ?? m[5],
    words: m[4] ?? m[6],
  };
}

/** The rows in the order the side bar draws them: group names, `Pane n`, and terminal ids. */
function sideOrder(html) {
  return [...html.matchAll(/<div\b[^>]*\sdata-row="[^"]*"[^>]*>[\s\S]*?<\/div>/g)]
    .map((m) => m[0])
    .map((row) => /\sdata-terminal-row="([^"]+)"/.exec(row)?.[1] ?? /<span class="truncate">([^<]*)<\/span>/.exec(row.replace(/<!-- -->/g, ''))?.[1] ?? null)
    .filter(Boolean);
}

const NOTE_AGO_MS = 3 * 60 * 1000;

/** An agent the side bar believes runs: a record, typed at a prompt into this very shell (`agentRuns`). */
const running = (id, kind, extra = {}) => ({ agent: { kind, sessionId: `${kind}-1` }, agentTyped: { sessionId: `sess-${id}` }, ...extra });

/**
 * Three terminals: one with every item; one paused with a read note on a
 * detached head — the active one, drawn on the selection colour; one with
 * nothing to say.
 */
function arrangeBoard() {
  reset();
  const now = Date.now();
  useTerminalStore.setState({
    tabs: [
      tab('sb-1', { title: 'agent', cwd: '/repo/app', ...running('sb-1', 'opencode') }),
      tab('sb-2', { title: 'paused', cwd: '/detached/x', ...running('sb-2', 'claude') }),
      tab('sb-3', { title: 'quiet', cwd: '/nowhere' }),
    ],
    activeTabId: 'sb-2',
    groups: [groupOf('group-1', ['sb-1', 'sb-2', 'sb-3'])],
    activeGroupId: 'group-1',
    progress: { 'sb-2': { state: 'warning', value: 40 } },
    notifications: [
      programNote('n-1', { tabId: 'sb-1', tabTitle: 'agent', title: 'Build', body: 'Permission needed', at: now - NOTE_AGO_MS, read: false }),
      programNote('n-2', { tabId: 'sb-2', tabTitle: 'paused', title: 'paused', body: 'Build finished', at: now - NOTE_AGO_MS, read: true }),
    ],
  });
  useBranchStore.setState({
    branches: {
      '/repo/app': { branch: 'feat/board', detached: false },
      '/detached/x': { branch: 'abc1234', detached: true },
      '/nowhere': null,
    },
  });
}

scenario(
  'RN-99',
  'a side bar row with every item: agent, state, branch and last note on its second line, each with its words',
  arrangeBoard,
  (html) => {
    const full = terminalRow(html, 'sb-1');
    expectThat(full, 'the row "agent" is not drawn');
    // Line 1 as it was: title, pill, folder.
    expectThat(full.includes('<span class="truncate">agent</span>'), 'the title is not on the row');
    expectThat(pillIn(full)?.text === '1', 'the unread pill is gone from the first line');
    expectThat(/truncate-start/.test(full), 'the folder is not on the first line');
    // Line 2, under the title.
    const line = tagWith(full, 'data-status-line');
    expectThat(line && attrOf(line, 'data-status-line') === 'sb-1', `no second line: ${full}`);
    for (const cls of ['h-[16px]', 'pl-[32px]', 'overflow-hidden']) expectThat(classOf(line).includes(cls), `the second line has no ${cls}: ${line}`);
    expectThat(full.indexOf('data-status-line') > full.indexOf('<span class="truncate">agent</span>'), 'the second line is not under the title');

    const agent = tagWith(full, 'data-agent');
    expectThat(attrOf(agent, 'data-agent') === 'opencode', `the agent: ${agent}`);
    expectText(full, 'OpenCode');

    const status = statusIn(full);
    expectThat(status?.state === 'waiting', `the state is ${JSON.stringify(status)}, not waiting`);
    expectThat(status.words === 'Waiting', `the state reads ${JSON.stringify(status.words)}`);
    // The icon is for the eye; its colour never carries the state alone.
    expectThat(/aria-hidden="true"/.test(status.iconTag), 'the icon is read out');
    expectThat(/\btext-vsc-attention\b/.test(status.iconTag), `the waiting icon is not in the attention colour: ${status.iconTag}`);

    const branch = tagWith(full, 'data-branch');
    expectThat(attrOf(branch, 'data-branch') === 'feat/board', `the branch: ${branch}`);
    expectThat(attrOf(branch, 'title') === 'Branch feat/board', `the branch's tooltip: ${attrOf(branch, 'title')}`);
    expectThat(!/data-branch-detached/.test(branch), 'a branch drawn as a detached head');
    expectThat(iconOf(tagWith(full.slice(full.indexOf(branch)), 'class="lucide')) === 'git-branch', 'a branch without the branch icon');
    expectThat(full.includes('<bdi>feat/board</bdi>'), 'the branch name is not isolated in a <bdi>');

    const note = tagWith(full, 'data-last-note');
    expectThat(attrOf(note, 'data-last-note') === 'unread', `the note: ${note}`);
    expectThat(!/\btext-vsc-muted\b/.test(classOf(note)), 'an unread note is drawn muted');
    expectThat(attrOf(note, 'title') === 'Build \u{2014} Permission needed\n3m ago', `the note's tooltip: ${JSON.stringify(attrOf(note, 'title'))}`);
    expectThat(full.includes('<bdi>Build \u{2014} Permission needed</bdi>'), 'the note does not read "title \u{2014} body"');

    // One sentence to a screen reader.
    const words = visibleText(line ? full.slice(full.indexOf(line)) : '').replace(/\n+/g, '');
    expectThat(
      words === 'OpenCode, Waiting, branch feat/board, last notification, unread: Build \u{2014} Permission needed',
      `the second line reads ${JSON.stringify(words)}`
    );

    // Paused, at an amount, on a detached head, its note read.
    const paused = terminalRow(html, 'sb-2');
    const p = statusIn(paused);
    expectThat(p?.state === 'progress' && p.value === '40' && p.words === 'Paused 40%', `the paused row: ${JSON.stringify(p)}`);
    expectThat(p.icon === 'circle-pause' && /\btext-vsc-warn\b/.test(p.iconTag), `a paused state without its icon in the warning colour: ${p.iconTag}`);
    expectThat(attrOf(tagWith(paused, 'data-agent'), 'data-agent') === 'claude', 'the agent of "paused"');
    expectText(paused, 'Claude Code');
    const read = tagWith(paused, 'data-last-note');
    expectThat(attrOf(read, 'data-last-note') === 'read', `the read note: ${read}`);
    // Its title is only the terminal's name, so the line is the body alone.
    expectThat(paused.includes('<bdi>Build finished</bdi>'), 'the read note does not read its body alone');

    // Nothing to say: the line is there, empty, and the row no shorter.
    const quiet = terminalRow(html, 'sb-3');
    expectThat(/data-status-line="sb-3"/.test(quiet), 'the quiet row has no second line');
    for (const attr of ['data-agent', 'data-status-state', 'data-branch', 'data-last-note']) {
      expectThat(!quiet.includes(attr), `the quiet row draws ${attr}`);
    }
  }
);

scenario(
  'RN-100',
  'with the branch, the agent and the last note all off, terminal rows are one line again, folder and group counts kept',
  () => {
    arrangeBoard();
    const set = useSettingsStore.getState().setSetting;
    set('terminalsPanelBranch', false);
    set('terminalsPanelAgent', false);
    set('terminalsPanelLastNote', false);
  },
  (html) => {
    for (const id of ['sb-1', 'sb-2', 'sb-3']) {
      const row = terminalRow(html, id);
      expectThat(row, `the row ${id} is not drawn`);
      const cls = classOf(openingTag(row));
      expectThat(cls.includes('h-[22px]') && !cls.includes('h-[38px]') && !cls.includes('flex-col'), `the row ${id} is not one line: ${cls}`);
      // Today's markup: no line boxes, no kept dot slot.
      expectThat(!row.includes('h-[20px]') && !row.includes('w-[6px]'), `the row ${id} still has two lines' parts`);
      expectThat(/truncate-start/.test(row), `the folder is gone from ${id}, and only the second line was turned off`);
    }
    for (const attr of ['data-status-line', 'data-agent', 'data-status-state', 'data-branch', 'data-last-note']) {
      expectThat(!new RegExp(`\\s${attr}="`).test(html), `drawn with every item off: ${attr}`);
    }
    expectThat(pillIn(terminalRow(html, 'sb-1'))?.text === '1', 'the pill went with the second line');
    // The group's counts are not a second-line item: one compact mark per
    // group, which the chip's tooltip carries whatever the settings.
    expectThat(attrOf(tagWith(sideRow(html, 'group-1'), 'data-group-summary'), 'data-group-summary') === '1 waiting, 1 running', 'the group row lost its counts with the second line');
  }
);

scenario(
  'RN-101',
  'every terminal row is the same height whatever it holds, a split group\u{2019}s included, with the folder off',
  () => {
    arrangeBoard();
    useSettingsStore.getState().setSetting('terminalsPanelFolder', false);
    useTerminalStore.setState((s) => ({
      tabs: [...s.tabs, tab('sb-4', { title: 'gone', exited: true }), tab('sb-5', { title: 'busy', running: true })],
      groups: [
        ...s.groups,
        {
          id: 'group-2',
          name: 'Split',
          createdAt: 0,
          tree: {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-s1', tabIds: ['sb-4'], activeTabId: 'sb-4' },
              { type: 'leaf', id: 'pane-s2', tabIds: ['sb-5'], activeTabId: 'sb-5' },
            ],
          },
          activePaneId: 'pane-s1',
        },
      ],
    }));
  },
  (html) => {
    const ids = ['sb-1', 'sb-2', 'sb-3', 'sb-4', 'sb-5'];
    for (const id of ids) {
      const row = terminalRow(html, id);
      expectThat(row, `the row ${id} is not drawn`);
      const cls = classOf(openingTag(row));
      expectThat(/(^|\s)h-\[38px\](\s|$)/.test(cls) && !cls.includes('h-[22px]'), `the row ${id} is not the two-line height: ${cls}`);
      // The boxes inside are fixed too, and the dot keeps its place whether
      // or not it is drawn, so a command starting does not move the title.
      expectThat(row.includes('h-[20px]') && row.includes('h-[16px]'), `the row ${id}'s lines are not fixed: ${row}`);
      expectThat(/<span aria-hidden="true" class="w-\[6px\] shrink-0/.test(row), `the row ${id} has no kept place for its dot`);
      expectThat(!/truncate-start/.test(row), `the row ${id} shows its folder with the folder off`);
    }
    expectThat(/data-activity="running"/.test(terminalRow(html, 'sb-5')), 'the running dot is not drawn in its place');
    expectThat(statusIn(terminalRow(html, 'sb-4'))?.state === 'exited', 'the exited row says nothing');
    // Group and pane rows stay one line, and say which they are: the order
    // holds still while the pointer moves over any of them (aimHold.js).
    for (const [name, attr] of [['group-1', 'data-group-row="group-1"'], ['Split', 'data-group-row="group-2"'], ['Pane 1', 'data-pane-row="pane-s1"'], ['Pane 2', 'data-pane-row="pane-s2"']]) {
      const row = sideRow(html, name);
      expectThat(row && classOf(openingTag(row)).includes('h-[22px]'), `the row "${name}" is not one line: ${openingTag(row)}`);
      expectThat(openingTag(row).includes(attr), `the row "${name}" does not carry ${attr}: ${openingTag(row)}`);
    }
  }
);

scenario(
  'RN-102',
  'a group row counts its terminals waiting, running and failed, in icons with words; the chip says it once, in words only',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        tab('g-wait', { title: 'wait' }),
        tab('g-run', { title: 'run', running: true }),
        tab('g-bar', { title: 'bar' }),
        tab('g-fail', { title: 'fail', lastExitCode: 2 }),
        tab('g-gone', { title: 'gone', exited: true, lastExitCode: 1 }),
        tab('q-1', { title: 'calm', running: true }),
      ],
      activeTabId: 'q-1',
      groups: [groupOf('busy', ['g-wait', 'g-run', 'g-bar', 'g-fail', 'g-gone']), groupOf('quiet', ['q-1'])],
      activeGroupId: 'quiet',
      progress: { 'g-bar': { state: 'normal', value: 10 } },
      notifications: [programNote('w-1', { tabId: 'g-wait', tabTitle: 'wait' })],
    });
  },
  (html) => {
    const row = sideRow(html, 'busy');
    expectThat(row, 'the group row is not drawn');
    const summary = tagWith(row, 'data-group-summary');
    const label = '1 waiting, 2 running, 1 failed';
    expectThat(attrOf(summary, 'data-group-summary') === label, `the summary: ${summary}`);
    // What it counts is TERMINALS, beside a pill counting NOTIFICATIONS.
    const words = `terminals: ${label}`;
    expectThat(attrOf(summary, 'aria-label') === words && attrOf(summary, 'title') === words && /\srole="img"/.test(summary), `the summary's words: ${summary}`);
    const items = [...row.matchAll(/<span\b[^>]*\sdata-summary-item="([^"]+)"\s+data-summary-count="([^"]+)"[^>]*>(<svg\b[^>]*>)/g)].map((m) => [m[1], m[2], iconOf(m[3]), m[3]]);
    expectThat(
      JSON.stringify(items.map((i) => i.slice(0, 3))) === JSON.stringify([['waiting', '1', 'bell-ring'], ['running', '2', 'circle-play'], ['failed', '1', 'circle-x']]),
      `the summary draws ${JSON.stringify(items.map((i) => i.slice(0, 3)))}`
    );
    expectThat(/text-vsc-attention/.test(items[0][3]) && /text-vsc-error/.test(items[2][3]) && /aria-hidden="true"/.test(items[0][3]), `the summary's icons: ${JSON.stringify(items)}`);
    const calmRow = sideRow(html, 'quiet');
    expectThat(attrOf(tagWith(calmRow, 'data-group-summary'), 'data-group-summary') === '1 running', `the quiet group's summary: ${tagWith(calmRow, 'data-group-summary')}`);
    // The row's tooltip names both counts for what they count.
    const rowTitle = attrOf(openingTag(row), 'title');
    expectThat(rowTitle === `busy \u{2014} 1 unread notification; ${words}. Click to switch to this group`, `the group row's tooltip: ${JSON.stringify(rowTitle)}`);

    const chip = groupChip(html, 'busy');
    const title = attrOf(openingTag(chip), 'title');
    expectThat(title.startsWith(`busy \u{2014} 5 terminals (${label})`), `the chip's tooltip: ${JSON.stringify(title)}`);
    // Said once: the summary's "2 running" and not again as a sentence.
    expectThat(!title.includes('one of them'), `the chip's tooltip says the activity twice: ${JSON.stringify(title)}`);
    expectThat(new RegExp(`<span data-group-summary-words="" class="sr-only">, ${label}</span>`).test(chip), `the chip's name does not carry the summary: ${chip}`);
    expectThat(!/data-group-summary=/.test(chip), 'the chip draws the summary; only its tooltip and name carry it');
    const calm = groupChip(html, 'quiet');
    const calmTitle = attrOf(openingTag(calm), 'title');
    expectThat(calmTitle.startsWith('quiet \u{2014} 1 terminal (1 running)'), `the quiet chip's tooltip: ${JSON.stringify(calmTitle)}`);
  }
);

scenario(
  'RN-103',
  'a detached head does not pass for a branch: a commit icon and the word',
  arrangeBoard,
  (html) => {
    const row = terminalRow(html, 'sb-2');
    const tag = tagWith(row, 'data-branch');
    expectThat(attrOf(tag, 'data-branch') === 'abc1234' && /data-branch-detached=""/.test(tag), `the detached head: ${tag}`);
    expectThat(attrOf(tag, 'title') === 'Detached HEAD at abc1234', `its tooltip: ${attrOf(tag, 'title')}`);
    const from = row.slice(row.indexOf(tag));
    expectThat(iconOf(tagWith(from, 'class="lucide')) === 'git-commit-horizontal', `a detached head drawn with the branch icon: ${from.slice(0, 300)}`);
    expectThat(/<span class="min-w-0 truncate">detached <!-- --><bdi>abc1234<\/bdi><\/span>/.test(from) || /<span class="min-w-0 truncate">detached <bdi>abc1234<\/bdi><\/span>/.test(from), `the detached head does not say "detached": ${from.slice(0, 400)}`);
  }
);

scenario(
  'RN-104',
  'each state has a legible icon of its own beside its word, never a character glyph',
  () => {
    reset();
    const ids = ['s-wait', 's-err', 's-prog', 's-pause', 's-work', 's-run', 's-fail', 's-exit'];
    useTerminalStore.setState({
      tabs: [
        tab('s-wait'),
        tab('s-err'),
        tab('s-prog'),
        tab('s-pause'),
        tab('s-work'),
        tab('s-run', { running: true }),
        tab('s-fail', { lastExitCode: 1 }),
        tab('s-exit', { exited: true }),
      ],
      activeTabId: 's-run',
      groups: [groupOf('states', ids)],
      activeGroupId: 'states',
      progress: {
        's-err': { state: 'error', value: 20 },
        's-prog': { state: 'normal', value: 60 },
        's-pause': { state: 'warning', value: 30 },
        's-work': { state: 'indeterminate', value: null },
      },
      notifications: [programNote('sw-1', { tabId: 's-wait', tabTitle: 's-wait' })],
    });
  },
  (html) => {
    // [state, icon, drawn, read out]: a bar's amount alone is drawn — "In
    // progress 100%" took 108 of a narrow line's 156 pixels — and the whole
    // words are read out and are the line's tooltip.
    const want = {
      's-wait': ['waiting', 'bell-ring', 'Waiting', 'Waiting'],
      's-err': ['error', 'circle-alert', 'Error 20%', 'Error 20%'],
      's-prog': ['progress', 'chart-pie', '60%', 'In progress 60%'],
      's-pause': ['progress', 'circle-pause', 'Paused 30%', 'Paused 30%'],
      's-work': ['working', 'loader-circle', 'Working', 'Working'],
      's-run': ['running', 'circle-play', 'Running', 'Running'],
      's-fail': ['failed', 'circle-x', 'Failed', 'Failed'],
      's-exit': ['exited', 'circle-stop', 'Exited', 'Exited'],
    };
    for (const [id, [state, icon, shown, words]] of Object.entries(want)) {
      const s = statusIn(terminalRow(html, id));
      expectThat(s, `${id} draws no state`);
      expectThat(
        s.state === state && s.icon === icon && s.shown === shown && s.words === words,
        `${id}: ${JSON.stringify([s.state, s.icon, s.shown, s.words])}, not ${JSON.stringify([state, icon, shown, words])}`
      );
      expectThat(/\swidth="12"/.test(s.iconTag), `${id}'s icon is not 12px: ${s.iconTag}`);
      const line = tagWith(terminalRow(html, id), 'data-status-line');
      expectThat(attrOf(line, 'title') === words, `${id}'s line tooltip does not have the whole words: ${line}`);
    }
    // The old characters, which were a smudge (\u{25CC}) and a speck (\u{25B8}) at 11px.
    for (const id of Object.keys(want)) {
      const row = terminalRow(html, id);
      const line = row.slice(row.indexOf('data-status-line'));
      for (const glyph of ['\u{25C6}', '\u{25D1}', '\u{2016}', '\u{25CC}', '\u{25B8}', '\u{2715}', '\u{25A0}', '!']) {
        expectThat(!visibleText(line).includes(glyph), `${id}'s state is still drawn as ${glyph}`);
      }
    }
  }
);

scenario(
  'RN-105',
  'when line 2 is narrow: the state never gives way, the branch gives way first, the agent is whole or gone, the note ends in an ellipsis',
  arrangeBoard,
  (html) => {
    const full = terminalRow(html, 'sb-1');
    const status = statusIn(full);
    expectThat(/\bshrink-0\b/.test(classOf(status.tag)) && /\bwhitespace-nowrap\b/.test(classOf(status.tag)), `the state can give way: ${status.tag}`);
    // A share to start from, and nothing it cannot give up: at a line's edge
    // it is cut by its own ellipsis, never clipped mid-glyph by the line.
    const note = classOf(tagWith(full, 'data-last-note'));
    expectThat(/(^|\s)flex-\[1_1_40%\](\s|$)/.test(note) && /(^|\s)min-w-0(\s|$)/.test(note), `the note: ${note}`);
    expectThat(/<span class="min-w-0 truncate"><bdi>Build \u{2014} Permission needed<\/bdi><\/span><\/span>/u.test(full), 'the note\u{2019}s text does not truncate with an ellipsis');
    const branch = classOf(tagWith(full, 'data-branch'));
    expectThat(/(^|\s)shrink-\[1000000\](\s|$)/.test(branch) && /(^|\s)min-w-\[10px\](\s|$)/.test(branch), `the branch does not give way first, down to its icon: ${branch}`);
    expectThat(!/max-w-\[/.test(branch), `the branch is capped instead of giving way: ${branch}`);
    // Whole or not at all: it never shrinks to "Ope\u{2026}" or a sliver.
    const agent = classOf(tagWith(full, 'data-agent'));
    expectThat(/\bshrink-0\b/.test(agent) && /\bwhitespace-nowrap\b/.test(agent) && !/\btruncate\b/.test(agent), `the agent can be cut down: ${agent}`);
    const line = tagWith(full, 'data-status-line');
    expectThat(attrOf(line, 'title') === 'OpenCode \u{2014} Waiting', `the line's tooltip: ${line}`);

    // Wired: the name is left out by measurement, read out when it is, and
    // the note is told whether it is drawn.
    const board = readFileSync(new URL('../../src/components/terminal/StatusBoard.jsx', import.meta.url), 'utf8');
    expectThat(/const agentShown = Boolean\(agent\) && fits;/.test(board), 'not wired: the agent is drawn whether it fits or not');
    expectThat(/<span key="agent" data-agent-hidden=\{tab\.agent\.kind\} className="sr-only">/.test(board), 'an agent left out for width is no longer read out');
    expectThat(/noteLine\(note, \{ agentShown \}\)/.test(board), 'the note is not told whether the agent is drawn');
    expectThat(/agentFits\(\{/.test(board) && /new ResizeObserver\(check\)/.test(board), 'not wired: the agent is not measured against the line, or not again when it is resized');
  }
);

scenario(
  'RN-106',
  'on the active row, secondary text is the plain foreground, not the muted grey that falls under 4.5:1 there',
  arrangeBoard,
  (html) => {
    const active = terminalRow(html, 'sb-2');
    const other = terminalRow(html, 'sb-1');
    expectThat(/\bbg-vsc-selection\b/.test(classOf(openingTag(active))), 'the active row is not on the selection colour');
    for (const [what, attr] of [['agent', 'data-agent'], ['branch', 'data-branch'], ['read note', 'data-last-note']]) {
      const cls = classOf(tagWith(active, attr));
      expectThat(/\btext-vsc-fg\b/.test(cls) && !/\btext-vsc-muted\b/.test(cls), `the active row's ${what} is muted: ${cls}`);
    }
    const folder = /<span class="([^"]*truncate-start[^"]*)">/.exec(active)?.[1] ?? '';
    expectThat(/\btext-vsc-fg\b/.test(folder) && !/\btext-vsc-muted\b/.test(folder), `the active row's folder is muted: ${folder}`);
    // Elsewhere, muted as before.
    for (const attr of ['data-agent', 'data-branch']) {
      expectThat(/\btext-vsc-muted\b/.test(classOf(tagWith(other, attr))), `an inactive row's ${attr} is not muted`);
    }
  }
);

scenario(
  'RN-107',
  'read and unread notes differ by a mark, not by colour alone',
  arrangeBoard,
  (html) => {
    const unread = terminalRow(html, 'sb-1');
    const read = terminalRow(html, 'sb-2');
    const from = (row) => row.slice(row.indexOf(tagWith(row, 'data-last-note')));
    expectThat(/^<span\b[^>]*data-last-note="unread"[^>]*><span aria-hidden="true" data-unread-dot=""/.test(from(unread)), `an unread note has no unread dot: ${from(unread).slice(0, 300)}`);
    expectThat(!/data-unread-dot/.test(from(read)), 'a read note has the unread dot');
  }
);

/**
 * Two groups in the user's order: an idle one, then one split in two panes
 * whose terminals are in no particular order of urgency.
 */
function arrangeSortable(sortOn) {
  reset();
  useTerminalStore.setState({
    tabs: [
      tab('a-1', { title: 'a-idle' }),
      tab('a-2', { title: 'a-gone', exited: true }),
      tab('b-1', { title: 'b-gone', exited: true }),
      tab('b-2', { title: 'b-wait' }),
      tab('b-3', { title: 'b-idle' }),
      tab('b-4', { title: 'b-fail', lastExitCode: 1 }),
      tab('b-5', { title: 'b-run', running: true }),
    ],
    activeTabId: 'a-1',
    groups: [
      groupOf('first', ['a-1', 'a-2']),
      {
        id: 'second',
        name: 'second',
        createdAt: 0,
        tree: {
          type: 'split',
          id: 'split-b',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-b1', tabIds: ['b-1', 'b-2'], activeTabId: 'b-1' },
            { type: 'leaf', id: 'pane-b2', tabIds: ['b-3', 'b-4', 'b-5'], activeTabId: 'b-3' },
          ],
        },
        activePaneId: 'pane-b1',
      },
    ],
    activeGroupId: 'first',
    notifications: [programNote('wait-1', { tabId: 'b-2', tabTitle: 'b-wait' })],
  });
  if (sortOn) useSettingsStore.getState().setSetting('terminalsPanelSortAttention', true);
}

const USER_ORDER = ['first', 'a-1', 'a-2', 'second', 'Pane 1', 'b-1', 'b-2', 'Pane 2', 'b-3', 'b-4', 'b-5'];

scenario(
  'RN-108',
  'sorted by attention: the group with a terminal waiting first, each pane most urgent first, the store and the chips untouched',
  () => arrangeSortable(true),
  (html) => {
    const order = sideOrder(html).filter((x) => USER_ORDER.includes(x));
    const want = ['second', 'Pane 1', 'b-2', 'b-1', 'Pane 2', 'b-4', 'b-5', 'b-3', 'first', 'a-1', 'a-2'];
    expectThat(JSON.stringify(order) === JSON.stringify(want), `the side bar draws ${JSON.stringify(order)}, not ${JSON.stringify(want)}`);
    expectThat(/<div\b[^>]*\sdata-sorted="attention"/.test(html), 'the list does not say it is sorted');
    // Nothing is aimed at, nothing is held, and nothing waits to be shown.
    expectThat(!/data-order-held=/.test(html) && !/data-order-pending=/.test(html), 'an order held with nothing aimed at');
    const toggle = tagWith(html, 'data-sort-toggle');
    expectThat(/aria-pressed="true"/.test(toggle) && attrOf(toggle, 'aria-label') === 'Sort by Attention', `the sort toggle: ${toggle}`);
    expectThat(attrOf(toggle, 'title').startsWith('Sorted by attention'), `the toggle's tooltip does not explain: ${toggle}`);
    // A view only: the order the user made is the one kept, and the chips draw it.
    const s = useTerminalStore.getState();
    expectThat(JSON.stringify(s.groups.map((g) => g.id)) === '["first","second"]', 'the store\u{2019}s group order changed');
    expectThat(JSON.stringify(s.groups[1].tree.children[1].tabIds) === '["b-3","b-4","b-5"]', 'the store\u{2019}s pane order changed');
    expectThat(JSON.stringify(attrOrder(html, 'data-group-chip')) === '["first","second"]', `the chips are sorted too: ${attrOrder(html, 'data-group-chip')}`);
  }
);

scenario(
  'RN-109',
  'the same terminals unsorted: the user\u{2019}s order exactly, and the toggle not pressed, under the same name',
  () => arrangeSortable(false),
  (html) => {
    const order = sideOrder(html).filter((x) => USER_ORDER.includes(x));
    expectThat(JSON.stringify(order) === JSON.stringify(USER_ORDER), `the side bar draws ${JSON.stringify(order)}`);
    expectThat(!/data-sorted=/.test(html), 'the list says it is sorted');
    const toggle = tagWith(html, 'data-sort-toggle');
    // One name whatever the state: aria-pressed says which.
    expectThat(/aria-pressed="false"/.test(toggle) && attrOf(toggle, 'aria-label') === 'Sort by Attention', `the sort toggle: ${toggle}`);
  }
);

const BOARD_SETTINGS = [
  ['terminal.sidebar.showFolder', 'Show Folder', true, 'terminalsPanelFolder'],
  ['terminal.sidebar.showGitBranch', 'Show Git Branch', true, 'terminalsPanelBranch'],
  ['terminal.sidebar.showAgentStatus', 'Show Agent and Status', true, 'terminalsPanelAgent'],
  ['terminal.sidebar.showLastNotification', 'Show Last Notification', true, 'terminalsPanelLastNote'],
  ['terminal.sidebar.sortByAttention', 'Sort by Attention', false, 'terminalsPanelSortAttention'],
];

/** The checkbox of the settings row whose key is `key`, and the row's description, from the markup. */
function settingRow(html, key) {
  const at = html.indexOf(key);
  if (at === -1) return null;
  const rest = html.slice(at);
  return {
    at,
    box: /<input\b[^>]*type="checkbox"[^>]*>/.exec(rest)?.[0] ?? '',
    description: visibleText(/<p\b[^>]*>([\s\S]*?)<\/p>/.exec(rest)?.[1] ?? ''),
  };
}

scenario(
  'RN-110',
  'the settings window offers the five side bar rows after the progress bars, at their defaults, each saying what it does',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const progress = html.indexOf('terminal.integrated.progress');
    const next = html.indexOf('terminal.integrated.suggestions');
    let last = progress;
    for (const [key, title, checked] of BOARD_SETTINGS) {
      expectText(html, title);
      const row = settingRow(html, key);
      expectThat(row, `rendered without ${key}`);
      expectThat(last < row.at && row.at < next, `${key} is not in order after the progress bars`);
      last = row.at;
      expectThat(/\schecked=""/.test(row.box) === checked, `${title} is drawn ${checked ? 'unchecked' : 'checked'}: ${row.box}`);
    }
    const branch = settingRow(html, 'terminal.sidebar.showGitBranch').description;
    for (const words of ['.git', 'never on a timer', 'nothing the repository configures is ever run', 'WSL', 'network folder']) {
      expectThat(branch.includes(words), `Show Git Branch does not say "${words}": ${branch}`);
    }
    const sort = settingRow(html, 'terminal.sidebar.sortByAttention').description;
    for (const words of ['turning this off shows it again', 'Close Terminals to the Right', 'over a terminal or group row', 'a double-click after', 'being renamed', 'leaving the window', 'a dot on the sort button']) {
      expectThat(sort.includes(words), `Sort by Attention does not say "${words}": ${sort}`);
    }
  }
);

scenario(
  'RN-111',
  'the five side bar rows draw what was chosen, each one turned from its default',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
    for (const [, , checked, name] of BOARD_SETTINGS) useSettingsStore.getState().setSetting(name, !checked);
  },
  (html) => {
    for (const [key, title, checked] of BOARD_SETTINGS) {
      const { box } = settingRow(html, key) ?? { box: '' };
      expectThat(/\schecked=""/.test(box) === !checked, `${title} is drawn ${checked ? 'checked' : 'unchecked'}, its default: ${box}`);
    }
  }
);

const { keepUserOrderItems, SORTED_REASON, subjectExists, agentFits, compactStatusText, NOTE_SHARE, BRANCH_MIN_PX } = await import(
  '../../src/components/terminal/statusBoardModel.js'
);
const { createAimHold, DOUBLE_CLICK_MS, PRESS_GRACE_MS } = await import('../../src/components/terminal/aimHold.js');

/** A case with no store to arrange and no tree to draw: `body` throws when something is wrong. */
function check(id, description, body) {
  const started = Date.now();
  try {
    body();
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

check('RN-115', 'what fits on a second line: the agent whole or not at all, at the widths the review measured', () => {
  // A side bar 220 px wide leaves line 2 156 px; 249 \u{2192} 185; 287 \u{2192} 223; 351 \u{2192} 287.
  // "OpenCode" is about 50 px at 11px, "Claude Code" about 62, a short state 40\u{2013}60.
  const line = (innerPx, extra) => ({ innerPx, gapPx: 6, hasBranch: true, hasNote: true, ...extra });
  const cases = [
    [line(156, { agentPx: 50, statusPx: 52 }), false],
    [line(185, { agentPx: 50, statusPx: 52 }), false],
    [line(223, { agentPx: 50, statusPx: 52 }), true],
    [line(287, { agentPx: 62, statusPx: 52 }), true],
    [line(223, { agentPx: 62, statusPx: 60 }), false],
    // Nothing beside it but the state.
    [{ innerPx: 120, gapPx: 6, agentPx: 62, statusPx: 52 }, true],
    [{ innerPx: 110, gapPx: 6, agentPx: 62, statusPx: 52 }, false],
    // Exactly enough is enough.
    [{ innerPx: 100, gapPx: 0, agentPx: 40, statusPx: 0, hasNote: true }, true],
    [{ innerPx: 0, agentPx: 10 }, false],
  ];
  for (const [given, want] of cases) {
    expectThat(agentFits(given) === want, `agentFits(${JSON.stringify(given)}) is ${!want}`);
  }
  expectThat(NOTE_SHARE === 0.4 && BRANCH_MIN_PX === 10, `the note's share and the branch's least: ${NOTE_SHARE}, ${BRANCH_MIN_PX}`);
  for (const [status, want] of [
    [{ state: 'progress', word: 'In progress', value: 100 }, '100%'],
    [{ state: 'progress', word: 'In progress' }, 'In progress'],
    [{ state: 'progress', word: 'Paused', value: 40, paused: true }, 'Paused 40%'],
    [{ state: 'error', word: 'Error', value: 20 }, 'Error 20%'],
    [{ state: 'waiting', word: 'Waiting' }, 'Waiting'],
    [{ state: 'none', word: '' }, ''],
  ]) {
    expectThat(compactStatusText(status) === want, `compactStatusText(${JSON.stringify(status)}) is ${JSON.stringify(compactStatusText(status))}`);
  }
});

check('RN-112', 'sorted, the menu items that act on the user\u{2019}s order are off and say why; nothing else is touched', () => {
  const panel = readFileSync(new URL('../../src/components/terminal/TerminalsPanel.jsx', import.meta.url), 'utf8');
  // The item exists under the key the rule names, and every menu of the
  // panel passes through the rule.
  expectThat(/key: 'close-right',\s*label: 'Close Terminals to the Right'/.test(panel), 'the tab menu has no "close-right" item for the rule to find');
  expectThat(/const menuItems = \(\) => keepUserOrderItems\(panelMenuItems\(\), sorted\);/.test(panel), 'not wired: the panel\u{2019}s menus do not pass through keepUserOrderItems');
  const items = [
    { key: 'open', label: 'Open' },
    { key: 'close', label: 'Close' },
    { key: 'close-others', label: 'Close Others in Pane' },
    { key: 'close-right', label: 'Close Terminals to the Right' },
    { type: 'separator', key: 's1' },
  ];
  const sortedItems = keepUserOrderItems(items, true);
  const right = sortedItems.find((i) => i.key === 'close-right');
  expectThat(right.disabled === true && right.disabledReason === SORTED_REASON, `sorted, "Close Terminals to the Right": ${JSON.stringify(right)}`);
  expectThat(SORTED_REASON === 'Turn off Sort by Attention to use your own order', `the reason: ${SORTED_REASON}`);
  for (const item of sortedItems.filter((i) => i.key !== 'close-right')) {
    expectThat(item === items.find((i) => i.key === item.key), `sorted, ${item.key} was changed too`);
  }
  expectThat(keepUserOrderItems(items, false) === items, 'unsorted, the menu was changed');
});

check('RN-113', 'the order holds while the pointer is over a row, from a press until a double-click\u{2019}s worth after its click, and lets go when the pointer or the window leaves', () => {
  let now = 0;
  let timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, at: now + ms };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => {
    timers = timers.filter((x) => x !== t);
  };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  const heard = [];
  const aim = createAimHold({ onChange: (held) => heard.push(held), setTimer, clearTimer });
  expectThat(DOUBLE_CLICK_MS >= 500 && PRESS_GRACE_MS >= 300, `the double-click and grace times: ${DOUBLE_CLICK_MS}, ${PRESS_GRACE_MS}`);
  expectThat(aim.held === false, 'held before anything happened');

  // Over a row, moving or resting, however long: held. A pointer that came
  // to rest on a row is about to click it.
  aim.pointerAt(true);
  advance(60_000);
  expectThat(aim.held, 'let go while the pointer rested on a row');
  // Off the rows — empty space, another section — let go at once.
  aim.pointerAt(false);
  expectThat(!aim.held, 'held with the pointer off the rows');

  // A click lets go only a double-click's worth after it: the second click
  // of a double-click lands where the first did.
  aim.pressed();
  aim.pressEnded();
  aim.clicked();
  advance(DOUBLE_CLICK_MS - 1);
  expectThat(aim.held, 'let go between the two clicks of a double-click');
  aim.pressed();
  aim.pressEnded();
  aim.clicked();
  advance(DOUBLE_CLICK_MS - 1);
  expectThat(aim.held, 'let go right after a double-click\u{2019}s second click');
  advance(1);
  expectThat(!aim.held, 'still held a double-click\u{2019}s worth after the click');

  // A long press holds; the finger lifting (it "leaves" then) does not let
  // go before its click, nor for a double-tap's worth after.
  aim.pressed();
  advance(5000);
  aim.pressEnded();
  advance(PRESS_GRACE_MS - 1);
  expectThat(aim.held, 'a tap let go before its click came');
  aim.clicked();
  advance(DOUBLE_CLICK_MS - 1);
  expectThat(aim.held, 'a tap let go before a double-tap could follow');
  advance(1);
  expectThat(!aim.held, 'a tap held for good');

  // A press dragged off its row: no click, so the grace runs out.
  aim.pressed();
  aim.pressEnded();
  advance(PRESS_GRACE_MS);
  expectThat(!aim.held, 'a press with no click held for good');

  // A click with no press (the keyboard's) holds nothing.
  aim.clicked();
  advance(DOUBLE_CLICK_MS);
  expectThat(!aim.held, 'a click without a press held the order');

  // Leaving the window lets go at once, and nothing left over re-holds it.
  aim.pointerAt(true);
  aim.pressed();
  aim.release();
  expectThat(!aim.held, 'leaving the window did not let go');
  const before = heard.length;
  advance(5000);
  expectThat(heard.length === before && !aim.held, 'a timer left over changed the hold after the window was left');
  expectThat(heard.every((h, i) => i === 0 || h !== heard[i - 1]), `told the same thing twice: ${JSON.stringify(heard)}`);

  // Disposed, it holds nothing and says nothing.
  aim.pointerAt(true);
  aim.pressed();
  const told = heard.length;
  aim.dispose();
  expectThat(!aim.held, 'disposed, it still holds');
  advance(5000);
  expectThat(heard.length === told, 'disposed, it still talks');

  // Wired.
  const panel = readFileSync(new URL('../../src/components/terminal/TerminalsPanel.jsx', import.meta.url), 'utf8');
  const hold = readFileSync(new URL('../../src/components/terminal/aimHold.js', import.meta.url), 'utf8');
  expectThat(/const \[aiming, recheckAim\] = useAimHold\(sorted, listMenuOpen\);/.test(panel), 'not wired: the panel does not take the hold, frozen while a list menu is open');
  expectThat(/const holding = aiming \|\| listMenuOpen \|\| liveDraft\?\.kind === 'tab' \|\| liveDraft\?\.kind === 'group';/.test(panel), 'not wired: what holds the order');
  expectThat(/useLayoutEffect\(\(\) => \{\s*if \(sorted\) recheckAim\(\);\s*\}\);/.test(panel), 'not wired: what is under a still pointer is not asked again after a redraw');
  expectThat(/window\.addEventListener\('blur', close\)/.test(panel), 'a menu from the panel stays open when the window is left');
  for (const [what, pattern] of [
    ['the pointer over a row, or not', /window\.addEventListener\('pointermove', move, \{ capture: true, passive: true \}\)/],
    ['a press on a row', /window\.addEventListener\('pointerdown', down, true\)/],
    ['a press is the primary button\u{2019}s (a right-click sends no click to end it)', /if \(e\.button === 0 && onRow\(e\.target\)\) aim\.pressed\(\);/],
    ['a press ending anywhere', /window\.addEventListener\('pointerup', up, true\)/],
    ['a click landing', /window\.addEventListener\('click', click, true\)/],
    ['the pointer leaving the window', /window\.addEventListener\('pointerout', out, true\)/],
    ['the window losing focus', /window\.addEventListener\('blur', leave\)/],
    ['the window being hidden', /document\.addEventListener\('visibilitychange', hidden\)/],
    ['what is under a still pointer', /document\.elementFromPoint\(where\.at\.x, where\.at\.y\)/],
    ['the pointer over an open menu is not the pointer leaving the rows', /if \(!where\.frozen\) aim\.pointerAt\(onRow\(e\.target\)\);/],
    ['a finger lifting is not a pointer resting on a row', /if \(e\.pointerType !== 'mouse'\) \{\s*where\.at = null;\s*aim\.pointerAt\(false\);/],
    ['only rows the sort moves', /'\[data-terminal-row\], \[data-group-row\], \[data-pane-row\]'/],
  ]) {
    expectThat(pattern.test(hold), `not wired in aimHold.js: ${what}`);
  }
});

check('RN-116', 'a menu or a rename whose subject is gone closes, and holds nothing', () => {
  const has = {
    tab: (id) => id === 't-1',
    group: (id) => id === 'g-1',
    pane: (id) => id === 'p-1',
    saved: (id) => id === 's-1',
    workspace: (id) => id === 'w-1',
  };
  for (const [kind, alive, gone] of [['tab', 't-1', 't-2'], ['group', 'g-1', 'g-2'], ['pane', 'p-1', 'p-2'], ['saved', 's-1', 's-2'], ['workspace', 'w-1', 'w-2']]) {
    expectThat(subjectExists(kind, alive, has), `a ${kind} that exists is taken for gone`);
    expectThat(!subjectExists(kind, gone, has), `a ${kind} that is gone is taken for one that exists`);
  }
  for (const kind of ['empty', 'workspace-bar', 'workspace-list', 'workspace-startup-list', 'workspace-name']) {
    expectThat(subjectExists(kind, null, has), `${kind} has no subject to lose`);
  }
  const panel = readFileSync(new URL('../../src/components/terminal/TerminalsPanel.jsx', import.meta.url), 'utf8');
  expectThat(/const liveMenu = menu && subjectExists\(menu\.kind, menu\.id, has\) \? menu : null;/.test(panel), 'not wired: a menu counts after its subject is gone');
  expectThat(/const liveDraft = draft && subjectExists\(draft\.kind, draft\.id, has\) \? draft : null;/.test(panel), 'not wired: a rename counts after its subject is gone');
  expectThat(/if \(menu && !liveMenu\) setMenu\(null\);\s*if \(draft && !liveDraft\) setDraft\(null\);/.test(panel), 'a dead menu or rename is never dropped');
  expectThat(/open=\{Boolean\(liveMenu\)\}/.test(panel), 'a menu whose subject is gone is still drawn');
  expectThat(/tab: \(id\) => tabById\.has\(id\) && layout\.some\(\(entry\) => entry\.tabIds\.includes\(id\)\)/.test(panel), 'a terminal is taken to exist without being in any pane');
});

check('RN-114', 'what keeps the side bar cheap and readable: narrow subscriptions, contrast on the active row, forced colours', () => {
  // A progress update ten times a second must redraw one line (S9): the
  // panel reading the bars would redraw every row, and a line declared
  // inside the panel would be remounted on every one of them.
  const panel = readFileSync(new URL('../../src/components/terminal/TerminalsPanel.jsx', import.meta.url), 'utf8');
  const board = readFileSync(new URL('../../src/components/terminal/StatusBoard.jsx', import.meta.url), 'utf8');
  expectThat(!/\bs\.progress\b/.test(panel), 'the TERMINALS panel subscribes to the progress bars');
  expectThat(/^export const TerminalStatusLine = memo\(function TerminalStatusLine\(/m.test(board), 'the second line is not a memoised module-level component');
  expectThat(/useTerminalStore\(\(s\) => \(showAgent \? s\.progress\?\.\[tabId\] \?\? null : null\)\)/.test(board), 'the second line does not subscribe to its own bar alone');
  expectThat(/^export const GroupSummary = memo\(function GroupSummary\(/m.test(board), 'the group summary is not a memoised module-level component');
  const css = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8');
  // 11px text needs 4.5:1. On the active row the muted grey falls short, the
  // plain foreground does not.
  const token = (name) => new RegExp(`--vsc-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1] ?? null;
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const [fg, muted, selection, sidebar] = ['fg', 'muted', 'selection', 'sidebar-bg'].map(token);
  expectThat(ratio(fg, selection) >= 4.5, `the foreground on the selection is ${ratio(fg, selection).toFixed(2)}:1`);
  expectThat(ratio(muted, sidebar) >= 4.5, `muted text on the side bar is ${ratio(muted, sidebar).toFixed(2)}:1`);
  const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  expectThat(/\[data-sort-toggle\]\[aria-pressed="true"\] \{\s*outline: 1px solid ButtonText;/.test(forced), 'in forced colours, the pressed sort toggle has no edge');
  expectThat(/\[data-unread-dot\] \{\s*forced-color-adjust: none;\s*background: Highlight;/.test(forced), 'in forced colours, the unread dot is not drawn');
  expectThat(/\[data-status-icon\] \{\s*color: CanvasText;/.test(forced), 'in forced colours, the state icons keep their own colours');
  // Three: line 2's state, the group summary's, and the tone of a status a
  // program reported (stage 7) — each drawn in CanvasText in forced colours,
  // its shape and its words saying what its colour does.
  for (const file of [board]) expectThat((file.match(/data-status-icon=""/g) || []).length === 3, 'a state icon (line 2, the group summary or a reported status) is not marked for forced colours');
  expectThat(!/\[data-last-note[^\]]*\][^{]*\{[^}]*GrayText/.test(forced), 'in forced colours, a read note is painted GrayText again (it reads as disabled, and some palettes make it the loudest text)');
  expectThat(/\[data-pending-dot\] \{\s*forced-color-adjust: none;\s*background: Highlight;/.test(forced), 'in forced colours, the "newer order waiting" dot is black on black');
  expectThat(/data-pending-dot=""/.test(panel), 'the "newer order waiting" dot is not marked for forced colours');
  // Fast Refresh swaps a module in place only when it exports components
  // alone; one helper exported beside them reloads the whole app on every edit.
  for (const [file, source] of [['TerminalsPanel.jsx', panel], ['StatusBoard.jsx', board]]) {
    // A component is a capitalised function, or a capitalised const made by
    // memo() or forwardRef(); a capitalised string (`ROW`) is not one.
    const exported = [...source.matchAll(/^export (const|function|let|class|var) (\w+)(.*)$/gm)].map((m) => ({ kind: m[1], name: m[2], rest: m[3] }));
    const helpers = exported.filter(
      ({ kind, name, rest }) => !/^[A-Z]/.test(name) || (kind === 'const' ? !/^ = (?:memo|forwardRef)\(/.test(rest) : kind !== 'function')
    );
    expectThat(exported.length > 0 && helpers.length === 0, `${file} exports more than components: ${JSON.stringify(helpers.map((h) => h.name))}`);
    expectThat(!/^export \{/m.test(source), `${file} re-exports something`);
  }
});

// ---- What the stylesheet must keep ------------------------------------------------

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Hue of `#rrggbb`, in degrees. */
function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

{
  const id = 'RN-94';
  const description = 'the stylesheet: an attention colour of its own, frames that survive forced colours, and motion that stops';
  const started = Date.now();
  try {
    // CSS is not drawn by a server render; what it must say is read from it.
    const css = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8');
    const token = (name) => new RegExp(`--vsc-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1] ?? null;
    const [attention, onAttention, warn, error, terminal] = ['attention', 'attention-fg', 'warn', 'error', 'terminal-bg'].map(token);
    // A paused bar (warn) and a count (attention) can share one chip.
    const apart = (a, b) => Math.min(Math.abs(hue(a) - hue(b)), 360 - Math.abs(hue(a) - hue(b)));
    expectThat(apart(attention, warn) >= 15, `the attention colour ${attention} is ${apart(attention, warn).toFixed(0)}\u{00b0} from the warning colour ${warn}`);
    expectThat(apart(attention, error) >= 15, `the attention colour ${attention} is ${apart(attention, error).toFixed(0)}\u{00b0} from the error colour ${error}`);
    expectThat(contrast(onAttention, attention) >= 4.5, `a count on the pill is ${contrast(onAttention, attention).toFixed(2)}:1`);
    expectThat(contrast(attention, terminal) >= 3, `the ring is ${contrast(attention, terminal).toFixed(2)}:1 against the terminal`);
    // Forced colours drop box shadows — the rings — and repaint backgrounds.
    const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    for (const [what, pattern] of [
      ['the attention ring a real border', /\[data-attention-ring\] \{\s*border: 2px solid Highlight;/],
      ['the active line a real border', /\[data-active-pane\] \{\s*border: 1px solid CanvasText;/],
      ['the pill an edge of its own', /\[data-unread-count\] \{\s*border: 1px solid/],
      ['the system colours kept as given', /forced-color-adjust: none/],
      ['a progress bar something to draw with', /\[data-progress-fill\] \{\s*forced-color-adjust: none;\s*background: Highlight;/],
      ['a paused bar unlike a normal one', /\[data-progress-state="warning"\] \[data-progress-fill\] \{\s*background: repeating-linear-gradient\(/],
      ['a failed bar unlike a paused one', /\[data-progress-state="error"\] \[data-progress-fill\] \{\s*background: repeating-linear-gradient\(90deg, CanvasText/],
      ['the zoom chip an edge', /\[data-zoomed-chip\] \{\s*box-shadow: none !important;\s*outline: 1px solid ButtonText;/],
      ['the zoom chip the attention edge while a hidden pane waits', /\[data-zoomed-chip\]\[data-hidden-unread\] \{\s*outline: 2px solid Highlight;/],
    ]) {
      expectThat(pattern.test(forced), `in forced colours, not: ${what}`);
    }
    // Reduced motion, by the OS and by the setting: off outright, not sped up.
    for (const cls of ['animate-attention-pulse', 'animate-attention-flash', 'animate-progress-indeterminate']) {
      expectThat(new RegExp(`:root\\.reduce-motion \\.${cls}[^{]*\\{[^}]*animation: none !important`).test(css) || new RegExp(`:root\\.reduce-motion \\.${cls},[\\s\\S]*?\\{\\s*animation: none !important`).test(css), `the setting does not stop .${cls}`);
      const os = /@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-attention-pulse,([\s\S]*?)\n\}/.exec(css)?.[0] ?? '';
      expectThat(os.includes(`.${cls}`) && os.includes('animation: none !important'), `the OS preference does not stop .${cls}`);
    }
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

// ---- Split polish (stage 3, part A): a hidden tab strip --------------------
//
// With "Hide the Tab Strip of a Single Terminal" on, a pane holding one
// terminal draws a 6 px HANDLE in place of its strip — in layout, always the
// same height — and the same strip in an overlay laid over the top of the
// pane, faded out and transparent to the pointer until it is opened from the
// handle (or held by a drag, a menu, a rename). When it opens and closes is
// stripReveal.js's (split_polish.test.js) and the browser's
// (split_lock_headless.test.js); what is drawn in each state is checked here.

const { StripOverlay, StripHandle } = await import('../../src/components/terminal/HiddenStrip.jsx');

/** The markup of one pane: from its outermost box (the one marked with whether its strip is hidden) to the next pane's. */
function paneMarkup(html, paneId) {
  const body = html.indexOf(`data-pane-body="${paneId}"`);
  if (body === -1) return null;
  // The pane's own box opens before its strip, its handle or its body.
  const open = html.lastIndexOf('<div', html.lastIndexOf('flex flex-col h-full w-full bg-vsc-terminal', body));
  const after = html.slice(body);
  const next = after.slice(1).search(/class="relative flex flex-col h-full w-full bg-vsc-terminal/);
  return html.slice(open, next === -1 ? html.length : body + 1 + next);
}

/** The opening tag of the overlay strip in some markup, or null. */
const overlayTag = (markup) => /<div\b[^>]*\sdata-strip-overlay=""[^>]*>/.exec(markup ?? '')?.[0] ?? null;
/** The handle's markup — a button holding spans only — or null. */
const handleOf = (markup) => /<button\b[^>]*\sdata-strip-handle="[^"]*"[^>]*>[\s\S]*?<\/button>/.exec(markup ?? '')?.[0] ?? null;

/**
 * A terminal asking for a password is told by its SESSION (`pty-echo`), and
 * the store works out which terminals that locks: `locked` names the tabs
 * whose sessions are asking. Every arrangement forgets what the one before
 * it said.
 */
function lockSessions(tabIds = []) {
  useTerminalStore.getState().forgetInputHidden();
  for (const id of tabIds) useTerminalStore.getState().noteInputHidden(`sess-${id}`, true);
}

function arrangeHidden({ tabIds = ['t1'], extra = {}, hide = true, locked = [] } = {}) {
  reset();
  useTerminalStore.setState({
    tabs: tabIds.map((id) => tab(id)),
    activeTabId: tabIds[0],
    groups: baseGroups(tabIds),
    ...extra,
  });
  lockSessions(locked);
  if (hide) useSettingsStore.getState().setSetting('terminalHideSingleTabStrip', true);
}

scenario(
  'RN-130',
  'a single terminal with the strip hidden: a 6 px handle above the terminal, the strip itself in a faded overlay',
  () => arrangeHidden(),
  (html) => {
    const pane = paneMarkup(html, 'pane-1');
    expectThat(pane, 'no pane drawn');
    expectThat(/^<div\b[^>]*\sdata-strip-hidden=""/.test(pane), `the pane does not say its strip is hidden: ${pane.slice(0, 200)}`);
    const handle = handleOf(pane);
    expectThat(handle, 'no handle on a pane whose strip is hidden');
    const tag = openingTag(handle);
    const body = pane.indexOf('data-pane-body="pane-1"');
    expectThat(pane.indexOf(handle) < body, 'the handle is not above the terminal');
    for (const word of ['h-[6px]', 'shrink-0', 'w-full']) {
      expectThat(classOf(tag).split(/\s+/).includes(word), `the handle is not "${word}": ${classOf(tag)}`);
    }
    expectThat(/\stype="button"/.test(tag), 'the handle is not a button (Enter and Tab reach it)');
    expectThat(/\saria-expanded="false"/.test(tag), 'the handle does not say the strip is down');
    const words = attrOf(tag, 'aria-label') ?? '';
    expectThat(words === 't1. Show its tab strip', `the handle's words: ${JSON.stringify(words)}`);
    expectThat(!/data-handle-mark=/.test(handle), 'a mark with nothing to say');
    const strip = pane.indexOf('data-tab-strip="pane-1"');
    expectThat(strip > body, 'the strip is still drawn in line, taking its height');
    const overlay = overlayTag(pane);
    expectThat(overlay, 'no overlay to bring the strip back in');
    expectThat(pane.indexOf(overlay) < strip, 'the strip is not inside the overlay');
    const cls = classOf(overlay);
    for (const word of ['absolute', 'top-[6px]', 'left-0', 'right-0', 'z-30', 'opacity-0', 'pointer-events-none']) {
      expectThat(cls.split(/\s+/).includes(word), `the hidden overlay is not "${word}": ${cls}`);
    }
    expectThat(/\sdata-shown="false"/.test(overlay), 'the overlay is drawn shown with nothing to show it');
    // Drawn by its state alone: focus left inside it (the window lost and
    // regained focus) drew a strip the state said was closed, which neither
    // Escape nor the handle could then put away.
    expectThat(!cls.includes('focus-within:'), `the overlay is drawn by focus, not by its state: ${cls}`);
    expectThat(tabChip(pane, 't1'), "the overlay's strip has no chip for the terminal");
    // Nothing that destroys: no tab ✕, no Close Pane — a second click or tap
    // just below the handle once killed a shell there. Closing is in the
    // right-click menus, the palette and the keyboard.
    const overlayStrip = pane.slice(pane.indexOf(overlay));
    const destructive = buttonsIn(overlayStrip).filter((b) => /^Close /.test(b.title) || /^Close /.test(b.label ?? ''));
    expectThat(destructive.length === 0, `the opened strip offers ${JSON.stringify(destructive.map((b) => b.title || b.label))}`);
    expectThat(!/data-pane-corner=/.test(html), 'the corner indicator is back');
  }
);

scenario(
  'RN-131',
  'a second terminal in the pane brings the real strip back; with the setting off one terminal keeps its strip',
  () => arrangeHidden({ tabIds: ['t1', 't2'] }),
  (html) => {
    const pane = paneMarkup(html, 'pane-1');
    expectThat(!/^<div\b[^>]*\sdata-strip-hidden=""/.test(pane), 'two terminals and the strip is hidden');
    expectThat(pane.indexOf('data-tab-strip="pane-1"') < pane.indexOf('data-pane-body="pane-1"'), 'the strip is not above the terminal');
    expectThat(!overlayTag(pane) && !handleOf(pane), 'an overlay or a handle with the strip in line');
    // The strip in line keeps its ✕ on each tab.
    const closers = buttonsIn(pane).filter((b) => /^Close /.test(b.label ?? ''));
    expectThat(closers.length === 2, `the in-line strip lost its tab ✕: ${JSON.stringify(closers)}`);
    reset();
    useTerminalStore.setState({ notifications: entriesFor('t1', 2) });
    const plain = paneMarkup(renderArranged(), 'pane-1');
    expectThat(useSettingsStore.getState().terminalHideSingleTabStrip === false, 'setup: the default is off');
    expectThat(plain.indexOf('data-tab-strip="pane-1"') < plain.indexOf('data-pane-body="pane-1"'), 'off by default, and the strip went');
    expectThat(!overlayTag(plain) && !handleOf(plain), 'off, and an overlay or a handle is drawn');
  }
);

scenario(
  'RN-132',
  "the handle keeps what the strip's chip would say — the count, the bar, the lock — as small marks, in words",
  () =>
    arrangeHidden({
      extra: {
        notifications: entriesFor('t1', 2),
        progress: { t1: { state: 'normal', value: 40 } },
      },
      locked: ['t1'],
    }),
  (html) => {
    const pane = paneMarkup(html, 'pane-1');
    const handle = handleOf(pane);
    expectThat(handle, 'no handle');
    // Told apart by shape, not by colour alone: a padlock, a dot, a bar.
    const unreadMark = tagWith(handle, 'data-handle-mark="unread"');
    expectThat(unreadMark && /\brounded-full\b/.test(classOf(unreadMark)) && /\bw-\[4px\]/.test(classOf(unreadMark)), `no unread dot: ${unreadMark}`);
    const lockMark = /<span\b[^>]*\sdata-handle-mark="lock"[^>]*>([\s\S]*?)<\/span>/.exec(handle)?.[1] ?? '';
    expectThat(iconOf(lockMark) === 'lock', `the lock mark is not a padlock: ${lockMark}`);
    const bar = progressIn(handle);
    expectThat(bar?.state === 'normal' && bar.value === '40', `the handle's bar: ${JSON.stringify(bar)}`);
    const tag = openingTag(handle);
    const words = attrOf(tag, 'aria-label') ?? '';
    expectThat(
      words === 't1 — Typing is hidden (password prompt), 2 unread notifications, 40% done. Show its tab strip',
      `the handle's words: ${JSON.stringify(words)}`
    );
    expectThat(attrOf(tag, 'title') === words, 'the tooltip says something else');
    expectThat(classOf(tag).split(/\s+/).includes('h-[6px]'), 'the handle grew with its marks');
    // The overlay's chip says it too, for when the strip is up.
    expectThat(pillIn(tabChip(pane, 't1'))?.count === '2', "the overlay chip's pill is missing");
  }
);

scenario(
  'RN-133',
  'the handle stays, at its one height, whatever it has to say — and bars off draws no bar',
  () => arrangeHidden({ extra: { progress: { t1: { state: 'normal', value: 40 } } } }),
  (html) => {
    expectThat(progressIn(handleOf(paneMarkup(html, 'pane-1'))), 'setup: a bar on the handle');
    useSettingsStore.getState().setSetting('terminalProgress', false);
    const off = handleOf(paneMarkup(renderArranged(), 'pane-1'));
    expectThat(off && !progressIn(off), 'bars off, and the handle still draws one');
    useSettingsStore.getState().setSetting('terminalProgress', true);
    useTerminalStore.setState({ progress: {}, notifications: entriesFor('t1', 3, true) });
    const quiet = handleOf(paneMarkup(renderArranged(), 'pane-1'));
    expectThat(quiet && !/data-handle-mark=/.test(quiet) && !progressIn(quiet), 'read entries, and the handle still marks them');
    expectThat(classOf(openingTag(quiet)).split(/\s+/).includes('h-[6px]'), 'the handle changed height');
  }
);

scenario(
  'RN-134',
  'a zoomed pane keeps its strip and its "Zoomed" chip, one terminal or not',
  () => {
    arrangeThreePanes({ zoomedPaneId: 'pane-b' });
    useSettingsStore.getState().setSetting('terminalHideSingleTabStrip', true);
  },
  (html) => {
    const pane = paneMarkup(html, 'pane-b');
    expectThat(pane.indexOf('data-tab-strip="pane-b"') < pane.indexOf('data-pane-body="pane-b"'), "the zoomed pane's strip is hidden");
    expectThat(zoomedChip(pane), 'the "Zoomed" chip went with it');
    expectThat(!overlayTag(pane) && !handleOf(pane), 'an overlay or a handle on a zoomed pane');
    // Unzoomed, each of the three one-terminal panes hides its strip.
    arrangeThreePanes();
    useSettingsStore.getState().setSetting('terminalHideSingleTabStrip', true);
    const all = renderArranged();
    expectThat(buttonsIn(pane).some((b) => b.title.startsWith('Close Pane')), "the zoomed pane's own strip lost Close Pane");
    for (const id of ['pane-a', 'pane-b', 'pane-c']) {
      const markup = paneMarkup(all, id);
      expectThat(overlayTag(markup) && handleOf(markup), `${id}: no overlay or no handle`);
      expectThat(!buttonsIn(markup).some((b) => b.title.startsWith('Close Pane')), `${id}: Close Pane in the opened strip`);
      expectThat(markup.indexOf(`data-tab-strip="${id}"`) > markup.indexOf(`data-pane-body="${id}"`), `${id}: the strip is in line`);
    }
  }
);

check('RN-135', 'the overlay opened: opaque, taking the pointer, below the handle; down: neither', () => {
  const draw = (props) =>
    overlayTag(renderToString(React.createElement(StripOverlay, props, React.createElement('div', { 'data-tab-strip': 'p' }))));
  const shown = draw({ shown: true });
  const cls = classOf(shown);
  expectThat(/\sdata-shown="true"/.test(shown), 'not marked shown');
  expectThat(cls.includes('opacity-100') && !cls.includes('pointer-events-none') && !cls.split(/\s+/).includes('opacity-0'), `shown, but: ${cls}`);
  // Below the handle, never over it: a second click on the handle is the
  // handle's, so there is no window in which the strip ignores the pointer.
  expectThat(cls.split(/\s+/).includes('top-[6px]') && !cls.split(/\s+/).includes('top-0'), `the strip is not laid below its 6 px handle: ${cls}`);
  // Under Reduce Motion every transition is instant (index.css), this one included.
  expectThat(/\btransition-\[opacity,transform\]/.test(cls) && /\bduration-100\b/.test(cls), `no short fade: ${cls}`);
});

check('RN-136', 'the handle on its own: a count past nine in words, the strip-is-up state, no mark for nothing', () => {
  reset();
  for (const s of STORES) Object.assign(s.getInitialState(), s.getState());
  const none = renderToString(React.createElement(StripHandle, { paneId: 'p', tabId: 't1', title: 'one', unread: 0 }));
  expectThat(!/data-handle-mark=/.test(none) && !progressIn(none), `a mark with nothing to show: ${none}`);
  const counted = renderToString(React.createElement(StripHandle, { paneId: 'p', tabId: 't1', title: 'one', unread: 12, open: true }));
  expectThat(/data-handle-mark="unread"/.test(counted), 'no unread mark');
  expectThat((attrOf(openingTag(counted), 'aria-label') ?? '').includes('12 unread notifications'), 'the words do not count them');
  expectThat(/\saria-expanded="true"/.test(openingTag(counted)), 'the strip is up and the handle does not say so');
});

scenario(
  'RN-137',
  'the settings window offers Equal Splits and Hide the Tab Strip after Split Directory, off, saying what each does',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const split = html.indexOf('terminal.integrated.splitCwd');
    let last = split;
    for (const [key, title] of [
      ['terminal.integrated.equalizeOnSplit', 'Equal Splits'],
      ['terminal.integrated.hideSingleTabStrip', 'Hide the Tab Strip of a Single Terminal'],
    ]) {
      expectText(html, title);
      const row = settingRow(html, key);
      expectThat(row, `rendered without ${key}`);
      expectThat(last < row.at, `${key} is not after Split Directory`);
      last = row.at;
      expectThat(!/\schecked=""/.test(row.box), `${title} is on by default: ${row.box}`);
    }
    const equal = settingRow(html, 'terminal.integrated.equalizeOnSplit').description;
    for (const words of ['a third each', 'keep the sizes you gave them', 'Equalize Splits']) {
      expectThat(equal.includes(words), `Equal Splits does not say "${words}": ${equal}`);
    }
    const hide = settingRow(html, 'terminal.integrated.hideSingleTabStrip').description;
    for (const words of ['thin handle', 'Click the handle', 'Escape', 'pointer leaves it', 'being dragged', 'never just because the pointer passes by', 'never resizing the terminal', 'password lock', 'zoomed pane', 'command palette']) {
      expectThat(hide.includes(words), `Hide the Tab Strip does not say "${words}": ${hide}`);
    }
  }
);

check('RN-138', "in forced colours the handle's marks keep a system colour each, the unread one and the lock's apart", () => {
  const css = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  expectThat(/\[data-handle-mark="unread"\] \{\s*forced-color-adjust: none;\s*background: Highlight;/.test(forced), 'the unread dot is repainted away');
  expectThat(!/\[data-handle-mark="lock"\] \{[^}]*background/.test(forced), 'the padlock is painted over with a background');
  expectThat(/\[data-handle-grip\] \{\s*forced-color-adjust: none;\s*background: CanvasText;/.test(forced), "the handle's grip disappears");
});

// ---- The terminal theme gallery (spec P5) ----------------------------------------

/** A gallery card's markup — the wrapper holds only spans and buttons, so its first </div> closes it. */
const themeCard = (html, id) => new RegExp(`<div\\b[^>]*\\sdata-theme-card="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?<\\/div>`).exec(html)?.[0] ?? null;
const pressedCards = (html) =>
  attrOrder(html, 'data-theme-card').filter((id) => /<button\b[^>]*\saria-checked="true"/.test(themeCard(html, id) ?? ''));
/** The opening tag of a card's own button (the radio). */
const cardRadio = (html, id) => /<button\b[^>]*>/.exec(themeCard(html, id) ?? '')?.[0] ?? '';
// rounded-sm: the 2px of the old rounded-[2px], in Tailwind's own scale (RN-226).
const swatchesIn = (markup) => [...(markup ?? '').matchAll(/<span class="block h-\[10px\] rounded-sm" style="background:([^"]+)"/g)].map((m) => m[1]);
const mineTheme = { id: 'custom:mine', label: 'Mine', theme: { background: '#0a0b0c', red: '#ff0000' } };

scenario(
  'RN-160',
  'Settings draws the theme gallery: a card per built-in theme, the chosen one pressed, Import and an empty notice',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const { TERMINAL_THEME_IDS } = TERMINAL_THEMES_MODULE;
    expectThat(JSON.stringify(attrOrder(html, 'data-theme-card')) === JSON.stringify(TERMINAL_THEME_IDS), `the cards are ${JSON.stringify(attrOrder(html, 'data-theme-card'))}`);
    expectThat(JSON.stringify(pressedCards(html)) === '["dark-modern"]', `pressed: ${JSON.stringify(pressedCards(html))}`);
    expectThat(!/<option value="monokai"/.test(html), 'the old theme <select> is still drawn');
    // A radio group, one Tab stop, the arrows inside it (T14).
    expectThat(/<div\b[^>]*role="radiogroup"[^>]*aria-label="Terminal color themes"/.test(html), 'the cards are not a radio group');
    const radios = TERMINAL_THEMES_MODULE.TERMINAL_THEME_IDS.map((id) => cardRadio(html, id));
    expectThat(radios.every((tag) => /\srole="radio"/.test(tag) && !/aria-pressed/.test(tag)), `a card is not a radio: ${radios[0]}`);
    const stops = radios.filter((tag) => /\stabindex="0"/i.test(tag));
    expectThat(stops.length === 1 && /aria-checked="true"/.test(stops[0]), `the Tab stops among the cards: ${stops.length}, on the chosen one: ${stops[0]}`);
    expectThat(radios.every((tag) => /\stabindex="(-1|0)"/i.test(tag)), 'a card is out of the roving order');
    expectThat(/\stitle="Tomorrow Night"/.test(cardRadio(html, 'tomorrow-night')), 'a card whose name may be cut has no tooltip with the whole of it');
    // The notice keeps to the visible part of the list, so an Undo is never scrolled away (T3).
    expectThat(/class="[^"]*\bsticky\b[^"]*\bbottom-0\b[^"]*"[^>]*data-theme-notice=""/.test(html), 'the notice is not held in view');
    const dark = themeCard(html, 'dark-modern');
    expectThat(/<svg\b/.test(dark), 'the chosen card has no check mark — its only sign in forced colours');
    expectThat(!/<svg\b/.test(themeCard(html, 'nord')), 'a card that is not chosen has a check mark');
    expectThat(/forced-color-adjust-none/.test(dark), 'the sample is repainted away in forced colours');
    expectThat(!/#[0-9a-fA-F]{3,6}\b/.test(dark), `Dark Modern's card names literal colours instead of the app's tokens: ${dark}`);
    expectThat(/background:var\(--vsc-terminal-bg\)/.test(dark), 'Dark Modern is not drawn in the terminal token');
    expectThat(swatchesIn(dark).length === 16 && swatchesIn(themeCard(html, 'nord')).length === 16, 'a card does not show all 16 colours');
    expectThat(swatchesIn(themeCard(html, 'monokai'))[1] === '#F92672', `Monokai's red swatch is ${swatchesIn(themeCard(html, 'monokai'))[1]}`);
    expectThat(!/aria-label="Delete /.test(html), 'a built-in theme can be deleted');
    expectThat(buttonsIn(html).some((b) => b.text === 'Import Theme…'), 'no Import button');
    const input = /<input\b[^>]*type="file"[^>]*>/.exec(html)?.[0] ?? '';
    expectThat(/\bclass="hidden"/.test(input) && /tabindex="-1"/i.test(input), `the file input is on screen: ${input}`);
    expectThat(!/\saccept=/.test(input), 'an accept filter would grey out Ghostty files, which have no extension');
    expectThat(/<div\b[^>]*role="status"[^>]*aria-live="polite"[^>]*>\s*<\/div>/.test(html), 'there is no empty live region waiting for the first result');
    expectText(html, '0 of 20 imported;');
  }
);

scenario(
  'RN-161',
  'an imported theme: its own card, marked Imported with a delete button, pressed when chosen, and the pane frame in its background',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
    useSettingsStore.getState().setSetting('terminalCustomThemes', [mineTheme]);
    useSettingsStore.getState().setSetting('terminalTheme', 'custom:mine');
  },
  (html) => {
    expectThat(attrOrder(html, 'data-theme-card').at(-1) === 'custom:mine', 'the imported card is not after the built-ins');
    expectThat(JSON.stringify(pressedCards(html)) === '["custom:mine"]', `pressed: ${JSON.stringify(pressedCards(html))}`);
    const card = themeCard(html, 'custom:mine');
    expectText(card, 'Mine');
    expectText(card, 'Imported');
    expectThat(buttonsIn(card).some((b) => b.label === 'Delete Mine'), 'no delete button on the imported card');
    const deleteButton = /<button\b[^>]*aria-label="Delete Mine"[^>]*>/.exec(card)?.[0] ?? '';
    expectThat(/\stabindex="-1"/i.test(deleteButton), `the delete button is a Tab stop of its own: ${deleteButton}`);
    expectThat(/aria-keyshortcuts="Delete"/.test(cardRadio(html, 'custom:mine')), 'the keyboard way to delete is not announced');
    const swatches = swatchesIn(card);
    expectThat(swatches[1] === '#ff0000', `its red is ${swatches[1]}`);
    expectThat(swatches[2] === 'var(--vsc-ansi-green)', `a colour the file left out is not the default's token: ${swatches[2]}`);
    expectThat(/background:#0a0b0c/.test(card), 'its sample is not on its background');
    expectText(html, '1 of 20 imported;');
    expectThat(/background-color:#0a0b0c/.test(paneBodyTag(html, 'pane-1') ?? ''), `the frame round the terminal is not the imported background: ${paneBodyTag(html, 'pane-1')}`);
  }
);

scenario(
  'RN-162',
  'the pane frame follows a preview, and a chosen theme that is gone is drawn and marked as the default',
  () => {
    reset();
    useSettingsStore.getState().setSetting('terminalTheme', 'nord');
    useSettingsStore.setState({ terminalThemePreview: 'monokai' });
  },
  (html) => {
    expectThat(/background-color:#272822/.test(paneBodyTag(html, 'pane-1') ?? ''), `the frame is not the previewed theme's: ${paneBodyTag(html, 'pane-1')}`);
    useSettingsStore.setState({ terminalThemePreview: null, isSettingsModalOpen: true });
    useSettingsStore.getState().setSetting('terminalTheme', 'custom:gone');
    const gone = renderArranged();
    expectThat(!/background-color/.test(paneBodyTag(gone, 'pane-1') ?? ''), 'a missing theme paints a background of its own');
    expectThat(JSON.stringify(pressedCards(gone)) === '["dark-modern"]', `pressed: ${JSON.stringify(pressedCards(gone))}`);
  }
);

{
  const id = 'RN-163';
  const description = 'the gallery notice: an import, a refusal, a choice of schemes, a delete with Undo';
  const started = Date.now();
  try {
    const { ThemeNotice } = await import('../../src/components/common/ThemeGallery.jsx');
    const draw = (notice) => renderToString(React.createElement(ThemeNotice, { notice, onPick() {}, onUndo() {}, onDismiss() {} }));
    /** What a screen reader is told: the live region's content alone. */
    const announced = (markup) => visibleText(/<div\b[^>]*role="status"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? '').trim();
    const ok = draw({ kind: 'ok', text: 'Imported "Night" and switched the terminals to it.', detail: 'Not in the file, so taken from the default theme: selection.' });
    expectText(ok, 'Imported "Night"');
    expectText(ok, 'taken from the default theme: selection.');
    expectThat(/data-theme-notice="ok"/.test(ok), 'no notice drawn');
    expectThat(announced(ok) === 'Imported "Night" and switched the terminals to it.', `announced: ${JSON.stringify(announced(ok))}`);
    expectThat(buttonsIn(ok).some((b) => b.label === 'Dismiss'), 'no way to dismiss it');
    const error = draw({ kind: 'error', text: '"x.json" was not imported. It is not valid JSON.' });
    expectThat(/border-vsc-error text-vsc-error/.test(error), 'a refusal is not drawn as an error');
    expectText(error, 'It is not valid JSON.');
    const pick = draw({
      kind: 'pick',
      fileName: 'settings.json',
      text: '"settings.json" holds 2 color schemes. Choose one to import:',
      total: 2,
      schemes: [
        { ok: true, name: 'Campbell', theme: { background: '#0c0c0c' }, filled: [] },
        { ok: false, name: 'One Half Light', error: '"One Half Light" has a light background (#fafafa).' },
      ],
    });
    expectText(pick, '"settings.json" holds 2 color schemes. Choose one to import:');
    expectThat(buttonsIn(pick).some((b) => b.text === 'Campbell'), 'the importable scheme is not a button');
    expectThat(!buttonsIn(pick).some((b) => b.text.includes('One Half Light')), 'a refused scheme is offered');
    expectText(pick, 'One Half Light: "One Half Light" has a light background (#fafafa).');
    // Only the summary is read out — not every button and every reason (T14).
    expectThat(announced(pick) === '"settings.json" holds 2 color schemes. Choose one to import:', `announced: ${JSON.stringify(announced(pick))}`);
    // Nothing importable: the reasons, and no invitation to choose (T9).
    const none = draw({
      kind: 'pick',
      fileName: 'light.json',
      text: 'None of the 2 color schemes in "light.json" can be imported:',
      total: 2,
      schemes: [
        { ok: false, name: 'A', error: 'It has a light background.' },
        { ok: false, name: 'B', error: 'It has a light background.' },
      ],
    });
    expectThat(!/Choose one/.test(visibleText(none)), 'a list with nothing to choose asks to choose');
    expectText(none, 'B: It has a light background.');
    const deleted = draw({ kind: 'deleted', text: 'Deleted "B".', undo: { entry: {}, index: 0, wasChosen: false } });
    expectThat(buttonsIn(deleted).some((b) => b.text === 'Undo'), 'a delete offers no Undo');
    const nothing = draw(null);
    expectThat(/<div\b[^>]*role="status"[^>]*aria-live="polite"[^>]*><\/div>/.test(nothing) && visibleText(nothing).trim() === '', `no notice is not an empty live region: ${nothing}`);
    results.push({ id, description, ok: true, ms: Date.now() - started });
  } catch (err) {
    failed += 1;
    results.push({ id, description, ok: false, error: err, ms: Date.now() - started });
  }
}

// ---- The password lock (stage 3, part B) -------------------------------------
//
// A terminal whose typing is hidden — echo off in canonical mode, a password
// prompt (src-tauri/src/pty/echo_watch.rs) — carries a lock wherever its tab
// says something about it: a badge over the chip's corner that takes no room
// (a lock in line moved the chip's ✕ under the pointer), a mark on a hidden
// strip's handle, an in-line lock on the side bar's row (whose only target is
// the whole row). These cases check that each one shows it, in words, and
// that nothing else does.

/** The lock in some markup, as `{ tag, label, title }`, or null when there is none. */
function lockIn(markup) {
  const tag = /<span\b[^>]*\sdata-lock-mark="[^"]*"[^>]*>/.exec(markup ?? '')?.[0];
  if (!tag) return null;
  return { tag, label: attrOf(tag, 'aria-label'), title: attrOf(tag, 'title'), role: attrOf(tag, 'role') };
}

const LOCK_WORDS = 'Typing is hidden (password prompt)';

scenario(
  'RN-140',
  "a terminal asking for a password: a badge over its chip's corner that takes no room, the words in the chip's tooltip; an in-line lock on its side bar row",
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [tab('t1'), tab('t2')],
      groups: baseGroups(['t1', 't2']),
      notifications: entriesFor('t1', 2),
    });
    lockSessions(['t1']);
  },
  (html) => {
    const chip = tabChip(html, 't1');
    const lock = lockIn(chip);
    expectThat(lock, 'no lock on the chip');
    expectThat(lock.role === 'img' && lock.label === LOCK_WORDS, `the lock does not say it: ${lock.tag}`);
    const cls = classOf(lock.tag).split(/\s+/);
    // Legible (10 px, an 8 px padlock) and clear of the activity dot, which
    // starts 8 px into the chip: the badge ends where the dot begins.
    expectThat(iconOf(chip.slice(chip.indexOf(lock.tag))) === 'lock' && /\swidth="8"/.test(chip.slice(chip.indexOf(lock.tag))), 'the padlock is not 8 px');
    for (const word of ['absolute', 'pointer-events-none', '-top-[2px]', '-left-[2px]', 'w-[10px]', 'h-[10px]', 'text-vsc-warn']) {
      expectThat(cls.includes(word), `the chip's lock is not "${word}" — it must take no room, and no pointer: ${lock.tag}`);
    }
    const title = visibleText(attrOf(openingTag(chip), 'title') ?? '');
    expectThat(title.includes(LOCK_WORDS), `the chip's tooltip does not say it: ${JSON.stringify(title)}`);
    expectThat(!lockIn(tabChip(html, 't2')), 'a lock on a terminal that is not asking');
    const row = terminalRow(html, 't1');
    const rowTitle = visibleText(attrOf(openingTag(row), 'title') ?? '');
    expectThat(rowTitle.includes(LOCK_WORDS), `the side bar row's tooltip does not say it: ${JSON.stringify(rowTitle)}`);
    const rowLock = lockIn(row);
    expectThat(rowLock?.label === LOCK_WORDS && rowLock.title === LOCK_WORDS, 'no lock, with its words, on the side bar row');
    expectThat(!lockIn(terminalRow(html, 't2')), "a lock on the other terminal's row");
    // The rows keep their fixed height, lock or not.
    expectThat(classOf(openingTag(row)).split(/\s+/).includes('h-[38px]'), `the row is not 38px: ${openingTag(row)}`);
    expectThat(
      classOf(openingTag(terminalRow(html, 't2'))).split(/\s+/).includes('h-[38px]'),
      'the locked row is drawn at another height than its neighbour'
    );
  }
);

scenario(
  'RN-141',
  'with the strip hidden, a password prompt alone marks the handle, and says so in its words',
  () => arrangeHidden({ locked: ['t1'] }),
  (html) => {
    const pane = paneMarkup(html, 'pane-1');
    const handle = handleOf(pane);
    expectThat(/data-handle-mark="lock"/.test(handle ?? ''), `no lock mark on the handle: ${handle}`);
    expectThat(!/data-handle-mark="unread"/.test(handle), 'an unread mark with nothing unread');
    const words = attrOf(openingTag(handle), 'aria-label') ?? '';
    expectThat(words.includes(LOCK_WORDS), `the handle's words do not say it: ${JSON.stringify(words)}`);
    // The overlay strip's chip carries it too, for when the strip comes back.
    expectThat(lockIn(tabChip(pane.slice(pane.indexOf('data-strip-overlay')), 't1')), "no lock on the overlay strip's chip");
  }
);

scenario(
  'RN-142',
  'one-line side bar rows carry the lock too, at their one height',
  () => {
    reset();
    for (const key of ['terminalsPanelBranch', 'terminalsPanelAgent', 'terminalsPanelLastNote']) {
      useSettingsStore.getState().setSetting(key, false);
    }
    useTerminalStore.setState({ tabs: [tab('t1'), tab('t2')], groups: baseGroups(['t1', 't2']) });
    lockSessions(['t2']);
  },
  (html) => {
    const row = terminalRow(html, 't2');
    expectThat(lockIn(row)?.label === LOCK_WORDS, `no lock on a one-line row: ${row}`);
    expectThat(classOf(openingTag(row)).split(/\s+/).includes('h-[22px]'), `the row is not 22px: ${openingTag(row)}`);
    expectThat(!lockIn(terminalRow(html, 't1')), 'a lock on the terminal that is not asking');
  }
);

scenario(
  'RN-143',
  'nobody asking: no lock anywhere, and the handle marks nothing',
  () => arrangeHidden({ locked: [] }),
  (html) => {
    expectThat(!/data-lock-mark=/.test(html), 'a lock drawn with no terminal asking');
    expectThat(!/data-handle-mark=/.test(handleOf(paneMarkup(html, 'pane-1')) ?? ''), 'a mark on the handle with nothing to say');
  }
);

// ---- Project commands (stage 5) ---------------------------------------------

const { parseCommandsFile: parseProjectCommands } = await import('../../src/lib/projectCommands.js');

const PROJECT_FILE = parseProjectCommands(
  JSON.stringify({
    version: 1,
    commands: [
      { name: 'Run the tests', description: 'Every suite, once', command: 'npm test' },
      {
        name: 'Deploy',
        description: 'Ship it to a stage',
        command: 'npm run deploy -- --stage {{stage}} --note {{note}}',
        placeholders: {
          stage: { label: 'Stage', choices: ['dev', 'prod'], default: 'dev' },
          note: { label: 'Release note', description: 'Said in the changelog', default: '50% off' },
        },
      },
      { name: 'Quoted', command: 'echo "{{x}}"' },
    ],
  })
);
const USER_FILE = parseProjectCommands(JSON.stringify({ version: 1, commands: [{ name: 'Deploy', command: 'make deploy' }] }), { source: 'user' });
const SHA = 'a'.repeat(64);

/** The palette's result rows, each as `{ title, subtitle, hint, tag }`, in order. */
function paletteRows(html) {
  return [...html.matchAll(/<div\b[^>]*\sdata-palette-row="\d+"[^>]*>([\s\S]*?)<\/kbd><\/div>|<div\b[^>]*\sdata-palette-row="\d+"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => {
    const tag = /^<div\b[^>]*>/.exec(m[0])[0];
    const spans = [...m[0].matchAll(/<span\b[^>]*class="(truncate[^"]*)"[^>]*>([\s\S]*?)<\/span>/g)].map((x) => visibleText(x[2]));
    return { title: spans[0] ?? '', subtitle: spans[1] ?? '', hint: visibleText(/<kbd\b[^>]*>([\s\S]*?)<\/kbd>/.exec(m[0])?.[1] ?? ''), tag };
  });
}

/** The markup of the group headed `label` in the palette, up to the next heading. */
function paletteGroup(html, label) {
  const at = html.indexOf(`>${label}</div>`);
  if (at === -1) return null;
  return html.slice(at);
}

scenario(
  'RN-170',
  "the palette with a folder's file not trusted: one Review row, hint Project, after NexTerm's commands — none of the file's commands",
  () => {
    reset();
    useProjectCommandsStore.setState({ root: '/workspace', status: 'ok', sha256: SHA, project: PROJECT_FILE, trust: 'untrusted' });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'all' });
  },
  (html) => {
    const group = paletteGroup(html, 'project commands');
    expectThat(group, 'no project commands group');
    expectThat(html.indexOf('>commands</div>') < html.indexOf('>project commands</div>'), 'the group is not after the commands');
    const rows = paletteRows(group);
    expectThat(rows.length === 1, `rows: ${JSON.stringify(rows.map((r) => r.title))}`);
    expectThat(rows[0].title === "Review This Folder's Commands…", rows[0].title);
    expectThat(rows[0].subtitle === '2 commands (1 refused) in .nexterm/commands.json — not trusted yet', rows[0].subtitle);
    expectThat(rows[0].hint === 'Project', rows[0].hint);
    expectThat(!visibleText(html).includes('Every suite, once'), "an untrusted command's description is on screen");
  }
);

scenario(
  'RN-171',
  'trusted, with a user command of the same name: a row each, one line high, hint Project or User',
  () => {
    reset();
    useProjectCommandsStore.setState({ root: '/workspace', status: 'ok', sha256: SHA, project: PROJECT_FILE, trust: 'trusted', user: USER_FILE });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'project-commands' });
  },
  (html) => {
    const rows = paletteRows(html);
    expectThat(
      JSON.stringify(rows.map((r) => [r.title, r.hint])) === JSON.stringify([['Run the tests', 'Project'], ['Deploy', 'Project'], ['Deploy', 'User']]),
      JSON.stringify(rows.map((r) => [r.title, r.hint]))
    );
    expectThat(rows[2].subtitle === 'make deploy', `a command with no description is shown by its line: ${rows[2].subtitle}`);
    for (const row of rows) expectThat(classOf(row.tag).split(/\s+/).includes('h-[22px]'), `a row is not one line high: ${row.tag}`);
    expectThat(/placeholder="Run a project or user command…"/.test(html), 'the pick does not say what it is for');
    expectText(html, "1 of .nexterm/commands.json's commands was refused — Open Project Commands File to see why.");
  }
);

scenario(
  'RN-172',
  'Run Project Command… with none: a note says how to add some',
  () => {
    reset();
    useProjectCommandsStore.setState({ root: '/workspace', status: 'none' });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'project-commands' });
  },
  (html) => {
    expectThat(paletteRows(html).length === 0, 'a row with nothing to run');
    expectText(html, 'No commands yet. Put a folder\'s in .nexterm/commands.json (Open Project Commands File makes one with an example)');
    expectThat(/data-palette-note=/.test(html), 'not drawn as a note');
  }
);

scenario(
  'RN-173',
  'the review: every command with its whole line in monospace, every refused one with its reason, Trust and Cancel',
  () => {
    reset();
    useProjectCommandsStore.setState({
      root: '/workspace',
      status: 'ok',
      sha256: SHA,
      project: PROJECT_FILE,
      trust: 'changed',
      reviewing: { id: 1, root: '/workspace', sha256: SHA, project: PROJECT_FILE, trust: 'changed' },
    });
  },
  (html) => {
    expectThat(/\srole="alertdialog"/.test(html), 'not drawn as a dialog');
    expectText(html, "This Folder's Commands Have Changed");
    expectText(html, 'The file has changed since you trusted its commands.');
    const lines = [...html.matchAll(/<pre\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/pre>/g)];
    const shown = lines.map((m) => visibleText(m[2]));
    expectThat(
      JSON.stringify(shown) === JSON.stringify(['npm test', 'npm run deploy -- --stage {{stage}} --note {{note}}']),
      `the lines shown: ${JSON.stringify(shown)}`
    );
    for (const [, cls] of lines) {
      expectThat(cls.includes('font-mono') && cls.includes('whitespace-pre-wrap'), `a line not in monospace, wrapped: ${cls}`);
    }
    for (const words of ['Run the tests', 'Every suite, once', 'Deploy', 'Ship it to a stage']) expectText(html, words);
    expectText(html, 'Refused, and not offered (1):');
    expectText(html, 'Command 3 (Quoted): {{x}} has a quote right beside it');
    const buttons = buttonsIn(html).map((b) => b.text);
    expectThat(buttons.includes('Trust') && buttons.includes('Cancel'), JSON.stringify(buttons));
  }
);

/** The words of inline markup, run together as they are drawn (`visibleText` breaks a line at each tag). */
const inlineText = (html) => visibleText(String(html ?? '').replace(/<[^>]*>/g, ''));

/** The run dialog's markup. */
const runDialog = (html) => /<div\b[^>]*\sdata-project-run-dialog=""[\s\S]*$/.exec(html)?.[0] ?? null;

scenario(
  'RN-174',
  'the run dialog in cmd: a field per blank (a select for choices, defaults filled), a value cmd cannot take refused under its field, the line typed into cmd',
  () => {
    reset();
    useSystemStore.setState({ os: 'windows', defaultShell: 'C:\\Windows\\System32\\cmd.exe' });
    useTerminalStore.setState({ tabs: [tab('t1', { title: 'api', shell: 'C:\\Windows\\System32\\cmd.exe' })] });
    useProjectCommandsStore.setState({
      root: '/workspace',
      status: 'ok',
      sha256: SHA,
      project: PROJECT_FILE,
      trust: 'trusted',
      running: { id: 7, command: PROJECT_FILE.commands[1], root: '/workspace', sha256: SHA },
    });
  },
  (html) => {
    const dialog = runDialog(html);
    expectThat(dialog, 'no run dialog');
    expectThat(/\srole="dialog"/.test(dialog) && /\saria-modal="true"/.test(dialog), 'not a modal dialog');
    expectText(dialog, 'Deploy');
    expectText(dialog, 'From .nexterm/commands.json in this folder');
    expectThat(attrOrder(dialog, 'data-blank-field').join() === 'stage,note', `fields: ${attrOrder(dialog, 'data-blank-field')}`);
    expectThat(/<select\b[^>]*id="project-blank-stage"/.test(dialog), 'a blank with choices is not a select');
    expectThat(/<option[^>]*value="dev"[^>]*selected=""/.test(dialog), 'the default choice is not selected');
    expectThat(/<input\b[^>]*id="project-blank-note"[^>]*value="50% off"/.test(dialog), 'the default is not filled in');
    expectText(dialog, 'Said in the changelog');
    const reason = /<p\b[^>]*data-blank-error="note"[^>]*>([\s\S]*?)<\/p>/.exec(dialog)?.[1] ?? '';
    expectThat(inlineText(reason) === 'It holds % — cmd expands %…% even inside quotes', `the reason under the field: ${inlineText(reason)}`);
    expectThat(/<input\b[^>]*id="project-blank-note"[^>]*aria-invalid="true"/.test(dialog), 'the field is not marked invalid');
    expectThat(/<p\b[^>]*data-blank-error="stage"[^>]*><\/p>/.test(dialog), 'the line under a good field is not kept, empty');
    expectText(dialog, 'Typed into cmd');
    const preview = /<pre\b[^>]*data-run-preview=""[^>]*>([\s\S]*?)<\/pre>/.exec(dialog)?.[1] ?? '';
    expectThat(inlineText(preview) === 'npm run deploy -- --stage dev --note {{note}}', inlineText(preview));
    expectThat(/data-blank="stage"[^>]*class="[^"]*text-vsc-link/.test(preview), 'a value is not set apart from the command');
    expectThat(/data-blank="note"[^>]*class="text-vsc-error"/.test(preview), 'the refused blank is not marked');
    const buttons = buttonsIn(dialog);
    for (const name of ['Run', 'Type Only']) {
      const b = buttons.find((x) => x.text === name);
      expectThat(b?.disabled, `${name} is not disabled with a value that cannot be typed`);
      expectThat(b?.title === 'A value above cannot be typed for cmd.', `${name} does not say why: ${b?.title}`);
    }
    expectThat(!buttons.find((x) => x.text === 'Cancel').disabled, 'Cancel is disabled');
    expectThat(/data-run-target="this"[\s\S]*?This terminal \(api\)/.test(dialog), 'this terminal is not named');
    // No shell prompt reported yet (no OSC 133 here): it cannot tell what
    // runs in it, so the new split is chosen (review M1).
    expectThat(inlineText(/<label\b[^>]*data-run-target="this"[\s\S]*?<\/label>/.exec(dialog)?.[0]).includes('not offered: NexTerm cannot tell what runs in this terminal'), 'a terminal that never said where its prompt is was offered');
    expectThat(/data-run-target="split"/.test(dialog), 'no new split');
  }
);

scenario(
  'RN-175',
  'the run dialog over a terminal running something: this terminal not offered, saying why — the new split chosen — and a command with no blanks shows its line',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [tab('t1', { title: 'claude', shell: '/bin/zsh', running: true })] });
    useProjectCommandsStore.setState({ running: { id: 8, command: USER_FILE.commands[0] } });
  },
  (html) => {
    const dialog = runDialog(html);
    expectText(dialog, 'From your User Commands');
    const self = /<label\b[^>]*data-run-target="this"[\s\S]*?<\/label>/.exec(dialog)?.[0] ?? '';
    expectThat(/<input\b[^>]*disabled=""/.test(self), `this terminal can be chosen: ${self}`);
    expectThat(inlineText(self).includes('This terminal (claude) — not offered: something is running in it'), inlineText(self));
    expectThat(/\stitle="Something is running in this terminal — an agent, a server\. Typed there, the line would be that program&#x27;s input, not a command\."/.test(self), `the tooltip does not say why in full: ${self}`);
    const split = /<label\b[^>]*data-run-target="split"[\s\S]*?<\/label>/.exec(dialog)?.[0] ?? '';
    expectThat(/<input\b[^>]*checked=""/.test(split), 'the new split is not the choice');
    expectThat(attrOrder(dialog, 'data-blank-field').length === 0, 'fields for a command with no blanks');
    expectText(dialog, 'Typed into zsh');
    expectThat(inlineText(/<pre\b[^>]*data-run-preview=""[^>]*>([\s\S]*?)<\/pre>/.exec(dialog)?.[1] ?? '') === 'make deploy', 'the line is not shown');
    expectThat(!buttonsIn(dialog).find((b) => b.text === 'Run').disabled, 'Run is disabled');
  }
);

scenario(
  'RN-176',
  'Settings ▸ Terminal ▸ User Commands: a monospace multi-line field, spelling off, and what the validator says under it',
  () => {
    reset();
    useSettingsStore.getState().setSetting(
      'terminalUserCommands',
      JSON.stringify({ version: 1, commands: [{ name: 'Deploy', command: 'make deploy' }, { name: 'Oops', comand: 'x' }] })
    );
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const at = html.indexOf('terminal.userCommands');
    expectThat(at !== -1, 'no User Commands row');
    const rest = html.slice(at);
    const area = /<textarea\b[^>]*>/.exec(rest)?.[0] ?? '';
    expectThat(area, 'no multi-line field');
    expectThat(/spellcheck="false"/.test(area), `spelling is checked: ${area}`);
    expectThat(classOf(area).includes('font-mono'), 'not monospace');
    const check = /<div\b[^>]*data-setting-check="terminalUserCommands"[^>]*>([\s\S]*?)<\/div>/.exec(rest);
    expectThat(check, 'nothing said under it');
    expectThat(classOf(check[0]).includes('text-vsc-error'), 'a refused command is not said as an error');
    expectThat(visibleText(check[1]).includes('1 command; 1 refused, and not offered:'), visibleText(check[1]));
    expectThat(visibleText(check[1]).includes('Command 2 (Oops): A key NexTerm does not know: "comand".'), visibleText(check[1]));
  }
);


scenario(
  'RN-177',
  'command lines are drawn in the order they are typed — the preview, the review, a palette row shown by its line (review M5)',
  () => {
    reset();
    const rtl = parseProjectCommands(JSON.stringify({ version: 1, commands: [{ name: 'Copy', command: 'cp \u{5D0} \u{5D1}' }] }));
    useProjectCommandsStore.setState({
      root: '/workspace',
      status: 'ok',
      sha256: SHA,
      project: rtl,
      trust: 'trusted',
      reviewing: { id: 3, root: '/workspace', sha256: SHA, project: rtl, trust: 'untrusted' },
      running: { id: 9, command: rtl.commands[0], root: '/workspace', sha256: SHA },
    });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'project-commands' });
  },
  (html) => {
    const LTR = /style="direction:ltr;unicode-bidi:bidi-override"/;
    const preview = /<pre\b[^>]*data-run-preview=""[^>]*>/.exec(html)?.[0] ?? '';
    expectThat(LTR.test(preview), `the preview may be reordered: ${preview}`);
    const review = /<li\b[^>]*data-trust-command="project:0"[\s\S]*?<pre\b[^>]*>/.exec(html)?.[0] ?? '';
    expectThat(LTR.test(review), `the review's line may be reordered: ${review}`);
    const row = /<div\b[^>]*data-palette-row="0"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    expectThat(LTR.test(row), `the palette row's line may be reordered: ${row}`);
  }
);

scenario(
  'RN-178',
  "a run dialog whose file changed under it: Run off, and why in words under the buttons — not only in a tooltip (review S2, L9)",
  () => {
    reset();
    useTerminalStore.setState({ tabs: [tab('t1', { title: 'api', shell: '/bin/zsh' })], projectCommandBlock: () => null });
    useProjectCommandsStore.setState({
      root: '/workspace',
      status: 'ok',
      sha256: 'b'.repeat(64),
      project: PROJECT_FILE,
      trust: 'trusted',
      running: { id: 10, command: PROJECT_FILE.commands[0], root: '/workspace', sha256: SHA },
    });
  },
  (html) => {
    const dialog = runDialog(html);
    const why = /<p\b[^>]*data-run-why=""[^>]*>([\s\S]*?)<\/p>/.exec(dialog)?.[1] ?? '';
    expectThat(inlineText(why) === "This folder's commands file has changed since this opened — review it again.", `why: ${inlineText(why)}`);
    const run = buttonsIn(dialog).find((b) => b.text === 'Run');
    expectThat(run?.disabled, 'Run is on for a file that changed');
    expectThat(/<button\b[^>]*aria-describedby="project-run-why-10"[^>]*data-run-run=""/.test(dialog) || /data-run-run=""[^>]*aria-describedby="project-run-why-10"/.test(dialog) || /aria-describedby="project-run-why-10"/.test(dialog), 'Run does not point at its reason');
    expectThat(/<pre\b[^>]*aria-labelledby="project-run-heading-10"/.test(dialog), 'the preview has no name');
    // The terminal is idle, at an empty prompt: offered — but a new split is
    // the choice, a fresh shell where the line can be run (review round 3).
    const self = /<label\b[^>]*data-run-target="this"[\s\S]*?<\/label>/.exec(dialog)?.[0] ?? '';
    const split = /<label\b[^>]*data-run-target="split"[\s\S]*?<\/label>/.exec(dialog)?.[0] ?? '';
    expectThat(!/disabled=""/.test(self) && !/checked=""/.test(self), `this terminal is not offered, or is the choice: ${self}`);
    expectThat(/checked=""/.test(split), 'a new split is not the choice');
  }
);

scenario(
  'RN-179',
  'text typed at the prompt of this terminal: not offered, saying so — the new split chosen (review H1)',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [tab('t1', { title: 'api', shell: '/bin/zsh' })],
      projectCommandBlock: () => 'something is typed at its prompt — clear it, or use New split',
    });
    useProjectCommandsStore.setState({ running: { id: 11, command: USER_FILE.commands[0] } });
  },
  (html) => {
    const dialog = runDialog(html);
    const self = /<label\b[^>]*data-run-target="this"[\s\S]*?<\/label>/.exec(dialog)?.[0] ?? '';
    expectThat(inlineText(self).includes('This terminal (api) — not offered: something is typed at its prompt'), inlineText(self));
    expectThat(/\stitle="Not offered: something is typed at its prompt — clear it, or use New split\."/.test(self), `the whole reason is not in the tooltip: ${self}`);
    expectThat(/<input\b[^>]*disabled=""/.test(self), 'it can be chosen');
    expectThat(/<label\b[^>]*data-run-target="split"[\s\S]*?checked=""/.test(dialog), 'the new split is not chosen');
  }
);

scenario(
  'RN-180',
  'the review: as tall as the window allows, its words scrolling, the buttons outside them (review M1) — and Trust off with a notice when the file changed while it was open (L7)',
  () => {
    reset();
    useProjectCommandsStore.setState({
      root: '/workspace',
      status: 'ok',
      sha256: 'c'.repeat(64),
      project: PROJECT_FILE,
      trust: 'untrusted',
      reviewing: { id: 4, root: '/workspace', sha256: SHA, project: PROJECT_FILE, trust: 'untrusted' },
    });
  },
  (html) => {
    const box = /<div\b[^>]*role="alertdialog"[^>]*>/.exec(html)?.[0] ?? '';
    expectThat(/max-h-\[80vh\]/.test(classOf(box)) && /\bflex-col\b/.test(classOf(box)), `not held within the window: ${box}`);
    const message = /<div\b[^>]*data-confirm-message=""[^>]*>/.exec(html)?.[0] ?? '';
    expectThat(/overflow-y-auto/.test(classOf(message)), 'the words do not scroll');
    expectThat(html.indexOf('data-confirm-message') < html.indexOf('>Trust</button>'), 'the buttons are inside what scrolls');
    expectText(html, 'The file has changed since this opened. Trust is off until you have seen the new version.');
    const trust = buttonsIn(html).find((b) => b.text === 'Trust');
    expectThat(trust?.disabled, 'Trust is on for a file that changed while the review was open');
    expectThat(buttonsIn(html).some((b) => b.text === 'Show the New Version'), 'no way to see the new version');
  }
);
// ---- Scrollback across a restart (stage 6, spec D9) ---------------------------

/** One Settings row, from its title to the next row: `settingKey`'s, or the action button's. */
/** Whether the row's checkbox is drawn checked; throws when it has none. */
function rowChecked(row) {
  const box = /<input\b[^>]*type="checkbox"[^>]*>/.exec(row)?.[0];
  expectThat(box, 'no checkbox in the row');
  return /\schecked=""/.test(box);
}

function settingRowAt(html, marker) {
  const at = html.indexOf(marker);
  expectThat(at !== -1, `no row with ${marker}`);
  const start = html.lastIndexOf('<div class="py-3 px-1', at);
  const next = html.indexOf('<div class="py-3 px-1', at);
  return html.slice(start, next === -1 ? undefined : next);
}

scenario(
  'RN-181',
  'Settings ▸ Terminal ▸ Restore Scrollback: on by default, saying what is kept, where, that secrets are masked and that off deletes — and Clear Saved Scrollback as a button',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const row = settingRowAt(html, 'terminal.integrated.restoreScrollback');
    const text = visibleText(row);
    expectThat(text.includes('Restore Scrollback'), 'no title');
    for (const words of [
      'under a dim "Previous output" line',
      'nothing is run again',
      // Which folder depends on the platform the suite runs on (Node 21+ has a
      // `navigator`); SW-20 holds each one to the backend's.
      'com.nexterm.ide',
      'on this computer only',
      'replaced with [hidden]',
      'the saved files are deleted',
    ]) {
      expectThat(text.includes(words), `the description does not say ${JSON.stringify(words)}: ${text.replace(/\s+/g, ' ')}`);
    }
    expectThat(rowChecked(row), 'not on by default');
    expectThat(!buttonsIn(row).some((b) => b.text === 'Reset'), 'a default offers Reset');
    const order = ['terminal.integrated.scrollback', 'terminal.integrated.restoreScrollback', 'data-setting-action="clearSavedScrollback"'].map((m) => html.indexOf(m));
    expectThat(order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1])), `not beside Scrollback: ${order}`);

    const clear = settingRowAt(html, 'data-setting-action="clearSavedScrollback"');
    const button = buttonsIn(clear).find((b) => b.text === 'Clear Saved Scrollback…');
    expectThat(button && !button.disabled, 'no Clear Saved Scrollback button');
    expectThat(visibleText(clear).includes('after asking'), 'does not say it asks first');
    expectThat(!/font-mono text-ui-sm text-vsc-muted">[^<]*</.test(clear), 'an action row shows a setting key it does not have');
    expectThat(!buttonsIn(clear).some((b) => b.text === 'Reset'), 'an action offers Reset');
    expectThat(!/role="alertdialog"/.test(html), 'the question is open before anything was asked');
  }
);

scenario(
  'RN-182',
  'Restore Scrollback turned off: Disabled, with Reset — and the Clear button still there',
  () => {
    reset();
    useSettingsStore.getState().setSetting('terminalRestoreScrollback', false);
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const row = settingRowAt(html, 'terminal.integrated.restoreScrollback');
    expectThat(!rowChecked(row), 'still drawn as on');
    expectThat(visibleText(row).includes('Disabled'), 'does not say Disabled');
    expectThat(buttonsIn(row).some((b) => b.text === 'Reset'), 'a changed setting offers no Reset');
    expectThat(html.includes('data-setting-action="clearSavedScrollback"'), 'the Clear button went with the setting');
  }
);

// ---- The control API (stage 7, spec D5/D6) ---------------------------------------

scenario(
  'RN-183',
  'Settings ▸ Terminal ▸ Control: under its heading, the API on and typing and other terminals off by default, each saying what it opens and that only terminals NexTerm started reach it',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const headings = [...html.matchAll(/data-settings-subsection="Control"/g)];
    expectThat(headings.length === 1, `the Control heading is drawn ${headings.length} times`);
    expectText(html, 'Terminal ▸ Control');
    const keys = ['terminal.control.enabled', 'terminal.control.typeAndRead', 'terminal.control.otherTerminals'];
    const at = keys.map((k) => html.indexOf(k));
    expectThat(at.every((i, n) => i !== -1 && (n === 0 || i > at[n - 1])), `the three rows are not drawn in order: ${at}`);
    expectThat(html.indexOf('data-settings-subsection="Control"') < at[0], 'the heading is not above the rows');
    // Last in the Terminal section: no other row is drawn under its heading.
    const under = html.slice(html.indexOf('data-settings-subsection="Control"'), html.indexOf('data-section="workbench"'));
    const keysUnder = [...under.matchAll(/font-mono text-ui-sm text-vsc-muted">([^<]+)</g)].map((m) => m[1]);
    expectThat(JSON.stringify(keysUnder) === JSON.stringify(keys), `rows under the Control heading: ${keysUnder.join(', ')}`);
    const [api, typing, others] = keys.map((k) => settingRowAt(html, k));
    expectThat(rowChecked(api), 'the API is not on by default');
    expectThat(!rowChecked(typing), 'typing and reading is on by default');
    expectThat(!rowChecked(others), 'other terminals is on by default');
    const say = (row, words) => {
      const text = visibleText(row).replace(/\s+/g, ' ');
      for (const w of words) expectThat(text.includes(w), `the row does not say ${JSON.stringify(w)}: ${text}`);
    };
    say(api, ['Let Programs in Terminals Control NexTerm', 'nexterm-cli', 'notification', 'status line', 'progress bar', 'open a split', 'Only programs in terminals NexTerm started can reach it, as you', 'nothing listens on the network', 'Show Control Log']);
    say(typing, ['Let Programs Type Into and Read Terminals', 'nexterm-cli send', 'nexterm-cli read-screen', 'Never into a password prompt', '[hidden]', 'Only from terminals NexTerm started, as you']);
    say(others, ['Let Programs Control Other Terminals', 'every other terminal', 'unmasked', 'Only from terminals NexTerm started, as you']);
  }
);

scenario(
  'RN-184',
  "a program's status on its terminal's second line, in the note's place, with its tone's icon and words — and not on another terminal's row",
  () => {
    arrangeBoard();
    useTerminalStore.setState({ reportedStatus: { 'sb-1': { text: 'Running tests', tone: 'warn', at: Date.now() - 60_000 } } });
  },
  (html) => {
    const row = terminalRow(html, 'sb-1');
    const tag = tagWith(row, 'data-reported-status');
    expectThat(tag && attrOf(tag, 'data-reported-status') === 'warn', `no reported status on the row: ${row}`);
    const text = visibleText(row);
    expectThat(text.includes('Running tests'), 'the status is not drawn');
    expectThat(text.includes('status, warning:'), 'the tone is not read out');
    expectThat(!/data-last-note=/.test(row), 'the last note is still drawn beside it');
    const tooltip = attrOf(tag, 'title') ?? '';
    expectThat(tooltip.includes('Status from the program in this terminal') && tooltip.includes('Last notification:'), `the tooltip: ${JSON.stringify(tooltip)}`);
    expectThat(/lucide-triangle-alert/.test(row), 'not the warning icon');
    expectThat(/data-last-note=/.test(terminalRow(html, 'sb-2')), "another terminal's note went too");
    expectThat(!/data-reported-status=/.test(terminalRow(html, 'sb-2')), 'a status on a terminal that reported none');
  }
);

scenario(
  'RN-185',
  "another terminal's program controlled this one: a badge on its chip's corner and a mark on its row, naming the caller — and nothing on the others",
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [tab('t1', { title: 'agent' }), tab('t2', { title: 'build' })],
      groups: baseGroups(['t1', 't2']),
      controlled: { t2: { by: 't1', byTitle: 'agent', cmd: 'send', at: Date.now(), n: 1 } },
    });
  },
  (html) => {
    const chip = tabChip(html, 't2');
    const badge = tagWith(chip, 'data-controlled-mark');
    expectThat(badge, `no mark on the chip: ${chip}`);
    expectThat(attrOf(badge, 'aria-label') === 'Controlled by agent (send)' && attrOf(badge, 'role') === 'img', `the mark does not say who: ${badge}`);
    expectThat(attrOf(badge, 'title') === 'Controlled by agent (send)', 'no tooltip naming the caller');
    const cls = classOf(badge).split(/\s+/);
    // Over the top edge just right of the lock's corner, above the activity dot.
    for (const word of ['absolute', '-top-[2px]', 'left-[9px]', 'w-[10px]', 'h-[10px]']) {
      expectThat(cls.includes(word), `the chip's mark is not "${word}" — it must take no room: ${badge}`);
    }
    expectThat(!/data-controlled-mark=/.test(tabChip(html, 't1')), 'the caller is marked');
    const row = terminalRow(html, 't2');
    expectThat(attrOf(tagWith(row, 'data-controlled-mark'), 'aria-label') === 'Controlled by agent (send)', `no mark on the side bar row: ${row}`);
    expectThat(!/data-controlled-mark=/.test(terminalRow(html, 't1')), "a mark on the caller's row");
  }
);

scenario(
  'RN-186',
  'Show Control Log: the calls newest first — who, what, of whom, how much, the answer — and never anything they carried',
  () => {
    reset();
    useControlLogStore.setState({ entries: [], open: true });
    const record = useControlLogStore.getState().record;
    record({ at: new Date(2026, 10, 7, 9, 5, 1).getTime(), caller: 't1', callerTitle: 'agent', cmd: 'send', target: 't2', targetTitle: 'build', size: 12, result: 'ok' });
    record({ at: new Date(2026, 10, 7, 9, 5, 2).getTime(), caller: 't1', callerTitle: 'agent', cmd: 'read-screen', target: 'self', lines: 40, result: 'disabled' });
  },
  (html) => {
    const box = /<div\b[^>]*\sdata-control-log-dialog=""[\s\S]*$/.exec(html)?.[0] ?? '';
    expectThat(box, 'the dialog is not open');
    expectThat(/role="dialog"/.test(box) && /aria-modal="true"/.test(box), 'not a modal dialog');
    expectText(box, 'Control Log');
    expectText(box, '2 calls');
    const rows = [...box.matchAll(/<tr\b[^>]*data-control-log-row="[^"]*"[^>]*>[\s\S]*?<\/tr>/g)].map((m) => visibleText(m[0]).replace(/\s+/g, ' ').trim());
    expectThat(rows.length === 2, `${rows.length} rows`);
    expectThat(rows[0].startsWith('09:05:02') && rows[0].includes('read-screen') && rows[0].includes('itself') && rows[0].includes('40 lines') && rows[0].includes('disabled'), `the newest row: ${rows[0]}`);
    expectThat(rows[1].startsWith('09:05:01') && rows[1].includes('agent') && rows[1].includes('build (t2)') && rows[1].includes('12 bytes') && rows[1].includes('ok'), `the older row: ${rows[1]}`);
    expectText(box, 'What was typed and what was read are never kept.');
    expectThat(buttonsIn(box).some((b) => b.text === 'Clear'), 'no Clear');
    expectThat(buttonsIn(box).some((b) => b.label === 'Close'), 'no Close');
  }
);

scenario(
  'RN-187',
  'Show Control Log with nothing logged says so; closed, it is not drawn at all',
  () => {
    reset();
    useControlLogStore.setState({ entries: [], open: true });
  },
  (html) => {
    expectThat(/data-control-log-empty=""/.test(html), 'no word for an empty log');
    expectText(html, 'No program has asked NexTerm for anything yet.');
    useControlLogStore.setState({ open: false });
    expectThat(!/data-control-log-dialog/.test(renderArranged()), 'drawn while closed');
  }
);

scenario(
  'RN-188',
  "with the strip hidden, another terminal's program controlling this one marks the handle, and its words say who (review: integration 7)",
  () =>
    arrangeHidden({
      tabIds: ['t1'],
      extra: { tabs: [tab('t1', { title: 'build' })], controlled: { t1: { by: 't9', byTitle: 'agent', cmd: 'send', at: Date.now(), n: 1 } } },
    }),
  (html) => {
    const handle = handleOf(paneMarkup(html, 'pane-1'));
    expectThat(/data-handle-mark="controlled"/.test(handle ?? ''), `no controlled mark on the handle: ${handle}`);
    const words = attrOf(openingTag(handle), 'aria-label') ?? '';
    expectThat(words.includes('Controlled by agent (send)'), `the handle's words do not say it: ${JSON.stringify(words)}`);
    expectThat((attrOf(openingTag(handle), 'title') ?? '').includes('Controlled by agent (send)'), "the handle's tooltip does not say it");
  }
);

scenario(
  'RN-189',
  "with every second-line item off, a program's status still shows on its one-line row — and nowhere else (review: integration 12)",
  () => {
    reset();
    for (const key of ['terminalsPanelBranch', 'terminalsPanelAgent', 'terminalsPanelLastNote']) {
      useSettingsStore.getState().setSetting(key, false);
    }
    useTerminalStore.setState({
      tabs: [tab('t1'), tab('t2')],
      groups: baseGroups(['t1', 't2']),
      reportedStatus: { t2: { text: 'Deploying to staging', tone: 'error', at: Date.now() } },
    });
  },
  (html) => {
    const row = terminalRow(html, 't2');
    expectThat(classOf(openingTag(row)).split(/\s+/).includes('h-[22px]'), `not a one-line row: ${openingTag(row)}`);
    const tag = tagWith(row, 'data-reported-status');
    expectThat(tag && attrOf(tag, 'data-reported-status') === 'error', `no status on the one-line row: ${row}`);
    expectThat(visibleText(row).includes('Deploying to staging') && visibleText(row).includes('status, error:'), 'the status is not drawn, or not read out');
    expectThat(!/data-status-line=/.test(row), 'a second line was drawn after all');
    expectThat(!/data-reported-status=/.test(terminalRow(html, 't1')), 'a status on a terminal that reported none');
  }
);

scenario(
  'RN-190',
  "a hidden strip's handle marks a program acting on ANY terminal of its pane, naming one that is not the one shown (re-verification F10)",
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [tab('t1', { title: 'shell' }), tab('t2', { title: 'build' })],
      groups: baseGroups(['t1', 't2']),
      controlled: { t2: { by: 't9', byTitle: 'agent', cmd: 'send', at: Date.now(), n: 1 } },
    });
  },
  () => {
    for (const s of STORES) Object.assign(s.getInitialState(), s.getState());
    const handle = renderToString(
      React.createElement(StripHandle, {
        paneId: 'pane-1',
        tabId: 't1',
        title: 'shell',
        tabs: [{ id: 't1', title: 'shell' }, { id: 't2', title: 'build' }],
      })
    );
    expectThat(/data-handle-mark="controlled"/.test(handle), `no mark for the terminal behind the one shown: ${handle}`);
    const words = attrOf(openingTag(handle), 'aria-label') ?? '';
    expectThat(words.includes('build: Controlled by agent (send)'), `the handle does not name it: ${JSON.stringify(words)}`);
    const quiet = renderToString(React.createElement(StripHandle, { paneId: 'pane-1', tabId: 't1', title: 'shell', tabs: [{ id: 't1', title: 'shell' }] }));
    expectThat(!/data-handle-mark="controlled"/.test(quiet), 'a mark for a terminal that is not in the pane');
  }
);

scenario(
  'RN-191',
  "a program acting on a terminal behind the pane's shown tab flashes that pane's ring (re-verification F10)",
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [tab('t1'), tab('t2')],
      groups: baseGroups(['t1', 't2']),
      attentionFlash: { t2: 7 },
    });
  },
  (html) => {
    const pane = paneMarkup(html, 'pane-1');
    expectThat(/data-attention-ring="flash"/.test(pane ?? ''), `the pane does not flash for its tab behind: ${String(pane).slice(0, 300)}`);
  }
);

// ---- The agent session history: AGENT SESSIONS and Resume Agent Session… ----------

const CLAUDE_ID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
/** An entry as `agent_history_list` answers, last used `minutesAgo` minutes ago. */
const historyEntry = (key, extra = {}, minutesAgo = 5) => ({
  key,
  kind: 'opencode',
  sessionId: null,
  cwd: '/work/app',
  title: null,
  startedAt: Date.now() - (minutesAgo + 60) * 60e3,
  lastUsedAt: Date.now() - minutesAgo * 60e3,
  endedAt: null,
  endReason: null,
  ...extra,
});
const HISTORY = [
  historyEntry('k-open', { sessionId: 'ses_abcdefgh1234567', title: 'Fix the login flow', cwd: '/work/api' }, 5),
  historyEntry('k-claude', { kind: 'claude', sessionId: CLAUDE_ID, cwd: '/work/web' }, 120),
  historyEntry('k-free', { cwd: '/work/tools' }, 3 * 24 * 60),
];

/** The AGENT SESSIONS section's markup, up to the context menu after it. */
function agentSessionsSection(html) {
  const at = html.indexOf('data-agent-sessions=""');
  return at === -1 ? null : html.slice(at);
}

/** Its rows, each as `{ key, text, title, tag }`, in the order drawn. */
function agentSessionRowsIn(html) {
  return [...html.matchAll(/<div\b[^>]*\sdata-agent-session="([^"]*)"[^>]*>[\s\S]*?<\/div>/g)].map((m) => ({
    key: m[1],
    text: visibleText(m[0]).replace(/\s+/g, ' ').trim(),
    title: visibleText(/\stitle="([^"]*)"/.exec(m[0])?.[1] ?? ''),
    tag: m[0],
  }));
}

scenario(
  'RN-200',
  'AGENT SESSIONS lists the history newest first: agent, title or short id, folder, when, and a badge for one a terminal holds (AC16)',
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: HISTORY, loaded: true, holders: { 'k-open': { tabId: 't1', state: 'open' } } });
  },
  (html) => {
    const section = agentSessionsSection(html);
    expectThat(section, 'no AGENT SESSIONS section');
    expectThat(html.indexOf('>Saved</span>') < html.indexOf('>Agent Sessions</span>'), 'the section is not below SAVED');
    expectThat(/data-agent-sessions-count="3"/.test(section), 'the header does not count the entries');
    const rows = agentSessionRowsIn(section);
    expectThat(JSON.stringify(rows.map((r) => r.key)) === JSON.stringify(['k-open', 'k-claude', 'k-free']), JSON.stringify(rows.map((r) => r.key)));
    const [open, claude, free] = rows;
    for (const words of ['Fix the login flow', 'opencode', 'api', '5m ago', 'open']) expectThat(open.text.includes(words), `the first row lacks ${JSON.stringify(words)}: ${open.text}`);
    expectThat(/data-agent-holder="open"/.test(open.tag), 'the held entry has no badge');
    expectThat(open.title.includes('/work/api'), `the folder's full path is not in the tooltip: ${open.title}`);
    for (const words of ['d4bef4d0', 'Claude Code', 'web', '2h ago']) expectThat(claude.text.includes(words), `the Claude Code row lacks ${JSON.stringify(words)}: ${claude.text}`);
    expectThat(!/data-agent-holder/.test(claude.tag), 'an entry no terminal holds has a badge');
    for (const words of ['most recent in folder', 'tools', '3d ago']) expectThat(free.text.includes(words), `the id-less row lacks ${JSON.stringify(words)}: ${free.text}`);
    expectThat(!/Show all/.test(section), 'three entries offer "Show all"');
    expectThat(!visibleText(section).includes('are listed here, newest first'), 'the empty-state hint is drawn beside entries');
  }
);

scenario(
  'RN-201',
  'AGENT SESSIONS with no entries: a count of 0 and the one-line hint (AC16)',
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: [], loaded: true, holders: {} });
  },
  (html) => {
    const section = agentSessionsSection(html);
    expectThat(section, 'no AGENT SESSIONS section');
    expectThat(/data-agent-sessions-count="0"/.test(section), 'the header does not say 0');
    expectThat(agentSessionRowsIn(section).length === 0, 'rows with no entries');
    expectText(section, 'Claude Code and OpenCode sessions run in these terminals are listed here, newest first.');
  }
);

scenario(
  'RN-202',
  'more than 15 entries: the first 15, then "Show all (N)…"; an offered entry is badged as such',
  () => {
    reset();
    const many = Array.from({ length: 18 }, (_, i) => historyEntry(`k-${i}`, { title: `Task ${i}` }, i + 1));
    useAgentHistoryStore.setState({ entries: many, loaded: true, holders: { 'k-2': { tabId: 't1', state: 'offered' } } });
  },
  (html) => {
    const section = agentSessionsSection(html);
    const rows = agentSessionRowsIn(section);
    expectThat(rows.length === 15, `${rows.length} rows drawn`);
    expectThat(rows[0].key === 'k-0' && rows[14].key === 'k-14', JSON.stringify(rows.map((r) => r.key)));
    expectThat(/data-agent-sessions-count="18"/.test(section), 'the header does not count every entry');
    expectThat(/data-agent-sessions-all=""/.test(section), 'no "Show all" row');
    expectText(section, 'Show all (18)…');
    expectThat(/data-agent-holder="offered"/.test(rows[2].tag), 'the offered entry is not badged "offered"');
  }
);

scenario(
  'RN-203',
  "the palette lists Resume Agent Session… and Clear Agent Session History… among NexTerm's commands (AC17)",
  () => {
    reset();
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'all' });
  },
  (html) => {
    const titles = paletteRows(paletteGroup(html, 'commands') ?? '').map((r) => r.title);
    expectThat(titles.includes('Resume Agent Session…'), `no Resume Agent Session…: ${JSON.stringify(titles)}`);
    expectThat(titles.includes('Clear Agent Session History…'), 'no Clear Agent Session History…');
    expectThat(!html.includes('>agent sessions</div>'), 'with nothing typed, the default palette lists the entries');
  }
);

scenario(
  'RN-204',
  'Resume Agent Session… lists every entry newest first, title, folder and agent on each row (AC17)',
  () => {
    reset();
    // Out of order on purpose: the pick sorts by when each was last used.
    useAgentHistoryStore.setState({ entries: [HISTORY[2], HISTORY[0], HISTORY[1]], loaded: true });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'agent-sessions' });
  },
  (html) => {
    const rows = paletteRows(html);
    expectThat(
      JSON.stringify(rows.map((r) => [r.title, r.subtitle, r.hint])) ===
        JSON.stringify([
          ['Fix the login flow', '/work/api', 'opencode'],
          ['d4bef4d0', '/work/web', 'Claude Code'],
          ['most recent in folder', '/work/tools', 'opencode'],
        ]),
      JSON.stringify(rows.map((r) => [r.title, r.subtitle, r.hint]))
    );
    expectThat(/placeholder="Resume an agent session/.test(html), 'the pick does not say what it is for');
  }
);

scenario(
  'RN-205',
  'Resume Agent Session… with an empty history says how the list fills',
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: [], loaded: true });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'agent-sessions' });
  },
  (html) => {
    expectThat(paletteRows(html).length === 0, 'a row with nothing to resume');
    expectText(html, 'No agent sessions yet. Claude Code and OpenCode conversations run in a NexTerm terminal are listed here, newest first.');
  }
);

scenario(
  'RN-206',
  'a resume that switched to the terminal holding the entry says so, and can be dismissed',
  () => {
    reset();
    useTerminalStore.setState({
      agentHistoryNotice: { kind: 'focused', text: 'That opencode conversation is already open in t1 — switched to it rather than opening it twice.', key: 'k-open', tabId: 't1', seq: 1 },
    });
  },
  (html) => {
    const notice = /<div\b[^>]*\sdata-agent-history-notice="focused"[^>]*>[\s\S]*?<\/button><\/div>/.exec(html)?.[0];
    expectThat(notice, 'no notice drawn');
    expectThat(/\srole="status"/.test(notice), 'a switch is announced as an error');
    expectText(notice, 'Already open');
    expectText(notice, 'switched to it rather than opening it twice.');
    expectThat(buttonsIn(notice).some((b) => b.title === 'Dismiss'), 'nothing to close it with');
  }
);

scenario(
  'RN-207',
  "a resume refused for a missing folder is an alert, beside the editor's open failure rather than over it",
  () => {
    reset();
    useTerminalStore.setState({
      agentHistoryNotice: { kind: 'missingFolder', text: '/work/gone is not there any more, so opencode cannot be resumed in it. The entry stays in the list.', key: 'k', tabId: null, seq: 2 },
    });
    useEditorStore.setState({ openFailure: { path: '/workspace/a.bin', fileName: 'a.bin', reason: 'Binary file' } });
  },
  (html) => {
    const notice = /<div\b[^>]*\sdata-agent-history-notice="missingFolder"[^>]*>/.exec(html)?.[0];
    expectThat(notice, 'no notice drawn');
    expectThat(/\srole="alert"/.test(notice), 'not announced');
    expectThat(/right-\[416px\]/.test(notice), `drawn over the open-failure notice: ${notice}`);
    expectText(html, 'Folder not found');
    expectText(html, '/work/gone is not there any more');
    expectText(html, 'Could not open a.bin');
  }
);

scenario(
  'RN-208',
  'a Clear Agent Session History… that left a copy behind is an alert that says so',
  () => {
    reset();
    useTerminalStore.getState().showAgentHistoryNotice(
      'clearFailed',
      'The agent session history was emptied, but 1 damaged copy of it kept aside could not be deleted. Try again; or delete agent-sessions.json.bad-* in NexTerm’s data folder'
    );
  },
  (html) => {
    const notice = /<div\b[^>]*\sdata-agent-history-notice="clearFailed"[^>]*>[\s\S]*?<\/button><\/div>/.exec(html)?.[0];
    expectThat(notice, 'no notice drawn');
    expectThat(/\srole="alert"/.test(notice), 'not announced as an alert');
    expectText(notice, 'Agent session history not cleared');
    expectText(notice, 'could not be deleted. Try again');
    expectThat(buttonsIn(notice).some((b) => b.title === 'Dismiss'), 'nothing to close it with');
  }
);

const CLAUDE_TITLED = historyEntry('k-claude', { kind: 'claude', sessionId: CLAUDE_ID, cwd: '/work/web', title: 'Rotate the deploy key ghp_[hidden]' }, 120);

scenario(
  'RN-209',
  "AGENT SESSIONS draws a Claude Code entry by the title Claude Code gave it, not by its short id (AC23)",
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: [HISTORY[0], CLAUDE_TITLED], loaded: true, holders: {} });
  },
  (html) => {
    const claude = agentSessionRowsIn(agentSessionsSection(html) ?? '').find((r) => r.key === 'k-claude');
    expectThat(claude, 'no Claude Code row');
    for (const words of ['Rotate the deploy key ghp_[hidden]', 'Claude Code', 'web']) expectThat(claude.text.includes(words), `the row lacks ${JSON.stringify(words)}: ${claude.text}`);
    expectThat(!claude.text.includes('d4bef4d0'), `the short id is drawn instead: ${claude.text}`);
    expectThat(claude.title.startsWith('Claude Code: Rotate the deploy key'), `the tooltip does not name it: ${claude.title}`);
  }
);

scenario(
  'RN-210',
  "Resume Agent Session… shows a Claude Code entry's own title on its row (AC23)",
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: [HISTORY[0], CLAUDE_TITLED], loaded: true });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'agent-sessions' });
  },
  (html) => {
    const rows = paletteRows(html).map((r) => [r.title, r.hint]);
    expectThat(
      JSON.stringify(rows) === JSON.stringify([['Fix the login flow', 'opencode'], ['Rotate the deploy key ghp_[hidden]', 'Claude Code']]),
      JSON.stringify(rows)
    );
  }
);

// ---- AGENT SESSIONS curated: pinned, groups, the rest, Archived (F25, AC37) -------

/** Its group headers, each as `{ id, collapsed, count, text, at }`, in the order drawn. */
function agentGroupHeadersIn(html) {
  return [...html.matchAll(/<div\b[^>]*\sdata-agent-group="([^"]*)"[^>]*>[\s\S]*?<\/div>/g)].map((m) => ({
    id: m[1],
    collapsed: /\sdata-agent-group-collapsed="([^"]*)"/.exec(m[0])?.[1],
    count: Number(/\sdata-agent-group-count="([^"]*)"/.exec(m[0])?.[1]),
    text: visibleText(m[0]).replace(/\s+/g, ' ').trim(),
    at: m.index,
  }));
}
/** A row's place in the markup, its level and whether it carries the pin marker. */
const rowFacts = (html, key) => {
  const at = html.indexOf(`data-agent-session="${key}"`);
  const tag = at === -1 ? '' : html.slice(html.lastIndexOf('<div', at), html.indexOf('>', at) + 1);
  return { at, level: /\sdata-agent-level="(\d)"/.exec(tag)?.[1] ?? null, pinned: /\sdata-agent-pinned=""/.test(tag) };
};

const CURATED_GROUPS = [
  { id: 'g-work', name: 'Work', collapsed: false },
  { id: 'g-folded', name: 'Folded away', collapsed: true },
  { id: 'g-empty', name: 'Nothing yet', collapsed: false },
];
const CURATED = [
  historyEntry('k-archived-new', { title: 'Archived but newest', archived: true }, 1),
  historyEntry('k-pinned', { title: 'Pinned in Work', pinned: true, groupId: 'g-work' }, 50),
  historyEntry('k-member', { title: 'A Work member' }, 10),
  historyEntry('k-folded', { title: 'Under a folded group', groupId: 'g-folded' }, 12),
  historyEntry('k-renamed', { kind: 'claude', sessionId: CLAUDE_ID, cwd: '/work/web', title: 'What Claude Code called it', name: 'My own name' }, 20),
  historyEntry('k-plain', { title: 'Plain and ungrouped' }, 30),
  historyEntry('k-archived-old', { title: 'Archived long ago', archived: true, groupId: 'g-work' }, 900),
];
CURATED[2].groupId = 'g-work';

scenario(
  'RN-211',
  'AGENT SESSIONS curated: pinned rows first with a pin, then each group with its count and its rows a level deeper, then the rest; Archived closed with its count; a renamed row by its name (AC37)',
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: CURATED, groups: CURATED_GROUPS, loaded: true, holders: {} });
  },
  (html) => {
    const section = agentSessionsSection(html);
    expectThat(section, 'no AGENT SESSIONS section');
    expectThat(/data-agent-sessions-count="5"/.test(section), `the header counts the archived entries: ${/data-agent-sessions-count="(\d+)"/.exec(section)?.[1]}`);
    const keys = agentSessionRowsIn(section).map((r) => r.key);
    expectThat(JSON.stringify(keys) === JSON.stringify(['k-pinned', 'k-member', 'k-renamed', 'k-plain']), `rows drawn: ${JSON.stringify(keys)}`);
    const headers = agentGroupHeadersIn(section);
    expectThat(JSON.stringify(headers.map((h) => [h.id, h.collapsed, h.count])) === JSON.stringify([['g-work', 'false', 1], ['g-folded', 'true', 1], ['g-empty', 'false', 0]]), JSON.stringify(headers));
    for (const [h, name] of [[headers[0], 'Work'], [headers[1], 'Folded away'], [headers[2], 'Nothing yet']]) expectThat(h.text.startsWith(name), `the header does not name its group: ${h.text}`);
    const pinned = rowFacts(section, 'k-pinned');
    expectThat(pinned.pinned && pinned.level === '1', `the pinned row: ${JSON.stringify(pinned)}`);
    expectThat(pinned.at < headers[0].at, 'a pinned row comes after a group header');
    const pinnedRow = agentSessionRowsIn(section).find((r) => r.key === 'k-pinned');
    expectThat(/data-agent-session-group="g-work"/.test(pinnedRow.tag) && pinnedRow.text.includes('Work'), `the pinned row does not name its group: ${pinnedRow.text}`);
    const member = rowFacts(section, 'k-member');
    expectThat(member.level === '2' && !member.pinned && member.at > headers[0].at && member.at < headers[1].at, `the member is not under its header: ${JSON.stringify(member)}`);
    expectThat(rowFacts(section, 'k-folded').at === -1, 'a collapsed group draws its rows');
    for (const key of ['k-renamed', 'k-plain']) {
      const row = rowFacts(section, key);
      expectThat(row.level === '1' && !row.pinned && row.at > headers[2].at, `the ungrouped row ${key} is not after the groups: ${JSON.stringify(row)}`);
    }
    const renamed = agentSessionRowsIn(section).find((r) => r.key === 'k-renamed');
    expectThat(renamed.text.includes('My own name') && !renamed.text.includes('What Claude Code called it'), `the renamed row: ${renamed.text}`);
    expectThat(renamed.title.startsWith('Claude Code: My own name') && renamed.title.includes('Its own title: What Claude Code called it'), `its tooltip: ${renamed.title}`);
    const archived = /<div\b[^>]*\sdata-agent-archived="([^"]*)"[^>]*>[\s\S]*?<\/div>/.exec(section);
    expectThat(archived && archived[1] === 'closed', 'no closed Archived header');
    expectThat(/data-agent-archived-count="2"/.test(archived[0]) && visibleText(archived[0]).includes('Archived'), `the Archived header: ${archived?.[0]}`);
    expectThat(archived.index > rowFacts(section, 'k-plain').at, 'Archived is not last');
    expectThat(!section.includes('data-agent-session="k-archived-new"') && !section.includes('data-agent-session="k-archived-old"'), 'archived rows drawn while closed');
    expectThat(!visibleText(section).includes('are listed here, newest first'), 'the empty-state hint beside entries');
  }
);

scenario(
  'RN-212',
  'AGENT SESSIONS with only archived entries: the hint, a count of 0 and Archived (n), no rows; a group alone keeps the hint away (AC37, F25)',
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: [CURATED[0], CURATED[6]], groups: [], loaded: true, holders: {} });
  },
  (html) => {
    const section = agentSessionsSection(html);
    expectThat(/data-agent-sessions-count="0"/.test(section), 'the header counts the archived entries');
    expectText(section, 'Claude Code and OpenCode sessions run in these terminals are listed here, newest first.');
    expectThat(/data-agent-archived="closed"/.test(section) && /data-agent-archived-count="2"/.test(section), 'no Archived (2)');
    expectThat(agentSessionRowsIn(section).length === 0, 'rows drawn');
    reset();
    useAgentHistoryStore.setState({ entries: [], groups: [CURATED_GROUPS[2]], loaded: true, holders: {} });
    const alone = agentSessionsSection(renderArranged());
    expectThat(!visibleText(alone).includes('are listed here, newest first'), 'the hint beside a group');
    expectThat(agentGroupHeadersIn(alone).map((h) => `${h.id}:${h.count}`).join() === 'g-empty:0', 'the empty group is not drawn with 0');
    expectThat(!/data-agent-archived=/.test(alone), 'an Archived header with nothing archived');
  }
);

scenario(
  'RN-213',
  "Resume Agent Session… curated: pinned first, then newest first, a grouped row's subtitle names its group, then 'archived agent sessions' (AC40)",
  () => {
    reset();
    useAgentHistoryStore.setState({ entries: CURATED, groups: CURATED_GROUPS, loaded: true });
    useSettingsStore.setState({ isCommandPaletteOpen: true, commandPaletteMode: 'agent-sessions' });
  },
  (html) => {
    const live = paletteRows(paletteGroup(html, 'agent sessions') ?? '');
    const archivedAt = html.indexOf('>archived agent sessions</div>');
    expectThat(archivedAt !== -1, 'no archived agent sessions group');
    const listed = live.filter((r) => html.indexOf(r.tag) < archivedAt).map((r) => [r.title, r.subtitle, r.hint]);
    expectThat(
      JSON.stringify(listed) ===
        JSON.stringify([
          ['Pinned in Work', '/work/app · Work', 'opencode · pinned'],
          ['A Work member', '/work/app · Work', 'opencode'],
          ['Under a folded group', '/work/app · Folded away', 'opencode'],
          ['My own name', '/work/web', 'Claude Code'],
          ['Plain and ungrouped', '/work/app', 'opencode'],
        ]),
      JSON.stringify(listed)
    );
    const archived = paletteRows(html.slice(archivedAt)).map((r) => [r.title, r.subtitle]);
    expectThat(JSON.stringify(archived) === JSON.stringify([['Archived but newest', '/work/app'], ['Archived long ago', '/work/app · Work']]), JSON.stringify(archived));
    expectThat(/placeholder="Resume an agent session — name, title, group/.test(html), 'the placeholder does not mention names and groups');
  }
);

scenario(
  'RN-214',
  'a pin, rename, group or delete the history refused is an alert headed "Agent session not changed" (F30)',
  () => {
    reset();
    useTerminalStore.getState().showAgentHistoryNotice('curationFailed', 'There can be at most 50 agent session groups');
  },
  (html) => {
    const notice = /<div\b[^>]*\sdata-agent-history-notice="curationFailed"[^>]*>[\s\S]*?<\/button><\/div>/.exec(html)?.[0];
    expectThat(notice, 'no notice drawn');
    expectThat(/\srole="alert"/.test(notice), 'not announced as an alert');
    expectText(notice, 'Agent session not changed');
    expectText(notice, 'There can be at most 50 agent session groups');
  }
);

scenario(
  'RN-215',
  'a newer NexTerm’s list draws the same sections; more than 15 ungrouped rows end in "Show all (N)…" with N every unarchived entry (F25, F30)',
  () => {
    reset();
    const many = Array.from({ length: 17 }, (_, i) => historyEntry(`k-${i}`, { title: `Task ${i}` }, i + 1));
    many.push(historyEntry('k-pin', { title: 'Pinned', pinned: true }, 100), historyEntry('k-arch', { title: 'Gone', archived: true }, 200));
    useAgentHistoryStore.setState({ entries: many, groups: [], readOnly: true, version: 3, loaded: true, holders: {} });
  },
  (html) => {
    const section = agentSessionsSection(html);
    const keys = agentSessionRowsIn(section).map((r) => r.key);
    expectThat(keys.length === 16 && keys[0] === 'k-pin' && keys[15] === 'k-14', JSON.stringify(keys));
    expectThat(/data-agent-sessions-count="18"/.test(section), 'the count');
    expectText(section, 'Show all (18)…');
    expectThat(/data-agent-archived-count="1"/.test(section), 'no Archived (1)');
  }
);

// ---- Claude Code working or idle, from its title (T-20261117-135439-4164) --------

/** Three Claude Code terminals — working, idle, idle with an unread entry — and a plain one. */
function arrangeClaudeStates() {
  reset();
  useTerminalStore.setState({
    tabs: [
      tab('cc-w', { title: 'busy', ...running('cc-w', 'claude') }),
      tab('cc-i', { title: 'done', ...running('cc-i', 'claude'), running: true }),
      tab('cc-u', { title: 'told', ...running('cc-u', 'claude') }),
      tab('cc-p', { title: 'plain' }),
    ],
    activeTabId: 'cc-p',
    groups: [groupOf('group-1', ['cc-w', 'cc-i', 'cc-u', 'cc-p'])],
    // Each state just began: since U5 (RN-238) a line says how long its
    // state has held, and these cases are about the state's words alone.
    agentActivity: {
      'cc-w': Object.freeze({ state: 'working', since: Date.now() }),
      'cc-i': Object.freeze({ state: 'idle', since: Date.now() }),
      'cc-u': Object.freeze({ state: 'idle', since: Date.now() }),
    },
    notifications: [
      { id: 'agent-cc-u-1-1', kind: 'program', origin: 'agent-done', agent: 'claude', tabId: 'cc-u', tabTitle: 'told', title: 'Claude Code', body: 'Waiting for you after 12s of work', durationMs: 12000, at: Date.now(), read: false },
    ],
  });
}

scenario(
  'RN-216',
  'TERMINALS: a working Claude Code draws Working with the loader, an idle one Idle with a ring (even while its shell runs it), an unread entry Waiting (AC12)',
  arrangeClaudeStates,
  (html) => {
    const working = statusIn(terminalRow(html, 'cc-w'));
    expectThat(working?.state === 'working' && working.words === 'Working' && working.icon === 'loader-circle', `working: ${JSON.stringify(working)}`);
    const idle = statusIn(terminalRow(html, 'cc-i'));
    expectThat(idle?.state === 'idle' && idle.words === 'Idle' && idle.icon === 'circle', `idle: ${JSON.stringify(idle)}`);
    expectThat(!/text-vsc-info|text-vsc-attention|text-vsc-error/.test(idle.iconTag), `the idle ring is coloured as news: ${idle.iconTag}`);
    const told = statusIn(terminalRow(html, 'cc-u'));
    expectThat(told?.state === 'waiting' && told.words === 'Waiting', `an unread entry: ${JSON.stringify(told)}`);
    expectThat(statusIn(terminalRow(html, 'cc-p')) === null, 'the plain terminal says something');
  }
);

scenario(
  'RN-217',
  "AGENT SESSIONS: a row held open says its terminal's state with the same word; an offered row says offered; a held row whose terminal says nothing says open (AC12, F7)",
  () => {
    arrangeClaudeStates();
    useAgentHistoryStore.setState({
      entries: HISTORY,
      loaded: true,
      holders: {
        'k-open': { tabId: 'cc-i', state: 'open' },
        'k-claude': { tabId: 'cc-w', state: 'offered' },
        'k-free': { tabId: 'cc-p', state: 'open' },
      },
    });
  },
  (html) => {
    const rows = agentSessionRowsIn(agentSessionsSection(html) ?? '');
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const held = byKey['k-open'];
    const badge = tagWith(held?.tag, 'data-agent-state');
    expectThat(badge && attrOf(badge, 'data-agent-holder') === 'open' && attrOf(badge, 'data-agent-state') === 'idle', `the held badge: ${badge}`);
    const termWords = statusIn(terminalRow(html, 'cc-i'))?.words;
    expectThat(termWords === 'Idle' && held.text.includes(termWords), `the held row does not say its terminal's ${termWords}: ${held?.text}`);
    expectThat(/lucide-circle\b/.test(held.tag), 'the held badge has no icon');
    // The row's tooltip says it is open, as in v0.27.0; the live state is the
    // badge's and its own title's (F7 as amended).
    const tipLines = (row) => row.title.split('\n').map((line) => line.trim());
    expectThat(tipLines(held).includes('Open in a terminal of this window') && !/Open in a terminal of this window:/.test(held.title), `its tooltip: ${held.title}`);
    expectThat(attrOf(badge, 'title') === 'Open in a terminal of this window: Idle', `the held badge's title: ${badge}`);
    const offered = byKey['k-claude'];
    expectThat(/data-agent-holder="offered"/.test(offered?.tag ?? '') && !/data-agent-state=/.test(offered.tag) && offered.text.includes('offered'), `the offered row: ${offered?.tag}`);
    expectThat(offered.title.includes('Offered for resuming in a terminal of this window'), `the offered tooltip: ${offered.title}`);
    const quiet = byKey['k-free'];
    const quietBadge = tagWith(quiet?.tag, 'data-agent-state');
    expectThat(attrOf(quietBadge, 'data-agent-state') === 'none' && attrOf(quietBadge, 'data-agent-holder') === 'open', `the quiet badge: ${quietBadge}`);
    expectThat(/>open<\/span>/.test(quiet.tag), `the quiet row does not say open: ${quiet.tag}`);
    expectThat(tipLines(quiet).includes('Open in a terminal of this window') && !/Open in a terminal of this window:/.test(quiet.title), `the quiet tooltip: ${quiet.title}`);
    expectThat(attrOf(quietBadge, 'title') === 'Open in a terminal of this window: open', `the quiet badge's title: ${quietBadge}`);
  }
);

scenario(
  'RN-218',
  "the bell list draws a finished Claude Code turn as a program's entry (AC12, F10)",
  () => reset(),
  () => {
    const html = renderToString(
      React.createElement(NotificationList, {
        notifications: [
          { id: 'agent-t1-1-1', kind: 'program', origin: 'agent-done', agent: 'claude', tabId: 't1', tabTitle: 't1', title: 'Claude Code', body: 'Waiting for you after 12s of work \u{2014} Fix it', durationMs: 12000, at: Date.now(), read: false },
        ],
        onGo() {},
        onDismiss() {},
      })
    );
    const kinds = [...html.matchAll(/\sdata-notification-entry="([^"]+)"/g)].map((m) => m[1]);
    expectThat(JSON.stringify(kinds) === '["program"]', `drawn as ${JSON.stringify(kinds)}`);
    expectText(html, 'Waiting for you after 12s of work');
  }
);

scenario(
  'RN-219',
  'the settings window offers Notify When an Agent Is Done as a number, 10 by default, right after Notify After (AC13)',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    const after = html.indexOf('terminal.integrated.notifyAfterSeconds');
    const at = html.indexOf('terminal.integrated.agentDoneAfterSeconds');
    const before = html.indexOf('terminal.integrated.programNotifications');
    expectThat(after !== -1 && at !== -1 && before !== -1 && after < at && at < before, `not between Notify After and Notifications from Programs: ${after} ${at} ${before}`);
    const keys = [...html.matchAll(/font-mono text-ui-sm text-vsc-muted">([^<]+)</g)].map((m) => m[1]);
    const n = keys.indexOf('terminal.integrated.notifyAfterSeconds');
    expectThat(
      n !== -1 && keys[n + 1] === 'terminal.integrated.agentDoneAfterSeconds' && keys[n + 2] === 'terminal.integrated.programNotifications',
      `not directly after Notify After: ${keys.slice(Math.max(0, n), n + 3)}`
    );
    expectText(html, 'Notify When an Agent Is Done');
    expectText(html, 'Needs no Claude Code setting.');
    const input = /<input\b[^>]*type="number"[^>]*>/.exec(html.slice(at, before))?.[0] ?? '';
    expectThat(/\svalue="10"/.test(input), `not a number input at 10: ${input}`);
  }
);

scenario(
  'RN-220',
  "the README says where Claude Code's state and its completion come from, in each section that tells of them (AC14, F13)",
  () => reset(),
  () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    /** The text of the section headed `heading`, to the next heading of its level or higher. */
    const section = (heading) => {
      const at = readme.indexOf(heading);
      expectThat(at !== -1, `no section ${heading}`);
      const level = /^#+/.exec(heading)[0].length;
      const rest = readme.slice(at + heading.length);
      const end = rest.search(new RegExp(`\\n#{1,${level}} `));
      return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
    };
    const say = (text, words, where) => {
      for (const w of words) expectThat(text.includes(w), `${where} does not say ${JSON.stringify(w)}`);
    };
    say(section('### Knowing what every terminal is doing'), ['Notify When an Agent Is Done', 'needs no Claude Code setting', 'one entry for that moment, not two'], 'Knowing what every terminal is doing');
    say(section('#### Notifications from programs'), ['no longer needed', 'one entry', 'Notify When an Agent Is Done'], 'Notifications from programs');
    say(section('#### The TERMINALS panel as a status board'), ['Idle', 'Working', '✳', 'not running'], 'The TERMINALS panel as a status board');
    say(section('#### Agent sessions: every conversation run here'), ['Idle', 'Working', 'open'], 'Agent sessions');
    say(readme.replace(/\s+/g, ' '), ['`idle`', '`working`'], 'the control section');
  }
);

check('RN-221', "a change of Claude Code's state redraws its own line, never the whole TERMINALS panel (non-functional: cost)", () => {
  // As for the bars (RN-114): the panel reading the activity map would
  // redraw every row on each state change; the second line reads its own
  // terminal's entry and nothing else of the map.
  const panel = readFileSync(new URL('../../src/components/terminal/TerminalsPanel.jsx', import.meta.url), 'utf8');
  const board = readFileSync(new URL('../../src/components/terminal/StatusBoard.jsx', import.meta.url), 'utf8');
  expectThat(!/\bs\.agentActivity\b/.test(panel), 'the TERMINALS panel subscribes to the activity map');
  expectThat(!/\.agentActivity\b/.test(panel), 'the TERMINALS panel reads the activity map');
  const start = board.search(/^export const TerminalStatusLine = memo\(function TerminalStatusLine\(/m);
  expectThat(start !== -1, 'the second line is not a memoised module-level component');
  const rest = board.slice(start);
  const end = rest.search(/^\}\);/m);
  // The component's code, its comments left out.
  const line = (end === -1 ? rest : rest.slice(0, end)).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const own = /useTerminalStore\(\(s\) => \(showAgent \? s\.agentActivity\?\.\[tabId\] \?\? null : null\)\)/;
  expectThat(own.test(line), 'the second line does not subscribe to its own terminal\'s entry');
  const reads = (line.match(/\bagentActivity\b/g) || []).length;
  expectThat(reads === 1, `the second line reads the activity map ${reads} times, not once for its own entry`);
});

// ---- The UI refresh: palette, focus, simple look, responsive panels ------------
//
// What the stylesheet and the class strings must say, read from the source:
// CSS is not drawn by a server render, and focus, hover and the separators'
// states only exist in a browser. The human checks what these cannot
// (WebView2 and WKWebView, forced colours, scaling).

// LF whatever the checkout has: a Windows one has CRLF, and checks here are
// written against `\n` (PZ-31 failed on windows-latest for v0.33.0 on that).
const readSource = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** The :root value of `--vsc-<name>` as written, or null. */
const rootToken = (css, name) => new RegExp(`--vsc-${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim() ?? null;
/** Every .js/.jsx/.css file under a source directory, as [path, text]. */
function sourcesUnder(rel) {
  const out = [];
  for (const entry of readdirSync(new URL(`../../${rel}/`, import.meta.url), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourcesUnder(child));
    else if (/\.(jsx?|css)$/.test(entry.name)) out.push([child, readSource(child)]);
  }
  return out;
}

check('RN-222', 'the palette: ActionMacro violet on bluish greys, every text and UI-part pair at WCAG contrast', () => {
  const css = readSource('src/styles/index.css');
  const exact = {
    accent: '#8B5CF6', 'accent-hover': '#6D28D9', 'accent-solid': '#7C3AED', 'accent-pressed': '#5B21B6',
    'accent-text': '#C4B5FD', focus: '#8B5CF6', 'focus-ring': '#C4B5FD', link: '#A78BFA', 'badge-accent': '#7C3AED',
    selection: '#3B2C5B',
    'titlebar-bg': '#0E1014', 'activitybar-bg': '#0E1014', 'sidebar-bg': '#0E1014', 'panel-bg': '#0E1014',
    'terminal-bg': '#0E1014', 'statusbar-bg': '#0E1014', 'tab-inactive-bg': '#0E1014', 'attention-fg': '#0E1014',
    'editor-bg': '#15171C', 'tab-active-bg': '#15171C',
    'widget-bg': '#1B1E25', 'quickinput-bg': '#1B1E25', 'menu-bg': '#1B1E25',
    'input-bg': '#232731', 'button-secondary': '#232731', hover: '#232731',
    border: '#2A2F3A',
    'widget-border': '#3A4150', 'input-border': '#3A4150', 'indent-guide': '#3A4150', 'badge-bg': '#3A4150',
    'input-border-hover': '#4F586B',
    fg: '#E7E9EE', 'activitybar-fg': '#E7E9EE', 'line-number-active': '#E7E9EE', 'badge-fg': '#E7E9EE',
    muted: '#9BA3AF', 'tab-inactive-fg': '#9BA3AF', 'activitybar-muted': '#9BA3AF',
    'input-placeholder': '#8B93A0', 'inactive-selection': '#2B303C',
    'line-number': '#6B7280', 'indent-guide-active': '#6B7280',
    'item-hover': 'rgba(155, 163, 175, 0.18)', 'item-active': 'rgba(155, 163, 175, 0.30)',
    scrollbar: 'rgba(155, 163, 175, 0.28)', 'scrollbar-hover': 'rgba(155, 163, 175, 0.45)',
  };
  for (const [name, value] of Object.entries(exact)) {
    expectThat((rootToken(css, name) ?? '').toLowerCase() === value.toLowerCase(), `--vsc-${name} is ${rootToken(css, name)}, not ${value}`);
  }
  // No colour of the old palette is left, comments included.
  const old = /#(0078d4|026ec1|04395e|181818|1f1f1f|202020|222222|313131|3c3c3c|2b2b2b|cccccc|9d9d9d|989898|868686|d7d7d7|2a2d2e|37373d|6e7681|404040|707070|282828|aeafad|616161|f8f8f8)\b/i;
  const left = [...sourcesUnder('src/styles'), ...sourcesUnder('src/components'), ['src/lib/monaco.js', readSource('src/lib/monaco.js')]]
    .filter(([, text]) => old.test(text)).map(([file, text]) => `${file}: ${old.exec(text)[0]}`);
  expectThat(left.length === 0, `colours of the old palette are left: ${left.join(', ')}`);

  const hex = (name) => {
    const value = rootToken(css, name);
    expectThat(/^#[0-9a-fA-F]{6}$/.test(value ?? ''), `--vsc-${name} is not #RRGGBB (the contrast maths and xterm parse it): ${value}`);
    return value;
  };
  const surfaces = ['sidebar-bg', 'editor-bg', 'widget-bg', 'input-bg', 'inactive-selection'];
  const needs = (fgName, bgNames, min) => {
    for (const bgName of bgNames) {
      const ratio = contrast(hex(fgName), hex(bgName));
      expectThat(ratio >= min, `--vsc-${fgName} on --vsc-${bgName} is ${ratio.toFixed(2)}:1, under ${min}`);
    }
  };
  for (const text of ['fg', 'muted', 'tab-inactive-fg', 'activitybar-muted']) needs(text, [...surfaces, 'selection'], 4.5);
  needs('input-placeholder', ['input-bg', 'widget-bg'], 4.5);
  needs('accent', surfaces, 3);
  needs('focus', ['input-bg', 'widget-bg', 'editor-bg', 'sidebar-bg'], 3);
  needs('focus-ring', [...surfaces, 'selection', 'accent-solid'], 3);
  needs('accent-text', surfaces, 4.5);
  needs('link', [...surfaces, 'selection'], 4.5);
  needs('accent-fg', ['accent-solid', 'accent-hover', 'accent-pressed'], 4.5);
  needs('fg', ['selection'], 4.5);
  needs('selection-fg', ['selection'], 4.5);
  needs('attention-fg', ['attention'], 4.5);
  needs('line-number', ['editor-bg'], 3);
  // Violet reads as neither "a terminal wants you" nor a warning nor a failure.
  const apart = (a, b) => Math.min(Math.abs(hue(a) - hue(b)), 360 - Math.abs(hue(a) - hue(b)));
  for (const other of ['attention', 'warn', 'error']) {
    expectThat(apart(hex('accent'), hex(other)) >= 60, `the accent is ${apart(hex('accent'), hex(other)).toFixed(0)}\u{00b0} from --vsc-${other}`);
  }
  // No text sits on the plain accent: white on it is under 4.5:1.
  const plainFill = sourcesUnder('src/components').filter(([, text]) => /\bbg-vsc-accent\b(?![-/])[^'"`\n]*\btext-vsc-accent-fg\b|\btext-vsc-accent-fg\b[^'"`\n]*\bbg-vsc-accent\b(?![-/])/.test(text));
  expectThat(plainFill.length === 0, `text on the plain accent (use bg-vsc-accent-solid): ${plainFill.map(([file]) => file).join(', ')}`);
});

check('RN-229', "Monaco's theme is a copy of the stylesheet's tokens, key by key", () => {
  const css = readSource('src/styles/index.css');
  const monaco = readSource('src/lib/monaco.js');
  const key = (name) => new RegExp(`'${name.replace(/\./g, '\\.')}':\\s*'(#[0-9a-fA-F]{6,8})'`).exec(monaco)?.[1] ?? null;
  const mirrors = {
    'editor.background': 'editor-bg',
    'editorGutter.background': 'editor-bg',
    'editor.foreground': 'fg',
    'editorCursor.foreground': 'fg',
    'editorLineNumber.foreground': 'line-number',
    'editorLineNumber.activeForeground': 'line-number-active',
    'editorIndentGuide.background1': 'indent-guide',
    'editorIndentGuide.activeBackground1': 'indent-guide-active',
    'editorWidget.background': 'widget-bg',
    'editorWidget.border': 'widget-border',
    'input.background': 'input-bg',
    'input.border': 'input-border',
    'inputOption.activeBorder': 'accent',
    'list.hoverBackground': 'hover',
    'list.activeSelectionBackground': 'selection',
    'menu.background': 'menu-bg',
    'menu.foreground': 'fg',
    'menu.selectionBackground': 'selection',
    'menu.border': 'widget-border',
    focusBorder: 'focus',
  };
  for (const [monacoKey, token] of Object.entries(mirrors)) {
    const value = key(monacoKey);
    expectThat(value && value.toLowerCase() === (rootToken(css, token) ?? '').toLowerCase(), `Monaco's ${monacoKey} is ${value}, --vsc-${token} is ${rootToken(css, token)}`);
  }
  for (const [monacoKey, value] of [
    ['editor.selectionBackground', '#523F8A'],
    ['editor.lineHighlightBorder', '#1F232B'],
    ['scrollbarSlider.background', '#9BA3AF47'],
    ['scrollbarSlider.hoverBackground', '#9BA3AF73'],
  ]) {
    expectThat((key(monacoKey) ?? '').toLowerCase() === value.toLowerCase(), `Monaco's ${monacoKey} is ${key(monacoKey)}, not ${value}`);
  }
  // The slider is the stylesheet's scrollbar grey.
  expectThat(/^rgba\(155, 163, 175,/.test(rootToken(css, 'scrollbar') ?? ''), `--vsc-scrollbar is no longer #9BA3AF: ${rootToken(css, 'scrollbar')}`);
  // The selection still reads on the editor as the old one did.
  expectThat(Math.abs(luminance('#523F8A') - luminance('#264f78')) < 0.01, 'the editor selection is lighter or darker than before');
  expectThat(contrast(key('editor.foreground'), key('editor.selectionBackground')) >= 4.5, 'editor text on the selection is under 4.5:1');
});

/** The body of the first `<at-rule> {` block that starts at column 0, up to its closing brace at column 0. */
const topBlock = (css, head) => {
  const start = css.indexOf(`\n${head} {`);
  if (start === -1) return null;
  const end = css.indexOf('\n}', start + 1);
  return css.slice(start + head.length + 3, end);
};
/** Every `selector { declarations }` rule in a block of CSS without nested blocks. */
const rulesIn = (block) =>
  [...(block ?? '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    props: m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(':')[0].trim()),
    body: m[2],
  }));

check('RN-223', 'focus is one rule: a keyboard-only ring in the base layer, a field shows focus by its own border, and forced colours keep both', () => {
  const css = readSource('src/styles/index.css');
  const base = topBlock(css, '@layer base');
  expectThat(base, 'no @layer base block');
  expectThat(/(^|\n)\s*:focus-visible \{\s*outline: 2px solid var\(--vsc-focus-ring\);\s*outline-offset: -2px;\s*\}/.test(base), `the keyboard ring is not 2px of --vsc-focus-ring, 2px in: ${base}`);
  const fields = /:is\(input:not\(\[type=checkbox\], \[type=radio\], \[type=range\], \[type=file\], \[type=color\]\), textarea, select\):focus-visible \{\s*outline: none;\s*\}/;
  expectThat(fields.test(base), 'text fields keep an outline of their own (F6)');
  // Unlayered, after `@tailwind utilities`, a :focus-visible rule beats
  // every `outline-none`: the double frame again.
  const outside = css.replace(base, '');
  expectThat(!/(^|\n)\s*:focus-visible\s*\{/.test(outside), 'a :focus-visible rule outside the base layer');
  expectThat(css.indexOf('@layer base') > css.indexOf('@tailwind utilities'), 'setup: the layers come after the @tailwind lines');
  const components = rulesIn(topBlock(css, '@layer components'));
  const rule = (selector) => components.find((r) => r.selector === selector);
  const field = rule('.ui-field');
  expectThat(field, 'no .ui-field in @layer components');
  expectThat(/border: 1px solid var\(--vsc-input-border\)/.test(field.body), `.ui-field's border is not 1px of --vsc-input-border: ${field.body}`);
  expectThat(/background-color: var\(--vsc-input-bg\)/.test(field.body), '.ui-field is not on --vsc-input-bg');
  expectThat(/border-radius: var\(--radius-control\)/.test(field.body), '.ui-field does not round to --radius-control');
  expectThat(!/outline|box-shadow|padding|height|margin/.test(field.body), `.ui-field sets more than its look: ${field.body}`);
  expectThat(/border-color: var\(--vsc-input-border-hover\)/.test(rule('.ui-field:hover')?.body ?? ''), 'a field gets no hover border');
  expectThat(/border-color: var\(--vsc-focus\)/.test(rule('.ui-field:focus-within')?.body ?? ''), 'a focused field does not turn --vsc-focus');
  const invalid = components.filter((r) => r.selector.includes('.ui-field-invalid'));
  expectThat(invalid.length > 0 && invalid.every((r) => /border-color: var\(--vsc-error\)/.test(r.body)), 'an invalid field does not keep --vsc-error');
  for (const state of ['', ':hover', ':focus-within']) {
    expectThat(invalid.some((r) => r.selector.split(',').some((one) => one.trim() === `.ui-field.ui-field-invalid${state}`)), `an invalid field is not red${state ? ` on ${state}` : ' at rest'}`);
  }
  // Focus and hover change a colour, never a size: nothing moves.
  for (const r of components.filter((one) => /:hover|:focus-within/.test(one.selector))) {
    expectThat(r.props.every((prop) => prop === 'border-color'), `${r.selector} sets ${r.props.join(', ')}, not border-color alone`);
  }
  // Forced colours repaint a border colour away: an outline in Highlight.
  const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  expectThat(/\.ui-field:focus-within \{\s*outline: 2px solid Highlight( !important)?;\s*outline-offset: -2px;/.test(forced), 'in forced colours, a focused field shows nothing');
  expectThat((css.match(/@media \(forced-colors: active\)/g) || []).length === 1, 'a second forced-colours block (RN-94 and RN-114 read the first alone)');
});

check('RN-224', 'every text field is a ui-field, red through ui-field-invalid, with no focus class of its own', () => {
  const fields = [
    ['src/components/command/CommandPalette.jsx', 1],
    ['src/components/search/SearchPanel.jsx', 1],
    ['src/components/explorer/FileExplorer.jsx', 1],
    ['src/components/terminal/TerminalFindBar.jsx', 1],
    ['src/components/common/SettingsWindow.jsx', 3],
    ['src/components/command/ProjectCommandDialog.jsx', 2],
    ['src/components/terminal/StartupCommandsDialog.jsx', 1],
    ['src/components/common/KeybindingSettings.jsx', 1],
    ['src/components/terminal/TerminalSplitContainer.jsx', 2],
    ['src/components/terminal/TerminalsPanel.jsx', 1],
    ['src/components/explorer/TreeRow.jsx', 1],
    ['src/components/layout/TitleBar.jsx', 1],
  ];
  const forbidden = /\b(focus:border-\S+|focus-within:border-\S+|focus-visible:outline\S*|focus-visible:ring\S*)/;
  for (const [file, count] of fields) {
    const source = readSource(file);
    const classes = [...source.matchAll(/(['"`])([^'"`\n]*\bui-field\b[^'"`\n]*)\1/g)].map((m) => m[2]).filter((c) => /(^|\s)ui-field(\s|$)/.test(c));
    expectThat(classes.length === count, `${file}: ${classes.length} ui-field class strings, not ${count}`);
    for (const cls of classes) expectThat(!/\bborder-2\b|\bborder-vsc-error\b|\bbg-vsc-input\b|\bborder-vsc-input-border\b/.test(cls), `${file}: a field draws its own border or fill: ${cls}`);
    expectThat(!forbidden.test(source), `${file}: a focus class of its own: ${forbidden.exec(source)?.[0]}`);
  }
  // A refused value: the field keeps the error colour through ui-field-invalid.
  for (const [file, flag] of [
    ['src/components/command/ProjectCommandDialog.jsx', 'error'],
    ['src/components/terminal/StartupCommandsDialog.jsx', 'error'],
    ['src/components/common/KeybindingSettings.jsx', 'refusal'],
    ['src/components/explorer/TreeRow.jsx', 'error'],
  ]) {
    const source = readSource(file);
    expectThat(source.includes(`${flag} && 'ui-field-invalid'`), `${file}: an invalid value is not drawn with ui-field-invalid`);
    expectThat(!/\? 'border-vsc-error' :/.test(source), `${file}: still picks border-vsc-error by hand`);
  }
  // One exception, and only it: the Explorer tree has no ring of its own, so
  // with no row selected it marks the row the keys move from in the ring's
  // colour (K-01, explorer_row_menu RM-06 to RM-10).
  const FOCUS_ROW = "isFocusRow && 'outline outline-1 -outline-offset-1 outline-vsc-focus-ring'";
  const treeRow = readSource('src/components/explorer/TreeRow.jsx');
  expectThat(treeRow.split(FOCUS_ROW).length === 2, "TreeRow's focus row is not one 1px inset outline in --vsc-focus-ring");
  const named = [...sourcesUnder('src/components'), ...sourcesUnder('src/lib')]
    .map(([file, text]) => [file, file === 'src/components/explorer/TreeRow.jsx' ? text.replace(FOCUS_ROW, '') : text])
    .filter(([, text]) => /vsc-focus/.test(text))
    .map(([file]) => file);
  expectThat(named.length === 0, `components still name vsc-focus (a field border is ui-field's, an active mark --vsc-accent, the ring the global rule's): ${named.join(', ')}`);
  // The per-component rings are gone: one ring, the global one.
  for (const file of ['src/components/common/ThemeGallery.jsx', 'src/components/common/ConfirmDialog.jsx', 'src/components/terminal/HiddenStrip.jsx', 'src/components/common/ControlLogDialog.jsx']) {
    expectThat(!forbidden.test(readSource(file)), `${file}: a focus ring of its own: ${forbidden.exec(readSource(file))?.[0]}`);
  }
});

check('RN-225', "'active' is violet and stays apart from focus and attention: pane line, tab marks, activity bar", () => {
  const read = (rel) => readSource(`src/components/${rel}`);
  expectThat(/isActive\s*\?\s*'text-vsc-fg border-vsc-accent'/.test(read('layout/PanelLayout.jsx')), 'the region tab underline is not the accent');
  expectThat(/shadow-\[inset_0_1px_0_0_var\(--vsc-accent\)\]/.test(read('editor/EditorTabs.jsx')), "the editor's active tab line is not the accent");
  expectThat(/absolute left-0 top-0 bottom-0 w-\[2px\] bg-vsc-accent/.test(read('layout/Sidebar.jsx')), "the activity bar's bar is not the accent");
  // Rewritten for sibling C (FC6): the editor pane's always-on ring is gone.
  // Its active line is the terminal's PaneFrame, by the same rule (RN-C6).
  const editorPane = read('editor/EditorPane.jsx');
  expectThat(/<PaneFrame active=\{showActiveLine\} \/>/.test(editorPane), "the editor pane's active line is not PaneFrame's");
  expectThat(!/ring-vsc-accent/.test(editorPane) && !/ring-vsc-accent/.test(read('editor/EditorPanel.jsx')), 'an editor pane still draws a ring of its own');
  expectThat(/showActiveLine=\{isActivePane && Boolean\(zoom\?\.canZoom\) && !zoomed\}/.test(read('terminal/TerminalSplitContainer.jsx')), "the editor pane's line is not on the terminal's condition");
  // One drop indicator for both kinds: named zones, the accent border.
  expectThat(/'border-2 border-vsc-accent rounded-sm'/.test(read('terminal/TerminalSplitContainer.jsx')), 'the drop indicator is not bordered in the accent');
  expectThat(!/function DropIndicator/.test(editorPane + read('editor/EditorPanel.jsx') + read('editor/EditorTabs.jsx')), 'the editor still draws a drop indicator of its own');
  const indicators = read('terminal/AttentionIndicators.jsx');
  expectThat(/'inset-0 ring-1 ring-inset ring-vsc-accent'/.test(indicators), "the terminal's active pane line is not the accent");
  // Attention: orange, 2px, one pixel inside the active line, as before.
  expectThat((indicators.match(/'inset-px ring-2 ring-inset ring-vsc-attention animate-attention-(pulse|flash)'/g) || []).length === 2, 'the attention ring is no longer 2px of --vsc-attention one pixel in');
  expectThat(/chosen \? 'border-vsc-accent'/.test(read('common/ThemeGallery.jsx')), 'the chosen theme card has no accent border');
});

/** The :root value of a custom property by its full name, or null. */
const rootTokenOf = (css, name) => new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim() ?? null;
check('RN-226', 'the simple look, and only it: two corner tokens, popovers rounded with inset rows, one shadow, edged secondary buttons', () => {
  const css = readSource('src/styles/index.css');
  const tailwind = readSource('tailwind.config.js');
  expectThat(rootTokenOf(css, '--radius-control') === '4px' && rootTokenOf(css, '--radius-popover') === '8px', 'the corner tokens are not 4px and 8px');
  expectThat(/control: 'var\(--radius-control\)'/.test(tailwind) && /popover: 'var\(--radius-popover\)'/.test(tailwind), 'tailwind has no rounded-control or rounded-popover');
  expectThat(/widget: '0 8px 24px -6px var\(--vsc-shadow\)'/.test(tailwind), 'shadow-widget is not the one elevation');
  expectThat(rootToken(css, 'shadow') === 'rgba(0, 0, 0, 0.5)', `--vsc-shadow is ${rootToken(css, 'shadow')}`);
  const components = sourcesUnder('src/components');
  /**
   * The class string around each use of a class, as [file, string, what comes
   * before it]: the run of text with no quote in it, so an apostrophe in a
   * comment cannot pair the quotes wrongly.
   */
  const around = (pattern) =>
    components.flatMap(([file, text]) =>
      [...text.matchAll(new RegExp(`[^'"\`]*${pattern}[^'"\`]*`, 'g'))].map((m) => [file, m[0], text.slice(Math.max(0, m.index - 20), m.index)])
    );
  const arbitrary = around('\\brounded-(\\[\\d+px\\]|md\\b)');
  expectThat(arbitrary.length === 0, `corners outside the tokens: ${arbitrary.map(([file, cls]) => `${file}: ${cls}`).join(' | ')}`);
  const shadowed = around('\\bshadow-widget\\b');
  expectThat(shadowed.length >= 12, `setup: only ${shadowed.length} popovers found`);
  for (const [file, cls] of shadowed) expectThat(/\brounded-popover\b/.test(cls), `${file}: a shadow without the popover corner: ${cls}`);
  // Menus and the palette: inset rows at the same 22px.
  const menu = readSource('src/components/common/ContextMenu.jsx');
  const bar = readSource('src/components/layout/MenuBar.jsx');
  const palette = readSource('src/components/command/CommandPalette.jsx');
  expectThat(/className="z-\[70\] min-w-\[220px\] p-1 rounded-popover /.test(menu), 'the context menu is not p-1 rounded-popover');
  expectThat(/'flex items-center gap-2 h-\[22px\] px-3 rounded-control text-ui select-none'/.test(menu), "the context menu's rows are not inset at 22px");
  expectThat(/const popupClass =\s*'p-1 rounded-popover /.test(bar), 'the menu-bar popups are not p-1 rounded-popover');
  expectThat(/'flex items-center gap-2 h-\[22px\] px-3 rounded-control text-ui select-none cursor-pointer'/.test(bar), "the menu bar's rows are not inset at 22px");
  expectThat(/<div className="max-h-\[400px\] overflow-auto p-1">/.test(palette), "the palette's list is not p-1");
  expectThat(/'h-\[22px\] px-2 rounded-control flex items-center gap-2 text-ui cursor-pointer'/.test(palette), "the palette's rows are not inset at 22px");
  // A secondary button is the field colour on a dialog only 1.12:1 lighter: it needs an edge.
  for (const [file, cls, before] of around('\\bbg-vsc-button-secondary\\b')) {
    if (/<kbd\s+className=["'`]?$/.test(before)) continue; // a key cap, not a button
    expectThat(/\bborder-vsc-(input-border|border)\b/.test(cls), `${file}: a secondary button without an edge: ${cls}`);
    if (/\bborder-vsc-input-border\b/.test(cls)) expectThat(/(^|\s)border(\s|$)/.test(cls), `${file}: an edge colour with no border: ${cls}`);
  }
  // Native checkboxes and selected text in violet.
  expectThat(around('\\baccent-current\\b').length === 0, 'a checkbox is still drawn in the text colour');
  for (const file of ['src/components/common/SettingsWindow.jsx', 'src/components/command/ProjectCommandDialog.jsx']) expectThat(/accent-vsc-accent/.test(readSource(file)), `${file}: the checkbox is not violet`);
  expectThat(/::selection \{\s*background: var\(--vsc-accent-solid\);\s*color: var\(--vsc-accent-fg\);\s*\}/.test(css), 'selected text is not the solid violet');
  // Motion: no new keyframes but the toasts' two opacity fades (U6, RN-239),
  // and every transition is a colour, 150ms or less (the maximize one went
  // with Maximize Panel, sibling C).
  const frames = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]).sort();
  expectThat(JSON.stringify(frames) === JSON.stringify(['attention-flash', 'attention-pulse', 'overlay-fade-in', 'panel-fade-in', 'panel-fade-out', 'progress-slide', 'toast-fade-in', 'toast-fade-out']), `the keyframes changed: ${frames}`);
  for (const [, value] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[\s;{])transition:\s*([^;]+);/g)) {
    for (const part of value.split(',')) {
      const [prop, time] = part.trim().split(/\s+/);
      expectThat(/^(background-color|border-color|outline-color|color)$/.test(prop) && parseInt(time, 10) <= 150 && /ms$/.test(time), `a transition that is not a colour of 150ms or less: ${part.trim()}`);
    }
  }
});

check('RN-227', 'at 960px and wider the title bar does not overlap and the status bar keeps the bell', () => {
  const bar = readSource('src/components/layout/TitleBar.jsx');
  expectThat(/isMac \? "pl-\[78px\] pr-3" : "pl-2"/.test(bar), "setup: the title bar's padding changed; the cap below is worked out from it");
  const pill = /<button\b[^>]*onClick=\{\(\) => setCommandPaletteOpen\(true\)\}[^>]*className="([^"]*)"/.exec(bar)?.[1] ?? '';
  const share = Number(/\bw-\[(\d+)%\]/.exec(pill)?.[1]);
  const least = Number(/\bmin-w-\[(\d+)px\]/.exec(pill)?.[1]);
  const most = Number(/\bmax-w-\[(\d+)px\]/.exec(pill)?.[1]);
  expectThat(share === 38 && least === 180 && most === 600, `the pill is not clamp(180px, 38%, 600px): ${pill}`);
  expectThat(/\bui-field\b/.test(pill) && /\bpx-2\b/.test(pill), `the pill is not a field with room for its ellipsis: ${pill}`);
  expectThat(/<span className="min-w-0 truncate">Search NexTerm/.test(bar), "the pill's label does not truncate");
  expectThat(/<Search size=\{14\} className="shrink-0" \/>/.test(bar), "the pill's icon gives way to the label");
  expectThat(/<span className="min-w-0 text-vsc-muted truncate" title=\{rootPath\}>\{workspaceName\}<\/span>/.test(bar), 'the workspace name does not truncate with its path in the tooltip');
  expectThat(/data-tauri-drag-region/.test(bar) && /absolute inset-0 flex items-center justify-center pointer-events-none/.test(bar), 'the bare title bar no longer drags the window');
  const cluster = /'relative z-10 flex items-center gap-2 min-w-0',\s*isMac\s*\?\s*'max-w-\[([^\]]+)\]'\s*:\s*'max-w-\[([^\]]+)\]'/.exec(bar);
  expectThat(cluster, 'the left cluster is not min-w-0 with a cap per platform');
  /** A Tailwind calc() in px and % of `base`, worked out. */
  const evaluate = (value, base) => {
    const expr = value.replace(/_/g, ' ').replace(/calc\(/g, '(').replace(/(\d+(?:\.\d+)?)%/g, `($1*${base}/100)`).replace(/(\d+(?:\.\d+)?)px/g, '$1');
    return Function('clamp', `return ${expr};`)((lo, v, hi) => Math.min(Math.max(lo, v), hi));
  };
  for (const [platform, cap, left, right] of [['macOS', cluster[1], 78, 12], ['Windows and Linux', cluster[2], 8, 0]]) {
    for (const width of [960, 1024, 1280, 1440, 1600, 1920, 2560, 3840]) {
      const content = width - left - right;
      const pillWidth = Math.min(Math.max(least, (share / 100) * width), most);
      const pillLeft = width / 2 - pillWidth / 2;
      const clusterRight = left + evaluate(cap, content);
      expectThat(pillLeft - clusterRight >= 8 - 1e-9, `${platform} at ${width}px: the left cluster can come ${(pillLeft - clusterRight).toFixed(1)}px from the pill`);
      expectThat(pillLeft - clusterRight <= 8.5, `${platform} at ${width}px: the cap leaves ${(pillLeft - clusterRight).toFixed(1)}px unused`);
    }
  }

  const status = readSource('src/components/layout/StatusBar.jsx');
  expectThat(/const SHRINKS = new Set\(\['workspace', 'cwd'\]\);/.test(status), 'the folder and cwd items are not the ones that give way');
  expectThat(/SHRINKS\.has\(item\.id\) \? 'min-w-0' : 'shrink-0'/.test(status), 'the folder and cwd items do not shrink');
  expectThat(/<span className="truncate">\{item\.text\}<\/span>/.test(status), "an item's text does not truncate");
  expectThat(/<div className="flex-1 min-w-0 flex items-center h-full overflow-hidden">\s*\{left\.map/.test(status), 'the left group is not flex-1 min-w-0');
  expectThat(/<div className="shrink-0 flex items-center h-full">\s*\{right\.map\(\(it\) => \(\s*<StatusItem key=\{it\.id\} item=\{it\} \/>\s*\)\)\}\s*<NotificationCenter \/>/.test(status), 'the right group, with the bell, can shrink');
  expectThat(/className="h-statusbar shrink-0 flex items-center justify-between [^"]*overflow-hidden"/.test(status) && !/flex-wrap/.test(status), 'the status bar can wrap or grow');
});

check('RN-228', 'every separator: a 1px line, violet on hover and drag (two rules) across a 10px hit area, a keyboard ring; pixel minimums for the editor and the bottom panel', () => {
  const css = readSource('src/styles/index.css');
  const rules = rulesIn(css.slice(css.indexOf('[data-separator] {'), css.indexOf('/* ------', css.indexOf('[data-separator] {'))));
  const rule = (selector) => rules.find((r) => r.selector.replace(/\s+/g, ' ') === selector);
  expectThat(/background: var\(--vsc-border\)/.test(rule('[data-separator]')?.body ?? ''), 'a separator is not a line in --vsc-border');
  // Hover (the pointer on the line, or anywhere in the hit area) and a drag
  // are two rules since U2: hover waits, a drag does not (RN-235).
  expectThat(/background: var\(--vsc-accent\)/.test(rule('[data-separator]:hover, [data-separator="hover"]')?.body ?? ''), 'a separator does not turn violet on hover, across its hit area');
  expectThat(/background: var\(--vsc-accent\)/.test(rule('[data-separator="active"]')?.body ?? ''), 'a separator does not turn violet while dragged');
  const focus = rule('[data-separator]:focus-visible')?.body ?? '';
  expectThat(/background: var\(--vsc-focus-ring\)/.test(focus) && /outline: 1px solid var\(--vsc-focus-ring\)/.test(focus) && /outline-offset: 0/.test(focus), `a focused separator shows no 3px ring line: ${focus}`);
  expectThat(rule('[data-separator]:focus-visible')?.props.join(',') === 'background,outline,outline-offset', `the keyboard ring rule changed: ${focus}`);
  expectThat(!/\[data-state/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'a v3 data-state selector, which v4 never sets');
  // Every separator in the app is the 1px element the rule draws.
  const separators = [...sourcesUnder('src/components')].flatMap(([file, text]) => [...text.matchAll(/<Separator\b([^>]*)\/>/g)].map((m) => [file, m[1]]));
  // Three (sibling C): the two of the side bars and the workbench's own. The
  // editor area's split and the editor|panel one went with the centre area.
  expectThat(separators.length === 3, `setup: ${separators.length} separators`);
  for (const [file, attrs] of separators) expectThat(/className=(\{direction === 'horizontal' \? 'w-px' : 'h-px'\}|"w-px"|"h-px")/.test(attrs), `${file}: a separator that is not 1px: ${attrs}`);
  // The hit area is the library's: 10px for a mouse, centred, unless a Group says otherwise.
  // What the package's own types say is read there; what only its build says
  // is read from the minified build, which a patch or a new minifier can
  // reword with nothing changed. A miss there is the library's, not NexTerm's.
  const types = readFileSync(new URL('../../node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts', import.meta.url), 'utf8');
  const library = readFileSync(new URL('../../node_modules/react-resizable-panels/dist/react-resizable-panels.js', import.meta.url), 'utf8');
  const H8 = 'react-resizable-panels changed (this reads its minified build, so the wording may have moved with nothing else): an update needs its hit area and separator states re-verified by hand (H8); NexTerm\u{2019}s own behaviour did not change';
  const fine = Number(/resizeTargetMinimumSize: \w+ = \{\s*coarse: \d+,\s*fine: (\d+)\s*\}/.exec(library)?.[1]);
  expectThat(fine >= 8, Number.isNaN(fine) ? `the default hit area for a mouse was not found: ${H8}` : `the default hit area for a mouse is ${fine}px, under 8: ${H8}`);
  expectThat(/g\.x - L \/ 2/.test(library) && /g\.y - L \/ 2/.test(library), `the hit area was not found centred on the line: ${H8}`);
  expectThat(/Use the `data-separator` attribute for custom _hover_ and _active_ styles/.test(types), 'the package\u{2019}s types no longer say data-separator carries the hover and active states');
  expectThat(/Q\("inactive"\)/.test(library) && /state: "hover"/.test(library), `the separator states behind data-separator ("hover" across the hit area, "inactive" at rest) were not found: ${H8}`);
  expectThat(/declare type BaseSeparatorAttributes = Omit<HTMLAttributes<HTMLDivElement>, "role" \| "tabIndex">/.test(types) && /Separators are not _required_ but they are _recommended_ as they improve keyboard accessibility/.test(types), 'the package\u{2019}s types no longer say a separator is reached by the keyboard, with its tabIndex its own');
  const overrides = [...sourcesUnder('src')].filter(([file, text]) => /\.jsx?$/.test(file) && /resizeTargetMinimumSize/.test(text));
  expectThat(overrides.length === 0, `a Group overrides the hit area: ${overrides.map(([file]) => file).join(', ')}`);

  const layout = readSource('src/components/layout/PanelLayout.jsx');
  const settings = readSource('src/stores/settingsStore.js');
  const row = Number(/terminalFontSize: (\d+),/.exec(settings)?.[1]) * Number(/terminalLineHeight: ([\d.]+),/.exec(settings)?.[1]);
  // Rewritten for sibling C (FC4, FC7): the editor-group Panel and its 112px
  // minimum went with the centre area, and Maximize Panel with it. An editor
  // pane's minimum is now the workbench's: PANE_MIN_PX, which ResizableSplit
  // turns into each Panel's share.
  const css2 = readSource('src/styles/index.css');
  const layoutCode = layout.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  expectThat(!/editor-group/.test(layoutCode) && !/aximize/.test(layoutCode), 'PanelLayout still has an editor-group or a Maximize Panel');
  expectThat(!/panel-maximize-transition/.test(layout + css2), 'the maximize transition is still there');
  const bottomMin = Number(/id="bottom-panel"\s*defaultSize="40"\s*minSize=\{(\d+)\}/.exec(layout)?.[1]);
  // The bottom panel: its 35px header, the 28px pane strip and three terminal rows.
  expectThat(bottomMin >= 35 + 28 + 3 * row, `the bottom panel's minimum is ${bottomMin}px (a row is ${row}px)`);
  // It fits in the 640px window, under the title and status bars.
  expectThat(bottomMin <= 640 - 35 - 22, 'the bottom panel minimum does not fit the smallest window');
  expectThat(/id="primary-sidebar"\s*defaultSize=\{260\}\s*minSize=\{170\}/.test(layout), 'the left side bar is no longer 260px, at least 170px');
  expectThat(/id="secondary-sidebar"\s*defaultSize=\{320\}\s*minSize=\{220\}/.test(layout), 'the right side bar is no longer 320px, at least 220px');
  const split = readSource('src/components/terminal/TerminalSplitContainer.jsx');
  const panes = readSource('src/components/terminal/splitLayout.js');
  expectThat(/terminal: Object\.freeze\(\{ width: 120, height: 88 \}\)/.test(panes) && /editor: Object\.freeze\(\{ width: 160, height: 96 \}\)/.test(panes), 'the documented pane minimums changed');
  expectThat(/const pixelShares = lengthPx \? minSharesOf\(node, lengthPx\) : null;/.test(split) && /minSize=\{minSizeOf\(i\)\}/.test(split), 'ResizableSplit does not derive its Panel minimums from PANE_MIN_PX');
  expectThat(/Math\.min\(equalBound, pixelShares\[i\]\)/.test(split), 'a pixel minimum can exceed the equal-share bound');
});

// ---- A program's title for its terminal (set-title, A10b) ----------------------
//
// Who wins a terminal's label (`displayTitle`, src/lib/tabTitle.js): the
// user's own name, then the title a program set, then the default name — on
// the chip, the TERMINALS row and the hidden strip's handle alike.

/** Three terminals: one a program titled, one the user named (a program titled it too), one plain. */
function arrangeProgramTitles() {
  reset();
  useTerminalStore.setState({
    tabs: [
      tab('pt-1', { title: 'Terminal 1', defaultTitle: 'Terminal 1', programTitle: 'vim notes.md', programTitleAt: 1 }),
      tab('pt-2', { title: 'build', defaultTitle: 'Terminal 2', programTitle: 'npm test', programTitleAt: 1 }),
      tab('pt-3', { title: 'Terminal 3', defaultTitle: 'Terminal 3' }),
    ],
    activeTabId: 'pt-1',
    groups: baseGroups(['pt-1', 'pt-2', 'pt-3']),
    activeGroupId: 'group-1',
  });
}

/** The text a chip or row draws as its name: its first `truncate` span. */
const nameIn = (markup) => visibleText(/<span class="[^"]*\btruncate\b[^"]*">([^<]*)<\/span>/.exec(markup ?? '')?.[1] ?? '');

scenario(
  'RN-231',
  "a program's title names an unnamed terminal on its chip and its TERMINALS row; a name the user gave wins over it; a plain one keeps its default",
  arrangeProgramTitles,
  (html) => {
    for (const [id, want, not] of [
      ['pt-1', 'vim notes.md', 'Terminal 1'],
      ['pt-2', 'build', 'npm test'],
      ['pt-3', 'Terminal 3', null],
    ]) {
      const chip = tabChip(html, id);
      expectThat(chip, `no chip for ${id}`);
      expectThat(nameIn(chip) === want, `the chip of ${id} says ${JSON.stringify(nameIn(chip))}, not ${JSON.stringify(want)}`);
      const tip = attrOf(openingTag(chip), 'title') ?? '';
      expectThat(tip.startsWith(`${want} — `), `the chip's tooltip of ${id} does not start with its label: ${JSON.stringify(tip)}`);
      expectThat(attrOf(chip.match(/<button\b[^>]*aria-label="Close [^"]*"[^>]*>/)?.[0], 'aria-label') === `Close ${want}`, `the ✕ of ${id} does not name ${want}`);
      const row = terminalRow(html, id);
      expectThat(row, `no TERMINALS row for ${id}`);
      expectThat(nameIn(row) === want, `the TERMINALS row of ${id} says ${JSON.stringify(nameIn(row))}, not ${JSON.stringify(want)}`);
      if (not) expectThat(!chip.includes(`>${not}<`) && !row.includes(`>${not}<`), `${id} still draws ${JSON.stringify(not)}`);
    }
  }
);

scenario(
  'RN-232',
  "the hidden strip's handle names its terminal by the same rule: the program's title, or the user's name over it",
  () => {
    arrangeHidden({ extra: { tabs: [tab('t1', { title: 'Terminal 1', defaultTitle: 'Terminal 1', programTitle: 'vim notes.md', programTitleAt: 1 })] } });
  },
  (html) => {
    const words = attrOf(openingTag(handleOf(paneMarkup(html, 'pane-1'))), 'aria-label') ?? '';
    expectThat(words === 'vim notes.md. Show its tab strip', `the handle's words: ${JSON.stringify(words)}`);
    // The same terminal, renamed: the user's name, whatever the program said.
    arrangeHidden({ extra: { tabs: [tab('t1', { title: 'mine', defaultTitle: 'Terminal 1', programTitle: 'vim notes.md', programTitleAt: 1 })] } });
    const named = attrOf(openingTag(handleOf(paneMarkup(renderArranged(), 'pane-1'))), 'aria-label') ?? '';
    expectThat(named === 'mine. Show its tab strip', `the renamed handle's words: ${JSON.stringify(named)}`);
  }
);

/** The Ctrl+Tab switcher's overlay, or '' when none is drawn. */
function tabSwitcherIn(html) {
  const at = html.indexOf('data-tab-switcher=""');
  if (at < 0) return '';
  const start = html.lastIndexOf('<div', at);
  const end = html.indexOf('</div></div>', at);
  return end < 0 ? html.slice(start) : html.slice(start, end + '</div></div>'.length);
}
/** Its rows, in order: the tab id, whether marked selected, and the words drawn. */
function tabSwitcherRows(markup) {
  return [...markup.matchAll(/<div\b[^>]*data-tab-switcher-row="([^"]+)"[^>]*>([\s\S]*?)(?=<div\b[^>]*data-tab-switcher-row=|<\/div><\/div>$)/g)].map((m) => {
    const tag = m[0].match(/^<div\b[^>]*>/)[0];
    const words = (sel) => m[2].match(new RegExp(`<span[^>]*${sel}[^>]*>([^<]*)</span>`))?.[1] ?? null;
    return {
      tabId: m[1],
      selected: attrOf(tag, 'aria-selected'),
      role: attrOf(tag, 'role'),
      id: attrOf(tag, 'id'),
      title: words('data-tab-switcher-title'),
      group: words('data-tab-switcher-group'),
      folder: words('data-tab-switcher-folder'),
    };
  });
}

scenario(
  'RN-233',
  'the Ctrl+Tab switcher: a listbox of every group\u{2019}s terminals, most recent first, the selected row marked, each with its name, group and folder',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        tab('t1', { title: 'Terminal 1', defaultTitle: 'Terminal 1', cwd: '/home/me/api' }),
        tab('t2', { title: 'build', defaultTitle: 'Terminal 2', cwd: 'C:\\work\\web' }),
        tab('t3', { title: 'Terminal 3', defaultTitle: 'Terminal 3', cwd: '/srv/logs/' }),
      ],
      activeTabId: 't1',
      activeGroupId: 'group-1',
      groups: [
        { id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-1', tree: { type: 'leaf', id: 'pane-1', tabIds: ['t1', 't2'], activeTabId: 't1' } },
        { id: 'group-2', name: 'Servers', createdAt: 0, activePaneId: 'pane-2', tree: { type: 'leaf', id: 'pane-2', tabIds: ['t3'], activeTabId: 't3' } },
      ],
    });
    useTabSwitcherStore.setState({ open: true, items: ['t1', 't3', 't2'], selectedIndex: 1, modifiers: { ctrl: true, alt: false, meta: false, shift: false } });
  },
  (html) => {
    const overlay = tabSwitcherIn(html);
    expectThat(overlay, 'no switcher drawn while it is open');
    const listbox = overlay.match(/<div\b[^>]*role="listbox"[^>]*>/)?.[0];
    expectThat(listbox, 'the switcher is no listbox');
    expectThat(attrOf(listbox, 'aria-label') === 'Recent terminals', `the listbox is called ${JSON.stringify(attrOf(listbox, 'aria-label'))}`);
    const rows = tabSwitcherRows(overlay);
    expectThat(rows.map((r) => r.tabId).join() === 't1,t3,t2', `the rows, in order: ${rows.map((r) => r.tabId).join()}`);
    expectThat(rows.every((r) => r.role === 'option'), 'a row is not an option');
    expectThat(rows.map((r) => r.selected).join() === 'false,true,false', `the selected marks: ${rows.map((r) => r.selected).join()}`);
    expectThat(attrOf(listbox, 'aria-activedescendant') === rows[1].id && rows[1].id, `aria-activedescendant ${JSON.stringify(attrOf(listbox, 'aria-activedescendant'))} is not the selected row ${JSON.stringify(rows[1].id)}`);
    const drawn = rows.map((r) => [r.title, r.group, r.folder].join('|')).join(' / ');
    expectThat(drawn === 'Terminal 1|Group 1|api / Terminal 3|Servers|logs / build|Group 1|web', `the rows say ${JSON.stringify(drawn)}`);
    // The theme's colours only, and nothing that moves (reduce motion).
    const classes = [...overlay.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    const colours = classes.filter((c) => /^(bg|text|border|shadow)-/.test(c) && !/^text-ui(-sm)?$/.test(c) && !/^shadow-widget$/.test(c));
    const notTheme = colours.filter((c) => !/^(bg|text|border)-vsc-/.test(c));
    expectThat(notTheme.length === 0, `colours that are not the theme's: ${notTheme.join(' ')}`);
    const moving = classes.filter((c) => /^(transition|animate|duration)/.test(c));
    expectThat(moving.length === 0, `classes that animate: ${moving.join(' ')}`);
    // Closed: nothing drawn, whatever list it last held.
    useTabSwitcherStore.setState({ open: false });
    expectThat(!tabSwitcherIn(renderArranged()), 'the switcher is drawn while closed');
  }
);

// ---- The style guide: STYLEGUIDE.md against the stylesheet ---------------------
//
// STYLEGUIDE.md is written by hand, so it can drift from index.css. This reads
// both as text (raw, so the CRLF handling is this check's own) and lists what
// no longer matches. RN-234 runs it on the checkout, on CRLF copies of all
// three files, and on broken copies it must catch.

const STYLEGUIDE_SECTIONS = [
  'Palette and tokens', 'Accent', 'Focus', 'Radii', 'Elevation', 'Motion and reduced motion',
  'Density and sizes', 'Copy', 'In-flight feedback', 'Recorded decisions',
];
/** The tokens the guide must name, each also declared in index.css's :root. */
const STYLEGUIDE_KEY_TOKENS = [
  'accent', 'accent-solid', 'accent-text', 'focus', 'focus-ring', 'attention', 'error', 'warn', 'ok', 'info',
  'border', 'widget-border', 'widget-bg', 'editor-bg', 'terminal-bg', 'input-bg', 'radius-control', 'radius-popover',
].map((name) => (name.startsWith('radius-') ? `--${name}` : `--vsc-${name}`));
/** [what is checked, how a decision's bold title names it]. */
const STYLEGUIDE_DECISIONS = [
  ['Q-C1', /\bQ-C1\b/],
  ['F8', /\bF8\b/],
  ['git read-only', /\bgit read-only\b/i],
  ['dark only', /\bdark only\b/i],
  ['a closed tab keeps nothing on disk', /\ba closed tab keeps nothing on disk\b/i],
];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The body of a markdown `## <title>` section (to the next `## ` or the end), or null. */
function markdownSection(markdown, title) {
  const start = new RegExp(`^## ${escapeRegExp(title)}[ \\t]*$`, 'im').exec(markdown);
  if (!start) return null;
  const rest = markdown.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
/** A real calendar date written YYYY-MM-DD, or null. */
function isoDateIn(text) {
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (date.toISOString().slice(0, 10) === m[0]) return m[0];
  }
  return null;
}

/** Every way STYLEGUIDE.md (`guide`) disagrees with index.css (`css`) and README.md (`readme`). */
function styleguideDrift({ guide: rawGuide, css: rawCss, readme: rawReadme }) {
  const guide = rawGuide.replace(/\r\n/g, '\n');
  const css = rawCss.replace(/\r\n/g, '\n');
  const readme = rawReadme.replace(/\r\n/g, '\n');
  const problems = [];

  // The sections, as `## ` headings.
  const headings = [...guide.matchAll(/^## (.+?)[ \t]*$/gm)].map((m) => m[1].toLowerCase());
  for (const title of STYLEGUIDE_SECTIONS) {
    if (!headings.includes(title.toLowerCase())) problems.push(`no "## ${title}" heading`);
  }
  const feedback = markdownSection(guide, 'In-flight feedback') ?? '';
  for (const [label, pattern] of [['100 ms', /\b100\s?ms\b/], ['1 s', /\b1\s?s\b/], ['3 s', /\b3\s?s\b/]]) {
    if (!pattern.test(feedback)) problems.push(`In-flight feedback does not name ${label}`);
  }

  // The tokens: index.css's :root block, the one at the start of a line.
  const root = /^:root\s*\{([\s\S]*?)^\}/m.exec(css)?.[1] ?? '';
  if (!root) problems.push('index.css has no :root block');
  const declared = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const token of STYLEGUIDE_KEY_TOKENS) {
    if (!declared.has(token)) problems.push(`${token} is not declared in index.css :root`);
    if (!new RegExp(`${escapeRegExp(token)}(?![\\w-])`).test(guide)) problems.push(`STYLEGUIDE.md does not name ${token}`);
  }
  // Every token the guide names is real. A name followed by `*` (`--vsc-*`) is a
  // family, and real when :root declares at least one token of it.
  for (const m of guide.matchAll(/--(?:vsc|radius)-[\w-]*(\*?)/g)) {
    const token = m[0].replace(/\*$/, '');
    const real = m[1] ? [...declared].some((d) => d.startsWith(token) && d !== token) : declared.has(token);
    if (!real) problems.push(`STYLEGUIDE.md names ${m[0]}, which index.css :root does not declare`);
  }
  // The corners it states are the ones the stylesheet sets.
  for (const token of ['--radius-control', '--radius-popover']) {
    const stated = new RegExp(`${escapeRegExp(token)}\`?\\s*\\((\\d+px)`).exec(guide)?.[1];
    const actual = new RegExp(`${escapeRegExp(token)}\\s*:\\s*([^;]+);`).exec(root)?.[1]?.trim();
    if (stated !== actual) problems.push(`STYLEGUIDE.md gives ${token} as ${stated}, index.css as ${actual}`);
  }

  // The decisions: one `- **title** ...` entry each, with a date and a reason.
  const decisions = markdownSection(guide, 'Recorded decisions') ?? '';
  const entries = decisions.split(/\n(?=- )/).map((e) => e.trim()).filter((e) => e.startsWith('- '));
  if (entries.length === 0) problems.push('Recorded decisions lists no entry');
  for (const entry of entries) {
    const title = /^- \*\*([\s\S]+?)\*\*/.exec(entry)?.[1]?.replace(/\s+/g, ' ');
    const what = title ?? entry.slice(0, 40);
    if (!title) problems.push(`a decision without a bold title: ${JSON.stringify(what)}`);
    if (!isoDateIn(entry)) problems.push(`the decision "${what}" has no YYYY-MM-DD date`);
    if (!/\bReason:\s+\S+(\s+\S+){2,}/.test(entry)) problems.push(`the decision "${what}" gives no reason`);
  }
  for (const [label, pattern] of STYLEGUIDE_DECISIONS) {
    const hits = entries.filter((e) => pattern.test(/^- \*\*([\s\S]+?)\*\*/.exec(e)?.[1]?.replace(/\s+/g, ' ') ?? ''));
    if (hits.length !== 1) problems.push(`Recorded decisions has ${hits.length} entries titled "${label}", not 1`);
  }

  // README links it from Develop, and index.css's header comment points to it.
  if (!/\]\(\.?\/?STYLEGUIDE\.md\)/.test(markdownSection(readme, 'Develop') ?? '')) {
    problems.push("README.md's Develop section does not link STYLEGUIDE.md");
  }
  const header = /\/\*[\s\S]*?\*\//.exec(css)?.[0] ?? '';
  if (!header.includes('STYLEGUIDE.md')) problems.push("index.css's header comment does not point to STYLEGUIDE.md");
  return problems;
}

check('RN-234', 'STYLEGUIDE.md: its sections, the recorded decisions with dates and reasons, and the tokens it names all match index.css; README links it', () => {
  // Raw, not readSource: the CRLF handling under test is styleguideDrift's own.
  const raw = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
  const texts = { guide: raw('STYLEGUIDE.md'), css: raw('src/styles/index.css'), readme: raw('README.md') };
  const crlf = (text) => text.replace(/\r?\n/g, '\r\n');
  const asCrlf = { guide: crlf(texts.guide), css: crlf(texts.css), readme: crlf(texts.readme) };
  expectThat(asCrlf.guide.includes('\r\n') && !/[^\r]\n/.test(asCrlf.guide), 'the CRLF copy is not CRLF');
  for (const [which, copy] of [['the checkout', texts], ['a CRLF copy', asCrlf]]) {
    const problems = styleguideDrift(copy);
    expectThat(problems.length === 0, `STYLEGUIDE.md drifted (${which}): ${problems.join('; ')}`);
  }

  // And it is not a check that passes anything: each of these breaks must show.
  const lf = (text) => text.replace(/\r\n/g, '\n');
  const broken = (what, change) => {
    const copy = { guide: lf(texts.guide), css: lf(texts.css), readme: lf(texts.readme) };
    change(copy);
    const problems = styleguideDrift(copy);
    expectThat(problems.length > 0, `styleguideDrift misses ${what}`);
  };
  broken('a key token left out of the guide', (c) => { c.guide = c.guide.replace(/--vsc-focus-ring(?![\w-])/g, 'the ring colour'); });
  broken('a key token gone from :root', (c) => { c.css = c.css.replace(/^(\s*)--vsc-warn(\s*):/m, '$1--vsc-caution$2:'); });
  broken('a token the guide names that does not exist', (c) => { c.guide += '\nUse `--vsc-made-up` for this.\n'; });
  broken('a token family the guide names that does not exist', (c) => { c.guide += '\nThe `--vsc-made-up-*` tokens.\n'; });
  broken('a decision without its date', (c) => { c.guide = c.guide.replace(/(\*\*F8\b[\s\S]*?)\(2026-11-18\)/, '$1(November)'); });
  broken('a decision without its reason', (c) => { c.guide = c.guide.replace(/(\*\*Dark only\*\*[\s\S]*?)Reason:/i, '$1Because:'); });
  broken('a missing decision', (c) => { c.guide = c.guide.replace(/\bQ-C1\b/g, 'K-03'); });
  broken('a missing heading', (c) => { c.guide = c.guide.replace(/^## Elevation$/m, '## Shadows'); });
  broken('the in-flight thresholds', (c) => { c.guide = c.guide.replace(/\b3 s\b/g, 'three seconds'); });
  broken('a radius that changed', (c) => { c.css = c.css.replace(/--radius-popover:\s*8px/, '--radius-popover: 6px'); });
  broken('README without the link', (c) => { c.readme = c.readme.replace(/\]\(STYLEGUIDE\.md\)/g, ''); });
  broken('index.css without the pointer', (c) => { c.css = c.css.replace(/STYLEGUIDE\.md/g, 'the guide'); });
});

// ---- Divider hover delay and the press that left it focused (U2) -----------
//
// A divider highlights after a 200 ms hover, at once while dragged, and with
// no transition at all under reduced motion; PanelLayout installs the release
// that blurs a separator the library focused on a press (src/lib/
// separatorFocus.js, DV-1.. in the adversarial suite).

/** The milliseconds of a CSS time (`200ms`, `0.2s`, `0`), or NaN. */
const cssMs = (time) => {
  const m = /^(-?[\d.]+)(ms|s)?$/.exec(String(time).trim());
  if (!m) return Number.NaN;
  if (!m[2]) return Number(m[1]) === 0 ? 0 : Number.NaN;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
};
/** Every time a declaration body gives, in ms, under `transition-delay` and in a `transition` shorthand's second time. */
const delaysIn = (body) => {
  const delays = [];
  for (const [, name, value] of body.matchAll(/(transition(?:-delay)?)\s*:\s*([^;]+)/g)) {
    for (const part of value.replace(/!important/, '').split(',')) {
      const times = part.trim().split(/\s+/).filter((t) => /^-?[\d.]+(ms|s)$/.test(t));
      if (name === 'transition-delay') delays.push(...part.trim().split(/\s+/).map(cssMs));
      else if (times.length > 1) delays.push(cssMs(times[1]));
    }
  }
  return delays;
};
/** The bodies of every `@media (prefers-reduced-motion: reduce)` block in index.css. */
const reducedMotionBlocks = (css) => {
  const blocks = [];
  const head = '@media (prefers-reduced-motion: reduce) {';
  for (let at = css.indexOf(head); at !== -1; at = css.indexOf(head, at + 1)) {
    const end = css.indexOf('\n}\n', at);
    blocks.push(css.slice(at + head.length, end === -1 ? undefined : end));
  }
  return blocks;
};

check('RN-235', 'a divider highlights after a 200 ms hover, at once while dragged, with no transition under either reduced-motion switch; PanelLayout installs the press release once', () => {
  const css = readSource('src/styles/index.css');
  const start = css.indexOf('[data-separator] {');
  expectThat(start !== -1, 'setup: no [data-separator] rule');
  const rules = rulesIn(css.slice(start, css.indexOf('/* ------', start)));
  const rule = (selector) => rules.find((r) => r.selector.replace(/\s+/g, ' ') === selector);

  // At rest: a colour transition and no delay, so leaving a hover goes back at once.
  const rest = rule('[data-separator]')?.body ?? '';
  expectThat(/transition: background-color (\d+)ms ease;/.test(rest), `a separator at rest has no colour transition: ${rest}`);
  expectThat(delaysIn(rest).every((d) => d === 0), `leaving a hover waits: ${rest}`);
  expectThat(Number(/transition: background-color (\d+)ms/.exec(rest)?.[1]) <= 150, `the separator's colour fade is not short: ${rest}`);

  // Hover, on the line or anywhere in the hit area: violet after 200 ms.
  const hover = rule('[data-separator]:hover, [data-separator="hover"]');
  expectThat(hover, 'no rule for [data-separator]:hover, [data-separator="hover"] alone');
  expectThat(/background: var\(--vsc-accent\)/.test(hover.body), `a hovered separator is not violet: ${hover.body}`);
  expectThat(delaysIn(hover.body).length === 1 && delaysIn(hover.body)[0] === 200, `a hovered separator does not wait 200ms: ${hover.body}`);
  // Only the delay: `:hover` outranks `[data-separator="active"]`, so a
  // transition-property or shorthand here would bring the delay back to a
  // drag over the 1px line.
  expectThat(!hover.props.includes('transition') && !hover.props.includes('transition-property'), `the hover rule sets more of the transition than its delay: ${hover.body}`);

  // A drag: violet at once. `transition-property: none` also cancels a hover
  // delay still running when the press comes (the colour does not change
  // between hover and active, so a running transition would otherwise be
  // kept). Not the `transition: none` shorthand: RN-226 allows a shorthand
  // only for a colour of 150ms or less.
  const active = rule('[data-separator="active"]');
  expectThat(active, 'no rule for [data-separator="active"] alone');
  expectThat(/background: var\(--vsc-accent\)/.test(active.body), `a dragged separator is not violet: ${active.body}`);
  expectThat(/transition-property: none;/.test(active.body), `a dragged separator keeps a transition: ${active.body}`);
  expectThat(delaysIn(active.body).every((d) => d === 0), `a dragged separator waits: ${active.body}`);
  // No other separator rule (the ring's included) adds a delay.
  for (const r of rules) {
    if (r === hover) continue;
    expectThat(delaysIn(r.body).every((d) => d === 0), `${r.selector} delays: ${r.body}`);
  }

  // Reduced motion, both switches: no transition, no delay. The cut to
  // 0.01ms on `*` leaves the 200ms delay in place, so it is not enough.
  const none = (body) => /transition-property: none !important;/.test(body) && /transition-delay: 0s !important;/.test(body) && delaysIn(body).every((d) => d === 0);
  const osRules = reducedMotionBlocks(css).flatMap((block) => rulesIn(block));
  expectThat(osRules.some((r) => r.selector === '[data-separator]' && none(r.body)), 'prefers-reduced-motion leaves a separator its transition and delay');
  const settingRules = rulesIn(css.slice(css.indexOf('/* Workbench "Reduced motion" setting')));
  expectThat(settingRules.some((r) => r.selector === ':root.reduce-motion [data-separator]' && none(r.body)), 'the Reduced motion setting leaves a separator its transition and delay');

  // The release: installed once, from one PanelLayout effect, for its life.
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const layout = code(readSource('src/components/layout/PanelLayout.jsx'));
  expectThat(/import \{ installSeparatorFocusRelease \} from '\.\.\/\.\.\/lib\/separatorFocus\.js';/.test(layout), 'PanelLayout does not import the release');
  expectThat((layout.match(/installSeparatorFocusRelease\(/g) ?? []).length === 1, 'PanelLayout does not call the release exactly once');
  expectThat(/useEffect\(\(\) => \{[^{}]*?return installSeparatorFocusRelease\(document\);\s*\}, \[\]\);/.test(layout), 'the release is not installed from a mount-only effect that returns its uninstall');
  const callers = [...sourcesUnder('src')].filter(([file, text]) => /\.jsx?$/.test(file) && !/separatorFocus\.js$/.test(file) && /installSeparatorFocusRelease\(/.test(code(text)));
  expectThat(callers.length === 1 && /PanelLayout\.jsx$/.test(callers[0][0]), `the release is installed elsewhere too: ${callers.map(([file]) => file).join(', ')}`);
  expectThat((code(readSource('src/App.jsx')).match(/<PanelLayout\b/g) ?? []).length === 1, 'the app draws PanelLayout more than once');
});

// ---- The activity mark by shape as well as colour (U4) ----------------------
//
// Running is a filled, pulsing violet dot; failed is lucide's CircleX in the
// error red, the icon StatusBoard draws for a failed command; unread stays
// the UnreadPill (RN-79). Forced colours keep the two apart by shape.

/** The doc block right above `export function ActivityDot`, line ends made `\n` first. */
const activityDotDoc = (source) => {
  const text = source.replace(/\r\n/g, '\n');
  const end = text.indexOf('\n */\nexport function ActivityDot(');
  const start = text.lastIndexOf('/**', end);
  return end === -1 || start === -1 ? null : text.slice(start, end + 4);
};

scenario(
  'RN-236',
  'a failed command is a circled cross on its tab, its group chip and its side bar row, a running one the pulsing violet dot; forced colours keep both; the doc says violet',
  () => {
    reset();
    useTerminalStore.setState({
      tabs: [
        tab('t1', { title: 'build', running: true }),
        tab('t2', { title: 'tests', lastExitCode: 2 }),
        tab('t3', { title: 'shell' }),
        tab('t4', { title: 'lint', lastExitCode: 1 }),
        tab('t5', { title: 'serve', running: true }),
      ],
      activeTabId: 't1',
      groups: [
        // Running and failed in one group: the chip says running.
        { ...baseGroups([])[0], tree: { type: 'leaf', id: 'pane-1', tabIds: ['t1', 't2', 't3'], activeTabId: 't1' } },
        { id: 'group-2', name: 'Failing', createdAt: 0, tree: { type: 'leaf', id: 'pane-2', tabIds: ['t4'], activeTabId: 't4' }, activePaneId: 'pane-2' },
        { id: 'group-3', name: 'Busy', createdAt: 0, tree: { type: 'leaf', id: 'pane-3', tabIds: ['t5'], activeTabId: 't5' }, activePaneId: 'pane-3' },
      ],
    });
  },
  (html) => {
    const marksIn = (markup) => [...(markup ?? '').matchAll(/<[a-z]+\b[^>]*\sdata-activity="[^"]*"[^>]*>/g)].map((m) => ({ tag: m[0], at: m.index }));

    // Failed: an SVG, the CircleX, red, hidden from a screen reader, and no
    // coloured dot anywhere in the chip or row.
    for (const [where, markup, passed] of [
      ['the tab chip "tests"', tabChip(html, 't2'), 'mr-1.5'],
      ['the chip of the group "Failing"', groupChip(html, 'group-2'), null],
      ['the side bar row "tests"', sideRow(html, 'tests'), null],
    ]) {
      expectThat(markup, `${where} is not drawn`);
      const marks = marksIn(markup);
      expectThat(marks.length === 1, `${where} has ${marks.length} activity marks: ${marks.map((m) => m.tag).join(' ')}`);
      const { tag, at } = marks[0];
      expectThat(tag.startsWith('<svg'), `${where}'s failed mark is not an icon: ${tag}`);
      expectThat(attrOf(tag, 'data-activity') === 'failed', `${where}'s mark is not the failed one: ${tag}`);
      expectThat(iconOf(tag) === 'circle-x', `${where}'s failed mark is not lucide's CircleX: ${tag}`);
      expectThat(classOf(tag).split(/\s+/).includes('text-vsc-error'), `${where}'s cross is not in the error red: ${tag}`);
      expectThat(attrOf(tag, 'aria-hidden') === 'true', `${where}'s cross is read out: ${tag}`);
      expectThat(attrOf(tag, 'width') === '10' && attrOf(tag, 'height') === '10', `${where}'s cross is not 10px: ${tag}`);
      expectThat(!/\bbg-vsc-error\b/.test(markup), `${where} still draws a red dot`);
      expectThat(!/\brounded-full\b/.test(tag), `${where}'s cross is a dot: ${tag}`);
      // In a box of the dot's 6px, the caller's classes on it, so the title
      // beside it does not move when a running command fails.
      const box = /<span\b[^>]*>$/.exec(markup.slice(0, at))?.[0] ?? '';
      const boxCls = classOf(box).split(/\s+/);
      for (const c of ['w-[6px]', 'h-[6px]', 'shrink-0', 'flex', 'items-center', 'justify-center']) {
        expectThat(boxCls.includes(c), `${where}'s cross is not in a 6px box (${c}): ${box || '(none)'}`);
      }
      expectThat(attrOf(box, 'aria-hidden') === 'true', `${where}'s box is read out: ${box}`);
      if (passed) expectThat(boxCls.includes(passed), `${where}'s ${passed} is not passed on to the box: ${box}`);
    }

    // Running: the filled, pulsing violet dot, as before.
    for (const [where, markup, passed] of [
      ['the tab chip "build"', tabChip(html, 't1'), 'mr-1.5'],
      ['the chip of the group "Busy"', groupChip(html, 'group-3'), null],
      ['the chip of the group "Group 1" (running and failed)', groupChip(html, 'group-1'), null],
      ['the side bar row "build"', sideRow(html, 'build'), null],
    ]) {
      expectThat(markup, `${where} is not drawn`);
      const marks = marksIn(markup);
      expectThat(marks.length === 1, `${where} has ${marks.length} activity marks: ${marks.map((m) => m.tag).join(' ')}`);
      const { tag } = marks[0];
      expectThat(tag.startsWith('<span'), `${where}'s running mark is not the dot: ${tag}`);
      expectThat(attrOf(tag, 'data-activity') === 'running', `${where}'s mark is not the running one: ${tag}`);
      const cls = classOf(tag).split(/\s+/);
      for (const c of ['bg-vsc-accent', 'animate-pulse', 'rounded-full', 'w-[6px]', 'h-[6px]']) {
        expectThat(cls.includes(c), `${where}'s running dot has no ${c}: ${tag}`);
      }
      expectThat(attrOf(tag, 'aria-hidden') === 'true', `${where}'s dot is read out: ${tag}`);
      if (passed) expectThat(cls.includes(passed), `${where}'s ${passed} is not passed on to the dot: ${tag}`);
    }
    for (const [where, markup] of [['the tab chip "shell"', tabChip(html, 't3')], ['the side bar row "shell"', sideRow(html, 'shell')]]) {
      expectThat(markup && marksIn(markup).length === 0, `${where} has a mark with nothing running or failed`);
    }

    // Forced colours: the dot is a background, which the mode paints over,
    // and the cross keeps the red set on itself, so each has its own rule.
    const css = readSource('src/styles/index.css');
    const head = '@media (forced-colors: active) {';
    const forced = [];
    for (let at = css.indexOf(head); at !== -1; at = css.indexOf(head, at + 1)) {
      const end = css.indexOf('\n}\n', at);
      forced.push(...rulesIn(css.slice(at + head.length, end === -1 ? undefined : end)));
    }
    const forcedRule = (selector) => forced.find((r) => r.selector === selector)?.body ?? '';
    const running = forcedRule('[data-activity="running"]');
    expectThat(/forced-color-adjust:\s*none/.test(running) && /background:\s*Highlight\b/.test(running), `the running dot vanishes in forced colours: ${JSON.stringify(running)}`);
    expectThat(/(^|[;\s])color:\s*CanvasText\b/.test(forcedRule('[data-activity="failed"]')), 'the failed cross keeps its red in forced colours');

    // The cross is the one StatusBoard draws for a failed command.
    expectThat(/failed: \[CircleX, 'text-vsc-error'\]/.test(readSource('src/components/terminal/StatusBoard.jsx')), "StatusBoard's failed icon is no longer CircleX in the error red");
    const source = readFileSync(new URL('../../src/components/terminal/ActivityDot.jsx', import.meta.url), 'utf8');
    expectThat(/import \{ CircleX \} from 'lucide-react';/.test(source), 'ActivityDot does not draw lucide-react\u{2019}s CircleX');

    // The doc says violet, with the checkout's line ends and with CRLF.
    for (const [which, text] of [['the checkout', source], ['a CRLF copy', source.replace(/\r?\n/g, '\r\n')]]) {
      const doc = activityDotDoc(text);
      expectThat(doc, `ActivityDot has no doc block (${which})`);
      expectThat(!/\bblue\b/i.test(doc), `ActivityDot's doc calls the dot blue (${which})`);
      expectThat(/\bviolet\b/i.test(doc), `ActivityDot's doc does not say violet (${which})`);
    }
  }
);

// ---- The fade at the edge of an overflowing tab strip (U3) ------------------
//
// The four strips that scroll sideways with no scroll bar (`.no-scrollbar`)
// fade the side with more content: useEdgeFade sets `data-edge-fade` on the
// scroller, and index.css masks it. Each strip passes its own drag state, so
// a strip a drag is over is not faded and its marker is drawn whole. The
// rule and the watcher are tests/adversarial/edge_fade.test.js (EDGE-*).

/** What each strip passes as its suspend flag: the component, its file, the expression. */
const EDGE_FADE_STRIPS = [
  ['the region view tabs', 'src/components/layout/PanelLayout.jsx', 'RegionHeader', 'Boolean(draggingView)'],
  ['the terminal chip row', 'src/components/terminal/TerminalSplitContainer.jsx', 'TerminalPane', "dropZone === 'tabs' || insertAt !== null"],
  ['the group switcher row', 'src/components/terminal/TerminalSplitContainer.jsx', 'GroupSwitcher', 'Boolean(drag?.active)'],
  ['the editor tab row', 'src/components/editor/EditorTabs.jsx', 'EditorTabs', 'tabsTargeted || dropIndex !== null'],
];

check('RN-237', 'the four tab strips fade the side with more content by a mask (both prefixes, start/end/both), each suspended by its own drag state, with no element added', () => {
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

  // The stylesheet: start, end and both, each masked with and without the prefix.
  const css = readSource('src/styles/index.css');
  const fadeRules = rulesIn(css).filter((r) => r.selector.includes('data-edge-fade'));
  for (const side of ['start', 'end', 'both']) {
    const rule = fadeRules.find((r) => r.selector === `[data-edge-fade="${side}"]`);
    expectThat(rule, `index.css has no [data-edge-fade="${side}"] rule`);
    expectThat(rule.props.includes('mask-image') && rule.props.includes('-webkit-mask-image'), `[data-edge-fade="${side}"] lacks mask-image or -webkit-mask-image: ${rule.body}`);
    const gradients = [...rule.body.matchAll(/mask-image:\s*([^;]+);/g)].map((m) => m[1].trim());
    expectThat(gradients.length === 2 && gradients[0] === gradients[1], `[data-edge-fade="${side}"]'s two masks differ: ${rule.body}`);
    expectThat(/^linear-gradient\(to right, /.test(gradients[0]) && /\btransparent\b/.test(gradients[0]) && /\bblack 20px\b|\bblack calc\(100% - 20px\)/.test(gradients[0]), `[data-edge-fade="${side}"] is not a 20px fade to transparent: ${gradients[0]}`);
    expectThat(!/var\(|transition|animation/.test(rule.body), `[data-edge-fade="${side}"] names a token or animates: ${rule.body}`);
  }
  expectThat(fadeRules.length === 3, `index.css has other data-edge-fade rules: ${fadeRules.map((r) => r.selector).join(', ')}`);
  expectThat(!fadeRules.some((r) => /::?(before|after)\b/.test(r.selector) || r.props.includes('pointer-events')), 'a fade is a pseudo-element or touches pointer events');

  // The strips: every scroller that hides its bar is one of the four, and
  // carries a ref that its own component hands to useEdgeFade with its own
  // drag state.
  const scrollers = sourcesUnder('src').flatMap(([file, text]) =>
    /\.jsx?$/.test(file) ? [...stripComments(text).matchAll(/<div\b[^>]*\bno-scrollbar\b[^>]*>/g)].map((m) => file) : []
  );
  expectThat(scrollers.length === EDGE_FADE_STRIPS.length, `the strips that hide their scroll bar are not the four: ${scrollers.join(', ')}`);
  const calls = sourcesUnder('src').flatMap(([file, text]) =>
    /\.jsx?$/.test(file) && !/useEdgeFade\.js$/.test(file) ? [...stripComments(text).matchAll(/\buseEdgeFade\(/g)].map(() => file) : []
  );
  expectThat(calls.length === EDGE_FADE_STRIPS.length, `useEdgeFade is called ${calls.length} times: ${calls.join(', ')}`);
  for (const [where, file, component, suspend] of EDGE_FADE_STRIPS) {
    const source = stripComments(readSource(file));
    expectThat(/^import \{ useEdgeFade \} from '\.\.\/\.\.\/hooks\/useEdgeFade\.js';$/m.test(source), `${file} does not import useEdgeFade`);
    const start = source.search(new RegExp(`\\n(export )?function ${component}\\(`));
    expectThat(start !== -1, `setup: no function ${component} in ${file}`);
    const next = source.slice(start + 1).search(/\n(export )?function [A-Za-z]/);
    const body = next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
    const tags = [...body.matchAll(/<div\b[^>]*\bno-scrollbar\b[^>]*>/g)].map((m) => m[0]);
    expectThat(tags.length === 1, `${where}: ${component} has ${tags.length} scrollers`);
    const ref = /\bref=\{(\w+)\}/.exec(tags[0])?.[1];
    expectThat(ref, `${where}: its scroller has no ref: ${tags[0]}`);
    expectThat(new RegExp(`const ${ref} = useRef\\(null\\);`).test(body), `${where}: ${ref} is not ${component}'s own useRef`);
    const hookCalls = [...body.matchAll(/\buseEdgeFade\(([^;]*)\);/g)].map((m) => m[1]);
    expectThat(hookCalls.length === 1, `${where}: ${component} calls useEdgeFade ${hookCalls.length} times`);
    expectThat(hookCalls[0] === `${ref}, ${suspend}`, `${where}: useEdgeFade(${hookCalls[0]}) is not useEdgeFade(${ref}, ${suspend})`);
    // Before the markup, so it runs on every render, never behind a return.
    expectThat(body.indexOf('useEdgeFade(') < body.indexOf('\n  return ('), `${where}: the hook comes after ${component}'s return`);
    expectThat(!/data-edge-fade|EdgeFade[A-Z]?\w*\s*\/?>|<EdgeFade/.test(body), `${where}: the fade is drawn as markup`);
  }

  // No element, no attribute in the markup: the fade exists only once an
  // effect runs, which a server render never does.
  reset();
  useTerminalStore.setState({
    tabs: [tab('t1'), tab('t2'), tab('t3')],
    activeTabId: 't1',
    groups: [
      { ...baseGroups(['t1', 't2', 't3'])[0] },
      { id: 'group-2', name: 'Other', createdAt: 0, tree: { type: 'leaf', id: 'pane-2', tabIds: [], activeTabId: null }, activePaneId: 'pane-2' },
    ],
  });
  const html = renderArranged();
  expectThat(html.includes('data-chip-row'), 'setup: no chip row drawn');
  expectThat(!/edge-fade/i.test(html), 'the server markup carries a fade');
  for (const [file] of [['src/lib/edgeFade.js'], ['src/hooks/useEdgeFade.js']]) {
    const source = stripComments(readSource(file));
    expectThat(!/createElement|appendChild|insertBefore|innerHTML|\.style\b/.test(source), `${file} adds or styles an element`);
  }
});

// ---- How long each agent's state has held (bundle 3, U5) -----------------------

const MINUTE = 60 * 1000;

/**
 * Agent rows whose states began a while ago — Claude Code working for 3
 * minutes, idle for 12, waiting after 12 idle minutes, working for 20 seconds;
 * OpenCode running for 4 minutes — and a plain shell running a command for 9.
 * Five seconds over each whole minute, so the case holds however long the
 * render takes short of a minute.
 */
function arrangeElapsed() {
  reset();
  const now = Date.now();
  const ago = (minutes) => now - minutes * MINUTE - 5000;
  useTerminalStore.setState({
    tabs: [
      tab('el-w', { title: 'busy', ...running('el-w', 'claude') }),
      tab('el-i', { title: 'done', ...running('el-i', 'claude') }),
      tab('el-u', { title: 'told', ...running('el-u', 'claude') }),
      tab('el-n', { title: 'new', ...running('el-n', 'claude') }),
      tab('el-o', { title: 'oc', ...running('el-o', 'opencode'), running: true, runStartedAt: ago(4) }),
      tab('el-p', { title: 'plain', running: true, runStartedAt: ago(9) }),
    ],
    activeTabId: 'el-p',
    groups: [groupOf('group-1', ['el-w', 'el-i', 'el-u', 'el-n', 'el-o', 'el-p'])],
    agentActivity: {
      'el-w': Object.freeze({ state: 'working', since: ago(3) }),
      'el-i': Object.freeze({ state: 'idle', since: ago(12) }),
      'el-u': Object.freeze({ state: 'idle', since: ago(12) }),
      'el-n': Object.freeze({ state: 'working', since: now - 20000 }),
    },
    notifications: [
      { id: 'agent-el-u-1-1', kind: 'program', origin: 'agent-done', agent: 'claude', tabId: 'el-u', tabTitle: 'told', title: 'Claude Code', body: 'Session done', at: now, read: false },
    ],
  });
}

/** The tooltip of a row's second line. */
const lineTitle = (row) => attrOf(tagWith(row, 'data-status-line'), 'title');
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

scenario(
  'RN-238',
  'TERMINALS: an agent row says how long its state has held (Working 3m, Idle 12m, Waiting 12m, OpenCode Running 4m), in words in its tooltip; no time under a minute, on a plain row or with Show Agent off; only a line with a time listens to the minute clock (AC14, U5)',
  arrangeElapsed,
  (html) => {
    const row = (id) => {
      const markup = terminalRow(html, id);
      expectThat(markup, `no row ${id}`);
      return markup;
    };
    const expectStatus = (id, state, shown, words, elapsed) => {
      const s = statusIn(row(id));
      expectThat(s?.state === state && s.shown === shown && s.words === words, `${id}: ${JSON.stringify(s)}`);
      expectThat(attrOf(s.tag, 'data-status-elapsed') === elapsed, `${id}'s data-status-elapsed: ${s.tag}`);
      expectThat(!/\d+s\b|second/.test(`${s.shown} ${s.words} ${lineTitle(row(id))}`), `${id} counts seconds: ${s.shown} / ${s.words}`);
      return s;
    };
    expectStatus('el-w', 'working', 'Working 3m', 'Working for 3 minutes', '3m');
    expectThat(lineTitle(row('el-w')) === 'Claude Code \u{2014} Working for 3 minutes', `the working tooltip: ${lineTitle(row('el-w'))}`);
    expectThat(lineTitle(row('el-w')).includes('for 3 minutes'), 'the tooltip does not say for 3 minutes');
    expectStatus('el-i', 'idle', 'Idle 12m', 'Idle for 12 minutes', '12m');
    expectStatus('el-u', 'waiting', 'Waiting 12m', 'Waiting for 12 minutes', '12m');
    const oc = expectStatus('el-o', 'running', 'Running 4m', 'Running for 4 minutes', '4m');
    expectThat(/\sdata-agent="opencode"/.test(row('el-o')) && oc, 'the OpenCode row does not name its agent');
    // Under a minute: the state alone, never "0m".
    expectStatus('el-n', 'working', 'Working', 'Working', null);
    // A plain shell running a command for 9 minutes names no agent: no time.
    expectStatus('el-p', 'running', 'Running', 'Running', null);
    expectThat(!/data-agent=/.test(row('el-p')) && !/\b9m\b|9 minutes/.test(row('el-p')), `the plain row shows a time: ${row('el-p')}`);
    expectThat(lineTitle(row('el-p')) === 'Running', `the plain tooltip: ${lineTitle(row('el-p'))}`);

    // Only the line, and only when it shows a time, listens to the clock.
    const board = withoutComments(readSource('src/components/terminal/StatusBoard.jsx'));
    const start = board.search(/^export const TerminalStatusLine = memo\(function TerminalStatusLine\(/m);
    expectThat(start !== -1, 'the second line is not a memoised module-level component');
    const rest = board.slice(start);
    const line = rest.slice(0, rest.search(/^\}\);/m));
    const calls = board.match(/\buseMinuteNow\(/g) || [];
    expectThat(calls.length === 1 && /\bconst now = useMinuteNow\(since !== null\);/.test(line), `the line does not listen only with a start to count from (${calls.length} calls)`);
    expectThat(/\bconst agent = showAgent \? agentLabel\(tab\) : '';/.test(line), 'the agent row is no longer Show Agent and a named agent');
    expectThat(
      /\bconst since = status \? elapsedSince\(tab, status, \{ activity, agentRow: Boolean\(agent\) \}\) : null;/.test(line),
      'the start is not elapsedSince of an agent row'
    );
    expectThat(/\bconst status = showAgent \? terminalStatus\(/.test(line), 'the state is drawn with Show Agent off');
    expectThat(/\bconst elapsed = since !== null \? elapsedLabel\(now - since\) : '';/.test(line), 'the time is not elapsedLabel of the start');
    expectThat(!/setInterval|requestAnimationFrame/.test(board), 'StatusBoard ticks a clock of its own');
    const shape = /useAgentFits\(lineRef, agent, `([^`]*)`\)/.exec(line)?.[1] ?? '';
    expectThat(shape.includes('${elapsed}'), `the agent's fit is not measured again for a new time: ${shape}`);
    for (const [file, source] of sourcesUnder('src')) {
      if (file === 'src/components/terminal/StatusBoard.jsx' || file === 'src/hooks/useMinuteNow.js' || file === 'src/lib/minuteClock.js') continue;
      expectThat(!/\buseMinuteNow\b|\bminuteClock\b/.test(withoutComments(source)), `${file} listens to the minute clock`);
    }
    const clock = withoutComments(readSource('src/lib/minuteClock.js'));
    expectThat(!/setInterval/.test(clock) && /const MINUTE_MS = 60 \* 1000;/.test(clock), 'the minute clock is not one timeout a minute');

    // The README and the style guide say it (U5).
    const flat = (text) => text.replace(/\s+/g, ' ');
    const readme = flat(readSource('README.md'));
    const boardSection = readme.slice(readme.indexOf('#### The TERMINALS panel as a status board'));
    for (const words of ['*Working 3m*', '*Idle 12m*', '*Waiting 12m*', '*Running 4m*', 'never in seconds', 'nothing under a minute', '*Working for 3 minutes*', 'once a minute']) {
      expectThat(readme.includes('#### The TERMINALS panel as a status board') && boardSection.slice(0, 4000).includes(words), `the status board section does not say ${words}`);
    }
    const guide = flat(readSource('STYLEGUIDE.md'));
    const copy = guide.slice(guide.indexOf('## Copy'), guide.indexOf('## In-flight feedback'));
    for (const words of ['"Working 3m"', 'never "Working 0m"', '"1h 0m", "2h 5m"', 'Never seconds', '"Working for 3 minutes"']) {
      expectThat(copy.includes(words), `STYLEGUIDE.md's Copy does not say ${words}`);
    }

    // Show Agent off: no state and no time on any row, agent or not.
    useSettingsStore.getState().setSetting('terminalsPanelAgent', false);
    const off = renderArranged();
    for (const id of ['el-w', 'el-i', 'el-u', 'el-o', 'el-p']) {
      const markup = terminalRow(off, id);
      expectThat(markup, `no row ${id} with Show Agent off`);
      expectThat(statusIn(markup) === null, `${id} draws a state with Show Agent off`);
      expectThat(!/data-status-elapsed|\b\d+m\b|minutes/.test(markup), `${id} shows a time with Show Agent off: ${markup}`);
    }
  }
);

// ---- Toasts (bundle 3, U6) -------------------------------------------------------

check('RN-239', 'toasts: an always-mounted hidden polite status region (the one copy of a confirmation\u{2019}s words) and an alert, above the status bar beside the corner notices (right-2, right-[416px], right-[824px]; above them in a narrow window), by opacity only, never taking focus (AC16, U6)', () => {
  // No real timer: a confirmation's TOAST_MS would keep the suite up for 3 s.
  const quiet = { setTimeout: () => 0, clearTimeout: () => {} };
  const OPEN_FAILURE = { path: '/workspace/a.bin', fileName: 'a.bin', reason: 'Binary file' };
  const AGENT_NOTICE = { kind: 'gone', text: 'The entry is no longer in the list.', key: 'k', tabId: null, seq: 1 };
  const hostOf = (html) => /<div\b[^>]*\sdata-toast-host=""[^>]*>/.exec(html)?.[0] ?? null;
  /** The polite region: its tag and what it holds (one div per confirmation). */
  const liveOf = (html) => {
    const all = [...html.matchAll(/<div\b[^>]*\sdata-toast-live=""[^>]*>((?:<div>[^<]*<\/div>)*)<\/div>/g)];
    return all.length === 1 ? { tag: /^<div\b[^>]*>/.exec(all[0][0])[0], lines: [...all[0][1].matchAll(/<div>([^<]*)<\/div>/g)].map((m) => m[1]) } : null;
  };
  const isLive = (tag) =>
    attrOf(tag, 'role') === 'status' && attrOf(tag, 'aria-live') === 'polite' && attrOf(tag, 'aria-atomic') === 'false' &&
    classesOf(tag).includes('sr-only') && classesOf(tag).includes('pointer-events-none');
  const classesOf = (tag) => (attrOf(tag, 'class') ?? '').split(/\s+/).filter(Boolean);
  const offsetOf = (tag) => classesOf(tag).filter((c) => c.startsWith('right-'));
  /** The app drawn with a confirmation and an error up, and the corner notices asked for. */
  const drawn = ({ openFailure = false, agentNotice = false } = {}) => {
    reset();
    setToastTimers(quiet);
    useToastStore.getState().show({ text: 'Path copied' });
    useToastStore.getState().show({ kind: 'error', text: 'Path not copied' });
    if (openFailure) useEditorStore.setState({ openFailure: OPEN_FAILURE });
    if (agentNotice) useTerminalStore.setState({ agentHistoryNotice: AGENT_NOTICE });
    return renderArranged();
  };
  try {
    reset();
    setToastTimers(quiet);
    const none = renderArranged();
    expectThat(hostOf(none) === null, 'a toast host is drawn with no toast up');
    expectThat(!/\sdata-toast="/.test(none), 'a toast is drawn with no toast up');
    // The polite region is there before any toast, empty, hidden, taking no clicks.
    const quietRegion = liveOf(none);
    expectThat(quietRegion, 'no single polite toast region with no toast up');
    expectThat(isLive(quietRegion.tag), `the toast region is not a hidden polite status taking no clicks: ${quietRegion.tag}`);
    expectThat(quietRegion.lines.length === 0, `the toast region is not empty with no toast up: ${quietRegion.lines}`);

    const html = drawn();
    const host = hostOf(html);
    expectThat(host, 'no toast host drawn');
    for (const cls of ['fixed', 'bottom-statusbar', 'mb-2', 'z-40', 'w-[400px]', 'pointer-events-none']) {
      expectThat(classesOf(host).includes(cls), `the host is not ${cls}: ${host}`);
    }
    expectThat(JSON.stringify(offsetOf(host)) === '["right-2"]', `with no corner notice the host is not right-2 alone: ${host}`);
    const toasts = [...html.matchAll(/<div\b[^>]*\sdata-toast="(?:confirm|error)"[^>]*>/g)].map((m) => m[0]);
    expectThat(toasts.length === 2, `${toasts.length} toasts drawn, not 2`);
    const [confirm, error] = toasts;
    expectThat(attrOf(confirm, 'data-toast') === 'confirm' && attrOf(error, 'data-toast') === 'error', 'the newest is not at the bottom');
    const region = liveOf(html);
    expectThat(region && isLive(region.tag), 'no single hidden polite toast region with toasts up');
    expectThat(JSON.stringify(region?.lines) === '["Path copied"]', `the polite region does not hold the confirmation alone: ${region?.lines}`);
    expectThat(html.indexOf(region.tag) < html.indexOf(host), 'the polite region is not drawn before the host');
    expectThat(attrOf(confirm, 'role') === null && attrOf(confirm, 'aria-live') === null, `a drawn confirmation is a live region of its own (said twice): ${confirm}`);
    expectThat(attrOf(error, 'role') === 'alert' && attrOf(error, 'aria-live') === null, `an error is not an alert: ${error}`);
    // A confirmation's drawn words are aria-hidden (the region holds them);
    // an error's are not, and no whole toast or Dismiss is hidden.
    const wordsTag = (text) => new RegExp(`(<div\\b[^>]*class="min-w-0 flex-1 break-words"[^>]*>)${text}</div>`).exec(html)?.[1] ?? null;
    expectThat(attrOf(wordsTag('Path copied') ?? '', 'aria-hidden') === 'true', `a drawn confirmation's words are read besides the region's: ${wordsTag('Path copied')}`);
    expectThat(wordsTag('Path not copied') && attrOf(wordsTag('Path not copied'), 'aria-hidden') === null, `an error's words are hidden: ${wordsTag('Path not copied')}`);
    expectThat(toasts.every((tag) => attrOf(tag, 'aria-hidden') === null), 'a whole toast is aria-hidden');
    expectThat(!/<button\b[^>]*aria-hidden/.test(html.slice(html.indexOf(host))), 'a Dismiss is aria-hidden');
    for (const tag of toasts) {
      for (const cls of ['pointer-events-auto', 'bg-vsc-widget', 'border', 'border-vsc-widget-border', 'shadow-widget', 'rounded-popover', 'text-ui']) {
        expectThat(classesOf(tag).includes(cls), `a toast is not ${cls}, as the corner notices are: ${tag}`);
      }
    }
    expectThat(classesOf(confirm).includes('animate-toast-in-out') && !classesOf(confirm).includes('animate-toast-in'), `a confirmation does not fade in and out: ${confirm}`);
    expectThat(classesOf(error).includes('animate-toast-in') && !classesOf(error).includes('animate-toast-in-out'), `an error fades out: ${error}`);
    const drawnPart = html.slice(html.indexOf(host));
    expectThat(visibleText(drawnPart).indexOf('Path copied') < visibleText(drawnPart).indexOf('Path not copied'), 'the toasts are not oldest first');
    expectThat(!/autofocus|tabindex/i.test(drawnPart.slice(0, drawnPart.indexOf('</button></div></div>') + 20)), 'a toast takes focus');
    expectThat(buttonsIn(drawnPart).filter((b) => b.title === 'Dismiss').length >= 2, 'a toast has no Dismiss');

    // Beside the corner notices, never over them; the notices drawn as before.
    const one = drawn({ openFailure: true });
    expectThat(JSON.stringify(offsetOf(hostOf(one))) === '["right-[416px]"]', `beside the open failure, not: ${hostOf(one)}`);
    expectText(one, 'Could not open a.bin');
    const failure = /<div\b[^>]*\srole="alert"[^>]*\bright-2\b[^>]*>/.exec(one)?.[0];
    expectThat(failure && /bottom-statusbar/.test(failure), 'the open failure notice moved');
    const other = drawn({ agentNotice: true });
    expectThat(JSON.stringify(offsetOf(hostOf(other))) === '["right-[416px]"]', `beside the agent session notice, not: ${hostOf(other)}`);
    expectText(other, 'No longer in the list');
    const both = drawn({ openFailure: true, agentNotice: true });
    expectThat(JSON.stringify(offsetOf(hostOf(both))) === '["right-[824px]"]', `beside both notices, not: ${hostOf(both)}`);
    const notice = /<div\b[^>]*\sdata-agent-history-notice="gone"[^>]*>/.exec(both)?.[0];
    expectThat(notice && /right-\[416px\]/.test(notice), `the agent session notice is not beside the open failure: ${notice}`);
    // Both notices' roots carry what the host measures them by in a narrow window.
    const cornerRoots = [...both.matchAll(/<div\b[^>]*\sdata-corner-notice=""[^>]*>/g)].map((m) => m[0]);
    expectThat(cornerRoots.length === 2, `${cornerRoots.length} corner notice roots marked, not 2`);
    expectThat(cornerRoots.some((tag) => /data-agent-history-notice="gone"/.test(tag)) && cornerRoots.some((tag) => attrOf(tag, 'role') === 'alert' && /\bright-2\b/.test(tag)), `the marked roots are not the two notices: ${cornerRoots}`);
    expectThat(!/style="/.test(hostOf(both)), `a server render lifts the host: ${hostOf(both)}`);
    expectText(both, 'Could not open a.bin');
    expectText(both, 'Path copied');
  } finally {
    resetToasts();
  }

  // index.css: two finite fades of opacity alone, the fade-out ending as the
  // store takes a confirmation away, cut to 0.01ms by both reduced-motion switches.
  const css = readSource('src/styles/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const frames = new Map([...css.matchAll(/@keyframes (toast-[\w-]+) \{([\s\S]*?)\n\}/g)].map((m) => [m[1], m[2]]));
  expectThat(JSON.stringify([...frames.keys()].sort()) === '["toast-fade-in","toast-fade-out"]', `the toast keyframes: ${[...frames.keys()]}`);
  for (const [name, body] of frames) {
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    expectThat(props.length > 0 && props.every((p) => p === 'opacity'), `${name} animates more than opacity: ${props}`);
    expectThat(!/transform|translate|scale|rotate/.test(body), `${name} moves the toast: ${body}`);
  }
  expectThat(/@keyframes toast-fade-in \{\s*from \{ opacity: 0; \}\s*to\s+\{ opacity: 1; \}/.test(css), 'toast-fade-in is not 0 to 1');
  expectThat(/@keyframes toast-fade-out \{\s*from \{ opacity: 1; \}\s*to\s+\{ opacity: 0; \}/.test(css), 'toast-fade-out is not 1 to 0');
  const ruleOf = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? null;
  const fadeIn = ruleOf('.animate-toast-in');
  const fadeInOut = ruleOf('.animate-toast-in-out');
  expectThat(fadeIn && /^\s*animation: toast-fade-in 150ms ease-out both;\s*$/.test(fadeIn), `.animate-toast-in: ${fadeIn}`);
  const parts = /^\s*animation: ([^;]+);\s*$/.exec(fadeInOut ?? '')?.[1]?.split(',').map((p) => p.trim()) ?? [];
  expectThat(parts.length === 2 && parts[0] === 'toast-fade-in 150ms ease-out both', `.animate-toast-in-out does not fade in first: ${fadeInOut}`);
  const out = /^toast-fade-out (\d+)ms ease-in (\d+)ms forwards$/.exec(parts[1] ?? '');
  expectThat(out, `the fade-out is not last, with a delay, filling forwards only: ${parts[1]}`);
  expectThat(Number(out[1]) + Number(out[2]) === TOAST_MS, `the fade-out ends at ${Number(out[1]) + Number(out[2])}ms, not at TOAST_MS (${TOAST_MS})`);
  for (const [, selector, body] of css.matchAll(/([^{}\n][^{}]*)\{([^}]*)\}/g)) {
    if (!/toast/.test(selector) || /^\s*@keyframes|^\s*(from|to)\s*$/.test(selector)) continue;
    expectThat(!/infinite|transform|transition/.test(body), `${selector.trim()} loops, moves or transitions: ${body.trim()}`);
  }
  expectThat(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{\s*animation-duration: 0\.01ms !important;/.test(css), 'the OS switch no longer cuts every animation');
  expectThat(/:root\.reduce-motion \*,[\s\S]*?\{\s*animation-duration: 0\.01ms !important;/.test(css), 'the setting no longer cuts every animation');

  // The host's source: the notices' offsets from their own stores, nothing that takes focus.
  const toastHost = withoutComments(readSource('src/components/common/ToastHost.jsx'));
  expectThat(/const OFFSETS = \['right-2', 'right-\[416px\]', 'right-\[824px\]'\];/.test(toastHost), 'the three offsets are not right-2, right-[416px], right-[824px]');
  expectThat(/useEditorStore\(\(s\) => Boolean\(s\.openFailure\)\)/.test(toastHost) && /useTerminalStore\(\(s\) => Boolean\(s\.agentHistoryNotice\)\)/.test(toastHost), 'the offset does not read the notices');
  expectThat(/const notices = Number\(openFailure\) \+ Number\(agentHistoryNotice\);/.test(toastHost) && /return \{ offset: OFFSETS\[notices\], lift: 0 \};/.test(toastHost), 'the offset is not one step per notice up');
  // The narrow-window fallback: measured from the notices' roots, on resize and
  // by a ResizeObserver, from a layout effect that cleans both up; no polling.
  expectThat(/export const CORNER_NOTICE_SELECTOR = '\[data-corner-notice\]';/.test(toastHost) && /document\.querySelectorAll\(CORNER_NOTICE_SELECTOR\)/.test(toastHost), 'the host does not find the notices by data-corner-notice');
  expectThat(/window\.addEventListener\('resize', onResize\)/.test(toastHost) && /window\.removeEventListener\('resize', onResize\)/.test(toastHost), 'the resize listener is not added and removed');
  expectThat(/new ResizeObserver\(/.test(toastHost) && /observer\.disconnect\(\)/.test(toastHost), 'the notices are not observed, or the observer not disconnected');
  expectThat(!/setInterval|requestAnimationFrame/.test(toastHost), 'the host polls');
  for (const rel of ['src/components/editor/OpenFailureNotice.jsx', 'src/components/terminal/AgentHistoryNotice.jsx']) {
    expectThat((readSource(rel).match(/data-corner-notice=""/g) || []).length === 1, `${rel} does not mark its root once with data-corner-notice`);
  }
  expectThat(!/autoFocus|\.focus\(|tabIndex/.test(toastHost), 'ToastHost moves focus');
  expectThat(/onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/.test(toastHost), "Dismiss takes focus when pressed");
  expectThat(!/return null/.test(toastHost) && /return \(\s*<>\s*(?:\{\s*\}\s*)?<div data-toast-live="" role="status" aria-live="polite"/.test(toastHost), 'the polite region is not drawn first and always');
  const app = readSource('src/App.jsx');
  expectThat(/<AgentHistoryNotice \/>[\s\S]*?<ToastHost \/>/.test(app) && (app.match(/<ToastHost \/>/g) || []).length === 1, 'App does not mount one ToastHost after AgentHistoryNotice');

  // The style guide and README say it.
  const flat = (text) => text.replace(/\s+/g, ' ');
  const guide = flat(readSource('STYLEGUIDE.md'));
  const feedback = guide.slice(guide.indexOf('## In-flight feedback'), guide.indexOf('## Recorded decisions'));
  for (const words of ['toast', 'short confirmations', 'Errors stay until they are dismissed', 'never takes focus', 'At most three']) {
    expectThat(feedback.includes(words), `STYLEGUIDE.md's In-flight feedback does not say ${words}`);
  }
  expectThat(guide.includes('a toast fading in'), "STYLEGUIDE.md's Motion does not list the toast's 150 ms");
  const readme = flat(readSource('README.md'));
  for (const words of ['**Toasts.**', 'fades after about 3 seconds', 'stays until you dismiss it', 'never takes focus', 'never over them']) {
    expectThat(readme.includes(words), `README.md does not say ${words}`);
  }
});

// ---- a read-only terminal (bundle 4, A3; src/lib/readOnly.js) ----------------
//
// A badge on the chip's bottom-left corner (under the lock's corner) and an
// in-line mark on the TERMINALS row, a keyboard with a stroke through it,
// with its words; a strip of its own above the terminal with Turn Off. Only
// while the terminal is read-only: the state is the store's `readOnly` map,
// set here directly (what turns it on is read_only.test.js's).

const RO_MODULE = await import('../../src/lib/readOnly.js');

/** The read-only mark in some markup, as `{ tag, label, title, role, after }`, or null. */
function readOnlyMarkIn(markup) {
  const tag = /<span\b[^>]*\sdata-read-only-mark="[^"]*"[^>]*>/.exec(markup ?? '')?.[0];
  if (!tag) return null;
  const after = markup.slice(markup.indexOf(tag));
  return { tag, label: attrOf(tag, 'aria-label'), title: attrOf(tag, 'title'), role: attrOf(tag, 'role'), after };
}

/** The read-only strip in some markup, from its opening tag to its button's end, or null. */
const readOnlyStripIn = (markup) => /<div\b[^>]*\sdata-read-only-strip="[^"]*"[^>]*>[\s\S]*?<\/button><\/div>/.exec(markup ?? '')?.[0] ?? null;

function arrangeReadOnly(readOnly) {
  reset();
  useTerminalStore.setState({
    tabs: [tab('t1'), tab('t2')],
    activeTabId: 't1',
    groups: baseGroups(['t1', 't2']),
    readOnly,
  });
}

scenario(
  'RN-240',
  "a read-only terminal: a KeyboardOff badge under the lock's corner of its chip, taking no room, an in-line mark on its side bar row, both with their words; a strip above the terminal with Turn Off",
  () => {
    arrangeReadOnly({ t1: true });
    lockSessions(['t1']);
  },
  (html) => {
    const words = RO_MODULE.READ_ONLY_LABEL;
    const chip = tabChip(html, 't1');
    const badge = readOnlyMarkIn(chip);
    expectThat(badge, 'no read-only badge on the chip');
    expectThat(badge.role === 'img' && badge.label === words && badge.title === words, `the badge does not say it: ${badge.tag}`);
    expectThat(iconOf(badge.after) === 'keyboard-off' && /\swidth="8"/.test(badge.after), 'the badge is not an 8 px KeyboardOff');
    const cls = classOf(badge.tag).split(/\s+/);
    for (const word of ['absolute', 'pointer-events-none', '-bottom-[2px]', '-left-[2px]', 'w-[10px]', 'h-[10px]']) {
      expectThat(cls.includes(word), `the chip's read-only badge is not "${word}" — it must take no room, and no pointer: ${badge.tag}`);
    }
    // Beside the lock, a different shape: both on the chip, neither the other.
    const lock = lockIn(chip);
    expectThat(lock && iconOf(chip.slice(chip.indexOf(lock.tag))) === 'lock', 'setup: the lock is on the chip too');
    expectThat(chip.indexOf(lock.tag) < chip.indexOf(badge.tag), 'the badge is not right after the lock');
    const chipTitle = visibleText(attrOf(openingTag(chip), 'title') ?? '');
    expectThat(chipTitle.includes(words), `the chip's tooltip does not say it: ${JSON.stringify(chipTitle)}`);
    expectThat(!readOnlyMarkIn(tabChip(html, 't2')), 'a read-only badge on a writable terminal');

    const row = terminalRow(html, 't1');
    const mark = readOnlyMarkIn(row);
    expectThat(mark?.label === words && mark.title === words && mark.role === 'img', 'no read-only mark, with its words, on the side bar row');
    expectThat(iconOf(mark.after) === 'keyboard-off', 'the row mark is not KeyboardOff');
    expectThat(row.indexOf(lockIn(row).tag) < row.indexOf(mark.tag), "the row's mark is not right after the lock");
    expectThat(visibleText(attrOf(openingTag(row), 'title') ?? '').includes(words), "the side bar row's tooltip does not say it");
    expectThat(!readOnlyMarkIn(terminalRow(html, 't2')), "a read-only mark on the writable terminal's row");

    const pane = paneMarkup(html, 'pane-1');
    const strip = readOnlyStripIn(pane);
    expectThat(strip, 'no read-only strip in the pane showing the read-only terminal');
    expectThat(attrOf(openingTag(strip), 'data-read-only-strip') === 't1' && attrOf(openingTag(strip), 'role') === 'status', `the strip is not t1's status: ${openingTag(strip)}`);
    expectThat(visibleText(strip).includes(RO_MODULE.READ_ONLY_STRIP_TEXT), `the strip does not say it: ${JSON.stringify(visibleText(strip))}`);
    const buttons = buttonsIn(strip);
    expectThat(buttons.length === 1 && buttons[0].text === RO_MODULE.READ_ONLY_TURN_OFF && !buttons[0].disabled, `no Turn Off button: ${JSON.stringify(buttons)}`);
    expectThat(buttons[0].title === RO_MODULE.READ_ONLY_TURN_OFF_HINT, 'Turn Off says nothing of what it does');
    // A row of its own, never laid over the terminal: thin, in the flow
    // (not absolute), and ahead of the box the terminal is drawn in.
    const stripCls = classOf(openingTag(strip)).split(/\s+/);
    expectThat(stripCls.includes('shrink-0') && stripCls.includes('h-[24px]') && !stripCls.includes('absolute'), `the strip is not a thin row of its own: ${openingTag(strip)}`);
    expectThat(pane.indexOf(strip) < pane.indexOf('class="relative flex-1 min-h-0"'), 'the strip is not above the terminal');
    expectThat(iconOf(strip) === 'keyboard-off', "the strip does not carry the badge's shape");
  }
);

scenario(
  'RN-241',
  'no terminal read-only: no badge, no row mark and no strip anywhere — and the other terminal of a pane, when it is the one read-only, puts no strip over the one shown',
  () => arrangeReadOnly({ t2: true }),
  (html) => {
    expectThat(!readOnlyMarkIn(tabChip(html, 't1')) && !readOnlyMarkIn(terminalRow(html, 't1')), 'a read-only mark on a writable terminal');
    expectThat(readOnlyMarkIn(tabChip(html, 't2')) && readOnlyMarkIn(terminalRow(html, 't2')), "the hidden read-only terminal's chip and row are not marked");
    expectThat(!readOnlyStripIn(paneMarkup(html, 'pane-1')), 'a read-only strip over a writable terminal');
    arrangeReadOnly({});
    const none = renderArranged();
    expectThat(!/data-read-only-mark=|data-read-only-strip=/.test(none), 'a read-only mark or strip with nothing read-only');
  }
);

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
