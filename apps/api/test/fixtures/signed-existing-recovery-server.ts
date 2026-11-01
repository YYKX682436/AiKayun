/** Auxiliary API for the isolated Compose recovery test; never imported in production. */
import { createApp } from './create-app-with-license.js'
import { readConfig } from '../../src/config.js'
import { createDatabase, createPostgresPool } from '../../src/db/pool.js'
import { createSignedBusinessLicense } from './signed-business-license.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const centerCheckout = process.env.LICENSE_CENTER_CHECKOUT
if (process.env.NODE_ENV !== 'test' || !databaseUrl || !centerCheckout ||
  !new URL(databaseUrl).pathname.slice(1).endsWith('_test') || process.env.DATABASE_URL !== databaseUrl) {
  throw new Error('Recovery signed API requires an isolated test database and frozen center checkout')
}
const config = readConfig()
const db = createDatabase()
const pool = createPostgresPool({ applicationName: 'aikayun-recovery-signed-fixture' })
let fixture: Awaited<ReturnType<typeof createSignedBusinessLicense>> | undefined
let app: Awaited<ReturnType<typeof createApp>> | undefined
let closing = false
async function close() {
  if (closing) return
  closing = true
  await app?.close()
  await fixture?.close()
  await pool.end()
  await db.destroy()
}
try {
  fixture = await createSignedBusinessLicense({ db, pool, databaseUrl, centerCheckout,
    existingRoots: { identityRoot: config.identityRoot, pendingKeyRoot: config.licensePendingKeyRoot } })
  app = await createApp({ db, config, licenseForTests: { releaseConfig: fixture.options.releaseConfig,
    trustStore: fixture.options.trustStore, pool } })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void close().finally(() => process.exit(0)) })
  }
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  await close()
  throw error
}
