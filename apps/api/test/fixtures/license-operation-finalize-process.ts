import { readFile } from 'node:fs/promises'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { LookupFunction } from 'node:net'
import type { Database } from '../../src/db/types.js'
import { finalizeTrustedActivationRejection } from '../../src/licensing/license-operation-recovery-client.js'
import { validateTrustedReleaseLicenseConfig } from '../../src/licensing/trusted-release-config.js'
import { fetchTrustedTimeAnchor } from '../../src/licensing/trust/time-anchor-client.js'
import { TrustBundleStore } from '../../src/licensing/trust/trust-bundle-store.js'

const [schema, operationId, attemptValue, identityRoot, pendingKeyRoot, trustRoot, releaseConfigPath, infoPath] = process.argv.slice(2)
if (!schema || !operationId || !attemptValue || !identityRoot || !pendingKeyRoot || !trustRoot || !releaseConfigPath || !infoPath) {
  throw new Error('Missing isolated trusted-rejection finalization fixture arguments')
}
const evidenceAttemptNo = Number(attemptValue)
if (!Number.isSafeInteger(evidenceAttemptNo) || evidenceAttemptNo < 1) throw new Error('Invalid evidence attempt number')
const releaseConfig = await validateTrustedReleaseLicenseConfig(JSON.parse(await readFile(releaseConfigPath, 'utf8')) as unknown)
const info = JSON.parse(await readFile(infoPath, 'utf8')) as { tls_ca: string }
const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
databaseUrl.searchParams.set('options', `-c search_path=${schema}`)
const pool = new Pool({ connectionString: databaseUrl.toString(), max: 3, application_name: 'aikayun-operation-finalize-test' })
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const lookup = ((hostname: string, optionsOrCallback: unknown, callbackMaybe?: (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void) => {
  const callback = callbackMaybe ?? (typeof optionsOrCallback === 'function'
    ? optionsOrCallback as (error: NodeJS.ErrnoException | null, address: string, family?: number) => void
    : undefined)
  if (!callback || !hostname) throw new Error('Invalid test DNS lookup')
  if (typeof optionsOrCallback === 'object' && optionsOrCallback !== null && 'all' in optionsOrCallback && optionsOrCallback.all === true) {
    callback(null, [{ address: '127.0.0.1', family: 4 }])
  } else {
    callback(null, '127.0.0.1', 4)
  }
}) as LookupFunction
const trustStore = new TrustBundleStore({
  directory: trustRoot,
  trustedRoot: releaseConfig.offline_root,
  expectedCenterIssuer: releaseConfig.expected_center_issuer,
  minimumBundleVersion: releaseConfig.minimum_bundle_version,
})

try {
  const candidate = await trustStore.getCandidateForTimeBootstrap()
  if (!candidate) throw new Error('Trusted center bundle is unavailable')
  const sample = await fetchTrustedTimeAnchor(releaseConfig, candidate, { testCa: info.tls_ca, testLookup: lookup })
  await finalizeTrustedActivationRejection({
    options: { db, pool, identityRoot, pendingKeyRoot, releaseConfig, trustStore, testTls: { ca: info.tls_ca, lookup } },
    operationId,
    evidenceAttemptNo,
    readTrustedTime: sample.assertFresh,
  })
  process.stdout.write('trusted_rejection_finalized\n')
} finally {
  await db.destroy().catch(() => undefined)
}
