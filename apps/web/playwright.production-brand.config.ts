import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3010'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/production-brand-runtime.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node .output/server/index.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '3010',
      NUXT_PUBLIC_STORE_NAME: '生产运行时商店',
      NUXT_PUBLIC_STORE_LOGO_URL: '',
      NUXT_PUBLIC_STORE_BRAND_COLOR: '#7C3AED',
    },
  },
})
