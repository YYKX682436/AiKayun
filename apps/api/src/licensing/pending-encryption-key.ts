import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const keyFileName = 'license-pending-aes-256-gcm.json'
const keyPurpose = 'aikayun-license-pending-aes-256-gcm-v1'
const keyIdPattern = /^[A-Za-z0-9_-]{1,48}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export class LicensePendingKeyError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LicensePendingKeyError'
  }
}

export interface LicensePendingKey {
  keyId: string
  key: Buffer
}

export interface PendingCiphertext {
  keyId: string
  ciphertext: Buffer
}

export interface PendingSecretContext {
  operationId: string
  record: 'operation' | 'attempt'
  field: 'intent_payload' | 'request_envelope' | 'center_response' | 'center_evidence' | 'center_result_jws'
  attemptNo?: number
}

interface StoredKeyFile {
  schema: 1
  purpose: typeof keyPurpose
  key_id: string
  key: string
}

function fail(code: string): never {
  throw new LicensePendingKeyError(code)
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function repositoryRoot(): string | undefined {
  for (const start of [process.cwd(), import.meta.dirname]) {
    let candidate = resolve(start)
    while (true) {
      try {
        requireApiRoot(candidate)
        return candidate
      } catch {
        const parent = dirname(candidate)
        if (parent === candidate) break
        candidate = parent
      }
    }
  }
  return undefined
}

function requireApiRoot(candidate: string): void {
  // The checks stay synchronous so repository discovery does not create or touch any files.
  if (!existsSync(resolve(candidate, 'apps/api/package.json')) || !existsSync(resolve(candidate, 'packages/contracts/package.json'))) {
    throw new Error('not repository root')
  }
}

function assertPathIsolated(root: string, forbiddenRoots: string[]): void {
  if (!isAbsolute(root)) fail('pending_key_root_must_be_absolute')
  const canonicalRoot = resolve(root)
  const repository = repositoryRoot()
  const protectedRoots = [...(repository ? [repository] : []), ...forbiddenRoots].map(path => resolve(path))
  if (protectedRoots.some(path => isWithin(path, canonicalRoot) || isWithin(canonicalRoot, path))) {
    fail('pending_key_root_not_isolated')
  }
}

async function validateRoot(root: string): Promise<void> {
  let info
  try {
    info = await lstat(root)
  } catch {
    fail('pending_key_root_missing')
  }
  if (info!.isSymbolicLink() || !info!.isDirectory()) fail('pending_key_root_type_invalid')
  if ((info!.mode & 0o777) !== 0o700 || (currentUid() !== undefined && info!.uid !== currentUid())) {
    fail('pending_key_root_permissions_invalid')
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0))
  try { await handle.sync() } finally { await handle.close() }
}

/** Explicit one-shot initializer. The CLI gates this to development/test and never overwrites a key. */
export async function initializeTemporaryLicensePendingKey(root: string, environment: string, forbiddenRoots: string[] = []): Promise<{ keyId: string }> {
  if ((environment !== 'development' && environment !== 'test') || process.env.NODE_ENV !== environment) {
    fail('temporary_pending_key_environment_forbidden')
  }
  assertPathIsolated(root, forbiddenRoots)
  const absoluteRoot = resolve(root)
  try {
    await mkdir(absoluteRoot, { recursive: true, mode: 0o700 })
  } catch {
    fail('pending_key_root_unavailable')
  }
  await validateRoot(absoluteRoot)
  const canonicalRoot = await realpath(absoluteRoot)
  assertPathIsolated(canonicalRoot, forbiddenRoots)

  const keyId = `lp-${randomUUID().replaceAll('-', '')}`
  const document: StoredKeyFile = {
    schema: 1,
    purpose: keyPurpose,
    key_id: keyId,
    key: randomBytes(32).toString('base64url'),
  }
  const finalPath = join(canonicalRoot, keyFileName)
  const temporaryPath = join(canonicalRoot, `.pending-key-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8')
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = undefined
    // link() gives create-if-absent semantics; a concurrent init cannot replace a key.
    await link(temporaryPath, finalPath)
    await unlink(temporaryPath)
    await fsyncDirectory(canonicalRoot)
    return { keyId }
  } catch {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    fail('pending_key_already_exists_or_unavailable')
  }
}

async function readProtectedKey(root: string): Promise<LicensePendingKey> {
  await validateRoot(root)
  const path = join(root, keyFileName)
  let before
  try { before = await lstat(path) } catch { fail('pending_key_missing') }
  if (before!.isSymbolicLink() || !before!.isFile() || before!.nlink !== 1) fail('pending_key_file_type_invalid')
  if ((before!.mode & 0o777) !== 0o600 || (currentUid() !== undefined && before!.uid !== currentUid())) {
    fail('pending_key_file_permissions_invalid')
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const after = await handle.stat()
    if (!after.isFile() || after.nlink !== 1 || (after.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && after.uid !== currentUid()) ||
      before!.dev !== after.dev || before!.ino !== after.ino || after.size > 4096) {
      fail('pending_key_file_changed_or_invalid')
    }
    bytes = await handle.readFile()
  } finally { await handle.close() }

  let value: unknown
  try { value = JSON.parse(bytes!.toString('utf8')) as unknown } catch { fail('pending_key_file_corrupt') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('pending_key_file_corrupt')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'key,key_id,purpose,schema' || record.schema !== 1 ||
    record.purpose !== keyPurpose || typeof record.key_id !== 'string' || !keyIdPattern.test(record.key_id) ||
    typeof record.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(record.key)) fail('pending_key_file_corrupt')
  const key = Buffer.from(record.key, 'base64url')
  if (key.length !== 32 || key.toString('base64url') !== record.key) fail('pending_key_file_corrupt')
  return { keyId: record.key_id, key }
}

export async function loadLicensePendingKey(root: string, forbiddenRoots: string[] = []): Promise<LicensePendingKey> {
  assertPathIsolated(root, forbiddenRoots)
  try {
    await validateRoot(resolve(root))
    const canonicalRoot = await realpath(root)
    assertPathIsolated(canonicalRoot, forbiddenRoots)
    return await readProtectedKey(canonicalRoot)
  } catch (error) {
    if (error instanceof LicensePendingKeyError) throw error
    fail('pending_key_unavailable')
  }
}

function aad(context: PendingSecretContext, keyId: string): Buffer {
  if (!uuidPattern.test(context.operationId)) fail('pending_cipher_context_invalid')
  if (context.record === 'operation' && context.field !== 'intent_payload' && context.field !== 'center_evidence') {
    fail('pending_cipher_context_invalid')
  }
  if (context.record === 'attempt' && context.field !== 'request_envelope' &&
    context.field !== 'center_response' && context.field !== 'center_result_jws') {
    fail('pending_cipher_context_invalid')
  }
  if (context.record === 'attempt' && (!Number.isSafeInteger(context.attemptNo) || context.attemptNo! < 1)) {
    fail('pending_cipher_context_invalid')
  }
  const attemptPart = context.record === 'attempt' ? `:${context.attemptNo}` : ''
  return Buffer.from(`aikayun-license-pending:v1:${context.record}:${context.operationId}${attemptPart}:${context.field}:${keyId}`, 'utf8')
}

export async function encryptLicensePendingBytes(
  root: string,
  context: PendingSecretContext,
  plaintext: Uint8Array,
  forbiddenRoots: string[] = [],
): Promise<PendingCiphertext> {
  const loaded = await loadLicensePendingKey(root, forbiddenRoots)
  try {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', loaded.key, nonce)
    cipher.setAAD(aad(context, loaded.keyId))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const envelope = {
      schema: 1,
      algorithm: 'A256GCM',
      key_id: loaded.keyId,
      nonce: nonce.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    }
    return { keyId: loaded.keyId, ciphertext: Buffer.from(JSON.stringify(envelope), 'utf8') }
  } catch (error) {
    if (error instanceof LicensePendingKeyError) throw error
    fail('pending_encryption_failed')
  }
}

export async function decryptLicensePendingBytes(
  root: string,
  context: PendingSecretContext,
  stored: PendingCiphertext,
  forbiddenRoots: string[] = [],
): Promise<Buffer> {
  const loaded = await loadLicensePendingKey(root, forbiddenRoots)
  try {
    if (stored.keyId !== loaded.keyId) fail('pending_key_id_mismatch')
    const envelopeValue: unknown = JSON.parse(stored.ciphertext.toString('utf8'))
    if (!envelopeValue || typeof envelopeValue !== 'object' || Array.isArray(envelopeValue)) fail('pending_ciphertext_corrupt')
    const envelope = envelopeValue as Record<string, unknown>
    if (Object.keys(envelope).sort().join(',') !== 'algorithm,ciphertext,key_id,nonce,schema,tag' ||
      envelope.schema !== 1 || envelope.algorithm !== 'A256GCM' || envelope.key_id !== loaded.keyId ||
      typeof envelope.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/u.test(envelope.nonce) ||
      typeof envelope.tag !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(envelope.tag) ||
      typeof envelope.ciphertext !== 'string' || !/^(?:[A-Za-z0-9_-]{2,})?$/u.test(envelope.ciphertext)) {
      fail('pending_ciphertext_corrupt')
    }
    const nonce = Buffer.from(envelope.nonce, 'base64url')
    const tag = Buffer.from(envelope.tag, 'base64url')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
    if (nonce.length !== 12 || tag.length !== 16 || nonce.toString('base64url') !== envelope.nonce ||
      tag.toString('base64url') !== envelope.tag || ciphertext.toString('base64url') !== envelope.ciphertext) {
      fail('pending_ciphertext_corrupt')
    }
    const decipher = createDecipheriv('aes-256-gcm', loaded.key, nonce)
    decipher.setAAD(aad(context, loaded.keyId))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    if (error instanceof LicensePendingKeyError) throw error
    fail('pending_decryption_authentication_failed')
  }
}
