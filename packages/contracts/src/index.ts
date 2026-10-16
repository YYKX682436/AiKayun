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

export const ProductVariantSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  productId: Type.String({ format: 'uuid' }),
  skuCode: Type.String({ minLength: 1, maxLength: 64 }),
  salePrice: ProductSalePriceSchema,
  currency: Type.Literal('CNY'),
  enabled: Type.Boolean(),
  isDefault: Type.Boolean(),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})

export const ProductDetailSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 20_000 }),
  productType: ProductTypeSchema,
  status: ProductStatusSchema,
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  variants: Type.Array(ProductVariantSchema, { minItems: 1 }),
})
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
export type ProductDetail = Static<typeof ProductDetailSchema>
export type Ready = Static<typeof ReadySchema>
export type UnitAmount = Static<typeof UnitAmountSchema>
export type SettlementAmount = Static<typeof SettlementAmountSchema>

export function success<T>(data: T, requestId: string): ApiSuccess<T> {
  return { data, meta: { requestId } }
}

export function failure(code: string, message: string, requestId: string): ApiError {
  return { error: { code, message }, meta: { requestId } }
}
