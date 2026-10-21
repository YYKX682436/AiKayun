import { createHash, randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import {
  CodePoolDecryptionError,
  CodePoolKeyUnavailableError,
  codePoolContentDigest,
  decryptCodePoolContent,
  encryptCodePoolContent,
  requiredCodePoolKeyRing,
} from './code-pool-crypto.js'

const pollIntervalMs = 1_000
const batchSize = 20
const maxRetryDelayMs = 5 * 60_000

type Db = Kysely<Database> | Transaction<Database>
type FailureCode = 'CODE_POOL_DATA_INCONSISTENT' | 'CODE_POOL_KEY_UNAVAILABLE'
  | 'CODE_POOL_DECRYPTION_FAILED' | 'CODE_POOL_PAYMENT_UNRESOLVED'

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
      AND item.fulfillment_method_snapshot = 'code_pool'
      AND item.fulfilled_quantity + item.fulfillment_reserved_quantity < item.quantity
      AND NOT EXISTS (
        SELECT 1 FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = 'code_pool'
          AND attempt.status IN ('processing', 'unknown')
      )
      AND COALESCE((
        SELECT attempt.retry_after FROM order_item_fulfillment_attempts AS attempt
        WHERE attempt.order_item_id = item.id AND attempt.delivery_source = 'code_pool'
          AND attempt.status = 'failed'
        ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
      ), '-infinity'::timestamptz) <= ${now}
    ORDER BY order_row.created_at, order_row.id, item.created_at, item.id
    LIMIT ${batchSize}
  `.execute(db)
  return result.rows
}

async function paymentAllowsDelivery(trx: Transaction<Database>, orderId: string, totalAmount: string): Promise<boolean> {
  if (totalAmount === '0.00') return true
  const evidence = await sql<{ valid: boolean }>`
    SELECT NOT order_has_unresolved_payment_attempts(${orderId}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM payment_attempts AS attempt
        JOIN payment_provider_reconciliation_cases AS reconciliation
          ON reconciliation.payment_attempt_id = attempt.id
        WHERE attempt.order_id = ${orderId}::uuid AND reconciliation.state = 'open'
      )
      AND COALESCE((
        SELECT sum(receipt.amount)
        FROM payment_attempts AS attempt
        JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = attempt.id
        WHERE attempt.order_id = ${orderId}::uuid AND attempt.status = 'succeeded'
          AND receipt.disposition = 'on_time'
      ), 0) = ${totalAmount}::numeric AS valid
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
    if (!item || item.fulfillment_method_snapshot !== 'code_pool') return 'skipped'
    const remaining = item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity
    if (remaining <= 0) return 'skipped'
    const active = await trx.selectFrom('order_item_fulfillment_attempts').select('id')
      .where('order_item_id', '=', item.id).where('delivery_source', '=', 'code_pool')
      .where('status', 'in', ['processing', 'unknown']).executeTakeFirst()
    if (active) return 'skipped'
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
    await trx.updateTable('order_item_fulfillment_attempts').set({
      status: 'failed',
      failure_code: 'CODE_POOL_DATA_INCONSISTENT',
      retry_after: new Date(Date.now() + retryDelay(Number(priorFailures.count) + 1)),
      completed_at: new Date(),
    }).where('id', '=', attemptId).execute()
    return 'failed'
  })
}

async function attemptDelivery(
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

/**
 * Database-only delivery is safe to retry: reservations and deliveries commit
 * with the existing fulfillment-attempt transition and inventory consumption.
 * SKIP LOCKED distributes orders between API instances; first startup pass
 * resumes any processing item without a live or scheduled attempt.
 */
export function startCodePoolDeliveryWorker(
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
              logger.warn({ orderId: candidate.order_id, orderItemId: candidate.order_item_id }, 'code-pool delivery requires retry')
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
            }, 'code-pool delivery transaction failed; item remains eligible for recovery')
          }
        }
      } catch (error) {
        const candidateError = error && typeof error === 'object'
          ? error as { code?: unknown; name?: unknown }
          : {}
        logger.warn({
          errorName: typeof candidateError.name === 'string' ? candidateError.name : 'unknown',
          databaseCode: typeof candidateError.code === 'string' ? candidateError.code : undefined,
        }, 'code-pool delivery recovery scan failed')
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
