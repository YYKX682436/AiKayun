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

export interface AdminProductCreationRequestsTable {
  idempotency_key: string
  administrator_id: string
  payload_sha256: string
  product_id: string
  created_at: Generated<Date>
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
  purchase_limit_per_order: Generated<number | null>
  purchase_limit_lifetime: Generated<number | null>
  purchase_limit_24h: Generated<number | null>
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

export interface StorefrontCustomerPolicyTable {
  singleton: Generated<boolean>
  require_email: Generated<boolean>
  require_phone: Generated<boolean>
  guest_checkout_enabled: Generated<boolean>
  guest_free_claim_enabled: Generated<boolean>
  unpaid_order_timeout_minutes: Generated<number>
  wallet_top_up_enabled: Generated<boolean>
  wallet_top_up_min_amount: ColumnType<string, string | undefined, string>
  wallet_top_up_max_amount: ColumnType<string, string | undefined, string>
  withdrawal_enabled: Generated<boolean>
  withdrawal_min_amount: ColumnType<string, string | undefined, string>
  withdrawal_max_amount: ColumnType<string, string | undefined, string>
  withdrawal_fixed_fee: ColumnType<string, string | undefined, string>
  withdrawal_percent_fee: ColumnType<string, string | undefined, string>
  withdrawal_methods: ColumnType<WithdrawalPayoutMethod[], WithdrawalPayoutMethod[] | undefined, WithdrawalPayoutMethod[]>
  updated_at: Generated<Date>
}

export type CustomerStatus = 'active' | 'disabled' | 'deleted'

export interface CustomersTable {
  id: string
  username: string | null
  password_hash: string | null
  email: string | null
  email_verified_at: Date | null
  phone: string | null
  phone_verified_at: Date | null
  status: CustomerStatus
  purchase_limit_lock_version: Generated<string>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface CustomerSessionsTable {
  id: string
  customer_id: string
  token_hash: string
  created_at: Generated<Date>
  expires_at: ColumnType<Date, Date | string, Date | string>
  revoked_at: Date | null
}

export interface CustomerManagementAuditTable {
  id: string
  administrator_id: string
  customer_id: string
  action: 'username_updated' | 'contact_updated' | 'password_reset' | 'disabled' | 'restored' | 'deleted'
  summary: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: Generated<Date>
}

export interface CustomerCartItemsTable {
  customer_id: string
  sku_id: string
  quantity: number
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface CustomerCartMergeRequestsTable {
  customer_id: string
  merge_id: string
  request_sha256: string
  skipped_sku_ids: string[]
  created_at: Generated<Date>
}

export interface GuestOrderSessionsTable {
  id: string
  token_hash: string
  created_at: Generated<Date>
  expires_at: ColumnType<Date, Date | string, Date | string>
  revoked_at: Date | null
}

export type FulfillmentMethod = 'manual' | 'code_pool' | 'fixed_content' | 'link' | 'file' | 'api'

export interface ProductVariantFulfillmentTable {
  product_variant_id: string
  method: FulfillmentMethod
  manual_delivery_ready: Generated<boolean>
  code_pool_delivery_ready: Generated<boolean>
  updated_at: Generated<Date>
}

export type OrderStatus = 'pending_payment' | 'processing' | 'completed' | 'closed'

export interface OrdersTable {
  id: string
  customer_id: string | null
  guest_order_session_id: string | null
  idempotency_key: string
  request_sha256: string
  status: Generated<OrderStatus>
  total_amount: ColumnType<string, string, string>
  currency: Generated<'CNY'>
  items_sealed: Generated<boolean>
  created_at: Generated<Date>
  unpaid_expires_at: Date | null
  history_hidden_at: Date | null
  history_hidden_by_admin_id: string | null
  history_hidden_reason: string | null
}

export type InventoryModeSnapshot = 'quantity' | 'unlimited'
export type OrderFulfillmentStatus = 'pending' | 'processing' | 'partially_fulfilled' | 'failed' | 'unknown' | 'completed'
export interface OrderSkuOptionSnapshot {
  groupId: string
  groupName: string
  valueId: string
  valueName: string
}

export interface OrderItemsTable {
  id: string
  order_id: string
  product_id: string
  product_variant_id: string
  product_name_snapshot: string
  product_type_snapshot: ProductType
  sku_code_snapshot: string
  sku_snapshot: ColumnType<OrderSkuOptionSnapshot[], string | OrderSkuOptionSnapshot[] | undefined, string | OrderSkuOptionSnapshot[]>
  inventory_mode_snapshot: InventoryModeSnapshot
  fulfillment_method_snapshot: FulfillmentMethod
  unit_price: ColumnType<string, string, string>
  quantity: number
  line_amount: ColumnType<string, string, string>
  fulfillment_status: Generated<OrderFulfillmentStatus>
  fulfilled_quantity: Generated<number>
  fulfillment_reserved_quantity: Generated<number>
  created_at: Generated<Date>
}

export interface OrderInventoryReservationsTable {
  id: string
  order_item_id: string
  product_id: string
  product_variant_id: string
  quantity: number
  created_at: Generated<Date>
}

export type OrderInventoryAction = 'reserve' | 'release' | 'consume' | 'restock' | 'withdraw'

export interface OrderInventoryEventsTable {
  id: string
  reservation_id: string | null
  product_variant_id: string | null
  code_pool_batch_id: string | null
  operation_id: string
  action: OrderInventoryAction
  quantity: number
  created_at: Generated<Date>
}

export type CodePoolBatchKind = 'import' | 'withdrawal'
export interface CodePoolBatchesTable {
  id: string
  product_id: string
  product_variant_id: string
  operation_id: string
  kind: CodePoolBatchKind
  request_sha256: string
  request_fingerprint_key_id: string | null
  requested_count: number
  accepted_count: number
  duplicate_count: number
  invalid_count: number
  reason: string | null
  created_by_admin_id: string
  created_at: Generated<Date>
}

export type CodePoolEntryState = 'staged' | 'available' | 'reserved' | 'delivered' | 'revoked'
export interface CodePoolEntriesTable {
  id: string
  product_id: string
  product_variant_id: string
  import_batch_id: string
  ciphertext: Buffer
  nonce: Buffer
  auth_tag: Buffer
  encryption_key_id: string
  content_fingerprint: string
  fingerprint_key_id: string
  state: CodePoolEntryState
  order_item_id: string | null
  withdrawal_batch_id: string | null
  created_at: Generated<Date>
  reserved_at: Date | null
  delivered_at: Date | null
  revoked_at: Date | null
}

export interface CodePoolWithdrawalEntriesTable {
  batch_id: string
  product_id: string
  product_variant_id: string
  entry_id: string
  created_at: Generated<Date>
}

export interface WalletAccountsTable {
  customer_id: string
  cash_available: ColumnType<string, string | undefined, string>
  cash_frozen: ColumnType<string, string | undefined, string>
  gift_available: ColumnType<string, string | undefined, string>
  gift_frozen: ColumnType<string, string | undefined, string>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type WalletOperationType =
  | 'top_up' | 'order_payment' | 'refund' | 'gift' | 'withdrawal_freeze'
  | 'withdrawal_release' | 'withdrawal_complete' | 'order_payment_hold'
  | 'order_payment_settlement' | 'order_payment_release' | 'adjustment'

export interface WalletOperationsTable {
  id: string
  customer_id: string
  order_id: Generated<string | null>
  resolves_operation_id: Generated<string | null>
  requested_amount: Generated<string | null>
  operation_type: WalletOperationType
  request_sha256: string
  actor_admin_id: string | null
  created_at: Generated<Date>
}

export type PaymentAttemptSource = 'external' | 'wallet'
export type PaymentAttemptStatus =
  | 'created' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'cancelled'
  | 'late_succeeded' | 'reconciliation_required'

export interface PaymentAttemptsTable {
  id: string
  idempotency_key: string
  request_sha256: string
  order_id: string | null
  topup_customer_id: string | null
  source: PaymentAttemptSource
  amount: ColumnType<string, string, string>
  status: Generated<PaymentAttemptStatus>
  provider: string | null
  provider_payment_id: string | null
  wallet_operation_id: string | null
  wallet_hold_operation_id: Generated<string | null>
  requested_wallet_amount: Generated<string | null>
  created_at: Generated<Date>
  expires_at: Date | null
  completed_at: Date | null
  payment_channel_id: Generated<string | null>
  provider_type_snapshot: Generated<'zpay_epay_v1' | null>
  payment_method_snapshot: Generated<'alipay' | 'wechat' | null>
  payment_channel_name_snapshot: Generated<string | null>
  channel_credential_version: Generated<number | null>
  merchant_order_no: Generated<string | null>
}

export type PaymentProviderType = 'zpay_epay_v1' | 'codepay_unconfigured'
export type ExternalPaymentMethod = 'alipay' | 'wechat'

export interface PaymentChannelsTable {
  id: string
  provider_type: PaymentProviderType
  name: string
  enabled: boolean
  payment_methods: ColumnType<string[], string[], string[]>
  display_order: number
  config_ciphertext: Buffer | null
  config_nonce: Buffer | null
  config_auth_tag: Buffer | null
  config_key_id: string | null
  credential_version: number
  created_by_admin_id: string
  updated_by_admin_id: string
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface PaymentChannelAuditEventsTable {
  id: string
  payment_channel_id: string
  administrator_id: string
  action: 'created' | 'updated' | 'encryption_reencrypted'
  summary: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: Generated<Date>
}

export interface PaymentAttemptSecretsTable {
  payment_attempt_id: string
  envelope_version: number
  config_version: number
  key_id: string
  nonce: Buffer
  ciphertext: Buffer
  auth_tag: Buffer
  created_at: Generated<Date>
}

export type PaymentProviderRequestState = 'requesting' | 'ready' | 'unknown' | 'failed'

export interface PaymentAttemptProviderStateTable {
  payment_attempt_id: string
  state: PaymentProviderRequestState
  action: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>
  provider_order_id: string | null
  last_error_code: string | null
  request_started_at: Generated<Date>
  last_query_at: Date | null
  updated_at: Generated<Date>
}

export type ProviderEventSource = 'callback' | 'query'
export type ProviderEventDisposition =
  | 'settled' | 'duplicate' | 'not_paid' | 'pending_confirmation' | 'reconciliation_required' | 'unknown'

export interface PaymentProviderEventsTable {
  id: string
  payment_attempt_id: string
  source: ProviderEventSource
  event_sha256: string
  verification: 'verified' | 'unverified'
  disposition: ProviderEventDisposition
  provider_status: 'paid' | 'pending' | 'failed' | 'unknown'
  provider_transaction_id: string | null
  reported_amount: ColumnType<string | null, string | null, string | null>
  currency: Generated<'CNY'>
  provider_paid_at: Date | null
  provider_time_text: string | null
  payload: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  error_code: string | null
  received_at: Generated<Date>
}

export type PaymentProviderReconciliationReason =
  | 'callback_query_mismatch' | 'provider_identity_conflict' | 'provider_transaction_conflict'
  | 'provider_amount_mismatch' | 'receipt_conflict' | 'late_confirmed_payment'

export interface PaymentProviderReconciliationCasesTable {
  id: string
  payment_attempt_id: string
  reason: PaymentProviderReconciliationReason
  opening_callback_event_id: string | null
  opening_query_event_id: string | null
  state: 'open' | 'resolved'
  opened_at: Generated<Date>
  resolved_at: Date | null
  resolved_by_admin_id: string | null
  resolution_query_event_sha256: string | null
  resolution_provider_transaction_id: string | null
  resolution_payment_method: 'alipay' | 'wechat' | null
  resolution_confirmed_amount: ColumnType<string | null, string | null, string | null>
  resolution_currency: 'CNY' | null
  resolution_payload: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>
}

export type PaymentReceiptBucket = 'external' | 'cash' | 'gift'
export type PaymentReceiptDisposition = 'on_time' | 'late' | 'excess' | 'amount_mismatch'

export interface PaymentReceiptsTable {
  id: string
  payment_attempt_id: string
  source_bucket: PaymentReceiptBucket
  provider: string | null
  provider_transaction_id: string | null
  wallet_operation_id: string | null
  wallet_line_no: number | null
  amount: ColumnType<string, string, string>
  disposition: Generated<PaymentReceiptDisposition>
  refund_reserved_amount: Generated<ColumnType<string, string | undefined, string>>
  refunded_amount: Generated<ColumnType<string, string | undefined, string>>
  received_at: Generated<Date>
}

export type RefundStatus =
  | 'requested' | 'approved' | 'processing' | 'partially_succeeded'
  | 'succeeded' | 'failed' | 'cancelled'

export interface OrderRefundsTable {
  id: string
  order_id: string
  idempotency_key: string
  request_sha256: string
  amount: ColumnType<string, string, string>
  status: Generated<RefundStatus>
  reason: string
  rejection_reason: string | null
  reviewed_by_admin_id: string | null
  reviewed_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type RefundDestination = 'original_source' | 'cash_balance' | 'gift_balance'
export type RefundAllocationStatus = 'reserved' | 'succeeded' | 'released'

export interface OrderRefundAllocationsTable {
  id: string
  refund_id: string
  source_payment_receipt_id: string
  operation_id: string
  request_sha256: string
  destination: RefundDestination
  amount: ColumnType<string, string, string>
  status: Generated<RefundAllocationStatus>
  provider: string | null
  provider_refund_id: string | null
  created_at: Generated<Date>
  completed_at: Date | null
}

export type RefundAuditActorType = 'customer' | 'guest' | 'admin' | 'system'

export interface OrderRefundAuditEventsTable {
  id: string
  refund_id: string
  action: string
  actor_type: RefundAuditActorType
  actor_customer_id: string | null
  actor_admin_id: string | null
  idempotency_key: string | null
  request_sha256: string | null
  previous_status: RefundStatus | null
  next_status: RefundStatus | null
  details: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: Generated<Date>
}

export type RefundManualAttemptStatus = 'started' | 'unknown' | 'succeeded' | 'failed'

export interface OrderRefundManualAttemptsTable {
  id: string
  allocation_id: string
  idempotency_key: string
  request_sha256: string
  started_by_admin_id: string
  resolved_by_admin_id: string | null
  status: Generated<RefundManualAttemptStatus>
  provider_reference: string | null
  refunded_amount: ColumnType<string | null, string | null, string | null>
  actual_refunded_at: Date | null
  evidence_summary: string | null
  resolution_note: string | null
  result_sha256: string | null
  created_at: Generated<Date>
  completed_at: Date | null
}

export type WalletBucket = 'cash' | 'gift'
export type WalletEntryAction = 'credit_available' | 'debit_available' | 'freeze' | 'unfreeze' | 'debit_frozen'

export interface WalletLedgerEntriesTable {
  id: string
  wallet_operation_id: string
  line_no: number
  customer_id: string
  bucket: WalletBucket
  action: WalletEntryAction
  amount: ColumnType<string, string, string>
  payment_attempt_id: string | null
  refund_allocation_id: string | null
  withdrawal_id: string | null
  created_at: Generated<Date>
}

export type WithdrawalStatus =
  | 'pending_review' | 'pending_transfer' | 'transfer_processing' | 'transfer_uncertain'
  | 'completed' | 'rejected' | 'cancelled'

export interface WithdrawalsTable {
  id: string
  customer_id: string
  idempotency_key: string
  request_sha256: string
  wallet_operation_id: string
  amount: ColumnType<string, string, string>
  fee_amount: ColumnType<string, string, string>
  payout_amount: ColumnType<string, string, string>
  payout_method: 'alipay' | 'wechat' | 'bank_card'
  recipient_snapshot: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  status: Generated<WithdrawalStatus>
  reviewed_by_admin_id: string | null
  reviewed_at: Date | null
  rejection_reason: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type WithdrawalPayoutAttemptStatus = 'started' | 'unknown' | 'succeeded' | 'failed'

export interface WithdrawalPayoutAttemptsTable {
  id: string
  withdrawal_id: string
  operation_id: string
  started_by_admin_id: string
  resolved_by_admin_id: Generated<string | null>
  result_sha256: Generated<string | null>
  status: Generated<WithdrawalPayoutAttemptStatus>
  provider_reference: string | null
  created_at: Generated<Date>
  completed_at: Date | null
}

export type WithdrawalPayoutMethod = 'alipay' | 'wechat' | 'bank_card'
export type WithdrawalAuditActorType = 'customer' | 'admin' | 'system'

export interface WithdrawalAuditEventsTable {
  id: string
  withdrawal_id: string
  action: string
  actor_type: WithdrawalAuditActorType
  actor_customer_id: string | null
  actor_admin_id: string | null
  idempotency_key: string | null
  request_sha256: string | null
  previous_status: string | null
  next_status: string | null
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>
  created_at: Generated<Date>
}

export interface WithdrawalSettingsAuditEventsTable {
  id: string
  administrator_id: string
  before_settings: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  after_settings: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: Generated<Date>
}

export interface WithdrawalPrivateFilesTable {
  id: string
  customer_id: string
  withdrawal_id: string | null
  mime_type: 'image/jpeg' | 'image/png' | 'image/webp'
  size_bytes: number
  sha256: string
  content: Buffer
  created_at: Generated<Date>
}

export interface WithdrawalPayoutResultsTable {
  attempt_id: string
  outcome: 'succeeded' | 'failed'
  resolved_by_admin_id: string
  provider_reference: string | null
  actual_payout_amount: ColumnType<string | null, string | null, string | null>
  actual_payout_at: Date | null
  confirmed_no_transfer: boolean
  evidence_sha256: string
  evidence_summary: string
  result_sha256: string
  created_at: Generated<Date>
}

export type FulfillmentAttemptStatus = 'processing' | 'unknown' | 'succeeded' | 'failed'

export interface OrderItemFulfillmentAttemptsTable {
  id: string
  order_item_id: string
  operation_id: string
  quantity: number
  started_by_admin_id: string | null
  status: Generated<FulfillmentAttemptStatus>
  result_sha256: string | null
  delivery_source: Generated<'manual' | 'code_pool'>
  failure_code: string | null
  retry_after: Date | null
  created_at: Generated<Date>
  completed_at: Date | null
}

export interface OrderItemFulfillmentDeliveriesTable {
  id: string
  fulfillment_attempt_id: string
  started_by_admin_id: string | null
  unit_index: number
  content: string | null
  content_sha256: string
  delivery_source: Generated<'manual' | 'code_pool'>
  encrypted_content: Buffer | null
  content_nonce: Buffer | null
  content_auth_tag: Buffer | null
  encryption_key_id: string | null
  code_pool_entry_id: string | null
  created_at: Generated<Date>
}

export interface OrderStatusEventsTable {
  id: string
  operation_id: string
  order_id: string
  previous_status: OrderStatus
  next_status: OrderStatus
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
  purchase_limit_per_order: Generated<number | null>
  purchase_limit_lifetime: Generated<number | null>
  purchase_limit_24h: Generated<number | null>
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
  admin_product_creation_requests: AdminProductCreationRequestsTable
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
  storefront_customer_policy: StorefrontCustomerPolicyTable
  customers: CustomersTable
  customer_sessions: CustomerSessionsTable
  customer_management_audit: CustomerManagementAuditTable
  customer_cart_items: CustomerCartItemsTable
  customer_cart_merge_requests: CustomerCartMergeRequestsTable
  guest_order_sessions: GuestOrderSessionsTable
  product_variant_fulfillment: ProductVariantFulfillmentTable
  orders: OrdersTable
  order_items: OrderItemsTable
  order_inventory_reservations: OrderInventoryReservationsTable
  order_inventory_events: OrderInventoryEventsTable
  code_pool_batches: CodePoolBatchesTable
  code_pool_entries: CodePoolEntriesTable
  code_pool_withdrawal_entries: CodePoolWithdrawalEntriesTable
  wallet_accounts: WalletAccountsTable
  wallet_operations: WalletOperationsTable
  payment_attempts: PaymentAttemptsTable
  payment_receipts: PaymentReceiptsTable
  payment_channels: PaymentChannelsTable
  payment_channel_audit_events: PaymentChannelAuditEventsTable
  payment_attempt_secrets: PaymentAttemptSecretsTable
  payment_attempt_provider_state: PaymentAttemptProviderStateTable
  payment_provider_events: PaymentProviderEventsTable
  payment_provider_reconciliation_cases: PaymentProviderReconciliationCasesTable
  order_refunds: OrderRefundsTable
  order_refund_allocations: OrderRefundAllocationsTable
  order_refund_audit_events: OrderRefundAuditEventsTable
  order_refund_manual_attempts: OrderRefundManualAttemptsTable
  wallet_ledger_entries: WalletLedgerEntriesTable
  withdrawals: WithdrawalsTable
  withdrawal_payout_attempts: WithdrawalPayoutAttemptsTable
  withdrawal_audit_events: WithdrawalAuditEventsTable
  withdrawal_settings_audit_events: WithdrawalSettingsAuditEventsTable
  withdrawal_private_files: WithdrawalPrivateFilesTable
  withdrawal_payout_results: WithdrawalPayoutResultsTable
  order_item_fulfillment_attempts: OrderItemFulfillmentAttemptsTable
  order_item_fulfillment_deliveries: OrderItemFulfillmentDeliveriesTable
  order_status_events: OrderStatusEventsTable
}
