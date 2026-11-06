import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoSwapTmpfs } from './tmpfs-staging.js'
import { LocalResticRepository, trustedAncestors, within } from './restic-local.js'
import { ResticCommandContainer } from './restic-command-container.js'

const minimumStagingBytes = 256n * 1024n * 1024n
async function validate(input: { root: string; credentialDirectory: string; binary?: string; backupResticImage?: string;
  minimumBytes: bigint; signal?: AbortSignal; assertLock?: () => Promise<void> }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || input.minimumBytes < 1n) throw new Error('BACKUP_FIXED_STORAGE_INVALID')
  const repository = join(input.root, 'repository'), journalDirectory = join(input.root, 'journal')
  const publicationDirectory = join(input.root, 'publications'), mountRoot = join(input.root, 'staging')
  const passwordFile = join(input.credentialDirectory, 'restic-password')
  const directories = [input.root, repository, journalDirectory, publicationDirectory, mountRoot, input.credentialDirectory]
  for (const path of directories) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o700 ||
        await realpath(path) !== path) throw new Error('BACKUP_FIXED_STORAGE_INVALID')
    await trustedAncestors(path)
  }
  const file = await lstat(passwordFile)
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== 0 || file.gid !== 0 ||
      (file.mode & 0o777) !== 0o600 || file.size < 1 || file.size > 4096 || await realpath(passwordFile) !== passwordFile ||
      within(input.root, passwordFile) || within(input.credentialDirectory, input.root)) throw new Error('BACKUP_FIXED_STORAGE_INVALID')
  await assertNoSwapTmpfs(mountRoot, input.minimumBytes)
  let executor: ResticCommandContainer | undefined
  if (input.backupResticImage) {
    if (!/^ghcr\.io\/yykx682436\/aikayun-backup-restic@sha256:[a-f0-9]{64}$/.test(input.backupResticImage) ||
        typeof input.assertLock !== 'function') throw new Error('BACKUP_FIXED_STORAGE_INVALID')
    const broker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
    const dockerBinary = broker ? undefined : '/usr/bin/docker', dockerSocket = broker ? undefined : '/run/docker.sock'
    if (!broker) {
      await trustedAncestors(dockerBinary!)
      const [docker, socket] = await Promise.all([lstat(dockerBinary!), lstat(dockerSocket!)])
      if (!docker.isFile() || docker.isSymbolicLink() || docker.nlink !== 1 || docker.uid !== 0 || (docker.mode & 0o022) !== 0 ||
          (docker.mode & 0o111) === 0 || await realpath(dockerBinary!) !== dockerBinary || !socket.isSocket() || socket.uid !== 0 ||
          await realpath(dockerSocket!) !== dockerSocket) throw new Error('BACKUP_FIXED_STORAGE_INVALID')
    }
    executor = new ResticCommandContainer({ ...(dockerBinary ? { dockerBinary } : {}), ...(dockerSocket ? { dockerSocket } : {}), image: input.backupResticImage,
      repositoryDirectory: repository, passwordFile, assertLock: input.assertLock, ...(input.signal ? { signal: input.signal } : {}) })
    await executor.initialize()
  } else {
    if (!input.binary) throw new Error('BACKUP_FIXED_STORAGE_INVALID')
    await trustedAncestors(input.binary)
    const binary = await lstat(input.binary)
    if (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || binary.uid !== 0 || (binary.mode & 0o022) !== 0 ||
        (binary.mode & 0o111) === 0 || await realpath(input.binary) !== input.binary) throw new Error('BACKUP_FIXED_STORAGE_INVALID')
  }
  return { repositoryDirectory: repository, mountRoot, minimumBytes: input.minimumBytes, journalDirectory, publicationDirectory,
    repository: new LocalResticRepository({ ...(input.binary ? { binary: input.binary } : {}), repository, passwordFile,
      ...(executor ? { executor } : {}), ...(input.signal ? { signal: input.signal } : {}) }) }
}

/** Internal fixed deployment layout; never creates or initializes storage. */
export async function loadFixedBackupPaths(signal: AbortSignal, backupResticImage: string, assertLock: () => Promise<void>) {
  if (!signal || signal.aborted || typeof assertLock !== 'function') throw new Error('BACKUP_FIXED_STORAGE_INVALID')
  return validate({ root: '/var/lib/aikayun-backup', credentialDirectory: '/etc/aikayun-backup',
    backupResticImage, assertLock, minimumBytes: minimumStagingBytes, signal })
}

/** Random isolated Linux fixture only, never production paths. */
export async function loadFixtureBackupPaths(root: string, minimumBytes: bigint) {
  if (process.env.NODE_ENV !== 'test' || !/^\/tmp\/aikayun-75a-paths-[a-f0-9]{24}$/.test(root)) throw new Error('BACKUP_STORAGE_FIXTURE_INVALID')
  return validate({ root: join(root, 'backup'), credentialDirectory: join(root, 'credentials'), binary: join(root, 'restic'), minimumBytes })
}
