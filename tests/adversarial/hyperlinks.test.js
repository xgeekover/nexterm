/**
 * OSC 8 hyperlinks: text a program has made a link —
 * `ESC ] 8 ; ; <address> ST <text> ESC ] 8 ; ; ST` — as `ls --hyperlink`,
 * gcc, delta, OpenCode and Claude Code print them.
 *
 * The registry gave xterm no handler for them, so xterm used its own: a
 * `window.confirm`, then `window.open` — the page handed to the webview, not
 * to the browser, on a different rule from every other link in the terminal.
 * And unlike an address printed as text, what a hyperlink shows is not where
 * it goes, so where it goes has to be shown some other way.
 *
 * Node has no xterm that draws, so the handler is cut from the registry and
 * run with the real `openExternal` (its browser path, with `window.open`
 * watched), and the xterm API it plugs into is checked against the typings of
 * the release installed.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
// The namespace, not the names: on code without the new export these cases
// fail one by one instead of the file failing to load.
import * as external from '../../src/lib/openExternal.js';

// As written, whatever line endings the checkout gave it: on Windows git
// writes CRLF, and a function's end is looked for by "\n}\n".
const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n'
);

/** One top-level function of the registry, by name, as written there. */
function cut(name) {
  const start = registry.indexOf(`function ${name}(`);
  assert.ok(start > 0, `the registry has no ${name}`);
  const end = registry.indexOf('\n}\n', start) + 3;
  return registry.slice(start, end);
}

/** A terminal's own element, as far as the handler touches it. */
function fakeContainer() {
  return {
    title: '',
    removed: 0,
    removeAttribute(name) {
      if (name === 'title') {
        this.title = '';
        this.removed += 1;
      }
    },
  };
}

/** A press on a link, as xterm hands it over. */
function clickEvent() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

/**
 * The registry's `hyperlinkHandler` for one terminal, run with the real
 * `openExternal` and `hyperlinkTitle`; `opened` is what reached the browser.
 */
function realHandler() {
  const container = fakeContainer();
  const make = new Function(
    'openExternal',
    'hyperlinkTitle',
    `${cut('openWebLink')}\n${cut('hyperlinkHandler')}\nreturn hyperlinkHandler;`
  )(external.openExternal, external.hyperlinkTitle);
  return { handler: make(container), container };
}

/** Run `fn` as the browser build does: a `window` whose `open` is watched, and no Tauri. */
async function inBrowser(fn) {
  const held = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const { warn } = console;
  const opened = [];
  globalThis.window = { open: (...args) => opened.push(args) };
  console.warn = () => {};
  try {
    await fn(opened);
  } finally {
    console.warn = warn;
    if (held) Object.defineProperty(globalThis, 'window', held);
    else delete globalThis.window;
  }
}

describe('Hyperlinks: where one goes, as its tooltip says it', () => {
  test('HY-01: the address as the browser will be handed it, not as the program spelled it', () => {
    const title = external.hyperlinkTitle;
    assert.equal(typeof title, 'function', 'openExternal.js says where a hyperlink goes');
    assert.equal(title('https://example.com/docs?q=1#top'), 'https://example.com/docs?q=1#top');
    assert.equal(title('HTTPS://Example.COM:443/a'), 'https://example.com/a', 'scheme and host as they are reached');
    assert.equal(title('http://localhost:1425/'), 'http://localhost:1425/');
    // What comes before an `@` is a user name sent to the host — not the host.
    assert.equal(title('https://example.com@evil.example/login'), 'https://evil.example/login');
    assert.equal(title('https://user:secret@example.com:8080/x'), 'https://example.com:8080/x');
    // A look-alike host is shown as the name it really is: its first letter
    // here is U+0430, a Cyrillic a.
    assert.equal(title('https://\u0430pple.com/'), 'https://xn--pple-43d.com/');
    // Nothing in it can turn the text round on screen.
    assert.equal(title('https://example.com/\u202Egnp.exe'), 'https://example.com/%E2%80%AEgnp.exe');
  });

  test('HY-02: a hyperlink that would not open has nothing to say — file:// to another machine above all', () => {
    const title = external.hyperlinkTitle;
    assert.equal(typeof title, 'function');
    for (const uri of [
      'file://fileserver/share/payload.exe',
      'file:////fileserver/share/x',
      'file:///etc/passwd',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'vscode://file/x',
      'ftp://host/x',
      'mailto:a@b.c',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      assert.equal(title(uri), null, `${JSON.stringify(uri)} got a tooltip`);
    }
  });

  test('HY-03: a long address is cut at its end, never into the host it goes to', () => {
    const title = external.hyperlinkTitle;
    assert.equal(typeof title, 'function');
    const limit = external.HYPERLINK_TITLE_LIMIT;
    const long = title(`https://example.com/${'p'.repeat(5000)}`);
    assert.equal(long.length, limit);
    assert.ok(long.startsWith('https://example.com/ppp') && long.endsWith('…'));
    // Pushed out of view by a long user name, the host would be the part cut.
    assert.ok(title(`https://${'a'.repeat(500)}@evil.example/x`).startsWith('https://evil.example/'));
    // A host longer than the limit is shown whole: it is the thing to see.
    const host = `${'a'.repeat(400)}.example`;
    assert.equal(title(`https://${host}/x`), `https://${host}…`);
  });
});

describe('Hyperlinks: what a terminal does with one', () => {
  test('HY-04: every terminal the app makes has the handler, from the moment it is created', () => {
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    const options = create.slice(create.indexOf('new Terminal({'), create.indexOf('});'));
    assert.match(options, /linkHandler: hyperlinkHandler\(container\),/, 'given to xterm with the rest of its options');
    assert.ok(create.indexOf('const container = ') < create.indexOf('new Terminal({'), 'on the element made for it');
  });

  test('HY-05: a click opens it in the browser through openExternal — http and https, nothing else', async () => {
    await inBrowser(async (opened) => {
      const { handler } = realHandler();
      assert.equal(handler.allowNonHttpProtocols, false, 'xterm offers no other scheme as a link at all');

      const click = clickEvent();
      handler.activate(click, 'https://example.com/docs');
      await Promise.resolve();
      assert.deepEqual(opened, [['https://example.com/docs', '_blank', 'noopener,noreferrer']]);
      assert.ok(click.defaultPrevented, 'the click is the link\'s');

      for (const uri of ['file://fileserver/share/payload.exe', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://h/x']) {
        handler.activate(clickEvent(), uri);
      }
      await Promise.resolve();
      assert.equal(opened.length, 1, `opened ${JSON.stringify(opened.slice(1))}`);
    });
  });

  test('HY-09: what is opened is the address the tooltip shows, not the text the program printed', async () => {
    // Found in review: xterm keeps an OSC 8 URI as printed, and the opener
    // passed it on as it came — quotes and spaces to the Windows shell, and
    // `HTTPS://…` or a leading space to a scope that refused it after the
    // tooltip had promised it.
    await inBrowser(async (opened) => {
      const { handler } = realHandler();
      for (const uri of [
        'https://example.com/" --gpu-launcher="cmd /c calc" "',
        'HTTPS://example.com/x',
        ' https://example.com/x',
        'https://user@example.com/x',
      ]) {
        handler.activate(clickEvent(), uri);
      }
      await Promise.resolve();
      assert.deepEqual(
        opened.map(([url]) => url),
        [
          'https://example.com/%22%20--gpu-launcher=%22cmd%20/c%20calc%22%20%22',
          'https://example.com/x',
          'https://example.com/x',
          'https://example.com/x',
        ]
      );
      for (const [url] of opened) assert.equal(url, external.hyperlinkTitle(url), 'what was opened is what the tooltip said');
    });
  });

  test('HY-06: the pointer on one shows where it goes, and taking it off clears that', () => {
    const { handler, container } = realHandler();
    handler.hover({}, 'https://example.com@evil.example/login');
    assert.equal(container.title, 'https://evil.example/login');
    handler.leave({}, 'https://example.com@evil.example/login');
    assert.equal(container.title, '');
    assert.equal(container.removed, 1);

    handler.hover({}, 'file://fileserver/share/payload.exe');
    assert.equal(container.title, '', 'nothing to show for a link that will not open');
  });

  test('HY-07: an address printed as text and a hyperlink open by one rule', () => {
    const provider = cut('registerLinks');
    assert.match(provider, /if \(match\.kind === 'url'\) \{\s*openWebLink\(event, match\.href\);/);
    assert.match(cut('hyperlinkHandler'), /activate: \(event, uri\) => openWebLink\(event, uri\),/);
    // openWebLink is the one way the registry reaches the browser.
    assert.equal(registry.match(/openExternal\(/g).length, 1, 'a second way to open an address');
    assert.match(cut('openWebLink'), /openExternal\(href\);/);
  });

  test('HY-08: the xterm installed takes a handler of this shape', () => {
    const typings = readFileSync(new URL('../../node_modules/@xterm/xterm/typings/xterm.d.ts', import.meta.url), 'utf8');
    assert.match(typings, /linkHandler\?: ILinkHandler \| null;/);
    const shape = typings.slice(typings.indexOf('interface ILinkHandler {'), typings.indexOf('interface ILinkProvider {'));
    assert.match(shape, /activate\(event: MouseEvent, text: string, range: IBufferRange\): void;/);
    assert.match(shape, /hover\?\(event: MouseEvent, text: string, range: IBufferRange\): void;/);
    assert.match(shape, /leave\?\(event: MouseEvent, text: string, range: IBufferRange\): void;/);
    assert.match(shape, /allowNonHttpProtocols\?: boolean;/);
  });
});
