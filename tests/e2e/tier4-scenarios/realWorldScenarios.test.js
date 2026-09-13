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

    // Step 3: Create a dedicated build terminal tab
    const firstTerminalId = app.activeTerminalTabId;
    const buildTab = await app.createTerminalTab('Build & Lint');
    assert.equal(app.activeTerminalTabId, buildTab.id);

    // Step 4: Execute build commands
    const b1 = await app.executeTerminalCommand('echo building');
    const b2 = await app.executeTerminalCommand('echo linting');
    assert.equal(buildTab.blocks.length, 2);

    // Step 5: Pin the important build block and clear others
    app.pinBlock(b1.id);
    app.clearTerminalBlocks(buildTab.id);
    assert.equal(buildTab.blocks.length, 1);
    assert.equal(buildTab.blocks[0].id, b1.id);

    // Step 6: Switch back to default terminal tab
    app.switchTerminalTab(firstTerminalId);
    assert.equal(app.activeTerminalTabId, firstTerminalId);
  });
});
