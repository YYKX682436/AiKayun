import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { AppConfig, PaymentCredentialKeyRing } from '../config.js'

export interface EncryptedEnvelope {
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export class PaymentCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentCredentialError'
  }
}

export function requiredPaymentKeyRing(config: AppConfig): PaymentCredentialKeyRing {
  if (!config.paymentCredentialKeyRing) {
    throw new PaymentCredentialError('Payment credential encryption is not configured')
  }
  return config.paymentCredentialKeyRing
}

export function encryptPaymentConfig(
  config: AppConfig,
  context: string,
  plaintext: Buffer,
  keyId = requiredPaymentKeyRing(config).activeKeyId,
): EncryptedEnvelope {
  const ring = requiredPaymentKeyRing(config)
  const key = ring.keys[keyId]
  if (!key) throw new PaymentCredentialError('The configured payment encryption key is unavailable')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { keyId, nonce, ciphertext, authTag: cipher.getAuthTag() }
}

export function decryptPaymentConfig(
  config: AppConfig,
  context: string,
  envelope: EncryptedEnvelope,
): Buffer {
  const key = requiredPaymentKeyRing(config).keys[envelope.keyId]
  if (!key) throw new PaymentCredentialError('A required historical payment encryption key is unavailable')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce)
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
  } catch {
    throw new PaymentCredentialError('Encrypted payment configuration failed integrity verification')
  }
}

export function serializePaymentConfig(value: Record<string, string>): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

export function parsePaymentConfig(value: Buffer): Record<string, string> {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    const record = parsed as Record<string, unknown>
    if (Object.values(record).some((item) => typeof item !== 'string')) throw new Error()
    return record as Record<string, string>
  } catch {
    throw new PaymentCredentialError('Encrypted payment configuration is malformed')
  }
}
