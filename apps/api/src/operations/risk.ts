import { sql, type Kysely } from 'kysely'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { requireAdmin } from '../auth/admin.js'
import { failure, success } from '@aikayun/contracts'

/** Coalesce polling and bound each caller, including pool acquisition. An in-flight
 * read remains the sole read after timeout until it settles; failed reads never
 * replace unknown with stale cached data. */
export function boundedCachedRead<T>(read: () => Promise<T>, cacheMs = 30_000, timeoutMs = 7_000): () => Promise<T> {
  let inFlight: Promise<T> | undefined
  let cached: { value: T; expires: number } | undefined
  return async () => {
    if (cached && performance.now() < cached.expires) return cached.value
    if (!inFlight) {
      inFlight = read().then(value => {
        cached = { value, expires: performance.now() + cacheMs }
        return value
      }).finally(() => { inFlight = undefined })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([inFlight, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operations_timeout')), timeoutMs)
        timer.unref()
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
}

interface Aggregate { kind: string; count: string; oldest: Date | null }

/** Read-only, bounded aggregate of existing business state. No customer or provider data is returned. */
export async function readOperationsRisk(db: Kysely<Database>) {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
    const result = await sql<Aggregate>`
      WITH incidents AS (
        SELECT CASE WHEN state.state = 'requesting' THEN 'payment_requesting' ELSE 'payment_unknown' END AS kind,
          state.request_started_at AS since FROM payment_attempt_provider_state state
          JOIN payment_attempts payment ON payment.id = state.payment_attempt_id
          WHERE state.state IN ('requesting', 'unknown') AND payment.status IN ('created', 'pending')
            AND state.request_started_at <= clock_timestamp() - interval '10 minutes'
        UNION ALL SELECT 'reconciliation', opened_at FROM payment_provider_reconciliation_cases WHERE state = 'open'
        UNION ALL SELECT 'orphan_hold', CASE WHEN payment.status = 'reconciliation_required' THEN NULL ELSE payment.completed_at END FROM wallet_operations hold
          JOIN payment_attempts payment ON payment.wallet_hold_operation_id = hold.id
          WHERE hold.operation_type = 'order_payment_hold'
            AND (payment.status IN ('succeeded', 'failed', 'expired', 'cancelled', 'late_succeeded')
                 AND payment.completed_at <= clock_timestamp() - interval '10 minutes'
              OR payment.status = 'reconciliation_required' AND NOT EXISTS (SELECT 1 FROM payment_provider_reconciliation_cases c
                 WHERE c.payment_attempt_id = payment.id AND c.state = 'open'))
            AND NOT EXISTS (SELECT 1 FROM wallet_operations resolution WHERE resolution.resolves_operation_id = hold.id)
        UNION ALL SELECT 'refund_unknown', created_at FROM order_refund_manual_attempts
          WHERE status IN ('started', 'unknown') AND created_at <= clock_timestamp() - interval '10 minutes'
        UNION ALL SELECT 'refund_manual', refund.updated_at FROM order_refunds refund
          WHERE refund.status IN ('approved', 'processing', 'partially_succeeded')
            AND refund.updated_at <= clock_timestamp() - interval '24 hours'
            AND NOT EXISTS (SELECT 1 FROM order_refund_allocations allocation JOIN order_refund_manual_attempts attempt ON attempt.allocation_id = allocation.id
              WHERE allocation.refund_id = refund.id AND attempt.status IN ('started', 'unknown'))
        UNION ALL SELECT 'withdrawal_unknown', created_at FROM withdrawal_payout_attempts
          WHERE status IN ('started', 'unknown') AND created_at <= clock_timestamp() - interval '10 minutes'
        UNION ALL SELECT 'withdrawal_uncertain', updated_at FROM withdrawals withdrawal
          WHERE withdrawal.status = 'transfer_uncertain'
            AND NOT EXISTS (SELECT 1 FROM withdrawal_payout_attempts attempt WHERE attempt.withdrawal_id = withdrawal.id AND attempt.status IN ('started', 'unknown'))
        UNION ALL SELECT 'delivery_failed', failing.since
          FROM order_items item JOIN orders o ON o.id = item.order_id
          JOIN LATERAL (
            SELECT count(*) AS failures, min(CASE WHEN a.status = 'failed' THEN a.completed_at END) AS since
            FROM order_item_fulfillment_attempts a
            LEFT JOIN supplier_api_delivery_operations operation ON operation.fulfillment_attempt_id = a.id
            WHERE a.order_item_id = item.id AND a.delivery_source = item.fulfillment_method_snapshot
              AND a.status IN ('failed', 'unknown') AND (
                (operation.id IS NULL AND NOT EXISTS (SELECT 1 FROM order_item_fulfillment_attempts later
                  WHERE later.order_item_id = a.order_item_id AND later.delivery_source = a.delivery_source
                    AND (later.created_at, later.id) > (a.created_at, a.id)))
                OR (operation.id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM supplier_api_delivery_operations replacement
                  JOIN order_item_fulfillment_attempts replacement_attempt ON replacement_attempt.id = replacement.fulfillment_attempt_id
                  WHERE replacement_attempt.order_item_id = a.order_item_id AND replacement.unit_index = operation.unit_index
                    AND replacement.id <> operation.id AND replacement.state <> 'failed'))
              )
          ) failing ON failing.failures > 0
          WHERE o.status = 'processing' AND item.fulfilled_quantity < item.quantity
        UNION ALL SELECT 'delivery_backlog', event.created_at FROM order_items item JOIN orders o ON o.id = item.order_id
          JOIN LATERAL (SELECT created_at FROM order_status_events e WHERE e.order_id = o.id AND e.next_status = 'processing'
            ORDER BY e.created_at DESC, e.id DESC LIMIT 1) event ON true
          WHERE o.status = 'processing' AND NOT order_has_unresolved_payment_attempts(o.id)
            AND NOT EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = o.id AND r.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
            AND NOT EXISTS (SELECT 1 FROM payment_attempts p JOIN payment_provider_reconciliation_cases c ON c.payment_attempt_id = p.id WHERE p.order_id = o.id AND c.state = 'open')
            AND item.fulfillment_method_snapshot IN ('code_pool', 'fixed_content', 'link', 'file', 'api')
            AND item.fulfillment_status IN ('pending', 'processing', 'partially_fulfilled')
            AND event.created_at <= clock_timestamp() - interval '24 hours'
        UNION ALL SELECT 'supplier_uncertain', NULL::timestamptz FROM supplier_api_delivery_operations WHERE state IN ('unknown', 'manual_review')
        UNION ALL SELECT 'license_retry', NULL::timestamptz FROM instance_license_state WHERE renewal_retry_count > 0
      ) SELECT kind, count(*)::text AS count, CASE WHEN count(*) FILTER (WHERE since IS NULL) > 0 THEN NULL ELSE min(since) END AS oldest FROM incidents GROUP BY kind
    `.execute(trx)
    const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
    return { checkedAt: time.rows[0]!.now.toISOString(), rows: result.rows.map(row => ({
      kind: row.kind, count: Number(row.count), oldest: row.oldest?.toISOString() ?? null,
    })) }
  })
}

export function registerOperationsRiskRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig) {
  const read = boundedCachedRead(() => readOperationsRisk(db))
  app.get('/api/v1/admin/operations/risk', { preHandler: requireAdmin(db, config) }, async (request, reply) => {
    try { return success(await read(), request.id) }
    catch { return reply.code(503).send(failure('OPERATIONS_UNAVAILABLE', 'Operations data is temporarily unavailable', request.id)) }
  })
}

interface WorkerRow { worker: string; last_scan_at: Date | null; last_success_at: Date | null; last_failure_at: Date | null; last_failure_code: string | null; last_unavailable_at: Date | null; last_unavailable_code: string | null; backlog: string; oldest: Date | null }

export async function readOperationsWorkers(db: Kysely<Database>) {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
    const result = await sql<WorkerRow>`
      WITH eligible_local AS (
    SELECT (SELECT max(event.created_at) FROM order_status_events event WHERE event.order_id = order_row.id AND event.next_status = 'processing') AS since
    FROM orders AS order_row
    JOIN order_items AS item ON item.order_id = order_row.id
    WHERE order_row.status = 'processing'
      AND NOT order_has_unresolved_payment_attempts(order_row.id)
      AND NOT EXISTS (SELECT 1 FROM order_refunds WHERE order_id = order_row.id
        AND status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
      AND NOT EXISTS (SELECT 1 FROM payment_attempts AS payment
        JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment.id
        WHERE payment.order_id = order_row.id AND (receipt.refunded_amount > 0 OR receipt.refund_reserved_amount > 0))
      AND NOT EXISTS (
        SELECT 1 FROM payment_attempts AS payment
        JOIN payment_provider_reconciliation_cases AS reconciliation ON reconciliation.payment_attempt_id = payment.id
        WHERE payment.order_id = order_row.id AND reconciliation.state = 'open'
      )
      AND (order_row.total_amount = 0 OR COALESCE((
        SELECT sum(receipt.amount) FROM payment_attempts AS payment
        JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment.id
        WHERE payment.order_id = order_row.id AND payment.status = 'succeeded' AND receipt.disposition = 'on_time'
      ), 0) = order_row.total_amount)
      AND item.fulfillment_method_snapshot IN ('code_pool', 'fixed_content', 'link', 'file', 'api')
      AND item.fulfilled_quantity + item.fulfillment_reserved_quantity < item.quantity
      AND NOT EXISTS (
        SELECT 1 FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = item.fulfillment_method_snapshot
          AND attempt.status IN ('processing', 'unknown')
      )
      AND (item.fulfillment_method_snapshot = 'api' OR COALESCE((
        SELECT attempt.retry_after FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = item.fulfillment_method_snapshot
          AND attempt.status = 'failed'
        ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
      ), '-infinity'::timestamptz) <= clock_timestamp())
      AND (item.fulfillment_method_snapshot <> 'api' OR NOT EXISTS (
        SELECT 1 FROM order_item_fulfillment_attempts WHERE order_item_id = item.id AND delivery_source = 'api' AND status = 'failed'
      ) OR EXISTS (
        SELECT 1 FROM order_item_fulfillment_attempts AS failed
        LEFT JOIN supplier_api_delivery_operations AS retry_operation ON retry_operation.fulfillment_attempt_id = failed.id
        WHERE failed.order_item_id = item.id AND failed.delivery_source = 'api' AND failed.status = 'failed'
          AND failed.retry_after <= clock_timestamp()
          AND ((retry_operation.id IS NULL AND failed.id = (
            SELECT latest.id FROM order_item_fulfillment_attempts AS latest
            WHERE latest.order_item_id = item.id AND latest.delivery_source = 'api' AND latest.status = 'failed'
            ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
          ) AND NOT EXISTS (
            SELECT 1 FROM supplier_api_delivery_operations AS submitted
            JOIN order_item_fulfillment_attempts AS submitted_attempt ON submitted_attempt.id = submitted.fulfillment_attempt_id
            WHERE submitted_attempt.order_item_id = item.id
          )) OR (retry_operation.id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM supplier_api_delivery_operations AS replacement
            JOIN order_item_fulfillment_attempts AS replacement_attempt ON replacement_attempt.id = replacement.fulfillment_attempt_id
            WHERE replacement_attempt.order_item_id = item.id AND replacement.unit_index = retry_operation.unit_index AND replacement.state <> 'failed'
          )))
      ))
      ), backlog AS (
        SELECT 'unpaid_expiry' AS worker, unpaid_expires_at AS since FROM orders
          WHERE status = 'pending_payment' AND unpaid_expires_at <= clock_timestamp()
            AND NOT order_has_unresolved_payment_attempts(orders.id)
            AND NOT EXISTS (SELECT 1 FROM payment_receipts receipt JOIN payment_attempts attempt ON attempt.id = receipt.payment_attempt_id
              WHERE attempt.order_id = orders.id AND (receipt.refund_reserved_amount > 0 OR receipt.amount <> receipt.refunded_amount))
            AND NOT EXISTS (SELECT 1 FROM order_refunds refund WHERE refund.order_id = orders.id AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
            AND NOT EXISTS (SELECT 1 FROM order_item_fulfillment_attempts attempt JOIN order_items item ON item.id = attempt.order_item_id
              WHERE item.order_id = orders.id AND attempt.status IN ('processing', 'unknown'))
            AND NOT EXISTS (SELECT 1 FROM order_items item WHERE item.order_id = orders.id AND item.fulfillment_reserved_quantity > 0)
            AND COALESCE((SELECT sum(receipt.amount) - sum(receipt.refunded_amount) FROM payment_receipts receipt
              JOIN payment_attempts attempt ON attempt.id = receipt.payment_attempt_id WHERE attempt.order_id = orders.id), 0) = 0
        UNION ALL SELECT 'local_delivery', since FROM eligible_local
        UNION ALL SELECT 'supplier_delivery', CASE WHEN state IN ('create_in_flight', 'query_in_flight') THEN lease_expires_at ELSE next_action_at END
          FROM supplier_api_delivery_operations
          WHERE (state IN ('create_pending', 'query_pending', 'processing', 'unknown', 'succeeded_pending_finalize') AND next_action_at <= clock_timestamp())
             OR (state IN ('create_in_flight', 'query_in_flight') AND lease_expires_at <= clock_timestamp())
        UNION ALL SELECT 'license_renewal', created_at FROM local_license_operations
          WHERE kind = 'renewal' AND state IN ('pending', 'response_saved')
      ), groups AS (SELECT worker, count(*)::text AS backlog, CASE WHEN count(*) FILTER (WHERE since IS NULL) > 0 THEN NULL ELSE min(since) END AS oldest FROM backlog GROUP BY worker)
      SELECT names.worker, health.last_scan_at, health.last_success_at, health.last_failure_at, health.last_failure_code, health.last_unavailable_at, health.last_unavailable_code,
        COALESCE(groups.backlog, '0') AS backlog, groups.oldest
      FROM (VALUES ('unpaid_expiry'), ('local_delivery'), ('supplier_delivery'), ('license_renewal')) AS names(worker)
      LEFT JOIN operations_worker_health health ON health.worker = names.worker
      LEFT JOIN groups ON groups.worker = names.worker
    `.execute(trx)
    const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)).rows[0]!.now
    return { checkedAt: now.toISOString(), workers: result.rows.map(row => {
      const staleAfter = row.worker === 'license_renewal' ? 70 * 60_000 : 3 * 60_000
      const stale = !row.last_scan_at || now.getTime() - row.last_scan_at.getTime() > staleAfter
      const unavailable = row.last_unavailable_at && (!row.last_scan_at || row.last_unavailable_at > row.last_scan_at)
      const failed = row.last_failure_at && (!row.last_success_at || row.last_failure_at > row.last_success_at)
      return { worker: row.worker, status: stale || unavailable ? 'unknown' : failed ? 'failed' : 'running',
        lastScanAt: row.last_scan_at?.toISOString() ?? null, lastSuccessAt: row.last_success_at?.toISOString() ?? null,
        lastFailureAt: row.last_failure_at?.toISOString() ?? null,
        unavailableCode: unavailable && row.last_unavailable_code === 'RELEASE_NOT_CONFIGURED' ? row.last_unavailable_code : null,
        lastFailureCode: row.last_failure_code === 'SCAN_FAILED' ? 'SCAN_FAILED' : null,
        backlog: Number(row.backlog), oldest: row.oldest?.toISOString() ?? null }
    }) }
  })
}

export function registerOperationsWorkerRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig) {
  const read = boundedCachedRead(() => readOperationsWorkers(db))
  app.get('/api/v1/admin/operations/workers', { preHandler: requireAdmin(db, config) }, async (request, reply) => {
    try { return success(await read(), request.id) }
    catch { return reply.code(503).send(failure('OPERATIONS_UNAVAILABLE', 'Worker data is temporarily unavailable', request.id)) }
  })
}

interface FileCheckRow { kind: string; status: string | null; started_at: Date | null; completed_at: Date | null; counts: Record<string, unknown> | null }
const safeCountKeys = new Set(['metadataVariants', 'verifiedVariants', 'missingFiles', 'invalidFiles', 'unreferencedFiles', 'staleStagingFiles',
  'referencedObjects', 'verifiedObjects', 'missingObjects', 'corruptObjects', 'unknownObjects', 'staleUploadRows', 'orphanFiles',
  'deletingAttachments', 'missingObjects', 'oldOrphanFiles', 'prepared', 'deleting', 'missingRetained', 'hashVerified', 'hashFailed', 'hashLimitReached'])
export async function readOperationsFiles(db: Kysely<Database>) {
  return db.transaction().execute(async trx => {
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
    const rows = await sql<FileCheckRow>`SELECT names.kind, checks.status, checks.started_at, checks.completed_at, checks.counts
      FROM (VALUES ('media'), ('private'), ('draft'), ('order')) AS names(kind)
      LEFT JOIN operations_file_checks checks ON checks.kind = names.kind`.execute(trx)
    const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)).rows[0]!.now
    return { checkedAt: now.toISOString(), files: rows.rows.map(row => {
      const valid = row.completed_at && now.getTime() - row.completed_at.getTime() <= 7 * 24 * 60 * 60_000
      const status = valid && (row.status === 'ok' || row.status === 'attention') ? row.status : 'unknown'
      const counts: Record<string, number> = {}
      for (const [key, value] of Object.entries(row.counts ?? {})) {
        if (safeCountKeys.has(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[key] = value
      }
      return { kind: row.kind, status, startedAt: row.started_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null, counts }
    }) }
  })
}
export function registerOperationsFileRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig) {
  const read = boundedCachedRead(() => readOperationsFiles(db))
  app.get('/api/v1/admin/operations/files', { preHandler: requireAdmin(db, config) }, async (request, reply) => {
    try { return success(await read(), request.id) }
    catch { return reply.code(503).send(failure('OPERATIONS_UNAVAILABLE', 'File check data is temporarily unavailable', request.id)) }
  })
}
