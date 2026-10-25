import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely, Selectable } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ProductPurchaseFormAssignmentBodySchema,
  ProductPurchaseFormAssignmentSchema,
  ProductPurchaseFormParamsSchema,
  PurchaseTemplateCreateBodySchema,
  PurchaseTemplateDetailSchema,
  PurchaseTemplateFreezeBodySchema,
  PurchaseTemplateIdParamsSchema,
  PurchaseTemplateListQuerySchema,
  PurchaseTemplateListSchema,
  PurchaseTemplateMutationSchema,
  PurchaseTemplateUpdateBodySchema,
  PurchaseTemplateVersionParamsSchema,
  PurchaseTemplateVersionSchema,
  PurchaseTemplateVersionsQuerySchema,
  PurchaseTemplateVersionsSchema,
  SkuPurchaseFormAssignmentBodySchema,
  SkuPurchaseFormAssignmentSchema,
  SkuPurchaseFormParamsSchema,
  failure,
  success,
  validatePurchaseFormDefinition,
  canonicalPurchaseFormJson,
} from '@aikayun/contracts'
import type {
  ProductPurchaseFormAssignmentBody,
  PurchaseFormDefinition,
  PurchaseTemplateCreateBody,
  PurchaseTemplateListQuery,
  PurchaseTemplateUpdateBody,
  PurchaseTemplateVersionsQuery,
  SkuPurchaseFormAssignmentBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database, PurchaseFormTemplateIdentitiesTable, PurchaseFormTemplateOperation } from '../db/types.js'
import { CatalogError, catalogDatabaseFailure, sendCatalogError } from './errors.js'
import { assertProductNotArchived, lockProductAtRevision } from './admin-product-guards.js'
import { effectivePurchaseFormForSku, readPurchaseFormsStatus } from '../commerce/purchase-form-config.js'

const templateNameMaxCharacters = 120
const defaultPageSize = 50

type IdentityEntry = Pick<PurchaseFormTemplateIdentitiesTable, 'id' | 'identity_kind' | 'meaning_key' | 'semantic_type' | 'parent_id'>

class PurchaseTemplateAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'PurchaseTemplateAdminError'
  }
}

function validTemplateName(value: string): string {
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > templateNameMaxCharacters) {
    throw new PurchaseTemplateAdminError(400, 'PURCHASE_TEMPLATE_NAME_INVALID', '模板名称不能为空，且最多 120 个字符。')
  }
  return normalized
}

function validDefinition(value: unknown): PurchaseFormDefinition {
  const result = validatePurchaseFormDefinition(value)
  if (!result.ok) {
    throw new PurchaseTemplateAdminError(400, 'PURCHASE_TEMPLATE_DEFINITION_INVALID', '模板字段结构或资源上限不符合要求。')
  }
  return result.value
}

function countFields(definition: PurchaseFormDefinition): number {
  let count = definition.fields.length
  const options = definition.fields.flatMap(field => field.type === 'cascade' ? field.options : [])
  const stack = [...options]
  while (stack.length) {
    const option = stack.pop()!
    count += option.expandedFields?.length ?? 0
    stack.push(...(option.children ?? []))
  }
  return count
}

function identitiesFor(definition: PurchaseFormDefinition): IdentityEntry[] {
  const result: IdentityEntry[] = []
  const addField = (field: Exclude<PurchaseFormDefinition['fields'][number], { type: 'cascade' }>, parentId: string | null) => {
    result.push({ id: field.id.toLowerCase(), identity_kind: 'field', meaning_key: field.meaningKey, semantic_type: field.type, parent_id: parentId })
    if (field.type === 'select') {
      for (const option of field.options) {
        result.push({ id: option.id.toLowerCase(), identity_kind: 'option', meaning_key: option.meaningKey, semantic_type: null, parent_id: field.id.toLowerCase() })
      }
    }
  }
  for (const field of definition.fields) {
    if (field.type !== 'cascade') {
      addField(field, null)
      continue
    }
    result.push({ id: field.id.toLowerCase(), identity_kind: 'field', meaning_key: field.meaningKey, semantic_type: 'cascade', parent_id: null })
    const stack = field.options.map(option => ({ option, parentId: field.id.toLowerCase() }))
    while (stack.length) {
      const { option, parentId } = stack.pop()!
      result.push({ id: option.id.toLowerCase(), identity_kind: 'option', meaning_key: option.meaningKey, semantic_type: null, parent_id: parentId })
      for (const expanded of option.expandedFields ?? []) addField(expanded, option.id.toLowerCase())
      for (const child of option.children ?? []) stack.push({ option: child, parentId: option.id.toLowerCase() })
    }
  }
  return result
}

function assertIdentityContinuity(existing: Array<Selectable<PurchaseFormTemplateIdentitiesTable>>, incoming: IdentityEntry[]): IdentityEntry[] {
  const byId = new Map(existing.map(identity => [identity.id.toLowerCase(), identity]))
  const inserts: IdentityEntry[] = []
  for (const identity of incoming) {
    const prior = byId.get(identity.id.toLowerCase())
    if (!prior) { inserts.push(identity); continue }
    if (prior.identity_kind !== identity.identity_kind || prior.meaning_key !== identity.meaning_key
      || prior.semantic_type !== identity.semantic_type || prior.parent_id?.toLowerCase() !== identity.parent_id?.toLowerCase()) {
      throw new PurchaseTemplateAdminError(409, 'PURCHASE_FORM_IDENTITY_REUSE', '字段或选项的业务含义发生变化，请新建身份后再保存。')
    }
  }
  return inserts
}

function audit(
  db: Kysely<Database>,
  value: {
    administratorId: string
    operation: PurchaseFormTemplateOperation
    templateId?: string
    productId?: string
    productVariantId?: string
    summary: Record<string, unknown>
  },
) {
  return db.insertInto('purchase_form_audit_events').values({
    id: randomUUID(),
    administrator_id: value.administratorId,
    operation: value.operation,
    template_id: value.templateId ?? null,
    product_id: value.productId ?? null,
    product_variant_id: value.productVariantId ?? null,
    summary: value.summary,
  }).execute()
}

function summaryFor(row: {
  id: string; name: string; revision: number; latest_version_number: number; definition: unknown; updated_at: Date
}) {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    latestVersionNumber: row.latest_version_number,
    fieldCount: countFields(validDefinition(row.definition)),
    updatedAt: row.updated_at.toISOString(),
  }
}

function versionResponse(row: {
  id: string; template_id: string; version_number: number; name: string; definition: unknown; sha256: string; created_at: Date
}) {
  return {
    id: row.id,
    templateId: row.template_id,
    versionNumber: row.version_number,
    name: row.name,
    definition: validDefinition(row.definition),
    sha256: row.sha256.trim(),
    createdAt: row.created_at.toISOString(),
  }
}

function fail(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof PurchaseTemplateAdminError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof CatalogError) return sendCatalogError(reply, error, requestId)
  const databaseFailure = catalogDatabaseFailure(error)
  if (databaseFailure) return reply.code(databaseFailure.status).send(failure(databaseFailure.code, databaseFailure.message, requestId))
  return reply.code(500).send(failure('INTERNAL_ERROR', '服务器暂时无法处理此请求。', requestId))
}

async function versionSummary(db: Kysely<Database>, versionId: string | null) {
  if (!versionId) return null
  const row = await db.selectFrom('purchase_form_template_versions')
    .select([
      'id', 'template_id', 'name', 'version_number',
    ]).where('id', '=', versionId).executeTakeFirst()
  if (!row) return null
  return { id: row.id, templateId: row.template_id, templateName: row.name, versionNumber: row.version_number }
}

async function productDefaultAssignment(db: Kysely<Database>, productId: string) {
  const product = await db.selectFrom('products').select(['id', 'revision'])
    .where('id', '=', productId).executeTakeFirst()
  if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
  const row = await db.selectFrom('product_purchase_form_settings').select(['mode', 'template_version_id', 'applied_mode', 'applied_template_version_id'])
    .where('product_id', '=', productId).executeTakeFirst()
  const mode = row?.mode ?? 'not_configured'
  const status = await readPurchaseFormsStatus(db)
  const appliedMode = status === 'preparing' ? null : row?.applied_mode ?? 'none'
  const appliedVersionId = row?.applied_template_version_id ?? null
  return {
    productId,
    productRevision: product.revision,
    mode,
    templateVersion: row?.template_version_id ? await versionSummary(db, row.template_version_id) : null,
    appliedMode,
    appliedTemplateVersion: appliedVersionId ? await versionSummary(db, appliedVersionId) : null,
    pendingApply: status !== 'preparing' && Boolean(row)
      && (row?.applied_mode !== (mode === 'template' ? 'template' : 'none')
        || appliedVersionId !== (mode === 'template' ? row?.template_version_id ?? null : null)),
  }
}

async function skuAssignment(db: Kysely<Database>, productId: string, variantId: string) {
  const product = await productDefaultAssignment(db, productId)
  const variant = await db.selectFrom('product_variants').select('id')
    .where('id', '=', variantId).where('product_id', '=', productId).executeTakeFirst()
  if (!variant) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')
  const row = await db.selectFrom('sku_purchase_form_overrides').select(['mode', 'template_version_id', 'applied_mode', 'applied_template_version_id'])
    .where('product_id', '=', productId).where('product_variant_id', '=', variantId).executeTakeFirst()
  const status = await readPurchaseFormsStatus(db)
  const effective = await effectivePurchaseFormForSku(db, variantId)
  const pendingApply = status !== 'preparing' && Boolean(row)
    && (row?.applied_mode !== (row?.mode === 'product_default' ? null : row?.mode)
      || row?.applied_template_version_id !== (row?.mode === 'template' ? row?.template_version_id ?? null : null))
  return {
    productId,
    variantId,
    productRevision: product.productRevision,
    mode: row?.mode ?? 'product_default',
    templateVersion: row?.template_version_id ? await versionSummary(db, row.template_version_id) : null,
    productDefault: product,
    appliedMode: status === 'preparing' ? null : row?.applied_mode === null || !row ? 'inherit'
      : row.applied_mode,
    appliedTemplateVersion: effective.templateVersionId ? await versionSummary(db, effective.templateVersionId) : null,
    pendingApply,
  }
}

function assertAssignmentBody(mode: string, templateVersionId: string | undefined, supported: string[]): string | null {
  if (!supported.includes(mode)) throw new PurchaseTemplateAdminError(400, 'PURCHASE_FORM_ASSIGNMENT_INVALID', '填写模板关联方式无效。')
  if (mode === 'template') {
    if (!templateVersionId) throw new PurchaseTemplateAdminError(400, 'PURCHASE_FORM_VERSION_REQUIRED', '选择模板版本后才能保存关联。')
    return templateVersionId.toLowerCase()
  }
  if (templateVersionId) throw new PurchaseTemplateAdminError(400, 'PURCHASE_FORM_VERSION_UNEXPECTED', '此关联方式不能携带模板版本。')
  return null
}

async function assertVersionExists(trx: Kysely<Database>, versionId: string | null): Promise<void> {
  if (!versionId) return
  const version = await trx.selectFrom('purchase_form_template_versions').select('id')
    .where('id', '=', versionId).executeTakeFirst()
  if (!version) throw new PurchaseTemplateAdminError(400, 'PURCHASE_FORM_VERSION_NOT_FOUND', '所选模板版本不存在。')
}

export function registerAdminPurchaseFormRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)
  const protectedWrite = [authenticate, csrfCheck]

  app.get('/api/v1/admin/purchase-form-templates', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'List locally prepared purchase form templates',
      querystring: PurchaseTemplateListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseTemplateListSchema), 401: ApiErrorSchema, 400: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const query = (request.query ?? {}) as PurchaseTemplateListQuery
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? defaultPageSize
    try {
      const base = db.selectFrom('purchase_form_templates').select([
        'id', 'name', 'revision', 'latest_version_number', 'definition', 'updated_at',
      ])
      const [items, count] = await Promise.all([
        base.orderBy('updated_at', 'desc').orderBy('id').limit(pageSize).offset((page - 1) * pageSize).execute(),
        db.selectFrom('purchase_form_templates').select(db.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
      ])
      return reply.send(success({
        items: items.map(summaryFor), total: Number(count.total), page, pageSize,
      }, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.post('/api/v1/admin/purchase-form-templates', {
    preHandler: protectedWrite,
    bodyLimit: 64 * 1024,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Create a local purchase form template in preparation state',
      body: PurchaseTemplateCreateBodySchema,
      response: { 201: ApiSuccessSchemaOf(PurchaseTemplateMutationSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const body = request.body as PurchaseTemplateCreateBody
    const administratorId = request.admin!.id
    try {
      const name = validTemplateName(body.name)
      const definition = validDefinition(body.definition)
      const id = randomUUID()
      const saved = await db.transaction().execute(async (trx) => {
        await trx.insertInto('purchase_form_templates').values({
          id, name, definition: definition as unknown as Record<string, unknown>, revision: 1, latest_version_number: 0,
          created_by_admin_id: administratorId, updated_by_admin_id: administratorId,
        }).execute()
        const identities = identitiesFor(definition)
        if (identities.length) await trx.insertInto('purchase_form_template_identities').values(identities.map(identity => ({ ...identity, template_id: id }))).execute()
        await audit(trx, {
          administratorId, operation: 'template_created', templateId: id,
          summary: { name, revision: 1, fieldCount: countFields(definition) },
        })
        return trx.selectFrom('purchase_form_templates').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
      })
      reply.code(201)
      return reply.send(success({ template: summaryFor(saved), definition }, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.get('/api/v1/admin/purchase-form-templates/:id', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read a local purchase form template editor state',
      params: PurchaseTemplateIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseTemplateDetailSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const row = await db.selectFrom('purchase_form_templates').selectAll().where('id', '=', id).executeTakeFirst()
      if (!row) throw new PurchaseTemplateAdminError(404, 'PURCHASE_TEMPLATE_NOT_FOUND', '找不到此填写模板。')
      const definition = validDefinition(row.definition)
      const latest = row.latest_version_number > 0
        ? await db.selectFrom('purchase_form_template_versions').selectAll()
          .where('template_id', '=', id).where('version_number', '=', row.latest_version_number).executeTakeFirst()
        : undefined
      return reply.send(success({
        template: summaryFor(row), definition,
        latestVersion: latest ? versionResponse(latest) : null,
      }, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.put('/api/v1/admin/purchase-form-templates/:id', {
    preHandler: protectedWrite,
    bodyLimit: 64 * 1024,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Save a revision-checked local purchase form template draft',
      params: PurchaseTemplateIdParamsSchema,
      body: PurchaseTemplateUpdateBodySchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseTemplateMutationSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as PurchaseTemplateUpdateBody
    const administratorId = request.admin!.id
    try {
      const name = validTemplateName(body.name)
      const definition = validDefinition(body.definition)
      const result = await db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('purchase_form_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
        if (!current) throw new PurchaseTemplateAdminError(404, 'PURCHASE_TEMPLATE_NOT_FOUND', '找不到此填写模板。')
        if (current.revision !== body.expectedRevision) throw new PurchaseTemplateAdminError(409, 'PURCHASE_TEMPLATE_REVISION_CONFLICT', '模板已被其他管理员修改，请重新读取后再保存。')
        const existingIdentities = await trx.selectFrom('purchase_form_template_identities').selectAll().where('template_id', '=', id).execute()
        const incoming = identitiesFor(definition)
        const newIdentities = assertIdentityContinuity(existingIdentities, incoming)
        if (newIdentities.length) await trx.insertInto('purchase_form_template_identities')
          .values(newIdentities.map(identity => ({ ...identity, template_id: id }))).execute()
        const updated = await trx.updateTable('purchase_form_templates').set({
          name, definition: definition as unknown as Record<string, unknown>, updated_by_admin_id: administratorId,
        }).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
        await audit(trx, {
          administratorId, operation: 'template_updated', templateId: id,
          summary: { revision: updated.revision, fieldCount: countFields(definition) },
        })
        return updated
      })
      return reply.send(success({ template: summaryFor(result), definition }, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.get('/api/v1/admin/purchase-form-templates/:id/versions', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'List immutable local purchase form versions',
      params: PurchaseTemplateIdParamsSchema,
      querystring: PurchaseTemplateVersionsQuerySchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseTemplateVersionsSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as PurchaseTemplateVersionsQuery
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? defaultPageSize
    try {
      const template = await db.selectFrom('purchase_form_templates').select('id').where('id', '=', id).executeTakeFirst()
      if (!template) throw new PurchaseTemplateAdminError(404, 'PURCHASE_TEMPLATE_NOT_FOUND', '找不到此填写模板。')
      const [items, count] = await Promise.all([
        db.selectFrom('purchase_form_template_versions').selectAll().where('template_id', '=', id)
          .orderBy('version_number', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute(),
        db.selectFrom('purchase_form_template_versions').select(db.fn.countAll<number>().as('total'))
          .where('template_id', '=', id).executeTakeFirstOrThrow(),
      ])
      return reply.send(success({
        items: items.map(row => ({
          id: row.id, templateId: row.template_id, versionNumber: row.version_number,
          name: row.name, createdAt: row.created_at.toISOString(),
        })), total: Number(count.total), page, pageSize,
      }, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.post('/api/v1/admin/purchase-form-templates/:id/versions', {
    preHandler: protectedWrite,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Freeze a new immutable purchase form template version',
      params: PurchaseTemplateIdParamsSchema,
      body: PurchaseTemplateFreezeBodySchema,
      response: { 201: ApiSuccessSchemaOf(PurchaseTemplateVersionSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { expectedRevision: number }
    const administratorId = request.admin!.id
    try {
      const frozen = await db.transaction().execute(async (trx) => {
        const template = await trx.selectFrom('purchase_form_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
        if (!template) throw new PurchaseTemplateAdminError(404, 'PURCHASE_TEMPLATE_NOT_FOUND', '找不到此填写模板。')
        if (template.revision !== body.expectedRevision) throw new PurchaseTemplateAdminError(409, 'PURCHASE_TEMPLATE_REVISION_CONFLICT', '模板已被其他管理员修改，请重新读取后再保存。')
        const definition = validDefinition(template.definition)
        const versionId = randomUUID()
        const versionNumber = template.latest_version_number + 1
        const sha256 = createHash('sha256').update(canonicalPurchaseFormJson({ name: template.name, definition }), 'utf8').digest('hex')
        const version = await trx.insertInto('purchase_form_template_versions').values({
          id: versionId, template_id: id, version_number: versionNumber, name: template.name,
          definition: definition as unknown as Record<string, unknown>, sha256, created_by_admin_id: administratorId,
        }).returningAll().executeTakeFirstOrThrow()
        const updated = await trx.updateTable('purchase_form_templates').set({
          latest_version_number: versionNumber, updated_by_admin_id: administratorId,
        }).where('id', '=', id).returning('revision').executeTakeFirstOrThrow()
        await audit(trx, {
          administratorId, operation: 'template_version_saved', templateId: id,
          summary: { revision: updated.revision, versionNumber },
        })
        return version
      })
      reply.code(201)
      return reply.send(success(versionResponse(frozen), request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.get('/api/v1/admin/purchase-form-templates/:id/versions/:versionId', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read an immutable local purchase form template version',
      params: PurchaseTemplateVersionParamsSchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseTemplateVersionSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id, versionId } = request.params as { id: string; versionId: string }
    try {
      const row = await db.selectFrom('purchase_form_template_versions').selectAll()
        .where('template_id', '=', id).where('id', '=', versionId).executeTakeFirst()
      if (!row) throw new PurchaseTemplateAdminError(404, 'PURCHASE_TEMPLATE_VERSION_NOT_FOUND', '找不到此模板版本。')
      return reply.send(success(versionResponse(row), request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.get('/api/v1/admin/products/:id/purchase-form', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read a product purchase form preparation assignment',
      params: ProductPurchaseFormParamsSchema,
      response: { 200: ApiSuccessSchemaOf(ProductPurchaseFormAssignmentSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try { return reply.send(success(await productDefaultAssignment(db, id), request.id)) }
    catch (error) { return fail(reply, error, request.id) }
  })

  app.put('/api/v1/admin/products/:id/purchase-form', {
    preHandler: protectedWrite,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Save a product purchase form preparation assignment',
      params: ProductPurchaseFormParamsSchema,
      body: ProductPurchaseFormAssignmentBodySchema,
      response: { 200: ApiSuccessSchemaOf(ProductPurchaseFormAssignmentSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as ProductPurchaseFormAssignmentBody
    const administratorId = request.admin!.id
    try {
      const versionId = assertAssignmentBody(body.mode, body.templateVersionId, ['not_configured', 'none', 'template'])
      await db.transaction().execute(async (trx) => {
        const status = await readPurchaseFormsStatus(trx, 'share')
        const product = await lockProductAtRevision(trx, id, body.expectedRevision)
        assertProductNotArchived(product)
        await assertVersionExists(trx, versionId)
        const current = await trx.selectFrom('product_purchase_form_settings').selectAll().where('product_id', '=', id).executeTakeFirst()
        const removeUnconfiguredPreparation = status === 'preparing' && body.mode === 'not_configured'
        const unchanged = current
          ? current.mode === body.mode && current.template_version_id === versionId
          : removeUnconfiguredPreparation
        let revision = product.revision
        if (!unchanged) {
          if (removeUnconfiguredPreparation) {
            await trx.deleteFrom('product_purchase_form_settings').where('product_id', '=', id).execute()
          } else if (current) {
            await trx.updateTable('product_purchase_form_settings').set({
              mode: body.mode, template_version_id: versionId, updated_by_admin_id: administratorId,
            }).where('product_id', '=', id).execute()
          } else {
            await trx.insertInto('product_purchase_form_settings').values({
              product_id: id, mode: body.mode, template_version_id: versionId, updated_by_admin_id: administratorId,
            }).execute()
          }
          const updated = await trx.updateTable('products').set({ updated_at: new Date() })
            .where('id', '=', id).returning('revision').executeTakeFirstOrThrow()
          revision = updated.revision
          await audit(trx, {
            administratorId, operation: 'product_assignment_updated', productId: id,
            summary: { mode: body.mode, templateVersionId: versionId, revision },
          })
        }
        return revision
      })
      const assignment = await productDefaultAssignment(db, id)
      return reply.send(success(assignment, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/purchase-form', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read a SKU purchase form preparation override',
      params: SkuPurchaseFormParamsSchema,
      response: { 200: ApiSuccessSchemaOf(SkuPurchaseFormAssignmentSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id, variantId } = request.params as { id: string; variantId: string }
    try { return reply.send(success(await skuAssignment(db, id, variantId), request.id)) }
    catch (error) { return fail(reply, error, request.id) }
  })

  app.put('/api/v1/admin/products/:id/variants/:variantId/purchase-form', {
    preHandler: protectedWrite,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Save a SKU purchase form preparation override',
      params: SkuPurchaseFormParamsSchema,
      body: SkuPurchaseFormAssignmentBodySchema,
      response: { 200: ApiSuccessSchemaOf(SkuPurchaseFormAssignmentSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id, variantId } = request.params as { id: string; variantId: string }
    const body = request.body as SkuPurchaseFormAssignmentBody
    const administratorId = request.admin!.id
    try {
      const versionId = assertAssignmentBody(body.mode, body.templateVersionId, ['product_default', 'none', 'template'])
      const revision = await db.transaction().execute(async (trx) => {
        const status = await readPurchaseFormsStatus(trx, 'share')
        const product = await lockProductAtRevision(trx, id, body.expectedRevision)
        assertProductNotArchived(product)
        const variant = await trx.selectFrom('product_variants').select('id')
          .where('id', '=', variantId).where('product_id', '=', id).forUpdate().executeTakeFirst()
        if (!variant) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')
        await assertVersionExists(trx, versionId)
        const current = await trx.selectFrom('sku_purchase_form_overrides').selectAll()
          .where('product_id', '=', id).where('product_variant_id', '=', variantId).executeTakeFirst()
        const removeDefaultPreparation = status === 'preparing' && body.mode === 'product_default'
        const unchanged = current
          ? current.mode === body.mode && current.template_version_id === versionId
          : removeDefaultPreparation
        if (unchanged) return product.revision
        if (removeDefaultPreparation) {
          await trx.deleteFrom('sku_purchase_form_overrides').where('product_id', '=', id)
            .where('product_variant_id', '=', variantId).execute()
        } else if (current) {
          await trx.updateTable('sku_purchase_form_overrides').set({
            mode: body.mode, template_version_id: versionId, updated_by_admin_id: administratorId,
          }).where('product_id', '=', id).where('product_variant_id', '=', variantId).execute()
        } else {
          await trx.insertInto('sku_purchase_form_overrides').values({
            product_id: id, product_variant_id: variantId, mode: body.mode,
            template_version_id: versionId, updated_by_admin_id: administratorId,
          }).execute()
        }
        const updated = await trx.updateTable('products').set({ updated_at: new Date() })
          .where('id', '=', id).returning('revision').executeTakeFirstOrThrow()
        await audit(trx, {
          administratorId, operation: 'sku_override_updated', productId: id, productVariantId: variantId,
          summary: { mode: body.mode, templateVersionId: versionId, revision: updated.revision },
        })
        return updated.revision
      })
      const assignment = await skuAssignment(db, id, variantId)
      return reply.send(success({ ...assignment, productRevision: revision }, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })
}
