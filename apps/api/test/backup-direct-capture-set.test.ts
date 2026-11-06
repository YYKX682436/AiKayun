import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureDirectUnpublishedSet, type DirectCaptureSetOperations } from '../src/backup/direct-capture-set.js'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const roots: string[] = []
let root: string, stage: string, evidence: { database: Record<string, unknown>; keys: Record<string, unknown>; unresolved: Record<string, number> }
let ops: DirectCaptureSetOperations, events: string[]
const sourceSnapshot = 'a'.repeat(64)
const dumpBytes = Buffer.from('PGDMP-direct-fixture')

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-direct-capture-'))); roots.push(root)
  stage = join(root, 'payload'); await mkdir(stage, { mode: 0o700 })
  evidence = { database: { databaseId: randomUUID(), instanceId: randomUUID(), identityJkt: 'b'.repeat(43), pendingKeyId: 'pending',
    pendingKeySha256: 'c'.repeat(64), migrationHead: 'fixture', migrationChecksumsSha256: 'd'.repeat(64) },
  keys: { paymentKeyIds: ['pay'], deliveryKeyIds: ['delivery'], paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [],
    paymentActiveKeyId: 'pay', deliveryActiveKeyId: 'delivery', paymentKeyDigests: { pay: 'e'.repeat(64) },
    deliveryKeyDigests: { delivery: 'f'.repeat(64) }, contentVerification: 'not_verified' },
  unresolved: { paymentAttemptsPending: 0, paymentRequests: 0, paymentUnknown: 0, paymentReconciliationCases: 0,
    refundsPending: 0, refundAttemptsUncertain: 0, withdrawalsPending: 0, withdrawalAttemptsUncertain: 0,
    fulfillmentAttemptsUnfinished: 0, deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0 } }
  events = []
  ops = {
    assertFence: async () => { events.push('fence') }, assertSecureStaging: async () => { events.push('secure') },
    readDatabaseEvidence: async () => { events.push('db-evidence'); return structuredClone(evidence) },
    captureDump: async () => { events.push('dump'); const path = join(stage, 'database.dump'); await writeFile(path, dumpBytes, { mode: 0o600 }); await chmod(path, 0o600); return { size: dumpBytes.length, sha256: sha(dumpBytes), pgDumpVersion: '18.6' } },
    verifyDumpBinding: async metadata => { events.push('dump-binding'); if (metadata.databaseId !== evidence.database.databaseId) throw new Error('mismatch') },
    captureSourceSnapshot: async set => { events.push('source-snapshot'); if (!set) throw new Error('missing set'); return sourceSnapshot },
    inspectSourceSnapshot: async ({ dump, database }) => { events.push('inspect-source'); if (dump.sha256 !== sha(dumpBytes) || database.databaseId !== evidence.database.databaseId) throw new Error('mismatch'); return {
      identityFileSha256: '9'.repeat(64), trustBundle: { status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 } } },
  }
})
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('direct unpublished backup set', () => {
  it('binds a verified PostgreSQL dump to one raw source snapshot under the writer fence', async () => {
    const value = await captureDirectUnpublishedSet({ backupSetId: randomUUID(), stagingDirectory: stage,
      createdAt: new Date(Date.now() - 1000).toISOString(), operations: ops })
    expect(value.sourceSnapshotId).toBe(sourceSnapshot)
    expect(value.databaseDump).toEqual({ size: dumpBytes.length, sha256: sha(dumpBytes) })
    expect(value.evidence.identityFileSha256).toBe('9'.repeat(64))
    expect((await readdir(stage)).sort()).toEqual(['database.dump'])
    expect(events.indexOf('dump')).toBeLessThan(events.indexOf('source-snapshot'))
    expect(events).toContain('dump-binding')
    expect(events).toContain('inspect-source')
  })
  it('rejects changing database evidence across source capture', async () => {
    ops.readDatabaseEvidence = async () => {
      const result = structuredClone(evidence)
      if (events.filter(event => event === 'db-evidence').length > 0) result.database.databaseId = 'changed'
      events.push('db-evidence')
      return result
    }
    await expect(captureDirectUnpublishedSet({ backupSetId: randomUUID(), stagingDirectory: stage,
      createdAt: new Date(Date.now() - 1000).toISOString(), operations: ops })).rejects.toThrow('BACKUP_SET_EVIDENCE_CHANGED')
    await expect(readFile(join(stage, 'database.dump'))).resolves.toEqual(dumpBytes)
  })
  it('does not continue after the writer fence is lost', async () => {
    let fenced = true
    ops.assertFence = async () => { if (!fenced) throw new Error('lost'); events.push('fence') }
    ops.captureSourceSnapshot = async () => { fenced = false; return sourceSnapshot }
    await expect(captureDirectUnpublishedSet({ backupSetId: randomUUID(), stagingDirectory: stage,
      createdAt: new Date(Date.now() - 1000).toISOString(), operations: ops })).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
  })
})
