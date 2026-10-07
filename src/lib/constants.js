/**
 * Application Constants
 */

export const APP_NAME = 'NexTerm';
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
