export default defineAppConfig({
  ui: {
    colors: {
      primary: 'brand',
      secondary: 'sky',
      success: 'green',
      info: 'blue',
      warning: 'amber',
      error: 'red',
      neutral: 'slate',
    },
    button: {
      slots: { base: 'rounded-lg' },
    },
    input: {
      slots: { base: 'rounded-lg' },
    },
    card: {
      slots: { root: 'rounded-xl' },
      variants: {
        variant: {
          outline: { root: 'bg-elevated' },
        },
      },
    },
    modal: {
      variants: {
        fullscreen: {
          false: { content: 'rounded-2xl' },
          true: { content: 'rounded-none' },
        },
      },
    },
  },
})
