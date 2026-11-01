/** Standalone Playwright API: real signed test evidence, never imported by production. */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createApp } from './create-app-with-license.js'
import { readConfig } from '../../src/config.js'
import { createDatabase, createPostgresPool } from '../../src/db/pool.js'
import { startDigitalDeliveryWorker } from '../../src/commerce/code-pool-delivery-worker.js'
import { startUnpaidOrderExpiryWorker } from '../../src/commerce/unpaid-order-expiry.js'
import { createSignedBusinessLicense } from './signed-business-license.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const centerCheckout = process.env.LICENSE_CENTER_CHECKOUT
if (process.env.NODE_ENV !== 'test' || !databaseUrl || !centerCheckout ||
  !new URL(databaseUrl).pathname.slice(1).endsWith('_test') || process.env.DATABASE_URL !== databaseUrl) {
  throw new Error('Playwright signed API requires an isolated test database and the frozen center checkout')
}
const root = resolve(import.meta.dirname, '../../../..')
const env = { ...process.env, ADMIN_INITIAL_EMAIL: 'browser-test@example.com', ADMIN_INITIAL_PASSWORD: 'Only-For-E2E-Tests-2026!!' }
execFileSync('pnpm', ['--filter', '@aikayun/api', 'db:reset:test'], { cwd: root, env, stdio: 'inherit' })
const db = createDatabase()
const pool = createPostgresPool({ applicationName: 'aikayun-playwright-license-fixture' })
let fixture: Awaited<ReturnType<typeof createSignedBusinessLicense>> | undefined
let app: Awaited<ReturnType<typeof createApp>> | undefined
let stopDigitalDelivery: (() => Promise<void>) | undefined
let stopUnpaidOrderExpiry: (() => Promise<void>) | undefined
let closing = false
async function close() {
  if (closing) return
  closing = true
  await stopUnpaidOrderExpiry?.()
  await stopDigitalDelivery?.()
  await app?.close()
  await fixture?.close()
  await pool.end()
  await db.destroy()
}
try {
  fixture = await createSignedBusinessLicense({ db, pool, databaseUrl, centerCheckout })
  execFileSync('pnpm', ['--filter', '@aikayun/api', 'admin:init'], { cwd: root, env, stdio: 'inherit' })
  const config = { ...readConfig(), identityRoot: fixture.options.identityRoot, licensePendingKeyRoot: fixture.options.pendingKeyRoot }
  app = await createApp({ db, config, licenseForTests: { releaseConfig: fixture.options.releaseConfig,
    trustStore: fixture.options.trustStore, pool },
    ...(process.env.PAYMENT_PROVIDER_BASE_URL_FOR_TESTS ? { paymentProviderBaseUrlForTests: process.env.PAYMENT_PROVIDER_BASE_URL_FOR_TESTS } : {}),
  })
  stopUnpaidOrderExpiry = startUnpaidOrderExpiryWorker(db, app.log)
  stopDigitalDelivery = startDigitalDeliveryWorker(db, config, app.log)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void close().finally(() => process.exit(0)) })
  }
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  await close()
  throw error
}
