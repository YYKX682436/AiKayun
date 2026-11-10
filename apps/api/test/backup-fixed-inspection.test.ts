import { generateKeyPairSync } from 'node:crypto'
import { calculateJwkThumbprint } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'
const mocks = vi.hoisted(() => ({ source: vi.fn(), safeTree: vi.fn(), verifyRelease: vi.fn(), paths: vi.fn(), discover: vi.fn(), target: vi.fn(), metadata: vi.fn(), cleanupProof: vi.fn(),
  journal: vi.fn(), initialized: vi.fn(), list: vi.fn(), inspect: vi.fn(), available: vi.fn(), assertStage: vi.fn(), createStage: vi.fn(), removeStage: vi.fn() }))
vi.mock('../src/backup/direct-source-inspection.js', () => ({ assertSafeResticSnapshotTree: mocks.safeTree }))
vi.mock('../src/backup/host-operations.js', () => ({ verifyHostBackupRelease: mocks.verifyRelease }))
vi.mock('../src/backup/fixed-release-source.js', () => ({ loadFixedReleaseSource: mocks.source }))
vi.mock('../src/backup/fixed-backup-paths.js', () => ({ loadFixedBackupPaths: mocks.paths }))
vi.mock('../src/backup/fixed-discovery.js', () => ({ discoverFixedDeployment: mocks.discover }))
vi.mock('../src/backup/database-target.js', () => ({ withProvenProductionDatabaseTarget: mocks.target }))
vi.mock('../src/backup/database-metadata.js', () => ({ readBackupDatabaseMetadata: mocks.metadata }))
vi.mock('../src/backup/repository-initialization.js', () => ({ assertInitializedRepository: mocks.initialized }))
vi.mock('../src/backup/journal.js', () => ({ readMaintenanceJournal: mocks.journal }))
vi.mock('../src/backup/fixed-cleanup-proof.js', () => ({ assertNoFixedBackupWriters: mocks.cleanupProof }))
vi.mock('../src/backup/direct-customer-inspection.js', () => ({ listDirectCustomerBackups: mocks.list, inspectDirectCustomerBackup: mocks.inspect }))
vi.mock('../src/backup/tmpfs-staging.js', () => ({ assertNoSwapTmpfs: mocks.available, assertTmpfsStaging: mocks.assertStage,
  createTmpfsStaging: mocks.createStage, removeTmpfsStaging: mocks.removeStage }))
import { runFixedProductionInspection } from '../src/backup/fixed-inspection.js'

const set = '12345678-1234-4234-8234-123456789abc'
const current = { databaseId: 'database', instanceId: 'instance', identityJkt: 'identity', migrationHead: 'head', migrationChecksumsSha256: 'a'.repeat(64), pendingKeyId: 'pending', pendingKeySha256: 'b'.repeat(64) }
let locked = true, root = '', stage = ''
const host = { assertOwnedLock: vi.fn(async () => { if (!locked) throw new Error('lock lost') }), verifyDeployment: vi.fn(async () => {}) }
const bound = vi.fn(async () => { await host.assertOwnedLock() })
beforeEach(async () => {
  vi.resetAllMocks(); locked = true
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-inspection-state-')))
  stage = join(root, 'stage'); await mkdir(stage, { mode: 0o700 })
  host.assertOwnedLock.mockImplementation(async () => { if (!locked) throw new Error('lock lost') }); host.verifyDeployment.mockResolvedValue(undefined)
  bound.mockImplementation(async () => { await host.assertOwnedLock() })
  const release = { releaseId: 'fixture', images: { api: 'api-image', web: 'web-image', postgres: 'pg-image', caddy: 'caddy-image' },
    backupResticImage: `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'e'.repeat(64)}`, postgresImage: 'fixed-image',
    database: { engine_major: 18, migration_head: 'head', migration_checksums_sha256: 'a'.repeat(64) }, signedChecksums: Buffer.from('fixture'), compiledChecksums: Buffer.from('fixture') }
  mocks.source.mockResolvedValue({ fingerprint: 'c'.repeat(64), host, readAuthenticatedRelease: async () => release, databaseConfig: { host: 'db' } })
  mocks.paths.mockResolvedValue({ mountRoot: stage, journalDirectory: join(root, 'journal'), publicationDirectory: '/fixed/publications', minimumBytes: 256n, repository: {} })
  mocks.discover.mockResolvedValue({ databaseContainerId: 'd'.repeat(64) })
  mocks.target.mockImplementation(async (_input, callback) => callback({ db: 'pinned-fixture', assertBound: bound }))
  mocks.journal.mockResolvedValue(null); mocks.initialized.mockResolvedValue(undefined); mocks.metadata.mockResolvedValue(current); mocks.cleanupProof.mockResolvedValue(undefined); mocks.available.mockResolvedValue(1024n)
  mocks.createStage.mockResolvedValue('/fixed/staging/set-fixture'); mocks.assertStage.mockResolvedValue(undefined); mocks.removeStage.mockResolvedValue(undefined)
})
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('fixed internal backup inspection', () => {
  it('uses authenticated fixed authorities and lists without creating plaintext scratch', async () => {
    mocks.list.mockResolvedValue({ items: [], nextAfter: null, revision: 'f'.repeat(64), unknownRecords: false, untrackedSnapshots: 0 })
    const command = { mode: 'list' as const, limit: 3 }
    await expect(runFixedProductionInspection(command, new AbortController().signal)).resolves.toMatchObject({ items: [] })
    expect(mocks.target).toHaveBeenCalledWith(expect.objectContaining({
      database: 'aikayun', bootstrapUser: 'aikayun_bootstrap', containerId: 'd'.repeat(64), postgresImage: 'fixed-image' }), expect.any(Function))
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ publicationDirectory: '/fixed/publications', scratchDirectory: stage,
      manifestDirectory: expect.any(Function) }), command)
    expect(mocks.createStage).not.toHaveBeenCalled()
  })
  it('exposes incomplete maintenance and unexpected staging without claiming a verified backup', async () => {
    mocks.list.mockResolvedValue({ items: [], nextAfter: null, revision: 'f'.repeat(64), unknownRecords: false, untrackedSnapshots: 0 })
    mocks.journal.mockResolvedValueOnce({ backupSetId: set, phase: 'stopped', deployment: 'secret-fixture' })
    await writeFile(join(stage, 'set-fixture'), 'fixture')
    const result = await runFixedProductionInspection({ mode: 'list', limit: 1 }, new AbortController().signal)
    expect(result).toMatchObject({ maintenance: { backupSetId: set, state: 'needs_attention' }, stagingNeedsAttention: true })
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
    mocks.journal.mockResolvedValueOnce({ backupSetId: set, phase: 'complete' })
    const completed = await runFixedProductionInspection({ mode: 'list', limit: 1 }, new AbortController().signal)
    expect(completed).toMatchObject({ maintenance: { backupSetId: set, state: 'restoration_recorded' } })
  })
  it('does not verify a backup if repository initialization is unproven', async () => {
    mocks.initialized.mockRejectedValue(new Error('uncertain initialization'))
    await expect(runFixedProductionInspection({ mode: 'verify', set }, new AbortController().signal)).resolves.toEqual({ backupSetId: set, status: 'needs_attention', createdAt: null, releaseId: null })
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.createStage).not.toHaveBeenCalled()
    mocks.list.mockResolvedValue({ items: [], nextAfter: null, revision: 'f'.repeat(64), unknownRecords: false, untrackedSnapshots: 0 })
    await expect(runFixedProductionInspection({ mode: 'list', limit: 1 }, new AbortController().signal)).resolves.toMatchObject({ repositoryInitialization: 'needs_attention' })
  })
  it('authenticates historical release metadata using its source snapshot and keeps the live target bound', async () => {
    const snapshot = 'e'.repeat(64)
    const manifestSnapshotId = 'f'.repeat(64)
    const saved = { release_id: 'older-release', images: { api: 'old-api', web: 'old-web', postgres: 'old-pg', caddy: 'old-caddy' },
      database: { id: 'old-database', schema_head: 'old-head', migration_checksums_sha256: 'f'.repeat(64) },
      binding: { instance_id: 'old-instance', identity_jkt: 'old-identity', pending_key_sha256: 'd'.repeat(64) },
      key_ids: { pending: 'old-pending' } }
    const publicJwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
    mocks.verifyRelease.mockResolvedValue({
      schema_version: 1, trust_configuration_id: set, release_id: saved.release_id,
      expected_center_issuer: 'https://license.fixture.invalid', expected_center_origin: 'https://license.fixture.invalid',
      offline_root: { kid: await calculateJwkThumbprint(publicJwk), publicJwk }, minimum_bundle_version: '1',
    })
    mocks.inspect.mockImplementation(async (config, value, evidence) => {
      expect(await config.assertAuthenticatedManifest(saved, snapshot)).toBeTypeOf('function')
      await config.assertSecureStorage()
      return { backupSetId: value, status: 'verified', createdAt: '2026-11-05T00:00:00.000Z', releaseId: saved.release_id,
        ...(evidence ? { restoreEvidence: { sourceSnapshotId: snapshot, manifestSnapshotId } } : {}) }
    })
    mocks.removeStage.mockImplementation(async (options: { assertSafeCleanup(): Promise<void> }) => options.assertSafeCleanup())
    const signal = new AbortController().signal
    await expect(runFixedProductionInspection({ mode: 'verify', set }, signal)).resolves.toMatchObject({ status: 'verified', releaseId: saved.release_id })
    await expect(runFixedProductionInspection({ mode: 'restore-isolated', set }, signal)).resolves.toMatchObject({
      status: 'verified', restoreEvidence: { sourceSnapshotId: snapshot, manifestSnapshotId } })
    expect(mocks.safeTree).toHaveBeenCalledWith(expect.anything(), snapshot, '/sources/deployment/release')
    expect(mocks.verifyRelease).toHaveBeenCalledWith(snapshot, saved)
    expect(mocks.metadata).not.toHaveBeenCalled()
    expect(mocks.cleanupProof).toHaveBeenCalledWith('pinned-fixture')
    mocks.inspect.mockImplementationOnce(async config => config.assertAuthenticatedManifest(saved, snapshot))
    await expect(runFixedProductionInspection({ mode: 'restore-plan', set }, signal))
      .rejects.toThrow('BACKUP_INSPECTION_RELEASE_OR_BINDING_MISMATCH')
  })
  it('preserves scratch after uncertain cleanup and aborts promptly when inherited lock is lost', async () => {
    mocks.inspect.mockRejectedValueOnce(new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED'))
    await expect(runFixedProductionInspection({ mode: 'verify', set }, new AbortController().signal)).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    expect(mocks.removeStage).not.toHaveBeenCalled()
    const controller = new AbortController()
    mocks.inspect.mockImplementationOnce(async config => new Promise((_resolve, reject) => {
      locked = false
      config.signal.addEventListener('abort', () => reject(new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')), { once: true })
      setTimeout(() => controller.abort(), 0)
    }))
    await expect(runFixedProductionInspection({ mode: 'verify', set }, controller.signal)).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    expect(mocks.removeStage).not.toHaveBeenCalled()
  }, 5000)
})
