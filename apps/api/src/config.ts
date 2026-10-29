import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PoolConfig } from 'pg'

const rootEnvCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(import.meta.dirname, '../../../.env'),
]
const rootEnvPath = rootEnvCandidates.find((path) => existsSync(path))
if (rootEnvPath) process.loadEnvFile(rootEnvPath)

function repositoryRoot(): string | undefined {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '../..'),
    resolve(import.meta.dirname, '../../..'),
  ]
  return candidates.find((candidate) =>
    existsSync(resolve(candidate, 'apps/api/package.json'))
      && existsSync(resolve(candidate, 'packages/contracts/package.json')))
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export interface AppConfig {
  nodeEnv: string
  host: string
  port: number
  publicOrigin: string
  cookieSecure: boolean
  trustProxy: boolean
  sessionTtlSeconds: number
  mediaRoot: string
  privateFileRoot: string
  identityRoot: string
  licenseTrustStoreRoot: string
  supplierHttpTestAllowlist: string[]
  database: PoolConfig
  paymentCredentialKeyRing: PaymentCredentialKeyRing | null
  codePoolEncryptionKeyRing: PaymentCredentialKeyRing | null
}

export interface PaymentCredentialKeyRing {
  activeKeyId: string
  keys: Record<string, Buffer>
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Boolean environment values must be true or false')
}

function parsePaymentCredentialKeyRing(value: string | undefined): PaymentCredentialKeyRing | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error('PAYMENT_CREDENTIAL_KEY_RING must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PAYMENT_CREDENTIAL_KEY_RING must contain an activeKeyId and keys object')
  }
  const record = parsed as { activeKeyId?: unknown; keys?: unknown }
  if (typeof record.activeKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/u.test(record.activeKeyId)
    || !record.keys || typeof record.keys !== 'object' || Array.isArray(record.keys)) {
    throw new Error('PAYMENT_CREDENTIAL_KEY_RING must contain an activeKeyId and keys object')
  }
  const keyEntries = Object.entries(record.keys as Record<string, unknown>)
  if (keyEntries.length < 1 || keyEntries.length > 16) {
    throw new Error('PAYMENT_CREDENTIAL_KEY_RING must contain between 1 and 16 keys')
  }
  const keys: Record<string, Buffer> = {}
  for (const [keyId, encoded] of keyEntries) {
    if (!/^[A-Za-z0-9_-]{1,48}$/u.test(keyId) || typeof encoded !== 'string') {
      throw new Error('PAYMENT_CREDENTIAL_KEY_RING contains an invalid key entry')
    }
    const key = Buffer.from(encoded, 'base64')
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new Error('Payment credential encryption keys must be canonical base64 encoded 32-byte values')
    }
    keys[keyId] = key
  }
  if (!keys[record.activeKeyId]) {
    throw new Error('PAYMENT_CREDENTIAL_KEY_RING activeKeyId must exist in keys')
  }
  return { activeKeyId: record.activeKeyId, keys }
}

function parseCodePoolEncryptionKeyRing(value: string | undefined): PaymentCredentialKeyRing | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error('CODE_POOL_ENCRYPTION_KEY_RING must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CODE_POOL_ENCRYPTION_KEY_RING must contain an activeKeyId and keys object')
  }
  const record = parsed as { activeKeyId?: unknown; keys?: unknown }
  if (typeof record.activeKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/u.test(record.activeKeyId)
    || !record.keys || typeof record.keys !== 'object' || Array.isArray(record.keys)) {
    throw new Error('CODE_POOL_ENCRYPTION_KEY_RING must contain an activeKeyId and keys object')
  }
  const keyEntries = Object.entries(record.keys as Record<string, unknown>)
  if (keyEntries.length < 1 || keyEntries.length > 16) {
    throw new Error('CODE_POOL_ENCRYPTION_KEY_RING must contain between 1 and 16 keys')
  }
  const keys: Record<string, Buffer> = {}
  for (const [keyId, encoded] of keyEntries) {
    if (!/^[A-Za-z0-9_-]{1,48}$/u.test(keyId) || typeof encoded !== 'string') {
      throw new Error('CODE_POOL_ENCRYPTION_KEY_RING contains an invalid key entry')
    }
    const key = Buffer.from(encoded, 'base64')
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new Error('Code-pool encryption keys must be canonical base64 encoded 32-byte values')
    }
    keys[keyId] = key
  }
  if (!keys[record.activeKeyId]) {
    throw new Error('CODE_POOL_ENCRYPTION_KEY_RING activeKeyId must exist in keys')
  }
  return { activeKeyId: record.activeKeyId, keys }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const origin = env.PUBLIC_ORIGIN ?? 'http://localhost:3000'
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.origin !== origin) {
    throw new Error('PUBLIC_ORIGIN must contain only the public scheme, host and optional port')
  }

  const cookieSecure = parseBoolean(env.COOKIE_SECURE, nodeEnv === 'production')
  const localHttpOrigin = parsedOrigin.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)
  if (nodeEnv === 'production' && !cookieSecure && !localHttpOrigin) {
    throw new Error('COOKIE_SECURE must be true in production')
  }

  const configuredMediaRoot = env.MEDIA_ROOT
  if (configuredMediaRoot && !isAbsolute(configuredMediaRoot)) {
    throw new Error('MEDIA_ROOT must be an absolute path')
  }
  const xdgDataHome = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  if (!isAbsolute(xdgDataHome)) throw new Error('XDG_DATA_HOME must be an absolute path')
  const mediaRoot = resolve(configuredMediaRoot ?? join(xdgDataHome, 'aikayun', 'media'))
  const configuredPrivateFileRoot = env.PRIVATE_FILE_ROOT
  if (configuredPrivateFileRoot && !isAbsolute(configuredPrivateFileRoot)) {
    throw new Error('PRIVATE_FILE_ROOT must be an absolute path')
  }
  const privateFileRoot = resolve(configuredPrivateFileRoot ?? join(xdgDataHome, 'aikayun', 'private-files'))
  const configuredIdentityRoot = env.INSTANCE_IDENTITY_ROOT
  if (configuredIdentityRoot && !isAbsolute(configuredIdentityRoot)) {
    throw new Error('INSTANCE_IDENTITY_ROOT must be an absolute path')
  }
  const identityRoot = resolve(configuredIdentityRoot ?? join(xdgDataHome, 'aikayun', 'identity'))
  const configuredLicenseTrustStoreRoot = env.LICENSE_TRUST_STORE_ROOT
  if (configuredLicenseTrustStoreRoot && !isAbsolute(configuredLicenseTrustStoreRoot)) {
    throw new Error('LICENSE_TRUST_STORE_ROOT must be an absolute path')
  }
  const licenseTrustStoreRoot = resolve(configuredLicenseTrustStoreRoot ?? join(xdgDataHome, 'aikayun', 'license-trust'))
  const repo = repositoryRoot()
  if (repo && isWithin(repo, mediaRoot)) {
    throw new Error('MEDIA_ROOT must be outside the repository')
  }
  if (repo && isWithin(repo, privateFileRoot)) {
    throw new Error('PRIVATE_FILE_ROOT must be outside the repository')
  }
  if (isWithin(mediaRoot, privateFileRoot) || isWithin(privateFileRoot, mediaRoot)) {
    throw new Error('PRIVATE_FILE_ROOT and MEDIA_ROOT must use isolated storage namespaces')
  }
  if (repo && isWithin(repo, identityRoot)) {
    throw new Error('INSTANCE_IDENTITY_ROOT must be outside the repository')
  }
  if (isWithin(mediaRoot, identityRoot) || isWithin(identityRoot, mediaRoot)
    || isWithin(privateFileRoot, identityRoot) || isWithin(identityRoot, privateFileRoot)) {
    throw new Error('INSTANCE_IDENTITY_ROOT, MEDIA_ROOT and PRIVATE_FILE_ROOT must use isolated storage namespaces')
  }
  if (repo && isWithin(repo, licenseTrustStoreRoot)) {
    throw new Error('LICENSE_TRUST_STORE_ROOT must be outside the repository')
  }
  const persistentRoots = [mediaRoot, privateFileRoot, identityRoot]
  if (persistentRoots.some(root => isWithin(root, licenseTrustStoreRoot) || isWithin(licenseTrustStoreRoot, root))) {
    throw new Error('LICENSE_TRUST_STORE_ROOT must use its own isolated API storage namespace')
  }

  const database: PoolConfig = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.PGHOST ?? '127.0.0.1',
        port: env.PGPORT ? Number(env.PGPORT) : 5432,
        database: env.PGDATABASE ?? env.POSTGRES_DB ?? 'aikayun',
        user: env.PGUSER ?? env.POSTGRES_USER ?? 'aikayun',
        password: env.PGPASSWORD ?? env.POSTGRES_PASSWORD,
      }

  const supplierHttpTestAllowlist = env.SUPPLIER_HTTP_TEST_ALLOWLIST
    ? env.SUPPLIER_HTTP_TEST_ALLOWLIST.split(',').map(value => value.trim()).filter(Boolean)
    : []
  if (supplierHttpTestAllowlist.length && nodeEnv !== 'test') {
    throw new Error('SUPPLIER_HTTP_TEST_ALLOWLIST is only available in NODE_ENV=test')
  }
  for (const value of supplierHttpTestAllowlist) {
    let parsed: URL
    try { parsed = new URL(value) } catch { throw new Error('Supplier test allowlist entries must be HTTP loopback origins') }
    const host = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    if (parsed.protocol !== 'http:' || parsed.origin !== value
      || !['localhost', '127.0.0.1', '::1'].includes(host)) {
      throw new Error('Supplier test allowlist entries must be exact HTTP loopback origins')
    }
  }

  return {
    nodeEnv,
    host: env.API_HOST ?? '127.0.0.1',
    port: env.API_PORT ? Number(env.API_PORT) : 3001,
    publicOrigin: origin,
    cookieSecure,
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    sessionTtlSeconds: 60 * 60 * 12,
    mediaRoot,
    privateFileRoot,
    identityRoot,
    licenseTrustStoreRoot,
    supplierHttpTestAllowlist,
    database,
    paymentCredentialKeyRing: parsePaymentCredentialKeyRing(env.PAYMENT_CREDENTIAL_KEY_RING),
    codePoolEncryptionKeyRing: parseCodePoolEncryptionKeyRing(env.CODE_POOL_ENCRYPTION_KEY_RING),
  }
}
