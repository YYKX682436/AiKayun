import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from '../../src/db/types.js'
import { createLicenseStateProjectionClient } from '../../src/licensing/license-state-projection.js'
import { validateTrustedReleaseLicenseConfig } from '../../src/licensing/trusted-release-config.js'
import { TrustBundleStore } from '../../src/licensing/trust/trust-bundle-store.js'

const [identityRoot, pendingRoot, trustRoot, releaseConfigPath] = process.argv.slice(2)
if (!identityRoot || !pendingRoot || !trustRoot || !releaseConfigPath || !process.env.DATABASE_URL) {
  throw new Error('Missing isolated license snapshot process arguments')
}

const releaseConfig = await validateTrustedReleaseLicenseConfig(JSON.parse(await readFile(releaseConfigPath, 'utf8')) as unknown)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, application_name: 'aikayun-license-snapshot-process-test' })
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const trustStore = new TrustBundleStore({
  directory: trustRoot,
  trustedRoot: releaseConfig.offline_root,
  expectedCenterIssuer: releaseConfig.expected_center_issuer,
  minimumBundleVersion: releaseConfig.minimum_bundle_version,
})

try {
  const snapshot = await createLicenseStateProjectionClient({
    db, pool, identityRoot, pendingKeyRoot: pendingRoot, releaseConfig, trustStore,
  }).getLicenseSnapshot()
  process.stdout.write(`${JSON.stringify(snapshot)}\n`)
} finally {
  await db.destroy()
}
