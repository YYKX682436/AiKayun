import { randomUUID } from 'node:crypto'
import { sql, type Selectable, type Transaction } from 'kysely'
import type { Database } from '../db/types.js'
import type { CheckoutProcurementSourceSelection } from './procurement-source-selection.js'

type MappingVersion = Selectable<Database['supplier_product_mapping_versions']>

/** Caller has already locked the checkout catalog and checked order idempotency. */
export async function lockCheckoutProcurementSources(
  trx: Transaction<Database>,
  selections: readonly CheckoutProcurementSourceSelection[],
  skuIds: readonly string[],
): Promise<Map<string, MappingVersion>> {
  if (!selections.length) return new Map()
  const requested = new Set(skuIds)
  const bySku = new Map<string, string>()
  for (const selection of selections) {
    if (!requested.has(selection.skuId) || bySku.has(selection.skuId)) throw new Error('Invalid checkout procurement selection')
    bySku.set(selection.skuId, selection.mappingVersionId)
  }
  const rows = await trx.selectFrom('supplier_product_mapping_versions').selectAll()
    .where('id', 'in', [...bySku.values()]).execute()
  if (rows.length !== bySku.size) throw new Error('Checkout procurement mapping version is unavailable')
  const connectionIds = [...new Set(rows.map(row => row.supplier_connection_id))].sort()
  const templateIds = [...new Set(rows.map(row => row.template_version_id))].sort()
  const headIds = [...new Set(rows.map(row => row.mapping_id))].sort()
  await sql`SELECT id FROM supplier_connections WHERE id = ANY(${connectionIds}::uuid[]) ORDER BY id FOR SHARE`.execute(trx)
  await sql`SELECT id FROM purchase_form_template_versions WHERE id = ANY(${templateIds}::uuid[]) ORDER BY id FOR SHARE`.execute(trx)
  await sql`SELECT id FROM supplier_product_mapping_heads WHERE id = ANY(${headIds}::uuid[]) ORDER BY id FOR SHARE`.execute(trx)
  const result = new Map<string, MappingVersion>()
  for (const row of rows) {
    if (bySku.get(row.product_variant_id) !== row.id) throw new Error('Checkout procurement mapping does not match the selected SKU')
    result.set(row.product_variant_id, row)
  }
  return result
}

/** Called only after the original order item and purchase snapshot were inserted. */
export async function persistCheckoutProcurementSource(
  trx: Transaction<Database>, orderId: string, orderItemId: string, mapping: MappingVersion,
): Promise<void> {
  const [version, purchase] = await Promise.all([
    trx.selectFrom('supplier_connection_versions').select('credential_version')
      .where('id', '=', mapping.supplier_connection_version_id).executeTakeFirstOrThrow(),
    trx.selectFrom('order_item_purchase_snapshots').select('content_identity')
      .where('order_item_id', '=', orderItemId).executeTakeFirstOrThrow(),
  ])
  await trx.insertInto('order_item_procurement_sources').values({
    id: randomUUID(), order_id: orderId, order_item_id: orderItemId,
    product_id: mapping.product_id, product_variant_id: mapping.product_variant_id,
    mapping_version_id: mapping.id, supplier_connection_id: mapping.supplier_connection_id,
    supplier_connection_version_id: mapping.supplier_connection_version_id,
    credential_version: version.credential_version, template_version_id: mapping.template_version_id,
    template_sha256: mapping.template_sha256, normalization_version: mapping.normalization_version,
    content_identity: purchase.content_identity, rules_sha256: mapping.rules_sha256,
    structure_sha256: mapping.upstream_structure_sha256, upstream_product_id: mapping.upstream_product_id,
    upstream_sku_type: mapping.upstream_sku_type, upstream_sku_code: mapping.upstream_sku_code,
    upstream_combination: JSON.stringify(mapping.upstream_combination),
  }).execute()
}

export type ProcurementEligibility =
  | { eligible: true; sourceId: string }
  | { eligible: false; reason: 'order_or_item_missing' | 'source_missing' | 'order_not_processing'
      | 'zero_amount' | 'payment_unresolved' | 'reconciliation_open' | 'refund_conflict' | 'payment_unconfirmed' }

/**
 * Internal future-preparation gate. The order lock serializes the original
 * payment/refund paths; callers must keep this transaction through any write.
 * It does not authorize a supplier request, determine a budget or expose a route.
 */
export async function procurementPreparationEligibility(
  trx: Transaction<Database>, orderId: string, orderItemId: string,
): Promise<ProcurementEligibility> {
  const order = await trx.selectFrom('orders').select(['id', 'status', 'items_sealed', 'total_amount'])
    .where('id', '=', orderId).forUpdate().executeTakeFirst()
  if (!order) return { eligible: false, reason: 'order_or_item_missing' }
  const item = await trx.selectFrom('order_items').select('id')
    .where('id', '=', orderItemId).where('order_id', '=', orderId).forUpdate().executeTakeFirst()
  if (!item) return { eligible: false, reason: 'order_or_item_missing' }
  const source = await trx.selectFrom('order_item_procurement_sources').select('id')
    .where('order_item_id', '=', orderItemId).where('order_id', '=', orderId).executeTakeFirst()
  if (!source) return { eligible: false, reason: 'source_missing' }
  if (!order.items_sealed || order.status !== 'processing') return { eligible: false, reason: 'order_not_processing' }
  const money = await sql<{
    zero: boolean; unresolved: boolean; reconciliation: boolean; refund: boolean; confirmed: boolean
  }>`
    SELECT ${order.total_amount}::numeric <= 0 AS zero,
      (order_has_unresolved_payment_attempts(${orderId}::uuid) OR EXISTS (
        SELECT 1 FROM payment_attempts p WHERE p.order_id = ${orderId}::uuid
          AND p.status IN ('created', 'pending', 'reconciliation_required'))) AS unresolved,
      EXISTS (SELECT 1 FROM payment_attempts p JOIN payment_provider_reconciliation_cases c ON c.payment_attempt_id = p.id
        WHERE p.order_id = ${orderId}::uuid AND c.state = 'open') AS reconciliation,
      (EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = ${orderId}::uuid
        AND r.status IN ('requested', 'approved', 'processing', 'partially_succeeded')) OR EXISTS (
        SELECT 1 FROM payment_attempts p JOIN payment_receipts r ON r.payment_attempt_id = p.id
        WHERE p.order_id = ${orderId}::uuid AND (r.refunded_amount > 0 OR r.refund_reserved_amount > 0))) AS refund,
      COALESCE((SELECT sum(r.amount) FROM payment_attempts p JOIN payment_receipts r ON r.payment_attempt_id = p.id
        WHERE p.order_id = ${orderId}::uuid AND p.status = 'succeeded' AND r.disposition = 'on_time'), 0)
        = ${order.total_amount}::numeric AS confirmed
  `.execute(trx)
  const evidence = money.rows[0]!
  if (evidence.zero) return { eligible: false, reason: 'zero_amount' }
  if (evidence.reconciliation) return { eligible: false, reason: 'reconciliation_open' }
  if (evidence.unresolved) return { eligible: false, reason: 'payment_unresolved' }
  if (evidence.refund) return { eligible: false, reason: 'refund_conflict' }
  if (!evidence.confirmed) return { eligible: false, reason: 'payment_unconfirmed' }
  return { eligible: true, sourceId: source.id }
}

export class ProcurementIdentityError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProcurementIdentityError' }
}

/**
 * Internal identity allocation only. This creates no request, outerNumber,
 * supplier quantity, budget reservation or execution eligibility.
 */
export async function allocateProcurementIdentity(
  trx: Transaction<Database>, orderId: string, orderItemId: string, unitIndexes: readonly number[],
): Promise<{ id: string; localBusinessNumber: string; repeated: boolean }> {
  const indexes = [...unitIndexes].sort((a, b) => a - b)
  if (!indexes.length || indexes.some((n, i) => !Number.isSafeInteger(n) || n < 1 || (i > 0 && n === indexes[i - 1]))) {
    throw new ProcurementIdentityError('invalid_units')
  }
  const eligible = await procurementPreparationEligibility(trx, orderId, orderItemId)
  if (!eligible.eligible) throw new ProcurementIdentityError(eligible.reason)
  const existing = await trx.selectFrom('procurement_operation_units')
    .select(['operation_id', 'unit_index']).where('order_item_id', '=', orderItemId)
    .where('unit_index', 'in', indexes).where('state', '!=', 'rejected').execute()
  if (existing.length) {
    const operationId = existing[0]!.operation_id
    const all = await trx.selectFrom('procurement_operation_units').select('unit_index')
      .where('operation_id', '=', operationId).orderBy('unit_index').execute()
    if (existing.length !== indexes.length || existing.some(row => row.operation_id !== operationId)
      || all.length !== indexes.length || all.some((row, i) => row.unit_index !== indexes[i])) {
      throw new ProcurementIdentityError('unit_already_allocated')
    }
    const operation = await trx.selectFrom('procurement_operations').select(['id', 'local_business_number'])
      .where('id', '=', operationId).executeTakeFirstOrThrow()
    return { id: operation.id, localBusinessNumber: operation.local_business_number, repeated: true }
  }
  const id = randomUUID()
  const localBusinessNumber = `local-procurement:${id}`
  await trx.insertInto('procurement_operations').values({ id, local_business_number: localBusinessNumber,
    source_id: eligible.sourceId, order_item_id: orderItemId }).execute()
  await trx.insertInto('procurement_operation_units').values(indexes.map(unitIndex => ({
    operation_id: id, order_item_id: orderItemId, unit_index: unitIndex,
  }))).execute()
  await trx.updateTable('procurement_operations').set({ allocations_sealed: true, revision: 1 })
    .where('id', '=', id).executeTakeFirstOrThrow()
  return { id, localBusinessNumber, repeated: false }
}
