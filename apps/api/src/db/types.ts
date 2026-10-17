import type { ColumnType, Generated } from 'kysely'
import type { ProductRichContent } from '@aikayun/contracts'

export type ProductMediaReferenceSource = 'gallery' | 'rich_content'

export interface AdminUsersTable {
  id: string
  email: string
  password_hash: string
  is_active: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface AdminSessionsTable {
  id: string
  admin_user_id: string
  token_hash: string
  created_at: Generated<Date>
  expires_at: ColumnType<Date, Date | string, Date | string>
  revoked_at: Date | null
}

export type ProductType = 'physical' | 'digital' | 'service'
export type ProductStatus = 'draft' | 'active' | 'paused' | 'archived'
export type ProductInventoryMode = 'quantity' | 'resource_pool' | 'unlimited' | 'external'

export interface ProductsTable {
  id: string
  name: string
  description: string
  rich_content: ColumnType<ProductRichContent, ProductRichContent | undefined, ProductRichContent>
  product_type: ProductType
  status: ProductStatus
  revision: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ProductMediaTable {
  id: string
  created_at: Generated<Date>
}

export type ProductMediaVariantName = 'thumbnail' | 'card' | 'detail'

export interface ProductMediaVariantsTable {
  media_id: string
  variant: ProductMediaVariantName
  storage_key: string
  format: 'webp'
  width: number
  height: number
  size_bytes: number
  sha256: string
  processing_version: string
  created_at: Generated<Date>
}

export interface ProductMediaReferencesTable {
  product_id: string
  media_id: string
  source: ProductMediaReferenceSource
  sort_order: number | null
  created_at: Generated<Date>
}

export interface ProductVariantsTable {
  id: string
  product_id: string
  sku_code: string
  /** Empty for the default SKU; future keys are canonicalized by the server. */
  combination_key: string
  /** PostgreSQL NUMERIC is returned as a string by node-postgres. */
  sale_price: ColumnType<string, string, string>
  compare_at_price: ColumnType<string | null, string | null, string | null>
  cost_price: ColumnType<string | null, string | null, string | null>
  enabled: Generated<boolean>
  retired_at: Generated<Date | null>
  inventory_mode: ProductInventoryMode | null
  inventory_revision: Generated<number>
  revision: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ProductVariantQuantityInventoryTable {
  product_id: string
  product_variant_id: string
  stocked: number
  reserved: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type InventoryAdjustmentAction = 'increase' | 'decrease' | 'set'

export interface ProductVariantInventoryAdjustmentsTable {
  id: string
  product_id: string
  product_variant_id: string
  operation_id: string
  administrator_id: string
  action: InventoryAdjustmentAction
  requested_quantity: number
  quantity_before: number
  quantity_after: number
  quantity_delta: number
  inventory_revision: number
  reason: string
  created_at: Generated<Date>
}

export interface ProductCategoriesTable {
  id: string
  parent_id: string | null
  name: string
  sort_order: number
  is_visible: Generated<boolean>
  revision: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ProductCategoryAssignmentsTable {
  product_id: string
  category_id: string
  is_primary: Generated<boolean>
  sort_order: number
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ProductAttributesTable {
  id: string
  product_id: string
  name: string
  value: string
  sort_order: number
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ProductOptionGroupsTable {
  id: string
  product_id: string
  name: string
  sort_order: number
  enabled: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ProductOptionValuesTable {
  id: string
  product_id: string
  option_group_id: string
  name: string
  sort_order: number
  enabled: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ProductVariantOptionValuesTable {
  product_id: string
  product_variant_id: string
  option_group_id: string
  option_value_id: string
  created_at: Generated<Date>
}

export type ProductManagementOperation =
  | 'created' | 'updated' | 'published' | 'paused' | 'relisted' | 'archived' | 'restored' | 'copied' | 'deleted'
  | 'gallery_updated' | 'rich_content_updated'

export interface ProductManagementAuditEventsTable {
  id: string
  product_id: string
  administrator_id: string
  operation: ProductManagementOperation
  before_data: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null, never>
  after_data: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null, never>
  created_at: Generated<Date>
}

export interface Database {
  admin_users: AdminUsersTable
  admin_sessions: AdminSessionsTable
  products: ProductsTable
  product_variants: ProductVariantsTable
  product_variant_quantity_inventory: ProductVariantQuantityInventoryTable
  product_variant_inventory_adjustments: ProductVariantInventoryAdjustmentsTable
  product_categories: ProductCategoriesTable
  product_category_assignments: ProductCategoryAssignmentsTable
  product_attributes: ProductAttributesTable
  product_option_groups: ProductOptionGroupsTable
  product_option_values: ProductOptionValuesTable
  product_variant_option_values: ProductVariantOptionValuesTable
  product_management_audit_events: ProductManagementAuditEventsTable
  product_media: ProductMediaTable
  product_media_variants: ProductMediaVariantsTable
  product_media_references: ProductMediaReferencesTable
}
