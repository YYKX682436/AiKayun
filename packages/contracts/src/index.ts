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
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const UpdateStorefrontCustomerPolicyBodySchema = Type.Object({
  requireEmail: Type.Boolean(),
  requirePhone: Type.Boolean(),
  guestCheckoutEnabled: Type.Boolean(),
  guestFreeClaimEnabled: Type.Boolean(),
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

export const ProductVariantSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  productId: Type.String({ format: 'uuid' }),
  skuCode: Type.String({ minLength: 1, maxLength: 64 }),
  salePrice: ProductSalePriceSchema,
  currency: Type.Literal('CNY'),
  enabled: Type.Boolean(),
  retiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
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
  options: Type.Array(Type.Object({
    groupId: Type.String({ format: 'uuid' }),
    valueId: Type.String({ format: 'uuid' }),
  }, { additionalProperties: false }), { maxItems: 5 }),
  salePrice: ProductSalePriceSchema,
  compareAtPrice: Type.Union([ProductSalePriceSchema, Type.Null()]),
  inventory: PublicInventorySummarySchema,
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
export const SettlementAmountSchema = Type.String({ pattern: '^-?(?:0|[1-9]\\d{0,15})\\.\\d{2}$' })

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
