import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { AppConfig, PaymentCredentialKeyRing } from '../config.js'
import { decryptPaymentConfig, encryptPaymentConfig, parsePaymentConfig, serializePaymentConfig } from '../payments/credentials.js'

export interface ApiDeliveryResult {
  type: 'code' | 'text' | 'redemption' | 'link' | 'completed'
  content: string | null
  title: string | null
  instructions: string | null
}

export interface EncryptedApiDeliveryResult {
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export class SupplierCredentialKeyUnavailableError extends Error {
  constructor() {
    super('Supplier credential encryption key is unavailable')
    this.name = 'SupplierCredentialKeyUnavailableError'
  }
}

export class ApiDeliveryKeyUnavailableError extends Error {
  constructor() {
    super('API delivery encryption key is unavailable')
    this.name = 'ApiDeliveryKeyUnavailableError'
  }
}

export class ApiDeliveryDecryptionError extends Error {
  constructor() {
    super('API delivery ciphertext failed integrity verification')
    this.name = 'ApiDeliveryDecryptionError'
  }
}

export function supplierCredentialContext(connectionId: string, credentialVersion: number): string {
  return `aikayun:supplier-connection:credential:v1:${connectionId}:${credentialVersion}`
}

export function encryptSupplierBearerToken(
  config: AppConfig,
  connectionId: string,
  credentialVersion: number,
  bearerToken: string,
) {
  if (!config.paymentCredentialKeyRing) throw new SupplierCredentialKeyUnavailableError()
  return encryptPaymentConfig(
    config,
    supplierCredentialContext(connectionId, credentialVersion),
    serializePaymentConfig({ bearerToken }),
  )
}

export function decryptSupplierBearerToken(
  config: AppConfig,
  connectionId: string,
  credentialVersion: number,
  envelope: { keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer },
): string {
  if (!config.paymentCredentialKeyRing) throw new SupplierCredentialKeyUnavailableError()
  try {
    const parsed = parsePaymentConfig(decryptPaymentConfig(
      config,
      supplierCredentialContext(connectionId, credentialVersion),
      envelope,
    ))
    const token = parsed.bearerToken
    if (!token || !/^[A-Za-z0-9._~+/-]+={0,}$/u.test(token) || token.length > 2048) {
      throw new SupplierCredentialKeyUnavailableError()
    }
    return token
  } catch (error) {
    if (error instanceof SupplierCredentialKeyUnavailableError) throw error
    throw new SupplierCredentialKeyUnavailableError()
  }
}

export type SupplierCredentials =
  | { providerType: 'http_json_v1'; bearerToken: string }
  | { providerType: 'kayixin_customer_v3'; appId: string; appSecret: string }

function kayixinCredentialContext(connectionId: string, credentialVersion: number): string {
  return `aikayun:supplier-connection:credential:kayixin_customer_v3:v1:${connectionId}:${credentialVersion}`
}

export function encryptSupplierCredentials(config: AppConfig, connectionId: string, credentialVersion: number, credentials: SupplierCredentials) {
  if (credentials.providerType === 'http_json_v1') return encryptSupplierBearerToken(config, connectionId, credentialVersion, credentials.bearerToken)
  if (!config.paymentCredentialKeyRing || !/^[0-9]{1,32}$/u.test(credentials.appId)
    || !/^[!-~]{1,512}$/u.test(credentials.appSecret)) throw new SupplierCredentialKeyUnavailableError()
  return encryptPaymentConfig(config, kayixinCredentialContext(connectionId, credentialVersion),
    serializePaymentConfig({ appId: credentials.appId, appSecret: credentials.appSecret }))
}

export function decryptSupplierCredentials(config: AppConfig, connectionId: string, credentialVersion: number,
  providerType: SupplierCredentials['providerType'],
  envelope: { keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer },
): SupplierCredentials {
  if (providerType === 'http_json_v1') return { providerType, bearerToken: decryptSupplierBearerToken(config, connectionId, credentialVersion, envelope) }
  try {
    const parsed = parsePaymentConfig(decryptPaymentConfig(config, kayixinCredentialContext(connectionId, credentialVersion), envelope))
    if (Object.keys(parsed).sort().join(',') !== 'appId,appSecret' || !/^[0-9]{1,32}$/u.test(parsed.appId ?? '')
      || !/^[!-~]{1,512}$/u.test(parsed.appSecret ?? '')) throw new SupplierCredentialKeyUnavailableError()
    return { providerType, appId: parsed.appId!, appSecret: parsed.appSecret! }
  } catch { throw new SupplierCredentialKeyUnavailableError() }
}

function apiResultRing(config: AppConfig): PaymentCredentialKeyRing {
  if (!config.codePoolEncryptionKeyRing) throw new ApiDeliveryKeyUnavailableError()
  return config.codePoolEncryptionKeyRing
}

function resultKey(config: AppConfig, keyId: string): Buffer {
  const key = apiResultRing(config).keys[keyId]
  if (!key) throw new ApiDeliveryKeyUnavailableError()
  return createHmac('sha256', key).update('aikayun:supplier-api-result:encryption:v1', 'utf8').digest()
}

function digestKey(config: AppConfig, keyId: string): Buffer {
  const key = apiResultRing(config).keys[keyId]
  if (!key) throw new ApiDeliveryKeyUnavailableError()
  return createHmac('sha256', key).update('aikayun:supplier-api-result:digest:v1', 'utf8').digest()
}

export function apiDeliveryResultContext(operationId: string): string {
  return `aikayun:supplier-api-result:v1:${operationId}`
}

export function apiDeliveryResultDigest(config: AppConfig, result: ApiDeliveryResult, keyId = apiResultRing(config).activeKeyId): string {
  return createHmac('sha256', digestKey(config, keyId)).update(JSON.stringify(result), 'utf8').digest('hex')
}

export function encryptApiDeliveryResult(
  config: AppConfig,
  operationId: string,
  result: ApiDeliveryResult,
  keyId = apiResultRing(config).activeKeyId,
): EncryptedApiDeliveryResult {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', resultKey(config, keyId), nonce)
  cipher.setAAD(Buffer.from(apiDeliveryResultContext(operationId), 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(result), 'utf8'), cipher.final()])
  return { keyId, nonce, ciphertext, authTag: cipher.getAuthTag() }
}

export function decryptApiDeliveryResult(
  config: AppConfig,
  operationId: string,
  envelope: EncryptedApiDeliveryResult,
): ApiDeliveryResult {
  try {
    const decipher = createDecipheriv('aes-256-gcm', resultKey(config, envelope.keyId), envelope.nonce)
    decipher.setAAD(Buffer.from(apiDeliveryResultContext(operationId), 'utf8'))
    decipher.setAuthTag(envelope.authTag)
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiDeliveryDecryptionError()
    const value = parsed as Record<string, unknown>
    if (!['code', 'text', 'redemption', 'link', 'completed'].includes(String(value.type))
      || (value.content !== null && typeof value.content !== 'string')
      || (value.title !== null && typeof value.title !== 'string')
      || (value.instructions !== null && typeof value.instructions !== 'string')) {
      throw new ApiDeliveryDecryptionError()
    }
    return value as unknown as ApiDeliveryResult
  } catch (error) {
    if (error instanceof ApiDeliveryKeyUnavailableError) throw error
    throw new ApiDeliveryDecryptionError()
  }
}
