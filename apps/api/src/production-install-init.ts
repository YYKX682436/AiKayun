import { createHash } from 'node:crypto'
import { createPostgresPool } from './db/pool.js'
import { readConfig } from './config.js'
import { initializeInstallationIdentity, verifyInstallationIdentity } from './licensing/installation-identity.js'
import {
  ensureProductionLicensePendingKey,
  loadLicensePendingKey,
  verifyBoundProductionLicensePendingKey,
} from './licensing/pending-encryption-key.js'

const pendingKeyBindingLock = 'aikayun:installation-identity:pending-key:v1'

export async function ensureBoundProductionPendingKey(
  pool: ReturnType<typeof createPostgresPool>,
  root: string,
  forbiddenRoots: string[] = [],
): Promise<{ keyId: string; created: boolean }> {
  if (process.env.NODE_ENV !== 'production') throw new Error('production_pending_key_environment_required')
  const client = await pool.connect()
  let candidate: { keyId: string; sha256: string; created: boolean } | undefined
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pendingKeyBindingLock])
    const stored = await client.query<{ pending_key_id: string | null; pending_key_sha256: string | null }>(`
      SELECT pending_key_id, pending_key_sha256
      FROM installation_binding WHERE singleton = true FOR UPDATE
    `)
    const row = stored.rows[0]
    if (!row) throw new Error('installation_binding_missing')

    if (row.pending_key_id === null && row.pending_key_sha256 === null) {
      const created = await ensureProductionLicensePendingKey(root, forbiddenRoots)
      const key = await loadLicensePendingKey(root, forbiddenRoots)
      if (created.keyId !== key.keyId) throw new Error('pending_key_changed_during_initialization')
      candidate = {
        keyId: key.keyId,
        sha256: createHash('sha256').update(key.key).digest('hex'),
        created: created.created,
      }
      const updated = await client.query(`
        UPDATE installation_binding
        SET pending_key_id = $1, pending_key_sha256 = $2
        WHERE singleton = true AND pending_key_id IS NULL AND pending_key_sha256 IS NULL
      `, [candidate.keyId, candidate.sha256])
      if (updated.rowCount !== 1) throw new Error('pending_key_binding_update_failed')
    } else if (row.pending_key_id && row.pending_key_sha256) {
      candidate = { keyId: row.pending_key_id, sha256: row.pending_key_sha256, created: false }
      await verifyBoundProductionLicensePendingKey(root, candidate, forbiddenRoots)
    } else {
      throw new Error('pending_key_binding_corrupt')
    }

    await client.query('COMMIT')
    return { keyId: candidate.keyId, created: candidate.created }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (candidate) {
      const committed = await pool.query<{ pending_key_id: string | null; pending_key_sha256: string | null }>(`
        SELECT pending_key_id, pending_key_sha256
        FROM installation_binding WHERE singleton = true
      `).catch(() => undefined)
      const actual = committed?.rows[0]
      if (actual?.pending_key_id === candidate.keyId && actual.pending_key_sha256 === candidate.sha256) {
        await verifyBoundProductionLicensePendingKey(root, candidate, forbiddenRoots)
        return { keyId: candidate.keyId, created: candidate.created }
      }
    }
    throw error
  } finally {
    client.release()
  }
}

/** Production image entrypoint invoked only by the fixed release Compose install phase. */
export async function runProductionInstallInitialization(mode: 'init' | 'verify' = 'init'): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('production_install_initialization_requires_NODE_ENV_production')
  }
  const config = readConfig()
  const pool = createPostgresPool({ applicationName: 'aikayun-production-install-init' })
  try {
    const forbiddenRoots = [config.mediaRoot, config.privateFileRoot, config.licenseTrustStoreRoot, config.licensePendingKeyRoot]
    const identity = mode === 'init'
      ? await initializeInstallationIdentity(pool, { identityRoot: config.identityRoot, mode: 'fresh', forbiddenRoots })
      : await verifyInstallationIdentity(pool, config.identityRoot, forbiddenRoots)
    if (identity.status !== 'ready') {
      throw new Error(`production_install_identity_${identity.code}`)
    }
    const pendingKeyForbiddenRoots = [config.mediaRoot, config.privateFileRoot, config.identityRoot, config.licenseTrustStoreRoot]
    const pendingKey = mode === 'init'
      ? await ensureBoundProductionPendingKey(pool, config.licensePendingKeyRoot, pendingKeyForbiddenRoots)
      : await (async () => {
          const binding = await pool.query<{ pending_key_id: string | null; pending_key_sha256: string | null }>(`
            SELECT pending_key_id, pending_key_sha256
            FROM installation_binding WHERE singleton = true
          `)
          const row = binding.rows[0]
          if (!row?.pending_key_id || !row.pending_key_sha256) throw new Error('pending_key_binding_missing')
          const key = await verifyBoundProductionLicensePendingKey(config.licensePendingKeyRoot, {
            keyId: row.pending_key_id, sha256: row.pending_key_sha256,
          }, pendingKeyForbiddenRoots)
          return { keyId: key.keyId, created: false }
        })()
    // Only public identifiers and stage state are emitted. The private key and AES key are never logged.
    process.stdout.write(`${JSON.stringify({
      status: 'ready',
      identity: identity.code,
      databaseId: identity.databaseId,
      instanceId: identity.instanceId,
      pendingKey: pendingKey.created ? 'created' : 'verified_existing',
    })}\n`)
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('production-install-init.js') || process.argv[1]?.endsWith('production-install-init.ts')) {
  try {
    const mode = process.argv[2] ?? 'init'
    if (mode !== 'init' && mode !== 'verify') throw new Error('production_install_mode_invalid')
    await runProductionInstallInitialization(mode)
  } catch (error) {
    const exposedCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error ? error.message : ''
    const code = /^[a-z0-9_]{1,100}$/iu.test(exposedCode)
      ? exposedCode.toLowerCase()
      : 'production_install_initialization_failed'
    process.stderr.write(`${JSON.stringify({ status: 'error', code })}\n`)
    process.exitCode = 1
  }
}
