import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import type { PaymentCredentialKeyRing } from '../config.js'
import { readBackupDatabaseMetadata, type VerifiedReleaseDatabase } from './database-metadata.js'
import { assertPendingKeyReferences, readBackupKeyReferences } from './key-references.js'
import { readBackupPendingSummary } from './pending-summary.js'
import { inspectCapturedStateArchivePair } from './state-archive-pair.js'
import { verifyStateArchiveProtection } from './state-archive-protection.js'
import { inspectArchivedTrustStore } from './state-archive-trust.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import { capturePostgresDump, verifyPostgresDumpBinding, type PostgresDumpTarget } from './pg-dump.js'
import { captureReleaseVolume, captureFixtureVolume, type VolumeArchiveTarget } from './volume-archive.js'
import { captureDeploymentArchive, captureFixtureDeploymentArchive, type DeploymentArchiveTarget } from './deployment-archive.js'
import type { CaptureSetOperations } from './capture-set.js'
import type { BackupManifest } from './manifest.js'

/** Supplied only after installer-owned cryptographic authentication of the
 * release, checksum files and fixed deployment. This module is internal and
 * provides no trust-root or customer entry point. */
export interface AuthenticatedCaptureRelease {
  releaseId: string
  images: BackupManifest['images']
  /** Exact digest reference authenticated by the release manifest. */
  backupResticImage: string
  database: VerifiedReleaseDatabase
  signedChecksums: Uint8Array
  compiledChecksums: Uint8Array
  postgresImage: string
}
export interface CaptureOperationsInput {
  db: Kysely<Database>
  stagingDirectory: string
  tarBinary: string
  dump: Omit<PostgresDumpTarget, 'stagingDirectory' | 'assertSecureStaging'>
  volumes: Omit<VolumeArchiveTarget, 'stagingDirectory' | 'assertSecureStaging'>
  deployment: Omit<DeploymentArchiveTarget, 'stagingDirectory' | 'assertSecureStaging' | 'tarBinary' | 'assertTrustedDeployment'>
  paymentKeys: PaymentCredentialKeyRing | null
  deliveryKeys: PaymentCredentialKeyRing | null
  /** Must authenticate release signatures, actual files and deployment identity on every call. */
  readAuthenticatedRelease(): Promise<AuthenticatedCaptureRelease>
  /** Expected signed Restic reader digest for production capture. */
  backupResticImage?: string
  /** Verifies captured Trust Store bytes against the database head without file recovery or mutation. */
  inspectTrustStoreReadOnly?(directory: string): Promise<ReadonlyTrustBundleInspection>
  /** Must prove held host lock and absence of all DB and volume writers. */
  assertFence(): Promise<void>
  assertSecureStaging(): Promise<void>
}

type Artifact = { size: number; sha256: string }
function create(input: CaptureOperationsInput, applicationUid: number, fixture?: string, applicationGid = applicationUid,
  requireTrustInspector = false): CaptureSetOperations {
  if (!input || !input.db || typeof input.assertFence !== 'function' || typeof input.assertSecureStaging !== 'function' ||
      typeof input.readAuthenticatedRelease !== 'function' || !input.paymentKeys || !input.deliveryKeys ||
      (requireTrustInspector && typeof input.inspectTrustStoreReadOnly !== 'function')) throw new Error('BACKUP_CAPTURE_AUTHORITY_MISSING')
  const dump: PostgresDumpTarget = { ...input.dump, stagingDirectory: input.stagingDirectory, assertSecureStaging: input.assertSecureStaging }
  const volumes: VolumeArchiveTarget = { ...input.volumes, stagingDirectory: input.stagingDirectory, assertSecureStaging: input.assertSecureStaging }
  let state: Artifact | undefined
  let stateUidVerified = false
  let stateTrustStoreFiles: Awaited<ReturnType<typeof verifyStateArchiveProtection>> | undefined
  async function verifiedRelease() {
    const release = await input.readAuthenticatedRelease()
    if (!release || !release.database || typeof release.releaseId !== 'string' || !release.images ||
        release.postgresImage !== `docker.io/library/postgres@${release.images.postgres}` || !(release.signedChecksums instanceof Uint8Array) ||
        !(release.compiledChecksums instanceof Uint8Array) || release.postgresImage !== volumes.postgresImage ||
        (requireTrustInspector && (typeof input.backupResticImage !== 'string' ||
          !/^ghcr\.io\/yykx682436\/aikayun-backup-restic@sha256:[a-f0-9]{64}$/.test(input.backupResticImage) ||
          release.backupResticImage !== input.backupResticImage))) throw new Error('BACKUP_CAPTURE_RELEASE_UNVERIFIED')
    return release
  }
  async function fence() { await input.assertFence(); await verifiedRelease(); await input.assertSecureStaging() }
  async function volume(kind: 'state' | 'caddy-data' | 'caddy-config') {
    return fixture ? captureFixtureVolume(volumes, fixture, kind) : captureReleaseVolume(volumes, kind)
  }
  return {
    assertFence: fence,
    assertSecureStaging: input.assertSecureStaging,
    async readEvidence() {
      await fence()
      const release = await verifiedRelease()
      const database = await readBackupDatabaseMetadata(input.db, release.database, release.signedChecksums, release.compiledChecksums)
      await assertPendingKeyReferences(input.db, database.pendingKeyId)
      // Capture the fixed state volume under the same writer fence before
      // deriving identity. This works across the app/root UID boundary without
      // granting root's identity readers exceptions to their ownership rules.
      if (!state) {
        state = await volume('state')
        await fence()
        stateTrustStoreFiles = await verifyStateArchiveProtection(input.stagingDirectory, applicationUid, true, applicationGid, true)
        stateUidVerified = true
      }
      if (!stateUidVerified) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
      const identity = await inspectCapturedStateArchivePair(input.stagingDirectory, input.tarBinary, database)
      const keys = await readBackupKeyReferences(input.db, input.paymentKeys, input.deliveryKeys)
      const unresolved = await readBackupPendingSummary(input.db)
      const trustBundle = input.inspectTrustStoreReadOnly && stateTrustStoreFiles
        ? await inspectArchivedTrustStore({ stagingDirectory: input.stagingDirectory, files: stateTrustStoreFiles,
          inspectReadOnly: input.inspectTrustStoreReadOnly })
        : { status: 'uninitialized' as const, bundleVersion: null, artifactSha256: null, stateDigest: null,
          revokedKeyCount: 0, retiredKeyCount: 0 }
      await fence()
      return { database, identityFileSha256: identity.identityFileSha256, keys, unresolved, trustBundle }
    },
    captureDump: () => capturePostgresDump(dump),
    verifyDumpBinding: metadata => verifyPostgresDumpBinding(dump, metadata),
    async captureVolume(kind) {
      if (kind === 'state') {
        if (!state || !stateUidVerified) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
        return state
      }
      return volume(kind)
    },
    captureDeployment: () => {
      const target = { ...input.deployment, stagingDirectory: input.stagingDirectory, tarBinary: input.tarBinary,
        assertSecureStaging: input.assertSecureStaging, assertTrustedDeployment: async () => { await fence() } }
      return fixture ? captureFixtureDeploymentArchive(target, fixture) : captureDeploymentArchive(target)
    },
  }
}

/** Fixed production ownership from the signed API image/Compose: UID 1000. */
export function createProductionCaptureOperations(input: CaptureOperationsInput): CaptureSetOperations {
  return create(input, 1000, undefined, 1000, true)
}

/** Isolated test volumes only; never accepts fixed production volume names. */
export function createFixtureCaptureOperations(input: CaptureOperationsInput, fixture: string, uid: number, gid = uid): CaptureSetOperations {
  if (process.env.NODE_ENV !== 'test' || !/^aikayun-75a-test-[a-f0-9]{24}$/.test(fixture) || !Number.isSafeInteger(uid) || uid < 1 ||
      !Number.isSafeInteger(gid) || gid < 0) throw new Error('BACKUP_CAPTURE_FIXTURE_INVALID')
  return create(input, uid, fixture, gid)
}
