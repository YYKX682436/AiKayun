import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'

/** Counts are deliberately grouped by table and state, and can overlap. They
 * describe pending work, not incident severity or a sum of distinct orders. */
export interface BackupPendingSummary {
  paymentAttemptsPending: number
  paymentRequests: number
  paymentUnknown: number
  paymentReconciliationCases: number
  refundsPending: number
  refundAttemptsUncertain: number
  withdrawalsPending: number
  withdrawalAttemptsUncertain: number
  fulfillmentAttemptsUnfinished: number
  deliveryItemsUnfinished: number
  supplierOperationsUnfinished: number
}

/** A single PostgreSQL statement provides a single MVCC snapshot; caller must
 * have quiesced all writers and fail the backup if this read fails. */
export async function readBackupPendingSummary(db: Kysely<Database>): Promise<BackupPendingSummary> {
  const result = await sql<Record<keyof BackupPendingSummary, string>>`
    SELECT
      (SELECT count(*) FROM payment_attempts WHERE status IN ('created', 'pending', 'reconciliation_required'))::text AS "paymentAttemptsPending",
      (SELECT count(*) FROM payment_attempt_provider_state WHERE state = 'requesting')::text AS "paymentRequests",
      (SELECT count(*) FROM payment_attempt_provider_state WHERE state = 'unknown')::text AS "paymentUnknown",
      (SELECT count(*) FROM payment_provider_reconciliation_cases WHERE state = 'open')::text AS "paymentReconciliationCases",
      (SELECT count(*) FROM order_refunds WHERE status IN ('requested', 'approved', 'processing', 'partially_succeeded'))::text AS "refundsPending",
      (SELECT count(*) FROM order_refund_manual_attempts WHERE status IN ('started', 'unknown'))::text AS "refundAttemptsUncertain",
      (SELECT count(*) FROM withdrawals WHERE status IN ('pending_review', 'pending_transfer', 'transfer_processing', 'transfer_uncertain'))::text AS "withdrawalsPending",
      (SELECT count(*) FROM withdrawal_payout_attempts WHERE status IN ('started', 'unknown'))::text AS "withdrawalAttemptsUncertain",
      (SELECT count(*) FROM order_item_fulfillment_attempts a JOIN order_items i ON i.id = a.order_item_id
        JOIN orders o ON o.id = i.order_id WHERE o.status = 'processing' AND i.fulfilled_quantity < i.quantity
        AND a.status IN ('processing', 'unknown', 'failed'))::text AS "fulfillmentAttemptsUnfinished",
      (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status = 'processing'
        AND i.fulfilled_quantity < i.quantity)::text AS "deliveryItemsUnfinished",
      (SELECT count(*) FROM supplier_api_delivery_operations WHERE state IN
        ('create_pending', 'create_in_flight', 'query_pending', 'query_in_flight', 'processing', 'unknown',
         'succeeded_pending_finalize', 'manual_review'))::text AS "supplierOperationsUnfinished"
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw new Error('backup_pending_summary_unavailable')
  const values = Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const count = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(count)) throw new Error('backup_pending_summary_invalid')
    return [key, count]
  }))
  return values as unknown as BackupPendingSummary
}
