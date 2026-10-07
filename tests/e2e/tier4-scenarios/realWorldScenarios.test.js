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

    // Step 4: Execute build commands — in the build terminal, the one on screen
    const build = await app.runTerminalCommand('echo building');
    const lint = await app.runTerminalCommand('echo linting');
    assert.equal(build.exitCode, 0);
    assert.equal(lint.exitCode, 0);
    const buildOutput = app.terminalOutput(buildTab.id);
    assert.ok(buildOutput.includes('building') && buildOutput.includes('linting'), 'Both must run in the build terminal');
    assert.equal(app.terminalOutput(firstTerminalId).includes('building'), false, 'and not in the first one');

    // Step 5: Switch back to default terminal tab
    app.switchTerminalTab(firstTerminalId);
    assert.equal(app.activeTerminalTabId, firstTerminalId);
  });
});
