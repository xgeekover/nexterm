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
const { useSettingsStore } = await import('../../src/stores/settingsStore.js');
const { useGitStore } = await import('../../src/stores/gitStore.js');
const { default: App } = await import('../../src/App.jsx');

const STORES = [useTerminalStore, useEditorStore, useSettingsStore, useGitStore];

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

scenario('RN-13', 'notifications waiting in the status bar', () => {
  reset();
  useTerminalStore.setState({
    notifications: [
      { id: 'n1', tabId: 't1', title: 'build', exitCode: 1, durationMs: 252000, at: 1 },
      { id: 'n2', tabId: 't1', title: 'tests', exitCode: 0, durationMs: 38000, at: 2 },
    ],
  });
});

scenario('RN-12', 'a file open in the editor', () => {
  reset();
  useEditorStore.setState({
    tabs: [{ id: 'e1', filePath: '/workspace/a.js', fileName: 'a.js', content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' }],
    activeTabId: 'e1',
    editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: ['e1'], activeTabId: 'e1' },
  });
});

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
  'opencode is offered as the most recent conversation here, not as this one',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering({ kind: 'opencode', sessionId: null })] });
  },
  (html) => {
    expectText(html, 'Resume opencode?');
    // The time belongs to this terminal: the most recent conversation in the
    // folder may be another terminal's.
    expectText(
      html,
      'Picks up the most recent opencode conversation in this folder; opencode was started in this terminal 3h ago.'
    );
    expectThat(
      !visibleText(html).includes('the conversation this terminal had'),
      'promises opencode the exact conversation, which it cannot choose'
    );
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
