import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  AdminProductCategoriesSchema,
  AdminProductCategorySchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreateProductCategoryBodySchema,
  DeleteProductCategoryBodySchema,
  ProductCategoryDeleteResultSchema,
  ProductCategoryIdParamsSchema,
  success,
  UpdateProductCategoryBodySchema,
} from '@aikayun/contracts'
import type {
  AdminProductCategory,
  CreateProductCategoryBody,
  DeleteProductCategoryBody,
  UpdateProductCategoryBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import { CatalogError, sendCatalogError } from './errors.js'

function asCategory(row: {
  id: string
  parent_id: string | null
  name: string
  sort_order: number
  is_visible: boolean
  revision: number
  created_at: Date
  updated_at: Date
}): AdminProductCategory {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: row.sort_order,
    isVisible: row.is_visible,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function normalizedCategoryName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new CatalogError(400, 'INVALID_CATEGORY_NAME', 'Category name must not be empty')
  if (normalized.length > 120) throw new CatalogError(400, 'INVALID_CATEGORY_NAME', 'Category name must be at most 120 characters')
  return normalized
}

async function lockCategoryTree(trx: Transaction<Database>): Promise<void> {
  const guard = await sql<{ singleton: boolean }>`
    UPDATE product_category_tree_guard
    SET revision = revision + 1
    WHERE singleton
    RETURNING singleton
  `.execute(trx)
  if (guard.rows.length !== 1) throw new Error('The category tree guard row is missing')
}

export function registerAdminCategoryRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/categories', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'List product categories',
      response: { 200: ApiSuccessSchemaOf(AdminProductCategoriesSchema), 401: ApiErrorSchema },
    },
  }, async (request) => {
    const rows = await db.selectFrom('product_categories').selectAll()
      .orderBy('parent_id').orderBy('sort_order').orderBy('id').execute()
    return success({ categories: rows.map(asCategory) }, request.id)
  })

  app.post('/api/v1/admin/categories', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Create a product category',
      body: CreateProductCategoryBodySchema,
      response: {
        201: ApiSuccessSchemaOf(AdminProductCategorySchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as CreateProductCategoryBody
      const row = await db.transaction().execute(async (trx) => {
        await lockCategoryTree(trx)
        return trx.insertInto('product_categories').values({
          id: randomUUID(),
          parent_id: body.parentId ?? null,
          name: normalizedCategoryName(body.name),
          sort_order: body.sortOrder ?? 0,
          is_visible: body.isVisible ?? true,
        }).returningAll().executeTakeFirstOrThrow()
      })
      return reply.code(201).send(success(asCategory(row), request.id))
    } catch (error) {
      return sendCatalogError(reply, error, request.id)
    }
  })

  app.patch('/api/v1/admin/categories/:id', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Edit, move, or reorder a product category',
      params: ProductCategoryIdParamsSchema,
      body: UpdateProductCategoryBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminProductCategorySchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as UpdateProductCategoryBody
      const { id } = request.params as { id: string }
      const row = await db.transaction().execute(async (trx) => {
        await lockCategoryTree(trx)
        const current = await trx.selectFrom('product_categories').select(['id', 'revision'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!current) throw new CatalogError(404, 'CATEGORY_NOT_FOUND', 'The category does not exist')
        if (current.revision !== body.expectedRevision) {
          throw new CatalogError(409, 'CATEGORY_REVISION_CONFLICT', 'The category changed; reload it and retry')
        }
        const values: { name?: string; parent_id?: string | null; sort_order?: number; is_visible?: boolean } = {}
        if (body.name !== undefined) values.name = normalizedCategoryName(body.name)
        if (Object.hasOwn(body, 'parentId')) values.parent_id = body.parentId ?? null
        if (body.sortOrder !== undefined) values.sort_order = body.sortOrder
        if (body.isVisible !== undefined) values.is_visible = body.isVisible
        return trx.updateTable('product_categories').set(values).where('id', '=', id)
          .returningAll().executeTakeFirstOrThrow()
      })
      return reply.send(success(asCategory(row), request.id))
    } catch (error) {
      return sendCatalogError(reply, error, request.id)
    }
  })

  app.delete('/api/v1/admin/categories/:id', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Delete an unused product category',
      params: ProductCategoryIdParamsSchema,
      body: DeleteProductCategoryBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductCategoryDeleteResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as DeleteProductCategoryBody
      await db.transaction().execute(async (trx) => {
        await lockCategoryTree(trx)
        const current = await trx.selectFrom('product_categories').select(['id', 'revision'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!current) throw new CatalogError(404, 'CATEGORY_NOT_FOUND', 'The category does not exist')
        if (current.revision !== body.expectedRevision) {
          throw new CatalogError(409, 'CATEGORY_REVISION_CONFLICT', 'The category changed; reload it and retry')
        }
        const child = await trx.selectFrom('product_categories').select('id').where('parent_id', '=', id).limit(1).executeTakeFirst()
        if (child) throw new CatalogError(409, 'CATEGORY_HAS_CHILDREN', 'Move child categories before deleting this category')
        const assignments = await trx.selectFrom('product_category_assignments')
          .select('is_primary').where('category_id', '=', id).execute()
        if (assignments.length > 0) {
          const hasPrimary = assignments.some((assignment) => assignment.is_primary)
          throw new CatalogError(
            409,
            hasPrimary ? 'PRIMARY_CATEGORY_IN_USE' : 'CATEGORY_HAS_PRODUCTS',
            hasPrimary
              ? 'Choose a replacement primary category or remove all category assignments before deleting this category'
              : 'Move or remove product category assignments before deleting this category',
          )
        }
        await trx.deleteFrom('product_categories').where('id', '=', id).executeTakeFirstOrThrow()
      })
      return reply.send(success({ deleted: true as const }, request.id))
    } catch (error) {
      return sendCatalogError(reply, error, request.id)
    }
  })
}
