/**
 * Stage 5: the run dialog of a project command (src/components/command/
 * ProjectCommandDialog.jsx), mounted.
 *
 * What it lists and why a target is refused is plain data, held in
 * project_commands_run.test.js. What it does with keys, clicks and a store
 * that changes under it — an effect, a window listener, a clock — is out of
 * reach of `renderToString`, so the dialog is rendered here with real React
 * on a page written by hand (react_page.js) and driven the way a user drives
 * it (review round 1: H2, H3, M4, S2, the Korean IME Enter).
 *
 * Node cannot import a .jsx file, so the component is bundled with esbuild
 * and imported from a data: URL, as palette_mounted.test.js does. Its stores
 * are stood in for by real zustand stores holding what a case puts there;
 * every Run that reaches the store is counted (`calls`).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun, dispatch } from './react_page.js';
import { parseCommandsFile } from '../../src/lib/projectCommands.js';

const h = React.createElement;
const COMMAND_DIR = fileURLToPath(new URL('../../src/components/command/', import.meta.url));
const REAL = new Set(['react', 'react/jsx-runtime', 'zustand']);

const STAND_INS = {
  calls: `export const calls = [];`,
  projectCommandsStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useProjectCommandsStore = create((set) => ({
      running: null,
      problem: null,
      closeRun: () => set({ running: null }),
      submitRun: (id, plan) => {
        calls.push(['submitRun', id, plan]);
        set({ running: null });
        return Promise.resolve(true);
      },
    }));
    export const runProblem = (state) => state.problem ?? null;`,
  settingsStore: `
    import { create } from 'zustand';
    export const useSettingsStore = create(() => ({
      terminalDefaultShell: 'default',
      terminalSplitCwd: 'inherited',
      setActiveView: () => {},
    }));`,
  systemStore: `
    import { create } from 'zustand';
    export const useSystemStore = create(() => ({ os: 'macos', defaultShell: '/bin/zsh' }));`,
  terminalStore: `
    import { create } from 'zustand';
    export const useTerminalStore = create((set, get) => ({
      tabs: [],
      activeTabId: null,
      activeGroupId: 'g1',
      groups: [],
      blocks: {},
      projectCommandBlock: (id) => get().blocks[id] ?? null,
    }));`,
  editorStore: `
    import { create } from 'zustand';
    export const useEditorStore = create(() => ({ getActiveTab: () => null, focusEditor: () => {} }));`,
  lucide: `
    export const X = function X() { return null; };`,
};

function standInFor(path) {
  if (path === 'stand-in:calls') return 'calls';
  if (path === 'lucide-react') return 'lucide';
  const store = /\/stores\/(projectCommands|settings|system|terminal|editor)Store\.js$/.exec(path);
  return store ? `${store[1]}Store` : null;
}

let loading = null;
function loadDialog() {
  loading ??= build({
    stdin: {
      contents: [
        "export * from './ProjectCommandDialog.jsx';",
        "export { useProjectCommandsStore } from '../../stores/projectCommandsStore.js';",
        "export { useTerminalStore } from '../../stores/terminalStore.js';",
        "export { modalHeld } from '../../lib/modalLock.js';",
        "export { calls } from 'stand-in:calls';",
      ].join('\n'),
      resolveDir: COMMAND_DIR,
      sourcefile: 'run-dialog-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'run-dialog-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            const standIn = standInFor(args.path);
            return standIn ? { path: standIn, namespace: 'stand-in' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({ contents: STAND_INS[args.path], loader: 'js', resolveDir: COMMAND_DIR }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loading;
}

const parse = (commands) => parseCommandsFile(JSON.stringify({ version: 1, commands }), { source: 'user' }).commands;
const [GREET, PLAIN] = parse([
  { name: 'Greet', command: 'echo {{who}}', placeholders: { who: { default: 'world' } } },
  { name: 'Plain', command: 'echo hi' },
]);

let ui = null;
let opened = 0;

async function fresh() {
  ui = await loadDialog();
  ui.useProjectCommandsStore.setState(ui.useProjectCommandsStore.getInitialState(), true);
  ui.useTerminalStore.setState(
    {
      ...ui.useTerminalStore.getInitialState(),
      tabs: [
        { id: 't1', title: 'api', shell: '/bin/zsh', sessionId: 's1' },
        { id: 't2', title: 'web', shell: '/bin/zsh', sessionId: 's2' },
      ],
      activeTabId: 't1',
      groups: [{ id: 'g1', activePaneId: 'p1', tree: { type: 'split', id: 'sp', children: [{ type: 'leaf', id: 'p1', tabIds: ['t1'], activeTabId: 't1' }, { type: 'leaf', id: 'p2', tabIds: ['t2'], activeTabId: 't2' }] } }],
      blocks: {},
    },
    true
  );
  ui.calls.length = 0;
}

/** Open the dialog for `command`, and let React draw it and run its effects. */
async function open(p, command) {
  opened += 1;
  p.render(h(ui.ProjectCommandDialog));
  p.settled(() => ui.useProjectCommandsStore.setState({ running: { id: opened, command } }));
  await letItRun();
  return opened;
}

const runs = () => ui.calls.filter(([c]) => c === 'submitRun');
const runButton = (p) => p.document.querySelector('[data-run-run]');
const why = (p) => p.document.querySelector('[data-run-why]')?.textContent ?? '';
const radio = (p, value) => p.document.querySelector(`[data-run-target="${value}"] input`);
const typeButton = (p) => p.document.querySelector('[data-run-type-only]');
/** Choose a target as a click on its radio does: the browser checks it, then the click is dispatched. */
const choose = (p, value) => {
  const input = radio(p, value);
  // The page keeps attributes, not a browser's properties: React tells a
  // radio by `type`, and a click on one changes what `checked` reads.
  input.type = 'radio';
  input.checked = true;
  p.click(input);
};
const keyClick = (p, node) => p.settled(() => dispatch(p.window, node, { type: 'click', detail: 0 }));

describe('Run dialog, mounted: nothing runs before the line could be read', () => {
  beforeEach(fresh);

  test('PRD-01: an Enter 60 ms after it opens runs nothing; one after half a second runs it, once', async () => {
    await onPage(async (p) => {
      await open(p, GREET);
      assert.equal(p.document.activeElement?.getAttribute('id'), 'project-blank-who', 'the first field has the keyboard');
      await letItRun(60);
      p.keydown('Enter');
      assert.equal(runs().length, 0, 'ran a line nobody had seen');
      assert.ok(ui.useProjectCommandsStore.getState().running, 'still open');
      await letItRun(560);
      p.keydown('Enter');
      p.keydown('Enter');
      assert.equal(runs().length, 1);
      assert.equal(runs()[0][2].line, 'echo world');
    });
  });

  test('PRD-02: Run from the keyboard (Enter on the button) or the pointer within the grace does nothing; after it, once', async () => {
    await onPage(async (p) => {
      await open(p, PLAIN);
      assert.equal(p.document.activeElement?.getAttribute('data-run-run'), '', 'Run has the keyboard with no blanks');
      keyClick(p, runButton(p));
      p.click(runButton(p));
      assert.equal(runs().length, 0);
      await letItRun(560);
      keyClick(p, runButton(p));
      assert.equal(runs().length, 1);
      // A new split by default: a fresh shell, beside the terminal it opened over.
      assert.deepEqual(
        (({ target, tabId, sessionId, line, enter }) => ({ target, tabId, sessionId, line, enter }))(runs()[0][2]),
        { target: 'split', tabId: 't1', sessionId: 's1', line: 'echo hi', enter: true }
      );
    });
  });

  test('PRD-03: the plain Enter Chrome sends right after the one that commits a Hangul syllable is the syllable\'s — a later Enter runs', async () => {
    await onPage(async (p) => {
      await open(p, GREET);
      await letItRun(560);
      const field = p.document.activeElement;
      p.settled(() => dispatch(p.window, field, { type: 'compositionend', data: '\u{D55C}' }));
      p.keydown('Enter');
      assert.equal(runs().length, 0, 'the commit ran the command');
      await letItRun(150);
      p.keydown('Enter');
      assert.equal(runs().length, 1);
    });
  });
});

describe('Run dialog, mounted: the terminal it was opened over', () => {
  beforeEach(fresh);

  test('PRD-04: another terminal made active behind it is not where it types — the one it opened over is', async () => {
    await onPage(async (p) => {
      await open(p, PLAIN);
      p.settled(() => ui.useTerminalStore.setState({ activeTabId: 't2' }));
      // …and the dialog drawn again meanwhile (its terminal moved on).
      p.settled(() => ui.useTerminalStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === 't1' ? { ...t, cwd: '/w/sub' } : t)) })));
      assert.match(p.document.querySelector('[data-run-target="this"]').textContent, /This terminal \(api\)/);
      await letItRun(560);
      keyClick(p, runButton(p));
      assert.equal(runs()[0][2].tabId, 't1');
      assert.equal(runs()[0][2].sessionId, 's1');
    });
  });

  test('PRD-05: a terminal that becomes busy keeps the choice — Type off, saying why — and never switches to a new split by itself', async () => {
    await onPage(async (p) => {
      await open(p, PLAIN);
      assert.equal(radio(p, 'split').checked, true, 'a new split by default');
      choose(p, 'this');
      assert.equal(radio(p, 'this').checked, true);
      p.settled(() => ui.useTerminalStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === 't1' ? { ...t, running: true } : t)) })));
      assert.equal(radio(p, 'this').checked, true, 'switched to another target by itself');
      assert.equal(radio(p, 'split').checked, false);
      assert.ok(typeButton(p).hasAttribute('disabled'), 'Type is on over a busy terminal');
      assert.equal(why(p), 'This terminal: something is running in it.');
      await letItRun(560);
      keyClick(p, typeButton(p));
      assert.equal(runs().length, 0);
      p.settled(() => ui.useTerminalStore.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, running: false })) })));
      assert.ok(!typeButton(p).hasAttribute('disabled'));
      assert.equal(why(p), '');
      keyClick(p, typeButton(p));
      assert.equal(runs()[0][2].target, 'this', 'no split made');
    });
  });

  test('PRD-09: into the terminal already open the line is only typed — Type is the button, Run is off and the dialog says why; Enter in a field types without Enter', async () => {
    await onPage(async (p) => {
      await open(p, GREET);
      choose(p, 'this');
      assert.equal(typeButton(p).textContent, 'Type');
      assert.ok(runButton(p).hasAttribute('disabled'), 'Run (with Enter) into a terminal already open');
      assert.match(p.document.querySelector('[data-run-mode]').textContent, /typed and left for you to press Enter — NexTerm cannot be sure its prompt is empty/);
      assert.match(typeButton(p).getAttribute('class'), /bg-vsc-accent/, 'Type is not the button to press');
      await letItRun(560);
      p.document.querySelector('[id="project-blank-who"]').focus();
      p.keydown('Enter');
      assert.equal(runs().length, 1);
      assert.equal(runs()[0][2].target, 'this');
      assert.equal(runs()[0][2].enter, false, 'an Enter sent into a terminal already open');
    });
  });

  test('PRD-06: closed behind the dialog, its terminal is not replaced by another of the same name — Run off, saying why', async () => {
    await onPage(async (p) => {
      await open(p, PLAIN);
      p.settled(() =>
        ui.useTerminalStore.setState({ tabs: [{ id: 't3', title: 'api', shell: '/bin/zsh', sessionId: 's3' }], activeTabId: 't3' })
      );
      assert.ok(runButton(p).hasAttribute('disabled'));
      assert.equal(why(p), 'New split: the terminal it would split beside has closed.');
      choose(p, 'this');
      assert.equal(why(p), 'This terminal: that terminal has closed.');
    });
  });

  test('PRD-07: text typed at its prompt, or the folder\'s file changed under it: Run off, saying why in words', async () => {
    await onPage(async (p) => {
      await open(p, PLAIN);
      choose(p, 'this');
      p.settled(() => ui.useTerminalStore.setState({ blocks: { t1: 'something is typed at its prompt — clear it, or use New split' } }));
      assert.equal(why(p), 'This terminal: something is typed at its prompt — clear it, or use New split.');
      p.settled(() => ui.useTerminalStore.setState({ blocks: {} }));
      p.settled(() => ui.useProjectCommandsStore.setState({ problem: "this folder's commands file has changed since this opened — review it again" }));
      assert.equal(why(p), "This folder's commands file has changed since this opened — review it again.");
      await letItRun(560);
      p.keydown('Enter');
      keyClick(p, runButton(p));
      assert.equal(runs().length, 0);
    });
  });

  test("PRD-08: while it is open the app's chords and menu are held off (modalLock), and let go when it closes", async () => {
    await onPage(async (p) => {
      assert.equal(ui.modalHeld(), false);
      await open(p, PLAIN);
      assert.equal(ui.modalHeld(), true);
      p.keydown('Escape');
      await letItRun();
      assert.equal(ui.useProjectCommandsStore.getState().running, null, 'Escape cancels');
      assert.equal(ui.modalHeld(), false);
    });
  });
});
