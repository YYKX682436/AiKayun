import { readFile } from 'node:fs/promises'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { Database } from '../../src/db/types.js'
import { createNewObligationGate } from '../../src/licensing/new-obligation-gate.js'
import { validateTrustedReleaseLicenseConfig } from '../../src/licensing/trusted-release-config.js'
import { TrustBundleStore } from '../../src/licensing/trust/trust-bundle-store.js'

const [schema, identityRoot, pendingRoot, trustRoot, configPath] = process.argv.slice(2)
const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
if (process.env.NODE_ENV !== 'test' || !process.send || !schema || !identityRoot || !pendingRoot || !trustRoot || !configPath ||
  !/^[a-z0-9_]+$/u.test(schema) || !databaseUrl.pathname.slice(1).endsWith('_test')) {
  throw new Error('Commit crash fixture requires an isolated test database and IPC')
}
const releaseConfig = await validateTrustedReleaseLicenseConfig(JSON.parse(await readFile(configPath, 'utf8')) as unknown)
const pool = new Pool({ connectionString: databaseUrl.toString(), options: `-c search_path=${schema}`, max: 3,
  application_name: 'aikayun-gate-commit-crash-test' })
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const trustStore = new TrustBundleStore({ directory: trustRoot, trustedRoot: releaseConfig.offline_root,
  expectedCenterIssuer: releaseConfig.expected_center_issuer, minimumBundleVersion: releaseConfig.minimum_bundle_version })
const gate = createNewObligationGate({ db, pool, identityRoot, pendingKeyRoot: pendingRoot, trustStoreRoot: trustRoot,
  test: { releaseConfig, trustStore } })
try {
  await gate.withTransactionScope(() => db.transaction().execute(async trx => {
    await gate.assertNewObligationAllowed(trx, 'create_order')
    await sql`INSERT INTO admission_commit_crash_probe (id) VALUES (1)`.execute(trx)
    const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
    await new Promise<void>((resolve, reject) => {
      process.send!({ inserted: true, pid: backend.rows[0]!.pid }, error => error ? reject(error) : resolve())
    })
  }))
} finally {
  await db.destroy()
}
