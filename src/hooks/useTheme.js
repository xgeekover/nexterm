import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore.js';

export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);
  const monacoTheme = useSettingsStore((s) => s.monacoTheme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  }, [theme]);

  return {
    theme,
    monacoTheme,
    isDark: theme === 'dark',
    setTheme,
    toggleTheme,
  };
}

export default useTheme;
