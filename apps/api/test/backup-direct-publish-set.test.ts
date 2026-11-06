import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DirectUnpublishedBackupSet } from '../src/backup/direct-capture-set.js'
import type { LocalResticRepository } from '../src/backup/restic-local.js'

const mocks = vi.hoisted(() => ({ readSnapshotFile: vi.fn(), verifyDirectSourceSnapshot: vi.fn() }))
vi.mock('../src/backup/direct-source-inspection.js', () => mocks)

import { publishDirectCapturedSet, readDirectPublicationRecord, verifyDirectPublishedSet } from '../src/backup/direct-publish-set.js'
import { advanceMaintenanceJournal, createMaintenanceJournal } from '../src/backup/journal.js'

const digest = (value: string) => value.repeat(64).slice(0, 64)
const trustBundle = { status: 'uninitialized' as const, bundleVersion: null, artifactSha256: null, stateDigest: null,
  revokedKeyCount: 0, retiredKeyCount: 0 }
let root: string, staging: string, manifest: string, scratch: string, journal: string, publication: string
let set: string, staged: DirectUnpublishedBackupSet, repository: LocalResticRepository
let sourceId: string, manifestId: string, manifestSnapshotTime: string
let failManifestUpload: boolean
const fixtureBytes = Buffer.from('PGDMP-paired-fixture')
const noop = async () => {}

beforeEach(async () => {
  mocks.readSnapshotFile.mockReset()
  mocks.verifyDirectSourceSnapshot.mockReset()
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-direct-publish-')))
  staging = join(root, 'payload'); manifest = join(root, 'manifest'); scratch = join(root, 'scratch')
  journal = join(root, 'journal'); publication = join(root, 'publication')
  for (const path of [staging, manifest, scratch, journal, publication]) await mkdir(path, { mode: 0o700 })
  await writeFile(join(staging, 'database.dump'), fixtureBytes, { mode: 0o600 })
  set = randomUUID(); sourceId = digest('a'); manifestId = digest('b'); failManifestUpload = false
  manifestSnapshotTime = new Date().toISOString()
  const createdAt = new Date(Date.now() - 10_000).toISOString()
  const quiescedAt = new Date(Date.now() - 7_000).toISOString()
  staged = { backupSetId: set, createdAt, quiescedAt, sourceSnapshotId: sourceId,
    pgDumpVersion: '18.6', databaseDump: { size: fixtureBytes.length,
      sha256: (await import('node:crypto')).createHash('sha256').update(fixtureBytes).digest('hex') },
    evidence: { database: { databaseId: randomUUID(), instanceId: randomUUID(), identityJkt: digest('c').slice(0, 43),
      pendingKeyId: 'pending-1', pendingKeySha256: digest('d'), migrationHead: 'fixture-migration',
      migrationChecksumsSha256: digest('e') }, identityFileSha256: digest('f'),
    keys: { paymentKeyIds: ['pay-1'], deliveryKeyIds: ['delivery-1'], paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [],
      paymentActiveKeyId: 'pay-1', deliveryActiveKeyId: 'delivery-1', paymentKeyDigests: { 'pay-1': digest('1') },
      deliveryKeyDigests: { 'delivery-1': digest('2') }, contentVerification: 'not_verified' }, trustBundle,
    unresolved: { paymentAttemptsPending: 0, paymentRequests: 0, paymentUnknown: 0, paymentReconciliationCases: 0,
      refundsPending: 0, refundAttemptsUncertain: 0, withdrawalsPending: 0, withdrawalAttemptsUncertain: 0,
      fulfillmentAttemptsUnfinished: 0, deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0 } } }
  const initial = await createMaintenanceJournal(journal, { deployment: digest('9'), backupSetId: set,
    services: [{ name: 'api', containerId: digest('3'), running: true }],
    roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: false }] })
  const restoring = await advanceMaintenanceJournal(journal, initial, 'restoring')
  await advanceMaintenanceJournal(journal, restoring, 'complete')
  mocks.readSnapshotFile.mockImplementation(async () => readFile(join(manifest, 'manifest.json')))
  mocks.verifyDirectSourceSnapshot.mockResolvedValue({ identityFileSha256: staged.evidence.identityFileSha256, trustBundle })
  const sourceRecord = { id: sourceId, time: quiescedAt, paths: ['/sources/caddy-config', '/sources/caddy-data', '/sources/deployment',
    '/sources/staging/payload', '/sources/state'], tags: [`aikayun-set-${set}`, 'aikayun-role-source'] }
  const restic = {
    assertSeparatedStorage: vi.fn(noop),
    backupRole: vi.fn(async () => {
      if (failManifestUpload) throw new Error('injected restic failure')
      const parsed = JSON.parse(await readFile(join(manifest, 'manifest.json'), 'utf8')) as { completed_at: string }
      manifestSnapshotTime = new Date(Date.parse(parsed.completed_at) + 1000).toISOString()
      return manifestId
    }),
    check: vi.fn(noop),
    snapshotMetadata: vi.fn(async () => [sourceRecord, { id: manifestId, time: manifestSnapshotTime,
      paths: [manifest], tags: [`aikayun-set-${set}`, 'aikayun-role-manifest'] }]),
    listSnapshot: vi.fn(async () => {
      const bytes = await readFile(join(manifest, 'manifest.json'))
      return `${JSON.stringify({ struct_type: 'node', path: join(manifest, 'manifest.json'), type: 'file',
        uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1,
        mode: 0o600, size: bytes.length, inode: 10 })}\n`
    }),
  }
  repository = restic as unknown as LocalResticRepository
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const input = () => ({ staged, stagingDirectory: staging, manifestDirectory: manifest, scratchDirectory: scratch,
  journalDirectory: journal, publicationDirectory: publication, repository, releaseId: 'fixture-release', resticVersion: '0.19.1',
  images: { api: `sha256:${digest('a')}`, web: `sha256:${digest('b')}`, postgres: `sha256:${digest('c')}`, caddy: `sha256:${digest('d')}` },
  assertLock: noop, assertSecureStorage: noop, assertRestoredAndRelease: noop, verifyDumpBinding: noop,
  inspectTrustStorePersistedReadOnly: async () => trustBundle })

describe('direct paired Restic publication', () => {
  it('publishes a small manifest snapshot after the source and verifies the exact pair', async () => {
    const published = await publishDirectCapturedSet(input())
    expect(published).toEqual({ snapshotId: manifestId, sourceSnapshotId: sourceId, status: 'verified' })
    expect(await readDirectPublicationRecord(publication, set)).toEqual({ sourceSnapshot: sourceId, manifestSnapshot: manifestId })
    expect(restoredRecord()).toMatchObject({ schema: 2, state: 'verified', source_snapshot: sourceId, manifest_snapshot: manifestId })
    const checked = await verifyDirectPublishedSet({ backupSetId: set, publicationDirectory: publication, manifestDirectory: manifest,
      scratchDirectory: scratch, repository, assertLock: noop, assertSecureStorage: noop,
      inspectTrustStoreReadOnly: async () => trustBundle, assertAuthenticatedManifest: async value => {
        expect(value.release_id).toBe('fixture-release')
      } })
    expect(checked).toMatchObject({ snapshotId: manifestId, sourceSnapshotId: sourceId, status: 'verified',
      manifest: { source_snapshot_id: sourceId, database_dump: staged.databaseDump } })
    expect(repository.backupRole).toHaveBeenCalledWith(manifest, set, 'manifest')
    expect(repository.check).toHaveBeenCalledTimes(2)
    expect(mocks.verifyDirectSourceSnapshot).toHaveBeenCalledTimes(2)
  })

  it('leaves an uploading record when Restic publication outcome is not successful', async () => {
    failManifestUpload = true
    await expect(publishDirectCapturedSet(input())).rejects.toThrow('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
    expect(await readDirectPublicationRecord(publication, set)).toBeNull()
    expect(restoredRecord()).toMatchObject({ schema: 2, state: 'uploading', source_snapshot: sourceId })
    await expect(verifyDirectPublishedSet({ backupSetId: set, publicationDirectory: publication, manifestDirectory: manifest,
      scratchDirectory: scratch, repository, assertLock: noop, assertSecureStorage: noop,
      inspectTrustStoreReadOnly: async () => trustBundle })).rejects.toThrow('BACKUP_PUBLICATION_NOT_VERIFIED')
  })
})

function restoredRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(publication, `${set}.json`), 'utf8')) as Record<string, unknown>
}
