import { constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, closeSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PoolConfig } from 'pg'

if (process.env.NODE_ENV !== 'production') {
  const rootEnvCandidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(import.meta.dirname, '../../../.env'),
  ]
  const rootEnvPath = rootEnvCandidates.find((path) => existsSync(path))
  if (rootEnvPath) process.loadEnvFile(rootEnvPath)
}

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
  trustProxy: boolean | string[]
  sessionTtlSeconds: number
  mediaRoot: string
  privateFileRoot: string
  identityRoot: string
  licenseTrustStoreRoot: string
  licensePendingKeyRoot: string
  licenseTrustBundleFile?: string
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

function configuredSecret(env: NodeJS.ProcessEnv, name: string, maxBytes = 64 * 1024): string | undefined {
  const direct = env[name]
  const file = env[`${name}_FILE`]
  if (direct !== undefined && file !== undefined) throw new Error(`CONFIG_CONFLICT: set only one of ${name} and ${name}_FILE`)
  if (direct !== undefined) return direct
  if (file === undefined) return undefined
  if (!isAbsolute(file)) throw new Error(`${name}_FILE must be an absolute path`)
  let descriptor: number | undefined
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
    descriptor = openSync(file, fsConstants.O_RDONLY | noFollow)
    const info = fstatSync(descriptor)
    const mode = info.mode & 0o777
    if (!info.isFile() || info.size > maxBytes || (process.platform !== 'win32' &&
      (info.nlink !== 1 || (mode !== 0o400 && mode !== 0o600)))) {
      throw new Error(`${name}_FILE must be a bounded, single-link regular file with mode 0400 or 0600`)
    }
    return readFileSync(descriptor, 'utf8').trimEnd()
  } catch (error) {
    if (error instanceof Error && error.message.includes(`${name}_FILE`)) throw error
    throw new Error(`Unable to read ${name}_FILE`, { cause: error })
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function parseTrustedProxyCidrs(value: string): string[] {
  const entries = value.split(',').map(entry => entry.trim()).filter(Boolean)
  if (entries.length < 1 || entries.length > 32) throw new Error('TRUST_PROXY_CIDRS must contain 1 to 32 exact IPs or CIDRs')
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/')
    const family = address ? isIP(address) : 0
    const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : -1
    if (family === 0 || extra !== undefined || (prefix !== undefined &&
      (!/^(0|[1-9][0-9]{0,2})$/.test(prefix) || Number(prefix) > maxPrefix))) {
      throw new Error('TRUST_PROXY_CIDRS entries must be valid IP addresses or CIDRs')
    }
    if (prefix !== undefined && Number(prefix) === 0) throw new Error('TRUST_PROXY_CIDRS must not trust every address')
  }
  return [...new Set(entries)]
}

function databasePassword(env: NodeJS.ProcessEnv): string | undefined {
  const choices = ['PGPASSWORD', 'POSTGRES_PASSWORD']
  const configured = choices.flatMap(name => [env[name] !== undefined ? name : undefined,
    env[`${name}_FILE`] !== undefined ? `${name}_FILE` : undefined].filter((value): value is string => value !== undefined))
  if (configured.length > 1) throw new Error('CONFIG_CONFLICT: set only one PostgreSQL password source')
  if (configured.length === 0) return undefined
  const selected = configured[0]!
  return selected.endsWith('_FILE') ? configuredSecret(env, selected.slice(0, -5)) : env[selected]
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
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV must be development, test, or production')
  const origin = env.PUBLIC_ORIGIN ?? 'http://localhost:3000'
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.origin !== origin) {
    throw new Error('PUBLIC_ORIGIN must contain only the public scheme, host and optional port')
  }

  const cookieSecure = parseBoolean(env.COOKIE_SECURE, nodeEnv === 'production')
  if (nodeEnv === 'production' && (parsedOrigin.protocol !== 'https:' || !cookieSecure)) {
    throw new Error('Production requires an HTTPS PUBLIC_ORIGIN and COOKIE_SECURE=true')
  }
  if (nodeEnv === 'production' && (isIP(parsedOrigin.hostname) || parsedOrigin.hostname.endsWith('.localhost') ||
    /(^|\.)(test|example|invalid|local)$/i.test(parsedOrigin.hostname) ||
    /(^|\.)example\.(com|net|org)$/i.test(parsedOrigin.hostname))) {
    throw new Error('Production PUBLIC_ORIGIN must use a non-test public DNS hostname')
  }
  if (nodeEnv === 'production') {
    const testOnlyValues = ['TEST_DATABASE_URL', 'PAYMENT_PROVIDER_BASE_URL_FOR_TESTS', 'SUPPLIER_HTTP_TEST_ALLOWLIST']
    if (testOnlyValues.some(name => env[name] !== undefined)) throw new Error('Test-only configuration is forbidden in production')
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
  const configuredLicensePendingKeyRoot = env.LICENSE_PENDING_KEY_ROOT
  if (configuredLicensePendingKeyRoot && !isAbsolute(configuredLicensePendingKeyRoot)) {
    throw new Error('LICENSE_PENDING_KEY_ROOT must be an absolute path')
  }
  const licensePendingKeyRoot = resolve(configuredLicensePendingKeyRoot ?? join(xdgDataHome, 'aikayun', 'license-pending'))
  const configuredTrustBundleFile = env.LICENSE_TRUST_BUNDLE_FILE
  if (configuredTrustBundleFile && !isAbsolute(configuredTrustBundleFile)) {
    throw new Error('LICENSE_TRUST_BUNDLE_FILE must be an absolute path')
  }
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
  const preexistingPersistentRoots = [mediaRoot, privateFileRoot, identityRoot]
  if (preexistingPersistentRoots.some(root => isWithin(root, licenseTrustStoreRoot) || isWithin(licenseTrustStoreRoot, root))) {
    throw new Error('LICENSE_TRUST_STORE_ROOT must use its own isolated API storage namespace')
  }
  if ((repo && (isWithin(repo, licensePendingKeyRoot) || isWithin(licensePendingKeyRoot, repo)))
    || [...preexistingPersistentRoots, licenseTrustStoreRoot].some(root =>
      isWithin(root, licensePendingKeyRoot) || isWithin(licensePendingKeyRoot, root))) {
    throw new Error('LICENSE_PENDING_KEY_ROOT must use its own API-only storage namespace outside the repository')
  }

  if (nodeEnv === 'production') {
    const requiredRoots: Array<[string, string | undefined, string]> = [
      ['MEDIA_ROOT', configuredMediaRoot, mediaRoot],
      ['PRIVATE_FILE_ROOT', configuredPrivateFileRoot, privateFileRoot],
      ['INSTANCE_IDENTITY_ROOT', configuredIdentityRoot, identityRoot],
      ['LICENSE_TRUST_STORE_ROOT', configuredLicenseTrustStoreRoot, licenseTrustStoreRoot],
      ['LICENSE_PENDING_KEY_ROOT', configuredLicensePendingKeyRoot, licensePendingKeyRoot],
    ]
    for (const [name, configured, path] of requiredRoots) {
      if (!configured || !isWithin('/var/lib/aikayun', path) || path === '/var/lib/aikayun') {
        throw new Error(`${name} must be explicitly set to an isolated path under /var/lib/aikayun in production`)
      }
    }
  }

  const databaseUrl = configuredSecret(env, 'DATABASE_URL', 16 * 1024)
  const hasSplitDatabaseSettings = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSWORD_FILE',
    'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_PASSWORD_FILE']
    .some(name => env[name] !== undefined)
  if (nodeEnv === 'production' && databaseUrl !== undefined && hasSplitDatabaseSettings) {
    throw new Error('CONFIG_CONFLICT: set DATABASE_URL or PostgreSQL host fields, not both')
  }
  if (nodeEnv === 'production' && env.DATABASE_URL !== undefined && env.DATABASE_URL_FILE !== undefined) {
    throw new Error('CONFIG_CONFLICT: set only one of DATABASE_URL and DATABASE_URL_FILE')
  }
  const database: PoolConfig = databaseUrl !== undefined
    ? { connectionString: databaseUrl }
    : {
        host: env.PGHOST ?? '127.0.0.1',
        port: env.PGPORT ? Number(env.PGPORT) : 5432,
        database: env.PGDATABASE ?? env.POSTGRES_DB ?? 'aikayun',
        user: env.PGUSER ?? env.POSTGRES_USER ?? 'aikayun',
        password: databasePassword(env),
      }

  const supplierHttpTestAllowlist = env.SUPPLIER_HTTP_TEST_ALLOWLIST
    ? env.SUPPLIER_HTTP_TEST_ALLOWLIST.split(',').map(value => value.trim()).filter(Boolean)
    : []
  if (supplierHttpTestAllowlist.length && nodeEnv !== 'test') {
    throw new Error('SUPPLIER_HTTP_TEST_ALLOWLIST is only available in NODE_ENV=test')
  }
  for (const value of supplierHttpTestAllowlist) {
    let parsed: URL
    try { parsed = new URL(value) } catch { throw new Error('Supplier test allowlist entries must be HTTP(S) loopback origins') }
    const host = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value
      || !['localhost', '127.0.0.1', '::1'].includes(host)) {
      throw new Error('Supplier test allowlist entries must be exact HTTP(S) loopback origins')
    }
  }

  const rawTrustProxy = env.TRUST_PROXY
  const rawTrustProxyCidrs = env.TRUST_PROXY_CIDRS
  if (rawTrustProxy !== undefined && rawTrustProxyCidrs !== undefined) {
    throw new Error('CONFIG_CONFLICT: set TRUST_PROXY or TRUST_PROXY_CIDRS, not both')
  }
  let trustProxy: boolean | string[]
  if (nodeEnv === 'production') {
    if (rawTrustProxy !== undefined || rawTrustProxyCidrs === undefined) {
      throw new Error('Production requires explicit TRUST_PROXY_CIDRS and does not accept boolean TRUST_PROXY')
    }
    trustProxy = parseTrustedProxyCidrs(rawTrustProxyCidrs)
  } else if (rawTrustProxyCidrs !== undefined) {
    trustProxy = parseTrustedProxyCidrs(rawTrustProxyCidrs)
  } else {
    trustProxy = parseBoolean(rawTrustProxy, false)
  }

  return {
    nodeEnv,
    host: env.API_HOST ?? '127.0.0.1',
    port: env.API_PORT ? Number(env.API_PORT) : 3001,
    publicOrigin: origin,
    cookieSecure,
    trustProxy,
    sessionTtlSeconds: 60 * 60 * 12,
    mediaRoot,
    privateFileRoot,
    identityRoot,
    licenseTrustStoreRoot,
    licensePendingKeyRoot,
    ...(configuredTrustBundleFile ? { licenseTrustBundleFile: resolve(configuredTrustBundleFile) } : {}),
    supplierHttpTestAllowlist,
    database,
    paymentCredentialKeyRing: parsePaymentCredentialKeyRing(configuredSecret(env, 'PAYMENT_CREDENTIAL_KEY_RING')),
    codePoolEncryptionKeyRing: parseCodePoolEncryptionKeyRing(configuredSecret(env, 'CODE_POOL_ENCRYPTION_KEY_RING')),
  }
}
