import { Type, type Static, type TSchema } from 'typebox'

export const RequestMetaSchema = Type.Object({
  requestId: Type.String(),
})

export const ApiSuccessSchema = Type.Object({
  data: Type.Unknown(),
  meta: RequestMetaSchema,
})

export const ApiErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
  meta: RequestMetaSchema,
})

export const HealthSchema = Type.Object({
  status: Type.Literal('ok'),
  service: Type.Literal('aikayun-api'),
})

export const CsrfTokenSchema = Type.Object({
  csrfToken: Type.String({ minLength: 32 }),
})

export const AdminLoginBodySchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254, format: 'email' }),
  password: Type.String({ minLength: 1, maxLength: 1024 }),
}, { additionalProperties: false })

export const AdminSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String({ format: 'email' }),
})

export const AdminSessionSchema = Type.Object({
  admin: AdminSchema,
  expiresAt: Type.String({ format: 'date-time' }),
})

export const AdminLogoutSchema = Type.Object({ loggedOut: Type.Literal(true) })
export const AdminOverviewSchema = Type.Object({
  administrator: Type.String({ format: 'email' }),
  status: Type.Literal('ready'),
})

export const CustomerUsernameSchema = Type.String({
  minLength: 3,
  maxLength: 32,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$',
  description: '3-32 ASCII letters, digits, underscores, dots or hyphens; starts with a letter or digit',
})
export const CustomerPasswordSchema = Type.String({ minLength: 12, maxLength: 128 })
export const CustomerEmailSchema = Type.String({ minLength: 3, maxLength: 254, format: 'email' })
export const CustomerPhoneSchema = Type.String({
  minLength: 7,
  maxLength: 32,
  pattern: '^\\+?[0-9][0-9 ()-]{5,30}[0-9]$',
})

export const CustomerRegisterBodySchema = Type.Object({
  username: CustomerUsernameSchema,
  password: CustomerPasswordSchema,
  email: Type.Optional(CustomerEmailSchema),
  phone: Type.Optional(CustomerPhoneSchema),
}, { additionalProperties: false })

export const CustomerLoginBodySchema = Type.Object({
  username: CustomerUsernameSchema,
  password: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false })

export const CustomerSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  username: CustomerUsernameSchema,
})

export const CustomerSessionSchema = Type.Object({
  customer: CustomerSchema,
  expiresAt: Type.String({ format: 'date-time' }),
})

export const CustomerProfileSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  username: CustomerUsernameSchema,
  email: Type.Union([CustomerEmailSchema, Type.Null()]),
  emailVerifiedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  phone: Type.Union([CustomerPhoneSchema, Type.Null()]),
  phoneVerifiedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const UpdateCustomerProfileBodySchema = Type.Object({
  email: Type.Optional(Type.Union([CustomerEmailSchema, Type.Null()])),
  phone: Type.Optional(Type.Union([CustomerPhoneSchema, Type.Null()])),
}, { additionalProperties: false, minProperties: 1 })

export const ChangeCustomerPasswordBodySchema = Type.Object({
  currentPassword: Type.String({ minLength: 1, maxLength: 128 }),
  newPassword: CustomerPasswordSchema,
}, { additionalProperties: false })

export const CustomerPasswordChangedSchema = Type.Object({
  passwordChanged: Type.Literal(true),
  expiresAt: Type.String({ format: 'date-time' }),
})
export const CustomerLogoutSchema = Type.Object({ loggedOut: Type.Literal(true) })

export const AdminCustomerStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('disabled'),
  Type.Literal('deleted'),
])
export const AdminCustomerListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  status: Type.Optional(Type.Union([
    Type.Literal('all'),
    Type.Literal('active'),
    Type.Literal('disabled'),
    Type.Literal('deleted'),
  ])),
  sortOrder: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
}, { additionalProperties: false })
export const AdminCustomerOrdersQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })
export const AdminCustomerIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
export const AdminCustomerListItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  username: Type.Union([CustomerUsernameSchema, Type.Null()]),
  email: Type.Union([CustomerEmailSchema, Type.Null()]),
  phone: Type.Union([CustomerPhoneSchema, Type.Null()]),
  status: AdminCustomerStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminCustomerListSchema = Type.Object({
  items: Type.Array(AdminCustomerListItemSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const AdminCustomerDetailSchema = Type.Object({
  customer: Type.Intersect([
    AdminCustomerListItemSchema,
    Type.Object({
      emailVerifiedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      phoneVerifiedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    }),
  ]),
}, { additionalProperties: false })
export const AdminCustomerProfileUpdateBodySchema = Type.Object({
  username: Type.Optional(CustomerUsernameSchema),
  email: Type.Optional(Type.Union([CustomerEmailSchema, Type.Null()])),
  phone: Type.Optional(Type.Union([CustomerPhoneSchema, Type.Null()])),
}, { additionalProperties: false, minProperties: 1 })
export const AdminCustomerStatusBodySchema = Type.Object({
  status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
}, { additionalProperties: false })
export const AdminCustomerPasswordResetBodySchema = Type.Object({
  temporaryPassword: CustomerPasswordSchema,
}, { additionalProperties: false })
export const AdminCustomerStatusResultSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: AdminCustomerStatusSchema,
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminCustomerPasswordResetResultSchema = Type.Object({
  passwordReset: Type.Literal(true),
  revokedSessionCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const AdminCustomerDeleteResultSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  deleted: Type.Literal(true),
}, { additionalProperties: false })
export const AdminCustomerOrderStatusSchema = Type.Union([
  Type.Literal('pending_payment'),
  Type.Literal('processing'),
  Type.Literal('completed'),
  Type.Literal('closed'),
])
export const AdminCustomerOrderSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: AdminCustomerOrderStatusSchema,
  customerStatus: Type.Union([
    Type.Literal('refunded'), Type.Literal('closed'), Type.Literal('completed'),
    Type.Literal('pending_payment'), Type.Literal('awaiting_fulfillment'), Type.Literal('in_progress'),
  ]),
  paymentStatus: Type.Union([
    Type.Literal('not_required'), Type.Literal('refunded'), Type.Literal('partially_refunded'),
    Type.Literal('late_paid'), Type.Literal('requires_reconciliation'), Type.Literal('unpaid'),
    Type.Literal('overpaid'), Type.Literal('partially_paid'), Type.Literal('paid'),
  ]),
  refundStatus: Type.Union([
    Type.Literal('refunded'), Type.Literal('processing'), Type.Literal('partially_refunded'),
    Type.Literal('requested_or_processing'), Type.Literal('none'),
  ]),
  totalAmount: Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' }),
  currency: Type.Literal('CNY'),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminCustomerOrderPageSchema = Type.Object({
  items: Type.Array(AdminCustomerOrderSummarySchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CustomerManagementAuditActionSchema = Type.Union([
  Type.Literal('username_updated'),
  Type.Literal('contact_updated'),
  Type.Literal('password_reset'),
  Type.Literal('disabled'),
  Type.Literal('restored'),
  Type.Literal('deleted'),
])
export const CustomerManagementAuditSummarySchema = Type.Object({
  changedFields: Type.Optional(Type.Array(Type.String())),
  clearedFields: Type.Optional(Type.Array(Type.String())),
  previousStatus: Type.Optional(AdminCustomerStatusSchema),
  newStatus: Type.Optional(AdminCustomerStatusSchema),
  revokedSessionCount: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false })
export const AdminCustomerAuditEventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  administratorId: Type.String({ format: 'uuid' }),
  administratorEmail: Type.String({ format: 'email' }),
  customerId: Type.String({ format: 'uuid' }),
  action: CustomerManagementAuditActionSchema,
  summary: CustomerManagementAuditSummarySchema,
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminCustomerAuditPageSchema = Type.Object({
  items: Type.Array(AdminCustomerAuditEventSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const StorefrontCustomerPolicySchema = Type.Object({
  requireEmail: Type.Boolean(),
  requirePhone: Type.Boolean(),
  guestCheckoutEnabled: Type.Boolean(),
  guestFreeClaimEnabled: Type.Boolean(),
  unpaidOrderTimeoutMinutes: Type.Union([Type.Literal(5), Type.Literal(15), Type.Literal(30)]),
  walletTopUpEnabled: Type.Boolean(),
  walletTopUpMinAmount: Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' }),
  walletTopUpMaxAmount: Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const UpdateStorefrontCustomerPolicyBodySchema = Type.Object({
  requireEmail: Type.Boolean(),
  requirePhone: Type.Boolean(),
  guestCheckoutEnabled: Type.Boolean(),
  guestFreeClaimEnabled: Type.Boolean(),
  unpaidOrderTimeoutMinutes: Type.Union([Type.Literal(5), Type.Literal(15), Type.Literal(30)]),
  walletTopUpEnabled: Type.Optional(Type.Boolean()),
  walletTopUpMinAmount: Type.Optional(Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' })),
  walletTopUpMaxAmount: Type.Optional(Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' })),
}, { additionalProperties: false })

export const ProductTypeSchema = Type.Union([
  Type.Literal('physical'),
  Type.Literal('digital'),
  Type.Literal('service'),
])

export const ProductStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('archived'),
])

export const ProductSalePriceSchema = Type.String({
  pattern: '^(?:0|[1-9]\\d{0,12})(?:\\.\\d{1,2})?(?![\\s\\S])',
  description: 'Non-negative CNY amount with at most 13 integer and 2 fractional digits',
})

export const ProductCostPriceSchema = Type.String({
  pattern: '^(?:0|[1-9]\\d{0,12})(?:\\.\\d{1,5})?(?![\\s\\S])',
  description: 'Non-negative internal CNY cost with at most 13 integer and 5 fractional digits',
})

export const ProductInventoryModeSchema = Type.Union([
  Type.Literal('quantity'),
  Type.Literal('resource_pool'),
  Type.Literal('unlimited'),
  Type.Literal('external'),
])

export const FulfillmentMethodSchema = Type.Union([
  Type.Literal('manual'), Type.Literal('code_pool'), Type.Literal('fixed_content'),
  Type.Literal('link'), Type.Literal('file'), Type.Literal('api'),
])

export const NullableProductInventoryModeSchema = Type.Union([
  ProductInventoryModeSchema,
  Type.Null(),
])

export const AdminProductVariantPricesSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  productRevision: Type.Integer({ minimum: 1 }),
  skuId: Type.String({ format: 'uuid' }),
  skuCode: Type.String({ minLength: 1, maxLength: 64 }),
  skuRevision: Type.Integer({ minimum: 1 }),
  salePrice: ProductSalePriceSchema,
  compareAtPrice: Type.Union([ProductSalePriceSchema, Type.Null()]),
  costPrice: Type.Union([ProductCostPriceSchema, Type.Null()]),
  currency: Type.Literal('CNY'),
  retiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const AdminProductVariantPricesQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false })

export const AdminProductVariantPricesPageSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  productRevision: Type.Integer({ minimum: 1 }),
  items: Type.Array(AdminProductVariantPricesSchema, { maxItems: 100 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  total: Type.Integer({ minimum: 0 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const UpdateAdminProductVariantPricesBatchBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  updates: Type.Array(Type.Object({
    skuId: Type.String({ format: 'uuid' }),
    expectedSkuRevision: Type.Integer({ minimum: 1 }),
    salePrice: Type.Optional(ProductSalePriceSchema),
    compareAtPrice: Type.Optional(Type.Union([ProductSalePriceSchema, Type.Null()])),
    costPrice: Type.Optional(Type.Union([ProductCostPriceSchema, Type.Null()])),
  }, { additionalProperties: false, minProperties: 3 }), { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })

export const AdminProductVariantPricesBatchResultSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  productRevision: Type.Integer({ minimum: 1 }),
  items: Type.Array(AdminProductVariantPricesSchema, { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })

export const UpdateAdminProductVariantPricesBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  expectedSkuRevision: Type.Integer({ minimum: 1 }),
  salePrice: Type.Optional(ProductSalePriceSchema),
  compareAtPrice: Type.Optional(Type.Union([ProductSalePriceSchema, Type.Null()])),
  costPrice: Type.Optional(Type.Union([ProductCostPriceSchema, Type.Null()])),
}, { additionalProperties: false, minProperties: 3 })

export const ProductInventoryStatusSchema = Type.Object({
  mode: NullableProductInventoryModeSchema,
  configured: Type.Boolean(),
  hasTrustedQuantity: Type.Boolean(),
  stocked: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  reserved: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  available: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  sufficient: Type.Union([Type.Boolean(), Type.Null()]),
  sourceReady: Type.Boolean(),
  status: Type.Union([
    Type.Literal('not_configured'),
    Type.Literal('ready'),
    Type.Literal('not_ready'),
  ]),
}, { additionalProperties: false })

export const AdminProductVariantInventorySchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  productRevision: Type.Integer({ minimum: 1 }),
  skuId: Type.String({ format: 'uuid' }),
  skuCode: Type.String({ minLength: 1, maxLength: 64 }),
  skuRevision: Type.Integer({ minimum: 1 }),
  inventoryRevision: Type.Integer({ minimum: 0 }),
  enabled: Type.Boolean(),
  retiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  inventory: ProductInventoryStatusSchema,
}, { additionalProperties: false })

export const AdminProductInventorySummarySchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  productRevision: Type.Integer({ minimum: 1 }),
  requestedQuantity: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  variants: Type.Array(AdminProductVariantInventorySchema),
}, { additionalProperties: false })

export const ProductInventorySummaryQuerySchema = Type.Object({
  quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
}, { additionalProperties: false })

export const UpdateProductInventoryModeBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  expectedSkuRevision: Type.Integer({ minimum: 1 }),
  expectedInventoryRevision: Type.Integer({ minimum: 0 }),
  inventoryMode: NullableProductInventoryModeSchema,
}, { additionalProperties: false })

const InventoryAdjustmentCommonSchema = {
  expectedInventoryRevision: Type.Integer({ minimum: 0 }),
  operationId: Type.String({ format: 'uuid' }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}

export const CreateInventoryAdjustmentBodySchema = Type.Union([
  Type.Object({
    ...InventoryAdjustmentCommonSchema,
    action: Type.Literal('increase'),
    quantity: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...InventoryAdjustmentCommonSchema,
    action: Type.Literal('decrease'),
    quantity: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...InventoryAdjustmentCommonSchema,
    action: Type.Literal('set'),
    quantity: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  }, { additionalProperties: false }),
])

export const InventoryAdjustmentSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  administratorId: Type.String({ format: 'uuid' }),
  action: Type.Union([Type.Literal('increase'), Type.Literal('decrease'), Type.Literal('set')]),
  requestedQuantity: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  quantityBefore: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  quantityAfter: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  quantityDelta: Type.Integer({ minimum: -2_147_483_647, maximum: 2_147_483_647 }),
  inventoryRevision: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const InventoryAdjustmentCursorSchema = Type.Object({
  createdAt: Type.String({ format: 'date-time' }),
  id: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })

export const InventoryAdjustmentPageSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  adjustments: Type.Array(InventoryAdjustmentSchema, { maxItems: 100 }),
  nextCursor: Type.Union([InventoryAdjustmentCursorSchema, Type.Null()]),
}, { additionalProperties: false })

export const InventoryAdjustmentQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  operationId: Type.Optional(Type.String({ format: 'uuid' })),
  beforeCreatedAt: Type.Optional(Type.String({ format: 'date-time' })),
  beforeId: Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: false })

export const CreateProductBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 20_000 })),
  productType: ProductTypeSchema,
  defaultSku: Type.Object({
    salePrice: ProductSalePriceSchema,
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export const ProductIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const ProductVariantIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  variantId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const ProductCategoryIdParamsSchema = ProductIdParamsSchema

const ProductPerOrderPurchaseLimitSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: 4950 }),
  Type.Null(),
])
const SkuPerOrderPurchaseLimitSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: 99 }),
  Type.Null(),
])
const AccountPurchaseLimitSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  Type.Null(),
])

export const PurchaseLimitSettingsSchema = Type.Object({
  perOrder: ProductPerOrderPurchaseLimitSchema,
  lifetime: AccountPurchaseLimitSchema,
  rolling24Hours: AccountPurchaseLimitSchema,
}, { additionalProperties: false })
export const SkuPurchaseLimitSettingsSchema = Type.Object({
  perOrder: SkuPerOrderPurchaseLimitSchema,
  lifetime: AccountPurchaseLimitSchema,
  rolling24Hours: AccountPurchaseLimitSchema,
}, { additionalProperties: false })

export const UpdateProductPurchaseLimitsBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  purchaseLimits: PurchaseLimitSettingsSchema,
}, { additionalProperties: false })

export const UpdateSkuPurchaseLimitsBodySchema = Type.Object({
  expectedProductRevision: Type.Integer({ minimum: 1 }),
  expectedSkuRevision: Type.Integer({ minimum: 1 }),
  purchaseLimits: SkuPurchaseLimitSettingsSchema,
}, { additionalProperties: false })

export const PurchaseLimitStatusSchema = Type.Object({
  perOrderLimit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  lifetimeLimit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  rolling24HourLimit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  lifetimePurchased: Type.Union([Type.Integer({ minimum: 0, maximum: 2_147_483_647 }), Type.Null()]),
  rolling24HoursPurchased: Type.Union([Type.Integer({ minimum: 0, maximum: 2_147_483_647 }), Type.Null()]),
  maxAvailable: Type.Union([Type.Integer({ minimum: 0, maximum: 2_147_483_647 }), Type.Null()]),
  exceeded: Type.Boolean(),
}, { additionalProperties: false })

export const CheckoutPurchaseLimitsSchema = Type.Object({
  product: PurchaseLimitStatusSchema,
  sku: PurchaseLimitStatusSchema,
  requiresLogin: Type.Boolean(),
}, { additionalProperties: false })

export const ProductVariantSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  productId: Type.String({ format: 'uuid' }),
  skuCode: Type.String({ minLength: 1, maxLength: 64 }),
  salePrice: ProductSalePriceSchema,
  currency: Type.Literal('CNY'),
  enabled: Type.Boolean(),
  retiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  purchaseLimits: SkuPurchaseLimitSettingsSchema,
  isDefault: Type.Boolean(),
  options: Type.Array(Type.Object({
    groupId: Type.String({ format: 'uuid' }),
    groupName: Type.String({ minLength: 1, maxLength: 80 }),
    valueId: Type.String({ format: 'uuid' }),
    valueName: Type.String({ minLength: 1, maxLength: 80 }),
  }, { additionalProperties: false })),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})

export const ProductOptionValueSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  sortOrder: Type.Integer(),
  enabled: Type.Boolean(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const ProductOptionGroupSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  sortOrder: Type.Integer(),
  enabled: Type.Boolean(),
  values: Type.Array(ProductOptionValueSchema, { maxItems: 50 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const ProductCategoryAssignmentSchema = Type.Object({
  categoryId: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  parentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  isVisible: Type.Boolean(),
  isPrimary: Type.Boolean(),
  sortOrder: Type.Integer(),
}, { additionalProperties: false })

export const ProductAttributeSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  value: Type.String({ minLength: 1, maxLength: 500 }),
  sortOrder: Type.Integer(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export type ProductRichContentMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'link'; attrs: { href: string; target?: '_blank' | '_self' } }

export type ProductRichContentInlineNode =
  | { type: 'text'; text: string; marks?: ProductRichContentMark[] }
  | { type: 'hardBreak'; marks?: ProductRichContentMark[] }

export type ProductRichContentListItem = {
  type: 'listItem'
  content: ProductRichContentBlock[]
}

export type ProductRichContentBlock =
  | { type: 'paragraph'; content?: ProductRichContentInlineNode[] }
  | { type: 'heading'; attrs: { level: 1 | 2 | 3 }; content?: ProductRichContentInlineNode[] }
  | { type: 'blockquote'; content: ProductRichContentBlock[] }
  | { type: 'bulletList'; content: ProductRichContentListItem[] }
  | { type: 'orderedList'; attrs?: { start?: number }; content: ProductRichContentListItem[] }
  | { type: 'horizontalRule' }
  | { type: 'image'; attrs: { mediaId: string; alt?: string } }

export interface ProductRichContent {
  type: 'doc'
  content: ProductRichContentBlock[]
}

/** The service enforces the full Tiptap node and attribute allowlist. */
export const ProductRichContentSchema = Type.Unsafe<ProductRichContent>(Type.Object({
  type: Type.Literal('doc'),
  content: Type.Array(Type.Unknown(), { maxItems: 500 }),
}, { additionalProperties: false }))

export const ProductMediaVariantSchema = Type.Union([
  Type.Literal('thumbnail'), Type.Literal('card'), Type.Literal('detail'),
])

export const ProductMediaVariantMetadataSchema = Type.Object({
  variant: ProductMediaVariantSchema,
  url: Type.String({ minLength: 1, maxLength: 200 }),
  contentType: Type.Literal('image/webp'),
  width: Type.Integer({ minimum: 1, maximum: 1920 }),
  height: Type.Integer({ minimum: 1, maximum: 1920 }),
  sizeBytes: Type.Integer({ minimum: 1 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  processingVersion: Type.String({ minLength: 1, maxLength: 32 }),
}, { additionalProperties: false })

export const ProductMediaMetadataSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  createdAt: Type.String({ format: 'date-time' }),
  variants: Type.Array(ProductMediaVariantMetadataSchema, { minItems: 3, maxItems: 3 }),
}, { additionalProperties: false })

export const ProductMediaLibraryQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false })

export const ProductMediaLibraryItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  createdAt: Type.String({ format: 'date-time' }),
  variants: Type.Array(ProductMediaVariantMetadataSchema, { minItems: 3, maxItems: 3 }),
  referenceCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const ProductMediaLibraryPageSchema = Type.Object({
  items: Type.Array(ProductMediaLibraryItemSchema, { maxItems: 100 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  total: Type.Integer({ minimum: 0 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const ProductGalleryImageSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  sortOrder: Type.Integer({ minimum: 0, maximum: 19 }),
  width: Type.Integer({ minimum: 1, maximum: 1920 }),
  height: Type.Integer({ minimum: 1, maximum: 1920 }),
  thumbnailUrl: Type.String({ minLength: 1, maxLength: 200 }),
  cardUrl: Type.String({ minLength: 1, maxLength: 200 }),
  detailUrl: Type.String({ minLength: 1, maxLength: 200 }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const MediaIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })

export const MediaVariantParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  variant: ProductMediaVariantSchema,
}, { additionalProperties: false })

export const ReplaceProductGalleryBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  mediaIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20, uniqueItems: true }),
}, { additionalProperties: false })

export const ProductGalleryResponseSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  revision: Type.Integer({ minimum: 1 }),
  images: Type.Array(ProductGalleryImageSchema, { maxItems: 20 }),
}, { additionalProperties: false })

export const SaveProductRichContentBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  content: ProductRichContentSchema,
}, { additionalProperties: false })

export const ProductRichContentResponseSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  revision: Type.Integer({ minimum: 1 }),
  content: ProductRichContentSchema,
}, { additionalProperties: false })

export const ProductMediaDeleteResponseSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  deleted: Type.Literal(true),
  cleanupPending: Type.Boolean(),
}, { additionalProperties: false })

export const ProductDetailSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 20_000 }),
  productType: ProductTypeSchema,
  status: ProductStatusSchema,
  purchaseLimits: PurchaseLimitSettingsSchema,
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  richContent: ProductRichContentSchema,
  gallery: Type.Array(ProductGalleryImageSchema, { maxItems: 20 }),
  categories: Type.Array(ProductCategoryAssignmentSchema),
  optionGroups: Type.Array(ProductOptionGroupSchema, { maxItems: 5 }),
  attributes: Type.Array(ProductAttributeSchema, { maxItems: 30 }),
  variants: Type.Array(ProductVariantSchema, { minItems: 1 }),
})

export const ProductListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  status: Type.Optional(ProductStatusSchema),
  productType: Type.Optional(ProductTypeSchema),
  categoryId: Type.Optional(Type.String({ format: 'uuid' })),
  sortBy: Type.Optional(Type.Union([
    Type.Literal('createdAt'), Type.Literal('updatedAt'), Type.Literal('price'),
  ])),
  sortOrder: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
}, { additionalProperties: false })

export const ProductListCategorySchema = Type.Object({
  categoryId: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  isPrimary: Type.Boolean(),
  sortOrder: Type.Integer(),
}, { additionalProperties: false })

export const ProductListItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  productType: ProductTypeSchema,
  status: ProductStatusSchema,
  coverImage: Type.Union([ProductGalleryImageSchema, Type.Null()]),
  skuCount: Type.Integer({ minimum: 1, maximum: 1000 }),
  priceRange: Type.Union([Type.Object({
    min: ProductSalePriceSchema,
    max: ProductSalePriceSchema,
    currency: Type.Literal('CNY'),
  }, { additionalProperties: false }), Type.Null()]),
  categories: Type.Array(ProductListCategorySchema),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const ProductListResponseSchema = Type.Object({
  items: Type.Array(ProductListItemSchema, { maxItems: 100 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  total: Type.Integer({ minimum: 0 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

// Public catalog contracts deliberately expose only customer-facing projections.
export const PublicCatalogSortSchema = Type.Union([
  Type.Literal('default'), Type.Literal('newest'), Type.Literal('price_asc'), Type.Literal('price_desc'),
])

export const PublicProductListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })),
  sort: Type.Optional(PublicCatalogSortSchema),
}, { additionalProperties: false })

export const PublicProductSearchQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  categoryId: Type.Optional(Type.String({ format: 'uuid' })),
  productType: Type.Optional(ProductTypeSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })),
  sort: Type.Optional(PublicCatalogSortSchema),
}, { additionalProperties: false })

export const PublicProductPriceRangeSchema = Type.Object({
  min: ProductSalePriceSchema,
  max: ProductSalePriceSchema,
  currency: Type.Literal('CNY'),
}, { additionalProperties: false })

export const PublicProductImageSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 200 }),
  thumbnailUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  width: Type.Integer({ minimum: 1, maximum: 1920 }),
  height: Type.Integer({ minimum: 1, maximum: 1920 }),
  alt: Type.String({ maxLength: 200 }),
}, { additionalProperties: false })

export const PublicInventorySummarySchema = Type.Union([
  Type.Object({ mode: Type.Literal('quantity'), status: Type.Union([Type.Literal('in_stock'), Type.Literal('out_of_stock')]) }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('resource_pool'), status: Type.Literal('not_ready') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('external'), status: Type.Literal('not_ready') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('unlimited'), status: Type.Literal('unlimited') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Null(), status: Type.Literal('not_configured') }, { additionalProperties: false }),
])

export const PublicProductCardSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 280 }),
  productType: ProductTypeSchema,
  cover: Type.Union([PublicProductImageSchema, Type.Null()]),
  priceRange: Type.Union([PublicProductPriceRangeSchema, Type.Null()]),
  selectionStatus: Type.Union([Type.Literal('available'), Type.Literal('none')]),
  inventoryStatus: Type.Union([
    Type.Literal('in_stock'), Type.Literal('out_of_stock'),
    Type.Literal('unconfirmed'), Type.Literal('not_applicable'),
  ]),
}, { additionalProperties: false })

export const PublicProductPageSchema = Type.Object({
  items: Type.Array(PublicProductCardSchema, { maxItems: 48 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 48 }),
  total: Type.Integer({ minimum: 0 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const PublicCategoryPathItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
}, { additionalProperties: false })

/** A visible category tree is represented as an ordered adjacency list plus its public path. */
export const PublicCategorySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  parentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  sortOrder: Type.Integer(),
  level: Type.Integer({ minimum: 0, maximum: 3 }),
  path: Type.Array(PublicCategoryPathItemSchema, { minItems: 1, maxItems: 4 }),
}, { additionalProperties: false })

export const PublicCategoriesResponseSchema = Type.Object({
  categories: Type.Array(PublicCategorySchema),
}, { additionalProperties: false })

export const PublicCategoryProductsResponseSchema = Type.Object({
  category: PublicCategorySchema,
  breadcrumbs: Type.Array(PublicCategoryPathItemSchema, { minItems: 1, maxItems: 4 }),
  children: Type.Array(PublicCategorySchema, { maxItems: 10_000 }),
  products: PublicProductPageSchema,
}, { additionalProperties: false })

export const PublicProductOptionValueSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  sortOrder: Type.Integer(),
  available: Type.Boolean(),
}, { additionalProperties: false })

export const PublicProductOptionGroupSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  sortOrder: Type.Integer(),
  values: Type.Array(PublicProductOptionValueSchema, { maxItems: 50 }),
}, { additionalProperties: false })

export const PublicProductVariantSchema = Type.Object({
  skuId: Type.String({ format: 'uuid' }),
  options: Type.Array(Type.Object({
    groupId: Type.String({ format: 'uuid' }),
    valueId: Type.String({ format: 'uuid' }),
  }, { additionalProperties: false }), { maxItems: 5 }),
  salePrice: ProductSalePriceSchema,
  compareAtPrice: Type.Union([ProductSalePriceSchema, Type.Null()]),
  purchaseLimits: SkuPurchaseLimitSettingsSchema,
  inventory: PublicInventorySummarySchema,
}, { additionalProperties: false })

export const SettlementAmountSchema = Type.String({ pattern: '^-?(?:0|[1-9]\\d{0,15})\\.\\d{2}$' })

export const CartSkuQuantitySchema = Type.Object({
  skuId: Type.String({ format: 'uuid' }),
  quantity: Type.Integer({ minimum: 1, maximum: 99 }),
}, { additionalProperties: false })

const PurchaseLineIdSchema = Type.String({ format: 'uuid' })
const PurchaseLineQuantitySchema = Type.Integer({ minimum: 1, maximum: 99 })
const PurchaseLineDraftRevisionSchema = Type.Integer({ minimum: 1 })

// Version 2 keeps the request's line reference separate from the server-only
// content identity. A draft reference and its revision are always paired.
export const CheckoutRequestLineV2Schema = Type.Union([
  Type.Object({
    lineId: PurchaseLineIdSchema,
    skuId: Type.String({ format: 'uuid' }),
    quantity: PurchaseLineQuantitySchema,
  }, { additionalProperties: false }),
  Type.Object({
    lineId: PurchaseLineIdSchema,
    skuId: Type.String({ format: 'uuid' }),
    quantity: PurchaseLineQuantitySchema,
    draftId: Type.Null(),
    draftRevision: Type.Null(),
  }, { additionalProperties: false }),
  Type.Object({
    lineId: PurchaseLineIdSchema,
    skuId: Type.String({ format: 'uuid' }),
    quantity: PurchaseLineQuantitySchema,
    draftId: Type.String({ format: 'uuid' }),
    draftRevision: PurchaseLineDraftRevisionSchema,
  }, { additionalProperties: false }),
])

export const CustomerCartAddBodySchema = Type.Union([
  CartSkuQuantitySchema,
  Type.Object({
    version: Type.Literal(2),
    skuId: Type.String({ format: 'uuid' }),
    quantity: PurchaseLineQuantitySchema,
    draftId: Type.String({ format: 'uuid' }),
    draftRevision: PurchaseLineDraftRevisionSchema,
  }, { additionalProperties: false }),
])
export const CustomerCartUpdateBodySchema = Type.Object({
  quantity: Type.Integer({ minimum: 1, maximum: 99 }),
}, { additionalProperties: false })

export const CustomerCartLineParamsSchema = Type.Object({ lineId: PurchaseLineIdSchema }, { additionalProperties: false })
export const CustomerCartLineQuantityBodySchema = Type.Object({
  quantity: PurchaseLineQuantitySchema,
  expectedLineRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })
export const CustomerCartLinePurchaseFormBodySchema = Type.Object({
  expectedLineRevision: Type.Integer({ minimum: 1 }),
  expectedDraftRevision: PurchaseLineDraftRevisionSchema,
  values: Type.Record(Type.String({ format: 'uuid' }), Type.Unknown()),
}, { additionalProperties: false })

export const CustomerCartMergeBodyV1Schema = Type.Object({
  mergeId: Type.String({ format: 'uuid' }),
  items: Type.Array(CartSkuQuantitySchema, { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })
export const CustomerCartMergeBodyV2Schema = Type.Object({
  version: Type.Literal(2),
  mergeId: Type.String({ format: 'uuid' }),
  items: Type.Array(CheckoutRequestLineV2Schema, { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })
export const CustomerCartMergeBodySchema = Type.Union([CustomerCartMergeBodyV1Schema, CustomerCartMergeBodyV2Schema])

export const CheckoutQuoteBodyV1Schema = Type.Object({
  items: Type.Array(CartSkuQuantitySchema, { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })
export const CheckoutQuoteBodyV2Schema = Type.Object({
  version: Type.Literal(2),
  items: Type.Array(CheckoutRequestLineV2Schema, { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })
export const CheckoutQuoteBodySchema = Type.Union([CheckoutQuoteBodyV1Schema, CheckoutQuoteBodyV2Schema])

export const CartOptionSchema = Type.Object({
  groupId: Type.String({ format: 'uuid' }),
  groupName: Type.String({ minLength: 1, maxLength: 80 }),
  valueId: Type.String({ format: 'uuid' }),
  valueName: Type.String({ minLength: 1, maxLength: 80 }),
}, { additionalProperties: false })

export const CheckoutQuoteReasonSchema = Type.Union([
  Type.Literal('product_not_found'),
  Type.Literal('product_not_active'),
  Type.Literal('sku_not_found'),
  Type.Literal('sku_disabled'),
  Type.Literal('sku_retired'),
  Type.Literal('specification_invalid'),
  Type.Literal('inventory_not_configured'),
  Type.Literal('insufficient_inventory'),
  Type.Literal('inventory_not_ready'),
  Type.Literal('fulfillment_not_ready'),
  Type.Literal('code_pool_inventory_inconsistent'),
  Type.Literal('guest_checkout_disabled'),
  Type.Literal('guest_free_claim_disabled'),
  Type.Literal('purchase_limit_exceeded'),
  Type.Literal('login_required_for_purchase_limit'),
  Type.Literal('purchase_form_invalid'),
  Type.Literal('purchase_form_version_changed'),
  Type.Literal('purchase_form_required'),
])

export const CheckoutQuoteItemSchema = Type.Object({
  lineId: Type.Union([PurchaseLineIdSchema, Type.Null()]),
  sourceLineIds: Type.Array(PurchaseLineIdSchema, { maxItems: 50 }),
  lineRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  draftId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  draftRevision: Type.Union([PurchaseLineDraftRevisionSchema, Type.Null()]),
  templateVersionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  normalizationVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  contentIdentity: Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]),
  skuId: Type.String({ format: 'uuid' }),
  productId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  productName: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  productType: Type.Union([ProductTypeSchema, Type.Null()]),
  productStatus: Type.Union([ProductStatusSchema, Type.Null()]),
  skuCode: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  options: Type.Array(CartOptionSchema, { maxItems: 5 }),
  unitPrice: Type.Union([ProductSalePriceSchema, Type.Null()]),
  quantity: Type.Integer({ minimum: 1, maximum: 99 }),
  lineTotal: Type.Union([SettlementAmountSchema, Type.Null()]),
  inventoryMode: Type.Union([NullableProductInventoryModeSchema, Type.Null()]),
  fulfillmentMethod: Type.Union([Type.String({ minLength: 1, maxLength: 24 }), Type.Null()]),
  fulfillmentRevision: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  fulfillmentVersionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  availableQuantity: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  identityValid: Type.Boolean(),
  purchaseLimits: CheckoutPurchaseLimitsSchema,
  canPurchase: Type.Boolean(),
  reason: Type.Union([CheckoutQuoteReasonSchema, Type.Null()]),
}, { additionalProperties: false })

export const CheckoutQuoteSchema = Type.Object({
  quotedAt: Type.String({ format: 'date-time' }),
  quoteToken: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  currency: Type.Literal('CNY'),
  items: Type.Array(CheckoutQuoteItemSchema, { minItems: 1, maxItems: 50 }),
  pricedSubtotal: SettlementAmountSchema,
  totalAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
  totalComplete: Type.Boolean(),
  canContinue: Type.Boolean(),
  customerAuthenticated: Type.Boolean(),
  guestCheckoutEnabled: Type.Boolean(),
  guestFreeClaimEnabled: Type.Boolean(),
  policyReasons: Type.Array(Type.Union([
    Type.Literal('guest_checkout_disabled'), Type.Literal('guest_free_claim_disabled'),
  ]), { maxItems: 2 }),
}, { additionalProperties: false })

export const CreateOrderBodyV1Schema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
  quoteToken: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  items: Type.Array(CartSkuQuantitySchema, { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })
export const CreateOrderBodyV2Schema = Type.Object({
  version: Type.Literal(2),
  idempotencyKey: Type.String({ format: 'uuid' }),
  quoteToken: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  items: Type.Array(CheckoutRequestLineV2Schema, { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false })
export const CreateOrderBodySchema = Type.Union([CreateOrderBodyV1Schema, CreateOrderBodyV2Schema])
// Optional transport binding preserves historical order bodies and hashes.
// A supplied guest identity is compared with the authenticated HttpOnly cookie.
export const CreateOrderHeadersSchema = Type.Object({
  'x-aikayun-guest-session-id': Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: true })

export const OrderStatusSchema = Type.Union([
  Type.Literal('pending_payment'), Type.Literal('processing'),
  Type.Literal('completed'), Type.Literal('closed'),
])
export const ExternalPaymentMethodSchema = Type.Union([Type.Literal('alipay'), Type.Literal('wechat')])
export const PaymentProviderTypeSchema = Type.Union([
  Type.Literal('zpay_epay_v1'), Type.Literal('codepay_unconfigured'),
])
export const PaymentActionSchema = Type.Union([
  Type.Object({ type: Type.Literal('qr_code'), value: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('redirect'), url: Type.String({ format: 'uri', maxLength: 2048 }) }, { additionalProperties: false }),
])
export const PublicPaymentChannelSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  paymentMethods: Type.Array(ExternalPaymentMethodSchema, { minItems: 1, maxItems: 2 }),
}, { additionalProperties: false })
export const PublicPaymentChannelListSchema = Type.Object({
  items: Type.Array(PublicPaymentChannelSchema),
}, { additionalProperties: false })
export const CustomerPaymentAttemptSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: Type.Union([
    Type.Literal('created'), Type.Literal('pending'), Type.Literal('succeeded'),
    Type.Literal('failed'), Type.Literal('expired'), Type.Literal('cancelled'),
    Type.Literal('late_succeeded'), Type.Literal('reconciliation_required'),
  ]),
  providerState: Type.Union([
    Type.Literal('requesting'), Type.Literal('ready'), Type.Literal('unknown'), Type.Literal('failed'), Type.Null(),
  ]),
  paymentMethod: Type.Union([ExternalPaymentMethodSchema, Type.Null()]),
  channelName: Type.Union([Type.String({ minLength: 1, maxLength: 80 }), Type.Null()]),
  action: Type.Union([PaymentActionSchema, Type.Null()]),
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  errorCode: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  source: Type.Union([Type.Literal('external'), Type.Literal('wallet')]),
  amount: SettlementAmountSchema,
  walletGiftAmount: SettlementAmountSchema,
  walletCashAmount: SettlementAmountSchema,
  walletRequestedAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
}, { additionalProperties: false })
export const CustomerOrderPaymentSchema = Type.Object({
  orderId: Type.String({ format: 'uuid' }),
  orderStatus: OrderStatusSchema,
  paymentStatus: Type.Union([
    Type.Literal('unpaid'), Type.Literal('pending'), Type.Literal('paid'),
    Type.Literal('late_paid'), Type.Literal('reconciliation_required'), Type.Literal('not_payable'),
  ]),
  totalAmount: SettlementAmountSchema,
  confirmedAmount: SettlementAmountSchema,
  currency: Type.Literal('CNY'),
  unpaidExpiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  walletBalance: Type.Union([Type.Object({
    cashAvailable: SettlementAmountSchema,
    giftAvailable: SettlementAmountSchema,
    totalAvailable: SettlementAmountSchema,
  }, { additionalProperties: false }), Type.Null()]),
  channels: Type.Array(PublicPaymentChannelSchema),
  attempt: Type.Union([CustomerPaymentAttemptSchema, Type.Null()]),
}, { additionalProperties: false })
export const CreateOrderPaymentBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
  channelId: Type.Optional(Type.String({ format: 'uuid' })),
  paymentMethod: Type.Optional(ExternalPaymentMethodSchema),
  walletAmount: Type.Optional(Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' })),
}, { additionalProperties: false })
export const PaymentOrderIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })

export const CustomerWalletSummarySchema = Type.Object({
  cashAvailable: SettlementAmountSchema,
  cashFrozen: SettlementAmountSchema,
  giftAvailable: SettlementAmountSchema,
  giftFrozen: SettlementAmountSchema,
  totalAvailable: SettlementAmountSchema,
  topUpEnabled: Type.Boolean(),
  topUpMinAmount: SettlementAmountSchema,
  topUpMaxAmount: SettlementAmountSchema,
}, { additionalProperties: false })
export const CustomerWalletLedgerEntrySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  operationType: Type.String({ maxLength: 24 }),
  bucket: Type.Union([Type.Literal('cash'), Type.Literal('gift')]),
  action: Type.Union([Type.Literal('credit_available'), Type.Literal('debit_available'), Type.Literal('freeze'), Type.Literal('unfreeze'), Type.Literal('debit_frozen')]),
  amount: SettlementAmountSchema,
  createdAt: Type.String({ format: 'date-time' }),
  orderId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  paymentAttemptId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  paymentStatus: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  paymentDisposition: Type.Union([Type.String({ maxLength: 24 }), Type.Null()]),
  providerTransactionId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
}, { additionalProperties: false })
export const CustomerWalletLedgerPageSchema = Type.Object({
  items: Type.Array(CustomerWalletLedgerEntrySchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CustomerWalletPageQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })
export const CustomerTopUpSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  amount: SettlementAmountSchema,
  status: Type.Union([Type.Literal('created'), Type.Literal('pending'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('expired'), Type.Literal('cancelled'), Type.Literal('late_succeeded'), Type.Literal('reconciliation_required')]),
  providerState: Type.Union([Type.Literal('requesting'), Type.Literal('ready'), Type.Literal('unknown'), Type.Literal('failed'), Type.Null()]),
  paymentMethod: Type.Union([ExternalPaymentMethodSchema, Type.Null()]),
  channelName: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  action: Type.Union([PaymentActionSchema, Type.Null()]),
  providerTransactionId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  receiptAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
  receiptDisposition: Type.Union([Type.String({ maxLength: 24 }), Type.Null()]),
  reconciliationOpen: Type.Boolean(),
  reconciliationReasons: Type.Array(Type.Union([
    Type.Literal('callback_query_mismatch'), Type.Literal('provider_identity_conflict'),
    Type.Literal('provider_transaction_conflict'), Type.Literal('provider_amount_mismatch'),
    Type.Literal('receipt_conflict'), Type.Literal('late_confirmed_payment'),
  ])),
  createdAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false })
export const CustomerTopUpPageSchema = Type.Object({
  items: Type.Array(CustomerTopUpSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const AdminWalletListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false })
export const AdminWalletListItemSchema = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  username: Type.Union([CustomerUsernameSchema, Type.Null()]),
  status: AdminCustomerStatusSchema,
  cashAvailable: SettlementAmountSchema,
  cashFrozen: SettlementAmountSchema,
  giftAvailable: SettlementAmountSchema,
  giftFrozen: SettlementAmountSchema,
  totalAvailable: SettlementAmountSchema,
}, { additionalProperties: false })
export const AdminWalletListSchema = Type.Object({
  items: Type.Array(AdminWalletListItemSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const AdminWalletDetailSchema = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  username: Type.Union([CustomerUsernameSchema, Type.Null()]),
  status: AdminCustomerStatusSchema,
  wallet: CustomerWalletSummarySchema,
  ledger: CustomerWalletLedgerPageSchema,
  topUps: CustomerTopUpPageSchema,
}, { additionalProperties: false })
export const CreateWalletTopUpBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
  amount: Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' }),
  channelId: Type.String({ format: 'uuid' }),
  paymentMethod: ExternalPaymentMethodSchema,
}, { additionalProperties: false })

export const WithdrawalPayoutMethodSchema = Type.Union([
  Type.Literal('alipay'), Type.Literal('wechat'), Type.Literal('bank_card'),
])
export const WithdrawalStatusSchema = Type.Union([
  Type.Literal('pending_review'), Type.Literal('pending_transfer'), Type.Literal('transfer_processing'),
  Type.Literal('transfer_uncertain'), Type.Literal('completed'), Type.Literal('rejected'), Type.Literal('cancelled'),
])
export const WithdrawalPayoutAttemptStatusSchema = Type.Union([
  Type.Literal('started'), Type.Literal('unknown'), Type.Literal('succeeded'), Type.Literal('failed'),
])
export const WithdrawalAmountInputSchema = Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})(?:\\.\\d{1,2})?$' })
export const WithdrawalPercentInputSchema = Type.String({ pattern: '^(?:0|[1-9]\\d{0,2})(?:\\.\\d{1,4})?$' })
export const WithdrawalSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  minAmount: SettlementAmountSchema,
  maxAmount: SettlementAmountSchema,
  fixedFee: SettlementAmountSchema,
  percentFee: WithdrawalPercentInputSchema,
  methods: Type.Array(WithdrawalPayoutMethodSchema, { uniqueItems: true }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const UpdateWithdrawalSettingsBodySchema = Type.Object({
  enabled: Type.Boolean(),
  minAmount: WithdrawalAmountInputSchema,
  maxAmount: WithdrawalAmountInputSchema,
  fixedFee: WithdrawalAmountInputSchema,
  percentFee: WithdrawalPercentInputSchema,
  methods: Type.Array(WithdrawalPayoutMethodSchema, { uniqueItems: true }),
}, { additionalProperties: false })
export const CustomerWithdrawalPolicySchema = Type.Object({
  enabled: Type.Boolean(),
  minAmount: SettlementAmountSchema,
  maxAmount: SettlementAmountSchema,
  fixedFee: SettlementAmountSchema,
  percentFee: WithdrawalPercentInputSchema,
  methods: Type.Array(WithdrawalPayoutMethodSchema),
}, { additionalProperties: false })
export const WithdrawalRecipientInputSchema = Type.Union([
  Type.Object({
    account: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    accountName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    qrFileId: Type.Optional(Type.String({ format: 'uuid' })),
    recipientName: Type.Optional(Type.Never()),
    bankName: Type.Optional(Type.Never()),
    cardNumber: Type.Optional(Type.Never()),
  }, { additionalProperties: false }),
  Type.Object({
    recipientName: Type.String({ minLength: 1, maxLength: 100 }),
    bankName: Type.String({ minLength: 1, maxLength: 120 }),
    cardNumber: Type.String({ minLength: 12, maxLength: 19, pattern: '^\\d{12,19}$' }),
    account: Type.Optional(Type.Never()),
    accountName: Type.Optional(Type.Never()),
    qrFileId: Type.Optional(Type.Never()),
  }, { additionalProperties: false }),
])
export const WithdrawalRecipientSnapshotSchema = Type.Object({
  account: Type.Optional(Type.String({ maxLength: 120 })),
  accountName: Type.Optional(Type.String({ maxLength: 100 })),
  recipientName: Type.Optional(Type.String({ maxLength: 100 })),
  bankName: Type.Optional(Type.String({ maxLength: 120 })),
  cardNumber: Type.Optional(Type.String({ maxLength: 19 })),
  qrFileId: Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: false })
export const CreateWithdrawalBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
  amount: WithdrawalAmountInputSchema,
  payoutMethod: WithdrawalPayoutMethodSchema,
  recipient: WithdrawalRecipientInputSchema,
}, { additionalProperties: false })
export const WithdrawalPayoutResultSchema = Type.Object({
  outcome: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
  resolvedByAdminId: Type.String({ format: 'uuid' }),
  providerReference: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  actualPayoutAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
  actualPayoutAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  confirmedNoTransfer: Type.Boolean(),
  evidenceSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  evidenceSummary: Type.String({ maxLength: 500 }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const WithdrawalPayoutAttemptSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  status: WithdrawalPayoutAttemptStatusSchema,
  startedByAdminId: Type.String({ format: 'uuid' }),
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  result: Type.Union([WithdrawalPayoutResultSchema, Type.Null()]),
}, { additionalProperties: false })
export const CustomerWithdrawalPayoutAttemptSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  status: WithdrawalPayoutAttemptStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false })
export const CustomerWithdrawalSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  amount: SettlementAmountSchema,
  feeAmount: SettlementAmountSchema,
  payoutAmount: SettlementAmountSchema,
  payoutMethod: WithdrawalPayoutMethodSchema,
  recipient: WithdrawalRecipientSnapshotSchema,
  status: WithdrawalStatusSchema,
  rejectionReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  payoutAttempts: Type.Array(CustomerWithdrawalPayoutAttemptSchema),
}, { additionalProperties: false })
export const CustomerWithdrawalPageSchema = Type.Object({
  cashAvailable: SettlementAmountSchema,
  cashFrozen: SettlementAmountSchema,
  policy: CustomerWithdrawalPolicySchema,
  items: Type.Array(CustomerWithdrawalSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CustomerWithdrawalMutationSchema = Type.Object({
  repeated: Type.Boolean(),
  withdrawal: CustomerWithdrawalSchema,
}, { additionalProperties: false })
export const WithdrawalPageQuerySchema = CustomerWalletPageQuerySchema
export const WithdrawalIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
export const AdminWithdrawalListQuerySchema = Type.Object({
  status: Type.Optional(WithdrawalStatusSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })
export const AdminWithdrawalListItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  customerId: Type.String({ format: 'uuid' }),
  customerUsername: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  customerEmail: Type.Union([Type.String({ maxLength: 254 }), Type.Null()]),
  amount: SettlementAmountSchema,
  feeAmount: SettlementAmountSchema,
  payoutAmount: SettlementAmountSchema,
  payoutMethod: WithdrawalPayoutMethodSchema,
  maskedRecipient: Type.String({ maxLength: 180 }),
  status: WithdrawalStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminWithdrawalListSchema = Type.Object({
  items: Type.Array(AdminWithdrawalListItemSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const WithdrawalAuditEventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  action: Type.String({ maxLength: 48 }),
  actorType: Type.Union([Type.Literal('customer'), Type.Literal('admin'), Type.Literal('system')]),
  actorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  idempotencyKey: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  previousStatus: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  nextStatus: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  details: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const WithdrawalLedgerEntrySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  operationType: Type.String({ maxLength: 24 }),
  action: Type.Union([Type.Literal('freeze'), Type.Literal('unfreeze'), Type.Literal('debit_frozen')]),
  amount: SettlementAmountSchema,
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminWithdrawalHistoryItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }), amount: SettlementAmountSchema,
  feeAmount: SettlementAmountSchema, payoutAmount: SettlementAmountSchema,
  status: WithdrawalStatusSchema, createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminWithdrawalDetailSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  customer: Type.Object({
    id: Type.String({ format: 'uuid' }),
    username: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
    email: Type.Union([Type.String({ maxLength: 254 }), Type.Null()]),
    phone: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
    status: Type.String({ maxLength: 16 }),
  }, { additionalProperties: false }),
  amount: SettlementAmountSchema,
  feeAmount: SettlementAmountSchema,
  payoutAmount: SettlementAmountSchema,
  payoutMethod: WithdrawalPayoutMethodSchema,
  recipient: WithdrawalRecipientSnapshotSchema,
  status: WithdrawalStatusSchema,
  rejectionReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  reviewedByAdminId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  wallet: Type.Object({
    cashAvailable: SettlementAmountSchema, cashFrozen: SettlementAmountSchema,
    giftAvailable: SettlementAmountSchema, giftFrozen: SettlementAmountSchema,
  }, { additionalProperties: false }),
  ledgerEntries: Type.Array(WithdrawalLedgerEntrySchema),
  payoutAttempts: Type.Array(WithdrawalPayoutAttemptSchema),
  customerHistory: Type.Array(AdminWithdrawalHistoryItemSchema),
  auditEvents: Type.Array(WithdrawalAuditEventSchema),
}, { additionalProperties: false })
export const AdminWithdrawalActionBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const AdminWithdrawalRejectionBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false })
export const AdminWithdrawalResolveBodySchema = Type.Union([
  Type.Object({
    idempotencyKey: Type.String({ format: 'uuid' }), outcome: Type.Literal('unknown'),
    evidenceSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    evidenceSummary: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
  Type.Object({
    idempotencyKey: Type.String({ format: 'uuid' }), outcome: Type.Literal('failed'),
    confirmedNoTransfer: Type.Literal(true),
    evidenceSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    evidenceSummary: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
  Type.Object({
    idempotencyKey: Type.String({ format: 'uuid' }), outcome: Type.Literal('succeeded'),
    providerReference: Type.String({ minLength: 1, maxLength: 200 }),
    actualPayoutAmount: WithdrawalAmountInputSchema,
    actualPayoutAt: Type.String({ format: 'date-time' }),
    evidenceSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    evidenceSummary: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
])
export const WithdrawalQrUploadSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  mimeType: Type.Union([Type.Literal('image/jpeg'), Type.Literal('image/png'), Type.Literal('image/webp')]),
  sizeBytes: Type.Integer({ minimum: 1, maximum: 5242880 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
}, { additionalProperties: false })
export const AdminWalletCustomerParamsSchema = Type.Object({ customerId: Type.String({ format: 'uuid' }) })

export const AdminPaymentChannelSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  providerType: PaymentProviderTypeSchema,
  providerAvailable: Type.Boolean(),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  enabled: Type.Boolean(),
  paymentMethods: Type.Array(ExternalPaymentMethodSchema, { maxItems: 2 }),
  displayOrder: Type.Integer({ minimum: 0, maximum: 100000 }),
  merchantIdMasked: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
  credentialsConfigured: Type.Boolean(),
  credentialVersion: Type.Integer({ minimum: 0 }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminPaymentChannelListSchema = Type.Object({
  items: Type.Array(AdminPaymentChannelSchema),
}, { additionalProperties: false })
export const CreatePaymentChannelBodySchema = Type.Object({
  providerType: PaymentProviderTypeSchema,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  enabled: Type.Boolean(),
  paymentMethods: Type.Array(ExternalPaymentMethodSchema, { maxItems: 2 }),
  displayOrder: Type.Integer({ minimum: 0, maximum: 100000 }),
  merchantId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  merchantKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
}, { additionalProperties: false })
export const UpdatePaymentChannelBodySchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  enabled: Type.Optional(Type.Boolean()),
  paymentMethods: Type.Optional(Type.Array(ExternalPaymentMethodSchema, { maxItems: 2 })),
  displayOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
  merchantId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  merchantKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
}, { additionalProperties: false, minProperties: 1 })
export const PaymentChannelIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
export const PaymentChannelMutationResultSchema = Type.Object({
  channel: AdminPaymentChannelSchema,
}, { additionalProperties: false })
export const PaymentChannelTestResultSchema = Type.Object({
  valid: Type.Boolean(),
  message: Type.String({ maxLength: 160 }),
}, { additionalProperties: false })
export const PaymentCredentialReencryptionResultSchema = Type.Object({
  channelsReencrypted: Type.Integer({ minimum: 0 }),
  attemptsReencrypted: Type.Integer({ minimum: 0 }),
  activeKeyId: Type.String({ minLength: 1, maxLength: 48 }),
}, { additionalProperties: false })
export const AdminPaymentProviderEventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  source: Type.Union([Type.Literal('callback'), Type.Literal('query')]),
  verification: Type.Union([Type.Literal('verified'), Type.Literal('unverified')]),
  disposition: Type.Union([
    Type.Literal('settled'), Type.Literal('duplicate'), Type.Literal('not_paid'),
    Type.Literal('pending_confirmation'), Type.Literal('reconciliation_required'), Type.Literal('unknown'),
  ]),
  providerStatus: Type.Union([
    Type.Literal('paid'), Type.Literal('pending'), Type.Literal('failed'), Type.Literal('unknown'),
  ]),
  providerTransactionId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  reportedAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
  providerTimeText: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  errorCode: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  eventSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  receivedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminPaymentAttemptSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  providerType: PaymentProviderTypeSchema,
  paymentMethod: Type.Union([ExternalPaymentMethodSchema, Type.Null()]),
  channelName: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  merchantOrderNo: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  status: CustomerPaymentAttemptSchema.properties.status,
  providerState: CustomerPaymentAttemptSchema.properties.providerState,
  providerOrderId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  providerErrorCode: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  expectedAmount: SettlementAmountSchema,
  actualAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
  providerTransactionId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  receiptDisposition: Type.Union([
    Type.Literal('on_time'), Type.Literal('late'), Type.Literal('excess'), Type.Literal('amount_mismatch'), Type.Null(),
  ]),
  createdAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  reconciliationOpen: Type.Boolean(),
  reconciliationCases: Type.Array(Type.Object({
    id: Type.String({ format: 'uuid' }),
    reason: Type.Union([
      Type.Literal('callback_query_mismatch'), Type.Literal('provider_identity_conflict'),
      Type.Literal('provider_transaction_conflict'), Type.Literal('provider_amount_mismatch'),
      Type.Literal('receipt_conflict'), Type.Literal('late_confirmed_payment'),
    ]),
    state: Type.Union([Type.Literal('open'), Type.Literal('resolved')]),
    openedAt: Type.String({ format: 'date-time' }),
    resolvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    resolvedByAdminId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    resolutionQueryEventSha256: Type.Union([Type.String({ pattern: '^[0-9a-f]{64}$' }), Type.Null()]),
    resolutionProviderTransactionId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    resolutionPaymentMethod: Type.Union([ExternalPaymentMethodSchema, Type.Null()]),
    resolutionConfirmedAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
  }, { additionalProperties: false })),
  events: Type.Array(AdminPaymentProviderEventSchema),
}, { additionalProperties: false })
export const AdminOrderPaymentsSchema = Type.Object({
  needsReconciliation: Type.Boolean(),
  attempts: Type.Array(AdminPaymentAttemptSchema),
}, { additionalProperties: false })
export const AdminPaymentReconciliationParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  attemptId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const AdminTopUpReconciliationParamsSchema = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  attemptId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const AdminPaymentReconciliationResultSchema = Type.Object({
  state: Type.Union([Type.Literal('resolved'), Type.Literal('still_open'), Type.Literal('throttled')]),
  providerStatus: Type.Union([Type.Literal('paid'), Type.Literal('pending'), Type.Literal('failed'), Type.Literal('unknown'), Type.Null()]),
  message: Type.String({ maxLength: 200 }),
}, { additionalProperties: false })
export const OrderPaymentStatusSchema = Type.Union([
  Type.Literal('not_required'), Type.Literal('unpaid'), Type.Literal('paid'),
])
export const OrderFulfillmentStatusSchema = Type.Union([
  Type.Literal('pending'), Type.Literal('processing'), Type.Literal('partially_fulfilled'),
  Type.Literal('failed'), Type.Literal('unknown'), Type.Literal('completed'),
])
export const OrderDeliverySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  unitIndex: Type.Integer({ minimum: 1 }),
  content: Type.Union([Type.String({ minLength: 1, maxLength: 20_000 }), Type.Null()]),
  contentFormat: Type.Union([
    Type.Literal('plain_text'), Type.Literal('markdown'), Type.Literal('link'),
    Type.Literal('file'), Type.Literal('confirmation'),
  ]),
  title: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
  accessInstructions: Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()]),
  fileName: Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()]),
  fileSizeBytes: Type.Union([Type.Integer({ minimum: 1, maximum: 104_857_600 }), Type.Null()]),
  fileMediaType: Type.Union([Type.String({ minLength: 1, maxLength: 96 }), Type.Null()]),
  downloadUrl: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const OrderFulfillmentAttemptSchema = Type.Object({
  status: Type.Union([Type.Literal('processing'), Type.Literal('unknown'), Type.Literal('succeeded'), Type.Literal('failed')]),
  quantity: Type.Integer({ minimum: 1 }),
  failureCode: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 48 })]),
  retryAfter: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false })
export const OrderItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  lineId: Type.Union([PurchaseLineIdSchema, Type.Null()]),
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  productName: Type.String({ minLength: 1, maxLength: 200 }),
  productType: ProductTypeSchema,
  skuCode: Type.String({ minLength: 1, maxLength: 64 }),
  options: Type.Array(CartOptionSchema, { maxItems: 5 }),
  inventoryMode: Type.Union([Type.Literal('quantity'), Type.Literal('unlimited')]),
  fulfillmentMethod: Type.String({ minLength: 1, maxLength: 24 }),
  unitPrice: SettlementAmountSchema,
  quantity: Type.Integer({ minimum: 1 }),
  lineAmount: SettlementAmountSchema,
  fulfillmentStatus: OrderFulfillmentStatusSchema,
  fulfilledQuantity: Type.Integer({ minimum: 0 }),
  fulfillmentReservedQuantity: Type.Integer({ minimum: 0 }),
  fulfillmentAttempts: Type.Array(OrderFulfillmentAttemptSchema),
  deliveries: Type.Array(OrderDeliverySchema),
}, { additionalProperties: false })
export const OrderStatusEventSchema = Type.Object({
  previousStatus: OrderStatusSchema,
  nextStatus: OrderStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const OrderSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: OrderStatusSchema,
  paymentStatus: OrderPaymentStatusSchema,
  totalAmount: SettlementAmountSchema,
  currency: Type.Literal('CNY'),
  itemCount: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  unpaidExpiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false })
export const OrderPageSchema = Type.Object({
  items: Type.Array(OrderSummarySchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const OrderDetailSchema = Type.Intersect([
  OrderSummarySchema,
  Type.Object({
    itemsSealed: Type.Literal(true),
    items: Type.Array(OrderItemSchema, { minItems: 1, maxItems: 50 }),
    statusEvents: Type.Array(OrderStatusEventSchema),
  }, { additionalProperties: false }),
])

export const RefundStatusSchema = Type.Union([
  Type.Literal('requested'), Type.Literal('approved'), Type.Literal('processing'),
  Type.Literal('partially_succeeded'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'),
])
export const RefundProgressStatusSchema = Type.Union([
  Type.Literal('none'), Type.Literal('requested_or_processing'),
  Type.Literal('partially_refunded'), Type.Literal('refunded'),
])
export const RefundSourceBucketSchema = Type.Union([
  Type.Literal('external'), Type.Literal('cash'), Type.Literal('gift'),
])
export const RefundDestinationSchema = Type.Union([
  Type.Literal('original_source'), Type.Literal('cash_balance'), Type.Literal('gift_balance'),
])
export const RefundAllocationStatusSchema = Type.Union([
  Type.Literal('reserved'), Type.Literal('succeeded'), Type.Literal('released'),
])
export const RefundManualAttemptStatusSchema = Type.Union([
  Type.Literal('started'), Type.Literal('unknown'), Type.Literal('succeeded'), Type.Literal('failed'),
])
export const RefundPayoutModeSchema = Type.Union([
  Type.Literal('wallet'), Type.Literal('manual_original_source'), Type.Literal('unavailable'),
])
export const RefundBlockReasonSchema = Type.Union([
  Type.Literal('payment_reconciliation_required'), Type.Literal('payment_unresolved'),
  Type.Literal('no_confirmed_receipts'), Type.Literal('no_refundable_balance'),
])
export const RefundAmountSchema = Type.String({ pattern: '^(?:0|[1-9]\\d{0,15})\\.\\d{2}$' })
export const RefundManualAttemptSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: RefundManualAttemptStatusSchema,
  startedByAdminId: Type.String({ format: 'uuid' }),
  resolvedByAdminId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  providerReference: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  amount: Type.Union([RefundAmountSchema, Type.Null()]),
  actualRefundedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  evidenceSummary: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  resolutionNote: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false })
export const RefundAllocationSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  sourceReceiptId: Type.String({ format: 'uuid' }),
  sourceBucket: RefundSourceBucketSchema,
  sourceReceiptAmount: RefundAmountSchema,
  sourceDisposition: Type.Union([
    Type.Literal('on_time'), Type.Literal('late'), Type.Literal('excess'), Type.Literal('amount_mismatch'),
  ]),
  sourceProvider: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  sourceProviderTransactionId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  destination: RefundDestinationSchema,
  amount: RefundAmountSchema,
  status: RefundAllocationStatusSchema,
  provider: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  providerRefundId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  manualAttempts: Type.Array(RefundManualAttemptSchema),
}, { additionalProperties: false })
export const CustomerOrderRefundSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  amount: RefundAmountSchema,
  succeededAmount: RefundAmountSchema,
  reservedAmount: RefundAmountSchema,
  status: RefundStatusSchema,
  reason: Type.String({ minLength: 1, maxLength: 500 }),
  rejectionReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  payoutMode: RefundPayoutModeSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  allocations: Type.Array(RefundAllocationSchema),
}, { additionalProperties: false })
export const CustomerOrderRefundsSchema = Type.Object({
  orderId: Type.String({ format: 'uuid' }),
  payoutMode: RefundPayoutModeSchema,
  refundStatus: RefundProgressStatusSchema,
  confirmedReceiptAmount: RefundAmountSchema,
  refundableAmount: RefundAmountSchema,
  refundedAmount: RefundAmountSchema,
  refundReservedAmount: RefundAmountSchema,
  activeRequestAmount: RefundAmountSchema,
  canRequest: Type.Boolean(),
  blockedReason: Type.Union([RefundBlockReasonSchema, Type.Null()]),
  items: Type.Array(CustomerOrderRefundSchema),
}, { additionalProperties: false })
export const AdminOrderRefundAuditEventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  action: Type.String({ maxLength: 48 }),
  actorType: Type.Union([Type.Literal('customer'), Type.Literal('guest'), Type.Literal('admin'), Type.Literal('system')]),
  actorCustomerId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  actorAdminId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  previousStatus: Type.Union([RefundStatusSchema, Type.Null()]),
  nextStatus: Type.Union([RefundStatusSchema, Type.Null()]),
  details: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminOrderRefundSchema = Type.Intersect([
  CustomerOrderRefundSchema,
  Type.Object({
    reviewedByAdminId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    auditEvents: Type.Array(AdminOrderRefundAuditEventSchema),
  }, { additionalProperties: false }),
])
export const AdminOrderRefundsSchema = Type.Intersect([
  CustomerOrderRefundsSchema,
  Type.Object({ items: Type.Array(AdminOrderRefundSchema) }, { additionalProperties: false }),
])
export const CreateOrderRefundBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
  amount: RefundAmountSchema,
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '.*\\S.*' }),
}, { additionalProperties: false })
export const AdminRefundActionBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const AdminRefundRejectionBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '.*\\S.*' }),
}, { additionalProperties: false })
export const AdminRefundManualAttemptBodySchema = Type.Object({
  idempotencyKey: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const AdminRefundManualResolutionBodySchema = Type.Union([
  Type.Object({
    idempotencyKey: Type.String({ format: 'uuid' }),
    outcome: Type.Literal('succeeded'),
    providerRefundId: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
    amount: RefundAmountSchema,
    actualRefundedAt: Type.String({ format: 'date-time' }),
    evidenceSummary: Type.String({ minLength: 1, maxLength: 500, pattern: '.*\\S.*' }),
  }, { additionalProperties: false }),
  Type.Object({
    idempotencyKey: Type.String({ format: 'uuid' }),
    outcome: Type.Union([Type.Literal('unknown'), Type.Literal('failed')]),
    resolutionNote: Type.String({ minLength: 1, maxLength: 500, pattern: '.*\\S.*' }),
  }, { additionalProperties: false }),
])
export const OrderRefundIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }), refundId: Type.String({ format: 'uuid' }) })
export const OrderRefundAllocationParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }), refundId: Type.String({ format: 'uuid' }), allocationId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const OrderRefundManualAttemptParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }), refundId: Type.String({ format: 'uuid' }), allocationId: Type.String({ format: 'uuid' }),
  attemptId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const CustomerOrderRefundMutationSchema = Type.Object({
  repeated: Type.Boolean(),
  refunds: CustomerOrderRefundsSchema,
}, { additionalProperties: false })
export const AdminOrderRefundMutationSchema = Type.Object({
  repeated: Type.Boolean(),
  refunds: AdminOrderRefundsSchema,
}, { additionalProperties: false })

export const CreateOrderResultSchema = Type.Object({
  created: Type.Boolean(),
  order: OrderDetailSchema,
}, { additionalProperties: false })
export const CheckoutConflictSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    currentQuote: CheckoutQuoteSchema,
  }),
  meta: RequestMetaSchema,
})
export const CheckoutOrderErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    currentQuote: Type.Optional(CheckoutQuoteSchema),
  }, { additionalProperties: false }),
  meta: RequestMetaSchema,
})
export const OrderIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
export const AdminOrderItemParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  itemId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const AdminProductIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
export const AdminProductVariantParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  variantId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const OrderListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })
export const AdminOrderListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  status: Type.Optional(Type.Union([OrderStatusSchema, Type.Literal('all')])),
}, { additionalProperties: false })
export const AdminOrderSummarySchema = Type.Intersect([
  OrderSummarySchema,
  Type.Object({
    ownerType: Type.Union([Type.Literal('customer'), Type.Literal('guest')]),
    customerId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    customerUsername: Type.Union([CustomerUsernameSchema, Type.Null()]),
  }, { additionalProperties: false }),
])
export const AdminOrderPageSchema = Type.Object({
  items: Type.Array(AdminOrderSummarySchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const AdminOrderInventoryEventSchema = Type.Object({
  action: Type.Union([
    Type.Literal('reserve'), Type.Literal('release'), Type.Literal('consume'),
    Type.Literal('restock'), Type.Literal('withdraw'),
  ]),
  quantity: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const AdminOrderItemInventorySchema = Type.Object({
  orderItemId: Type.String({ format: 'uuid' }),
  reservationId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  reservedQuantity: Type.Integer({ minimum: 0 }),
  events: Type.Array(AdminOrderInventoryEventSchema),
}, { additionalProperties: false })
export const AdminFulfillmentAttemptSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  orderItemId: Type.String({ format: 'uuid' }),
  administratorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  quantity: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('processing'), Type.Literal('unknown'), Type.Literal('succeeded'), Type.Literal('failed')]),
  deliverySource: Type.Union([
    Type.Literal('manual'), Type.Literal('code_pool'), Type.Literal('fixed_content'), Type.Literal('link'), Type.Literal('file'), Type.Literal('api'),
  ]),
  failureCode: Type.Union([Type.Null(),
    Type.Literal('CODE_POOL_DATA_INCONSISTENT'),
    Type.Literal('CODE_POOL_KEY_UNAVAILABLE'),
    Type.Literal('CODE_POOL_DECRYPTION_FAILED'),
    Type.Literal('CODE_POOL_PAYMENT_UNRESOLVED'),
    Type.Literal('FIXED_DELIVERY_DATA_INCONSISTENT'),
    Type.Literal('FIXED_DELIVERY_KEY_UNAVAILABLE'),
    Type.Literal('FIXED_DELIVERY_DECRYPTION_FAILED'),
    Type.Literal('FIXED_DELIVERY_VERSION_UNAVAILABLE'),
    Type.Literal('FIXED_DELIVERY_PAYMENT_UNRESOLVED'),
    Type.Literal('FILE_DELIVERY_DATA_INCONSISTENT'),
    Type.Literal('FILE_DELIVERY_OBJECT_UNAVAILABLE'),
    Type.Literal('FILE_DELIVERY_INTEGRITY_FAILED'),
    Type.Literal('FILE_DELIVERY_PAYMENT_UNRESOLVED'),
    Type.Literal('API_DELIVERY_DATA_INCONSISTENT'),
    Type.Literal('API_DELIVERY_KEY_UNAVAILABLE'),
    Type.Literal('API_DELIVERY_ENCRYPTION_FAILED'),
    Type.Literal('API_DELIVERY_PAYMENT_UNRESOLVED'),
    Type.Literal('API_DELIVERY_SUPPLIER_REJECTED'),
    Type.Literal('API_DELIVERY_DUPLICATE_RESULT'),
  ]),
  retryAfter: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  resultSha256: Type.Union([Type.String({ pattern: '^[0-9a-f]{64}$' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  deliveryCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const SupplierApiOperationEventSchema = Type.Object({
  eventType: Type.String({ minLength: 1, maxLength: 32 }),
  httpStatus: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
  classification: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
  providerStatus: Type.Union([Type.String({ minLength: 1, maxLength: 24 }), Type.Null()]),
  errorCode: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  responseSha256: Type.Union([Type.String({ pattern: '^[0-9a-f]{64}$' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const SupplierApiOperationSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  fulfillmentAttemptId: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  unitIndex: Type.Integer({ minimum: 1 }),
  supplierConnectionId: Type.String({ format: 'uuid' }),
  supplierName: Type.String({ minLength: 1, maxLength: 120 }),
  supplierProductId: Type.String({ minLength: 1, maxLength: 200 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 80 }),
  providerOperationId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  state: Type.Union([
    Type.Literal('create_pending'), Type.Literal('create_in_flight'), Type.Literal('query_pending'),
    Type.Literal('query_in_flight'), Type.Literal('processing'), Type.Literal('unknown'),
    Type.Literal('succeeded_pending_finalize'), Type.Literal('manual_review'),
    Type.Literal('succeeded'), Type.Literal('failed'),
  ]),
  createAttemptCount: Type.Integer({ minimum: 0 }),
  queryAttemptCount: Type.Integer({ minimum: 0 }),
  lastHttpStatus: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
  lastErrorCode: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  lastFailureClass: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
  lastProviderStatus: Type.Union([Type.String({ minLength: 1, maxLength: 24 }), Type.Null()]),
  nextActionAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createRequestedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  lastQueryAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  events: Type.Array(SupplierApiOperationEventSchema),
}, { additionalProperties: false })
export const AdminOrderDetailSchema = Type.Object({
  order: OrderDetailSchema,
  owner: Type.Object({
    type: Type.Union([Type.Literal('customer'), Type.Literal('guest')]),
    customerId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    customerUsername: Type.Union([CustomerUsernameSchema, Type.Null()]),
    guestSessionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  }, { additionalProperties: false }),
  inventory: Type.Array(AdminOrderItemInventorySchema),
  fulfillmentAttempts: Type.Array(AdminFulfillmentAttemptSchema),
  supplierOperations: Type.Array(SupplierApiOperationSchema),
  payments: AdminOrderPaymentsSchema,
}, { additionalProperties: false })
export const UpdateManualFulfillmentBodySchema = Type.Object({
  enabled: Type.Boolean(),
}, { additionalProperties: false })
export const ManualFulfillmentConfigSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  productType: ProductTypeSchema,
  method: Type.Union([FulfillmentMethodSchema, Type.Null()]),
  enabled: Type.Boolean(),
  codePoolDeliveryReady: Type.Boolean(),
  automaticDeliveryReady: Type.Boolean(),
  configurationRevision: Type.Integer({ minimum: 0 }),
  currentVersionNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false })
export const ManualFulfillmentConfigPageSchema = Type.Array(ManualFulfillmentConfigSchema)
export const FixedDeliveryMethodSchema = Type.Union([Type.Literal('fixed_content'), Type.Literal('link')])
export const FixedDeliveryVersionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionNumber: Type.Integer({ minimum: 1 }),
  method: FixedDeliveryMethodSchema,
  content: Type.String({ minLength: 1, maxLength: 20_000 }),
  title: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
  accessInstructions: Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const FixedDeliveryVersionSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionNumber: Type.Integer({ minimum: 1 }),
  method: FixedDeliveryMethodSchema,
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const FixedDeliveryConfigSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  productType: ProductTypeSchema,
  method: Type.Union([FulfillmentMethodSchema, Type.Null()]),
  automaticDeliveryReady: Type.Boolean(),
  configurationRevision: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  currentVersion: Type.Union([FixedDeliveryVersionSchema, Type.Null()]),
}, { additionalProperties: false })
export const FixedDeliveryVersionsPageSchema = Type.Object({
  items: Type.Array(FixedDeliveryVersionSummarySchema, { maxItems: 50 }),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 50 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const FixedDeliveryVersionsQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false })

export const SupplierProviderTypeSchema = Type.Union([Type.Literal('http_json_v1'), Type.Literal('kayixin_customer_v3')])
export const SupplierAuthSchemeSchema = Type.Union([Type.Literal('bearer'), Type.Literal('app_signature_v3')])
export const KayixinCredentialsSchema = Type.Object({
  appId: Type.String({ pattern: '^[0-9]{1,32}$' }),
  appSecret: Type.String({ minLength: 1, maxLength: 512, pattern: '^[!-~]+$' }),
}, { additionalProperties: false })
export const SupplierConnectionTestResultSchema = Type.Object({
  connectionOk: Type.Boolean(), queryCapable: Type.Boolean(),
  scope: Type.Union([Type.Literal('fulfillment_v1'), Type.Literal('catalog_read_v3')]),
  configurationVersionId: Type.String({ format: 'uuid' }),
  checkedAt: Type.String({ format: 'date-time' }),
  errorCode: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  message: Type.String({ maxLength: 200 }),
}, { additionalProperties: false })
export const SupplierConnectionVersionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionNumber: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  providerType: SupplierProviderTypeSchema,
  baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  authScheme: SupplierAuthSchemeSchema,
  credentialVersion: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const SupplierConnectionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  enabled: Type.Boolean(),
  providerType: SupplierProviderTypeSchema,
  fulfillmentEligible: Type.Boolean(),
  lastTest: Type.Union([SupplierConnectionTestResultSchema, Type.Null()]),
  credentialsConfigured: Type.Literal(true),
  currentVersion: SupplierConnectionVersionSchema,
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const SupplierConnectionPageSchema = Type.Array(SupplierConnectionSchema)
const SupplierConnectionConfigProperties = {
  name: Type.String({ minLength: 1, maxLength: 120, pattern: '.*\\S.*' }),
  baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
}
export const CreateSupplierConnectionBodySchema = Type.Union([
  Type.Object({ ...SupplierConnectionConfigProperties, providerType: Type.Literal('http_json_v1'),
    bearerToken: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
  Type.Object({ ...SupplierConnectionConfigProperties, providerType: Type.Literal('kayixin_customer_v3'),
    credentials: KayixinCredentialsSchema }, { additionalProperties: false }),
])
export const UpdateSupplierConnectionBodySchema = Type.Union([
  Type.Object({ ...SupplierConnectionConfigProperties, providerType: Type.Optional(Type.Literal('http_json_v1')),
    bearerToken: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })) }, { additionalProperties: false }),
  Type.Object({ ...SupplierConnectionConfigProperties, providerType: Type.Literal('kayixin_customer_v3'),
    credentials: Type.Optional(KayixinCredentialsSchema) }, { additionalProperties: false }),
])
export const UpdateSupplierConnectionEnabledBodySchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false })
export const SupplierConnectionVersionsPageSchema = Type.Object({
  items: Type.Array(SupplierConnectionVersionSchema, { maxItems: 50 }),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 50 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const SupplierConnectionVersionsQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false })
export const SupplierConnectionAuditEventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  administratorId: Type.String({ format: 'uuid' }),
  action: Type.Union([
    Type.Literal('created'), Type.Literal('configuration_updated'), Type.Literal('credential_rotated'),
    Type.Literal('credential_key_rewrapped'), Type.Literal('enabled'), Type.Literal('disabled'),
    Type.Literal('connection_test_succeeded'), Type.Literal('connection_test_failed'),
  ]),
  details: Type.Record(Type.String(), Type.Any()),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const SupplierConnectionAuditPageSchema = Type.Object({
  events: Type.Array(SupplierConnectionAuditEventSchema, { maxItems: 100 }),
}, { additionalProperties: false })
export const SupplierCredentialRewrapResultSchema = Type.Object({
  rewrappedCredentialVersions: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const ApiFulfillmentConfigSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  productType: ProductTypeSchema,
  method: Type.Union([FulfillmentMethodSchema, Type.Null()]),
  automaticDeliveryReady: Type.Boolean(),
  configurationRevision: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  supplierConnectionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  supplierConnectionName: Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()]),
  supplierEnabled: Type.Boolean(),
  supplierConnectionVersionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  supplierConnectionVersionNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  supplierProductId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  parameters: Type.Record(Type.String({ maxLength: 500 }), Type.String({ maxLength: 500 }), { maxProperties: 20 }),
  currentVersionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
}, { additionalProperties: false })
export const ApiFulfillmentHistoryItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionNumber: Type.Integer({ minimum: 1 }),
  supplierConnectionId: Type.String({ format: 'uuid' }),
  supplierConnectionName: Type.String({ minLength: 1, maxLength: 120 }),
  supplierConnectionVersionId: Type.String({ format: 'uuid' }),
  supplierConnectionVersionNumber: Type.Integer({ minimum: 1 }),
  supplierProductId: Type.String({ minLength: 1, maxLength: 200 }),
  parameters: Type.Record(Type.String({ maxLength: 500 }), Type.String({ maxLength: 500 }), { maxProperties: 20 }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const ApiFulfillmentHistoryPageSchema = Type.Object({
  items: Type.Array(ApiFulfillmentHistoryItemSchema, { maxItems: 50 }),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 50 }),
  totalPages: Type.Integer({ minimum: 0 }),
  events: Type.Array(Type.Object({
    id: Type.String({ format: 'uuid' }),
    administratorId: Type.String({ format: 'uuid' }),
    action: Type.Union([Type.Literal('version_saved'), Type.Literal('automatic_delivery_enabled'), Type.Literal('automatic_delivery_paused')]),
    details: Type.Record(Type.String(), Type.Any()),
    createdAt: Type.String({ format: 'date-time' }),
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false })
export const SaveApiFulfillmentVersionBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  supplierConnectionVersionId: Type.String({ format: 'uuid' }),
  supplierProductId: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
  parameters: Type.Record(Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_.-]+$' }),
    Type.String({ maxLength: 500 }), { maxProperties: 20 }),
}, { additionalProperties: false })
export const UpdateApiFulfillmentReadinessBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false })
export const ApiFulfillmentMutationResultSchema = Type.Object({
  configuration: ApiFulfillmentConfigSchema,
  currentVersion: Type.Union([ApiFulfillmentHistoryItemSchema, Type.Null()]),
}, { additionalProperties: false })
export const SupplierOperationAdminActionResultSchema = Type.Object({
  operation: SupplierApiOperationSchema,
}, { additionalProperties: false })
export const SaveFixedDeliveryContentBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  method: Type.Literal('fixed_content'),
  content: Type.String({ minLength: 1, maxLength: 20_000, pattern: '.*\\S.*' }),
}, { additionalProperties: false })
export const SaveFixedDeliveryLinkBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  method: Type.Literal('link'),
  url: Type.String({ minLength: 9, maxLength: 2_048, pattern: '^https://[^\\s]+$' }),
  title: Type.String({ minLength: 1, maxLength: 160, pattern: '.*\\S.*' }),
  accessInstructions: Type.Optional(Type.String({ maxLength: 4_000 })),
}, { additionalProperties: false })
export const SaveFixedDeliveryVersionBodySchema = Type.Union([
  SaveFixedDeliveryContentBodySchema,
  SaveFixedDeliveryLinkBodySchema,
])
export const UpdateFixedDeliveryReadinessBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false })
export const PrivateFileIntegrityStatusSchema = Type.Union([
  Type.Literal('verified'), Type.Literal('missing'), Type.Literal('corrupt'), Type.Literal('unknown'),
])
export const PrivateFileVersionSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionNumber: Type.Integer({ minimum: 1 }),
  displayFilename: Type.String({ minLength: 1, maxLength: 255 }),
  fileSizeBytes: Type.Integer({ minimum: 1, maximum: 104_857_600 }),
  fileMediaType: Type.String({ minLength: 1, maxLength: 96 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const PrivateFileVersionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionNumber: Type.Integer({ minimum: 1 }),
  displayFilename: Type.String({ minLength: 1, maxLength: 255 }),
  fileSizeBytes: Type.Integer({ minimum: 1, maximum: 104_857_600 }),
  fileMediaType: Type.String({ minLength: 1, maxLength: 96 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  createdAt: Type.String({ format: 'date-time' }),
  integrityStatus: PrivateFileIntegrityStatusSchema,
}, { additionalProperties: false })
export const PrivateFileUploadSchema = Type.Object({
  uploadId: Type.String({ format: 'uuid' }),
  uploadFilename: Type.String({ minLength: 1, maxLength: 255 }),
  fileSizeBytes: Type.Integer({ minimum: 1, maximum: 104_857_600 }),
  fileMediaType: Type.String({ minLength: 1, maxLength: 96 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  status: Type.Literal('staged'),
}, { additionalProperties: false })
export const PrivateFileVersionsPageSchema = Type.Object({
  items: Type.Array(PrivateFileVersionSummarySchema, { maxItems: 50 }),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 50 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const PrivateFileConfigSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  productType: ProductTypeSchema,
  method: Type.Union([FulfillmentMethodSchema, Type.Null()]),
  automaticDeliveryReady: Type.Boolean(),
  configurationRevision: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  integrityStatus: PrivateFileIntegrityStatusSchema,
  currentVersion: Type.Union([PrivateFileVersionSchema, Type.Null()]),
}, { additionalProperties: false })
export const PrivateFileVersionsQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false })
export const SavePrivateFileVersionBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  uploadId: Type.String({ format: 'uuid' }),
  displayFilename: Type.String({ minLength: 1, maxLength: 255, pattern: '.*\\S.*' }),
}, { additionalProperties: false })
export const UpdatePrivateFileReadinessBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false })
export const PrivateFileDownloadParamsSchema = Type.Object({
  orderId: Type.String({ format: 'uuid' }),
  itemId: Type.String({ format: 'uuid' }),
  deliveryId: Type.String({ format: 'uuid' }),
}, { additionalProperties: false })
export const GuestOrderSessionSchema = Type.Object({
  sessionId: Type.String({ format: 'uuid' }),
  expiresAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const ManualFulfillmentDeliveryBodySchema = Type.Object({
  operationId: Type.String({ format: 'uuid' }),
  deliveries: Type.Array(Type.Object({
    content: Type.String({ minLength: 1, maxLength: 512, pattern: '.*\\S.*' }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false })
export const ManualFulfillmentResultSchema = Type.Object({
  repeated: Type.Boolean(),
  order: OrderDetailSchema,
}, { additionalProperties: false })

export const CodePoolFormatSchema = Type.Union([
  Type.Literal('paste'), Type.Literal('txt'), Type.Literal('csv'),
])
export const CodePoolStatusFilterSchema = Type.Union([
  Type.Literal('all'), Type.Literal('available'), Type.Literal('reserved'),
  Type.Literal('delivered'), Type.Literal('revoked'),
])
export const CodePoolImportPreviewBodySchema = Type.Object({
  format: CodePoolFormatSchema,
  sourceText: Type.String({ minLength: 1, maxLength: 1_048_576 }),
}, { additionalProperties: false })
export const CodePoolImportBodySchema = Type.Object({
  operationId: Type.String({ format: 'uuid' }),
  format: CodePoolFormatSchema,
  sourceText: Type.String({ minLength: 1, maxLength: 1_048_576 }),
}, { additionalProperties: false })
export const CodePoolImportPreviewRowSchema = Type.Object({
  row: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('invalid')]),
  reason: Type.Union([Type.Null(),
    Type.Literal('duplicate_in_request'), Type.Literal('already_imported'),
    Type.Literal('empty'), Type.Literal('too_long'), Type.Literal('invalid_text'),
    Type.Literal('invalid_csv_row'),
  ]),
}, { additionalProperties: false })
export const CodePoolImportPreviewSchema = Type.Object({
  rowCount: Type.Integer({ minimum: 0 }),
  acceptedCount: Type.Integer({ minimum: 0 }),
  duplicateCount: Type.Integer({ minimum: 0 }),
  invalidCount: Type.Integer({ minimum: 0 }),
  rows: Type.Array(CodePoolImportPreviewRowSchema, { maxItems: 5000 }),
}, { additionalProperties: false })
export const CodePoolBatchSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  operationId: Type.String({ format: 'uuid' }),
  kind: Type.Union([Type.Literal('import'), Type.Literal('withdrawal')]),
  requestedCount: Type.Integer({ minimum: 0 }),
  acceptedCount: Type.Integer({ minimum: 0 }),
  duplicateCount: Type.Integer({ minimum: 0 }),
  invalidCount: Type.Integer({ minimum: 0 }),
  reason: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  administratorId: Type.String({ format: 'uuid' }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const CodePoolCountsSchema = Type.Object({
  available: Type.Integer({ minimum: 0 }),
  reserved: Type.Integer({ minimum: 0 }),
  delivered: Type.Integer({ minimum: 0 }),
  revoked: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CodePoolInventorySchema = Type.Object({
  stocked: Type.Integer({ minimum: 0 }),
  reserved: Type.Integer({ minimum: 0 }),
  available: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CodePoolStatusSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  enabled: Type.Boolean(),
  configured: Type.Boolean(),
  inventoryConsistent: Type.Boolean(),
  counts: CodePoolCountsSchema,
  inventory: CodePoolInventorySchema,
}, { additionalProperties: false })
export const CodePoolEntrySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  importBatchId: Type.String({ format: 'uuid' }),
  state: Type.Union([
    Type.Literal('available'), Type.Literal('reserved'), Type.Literal('delivered'), Type.Literal('revoked'),
  ]),
  orderId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  reservedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  deliveredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  revokedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false })
export const CodePoolListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  status: Type.Optional(CodePoolStatusFilterSchema),
  batchId: Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: false })
export const CodePoolEntryPageSchema = Type.Object({
  items: Type.Array(CodePoolEntrySchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CodePoolBatchPageSchema = Type.Object({
  items: Type.Array(CodePoolBatchSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CodePoolReadinessBodySchema = Type.Object({
  enabled: Type.Boolean(),
  expectedSkuRevision: Type.Integer({ minimum: 1 }),
  expectedInventoryRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const CodePoolWithdrawalBodySchema = Type.Object({
  operationId: Type.String({ format: 'uuid' }),
  entryIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 500 }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
  confirmation: Type.Literal('REVOKE_UNSOLD_CODES'),
}, { additionalProperties: false })
export const CodePoolMutationResultSchema = Type.Object({
  repeated: Type.Boolean(),
  batch: CodePoolBatchSchema,
  status: CodePoolStatusSchema,
}, { additionalProperties: false })

export const CustomerCartSchema = Type.Object({
  items: Type.Array(CheckoutQuoteItemSchema, { maxItems: 50 }),
  itemCount: Type.Integer({ minimum: 0, maximum: 50 }),
  totalQuantity: Type.Integer({ minimum: 0 }),
  pricedSubtotal: SettlementAmountSchema,
  totalAmount: Type.Union([SettlementAmountSchema, Type.Null()]),
  totalComplete: Type.Boolean(),
  canContinue: Type.Boolean(),
  policyReasons: Type.Array(Type.Union([
    Type.Literal('guest_checkout_disabled'), Type.Literal('guest_free_claim_disabled'),
  ]), { maxItems: 2 }),
  quotedAt: Type.String({ format: 'date-time' }),
  currency: Type.Literal('CNY'),
}, { additionalProperties: false })

export const CustomerCartMutationSchema = Type.Object({
  changed: Type.Boolean(),
  merged: Type.Boolean(),
  retainedLineId: Type.Union([PurchaseLineIdSchema, Type.Null()]),
  skippedSkuIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 50 }),
  cart: CustomerCartSchema,
}, { additionalProperties: false })

export const PublicProductCategoryAssignmentSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  path: Type.Array(PublicCategoryPathItemSchema, { minItems: 1, maxItems: 4 }),
  isPrimary: Type.Boolean(),
  sortOrder: Type.Integer(),
}, { additionalProperties: false })

export const PublicProductAttributeSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  value: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false })

export const PublicProductDetailSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 20_000 }),
  productType: ProductTypeSchema,
  purchaseLimits: PurchaseLimitSettingsSchema,
  priceRange: Type.Union([PublicProductPriceRangeSchema, Type.Null()]),
  selectionStatus: Type.Union([Type.Literal('available'), Type.Literal('none')]),
  gallery: Type.Array(PublicProductImageSchema, { maxItems: 20 }),
  // The validated 128 KiB JSON document can expand during HTML escaping; keep
  // the response contract above its worst-case rendered size.
  richContentHtml: Type.String({ maxLength: 900_000 }),
  categories: Type.Array(PublicProductCategoryAssignmentSchema),
  optionGroups: Type.Array(PublicProductOptionGroupSchema, { maxItems: 5 }),
  variants: Type.Array(PublicProductVariantSchema, { maxItems: 1000 }),
  attributes: Type.Array(PublicProductAttributeSchema, { maxItems: 30 }),
}, { additionalProperties: false })

export const PublicSitemapQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000 })),
}, { additionalProperties: false })

export const PublicSitemapItemSchema = Type.Object({
  type: Type.Union([Type.Literal('product'), Type.Literal('category')]),
  id: Type.String({ format: 'uuid' }),
  lastModified: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const PublicSitemapResponseSchema = Type.Object({
  items: Type.Array(PublicSitemapItemSchema, { maxItems: 50_000 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 50_000 }),
  total: Type.Integer({ minimum: 0 }),
  totalPages: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const UpdateProductBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 20_000 })),
  productType: Type.Optional(ProductTypeSchema),
}, { additionalProperties: false, minProperties: 2 })

export const UpdateProductLifecycleBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  status: ProductStatusSchema,
}, { additionalProperties: false })

export const ProductExpectedRevisionBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const ProductDeleteResultSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  deleted: Type.Literal(true),
}, { additionalProperties: false })

export const ProductManagementOperationSchema = Type.Union([
  Type.Literal('created'), Type.Literal('updated'), Type.Literal('published'),
  Type.Literal('paused'), Type.Literal('relisted'), Type.Literal('archived'),
  Type.Literal('restored'), Type.Literal('copied'), Type.Literal('deleted'),
  Type.Literal('gallery_updated'), Type.Literal('rich_content_updated'),
])

export const ProductAuditSnapshotSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 20_000 })),
  productType: Type.Optional(ProductTypeSchema),
  status: Type.Optional(ProductStatusSchema),
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
  descriptionLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_000 })),
  descriptionChanged: Type.Optional(Type.Boolean()),
  changedFields: Type.Optional(Type.Array(Type.Union([
    Type.Literal('name'), Type.Literal('description'), Type.Literal('productType'),
  ]))),
  skuCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  sourceProductId: Type.Optional(Type.String({ format: 'uuid' })),
  galleryCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  galleryMediaIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20 })),
  richContentSummary: Type.Optional(Type.Object({
    byteLength: Type.Integer({ minimum: 0, maximum: 131_072 }),
    textLength: Type.Integer({ minimum: 0, maximum: 50_000 }),
    nodeCount: Type.Integer({ minimum: 1, maximum: 500 }),
    mediaCount: Type.Integer({ minimum: 0, maximum: 100 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

export const ProductManagementAuditEventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  productId: Type.String({ format: 'uuid' }),
  administratorId: Type.String({ format: 'uuid' }),
  operation: ProductManagementOperationSchema,
  occurredAt: Type.String({ format: 'date-time' }),
  before: Type.Union([ProductAuditSnapshotSchema, Type.Null()]),
  after: Type.Union([ProductAuditSnapshotSchema, Type.Null()]),
}, { additionalProperties: false })

export const ProductAuditHistoryQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  beforeCreatedAt: Type.Optional(Type.String({ format: 'date-time' })),
  beforeId: Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: false })

export const ProductAuditHistoryPageSchema = Type.Object({
  productId: Type.String({ format: 'uuid' }),
  events: Type.Array(ProductManagementAuditEventSchema, { maxItems: 100 }),
  nextCursor: Type.Union([Type.Object({
    createdAt: Type.String({ format: 'date-time' }),
    id: Type.String({ format: 'uuid' }),
  }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false })

const UuidSchema = Type.String({ format: 'uuid' })
const SortOrderSchema = Type.Integer({ minimum: 0, maximum: 1_000_000 })
const CategoryNameSchema = Type.String({ minLength: 1, maxLength: 120 })
const OptionNameSchema = Type.String({ minLength: 1, maxLength: 80 })

export const AdminProductCategorySchema = Type.Object({
  id: UuidSchema,
  parentId: Type.Union([UuidSchema, Type.Null()]),
  name: CategoryNameSchema,
  sortOrder: Type.Integer(),
  isVisible: Type.Boolean(),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const AdminProductCategoriesSchema = Type.Object({
  categories: Type.Array(AdminProductCategorySchema),
})

export const CreateProductCategoryBodySchema = Type.Object({
  name: CategoryNameSchema,
  parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  sortOrder: Type.Optional(SortOrderSchema),
  isVisible: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })

export const UpdateProductCategoryBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  name: Type.Optional(CategoryNameSchema),
  parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  sortOrder: Type.Optional(SortOrderSchema),
  isVisible: Type.Optional(Type.Boolean()),
}, { additionalProperties: false, minProperties: 2 })

export const DeleteProductCategoryBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const ReplaceProductCategoriesBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  assignments: Type.Array(Type.Object({
    categoryId: UuidSchema,
    isPrimary: Type.Boolean(),
    sortOrder: SortOrderSchema,
  }, { additionalProperties: false })),
}, { additionalProperties: false })

export const ReplaceProductAttributesBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  attributes: Type.Array(Type.Object({
    id: Type.Optional(UuidSchema),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    value: Type.String({ minLength: 1, maxLength: 500 }),
    sortOrder: SortOrderSchema,
  }, { additionalProperties: false }), { maxItems: 30 }),
}, { additionalProperties: false })

const ProductVariantMatrixGroupSchema = Type.Object({
  id: UuidSchema,
  name: OptionNameSchema,
  sortOrder: SortOrderSchema,
  enabled: Type.Boolean(),
  values: Type.Array(Type.Object({
    id: UuidSchema,
    name: OptionNameSchema,
    sortOrder: SortOrderSchema,
    enabled: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: 50 }),
}, { additionalProperties: false })

const ProductVariantMatrixCombinationSchema = Type.Object({
  skuId: Type.Optional(UuidSchema),
  optionValueIds: Type.Array(UuidSchema, { maxItems: 5 }),
  salePrice: Type.Optional(ProductSalePriceSchema),
  enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })

const ProductVariantRetireIdsSchema = Type.Optional(Type.Array(UuidSchema, { maxItems: 1000 }))
const ProductVariantMatrixSkuEnabledUpdateSchema = Type.Object({
  skuId: UuidSchema,
  enabled: Type.Boolean(),
}, { additionalProperties: false })

export const ProductVariantMatrixAllBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  groups: Type.Array(ProductVariantMatrixGroupSchema, { maxItems: 5 }),
  mode: Type.Literal('all'),
  newSkuDefaults: Type.Object({ salePrice: ProductSalePriceSchema, enabled: Type.Boolean() }, { additionalProperties: false }),
  skuEnabledUpdates: Type.Optional(Type.Array(ProductVariantMatrixSkuEnabledUpdateSchema, { maxItems: 1000 })),
  retireSkuIds: ProductVariantRetireIdsSchema,
}, { additionalProperties: false })

export const ProductVariantMatrixSelectedBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  groups: Type.Array(ProductVariantMatrixGroupSchema, { maxItems: 5 }),
  mode: Type.Literal('selected'),
  combinations: Type.Array(ProductVariantMatrixCombinationSchema, { minItems: 1, maxItems: 1000 }),
  retireSkuIds: ProductVariantRetireIdsSchema,
}, { additionalProperties: false })

export const ProductVariantMatrixBodySchema = Type.Union([
  ProductVariantMatrixAllBodySchema,
  ProductVariantMatrixSelectedBodySchema,
])

export const ProductVariantMatrixChangeSchema = Type.Object({
  change: Type.Union([
    Type.Literal('added'), Type.Literal('retained'), Type.Literal('modified'),
    Type.Literal('removed'), Type.Literal('retired'),
  ]),
  skuId: Type.Union([UuidSchema, Type.Null()]),
  skuCode: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  salePrice: Type.Union([ProductSalePriceSchema, Type.Null()]),
  enabled: Type.Union([Type.Boolean(), Type.Null()]),
  options: Type.Array(Type.Object({
    groupId: UuidSchema,
    groupName: OptionNameSchema,
    valueId: UuidSchema,
    valueName: OptionNameSchema,
  }, { additionalProperties: false })),
  inventoryMutationBlocked: Type.Boolean(),
  inventoryMutationBlockReason: Type.Union([
    Type.Literal('stocked_quantity'),
    Type.Literal('reserved_quantity'),
    Type.Literal('adjustment_history'),
    Type.Null(),
  ]),
  retirementBlocked: Type.Boolean(),
  retirementBlockReason: Type.Union([
    Type.Literal('stocked_quantity'),
    Type.Literal('reserved_quantity'),
    Type.Null(),
  ]),
}, { additionalProperties: false })

export const ProductVariantMatrixPreviewSchema = Type.Object({
  productId: UuidSchema,
  currentRevision: Type.Integer({ minimum: 1 }),
  possibleCombinationCount: Type.Integer({ minimum: 1 }),
  requestedSkuCount: Type.Integer({ minimum: 1, maximum: 1000 }),
  changes: Type.Array(ProductVariantMatrixChangeSchema),
}, { additionalProperties: false })

export const ProductVariantMatrixSaveResultSchema = Type.Object({
  product: ProductDetailSchema,
  changes: Type.Array(ProductVariantMatrixChangeSchema),
}, { additionalProperties: false })

export const ProductCategoryDeleteResultSchema = Type.Object({ deleted: Type.Literal(true) })
export const ReadySchema = Type.Object({
  status: Type.Literal('ok'),
  service: Type.Literal('aikayun-api'),
  database: Type.Literal('ready'),
})

export const UnitAmountSchema = Type.String({ pattern: '^-?(?:0|[1-9]\\d{0,12})(?:\\.\\d{1,5})?$' })
export function ApiSuccessSchemaOf<T extends TSchema>(data: T) {
  return Type.Object({ data, meta: RequestMetaSchema })
}

export type ApiSuccess<T> = { data: T; meta: { requestId: string } }
export type ApiError = Static<typeof ApiErrorSchema>
export type Health = Static<typeof HealthSchema>
export type CsrfToken = Static<typeof CsrfTokenSchema>
export type AdminLoginBody = Static<typeof AdminLoginBodySchema>
export type Admin = Static<typeof AdminSchema>
export type AdminSession = Static<typeof AdminSessionSchema>
export type AdminLogout = Static<typeof AdminLogoutSchema>
export type AdminOverview = Static<typeof AdminOverviewSchema>
export type CustomerRegisterBody = Static<typeof CustomerRegisterBodySchema>
export type CustomerLoginBody = Static<typeof CustomerLoginBodySchema>
export type Customer = Static<typeof CustomerSchema>
export type CustomerSession = Static<typeof CustomerSessionSchema>
export type CustomerProfile = Static<typeof CustomerProfileSchema>
export type UpdateCustomerProfileBody = Static<typeof UpdateCustomerProfileBodySchema>
export type ChangeCustomerPasswordBody = Static<typeof ChangeCustomerPasswordBodySchema>
export type CustomerPasswordChanged = Static<typeof CustomerPasswordChangedSchema>
export type CustomerLogout = Static<typeof CustomerLogoutSchema>
export type AdminCustomerStatus = Static<typeof AdminCustomerStatusSchema>
export type AdminCustomerListQuery = Static<typeof AdminCustomerListQuerySchema>
export type AdminCustomerOrdersQuery = Static<typeof AdminCustomerOrdersQuerySchema>
export type AdminCustomerListItem = Static<typeof AdminCustomerListItemSchema>
export type AdminCustomerList = Static<typeof AdminCustomerListSchema>
export type AdminCustomerDetail = Static<typeof AdminCustomerDetailSchema>
export type AdminCustomerProfileUpdateBody = Static<typeof AdminCustomerProfileUpdateBodySchema>
export type AdminCustomerStatusBody = Static<typeof AdminCustomerStatusBodySchema>
export type AdminCustomerPasswordResetBody = Static<typeof AdminCustomerPasswordResetBodySchema>
export type AdminCustomerStatusResult = Static<typeof AdminCustomerStatusResultSchema>
export type AdminCustomerPasswordResetResult = Static<typeof AdminCustomerPasswordResetResultSchema>
export type AdminCustomerDeleteResult = Static<typeof AdminCustomerDeleteResultSchema>
export type AdminCustomerOrderSummary = Static<typeof AdminCustomerOrderSummarySchema>
export type AdminCustomerOrderPage = Static<typeof AdminCustomerOrderPageSchema>
export type CustomerManagementAuditAction = Static<typeof CustomerManagementAuditActionSchema>
export type CustomerManagementAuditSummary = Static<typeof CustomerManagementAuditSummarySchema>
export type AdminCustomerAuditEvent = Static<typeof AdminCustomerAuditEventSchema>
export type AdminCustomerAuditPage = Static<typeof AdminCustomerAuditPageSchema>
export type CustomerWalletSummary = Static<typeof CustomerWalletSummarySchema>
export type CustomerWalletLedgerEntry = Static<typeof CustomerWalletLedgerEntrySchema>
export type CustomerWalletLedgerPage = Static<typeof CustomerWalletLedgerPageSchema>
export type CustomerTopUp = Static<typeof CustomerTopUpSchema>
export type CustomerTopUpPage = Static<typeof CustomerTopUpPageSchema>
export type CreateWalletTopUpBody = Static<typeof CreateWalletTopUpBodySchema>
export type CustomerWalletPageQuery = Static<typeof CustomerWalletPageQuerySchema>
export type WithdrawalPayoutMethod = Static<typeof WithdrawalPayoutMethodSchema>
export type WithdrawalStatus = Static<typeof WithdrawalStatusSchema>
export type WithdrawalPayoutAttemptStatus = Static<typeof WithdrawalPayoutAttemptStatusSchema>
export type WithdrawalSettings = Static<typeof WithdrawalSettingsSchema>
export type UpdateWithdrawalSettingsBody = Static<typeof UpdateWithdrawalSettingsBodySchema>
export type CustomerWithdrawalPolicy = Static<typeof CustomerWithdrawalPolicySchema>
export type WithdrawalRecipientInput = Static<typeof WithdrawalRecipientInputSchema>
export type WithdrawalRecipientSnapshot = Static<typeof WithdrawalRecipientSnapshotSchema>
export type CreateWithdrawalBody = Static<typeof CreateWithdrawalBodySchema>
export type WithdrawalPayoutResult = Static<typeof WithdrawalPayoutResultSchema>
export type WithdrawalPayoutAttempt = Static<typeof WithdrawalPayoutAttemptSchema>
export type CustomerWithdrawalPayoutAttempt = Static<typeof CustomerWithdrawalPayoutAttemptSchema>
export type CustomerWithdrawal = Static<typeof CustomerWithdrawalSchema>
export type CustomerWithdrawalPage = Static<typeof CustomerWithdrawalPageSchema>
export type CustomerWithdrawalMutation = Static<typeof CustomerWithdrawalMutationSchema>
export type WithdrawalPageQuery = Static<typeof WithdrawalPageQuerySchema>
export type AdminWithdrawalListQuery = Static<typeof AdminWithdrawalListQuerySchema>
export type AdminWithdrawalListItem = Static<typeof AdminWithdrawalListItemSchema>
export type AdminWithdrawalList = Static<typeof AdminWithdrawalListSchema>
export type WithdrawalAuditEvent = Static<typeof WithdrawalAuditEventSchema>
export type WithdrawalLedgerEntry = Static<typeof WithdrawalLedgerEntrySchema>
export type AdminWithdrawalDetail = Static<typeof AdminWithdrawalDetailSchema>
export type AdminWithdrawalActionBody = Static<typeof AdminWithdrawalActionBodySchema>
export type AdminWithdrawalRejectionBody = Static<typeof AdminWithdrawalRejectionBodySchema>
export type AdminWithdrawalResolveBody = Static<typeof AdminWithdrawalResolveBodySchema>
export type WithdrawalQrUpload = Static<typeof WithdrawalQrUploadSchema>
export type AdminWalletListQuery = Static<typeof AdminWalletListQuerySchema>
export type AdminWalletListItem = Static<typeof AdminWalletListItemSchema>
export type AdminWalletList = Static<typeof AdminWalletListSchema>
export type AdminWalletDetail = Static<typeof AdminWalletDetailSchema>
export type AdminPaymentReconciliationResult = Static<typeof AdminPaymentReconciliationResultSchema>
export type StorefrontCustomerPolicy = Static<typeof StorefrontCustomerPolicySchema>
export type UpdateStorefrontCustomerPolicyBody = Static<typeof UpdateStorefrontCustomerPolicyBodySchema>
export type ProductType = Static<typeof ProductTypeSchema>
export type ProductStatus = Static<typeof ProductStatusSchema>
export type ProductSalePrice = Static<typeof ProductSalePriceSchema>
export type ProductCostPrice = Static<typeof ProductCostPriceSchema>
export type ProductInventoryMode = Static<typeof ProductInventoryModeSchema>
export type NullableProductInventoryMode = Static<typeof NullableProductInventoryModeSchema>
export type AdminProductVariantPrices = Static<typeof AdminProductVariantPricesSchema>
export type AdminProductVariantPricesQuery = Static<typeof AdminProductVariantPricesQuerySchema>
export type AdminProductVariantPricesPage = Static<typeof AdminProductVariantPricesPageSchema>
export type UpdateAdminProductVariantPricesBatchBody = Static<typeof UpdateAdminProductVariantPricesBatchBodySchema>
export type AdminProductVariantPricesBatchResult = Static<typeof AdminProductVariantPricesBatchResultSchema>
export type UpdateAdminProductVariantPricesBody = Static<typeof UpdateAdminProductVariantPricesBodySchema>
export type ProductInventoryStatus = Static<typeof ProductInventoryStatusSchema>
export type AdminProductVariantInventory = Static<typeof AdminProductVariantInventorySchema>
export type AdminProductInventorySummary = Static<typeof AdminProductInventorySummarySchema>
export type ProductInventorySummaryQuery = Static<typeof ProductInventorySummaryQuerySchema>
export type UpdateProductInventoryModeBody = Static<typeof UpdateProductInventoryModeBodySchema>
export type CreateInventoryAdjustmentBody = Static<typeof CreateInventoryAdjustmentBodySchema>
export type InventoryAdjustment = Static<typeof InventoryAdjustmentSchema>
export type InventoryAdjustmentPage = Static<typeof InventoryAdjustmentPageSchema>
export type InventoryAdjustmentQuery = Static<typeof InventoryAdjustmentQuerySchema>
export type CreateProductBody = Static<typeof CreateProductBodySchema>
export type ProductIdParams = Static<typeof ProductIdParamsSchema>
export type ProductVariantIdParams = Static<typeof ProductVariantIdParamsSchema>
export type ProductVariant = Static<typeof ProductVariantSchema>
export type PurchaseLimitSettings = Static<typeof PurchaseLimitSettingsSchema>
export type SkuPurchaseLimitSettings = Static<typeof SkuPurchaseLimitSettingsSchema>
export type UpdateProductPurchaseLimitsBody = Static<typeof UpdateProductPurchaseLimitsBodySchema>
export type UpdateSkuPurchaseLimitsBody = Static<typeof UpdateSkuPurchaseLimitsBodySchema>
export type PurchaseLimitStatus = Static<typeof PurchaseLimitStatusSchema>
export type CheckoutPurchaseLimits = Static<typeof CheckoutPurchaseLimitsSchema>
export type ProductOptionValue = Static<typeof ProductOptionValueSchema>
export type ProductOptionGroup = Static<typeof ProductOptionGroupSchema>
export type ProductCategoryAssignment = Static<typeof ProductCategoryAssignmentSchema>
export type ProductAttribute = Static<typeof ProductAttributeSchema>
export type ProductMediaVariant = Static<typeof ProductMediaVariantSchema>
export type ProductMediaVariantMetadata = Static<typeof ProductMediaVariantMetadataSchema>
export type ProductMediaMetadata = Static<typeof ProductMediaMetadataSchema>
export type ProductMediaLibraryQuery = Static<typeof ProductMediaLibraryQuerySchema>
export type ProductMediaLibraryItem = Static<typeof ProductMediaLibraryItemSchema>
export type ProductMediaLibraryPage = Static<typeof ProductMediaLibraryPageSchema>
export type ProductGalleryImage = Static<typeof ProductGalleryImageSchema>
export type ReplaceProductGalleryBody = Static<typeof ReplaceProductGalleryBodySchema>
export type ProductGalleryResponse = Static<typeof ProductGalleryResponseSchema>
export type SaveProductRichContentBody = Static<typeof SaveProductRichContentBodySchema>
export type ProductRichContentResponse = Static<typeof ProductRichContentResponseSchema>
export type ProductMediaDeleteResponse = Static<typeof ProductMediaDeleteResponseSchema>

export * from './product-rich-content.js'

export type ProductDetail = Static<typeof ProductDetailSchema>
export type ProductListQuery = Static<typeof ProductListQuerySchema>
export type ProductListItem = Static<typeof ProductListItemSchema>
export type ProductListResponse = Static<typeof ProductListResponseSchema>
export type PublicCatalogSort = Static<typeof PublicCatalogSortSchema>
export type PublicProductListQuery = Static<typeof PublicProductListQuerySchema>
export type PublicProductSearchQuery = Static<typeof PublicProductSearchQuerySchema>
export type PublicProductImage = Static<typeof PublicProductImageSchema>
export type PublicProductCard = Static<typeof PublicProductCardSchema>
export type PublicProductPage = Static<typeof PublicProductPageSchema>
export type PublicCategoryPathItem = Static<typeof PublicCategoryPathItemSchema>
export type PublicCategory = Static<typeof PublicCategorySchema>
export type PublicCategoriesResponse = Static<typeof PublicCategoriesResponseSchema>
export type PublicCategoryProductsResponse = Static<typeof PublicCategoryProductsResponseSchema>
export type PublicInventorySummary = Static<typeof PublicInventorySummarySchema>
export type PublicProductOptionGroup = Static<typeof PublicProductOptionGroupSchema>
export type PublicProductVariant = Static<typeof PublicProductVariantSchema>
export type CartSkuQuantity = Static<typeof CartSkuQuantitySchema>
export type CheckoutRequestLineV2 = Static<typeof CheckoutRequestLineV2Schema>
export type CustomerCartAddBody = Static<typeof CustomerCartAddBodySchema>
export type CustomerCartUpdateBody = Static<typeof CustomerCartUpdateBodySchema>
export type CustomerCartLineParams = Static<typeof CustomerCartLineParamsSchema>
export type CustomerCartLineQuantityBody = Static<typeof CustomerCartLineQuantityBodySchema>
export type CustomerCartLinePurchaseFormBody = Static<typeof CustomerCartLinePurchaseFormBodySchema>
export type CustomerCartMergeBodyV1 = Static<typeof CustomerCartMergeBodyV1Schema>
export type CustomerCartMergeBodyV2 = Static<typeof CustomerCartMergeBodyV2Schema>
export type CustomerCartMergeBody = Static<typeof CustomerCartMergeBodySchema>
export type CheckoutQuoteBodyV1 = Static<typeof CheckoutQuoteBodyV1Schema>
export type CheckoutQuoteBodyV2 = Static<typeof CheckoutQuoteBodyV2Schema>
export type CheckoutQuoteBody = Static<typeof CheckoutQuoteBodySchema>
export type CheckoutQuoteReason = Static<typeof CheckoutQuoteReasonSchema>
export type CheckoutQuoteItem = Static<typeof CheckoutQuoteItemSchema>
export type CheckoutQuote = Static<typeof CheckoutQuoteSchema>
export type CreateOrderBodyV1 = Static<typeof CreateOrderBodyV1Schema>
export type CreateOrderBodyV2 = Static<typeof CreateOrderBodyV2Schema>
export type CreateOrderBody = Static<typeof CreateOrderBodySchema>
export type ExternalPaymentMethod = Static<typeof ExternalPaymentMethodSchema>
export type PaymentProviderType = Static<typeof PaymentProviderTypeSchema>
export type PaymentAction = Static<typeof PaymentActionSchema>
export type CustomerPaymentAttempt = Static<typeof CustomerPaymentAttemptSchema>
export type CustomerOrderPayment = Static<typeof CustomerOrderPaymentSchema>
export type CreateOrderPaymentBody = Static<typeof CreateOrderPaymentBodySchema>
export type AdminPaymentChannel = Static<typeof AdminPaymentChannelSchema>
export type CreatePaymentChannelBody = Static<typeof CreatePaymentChannelBodySchema>
export type UpdatePaymentChannelBody = Static<typeof UpdatePaymentChannelBodySchema>
export type PaymentCredentialReencryptionResult = Static<typeof PaymentCredentialReencryptionResultSchema>
export type AdminOrderPayments = Static<typeof AdminOrderPaymentsSchema>
export type AdminPaymentAttempt = Static<typeof AdminPaymentAttemptSchema>
export type AdminPaymentProviderEvent = Static<typeof AdminPaymentProviderEventSchema>
export type CreateOrderResult = Static<typeof CreateOrderResultSchema>
export type OrderStatus = Static<typeof OrderStatusSchema>
export type OrderSummary = Static<typeof OrderSummarySchema>
export type OrderItem = Static<typeof OrderItemSchema>
export type OrderFulfillmentAttempt = Static<typeof OrderFulfillmentAttemptSchema>
export type OrderDetail = Static<typeof OrderDetailSchema>
export type OrderPage = Static<typeof OrderPageSchema>
export type RefundStatus = Static<typeof RefundStatusSchema>
export type RefundProgressStatus = Static<typeof RefundProgressStatusSchema>
export type RefundPayoutMode = Static<typeof RefundPayoutModeSchema>
export type CustomerOrderRefund = Static<typeof CustomerOrderRefundSchema>
export type CustomerOrderRefunds = Static<typeof CustomerOrderRefundsSchema>
export type AdminOrderRefunds = Static<typeof AdminOrderRefundsSchema>
export type CreateOrderRefundBody = Static<typeof CreateOrderRefundBodySchema>
export type AdminRefundActionBody = Static<typeof AdminRefundActionBodySchema>
export type AdminRefundRejectionBody = Static<typeof AdminRefundRejectionBodySchema>
export type AdminRefundManualResolutionBody = Static<typeof AdminRefundManualResolutionBodySchema>
export type CustomerOrderRefundMutation = Static<typeof CustomerOrderRefundMutationSchema>
export type AdminOrderRefundMutation = Static<typeof AdminOrderRefundMutationSchema>
export type AdminOrderPage = Static<typeof AdminOrderPageSchema>
export type AdminOrderDetail = Static<typeof AdminOrderDetailSchema>
export type UpdateManualFulfillmentBody = Static<typeof UpdateManualFulfillmentBodySchema>
export type ManualFulfillmentConfig = Static<typeof ManualFulfillmentConfigSchema>
export type ManualFulfillmentConfigPage = Static<typeof ManualFulfillmentConfigPageSchema>
export type ManualFulfillmentResult = Static<typeof ManualFulfillmentResultSchema>
export type FixedDeliveryMethod = Static<typeof FixedDeliveryMethodSchema>
export type FixedDeliveryVersion = Static<typeof FixedDeliveryVersionSchema>
export type FixedDeliveryVersionSummary = Static<typeof FixedDeliveryVersionSummarySchema>
export type FixedDeliveryConfig = Static<typeof FixedDeliveryConfigSchema>
export type FixedDeliveryVersionsPage = Static<typeof FixedDeliveryVersionsPageSchema>
export type FixedDeliveryVersionsQuery = Static<typeof FixedDeliveryVersionsQuerySchema>
export type SaveFixedDeliveryVersionBody = Static<typeof SaveFixedDeliveryVersionBodySchema>
export type UpdateFixedDeliveryReadinessBody = Static<typeof UpdateFixedDeliveryReadinessBodySchema>
export type SupplierConnection = Static<typeof SupplierConnectionSchema>
export type SupplierConnectionVersion = Static<typeof SupplierConnectionVersionSchema>
export type SupplierConnectionTestResult = Static<typeof SupplierConnectionTestResultSchema>
export type SupplierConnectionVersionsPage = Static<typeof SupplierConnectionVersionsPageSchema>
export type SupplierConnectionVersionsQuery = Static<typeof SupplierConnectionVersionsQuerySchema>
export type SupplierConnectionAuditPage = Static<typeof SupplierConnectionAuditPageSchema>
export type CreateSupplierConnectionBody = Static<typeof CreateSupplierConnectionBodySchema>
export type UpdateSupplierConnectionBody = Static<typeof UpdateSupplierConnectionBodySchema>
export type UpdateSupplierConnectionEnabledBody = Static<typeof UpdateSupplierConnectionEnabledBodySchema>
export type ApiFulfillmentConfig = Static<typeof ApiFulfillmentConfigSchema>
export type ApiFulfillmentHistoryItem = Static<typeof ApiFulfillmentHistoryItemSchema>
export type ApiFulfillmentHistoryPage = Static<typeof ApiFulfillmentHistoryPageSchema>
export type SaveApiFulfillmentVersionBody = Static<typeof SaveApiFulfillmentVersionBodySchema>
export type UpdateApiFulfillmentReadinessBody = Static<typeof UpdateApiFulfillmentReadinessBodySchema>
export type ApiFulfillmentMutationResult = Static<typeof ApiFulfillmentMutationResultSchema>
export type SupplierApiOperation = Static<typeof SupplierApiOperationSchema>
export type SupplierOperationAdminActionResult = Static<typeof SupplierOperationAdminActionResultSchema>
export type PrivateFileIntegrityStatus = Static<typeof PrivateFileIntegrityStatusSchema>
export type PrivateFileVersionSummary = Static<typeof PrivateFileVersionSummarySchema>
export type PrivateFileVersion = Static<typeof PrivateFileVersionSchema>
export type PrivateFileUpload = Static<typeof PrivateFileUploadSchema>
export type PrivateFileVersionsPage = Static<typeof PrivateFileVersionsPageSchema>
export type PrivateFileConfig = Static<typeof PrivateFileConfigSchema>
export type PrivateFileVersionsQuery = Static<typeof PrivateFileVersionsQuerySchema>
export type SavePrivateFileVersionBody = Static<typeof SavePrivateFileVersionBodySchema>
export type UpdatePrivateFileReadinessBody = Static<typeof UpdatePrivateFileReadinessBodySchema>
export type PrivateFileDownloadParams = Static<typeof PrivateFileDownloadParamsSchema>
export type GuestOrderSession = Static<typeof GuestOrderSessionSchema>
export type ManualFulfillmentDeliveryBody = Static<typeof ManualFulfillmentDeliveryBodySchema>
export type CodePoolFormat = Static<typeof CodePoolFormatSchema>
export type CodePoolImportPreviewBody = Static<typeof CodePoolImportPreviewBodySchema>
export type CodePoolImportBody = Static<typeof CodePoolImportBodySchema>
export type CodePoolImportPreview = Static<typeof CodePoolImportPreviewSchema>
export type CodePoolBatch = Static<typeof CodePoolBatchSchema>
export type CodePoolBatchPage = Static<typeof CodePoolBatchPageSchema>
export type CodePoolStatus = Static<typeof CodePoolStatusSchema>
export type CodePoolEntry = Static<typeof CodePoolEntrySchema>
export type CodePoolEntryPage = Static<typeof CodePoolEntryPageSchema>
export type CodePoolListQuery = Static<typeof CodePoolListQuerySchema>
export type CodePoolReadinessBody = Static<typeof CodePoolReadinessBodySchema>
export type CodePoolWithdrawalBody = Static<typeof CodePoolWithdrawalBodySchema>
export type CodePoolMutationResult = Static<typeof CodePoolMutationResultSchema>
export type CustomerCart = Static<typeof CustomerCartSchema>
export type CustomerCartMutation = Static<typeof CustomerCartMutationSchema>
export type PublicProductCategoryAssignment = Static<typeof PublicProductCategoryAssignmentSchema>
export type PublicProductAttribute = Static<typeof PublicProductAttributeSchema>
export type PublicProductDetail = Static<typeof PublicProductDetailSchema>
export type PublicSitemapQuery = Static<typeof PublicSitemapQuerySchema>
export type PublicSitemapItem = Static<typeof PublicSitemapItemSchema>
export type PublicSitemapResponse = Static<typeof PublicSitemapResponseSchema>
export type UpdateProductBody = Static<typeof UpdateProductBodySchema>
export type UpdateProductLifecycleBody = Static<typeof UpdateProductLifecycleBodySchema>
export type ProductExpectedRevisionBody = Static<typeof ProductExpectedRevisionBodySchema>
export type ProductDeleteResult = Static<typeof ProductDeleteResultSchema>
export type ProductManagementOperation = Static<typeof ProductManagementOperationSchema>
export type ProductAuditSnapshot = Static<typeof ProductAuditSnapshotSchema>
export type ProductManagementAuditEvent = Static<typeof ProductManagementAuditEventSchema>
export type ProductAuditHistoryQuery = Static<typeof ProductAuditHistoryQuerySchema>
export type ProductAuditHistoryPage = Static<typeof ProductAuditHistoryPageSchema>
export type AdminProductCategory = Static<typeof AdminProductCategorySchema>
export type AdminProductCategories = Static<typeof AdminProductCategoriesSchema>
export type CreateProductCategoryBody = Static<typeof CreateProductCategoryBodySchema>
export type UpdateProductCategoryBody = Static<typeof UpdateProductCategoryBodySchema>
export type DeleteProductCategoryBody = Static<typeof DeleteProductCategoryBodySchema>
export type ReplaceProductCategoriesBody = Static<typeof ReplaceProductCategoriesBodySchema>
export type ReplaceProductAttributesBody = Static<typeof ReplaceProductAttributesBodySchema>
export type ProductVariantMatrixBody = Static<typeof ProductVariantMatrixBodySchema>
export type ProductVariantMatrixPreview = Static<typeof ProductVariantMatrixPreviewSchema>
export type ProductVariantMatrixSaveResult = Static<typeof ProductVariantMatrixSaveResultSchema>
export type Ready = Static<typeof ReadySchema>
export type UnitAmount = Static<typeof UnitAmountSchema>
export type SettlementAmount = Static<typeof SettlementAmountSchema>

export function success<T>(data: T, requestId: string): ApiSuccess<T> {
  return { data, meta: { requestId } }
}

export function failure(code: string, message: string, requestId: string): ApiError {
  return { error: { code, message }, meta: { requestId } }
}

export * from './supplier-catalog.js'
export * from './purchase-forms.js'
export type SupplierProviderType = Static<typeof SupplierProviderTypeSchema>
export type SupplierAuthScheme = Static<typeof SupplierAuthSchemeSchema>
