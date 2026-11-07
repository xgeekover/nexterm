#!/usr/bin/env node
/**
 * Builds nexterm-cli (this folder) and puts it where Tauri's
 * `bundle.externalBin` looks for it: src-tauri/binaries/nexterm-cli-<target
 * triple>[.exe]. The bundler then ships it beside the app in every installer —
 * NexTerm.app/Contents/MacOS (signed with the app), next to NexTerm.exe in the
 * MSI and NSIS installs, /usr/bin in the deb, rpm and AppImage — under its
 * plain name, nexterm-cli[.exe].
 *
 * Why externalBin is not in tauri.conf.json: tauri-build checks that every
 * externalBin file exists whenever the app crate builds, so `cargo test` and
 * `cargo check` of the app would fail until this script had run. It lives in
 * src-tauri/tauri.sidecar.conf.json instead, which only a bundle build passes:
 *
 *   npm run tauri build -- --config src-tauri/tauri.sidecar.conf.json
 *
 * That overlay also makes the build run this script first (its
 * beforeBuildCommand), so a bundle can never carry a CLI older than the app.
 * Tauri tells it the target in TAURI_ENV_TARGET_TRIPLE; run by hand it builds
 * for this machine.
 *
 *   node src-tauri/cli/stage.mjs         release build, staged for bundling
 *   node src-tauri/cli/stage.mjs --dev   debug build, also copied beside the
 *                                        dev app (src-tauri/target/debug), where
 *                                        a `tauri dev` NexTerm finds it
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(fileURLToPath(import.meta.url));
const tauriDir = dirname(cliDir);
const manifest = join(cliDir, 'Cargo.toml');
const dev = process.argv.includes('--dev');

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = /^host: (\S+)$/m.exec(out);
  if (!m) throw new Error('`rustc -vV` printed no host triple');
  return m[1];
}

/** Builds for `target` and returns the executable cargo reports (CARGO_TARGET_DIR and all). */
function build(target, release) {
  const args = ['build', '--manifest-path', manifest, '--target', target, '--message-format=json-render-diagnostics'];
  if (release) args.push('--release');
  let out;
  try {
    // From this folder, so .cargo/config.toml applies (the static C runtime on Windows).
    out = execFileSync('cargo', args, {
      cwd: cliDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // cargo has printed why on stderr already.
    console.error(`nexterm-cli: cargo build for ${target} failed (${e.status ?? e.message})`);
    process.exit(1);
  }
  let exe = null;
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue;
    const msg = JSON.parse(line);
    if (msg.reason === 'compiler-artifact' && msg.target?.name === 'nexterm-cli' && msg.executable) exe = msg.executable;
  }
  if (!exe) throw new Error(`cargo built no nexterm-cli executable for ${target}`);
  return exe;
}

function place(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  if (process.platform !== 'win32') chmodSync(to, 0o755);
  console.log(`nexterm-cli -> ${relative(process.cwd(), to) || to}`);
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const exeSuffix = triple.includes('windows') ? '.exe' : '';
const staged = join(tauriDir, 'binaries', `nexterm-cli-${triple}${exeSuffix}`);

if (triple === 'universal-apple-darwin') {
  // `tauri build --target universal-apple-darwin` wants one fat binary.
  const parts = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map((t) => build(t, !dev));
  mkdirSync(dirname(staged), { recursive: true });
  execFileSync('lipo', ['-create', '-output', staged, ...parts], { stdio: 'inherit' });
  console.log(`nexterm-cli -> ${relative(process.cwd(), staged)}`);
} else {
  const exe = build(triple, !dev);
  place(exe, staged);
  if (dev) place(exe, join(tauriDir, 'target', 'debug', `nexterm-cli${exeSuffix}`));
}
