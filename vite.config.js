import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  server: {
    port: 1420,
    strictPort: true,
    host: host || false
  }
});
