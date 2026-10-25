import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { Type } from 'typebox'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  AdminOrderDetailSchema,
  AdminOrderItemParamsSchema,
  AdminOrderListQuerySchema,
  AdminOrderPageSchema,
  AdminProductIdParamsSchema,
  AdminProductVariantParamsSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CheckoutOrderErrorSchema,
  CreateOrderBodySchema,
  CreateOrderHeadersSchema,
  CreateOrderResultSchema,
  GuestOrderSessionSchema,
  ManualFulfillmentConfigSchema,
  ManualFulfillmentConfigPageSchema,
  ManualFulfillmentDeliveryBodySchema,
  ManualFulfillmentResultSchema,
  OrderDetailSchema,
  OrderIdParamsSchema,
  OrderListQuerySchema,
  OrderPageSchema,
  UpdateManualFulfillmentBodySchema,
  SupplierOperationAdminActionResultSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  AdminOrderDetail,
  AdminOrderPage,
  CreateOrderBody,
  ManualFulfillmentDeliveryBody,
  OrderPurchaseData,
  OrderDetail,
  OrderPage,
  OrderStatus,
  UpdateManualFulfillmentBody,
} from '@aikayun/contracts'
import { type AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf as verifyAdminCsrf } from '../auth/admin.js'
import {
  CUSTOMER_CSRF_COOKIE,
  optionalCustomer,
  requireCustomer,
  type AuthenticatedCustomer,
} from '../auth/customer.js'
import {
  createOpaqueToken,
  hashToken,
  verifyDoubleSubmitCsrf,
} from '../auth/security.js'
import type { Database, FulfillmentMethod, OrderStatus as DbOrderStatus } from '../db/types.js'
import { CheckoutQuoteError, checkoutRequestHash, normalizeCheckoutItems,
  quoteCheckoutItems, quoteCheckoutPurchaseLines } from './checkout-quote.js'
import { normalizePurchaseLineRequests, purchaseLineContentIdentity,
  purchaseLineRequestHash, PurchaseLineError, type ResolvedPurchaseLine } from './purchase-lines.js'
import { PurchaseDraftServiceError, type PurchaseDraftOwner } from './purchase-forms.js'
import { PurchaseAttachmentError, PurchaseAttachmentStorage } from '../media/purchase-attachment-storage.js'
import { PurchaseOrderAttachmentStorage } from '../media/purchase-order-attachment-storage.js'
import { readAdminOrderPurchaseAttachment, readOrderPurchaseSnapshot, readOwnedOrderPurchaseAttachment } from './purchase-order-attachments.js'
import { validatePurchaseFormDefinition } from '@aikayun/contracts'
import { PurchaseOrderDecryptionError, PurchaseOrderKeyUnavailableError } from './purchase-form-crypto.js'
import { preparePurchaseOrderAttachments, persistOrderPurchaseSnapshotInTransaction,
  type PreparedPurchaseOrderAttachment } from './purchase-order-attachments.js'
import { CodePoolDecryptionError, CodePoolKeyUnavailableError, decryptCodePoolContent } from './code-pool-crypto.js'
import {
  decryptFixedDeliveryPayload,
  FixedDeliveryDecryptionError,
  FixedDeliveryKeyUnavailableError,
  fixedDeliveryDeliveryContext,
  type FixedDeliveryMethod,
} from './fixed-delivery-crypto.js'
import { decryptApiDeliveryResult } from './supplier-api-crypto.js'

export const guestSessionCookie = 'aikayun_guest_order_session'
const guestSessionTtlSeconds = 60 * 60 * 24 * 180
const defaultPageSize = 20
const maxPageSize = 100
const retryableSqlStates = new Set(['40001', '40P01'])

type Db = Kysely<Database> | Transaction<Database>

class OrderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'OrderError'
  }
}

class CheckoutConflict extends Error {
  constructor(readonly code: string, override readonly message: string, readonly currentQuote: Awaited<ReturnType<typeof quoteCheckoutItems>>) {
    super(message)
    this.name = 'CheckoutConflict'
  }
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string') return candidate.code
    current = candidate.cause
  }
  return undefined
}

function postgresConstraint(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (typeof candidate.constraint === 'string') return candidate.constraint
    current = candidate.cause
  }
  return undefined
}

function handleOrderError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof CodePoolKeyUnavailableError) {
    return reply.code(503).send(failure('CODE_POOL_KEY_UNAVAILABLE', '服务暂时无法解密此订单的交付凭证，请稍后重试。', requestId))
  }
  if (error instanceof CodePoolDecryptionError) {
    return reply.code(503).send(failure('CODE_POOL_DECRYPTION_FAILED', '此订单的交付凭证完整性校验失败，已记录请求编号供管理员排查。', requestId))
  }
  if (error instanceof FixedDeliveryKeyUnavailableError) {
    return reply.code(503).send(failure('FIXED_DELIVERY_KEY_UNAVAILABLE', '服务暂时无法读取此订单的数字交付内容，请稍后重试。', requestId))
  }
  if (error instanceof FixedDeliveryDecryptionError) {
    return reply.code(503).send(failure('FIXED_DELIVERY_DECRYPTION_FAILED', '此订单的数字交付内容完整性校验失败，已记录请求编号供排查。', requestId))
  }
  if (error instanceof PurchaseOrderKeyUnavailableError || error instanceof PurchaseOrderDecryptionError) {
    return reply.code(503).send(failure('PURCHASE_ORDER_SNAPSHOT_UNAVAILABLE', '成交资料暂时无法读取。', requestId))
  }
  if (error instanceof PurchaseAttachmentError) {
    return reply.code(503).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof OrderError || error instanceof CheckoutQuoteError
    || error instanceof PurchaseLineError || error instanceof PurchaseDraftServiceError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  const constraint = postgresConstraint(error)
  if (constraint === 'order_inventory_insufficient_code_pool') {
    return reply.code(409).send(failure('INSUFFICIENT_CODE_POOL', '卡密池可售数量已变化，请刷新报价后重试。', requestId))
  }
  if (constraint === 'code_pool_stock_requires_inventory_event'
    || constraint === 'code_pool_inventory_mode_immutable'
    || constraint === 'code_pool_fulfillment_history_immutable') {
    return reply.code(409).send(failure('CODE_POOL_HISTORY_PROTECTED', '此 SKU 的卡密池历史受保护，请通过卡密池管理操作调整。', requestId))
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return reply.code(422).send(failure('ORDER_AMOUNT_OUT_OF_RANGE', '订单金额超出当前结算金额范围。', requestId))
  }
  throw error
}

function orderConflict(reply: FastifyReply, requestId: string, error: CheckoutConflict) {
  return reply.code(409).send({
    error: { code: error.code, message: error.message, currentQuote: error.currentQuote },
    meta: { requestId },
  })
}

function orderPaymentStatus(order: { total_amount: string; confirmed_amount: string }): 'not_required' | 'unpaid' | 'paid' {
  if (order.total_amount === '0.00') return 'not_required'
  return order.confirmed_amount === order.total_amount ? 'paid' : 'unpaid'
}

type OrderRow = {
  id: string
  customer_id: string | null
  guest_order_session_id: string | null
  status: DbOrderStatus
  total_amount: string
  confirmed_amount: string
  currency: 'CNY'
  items_sealed: boolean
  created_at: Date
  unpaid_expires_at: Date | null
  item_count: number
}

async function orderRow(db: Db, id: string): Promise<OrderRow | undefined> {
  const result = await sql<OrderRow>`
    SELECT order_row.id, order_row.customer_id, order_row.guest_order_session_id,
      order_row.status, order_row.total_amount::text AS total_amount, order_row.currency,
      COALESCE((SELECT sum(receipt.amount) FROM payment_receipts AS receipt
        JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
        WHERE attempt.order_id = order_row.id AND attempt.status = 'succeeded'
          AND receipt.disposition = 'on_time'), 0)::text AS confirmed_amount,
      order_row.items_sealed, order_row.created_at, order_row.unpaid_expires_at,
      (SELECT count(*)::integer FROM order_items AS item WHERE item.order_id = order_row.id) AS item_count
    FROM orders AS order_row WHERE order_row.id = ${id}::uuid
  `.execute(db)
  return result.rows[0]
}

function parseOptions(value: unknown): OrderDetail['items'][number]['options'] {
  if (Array.isArray(value)) return value as OrderDetail['items'][number]['options']
  if (typeof value === 'string') {
    try { return JSON.parse(value) as OrderDetail['items'][number]['options'] }
    catch { return [] }
  }
  return []
}

export async function loadOrderDetail(db: Db, id: string, config: AppConfig): Promise<OrderDetail | undefined> {
  const order = await orderRow(db, id)
  if (!order) return undefined
  const itemRows = await db.selectFrom('order_items')
    .select([
      'id', 'product_id', 'product_variant_id', 'product_name_snapshot', 'product_type_snapshot',
      'sku_code_snapshot', 'sku_snapshot', 'inventory_mode_snapshot', 'fulfillment_method_snapshot',
      'fulfillment_content_version_id', 'purchase_line_id',
      'unit_price', 'quantity', 'line_amount', 'fulfillment_status', 'fulfilled_quantity',
      'fulfillment_reserved_quantity',
    ])
    .where('order_id', '=', id)
    .orderBy('created_at').orderBy('id')
    .execute()
  const itemIds = itemRows.map(item => item.id)
  const purchaseDataByItem = new Map<string, OrderPurchaseData>()
  for (const item of itemRows) {
    const snapshot = await readOrderPurchaseSnapshot(db, config, item.id)
    let templateName: string | null = null
    let templateVersionNumber: number | null = null
    let definition: OrderPurchaseData['definition'] = null
    if (snapshot.state === 'filled') {
      const version = await db.selectFrom('purchase_form_template_versions')
        .select(['version_number', 'name', 'definition'])
        .where('id', '=', snapshot.templateVersionId).executeTakeFirst()
      const parsed = version ? validatePurchaseFormDefinition(version.definition) : null
      if (!version || !parsed?.ok) throw new Error('Order purchase template snapshot is unavailable')
      templateName = version.name
      templateVersionNumber = version.version_number
      definition = parsed.value
    }
    const ownerPath = order.customer_id ? 'customer' : 'guest'
    purchaseDataByItem.set(item.id, {
      state: snapshot.state,
      templateVersionId: snapshot.templateVersionId,
      templateName,
      templateVersionNumber,
      definition,
      values: snapshot.values,
      attachments: snapshot.attachments.map(attachment => ({
        ...attachment,
        url: `/api/v1/${ownerPath}/orders/${order.id}/items/${item.id}/purchase-attachments/${attachment.attachmentId}`,
      })),
    })
  }
  const deliveries = itemIds.length
    ? await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .leftJoin('product_variant_fulfillment_versions as version', 'version.id', 'delivery.fulfillment_content_version_id')
      .leftJoin('private_file_objects as object', 'object.id', 'version.private_file_object_id')
      .select([
        'attempt.order_item_id as order_item_id', 'delivery.id', 'delivery.unit_index',
        'delivery.content', 'delivery.delivery_source', 'delivery.encrypted_content', 'delivery.content_nonce',
        'delivery.content_auth_tag', 'delivery.encryption_key_id', 'delivery.code_pool_entry_id',
        'delivery.fulfillment_content_version_id', 'delivery.created_at',
        'delivery.supplier_api_operation_id', 'delivery.supplier_content_type',
        'version.method as version_method', 'version.display_filename',
        'object.size_bytes as file_size_bytes', 'object.media_type as file_media_type',
      ])
      .where('attempt.order_item_id', 'in', itemIds)
      .where('attempt.status', '=', 'succeeded')
      .orderBy('attempt.order_item_id').orderBy('delivery.unit_index').orderBy('delivery.id')
      .execute()
    : []
  const deliveriesByItem = new Map<string, OrderDetail['items'][number]['deliveries']>()
  for (const delivery of deliveries) {
    let content = delivery.content
    let contentFormat: OrderDetail['items'][number]['deliveries'][number]['contentFormat'] = 'plain_text'
    let title: string | null = null
    let accessInstructions: string | null = null
    let fileName: string | null = null
    let fileSizeBytes: number | null = null
    let fileMediaType: string | null = null
    let downloadUrl: string | null = null
    if (delivery.delivery_source === 'code_pool') {
      const item = itemRows.find(row => row.id === delivery.order_item_id)
      if (!config || !item || !delivery.encrypted_content || !delivery.content_nonce || !delivery.content_auth_tag
        || !delivery.encryption_key_id || !delivery.code_pool_entry_id) {
        throw new Error('Authorized code-pool delivery could not be decrypted')
      }
      content = decryptCodePoolContent(config,
        `code-pool-delivery:${delivery.order_item_id}:${delivery.id}:${delivery.code_pool_entry_id}`, {
          keyId: delivery.encryption_key_id,
          nonce: delivery.content_nonce,
          ciphertext: delivery.encrypted_content,
          authTag: delivery.content_auth_tag,
        })
    } else if (delivery.delivery_source === 'fixed_content' || delivery.delivery_source === 'link') {
      const item = itemRows.find(row => row.id === delivery.order_item_id)
      const method = delivery.delivery_source as FixedDeliveryMethod
      if (!config || !item || !item.fulfillment_content_version_id
        || delivery.fulfillment_content_version_id !== item.fulfillment_content_version_id
        || !delivery.encrypted_content || !delivery.content_nonce || !delivery.content_auth_tag
        || !delivery.encryption_key_id) {
        throw new FixedDeliveryDecryptionError()
      }
      const payload = decryptFixedDeliveryPayload(config,
        fixedDeliveryDeliveryContext(item.id, delivery.id, item.fulfillment_content_version_id, method),
        method, {
          keyId: delivery.encryption_key_id,
          nonce: delivery.content_nonce,
          ciphertext: delivery.encrypted_content,
          authTag: delivery.content_auth_tag,
        })
      content = payload.method === 'fixed_content' ? payload.content : payload.url
      contentFormat = payload.method === 'fixed_content' ? 'markdown' : 'link'
      title = payload.method === 'link' ? payload.title : null
      accessInstructions = payload.method === 'link' ? payload.accessInstructions : null
    } else if (delivery.delivery_source === 'file') {
      const item = itemRows.find(row => row.id === delivery.order_item_id)
      if (!item || item.fulfillment_method_snapshot !== 'file'
        || !item.fulfillment_content_version_id
        || delivery.fulfillment_content_version_id !== item.fulfillment_content_version_id
        || delivery.version_method !== 'file'
        || !delivery.display_filename || delivery.file_size_bytes === null || !delivery.file_media_type) {
        throw new Error('File delivery version does not match the immutable order snapshot')
      }
      content = null
      contentFormat = 'file'
      fileName = delivery.display_filename
      fileSizeBytes = delivery.file_size_bytes
      fileMediaType = delivery.file_media_type
      const ownerPath = order.customer_id ? 'customer' : 'guest'
      downloadUrl = `/api/v1/${ownerPath}/orders/${order.id}/items/${item.id}/deliveries/${delivery.id}/file`
    } else if (delivery.delivery_source === 'api') {
      const item = itemRows.find(row => row.id === delivery.order_item_id)
      if (!config || !item || item.fulfillment_method_snapshot !== 'api'
        || !item.fulfillment_content_version_id
        || delivery.fulfillment_content_version_id !== item.fulfillment_content_version_id
        || !delivery.supplier_api_operation_id || !delivery.supplier_content_type) {
        throw new Error('Authorized API delivery does not match its immutable order snapshot')
      }
      if (delivery.supplier_content_type === 'completed') {
        if (delivery.encrypted_content || delivery.content_nonce || delivery.content_auth_tag || delivery.encryption_key_id) {
          throw new Error('Completed API confirmation unexpectedly includes a content envelope')
        }
        content = null
        contentFormat = 'confirmation'
      } else {
        if (!delivery.encrypted_content || !delivery.content_nonce || !delivery.content_auth_tag || !delivery.encryption_key_id) {
          throw new Error('Authorized API delivery could not be decrypted')
        }
        const result = decryptApiDeliveryResult(config, delivery.supplier_api_operation_id, {
          keyId: delivery.encryption_key_id,
          nonce: delivery.content_nonce,
          ciphertext: delivery.encrypted_content,
          authTag: delivery.content_auth_tag,
        })
        if (result.type !== delivery.supplier_content_type) throw new Error('API delivery type does not match its stored result')
        content = result.content
        contentFormat = result.type === 'link' ? 'link' : 'plain_text'
        title = result.title
        accessInstructions = result.instructions
      }
    }
    if (content === null && contentFormat !== 'file' && contentFormat !== 'confirmation') throw new Error('Fulfillment delivery content is missing')
    const rows = deliveriesByItem.get(delivery.order_item_id) ?? []
    rows.push({
      id: delivery.id,
      unitIndex: delivery.unit_index,
      content,
      contentFormat,
      title,
      accessInstructions,
      fileName,
      fileSizeBytes,
      fileMediaType,
      downloadUrl,
      createdAt: delivery.created_at.toISOString(),
    })
    deliveriesByItem.set(delivery.order_item_id, rows)
  }
  const attemptRows = itemIds.length
    ? await sql<{
      order_item_id: string; status: OrderDetail['items'][number]['fulfillmentAttempts'][number]['status'];
      quantity: number; delivery_source: string; failure_code: string | null; retry_after: Date | null; created_at: Date; completed_at: Date | null;
    }>`
      SELECT order_item_id, status, quantity, failure_code, retry_after, created_at, completed_at
      FROM (
        SELECT attempt.order_item_id, attempt.status, attempt.quantity, attempt.delivery_source, attempt.failure_code,
          attempt.retry_after, attempt.created_at, attempt.completed_at,
          row_number() OVER (PARTITION BY attempt.order_item_id ORDER BY attempt.created_at DESC, attempt.id DESC) AS rank
        FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = ANY(${itemIds}::uuid[])
      ) AS recent
      WHERE rank <= 10
      ORDER BY order_item_id, created_at DESC
    `.execute(db)
    : { rows: [] }
  const attemptsByItem = new Map<string, OrderDetail['items'][number]['fulfillmentAttempts']>()
  for (const attempt of attemptRows.rows) {
    const rows = attemptsByItem.get(attempt.order_item_id) ?? []
    rows.push({
      status: attempt.status,
      quantity: attempt.quantity,
      failureCode: attempt.delivery_source === 'api' ? null : attempt.failure_code,
      retryAfter: attempt.retry_after?.toISOString() ?? null,
      createdAt: attempt.created_at.toISOString(),
      completedAt: attempt.completed_at?.toISOString() ?? null,
    })
    attemptsByItem.set(attempt.order_item_id, rows)
  }
  const statusEvents = await db.selectFrom('order_status_events')
    .select(['previous_status', 'next_status', 'created_at'])
    .where('order_id', '=', id)
    .orderBy('created_at').orderBy('id')
    .execute()
  if (!order.items_sealed || itemRows.length === 0) throw new Error('Committed order is missing its sealed item snapshots')
  return {
    id: order.id,
    status: order.status,
    paymentStatus: orderPaymentStatus(order),
    totalAmount: order.total_amount,
    currency: order.currency,
    itemCount: order.item_count,
    createdAt: order.created_at.toISOString(),
    unpaidExpiresAt: order.unpaid_expires_at?.toISOString() ?? null,
    itemsSealed: true,
    items: itemRows.map(item => ({
      id: item.id,
      lineId: item.purchase_line_id,
      productId: item.product_id,
      skuId: item.product_variant_id,
      productName: item.product_name_snapshot,
      productType: item.product_type_snapshot,
      skuCode: item.sku_code_snapshot,
      options: parseOptions(item.sku_snapshot),
      inventoryMode: item.inventory_mode_snapshot,
      fulfillmentMethod: item.fulfillment_method_snapshot,
      unitPrice: item.unit_price,
      quantity: item.quantity,
      lineAmount: item.line_amount,
      fulfillmentStatus: item.fulfillment_status,
      fulfilledQuantity: item.fulfilled_quantity,
      fulfillmentReservedQuantity: item.fulfillment_reserved_quantity,
      purchaseData: purchaseDataByItem.get(item.id)!,
      fulfillmentAttempts: attemptsByItem.get(item.id) ?? [],
      deliveries: deliveriesByItem.get(item.id) ?? [],
    })),
    statusEvents: statusEvents.map(event => ({
      previousStatus: event.previous_status,
      nextStatus: event.next_status,
      createdAt: event.created_at.toISOString(),
    })),
  }
}

export async function assertCustomerSession(
  trx: Transaction<Database>,
  customer: AuthenticatedCustomer,
  purchaseLock = false,
): Promise<void> {
  let ownerQuery = trx.selectFrom('customers')
    .select(['id', 'status', 'username'])
    .where('id', '=', customer.id)
  ownerQuery = purchaseLock ? ownerQuery.forUpdate() : ownerQuery.forShare()
  const owner = await ownerQuery.executeTakeFirst()
  if (!owner || owner.status !== 'active' || !owner.username) {
    throw new OrderError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
  }
  const session = await trx.selectFrom('customer_sessions')
    .select('id')
    .where('id', '=', customer.sessionId)
    .where('customer_id', '=', customer.id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .forShare()
    .executeTakeFirst()
  if (!session) throw new OrderError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
}

export async function assertGuestSession(
  trx: Transaction<Database>, token: string | undefined, purchaseLock = false,
): Promise<string> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new OrderError(401, 'GUEST_SESSION_REQUIRED', '请刷新页面后继续，系统会自动恢复游客订单会话。')
  }
  const query = trx.selectFrom('guest_order_sessions')
    .select('id')
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
  const session = await (purchaseLock ? query.forUpdate() : query.forShare()).executeTakeFirst()
  if (!session) throw new OrderError(401, 'GUEST_SESSION_REQUIRED', '游客订单会话已过期，请刷新页面后继续。')
  return session.id
}

async function lockCheckoutCatalog(trx: Transaction<Database>, skuIds: string[]): Promise<void> {
  const products = await trx.selectFrom('product_variants')
    .select('product_id')
    .distinct()
    .where('id', 'in', skuIds)
    .orderBy('product_id')
    .execute()
  const productIds = products.map(row => row.product_id)
  if (productIds.length) {
    await sql`SELECT id FROM products WHERE id = ANY(${productIds}::uuid[]) ORDER BY id FOR SHARE`.execute(trx)
  }
  await sql`SELECT id FROM product_variants WHERE id = ANY(${skuIds}::uuid[]) ORDER BY product_id, id FOR UPDATE`.execute(trx)
  await sql`
    SELECT product_variant_id FROM product_variant_quantity_inventory
    WHERE product_variant_id = ANY(${skuIds}::uuid[])
    ORDER BY product_id, product_variant_id FOR UPDATE
  `.execute(trx)
  await sql`
    SELECT product_variant_id FROM product_variant_fulfillment
    WHERE product_variant_id = ANY(${skuIds}::uuid[])
    ORDER BY product_variant_id FOR SHARE
  `.execute(trx)
}

async function lockIdempotencyKey(
  trx: Transaction<Database>,
  ownerType: 'customer' | 'guest',
  ownerId: string,
  idempotencyKey: string,
): Promise<void> {
  const lockName = `${ownerType}:${ownerId}:${idempotencyKey}`
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`.execute(trx)
}

async function existingIdempotentOrder(
  trx: Transaction<Database>,
  ownerType: 'customer' | 'guest',
  ownerId: string,
  idempotencyKey: string,
  requestHash: string,
  config: AppConfig,
): Promise<OrderDetail | null> {
  let query = trx.selectFrom('orders').select(['id', 'request_sha256'])
    .where('idempotency_key', '=', idempotencyKey)
  query = ownerType === 'customer'
    ? query.where('customer_id', '=', ownerId)
    : query.where('guest_order_session_id', '=', ownerId)
  const existing = await query.executeTakeFirst()
  if (!existing) return null
  if (existing.request_sha256 !== requestHash) {
    throw new OrderError(409, 'ORDER_IDEMPOTENCY_CONFLICT', '此幂等标识已用于不同的 SKU 或购买数量。请为新的下单内容生成新标识。')
  }
  const detail = await loadOrderDetail(trx, existing.id, config)
  if (!detail) throw new Error('Idempotent order disappeared inside its transaction')
  return detail
}

function assertExpectedGuestOwner(expectedGuestSessionId: string | undefined, ownerType: 'customer' | 'guest', ownerId: string): void {
  if (expectedGuestSessionId && (ownerType !== 'guest' || expectedGuestSessionId !== ownerId)) {
    throw new OrderError(409, 'GUEST_SESSION_CHANGED', '游客订单会话已变化，请在原游客会话核对未确认订单。原提交标识已保留。')
  }
}

async function createOrderTransaction(
  trx: Transaction<Database>,
  body: CreateOrderBody,
  customer: AuthenticatedCustomer | null,
  guestToken: string | undefined,
  config: AppConfig,
  preparedByLine: ReadonlyMap<string, PreparedPurchaseOrderAttachment[]>,
  expectedGuestSessionId?: string,
): Promise<{ created: boolean; order: OrderDetail }> {
  const v2 = 'version' in body && body.version === 2
  const legacyItems = v2 ? null : normalizeCheckoutItems(body.items)
  const requestedLines = v2 ? normalizePurchaseLineRequests(body.items) : null
  const requestHash = v2 ? purchaseLineRequestHash(body.items) : checkoutRequestHash(legacyItems!)
  let ownerType: 'customer' | 'guest'
  let ownerId: string
  if (customer) {
    // Take UPDATE first, before the session SHARE lock. This serializes all
    // customer quota checks and avoids SHARE-to-UPDATE lock upgrade deadlocks.
    await assertCustomerSession(trx, customer, true)
    ownerType = 'customer'
    ownerId = customer.id
  } else {
    ownerId = await assertGuestSession(trx, guestToken, v2)
    ownerType = 'guest'
  }
  assertExpectedGuestOwner(expectedGuestSessionId, ownerType, ownerId)

  await lockIdempotencyKey(trx, ownerType, ownerId, body.idempotencyKey)
  const existing = await existingIdempotentOrder(trx, ownerType, ownerId, body.idempotencyKey, requestHash, config)
  if (existing) return { created: false, order: existing }

  await trx.selectFrom('storefront_customer_policy').select('singleton')
    .where('singleton', '=', true).forShare().executeTakeFirstOrThrow()
  await lockCheckoutCatalog(trx, (v2 ? requestedLines! : legacyItems!).map(item => item.skuId))
  const owner: PurchaseDraftOwner = customer
    ? { kind: 'customer', customer }
    : { kind: 'guest', guestSessionToken: guestToken ?? '' }
  const purchaseQuote = v2 ? await quoteCheckoutPurchaseLines(trx, body.items, owner, config) : null
  const currentQuote = purchaseQuote?.quote
    ?? await quoteCheckoutItems(trx, legacyItems!, customer?.id ?? null, config)
  if (currentQuote.quoteToken !== body.quoteToken) {
    throw new CheckoutConflict('CHECKOUT_QUOTE_CHANGED', '价格、商品状态、库存、限购规则或可购额度已变化，请核对最新报价后重新提交。', currentQuote)
  }
  if (!currentQuote.canContinue || currentQuote.totalAmount === null) {
    if (currentQuote.items.some(item => item.purchaseLimits.requiresLogin
      || item.purchaseLimits.product.exceeded || item.purchaseLimits.sku.exceeded)) {
      throw new CheckoutConflict('PURCHASE_LIMIT_EXCEEDED', '该商品需要登录后购买，或所选数量超过当前限购额度。请调整数量后重新报价。', currentQuote)
    }
    throw new CheckoutConflict('ORDER_NOT_ELIGIBLE', '所选商品当前不满足下单条件，请查看新的报价信息。', currentQuote)
  }

  const orderId = randomUUID()
  await trx.insertInto('orders').values({
    id: orderId,
    customer_id: ownerType === 'customer' ? ownerId : null,
    guest_order_session_id: ownerType === 'guest' ? ownerId : null,
    idempotency_key: body.idempotencyKey,
    request_sha256: requestHash,
    total_amount: currentQuote.totalAmount,
    // The BEFORE INSERT trigger replaces this placeholder using the locked policy.
    unpaid_expires_at: new Date(Date.now() + 60_000),
    history_hidden_at: null,
    history_hidden_by_admin_id: null,
    history_hidden_reason: null,
  }).execute()

  const resolvedLines = new Map<string, ResolvedPurchaseLine>(purchaseQuote?.lines.map(line => [line.lineId, line]) ?? [])
  const orderItems = [...currentQuote.items].sort((left, right) =>
    (left.productId ?? '').localeCompare(right.productId ?? '')
    || left.skuId.localeCompare(right.skuId)
    || (left.lineId ?? '').localeCompare(right.lineId ?? ''))
  for (const item of orderItems) {
    const inventoryMode = item.inventoryMode
    if (!item.productId || !item.productName || !item.productType || !item.skuCode || !item.unitPrice || !item.lineTotal
      || (inventoryMode !== 'quantity' && inventoryMode !== 'unlimited')
      || !['manual', 'code_pool', 'fixed_content', 'link', 'file', 'api'].includes(item.fulfillmentMethod ?? '')) {
      throw new Error('Eligible checkout item is missing required transaction snapshot fields')
    }
    const orderItemId = randomUUID()
    const lineId = item.lineId ?? randomUUID()
    await trx.insertInto('order_items').values({
      id: orderItemId,
      purchase_line_id: lineId,
      order_id: orderId,
      product_id: item.productId,
      product_variant_id: item.skuId,
      product_name_snapshot: item.productName,
      product_type_snapshot: item.productType,
      sku_code_snapshot: item.skuCode,
      sku_snapshot: JSON.stringify(item.options),
      inventory_mode_snapshot: inventoryMode,
      fulfillment_method_snapshot: item.fulfillmentMethod as FulfillmentMethod,
      fulfillment_content_version_id: item.fulfillmentVersionId,
      unit_price: item.unitPrice,
      quantity: item.quantity,
      line_amount: item.lineTotal,
    }).execute()
    const resolved = item.lineId ? resolvedLines.get(item.lineId) : null
    if (v2 && !resolved) throw new Error('Version 2 quote is missing its resolved purchase line')
    await persistOrderPurchaseSnapshotInTransaction(trx, config, {
      orderItemId,
      contentIdentity: resolved?.contentIdentity ?? purchaseLineContentIdentity(item.skuId, null, null, null),
      draft: resolved?.validatedDraft ?? null,
      preparedAttachments: item.lineId ? (preparedByLine.get(item.lineId) ?? []) : [],
    })
    if (inventoryMode === 'quantity') {
      await trx.insertInto('order_inventory_reservations').values({
        id: randomUUID(),
        order_item_id: orderItemId,
        product_id: item.productId,
        product_variant_id: item.skuId,
        quantity: item.quantity,
      }).execute()
    }
  }
  await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
  const order = await loadOrderDetail(trx, orderId, config)
  if (!order) throw new Error('New order could not be loaded before commit')
  return { created: true, order }
}

async function createOrderWithRetry(
  db: Kysely<Database>,
  body: CreateOrderBody,
  customer: AuthenticatedCustomer | null,
  guestToken: string | undefined,
  config: AppConfig,
  expectedGuestSessionId?: string,
): Promise<{ created: boolean; order: OrderDetail }> {
  const preparedByLine = new Map<string, PreparedPurchaseOrderAttachment[]>()
  if ('version' in body && body.version === 2) {
    const requestHash = purchaseLineRequestHash(body.items)
    const preflight = await db.transaction().execute(async (trx) => {
      let ownerType: 'customer' | 'guest'
      let ownerId: string
      if (customer) {
        await assertCustomerSession(trx, customer, true)
        ownerType = 'customer'
        ownerId = customer.id
      } else {
        ownerId = await assertGuestSession(trx, guestToken, true)
        ownerType = 'guest'
      }
      assertExpectedGuestOwner(expectedGuestSessionId, ownerType, ownerId)
      await lockIdempotencyKey(trx, ownerType, ownerId, body.idempotencyKey)
      const existing = await existingIdempotentOrder(trx, ownerType, ownerId,
        body.idempotencyKey, requestHash, config)
      if (existing) return { existing, lines: [] as ResolvedPurchaseLine[] }
      const owner: PurchaseDraftOwner = customer
        ? { kind: 'customer', customer }
        : { kind: 'guest', guestSessionToken: guestToken ?? '' }
      const purchaseQuote = await quoteCheckoutPurchaseLines(trx, body.items, owner, config)
      if (purchaseQuote.quote.quoteToken !== body.quoteToken) {
        throw new CheckoutConflict('CHECKOUT_QUOTE_CHANGED',
          '填写资料、价格、库存或购买资格已变化，请核对最新报价后重新提交。', purchaseQuote.quote)
      }
      if (!purchaseQuote.quote.canContinue || purchaseQuote.quote.totalAmount === null) {
        const limitExceeded = purchaseQuote.quote.items.some(item => item.purchaseLimits.requiresLogin
          || item.purchaseLimits.product.exceeded || item.purchaseLimits.sku.exceeded)
        throw new CheckoutConflict(limitExceeded ? 'PURCHASE_LIMIT_EXCEEDED' : 'ORDER_NOT_ELIGIBLE',
          '所选购买行当前不满足下单条件，请核对最新报价后重新提交。', purchaseQuote.quote)
      }
      return { existing: null, lines: purchaseQuote.lines }
    })
    if (preflight.existing) return { created: false, order: preflight.existing }
    const draftStorage = new PurchaseAttachmentStorage(config.privateFileRoot)
    const orderStorage = new PurchaseOrderAttachmentStorage(config.privateFileRoot)
    for (const line of preflight.lines) {
      if (!line.validatedDraft || line.validatedDraft.attachments.length === 0) continue
      const prepared = await preparePurchaseOrderAttachments(db, draftStorage, orderStorage,
        line.validatedDraft)
      preparedByLine.set(line.lineId, prepared)
    }
  }
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.transaction().execute(trx => createOrderTransaction(trx, body, customer,
        guestToken, config, preparedByLine, expectedGuestSessionId))
    } catch (error) {
      if (!retryableSqlStates.has(postgresCode(error) ?? '') || attempt === maxAttempts) {
        if (retryableSqlStates.has(postgresCode(error) ?? '')) {
          throw new OrderError(409, 'ORDER_CONCURRENT_CONFLICT', '订单数据正在并发变化，请刷新报价后重试。')
        }
        throw error
      }
    }
  }
  throw new Error('Unreachable bounded order retry exit')
}

async function orderPage(
  db: Db,
  ownerType: 'customer' | 'guest',
  ownerId: string,
  page: number,
  pageSize: number,
): Promise<OrderPage> {
  const offset = (page - 1) * pageSize
  let listQuery = db.selectFrom('orders').select([
    'id', 'status', 'total_amount', 'currency', 'created_at', 'unpaid_expires_at',
    sql<string>`COALESCE((SELECT sum(receipt.amount) FROM payment_receipts AS receipt
      JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
      WHERE attempt.order_id = orders.id AND attempt.status = 'succeeded'
        AND receipt.disposition = 'on_time'), 0)::text`.as('confirmed_amount'),
  ])
  let countQuery = db.selectFrom('orders').select(({ fn }) => fn.countAll<number>().as('total'))
  if (ownerType === 'customer') {
    listQuery = listQuery.where('customer_id', '=', ownerId)
    countQuery = countQuery.where('customer_id', '=', ownerId)
  } else {
    listQuery = listQuery.where('guest_order_session_id', '=', ownerId)
    countQuery = countQuery.where('guest_order_session_id', '=', ownerId)
  }
  const [rows, count] = await Promise.all([
    listQuery.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(pageSize).offset(offset).execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])
  const orderIds = rows.map(row => row.id)
  const counts = orderIds.length
    ? await db.selectFrom('order_items')
      .select(({ fn }) => ['order_id', fn.countAll<number>().as('item_count')])
      .where('order_id', 'in', orderIds)
      .groupBy('order_id')
      .execute()
    : []
  const itemCounts = new Map(counts.map(row => [row.order_id, row.item_count]))
  const total = Number(count.total)
  return {
    items: rows.map(row => ({
      id: row.id,
      status: row.status,
      paymentStatus: orderPaymentStatus(row),
      totalAmount: row.total_amount,
      currency: row.currency,
      itemCount: itemCounts.get(row.id) ?? 1,
      createdAt: row.created_at.toISOString(),
      unpaidExpiresAt: row.unpaid_expires_at?.toISOString() ?? null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }
}

async function getOwnedOrder(
  db: Db,
  orderId: string,
  ownerType: 'customer' | 'guest',
  ownerId: string,
  config: AppConfig,
): Promise<OrderDetail | undefined> {
  const order = await db.selectFrom('orders').select('id').where('id', '=', orderId)
  const owned = ownerType === 'customer'
    ? await order.where('customer_id', '=', ownerId).executeTakeFirst()
    : await order.where('guest_order_session_id', '=', ownerId).executeTakeFirst()
  if (!owned) return undefined
  return loadOrderDetail(db, owned.id, config)
}

async function orderHasCloseProtection(trx: Transaction<Database>, orderId: string): Promise<boolean> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${orderId}::text, 0))`.execute(trx)
  const result = await sql<{ protected: boolean }>`
    SELECT
      order_has_unresolved_payment_attempts(${orderId}::uuid)
      OR EXISTS (
        SELECT 1 FROM payment_receipts AS receipt
        JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
        WHERE attempt.order_id = ${orderId}::uuid
          AND (receipt.refund_reserved_amount > 0 OR receipt.amount <> receipt.refunded_amount)
      )
      OR EXISTS (
        SELECT 1 FROM order_refunds AS refund
        WHERE refund.order_id = ${orderId}::uuid
          AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded')
      )
      OR EXISTS (
        SELECT 1 FROM order_item_fulfillment_attempts AS attempt
        JOIN order_items AS item ON item.id = attempt.order_item_id
        WHERE item.order_id = ${orderId}::uuid AND attempt.status IN ('processing', 'unknown')
      )
      OR EXISTS (
        SELECT 1 FROM order_items AS item
        WHERE item.order_id = ${orderId}::uuid AND item.fulfillment_reserved_quantity > 0
      ) AS protected
  `.execute(trx)
  return result.rows[0]?.protected ?? true
}

async function closeOrderAndReleaseInventory(trx: Transaction<Database>, orderId: string): Promise<void> {
  if (await orderHasCloseProtection(trx, orderId)) {
    throw new OrderError(409, 'ORDER_HAS_UNRESOLVED_OBLIGATION', '订单存在支付、退款或履约义务，当前不能关闭。')
  }
  const updated = await trx.updateTable('orders').set({ status: 'closed' })
    .where('id', '=', orderId).where('status', '=', 'pending_payment')
    .returning('id').executeTakeFirst()
  if (!updated) throw new OrderError(409, 'ORDER_NOT_CANCELLABLE', '订单状态已变化，请刷新后查看最新状态。')
  // ④-1's AFTER status trigger writes release events and updates reserved.
  // Inventory remains governed by order_inventory_events; never edit reserved here.
}

/** Close a bounded batch of expired unpaid orders in one PostgreSQL transaction. */
export async function expireDueUnpaidOrders(
  db: Kysely<Database>,
  now = new Date(),
  batchSize = 100,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError('Unpaid-order batch size must be between 1 and 500')
  }
  return db.transaction().execute(async (trx) => {
    const due = await sql<{ id: string }>`
      SELECT id FROM orders
      WHERE status = 'pending_payment' AND unpaid_expires_at <= ${now}
        AND NOT order_has_unresolved_payment_attempts(orders.id)
        AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt
          JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
          WHERE attempt.order_id = orders.id
            AND (receipt.refund_reserved_amount > 0 OR receipt.amount <> receipt.refunded_amount)
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_refunds AS refund
          WHERE refund.order_id = orders.id
            AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded')
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_item_fulfillment_attempts AS attempt
          JOIN order_items AS item ON item.id = attempt.order_item_id
          WHERE item.order_id = orders.id AND attempt.status IN ('processing', 'unknown')
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items AS item
          WHERE item.order_id = orders.id AND item.fulfillment_reserved_quantity > 0
        )
        AND COALESCE((
          SELECT sum(receipt.amount) - sum(receipt.refunded_amount)
          FROM payment_receipts AS receipt
          JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
          WHERE attempt.order_id = orders.id
        ), 0) = 0
      ORDER BY unpaid_expires_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `.execute(trx)
    let closed = 0
    for (const order of due.rows) {
      if (await orderHasCloseProtection(trx, order.id)) continue
      try {
        await closeOrderAndReleaseInventory(trx, order.id)
        closed += 1
      } catch (error) {
        if (error instanceof OrderError && error.code === 'ORDER_HAS_UNRESOLVED_OBLIGATION') continue
        throw error
      }
    }
    return closed
  })
}

async function lockCustomerForOrderMutation(trx: Transaction<Database>, customer: AuthenticatedCustomer): Promise<void> {
  await assertCustomerSession(trx, customer)
}

function setGuestSessionCookie(reply: FastifyReply, token: string, config: AppConfig): void {
  reply.setCookie(guestSessionCookie, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: guestSessionTtlSeconds,
  })
}

async function adminOrderPage(db: Kysely<Database>, query: {
  page?: number
  pageSize?: number
  status?: OrderStatus | 'all'
}): Promise<AdminOrderPage> {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? defaultPageSize
  const offset = (page - 1) * pageSize
  let listQuery = db.selectFrom('orders as order')
    .leftJoin('customers as customer', 'customer.id', 'order.customer_id')
    .select([
      'order.id', 'order.status', 'order.total_amount', 'order.currency', 'order.created_at',
      'order.unpaid_expires_at', 'order.customer_id', 'customer.username as customer_username',
      sql<string>`COALESCE((SELECT sum(receipt.amount) FROM payment_receipts AS receipt
        JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
        WHERE attempt.order_id = order.id AND attempt.status = 'succeeded'
          AND receipt.disposition = 'on_time'), 0)::text`.as('confirmed_amount'),
    ])
  let countQuery = db.selectFrom('orders').select(({ fn }) => fn.countAll<number>().as('total'))
  if (query.status && query.status !== 'all') {
    listQuery = listQuery.where('order.status', '=', query.status)
    countQuery = countQuery.where('status', '=', query.status)
  }
  const [rows, count] = await Promise.all([
    listQuery.orderBy('order.created_at', 'desc').orderBy('order.id', 'desc').limit(pageSize).offset(offset).execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])
  const ids = rows.map(row => row.id)
  const counts = ids.length
    ? await db.selectFrom('order_items').select(({ fn }) => ['order_id', fn.countAll<number>().as('item_count')])
      .where('order_id', 'in', ids).groupBy('order_id').execute()
    : []
  const itemCounts = new Map(counts.map(row => [row.order_id, row.item_count]))
  const total = Number(count.total)
  return {
    items: rows.map(row => ({
      id: row.id,
      status: row.status,
      paymentStatus: orderPaymentStatus(row),
      totalAmount: row.total_amount,
      currency: row.currency,
      itemCount: itemCounts.get(row.id) ?? 1,
      createdAt: row.created_at.toISOString(),
      unpaidExpiresAt: row.unpaid_expires_at?.toISOString() ?? null,
      ownerType: row.customer_id ? 'customer' : 'guest',
      customerId: row.customer_id,
      customerUsername: row.customer_username,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }
}

async function adminOrderDetail(db: Kysely<Database>, orderId: string, config: AppConfig): Promise<AdminOrderDetail | undefined> {
  const detail = await loadOrderDetail(db, orderId, config)
  if (!detail) return undefined
  const row = await db.selectFrom('orders as order')
    .leftJoin('customers as customer', 'customer.id', 'order.customer_id')
    .select([
      'order.customer_id', 'order.guest_order_session_id', 'customer.username as customer_username',
    ])
    .where('order.id', '=', orderId)
    .executeTakeFirstOrThrow()
  const inventoryRows = await sql<{
    order_item_id: string
    reservation_id: string | null
    reserved_quantity: number
    events: AdminOrderDetail['inventory'][number]['events']
  }>`
    SELECT item.id AS order_item_id,
      reservation.id AS reservation_id,
      COALESCE(sum(event.quantity) FILTER (WHERE event.action = 'reserve'), 0)
        - COALESCE(sum(event.quantity) FILTER (WHERE event.action IN ('release', 'consume')), 0) AS reserved_quantity,
      COALESCE(jsonb_agg(jsonb_build_object(
        'action', event.action, 'quantity', event.quantity, 'createdAt', event.created_at
      ) ORDER BY event.created_at, event.id) FILTER (WHERE event.id IS NOT NULL), '[]'::jsonb) AS events
    FROM order_items AS item
    LEFT JOIN order_inventory_reservations AS reservation ON reservation.order_item_id = item.id
    LEFT JOIN order_inventory_events AS event ON event.reservation_id = reservation.id
    WHERE item.order_id = ${orderId}::uuid
    GROUP BY item.id, reservation.id
    ORDER BY item.created_at, item.id
  `.execute(db)
  const attempts = await db.selectFrom('order_item_fulfillment_attempts as attempt')
    .innerJoin('order_items as item', 'item.id', 'attempt.order_item_id')
    .select([
      'attempt.id', 'attempt.order_item_id', 'attempt.started_by_admin_id', 'attempt.quantity',
      'attempt.status', 'attempt.result_sha256', 'attempt.created_at', 'attempt.completed_at',
      'attempt.delivery_source', 'attempt.failure_code', 'attempt.retry_after',
    ])
    .where('item.order_id', '=', orderId)
    .orderBy('attempt.created_at').orderBy('attempt.id')
    .execute()
  const attemptCounts = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
    .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
    .innerJoin('order_items as item', 'item.id', 'attempt.order_item_id')
    .select(({ fn }) => ['attempt.id as attempt_id', fn.countAll<number>().as('delivery_count')])
    .where('item.order_id', '=', orderId)
    .groupBy('attempt.id')
    .execute()
  const deliveryCounts = new Map(attemptCounts.map(item => [item.attempt_id, item.delivery_count]))
  const supplierOperationRows = await sql<{
    id: string; fulfillment_attempt_id: string; operation_id: string; unit_index: number;
    supplier_connection_id: string; supplier_name: string; supplier_product_id: string;
    idempotency_key: string; provider_operation_id: string | null; state: AdminOrderDetail['supplierOperations'][number]['state'];
    create_attempt_count: number; query_attempt_count: number; last_http_status: number | null;
    last_error_code: string | null; last_failure_class: string | null; last_provider_status: string | null;
    next_action_at: Date | null; create_requested_at: Date | null; last_query_at: Date | null;
    created_at: Date; completed_at: Date | null; events: AdminOrderDetail['supplierOperations'][number]['events'];
  }>`
    SELECT operation.id, operation.fulfillment_attempt_id, operation.operation_id, operation.unit_index,
      operation.supplier_connection_id, supplier_version.display_name AS supplier_name,
      operation.supplier_product_id, operation.idempotency_key, operation.provider_operation_id,
      operation.state, operation.create_attempt_count, operation.query_attempt_count,
      operation.last_http_status, operation.last_error_code, operation.last_failure_class,
      operation.last_provider_status, operation.next_action_at, operation.create_requested_at,
      operation.last_query_at, operation.created_at, operation.completed_at,
      COALESCE(jsonb_agg(jsonb_build_object(
        'eventType', event.event_type, 'httpStatus', event.http_status,
        'classification', event.classification, 'providerStatus', event.provider_status,
        'errorCode', event.error_code, 'responseSha256', nullif(btrim(event.response_sha256), ''),
        'createdAt', event.created_at
      ) ORDER BY event.created_at, event.id) FILTER (WHERE event.id IS NOT NULL), '[]'::jsonb) AS events
    FROM supplier_api_delivery_operations AS operation
    JOIN supplier_connection_versions AS supplier_version
      ON supplier_version.id = operation.supplier_connection_version_id
    JOIN order_item_fulfillment_attempts AS attempt ON attempt.id = operation.fulfillment_attempt_id
    JOIN order_items AS item ON item.id = attempt.order_item_id
    LEFT JOIN supplier_api_delivery_events AS event ON event.operation_id = operation.id
    WHERE item.order_id = ${orderId}::uuid
    GROUP BY operation.id, supplier_version.display_name
    ORDER BY operation.created_at, operation.id
  `.execute(db)
  const paymentAttempts = await db.selectFrom('payment_attempts as attempt')
    .leftJoin('payment_attempt_provider_state as provider_state', 'provider_state.payment_attempt_id', 'attempt.id')
    .select([
      'attempt.id', 'attempt.provider_type_snapshot', 'attempt.payment_method_snapshot',
      'attempt.payment_channel_name_snapshot', 'attempt.merchant_order_no', 'attempt.status',
      'attempt.amount', 'attempt.created_at', 'attempt.expires_at', 'attempt.completed_at',
      'provider_state.state as provider_state', 'provider_state.provider_order_id as provider_order_id',
      'provider_state.last_error_code as provider_error_code',
      sql<string | null>`(SELECT receipt.amount::text FROM payment_receipts AS receipt
        WHERE receipt.payment_attempt_id = attempt.id AND receipt.source_bucket = 'external'
        ORDER BY receipt.received_at, receipt.id LIMIT 1)`.as('actual_amount'),
      sql<string | null>`(SELECT receipt.provider_transaction_id FROM payment_receipts AS receipt
        WHERE receipt.payment_attempt_id = attempt.id AND receipt.source_bucket = 'external'
        ORDER BY receipt.received_at, receipt.id LIMIT 1)`.as('provider_transaction_id'),
      sql<string | null>`(SELECT receipt.disposition FROM payment_receipts AS receipt
        WHERE receipt.payment_attempt_id = attempt.id AND receipt.source_bucket = 'external'
        ORDER BY receipt.received_at, receipt.id LIMIT 1)`.as('receipt_disposition'),
    ])
    .where('attempt.order_id', '=', orderId)
    .where('attempt.payment_channel_id', 'is not', null)
    .orderBy('attempt.created_at').orderBy('attempt.id')
    .execute()
  const paymentAttemptIds = paymentAttempts.map(attempt => attempt.id)
  const providerEvents = paymentAttemptIds.length
    ? await db.selectFrom('payment_provider_events').selectAll()
      .where('payment_attempt_id', 'in', paymentAttemptIds)
      .orderBy('received_at').orderBy('id').execute()
    : []
  const providerEventsByAttempt = new Map<string, typeof providerEvents>()
  for (const event of providerEvents) {
    const events = providerEventsByAttempt.get(event.payment_attempt_id) ?? []
    events.push(event)
    providerEventsByAttempt.set(event.payment_attempt_id, events)
  }
  const reconciliationCases = paymentAttemptIds.length
    ? await db.selectFrom('payment_provider_reconciliation_cases').selectAll()
      .where('payment_attempt_id', 'in', paymentAttemptIds)
      .orderBy('opened_at').orderBy('id').execute()
    : []
  const reconciliationCasesByAttempt = new Map<string, typeof reconciliationCases>()
  for (const reconciliationCase of reconciliationCases) {
    const cases = reconciliationCasesByAttempt.get(reconciliationCase.payment_attempt_id) ?? []
    cases.push(reconciliationCase)
    reconciliationCasesByAttempt.set(reconciliationCase.payment_attempt_id, cases)
  }
  const payments = {
    needsReconciliation: paymentAttempts.some(attempt =>
      attempt.status === 'late_succeeded' || attempt.status === 'reconciliation_required'
      || (reconciliationCasesByAttempt.get(attempt.id) ?? []).some(reconciliationCase => reconciliationCase.state === 'open')
      || (providerEventsByAttempt.get(attempt.id) ?? []).some(event =>
        event.verification === 'unverified' || event.disposition === 'reconciliation_required'
          || event.disposition === 'unknown')),
    attempts: paymentAttempts.map(attempt => ({
      id: attempt.id,
      providerType: attempt.provider_type_snapshot ?? 'zpay_epay_v1',
      paymentMethod: attempt.payment_method_snapshot,
      channelName: attempt.payment_channel_name_snapshot,
      merchantOrderNo: attempt.merchant_order_no,
      status: attempt.status,
      providerState: attempt.provider_state,
      providerOrderId: attempt.provider_order_id,
      providerErrorCode: attempt.provider_error_code,
      expectedAmount: attempt.amount,
      actualAmount: attempt.actual_amount,
      providerTransactionId: attempt.provider_transaction_id,
      receiptDisposition: attempt.receipt_disposition as AdminOrderDetail['payments']['attempts'][number]['receiptDisposition'],
      createdAt: attempt.created_at.toISOString(),
      expiresAt: attempt.expires_at?.toISOString() ?? null,
      completedAt: attempt.completed_at?.toISOString() ?? null,
      reconciliationOpen: (reconciliationCasesByAttempt.get(attempt.id) ?? []).some(reconciliationCase => reconciliationCase.state === 'open'),
      reconciliationCases: (reconciliationCasesByAttempt.get(attempt.id) ?? []).map(reconciliationCase => ({
        id: reconciliationCase.id,
        reason: reconciliationCase.reason,
        state: reconciliationCase.state,
        openedAt: reconciliationCase.opened_at.toISOString(),
        resolvedAt: reconciliationCase.resolved_at?.toISOString() ?? null,
        resolvedByAdminId: reconciliationCase.resolved_by_admin_id,
        resolutionQueryEventSha256: reconciliationCase.resolution_query_event_sha256?.trim() ?? null,
        resolutionProviderTransactionId: reconciliationCase.resolution_provider_transaction_id,
        resolutionPaymentMethod: reconciliationCase.resolution_payment_method,
        resolutionConfirmedAmount: reconciliationCase.resolution_confirmed_amount,
      })),
      events: (providerEventsByAttempt.get(attempt.id) ?? []).map(event => ({
        id: event.id,
        source: event.source,
        verification: event.verification,
        disposition: event.disposition,
        providerStatus: event.provider_status,
        providerTransactionId: event.provider_transaction_id,
        reportedAmount: event.reported_amount,
        providerTimeText: event.provider_time_text,
        errorCode: event.error_code,
        eventSha256: event.event_sha256.trim(),
        receivedAt: event.received_at.toISOString(),
      })),
    })),
  }
  return {
    order: detail,
    owner: {
      type: row.customer_id ? 'customer' : 'guest',
      customerId: row.customer_id,
      customerUsername: row.customer_username,
      guestSessionId: row.guest_order_session_id,
    },
    inventory: inventoryRows.rows.map(item => ({
      orderItemId: item.order_item_id,
      reservationId: item.reservation_id,
      reservedQuantity: Number(item.reserved_quantity),
      events: (item.events ?? []).map(event => ({
        action: event.action,
        quantity: event.quantity,
        createdAt: new Date(event.createdAt).toISOString(),
      })),
    })),
    fulfillmentAttempts: attempts.map(attempt => ({
      id: attempt.id,
      orderItemId: attempt.order_item_id,
      administratorId: attempt.started_by_admin_id,
      quantity: attempt.quantity,
      status: attempt.status,
      deliverySource: attempt.delivery_source,
      failureCode: attempt.failure_code as AdminOrderDetail['fulfillmentAttempts'][number]['failureCode'],
      retryAfter: attempt.retry_after?.toISOString() ?? null,
      resultSha256: attempt.result_sha256,
      createdAt: attempt.created_at.toISOString(),
      completedAt: attempt.completed_at?.toISOString() ?? null,
      deliveryCount: deliveryCounts.get(attempt.id) ?? 0,
    })),
    supplierOperations: supplierOperationRows.rows.map(operation => ({
      id: operation.id,
      fulfillmentAttemptId: operation.fulfillment_attempt_id,
      operationId: operation.operation_id,
      unitIndex: operation.unit_index,
      supplierConnectionId: operation.supplier_connection_id,
      supplierName: operation.supplier_name,
      supplierProductId: operation.supplier_product_id,
      idempotencyKey: operation.idempotency_key,
      providerOperationId: operation.provider_operation_id,
      state: operation.state,
      createAttemptCount: operation.create_attempt_count,
      queryAttemptCount: operation.query_attempt_count,
      lastHttpStatus: operation.last_http_status,
      lastErrorCode: operation.last_error_code,
      lastFailureClass: operation.last_failure_class,
      lastProviderStatus: operation.last_provider_status,
      nextActionAt: operation.next_action_at?.toISOString() ?? null,
      createRequestedAt: operation.create_requested_at?.toISOString() ?? null,
      lastQueryAt: operation.last_query_at?.toISOString() ?? null,
      createdAt: operation.created_at.toISOString(),
      completedAt: operation.completed_at?.toISOString() ?? null,
      events: operation.events.map(event => ({
        ...event,
        createdAt: new Date(event.createdAt).toISOString(),
        responseSha256: event.responseSha256?.trim() ?? null,
      })),
    })),
    payments,
  }
}

export function registerOrderRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const optionalCustomerAuth = optionalCustomer(db, config)
  const requireCustomerAuth = requireCustomer(db, config)
  const customerCsrf = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)
  const requireAdministrator = requireAdmin(db, config)
  const adminCsrf = verifyAdminCsrf(config)
  const purchaseOrderStorage = new PurchaseOrderAttachmentStorage(config.privateFileRoot)

  const CustomerPurchaseAttachmentParamsSchema = Type.Object({
    id: Type.String({ format: 'uuid' }), itemId: Type.String({ format: 'uuid' }),
    attachmentId: Type.String({ format: 'uuid' }),
  }, { additionalProperties: false })
  const sendPurchaseAttachment = (reply: FastifyReply, image: { bytes: Buffer; mimeType: string; byteSize: number }) => {
    reply.header('cache-control', 'private, no-store')
    reply.header('content-type', image.mimeType)
    reply.header('content-length', String(image.byteSize))
    reply.header('content-disposition', 'inline; filename="purchase-image.webp"')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('content-security-policy', "default-src 'none'; sandbox")
    return reply.send(image.bytes)
  }

  app.get('/api/v1/customer/orders/:id/items/:itemId/purchase-attachments/:attachmentId', {
    preHandler: requireCustomerAuth,
    schema: { tags: ['customer'], summary: 'Read an archived purchase image for an owned customer order',
      params: CustomerPurchaseAttachmentParamsSchema,
      response: { 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id, itemId, attachmentId } = request.params as { id: string; itemId: string; attachmentId: string }
      const image = await readOwnedOrderPurchaseAttachment(db, purchaseOrderStorage,
        { kind: 'customer', customer: request.customer! }, itemId, attachmentId, id)
      return sendPurchaseAttachment(reply, image)
    } catch (error) { return handleOrderError(error, reply, request.id) }
  })

  app.get('/api/v1/guest/orders/:id/items/:itemId/purchase-attachments/:attachmentId', {
    preHandler: optionalCustomerAuth,
    schema: { tags: ['customer'], summary: 'Read an archived purchase image for the current guest order session',
      params: CustomerPurchaseAttachmentParamsSchema,
      response: { 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      if (request.customer) throw new OrderError(403, 'CUSTOMER_SESSION_ACTIVE', '登录顾客与游客订单会话不能混用。')
      const { id, itemId, attachmentId } = request.params as { id: string; itemId: string; attachmentId: string }
      const token = request.cookies[guestSessionCookie]
      const image = await readOwnedOrderPurchaseAttachment(db, purchaseOrderStorage,
        { kind: 'guest', guestSessionToken: token ?? '' }, itemId, attachmentId, id)
      return sendPurchaseAttachment(reply, image)
    } catch (error) { return handleOrderError(error, reply, request.id) }
  })

  app.get('/api/v1/admin/orders/:id/items/:itemId/purchase-attachments/:attachmentId', {
    preHandler: requireAdministrator,
    schema: { tags: ['admin'], summary: 'Read an archived purchase image for an administrator-authorized order',
      params: CustomerPurchaseAttachmentParamsSchema,
      response: { 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id, itemId, attachmentId } = request.params as { id: string; itemId: string; attachmentId: string }
      const image = await readAdminOrderPurchaseAttachment(db, purchaseOrderStorage, id, itemId, attachmentId)
      return sendPurchaseAttachment(reply, image)
    } catch (error) { return handleOrderError(error, reply, request.id) }
  })

  app.post('/api/v1/guest/session', {
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Create or resume the secure guest order session',
      response: {
        200: ApiSuccessSchemaOf(GuestOrderSessionSchema), 201: ApiSuccessSchemaOf(GuestOrderSessionSchema),
        401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      if (request.customer) throw new OrderError(409, 'CUSTOMER_SESSION_ACTIVE', '登录顾客请使用自己的订单账户。')
      const currentToken = request.cookies[guestSessionCookie]
      if (currentToken && /^[A-Za-z0-9_-]{43}$/u.test(currentToken)) {
        const existing = await db.selectFrom('guest_order_sessions').select(['id', 'expires_at'])
          .where('token_hash', '=', hashToken(currentToken))
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', new Date())
          .executeTakeFirst()
        if (existing) {
          reply.header('cache-control', 'no-store')
          return success({ sessionId: existing.id, expiresAt: existing.expires_at.toISOString() }, request.id)
        }
      }
      const token = createOpaqueToken()
      const sessionId = randomUUID()
      const expiresAt = new Date(Date.now() + guestSessionTtlSeconds * 1000)
      await db.insertInto('guest_order_sessions').values({
        id: sessionId, token_hash: hashToken(token), expires_at: expiresAt, revoked_at: null,
      }).execute()
      setGuestSessionCookie(reply, token, config)
      reply.header('cache-control', 'no-store')
      return reply.code(201).send(success({ sessionId, expiresAt: expiresAt.toISOString() }, request.id))
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.post('/api/v1/checkout/orders', {
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Create an order from a fresh locked checkout quote',
      body: CreateOrderBodySchema,
      headers: CreateOrderHeadersSchema,
      response: {
        200: ApiSuccessSchemaOf(CreateOrderResultSchema),
        201: ApiSuccessSchemaOf(CreateOrderResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema,
        409: CheckoutOrderErrorSchema, 422: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const result = await createOrderWithRetry(
        db,
        request.body as CreateOrderBody,
        request.customer,
        request.customer ? undefined : request.cookies[guestSessionCookie],
        config,
        request.headers['x-aikayun-guest-session-id'] as string | undefined,
      )
      reply.header('cache-control', 'no-store')
      return reply.code(result.created ? 201 : 200).send(success(result, request.id))
    } catch (error) {
      if (error instanceof CheckoutConflict) return orderConflict(reply, request.id, error)
      return handleOrderError(error, reply, request.id)
    }
  })

  app.get('/api/v1/customer/orders', {
    preHandler: requireCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'List the signed-in customer orders with server-side pagination',
      querystring: OrderListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(OrderPageSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const customer = request.customer!
      const query = request.query as { page?: number; pageSize?: number }
      const page = query.page ?? 1
      const pageSize = Math.min(query.pageSize ?? defaultPageSize, maxPageSize)
      const result = await db.transaction().execute(async (trx) => {
        await assertCustomerSession(trx, customer)
        return orderPage(trx, 'customer', customer.id, page, pageSize)
      })
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.get('/api/v1/customer/orders/:id', {
    preHandler: requireCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'Read a customer-owned order and its private completed deliveries',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(OrderDetailSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const detail = await db.transaction().execute(async (trx) => {
        await assertCustomerSession(trx, request.customer!)
        return getOwnedOrder(trx, params.id, 'customer', request.customer!.id, config)
      })
      if (!detail) return reply.code(404).send(failure('ORDER_NOT_FOUND', '找不到属于当前顾客账户的订单。', request.id))
      reply.header('cache-control', 'no-store')
      return success(detail, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.post('/api/v1/customer/orders/:id/cancel', {
    preHandler: [requireCustomerAuth, customerCsrf],
    schema: {
      tags: ['customer'], summary: 'Cancel an eligible unpaid customer order and release its inventory reservations',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(OrderDetailSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const customer = request.customer!
      const params = request.params as { id: string }
      const detail = await db.transaction().execute(async (trx) => {
        await lockCustomerForOrderMutation(trx, customer)
        return cancelOwnedOrderInTransaction(trx, params.id, 'customer', customer.id, config)
      })
      reply.header('cache-control', 'no-store')
      return success(detail, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.get('/api/v1/guest/orders', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'List orders for the current secure guest order session',
      querystring: OrderListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(OrderPageSchema), 401: ApiErrorSchema, 403: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (request.customer) throw new OrderError(403, 'CUSTOMER_SESSION_ACTIVE', '登录顾客与游客订单会话不能混用。')
      const query = request.query as { page?: number; pageSize?: number }
      const result = await db.transaction().execute(async (trx) => {
        const sessionId = await assertGuestSession(trx, request.cookies[guestSessionCookie])
        return orderPage(trx, 'guest', sessionId, query.page ?? 1, Math.min(query.pageSize ?? defaultPageSize, maxPageSize))
      })
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.get('/api/v1/guest/orders/:id', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'Read a guest order only through its current secure guest session',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(OrderDetailSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (request.customer) throw new OrderError(403, 'CUSTOMER_SESSION_ACTIVE', '登录顾客与游客订单会话不能混用。')
      const params = request.params as { id: string }
      const detail = await db.transaction().execute(async (trx) => {
        const sessionId = await assertGuestSession(trx, request.cookies[guestSessionCookie])
        return getOwnedOrder(trx, params.id, 'guest', sessionId, config)
      })
      if (!detail) return reply.code(404).send(failure('ORDER_NOT_FOUND', '找不到属于当前游客会话的订单。', request.id))
      reply.header('cache-control', 'no-store')
      return success(detail, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.post('/api/v1/guest/orders/:id/cancel', {
    preHandler: [optionalCustomerAuth, customerCsrf],
    schema: {
      tags: ['customer'], summary: 'Cancel an eligible unpaid guest order and release its inventory reservations',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(OrderDetailSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      if (request.customer) throw new OrderError(403, 'CUSTOMER_SESSION_ACTIVE', '登录顾客与游客订单会话不能混用。')
      const params = request.params as { id: string }
      const detail = await db.transaction().execute(async (trx) => {
        const sessionId = await assertGuestSession(trx, request.cookies[guestSessionCookie])
        return cancelOwnedOrderInTransaction(trx, params.id, 'guest', sessionId, config)
      })
      reply.header('cache-control', 'no-store')
      return success(detail, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.get('/api/v1/admin/orders', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin'], summary: 'List orders and ownership with server-side pagination',
      querystring: AdminOrderListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderPageSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const query = request.query as { page?: number; pageSize?: number; status?: 'pending_payment' | 'processing' | 'completed' | 'closed' | 'all' }
    const result = await adminOrderPage(db, query)
    reply.header('cache-control', 'no-store')
    return success(result, request.id)
  })

  app.get('/api/v1/admin/orders/:id', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin'], summary: 'Read an order snapshot, ownership, inventory events, fulfillment and status audit',
      params: OrderIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(AdminOrderDetailSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string }
    try {
      const detail = await adminOrderDetail(db, params.id, config)
      if (!detail) return reply.code(404).send(failure('ORDER_NOT_FOUND', '订单不存在。', request.id))
      reply.header('cache-control', 'no-store')
      return success(detail, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.post('/api/v1/admin/orders/:id/supplier-operations/:operationId/query', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Queue a safe supplier status query or finalize a previously stored success result',
      params: { type: 'object', required: ['id', 'operationId'], additionalProperties: false, properties: {
        id: { type: 'string', format: 'uuid' }, operationId: { type: 'string', format: 'uuid' },
      } },
      response: { 200: ApiSuccessSchemaOf(SupplierOperationAdminActionResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; operationId: string }
      await db.transaction().execute(async (trx) => {
        const order = await trx.selectFrom('orders').select(['id', 'status'])
          .where('id', '=', params.id).forUpdate().executeTakeFirst()
        if (!order) throw new OrderError(404, 'ORDER_NOT_FOUND', '订单不存在。')
        const identity = await trx.selectFrom('supplier_api_delivery_operations as operation')
          .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'operation.fulfillment_attempt_id')
          .innerJoin('order_items as item', 'item.id', 'attempt.order_item_id')
          .select(['item.id as item_id', 'item.product_id', 'item.product_variant_id', 'item.inventory_mode_snapshot',
            'operation.fulfillment_attempt_id'])
          .where('operation.id', '=', params.operationId).where('item.order_id', '=', params.id).executeTakeFirst()
        if (!identity) throw new OrderError(404, 'SUPPLIER_OPERATION_NOT_FOUND', '此订单没有该供应商操作。')
        await trx.selectFrom('order_items').select('id').where('id', '=', identity.item_id).forUpdate().executeTakeFirst()
        await trx.selectFrom('products').select('id').where('id', '=', identity.product_id).forShare().executeTakeFirst()
        await trx.selectFrom('product_variants').select('id').where('id', '=', identity.product_variant_id).forUpdate().executeTakeFirst()
        if (identity.inventory_mode_snapshot === 'quantity') {
          await trx.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
            .where('product_variant_id', '=', identity.product_variant_id).forUpdate().executeTakeFirst()
        }
        await trx.selectFrom('product_variant_fulfillment').select('product_variant_id')
          .where('product_variant_id', '=', identity.product_variant_id).forShare().executeTakeFirst()
        const operation = await trx.selectFrom('supplier_api_delivery_operations').selectAll()
          .where('id', '=', params.operationId).forUpdate().executeTakeFirstOrThrow()
        if (operation.state === 'succeeded' || operation.state === 'failed'
          || operation.state === 'create_in_flight' || operation.state === 'query_in_flight') {
          throw new OrderError(409, 'SUPPLIER_OPERATION_NOT_QUERYABLE', '该操作已结束或正在执行，当前不能手动查单。')
        }
        if (operation.result_ciphertext && operation.state !== 'succeeded_pending_finalize') {
          throw new OrderError(409, 'SUPPLIER_RESULT_REQUIRES_REVIEW', '此操作已有供应商成功结果，需要人工核对；系统不会覆盖或伪造交付。')
        }
        const nextState = operation.state === 'succeeded_pending_finalize' ? 'succeeded_pending_finalize' : 'query_pending'
        await trx.updateTable('supplier_api_delivery_operations').set({
          state: nextState, next_action_at: new Date(), lease_token: null, lease_expires_at: null,
        }).where('id', '=', operation.id).execute()
        await trx.insertInto('supplier_api_delivery_events').values({
          id: randomUUID(), operation_id: operation.id,
          event_type: 'manual_query_requested', http_status: null,
          classification: nextState === 'query_pending' ? 'admin_requested' : 'finalize_saved_result',
          provider_status: operation.last_provider_status,
          provider_operation_id: operation.provider_operation_id, error_code: null,
          response_sha256: null, details: { administratorId: request.admin!.id },
        }).execute()
        await trx.insertInto('supplier_api_operations_admin_audit').values({
          id: randomUUID(), operation_id: operation.id, administrator_id: request.admin!.id,
          action: 'query_requested', details: { queuedState: nextState },
        }).execute()
      })
      const detail = await adminOrderDetail(db, params.id, config)
      const operation = detail?.supplierOperations.find(row => row.id === params.operationId)
      if (!operation) throw new OrderError(404, 'SUPPLIER_OPERATION_NOT_FOUND', '此订单没有该供应商操作。')
      reply.header('cache-control', 'private, no-store')
      return success({ operation }, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.post('/api/v1/admin/orders/:id/supplier-operations/:operationId/retry', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Retry only a supplier operation explicitly rejected without delivery',
      params: { type: 'object', required: ['id', 'operationId'], additionalProperties: false, properties: {
        id: { type: 'string', format: 'uuid' }, operationId: { type: 'string', format: 'uuid' },
      } },
      response: { 200: ApiSuccessSchemaOf(SupplierOperationAdminActionResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; operationId: string }
      await db.transaction().execute(async (trx) => {
        const order = await trx.selectFrom('orders').select(['id', 'status'])
          .where('id', '=', params.id).forUpdate().executeTakeFirst()
        if (!order) throw new OrderError(404, 'ORDER_NOT_FOUND', '订单不存在。')
        if (order.status !== 'processing') throw new OrderError(409, 'ORDER_FULFILLMENT_REQUIRES_PROCESSING', '只有仍在 processing 的订单可以恢复供应商拒绝操作。')
        const identity = await trx.selectFrom('supplier_api_delivery_operations as operation')
          .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'operation.fulfillment_attempt_id')
          .innerJoin('order_items as item', 'item.id', 'attempt.order_item_id')
          .select(['item.id as item_id', 'item.product_id', 'item.product_variant_id', 'item.inventory_mode_snapshot', 'attempt.id as attempt_id'])
          .where('operation.id', '=', params.operationId).where('item.order_id', '=', params.id).executeTakeFirst()
        if (!identity) throw new OrderError(404, 'SUPPLIER_OPERATION_NOT_FOUND', '此订单没有该供应商操作。')
        await trx.selectFrom('order_items').select('id').where('id', '=', identity.item_id).forUpdate().executeTakeFirst()
        await trx.selectFrom('products').select('id').where('id', '=', identity.product_id).forShare().executeTakeFirst()
        await trx.selectFrom('product_variants').select('id').where('id', '=', identity.product_variant_id).forUpdate().executeTakeFirst()
        if (identity.inventory_mode_snapshot === 'quantity') {
          await trx.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
            .where('product_variant_id', '=', identity.product_variant_id).forUpdate().executeTakeFirst()
        }
        await trx.selectFrom('product_variant_fulfillment').select('product_variant_id')
          .where('product_variant_id', '=', identity.product_variant_id).forShare().executeTakeFirst()
        const operation = await trx.selectFrom('supplier_api_delivery_operations').selectAll()
          .where('id', '=', params.operationId).forUpdate().executeTakeFirstOrThrow()
        const attempt = await trx.selectFrom('order_item_fulfillment_attempts').select(['id', 'status', 'retry_after'])
          .where('id', '=', identity.attempt_id).forUpdate().executeTakeFirstOrThrow()
        if (operation.state !== 'failed' || operation.last_failure_class !== 'supplier_rejected' || attempt.status !== 'failed') {
          throw new OrderError(409, 'SUPPLIER_RETRY_REQUIRES_CONFIRMED_REJECTION', '只有供应商明确拒绝且确认未发货的操作可重试。')
        }
        if (attempt.retry_after !== null) return
        const consumed = await trx.selectFrom('supplier_api_delivery_events').select('id')
          .where('operation_id', '=', operation.id).where('event_type', '=', 'manual_retry_requested').executeTakeFirst()
        if (consumed) throw new OrderError(409, 'SUPPLIER_OPERATION_REPLACED', '此操作的重试已生成后续操作，请核对最新单位操作。')
        await trx.updateTable('order_item_fulfillment_attempts').set({ retry_after: new Date() })
          .where('id', '=', attempt.id).execute()
        await trx.insertInto('supplier_api_delivery_events').values({
          id: randomUUID(), operation_id: operation.id, event_type: 'manual_retry_requested',
          http_status: null, classification: 'admin_requested', provider_status: 'rejected',
          provider_operation_id: operation.provider_operation_id, error_code: 'confirmed_no_delivery',
          response_sha256: null, details: { administratorId: request.admin!.id },
        }).execute()
        await trx.insertInto('supplier_api_operations_admin_audit').values({
          id: randomUUID(), operation_id: operation.id, administrator_id: request.admin!.id,
          action: 'retry_requested', details: { retryAfter: new Date().toISOString(), reason: 'confirmed_supplier_rejection' },
        }).execute()
      })
      const detail = await adminOrderDetail(db, params.id, config)
      const operation = detail?.supplierOperations.find(row => row.id === params.operationId)
      if (!operation) throw new OrderError(404, 'SUPPLIER_OPERATION_NOT_FOUND', '此订单没有该供应商操作。')
      reply.header('cache-control', 'private, no-store')
      return success({ operation }, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.post('/api/v1/admin/orders/:id/items/:itemId/fulfillments', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Record actual manual digital delivery for a processing order',
      params: AdminOrderItemParamsSchema,
      body: ManualFulfillmentDeliveryBodySchema,
      response: { 200: ApiSuccessSchemaOf(ManualFulfillmentResultSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; itemId: string }
      const body = request.body as ManualFulfillmentDeliveryBody
      const adminId = request.admin!.id
      const resultHash = createHash('sha256').update(JSON.stringify(body.deliveries.map(delivery => delivery.content))).digest('hex')
      const result = await db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'fulfillment:' + body.operationId}, 0))`.execute(trx)
        const existing = await trx.selectFrom('order_item_fulfillment_attempts')
          .select(['id', 'order_item_id', 'status', 'result_sha256'])
          .where('operation_id', '=', body.operationId)
          .executeTakeFirst()
        if (existing) {
          const item = await trx.selectFrom('order_items').select(['order_id'])
            .where('id', '=', existing.order_item_id).executeTakeFirst()
          if (item?.order_id !== params.id || existing.order_item_id !== params.itemId
            || existing.status !== 'succeeded' || existing.result_sha256 !== resultHash) {
            throw new OrderError(409, 'FULFILLMENT_OPERATION_CONFLICT', '此履约操作标识已用于不同的订单、数量或交付内容。')
          }
          const order = await loadOrderDetail(trx, params.id, config)
          if (!order) throw new OrderError(404, 'ORDER_NOT_FOUND', '订单不存在。')
          return { repeated: true, order }
        }

        const order = await trx.selectFrom('orders').select(['id', 'status', 'total_amount'])
          .where('id', '=', params.id).forUpdate().executeTakeFirst()
        if (!order) throw new OrderError(404, 'ORDER_NOT_FOUND', '订单不存在。')
        if (order.status !== 'processing') {
          throw new OrderError(409, 'ORDER_FULFILLMENT_REQUIRES_PROCESSING', '只有零元订单或已确认付款的 processing 订单可以履约。')
        }
        const openPaymentCase = await trx.selectFrom('payment_provider_reconciliation_cases as reconciliation')
          .innerJoin('payment_attempts as payment_attempt', 'payment_attempt.id', 'reconciliation.payment_attempt_id')
          .select('reconciliation.id').where('payment_attempt.order_id', '=', params.id)
          .where('reconciliation.state', '=', 'open').limit(1).executeTakeFirst()
        if (openPaymentCase) {
          throw new OrderError(409, 'ORDER_PAYMENT_RECONCILIATION_OPEN', '订单存在尚未解决的服务商资金冲突，核验完成前不能进行人工交付。')
        }
        const item = await trx.selectFrom('order_items')
          .select(['id', 'order_id', 'quantity', 'fulfilled_quantity', 'fulfillment_reserved_quantity', 'fulfillment_method_snapshot'])
          .where('id', '=', params.itemId)
          .where('order_id', '=', params.id)
          .forUpdate()
          .executeTakeFirst()
        if (!item) throw new OrderError(404, 'ORDER_ITEM_NOT_FOUND', '订单中不存在此商品项。')
        if (item.fulfillment_method_snapshot !== 'manual') {
          throw new OrderError(409, 'FULFILLMENT_METHOD_NOT_READY', '此订单项没有已实现的人工交付能力。')
        }
        if (body.deliveries.length > item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity) {
          throw new OrderError(409, 'FULFILLMENT_QUANTITY_EXCEEDED', '交付数量超过此订单项的未完成数量。')
        }

        const attemptId = randomUUID()
        await trx.insertInto('order_item_fulfillment_attempts').values({
          id: attemptId,
          order_item_id: item.id,
          operation_id: body.operationId,
          quantity: body.deliveries.length,
          started_by_admin_id: adminId,
          status: 'processing',
          result_sha256: null,
          completed_at: null,
        }).execute()
        for (let index = 0; index < body.deliveries.length; index += 1) {
          const content = body.deliveries[index]!.content
          await trx.insertInto('order_item_fulfillment_deliveries').values({
            id: randomUUID(),
            fulfillment_attempt_id: attemptId,
            started_by_admin_id: adminId,
            unit_index: item.fulfilled_quantity + index + 1,
            content,
            content_sha256: createHash('sha256').update(content).digest('hex'),
          }).execute()
        }
        await trx.updateTable('order_item_fulfillment_attempts')
          .set({ status: 'succeeded', result_sha256: resultHash })
          .where('id', '=', attemptId)
          .execute()
        const detail = await loadOrderDetail(trx, params.id, config)
        if (!detail) throw new Error('Fulfilled order could not be loaded')
        return { repeated: false, order: detail }
      })
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })

  app.get('/api/v1/admin/products/:id/manual-fulfillment', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin'], summary: 'Read explicit manual delivery readiness for product SKUs',
      params: AdminProductIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(ManualFulfillmentConfigPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string }
    const product = await db.selectFrom('products').select(['id', 'product_type'])
      .where('id', '=', params.id).executeTakeFirst()
    if (!product) return reply.code(404).send(failure('PRODUCT_NOT_FOUND', '商品不存在。', request.id))
    const variants = await db.selectFrom('product_variants as variant')
      .leftJoin('product_variant_fulfillment as fulfillment', 'fulfillment.product_variant_id', 'variant.id')
      .leftJoin('product_variant_fulfillment_versions as version', 'version.id', 'fulfillment.current_content_version_id')
      .leftJoin('supplier_connection_versions as supplier_version', 'supplier_version.id', 'version.supplier_connection_version_id')
      .leftJoin('supplier_connections as supplier_connection', 'supplier_connection.id', 'supplier_version.supplier_connection_id')
      .select([
        'variant.id as sku_id', 'fulfillment.method', 'fulfillment.manual_delivery_ready',
        'fulfillment.code_pool_delivery_ready', 'fulfillment.automatic_delivery_ready',
        'fulfillment.configuration_revision', 'version.version_number', 'fulfillment.updated_at',
        sql<boolean>`COALESCE(supplier_connection.enabled
          AND supplier_connection.current_version_id = supplier_version.id
          AND supplier_connection.tested_version_id = supplier_version.id, false)`.as('supplier_connection_available'),
      ])
      .where('variant.product_id', '=', product.id)
      .orderBy('variant.id')
      .execute()
    reply.header('cache-control', 'no-store')
    return success(variants.map(variant => ({
      productId: product.id,
      skuId: variant.sku_id,
      productType: product.product_type,
      method: variant.method,
      enabled: variant.method === 'manual' && variant.manual_delivery_ready === true && product.product_type === 'digital',
      codePoolDeliveryReady: variant.method === 'code_pool' && variant.code_pool_delivery_ready === true,
      automaticDeliveryReady: variant.method === 'fixed_content' || variant.method === 'link' || variant.method === 'file'
        ? variant.automatic_delivery_ready === true
        : variant.method === 'api'
          ? variant.automatic_delivery_ready === true && variant.supplier_connection_available
        : false,
      configurationRevision: variant.configuration_revision ?? 0,
      currentVersionNumber: variant.version_number ?? null,
      updatedAt: variant.updated_at?.toISOString() ?? null,
    })), request.id)
  })

  app.put('/api/v1/admin/products/:id/variants/:variantId/manual-fulfillment', {
    preHandler: [requireAdministrator, adminCsrf],
    schema: {
      tags: ['admin'], summary: 'Explicitly enable or disable manual digital fulfillment for one SKU',
      params: AdminProductVariantParamsSchema,
      body: UpdateManualFulfillmentBodySchema,
      response: { 200: ApiSuccessSchemaOf(ManualFulfillmentConfigSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; variantId: string }
      const body = request.body as UpdateManualFulfillmentBody
      const result = await db.transaction().execute(async (trx) => {
        const product = await trx.selectFrom('products').select(['id', 'product_type'])
          .where('id', '=', params.id).forUpdate().executeTakeFirst()
        if (!product) throw new OrderError(404, 'PRODUCT_NOT_FOUND', '商品不存在。')
        const variant = await trx.selectFrom('product_variants')
          .select(['id', 'enabled', 'retired_at', 'inventory_mode'])
          .where('product_id', '=', product.id).where('id', '=', params.variantId)
          .forUpdate().executeTakeFirst()
        if (!variant) throw new OrderError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
        if (body.enabled && (product.product_type !== 'digital' || !variant.enabled || variant.retired_at
          || (variant.inventory_mode !== 'quantity' && variant.inventory_mode !== 'unlimited'))) {
          throw new OrderError(409, 'MANUAL_FULFILLMENT_SKU_UNSUITABLE', '只有启用且未退役、库存模式为按数量或不限数量的数字商品 SKU 才能开启人工交付。')
        }
        const configured = await trx.selectFrom('product_variant_fulfillment')
          .select(['product_variant_id', 'method'])
          .where('product_variant_id', '=', variant.id)
          .forUpdate()
          .executeTakeFirst()
        if (configured?.method === 'code_pool') {
          throw new OrderError(409, 'CODE_POOL_METHOD_ACTIVE', '此 SKU 正在使用卡密池履约，不能切换为人工发货。请先暂停新销售并处理卡密池历史。')
        }
        if (configured) {
          await trx.updateTable('product_variant_fulfillment').set({
            method: 'manual',
            manual_delivery_ready: body.enabled,
            code_pool_delivery_ready: false,
            automatic_delivery_ready: false,
            current_content_version_id: null,
            updated_at: new Date(),
          }).where('product_variant_id', '=', variant.id).execute()
        } else {
          await trx.insertInto('product_variant_fulfillment').values({
            product_variant_id: variant.id,
            method: 'manual',
            manual_delivery_ready: body.enabled,
            code_pool_delivery_ready: false,
          }).execute()
        }
        const saved = await trx.selectFrom('product_variant_fulfillment')
          .leftJoin('product_variant_fulfillment_versions as version', 'version.id', 'product_variant_fulfillment.current_content_version_id')
          .select([
            'product_variant_fulfillment.method', 'product_variant_fulfillment.manual_delivery_ready',
            'product_variant_fulfillment.code_pool_delivery_ready', 'product_variant_fulfillment.automatic_delivery_ready',
            'product_variant_fulfillment.configuration_revision', 'version.version_number', 'product_variant_fulfillment.updated_at',
          ])
          .where('product_variant_fulfillment.product_variant_id', '=', variant.id).executeTakeFirstOrThrow()
        return {
          productId: product.id,
          skuId: variant.id,
          productType: product.product_type,
          method: saved.method,
          enabled: saved.method === 'manual' && saved.manual_delivery_ready && product.product_type === 'digital',
          codePoolDeliveryReady: saved.method === 'code_pool' && saved.code_pool_delivery_ready,
          automaticDeliveryReady: (saved.method === 'fixed_content' || saved.method === 'link' || saved.method === 'file' || saved.method === 'api') && saved.automatic_delivery_ready,
          configurationRevision: saved.configuration_revision,
          currentVersionNumber: saved.version_number ?? null,
          updatedAt: saved.updated_at.toISOString(),
        }
      })
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) {
      return handleOrderError(error, reply, request.id)
    }
  })
}

async function cancelOwnedOrderInTransaction(
  trx: Transaction<Database>,
  orderId: string,
  ownerType: 'customer' | 'guest',
  ownerId: string,
  config: AppConfig,
): Promise<OrderDetail> {
  const order = await trx.selectFrom('orders').select(['id', 'status'])
  const owned = ownerType === 'customer'
    ? await order.where('customer_id', '=', ownerId).where('id', '=', orderId).forUpdate().executeTakeFirst()
    : await order.where('guest_order_session_id', '=', ownerId).where('id', '=', orderId).forUpdate().executeTakeFirst()
  if (!owned) throw new OrderError(404, 'ORDER_NOT_FOUND', '找不到属于当前账户或游客会话的订单。')
  if (owned.status === 'closed') {
    const detail = await loadOrderDetail(trx, orderId, config)
    if (!detail) throw new Error('Closed order could not be loaded')
    return detail
  }
  if (owned.status !== 'pending_payment') {
    throw new OrderError(409, 'ORDER_NOT_CANCELLABLE', '只有仍在待付款且没有资金或履约义务的订单可以取消。')
  }
  await closeOrderAndReleaseInventory(trx, orderId)
  const detail = await loadOrderDetail(trx, orderId, config)
  if (!detail) throw new Error('Cancelled order could not be loaded')
  return detail
}
