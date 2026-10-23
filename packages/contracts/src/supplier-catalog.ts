import { Type, type Static } from 'typebox'

const NullableText = Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])
const NullableInt = Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()])
const NullableFlag = Type.Union([Type.Boolean(), Type.Null()])
export const SupplierReadSourceSchema = Type.Object({
  connectionId: Type.String({ format: 'uuid' }),
  configurationVersionId: Type.String({ format: 'uuid' }),
  configurationVersionNumber: Type.Integer({ minimum: 1 }),
  protocol: Type.Literal('kayixin_customer_v3'),
  apiVersion: Type.Literal('3.0'),
  readAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const SupplierReferenceQuoteSchema = Type.Object({
  amount: Type.Union([Type.String({ pattern: '^(0|[1-9][0-9]{0,23})(\\.[0-9]{1,18})?$' }), Type.Null()]),
  currency: Type.Null({ description: 'The upstream V3 document does not declare a currency. Verify before procurement.' }),
  basis: Type.Literal('upstream_account_reference'),
  actualDebitVerified: Type.Literal(false),
}, { additionalProperties: false })
const SupplierCapabilitiesSchema = Type.Object({
  repeatOrder: NullableFlag, refundOrder: NullableFlag, refundMoney: NullableFlag,
  warrantyDays: NullableInt, warrantyTime: NullableInt,
  warrantyUnit: Type.Union([Type.Integer(), Type.Null()]),
}, { additionalProperties: false })
const SupplierStockSchema = Type.Object({
  reportedCount: NullableInt,
  availability: Type.Union([Type.Literal('reported_available'), Type.Literal('reported_empty'), Type.Literal('unknown')]),
}, { additionalProperties: false })
const SupplierVariantSchema = Type.Object({
  upstreamSku: Type.String({ minLength: 1, maxLength: 200 }),
  combination: Type.Array(Type.Object({ title: Type.String({ maxLength: 200 }), value: Type.String({ maxLength: 200 }) }, { additionalProperties: false }), { maxItems: 30 }),
  status: Type.Union([Type.Integer(), Type.Null()]),
  quote: SupplierReferenceQuoteSchema, stock: SupplierStockSchema,
}, { additionalProperties: false })
// Keep the documented option/children/expand tree. No script or regex is executed.
export const SupplierPurchaseFieldsSchema = Type.Cyclic({
  Field: Type.Object({
    type: Type.Union([Type.Integer(), Type.Null()]),
    title: NullableText, placeholder: NullableText, required: NullableFlag,
    regex: NullableText,
    options: Type.Array(Type.Ref('Option'), { maxItems: 500 }),
  }, { additionalProperties: false }),
  Option: Type.Object({
    name: Type.String({ maxLength: 2000 }), value: Type.String({ maxLength: 2000 }),
    children: Type.Array(Type.Ref('Option'), { maxItems: 500 }),
    expand: Type.Array(Type.Ref('Field'), { maxItems: 50 }),
  }, { additionalProperties: false }),
  Fields: Type.Array(Type.Ref('Field'), { maxItems: 50 }),
}, 'Fields')
export const SupplierCatalogProductSchema = Type.Object({
  source: SupplierReadSourceSchema,
  upstreamProductId: Type.String({ minLength: 1, maxLength: 32 }),
  name: Type.String({ minLength: 1, maxLength: 500 }),
  goodsType: Type.Integer(), status: Type.Integer(),
  skuType: Type.Union([Type.Integer(), Type.Null()]),
  quote: SupplierReferenceQuoteSchema, stock: SupplierStockSchema,
  quantityRules: Type.Object({ minQuantity: NullableInt, maxQuantity: NullableInt, multiple: NullableInt,
    conversionVerified: Type.Literal(false) }, { additionalProperties: false }),
  capabilities: SupplierCapabilitiesSchema,
  imageUrl: NullableText,
  description: NullableText, detail: NullableText, buyNotice: NullableText,
  variants: Type.Array(SupplierVariantSchema, { maxItems: 2000 }),
  specificationGroups: Type.Array(Type.Object({ name: Type.String({ maxLength: 200 }),
    values: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 500 }) }, { additionalProperties: false }), { maxItems: 30 }),
  purchaseFields: Type.Union([SupplierPurchaseFieldsSchema, Type.Null()]),
  warnings: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 30 }),
  procurementReady: Type.Literal(false),
}, { additionalProperties: false })
export const SupplierAccountObservationSchema = Type.Object({
  source: SupplierReadSourceSchema, balance: SupplierReferenceQuoteSchema,
}, { additionalProperties: false })
export const SupplierCatalogPageSchema = Type.Object({
  source: SupplierReadSourceSchema, requestedPage: Type.Integer({ minimum: 1 }),
  upstreamPagination: Type.Object({ allCount: NullableInt, allPage: NullableInt,
    semanticsVerified: Type.Literal(false) }, { additionalProperties: false }),
  items: Type.Array(SupplierCatalogProductSchema, { maxItems: 1000 }),
}, { additionalProperties: false })
export const SupplierCatalogQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  keyWord: Type.Optional(Type.String({ maxLength: 120 })),
  goodsType: Type.Optional(Type.Union([Type.Literal('1'), Type.Literal('3')])),
  skuType: Type.Optional(Type.Union([Type.Literal('0'), Type.Literal('1'), Type.Literal('2')])),
  dirId: Type.Optional(Type.String({ pattern: '^[0-9]{1,15}$' })),
  brandId: Type.Optional(Type.String({ pattern: '^[0-9]{1,15}$' })),
}, { additionalProperties: false })
export type SupplierReadSource = Static<typeof SupplierReadSourceSchema>
export type SupplierCatalogProduct = Static<typeof SupplierCatalogProductSchema>
export type SupplierAccountObservation = Static<typeof SupplierAccountObservationSchema>
export type SupplierCatalogPage = Static<typeof SupplierCatalogPageSchema>
export type SupplierCatalogQuery = Static<typeof SupplierCatalogQuerySchema>
export type SupplierPurchaseField = NonNullable<SupplierCatalogProduct['purchaseFields']>[number]
export type SupplierPurchaseOption = SupplierPurchaseField['options'][number]
