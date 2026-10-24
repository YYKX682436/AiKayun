import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from 'node:crypto'
import type { AppConfig } from '../config.js'
import { requiredPaymentKeyRing } from '../payments/credentials.js'
import { canonicalPurchaseFormJson, PURCHASE_FORM_NORMALIZATION_VERSION } from '@aikayun/contracts'

export interface EncryptedPurchaseDraft {
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export class PurchaseDraftKeyUnavailableError extends Error {
  constructor() {
    super('Purchase draft encryption is unavailable')
    this.name = 'PurchaseDraftKeyUnavailableError'
  }
}

export class PurchaseDraftDecryptionError extends Error {
  constructor() {
    super('Purchase draft ciphertext failed integrity verification')
    this.name = 'PurchaseDraftDecryptionError'
  }
}

function purposeKey(config: AppConfig, keyId: string): Buffer {
  try {
    const rootKey = requiredPaymentKeyRing(config).keys[keyId]
    if (!rootKey) throw new PurchaseDraftKeyUnavailableError()
    return createHmac('sha256', rootKey).update('aikayun:purchase-draft:encryption:v1', 'utf8').digest()
  } catch {
    throw new PurchaseDraftKeyUnavailableError()
  }
}

export function purchaseDraftContentContext(draftId: string): string {
  return `aikayun:purchase-draft:content:v1:${draftId}`
}

export function encryptPurchaseDraft(
  config: AppConfig,
  draftId: string,
  normalizedValues: Record<string, unknown>,
  requestedKeyId?: string,
): EncryptedPurchaseDraft {
  let keyId: string
  try { keyId = requestedKeyId ?? requiredPaymentKeyRing(config).activeKeyId } catch {
    throw new PurchaseDraftKeyUnavailableError()
  }
  const key = purposeKey(config, keyId)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(purchaseDraftContentContext(draftId), 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(canonicalPurchaseFormJson(normalizedValues), 'utf8'),
    cipher.final(),
  ])
  return { keyId, nonce, ciphertext, authTag: cipher.getAuthTag() }
}

export function decryptPurchaseDraft(
  config: AppConfig,
  draftId: string,
  envelope: EncryptedPurchaseDraft,
): Record<string, unknown> {
  const key = purposeKey(config, envelope.keyId)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce)
    decipher.setAAD(Buffer.from(purchaseDraftContentContext(draftId), 'utf8'))
    decipher.setAuthTag(envelope.authTag)
    const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PurchaseDraftDecryptionError()
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof PurchaseDraftKeyUnavailableError) throw error
    throw new PurchaseDraftDecryptionError()
  }
}

export function purchaseFormContentIdentity(templateVersionId: string, normalizedValues: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalPurchaseFormJson({
      normalizationVersion: PURCHASE_FORM_NORMALIZATION_VERSION,
      templateVersionId,
      values: normalizedValues,
    }), 'utf8')
    .digest('hex')
}
