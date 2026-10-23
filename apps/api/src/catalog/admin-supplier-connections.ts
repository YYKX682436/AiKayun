import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreateSupplierConnectionBodySchema,
  SupplierConnectionPageSchema,
  SupplierConnectionAuditPageSchema,
  SupplierConnectionTestResultSchema,
  SupplierConnectionVersionsPageSchema,
  SupplierConnectionVersionsQuerySchema,
  SupplierCredentialRewrapResultSchema,
  UpdateSupplierConnectionBodySchema,
  UpdateSupplierConnectionEnabledBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  CreateSupplierConnectionBody,
  SupplierConnection,
  SupplierConnectionTestResult,
  SupplierConnectionVersion,
  SupplierConnectionVersionsQuery,
  UpdateSupplierConnectionBody,
  UpdateSupplierConnectionEnabledBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import {
  decryptSupplierBearerToken,
  encryptSupplierBearerToken,
  SupplierCredentialKeyUnavailableError,
} from '../commerce/supplier-api-crypto.js'
import {
  HttpJsonV1Error,
  testHttpJsonV1Connection,
  validateSupplierBaseUrl,
} from '../commerce/http-json-v1.js'

class SupplierAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'SupplierAdminError'
  }
}

interface SupplierVersionRow {
  id: string
  supplier_connection_id: string
  version_number: number
  display_name: string
  provider_type: 'http_json_v1'
  base_url: string
  auth_scheme: 'bearer'
  credential_version: number
  created_at: Date
}

type Db = Kysely<Database> | import('kysely').Transaction<Database>

function toVersion(row: SupplierVersionRow): SupplierConnectionVersion {
  return {
    id: row.id,
    versionNumber: row.version_number,
    name: row.display_name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    authScheme: row.auth_scheme,
    credentialVersion: row.credential_version,
    createdAt: row.created_at.toISOString(),
  }
}

function handleError(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof SupplierAdminError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof SupplierCredentialKeyUnavailableError) {
    return reply.code(503).send(failure('SUPPLIER_CREDENTIAL_KEY_UNAVAILABLE', '供应商凭据密钥暂不可用，操作已被阻止。', requestId))
  }
  if (error instanceof HttpJsonV1Error) {
    return reply.code(400).send(failure('SUPPLIER_CONFIGURATION_INVALID', '供应商地址或 HTTP JSON v1 配置未通过安全校验。', requestId))
  }
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (candidate.constraint === 'supplier_connection_test_required') {
      return reply.code(409).send(failure('SUPPLIER_TEST_REQUIRED', '当前配置必须先通过连接和查单能力测试，再明确启用。', requestId))
    }
    current = candidate.cause
  }
  throw error
}

async function currentSupplier(
  db: Db, connectionId: string,
): Promise<{ connection: SupplierConnection; versionRow: SupplierVersionRow } | undefined> {
  const result = await sql<SupplierVersionRow & {
    name: string; enabled: boolean; updated_at: Date; credential_present: boolean
  }>`
    SELECT connection.id AS supplier_connection_id, connection.display_name AS name,
      connection.enabled, connection.updated_at, version.id, version.version_number,
      version.display_name, version.provider_type, version.base_url, version.auth_scheme,
      version.credential_version, version.created_at,
      (credential.ciphertext IS NOT NULL) AS credential_present
    FROM supplier_connections AS connection
    JOIN supplier_connection_versions AS version ON version.id = connection.current_version_id
      AND version.supplier_connection_id = connection.id
    LEFT JOIN supplier_connection_credentials AS credential
      ON credential.supplier_connection_id = connection.id
      AND credential.credential_version = version.credential_version
    WHERE connection.id = ${connectionId}::uuid
  `.execute(db)
  const row = result.rows[0]
  if (!row) return undefined
  const versionRow: SupplierVersionRow = {
    id: row.id,
    supplier_connection_id: row.supplier_connection_id,
    version_number: row.version_number,
    display_name: row.display_name,
    provider_type: row.provider_type,
    base_url: row.base_url,
    auth_scheme: row.auth_scheme,
    credential_version: row.credential_version,
    created_at: row.created_at,
  }
  return {
    connection: {
      id: row.supplier_connection_id,
      name: row.name,
      enabled: row.enabled,
      providerType: row.provider_type,
      credentialsConfigured: true,
      currentVersion: toVersion(versionRow),
      updatedAt: row.updated_at.toISOString(),
    },
    versionRow,
  }
}

async function credentialForVersion(
  db: Db, config: AppConfig, version: SupplierVersionRow,
): Promise<string> {
  const row = await db.selectFrom('supplier_connection_credentials').selectAll()
    .where('supplier_connection_id', '=', version.supplier_connection_id)
    .where('credential_version', '=', version.credential_version)
    .executeTakeFirst()
  if (!row) throw new SupplierCredentialKeyUnavailableError()
  return decryptSupplierBearerToken(config, version.supplier_connection_id, version.credential_version, {
    keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
  })
}

export function registerAdminSupplierConnectionRoutes(
  app: FastifyInstance, db: Kysely<Database>, config: AppConfig,
): void {
  const requireAdministrator = requireAdmin(db, config)
  const adminCsrf = verifyCsrf(config)

  app.get('/api/v1/admin/supplier-connections', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'List supplier API connections without exposing credentials',
      response: { 200: ApiSuccessSchemaOf(SupplierConnectionPageSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const ids = await db.selectFrom('supplier_connections').select('id').orderBy('created_at').execute()
    const rows: SupplierConnection[] = []
    for (const item of ids) {
      const loaded = await currentSupplier(db, item.id)
      if (loaded) rows.push(loaded.connection)
    }
    reply.header('cache-control', 'private, no-store')
    return success(rows, request.id)
  })

  app.post('/api/v1/admin/supplier-connections', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Create an encrypted http_json_v1 supplier connection',
      body: CreateSupplierConnectionBodySchema,
      response: { 201: ApiSuccessSchemaOf(SupplierConnectionPageSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as CreateSupplierConnectionBody
      const baseUrl = validateSupplierBaseUrl(body.baseUrl, config).href.replace(/\/$/u, '')
      const connectionId = randomUUID()
      const versionId = randomUUID()
      const credential = encryptSupplierBearerToken(config, connectionId, 1, body.bearerToken)
      const result = await db.transaction().execute(async (trx) => {
        await trx.insertInto('supplier_connections').values({
          id: connectionId, display_name: body.name.trim(), enabled: false,
          current_version_id: null, tested_version_id: null, created_by_admin_id: request.admin!.id,
        }).execute()
        await trx.insertInto('supplier_connection_credentials').values({
          supplier_connection_id: connectionId, credential_version: 1, key_id: credential.keyId,
          nonce: credential.nonce, ciphertext: credential.ciphertext, auth_tag: credential.authTag,
        }).execute()
        await trx.insertInto('supplier_connection_versions').values({
          id: versionId, supplier_connection_id: connectionId, version_number: 1,
          display_name: body.name.trim(), provider_type: 'http_json_v1', base_url: baseUrl,
          auth_scheme: 'bearer', credential_version: 1, created_by_admin_id: request.admin!.id,
        }).execute()
        await trx.updateTable('supplier_connections').set({ current_version_id: versionId })
          .where('id', '=', connectionId).execute()
        await trx.insertInto('supplier_connection_audit_events').values({
          id: randomUUID(), supplier_connection_id: connectionId, administrator_id: request.admin!.id,
          action: 'created', details: { providerType: 'http_json_v1', versionNumber: 1, credentialVersion: 1 },
        }).execute()
        return await currentSupplier(trx, connectionId)
      })
      if (!result) throw new SupplierAdminError(500, 'SUPPLIER_CREATE_FAILED', '供应商连接创建失败。')
      reply.header('cache-control', 'private, no-store')
      return reply.code(201).send(success([result.connection], request.id))
    } catch (error) {
      return handleError(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/supplier-connections/:id', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Save a new immutable supplier endpoint and credential version',
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
      body: UpdateSupplierConnectionBodySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierConnectionPageSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as UpdateSupplierConnectionBody
      const baseUrl = validateSupplierBaseUrl(body.baseUrl, config).href.replace(/\/$/u, '')
      const result = await db.transaction().execute(async (trx) => {
        const existing = await trx.selectFrom('supplier_connections as connection')
          .innerJoin('supplier_connection_versions as version', 'version.id', 'connection.current_version_id')
          .select(['connection.id', 'connection.display_name', 'connection.current_version_id', 'version.version_number', 'version.credential_version', 'version.base_url', 'version.display_name as version_name'])
          .where('connection.id', '=', id).forUpdate('connection').executeTakeFirst()
        if (!existing) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
        const tokenChanged = body.bearerToken !== undefined
        const credentialVersion = existing.credential_version + (tokenChanged ? 1 : 0)
        if (tokenChanged) {
          const envelope = encryptSupplierBearerToken(config, id, credentialVersion, body.bearerToken!)
          await trx.insertInto('supplier_connection_credentials').values({
            supplier_connection_id: id, credential_version: credentialVersion, key_id: envelope.keyId,
            nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag,
          }).execute()
        }
        const nextNumber = existing.version_number + 1
        const versionId = randomUUID()
        await trx.insertInto('supplier_connection_versions').values({
          id: versionId, supplier_connection_id: id, version_number: nextNumber,
          display_name: body.name.trim(), provider_type: 'http_json_v1', base_url: baseUrl,
          auth_scheme: 'bearer', credential_version: credentialVersion, created_by_admin_id: request.admin!.id,
        }).execute()
        await trx.updateTable('supplier_connections').set({
          display_name: body.name.trim(), current_version_id: versionId, tested_version_id: null, enabled: false,
        }).where('id', '=', id).execute()
        await trx.insertInto('supplier_connection_audit_events').values({
          id: randomUUID(), supplier_connection_id: id, administrator_id: request.admin!.id,
          action: tokenChanged ? 'credential_rotated' : 'configuration_updated',
          details: { versionNumber: nextNumber, credentialVersion, credentialChanged: tokenChanged, baseUrlChanged: baseUrl !== existing.base_url, nameChanged: body.name.trim() !== existing.version_name },
        }).execute()
        return await currentSupplier(trx, id)
      })
      if (!result) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
      reply.header('cache-control', 'private, no-store')
      return success([result.connection], request.id)
    } catch (error) {
      return handleError(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/supplier-connections/:id/test', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Test HTTPS, bearer authentication and both supplier query capabilities',
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: ApiSuccessSchemaOf(SupplierConnectionTestResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = await currentSupplier(db, id)
    if (!loaded) return reply.code(404).send(failure('SUPPLIER_NOT_FOUND', '供应商连接不存在。', request.id))
    const checkedAt = new Date()
    let passed = false
    let safeError: HttpJsonV1Error | undefined
    try {
      const bearerToken = await credentialForVersion(db, config, loaded.versionRow)
      await testHttpJsonV1Connection(config, { baseUrl: loaded.versionRow.base_url, bearerToken })
      passed = true
    } catch (error) {
      if (error instanceof HttpJsonV1Error) safeError = error
      else if (!(error instanceof SupplierCredentialKeyUnavailableError)) throw error
    }
    try {
      await db.transaction().execute(async (trx) => {
        const connection = await trx.selectFrom('supplier_connections').select(['id', 'current_version_id'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!connection) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
        if (connection.current_version_id !== loaded.versionRow.id) throw new SupplierAdminError(409, 'SUPPLIER_VERSION_CHANGED', '测试期间供应商配置发生变化，请重新测试当前版本。')
        await trx.updateTable('supplier_connections').set({
          tested_version_id: passed ? loaded.versionRow.id : null,
          ...(passed ? {} : { enabled: false }),
        }).where('id', '=', id).execute()
        await trx.insertInto('supplier_connection_audit_events').values({
          id: randomUUID(), supplier_connection_id: id, administrator_id: request.admin!.id,
          action: passed ? 'connection_test_succeeded' : 'connection_test_failed',
          details: passed ? { versionId: loaded.versionRow.id, queryCapable: true, checkedAt: checkedAt.toISOString() }
            : { versionId: loaded.versionRow.id, errorCode: safeError?.code ?? 'credential_unavailable', classification: safeError?.classification ?? 'credential_unavailable', checkedAt: checkedAt.toISOString() },
        }).execute()
      })
    } catch (error) {
      return handleError(reply, error, request.id)
    }
    const result: SupplierConnectionTestResult = {
      connectionOk: passed,
      queryCapable: passed,
      checkedAt: checkedAt.toISOString(),
      message: passed ? '连接及按稳定幂等键查单测试通过；请单独明确启用。'
        : '连接或查单能力测试失败。请核对供应商协议、地址和凭据；系统未保存响应正文。',
    }
    reply.header('cache-control', 'private, no-store')
    return success(result, request.id)
  })

  app.put('/api/v1/admin/supplier-connections/:id/enabled', {
    preHandler: [requireAdministrator, adminCsrf],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Explicitly enable or disable supplier sales',
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
      body: UpdateSupplierConnectionEnabledBodySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierConnectionPageSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as UpdateSupplierConnectionEnabledBody
      const result = await db.transaction().execute(async (trx) => {
        const row = await trx.selectFrom('supplier_connections').select(['id', 'enabled', 'current_version_id', 'tested_version_id'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!row) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
        if (body.enabled && (!row.current_version_id || row.tested_version_id !== row.current_version_id)) {
          throw new SupplierAdminError(409, 'SUPPLIER_TEST_REQUIRED', '当前版本尚未通过连接与查单测试。')
        }
        await trx.updateTable('supplier_connections').set({ enabled: body.enabled }).where('id', '=', id).execute()
        await trx.insertInto('supplier_connection_audit_events').values({
          id: randomUUID(), supplier_connection_id: id, administrator_id: request.admin!.id,
          action: body.enabled ? 'enabled' : 'disabled', details: { enabled: body.enabled },
        }).execute()
        return await currentSupplier(trx as unknown as Kysely<Database>, id)
      })
      if (!result) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
      reply.header('cache-control', 'private, no-store')
      return success([result.connection], request.id)
    } catch (error) {
      return handleError(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/supplier-connections/:id/rewrap-credentials', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Re-encrypt retained supplier credentials with the active key-ring key',
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: ApiSuccessSchemaOf(SupplierCredentialRewrapResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const count = await db.transaction().execute(async (trx) => {
        const connection = await trx.selectFrom('supplier_connections').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
        if (!connection) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
        const rows = await trx.selectFrom('supplier_connection_credentials').selectAll()
          .where('supplier_connection_id', '=', id).forUpdate().execute()
        let changed = 0
        for (const row of rows) {
          if (row.key_id === config.paymentCredentialKeyRing?.activeKeyId) continue
          const token = decryptSupplierBearerToken(config, id, row.credential_version, {
            keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
          })
          const envelope = encryptSupplierBearerToken(config, id, row.credential_version, token)
          await trx.updateTable('supplier_connection_credentials').set({
            key_id: envelope.keyId, nonce: envelope.nonce,
            ciphertext: envelope.ciphertext, auth_tag: envelope.authTag,
          }).where('supplier_connection_id', '=', id).where('credential_version', '=', row.credential_version).execute()
          changed += 1
        }
        if (changed) await trx.insertInto('supplier_connection_audit_events').values({
          id: randomUUID(), supplier_connection_id: id, administrator_id: request.admin!.id,
          action: 'credential_key_rewrapped', details: { count: changed, activeKeyId: config.paymentCredentialKeyRing?.activeKeyId ?? null },
        }).execute()
        return changed
      })
      const result = { rewrappedCredentialVersions: count }
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) {
      return handleError(reply, error, request.id)
    }
  })

  app.get('/api/v1/admin/supplier-connections/:id/versions', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'List immutable supplier endpoint and credential-version metadata',
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: SupplierConnectionVersionsQuerySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierConnectionVersionsPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as SupplierConnectionVersionsQuery
    const page = query.page ?? 1
    const pageSize = Math.min(query.pageSize ?? 20, 50)
    const exists = await db.selectFrom('supplier_connections').select('id').where('id', '=', id).executeTakeFirst()
    if (!exists) return reply.code(404).send(failure('SUPPLIER_NOT_FOUND', '供应商连接不存在。', request.id))
    const count = await db.selectFrom('supplier_connection_versions').select(sql<number>`count(*)::integer`.as('count'))
      .where('supplier_connection_id', '=', id).executeTakeFirstOrThrow()
    const versions = await db.selectFrom('supplier_connection_versions').selectAll()
      .where('supplier_connection_id', '=', id).orderBy('version_number', 'desc')
      .limit(pageSize).offset((page - 1) * pageSize).execute()
    reply.header('cache-control', 'private, no-store')
    return success({
      items: versions.map((row) => toVersion(row)), total: count.count, page, pageSize,
      totalPages: count.count === 0 ? 0 : Math.ceil(count.count / pageSize),
    }, request.id)
  })

  app.get('/api/v1/admin/supplier-connections/:id/audit', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read sanitized supplier connection configuration and credential audit events',
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: ApiSuccessSchemaOf(SupplierConnectionAuditPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const exists = await db.selectFrom('supplier_connections').select('id').where('id', '=', id).executeTakeFirst()
    if (!exists) return reply.code(404).send(failure('SUPPLIER_NOT_FOUND', '供应商连接不存在。', request.id))
    const rows = await db.selectFrom('supplier_connection_audit_events').selectAll()
      .where('supplier_connection_id', '=', id).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(100).execute()
    reply.header('cache-control', 'private, no-store')
    return success({ events: rows.map(row => ({
      id: row.id, administratorId: row.administrator_id,
      action: row.action, details: row.details, createdAt: row.created_at.toISOString(),
    })) }, request.id)
  })
}
