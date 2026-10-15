import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { FullConfig } from '@playwright/test'

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true') return

  const testDatabaseUrl = process.env.TEST_DATABASE_URL
    ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
  const databaseName = new URL(testDatabaseUrl).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error('E2E tests require a dedicated PostgreSQL database ending in _test')
  }

  const workspaceRoot = resolve(import.meta.dirname, '../../../..')
  const env = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    TEST_DATABASE_URL: testDatabaseUrl,
    ADMIN_INITIAL_EMAIL: 'browser-test@example.com',
    ADMIN_INITIAL_PASSWORD: 'Only-For-E2E-Tests-2026!!',
  }
  execFileSync('pnpm', ['--filter', '@aikayun/api', 'db:reset:test'], { cwd: workspaceRoot, env, stdio: 'inherit' })
  execFileSync('pnpm', ['--filter', '@aikayun/api', 'admin:init'], { cwd: workspaceRoot, env, stdio: 'inherit' })
}
