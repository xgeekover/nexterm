/**
 * The clickable things in terminal output.
 *
 * Two ways this feature can be worse than not having it: claiming text that is
 * not a link (every word with a slash in it turns blue and the output becomes
 * unreadable), and resolving a real link to the wrong file (a click opens
 * something unrelated, which is worse than a click doing nothing).
 *
 * So most of these cases are about what must NOT match, and about the cwd a
 * relative path is read against. The samples are real output shapes — rustc,
 * node, python, eslint, tsc, cmd.exe — rather than invented ones.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { findLinks, resolveLinkPath } from '../../src/lib/terminalLinks.js';
import { isOpenable } from '../../src/lib/openExternal.js';

const only = (text) => {
  const links = findLinks(text);
  assert.equal(links.length, 1, `expected exactly one link in ${JSON.stringify(text)}, got ${links.length}`);
  return links[0];
};

describe('Terminal links: what is a link', () => {
  test('LK-01: the shapes real tools print', () => {
    // rustc
    let l = only('  --> src/main.rs:10:5');
    assert.equal(l.path, 'src/main.rs');
    assert.equal(l.line, 10);
    assert.equal(l.column, 5);

    // node / jest / vitest
    l = only('    at Object.<anonymous> tests/unit/app.test.js:42:13');
    assert.equal(l.path, 'tests/unit/app.test.js');
    assert.equal(l.line, 42);

    // tsc and eslint, which stop at the line
    l = only('src/lib/paths.ts:88 - error TS2345');
    assert.equal(l.path, 'src/lib/paths.ts');
    assert.equal(l.line, 88);
    assert.equal(l.column, null);

    // python
    l = only('  File "src/app.py", line 42');
    assert.equal(l.path, 'src/app.py');
    assert.equal(l.line, 42);
  });

  test('LK-02: explicitly relative and absolute paths', () => {
    assert.equal(only('./src/a.js:1').path, './src/a.js');
    assert.equal(only('../shared/b.ts:2:3').path, '../shared/b.ts');
    assert.equal(only('/Users/me/p/c.rs:9').path, '/Users/me/p/c.rs');
  });

  test('LK-03: Windows, both spellings, drive letter and all', () => {
    // The colon in `C:` is why the position is read from the end of the match
    // rather than counted from the front.
    let l = only('C:\\work\\proj\\src\\main.rs:10:5');
    assert.equal(l.path, 'C:\\work\\proj\\src\\main.rs');
    assert.equal(l.line, 10);
    assert.equal(l.column, 5);

    l = only('src\\components\\App.jsx:7');
    assert.equal(l.path, 'src\\components\\App.jsx');
    assert.equal(l.line, 7);

    // A tool under cmd.exe may still print forward slashes.
    assert.equal(only('C:/work/proj/src/main.rs:3').path, 'C:/work/proj/src/main.rs');
  });

  test('LK-04: a line number is required, so prose is left alone', () => {
    // Without this rule every word with a slash lights up.
    assert.deepEqual(findLinks('see src/main.rs for details'), []);
    assert.deepEqual(findLinks('cd src/components && npm test'), []);
    assert.deepEqual(findLinks('total 24 drwxr-xr-x  5 me staff'), []);
  });

  test('LK-05: an extension is required, so a printed PATH is not a link', () => {
    assert.deepEqual(findLinks('/usr/bin:/usr/local/bin:/opt/homebrew/bin'), []);
    assert.deepEqual(findLinks('warning: 3 problems:12 fixable'), []);
  });

  test('LK-06: timestamps and versions are not files', () => {
    assert.deepEqual(findLinks('[12:34:56] build finished'), []);
    assert.deepEqual(findLinks('listening on 0.0.0.0:3000'), []);
    assert.deepEqual(findLinks('node v22.14.0:1'), [], 'a version is not a path');
  });

  test('LK-07: several links on one line, in order', () => {
    const links = findLinks('src/a.js:1 and src/b.js:22:3');
    assert.equal(links.length, 2);
    assert.equal(links[0].path, 'src/a.js');
    assert.equal(links[1].path, 'src/b.js');
    assert.equal(links[1].column, 3);
    assert.ok(links[0].start < links[1].start);
  });

  test('LK-08: the offsets point at the text that was matched', () => {
    const text = 'error in src/lib/x.ts:14:2 — undefined';
    const l = only(text);
    assert.equal(text.slice(l.start, l.start + l.length), 'src/lib/x.ts:14:2');
  });
});

describe('Terminal links: URLs', () => {
  test('LK-09: http and https only — nothing that could run', () => {
    assert.equal(only('see https://example.com/docs').href, 'https://example.com/docs');
    assert.equal(only('http://localhost:5173/').href, 'http://localhost:5173/');
    // `file:` reads the disk and `javascript:` runs; neither is offered.
    assert.deepEqual(findLinks('file:///etc/passwd'), []);
    assert.deepEqual(findLinks('javascript:alert(1)'), []);
    assert.deepEqual(findLinks('ftp://host/x'), []);
  });

  test('LK-10: trailing prose punctuation is not part of the address', () => {
    assert.equal(only('open https://example.com/x.').href, 'https://example.com/x');
    assert.equal(only('(see https://example.com/x)').href, 'https://example.com/x');
    // …but a bracket the URL itself opened is.
    assert.equal(only('https://en.wikipedia.org/wiki/Foo_(bar)').href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  test('LK-11: a path-shaped tail inside a URL stays part of the URL', () => {
    // The failure this prevents: half a URL turning into a file link, so a
    // click opens nothing and the address is no longer clickable either.
    const l = only('http://localhost:8080/static/app.js:3');
    assert.equal(l.kind, 'url');
    assert.equal(l.href, 'http://localhost:8080/static/app.js:3');
  });
});

describe('Terminal links: where a relative path points', () => {
  test('LK-12: resolved against the shell’s cwd, not the workspace root', () => {
    // A `cargo` run inside src-tauri/ prints `src/main.rs`, which is
    // src-tauri/src/main.rs — resolving it against the workspace root opens
    // the wrong file, or nothing.
    assert.equal(
      resolveLinkPath('src/main.rs', '/work/proj/src-tauri'),
      '/work/proj/src-tauri/src/main.rs'
    );
    assert.equal(resolveLinkPath('./src/a.js', '/work/proj'), '/work/proj/src/a.js');
  });

  test('LK-13: an absolute path is already the answer', () => {
    assert.equal(resolveLinkPath('/etc/hosts.conf', '/work'), '/etc/hosts.conf');
    assert.equal(resolveLinkPath('C:\\work\\a.rs', 'C:\\other'), 'C:\\work\\a.rs');
  });

  test('LK-14: Windows keeps its own separator', () => {
    assert.equal(resolveLinkPath('src\\main.rs', 'C:\\work\\proj'), 'C:\\work\\proj\\src\\main.rs');
    // A forward-slash relative path under a Windows cwd still joins with `\`,
    // because the backend is handed a Windows path either way.
    assert.equal(resolveLinkPath('src/main.rs', 'C:\\work\\proj'), 'C:\\work\\proj\\src/main.rs');
    // Trailing separators on the cwd must not double up.
    assert.equal(resolveLinkPath('a.js', 'C:\\work\\'), 'C:\\work\\a.js');
    assert.equal(resolveLinkPath('a.js', '/work/'), '/work/a.js');
  });

  test('LK-15: nothing to resolve against is null, not a guess', () => {
    assert.equal(resolveLinkPath('src/a.js', null), null);
    assert.equal(resolveLinkPath('src/a.js', ''), null);
    assert.equal(resolveLinkPath(null, '/work'), null);
  });
});

describe('Terminal links: what may be handed to the system browser', () => {
  test('LK-16: http and https, and nothing else, whoever asks', () => {
    // The matcher already refuses to OFFER anything else, but this function is
    // exported and the next caller may not come through the matcher. Three
    // independent gates guard one action the terminal's own output can reach:
    // the matcher, this, and the backend capability's url scope.
    assert.equal(isOpenable('https://example.com'), true);
    assert.equal(isOpenable('http://localhost:1425/'), true);

    assert.equal(isOpenable('file:///etc/passwd'), false, 'reads the disk');
    assert.equal(isOpenable('javascript:alert(1)'), false, 'runs');
    assert.equal(isOpenable('data:text/html,<script>x</script>'), false);
    assert.equal(isOpenable('vscode://x/y'), false, 'hands off to another app');
    assert.equal(isOpenable('ftp://host/x'), false);
  });

  test('LK-17: anything that is not a URL at all is not openable', () => {
    assert.equal(isOpenable('not a url'), false);
    assert.equal(isOpenable(''), false);
    assert.equal(isOpenable(null), false);
    assert.equal(isOpenable(undefined), false);
    assert.equal(isOpenable(42), false);
    // A scheme-relative address has no scheme to check, so it is refused.
    assert.equal(isOpenable('//example.com'), false);
  });
});
