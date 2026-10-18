import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const baseURL = 'http://127.0.0.1:3002'
const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const apiPort = process.env.AIKAYUN_TEST_API_PORT ?? '3001'
const mediaRoot = join(tmpdir(), 'aikayun-d7-playwright-media')

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
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  webServer: [
    {
      command: 'pnpm --filter @aikayun/api dev',
      url: `http://127.0.0.1:${apiPort}/api/v1/health/live`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: testDatabaseUrl,
        API_PORT: apiPort,
        NODE_ENV: 'test',
        PUBLIC_ORIGIN: baseURL,
        MEDIA_ROOT: mediaRoot,
        COOKIE_SECURE: 'false',
      },
    },
    {
      command: 'pnpm --filter @aikayun/web exec nuxt dev --host 127.0.0.1 --port 3002',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NUXT_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
        NUXT_PUBLIC_SITE_URL: baseURL,
        NUXT_PUBLIC_STORE_NAME: '青屿数字商店',
        NUXT_PUBLIC_STORE_LOGO_URL: '/configured-logo.svg',
        NUXT_PUBLIC_STORE_BRAND_COLOR: '#7C3AED',
        AIKAYUN_E2E_BUILD_DIR: '.nuxt/brand-alt',
      },
    },
  ],
})
