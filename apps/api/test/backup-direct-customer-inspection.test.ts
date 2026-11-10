import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectCustomerBackups } from '../src/backup/direct-customer-inspection.js'
import type { LocalResticRepository } from '../src/backup/restic-local.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('direct backup pair listing', () => {
  it('marks a matching source/manifest publication as not checked', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-direct-list-'))); roots.push(root)
    const publicationDirectory = join(root, 'publications'), scratchDirectory = join(root, 'scratch')
    await mkdir(publicationDirectory, { mode: 0o700 }); await mkdir(scratchDirectory, { mode: 0o700 })
    const set = randomUUID(), source = 'a'.repeat(64), manifest = 'b'.repeat(64)
    await writeFile(join(publicationDirectory, `${set}.json`), `${JSON.stringify({ schema: 2, set, state: 'verified',
      source_snapshot: source, manifest_snapshot: manifest })}\n`, { mode: 0o600 })
    const records = [
      { id: source, tags: [`aikayun-set-${set}`, 'aikayun-role-source'] },
      { id: manifest, tags: [`aikayun-set-${set}`, 'aikayun-role-manifest'] },
    ]
    const repository = { assertSeparatedStorage: async () => {}, allSnapshotMetadata: async () => records } as unknown as LocalResticRepository
    const config = { publicationDirectory, scratchDirectory, repository, assertLock: async () => {}, assertSecureStorage: async () => {},
      manifestDirectory: (value: string) => join(root, 'staging', value),
      inspectTrustStoreReadOnly: async () => ({ status: 'uninitialized' as const, bundleVersion: null, artifactSha256: null, stateDigest: null,
        revokedKeyCount: 0, retiredKeyCount: 0 }),
      assertAuthenticatedManifest: async () => {} }
    const result = await listDirectCustomerBackups(config, { limit: 10 })
    expect(result.items).toEqual([{ backupSetId: set, status: 'not_checked' }])
    expect(result.untrackedSnapshots).toBe(0)
  })
  it('requires attention for incomplete or mismatched snapshot pairs', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-direct-list-'))); roots.push(root)
    const publicationDirectory = join(root, 'publications'), scratchDirectory = join(root, 'scratch')
    await mkdir(publicationDirectory, { mode: 0o700 }); await mkdir(scratchDirectory, { mode: 0o700 })
    const set = randomUUID(), source = 'a'.repeat(64), manifest = 'b'.repeat(64)
    await writeFile(join(publicationDirectory, `${set}.json`), `${JSON.stringify({ schema: 2, set, state: 'uploading', source_snapshot: source })}\n`, { mode: 0o600 })
    const repository = { assertSeparatedStorage: async () => {}, allSnapshotMetadata: async () => [
      { id: source, tags: [`aikayun-set-${set}`, 'aikayun-role-source'] },
      { id: manifest, tags: [`aikayun-set-${set}`, 'aikayun-role-manifest'] },
      { id: 'c'.repeat(64), tags: ['aikayun-set-untracked', 'aikayun-role-source'] },
    ] } as unknown as LocalResticRepository
    const result = await listDirectCustomerBackups({ publicationDirectory, scratchDirectory, repository, assertLock: async () => {},
      manifestDirectory: value => join(root, 'staging', value), assertSecureStorage: async () => {}, inspectTrustStoreReadOnly: async () => ({
        status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 }),
      assertAuthenticatedManifest: async () => {} }, { limit: 10 })
    expect(result.items).toEqual([{ backupSetId: set, status: 'needs_attention' }])
    expect(result.untrackedSnapshots).toBe(1)
  })

  it('keeps a fixed Restic operation code when list hides command output', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-direct-list-'))); roots.push(root)
    const publicationDirectory = join(root, 'publications'), scratchDirectory = join(root, 'scratch')
    await mkdir(publicationDirectory, { mode: 0o700 }); await mkdir(scratchDirectory, { mode: 0o700 })
    const failure = new Error('RESTIC_COMMAND_FAILED')
    Object.defineProperty(failure, 'operationCode', { value: 'RESTIC_SNAPSHOTS_FAILED' })
    const repository = { assertSeparatedStorage: async () => {}, allSnapshotMetadata: async () => { throw failure } } as unknown as LocalResticRepository
    await expect(listDirectCustomerBackups({ publicationDirectory, scratchDirectory, repository, assertLock: async () => {},
      manifestDirectory: value => join(root, 'staging', value), assertSecureStorage: async () => {},
      inspectTrustStoreReadOnly: async () => ({ status: 'uninitialized' as const, bundleVersion: null, artifactSha256: null,
        stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 }), assertAuthenticatedManifest: async () => {} },
    { limit: 10 })).rejects.toThrow('RESTIC_SNAPSHOTS_FAILED')
  })
})
