import { createHash, randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { settleAmount } from '@aikayun/money'
import { PrivateFileError, PrivateFileStorage } from '../media/private-file-storage.js'
import {
  CodePoolDecryptionError,
  CodePoolKeyUnavailableError,
  codePoolFingerprints,
  codePoolContentDigest,
  decryptCodePoolContent,
  encryptCodePoolContent,
  requiredCodePoolKeyRing,
} from './code-pool-crypto.js'
import {
  decryptFixedDeliveryPayload,
  encryptFixedDeliveryPayload,
  fixedDeliveryPayloadDigest,
  FixedDeliveryDecryptionError,
  FixedDeliveryKeyUnavailableError,
  fixedDeliveryDeliveryContext,
  fixedDeliveryVersionContext,
  type FixedDeliveryMethod,
} from './fixed-delivery-crypto.js'
import {
  ApiDeliveryKeyUnavailableError,
  SupplierCredentialKeyUnavailableError,
  apiDeliveryResultDigest,
  decryptApiDeliveryResult,
  decryptSupplierBearerToken,
  encryptApiDeliveryResult,
} from './supplier-api-crypto.js'
import {
  createHttpJsonV1Delivery,
  HttpJsonV1Error,
  queryHttpJsonV1Delivery,
  type HttpJsonV1DeliveryRequest,
  type HttpJsonV1Outcome,
} from './http-json-v1.js'

const pollIntervalMs = 1_000
const batchSize = 20
const maxRetryDelayMs = 5 * 60_000
const supplierOperationLeaseMs = 30_000
const supplierOperationPollMs = 5_000

type Db = Kysely<Database> | Transaction<Database>
type FailureCode = 'CODE_POOL_DATA_INCONSISTENT' | 'CODE_POOL_KEY_UNAVAILABLE'
  | 'CODE_POOL_DECRYPTION_FAILED' | 'CODE_POOL_PAYMENT_UNRESOLVED'
  | 'FIXED_DELIVERY_DATA_INCONSISTENT' | 'FIXED_DELIVERY_KEY_UNAVAILABLE'
  | 'FIXED_DELIVERY_DECRYPTION_FAILED' | 'FIXED_DELIVERY_VERSION_UNAVAILABLE'
  | 'FIXED_DELIVERY_PAYMENT_UNRESOLVED'
  | 'FILE_DELIVERY_DATA_INCONSISTENT' | 'FILE_DELIVERY_OBJECT_UNAVAILABLE'
  | 'FILE_DELIVERY_INTEGRITY_FAILED' | 'FILE_DELIVERY_PAYMENT_UNRESOLVED'

interface Candidate { order_id: string; order_item_id: string }

interface DeliveryCode {
  id: string
  unitIndex: number
  encrypted: ReturnType<typeof encryptCodePoolContent>
  digest: string
}

function retryDelay(attemptNumber: number): number {
  return Math.min(maxRetryDelayMs, 1_000 * 2 ** Math.min(16, Math.max(0, attemptNumber - 1)))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function candidates(db: Db, now: Date): Promise<Candidate[]> {
  const result = await sql<Candidate>`
    SELECT item.order_id, item.id AS order_item_id
    FROM orders AS order_row
    JOIN order_items AS item ON item.order_id = order_row.id
    WHERE order_row.status = 'processing'
      AND item.fulfillment_method_snapshot IN ('code_pool', 'fixed_content', 'link', 'file', 'api')
      AND item.fulfilled_quantity + item.fulfillment_reserved_quantity < item.quantity
      AND NOT EXISTS (
        SELECT 1 FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = item.fulfillment_method_snapshot
          AND attempt.status IN ('processing', 'unknown')
      )
      AND (item.fulfillment_method_snapshot = 'api' OR COALESCE((
        SELECT attempt.retry_after FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = item.fulfillment_method_snapshot
          AND attempt.status = 'failed'
        ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
      ), '-infinity'::timestamptz) <= ${now})
      AND (item.fulfillment_method_snapshot <> 'api' OR NOT EXISTS (
        SELECT 1 FROM (
          SELECT attempt.retry_after FROM order_item_fulfillment_attempts AS attempt
          WHERE attempt.order_item_id = item.id AND attempt.delivery_source = 'api' AND attempt.status = 'failed'
          ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
        ) AS last_api_failure
        WHERE last_api_failure.retry_after IS NULL OR last_api_failure.retry_after > ${now}
      ))
    ORDER BY order_row.created_at, order_row.id, item.created_at, item.id
    LIMIT ${batchSize}
  `.execute(db)
  return result.rows
}

async function paymentAllowsDelivery(trx: Transaction<Database>, orderId: string, totalAmount: string): Promise<boolean> {
  const evidence = await sql<{ valid: boolean }>`
    SELECT NOT order_has_unresolved_payment_attempts(${orderId}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM payment_attempts AS attempt
        JOIN payment_provider_reconciliation_cases AS reconciliation
          ON reconciliation.payment_attempt_id = attempt.id
        WHERE attempt.order_id = ${orderId}::uuid AND reconciliation.state = 'open'
      )
      AND (${totalAmount}::numeric = 0 OR COALESCE((
        SELECT sum(receipt.amount)
        FROM payment_attempts AS attempt
        JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = attempt.id
        WHERE attempt.order_id = ${orderId}::uuid AND attempt.status = 'succeeded'
          AND receipt.disposition = 'on_time'
      ), 0) = ${totalAmount}::numeric) AS valid
  `.execute(trx)
  return evidence.rows[0]?.valid === true
}

async function recordUnexpectedFailure(
  db: Kysely<Database>,
  orderId: string,
  itemId: string,
  operationId: string,
): Promise<'failed' | 'delivered' | 'skipped'> {
  const committed = await db.selectFrom('order_item_fulfillment_attempts')
    .select('status').where('operation_id', '=', operationId).executeTakeFirst()
  if (committed) return committed.status === 'succeeded' ? 'delivered' : 'failed'

  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('orders').select(['id', 'status'])
      .where('id', '=', orderId).forUpdate().skipLocked().executeTakeFirst()
    if (!order || order.status !== 'processing') return 'skipped'
    const item = await trx.selectFrom('order_items')
      .select(['id', 'quantity', 'fulfilled_quantity', 'fulfillment_reserved_quantity', 'fulfillment_method_snapshot'])
      .where('id', '=', itemId).where('order_id', '=', orderId).forUpdate().executeTakeFirst()
    if (!item || !['code_pool', 'fixed_content', 'link', 'file'].includes(item.fulfillment_method_snapshot)) return 'skipped'
    const source = item.fulfillment_method_snapshot as 'code_pool' | 'fixed_content' | 'link' | 'file'
    const remaining = item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity
    if (remaining <= 0) return 'skipped'
    const active = await trx.selectFrom('order_item_fulfillment_attempts').select('id')
      .where('order_item_id', '=', item.id).where('delivery_source', '=', source)
      .where('status', 'in', ['processing', 'unknown']).executeTakeFirst()
    if (active) return 'skipped'
    const priorFailures = await trx.selectFrom('order_item_fulfillment_attempts')
      .select(sql<number>`count(*)::integer`.as('count'))
      .where('order_item_id', '=', item.id).where('delivery_source', '=', source)
      .where('status', '=', 'failed').executeTakeFirstOrThrow()
    const attemptId = randomUUID()
    await trx.insertInto('order_item_fulfillment_attempts').values({
      id: attemptId,
      order_item_id: item.id,
      operation_id: operationId,
      quantity: remaining,
      started_by_admin_id: null,
      delivery_source: source,
      status: 'processing',
      failure_code: null,
      retry_after: null,
      result_sha256: null,
      completed_at: null,
    }).execute()
    await trx.updateTable('order_item_fulfillment_attempts').set({
      status: 'failed',
      failure_code: source === 'code_pool' ? 'CODE_POOL_DATA_INCONSISTENT'
        : source === 'file' ? 'FILE_DELIVERY_DATA_INCONSISTENT' : 'FIXED_DELIVERY_DATA_INCONSISTENT',
      retry_after: new Date(Date.now() + retryDelay(Number(priorFailures.count) + 1)),
      completed_at: new Date(),
    }).where('id', '=', attemptId).execute()
    return 'failed'
  })
}

async function attemptCodePoolDelivery(
  db: Kysely<Database>,
  config: AppConfig,
  orderId: string,
  itemId: string,
): Promise<'delivered' | 'failed' | 'skipped'> {
  const operationId = randomUUID()
  try {
    return await db.transaction().execute(async (trx) => {
    // Serializes callbacks, cancellation and all other fulfillment runners for this order.
    const order = await trx.selectFrom('orders').select(['id', 'status', 'total_amount'])
      .where('id', '=', orderId).forUpdate().skipLocked().executeTakeFirst()
    if (!order || order.status !== 'processing') return 'skipped'
    const item = await trx.selectFrom('order_items')
      .select(['id', 'order_id', 'product_id', 'product_variant_id', 'quantity', 'fulfilled_quantity',
        'fulfillment_reserved_quantity', 'fulfillment_method_snapshot'])
      .where('id', '=', itemId).where('order_id', '=', orderId).forUpdate().executeTakeFirst()
    if (!item || item.fulfillment_method_snapshot !== 'code_pool') return 'skipped'
    const remaining = item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity
    if (remaining <= 0) return 'skipped'

    // Catalog/stock/config lock order matches checkout and administrative pool operations.
    await trx.selectFrom('products').select('id').where('id', '=', item.product_id).forShare().executeTakeFirst()
    const variant = await trx.selectFrom('product_variants')
      .select(['id', 'product_id', 'inventory_mode', 'enabled', 'retired_at'])
      .where('id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
    const inventory = await trx.selectFrom('product_variant_quantity_inventory')
      .select(['stocked', 'reserved']).where('product_variant_id', '=', item.product_variant_id)
      .forUpdate().executeTakeFirst()
    const fulfillment = await trx.selectFrom('product_variant_fulfillment')
      .select(['method', 'code_pool_delivery_ready']).where('product_variant_id', '=', item.product_variant_id)
      .forUpdate().executeTakeFirst()

    const reservedEntries = await trx.selectFrom('code_pool_entries')
      .select(['id', 'ciphertext', 'nonce', 'auth_tag', 'encryption_key_id', 'state', 'order_item_id'])
      .where('product_variant_id', '=', item.product_variant_id)
      .where('order_item_id', '=', item.id).where('state', '=', 'reserved')
      .orderBy('created_at').orderBy('id').forUpdate().execute()

    const consistent = variant?.inventory_mode === 'quantity' && inventory !== undefined
      && fulfillment?.method === 'code_pool'
      && Number(inventory.reserved) === (await trx.selectFrom('code_pool_entries')
        .select(sql<number>`count(*)::integer`.as('count')).where('product_variant_id', '=', item.product_variant_id)
        .where('state', '=', 'reserved').executeTakeFirstOrThrow()).count
      && Number(inventory.stocked) - Number(inventory.reserved) === (await trx.selectFrom('code_pool_entries')
        .select(sql<number>`count(*)::integer`.as('count')).where('product_variant_id', '=', item.product_variant_id)
        .where('state', '=', 'available').executeTakeFirstOrThrow()).count

    let failureCode: FailureCode | undefined
    if (!consistent || reservedEntries.length !== remaining
      || reservedEntries.some(entry => entry.state !== 'reserved' || entry.order_item_id !== item.id)) {
      failureCode = 'CODE_POOL_DATA_INCONSISTENT'
    } else if (!await paymentAllowsDelivery(trx, order.id, order.total_amount)) {
      failureCode = 'CODE_POOL_PAYMENT_UNRESOLVED'
    }

    const priorFailures = await trx.selectFrom('order_item_fulfillment_attempts')
      .select(sql<number>`count(*)::integer`.as('count'))
      .where('order_item_id', '=', item.id).where('delivery_source', '=', 'code_pool')
      .where('status', '=', 'failed').executeTakeFirstOrThrow()
    const attemptId = randomUUID()
    await trx.insertInto('order_item_fulfillment_attempts').values({
      id: attemptId,
      order_item_id: item.id,
      operation_id: operationId,
      quantity: remaining,
      started_by_admin_id: null,
      delivery_source: 'code_pool',
      status: 'processing',
      failure_code: null,
      retry_after: null,
      result_sha256: null,
      completed_at: null,
    }).execute()

    if (!failureCode) {
      try {
        requiredCodePoolKeyRing(config)
        const prepared: DeliveryCode[] = []
        for (let index = 0; index < reservedEntries.length; index += 1) {
          const entry = reservedEntries[index]!
          const plaintext = decryptCodePoolContent(config, `aikayun:code-pool:entry:v1:${item.product_variant_id}:${entry.id}`, {
            keyId: entry.encryption_key_id,
            nonce: entry.nonce,
            ciphertext: entry.ciphertext,
            authTag: entry.auth_tag,
          })
          const deliveryId = randomUUID()
          const encrypted = encryptCodePoolContent(
            config,
            `code-pool-delivery:${item.id}:${deliveryId}:${entry.id}`,
            plaintext,
          )
          prepared.push({
            id: deliveryId,
            unitIndex: item.fulfilled_quantity + index + 1,
            encrypted,
            digest: codePoolContentDigest(config, plaintext),
          })
        }
        for (let index = 0; index < prepared.length; index += 1) {
          const delivery = prepared[index]!
          const entry = reservedEntries[index]!
          await trx.insertInto('order_item_fulfillment_deliveries').values({
            id: delivery.id,
            fulfillment_attempt_id: attemptId,
            started_by_admin_id: null,
            unit_index: delivery.unitIndex,
            content: null,
            content_sha256: delivery.digest,
            delivery_source: 'code_pool',
            encrypted_content: delivery.encrypted.ciphertext,
            content_nonce: delivery.encrypted.nonce,
            content_auth_tag: delivery.encrypted.authTag,
            encryption_key_id: delivery.encrypted.keyId,
            code_pool_entry_id: entry.id,
          }).execute()
        }
        const resultDigest = createHash('sha256')
          .update(prepared.map((delivery, index) => `${delivery.id}:${reservedEntries[index]!.id}`).join('\n'))
          .digest('hex')
        await trx.updateTable('order_item_fulfillment_attempts').set({
          status: 'succeeded', result_sha256: resultDigest, completed_at: new Date(),
        }).where('id', '=', attemptId).execute()
        return 'delivered'
      } catch (error) {
        failureCode = error instanceof CodePoolKeyUnavailableError
          ? 'CODE_POOL_KEY_UNAVAILABLE'
          : error instanceof CodePoolDecryptionError
            ? 'CODE_POOL_DECRYPTION_FAILED'
            : 'CODE_POOL_DATA_INCONSISTENT'
      }
    }

    await trx.updateTable('order_item_fulfillment_attempts').set({
      status: 'failed',
      failure_code: failureCode,
      retry_after: new Date(Date.now() + retryDelay(Number(priorFailures.count) + 1)),
      completed_at: new Date(),
    }).where('id', '=', attemptId).execute()
    return 'failed'
    })
  } catch (error) {
    try {
      return await recordUnexpectedFailure(db, orderId, itemId, operationId)
    } catch {
      throw error
    }
  }
}

interface FixedDeliveryRecord {
  id: string
  unitIndex: number
  encrypted: ReturnType<typeof encryptFixedDeliveryPayload>
  digest: string
}

async function attemptFixedDelivery(
  db: Kysely<Database>,
  config: AppConfig,
  orderId: string,
  itemId: string,
): Promise<'delivered' | 'failed' | 'skipped'> {
  const operationId = randomUUID()
  try {
    return await db.transaction().execute(async (trx) => {
      const order = await trx.selectFrom('orders').select(['id', 'status', 'total_amount'])
        .where('id', '=', orderId).forUpdate().skipLocked().executeTakeFirst()
      if (!order || order.status !== 'processing') return 'skipped'
      const item = await trx.selectFrom('order_items')
        .select([
          'id', 'order_id', 'product_id', 'product_variant_id', 'quantity', 'fulfilled_quantity',
          'fulfillment_reserved_quantity', 'fulfillment_method_snapshot', 'fulfillment_content_version_id',
          'inventory_mode_snapshot',
        ])
        .where('id', '=', itemId).where('order_id', '=', orderId).forUpdate().executeTakeFirst()
      if (!item || (item.fulfillment_method_snapshot !== 'fixed_content' && item.fulfillment_method_snapshot !== 'link')) {
        return 'skipped'
      }
      const source = item.fulfillment_method_snapshot as FixedDeliveryMethod
      const remaining = item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity
      if (remaining <= 0) return 'skipped'
      const activeAttempt = await trx.selectFrom('order_item_fulfillment_attempts').select('id')
        .where('order_item_id', '=', item.id).where('delivery_source', '=', source)
        .where('status', 'in', ['processing', 'unknown']).executeTakeFirst()
      if (activeAttempt) return 'skipped'

      // Keep the checkout and worker catalog lock order: order → item → product → SKU → inventory → config.
      await trx.selectFrom('products').select('id').where('id', '=', item.product_id).forShare().executeTakeFirst()
      await trx.selectFrom('product_variants').select('id').where('id', '=', item.product_variant_id)
        .forUpdate().executeTakeFirst()
      const inventory = item.inventory_mode_snapshot === 'quantity'
        ? await trx.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
          .where('product_variant_id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
        : undefined
      await trx.selectFrom('product_variant_fulfillment').select('product_variant_id')
        .where('product_variant_id', '=', item.product_variant_id).forShare().executeTakeFirst()

      let failureCode: FailureCode | undefined
      if (item.inventory_mode_snapshot === 'quantity') {
        const reservation = await trx.selectFrom('order_inventory_reservations')
          .select(['id', 'quantity']).where('order_item_id', '=', item.id).executeTakeFirst()
        const eventTotals = reservation ? await sql<{ active_quantity: number; reserve_count: number }>`
          SELECT COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
            - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0) AS active_quantity,
            count(*) FILTER (WHERE action = 'reserve')::integer AS reserve_count
          FROM order_inventory_events WHERE reservation_id = ${reservation.id}::uuid
        `.execute(trx) : null
        const activeQuantity = Number(eventTotals?.rows[0]?.active_quantity ?? 0)
        if (!inventory || !reservation || reservation.quantity !== item.quantity
          || eventTotals?.rows[0]?.reserve_count !== 1 || activeQuantity !== remaining
          || Number(inventory.reserved) < remaining || Number(inventory.stocked) < remaining) {
          failureCode = 'FIXED_DELIVERY_DATA_INCONSISTENT'
        }
      } else if (item.inventory_mode_snapshot !== 'unlimited'
        || await trx.selectFrom('order_inventory_reservations').select('id')
          .where('order_item_id', '=', item.id).executeTakeFirst()) {
        failureCode = 'FIXED_DELIVERY_DATA_INCONSISTENT'
      }
      if (!failureCode && !await paymentAllowsDelivery(trx, order.id, order.total_amount)) {
        failureCode = 'FIXED_DELIVERY_PAYMENT_UNRESOLVED'
      }

      const version = item.fulfillment_content_version_id
        ? await trx.selectFrom('product_variant_fulfillment_versions')
          .select([
            'id', 'method', 'product_variant_id', 'encrypted_content', 'content_nonce',
            'content_auth_tag', 'encryption_key_id',
          ])
          .where('id', '=', item.fulfillment_content_version_id)
          .where('product_variant_id', '=', item.product_variant_id)
          .where('method', '=', source).executeTakeFirst()
        : undefined
      if (!failureCode && !version) failureCode = 'FIXED_DELIVERY_VERSION_UNAVAILABLE'

      const priorFailures = await trx.selectFrom('order_item_fulfillment_attempts')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('order_item_id', '=', item.id).where('delivery_source', '=', source)
        .where('status', '=', 'failed').executeTakeFirstOrThrow()
      const attemptId = randomUUID()
      await trx.insertInto('order_item_fulfillment_attempts').values({
        id: attemptId,
        order_item_id: item.id,
        operation_id: operationId,
        quantity: remaining,
        started_by_admin_id: null,
        delivery_source: source,
        status: 'processing',
        failure_code: null,
        retry_after: null,
        result_sha256: null,
        completed_at: null,
      }).execute()

      if (!failureCode && version && item.fulfillment_content_version_id
        && version.encryption_key_id && version.content_nonce && version.encrypted_content && version.content_auth_tag) {
        try {
          const payload = decryptFixedDeliveryPayload(config,
            fixedDeliveryVersionContext(item.product_variant_id, version.id, source),
            source, {
              keyId: version.encryption_key_id,
              nonce: version.content_nonce,
              ciphertext: version.encrypted_content,
              authTag: version.content_auth_tag,
            })
          const prepared: FixedDeliveryRecord[] = []
          for (let index = 0; index < remaining; index += 1) {
            const deliveryId = randomUUID()
            prepared.push({
              id: deliveryId,
              unitIndex: item.fulfilled_quantity + index + 1,
              encrypted: encryptFixedDeliveryPayload(config,
                fixedDeliveryDeliveryContext(item.id, deliveryId, version.id, source), payload),
              digest: fixedDeliveryPayloadDigest(config, payload),
            })
          }
          for (const delivery of prepared) {
            await trx.insertInto('order_item_fulfillment_deliveries').values({
              id: delivery.id,
              fulfillment_attempt_id: attemptId,
              started_by_admin_id: null,
              unit_index: delivery.unitIndex,
              content: null,
              content_sha256: delivery.digest,
              delivery_source: source,
              encrypted_content: delivery.encrypted.ciphertext,
              content_nonce: delivery.encrypted.nonce,
              content_auth_tag: delivery.encrypted.authTag,
              encryption_key_id: delivery.encrypted.keyId,
              code_pool_entry_id: null,
              fulfillment_content_version_id: version.id,
            }).execute()
          }
          const resultDigest = createHash('sha256')
            .update(prepared.map(delivery => `${delivery.id}:${version.id}`).join('\n'))
            .digest('hex')
          await trx.updateTable('order_item_fulfillment_attempts').set({
            status: 'succeeded', result_sha256: resultDigest, completed_at: new Date(),
          }).where('id', '=', attemptId).execute()
          return 'delivered'
        } catch (error) {
          failureCode = error instanceof FixedDeliveryKeyUnavailableError
            ? 'FIXED_DELIVERY_KEY_UNAVAILABLE'
            : error instanceof FixedDeliveryDecryptionError
              ? 'FIXED_DELIVERY_DECRYPTION_FAILED'
              : 'FIXED_DELIVERY_DATA_INCONSISTENT'
        }
      }

      await trx.updateTable('order_item_fulfillment_attempts').set({
        status: 'failed',
        failure_code: failureCode ?? 'FIXED_DELIVERY_DATA_INCONSISTENT',
        retry_after: new Date(Date.now() + retryDelay(Number(priorFailures.count) + 1)),
        completed_at: new Date(),
      }).where('id', '=', attemptId).execute()
      return 'failed'
    })
  } catch (error) {
    try {
      return await recordUnexpectedFailure(db, orderId, itemId, operationId)
    } catch {
      throw error
    }
  }
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

async function attemptFileDelivery(
  db: Kysely<Database>, config: AppConfig, orderId: string, itemId: string,
): Promise<'delivered' | 'failed' | 'skipped'> {
  const operationId = randomUUID()
  const storage = new PrivateFileStorage(config.privateFileRoot)
  let opened: Awaited<ReturnType<typeof storage.openVerified>> | undefined
  let fileFailure: FailureCode | undefined
  try {
    const bound = await db.selectFrom('order_items')
      .select(['product_variant_id', 'fulfillment_method_snapshot', 'fulfillment_content_version_id'])
      .where('id', '=', itemId).where('order_id', '=', orderId).executeTakeFirst()
    if (!bound || bound.fulfillment_method_snapshot !== 'file') return 'skipped'
    const version = bound.fulfillment_content_version_id
      ? await db.selectFrom('product_variant_fulfillment_versions as version')
        .leftJoin('private_file_objects as object', 'object.id', 'version.private_file_object_id')
        .select([
          'version.id as version_id', 'version.product_variant_id', 'version.private_file_object_id as object_id',
          'object.status as object_status', 'object.media_type', 'object.size_bytes', 'object.sha256',
        ])
        .where('version.id', '=', bound.fulfillment_content_version_id)
        .where('version.product_variant_id', '=', bound.product_variant_id)
        .where('version.method', '=', 'file').executeTakeFirst()
      : undefined
    if (!version?.version_id || !version.object_id || !version.media_type
      || version.size_bytes === null || !version.sha256) {
      fileFailure = 'FILE_DELIVERY_DATA_INCONSISTENT'
    } else if (version.object_status !== 'available') {
      fileFailure = 'FILE_DELIVERY_OBJECT_UNAVAILABLE'
      await db.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: false })
        .where('product_variant_id', '=', bound.product_variant_id).where('method', '=', 'file')
        .where('current_content_version_id', '=', version.version_id)
        .where('automatic_delivery_ready', '=', true).execute()
    } else {
      try {
        opened = await storage.openVerified(version.object_id, {
          sizeBytes: version.size_bytes,
          sha256: version.sha256.trim(),
        })
      } catch (error) {
        const unavailable = error instanceof PrivateFileError
          ? error.code === 'PRIVATE_FILE_UNAVAILABLE'
          : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(errno(error) ?? '')
        fileFailure = unavailable ? 'FILE_DELIVERY_OBJECT_UNAVAILABLE' : 'FILE_DELIVERY_INTEGRITY_FAILED'
        const nextStatus = unavailable ? 'missing' : 'corrupt'
        await db.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: false })
          .where('product_variant_id', '=', bound.product_variant_id).where('method', '=', 'file')
          .where('current_content_version_id', '=', version.version_id)
          .where('automatic_delivery_ready', '=', true).execute()
        await db.updateTable('private_file_objects').set({ status: nextStatus })
          .where('id', '=', version.object_id).where('status', '=', 'available').execute()
      }
    }

    return await db.transaction().execute(async (trx) => {
      const order = await trx.selectFrom('orders').select(['id', 'status', 'total_amount'])
        .where('id', '=', orderId).forUpdate().skipLocked().executeTakeFirst()
      if (!order || order.status !== 'processing') return 'skipped'
      const item = await trx.selectFrom('order_items')
        .select([
          'id', 'order_id', 'product_id', 'product_variant_id', 'quantity', 'fulfilled_quantity',
          'fulfillment_reserved_quantity', 'fulfillment_method_snapshot', 'fulfillment_content_version_id',
          'inventory_mode_snapshot',
        ])
        .where('id', '=', itemId).where('order_id', '=', orderId).forUpdate().executeTakeFirst()
      if (!item || item.fulfillment_method_snapshot !== 'file') return 'skipped'
      const remaining = item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity
      if (remaining <= 0) return 'skipped'
      const activeAttempt = await trx.selectFrom('order_item_fulfillment_attempts').select('id')
        .where('order_item_id', '=', item.id).where('delivery_source', '=', 'file')
        .where('status', 'in', ['processing', 'unknown']).executeTakeFirst()
      if (activeAttempt) return 'skipped'

      await trx.selectFrom('products').select('id').where('id', '=', item.product_id).forShare().executeTakeFirst()
      await trx.selectFrom('product_variants').select('id').where('id', '=', item.product_variant_id)
        .forUpdate().executeTakeFirst()
      const inventory = item.inventory_mode_snapshot === 'quantity'
        ? await trx.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
          .where('product_variant_id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
        : undefined
      await trx.selectFrom('product_variant_fulfillment').select('product_variant_id')
        .where('product_variant_id', '=', item.product_variant_id).forShare().executeTakeFirst()

      let failureCode = fileFailure
      if (!failureCode && item.inventory_mode_snapshot === 'quantity') {
        const reservation = await trx.selectFrom('order_inventory_reservations')
          .select(['id', 'quantity']).where('order_item_id', '=', item.id).executeTakeFirst()
        const eventTotals = reservation ? await sql<{ active_quantity: number; reserve_count: number }>`
          SELECT COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
            - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0) AS active_quantity,
            count(*) FILTER (WHERE action = 'reserve')::integer AS reserve_count
          FROM order_inventory_events WHERE reservation_id = ${reservation.id}::uuid
        `.execute(trx) : null
        const activeQuantity = Number(eventTotals?.rows[0]?.active_quantity ?? 0)
        if (!inventory || !reservation || reservation.quantity !== item.quantity
          || eventTotals?.rows[0]?.reserve_count !== 1 || activeQuantity !== remaining
          || Number(inventory.reserved) < remaining || Number(inventory.stocked) < remaining) {
          failureCode = 'FILE_DELIVERY_DATA_INCONSISTENT'
        }
      } else if (!failureCode && (item.inventory_mode_snapshot !== 'unlimited'
        || await trx.selectFrom('order_inventory_reservations').select('id')
          .where('order_item_id', '=', item.id).executeTakeFirst())) {
        failureCode = 'FILE_DELIVERY_DATA_INCONSISTENT'
      }
      if (!failureCode && !await paymentAllowsDelivery(trx, order.id, order.total_amount)) {
        failureCode = 'FILE_DELIVERY_PAYMENT_UNRESOLVED'
      }

      const immutableVersion = item.fulfillment_content_version_id
        ? await trx.selectFrom('product_variant_fulfillment_versions as version')
          .leftJoin('private_file_objects as object', 'object.id', 'version.private_file_object_id')
          .select([
            'version.id', 'version.method', 'version.product_variant_id',
            'version.private_file_object_id', 'version.content_sha256',
            'object.status as object_status', 'object.size_bytes', 'object.sha256',
          ])
          .where('version.id', '=', item.fulfillment_content_version_id)
          .where('version.product_variant_id', '=', item.product_variant_id)
          .where('version.method', '=', 'file').executeTakeFirst()
        : undefined
      if (!failureCode && (!opened || !immutableVersion || !immutableVersion.private_file_object_id
        || immutableVersion.object_status !== 'available' || immutableVersion.size_bytes === null
        || !immutableVersion.sha256 || immutableVersion.sha256.trim() !== immutableVersion.content_sha256.trim()
        || immutableVersion.private_file_object_id !== version?.object_id
        || immutableVersion.size_bytes !== version?.size_bytes
        || immutableVersion.sha256.trim() !== version?.sha256?.trim())) {
        failureCode = 'FILE_DELIVERY_DATA_INCONSISTENT'
      }

      const priorFailures = await trx.selectFrom('order_item_fulfillment_attempts')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('order_item_id', '=', item.id).where('delivery_source', '=', 'file')
        .where('status', '=', 'failed').executeTakeFirstOrThrow()
      const attemptId = randomUUID()
      await trx.insertInto('order_item_fulfillment_attempts').values({
        id: attemptId,
        order_item_id: item.id,
        operation_id: operationId,
        quantity: remaining,
        started_by_admin_id: null,
        delivery_source: 'file',
        status: 'processing',
        failure_code: null,
        retry_after: null,
        result_sha256: null,
        completed_at: null,
      }).execute()

      if (!failureCode && immutableVersion) {
        const deliveries: { id: string; unitIndex: number }[] = []
        for (let index = 0; index < remaining; index += 1) {
          const delivery = { id: randomUUID(), unitIndex: item.fulfilled_quantity + index + 1 }
          deliveries.push(delivery)
          await trx.insertInto('order_item_fulfillment_deliveries').values({
            id: delivery.id,
            fulfillment_attempt_id: attemptId,
            started_by_admin_id: null,
            unit_index: delivery.unitIndex,
            content: null,
            content_sha256: immutableVersion.content_sha256,
            delivery_source: 'file',
            encrypted_content: null,
            content_nonce: null,
            content_auth_tag: null,
            encryption_key_id: null,
            code_pool_entry_id: null,
            fulfillment_content_version_id: immutableVersion.id,
          }).execute()
        }
        const resultDigest = createHash('sha256')
          .update(deliveries.map(delivery => `${delivery.id}:${immutableVersion.id}`).join('\n'))
          .digest('hex')
        await trx.updateTable('order_item_fulfillment_attempts').set({
          status: 'succeeded', result_sha256: resultDigest, completed_at: new Date(),
        }).where('id', '=', attemptId).execute()
        return 'delivered'
      }
      await trx.updateTable('order_item_fulfillment_attempts').set({
        status: 'failed',
        failure_code: failureCode ?? 'FILE_DELIVERY_DATA_INCONSISTENT',
        retry_after: new Date(Date.now() + retryDelay(Number(priorFailures.count) + 1)),
        completed_at: new Date(),
      }).where('id', '=', attemptId).execute()
      return 'failed'
    })
  } catch {
    try { return await recordUnexpectedFailure(db, orderId, itemId, operationId) }
    catch { return 'failed' }
  } finally {
    await opened?.handle.close().catch(() => undefined)
  }
}

type ApiPreflightFailure = 'API_DELIVERY_DATA_INCONSISTENT' | 'API_DELIVERY_KEY_UNAVAILABLE'

async function recordApiPreflightFailure(
  trx: Transaction<Database>, orderItemId: string, remaining: number, failureCode: ApiPreflightFailure,
): Promise<void> {
  const priorFailures = await trx.selectFrom('order_item_fulfillment_attempts')
    .select(sql<number>`count(*)::integer`.as('count'))
    .where('order_item_id', '=', orderItemId).where('delivery_source', '=', 'api').where('status', '=', 'failed')
    .executeTakeFirstOrThrow()
  const retryAfter = new Date(Date.now() + retryDelay(Number(priorFailures.count) + 1))
  for (let index = 0; index < remaining; index += 1) {
    const operationId = randomUUID()
    const attemptId = randomUUID()
    await trx.insertInto('order_item_fulfillment_attempts').values({
      id: attemptId, order_item_id: orderItemId, operation_id: operationId, quantity: 1,
      started_by_admin_id: null, delivery_source: 'api', status: 'processing',
      failure_code: null, retry_after: null, result_sha256: null, completed_at: null,
    }).execute()
    await trx.updateTable('order_item_fulfillment_attempts').set({
      status: 'failed', failure_code: failureCode, retry_after: retryAfter,
    }).where('id', '=', attemptId).execute()
  }
}

async function attemptApiDelivery(
  db: Kysely<Database>, config: AppConfig, orderId: string, itemId: string,
): Promise<'delivered' | 'failed' | 'skipped'> {
  const now = new Date()
  return await db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('orders').select(['id', 'status', 'total_amount'])
      .where('id', '=', orderId).forUpdate().skipLocked().executeTakeFirst()
    if (!order || order.status !== 'processing') return 'skipped'
    const item = await trx.selectFrom('order_items').select([
      'id', 'order_id', 'product_id', 'product_variant_id', 'quantity', 'fulfilled_quantity',
      'fulfillment_reserved_quantity', 'fulfillment_method_snapshot', 'fulfillment_content_version_id',
      'inventory_mode_snapshot', 'unit_price',
    ]).where('id', '=', itemId).where('order_id', '=', orderId).forUpdate().executeTakeFirst()
    if (!item || item.fulfillment_method_snapshot !== 'api') return 'skipped'
    const remaining = item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity
    if (remaining <= 0) return 'skipped'
    await trx.selectFrom('products').select('id').where('id', '=', item.product_id).forShare().executeTakeFirst()
    const variant = await trx.selectFrom('product_variants').select(['id', 'inventory_mode'])
      .where('id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
    const inventory = item.inventory_mode_snapshot === 'quantity'
      ? await trx.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
        .where('product_variant_id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
      : undefined
    await trx.selectFrom('product_variant_fulfillment').select('product_variant_id')
      .where('product_variant_id', '=', item.product_variant_id).forShare().executeTakeFirst()
    if (!await paymentAllowsDelivery(trx, order.id, order.total_amount)) return 'skipped'

    const activeAttempt = await trx.selectFrom('order_item_fulfillment_attempts').select('id')
      .where('order_item_id', '=', item.id).where('delivery_source', '=', 'api')
      .where('status', 'in', ['processing', 'unknown']).executeTakeFirst()
    if (activeAttempt) return 'skipped'

    let dataConsistent = variant?.inventory_mode === item.inventory_mode_snapshot
      && (item.inventory_mode_snapshot === 'quantity' || item.inventory_mode_snapshot === 'unlimited')
    if (dataConsistent && item.inventory_mode_snapshot === 'quantity') {
      const reservation = await trx.selectFrom('order_inventory_reservations').select(['id', 'quantity'])
        .where('order_item_id', '=', item.id).executeTakeFirst()
      const events = reservation ? await sql<{ active_quantity: number; reserve_count: number }>`
        SELECT COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
          - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0) AS active_quantity,
          count(*) FILTER (WHERE action = 'reserve')::integer AS reserve_count
        FROM order_inventory_events WHERE reservation_id = ${reservation.id}::uuid
      `.execute(trx) : null
      const activeQuantity = Number(events?.rows[0]?.active_quantity ?? 0)
      dataConsistent = Boolean(reservation && inventory && reservation.quantity === item.quantity
        && events?.rows[0]?.reserve_count === 1 && activeQuantity === item.quantity - item.fulfilled_quantity
        && Number(inventory.reserved) >= activeQuantity && Number(inventory.stocked) >= activeQuantity)
    } else if (dataConsistent) {
      dataConsistent = !await trx.selectFrom('order_inventory_reservations').select('id')
        .where('order_item_id', '=', item.id).executeTakeFirst()
    }
    const version = item.fulfillment_content_version_id ? await trx.selectFrom('product_variant_fulfillment_versions as fulfillment_version')
      .innerJoin('supplier_connection_versions as supplier_version', 'supplier_version.id', 'fulfillment_version.supplier_connection_version_id')
      .select([
        'fulfillment_version.id', 'fulfillment_version.supplier_connection_version_id',
        'fulfillment_version.supplier_product_id', 'fulfillment_version.supplier_parameters',
        'supplier_version.supplier_connection_id', 'supplier_version.credential_version',
      ]).where('fulfillment_version.id', '=', item.fulfillment_content_version_id)
      .where('fulfillment_version.product_variant_id', '=', item.product_variant_id)
      .where('fulfillment_version.method', '=', 'api').executeTakeFirst() : undefined
    const hasCredential = version ? await trx.selectFrom('supplier_connection_credentials').select('credential_version')
      .where('supplier_connection_id', '=', version.supplier_connection_id)
      .where('credential_version', '=', version.credential_version).executeTakeFirst() : undefined
    if (!dataConsistent || !version || !version.supplier_product_id || !version.supplier_parameters || !hasCredential) {
      await recordApiPreflightFailure(trx, item.id, remaining, 'API_DELIVERY_DATA_INCONSISTENT')
      return 'failed'
    }
    if (!config.paymentCredentialKeyRing || !config.codePoolEncryptionKeyRing) {
      await recordApiPreflightFailure(trx, item.id, remaining, 'API_DELIVERY_KEY_UNAVAILABLE')
      return 'failed'
    }

    const retryUnit = await sql<{ unit_index: number }>`
      SELECT operation.unit_index
      FROM order_item_fulfillment_attempts AS attempt
      JOIN supplier_api_delivery_operations AS operation ON operation.fulfillment_attempt_id = attempt.id
      WHERE attempt.order_item_id = ${item.id}::uuid AND attempt.delivery_source = 'api'
        AND attempt.status = 'failed' AND attempt.retry_after IS NOT NULL AND attempt.retry_after <= ${now}
      ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
    `.execute(trx)
    const unitIndexes = retryUnit.rows.length
      ? [retryUnit.rows[0]!.unit_index]
      : Array.from({ length: remaining }, (_, index) => item.fulfilled_quantity + item.fulfillment_reserved_quantity + index + 1)
    for (const unitIndex of unitIndexes) {
      if (unitIndex > item.quantity) return 'skipped'
      const attemptId = randomUUID()
      const operationId = randomUUID()
      const idempotencyKey = `aikayun:${operationId}`
      let unitAmount: string
      try { unitAmount = settleAmount(item.unit_price) } catch { return 'skipped' }
      const requestSha256 = createHash('sha256').update(canonicalJson({
        protocol: 'http_json_v1', operationId, idempotencyKey,
        productId: version.supplier_product_id, quantity: 1, unitAmount,
        currency: 'CNY', parameters: version.supplier_parameters,
      })).digest('hex')
      await trx.insertInto('order_item_fulfillment_attempts').values({
        id: attemptId, order_item_id: item.id, operation_id: operationId, quantity: 1,
        started_by_admin_id: null, delivery_source: 'api', status: 'processing',
        failure_code: null, retry_after: null, result_sha256: null, completed_at: null,
      }).execute()
      await trx.insertInto('supplier_api_delivery_operations').values({
        id: operationId, fulfillment_attempt_id: attemptId, operation_id: operationId,
        unit_index: unitIndex, supplier_connection_id: version.supplier_connection_id,
        supplier_connection_version_id: version.supplier_connection_version_id!,
        supplier_product_id: version.supplier_product_id,
        idempotency_key: idempotencyKey, request_sha256: requestSha256,
        state: 'create_pending', next_action_at: now,
      }).execute()
    }
    return 'delivered'
  })
}

interface ApiOperationExecutionRow {
  operation_id: string
  operation_state: string
  lease_token: string | null
  fulfillment_attempt_id: string
  unit_index: number
  supplier_connection_id: string
  supplier_connection_version_id: string
  supplier_product_id: string
  idempotency_key: string
  request_sha256: string
  provider_operation_id: string | null
  base_url: string
  credential_version: number
  key_id: string
  nonce: Buffer
  ciphertext: Buffer
  auth_tag: Buffer
  parameters: Record<string, string>
  order_id: string
  item_id: string
  internal_product_id: string
  unit_price: string
}

interface ApiOperationClaim { id: string; token: string; action: 'create' | 'query' }

async function claimSupplierOperations(db: Kysely<Database>, limit = 20): Promise<ApiOperationClaim[]> {
  const now = new Date()
  return await db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom('supplier_api_delivery_operations').selectAll()
      .where((eb) => eb.or([
        eb.and([
          eb('state', 'in', ['create_pending', 'query_pending', 'processing', 'unknown']),
          eb('next_action_at', '<=', now),
        ]),
        eb.and([
          eb('state', 'in', ['create_in_flight', 'query_in_flight']),
          eb('lease_expires_at', '<=', now),
        ]),
      ]))
      .orderBy('next_action_at').orderBy('created_at').orderBy('id')
      .forUpdate().skipLocked().limit(limit).execute()
    const claims: ApiOperationClaim[] = []
    for (const row of rows) {
      const action: ApiOperationClaim['action'] = row.state === 'create_pending' ? 'create' : 'query'
      const token = randomUUID()
      await trx.updateTable('supplier_api_delivery_operations').set({
        state: action === 'create' ? 'create_in_flight' : 'query_in_flight',
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + supplierOperationLeaseMs),
        next_action_at: null,
        ...(action === 'create'
          ? { create_attempt_count: sql`create_attempt_count + 1`, create_requested_at: row.create_requested_at ?? now }
          : { query_attempt_count: sql`query_attempt_count + 1`, last_query_at: now }),
      }).where('id', '=', row.id).execute()
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: row.id,
        event_type: action === 'create' ? 'create_started' : 'query_started',
        http_status: null, classification: action, provider_status: null,
        provider_operation_id: row.provider_operation_id, error_code: null,
        response_sha256: null, details: { attempt: action === 'create' ? row.create_attempt_count + 1 : row.query_attempt_count + 1 },
      }).execute()
      claims.push({ id: row.id, token, action })
    }
    return claims
  })
}

async function apiExecutionRow(db: Kysely<Database>, operationId: string, leaseToken: string): Promise<ApiOperationExecutionRow | undefined> {
  const result = await sql<ApiOperationExecutionRow>`
    SELECT operation.operation_id, operation.state AS operation_state, operation.lease_token,
      operation.fulfillment_attempt_id, operation.unit_index, operation.supplier_connection_id,
      operation.supplier_connection_version_id, operation.supplier_product_id,
      operation.idempotency_key, operation.request_sha256, operation.provider_operation_id,
      supplier_version.base_url, supplier_version.credential_version,
      credential.key_id, credential.nonce, credential.ciphertext, credential.auth_tag,
      fulfillment_version.supplier_parameters AS parameters,
      parent.id AS order_id, item.id AS item_id, item.product_id AS internal_product_id,
      item.unit_price::text AS unit_price
    FROM supplier_api_delivery_operations AS operation
    JOIN order_item_fulfillment_attempts AS attempt ON attempt.id = operation.fulfillment_attempt_id
    JOIN order_items AS item ON item.id = attempt.order_item_id
    JOIN orders AS parent ON parent.id = item.order_id
    JOIN supplier_connection_versions AS supplier_version
      ON supplier_version.id = operation.supplier_connection_version_id
      AND supplier_version.supplier_connection_id = operation.supplier_connection_id
      AND supplier_version.credential_version > 0
    JOIN product_variant_fulfillment_versions AS fulfillment_version
      ON fulfillment_version.id = item.fulfillment_content_version_id
      AND fulfillment_version.supplier_connection_version_id = supplier_version.id
      AND fulfillment_version.supplier_product_id = operation.supplier_product_id
    JOIN supplier_connection_credentials AS credential
      ON credential.supplier_connection_id = operation.supplier_connection_id
      AND credential.credential_version = supplier_version.credential_version
    WHERE operation.id = ${operationId}::uuid AND operation.lease_token = ${leaseToken}::uuid
  `.execute(db)
  return result.rows[0]
}

interface ApiOperationLock {
  operation: {
    id: string
    fulfillment_attempt_id: string
    operation_id: string
    unit_index: number
    supplier_connection_id: string
    supplier_product_id: string
    state: string
    lease_token: string | null
    provider_operation_id: string | null
    result_sha256: string | null
    result_key_id: string | null
    result_nonce: Buffer | null
    result_ciphertext: Buffer | null
    result_auth_tag: Buffer | null
    query_attempt_count: number
  }
  order: { id: string; status: string; total_amount: string }
  item: { id: string; product_id: string; product_variant_id: string; quantity: number; fulfilled_quantity: number; fulfillment_reserved_quantity: number; fulfillment_method_snapshot: string; fulfillment_content_version_id: string | null; inventory_mode_snapshot: string }
}

async function lockApiOperation(
  trx: Transaction<Database>, operationId: string,
): Promise<ApiOperationLock | undefined> {
  const identity = await trx.selectFrom('supplier_api_delivery_operations')
    .select('fulfillment_attempt_id').where('id', '=', operationId).executeTakeFirst()
  if (!identity) return undefined
  const attempt = await trx.selectFrom('order_item_fulfillment_attempts').select('order_item_id')
    .where('id', '=', identity.fulfillment_attempt_id).executeTakeFirst()
  if (!attempt) return undefined
  const link = await trx.selectFrom('order_items').select(['id', 'order_id', 'product_id', 'product_variant_id'])
    .where('id', '=', attempt.order_item_id).executeTakeFirst()
  if (!link) return undefined
  const order = await trx.selectFrom('orders').select(['id', 'status', 'total_amount'])
    .where('id', '=', link.order_id).forUpdate().executeTakeFirst()
  const item = await trx.selectFrom('order_items').select([
    'id', 'product_id', 'product_variant_id', 'quantity', 'fulfilled_quantity',
    'fulfillment_reserved_quantity', 'fulfillment_method_snapshot', 'fulfillment_content_version_id', 'inventory_mode_snapshot',
  ]).where('id', '=', link.id).forUpdate().executeTakeFirst()
  if (!order || !item) return undefined
  await trx.selectFrom('products').select('id').where('id', '=', item.product_id).forShare().executeTakeFirst()
  await trx.selectFrom('product_variants').select('id').where('id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
  if (item.inventory_mode_snapshot === 'quantity') {
    await trx.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
      .where('product_variant_id', '=', item.product_variant_id).forUpdate().executeTakeFirst()
  }
  await trx.selectFrom('product_variant_fulfillment').select('product_variant_id')
    .where('product_variant_id', '=', item.product_variant_id).forShare().executeTakeFirst()
  const operation = await trx.selectFrom('supplier_api_delivery_operations').selectAll()
    .where('id', '=', operationId).forUpdate().executeTakeFirst()
  if (!operation) return undefined
  return { operation, order, item }
}

function operationPollDelay(attemptNumber: number): number {
  return Math.min(maxRetryDelayMs, 1_000 * 2 ** Math.min(8, Math.max(0, attemptNumber - 1)))
}

async function markApiAttemptUnknown(trx: Transaction<Database>, attemptId: string): Promise<void> {
  await trx.updateTable('order_item_fulfillment_attempts').set({ status: 'unknown' })
    .where('id', '=', attemptId).where('status', '=', 'processing').execute()
}

async function handleSupplierOutcome(
  db: Kysely<Database>, config: AppConfig, claim: ApiOperationClaim, outcome: HttpJsonV1Outcome,
): Promise<void> {
  let envelope: ReturnType<typeof encryptApiDeliveryResult> | undefined
  let resultDigest: string | undefined
  if (outcome.kind === 'succeeded') {
    try {
      envelope = encryptApiDeliveryResult(config, claim.id, outcome.result)
      resultDigest = apiDeliveryResultDigest(config, outcome.result, envelope.keyId)
    } catch (error) {
      await handleSupplierError(db, claim, error)
      return
    }
  }
  await db.transaction().execute(async (trx) => {
    const locked = await lockApiOperation(trx, claim.id)
    if (!locked) return
    const operation = locked.operation
    if (operation.lease_token !== claim.token || !['create_in_flight', 'query_in_flight'].includes(operation.state)) return
    const attempt = await trx.selectFrom('order_item_fulfillment_attempts').select(['id', 'status'])
      .where('id', '=', operation.fulfillment_attempt_id).forUpdate().executeTakeFirst()
    if (!attempt) return
    const now = new Date()
    const providerId = outcome.kind === 'succeeded' || outcome.kind === 'processing'
      ? outcome.providerOperationId : operation.provider_operation_id
    if (operation.provider_operation_id && providerId && operation.provider_operation_id !== providerId) {
      await trx.updateTable('supplier_api_delivery_operations').set({
        state: 'manual_review', next_action_at: null, lease_token: null, lease_expires_at: null,
        last_http_status: outcome.httpStatus, last_error_code: 'supplier_operation_id_conflict',
        last_failure_class: 'identity_mismatch', last_provider_status: outcome.kind,
      }).where('id', '=', claim.id).execute()
      await markApiAttemptUnknown(trx, attempt.id)
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: claim.id,
        event_type: 'integrity_conflict', http_status: outcome.httpStatus,
        classification: 'identity_mismatch', provider_status: outcome.kind,
        provider_operation_id: providerId, error_code: 'supplier_operation_id_conflict',
        response_sha256: outcome.responseSha256, details: {},
      }).execute()
      return
    }
    const eventType = claim.action === 'create' ? 'create_response' : 'query_response'
    if (outcome.kind === 'not_found') {
      if (claim.action !== 'query') {
        await trx.updateTable('supplier_api_delivery_operations').set({
          state: 'manual_review', next_action_at: null, lease_token: null, lease_expires_at: null,
          last_http_status: outcome.httpStatus, last_error_code: 'supplier_not_found_after_create',
          last_failure_class: 'identity_mismatch', last_provider_status: 'not_found',
        }).where('id', '=', claim.id).execute()
        await markApiAttemptUnknown(trx, attempt.id)
      } else {
        await trx.updateTable('supplier_api_delivery_operations').set({
          state: 'create_pending', next_action_at: now, lease_token: null, lease_expires_at: null,
          last_http_status: outcome.httpStatus, last_error_code: null, last_failure_class: null,
          last_provider_status: 'not_found', provider_operation_id: null,
        }).where('id', '=', claim.id).execute()
      }
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: claim.id, event_type: eventType,
        http_status: outcome.httpStatus, classification: claim.action, provider_status: 'not_found',
        provider_operation_id: null, error_code: claim.action === 'query' ? null : 'supplier_not_found_after_create',
        response_sha256: outcome.responseSha256, details: {},
      }).execute()
      return
    }
    if (outcome.kind === 'processing') {
      await trx.updateTable('supplier_api_delivery_operations').set({
        state: 'processing', next_action_at: new Date(now.getTime() + supplierOperationPollMs),
        lease_token: null, lease_expires_at: null, provider_operation_id: outcome.providerOperationId,
        last_http_status: outcome.httpStatus, last_error_code: null, last_failure_class: null,
        last_provider_status: outcome.status,
      }).where('id', '=', claim.id).execute()
      if (attempt.status === 'unknown') {
        await trx.updateTable('order_item_fulfillment_attempts').set({ status: 'processing' }).where('id', '=', attempt.id).execute()
      }
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: claim.id, event_type: eventType,
        http_status: outcome.httpStatus, classification: claim.action, provider_status: outcome.status,
        provider_operation_id: outcome.providerOperationId, error_code: null,
        response_sha256: outcome.responseSha256, details: {},
      }).execute()
      return
    }
    if (outcome.kind === 'rejected') {
      await trx.updateTable('supplier_api_delivery_operations').set({
        state: 'failed', next_action_at: null, lease_token: null, lease_expires_at: null,
        provider_operation_id: operation.provider_operation_id,
        last_http_status: outcome.httpStatus, last_error_code: 'supplier_rejected',
        last_failure_class: 'supplier_rejected', last_provider_status: 'rejected',
        completed_at: now,
      }).where('id', '=', claim.id).execute()
      await trx.updateTable('order_item_fulfillment_attempts').set({
        status: 'failed', failure_code: 'API_DELIVERY_SUPPLIER_REJECTED', retry_after: null,
      }).where('id', '=', attempt.id).execute()
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: claim.id, event_type: eventType,
        http_status: outcome.httpStatus, classification: 'supplier_rejected', provider_status: 'rejected',
        provider_operation_id: operation.provider_operation_id, error_code: 'supplier_rejected',
        response_sha256: outcome.responseSha256, details: {},
      }).execute()
      return
    }
    if (locked.order.status !== 'processing') {
      await trx.updateTable('supplier_api_delivery_operations').set({
        state: 'manual_review', next_action_at: null, lease_token: null, lease_expires_at: null,
        provider_operation_id: outcome.providerOperationId, last_http_status: outcome.httpStatus,
        last_error_code: 'order_not_processing_after_provider_success', last_failure_class: 'integrity_conflict',
        last_provider_status: 'succeeded', result_type: outcome.result.type, result_sha256: resultDigest!,
        result_key_id: envelope!.keyId, result_nonce: envelope!.nonce,
        result_ciphertext: envelope!.ciphertext, result_auth_tag: envelope!.authTag,
      }).where('id', '=', claim.id).execute()
      await markApiAttemptUnknown(trx, attempt.id)
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: claim.id, event_type: 'integrity_conflict',
        http_status: outcome.httpStatus, classification: 'integrity_conflict', provider_status: 'succeeded',
        provider_operation_id: outcome.providerOperationId, error_code: 'order_not_processing_after_provider_success',
        response_sha256: outcome.responseSha256, details: {},
      }).execute()
      return
    }
    await trx.updateTable('supplier_api_delivery_operations').set({
      state: 'succeeded_pending_finalize', next_action_at: now,
      lease_token: null, lease_expires_at: null, provider_operation_id: outcome.providerOperationId,
      last_http_status: outcome.httpStatus, last_error_code: null, last_failure_class: null,
      last_provider_status: 'succeeded', result_type: outcome.result.type,
      result_sha256: resultDigest!, result_key_id: envelope!.keyId,
      result_nonce: envelope!.nonce, result_ciphertext: envelope!.ciphertext,
      result_auth_tag: envelope!.authTag,
    }).where('id', '=', claim.id).execute()
    const paymentsAllowed = await paymentAllowsDelivery(trx, locked.order.id, locked.order.total_amount)
    if (!paymentsAllowed) await markApiAttemptUnknown(trx, attempt.id)
    await trx.insertInto('supplier_api_delivery_events').values({
      id: randomUUID(), operation_id: claim.id, event_type: paymentsAllowed ? 'result_stored' : 'payment_protection_pending',
      http_status: outcome.httpStatus, classification: claim.action, provider_status: 'succeeded',
      provider_operation_id: outcome.providerOperationId, error_code: paymentsAllowed ? null : 'payment_unresolved',
      response_sha256: outcome.responseSha256, details: { resultType: outcome.result.type },
    }).execute()
  })
}

async function handleSupplierError(
  db: Kysely<Database>, claim: ApiOperationClaim, error: unknown,
): Promise<void> {
  const httpError = error instanceof HttpJsonV1Error ? error : new HttpJsonV1Error('response_invalid',
    error instanceof SupplierCredentialKeyUnavailableError ? 'supplier_credential_key_unavailable'
      : error instanceof ApiDeliveryKeyUnavailableError ? 'api_delivery_key_unavailable' : 'supplier_operation_unavailable')
  await db.transaction().execute(async (trx) => {
    const locked = await lockApiOperation(trx, claim.id)
    if (!locked) return
    const operation = locked.operation
    if (operation.lease_token !== claim.token) return
    const attempt = await trx.selectFrom('order_item_fulfillment_attempts').select(['id', 'status'])
      .where('id', '=', operation.fulfillment_attempt_id).forUpdate().executeTakeFirst()
    if (!attempt) return
    const retryable = httpError.classification === 'transport_unknown' || httpError.classification === 'http_unknown'
      || httpError.code === 'api_delivery_key_unavailable' || httpError.code === 'supplier_credential_key_unavailable'
    const now = new Date()
    const nextState = retryable ? 'unknown' : 'manual_review'
    await trx.updateTable('supplier_api_delivery_operations').set({
      state: nextState,
      next_action_at: retryable ? new Date(now.getTime() + operationPollDelay(operation.query_attempt_count + 1)) : null,
      lease_token: null, lease_expires_at: null,
      last_http_status: httpError.httpStatus, last_error_code: httpError.code,
      last_failure_class: httpError.classification,
      last_provider_status: null,
    }).where('id', '=', claim.id).execute()
    await markApiAttemptUnknown(trx, attempt.id)
    await trx.insertInto('supplier_api_delivery_events').values({
      id: randomUUID(), operation_id: claim.id,
      event_type: httpError.code === 'supplier_credential_key_unavailable'
        ? 'credential_unavailable'
        : httpError.classification === 'identity_mismatch' || httpError.classification === 'result_invalid'
          ? 'integrity_conflict' : claim.action === 'create' ? 'create_response' : 'query_response',
      http_status: httpError.httpStatus, classification: httpError.classification,
      provider_status: null, provider_operation_id: operation.provider_operation_id,
      error_code: httpError.code, response_sha256: null, details: { retryable },
    }).execute()
  })
}

async function processSupplierClaim(
  db: Kysely<Database>, config: AppConfig, claim: ApiOperationClaim,
): Promise<void> {
  try {
    if (claim.action === 'create') {
      const mayCreate = await db.transaction().execute(async (trx) => {
        const locked = await lockApiOperation(trx, claim.id)
        if (!locked || locked.operation.lease_token !== claim.token || locked.operation.state !== 'create_in_flight') return false
        if (locked.order.status === 'processing'
          && await paymentAllowsDelivery(trx, locked.order.id, locked.order.total_amount)) return true
        const now = new Date()
        await trx.updateTable('supplier_api_delivery_operations').set({
          state: 'create_pending', next_action_at: new Date(now.getTime() + supplierOperationPollMs),
          lease_token: null, lease_expires_at: null,
          last_error_code: 'payment_unresolved', last_failure_class: 'payment_protection',
        }).where('id', '=', claim.id).execute()
        await trx.insertInto('supplier_api_delivery_events').values({
          id: randomUUID(), operation_id: claim.id, event_type: 'payment_protection_pending',
          http_status: null, classification: 'payment_protection', provider_status: null,
          provider_operation_id: locked.operation.provider_operation_id, error_code: 'payment_unresolved',
          response_sha256: null, details: { action: 'create' },
        }).execute()
        return false
      })
      if (!mayCreate) return
    }
    const row = await apiExecutionRow(db, claim.id, claim.token)
    if (!row || !row.key_id || !row.ciphertext || !row.nonce || !row.auth_tag) {
      await handleSupplierError(db, claim, new SupplierCredentialKeyUnavailableError())
      return
    }
    const token = decryptSupplierBearerToken(config, row.supplier_connection_id, row.credential_version, {
      keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
    })
    let unitAmount: string
    try { unitAmount = settleAmount(row.unit_price) } catch {
      await handleSupplierError(db, claim, new HttpJsonV1Error('identity_mismatch', 'order_unit_amount_invalid'))
      return
    }
    const request: HttpJsonV1DeliveryRequest = {
      operationId: row.operation_id, idempotencyKey: row.idempotency_key,
      productId: row.supplier_product_id, unitAmount,
      parameters: row.parameters ?? {},
    }
    const expectedDigest = createHash('sha256').update(canonicalJson({
      protocol: 'http_json_v1', operationId: request.operationId,
      idempotencyKey: request.idempotencyKey, productId: request.productId,
      quantity: 1, unitAmount, currency: 'CNY', parameters: request.parameters,
    })).digest('hex')
    if (expectedDigest !== row.request_sha256) {
      await handleSupplierError(db, claim, new HttpJsonV1Error('identity_mismatch', 'operation_request_digest_mismatch'))
      return
    }
    const supplier = { baseUrl: row.base_url, bearerToken: token }
    const outcome = claim.action === 'create'
      ? await createHttpJsonV1Delivery(config, supplier, request)
      : await queryHttpJsonV1Delivery(config, supplier, request, row.provider_operation_id)
    if ((outcome.kind === 'processing' || outcome.kind === 'succeeded')
      && (outcome.providerOperationId === token || outcome.providerOperationId.includes(token))) {
      await handleSupplierError(db, claim, new HttpJsonV1Error('identity_mismatch', 'supplier_response_credential_echo'))
      return
    }
    if (outcome.kind === 'succeeded' && [outcome.result.content, outcome.result.title, outcome.result.instructions]
      .some(value => value !== null && value.includes(token))) {
      await handleSupplierError(db, claim, new HttpJsonV1Error('result_invalid', 'supplier_result_credential_echo'))
      return
    }
    await handleSupplierOutcome(db, config, claim, outcome)
  } catch (error) {
    await handleSupplierError(db, claim, error)
  }
}

async function finalizeApiOperation(db: Kysely<Database>, config: AppConfig, operationId: string): Promise<void> {
  const record = await db.selectFrom('supplier_api_delivery_operations').selectAll()
    .where('id', '=', operationId).where('state', '=', 'succeeded_pending_finalize').executeTakeFirst()
  if (!record || !record.result_key_id || !record.result_nonce || !record.result_ciphertext || !record.result_auth_tag || !record.result_sha256) return
  let result: ReturnType<typeof decryptApiDeliveryResult>
  try {
    result = decryptApiDeliveryResult(config, operationId, {
      keyId: record.result_key_id, nonce: record.result_nonce,
      ciphertext: record.result_ciphertext, authTag: record.result_auth_tag,
    })
    if (apiDeliveryResultDigest(config, result, record.result_key_id) !== record.result_sha256.trim()) {
      throw new Error('supplier result digest mismatch')
    }
  } catch (error) {
    if (error instanceof ApiDeliveryKeyUnavailableError) {
      await db.transaction().execute(async (trx) => {
        const locked = await lockApiOperation(trx, operationId)
        if (!locked || locked.operation.state !== 'succeeded_pending_finalize') return
        const attempt = await trx.selectFrom('order_item_fulfillment_attempts').select(['id', 'status'])
          .where('id', '=', locked.operation.fulfillment_attempt_id).forUpdate().executeTakeFirst()
        if (!attempt) return
        await markApiAttemptUnknown(trx, attempt.id)
        await trx.updateTable('supplier_api_delivery_operations').set({
          next_action_at: new Date(Date.now() + supplierOperationPollMs),
          last_error_code: 'api_delivery_key_unavailable', last_failure_class: 'key_unavailable',
        }).where('id', '=', operationId).execute()
        await trx.insertInto('supplier_api_delivery_events').values({
          id: randomUUID(), operation_id: operationId, event_type: 'credential_unavailable',
          http_status: null, classification: 'key_unavailable', provider_status: 'succeeded',
          provider_operation_id: locked.operation.provider_operation_id, error_code: 'api_delivery_key_unavailable',
          response_sha256: null, details: {},
        }).execute()
      })
      return
    }
    await db.transaction().execute(async (trx) => {
      const locked = await lockApiOperation(trx, operationId)
      if (!locked || locked.operation.state !== 'succeeded_pending_finalize') return
      const attempt = await trx.selectFrom('order_item_fulfillment_attempts').select('id')
        .where('id', '=', locked.operation.fulfillment_attempt_id).forUpdate().executeTakeFirst()
      if (!attempt) return
      await markApiAttemptUnknown(trx, attempt.id)
      await trx.updateTable('supplier_api_delivery_operations').set({
        state: 'manual_review', next_action_at: null,
        last_error_code: 'supplier_result_integrity_failed', last_failure_class: 'integrity_conflict',
      }).where('id', '=', operationId).execute()
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: operationId, event_type: 'integrity_conflict',
        http_status: null, classification: 'integrity_conflict', provider_status: 'succeeded',
        provider_operation_id: locked.operation.provider_operation_id, error_code: 'supplier_result_integrity_failed',
        response_sha256: null, details: {},
      }).execute()
    })
    return
  }

  await db.transaction().execute(async (trx) => {
    const locked = await lockApiOperation(trx, operationId)
    if (!locked || locked.operation.state !== 'succeeded_pending_finalize') return
    const operation = locked.operation
    const attempt = await trx.selectFrom('order_item_fulfillment_attempts').select(['id', 'status'])
      .where('id', '=', operation.fulfillment_attempt_id).forUpdate().executeTakeFirst()
    if (!attempt) return
    if (locked.order.status !== 'processing' || !await paymentAllowsDelivery(trx, locked.order.id, locked.order.total_amount)) {
      await markApiAttemptUnknown(trx, attempt.id)
      await trx.updateTable('supplier_api_delivery_operations').set({
        next_action_at: new Date(Date.now() + supplierOperationPollMs),
        last_error_code: 'payment_unresolved', last_failure_class: 'payment_protection',
      }).where('id', '=', operationId).execute()
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: operationId, event_type: 'payment_protection_pending',
        http_status: null, classification: 'payment_protection', provider_status: 'succeeded',
        provider_operation_id: operation.provider_operation_id, error_code: 'payment_unresolved',
        response_sha256: null, details: {},
      }).execute()
      return
    }
    if (operation.unit_index > locked.item.quantity || locked.item.fulfillment_content_version_id === null
      || locked.item.fulfillment_method_snapshot !== 'api') {
      await markApiAttemptUnknown(trx, attempt.id)
      await trx.updateTable('supplier_api_delivery_operations').set({
        state: 'manual_review', next_action_at: null,
        last_error_code: 'api_order_snapshot_mismatch', last_failure_class: 'integrity_conflict',
      }).where('id', '=', operationId).execute()
      await trx.insertInto('supplier_api_delivery_events').values({
        id: randomUUID(), operation_id: operationId, event_type: 'integrity_conflict',
        http_status: null, classification: 'integrity_conflict', provider_status: 'succeeded',
        provider_operation_id: operation.provider_operation_id, error_code: 'api_order_snapshot_mismatch',
        response_sha256: null, details: {},
      }).execute()
      return
    }
    let fingerprintKeyId: string | null = null
    let contentDigest = operation.result_sha256!.trim()
    if (result.type === 'code') {
      if (!result.content || !config.codePoolEncryptionKeyRing) {
        await markApiAttemptUnknown(trx, attempt.id)
        await trx.updateTable('supplier_api_delivery_operations').set({
          next_action_at: new Date(Date.now() + supplierOperationPollMs),
          last_error_code: 'api_delivery_key_unavailable', last_failure_class: 'key_unavailable',
        }).where('id', '=', operationId).execute()
        return
      }
      fingerprintKeyId = config.codePoolEncryptionKeyRing.activeKeyId
      const matches = codePoolFingerprints(config, result.content)
      const activeFingerprint = matches.find((item) => item.keyId === fingerprintKeyId)
      if (!activeFingerprint) throw new CodePoolKeyUnavailableError()
      const duplicatePairs = await sql<{ id: string }>`
        WITH requested AS MATERIALIZED (
          SELECT pair.key_id, pair.fingerprint
          FROM unnest(${matches.map(item => item.keyId)}::text[], ${matches.map(item => item.fingerprint)}::text[]) AS pair(key_id, fingerprint)
        )
        SELECT delivery.id
        FROM order_item_fulfillment_deliveries AS delivery
        JOIN requested ON requested.key_id = delivery.supplier_fingerprint_key_id
          AND requested.fingerprint = delivery.content_sha256
        WHERE delivery.delivery_source = 'api'
          AND delivery.supplier_connection_id = ${operation.supplier_connection_id}::uuid
          AND delivery.supplier_product_id = ${operation.supplier_product_id}
          AND delivery.supplier_api_operation_id <> ${operationId}::uuid
        LIMIT 1
      `.execute(trx)
      if (duplicatePairs.rows.length) {
        await markApiAttemptUnknown(trx, attempt.id)
        await trx.updateTable('supplier_api_delivery_operations').set({
          state: 'manual_review', next_action_at: null,
          last_error_code: 'duplicate_supplier_code', last_failure_class: 'integrity_conflict',
        }).where('id', '=', operationId).execute()
        await trx.insertInto('supplier_api_delivery_events').values({
          id: randomUUID(), operation_id: operationId, event_type: 'integrity_conflict',
          http_status: null, classification: 'integrity_conflict', provider_status: 'succeeded',
          provider_operation_id: operation.provider_operation_id, error_code: 'duplicate_supplier_code',
          response_sha256: null, details: {},
        }).execute()
        return
      }
      contentDigest = activeFingerprint.fingerprint
    }
    const deliveryId = randomUUID()
    await trx.insertInto('order_item_fulfillment_deliveries').values({
      id: deliveryId, fulfillment_attempt_id: attempt.id, started_by_admin_id: null,
      unit_index: operation.unit_index, content: null, content_sha256: contentDigest,
      delivery_source: 'api', encrypted_content: result.type === 'completed' ? null : operation.result_ciphertext,
      content_nonce: result.type === 'completed' ? null : operation.result_nonce,
      content_auth_tag: result.type === 'completed' ? null : operation.result_auth_tag,
      encryption_key_id: result.type === 'completed' ? null : operation.result_key_id,
      code_pool_entry_id: null, fulfillment_content_version_id: locked.item.fulfillment_content_version_id,
      supplier_api_operation_id: operationId, supplier_connection_id: operation.supplier_connection_id,
      supplier_product_id: operation.supplier_product_id, supplier_content_type: result.type,
      supplier_fingerprint_key_id: fingerprintKeyId,
    }).execute()
    await trx.updateTable('order_item_fulfillment_attempts').set({
      status: 'succeeded', result_sha256: operation.result_sha256!.trim(),
    }).where('id', '=', attempt.id).execute()
    await trx.updateTable('supplier_api_delivery_operations').set({
      state: 'succeeded', next_action_at: null, lease_token: null, lease_expires_at: null,
      last_error_code: null, last_failure_class: null, completed_at: new Date(),
    }).where('id', '=', operationId).execute()
    await trx.insertInto('supplier_api_delivery_events').values({
      id: randomUUID(), operation_id: operationId, event_type: 'delivery_finalized',
      http_status: null, classification: 'success', provider_status: 'succeeded',
      provider_operation_id: operation.provider_operation_id, error_code: null,
      response_sha256: operation.result_sha256!.trim(), details: { deliveryId, resultType: result.type },
    }).execute()
  })
}

async function processSupplierOperations(db: Kysely<Database>, config: AppConfig): Promise<void> {
  const dueFinalizations = await db.selectFrom('supplier_api_delivery_operations').select('id')
    .where('state', '=', 'succeeded_pending_finalize').where('next_action_at', '<=', new Date())
    .orderBy('next_action_at').orderBy('id').limit(20).execute()
  for (const row of dueFinalizations) await finalizeApiOperation(db, config, row.id)
  const claims = await claimSupplierOperations(db)
  for (const claim of claims) await processSupplierClaim(db, config, claim)
}

async function attemptDelivery(
  db: Kysely<Database>, config: AppConfig, orderId: string, itemId: string,
): Promise<'delivered' | 'failed' | 'skipped'> {
  const item = await db.selectFrom('order_items').select('fulfillment_method_snapshot')
    .where('id', '=', itemId).where('order_id', '=', orderId).executeTakeFirst()
  if (item?.fulfillment_method_snapshot === 'code_pool') {
    return attemptCodePoolDelivery(db, config, orderId, itemId)
  }
  if (item?.fulfillment_method_snapshot === 'fixed_content' || item?.fulfillment_method_snapshot === 'link') {
    return attemptFixedDelivery(db, config, orderId, itemId)
  }
  if (item?.fulfillment_method_snapshot === 'file') return attemptFileDelivery(db, config, orderId, itemId)
  if (item?.fulfillment_method_snapshot === 'api') return attemptApiDelivery(db, config, orderId, itemId)
  return 'skipped'
}

/** Run one deterministic recovery pass; operations and network requests remain split by committed transactions. */
export async function runDigitalDeliveryRecoveryPass(db: Kysely<Database>, config: AppConfig): Promise<void> {
  const batch = await candidates(db, new Date())
  for (const candidate of batch) {
    await attemptDelivery(db, config, candidate.order_id, candidate.order_item_id)
  }
  await processSupplierOperations(db, config)
}

/**
 * Database-only delivery is safe to retry: reservations and deliveries commit
 * with the existing fulfillment-attempt transition and inventory consumption.
 * SKIP LOCKED distributes orders between API instances; first startup pass
 * resumes any processing item without a live or scheduled attempt.
 */
export function startDigitalDeliveryWorker(
  db: Kysely<Database>,
  config: AppConfig,
  logger: FastifyBaseLogger,
): () => Promise<void> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let activeRun: Promise<void> | undefined

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => { void run() }, pollIntervalMs)
    timer.unref()
  }

  const run = async () => {
    if (stopped) return
    activeRun = (async () => {
      try {
        await runDigitalDeliveryRecoveryPass(db, config)
      } catch (error) {
        const candidateError = error && typeof error === 'object'
          ? error as { code?: unknown; name?: unknown }
          : {}
        logger.warn({
          errorName: typeof candidateError.name === 'string' ? candidateError.name : 'unknown',
          databaseCode: typeof candidateError.code === 'string' ? candidateError.code : undefined,
        }, 'digital delivery recovery scan failed')
      } finally {
        activeRun = undefined
        schedule()
      }
    })()
    await activeRun
  }

  void run()
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    await activeRun
  }
}

/** @deprecated Kept as a source-compatible alias for existing ⑤-1 tests and callers. */
export const startCodePoolDeliveryWorker = startDigitalDeliveryWorker
