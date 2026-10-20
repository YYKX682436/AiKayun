import { randomUUID } from 'node:crypto'
import { settleAmount } from '@aikayun/money'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { AppConfig } from '../config.js'
import type { Database, PaymentAttemptStatus, PaymentProviderRequestState } from '../db/types.js'
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
  orderId: string
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
      'attempt.id as id', 'attempt.order_id as order_id', 'attempt.amount as amount',
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
  if (!row || !row.order_id || row.provider_type !== 'zpay_epay_v1' || !row.payment_method
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
): Promise<void> {
  await db.insertInto('payment_provider_events').values({
    id: randomUUID(),
    payment_attempt_id: attemptId,
    source: 'callback',
    event_sha256: observation.eventSha256,
    verification: observation.verification,
    disposition: disposition as 'settled' | 'duplicate' | 'not_paid' | 'pending_confirmation' | 'reconciliation_required' | 'unknown',
    provider_status: observation.status,
    provider_transaction_id: observation.providerOrderId,
    reported_amount: observation.amount,
    currency: 'CNY',
    provider_paid_at: null,
    provider_time_text: observation.providerTimeText,
    payload: observation.payload,
    error_code: observation.errorCode,
  }).onConflict((conflict) => conflict.columns(['payment_attempt_id', 'source', 'event_sha256']).doNothing()).execute()
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
    && result.paymentMethod === attempt.paymentMethod
    && normalizedAmount !== null && normalizedAmount !== '0.00'
}

function callbackMatchesQuery(callback: CallbackObservation, result: PaymentQueryResult): boolean {
  return callback.verification === 'verified' && callback.status === 'paid'
    && callback.merchantOrderNo !== '' && callback.merchantOrderNo === result.merchantOrderNo
    && callback.merchantId !== null && callback.merchantId === result.merchantId
    && callback.providerOrderId !== null && callback.providerOrderId === result.providerOrderId
    && callback.paymentMethod !== null && callback.paymentMethod === result.paymentMethod
    && callback.amount !== null && result.amount !== null
    && settleAmount(callback.amount) === settleAmount(result.amount)
}

interface SettlementWriteResult {
  receiptDisposition: 'on_time' | 'late' | 'excess' | 'amount_mismatch' | null
  duplicate: boolean
  conflict: boolean
}

async function writeVerifiedReceipt(
  db: Kysely<Database>, attempt: PaymentAttemptSnapshot, result: PaymentQueryResult,
): Promise<SettlementWriteResult> {
  return await db.transaction().execute(async (trx) => {
    // Match the receipt trigger and order-close path: order row first, then
    // payment attempt. No provider network request runs inside this transaction.
    await trx.selectFrom('orders').select('id').where('id', '=', attempt.orderId).forUpdate().executeTakeFirst()
    const lockedAttempt = await trx.selectFrom('payment_attempts').select(['id', 'status', 'amount', 'provider'])
      .where('id', '=', attempt.id).forUpdate().executeTakeFirst()
    if (!lockedAttempt || !lockedAttempt.provider) return { receiptDisposition: null, duplicate: false, conflict: true }

    const currentAttemptReceipts = await trx.selectFrom('payment_receipts')
      .select(['provider_transaction_id', 'amount', 'disposition'])
      .where('payment_attempt_id', '=', attempt.id).where('source_bucket', '=', 'external')
      .execute()
    if (currentAttemptReceipts.length) {
      const prior = currentAttemptReceipts[0]!
      const sameIdentity = prior.provider_transaction_id === result.providerOrderId
      const sameAmount = prior.amount === result.amount
      return {
        receiptDisposition: prior.disposition,
        duplicate: sameIdentity && sameAmount,
        conflict: !sameIdentity || !sameAmount,
      }
    }

    const globalTransaction = await trx.selectFrom('payment_receipts')
      .select(['payment_attempt_id', 'amount'])
      .where('provider', '=', lockedAttempt.provider)
      .where('provider_transaction_id', '=', result.providerOrderId!)
      .executeTakeFirst()
    if (globalTransaction) return { receiptDisposition: null, duplicate: false, conflict: true }

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
    if (!inserted) {
      const collision = await trx.selectFrom('payment_receipts')
        .select(['payment_attempt_id', 'provider_transaction_id', 'amount', 'disposition'])
        .where('provider', '=', lockedAttempt.provider)
        .where('provider_transaction_id', '=', result.providerOrderId!)
        .executeTakeFirst()
      return {
        receiptDisposition: collision?.payment_attempt_id === attempt.id ? collision.disposition : null,
        duplicate: collision?.payment_attempt_id === attempt.id && collision.provider_transaction_id === result.providerOrderId
          && collision.amount === result.amount,
        conflict: !collision || collision.payment_attempt_id !== attempt.id || collision.amount !== result.amount,
      }
    }
    const receipt = await trx.selectFrom('payment_receipts').select('disposition').where('id', '=', inserted.id).executeTakeFirstOrThrow()
    return { receiptDisposition: receipt.disposition, duplicate: false, conflict: false }
  })
}

function finalDisposition(result: SettlementWriteResult): string {
  if (result.conflict) return 'reconciliation_required'
  if (result.duplicate) return 'duplicate'
  if (result.receiptDisposition === 'on_time') return 'settled'
  if (result.receiptDisposition) return 'reconciliation_required'
  return 'unknown'
}

function eventDispositionForCallback(
  callback: CallbackObservation,
  query: PaymentQueryResult,
  queryVerified: boolean,
  settlement: SettlementWriteResult | null,
): string {
  if (callback.verification === 'unverified') return 'unknown'
  if (callback.status !== 'paid') return callback.status === 'unknown' ? 'unknown' : 'not_paid'
  if (!queryVerified || query.status !== 'paid') return 'pending_confirmation'
  if (!callbackMatchesQuery(callback, query)) return 'reconciliation_required'
  return settlement ? finalDisposition(settlement) : 'unknown'
}

export async function processProviderQuery(
  db: Kysely<Database>,
  attempt: PaymentAttemptSnapshot,
  credentials: PaymentProviderCredentials,
  result: PaymentQueryResult,
  callback?: CallbackObservation,
): Promise<RefreshAttemptResult> {
  const verified = queryMatchesAttempt(attempt, credentials, result)
  const callbackMismatch = Boolean(callback && callback.status === 'paid' && result.status === 'paid'
    && verified && !callbackMatchesQuery(callback, result))
  let settlement: SettlementWriteResult | null = null
  if (verified && result.status === 'paid' && !callbackMismatch) {
    settlement = await writeVerifiedReceipt(db, attempt, result)
  }

  const queryDisposition = verified
    ? result.status === 'paid'
      ? callbackMismatch ? 'reconciliation_required' : finalDisposition(settlement!)
      : result.status === 'pending' || result.status === 'failed' ? 'not_paid' : 'unknown'
    : 'unknown'
  await db.transaction().execute(async (trx) => {
    if (callback) {
      await trx.insertInto('payment_provider_events').values({
        id: randomUUID(),
        payment_attempt_id: attempt.id,
        source: 'callback',
        event_sha256: callback.eventSha256,
        verification: callback.verification,
        disposition: eventDispositionForCallback(callback, result, verified, settlement) as 'settled' | 'duplicate' | 'not_paid' | 'pending_confirmation' | 'reconciliation_required' | 'unknown',
        provider_status: callback.status,
        provider_transaction_id: callback.providerOrderId,
        reported_amount: callback.amount,
        currency: 'CNY',
        provider_paid_at: null,
        provider_time_text: callback.providerTimeText,
        payload: callback.payload,
        error_code: callback.errorCode,
      }).onConflict((conflict) => conflict.columns(['payment_attempt_id', 'source', 'event_sha256']).doNothing()).execute()
    }
    await trx.insertInto('payment_provider_events').values({
      id: randomUUID(),
      payment_attempt_id: attempt.id,
      source: 'query',
      event_sha256: result.eventSha256,
      verification: verified ? 'verified' : 'unverified',
      disposition: queryDisposition as 'settled' | 'duplicate' | 'not_paid' | 'pending_confirmation' | 'reconciliation_required' | 'unknown',
      provider_status: result.status,
      provider_transaction_id: result.providerOrderId,
      reported_amount: result.amount,
      currency: 'CNY',
      provider_paid_at: null,
      provider_time_text: result.paidAtText,
      payload: result.payload,
      error_code: verified ? null : 'provider_query_identity_unknown',
    }).onConflict((conflict) => conflict.columns(['payment_attempt_id', 'source', 'event_sha256']).doNothing()).execute()
  })

  if (!verified) {
    return { kind: 'unknown', attempt, providerStatus: result.status, verification: 'unverified' }
  }
  if (result.status === 'paid') {
    if (callbackMismatch) {
      return { kind: 'reconciliation_required', attempt, providerStatus: result.status, verification: 'verified' }
    }
    if (settlement?.conflict || settlement?.receiptDisposition && settlement.receiptDisposition !== 'on_time') {
      return { kind: 'reconciliation_required', attempt, providerStatus: result.status, verification: 'verified' }
    }
    return { kind: settlement?.duplicate ? 'confirmed' : 'confirmed', attempt, providerStatus: result.status, verification: 'verified' }
  }
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
  if (attempt.status !== 'created' && attempt.status !== 'pending') {
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
  if (verified.merchantOrderNo !== attempt.merchantOrderNo || verified.merchantId !== credentials.merchantId) {
    await recordCallbackObservation(db, attempt.id, { ...observation, errorCode: 'callback_merchant_identity_mismatch' }, 'reconciliation_required')
    return 'accepted'
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

  if (!provider.supportsStatusQuery || !(await claimProviderQuery(db, attempt.id))) {
    await recordCallbackObservation(db, attempt.id, { ...observation, errorCode: 'provider_query_throttled' }, 'pending_confirmation')
    return 'retry'
  }
  const query = await provider.query(credentials, attempt.merchantOrderNo)
  const result = await processProviderQuery(db, attempt, credentials, query, observation)
  if (result.kind === 'confirmed' || result.kind === 'reconciliation_required') return 'accepted'
  return 'retry'
}
