import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: Dark-Only Theme Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-THM-01: Application always initializes in dark mode', () => {
    assert.equal(app.theme, 'dark', 'Theme must be dark');
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Monaco editor theme must be nexterm-dark');
  });

  test('TC-THM-02: There is no theme toggle — light mode was removed entirely', () => {
    assert.equal(typeof app.toggleTheme, 'undefined', 'toggleTheme must not exist on the mock app');
    assert.equal(typeof app.setTheme, 'undefined', 'setTheme must not exist on the mock app');
  });

  test('TC-THM-03: Monaco editor theme stays nexterm-dark across file tab switches', async () => {
    await app.openFile('/workspace/package.json');
    await app.openFile('/workspace/README.md');

    assert.equal(app.monacoTheme, 'nexterm-dark');
    app.openFile('/workspace/package.json'); // focus tab1
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Monaco theme must remain nexterm-dark after tab change');
  });
});
