import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'
import type { Database } from '../db/types.js'
import { createLicenseOperationRecoveryClient } from './license-operation-recovery-client.js'
import { createLicenseStateProjectionClient } from './license-state-projection.js'
import { loadEmbeddedTrustedReleaseLicenseConfig } from './trusted-release-config.js'
import { createReleaseBoundTrustStore } from './trust/service.js'
import type { TrustedReleaseLicenseConfig } from './trusted-release-config.js'
import type { TrustBundleStore } from './trust/trust-bundle-store.js'
import { createTrustDatabaseCoordinator } from './trust/trust-database-coordinator.js'
import type { TestLicenseTlsOptions } from './license-request-http.js'
import type { LicenseRecoveryCheckpoint } from './license-operation-recovery-client.js'
import { withVerifiedInstallationSigningContext } from './installation-identity.js'
import { advanceLicenseTrustedTime } from './license-trusted-time.js'
import { fetchTrustedTimeAnchor } from './trust/time-anchor-client.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const LOCK_KEY = 'aikayun-license-renewal-worker'

/** Stable jitter prevents every poll (or process restart) from moving the due time. */
export function renewalDueAt(input: { issuedAt: number; renewAfter: number; expiresAt: number; credentialId: string }): number {
  const digest = createHash('sha256').update(input.credentialId).digest()
  const fraction = digest.readUInt32BE(0) / 0xffff_ffff * 2 - 1
  const interval = Math.max(0, input.renewAfter - input.issuedAt)
  // Leave a full poll interval before expiry, but never schedule before issuance
  // when the signed lease is shorter than that interval.
  return Math.max(input.issuedAt, Math.min(input.expiresAt - MINUTE, input.renewAfter + Math.round(interval * 0.1 * fraction)))
}

/** Backoff is derived from persisted attempt timestamps, so restart or another instance cannot reset it. */
export function renewalRetryAt(lastAttempt: number, attemptCount: number, seed: string): number {
  const base = Math.min(HOUR, MINUTE * 2 ** Math.min(Math.max(attemptCount - 1, 0), 6))
  const digest = createHash('sha256').update(`${seed}:${attemptCount}`).digest()
  const factor = 0.9 + 0.2 * digest.readUInt32BE(0) / 0xffff_ffff
  return lastAttempt + Math.round(base * factor)
}

export interface LicenseRenewalWorkerOptions {
  db: Kysely<Database>
  pool: Pool
  identityRoot: string
  pendingKeyRoot: string
  trustStoreRoot: string
  logger: FastifyBaseLogger
  /** Isolated integration tests only. Production always uses the embedded release and normal intervals. */
  test?: { releaseConfig: TrustedReleaseLicenseConfig; trustStore: TrustBundleStore; tls: TestLicenseTlsOptions;
    pollIntervalMs?: number; skipRetryDelay?: boolean; lowFrequencyMs?: number;
    databaseTimeMs?: number;
    onCheckpoint?: (stage: LicenseRecoveryCheckpoint) => void | Promise<void> }
}

/** The worker holds a PostgreSQL session lock, never a business transaction, during network I/O. */
export function startLicenseRenewalWorker(options: LicenseRenewalWorkerOptions): () => Promise<void> {
  if (options.test && process.env.NODE_ENV !== 'test') throw new Error('license_worker_test_options_forbidden')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: Promise<void> | undefined
  let failures = 0

  const pass = async () => {
    const config = options.test?.releaseConfig ?? await loadEmbeddedTrustedReleaseLicenseConfig()
    if (!config || stopped) return
    const session = await options.pool.connect()
    let locked = false
    let lost = false
    const onError = () => { lost = true }
    session.on('error', onError)
    try {
      const lock = await session.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [LOCK_KEY])
      locked = lock.rows[0]?.acquired === true
      if (!locked || stopped || lost) return
      const trustCoordinator = createTrustDatabaseCoordinator({ db: options.db, identityRoot: options.identityRoot })
      const assertHeld = async () => {
        if (lost) throw new Error('license_renewal_worker_lock_lost')
        await session.query('SELECT 1')
        if (lost) throw new Error('license_renewal_worker_lock_lost')
      }
      const clientOptions = {
        db: options.db, pool: options.pool, identityRoot: options.identityRoot, pendingKeyRoot: options.pendingKeyRoot,
        releaseConfig: config, trustStore: options.test?.trustStore ?? createReleaseBoundTrustStore(config, options.trustStoreRoot, trustCoordinator),
        ...(options.test ? { testTls: options.test.tls } : {}),
        ...(options.test?.onCheckpoint ? { onTestCheckpoint: options.test.onCheckpoint } : {}),
      }
      const state = await options.db.selectFrom('instance_license_state').selectAll().where('singleton', '=', true).executeTakeFirst()
      if (!state?.license_id || !state.database_id || !state.instance_id || !state.identity_jkt ||
        !state.activation_generation || !state.entitlement_revision || state.refusal_status === 'superseded') return
      const current = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(options.db)
      const databaseTime = options.test?.databaseTimeMs ?? current.rows[0]?.now.getTime()
      const watermark = Number(state.trusted_time_high_water_ms)
      if (databaseTime === undefined || !Number.isSafeInteger(databaseTime) || !Number.isSafeInteger(watermark) || watermark <= 0) {
        throw new Error('license_renewal_database_time_unavailable')
      }
      const now = Math.max(databaseTime, watermark)
      // A previous untrusted DB clock could have jumped far ahead before the signed anchor
      // rejected it. Such a retry deadline cannot be produced by the bounded backoff on a
      // healthy clock; ignore it so fixing the clock does not strand renewal for years.
      const retryDelay = state.renewal_retry_after ? state.renewal_retry_after.getTime() - now : 0
      if (!options.test?.skipRetryDelay && retryDelay > 0 && retryDelay <= HOUR * 1.1 + MINUTE) return
      const pending = await options.db.selectFrom('local_license_operations').selectAll()
        .where('kind', '=', 'renewal').where('state', 'in', ['pending', 'response_saved'])
        .where('database_id', '=', state.database_id).where('instance_id', '=', state.instance_id)
        .orderBy('created_at', 'asc').executeTakeFirst()
      // A refusal remains archived after a newer lease restores service. Its revision is
      // only a local prefilter; the later signed snapshot is authoritative for new work.
      const lowFrequency = (state.refusal_status === 'revoked' || state.refusal_status === 'expired') &&
        (!state.credential_jti || state.refusal_revision === null ||
          BigInt(state.refusal_revision) >= BigInt(state.entitlement_revision))
      if (!pending) {
        if (lowFrequency) {
          const latest = await options.db.selectFrom('local_license_operations').select('created_at')
            .where('kind', '=', 'renewal').where('database_id', '=', state.database_id).where('instance_id', '=', state.instance_id)
            .orderBy('created_at', 'desc').executeTakeFirst()
          if (latest && now < latest.created_at.getTime() + (options.test?.lowFrequencyMs ?? HOUR)) return
        } else {
          if (!state.credential_jti) return
          const issuedAt = Number(state.credential_issued_at) * 1000
          const expiresAt = Number(state.credential_expires_at) * 1000
          if (![issuedAt, expiresAt].every(Number.isFinite)) return
          const renewAfter = Math.min(issuedAt + 6 * HOUR, expiresAt)
          if (now < renewalDueAt({ issuedAt, renewAfter, expiresAt, credentialId: state.credential_jti })) return
        }
      }
      // Identity and candidate trust are checked before contacting the center. Reserve the next
      // retry before the time-anchor request, so a crash or failure before an attempt still backs off.
      await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async identity => {
        if (identity.databaseId !== state.database_id || identity.instanceId !== state.instance_id ||
          identity.identityJkt !== state.identity_jkt) throw new Error('license_renewal_identity_mismatch')
        const candidate = await clientOptions.trustStore.getCandidateForTimeBootstrap()
        if (!candidate || candidate.claims.sub !== config.expected_center_issuer) throw new Error('license_renewal_trust_unavailable')
        await assertHeld()
        const count = Math.min(state.renewal_retry_count + 1, 7)
        await options.db.updateTable('instance_license_state').set({
          renewal_retry_count: count,
          renewal_retry_after: new Date(renewalRetryAt(now, count, state.identity_jkt!)),
        }).where('singleton', '=', true).executeTakeFirstOrThrow()
        await assertHeld()
        const sample = await fetchTrustedTimeAnchor(config, candidate, options.test ? {
          ...(options.test.tls.ca === undefined ? {} : { testCa: options.test.tls.ca }),
          ...(options.test.tls.lookup === undefined ? {} : { testLookup: options.test.tls.lookup }),
        } : {})
        await options.db.transaction().execute(async tx => clientOptions.trustStore.withDatabaseTransaction(tx, async () => {
          const binding = await tx.selectFrom('installation_binding').selectAll().where('singleton', '=', true).forUpdate().executeTakeFirst()
          if (!binding || binding.binding_state !== 'ready' || binding.database_id !== identity.databaseId ||
            binding.instance_id !== identity.instanceId || binding.identity_jkt !== identity.identityJkt) {
            throw new Error('license_renewal_binding_changed')
          }
          const lockedState = await tx.selectFrom('instance_license_state').selectAll().where('singleton', '=', true).forUpdate().executeTakeFirstOrThrow()
          const time = await advanceLicenseTrustedTime({ tx, row: lockedState, pendingRoot: options.pendingKeyRoot,
            identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
            signedTimeMs: sample.readCurrentTrustedTimeMs(),
            ...(options.test?.databaseTimeMs === undefined ? {} : { databaseTimeMs: options.test.databaseTimeMs }) })
          await clientOptions.trustStore.getAccepted(() => time.trustedTimeSeconds)
          sample.assertFresh()
        }))
      })
      const projection = createLicenseStateProjectionClient(clientOptions)
      const clearRetryIfProjected = async (operationId: string) => {
        const row = await options.db.selectFrom('local_license_operations').select('state')
          .where('operation_id', '=', operationId).executeTakeFirst()
        if (row?.state !== 'projected') return false
        await assertHeld()
        await options.db.updateTable('instance_license_state').set({ renewal_retry_count: 0, renewal_retry_after: null })
          .where('singleton', '=', true).executeTakeFirstOrThrow()
        return true
      }
      const client = createLicenseOperationRecoveryClient(clientOptions)
      if (pending) {
        if (pending.state === 'response_saved') {
          await assertHeld()
          await projection.projectPersistedOperation(pending.operation_id)
          if (await clearRetryIfProjected(pending.operation_id)) return
        }
        const attempts = await options.db.selectFrom('local_license_operation_attempts').select('created_at')
          .where('operation_id', '=', pending.operation_id).orderBy('attempt_no', 'desc').limit(10).execute()
        if (!options.test?.skipRetryDelay && attempts.length && now < renewalRetryAt(attempts[0]!.created_at.getTime(), attempts.length, pending.operation_id)) return
        await assertHeld()
        const result = await client.resumeRenewal(pending.operation_id)
        await assertHeld()
        await projection.projectPersistedOperation(result.recoveryOperationId)
        await clearRetryIfProjected(result.recoveryOperationId)
        return
      }
      const snapshot = await projection.getLicenseSnapshot()
      if (!['active', 'offline_valid', 'expired', 'offline_expired', 'revoked'].includes(snapshot.status)) {
        if (snapshot.status !== 'invalid_credential' || !await projection.canRenewAfterSignerRevocation()) return
        // An explicitly revoked signer never grants permission; it only permits a low-frequency
        // attempt to obtain independently verified current evidence from the center.
        const latest = await options.db.selectFrom('local_license_operations').select('created_at')
          .where('kind', '=', 'renewal').where('database_id', '=', state.database_id).where('instance_id', '=', state.instance_id)
          .orderBy('created_at', 'desc').executeTakeFirst()
        if (latest && now < latest.created_at.getTime() + (options.test?.lowFrequencyMs ?? HOUR)) return
      }
      if (!lowFrequency && snapshot.status === 'expired' && snapshot.reason === 'subscription_end_reached') {
        const latest = await options.db.selectFrom('local_license_operations').select('created_at')
          .where('kind', '=', 'renewal').where('database_id', '=', state.database_id).where('instance_id', '=', state.instance_id)
          .orderBy('created_at', 'desc').executeTakeFirst()
        if (latest && now < latest.created_at.getTime() + (options.test?.lowFrequencyMs ?? HOUR)) return
      }
      await assertHeld()
      const result = await client.renewLicense({
        licenseId: state.license_id, databaseId: state.database_id, instanceId: state.instance_id,
        identityJkt: state.identity_jkt, expectedGeneration: state.activation_generation, knownRevision: state.entitlement_revision,
      })
      await assertHeld()
      await projection.projectPersistedOperation(result.recoveryOperationId)
      await clearRetryIfProjected(result.recoveryOperationId)
    } finally {
      if (locked && !lost) {
        try { await session.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY]) } catch { lost = true }
      }
      session.removeListener('error', onError)
      session.release(lost)
    }
  }

  const run = () => {
    if (stopped) return
    active = (async () => {
      try { await pass(); failures = 0 } catch (error) {
        failures = Math.min(failures + 1, 6)
        options.logger.warn({ err: error }, 'license renewal pass failed')
      } finally {
        active = undefined
        if (!stopped) {
          const delay = failures ? Math.round(Math.min(HOUR, MINUTE * 2 ** (failures - 1)) * (0.9 + Math.random() * 0.2)) : (options.test?.pollIntervalMs ?? MINUTE)
          timer = setTimeout(run, delay)
          timer.unref()
        }
      }
    })()
  }
  run()
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active }
}
