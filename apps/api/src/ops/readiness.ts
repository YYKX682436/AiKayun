import { access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { sql, type Kysely } from 'kysely'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { AppMigrationProvider } from '../db/migration-provider.js'

/** Verify compiled migrations once, never hash files on the public probe. */
export function createReadinessCheck(db: Kysely<Database>, config: AppConfig) {
  const compiledNames = new AppMigrationProvider().getMigrations().then(migrations => Object.keys(migrations).sort()).catch(() => null)
  let inFlight: Promise<boolean> | undefined
  const check = async (): Promise<boolean> => {
    const names = await compiledNames
    if (!names?.length) return false
    const [schema] = await Promise.all([
      db.transaction().execute(async tx => {
        await sql`SET LOCAL statement_timeout = '1500ms'`.execute(tx)
        const applied = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(tx)
        if (applied.rows.length !== names.length || applied.rows.some((row, i) => row.name !== names[i])) return false
        // Selected critical objects, not a complete physical schema audit. LIMIT 0
        // checks required columns without reading or hashing business data.
        await sql`SELECT id, status, total_amount, unpaid_expires_at FROM orders LIMIT 0`.execute(tx)
        await sql`SELECT id, order_id, fulfillment_status, fulfilled_quantity, fulfillment_reserved_quantity FROM order_items LIMIT 0`.execute(tx)
        await sql`SELECT id, status, amount, order_id, wallet_hold_operation_id FROM payment_attempts LIMIT 0`.execute(tx)
        await sql`SELECT payment_attempt_id, state, request_started_at FROM payment_attempt_provider_state LIMIT 0`.execute(tx)
        await sql`SELECT id, order_id, status, amount FROM order_refunds LIMIT 0`.execute(tx)
        await sql`SELECT id, wallet_operation_id, amount, action FROM wallet_ledger_entries LIMIT 0`.execute(tx)
        await sql`SELECT id, customer_id, status, amount, wallet_operation_id FROM withdrawals LIMIT 0`.execute(tx)
        await sql`SELECT id, withdrawal_id, status FROM withdrawal_payout_attempts LIMIT 0`.execute(tx)
        await sql`SELECT id, order_item_id, status FROM order_item_fulfillment_attempts LIMIT 0`.execute(tx)
        await sql`SELECT operation_id, state, next_action_at FROM supplier_api_delivery_operations LIMIT 0`.execute(tx)
        await sql`SELECT singleton, renewal_retry_count FROM instance_license_state LIMIT 0`.execute(tx)
        await sql`SELECT worker, last_scan_at, last_unavailable_at FROM operations_worker_health LIMIT 0`.execute(tx)
        const guards = await sql<{ ok: boolean }>`
          SELECT
            NOT EXISTS (
              SELECT 1 FROM (VALUES
                ('orders', 'orders_single_owner_check'),
                ('payment_attempts', 'payment_attempts_single_target_check'),
                ('payment_attempts', 'payment_attempts_amount_check'),
                ('order_refunds', 'order_refunds_order_idempotency_unique'),
                ('wallet_ledger_entries', 'wallet_ledger_entries_operation_line_unique'),
                ('withdrawals', 'withdrawals_customer_idempotency_unique')
              ) AS expected(rel, name)
              WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                WHERE c.conrelid = to_regclass(expected.rel) AND c.conname = expected.name AND c.convalidated)
            ) AND NOT EXISTS (
              SELECT 1 FROM (VALUES
                ('orders', 'orders_customer_idempotency_unique'),
                ('payment_attempts', 'payment_attempts_one_active_order_unique'),
                ('payment_receipts', 'payment_receipts_provider_transaction_unique'),
                ('wallet_operations', 'wallet_operations_resolves_once_unique'),
                ('wallet_ledger_entries', 'wallet_ledger_entries_payment_attempt_bucket_action_unique'),
                ('withdrawal_payout_attempts', 'withdrawal_payout_attempts_active_unique'),
                ('order_refund_manual_attempts', 'order_refund_manual_attempt_active_unique')
              ) AS expected(rel, name)
              WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                WHERE i.indrelid = to_regclass(expected.rel) AND i.indexrelid = to_regclass(expected.name)
                  AND i.indisvalid AND i.indisready AND i.indisunique)
            ) AND NOT EXISTS (
              SELECT 1 FROM (VALUES
                ('payment_attempts', 'payment_attempts_guard'),
                ('wallet_ledger_entries', 'wallet_ledger_entries_immutable'),
                ('wallet_ledger_entries', 'wallet_ledger_entries_apply'),
                ('order_refunds', 'order_refunds_prevent_delete'),
                ('withdrawals', 'withdrawals_prevent_delete'),
                ('order_item_fulfillment_attempts', 'order_item_fulfillment_attempts_guard')
              ) AS expected(rel, name)
              WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                WHERE t.tgrelid = to_regclass(expected.rel) AND t.tgname = expected.name
                  AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A'))
            ) AS ok
        `.execute(tx)
        if (!guards.rows[0]?.ok) return false
        return true
      }),
      ...[config.mediaRoot, config.privateFileRoot].map(async root => {
        const info = await lstat(root)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('DIRECTORY_UNAVAILABLE')
        await access(root, constants.R_OK | constants.W_OK | constants.X_OK)
      }),
    ])
    return schema
  }
  return async (): Promise<boolean> => {
    if (!inFlight) {
      inFlight = check().catch(() => false).finally(() => { inFlight = undefined })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([inFlight, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2000) })])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
