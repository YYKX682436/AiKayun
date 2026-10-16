import { defineConfig, devices } from '@playwright/test'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'
const webPort = new URL(baseURL).port || '3100'
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true'

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  testIgnore: ['**/brand-alt.spec.ts', '**/production-brand-runtime.spec.ts'],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  globalSetup: './test/e2e/global-setup.ts',
  webServer: useExternalServer ? undefined : [
    {
      command: 'pnpm --filter @aikayun/api dev',
      url: 'http://127.0.0.1:3001/api/v1/health/live',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL: testDatabaseUrl,
        NODE_ENV: 'test',
        PUBLIC_ORIGIN: baseURL,
        COOKIE_SECURE: 'false',
      },
    },
    {
      command: `pnpm --filter @aikayun/web exec nuxt dev --host 127.0.0.1 --port ${webPort}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NUXT_API_INTERNAL_URL: 'http://127.0.0.1:3001' },
    },
  ],
})
