import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3110'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/d7-ssr-error.spec.ts',
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
  webServer: [
    {
      command: 'node test/e2e/d7-ssr-error-api.mjs',
      url: 'http://127.0.0.1:3111/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm --filter @aikayun/web exec nuxt dev --host 127.0.0.1 --port 3110',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AIKAYUN_E2E_BUILD_DIR: '.nuxt/d7-ssr-error',
        NUXT_API_INTERNAL_URL: 'http://127.0.0.1:3111',
        NUXT_PUBLIC_SITE_URL: baseURL,
      },
    },
  ],
})
