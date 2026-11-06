// Isolated Linux fixture: real noswap tmpfs exhaustion; DB/container adapters
// are synthetic, so this is not a production-stack acceptance test.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoSwapTmpfs } from '../../../apps/api/src/backup/tmpfs-staging.js'
import { captureUnpublishedSet, type CaptureSetOperations } from '../../../apps/api/src/backup/capture-set.js'
import { quiesceAndCapture, type QuiesceAdapter } from '../../../apps/api/src/backup/coordinator.js'
import { readMaintenanceJournal } from '../../../apps/api/src/backup/journal.js'

const root = '/stage', stage = await realpath(await mkdtemp(join(root, 'enospc-stage-')))
const journal = await realpath(await mkdtemp('/tmp/aikayun-enospc-journal-'))
const serviceId = 'a'.repeat(64), deployment = 'b'.repeat(64), set = randomUUID()
let running = true, app = true, migrator = true, published = false
const adapter: QuiesceAdapter = { assertLock: async () => {}, assertDeployment: async () => {},
  async assertNoWriters() { if (running || app || migrator) throw new Error('fixture fence open') }, assertRestorationSafe: async () => {},
  containerState: async () => running ? 'running' : 'stopped', stopContainer: async () => { running = false }, startContainer: async () => { running = true },
  roleLogin: async name => name === 'aikayun_app' ? app : migrator,
  setRoleLogin: async (name, allowed) => { if (name === 'aikayun_app') app = allowed; else migrator = allowed } }
const evidence = {
  database: { databaseId: '11111111-1111-4111-8111-111111111111', instanceId: '22222222-2222-4222-8222-222222222222',
    identityJkt: 'd'.repeat(43), pendingKeyId: `lp-${'e'.repeat(32)}`, pendingKeySha256: 'f'.repeat(64),
    migrationHead: '202611040002_file_check_results', migrationChecksumsSha256: 'a'.repeat(64) },
  identityFileSha256: 'c'.repeat(64),
  keys: { paymentKeyIds: ['fixture'], deliveryKeyIds: ['fixture'], paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [],
    paymentActiveKeyId: 'fixture', deliveryActiveKeyId: 'fixture', paymentKeyDigests: { fixture: 'b'.repeat(64) },
    deliveryKeyDigests: { fixture: 'a'.repeat(64) }, contentVerification: 'not_verified' as const },
  unresolved: { paymentAttemptsPending: 0, paymentRequests: 0, paymentUnknown: 0, paymentReconciliationCases: 0,
    refundsPending: 0, refundAttemptsUncertain: 0, withdrawalsPending: 0, withdrawalAttemptsUncertain: 0,
    fulfillmentAttemptsUnfinished: 0, deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0 },
  trustBundle: { status: 'uninitialized' as const, bundleVersion: null, artifactSha256: null, stateDigest: null,
    revokedKeyCount: 0, retiredKeyCount: 0 },
}
const operations = { assertFence: () => adapter.assertNoWriters(), assertSecureStaging: async () => { await assertNoSwapTmpfs(root, 1n) },
  readEvidence: async () => evidence,
  async captureDump() { await writeFile(join(stage, 'database.dump'), Buffer.alloc(8 * 1024 * 1024), { mode: 0o600 }); throw new Error('expected ENOSPC') },
  verifyDumpBinding: async () => {}, captureVolume: async () => { throw new Error('unexpected volume') }, captureDeployment: async () => { throw new Error('unexpected deployment') },
} as unknown as CaptureSetOperations
try {
  let enospc = false
  try {
    await quiesceAndCapture(journal, { deployment, backupSetId: set, services: [{ name: 'api', containerId: serviceId, running: true }],
      roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: true }] }, adapter,
    () => captureUnpublishedSet({ backupSetId: set, stagingDirectory: stage, tarBinary: '/usr/bin/tar',
      createdAt: new Date(Date.now() - 1000).toISOString(), operations }), async () => { published = true })
  } catch (error) {
    console.log(`capture failure code=${(error as NodeJS.ErrnoException).code ?? 'none'} message=${(error as Error).message}`)
    enospc = (error as NodeJS.ErrnoException).code === 'ENOSPC'
  }
  assert.equal(enospc, true); assert.equal(published, false); assert.equal(running && app && migrator, true)
  assert.deepEqual(await readdir(stage), []); assert.equal((await readMaintenanceJournal(journal))?.phase, 'complete')
  console.log('Real Linux noswap tmpfs ENOSPC: synthetic coordinator restored state and did not publish')
} finally { await rm(stage, { recursive: true, force: true }); await rm(journal, { recursive: true, force: true }) }
