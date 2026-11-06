import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackupPendingSummary } from './pending-summary.js'

// The set is deliberately fixed: silently accepting an omitted archive would
// make a syntactically valid but unrecoverable backup look complete.
export const backupArtifacts = ['database.dump', 'state.tar', 'deployment.tar', 'caddy-data.tar', 'caddy-config.tar'] as const
export type BackupArtifact = typeof backupArtifacts[number]
export type BackupManifest = {
  schema: 1
  product: 'aikayun'
  status: 'complete' | 'candidate'
  backup_set_id: string
  created_at: string
  quiesced_at: string
  service_restoration: 'restored' | 'not_needed'
  services_resumed_at: string | null
  completed_at: string
  release_id: string
  images: Record<'api' | 'web' | 'postgres' | 'caddy', string>
  database: { id: string; schema_head: string; migration_checksums_sha256: string }
  instance_identity_sha256: string
  binding: { instance_id: string; identity_jkt: string; pending_key_sha256: string }
  key_ids: { payment: string[]; delivery: string[]; pending: string }
  // Key fingerprints are stored only inside the authenticated encrypted set.
  key_material_proofs: { payment_active: string; delivery_active: string; payment: Record<string, string>; delivery: Record<string, string>; ciphertext_verification: 'not_verified' }
  trust_bundle: { status: 'uninitialized' | 'accepted'; bundle_version: string | null; artifact_sha256: string | null;
    state_digest: string | null; revoked_key_count: number; retired_key_count: number }
  tools: { pg_dump: string; restic: string }
  unresolved: BackupPendingSummary
  artifacts: Record<BackupArtifact, { size: number; sha256: string }>
}
export type DirectBackupManifest = Omit<BackupManifest, 'schema' | 'artifacts'> & {
  schema: 2
  source_snapshot_id: string
  database_dump: { size: number; sha256: string }
}

const digest = /^[a-f0-9]{64}$/
const identifier = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('INVALID_BACKUP_MANIFEST')
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value)
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

/** Validate the manifest independently of its authentication by restic. */
export function validateBackupManifest(input: unknown, allowCandidate = false): asserts input is BackupManifest {
  fields(input, ['schema', 'product', 'status', 'backup_set_id', 'created_at', 'quiesced_at', 'service_restoration', 'services_resumed_at',
    'completed_at', 'release_id', 'images', 'database', 'instance_identity_sha256', 'binding', 'key_ids', 'key_material_proofs', 'trust_bundle', 'tools', 'unresolved', 'artifacts'])
  if (input.schema !== 1 || input.product !== 'aikayun' || (input.status !== 'complete' && !(allowCandidate && input.status === 'candidate')) ||
      typeof input.backup_set_id !== 'string' || !uuid.test(input.backup_set_id) || !validId(input.release_id) ||
      !validTime(input.created_at) || !validTime(input.quiesced_at) || !validTime(input.completed_at) ||
      input.created_at > input.quiesced_at || input.quiesced_at > input.completed_at ||
      !((input.service_restoration === 'not_needed' && input.services_resumed_at === null) ||
        (input.service_restoration === 'restored' && validTime(input.services_resumed_at) &&
         input.quiesced_at <= input.services_resumed_at && input.services_resumed_at <= input.completed_at)) ||
      typeof input.instance_identity_sha256 !== 'string' ||
      !digest.test(input.instance_identity_sha256)) throw new Error('INVALID_BACKUP_MANIFEST')
  fields(input.images, ['api', 'web', 'postgres', 'caddy'])
  for (const value of Object.values(input.images)) if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('INVALID_BACKUP_MANIFEST')
  fields(input.database, ['id', 'schema_head', 'migration_checksums_sha256'])
  if (typeof input.database.id !== 'string' || !uuid.test(input.database.id) || !validId(input.database.schema_head) ||
      typeof input.database.migration_checksums_sha256 !== 'string' || !digest.test(input.database.migration_checksums_sha256)) throw new Error('INVALID_BACKUP_MANIFEST')
  fields(input.binding, ['instance_id', 'identity_jkt', 'pending_key_sha256'])
  if (typeof input.binding.instance_id !== 'string' || !uuid.test(input.binding.instance_id) ||
      typeof input.binding.identity_jkt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.binding.identity_jkt) ||
      typeof input.binding.pending_key_sha256 !== 'string' || !digest.test(input.binding.pending_key_sha256)) throw new Error('INVALID_BACKUP_MANIFEST')
  fields(input.key_ids, ['payment', 'delivery', 'pending'])
  if (!validId(input.key_ids.pending)) throw new Error('INVALID_BACKUP_MANIFEST')
  for (const ids of [input.key_ids.payment, input.key_ids.delivery]) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 256 || !ids.every(validId) || new Set(ids).size !== ids.length) throw new Error('INVALID_BACKUP_MANIFEST')
  }
  fields(input.key_material_proofs, ['payment_active', 'delivery_active', 'payment', 'delivery', 'ciphertext_verification'])
  if (input.key_material_proofs.ciphertext_verification !== 'not_verified') throw new Error('INVALID_BACKUP_MANIFEST')
  for (const [ids, active, proofs] of [
    [input.key_ids.payment, input.key_material_proofs.payment_active, input.key_material_proofs.payment],
    [input.key_ids.delivery, input.key_material_proofs.delivery_active, input.key_material_proofs.delivery],
  ] as const) {
    if (!Array.isArray(ids) || !ids.includes(active) || !proofs || typeof proofs !== 'object' || Array.isArray(proofs) ||
        Object.keys(proofs).sort().join(',') !== [...ids].sort().join(',') ||
        Object.values(proofs).some(value => typeof value !== 'string' || !digest.test(value))) throw new Error('INVALID_BACKUP_MANIFEST')
  }
  fields(input.trust_bundle, ['status', 'bundle_version', 'artifact_sha256', 'state_digest', 'revoked_key_count', 'retired_key_count'])
  const trust = input.trust_bundle
  if (!Number.isSafeInteger(trust.revoked_key_count) || (trust.revoked_key_count as number) < 0 ||
      !Number.isSafeInteger(trust.retired_key_count) || (trust.retired_key_count as number) < 0 ||
      !((trust.status === 'uninitialized' && trust.bundle_version === null && trust.artifact_sha256 === null && trust.state_digest === null &&
        trust.revoked_key_count === 0 && trust.retired_key_count === 0) ||
        (trust.status === 'accepted' && typeof trust.bundle_version === 'string' && /^[1-9][0-9]{0,18}$/.test(trust.bundle_version) &&
          typeof trust.artifact_sha256 === 'string' && /^[A-Za-z0-9_-]{43}$/.test(trust.artifact_sha256) &&
          typeof trust.state_digest === 'string' && /^[A-Za-z0-9_-]{43}$/.test(trust.state_digest)))) throw new Error('INVALID_BACKUP_MANIFEST')
  fields(input.tools, ['pg_dump', 'restic'])
  if (!validId(input.tools.pg_dump) || !validId(input.tools.restic)) throw new Error('INVALID_BACKUP_MANIFEST')
  fields(input.unresolved, ['paymentAttemptsPending', 'paymentRequests', 'paymentUnknown', 'paymentReconciliationCases',
    'refundsPending', 'refundAttemptsUncertain', 'withdrawalsPending', 'withdrawalAttemptsUncertain',
    'fulfillmentAttemptsUnfinished', 'deliveryItemsUnfinished', 'supplierOperationsUnfinished'])
  for (const count of Object.values(input.unresolved)) if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error('INVALID_BACKUP_MANIFEST')
  fields(input.artifacts, backupArtifacts)
  for (const artifact of Object.values(input.artifacts)) {
    fields(artifact, ['size', 'sha256'])
    if (!Number.isSafeInteger(artifact.size) || (artifact.size as number) <= 0 ||
        typeof artifact.sha256 !== 'string' || !digest.test(artifact.sha256)) throw new Error('INVALID_BACKUP_MANIFEST')
  }
}

/** Direct Restic source snapshots have no lossy tar members. The metadata
 * snapshot records the independently identified raw-source snapshot and the
 * PostgreSQL dump hash. Common business evidence follows the existing strict
 * manifest validator. */
export function validateDirectBackupManifest(input: unknown, allowCandidate = false): asserts input is DirectBackupManifest {
  fields(input, ['schema', 'product', 'status', 'backup_set_id', 'created_at', 'quiesced_at', 'service_restoration', 'services_resumed_at',
    'completed_at', 'release_id', 'images', 'database', 'instance_identity_sha256', 'binding', 'key_ids', 'key_material_proofs',
    'trust_bundle', 'tools', 'unresolved', 'source_snapshot_id', 'database_dump'])
  if (input.schema !== 2 || typeof input.source_snapshot_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.source_snapshot_id)) {
    throw new Error('INVALID_BACKUP_MANIFEST')
  }
  fields(input.database_dump, ['size', 'sha256'])
  if (!Number.isSafeInteger(input.database_dump.size) || (input.database_dump.size as number) <= 0 ||
      typeof input.database_dump.sha256 !== 'string' || !digest.test(input.database_dump.sha256)) throw new Error('INVALID_BACKUP_MANIFEST')
  const common: Record<string, unknown> = { ...(input as Record<string, unknown>), schema: 1,
    artifacts: Object.fromEntries(backupArtifacts.map(name => [name, { size: 1, sha256: 'a'.repeat(64) }])) }
  delete common.source_snapshot_id
  delete common.database_dump
  validateBackupManifest(common, allowCandidate)
}

async function hashArtifact(directory: string, name: BackupArtifact, signal?: AbortSignal) {
  // Fixed flat names + NOFOLLOW disallow archive paths and link substitution.
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || !Number.isSafeInteger(before.size)) throw new Error('INVALID_BACKUP_ARTIFACT')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) { if (signal?.aborted) throw new Error('BACKUP_ARTIFACT_INTERRUPTED'); hash.update(chunk) }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('BACKUP_ARTIFACT_CHANGED')
    return { size: before.size, sha256: hash.digest('hex') }
  } finally { await file.close() }
}

/** Caller must ensure the directory is private and no writer can change it. */
export async function checksumBackupArtifacts(directory: string, signal?: AbortSignal): Promise<BackupManifest['artifacts']> {
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('INVALID_BACKUP_DIRECTORY')
  const result = {} as BackupManifest['artifacts']
  for (const name of backupArtifacts) result[name] = await hashArtifact(directory, name, signal)
  return result
}

/** Verify a complete, already authenticated/decrypted set without extraction. */
export async function verifyBackupSet(directory: string, allowCandidate = false, signal?: AbortSignal): Promise<BackupManifest> {
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('INVALID_BACKUP_DIRECTORY')
  const names = await readdir(directory)
  if (names.length !== backupArtifacts.length + 1 || !names.includes('manifest.json') ||
      names.some(name => name !== 'manifest.json' && !backupArtifacts.includes(name as BackupArtifact))) throw new Error('UNEXPECTED_BACKUP_ARTIFACT')
  const file = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let manifest: unknown
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 65536) throw new Error('INVALID_BACKUP_MANIFEST')
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const after = await file.stat()
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('INVALID_BACKUP_MANIFEST')
    manifest = JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown
  } finally { await file.close() }
  validateBackupManifest(manifest, allowCandidate)
  const actual = await checksumBackupArtifacts(directory, signal)
  for (const name of backupArtifacts) {
    if (actual[name].size !== manifest.artifacts[name].size || actual[name].sha256 !== manifest.artifacts[name].sha256) throw new Error('BACKUP_ARTIFACT_MISMATCH')
  }
  return manifest
}
