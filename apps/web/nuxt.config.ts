export default defineNuxtConfig({
  compatibilityDate: '2026-10-15',
  // Allows isolated Playwright servers to exercise separate deployment themes.
  buildDir: process.env.AIKAYUN_E2E_BUILD_DIR ?? '.nuxt',
  nitro: {
    preset: 'node_server',
    esbuild: { options: { target: 'node24' } },
  },
  devtools: { enabled: false },
  modules: ['@nuxt/ui'],
  colorMode: {
    preference: 'system',
    storageKey: 'aikayun-color-mode',
  },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    apiInternalUrl: process.env.NUXT_API_INTERNAL_URL ?? 'http://127.0.0.1:3001',
    public: {
      apiBase: '/api/v1',
      storeName: 'AiKayun 数字商城',
      storeLogoUrl: '',
      storeBrandColor: '#2563EB',
    },
  },
  typescript: { strict: true, typeCheck: true },
  app: {
    head: {
      titleTemplate: '%s · AiKayun',
      htmlAttrs: { lang: 'zh-CN' },
      meta: [
        { name: 'description', content: '独立部署的数字商品商城系统' },
        { name: 'theme-color', content: '#f8fafc' },
      ],
    },
  },
})
