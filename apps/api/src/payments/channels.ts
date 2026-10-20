import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Transaction } from 'kysely'
import {
  AdminPaymentChannelListSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CreatePaymentChannelBodySchema,
  PaymentChannelIdParamsSchema,
  PaymentChannelMutationResultSchema,
  PaymentChannelTestResultSchema,
  PaymentCredentialReencryptionResultSchema,
  PublicPaymentChannelListSchema,
  UpdatePaymentChannelBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type { CreatePaymentChannelBody, ExternalPaymentMethod, PaymentProviderType, UpdatePaymentChannelBody } from '@aikayun/contracts'
import type { Kysely as KyselyType } from 'kysely'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import {
  decryptPaymentConfig,
  encryptPaymentConfig,
  parsePaymentConfig,
  requiredPaymentKeyRing,
  serializePaymentConfig,
  type EncryptedEnvelope,
} from './credentials.js'
import type { PaymentProviderAdapter } from './provider.js'

type DbTransaction = Transaction<Database>
type ChannelRow = {
  id: string
  provider_type: PaymentProviderType
  name: string
  enabled: boolean
  payment_methods: string[]
  display_order: number
  config_ciphertext: Buffer | null
  config_nonce: Buffer | null
  config_auth_tag: Buffer | null
  config_key_id: string | null
  credential_version: number
  created_at: Date
  updated_at: Date
}

class PaymentChannelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'PaymentChannelError'
  }
}

function handleChannelError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof PaymentChannelError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  throw error
}

function credentialContext(id: string, version: number): string {
  return `payment-channel:${id}:credential:${version}`
}

function attemptCredentialContext(id: string, configVersion: number): string {
  return `payment-attempt:${id}:config:${configVersion}`
}

function envelopeFromChannel(row: ChannelRow): EncryptedEnvelope | null {
  if (!row.config_ciphertext || !row.config_nonce || !row.config_auth_tag || !row.config_key_id) return null
  return { keyId: row.config_key_id, nonce: row.config_nonce, ciphertext: row.config_ciphertext, authTag: row.config_auth_tag }
}

function decryptChannelConfig(config: AppConfig, row: ChannelRow): Record<string, string> {
  const envelope = envelopeFromChannel(row)
  if (!envelope) throw new PaymentChannelError(409, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道尚未配置商户凭据。')
  return parsePaymentConfig(decryptPaymentConfig(config, credentialContext(row.id, row.credential_version), envelope))
}

function maskMerchantId(value: string | undefined): string | null {
  if (!value) return null
  if (value.length <= 4) return `${value.slice(0, 1)}***`
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(value.length - 4, 12))}${value.slice(-2)}`
}

async function loadChannel(db: KyselyType<Database>, id: string, lock = false): Promise<ChannelRow | undefined> {
  let query = db.selectFrom('payment_channels').selectAll().where('id', '=', id)
  if (lock) query = query.forUpdate()
  return await query.executeTakeFirst()
}

function safeChannel(config: AppConfig, row: ChannelRow) {
  let merchantIdMasked: string | null = null
  let providerAvailable = row.provider_type === 'zpay_epay_v1'
  if (row.config_ciphertext && config.paymentCredentialKeyRing) {
    try {
      merchantIdMasked = maskMerchantId(decryptChannelConfig(config, row).merchantId)
    } catch {
      providerAvailable = false
    }
  } else if (row.provider_type === 'zpay_epay_v1') {
    providerAvailable = false
  }
  return {
    id: row.id,
    providerType: row.provider_type,
    providerAvailable,
    name: row.name,
    enabled: row.enabled,
    paymentMethods: row.payment_methods as ExternalPaymentMethod[],
    displayOrder: row.display_order,
    merchantIdMasked,
    credentialsConfigured: row.config_ciphertext !== null,
    credentialVersion: row.credential_version,
    updatedAt: row.updated_at.toISOString(),
  }
}

function encryptedConfig(config: AppConfig, id: string, version: number, value: Record<string, string>) {
  const envelope = encryptPaymentConfig(config, credentialContext(id, version), serializePaymentConfig(value))
  return {
    config_ciphertext: envelope.ciphertext,
    config_nonce: envelope.nonce,
    config_auth_tag: envelope.authTag,
    config_key_id: envelope.keyId,
  }
}

function setAuditActor(trx: DbTransaction, adminId: string) {
  return sql`SELECT set_config('aikayun.admin_id', ${adminId}, true)`.execute(trx)
}

function normalizeCreate(body: CreatePaymentChannelBody): {
  name: string
  paymentMethods: ExternalPaymentMethod[]
  credentials: Record<string, string> | null
} {
  const name = body.name.trim()
  if (!name) throw new PaymentChannelError(400, 'INVALID_PAYMENT_CHANNEL', '通道名称不能为空。')
  if (body.providerType === 'codepay_unconfigured') {
    if (body.enabled || body.paymentMethods.length || body.merchantId || body.merchantKey) {
      throw new PaymentChannelError(422, 'CODEPAY_PROTOCOL_UNCONFIRMED', '尚未确认码支付服务商协议，码支付通道只能作为停用占位配置。')
    }
    return { name, paymentMethods: [], credentials: null }
  }
  if (!body.paymentMethods.length || !body.merchantId?.trim() || !body.merchantKey?.trim()) {
    throw new PaymentChannelError(422, 'PAYMENT_CREDENTIALS_REQUIRED', '易支付通道需要至少一种支付方式、商户号和商户密钥。')
  }
  return {
    name,
    paymentMethods: [...new Set(body.paymentMethods)],
    credentials: { merchantId: body.merchantId!.trim(), merchantKey: body.merchantKey!.trim() },
  }
}

function providerFor(providerType: PaymentProviderType, provider: PaymentProviderAdapter): PaymentProviderAdapter {
  if (providerType !== provider.id) {
    throw new PaymentChannelError(409, 'PAYMENT_PROVIDER_NOT_AVAILABLE', '该服务商协议尚未完成核实，不能发起真实支付。')
  }
  return provider
}

async function insertChannelAudit(
  trx: DbTransaction,
  adminId: string,
  channelId: string,
  summary: Record<string, unknown>,
): Promise<void> {
  await trx.insertInto('payment_channel_audit_events').values({
    id: randomUUID(),
    payment_channel_id: channelId,
    administrator_id: adminId,
    action: 'encryption_reencrypted',
    summary,
  }).execute()
}

function validateProviderType(providerType: PaymentProviderType): void {
  if (providerType !== 'zpay_epay_v1' && providerType !== 'codepay_unconfigured') {
    throw new PaymentChannelError(422, 'PAYMENT_PROVIDER_NOT_AVAILABLE', '未实现或未核实该服务商协议。')
  }
}

async function createChannel(
  db: KyselyType<Database>, config: AppConfig, adminId: string, body: CreatePaymentChannelBody,
): Promise<ChannelRow> {
  validateProviderType(body.providerType)
  const normalized = normalizeCreate(body)
  const id = randomUUID()
  if (body.providerType === 'zpay_epay_v1') requiredPaymentKeyRing(config)
  return await db.transaction().execute(async (trx) => {
    await setAuditActor(trx, adminId)
    const encrypted = normalized.credentials
      ? encryptedConfig(config, id, 1, normalized.credentials)
      : { config_ciphertext: null, config_nonce: null, config_auth_tag: null, config_key_id: null }
    await trx.insertInto('payment_channels').values({
      id,
      provider_type: body.providerType,
      name: normalized.name,
      enabled: body.providerType === 'zpay_epay_v1' && body.enabled,
      payment_methods: normalized.paymentMethods,
      display_order: body.displayOrder,
      ...encrypted,
      credential_version: normalized.credentials ? 1 : 0,
      created_by_admin_id: adminId,
      updated_by_admin_id: adminId,
    }).execute()
    return (await loadChannel(trx as unknown as KyselyType<Database>, id))!
  })
}

async function updateChannel(
  db: KyselyType<Database>, config: AppConfig, adminId: string, id: string, body: UpdatePaymentChannelBody,
): Promise<ChannelRow> {
  return await db.transaction().execute(async (trx) => {
    await setAuditActor(trx, adminId)
    const existing = await loadChannel(trx as unknown as KyselyType<Database>, id, true)
    if (!existing) throw new PaymentChannelError(404, 'PAYMENT_CHANNEL_NOT_FOUND', '支付通道不存在。')
    const name = body.name?.trim() ?? existing.name
    if (!name) throw new PaymentChannelError(400, 'INVALID_PAYMENT_CHANNEL', '通道名称不能为空。')
    let methods: ExternalPaymentMethod[] = body.paymentMethods ?? existing.payment_methods as ExternalPaymentMethod[]
    const isCodePay = existing.provider_type === 'codepay_unconfigured'
    let enabled = body.enabled ?? existing.enabled
    if (isCodePay) {
      if (enabled || methods.length || body.merchantId || body.merchantKey) {
        throw new PaymentChannelError(422, 'CODEPAY_PROTOCOL_UNCONFIRMED', '尚未确认码支付服务商协议，码支付通道只能作为停用占位配置。')
      }
      methods = []
      enabled = false
    } else if (!methods.length) {
      throw new PaymentChannelError(422, 'PAYMENT_METHOD_REQUIRED', '易支付通道至少需要一种支付方式。')
    }

    let credentialVersion = existing.credential_version
    let encrypted = {
      config_ciphertext: existing.config_ciphertext,
      config_nonce: existing.config_nonce,
      config_auth_tag: existing.config_auth_tag,
      config_key_id: existing.config_key_id,
    }
    const credentialsChanged = !isCodePay && (body.merchantId !== undefined || body.merchantKey !== undefined)
    if (credentialsChanged) {
      requiredPaymentKeyRing(config)
      const previous = decryptChannelConfig(config, existing)
      const merchantId = body.merchantId?.trim() || previous.merchantId
      const merchantKey = body.merchantKey?.trim() || previous.merchantKey
      if (!merchantId || !merchantKey) {
        throw new PaymentChannelError(422, 'PAYMENT_CREDENTIALS_REQUIRED', '商户号和商户密钥不能为空。')
      }
      const next: Record<string, string> = { merchantId, merchantKey }
      credentialVersion += 1
      encrypted = encryptedConfig(config, id, credentialVersion, next)
    }
    await trx.updateTable('payment_channels').set({
      name,
      enabled,
      payment_methods: methods,
      display_order: body.displayOrder ?? existing.display_order,
      ...encrypted,
      credential_version: credentialVersion,
      updated_by_admin_id: adminId,
    }).where('id', '=', id).execute()
    return (await loadChannel(trx as unknown as KyselyType<Database>, id))!
  })
}

async function reencryptCredentials(
  db: KyselyType<Database>, config: AppConfig, adminId: string,
): Promise<{ channelsReencrypted: number; attemptsReencrypted: number; activeKeyId: string }> {
  const ring = requiredPaymentKeyRing(config)
  let channelsReencrypted = 0
  let attemptsReencrypted = 0
  await db.transaction().execute(async (trx) => {
    await setAuditActor(trx, adminId)
    const channels = await trx.selectFrom('payment_channels').selectAll().orderBy('id').forUpdate().execute()
    const rewrappedChannelIds = new Set<string>()
    for (const channel of channels) {
      const envelope = envelopeFromChannel(channel)
      if (!envelope || envelope.keyId === ring.activeKeyId) continue
      const plaintext = decryptPaymentConfig(config, credentialContext(channel.id, channel.credential_version), envelope)
      const next = encryptPaymentConfig(config, credentialContext(channel.id, channel.credential_version), plaintext)
      await trx.updateTable('payment_channels').set({
        config_ciphertext: next.ciphertext,
        config_nonce: next.nonce,
        config_auth_tag: next.authTag,
        config_key_id: next.keyId,
        updated_by_admin_id: adminId,
      }).where('id', '=', channel.id).execute()
      rewrappedChannelIds.add(channel.id)
      channelsReencrypted += 1
    }

    const attempts = await trx.selectFrom('payment_attempts')
      .innerJoin('payment_attempt_secrets as secret', 'secret.payment_attempt_id', 'payment_attempts.id')
      .select([
        'payment_attempts.id as attempt_id', 'payment_attempts.channel_credential_version',
        'secret.envelope_version', 'secret.config_version', 'secret.key_id', 'secret.nonce',
        'secret.ciphertext', 'secret.auth_tag',
      ])
      .where('payment_attempts.payment_channel_id', 'is not', null)
      .orderBy('payment_attempts.id').orderBy('secret.envelope_version')
      .execute()
    const latest = new Map<string, typeof attempts[number]>()
    for (const item of attempts) latest.set(item.attempt_id, item)
    const perChannel = new Map<string, number>()
    for (const item of latest.values()) {
      if (item.key_id === ring.activeKeyId) continue
      const context = attemptCredentialContext(item.attempt_id, item.config_version)
      const plaintext = decryptPaymentConfig(config, context, {
        keyId: item.key_id, nonce: item.nonce, ciphertext: item.ciphertext, authTag: item.auth_tag,
      })
      const next = encryptPaymentConfig(config, context, plaintext)
      await trx.insertInto('payment_attempt_secrets').values({
        payment_attempt_id: item.attempt_id,
        envelope_version: item.envelope_version + 1,
        config_version: item.config_version,
        key_id: next.keyId,
        nonce: next.nonce,
        ciphertext: next.ciphertext,
        auth_tag: next.authTag,
      }).execute()
      const attempt = await trx.selectFrom('payment_attempts').select('payment_channel_id')
        .where('id', '=', item.attempt_id).executeTakeFirstOrThrow()
      if (attempt.payment_channel_id) {
        perChannel.set(attempt.payment_channel_id, (perChannel.get(attempt.payment_channel_id) ?? 0) + 1)
      }
      attemptsReencrypted += 1
    }
    for (const [channelId, count] of perChannel) {
      await insertChannelAudit(trx, adminId, channelId, {
        operation: 'attempt_credentials_reencrypted',
        attemptSecretsReencrypted: count,
        activeKeyId: ring.activeKeyId,
        channelEnvelopeAlsoReencrypted: rewrappedChannelIds.has(channelId),
      })
    }
  })
  return { channelsReencrypted, attemptsReencrypted, activeKeyId: ring.activeKeyId }
}

export function registerPaymentChannelRoutes(
  app: FastifyInstance,
  db: KyselyType<Database>,
  config: AppConfig,
  provider: PaymentProviderAdapter,
): void {
  const authenticate = requireAdmin(db, config)
  const csrf = verifyCsrf(config)

  app.get('/api/v1/public/payment-channels', {
    schema: {
      tags: ['payments'], summary: 'List enabled payment methods without exposing provider configuration',
      response: { 200: ApiSuccessSchemaOf(PublicPaymentChannelListSchema) },
    },
  }, async (request) => {
    const rows = await db.selectFrom('payment_channels').select(['id', 'name', 'payment_methods'])
      .where('enabled', '=', true).where('provider_type', '=', 'zpay_epay_v1')
      .where('config_ciphertext', 'is not', null)
      .orderBy('display_order').orderBy('created_at').orderBy('id').execute()
    return success({ items: rows.filter(row => row.payment_methods.length > 0).map(row => ({
      id: row.id, name: row.name, paymentMethods: row.payment_methods as ExternalPaymentMethod[],
    })) }, request.id)
  })

  app.get('/api/v1/admin/payment-channels', {
    preHandler: authenticate,
    schema: {
      tags: ['admin-payments'], summary: 'List payment channels without returning plaintext credentials',
      response: { 200: ApiSuccessSchemaOf(AdminPaymentChannelListSchema), 401: ApiErrorSchema },
    },
  }, async (request) => {
    const rows = await db.selectFrom('payment_channels').selectAll()
      .orderBy('display_order').orderBy('created_at').orderBy('id').execute()
    return success({ items: rows.map(row => safeChannel(config, row)) }, request.id)
  })

  app.post('/api/v1/admin/payment-channels', {
    logLevel: 'silent',
    preHandler: [authenticate, csrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin-payments'], summary: 'Create a payment channel and store credentials encrypted',
      body: CreatePaymentChannelBodySchema,
      response: { 201: ApiSuccessSchemaOf(PaymentChannelMutationResultSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 422: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const channel = await createChannel(db, config, request.admin!.id, request.body as CreatePaymentChannelBody)
      return reply.code(201).send(success({ channel: safeChannel(config, channel) }, request.id))
    } catch (error) { return handleChannelError(error, reply, request.id) }
  })

  app.patch('/api/v1/admin/payment-channels/:id', {
    logLevel: 'silent',
    preHandler: [authenticate, csrf],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin-payments'], summary: 'Update payment channel settings or rotate merchant credentials',
      params: PaymentChannelIdParamsSchema,
      body: UpdatePaymentChannelBodySchema,
      response: { 200: ApiSuccessSchemaOf(PaymentChannelMutationResultSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 422: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const channel = await updateChannel(db, config, request.admin!.id, params.id, request.body as UpdatePaymentChannelBody)
      return success({ channel: safeChannel(config, channel) }, request.id)
    } catch (error) { return handleChannelError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/payment-channels/:id/test', {
    logLevel: 'silent',
    preHandler: [authenticate, csrf],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin-payments'], summary: 'Validate a ZPAY merchant configuration when its balance test endpoint is available',
      params: PaymentChannelIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(PaymentChannelTestResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string }
      const row = await loadChannel(db, params.id)
      if (!row) throw new PaymentChannelError(404, 'PAYMENT_CHANNEL_NOT_FOUND', '支付通道不存在。')
      const selectedProvider = providerFor(row.provider_type, provider)
      const credentials = decryptChannelConfig(config, row)
      if (!credentials.merchantId || !credentials.merchantKey) {
        throw new PaymentChannelError(409, 'PAYMENT_CHANNEL_NOT_CONFIGURED', '支付通道尚未配置有效商户凭据。')
      }
      const valid = await selectedProvider.testConfiguration({
        merchantId: credentials.merchantId, merchantKey: credentials.merchantKey,
      })
      return success({ valid, message: valid ? '服务商确认配置可用。' : '服务商未能确认配置，请检查商户号、密钥和服务商连通性。' }, request.id)
    } catch (error) { return handleChannelError(error, reply, request.id) }
  })

  app.post('/api/v1/admin/payment-channels/reencrypt', {
    logLevel: 'silent',
    preHandler: [authenticate, csrf],
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin-payments'], summary: 'Re-encrypt current channel and historical attempt snapshots with the active environment key',
      response: { 200: ApiSuccessSchemaOf(PaymentCredentialReencryptionResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const result = await reencryptCredentials(db, config, request.admin!.id)
      return success(result, request.id)
    } catch (error) { return handleChannelError(error, reply, request.id) }
  })
}
