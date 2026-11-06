import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { parseCodePoolEncryptionKeyRing, parsePaymentCredentialKeyRing } from '../config.js'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { loadEmbeddedTrustedReleaseLicenseConfig } from '../licensing/trusted-release-config.js'
import { createTrustDatabaseCoordinator } from '../licensing/trust/trust-database-coordinator.js'
import { createReleaseBoundTrustStore } from '../licensing/trust/service.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import { installerOwnedHostProof } from './installer-owned-proof.js'
import { assertFixedComposeConfiguration } from './fixed-configuration.js'
import type { AuthenticatedCaptureRelease } from './capture-operations.js'

const root = '/opt/aikayun'
const compiledChecksums = '/app/dist/db/migration-checksums.json'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function protectedFile(path: string, max: number, expected: { uid?: number; gid?: number; mode?: number } = {}): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > max ||
        (expected.uid !== undefined && before.uid !== expected.uid) || (expected.gid !== undefined && before.gid !== expected.gid) ||
        (expected.mode !== undefined && (before.mode & 0o777) !== expected.mode)) throw new Error('BACKUP_FIXED_FILE_INVALID')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const after = await file.stat()
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('BACKUP_FIXED_FILE_CHANGED')
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

/** Internal wiring only. The image containing this module must already be
 * authenticated by the host bootstrap. All release authentication is then
 * rechecked with the concrete installer-owned verifier under the inherited lock. */
export async function loadFixedReleaseSource(signal: AbortSignal) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.env.NODE_ENV !== 'production' || !signal || signal.aborted) throw new Error('BACKUP_FIXED_SOURCE_UNAVAILABLE')
  const stateBytes = await protectedFile(`${root}/install-state.json`, 65536, { uid: 0, gid: 0, mode: 0o600 })
  let state: unknown
  try { state = JSON.parse(stateBytes.toString('utf8')) as unknown } catch { throw new Error('BACKUP_FIXED_SOURCE_INVALID') }
  if (!state || typeof state !== 'object' || Array.isArray(state) || !('manifest_sha256' in state) ||
      typeof state.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.manifest_sha256) ||
      !('domain' in state) || typeof state.domain !== 'string') throw new Error('BACKUP_FIXED_SOURCE_INVALID')
  const fingerprint = state.manifest_sha256
  const domain = state.domain
  const embeddedTrustConfig = await loadEmbeddedTrustedReleaseLicenseConfig()
  if (!embeddedTrustConfig) throw new Error('BACKUP_FIXED_TRUST_CONFIG_UNAVAILABLE')
  const trustConfig = embeddedTrustConfig
  const host = installerOwnedHostProof(fingerprint, signal)
  async function inspectTrustStoreReadOnly(directory: string, db: Kysely<Database>): Promise<ReadonlyTrustBundleInspection> {
    // The backup helper runs this only inside the proven writer-quiesced
    // capture window. Use the fixed, root-owned backup root for its local lock
    // file; the DB advisory lock remains the shared Trust Store authority.
    const coordinator = createTrustDatabaseCoordinator({ db, identityRoot: '/var/lib/aikayun-backup' })
    return createReleaseBoundTrustStore(trustConfig, directory, coordinator).inspectAcceptedReadOnly()
  }
  async function inspectPersistedTrustStoreReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection> {
    return createReleaseBoundTrustStore(trustConfig, directory).inspectPersistedReadOnly()
  }
  async function readAuthenticatedRelease(): Promise<AuthenticatedCaptureRelease> {
    await host.verifyDeployment(fingerprint)
    const currentState = await protectedFile(`${root}/install-state.json`, 65536, { uid: 0, gid: 0, mode: 0o600 })
    if (!currentState.equals(stateBytes)) throw new Error('BACKUP_FIXED_SOURCE_CHANGED')
    const manifestBytes = await protectedFile(`${root}/release/release-manifest.json`, 16 * 1024 * 1024)
    if (sha(manifestBytes) !== fingerprint) throw new Error('BACKUP_FIXED_SOURCE_INVALID')
    let value: unknown
    try { value = JSON.parse(manifestBytes.toString('utf8')) as unknown } catch { throw new Error('BACKUP_FIXED_SOURCE_INVALID') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('release_id' in value) || typeof value.release_id !== 'string' ||
        !('images' in value) || !value.images || typeof value.images !== 'object' || Array.isArray(value.images) ||
        !('database' in value) || !value.database || typeof value.database !== 'object' || Array.isArray(value.database)) throw new Error('BACKUP_FIXED_SOURCE_INVALID')
    const images = value.images as Record<string, { reference?: unknown }>
    const refs = ['api', 'web', 'postgres', 'caddy'].map(name => images[name]?.reference)
    const backupResticImage = images.backup?.reference
    if (!refs.every((item): item is string => typeof item === 'string') || typeof backupResticImage !== 'string' ||
        !/^ghcr\.io\/yykx682436\/aikayun-backup-restic@sha256:[a-f0-9]{64}$/.test(backupResticImage)) {
      throw new Error('BACKUP_FIXED_SOURCE_INVALID')
    }
    const [api, web, postgres, caddy] = refs as [string, string, string, string]
    const env = await protectedFile(`${root}/.env`, 8192, { uid: 0, gid: 0, mode: 0o600 })
    assertFixedComposeConfiguration(env, { domain, api, web, postgres, caddy })
    const database = value.database as Record<string, unknown>
    if (database.engine_major !== 18 || typeof database.migration_head !== 'string' ||
        typeof database.migration_checksums_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(database.migration_checksums_sha256)) throw new Error('BACKUP_FIXED_SOURCE_INVALID')
    const signedChecksums = await protectedFile(`${root}/release/migration-checksums.json`, 1024 * 1024)
    const compiled = await protectedFile(compiledChecksums, 1024 * 1024)
    if (sha(signedChecksums) !== database.migration_checksums_sha256 || !signedChecksums.equals(compiled)) throw new Error('BACKUP_FIXED_SOURCE_INVALID')
    await host.assertOwnedLock()
    const finalState = await protectedFile(`${root}/install-state.json`, 65536, { uid: 0, gid: 0, mode: 0o600 })
    if (!finalState.equals(stateBytes)) throw new Error('BACKUP_FIXED_SOURCE_CHANGED')
    return { releaseId: value.release_id, images: { api: api.slice(api.indexOf('@') + 1), web: web.slice(web.indexOf('@') + 1),
      postgres: postgres.slice(postgres.indexOf('@') + 1), caddy: caddy.slice(caddy.indexOf('@') + 1) }, postgresImage: postgres,
    backupResticImage,
    database: { engine_major: 18, migration_head: database.migration_head, migration_checksums_sha256: database.migration_checksums_sha256 },
    signedChecksums, compiledChecksums: compiled }
  }
  await host.verifyDeployment(fingerprint)
  const secretsPath = `${root}/secrets`
  const secretsBefore = await lstat(secretsPath)
  if (!secretsBefore.isDirectory() || secretsBefore.isSymbolicLink() || secretsBefore.uid !== 0 || secretsBefore.gid !== 0 ||
      (secretsBefore.mode & 0o777) !== 0o700 || await realpath(secretsPath) !== secretsPath) throw new Error('BACKUP_FIXED_SECRET_INVALID')
  let payment: Buffer | undefined, delivery: Buffer | undefined, password: Buffer | undefined
  try {
    payment = await protectedFile(`${secretsPath}/payment_credential_key_ring`, 65536, { uid: 1000, gid: 1000, mode: 0o400 })
    delivery = await protectedFile(`${secretsPath}/code_pool_encryption_key_ring`, 65536, { uid: 1000, gid: 1000, mode: 0o400 })
    password = await protectedFile(`${secretsPath}/postgres_admin_password`, 4096, { uid: 0, gid: 0, mode: 0o400 })
    const paymentKeys = parsePaymentCredentialKeyRing(payment.toString('utf8'))
    const deliveryKeys = parseCodePoolEncryptionKeyRing(delivery.toString('utf8'))
    const passwordText = password.toString('utf8')
    const passwordDecoded = Buffer.from(passwordText, 'base64')
    try {
      if (!paymentKeys || !deliveryKeys || !/^[A-Za-z0-9+/]{43}=$/.test(passwordText) || passwordDecoded.length !== 32 ||
          passwordDecoded.toString('base64') !== passwordText) throw new Error('BACKUP_FIXED_SECRET_INVALID')
    } finally { passwordDecoded.fill(0) }
    const secretsAfter = await lstat(secretsPath)
    if (!secretsAfter.isDirectory() || secretsAfter.isSymbolicLink() || secretsAfter.dev !== secretsBefore.dev ||
        secretsAfter.ino !== secretsBefore.ino || secretsAfter.uid !== 0 || secretsAfter.gid !== 0 ||
        (secretsAfter.mode & 0o777) !== 0o700 || await realpath(secretsPath) !== secretsPath) throw new Error('BACKUP_FIXED_SECRET_INVALID')
    await host.assertOwnedLock()
  return { fingerprint, host, readAuthenticatedRelease, inspectTrustStoreReadOnly, inspectPersistedTrustStoreReadOnly,
    paymentKeys, deliveryKeys,
      databaseConfig: { host: 'db', port: 5432, user: 'aikayun_bootstrap', database: 'aikayun', password: passwordText } }
  } finally { payment?.fill(0); delivery?.fill(0); password?.fill(0) }
}
