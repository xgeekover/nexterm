/**
 * The command palette (src/components/command/CommandPalette.jsx), mounted.
 *
 * What it lists is plain data, pinned in palette_results.test.js. What it
 * does with the list is not: which backend list it asks for and when, what a
 * move of the mouse redraws. Those live in effects and handlers that
 * `renderToString` never runs, so the palette is rendered here with real
 * React on a page written by hand (react_page.js), and driven the way a user
 * drives it.
 *
 * Node cannot import a .jsx file, so the component is bundled with esbuild
 * and imported from a data: URL, as confirm_dialog.test.js does. Its stores,
 * the IPC bridge, the command history and the icons are stood in for: the
 * stores are real zustand stores holding what a case puts there, the bridge
 * answers what a case says, and every icon counts how often it is drawn —
 * which is how a row drawn again shows.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun } from './react_page.js';

const h = React.createElement;

// ---- The component, bundled with stand-ins -----------------------------------

const COMMAND_DIR = fileURLToPath(new URL('../../src/components/command/', import.meta.url));
/** Kept real: the React the page renders with must be the one the component calls. */
const REAL = new Set(['react', 'react/jsx-runtime', 'zustand']);

const STAND_INS = {
  calls: `export const calls = [];`,
  settingsStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useSettingsStore = create((set) => ({
      isCommandPaletteOpen: false,
      commandPaletteMode: 'all',
      keybindings: {},
      activeView: 'terminal',
      setCommandPaletteOpen: (open, mode = 'all') =>
        set({ isCommandPaletteOpen: open, commandPaletteMode: open ? mode : 'all' }),
      setActiveView: (activeView) => {
        calls.push(['setActiveView', activeView]);
        set({ activeView });
      },
    }));`,
  editorStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useEditorStore = create((set, get) => ({
      fileTree: [],
      rootPath: '/w',
      recentRoots: [],
      tabs: [],
      activeTabId: null,
      getActiveTab: () => get().tabs.find((t) => t.id === get().activeTabId) || null,
      openFile: async (path) => {
        calls.push(['openFile', path]);
        return { id: 'tab-1', filePath: path };
      },
      openRoot: async (path) => {
        calls.push(['openRoot', path]);
        return path;
      },
      saveAll: async () => {
        calls.push(['saveAll']);
      },
      focusEditor: () => {
        calls.push(['focusEditor']);
      },
    }));`,
  terminalStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useTerminalStore = create(() => ({
      activeTabId: 't1',
      activeGroupId: 'g1',
      groups: [{ id: 'g1', activePaneId: 'pane-1' }],
      writeRaw: async (tabId, data) => {
        calls.push(['writeRaw', tabId, data]);
      },
      createTab: async () => {
        calls.push(['createTab']);
      },
      clearBlocks: () => {
        calls.push(['clearBlocks']);
      },
      togglePaneZoom: () => {
        calls.push(['togglePaneZoom']);
      },
    }));`,
  ipc: `
    export const bridge = { answer: null, asked: [], listeners: new Map() };
    export async function invoke(command, args) {
      bridge.asked.push([command, args]);
      if (!bridge.answer) throw new Error('Unknown IPC command: ' + command);
      return bridge.answer(command, args);
    }
    export async function listen(event, callback) {
      if (!bridge.listeners.has(event)) bridge.listeners.set(event, new Set());
      bridge.listeners.get(event).add(callback);
      return () => bridge.listeners.get(event)?.delete(callback);
    }
    export function emit(event, payload) {
      for (const callback of [...(bridge.listeners.get(event) ?? [])]) callback(payload);
    }`,
  commandIndex: `
    export const historyEntries = [];
    export function commandHistory() {
      return [...historyEntries];
    }`,
  lucide: `
    export const renders = {};
    const icon = (name) => function Icon() {
      renders[name] = (renders[name] || 0) + 1;
      return null;
    };
    export const Search = icon('Search');
    export const FileCode = icon('FileCode');
    export const FolderOpen = icon('FolderOpen');
    export const History = icon('History');
    export const Terminal = icon('Terminal');
    export const Save = icon('Save');
    export const Maximize2 = icon('Maximize2');`,
};

/** Which stand-in a module the component imports is replaced by, if any. */
function standInFor(path) {
  if (path === 'stand-in:calls') return 'calls';
  if (path === 'lucide-react') return 'lucide';
  const store = /\/stores\/(settings|editor|terminal)Store\.js$/.exec(path);
  if (store) return `${store[1]}Store`;
  if (/\/lib\/ipc\.js$/.test(path)) return 'ipc';
  if (/\/lib\/commandIndex\.js$/.test(path)) return 'commandIndex';
  return null;
}

let loading = null;
function loadPalette() {
  loading ??= build({
    stdin: {
      contents: [
        "export * from './CommandPalette.jsx';",
        "export { useSettingsStore } from '../../stores/settingsStore.js';",
        "export { useEditorStore } from '../../stores/editorStore.js';",
        "export { useTerminalStore } from '../../stores/terminalStore.js';",
        "export { bridge, emit } from '../../lib/ipc.js';",
        "export { historyEntries } from '../../lib/commandIndex.js';",
        "export { renders } from 'lucide-react';",
        "export { calls } from 'stand-in:calls';",
      ].join('\n'),
      resolveDir: COMMAND_DIR,
      sourcefile: 'palette-under-test.js',
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
        name: 'palette-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            const standIn = standInFor(args.path);
            return standIn ? { path: standIn, namespace: 'stand-in' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({
            contents: STAND_INS[args.path],
            loader: 'js',
            resolveDir: COMMAND_DIR,
          }));
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

let ui = null;

/** Every case starts from a closed palette, a backend with no file list, and nothing called. */
async function fresh() {
  ui = await loadPalette();
  for (const store of [ui.useSettingsStore, ui.useEditorStore, ui.useTerminalStore]) {
    store.setState(store.getInitialState(), true);
  }
  ui.bridge.answer = null;
  ui.bridge.asked.length = 0;
  ui.bridge.listeners.clear();
  ui.historyEntries.length = 0;
  ui.calls.length = 0;
  for (const name of Object.keys(ui.renders)) delete ui.renders[name];
}

/** `n` files directly in the folder, as the Explorer's tree holds them. */
const flatTree = (n) =>
  Array.from({ length: n }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.js`, path: `/w/f${String(i).padStart(3, '0')}.js`, is_dir: false }));

/** The backend answering `fs_list_files` with `files`, and refusing anything else. */
const listing = (files, truncated = false) => (command) => {
  if (command !== 'fs_list_files') throw new Error(`Unknown IPC command: ${command}`);
  return { files, truncated };
};

/** Open the palette as a shortcut does, and wait for it to settle: its input focused, the backend asked. */
async function openPalette(p, mode) {
  p.settled(() => ui.useSettingsStore.getState().setCommandPaletteOpen(true, mode));
  await letItRun(60);
}

/** The result rows on the page — what has a pointer cursor — and the words each shows. */
const rows = (p) => p.document.querySelectorAll('div').filter((d) => (d.getAttribute('class') || '').includes('cursor-pointer'));
const rowTitles = (p) => rows(p).map((r) => r.childNodes[1]?.textContent);
const isSelected = (row) => (row.getAttribute('class') || '').includes('bg-vsc-selection');
const asked = (command) => ui.bridge.asked.filter(([c]) => c === command).length;

describe('Command palette, mounted: drawing the list', () => {
  beforeEach(fresh);

  test('PM-01: moving the mouse over the list redraws the two rows whose selection changed — not every row', async () => {
    await onPage(async (p) => {
      ui.useEditorStore.setState({ fileTree: flatTree(50) });
      ui.bridge.answer = listing(flatTree(50).map((n) => n.path));
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      assert.equal(rows(p).length, 50, 'precondition: fifty rows');
      assert.ok(isSelected(rows(p)[0]), 'the first row starts selected');

      const before = ui.renders.FileCode;
      await p.hover(rows(p)[10]);
      assert.ok(isSelected(rows(p)[10]), 'the row under the pointer is selected');
      assert.ok(!isSelected(rows(p)[0]), 'and the first one is not any more');
      const redrawn = ui.renders.FileCode - before;
      assert.ok(redrawn <= 2, `${redrawn} rows were drawn again for one move of the mouse`);

      const again = ui.renders.FileCode;
      await p.hover(rows(p)[10]);
      assert.equal(ui.renders.FileCode - again, 0, 'the row already selected, nothing to draw');
    });
  });
});

describe('Command palette, mounted: the files Go to File lists', () => {
  beforeEach(fresh);

  test('PM-02: it lists every file the backend lists — one six levels down included — not the Explorer\'s tree', async () => {
    await onPage(async (p) => {
      const deep = '/w/src/main/java/com/acme/app/App.java';
      ui.useEditorStore.setState({ fileTree: flatTree(1) });
      ui.bridge.answer = listing([deep, '/w/f000.js']);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      assert.deepEqual(rowTitles(p), ['App.java', 'f000.js']);
      assert.deepEqual(ui.bridge.asked.find(([c]) => c === 'fs_list_files')?.[1], { limit: 20000 }, 'asked for, with the limit said out loud');
    });
  });

  test('PM-03: while it is open, a change on disk is listed once things settle; closed, it is not asked again', async () => {
    await onPage(async (p) => {
      let files = ['/w/a.js'];
      ui.bridge.answer = (command) => listing(files)(command);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      assert.deepEqual(rowTitles(p), ['a.js']);

      files = ['/w/a.js', '/w/b.js'];
      ui.emit('fs-change', { path: '/w/b.js', kind: 'create' });
      ui.emit('fs-change', { path: '/w/b.js', kind: 'modify' });
      await letItRun(350);
      assert.deepEqual(rowTitles(p), ['a.js', 'b.js']);
      assert.equal(asked('fs_list_files'), 2, 'a burst of changes is listed once');

      p.settled(() => ui.useSettingsStore.getState().setCommandPaletteOpen(false));
      ui.emit('fs-change', { path: '/w/c.js', kind: 'create' });
      await letItRun(350);
      assert.equal(asked('fs_list_files'), 2, 'listed again while closed');
    });
  });

  test('PM-04: a backend without the command leaves the Explorer\'s files listed', async () => {
    await onPage(async (p) => {
      const warn = console.warn;
      console.warn = () => {};
      try {
        ui.useEditorStore.setState({ fileTree: flatTree(2) });
        p.render(h(ui.CommandPalette));
        await openPalette(p, 'files');
      } finally {
        console.warn = warn;
      }
      assert.deepEqual(rowTitles(p), ['f000.js', 'f001.js']);
    });
  });

  test('PM-05: asked once each time it opens to list files — not for every key, and not for command history', async () => {
    await onPage(async (p) => {
      ui.bridge.answer = listing(['/w/a.js', '/w/b.js']);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      p.keydown('ArrowDown');
      p.keydown('ArrowDown');
      assert.equal(asked('fs_list_files'), 1);
      p.keydown('Escape');
      await openPalette(p, 'history');
      assert.equal(asked('fs_list_files'), 1, 'command history lists no files');
      p.keydown('Escape');
      await openPalette(p, 'all');
      assert.equal(asked('fs_list_files'), 2);
    });
  });

  test('PM-06: a list the backend cut short says so, under the rows', async () => {
    await onPage(async (p) => {
      ui.bridge.answer = listing(['/w/a.js'], true);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      assert.deepEqual(rowTitles(p), ['a.js']);
      assert.ok(p.document.body.textContent.includes('Only the first 20,000 files in this folder are searched'));
    });
  });
});

// ---- Where the keyboard goes when it closes ----------------------------------

/**
 * The terminal pane and the editor as the app draws them — what the palette
 * gives the keyboard to — and the title bar's search box, which opens it.
 */
function workspace(p) {
  const pane = p.el('div', { 'data-pane-body': 'pane-1' });
  const xterm = p.el('div', { class: 'xterm' }, pane);
  const terminal = p.el('textarea', { class: 'xterm-helper-textarea' }, xterm);
  const monaco = p.el('div', { class: 'monaco-editor' });
  const editor = p.el('textarea', { class: 'inputarea' }, monaco);
  const searchBox = p.el('button', { title: 'Search NexTerm' });
  return { terminal, editor, searchBox };
}

/**
 * What has the keyboard, by name: one of `named`, 'page' for nothing, or a
 * tag. Never the element itself in an assertion — a failing one would print
 * it, React's whole tree hanging off it, at a depth that runs Node out of
 * memory.
 */
function focusIs(p, named) {
  const el = p.document.activeElement;
  for (const [name, node] of Object.entries(named)) if (node === el) return name;
  return el === p.document.body ? 'page' : el.tagName;
}
const called = (name) => ui.calls.filter(([c]) => c === name);

/**
 * Closing the palette unmounted its input, and the keyboard fell to the
 * page. A command picked from history was typed into the prompt and Enter
 * then ran nothing until the terminal was clicked; on Windows and Linux the
 * next Ctrl+W, a word erased in the shell, reached the app's Close Pane.
 */
describe('Command palette, mounted: the keyboard after it closes', () => {
  beforeEach(fresh);

  test('PM-07: Escape gives the keyboard back to the terminal the palette was opened from', async () => {
    await onPage(async (p) => {
      const { terminal } = workspace(p);
      terminal.focus();
      ui.bridge.answer = listing(['/w/a.js']);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      assert.equal(focusIs(p, { terminal }), 'INPUT', 'precondition: the palette has the keyboard');
      p.keydown('Escape');
      assert.equal(focusIs(p, { terminal }), 'terminal');
    });
  });

  test('PM-08: a command picked from history is typed into the active terminal, and the keyboard goes there — even from the editor', async () => {
    await onPage(async (p) => {
      ui.historyEntries.push({ command: 'npm test', cwd: '/w', count: 3 });
      const { terminal, editor } = workspace(p);
      editor.focus();
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'history');
      p.keydown('Enter');
      await letItRun();
      assert.deepEqual(called('writeRaw'), [['writeRaw', 't1', 'npm test']]);
      assert.equal(focusIs(p, { terminal, editor }), 'terminal', 'Enter would not run it — and in the editor it would start a new line');
    });
  });

  test('PM-09: a file picked: its editor is asked for the keyboard once it is open, and the terminal is not handed it on the way', async () => {
    await onPage(async (p) => {
      const { terminal } = workspace(p);
      terminal.focus();
      let handed = 0;
      const focusTerminal = terminal.focus.bind(terminal);
      terminal.focus = () => {
        handed += 1;
        focusTerminal();
      };
      ui.bridge.answer = listing(['/w/a.js']);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      p.keydown('Enter');
      await letItRun();
      assert.deepEqual(ui.calls.map(([c]) => c).filter((c) => c === 'openFile' || c === 'focusEditor'), ['openFile', 'focusEditor']);
      assert.equal(handed, 0, 'a program in the terminal was told it had focus, then that it had lost it');
    });
  });

  test('PM-10: a file that cannot be opened gives the keyboard back where it was', async () => {
    await onPage(async (p) => {
      const { terminal } = workspace(p);
      terminal.focus();
      ui.bridge.answer = listing(['/w/huge.min.js']);
      ui.useEditorStore.setState({
        openFile: async (path) => {
          ui.calls.push(['openFile', path]);
          throw new Error('File is too large to open');
        },
      });
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      const report = console.error;
      console.error = () => {};
      try {
        p.keydown('Enter');
        await letItRun();
      } finally {
        console.error = report;
      }
      assert.deepEqual(called('focusEditor'), []);
      assert.equal(focusIs(p, { terminal }), 'terminal');
    });
  });

  test('PM-11: closed from outside — the chord that opens it, pressed again — the keyboard goes back too', async () => {
    await onPage(async (p) => {
      const { terminal } = workspace(p);
      terminal.focus();
      ui.bridge.answer = listing(['/w/a.js']);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'all');
      p.settled(() => ui.useSettingsStore.getState().setCommandPaletteOpen(false));
      assert.equal(focusIs(p, { terminal }), 'terminal');
    });
  });

  test('PM-12: a click outside the box closes it and gives the keyboard back', async () => {
    await onPage(async (p) => {
      const { terminal } = workspace(p);
      terminal.focus();
      ui.bridge.answer = listing(['/w/a.js']);
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'files');
      const backdrop = p.document.querySelectorAll('div').find((d) => (d.getAttribute('class') || '').startsWith('fixed inset-0'));
      p.click(backdrop);
      assert.equal(ui.useSettingsStore.getState().isCommandPaletteOpen, false);
      assert.equal(focusIs(p, { terminal }), 'terminal');
    });
  });

  test('PM-13: opened from the title bar\'s search box, or with what had the keyboard gone, it goes to the active terminal', async () => {
    await onPage(async (p) => {
      const { terminal, searchBox } = workspace(p);
      ui.bridge.answer = listing(['/w/a.js']);
      p.render(h(ui.CommandPalette));

      // Chromium focuses a button that is clicked: given it back, the next
      // Enter would open the palette again.
      searchBox.focus();
      await openPalette(p, 'all');
      p.keydown('Escape');
      assert.equal(focusIs(p, { terminal, searchBox }), 'terminal');

      const rename = p.el('input');
      rename.focus();
      await openPalette(p, 'all');
      rename.parentNode.removeChild(rename);
      p.keydown('Escape');
      assert.equal(focusIs(p, { terminal }), 'terminal', 'what had it left the page');
    });
  });

  test('PM-14: a folder from Open Recent: the keyboard is back where it was before the folder opens — so a question it asks gives it back there', async () => {
    await onPage(async (p) => {
      const { terminal } = workspace(p);
      terminal.focus();
      ui.useEditorStore.setState({
        recentRoots: ['/x/alpha'],
        openRoot: async (path) => {
          // "Save a.js?" opens here, and remembers what has the keyboard.
          ui.calls.push(['openRoot', path, focusIs(p, { terminal })]);
          return path;
        },
      });
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'recent');
      p.keydown('Enter');
      await letItRun();
      const [[, path, heldBy]] = called('openRoot');
      assert.equal(path, '/x/alpha');
      assert.equal(heldBy, 'terminal', 'what had the keyboard when the folder was opened');
    });
  });

  test('PM-15: with no terminal on screen and nothing to give it back to, the file open in the editor takes the keyboard — and with neither, nothing is asked', async () => {
    await onPage(async (p) => {
      // The terminal panel hidden: no pane drawn. Opened from the title bar.
      const searchBox = p.el('button', { title: 'Search NexTerm' });
      ui.useEditorStore.setState({ tabs: [{ id: 'e1', filePath: '/w/a.js' }], activeTabId: 'e1' });
      ui.bridge.answer = listing(['/w/a.js']);
      p.render(h(ui.CommandPalette));
      searchBox.focus();
      await openPalette(p, 'all');
      p.keydown('Escape');
      assert.deepEqual(called('focusEditor'), [['focusEditor']], 'the keyboard was left on the page');

      ui.useEditorStore.setState({ tabs: [], activeTabId: null });
      searchBox.focus();
      await openPalette(p, 'all');
      p.keydown('Escape');
      assert.deepEqual(called('focusEditor'), [['focusEditor']], 'no file is open, so there is no editor to ask');
      assert.equal(focusIs(p, { searchBox }), 'page');
    });
  });

  test('PM-16: the terminal is given the keyboard without scrolling it into view, as xterm gives it itself', async () => {
    await onPage(async (p) => {
      ui.historyEntries.push({ command: 'npm test', cwd: '/w', count: 3 });
      const { terminal } = workspace(p);
      terminal.focus();
      const asked = [];
      const focusTerminal = terminal.focus.bind(terminal);
      terminal.focus = (options) => {
        asked.push(options);
        focusTerminal();
      };
      ui.bridge.answer = listing(['/w/a.js']);
      p.render(h(ui.CommandPalette));

      await openPalette(p, 'files');
      p.keydown('Escape');
      await openPalette(p, 'history');
      p.keydown('Enter');
      await letItRun();
      assert.equal(focusIs(p, { terminal }), 'terminal');
      // The textarea xterm types through follows the cursor: brought into
      // view, it scrolled the terminal's box.
      assert.deepEqual(asked, [{ preventScroll: true }, { preventScroll: true }]);
    });
  });
});
