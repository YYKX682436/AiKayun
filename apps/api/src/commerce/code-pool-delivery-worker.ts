import { createHash, randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { PrivateFileError, PrivateFileStorage } from '../media/private-file-storage.js'
import {
  CodePoolDecryptionError,
  CodePoolKeyUnavailableError,
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

const pollIntervalMs = 1_000
const batchSize = 20
const maxRetryDelayMs = 5 * 60_000

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

async function candidates(db: Db, now: Date): Promise<Candidate[]> {
  const result = await sql<Candidate>`
    SELECT item.order_id, item.id AS order_item_id
    FROM orders AS order_row
    JOIN order_items AS item ON item.order_id = order_row.id
    WHERE order_row.status = 'processing'
      AND item.fulfillment_method_snapshot IN ('code_pool', 'fixed_content', 'link', 'file')
      AND item.fulfilled_quantity + item.fulfillment_reserved_quantity < item.quantity
      AND NOT EXISTS (
        SELECT 1 FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = item.fulfillment_method_snapshot
          AND attempt.status IN ('processing', 'unknown')
      )
      AND COALESCE((
        SELECT attempt.retry_after FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = item.fulfillment_method_snapshot
          AND attempt.status = 'failed'
        ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
      ), '-infinity'::timestamptz) <= ${now}
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
  return 'skipped'
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
        const batch = await candidates(db, new Date())
        for (const candidate of batch) {
          if (stopped) break
          try {
            const result = await attemptDelivery(db, config, candidate.order_id, candidate.order_item_id)
            if (result === 'failed') {
              logger.warn({ orderId: candidate.order_id, orderItemId: candidate.order_item_id }, 'digital delivery requires retry')
            }
          } catch (error) {
            const candidateError = error && typeof error === 'object'
              ? error as { code?: unknown; name?: unknown }
              : {}
            logger.warn({
              orderId: candidate.order_id,
              orderItemId: candidate.order_item_id,
              errorName: typeof candidateError.name === 'string' ? candidateError.name : 'unknown',
              databaseCode: typeof candidateError.code === 'string' ? candidateError.code : undefined,
            }, 'digital delivery transaction failed; item remains eligible for recovery')
          }
        }
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
