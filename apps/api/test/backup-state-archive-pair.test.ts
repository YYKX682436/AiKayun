import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyStateArchivePair } from '../src/backup/state-archive-pair.js'
import { createBackupIdentityFixture } from './fixtures/backup-identity-fixture.js'

let root: string
let stage: string
let source: string
let tarBinary: string
const key = randomBytes(32)
let identityBytes: Buffer
const keyId = `lp-${randomBytes(16).toString('hex')}`
let metadata: { databaseId: string; instanceId: string; identityJkt: string; pendingKeyId: string; pendingKeySha256: string; migrationHead: string; migrationChecksumsSha256: string }
let identitySha: string
async function archive() { execFileSync(tarBinary, ['-cf', join(stage, 'state.tar'), '-C', source, '.']); await chmod(join(stage, 'state.tar'), 0o600) }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-state-pair-')))
  stage = join(root, 'stage'); source = join(root, 'source')
  await mkdir(stage, { mode: 0o700 }); await mkdir(source, { mode: 0o700 })
  await mkdir(join(source, 'identity', 'current'), { recursive: true, mode: 0o700 })
  await mkdir(join(source, 'license-pending'), { mode: 0o700 })
  const fixture = await createBackupIdentityFixture()
  identityBytes = fixture.identityBytes
  identitySha = createHash('sha256').update(identityBytes).digest('hex')
  metadata = { databaseId: fixture.identity.database_id, instanceId: fixture.identity.instance_id, identityJkt: fixture.identity.identity_jkt,
    pendingKeyId: keyId, pendingKeySha256: createHash('sha256').update(key).digest('hex'), migrationHead: 'fixture', migrationChecksumsSha256: 'a'.repeat(64) }
  await writeFile(join(source, 'identity', 'current', 'identity.json'), identityBytes, { mode: 0o600 })
  await writeFile(join(source, 'identity', 'current', 'identity-intent.json'), fixture.intentBytes, { mode: 0o600 })
  await writeFile(join(source, 'identity', 'current', 'instance-private-key.pk8.pem'), fixture.privateBytes, { mode: 0o600 })
  await writeFile(join(source, 'license-pending', 'license-pending-aes-256-gcm.json'), JSON.stringify({
    schema: 1, purpose: 'aikayun-license-pending-aes-256-gcm-v1', key_id: keyId, key: key.toString('base64url'),
  }), { mode: 0o600 })
  tarBinary = await realpath('/usr/bin/tar')
  await archive()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('read-only state archive binding', () => {
  it('checks exact identity.json bytes and pending key without extracting any files', async () => {
    const before = await readFile(join(stage, 'state.tar'))
    await expect(verifyStateArchivePair(stage, tarBinary, metadata, identitySha)).resolves.toBeUndefined()
    expect(await readFile(join(stage, 'state.tar'))).toEqual(before)
  })
  it('rejects wrong identity bytes or database identity', async () => {
    await expect(verifyStateArchivePair(stage, tarBinary, metadata, 'b'.repeat(64))).rejects.toThrow('BACKUP_STATE_IDENTITY_MISMATCH')
    await expect(verifyStateArchivePair(stage, tarBinary, { ...metadata, databaseId: randomUUID() }, identitySha)).rejects.toThrow('BACKUP_STATE_IDENTITY_MISMATCH')
  })
  it('rejects a missing or mismatched pending key', async () => {
    await expect(verifyStateArchivePair(stage, tarBinary, { ...metadata, pendingKeySha256: 'c'.repeat(64) }, identitySha)).rejects.toThrow('BACKUP_STATE_PENDING_MISMATCH')
    await rm(join(source, 'license-pending', 'license-pending-aes-256-gcm.json'))
    await archive()
    await expect(verifyStateArchivePair(stage, tarBinary, metadata, identitySha)).rejects.toThrow('BACKUP_STATE_ARCHIVE_MEMBER_INVALID')
  })
  it('rejects an omitted or replaced private key and a missing identity intent', async () => {
    const keyPath = join(source, 'identity', 'current', 'instance-private-key.pk8.pem')
    await rm(keyPath)
    await archive()
    await expect(verifyStateArchivePair(stage, tarBinary, metadata, identitySha)).rejects.toThrow('BACKUP_STATE_ARCHIVE_MEMBER_INVALID')
    const other = await createBackupIdentityFixture()
    await writeFile(keyPath, other.privateBytes, { mode: 0o600 })
    await archive()
    await expect(verifyStateArchivePair(stage, tarBinary, metadata, identitySha)).rejects.toThrow('BACKUP_STATE_IDENTITY_MISMATCH')
    await rm(join(source, 'identity', 'current', 'identity-intent.json'))
    await archive()
    await expect(verifyStateArchivePair(stage, tarBinary, metadata, identitySha)).rejects.toThrow('BACKUP_STATE_ARCHIVE_MEMBER_INVALID')
  })
})
