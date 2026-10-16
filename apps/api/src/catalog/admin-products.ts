import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreateProductBodySchema,
  failure,
  ProductDetailSchema,
  ProductIdParamsSchema,
  success,
} from '@aikayun/contracts'
import type { CreateProductBody, ProductDetail, ProductIdParams, ProductSalePrice } from '@aikayun/contracts'
import { parseUnitAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database, ProductType } from '../db/types.js'

const salePricePattern = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?(?![\s\S])/

export interface ProductIdentityFactory {
  nextProductId(): string
  nextVariantId(): string
  nextSkuCode(): string
}

export const defaultProductIdentityFactory: ProductIdentityFactory = {
  nextProductId: randomUUID,
  nextVariantId: randomUUID,
  nextSkuCode: () => `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
}

export class ProductInputError extends Error {
  constructor(
    readonly code: 'INVALID_PRODUCT_NAME' | 'INVALID_SALE_PRICE',
    message: string,
  ) {
    super(message)
    this.name = 'ProductInputError'
  }
}

function normalizedSalePrice(value: ProductSalePrice): string {
  if (!salePricePattern.test(value)) {
    throw new ProductInputError('INVALID_SALE_PRICE', 'Sale price must be a non-negative CNY decimal with at most two fractional digits')
  }
  return parseUnitAmount(value).toFixed(2)
}

async function loadProduct(db: Kysely<Database>, id: string): Promise<ProductDetail | undefined> {
  const product = await db.selectFrom('products')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!product) return undefined

  const variants = await db.selectFrom('product_variants')
    .selectAll()
    .where('product_id', '=', id)
    .orderBy('created_at')
    .orderBy('id')
    .execute()

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    productType: product.product_type as ProductType,
    status: product.status,
    revision: product.revision,
    createdAt: product.created_at.toISOString(),
    updatedAt: product.updated_at.toISOString(),
    variants: variants.map((variant) => {
      const amount = parseUnitAmount(variant.sale_price)
      if (amount.isNegative() || amount.decimalPlaces() > 2) {
        throw new Error('Stored product sale price violates the catalog amount contract')
      }
      return {
        id: variant.id,
        productId: variant.product_id,
        skuCode: variant.sku_code,
        salePrice: amount.toFixed(2),
        currency: 'CNY' as const,
        enabled: variant.enabled,
        isDefault: variant.combination_key === '',
        revision: variant.revision,
        createdAt: variant.created_at.toISOString(),
        updatedAt: variant.updated_at.toISOString(),
      }
    }),
  }
}

export async function createDraftProduct(
  db: Kysely<Database>,
  body: CreateProductBody,
  identityFactory: ProductIdentityFactory = defaultProductIdentityFactory,
): Promise<ProductDetail> {
  const name = body.name.trim()
  if (!name) {
    throw new ProductInputError('INVALID_PRODUCT_NAME', 'Product name must not be empty')
  }
  if (name.length > 200) {
    throw new ProductInputError('INVALID_PRODUCT_NAME', 'Product name must be at most 200 characters')
  }
  const salePrice = normalizedSalePrice(body.defaultSku.salePrice)

  return db.transaction().execute(async (trx) => {
    const product = await trx.insertInto('products').values({
      id: identityFactory.nextProductId(),
      name,
      description: body.description ?? '',
      product_type: body.productType,
      status: 'draft',
    }).returningAll().executeTakeFirstOrThrow()

    await trx.insertInto('product_variants').values({
      id: identityFactory.nextVariantId(),
      product_id: product.id,
      sku_code: identityFactory.nextSkuCode(),
      combination_key: '',
      sale_price: salePrice,
      enabled: true,
    }).executeTakeFirstOrThrow()

    const created = await loadProduct(trx, product.id)
    if (!created) throw new Error('Created product could not be read inside its transaction')
    return created
  })
}

export function productDatabaseFailure(error: unknown): { status: number; code: string; message: string } | undefined {
  if (error instanceof ProductInputError) {
    return { status: 400, code: error.code, message: error.message }
  }

  if (!error || typeof error !== 'object') return undefined
  const databaseError = error as { code?: string; constraint?: string }
  if (databaseError.code === '23505') {
    if (databaseError.constraint === 'product_variants_sku_code_unique') {
      return { status: 409, code: 'SKU_CODE_CONFLICT', message: 'The generated SKU code already exists' }
    }
    if (databaseError.constraint === 'product_variants_product_combination_unique') {
      return { status: 409, code: 'SKU_COMBINATION_CONFLICT', message: 'This product already has that SKU combination' }
    }
    return { status: 409, code: 'PRODUCT_IDENTITY_CONFLICT', message: 'A product or SKU identity already exists' }
  }
  if (databaseError.code === '23514') {
    if (databaseError.constraint === 'products_product_type_check') {
      return { status: 400, code: 'INVALID_PRODUCT_TYPE', message: 'Product type is invalid' }
    }
    if (databaseError.constraint === 'products_status_check') {
      return { status: 400, code: 'INVALID_PRODUCT_STATUS', message: 'Product status is invalid' }
    }
    if (databaseError.constraint === 'product_variants_sale_price_check') {
      return { status: 400, code: 'INVALID_SALE_PRICE', message: 'Sale price must be non-negative with at most two fractional digits' }
    }
    if (databaseError.constraint === 'product_requires_default_sku') {
      return { status: 400, code: 'DEFAULT_SKU_REQUIRED', message: 'Every product must have a default SKU' }
    }
  }
  if (databaseError.code === '22003') {
    return { status: 400, code: 'INVALID_SALE_PRICE', message: 'Sale price exceeds the supported range' }
  }
  if (databaseError.code === '23503') {
    return { status: 400, code: 'PRODUCT_REFERENCE_INVALID', message: 'The SKU must reference an existing product' }
  }
  return undefined
}

function sendKnownProductFailure(reply: FastifyReply, error: unknown, requestId: string) {
  const known = productDatabaseFailure(error)
  if (!known) throw error
  return reply.code(known.status).send(failure(known.code, known.message, requestId))
}

export function registerAdminProductRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
  identityFactory: ProductIdentityFactory = defaultProductIdentityFactory,
): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.post('/api/v1/admin/products', {
    attachValidation: true,
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Create a draft product and its default SKU',
      body: CreateProductBodySchema,
      response: {
        201: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        409: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    if (request.validationError) {
      const issues = request.validationError.validation as Array<{ instancePath?: string; dataPath?: string }>
      const paths = issues.map((issue) => issue.instancePath ?? issue.dataPath ?? '')
      if (paths.includes('/defaultSku/salePrice')) {
        return reply.code(400).send(failure(
          'INVALID_SALE_PRICE',
          'Sale price must be a non-negative CNY decimal with at most two fractional digits',
          request.id,
        ))
      }
      if (paths.includes('/productType')) {
        return reply.code(400).send(failure('INVALID_PRODUCT_TYPE', 'Product type is invalid', request.id))
      }
      return reply.code(400).send(failure('VALIDATION_ERROR', 'The request contains invalid data', request.id))
    }

    try {
      const body = request.body as CreateProductBody
      const product = await createDraftProduct(db, body, identityFactory)
      return reply.code(201).send(success(product, request.id))
    } catch (error) {
      return sendKnownProductFailure(reply, error, request.id)
    }
  })

  app.get('/api/v1/admin/products/:id', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Read a product and its SKUs by stable ID',
      params: ProductIdParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const params = request.params as ProductIdParams
    const product = await loadProduct(db, params.id)
    if (!product) return reply.code(404).send(failure('PRODUCT_NOT_FOUND', 'The product does not exist', request.id))
    return success(product, request.id)
  })
}
