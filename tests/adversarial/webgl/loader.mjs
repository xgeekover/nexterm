/**
 * Module hooks for the WebGL model tests: every `@xterm/*` import resolves to
 * `xtermDouble.js`, and xterm's stylesheet to an empty module.
 *
 * The real packages touch `document` and a canvas as they load and cannot run
 * in Node; the double reproduces what `terminalRegistry.js` relies on (see its
 * header). Only `@xterm/*` and `.css` are touched, so registering this from
 * the adversarial runner changes nothing for any other test.
 */
const DOUBLE = new URL('./xtermDouble.js', import.meta.url).href;
const EMPTY_CSS = 'nexterm-test:empty-css';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@xterm/')) {
    return { url: specifier.endsWith('.css') ? EMPTY_CSS : DOUBLE, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === EMPTY_CSS) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return next(url, context);
}
