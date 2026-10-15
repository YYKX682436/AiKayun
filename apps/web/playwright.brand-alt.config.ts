import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3002'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/brand-alt.spec.ts',
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
    command: 'pnpm --filter @aikayun/web exec nuxt dev --host 127.0.0.1 --port 3002',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NUXT_API_INTERNAL_URL: 'http://127.0.0.1:3001',
      NUXT_PUBLIC_STORE_NAME: '青屿数字商店',
      NUXT_PUBLIC_STORE_LOGO_URL: '/configured-logo.svg',
      NUXT_PUBLIC_STORE_BRAND_COLOR: '#7C3AED',
      AIKAYUN_E2E_BUILD_DIR: '.nuxt/brand-alt',
    },
  },
})
