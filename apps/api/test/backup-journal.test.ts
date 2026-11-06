import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceMaintenanceJournal, archiveCompletedMaintenanceJournal, createMaintenanceJournal, readMaintenanceJournal } from '../src/backup/journal.js'

let directory: string
const input = () => ({ deployment: 'a'.repeat(64), backupSetId: randomUUID(), services: [
  { name: 'api', containerId: 'b'.repeat(64), running: true },
  { name: 'caddy', containerId: 'c'.repeat(64), running: false },
], roles: [
  { name: 'aikayun_app' as const, canLogin: true },
  { name: 'aikayun_migrator' as const, canLogin: false },
] })
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-backup-journal-'))) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('backup maintenance journal', () => {
  it('durably records exact prior service state and enforces sequential transitions', async () => {
    expect(await readMaintenanceJournal(directory)).toBeNull()
    const initial = await createMaintenanceJournal(directory, input())
    expect(await readMaintenanceJournal(directory)).toEqual(initial)
    expect(initial.services.map(service => service.running)).toEqual([true, false])
    expect(initial.roles.map(role => role.canLogin)).toEqual([true, false])
    await expect(createMaintenanceJournal(directory, input())).rejects.toThrow('already exists')
    await expect(advanceMaintenanceJournal(directory, initial, 'stopped')).rejects.toThrow('transition')
    const stopping = await advanceMaintenanceJournal(directory, initial, 'stopping')
    await expect(advanceMaintenanceJournal(directory, initial, 'stopping')).rejects.toThrow('changed')
    const stopped = await advanceMaintenanceJournal(directory, stopping, 'stopped')
    const captured = await advanceMaintenanceJournal(directory, stopped, 'captured')
    const restoring = await advanceMaintenanceJournal(directory, captured, 'restoring')
    const complete = await advanceMaintenanceJournal(directory, restoring, 'complete')
    expect(await readMaintenanceJournal(directory)).toEqual(complete)
  })
  it('rejects symlinks, malformed records, hardlinks and unsafe directory permissions', async () => {
    const file = join(directory, 'backup-maintenance.json')
    await writeFile(join(directory, 'target'), '{}', { mode: 0o600 })
    await symlink('target', file)
    await expect(readMaintenanceJournal(directory)).rejects.toThrow()
    await expect(createMaintenanceJournal(directory, input())).rejects.toThrow()
    await rm(file)
    await writeFile(file, '{"unexpected":"secret"}', { mode: 0o600 })
    await expect(readMaintenanceJournal(directory)).rejects.toThrow()
    await rm(file)
    await createMaintenanceJournal(directory, input())
    await link(file, join(directory, 'hardlink'))
    await expect(readMaintenanceJournal(directory)).rejects.toThrow('Unsafe')
    await rm(join(directory, 'hardlink'))
    await chmod(directory, 0o755)
    await expect(readMaintenanceJournal(directory)).rejects.toThrow('Unsafe')
    await chmod(directory, 0o700)
    expect(JSON.parse(await readFile(file, 'utf8')).phase).toBe('prepared')
  })
  it('rejects invalid deployment or duplicate container identity', async () => {
    const invalid = input()
    invalid.services.push(invalid.services[0]!)
    await expect(createMaintenanceJournal(directory, invalid)).rejects.toThrow('Invalid')
    expect(await readMaintenanceJournal(directory)).toBeNull()
    await expect(createMaintenanceJournal(directory, { ...input(), deployment: '../bad' })).rejects.toThrow('Invalid')
  })
  it('records recovery after an interrupted stop without claiming a captured backup', async () => {
    const prepared = await createMaintenanceJournal(directory, input())
    const stopping = await advanceMaintenanceJournal(directory, prepared, 'stopping')
    const restoring = await advanceMaintenanceJournal(directory, stopping, 'restoring')
    expect((await readMaintenanceJournal(directory))?.phase).toBe('restoring')
    expect((await advanceMaintenanceJournal(directory, restoring, 'complete')).phase).toBe('complete')
  })
  it('fails closed on an orphaned write, including before initial creation', async () => {
    const orphan = join(directory, '.backup-maintenance-1234.tmp')
    await writeFile(orphan, 'partial', { mode: 0o600 })
    await expect(readMaintenanceJournal(directory)).rejects.toThrow('requires inspection')
    await expect(createMaintenanceJournal(directory, input())).rejects.toThrow('requires inspection')
    await rm(orphan)
    const prepared = await createMaintenanceJournal(directory, input())
    await writeFile(orphan, 'partial', { mode: 0o600 })
    await expect(advanceMaintenanceJournal(directory, prepared, 'stopping')).rejects.toThrow('requires inspection')
    await rm(orphan)
    expect(await readMaintenanceJournal(directory)).toEqual(prepared)
  })
  it('rejects missing, duplicate or unrecognized role snapshots', async () => {
    const invalid = input()
    invalid.roles[1] = { ...invalid.roles[0]! }
    await expect(createMaintenanceJournal(directory, invalid)).rejects.toThrow('Invalid')
    expect(await readMaintenanceJournal(directory)).toBeNull()
  })
  it('archives a complete record durably without overwriting history, then permits a new set', async () => {
    const first = await createMaintenanceJournal(directory, input())
    await expect(archiveCompletedMaintenanceJournal(directory, first, async () => {})).rejects.toThrow('not complete')
    const restoring = await advanceMaintenanceJournal(directory, first, 'restoring')
    const complete = await advanceMaintenanceJournal(directory, restoring, 'complete')
    const archive = join(directory, `backup-maintenance-${complete.backupSetId}.complete.json`)
    await writeFile(archive, '{}', { mode: 0o600 })
    await expect(archiveCompletedMaintenanceJournal(directory, complete, async () => {})).rejects.toThrow()
    expect(await readFile(archive, 'utf8')).toBe('{}')
    expect(await readMaintenanceJournal(directory)).toEqual(complete)
    await rm(archive)
    await archiveCompletedMaintenanceJournal(directory, complete, async () => {})
    expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual(complete)
    expect(await readMaintenanceJournal(directory)).toBeNull()
    await expect(createMaintenanceJournal(directory, { ...input(), backupSetId: complete.backupSetId })).rejects.toThrow('already exists')
    expect((await createMaintenanceJournal(directory, input())).backupSetId).not.toBe(complete.backupSetId)
  })
  it('can resume retirement when the archive was installed before a lock failure', async () => {
    const first = await createMaintenanceJournal(directory, input())
    const restoring = await advanceMaintenanceJournal(directory, first, 'restoring')
    const complete = await advanceMaintenanceJournal(directory, restoring, 'complete')
    let locks = 0
    await expect(archiveCompletedMaintenanceJournal(directory, complete, async () => {
      if (++locks === 3) throw new Error('lock lost')
    })).rejects.toThrow('lock lost')
    expect(await readMaintenanceJournal(directory)).toEqual(complete)
    const archive = join(directory, `backup-maintenance-${complete.backupSetId}.complete.json`)
    expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual(complete)
    await archiveCompletedMaintenanceJournal(directory, complete, async () => {})
    expect(await readMaintenanceJournal(directory)).toBeNull()
  })
  it('refuses an archive symlink and preserves the active journal', async () => {
    const prepared = await createMaintenanceJournal(directory, input())
    const restoring = await advanceMaintenanceJournal(directory, prepared, 'restoring')
    const complete = await advanceMaintenanceJournal(directory, restoring, 'complete')
    const archive = join(directory, `backup-maintenance-${complete.backupSetId}.complete.json`)
    await symlink('backup-maintenance.json', archive)
    await expect(archiveCompletedMaintenanceJournal(directory, complete, async () => {})).rejects.toThrow()
    expect(await readMaintenanceJournal(directory)).toEqual(complete)
  })
})
