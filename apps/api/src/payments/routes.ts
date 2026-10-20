import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  AdminWalletCustomerParamsSchema,
  AdminWalletDetailSchema,
  AdminWalletListQuerySchema,
  AdminWalletListSchema,
  AdminPaymentReconciliationParamsSchema,
  AdminPaymentReconciliationResultSchema,
  AdminTopUpReconciliationParamsSchema,
  CreateOrderPaymentBodySchema,
  CreateWalletTopUpBodySchema,
  CustomerOrderPaymentSchema,
  CustomerWalletLedgerPageSchema,
  CustomerWalletPageQuerySchema,
  CustomerWalletSummarySchema,
  CustomerTopUpPageSchema,
  PaymentOrderIdParamsSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  AdminWalletListQuery,
  CreateOrderPaymentBody,
  CreateWalletTopUpBody,
  CustomerWalletPageQuery,
  ExternalPaymentMethod,
  PaymentAction,
} from '@aikayun/contracts'
import { addSettlementAmounts, allocateWalletOrderPayment, normalizeWalletAmount, settleAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import { CUSTOMER_CSRF_COOKIE, optionalCustomer, type AuthenticatedCustomer } from '../auth/customer.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import { assertCustomerSession, assertGuestSession, guestSessionCookie } from '../commerce/orders.js'
import type { Database, PaymentAttemptStatus, PaymentProviderRequestState } from '../db/types.js'
import { decryptPaymentConfig, encryptPaymentConfig, parsePaymentConfig, serializePaymentConfig } from './credentials.js'
import { registerPaymentChannelRoutes } from './channels.js'
import { recordWalletOrderPayment } from '../finance/wallet.js'
import type { PaymentProviderAdapter } from './provider.js'
import { PaymentServiceError, handleProviderCallback, loadPaymentAttemptSnapshot, refreshPaymentAttempt, resolvePaymentReconciliation } from './settlement.js'

const providerName = 'epay:zpayz.cn'
const paymentAttemptLifetimeMs = 10 * 60 * 1000
const paymentMerchantOrderLength = 32

type TransactionDb = Transaction<Database>
type Owner = { customer: AuthenticatedCustomer | null; guestSessionToken?: string }

interface OwnedOrder {
  id: string
  status: 'pending_payment' | 'processing' | 'completed' | 'closed'
  total_amount: string
  currency: 'CNY'
  created_at: Date
  unpaid_expires_at: Date | null
}

class PaymentRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'PaymentRouteError'
  }
}

function handlePaymentError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof PaymentRouteError || error instanceof PaymentServiceError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  const known = error as { status?: unknown; code?: unknown; message?: unknown }
  if (typeof known?.status === 'number' && typeof known.code === 'string' && typeof known.message === 'string') {
    return reply.code(known.status).send(failure(known.code, known.message, requestId))
  }
  throw error
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function merchantOrderNo(): string {
  let output = ''
  for (let index = 0; index < paymentMerchantOrderLength; index += 1) output += String(randomInt(10))
  return output
}

function credentialContext(channelId: string, credentialVersion: number): string {
  return `payment-channel:${channelId}:credential:${credentialVersion}`
}

function attemptCredentialContext(attemptId: string, credentialVersion: number): string {
  return `payment-attempt:${attemptId}:config:${credentialVersion}`
}

async function resolveOwner(trx: TransactionDb, request: FastifyRequest, owner: Owner): Promise<{ customerId: string | null; guestSessionId: string | null }> {
  if (owner.customer) {
    await assertCustomerSession(trx, owner.customer)
    return { customerId: owner.customer.id, guestSessionId: null }
  }
  const sessionId = await assertGuestSession(trx, owner.guestSessionToken)
  return { customerId: null, guestSessionId: sessionId }
}

async function loadOwnedOrder(
  trx: TransactionDb,
  orderId: string,
  request: FastifyRequest,
  owner: Owner,
  forUpdate = false,
): Promise<OwnedOrder> {
  const resolved = await resolveOwner(trx, request, owner)
  let query = trx.selectFrom('orders').select([
    'id', 'status', 'total_amount', 'currency', 'created_at', 'unpaid_expires_at',
  ]).where('id', '=', orderId)
  query = resolved.customerId
    ? query.where('customer_id', '=', resolved.customerId)
    : query.where('guest_order_session_id', '=', resolved.guestSessionId!)
  if (forUpdate) query = query.forUpdate()
  const order = await query.executeTakeFirst()
  if (!order) throw new PaymentRouteError(404, 'ORDER_NOT_FOUND', '找不到属于当前顾客或游客会话的订单。')
  return order
}

function ownerFor(request: FastifyRequest): Owner {
  if (request.customer) return { customer: request.customer }
  const token = request.cookies[guestSessionCookie]
  return token ? { customer: null, guestSessionToken: token } : { customer: null }
}

async function buildCustomerPaymentView(
  db: Kysely<Database>, request: FastifyRequest, orderId: string, owner: Owner,
): Promise<{
  orderId: string
  orderStatus: OwnedOrder['status']
  paymentStatus: 'unpaid' | 'pending' | 'paid' | 'late_paid' | 'reconciliation_required' | 'not_payable'
  totalAmount: string
  confirmedAmount: string
  currency: 'CNY'
  unpaidExpiresAt: string | null
  channels: Array<{ id: string; name: string; paymentMethods: ExternalPaymentMethod[] }>
  walletBalance: { cashAvailable: string; giftAvailable: string; totalAvailable: string } | null
  attempt: null | {
    id: string
    status: PaymentAttemptStatus
    providerState: PaymentProviderRequestState | null
    paymentMethod: ExternalPaymentMethod | null
    channelName: string | null
    action: PaymentAction | null
    expiresAt: string | null
    completedAt: string | null
    errorCode: string | null
    source: 'external' | 'wallet'
    amount: string
    walletGiftAmount: string
    walletCashAmount: string
    walletRequestedAmount: string | null
  }
}> {
  const order = await db.transaction().execute(async (trx) => await loadOwnedOrder(trx, orderId, request, owner))
  const timeRow = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)
  const now = timeRow.rows[0]!.now
  const receipts = await db.selectFrom('payment_receipts as receipt')
    .innerJoin('payment_attempts as attempt', 'attempt.id', 'receipt.payment_attempt_id')
    .select([
      sql<string>`COALESCE(sum(receipt.amount), 0)::text`.as('amount'),
      sql<number>`count(*)::int`.as('receipt_count'),
      sql<boolean>`COALESCE(bool_or(receipt.disposition = 'late'), false)`.as('has_late'),
      sql<boolean>`COALESCE(bool_or(receipt.disposition IN ('excess', 'amount_mismatch')), false)`.as('has_mismatch'),
    ])
    .where('attempt.order_id', '=', orderId)
    .executeTakeFirstOrThrow()
  const providerEvidence = await db.selectFrom('payment_provider_events as event')
    .innerJoin('payment_attempts as attempt', 'attempt.id', 'event.payment_attempt_id')
    .select(sql<boolean>`COALESCE(bool_or(event.disposition = 'reconciliation_required'), false)`.as('needs_reconciliation'))
    .where('attempt.order_id', '=', orderId)
    .executeTakeFirstOrThrow()
  const openCase = await db.selectFrom('payment_provider_reconciliation_cases as reconciliation')
    .innerJoin('payment_attempts as attempt', 'attempt.id', 'reconciliation.payment_attempt_id')
    .select('reconciliation.id').where('attempt.order_id', '=', orderId)
    .where('reconciliation.state', '=', 'open').limit(1).executeTakeFirst()
  const attempts = await db.selectFrom('payment_attempts')
    .select('id')
    .where('order_id', '=', orderId)
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(1).execute()
  const attemptSnapshot = attempts[0]
    ? await loadPaymentAttemptSnapshot(db, attempts[0].id)
    : undefined
  const attemptRow = attempts[0]
    ? await db.selectFrom('payment_attempts').select([
      'id', 'status', 'source', 'amount', 'wallet_operation_id', 'wallet_hold_operation_id', 'requested_wallet_amount',
      'payment_method_snapshot', 'payment_channel_name_snapshot', 'expires_at', 'completed_at',
    ])
      .where('id', '=', attempts[0].id).executeTakeFirst()
    : undefined
  const walletOperationId = attemptRow?.source === 'wallet'
    ? attemptRow.wallet_operation_id
    : attemptRow?.wallet_hold_operation_id
  const walletLegs = walletOperationId
    ? await db.selectFrom('wallet_ledger_entries').select([
      'bucket', sql<string>`sum(amount)::text`.as('amount'),
    ]).where('wallet_operation_id', '=', walletOperationId).where('action', 'in', ['debit_available', 'freeze'])
      .groupBy('bucket').execute()
    : []
  const walletAccount = request.customer
    ? await db.selectFrom('wallet_accounts').select(['cash_available', 'gift_available'])
      .where('customer_id', '=', request.customer.id).executeTakeFirst()
    : undefined
  let paymentStatus: 'unpaid' | 'pending' | 'paid' | 'late_paid' | 'reconciliation_required' | 'not_payable'
  if (receipts.has_mismatch || providerEvidence.needs_reconciliation || openCase) paymentStatus = 'reconciliation_required'
  else if (receipts.has_late) paymentStatus = 'late_paid'
  else if (receipts.receipt_count > 0 && ['processing', 'completed'].includes(order.status)) paymentStatus = 'paid'
  else if (order.status !== 'pending_payment' || !order.unpaid_expires_at || order.unpaid_expires_at <= now) paymentStatus = 'not_payable'
  else if (attemptRow && ['created', 'pending'].includes(attemptRow.status)) paymentStatus = 'pending'
  else paymentStatus = 'unpaid'

  const payable = order.status === 'pending_payment'
    && order.unpaid_expires_at !== null && order.unpaid_expires_at > now
    && receipts.receipt_count === 0 && !openCase
  const rows = payable
    ? await db.selectFrom('payment_channels').select(['id', 'name', 'payment_methods'])
      .where('enabled', '=', true).where('provider_type', '=', 'zpay_epay_v1')
      .where('config_ciphertext', 'is not', null)
      .orderBy('display_order').orderBy('created_at').orderBy('id').execute()
    : []
  const activeAttempt = attemptRow && ['created', 'pending', 'reconciliation_required'].includes(attemptRow.status)
    ? attemptSnapshot
    : undefined
  return {
    orderId: order.id,
    orderStatus: order.status,
    paymentStatus,
    totalAmount: settleAmount(order.total_amount),
    confirmedAmount: settleAmount(receipts.amount),
    currency: 'CNY',
    unpaidExpiresAt: order.unpaid_expires_at?.toISOString() ?? null,
    walletBalance: walletAccount ? {
      cashAvailable: settleAmount(walletAccount.cash_available),
      giftAvailable: settleAmount(walletAccount.gift_available),
      totalAvailable: addSettlementAmounts(walletAccount.cash_available, walletAccount.gift_available),
    } : null,
    channels: rows.filter(row => row.payment_methods.length > 0).map(row => ({
      id: row.id, name: row.name, paymentMethods: row.payment_methods as ExternalPaymentMethod[],
    })),
    attempt: attemptRow ? {
      id: attemptRow.id,
      status: attemptRow.status,
      providerState: attemptSnapshot?.providerState ?? null,
      paymentMethod: attemptSnapshot?.paymentMethod ?? null,
      channelName: attemptSnapshot?.channelName ?? null,
      action: payable && activeAttempt?.providerState === 'ready' ? activeAttempt.action : null,
      expiresAt: attemptRow.expires_at?.toISOString() ?? null,
      completedAt: attemptRow.completed_at?.toISOString() ?? null,
      errorCode: attemptSnapshot?.lastErrorCode ?? null,
      source: attemptRow.source,
      amount: settleAmount(attemptRow.amount),
      walletGiftAmount: walletLegs.find(row => row.bucket === 'gift')?.amount ?? '0.00',
      walletCashAmount: walletLegs.find(row => row.bucket === 'cash')?.amount ?? '0.00',
      walletRequestedAmount: attemptRow.requested_wallet_amount ? settleAmount(attemptRow.requested_wallet_amount) : null,
    } : null,
  }
}

interface NewAttemptResult {
  attemptId: string
  created: boolean
  shouldStartProviderRequest: boolean
  shouldRecover: boolean
  credentials: { merchantId: string; merchantKey: string } | null
  merchantOrderNo: string | null
  expiresAt: Date | null
  amount: string | null
  productName: string | null
  paymentMethod?: ExternalPaymentMethod
}

async function createOrReuseWalletOrderPayment(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
  request: FastifyRequest, orderId: string, owner: Owner, body: CreateOrderPaymentBody,
): Promise<NewAttemptResult> {
  if (!owner.customer) throw new PaymentRouteError(403, 'WALLET_LOGIN_REQUIRED', '游客订单不能使用顾客钱包。')
  if (!body.walletAmount) throw new PaymentRouteError(400, 'WALLET_AMOUNT_REQUIRED', '请选择钱包支付金额。')
  let requestedWalletAmount: string
  try { requestedWalletAmount = normalizeWalletAmount(body.walletAmount) } catch {
    throw new PaymentRouteError(400, 'WALLET_AMOUNT_INVALID', '钱包金额格式无效。')
  }
  const requestHash = sha256(JSON.stringify({
    orderId,
    walletAmount: requestedWalletAmount,
    channelId: body.channelId ?? null,
    paymentMethod: body.paymentMethod ?? null,
  }))
  const requestedChannelId = body.channelId
  const requestedPaymentMethod = body.paymentMethod
  return await db.transaction().execute(async (trx) => {
    await assertCustomerSession(trx, owner.customer!, true)
    const order = await loadOwnedOrder(trx, orderId, request, owner, true)

    const existingByKey = await trx.selectFrom('payment_attempts').select(['id', 'request_sha256', 'source', 'status'])
      .where('idempotency_key', '=', body.idempotencyKey).executeTakeFirst()
    if (existingByKey) {
      if (existingByKey.request_sha256 !== requestHash) {
        throw new PaymentRouteError(409, 'PAYMENT_IDEMPOTENCY_CONFLICT', '此支付请求标识已用于不同的钱包金额或支付方式。')
      }
      const snapshot = await loadPaymentAttemptSnapshot(trx as unknown as Kysely<Database>, existingByKey.id)
      const requestState = await trx.selectFrom('payment_attempt_provider_state').select(['state', 'request_started_at'])
        .where('payment_attempt_id', '=', existingByKey.id).executeTakeFirst()
      return {
        attemptId: existingByKey.id,
        created: false,
        shouldStartProviderRequest: false,
        shouldRecover: Boolean(snapshot && (snapshot.providerState === 'unknown'
          || snapshot.providerState === 'requesting' && requestState
          && Date.now() - requestState.request_started_at.getTime() >= 10_000)),
        credentials: null,
        merchantOrderNo: snapshot?.merchantOrderNo ?? null,
        expiresAt: snapshot?.expiresAt ?? null,
        amount: snapshot?.amount ?? null,
        productName: null,
        ...(snapshot?.paymentMethod ? { paymentMethod: snapshot.paymentMethod } : {}),
      }
    }

    const active = await trx.selectFrom('payment_attempts').select(['id', 'source', 'status'])
      .where('order_id', '=', orderId).where('status', 'in', ['created', 'pending', 'reconciliation_required'])
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst()
    if (active) {
      const snapshot = await loadPaymentAttemptSnapshot(trx as unknown as Kysely<Database>, active.id)
      const requestState = await trx.selectFrom('payment_attempt_provider_state').select(['state', 'request_started_at'])
        .where('payment_attempt_id', '=', active.id).executeTakeFirst()
      return {
        attemptId: active.id,
        created: false,
        shouldStartProviderRequest: false,
        shouldRecover: Boolean(snapshot && (snapshot.providerState === 'unknown'
          || snapshot.providerState === 'requesting' && requestState
          && Date.now() - requestState.request_started_at.getTime() >= 10_000)),
        credentials: null,
        merchantOrderNo: snapshot?.merchantOrderNo ?? null,
        expiresAt: snapshot?.expiresAt ?? null,
        amount: snapshot?.amount ?? null,
        productName: null,
        ...(snapshot?.paymentMethod ? { paymentMethod: snapshot.paymentMethod } : {}),
      }
    }

    const nowRow = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
    const now = nowRow.rows[0]!.now
    if (order.status !== 'pending_payment' || !order.unpaid_expires_at || order.unpaid_expires_at <= now) {
      throw new PaymentRouteError(409, 'ORDER_NOT_PAYABLE', '订单已付款、已关闭或超过付款截止时间。')
    }
    if (order.currency !== 'CNY') throw new PaymentRouteError(409, 'PAYMENT_CURRENCY_UNSUPPORTED', '当前支付通道仅支持人民币订单。')
    if (settleAmount(order.total_amount) === '0.00') throw new PaymentRouteError(409, 'ORDER_PAYMENT_NOT_REQUIRED', '零元订单不需要付款。')
    const openCase = await trx.selectFrom('payment_provider_reconciliation_cases as reconciliation')
      .innerJoin('payment_attempts as attempt', 'attempt.id', 'reconciliation.payment_attempt_id')
      .select('reconciliation.id').where('attempt.order_id', '=', orderId)
      .where('reconciliation.state', '=', 'open').limit(1).executeTakeFirst()
    if (openCase) throw new PaymentRouteError(409, 'PAYMENT_RECONCILIATION_REQUIRED', '订单有待核对的服务商资金证据，暂不能再次付款。')
    const receipt = await trx.selectFrom('payment_receipts as receipt')
      .innerJoin('payment_attempts as attempt', 'attempt.id', 'receipt.payment_attempt_id')
      .select('receipt.id').where('attempt.order_id', '=', orderId).limit(1).executeTakeFirst()
    if (receipt) throw new PaymentRouteError(409, 'PAYMENT_RECONCILIATION_REQUIRED', '订单已有实际收款凭证，暂不能再次付款。')

    const account = await trx.selectFrom('wallet_accounts').selectAll()
      .where('customer_id', '=', owner.customer!.id).forUpdate().executeTakeFirst()
    if (!account) throw new PaymentRouteError(409, 'WALLET_ACCOUNT_NOT_FOUND', '当前顾客钱包暂不可用。')
    let allocation: ReturnType<typeof allocateWalletOrderPayment>
    try {
      allocation = allocateWalletOrderPayment(order.total_amount, requestedWalletAmount, account.gift_available, account.cash_available)
    } catch {
      throw new PaymentRouteError(409, 'WALLET_AMOUNT_INVALID', '钱包支付金额必须大于零且不能超过订单金额。')
    }
    const toCents = (amount: string) => {
      const [whole, fraction] = amount.split('.')
      return BigInt(whole!) * 100n + BigInt(fraction!)
    }
    if (toCents(allocation.giftAmount) + toCents(allocation.cashAmount) !== toCents(requestedWalletAmount)) {
      throw new PaymentRouteError(409, 'WALLET_INSUFFICIENT_BALANCE', '钱包余额不足以支付所选金额，请刷新余额或选择组合支付。')
    }

    let credentials: { merchantId: string; merchantKey: string } | null = null
    let externalPaymentSnapshot: {
      channelId: string
      providerType: 'zpay_epay_v1'
      paymentMethod: ExternalPaymentMethod
      channelName: string
      credentialVersion: number
      merchantOrderNo: string
      expiresAt: Date
    } | undefined
    if (allocation.externalAmount !== '0.00') {
      if (!requestedChannelId || !requestedPaymentMethod) {
        throw new PaymentRouteError(409, 'EXTERNAL_PAYMENT_REQUIRED', '钱包余额不能覆盖订单全额，请选择外部支付方式完成尾款。')
      }
      const channel = await trx.selectFrom('payment_channels').selectAll()
        .where('id', '=', requestedChannelId).forShare().executeTakeFirst()
      if (!channel || !channel.enabled || channel.provider_type !== provider.id
        || !channel.payment_methods.includes(requestedPaymentMethod)) {
        throw new PaymentRouteError(409, 'PAYMENT_CHANNEL_UNAVAILABLE', '所选支付通道已停用或不支持此支付方式。')
      }
      if (!provider.paymentMethods.includes(requestedPaymentMethod)) {
        throw new PaymentRouteError(409, 'PAYMENT_METHOD_UNAVAILABLE', '所选支付方式尚未被此服务商协议支持。')
      }
      if (!channel.config_ciphertext || !channel.config_nonce || !channel.config_auth_tag || !channel.config_key_id) {
        throw new PaymentRouteError(503, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道凭据暂时不可用。')
      }
      const plaintext = decryptPaymentConfig(config, credentialContext(channel.id, channel.credential_version), {
        keyId: channel.config_key_id, nonce: channel.config_nonce,
        ciphertext: channel.config_ciphertext, authTag: channel.config_auth_tag,
      })
      const parsedCredentials = parsePaymentConfig(plaintext)
      if (!parsedCredentials.merchantId || !parsedCredentials.merchantKey) {
        throw new PaymentRouteError(503, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道凭据暂时不可用。')
      }
      credentials = { merchantId: parsedCredentials.merchantId, merchantKey: parsedCredentials.merchantKey }
      const expiresAt = new Date(Math.min(order.unpaid_expires_at.getTime(), now.getTime() + paymentAttemptLifetimeMs))
      if (expiresAt <= now) throw new PaymentRouteError(409, 'ORDER_NOT_PAYABLE', '订单已超过付款截止时间。')
      externalPaymentSnapshot = {
        channelId: channel.id,
        providerType: 'zpay_epay_v1',
        paymentMethod: requestedPaymentMethod,
        channelName: channel.name,
        credentialVersion: channel.credential_version,
        merchantOrderNo: merchantOrderNo(),
        expiresAt,
      }
    }

    const operationId = body.idempotencyKey
    const payment = await recordWalletOrderPayment(trx, {
      customerId: owner.customer!.id,
      orderId,
      operationId,
      requestSha256: requestHash,
      amount: requestedWalletAmount,
      ...(allocation.externalAmount === '0.00' ? {} : { externalProvider: providerName }),
      ...(externalPaymentSnapshot ? { externalPaymentSnapshot } : {}),
    })
    if (externalPaymentSnapshot && credentials) {
      const envelope = encryptPaymentConfig(
        config,
        attemptCredentialContext(payment.paymentAttemptId, externalPaymentSnapshot.credentialVersion),
        serializePaymentConfig(credentials),
      )
      await trx.insertInto('payment_attempt_secrets').values({
        payment_attempt_id: payment.paymentAttemptId, envelope_version: 1,
        config_version: externalPaymentSnapshot.credentialVersion, key_id: envelope.keyId,
        nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag,
      }).execute()
      await trx.insertInto('payment_attempt_provider_state').values({
        payment_attempt_id: payment.paymentAttemptId, state: 'requesting', action: null,
        provider_order_id: null, last_error_code: null,
      }).execute()
    }
    const itemRows = await trx.selectFrom('order_items').select(['product_name_snapshot'])
      .where('order_id', '=', orderId).orderBy('created_at').orderBy('id').limit(2).execute()
    const productName = (itemRows[0]?.product_name_snapshot ?? '商城商品').replace(/[\r\n\t]/gu, ' ').trim().slice(0, 72)
      + (itemRows.length > 1 ? '等商品' : '')
    return {
      attemptId: payment.paymentAttemptId,
      created: true,
      shouldStartProviderRequest: payment.externalAmount !== '0.00',
      shouldRecover: false,
      credentials,
      merchantOrderNo: externalPaymentSnapshot?.merchantOrderNo ?? null,
      expiresAt: externalPaymentSnapshot?.expiresAt ?? null,
      amount: payment.externalAmount === '0.00' ? null : payment.externalAmount,
      productName: payment.externalAmount === '0.00' ? null : productName,
      ...(externalPaymentSnapshot?.paymentMethod ? { paymentMethod: externalPaymentSnapshot.paymentMethod } : {}),
    }
  })
}

async function createOrReuseAttempt(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
  request: FastifyRequest, orderId: string, owner: Owner, body: CreateOrderPaymentBody,
): Promise<NewAttemptResult> {
  if (body.walletAmount !== undefined) {
    return await createOrReuseWalletOrderPayment(db, config, provider, request, orderId, owner, body)
  }
  const channelId = body.channelId
  const paymentMethod = body.paymentMethod
  if (!channelId || !paymentMethod) {
    throw new PaymentRouteError(400, 'PAYMENT_METHOD_REQUIRED', '请选择支付通道和支付方式。')
  }
  return await db.transaction().execute(async (trx) => {
    const order = await loadOwnedOrder(trx, orderId, request, owner, true)
    const nowRow = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
    const now = nowRow.rows[0]!.now
    if (order.status !== 'pending_payment' || !order.unpaid_expires_at || order.unpaid_expires_at <= now) {
      throw new PaymentRouteError(409, 'ORDER_NOT_PAYABLE', '订单已付款、已关闭或超过付款截止时间。')
    }
    if (order.currency !== 'CNY') throw new PaymentRouteError(409, 'PAYMENT_CURRENCY_UNSUPPORTED', '当前支付通道仅支持人民币订单。')
    const amount = settleAmount(order.total_amount)
    if (amount === '0.00') throw new PaymentRouteError(409, 'ORDER_PAYMENT_NOT_REQUIRED', '零元订单不需要在线付款。')
    const openCase = await trx.selectFrom('payment_provider_reconciliation_cases as reconciliation')
      .innerJoin('payment_attempts as attempt', 'attempt.id', 'reconciliation.payment_attempt_id')
      .select('reconciliation.id').where('attempt.order_id', '=', orderId)
      .where('reconciliation.state', '=', 'open').limit(1).executeTakeFirst()
    if (openCase) throw new PaymentRouteError(409, 'PAYMENT_RECONCILIATION_REQUIRED', '订单有待核对的服务商资金证据，暂不能再次付款。')
    const requestHash = sha256(JSON.stringify({ orderId, channelId, paymentMethod, amount }))
    const existingByKey = await trx.selectFrom('payment_attempts').select(['id', 'request_sha256'])
      .where('idempotency_key', '=', body.idempotencyKey).executeTakeFirst()
    if (existingByKey) {
      if (existingByKey.request_sha256 !== requestHash) {
        throw new PaymentRouteError(409, 'PAYMENT_IDEMPOTENCY_CONFLICT', '此支付请求标识已用于不同的通道、方式或金额。')
      }
      const snapshot = await loadPaymentAttemptSnapshot(trx as unknown as Kysely<Database>, existingByKey.id)
      if (!snapshot) throw new PaymentRouteError(409, 'PAYMENT_ATTEMPT_UNAVAILABLE', '此支付请求不属于在线支付通道。')
      const requestStartedAt = await trx.selectFrom('payment_attempt_provider_state').select('request_started_at')
        .where('payment_attempt_id', '=', snapshot.id).executeTakeFirstOrThrow()
      return {
        attemptId: snapshot.id, created: false, shouldStartProviderRequest: false,
        shouldRecover: snapshot.providerState === 'unknown'
          || snapshot.providerState === 'requesting' && Date.now() - requestStartedAt.request_started_at.getTime() >= 10_000,
        credentials: null, merchantOrderNo: snapshot.merchantOrderNo,
        expiresAt: snapshot.expiresAt, amount: snapshot.amount, productName: null,
      }
    }
    const active = await trx.selectFrom('payment_attempts')
      .select('id')
      .where('order_id', '=', orderId).where('status', 'in', ['created', 'pending'])
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst()
    if (active) {
      const snapshot = await loadPaymentAttemptSnapshot(trx as unknown as Kysely<Database>, active.id)
      if (!snapshot) throw new PaymentRouteError(409, 'PAYMENT_ALREADY_IN_PROGRESS', '订单已有未完成的支付尝试，请先在订单页查看其状态。')
      const requestStartedAt = await trx.selectFrom('payment_attempt_provider_state').select('request_started_at')
        .where('payment_attempt_id', '=', snapshot.id).executeTakeFirstOrThrow()
      return {
        attemptId: snapshot.id, created: false, shouldStartProviderRequest: false,
        shouldRecover: snapshot.providerState === 'unknown'
          || snapshot.providerState === 'requesting' && Date.now() - requestStartedAt.request_started_at.getTime() >= 10_000,
        credentials: null, merchantOrderNo: snapshot.merchantOrderNo,
        expiresAt: snapshot.expiresAt, amount: snapshot.amount, productName: null,
      }
    }
    const receipt = await trx.selectFrom('payment_receipts as receipt')
      .innerJoin('payment_attempts as attempt', 'attempt.id', 'receipt.payment_attempt_id')
      .select('receipt.id').where('attempt.order_id', '=', orderId).limit(1).executeTakeFirst()
    if (receipt) throw new PaymentRouteError(409, 'PAYMENT_RECONCILIATION_REQUIRED', '订单已有实际收款凭证，暂不能再次付款。')

    const channel = await trx.selectFrom('payment_channels').selectAll()
      .where('id', '=', channelId).forShare().executeTakeFirst()
    if (!channel || !channel.enabled || channel.provider_type !== provider.id
      || !channel.payment_methods.includes(paymentMethod)) {
      throw new PaymentRouteError(409, 'PAYMENT_CHANNEL_UNAVAILABLE', '所选支付通道已停用或不支持此支付方式。')
    }
    if (!provider.paymentMethods.includes(paymentMethod)) {
      throw new PaymentRouteError(409, 'PAYMENT_METHOD_UNAVAILABLE', '所选支付方式尚未被此服务商协议支持。')
    }
    if (!channel.config_ciphertext || !channel.config_nonce || !channel.config_auth_tag || !channel.config_key_id) {
      throw new PaymentRouteError(503, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道凭据暂时不可用。')
    }
    const plaintext = decryptPaymentConfig(config, credentialContext(channel.id, channel.credential_version), {
      keyId: channel.config_key_id,
      nonce: channel.config_nonce,
      ciphertext: channel.config_ciphertext,
      authTag: channel.config_auth_tag,
    })
    const credentials = parsePaymentConfig(plaintext)
    if (!credentials.merchantId || !credentials.merchantKey) {
      throw new PaymentRouteError(503, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道凭据暂时不可用。')
    }
    const expiresAt = new Date(Math.min(order.unpaid_expires_at.getTime(), now.getTime() + paymentAttemptLifetimeMs))
    if (expiresAt <= now) throw new PaymentRouteError(409, 'ORDER_NOT_PAYABLE', '订单已超过付款截止时间。')
    const merchantNo = merchantOrderNo()
    const attemptId = randomUUID()
    const providerIdentity = providerName
    const itemRows = await trx.selectFrom('order_items').select(['product_name_snapshot', 'quantity'])
      .where('order_id', '=', orderId).orderBy('created_at').orderBy('id').limit(3).execute()
    const productName = (itemRows[0]?.product_name_snapshot ?? '商城商品')
      .replace(/[\r\n\t]/gu, ' ').trim().slice(0, 72)
      + (itemRows.length > 1 ? '等商品' : '')

    await trx.insertInto('payment_attempts').values({
      id: attemptId,
      idempotency_key: body.idempotencyKey,
      request_sha256: requestHash,
      order_id: orderId,
      topup_customer_id: null,
      source: 'external',
      amount,
      status: 'created',
      provider: providerIdentity,
      provider_payment_id: null,
      wallet_operation_id: null,
      wallet_hold_operation_id: null,
      requested_wallet_amount: null,
      expires_at: expiresAt,
      payment_channel_id: channel.id,
      provider_type_snapshot: 'zpay_epay_v1',
      payment_method_snapshot: paymentMethod,
      payment_channel_name_snapshot: channel.name,
      channel_credential_version: channel.credential_version,
      merchant_order_no: merchantNo,
    }).execute()
    const attemptEnvelope = encryptPaymentConfig(
      config, attemptCredentialContext(attemptId, channel.credential_version), serializePaymentConfig(credentials),
    )
    await trx.insertInto('payment_attempt_secrets').values({
      payment_attempt_id: attemptId,
      envelope_version: 1,
      config_version: channel.credential_version,
      key_id: attemptEnvelope.keyId,
      nonce: attemptEnvelope.nonce,
      ciphertext: attemptEnvelope.ciphertext,
      auth_tag: attemptEnvelope.authTag,
    }).execute()
    await trx.insertInto('payment_attempt_provider_state').values({
      payment_attempt_id: attemptId,
      state: 'requesting',
      action: null,
      provider_order_id: null,
      last_error_code: null,
    }).execute()
    return {
      attemptId, created: true, shouldStartProviderRequest: true, shouldRecover: false,
      credentials: { merchantId: credentials.merchantId, merchantKey: credentials.merchantKey },
      merchantOrderNo: merchantNo, expiresAt, amount,
      productName: productName || `商城订单 ${orderId.slice(0, 8)}`,
    }
  })
}

async function recordProviderCreateResult(
  db: Kysely<Database>, attemptId: string, result: Awaited<ReturnType<PaymentProviderAdapter['create']>>,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const attempt = await trx.selectFrom('payment_attempts').select(['id', 'status'])
      .where('id', '=', attemptId).forUpdate().executeTakeFirst()
    if (!attempt || !['created', 'pending'].includes(attempt.status)) return
    const state = await trx.selectFrom('payment_attempt_provider_state').selectAll()
      .where('payment_attempt_id', '=', attemptId).forUpdate().executeTakeFirstOrThrow()
    if (state.action || state.provider_order_id) return
    if (result.kind === 'ready') {
      await trx.updateTable('payment_attempt_provider_state').set({
        state: 'ready', action: result.action, provider_order_id: result.providerOrderId, last_error_code: null,
      }).where('payment_attempt_id', '=', attemptId).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' })
        .where('id', '=', attemptId).where('status', '=', 'created')
        .where(sql<boolean>`expires_at > clock_timestamp()`).execute()
      return
    }
    if (result.kind === 'rejected') {
      await trx.updateTable('payment_attempt_provider_state').set({ state: 'failed', last_error_code: result.code })
        .where('payment_attempt_id', '=', attemptId).execute()
      await trx.updateTable('payment_attempts').set({ status: 'failed' })
        .where('id', '=', attemptId).where('status', 'in', ['created', 'pending']).execute()
      return
    }
    await trx.updateTable('payment_attempt_provider_state').set({
      state: 'unknown', last_error_code: result.code,
    }).where('payment_attempt_id', '=', attemptId).execute()
  })
}

async function startProviderRequest(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
  attempt: NewAttemptResult, orderId: string | null, paymentMethod: ExternalPaymentMethod, clientIp: string,
): Promise<void> {
  if (!attempt.credentials || !attempt.merchantOrderNo || !attempt.amount || !attempt.productName || !attempt.expiresAt) return
  let result: Awaited<ReturnType<PaymentProviderAdapter['create']>>
  try {
    result = await provider.create(attempt.credentials, {
      merchantOrderNo: attempt.merchantOrderNo,
      orderId,
      amount: attempt.amount,
      currency: 'CNY',
      paymentMethod,
      productName: attempt.productName,
      clientIp,
      notifyUrl: `${config.publicOrigin}/api/v1/payments/callback/zpay`,
    })
  } catch {
    result = { kind: 'unknown', code: 'provider_create_response_unknown' }
  }
  await recordProviderCreateResult(db, attempt.attemptId, result)
}

function parseCallbackParameters(request: FastifyRequest): { params: Record<string, string>; hash: string } | null {
  const rawUrl = request.raw.url ?? ''
  if (rawUrl.length > 8192) return null
  const queryIndex = rawUrl.indexOf('?')
  if (queryIndex < 0) return null
  const rawQuery = rawUrl.slice(queryIndex + 1)
  const url = new URL(rawUrl, 'http://localhost')
  const params: Record<string, string> = {}
  let count = 0
  for (const [key, value] of url.searchParams) {
    count += 1
    if (count > 64 || key.length > 128 || value.length > 4096 || Object.hasOwn(params, key)) return null
    params[key] = value
  }
  return { params, hash: sha256(rawQuery) }
}

function amountCents(value: string): bigint {
  const [whole, fraction] = value.split('.')
  return BigInt(whole!) * 100n + BigInt(fraction ?? '00')
}

async function buildWalletSummary(db: Kysely<Database>, customerId: string) {
  const [account, policy] = await Promise.all([
    db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirst(),
    db.selectFrom('storefront_customer_policy')
      .select(['wallet_top_up_enabled', 'wallet_top_up_min_amount', 'wallet_top_up_max_amount'])
      .where('singleton', '=', true).executeTakeFirstOrThrow(),
  ])
  if (!account) throw new PaymentRouteError(404, 'WALLET_NOT_FOUND', '当前顾客钱包不存在。')
  return {
    cashAvailable: settleAmount(account.cash_available),
    cashFrozen: settleAmount(account.cash_frozen),
    giftAvailable: settleAmount(account.gift_available),
    giftFrozen: settleAmount(account.gift_frozen),
    totalAvailable: addSettlementAmounts(account.cash_available, account.gift_available),
    topUpEnabled: policy.wallet_top_up_enabled,
    topUpMinAmount: settleAmount(policy.wallet_top_up_min_amount),
    topUpMaxAmount: settleAmount(policy.wallet_top_up_max_amount),
  }
}

async function buildWalletLedgerPage(
  db: Kysely<Database>, customerId: string, page: number, pageSize: number,
) {
  const count = await db.selectFrom('wallet_ledger_entries').select(sql<number>`count(*)::int`.as('total'))
    .where('customer_id', '=', customerId).executeTakeFirstOrThrow()
  const offset = (page - 1) * pageSize
  const rows = await db.selectFrom('wallet_ledger_entries as entry')
    .innerJoin('wallet_operations as operation', 'operation.id', 'entry.wallet_operation_id')
    .select([
      'entry.id as id', 'entry.wallet_operation_id as operation_id', 'operation.operation_type as operation_type',
      'entry.bucket as bucket', 'entry.action as action', 'entry.amount as amount', 'entry.created_at as created_at',
      'operation.order_id as order_id', 'entry.payment_attempt_id as payment_attempt_id',
      sql<string | null>`(SELECT attempt.status FROM payment_attempts AS attempt
        WHERE attempt.id = entry.payment_attempt_id LIMIT 1)`.as('payment_status'),
      sql<string | null>`(SELECT receipt.disposition FROM payment_receipts AS receipt
        WHERE receipt.id = entry.wallet_operation_id
          OR (receipt.payment_attempt_id = entry.payment_attempt_id AND receipt.source_bucket = entry.bucket)
        ORDER BY CASE WHEN receipt.id = entry.wallet_operation_id THEN 0 ELSE 1 END
        LIMIT 1)`.as('payment_disposition'),
      sql<string | null>`(SELECT receipt.provider_transaction_id FROM payment_receipts AS receipt
        WHERE receipt.id = entry.wallet_operation_id
          OR (receipt.payment_attempt_id = entry.payment_attempt_id AND receipt.source_bucket = entry.bucket)
        ORDER BY CASE WHEN receipt.id = entry.wallet_operation_id THEN 0 ELSE 1 END
        LIMIT 1)`.as('provider_transaction_id'),
    ])
    .where('entry.customer_id', '=', customerId)
    .orderBy('entry.created_at', 'desc').orderBy('entry.id', 'desc')
    .limit(pageSize).offset(offset).execute()
  const total = count.total
  return {
    items: rows.map(row => ({
      id: row.id,
      operationId: row.operation_id,
      operationType: row.operation_type,
      bucket: row.bucket,
      action: row.action,
      amount: settleAmount(row.amount),
      createdAt: row.created_at.toISOString(),
      orderId: row.order_id,
      paymentAttemptId: row.payment_attempt_id,
      paymentStatus: row.payment_status,
      paymentDisposition: row.payment_disposition,
      providerTransactionId: row.provider_transaction_id,
    })),
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

async function buildTopUpPage(db: Kysely<Database>, customerId: string, page: number, pageSize: number) {
  const count = await db.selectFrom('payment_attempts').select(sql<number>`count(*)::int`.as('total'))
    .where('topup_customer_id', '=', customerId).where('source', '=', 'external').executeTakeFirstOrThrow()
  const rows = await db.selectFrom('payment_attempts as attempt')
    .leftJoin('payment_attempt_provider_state as provider_state', 'provider_state.payment_attempt_id', 'attempt.id')
    .leftJoin('payment_receipts as receipt', (join) => join.onRef('receipt.payment_attempt_id', '=', 'attempt.id')
      .on('receipt.source_bucket', '=', 'external'))
    .select([
      'attempt.id as id', 'attempt.amount as amount', 'attempt.status as status',
      'attempt.payment_method_snapshot as payment_method', 'attempt.payment_channel_name_snapshot as channel_name',
      'attempt.created_at as created_at', 'attempt.expires_at as expires_at', 'attempt.completed_at as completed_at',
      'provider_state.state as provider_state', 'provider_state.action as action',
      'receipt.provider_transaction_id as provider_transaction_id', 'receipt.amount as receipt_amount',
      'receipt.disposition as receipt_disposition',
      sql<boolean>`EXISTS (SELECT 1 FROM payment_provider_reconciliation_cases AS reconciliation
        WHERE reconciliation.payment_attempt_id = attempt.id AND reconciliation.state = 'open')`.as('reconciliation_open'),
      sql<string[]>`COALESCE((SELECT array_agg(DISTINCT reconciliation.reason ORDER BY reconciliation.reason)
        FROM payment_provider_reconciliation_cases AS reconciliation
        WHERE reconciliation.payment_attempt_id = attempt.id AND reconciliation.state = 'open'), ARRAY[]::varchar[])`.as('reconciliation_reasons'),
    ])
    .where('attempt.topup_customer_id', '=', customerId).where('attempt.source', '=', 'external')
    .orderBy('attempt.created_at', 'desc').orderBy('attempt.id', 'desc')
    .limit(pageSize).offset((page - 1) * pageSize).execute()
  const total = count.total
  return {
    items: rows.map(row => ({
      id: row.id,
      amount: settleAmount(row.amount),
      status: row.status,
      providerState: row.provider_state,
      paymentMethod: row.payment_method,
      channelName: row.channel_name,
      action: ['created', 'pending'].includes(row.status) && row.provider_state === 'ready'
        ? row.action as PaymentAction | null : null,
      providerTransactionId: row.provider_transaction_id,
      receiptAmount: row.receipt_amount === null ? null : settleAmount(row.receipt_amount),
      receiptDisposition: row.receipt_disposition,
      reconciliationOpen: row.reconciliation_open,
      reconciliationReasons: row.reconciliation_reasons,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
    })),
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

async function createTopUpAttempt(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
  customer: AuthenticatedCustomer, body: CreateWalletTopUpBody,
): Promise<NewAttemptResult> {
  let amount: string
  try { amount = normalizeWalletAmount(body.amount) } catch {
    throw new PaymentRouteError(400, 'TOP_UP_AMOUNT_INVALID', '充值金额格式无效。')
  }
  const requestHash = sha256(JSON.stringify({
    type: 'wallet_top_up', customerId: customer.id, amount,
    channelId: body.channelId, paymentMethod: body.paymentMethod,
  }))
  return await db.transaction().execute(async (trx) => {
    await assertCustomerSession(trx, customer, true)
    const wallet = await trx.selectFrom('wallet_accounts').select('customer_id')
      .where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
    if (!wallet) throw new PaymentRouteError(404, 'WALLET_NOT_FOUND', '当前顾客钱包不存在。')
    const existing = await trx.selectFrom('payment_attempts').select(['id', 'request_sha256'])
      .where('idempotency_key', '=', body.idempotencyKey).executeTakeFirst()
    if (existing) {
      if (existing.request_sha256 !== requestHash) {
        throw new PaymentRouteError(409, 'TOP_UP_IDEMPOTENCY_CONFLICT', '此充值请求标识已用于不同金额或支付方式。')
      }
      const snapshot = await loadPaymentAttemptSnapshot(trx as unknown as Kysely<Database>, existing.id)
      const state = await trx.selectFrom('payment_attempt_provider_state').select(['state', 'request_started_at'])
        .where('payment_attempt_id', '=', existing.id).executeTakeFirst()
      return {
        attemptId: existing.id, created: false, shouldStartProviderRequest: false,
        shouldRecover: Boolean(snapshot && (snapshot.providerState === 'unknown'
          || snapshot.providerState === 'requesting' && state && Date.now() - state.request_started_at.getTime() >= 10_000)),
        credentials: null, merchantOrderNo: snapshot?.merchantOrderNo ?? null,
        expiresAt: snapshot?.expiresAt ?? null, amount: snapshot?.amount ?? null, productName: null,
        ...(snapshot?.paymentMethod ? { paymentMethod: snapshot.paymentMethod } : {}),
      }
    }
    const policy = await trx.selectFrom('storefront_customer_policy')
      .select(['wallet_top_up_enabled', 'wallet_top_up_min_amount', 'wallet_top_up_max_amount'])
      .where('singleton', '=', true).executeTakeFirstOrThrow()
    if (!policy.wallet_top_up_enabled) throw new PaymentRouteError(409, 'TOP_UP_DISABLED', '商家暂未开放在线充值。')
    const amountValue = amountCents(amount)
    if (amountValue < amountCents(policy.wallet_top_up_min_amount)
      || amountValue > amountCents(policy.wallet_top_up_max_amount)) {
      throw new PaymentRouteError(400, 'TOP_UP_AMOUNT_OUT_OF_RANGE', '充值金额超出商家设置的范围。')
    }
    const active = await trx.selectFrom('payment_attempts').select('id')
      .where('topup_customer_id', '=', customer.id).where('status', 'in', ['created', 'pending', 'reconciliation_required'])
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst()
    if (active) throw new PaymentRouteError(409, 'TOP_UP_IN_PROGRESS', '已有充值尚未确认，请先恢复或核对该记录。')

    const nowRow = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
    const now = nowRow.rows[0]!.now
    const expiresAt = new Date(now.getTime() + paymentAttemptLifetimeMs)
    const channel = await trx.selectFrom('payment_channels').selectAll()
      .where('id', '=', body.channelId).forShare().executeTakeFirst()
    if (!channel || !channel.enabled || channel.provider_type !== provider.id
      || !channel.payment_methods.includes(body.paymentMethod)) {
      throw new PaymentRouteError(409, 'PAYMENT_CHANNEL_UNAVAILABLE', '所选支付通道已停用或不支持此支付方式。')
    }
    if (!provider.paymentMethods.includes(body.paymentMethod)) {
      throw new PaymentRouteError(409, 'PAYMENT_METHOD_UNAVAILABLE', '所选支付方式尚未被此服务商协议支持。')
    }
    if (!channel.config_ciphertext || !channel.config_nonce || !channel.config_auth_tag || !channel.config_key_id) {
      throw new PaymentRouteError(503, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道凭据暂时不可用。')
    }
    const plaintext = decryptPaymentConfig(config, credentialContext(channel.id, channel.credential_version), {
      keyId: channel.config_key_id, nonce: channel.config_nonce,
      ciphertext: channel.config_ciphertext, authTag: channel.config_auth_tag,
    })
    const credentials = parsePaymentConfig(plaintext)
    if (!credentials.merchantId || !credentials.merchantKey) {
      throw new PaymentRouteError(503, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道凭据暂时不可用。')
    }
    const attemptId = randomUUID()
    const merchantNo = merchantOrderNo()
    await trx.insertInto('payment_attempts').values({
      id: attemptId,
      idempotency_key: body.idempotencyKey,
      request_sha256: requestHash,
      order_id: null,
      topup_customer_id: customer.id,
      source: 'external',
      amount,
      status: 'created',
      provider: providerName,
      provider_payment_id: null,
      wallet_operation_id: null,
      wallet_hold_operation_id: null,
      requested_wallet_amount: null,
      expires_at: expiresAt,
      payment_channel_id: channel.id,
      provider_type_snapshot: 'zpay_epay_v1',
      payment_method_snapshot: body.paymentMethod,
      payment_channel_name_snapshot: channel.name,
      channel_credential_version: channel.credential_version,
      merchant_order_no: merchantNo,
    }).execute()
    const envelope = encryptPaymentConfig(config, attemptCredentialContext(attemptId, channel.credential_version), serializePaymentConfig(credentials))
    await trx.insertInto('payment_attempt_secrets').values({
      payment_attempt_id: attemptId, envelope_version: 1, config_version: channel.credential_version,
      key_id: envelope.keyId, nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag,
    }).execute()
    await trx.insertInto('payment_attempt_provider_state').values({
      payment_attempt_id: attemptId, state: 'requesting', action: null, provider_order_id: null, last_error_code: null,
    }).execute()
    return {
      attemptId, created: true, shouldStartProviderRequest: true, shouldRecover: false,
      credentials: { merchantId: credentials.merchantId, merchantKey: credentials.merchantKey },
      merchantOrderNo: merchantNo, expiresAt, amount, productName: '钱包充值', paymentMethod: body.paymentMethod,
    }
  })
}

export function registerPaymentRoutes(
  app: FastifyInstance, db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
): void {
  registerPaymentChannelRoutes(app, db, config, provider)
  const optionalCustomerAuth = optionalCustomer(db, config)
  const customerCsrf = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)

  app.get('/api/v1/orders/:id/payment', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['payments'], summary: 'Read the current payment status for an owned customer or guest order',
      params: PaymentOrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerOrderPaymentSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const view = await buildCustomerPaymentView(db, request, params.id, ownerFor(request))
      reply.header('cache-control', 'no-store')
      return success(view, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.post('/api/v1/orders/:id/payments', {
    logLevel: 'silent',
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['payments'], summary: 'Create or recover an online payment attempt for an owned order',
      params: PaymentOrderIdParamsSchema,
      body: CreateOrderPaymentBodySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerOrderPaymentSchema), 201: ApiSuccessSchemaOf(CustomerOrderPaymentSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const body = request.body as CreateOrderPaymentBody
      const result = await createOrReuseAttempt(db, config, provider, request, params.id, ownerFor(request), body)
      if (result.shouldStartProviderRequest) {
        const paymentMethod = result.paymentMethod ?? body.paymentMethod
        if (!paymentMethod) throw new PaymentRouteError(409, 'PAYMENT_METHOD_REQUIRED', '支付方式缺失，请刷新后重试。')
        await startProviderRequest(db, config, provider, result, params.id, paymentMethod, request.ip)
      } else if (result.shouldRecover) {
        await refreshPaymentAttempt(db, config, provider, result.attemptId)
      }
      const view = await buildCustomerPaymentView(db, request, params.id, ownerFor(request))
      reply.header('cache-control', 'no-store')
      return reply.code(result.created ? 201 : 200).send(success(view, request.id))
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.post('/api/v1/orders/:id/payment/refresh', {
    logLevel: 'silent',
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    schema: {
      tags: ['payments'], summary: 'Confirm the provider status for the active payment attempt with a rate-limited server query',
      params: PaymentOrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerOrderPaymentSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const owner = ownerFor(request)
      await db.transaction().execute(async (trx) => { await loadOwnedOrder(trx, params.id, request, owner) })
      const attempt = await db.selectFrom('payment_attempts').select('id')
        .where('order_id', '=', params.id).where('status', 'in', ['created', 'pending', 'reconciliation_required'])
        .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst()
      if (attempt) await refreshPaymentAttempt(db, config, provider, attempt.id)
      const view = await buildCustomerPaymentView(db, request, params.id, owner)
      reply.header('cache-control', 'no-store')
      return success(view, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.get('/api/v1/customer/wallet', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'Read the signed-in customer wallet balances and top-up policy',
      response: { 200: ApiSuccessSchemaOf(CustomerWalletSummarySchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (!request.customer) throw new PaymentRouteError(401, 'UNAUTHORIZED', '请登录后查看钱包。')
      const summary = await buildWalletSummary(db, request.customer.id)
      reply.header('cache-control', 'no-store')
      return success(summary, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.get('/api/v1/customer/wallet/ledger', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'Read the signed-in customer wallet ledger page',
      querystring: CustomerWalletPageQuerySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerWalletLedgerPageSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (!request.customer) throw new PaymentRouteError(401, 'UNAUTHORIZED', '请登录后查看钱包明细。')
      const query = request.query as CustomerWalletPageQuery
      const page = query.page ?? 1
      const pageSize = query.pageSize ?? 20
      const result = await buildWalletLedgerPage(db, request.customer.id, page, pageSize)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.get('/api/v1/customer/wallet/top-ups', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'Read the signed-in customer top-up records',
      querystring: CustomerWalletPageQuerySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerTopUpPageSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (!request.customer) throw new PaymentRouteError(401, 'UNAUTHORIZED', '请登录后查看充值记录。')
      const query = request.query as CustomerWalletPageQuery
      const result = await buildTopUpPage(db, request.customer.id, query.page ?? 1, query.pageSize ?? 20)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/wallet/top-ups', {
    logLevel: 'silent',
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: {
      tags: ['payments'], summary: 'Create or recover an online top-up payment for the signed-in customer',
      body: CreateWalletTopUpBodySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerTopUpPageSchema), 201: ApiSuccessSchemaOf(CustomerTopUpPageSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (!request.customer) throw new PaymentRouteError(401, 'UNAUTHORIZED', '请登录后充值。')
      const body = request.body as CreateWalletTopUpBody
      const result = await createTopUpAttempt(db, config, provider, request.customer, body)
      if (result.shouldStartProviderRequest) {
        await startProviderRequest(db, config, provider, result, null, body.paymentMethod, request.ip)
      } else if (result.shouldRecover) {
        await refreshPaymentAttempt(db, config, provider, result.attemptId)
      }
      const page = await buildTopUpPage(db, request.customer.id, 1, 20)
      reply.header('cache-control', 'no-store')
      return reply.code(result.created ? 201 : 200).send(success(page, request.id))
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/wallet/top-ups/:id/refresh', {
    logLevel: 'silent',
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    schema: {
      tags: ['payments'], summary: 'Recover an owned top-up using the existing provider attempt',
      params: PaymentOrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerTopUpPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (!request.customer) throw new PaymentRouteError(401, 'UNAUTHORIZED', '请登录后恢复充值。')
      const params = request.params as { id: string }
      const attemptRow = await db.selectFrom('payment_attempts').select('id')
        .where('id', '=', params.id).where('topup_customer_id', '=', request.customer.id)
        .where('source', '=', 'external').executeTakeFirst()
      if (!attemptRow) throw new PaymentRouteError(404, 'TOP_UP_NOT_FOUND', '找不到属于当前顾客的充值记录。')
      await db.transaction().execute(async (trx) => {
        await assertCustomerSession(trx, request.customer!, true)
      })
      await refreshPaymentAttempt(db, config, provider, attemptRow.id)
      const page = await buildTopUpPage(db, request.customer.id, 1, 20)
      reply.header('cache-control', 'no-store')
      return success(page, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.get('/api/v1/admin/wallets', {
    preHandler: requireAdmin(db, config),
    schema: {
      tags: ['admin-payments'], summary: 'Read customer wallet balances without mutating funds',
      querystring: AdminWalletListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(AdminWalletListSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const query = request.query as AdminWalletListQuery
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20
    const search = query.search?.trim()
    let countQuery = db.selectFrom('wallet_accounts as wallet').innerJoin('customers as customer', 'customer.id', 'wallet.customer_id')
      .select(sql<number>`count(*)::int`.as('total'))
    let rowsQuery = db.selectFrom('wallet_accounts as wallet').innerJoin('customers as customer', 'customer.id', 'wallet.customer_id')
      .select([
        'wallet.customer_id as customer_id', 'customer.username as username', 'customer.status as status',
        'wallet.cash_available as cash_available', 'wallet.cash_frozen as cash_frozen',
        'wallet.gift_available as gift_available', 'wallet.gift_frozen as gift_frozen',
      ])
    if (search) {
      countQuery = countQuery.where('customer.username', 'ilike', `%${search}%`)
      rowsQuery = rowsQuery.where('customer.username', 'ilike', `%${search}%`)
    }
    const [count, rows] = await Promise.all([
      countQuery.executeTakeFirstOrThrow(),
      rowsQuery.orderBy('customer.created_at', 'desc').orderBy('customer.id', 'desc')
        .limit(pageSize).offset((page - 1) * pageSize).execute(),
    ])
    const total = count.total
    reply.header('cache-control', 'no-store')
    return success({
      items: rows.map(row => ({
        customerId: row.customer_id, username: row.username, status: row.status,
        cashAvailable: settleAmount(row.cash_available), cashFrozen: settleAmount(row.cash_frozen),
        giftAvailable: settleAmount(row.gift_available), giftFrozen: settleAmount(row.gift_frozen),
        totalAvailable: addSettlementAmounts(row.cash_available, row.gift_available),
      })),
      total, page, pageSize, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    }, request.id)
  })

  app.get('/api/v1/admin/wallets/:customerId', {
    preHandler: requireAdmin(db, config),
    schema: {
      tags: ['admin-payments'], summary: 'Read one customer wallet, ledger, and top-up evidence',
      params: AdminWalletCustomerParamsSchema,
      querystring: CustomerWalletPageQuerySchema,
      response: { 200: ApiSuccessSchemaOf(AdminWalletDetailSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { customerId: string }
      const query = request.query as CustomerWalletPageQuery
      const customer = await db.selectFrom('customers').select(['id', 'username', 'status'])
        .where('id', '=', params.customerId).executeTakeFirst()
      if (!customer) throw new PaymentRouteError(404, 'CUSTOMER_NOT_FOUND', '找不到顾客账户。')
      const [wallet, ledger, topUps] = await Promise.all([
        buildWalletSummary(db, customer.id),
        buildWalletLedgerPage(db, customer.id, query.page ?? 1, query.pageSize ?? 20),
        buildTopUpPage(db, customer.id, query.page ?? 1, query.pageSize ?? 20),
      ])
      reply.header('cache-control', 'no-store')
      return success({ customerId: customer.id, username: customer.username, status: customer.status, wallet, ledger, topUps }, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/wallets/:customerId/top-ups/:attemptId/reconcile', {
    logLevel: 'silent',
    preHandler: [requireAdmin(db, config), verifyCsrf(config)],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'payments'],
      summary: 'Reconcile one top-up only through a fresh authenticated provider query',
      params: AdminTopUpReconciliationParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(AdminPaymentReconciliationResultSchema),
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema,
        409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { customerId: string; attemptId: string }
      const attempt = await db.selectFrom('payment_attempts').select('id')
        .where('id', '=', params.attemptId).where('topup_customer_id', '=', params.customerId)
        .where('source', '=', 'external').executeTakeFirst()
      if (!attempt) throw new PaymentRouteError(404, 'TOP_UP_NOT_FOUND', '此顾客没有该充值支付尝试。')
      const result = await resolvePaymentReconciliation(db, config, provider, attempt.id, request.admin!.id)
      const resolved = 'resolutionMade' in result && result.resolutionMade === true
      const state = result.kind === 'throttled' ? 'throttled' : resolved ? 'resolved' : 'still_open'
      reply.header('cache-control', 'no-store')
      return success({
        state,
        providerStatus: result.kind === 'throttled' ? null : result.providerStatus,
        message: state === 'resolved'
          ? '服务商最新认证结果与充值凭证一致，充值已按原记录核对。'
          : state === 'throttled' ? '查单频率受限，请稍后重试。'
            : '最新服务商结果尚不足以解除异常；充值仍未入账，原始证据已保留。',
      }, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })

  app.get('/api/v1/payments/callback/zpay', {
    logLevel: 'silent',
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    schema: {
      tags: ['payments'], summary: 'Receive a signed ZPAY asynchronous payment notification',
      response: { 200: { type: 'string' }, 400: { type: 'string' }, 503: { type: 'string' }, 429: { type: 'string' } },
    },
  }, async (request, reply) => {
    const parsed = parseCallbackParameters(request)
    if (!parsed) return reply.code(400).type('text/plain').send('fail')
    const merchantNo = parsed.params.out_trade_no
    if (!merchantNo || !/^\d{20,32}$/u.test(merchantNo)) return reply.code(400).type('text/plain').send('fail')
    const attemptRow = await db.selectFrom('payment_attempts').select('id')
      .where('merchant_order_no', '=', merchantNo).where('provider_type_snapshot', '=', provider.id)
      .executeTakeFirst()
    if (!attemptRow) return reply.code(400).type('text/plain').send('fail')
    try {
      const attempt = await loadPaymentAttemptSnapshot(db, attemptRow.id)
      if (!attempt) return reply.code(400).type('text/plain').send('fail')
      const result = await handleProviderCallback(db, config, provider, attempt, parsed.params, parsed.hash)
      reply.header('cache-control', 'no-store')
      if (result === 'accepted') return reply.type('text/plain').send('success')
      if (result === 'unverified') return reply.code(400).type('text/plain').send('fail')
      return reply.code(503).type('text/plain').send('fail')
    } catch {
      request.log.warn({ callbackProcessingFailed: true }, 'payment callback could not be confirmed')
      return reply.code(503).type('text/plain').send('fail')
    }
  })

  app.post('/api/v1/admin/orders/:id/payments/:attemptId/reconcile', {
    logLevel: 'silent',
    preHandler: [requireAdmin(db, config), verifyCsrf(config)],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'payments'],
      summary: 'Resolve a payment reconciliation case only after a fresh authenticated provider query',
      params: AdminPaymentReconciliationParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(AdminPaymentReconciliationResultSchema),
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema,
        409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; attemptId: string }
      const attempt = await db.selectFrom('payment_attempts').select('id')
        .where('id', '=', params.attemptId).where('order_id', '=', params.id)
        .where('source', '=', 'external').executeTakeFirst()
      if (!attempt) throw new PaymentRouteError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', '此订单没有该在线支付尝试。')
      const result = await resolvePaymentReconciliation(db, config, provider, attempt.id, request.admin!.id)
      const resolved = 'resolutionMade' in result && result.resolutionMade === true
      const state = result.kind === 'throttled' ? 'throttled' : resolved ? 'resolved' : 'still_open'
      reply.header('cache-control', 'no-store')
      return success({
        state,
        providerStatus: result.kind === 'throttled' ? null : result.providerStatus,
        message: state === 'resolved'
          ? '服务商最新认证结果与可用资金凭证一致，核对已记录。'
          : state === 'throttled' ? '查单频率受限，请稍后重试。'
            : '最新服务商结果尚不足以解除异常；资金凭证仍受保护，订单不会自动履约。',
      }, request.id)
    } catch (error) { return handlePaymentError(error, reply, request.id) }
  })
}
