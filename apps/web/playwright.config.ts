import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const apiPort = process.env.AIKAYUN_TEST_API_PORT ?? '3001'
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'
const webPort = new URL(baseURL).port || '3100'
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true'
const useProductionBuild = process.env.PLAYWRIGHT_USE_PRODUCTION_SERVER === 'true'
const mediaRoot = join(tmpdir(), 'aikayun-d7-playwright-media')

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  testIgnore: [
    '**/brand-alt.spec.ts',
    '**/dev-preview.spec.ts',
    '**/production-brand-runtime.spec.ts',
    '**/d7-ssr-error.spec.ts',
  ],
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
        TRUST_PROXY: 'true',
      },
    },
    {
      command: useProductionBuild
        ? 'pnpm --filter @aikayun/web start'
        : `pnpm --filter @aikayun/web exec nuxt dev --host 127.0.0.1 --port ${webPort}`,
      // The storefront SSR route depends on migrated catalog tables. Probe the
      // self-contained admin entry so the server can start before globalSetup
      // initializes the disposable test database.
      url: new URL('/admin/login', baseURL).toString(),
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...(useProductionBuild ? {
          NODE_ENV: 'production',
          NITRO_HOST: '127.0.0.1',
          NITRO_PORT: webPort,
        } : {}),
        NUXT_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
        NUXT_PUBLIC_SITE_URL: baseURL,
      },
    },
  ],
  globalTeardown: './test/e2e/global-teardown.ts',
})
