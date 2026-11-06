import { constants } from 'node:fs'
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { canonical, LocalResticRepository, privateDirectory, trustedAncestors, within } from './restic-local.js'
import { verifyPublishedSnapshot, type PublishSetInput } from './publish-set.js'
import { verifyDirectPublishedSet } from './direct-publish-set.js'
import { verifyPostgresDumpBinding, type PostgresDumpTarget } from './pg-dump.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'

export type S3CopyConfiguration = {
  binary: string
  localRepository: string
  localPasswordFile: string
  remoteHttpsUrl: string
  remotePasswordFile: string
  credentialsFile: string
  publicationDirectory: string
  remoteStatusDirectory: string
  scratchParent: string
  tarBinary: string
  maxExtractBytes: number
  timeoutMs?: number
  /** Production must use verifyPostgresDumpBinding on the decrypted archive. */
  verifyDumpBinding: PublishSetInput['verifyDumpBinding']
  inspectTrustStoreReadOnly?: ((directory: string) => Promise<ReadonlyTrustBundleInspection>) | undefined
  /** Caller must prove that scratch is encrypted or memory-backed. */
  assertSecureStorage(): Promise<void>
  /** Caller must hold the deployment lock throughout verification and copy. */
  assertLock(): Promise<void>
}

/** Production-facing configuration excludes a substitutable dump verifier. */
export type ProductionS3CopyConfiguration = Omit<S3CopyConfiguration, 'verifyDumpBinding' | 'inspectTrustStoreReadOnly'> & {
  pgDumpTarget: Omit<PostgresDumpTarget, 'stagingDirectory'>
  inspectTrustStoreReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>
}

export type ProductionS3DirectCopyConfiguration = Omit<S3CopyConfiguration, 'verifyDumpBinding' | 'tarBinary' | 'maxExtractBytes' | 'inspectTrustStoreReadOnly'> & {
  manifestDirectory(set: string): string
  inspectTrustStoreReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>
  assertBackupRelease(releaseId: string, images: import('./manifest.js').BackupManifest['images']): Promise<void>
  assertBackupMetadata(manifest: import('./manifest.js').DirectBackupManifest): Promise<void>
}
const digestPattern = /^[a-f0-9]{64}$/

async function requireRemoteLock(input: { assertLock(): Promise<void> }): Promise<void> {
  try { await input.assertLock() } catch { throw new Error('REMOTE_COPY_LOCK_UNVERIFIED') }
}

const publicErrors = new Set(['REMOTE_COPY_ARGUMENT_INVALID', 'REMOTE_REPOSITORY_INVALID', 'RESTIC_PATH_INVALID',
  'RESTIC_ANCESTOR_UNSAFE', 'RESTIC_EXECUTABLE_UNSAFE', 'RESTIC_DIRECTORY_UNSAFE', 'REMOTE_SCRATCH_INVALID',
  'REMOTE_STATUS_LOCATION_INVALID', 'REMOTE_SECRET_LOCATION_INVALID', 'REMOTE_SECRET_INVALID', 'REMOTE_CREDENTIALS_INVALID',
  'RESTIC_TIMEOUT_INVALID', 'REMOTE_SOURCE_NOT_VERIFIED', 'REMOTE_COPY_ATTEMPT_UNCERTAIN', 'REMOTE_COPY_ALREADY_ATTEMPTED',
  'REMOTE_COPY_LOCK_UNVERIFIED', 'REMOTE_COPY_TIMEOUT', 'REMOTE_COPY_FAILED', 'REMOTE_COPY_NOT_VERIFIED'])

/** A verified marker records a past check, not present-day remote health. This
 * read-only inspection never clears an uncertain attempt or starts a retry. */
async function inspectRemoteCopyAttemptInternal(input: {
  remoteStatusDirectory: string; remoteHttpsUrl: string; assertLock(): Promise<void>
}, set: string): Promise<'not_attempted' | 'requires_review' | 'last_copy_verified'> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(set) ||
      typeof input.assertLock !== 'function') throw new Error('REMOTE_COPY_ARGUMENT_INVALID')
  const destination = createHash('sha256').update(validateS3Destination(input.remoteHttpsUrl)).digest('hex')
  const directory = await canonical(input.remoteStatusDirectory, 'directory')
  await privateDirectory(directory)
  await requireRemoteLock(input)
  if ((await readdir(directory)).some(name => name.startsWith(`.remote-${set}-${destination}-`) && name.endsWith('.tmp'))) return 'requires_review'
  let file
  try { file = await open(join(directory, `${set}-${destination}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not_attempted'; return 'requires_review' }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 ||
        before.size < 1 || before.size > 2048) return 'requires_review'
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return 'requires_review'
    let value: unknown
    try { value = JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown } catch { return 'requires_review' }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'requires_review'
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort().join(',')
    if (record.set !== set || record.destination !== destination) return 'requires_review'
    await requireRemoteLock(input)
    if (record.schema === 1 && typeof record.source === 'string' && digestPattern.test(record.source)) {
      if (keys === 'destination,schema,set,source,state' && record.state === 'uploading') return 'requires_review'
      if (keys === 'destination,remote,schema,set,source,state' && record.state === 'verified' &&
          typeof record.remote === 'string' && digestPattern.test(record.remote)) return 'last_copy_verified'
    }
    if (record.schema === 2 && typeof record.source === 'string' && digestPattern.test(record.source) &&
        typeof record.manifest === 'string' && digestPattern.test(record.manifest)) {
      if (keys === 'destination,manifest,schema,set,source,state' && record.state === 'uploading') return 'requires_review'
      if (keys === 'destination,manifest,remote_manifest,remote_source,schema,set,source,state' && record.state === 'verified' &&
          typeof record.remote_source === 'string' && digestPattern.test(record.remote_source) &&
          typeof record.remote_manifest === 'string' && digestPattern.test(record.remote_manifest)) return 'last_copy_verified'
    }
    return 'requires_review'
  } finally { await file.close() }
}

export async function inspectRemoteCopyAttempt(input: {
  remoteStatusDirectory: string; remoteHttpsUrl: string; assertLock(): Promise<void>
}, set: string): Promise<'not_attempted' | 'requires_review' | 'last_copy_verified'> {
  try {
    const state = await inspectRemoteCopyAttemptInternal(input, set)
    await requireRemoteLock(input)
    return state
  }
  catch (error) {
    // Never include native filesystem exceptions (which contain local paths).
    // eslint-disable-next-line preserve-caught-error
    throw new Error(error instanceof Error && publicErrors.has(error.message) ? error.message : 'REMOTE_STATUS_UNAVAILABLE')
  }
}

/** Use the actual pg_restore-based binding check for the decrypted snapshot. */
export async function copyProductionVerifiedSnapshotToS3(config: ProductionS3CopyConfiguration, set: string, snapshot: string): Promise<string> {
  const { pgDumpTarget, ...rest } = config
  if (!pgDumpTarget || typeof pgDumpTarget !== 'object') throw new Error('REMOTE_COPY_ARGUMENT_INVALID')
  return copyVerifiedSnapshotToS3({ ...rest, verifyDumpBinding: (directory, metadata) =>
    verifyPostgresDumpBinding({ ...pgDumpTarget, stagingDirectory: directory }, metadata),
    inspectTrustStoreReadOnly: config.inspectTrustStoreReadOnly }, set, snapshot)
}

/** Copy both members of a verified direct-source set. A partial transfer is
 * durable and requires review before any later attempt. */
export async function copyProductionDirectBackupToS3(config: ProductionS3DirectCopyConfiguration, set: string): Promise<string> {
  return copyVerifiedSnapshotToS3Internal({ ...config, tarBinary: '/usr/bin/tar', maxExtractBytes: 1,
    verifyDumpBinding: async () => {}, inspectTrustStoreReadOnly: config.inspectTrustStoreReadOnly }, set, null, config.manifestDirectory)
}

/** Only HTTPS path-style endpoints without URL credentials or query parameters. */
export function validateS3Destination(input: string): string {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('REMOTE_REPOSITORY_INVALID') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash ||
      input !== url.href || !/^\/[a-z0-9][a-z0-9.-]{1,61}(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127})*\/?$/.test(url.pathname) ||
      url.pathname.split('/').some(part => part === '..' || part === '.')) throw new Error('REMOTE_REPOSITORY_INVALID')
  return `s3:${url.href}`
}

async function secretHandle(path: string, repository: string, scratch: string) {
  const resolved = await canonical(path, 'file')
  await trustedAncestors(resolved)
  if (within(repository, resolved) || within(scratch, resolved)) throw new Error('REMOTE_SECRET_LOCATION_INVALID')
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const info = await file.stat()
  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 4096 || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    await file.close()
    throw new Error('REMOTE_SECRET_INVALID')
  }
  return file
}

function readCredentials(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('REMOTE_CREDENTIALS_INVALID')
  const item = input as Record<string, unknown>
  const keys = Object.keys(item).sort().join(',')
  if (keys !== 'accessKeyId,secretAccessKey' && keys !== 'accessKeyId,secretAccessKey,sessionToken') throw new Error('REMOTE_CREDENTIALS_INVALID')
  for (const value of Object.values(item)) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) throw new Error('REMOTE_CREDENTIALS_INVALID')
  }
  return { AWS_ACCESS_KEY_ID: item.accessKeyId as string, AWS_SECRET_ACCESS_KEY: item.secretAccessKey as string,
    ...(item.sessionToken ? { AWS_SESSION_TOKEN: item.sessionToken as string } : {}) }
}

/** Caller provides a private encrypted scratch directory; SIGKILL cleanup is an
 * external maintenance obligation. No source-repository mutation is performed. */
async function copyVerifiedSnapshotToS3Internal(config: S3CopyConfiguration & {
  manifestDirectory?: (set: string) => string
  assertBackupRelease?: (releaseId: string, images: import('./manifest.js').BackupManifest['images']) => Promise<void>
  assertBackupMetadata?: (manifest: import('./manifest.js').DirectBackupManifest) => Promise<void>
}, set: string,
  snapshot: string | null, directManifestDirectory?: (set: string) => string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(set) ||
      (snapshot !== null && !digestPattern.test(snapshot)) || (snapshot === null && typeof directManifestDirectory !== 'function')) throw new Error('REMOTE_COPY_ARGUMENT_INVALID')
  if (typeof config.assertSecureStorage !== 'function' || typeof config.assertLock !== 'function' ||
      typeof config.verifyDumpBinding !== 'function') throw new Error('REMOTE_COPY_ARGUMENT_INVALID')
  const destination = validateS3Destination(config.remoteHttpsUrl)
  const binary = await canonical(config.binary, 'file')
  await trustedAncestors(binary)
  const executable = await lstat(binary)
  if (executable.nlink !== 1 || (executable.mode & 0o022) !== 0 || (executable.mode & 0o111) === 0 ||
      (typeof process.getuid === 'function' && executable.uid !== 0 && executable.uid !== process.getuid())) throw new Error('RESTIC_EXECUTABLE_UNSAFE')
  const repository = await canonical(config.localRepository, 'directory')
  await privateDirectory(repository)
  const scratch = await canonical(config.scratchParent, 'directory')
  await privateDirectory(scratch)
  if (within(scratch, repository) || within(repository, scratch)) throw new Error('REMOTE_SCRATCH_INVALID')
  const statusDirectory = await canonical(config.remoteStatusDirectory, 'directory')
  await privateDirectory(statusDirectory)
  const publicationDirectory = await canonical(config.publicationDirectory, 'directory')
  await privateDirectory(publicationDirectory)
  if (within(statusDirectory, repository) || within(repository, statusDirectory) ||
      within(statusDirectory, scratch) || within(scratch, statusDirectory) || within(statusDirectory, publicationDirectory) ||
      within(publicationDirectory, statusDirectory) || within(publicationDirectory, repository) ||
      within(repository, publicationDirectory)) throw new Error('REMOTE_STATUS_LOCATION_INVALID')
  const destinationDigest = createHash('sha256').update(destination).digest('hex')
  const markerName = `${set}-${destinationDigest}.json`
  const marker = join(statusDirectory, markerName)
  const localPassword = await secretHandle(config.localPasswordFile, repository, scratch)
  try {
    const remotePassword = await secretHandle(config.remotePasswordFile, repository, scratch)
    try {
      const credentials = await secretHandle(config.credentialsFile, repository, scratch)
      let env: Record<string, string>
      try {
        const before = await credentials.stat()
        const bytes = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          const result = await credentials.read(bytes, offset, bytes.length - offset, offset)
          if (result.bytesRead === 0) break
          offset += result.bytesRead
        }
        const after = await credentials.stat()
        if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error('REMOTE_CREDENTIALS_INVALID')
        }
        try { env = readCredentials(JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown) } catch { throw new Error('REMOTE_CREDENTIALS_INVALID') }
      } finally { await credentials.close() }
      const timeoutMs = config.timeoutMs ?? 6 * 60 * 60 * 1000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 6 * 60 * 60 * 1000) throw new Error('RESTIC_TIMEOUT_INVALID')
      const source = new LocalResticRepository({ binary, repository, passwordFile: config.localPasswordFile, timeoutMs })
      await requireRemoteLock(config)
      let sourceSnapshots: string[]
      if (snapshot === null) {
        let verified: Awaited<ReturnType<typeof verifyDirectPublishedSet>>
        try {
          verified = await verifyDirectPublishedSet({ backupSetId: set, publicationDirectory: config.publicationDirectory,
            manifestDirectory: directManifestDirectory!(set), scratchDirectory: scratch, repository: source,
            assertSecureStorage: config.assertSecureStorage, assertLock: () => requireRemoteLock(config),
            inspectTrustStoreReadOnly: config.inspectTrustStoreReadOnly!,
            async assertAuthenticatedManifest(manifest) {
              await config.assertBackupRelease!(manifest.release_id, manifest.images)
              await config.assertBackupMetadata!(manifest)
            } })
        } catch { throw new Error('REMOTE_SOURCE_NOT_VERIFIED') }
        if (verified.status !== 'verified' || verified.manifest.status !== 'candidate' || verified.manifest.backup_set_id !== set) {
          throw new Error('REMOTE_SOURCE_NOT_VERIFIED')
        }
        sourceSnapshots = [verified.sourceSnapshotId, verified.snapshotId]
      } else {
        let verified: Awaited<ReturnType<typeof verifyPublishedSnapshot>>
        try {
          verified = await verifyPublishedSnapshot({ backupSetId: set, publicationDirectory: config.publicationDirectory,
            scratchParent: scratch, tarBinary: config.tarBinary, repository: source,
            maxExtractBytes: config.maxExtractBytes, assertSecureStorage: config.assertSecureStorage,
            assertSafeCleanup: async () => { await requireRemoteLock(config); await config.assertSecureStorage() },
            verifyDumpBinding: config.verifyDumpBinding })
        } catch { throw new Error('REMOTE_SOURCE_NOT_VERIFIED') }
        if (verified.status !== 'verified' || verified.snapshotId !== snapshot || verified.manifest.status !== 'candidate' ||
            verified.manifest.backup_set_id !== set) throw new Error('REMOTE_SOURCE_NOT_VERIFIED')
        sourceSnapshots = [snapshot]
      }
      await requireRemoteLock(config)
      // A prior attempted or ambiguous transfer must be inspected explicitly;
      // do not start a duplicate copy merely because the client lost its reply.
      if ((await readdir(statusDirectory)).some(name => name.startsWith(`.remote-${set}-${destinationDigest}-`) && name.endsWith('.tmp'))) {
        throw new Error('REMOTE_COPY_ATTEMPT_UNCERTAIN')
      }
      const uploadingValue = snapshot === null
        ? { schema: 2, set, source: sourceSnapshots[0]!, manifest: sourceSnapshots[1]!, destination: destinationDigest, state: 'uploading' }
        : { schema: 1, set, source: sourceSnapshots[0]!, destination: destinationDigest, state: 'uploading' }
      const uploading = `${JSON.stringify(uploadingValue)}\n`
      let attempt
      try { attempt = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) }
      catch (error) {
        // The native error includes a private path; never expose it as a cause.
        // eslint-disable-next-line preserve-caught-error
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('REMOTE_COPY_ALREADY_ATTEMPTED')
        throw error
      }
      try { await attempt.writeFile(uploading); await attempt.sync() } finally { await attempt.close() }
      const statusHandle = await open(statusDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await statusHandle.sync() } finally { await statusHandle.close() }
      await requireRemoteLock(config)
      async function execute(args: string[]): Promise<string> {
        // Each command receives fresh file descriptions. A previous command may
        // have advanced the offsets of descriptors inherited by its child.
        const from = await secretHandle(config.localPasswordFile, repository, scratch)
        try {
          const to = await secretHandle(config.remotePasswordFile, repository, scratch)
          try {
            await requireRemoteLock(config)
            return await new Promise((accept, reject) => {
          const child = spawn(binary, ['--repo', destination, '--password-file', '/dev/fd/4', '--no-cache', '--quiet', ...args], {
            env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: repository, TMPDIR: scratch, AWS_EC2_METADATA_DISABLED: 'true', ...env },
            stdio: ['ignore', 'pipe', 'pipe', from.fd, to.fd],
          })
          let output = '', stdoutSize = 0, stderrSize = 0, invalid = false, timedOut = false, spawnError = false, lockLost = false, checkingLock = false, childClosed = false
          let killTimer: ReturnType<typeof setTimeout> | undefined
          const stop = () => { if (!childClosed) { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000) } }
          const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
          const lockTimer = setInterval(() => {
            // A stuck lock verifier is itself uncertainty. Never stack checks or
            // continue a remote operation on an unverifiable deployment lock.
            if (checkingLock) { lockLost = true; stop(); return }
            checkingLock = true
            void requireRemoteLock(config).catch(() => { lockLost = true; stop() }).finally(() => { checkingLock = false })
          }, 1000)
          child.stdout!.on('data', (chunk: Buffer) => {
            stdoutSize += chunk.length
            if (stdoutSize > 1024 * 1024) { invalid = true; stop() } else output += chunk.toString('utf8')
          })
          child.stderr!.on('data', (chunk: Buffer) => { stderrSize += chunk.length; if (stderrSize > 1024 * 1024) { invalid = true; stop() } })
          child.once('error', () => { spawnError = true })
          child.once('close', code => {
            childClosed = true
            clearTimeout(timer)
            clearInterval(lockTimer)
            if (killTimer) clearTimeout(killTimer)
            if (checkingLock) lockLost = true
            if (lockLost) reject(new Error('REMOTE_COPY_LOCK_UNVERIFIED'))
            else if (timedOut) reject(new Error('REMOTE_COPY_TIMEOUT'))
            else if (spawnError || invalid || code !== 0) reject(new Error('REMOTE_COPY_FAILED'))
            else accept(output)
          })
            })
          } finally { await to.close() }
        } finally { await from.close() }
      }
      for (const sourceSnapshot of sourceSnapshots) {
        await execute(['copy', '--from-repo', repository, '--from-password-file', '/dev/fd/3', sourceSnapshot])
      }
      await requireRemoteLock(config)
      // A successful upload and snapshot listing do not prove remote packs can
      // be read back. Never report the remote copy as verified before this.
      await execute(['check', '--read-data'])
      await requireRemoteLock(config)
      const output = await execute(['snapshots', '--json', '--tag', `aikayun-set-${set}`])
      let snapshots: unknown
      try { snapshots = JSON.parse(output) as unknown } catch { throw new Error('REMOTE_COPY_NOT_VERIFIED') }
      let remoteId: string
      let remotePair: { source: string; manifest: string } | undefined
      if (snapshot === null) {
        if (!Array.isArray(snapshots) || snapshots.length !== 2) throw new Error('REMOTE_COPY_NOT_VERIFIED')
        const match = new Map<string, string>()
        for (const item of snapshots) {
          if (!item || typeof item !== 'object' || !('original' in item) || !('id' in item) || !('tags' in item) ||
              typeof item.original !== 'string' || !digestPattern.test(item.original) || typeof item.id !== 'string' || !digestPattern.test(item.id) ||
              !Array.isArray(item.tags) || !item.tags.includes(`aikayun-set-${set}`)) throw new Error('REMOTE_COPY_NOT_VERIFIED')
          const expectedRole = item.original === sourceSnapshots[0] ? 'aikayun-role-source' :
            item.original === sourceSnapshots[1] ? 'aikayun-role-manifest' : ''
          if (!expectedRole || !item.tags.includes(expectedRole)) throw new Error('REMOTE_COPY_NOT_VERIFIED')
          match.set(item.original, item.id)
        }
        const sourceRemote = match.get(sourceSnapshots[0]!), manifestRemote = match.get(sourceSnapshots[1]!)
        if (match.size !== 2 || !sourceRemote || !manifestRemote) throw new Error('REMOTE_COPY_NOT_VERIFIED')
        remotePair = { source: sourceRemote, manifest: manifestRemote }
        remoteId = manifestRemote
      } else {
        if (!Array.isArray(snapshots) || snapshots.length !== 1 || snapshots[0]?.original !== snapshot ||
            !digestPattern.test(snapshots[0]?.id ?? '') || !Array.isArray(snapshots[0]?.tags) ||
            !snapshots[0].tags.includes(`aikayun-set-${set}`)) throw new Error('REMOTE_COPY_NOT_VERIFIED')
        remoteId = snapshots[0].id as string
      }
      await requireRemoteLock(config)
      const original = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await original.stat()
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 ||
            info.size !== Buffer.byteLength(uploading) || await original.readFile('utf8') !== uploading) throw new Error('REMOTE_COPY_ATTEMPT_UNCERTAIN')
      } finally { await original.close() }
      const temporary = join(statusDirectory, `.remote-${set}-${destinationDigest}-${randomUUID()}.tmp`)
      try {
        const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        const verifiedValue = remotePair
          ? { schema: 2, set, source: sourceSnapshots[0]!, manifest: sourceSnapshots[1]!, destination: destinationDigest,
              state: 'verified', remote_source: remotePair.source, remote_manifest: remotePair.manifest }
          : { schema: 1, set, source: sourceSnapshots[0]!, destination: destinationDigest, state: 'verified', remote: remoteId }
        try { await file.writeFile(`${JSON.stringify(verifiedValue)}\n`); await file.sync() }
        finally { await file.close() }
        await requireRemoteLock(config)
        await rename(temporary, marker)
        const directory = await open(statusDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
      } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
      return remoteId
    } finally { await remotePassword.close() }
  } finally { await localPassword.close() }
}

export async function copyVerifiedSnapshotToS3(config: S3CopyConfiguration, set: string, snapshot: string): Promise<string> {
  try { return await copyVerifiedSnapshotToS3Internal(config, set, snapshot) }
  catch (error) {
    // Native process/filesystem errors may contain secrets or customer paths.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(error instanceof Error && publicErrors.has(error.message) ? error.message : 'REMOTE_COPY_UNAVAILABLE')
  }
}
