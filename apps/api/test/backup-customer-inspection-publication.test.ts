import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectCustomerBackup, listCustomerBackups, type CustomerBackupInspectionConfig } from '../src/backup/customer-inspection.js'
import type { LocalResticRepository } from '../src/backup/restic-local.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('the real publication verifier rejects absent, uploading and tampered marker records without exposing paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-customer-publication-')))
  roots.push(root)
  const publicationDirectory = join(root, 'publication'), scratchParent = join(root, 'scratch')
  await mkdir(publicationDirectory, { mode: 0o700 }); await mkdir(scratchParent, { mode: 0o700 })
  const set = randomUUID(), id = 'a'.repeat(64)
  const repository = { allSnapshotMetadata: async () => [{ id, tags: [`aikayun-set-${set}`], paths: ['/customer/private'] }], assertSeparatedStorage: async () => {},
    check: async () => { throw new Error('fixture check must not run') } } as unknown as LocalResticRepository
  const config: CustomerBackupInspectionConfig = { publicationDirectory, scratchParent, repository, tarBinary: '/usr/bin/tar', maxExtractBytes: 1024,
    pgDumpTarget: { dockerBinary: '/usr/bin/docker', dockerSocket: '/run/docker.sock', containerId: id, database: 'aikayun',
      user: 'aikayun_bootstrap', assertSecureStaging: async () => {} }, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, assertBackupMetadata: async () => {}, assertBackupRelease: async () => {}, assertLock: async () => {} }
  const missing = await listCustomerBackups(config, { limit: 1 })
  expect(missing.items).toEqual([])
  expect(missing.untrackedSnapshots).toBe(1)
  await writeFile(join(publicationDirectory, `${set}.json`), JSON.stringify({ schema: 1, set, state: 'uploading' }), { mode: 0o600 })
  expect((await listCustomerBackups(config, { limit: 1 })).items).toEqual([{ backupSetId: set, status: 'needs_attention' }])
  expect((await inspectCustomerBackup(config, set)).status).toBe('needs_attention')
  await writeFile(join(publicationDirectory, `${set}.json`), '{tampered')
  const damaged = await inspectCustomerBackup(config, set)
  expect(damaged.status).toBe('needs_attention')
  expect(JSON.stringify([missing, damaged])).not.toContain('/customer/private')
})

it('a verified marker cannot hide a snapshot missing an archive', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-customer-missing-')))
  roots.push(root)
  const publicationDirectory = join(root, 'publication'), scratchParent = join(root, 'scratch')
  await mkdir(publicationDirectory, { mode: 0o700 }); await mkdir(scratchParent, { mode: 0o700 })
  const set = randomUUID(), id = 'b'.repeat(64)
  await writeFile(join(publicationDirectory, `${set}.json`), JSON.stringify({ schema: 1, set, state: 'verified', snapshot: id }), { mode: 0o600 })
  const repository = { assertSeparatedStorage: async () => {}, check: async () => {}, validateExtractionParent: async () => {},
    allSnapshotMetadata: async () => [{ id, tags: [`aikayun-set-${set}`] }],
    snapshotMetadata: async () => [{ id, tags: [`aikayun-set-${set}`], paths: ['/private/fixture'] }],
    listSnapshot: async () => ['manifest.json', 'database.dump', 'state.tar', 'deployment.tar', 'caddy-data.tar']
      .map(name => JSON.stringify({ struct_type: 'node', path: `/private/fixture/${name}`, type: 'file', size: 10 })).join('\n'),
  } as unknown as LocalResticRepository
  const config: CustomerBackupInspectionConfig = { publicationDirectory, scratchParent, repository, tarBinary: '/usr/bin/tar', maxExtractBytes: 1024,
    pgDumpTarget: { dockerBinary: '/usr/bin/docker', dockerSocket: '/run/docker.sock', containerId: id, database: 'aikayun',
      user: 'aikayun_bootstrap', assertSecureStaging: async () => {} }, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, assertBackupMetadata: async () => {}, assertBackupRelease: async () => {}, assertLock: async () => {} }
  expect((await listCustomerBackups(config, { limit: 1 })).items).toEqual([{ backupSetId: set, status: 'not_checked' }])
  expect(await inspectCustomerBackup(config, set)).toEqual({ backupSetId: set, status: 'needs_attention', createdAt: null, releaseId: null })
})
