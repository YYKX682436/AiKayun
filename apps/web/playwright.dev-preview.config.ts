import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3120'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/dev-preview.spec.ts',
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
  webServer: [{
    command: 'pnpm --filter @aikayun/web exec nuxt dev --host 127.0.0.1 --port 3120',
    url: new URL('/dev-preview', baseURL).toString(),
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'development',
      NUXT_PUBLIC_SITE_URL: baseURL,
      AIKAYUN_E2E_BUILD_DIR: '.nuxt/dev-preview',
    },
  }],
})
