import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMaintenanceJournal, advanceMaintenanceJournal } from '../src/backup/journal.js'
import { backupArtifacts, checksumBackupArtifacts, validateBackupManifest } from '../src/backup/manifest.js'
import { publishCapturedSet, verifyPublishedSnapshot, type PublishSetInput } from '../src/backup/publish-set.js'
import { LocalResticRepository } from '../src/backup/restic-local.js'
import type { UnpublishedBackupSet } from '../src/backup/capture-set.js'
import { createBackupIdentityFixture } from './fixtures/backup-identity-fixture.js'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'
import { copyVerifiedSnapshotToS3 } from '../src/backup/remote-copy.js'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let root: string
let stage: string
let journalDir: string
let pubDir: string
let scratch: string
let staged: UnpublishedBackupSet
let input: PublishSetInput
let repository: FakeRepo
let safeRestoration: boolean

class FakeRepo {
  files = new Map<string, Buffer>()
  set = ''
  snapshot = 'a'.repeat(64)
  failUpload = false
  failCheck = false
  async backup(path: string, set: string) {
    for (const name of ['manifest.json', ...backupArtifacts]) this.files.set(name, await readFile(join(path, name)))
    this.set = set
    if (this.failUpload) throw new Error('uncertain commit')
    return this.snapshot
  }
  async check() { if (this.failCheck) throw new Error('corrupt') }
  async validateExtractionParent() {}
  async assertSeparatedStorage() {}
  async snapshotMetadata() { return [{ id: this.snapshot, tags: [`aikayun-set-${this.set}`], paths: ['/source'] }] }
  async listSnapshot() {
    return [...this.files].map(([name, value]) => JSON.stringify({ struct_type: 'node', path: `/source/${name}`, type: 'file', size: value.length })).join('\n')
  }
  async dumpFile(_id: string, path: string, destination: FileHandle) { await destination.writeFile(this.files.get(path.slice('/source/'.length))!) }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-publish-')))
  stage = join(root, 'stage'); journalDir = join(root, 'journal'); pubDir = join(root, 'publications'); scratch = join(root, 'scratch')
  const source = join(root, 'state-source'), deployment = join(root, 'deployment-source')
  for (const dir of [stage, journalDir, pubDir, scratch, source, deployment]) await mkdir(dir, { mode: 0o700 })
  await mkdir(join(source, 'identity', 'current'), { recursive: true, mode: 0o700 })
  await mkdir(join(source, 'license-pending'), { mode: 0o700 })
  const fixture = await createBackupIdentityFixture()
  const id = fixture.identity
  const identity = fixture.identityBytes
  const key = randomBytes(32), keyId = `lp-${randomBytes(16).toString('hex')}`
  await writeFile(join(source, 'identity', 'current', 'identity.json'), identity, { mode: 0o600 })
  await writeFile(join(source, 'identity', 'current', 'identity-intent.json'), fixture.intentBytes, { mode: 0o600 })
  await writeFile(join(source, 'identity', 'current', 'instance-private-key.pk8.pem'), fixture.privateBytes, { mode: 0o600 })
  await writeFile(join(source, 'license-pending', 'license-pending-aes-256-gcm.json'), JSON.stringify({
    schema: 1, purpose: 'aikayun-license-pending-aes-256-gcm-v1', key_id: keyId, key: key.toString('base64url'),
  }), { mode: 0o600 })
  const tarBinary = await realpath('/usr/bin/tar')
  execFileSync(tarBinary, ['-cf', join(stage, 'state.tar'), '-C', source, '.'])
  await chmod(join(stage, 'state.tar'), 0o600)
  const payKey = randomBytes(32), deliveryKey = randomBytes(32)
  await mkdir(join(deployment, 'secrets'), { mode: 0o700 })
  await writeFile(join(deployment, 'secrets', 'payment_credential_key_ring'), JSON.stringify({ activeKeyId: 'pay', keys: { pay: payKey.toString('base64') } }), { mode: 0o600 })
  await writeFile(join(deployment, 'secrets', 'code_pool_encryption_key_ring'), JSON.stringify({ activeKeyId: 'delivery', keys: { delivery: deliveryKey.toString('base64') } }), { mode: 0o600 })
  execFileSync(tarBinary, ['-cf', join(stage, 'deployment.tar'), '-C', deployment, 'secrets'])
  await chmod(join(stage, 'deployment.tar'), 0o600)
  for (const name of backupArtifacts.filter(name => name !== 'state.tar' && name !== 'deployment.tar')) await writeFile(join(stage, name), `fixture-${name}`, { mode: 0o600 })
  const set = randomUUID()
  staged = { backupSetId: set, createdAt: new Date(Date.now() - 2000).toISOString(), quiescedAt: new Date(Date.now() - 1000).toISOString(),
    pgDumpVersion: '18.1', artifacts: await checksumBackupArtifacts(stage), evidence: {
      database: { databaseId: id.database_id, instanceId: id.instance_id, identityJkt: id.identity_jkt, pendingKeyId: keyId,
        pendingKeySha256: sha(key), migrationHead: 'fixture', migrationChecksumsSha256: 'a'.repeat(64) }, identityFileSha256: sha(identity),
      keys: { paymentKeyIds: ['pay'], deliveryKeyIds: ['delivery'], paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [],
        paymentActiveKeyId: 'pay', deliveryActiveKeyId: 'delivery', paymentKeyDigests: { pay: sha(payKey) }, deliveryKeyDigests: { delivery: sha(deliveryKey) }, contentVerification: 'not_verified' },
      unresolved: { paymentAttemptsPending: 0, paymentRequests: 0, paymentUnknown: 1, paymentReconciliationCases: 0, refundsPending: 0,
        refundAttemptsUncertain: 0, withdrawalsPending: 0, withdrawalAttemptsUncertain: 0, fulfillmentAttemptsUnfinished: 0,
        deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0 },
      trustBundle: { status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 },
    } }
  const initial = await createMaintenanceJournal(journalDir, { deployment: 'b'.repeat(64), backupSetId: set,
    services: [], roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: false }] })
  const restoring = await advanceMaintenanceJournal(journalDir, initial, 'restoring')
  await advanceMaintenanceJournal(journalDir, restoring, 'complete')
  repository = new FakeRepo(); safeRestoration = true
  input = { staged, stagingDirectory: stage, journalDirectory: journalDir, publicationDirectory: pubDir, scratchParent: scratch,
    tarBinary, releaseId: 'aikayun-0.1.0', images: { api: `sha256:${'a'.repeat(64)}`, web: `sha256:${'b'.repeat(64)}`,
      postgres: `sha256:${'c'.repeat(64)}`, caddy: `sha256:${'d'.repeat(64)}` }, resticVersion: '0.19.1',
    repository: repository as unknown as LocalResticRepository, assertLock: async () => {},
    verifyDumpBinding: async (directory, metadata) => { if ((await readFile(join(directory, 'database.dump'), 'utf8')) !== 'fixture-database.dump' || metadata.databaseId !== staged.evidence.database.databaseId) throw new Error('dump binding mismatch') },
    assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, assertRestoredAndRelease: async () => { if (!safeRestoration) throw new Error('unsafe restoration') } }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('unpublished snapshot publication with synthetic repository', () => {
  it('only marks a candidate verified after complete read-only re-extraction', async () => {
    const result = await publishCapturedSet(input)
    expect(result).toEqual({ snapshotId: repository.snapshot, status: 'verified' })
    const manifest = JSON.parse(repository.files.get('manifest.json')!.toString('utf8')) as { status: string }
    expect(manifest.status).toBe('candidate')
    expect(() => validateBackupManifest(manifest)).toThrow('INVALID_BACKUP_MANIFEST')
    const marker = JSON.parse(await readFile(join(pubDir, `${staged.backupSetId}.json`), 'utf8'))
    expect(marker).toEqual({ schema: 1, set: staged.backupSetId, state: 'verified', snapshot: repository.snapshot })
    expect(await readdir(stage)).toEqual([])
    expect(await readdir(scratch)).toEqual([])
    const verifyInput = { backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024, verifyDumpBinding: input.verifyDumpBinding, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {} }
    expect((await verifyPublishedSnapshot(verifyInput)).status).toBe('verified')
    repository.files.set('database.dump', Buffer.from('tampered-snapshot'))
    await expect(verifyPublishedSnapshot(verifyInput)).rejects.toThrow()
    await expect(publishCapturedSet(input)).rejects.toThrow('BACKUP_PUBLICATION_ALREADY_ATTEMPTED')
  })
  it('leaves no verified marker when the upload result is unknown and refuses automatic retry', async () => {
    repository.failUpload = true
    await expect(publishCapturedSet(input)).rejects.toThrow('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
    expect(JSON.parse(await readFile(join(pubDir, `${staged.backupSetId}.json`), 'utf8')).state).toBe('uploading')
    expect(repository.files.size).toBe(6)
    expect(await readdir(stage)).toEqual([])
    await expect(verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024, verifyDumpBinding: input.verifyDumpBinding, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {} }))
      .rejects.toThrow('BACKUP_PUBLICATION_NOT_VERIFIED')
    await expect(publishCapturedSet(input)).rejects.toThrow('BACKUP_PUBLICATION_ALREADY_ATTEMPTED')
  })
  it('does not mark a failed integrity recheck verified or delete the uploaded snapshot', async () => {
    repository.failCheck = true
    await expect(publishCapturedSet(input)).rejects.toThrow('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
    expect(JSON.parse(await readFile(join(pubDir, `${staged.backupSetId}.json`), 'utf8')).state).toBe('uploading')
    expect(repository.files.size).toBe(6)
    expect(await readdir(stage)).toEqual([])
  })
  it('fails closed when an extracted dump cannot be bound, even after upload', async () => {
    const original = input.verifyDumpBinding
    input.verifyDumpBinding = async (directory, metadata) => {
      if (directory !== stage) throw new Error('dump binding mismatch')
      await original(directory, metadata)
    }
    await expect(publishCapturedSet(input)).rejects.toThrow('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
    expect(JSON.parse(await readFile(join(pubDir, `${staged.backupSetId}.json`), 'utf8')).state).toBe('uploading')
    expect(repository.files.size).toBe(6)
  })
  it('rejects a coherent archive with replaced same-ID key on independent recheck', async () => {
    await publishCapturedSet(input)
    const deployment = join(root, 'deployment-source')
    await writeFile(join(deployment, 'secrets', 'payment_credential_key_ring'), JSON.stringify({ activeKeyId: 'pay', keys: { pay: randomBytes(32).toString('base64') } }), { mode: 0o600 })
    const tar = join(root, 'replacement.tar')
    execFileSync(input.tarBinary, ['-cf', tar, '-C', deployment, 'secrets'])
    const replacement = await readFile(tar)
    repository.files.set('deployment.tar', replacement)
    const manifest = JSON.parse(repository.files.get('manifest.json')!.toString('utf8'))
    manifest.artifacts['deployment.tar'] = { size: replacement.length, sha256: sha(replacement) }
    repository.files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`))
    await expect(verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024,
      verifyDumpBinding: input.verifyDumpBinding, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {} })).rejects.toThrow('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')
  })
  it('requires a fresh dump binding check on independent verification', async () => {
    await publishCapturedSet(input)
    await expect(verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024,
      verifyDumpBinding: async () => { throw new Error('dump binding mismatch') }, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {} })).rejects.toThrow('dump binding mismatch')
  })
  it('preserves staged files if the lock disappears after upload', async () => {
    let locked = true
    input.assertLock = async () => { if (!locked) throw new Error('lock lost') }
    const backup = repository.backup.bind(repository)
    repository.backup = async (directory, set) => { const id = await backup(directory, set); locked = false; return id }
    await expect(publishCapturedSet(input)).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    expect((await readdir(stage)).sort()).toEqual(['manifest.json', ...backupArtifacts].sort())
    expect(JSON.parse(await readFile(join(pubDir, `${staged.backupSetId}.json`), 'utf8')).state).toBe('uploading')
  })
  it('preserves fully extracted scratch when cleanup authority is lost', async () => {
    await publishCapturedSet(input)
    const verify = { backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024,
      assertSecureStorage: async () => {}, assertSafeCleanup: async () => { throw new Error('lock lost') },
      verifyDumpBinding: async () => { throw new Error('interrupted') } }
    await expect(verifyPublishedSnapshot(verify)).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    const children = await readdir(scratch)
    expect(children).toHaveLength(1)
    expect((await readdir(join(scratch, children[0]!))).sort()).toEqual(['manifest.json', ...backupArtifacts].sort())
  })
  it('stops deleting extracted files when the lock is lost during cleanup', async () => {
    await publishCapturedSet(input)
    let proofs = 0
    await expect(verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024,
      assertSecureStorage: async () => {}, assertSafeCleanup: async () => { if (++proofs === 4) throw new Error('lock lost') },
      verifyDumpBinding: input.verifyDumpBinding })).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    const children = await readdir(scratch)
    expect(children).toHaveLength(1)
    const retained = await readdir(join(scratch, children[0]!))
    expect(retained.length).toBeGreaterThan(0)
    expect(retained.length).toBeLessThan(backupArtifacts.length + 1)
  })
  it('refuses a scratch file replaced after the original inventory', async () => {
    await publishCapturedSet(input)
    let proofs = 0
    await expect(verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024,
      assertSecureStorage: async () => {}, assertSafeCleanup: async () => {
        if (++proofs !== 3) return
        const child = (await readdir(scratch))[0]!, dir = join(scratch, child), file = (await readdir(dir))[0]!
        await rename(join(dir, file), join(root, 'held-original'))
        await writeFile(join(dir, file), 'replacement', { mode: 0o600 })
      }, verifyDumpBinding: input.verifyDumpBinding })).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    const dir = join(scratch, (await readdir(scratch))[0]!)
    expect((await readdir(dir)).length).toBe(backupArtifacts.length + 1)
  })
  it('preserves partially extracted scratch when cleanup authority is lost', async () => {
    await publishCapturedSet(input)
    const dump = repository.dumpFile.bind(repository)
    repository.dumpFile = async (id, path, destination) => { await dump(id, path, destination); throw new Error('interrupted') }
    await expect(verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: input.repository, maxExtractBytes: 10 * 1024 * 1024,
      assertSecureStorage: async () => {}, assertSafeCleanup: async () => { throw new Error('lock lost') },
      verifyDumpBinding: input.verifyDumpBinding })).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    const children = await readdir(scratch)
    expect(children).toHaveLength(1)
    expect(await readdir(join(scratch, children[0]!))).toContain('manifest.json')
  })
  it('stops stage cleanup after the lock or writer proof becomes unsafe mid-deletion', async () => {
    let checks = 0
    input.assertSafeCleanup = async () => {
      if ((await readdir(scratch)).length === 0 && ++checks === 3) throw new Error('lost lock')
    }
    await expect(publishCapturedSet(input)).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    const remaining = await readdir(stage)
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.length).toBeLessThan(backupArtifacts.length + 1)
    expect(JSON.parse(await readFile(join(pubDir, `${staged.backupSetId}.json`), 'utf8')).state).toBe('uploading')
  })
  it('refuses to start when restoration cannot be verified', async () => {
    safeRestoration = false
    await expect(publishCapturedSet(input)).rejects.toThrow('unsafe restoration')
    expect(await readdir(pubDir)).toEqual([])
    expect(repository.files.size).toBe(0)
  })
})

describe.skipIf(!process.env.AIKAYUN_TEST_RESTIC)('publication with an independently verified real restic binary', () => {
  it('uploads a candidate, decrypts and rechecks it before verified status', async () => {
    const directory = join(root, 'repo'), password = join(root, 'password')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(password, 'isolated-publication-password', { mode: 0o600 })
    const repo = new LocalResticRepository({ binary: process.env.AIKAYUN_TEST_RESTIC!, repository: directory, passwordFile: password })
    await repo.initialize()
    input.repository = repo
    const published = await publishCapturedSet(input)
    const verified = await verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: repo, maxExtractBytes: 10 * 1024 * 1024, verifyDumpBinding: input.verifyDumpBinding, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {} })
    expect(verified.snapshotId).toBe(published.snapshotId)
    expect(verified.status).toBe('verified')
    expect(verified.manifest.status).toBe('candidate')
    // Local repository operations use real restic; remote operations are a
    // no-network process fixture, not an S3 service acceptance test.
    const remotePassword = join(root, 'remote-password'), credentials = join(root, 'remote-credentials'), wrapper = join(root, 'remote-restic-fixture')
    const remoteStatusDirectory = join(root, 'remote-status')
    await mkdir(remoteStatusDirectory, { mode: 0o700 })
    await writeFile(remotePassword, 'synthetic-remote-password', { mode: 0o600 })
    await writeFile(credentials, JSON.stringify({ accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' }), { mode: 0o600 })
    const remoteId = 'f'.repeat(64)
    await writeFile(wrapper, `#!/bin/sh\ncase "$*" in\n  *s3:https:*) case "$*" in *snapshots*) printf '%s\\n' '[{"id":"${remoteId}","original":"${published.snapshotId}","tags":["aikayun-set-${staged.backupSetId}"]}]';; esac; exit 0;;\n  *) exec '${process.env.AIKAYUN_TEST_RESTIC}' "$@";;\nesac\n`, { mode: 0o700 })
    expect(await copyVerifiedSnapshotToS3({ binary: wrapper, localRepository: directory, localPasswordFile: password,
      remoteHttpsUrl: 'https://s3.example.invalid/test-bucket/backup', remotePasswordFile: remotePassword,
      credentialsFile: credentials, publicationDirectory: pubDir, remoteStatusDirectory, scratchParent: scratch, tarBinary: input.tarBinary,
      maxExtractBytes: 10 * 1024 * 1024, verifyDumpBinding: input.verifyDumpBinding, timeoutMs: 60000, assertSecureStorage: async () => {}, assertLock: async () => {} },
    staged.backupSetId, published.snapshotId)).toBe(remoteId)
    await writeFile(password, 'wrong-password')
    await expect(verifyPublishedSnapshot({ backupSetId: staged.backupSetId, publicationDirectory: pubDir, scratchParent: scratch,
      tarBinary: input.tarBinary, repository: repo, maxExtractBytes: 10 * 1024 * 1024, verifyDumpBinding: input.verifyDumpBinding, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {} })).rejects.toThrow()
  }, 120_000)
})
