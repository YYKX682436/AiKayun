import { constants } from 'node:fs'
import { open, lstat, realpath, link, rename, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// This is a persistence primitive, not an automatic recovery mechanism. All
// callers must hold the deployment lock for every read/create/update sequence.
const fileName = 'backup-maintenance.json'
const stages = ['prepared', 'stopping', 'stopped', 'captured', 'restoring', 'complete'] as const
type Stage = typeof stages[number]
export type MaintenanceJournal = {
  version: 1
  deployment: string
  backupSetId: string
  phase: Stage
  services: { name: string; containerId: string; running: boolean }[]
  roles: { name: 'aikayun_app' | 'aikayun_migrator'; canLogin: boolean }[]
  updatedAt: string
}

function validate(value: unknown): asserts value is MaintenanceJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid maintenance journal')
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'backupSetId,deployment,phase,roles,services,updatedAt,version'
    || v.version !== 1 || typeof v.deployment !== 'string' || !/^[a-f0-9]{64}$/.test(v.deployment)
    || typeof v.backupSetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.backupSetId)
    || typeof v.phase !== 'string' || !stages.includes(v.phase as Stage)
    || typeof v.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.updatedAt)
    || !Array.isArray(v.services) || v.services.length > 100 || !Array.isArray(v.roles) || v.roles.length !== 2) throw new Error('Invalid maintenance journal')
  const seen = new Set<string>()
  for (const item of v.services) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'containerId,name,running'
      || typeof item.name !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(item.name)
      || typeof item.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(item.containerId)
      || typeof item.running !== 'boolean' || seen.has(item.containerId)) throw new Error('Invalid maintenance journal')
    seen.add(item.containerId)
  }
  const roleNames = new Set<string>()
  for (const role of v.roles) {
    if (!role || typeof role !== 'object' || Array.isArray(role)
      || Object.keys(role).sort().join(',') !== 'canLogin,name'
      || (role.name !== 'aikayun_app' && role.name !== 'aikayun_migrator')
      || typeof role.canLogin !== 'boolean' || roleNames.has(role.name)) throw new Error('Invalid maintenance journal')
    roleNames.add(role.name)
  }
}

async function secureDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory) {
    throw new Error('Unsafe journal directory')
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Unsafe journal directory')
  }
  // A sticky parent permits only the owner to rename this directory. Otherwise
  // each ancestor must be writable only by its owner; owners are trusted.
  let parent = dirname(directory)
  while (true) {
    const stat = await lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
      || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error('Unsafe journal ancestor')
    }
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

export async function readMaintenanceJournal(directory: string): Promise<MaintenanceJournal | null> {
  await secureDirectory(directory)
  if ((await readdir(directory)).some(name => /^\.backup-maintenance-.*\.tmp$/.test(name))) {
    throw new Error('Incomplete maintenance journal write requires inspection')
  }
  let handle
  try { handle = await open(join(directory, fileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 65536) {
      throw new Error('Unsafe maintenance journal')
    }
    const data: unknown = JSON.parse(await handle.readFile('utf8'))
    validate(data)
    return data
  } finally { await handle.close() }
}

async function persist(directory: string, journal: MaintenanceJournal, create: boolean) {
  validate(journal)
  await secureDirectory(directory)
  const temporary = join(directory, `.backup-maintenance-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`)
      await handle.sync()
    } finally { await handle.close() }
    if (create) {
      await link(temporary, join(directory, fileName)) // Atomic no-replace.
      await unlink(temporary)
    } else {
      await rename(temporary, join(directory, fileName))
    }
    await syncDirectory(directory)
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
}

export async function createMaintenanceJournal(directory: string, input: Omit<MaintenanceJournal, 'version' | 'phase' | 'updatedAt'>) {
  if (await readMaintenanceJournal(directory)) throw new Error('Maintenance journal already exists')
  const journal: MaintenanceJournal = { ...input, version: 1, phase: 'prepared', updatedAt: new Date().toISOString() }
  validate(journal)
  try {
    await lstat(join(directory, `backup-maintenance-${journal.backupSetId}.complete.json`))
    throw new Error('Maintenance backup set ID already exists')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await persist(directory, journal, true)
  return journal
}

export async function advanceMaintenanceJournal(directory: string, expected: MaintenanceJournal, phase: Stage) {
  validate(expected)
  const current = await readMaintenanceJournal(directory)
  const mayRestore = phase === 'restoring' && current && ['prepared', 'stopping', 'stopped', 'captured'].includes(current.phase)
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)
    || (!mayRestore && stages.indexOf(phase) !== stages.indexOf(current.phase) + 1)) {
    throw new Error('Maintenance journal changed or transition invalid')
  }
  const next = { ...current, phase, updatedAt: new Date().toISOString() }
  await persist(directory, next, false)
  return next
}

/** Retire a completed maintenance record under the deployment lock.
 * Completion records service restoration at the time of maintenance; the
 * publication record separately determines whether the backup succeeded. */
export async function archiveCompletedMaintenanceJournal(
  directory: string, expected: MaintenanceJournal, assertLock: () => Promise<void>,
): Promise<void> {
  validate(expected)
  if (expected.phase !== 'complete') throw new Error('Maintenance journal is not complete')
  await assertLock()
  const current = await readMaintenanceJournal(directory)
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Maintenance journal changed')
  const target = join(directory, `backup-maintenance-${expected.backupSetId}.complete.json`)
  const temporary = join(directory, `.backup-maintenance-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(`${JSON.stringify(expected)}\n`); await file.sync() } finally { await file.close() }
    await assertLock()
    try { await link(temporary, target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await unlink(temporary)
    // An interrupted prior retirement may already have installed the archive.
    // Accept it only if it is exactly the same safe, complete record.
    const archived = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await archived.stat()
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 65536) {
        throw new Error('Unsafe maintenance archive')
      }
      const contents: unknown = JSON.parse(await archived.readFile('utf8'))
      validate(contents)
      if (JSON.stringify(contents) !== JSON.stringify(expected)) throw new Error('Maintenance archive conflict')
    } finally { await archived.close() }
    await syncDirectory(directory)
    await assertLock()
    const again = await readMaintenanceJournal(directory)
    if (!again || JSON.stringify(again) !== JSON.stringify(expected)) throw new Error('Maintenance journal changed')
    await unlink(join(directory, fileName))
    await syncDirectory(directory)
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
}
