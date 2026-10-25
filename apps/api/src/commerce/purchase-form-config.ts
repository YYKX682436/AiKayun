import type { Kysely, Transaction } from 'kysely'
import { validatePurchaseFormDefinition } from '@aikayun/contracts'
import type { PurchaseFormDefinition } from '@aikayun/contracts'
import type { Database, PurchaseFormsStatus } from '../db/types.js'

export type PurchaseFormDb = Kysely<Database> | Transaction<Database>

export interface EffectivePurchaseForm {
  status: PurchaseFormsStatus
  skuId: string
  templateVersionId: string | null
  templateId: string | null
  templateName: string | null
  versionNumber: number | null
  definition: PurchaseFormDefinition | null
}

export async function readPurchaseFormsStatus(
  db: PurchaseFormDb,
  lock?: 'share' | 'update',
): Promise<PurchaseFormsStatus> {
  let query = db.selectFrom('storefront_customer_policy').select('purchase_forms_status')
    .where('singleton', '=', true)
  if (lock === 'share') query = query.forShare()
  if (lock === 'update') query = query.forUpdate()
  const row = await query.executeTakeFirstOrThrow()
  return row.purchase_forms_status
}

/** Resolve only the currently applied association. Preparation rows are never storefront authority. */
export async function effectivePurchaseFormForSku(
  db: PurchaseFormDb,
  skuId: string,
  options: { lockStatus?: 'share' | 'update' } = {},
): Promise<EffectivePurchaseForm> {
  const status = await readPurchaseFormsStatus(db, options.lockStatus)
  const variant = await db.selectFrom('product_variants as variant')
    .innerJoin('products as product', 'product.id', 'variant.product_id')
    .select(['variant.id as sku_id', 'variant.product_id', 'product.status as product_status'])
    .where('variant.id', '=', skuId).executeTakeFirst()
  if (!variant) return { status, skuId, templateVersionId: null, templateId: null,
    templateName: null, versionNumber: null, definition: null }
  if (status === 'preparing') return { status, skuId, templateVersionId: null, templateId: null,
    templateName: null, versionNumber: null, definition: null }

  const override = await db.selectFrom('sku_purchase_form_overrides')
    .select(['applied_mode', 'applied_template_version_id'])
    .where('product_id', '=', variant.product_id).where('product_variant_id', '=', skuId).executeTakeFirst()
  const product = await db.selectFrom('product_purchase_form_settings')
    .select(['applied_mode', 'applied_template_version_id'])
    .where('product_id', '=', variant.product_id).executeTakeFirst()
  const mode = override?.applied_mode ?? product?.applied_mode ?? null
  const templateVersionId = override?.applied_mode
    ? override.applied_mode === 'template' ? override.applied_template_version_id : null
    : product?.applied_mode === 'template' ? product.applied_template_version_id : null
  if (mode !== 'template' || !templateVersionId) return { status, skuId, templateVersionId: null,
    templateId: null, templateName: null, versionNumber: null, definition: null }

  const version = await db.selectFrom('purchase_form_template_versions')
    .select(['id', 'template_id', 'version_number', 'name', 'definition'])
    .where('id', '=', templateVersionId).executeTakeFirst()
  if (!version) throw new Error('Applied purchase form version is missing')
  const definition = validatePurchaseFormDefinition(version.definition)
  if (!definition.ok) throw new Error('Applied purchase form version is invalid')
  return {
    status, skuId, templateVersionId: version.id, templateId: version.template_id,
    templateName: version.name, versionNumber: version.version_number, definition: definition.value,
  }
}
