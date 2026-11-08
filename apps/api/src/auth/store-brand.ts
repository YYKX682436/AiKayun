import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  StorefrontBrandSettingsSchema,
  UpdateStorefrontBrandBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type { StorefrontBrand, UpdateStorefrontBrandBody } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { requireAdmin, verifyCsrf } from './admin.js'

type BrandSettingsRow = {
  store_name: string | null
  store_logo_url: string | null
  store_brand_color: string | null
}

function toSettings(row: BrandSettingsRow | undefined): { brand: StorefrontBrand | null } {
  if (!row || row.store_name === null || row.store_logo_url === null || row.store_brand_color === null) {
    return { brand: null }
  }

  return {
    brand: {
      storeName: row.store_name,
      storeLogoUrl: row.store_logo_url,
      storeBrandColor: row.store_brand_color,
    },
  }
}

function normalizeName(value: string): string | undefined {
  const name = value.trim()
  if (!name || name.length > 80 || name.includes('<') || name.includes('>') || containsControlCharacters(name)) return undefined
  return name
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1F || code === 0x7F
  })
}

function normalizeLogoUrl(value: string): string | undefined {
  const candidate = value.trim()
  if (candidate.length > 2048 || candidate.includes('\\') || containsControlCharacters(candidate)) {
    return undefined
  }
  if (!candidate) return ''
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function normalizeColor(value: string): string | undefined {
  const color = value.trim()
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) return undefined
  if (color.length === 4) {
    return `#${color.slice(1).split('').map(channel => channel + channel).join('')}`.toUpperCase()
  }
  return color.toUpperCase()
}

function validateBrand(body: UpdateStorefrontBrandBody): StorefrontBrand | undefined {
  const storeName = normalizeName(body.storeName)
  const storeLogoUrl = normalizeLogoUrl(body.storeLogoUrl)
  const storeBrandColor = normalizeColor(body.storeBrandColor)
  if (storeName === undefined || storeLogoUrl === undefined || storeBrandColor === undefined) return undefined
  return { storeName, storeLogoUrl, storeBrandColor }
}

export function registerStoreBrandRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  app.get('/api/v1/public/storefront/brand', {
    schema: {
      tags: ['public-storefront'],
      summary: 'Read non-sensitive saved storefront brand settings',
      response: { 200: ApiSuccessSchemaOf(StorefrontBrandSettingsSchema) },
    },
  }, async (request, reply) => {
    const row = await db.selectFrom('storefront_brand_settings')
      .select(['store_name', 'store_logo_url', 'store_brand_color'])
      .where('singleton', '=', true)
      .executeTakeFirst()
    reply.header('cache-control', 'no-store')
    return success(toSettings(row), request.id)
  })

  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/storefront/brand', {
    preHandler: authenticate,
    schema: {
      tags: ['admin'],
      summary: 'Read saved storefront brand settings',
      response: {
        200: ApiSuccessSchemaOf(StorefrontBrandSettingsSchema),
        401: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const row = await db.selectFrom('storefront_brand_settings')
      .select(['store_name', 'store_logo_url', 'store_brand_color'])
      .where('singleton', '=', true)
      .executeTakeFirst()
    reply.header('cache-control', 'no-store')
    return success(toSettings(row), request.id)
  })

  app.put('/api/v1/admin/storefront/brand', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin'],
      summary: 'Update the single-instance storefront brand settings',
      body: UpdateStorefrontBrandBodySchema,
      response: {
        200: ApiSuccessSchemaOf(StorefrontBrandSettingsSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const brand = validateBrand(request.body as UpdateStorefrontBrandBody)
    if (!brand) {
      return reply.code(400).send(failure(
        'STOREFRONT_BRAND_INVALID',
        '店铺名称不能包含标记或控制字符，Logo 仅支持站内路径或 HTTPS 地址，品牌色请使用 #RGB 或 #RRGGBB。',
        request.id,
      ))
    }

    const saved = await db.insertInto('storefront_brand_settings').values({
      singleton: true,
      store_name: brand.storeName,
      store_logo_url: brand.storeLogoUrl,
      store_brand_color: brand.storeBrandColor,
      updated_at: new Date(),
    }).onConflict(oc => oc.column('singleton').doUpdateSet({
      store_name: brand.storeName,
      store_logo_url: brand.storeLogoUrl,
      store_brand_color: brand.storeBrandColor,
      updated_at: new Date(),
    })).returning(['store_name', 'store_logo_url', 'store_brand_color']).executeTakeFirstOrThrow()

    reply.header('cache-control', 'no-store')
    return success(toSettings(saved), request.id)
  })
}
