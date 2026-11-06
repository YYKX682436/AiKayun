import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureUnpublishedSet, type CaptureSetEvidence, type CaptureSetOperations } from '../src/backup/capture-set.js'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'
import { createBackupIdentityFixture } from './fixtures/backup-identity-fixture.js'

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
let root: string
let stage: string
let source: string
let deploymentSource: string
let tarBinary: string
let evidence: CaptureSetEvidence
let ops: CaptureSetOperations
let fenceCalls: number
const events: string[] = []
const pending = randomBytes(32)
const payKey = randomBytes(32), deliveryKey = randomBytes(32)
const keyId = `lp-${randomBytes(16).toString('hex')}`

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-set-')))
  stage = join(root, 'stage'); source = join(root, 'source'); deploymentSource = join(root, 'deployment-source')
  await mkdir(stage, { mode: 0o700 }); await mkdir(source, { mode: 0o700 }); await mkdir(deploymentSource, { mode: 0o700 })
  await mkdir(join(deploymentSource, 'secrets'), { mode: 0o700 })
  await writeFile(join(deploymentSource, 'secrets', 'payment_credential_key_ring'), JSON.stringify({ activeKeyId: 'pay', keys: { pay: payKey.toString('base64') } }), { mode: 0o600 })
  await writeFile(join(deploymentSource, 'secrets', 'code_pool_encryption_key_ring'), JSON.stringify({ activeKeyId: 'delivery', keys: { delivery: deliveryKey.toString('base64') } }), { mode: 0o600 })
  await mkdir(join(source, 'identity', 'current'), { recursive: true, mode: 0o700 })
  await mkdir(join(source, 'license-pending'), { mode: 0o700 })
  const fixture = await createBackupIdentityFixture()
  const stateId = fixture.identity
  const identity = fixture.identityBytes
  await writeFile(join(source, 'identity', 'current', 'identity.json'), identity, { mode: 0o600 })
  await writeFile(join(source, 'identity', 'current', 'identity-intent.json'), fixture.intentBytes, { mode: 0o600 })
  await writeFile(join(source, 'identity', 'current', 'instance-private-key.pk8.pem'), fixture.privateBytes, { mode: 0o600 })
  await writeFile(join(source, 'license-pending', 'license-pending-aes-256-gcm.json'), JSON.stringify({
    schema: 1, purpose: 'aikayun-license-pending-aes-256-gcm-v1', key_id: keyId, key: pending.toString('base64url'),
  }), { mode: 0o600 })
  tarBinary = await realpath('/usr/bin/tar')
  evidence = { database: { databaseId: stateId.database_id, instanceId: stateId.instance_id, identityJkt: stateId.identity_jkt,
    pendingKeyId: keyId, pendingKeySha256: sha(pending), migrationHead: 'fixture', migrationChecksumsSha256: 'a'.repeat(64) },
  identityFileSha256: sha(identity), keys: { paymentKeyIds: ['pay'], deliveryKeyIds: ['delivery'], paymentReferencedKeyIds: [],
    deliveryReferencedKeyIds: [], paymentActiveKeyId: 'pay', deliveryActiveKeyId: 'delivery', paymentKeyDigests: { pay: sha(payKey) },
    deliveryKeyDigests: { delivery: sha(deliveryKey) }, contentVerification: 'not_verified' }, unresolved: { paymentAttemptsPending: 0, paymentRequests: 0,
    paymentUnknown: 1, paymentReconciliationCases: 0, refundsPending: 0, refundAttemptsUncertain: 0, withdrawalsPending: 0,
    withdrawalAttemptsUncertain: 0, fulfillmentAttemptsUnfinished: 0, deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0 },
  trustBundle: { status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 } }
  fenceCalls = 0; events.length = 0
  const output = async (name: string, bytes: Buffer) => { await writeFile(join(stage, name), bytes, { mode: 0o600 }); return { size: bytes.length, sha256: sha(bytes) } }
  ops = {
    assertFence: async () => { fenceCalls++; events.push('fence') }, assertSecureStaging: async () => { events.push('staging') },
    readEvidence: async () => { events.push('evidence'); return structuredClone(evidence) },
    captureDump: async () => { events.push('dump'); return { ...await output('database.dump', Buffer.from('PGDMP-fixture')), pgDumpVersion: '18.1' } },
    verifyDumpBinding: async () => { events.push('dump-binding') },
    captureVolume: async kind => {
      events.push(kind)
      if (kind === 'state') {
        const path = join(stage, 'state.tar')
        execFileSync(tarBinary, ['-cf', path, '-C', source, '.'])
        await chmod(path, 0o600)
        const bytes = await readFile(path)
        return { size: bytes.length, sha256: sha(bytes) }
      }
      return output(`${kind}.tar`, Buffer.from(kind))
    },
    captureDeployment: async () => {
      events.push('deployment')
      const path = join(stage, 'deployment.tar')
      execFileSync(tarBinary, ['-cf', path, '-C', deploymentSource, 'secrets'])
      await chmod(path, 0o600)
      const bytes = await readFile(path)
      return { size: bytes.length, sha256: sha(bytes) }
    },
  }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const input = () => ({ backupSetId: randomUUID(), stagingDirectory: stage, tarBinary, createdAt: new Date(Date.now() - 1000).toISOString(), operations: ops })
describe('unpublished capture set with synthetic adapters and real tar', () => {
  it('binds five artifacts and both state members to one fenced evidence record', async () => {
    const value = await captureUnpublishedSet(input())
    expect(value.evidence).toEqual(evidence)
    expect(value.pgDumpVersion).toBe('18.1')
    expect(Object.keys(value.artifacts).sort()).toEqual(['caddy-config.tar', 'caddy-data.tar', 'database.dump', 'deployment.tar', 'state.tar'])
    expect((await readdir(stage)).sort()).toEqual(Object.keys(value.artifacts).sort())
    expect(fenceCalls).toBeGreaterThanOrEqual(8)
    expect(events.filter(event => event === 'evidence')).toHaveLength(2)
    expect(JSON.stringify(value)).not.toContain(pending.toString('base64url'))
    expect(value).not.toHaveProperty('status')
  })
  it('cleans created artifacts after capture failure without deleting pre-existing data', async () => {
    ops.captureDeployment = async () => { await writeFile(join(stage, 'deployment.tar'), 'partial', { mode: 0o600 }); throw new Error('disk full') }
    await expect(captureUnpublishedSet(input())).rejects.toThrow('disk full')
    expect(await readdir(stage)).toEqual([])
    await writeFile(join(stage, 'keep'), 'user data', { mode: 0o600 })
    await expect(captureUnpublishedSet(input())).rejects.toThrow('BACKUP_SET_STAGING_NOT_EMPTY')
    expect(await readFile(join(stage, 'keep'), 'utf8')).toBe('user data')
  })
  it('preserves all captured evidence if an ordinary failure coincides with a lost writer fence', async () => {
    let safe = true
    ops.assertFence = async () => { if (!safe) throw new Error('database or lock lost') }
    ops.captureDeployment = async () => { await writeFile(join(stage, 'deployment.tar'), 'partial', { mode: 0o600 }); safe = false; throw new Error('write failed') }
    await expect(captureUnpublishedSet(input())).rejects.toMatchObject({ code: 'SET_FENCE_UNVERIFIED' })
    expect((await readdir(stage)).sort()).toEqual(['database.dump', 'deployment.tar', 'state.tar'])
  })
  it('rejects changed identity inside the archive and cleans all artifacts', async () => {
    evidence.identityFileSha256 = 'b'.repeat(64)
    await expect(captureUnpublishedSet(input())).rejects.toThrow('BACKUP_STATE_IDENTITY_MISMATCH')
    expect(await readdir(stage)).toEqual([])
  })
  it('rejects a different database binding or different key bytes under the same ID', async () => {
    ops.verifyDumpBinding = async () => { throw new Error('DUMP_BINDING_MISMATCH') }
    await expect(captureUnpublishedSet(input())).rejects.toThrow('DUMP_BINDING_MISMATCH')
    expect(await readdir(stage)).toEqual([])
    ops.verifyDumpBinding = async () => {}
    await writeFile(join(deploymentSource, 'secrets', 'payment_credential_key_ring'), JSON.stringify({ activeKeyId: 'pay', keys: { pay: randomBytes(32).toString('base64') } }))
    await expect(captureUnpublishedSet(input())).rejects.toThrow('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')
    expect(await readdir(stage)).toEqual([])
  })
  it('rejects changed DB evidence or a mismatched reported hash', async () => {
    let reads = 0
    ops.readEvidence = async () => { const result = structuredClone(evidence); if (++reads === 2) result.unresolved.paymentUnknown++; return result }
    await expect(captureUnpublishedSet(input())).rejects.toThrow('BACKUP_SET_EVIDENCE_CHANGED')
    expect(await readdir(stage)).toEqual([])
    ops.readEvidence = async () => structuredClone(evidence)
    const dump = ops.captureDump
    ops.captureDump = async () => ({ ...await dump(), sha256: '0'.repeat(64) })
    await expect(captureUnpublishedSet(input())).rejects.toThrow('BACKUP_SET_ARTIFACT_MISMATCH')
    expect(await readdir(stage)).toEqual([])
  })
  it('preserves unsafe failure and does not erase unexpected staged data', async () => {
    ops.captureDump = async () => { await writeFile(join(stage, 'unexpected'), 'evidence', { mode: 0o600 }); throw new Error('failed') }
    await expect(captureUnpublishedSet(input())).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    expect(await readFile(join(stage, 'unexpected'), 'utf8')).toBe('evidence')
  })
  it('preserves artifacts when the writer fence is lost', async () => {
    ops.assertFence = async () => { if (++fenceCalls >= 3) throw new Error('fence lost') }
    await expect(captureUnpublishedSet(input())).rejects.toMatchObject({ code: 'SET_FENCE_UNVERIFIED' })
    expect(await readdir(stage)).toEqual(['database.dump'])
  })
  it('propagates an unverified subprocess cleanup even when the fence is still present', async () => {
    ops.captureDump = async () => {
      await writeFile(join(stage, 'database.dump'), 'partial', { mode: 0o600 })
      throw new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED')
    }
    await expect(captureUnpublishedSet(input())).rejects.toMatchObject({ code: 'DUMP_CLEANUP_UNVERIFIED' })
    expect(await readFile(join(stage, 'database.dump'), 'utf8')).toBe('partial')
  })
})
