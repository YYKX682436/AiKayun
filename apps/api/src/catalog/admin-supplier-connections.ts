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
  SupplierAccountObservationSchema, SupplierCatalogPageSchema, SupplierCatalogProductSchema, SupplierCatalogQuerySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  CreateSupplierConnectionBody, SupplierCatalogQuery,
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
  decryptSupplierCredentials,
  encryptSupplierCredentials,
  type SupplierCredentials,
  SupplierCredentialKeyUnavailableError,
} from '../commerce/supplier-api-crypto.js'
import {
  HttpJsonV1Error,
  testHttpJsonV1Connection,
  validateSupplierBaseUrl,
} from '../commerce/http-json-v1.js'
import { validateKayixinBaseUrl, KayixinV3Error, readKayixinAccount, readKayixinGoods, readKayixinGoodDetail, type KayixinV3Source } from '../commerce/kayixin-customer-v3.js'

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
  provider_type: SupplierConnection['providerType']
  base_url: string
  auth_scheme: SupplierConnectionVersion['authScheme']
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
  if (error instanceof KayixinV3Error) {
    return reply.code(502).send(failure(error.code.toUpperCase(), supplierErrorMessage(error.code), requestId))
  }
  if (error instanceof HttpJsonV1Error) {
    return reply.code(400).send(failure('SUPPLIER_CONFIGURATION_INVALID', supplierErrorMessage(error.code), requestId))
  }
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (candidate.constraint === 'supplier_protocol_readonly') return reply.code(409).send(failure('SUPPLIER_READ_ONLY', '卡易信仅开放只读连接，自动采购尚未开放。', requestId))
    if (candidate.constraint === 'supplier_connection_test_required') {
      return reply.code(409).send(failure('SUPPLIER_TEST_REQUIRED', '当前配置必须先通过连接和查单能力测试，再明确启用。', requestId))
    }
    current = candidate.cause
  }
  throw error
}

function supplierErrorMessage(code: string): string {
  if (code === 'kayixin_origin_required') return '卡易信 V3 请填写站点 HTTPS 根地址，不包含 API 路径。'
  if (code === 'kayixin_authentication_failed') return '上游认证失败。请核对 AppID、AppSecret、服务器时间与 V3 权限。'
  if (code.startsWith('kayixin_business_')) return `上游拒绝只读请求（业务代码 ${code.slice(17)}）。请核对账户权限和商品可见范围。`
  if (code === 'credential_unavailable') return '凭据或历史加密密钥不可用，请核对密钥环。'
  if (/timeout/u.test(code)) return '上游请求超时，请稍后重试。'
  if (/redirect/u.test(code)) return '上游返回重定向，已拒绝；请填写最终 HTTPS API 地址。'
  if (/address_not_public|https_required|url_invalid/u.test(code)) return '供应商地址未通过安全校验；正式连接必须使用公开 HTTPS 地址。'
  if (/too_large/u.test(code)) return '上游响应或请求超过此操作的安全大小限制。'
  if (/network|dns|refused|interrupted/u.test(code)) return '上游网络或 TLS 连接失败，请核对地址后重试。'
  return `上游协议或商品字段校验失败（${code}），请核对站点协议版本后重试。`
}
function testResult(row: { passed: boolean; scope: 'fulfillment_v1' | 'catalog_read_v3'; configuration_version_id: string; checked_at: Date; error_code: string | null }): SupplierConnectionTestResult {
  return { connectionOk: row.passed, queryCapable: row.scope === 'fulfillment_v1' && row.passed,
    scope: row.scope, configurationVersionId: row.configuration_version_id,
    checkedAt: row.checked_at.toISOString(), errorCode: row.error_code,
    message: row.passed ? row.scope === 'catalog_read_v3'
      ? '只读连接正常：账户和商品目录已读取。自动采购尚未开放。'
      : '连接及两种查单测试通过；请单独明确启用。'
      : supplierErrorMessage(row.error_code ?? 'credential_unavailable') }
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
      fulfillmentEligible: row.provider_type === 'http_json_v1' && row.enabled,
      lastTest: await db.selectFrom('supplier_connection_tests').selectAll()
        .where('configuration_version_id', '=', row.id).orderBy('checked_at', 'desc').orderBy('id', 'desc').executeTakeFirst().then(test => test ? testResult(test) : null),
      credentialsConfigured: true,
      currentVersion: toVersion(versionRow),
      updatedAt: row.updated_at.toISOString(),
    },
    versionRow,
  }
}

async function credentialForVersion(
  db: Db, config: AppConfig, version: SupplierVersionRow,
): Promise<SupplierCredentials> {
  const row = await db.selectFrom('supplier_connection_credentials').selectAll()
    .where('supplier_connection_id', '=', version.supplier_connection_id)
    .where('credential_version', '=', version.credential_version)
    .executeTakeFirst()
  if (!row || row.provider_type !== version.provider_type || row.auth_scheme !== version.auth_scheme) throw new SupplierCredentialKeyUnavailableError()
  return decryptSupplierCredentials(config, version.supplier_connection_id, version.credential_version, version.provider_type, {
    keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
  })
}

function readIdentity(version: SupplierVersionRow): KayixinV3Source {
  return { connectionId: version.supplier_connection_id, configurationVersionId: version.id, configurationVersionNumber: version.version_number }
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
      tags: ['admin', 'catalog'], summary: 'Create a versioned supplier connection with protocol-specific encrypted credentials',
      body: CreateSupplierConnectionBodySchema,
      response: { 201: ApiSuccessSchemaOf(SupplierConnectionPageSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as CreateSupplierConnectionBody
      const baseUrl = (body.providerType === 'kayixin_customer_v3' ? validateKayixinBaseUrl(body.baseUrl, config) : validateSupplierBaseUrl(body.baseUrl, config)).href.replace(/\/$/u, '')
      const connectionId = randomUUID()
      const versionId = randomUUID()
      const credentials: SupplierCredentials = body.providerType === 'http_json_v1'
        ? { providerType: body.providerType, bearerToken: body.bearerToken } : { providerType: body.providerType, ...body.credentials }
      const credential = encryptSupplierCredentials(config, connectionId, 1, credentials)
      const authScheme = body.providerType === 'http_json_v1' ? 'bearer' as const : 'app_signature_v3' as const
      const result = await db.transaction().execute(async (trx) => {
        await trx.insertInto('supplier_connections').values({
          id: connectionId, provider_type: body.providerType, display_name: body.name.trim(), enabled: false,
          current_version_id: null, tested_version_id: null, created_by_admin_id: request.admin!.id,
        }).execute()
        await trx.insertInto('supplier_connection_credentials').values({
          supplier_connection_id: connectionId, provider_type: body.providerType, auth_scheme: authScheme, credential_version: 1, key_id: credential.keyId,
          nonce: credential.nonce, ciphertext: credential.ciphertext, auth_tag: credential.authTag,
        }).execute()
        await trx.insertInto('supplier_connection_versions').values({
          id: versionId, supplier_connection_id: connectionId, version_number: 1,
          display_name: body.name.trim(), provider_type: body.providerType, base_url: baseUrl,
          auth_scheme: authScheme, credential_version: 1, created_by_admin_id: request.admin!.id,
        }).execute()
        await trx.updateTable('supplier_connections').set({ current_version_id: versionId })
          .where('id', '=', connectionId).execute()
        await trx.insertInto('supplier_connection_audit_events').values({
          id: randomUUID(), supplier_connection_id: connectionId, administrator_id: request.admin!.id,
          action: 'created', details: { providerType: body.providerType, versionNumber: 1, credentialVersion: 1 },
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
      const baseUrl = (body.providerType === 'kayixin_customer_v3' ? validateKayixinBaseUrl(body.baseUrl, config) : validateSupplierBaseUrl(body.baseUrl, config)).href.replace(/\/$/u, '')
      const result = await db.transaction().execute(async (trx) => {
        const existing = await trx.selectFrom('supplier_connections as connection')
          .innerJoin('supplier_connection_versions as version', 'version.id', 'connection.current_version_id')
          .select(['connection.id', 'connection.display_name', 'connection.current_version_id', 'version.version_number', 'version.credential_version', 'version.base_url', 'version.provider_type', 'version.auth_scheme', 'version.display_name as version_name'])
          .where('connection.id', '=', id).forUpdate('connection').executeTakeFirst()
        if (!existing) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
        const requestedProtocol = body.providerType ?? 'http_json_v1'
        if (requestedProtocol !== existing.provider_type) throw new SupplierAdminError(409, 'SUPPLIER_PROTOCOL_IMMUTABLE', '更换协议必须建立新连接，不能修改现有连接的协议。')
        const nextCredentials: SupplierCredentials | undefined = body.providerType === 'kayixin_customer_v3'
          ? body.credentials ? { providerType: body.providerType, ...body.credentials } : undefined
          : body.bearerToken !== undefined ? { providerType: 'http_json_v1', bearerToken: body.bearerToken } : undefined
        const tokenChanged = nextCredentials !== undefined
        const credentialVersion = existing.credential_version + (tokenChanged ? 1 : 0)
        if (tokenChanged) {
          const envelope = encryptSupplierCredentials(config, id, credentialVersion, nextCredentials!)
          await trx.insertInto('supplier_connection_credentials').values({
            supplier_connection_id: id, provider_type: existing.provider_type, auth_scheme: existing.auth_scheme, credential_version: credentialVersion, key_id: envelope.keyId,
            nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag,
          }).execute()
        }
        const nextNumber = existing.version_number + 1
        const versionId = randomUUID()
        await trx.insertInto('supplier_connection_versions').values({
          id: versionId, supplier_connection_id: id, version_number: nextNumber,
          display_name: body.name.trim(), provider_type: existing.provider_type, base_url: baseUrl,
          auth_scheme: existing.auth_scheme, credential_version: credentialVersion, created_by_admin_id: request.admin!.id,
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
      tags: ['admin', 'catalog'], summary: 'Test only the current protocol scope; V3 reads never confer fulfillment readiness',
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: ApiSuccessSchemaOf(SupplierConnectionTestResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = await currentSupplier(db, id)
    if (!loaded) return reply.code(404).send(failure('SUPPLIER_NOT_FOUND', '供应商连接不存在。', request.id))
    const scope = loaded.versionRow.provider_type === 'http_json_v1' ? 'fulfillment_v1' as const : 'catalog_read_v3' as const
    let passed = false
    let errorCode: string | null = null
    let classification = 'credential_unavailable'
    const completedOperations: string[] = []
    try {
      const credentials = await credentialForVersion(db, config, loaded.versionRow)
      if (credentials.providerType === 'http_json_v1') {
        await testHttpJsonV1Connection(config, { baseUrl: loaded.versionRow.base_url, bearerToken: credentials.bearerToken })
        completedOperations.push('capabilities', 'query_by_key', 'query_by_id')
      } else {
        const supplier = { baseUrl: loaded.versionRow.base_url, ...credentials }
        const identity = readIdentity(loaded.versionRow)
        await readKayixinAccount(config, supplier, identity)
        completedOperations.push('account')
        const page = await readKayixinGoods(config, supplier, identity, { page: 1 })
        completedOperations.push('goods_list')
        if (page.items[0]) {
          await readKayixinGoodDetail(config, supplier, identity, Number(page.items[0].upstreamProductId))
          completedOperations.push('goods_detail')
        }
      }
      passed = true
    } catch (error) {
      if (error instanceof HttpJsonV1Error || error instanceof KayixinV3Error) {
        errorCode = error.code
        classification = error.classification
      } else if (error instanceof SupplierCredentialKeyUnavailableError) errorCode = 'credential_unavailable'
      else throw error
    }
    const checkedAt = new Date()
    try {
      await db.transaction().execute(async (trx) => {
        const connection = await trx.selectFrom('supplier_connections').select(['id', 'current_version_id'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!connection) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
        if (connection.current_version_id !== loaded.versionRow.id) throw new SupplierAdminError(409, 'SUPPLIER_VERSION_CHANGED', '测试期间供应商配置发生变化，请重新测试当前版本。')
        await trx.updateTable('supplier_connections').set({
          tested_version_id: passed && scope === 'fulfillment_v1' ? loaded.versionRow.id : null,
          ...(passed && scope === 'fulfillment_v1' ? {} : { enabled: false }),
        }).where('id', '=', id).execute()
        await trx.insertInto('supplier_connection_tests').values({
          id: randomUUID(), supplier_connection_id: id, configuration_version_id: loaded.versionRow.id,
          provider_type: loaded.versionRow.provider_type, scope, passed, checked_at: checkedAt,
          error_code: errorCode, administrator_id: request.admin!.id,
        }).execute()
        await trx.insertInto('supplier_connection_audit_events').values({
          id: randomUUID(), supplier_connection_id: id, administrator_id: request.admin!.id,
          action: passed ? 'connection_test_succeeded' : 'connection_test_failed',
          details: { versionId: loaded.versionRow.id, scope, completedOperations,
            queryCapable: scope === 'fulfillment_v1' && passed,
            errorCode, ...(passed ? {} : { classification }), checkedAt: checkedAt.toISOString() },
        }).execute()
      })
    } catch (error) {
      return handleError(reply, error, request.id)
    }
    const result = testResult({ passed, scope, configuration_version_id: loaded.versionRow.id, checked_at: checkedAt, error_code: errorCode })
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
        const row = await trx.selectFrom('supplier_connections').select(['id', 'provider_type', 'enabled', 'current_version_id', 'tested_version_id'])
          .where('id', '=', id).forUpdate().executeTakeFirst()
        if (!row) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
        if (body.enabled && row.provider_type !== 'http_json_v1') throw new SupplierAdminError(409, 'SUPPLIER_READ_ONLY', '只读连接不能启用自动销售；自动采购尚未开放。')
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
          const credentials = decryptSupplierCredentials(config, id, row.credential_version, row.provider_type, {
            keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
          })
          const envelope = encryptSupplierCredentials(config, id, row.credential_version, credentials)
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

  const readParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } }
  async function readContext(id: string) {
    const loaded = await currentSupplier(db, id)
    if (!loaded) throw new SupplierAdminError(404, 'SUPPLIER_NOT_FOUND', '供应商连接不存在。')
    if (loaded.versionRow.provider_type !== 'kayixin_customer_v3') throw new SupplierAdminError(409, 'SUPPLIER_CATALOG_UNSUPPORTED', '该连接协议未开放商品只读浏览。')
    const credentials = await credentialForVersion(db, config, loaded.versionRow)
    if (credentials.providerType !== 'kayixin_customer_v3') throw new SupplierCredentialKeyUnavailableError()
    return { version: loaded.versionRow, identity: readIdentity(loaded.versionRow), supplier: { baseUrl: loaded.versionRow.base_url, ...credentials } }
  }
  async function assertReadVersion(id: string, versionId: string) {
    const current = await db.selectFrom('supplier_connections').select('current_version_id').where('id', '=', id).executeTakeFirst()
    if (current?.current_version_id !== versionId) throw new SupplierAdminError(409, 'SUPPLIER_VERSION_CHANGED', '读取期间供应商配置发生变化，请重试当前版本。')
  }
  const readErrors = { 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 502: ApiErrorSchema, 503: ApiErrorSchema }
  app.post('/api/v1/admin/supplier-connections/:id/catalog/account', {
    preHandler: [requireAdministrator, adminCsrf], config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['admin', 'catalog'], summary: 'Read V3 account balance without business side effects', params: readParams,
      response: { 200: ApiSuccessSchemaOf(SupplierAccountObservationSchema), ...readErrors } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const context = await readContext(id)
      const result = await readKayixinAccount(config, context.supplier, context.identity)
      await assertReadVersion(id, context.version.id)
      return success(result, request.id)
    } catch (error) { return handleError(reply, error, request.id) }
  })
  app.post('/api/v1/admin/supplier-connections/:id/catalog/goods', {
    preHandler: [requireAdministrator, adminCsrf], config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['admin', 'catalog'], summary: 'Read a bounded page of V3 goods', params: readParams, body: SupplierCatalogQuerySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierCatalogPageSchema), ...readErrors } },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const context = await readContext(id)
      const result = await readKayixinGoods(config, context.supplier, context.identity, request.body as SupplierCatalogQuery)
      await assertReadVersion(id, context.version.id)
      return success(result, request.id)
    } catch (error) { return handleError(reply, error, request.id) }
  })
  app.post('/api/v1/admin/supplier-connections/:id/catalog/goods/:goodsId', {
    preHandler: [requireAdministrator, adminCsrf], config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['admin', 'catalog'], summary: 'Read V3 goods detail, specifications and purchase templates',
      params: { type: 'object', required: ['id', 'goodsId'], additionalProperties: false, properties: {
        id: { type: 'string', format: 'uuid' }, goodsId: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
      } }, response: { 200: ApiSuccessSchemaOf(SupplierCatalogProductSchema), ...readErrors } },
  }, async (request, reply) => {
    try {
      const { id, goodsId } = request.params as { id: string; goodsId: string }
      const context = await readContext(id)
      const result = await readKayixinGoodDetail(config, context.supplier, context.identity, Number(goodsId))
      await assertReadVersion(id, context.version.id)
      return success(result, request.id)
    } catch (error) { return handleError(reply, error, request.id) }
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
