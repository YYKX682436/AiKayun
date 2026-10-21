import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  ApiErrorSchema,
  PrivateFileDownloadParamsSchema,
  failure,
} from '@aikayun/contracts'
import { optionalCustomer, requireCustomer } from '../auth/customer.js'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { PrivateFileError, PrivateFileStorage } from '../media/private-file-storage.js'
import { assertCustomerSession, assertGuestSession, guestSessionCookie } from './orders.js'

interface AuthorizedDownload {
  order_status: string
  total_amount: string
  confirmed_amount: string
  customer_id: string | null
  guest_order_session_id: string | null
  item_method: string
  item_version_id: string | null
  fulfilled_quantity: number
  delivery_unit_index: number
  attempt_status: string
  delivery_source: string
  delivery_version_id: string | null
  delivery_digest: string
  version_id: string | null
  version_method: string | null
  version_digest: string | null
  display_filename: string | null
  object_id: string | null
  object_status: string | null
  size_bytes: number | null
  sha256: string | null
  media_type: string | null
  current_version_id: string | null
}

class DownloadAuthorizationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DownloadAuthorizationError'
  }
}

function errorReply(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof DownloadAuthorizationError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof PrivateFileError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  return reply.code(500).send(failure('PRIVATE_FILE_DOWNLOAD_FAILED', '文件暂时无法下载，请稍后重试。', requestId))
}

function resolveRange(value: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (value === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return 'invalid'
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return 'invalid'
  }
  return { start, end: Math.min(end, size - 1) }
}

function encodedFilename(filename: string): { fallback: string; extended: string } {
  const fallback = filename.normalize('NFC').replace(/[^\x20-\x7E]|["\\]/gu, '_').replace(/[;\r\n]/gu, '_')
  const extended = encodeURIComponent(filename.normalize('NFC')).replace(/['()*]/gu, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return { fallback: fallback || 'download', extended }
}

async function download(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Kysely<Database>,
  config: AppConfig,
  owner: 'customer' | 'guest',
): Promise<unknown> {
  const params = request.params as { orderId: string; itemId: string; deliveryId: string }
  const isHead = request.method === 'HEAD'
  let record: AuthorizedDownload | undefined
  try {
    record = await db.transaction().execute(async (trx) => {
      let customerId: string | undefined
      let guestSessionId: string | undefined
      if (owner === 'customer') {
        if (!request.customer) throw new DownloadAuthorizationError(401, 'UNAUTHORIZED', '请登录后下载订单文件。')
        await assertCustomerSession(trx, request.customer)
        customerId = request.customer.id
      } else {
        if (request.customer) throw new DownloadAuthorizationError(403, 'GUEST_SESSION_REQUIRED', '请使用创建订单时的游客会话下载文件。')
        guestSessionId = await assertGuestSession(trx, request.cookies[guestSessionCookie])
      }

      const result = await sql<AuthorizedDownload>`
        SELECT order_row.status AS order_status, order_row.total_amount::text AS total_amount,
          COALESCE((SELECT sum(receipt.amount) FROM payment_attempts AS payment_attempt
            JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment_attempt.id
            WHERE payment_attempt.order_id = order_row.id AND payment_attempt.status = 'succeeded'
              AND receipt.disposition = 'on_time'), 0)::text AS confirmed_amount,
          order_row.customer_id, order_row.guest_order_session_id,
          item.fulfillment_method_snapshot AS item_method,
          item.fulfillment_content_version_id AS item_version_id,
          item.fulfilled_quantity,
          delivery.unit_index AS delivery_unit_index,
          attempt.status AS attempt_status,
          delivery.delivery_source, delivery.fulfillment_content_version_id AS delivery_version_id,
          delivery.content_sha256 AS delivery_digest,
          version.id AS version_id, version.method AS version_method,
          version.content_sha256 AS version_digest, version.display_filename,
          object.id AS object_id, object.status AS object_status, object.size_bytes,
          object.sha256, object.media_type,
          fulfillment.current_content_version_id AS current_version_id
        FROM orders AS order_row
        JOIN order_items AS item ON item.order_id = order_row.id
        JOIN order_item_fulfillment_deliveries AS delivery ON delivery.id = ${params.deliveryId}::uuid
        JOIN order_item_fulfillment_attempts AS attempt ON attempt.id = delivery.fulfillment_attempt_id
        LEFT JOIN product_variant_fulfillment_versions AS version ON version.id = delivery.fulfillment_content_version_id
        LEFT JOIN private_file_objects AS object ON object.id = version.private_file_object_id
        LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = item.product_variant_id
        WHERE order_row.id = ${params.orderId}::uuid
          AND item.id = ${params.itemId}::uuid
          AND delivery.fulfillment_attempt_id = attempt.id
          AND attempt.order_item_id = item.id
      `.execute(trx)
      const row = result.rows[0]
      const ownsOrder = row && (owner === 'customer'
        ? row.customer_id === customerId
        : row.guest_order_session_id === guestSessionId)
      if (!row || !ownsOrder) {
        throw new DownloadAuthorizationError(404, 'DELIVERY_NOT_FOUND', '找不到可下载的订单文件。')
      }
      if (row.order_status !== 'processing' && row.order_status !== 'completed') {
        throw new DownloadAuthorizationError(404, 'DELIVERY_NOT_FOUND', '找不到可下载的订单文件。')
      }
      if (row.total_amount !== '0.00' && row.confirmed_amount !== row.total_amount) {
        throw new DownloadAuthorizationError(404, 'DELIVERY_NOT_FOUND', '找不到可下载的订单文件。')
      }
      const blocked = await sql<{ blocked: boolean }>`
        SELECT order_has_unresolved_payment_attempts(${params.orderId}::uuid)
          OR EXISTS (
            SELECT 1 FROM payment_attempts AS payment_attempt
            JOIN payment_provider_reconciliation_cases AS reconciliation
              ON reconciliation.payment_attempt_id = payment_attempt.id
            WHERE payment_attempt.order_id = ${params.orderId}::uuid AND reconciliation.state = 'open'
          ) AS blocked
      `.execute(trx)
      if (blocked.rows[0]?.blocked) {
        throw new DownloadAuthorizationError(404, 'DELIVERY_NOT_FOUND', '找不到可下载的订单文件。')
      }
      if (row.item_method !== 'file' || !row.item_version_id
        || row.item_version_id !== row.delivery_version_id
        || row.delivery_source !== 'file' || row.attempt_status !== 'succeeded'
        || row.delivery_unit_index < 1 || row.delivery_unit_index > row.fulfilled_quantity
        || !row.version_id || row.version_id !== row.item_version_id || row.version_method !== 'file'
        || !row.object_id || !row.display_filename || !row.media_type || row.size_bytes === null || !row.sha256
        || !row.version_digest || row.version_digest.trim() !== row.sha256.trim()
        || row.delivery_digest.trim() !== row.version_digest.trim()) {
        throw new DownloadAuthorizationError(404, 'DELIVERY_NOT_FOUND', '找不到可下载的订单文件。')
      }
      return row
    })

    if (!record) throw new DownloadAuthorizationError(404, 'DELIVERY_NOT_FOUND', '找不到可下载的订单文件。')
    if (record.object_status !== 'available') {
      throw new DownloadAuthorizationError(410, 'PRIVATE_FILE_UNAVAILABLE', '此订单文件暂时无法读取，请联系商城客服。')
    }
    const storage = new PrivateFileStorage(config.privateFileRoot)
    let opened: Awaited<ReturnType<typeof storage.openVerified>>
    try {
      opened = await storage.openVerified(record.object_id!, {
        sizeBytes: record.size_bytes!, sha256: record.sha256!.trim(),
      })
    } catch (error) {
      const integrity = error instanceof PrivateFileError && error.code === 'PRIVATE_FILE_INTEGRITY_FAILED'
      await db.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: false })
        .where('method', '=', 'file').where('current_content_version_id', '=', record.version_id!)
        .where('automatic_delivery_ready', '=', true).execute().catch(() => undefined)
      await db.updateTable('private_file_objects').set({ status: integrity ? 'corrupt' : 'missing' })
        .where('id', '=', record.object_id!).where('status', '=', 'available').execute().catch(() => undefined)
      if (error instanceof PrivateFileError) throw error
      throw new PrivateFileError('PRIVATE_FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。', 410)
    }

    reply.header('cache-control', 'private, no-store, max-age=0')
    reply.header('pragma', 'no-cache')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('accept-ranges', 'bytes')
    reply.header('content-type', record.media_type!)
    const name = encodedFilename(record.display_filename!)
    reply.header('content-disposition', `attachment; filename="${name.fallback}"; filename*=UTF-8''${name.extended}`)

    const range = isHead ? null : resolveRange(request.headers.range, record.size_bytes!)
    if (range === 'invalid') {
      await opened.handle.close()
      reply.header('content-range', `bytes */${record.size_bytes}`)
      reply.header('content-type', 'application/json; charset=utf-8')
      return reply.code(416).send(failure('RANGE_NOT_SATISFIABLE', '请求的文件范围无效。', request.id))
    }
    if (range) {
      const length = range.end - range.start + 1
      reply.code(206)
      reply.header('content-range', `bytes ${range.start}-${range.end}/${record.size_bytes}`)
      reply.header('content-length', String(length))
      if (isHead) {
        await opened.handle.close()
        return reply.send()
      }
      const stream = opened.handle.createReadStream({ start: range.start, end: range.end, autoClose: false })
      let fileClosed = false
      const closeFile = () => {
        if (fileClosed) return
        fileClosed = true
        void opened.handle.close().catch(() => undefined)
      }
      stream.once('end', closeFile)
      stream.once('close', closeFile)
      stream.once('error', closeFile)
      reply.raw.once('close', closeFile)
      return reply.send(stream)
    }

    reply.header('content-length', String(record.size_bytes))
    if (isHead) {
      await opened.handle.close()
      reply.hijack()
      reply.raw.setHeader('cache-control', 'private, no-store, max-age=0')
      reply.raw.setHeader('pragma', 'no-cache')
      reply.raw.setHeader('x-content-type-options', 'nosniff')
      reply.raw.setHeader('accept-ranges', 'bytes')
      reply.raw.setHeader('content-type', record.media_type!)
      reply.raw.setHeader('content-disposition', `attachment; filename="${name.fallback}"; filename*=UTF-8''${name.extended}`)
      reply.raw.setHeader('content-length', String(record.size_bytes))
      reply.raw.end()
      return reply
    }
    const stream = opened.handle.createReadStream({ start: 0, end: record.size_bytes! - 1, autoClose: false })
    let fileClosed = false
    const closeFile = () => {
      if (fileClosed) return
      fileClosed = true
      void opened.handle.close().catch(() => undefined)
    }
    stream.once('end', closeFile)
    stream.once('close', closeFile)
    stream.once('error', closeFile)
    reply.raw.once('close', closeFile)
    return reply.send(stream)
  } catch (error) {
    if (error instanceof Error && error.name === 'OrderError') {
      return reply.code(401).send(failure('GUEST_SESSION_REQUIRED', '游客订单会话无效或已过期。', request.id))
    }
    return errorReply(reply, error, request.id)
  }
}

export function registerPrivateFileDownloadRoutes(
  app: FastifyInstance, db: Kysely<Database>, config: AppConfig,
): void {
  const customerAuth = requireCustomer(db, config)
  const guestAuth = optionalCustomer(db, config)
  const params = PrivateFileDownloadParamsSchema
  // Fastify exposes HEAD automatically for each GET route and invokes the same
  // authorization handler, which suppresses the response body after validation.
  for (const method of ['GET'] as const) {
    app.route({
      method,
      url: '/api/v1/customer/orders/:orderId/items/:itemId/deliveries/:deliveryId/file',
      preHandler: customerAuth,
      schema: { tags: ['customer'], summary: 'Download a file from a successfully delivered customer order', params,
        response: { 401: ApiErrorSchema, 404: ApiErrorSchema, 410: ApiErrorSchema, 416: ApiErrorSchema } },
      handler: (request, reply) => download(request, reply, db, config, 'customer'),
    })
    app.route({
      method,
      url: '/api/v1/guest/orders/:orderId/items/:itemId/deliveries/:deliveryId/file',
      preHandler: guestAuth,
      schema: { tags: ['customer'], summary: 'Download a file from a successfully delivered guest order', params,
        response: { 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 410: ApiErrorSchema, 416: ApiErrorSchema } },
      handler: (request, reply) => download(request, reply, db, config, 'guest'),
    })
  }
}
