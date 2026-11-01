import { readFile } from 'node:fs/promises'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Database } from '../../src/db/types.js'
import { validateTrustedReleaseLicenseConfig } from '../../src/licensing/trusted-release-config.js'
import { TrustBundleStore } from '../../src/licensing/trust/trust-bundle-store.js'
import type { TrustStoreWriteStage } from '../../src/licensing/trust/trust-bundle-store.js'
import { createTrustDatabaseCoordinator } from '../../src/licensing/trust/trust-database-coordinator.js'

const [directory, configPath, infoPath, schema, identityRoot, killAt] = process.argv.slice(2)
if (process.env.NODE_ENV !== 'test' || !process.send || !directory || !configPath || !infoPath || !schema || !identityRoot) {
  throw new Error('Trust contender requires an isolated test process and IPC')
}
if (!/^[a-z0-9_]+$/u.test(schema)) throw new Error('Invalid test schema')
const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
databaseUrl.searchParams.set('options', `-c search_path=${schema}`)
const pool = new Pool({ connectionString: databaseUrl.toString(), max: 2, application_name: 'aikayun-trust-contender-test' })
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const config = await validateTrustedReleaseLicenseConfig(JSON.parse(await readFile(configPath, 'utf8')))
const info = JSON.parse(await readFile(infoPath, 'utf8')) as { trust_bundle?: string; bundle_jws?: string }
const bundle = info.bundle_jws ?? info.trust_bundle
if (!bundle) throw new Error('Missing signed trust bundle')
const store = new TrustBundleStore({ directory, trustedRoot: config.offline_root,
  expectedCenterIssuer: config.expected_center_issuer, minimumBundleVersion: config.minimum_bundle_version,
  coordinator: createTrustDatabaseCoordinator({ db, identityRoot }),
  ...(killAt === undefined ? {} : { faultAt(stage: TrustStoreWriteStage) {
    if (stage === killAt) process.kill(process.pid, 'SIGKILL')
  } }) })
process.send({ ready: true })
try {
  await store.accept(bundle, () => Math.floor(Date.now() / 1000))
  process.send({ accepted: true })
  process.disconnect()
} finally {
  await db.destroy()
}
