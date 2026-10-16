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

export const ProductDetailSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 20_000 }),
  productType: ProductTypeSchema,
  status: ProductStatusSchema,
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  categories: Type.Array(ProductCategoryAssignmentSchema),
  optionGroups: Type.Array(ProductOptionGroupSchema, { maxItems: 5 }),
  attributes: Type.Array(ProductAttributeSchema, { maxItems: 30 }),
  variants: Type.Array(ProductVariantSchema, { minItems: 1 }),
})

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

export const ProductVariantMatrixAllBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  groups: Type.Array(ProductVariantMatrixGroupSchema, { maxItems: 5 }),
  mode: Type.Literal('all'),
  newSkuDefaults: Type.Object({ salePrice: ProductSalePriceSchema, enabled: Type.Boolean() }, { additionalProperties: false }),
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
export type ProductType = Static<typeof ProductTypeSchema>
export type ProductStatus = Static<typeof ProductStatusSchema>
export type ProductSalePrice = Static<typeof ProductSalePriceSchema>
export type CreateProductBody = Static<typeof CreateProductBodySchema>
export type ProductIdParams = Static<typeof ProductIdParamsSchema>
export type ProductVariant = Static<typeof ProductVariantSchema>
export type ProductOptionValue = Static<typeof ProductOptionValueSchema>
export type ProductOptionGroup = Static<typeof ProductOptionGroupSchema>
export type ProductCategoryAssignment = Static<typeof ProductCategoryAssignmentSchema>
export type ProductAttribute = Static<typeof ProductAttributeSchema>
export type ProductDetail = Static<typeof ProductDetailSchema>
export type AdminProductCategory = Static<typeof AdminProductCategorySchema>
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
