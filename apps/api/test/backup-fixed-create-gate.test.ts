import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaintenanceJournal, advanceMaintenanceJournal } from '../src/backup/journal.js'
import { assertNoUncertainBackupState } from '../src/backup/fixed-create-gate.js'
import type { LocalResticRepository } from '../src/backup/restic-local.js'

let root: string, repositoryDirectory: string, journalDirectory: string, publicationDirectory: string, mountRoot: string
let snapshots: unknown[]
const snapshot = 'a'.repeat(64)
const manifestSnapshot = 'c'.repeat(64)
const pairedSnapshots = (set: string, source = snapshot, manifest = manifestSnapshot) => [
  { id: source, tags: [`aikayun-set-${set}`, 'aikayun-role-source'] },
  { id: manifest, tags: [`aikayun-set-${set}`, 'aikayun-role-manifest'] },
]
const assertLock = vi.fn(async () => {})
const repository = { assertRepositoryPath: vi.fn(async () => {}), repositoryIdentity: vi.fn(async () => 'b'.repeat(64)), assertSeparatedStorage: vi.fn(async () => {}), allSnapshotMetadata: vi.fn(async () => snapshots) } as unknown as LocalResticRepository
const input = () => ({ repositoryDirectory, journalDirectory, publicationDirectory, mountRoot, repository, assertLock })
beforeEach(async () => {
  vi.clearAllMocks(); snapshots = []
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-create-gate-')))
  repositoryDirectory = join(root, 'repo'); journalDirectory = join(root, 'journal'); publicationDirectory = join(root, 'publication'); mountRoot = join(root, 'stage')
  for (const dir of [repositoryDirectory, journalDirectory, publicationDirectory, mountRoot]) await mkdir(dir, { mode: 0o700 })
  await writeFile(join(journalDirectory, 'repository-initialization.json'), JSON.stringify({ schema: 1, state: 'verified', repositoryId: 'b'.repeat(64) }), { mode: 0o600 })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('new backup uncertainty gate', () => {
  it('accepts an empty repository and previously verified source/manifest pairs', async () => {
    await expect(assertNoUncertainBackupState(input())).resolves.toBeUndefined()
    const set = randomUUID()
    await writeFile(join(publicationDirectory, `${set}.json`), JSON.stringify({ schema: 2, set, state: 'verified',
      source_snapshot: snapshot, manifest_snapshot: manifestSnapshot }), { mode: 0o600 })
    snapshots = pairedSnapshots(set)
    await expect(assertNoUncertainBackupState(input())).resolves.toBeUndefined()
  })
  it('blocks an ambiguous prior upload even when a new create would generate a different ID', async () => {
    const set = randomUUID()
    await writeFile(join(publicationDirectory, `${set}.json`), JSON.stringify({ schema: 2, set, state: 'uploading', source_snapshot: snapshot }), { mode: 0o600 })
    snapshots = [{ id: snapshot, tags: [`aikayun-set-${set}`, 'aikayun-role-source'] }]
    await expect(assertNoUncertainBackupState(input())).rejects.toThrow('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
  })
  it('rejects unknown, missing, duplicate and mismatched snapshot evidence', async () => {
    const set = randomUUID()
    await writeFile(join(publicationDirectory, `${set}.json`), JSON.stringify({ schema: 2, set, state: 'verified',
      source_snapshot: snapshot, manifest_snapshot: manifestSnapshot }), { mode: 0o600 })
    for (const records of [[], [{ id: 'b'.repeat(64), tags: [`aikayun-set-${set}`, 'aikayun-role-source'] }],
      [{ id: snapshot, tags: [`aikayun-set-${set}`, 'aikayun-role-source'] }, { id: snapshot, tags: [`aikayun-set-${set}`, 'aikayun-role-source'] }],
      [{ id: snapshot, tags: ['unrelated'] }, { id: manifestSnapshot, tags: ['unrelated'] }]]) {
      snapshots = records
      await expect(assertNoUncertainBackupState(input())).rejects.toThrow('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
    }
  })
  it('rejects incomplete maintenance, leftover staging, unknown records and lock loss', async () => {
    const set = randomUUID()
    const journal = await createMaintenanceJournal(journalDirectory, { backupSetId: set, deployment: 'b'.repeat(64), services: [],
      roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: true }] })
    await expect(assertNoUncertainBackupState(input())).rejects.toThrow('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
    const restoring = await advanceMaintenanceJournal(journalDirectory, journal, 'restoring')
    await advanceMaintenanceJournal(journalDirectory, restoring, 'complete')
    await writeFile(join(mountRoot, 'unknown'), 'fixture')
    await expect(assertNoUncertainBackupState(input())).rejects.toThrow('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
    await rm(join(mountRoot, 'unknown'))
    await writeFile(join(publicationDirectory, '.uncertain.tmp'), 'fixture')
    await expect(assertNoUncertainBackupState(input())).rejects.toThrow('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
    await rm(join(publicationDirectory, '.uncertain.tmp'))
    assertLock.mockRejectedValueOnce(new Error('private lock detail'))
    const error = await assertNoUncertainBackupState(input()).catch(error => error as Error)
    expect(error.message).toBe('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
  })
})
