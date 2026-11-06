import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readMaintenanceJournal } from './journal.js'
import { LocalResticRepository, privateDirectory } from './restic-local.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

const markerName = 'repository-initialization.json'
const idPattern = /^[a-f0-9]{64}$/
type Input = { repositoryDirectory: string; journalDirectory: string; publicationDirectory: string; mountRoot: string;
  repository: LocalResticRepository; assertLock(): Promise<void> }
async function syncDirectory(directory: string) {
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await file.sync() } finally { await file.close() }
}
async function validatePaths(input: Input) {
  const dirs = [input.repositoryDirectory, input.journalDirectory, input.publicationDirectory, input.mountRoot]
  for (const path of dirs) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_REPOSITORY_PATH_INVALID')
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('BACKUP_REPOSITORY_PATH_INVALID')
    await privateDirectory(path)
  }
  await input.repository.assertRepositoryPath(input.repositoryDirectory)
  await input.repository.assertSeparatedStorage([input.journalDirectory, input.publicationDirectory, input.mountRoot])
}

/** Read-only check: only the durable marker bound to the actual decrypted
 * repository ID establishes initialization. No manual adoption or repair. */
export async function assertInitializedRepository(input: Input): Promise<void> {
  await input.assertLock()
  await validatePaths(input)
  if ((await readdir(input.journalDirectory)).some(name => /^\.repository-init-.*\.tmp$/.test(name))) throw new Error('BACKUP_REPOSITORY_INIT_UNCERTAIN')
  const file = await open(join(input.journalDirectory, markerName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let expected: string
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 1024) throw new Error('BACKUP_REPOSITORY_INIT_UNCERTAIN')
    const data: unknown = JSON.parse(await file.readFile('utf8'))
    const after = await file.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        !data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'repositoryId,schema,state' ||
        !('schema' in data) || data.schema !== 1 || !('state' in data) || data.state !== 'verified' ||
        !('repositoryId' in data) || typeof data.repositoryId !== 'string' || !idPattern.test(data.repositoryId)) throw new Error('BACKUP_REPOSITORY_INIT_UNCERTAIN')
    expected = data.repositoryId
  } finally { await file.close() }
  if (await input.repository.repositoryIdentity() !== expected) throw new Error('BACKUP_REPOSITORY_INIT_UNCERTAIN')
  await input.assertLock()
}

/** Explicitly initialize a completely empty dedicated repository. The password
 * must already exist outside the repository; this never creates a credential. */
export async function initializeEmptyRepository(input: Input): Promise<void> {
  await input.assertLock()
  await validatePaths(input)
  if (await readMaintenanceJournal(input.journalDirectory) || (await readdir(input.journalDirectory)).length !== 0 ||
      (await readdir(input.repositoryDirectory)).length !== 0 || (await readdir(input.publicationDirectory)).length !== 0 ||
      (await readdir(input.mountRoot)).length !== 0) throw new Error('BACKUP_REPOSITORY_NOT_EMPTY')
  await input.assertLock()
  const marker = join(input.journalDirectory, markerName)
  let attempted = false, markerIdentity: { dev: number; ino: number } | undefined
  try {
    const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    attempted = true
    const markerStat = await file.stat()
    markerIdentity = { dev: markerStat.dev, ino: markerStat.ino }
    try { await file.writeFile('{"schema":1,"state":"initializing"}\n'); await file.sync() } finally { await file.close() }
    await syncDirectory(input.journalDirectory)
    await input.assertLock()
    await input.repository.initialize()
    const repositoryId = await input.repository.repositoryIdentity()
    await input.repository.check()
    if ((await input.repository.snapshots()).length !== 0) throw new Error('BACKUP_REPOSITORY_NOT_EMPTY')
    await input.assertLock()
    const old = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await old.stat()
      if (!markerIdentity || info.dev !== markerIdentity.dev || info.ino !== markerIdentity.ino || !info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 ||
          await old.readFile('utf8') !== '{"schema":1,"state":"initializing"}\n') throw new Error('BACKUP_REPOSITORY_INIT_UNCERTAIN')
    } finally { await old.close() }
    const temporary = join(input.journalDirectory, `.repository-init-${randomUUID()}.tmp`)
    const completed = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await completed.writeFile(`${JSON.stringify({ schema: 1, state: 'verified', repositoryId })}\n`); await completed.sync() } finally { await completed.close() }
    await input.assertLock()
    const current = await lstat(marker)
    if (!markerIdentity || current.dev !== markerIdentity.dev || current.ino !== markerIdentity.ino || current.isSymbolicLink()) throw new Error('BACKUP_REPOSITORY_INIT_UNCERTAIN')
    await rename(temporary, marker)
    await syncDirectory(input.journalDirectory)
    await assertInitializedRepository(input)
  } catch (error) {
    if (attempted) throw new UnsafeMaintenanceRecoveryError('REPOSITORY_INIT_UNCERTAIN')
    throw error
  }
}
