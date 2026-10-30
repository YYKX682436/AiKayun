import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import vector from './fixtures/activation-intent-7-1b-3c-1.json' with { type: 'json' }
import { calculateJwkThumbprint } from 'jose'
import { activationCodeSha256, buildActivationIntent, ed25519IdentityJkt } from '../src/licensing/license-intent.js'
import { parsePendingKeyCliArguments, runPendingKeyCli } from '../src/licensing/pending-encryption-key-cli.js'
import {
  decryptLicensePendingBytes,
  encryptLicensePendingBytes,
  initializeTemporaryLicensePendingKey,
  LicensePendingKeyError,
  loadLicensePendingKey,
} from '../src/licensing/pending-encryption-key.js'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'aikayun-license-pending-test-'))
  roots.add(path)
  return path
}

const context = {
  operationId: '44444444-4444-4444-8444-444444444444',
  record: 'operation' as const,
  field: 'intent_payload' as const,
}

describe('⑦-1B-3C-1 activation intent digest', () => {
  it('matches the frozen authorization-center activation vector field-for-field', () => {
    const actual = buildActivationIntent(vector.input)
    expect(activationCodeSha256(vector.input.activationCode)).toBe(vector.activation_code_sha256)
    expect(actual.intentDigest).toBe(vector.intent_digest)
    expect(actual.canonicalIntent).not.toContain(vector.input.activationCode)
    expect(actual.canonicalIntent).toContain(vector.activation_code_sha256)
  })

  it('binds saved operation requests to the 3A Ed25519 identity JKT', async () => {
    const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: Buffer.alloc(32, 9).toString('base64url') }
    expect(ed25519IdentityJkt(publicJwk)).toBe(await calculateJwkThumbprint(publicJwk))
  })

  it('changes for each business-intent field and rejects malformed activation codes', () => {
    const input = vector.input
    const baseline = buildActivationIntent(input).intentDigest
    expect(buildActivationIntent({ ...input, licenseId: randomUUID() }).intentDigest).not.toBe(baseline)
    expect(buildActivationIntent({ ...input, activationCode: Buffer.alloc(32, 3).toString('base64url') }).intentDigest).not.toBe(baseline)
    expect(buildActivationIntent({ ...input, instanceId: randomUUID() }).intentDigest).not.toBe(baseline)
    expect(buildActivationIntent({ ...input, databaseId: randomUUID() }).intentDigest).not.toBe(baseline)
    expect(buildActivationIntent({ ...input, identityJkt: Buffer.alloc(32, 4).toString('base64url') }).intentDigest).not.toBe(baseline)
    expect(buildActivationIntent({ ...input, origin: null }).intentDigest).not.toBe(baseline)
    expect(() => activationCodeSha256('not-a-code')).toThrowError('invalid_activation_code')
    expect(() => buildActivationIntent({ ...input, origin: 'http://shop.example.test' }))
      .toThrowError('invalid_activation_origin')
    expect(() => buildActivationIntent({ ...input, origin: 'https://shop.example.test/path' }))
      .toThrowError('invalid_activation_origin')
  })
})

describe('independent AES-256-GCM pending key store', () => {
  it('round-trips sensitive bytes with row-bound AAD and survives a second load', async () => {
    const directory = await root()
    const { keyId } = await initializeTemporaryLicensePendingKey(directory, 'test')
    expect(await loadLicensePendingKey(directory)).toMatchObject({ keyId })
    const secret = Buffer.from('synthetic activation-code and signed-response bytes')
    const encrypted = await encryptLicensePendingBytes(directory, context, secret)
    expect(encrypted.ciphertext.toString('utf8')).not.toContain(secret.toString('utf8'))
    expect(await decryptLicensePendingBytes(directory, context, encrypted)).toEqual(secret)
    await expect(decryptLicensePendingBytes(directory, { ...context, operationId: randomUUID() }, encrypted))
      .rejects.toBeInstanceOf(LicensePendingKeyError)
    await expect(decryptLicensePendingBytes(directory, { ...context, field: 'center_evidence' }, encrypted))
      .rejects.toBeInstanceOf(LicensePendingKeyError)
    const file = join(directory, 'license-pending-aes-256-gcm.json')
    expect((await lstat(file)).mode & 0o777).toBe(0o600)
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
  })

  it('rejects tampering, a substituted key, and a changed key id', async () => {
    const first = await root()
    const second = await root()
    const { keyId } = await initializeTemporaryLicensePendingKey(first, 'test')
    await initializeTemporaryLicensePendingKey(second, 'test')
    const encrypted = await encryptLicensePendingBytes(first, context, Buffer.from('saved center bytes'))
    await expect(decryptLicensePendingBytes(second, context, encrypted)).rejects.toMatchObject({ code: 'pending_key_id_mismatch' })
    const tampered = JSON.parse(encrypted.ciphertext.toString('utf8')) as Record<string, unknown>
    const cipherText = String(tampered['ciphertext'])
    tampered['ciphertext'] = `${cipherText[0] === 'A' ? 'B' : 'A'}${cipherText.slice(1)}`
    await expect(decryptLicensePendingBytes(first, context, { keyId, ciphertext: Buffer.from(JSON.stringify(tampered)) }))
      .rejects.toBeInstanceOf(LicensePendingKeyError)

    const keyPath = join(first, 'license-pending-aes-256-gcm.json')
    const original = await readFile(keyPath, 'utf8')
    const changed = JSON.parse(original) as { schema: number; purpose: string; key_id: string; key: string }
    changed.key = Buffer.alloc(32, 0x55).toString('base64url')
    await writeFile(keyPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 })
    await expect(decryptLicensePendingBytes(first, context, { keyId, ciphertext: encrypted.ciphertext }))
      .rejects.toMatchObject({ code: 'pending_decryption_authentication_failed' })
    await writeFile(keyPath, original, { mode: 0o600 })
  })

  it('fails closed on missing, symlinked, hardlinked, or incorrectly permissioned key files without regenerating', async () => {
    const directory = await root()
    const file = join(directory, 'license-pending-aes-256-gcm.json')
    await expect(loadLicensePendingKey(directory)).rejects.toMatchObject({ code: 'pending_key_missing' })
    expect(await readdir(directory)).toEqual([])
    const rootLink = join(await root(), 'pending-root-link')
    await symlink(directory, rootLink)
    await expect(loadLicensePendingKey(rootLink)).rejects.toMatchObject({ code: 'pending_key_root_type_invalid' })
    await initializeTemporaryLicensePendingKey(directory, 'test')
    await chmod(directory, 0o755)
    await expect(loadLicensePendingKey(directory)).rejects.toMatchObject({ code: 'pending_key_root_permissions_invalid' })
    await chmod(directory, 0o700)
    const external = join(await root(), 'external-key-copy')
    await writeFile(external, await readFile(file), { mode: 0o600 })
    await unlink(file)
    await symlink(external, file)
    await expect(loadLicensePendingKey(directory)).rejects.toMatchObject({ code: 'pending_key_file_type_invalid' })
    await unlink(file)
    await writeFile(file, await readFile(external), { mode: 0o600 })
    const hardlinkPath = join(directory, 'hardlink')
    await link(file, hardlinkPath)
    await expect(loadLicensePendingKey(directory)).rejects.toMatchObject({ code: 'pending_key_file_type_invalid' })
    await unlink(hardlinkPath)
    await chmod(file, 0o644)
    await expect(loadLicensePendingKey(directory)).rejects.toMatchObject({ code: 'pending_key_file_permissions_invalid' })
    await chmod(file, 0o600)
    await writeFile(file, 'not-json', { mode: 0o600 })
    await expect(loadLicensePendingKey(directory)).rejects.toMatchObject({ code: 'pending_key_file_corrupt' })
    await unlink(file)
    await expect(loadLicensePendingKey(directory)).rejects.toMatchObject({ code: 'pending_key_missing' })
    expect(await readdir(directory)).toEqual([])
  })

  it('requires the explicit temporary-key command and rejects production or an unpaired test environment', async () => {
    expect(() => parsePendingKeyCliArguments(['init', '--temporary', '--environment', 'test', '--pending-key-dir', '/tmp/pending']))
      .not.toThrow()
    expect(() => parsePendingKeyCliArguments(['init', '--environment', 'test', '--pending-key-dir', '/tmp/pending']))
      .toThrowError(/--temporary/u)
    const parsed = parsePendingKeyCliArguments(['init', '--temporary', '--environment', 'test', '--pending-key-dir', '/tmp/pending'])
    await expect(runPendingKeyCli(parsed, 'production', 'postgres://localhost/aikayun_test'))
      .rejects.toMatchObject({ code: 'temporary_pending_key_environment_mismatch' })
    await expect(runPendingKeyCli(parsed, 'test', 'postgres://localhost/aikayun'))
      .rejects.toMatchObject({ code: 'temporary_pending_key_test_database_required' })
  })
})
