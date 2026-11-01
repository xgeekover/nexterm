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
import { readFileSync } from 'node:fs';
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
const { usePathDropStore } = await import('../../src/stores/pathDropStore.js');
const { useBranchStore } = await import('../../src/stores/branchStore.js');
const { useProjectCommandsStore } = await import('../../src/stores/projectCommandsStore.js');
const { useSystemStore } = await import('../../src/stores/systemStore.js');
const { default: App } = await import('../../src/App.jsx');
const TERMINAL_THEMES_MODULE = await import('../../src/lib/terminalThemes.js');

const STORES = [useTerminalStore, useEditorStore, useSettingsStore, useGitStore, usePathDropStore, useBranchStore, useProjectCommandsStore, useSystemStore];

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
      const bound = keysFor(id).length > 0;
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
    expectThat(/\binset-0\b/.test(line) && /\bring-1\b/.test(line) && /\bring-vsc-focus\b/.test(line), `not a 1px focus line on the edge: ${line}`);
    expectThat(/pointer-events-none/.test(line) && /aria-hidden="true"/.test(line), `the line is in the way: ${line}`);
    // Both on one pane: the ring one pixel in, so the two read as two things.
    expectThat(/data-attention-ring="unread"/.test(paneBody(three, 'pane-b') ?? ''), 'setup: pane-b does not ring');
    // Painted under the strip and the terminal, a ring on the pane's own box never showed.
    expectThat(!/<div\b[^>]*class="[^"]*ring-vsc-focus[^"]*"[^>]*>\s*<div\b[^>]*data-tab-strip/.test(three), 'the pane box still carries the ring the strip hid');
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
  for (const file of [board]) expectThat((file.match(/data-status-icon=""/g) || []).length === 2, 'a state icon (line 2 or the group summary) is not marked for forced colours');
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
const swatchesIn = (markup) => [...(markup ?? '').matchAll(/<span class="block h-\[10px\] rounded-\[2px\]" style="background:([^"]+)"/g)].map((m) => m[1]);
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
