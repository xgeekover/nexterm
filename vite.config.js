import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);

// The dev server answers this machine only — the app's webview reaches it as
// http://localhost:1420 (tauri.conf.json). `host: true` had it listening on
// every network interface, serving the source and Vite's dev endpoints to
// anyone who could reach the machine while `npm run tauri dev` ran. A mobile
// dev run (`tauri android|ios dev`) sets TAURI_DEV_HOST to the address the
// device connects to, and listens there instead.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    // micromark decodes `&amp;` and friends through
    // decode-named-character-reference. Vite picks the package's "browser"
    // build, index.dom.js, which calls document.createElement as it loads;
    // the Markdown preview's Web Worker has no document, so the worker died
    // before its first parse. The package's own "worker" and "default"
    // exports name the DOM-free index.js, which is what Node resolves here.
    // Only the worker bundles the package.
    // tests/adversarial/markdown_render_worker.test.js MW-50.
    alias: [
      {
        find: /^decode-named-character-reference$/,
        replacement: require.resolve('decode-named-character-reference')
      }
    ]
  },
  build: {
    // ES2021 syntax kept as written. Vite's default target includes
    // es2020, so esbuild (0.25) lowered xterm's `let r; (…)(r ||= {})` in
    // InputHandler.requestMode to `r || (r = {})` and, minifying, dropped
    // the `let`: `(void 0 || (r = {}))`, an assignment to an undeclared
    // variable — a ReferenceError in strict (class) code. Thrown inside xterm's
    // write loop by the first DECRQM (`CSI ? 2026 $ p`, Claude Code's
    // start-up), it stopped the terminal parsing for good: the release
    // app froze, the dev server never did. Every webview NexTerm runs in
    // (WKWebView, WebView2, WebKitGTK) has ES2021.
    // tests/adversarial/claude_startup_headless.test.js CS-04.
    target: 'es2021'
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false
  }
});
