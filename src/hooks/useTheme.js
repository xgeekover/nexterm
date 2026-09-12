/**
 * No-op now that NexTerm is dark-only (light mode was removed from
 * settingsStore — there is no more `theme`/`setTheme`/`toggleTheme`/
 * `monacoTheme` to read). App.jsx still calls `useTheme()` on mount; that
 * call site lives outside this worker's file scope, so this hook is kept
 * (rather than deleted) purely so that import doesn't break. It still
 * ensures the `dark` class is present on <html> in case any legacy/external
 * CSS selector keys off it. Safe to delete this file and its call site in
 * App.jsx together in a future pass.
 */
import { useEffect } from 'react';

export function useTheme() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.add('dark');
    }
  }, []);
}

export default useTheme;
