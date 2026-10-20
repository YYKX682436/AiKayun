import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  AdminOrderRefundMutationSchema,
  AdminOrderRefundsSchema,
  AdminRefundActionBodySchema,
  AdminRefundManualAttemptBodySchema,
  AdminRefundManualResolutionBodySchema,
  AdminRefundRejectionBodySchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreateOrderRefundBodySchema,
  CustomerOrderRefundMutationSchema,
  CustomerOrderRefundsSchema,
  OrderIdParamsSchema,
  OrderRefundAllocationParamsSchema,
  OrderRefundIdParamsSchema,
  OrderRefundManualAttemptParamsSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  AdminOrderRefunds,
  AdminRefundActionBody,
  AdminRefundManualResolutionBody,
  AdminRefundRejectionBody,
  CreateOrderRefundBody,
  CustomerOrderRefunds,
  RefundPayoutMode,
  RefundProgressStatus,
} from '@aikayun/contracts'
import { normalizeWalletAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import { optionalCustomer, requireCustomer, CUSTOMER_CSRF_COOKIE, type AuthenticatedCustomer } from '../auth/customer.js'
import { requireAdmin, verifyCsrf as verifyAdminCsrf } from '../auth/admin.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import type { Database, RefundStatus as DbRefundStatus } from '../db/types.js'
import { assertCustomerSession, assertGuestSession, guestSessionCookie } from './orders.js'

type Db = Kysely<Database> | Transaction<Database>

type RefundActor =
  | { type: 'customer'; customerId: string }
  | { type: 'guest' }
  | { type: 'admin'; adminId: string }

type RefundOwner =
  | { type: 'customer'; customer: AuthenticatedCustomer }
  | { type: 'guest'; token: string | undefined }

type RefundOrder = {
  id: string
  customer_id: string | null
  guest_order_session_id: string | null
  status: string
}

type RefundSource = {
  id: string
  payment_attempt_id: string
  source_bucket: 'external' | 'cash' | 'gift'
  provider: string | null
  provider_transaction_id: string | null
  amount: string
  disposition: 'on_time' | 'late' | 'excess' | 'amount_mismatch'
  refund_reserved_amount: string
  refunded_amount: string
  received_at: Date
  attempt_status: string
}

type RefundBlocker = {
  open_case: boolean
  unresolved_payment: boolean
  reconciliation_required: boolean
}

type RefundRecord = {
  id: string
  amount: string
  succeeded_amount: string
  reserved_amount: string
  status: DbRefundStatus
  reason: string
  rejection_reason: string | null
  reviewed_by_admin_id: string | null
  reviewed_at: Date | null
  created_at: Date
  updated_at: Date
}

class RefundError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'RefundError'
  }
}

function cents(value: string): bigint {
  const normalized = normalizeWalletAmount(value)
  const [whole, fraction] = normalized.split('.')
  return BigInt(whole!) * 100n + BigInt(fraction!)
}

function amountFromCents(value: bigint): string {
  const positive = value < 0n ? 0n : value
  return `${positive / 100n}.${(positive % 100n).toString().padStart(2, '0')}`
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function postgresInfo(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      }
    }
    current = candidate.cause
  }
  return {}
}

function handleRefundError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof RefundError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown; code?: unknown; message?: unknown }
    if (typeof candidate.status === 'number' && typeof candidate.code === 'string') {
      return reply.code(candidate.status).send(failure(candidate.code, String(candidate.message ?? '订单退款请求失败。'), requestId))
    }
  }
  const { code, constraint } = postgresInfo(error)
  if (constraint === 'order_refunds_exceed_actual_available' || constraint === 'order_refund_exceeds_source_payment') {
    return reply.code(409).send(failure('REFUND_AMOUNT_UNAVAILABLE', '退款金额已被其他退款或新的资金事实占用，请刷新可退款金额后重试。', requestId))
  }
  if (constraint === 'order_refund_payment_unresolved' || constraint === 'order_refund_manual_attempt_payment_unresolved') {
    return reply.code(409).send(failure('REFUND_PAYMENT_UNRESOLVED', '订单有未决支付或对账证据，当前不能继续退款。', requestId))
  }
  if (constraint?.startsWith('order_refund_') || constraint?.startsWith('order_refunds_')) {
    return reply.code(409).send(failure('REFUND_CONFLICT', '退款记录或资金来源已变化，请刷新订单退款进度后重试。', requestId))
  }
  if (code === '23505') {
    return reply.code(409).send(failure('REFUND_IDEMPOTENCY_CONFLICT', '该幂等标识已用于另一项退款操作。', requestId))
  }
  if (code === '40001' || code === '40P01') {
    return reply.code(409).send(failure('REFUND_CONCURRENT_CONFLICT', '订单资金正在并发变化，请刷新退款进度后重试。', requestId))
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return reply.code(422).send(failure('REFUND_INPUT_INVALID', '退款金额或退款凭证超出有效范围。', requestId))
  }
  throw error
}

async function setRefundActor(trx: Transaction<Database>, actor: RefundActor): Promise<void> {
  await sql`
    SELECT set_config('aikayun.refund_actor_type', ${actor.type}, true),
      set_config('aikayun.refund_actor_customer_id', ${actor.type === 'customer' ? actor.customerId : ''}, true),
      set_config('aikayun.refund_actor_admin_id', ${actor.type === 'admin' ? actor.adminId : ''}, true)
  `.execute(trx)
}

function actorFor(owner: RefundOwner): RefundActor {
  return owner.type === 'customer'
    ? { type: 'customer', customerId: owner.customer.id }
    : { type: 'guest' }
}

async function lockCustomerOrder(
  trx: Transaction<Database>, orderId: string, owner: RefundOwner,
): Promise<RefundOrder> {
  let order: RefundOrder | undefined
  if (owner.type === 'customer') {
    await assertCustomerSession(trx, owner.customer, true)
    order = await trx.selectFrom('orders').select(['id', 'customer_id', 'guest_order_session_id', 'status'])
      .where('id', '=', orderId).where('customer_id', '=', owner.customer.id).forUpdate().executeTakeFirst()
    if (order) await trx.selectFrom('wallet_accounts').select('customer_id')
      .where('customer_id', '=', owner.customer.id).forUpdate().executeTakeFirst()
  } else {
    const guestSessionId = await assertGuestSession(trx, owner.token)
    order = await trx.selectFrom('orders').select(['id', 'customer_id', 'guest_order_session_id', 'status'])
      .where('id', '=', orderId).where('guest_order_session_id', '=', guestSessionId)
      .where('customer_id', 'is', null).forUpdate().executeTakeFirst()
  }
  if (!order) throw new RefundError(404, 'ORDER_NOT_FOUND', '找不到属于当前顾客或游客会话的订单。')
  await lockOrderPaymentAttempts(trx, orderId)
  return order
}

async function lockOrderPaymentAttempts(trx: Transaction<Database>, orderId: string): Promise<void> {
  await trx.selectFrom('payment_attempts').select('id').where('order_id', '=', orderId)
    .orderBy('id').forUpdate().execute()
}

async function adminLockRefundContext(
  trx: Transaction<Database>, orderId: string, refundId?: string,
): Promise<{ order: RefundOrder; refund?: RefundRecord }> {
  const ownerHint = await trx.selectFrom('orders').select('customer_id').where('id', '=', orderId).executeTakeFirst()
  if (!ownerHint) throw new RefundError(404, 'ORDER_NOT_FOUND', '订单不存在。')
  if (ownerHint.customer_id) {
    await trx.selectFrom('customers').select('id').where('id', '=', ownerHint.customer_id).forUpdate().executeTakeFirst()
  }
  const order = await trx.selectFrom('orders').select(['id', 'customer_id', 'guest_order_session_id', 'status'])
    .where('id', '=', orderId).forUpdate().executeTakeFirst()
  if (!order) throw new RefundError(404, 'ORDER_NOT_FOUND', '订单不存在。')
  if (order.customer_id) {
    await trx.selectFrom('wallet_accounts').select('customer_id').where('customer_id', '=', order.customer_id)
      .forUpdate().executeTakeFirst()
  }
  await lockOrderPaymentAttempts(trx, orderId)
  if (!refundId) return { order }
  const refund = await trx.selectFrom('order_refunds').select([
    'id', 'amount', 'status', 'reason', 'rejection_reason', 'reviewed_by_admin_id', 'reviewed_at',
    'created_at', 'updated_at',
    sql<string>`COALESCE((SELECT sum(amount) FROM order_refund_allocations WHERE refund_id = order_refunds.id AND status = 'succeeded'), 0)::text`.as('succeeded_amount'),
    sql<string>`COALESCE((SELECT sum(amount) FROM order_refund_allocations WHERE refund_id = order_refunds.id AND status = 'reserved'), 0)::text`.as('reserved_amount'),
  ]).where('id', '=', refundId).where('order_id', '=', orderId).forUpdate().executeTakeFirst()
  if (!refund) throw new RefundError(404, 'REFUND_NOT_FOUND', '退款申请不存在。')
  return { order, refund: refund as RefundRecord }
}

async function lockRefundSourceReceipts(trx: Transaction<Database>, orderId: string): Promise<RefundSource[]> {
  const result = await sql<RefundSource>`
    SELECT receipt.id, receipt.payment_attempt_id, receipt.source_bucket, receipt.provider,
      receipt.provider_transaction_id, receipt.amount::text AS amount,
      receipt.disposition, receipt.refund_reserved_amount::text AS refund_reserved_amount,
      receipt.refunded_amount::text AS refunded_amount, receipt.received_at,
      attempt.status AS attempt_status
    FROM payment_receipts AS receipt
    JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
    WHERE attempt.order_id = ${orderId}::uuid
    ORDER BY receipt.received_at,
      CASE receipt.source_bucket WHEN 'gift' THEN 0 WHEN 'cash' THEN 1 ELSE 2 END,
      COALESCE(receipt.wallet_line_no, 0), receipt.id
    FOR UPDATE OF receipt
  `.execute(trx)
  return result.rows
}

async function refundBlocker(db: Db, orderId: string): Promise<RefundBlocker> {
  const result = await sql<RefundBlocker>`
    SELECT
      EXISTS (
        SELECT 1 FROM payment_provider_reconciliation_cases AS reconciliation
        JOIN payment_attempts AS attempt ON attempt.id = reconciliation.payment_attempt_id
        WHERE attempt.order_id = ${orderId}::uuid AND reconciliation.state = 'open'
      ) AS open_case,
      order_has_unresolved_payment_attempts(${orderId}::uuid) AS unresolved_payment,
      EXISTS (SELECT 1 FROM payment_attempts AS attempt
        WHERE attempt.order_id = ${orderId}::uuid AND attempt.status = 'reconciliation_required')
        AS reconciliation_required
  `.execute(db)
  return result.rows[0] ?? { open_case: true, unresolved_payment: true, reconciliation_required: true }
}

function blockerReason(blocker: RefundBlocker): CustomerOrderRefunds['blockedReason'] {
  if (blocker.open_case || blocker.reconciliation_required) return 'payment_reconciliation_required'
  if (blocker.unresolved_payment) return 'payment_unresolved'
  return null
}

function isUsableReceipt(receipt: RefundSource): boolean {
  return ['succeeded', 'late_succeeded'].includes(receipt.attempt_status)
    && ['on_time', 'late'].includes(receipt.disposition)
}

function allocateRefundSources(
  receipts: RefundSource[], amount: string, customerOwned: boolean,
): Array<{ receipt: RefundSource; amount: string; destination: 'cash_balance' | 'gift_balance' | 'original_source' }> {
  let remaining = cents(amount)
  const result: Array<{ receipt: RefundSource; amount: string; destination: 'cash_balance' | 'gift_balance' | 'original_source' }> = []
  for (const receipt of receipts) {
    if (!isUsableReceipt(receipt) || remaining === 0n) continue
    if (!customerOwned && receipt.source_bucket !== 'external') continue
    const available = cents(receipt.amount) - cents(receipt.refunded_amount) - cents(receipt.refund_reserved_amount)
    if (available <= 0n) continue
    const take = available < remaining ? available : remaining
    const destination = customerOwned
      ? receipt.source_bucket === 'gift' ? 'gift_balance' : 'cash_balance'
      : 'original_source'
    result.push({ receipt, amount: amountFromCents(take), destination })
    remaining -= take
  }
  if (remaining > 0n) {
    throw new RefundError(409, 'REFUND_AMOUNT_UNAVAILABLE', '可用收款回执不足以支持此退款金额，请刷新退款进度。')
  }
  return result
}

async function assertRefundNotBlocked(db: Db, orderId: string): Promise<void> {
  const blocker = await refundBlocker(db, orderId)
  if (blocker.open_case || blocker.reconciliation_required) {
    throw new RefundError(409, 'REFUND_PAYMENT_UNRESOLVED', '订单有待处理的服务商对账异常，暂不能退款。')
  }
  if (blocker.unresolved_payment) {
    throw new RefundError(409, 'REFUND_PAYMENT_UNRESOLVED', '订单存在未决支付或资金预留，暂不能退款。')
  }
}

async function actionReplay(
  trx: Transaction<Database>, refundId: string, idempotencyKey: string, action: string, hash: string,
): Promise<boolean> {
  const existing = await trx.selectFrom('order_refund_audit_events')
    .select(['action', 'request_sha256'])
    .where('refund_id', '=', refundId).where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst()
  if (!existing) return false
  if (existing.action !== action || existing.request_sha256 !== hash) {
    throw new RefundError(409, 'REFUND_IDEMPOTENCY_CONFLICT', '该幂等标识已用于另一项退款操作。')
  }
  return true
}

async function appendAction(
  trx: Transaction<Database>,
  input: { refundId: string; idempotencyKey: string; hash: string; action: string; actor: RefundActor; details: Record<string, unknown> },
): Promise<void> {
  await trx.insertInto('order_refund_audit_events').values({
    id: randomUUID(),
    refund_id: input.refundId,
    action: input.action,
    actor_type: input.actor.type,
    actor_customer_id: input.actor.type === 'customer' ? input.actor.customerId : null,
    actor_admin_id: input.actor.type === 'admin' ? input.actor.adminId : null,
    idempotency_key: input.idempotencyKey,
    request_sha256: input.hash,
    previous_status: null,
    next_status: null,
    details: input.details,
  }).execute()
}

async function setRefundStatus(
  trx: Transaction<Database>, refundId: string, status: DbRefundStatus,
): Promise<void> {
  await trx.updateTable('order_refunds').set({ status })
    .where('id', '=', refundId).where('status', '!=', status).execute()
}

async function loadRefundSummary(db: Db, orderId: string, includeAudit: boolean): Promise<CustomerOrderRefunds | AdminOrderRefunds> {
  const order = await db.selectFrom('orders').select(['id', 'customer_id']).where('id', '=', orderId).executeTakeFirst()
  if (!order) throw new RefundError(404, 'ORDER_NOT_FOUND', '订单不存在。')

  const totals = await sql<{
    receipt_amount: string
    refunded_amount: string
    reserved_amount: string
    remaining_amount: string
    eligible_receipt_amount: string
    eligible_remaining_amount: string
    has_external: boolean
  }>`
    SELECT COALESCE(sum(receipt.amount), 0)::text AS receipt_amount,
      COALESCE(sum(receipt.refunded_amount), 0)::text AS refunded_amount,
      COALESCE(sum(receipt.refund_reserved_amount), 0)::text AS reserved_amount,
      COALESCE(sum(receipt.amount - receipt.refunded_amount - receipt.refund_reserved_amount), 0)::text AS remaining_amount,
      COALESCE(sum(receipt.amount) FILTER (WHERE attempt.status IN ('succeeded', 'late_succeeded')
        AND receipt.disposition IN ('on_time', 'late')), 0)::text AS eligible_receipt_amount,
      COALESCE(sum(receipt.amount - receipt.refunded_amount - receipt.refund_reserved_amount)
        FILTER (WHERE attempt.status IN ('succeeded', 'late_succeeded')
          AND receipt.disposition IN ('on_time', 'late')), 0)::text AS eligible_remaining_amount,
      COALESCE(bool_or(receipt.source_bucket = 'external'), false) AS has_external
    FROM payment_receipts AS receipt
    JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
    WHERE attempt.order_id = ${orderId}::uuid
  `.execute(db).then(result => result.rows[0]!)
  const rawRefunds = await db.selectFrom('order_refunds as refund')
    .select([
      'refund.id', 'refund.amount', 'refund.status', 'refund.reason', 'refund.rejection_reason',
      'refund.reviewed_by_admin_id', 'refund.reviewed_at', 'refund.created_at', 'refund.updated_at',
      sql<string>`COALESCE((SELECT sum(amount) FROM order_refund_allocations AS allocation
        WHERE allocation.refund_id = refund.id AND allocation.status = 'succeeded'), 0)::text`.as('succeeded_amount'),
      sql<string>`COALESCE((SELECT sum(amount) FROM order_refund_allocations AS allocation
        WHERE allocation.refund_id = refund.id AND allocation.status = 'reserved'), 0)::text`.as('reserved_amount'),
    ])
    .where('refund.order_id', '=', orderId)
    .orderBy('refund.created_at', 'desc').orderBy('refund.id', 'desc')
    .execute()
  const refundIds = rawRefunds.map(refund => refund.id)
  const allocationRows = refundIds.length
    ? await db.selectFrom('order_refund_allocations as allocation')
      .innerJoin('payment_receipts as receipt', 'receipt.id', 'allocation.source_payment_receipt_id')
      .innerJoin('payment_attempts as attempt', 'attempt.id', 'receipt.payment_attempt_id')
      .select([
        'allocation.id', 'allocation.refund_id', 'allocation.operation_id', 'allocation.source_payment_receipt_id',
        'allocation.destination', 'allocation.amount', 'allocation.status', 'allocation.provider',
        'allocation.provider_refund_id', 'allocation.created_at', 'allocation.completed_at',
        'receipt.source_bucket', 'receipt.amount as source_receipt_amount', 'receipt.disposition as source_disposition',
        'receipt.provider as source_provider', 'receipt.provider_transaction_id as source_provider_transaction_id',
      ])
      .where('allocation.refund_id', 'in', refundIds)
      .orderBy('allocation.created_at').orderBy('allocation.id')
      .execute()
    : []
  const allocationIds = allocationRows.map(allocation => allocation.id)
  const manualRows = allocationIds.length
    ? await db.selectFrom('order_refund_manual_attempts')
      .selectAll().where('allocation_id', 'in', allocationIds)
      .orderBy('created_at').orderBy('id').execute()
    : []
  const manualsByAllocation = new Map<string, typeof manualRows>()
  for (const manual of manualRows) {
    const attempts = manualsByAllocation.get(manual.allocation_id) ?? []
    attempts.push(manual)
    manualsByAllocation.set(manual.allocation_id, attempts)
  }
  const audits = includeAudit && refundIds.length
    ? await db.selectFrom('order_refund_audit_events').selectAll()
      .where('refund_id', 'in', refundIds).orderBy('created_at').orderBy('id').execute()
    : []
  const auditsByRefund = new Map<string, typeof audits>()
  for (const event of audits) {
    const events = auditsByRefund.get(event.refund_id) ?? []
    events.push(event)
    auditsByRefund.set(event.refund_id, events)
  }
  const allocationsByRefund = new Map<string, typeof allocationRows>()
  for (const allocation of allocationRows) {
    const rows = allocationsByRefund.get(allocation.refund_id) ?? []
    rows.push(allocation)
    allocationsByRefund.set(allocation.refund_id, rows)
  }

  const blocker = await refundBlocker(db, orderId)
  const activeRequestAmount = rawRefunds
    .filter(refund => ['requested', 'approved', 'processing', 'partially_succeeded'].includes(refund.status))
    .reduce((total, refund) => total + cents(refund.amount) - cents(refund.succeeded_amount), 0n)
  const availableNow = cents(totals.eligible_remaining_amount)
    - rawRefunds
      .filter(refund => ['requested', 'approved', 'processing', 'partially_succeeded'].includes(refund.status))
      .reduce((total, refund) => total + cents(refund.amount) - cents(refund.succeeded_amount) - cents(refund.reserved_amount), 0n)
  const refundableAmount = amountFromCents(availableNow)
  const payoutMode: RefundPayoutMode = order.customer_id
    ? await db.selectFrom('wallet_accounts').select('customer_id').where('customer_id', '=', order.customer_id).executeTakeFirst()
      ? 'wallet'
      : 'unavailable'
    : totals.has_external ? 'manual_original_source' : 'unavailable'
  const financial = await sql<{ refund_status: string }>`
    SELECT refund_status FROM order_financial_status WHERE order_id = ${orderId}::uuid
  `.execute(db).then(result => result.rows[0])
  let refundStatus: RefundProgressStatus
  if (cents(totals.eligible_receipt_amount) > 0n
    && cents(totals.refunded_amount) >= cents(totals.eligible_receipt_amount)) {
    refundStatus = 'refunded'
  } else if (cents(totals.refunded_amount) > 0n) {
    refundStatus = 'partially_refunded'
  } else if (financial?.refund_status === 'requested_or_processing' || rawRefunds.some(refund =>
    ['requested', 'approved', 'processing', 'partially_succeeded'].includes(refund.status))) {
    refundStatus = 'requested_or_processing'
  } else {
    refundStatus = 'none'
  }
  const blockedReason = blockerReason(blocker)
    ?? (cents(totals.eligible_receipt_amount) === 0n ? 'no_confirmed_receipts' : null)
    ?? (cents(refundableAmount) === 0n ? 'no_refundable_balance' : null)

  const items = rawRefunds.map((refund) => {
    const common = {
      id: refund.id,
      amount: normalizeWalletAmount(refund.amount),
      succeededAmount: normalizeWalletAmount(refund.succeeded_amount),
      reservedAmount: normalizeWalletAmount(refund.reserved_amount),
      status: refund.status,
      reason: refund.reason,
      rejectionReason: refund.rejection_reason,
      payoutMode: order.customer_id ? 'wallet' as const : 'manual_original_source' as const,
      createdAt: refund.created_at.toISOString(),
      updatedAt: refund.updated_at.toISOString(),
      reviewedAt: refund.reviewed_at?.toISOString() ?? null,
      allocations: (allocationsByRefund.get(refund.id) ?? []).map(allocation => ({
        id: allocation.id,
        operationId: allocation.operation_id,
        sourceReceiptId: allocation.source_payment_receipt_id,
        sourceBucket: allocation.source_bucket,
        sourceReceiptAmount: normalizeWalletAmount(allocation.source_receipt_amount),
        sourceDisposition: allocation.source_disposition,
        sourceProvider: allocation.source_provider,
        sourceProviderTransactionId: allocation.source_provider_transaction_id,
        destination: allocation.destination,
        amount: normalizeWalletAmount(allocation.amount),
        status: allocation.status,
        provider: allocation.provider,
        providerRefundId: allocation.provider_refund_id,
        createdAt: allocation.created_at.toISOString(),
        completedAt: allocation.completed_at?.toISOString() ?? null,
        manualAttempts: (manualsByAllocation.get(allocation.id) ?? []).map(manual => ({
          id: manual.id,
          status: manual.status,
          startedByAdminId: manual.started_by_admin_id,
          resolvedByAdminId: manual.resolved_by_admin_id,
          providerReference: manual.provider_reference,
          amount: manual.refunded_amount === null ? null : normalizeWalletAmount(manual.refunded_amount),
          actualRefundedAt: manual.actual_refunded_at?.toISOString() ?? null,
          evidenceSummary: manual.evidence_summary,
          resolutionNote: manual.resolution_note,
          createdAt: manual.created_at.toISOString(),
          completedAt: manual.completed_at?.toISOString() ?? null,
        })),
      })),
    }
    if (!includeAudit) return common
    return {
      ...common,
      reviewedByAdminId: refund.reviewed_by_admin_id,
      auditEvents: (auditsByRefund.get(refund.id) ?? []).map(event => ({
        id: event.id,
        action: event.action,
        actorType: event.actor_type,
        actorCustomerId: event.actor_customer_id,
        actorAdminId: event.actor_admin_id,
        previousStatus: event.previous_status,
        nextStatus: event.next_status,
        details: event.details,
        createdAt: event.created_at.toISOString(),
      })),
    }
  })

  const result = {
    orderId,
    payoutMode,
    refundStatus,
    confirmedReceiptAmount: normalizeWalletAmount(totals.receipt_amount),
    refundableAmount,
    refundedAmount: normalizeWalletAmount(totals.refunded_amount),
    refundReservedAmount: normalizeWalletAmount(totals.reserved_amount),
    activeRequestAmount: amountFromCents(activeRequestAmount),
    canRequest: payoutMode !== 'unavailable' && blockedReason === null && cents(refundableAmount) > 0n,
    blockedReason,
    items,
  }
  return includeAudit ? result as AdminOrderRefunds : result as CustomerOrderRefunds
}

async function customerRefundsForOwner(
  db: Kysely<Database>, orderId: string, owner: RefundOwner,
): Promise<CustomerOrderRefunds> {
  const order = await db.transaction().execute(async (trx) => {
    let resolvedOwnerId: string
    if (owner.type === 'customer') {
      await assertCustomerSession(trx, owner.customer)
      resolvedOwnerId = owner.customer.id
    } else {
      resolvedOwnerId = await assertGuestSession(trx, owner.token)
    }
    const query = trx.selectFrom('orders').select('id').where('id', '=', orderId)
    const result = owner.type === 'customer'
      ? await query.where('customer_id', '=', resolvedOwnerId).executeTakeFirst()
      : await query.where('guest_order_session_id', '=', resolvedOwnerId).where('customer_id', 'is', null).executeTakeFirst()
    return result
  })
  if (!order) throw new RefundError(404, 'ORDER_NOT_FOUND', '找不到属于当前顾客或游客会话的订单。')
  return await loadRefundSummary(db, orderId, false) as CustomerOrderRefunds
}

async function customerCreateRefund(
  db: Kysely<Database>, orderId: string, owner: RefundOwner, body: CreateOrderRefundBody,
): Promise<{ repeated: boolean; refunds: CustomerOrderRefunds }> {
  const amount = normalizeWalletAmount(body.amount)
  if (cents(amount) <= 0n) throw new RefundError(422, 'REFUND_AMOUNT_INVALID', '退款金额必须大于零。')
  const reason = body.reason.trim()
  if (!reason) throw new RefundError(422, 'REFUND_REASON_REQUIRED', '请填写退款原因。')
  const hash = requestHash({ orderId, amount, reason })
  const result = await db.transaction().execute(async (trx) => {
    await setRefundActor(trx, actorFor(owner))
    const order = await lockCustomerOrder(trx, orderId, owner)
    const existing = await trx.selectFrom('order_refunds').select(['id', 'request_sha256'])
      .where('order_id', '=', orderId).where('idempotency_key', '=', body.idempotencyKey).executeTakeFirst()
    if (existing) {
      if (existing.request_sha256 !== hash) throw new RefundError(409, 'REFUND_IDEMPOTENCY_CONFLICT', '此退款幂等标识已用于不同金额或原因。')
      return { repeated: true }
    }
    await assertRefundNotBlocked(trx, order.id)
    const receipts = await lockRefundSourceReceipts(trx, orderId)
    const sourceAvailable = receipts.filter(receipt => isUsableReceipt(receipt)
      && (order.customer_id !== null || receipt.source_bucket === 'external'))
      .reduce((total, receipt) => total + cents(receipt.amount) - cents(receipt.refund_reserved_amount) - cents(receipt.refunded_amount), 0n)
    const active = await trx.selectFrom('order_refunds as refund')
      .select(sql<string>`COALESCE(sum(refund.amount
        - COALESCE((SELECT sum(amount) FROM order_refund_allocations AS allocation
          WHERE allocation.refund_id = refund.id AND allocation.status = 'succeeded'), 0)
        - COALESCE((SELECT sum(amount) FROM order_refund_allocations AS allocation
          WHERE allocation.refund_id = refund.id AND allocation.status = 'reserved'), 0)), 0)::text`.as('unallocated'))
      .where('refund.order_id', '=', orderId)
      .where('refund.status', 'in', ['requested', 'approved', 'processing', 'partially_succeeded'])
      .executeTakeFirstOrThrow()
    if (cents(amount) > sourceAvailable - cents(active.unallocated)) {
      throw new RefundError(409, 'REFUND_AMOUNT_UNAVAILABLE', '退款金额超过当前真实可退款余额。')
    }
    await trx.insertInto('order_refunds').values({
      id: randomUUID(), order_id: orderId, idempotency_key: body.idempotencyKey,
      request_sha256: hash, amount, status: 'requested', reason,
    }).execute()
    const refundId = await trx.selectFrom('order_refunds').select('id')
      .where('order_id', '=', orderId).where('idempotency_key', '=', body.idempotencyKey).executeTakeFirstOrThrow()
    await appendAction(trx, {
      refundId: refundId.id,
      idempotencyKey: body.idempotencyKey,
      hash,
      action: 'refund_requested',
      actor: actorFor(owner),
      details: { amount, reason, payoutMode: order.customer_id ? 'wallet' : 'manual_original_source' },
    })
    return { repeated: false }
  })
  return { ...result, refunds: await loadRefundSummary(db, orderId, false) as CustomerOrderRefunds }
}

async function adminApproveRefund(
  db: Kysely<Database>, orderId: string, refundId: string, adminId: string, body: AdminRefundActionBody,
): Promise<{ repeated: boolean; refunds: AdminOrderRefunds }> {
  const hash = requestHash({ orderId, refundId, action: 'approve' })
  const result = await db.transaction().execute(async (trx) => {
    await setRefundActor(trx, { type: 'admin', adminId })
    const context = await adminLockRefundContext(trx, orderId, refundId)
    const refund = context.refund!
    if (await actionReplay(trx, refundId, body.idempotencyKey, 'refund_approved', hash)) return { repeated: true }
    if (refund.status !== 'requested') throw new RefundError(409, 'REFUND_STATUS_CHANGED', '此退款申请已审核或已处理，请刷新后再操作。')
    await assertRefundNotBlocked(trx, orderId)
    const receipts = await lockRefundSourceReceipts(trx, orderId)
    const splits = allocateRefundSources(receipts, refund.amount, context.order.customer_id !== null)
    await trx.updateTable('order_refunds').set({
      status: 'approved', reviewed_by_admin_id: adminId,
    }).where('id', '=', refundId).where('status', '=', 'requested').executeTakeFirstOrThrow()
    const allocations = splits.map(split => ({
      id: randomUUID(),
      refund_id: refundId,
      source_payment_receipt_id: split.receipt.id,
      operation_id: randomUUID(),
      request_sha256: requestHash({ refundId, receiptId: split.receipt.id, amount: split.amount, destination: split.destination }),
      destination: split.destination,
      amount: split.amount,
      status: 'reserved' as const,
      provider: null,
      provider_refund_id: null,
    }))
    await trx.insertInto('order_refund_allocations').values(allocations).execute()
    await trx.updateTable('order_refunds').set({ status: 'processing' })
      .where('id', '=', refundId).where('status', '=', 'approved').executeTakeFirstOrThrow()
    if (context.order.customer_id) {
      for (const allocation of allocations) {
        await trx.updateTable('order_refund_allocations').set({ status: 'succeeded' })
          .where('id', '=', allocation.id).where('status', '=', 'reserved').executeTakeFirstOrThrow()
      }
      await trx.updateTable('order_refunds').set({ status: 'succeeded' })
        .where('id', '=', refundId).where('status', '=', 'processing').executeTakeFirstOrThrow()
    }
    await appendAction(trx, {
      refundId, idempotencyKey: body.idempotencyKey, hash, action: 'refund_approved',
      actor: { type: 'admin', adminId },
      details: {
        amount: refund.amount,
        payoutMode: context.order.customer_id ? 'wallet' : 'manual_original_source',
        allocations: allocations.map(allocation => ({
          id: allocation.id, operationId: allocation.operation_id,
          sourceReceiptId: allocation.source_payment_receipt_id, amount: allocation.amount,
          destination: allocation.destination,
        })),
      },
    })
    return { repeated: false }
  })
  return { ...result, refunds: await loadRefundSummary(db, orderId, true) as AdminOrderRefunds }
}

async function adminRejectRefund(
  db: Kysely<Database>, orderId: string, refundId: string, adminId: string, body: AdminRefundRejectionBody,
): Promise<{ repeated: boolean; refunds: AdminOrderRefunds }> {
  const reason = body.reason.trim()
  const hash = requestHash({ orderId, refundId, action: 'reject', reason })
  const result = await db.transaction().execute(async (trx) => {
    await setRefundActor(trx, { type: 'admin', adminId })
    await adminLockRefundContext(trx, orderId, refundId)
    if (await actionReplay(trx, refundId, body.idempotencyKey, 'refund_rejected', hash)) return { repeated: true }
    const refund = await trx.selectFrom('order_refunds').select('status').where('id', '=', refundId).forUpdate().executeTakeFirstOrThrow()
    if (refund.status !== 'requested') throw new RefundError(409, 'REFUND_STATUS_CHANGED', '只有待审核退款申请可以拒绝。')
    await trx.updateTable('order_refunds').set({
      status: 'cancelled', rejection_reason: reason, reviewed_by_admin_id: adminId,
    }).where('id', '=', refundId).where('status', '=', 'requested').executeTakeFirstOrThrow()
    await appendAction(trx, {
      refundId, idempotencyKey: body.idempotencyKey, hash, action: 'refund_rejected',
      actor: { type: 'admin', adminId }, details: { reason },
    })
    return { repeated: false }
  })
  return { ...result, refunds: await loadRefundSummary(db, orderId, true) as AdminOrderRefunds }
}

async function adminRetryGuestRefund(
  db: Kysely<Database>, orderId: string, refundId: string, adminId: string, body: AdminRefundActionBody,
): Promise<{ repeated: boolean; refunds: AdminOrderRefunds }> {
  const hash = requestHash({ orderId, refundId, action: 'retry' })
  const result = await db.transaction().execute(async (trx) => {
    await setRefundActor(trx, { type: 'admin', adminId })
    const context = await adminLockRefundContext(trx, orderId, refundId)
    if (context.order.customer_id) throw new RefundError(409, 'REFUND_RETRY_NOT_MANUAL', '钱包退款由数据库事务原子完成，无需人工重试。')
    const refund = context.refund!
    if (await actionReplay(trx, refundId, body.idempotencyKey, 'refund_retry_reserved', hash)) return { repeated: true }
    if (!['failed', 'partially_succeeded'].includes(refund.status)) {
      throw new RefundError(409, 'REFUND_STATUS_CHANGED', '当前退款没有可重试的已释放金额。')
    }
    await assertRefundNotBlocked(trx, orderId)
    const receipts = await lockRefundSourceReceipts(trx, orderId)
    const missing = cents(refund.amount) - cents(refund.succeeded_amount) - cents(refund.reserved_amount)
    if (missing <= 0n) throw new RefundError(409, 'REFUND_NOT_RETRYABLE', '当前没有已释放且待重试的退款金额。')
    const splits = allocateRefundSources(receipts, amountFromCents(missing), false)
    if (refund.status === 'failed') {
      await trx.updateTable('order_refunds').set({ status: 'processing' })
        .where('id', '=', refundId).where('status', '=', 'failed').executeTakeFirstOrThrow()
    } else {
      await trx.updateTable('order_refunds').set({ status: 'processing' })
        .where('id', '=', refundId).where('status', '=', 'partially_succeeded').executeTakeFirstOrThrow()
    }
    const allocations = splits.map(split => ({
      id: randomUUID(), refund_id: refundId, source_payment_receipt_id: split.receipt.id,
      operation_id: randomUUID(),
      request_sha256: requestHash({ refundId, receiptId: split.receipt.id, amount: split.amount, destination: split.destination, retry: body.idempotencyKey }),
      destination: split.destination, amount: split.amount,
      status: 'reserved' as const, provider: null, provider_refund_id: null,
    }))
    await trx.insertInto('order_refund_allocations').values(allocations).execute()
    await appendAction(trx, {
      refundId, idempotencyKey: body.idempotencyKey, hash, action: 'refund_retry_reserved',
      actor: { type: 'admin', adminId },
      details: { amount: amountFromCents(missing), allocations: allocations.map(allocation => ({
        id: allocation.id, operationId: allocation.operation_id,
        sourceReceiptId: allocation.source_payment_receipt_id, amount: allocation.amount,
      })) },
    })
    return { repeated: false }
  })
  return { ...result, refunds: await loadRefundSummary(db, orderId, true) as AdminOrderRefunds }
}

async function adminStartManualAttempt(
  db: Kysely<Database>, orderId: string, refundId: string, allocationId: string, adminId: string,
  body: AdminRefundActionBody,
): Promise<{ repeated: boolean; refunds: AdminOrderRefunds }> {
  const hash = requestHash({ orderId, refundId, allocationId, action: 'manual_attempt_start' })
  const result = await db.transaction().execute(async (trx) => {
    await setRefundActor(trx, { type: 'admin', adminId })
    const context = await adminLockRefundContext(trx, orderId, refundId)
    if (context.order.customer_id) throw new RefundError(409, 'REFUND_MANUAL_NOT_REQUIRED', '顾客退款会自动退回本人钱包。')
    if (await actionReplay(trx, refundId, body.idempotencyKey, 'manual_attempt_started', hash)) return { repeated: true }
    await assertRefundNotBlocked(trx, orderId)
    const allocation = await trx.selectFrom('order_refund_allocations as allocation')
      .innerJoin('payment_receipts as receipt', 'receipt.id', 'allocation.source_payment_receipt_id')
      .select(['allocation.id', 'allocation.status', 'allocation.destination', 'allocation.amount', 'receipt.id as receipt_id'])
      .where('allocation.id', '=', allocationId).where('allocation.refund_id', '=', refundId).forUpdate().executeTakeFirst()
    if (!allocation || allocation.status !== 'reserved' || allocation.destination !== 'original_source') {
      throw new RefundError(409, 'REFUND_ALLOCATION_NOT_MANUAL', '该退款来源当前不能进行人工原路退款。')
    }
    const existingActive = await trx.selectFrom('order_refund_manual_attempts').select('id')
      .where('allocation_id', '=', allocationId).where('status', 'in', ['started', 'unknown'])
      .forUpdate().executeTakeFirst()
    if (existingActive) throw new RefundError(409, 'REFUND_MANUAL_ATTEMPT_ACTIVE', '这笔人工退款已有待确认操作，请先核实已有处理结果。')
    const attemptId = randomUUID()
    await trx.insertInto('order_refund_manual_attempts').values({
      id: attemptId, allocation_id: allocationId, idempotency_key: body.idempotencyKey,
      request_sha256: hash, started_by_admin_id: adminId, status: 'started',
    }).execute()
    await appendAction(trx, {
      refundId, idempotencyKey: body.idempotencyKey, hash, action: 'manual_attempt_started',
      actor: { type: 'admin', adminId }, details: { allocationId, manualAttemptId: attemptId, amount: allocation.amount },
    })
    return { repeated: false }
  })
  return { ...result, refunds: await loadRefundSummary(db, orderId, true) as AdminOrderRefunds }
}

async function adminResolveManualAttempt(
  db: Kysely<Database>, orderId: string, refundId: string, allocationId: string, attemptId: string,
  adminId: string, body: AdminRefundManualResolutionBody,
): Promise<{ repeated: boolean; refunds: AdminOrderRefunds }> {
  const resolution = body.outcome === 'succeeded'
    ? {
        outcome: body.outcome, providerRefundId: body.providerRefundId.trim(), amount: normalizeWalletAmount(body.amount),
        actualRefundedAt: body.actualRefundedAt, evidenceSummary: body.evidenceSummary.trim(),
      }
    : { outcome: body.outcome, resolutionNote: body.resolutionNote.trim() }
  const hash = requestHash({ orderId, refundId, allocationId, attemptId, ...resolution })
  const action = body.outcome === 'succeeded' ? 'manual_refund_confirmed'
    : body.outcome === 'unknown' ? 'manual_attempt_unknown' : 'manual_attempt_failed'
  const result = await db.transaction().execute(async (trx) => {
    await setRefundActor(trx, { type: 'admin', adminId })
    const context = await adminLockRefundContext(trx, orderId, refundId)
    if (context.order.customer_id) throw new RefundError(409, 'REFUND_MANUAL_NOT_REQUIRED', '顾客退款会自动退回本人钱包。')
    if (await actionReplay(trx, refundId, body.idempotencyKey, action, hash)) return { repeated: true }
    const attempt = await trx.selectFrom('order_refund_manual_attempts')
      .select(['id', 'allocation_id', 'status'])
      .where('id', '=', attemptId).where('allocation_id', '=', allocationId).forUpdate().executeTakeFirst()
    if (!attempt) throw new RefundError(404, 'REFUND_MANUAL_ATTEMPT_NOT_FOUND', '人工退款操作记录不存在。')
    if (!['started', 'unknown'].includes(attempt.status)) {
      throw new RefundError(409, 'REFUND_MANUAL_ATTEMPT_RESOLVED', '该人工退款操作已有最终结果。')
    }
    if (body.outcome === 'succeeded') {
      const allocation = await trx.selectFrom('order_refund_allocations')
        .select('amount').where('id', '=', allocationId).where('refund_id', '=', refundId).executeTakeFirstOrThrow()
      if (cents(body.amount) !== cents(allocation.amount)) {
        throw new RefundError(409, 'REFUND_AMOUNT_MISMATCH', '实际退款金额必须与本笔预留金额完全一致。')
      }
      const actualTime = new Date(body.actualRefundedAt)
      if (!Number.isFinite(actualTime.getTime()) || actualTime.getTime() > Date.now()) {
        throw new RefundError(422, 'REFUND_TIME_INVALID', '实际退款时间不能晚于当前时间。')
      }
      await trx.updateTable('order_refund_manual_attempts').set({
        status: 'succeeded', resolved_by_admin_id: adminId,
        provider_reference: resolution.providerRefundId,
        refunded_amount: resolution.amount,
        actual_refunded_at: actualTime,
        evidence_summary: resolution.evidenceSummary,
        resolution_note: null,
        result_sha256: hash,
      }).where('id', '=', attemptId).executeTakeFirstOrThrow()
    } else {
      await trx.updateTable('order_refund_manual_attempts').set({
        status: body.outcome, resolved_by_admin_id: adminId,
        resolution_note: resolution.resolutionNote,
        result_sha256: hash,
      }).where('id', '=', attemptId).executeTakeFirstOrThrow()
    }
    const allocations = await trx.selectFrom('order_refund_allocations')
      .select(['status', 'amount']).where('refund_id', '=', refundId).execute()
    const succeeded = allocations.filter(item => item.status === 'succeeded').reduce((sum, item) => sum + cents(item.amount), 0n)
    const reserved = allocations.filter(item => item.status === 'reserved').reduce((sum, item) => sum + cents(item.amount), 0n)
    const requested = cents(context.refund!.amount)
    const nextStatus: DbRefundStatus = succeeded === 0n && reserved === 0n
      ? 'failed'
      : succeeded === requested && reserved === 0n
        ? 'succeeded'
        : succeeded > 0n
          ? 'partially_succeeded'
          : 'processing'
    await setRefundStatus(trx, refundId, nextStatus)
    await appendAction(trx, {
      refundId, idempotencyKey: body.idempotencyKey, hash, action,
      actor: { type: 'admin', adminId },
      details: {
        allocationId, manualAttemptId: attemptId,
        ...(body.outcome === 'succeeded'
          ? { providerRefundId: resolution.providerRefundId, amount: resolution.amount,
              actualRefundedAt: resolution.actualRefundedAt, evidenceSummary: resolution.evidenceSummary }
          : { resolutionNote: resolution.resolutionNote }),
      },
    })
    return { repeated: false }
  })
  return { ...result, refunds: await loadRefundSummary(db, orderId, true) as AdminOrderRefunds }
}

function ownerForCustomer(customer: AuthenticatedCustomer): RefundOwner {
  return { type: 'customer', customer }
}

function ownerForGuest(request: FastifyRequest): RefundOwner {
  return { type: 'guest', token: request.cookies[guestSessionCookie] }
}

export function registerRefundRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const customerAuth = requireCustomer(db, config)
  const optionalCustomerAuth = optionalCustomer(db, config)
  const customerCsrf = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)
  const administrator = requireAdmin(db, config)
  const adminCsrf = verifyAdminCsrf(config)

  app.get('/api/v1/customer/orders/:id/refunds', {
    preHandler: customerAuth,
    schema: {
      tags: ['customer'], summary: 'Read refund progress for an order owned by the signed-in customer',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerOrderRefundsSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const refunds = await customerRefundsForOwner(db, params.id, ownerForCustomer(request.customer!))
      reply.header('cache-control', 'no-store')
      return success(refunds, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/orders/:id/refunds', {
    preHandler: [customerAuth, customerCsrf],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Request a wallet refund for a customer-owned order',
      params: OrderIdParamsSchema, body: CreateOrderRefundBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerOrderRefundMutationSchema), 201: ApiSuccessSchemaOf(CustomerOrderRefundMutationSchema),
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const body = request.body as CreateOrderRefundBody
      const result = await customerCreateRefund(db, params.id, ownerForCustomer(request.customer!), body)
      reply.header('cache-control', 'no-store')
      return reply.code(result.repeated ? 200 : 201).send(success(result, request.id))
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.get('/api/v1/guest/orders/:id/refunds', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'Read refund progress for an order owned by the current guest session',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerOrderRefundsSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const refunds = await customerRefundsForOwner(db, params.id, ownerForGuest(request))
      reply.header('cache-control', 'no-store')
      return success(refunds, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.post('/api/v1/guest/orders/:id/refunds', {
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Request a manual original-source refund for a guest order',
      params: OrderIdParamsSchema, body: CreateOrderRefundBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerOrderRefundMutationSchema), 201: ApiSuccessSchemaOf(CustomerOrderRefundMutationSchema),
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const body = request.body as CreateOrderRefundBody
      const result = await customerCreateRefund(db, params.id, ownerForGuest(request), body)
      reply.header('cache-control', 'no-store')
      return reply.code(result.repeated ? 200 : 201).send(success(result, request.id))
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.get('/api/v1/admin/orders/:id/refunds', {
    preHandler: administrator,
    schema: {
      tags: ['admin'], summary: 'Read order refunds, source receipts, wallet allocations and refund audit history',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderRefundsSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const refunds = await loadRefundSummary(db, params.id, true) as AdminOrderRefunds
      reply.header('cache-control', 'no-store')
      return success(refunds, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/orders/:id/refunds/:refundId/approve', {
    preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Approve a refund and reserve each confirmed funding source',
      params: OrderRefundIdParamsSchema, body: AdminRefundActionBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderRefundMutationSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; refundId: string }
      const result = await adminApproveRefund(db, params.id, params.refundId, request.admin!.id, request.body as AdminRefundActionBody)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/orders/:id/refunds/:refundId/reject', {
    preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Reject a refund request with an immutable reason',
      params: OrderRefundIdParamsSchema, body: AdminRefundRejectionBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderRefundMutationSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; refundId: string }
      const result = await adminRejectRefund(db, params.id, params.refundId, request.admin!.id, request.body as AdminRefundRejectionBody)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/orders/:id/refunds/:refundId/retry', {
    preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Reserve the unreimbursed remainder for a guest manual refund retry',
      params: OrderRefundIdParamsSchema, body: AdminRefundActionBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderRefundMutationSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; refundId: string }
      const result = await adminRetryGuestRefund(db, params.id, params.refundId, request.admin!.id, request.body as AdminRefundActionBody)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/orders/:id/refunds/:refundId/allocations/:allocationId/manual-attempts', {
    preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Start an auditable manual original-source refund operation for a guest allocation',
      params: OrderRefundAllocationParamsSchema,
      body: AdminRefundManualAttemptBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderRefundMutationSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; refundId: string; allocationId: string }
      const result = await adminStartManualAttempt(db, params.id, params.refundId, params.allocationId,
        request.admin!.id, request.body as AdminRefundActionBody)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/orders/:id/refunds/:refundId/allocations/:allocationId/manual-attempts/:attemptId/resolve', {
    preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Record the real result of a guest manual original-source refund attempt',
      params: OrderRefundManualAttemptParamsSchema,
      body: AdminRefundManualResolutionBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderRefundMutationSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; refundId: string; allocationId: string; attemptId: string }
      const result = await adminResolveManualAttempt(db, params.id, params.refundId, params.allocationId,
        params.attemptId, request.admin!.id, request.body as AdminRefundManualResolutionBody)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handleRefundError(error, reply, request.id) }
  })
}
