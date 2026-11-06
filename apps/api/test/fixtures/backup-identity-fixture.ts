import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { calculateJwkThumbprint } from 'jose'

export async function createBackupIdentityFixture() {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ format: 'jwk' })
  if (typeof publicKey.x !== 'string') throw new Error('fixture public key missing')
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: publicKey.x }
  const identity = { schema: 1, operation_id: randomUUID(), database_id: randomUUID(), instance_id: randomUUID(),
    identity_jkt: await calculateJwkThumbprint(jwk), public_jwk: jwk, private_key_file: 'instance-private-key.pk8.pem' }
  const intent = { schema: 1, operation_id: identity.operation_id, mode: 'fresh', database_id: identity.database_id, instance_id: identity.instance_id }
  return { identity, identityBytes: Buffer.from(JSON.stringify(identity)), intentBytes: Buffer.from(JSON.stringify(intent)),
    privateBytes: Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' })) }
}
