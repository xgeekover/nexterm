/**
 * NexTerm IPC Bridge
 * Provides transparent communication to Tauri v2 Rust backend when running in desktop shell,
 * and a seamless in-memory mock PTY + FS when running in browser mode.
 */

import {
  DEFAULT_PROJECT_FILES,
} from './constants.js';

function parseCommandLine(cmdLine) {
  const tokens = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(cmdLine)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1].replace(/\\"/g, '"'));
    else if (match[2] !== undefined) tokens.push(match[2].replace(/\\'/g, "'"));
    else tokens.push(match[3]);
  }
  return tokens;
}

function normalizePath(p) {
  const parts = p.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return '/' + stack.join('/');
}

function resolvePath(baseDir, relOrAbs) {
  if (!relOrAbs) return baseDir;
  if (relOrAbs.startsWith('/')) return normalizePath(relOrAbs);
  return normalizePath(`${baseDir.replace(/\/+$/, '')}/${relOrAbs}`);
}


export function isTauri() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

class BrowserMockBridge {
  constructor() {
    this.sessionCounter = 1;
    this.ptySessions = new Map();
    this.eventListeners = new Map();
    this.files = new Map(Object.entries(DEFAULT_PROJECT_FILES));
    this.directories = new Set(['/workspace', '/workspace/src', '/workspace/tests']);
    this.agentLogs = new Map();
    this.systemInfo = {
      os: 'macos',
      arch: 'aarch64',
      // Same field names the Rust command serialises, so a caller written
      // against the mock works against the real backend.
      default_shell: '/bin/zsh',
      home_dir: '/Users/developer',
      app_version: '0.1.5',
      tauri_version: '2.0.0',
      rust_version: '1.80.0',
    };
  }

  listen(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event).add(callback);
    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }

  async emit(event, payload) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const cb of Array.from(listeners)) {
        try {
          await cb({ event, payload, id: Date.now() });
        } catch (e) {
          console.error(`[IPC Mock] Error in event listener for ${event}:`, e);
        }
      }
    }
  }

  async runDynamicVirtualTests(session) {
    const { session_id } = session;
    const testFiles = Array.from(this.files.keys()).filter((p) => p.endsWith('.test.js') || p.includes('/' + 'tests' + '/'));

    if (testFiles.length === 0) {
      await this.emit('pty-output', { session_id, data: 'No test files found.\r\n' });
      await this.emit('pty-command-done', { session_id, exit_code: 0 });
      return;
    }

    let allPassed = true;
    let totalPassed = 0;
    let totalFailed = 0;
    let outputBuffer = '';

    for (const testPath of testFiles) {
      const relPath = testPath.replace(/^\/workspace\//, '');
      try {
        this.evaluateVirtualModule(testPath);
        outputBuffer += `\x1b[32mPASS\x1b[0m ${relPath} (1 passed, 0 failed)\r\n`;
        totalPassed++;
      } catch (err) {
        allPassed = false;
        totalFailed++;
        const errMsg = err && err.message ? err.message : String(err);
        outputBuffer += `\x1b[31mFAIL\x1b[0m ${relPath}\nAssertionError: ${errMsg}\n    at ${relPath}:4:7\nExit code: 1\r\n`;
      }
    }

    if (allPassed) {
      outputBuffer += `Test Suites: 1 passed, 1 total\nTests:       ${totalPassed} passed, ${totalPassed} total\r\n`;
      await this.emit('pty-output', { session_id, data: outputBuffer });
      await this.emit('pty-command-done', { session_id, exit_code: 0 });
    } else {
      outputBuffer += `Test Suites: 1 failed, 1 total\nTests:       ${totalFailed} failed, ${totalPassed} passed, ${totalPassed + totalFailed} total\r\n`;
      await this.emit('pty-output', { session_id, data: outputBuffer });
      await this.emit('pty-command-done', { session_id, exit_code: 1 });
    }
  }

  evaluateVirtualModule(entryPath) {
    const moduleCache = new Map();
    const self = this;

    function virtualRequire(specifier, fromFile) {
      let resolved = specifier;
      if (specifier.startsWith('.')) {
        const fromDir = fromFile.slice(0, fromFile.lastIndexOf('/'));
        resolved = resolvePath(fromDir, specifier);
        if (!resolved.endsWith('.js') && !resolved.endsWith('.jsx')) {
          if (self.files.has(resolved + '.js')) resolved += '.js';
          else if (self.files.has(resolved + '.jsx')) resolved += '.jsx';
        }
      }

      if (moduleCache.has(resolved)) {
        return moduleCache.get(resolved);
      }

      const content = self.files.get(resolved);
      if (content === undefined) {
        throw new Error(`Cannot find module '${specifier}' imported from '${fromFile}'`);
      }

      let code = content
        .replace(/export\s+function\s+([a-zA-Z0-9_$]+)/g, 'exports.$1 = function $1')
        .replace(/export\s+const\s+([a-zA-Z0-9_$]+)\s*=/g, 'exports.$1 =')
        .replace(/export\s+let\s+([a-zA-Z0-9_$]+)\s*=/g, 'exports.$1 =')
        .replace(/export\s+default\s+/g, 'module.exports = ')
        .replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/g, (m, imp, src) => {
          return `const { ${imp} } = __req('${src}', '${resolved}');`;
        })
        .replace(/import\s+([a-zA-Z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?/g, (m, imp, src) => {
          return `const ${imp} = __req('${src}', '${resolved}');`;
        });

      const moduleObj = { exports: {} };
      const fn = new Function('__req', 'module', 'exports', code);
      fn((s, f) => virtualRequire(s, f || resolved), moduleObj, moduleObj.exports);
      moduleCache.set(resolved, moduleObj.exports);
      return moduleObj.exports;
    }

    virtualRequire(entryPath, entryPath);
  }

  async invoke(command, args = {}) {
    switch (command) {
      // 1. pty_spawn
      case 'pty_spawn': {
        const { cols = 80, rows = 24, cwd = '/workspace', shell = '/bin/zsh' } = args;
        const sessionId = `pty-${this.sessionCounter++}`;
        const sessionInfo = {
          session_id: sessionId,
          cols: Math.max(10, Math.min(cols, 500)),
          rows: Math.max(2, Math.min(rows, 200)),
          cwd,
          shell,
          active: true,
          created_at: Date.now(),
        };
        this.ptySessions.set(sessionId, sessionInfo);
        return sessionInfo;
      }

      // 2. pty_write
      case 'pty_write': {
        const { session_id, data } = args;
        const session = this.ptySessions.get(session_id);
        if (!session) {
          throw new Error(`PTY session not found: ${session_id}`);
        }
        const trimmed = (data || '').trim();
        if (!trimmed) return null;

        if (!session._queue) session._queue = Promise.resolve();
        session._queue = session._queue.then(async () => {
          const tokens = parseCommandLine(trimmed);
          const cmd = tokens[0];
          const cmdArgs = tokens.slice(1);

          // The real backend emits this from OSC 133's "C" marker the moment a
          // command starts producing output, and every branch below ends with
          // the matching `pty-command-done`. Emitting it once here keeps the
          // pair honest: when the mock and the backend disagree, the mock wins
          // the test and the user loses — it has happened twice.
          await this.emit('pty-command-started', { session_id });

          if (cmd === 'ls' || cmd === 'dir') {
            const targetDir = cmdArgs[0] ? resolvePath(session.cwd, cmdArgs[0]) : session.cwd;
            const normalized = targetDir.replace(/\/+$/, '');
            const entries = new Set();
            for (const d of this.directories) {
              if (d.startsWith(normalized + '/') && d !== normalized) {
                entries.add(d.slice(normalized.length + 1).split('/')[0]);
              }
            }
            for (const f of this.files.keys()) {
              if (f.startsWith(normalized + '/') && f !== normalized) {
                entries.add(f.slice(normalized.length + 1).split('/')[0]);
              }
            }
            if (entries.size === 0 && !this.directories.has(normalized)) {
              await this.emit('pty-output', { session_id, data: `ls: ${cmdArgs[0] || targetDir}: No such file or directory\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 1 });
            } else {
              const fileList = Array.from(entries).sort().join('  \n');
              await this.emit('pty-output', { session_id, data: `${fileList}\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 0 });
            }
          } else if (cmd === 'pwd') {
            await this.emit('pty-output', { session_id, data: `${session.cwd}\r\n` });
            await this.emit('pty-command-done', { session_id, exit_code: 0 });
          } else if (cmd === 'cd') {
            const target = cmdArgs[0] || '/workspace';
            const resolved = resolvePath(session.cwd, target);
            if (this.directories.has(resolved) || Array.from(this.files.keys()).some((f) => f.startsWith(resolved + '/'))) {
              session.cwd = resolved;
              await this.emit('pty-command-done', { session_id, exit_code: 0 });
            } else {
              await this.emit('pty-output', { session_id, data: `cd: no such file or directory: ${target}\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 1 });
            }
          } else if (cmd === 'echo') {
            const echoContent = cmdArgs.join(' ');
            await this.emit('pty-output', { session_id, data: `${echoContent}\r\n` });
            await this.emit('pty-command-done', { session_id, exit_code: 0 });
          } else if (cmd === 'cat') {
            const targetFile = cmdArgs[0] ? resolvePath(session.cwd, cmdArgs[0]) : null;
            if (targetFile && this.files.has(targetFile)) {
              await this.emit('pty-output', { session_id, data: `${this.files.get(targetFile)}\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 0 });
            } else {
              await this.emit('pty-output', { session_id, data: `cat: ${cmdArgs[0] || ''}: No such file or directory\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 1 });
            }
          } else if (cmd === 'clear') {
            await this.emit('pty-output', { session_id, data: '\x1b[2J\x1b[H' });
            await this.emit('pty-command-done', { session_id, exit_code: 0 });
          } else if (cmd === 'git') {
            const sub = cmdArgs[0];
            if (sub === 'status') {
              const gitStatus = `On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\r\n`;
              await this.emit('pty-output', { session_id, data: gitStatus });
              await this.emit('pty-command-done', { session_id, exit_code: 0 });
            } else if (sub === 'branch') {
              await this.emit('pty-output', { session_id, data: `* main\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 0 });
            } else if (sub === '--version' || sub === 'version') {
              await this.emit('pty-output', { session_id, data: `git version 2.45.0\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 0 });
            } else {
              await this.emit('pty-output', { session_id, data: `git: '${sub}' is not a git command. See 'git --help'.\r\n` });
              await this.emit('pty-command-done', { session_id, exit_code: 1 });
            }
          } else if (cmd === 'whoami') {
            await this.emit('pty-output', { session_id, data: `developer\r\n` });
            await this.emit('pty-command-done', { session_id, exit_code: 0 });
          } else if (cmd === 'date') {
            await this.emit('pty-output', { session_id, data: `${new Date().toUTCString()}\r\n` });
            await this.emit('pty-command-done', { session_id, exit_code: 0 });
          } else if (cmd === 'npm' && (cmdArgs[0] === 'test' || cmdArgs[0] === 't')) {
            await this.runDynamicVirtualTests(session);
          } else if (cmd === 'exit' || cmd === 'logout') {
            // The one command that really does end the session.
            const code = Number(cmdArgs[0]) || 0;
            session.active = false;
            await this.emit('pty-exit', { session_id, exit_code: code });
            this.ptySessions.delete(session_id);
          } else {
            const shellName = (session.shell || '').includes('zsh') ? 'zsh' : 'bash';
            await this.emit('pty-output', { session_id, data: `${shellName}: command not found: ${cmd}\r\n` });
            await this.emit('pty-command-done', { session_id, exit_code: 127 });
          }
        });
        await session._queue;
        return null;
      }

      // 3. pty_resize
      case 'pty_resize': {
        const { session_id, cols, rows } = args;
        const session = this.ptySessions.get(session_id);
        if (!session) throw new Error(`PTY session not found: ${session_id}`);
        session.cols = Math.max(10, Math.min(cols, 500));
        session.rows = Math.max(2, Math.min(rows, 200));
        return null;
      }

      // 4. pty_kill
      case 'pty_kill': {
        const { session_id } = args;
        const session = this.ptySessions.get(session_id);
        if (session) {
          session.active = false;
          await this.emit('pty-exit', { session_id, exit_code: 130 });
          this.ptySessions.delete(session_id);
        }
        return null;
      }

      // The browser mock keeps its own session map, and it survives a
      // reload just as the Rust one does — so it has to reap too, or browser
      // mode would disagree with the app about what leaking looks like.
      case 'pty_retain_only': {
        const { session_ids = [] } = args;
        const keep = new Set(session_ids);
        let reaped = 0;
        for (const id of Array.from(this.ptySessions.keys())) {
          if (keep.has(id)) continue;
          const session = this.ptySessions.get(id);
          if (session) session.active = false;
          this.ptySessions.delete(id);
          await this.emit('pty-exit', { session_id: id, exit_code: 130 });
          reaped += 1;
        }
        return reaped;
      }

      // 5. pty_list_sessions
      case 'pty_list_sessions': {
        return Array.from(this.ptySessions.values());
      }

      // 6a. fs_get_root / fs_pick_root — browser mode has a single virtual root
      case 'fs_get_root': {
        return '/workspace';
      }
      case 'fs_pick_root': {
        return null; // no native dialog in the browser mock
      }

      // 6. fs_read_dir
      // The real one validates through `Workspace::set_root` and refuses a
      // folder that has moved. The mock only knows its own virtual tree, so it
      // accepts a path it has directories for and refuses anything else —
      // which is the behaviour the UI branches on.
      case 'fs_set_root': {
        const { path } = args || {};
        const wanted = String(path || '').replace(/\/+$/, '');
        const known = this.directories.has(wanted)
          || [...this.files.keys()].some((f) => f.startsWith(wanted + '/'));
        if (!wanted || !known) throw new Error(`Cannot open '${path}'`);
        this.root = wanted;
        return wanted;
      }

      // The real one shells out to the user's own git. The mock stands in with
      // a repository shaped like one — a branch, a couple of changed files —
      // so browser QA and the render suite exercise the same code paths.
      case 'git_status': {
        return {
          branch: 'main',
          ahead: 1,
          behind: 0,
          truncated: false,
          files: [
            { path: '/workspace/src/App.jsx', status: 'modified', staged: false },
            { path: '/workspace/README.md', status: 'untracked', staged: false },
          ],
        };
      }

      case 'fs_read_dir': {
        const { path, max_depth = 10 } = args;
        const normalized = (path || '/workspace').replace(/\/+$/, '');
        // The Rust backend returns a NESTED tree — each directory carries its
        // own `children` — and hides the same build/VCS folders. The mock used
        // to return one flat list, which let callers that only walked the top
        // level look correct here and lose data against the real backend.
        const SKIPPED = ['.git', 'node_modules', 'target', '.agents', 'dist'];

        const childrenOf = (dirPath, depth) => {
          const prefix = `${dirPath}/`;
          const nodes = [];
          for (const dir of this.directories) {
            if (!dir.startsWith(prefix)) continue;
            const rel = dir.slice(prefix.length);
            if (rel.includes('/')) continue;
            if (SKIPPED.includes(rel)) continue;
            nodes.push({
              name: rel,
              path: dir,
              is_dir: true,
              size: 0,
              children: depth > 1 ? childrenOf(dir, depth - 1) : [],
            });
          }
          for (const [filePath, content] of this.files.entries()) {
            if (!filePath.startsWith(prefix)) continue;
            const rel = filePath.slice(prefix.length);
            if (rel.includes('/')) continue;
            nodes.push({
              name: rel,
              path: filePath,
              is_dir: false,
              size: typeof content === 'string' ? content.length : 0,
            });
          }
          // The Rust backend sorts directories first, then by name, and the
          // explorer renders whatever order it is handed — so a mock that
          // skipped this showed a different tree from the real app.
          nodes.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          });
          return nodes;
        };

        return childrenOf(normalized, Math.max(1, max_depth));
      }

      case 'fs_read_file': {
        const { path } = args;
        if (!this.files.has(path)) {
          throw new Error(`File not found: ${path}`);
        }
        return this.files.get(path);
      }

      // 8. fs_write_file
      // The real one walks the disk in Rust (src-tauri/src/fs/search.rs) with
      // caps and the Explorer's ignore list. This searches the virtual files
      // the mock holds, with the same result shape — when the mock and the
      // backend disagree the mock wins the test and the user loses, and that
      // has happened twice.
      case 'fs_search': {
        const { query, case_sensitive, whole_word, regex } = args || {};
        const needle = String(query || '').trim();
        if (!needle) return { files: [], total_matches: 0, files_searched: 0, truncated: false };
        let test;
        try {
          const escaped = regex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = whole_word ? `\\b(?:${escaped})\\b` : escaped;
          const re = new RegExp(pattern, case_sensitive ? '' : 'i');
          test = (line) => {
            const m = re.exec(line);
            return m ? m.index : -1;
          };
        } catch (err) {
          throw new Error(`bad pattern: ${err.message}`);
        }
        const files = [];
        let total = 0;
        let searched = 0;
        for (const [path, content] of this.files.entries()) {
          if (/node_modules|\.git|target|dist/.test(path)) continue;
          searched += 1;
          const matches = [];
          String(content || '').split('\n').forEach((line, i) => {
            const at = test(line);
            if (at >= 0 && matches.length < 50) {
              matches.push({ line: i + 1, column: at + 1, text: line.slice(0, 400) });
              total += 1;
            }
          });
          if (matches.length) files.push({ path, matches, truncated: false });
        }
        return { files, total_matches: total, files_searched: searched, truncated: false };
      }

      case 'fs_write_file': {
        const { path, content } = args;
        this.files.set(path, content);
        await this.emit('fs-change', { path, kind: 'modify' });
        return null;
      }

      // 9. fs_create_file
      case 'fs_create_file': {
        const { path } = args;
        if (this.files.has(path)) {
          throw new Error(`File already exists: ${path}`);
        }
        this.files.set(path, '');
        await this.emit('fs-change', { path, kind: 'create' });
        return null;
      }

      // 10. fs_create_dir
      case 'fs_create_dir': {
        const { path } = args;
        this.directories.add(path);
        await this.emit('fs-change', { path, kind: 'create_dir' });
        return null;
      }

      // 11. fs_rename_path — one atomic move, like the Rust command.
      case 'fs_rename_path': {
        const { from, to } = args;
        const isDir = this.directories.has(from);
        if (!this.files.has(from) && !isDir) {
          throw new Error(`Path does not exist: ${from}`);
        }
        if ((this.files.has(to) || this.directories.has(to)) && to !== from) {
          throw new Error(`A file or folder named '${to.split('/').pop()}' already exists`);
        }
        if (isDir && to.startsWith(`${from}/`)) {
          throw new Error(`Cannot move '${from}' inside itself`);
        }
        const move = (map, isSet) => {
          for (const key of Array.from(isSet ? map.keys() : map.keys())) {
            if (key !== from && !key.startsWith(`${from}/`)) continue;
            const next = to + key.slice(from.length);
            if (isSet) {
              map.delete(key);
              map.add(next);
            } else {
              const value = map.get(key);
              map.delete(key);
              map.set(next, value);
            }
          }
        };
        move(this.files, false);
        move(this.directories, true);
        await this.emit('fs-change', { path: to, kind: 'rename' });
        return null;
      }

      // 11. fs_delete_path
      case 'fs_delete_path': {
        const { path, recursive = false } = args;
        if (this.files.has(path)) {
          this.files.delete(path);
          await this.emit('fs-change', { path, kind: 'delete' });
        } else if (this.directories.has(path)) {
          if (recursive) {
            for (const f of Array.from(this.files.keys())) {
              if (f.startsWith(path)) this.files.delete(f);
            }
            for (const d of Array.from(this.directories.keys())) {
              if (d.startsWith(path)) this.directories.delete(d);
            }
          } else {
            this.directories.delete(path);
          }
          await this.emit('fs-change', { path, kind: 'delete' });
        } else {
          throw new Error(`Path does not exist: ${path}`);
        }
        return null;
      }

      // 17. system_get_info
      case 'system_get_info': {
        return this.systemInfo;
      }

      // 18. system_list_shells — the backend FINDS these on the real machine.
      // The mock answers with a plausible pair so the picker has something to
      // show in browser QA, and never claims a path that means anything.
      case 'system_list_shells': {
        return [
          { id: 'login-shell', label: 'zsh (login shell)', spec: '/bin/zsh' },
          { id: 'bash', label: 'bash', spec: '/bin/bash' },
        ];
      }

      default:
        throw new Error(`Unknown IPC command: ${command}`);
    }
  }
}

export const mockBridge = new BrowserMockBridge();

/**
 * The Tauri bridge modules, loaded once.
 *
 * Only a failure to LOAD these may fall back to the mock. A rejection from a
 * command is the command's own answer — every Rust command returns
 * `Result<_, String>`, so a refusal or a real I/O failure arrives as a
 * rejection — and it has to reach the caller. Answering it with fabricated
 * mock data is how a failed save came to be reported as a success.
 */
let corePromise = null;
let eventPromise = null;

function loadBridge(which) {
  if (which === 'core') {
    if (!corePromise) {
      corePromise = import('@tauri-apps/api/core').catch((err) => {
        corePromise = null; // let a later call retry
        throw err;
      });
    }
    return corePromise;
  }
  if (!eventPromise) {
    eventPromise = import('@tauri-apps/api/event').catch((err) => {
      eventPromise = null;
      throw err;
    });
  }
  return eventPromise;
}

/**
 * Invoke an IPC command. Inside Tauri this is the real command and its errors
 * are real; in a browser it is the mock bridge.
 */
export async function invoke(command, args = {}) {
  if (isTauri()) {
    let core;
    try {
      core = await loadBridge('core');
    } catch (err) {
      console.error(
        `[IPC] Tauri core module failed to load; serving '${command}' from the browser mock:`,
        err
      );
      return mockBridge.invoke(command, args);
    }
    // Deliberately outside the try: let the command's own rejection through.
    return core.invoke(command, args);
  }
  return mockBridge.invoke(command, args);
}

const unwrap = (callback) => (evt) => callback(evt?.payload !== undefined ? evt.payload : evt);

/**
 * Listen to an IPC event. Returns an unlisten function.
 */
export async function listen(event, callback) {
  if (isTauri()) {
    let mod;
    try {
      mod = await loadBridge('event');
    } catch (err) {
      console.error(
        `[IPC] Tauri event module failed to load; subscribing '${event}' on the browser mock:`,
        err
      );
      return mockBridge.listen(event, unwrap(callback));
    }
    // Same rule as invoke: a failed subscription must surface, not silently
    // swap a live PTY stream for a simulated one.
    return mod.listen(event, unwrap(callback));
  }
  return mockBridge.listen(event, unwrap(callback));
}

export default {
  invoke,
  listen,
  isTauri,
  mockBridge,
};
