import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 4: Real-World Scenarios (End-to-End User Journeys)', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-SCENARIO-03: Keyboard-First Power User Navigation Journey', async () => {
    // Step 1: Start in Dark Theme
    assert.equal(app.theme, 'dark');

    // Step 2: Open Command Palette (⌘K) and navigate to package.json
    app.openCommandPalette();
    const pkgResult = app.searchPalette('package.json');
    assert.ok(pkgResult.files.length > 0);
    await app.executePaletteItem(pkgResult.files[0]);

    const activeTab = app.getActiveEditorTab();
    assert.equal(activeTab.fileName, 'package.json');
    assert.equal(activeTab.language, 'json');

    // Step 3: Switch Theme to Light via Command Palette
    app.openCommandPalette();
    const themeCmd = app.searchPalette('switch').commands.find((c) => c.action === 'switch_theme');
    await app.executePaletteItem(themeCmd);
    assert.equal(app.theme, 'light');
    assert.equal(app.monacoTheme, 'nexterm-light');

    // Step 4: Create a dedicated build terminal tab
    const buildTab = await app.createTerminalTab('Build & Lint');
    assert.equal(app.activeTerminalTabId, buildTab.id);

    // Step 5: Execute build commands
    const b1 = await app.executeTerminalCommand('echo building');
    const b2 = await app.executeTerminalCommand('echo linting');
    assert.equal(buildTab.blocks.length, 2);

    // Step 6: Pin the important build block and clear others
    app.pinBlock(b1.id);
    app.clearTerminalBlocks(buildTab.id);
    assert.equal(buildTab.blocks.length, 1);
    assert.equal(buildTab.blocks[0].id, b1.id);

    // Step 7: Switch back to default terminal tab
    app.switchTerminalTab('tab-term-1');
    assert.equal(app.activeTerminalTabId, 'tab-term-1');
  });
});
