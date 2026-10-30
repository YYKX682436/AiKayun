import { readFile } from 'node:fs/promises'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { LookupFunction } from 'node:net'
import type { Database } from '../../src/db/types.js'
import { createLicenseOperationRecoveryClient } from '../../src/licensing/license-operation-recovery-client.js'
import type { LicenseRecoveryCheckpoint } from '../../src/licensing/license-operation-recovery-client.js'
import { validateTrustedReleaseLicenseConfig } from '../../src/licensing/trusted-release-config.js'
import { TrustBundleStore } from '../../src/licensing/trust/trust-bundle-store.js'

const [checkpointName, occurrenceValue, schema, operationId, identityRoot, pendingKeyRoot, trustRoot, releaseConfigPath, infoPath] = process.argv.slice(2)
if (!checkpointName || !occurrenceValue || !schema || !operationId || !identityRoot || !pendingKeyRoot || !trustRoot || !releaseConfigPath || !infoPath) {
  throw new Error('Missing isolated operation recovery fixture arguments')
}

const occurrence = Number(occurrenceValue)
if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error('Invalid recovery checkpoint occurrence')
const releaseConfig = await validateTrustedReleaseLicenseConfig(JSON.parse(await readFile(releaseConfigPath, 'utf8')) as unknown)
const info = JSON.parse(await readFile(infoPath, 'utf8')) as { tls_ca: string }
const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
databaseUrl.searchParams.set('options', `-c search_path=${schema}`)
const pool = new Pool({ connectionString: databaseUrl.toString(), max: Number(process.env.RECOVERY_TEST_POOL_MAX ?? 6), application_name: 'aikayun-operation-recovery-test' })
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const lookup = ((hostname: string, optionsOrCallback: unknown, callbackMaybe?: (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void) => {
  const callback = callbackMaybe ?? (typeof optionsOrCallback === 'function'
    ? optionsOrCallback as (error: NodeJS.ErrnoException | null, address: string, family?: number) => void
    : undefined)
  if (!callback || !hostname) throw new Error('Invalid recovery test DNS lookup')
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
let seen = 0
const client = createLicenseOperationRecoveryClient({
  db,
  pool,
  identityRoot,
  pendingKeyRoot,
  releaseConfig,
  trustStore,
  testTls: { ca: info.tls_ca, lookup },
  onTestCheckpoint(stage: LicenseRecoveryCheckpoint) {
    if (stage !== checkpointName || occurrence === 0) return
    seen += 1
    if (seen === occurrence) process.kill(process.pid, 'SIGKILL')
  },
})

try {
  const mode = process.env.RECOVERY_TEST_MODE
  let result: unknown
  if (mode === 'parallel') {
    result = await Promise.all([client.queryPendingActivation(operationId), client.queryPendingActivation(operationId)])
  } else if (mode === 'busy') {
    const occupied = await pool.connect()
    const pending = client.queryPendingActivation(operationId)
    setTimeout(() => occupied.release(), 500)
    result = await pending
  } else if (mode === 'query') {
    result = await client.queryPendingActivation(operationId)
  } else {
    result = await client.recoverPendingActivation(operationId)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await db.destroy().catch(() => undefined)
}
