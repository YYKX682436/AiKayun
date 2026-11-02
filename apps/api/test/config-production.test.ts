import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'

const testRoot = mkdtempSync(join(tmpdir(), 'aikayun-production-config-'))
afterAll(() => rmSync(testRoot, { recursive: true, force: true }))

function secretFile(name: string, contents: string, mode = 0o600): string {
  const path = join(testRoot, name)
  writeFileSync(path, contents, { mode })
  chmodSync(path, mode)
  return path
}

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://aikayun_app:isolated-test-only@127.0.0.1/aikayun_test',
    PUBLIC_ORIGIN: 'https://www.iana.org',
    COOKIE_SECURE: 'true',
    TRUST_PROXY_CIDRS: '127.0.0.1/32',
    MEDIA_ROOT: '/var/lib/aikayun/media',
    PRIVATE_FILE_ROOT: '/var/lib/aikayun/private-files',
    INSTANCE_IDENTITY_ROOT: '/var/lib/aikayun/identity',
    LICENSE_TRUST_STORE_ROOT: '/var/lib/aikayun/license-trust',
    LICENSE_PENDING_KEY_ROOT: '/var/lib/aikayun/license-pending',
  }
}

function productionEnvironmentWithDatabaseFile(path: string): NodeJS.ProcessEnv {
  const env = productionEnvironment()
  delete env.DATABASE_URL
  env.DATABASE_URL_FILE = path
  return env
}

it('loads database and encryption key rings from private *_FILE secrets', () => {
  const databaseUrl = 'postgresql://aikayun_app:file-only-test@127.0.0.1/aikayun_test'
  const databaseFile = secretFile('database.url', `${databaseUrl}\n`)
  const paymentKey = Buffer.alloc(32, 9).toString('base64')
  const deliveryKey = Buffer.alloc(32, 10).toString('base64')
  const paymentFile = secretFile('payment-keys.json', JSON.stringify({ activeKeyId: 'current', keys: { current: paymentKey } }))
  const deliveryFile = secretFile('delivery-keys.json', JSON.stringify({ activeKeyId: 'current', keys: { current: deliveryKey } }))

  const config = readConfig({
    ...productionEnvironmentWithDatabaseFile(databaseFile),
    PAYMENT_CREDENTIAL_KEY_RING_FILE: paymentFile,
    CODE_POOL_ENCRYPTION_KEY_RING_FILE: deliveryFile,
  })

  expect(config.database.connectionString).toBe(databaseUrl)
  expect(config.paymentCredentialKeyRing?.keys.current?.equals(Buffer.alloc(32, 9))).toBe(true)
  expect(config.codePoolEncryptionKeyRing?.keys.current?.equals(Buffer.alloc(32, 10))).toBe(true)
})

it('rejects simultaneous secret values and files, and rejects weak production file modes', () => {
  const databaseFile = secretFile('conflicting-database.url', 'postgresql://aikayun_app:test@127.0.0.1/aikayun_test')
  const keyFile = secretFile('conflicting-payment-keys.json', JSON.stringify({
    activeKeyId: 'current', keys: { current: Buffer.alloc(32, 11).toString('base64') },
  }))
  const weakDatabaseFile = secretFile('weak-database.url', 'postgresql://aikayun_app:test@127.0.0.1/aikayun_test', 0o644)

  expect(() => readConfig({ ...productionEnvironment(), DATABASE_URL_FILE: databaseFile }))
    .toThrow('CONFIG_CONFLICT: set only one of DATABASE_URL and DATABASE_URL_FILE')
  expect(() => readConfig({ ...productionEnvironment(),
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({ activeKeyId: 'current', keys: { current: Buffer.alloc(32, 11).toString('base64') } }),
    PAYMENT_CREDENTIAL_KEY_RING_FILE: keyFile }))
    .toThrow('CONFIG_CONFLICT: set only one of PAYMENT_CREDENTIAL_KEY_RING and PAYMENT_CREDENTIAL_KEY_RING_FILE')
  expect(() => readConfig(productionEnvironmentWithDatabaseFile(weakDatabaseFile)))
    .toThrow('DATABASE_URL_FILE must be a bounded, single-link regular file with mode 0400 or 0600')
})

it('rejects production database URL and split connection fields together', () => {
  expect(() => readConfig({ ...productionEnvironment(), PGHOST: 'postgres' }))
    .toThrow('CONFIG_CONFLICT: set DATABASE_URL or PostgreSQL host fields, not both')
})

it('does not load a development .env file in a production process', () => {
  const workingDirectory = join(testRoot, 'production-process')
  mkdirSync(workingDirectory)
  writeFileSync(join(workingDirectory, '.env'), 'SUPPLIER_HTTP_TEST_ALLOWLIST=http://127.0.0.1:9911\n', { mode: 0o600 })
  const databaseFile = secretFile('isolated-production.database-url',
    'postgresql://aikayun_app:file-only-test@127.0.0.1/aikayun_test')
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/config.ts')).href
  const code = `import { readConfig } from ${JSON.stringify(moduleUrl)}; const config = readConfig(); process.stdout.write(config.nodeEnv)`
  const env = productionEnvironmentWithDatabaseFile(databaseFile)
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    cwd: workingDirectory,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  })

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('production')
})

it('rejects test endpoints and insecure production origins', () => {
  expect(() => readConfig({ ...productionEnvironment(), TEST_DATABASE_URL: 'postgresql://localhost/aikayun_test' }))
    .toThrow('Test-only configuration is forbidden in production')
  expect(() => readConfig({ ...productionEnvironment(), PUBLIC_ORIGIN: 'http://store.customer-domain.com' }))
    .toThrow('Production requires an HTTPS PUBLIC_ORIGIN and COOKIE_SECURE=true')
})
