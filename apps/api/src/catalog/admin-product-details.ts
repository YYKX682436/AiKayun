import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ProductDetailSchema,
  ProductIdParamsSchema,
  ReplaceProductAttributesBodySchema,
  ReplaceProductCategoriesBodySchema,
  success,
} from '@aikayun/contracts'
import type { ReplaceProductAttributesBody, ReplaceProductCategoriesBody } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import { loadProduct } from './admin-products.js'
import { CatalogError, sendCatalogError } from './errors.js'

async function lockProduct(db: Kysely<Database>, productId: string, expectedRevision: number) {
  const product = await db.selectFrom('products').select(['id', 'revision'])
    .where('id', '=', productId).forUpdate().executeTakeFirst()
  if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
  if (product.revision !== expectedRevision) {
    throw new CatalogError(409, 'PRODUCT_REVISION_CONFLICT', 'The product changed; reload it and retry')
  }
  return product
}

function fail(reply: FastifyReply, error: unknown, requestId: string) {
  return sendCatalogError(reply, error, requestId)
}

export function registerAdminProductDetailRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.put('/api/v1/admin/products/:id/categories', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Replace a product category assignment set atomically',
      params: ProductIdParamsSchema,
      body: ReplaceProductCategoriesBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as ReplaceProductCategoriesBody
    const { id: productId } = request.params as { id: string }
    try {
      const categoryIds = body.assignments.map((assignment) => assignment.categoryId.toLowerCase())
      if (new Set(categoryIds).size !== categoryIds.length) {
        throw new CatalogError(400, 'DUPLICATE_PRODUCT_CATEGORY', 'A product cannot be assigned to the same category more than once')
      }
      const primaryCount = body.assignments.filter((assignment) => assignment.isPrimary).length
      if (body.assignments.length > 0 && primaryCount !== 1) {
        throw new CatalogError(400, 'PRIMARY_CATEGORY_REQUIRED', 'Choose exactly one primary category')
      }
      if (body.assignments.length === 0 && primaryCount !== 0) {
        throw new CatalogError(400, 'PRIMARY_CATEGORY_INVALID', 'An unclassified product cannot have a primary category')
      }

      const result = await db.transaction().execute(async (trx) => {
        await lockProduct(trx, productId, body.expectedRevision)
        const normalizedIds = [...new Set(categoryIds)]
        if (normalizedIds.length > 0) {
          const categories = await trx.selectFrom('product_categories').select('id')
            .where('id', 'in', normalizedIds).execute()
          if (categories.length !== normalizedIds.length) {
            throw new CatalogError(400, 'CATEGORY_REFERENCE_INVALID', 'One or more categories do not exist')
          }
        }
        await trx.deleteFrom('product_category_assignments').where('product_id', '=', productId).execute()
        if (body.assignments.length > 0) {
          await trx.insertInto('product_category_assignments').values(body.assignments.map((assignment) => ({
            product_id: productId,
            category_id: assignment.categoryId.toLowerCase(),
            is_primary: assignment.isPrimary,
            sort_order: assignment.sortOrder,
          }))).execute()
        }
        const product = await loadProduct(trx, productId)
        if (!product) throw new Error('Updated product could not be read inside its transaction')
        return product
      })
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/products/:id/attributes', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Replace a product display attribute set atomically',
      params: ProductIdParamsSchema,
      body: ReplaceProductAttributesBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as ReplaceProductAttributesBody
    const { id: productId } = request.params as { id: string }
    try {
      const attributes = body.attributes.map((attribute) => ({
        id: attribute.id?.toLowerCase() ?? randomUUID(),
        name: attribute.name.trim(),
        value: attribute.value.trim(),
        sortOrder: attribute.sortOrder,
        requestedId: attribute.id?.toLowerCase(),
      }))
      if (attributes.some((attribute) => !attribute.name || !attribute.value)) {
        throw new CatalogError(400, 'INVALID_PRODUCT_ATTRIBUTE', 'Attribute names and values must not be empty')
      }
      if (new Set(attributes.map((attribute) => attribute.id)).size !== attributes.length) {
        throw new CatalogError(400, 'DUPLICATE_PRODUCT_ATTRIBUTE_ID', 'An attribute ID may appear only once')
      }
      if (new Set(attributes.map((attribute) => attribute.name.toLowerCase())).size !== attributes.length) {
        throw new CatalogError(400, 'PRODUCT_ATTRIBUTE_NAME_CONFLICT', 'Attribute names must be unique within a product')
      }

      const result = await db.transaction().execute(async (trx) => {
        await lockProduct(trx, productId, body.expectedRevision)
        const existing = await trx.selectFrom('product_attributes').selectAll().where('product_id', '=', productId).execute()
        const existingById = new Map(existing.map((attribute) => [attribute.id, attribute]))
        for (const attribute of attributes) {
          if (attribute.requestedId && !existingById.has(attribute.id)) {
            throw new CatalogError(409, 'PRODUCT_ATTRIBUTE_ID_CONFLICT', 'An attribute ID does not belong to this product')
          }
        }
        await trx.deleteFrom('product_attributes').where('product_id', '=', productId).execute()
        if (attributes.length > 0) {
          const now = new Date()
          await trx.insertInto('product_attributes').values(attributes.map((attribute) => ({
            id: attribute.id,
            product_id: productId,
            name: attribute.name,
            value: attribute.value,
            sort_order: attribute.sortOrder,
            created_at: existingById.get(attribute.id)?.created_at ?? now,
            updated_at: now,
          }))).execute()
        }
        const product = await loadProduct(trx, productId)
        if (!product) throw new Error('Updated product could not be read inside its transaction')
        return product
      })
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })
}
