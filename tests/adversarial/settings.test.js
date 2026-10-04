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
  'terminalCopyOnSelect',
  'terminalMouseReporting',
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
      terminalCopyOnSelect: false,
      terminalMouseReporting: false,
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

  /**
   * A mock backend whose shell cannot enter `locked` — a directory that exists,
   * so `start_dir` accepts it, and that the spawn itself then refuses, as a
   * real one does for a folder without execute permission.
   */
  async function withLockedDirectory(locked, fn) {
    const original = mockBridge.invoke;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_spawn' && args?.cwd === locked) {
        return Promise.reject(new Error('Permission denied (os error 13)'));
      }
      return original.call(this, command, args, ...rest);
    };
    try {
      await fn();
    } finally {
      mockBridge.invoke = original;
    }
  }

  test('SET-21: a setting naming a directory the shell cannot enter still gives a terminal', async () => {
    await freshStart();
    await withSetting({ mode: 'custom', path: '/workspace/locked' }, async () => {
      await withLockedDirectory('/workspace/locked', async () => {
        const before = T.getState().tabs.length;
        let created = null;
        const { asked } = await spawnsDuring(async () => {
          created = await T.getState().createTab();
        });
        assert.deepEqual(asked, ['/workspace/locked', null], 'tried the setting, then the default');
        assert.ok(created, 'New Terminal gave nothing at all');
        assert.equal(T.getState().tabs.length, before + 1);
      });
    });
  });

  test('SET-22: and a fresh start with that setting is not left without a terminal', async () => {
    // Before the setting existed the first terminal always asked for the
    // open folder, and could not fail this way.
    await withSetting({ mode: 'custom', path: '/workspace/locked' }, async () => {
      await withLockedDirectory('/workspace/locked', async () => {
        const { asked } = await spawnsDuring(freshStart);
        assert.deepEqual(asked, ['/workspace/locked', '/workspace']);
        assert.equal(T.getState().tabs.length, 1, 'the app started with no terminal');
        assert.equal(T.getState().isInitialized, true);
      });
    });
  });

  test('SET-23: the mock starts a terminal with no directory where the backend would', async () => {
    // `null` is "backend, you decide". The mock took it as the directory
    // itself, and the first `ls` in that terminal threw on it.
    const session = await mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: null });
    assert.equal(session.cwd, '/workspace');
    await mockBridge.invoke('pty_kill', { session_id: session.session_id });
  });

  test('SET-24: the mock and the backend agree on the directories every machine has', async () => {
    for (const path of ['/', '/workspace/..', mockBridge.systemInfo.home_dir]) {
      assert.equal(await mockBridge.invoke('fs_dir_exists', { path }), true, `${path} is a directory`);
    }
    assert.equal(await mockBridge.invoke('fs_dir_exists', { path: '/nowhere/at/all' }), false);
  });

  test('SET-25: teardown — leave the terminals disposed and nothing persisted', () => {
    T.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
  });
});

describe('Only what the user changed is saved', () => {
  // Every save used to write every key of SETTINGS_DEFAULTS, and a saved key
  // wins over the default when the app starts. So the first change anyone
  // made to any setting froze every default of that day into their storage,
  // and a default changed by a later release never reached them — had v0.6.0's
  // `terminalDefaultCwd: 'workspace'` ever needed to change, everyone who had
  // touched Settings would have kept the old one. Storage now holds what
  // differs from the defaults, as VS Code's settings.json does.
  const KEY = 'nexterm.settings';
  const backing = new Map();
  const ownStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };

  /**
   * Run `fn` against storage of its own, handed back in `finally` rather than
   * in an `afterEach`: the harness runs `afterEach` only after a case passes,
   * so a failing case would leave every later suite writing into this Map.
   */
  const withOwnStorage = (fn) => async () => {
    const borrowed = globalThis.localStorage;
    globalThis.localStorage = ownStorage;
    backing.clear();
    try {
      await fn();
    } finally {
      globalThis.localStorage = borrowed;
    }
  };

  /** Start the app: a fresh module instance, which reads storage as it is created. */
  const launch = () => import(`../../src/stores/settingsStore.js?relaunch=${Math.random()}`);

  /** The settings in storage right now — what the next launch reads over its defaults. */
  const saved = () => {
    const raw = backing.get(KEY);
    return raw == null ? {} : JSON.parse(raw).data;
  };

  /** A payload as v0.6.x wrote it. 2 is the version it stamped, and it has to keep loading. */
  const writtenByAnOlderRelease = (data) => backing.set(KEY, JSON.stringify({ version: 2, data }));

  test(
    'SET-26: changing a setting saves that setting and nothing else',
    withOwnStorage(async () => {
      const store = (await launch()).useSettingsStore;
      const defaults = store.getState().settingsDefaults;

      store.getState().setSetting('terminalTheme', 'dracula');
      assert.deepEqual(saved(), { terminalTheme: 'dracula' }, 'settings nobody touched were saved with it');

      store.getState().setSetting('terminalFontSize', 16);
      assert.deepEqual(saved(), { terminalTheme: 'dracula', terminalFontSize: 16 });

      // ⌘+ changes two settings, and saves those two.
      store.getState().zoomFont(1);
      assert.deepEqual(saved(), {
        terminalTheme: 'dracula',
        terminalFontSize: 17,
        editorFontSize: defaults.editorFontSize + 1,
      });
    })
  );

  test(
    'SET-27: a setting put back to its default leaves storage, shortcut overrides included',
    withOwnStorage(async () => {
      const store = (await launch()).useSettingsStore;
      const { setSetting, settingsDefaults } = store.getState();

      setSetting('terminalFontSize', 16);
      setSetting('terminalCursorStyle', 'block');
      // Typing the default back in, and the row's Reset — SettingsWindow's
      // `handleReset` — are both this call.
      setSetting('terminalFontSize', settingsDefaults.terminalFontSize);
      assert.deepEqual(saved(), { terminalCursorStyle: 'block' }, 'a default value stayed in storage');
      setSetting('terminalCursorStyle', settingsDefaults.terminalCursorStyle);
      assert.deepEqual(saved(), {});

      // The shortcut overrides are one object, and the Keyboard Shortcuts
      // section hands over a NEW one on every edit. An override is saved whole —
      // an unbinding (`null`) and a chord pair included...
      const overrides = { 'toggle-sidebar': null, 'split-right': ['mod+k', 'mod+\\'] };
      setSetting('keybindings', overrides);
      assert.deepEqual(saved(), { keybindings: overrides });

      // ...and resetting them one command at a time, as KeybindingSettings'
      // `reset` does, ends at `{}`: the default in content, never in identity.
      for (const commandId of Object.keys(overrides)) {
        const next = { ...store.getState().keybindings };
        delete next[commandId];
        setSetting('keybindings', next);
      }
      assert.deepEqual(store.getState().keybindings, {});
      assert.deepEqual(saved(), {}, 'an emptied override map was saved as though it were a change');
    })
  );

  test(
    'SET-28: Reset All and ⌘0 leave nothing saved for what they reset',
    withOwnStorage(async () => {
      const store = (await launch()).useSettingsStore;
      const s = store.getState();
      const defaults = s.settingsDefaults;

      s.setSetting('terminalTheme', 'nord');
      s.setSetting('editorWordWrap', true);
      s.zoomFont(2);
      assert.deepEqual(saved(), {
        terminalTheme: 'nord',
        editorWordWrap: true,
        terminalFontSize: defaults.terminalFontSize + 2,
        editorFontSize: defaults.editorFontSize + 2,
      });

      s.resetZoom();
      assert.deepEqual(saved(), { terminalTheme: 'nord', editorWordWrap: true }, '⌘0 left the font sizes saved');

      s.setSetting('keybindings', { 'new-terminal': 'mod+alt+t' });
      s.resetSettings();
      assert.deepEqual(saved(), {}, 'Reset All left settings in storage');

      // So the next launch is every default of the release it is.
      const next = (await launch()).useSettingsStore.getState();
      for (const key of Object.keys(next.settingsDefaults)) {
        assert.deepEqual(next[key], next.settingsDefaults[key], `${key} did not come back as the default`);
      }
    })
  );

  test(
    'SET-29: a default changed by a later release reaches everyone who never changed that setting',
    withOwnStorage(async () => {
      // Two module instances stand in for two releases. The older one shipped
      // a different scrollback default: editing its defaults before anything
      // is saved is exactly the difference between the two builds.
      const older = await launch();
      older.SETTINGS_DEFAULTS.terminalScrollback = 1000;
      older.useSettingsStore.setState({ terminalScrollback: 1000 });
      // The user changes something else entirely, which is a save.
      older.useSettingsStore.getState().setSetting('terminalTheme', 'nord');

      const newer = (await launch()).useSettingsStore.getState();
      assert.notEqual(newer.settingsDefaults.terminalScrollback, 1000, 'the two releases must disagree');
      assert.equal(
        newer.terminalScrollback,
        newer.settingsDefaults.terminalScrollback,
        "the older release's default was frozen into storage and outlived the release"
      );
      assert.equal(newer.terminalTheme, 'nord', 'what the user did change must still come back');
    })
  );

  test(
    'SET-30: a payload written by an older release loads as it always did, and the next save keeps only the changes',
    withOwnStorage(async () => {
      // Every key, as v0.6.x wrote it: three the user chose, and the rest
      // whatever the defaults were that day — which are today's.
      const defaults = S.getState().settingsDefaults;
      const chosen = {
        terminalTheme: 'nord',
        editorTabSize: 4,
        keybindings: { 'toggle-sidebar': 'mod+shift+e' },
      };
      const full = { ...defaults, ...chosen };
      writtenByAnOlderRelease(full);

      const store = (await launch()).useSettingsStore;
      for (const [key, value] of Object.entries(full)) {
        assert.deepEqual(store.getState()[key], value, `${key} did not load as it used to`);
      }

      store.getState().setSetting('reducedMotion', true);
      assert.deepEqual(
        saved(),
        { ...chosen, reducedMotion: true },
        "the next save kept the older release's copy of the defaults"
      );
    })
  );

  test(
    "SET-31: a saved value that is not today's default is kept, even if an older release had it as its default",
    withOwnStorage(async () => {
      // Say scrollback defaulted to 1000 when this payload was written. Nothing
      // in it says whether the user chose 1000 or never touched the setting, so
      // it stays: dropping it would be a guess, and a wrong guess costs someone
      // a setting they picked.
      const defaults = S.getState().settingsDefaults;
      assert.notEqual(defaults.terminalScrollback, 1000);
      writtenByAnOlderRelease({ ...defaults, terminalScrollback: 1000 });

      const store = (await launch()).useSettingsStore;
      assert.equal(store.getState().terminalScrollback, 1000);

      store.getState().setSetting('terminalTheme', 'nord');
      assert.deepEqual(saved(), { terminalScrollback: 1000, terminalTheme: 'nord' });

      assert.equal((await launch()).useSettingsStore.getState().terminalScrollback, 1000);
    })
  );

  test(
    'SET-32: unknown keys and wrong types are still ignored, and the next save does not write them back',
    withOwnStorage(async () => {
      writtenByAnOlderRelease({
        terminalFontSize: 'huge',
        editorWordWrap: 'yes',
        keybindings: ['not', 'a', 'map'],
        nonsense: 1,
        terminalTheme: 'nord',
      });

      const store = (await launch()).useSettingsStore;
      const state = store.getState();
      assert.equal(state.terminalFontSize, state.settingsDefaults.terminalFontSize);
      assert.equal(state.editorWordWrap, state.settingsDefaults.editorWordWrap);
      assert.deepEqual(state.keybindings, {});
      assert.equal('nonsense' in state, false);
      assert.equal(state.terminalTheme, 'nord');

      state.setSetting('reducedMotion', true);
      assert.deepEqual(saved(), { terminalTheme: 'nord', reducedMotion: true }, 'garbage was carried forward');
    })
  );

  test(
    'SET-33: an object setting is compared by content, whichever way round',
    withOwnStorage(async () => {
      // `keybindings` is the only object setting today, and its default is
      // empty, which lets a one-sided comparison pass. A later object setting
      // with something in its default must count an emptied or shortened value
      // as a change, and the same entries in another order as none — or that
      // setting freezes into storage exactly as every default used to.
      const app = await launch();
      const LATER_DEFAULT = { a: ['x', 'y'], b: null };
      app.SETTINGS_DEFAULTS.laterObjectSetting = LATER_DEFAULT;
      const { setSetting } = app.useSettingsStore.getState();

      setSetting('laterObjectSetting', { b: null, a: ['x', 'y'] });
      assert.deepEqual(saved(), {}, 'the default, in another order, was saved as a change');

      const changes = [
        {},
        { a: ['x', 'y'] },
        { a: ['x'], b: null },
        { a: { 0: 'x', 1: 'y' }, b: null },
        { a: ['x', 'y'], b: {} },
      ];
      for (const changed of changes) {
        setSetting('laterObjectSetting', changed);
        assert.deepEqual(saved(), { laterObjectSetting: changed }, `${JSON.stringify(changed)} was not saved`);
      }
    })
  );
});
