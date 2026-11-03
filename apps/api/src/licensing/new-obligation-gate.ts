import type { Kysely, Transaction } from 'kysely'
import type { Pool } from 'pg'
import type { Database } from '../db/types.js'
import { InstallationIdentityError } from './installation-identity.js'
import { createLicenseStateProjectionClient, type LicenseSnapshotResult, type LicenseSnapshotStatus } from './license-state-projection.js'
import { LicenseClockSuspectError } from './license-trusted-time.js'
import { loadEmbeddedTrustedReleaseLicenseConfig, validateTrustedReleaseLicenseConfig } from './trusted-release-config.js'
import type { TrustedReleaseLicenseConfig } from './trusted-release-config.js'
import { createLicenseTrustService, createReleaseBoundTrustStore } from './trust/service.js'
import { createTrustDatabaseCoordinator } from './trust/trust-database-coordinator.js'
import { withTrustTransactionScope, type TrustBundleStore } from './trust/trust-bundle-store.js'
import type { TestLicenseTlsOptions } from './license-request-http.js'

export type NewObligation = 'create_order' | 'create_top_up'
export type NewObligationStatus = LicenseSnapshotStatus | 'unavailable'
export interface NewObligationDetails {
  readonly status: NewObligationStatus
  readonly allowedUntil: string | null
  readonly retryable: boolean
}

export class LicenseNewObligationError extends Error {
  readonly statusCode: 403 | 503
  readonly code: 'LICENSE_NEW_OBLIGATION_BLOCKED' | 'LICENSE_STATE_UNAVAILABLE'
  constructor(readonly details: NewObligationDetails) {
    const unavailable = details.status === 'unavailable' || details.status === 'invalid_credential'
    super(unavailable ? 'LICENSE_STATE_UNAVAILABLE' : 'LICENSE_NEW_OBLIGATION_BLOCKED')
    this.name = 'LicenseNewObligationError'
    this.statusCode = unavailable ? 503 : 403
    this.code = unavailable ? 'LICENSE_STATE_UNAVAILABLE' : 'LICENSE_NEW_OBLIGATION_BLOCKED'
  }
}

export interface NewObligationGate {
  withTransactionScope<T>(work: () => Promise<T>): Promise<T>
  assertNewObligationAllowed(trx: Transaction<Database>, kind: NewObligation): Promise<void>
  getDiagnostic(): Promise<NewObligationDetails>
}

export interface NewObligationGateOptions {
  db: Kysely<Database>
  pool: Pool
  identityRoot: string
  pendingKeyRoot: string
  trustStoreRoot: string
  /** Only real cryptographic fixtures, restricted to isolated test processes. */
  test?: { releaseConfig: TrustedReleaseLicenseConfig; trustStore: TrustBundleStore; testTls?: TestLicenseTlsOptions }
}

const unavailable = (): NewObligationDetails => Object.freeze({ status: 'unavailable', allowedUntil: null, retryable: true })
function detailsFor(snapshot: LicenseSnapshotResult): NewObligationDetails {
  return Object.freeze({
    status: snapshot.status,
    allowedUntil: snapshot.allowedUntil,
    retryable: snapshot.status === 'invalid_credential' || snapshot.status === 'clock_suspect' ||
      snapshot.status === 'offline_expired' || snapshot.status === 'expired',
  })
}

/**
 * No network I/O is performed here. The caller must hold its business locks first;
 * the shared projection verifier then locks binding → state and verifies all stored
 * evidence in that same transaction. The caller must retry the entire transaction.
 */
export function createNewObligationGate(options: NewObligationGateOptions): NewObligationGate {
  if (options.test && process.env.NODE_ENV !== 'test') throw new Error('license_gate_test_options_forbidden')
  const coordinator = createTrustDatabaseCoordinator({ db: options.db, identityRoot: options.identityRoot })
  const client = (async () => {
    const config = options.test
      ? await validateTrustedReleaseLicenseConfig(options.test.releaseConfig)
      : await loadEmbeddedTrustedReleaseLicenseConfig()
    if (!config) return null
    const store = options.test?.trustStore.withCoordinator(coordinator)
      ?? createReleaseBoundTrustStore(config, options.trustStoreRoot, coordinator)
    // Validate the root, issuer and minimum version against the immutable release pin.
    createLicenseTrustService({ config, store })
    return createLicenseStateProjectionClient({
      db: options.db, pool: options.pool, identityRoot: options.identityRoot,
      pendingKeyRoot: options.pendingKeyRoot, releaseConfig: config, trustStore: store,
      ...(options.test?.testTls === undefined ? {} : { testTls: options.test.testTls }),
    })
  })().catch(() => null)
  return Object.freeze({
    withTransactionScope: withTrustTransactionScope,
    async assertNewObligationAllowed(trx: Transaction<Database>, kind: NewObligation) {
      if (kind !== 'create_order' && kind !== 'create_top_up') throw new Error('invalid_new_obligation_kind')
      try {
        const projection = await client
        if (!projection) throw new LicenseNewObligationError(unavailable())
        const snapshot = await projection.getLicenseSnapshotInTransaction(trx)
        if (snapshot.status !== 'active' && snapshot.status !== 'offline_valid') {
          throw new LicenseNewObligationError(detailsFor(snapshot))
        }
      } catch (error) {
        if (error instanceof LicenseNewObligationError) throw error
        // Let the existing bounded SQL retry re-run the entire business transaction.
        if (error && typeof error === 'object' && 'code' in error &&
          ['40001', '40P01', '55P03'].includes(String(error.code))) throw error
        if (error instanceof LicenseClockSuspectError) {
          throw new LicenseNewObligationError({ status: 'clock_suspect', allowedUntil: null, retryable: true })
        }
        if (error instanceof InstallationIdentityError && error.status !== 'unavailable') {
          throw new LicenseNewObligationError({ status: 'identity_mismatch', allowedUntil: null, retryable: false })
        }
        throw new LicenseNewObligationError(unavailable())
      }
    },
    async getDiagnostic() {
      try {
        const projection = await client
        if (!projection) return unavailable()
        return detailsFor(await projection.getLicenseSnapshot())
      } catch {
        return unavailable()
      }
    },
  })
}
