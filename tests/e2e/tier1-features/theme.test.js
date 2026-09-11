import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: Dark/Light Theme Switching Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-THM-01: Application initializes in dark mode by default', () => {
    assert.equal(app.theme, 'dark', 'Default theme must be dark');
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Default Monaco editor theme must be vs-dark');
  });

  test('TC-THM-02: Theme toggle switches application to light mode without reload', () => {
    app.toggleTheme();
    assert.equal(app.theme, 'light', 'Theme should toggle to light');
    assert.equal(app.monacoTheme, 'nexterm-light', 'Monaco theme should switch to vs-light');
  });

  test('TC-THM-03: Theme toggle switches back from light to dark mode', () => {
    app.toggleTheme(); // -> light
    app.toggleTheme(); // -> dark
    assert.equal(app.theme, 'dark', 'Theme should toggle back to dark');
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Monaco theme should toggle back to vs-dark');
  });

  test('TC-THM-04: Explicit setTheme updates theme and synchronizes Monaco editor theme', () => {
    app.setTheme('light');
    assert.equal(app.theme, 'light');
    assert.equal(app.monacoTheme, 'nexterm-light');

    app.setTheme('dark');
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark');
  });

  test('TC-THM-05: Setting invalid theme name throws validation error', () => {
    assert.throws(
      () => {
        app.setTheme('neon-cyberpunk');
      },
      /Invalid theme/,
      'Should throw error for unsupported theme name'
    );
  });

  test('TC-THM-06: Monaco editor maintains theme across file tab switches', async () => {
    app.setTheme('light');
    const tab1 = await app.openFile('/workspace/package.json');
    const tab2 = await app.openFile('/workspace/README.md');

    assert.equal(app.monacoTheme, 'nexterm-light');
    app.openFile('/workspace/package.json'); // focus tab1
    assert.equal(app.monacoTheme, 'nexterm-light', 'Monaco theme must remain vs-light after tab change');
  });
});
