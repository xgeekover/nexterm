import { create } from 'zustand';
import { invoke } from '../lib/ipc.js';
import { isMac, isWindows } from '../lib/platform.js';

/**
 * What machine we are on.
 *
 * `system_get_info` has existed since the first release and nothing called it,
 * so the status bar guessed — or rather, hard-coded. Fetched once at startup
 * and cached; the browser falls back to what the user agent admits to, which
 * is enough to pick the right conventions when there is no backend.
 */
function browserFallback() {
  return {
    os: isWindows ? 'windows' : isMac ? 'macos' : 'linux',
    arch: null,
    homeDir: null,
    defaultShell: null,
    appVersion: null,
  };
}

export const useSystemStore = create((set, get) => ({
  os: browserFallback().os,
  arch: null,
  homeDir: null,
  defaultShell: null,
  appVersion: null,
  isLoaded: false,

  /**
   * The shells this machine actually has, as `{ id, label, spec }`.
   *
   * Found by the backend rather than assumed: the Settings window used to
   * offer a fixed list per platform, which promised "PowerShell 7" on boxes
   * without it and never mentioned Git Bash or WSL. Empty is a legitimate
   * answer — "Default" always works, because the backend decides at spawn.
   */
  shells: [],

  init: async () => {
    if (get().isLoaded) return;
    try {
      const info = await invoke('system_get_info');
      // Asked for alongside the rest; a backend too old to answer just leaves
      // the list empty, and every picker falls back to "Default".
      let shells = [];
      try {
        const found = await invoke('system_list_shells');
        if (Array.isArray(found)) {
          shells = found.filter((s) => s && typeof s.spec === 'string' && s.spec);
        }
      } catch (err) {
        console.warn('[system] could not list shells:', err);
      }
      set({ shells });
      if (info && typeof info === 'object') {
        set({
          os: info.os || browserFallback().os,
          arch: info.arch ?? null,
          homeDir: info.home_dir ?? null,
          defaultShell: info.default_shell ?? null,
          appVersion: info.app_version ?? null,
          // Windows build number; terminals need it to know how ConPTY wraps.
          osBuild: info.os_build ?? null,
          isLoaded: true,
        });
        return;
      }
    } catch (err) {
      console.warn('[SystemStore] system_get_info unavailable; using browser defaults:', err);
    }
    set({ ...browserFallback(), isLoaded: true });
  },
}));

export default useSystemStore;
