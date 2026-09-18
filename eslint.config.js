/**
 * The checks that catch what the test suites structurally cannot see.
 *
 * `tests/e2e/` and `tests/adversarial/` run in Node against a mock backend and
 * never mount a component, so a mistake in a component's RENDER produces a
 * clean build, a clean `cargo test`, several hundred green cases — and a white
 * screen the moment that branch is drawn. That happened twice in one day:
 *
 *   - `GroupSwitcher` read the `tabs` binding of a DIFFERENT component in the
 *     same file. ReferenceError, whole React tree down.
 *   - `FileExplorer` used `cn` without importing it. Same shape, caught only
 *     because the first one had taught the habit.
 *
 * And once more in a form that renders perfectly and simply does not work:
 *
 *   - a component declared INSIDE another component's render is a new type on
 *     every render, so React remounts it — and a real click needs mousedown
 *     and mouseup on the SAME element, so every click was swallowed.
 *
 * All three are visible without running anything, which is why this file
 * exists and why the rule list is short. It is not a style config: nothing
 * here is about how the code looks, and formatting rules are deliberately
 * absent so that a lint failure always means something is actually wrong.
 */
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'docs/**'],
  },
  {
    files: ['src/**/*.{js,jsx}', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        // Vite's define-time constant, and the debug handle the app hangs off
        // `window` in development (see `?debug`).
        __nexterm: 'readonly',
      },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      // ---- The three that caught real bugs -----------------------------
      /** The white screens. An identifier that is not in scope. */
      'no-undef': 'error',
      /** The swallowed clicks: a component defined inside another's render. */
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
      /** A hook called conditionally reorders state between renders. */
      'react-hooks/rules-of-hooks': 'error',
      /** Advice, not law — the codebase already carries disable comments for
       *  it from before any linter ran, and those are deliberate. */
      'react-hooks/exhaustive-deps': 'warn',

      // ---- Cheap correctness, all of it about behaviour ------------------
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      'require-atomic-updates': 'off',
      /** An unused import is usually a leftover from a half-finished edit. */
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      /** Without these two, every component in a JSX file looks unused. */
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      /** JSX that is never returned, a prop spelled two ways, a missing key. */
      'react/jsx-key': 'error',
      'react/jsx-no-duplicate-props': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-children-prop': 'error',
      'react/no-direct-mutation-state': 'error',
    },
  },
  {
    // The browser mock and the harness deliberately stand in for globals the
    // real app has, and the runners are scripts rather than modules.
    files: ['tests/**/*.js'],
    rules: { 'no-unused-vars': 'off' },
  },
];
