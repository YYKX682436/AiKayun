import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ProductionBackupRuntimeInput } from '../src/backup/production-runtime.js'

const mocks = vi.hoisted(() => ({ target: vi.fn(), fence: vi.fn(), cleanupProof: vi.fn(),
  payload: vi.fn(), scratch: vi.fn(), assertPayload: vi.fn(), assertStage: vi.fn(), removeStage: vi.fn(),
  quiesce: vi.fn(), captureSet: vi.fn(), publishSet: vi.fn(), readerCreate: vi.fn(), readerBackup: vi.fn(),
  readDatabase: vi.fn(), assertPending: vi.fn(), readKeys: vi.fn(), readPending: vi.fn(), dump: vi.fn(), verifyDump: vi.fn(),
  verifySource: vi.fn() }))
vi.mock('../src/backup/database-target.js', () => ({ withProvenProductionDatabaseTarget: mocks.target }))
vi.mock('../src/backup/docker-pg-fence.js', () => ({ productionDockerPgFence: mocks.fence }))
vi.mock('../src/backup/fixed-cleanup-proof.js', () => ({ assertNoFixedBackupWriters: mocks.cleanupProof }))
vi.mock('../src/backup/tmpfs-staging.js', () => ({ assertTmpfsPayload: mocks.assertPayload, assertTmpfsStaging: mocks.assertStage,
  createTmpfsPayload: mocks.payload, createTmpfsStaging: mocks.scratch, removeTmpfsStaging: mocks.removeStage }))
vi.mock('../src/backup/coordinator.js', () => ({ quiesceAndCapture: mocks.quiesce }))
vi.mock('../src/backup/direct-capture-set.js', () => ({ captureDirectUnpublishedSet: mocks.captureSet }))
vi.mock('../src/backup/direct-publish-set.js', () => ({ publishDirectCapturedSet: mocks.publishSet }))
vi.mock('../src/backup/restic-container.js', () => ({ DirectResticVolumeReader: { create: mocks.readerCreate } }))
vi.mock('../src/backup/database-metadata.js', () => ({ readBackupDatabaseMetadata: mocks.readDatabase }))
vi.mock('../src/backup/key-references.js', () => ({ assertPendingKeyReferences: mocks.assertPending, readBackupKeyReferences: mocks.readKeys }))
vi.mock('../src/backup/pending-summary.js', () => ({ readBackupPendingSummary: mocks.readPending }))
vi.mock('../src/backup/pg-dump.js', () => ({ capturePostgresDump: mocks.dump, verifyPostgresDumpBinding: mocks.verifyDump }))
vi.mock('../src/backup/direct-source-inspection.js', () => ({ verifyDirectSourceSnapshot: mocks.verifySource }))
import { runProductionBackupRuntime } from '../src/backup/production-runtime.js'

const noop = async () => {}
const sourceSnapshot = 'f'.repeat(64)
const backupResticImage = `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'e'.repeat(64)}`
const digestImage = `sha256:${'a'.repeat(64)}`

function input(): ProductionBackupRuntimeInput {
  const snapshotId = randomUUID()
  const host = { assertOwnedLock: vi.fn(noop), verifyDeployment: vi.fn(noop) }
  const repository = { storagePaths: () => ({ binary: '/restic', repository: '/repo', passwordFile: '/password' }),
    snapshotsForRole: vi.fn(async () => [sourceSnapshot]) }
  return {
    snapshot: { deployment: 'b'.repeat(64), backupSetId: snapshotId, services: [], roles: [] },
    fence: { dockerBinary: '/docker', dockerSocket: '/socket', dockerHome: '/docker-home', deployment: 'b'.repeat(64), managed: [{ id: 'a'.repeat(64), service: 'api' }], host },
    mountRoot: '/mount', minimumBytes: 1n, journalDirectory: '/journal', publicationDirectory: '/publication',
    releaseId: 'fixture', backupResticImage, images: { api: digestImage, web: digestImage, postgres: digestImage, caddy: digestImage }, resticVersion: '0.19.1',
    repository: repository as unknown as ProductionBackupRuntimeInput['repository'], assertTrustedDeployment: vi.fn(noop), assertSafeCleanup: vi.fn(noop), assertRestoredAndRelease: vi.fn(noop),
    databaseConfig: { connectionString: 'postgresql://fixture@localhost/fixture' }, dump: { dockerBinary: '/docker', dockerSocket: '/socket', containerId: 'c'.repeat(64), database: 'aikayun', user: 'aikayun_bootstrap' },
    volumes: { dockerBinary: '/docker', dockerSocket: '/socket', postgresImage: `docker.io/library/postgres@${digestImage}` },
    deployment: { deploymentRoot: '/deployment' }, paymentKeys: { activeKeyId: 'current', keys: { current: Buffer.alloc(32) } },
    deliveryKeys: { activeKeyId: 'current', keys: { current: Buffer.alloc(32) } },
    readAuthenticatedRelease: vi.fn(async () => ({ releaseId: 'fixture', backupResticImage,
      images: { api: digestImage, web: digestImage, postgres: digestImage, caddy: digestImage },
      database: { engine_major: 18, migration_head: 'head', migration_checksums_sha256: 'c'.repeat(64) },
      signedChecksums: Buffer.from('fixture'), compiledChecksums: Buffer.from('fixture'), postgresImage: `docker.io/library/postgres@${digestImage}` })),
    inspectTrustStoreReadOnly: vi.fn(async () => ({ status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null,
      revokedKeyCount: 0, retiredKeyCount: 0 })),
    inspectTrustStorePersistedReadOnly: vi.fn(async () => ({ status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null,
      revokedKeyCount: 0, retiredKeyCount: 0 })),
  }
}

const database = { databaseId: 'db', instanceId: 'instance', identityJkt: 'identity', pendingKeyId: 'pending', pendingKeySha256: 'c'.repeat(64),
  migrationHead: 'head', migrationChecksumsSha256: 'd'.repeat(64) }
const keys = { paymentKeyIds: ['current'], deliveryKeyIds: ['current'], paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [],
  paymentActiveKeyId: 'current', deliveryActiveKeyId: 'current', paymentKeyDigests: { current: 'e'.repeat(64) },
  deliveryKeyDigests: { current: 'f'.repeat(64) }, contentVerification: 'not_verified' as const }
const unresolved = { paymentAttemptsPending: 0, paymentRequests: 0, paymentUnknown: 0, paymentReconciliationCases: 0,
  refundsPending: 0, refundAttemptsUncertain: 0, withdrawalsPending: 0, withdrawalAttemptsUncertain: 0,
  fulfillmentAttemptsUnfinished: 0, deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0 }
const dump = { size: 128, sha256: '9'.repeat(64), pgDumpVersion: '18.6' }

type FakeCaptureOperations = {
  assertFence(): Promise<void>
  readDatabaseEvidence(): Promise<{ database: unknown; keys: unknown; unresolved: unknown }>
  captureDump(): Promise<typeof dump>
  verifyDumpBinding(metadata: unknown): Promise<void>
  captureSourceSnapshot(set: string): Promise<string>
  inspectSourceSnapshot(input: { snapshot: string; dump: typeof dump; database: unknown; keys: unknown }): Promise<{
    identityFileSha256: string; trustBundle: { status: string; bundleVersion: null; artifactSha256: null; stateDigest: null; revokedKeyCount: number; retiredKeyCount: number }
  }>
}

function prepareMocks() {
  const adapter = { assertNoWriters: vi.fn(noop), assertDeployment: vi.fn(noop), containerState: vi.fn(async () => 'stopped'), roleLogin: vi.fn(async () => false) }
  mocks.fence.mockReturnValue(adapter)
  mocks.target.mockImplementation(async (_options, callback) => callback({ db: 'pinned-db', assertBound: vi.fn(noop) }))
  mocks.payload.mockResolvedValue('/mount/set/payload')
  mocks.scratch.mockResolvedValue('/mount/set/scratch')
  mocks.assertPayload.mockResolvedValue(undefined); mocks.assertStage.mockResolvedValue(undefined)
  mocks.removeStage.mockImplementation(async (options: { assertSafeCleanup(): Promise<void> }) => options.assertSafeCleanup())
  mocks.readDatabase.mockResolvedValue(database); mocks.assertPending.mockResolvedValue(undefined); mocks.readKeys.mockResolvedValue(keys); mocks.readPending.mockResolvedValue(unresolved)
  mocks.dump.mockResolvedValue(dump); mocks.verifyDump.mockResolvedValue(undefined); mocks.verifySource.mockResolvedValue({ identityFileSha256: '8'.repeat(64),
    trustBundle: { status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 } })
  mocks.readerBackup.mockResolvedValue({ snapshotId: sourceSnapshot })
  mocks.readerCreate.mockResolvedValue({ backup: mocks.readerBackup })
  mocks.captureSet.mockImplementation(async ({ backupSetId, operations }: { backupSetId: string; operations: FakeCaptureOperations }) => {
    await operations.assertFence()
    const before = await operations.readDatabaseEvidence()
    const capturedDump = await operations.captureDump()
    await operations.verifyDumpBinding(before.database)
    const source = await operations.captureSourceSnapshot(backupSetId)
    const evidence = await operations.inspectSourceSnapshot({ snapshot: source, dump: capturedDump, database: before.database, keys: before.keys })
    return { backupSetId, sourceSnapshotId: source, createdAt: '2026-11-05T00:00:00.000Z', quiescedAt: '2026-11-05T00:00:01.000Z',
      evidence: { ...before, identityFileSha256: evidence.identityFileSha256, trustBundle: evidence.trustBundle }, pgDumpVersion: capturedDump.pgDumpVersion,
      databaseDump: { size: capturedDump.size, sha256: capturedDump.sha256 } }
  })
  mocks.publishSet.mockImplementation(async ({ staged, verifyDumpBinding, assertSecureStorage }: { staged: { sourceSnapshotId: string }; verifyDumpBinding(directory: string, metadata: unknown): Promise<void>; assertSecureStorage(): Promise<void> }) => {
    await assertSecureStorage()
    await verifyDumpBinding('/decrypted', { databaseId: 'db' })
    return { snapshotId: '7'.repeat(64), sourceSnapshotId: staged.sourceSnapshotId, status: 'verified' }
  })
  mocks.quiesce.mockImplementation(async (_directory, snapshot, _adapter, capture, publish) => {
    const staged = await capture()
    return publish(staged, { backupSetId: snapshot.backupSetId, phase: 'complete', deployment: snapshot.deployment, services: [], roles: [], updatedAt: '2026-11-05T00:00:02.000Z' })
  })
}

describe('direct Restic production capture wiring', () => {
  beforeEach(() => vi.clearAllMocks())
  it('rejects missing authority before connecting to PostgreSQL', async () => {
    const value = input()
    value.volumes.postgresImage = `docker.io/library/postgres@sha256:${'d'.repeat(64)}`
    await expect(runProductionBackupRuntime(value)).rejects.toThrow('BACKUP_CAPTURE_AUTHORITY_MISSING')
    expect(mocks.target).not.toHaveBeenCalled()
  })
  it('captures the direct source snapshot under the writer fence and publishes its linked manifest after restoration', async () => {
    const value = input(); prepareMocks()
    await expect(runProductionBackupRuntime(value)).resolves.toEqual({ snapshotId: '7'.repeat(64), sourceSnapshotId: sourceSnapshot, status: 'verified' })
    expect(mocks.fence).toHaveBeenCalledWith(expect.objectContaining({ db: 'pinned-db' }))
    expect(mocks.readerCreate).toHaveBeenCalledWith(expect.objectContaining({ image: backupResticImage,
      repositoryDirectory: '/repo', passwordFile: '/password', stagingDirectory: '/mount/set', deploymentRoot: '/deployment' }))
    expect(value.readAuthenticatedRelease).toHaveBeenCalled()
    expect(mocks.verifyDump.mock.calls[0]?.[0]).toMatchObject({ stagingDirectory: '/mount/set/payload' })
    expect(mocks.cleanupProof).toHaveBeenCalledWith('pinned-db')
    expect(mocks.removeStage).toHaveBeenCalledTimes(2)
  })
  it('rejects a changed signed Restic reader digest before starting a reader', async () => {
    const value = input(); prepareMocks()
    value.readAuthenticatedRelease = vi.fn(async () => ({ ...await input().readAuthenticatedRelease(),
      backupResticImage: `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'f'.repeat(64)}` }))
    await expect(runProductionBackupRuntime(value)).rejects.toThrow('BACKUP_CAPTURE_RELEASE_UNVERIFIED')
    expect(mocks.readerCreate).not.toHaveBeenCalled()
  })
})
