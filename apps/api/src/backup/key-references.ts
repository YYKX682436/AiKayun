import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { PaymentCredentialKeyRing } from '../config.js'
import type { Database } from '../db/types.js'

function ids(ring: PaymentCredentialKeyRing | null): string[] {
  if (!ring || !ring.keys || !Object.hasOwn(ring.keys, ring.activeKeyId)) throw new Error('BACKUP_KEY_RING_UNAVAILABLE')
  const entries = Object.entries(ring.keys)
  if (!entries.length || entries.length > 16 || entries.some(([id, key]) =>
    !/^[A-Za-z0-9_-]{1,48}$/.test(id) || !Buffer.isBuffer(key) || key.length !== 32)) {
    throw new Error('BACKUP_KEY_RING_INVALID')
  }
  return entries.map(([id]) => id).sort()
}

/** Check every historical key reference covered by operations diagnostics.
 * This establishes key-ID coverage only, not ciphertext decryptability or key
 * material correctness. Caller supplies file-validated rings and writer fence. */
export async function readBackupKeyReferences(db: Kysely<Database>, payment: PaymentCredentialKeyRing | null,
  delivery: PaymentCredentialKeyRing | null) {
  const paymentIds = ids(payment)
  const deliveryIds = ids(delivery)
  return db.transaction().execute(async tx => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.execute(tx)
    const result = await sql<{ kind: string; key_id: string }>`
      SELECT DISTINCT kind, key_id FROM (
        SELECT 'payment' AS kind, config_key_id AS key_id FROM payment_channels WHERE config_key_id IS NOT NULL
        UNION ALL SELECT 'payment', key_id FROM payment_attempt_secrets
        UNION ALL SELECT 'payment', key_id FROM supplier_connection_credentials
        UNION ALL SELECT 'payment', encryption_key_id FROM purchase_drafts
        UNION ALL SELECT 'payment', encryption_key_id FROM order_item_purchase_snapshots WHERE encryption_key_id IS NOT NULL
        UNION ALL SELECT 'delivery', encryption_key_id FROM code_pool_entries
        UNION ALL SELECT 'delivery', fingerprint_key_id FROM code_pool_entries
        UNION ALL SELECT 'delivery', request_fingerprint_key_id FROM code_pool_batches WHERE request_fingerprint_key_id IS NOT NULL
        UNION ALL SELECT 'delivery', encryption_key_id FROM product_variant_fulfillment_versions WHERE encryption_key_id IS NOT NULL
        UNION ALL SELECT 'delivery', encryption_key_id FROM order_item_fulfillment_deliveries WHERE encryption_key_id IS NOT NULL
        UNION ALL SELECT 'delivery', supplier_fingerprint_key_id FROM order_item_fulfillment_deliveries WHERE supplier_fingerprint_key_id IS NOT NULL
        UNION ALL SELECT 'delivery', result_key_id FROM supplier_api_delivery_operations WHERE result_key_id IS NOT NULL
      ) AS refs ORDER BY kind, key_id LIMIT 33
    `.execute(tx)
    // Both validated rings contain at most 16 keys each. More than 32 distinct
    // typed references necessarily means at least one unavailable key.
    if (result.rows.length > 32) throw new Error('BACKUP_HISTORICAL_KEY_MISSING')
    const paymentReferenced: string[] = []
    const deliveryReferenced: string[] = []
    for (const row of result.rows) {
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(row.key_id)) throw new Error('BACKUP_KEY_REFERENCE_INVALID')
      if (row.kind === 'payment') paymentReferenced.push(row.key_id)
      else if (row.kind === 'delivery') deliveryReferenced.push(row.key_id)
      else throw new Error('BACKUP_KEY_REFERENCE_INVALID')
    }
    if (paymentReferenced.some(id => !Object.hasOwn(payment!.keys, id)) ||
        deliveryReferenced.some(id => !Object.hasOwn(delivery!.keys, id))) throw new Error('BACKUP_HISTORICAL_KEY_MISSING')
    return { paymentKeyIds: paymentIds, deliveryKeyIds: deliveryIds,
      paymentReferencedKeyIds: paymentReferenced, deliveryReferencedKeyIds: deliveryReferenced,
      paymentActiveKeyId: payment!.activeKeyId, deliveryActiveKeyId: delivery!.activeKeyId,
      paymentKeyDigests: Object.fromEntries(paymentIds.map(id => [id, createHash('sha256').update(payment!.keys[id]!).digest('hex')])),
      deliveryKeyDigests: Object.fromEntries(deliveryIds.map(id => [id, createHash('sha256').update(delivery!.keys[id]!).digest('hex')])),
      contentVerification: 'not_verified' as const }
  })
}

/** The installation has one bound Pending Key. Historical encrypted licensing
 * records must not silently reference a different key. This establishes ID
 * coverage only; it does not prove that any ciphertext can be decrypted. */
export async function assertPendingKeyReferences(db: Kysely<Database>, pendingKeyId: string): Promise<void> {
  if (!/^lp-[a-f0-9]{32}$/.test(pendingKeyId)) throw new Error('BACKUP_PENDING_KEY_REFERENCE_INVALID')
  const result = await sql<{ mismatch: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM local_license_operations WHERE payload_key_id <> ${pendingKeyId}
      UNION ALL SELECT 1 FROM local_license_operations WHERE center_evidence_key_id IS NOT NULL AND center_evidence_key_id <> ${pendingKeyId}
      UNION ALL SELECT 1 FROM local_license_operation_attempts WHERE request_key_id <> ${pendingKeyId}
      UNION ALL SELECT 1 FROM local_license_operation_attempts WHERE response_key_id IS NOT NULL AND response_key_id <> ${pendingKeyId}
      UNION ALL SELECT 1 FROM local_license_operation_attempts WHERE result_key_id IS NOT NULL AND result_key_id <> ${pendingKeyId}
      UNION ALL SELECT 1 FROM instance_license_state WHERE credential_encryption_key_id IS NOT NULL AND credential_encryption_key_id <> ${pendingKeyId}
      UNION ALL SELECT 1 FROM instance_license_state WHERE refusal_encryption_key_id IS NOT NULL AND refusal_encryption_key_id <> ${pendingKeyId}
    ) AS mismatch
  `.execute(db)
  if (result.rows.length !== 1 || result.rows[0]?.mismatch !== false) throw new Error('BACKUP_PENDING_HISTORICAL_KEY_MISSING')
}
