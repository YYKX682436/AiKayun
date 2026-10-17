import { sql } from 'kysely'
import type { Kysely, Transaction } from 'kysely'
import { parseUnitAmount } from '@aikayun/money'
import type {
  ProductVariantMatrixBody,
  ProductVariantMatrixPreview,
  ProductVariantMatrixSaveResult,
} from '@aikayun/contracts'
import type { ProductDetail } from '@aikayun/contracts'
import type { Database } from '../db/types.js'
import type { ProductIdentityFactory } from './admin-products.js'
import { loadProduct } from './admin-products.js'
import { CatalogError } from './errors.js'
import { assertProductNotArchived, lockProductAtRevision } from './admin-product-guards.js'

type MatrixGroupInput = ProductVariantMatrixBody['groups'][number]
type MatrixCombinationInput = Extract<ProductVariantMatrixBody, { mode: 'selected' }>['combinations'][number]

interface ExistingVariant {
  id: string
  product_id: string
  sku_code: string
  combination_key: string
  sale_price: string
  compare_at_price: string | null
  cost_price: string | null
  enabled: boolean
  retired_at: Date | null
  revision: number
  created_at: Date
  updated_at: Date
}
interface NormalizedValue {
  id: string
  groupId: string
  name: string
  sortOrder: number
  enabled: boolean
}

interface NormalizedGroup {
  id: string
  name: string
  sortOrder: number
  enabled: boolean
  values: NormalizedValue[]
}

interface PlannedOption {
  groupId: string
  groupName: string
  valueId: string
  valueName: string
}

interface PlannedVariant {
  skuId: string | undefined
  skuCode: string | null
  current: ExistingVariant | undefined
  combinationKey: string
  options: PlannedOption[]
  salePrice: string
  enabled: boolean
  change: 'added' | 'retained' | 'modified'
  inventoryMutationBlockReason: 'stocked_quantity' | 'reserved_quantity' | 'adjustment_history' | null
  retirementBlockReason: 'stocked_quantity' | 'reserved_quantity' | null
}

interface ExistingOption {
  groupId: string
  groupName: string
  valueId: string
  valueName: string
}

interface MatrixPlan {
  productId: string
  possibleCombinationCount: number
  groups: NormalizedGroup[]
  values: NormalizedValue[]
  combinations: PlannedVariant[]
  retired: ExistingVariant[]
  retireNow: ExistingVariant[]
  removed: ExistingVariant[]
  existingOptions: Map<string, ExistingOption[]>
  inventoryMutationBlockReasons: Map<string, 'stocked_quantity' | 'reserved_quantity' | 'adjustment_history'>
  retirementBlockReasons: Map<string, 'stocked_quantity' | 'reserved_quantity'>
}

const salePricePattern = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?(?![\s\S])/

function normalizeName(value: string, label: string, max: number): string {
  const name = value.trim()
  if (!name) throw new CatalogError(400, 'INVALID_OPTION_NAME', `${label} must not be empty`)
  if (name.length > max) throw new CatalogError(400, 'INVALID_OPTION_NAME', `${label} must be at most ${max} characters`)
  return name
}

function normalizePrice(value: string): string {
  if (!salePricePattern.test(value)) {
    throw new CatalogError(400, 'INVALID_SALE_PRICE', 'Sale price must be a non-negative CNY decimal with at most two fractional digits')
  }
  return parseUnitAmount(value).toFixed(2)
}

function keyFor(ids: string[]): string {
  if (ids.length === 0) return ''
  return `v1:${[...ids].map((id) => id.toLowerCase()).sort().join('.')}`
}

function optionSort(left: PlannedOption, right: PlannedOption, groups: Map<string, NormalizedGroup>) {
  const leftGroup = groups.get(left.groupId)!
  const rightGroup = groups.get(right.groupId)!
  return leftGroup.sortOrder - rightGroup.sortOrder || left.groupId.localeCompare(right.groupId)
}

function cartesian(groups: NormalizedGroup[]): NormalizedValue[][] {
  const activeGroups = groups.filter((group) => group.enabled)
  if (activeGroups.length === 0) return [[]]
  let rows: NormalizedValue[][] = [[]]
  for (const group of activeGroups) {
    const values = group.values.filter((value) => value.enabled)
    rows = rows.flatMap((row) => values.map((value) => [...row, value]))
  }
  return rows
}

async function planMatrix(
  trx: Transaction<Database>,
  productId: string,
  body: ProductVariantMatrixBody,
): Promise<MatrixPlan> {
  const [currentValues, currentVariants, linkRows, quantityRows, adjustmentRows] = await Promise.all([
    trx.selectFrom('product_option_values').selectAll().where('product_id', '=', productId).execute(),
    trx.selectFrom('product_variants')
      .select(['id', 'product_id', 'sku_code', 'combination_key', 'sale_price', 'compare_at_price', 'cost_price', 'enabled', 'retired_at', 'revision', 'created_at', 'updated_at'])
      .where('product_id', '=', productId).execute(),
    trx.selectFrom('product_variant_option_values as selected')
      .innerJoin('product_option_groups as option_group', (join) => join
        .onRef('option_group.id', '=', 'selected.option_group_id')
        .onRef('option_group.product_id', '=', 'selected.product_id'))
      .innerJoin('product_option_values as option_value', (join) => join
        .onRef('option_value.id', '=', 'selected.option_value_id')
        .onRef('option_value.option_group_id', '=', 'selected.option_group_id')
        .onRef('option_value.product_id', '=', 'selected.product_id'))
      .select([
        'selected.product_variant_id', 'option_group.id as group_id', 'option_group.name as group_name',
        'option_value.id as value_id', 'option_value.name as value_name',
      ])
      .where('selected.product_id', '=', productId).execute(),
    trx.selectFrom('product_variant_quantity_inventory').select(['product_variant_id', 'stocked', 'reserved'])
      .where('product_id', '=', productId).execute(),
    trx.selectFrom('product_variant_inventory_adjustments').select('product_variant_id')
      .distinct().where('product_id', '=', productId).execute(),
  ])
  const currentValueById = new Map(currentValues.map((value) => [value.id, value]))
  const existingById = new Map(currentVariants.map((variant) => [variant.id, variant]))
  const existingByKey = new Map(currentVariants.map((variant) => [variant.combination_key, variant]))
  const enabledUpdates = new Map<string, boolean>()
  if (body.mode === 'all') {
    for (const update of body.skuEnabledUpdates ?? []) {
      const skuId = update.skuId.toLowerCase()
      if (enabledUpdates.has(skuId)) {
        throw new CatalogError(400, 'DUPLICATE_SKU_ENABLED_UPDATE', 'A SKU enabled state may be updated only once')
      }
      const variant = existingById.get(skuId)
      if (!variant) throw new CatalogError(409, 'SKU_ID_CONFLICT', 'An enabled-state update SKU does not belong to this product')
      if (variant.retired_at !== null) {
        throw new CatalogError(409, 'SKU_RETIRED', 'A permanently retired SKU cannot be reactivated or reused')
      }
      enabledUpdates.set(skuId, update.enabled)
    }
  }
  const existingOptions = new Map<string, ExistingOption[]>()
  for (const row of linkRows) {
    const options = existingOptions.get(row.product_variant_id) ?? []
    options.push({ groupId: row.group_id, groupName: row.group_name, valueId: row.value_id, valueName: row.value_name })
    existingOptions.set(row.product_variant_id, options)
  }
  const inventoryMutationBlockReasons = new Map<string, 'stocked_quantity' | 'reserved_quantity' | 'adjustment_history'>()
  const retirementBlockReasons = new Map<string, 'stocked_quantity' | 'reserved_quantity'>()
  for (const row of quantityRows) {
    if (row.reserved > 0) {
      inventoryMutationBlockReasons.set(row.product_variant_id, 'reserved_quantity')
      retirementBlockReasons.set(row.product_variant_id, 'reserved_quantity')
    } else if (row.stocked > 0) {
      inventoryMutationBlockReasons.set(row.product_variant_id, 'stocked_quantity')
      retirementBlockReasons.set(row.product_variant_id, 'stocked_quantity')
    }
  }
  for (const row of adjustmentRows) {
    inventoryMutationBlockReasons.set(row.product_variant_id, 'adjustment_history')
  }

  const groupIds = new Set<string>()
  const valueIds = new Set<string>()
  const groupNames = new Set<string>()
  const normalizedGroups: NormalizedGroup[] = body.groups.map((input: MatrixGroupInput) => {
    const id = input.id.toLowerCase()
    if (groupIds.has(id)) throw new CatalogError(400, 'DUPLICATE_OPTION_GROUP_ID', 'An option group ID may appear only once')
    groupIds.add(id)
    const name = normalizeName(input.name, 'Option group name', 80)
    const nameKey = name.toLowerCase()
    if (groupNames.has(nameKey)) throw new CatalogError(400, 'OPTION_GROUP_NAME_CONFLICT', 'Option group names must be unique within a product')
    groupNames.add(nameKey)
    const valueNames = new Set<string>()
    const values: NormalizedValue[] = input.values.map((rawValue) => {
      const valueId = rawValue.id.toLowerCase()
      if (valueIds.has(valueId)) throw new CatalogError(400, 'DUPLICATE_OPTION_VALUE_ID', 'An option value ID may appear only once')
      valueIds.add(valueId)
      const existingValue = currentValueById.get(valueId)
      if (existingValue && existingValue.option_group_id !== id) {
        throw new CatalogError(409, 'OPTION_VALUE_GROUP_IMMUTABLE', 'An option value cannot be moved to another option group')
      }
      const valueName = normalizeName(rawValue.name, 'Option value name', 80)
      const valueNameKey = valueName.toLowerCase()
      if (valueNames.has(valueNameKey)) throw new CatalogError(400, 'OPTION_VALUE_NAME_CONFLICT', 'Option value names must be unique within a group')
      valueNames.add(valueNameKey)
      return {
        id: valueId,
        groupId: id,
        name: valueName,
        sortOrder: rawValue.sortOrder,
        enabled: rawValue.enabled,
      }
    })
    return { id, name, sortOrder: input.sortOrder, enabled: input.enabled, values }
  })
  const desiredGroupIds = [...groupIds]
  const desiredValueIds = [...valueIds]
  const [foreignGroups, foreignValues] = await Promise.all([
    desiredGroupIds.length > 0
      ? trx.selectFrom('product_option_groups').select('id').where('id', 'in', desiredGroupIds).where('product_id', '!=', productId).execute()
      : Promise.resolve([]),
    desiredValueIds.length > 0
      ? trx.selectFrom('product_option_values').select('id').where('id', 'in', desiredValueIds).where('product_id', '!=', productId).execute()
      : Promise.resolve([]),
  ])
  if (foreignGroups.length > 0 || foreignValues.length > 0) {
    throw new CatalogError(409, 'SPECIFICATION_ID_CONFLICT', 'A specification ID belongs to another product')
  }

  const activeGroups = normalizedGroups.filter((group) => group.enabled)
  const possibleCombinationCount = activeGroups.length === 0
    ? 1
    : activeGroups.some((group) => group.values.every((value) => !value.enabled))
      ? 0
      : activeGroups.reduce((count, group) => count * group.values.filter((value) => value.enabled).length, 1)
  if (body.mode === 'all' && possibleCombinationCount > 1000) {
    throw new CatalogError(400, 'SKU_LIMIT_EXCEEDED', 'The full option matrix exceeds the 1000 SKU limit; select a smaller set of combinations')
  }
  if (possibleCombinationCount === 0) {
    throw new CatalogError(400, 'INVALID_OPTION_MATRIX', 'Every enabled option group must contain at least one enabled value')
  }

  const desiredCombinations = body.mode === 'all'
    ? cartesian(normalizedGroups).map((values) => ({
      values,
      skuId: undefined,
      salePrice: undefined,
      enabled: undefined,
    }))
    : body.combinations.map((combination: MatrixCombinationInput) => {
      const selectedIds = combination.optionValueIds.map((id) => id.toLowerCase())
      if (new Set(selectedIds).size !== selectedIds.length) {
        throw new CatalogError(400, 'DUPLICATE_OPTION_VALUE_SELECTION', 'An option value may be selected only once for a SKU')
      }
      const values = selectedIds.map((id) => normalizedGroups.flatMap((group) => group.values).find((value) => value.id === id))
      if (values.some((value) => !value)) {
        throw new CatalogError(400, 'OPTION_VALUE_REFERENCE_INVALID', 'A selected option value does not belong to the proposed product specifications')
      }
      const resolved = values as NormalizedValue[]
      if (resolved.some((value) => !value.enabled || !normalizedGroups.find((group) => group.id === value.groupId)?.enabled)) {
        throw new CatalogError(400, 'INACTIVE_OPTION_VALUE', 'A sellable SKU cannot use a disabled option group or value')
      }
      const selectedGroups = new Set(resolved.map((value) => value.groupId))
      if (selectedGroups.size !== resolved.length || selectedGroups.size !== activeGroups.length
        || activeGroups.some((group) => !selectedGroups.has(group.id))) {
        throw new CatalogError(400, 'INCOMPLETE_OPTION_COMBINATION', 'Each SKU must select exactly one value from every enabled option group')
      }
      return {
        values: resolved,
        skuId: combination.skuId?.toLowerCase(),
        salePrice: combination.salePrice,
        enabled: combination.enabled,
      }
    })

  if (desiredCombinations.length < 1 || desiredCombinations.length > 1000) {
    throw new CatalogError(400, 'SKU_LIMIT_EXCEEDED', 'A product must contain between one and 1000 requested SKU combinations')
  }
  const groupMap = new Map(normalizedGroups.map((group) => [group.id, group]))
  const combinationKeys = new Set<string>()
  const usedSkuIds = new Set<string>()
  const combinations: PlannedVariant[] = desiredCombinations.map((requested) => {
    const ids = requested.values.map((value) => value.id)
    const combinationKey = keyFor(ids)
    if (combinationKeys.has(combinationKey)) {
      throw new CatalogError(400, 'DUPLICATE_SKU_COMBINATION', 'Two SKUs cannot use the same option combination')
    }
    combinationKeys.add(combinationKey)
    const options = requested.values.map((value) => ({
      groupId: value.groupId,
      groupName: groupMap.get(value.groupId)!.name,
      valueId: value.id,
      valueName: value.name,
    })).sort((left, right) => optionSort(left, right, groupMap))
    let current: ExistingVariant | undefined
    if (requested.skuId) {
      current = existingById.get(requested.skuId)
      if (!current) throw new CatalogError(409, 'SKU_ID_CONFLICT', 'A selected SKU does not belong to this product')
      if (current.retired_at !== null) {
        throw new CatalogError(409, 'SKU_RETIRED', 'A permanently retired SKU cannot be reactivated or reused')
      }
      if (usedSkuIds.has(current.id)) throw new CatalogError(400, 'DUPLICATE_SKU_ID', 'A SKU ID may appear only once')
      if (current.combination_key === '' && combinationKey !== '') {
        throw new CatalogError(409, 'LEGACY_SKU_REMAP_PROHIBITED', 'The default SKU cannot be reassigned to a different option combination; retire or remove it and create a new SKU')
      }
    } else {
      current = existingByKey.get(combinationKey)
      if (current && current.retired_at !== null) {
        throw new CatalogError(409, 'SKU_RETIRED_COMBINATION', 'A permanently retired SKU reserves its option combination')
      }
    }

    if (current) {
      usedSkuIds.add(current.id)
      const price = requested.salePrice === undefined ? parseUnitAmount(current.sale_price).toFixed(2) : normalizePrice(requested.salePrice)
      if (current.compare_at_price !== null && !parseUnitAmount(price).lessThan(parseUnitAmount(current.compare_at_price))) {
        throw new CatalogError(400, 'INVALID_COMPARE_AT_PRICE', 'The sale price must remain below the SKU compare-at price')
      }
      const enabled = requested.enabled ?? enabledUpdates.get(current.id) ?? current.enabled
      const changed = current.combination_key !== combinationKey
        || price !== parseUnitAmount(current.sale_price).toFixed(2)
        || enabled !== current.enabled
      return {
        skuId: current.id,
        skuCode: current.sku_code,
        current,
        combinationKey,
        options,
        salePrice: price,
        enabled,
        change: changed ? 'modified' : 'retained',
        inventoryMutationBlockReason: current.combination_key !== combinationKey
          ? inventoryMutationBlockReasons.get(current.id) ?? null
          : null,
        retirementBlockReason: null,
      }
    }

    const newSalePrice = requested.salePrice ?? (body.mode === 'all' ? body.newSkuDefaults.salePrice : undefined)
    const newEnabled = requested.enabled ?? (body.mode === 'all' ? body.newSkuDefaults.enabled : undefined)
    if (newSalePrice === undefined || newEnabled === undefined) {
      throw new CatalogError(400, 'NEW_SKU_DEFAULTS_REQUIRED', 'Each new SKU requires an explicit sale price and enabled state')
    }
    return {
      skuId: undefined,
      skuCode: null,
      current: undefined,
      combinationKey,
      options,
      salePrice: normalizePrice(newSalePrice),
      enabled: newEnabled,
      change: 'added',
      inventoryMutationBlockReason: null,
      retirementBlockReason: null,
    }
  })

  for (const skuId of enabledUpdates.keys()) {
    if (!usedSkuIds.has(skuId)) {
      throw new CatalogError(409, 'SKU_ENABLED_UPDATE_NOT_IN_MATRIX', 'An enabled-state update must refer to an existing SKU retained by the requested matrix')
    }
  }

  const retireIds = (body.retireSkuIds ?? []).map((id) => id.toLowerCase())
  if (new Set(retireIds).size !== retireIds.length) {
    throw new CatalogError(400, 'DUPLICATE_RETIRED_SKU_ID', 'A retired SKU ID may appear only once')
  }
  const requestedRetirements = retireIds.map((id) => {
    const variant = existingById.get(id)
    if (!variant) throw new CatalogError(409, 'SKU_ID_CONFLICT', 'A retired SKU does not belong to this product')
    if (usedSkuIds.has(id)) throw new CatalogError(400, 'SKU_SELECTED_AND_RETIRED', 'A SKU cannot be selected and retired in the same edit')
    return variant
  })
  const retireNow = requestedRetirements.filter((variant) => variant.retired_at === null)
  const retired = currentVariants.filter((variant) => variant.retired_at !== null)
  const allRetired = [...retired, ...retireNow]
  const desiredIds = new Set(combinations.flatMap((variant) => variant.skuId ? [variant.skuId] : []))
  const retiredIds = new Set(allRetired.map((variant) => variant.id))
  const removed = currentVariants.filter((variant) => !desiredIds.has(variant.id) && !retiredIds.has(variant.id))
  const remainingCount = combinations.length + allRetired.length
  if (remainingCount > 1000) {
    throw new CatalogError(400, 'SKU_LIMIT_EXCEEDED', 'A product cannot have more than 1000 retained and requested SKUs')
  }

  const desiredKeySet = new Set(combinations.map((variant) => variant.combinationKey))
  for (const variant of allRetired) {
    if (desiredKeySet.has(variant.combination_key)) {
      throw new CatalogError(409, 'SKU_RETIRED_COMBINATION', 'A retained historical SKU reserves its option combination')
    }
    const retainedOptionIds = (existingOptions.get(variant.id) ?? []).map((option) => option.valueId)
    if (retainedOptionIds.some((id) => !valueIds.has(id))) {
      throw new CatalogError(409, 'SPECIFICATION_VALUE_IN_USE', 'A retained SKU uses an option value that cannot be removed')
    }
    const retainedGroupIds = (existingOptions.get(variant.id) ?? []).map((option) => option.groupId)
    if (retainedGroupIds.some((id) => !groupIds.has(id))) {
      throw new CatalogError(409, 'SPECIFICATION_GROUP_IN_USE', 'A retained SKU uses an option group that cannot be removed')
    }
  }

  return {
    productId,
    possibleCombinationCount,
    groups: normalizedGroups,
    values: normalizedGroups.flatMap((group) => group.values),
    combinations,
    retired,
    retireNow,
    removed,
    existingOptions,
    inventoryMutationBlockReasons,
    retirementBlockReasons,
  }
}

function oldOptions(plan: MatrixPlan, variantId: string): PlannedOption[] {
  return (plan.existingOptions.get(variantId) ?? []).map((option) => ({
    groupId: option.groupId,
    groupName: option.groupName,
    valueId: option.valueId,
    valueName: option.valueName,
  }))
}

function matrixChanges(plan: MatrixPlan): ProductVariantMatrixPreview['changes'] {
  const changes: ProductVariantMatrixPreview['changes'] = plan.combinations.map((variant) => ({
    change: variant.change,
    skuId: variant.skuId ?? null,
    skuCode: variant.skuCode,
    salePrice: variant.salePrice,
    enabled: variant.enabled,
    options: variant.options,
      inventoryMutationBlocked: variant.inventoryMutationBlockReason !== null,
      inventoryMutationBlockReason: variant.inventoryMutationBlockReason,
      retirementBlocked: false,
      retirementBlockReason: null,
  }))
  for (const variant of plan.retireNow) {
    changes.push({
      change: 'retired',
      skuId: variant.id,
      skuCode: variant.sku_code,
      salePrice: parseUnitAmount(variant.sale_price).toFixed(2),
      enabled: false,
      options: oldOptions(plan, variant.id),
      inventoryMutationBlocked: false,
      inventoryMutationBlockReason: null,
      retirementBlocked: plan.retirementBlockReasons.has(variant.id),
      retirementBlockReason: plan.retirementBlockReasons.get(variant.id) ?? null,
    })
  }
  for (const variant of plan.removed) {
    changes.push({
      change: 'removed',
      skuId: variant.id,
      skuCode: variant.sku_code,
      salePrice: parseUnitAmount(variant.sale_price).toFixed(2),
      enabled: variant.enabled,
      options: oldOptions(plan, variant.id),
      inventoryMutationBlocked: plan.inventoryMutationBlockReasons.has(variant.id),
      inventoryMutationBlockReason: plan.inventoryMutationBlockReasons.get(variant.id) ?? null,
      retirementBlocked: false,
      retirementBlockReason: null,
    })
  }
  return changes
}

export async function previewVariantMatrix(
  db: Kysely<Database>,
  productId: string,
  body: ProductVariantMatrixBody,
): Promise<ProductVariantMatrixPreview> {
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
    const plan = await planMatrix(trx, productId, body)
    return {
      productId,
      currentRevision: product.revision,
      possibleCombinationCount: plan.possibleCombinationCount,
      requestedSkuCount: plan.combinations.length + plan.retired.length + plan.retireNow.length,
      changes: matrixChanges(plan),
    }
  })
}

async function applyMatrixPlan(
  trx: Transaction<Database>,
  plan: MatrixPlan,
  identityFactory: ProductIdentityFactory,
): Promise<ProductDetail> {
  const blockedChange = plan.combinations.find((variant) => variant.inventoryMutationBlockReason)
  const blockedRemoval = plan.removed.find((variant) => plan.inventoryMutationBlockReasons.has(variant.id))
  const blockedRetirement = plan.retireNow.find((variant) => plan.retirementBlockReasons.has(variant.id))
  if (blockedChange || blockedRemoval) {
    const reason = blockedChange?.inventoryMutationBlockReason
      ?? (blockedRemoval ? plan.inventoryMutationBlockReasons.get(blockedRemoval.id) : undefined)
    throw new CatalogError(
      409,
      'SKU_HAS_REFERENCES',
      `A SKU with ${reason?.replaceAll('_', ' ')} cannot be remapped or removed; retain it as permanently retired instead`,
    )
  }
  if (blockedRetirement) {
    const reason = plan.retirementBlockReasons.get(blockedRetirement.id)
    const reserved = reason === 'reserved_quantity'
    throw new CatalogError(
      409,
      reserved ? 'SKU_STOCK_RESERVED' : 'SKU_STOCK_NOT_CLEARED',
      reserved
        ? 'A SKU with reserved quantity cannot be permanently retired; release reservations first'
        : 'Stocked quantity must be reduced to zero before permanently retiring a SKU',
    )
  }
  await sql`SET CONSTRAINTS product_variants_product_combination_unique DEFERRED`.execute(trx)

  const currentGroupById = new Map((await trx.selectFrom('product_option_groups').selectAll()
    .where('product_id', '=', plan.productId).execute()).map((group) => [group.id, group]))
  for (const group of plan.groups) {
    const current = currentGroupById.get(group.id)
    if (current) {
      if (current.name !== group.name || current.sort_order !== group.sortOrder || current.enabled !== group.enabled) {
        await trx.updateTable('product_option_groups').set({
          name: group.name, sort_order: group.sortOrder, enabled: group.enabled,
        }).where('id', '=', group.id).execute()
      }
    } else {
      await trx.insertInto('product_option_groups').values({
        id: group.id, product_id: plan.productId, name: group.name,
        sort_order: group.sortOrder, enabled: group.enabled,
      }).execute()
    }
  }

  const currentValueById = new Map((await trx.selectFrom('product_option_values').selectAll()
    .where('product_id', '=', plan.productId).execute()).map((value) => [value.id, value]))
  for (const value of plan.values) {
    const current = currentValueById.get(value.id)
    if (current) {
      if (current.name !== value.name || current.sort_order !== value.sortOrder || current.enabled !== value.enabled) {
        await trx.updateTable('product_option_values').set({
          name: value.name, sort_order: value.sortOrder, enabled: value.enabled,
        }).where('id', '=', value.id).execute()
      }
    } else {
      await trx.insertInto('product_option_values').values({
        id: value.id, product_id: plan.productId, option_group_id: value.groupId,
        name: value.name, sort_order: value.sortOrder, enabled: value.enabled,
      }).execute()
    }
  }

  for (const variant of plan.combinations) {
    if (!variant.current) continue
    const currentPrice = parseUnitAmount(variant.current.sale_price).toFixed(2)
    const changes: { combination_key?: string; sale_price?: string; enabled?: boolean } = {}
    if (variant.current.combination_key !== variant.combinationKey) changes.combination_key = variant.combinationKey
    if (currentPrice !== variant.salePrice) changes.sale_price = variant.salePrice
    if (variant.current.enabled !== variant.enabled) changes.enabled = variant.enabled
    if (Object.keys(changes).length > 0) {
      await trx.updateTable('product_variants').set(changes).where('id', '=', variant.current.id).execute()
    }
    if (variant.current.combination_key !== variant.combinationKey) {
      await trx.deleteFrom('product_variant_option_values').where('product_id', '=', plan.productId)
        .where('product_variant_id', '=', variant.current.id).execute()
      if (variant.options.length > 0) {
        await trx.insertInto('product_variant_option_values').values(variant.options.map((option) => ({
          product_id: plan.productId,
          product_variant_id: variant.current!.id,
          option_group_id: option.groupId,
          option_value_id: option.valueId,
        }))).execute()
      }
    }
  }

  const removalIds = plan.removed.map((variant) => variant.id)
  if (removalIds.length > 0) {
    await trx.deleteFrom('product_variant_quantity_inventory').where('product_id', '=', plan.productId)
      .where('product_variant_id', 'in', removalIds).execute()
    await trx.deleteFrom('product_variants').where('product_id', '=', plan.productId)
      .where('id', 'in', removalIds).execute()
  }
  const retiringIds = plan.retireNow.map((variant) => variant.id)
  if (retiringIds.length > 0) {
    await trx.updateTable('product_variants').set({ enabled: false, retired_at: new Date() })
      .where('product_id', '=', plan.productId).where('id', 'in', retiringIds).execute()
  }

  const newVariants = plan.combinations.filter((variant) => !variant.current)
  if (newVariants.length > 0) {
    const newRows = newVariants.map((variant) => {
      const id = identityFactory.nextVariantId()
      const skuCode = identityFactory.nextSkuCode()
      variant.skuId = id
      variant.skuCode = skuCode
      return {
        id,
        product_id: plan.productId,
        sku_code: skuCode,
        combination_key: variant.combinationKey,
        sale_price: variant.salePrice,
        enabled: variant.enabled,
      }
    })
    await trx.insertInto('product_variants').values(newRows).execute()
    const optionRows = newVariants.flatMap((variant) => variant.options.map((option) => ({
      product_id: plan.productId,
      product_variant_id: variant.skuId!,
      option_group_id: option.groupId,
      option_value_id: option.valueId,
    })))
    if (optionRows.length > 0) await trx.insertInto('product_variant_option_values').values(optionRows).execute()
  }

  const desiredValueIds = plan.values.map((value) => value.id)
  const desiredGroupIds = plan.groups.map((group) => group.id)
  let obsoleteValues = trx.deleteFrom('product_option_values').where('product_id', '=', plan.productId)
  obsoleteValues = desiredValueIds.length > 0
    ? obsoleteValues.where('id', 'not in', desiredValueIds)
    : obsoleteValues
  await obsoleteValues.execute()
  let obsoleteGroups = trx.deleteFrom('product_option_groups').where('product_id', '=', plan.productId)
  obsoleteGroups = desiredGroupIds.length > 0
    ? obsoleteGroups.where('id', 'not in', desiredGroupIds)
    : obsoleteGroups
  await obsoleteGroups.execute()

  await sql`SET CONSTRAINTS product_variants_product_combination_unique IMMEDIATE`.execute(trx)
  const product = await loadProduct(trx, plan.productId)
  if (!product) throw new Error('Updated product could not be read inside its transaction')
  return product
}

export async function saveVariantMatrix(
  db: Kysely<Database>,
  productId: string,
  body: ProductVariantMatrixBody,
  identityFactory: ProductIdentityFactory,
): Promise<ProductVariantMatrixSaveResult> {
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
    assertProductNotArchived(product)
    const plan = await planMatrix(trx, productId, body)
    const updatedProduct = await applyMatrixPlan(trx, plan, identityFactory)
    return { product: updatedProduct, changes: matrixChanges(plan) }
  })
}
