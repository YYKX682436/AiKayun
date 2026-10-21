import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { AppConfig, PaymentCredentialKeyRing } from '../config.js'

export interface EncryptedCodePoolContent {
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export class CodePoolKeyUnavailableError extends Error {
  constructor() {
    super('Code-pool encryption is unavailable')
    this.name = 'CodePoolKeyUnavailableError'
  }
}

export class CodePoolDecryptionError extends Error {
  constructor() {
    super('Code-pool ciphertext failed integrity verification')
    this.name = 'CodePoolDecryptionError'
  }
}

export function requiredCodePoolKeyRing(config: AppConfig): PaymentCredentialKeyRing {
  if (!config.codePoolEncryptionKeyRing) throw new CodePoolKeyUnavailableError()
  return config.codePoolEncryptionKeyRing
}

function keyFor(config: AppConfig, keyId: string): Buffer {
  const key = requiredCodePoolKeyRing(config).keys[keyId]
  if (!key) throw new CodePoolKeyUnavailableError()
  return key
}

function purposeKey(key: Buffer, purpose: 'dedupe' | 'operation' | 'delivery-digest'): Buffer {
  return createHmac('sha256', key).update(`aikayun:code-pool:${purpose}:v1`, 'utf8').digest()
}

export function codePoolFingerprints(config: AppConfig, value: string): Array<{ keyId: string; fingerprint: string }> {
  const ring = requiredCodePoolKeyRing(config)
  return Object.entries(ring.keys).map(([keyId, key]) => ({
    keyId,
    fingerprint: createHmac('sha256', purposeKey(key, 'dedupe')).update(value, 'utf8').digest('hex'),
  }))
}

export function codePoolFingerprint(config: AppConfig, value: string, keyId = requiredCodePoolKeyRing(config).activeKeyId): string {
  return createHmac('sha256', purposeKey(keyFor(config, keyId), 'operation')).update(value, 'utf8').digest('hex')
}

export function codePoolOperationFingerprints(config: AppConfig, value: string): Array<{ keyId: string; fingerprint: string }> {
  const ring = requiredCodePoolKeyRing(config)
  return Object.entries(ring.keys).map(([keyId, key]) => ({
    keyId,
    fingerprint: createHmac('sha256', purposeKey(key, 'operation')).update(value, 'utf8').digest('hex'),
  }))
}

export function codePoolContentDigest(config: AppConfig, value: string, keyId = requiredCodePoolKeyRing(config).activeKeyId): string {
  return createHmac('sha256', purposeKey(keyFor(config, keyId), 'delivery-digest')).update(value, 'utf8').digest('hex')
}

export function encryptCodePoolContent(
  config: AppConfig,
  context: string,
  plaintext: string,
  keyId = requiredCodePoolKeyRing(config).activeKeyId,
): EncryptedCodePoolContent {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(config, keyId), nonce)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  return { keyId, nonce, ciphertext, authTag: cipher.getAuthTag() }
}

export function decryptCodePoolContent(
  config: AppConfig,
  context: string,
  envelope: EncryptedCodePoolContent,
): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(config, envelope.keyId), envelope.nonce)
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(envelope.authTag)
    const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch (error) {
    if (error instanceof CodePoolKeyUnavailableError) throw error
    throw new CodePoolDecryptionError()
  }
}
