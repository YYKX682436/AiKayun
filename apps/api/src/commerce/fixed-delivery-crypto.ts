import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { AppConfig, PaymentCredentialKeyRing } from '../config.js'

export type FixedDeliveryMethod = 'fixed_content' | 'link'

export type FixedDeliveryPayload =
  | { method: 'fixed_content'; content: string }
  | { method: 'link'; url: string; title: string; accessInstructions: string | null }

export interface EncryptedFixedDeliveryPayload {
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export class FixedDeliveryKeyUnavailableError extends Error {
  constructor() {
    super('Fixed digital delivery key is unavailable')
    this.name = 'FixedDeliveryKeyUnavailableError'
  }
}

export class FixedDeliveryDecryptionError extends Error {
  constructor() {
    super('Fixed digital delivery ciphertext failed integrity verification')
    this.name = 'FixedDeliveryDecryptionError'
  }
}

export class FixedDeliveryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FixedDeliveryValidationError'
  }
}

function ringFor(config: AppConfig): PaymentCredentialKeyRing {
  if (!config.codePoolEncryptionKeyRing) throw new FixedDeliveryKeyUnavailableError()
  return config.codePoolEncryptionKeyRing
}

function rootKeyFor(config: AppConfig, keyId: string): Buffer {
  const key = ringFor(config).keys[keyId]
  if (!key) throw new FixedDeliveryKeyUnavailableError()
  return key
}

function purposeKey(rootKey: Buffer, purpose: 'encryption' | 'digest'): Buffer {
  return createHmac('sha256', rootKey)
    .update(`aikayun:fixed-delivery:${purpose}:v1`, 'utf8')
    .digest()
}

export function normalizeFixedDeliveryUrl(value: string): string {
  const hasControlOrSpace = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x20 || codePoint === 0x7f
  })
  if (value !== value.trim() || hasControlOrSpace || !/^https:\/\//iu.test(value)) {
    throw new FixedDeliveryValidationError('链接必须是完整的 HTTPS 地址。')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new FixedDeliveryValidationError('链接格式无效，请输入完整的 HTTPS 地址。')
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
    || parsed.href.length > 2_048) {
    throw new FixedDeliveryValidationError('链接必须使用 HTTPS，且不能包含用户名或密码。')
  }
  return parsed.href
}

export function validateFixedDeliveryPayload(payload: FixedDeliveryPayload): FixedDeliveryPayload {
  if (payload.method === 'fixed_content') {
    if (typeof payload.content !== 'string' || payload.content.length === 0
      || payload.content.length > 20_000 || payload.content.trim().length === 0) {
      throw new FixedDeliveryValidationError('固定文本不能为空，且最多支持 20000 个字符。')
    }
    return payload
  }
  if (typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.length > 160
    || (payload.accessInstructions !== null && (typeof payload.accessInstructions !== 'string'
      || payload.accessInstructions.length > 4_000))) {
    throw new FixedDeliveryValidationError('链接标题或访问说明长度无效。')
  }
  return {
    method: 'link',
    url: normalizeFixedDeliveryUrl(payload.url),
    title: payload.title,
    accessInstructions: payload.accessInstructions,
  }
}

export function fixedDeliveryVersionContext(skuId: string, versionId: string, method: FixedDeliveryMethod): string {
  return `aikayun:fixed-delivery:version:v1:${skuId}:${versionId}:${method}`
}

export function fixedDeliveryDeliveryContext(
  orderItemId: string,
  deliveryId: string,
  versionId: string,
  method: FixedDeliveryMethod,
): string {
  return `aikayun:fixed-delivery:delivery:v1:${orderItemId}:${deliveryId}:${versionId}:${method}`
}

export function fixedDeliveryPayloadDigest(
  config: AppConfig,
  payload: FixedDeliveryPayload,
  keyId = ringFor(config).activeKeyId,
): string {
  return createHmac('sha256', purposeKey(rootKeyFor(config, keyId), 'digest'))
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex')
}

export function encryptFixedDeliveryPayload(
  config: AppConfig,
  context: string,
  payload: FixedDeliveryPayload,
  keyId = ringFor(config).activeKeyId,
): EncryptedFixedDeliveryPayload {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', purposeKey(rootKeyFor(config, keyId), 'encryption'), nonce)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return { keyId, nonce, ciphertext, authTag: cipher.getAuthTag() }
}

export function decryptFixedDeliveryPayload(
  config: AppConfig,
  context: string,
  method: FixedDeliveryMethod,
  envelope: EncryptedFixedDeliveryPayload,
): FixedDeliveryPayload {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm', purposeKey(rootKeyFor(config, envelope.keyId), 'encryption'), envelope.nonce,
    )
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(envelope.authTag)
    const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new FixedDeliveryDecryptionError()
    const record = parsed as Record<string, unknown>
    if (method === 'fixed_content' && typeof record.content === 'string') {
      return validateFixedDeliveryPayload({ method, content: record.content })
    }
    if (method === 'link' && typeof record.url === 'string' && typeof record.title === 'string'
      && (typeof record.accessInstructions === 'string' || record.accessInstructions === null)) {
      return validateFixedDeliveryPayload({
        method, url: record.url, title: record.title, accessInstructions: record.accessInstructions,
      })
    }
    throw new FixedDeliveryDecryptionError()
  } catch (error) {
    if (error instanceof FixedDeliveryKeyUnavailableError) throw error
    throw new FixedDeliveryDecryptionError()
  }
}
