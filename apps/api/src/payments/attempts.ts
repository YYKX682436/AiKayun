import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../db/types.js'

export async function lockPaymentAttempt(trx: Transaction<Database>, attemptId: string) {
  const attempt = await trx.selectFrom('payment_attempts')
    .select(['order_id', 'topup_customer_id', 'wallet_hold_operation_id'])
    .where('id', '=', attemptId).executeTakeFirst()
  if (!attempt) return undefined

  // Combo: customer -> order -> wallet -> attempt. Top-up omits the order;
  // a plain order payment needs only the order and attempt locks.
  const customerId = attempt.wallet_hold_operation_id && attempt.order_id
    ? (await trx.selectFrom('orders').select('customer_id')
        .where('id', '=', attempt.order_id).executeTakeFirstOrThrow()).customer_id
    : attempt.topup_customer_id
  if (customerId) {
    await trx.selectFrom('customers').select('id').where('id', '=', customerId).forUpdate().executeTakeFirst()
  }
  if (attempt.order_id) {
    await trx.selectFrom('orders').select('id').where('id', '=', attempt.order_id).forUpdate().executeTakeFirst()
  }
  if (customerId) {
    await trx.selectFrom('wallet_accounts').select('customer_id')
      .where('customer_id', '=', customerId).forUpdate().executeTakeFirst()
  }
  return await trx.selectFrom('payment_attempts').select(['id', 'status', 'provider'])
    .where('id', '=', attemptId).forUpdate().executeTakeFirst()
}

export const paymentAttemptHasNoFundsEvidence = sql<boolean>`
  NOT payment_attempt_has_unresolved_provider_evidence(attempt.id)
  AND NOT EXISTS (SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = attempt.id)
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_events AS event
    WHERE event.payment_attempt_id = attempt.id AND event.source IN ('callback', 'query')
      AND event.verification = 'verified' AND event.provider_status = 'paid'
      AND event.disposition = 'pending_confirmation'
  )`

export async function expirePaymentAttempt(trx: Transaction<Database>, attemptId: string) {
  await lockPaymentAttempt(trx, attemptId)
  // A receipt or signed observation may have arrived since the candidate read.
  // The status trigger resolves any wallet hold in this same transaction.
  return await trx.updateTable('payment_attempts as attempt').set({ status: 'expired' })
    .where('attempt.id', '=', attemptId).where('attempt.status', 'in', ['created', 'pending'])
    .where('attempt.expires_at', '<=', sql<Date>`statement_timestamp()`).where(paymentAttemptHasNoFundsEvidence)
    .returning('attempt.id').executeTakeFirst()
}

/** End local payment windows; a later provider receipt can still settle. */
export async function expireDuePaymentAttempts(db: Kysely<Database>, batchSize: number): Promise<number> {
  const due = await db.selectFrom('payment_attempts as attempt').select('attempt.id')
    .where('attempt.status', 'in', ['created', 'pending']).where('attempt.expires_at', '<=', sql<Date>`statement_timestamp()`)
    .where(paymentAttemptHasNoFundsEvidence).orderBy('attempt.expires_at').orderBy('attempt.id')
    .limit(batchSize).execute()
  for (const attempt of due) {
    await db.transaction().execute(trx => expirePaymentAttempt(trx, attempt.id))
  }
  return due.length
}
