import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import {
  AdminCustomerAuditPageSchema,
  AdminCustomerDeleteResultSchema,
  AdminCustomerDetailSchema,
  AdminCustomerIdParamsSchema,
  AdminCustomerListQuerySchema,
  AdminCustomerListSchema,
  AdminCustomerOrderPageSchema,
  AdminCustomerOrdersQuerySchema,
  AdminCustomerPasswordResetBodySchema,
  AdminCustomerPasswordResetResultSchema,
  AdminCustomerProfileUpdateBodySchema,
  AdminCustomerStatusBodySchema,
  AdminCustomerStatusResultSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  AdminCustomerAuditEvent,
  AdminCustomerDetail,
  AdminCustomerList,
  AdminCustomerListQuery,
  AdminCustomerOrderPage,
  AdminCustomerOrdersQuery,
  AdminCustomerPasswordResetBody,
  AdminCustomerProfileUpdateBody,
  AdminCustomerStatusBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { hashPassword } from '../auth/password.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'

class CustomerManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CustomerManagementError'
  }
}

function postgresConstraint(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (typeof candidate.constraint === 'string') return candidate.constraint
    current = candidate.cause
  }
  return undefined
}

function sendError(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof CustomerManagementError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (postgresConstraint(error) === 'customers_username_lower_unique') {
    return reply.code(409).send(failure('USERNAME_TAKEN', '该用户名已被其他顾客使用。', requestId))
  }
  throw error
}

function normalizeEmail(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized || null
}

function normalizePhone(value: string | null): string | null {
  const normalized = value?.trim().replace(/[ ()-]/g, '') ?? ''
  return normalized || null
}

function safeLikePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, character => `\\${character}`)}%`
}

function pageValues(query: { page?: number; pageSize?: number }) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function customerQueryFilter(query: AdminCustomerListQuery) {
  const statusFilter = query.status === 'active'
    ? sql<boolean>`c.status = 'active'`
    : query.status === 'disabled'
      ? sql<boolean>`c.status = 'disabled'`
      : query.status === 'deleted'
        ? sql<boolean>`c.status = 'deleted'`
        : sql<boolean>`c.status IN ('active', 'disabled')`
  const search = query.search?.trim()
  if (!search) return sql<boolean>`(${statusFilter})`

  const usernamePattern = safeLikePrefix(search.toLowerCase())
  const phoneTerm = normalizePhone(search)
  const searchConditions = [
    sql<boolean>`lower(c.username) LIKE ${usernamePattern}`,
    sql<boolean>`lower(c.email) LIKE ${usernamePattern}`,
  ]
  if (phoneTerm) searchConditions.push(sql<boolean>`c.phone LIKE ${safeLikePrefix(phoneTerm)}`)
  return sql<boolean>`(${statusFilter}) AND (${sql.join(searchConditions, sql` OR `)})`
}

async function writeAudit(
  trx: Transaction<Database>,
  administratorId: string,
  customerId: string,
  action: 'username_updated' | 'contact_updated' | 'password_reset' | 'disabled' | 'restored' | 'deleted',
  summary: Record<string, unknown>,
): Promise<void> {
  await trx.insertInto('customer_management_audit').values({
    id: randomUUID(),
    administrator_id: administratorId,
    customer_id: customerId,
    action,
    summary,
  }).execute()
}

async function revokeCustomerSessions(trx: Transaction<Database>, customerId: string): Promise<number> {
  const revoked = await trx.updateTable('customer_sessions')
    .set({ revoked_at: new Date() })
    .where('customer_id', '=', customerId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute()
  return revoked.length
}

export function registerAdminCustomerRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/customers', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'customers'],
      summary: 'List customers with server-side search and pagination',
      querystring: AdminCustomerListQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerListSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
      },
    },
  }, async (request) => {
    const query = request.query as AdminCustomerListQuery
    const { page, pageSize, offset } = pageValues(query)
    const filter = customerQueryFilter(query)
    const countResult = await sql<{ total: string }>`
      SELECT count(*)::text AS total
      FROM customers AS c
      WHERE ${filter}
    `.execute(db)
    const total = Number(countResult.rows[0]?.total ?? 0)
    const direction = sql.raw(query.sortOrder === 'asc' ? 'ASC' : 'DESC')
    const rows = await sql<{
      id: string
      username: string | null
      email: string | null
      phone: string | null
      status: 'active' | 'disabled' | 'deleted'
      created_at: Date
      updated_at: Date
    }>`
      SELECT c.id, c.username, c.email, c.phone, c.status, c.created_at, c.updated_at
      FROM customers AS c
      WHERE ${filter}
      ORDER BY c.created_at ${direction}, c.id ${direction}
      LIMIT ${pageSize} OFFSET ${offset}
    `.execute(db)

    const result: AdminCustomerList = {
      items: rows.rows.map(row => ({
        id: row.id,
        username: row.username,
        email: row.email,
        phone: row.phone,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
    return success(result, request.id)
  })

  app.get('/api/v1/admin/customers/:id', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'customers'],
      summary: 'Read customer profile without credential or session secrets',
      params: AdminCustomerIdParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerDetailSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = await db.selectFrom('customers')
      .select(['id', 'username', 'email', 'email_verified_at', 'phone', 'phone_verified_at', 'status', 'created_at', 'updated_at'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return reply.code(404).send(failure('CUSTOMER_NOT_FOUND', '顾客不存在。', request.id))

    const result: AdminCustomerDetail = {
      customer: {
        id: row.id,
        username: row.username,
        email: row.email,
        phone: row.phone,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
        phoneVerifiedAt: row.phone_verified_at?.toISOString() ?? null,
      },
    }
    return success(result, request.id)
  })

  app.get('/api/v1/admin/customers/:id/orders', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'customers'],
      summary: 'List a customer’s historical orders without mutation controls',
      params: AdminCustomerIdParamsSchema,
      querystring: AdminCustomerOrdersQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerOrderPageSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as AdminCustomerOrdersQuery
    const { page, pageSize, offset } = pageValues(query)
    const exists = await db.selectFrom('customers').select('id').where('id', '=', id).executeTakeFirst()
    if (!exists) return reply.code(404).send(failure('CUSTOMER_NOT_FOUND', '顾客不存在。', request.id))

    const countResult = await sql<{ total: string }>`
      SELECT count(*)::text AS total FROM orders WHERE customer_id = ${id}
    `.execute(db)
    const total = Number(countResult.rows[0]?.total ?? 0)
    const rows = await sql<{
      id: string
      status: 'pending_payment' | 'processing' | 'completed' | 'closed'
      customer_status: string
      payment_status: string
      refund_status: string
      total_amount: string
      currency: 'CNY'
      created_at: Date
    }>`
      SELECT o.id, o.status, customer_order_status.customer_status,
        order_financial_status.payment_status, order_financial_status.refund_status,
        o.total_amount::text AS total_amount, o.currency, o.created_at
      FROM orders AS o
      JOIN customer_order_status ON customer_order_status.order_id = o.id
      JOIN order_financial_status ON order_financial_status.order_id = o.id
      WHERE o.customer_id = ${id}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `.execute(db)

    const result: AdminCustomerOrderPage = {
      items: rows.rows.map(row => ({
        id: row.id,
        status: row.status,
        customerStatus: row.customer_status as AdminCustomerOrderPage['items'][number]['customerStatus'],
        paymentStatus: row.payment_status as AdminCustomerOrderPage['items'][number]['paymentStatus'],
        refundStatus: row.refund_status as AdminCustomerOrderPage['items'][number]['refundStatus'],
        totalAmount: row.total_amount,
        currency: row.currency,
        createdAt: row.created_at.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
    return success(result, request.id)
  })

  app.get('/api/v1/admin/customers/:id/audit', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'customers'],
      summary: 'Read immutable customer management audit events',
      params: AdminCustomerIdParamsSchema,
      querystring: AdminCustomerOrdersQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerAuditPageSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as AdminCustomerOrdersQuery
    const { page, pageSize, offset } = pageValues(query)
    const exists = await db.selectFrom('customers').select('id').where('id', '=', id).executeTakeFirst()
    if (!exists) return reply.code(404).send(failure('CUSTOMER_NOT_FOUND', '顾客不存在。', request.id))

    const countResult = await db.selectFrom('customer_management_audit').select(eb => eb.fn.countAll<number>().as('total'))
      .where('customer_id', '=', id).executeTakeFirstOrThrow()
    const rows = await db.selectFrom('customer_management_audit')
      .innerJoin('admin_users', 'admin_users.id', 'customer_management_audit.administrator_id')
      .select([
        'customer_management_audit.id',
        'customer_management_audit.administrator_id as administrator_id',
        'admin_users.email as administrator_email',
        'customer_management_audit.customer_id',
        'customer_management_audit.action',
        'customer_management_audit.summary',
        'customer_management_audit.created_at',
      ])
      .where('customer_management_audit.customer_id', '=', id)
      .orderBy('customer_management_audit.created_at', 'desc')
      .orderBy('customer_management_audit.id', 'desc')
      .limit(pageSize).offset(offset).execute()
    const events: AdminCustomerAuditEvent[] = rows.map(row => ({
      id: row.id,
      administratorId: row.administrator_id,
      administratorEmail: row.administrator_email,
      customerId: row.customer_id,
      action: row.action,
      summary: row.summary,
      createdAt: row.created_at.toISOString(),
    }))
    const total = Number(countResult.total)
    return success({ items: events, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }, request.id)
  })

  app.patch('/api/v1/admin/customers/:id/profile', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'customers'],
      summary: 'Update a customer username and contact details',
      params: AdminCustomerIdParamsSchema,
      body: AdminCustomerProfileUpdateBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerDetailSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as AdminCustomerProfileUpdateBody
    try {
      const detail = await db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('customers')
          .select(['id', 'username', 'email', 'email_verified_at', 'phone', 'phone_verified_at', 'status', 'created_at', 'updated_at'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!current) throw new CustomerManagementError(404, 'CUSTOMER_NOT_FOUND', '顾客不存在。')
        if (current.status === 'deleted') {
          throw new CustomerManagementError(409, 'CUSTOMER_DELETED', '已删除顾客的身份资料不能恢复或修改。')
        }

        const values: {
          username?: string
          email?: string | null
          phone?: string | null
          updated_at?: Date
        } = {}
        const changedFields: string[] = []
        if (body.username !== undefined && body.username !== current.username) {
          values.username = body.username
          changedFields.push('username')
        }
        if (Object.hasOwn(body, 'email')) {
          const email = normalizeEmail(body.email ?? null)
          if (email !== current.email) {
            values.email = email
            changedFields.push('email')
          }
        }
        if (Object.hasOwn(body, 'phone')) {
          const phone = normalizePhone(body.phone ?? null)
          if (phone !== current.phone) {
            values.phone = phone
            changedFields.push('phone')
          }
        }
        if (changedFields.length === 0) return current

        values.updated_at = new Date()
        const updated = await trx.updateTable('customers').set(values).where('id', '=', id)
          .returning(['id', 'username', 'email', 'email_verified_at', 'phone', 'phone_verified_at', 'status', 'created_at', 'updated_at'])
          .executeTakeFirstOrThrow()
        if (changedFields.includes('username')) {
          await writeAudit(trx, request.admin!.id, id, 'username_updated', { changedFields: ['username'] })
        }
        const contactFields = changedFields.filter(field => field === 'email' || field === 'phone')
        if (contactFields.length) {
          await writeAudit(trx, request.admin!.id, id, 'contact_updated', { changedFields: contactFields })
        }
        return updated
      })
      return success({
        customer: {
          id: detail.id,
          username: detail.username,
          email: detail.email,
          phone: detail.phone,
          status: detail.status,
          createdAt: detail.created_at.toISOString(),
          updatedAt: detail.updated_at.toISOString(),
          emailVerifiedAt: detail.email_verified_at?.toISOString() ?? null,
          phoneVerifiedAt: detail.phone_verified_at?.toISOString() ?? null,
        },
      }, request.id)
    } catch (error) {
      return sendError(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/customers/:id/password-reset', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'customers'],
      summary: 'Set a temporary customer password and revoke every prior session',
      params: AdminCustomerIdParamsSchema,
      body: AdminCustomerPasswordResetBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerPasswordResetResultSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as AdminCustomerPasswordResetBody
    const passwordHash = await hashPassword(body.temporaryPassword)
    try {
      const revokedSessionCount = await db.transaction().execute(async (trx) => {
        const customer = await trx.selectFrom('customers').select(['id', 'status'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!customer) throw new CustomerManagementError(404, 'CUSTOMER_NOT_FOUND', '顾客不存在。')
        if (customer.status === 'deleted') {
          throw new CustomerManagementError(409, 'CUSTOMER_DELETED', '已删除顾客不能重置密码。')
        }
        const revoked = await revokeCustomerSessions(trx, id)
        await trx.updateTable('customers').set({ password_hash: passwordHash, updated_at: new Date() })
          .where('id', '=', id).execute()
        await writeAudit(trx, request.admin!.id, id, 'password_reset', { revokedSessionCount: revoked })
        return revoked
      })
      return success({ passwordReset: true, revokedSessionCount }, request.id)
    } catch (error) {
      return sendError(reply, error, request.id)
    }
  })

  app.patch('/api/v1/admin/customers/:id/status', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'customers'],
      summary: 'Disable or restore a customer account',
      params: AdminCustomerIdParamsSchema,
      body: AdminCustomerStatusBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerStatusResultSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as AdminCustomerStatusBody
    try {
      const updated = await db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('customers').select(['id', 'status', 'updated_at'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!current) throw new CustomerManagementError(404, 'CUSTOMER_NOT_FOUND', '顾客不存在。')
        if (current.status === 'deleted') {
          throw new CustomerManagementError(409, 'CUSTOMER_DELETED', '已删除顾客不能恢复或更改状态。')
        }

        let revokedSessionCount = 0
        if (body.status === 'disabled') revokedSessionCount = await revokeCustomerSessions(trx, id)
        if (body.status !== current.status) {
          const row = await trx.updateTable('customers').set({ status: body.status, updated_at: new Date() })
            .where('id', '=', id).returning(['id', 'status', 'updated_at']).executeTakeFirstOrThrow()
          await writeAudit(trx, request.admin!.id, id, body.status === 'disabled' ? 'disabled' : 'restored', {
            previousStatus: current.status,
            newStatus: body.status,
            ...(body.status === 'disabled' ? { revokedSessionCount } : {}),
          })
          return row
        }
        if (revokedSessionCount > 0) {
          await writeAudit(trx, request.admin!.id, id, 'disabled', {
            previousStatus: current.status,
            newStatus: current.status,
            revokedSessionCount,
          })
        }
        return { id: current.id, status: current.status, updated_at: current.updated_at }
      })
      return success({ id: updated.id, status: updated.status, updatedAt: updated.updated_at.toISOString() }, request.id)
    } catch (error) {
      return sendError(reply, error, request.id)
    }
  })

  app.delete('/api/v1/admin/customers/:id', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'customers'],
      summary: 'Anonymize a customer only after all current transaction obligations are settled',
      params: AdminCustomerIdParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(AdminCustomerDeleteResultSchema),
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await db.transaction().execute(async (trx) => {
        const customer = await trx.selectFrom('customers')
          .select(['id', 'status'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!customer) throw new CustomerManagementError(404, 'CUSTOMER_NOT_FOUND', '顾客不存在。')
        if (customer.status === 'deleted') return

        // Trade and refund transitions lock orders before touching wallet rows.
        await trx.selectFrom('orders').select('id')
          .where('customer_id', '=', id)
          .orderBy('id')
          .forUpdate()
          .execute()

        const unfinishedOrder = await trx.selectFrom('orders').select('id')
          .where('customer_id', '=', id).where('status', 'in', ['pending_payment', 'processing'])
          .executeTakeFirst()
        if (unfinishedOrder) {
          throw new CustomerManagementError(409, 'CUSTOMER_HAS_UNFINISHED_ORDERS', '账户存在未完成订单，不能删除。')
        }

        const unsettledPayment = await sql<{ id: string }>`
          SELECT obligation.id
          FROM (
            SELECT attempt.id
            FROM payment_attempts AS attempt
            LEFT JOIN orders AS order_row ON order_row.id = attempt.order_id
            WHERE (attempt.topup_customer_id = ${id} OR order_row.customer_id = ${id})
              AND (
                attempt.status IN ('created', 'pending')
                OR (attempt.status = 'reconciliation_required' AND EXISTS (
                  SELECT 1 FROM payment_receipts AS receipt
                  WHERE receipt.payment_attempt_id = attempt.id
                    AND receipt.disposition IN ('late', 'excess', 'amount_mismatch')
                    AND receipt.refunded_amount < receipt.amount
                ))
              )
            UNION ALL
            SELECT receipt.id
            FROM payment_receipts AS receipt
            JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
            LEFT JOIN orders AS order_row ON order_row.id = attempt.order_id
            WHERE (attempt.topup_customer_id = ${id} OR order_row.customer_id = ${id})
              AND receipt.disposition IN ('late', 'excess', 'amount_mismatch')
              AND receipt.refunded_amount < receipt.amount
            UNION ALL
            SELECT financial.order_id AS id
            FROM order_financial_status AS financial
            JOIN orders AS order_row ON order_row.id = financial.order_id
            WHERE order_row.customer_id = ${id}
              AND (
                financial.payment_status IN ('late_paid', 'requires_reconciliation', 'overpaid', 'partially_paid')
                OR (order_row.status = 'closed' AND financial.payment_status IN ('paid', 'partially_refunded'))
              )
          ) AS obligation
          LIMIT 1
        `.execute(trx)
        if (unsettledPayment.rows.length) {
          throw new CustomerManagementError(409, 'CUSTOMER_HAS_PENDING_PAYMENT', '账户存在未结清支付或资金对账，不能删除。')
        }

        const pendingRefund = await sql<{ id: string }>`
          SELECT refund.id
          FROM order_refunds AS refund
          JOIN orders AS order_row ON order_row.id = refund.order_id
          WHERE order_row.customer_id = ${id}
            AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded')
          UNION ALL
          SELECT allocation.id
          FROM order_refund_allocations AS allocation
          JOIN order_refunds AS refund ON refund.id = allocation.refund_id
          JOIN orders AS order_row ON order_row.id = refund.order_id
          WHERE order_row.customer_id = ${id} AND allocation.status = 'reserved'
          UNION ALL
          SELECT receipt.id
          FROM payment_receipts AS receipt
          JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
          JOIN orders AS order_row ON order_row.id = attempt.order_id
          WHERE order_row.customer_id = ${id} AND receipt.refund_reserved_amount > 0
          LIMIT 1
        `.execute(trx)
        if (pendingRefund.rows.length) {
          throw new CustomerManagementError(409, 'CUSTOMER_HAS_PENDING_REFUND', '账户存在待处理退款，不能删除。')
        }

        const pendingWithdrawal = await sql<{ id: string }>`
          SELECT withdrawal.id
          FROM withdrawals AS withdrawal
          WHERE withdrawal.customer_id = ${id}
            AND withdrawal.status IN ('pending_review', 'pending_transfer', 'transfer_processing', 'transfer_uncertain')
          UNION ALL
          SELECT attempt.id
          FROM withdrawal_payout_attempts AS attempt
          JOIN withdrawals AS withdrawal ON withdrawal.id = attempt.withdrawal_id
          WHERE withdrawal.customer_id = ${id} AND attempt.status IN ('started', 'unknown')
          LIMIT 1
        `.execute(trx)
        if (pendingWithdrawal.rows.length) {
          throw new CustomerManagementError(409, 'CUSTOMER_HAS_PENDING_WITHDRAWAL', '账户存在待处理提现或打款，不能删除。')
        }

        const wallet = await trx.selectFrom('wallet_accounts')
          .select(['cash_available', 'cash_frozen', 'gift_available', 'gift_frozen'])
          .where('customer_id', '=', id).forUpdate().executeTakeFirst()
        if (!wallet) throw new Error('A customer wallet account is missing')

        if ([wallet.cash_available, wallet.cash_frozen, wallet.gift_available, wallet.gift_frozen]
          .some(amount => amount !== '0.00' && amount !== '0')) {
          throw new CustomerManagementError(409, 'CUSTOMER_HAS_WALLET_BALANCE', '账户仍有可用或冻结余额，不能删除。')
        }

        const pendingFulfillment = await sql<{ id: string }>`
          SELECT attempt.id
          FROM order_item_fulfillment_attempts AS attempt
          JOIN order_items AS item ON item.id = attempt.order_item_id
          JOIN orders AS order_row ON order_row.id = item.order_id
          WHERE order_row.customer_id = ${id} AND attempt.status IN ('processing', 'unknown')
          UNION ALL
          SELECT item.id
          FROM order_items AS item
          JOIN orders AS order_row ON order_row.id = item.order_id
          WHERE order_row.customer_id = ${id}
            AND (item.fulfillment_reserved_quantity > 0 OR item.fulfillment_status IN ('processing', 'unknown'))
          LIMIT 1
        `.execute(trx)
        if (pendingFulfillment.rows.length) {
          throw new CustomerManagementError(409, 'CUSTOMER_HAS_UNRESOLVED_FULFILLMENT', '账户存在尚未完成的履约义务，不能删除。')
        }

        const revokedSessionCount = await revokeCustomerSessions(trx, id)
        await trx.updateTable('customers').set({
          status: 'deleted',
          username: null,
          password_hash: null,
          email: null,
          email_verified_at: null,
          phone: null,
          phone_verified_at: null,
          updated_at: new Date(),
        }).where('id', '=', id).execute()
        await writeAudit(trx, request.admin!.id, id, 'deleted', {
          clearedFields: ['username', 'password_hash', 'email', 'phone', 'email_verified_at', 'phone_verified_at'],
          revokedSessionCount,
        })
      })
      return success({ id, deleted: true }, request.id)
    } catch (error) {
      return sendError(reply, error, request.id)
    }
  })
}
