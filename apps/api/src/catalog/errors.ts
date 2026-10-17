import type { FastifyReply } from 'fastify'
import { failure } from '@aikayun/contracts'

export class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CatalogError'
  }
}

function conflict(code: string, message: string) {
  return { status: 409, code, message }
}

export function catalogDatabaseFailure(error: unknown): { status: number; code: string; message: string } | undefined {
  if (!error || typeof error !== 'object') return undefined
  const databaseError = error as { code?: string; constraint?: string }
  const constraint = databaseError.constraint ?? ''

  if (databaseError.code === '40001' || databaseError.code === '40P01') {
    return conflict('CATALOG_CONCURRENT_MODIFICATION', 'The catalog changed concurrently; reload it and retry')
  }
  if (databaseError.code === '23001' && databaseError.constraint === 'product_media_references_media_fkey') {
    return conflict('MEDIA_STILL_REFERENCED', 'The image is still used by a product gallery or rich content')
  }
  if (databaseError.code === '23505') {
    if (constraint === 'product_variant_inventory_adjustments_operation_unique') {
      return conflict('INVENTORY_OPERATION_ID_CONFLICT', 'This operationId has already been used')
    }
    if (constraint.includes('category') && constraint.includes('name')) {
      return conflict('CATEGORY_NAME_CONFLICT', 'A category with this name already exists at that level')
    }
    if (constraint === 'product_category_assignments_one_primary_unique') {
      return conflict('PRIMARY_CATEGORY_CONFLICT', 'A product can have only one primary category')
    }
    if (constraint === 'product_attributes_name_unique') {
      return conflict('PRODUCT_ATTRIBUTE_NAME_CONFLICT', 'Attribute names must be unique within a product')
    }
    if (constraint === 'product_option_groups_name_unique') {
      return conflict('OPTION_GROUP_NAME_CONFLICT', 'Option group names must be unique within a product')
    }
    if (constraint === 'product_option_values_name_unique') {
      return conflict('OPTION_VALUE_NAME_CONFLICT', 'Option values must be unique within a group')
    }
    if (constraint === 'product_variants_product_combination_unique') {
      return conflict('SKU_COMBINATION_CONFLICT', 'A SKU with this option combination already exists')
    }
    if (constraint === 'product_variants_sku_code_unique') {
      return conflict('SKU_CODE_CONFLICT', 'The generated SKU code already exists')
    }
    return conflict('CATALOG_IDENTITY_CONFLICT', 'A catalog identity or name already exists')
  }
  if (databaseError.code === '23503') {
    if (constraint === 'product_media_references_media_fkey') {
      return conflict('MEDIA_STILL_REFERENCED', 'The image is still used by a product gallery or rich content')
    }
    if (constraint === 'product_category_assignments_category_id_fkey') {
      return conflict('CATEGORY_HAS_PRODUCTS', 'Move or remove product category assignments before deleting this category')
    }
    if (constraint === 'product_variant_option_values_value_fkey') {
      return conflict('SPECIFICATION_VALUE_IN_USE', 'Remove or update SKU references before deleting this option value')
    }
    if (constraint === 'product_variant_option_values_group_fkey'
      || constraint === 'product_option_values_group_fkey') {
      return conflict('SPECIFICATION_GROUP_IN_USE', 'Remove or update option values and SKU references before deleting this option group')
    }
    if (constraint === 'product_variant_option_values_variant_fkey') {
      return conflict('SKU_HAS_REFERENCES', 'The SKU is referenced by catalog data and cannot be removed')
    }
    if (constraint === 'product_categories_parent_id_fkey') {
      return conflict('CATEGORY_REFERENCE_CONFLICT', 'The category has a parent or child reference that must be resolved first')
    }
    return conflict('CATALOG_REFERENCE_CONFLICT', 'A catalog item is still referenced and cannot be removed; archive the product when business history must be retained')
  }
  if (databaseError.code === '23514') {
    const known: Record<string, { status: number; code: string; message: string }> = {
      product_variants_compare_at_price_check: { status: 400, code: 'INVALID_COMPARE_AT_PRICE', message: 'Compare-at price must be non-negative, have at most two fractional digits, and exceed the sale price' },
      product_variants_cost_price_check: { status: 400, code: 'INVALID_COST_PRICE', message: 'Cost price must be non-negative with at most five fractional digits' },
      product_variants_inventory_mode_check: { status: 400, code: 'INVALID_INVENTORY_MODE', message: 'The inventory mode is not supported' },
      product_variants_inventory_revision_check: { status: 400, code: 'INVALID_INVENTORY_REVISION', message: 'The inventory revision is invalid' },
      product_variant_quantity_inventory_stocked_check: { status: 400, code: 'INVALID_INVENTORY_QUANTITY', message: 'Stocked quantity must be a non-negative integer' },
      product_variant_quantity_inventory_reserved_check: conflict('STOCK_BELOW_RESERVED_QUANTITY', 'Reserved quantity must be non-negative and cannot exceed stocked quantity'),
      product_variant_quantity_state_consistent: conflict('INVENTORY_MODE_CONFLICT', 'Quantity inventory state must match the SKU inventory mode'),
      product_variant_retirement_stocked_check: conflict('SKU_STOCK_NOT_CLEARED', 'Stocked quantity must be zero before permanently retiring a SKU'),
      product_variant_retirement_reserved_check: conflict('SKU_STOCK_RESERVED', 'Reserved quantity must be released before permanently retiring a SKU'),
      product_variant_inventory_adjustments_immutable: conflict('INVENTORY_HISTORY_IMMUTABLE', 'Inventory adjustment history cannot be changed or deleted'),
      product_variant_inventory_adjustments_action_check: { status: 400, code: 'INVALID_INVENTORY_ADJUSTMENT', message: 'The inventory adjustment action is invalid' },
      product_variant_inventory_adjustments_action_delta_check: { status: 400, code: 'INVALID_INVENTORY_ADJUSTMENT', message: 'The inventory adjustment quantity does not match its action' },
      product_variant_inventory_adjustments_quantities_check: { status: 400, code: 'INVALID_INVENTORY_ADJUSTMENT', message: 'The inventory adjustment quantities are invalid' },
      product_variant_inventory_adjustments_reason_nonempty: { status: 400, code: 'INVALID_INVENTORY_REASON', message: 'An inventory adjustment reason is required' },
      product_variant_quantity_inventory_truncate_forbidden: conflict('INVENTORY_TRUNCATE_FORBIDDEN', 'Quantity inventory cannot be truncated'),
      product_variant_inventory_adjustments_truncate_forbidden: conflict('INVENTORY_TRUNCATE_FORBIDDEN', 'Inventory adjustment history cannot be truncated'),
      product_categories_no_cycle: { status: 400, code: 'CATEGORY_CYCLE', message: 'A category cannot be moved below itself or one of its descendants' },
      product_categories_max_depth: { status: 400, code: 'CATEGORY_DEPTH_LIMIT', message: 'The category tree cannot exceed four levels' },
      product_category_tree_guard_required: conflict('CATALOG_CONCURRENT_MODIFICATION', 'The category tree changed concurrently; reload it and retry'),
      product_categories_primary_required: { status: 400, code: 'PRIMARY_CATEGORY_REQUIRED', message: 'Choose one primary category or remove all category assignments' },
      product_catalog_identity_immutable: { status: 400, code: 'CATALOG_IDENTITY_IMMUTABLE', message: 'Catalog records cannot be moved to another product' },
      product_variants_max_count: { status: 400, code: 'SKU_LIMIT_EXCEEDED', message: 'A product cannot have more than 1000 SKUs' },
      product_option_groups_max_count: { status: 400, code: 'OPTION_GROUP_LIMIT_EXCEEDED', message: 'A product cannot have more than five option groups' },
      product_option_values_max_count: { status: 400, code: 'OPTION_VALUE_LIMIT_EXCEEDED', message: 'An option group cannot have more than 50 values' },
      product_attributes_max_count: { status: 400, code: 'PRODUCT_ATTRIBUTE_LIMIT_EXCEEDED', message: 'A product cannot have more than 30 attributes' },
      product_variant_combination_key_consistent: conflict('SKU_COMBINATION_INCONSISTENT', 'The SKU option references do not match its saved combination'),
      product_variant_active_combination_required: conflict('INVALID_SKU_MATRIX', 'Every enabled SKU must have one valid value for each active option group'),
      product_requires_sku: conflict('PRODUCT_SKU_REQUIRED', 'A product must retain at least one SKU'),
      product_variant_retired_immutable: conflict('SKU_PERMANENTLY_RETIRED', 'A permanently retired SKU cannot be reactivated, rewritten, or deleted'),
      product_variant_retired_options_immutable: conflict('SKU_PERMANENTLY_RETIRED', 'A permanently retired SKU must retain its specification references'),
      product_variant_option_values_truncate_forbidden: conflict('SKU_OPTION_TRUNCATE_FORBIDDEN', 'Use catalog operations to preserve SKU combinations and product revisions'),
    }
    return known[constraint] ?? { status: 400, code: 'CATALOG_CONSTRAINT_VIOLATION', message: 'The catalog change violates a business rule' }
  }
  if (databaseError.code === '22001') {
    return { status: 400, code: 'CATALOG_VALUE_TOO_LONG', message: 'A catalog value exceeds its supported length' }
  }
  return undefined
}

export function sendCatalogError(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof CatalogError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  const known = catalogDatabaseFailure(error)
  if (!known) throw error
  return reply.code(known.status).send(failure(known.code, known.message, requestId))
}
