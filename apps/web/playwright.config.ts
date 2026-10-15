import { defineConfig, devices } from '@playwright/test'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true'
const alternateBrandURL = 'http://127.0.0.1:3002'
const alternateBrandServer = {
  command: 'pnpm --filter @aikayun/web exec nuxt dev --host 127.0.0.1 --port 3002',
  url: alternateBrandURL,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: {
    NUXT_API_INTERNAL_URL: 'http://127.0.0.1:3001',
    NUXT_PUBLIC_STORE_NAME: '青屿数字商店',
    NUXT_PUBLIC_STORE_LOGO_URL: '/configured-logo.svg',
    NUXT_PUBLIC_STORE_BRAND_COLOR: '#7C3AED',
    AIKAYUN_E2E_BUILD_DIR: '.nuxt/brand-alt',
  },
}

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/brand-alt.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'brand-alt',
      testMatch: '**/brand-alt.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: alternateBrandURL },
    },
  ],
  globalSetup: './test/e2e/global-setup.ts',
  webServer: useExternalServer ? [alternateBrandServer] : [
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
      command: 'pnpm --filter @aikayun/web dev --host 127.0.0.1',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NUXT_API_INTERNAL_URL: 'http://127.0.0.1:3001' },
    },
    alternateBrandServer,
  ],
})
