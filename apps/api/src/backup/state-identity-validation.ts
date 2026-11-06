import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { calculateJwkThumbprint } from 'jose'
import type { readBackupDatabaseMetadata } from './database-metadata.js'

type Metadata = Awaited<ReturnType<typeof readBackupDatabaseMetadata>>

/** Shared content check for state files read from either a verified tar or a
 * Restic source snapshot. Secret buffers are zeroed before returning. */
export async function verifyStateIdentityFiles(input: {
  identity: Buffer
  intent: Buffer
  privateKey: Buffer
  pendingKey: Buffer
  metadata: Metadata
  expectedIdentitySha256?: string
}): Promise<string> {
  const { identity, intent, privateKey: privateBytes, pendingKey: keyBytes, metadata } = input
  try {
    const identityFileSha256 = createHash('sha256').update(identity).digest('hex')
    if (input.expectedIdentitySha256 !== undefined && identityFileSha256 !== input.expectedIdentitySha256) throw new Error('BACKUP_STATE_IDENTITY_MISMATCH')
    let value: unknown
    try { value = JSON.parse(identity.toString('utf8')) as unknown } catch { throw new Error('BACKUP_STATE_IDENTITY_MISMATCH') }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'database_id,identity_jkt,instance_id,operation_id,private_key_file,public_jwk,schema' ||
        !('schema' in value) || value.schema !== 1 || !('database_id' in value) || !('instance_id' in value) ||
        !('identity_jkt' in value) || value.database_id !== metadata.databaseId || value.instance_id !== metadata.instanceId ||
        value.identity_jkt !== metadata.identityJkt || !('public_jwk' in value) || !value.public_jwk ||
        typeof value.public_jwk !== 'object' || Array.isArray(value.public_jwk) ||
        Object.keys(value.public_jwk).sort().join(',') !== 'crv,kty,x' || !('kty' in value.public_jwk) || value.public_jwk.kty !== 'OKP' ||
        !('crv' in value.public_jwk) || value.public_jwk.crv !== 'Ed25519' || !('x' in value.public_jwk) || typeof value.public_jwk.x !== 'string' ||
        !('operation_id' in value) || typeof value.operation_id !== 'string' ||
        !('private_key_file' in value) || value.private_key_file !== 'instance-private-key.pk8.pem') throw new Error('BACKUP_STATE_IDENTITY_MISMATCH')
    let intentValue: unknown
    try { intentValue = JSON.parse(intent.toString('utf8')) as unknown } catch { throw new Error('BACKUP_STATE_IDENTITY_MISMATCH') }
    if (!intentValue || typeof intentValue !== 'object' || Array.isArray(intentValue) ||
        Object.keys(intentValue).sort().join(',') !== 'database_id,instance_id,mode,operation_id,schema' ||
        !('schema' in intentValue) || intentValue.schema !== 1 || !('operation_id' in intentValue) || intentValue.operation_id !== value.operation_id ||
        !('database_id' in intentValue) || intentValue.database_id !== metadata.databaseId ||
        !('instance_id' in intentValue) || intentValue.instance_id !== metadata.instanceId ||
        !('mode' in intentValue) || !['fresh', 'adopt_existing'].includes(String(intentValue.mode))) throw new Error('BACKUP_STATE_IDENTITY_MISMATCH')
    let jwk: JsonWebKey
    try {
      const key = createPrivateKey({ key: privateBytes, format: 'pem', type: 'pkcs8' })
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong type')
      jwk = createPublicKey(key).export({ format: 'jwk' })
    } catch { throw new Error('BACKUP_STATE_IDENTITY_MISMATCH') }
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || jwk.x !== value.public_jwk.x ||
        await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }) !== metadata.identityJkt) throw new Error('BACKUP_STATE_IDENTITY_MISMATCH')
    let pending: unknown
    try { pending = JSON.parse(keyBytes.toString('utf8')) as unknown } catch { throw new Error('BACKUP_STATE_PENDING_MISMATCH') }
    if (!pending || typeof pending !== 'object' || Array.isArray(pending) ||
        Object.keys(pending).sort().join(',') !== 'key,key_id,purpose,schema' || !('schema' in pending) || pending.schema !== 1 ||
        !('purpose' in pending) || pending.purpose !== 'aikayun-license-pending-aes-256-gcm-v1' ||
        !('key_id' in pending) || pending.key_id !== metadata.pendingKeyId || !('key' in pending) || typeof pending.key !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(pending.key)) throw new Error('BACKUP_STATE_PENDING_MISMATCH')
    const decoded = Buffer.from(pending.key, 'base64url')
    try {
      if (decoded.length !== 32 || decoded.toString('base64url') !== pending.key ||
          createHash('sha256').update(decoded).digest('hex') !== metadata.pendingKeySha256) throw new Error('BACKUP_STATE_PENDING_MISMATCH')
    } finally { decoded.fill(0) }
    return identityFileSha256
  } finally {
    privateBytes.fill(0)
    keyBytes.fill(0)
  }
}
