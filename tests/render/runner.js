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
  'an opencode terminal that saw a title but no id still promises only the latest — and says what it was in',
  () => {
    reset();
    useTerminalStore.setState({ tabs: [offering({ ...OPENCODE_KNOWN, sessionId: null })] });
  },
  (html) => {
    expectText(
      html,
      'Picks up the most recent opencode conversation in this folder; opencode was started in this terminal 3h ago \u2014 it was in \u201cFix the login bug\u201d.'
    );
    expectThat(
      !visibleText(html).includes('the conversation this terminal had'),
      'promises the exact conversation without its id'
    );
    expectThat(buttonsIn(html).find((b) => b.text === 'Choose…'), 'no Choose… when the resume cannot be exact');
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
  // React writes a bare `data-*` attribute out as `="true"`.
  return /<span\b[^>]*\sdata-notification-count="[^"]*"[^>]*\sclass="([^"]*)"/.exec(html)?.[1] ?? null;
}

scenario(
  'RN-20',
  'cmd commands that finished while you were elsewhere are not called failures',
  () => {
    reset();
    // cmd's prompt can say a command ended but not how, so its notifications
    // carry no code at all.
    useTerminalStore.setState({
      notifications: [
        { id: 'n1', tabId: 't1', title: 'ping -n 15 localhost', exitCode: null, durationMs: 14000, at: 1 },
        { id: 'n2', tabId: 't1', title: 'build.cmd', exitCode: null, durationMs: 61000, at: 2 },
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

/** The bell's own button — the one that opens the list — as `{ label, title }`, or null. */
function bellButton(html) {
  // The button that holds the count badge — not just the first one with
  // `aria-expanded`: off macOS the title bar's Application Menu comes first,
  // and the suite decides "off macOS" from `navigator.platform`, which Node 20
  // (CI, on every OS) does not have and Node 24 does.
  const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, , inner]) =>
    /\sdata-notification-count[=\s>]/.test(inner)
  );
  const attrs = button?.[1];
  if (attrs === undefined) return null;
  return {
    label: visibleText(/\saria-label="([^"]*)"/.exec(attrs)?.[1] ?? ''),
    title: visibleText(/\stitle="([^"]*)"/.exec(attrs)?.[1] ?? ''),
  };
}

/** A program's message, as `notifyFromProgram` puts it in the list. */
const programNote = (id, extra = {}) => ({
  id,
  kind: 'program',
  tabId: 't1',
  tabTitle: 't1',
  title: 'opencode',
  body: 'Session done',
  at: 1,
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
    expectThat(bell.label === '1 message from a program', `the bell is called ${JSON.stringify(bell.label)}`);
    expectThat(
      bell.title === '1 message from a program while you were elsewhere',
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
        { id: 'n1', tabId: 't1', title: 'build', exitCode: 1, durationMs: 252000, at: 1 },
      ],
    });
  },
  (html) => {
    expectThat(/\bbg-vsc-error\b/.test(notificationBadgeClass(html) ?? ''), 'a failed command no longer turns the badge red');
    const bell = bellButton(html);
    expectThat(
      bell?.label === '1 finished command and 2 messages from programs',
      `the bell is called ${JSON.stringify(bell?.label)}`
    );
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

const { COMMANDS, configurableCommands } = await import('../../src/lib/keybindings.js');

scenario(
  'RN-61',
  'Settings names every shortcut a focused terminal never sees, and only those',
  () => {
    reset();
    useSettingsStore.setState({ isSettingsModalOpen: true });
  },
  (html) => {
    // It said only the two side-bar toggles were claimed over a terminal,
    // while ten commands were.
    const note = visibleText(html).split('\n').find((line) => line.startsWith('Over a focused terminal'));
    expectThat(note, 'no note about what a focused terminal never sees');
    for (const { id, title } of configurableCommands()) {
      const named = note.includes(title);
      if (COMMANDS[id].overTerminal) expectThat(named, `${title} is taken ahead of the terminal, and the note does not say so`);
      else expectThat(!named, `the note says ${title} is taken ahead of the terminal; it is not`);
    }
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
