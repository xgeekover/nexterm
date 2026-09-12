/**
 * Application Constants
 */

export const APP_NAME = 'NexTerm';
export const APP_VERSION = '0.1.0';

export const THEMES = {
  DARK: 'dark',
  LIGHT: 'light'
};

export const AI_MODELS = [
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'Anthropic', contextWindow: '200k' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', contextWindow: '128k' },
  { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', contextWindow: '1M' },
  { id: 'gemini-2-5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', contextWindow: '1M' },
  { id: 'ollama-local', name: 'Local Ollama (Llama 3)', provider: 'Local', contextWindow: '32k' }
];

export const AGENT_ROLES = [
  { id: 'architect', name: 'System Architect', icon: '🏗️', description: 'Designs component hierarchies, system contracts, and module boundaries' },
  { id: 'backend', name: 'Backend Engineer', icon: '⚙️', description: 'Implements Rust PTY, IPC bridge, file operations, and native systems' },
  { id: 'frontend', name: 'Frontend Engineer', icon: '🎨', description: 'Builds UI components, state management, layouts, and animations' },
  { id: 'qa', name: 'QA Specialist', icon: '🧪', description: 'Designs test suites, verifies edge cases, and benchmarks performance' },
  { id: 'reviewer', name: 'Code Reviewer', icon: '🔍', description: 'Reviews code diffs for security, maintainability, and clean architecture' }
];

export const IPC_COMMANDS = {
  PTY_SPAWN: 'pty_spawn',
  PTY_WRITE: 'pty_write',
  PTY_RESIZE: 'pty_resize',
  PTY_KILL: 'pty_kill',
  PTY_LIST_SESSIONS: 'pty_list_sessions',
  FS_READ_DIR: 'fs_read_dir',
  FS_READ_FILE: 'fs_read_file',
  FS_WRITE_FILE: 'fs_write_file',
  FS_CREATE_FILE: 'fs_create_file',
  FS_CREATE_DIR: 'fs_create_dir',
  FS_DELETE_PATH: 'fs_delete_path',
  AGENT_LIST: 'agent_list',
  AGENT_CREATE: 'agent_create',
  AGENT_UPDATE_STATUS: 'agent_update_status',
  AGENT_GET_LOGS: 'agent_get_logs',
  CHAT_SEND_MESSAGE: 'chat_send_message',
  SYSTEM_GET_INFO: 'system_get_info'
};

export const IPC_EVENTS = {
  PTY_OUTPUT: 'pty-output',
  PTY_EXIT: 'pty-exit',
  FS_CHANGE: 'fs-change',
  AGENT_UPDATED: 'agent-updated',
  AGENT_LOG: 'agent-log',
  CHAT_TOKEN: 'chat-token'
};

export const DEFAULT_KEYBINDINGS = {
  COMMAND_PALETTE: 'Mod+k',
  QUICK_OPEN: 'Mod+p',
  NEW_TERMINAL: 'Mod+`',
  SAVE_FILE: 'Mod+s',
  TOGGLE_THEME: 'Mod+Shift+t',
  TOGGLE_SIDEBAR: 'Mod+b',
  TOGGLE_CHAT: 'Mod+Shift+c'
};





export const DEFAULT_PROJECT_FILES = {
  '/workspace/package.json': JSON.stringify(
    {
      name: 'nexterm',
      version: '0.1.0',
      type: 'module',
      scripts: {
        test: `node ${['tests', 'e2e', 'runner.js'].join('/')}`,
      },
    },
    null,
    2
  ),
  '/workspace/README.md': '# NexTerm\n\nA desktop application combining Warp-style block terminal, Monaco editor, and multi-AI Mission Control.\n',
  '/workspace/src/main.jsx': "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n",
  '/workspace/src/App.jsx': "import React from 'react';\n\nexport default function App() {\n  return <div className=\"nexterm-root\">NexTerm IDE</div>;\n}\n",
  '/workspace/src/calculator.js': "export function calculateTotal(items) {\n  // Bug: multiplies instead of sums\n  return items.reduce((acc, item) => acc * item.price, 0);\n}\n",
  [['/workspace', 'tests', 'calculator.test.js'].join('/')]: "import { calculateTotal } from '../src/calculator.js';\n// Expected sum 30\nconst res = calculateTotal([{ price: 10 }, { price: 20 }]);\nif (res !== 30) throw new Error(`expected 30, got ${res}`);\n",
};

// Backward compatibility exports
export const SAMPLE_PROJECT_FILES = DEFAULT_PROJECT_FILES;

