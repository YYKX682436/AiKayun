import { randomUUID } from 'node:crypto'
import { allocateWalletSpend, normalizeWalletAmount } from '@aikayun/money'
import type { Transaction } from 'kysely'
import type { Database } from '../db/types.js'

export interface WalletOrderPaymentInput {
  customerId: string
  orderId: string
  operationId: string
  requestSha256: string
  amount: string
}

export interface WalletOrderPaymentResult {
  paymentAttemptId: string
  giftAmount: string
  cashAmount: string
}

/**
 * Records one idempotent wallet payment inside the caller's order transaction.
 * The account row lock serializes concurrent spending; money remains decimal text.
 */
export async function recordWalletOrderPayment(
  trx: Transaction<Database>,
  input: WalletOrderPaymentInput,
): Promise<WalletOrderPaymentResult> {
  const amount = normalizeWalletAmount(input.amount)
  const order = await trx.selectFrom('orders').select(['customer_id', 'status', 'total_amount'])
    .where('id', '=', input.orderId).forUpdate().executeTakeFirst()
  if (!order) throw new Error('ORDER_NOT_FOUND')
  if (order.customer_id !== input.customerId) throw new Error('ORDER_CUSTOMER_MISMATCH')

  const existing = await trx.selectFrom('payment_attempts').selectAll()
    .where('idempotency_key', '=', input.operationId).executeTakeFirst()
  if (existing) {
    if (existing.order_id !== input.orderId || existing.source !== 'wallet'
      || existing.wallet_operation_id !== input.operationId || existing.amount !== amount
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
    }
  }
  if (order.status !== 'pending_payment' || order.total_amount === '0.00') {
    throw new Error('ORDER_NOT_PAYABLE')
  }

  const account = await trx.selectFrom('wallet_accounts').selectAll()
    .where('customer_id', '=', input.customerId).forUpdate().executeTakeFirst()
  if (!account) throw new Error('WALLET_ACCOUNT_NOT_FOUND')
  const allocation = allocateWalletSpend(amount, account.gift_available, account.cash_available)
  const paymentAttemptId = randomUUID()

  await trx.insertInto('wallet_operations').values({
    id: input.operationId,
    customer_id: input.customerId,
    operation_type: 'order_payment',
    request_sha256: input.requestSha256,
    actor_admin_id: null,
  }).execute()

  await trx.insertInto('payment_attempts').values({
    id: paymentAttemptId,
    idempotency_key: input.operationId,
    request_sha256: input.requestSha256,
    order_id: input.orderId,
    topup_customer_id: null,
    source: 'wallet',
    amount,
    provider: null,
    provider_payment_id: null,
    wallet_operation_id: input.operationId,
    expires_at: null,
    completed_at: null,
  }).execute()

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
      action: 'debit_available',
      amount: leg.amount,
      payment_attempt_id: paymentAttemptId,
      refund_allocation_id: null,
      withdrawal_id: null,
    }).execute()
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

  return {
    paymentAttemptId,
    giftAmount: allocation.giftAmount,
    cashAmount: allocation.cashAmount,
  }
}
