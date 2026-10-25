import multipart from '@fastify/multipart'
import { Type } from 'typebox'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  PurchaseDraftAttachmentUploadSchema,
  PurchaseDraftCreateBodySchema,
  PurchaseDraftDeleteBodySchema,
  PurchaseDraftSaveBodySchema,
  PurchaseDraftSchema,
  PurchaseDraftValidationBodySchema,
  PurchaseDraftValidationSchema,
  StorefrontPurchaseFormSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { optionalCustomer, CUSTOMER_CSRF_COOKIE } from '../auth/customer.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import { PurchaseAttachmentError, PurchaseAttachmentStorage, PURCHASE_ATTACHMENT_REQUEST_LIMIT_BYTES } from '../media/purchase-attachment-storage.js'
import { effectivePurchaseFormForSku } from './purchase-form-config.js'
import {
  PurchaseDraftServiceError,
  createPurchaseDraftInTransaction,
  claimGuestPurchaseDraftsInTransaction,
  getPurchaseDraft,
  inspectPurchaseDraftCompleteness,
  readPurchaseDraftAttachment,
  releaseUnreferencedPurchaseDraftAttachment,
  requestPurchaseDraftAttachmentDeletion,
  requestPurchaseDraftDeletion,
  savePurchaseDraftInTransaction,
  uploadPurchaseDraftAttachment,
  validateAndLockPurchaseDraftOwner,
  validatePurchaseDraftForPurchaseInTransaction,
  type PurchaseDraftOwner,
} from './purchase-forms.js'
import { guestSessionCookie } from './orders.js'

const DraftIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false })
const DraftAttachmentParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }), attachmentId: Type.String({ format: 'uuid' }) }, { additionalProperties: false })
const safeDraftMutationSchema = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  complete: Type.Optional(Type.Boolean()),
  incompleteFieldIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }))),
}, { additionalProperties: false })
const draftCreatedSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  templateVersionId: Type.String({ format: 'uuid' }),
  revision: Type.Integer({ minimum: 1 }),
  expiresAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
const deletedSchema = Type.Object({ deleted: Type.Literal(true) }, { additionalProperties: false })
const releaseSchema = Type.Object({ released: Type.Boolean() }, { additionalProperties: false })
const draftRecoveryListSchema = Type.Array(Type.Object({
  id: Type.String({ format: 'uuid' }),
  templateVersionId: Type.String({ format: 'uuid' }),
  revision: Type.Integer({ minimum: 1 }),
  expiresAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  templateChanged: Type.Boolean(),
}, { additionalProperties: false }), { maxItems: 50 })
const selectedDraftClaimBodySchema = Type.Object({
  skuId: Type.String({ format: 'uuid' }),
  expectedRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })
const selectedDraftClaimResultSchema = Type.Object({
  draftId: Type.String({ format: 'uuid' }),
  skuId: Type.String({ format: 'uuid' }),
  templateVersionId: Type.String({ format: 'uuid' }),
  revision: Type.Integer({ minimum: 1 }),
  complete: Type.Literal(true),
}, { additionalProperties: false })

function ownerForRequest(request: FastifyRequest): PurchaseDraftOwner {
  if (request.customer) return { kind: 'customer', customer: request.customer }
  const guestSessionToken = request.cookies[guestSessionCookie]
  if (!guestSessionToken) throw new PurchaseDraftServiceError(401, 'GUEST_SESSION_REQUIRED', '请先建立游客订单会话。')
  return { kind: 'guest', guestSessionToken }
}

function routeError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof PurchaseDraftServiceError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId, error.fieldIds))
  }
  if (error instanceof PurchaseAttachmentError) {
    const status = error.code.includes('TOO_LARGE') ? 413
      : error.code.includes('FORMAT') || error.code.includes('MIME') ? 415 : 400
    return reply.code(status).send(failure(error.code, error.message, requestId))
  }
  return reply.code(500).send(failure('INTERNAL_ERROR', '服务器暂时无法处理此请求。', requestId))
}

function draftResponse(view: Awaited<ReturnType<typeof getPurchaseDraft>>, skuId: string) {
  return {
    id: view.id,
    skuId,
    templateVersionId: view.templateVersionId,
    revision: view.revision,
    normalizationVersion: view.normalizationVersion,
    expiresAt: view.expiresAt,
    values: view.values,
    templateChanged: view.templateChanged,
    attachments: view.attachments.map(attachment => ({
      id: attachment.id,
      fieldId: attachment.field_id,
      mimeType: 'image/webp' as const,
      byteSize: attachment.byte_size!,
      width: attachment.width!,
      height: attachment.height!,
      ...(attachment.replaces_attachment_id ? { replacesAttachmentId: attachment.replaces_attachment_id } : {}),
      url: `/api/v1/storefront/purchase-drafts/${view.id}/attachments/${attachment.id}`,
    })),
  }
}

export async function registerCustomerPurchaseFormRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
): Promise<void> {
  const optionalCustomerAuth = optionalCustomer(db, config)
  const customerCsrf = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)
  const storage = new PurchaseAttachmentStorage(config.privateFileRoot)

  app.get('/api/v1/storefront/skus/:skuId/purchase-form', {
    schema: {
      tags: ['public-storefront'], summary: 'Read the currently applied purchase form for one SKU',
      params: Type.Object({ skuId: Type.String({ format: 'uuid' }) }, { additionalProperties: false }),
      response: { 200: ApiSuccessSchemaOf(StorefrontPurchaseFormSchema), 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { skuId } = request.params as { skuId: string }
      const effective = await effectivePurchaseFormForSku(db, skuId)
      if (!effective.templateVersionId || !effective.definition) {
        reply.header('cache-control', 'no-store')
        return success({ skuId, status: effective.status, required: false, templateVersionId: null,
          templateName: null, versionNumber: null, definition: null }, request.id)
      }
      reply.header('cache-control', 'private, no-store')
      return success({ skuId, status: effective.status, required: true,
        templateVersionId: effective.templateVersionId, templateName: effective.templateName,
        versionNumber: effective.versionNumber, definition: effective.definition }, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.get('/api/v1/storefront/skus/:skuId/purchase-drafts', {
    preHandler: optionalCustomerAuth,
    schema: {
      tags: ['customer'], summary: 'List safe recovery metadata for the caller-owned drafts of the current SKU form',
      params: Type.Object({ skuId: Type.String({ format: 'uuid' }) }, { additionalProperties: false }),
      response: { 200: ApiSuccessSchemaOf(draftRecoveryListSchema), 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { skuId } = request.params as { skuId: string }
      if (!request.customer && !request.cookies[guestSessionCookie]) {
        reply.header('cache-control', 'private, no-store')
        return success([], request.id)
      }
      const owner = ownerForRequest(request)
      const candidates = await db.transaction().execute(async trx => {
        const effective = await effectivePurchaseFormForSku(trx, skuId, { lockStatus: 'share' })
        if (!effective.templateId || !effective.templateVersionId) return []
        const identity = await validateAndLockPurchaseDraftOwner(trx, owner, 'share')
        let query = trx.selectFrom('purchase_drafts as draft')
          .innerJoin('purchase_form_template_versions as version', 'version.id', 'draft.template_version_id')
          .select(['draft.id', 'draft.template_version_id', 'draft.revision', 'draft.expires_at', 'draft.updated_at'])
          .where('version.template_id', '=', effective.templateId)
          .where('draft.status', '=', 'active').where('draft.expires_at', '>', new Date())
        query = identity.kind === 'customer'
          ? query.where('draft.customer_id', '=', identity.customerId).where('draft.guest_order_session_id', 'is', null)
          : query.where('draft.guest_order_session_id', '=', identity.guestSessionId).where('draft.customer_id', 'is', null)
        const rows = await query.orderBy('draft.updated_at', 'desc').orderBy('draft.id').limit(50).execute()
        const bound = identity.kind === 'customer' && rows.length
          ? new Set((await trx.selectFrom('customer_cart_items').select('draft_id')
            .where('customer_id', '=', identity.customerId).where('draft_id', 'in', rows.map(row => row.id)).execute())
            .flatMap(row => row.draft_id ? [row.draft_id] : []))
          : new Set<string>()
        return rows.filter(row => !bound.has(row.id)).map(row => ({
          id: row.id,
          templateVersionId: row.template_version_id,
          revision: row.revision,
          expiresAt: row.expires_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          templateChanged: row.template_version_id !== effective.templateVersionId,
        }))
      })
      reply.header('cache-control', 'private, no-store')
      return success(candidates, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.post('/api/v1/storefront/purchase-drafts', {
    logLevel: 'silent', preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['customer'], summary: 'Create an owner-bound draft from the current applied SKU form',
      body: PurchaseDraftCreateBodySchema,
      response: { 201: ApiSuccessSchemaOf(draftCreatedSchema), 400: ApiErrorSchema, 401: ApiErrorSchema,
        403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { skuId } = request.body as { skuId: string }
      const owner = ownerForRequest(request)
      const { draft, templateVersionId } = await db.transaction().execute(async trx => {
        const effective = await effectivePurchaseFormForSku(trx, skuId, { lockStatus: 'share' })
        if (!effective.templateVersionId) throw new PurchaseDraftServiceError(409,
          effective.status === 'preparing' ? 'PURCHASE_FORM_NOT_ACTIVE' : 'PURCHASE_FORM_NOT_CONFIGURED',
          '此 SKU 当前没有可填写的正式购买模板。')
        return {
          draft: await createPurchaseDraftInTransaction(trx, config, owner, effective.templateVersionId),
          templateVersionId: effective.templateVersionId,
        }
      })
      reply.header('cache-control', 'private, no-store')
      return reply.code(201).send(success({ ...draft, templateVersionId }, request.id))
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.get('/api/v1/storefront/purchase-drafts/:id', {
    preHandler: optionalCustomerAuth,
    schema: { tags: ['customer'], summary: 'Read the caller-owned purchase draft for its current SKU',
      params: DraftIdParamsSchema,
      querystring: Type.Object({ skuId: Type.String({ format: 'uuid' }) }, { additionalProperties: false }),
      response: { 200: ApiSuccessSchemaOf(PurchaseDraftSchema), 401: ApiErrorSchema, 404: ApiErrorSchema,
        409: ApiErrorSchema, 410: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { skuId } = request.query as { skuId: string }
      const view = await getPurchaseDraft(db, config, ownerForRequest(request), id, skuId)
      reply.header('cache-control', 'private, no-store')
      return success(draftResponse(view, skuId), request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/purchase-drafts/:id/claim-selected', {
    logLevel: 'silent', preHandler: [optionalCustomerAuth, customerCsrf],
    schema: {
      tags: ['customer'], summary: 'Claim only the guest draft explicitly selected for direct checkout',
      params: DraftIdParamsSchema, body: selectedDraftClaimBodySchema,
      response: { 200: ApiSuccessSchemaOf(selectedDraftClaimResultSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 410: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const customer = request.customer
      if (!customer) throw new PurchaseDraftServiceError(401, 'UNAUTHORIZED', '请先登录后继续购买。')
      const guestSessionToken = request.cookies[guestSessionCookie]
      if (!guestSessionToken) throw new PurchaseDraftServiceError(401, 'GUEST_SESSION_REQUIRED', '原游客会话已失效，请返回原页面重新确认。')
      const { id } = request.params as { id: string }
      const body = request.body as { skuId: string; expectedRevision: number }
      const result = await db.transaction().execute(async trx => {
        // Reuse the one-way guest claim primitive. Its already-claimed branch
        // makes a repeated redirect or a lost response safe and idempotent.
        const claimed = await claimGuestPurchaseDraftsInTransaction(trx, customer, guestSessionToken, [{
          draftId: id, expectedRevision: body.expectedRevision,
        }])
        const effective = await effectivePurchaseFormForSku(trx, body.skuId, { lockStatus: 'share' })
        if (!effective.templateVersionId) {
          throw new PurchaseDraftServiceError(409, 'PURCHASE_TEMPLATE_VERSION_CONFLICT', '购买模板已变化，请返回商品页重新填写。')
        }
        const revision = claimed.revisions[id]
        if (!revision) throw new PurchaseDraftServiceError(404, 'PURCHASE_DRAFT_NOT_FOUND', '找不到这份可认领的购买资料。')
        const validated = await validatePurchaseDraftForPurchaseInTransaction(trx, config,
          { kind: 'customer', customer }, {
            draftId: id, expectedRevision: revision, expectedTemplateVersionId: effective.templateVersionId,
          }, 'update')
        return { draftId: id, skuId: body.skuId, templateVersionId: validated.templateVersionId,
          revision: validated.revision, complete: true as const }
      })
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.put('/api/v1/storefront/purchase-drafts/:id', {
    logLevel: 'silent', preHandler: [optionalCustomerAuth, customerCsrf],
    schema: { tags: ['customer'], summary: 'Save partial purchase form answers with an expected draft revision',
      params: DraftIdParamsSchema, body: PurchaseDraftSaveBodySchema,
      response: { 200: ApiSuccessSchemaOf(safeDraftMutationSchema), 400: ApiErrorSchema, 401: ApiErrorSchema,
        403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 410: ApiErrorSchema, 413: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { skuId: string; expectedRevision: number; values: Record<string, unknown>; replacements?: Array<{ oldAttachmentId: string; newAttachmentId: string }> }
      const owner = ownerForRequest(request)
      const result = await db.transaction().execute(async trx => {
        const effective = await effectivePurchaseFormForSku(trx, body.skuId, { lockStatus: 'share' })
        if (!effective.templateVersionId) throw new PurchaseDraftServiceError(409, 'PURCHASE_FORM_NOT_ACTIVE', '当前 SKU 没有可用的正式填写模板。')
        return savePurchaseDraftInTransaction(trx, config, owner, {
          draftId: id, expectedRevision: body.expectedRevision, values: body.values,
        }, {
          expectedTemplateVersionId: effective.templateVersionId,
          ...(body.replacements ? { replacements: body.replacements } : {}),
        })
      })
      for (const attachmentId of result.replacedAttachmentIds ?? []) {
        const row = await db.selectFrom('purchase_draft_attachments').select(['id', 'storage_key'])
          .where('id', '=', attachmentId).where('status', '=', 'deleting').executeTakeFirst()
        if (row) {
          try {
            await storage.remove(row.id, row.storage_key)
            await db.deleteFrom('purchase_draft_attachments').where('id', '=', row.id).where('status', '=', 'deleting').execute()
          } catch { /* a deleting row remains available to the existing reconciler */ }
        }
      }
      reply.header('cache-control', 'private, no-store')
      return success({ revision: result.revision, complete: result.complete,
        incompleteFieldIds: result.incompleteFieldIds }, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.post('/api/v1/storefront/purchase-drafts/:id/validate', {
    logLevel: 'silent', preHandler: [optionalCustomerAuth, customerCsrf],
    schema: { tags: ['customer'], summary: 'Explicitly validate draft completeness before quoting',
      params: DraftIdParamsSchema, body: PurchaseDraftValidationBodySchema,
      response: { 200: ApiSuccessSchemaOf(Type.Intersect([Type.Object({ revision: Type.Integer({ minimum: 1 }) }), PurchaseDraftValidationSchema])), 400: ApiErrorSchema, 401: ApiErrorSchema,
        403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 410: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { expectedRevision } = request.body as { expectedRevision: number }
      const result = await inspectPurchaseDraftCompleteness(db, config, ownerForRequest(request), id, expectedRevision)
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.delete('/api/v1/storefront/purchase-drafts/:id', {
    logLevel: 'silent', preHandler: [optionalCustomerAuth, customerCsrf],
    schema: { tags: ['customer'], summary: 'Delete an unbound owner purchase draft',
      params: DraftIdParamsSchema, body: PurchaseDraftDeleteBodySchema,
      response: { 200: ApiSuccessSchemaOf(deletedSchema), 401: ApiErrorSchema, 403: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 410: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { expectedRevision } = request.body as { expectedRevision: number }
      await requestPurchaseDraftDeletion(db, ownerForRequest(request), id, expectedRevision)
      reply.header('cache-control', 'no-store')
      return success({ deleted: true }, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  await app.register(async scope => {
   await scope.register(multipart, { limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 4, parts: 5 }, throwFileSizeLimit: false })
   scope.post('/api/v1/storefront/purchase-drafts/:id/attachments', {
    logLevel: 'silent', bodyLimit: PURCHASE_ATTACHMENT_REQUEST_LIMIT_BYTES,
    preHandler: [optionalCustomerAuth, customerCsrf],
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    schema: { tags: ['customer'], summary: 'Upload a validated private image to an owner-bound draft',
      consumes: ['multipart/form-data'], params: DraftIdParamsSchema,
      response: { 201: ApiSuccessSchemaOf(PurchaseDraftAttachmentUploadSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
        410: ApiErrorSchema, 413: ApiErrorSchema, 415: ApiErrorSchema, 429: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const fields: Record<string, string> = {}
      let file: { bytes: Buffer; mimetype: string; size: number } | undefined
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || file) throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_REQUEST_INVALID', '图片上传请求无效。')
          file = { bytes: await part.toBuffer(), mimetype: part.mimetype, size: part.file.bytesRead }
        } else {
          if (!['skuId', 'expectedRevision', 'fieldId', 'replaceAttachmentId'].includes(part.fieldname)
            || fields[part.fieldname] !== undefined) throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_REQUEST_INVALID', '图片上传请求无效。')
          fields[part.fieldname] = String(part.value)
        }
      }
      const revision = Number(fields.expectedRevision)
      if (!file || !Number.isSafeInteger(revision) || revision < 1 || !fields.fieldId || !fields.skuId) {
        throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_REQUEST_INVALID', '图片上传请求无效。')
      }
      const uploaded = await uploadPurchaseDraftAttachment(db, config, storage, ownerForRequest(request), {
        draftId: id, skuId: fields.skuId, expectedRevision: revision, fieldId: fields.fieldId, claimedMimeType: file.mimetype,
        expectedBytes: file.size, ...(fields.replaceAttachmentId ? { replaceAttachmentId: fields.replaceAttachmentId } : {}),
        stream: (async function* () { yield file.bytes })(),
      })
      reply.header('cache-control', 'private, no-store')
      return reply.code(201).send(success(uploaded, request.id))
    } catch (error) { return routeError(error, reply, request.id) }
  })
  })

  app.get('/api/v1/storefront/purchase-drafts/:id/attachments/:attachmentId', {
    preHandler: optionalCustomerAuth,
    schema: { tags: ['customer'], summary: 'Read one private image owned by the current draft owner',
      params: DraftAttachmentParamsSchema,
      response: { 401: ApiErrorSchema, 404: ApiErrorSchema, 410: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id, attachmentId } = request.params as { id: string; attachmentId: string }
      const image = await readPurchaseDraftAttachment(db, storage, ownerForRequest(request), id, attachmentId)
      reply.header('cache-control', 'private, no-store')
      reply.header('content-type', image.mimeType)
      reply.header('content-length', String(image.byteSize))
      reply.header('content-disposition', 'inline; filename="purchase-image.webp"')
      reply.header('x-content-type-options', 'nosniff')
      reply.header('content-security-policy', "default-src 'none'; sandbox")
      return reply.send(image.bytes)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.delete('/api/v1/storefront/purchase-drafts/:id/attachments/:attachmentId', {
    logLevel: 'silent', preHandler: [optionalCustomerAuth, customerCsrf],
    schema: { tags: ['customer'], summary: 'Delete an unreferenced private draft image',
      params: DraftAttachmentParamsSchema,
      body: PurchaseDraftDeleteBodySchema,
      response: { 200: ApiSuccessSchemaOf(safeDraftMutationSchema), 401: ApiErrorSchema, 403: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 410: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const { id, attachmentId } = request.params as { id: string; attachmentId: string }
      const { expectedRevision } = request.body as { expectedRevision: number }
      const result = await requestPurchaseDraftAttachmentDeletion(db, ownerForRequest(request), id, attachmentId, expectedRevision)
      reply.header('cache-control', 'no-store')
      return success({ revision: result.revision }, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })

  app.post('/api/v1/storefront/purchase-drafts/:id/attachments/:attachmentId/release', {
    logLevel: 'silent', preHandler: [optionalCustomerAuth, customerCsrf],
    schema: {
      tags: ['customer'], summary: 'Release an unreferenced ready draft image after a failed save',
      params: DraftAttachmentParamsSchema, body: Type.Object({}, { additionalProperties: false }),
      response: { 200: ApiSuccessSchemaOf(releaseSchema), 401: ApiErrorSchema, 404: ApiErrorSchema,
        409: ApiErrorSchema, 410: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { id, attachmentId } = request.params as { id: string; attachmentId: string }
      const result = await releaseUnreferencedPurchaseDraftAttachment(
        db, storage, ownerForRequest(request), id, attachmentId,
      )
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return routeError(error, reply, request.id) }
  })
}
