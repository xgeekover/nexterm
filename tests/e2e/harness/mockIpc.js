import { INITIAL_AGENTS, SAMPLE_CHAT_MESSAGES } from '../fixtures/mockAgents.js';
import { SAMPLE_PROJECT_FILES } from '../fixtures/sampleFiles.js';
import { generateDynamicAgentResponse } from '../../../src/lib/ipc.js';

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

export class MockIpcBridge {
  constructor(options = {}) {
    this.options = options;
    this.callHistory = [];
    this.eventListeners = new Map();

    // In-memory PTY Sessions
    this.ptySessions = new Map();
    this.sessionCounter = 1;

    // In-memory Virtual Filesystem
    this.files = new Map(Object.entries(SAMPLE_PROJECT_FILES));
    this.directories = new Set(['/workspace', '/workspace/src', '/workspace/tests']);

    // In-memory Agents
    this.agents = new Map(
      JSON.parse(JSON.stringify(INITIAL_AGENTS)).map((agent) => [agent.id, agent])
    );
    this.agentLogs = new Map();
    for (const [id, agent] of this.agents.entries()) {
      this.agentLogs.set(id, agent.logs ? [...agent.logs] : []);
    }

    // In-memory Chat
    this.chatMessages = JSON.parse(JSON.stringify(SAMPLE_CHAT_MESSAGES));

    // System Info
    this.systemInfo = {
      os: 'macos',
      arch: 'aarch64',
      app_version: '0.1.0',
      tauri_version: '2.0.0',
      rust_version: '1.80.0',
    };
  }

  recordCall(command, args) {
    this.callHistory.push({
      command,
      args,
      timestamp: Date.now(),
    });
  }

  getCalls(command) {
    return this.callHistory.filter((c) => c.command === command);
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
          await cb(payload);
        } catch (e) {
          console.error(`Error in event listener for ${event}:`, e);
        }
      }
    }
  }

  async runDynamicVirtualTests(session) {
    const { session_id } = session;
    const testFiles = Array.from(this.files.keys()).filter((p) => p.endsWith('.test.js') || p.includes('/' + 'tests' + '/'));

    if (testFiles.length === 0) {
      await this.emit('pty-output', { session_id, data: 'No test files found.\r\n' });
      await this.emit('pty-exit', { session_id, exit_code: 0 });
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
      await this.emit('pty-exit', { session_id, exit_code: 0 });
    } else {
      outputBuffer += `Test Suites: 1 failed, 1 total\nTests:       ${totalFailed} failed, ${totalPassed} passed, ${totalPassed + totalFailed} total\r\n`;
      await this.emit('pty-output', { session_id, data: outputBuffer });
      await this.emit('pty-exit', { session_id, exit_code: 1 });
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
    this.recordCall(command, args);

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
              await this.emit('pty-exit', { session_id, exit_code: 1 });
            } else {
              const fileList = Array.from(entries).sort().join('  \n');
              await this.emit('pty-output', { session_id, data: `${fileList}\r\n` });
              await this.emit('pty-exit', { session_id, exit_code: 0 });
            }
          } else if (cmd === 'pwd') {
            await this.emit('pty-output', { session_id, data: `${session.cwd}\r\n` });
            await this.emit('pty-exit', { session_id, exit_code: 0 });
          } else if (cmd === 'cd') {
            const target = cmdArgs[0] || '/workspace';
            const resolved = resolvePath(session.cwd, target);
            if (this.directories.has(resolved) || Array.from(this.files.keys()).some((f) => f.startsWith(resolved + '/'))) {
              session.cwd = resolved;
              await this.emit('pty-exit', { session_id, exit_code: 0 });
            } else {
              await this.emit('pty-output', { session_id, data: `cd: no such file or directory: ${target}\r\n` });
              await this.emit('pty-exit', { session_id, exit_code: 1 });
            }
          } else if (cmd === 'echo') {
            const echoContent = cmdArgs.join(' ');
            await this.emit('pty-output', { session_id, data: `${echoContent}\r\n` });
            await this.emit('pty-exit', { session_id, exit_code: 0 });
          } else if (cmd === 'cat') {
            const targetFile = cmdArgs[0] ? resolvePath(session.cwd, cmdArgs[0]) : null;
            if (targetFile && this.files.has(targetFile)) {
              await this.emit('pty-output', { session_id, data: `${this.files.get(targetFile)}\r\n` });
              await this.emit('pty-exit', { session_id, exit_code: 0 });
            } else {
              await this.emit('pty-output', { session_id, data: `cat: ${cmdArgs[0] || ''}: No such file or directory\r\n` });
              await this.emit('pty-exit', { session_id, exit_code: 1 });
            }
          } else if (cmd === 'clear') {
            await this.emit('pty-output', { session_id, data: '\x1b[2J\x1b[H' });
            await this.emit('pty-exit', { session_id, exit_code: 0 });
          } else if (cmd === 'git') {
            const sub = cmdArgs[0];
            if (sub === 'status') {
              const gitStatus = `On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\r\n`;
              await this.emit('pty-output', { session_id, data: gitStatus });
              await this.emit('pty-exit', { session_id, exit_code: 0 });
            } else if (sub === 'branch') {
              await this.emit('pty-output', { session_id, data: `* main\r\n` });
              await this.emit('pty-exit', { session_id, exit_code: 0 });
            } else if (sub === '--version' || sub === 'version') {
              await this.emit('pty-output', { session_id, data: `git version 2.45.0\r\n` });
              await this.emit('pty-exit', { session_id, exit_code: 0 });
            } else {
              await this.emit('pty-output', { session_id, data: `git: '${sub}' is not a git command. See 'git --help'.\r\n` });
              await this.emit('pty-exit', { session_id, exit_code: 1 });
            }
          } else if (cmd === 'whoami') {
            await this.emit('pty-output', { session_id, data: `developer\r\n` });
            await this.emit('pty-exit', { session_id, exit_code: 0 });
          } else if (cmd === 'date') {
            await this.emit('pty-output', { session_id, data: `${new Date().toUTCString()}\r\n` });
            await this.emit('pty-exit', { session_id, exit_code: 0 });
          } else if (cmd === 'npm' && (cmdArgs[0] === 'test' || cmdArgs[0] === 't')) {
            await this.runDynamicVirtualTests(session);
          } else {
            const shellName = (session.shell || '').includes('zsh') ? 'zsh' : 'bash';
            await this.emit('pty-output', { session_id, data: `${shellName}: command not found: ${cmd}\r\n` });
            await this.emit('pty-exit', { session_id, exit_code: 127 });
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

      // 5. pty_list_sessions
      case 'pty_list_sessions': {
        return Array.from(this.ptySessions.values());
      }

      // 6. fs_read_dir
      case 'fs_read_dir': {
        const { path, max_depth = 10 } = args;
        const normalized = path.replace(/\/+$/, '');
        const nodes = [];
        for (const dir of this.directories) {
          if (dir.startsWith(normalized) && dir !== normalized) {
            const rel = dir.slice(normalized.length + 1);
            if (!rel.includes('/') || max_depth > 1) {
              nodes.push({
                name: dir.split('/').pop(),
                path: dir,
                is_dir: true,
                size: 0,
                children: [],
              });
            }
          }
        }
        for (const [filePath, content] of this.files.entries()) {
          if (filePath.startsWith(normalized)) {
            const rel = filePath.slice(normalized.length + 1);
            nodes.push({
              name: filePath.split('/').pop(),
              path: filePath,
              is_dir: false,
              size: Buffer.byteLength(content, 'utf8'),
            });
          }
        }
        return nodes;
      }

      // 7. fs_read_file
      case 'fs_read_file': {
        const { path } = args;
        if (!this.files.has(path)) {
          throw new Error(`File not found: ${path}`);
        }
        return this.files.get(path);
      }

      // 8. fs_write_file
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

      // 12. agent_list
      case 'agent_list': {
        return Array.from(this.agents.values());
      }

      // 13. agent_create
      case 'agent_create': {
        const { name, role, model, systemPrompt = '', dependency = null } = args;
        if (!name || !name.trim()) {
          throw new Error('Agent name is required');
        }
        if (!model) {
          throw new Error('Agent model is required');
        }
        const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const newAgent = {
          id,
          name: name.trim(),
          role: role || 'Assistant',
          model,
          status: dependency ? 'waiting' : 'active',
          progress: 0,
          tokens: 0,
          cost: 0.0,
          dependency,
          systemPrompt,
          logs: [],
        };
        this.agents.set(id, newAgent);
        this.agentLogs.set(id, []);
        await this.emit('agent-updated', newAgent);
        return newAgent;
      }

      // 14. agent_update_status
      case 'agent_update_status': {
        const { agent_id, status } = args;
        const validStatuses = ['active', 'idle', 'waiting', 'error', 'completed', 'paused'];
        if (!validStatuses.includes(status)) {
          throw new Error(`Invalid agent status: ${status}`);
        }
        const agent = this.agents.get(agent_id);
        if (!agent) throw new Error(`Agent not found: ${agent_id}`);
        agent.status = status;
        if (status === 'completed') {
          agent.progress = 100;
          // Trigger dependent agents
          for (const other of this.agents.values()) {
            if (other.dependency === agent_id && other.status === 'waiting') {
              other.status = 'active';
              await this.emit('agent-updated', other);
            }
          }
        }
        await this.emit('agent-updated', agent);
        return agent;
      }

      // 15. agent_get_logs
      case 'agent_get_logs': {
        const { agent_id } = args;
        return this.agentLogs.get(agent_id) || [];
      }

      // 16. chat_send_message
      case 'chat_send_message': {
        const { agent_id, message } = args;
        const userMsg = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-user`,
          sender: 'user',
          text: message,
          timestamp: Date.now(),
        };
        this.chatMessages.push(userMsg);

        // Assistant response simulation
        const replyId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-asst`;
        const agent = this.agents.get(agent_id) || { name: 'Assistant', role: 'AI Specialist', model: 'Default' };
        const { fullText, tokens } = generateDynamicAgentResponse(agent, message);

        setTimeout(async () => {
          for (let i = 0; i < tokens.length; i++) {
            const isDone = i === tokens.length - 1;
            await this.emit('chat-token', {
              message_id: replyId,
              agent_id,
              token: tokens[i],
              done: isDone,
            });
          }
        }, 10);

        const asstMsg = {
          id: replyId,
          sender: 'assistant',
          agentId: agent_id,
          agentName: agent.name,
          text: fullText,
          timestamp: Date.now() + 50,
        };
        this.chatMessages.push(asstMsg);
        return asstMsg;
      }

      // 17. system_get_info
      case 'system_get_info': {
        return this.systemInfo;
      }

      default:
        throw new Error(`Unknown Tauri IPC command: ${command}`);
    }
  }
}
