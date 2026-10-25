import { createHash } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import { canonicalPurchaseFormJson } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { validatePurchaseDraftForPurchaseInTransaction,
  type PurchaseDraftOwner, type ValidatedPurchaseDraft } from './purchase-forms.js'

export interface PurchaseLineRequest {
  lineId: string
  skuId: string
  quantity: number
  draftId?: string | null
  draftRevision?: number | null
}

export interface NormalizedPurchaseLineRequest {
  lineId: string
  skuId: string
  quantity: number
  draftId: string | null
  draftRevision: number | null
}

export interface ResolvedPurchaseLine extends NormalizedPurchaseLineRequest {
  sourceLineIds: string[]
  templateVersionId: string | null
  normalizationVersion: number | null
  contentIdentity: string
  normalizedValues: Record<string, unknown> | null
  attachments: Array<{ id: string; fieldId: string; storageKey: string; byteSize: number; sha256: string }>
  preparationVersionId: string | null
  validatedDraft: ValidatedPurchaseDraft | null
}

export function purchaseLineContentIdentity(
  skuId: string,
  templateVersionId: string | null,
  normalizationVersion: number | null,
  values: Record<string, unknown> | null,
): string {
  return createHash('sha256').update(canonicalPurchaseFormJson({
    skuId: skuId.toLowerCase(),
    templateVersionId,
    normalizationVersion,
    values,
  }), 'utf8').digest('hex')
}

export function normalizePurchaseLineRequests(items: PurchaseLineRequest[]): NormalizedPurchaseLineRequest[] {
  if (items.length < 1 || items.length > 50) throw new PurchaseLineError('CART_ITEM_LIMIT', '一次购买最多包含 50 个购买行。')
  const lineIds = new Set<string>()
  const draftIds = new Set<string>()
  const skuQuantities = new Map<string, number>()
  const normalized = items.map((item) => {
    const lineId = item.lineId.toLowerCase()
    const skuId = item.skuId.toLowerCase()
    const draftId = item.draftId?.toLowerCase() ?? null
    const draftRevision = item.draftRevision ?? null
    if (lineIds.has(lineId)) throw new PurchaseLineError('PURCHASE_LINE_DUPLICATE', '同一请求不能重复使用购买行标识。')
    lineIds.add(lineId)
    if (draftId) {
      if (draftIds.has(draftId)) throw new PurchaseLineError('PURCHASE_DRAFT_DUPLICATE', '同一填写草稿不能对应多个购买行。')
      draftIds.add(draftId)
    }
    if ((draftId === null) !== (draftRevision === null)
      || (draftRevision !== null && (!Number.isSafeInteger(draftRevision) || draftRevision < 1))) {
      throw new PurchaseLineError('PURCHASE_LINE_REVISION_INVALID', '购买行草稿修订无效。')
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      throw new PurchaseLineError('CART_QUANTITY_LIMIT', '购买行数量必须为 1 至 99。')
    }
    const total = (skuQuantities.get(skuId) ?? 0) + item.quantity
    if (total > 99) throw new PurchaseLineError('CART_QUANTITY_LIMIT', '同一 SKU 的购买数量不能超过 99。')
    skuQuantities.set(skuId, total)
    return { lineId, skuId, quantity: item.quantity, draftId, draftRevision }
  })
  return normalized.sort((left, right) => left.lineId.localeCompare(right.lineId))
}

export function purchaseLineRequestHash(items: PurchaseLineRequest[]): string {
  const normalized = normalizePurchaseLineRequests(items)
  return createHash('sha256').update(canonicalPurchaseFormJson({ version: 2, items: normalized }), 'utf8').digest('hex')
}

export class PurchaseLineError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'PurchaseLineError'
  }
}

export async function preparedPurchaseFormVersion(
  trx: Kysely<Database> | Transaction<Database>, skuId: string,
): Promise<string | null> {
  const variant = await trx.selectFrom('product_variants').select('product_id').where('id', '=', skuId).executeTakeFirst()
  if (!variant) return null
  const override = await trx.selectFrom('sku_purchase_form_overrides')
    .select(['mode', 'template_version_id']).where('product_variant_id', '=', skuId).executeTakeFirst()
  if (override) return override.mode === 'template' ? override.template_version_id : null
  const product = await trx.selectFrom('product_purchase_form_settings')
    .select(['mode', 'template_version_id']).where('product_id', '=', variant.product_id).executeTakeFirst()
  return product?.mode === 'template' ? product.template_version_id : null
}

/** Resolve references from their authenticated owner in the caller's transaction. */
export async function resolvePurchaseLinesInTransaction(
  trx: Transaction<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  rawItems: PurchaseLineRequest[],
  lock: 'share' | 'update' = 'share',
): Promise<ResolvedPurchaseLine[]> {
  const items = normalizePurchaseLineRequests(rawItems)
  const prepared = new Map<string, string | null>()
  const resolved: ResolvedPurchaseLine[] = []
  for (const item of items) {
    let preparationVersionId = prepared.get(item.skuId)
    if (preparationVersionId === undefined) {
      preparationVersionId = await preparedPurchaseFormVersion(trx, item.skuId)
      prepared.set(item.skuId, preparationVersionId)
    }
    if (!item.draftId) {
      resolved.push({
        ...item, sourceLineIds: [item.lineId], templateVersionId: null, normalizationVersion: null,
        contentIdentity: purchaseLineContentIdentity(item.skuId, null, null, null),
        normalizedValues: null, attachments: [], preparationVersionId, validatedDraft: null,
      })
      continue
    }
    const draft = await validatePurchaseDraftForPurchaseInTransaction(trx, config, owner, {
      draftId: item.draftId, expectedRevision: item.draftRevision!,
    }, lock)
    if (!preparationVersionId || draft.templateVersionId !== preparationVersionId) {
      throw new PurchaseLineError('PURCHASE_FORM_VERSION_CHANGED', '商品填写模板绑定已变化，请重新确认购买资料。', 409)
    }
    resolved.push({
      ...item,
      sourceLineIds: [item.lineId],
      templateVersionId: draft.templateVersionId,
      normalizationVersion: draft.normalizationVersion,
      contentIdentity: purchaseLineContentIdentity(item.skuId, draft.templateVersionId,
        draft.normalizationVersion, draft.normalizedValues),
      normalizedValues: draft.normalizedValues,
      attachments: draft.attachments,
      preparationVersionId,
      validatedDraft: draft,
    })
  }
  const byContent = new Map<string, ResolvedPurchaseLine>()
  for (const line of resolved) {
    const key = `${line.skuId}:${line.contentIdentity}`
    const existing = byContent.get(key)
    if (!existing) {
      byContent.set(key, line)
      continue
    }
    const quantity = existing.quantity + line.quantity
    if (quantity > 99) throw new PurchaseLineError('CART_QUANTITY_LIMIT', '同一 SKU 的购买数量不能超过 99。')
    existing.quantity = quantity
    existing.sourceLineIds.push(...line.sourceLineIds)
  }
  return [...byContent.values()].sort((left, right) => left.lineId.localeCompare(right.lineId))
}
