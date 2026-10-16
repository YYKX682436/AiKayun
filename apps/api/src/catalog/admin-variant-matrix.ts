import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ProductIdParamsSchema,
  ProductVariantMatrixBodySchema,
  ProductVariantMatrixPreviewSchema,
  ProductVariantMatrixSaveResultSchema,
  success,
} from '@aikayun/contracts'
import type { ProductVariantMatrixBody } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import type { ProductIdentityFactory } from './admin-products.js'
import { CatalogError, sendCatalogError } from './errors.js'
import { previewVariantMatrix, saveVariantMatrix } from './variant-matrix.js'

export function registerAdminVariantMatrixRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
  identityFactory: ProductIdentityFactory,
): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.post('/api/v1/admin/products/:id/variant-matrix/preview', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Preview specification combinations and SKU changes',
      params: ProductIdParamsSchema,
      body: ProductVariantMatrixBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductVariantMatrixPreviewSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await previewVariantMatrix(db, id, request.body as ProductVariantMatrixBody)
      return reply.send(success(result, request.id))
    } catch (error) {
      return sendCatalogError(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/products/:id/variant-matrix', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Save specification groups and SKU combinations atomically',
      params: ProductIdParamsSchema,
      body: ProductVariantMatrixBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductVariantMatrixSaveResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await saveVariantMatrix(db, id, request.body as ProductVariantMatrixBody, identityFactory)
      return reply.send(success(result, request.id))
    } catch (error) {
      if (error && typeof error === 'object') {
        const databaseError = error as { code?: string; constraint?: string }
        if (databaseError.code === '23001' || (databaseError.code === '23503'
          && databaseError.constraint !== 'product_variant_option_values_value_fkey'
          && databaseError.constraint !== 'product_variant_option_values_group_fkey'
          && databaseError.constraint !== 'product_option_values_group_fkey')) {
          return sendCatalogError(reply, new CatalogError(
            409,
            'SKU_HAS_REFERENCES',
            'A SKU is referenced by catalog history or resources and cannot be removed; retain it as permanently retired instead',
          ), request.id)
        }
      }
      return sendCatalogError(reply, error, request.id)
    }
  })
}
