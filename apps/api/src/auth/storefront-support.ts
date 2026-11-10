import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  StorefrontSupportSettingsSchema,
  UpdateStorefrontSupportBodySchema,
  failure,
  storefrontSupportLimits,
  success,
  type StorefrontSupportChannel,
  type UpdateStorefrontSupportBody,
} from '@aikayun/contracts'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { requireAdmin, verifyCsrf } from './admin.js'

// Unicode matching rejects lone surrogates without rejecting valid supplementary characters.
const invalidTextCharacter = /[\p{Cc}\p{Cs}]/u

function normalizeText(raw: string): string | undefined {
  const value = raw.trim()
  if (!value || invalidTextCharacter.test(raw)) return undefined
  return value
}

function normalizeHttps(value: string): string | undefined {
  // Require an explicit authority. URL alone also accepts missing/extra slashes and backslashes.
  const authority = /^https:\/\/([^/?#]+)/iu.exec(value)?.[1]
  if (!authority || authority.includes('@') || /[\s\\]/u.test(value)) return undefined

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined
    const href = url.href
    return href.length <= storefrontSupportLimits.https ? href : undefined
  } catch {
    return undefined
  }
}

function validateChannels(input: StorefrontSupportChannel[]): StorefrontSupportChannel[] | string {
  const channels: StorefrontSupportChannel[] = []
  const seen = new Set<string>()
  for (const [index, channel] of input.entries()) {
    const label = `第 ${index + 1} 个渠道`
    const name = normalizeText(channel.name)
    const value = normalizeText(channel.content)
    if (!name || !value) {
      return `${label}的名称和内容必须是非空文本，且不能包含无效字符或控制字符。`
    }
    const content = channel.type === 'https' ? normalizeHttps(value) : value
    if (!content) return `${label}请填写有效的 HTTPS 地址，且地址不能包含账号或密码。`

    const key = `${channel.type}:${content}`
    if (seen.has(key)) return `${label}的联系方式已存在，请移除重复项。`
    seen.add(key)
    channels.push({ type: channel.type, name, content })
  }
  return channels
}

export function registerStorefrontSupportRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const responseSchema = ApiSuccessSchemaOf(StorefrontSupportSettingsSchema)
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  async function readChannels() {
    const row = await db.selectFrom('storefront_support_settings').select('channels')
      .where('singleton', '=', true).executeTakeFirst()
    return { channels: row?.channels ?? [] }
  }

  app.get('/api/v1/public/storefront/support', {
    schema: {
      tags: ['public-storefront'],
      summary: 'Read the contact channels published by the store owner',
      response: { 200: responseSchema },
    },
  }, async request => success(await readChannels(), request.id))

  app.get('/api/v1/admin/storefront/support', {
    preHandler: authenticate,
    schema: {
      tags: ['admin'],
      summary: 'Read the storefront contact settings',
      response: { 200: responseSchema, 401: ApiErrorSchema },
    },
  }, async request => success(await readChannels(), request.id))

  app.put('/api/v1/admin/storefront/support', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin'],
      summary: 'Replace the ordered storefront contact channels',
      body: UpdateStorefrontSupportBodySchema,
      response: { 200: responseSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const channels = validateChannels((request.body as UpdateStorefrontSupportBody).channels)
    if (typeof channels === 'string') {
      return reply.code(400).send(failure('STOREFRONT_SUPPORT_INVALID', channels, request.id))
    }

    // A single upsert replaces the whole ordered list atomically. Pass JSON as text
    // so the PostgreSQL driver does not encode the JavaScript array as a SQL array.
    const encoded = JSON.stringify(channels)
    const saved = await db.insertInto('storefront_support_settings').values({ singleton: true, channels: encoded })
      .onConflict(oc => oc.column('singleton').doUpdateSet({ channels: encoded }))
      .returning('channels').executeTakeFirstOrThrow()
    return success({ channels: saved.channels }, request.id)
  })
}
