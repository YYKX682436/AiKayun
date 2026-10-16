import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  AdminProductInventorySummarySchema,
  AdminProductVariantInventorySchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreateInventoryAdjustmentBodySchema,
  InventoryAdjustmentPageSchema,
  InventoryAdjustmentQuerySchema,
  InventoryAdjustmentSchema,
  ProductIdParamsSchema,
  ProductInventorySummaryQuerySchema,
  ProductVariantIdParamsSchema,
  UpdateProductInventoryModeBodySchema,
  success,
} from '@aikayun/contracts'
import type {
  AdminProductInventorySummary,
  AdminProductVariantInventory,
  CreateInventoryAdjustmentBody,
  InventoryAdjustment,
  InventoryAdjustmentPage,
  InventoryAdjustmentQuery,
  ProductInventoryMode,
  ProductInventoryStatus,
  UpdateProductInventoryModeBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database, InventoryAdjustmentAction } from '../db/types.js'
import { CatalogError, sendCatalogError } from './errors.js'

const maxInventoryQuantity = 2_147_483_647
const inventoryModes = new Set<ProductInventoryMode>(['quantity', 'resource_pool', 'unlimited', 'external'])

type InventoryRow = {
  product_id: string
  product_revision: number
  sku_id: string
  sku_code: string
  sku_revision: number
  inventory_revision: number
  enabled: boolean
  retired_at: Date | null
  inventory_mode: ProductInventoryMode | null
  stocked: number | null
  reserved: number | null
}

function inventoryStatus(row: InventoryRow, requestedQuantity: number): ProductInventoryStatus {
  const mode = row.inventory_mode
  if (mode === 'quantity') {
    if (row.stocked === null || row.reserved === null) {
      throw new Error('Quantity-mode SKU is missing its quantity inventory record')
    }
    const available = row.stocked - row.reserved
    return {
      mode,
      configured: true,
      hasTrustedQuantity: true,
      stocked: row.stocked,
      reserved: row.reserved,
      available,
      sufficient: available >= requestedQuantity,
      sourceReady: true,
      status: 'ready',
    }
  }
  if (mode === 'unlimited') {
    return {
      mode,
      configured: true,
      hasTrustedQuantity: false,
      stocked: null,
      reserved: null,
      available: null,
      sufficient: true,
      sourceReady: true,
      status: 'ready',
    }
  }
  if (mode === 'resource_pool' || mode === 'external') {
    return {
      mode,
      configured: true,
      hasTrustedQuantity: false,
      stocked: null,
      reserved: null,
      available: null,
      sufficient: null,
      sourceReady: false,
      status: 'not_ready',
    }
  }
  return {
    mode: null,
    configured: false,
    hasTrustedQuantity: false,
    stocked: null,
    reserved: null,
    available: null,
    sufficient: null,
    sourceReady: false,
    status: 'not_configured',
  }
}

function toVariantInventory(row: InventoryRow, requestedQuantity = 1): AdminProductVariantInventory {
  return {
    productId: row.product_id,
    productRevision: row.product_revision,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuRevision: row.sku_revision,
    inventoryRevision: row.inventory_revision,
    enabled: row.enabled,
    retiredAt: row.retired_at?.toISOString() ?? null,
    inventory: inventoryStatus(row, requestedQuantity),
  }
}

async function selectInventoryRows(db: Kysely<Database>, productId: string): Promise<InventoryRow[]> {
  return db.selectFrom('product_variants as variant')
    .innerJoin('products as product', 'product.id', 'variant.product_id')
    .leftJoin('product_variant_quantity_inventory as inventory', (join) => join
      .onRef('inventory.product_id', '=', 'variant.product_id')
      .onRef('inventory.product_variant_id', '=', 'variant.id'))
    .select([
      'product.id as product_id', 'product.revision as product_revision',
      'variant.id as sku_id', 'variant.sku_code', 'variant.revision as sku_revision',
      'variant.inventory_revision', 'variant.enabled', 'variant.retired_at', 'variant.inventory_mode',
      'inventory.stocked', 'inventory.reserved',
    ])
    .where('variant.product_id', '=', productId)
    .orderBy('variant.created_at').orderBy('variant.id')
    .execute()
}

async function selectInventoryRow(db: Kysely<Database>, productId: string, skuId: string): Promise<InventoryRow | undefined> {
  return (await selectInventoryRows(db, productId)).find((row) => row.sku_id === skuId)
}

function mapAdjustment(row: {
  id: string
  operation_id: string
  product_id: string
  product_variant_id: string
  administrator_id: string
  action: InventoryAdjustmentAction
  requested_quantity: number
  quantity_before: number
  quantity_after: number
  quantity_delta: number
  inventory_revision: number
  reason: string
  created_at: Date
}): InventoryAdjustment {
  return {
    id: row.id,
    operationId: row.operation_id,
    productId: row.product_id,
    skuId: row.product_variant_id,
    administratorId: row.administrator_id,
    action: row.action,
    requestedQuantity: row.requested_quantity,
    quantityBefore: row.quantity_before,
    quantityAfter: row.quantity_after,
    quantityDelta: row.quantity_delta,
    inventoryRevision: row.inventory_revision,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  }
}

type AdjustmentRequest = {
  productId: string
  skuId: string
  administratorId: string
  operationId: string
  expectedInventoryRevision: number
  action: InventoryAdjustmentAction
  quantity: number
  reason: string
}

function sameAdjustmentRequest(existing: {
  product_id: string
  product_variant_id: string
  administrator_id: string
  operation_id: string
  inventory_revision: number
  action: InventoryAdjustmentAction
  requested_quantity: number
  reason: string
}, request: AdjustmentRequest): boolean {
  return existing.product_id === request.productId
    && existing.product_variant_id === request.skuId
    && existing.administrator_id === request.administratorId
    && existing.operation_id === request.operationId
    && existing.inventory_revision - 1 === request.expectedInventoryRevision
    && existing.action === request.action
    && existing.requested_quantity === request.quantity
    && existing.reason === request.reason
}

async function resolveExistingOperation(
  db: Kysely<Database>,
  request: AdjustmentRequest,
): Promise<InventoryAdjustment | undefined> {
  const existing = await db.selectFrom('product_variant_inventory_adjustments').selectAll()
    .where('operation_id', '=', request.operationId).executeTakeFirst()
  if (!existing) return undefined
  if (!sameAdjustmentRequest(existing, request)) {
    throw new CatalogError(409, 'INVENTORY_OPERATION_ID_CONFLICT', 'This operationId was already used with different adjustment content')
  }
  return mapAdjustment(existing)
}

function fail(reply: FastifyReply, error: unknown, requestId: string) {
  return sendCatalogError(reply, error, requestId)
}

export function registerAdminInventoryRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/products/:id/inventory', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Read inventory mode and availability summaries for every SKU in a product',
      params: ProductIdParamsSchema,
      querystring: ProductInventorySummaryQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminProductInventorySummarySchema),
        401: ApiErrorSchema, 404: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const query = request.query as { quantity?: number }
    try {
      const rows = await selectInventoryRows(db, productId)
      if (rows.length === 0) {
        const product = await db.selectFrom('products').select('id').where('id', '=', productId).executeTakeFirst()
        if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
      }
      const result: AdminProductInventorySummary = {
        productId,
        productRevision: rows[0]?.product_revision ?? 1,
        requestedQuantity: query.quantity ?? 1,
        variants: rows.map((row) => toVariantInventory(row, query.quantity ?? 1)),
      }
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/products/:id/variants/:variantId/inventory-mode', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Configure or safely switch the inventory mode for one SKU',
      params: ProductVariantIdParamsSchema,
      body: UpdateProductInventoryModeBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminProductVariantInventorySchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as UpdateProductInventoryModeBody
    const { id: productId, variantId: skuId } = request.params as { id: string; variantId: string }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const product = await trx.selectFrom('products').select(['id', 'revision'])
          .where('id', '=', productId).forUpdate().executeTakeFirst()
        if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
        if (product.revision !== body.expectedRevision) {
          throw new CatalogError(409, 'PRODUCT_REVISION_CONFLICT', 'The product changed; reload it and retry')
        }
        const variant = await trx.selectFrom('product_variants').selectAll()
          .where('product_id', '=', productId).where('id', '=', skuId).forUpdate().executeTakeFirst()
        if (!variant) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')
        if (variant.retired_at !== null) {
          throw new CatalogError(409, 'SKU_PERMANENTLY_RETIRED', 'A permanently retired SKU cannot change inventory mode')
        }
        if (variant.revision !== body.expectedSkuRevision) {
          throw new CatalogError(409, 'SKU_REVISION_CONFLICT', 'The SKU changed; reload it and retry')
        }
        if (variant.inventory_revision !== body.expectedInventoryRevision) {
          throw new CatalogError(409, 'INVENTORY_REVISION_CONFLICT', 'Inventory changed; reload it and retry')
        }
        if (body.inventoryMode !== null && !inventoryModes.has(body.inventoryMode)) {
          throw new CatalogError(400, 'INVALID_INVENTORY_MODE', 'The requested inventory mode is not supported')
        }
        if (variant.inventory_mode === body.inventoryMode) {
          const current = await selectInventoryRow(trx, productId, skuId)
          if (!current) throw new Error('The SKU inventory state could not be read inside its transaction')
          return toVariantInventory(current)
        }

        let quantityState: { stocked: number; reserved: number } | undefined
        if (variant.inventory_mode === 'quantity') {
          quantityState = await trx.selectFrom('product_variant_quantity_inventory')
            .select(['stocked', 'reserved'])
            .where('product_id', '=', productId).where('product_variant_id', '=', skuId)
            .forUpdate().executeTakeFirst()
          if (!quantityState) throw new Error('Quantity-mode SKU is missing its quantity inventory record')
          if (quantityState.stocked !== 0 || quantityState.reserved !== 0) {
            throw new CatalogError(409, 'INVENTORY_MODE_SWITCH_BLOCKED', 'A SKU with stocked or reserved quantity must be adjusted to zero before changing inventory mode')
          }
        }
        if (variant.inventory_revision >= maxInventoryQuantity) {
          throw new CatalogError(409, 'INVENTORY_REVISION_EXHAUSTED', 'The inventory revision limit has been reached')
        }

        await trx.updateTable('product_variants').set({
          inventory_mode: body.inventoryMode,
          inventory_revision: variant.inventory_revision + 1,
        }).where('product_id', '=', productId).where('id', '=', skuId).execute()

        if (body.inventoryMode === 'quantity') {
          await trx.insertInto('product_variant_quantity_inventory').values({
            product_id: productId,
            product_variant_id: skuId,
            stocked: 0,
            reserved: 0,
          }).execute()
        } else if (variant.inventory_mode === 'quantity') {
          await trx.deleteFrom('product_variant_quantity_inventory')
            .where('product_id', '=', productId).where('product_variant_id', '=', skuId).execute()
        }

        const updated = await selectInventoryRow(trx, productId, skuId)
        if (!updated) throw new Error('Updated SKU inventory mode could not be read inside its transaction')
        return toVariantInventory(updated)
      })
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/inventory/adjustments', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Apply an idempotent quantity inventory adjustment',
      params: ProductVariantIdParamsSchema,
      body: CreateInventoryAdjustmentBodySchema,
      response: {
        200: ApiSuccessSchemaOf(InventoryAdjustmentSchema),
        201: ApiSuccessSchemaOf(InventoryAdjustmentSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as CreateInventoryAdjustmentBody
    const { id: productId, variantId: skuId } = request.params as { id: string; variantId: string }
    const administratorId = request.admin?.id
    if (!administratorId) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Administrator authentication is required' }, meta: { requestId: request.id } })
    const normalizedReason = body.reason.trim()
    if (!normalizedReason) {
      return fail(reply, new CatalogError(400, 'INVALID_INVENTORY_REASON', 'An inventory adjustment reason is required'), request.id)
    }
    const requestData: AdjustmentRequest = {
      productId,
      skuId,
      administratorId,
      operationId: body.operationId.toLowerCase(),
      expectedInventoryRevision: body.expectedInventoryRevision,
      action: body.action,
      quantity: body.quantity,
      reason: normalizedReason,
    }

    try {
      const duplicate = await resolveExistingOperation(db, requestData)
      if (duplicate) return reply.code(200).send(success(duplicate, request.id))
      const result = await db.transaction().execute(async (trx) => {
        const product = await trx.selectFrom('products').select('id').where('id', '=', productId).forKeyShare().executeTakeFirst()
        if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
        const variant = await trx.selectFrom('product_variants').selectAll()
          .where('product_id', '=', productId).where('id', '=', skuId).forUpdate().executeTakeFirst()
        if (!variant) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')
        if (variant.retired_at !== null) {
          throw new CatalogError(409, 'SKU_PERMANENTLY_RETIRED', 'A permanently retired SKU cannot receive inventory adjustments')
        }
        if (variant.inventory_mode !== 'quantity') {
          throw new CatalogError(409, 'INVENTORY_MODE_CONFLICT', 'Quantity adjustments require the SKU to use quantity inventory mode')
        }

        const inventory = await trx.selectFrom('product_variant_quantity_inventory').selectAll()
          .where('product_id', '=', productId).where('product_variant_id', '=', skuId)
          .forUpdate().executeTakeFirst()
        if (!inventory) throw new Error('Quantity-mode SKU is missing its quantity inventory record')

        const duplicateAfterSkuLock = await trx.selectFrom('product_variant_inventory_adjustments').selectAll()
          .where('operation_id', '=', requestData.operationId).executeTakeFirst()
        if (duplicateAfterSkuLock) {
          if (!sameAdjustmentRequest(duplicateAfterSkuLock, requestData)) {
            throw new CatalogError(409, 'INVENTORY_OPERATION_ID_CONFLICT', 'This operationId was already used with different adjustment content')
          }
          return { adjustment: mapAdjustment(duplicateAfterSkuLock), inserted: false }
        }

        if (variant.inventory_revision !== requestData.expectedInventoryRevision) {
          throw new CatalogError(409, 'INVENTORY_REVISION_CONFLICT', 'Inventory changed; reload it and retry')
        }
        if (variant.inventory_revision >= maxInventoryQuantity) {
          throw new CatalogError(409, 'INVENTORY_REVISION_EXHAUSTED', 'The inventory revision limit has been reached')
        }

        let quantityAfter: number
        if (requestData.action === 'increase') {
          quantityAfter = inventory.stocked + requestData.quantity
          if (quantityAfter > maxInventoryQuantity) {
            throw new CatalogError(400, 'INVENTORY_QUANTITY_OUT_OF_RANGE', 'Stocked quantity exceeds the supported integer range')
          }
        } else if (requestData.action === 'decrease') {
          quantityAfter = inventory.stocked - requestData.quantity
          if (quantityAfter < 0) {
            throw new CatalogError(409, 'INSUFFICIENT_STOCKED_QUANTITY', 'The requested decrease exceeds the stocked quantity')
          }
        } else {
          quantityAfter = requestData.quantity
        }
        if (quantityAfter < inventory.reserved) {
          throw new CatalogError(409, 'STOCK_BELOW_RESERVED_QUANTITY', 'Stocked quantity cannot be lower than the reserved quantity')
        }
        const nextRevision = variant.inventory_revision + 1
        const quantityBefore = inventory.stocked
        const quantityDelta = quantityAfter - quantityBefore
        const adjustmentValues = {
          id: randomUUID(),
          product_id: productId,
          product_variant_id: skuId,
          operation_id: requestData.operationId,
          administrator_id: administratorId,
          action: requestData.action,
          requested_quantity: requestData.quantity,
          quantity_before: quantityBefore,
          quantity_after: quantityAfter,
          quantity_delta: quantityDelta,
          inventory_revision: nextRevision,
          reason: normalizedReason,
        }
        const inserted = await trx.insertInto('product_variant_inventory_adjustments').values(adjustmentValues)
          .onConflict((conflict) => conflict.column('operation_id').doNothing())
          .returningAll().executeTakeFirst()
        if (!inserted) {
          const concurrent = await trx.selectFrom('product_variant_inventory_adjustments').selectAll()
            .where('operation_id', '=', requestData.operationId).executeTakeFirst()
          if (!concurrent) throw new Error('Inventory operation conflict could not be resolved')
          if (!sameAdjustmentRequest(concurrent, requestData)) {
            throw new CatalogError(409, 'INVENTORY_OPERATION_ID_CONFLICT', 'This operationId was already used with different adjustment content')
          }
          return { adjustment: mapAdjustment(concurrent), inserted: false }
        }

        const updated = await trx.updateTable('product_variant_quantity_inventory').set({ stocked: quantityAfter })
          .where('product_id', '=', productId).where('product_variant_id', '=', skuId)
          .where('stocked', '=', quantityBefore).executeTakeFirst()
        if (Number(updated.numUpdatedRows) !== 1) {
          throw new CatalogError(409, 'INVENTORY_CONCURRENT_MODIFICATION', 'Inventory changed concurrently; reload it and retry')
        }
        const revised = await trx.updateTable('product_variants')
          .set({ inventory_revision: nextRevision })
          .where('product_id', '=', productId).where('id', '=', skuId)
          .where('inventory_revision', '=', requestData.expectedInventoryRevision)
          .executeTakeFirst()
        if (Number(revised.numUpdatedRows) !== 1) {
          throw new CatalogError(409, 'INVENTORY_REVISION_CONFLICT', 'Inventory changed; reload it and retry')
        }
        return { adjustment: mapAdjustment(inserted), inserted: true }
      })
      return reply.code(result.inserted ? 201 : 200).send(success(result.adjustment, request.id))
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
        try {
          const duplicate = await resolveExistingOperation(db, requestData)
          if (duplicate) return reply.code(200).send(success(duplicate, request.id))
        } catch (idempotencyError) {
          return fail(reply, idempotencyError, request.id)
        }
      }
      return fail(reply, error, request.id)
    }
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/inventory/adjustments', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Read a bounded page of immutable SKU inventory adjustment history',
      params: ProductVariantIdParamsSchema,
      querystring: InventoryAdjustmentQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(InventoryAdjustmentPageSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id: productId, variantId: skuId } = request.params as { id: string; variantId: string }
    const query = request.query as InventoryAdjustmentQuery
    try {
      if (Boolean(query.beforeCreatedAt) !== Boolean(query.beforeId)) {
        throw new CatalogError(400, 'INVALID_INVENTORY_CURSOR', 'Both beforeCreatedAt and beforeId are required for pagination')
      }
      const sku = await db.selectFrom('product_variants').select('id')
        .where('product_id', '=', productId).where('id', '=', skuId).executeTakeFirst()
      if (!sku) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')

      const limit = query.limit ?? 50
      let statement = db.selectFrom('product_variant_inventory_adjustments as adjustment')
        .select([
          'adjustment.id', 'adjustment.operation_id', 'adjustment.product_id',
          'adjustment.product_variant_id', 'adjustment.administrator_id', 'adjustment.action',
          'adjustment.requested_quantity', 'adjustment.quantity_before', 'adjustment.quantity_after',
          'adjustment.quantity_delta', 'adjustment.inventory_revision', 'adjustment.reason',
          'adjustment.created_at',
          sql<string>`to_char(adjustment.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('cursor_created_at'),
        ])
        .where('adjustment.product_id', '=', productId)
        .where('adjustment.product_variant_id', '=', skuId)
      if (query.beforeCreatedAt && query.beforeId) {
        statement = statement.where(sql<boolean>`(
          adjustment.created_at < ${query.beforeCreatedAt}::timestamptz
          OR (adjustment.created_at = ${query.beforeCreatedAt}::timestamptz AND adjustment.id < ${query.beforeId}::uuid)
        )`)
      }
      const rows = await statement.orderBy('adjustment.created_at', 'desc').orderBy('adjustment.id', 'desc')
        .limit(limit + 1).execute()
      const hasMore = rows.length > limit
      const pageRows = hasMore ? rows.slice(0, limit) : rows
      const last = pageRows.at(-1)
      const result: InventoryAdjustmentPage = {
        productId,
        skuId,
        adjustments: pageRows.map(mapAdjustment),
        nextCursor: hasMore && last ? { createdAt: last.cursor_created_at, id: last.id } : null,
      }
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })
}
