/**
 * The menu may not advertise a shortcut that nothing listens for.
 *
 * Four of them did. `Open Folder…` showed ⌘⇧O / Ctrl+Shift+O, `Settings…`
 * showed ⌘, , `Exit` showed ⌘⇧W and `Toggle Terminals Side Bar` showed ⌘⌥B —
 * and `useKeybindings` handled none of the four. On macOS three of them worked
 * anyway, by accident, because the native menu in src-tauri/src/menu.rs
 * registers its own accelerators; on Windows and Linux, where NexTerm draws
 * its own menu, pressing them did nothing at all. Nothing caught it because
 * the label lived in one file as a string and the handler in another as an
 * `if`, and no test could compare a string to an `if`.
 *
 * So the chords are data now. These cases take the chord each menu entry
 * advertises, build the KeyboardEvent a real keypress would produce — on both
 * platforms, since "mod" is ⌘ on one and Ctrl on the other — and assert that
 * exactly the right binding claims it.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { MENU_BAR } from '../../src/lib/menuActions.js';
import { chordMatches, parseChord } from '../../src/lib/chords.js';
import {
  COMMANDS,
  DEFAULT_RESOLVED,
  findBinding,
  dispatchKeydown,
  dispatchKeydownOverTerminal,
  menuIdOf,
} from '../../src/lib/keybindings.js';

/** Every menu entry that advertises a shortcut. */
const MENU_ITEMS = MENU_BAR.flatMap((menu) => menu.items).filter((i) => i.id && i.key);

/** What the glyph keys report as `event.key` unshifted. */
const CODE_TO_KEY = { Backquote: '`', Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=' };

/**
 * The event a real keypress for the chord `key` produces on `platform`.
 *
 * Built from the chord the menu shows, and deliberately NOT from
 * `chordMatches` — this models the browser, so the matcher is still free to be
 * wrong about it.
 *
 * The difference that matters: "mod" is ⌘ on macOS (metaKey, ctrlKey stays
 * FALSE) and Ctrl on Windows and Linux (ctrlKey TRUE) — so a Windows event
 * looks, to any rule written in terms of `e.ctrlKey`, exactly like a literal
 * Ctrl chord. That overlap is where an ordering mistake would hide.
 */
function eventFor(key, platform) {
  const chord = parseChord(key);
  assert.ok(chord, `not a chord: ${key}`);
  const e = {
    ctrlKey: Boolean(chord.ctrl),
    metaKey: Boolean(chord.cmd),
    shiftKey: Boolean(chord.shift),
    altKey: Boolean(chord.alt),
    key: '',
    code: '',
  };
  if (chord.mod) {
    if (platform === 'macos') e.metaKey = true;
    else e.ctrlKey = true;
  }
  if (chord.code) {
    e.code = chord.code;
    e.key = CODE_TO_KEY[chord.code] ?? '';
    // `shift` + backtick reports '~' on a US layout, which is exactly why the
    // table matches on `code` rather than `key` for that one.
    if (chord.code === 'Backquote' && e.shiftKey) e.key = '~';
  } else if (chord.key.length === 1) {
    // A letter. Shift makes the browser report the capital.
    e.key = e.shiftKey ? chord.key.toUpperCase() : chord.key;
    e.code = `Key${chord.key.toUpperCase()}`;
  } else {
    e.key = chord.key;
    e.code = chord.key;
  }
  return e;
}

/** What `hasMod` would say for this event on this platform. */
const isModFor = (e, platform) => (platform === 'macos' ? e.metaKey : e.ctrlKey);

const ctxFor = (e, platform, extra = {}) => ({
  isMod: isModFor(e, platform),
  isInMonacoEditor: false,
  isCommandPaletteOpen: false,
  ...extra,
});

const PLATFORMS = ['macos', 'windows'];

describe('Keybinding table: the menu and the keyboard cannot drift apart', () => {
  test('KB-00: there is a menu to check in the first place', () => {
    // KB-01, KB-02 and KB-10 all loop over MENU_ITEMS, so an empty list would
    // report three passes having checked nothing. Not hypothetical: the menu
    // entries stopped carrying their chord under the old name when the
    // shortcuts started coming from the bindings, and every one of those cases
    // went green iterating an empty array.
    const withoutShortcut = MENU_BAR.flatMap((m) => m.items)
      .filter((i) => i.id && !i.key)
      .map((i) => i.id);
    assert.deepEqual(withoutShortcut, [], 'these menu entries advertise no shortcut at all');
    assert.equal(MENU_ITEMS.length, 19, `expected the whole menu, got ${MENU_ITEMS.length} entries`);
  });

  test('KB-01: every shortcut the menu advertises is claimed by a binding', () => {
    const unclaimed = [];
    for (const platform of PLATFORMS) {
      for (const menuItem of MENU_ITEMS) {
        const e = eventFor(menuItem.key, platform);
        const binding = findBinding(e, ctxFor(e, platform));
        if (!binding) {
          unclaimed.push(`${platform}: ${menuItem.id} (${menuItem.shortcut})`);
        }
      }
    }
    assert.deepEqual(
      unclaimed,
      [],
      `these menu entries show a shortcut nothing listens for:\n  ${unclaimed.join('\n  ')}`
    );
  });

  test('KB-02: and it is claimed by the binding for THAT command, not another', () => {
    const wrong = [];
    for (const platform of PLATFORMS) {
      for (const menuItem of MENU_ITEMS) {
        const e = eventFor(menuItem.key, platform);
        const binding = findBinding(e, ctxFor(e, platform));
        if (binding && binding.id !== menuItem.id) {
          wrong.push(`${platform}: ${menuItem.shortcut} is ${menuItem.id} in the menu but ran ${binding.id}`);
        }
      }
    }
    assert.deepEqual(wrong, [], `shortcuts land on the wrong command:\n  ${wrong.join('\n  ')}`);
  });

  test('KB-03: the four that used to do nothing off macOS now do something', () => {
    // Named individually rather than left to KB-01: these are the regression.
    for (const id of ['open-folder', 'preferences', 'close-window', 'toggle-secondary']) {
      const menuItem = MENU_ITEMS.find((i) => i.id === id);
      assert.ok(menuItem, `${id} is still in the menu`);
      for (const platform of PLATFORMS) {
        const e = eventFor(menuItem.key, platform);
        const binding = findBinding(e, ctxFor(e, platform));
        assert.equal(binding?.id, id, `${id} must be claimed on ${platform} (${menuItem.shortcut})`);
      }
    }
  });

  test('KB-04: pressing each one actually calls the action behind it', () => {
    const calls = [];
    const stub = (name) => (...args) => calls.push(`${name}(${args.join(',')})`);
    const actions = {
      setCommandPaletteOpen: stub('palette'),
      setSettingsModalOpen: stub('settings'),
      toggleSidebar: stub('sidebar'),
      togglePanel: stub('panel'),
      toggleSecondarySidebar: stub('secondary'),
      saveFile: stub('save'),
      pickRoot: stub('pickRoot'),
      splitActivePane: stub('split'),
      closeActivePane: stub('closePane'),
      focusNextPane: stub('focusPane'),
      createTerminalTab: stub('newTerminal'),
      clearBlocks: stub('clear'),
      openFind: stub('find'),
      showView: stub('showView'),
      zoomFont: stub('zoom'),
      resetZoom: stub('zoomReset'),
      closeWindow: stub('closeWindow'),
      activeEditorTabId: 'tab-1',
    };

    const expected = {
      'open-folder': 'pickRoot()',
      'preferences': 'settings(true)',
      'close-window': 'closeWindow()',
      'toggle-secondary': 'secondary()',
      'toggle-sidebar': 'sidebar()',
      'toggle-panel': 'panel()',
      'new-terminal': 'newTerminal()',
      'save': 'save(tab-1)',
      'split-right': 'split(horizontal)',
      'split-down': 'split(vertical)',
      'close-pane': 'closePane()',
      'clear-terminal': 'clear()',
      'command-palette': 'palette(true)',
      'quick-open': 'palette(true,files)',
      'find-in-terminal': 'find()',
      'search-in-files': 'showView(search)',
      'zoom-in': 'zoom(1)',
      'zoom-out': 'zoom(-1)',
      'zoom-reset': 'zoomReset()',
    };

    for (const menuItem of MENU_ITEMS) {
      calls.length = 0;
      const e = { ...eventFor(menuItem.key, 'windows'), preventDefault: () => {} };
      const fired = dispatchKeydown(e, ctxFor(e, 'windows', actions));
      assert.equal(fired, menuItem.id, `${menuItem.id} must be the binding that ran`);
      assert.deepEqual(
        calls,
        [expected[menuItem.id]],
        `${menuItem.id} (${menuItem.shortcut}) must call its own action exactly once`
      );
    }
  });

  test('KB-05: the shifted variants win over the unshifted ones', () => {
    // ⌘⇧D must not be swallowed by the ⌘D rule, and ⌘⇧W must not close a
    // pane. Each unshifted rule excludes the shifted case explicitly (KB-10
    // holds that), so check the pairs land where the menu says they do.
    for (const platform of PLATFORMS) {
      const pairs = [
        ['mod+shift+d', 'split-down'],
        ['mod+d', 'split-right'],
        ['mod+shift+w', 'close-window'],
        ['mod+w', 'close-pane'],
        ['mod+alt+b', 'toggle-secondary'],
        ['mod+b', 'toggle-sidebar'],
        ['ctrl+shift+backquote', 'new-terminal'],
        ['ctrl+backquote', 'toggle-panel'],
      ];
      for (const [key, id] of pairs) {
        const e = eventFor(key, platform);
        assert.equal(findBinding(e, ctxFor(e, platform))?.id, id, `${platform}: ${key}`);
      }
    }
  });

  test('KB-06: Monaco keeps the chords it owns, without them being swallowed', () => {
    // ⌘D and ⌘W belong to the editor while the cursor is in a file: the table
    // must step aside AND leave the key unprevented.
    for (const key of ['mod+d', 'mod+w']) {
      let prevented = false;
      const e = { ...eventFor(key, 'macos'), preventDefault: () => { prevented = true; } };
      const fired = dispatchKeydown(e, ctxFor(e, 'macos', { isInMonacoEditor: true }));
      assert.ok(String(fired).startsWith('pass:'), `${key} must pass through, got ${fired}`);
      assert.equal(prevented, false, `${key} must not be swallowed inside Monaco`);
    }
  });

  test('KB-07: Escape closes the palette without claiming the key', () => {
    let prevented = false;
    const closed = [];
    const e = { key: 'Escape', code: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => { prevented = true; } };
    dispatchKeydown(e, ctxFor(e, 'macos', { isCommandPaletteOpen: true, setCommandPaletteOpen: (v) => closed.push(v) }));
    assert.deepEqual(closed, [false], 'the palette closes');
    assert.equal(prevented, false, 'but Escape still reaches whatever else is open');
  });

  test('KB-08: a plain Ctrl+letter is left to the shell', () => {
    // The terminal turns these into control bytes; claiming them here would
    // take ^C, ^D and ^L away from every program running in a pane.
    for (const letter of ['c', 'd', 'l', 'a', 'e', 'k', 'w', 'u']) {
      const e = {
        ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
        key: letter, code: `Key${letter.toUpperCase()}`,
      };
      // On macOS Ctrl is NOT the app modifier, so nothing may claim it.
      const binding = findBinding(e, ctxFor(e, 'macos'));
      assert.equal(binding, null, `macOS: Ctrl+${letter} must reach the shell, got ${binding?.id}`);
    }
  });

  test('KB-10: exactly one binding may claim a chord — order must not decide it', () => {
    // If two rules both accepted the same chord, whichever sat higher would
    // win, and rearranging the list would silently change what a key does.
    // Every overlapping rule states its own exclusion instead.
    const ambiguous = [];
    for (const platform of PLATFORMS) {
      for (const menuItem of MENU_ITEMS) {
        const e = eventFor(menuItem.key, platform);
        const ctx = ctxFor(e, platform);
        const claimants = DEFAULT_RESOLVED.filter((b) => chordMatches(b.chord, e, ctx.isMod))
          .map((b) => b.command);
        if (claimants.length !== 1) {
          ambiguous.push(`${platform}: ${menuItem.shortcut} claimed by [${claimants.join(', ')}]`);
        }
      }
    }
    assert.deepEqual(ambiguous, [], `chords whose meaning depends on table order:\n  ${ambiguous.join('\n  ')}`);
  });

  test('KB-09: every binding either serves a menu entry or is deliberately not in the menu', () => {
    const menuIds = new Set(MENU_ITEMS.map((i) => i.id));
    const orphans = Object.keys(COMMANDS).map(menuIdOf)
      .filter((id) => id !== null)
      .filter((id) => !menuIds.has(id));
    assert.deepEqual(
      orphans,
      [],
      `these bindings claim a menu id that no menu entry has: ${orphans.join(', ')}`
    );

    // The intentional exceptions, spelled out so adding another is a decision.
    const notInMenu = Object.keys(COMMANDS).filter((id) => menuIdOf(id) === null);
    assert.deepEqual(notInMenu.sort(), [
      // Deliberately keyboard-only. `all-commands` is ⌘⇧P, the other half of
      // quick open; the pane-focus pair and the two guards have never been
      // menu items.
      'all-commands',
      'escape',
      'focus-next-pane',
      'focus-previous-pane',
      'reload-guard',
    ]);
  });

  test('KB-11: only window chrome may be claimed over a focused terminal', () => {
    // `overTerminal` takes a chord away from the shell. Which chords do that
    // is a product decision, so it is written down here rather than left to
    // whoever edits the table next.
    const claimed = Object.entries(COMMANDS).filter(([, c]) => c.overTerminal).map(([id]) => id).sort();
    assert.deepEqual(claimed, [
      // Ctrl+F off macOS, which readline uses for forward-char. Taken on
      // purpose: a find bar that stops working whenever a terminal has focus
      // would never work at all, VS Code makes the same trade, and Settings
      // can move it. The arrow keys do the same job in the shell.
      'find-in-terminal',
      'reload-guard',
      // ⇧⌘F. The terminal has no use for it, and shifted it is not a bare
      // Ctrl+letter, so nothing is taken from the shell.
      'search-in-files',
      'toggle-secondary',
      'toggle-sidebar',
      // Punctuation and a digit — no control byte is given up for these.
      'zoom-in',
      'zoom-out',
      'zoom-reset',
    ]);
  });

  test('KB-12: the terminal keeps every control byte, including the ones mod maps to', () => {
    // KB-08 covers macOS, where Ctrl is not the app modifier so nothing can
    // claim it. This is the Windows/Linux half, which KB-08 could not reach:
    // there Ctrl IS the app modifier, so ^C/^D/^L/^W/^K/^U all match a binding
    // in the table — and must still be left alone over a terminal.
    // 'r' is in this list on purpose: Ctrl+R is reverse-i-search in bash, zsh
    // and PSReadLine. The reload guard must never grow to cover it.
    for (const letter of ['c', 'd', 'l', 'a', 'e', 'k', 'w', 'u', 'r']) {
      const e = {
        ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
        key: letter, code: `Key${letter.toUpperCase()}`,
        preventDefault: () => assert.ok(false, `Ctrl+${letter} must not be swallowed over a terminal`),
        stopPropagation: () => assert.ok(false, `Ctrl+${letter} must reach xterm`),
      };
      const fired = dispatchKeydownOverTerminal(e, ctxFor(e, 'windows', { blockReload: true }));
      assert.equal(fired, null, `Ctrl+${letter} must reach the shell, got ${fired}`);
    }

    // And the macOS half, through the same entry point. KB-08 shows that no
    // binding MATCHES a bare Ctrl there, which is the reason nothing can claim
    // it — but the capture listener is what actually runs over a terminal, and
    // the worry after it was added is precisely that ^C stopped reaching the
    // shell. Cheap to state outright rather than leave to inference.
    for (const letter of ['c', 'd', 'l', 'a', 'e', 'k', 'w', 'u', 'r']) {
      const e = {
        ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
        key: letter, code: `Key${letter.toUpperCase()}`,
        preventDefault: () => assert.ok(false, `macOS: Ctrl+${letter} must not be swallowed`),
        stopPropagation: () => assert.ok(false, `macOS: Ctrl+${letter} must reach xterm`),
      };
      const fired = dispatchKeydownOverTerminal(e, ctxFor(e, 'macos', { blockReload: true }));
      assert.equal(fired, null, `macOS: Ctrl+${letter} must reach the shell, got ${fired}`);
    }
  });

  test('KB-13: Ctrl+B toggles the side bar even though xterm would eat it', () => {
    // The defect: off macOS the side bar toggle the menu advertises did
    // nothing whenever a terminal had focus, because xterm turned Ctrl+B into
    // ^B and stopped the event before any window listener ran.
    for (const platform of PLATFORMS) {
      for (const [key, expected] of [
        ['mod+b', 'toggle-sidebar'],
        ['mod+alt+b', 'toggle-secondary'],
      ]) {
        let prevented = false;
        let stopped = false;
        const toggled = [];
        const e = {
          ...eventFor(key, platform),
          preventDefault: () => { prevented = true; },
          stopPropagation: () => { stopped = true; },
        };
        const fired = dispatchKeydownOverTerminal(
          e,
          ctxFor(e, platform, { toggleSidebar: () => toggled.push('primary'), toggleSecondarySidebar: () => toggled.push('secondary') })
        );
        assert.equal(fired, expected, `${platform}: ${key} must be claimed over a terminal`);
        assert.equal(toggled.length, 1, `${platform}: ${expected} must actually run`);
        assert.ok(prevented, `${platform}: ${key} must be swallowed`);
        assert.ok(stopped, `${platform}: xterm must not also see ${key}`);
      }
    }
  });

  test('KB-14: a packaged build refuses the reload chords, and a dev build does not', () => {
    // A reload restarts the frontend, and bootstrap reaps every PTY — so a
    // stray Ctrl+Shift+R kills every shell in the window. Measured on the
    // shipped 0.2.3 Windows build: F5 and Ctrl+R are already suppressed by
    // WebView2, Ctrl+Shift+R is not.
    const chords = [
      ['F5', { key: 'F5', code: 'F5', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }],
      ['Ctrl+Shift+R', { key: 'R', code: 'KeyR', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }],
      ['Cmd+R', { key: 'r', code: 'KeyR', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }],
      ['Cmd+Shift+R', { key: 'R', code: 'KeyR', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false }],
    ];

    for (const [label, base] of chords) {
      let prevented = false;
      const e = { ...base, preventDefault: () => { prevented = true; } };
      const platform = base.metaKey ? 'macos' : 'windows';
      const fired = dispatchKeydown(e, ctxFor(e, platform, { blockReload: true }));
      assert.equal(fired, 'reload-guard', `${label} must be refused in a packaged build`);
      assert.ok(prevented, `${label} must be swallowed, or the webview still reloads`);

      // Development is the one place reloading is wanted.
      const devEvent = { ...base, preventDefault: () => assert.ok(false, `${label} must work in dev`) };
      assert.equal(
        dispatchKeydown(devEvent, ctxFor(devEvent, platform, { blockReload: false })),
        null,
        `${label} must still reload in development`
      );
    }

    // And the one that must NOT be refused, packaged or not: reverse-i-search.
    const search = {
      key: 'r', code: 'KeyR', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      preventDefault: () => assert.ok(false, 'Ctrl+R must reach the shell'),
    };
    assert.equal(
      dispatchKeydown(search, ctxFor(search, 'windows', { blockReload: true })),
      null,
      'a plain Ctrl+R is reverse-i-search and does not reload — it must be left alone'
    );
  });
});
