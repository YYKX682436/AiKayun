import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const baseURL = 'http://127.0.0.1:3010'
const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const mediaRoot = join(tmpdir(), 'aikayun-d7-playwright-media')

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
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  webServer: [
    {
      command: 'pnpm --filter @aikayun/api dev',
      url: 'http://127.0.0.1:3001/api/v1/health/live',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: testDatabaseUrl,
        NODE_ENV: 'test',
        PUBLIC_ORIGIN: baseURL,
        MEDIA_ROOT: mediaRoot,
        COOKIE_SECURE: 'false',
      },
    },
    {
      command: 'node .output/server/index.mjs',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'production',
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: '3010',
        NUXT_API_INTERNAL_URL: 'http://127.0.0.1:3001',
        NUXT_PUBLIC_SITE_URL: baseURL,
        NUXT_PUBLIC_STORE_NAME: '生产运行时商店',
        NUXT_PUBLIC_STORE_LOGO_URL: '',
        NUXT_PUBLIC_STORE_BRAND_COLOR: '#7C3AED',
      },
    },
  ],
})
