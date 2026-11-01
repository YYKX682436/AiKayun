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
  app.put('/__test/procurement-selection', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as { sources?: unknown }
      : undefined
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    if (!Array.isArray(body?.sources) || body.sources.length > 20 || body.sources.some(source =>
      !source || typeof source !== 'object' || Array.isArray(source) ||
      !('skuId' in source) || typeof source.skuId !== 'string' || !uuid.test(source.skuId) ||
      !('mappingVersionId' in source) || typeof source.mappingVersionId !== 'string' || !uuid.test(source.mappingVersionId))) {
      return reply.code(400).send({ error: { code: 'RECOVERY_FIXTURE_SELECTION_INVALID' } })
    }
    process.env.AIKAYUN_SYNTHETIC_PROCUREMENT_SELECTION = JSON.stringify(body.sources)
    return reply.code(204).send()
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void close().finally(() => process.exit(0)) })
  }
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  await close()
  throw error
}
