import { createHash } from 'node:crypto'
import { lstat, open, realpath, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createConnection } from 'node:net'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { readConfig } from '../config.js'
import { Pool } from 'pg'
import type { Database } from '../db/types.js'
import { readBackupDatabaseMetadata } from './database-metadata.js'
import { readBackupPendingSummary } from './pending-summary.js'
import { readBackupKeyReferences, assertPendingKeyReferences } from './key-references.js'
import { verifyDeploymentKeyRingBytes } from './deployment-keyring-pair.js'
import { verifyBackupIdentityPair } from './identity-pair.js'
import { validateDirectBackupManifest } from './manifest.js'
import { assertTrustBundleManifestMatch } from './state-archive-trust.js'
import { loadEmbeddedTrustedReleaseLicenseConfig } from '../licensing/trusted-release-config.js'
import { createReleaseBoundTrustStore } from '../licensing/trust/service.js'
import { verifyLicensePendingBackupPairReadOnly } from '../licensing/license-pending-restore-check.js'
import { readTrustedTimeWatermark } from '../licensing/trusted-time-watermark.js'
import { decryptPaymentConfig, parsePaymentConfig } from '../payments/credentials.js'
import { decryptCodePoolContent } from '../commerce/code-pool-crypto.js'
import { decryptFixedDeliveryPayload, fixedDeliveryDeliveryContext, fixedDeliveryPayloadDigest,
  fixedDeliveryVersionContext } from '../commerce/fixed-delivery-crypto.js'
import { decryptApiDeliveryResult } from '../commerce/supplier-api-crypto.js'
import { decryptPurchaseOrderValues, purchaseFormContentIdentity } from '../commerce/purchase-form-crypto.js'
import { PrivateFileStorage } from '../media/private-file-storage.js'
import { MediaStorage } from '../media/storage.js'
import { PurchaseAttachmentStorage } from '../media/purchase-attachment-storage.js'
import { PurchaseOrderAttachmentStorage } from '../media/purchase-order-attachment-storage.js'
import { reconcileProductMedia } from '../media/reconcile.js'
import { reconcilePrivateFiles } from '../media/private-file-reconcile.js'
import { reconcilePurchaseDrafts } from '../commerce/purchase-forms.js'
import { reconcilePurchaseOrderAttachments } from '../commerce/purchase-order-attachments.js'

const digest = /^[a-f0-9]{64}$/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
let restoreValidationStage = 'startup'

function required(name: string, pattern?: RegExp): string {
  const value = process.env[name]
  if (!value || (pattern && !pattern.test(value))) throw new Error('RESTORE_VALIDATION_CONFIGURATION_INVALID')
  return value
}

async function readProtectedFile(path: string, mode: number, maxBytes: number, owner = process.getuid?.()): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== owner ||
      before.gid !== process.getgid?.() || (before.mode & 0o777) !== mode || before.size < 1 || before.size > maxBytes) {
    throw new Error('RESTORE_VALIDATION_FILE_UNSAFE')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) {
      throw new Error('RESTORE_VALIDATION_FILE_CHANGED')
    }
    const bytes = await file.readFile()
    const after = await file.stat()
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      bytes.fill(0)
      throw new Error('RESTORE_VALIDATION_FILE_CHANGED')
    }
    return bytes
  } finally { await file.close() }
}

async function hashFile(path: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) {
      throw new Error('RESTORE_VALIDATION_FILE_UNSAFE')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let size = 0
    while (size < before.size) {
      const read = await file.read(buffer, 0, Math.min(buffer.length, before.size - size), size)
      if (!read.bytesRead) throw new Error('RESTORE_VALIDATION_FILE_CHANGED')
      hash.update(buffer.subarray(0, read.bytesRead)); size += read.bytesRead
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('RESTORE_VALIDATION_FILE_CHANGED')
    }
    return { size, sha256: hash.digest('hex') }
  } finally { await file.close() }
}

async function assertNoExternalRoute(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '1.1.1.1', port: 443 })
    const timer = setTimeout(() => { socket.destroy(); resolve() }, 1500)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('RESTORE_NETWORK_EGRESS_AVAILABLE')) })
    socket.once('error', () => { clearTimeout(timer); resolve() })
  })
}

async function verifyHistoricalDecryption(db: Kysely<Database>, config: ReturnType<typeof readConfig>) {
  let payments = 0, deliveries = 0, purchaseSnapshots = 0
  const channels = await db.selectFrom('payment_channels').selectAll().where('config_ciphertext', 'is not', null).execute()
  for (const row of channels) {
    if (!row.config_ciphertext || !row.config_nonce || !row.config_auth_tag || !row.config_key_id) throw new Error('RESTORE_PAYMENT_ENVELOPE_INCOMPLETE')
    const plaintext = decryptPaymentConfig(config, `payment-channel:${row.id}:credential:${row.credential_version}`, {
      keyId: row.config_key_id, nonce: row.config_nonce, ciphertext: row.config_ciphertext, authTag: row.config_auth_tag,
    })
    try { parsePaymentConfig(plaintext) } finally { plaintext.fill(0) }
    payments++
  }
  const attemptSecrets = await db.selectFrom('payment_attempt_secrets').selectAll().execute()
  for (const row of attemptSecrets) {
    const plaintext = decryptPaymentConfig(config, `payment-attempt:${row.payment_attempt_id}:config:${row.config_version}`, {
      keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
    })
    try { parsePaymentConfig(plaintext) } finally { plaintext.fill(0) }
    payments++
  }
  const supplierCredentials = await db.selectFrom('supplier_connection_credentials').selectAll().execute()
  for (const row of supplierCredentials) {
    const context = row.provider_type === 'kayixin_customer_v3'
      ? `aikayun:supplier-connection:credential:kayixin_customer_v3:v1:${row.supplier_connection_id}:${row.credential_version}`
      : `aikayun:supplier-connection:credential:v1:${row.supplier_connection_id}:${row.credential_version}`
    const plaintext = decryptPaymentConfig(config, context, {
      keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
    })
    try { parsePaymentConfig(plaintext) } finally { plaintext.fill(0) }
    payments++
  }
  const purchaseRows = await db.selectFrom('order_item_purchase_snapshots').selectAll()
    .where('encrypted_values', 'is not', null).orderBy('order_item_id').execute()
  for (const row of purchaseRows) {
    if (!row.template_version_id || !row.normalization_version || !row.encrypted_values || !row.values_nonce ||
        !row.values_auth_tag || !row.encryption_key_id) throw new Error('RESTORE_PURCHASE_SNAPSHOT_ENVELOPE_INCOMPLETE')
    const values = decryptPurchaseOrderValues(config, row.order_item_id, {
      keyId: row.encryption_key_id, nonce: row.values_nonce, ciphertext: row.encrypted_values, authTag: row.values_auth_tag,
    })
    if (purchaseFormContentIdentity(row.template_version_id, values) !== row.content_identity) {
      throw new Error('RESTORE_PURCHASE_SNAPSHOT_DECRYPTION_FAILED')
    }
    purchaseSnapshots++
  }
  const codePool = await db.selectFrom('code_pool_entries').selectAll().execute()
  for (const row of codePool) {
    const plaintext = decryptCodePoolContent(config, `aikayun:code-pool:entry:v1:${row.product_variant_id}:${row.id}`, {
      keyId: row.encryption_key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
    })
    if (!plaintext) throw new Error('RESTORE_DELIVERY_DECRYPTION_FAILED')
    deliveries++
  }
  const versions = await db.selectFrom('product_variant_fulfillment_versions').selectAll()
    .where('encrypted_content', 'is not', null).execute()
  for (const row of versions) {
    if (!row.encrypted_content || !row.content_nonce || !row.content_auth_tag || !row.encryption_key_id ||
        (row.method !== 'fixed_content' && row.method !== 'link')) throw new Error('RESTORE_DELIVERY_ENVELOPE_INCOMPLETE')
    const plaintext = decryptFixedDeliveryPayload(config, fixedDeliveryVersionContext(row.product_variant_id, row.id, row.method), row.method, {
      keyId: row.encryption_key_id, nonce: row.content_nonce, ciphertext: row.encrypted_content, authTag: row.content_auth_tag,
    })
    if (!plaintext || fixedDeliveryPayloadDigest(config, plaintext, row.encryption_key_id) !== row.content_sha256) {
      throw new Error('RESTORE_DELIVERY_DECRYPTION_FAILED')
    }
    deliveries++
  }
  const savedDeliveries = await sql<{
    id: string; order_item_id: string; delivery_source: string; content_sha256: string; encrypted_content: Buffer | null; content_nonce: Buffer | null
    content_auth_tag: Buffer | null; encryption_key_id: string | null; code_pool_entry_id: string | null
    fulfillment_content_version_id: string | null; version_method: string | null; supplier_api_operation_id: string | null
  }>`
    SELECT d.id::text, i.id::text AS order_item_id, d.delivery_source, d.content_sha256, d.encrypted_content, d.content_nonce,
      d.content_auth_tag, d.encryption_key_id, d.code_pool_entry_id, d.fulfillment_content_version_id,
      v.method AS version_method, d.supplier_api_operation_id
    FROM order_item_fulfillment_deliveries d
    JOIN order_item_fulfillment_attempts a ON a.id = d.fulfillment_attempt_id
    JOIN order_items i ON i.id = a.order_item_id
    LEFT JOIN product_variant_fulfillment_versions v ON v.id = d.fulfillment_content_version_id
    WHERE d.encrypted_content IS NOT NULL ORDER BY d.id
  `.execute(db)
  for (const row of savedDeliveries.rows) {
    if (!row.encrypted_content || !row.content_nonce || !row.content_auth_tag || !row.encryption_key_id) throw new Error('RESTORE_DELIVERY_ENVELOPE_INCOMPLETE')
    if (row.delivery_source === 'code_pool') {
      if (!row.code_pool_entry_id) throw new Error('RESTORE_DELIVERY_ENVELOPE_INCOMPLETE')
      const plaintext = decryptCodePoolContent(config, `code-pool-delivery:${row.order_item_id}:${row.id}:${row.code_pool_entry_id}`, {
        keyId: row.encryption_key_id, nonce: row.content_nonce, ciphertext: row.encrypted_content, authTag: row.content_auth_tag,
      })
      if (!plaintext) throw new Error('RESTORE_DELIVERY_DECRYPTION_FAILED')
    } else if (row.delivery_source === 'fixed_content' || row.delivery_source === 'link') {
      if (!row.fulfillment_content_version_id || row.version_method !== row.delivery_source) throw new Error('RESTORE_DELIVERY_ENVELOPE_INCOMPLETE')
      const plaintext = decryptFixedDeliveryPayload(config,
        fixedDeliveryDeliveryContext(row.order_item_id, row.id, row.fulfillment_content_version_id,
          row.delivery_source as 'fixed_content' | 'link'), row.delivery_source as 'fixed_content' | 'link', {
          keyId: row.encryption_key_id, nonce: row.content_nonce, ciphertext: row.encrypted_content, authTag: row.content_auth_tag,
        })
      if (!plaintext || fixedDeliveryPayloadDigest(config, plaintext, row.encryption_key_id) !== row.content_sha256) {
        throw new Error('RESTORE_DELIVERY_DECRYPTION_FAILED')
      }
    } else if (row.delivery_source === 'api') {
      if (!row.supplier_api_operation_id) throw new Error('RESTORE_DELIVERY_ENVELOPE_INCOMPLETE')
      const plaintext = decryptApiDeliveryResult(config, row.supplier_api_operation_id, {
        keyId: row.encryption_key_id, nonce: row.content_nonce, ciphertext: row.encrypted_content, authTag: row.content_auth_tag,
      })
      if (!plaintext) throw new Error('RESTORE_DELIVERY_DECRYPTION_FAILED')
    } else throw new Error('RESTORE_DELIVERY_SOURCE_UNSUPPORTED')
    deliveries++
  }
  const apiResults = await db.selectFrom('supplier_api_delivery_operations').selectAll().where('result_ciphertext', 'is not', null).execute()
  for (const row of apiResults) {
    if (!row.result_ciphertext || !row.result_nonce || !row.result_auth_tag || !row.result_key_id || !row.result_sha256) {
      throw new Error('RESTORE_DELIVERY_ENVELOPE_INCOMPLETE')
    }
    const plaintext = decryptApiDeliveryResult(config, row.operation_id, {
      keyId: row.result_key_id, nonce: row.result_nonce, ciphertext: row.result_ciphertext, authTag: row.result_auth_tag,
    })
    if (!plaintext) throw new Error('RESTORE_DELIVERY_DECRYPTION_FAILED')
    deliveries++
  }
  return { paymentEnvelopesDecrypted: payments, deliveryEnvelopesDecrypted: deliveries,
    purchaseSnapshotsDecrypted: purchaseSnapshots }
}

async function verifyPrivateFiles(db: Kysely<Database>, root: string): Promise<number> {
  const storage = new PrivateFileStorage(root)
  const objects = await db.selectFrom('private_file_objects').select(['id', 'size_bytes', 'sha256'])
    .where('status', '=', 'available').orderBy('id').execute()
  for (const object of objects) {
    if (!object.size_bytes || !object.sha256 || !digest.test(object.sha256)) throw new Error('RESTORE_PRIVATE_FILE_METADATA_INVALID')
    const file = await storage.openVerified(object.id, { sizeBytes: object.size_bytes, sha256: object.sha256 })
    await file.handle.close()
  }
  return objects.length
}

async function verifyMediaAndAttachments(db: Kysely<Database>, config: ReturnType<typeof readConfig>) {
  const media = await reconcileProductMedia(db, new MediaStorage(config.mediaRoot))
  if (media.needsAttention || media.verifiedVariants !== media.metadataVariants) {
    throw new Error('RESTORE_PUBLIC_MEDIA_INTEGRITY_FAILED')
  }

  const privateFiles = await reconcilePrivateFiles(db, new PrivateFileStorage(config.privateFileRoot), 'check')
  if (privateFiles.needsAttention || privateFiles.unknownObjects !== 0 ||
      privateFiles.verifiedObjects !== privateFiles.referencedObjects) {
    throw new Error('RESTORE_PRIVATE_FILE_INTEGRITY_FAILED')
  }

  const draftStorage = new PurchaseAttachmentStorage(config.privateFileRoot)
  const draftReconciliation = await reconcilePurchaseDrafts(db, draftStorage, { repair: false })
  if (draftReconciliation.missingObjects || draftReconciliation.deletingAttachments || draftReconciliation.oldOrphanFiles) {
    throw new Error('RESTORE_PURCHASE_DRAFT_FILE_INTEGRITY_FAILED')
  }
  const draftFiles = await db.selectFrom('purchase_draft_attachments').select(['id', 'storage_key', 'byte_size', 'sha256'])
    .where('status', '=', 'ready').orderBy('id').execute()
  for (const row of draftFiles) {
    if (!row.byte_size || !row.sha256 || !digest.test(row.sha256.trim())) throw new Error('RESTORE_PURCHASE_DRAFT_FILE_METADATA_INVALID')
    const bytes = await draftStorage.readVerified(row.id, row.storage_key, row.byte_size, row.sha256.trim())
    if (bytes.length !== row.byte_size || createHash('sha256').update(bytes).digest('hex') !== row.sha256.trim()) {
      bytes.fill(0)
      throw new Error('RESTORE_PURCHASE_DRAFT_FILE_INTEGRITY_FAILED')
    }
    bytes.fill(0)
  }

  const orderStorage = new PurchaseOrderAttachmentStorage(config.privateFileRoot)
  const orderReconciliation = await reconcilePurchaseOrderAttachments(db, orderStorage, { repair: false })
  if (orderReconciliation.missingRetained || orderReconciliation.orphanFiles || orderReconciliation.deleting) {
    throw new Error('RESTORE_PURCHASE_ORDER_FILE_INTEGRITY_FAILED')
  }
  const orderFiles = await db.selectFrom('purchase_order_attachment_objects').select(['id', 'storage_key', 'byte_size', 'sha256'])
    .where('status', '=', 'retained').orderBy('id').execute()
  for (const row of orderFiles) {
    if (!row.byte_size || !row.sha256 || !digest.test(row.sha256.trim())) throw new Error('RESTORE_PURCHASE_ORDER_FILE_METADATA_INVALID')
    const bytes = await orderStorage.readVerified(row.id, row.storage_key, row.byte_size, row.sha256.trim())
    if (bytes.length !== row.byte_size || createHash('sha256').update(bytes).digest('hex') !== row.sha256.trim()) {
      bytes.fill(0)
      throw new Error('RESTORE_PURCHASE_ORDER_FILE_INTEGRITY_FAILED')
    }
    bytes.fill(0)
  }
  return { publicMediaVariantsSha256Verified: media.verifiedVariants,
    privateFileObjectsSha256Verified: privateFiles.verifiedObjects,
    purchaseDraftAttachmentsSha256Verified: draftFiles.length,
    purchaseOrderAttachmentsSha256Verified: orderFiles.length }
}

async function inspectUninitializedTrustStore(root: string) {
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() ||
      directory.gid !== process.getgid?.() || (directory.mode & 0o777) !== 0o700 || await realpath(root) !== root) {
    throw new Error('RESTORE_VALIDATION_TRUST_STORE_INVALID')
  }
  const names = await readdir(root)
  if (names.some(name => name !== '.trust-bundle.kernel-lock')) throw new Error('RESTORE_VALIDATION_TRUST_STORE_UNEXPECTED_FILES')
  if (names.includes('.trust-bundle.kernel-lock')) {
    const lock = await lstat(`${root}/.trust-bundle.kernel-lock`)
    if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1 || lock.uid !== process.getuid?.() ||
        lock.gid !== process.getgid?.() || (lock.mode & 0o777) !== 0o600 || lock.size !== 0) {
      throw new Error('RESTORE_VALIDATION_TRUST_STORE_INVALID')
    }
  }
  return { status: 'uninitialized' as const, bundleVersion: null, artifactSha256: null, stateDigest: null,
    revokedKeyCount: 0, retiredKeyCount: 0 }
}

export async function runIsolatedRestoreVerification(): Promise<void> {
  restoreValidationStage = 'runtime'
  if (process.platform !== 'linux' || process.getuid?.() !== 1000 || process.env.NODE_ENV !== 'production') {
    throw new Error('RESTORE_VALIDATION_RUNTIME_INVALID')
  }
  restoreValidationStage = 'network-isolation'
  await assertNoExternalRoute()
  restoreValidationStage = 'manifest-read'
  const set = required('AIKAYUN_RESTORE_SET_ID', uuid)
  const sourceSnapshot = required('AIKAYUN_RESTORE_SOURCE_SNAPSHOT_ID', digest)
  const manifestSnapshot = required('AIKAYUN_RESTORE_MANIFEST_SNAPSHOT_ID', digest)
  const runId = required('AIKAYUN_RESTORE_RUN_ID', uuid)
  const manifestPath = '/run/restore/manifest/manifest.json'
  const manifestBytes = await readProtectedFile(manifestPath, 0o400, 65536)
  restoreValidationStage = 'manifest-json-parse'
  let manifest: unknown
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown } catch { manifestBytes.fill(0); throw new Error('RESTORE_VALIDATION_MANIFEST_INVALID') }
  manifestBytes.fill(0)
  restoreValidationStage = 'manifest-schema'
  validateDirectBackupManifest(manifest, true)
  restoreValidationStage = 'manifest-binding'
  if (manifest.status !== 'candidate' || manifest.backup_set_id !== set || manifest.source_snapshot_id !== sourceSnapshot ||
      required('AIKAYUN_RESTORE_RELEASE_ID') !== manifest.release_id ||
      manifest.images.api !== required('AIKAYUN_RESTORE_API_DIGEST', /^sha256:[a-f0-9]{64}$/u) ||
      manifest.images.web !== required('AIKAYUN_RESTORE_WEB_DIGEST', /^sha256:[a-f0-9]{64}$/u) ||
      manifest.images.postgres !== required('AIKAYUN_RESTORE_POSTGRES_DIGEST', /^sha256:[a-f0-9]{64}$/u) ||
      manifest.images.caddy !== required('AIKAYUN_RESTORE_CADDY_DIGEST', /^sha256:[a-f0-9]{64}$/u)) {
    throw new Error('RESTORE_VALIDATION_RELEASE_OR_SNAPSHOT_MISMATCH')
  }
  const dump = await hashFile('/run/restore/database/database.dump', manifest.database_dump.size)
  if (dump.size !== manifest.database_dump.size || dump.sha256 !== manifest.database_dump.sha256) throw new Error('RESTORE_VALIDATION_DATABASE_DUMP_MISMATCH')

  restoreValidationStage = 'configuration'
  const config = readConfig(process.env)
  const paymentKeys = config.paymentCredentialKeyRing
  const deliveryKeys = config.codePoolEncryptionKeyRing
  if (!paymentKeys || !deliveryKeys) throw new Error('RESTORE_VALIDATION_KEYRING_INVALID')

  const pool = new Pool({ ...config.database, max: 2, connectionTimeoutMillis: 5000, application_name: `aikayun_restore_${runId.replaceAll('-', '')}` })
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  try {
    restoreValidationStage = 'database-binding'
    const checksums = await readProtectedFile('/app/dist/db/migration-checksums.json', 0o644, 1024 * 1024)
    const metadata = await readBackupDatabaseMetadata(db, {
      engine_major: 18,
      migration_head: manifest.database.schema_head,
      migration_checksums_sha256: manifest.database.migration_checksums_sha256,
    }, checksums, checksums)
    checksums.fill(0)
    if (metadata.databaseId !== manifest.database.id || metadata.instanceId !== manifest.binding.instance_id ||
        metadata.identityJkt !== manifest.binding.identity_jkt || metadata.pendingKeyId !== manifest.key_ids.pending ||
        metadata.pendingKeySha256 !== manifest.binding.pending_key_sha256) throw new Error('RESTORE_VALIDATION_BINDING_MISMATCH')

    restoreValidationStage = 'historical-key-rings'
    const references = await readBackupKeyReferences(db, paymentKeys, deliveryKeys)
    const paymentRingBytes = await readProtectedFile('/run/restore/keys/payment_credential_key_ring', 0o400, 65536)
    let deliveryRingBytes: Buffer | undefined
    try {
      deliveryRingBytes = await readProtectedFile('/run/restore/keys/code_pool_encryption_key_ring', 0o400, 65536)
      verifyDeploymentKeyRingBytes(paymentRingBytes, deliveryRingBytes, references)
    } finally { paymentRingBytes.fill(0); deliveryRingBytes?.fill(0) }
    await assertPendingKeyReferences(db, metadata.pendingKeyId)
    restoreValidationStage = 'installation-identity'
    const identity = await verifyBackupIdentityPair(db, config.identityRoot, config.licensePendingKeyRoot, metadata,
      [config.mediaRoot, config.privateFileRoot, config.licenseTrustStoreRoot])
    if (identity.identityFileSha256 !== manifest.instance_identity_sha256) throw new Error('RESTORE_VALIDATION_IDENTITY_HASH_MISMATCH')

    restoreValidationStage = 'trust-store'
    const trustConfig = await loadEmbeddedTrustedReleaseLicenseConfig()
    const trust = trustConfig
      ? await createReleaseBoundTrustStore(trustConfig, config.licenseTrustStoreRoot).inspectPersistedReadOnly()
      : manifest.trust_bundle.status === 'uninitialized'
        ? await inspectUninitializedTrustStore(config.licenseTrustStoreRoot)
        : (() => { throw new Error('RESTORE_VALIDATION_TRUST_CONFIG_UNAVAILABLE') })()
    assertTrustBundleManifestMatch(trust, manifest.trust_bundle)

    restoreValidationStage = 'time-watermark'
    const projection = await db.selectFrom('instance_license_state').selectAll().where('singleton', '=', true).executeTakeFirst()
    if (!projection) throw new Error('RESTORE_VALIDATION_LICENSE_PROJECTION_MISSING')
    const watermark = await readTrustedTimeWatermark(config.licensePendingKeyRoot, {
      databaseId: metadata.databaseId, instanceId: metadata.instanceId, identityJkt: metadata.identityJkt,
    })
    if (projection.trusted_time_high_water_ms !== null) {
      if (!/^[1-9][0-9]{0,15}$/u.test(projection.trusted_time_high_water_ms) || watermark.status !== 'valid' ||
          watermark.record.high_water_ms < Number(projection.trusted_time_high_water_ms)) throw new Error('RESTORE_VALIDATION_TIME_WATERMARK_MISMATCH')
    } else if (watermark.status === 'corrupt') throw new Error('RESTORE_VALIDATION_TIME_WATERMARK_MISMATCH')

    restoreValidationStage = 'unresolved-operations'
    const pending = await readBackupPendingSummary(db)
    if (JSON.stringify(pending) !== JSON.stringify(manifest.unresolved)) throw new Error('RESTORE_VALIDATION_PENDING_SUMMARY_MISMATCH')
    restoreValidationStage = 'license-pending-pair'
    const license = await verifyLicensePendingBackupPairReadOnly(db, config.licensePendingKeyRoot)
    restoreValidationStage = 'private-files'
    const fileCount = await verifyPrivateFiles(db, config.privateFileRoot)
    restoreValidationStage = 'media-and-attachments'
    const attachments = await verifyMediaAndAttachments(db, config)
    restoreValidationStage = 'historical-decryption'
    const decryption = await verifyHistoricalDecryption(db, config)
    restoreValidationStage = 'business-invariants'
    const business = await sql<{ orders: string; order_items: string; payment_attempts: string; refunds: string; withdrawals: string;
      deliveries: string; supplier_operations: string; inconsistent_order_items: string; inconsistent_wallet_ledger: string;
      inconsistent_inventory_reservations: string; missing_inventory_evidence: string; inconsistent_withdrawal_freeze: string;
      inconsistent_file_authorizations: string; file_deliveries: string; procurement_operations: string;
      procurement_unknown_operations: string; procurement_request_intents: string; procurement_execution_evidence: string;
      procurement_risk_reservations: string; procurement_risk_events: string; inconsistent_procurement_pairs: string;
      inconsistent_procurement_risk_buckets: string }>`
      WITH wallet_totals AS (
        SELECT customer_id, bucket,
          sum(CASE action WHEN 'credit_available' THEN amount WHEN 'unfreeze' THEN amount
            WHEN 'debit_available' THEN -amount WHEN 'freeze' THEN -amount ELSE 0 END) AS available,
          sum(CASE action WHEN 'freeze' THEN amount WHEN 'unfreeze' THEN -amount WHEN 'debit_frozen' THEN -amount ELSE 0 END) AS frozen
        FROM wallet_ledger_entries GROUP BY customer_id, bucket
      ), inventory_totals AS (
        SELECT reservation.product_variant_id,
          sum(CASE event.action WHEN 'reserve' THEN event.quantity ELSE -event.quantity END) AS reserved
        FROM order_inventory_reservations reservation
        JOIN order_inventory_events event ON event.reservation_id = reservation.id
        GROUP BY reservation.product_variant_id
      )
      SELECT
        (SELECT count(*) FROM orders)::text AS orders,
        (SELECT count(*) FROM order_items)::text AS order_items,
        (SELECT count(*) FROM payment_attempts)::text AS payment_attempts,
        (SELECT count(*) FROM order_refunds)::text AS refunds,
        (SELECT count(*) FROM withdrawals)::text AS withdrawals,
        (SELECT count(*) FROM order_item_fulfillment_deliveries)::text AS deliveries,
        (SELECT count(*) FROM supplier_api_delivery_operations)::text AS supplier_operations,
        (SELECT count(*) FROM procurement_operations)::text AS procurement_operations,
        (SELECT count(*) FROM procurement_operations WHERE state = 'unknown')::text AS procurement_unknown_operations,
        (SELECT count(*) FROM procurement_request_intents)::text AS procurement_request_intents,
        (SELECT count(*) FROM procurement_execution_evidence)::text AS procurement_execution_evidence,
        (SELECT count(*) FROM procurement_risk_reservations)::text AS procurement_risk_reservations,
        (SELECT count(*) FROM procurement_risk_events)::text AS procurement_risk_events,
        (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id
          WHERE i.quantity <= 0 OR i.fulfilled_quantity < 0 OR i.fulfilled_quantity > i.quantity
            OR i.unit_price < 0 OR i.line_amount <> (i.unit_price * i.quantity) OR o.currency <> 'CNY')::text AS inconsistent_order_items,
        (SELECT count(*) FROM wallet_accounts w
          LEFT JOIN wallet_totals cash ON cash.customer_id = w.customer_id AND cash.bucket = 'cash'
          LEFT JOIN wallet_totals gift ON gift.customer_id = w.customer_id AND gift.bucket = 'gift'
          WHERE w.cash_available <> coalesce(cash.available, 0) OR w.cash_frozen <> coalesce(cash.frozen, 0)
            OR w.gift_available <> coalesce(gift.available, 0) OR w.gift_frozen <> coalesce(gift.frozen, 0))::text AS inconsistent_wallet_ledger,
        (SELECT count(*) FROM product_variant_quantity_inventory inventory
          LEFT JOIN inventory_totals movement ON movement.product_variant_id = inventory.product_variant_id
          WHERE inventory.reserved <> coalesce(movement.reserved, 0) OR inventory.stocked < inventory.reserved)::text
          AS inconsistent_inventory_reservations,
        (SELECT count(*) FROM product_variants v WHERE v.inventory_mode = 'quantity' AND v.inventory_revision > 0
          AND NOT EXISTS (SELECT 1 FROM product_variant_inventory_adjustments a WHERE a.product_variant_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM order_inventory_events event
            JOIN order_inventory_reservations reservation ON reservation.id = event.reservation_id
            WHERE reservation.product_variant_id = v.id))::text AS missing_inventory_evidence,
        (SELECT count(*) FROM withdrawals withdrawal
          WHERE withdrawal.status IN ('pending_review', 'pending_transfer', 'transfer_processing', 'transfer_uncertain')
            AND (SELECT coalesce(sum(entry.amount) FILTER (WHERE entry.action = 'freeze'), 0)
                 - coalesce(sum(entry.amount) FILTER (WHERE entry.action IN ('unfreeze', 'debit_frozen')), 0)
              FROM wallet_ledger_entries entry WHERE entry.withdrawal_id = withdrawal.id) <> withdrawal.amount)::text
          AS inconsistent_withdrawal_freeze,
        (SELECT count(*) FROM order_item_fulfillment_deliveries delivery
          JOIN order_item_fulfillment_attempts attempt ON attempt.id = delivery.fulfillment_attempt_id
          JOIN order_items item ON item.id = attempt.order_item_id
          JOIN orders parent ON parent.id = item.order_id
          LEFT JOIN product_variant_fulfillment_versions version ON version.id = delivery.fulfillment_content_version_id
          LEFT JOIN private_file_objects object ON object.id = version.private_file_object_id
          WHERE delivery.delivery_source = 'file' AND (attempt.delivery_source <> 'file' OR attempt.status <> 'succeeded'
            OR item.fulfillment_status <> 'completed' OR item.fulfilled_quantity <> item.quantity
            OR parent.status <> 'completed' OR version.method <> 'file' OR object.status <> 'available'
            OR delivery.content_sha256 <> object.sha256))::text AS inconsistent_file_authorizations,
        (SELECT count(*) FROM order_item_fulfillment_deliveries WHERE delivery_source = 'file')::text AS file_deliveries
        ,(SELECT count(*) FROM procurement_risk_reservations risk
          JOIN procurement_operations operation ON operation.id = risk.operation_id
          JOIN order_item_procurement_sources source ON source.id = operation.source_id
          WHERE source.order_item_id <> operation.order_item_id
            OR risk.supplier_connection_id <> source.supplier_connection_id
            OR risk.product_variant_id <> source.product_variant_id
            OR risk.amount_minor <= 0)::text AS inconsistent_procurement_pairs,
        (WITH operation_exposure AS (
          SELECT risk.operation_id, risk.currency, risk.supplier_connection_id, risk.product_variant_id,
            risk.amount_minor + coalesce(sum(CASE event.kind WHEN 'debit' THEN -event.amount_minor
              WHEN 'release' THEN -event.amount_minor WHEN 'reinstate' THEN event.amount_minor ELSE 0 END), 0) AS remaining
          FROM procurement_risk_reservations risk LEFT JOIN procurement_risk_events event ON event.operation_id = risk.operation_id
          GROUP BY risk.operation_id, risk.currency, risk.supplier_connection_id, risk.product_variant_id, risk.amount_minor
        ), expected AS (
          SELECT currency, 'global'::text AS scope_kind, '*'::text AS scope_key, sum(remaining) AS outstanding
          FROM operation_exposure GROUP BY currency
          UNION ALL
          SELECT currency, 'supplier', supplier_connection_id::text, sum(remaining)
          FROM operation_exposure GROUP BY currency, supplier_connection_id
          UNION ALL
          SELECT currency, 'sku', product_variant_id::text, sum(remaining)
          FROM operation_exposure GROUP BY currency, product_variant_id
        ), keys AS (
          SELECT currency, scope_kind, scope_key FROM procurement_risk_buckets
          UNION SELECT currency, scope_kind, scope_key FROM expected
        )
        SELECT count(*) FROM keys
        LEFT JOIN procurement_risk_buckets actual USING (currency, scope_kind, scope_key)
        LEFT JOIN expected USING (currency, scope_kind, scope_key)
        WHERE coalesce(actual.outstanding_minor, 0) <> coalesce(expected.outstanding, 0))::text
          AS inconsistent_procurement_risk_buckets
    `.execute(db)
    const businessRow = business.rows[0]
    if (!businessRow || businessRow.inconsistent_order_items !== '0' || businessRow.inconsistent_wallet_ledger !== '0' ||
        businessRow.inconsistent_inventory_reservations !== '0' || businessRow.missing_inventory_evidence !== '0' ||
        businessRow.inconsistent_withdrawal_freeze !== '0' || businessRow.inconsistent_file_authorizations !== '0' ||
        businessRow.inconsistent_procurement_pairs !== '0' || businessRow.inconsistent_procurement_risk_buckets !== '0') {
      throw new Error('RESTORE_VALIDATION_BUSINESS_INVARIANT_FAILED')
    }
    restoreValidationStage = 'read-only-database'
    const version = await db.transaction().execute(async tx => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx)
      return sql<{ major: number; read_only: boolean; database: string }>`
        SELECT current_setting('server_version_num')::int / 10000 AS major,
          current_setting('transaction_read_only') = 'on' AS read_only, current_database() AS database
      `.execute(tx)
    })
    if (version.rows[0]?.major !== 18 || version.rows[0]?.read_only !== true || version.rows[0]?.database !== 'aikayun') {
      throw new Error('RESTORE_VALIDATION_DATABASE_MODE_INVALID')
    }
    process.stdout.write(`${JSON.stringify({ operation: 'restore-validation', status: 'verified', runId,
      backupSetId: set, sourceSnapshotId: sourceSnapshot, manifestSnapshotId: manifestSnapshot,
      schemaHead: metadata.migrationHead, business: { orders: Number(businessRow.orders), orderItems: Number(businessRow.order_items),
        paymentAttempts: Number(businessRow.payment_attempts), refunds: Number(businessRow.refunds), withdrawals: Number(businessRow.withdrawals),
        deliveries: Number(businessRow.deliveries), supplierOperations: Number(businessRow.supplier_operations),
        procurementOperations: Number(businessRow.procurement_operations),
        unknownProcurementOperations: Number(businessRow.procurement_unknown_operations),
        procurementRequestIntents: Number(businessRow.procurement_request_intents),
        procurementExecutionEvidence: Number(businessRow.procurement_execution_evidence),
        procurementRiskReservations: Number(businessRow.procurement_risk_reservations),
        procurementRiskEvents: Number(businessRow.procurement_risk_events),
        fileDeliveries: Number(businessRow.file_deliveries),
        walletLedgerEntries: Number((await db.selectFrom('wallet_ledger_entries').select(({ fn }) => fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
        inventoryReservations: Number((await db.selectFrom('order_inventory_reservations').select(({ fn }) => fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
        consistency: 'verified' },
      pendingOperations: 'preserved',
      privateFileSha256Count: fileCount, paymentEnvelopeDecryptions: decryption.paymentEnvelopesDecrypted,
      deliveryEnvelopeDecryptions: decryption.deliveryEnvelopesDecrypted,
      purchaseSnapshotsDecrypted: decryption.purchaseSnapshotsDecrypted,
      files: attachments,
      licenseOperations: license.operations, licenseAttempts: license.attempts, watermark: license.watermark || watermark.status === 'valid',
      resticSource: 'verified', network: 'egress-blocked' })}\n`)
  } finally {
    await db.destroy()
    for (const key of Object.values(paymentKeys.keys)) key.fill(0)
    for (const key of Object.values(deliveryKeys.keys)) key.fill(0)
  }
}

try {
  await runIsolatedRestoreVerification()
} catch (error) {
  const standardCode = error instanceof Error && /^RESTORE_[A-Z0-9_]{1,80}$/u.test(error.message) ? error.message : null
  const diagnostic = process.env.AIKAYUN_RESTORE_TEST_DIAGNOSTICS === 'true' && error && typeof error === 'object'
    ? ('message' in error && typeof error.message === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/u.test(error.message)
      ? `RESTORE_TEST_${error.message.toUpperCase().replaceAll('-', '_')}`
      : 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{2,8}$/u.test(error.code)
        ? `RESTORE_TEST_DATABASE_OR_FILE_ERROR_${error.code}` : null)
    : null
  const stageDiagnostic = process.env.AIKAYUN_RESTORE_TEST_DIAGNOSTICS === 'true' && error && typeof error === 'object' &&
    'code' in error && error.code === 'EACCES'
    ? `RESTORE_TEST_EACCES_AT_${restoreValidationStage.toUpperCase().replaceAll('-', '_')}` : null
  const unclassifiedStageDiagnostic = process.env.AIKAYUN_RESTORE_TEST_DIAGNOSTICS === 'true'
    ? `RESTORE_TEST_UNCLASSIFIED_AT_${restoreValidationStage.toUpperCase().replaceAll('-', '_')}_` +
      (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string' &&
        /^[A-Za-z][A-Za-z0-9]{0,24}$/u.test(error.name) ? error.name.toUpperCase() : 'UNKNOWN') : null
  const code = standardCode ?? stageDiagnostic ?? diagnostic ?? unclassifiedStageDiagnostic ?? 'RESTORE_VALIDATION_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
}
