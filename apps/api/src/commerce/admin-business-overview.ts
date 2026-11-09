import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import {
  AdminBusinessOverviewSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  failure,
  success,
} from '@aikayun/contracts'
import type { AdminBusinessOverview } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin } from '../auth/admin.js'
import type { Database } from '../db/types.js'

interface BusinessOverviewRow {
  today_new_orders: string
  pending_payment_orders: string
  processing_orders: string
  completed_orders: string
  today_confirmed_order_payment_amount: string
  period_start: Date
  period_end: Date
  measured_at: Date
}

function safeCount(value: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Business overview count is outside the supported range')
  return count
}

export async function readAdminBusinessOverview(db: Kysely<Database>): Promise<AdminBusinessOverview> {
  const result = await sql<BusinessOverviewRow>`
    WITH clock AS (
      SELECT statement_timestamp() AS measured_at
    ), beijing_day AS (
      SELECT measured_at,
        date_trunc('day', measured_at AT TIME ZONE 'Asia/Shanghai') AS local_day_start
      FROM clock
    ), period AS (
      SELECT measured_at,
        local_day_start AT TIME ZONE 'Asia/Shanghai' AS period_start,
        (local_day_start + interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS period_end
      FROM beijing_day
    ), order_totals AS (
      SELECT
        count(*) FILTER (WHERE order_row.created_at >= period.period_start AND order_row.created_at < period.period_end)::text AS today_new_orders,
        count(*) FILTER (WHERE order_row.status = 'pending_payment')::text AS pending_payment_orders,
        count(*) FILTER (WHERE order_row.status = 'processing')::text AS processing_orders,
        count(*) FILTER (WHERE order_row.status = 'completed')::text AS completed_orders
      FROM orders AS order_row
      CROSS JOIN period
    ), payment_totals AS (
      SELECT coalesce(sum(receipt.amount) FILTER (
        WHERE receipt.received_at >= period.period_start AND receipt.received_at < period.period_end
      ), 0.00::numeric)::text AS today_confirmed_order_payment_amount
      FROM payment_attempts AS attempt
      JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = attempt.id
      CROSS JOIN period
      WHERE attempt.order_id IS NOT NULL
        AND attempt.topup_customer_id IS NULL
        AND attempt.status = 'succeeded'
        AND receipt.disposition = 'on_time'
        AND NOT EXISTS (
          SELECT 1 FROM payment_provider_reconciliation_cases AS reconciliation
          WHERE reconciliation.payment_attempt_id = attempt.id AND reconciliation.state = 'open'
        )
    )
    SELECT order_totals.today_new_orders,
      order_totals.pending_payment_orders,
      order_totals.processing_orders,
      order_totals.completed_orders,
      payment_totals.today_confirmed_order_payment_amount,
      period.period_start,
      period.period_end,
      period.measured_at
    FROM period
    CROSS JOIN order_totals
    CROSS JOIN payment_totals
  `.execute(db)

  const row = result.rows[0]
  if (!row) throw new Error('Business overview query returned no result')

  return {
    todayNewOrders: safeCount(row.today_new_orders),
    pendingPaymentOrders: safeCount(row.pending_payment_orders),
    processingOrders: safeCount(row.processing_orders),
    completedOrders: safeCount(row.completed_orders),
    todayConfirmedOrderPaymentAmount: row.today_confirmed_order_payment_amount,
    currency: 'CNY',
    paymentRule: 'succeeded_on_time_order_receipts_excluding_open_reconciliation',
    paymentTimeBasis: 'payment_receipts.received_at',
    includedPaymentSources: ['external', 'cash', 'gift'],
    refundsDeducted: false,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    measuredAt: row.measured_at.toISOString(),
  }
}

export function registerAdminBusinessOverviewRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
): void {
  app.get('/api/v1/admin/business-overview', {
    preHandler: requireAdmin(db, config),
    schema: {
      tags: ['admin'],
      summary: 'Read the administrator business overview',
      response: {
        200: ApiSuccessSchemaOf(AdminBusinessOverviewSchema),
        401: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      return success(await readAdminBusinessOverview(db), request.id)
    } catch {
      request.log.error({ event: 'admin_business_overview_read_failed' }, 'Unable to read business overview')
      return reply.code(503).send(failure(
        'BUSINESS_OVERVIEW_UNAVAILABLE',
        '经营数据暂时无法读取，请稍后重试。',
        request.id,
      ))
    }
  })
}
