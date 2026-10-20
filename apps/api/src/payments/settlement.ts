import { randomUUID } from 'node:crypto'
import { settleAmount } from '@aikayun/money'
import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import type { AppConfig } from '../config.js'
import type {
  Database,
  PaymentAttemptStatus,
  ProviderEventDisposition,
  PaymentProviderRequestState,
} from '../db/types.js'
import {
  decryptPaymentConfig,
  parsePaymentConfig,
  type EncryptedEnvelope,
} from './credentials.js'
import type {
  PaymentAction,
  PaymentProviderAdapter,
  PaymentProviderCredentials,
  PaymentQueryResult,
  ProviderResultStatus,
} from './provider.js'

const providerQueryCooldownSeconds = 10

export interface PaymentAttemptSnapshot {
  id: string
  orderId: string | null
  topupCustomerId: string | null
  walletHoldOperationId: string | null
  amount: string
  status: PaymentAttemptStatus
  provider: string
  providerType: 'zpay_epay_v1'
  paymentMethod: 'alipay' | 'wechat'
  channelId: string
  channelName: string
  credentialVersion: number
  merchantOrderNo: string
  expiresAt: Date
  createdAt: Date
  completedAt: Date | null
  providerState: PaymentProviderRequestState
  action: PaymentAction | null
  providerOrderId: string | null
  lastErrorCode: string | null
  lastQueryAt: Date | null
}

export interface CallbackObservation {
  verification: 'verified' | 'unverified'
  eventSha256: string
  merchantOrderNo: string
  merchantId: string | null
  providerOrderId: string | null
  paymentMethod: 'alipay' | 'wechat' | null
  amount: string | null
  status: ProviderResultStatus
  payload: Record<string, string>
  providerTimeText: string | null
  errorCode: string | null
}

export type RefreshAttemptResult =
  | { kind: 'throttled'; attempt: PaymentAttemptSnapshot }
  | {
      kind: 'confirmed' | 'pending' | 'unknown' | 'reconciliation_required'
      attempt: PaymentAttemptSnapshot
      providerStatus: ProviderResultStatus
      verification: 'verified' | 'unverified'
      resolutionMade?: boolean
    }

export class PaymentServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'PaymentServiceError'
  }
}

function attemptContext(id: string, version: number): string {
  return `payment-attempt:${id}:config:${version}`
}

export async function loadPaymentAttemptSnapshot(
  db: Kysely<Database>, attemptId: string,
): Promise<PaymentAttemptSnapshot | undefined> {
  const row = await db.selectFrom('payment_attempts as attempt')
    .innerJoin('payment_attempt_provider_state as provider_state', 'provider_state.payment_attempt_id', 'attempt.id')
    .select([
      'attempt.id as id', 'attempt.order_id as order_id', 'attempt.topup_customer_id as topup_customer_id',
      'attempt.wallet_hold_operation_id as wallet_hold_operation_id', 'attempt.amount as amount',
      'attempt.status as status', 'attempt.provider as provider', 'attempt.provider_type_snapshot as provider_type',
      'attempt.payment_method_snapshot as payment_method', 'attempt.payment_channel_id as channel_id',
      'attempt.payment_channel_name_snapshot as channel_name', 'attempt.channel_credential_version as credential_version',
      'attempt.merchant_order_no as merchant_order_no', 'attempt.expires_at as expires_at',
      'attempt.created_at as created_at', 'attempt.completed_at as completed_at',
      'provider_state.state as provider_state', 'provider_state.action as action',
      'provider_state.provider_order_id as provider_order_id', 'provider_state.last_error_code as last_error_code',
      'provider_state.last_query_at as last_query_at',
    ])
    .where('attempt.id', '=', attemptId)
    .where('attempt.source', '=', 'external')
    .executeTakeFirst()
  if (!row || (row.order_id === null) === (row.topup_customer_id === null)
    || row.provider_type !== 'zpay_epay_v1' || !row.payment_method
    || !row.channel_id || !row.channel_name || row.credential_version === null
    || !row.merchant_order_no || !row.expires_at) return undefined
  const actionRecord = row.action as Record<string, unknown> | null
  const action = actionRecord?.type === 'qr_code' && typeof actionRecord.value === 'string'
    ? { type: 'qr_code' as const, value: actionRecord.value }
    : actionRecord?.type === 'redirect' && typeof actionRecord.url === 'string'
      ? { type: 'redirect' as const, url: actionRecord.url }
      : null
  return {
    id: row.id,
    orderId: row.order_id,
    topupCustomerId: row.topup_customer_id,
    walletHoldOperationId: row.wallet_hold_operation_id,
    amount: settleAmount(row.amount),
    status: row.status,
    provider: row.provider ?? '',
    providerType: 'zpay_epay_v1',
    paymentMethod: row.payment_method,
    channelId: row.channel_id,
    channelName: row.channel_name,
    credentialVersion: row.credential_version,
    merchantOrderNo: row.merchant_order_no,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    providerState: row.provider_state,
    action,
    providerOrderId: row.provider_order_id,
    lastErrorCode: row.last_error_code,
    lastQueryAt: row.last_query_at ? new Date(row.last_query_at) : null,
  }
}

export async function loadAttemptCredentials(
  db: Kysely<Database>, config: AppConfig, attempt: PaymentAttemptSnapshot,
): Promise<PaymentProviderCredentials> {
  const secret = await db.selectFrom('payment_attempt_secrets').selectAll()
    .where('payment_attempt_id', '=', attempt.id)
    .orderBy('envelope_version', 'desc')
    .executeTakeFirst()
  if (!secret || secret.config_version !== attempt.credentialVersion) {
    throw new PaymentServiceError(503, 'PAYMENT_CREDENTIAL_UNAVAILABLE', '支付凭据快照暂时不可用，请联系商家处理。')
  }
  const plaintext = decryptPaymentConfig(config, attemptContext(attempt.id, secret.config_version), {
    keyId: secret.key_id,
    nonce: secret.nonce,
    ciphertext: secret.ciphertext,
    authTag: secret.auth_tag,
  } satisfies EncryptedEnvelope)
  const credentials = parsePaymentConfig(plaintext)
  if (!credentials.merchantId || !credentials.merchantKey) {
    throw new PaymentServiceError(503, 'PAYMENT_CREDENTIAL_UNAVAILABLE', '支付凭据快照暂时不可用，请联系商家处理。')
  }
  return { merchantId: credentials.merchantId, merchantKey: credentials.merchantKey }
}

export async function recordCallbackObservation(
  db: Kysely<Database>, attemptId: string, observation: CallbackObservation, disposition: string,
): Promise<string> {
  return await db.transaction().execute(async (trx) => {
    const attempt = await trx.selectFrom('payment_attempts').select(['id', 'order_id', 'wallet_hold_operation_id', 'status'])
      .where('id', '=', attemptId).executeTakeFirst()
    if (!attempt) throw new PaymentServiceError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', '支付尝试不存在。')
    // Plain orders use order -> attempt. Combo orders use customer -> order ->
    // wallet -> attempt; top-ups use customer -> wallet -> attempt. A common
    // customer/account prefix prevents receipt-settlement cycles across both.
    if (attempt.order_id) {
      if (attempt.wallet_hold_operation_id) {
        const orderOwner = await trx.selectFrom('orders').select('customer_id')
          .where('id', '=', attempt.order_id).executeTakeFirst()
        if (orderOwner?.customer_id) {
          await trx.selectFrom('customers').select('id').where('id', '=', orderOwner.customer_id)
            .forUpdate().executeTakeFirst()
        }
      }
      await trx.selectFrom('orders').select('id').where('id', '=', attempt.order_id).forUpdate().executeTakeFirst()
      if (attempt.wallet_hold_operation_id) {
        const orderOwner = await trx.selectFrom('orders').select('customer_id')
          .where('id', '=', attempt.order_id).executeTakeFirstOrThrow()
        if (orderOwner.customer_id) {
          await trx.selectFrom('wallet_accounts').select('customer_id')
            .where('customer_id', '=', orderOwner.customer_id).forUpdate().executeTakeFirst()
        }
      }
    } else {
      const topupCustomer = await trx.selectFrom('payment_attempts').select('topup_customer_id')
        .where('id', '=', attemptId).executeTakeFirstOrThrow()
      if (topupCustomer.topup_customer_id) {
        await trx.selectFrom('customers').select('id').where('id', '=', topupCustomer.topup_customer_id).forUpdate().executeTakeFirst()
        await trx.selectFrom('wallet_accounts').select('customer_id')
          .where('customer_id', '=', topupCustomer.topup_customer_id).forUpdate().executeTakeFirst()
      }
    }
    await trx.selectFrom('payment_attempts').select('id').where('id', '=', attemptId).forUpdate().executeTakeFirst()
    const inserted = await trx.insertInto('payment_provider_events').values({
      id: randomUUID(),
      payment_attempt_id: attemptId,
      source: 'callback',
      event_sha256: observation.eventSha256,
      verification: observation.verification,
      disposition: disposition as ProviderEventDisposition,
      provider_status: observation.status,
      provider_transaction_id: observation.providerOrderId,
      reported_amount: observation.amount,
      currency: 'CNY',
      provider_paid_at: null,
      provider_time_text: observation.providerTimeText,
      payload: observation.payload,
      error_code: observation.errorCode,
    }).onConflict((conflict) => conflict.columns(['payment_attempt_id', 'source', 'event_sha256']).doNothing())
      .returning('id').executeTakeFirst()
    const event = inserted ?? await trx.selectFrom('payment_provider_events').select('id')
      .where('payment_attempt_id', '=', attemptId).where('source', '=', 'callback')
      .where('event_sha256', '=', observation.eventSha256).executeTakeFirstOrThrow()

    // A callback may arrive after a query already settled the order. Detect the
    // contradiction as soon as the signed observation is durable; subsequent
    // settlement and fulfillment paths must honor the open case.
    if (observation.verification === 'verified' && observation.status === 'paid') {
      const priorQueries = await trx.selectFrom('payment_provider_events')
        .select(['id', 'provider_transaction_id', 'reported_amount', 'payload'])
        .where('payment_attempt_id', '=', attemptId).where('source', '=', 'query')
        .where('verification', '=', 'verified').where('provider_status', '=', 'paid').execute()
      const conflictingQuery = priorQueries.find(query => !providerEventMatchesCallback(query, observation))
      if (conflictingQuery) {
        await insertOpenReconciliationCase(trx, {
          paymentAttemptId: attemptId,
          reason: 'callback_query_mismatch',
          callbackEventId: event.id,
          queryEventId: conflictingQuery.id,
        })
        await trx.updateTable('payment_attempts').set({ status: 'reconciliation_required' })
          .where('id', '=', attemptId).where('status', '=', 'succeeded').execute()
      }
    }
    return event.id
  })
}

function queryMatchesAttempt(
  attempt: PaymentAttemptSnapshot,
  credentials: PaymentProviderCredentials,
  result: PaymentQueryResult,
): boolean {
  let normalizedAmount: string | null = null
  try {
    if (result.amount !== null) normalizedAmount = settleAmount(result.amount)
  } catch {
    normalizedAmount = null
  }
  return result.status !== 'unknown'
    && result.currency === 'CNY'
    && result.merchantOrderNo === attempt.merchantOrderNo
    && result.merchantId === credentials.merchantId
    && result.providerOrderId !== null && result.providerOrderId.length > 0 && result.providerOrderId.length <= 200
    && normalizedAmount !== null && normalizedAmount !== '0.00'
}

function callbackMatchesQuery(callback: CallbackObservation, result: PaymentQueryResult): boolean {
  return callback.verification === 'verified' && callback.status === 'paid'
    && callback.merchantOrderNo !== '' && callback.merchantOrderNo === result.merchantOrderNo
    && callback.merchantId !== null && callback.merchantId === result.merchantId
    && callback.providerOrderId !== null && callback.providerOrderId === result.providerOrderId
    && callback.paymentMethod !== null && callback.paymentMethod === result.paymentMethod
    && callback.amount !== null && result.amount !== null
    && safeAmount(callback.amount) !== null && safeAmount(callback.amount) === safeAmount(result.amount)
}

interface SettlementWriteResult {
  receiptDisposition: 'on_time' | 'late' | 'excess' | 'amount_mismatch' | null
  duplicate: boolean
  conflict: boolean
}

type ReconciliationReason = Database['payment_provider_reconciliation_cases']['reason']

async function insertOpenReconciliationCase(
  trx: Transaction<Database>, input: {
    paymentAttemptId: string
    reason: ReconciliationReason
    callbackEventId?: string | null
    queryEventId?: string | null
  },
): Promise<string> {
  const open = await trx.selectFrom('payment_provider_reconciliation_cases')
    .select('id').where('payment_attempt_id', '=', input.paymentAttemptId).where('state', '=', 'open')
    .forUpdate().executeTakeFirst()
  if (open) return open.id
  const id = randomUUID()
  const inserted = await trx.insertInto('payment_provider_reconciliation_cases').values({
    id,
    payment_attempt_id: input.paymentAttemptId,
    reason: input.reason,
    opening_callback_event_id: input.callbackEventId ?? null,
    opening_query_event_id: input.queryEventId ?? null,
    state: 'open',
    resolved_at: null,
    resolved_by_admin_id: null,
    resolution_query_event_sha256: null,
    resolution_provider_transaction_id: null,
    resolution_payment_method: null,
    resolution_confirmed_amount: null,
    resolution_currency: null,
    resolution_payload: null,
  }).onConflict((conflict) => conflict.doNothing()).returning('id').executeTakeFirst()
  if (inserted) return inserted.id
  return await trx.selectFrom('payment_provider_reconciliation_cases').select('id')
    .where('payment_attempt_id', '=', input.paymentAttemptId).where('state', '=', 'open')
    .executeTakeFirstOrThrow().then(row => row.id)
}

function providerEventMatchesCallback(
  event: { provider_transaction_id: string | null; reported_amount: string | null; payload: Record<string, unknown> },
  callback: CallbackObservation,
): boolean {
  const payload = event.payload
  const callbackAmount = callback.amount === null ? null : safeAmount(callback.amount)
  const eventAmount = event.reported_amount === null ? null : safeAmount(event.reported_amount)
  const eventMethod = methodFromProviderValue(payload.type)
  const callbackMethod = callback.paymentMethod
  return event.provider_transaction_id === callback.providerOrderId
    && eventAmount !== null && eventAmount === callbackAmount
    && eventMethod !== null && eventMethod === callbackMethod
    && payload.out_trade_no === callback.merchantOrderNo
    && payload.pid === callback.merchantId
}

function safeAmount(value: string): string | null {
  try { return settleAmount(value) } catch { return null }
}

function methodFromProviderValue(value: unknown): 'alipay' | 'wechat' | null {
  if (value === 'alipay') return 'alipay'
  if (value === 'wxpay') return 'wechat'
  return null
}

function providerEventMatchesQuery(
  event: { provider_transaction_id: string | null; reported_amount: string | null; payload: Record<string, unknown> },
  query: PaymentQueryResult,
): boolean {
  const amount = event.reported_amount === null ? null : safeAmount(event.reported_amount)
  const queryAmount = query.amount === null ? null : safeAmount(query.amount)
  return event.provider_transaction_id === query.providerOrderId
    && amount !== null && amount === queryAmount
    && methodFromProviderValue(event.payload.type) === query.paymentMethod
    && event.payload.out_trade_no === query.merchantOrderNo
    && event.payload.pid === query.merchantId
}

async function writeVerifiedReceipt(
  trx: Transaction<Database>, attempt: PaymentAttemptSnapshot,
  result: PaymentQueryResult, queryEventId: string,
  callback: CallbackObservation | undefined, resolverAdminId?: string,
): Promise<{ settlement: SettlementWriteResult; reconciliationOpen: boolean; resolutionMade: boolean }> {
  const lockedAttempt = await trx.selectFrom('payment_attempts').select(['id', 'status', 'amount', 'provider'])
    .where('id', '=', attempt.id).forUpdate().executeTakeFirst()
  if (!lockedAttempt || !lockedAttempt.provider) {
    return { settlement: { receiptDisposition: null, duplicate: false, conflict: true }, reconciliationOpen: true, resolutionMade: false }
  }
  const callbackEvents = await trx.selectFrom('payment_provider_events')
    .select(['id', 'provider_transaction_id', 'reported_amount', 'payload'])
    .where('payment_attempt_id', '=', attempt.id).where('source', '=', 'callback')
    .where('verification', '=', 'verified').where('provider_status', '=', 'paid').execute()
  const priorPaidQueries = await trx.selectFrom('payment_provider_events')
    .select(['id', 'provider_transaction_id', 'reported_amount', 'payload'])
    .where('payment_attempt_id', '=', attempt.id).where('source', '=', 'query')
    .where('verification', '=', 'verified').where('provider_status', '=', 'paid')
    .where('id', '!=', queryEventId).execute()
  const callbackMismatch = callbackEvents.some(event => !providerEventMatchesQuery(event, result))
    || Boolean(callback && callback.status === 'paid' && !callbackMatchesQuery(callback, result))
  const priorQueryMismatch = priorPaidQueries.some(event => !providerEventMatchesQuery(event, result))
  const methodMismatch = result.paymentMethod !== attempt.paymentMethod
  const existingReceipt = await trx.selectFrom('payment_receipts')
    .select(['provider_transaction_id', 'amount', 'disposition'])
    .where('payment_attempt_id', '=', attempt.id).where('source_bucket', '=', 'external')
    .executeTakeFirst()

  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'payment-receipt:' + lockedAttempt.provider + ':' + result.providerOrderId}, 0))`.execute(trx)
  const globalReceipt = await trx.selectFrom('payment_receipts')
    .select(['payment_attempt_id', 'provider_transaction_id', 'amount', 'disposition'])
    .where('provider', '=', lockedAttempt.provider).where('provider_transaction_id', '=', result.providerOrderId!)
    .executeTakeFirst()
  const globalCollision = Boolean(globalReceipt && globalReceipt.payment_attempt_id !== attempt.id)
  const receiptConflict = Boolean(existingReceipt && (existingReceipt.provider_transaction_id !== result.providerOrderId
    || existingReceipt.amount !== settleAmount(result.amount!)))
  let hasOpenCase = await trx.selectFrom('payment_provider_reconciliation_cases')
    .select('id').where('payment_attempt_id', '=', attempt.id).where('state', '=', 'open')
    .forUpdate().executeTakeFirst()

  let reason: ReconciliationReason | null = null
  if (globalCollision) reason = 'provider_transaction_conflict'
  else if (priorQueryMismatch || (callbackMismatch && !(resolverAdminId && !priorQueryMismatch))) reason = 'callback_query_mismatch'
  else if (methodMismatch && !resolverAdminId) reason = 'provider_identity_conflict'
  else if (receiptConflict) reason = 'receipt_conflict'
  if (reason || (resolverAdminId && hasOpenCase)) {
    const callbackEvent = callbackEvents.find(event => !providerEventMatchesQuery(event, result))
    await insertOpenReconciliationCase(trx, {
      paymentAttemptId: attempt.id,
      reason: reason ?? 'receipt_conflict',
      callbackEventId: callbackEvent?.id ?? null,
      queryEventId,
    })
    hasOpenCase = await trx.selectFrom('payment_provider_reconciliation_cases')
      .select('id').where('payment_attempt_id', '=', attempt.id).where('state', '=', 'open')
      .forUpdate().executeTakeFirst()
    if (globalCollision || receiptConflict) {
      await trx.updateTable('payment_attempts').set({ status: 'reconciliation_required' })
        .where('id', '=', attempt.id).where('status', 'in', ['created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled'])
        .execute()
    }
  }

  let settlement: SettlementWriteResult
  if (existingReceipt) {
    settlement = {
      receiptDisposition: existingReceipt.disposition,
      duplicate: !receiptConflict,
      conflict: receiptConflict,
    }
  } else if (!globalCollision) {
    const inserted = await trx.insertInto('payment_receipts').values({
      id: randomUUID(),
      payment_attempt_id: attempt.id,
      source_bucket: 'external',
      provider: lockedAttempt.provider,
      provider_transaction_id: result.providerOrderId!,
      wallet_operation_id: null,
      wallet_line_no: null,
      amount: settleAmount(result.amount!),
      disposition: 'on_time',
    }).onConflict((conflict) => conflict.doNothing()).returning('id').executeTakeFirst()
    if (inserted) {
      const receipt = await trx.selectFrom('payment_receipts').select('disposition')
        .where('id', '=', inserted.id).executeTakeFirstOrThrow()
      settlement = { receiptDisposition: receipt.disposition, duplicate: false, conflict: false }
    } else {
      const collision = await trx.selectFrom('payment_receipts')
        .select(['payment_attempt_id', 'provider_transaction_id', 'amount', 'disposition'])
        .where('provider', '=', lockedAttempt.provider).where('provider_transaction_id', '=', result.providerOrderId!)
        .executeTakeFirst()
      settlement = {
        receiptDisposition: collision?.payment_attempt_id === attempt.id ? collision.disposition : null,
        duplicate: collision?.payment_attempt_id === attempt.id && collision.amount === settleAmount(result.amount!),
        conflict: !collision || collision.payment_attempt_id !== attempt.id || collision.amount !== settleAmount(result.amount!),
      }
    }
  } else {
    settlement = { receiptDisposition: null, duplicate: false, conflict: true }
  }

  if (settlement.receiptDisposition === 'amount_mismatch' || settlement.receiptDisposition === 'excess') {
    await insertOpenReconciliationCase(trx, {
      paymentAttemptId: attempt.id,
      reason: 'provider_amount_mismatch',
      callbackEventId: callbackEvents[0]?.id ?? null,
      queryEventId,
    })
  } else if (settlement.receiptDisposition === 'late') {
    await insertOpenReconciliationCase(trx, {
      paymentAttemptId: attempt.id,
      reason: 'late_confirmed_payment',
      callbackEventId: callbackEvents[0]?.id ?? null,
      queryEventId,
    })
  }

  let resolutionMade = false
  if (resolverAdminId && hasOpenCase && !reason && !receiptConflict && !globalCollision
    && ['on_time', 'late'].includes(settlement.receiptDisposition ?? '') && !settlement.conflict) {
    const canonicalQueryConflict = priorPaidQueries.some(event => !providerEventMatchesQuery(event, result))
    if (!canonicalQueryConflict && !settlement.conflict
      && ['on_time', 'late'].includes(settlement.receiptDisposition ?? '')) {
      await trx.updateTable('payment_provider_reconciliation_cases').set({
        state: 'resolved',
        resolved_at: new Date(),
        resolved_by_admin_id: resolverAdminId,
        resolution_query_event_sha256: result.eventSha256,
        resolution_provider_transaction_id: result.providerOrderId,
        resolution_payment_method: result.paymentMethod,
        resolution_confirmed_amount: settleAmount(result.amount!),
        resolution_currency: result.currency,
        resolution_payload: result.payload,
      }).where('id', '=', hasOpenCase.id).where('state', '=', 'open').execute()
      if (settlement.receiptDisposition === 'on_time' && settleAmount(result.amount!) === attempt.amount) {
        await trx.updateTable('payment_attempts').set({ status: 'succeeded' })
          .where('id', '=', attempt.id).where('status', '=', 'reconciliation_required').execute()
        if (attempt.walletHoldOperationId) {
          await sql`SELECT resolve_order_wallet_hold(${attempt.walletHoldOperationId}::uuid, 'order_payment_settlement')`.execute(trx)
        }
        if (attempt.orderId) {
          await trx.updateTable('orders').set({ status: 'processing' })
            .where('id', '=', attempt.orderId).where('status', '=', 'pending_payment')
            .where(sql<boolean>`NOT order_has_unresolved_payment_attempts(${attempt.orderId}::uuid)`).execute()
        }
      }
      resolutionMade = true
      hasOpenCase = undefined
    }
  }

  return { settlement, reconciliationOpen: Boolean(hasOpenCase), resolutionMade }
}

export async function processProviderQuery(
  db: Kysely<Database>,
  attempt: PaymentAttemptSnapshot,
  credentials: PaymentProviderCredentials,
  result: PaymentQueryResult,
  callback?: CallbackObservation,
  resolverAdminId?: string,
): Promise<RefreshAttemptResult> {
  const identityVerified = queryMatchesAttempt(attempt, credentials, result)
  const persisted = await db.transaction().execute(async (trx) => {
    if (attempt.orderId) {
      if (attempt.walletHoldOperationId) {
        const orderOwner = await trx.selectFrom('orders').select('customer_id')
          .where('id', '=', attempt.orderId).executeTakeFirst()
        if (orderOwner?.customer_id) {
          await trx.selectFrom('customers').select('id').where('id', '=', orderOwner.customer_id)
            .forUpdate().executeTakeFirst()
        }
      }
      await trx.selectFrom('orders').select('id').where('id', '=', attempt.orderId).forUpdate().executeTakeFirst()
      if (attempt.walletHoldOperationId) {
        const orderOwner = await trx.selectFrom('orders').select('customer_id')
          .where('id', '=', attempt.orderId).executeTakeFirstOrThrow()
        if (orderOwner.customer_id) {
          await trx.selectFrom('wallet_accounts').select('customer_id')
            .where('customer_id', '=', orderOwner.customer_id).forUpdate().executeTakeFirst()
        }
      }
    } else if (attempt.topupCustomerId) {
      await trx.selectFrom('customers').select('id').where('id', '=', attempt.topupCustomerId).forUpdate().executeTakeFirst()
      await trx.selectFrom('wallet_accounts').select('customer_id')
        .where('customer_id', '=', attempt.topupCustomerId).forUpdate().executeTakeFirst()
    }
    await trx.selectFrom('payment_attempts').select('id').where('id', '=', attempt.id).forUpdate().executeTakeFirst()
    const inserted = await trx.insertInto('payment_provider_events').values({
      id: randomUUID(), payment_attempt_id: attempt.id, source: 'query', event_sha256: result.eventSha256,
      verification: identityVerified ? 'verified' : 'unverified',
      disposition: identityVerified
        ? result.status === 'paid' ? 'pending_confirmation'
          : result.status === 'pending' || result.status === 'failed' ? 'not_paid' : 'unknown'
        : 'unknown',
      provider_status: result.status, provider_transaction_id: result.providerOrderId,
      reported_amount: result.amount, currency: result.currency, provider_paid_at: null,
      provider_time_text: result.paidAtText, payload: result.payload,
      error_code: identityVerified ? null : 'provider_query_identity_unknown',
    }).onConflict((conflict) => conflict.columns(['payment_attempt_id', 'source', 'event_sha256']).doNothing())
      .returning('id').executeTakeFirst()
    const queryEvent = inserted ?? await trx.selectFrom('payment_provider_events').select('id')
      .where('payment_attempt_id', '=', attempt.id).where('source', '=', 'query')
      .where('event_sha256', '=', result.eventSha256).executeTakeFirstOrThrow()
    if (!identityVerified || result.status !== 'paid') {
      const callback = await trx.selectFrom('payment_provider_events')
        .select('id').where('payment_attempt_id', '=', attempt.id).where('source', '=', 'callback')
        .where('verification', '=', 'verified').where('provider_status', '=', 'paid')
        .executeTakeFirst()
      if (callback) {
        const open = await trx.selectFrom('payment_provider_reconciliation_cases').select('id')
          .where('payment_attempt_id', '=', attempt.id).where('state', '=', 'open').executeTakeFirst()
        if (!open) {
          await insertOpenReconciliationCase(trx, {
            paymentAttemptId: attempt.id,
            reason: 'provider_identity_conflict',
            callbackEventId: callback.id,
            queryEventId: queryEvent.id,
          })
          await trx.updateTable('payment_attempts').set({ status: 'reconciliation_required' })
            .where('id', '=', attempt.id).where('status', 'in', ['created', 'pending', 'succeeded']).execute()
        }
      }
      const openCase = await trx.selectFrom('payment_provider_reconciliation_cases').select('id')
        .where('payment_attempt_id', '=', attempt.id).where('state', '=', 'open').executeTakeFirst()
      const receipt = await trx.selectFrom('payment_receipts').select('id')
        .where('payment_attempt_id', '=', attempt.id).executeTakeFirst()
      if (identityVerified && result.status === 'failed' && !callback && !receipt && !openCase) {
        await trx.updateTable('payment_attempts').set({ status: 'failed' })
          .where('id', '=', attempt.id).where('status', 'in', ['created', 'pending']).execute()
      }
      return { settlement: null, reconciliationOpen: Boolean(openCase), resolutionMade: false }
    }
    const resultWrite = await writeVerifiedReceipt(trx, attempt, result, queryEvent.id, callback, resolverAdminId)
    if (callback) {
      // The signed callback event was durably recorded before the network query.
      // Its immutable disposition remains pending_confirmation; the query and case
      // rows record the later adjudication without rewriting historic evidence.
    }
    return resultWrite
  })

  if (!identityVerified) return { kind: 'unknown', attempt, providerStatus: result.status, verification: 'unverified' }
  if (persisted.reconciliationOpen || persisted.settlement?.conflict
    || persisted.settlement?.receiptDisposition && persisted.settlement.receiptDisposition !== 'on_time') {
    return { kind: 'reconciliation_required', attempt, providerStatus: result.status, verification: 'verified', resolutionMade: persisted.resolutionMade }
  }
  if (result.status === 'paid') return { kind: 'confirmed', attempt, providerStatus: result.status, verification: 'verified', resolutionMade: persisted.resolutionMade }
  if (result.status === 'pending') return { kind: 'pending', attempt, providerStatus: result.status, verification: 'verified' }
  return { kind: 'unknown', attempt, providerStatus: result.status, verification: 'verified' }
}

async function claimProviderQuery(db: Kysely<Database>, attemptId: string): Promise<boolean> {
  const result = await sql<{ payment_attempt_id: string }>`
    UPDATE payment_attempt_provider_state
    SET last_query_at = clock_timestamp()
    WHERE payment_attempt_id = ${attemptId}::uuid
      AND (last_query_at IS NULL OR last_query_at <= clock_timestamp() - (${providerQueryCooldownSeconds} * interval '1 second'))
    RETURNING payment_attempt_id
  `.execute(db)
  return result.rows.length === 1
}

export async function refreshPaymentAttempt(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter, attemptId: string,
): Promise<RefreshAttemptResult> {
  const attempt = await loadPaymentAttemptSnapshot(db, attemptId)
  if (!attempt) throw new PaymentServiceError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', '支付尝试不存在。')
  const openCase = attempt.status === 'reconciliation_required'
    ? await db.selectFrom('payment_provider_reconciliation_cases').select('id')
      .where('payment_attempt_id', '=', attempt.id).where('state', '=', 'open').executeTakeFirst()
    : undefined
  if (attempt.status !== 'created' && attempt.status !== 'pending' && !openCase) {
    return {
      kind: attempt.status === 'succeeded' ? 'confirmed' : 'reconciliation_required',
      attempt,
      providerStatus: attempt.status === 'succeeded' ? 'paid' : 'unknown',
      verification: attempt.status === 'succeeded' ? 'verified' : 'unverified',
    }
  }
  if (!provider.supportsStatusQuery) {
    throw new PaymentServiceError(409, 'PAYMENT_STATUS_QUERY_UNAVAILABLE', '该支付通道不支持安全的主动查单。')
  }
  if (!(await claimProviderQuery(db, attempt.id))) return { kind: 'throttled', attempt }
  const credentials = await loadAttemptCredentials(db, config, attempt)
  const query = await provider.query(credentials, attempt.merchantOrderNo)
  return await processProviderQuery(db, attempt, credentials, query)
}

export async function resolvePaymentReconciliation(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
  attemptId: string, administratorId: string,
): Promise<RefreshAttemptResult> {
  const attempt = await loadPaymentAttemptSnapshot(db, attemptId)
  if (!attempt) throw new PaymentServiceError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', '支付尝试不存在。')
  const openCase = await db.selectFrom('payment_provider_reconciliation_cases').select('id')
    .where('payment_attempt_id', '=', attempt.id).where('state', '=', 'open').executeTakeFirst()
  if (!openCase) throw new PaymentServiceError(409, 'PAYMENT_RECONCILIATION_NOT_OPEN', '此支付尝试没有待核对异常。')
  if (!provider.supportsStatusQuery) {
    throw new PaymentServiceError(409, 'PAYMENT_STATUS_QUERY_UNAVAILABLE', '该支付通道不支持安全的主动查单。')
  }
  if (!(await claimProviderQuery(db, attempt.id))) return { kind: 'throttled', attempt }
  const credentials = await loadAttemptCredentials(db, config, attempt)
  const query = await provider.query(credentials, attempt.merchantOrderNo)
  return await processProviderQuery(db, attempt, credentials, query, undefined, administratorId)
}

export async function handleProviderCallback(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
  attempt: PaymentAttemptSnapshot, parameters: Record<string, string>, eventSha256: string,
): Promise<'accepted' | 'retry' | 'unverified'> {
  const credentials = await loadAttemptCredentials(db, config, attempt)
  const verified = provider.verifyCallback(credentials, parameters, eventSha256)
  if (!verified) {
    const minimalPayload: Record<string, string> = {}
    for (const key of ['pid', 'out_trade_no', 'trade_no', 'type', 'money', 'trade_status', 'sign_type']) {
      if (parameters[key] !== undefined) minimalPayload[key] = parameters[key]!.slice(0, 2048)
    }
    await recordCallbackObservation(db, attempt.id, {
      verification: 'unverified', eventSha256, merchantOrderNo: attempt.merchantOrderNo,
      merchantId: minimalPayload.pid ?? null,
      providerOrderId: minimalPayload.trade_no ?? null,
      paymentMethod: null,
      amount: null,
      status: 'unknown',
      payload: minimalPayload,
      providerTimeText: null,
      errorCode: 'callback_signature_invalid',
    }, 'unknown')
    return 'unverified'
  }

  const observation: CallbackObservation = {
    verification: 'verified',
    eventSha256,
    merchantOrderNo: verified.merchantOrderNo ?? attempt.merchantOrderNo,
    merchantId: verified.merchantId,
    providerOrderId: verified.providerOrderId,
    paymentMethod: verified.paymentMethod,
    amount: verified.amount,
    status: verified.status,
    payload: verified.payload,
    providerTimeText: verified.providerTimeText,
    errorCode: null,
  }
  if (verified.status !== 'paid') {
    await recordCallbackObservation(
      db, attempt.id, observation, verified.status === 'unknown' ? 'unknown' : 'not_paid',
    )
    return 'accepted'
  }

  const priorEvent = await db.selectFrom('payment_provider_events')
    .select(['verification', 'disposition'])
    .where('payment_attempt_id', '=', attempt.id)
    .where('source', '=', 'callback')
    .where('event_sha256', '=', eventSha256)
    .executeTakeFirst()
  if (priorEvent?.verification === 'verified' && priorEvent.disposition !== 'pending_confirmation') return 'accepted'

  // Persist signed funds evidence before making the provider query so any
  // concurrent refresh observes it before attempting automatic settlement.
  await recordCallbackObservation(db, attempt.id, observation, 'pending_confirmation')

  const priorReceipt = await db.selectFrom('payment_receipts').select(['provider_transaction_id', 'amount', 'disposition'])
    .where('payment_attempt_id', '=', attempt.id).where('source_bucket', '=', 'external').executeTakeFirst()
  if (priorReceipt && priorReceipt.provider_transaction_id === observation.providerOrderId
    && priorReceipt.amount === observation.amount && priorReceipt.disposition === 'on_time'
    && observation.merchantOrderNo === attempt.merchantOrderNo
    && observation.merchantId === credentials.merchantId && observation.paymentMethod === attempt.paymentMethod) {
    return 'accepted'
  }
  const unresolvedCase = await db.selectFrom('payment_provider_reconciliation_cases').select('id')
    .where('payment_attempt_id', '=', attempt.id).where('state', '=', 'open').executeTakeFirst()
  if (unresolvedCase) return 'accepted'

  if (!provider.supportsStatusQuery || !(await claimProviderQuery(db, attempt.id))) {
    return 'retry'
  }
  const query = await provider.query(credentials, attempt.merchantOrderNo)
  const result = await processProviderQuery(db, attempt, credentials, query, observation)
  if (result.kind === 'confirmed' || result.kind === 'reconciliation_required') return 'accepted'
  return 'retry'
}
