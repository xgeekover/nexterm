/**
 * Lets plain `node` import the app's `.jsx` files.
 *
 * This is the whole reason NexTerm had no component tests: the suites run
 * under `node` with no build step, and node cannot parse JSX. So a mistake in
 * a render reached CI as several hundred green cases and a white screen on the
 * user's machine — twice in one day.
 *
 * esbuild does the transform and is already present (Vite depends on it), so
 * this costs no new dependency. Two other things have to be stood in for:
 *
 *   - **CSS imports.** `import '@xterm/xterm/css/xterm.css'` is a Vite idiom;
 *     node has no idea what to do with it.
 *   - **`@xterm/*`.** Those packages touch `document` and a canvas at import
 *     time and throw outside a browser — which is exactly why
 *     `terminalStore.js` imports the registry lazily. The stub is honest about
 *     what it is NOT testing: xterm's own behaviour is covered by driving the
 *     real app (see TEST_INFRA.md), never here.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

/** A terminal that satisfies the registry without drawing anything. */
const XTERM_STUB = `
class Stub {
  constructor() {
    this.options = {};
    this.buffer = { active: { getLine: () => null, length: 0, cursorX: 0, cursorY: 0 } };
    this.cols = 80;
    this.rows = 24;
    this.element = null;
  }
  loadAddon() {}
  open() {}
  write() {}
  focus() {}
  dispose() {}
  onData() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
  registerLinkProvider() { return { dispose() {} }; }
}
export class Terminal extends Stub {}
export class FitAddon { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } }
export class WebglAddon { activate() {} dispose() {} onContextLoss() {} }
export class SearchAddon {
  activate() {} dispose() {}
  findNext() { return false; }
  findPrevious() { return false; }
  clearDecorations() {}
  onDidChangeResults() { return { dispose() {} }; }
}
export default {};
`;

export async function load(url, context, next) {
  if (url.includes('/@xterm/')) {
    return { format: 'module', source: XTERM_STUB, shortCircuit: true };
  }
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  if (url.endsWith('.jsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, {
      loader: 'jsx',
      format: 'esm',
      jsx: 'automatic',
      sourcefile: fileURLToPath(url),
      // Vite's compile-time constants. `DEV` false is the honest setting: a
      // packaged build is what a user runs, and it is the build where the
      // reload guard is armed and `window.__nexterm` is absent.
      define: {
        'import.meta.env.DEV': 'false',
        'import.meta.env.PROD': 'true',
        'import.meta.env.MODE': '"production"',
      },
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  if (url.endsWith('.js') && url.includes('/src/')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    if (source.includes('import.meta.env')) {
      const { code } = transformSync(source, {
        loader: 'js',
        format: 'esm',
        sourcefile: fileURLToPath(url),
        define: {
          'import.meta.env.DEV': 'false',
          'import.meta.env.PROD': 'true',
          'import.meta.env.MODE': '"production"',
        },
      });
      return { format: 'module', source: code, shortCircuit: true };
    }
  }
  return next(url, context);
}
