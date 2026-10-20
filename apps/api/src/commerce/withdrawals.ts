import { createHash, randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import sharp from 'sharp'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  AdminWithdrawalActionBodySchema,
  AdminWithdrawalDetailSchema,
  AdminWithdrawalListQuerySchema,
  AdminWithdrawalListSchema,
  AdminWithdrawalRejectionBodySchema,
  AdminWithdrawalResolveBodySchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreateWithdrawalBodySchema,
  CustomerWithdrawalMutationSchema,
  CustomerWithdrawalPageSchema,
  CustomerWalletPageQuerySchema,
  UpdateWithdrawalSettingsBodySchema,
  WithdrawalIdParamsSchema,
  WithdrawalQrUploadSchema,
  WithdrawalSettingsSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  AdminWithdrawalActionBody,
  AdminWithdrawalDetail,
  AdminWithdrawalListQuery,
  AdminWithdrawalRejectionBody,
  AdminWithdrawalResolveBody,
  CreateWithdrawalBody,
  CustomerWithdrawal,
  CustomerWithdrawalPage,
  UpdateWithdrawalSettingsBody,
  WithdrawalPayoutAttempt,
  WithdrawalPayoutMethod,
  WithdrawalPayoutResult,
  WithdrawalRecipientInput,
  WithdrawalRecipientSnapshot,
  WithdrawalSettings,
  WithdrawalStatus,
} from '@aikayun/contracts'
import { calculateWithdrawalFee, normalizeWalletAmount, normalizeWithdrawalPercent, settleAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf as verifyAdminCsrf } from '../auth/admin.js'
import { CUSTOMER_CSRF_COOKIE, requireCustomer, type AuthenticatedCustomer } from '../auth/customer.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import type { Database, WithdrawalPayoutAttemptStatus, WithdrawalStatus as DbWithdrawalStatus } from '../db/types.js'
import { assertCustomerSession } from './orders.js'

type Db = Kysely<Database> | Transaction<Database>
type Recipient = WithdrawalRecipientSnapshot
type SettingsRow = {
  withdrawal_enabled: boolean
  withdrawal_min_amount: string
  withdrawal_max_amount: string
  withdrawal_fixed_fee: string
  withdrawal_percent_fee: string
  withdrawal_methods: WithdrawalPayoutMethod[]
  updated_at: Date
}

const MAX_QR_BYTES = 5 * 1024 * 1024
const MAX_QR_REQUEST_BYTES = MAX_QR_BYTES + 32 * 1024
const MAX_QR_PIXELS = 8_000_000
const uploadLimits = { fileSize: MAX_QR_BYTES, files: 1, fields: 0, parts: 1, fieldSize: 0, fieldNameSize: 32, headerPairs: 20 }
const methods: WithdrawalPayoutMethod[] = ['alipay', 'wechat', 'bank_card']

class WithdrawalError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'WithdrawalError'
  }
}

function postgresInfo(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}) }
    }
    current = candidate.cause
  }
  return {}
}

function handleWithdrawalError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof WithdrawalError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error && typeof error === 'object' && 'status' in error && 'code' in error
    && typeof (error as { status?: unknown }).status === 'number'
    && typeof (error as { code?: unknown }).code === 'string') {
    const candidate = error as { status: number; code: string; message?: unknown }
    return reply.code(candidate.status).send(failure(candidate.code, String(candidate.message ?? '提现请求无法完成。'), requestId))
  }
  const { code, constraint } = postgresInfo(error)
  if (constraint === 'withdrawal_payout_results_reference_unique' || constraint === 'withdrawal_payout_reference_unique') {
    return reply.code(409).send(failure('WITHDRAWAL_REFERENCE_USED', '该真实转账参考号已关联其他提现，请核对后再记录。', requestId))
  }
  if (code === '40001' || code === '40P01') {
    return reply.code(409).send(failure('WITHDRAWAL_CONCURRENT_CONFLICT', '钱包或提现正在并发变化，请刷新状态后重试。', requestId))
  }
  if (constraint?.startsWith('withdrawal_') || constraint?.startsWith('withdrawals_')) {
    return reply.code(409).send(failure('WITHDRAWAL_STATE_CONFLICT', '提现状态或冻结资金已变化，请刷新记录后重试。', requestId))
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return reply.code(422).send(failure('WITHDRAWAL_INPUT_INVALID', '金额、手续费或收款信息超出有效范围。', requestId))
  }
  throw error
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function cents(value: string): bigint {
  const normalized = normalizeWalletAmount(value)
  const [whole, fraction] = normalized.split('.')
  return BigInt(whole!) * 100n + BigInt(fraction!)
}

function toSettings(row: SettingsRow): WithdrawalSettings {
  return {
    enabled: row.withdrawal_enabled,
    minAmount: settleAmount(row.withdrawal_min_amount),
    maxAmount: settleAmount(row.withdrawal_max_amount),
    fixedFee: settleAmount(row.withdrawal_fixed_fee),
    percentFee: normalizeWithdrawalPercent(row.withdrawal_percent_fee),
    methods: methods.filter(method => row.withdrawal_methods.includes(method)),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toCustomerPolicy(row: SettingsRow) {
  const { enabled, minAmount, maxAmount, fixedFee, percentFee, methods: enabledMethods } = toSettings(row)
  return { enabled, minAmount, maxAmount, fixedFee, percentFee, methods: enabledMethods }
}

function normalizeText(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /\p{Cc}/u.test(normalized)) {
    throw new WithdrawalError(422, 'WITHDRAWAL_RECIPIENT_INVALID', `${label}格式无效。`)
  }
  return normalized
}

function normalizeRecipient(method: WithdrawalPayoutMethod, input: WithdrawalRecipientInput): Recipient {
  if (method === 'bank_card') {
    if (!('cardNumber' in input) || typeof input.cardNumber !== 'string' || !/^\d{12,19}$/u.test(input.cardNumber)) {
      throw new WithdrawalError(422, 'WITHDRAWAL_RECIPIENT_INVALID', '银行卡号必须为12至19位数字。')
    }
    return {
      recipientName: normalizeText(input.recipientName, '收款人', 100),
      bankName: normalizeText(input.bankName, '开户银行', 120),
      cardNumber: input.cardNumber,
    }
  }
  if ('cardNumber' in input || 'bankName' in input || 'recipientName' in input) {
    throw new WithdrawalError(422, 'WITHDRAWAL_RECIPIENT_INVALID', '所选收款方式与收款信息不匹配。')
  }
  const recipient: Recipient = {}
  if (input.account) recipient.account = normalizeText(input.account, '收款账号', 120)
  if (input.accountName) recipient.accountName = normalizeText(input.accountName, '收款人姓名', 100)
  if (input.qrFileId) recipient.qrFileId = input.qrFileId.toLowerCase()
  if (!recipient.account && !recipient.qrFileId) {
    throw new WithdrawalError(422, 'WITHDRAWAL_RECIPIENT_REQUIRED', '请填写收款账号或上传收款二维码。')
  }
  return recipient
}

function setActor(trx: Transaction<Database>, actor: { type: 'customer'; id: string } | { type: 'admin'; id: string }) {
  return sql`
    SELECT set_config('aikayun.withdrawal_actor_type', ${actor.type}, true),
      set_config('aikayun.withdrawal_actor_customer_id', ${actor.type === 'customer' ? actor.id : ''}, true),
      set_config('aikayun.withdrawal_actor_admin_id', ${actor.type === 'admin' ? actor.id : ''}, true)
  `.execute(trx)
}

async function currentSettings(db: Db, lock?: 'share' | 'update'): Promise<SettingsRow> {
  let query = db.selectFrom('storefront_customer_policy')
    .select([
      'withdrawal_enabled', 'withdrawal_min_amount', 'withdrawal_max_amount',
      'withdrawal_fixed_fee', 'withdrawal_percent_fee', 'withdrawal_methods', 'updated_at',
    ]).where('singleton', '=', true)
  if (lock === 'share') query = query.forShare()
  if (lock === 'update') query = query.forUpdate()
  return query.executeTakeFirstOrThrow()
}

async function appendActionEvent(trx: Transaction<Database>, input: {
  withdrawalId: string
  action: string
  actor: { type: 'customer'; id: string } | { type: 'admin'; id: string }
  idempotencyKey: string
  hash: string
  previousStatus: DbWithdrawalStatus | null
  nextStatus: DbWithdrawalStatus | null
  details?: Record<string, unknown>
}): Promise<void> {
  await trx.insertInto('withdrawal_audit_events').values({
    id: randomUUID(), withdrawal_id: input.withdrawalId, action: input.action,
    actor_type: input.actor.type, actor_customer_id: input.actor.type === 'customer' ? input.actor.id : null,
    actor_admin_id: input.actor.type === 'admin' ? input.actor.id : null,
    idempotency_key: input.idempotencyKey, request_sha256: input.hash,
    previous_status: input.previousStatus, next_status: input.nextStatus, details: input.details ?? {},
  }).execute()
}

async function actionReplay(trx: Transaction<Database>, withdrawalId: string, key: string, action: string, hash: string): Promise<boolean> {
  const event = await trx.selectFrom('withdrawal_audit_events').select(['action', 'request_sha256'])
    .where('withdrawal_id', '=', withdrawalId).where('idempotency_key', '=', key).executeTakeFirst()
  if (!event) return false
  if (event.action !== action || event.request_sha256 !== hash) {
    throw new WithdrawalError(409, 'WITHDRAWAL_IDEMPOTENCY_CONFLICT', '此幂等标识已用于不同的提现操作。')
  }
  return true
}

function asRecipient(value: Record<string, unknown>): Recipient {
  const allowed = ['account', 'accountName', 'recipientName', 'bankName', 'cardNumber', 'qrFileId'] as const
  const result: Record<string, string> = {}
  for (const key of allowed) if (typeof value[key] === 'string') result[key] = value[key] as string
  return result as Recipient
}

async function loadPayoutAttempts(db: Db, withdrawalId: string): Promise<WithdrawalPayoutAttempt[]> {
  const rows = await db.selectFrom('withdrawal_payout_attempts as attempt')
    .leftJoin('withdrawal_payout_results as result', 'result.attempt_id', 'attempt.id')
    .select([
      'attempt.id', 'attempt.operation_id', 'attempt.status', 'attempt.started_by_admin_id',
      'attempt.created_at', 'attempt.completed_at', 'result.outcome', 'result.resolved_by_admin_id',
      'result.provider_reference', 'result.actual_payout_amount', 'result.actual_payout_at',
      'result.confirmed_no_transfer', 'result.evidence_sha256', 'result.evidence_summary', 'result.created_at as result_created_at',
    ])
    .where('attempt.withdrawal_id', '=', withdrawalId)
    .orderBy('attempt.created_at').orderBy('attempt.id').execute()
  return rows.map((row) => {
    let result: WithdrawalPayoutResult | null = null
    if (row.outcome) {
      result = {
        outcome: row.outcome,
        resolvedByAdminId: row.resolved_by_admin_id!,
        providerReference: row.provider_reference,
        actualPayoutAmount: row.actual_payout_amount === null ? null : settleAmount(row.actual_payout_amount!),
        actualPayoutAt: row.actual_payout_at?.toISOString() ?? null,
        confirmedNoTransfer: row.confirmed_no_transfer!,
        evidenceSha256: row.evidence_sha256!,
        evidenceSummary: row.evidence_summary!,
        createdAt: row.result_created_at!.toISOString(),
      }
    }
    return {
      id: row.id, operationId: row.operation_id,
      status: row.status as WithdrawalPayoutAttemptStatus,
      startedByAdminId: row.started_by_admin_id,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      result,
    }
  })
}

async function loadCustomerWithdrawal(db: Db, withdrawalId: string): Promise<CustomerWithdrawal> {
  const row = await db.selectFrom('withdrawals').selectAll().where('id', '=', withdrawalId).executeTakeFirstOrThrow()
  return {
    id: row.id,
    amount: settleAmount(row.amount), feeAmount: settleAmount(row.fee_amount), payoutAmount: settleAmount(row.payout_amount),
    payoutMethod: row.payout_method,
    recipient: asRecipient(row.recipient_snapshot),
    status: row.status as WithdrawalStatus,
    rejectionReason: row.rejection_reason,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    payoutAttempts: (await loadPayoutAttempts(db, withdrawalId)).map(attempt => ({
      id: attempt.id, operationId: attempt.operationId, status: attempt.status,
      createdAt: attempt.createdAt, completedAt: attempt.completedAt,
    })),
  }
}

async function buildCustomerWithdrawalPage(
  db: Kysely<Database>, customer: AuthenticatedCustomer, page: number, pageSize: number,
): Promise<CustomerWithdrawalPage> {
  return db.transaction().execute(async (trx) => {
    await assertCustomerSession(trx, customer)
    const account = await trx.selectFrom('wallet_accounts').select(['cash_available', 'cash_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirst()
    if (!account) throw new WithdrawalError(404, 'WALLET_NOT_FOUND', '当前顾客钱包不存在。')
    const policy = toCustomerPolicy(await currentSettings(trx))
    const countRow = await trx.selectFrom('withdrawals').select(sql<number>`count(*)::int`.as('total'))
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    const rows = await trx.selectFrom('withdrawals').select('id')
      .where('customer_id', '=', customer.id)
      .orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(pageSize).offset((page - 1) * pageSize).execute()
    const items = await Promise.all(rows.map(row => loadCustomerWithdrawal(trx, row.id)))
    const total = countRow.total
    return {
      cashAvailable: settleAmount(account.cash_available), cashFrozen: settleAmount(account.cash_frozen),
      policy, items, total, page, pageSize, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    }
  })
}

async function lockWithdrawalContext(trx: Transaction<Database>, withdrawalId: string) {
  const hint = await trx.selectFrom('withdrawals').select('customer_id').where('id', '=', withdrawalId).executeTakeFirst()
  if (!hint) throw new WithdrawalError(404, 'WITHDRAWAL_NOT_FOUND', '提现申请不存在。')
  await trx.selectFrom('customers').select('id').where('id', '=', hint.customer_id).forUpdate().executeTakeFirstOrThrow()
  const wallet = await trx.selectFrom('wallet_accounts').select('customer_id')
    .where('customer_id', '=', hint.customer_id).forUpdate().executeTakeFirst()
  if (!wallet) throw new WithdrawalError(409, 'WITHDRAWAL_WALLET_MISSING', '顾客钱包记录不存在，提现资金无法安全处理。')
  const withdrawal = await trx.selectFrom('withdrawals').selectAll()
    .where('id', '=', withdrawalId).forUpdate().executeTakeFirst()
  if (!withdrawal) throw new WithdrawalError(404, 'WITHDRAWAL_NOT_FOUND', '提现申请不存在。')
  return withdrawal
}

async function createWithdrawal(
  db: Kysely<Database>, customer: AuthenticatedCustomer, body: CreateWithdrawalBody,
): Promise<{ repeated: boolean; withdrawalId: string }> {
  const amount = normalizeWalletAmount(body.amount)
  const recipient = normalizeRecipient(body.payoutMethod, body.recipient)
  const hash = requestHash({ amount, payoutMethod: body.payoutMethod, recipient })
  return db.transaction().execute(async (trx) => {
    await setActor(trx, { type: 'customer', id: customer.id })
    await assertCustomerSession(trx, customer, true)
    const wallet = await trx.selectFrom('wallet_accounts').select(['cash_available'])
      .where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
    if (!wallet) throw new WithdrawalError(404, 'WALLET_NOT_FOUND', '当前顾客钱包不存在。')

    const existing = await trx.selectFrom('withdrawals').select(['id', 'request_sha256'])
      .where('customer_id', '=', customer.id).where('idempotency_key', '=', body.idempotencyKey).executeTakeFirst()
    if (existing) {
      if (existing.request_sha256 !== hash) {
        throw new WithdrawalError(409, 'WITHDRAWAL_IDEMPOTENCY_CONFLICT', '该提现幂等标识已用于不同的申请内容。')
      }
      return { repeated: true, withdrawalId: existing.id }
    }

    const settings = await currentSettings(trx, 'share')
    if (!settings.withdrawal_enabled) throw new WithdrawalError(409, 'WITHDRAWAL_DISABLED', '商家当前未开放提现。')
    if (!settings.withdrawal_methods.includes(body.payoutMethod)) {
      throw new WithdrawalError(422, 'WITHDRAWAL_METHOD_UNAVAILABLE', '该收款方式当前未开放。')
    }
    if (cents(amount) < cents(settings.withdrawal_min_amount) || cents(amount) > cents(settings.withdrawal_max_amount)) {
      throw new WithdrawalError(422, 'WITHDRAWAL_AMOUNT_OUT_OF_RANGE', '提现金额不在当前单次限额范围内。')
    }
    const fee = calculateWithdrawalFee(amount, settings.withdrawal_percent_fee, settings.withdrawal_fixed_fee)
    if (cents(wallet.cash_available) < cents(amount)) {
      throw new WithdrawalError(409, 'WITHDRAWAL_CASH_INSUFFICIENT', '可用现金余额不足，赠送余额和冻结资金不能用于提现。')
    }

    if (recipient.qrFileId) {
      const file = await trx.selectFrom('withdrawal_private_files').select(['id', 'withdrawal_id'])
        .where('id', '=', recipient.qrFileId).where('customer_id', '=', customer.id)
        .where((eb) => eb.or([
          eb('withdrawal_id', 'is not', null),
          eb('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000)),
        ])).forUpdate().executeTakeFirst()
      if (!file || file.withdrawal_id !== null) {
        throw new WithdrawalError(422, 'WITHDRAWAL_QR_UNAVAILABLE', '收款二维码不存在、已使用或不属于当前顾客。')
      }
    }

    const withdrawalId = randomUUID()
    const walletOperationId = randomUUID()
    await trx.insertInto('wallet_operations').values({
      id: walletOperationId, customer_id: customer.id, operation_type: 'withdrawal_freeze', request_sha256: hash,
      actor_admin_id: null, order_id: null, resolves_operation_id: null, requested_amount: null,
    }).execute()
    await trx.insertInto('withdrawals').values({
      id: withdrawalId, customer_id: customer.id, idempotency_key: body.idempotencyKey,
      request_sha256: hash, wallet_operation_id: walletOperationId, amount,
      fee_amount: fee.feeAmount, payout_amount: fee.payoutAmount, payout_method: body.payoutMethod,
      recipient_snapshot: recipient, status: 'pending_review', reviewed_by_admin_id: null,
      reviewed_at: null, rejection_reason: null,
    }).execute()
    if (recipient.qrFileId) {
      const attached = await trx.updateTable('withdrawal_private_files').set({ withdrawal_id: withdrawalId })
        .where('id', '=', recipient.qrFileId).where('customer_id', '=', customer.id)
        .where('withdrawal_id', 'is', null).returning('id').executeTakeFirst()
      if (!attached) throw new WithdrawalError(409, 'WITHDRAWAL_QR_UNAVAILABLE', '收款二维码已被其他提现申请使用。')
    }
    await appendActionEvent(trx, {
      withdrawalId, action: 'customer_requested', actor: { type: 'customer', id: customer.id },
      idempotencyKey: body.idempotencyKey, hash, previousStatus: null, nextStatus: 'pending_review',
      details: { amount, feeAmount: fee.feeAmount, payoutAmount: fee.payoutAmount, payoutMethod: body.payoutMethod },
    })
    return { repeated: false, withdrawalId }
  })
}

async function cancelCustomerWithdrawal(
  db: Kysely<Database>, customer: AuthenticatedCustomer, withdrawalId: string, body: AdminWithdrawalActionBody,
): Promise<boolean> {
  const action = 'customer_cancelled'
  const hash = requestHash({ withdrawalId, action })
  return db.transaction().execute(async (trx) => {
    await setActor(trx, { type: 'customer', id: customer.id })
    await assertCustomerSession(trx, customer, true)
    const account = await trx.selectFrom('wallet_accounts').select('customer_id')
      .where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
    if (!account) throw new WithdrawalError(404, 'WALLET_NOT_FOUND', '当前顾客钱包不存在。')
    const withdrawal = await trx.selectFrom('withdrawals').selectAll()
      .where('id', '=', withdrawalId).where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
    if (!withdrawal) throw new WithdrawalError(404, 'WITHDRAWAL_NOT_FOUND', '提现申请不存在。')
    if (await actionReplay(trx, withdrawalId, body.idempotencyKey, action, hash)) return true
    if (withdrawal.status !== 'pending_review') {
      throw new WithdrawalError(409, 'WITHDRAWAL_CANNOT_CANCEL', '只有待审核的提现申请可以由顾客取消。')
    }
    await trx.updateTable('withdrawals').set({ status: 'cancelled' }).where('id', '=', withdrawalId).execute()
    await appendActionEvent(trx, {
      withdrawalId, action, actor: { type: 'customer', id: customer.id },
      idempotencyKey: body.idempotencyKey, hash, previousStatus: withdrawal.status, nextStatus: 'cancelled',
    })
    return false
  })
}

async function adminReview(
  db: Kysely<Database>, withdrawalId: string, adminId: string,
  actionBody: AdminWithdrawalActionBody | AdminWithdrawalRejectionBody, approve: boolean,
): Promise<void> {
  const action = approve ? 'admin_approved' : 'admin_rejected'
  const rejection = approve ? null : (actionBody as AdminWithdrawalRejectionBody).reason.trim()
  if (!approve && (!rejection || rejection.length > 500 || /\p{Cc}/u.test(rejection))) {
    throw new WithdrawalError(422, 'WITHDRAWAL_REJECTION_REASON_REQUIRED', '拒绝申请必须填写有效原因。')
  }
  const hash = requestHash({ withdrawalId, action, rejection })
  await db.transaction().execute(async (trx) => {
    await setActor(trx, { type: 'admin', id: adminId })
    const withdrawal = await lockWithdrawalContext(trx, withdrawalId)
    if (await actionReplay(trx, withdrawalId, actionBody.idempotencyKey, action, hash)) return
    if (withdrawal.status !== 'pending_review') {
      throw new WithdrawalError(409, 'WITHDRAWAL_ALREADY_REVIEWED', '该提现已被其他管理员审核或已被顾客取消。')
    }
    const nextStatus: DbWithdrawalStatus = approve ? 'pending_transfer' : 'rejected'
    await trx.updateTable('withdrawals').set({
      status: nextStatus, reviewed_by_admin_id: adminId, reviewed_at: new Date(),
      rejection_reason: rejection,
    }).where('id', '=', withdrawalId).where('status', '=', 'pending_review').execute()
    await appendActionEvent(trx, {
      withdrawalId, action, actor: { type: 'admin', id: adminId },
      idempotencyKey: actionBody.idempotencyKey, hash,
      previousStatus: 'pending_review', nextStatus,
      details: rejection ? { rejectionReason: rejection } : {},
    })
  })
}

async function startPayoutAttempt(
  db: Kysely<Database>, withdrawalId: string, adminId: string, body: AdminWithdrawalActionBody,
): Promise<void> {
  const action = 'payout_attempt_started'
  const hash = requestHash({ withdrawalId, action })
  await db.transaction().execute(async (trx) => {
    await setActor(trx, { type: 'admin', id: adminId })
    const withdrawal = await lockWithdrawalContext(trx, withdrawalId)
    if (await actionReplay(trx, withdrawalId, body.idempotencyKey, action, hash)) return
    if (withdrawal.status !== 'pending_transfer') {
      throw new WithdrawalError(409, 'WITHDRAWAL_NOT_READY_FOR_TRANSFER', '只有待打款提现可以开始人工转账。')
    }
    const active = await trx.selectFrom('withdrawal_payout_attempts').select(['id', 'status'])
      .where('withdrawal_id', '=', withdrawalId).where('status', 'in', ['started', 'unknown'])
      .forUpdate().executeTakeFirst()
    if (active) throw new WithdrawalError(409, 'WITHDRAWAL_PAYOUT_ACTIVE', '该提现已有处理中或结果未知的打款操作，必须先核对该操作。')
    const attemptId = randomUUID()
    const operationId = randomUUID()
    await trx.insertInto('withdrawal_payout_attempts').values({
      id: attemptId, withdrawal_id: withdrawalId, operation_id: operationId,
      started_by_admin_id: adminId, resolved_by_admin_id: null, result_sha256: null,
      status: 'started', provider_reference: null, completed_at: null,
    }).execute()
    await appendActionEvent(trx, {
      withdrawalId, action, actor: { type: 'admin', id: adminId },
      idempotencyKey: body.idempotencyKey, hash,
      previousStatus: 'pending_transfer', nextStatus: 'transfer_processing',
      details: { attemptId, operationId },
    })
  })
}

async function resolvePayoutAttempt(
  db: Kysely<Database>, withdrawalId: string, attemptId: string, adminId: string, body: AdminWithdrawalResolveBody,
): Promise<boolean> {
  const action = `payout_result_${body.outcome}`
  const normalizedReference = body.outcome === 'succeeded' ? body.providerReference.trim() : null
  const normalizedAmount = body.outcome === 'succeeded' ? normalizeWalletAmount(body.actualPayoutAmount) : null
  const evidenceSummary = body.evidenceSummary.trim()
  if (!evidenceSummary || evidenceSummary.length > 500 || /\p{Cc}/u.test(evidenceSummary)) {
    throw new WithdrawalError(422, 'WITHDRAWAL_EVIDENCE_REQUIRED', '请填写有效的转账核对摘要。')
  }
  if (body.outcome === 'succeeded' && (!normalizedReference || normalizedReference.length > 200)) {
    throw new WithdrawalError(422, 'WITHDRAWAL_REFERENCE_INVALID', '请填写真实转账参考号。')
  }
  if (body.outcome === 'succeeded' && /\p{Cc}/u.test(normalizedReference ?? '')) {
    throw new WithdrawalError(422, 'WITHDRAWAL_REFERENCE_INVALID', '真实转账参考号格式无效。')
  }
  if (body.outcome === 'succeeded' && new Date(body.actualPayoutAt).getTime() > Date.now() + 60_000) {
    throw new WithdrawalError(422, 'WITHDRAWAL_TRANSFER_TIME_INVALID', '实际打款时间不能晚于当前时间。')
  }
  const payload = body.outcome === 'succeeded'
    ? { withdrawalId, attemptId, outcome: body.outcome, providerReference: normalizedReference,
        actualPayoutAmount: normalizedAmount, actualPayoutAt: body.actualPayoutAt, evidenceSha256: body.evidenceSha256, evidenceSummary }
    : body.outcome === 'failed'
      ? { withdrawalId, attemptId, outcome: body.outcome, confirmedNoTransfer: body.confirmedNoTransfer,
          evidenceSha256: body.evidenceSha256, evidenceSummary }
      : { withdrawalId, attemptId, outcome: body.outcome, evidenceSha256: body.evidenceSha256, evidenceSummary }
  const hash = requestHash(payload)
  return db.transaction().execute(async (trx) => {
    await setActor(trx, { type: 'admin', id: adminId })
    const withdrawal = await lockWithdrawalContext(trx, withdrawalId)
    if (await actionReplay(trx, withdrawalId, body.idempotencyKey, action, hash)) return true
    const attempt = await trx.selectFrom('withdrawal_payout_attempts').selectAll()
      .where('id', '=', attemptId).where('withdrawal_id', '=', withdrawalId).forUpdate().executeTakeFirst()
    if (!attempt) throw new WithdrawalError(404, 'WITHDRAWAL_ATTEMPT_NOT_FOUND', '打款操作不存在。')
    if (body.outcome === 'unknown') {
      if (attempt.status !== 'started') {
        throw new WithdrawalError(409, 'WITHDRAWAL_ATTEMPT_ALREADY_RESOLVED', '只有处理中操作可以首次标记为结果未知。')
      }
      await trx.updateTable('withdrawal_payout_attempts').set({ status: 'unknown' })
        .where('id', '=', attemptId).where('status', '=', 'started').execute()
      await appendActionEvent(trx, {
        withdrawalId, action, actor: { type: 'admin', id: adminId },
        idempotencyKey: body.idempotencyKey, hash,
        previousStatus: withdrawal.status, nextStatus: 'transfer_uncertain',
        details: { attemptId, evidenceSha256: body.evidenceSha256, evidenceSummary },
      })
      return false
    }
    if (!['started', 'unknown'].includes(attempt.status)) {
      throw new WithdrawalError(409, 'WITHDRAWAL_ATTEMPT_ALREADY_RESOLVED', '该打款操作已经记录最终结果。')
    }
    if (body.outcome === 'succeeded' && normalizedAmount !== settleAmount(withdrawal.payout_amount)) {
      throw new WithdrawalError(422, 'WITHDRAWAL_PAYOUT_AMOUNT_MISMATCH', '实际打款金额必须与提现申请的预计到账金额完全一致；如已发生不同金额转账，请保持结果未知并人工核对。')
    }
    await trx.insertInto('withdrawal_payout_results').values({
      attempt_id: attemptId,
      outcome: body.outcome,
      resolved_by_admin_id: adminId,
      provider_reference: body.outcome === 'succeeded' ? normalizedReference : null,
      actual_payout_amount: body.outcome === 'succeeded' ? normalizedAmount : null,
      actual_payout_at: body.outcome === 'succeeded' ? new Date(body.actualPayoutAt) : null,
      confirmed_no_transfer: body.outcome === 'failed',
      evidence_sha256: body.evidenceSha256,
      evidence_summary: evidenceSummary,
      result_sha256: hash,
    }).execute()
    await trx.updateTable('withdrawal_payout_attempts').set({
      status: body.outcome, resolved_by_admin_id: adminId, result_sha256: hash,
    }).where('id', '=', attemptId).where('status', 'in', ['started', 'unknown']).execute()
    await appendActionEvent(trx, {
      withdrawalId, action, actor: { type: 'admin', id: adminId },
      idempotencyKey: body.idempotencyKey, hash,
      previousStatus: withdrawal.status,
      nextStatus: body.outcome === 'succeeded' ? 'completed' : 'pending_transfer',
      details: {
        attemptId, outcome: body.outcome,
        ...(body.outcome === 'succeeded' ? { providerReference: normalizedReference, actualPayoutAmount: normalizedAmount } : { confirmedNoTransfer: true }),
        evidenceSha256: body.evidenceSha256,
      },
    })
    return false
  })
}

function maskValue(value: string | undefined): string {
  if (!value) return '未填写'
  if (value.length <= 4) return `${'*'.repeat(value.length)}`
  return `${value.slice(0, 1)}${'*'.repeat(Math.min(10, value.length - 4))}${value.slice(-4)}`
}

function maskedRecipient(method: WithdrawalPayoutMethod, recipient: Recipient): string {
  if (method === 'bank_card') return `${recipient.bankName ?? '银行卡'} · ${recipient.recipientName ?? '收款人'} · ${maskValue(recipient.cardNumber)}`
  const account = recipient.account ? maskValue(recipient.account) : ''
  return `${method === 'alipay' ? '支付宝' : '微信'} · ${account || (recipient.qrFileId ? '收款二维码' : '未填写')}`
}

async function buildAdminWithdrawalList(
  db: Kysely<Database>, query: AdminWithdrawalListQuery,
) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  let base = db.selectFrom('withdrawals as withdrawal')
    .innerJoin('customers as customer', 'customer.id', 'withdrawal.customer_id')
  if (query.status) base = base.where('withdrawal.status', '=', query.status as DbWithdrawalStatus)
  const countRow = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow()
  let rowsQuery = db.selectFrom('withdrawals as withdrawal')
    .innerJoin('customers as customer', 'customer.id', 'withdrawal.customer_id')
    .select([
      'withdrawal.id', 'withdrawal.customer_id', 'customer.username', 'customer.email',
      'withdrawal.amount', 'withdrawal.fee_amount', 'withdrawal.payout_amount', 'withdrawal.payout_method',
      'withdrawal.recipient_snapshot', 'withdrawal.status', 'withdrawal.created_at', 'withdrawal.updated_at',
    ])
  if (query.status) rowsQuery = rowsQuery.where('withdrawal.status', '=', query.status as DbWithdrawalStatus)
  const rows = await rowsQuery.orderBy('withdrawal.created_at', 'desc').orderBy('withdrawal.id', 'desc')
    .limit(pageSize).offset((page - 1) * pageSize).execute()
  const total = countRow.total
  return {
    items: rows.map((row) => ({
      id: row.id, customerId: row.customer_id,
      customerUsername: row.username, customerEmail: row.email,
      amount: settleAmount(row.amount), feeAmount: settleAmount(row.fee_amount), payoutAmount: settleAmount(row.payout_amount),
      payoutMethod: row.payout_method, maskedRecipient: maskedRecipient(row.payout_method, asRecipient(row.recipient_snapshot)),
      status: row.status as WithdrawalStatus, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    })),
    total, page, pageSize, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

async function buildAdminWithdrawalDetail(db: Kysely<Database>, withdrawalId: string): Promise<AdminWithdrawalDetail> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('withdrawals as withdrawal')
      .innerJoin('customers as customer', 'customer.id', 'withdrawal.customer_id')
      .innerJoin('wallet_accounts as wallet', 'wallet.customer_id', 'withdrawal.customer_id')
      .select([
        'withdrawal.id', 'withdrawal.customer_id', 'withdrawal.amount', 'withdrawal.fee_amount', 'withdrawal.payout_amount',
        'withdrawal.payout_method', 'withdrawal.recipient_snapshot', 'withdrawal.status', 'withdrawal.rejection_reason',
        'withdrawal.reviewed_by_admin_id', 'withdrawal.reviewed_at', 'withdrawal.created_at', 'withdrawal.updated_at',
        'customer.username', 'customer.email', 'customer.phone', 'customer.status as customer_status',
        'wallet.cash_available', 'wallet.cash_frozen', 'wallet.gift_available', 'wallet.gift_frozen',
      ]).where('withdrawal.id', '=', withdrawalId).executeTakeFirst()
    if (!row) throw new WithdrawalError(404, 'WITHDRAWAL_NOT_FOUND', '提现申请不存在。')
    const ledger = await trx.selectFrom('wallet_ledger_entries as entry')
      .innerJoin('wallet_operations as operation', 'operation.id', 'entry.wallet_operation_id')
      .select([
        'entry.id', 'entry.wallet_operation_id', 'operation.operation_type', 'entry.action', 'entry.amount', 'entry.created_at',
      ]).where('entry.withdrawal_id', '=', withdrawalId).orderBy('entry.created_at').orderBy('entry.id').execute()
    const historyRows = await trx.selectFrom('withdrawals').select([
      'id', 'amount', 'fee_amount', 'payout_amount', 'status', 'created_at',
    ]).where('customer_id', '=', row.customer_id).orderBy('created_at', 'desc').orderBy('id', 'desc').execute()
    const events = await trx.selectFrom('withdrawal_audit_events as event')
      .leftJoin('admin_users as admin', 'admin.id', 'event.actor_admin_id')
      .select([
        'event.id', 'event.action', 'event.actor_type', 'event.actor_customer_id', 'event.actor_admin_id',
        'event.idempotency_key', 'event.previous_status', 'event.next_status', 'event.details', 'event.created_at',
        'admin.email as admin_email',
      ]).where('event.withdrawal_id', '=', withdrawalId).orderBy('event.created_at').orderBy('event.id').execute()
    return {
      id: row.id,
      customer: { id: row.customer_id, username: row.username, email: row.email, phone: row.phone, status: row.customer_status },
      amount: settleAmount(row.amount), feeAmount: settleAmount(row.fee_amount), payoutAmount: settleAmount(row.payout_amount),
      payoutMethod: row.payout_method, recipient: asRecipient(row.recipient_snapshot),
      status: row.status as WithdrawalStatus, rejectionReason: row.rejection_reason,
      reviewedByAdminId: row.reviewed_by_admin_id, reviewedAt: row.reviewed_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      wallet: {
        cashAvailable: settleAmount(row.cash_available), cashFrozen: settleAmount(row.cash_frozen),
        giftAvailable: settleAmount(row.gift_available), giftFrozen: settleAmount(row.gift_frozen),
      },
      ledgerEntries: ledger.map(entry => ({
        id: entry.id, operationId: entry.wallet_operation_id, operationType: entry.operation_type,
        action: entry.action as 'freeze' | 'unfreeze' | 'debit_frozen',
        amount: settleAmount(entry.amount), createdAt: entry.created_at.toISOString(),
      })),
      payoutAttempts: await loadPayoutAttempts(trx, withdrawalId),
      customerHistory: historyRows.map(history => ({
        id: history.id, amount: settleAmount(history.amount), feeAmount: settleAmount(history.fee_amount),
        payoutAmount: settleAmount(history.payout_amount), status: history.status as WithdrawalStatus,
        createdAt: history.created_at.toISOString(),
      })),
      auditEvents: events.map(event => ({
        id: event.id, action: event.action, actorType: event.actor_type as 'customer' | 'admin' | 'system',
        actorId: event.actor_customer_id ?? event.actor_admin_id,
        idempotencyKey: event.idempotency_key, previousStatus: event.previous_status,
        nextStatus: event.next_status,
        details: event.actor_admin_id && event.admin_email
          ? { ...(event.details as Record<string, unknown>), administrator: event.admin_email }
          : event.details as Record<string, unknown>,
        createdAt: event.created_at.toISOString(),
      })),
    }
  })
}

function uploadLength(request: FastifyRequest): number {
  const contentLength = request.headers['content-length']
  if (typeof contentLength !== 'string' || !/^\d+$/u.test(contentLength)) {
    throw new WithdrawalError(411, 'WITHDRAWAL_UPLOAD_LENGTH_REQUIRED', '二维码上传必须包含有效的 Content-Length。')
  }
  const size = Number(contentLength)
  if (!Number.isSafeInteger(size) || size < 1) throw new WithdrawalError(400, 'WITHDRAWAL_UPLOAD_INVALID', '上传文件长度无效。')
  if (size > MAX_QR_REQUEST_BYTES) throw new WithdrawalError(413, 'WITHDRAWAL_QR_TOO_LARGE', '收款二维码不能超过5MB。')
  return size
}

async function readQrImage(request: FastifyRequest): Promise<{ bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  uploadLength(request)
  let result: { bytes: Buffer; declaredMime: string } | undefined
  for await (const part of request.parts({ limits: uploadLimits })) {
    if (part.type !== 'file' || part.fieldname !== 'file' || result) {
      if (part.type === 'file') await part.toBuffer()
      throw new WithdrawalError(400, 'WITHDRAWAL_QR_MULTIPART_INVALID', '请只上传一个收款二维码图片。')
    }
    const bytes = await part.toBuffer()
    if (part.file.truncated) throw new WithdrawalError(413, 'WITHDRAWAL_QR_TOO_LARGE', '收款二维码不能超过5MB。')
    result = { bytes, declaredMime: part.mimetype }
  }
  if (!result || result.bytes.length === 0) throw new WithdrawalError(400, 'WITHDRAWAL_QR_REQUIRED', '请选择收款二维码图片。')
  if (result.bytes.length > MAX_QR_BYTES) throw new WithdrawalError(413, 'WITHDRAWAL_QR_TOO_LARGE', '收款二维码不能超过5MB。')
  const declared = result.declaredMime.split(';', 1)[0]?.trim().toLowerCase()
  const expected = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' } as const
  if (!declared || !(declared in expected)) {
    throw new WithdrawalError(415, 'WITHDRAWAL_QR_FORMAT_UNSUPPORTED', '收款二维码只支持 JPEG、PNG 或 WebP。')
  }
  const options = { failOn: 'warning' as const, limitInputPixels: MAX_QR_PIXELS, pages: 1, animated: false }
  const metadata = await sharp(result.bytes, options)
    .metadata().catch(() => { throw new WithdrawalError(400, 'WITHDRAWAL_QR_INVALID', '收款二维码图片内容无法安全解码。') })
  if (metadata.format !== expected[declared as keyof typeof expected]) {
    throw new WithdrawalError(400, 'WITHDRAWAL_QR_MIME_MISMATCH', '图片内容与声明的文件格式不一致。')
  }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1
    || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_QR_PIXELS) {
    throw new WithdrawalError(400, 'WITHDRAWAL_QR_DIMENSIONS_INVALID', '收款二维码的格式或像素尺寸不受支持。')
  }
  await sharp(result.bytes, options).stats()
    .catch(() => { throw new WithdrawalError(400, 'WITHDRAWAL_QR_INVALID', '收款二维码图片像素数据无法安全解码。') })
  return { bytes: result.bytes, mimeType: declared as 'image/jpeg' | 'image/png' | 'image/webp' }
}

function sendPrivateImage(reply: FastifyReply, file: { mime_type: string; content: Buffer }) {
  reply.header('cache-control', 'private, no-store, max-age=0')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('content-disposition', 'inline; filename="withdrawal-qr"')
    .type(file.mime_type)
  return reply.send(file.content)
}

export async function registerWithdrawalRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): Promise<void> {
  const customerAuth = requireCustomer(db, config)
  const customerCsrf = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)
  const administrator = requireAdmin(db, config)
  const adminCsrf = verifyAdminCsrf(config)

  app.get('/api/v1/customer/wallet/withdrawals', {
    preHandler: customerAuth,
    schema: {
      tags: ['customer'], summary: 'Read the signed-in customer withdrawal policy, cash balance and history',
      querystring: CustomerWalletPageQuerySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerWithdrawalPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const query = request.query as { page?: number; pageSize?: number }
      const result = await buildCustomerWithdrawalPage(db, request.customer!, query.page ?? 1, query.pageSize ?? 10)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/wallet/withdrawals', {
    logLevel: 'silent', preHandler: [customerAuth, customerCsrf],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Create an idempotent cash-only withdrawal request and freeze its full amount',
      body: CreateWithdrawalBodySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerWithdrawalMutationSchema), 201: ApiSuccessSchemaOf(CustomerWithdrawalMutationSchema),
        401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const result = await createWithdrawal(db, request.customer!, request.body as CreateWithdrawalBody)
      const withdrawal = await loadCustomerWithdrawal(db, result.withdrawalId)
      reply.header('cache-control', 'no-store')
      return reply.code(result.repeated ? 200 : 201).send(success({ repeated: result.repeated, withdrawal }, request.id))
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/wallet/withdrawals/:id/cancel', {
    logLevel: 'silent', preHandler: [customerAuth, customerCsrf],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Cancel a withdrawal that is still pending administrator review',
      params: WithdrawalIdParamsSchema, body: AdminWithdrawalActionBodySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerWithdrawalMutationSchema), 401: ApiErrorSchema, 403: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const repeated = await cancelCustomerWithdrawal(db, request.customer!, id, request.body as AdminWithdrawalActionBody)
      const withdrawal = await loadCustomerWithdrawal(db, id)
      reply.header('cache-control', 'no-store')
      return success({ repeated, withdrawal }, request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  await app.register(async (scope) => {
    await scope.register(multipart, { limits: uploadLimits, throwFileSizeLimit: false })
    scope.post('/api/v1/customer/wallet/withdrawal-qr', {
      logLevel: 'silent', bodyLimit: MAX_QR_REQUEST_BYTES,
      preHandler: [customerAuth, customerCsrf],
      config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
      schema: {
        tags: ['customer'], summary: 'Upload a private recipient QR image for a withdrawal', consumes: ['multipart/form-data'],
        response: { 201: ApiSuccessSchemaOf(WithdrawalQrUploadSchema), 400: ApiErrorSchema, 401: ApiErrorSchema,
          403: ApiErrorSchema, 411: ApiErrorSchema, 413: ApiErrorSchema, 415: ApiErrorSchema, 429: ApiErrorSchema },
      },
    }, async (request, reply) => {
      try {
        const image = await readQrImage(request)
        const id = randomUUID()
        const sha256 = createHash('sha256').update(image.bytes).digest('hex')
        await db.transaction().execute(async (trx) => {
          await assertCustomerSession(trx, request.customer!)
          await trx.deleteFrom('withdrawal_private_files')
            .where('withdrawal_id', 'is', null)
            .where('created_at', '<', new Date(Date.now() - 24 * 60 * 60 * 1000))
            .execute()
          await trx.insertInto('withdrawal_private_files').values({
            id, customer_id: request.customer!.id, withdrawal_id: null, mime_type: image.mimeType,
            size_bytes: image.bytes.length, sha256, content: image.bytes,
          }).execute()
        })
        reply.header('cache-control', 'no-store')
        return reply.code(201).send(success({ id, mimeType: image.mimeType, sizeBytes: image.bytes.length, sha256 }, request.id))
      } catch (error) { return handleWithdrawalError(error, reply, request.id) }
    })
  })

  app.get('/api/v1/customer/wallet/withdrawal-qr/:id', {
    logLevel: 'silent', preHandler: customerAuth,
    schema: { tags: ['customer'], summary: 'Read a private withdrawal QR file owned by the signed-in customer', params: WithdrawalIdParamsSchema,
      response: { 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const file = await db.selectFrom('withdrawal_private_files').select(['mime_type', 'content'])
      .where('id', '=', id).where('customer_id', '=', request.customer!.id)
      .where((eb) => eb.or([
        eb('withdrawal_id', 'is not', null),
        eb('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ])).executeTakeFirst()
    if (!file) return reply.code(404).send(failure('WITHDRAWAL_QR_NOT_FOUND', '收款二维码不存在。', request.id))
    return sendPrivateImage(reply, file)
  })

  app.get('/api/v1/admin/withdrawals/settings', {
    preHandler: administrator,
    schema: { tags: ['admin'], summary: 'Read merchant withdrawal limits, fees and enabled payout methods',
      response: { 200: ApiSuccessSchemaOf(WithdrawalSettingsSchema), 401: ApiErrorSchema } },
  }, async (request, reply) => {
    const settings = toSettings(await currentSettings(db))
    reply.header('cache-control', 'no-store')
    return success(settings, request.id)
  })

  app.put('/api/v1/admin/withdrawals/settings', {
    preHandler: [administrator, adminCsrf],
    schema: { tags: ['admin'], summary: 'Update withdrawal availability, amount limits, fees and supported methods',
      body: UpdateWithdrawalSettingsBodySchema,
      response: { 200: ApiSuccessSchemaOf(WithdrawalSettingsSchema), 400: ApiErrorSchema, 401: ApiErrorSchema,
        403: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const body = request.body as UpdateWithdrawalSettingsBody
      const minAmount = normalizeWalletAmount(body.minAmount)
      const maxAmount = normalizeWalletAmount(body.maxAmount)
      const fixedFee = normalizeWalletAmount(body.fixedFee)
      const percentFee = normalizeWithdrawalPercent(body.percentFee)
      if (cents(minAmount) <= 0n || cents(maxAmount) < cents(minAmount)) {
        throw new WithdrawalError(422, 'WITHDRAWAL_SETTINGS_LIMITS_INVALID', '提现最低金额必须大于零，最高金额不能低于最低金额。')
      }
      if (body.enabled && body.methods.length === 0) {
        throw new WithdrawalError(422, 'WITHDRAWAL_SETTINGS_METHODS_REQUIRED', '开启提现时至少要启用一种收款方式。')
      }
      const nextMethods = methods.filter(method => body.methods.includes(method))
      const saved = await db.transaction().execute(async (trx) => {
        const current = await currentSettings(trx, 'update')
        const before = toSettings(current)
        const after = { enabled: body.enabled, minAmount, maxAmount, fixedFee, percentFee, methods: nextMethods }
        await trx.insertInto('withdrawal_settings_audit_events').values({
          id: randomUUID(), administrator_id: request.admin!.id,
          before_settings: { enabled: before.enabled, minAmount: before.minAmount, maxAmount: before.maxAmount,
            fixedFee: before.fixedFee, percentFee: before.percentFee, methods: before.methods },
          after_settings: after,
        }).execute()
        const updated = await trx.updateTable('storefront_customer_policy').set({
          withdrawal_enabled: body.enabled, withdrawal_min_amount: minAmount,
          withdrawal_max_amount: maxAmount, withdrawal_fixed_fee: fixedFee,
          withdrawal_percent_fee: percentFee, withdrawal_methods: nextMethods, updated_at: new Date(),
        }).where('singleton', '=', true).returning([
          'withdrawal_enabled', 'withdrawal_min_amount', 'withdrawal_max_amount',
          'withdrawal_fixed_fee', 'withdrawal_percent_fee', 'withdrawal_methods', 'updated_at',
        ]).executeTakeFirstOrThrow()
        return toSettings(updated)
      })
      reply.header('cache-control', 'no-store')
      return success(saved, request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.get('/api/v1/admin/withdrawals', {
    preHandler: administrator,
    schema: { tags: ['admin'], summary: 'List and filter withdrawal applications', querystring: AdminWithdrawalListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(AdminWithdrawalListSchema), 401: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const result = await buildAdminWithdrawalList(db, request.query as AdminWithdrawalListQuery)
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.get('/api/v1/admin/withdrawals/:id', {
    preHandler: administrator,
    schema: { tags: ['admin'], summary: 'Read a withdrawal, recipient details, frozen ledger and immutable audit history',
      params: WithdrawalIdParamsSchema, response: { 200: ApiSuccessSchemaOf(AdminWithdrawalDetailSchema), 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const detail = await buildAdminWithdrawalDetail(db, id)
      reply.header('cache-control', 'no-store')
      return success(detail, request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.get('/api/v1/admin/withdrawals/:id/recipient-qr', {
    logLevel: 'silent', preHandler: administrator,
    schema: { tags: ['admin'], summary: 'Read the private QR image for this authorized withdrawal', params: WithdrawalIdParamsSchema,
      response: { 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await db.selectFrom('withdrawals as withdrawal')
      .innerJoin('withdrawal_private_files as file', 'file.withdrawal_id', 'withdrawal.id')
      .select(['file.mime_type', 'file.content'])
      .where('withdrawal.id', '=', id)
      .where(sql<boolean>`withdrawal.recipient_snapshot->>'qrFileId' = file.id::text`)
      .executeTakeFirst()
    if (!result) return reply.code(404).send(failure('WITHDRAWAL_QR_NOT_FOUND', '收款二维码不存在。', request.id))
    return sendPrivateImage(reply, result)
  })

  app.post('/api/v1/admin/withdrawals/:id/approve', {
    logLevel: 'silent', preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Approve a withdrawal and retain the full cash freeze',
      params: WithdrawalIdParamsSchema, body: AdminWithdrawalActionBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminWithdrawalDetailSchema), 401: ApiErrorSchema, 403: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await adminReview(db, id, request.admin!.id, request.body as AdminWithdrawalActionBody, true)
      reply.header('cache-control', 'no-store')
      return success(await buildAdminWithdrawalDetail(db, id), request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/withdrawals/:id/reject', {
    logLevel: 'silent', preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Reject a pending withdrawal with an immutable reason and unfreeze the cash',
      params: WithdrawalIdParamsSchema, body: AdminWithdrawalRejectionBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminWithdrawalDetailSchema), 401: ApiErrorSchema, 403: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await adminReview(db, id, request.admin!.id, request.body as AdminWithdrawalRejectionBody, false)
      reply.header('cache-control', 'no-store')
      return success(await buildAdminWithdrawalDetail(db, id), request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/withdrawals/:id/payout-attempts', {
    logLevel: 'silent', preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Persist a manual payout operation before the administrator transfers money externally',
      params: WithdrawalIdParamsSchema, body: AdminWithdrawalActionBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminWithdrawalDetailSchema), 401: ApiErrorSchema, 403: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await startPayoutAttempt(db, id, request.admin!.id, request.body as AdminWithdrawalActionBody)
      reply.header('cache-control', 'no-store')
      return success(await buildAdminWithdrawalDetail(db, id), request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/withdrawals/:id/payout-attempts/:attemptId/resolve', {
    logLevel: 'silent', preHandler: [administrator, adminCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Record a confirmed manual transfer result or keep it frozen as unknown',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, attemptId: { type: 'string', format: 'uuid' } }, required: ['id', 'attemptId'], additionalProperties: false },
      body: AdminWithdrawalResolveBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminWithdrawalDetailSchema), 401: ApiErrorSchema, 403: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema, 429: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id, attemptId } = request.params as { id: string; attemptId: string }
      await resolvePayoutAttempt(db, id, attemptId, request.admin!.id, request.body as AdminWithdrawalResolveBody)
      reply.header('cache-control', 'no-store')
      return success(await buildAdminWithdrawalDetail(db, id), request.id)
    } catch (error) { return handleWithdrawalError(error, reply, request.id) }
  })
}
