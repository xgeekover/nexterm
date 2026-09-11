import { create } from 'zustand';

export const useSettingsStore = create((set, get) => ({
  theme: 'dark',
  monacoTheme: 'nexterm-dark',
  activeView: 'terminal', // 'terminal' | 'editor' | 'agents' | 'chat' | 'all' — legacy, mapped onto shell flags below
  layoutMode: 'split', // 'split' | 'single'
  isCommandPaletteOpen: false,
  commandPaletteMode: 'all', // 'all' | 'files' (⌘P quick open)
  isSettingsModalOpen: false,

  // VS Code Dark Modern shell regions
  sidebarVisible: true, // primary sidebar (Explorer)
  panelVisible: true, // bottom panel (terminal)
  secondarySidebarVisible: true, // secondary sidebar (AI Chat / Agents)
  secondaryTab: 'chat', // 'chat' | 'agents'

  byokKeys: {
    openaiKey: '',
    claudeKey: '',
    geminiKey: '',
    ollamaUrl: 'http://localhost:11434',
  },

  modelPreference: 'claude-3-7-sonnet',

  setTheme: (theme) => {
    if (theme !== 'dark' && theme !== 'light') {
      throw new Error(`Invalid theme: ${theme}`);
    }

    if (typeof document !== 'undefined') {
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }

    set({
      theme,
      monacoTheme: theme === 'dark' ? 'nexterm-dark' : 'nexterm-light',
    });
  },

  toggleTheme: () => {
    const nextTheme = get().theme === 'dark' ? 'light' : 'dark';
    get().setTheme(nextTheme);
  },

  // Legacy view switcher — kept because other subsystems still call it to
  // bring their own region into view. It no longer hides everything else;
  // it just maps the old view name onto the new shell flags.
  setActiveView: (activeView) => {
    set({ activeView });
    switch (activeView) {
      case 'editor':
        set({ sidebarVisible: true });
        break;
      case 'terminal':
        set({ panelVisible: true });
        break;
      case 'chat':
        set({ secondarySidebarVisible: true, secondaryTab: 'chat' });
        break;
      case 'agents':
        set({ secondarySidebarVisible: true, secondaryTab: 'agents' });
        break;
      case 'all':
        set({ sidebarVisible: true, panelVisible: true, secondarySidebarVisible: true });
        break;
      default:
        break;
    }
  },
  setLayoutMode: (layoutMode) => set({ layoutMode }),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),

  // No tab: plain visibility toggle. With a tab: open on that tab if closed,
  // switch to that tab if open on a different one, or close if already open
  // on that exact tab (VS Code's activity-bar-click behaviour).
  toggleSecondarySidebar: (tab) => {
    set((state) => {
      if (!tab) {
        return { secondarySidebarVisible: !state.secondarySidebarVisible };
      }
      if (state.secondarySidebarVisible && state.secondaryTab === tab) {
        return { secondarySidebarVisible: false };
      }
      return { secondarySidebarVisible: true, secondaryTab: tab };
    });
  },
  setSecondaryTab: (tab) => set({ secondaryTab: tab }),

  setApiKey: (provider, key) => {
    set((state) => ({
      byokKeys: {
        ...state.byokKeys,
        [provider]: key,
      },
    }));
  },

  setModelPreference: (modelPreference) => set({ modelPreference }),
  setCommandPaletteOpen: (open, mode = 'all') =>
    set({ isCommandPaletteOpen: open, commandPaletteMode: open ? mode : 'all' }),
  setSettingsModalOpen: (open) => set({ isSettingsModalOpen: open }),
}));

export default useSettingsStore;
