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
import { KEYBINDINGS, findBinding, dispatchKeydown, menuIdOf } from '../../src/lib/keybindings.js';

/** Every menu entry that advertises a shortcut. */
const MENU_ITEMS = MENU_BAR.flatMap((menu) => menu.items).filter((i) => i.id && i.keys);

/**
 * The event a real keypress for `keys` produces on `platform`.
 *
 * The difference that matters: "mod" is ⌘ on macOS (metaKey, ctrlKey stays
 * FALSE) and Ctrl on Windows and Linux (ctrlKey TRUE) — so a Windows event
 * looks, to any rule written in terms of `e.ctrlKey`, exactly like a literal
 * Ctrl chord. That overlap is where an ordering mistake would hide.
 */
function eventFor(keys, platform) {
  const e = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '' };
  for (const k of keys) {
    if (k === 'mod') {
      if (platform === 'macos') e.metaKey = true;
      else e.ctrlKey = true;
    } else if (k === 'ctrl') e.ctrlKey = true;
    else if (k === 'shift') e.shiftKey = true;
    else if (k === 'alt') e.altKey = true;
    else if (k === '`') {
      e.code = 'Backquote';
      e.key = '`';
    } else if (k === ',') {
      e.key = ',';
      e.code = 'Comma';
    } else {
      // A letter. Shift makes the browser report the capital.
      e.key = keys.includes('shift') ? k.toUpperCase() : k;
      e.code = `Key${k.toUpperCase()}`;
    }
  }
  // `shift` + backtick reports '~' on a US layout, which is exactly why the
  // table matches on `code` rather than `key` for that one.
  if (e.code === 'Backquote' && e.shiftKey) e.key = '~';
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
  test('KB-01: every shortcut the menu advertises is claimed by a binding', () => {
    const unclaimed = [];
    for (const platform of PLATFORMS) {
      for (const menuItem of MENU_ITEMS) {
        const e = eventFor(menuItem.keys, platform);
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
        const e = eventFor(menuItem.keys, platform);
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
        const e = eventFor(menuItem.keys, platform);
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
    };

    for (const menuItem of MENU_ITEMS) {
      calls.length = 0;
      const e = { ...eventFor(menuItem.keys, 'windows'), preventDefault: () => {} };
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
        [['mod', 'shift', 'd'], 'split-down'],
        [['mod', 'd'], 'split-right'],
        [['mod', 'shift', 'w'], 'close-window'],
        [['mod', 'w'], 'close-pane'],
        [['mod', 'alt', 'b'], 'toggle-secondary'],
        [['mod', 'b'], 'toggle-sidebar'],
        [['ctrl', 'shift', '`'], 'new-terminal'],
        [['ctrl', '`'], 'toggle-panel'],
      ];
      for (const [keys, id] of pairs) {
        const e = eventFor(keys, platform);
        assert.equal(findBinding(e, ctxFor(e, platform))?.id, id, `${platform}: ${keys.join('+')}`);
      }
    }
  });

  test('KB-06: Monaco keeps the chords it owns, without them being swallowed', () => {
    // ⌘D and ⌘W belong to the editor while the cursor is in a file: the table
    // must step aside AND leave the key unprevented.
    for (const keys of [['mod', 'd'], ['mod', 'w']]) {
      let prevented = false;
      const e = { ...eventFor(keys, 'macos'), preventDefault: () => { prevented = true; } };
      const fired = dispatchKeydown(e, ctxFor(e, 'macos', { isInMonacoEditor: true }));
      assert.ok(String(fired).startsWith('pass:'), `${keys.join('+')} must pass through, got ${fired}`);
      assert.equal(prevented, false, `${keys.join('+')} must not be swallowed inside Monaco`);
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
        const e = eventFor(menuItem.keys, platform);
        const ctx = ctxFor(e, platform);
        const claimants = KEYBINDINGS.filter((b) => b.when(e, ctx)).map((b) => b.id);
        if (claimants.length !== 1) {
          ambiguous.push(`${platform}: ${menuItem.shortcut} claimed by [${claimants.join(', ')}]`);
        }
      }
    }
    assert.deepEqual(ambiguous, [], `chords whose meaning depends on table order:\n  ${ambiguous.join('\n  ')}`);
  });

  test('KB-09: every binding either serves a menu entry or is deliberately not in the menu', () => {
    const menuIds = new Set(MENU_ITEMS.map((i) => i.id));
    const orphans = KEYBINDINGS.map(menuIdOf)
      .filter((id) => id !== null)
      .filter((id) => !menuIds.has(id));
    assert.deepEqual(
      orphans,
      [],
      `these bindings claim a menu id that no menu entry has: ${orphans.join(', ')}`
    );

    // The intentional exceptions, spelled out so adding another is a decision.
    const notInMenu = KEYBINDINGS.filter((b) => menuIdOf(b) === null).map((b) => b.id);
    assert.deepEqual(notInMenu.sort(), ['escape', 'focus-pane']);
  });
});
