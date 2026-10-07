/**
 * What the command palette lists (src/lib/paletteItems.js), as plain data.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { paletteCommands } from '../../src/lib/paletteItems.js';
import { DEFAULT_RESOLVED, shortcutLabel } from '../../src/lib/keybindings.js';

describe('Command palette: what a row advertises', () => {
  test('PR-01: "Save All Files" shows no shortcut — Ctrl/Cmd+S saves one tab, not all of them', () => {
    const saveAll = paletteCommands(DEFAULT_RESOLVED).find((c) => c.command === 'save_all');
    assert.ok(saveAll, 'the palette offers Save All');
    const save = shortcutLabel('save', DEFAULT_RESOLVED, { isMac: false });
    assert.ok(save, 'precondition: Save has a chord');
    assert.ok(!saveAll.hint, `Save All advertises "${saveAll.hint}", the chord that saves only the active tab`);
  });
});
