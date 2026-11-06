import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { backupArtifacts, validateBackupManifest, verifyBackupSet, type BackupManifest } from './manifest.js'
import { LocalResticRepository } from './restic-local.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digest = /^[a-f0-9]{64}$/
const filenames = ['manifest.json', ...backupArtifacts] as const

/** Remove only known files in the owned scratch directory while lock and
 * child-process cleanup are proven. Preserve all evidence on uncertainty. */
export async function removeExtractedBackup(parent: string, name: string, assertSafeCleanup: () => Promise<void>): Promise<void> {
  try {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || typeof assertSafeCleanup !== 'function') throw new Error('unsafe')
    await assertSafeCleanup()
    const target = join(parent, name)
    const [root, directory] = await Promise.all([lstat(parent), lstat(target)])
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700 ||
        await realpath(parent) !== parent || !directory.isDirectory() ||
        directory.isSymbolicLink() || directory.uid !== process.getuid?.() || directory.dev !== root.dev ||
        (directory.mode & 0o777) !== 0o700 || await realpath(target) !== target) throw new Error('unsafe')
    const names = await readdir(target)
    const identities = new Map<string, { dev: number; ino: number }>()
    for (const file of names) {
      if (!filenames.includes(file as typeof filenames[number])) throw new Error('unsafe')
      const item = await lstat(join(target, file))
      if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.uid !== process.getuid?.() || item.dev !== root.dev) throw new Error('unsafe')
      identities.set(file, { dev: item.dev, ino: item.ino })
    }
    await assertSafeCleanup()
    const final = await lstat(target)
    if (final.dev !== directory.dev || final.ino !== directory.ino || await realpath(target) !== target) throw new Error('unsafe')
    for (const file of names) {
      await assertSafeCleanup()
      const item = await lstat(join(target, file)), expected = identities.get(file)
      if (!expected || !item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.uid !== process.getuid?.() ||
          item.dev !== expected.dev || item.ino !== expected.ino) throw new Error('unsafe')
      await unlink(join(target, file))
    }
    await assertSafeCleanup()
    await rmdir(target)
  } catch { throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED') }
}

/** Extract fixed files only; never unpack the archives. The caller must provide
 * private encrypted scratch space and handle a process killed before cleanup. */
export async function extractVerifiedBackup(repo: LocalResticRepository, set: string, snapshot: string,
  parent: string, name: string, maxBytes: number, allowCandidate = false, assertSafeCleanup?: () => Promise<void>, signal?: AbortSignal): Promise<BackupManifest> {
  if (!uuid.test(set) || !digest.test(snapshot) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof assertSafeCleanup !== 'function') throw new Error('BACKUP_EXTRACT_ARGUMENT_INVALID')
  if (signal?.aborted) throw new Error('BACKUP_EXTRACT_INTERRUPTED')
  await repo.validateExtractionParent(parent)
  const snapshots = await repo.snapshotMetadata(set)
  if (!Array.isArray(snapshots) || snapshots.length !== 1) throw new Error('BACKUP_SNAPSHOT_AMBIGUOUS')
  const metadata = snapshots[0] as { id?: unknown; tags?: unknown; paths?: unknown }
  if (metadata.id !== snapshot || !Array.isArray(metadata.tags) || !metadata.tags.includes(`aikayun-set-${set}`) ||
      !Array.isArray(metadata.paths) || metadata.paths.length !== 1 || typeof metadata.paths[0] !== 'string') {
    throw new Error('BACKUP_SNAPSHOT_INVALID')
  }
  const root = metadata.paths[0]
  if (!root.startsWith('/') || root === '/' || posix.normalize(root) !== root ||
      [...root].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)) {
    throw new Error('BACKUP_SNAPSHOT_INVALID')
  }
  const entries = new Map<string, number>()
  for (const line of (await repo.listSnapshot(snapshot)).trim().split('\n')) {
    let entry: { struct_type?: unknown; path?: unknown; type?: unknown; size?: unknown }
    try { entry = JSON.parse(line) as typeof entry } catch { throw new Error('BACKUP_SNAPSHOT_INVALID') }
    if (signal?.aborted) throw new Error('BACKUP_EXTRACT_INTERRUPTED')
    if (entry.struct_type !== 'node') continue
    if (typeof entry.path !== 'string') throw new Error('BACKUP_SNAPSHOT_INVALID')
    if (entry.type === 'dir' && (entry.path === root || root.startsWith(`${entry.path}/`))) continue
    const relative = entry.path.startsWith(`${root}/`) ? entry.path.slice(root.length + 1) : ''
    if (!filenames.includes(relative as typeof filenames[number]) || entry.type !== 'file' ||
        !Number.isSafeInteger(entry.size) || (entry.size as number) < 1 || entries.has(relative)) throw new Error('BACKUP_SNAPSHOT_INVALID')
    entries.set(relative, entry.size as number)
  }
  if (entries.size !== filenames.length || (entries.get('manifest.json') ?? 0) > 65536 ||
      [...entries.values()].reduce((a, b) => a + b, 0) > maxBytes) throw new Error('BACKUP_SNAPSHOT_INVALID')
  const target = join(parent, name)
  await mkdir(target, { mode: 0o700 }) // exclusive; never overwrite an existing target
  try {
    async function dump(filename: string, size: number) {
      if (signal?.aborted) throw new Error('BACKUP_EXTRACT_INTERRUPTED')
      const file = await open(join(target, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await repo.dumpFile(snapshot, posix.join(root, filename), file, size)
        if ((await file.stat()).size !== size) throw new Error('BACKUP_ARTIFACT_MISMATCH')
        await file.sync()
      } finally { await file.close() }
    }
    await dump('manifest.json', entries.get('manifest.json')!)
    const parsed: unknown = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    validateBackupManifest(parsed, allowCandidate)
    if (parsed.backup_set_id !== set) throw new Error('BACKUP_SET_MISMATCH')
    for (const file of backupArtifacts) {
      if (parsed.artifacts[file].size !== entries.get(file)) throw new Error('BACKUP_ARTIFACT_MISMATCH')
      await dump(file, parsed.artifacts[file].size)
    }
    return await verifyBackupSet(target, allowCandidate, signal)
  } catch (error) {
    if (!assertSafeCleanup) throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED')
    await removeExtractedBackup(parent, name, assertSafeCleanup)
    throw error
  }
}
