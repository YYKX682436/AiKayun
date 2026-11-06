import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectCustomerBackup, listCustomerBackups, type CustomerBackupInspectionConfig } from '../src/backup/customer-inspection.js'
import { verifyPublishedSnapshot } from '../src/backup/publish-set.js'
import { verifyPostgresDumpBinding } from '../src/backup/pg-dump.js'
import type { LocalResticRepository } from '../src/backup/restic-local.js'

vi.mock('../src/backup/pg-dump.js', () => ({ verifyPostgresDumpBinding: vi.fn(async () => {}) }))
vi.mock('../src/backup/publish-set.js', () => ({ readVerifiedPublicationRecord: vi.fn(async (directory, set) => {
  const { readFile } = await import('node:fs/promises')
  const record = JSON.parse(await readFile(join(directory, `${set}.json`), 'utf8'))
  if (record.state !== 'verified' || record.set !== set || typeof record.snapshot !== 'string') throw new Error('invalid')
  return record.snapshot
}), verifyPublishedSnapshot: vi.fn(async input => {
  if (input.backupSetId === '00000000-0000-4000-8000-000000000001') throw new Error('private-sensitive-error-marker')
  await input.assertAuthenticatedManifest({ release_id: 'fixture', images: {} })
  await input.verifyDumpBinding('/fixture', { databaseId: 'fixture' })
  return { status: 'verified', snapshotId: 'a'.repeat(64), manifest: { status: 'candidate', backup_set_id: input.backupSetId,
    created_at: '2026-11-04T00:00:00.000Z', release_id: 'aikayun-1.0.0',
    identity_jkt: 'private-identity', key_material_proofs: { payment: 'private-key-fingerprint' } } }
}) }))

const roots: string[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-customer-inspect-')))
  roots.push(root)
  const publicationDirectory = join(root, 'publications'), scratchParent = join(root, 'scratch')
  await mkdir(publicationDirectory, { mode: 0o700 }); await mkdir(scratchParent, { mode: 0o700 })
  const snapshots: unknown[] = []
  const repository = { allSnapshotMetadata: vi.fn(async () => snapshots), assertSeparatedStorage: async () => {} } as unknown as LocalResticRepository
  const config: CustomerBackupInspectionConfig = { publicationDirectory, scratchParent, tarBinary: '/usr/bin/tar', repository,
    maxExtractBytes: 1024, pgDumpTarget: { dockerBinary: '/usr/bin/docker', dockerSocket: '/run/docker.sock', containerId: 'a'.repeat(64),
      database: 'aikayun', user: 'aikayun_bootstrap', assertSecureStaging: async () => {} },
    assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, assertBackupMetadata: async () => {}, assertBackupRelease: async () => {}, assertLock: async () => {} }
  return { config, snapshots }
}

it('exposes only whitelisted fields after full verification with the real dump verifier dependency', async () => {
  const { config } = await fixture(), set = randomUUID()
  const result = await inspectCustomerBackup(config, set)
  expect(result).toEqual({ backupSetId: set, status: 'verified', createdAt: '2026-11-04T00:00:00.000Z', releaseId: 'aikayun-1.0.0' })
  expect(JSON.stringify(result)).not.toMatch(/private-|fingerprint|identity/)
  expect(verifyPostgresDumpBinding).toHaveBeenCalledWith(expect.objectContaining({ stagingDirectory: '/fixture' }), expect.objectContaining({ databaseId: 'fixture' }))
})

it('treats failed, missing, changed or wrong-password checks as unknown without exposing the error', async () => {
  const { config } = await fixture(), set = '00000000-0000-4000-8000-000000000001'
  const result = await inspectCustomerBackup(config, set)
  expect(result).toEqual({ backupSetId: set, status: 'needs_attention', createdAt: null, releaseId: null })
  expect(JSON.stringify(result)).not.toContain('private-sensitive')
  vi.mocked(verifyPublishedSnapshot).mockRejectedValueOnce(new Error('wrong password token /private/path'))
  expect((await inspectCustomerBackup(config, randomUUID())).status).toBe('needs_attention')
})

it('does not report verified when authenticated DB or release metadata do not match', async () => {
  const { config } = await fixture()
  config.assertBackupMetadata = async () => { throw new Error('private identity mismatch') }
  const result = await inspectCustomerBackup(config, randomUUID())
  expect(result).toMatchObject({ status: 'needs_attention', createdAt: null, releaseId: null })
  expect(JSON.stringify(result)).not.toContain('private identity')
})

it('does not report verified when the saved release or image is not authenticated', async () => {
  const { config } = await fixture()
  config.assertBackupRelease = async () => { throw new Error('private release mismatch') }
  const result = await inspectCustomerBackup(config, randomUUID())
  expect(result).toMatchObject({ status: 'needs_attention', createdAt: null, releaseId: null })
  expect(JSON.stringify(result)).not.toContain('private release')
})

it('paginates metadata without claiming verification and conservatively flags untracked evidence', async () => {
  const { config, snapshots } = await fixture()
  const first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002'
  await writeFile(join(config.publicationDirectory, `${first}.json`), 'untrusted-file')
  await writeFile(join(config.publicationDirectory, `${second}.json`), JSON.stringify({ schema: 1, set: second, state: 'verified', snapshot: 'a'.repeat(64) }), { mode: 0o600 })
  await writeFile(join(config.publicationDirectory, 'private-invalid-marker'), '')
  snapshots.push({ id: 'a'.repeat(64), tags: [`aikayun-set-${second}`], paths: ['/secret/private/path'] }, { id: 'b'.repeat(64) })
  const page1 = await listCustomerBackups(config, { limit: 1 })
  expect(page1).toEqual({ items: [{ backupSetId: first, status: 'needs_attention' }],
    nextAfter: first, revision: expect.stringMatching(/^[a-f0-9]{64}$/), unknownRecords: true, untrackedSnapshots: 1 })
  const page2 = await listCustomerBackups(config, { limit: 1, after: first, revision: page1.revision })
  expect(page2.items).toEqual([{ backupSetId: second, status: 'not_checked' }])
  expect(page2.nextAfter).toBeNull()
  expect(JSON.stringify([page1, page2])).not.toMatch(/private-invalid-marker|private\/path|fingerprint/)
  expect(verifyPublishedSnapshot).not.toHaveBeenCalled()
  await expect(listCustomerBackups(config, { limit: 11 })).rejects.toThrow('BACKUP_INSPECTION_ARGUMENT_INVALID')
  await expect(listCustomerBackups(config, { limit: 1, after: first })).rejects.toThrow('BACKUP_INSPECTION_ARGUMENT_INVALID')
  snapshots.push({ id: 'c'.repeat(64), tags: [`aikayun-set-${randomUUID()}`] })
  await expect(listCustomerBackups(config, { limit: 1, after: first, revision: page1.revision })).rejects.toThrow('BACKUP_LIST_CHANGED')
})

it('does not disguise repository or lock failure as a healthy empty list', async () => {
  const { config } = await fixture()
  vi.mocked(config.repository.allSnapshotMetadata).mockRejectedValueOnce(new Error('password /private/path'))
  await expect(listCustomerBackups(config, { limit: 1 })).rejects.toThrow('BACKUP_LIST_UNAVAILABLE')
  config.assertLock = async () => { throw new Error('lock lost') }
  await expect(inspectCustomerBackup(config, randomUUID())).rejects.toThrow('BACKUP_INSPECTION_LOCK_UNVERIFIED')
})

it('does not return a partial page when the deployment lock is lost during listing', async () => {
  const { config, snapshots } = await fixture()
  for (const set of ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']) {
    snapshots.push({ id: set === '00000000-0000-4000-8000-000000000002' ? 'a'.repeat(64) : 'b'.repeat(64), tags: [`aikayun-set-${set}`] })
  }
  let calls = 0
  config.assertLock = async () => { if (++calls >= 2) throw new Error('private lock detail') }
  await expect(listCustomerBackups(config, { limit: 2 })).rejects.toThrow('BACKUP_INSPECTION_LOCK_UNVERIFIED')
})

it('sanitizes missing directories and lock errors without leaking private paths', async () => {
  const { config } = await fixture()
  const path = join(config.publicationDirectory, 'private-customer-marker')
  const error = await listCustomerBackups({ ...config, publicationDirectory: path }, { limit: 1 }).catch(error => error as Error)
  expect((error as Error).message).toBe('BACKUP_LIST_UNAVAILABLE')
  expect(String((error as Error).stack)).not.toContain('private-customer-marker')
  config.assertLock = async () => { throw new Error('private-customer-marker') }
  const lock = await inspectCustomerBackup(config, randomUUID()).catch(error => error as Error)
  expect((lock as Error).message).toBe('BACKUP_INSPECTION_LOCK_UNVERIFIED')
  expect(String((lock as Error).stack)).not.toContain('private-customer-marker')
})
