import { constants as fsConstants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseStrictJson } from './strict-json.js'

const fileName = 'license-time-watermark.json'
const temporaryName = '.license-time-watermark.tmp'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const digestPattern = /^[A-Za-z0-9_-]{43}$/u

export interface TimeWatermarkIdentity {
  databaseId: string
  instanceId: string
  identityJkt: string
}

export interface TimeWatermarkRecord extends TimeWatermarkIdentity {
  schema: 1
  high_water_ms: number
}

export type TimeWatermarkRead =
  | { readonly status: 'valid'; readonly record: TimeWatermarkRecord }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' }

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function safeIdentity(value: Record<string, unknown>): TimeWatermarkIdentity | null {
  if (typeof value.database_id !== 'string' || !uuidPattern.test(value.database_id) ||
    typeof value.instance_id !== 'string' || !uuidPattern.test(value.instance_id) ||
    typeof value.identity_jkt !== 'string' || !digestPattern.test(value.identity_jkt)) return null
  return { databaseId: value.database_id, instanceId: value.instance_id, identityJkt: value.identity_jkt }
}

function validHighWater(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function validateRoot(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700 ||
    (currentUid() !== undefined && info.uid !== currentUid())) throw new Error('time_watermark_root_invalid')
}

export async function readTrustedTimeWatermark(
  directory: string,
  expectedIdentity: TimeWatermarkIdentity,
): Promise<TimeWatermarkRead> {
  const root = resolve(directory)
  await validateRoot(root)
  const path = join(root, fileName)
  let before
  try {
    before = await lstat(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 ||
    (currentUid() !== undefined && before.uid !== currentUid()) || before.size > 2048) return { status: 'corrupt' }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const after = await handle.stat()
    if (!after.isFile() || after.nlink !== 1 || (after.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && after.uid !== currentUid()) || before.dev !== after.dev || before.ino !== after.ino ||
      after.size > 2048) return { status: 'corrupt' }
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  try {
    const parsed = parseStrictJson(bytes) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'database_id,high_water_ms,identity_jkt,instance_id,schema' ||
      parsed.schema !== 1 || !validHighWater(parsed.high_water_ms)) return { status: 'corrupt' }
    const identity = safeIdentity(parsed)
    if (!identity || identity.databaseId !== expectedIdentity.databaseId ||
      identity.instanceId !== expectedIdentity.instanceId || identity.identityJkt !== expectedIdentity.identityJkt) {
      return { status: 'corrupt' }
    }
    return { status: 'valid', record: {
      schema: 1, ...identity, high_water_ms: parsed.high_water_ms,
    } }
  } catch {
    return { status: 'corrupt' }
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0))
  try { await handle.sync() } finally { await handle.close() }
}

/** Caller must hold the instance_license_state singleton row lock across this file update and DB write. */
export async function advanceTrustedTimeWatermarkFile(
  directory: string,
  identity: TimeWatermarkIdentity,
  highWaterMs: number,
): Promise<void> {
  if (!validHighWater(highWaterMs)) throw new Error('time_watermark_value_invalid')
  const root = resolve(directory)
  await validateRoot(root)
  const path = join(root, fileName)
  const temporaryPath = join(root, temporaryName)
  const current = await readTrustedTimeWatermark(root, identity)
  const alreadyHigh = current.status === 'valid' && current.record.high_water_ms >= highWaterMs

  // An orphan can only remain when SIGKILL interrupted the atomic write. The DB row lock
  // serializes writers from all API processes before this deterministic temp name is reused.
  try {
    const orphan = await lstat(temporaryPath)
    if (orphan.isSymbolicLink() || !orphan.isFile() || orphan.nlink !== 1 || (orphan.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && orphan.uid !== currentUid())) throw new Error('time_watermark_temp_invalid')
    await unlink(temporaryPath)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (alreadyHigh) return

  const document: TimeWatermarkRecord = {
    schema: 1,
    databaseId: identity.databaseId,
    instanceId: identity.instanceId,
    identityJkt: identity.identityJkt,
    high_water_ms: highWaterMs,
  }
  // The durable JSON uses protocol field names; keeping this conversion explicit avoids
  // accidentally writing the public TypeScript property casing to disk.
  const encoded = JSON.stringify({
    schema: document.schema,
    database_id: document.databaseId,
    instance_id: document.instanceId,
    identity_jkt: document.identityJkt,
    high_water_ms: document.high_water_ms,
  }) + '\n'
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(encoded, 'utf8')
    await handle.chmod(0o600)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporaryPath, path)
  await fsyncDirectory(root)
}

export const trustedTimeWatermarkFileName = fileName
