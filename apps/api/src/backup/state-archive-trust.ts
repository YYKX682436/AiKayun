import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import type { StateArchiveTrustStoreFiles } from './state-archive-protection.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import type { BackupManifest } from './manifest.js'

const artifactDigest = /^[A-Za-z0-9_-]{43}$/

function validateInspection(value: ReadonlyTrustBundleInspection): void {
  if (!value || !Number.isSafeInteger(value.revokedKeyCount) || value.revokedKeyCount < 0 ||
      !Number.isSafeInteger(value.retiredKeyCount) || value.retiredKeyCount < 0) throw new Error('BACKUP_TRUST_STORE_INVALID')
  if (value.status === 'uninitialized') {
    if (value.bundleVersion !== null || value.artifactSha256 !== null || value.stateDigest !== null ||
        value.revokedKeyCount !== 0 || value.retiredKeyCount !== 0) throw new Error('BACKUP_TRUST_STORE_INVALID')
    return
  }
  if (value.status !== 'accepted' || typeof value.bundleVersion !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(value.bundleVersion) || typeof value.artifactSha256 !== 'string' ||
      !artifactDigest.test(value.artifactSha256) || typeof value.stateDigest !== 'string' || !artifactDigest.test(value.stateDigest)) {
    throw new Error('BACKUP_TRUST_STORE_INVALID')
  }
}

export function trustBundleManifestProjection(value: ReadonlyTrustBundleInspection): BackupManifest['trust_bundle'] {
  validateInspection(value)
  return { status: value.status, bundle_version: value.bundleVersion, artifact_sha256: value.artifactSha256,
    state_digest: value.stateDigest, revoked_key_count: value.revokedKeyCount, retired_key_count: value.retiredKeyCount }
}

export function assertTrustBundleManifestMatch(value: ReadonlyTrustBundleInspection, recorded: BackupManifest['trust_bundle']): void {
  if (JSON.stringify(trustBundleManifestProjection(value)) !== JSON.stringify(recorded)) throw new Error('BACKUP_TRUST_STORE_MISMATCH')
}

/**
 * Materialize only the two bounded, already header-validated Trust Store files
 * into a private directory, then ask the production TrustBundleStore parser to
 * verify their signatures and database head. This never extracts from tar and
 * never touches the live state volume.
 */
export async function inspectArchivedTrustStore(input: {
  stagingDirectory: string
  files: StateArchiveTrustStoreFiles
  inspectReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>
}): Promise<ReadonlyTrustBundleInspection> {
  const parent = await lstat(input.stagingDirectory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 ||
      parent.uid !== process.getuid?.() || await realpath(input.stagingDirectory) !== input.stagingDirectory ||
      typeof input.inspectReadOnly !== 'function' ||
      !((input.files.state === null) === (input.files.checkpoint === null)) ||
      (input.files.state !== null && input.files.state.byteLength > 32 * 1024) ||
      (input.files.checkpoint !== null && input.files.checkpoint.byteLength > 64 * 1024)) {
    throw new Error('BACKUP_TRUST_STORE_INVALID')
  }
  const temporary = await mkdtemp(join(input.stagingDirectory, '.trust-store-check-'))
  const root = await lstat(temporary)
  const owned = new Map<string, { dev: number; ino: number }>()
  let cleanupFailure = false, trustDirectoryCreated = false
  let result: ReadonlyTrustBundleInspection | undefined
  let operationError: unknown
  try {
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || parent.dev !== root.dev ||
        (root.mode & 0o777) !== 0o700 || await realpath(temporary) !== temporary) throw new Error('BACKUP_TRUST_STORE_INVALID')
    const directory = join(temporary, 'license-trust')
    await mkdir(directory, { mode: 0o700 })
    trustDirectoryCreated = true
    for (const [name, bytes] of [
      ['trust-bundle-state.json', input.files.state],
      ['trust-bundle-store.marker.json', input.files.checkpoint],
    ] as const) {
      if (bytes === null) continue
      const path = join(directory, name)
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
        const info = await file.stat()
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
            (info.mode & 0o777) !== 0o600 || info.size !== bytes.byteLength) throw new Error('BACKUP_TRUST_STORE_INVALID')
        owned.set(name, { dev: info.dev, ino: info.ino })
      } finally { await file.close() }
    }
    result = await input.inspectReadOnly(directory)
    validateInspection(result)
  } catch (error) { operationError = error }
  try {
    const after = await lstat(temporary)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== root.dev || after.ino !== root.ino ||
        await realpath(temporary) !== temporary) throw new Error('unsafe')
    if (trustDirectoryCreated) {
      const directory = join(temporary, 'license-trust')
      const names = await readdir(directory)
      if (names.some(name => name !== 'trust-bundle-state.json' && name !== 'trust-bundle-store.marker.json')) throw new Error('unsafe')
      for (const name of names) {
        const path = join(directory, name), info = await lstat(path)
        const expected = owned.get(name)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
            !expected || info.dev !== expected.dev || info.ino !== expected.ino) throw new Error('unsafe')
        await unlink(path)
      }
      await rmdir(directory)
    }
    await rmdir(temporary)
  } catch { cleanupFailure = true }
  if (cleanupFailure) throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED')
  if (operationError) throw operationError
  if (!result) throw new Error('BACKUP_TRUST_STORE_INVALID')
  return result
}
