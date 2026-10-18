import { randomUUID } from 'node:crypto'
import { allocateWalletOrderPayment, normalizeWalletAmount } from '@aikayun/money'
import type { Transaction } from 'kysely'
import type { Database } from '../db/types.js'

export interface WalletOrderPaymentInput {
  customerId: string
  orderId: string
  operationId: string
  requestSha256: string
  /** Maximum wallet contribution requested for this checkout. */
  amount: string
  /** Required when wallet funds do not cover the whole order. */
  externalProvider?: string
}

export interface WalletOrderPaymentResult {
  paymentAttemptId: string
  giftAmount: string
  cashAmount: string
  externalAmount: string
}

/**
 * Creates one idempotent payment plan inside the caller's order transaction.
 * Partial wallet funds are frozen against the external attempt and are only
 * debited after its on-time receipt. Full wallet payment settles immediately.
 */
export async function recordWalletOrderPayment(
  trx: Transaction<Database>,
  input: WalletOrderPaymentInput,
): Promise<WalletOrderPaymentResult> {
  const requestedAmount = normalizeWalletAmount(input.amount)
  const order = await trx.selectFrom('orders').select(['customer_id', 'status', 'total_amount', 'unpaid_expires_at'])
    .where('id', '=', input.orderId).forUpdate().executeTakeFirst()
  if (!order) throw new Error('ORDER_NOT_FOUND')
  if (order.customer_id !== input.customerId) throw new Error('ORDER_CUSTOMER_MISMATCH')

  const existing = await trx.selectFrom('payment_attempts').selectAll()
    .where('idempotency_key', '=', input.operationId).executeTakeFirst()
  if (existing) {
    if (existing.order_id !== input.orderId || existing.source === 'external' && existing.requested_wallet_amount !== requestedAmount
      || existing.source === 'wallet' && existing.amount !== requestedAmount
      || existing.source === 'external' && existing.provider !== input.externalProvider?.trim()
      || existing.request_sha256 !== input.requestSha256) {
      throw new Error('WALLET_PAYMENT_IDEMPOTENCY_CONFLICT')
    }
    const amounts = await trx.selectFrom('wallet_ledger_entries').select([
      'bucket',
      (eb) => eb.fn.sum<string>('amount').as('amount'),
    ]).where('wallet_operation_id', '=', input.operationId).groupBy('bucket').execute()
    return {
      paymentAttemptId: existing.id,
      giftAmount: amounts.find((row) => row.bucket === 'gift')?.amount ?? '0.00',
      cashAmount: amounts.find((row) => row.bucket === 'cash')?.amount ?? '0.00',
      externalAmount: existing.source === 'external' ? existing.amount : '0.00',
    }
  }
  if (order.status !== 'pending_payment' || order.total_amount === '0.00' || !order.unpaid_expires_at) {
    throw new Error('ORDER_NOT_PAYABLE')
  }

  const activeAttempt = await trx.selectFrom('payment_attempts').select('id')
    .where('order_id', '=', input.orderId).where('status', 'in', ['created', 'pending']).executeTakeFirst()
  if (activeAttempt) throw new Error('ORDER_PAYMENT_IN_PROGRESS')

  const account = await trx.selectFrom('wallet_accounts').selectAll()
    .where('customer_id', '=', input.customerId).forUpdate().executeTakeFirst()
  if (!account) throw new Error('WALLET_ACCOUNT_NOT_FOUND')

  const allocation = allocateWalletOrderPayment(
    order.total_amount,
    requestedAmount,
    account.gift_available,
    account.cash_available,
  )
  const paymentAttemptId = randomUUID()
  const hasWalletAmount = allocation.giftAmount !== '0.00' || allocation.cashAmount !== '0.00'
  const isExternal = allocation.externalAmount !== '0.00'
  if (isExternal && (!input.externalProvider || input.externalProvider.trim() === '')) {
    throw new Error('EXTERNAL_PAYMENT_PROVIDER_REQUIRED')
  }

  if (hasWalletAmount) {
    await trx.insertInto('wallet_operations').values({
      id: input.operationId,
      customer_id: input.customerId,
      order_id: input.orderId,
      resolves_operation_id: null,
      requested_amount: requestedAmount,
      operation_type: isExternal ? 'order_payment_hold' : 'order_payment',
      request_sha256: input.requestSha256,
      actor_admin_id: null,
    }).execute()
  }

  await trx.insertInto('payment_attempts').values({
    id: paymentAttemptId,
    idempotency_key: input.operationId,
    request_sha256: input.requestSha256,
    order_id: input.orderId,
    topup_customer_id: null,
    source: isExternal ? 'external' : 'wallet',
    amount: isExternal ? allocation.externalAmount : order.total_amount,
    status: 'created',
    provider: isExternal ? input.externalProvider!.trim() : null,
    provider_payment_id: null,
    wallet_operation_id: isExternal ? null : input.operationId,
    wallet_hold_operation_id: isExternal && hasWalletAmount ? input.operationId : null,
    requested_wallet_amount: requestedAmount,
    expires_at: order.unpaid_expires_at,
    completed_at: null,
  }).execute()

  if (hasWalletAmount) {
    let lineNo = 0
    for (const leg of [
      { bucket: 'gift' as const, amount: allocation.giftAmount },
      { bucket: 'cash' as const, amount: allocation.cashAmount },
    ]) {
      if (leg.amount === '0.00') continue
      lineNo += 1
      await trx.insertInto('wallet_ledger_entries').values({
        id: randomUUID(),
        wallet_operation_id: input.operationId,
        line_no: lineNo,
        customer_id: input.customerId,
        bucket: leg.bucket,
        action: isExternal ? 'freeze' : 'debit_available',
        amount: leg.amount,
        payment_attempt_id: paymentAttemptId,
        refund_allocation_id: null,
        withdrawal_id: null,
      }).execute()
      if (!isExternal) {
        await trx.insertInto('payment_receipts').values({
          id: randomUUID(),
          payment_attempt_id: paymentAttemptId,
          source_bucket: leg.bucket,
          provider: null,
          provider_transaction_id: null,
          wallet_operation_id: input.operationId,
          wallet_line_no: lineNo,
          amount: leg.amount,
        }).execute()
      }
    }
  }

  if (isExternal) {
    await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', paymentAttemptId).execute()
  }

  return {
    paymentAttemptId,
    giftAmount: allocation.giftAmount,
    cashAmount: allocation.cashAmount,
    externalAmount: allocation.externalAmount,
  }
}
