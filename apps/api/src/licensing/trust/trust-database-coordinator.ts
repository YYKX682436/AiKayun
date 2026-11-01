import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database, InstanceLicenseStateTable } from '../../db/types.js'
import { InstallationIdentityError, verifyInstallationIdentityInTransaction } from '../installation-identity.js'
import type { AcceptedTrustBundle } from './trust-bundle-store.js'

const TRUST_BUNDLE_LOCK = 'aikayun-trust-bundle-state-v1'

export interface TrustDatabaseState {
  readonly headDigest: string | null
  readonly headVersion: string | null
  readonly pendingArtifactSha256: string | null
  readonly pendingToken: string | null
  readonly licenseId: string | null
}

export interface TrustDatabaseCoordinator {
  withRead<T>(work: (state: TrustDatabaseState) => Promise<T>): Promise<T>
  withTransaction<T>(trx: Transaction<Database>, work: () => Promise<T>): Promise<T>
  bootstrap(readCurrent: () => Promise<AcceptedTrustBundle>): Promise<AcceptedTrustBundle>
  accept(
    input: { token: string; artifactSha256: string },
    readCurrent: () => Promise<AcceptedTrustBundle>,
    apply: () => Promise<AcceptedTrustBundle>,
  ): Promise<AcceptedTrustBundle>
}

interface ScopedTransaction { readonly trx: Transaction<Database> }

function stateFromRow(row: SelectableLicenseState): TrustDatabaseState {
  return Object.freeze({
    headDigest: row.trust_bundle_head_digest,
    headVersion: row.trust_bundle_head_version,
    pendingArtifactSha256: row.trust_bundle_pending_artifact_sha256,
    pendingToken: row.trust_bundle_pending_token,
    licenseId: row.license_id,
  })
}

type SelectableLicenseState = Pick<InstanceLicenseStateTable,
  'trust_bundle_head_digest' | 'trust_bundle_head_version' | 'trust_bundle_pending_artifact_sha256' |
  'trust_bundle_pending_token' | 'license_id'>

export function trustedBundleStateDigest(bundle: Pick<AcceptedTrustBundle,
  'artifactSha256' | 'bundleVersion' | 'revokedKids' | 'retiredKids'>): string {
  const canonical = JSON.stringify({
    artifact_sha256: bundle.artifactSha256,
    bundle_version: bundle.bundleVersion,
    revoked_kids: [...bundle.revokedKids].sort(),
    retired_kids: [...bundle.retiredKids].sort(),
  })
  return createSha256Base64url(canonical)
}

function createSha256Base64url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

export function createTrustDatabaseCoordinator(input: {
  db: Kysely<Database>
  identityRoot: string
}): TrustDatabaseCoordinator {
  const scoped = new AsyncLocalStorage<ScopedTransaction>()

  async function lockRows(trx: Transaction<Database>): Promise<SelectableLicenseState> {
    await trx.selectFrom('installation_binding').select('singleton')
      .where('singleton', '=', true).forUpdate().executeTakeFirst()
    try {
      await verifyInstallationIdentityInTransaction(trx, input.identityRoot)
    } catch (error) {
      if (error instanceof InstallationIdentityError) throw error
      throw new Error('trust_bundle_identity_unavailable', { cause: error })
    }
    const row = await trx.selectFrom('instance_license_state').select([
      'license_id', 'trust_bundle_head_digest', 'trust_bundle_head_version',
      'trust_bundle_pending_artifact_sha256', 'trust_bundle_pending_token',
    ]).where('singleton', '=', true).forUpdate().executeTakeFirst()
    if (!row) throw new Error('trust_bundle_license_state_missing')
    return row
  }

  async function takeReadLock(trx: Transaction<Database>): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${TRUST_BUNDLE_LOCK}, 0))`.execute(trx)
  }

  return Object.freeze({
    async withRead<T>(work: (state: TrustDatabaseState) => Promise<T>): Promise<T> {
      const current = scoped.getStore()
      if (current) {
        await takeReadLock(current.trx)
        const row = await current.trx.selectFrom('instance_license_state').select([
          'license_id', 'trust_bundle_head_digest', 'trust_bundle_head_version',
          'trust_bundle_pending_artifact_sha256', 'trust_bundle_pending_token',
        ]).where('singleton', '=', true).executeTakeFirst()
        if (!row) throw new Error('trust_bundle_license_state_missing')
        const state = stateFromRow(row)
        if (state.pendingArtifactSha256 !== null) throw new Error('trust_bundle_update_pending')
        return work(state)
      }
      return await input.db.transaction().execute(async trx => {
        await takeReadLock(trx)
        const row = await trx.selectFrom('instance_license_state').select([
          'license_id', 'trust_bundle_head_digest', 'trust_bundle_head_version',
          'trust_bundle_pending_artifact_sha256', 'trust_bundle_pending_token',
        ]).where('singleton', '=', true).executeTakeFirst()
        if (!row) throw new Error('trust_bundle_license_state_missing')
        const state = stateFromRow(row)
        if (state.pendingArtifactSha256 !== null) throw new Error('trust_bundle_update_pending')
        return work(state)
      })
    },

    async withTransaction<T>(trx: Transaction<Database>, work: () => Promise<T>): Promise<T> {
      if (scoped.getStore()) throw new Error('Nested trust database transaction scopes are not supported')
      return scoped.run({ trx }, work)
    },

    async bootstrap(readCurrent: () => Promise<AcceptedTrustBundle>) {
      return await input.db.transaction().execute(async trx => {
        const row = await lockRows(trx)
        const state = stateFromRow(row)
        if (state.pendingArtifactSha256 !== null) throw new Error('trust_bundle_update_pending')
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${TRUST_BUNDLE_LOCK}, 0))`.execute(trx)
        const accepted = await readCurrent()
        const digest = trustedBundleStateDigest(accepted)
        if (state.headDigest !== null) {
          if (state.headDigest !== digest || state.headVersion !== accepted.bundleVersion) {
            throw new Error('trust_bundle_store_does_not_match_database_head')
          }
          return accepted
        }
        await trx.updateTable('instance_license_state').set({
          trust_bundle_head_digest: digest,
          trust_bundle_head_version: accepted.bundleVersion,
        }).where('singleton', '=', true).executeTakeFirstOrThrow()
        return accepted
      })
    },

    async accept(
      inputBundle: { token: string; artifactSha256: string },
      readCurrent: () => Promise<AcceptedTrustBundle>,
      apply: () => Promise<AcceptedTrustBundle>,
    ) {
      const samePending = (state: TrustDatabaseState) => {
        if (state.pendingArtifactSha256 === null) return false
        if (state.pendingArtifactSha256 !== inputBundle.artifactSha256 || state.pendingToken !== inputBundle.token) {
          throw new Error('a different trust bundle update is already pending')
        }
        return true
      }

      const initial = await input.db.transaction().execute(async trx => {
        const row = await lockRows(trx)
        const state = stateFromRow(row)
        if (samePending(state)) return { pending: true, state }
        if (state.headDigest !== null) {
          const current = await readCurrent()
          if (trustedBundleStateDigest(current) !== state.headDigest || current.bundleVersion !== state.headVersion) {
            throw new Error('trust_bundle_store_does_not_match_database_head')
          }
        } else if (state.licenseId !== null) {
          throw new Error('trust_bundle_head_missing_for_existing_license')
        }
        return { pending: false, state }
      })

      if (!initial.pending) {
        await input.db.transaction().execute(async trx => {
          const row = await lockRows(trx)
          const state = stateFromRow(row)
          if (state.pendingArtifactSha256 !== null) {
            if (!samePending(state)) throw new Error('a different trust bundle update is already pending')
            return
          }
          if (state.headDigest !== initial.state.headDigest || state.headVersion !== initial.state.headVersion) {
            throw new Error('trust_bundle_head_changed_during_update')
          }
          if (state.headDigest !== null) {
            const current = await readCurrent()
            if (trustedBundleStateDigest(current) !== state.headDigest || current.bundleVersion !== state.headVersion) {
              throw new Error('trust_bundle_store_does_not_match_database_head')
            }
          } else if (state.licenseId !== null) {
            throw new Error('trust_bundle_head_missing_for_existing_license')
          }
          await trx.updateTable('instance_license_state').set({
            trust_bundle_pending_artifact_sha256: inputBundle.artifactSha256,
            trust_bundle_pending_token: inputBundle.token,
          }).where('singleton', '=', true).executeTakeFirstOrThrow()
        })
      }

      return await input.db.transaction().execute(async trx => {
        const row = await lockRows(trx)
        const state = stateFromRow(row)
        if (state.pendingArtifactSha256 !== inputBundle.artifactSha256 || state.pendingToken !== inputBundle.token) {
          throw new Error('trust_bundle_pending_update_mismatch')
        }
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${TRUST_BUNDLE_LOCK}, 0))`.execute(trx)
        let persisted: AcceptedTrustBundle | null = null
        try { persisted = await readCurrent() } catch (error) {
          if (state.headDigest !== null || state.licenseId !== null ||
            !(error instanceof Error) || error.message !== 'No accepted trust bundle is persisted') throw error
        }
        const currentIsHead = persisted !== null && state.headDigest !== null &&
          persisted.bundleVersion === state.headVersion && trustedBundleStateDigest(persisted) === state.headDigest
        const currentIsPendingTarget = persisted !== null && persisted.artifactSha256 === inputBundle.artifactSha256 &&
          persisted.token === inputBundle.token
        const freshInstallWithoutTrust = persisted === null && state.headDigest === null && state.licenseId === null
        if (!currentIsHead && !currentIsPendingTarget && !freshInstallWithoutTrust &&
          !(state.headDigest === null && state.licenseId === null && persisted !== null)) {
          throw new Error('trust_bundle_store_does_not_match_database_or_pending_head')
        }
        const accepted = await apply()
        const digest = trustedBundleStateDigest(accepted)
        if (state.headVersion !== null) {
          const currentVersion = BigInt(state.headVersion)
          const nextVersion = BigInt(accepted.bundleVersion)
          if (nextVersion < currentVersion || nextVersion === currentVersion && digest !== state.headDigest) {
            throw new Error('trust_bundle_head_rollback_rejected')
          }
        }
        await trx.updateTable('instance_license_state').set({
          trust_bundle_head_digest: digest,
          trust_bundle_head_version: accepted.bundleVersion,
          trust_bundle_pending_artifact_sha256: null,
          trust_bundle_pending_token: null,
        }).where('singleton', '=', true).executeTakeFirstOrThrow()
        return accepted
      })
    },
  })
}
