export default defineNuxtConfig({
  compatibilityDate: '2026-10-15',
  nitro: {
    preset: 'node_server',
    esbuild: { options: { target: 'node24' } },
  },
  devtools: { enabled: false },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    apiInternalUrl: process.env.NUXT_API_INTERNAL_URL ?? 'http://127.0.0.1:3001',
    public: { apiBase: '/api/v1' },
  },
  typescript: { strict: true, typeCheck: true },
  app: {
    head: {
      titleTemplate: '%s · AiKayun',
      meta: [
        { name: 'description', content: '独立部署的数字商品商城系统' },
        { name: 'theme-color', content: '#f7f8fc' },
      ],
    },
  },
})
