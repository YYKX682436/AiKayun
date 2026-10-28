import { createHash } from 'node:crypto'
import type { Transaction } from 'kysely'
import {
  canonicalPurchaseFormJson, canonicalSupplierMappingJson, normalizePurchaseFormAnswers, SUPPLIER_MAPPING_STRUCTURE_VERSION,
  resolveSupplierMappingPath, validatePurchaseFormDefinition, validateSupplierProductMapping,
  type PurchaseFormField, type SupplierMappingPath,
} from '@aikayun/contracts'
import type { Database } from '../db/types.js'
import type { AppConfig } from '../config.js'
import { purchaseLineContentIdentity } from './purchase-lines.js'
import { readOrderPurchaseSnapshot } from './purchase-order-attachments.js'
import { procurementPreparationEligibility } from './procurement-identity.js'

const digest = (value: unknown) => createHash('sha256').update(canonicalSupplierMappingJson(value), 'utf8').digest('hex')
const blockers = ['currency', 'maximum_debit', 'fees', 'quantity_conversion', 'safe_price', 'outer_number', 'protocol_encoding'] as const

type PreparedField = {
  localFieldId: string; upstreamPath: SupplierMappingPath
  value?: string; options?: Array<{ localOptionId: string; upstreamPath: SupplierMappingPath; value: string }>
  attachments?: Array<{ archiveObjectId: string; sha256: string; byteSize: number }>
}
export type ProcurementPreparation =
  | { kind: 'blocked'; reason: string; purchaseEligible: false }
  | { kind: 'prepared'; orderItemId: string; quantity: number; sourceId: string; mappingVersionId: string;
      fields: PreparedField[]; paymentEligibility: string; purchaseEligible: false; blockers: readonly string[] }

/** Sensitive internal result: never expose via an API, audit, or log. This function writes nothing. */
export async function prepareOrderItemProcurement(trx: Transaction<Database>, config: AppConfig, orderItemId: string): Promise<ProcurementPreparation> {
  const blocked = (reason: string): ProcurementPreparation => ({ kind: 'blocked', reason, purchaseEligible: false })
  const item = await trx.selectFrom('order_items').selectAll().where('id', '=', orderItemId).executeTakeFirst()
  if (!item) return blocked('order_or_item_missing')
  const eligibility = await procurementPreparationEligibility(trx, item.order_id, orderItemId)
  if (!eligibility.eligible && eligibility.reason === 'source_missing') return blocked('source_missing')
  const source = await trx.selectFrom('order_item_procurement_sources').selectAll().where('order_item_id', '=', orderItemId).executeTakeFirst()
  if (!source || source.order_id !== item.order_id) return blocked('source_missing')
  const [mapping, template, connection, credential] = await Promise.all([
    trx.selectFrom('supplier_product_mapping_versions').selectAll().where('id', '=', source.mapping_version_id).executeTakeFirst(),
    trx.selectFrom('purchase_form_template_versions').selectAll().where('id', '=', source.template_version_id).executeTakeFirst(),
    trx.selectFrom('supplier_connection_versions').selectAll().where('id', '=', source.supplier_connection_version_id).executeTakeFirst(),
    trx.selectFrom('supplier_connection_credentials').select(['supplier_connection_id', 'credential_version', 'provider_type', 'auth_scheme'])
      .where('supplier_connection_id', '=', source.supplier_connection_id).where('credential_version', '=', source.credential_version).executeTakeFirst(),
  ])
  if (!mapping || !template || !connection || !credential) return blocked('frozen_version_missing')
  if (source.product_id !== item.product_id || source.product_variant_id !== item.product_variant_id
    || mapping.product_id !== item.product_id || mapping.product_variant_id !== item.product_variant_id
    || mapping.supplier_connection_id !== source.supplier_connection_id || mapping.supplier_connection_version_id !== source.supplier_connection_version_id
    || connection.supplier_connection_id !== source.supplier_connection_id || connection.credential_version !== source.credential_version
    || connection.provider_type !== 'kayixin_customer_v3' || connection.auth_scheme !== 'app_signature_v3'
    || credential.provider_type !== 'kayixin_customer_v3' || credential.auth_scheme !== 'app_signature_v3'
    || mapping.provider_type !== 'kayixin_customer_v3' || source.provider_type !== 'kayixin_customer_v3'
    || mapping.template_version_id !== source.template_version_id || mapping.template_id !== template.template_id
    || mapping.template_sha256 !== source.template_sha256 || template.sha256 !== source.template_sha256
    || mapping.normalization_version !== source.normalization_version || mapping.rules_sha256 !== source.rules_sha256
    || mapping.upstream_structure_sha256 !== source.structure_sha256 || mapping.upstream_product_id !== source.upstream_product_id
    || mapping.upstream_sku_type !== source.upstream_sku_type || mapping.upstream_sku_code !== source.upstream_sku_code
    || digest(mapping.upstream_combination) !== digest(source.upstream_combination)
    || digest(mapping.rules) !== source.rules_sha256 || digest(mapping.upstream_structure_snapshot) !== source.structure_sha256) return blocked('frozen_identity_mismatch')
  const definition = validatePurchaseFormDefinition(template.definition)
  if (!definition.ok || createHash('sha256').update(canonicalPurchaseFormJson({ name: template.name, definition: definition.value }), 'utf8').digest('hex') !== template.sha256) return blocked('template_invalid')
  const structure = mapping.upstream_structure_snapshot as { version?: unknown; product?: { goodsId?: unknown; skuType?: unknown; skuCode?: unknown; combination?: unknown }; purchaseFields?: Parameters<typeof validateSupplierProductMapping>[1] }
  if (!structure || typeof structure !== 'object' || structure.version !== SUPPLIER_MAPPING_STRUCTURE_VERSION || !structure.product || structure.product.goodsId !== source.upstream_product_id || structure.product.skuType !== source.upstream_sku_type
    || structure.product.skuCode !== source.upstream_sku_code || !Array.isArray(structure.product.combination)
    || digest(structure.product.combination) !== digest(source.upstream_combination)
    || (source.upstream_sku_type === 0 ? source.upstream_sku_code !== null || source.upstream_combination.length !== 0
      : ![1, 2].includes(source.upstream_sku_type) || !source.upstream_sku_code || !source.upstream_combination.length)
    || !Array.isArray(structure.purchaseFields)) return blocked('structure_invalid')
  let checked: ReturnType<typeof validateSupplierProductMapping>
  try { checked = validateSupplierProductMapping(definition.value, structure.purchaseFields, mapping.rules) } catch { return blocked('mapping_invalid') }
  if (!checked.valid || !checked.rules) return blocked('mapping_invalid')
  let snapshot: Awaited<ReturnType<typeof readOrderPurchaseSnapshot>>
  try { snapshot = await readOrderPurchaseSnapshot(trx, config, orderItemId) } catch { return blocked('purchase_snapshot_unavailable') }
  if (snapshot.state !== 'filled' || !snapshot.values || snapshot.templateVersionId !== source.template_version_id
    || snapshot.normalizationVersion !== source.normalization_version || snapshot.contentIdentity !== source.content_identity
    || purchaseLineContentIdentity(item.product_variant_id, snapshot.templateVersionId, snapshot.normalizationVersion, snapshot.values) !== source.content_identity) return blocked('purchase_snapshot_mismatch')
  const attachments = await trx.selectFrom('order_item_purchase_attachments as a')
    .innerJoin('purchase_order_attachment_objects as o', 'o.id', 'a.archive_object_id')
    .select(['a.source_attachment_id', 'a.field_id', 'a.archive_object_id', 'a.sha256', 'a.byte_size', 'o.status', 'o.source_attachment_id as object_source_id', 'o.sha256 as object_sha256', 'o.byte_size as object_size'])
    .where('a.order_item_id', '=', orderItemId).execute()
  if (attachments.length !== snapshot.attachments.length || attachments.some(a => a.status !== 'retained' || a.source_attachment_id !== a.object_source_id || a.sha256 !== a.object_sha256 || a.byte_size !== a.object_size)) return blocked('attachment_mismatch')
  const normalized = normalizePurchaseFormAnswers(definition.value, snapshot.values, { requireComplete: true,
    attachmentIds: new Set(attachments.map(a => a.source_attachment_id.toLowerCase())),
    attachmentFieldIds: new Map(attachments.map(a => [a.source_attachment_id.toLowerCase(), a.field_id.toLowerCase()])) })
  if (!normalized.ok || normalized.incompleteFieldIds.length || canonicalPurchaseFormJson(normalized.value) !== canonicalPurchaseFormJson(snapshot.values)) return blocked('purchase_values_invalid')
  const fields: PreparedField[] = []
  const rules = new Map(checked.rules.fields.map(rule => [rule.localFieldId.toLowerCase(), rule]))
  const append = (field: PurchaseFormField, value: unknown): boolean => {
    if (value === undefined) return true
    const rule = rules.get(field.id.toLowerCase())
    if (!rule) return false
    const entry: PreparedField = { localFieldId: field.id, upstreamPath: rule.upstreamPath }
    const mapOption = (id: string) => {
      const option = rule.options.find(row => row.localOptionId.toLowerCase() === id.toLowerCase())
      const resolved = option && resolveSupplierMappingPath(structure.purchaseFields!, option.upstreamPath)
      return option && resolved?.kind === 'option' ? { localOptionId: id, upstreamPath: option.upstreamPath, value: resolved.option.value } : null
    }
    if (field.type === 'image') {
      if (!Array.isArray(value)) return false
      entry.attachments = value.map(id => attachments.find(a => a.source_attachment_id === id && a.field_id.toLowerCase() === field.id.toLowerCase())).filter(a => a !== undefined)
        .map(a => ({ archiveObjectId: a.archive_object_id, sha256: a.sha256, byteSize: a.byte_size }))
      if (entry.attachments.length !== value.length) return false
    } else if (field.type === 'select') {
      if (typeof value !== 'string') return false
      const option = mapOption(value); if (!option) return false
      entry.options = [option]
    } else if (field.type === 'cascade') {
      const cascade = value as { path: string[]; expanded: Record<string, unknown> }
      entry.options = []
      let choices = field.options
      for (const id of cascade.path) {
        const selected = choices.find(option => option.id.toLowerCase() === id.toLowerCase())
        const mapped = mapOption(id)
        if (!selected || !mapped) return false
        entry.options.push(mapped)
        for (const child of selected.expandedFields ?? []) if (!append(child, cascade.expanded[child.id.toLowerCase()])) return false
        choices = selected.children ?? []
      }
    } else {
      if (typeof value !== 'string') return false
      entry.value = value
    }
    fields.push(entry)
    return true
  }
  for (const field of definition.value.fields) if (!append(field, normalized.value[field.id.toLowerCase()])) return blocked('mapping_values_invalid')
  if (fields.reduce((count, field) => count + (field.attachments?.length ?? 0), 0) !== attachments.length) return blocked('attachment_mismatch')
  const explicitBlockers: string[] = [...blockers]
  if (fields.some(field => field.attachments?.length)) explicitBlockers.push('image_encoding')
  if (fields.some(field => field.options?.length && field.upstreamPath.some(segment => segment.kind === 'field')
    && definition.value.fields.some(local => local.id === field.localFieldId && local.type === 'cascade'))) explicitBlockers.push('cascade_encoding')
  if (fields.some(field => field.upstreamPath.some(segment => segment.kind === 'expand'))) explicitBlockers.push('conditional_encoding')
  return { kind: 'prepared', orderItemId, quantity: item.quantity, sourceId: source.id, mappingVersionId: mapping.id,
    fields, paymentEligibility: eligibility.eligible ? 'eligible' : eligibility.reason, purchaseEligible: false, blockers: explicitBlockers }
}
