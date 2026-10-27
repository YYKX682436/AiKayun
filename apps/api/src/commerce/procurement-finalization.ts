import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { procurementPreparationEligibility } from './procurement-identity.js'

/**
 * Finalize one proven synthetic completed unit through the original fulfillment
 * records. There is no scheduler or production procurement transport here.
 */
export async function finalizeProcurementUnit(
  db: Kysely<Database>, operationId: string, unitIndex: number,
): Promise<'completed' | 'already_completed' | 'not_ready'> {
  if (!Number.isSafeInteger(unitIndex) || unitIndex < 1) return 'not_ready'
  return db.transaction().execute(async trx => {
    const identity = await sql<{ order_id: string; order_item_id: string }>`
      SELECT source.order_id, operation.order_item_id
      FROM procurement_operations operation
      JOIN order_item_procurement_sources source ON source.id = operation.source_id
      WHERE operation.id = ${operationId}::uuid
    `.execute(trx)
    const link = identity.rows[0]
    if (!link) return 'not_ready'
    const previouslyCompleted = await trx.selectFrom('procurement_operation_units').select('state')
      .where('operation_id', '=', operationId).where('unit_index', '=', unitIndex).executeTakeFirst()
    if (previouslyCompleted?.state === 'completed') return 'already_completed'
    const eligible = await procurementPreparationEligibility(trx, link.order_id, link.order_item_id)
    if (!eligible.eligible) return 'not_ready'
    const item = await trx.selectFrom('order_items')
      .select(['product_id', 'product_variant_id', 'inventory_mode_snapshot'])
      .where('id', '=', link.order_item_id).executeTakeFirstOrThrow()
    await trx.selectFrom('products').select('id').where('id', '=', item.product_id).forShare().executeTakeFirst()
    await trx.selectFrom('product_variants').select('id').where('id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
    if (item.inventory_mode_snapshot === 'quantity') {
      await trx.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
        .where('product_variant_id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
    }
    await trx.selectFrom('product_variant_fulfillment').select('product_variant_id')
      .where('product_variant_id', '=', item.product_variant_id).forShare().executeTakeFirst()

    const riskPolicy = await sql<{ currency: string }>`
      SELECT policy.currency FROM procurement_risk_policies policy
      JOIN procurement_risk_reservations reservation ON reservation.currency = policy.currency
      WHERE reservation.operation_id = ${operationId}::uuid FOR UPDATE OF policy
    `.execute(trx)
    if (!riskPolicy.rows[0]) return 'not_ready'

    // Provider identity is serialized before checking for conflicting evidence.
    // The source identity and number are immutable once observed.
    const source = await sql<{ supplier_connection_id: string; supplier_order_number: string | null }>`
      SELECT source.supplier_connection_id, operation.supplier_order_number
      FROM procurement_operations operation JOIN order_item_procurement_sources source ON source.id = operation.source_id
      WHERE operation.id = ${operationId}::uuid
    `.execute(trx)
    const provider = source.rows[0]
    if (!provider?.supplier_order_number) return 'not_ready'
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'procurement-number:' + provider.supplier_connection_id + ':' + provider.supplier_order_number}, 0))`.execute(trx)
    const operation = await trx.selectFrom('procurement_operations').select(['state', 'revision'])
      .where('id', '=', operationId).forUpdate().executeTakeFirst()
    if (!operation) return 'not_ready'
    const unit = await trx.selectFrom('procurement_operation_units').select('state')
      .where('operation_id', '=', operationId).where('unit_index', '=', unitIndex).forUpdate().executeTakeFirst()
    if (unit?.state === 'completed') return 'already_completed'
    if (operation.state !== 'success_pending_finalize' || unit?.state !== 'success_pending_finalize') return 'not_ready'
    const evidence = await sql<{ response_digest: string }>`
      SELECT confirmed.response_digest FROM procurement_execution_evidence confirmed
      WHERE confirmed.operation_id = ${operationId}::uuid AND confirmed.kind = 'delivery_confirmed'
        AND ${unitIndex} = ANY(confirmed.unit_indices)
        AND EXISTS (SELECT 1 FROM procurement_execution_evidence success
          WHERE success.operation_id = confirmed.operation_id AND success.kind = 'success'
            AND success.response_digest = confirmed.response_digest AND ${unitIndex} = ANY(success.unit_indices))
      ORDER BY confirmed.observed_at, confirmed.id LIMIT 1
    `.execute(trx)
    const digest = evidence.rows[0]?.response_digest
    if (!digest) return 'not_ready'
    const conflicts = await sql<{ conflict: boolean }>`SELECT procurement_has_unresolved_conflict(${operationId}::uuid) AS conflict`.execute(trx)
    if (conflicts.rows[0]?.conflict) return 'not_ready'
    const attemptId = randomUUID()
    await sql`INSERT INTO order_item_fulfillment_attempts
      (id, order_item_id, operation_id, quantity, status, delivery_source, started_by_admin_id,
       procurement_operation_id, procurement_unit_index)
      VALUES (${attemptId}::uuid, ${link.order_item_id}::uuid, ${randomUUID()}::uuid, 1, 'processing',
        'procurement', NULL, ${operationId}::uuid, ${unitIndex})`.execute(trx)
    await sql`INSERT INTO order_item_fulfillment_deliveries
      (id, fulfillment_attempt_id, started_by_admin_id, unit_index, content, content_sha256, delivery_source)
      VALUES (${randomUUID()}::uuid, ${attemptId}::uuid, NULL, ${unitIndex}, NULL, ${digest}, 'procurement')`.execute(trx)
    await trx.updateTable('order_item_fulfillment_attempts').set({ status: 'succeeded', result_sha256: digest })
      .where('id', '=', attemptId).execute()
    await trx.updateTable('procurement_operation_units').set({ state: 'completed' })
      .where('operation_id', '=', operationId).where('unit_index', '=', unitIndex).execute()
    const unfinished = await trx.selectFrom('procurement_operation_units').select('unit_index')
      .where('operation_id', '=', operationId).where('state', '!=', 'completed').limit(1).executeTakeFirst()
    if (!unfinished) await trx.updateTable('procurement_operations')
      .set({ state: 'completed', revision: operation.revision + 1 }).where('id', '=', operationId).execute()
    return 'completed'
  })
}
