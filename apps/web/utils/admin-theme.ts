export const adminThemeUi = {
  button: {
    base: 'rounded-lg font-medium transition-colors',
  },
  badge: {
    base: 'rounded-md font-medium',
  },
  card: {
    root: 'rounded-xl transition-shadow ring ring-default/70 shadow-xs',
  },
  dashboardNavbar: {
    root: 'h-14 border-b border-default/70 bg-elevated/80 backdrop-blur-md sticky top-0 z-30 px-4 sm:px-6',
    title: 'text-base font-semibold text-highlighted tracking-tight',
    toggle: 'min-h-11 min-w-11',
  },
  dashboardSidebar: {
    root: 'border-e border-default/70 bg-elevated',
    header: 'h-14 border-b border-default/60 px-4',
    footer: 'border-t border-default/60 px-3 py-3',
  },
  navigationMenu: {
    label: 'px-3 pt-3 pb-1 text-xs font-semibold text-muted uppercase tracking-wider',
    link: 'rounded-lg font-medium transition-colors text-sm py-2 px-3',
  },
  table: {
    th: 'text-xs font-semibold text-muted bg-muted/25 py-3 px-4 uppercase tracking-wider',
    td: 'py-3.5 px-4 text-sm',
  },
} as const
