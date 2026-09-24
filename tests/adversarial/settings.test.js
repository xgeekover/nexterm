/**
 * Settings store: the VS Code-style Settings window (SettingsWindow.jsx)
 * writes exclusively through `setSetting`/`resetSettings` and reads
 * `settingsDefaults` to decide when to show a per-row "Reset" affordance.
 * These tests hold the store itself to that contract — the UI layer owns
 * range-clamping (font size 8-32, line height 1-2, tab size 1-8, scrollback
 * 100-100000), so it is not re-asserted here.
 */
import { describe, test, beforeEach, assert, afterEach} from '../e2e/harness/testFramework.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useSystemStore } from '../../src/stores/systemStore.js';
import { useTerminalStore as T, PERSIST_KEY } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { resolveStartDir } from '../../src/lib/terminalCwd.js';

if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

const S = useSettingsStore;

// Every key the Settings window renders a control for.
const SETTINGS_KEYS = [
  // Rendered by KeybindingSettings rather than by a SettingRow — a table of
  // commands, not a single control — but it is still a setting the window
  // edits and persists.
  'keybindings',
  'terminalFontFamily',
  'terminalFontSize',
  'terminalLineHeight',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalScrollback',
  'terminalTheme',
  'terminalSuggestions',
  'terminalStickyHeader',
  'terminalDefaultShell',
  'terminalDefaultCwd',
  'terminalDefaultCwdPath',
  'terminalNotifyAfterSeconds',
  'editorFontSize',
  'editorTabSize',
  'editorWordWrap',
  'editorMinimap',
  'reducedMotion',
];

describe('Settings store: setSetting / resetSettings contract', () => {
  beforeEach(() => {
    S.getState().resetSettings();
  });

  test('SET-01: settingsDefaults has an entry for every setting the window exposes', () => {
    const defaults = S.getState().settingsDefaults;
    for (const key of SETTINGS_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(defaults, key),
        `settingsDefaults is missing "${key}"`
      );
    }
  });

  test('SET-02: settingsDefaults has no stray keys the window does not render', () => {
    const defaults = S.getState().settingsDefaults;
    for (const key of Object.keys(defaults)) {
      assert.ok(SETTINGS_KEYS.includes(key), `settingsDefaults has an unexpected key "${key}"`);
    }
  });

  test('SET-03: the live store value for every default starts out equal to its default', () => {
    const defaults = S.getState().settingsDefaults;
    for (const key of SETTINGS_KEYS) {
      assert.deepEqual(S.getState()[key], defaults[key], `initial ${key} must match settingsDefaults`);
    }
  });

  test('SET-04: setSetting writes exactly the key it is given, immediately', () => {
    S.getState().setSetting('terminalFontSize', 18);
    assert.equal(S.getState().terminalFontSize, 18);
    // Sibling settings must be untouched.
    assert.equal(S.getState().editorFontSize, S.getState().settingsDefaults.editorFontSize);
    assert.equal(S.getState().terminalScrollback, S.getState().settingsDefaults.terminalScrollback);
  });

  test('SET-05: setSetting round-trips every settings key', () => {
    const probes = {
      terminalFontFamily: 'Fira Code, monospace',
      terminalFontSize: 20,
      terminalLineHeight: 1.8,
      terminalCursorStyle: 'block',
      terminalCursorBlink: false,
      terminalScrollback: 10000,
      terminalTheme: 'dracula',
      terminalSuggestions: false,
      editorFontSize: 16,
      editorTabSize: 4,
      editorWordWrap: true,
      editorMinimap: false,
      reducedMotion: true,
    };
    const defaults = S.getState().settingsDefaults;

    for (const [key, value] of Object.entries(probes)) {
      // Every probe must actually differ from its default, otherwise a
      // no-op setSetting could pass this test by accident.
      assert.notEqual(value, defaults[key], `probe for "${key}" must differ from its default`);
      S.getState().setSetting(key, value);
      assert.deepEqual(S.getState()[key], value, `setSetting did not round-trip "${key}"`);
    }
  });

  test('SET-06: resetSettings restores every key to settingsDefaults in one call', () => {
    S.getState().setSetting('terminalFontSize', 30);
    S.getState().setSetting('terminalCursorStyle', 'underline');
    S.getState().setSetting('editorWordWrap', true);
    S.getState().setSetting('editorMinimap', false);

    S.getState().resetSettings();

    const defaults = S.getState().settingsDefaults;
    for (const key of SETTINGS_KEYS) {
      assert.deepEqual(S.getState()[key], defaults[key], `resetSettings did not restore "${key}"`);
    }
  });

  test('SET-07: resetSettings leaves unrelated shell/window state alone', () => {
    S.getState().setSettingsModalOpen(true);
    S.getState().setSetting('terminalScrollback', 42000);

    S.getState().resetSettings();

    assert.equal(S.getState().isSettingsModalOpen, true, 'resetSettings must not close the Settings window');
    assert.equal(S.getState().terminalScrollback, S.getState().settingsDefaults.terminalScrollback);

    S.getState().setSettingsModalOpen(false);
  });
});

describe('Settings survive a restart', () => {
  // Every setting used to live only in memory: the store never touched
  // persistence.js, so picking a terminal theme or a font size and relaunching
  // put it straight back to the default — while the terminal TABS came back
  // correctly, which made it look like a bug rather than a design choice.
  const KEY = 'nexterm.settings';
  const backing = new Map();
  let borrowed = null;

  const useOwnStorage = () => {
    borrowed = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
      removeItem: (k) => backing.delete(k),
      clear: () => backing.clear(),
    };
    backing.clear();
  };
  const returnStorage = () => {
    globalThis.localStorage = borrowed;
    borrowed = null;
  };

  /** Re-import the store as if the app had just started. */
  const relaunch = () =>
    import(`../../src/stores/settingsStore.js?relaunch=${Math.random()}`);

  beforeEach(useOwnStorage);
  afterEach(returnStorage);

  test('ST-20: a changed setting is written and read back on the next launch', async () => {
    const first = await relaunch();
    first.useSettingsStore.getState().setSetting('terminalTheme', 'dracula');
    first.useSettingsStore.getState().setSetting('terminalFontSize', 16);
    assert.ok(backing.get(KEY), 'nothing reached storage');

    const next = await relaunch();
    assert.equal(next.useSettingsStore.getState().terminalTheme, 'dracula');
    assert.equal(next.useSettingsStore.getState().terminalFontSize, 16);
  });

  test('ST-21: resetting is remembered too', async () => {
    const first = await relaunch();
    first.useSettingsStore.getState().setSetting('terminalTheme', 'nord');
    first.useSettingsStore.getState().resetSettings();

    const next = await relaunch();
    assert.equal(
      next.useSettingsStore.getState().terminalTheme,
      next.useSettingsStore.getState().settingsDefaults.terminalTheme
    );
  });

  test('ST-22: a corrupt or foreign payload falls back to the defaults', async () => {
    backing.set(KEY, '{{{ not json');
    let store = (await relaunch()).useSettingsStore.getState();
    assert.equal(store.terminalFontSize, 12);

    // wrong types and unknown keys are ignored rather than trusted
    backing.set(
      KEY,
      JSON.stringify({ version: 2, data: { terminalFontSize: 'huge', nonsense: 1, terminalTheme: 'nord' } })
    );
    store = (await relaunch()).useSettingsStore.getState();
    assert.equal(store.terminalFontSize, 12, 'a string font size must not be trusted');
    assert.equal(store.terminalTheme, 'nord', 'but a well-typed value still loads');
    assert.equal('nonsense' in store, false);
  });
});

describe('Where a new terminal starts', () => {
  const HOME = '/Users/dev';

  test('SET-10: a directory that was asked for beats the setting, always', () => {
    // This is session restore. Every saved terminal hands its own directory
    // to spawnTab, and v0.5.3 and v0.5.5 exist because those directories used
    // to be thrown away. A setting that overruled them would undo both.
    for (const mode of ['workspace', 'home', 'active', 'custom']) {
      assert.equal(
        resolveStartDir({
          requested: '/saved/where/it/was',
          mode,
          customPath: '/somewhere/else',
          homeDir: HOME,
          activeCwd: '/another/place',
        }),
        '/saved/where/it/was',
        `mode "${mode}" overruled a directory that was asked for`
      );
    }
  });

  test('SET-11: with nothing asked for, the setting decides', () => {
    const base = { homeDir: HOME, activeCwd: '/live/here', customPath: '~/work' };

    // null means "backend, you decide" — it owns the open-folder fallback and
    // is the only side that knows the canonical root.
    assert.equal(resolveStartDir({ ...base, mode: 'workspace' }), null);
    assert.equal(resolveStartDir({ ...base, mode: 'home' }), HOME);
    assert.equal(resolveStartDir({ ...base, mode: 'active' }), '/live/here');
    assert.equal(resolveStartDir({ ...base, mode: 'custom' }), '/Users/dev/work');
  });

  test('SET-12: a setting with no answer falls back rather than guessing', () => {
    // The first terminal of a session has no sibling to copy, a custom path
    // may be empty, and the home directory is unknown until the backend has
    // answered. None of those is a reason to invent a directory.
    assert.equal(resolveStartDir({ mode: 'active', activeCwd: null }), null);
    assert.equal(resolveStartDir({ mode: 'active', activeCwd: '   ' }), null);
    assert.equal(resolveStartDir({ mode: 'custom', customPath: '' }), null);
    assert.equal(resolveStartDir({ mode: 'home', homeDir: null }), null);
    assert.equal(resolveStartDir({}), null, 'no input at all is still safe');
    assert.equal(resolveStartDir({ mode: 'nonsense-from-an-old-config' }), null);
  });

  test('SET-13: a Windows custom path survives, separators and all', () => {
    assert.equal(
      resolveStartDir({ mode: 'custom', customPath: 'C:\\work\\proj', homeDir: 'C:\\Users\\dev' }),
      'C:\\work\\proj'
    );
    assert.equal(
      resolveStartDir({ mode: 'custom', customPath: '~\\proj', homeDir: 'C:\\Users\\dev' }),
      'C:\\Users\\dev\\proj'
    );
  });
});

describe('Every new terminal follows the setting, however it is made', () => {
  // SET-10..13 hold the rule; these hold the store to it. v0.6.0 applied the
  // setting inside `spawnTab`, and two ways of making a terminal went around
  // it: New Group handed `spawnTab` the active terminal's directory as though
  // it had been asked for — and an asked-for directory wins — and the first
  // terminal of a fresh start was spawned at the workspace root directly.
  // With a custom directory set, New Terminal and Split opened there and New
  // Group did not.
  const HOME = '/Users/dev';
  const settings = () => useSettingsStore.getState();

  /** Run `fn` with the setting in place, and put everything back afterwards. */
  async function withSetting({ mode, path = '', homeDir = HOME }, fn) {
    const before = {
      mode: settings().terminalDefaultCwd,
      path: settings().terminalDefaultCwdPath,
      system: useSystemStore.getState(),
    };
    settings().setSetting('terminalDefaultCwd', mode);
    settings().setSetting('terminalDefaultCwdPath', path);
    // `homeDir: null` is a backend that has not answered yet.
    useSystemStore.setState({ homeDir, isLoaded: homeDir !== null });
    try {
      await fn();
    } finally {
      settings().setSetting('terminalDefaultCwd', before.mode);
      settings().setSetting('terminalDefaultCwdPath', before.path);
      useSystemStore.setState(before.system, true);
    }
  }

  /** The directory each new shell asked for while `fn` ran, and every command sent. */
  async function spawnsDuring(fn) {
    const original = mockBridge.invoke;
    const sent = [];
    mockBridge.invoke = function (command, args, ...rest) {
      sent.push({ command, args });
      return original.call(this, command, args, ...rest);
    };
    try {
      await fn();
    } finally {
      mockBridge.invoke = original;
    }
    return {
      asked: sent.filter((c) => c.command === 'pty_spawn').map((c) => c.args?.cwd ?? null),
      commands: sent.map((c) => c.command),
    };
  }

  /** A launch with nothing saved, so the bootstrap spawns the first terminal itself. */
  async function freshStart() {
    T.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
    T.setState({ tabs: [], activeTabId: null, isInitialized: false });
    await T.getState().init();
  }

  /** Move the active terminal where no setting points, so copying it would show. */
  async function wanderOff() {
    const tab = T.getState().getActiveTab();
    await mockBridge.emit('pty-cwd', { session_id: tab.sessionId, cwd: '/workspace/tests' });
  }

  test('SET-14: New Group starts at home when the setting says home', async () => {
    await freshStart();
    await wanderOff();
    await withSetting({ mode: 'home' }, async () => {
      const { asked } = await spawnsDuring(() => T.getState().createGroup({ name: 'Home' }));
      assert.deepEqual(asked, [HOME], "New Group started in the active terminal's directory instead");
      assert.equal(T.getState().getActiveTab().cwd, HOME);
    });
  });

  test('SET-15: a directory handed to New Group still beats the setting', async () => {
    await freshStart();
    for (const mode of ['workspace', 'home', 'active', 'custom']) {
      await withSetting({ mode, path: '/workspace/tests' }, async () => {
        const { asked } = await spawnsDuring(() => T.getState().createGroup({ cwd: '/workspace/src' }));
        assert.deepEqual(asked, ['/workspace/src'], `mode "${mode}" overruled a directory that was asked for`);
      });
    }
  });

  test('SET-16: under the default setting New Group starts where New Terminal does, not beside the active terminal', async () => {
    // A change, and a deliberate one: New Group used to open in the active
    // terminal's directory under every setting.
    await freshStart();
    await wanderOff();
    await withSetting({ mode: 'workspace' }, async () => {
      const { asked } = await spawnsDuring(async () => {
        await T.getState().createTab();
        await T.getState().createGroup();
      });
      // null is "backend, you decide" — the open folder, then home.
      assert.deepEqual(asked, [null, null], 'New Terminal and New Group disagree about where to start');
    });

    // Starting beside the active terminal is still there, as its own setting.
    await wanderOff();
    await withSetting({ mode: 'active' }, async () => {
      const { asked } = await spawnsDuring(() => T.getState().createGroup());
      assert.deepEqual(asked, ['/workspace/tests']);
    });
  });

  test('SET-17: the first terminal of a fresh start opens where the setting says', async () => {
    await withSetting({ mode: 'custom', path: '/workspace/src' }, async () => {
      const { asked } = await spawnsDuring(freshStart);
      assert.deepEqual(asked, ['/workspace/src'], 'the first terminal ignored the setting');
      assert.equal(T.getState().tabs[0].cwd, '/workspace/src');
    });
  });

  test('SET-18: under the default setting a fresh start asks for exactly what it always did', async () => {
    // Nothing more, either: with the home directory not known yet, the
    // default setting must not wait on a round trip it has no use for.
    await withSetting({ mode: 'workspace', homeDir: null }, async () => {
      const { asked, commands } = await spawnsDuring(freshStart);
      assert.deepEqual(asked, ['/workspace'], 'the workspace root, as the bootstrap always asked');
      assert.equal(commands.includes('system_get_info'), false, 'waited on the home directory for nothing');
    });
  });

  test('SET-19: a fresh start that needs the home directory waits for it instead of falling back', async () => {
    // The status bar asks for the home directory at startup, racing the first
    // terminal. Losing that race used to put a `home` terminal in the
    // workspace root, with nothing to say why.
    const home = mockBridge.systemInfo.home_dir;
    await withSetting({ mode: 'home', homeDir: null }, async () => {
      const { asked } = await spawnsDuring(freshStart);
      assert.deepEqual(asked, [home]);
    });
    await withSetting({ mode: 'custom', path: '~/projects', homeDir: null }, async () => {
      const { asked } = await spawnsDuring(freshStart);
      assert.deepEqual(asked, [`${home}/projects`]);
    });
  });

  test('SET-20: teardown — leave the terminals disposed and nothing persisted', () => {
    T.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
  });
});
