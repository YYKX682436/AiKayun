export default defineNuxtConfig({
  compatibilityDate: '2026-10-15',
  // Allows isolated Playwright servers to exercise separate deployment themes.
  buildDir: process.env.AIKAYUN_E2E_BUILD_DIR ?? '.nuxt',
  nitro: {
    preset: 'node_server',
    esbuild: { options: { target: 'node24' } },
  },
  vite: {
    optimizeDeps: {
      // The admin product editor is lazy-loaded, so its direct dependencies
      // and Nuxt UI's nested editor dependencies are otherwise discovered only
      // after the browser begins loading the editor chunk.
      include: [
        '@tiptap/core',
        '@tiptap/extension-blockquote',
        '@tiptap/extension-bold',
        '@tiptap/extension-bullet-list',
        '@tiptap/extension-heading',
        '@tiptap/extension-horizontal-rule',
        '@tiptap/extension-image',
        '@tiptap/extension-italic',
        '@tiptap/extension-link',
        '@tiptap/extension-list-item',
        '@tiptap/extension-ordered-list',
        '@nuxt/ui > @tiptap/core',
        '@nuxt/ui > @tiptap/extension-code',
        '@nuxt/ui > @tiptap/extension-horizontal-rule',
        '@nuxt/ui > @tiptap/extension-image',
        '@nuxt/ui > @tiptap/extension-mention',
        '@nuxt/ui > @tiptap/extension-placeholder',
        '@nuxt/ui > @tiptap/markdown',
        '@nuxt/ui > @tiptap/pm/state',
        '@nuxt/ui > @tiptap/starter-kit',
        '@nuxt/ui > @tiptap/suggestion',
        '@nuxt/ui > @tiptap/vue-3',
      ],
    },
  },
  devtools: { enabled: false },
  modules: ['@nuxt/ui'],
  icon: {
    serverBundle: { collections: ['lucide'] },
  },
  colorMode: {
    preference: 'system',
    storageKey: 'aikayun-color-mode',
  },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    apiInternalUrl: process.env.NUXT_API_INTERNAL_URL ?? 'http://127.0.0.1:3001',
    public: {
      apiBase: '/api/v1',
      // Trusted deployment configuration; never derive canonical URLs from request Host headers.
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000',
      storeName: 'AiKayun 数字商城',
      storeLogoUrl: '',
      storeBrandColor: '#2563EB',
    },
  },
  typescript: { strict: true, typeCheck: true },
  hooks: {
    'pages:extend'(pages) {
      if (process.env.NODE_ENV !== 'production') return
      const previewIndex = pages.findIndex(page => page.path === '/dev-preview')
      if (previewIndex !== -1) pages.splice(previewIndex, 1)
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      meta: [
        { name: 'description', content: '独立部署的数字商品商城系统' },
      ],
    },
  },
})
