/** @type {import('tailwindcss').Config} */
// Every colour resolves to a CSS variable declared in src/styles/index.css,
// so a single `.dark` class flips the whole palette and components never
// need `dark:` variants. Usage: bg-vsc-sidebar, text-vsc-fg, border-vsc-border.
const v = (name) => `var(--vsc-${name})`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        vsc: {
          titlebar: v('titlebar-bg'),
          activitybar: v('activitybar-bg'),
          'activitybar-fg': v('activitybar-fg'),
          'activitybar-muted': v('activitybar-muted'),
          sidebar: v('sidebar-bg'),
          editor: v('editor-bg'),
          'tab-active': v('tab-active-bg'),
          'tab-inactive': v('tab-inactive-bg'),
          'tab-active-fg': v('tab-active-fg'),
          'tab-inactive-fg': v('tab-inactive-fg'),
          panel: v('panel-bg'),
          terminal: v('terminal-bg'),
          statusbar: v('statusbar-bg'),
          widget: v('widget-bg'),
          quickinput: v('quickinput-bg'),
          menu: v('menu-bg'),
          input: v('input-bg'),
          'input-border': v('input-border'),
          'input-border-hover': v('input-border-hover'),
          placeholder: v('input-placeholder'),
          'button-secondary': v('button-secondary'),

          fg: v('fg'),
          'fg-bright': v('fg-bright'),
          muted: v('muted'),
          border: v('border'),
          'widget-border': v('widget-border'),

          accent: v('accent'),
          'accent-hover': v('accent-hover'),
          'accent-solid': v('accent-solid'),
          'accent-pressed': v('accent-pressed'),
          'accent-text': v('accent-text'),
          'accent-fg': v('accent-fg'),
          focus: v('focus'),
          'focus-ring': v('focus-ring'),
          link: v('link'),
          badge: v('badge-bg'),
          'badge-fg': v('badge-fg'),
          'badge-accent': v('badge-accent'),

          hover: v('hover'),
          selection: v('selection'),
          'selection-fg': v('selection-fg'),
          'inactive-selection': v('inactive-selection'),
          'item-hover': v('item-hover'),
          'item-active': v('item-active'),

          error: v('error'),
          warn: v('warn'),
          attention: v('attention'),
          'attention-fg': v('attention-fg'),
          ok: v('ok'),
          info: v('info'),
          'git-modified': v('git-modified'),
          'git-added': v('git-added'),
          'git-deleted': v('git-deleted'),
          'git-untracked': v('git-untracked'),

          'line-number': v('line-number'),
          'indent-guide': v('indent-guide'),
        },
      },
      fontFamily: {
        ui: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        // VS Code's working sizes
        ui: ['13px', '1.4'],
        'ui-sm': ['11px', '1.3'],
        code: ['12px', '18px'],
      },
      // Corners (src/styles/index.css): rounded-control for fields, buttons
      // and small controls, rounded-popover for anything that floats.
      // rounded-sm (2px) stays on tab chips, group chips and inline items.
      borderRadius: {
        control: 'var(--radius-control)',
        popover: 'var(--radius-popover)',
      },
      // The one elevation, for popovers only. On the near-black surfaces
      // their --vsc-widget-border edge does most of the separating.
      boxShadow: {
        widget: '0 8px 24px -6px var(--vsc-shadow)',
      },
      spacing: {
        activitybar: '48px',
        tab: '35px',
        statusbar: '22px',
        'panel-header': '35px',
      },
    },
  },
  plugins: [],
};
