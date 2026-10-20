import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreateOrderPaymentBodySchema,
  CustomerOrderPaymentSchema,
  PaymentOrderIdParamsSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type { CreateOrderPaymentBody, ExternalPaymentMethod, PaymentAction } from '@aikayun/contracts'
import { settleAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import { CUSTOMER_CSRF_COOKIE, optionalCustomer, type AuthenticatedCustomer } from '../auth/customer.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import { assertCustomerSession, assertGuestSession, guestSessionCookie } from '../commerce/orders.js'
import type { Database, PaymentAttemptStatus, PaymentProviderRequestState } from '../db/types.js'
import { decryptPaymentConfig, encryptPaymentConfig, parsePaymentConfig, serializePaymentConfig } from './credentials.js'
import { registerPaymentChannelRoutes } from './channels.js'
import type { PaymentProviderAdapter } from './provider.js'
import { PaymentServiceError, handleProviderCallback, loadPaymentAttemptSnapshot, refreshPaymentAttempt } from './settlement.js'

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
  const attempts = await db.selectFrom('payment_attempts')
    .select('id')
    .where('order_id', '=', orderId)
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(1).execute()
  const attemptSnapshot = attempts[0]
    ? await loadPaymentAttemptSnapshot(db, attempts[0].id)
    : undefined
  const attemptRow = attempts[0]
    ? await db.selectFrom('payment_attempts').select(['id', 'status', 'payment_method_snapshot', 'payment_channel_name_snapshot', 'expires_at', 'completed_at'])
      .where('id', '=', attempts[0].id).executeTakeFirst()
    : undefined
  let paymentStatus: 'unpaid' | 'pending' | 'paid' | 'late_paid' | 'reconciliation_required' | 'not_payable'
  if (receipts.has_mismatch || providerEvidence.needs_reconciliation) paymentStatus = 'reconciliation_required'
  else if (receipts.has_late) paymentStatus = 'late_paid'
  else if (receipts.receipt_count > 0 && ['processing', 'completed'].includes(order.status)) paymentStatus = 'paid'
  else if (order.status !== 'pending_payment' || !order.unpaid_expires_at || order.unpaid_expires_at <= now) paymentStatus = 'not_payable'
  else if (attemptRow && ['created', 'pending'].includes(attemptRow.status)) paymentStatus = 'pending'
  else paymentStatus = 'unpaid'

  const payable = order.status === 'pending_payment'
    && order.unpaid_expires_at !== null && order.unpaid_expires_at > now
    && receipts.receipt_count === 0
  const rows = payable
    ? await db.selectFrom('payment_channels').select(['id', 'name', 'payment_methods'])
      .where('enabled', '=', true).where('provider_type', '=', 'zpay_epay_v1')
      .where('config_ciphertext', 'is not', null)
      .orderBy('display_order').orderBy('created_at').orderBy('id').execute()
    : []
  const activeAttempt = attemptRow && (attemptRow.status === 'created' || attemptRow.status === 'pending')
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
    channels: rows.filter(row => row.payment_methods.length > 0).map(row => ({
      id: row.id, name: row.name, paymentMethods: row.payment_methods as ExternalPaymentMethod[],
    })),
    attempt: attemptRow && attemptSnapshot ? {
      id: attemptRow.id,
      status: attemptRow.status,
      providerState: attemptSnapshot.providerState,
      paymentMethod: attemptSnapshot.paymentMethod,
      channelName: attemptSnapshot.channelName,
      action: payable && activeAttempt?.providerState === 'ready' ? activeAttempt.action : null,
      expiresAt: attemptRow.expires_at?.toISOString() ?? null,
      completedAt: attemptRow.completed_at?.toISOString() ?? null,
      errorCode: attemptSnapshot.lastErrorCode,
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
}

async function createOrReuseAttempt(
  db: Kysely<Database>, config: AppConfig, provider: PaymentProviderAdapter,
  request: FastifyRequest, orderId: string, owner: Owner, body: CreateOrderPaymentBody,
): Promise<NewAttemptResult> {
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
    const requestHash = sha256(JSON.stringify({ orderId, channelId: body.channelId, paymentMethod: body.paymentMethod, amount }))
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
      payment_method_snapshot: body.paymentMethod,
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
  attempt: NewAttemptResult, orderId: string, paymentMethod: ExternalPaymentMethod, clientIp: string,
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
        await startProviderRequest(db, config, provider, result, params.id, body.paymentMethod, request.ip)
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
        .where('order_id', '=', params.id).where('status', 'in', ['created', 'pending'])
        .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst()
      if (attempt) await refreshPaymentAttempt(db, config, provider, attempt.id)
      const view = await buildCustomerPaymentView(db, request, params.id, owner)
      reply.header('cache-control', 'no-store')
      return success(view, request.id)
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
}
