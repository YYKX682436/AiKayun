import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { hashPassword } from '../src/auth/password.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { defaultProductIdentityFactory } from '../src/catalog/admin-products.js'
import type { ProductIdentityFactory } from '../src/catalog/admin-products.js'
import type { Database } from '../src/db/types.js'
import type { CreateProductBody, ProductDetail } from '@aikayun/contracts'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const testEmail = 'admin@example.com'
const testPassword = 'TestOnly-Valid-Password-2026!'
const testOrigin = 'http://localhost:3000'

let app: FastifyInstance
let db: Kysely<Database>
let skuCodeOverride: string | undefined
let nextTestClient = 20
const migrationSentinel = {
  productId: '00000000-0000-4000-8000-000000000101',
  variantId: '00000000-0000-4000-8000-000000000102',
  skuCode: 'SKU-MIGRATION-SENTINEL',
}

const productIdentityFactory: ProductIdentityFactory = {
  ...defaultProductIdentityFactory,
  nextSkuCode: () => skuCodeOverride ?? defaultProductIdentityFactory.nextSkuCode(),
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find((value) => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0] ?? ''
}

async function getCsrf(): Promise<{ token: string; cookie: string }> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  expect(response.statusCode).toBe(200)
  const body = response.json<{ data: { csrfToken: string } }>()
  return { token: body.data.csrfToken, cookie: cookieFrom(response, 'aikayun_admin_csrf') }
}

async function loginAdmin(): Promise<{ sessionCookie: string; csrf: { token: string; cookie: string } }> {
  const csrf = await getCsrf()
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    remoteAddress: `192.0.2.${nextTestClient++}`,
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    payload: { email: testEmail, password: testPassword },
  })
  expect(login.statusCode).toBe(200)
  return { sessionCookie: cookieFrom(login, 'aikayun_admin_session'), csrf }
}

function productBody(name: string, salePrice = '19.90'): CreateProductBody {
  return {
    name,
    description: 'Integration test product',
    productType: 'digital',
    defaultSku: { salePrice },
  }
}

function productHeaders(auth: { sessionCookie: string; csrf: { token: string; cookie: string } }) {
  return {
    origin: testOrigin,
    cookie: `${auth.sessionCookie}; ${auth.csrf.cookie}`,
    'x-csrf-token': auth.csrf.token,
  }
}

async function createTestProduct(auth: Awaited<ReturnType<typeof loginAdmin>>, name: string): Promise<ProductDetail> {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/admin/products', headers: productHeaders(auth), payload: productBody(name),
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ data: ProductDetail }>().data
}

function optionGroup(
  name: string,
  groupId: string,
  options: Array<{ id: string; name: string; sortOrder?: number; enabled?: boolean }>,
  sortOrder = 0,
  enabled = true,
) {
  return {
    id: groupId,
    name,
    sortOrder,
    enabled,
    values: options.map((option, index) => ({
      id: option.id,
      name: option.name,
      sortOrder: option.sortOrder ?? index,
      enabled: option.enabled ?? true,
    })),
  }
}

async function saveMatrix(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/admin/products/${productId}/variant-matrix`,
    headers: productHeaders(auth),
    payload,
  })
}

beforeAll(async () => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test')
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run API integration tests unless TEST_DATABASE_URL names a database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`drop schema public cascade`.execute(db)
  await sql`create schema public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migratedAdminSchema = await migrator.migrateTo('202610150001_admin_auth')
  if (migratedAdminSchema.error) throw migratedAdminSchema.error

  await db.insertInto('admin_users').values({
    id: randomUUID(),
    email: testEmail,
    password_hash: await hashPassword(testPassword),
  }).execute()

  const migratedCatalog = await migrator.migrateTo('202610160001_product_catalog_core')
  if (migratedCatalog.error) throw migratedCatalog.error

  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: migrationSentinel.productId,
      name: '迁移前已有商品',
      description: '必须跨前进迁移保留',
      product_type: 'digital',
      status: 'draft',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: migrationSentinel.variantId,
      product_id: migrationSentinel.productId,
      sku_code: migrationSentinel.skuCode,
      combination_key: '',
      sale_price: '19.90',
      enabled: true,
    }).execute()
  })

  const upgradedSchema = await migrator.migrateToLatest()
  if (upgradedSchema.error) throw upgradedSchema.error
  const repeatedUpgrade = await migrator.migrateToLatest()
  if (repeatedUpgrade.error) throw repeatedUpgrade.error

  const config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: testOrigin,
    COOKIE_SECURE: 'false',
  })
  app = await createApp({ db, config, logger: false, productIdentityFactory })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
})

describe('Fastify API with PostgreSQL 18', () => {
  it('serves enveloped health checks, readiness and generated OpenAPI', async () => {
    const live = await app.inject('/api/v1/health/live')
    expect(live.statusCode).toBe(200)
    expect(live.json().data.service).toBe('aikayun-api')
    expect(live.json().meta.requestId).toBeTruthy()

    const ready = await app.inject('/api/v1/health/ready')
    expect(ready.statusCode).toBe(200)
    expect(ready.json().data.database).toBe('ready')

    const openapi = await app.inject('/api/docs/json')
    expect(openapi.statusCode).toBe(200)
    expect(openapi.json().paths['/api/v1/admin/auth/login']).toBeDefined()
    expect(openapi.json().paths['/api/v1/admin/products']).toBeDefined()
    expect(openapi.json().paths['/api/v1/admin/products/{id}']).toBeDefined()
  })

  it('validates input and rejects CSRF and unauthenticated admin requests', async () => {
    const unauthorized = await app.inject('/api/v1/admin/overview')
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.json().error.code).toBe('UNAUTHORIZED')

    const csrf = await getCsrf()
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      headers: { origin: 'https://attacker.example', cookie: csrf.cookie, 'x-csrf-token': csrf.token },
      payload: { email: testEmail, password: testPassword },
    })
    expect(badOrigin.statusCode).toBe(403)
    expect(badOrigin.json().error.code).toBe('CSRF_INVALID')

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
      payload: { email: 'not-an-email', password: testPassword, unexpected: true },
    })
    expect(invalidBody.statusCode).toBe(400)
    expect(invalidBody.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('creates a secure server-side session, validates it and revokes it on logout', async () => {
    const csrf = await getCsrf()
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
      payload: { email: testEmail, password: testPassword },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json().data.admin.email).toBe(testEmail)

    const sessionCookie = cookieFrom(login, 'aikayun_admin_session')
    expect(sessionCookie).not.toContain(testPassword)
    const sessionHeader = login.headers['set-cookie']
    const sessionSetCookie = Array.isArray(sessionHeader) ? sessionHeader.find((value) => value.startsWith('aikayun_admin_session=')) : sessionHeader
    expect(sessionSetCookie).toContain('HttpOnly')
    expect(sessionSetCookie).toContain('SameSite=Lax')

    const session = await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers: { cookie: sessionCookie } })
    expect(session.statusCode).toBe(200)
    expect(session.json().data.admin.email).toBe(testEmail)

    const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: { cookie: sessionCookie } })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().data.administrator).toBe(testEmail)

    const logoutCsrf = await getCsrf()
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/logout',
      headers: {
        origin: testOrigin,
        cookie: `${sessionCookie}; ${logoutCsrf.cookie}`,
        'x-csrf-token': logoutCsrf.token,
      },
    })
    expect(logout.statusCode).toBe(200)
    expect(logout.json().data.loggedOut).toBe(true)

    const afterLogout = await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers: { cookie: sessionCookie } })
    expect(afterLogout.statusCode).toBe(401)

    const persisted = await sql<{ active_sessions: string }>`
      select count(*)::text as active_sessions from admin_sessions where revoked_at is null
    `.execute(db)
    expect(persisted.rows[0]?.active_sessions).toBe('0')
  })

  it('creates and reads a draft product with a real default SKU and stable independent IDs', async () => {
    const auth = await loginAdmin()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: productBody('相同名称'),
    })

    expect(response.statusCode).toBe(201)
    const created = response.json<{ data: ProductDetail }>().data
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(created.name).toBe('相同名称')
    expect(created.productType).toBe('digital')
    expect(created.status).toBe('draft')
    expect(created.revision).toBe(1)
    expect(created.categories).toEqual([])
    expect(created.optionGroups).toEqual([])
    expect(created.attributes).toEqual([])
    expect(created.variants).toHaveLength(1)
    const defaultSku = created.variants[0]!
    expect(defaultSku.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(defaultSku.id).not.toBe(created.id)
    expect(defaultSku.productId).toBe(created.id)
    expect(defaultSku.skuCode).toMatch(/^SKU-[0-9A-F]{32}$/)
    expect(defaultSku.salePrice).toBe('19.90')
    expect(defaultSku.currency).toBe('CNY')
    expect(defaultSku.enabled).toBe(true)
    expect(defaultSku.isDefault).toBe(true)
    expect(defaultSku.revision).toBe(1)

    const databasePrice = await db.selectFrom('product_variants')
      .select(['product_id', 'sale_price'])
      .where('id', '=', defaultSku.id)
      .executeTakeFirstOrThrow()
    expect(databasePrice.product_id).toBe(created.id)
    expect(typeof databasePrice.sale_price).toBe('string')
    expect(databasePrice.sale_price).toBe('19.90000')

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${created.id}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(read.statusCode).toBe(200)
    expect(read.json<{ data: ProductDetail }>().data).toEqual(created)

    const sameName = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: productBody('相同名称', '0.01'),
    })
    expect(sameName.statusCode).toBe(201)
    const separateProduct = sameName.json<{ data: ProductDetail }>().data
    expect(separateProduct.id).not.toBe(created.id)
    expect(separateProduct.variants[0]?.id).not.toBe(defaultSku.id)
  })

  it('enforces administrator auth, CSRF, strict payloads, and valid CNY sale-price strings', async () => {
    const unauthorizedGet = await app.inject('/api/v1/admin/products/00000000-0000-4000-8000-000000000000')
    expect(unauthorizedGet.statusCode).toBe(401)
    const unauthorizedPost = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      payload: productBody('未授权商品'),
    })
    expect(unauthorizedPost.statusCode).toBe(401)

    const auth = await loginAdmin()
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: { cookie: auth.sessionCookie, origin: testOrigin },
      payload: productBody('缺少 CSRF'),
    })
    expect(missingCsrf.statusCode).toBe(403)
    expect(missingCsrf.json().error.code).toBe('CSRF_INVALID')

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: { ...productBody('未知字段'), skuCode: 'CLIENT-CONTROLLED' },
    })
    expect(unknownField.statusCode).toBe(400)
    expect(unknownField.json().error.code).toBe('VALIDATION_ERROR')

    const unknownNestedField = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: { ...productBody('未知嵌套字段'), defaultSku: { salePrice: '1.00', combinationKey: 'client-key' } },
    })
    expect(unknownNestedField.statusCode).toBe(400)

    const invalidType = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: { ...productBody('非法类型'), productType: 'subscription' },
    })
    expect(invalidType.statusCode).toBe(400)
    expect(invalidType.json().error.code).toBe('INVALID_PRODUCT_TYPE')

    for (const salePrice of ['-0.01', '1.001', '1e3', '10000000000000.00', '1.', '1.00\n']) {
      const invalidPrice = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        headers: productHeaders(auth),
        payload: productBody(`非法价格 ${salePrice}`, salePrice),
      })
      expect(invalidPrice.statusCode).toBe(400)
      expect(invalidPrice.json().error.code).toBe('INVALID_SALE_PRICE')
    }

    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/products/not-a-uuid',
      headers: { cookie: auth.sessionCookie },
    })
    expect(invalidId.statusCode).toBe(400)

    const notFound = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/products/00000000-0000-4000-8000-000000000000',
      headers: { cookie: auth.sessionCookie },
    })
    expect(notFound.statusCode).toBe(404)
    expect(notFound.json().error.code).toBe('PRODUCT_NOT_FOUND')
  })

  it('preserves exact zero, cent, and two-decimal prices through PostgreSQL and the read API', async () => {
    const auth = await loginAdmin()
    for (const [price, stored, returned] of [
      ['0', '0.00000', '0.00'],
      ['0.01', '0.01000', '0.01'],
      ['19.90', '19.90000', '19.90'],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        headers: productHeaders(auth),
        payload: productBody(`精确金额 ${price}`, price),
      })
      expect(response.statusCode).toBe(201)
      const product = response.json<{ data: ProductDetail }>().data
      const sku = product.variants[0]!
      expect(sku.salePrice).toBe(returned)
      const row = await db.selectFrom('product_variants')
        .select('sale_price')
        .where('id', '=', sku.id)
        .executeTakeFirstOrThrow()
      expect(typeof row.sale_price).toBe('string')
      expect(row.sale_price).toBe(stored)

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/products/${product.id}`,
        headers: { cookie: auth.sessionCookie },
      })
      expect(read.statusCode).toBe(200)
      expect(read.json<{ data: ProductDetail }>().data.variants[0]?.salePrice).toBe(returned)
    }
  })

  it('rolls back product creation and reports a generated SKU-code conflict', async () => {
    const auth = await loginAdmin()
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: productBody('冲突基准商品'),
    })
    expect(first.statusCode).toBe(201)
    const existingSkuCode = first.json<{ data: ProductDetail }>().data.variants[0]!.skuCode
    const before = await sql<{ products: string; variants: string }>`
      select
        (select count(*)::text from products) as products,
        (select count(*)::text from product_variants) as variants
    `.execute(db)

    skuCodeOverride = existingSkuCode
    let conflict: Awaited<ReturnType<typeof app.inject>>
    try {
      conflict = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        headers: productHeaders(auth),
        payload: productBody('必须回滚的商品'),
      })
    } finally {
      skuCodeOverride = undefined
    }

    expect(conflict!.statusCode).toBe(409)
    expect(conflict!.json().error.code).toBe('SKU_CODE_CONFLICT')
    const after = await sql<{ products: string; variants: string }>`
      select
        (select count(*)::text from products) as products,
        (select count(*)::text from product_variants) as variants
    `.execute(db)
    expect(after.rows[0]).toEqual(before.rows[0])
    expect(await db.selectFrom('products').select('id').where('name', '=', '必须回滚的商品').execute()).toHaveLength(0)
  })

  it('enforces product, SKU, default-combination, revision, and sale-price constraints in PostgreSQL', async () => {
    const auth = await loginAdmin()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: productBody('数据库约束基准'),
    })
    const product = created.json<{ data: ProductDetail }>().data
    const sku = product.variants[0]!

    await expect(db.insertInto('products').values({
      id: randomUUID(), name: '非法性质', description: '', product_type: 'other' as never, status: 'draft',
    }).execute()).rejects.toMatchObject({ code: '23514', constraint: 'products_product_type_check' })
    await expect(db.insertInto('products').values({
      id: randomUUID(), name: '非法状态', description: '', product_type: 'digital', status: 'publishing' as never,
    }).execute()).rejects.toMatchObject({ code: '23514', constraint: 'products_status_check' })
    await expect(db.insertInto('products').values({
      id: randomUUID(), name: '非法修订', description: '', product_type: 'digital', status: 'draft', revision: 0,
    }).execute()).rejects.toMatchObject({ code: '23514', constraint: 'products_revision_check' })
    await expect(db.insertInto('products').values({
      id: randomUUID(), name: '无 SKU 商品', description: '', product_type: 'digital', status: 'draft',
    }).execute()).rejects.toMatchObject({ code: '23514', constraint: 'product_requires_sku' })

    await expect(db.insertInto('product_variants').values({
      id: randomUUID(), product_id: randomUUID(), sku_code: 'SKU-MISSING-PRODUCT',
      combination_key: '', sale_price: '1.00',
    }).execute()).rejects.toMatchObject({ code: '23503', constraint: 'product_variants_product_id_fkey' })
    await expect(db.insertInto('product_variants').values({
      id: randomUUID(), product_id: product.id, sku_code: `SKU-${randomUUID()}`,
      combination_key: '', sale_price: '1.00',
    }).execute()).rejects.toMatchObject({ code: '23505', constraint: 'product_variants_product_combination_unique' })
    await expect(db.insertInto('product_variants').values({
      id: randomUUID(), product_id: product.id, sku_code: `SKU-${randomUUID()}`,
      combination_key: 'invalid-negative', sale_price: '-0.01',
    }).execute()).rejects.toMatchObject({ code: '23514', constraint: 'product_variants_sale_price_check' })
    await expect(db.insertInto('product_variants').values({
      id: randomUUID(), product_id: product.id, sku_code: `SKU-${randomUUID()}`,
      combination_key: 'invalid-scale', sale_price: '1.001',
    }).execute()).rejects.toMatchObject({ code: '23514', constraint: 'product_variants_sale_price_check' })
    await expect(db.insertInto('product_variants').values({
      id: randomUUID(), product_id: product.id, sku_code: `SKU-${randomUUID()}`,
      combination_key: 'invalid-range', sale_price: '10000000000000.00',
    }).execute()).rejects.toMatchObject({ code: '22003' })

    const optionGroupId = randomUUID()
    const optionValueId = randomUUID()
    const extraSkuId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('product_option_groups').values({
        id: optionGroupId, product_id: product.id, name: '设备', sort_order: 0,
      }).execute()
      await trx.insertInto('product_option_values').values({
        id: optionValueId, product_id: product.id, option_group_id: optionGroupId, name: '一台', sort_order: 0,
      }).execute()
      await trx.updateTable('product_variants').set({ enabled: false }).where('id', '=', sku.id).execute()
      await trx.insertInto('product_variants').values({
        id: extraSkuId,
        product_id: product.id,
        sku_code: `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
        combination_key: `v1:${optionValueId}`,
        sale_price: '19.90',
      }).execute()
      await trx.insertInto('product_variant_option_values').values({
        product_id: product.id, product_variant_id: extraSkuId,
        option_group_id: optionGroupId, option_value_id: optionValueId,
      }).execute()
    })
    const multipleSkus = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${product.id}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(multipleSkus.statusCode).toBe(200)
    const variants = multipleSkus.json<{ data: ProductDetail }>().data.variants
    expect(variants).toHaveLength(2)
    expect(variants.filter((variant) => variant.isDefault)).toHaveLength(1)
    expect(variants.some((variant) => 'combinationKey' in variant)).toBe(false)
    expect(variants.filter((variant) => !variant.isDefault)).toHaveLength(1)

    const revisionBeforeUpdate = await db.selectFrom('products').select('revision').where('id', '=', product.id).executeTakeFirstOrThrow()
    await db.updateTable('products').set({ description: '修订触发器验证' }).where('id', '=', product.id).execute()
    const revised = await db.selectFrom('products').select('revision').where('id', '=', product.id).executeTakeFirstOrThrow()
    expect(revised.revision).toBe(revisionBeforeUpdate.revision + 1)
    expect(sku.revision).toBe(1)

    await expect(sql`TRUNCATE TABLE product_variants`.execute(db)).rejects.toBeDefined()
    expect(await db.selectFrom('product_variants').select('id').where('product_id', '=', product.id).execute()).toHaveLength(2)
  })

  it('can rerun the forward migration without duplicating tables or changing existing data', async () => {
    const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
    const firstRepeat = await migrator.migrateToLatest()
    const secondRepeat = await migrator.migrateToLatest()
    expect(firstRepeat.error).toBeUndefined()
    expect(secondRepeat.error).toBeUndefined()

    const result = await sql<{ table_name: string }>`
      select tablename as table_name from pg_tables
      where schemaname = 'public' and tablename not in ('kysely_migration', 'kysely_migration_lock')
      order by tablename
    `.execute(db)
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'admin_sessions', 'admin_users', 'product_attributes', 'product_categories',
      'product_category_assignments', 'product_option_groups', 'product_option_values',
      'product_variant_option_values', 'product_variants', 'products',
    ])
    const admin = await db.selectFrom('admin_users').select('email').where('email', '=', testEmail).executeTakeFirst()
    expect(admin?.email).toBe(testEmail)
    const migratedProduct = await db.selectFrom('products').select(['id', 'name']).where('id', '=', migrationSentinel.productId).executeTakeFirst()
    expect(migratedProduct).toEqual({ id: migrationSentinel.productId, name: '迁移前已有商品' })
    const migratedSku = await db.selectFrom('product_variants').select(['id', 'sku_code', 'sale_price'])
      .where('id', '=', migrationSentinel.variantId).executeTakeFirst()
    expect(migratedSku).toEqual({
      id: migrationSentinel.variantId,
      sku_code: migrationSentinel.skuCode,
      sale_price: '19.90000',
    })
  })

  it('requires at least one SKU but permits multi-SKU products without a default SKU', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '允许移除默认 SKU')
    const groupId = randomUUID()
    const blueId = randomUUID()
    const redId = randomUUID()
    const saved = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('期限', groupId, [{ id: blueId, name: '30天' }, { id: redId, name: '90天' }])],
      combinations: [
        { optionValueIds: [blueId], salePrice: '0.00', enabled: true },
        { optionValueIds: [redId], salePrice: '19.90', enabled: true },
      ],
    })
    expect(saved.statusCode).toBe(200)
    const result = saved.json<{ data: { product: ProductDetail } }>().data.product
    expect(result.variants).toHaveLength(2)
    expect(result.variants.every((variant) => !variant.isDefault)).toBe(true)
    expect(result.variants.some((variant) => variant.id === product.variants[0]!.id)).toBe(false)
    expect(result.optionGroups).toHaveLength(1)
    expect(result.variants.every((variant) => variant.options.length === 1)).toBe(true)
  })

  it('swaps SKU combinations transactionally without changing SKU identities and rolls back invalid replacements', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '规格组合替换')
    const groupId = randomUUID()
    const blueId = randomUUID()
    const redId = randomUUID()
    const initial = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('期限', groupId, [{ id: blueId, name: '30天' }, { id: redId, name: '90天' }])],
      combinations: [
        { optionValueIds: [blueId], salePrice: '1.00', enabled: true },
        { optionValueIds: [redId], salePrice: '2.00', enabled: true },
      ],
    })
    expect(initial.statusCode).toBe(200)
    const before = initial.json<{ data: { product: ProductDetail } }>().data.product
    const blueSku = before.variants.find((variant) => variant.options[0]?.valueId === blueId)!
    const redSku = before.variants.find((variant) => variant.options[0]?.valueId === redId)!

    const invalid = await saveMatrix(auth, product.id, {
      expectedRevision: before.revision,
      mode: 'selected',
      groups: before.optionGroups.map((group) => optionGroup(group.name, group.id, group.values)),
      combinations: [
        { skuId: blueSku.id, optionValueIds: [redId] },
        { skuId: redSku.id, optionValueIds: [redId] },
      ],
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('DUPLICATE_SKU_COMBINATION')
    const afterInvalid = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    expect(afterInvalid.json<{ data: ProductDetail }>().data.variants.map((variant) => [variant.id, variant.salePrice]))
      .toEqual(before.variants.map((variant) => [variant.id, variant.salePrice]))

    const swapped = await saveMatrix(auth, product.id, {
      expectedRevision: before.revision,
      mode: 'selected',
      groups: [optionGroup('期限改名', groupId, [
        { id: blueId, name: '季卡', sortOrder: 1 }, { id: redId, name: '月卡', sortOrder: 0 },
      ], 4)],
      combinations: [
        { skuId: blueSku.id, optionValueIds: [redId] },
        { skuId: redSku.id, optionValueIds: [blueId] },
      ],
    })
    expect(swapped.statusCode).toBe(200)
    const after = swapped.json<{ data: { product: ProductDetail; changes: Array<{ change: string }> } }>().data
    expect(after.changes.map((change) => change.change)).toEqual(['modified', 'modified'])
    expect(after.product.variants.map((variant) => [variant.id, variant.skuCode, variant.salePrice]).sort())
      .toEqual(before.variants.map((variant) => [variant.id, variant.skuCode, variant.salePrice]).sort())
    expect(after.product.variants.find((variant) => variant.id === blueSku.id)?.options[0]?.valueId).toBe(redId)
    expect(after.product.variants.find((variant) => variant.id === redSku.id)?.options[0]?.valueId).toBe(blueId)
    expect(after.product.optionGroups[0]?.name).toBe('期限改名')
    const savedKeys = await db.selectFrom('product_variants').select(['id', 'combination_key'])
      .where('product_id', '=', product.id).execute()
    expect(savedKeys.every((row) => row.combination_key === `v1:${row.id === blueSku.id ? redId : blueId}`)).toBe(true)
  })

  it('rejects deleting the last SKU and leaves its data and identity unchanged', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(await loginAdmin()),
      payload: productBody('不能没有 SKU'),
    })
    const sku = created.json<{ data: ProductDetail }>().data.variants[0]!
    const before = await db.selectFrom('product_variants').selectAll().where('id', '=', sku.id).executeTakeFirstOrThrow()

    await expect(db.deleteFrom('product_variants').where('id', '=', sku.id).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'product_requires_sku' })

    expect(await db.selectFrom('product_variants').selectAll().where('id', '=', sku.id).executeTakeFirst())
      .toEqual(before)
  })

  it.each([
    ['read committed', 'read committed', '23514'],
    ['repeatable read', 'repeatable read', '40001'],
  ] as const)('serializes concurrent SKU deletions at %s isolation', async (_label, isolation, expectedCode) => {
    const auth = await loginAdmin()
    const draft = await createTestProduct(auth, `并发删除 ${isolation}`)
    const groupId = randomUUID()
    const one = randomUUID()
    const three = randomUUID()
    const populated = await saveMatrix(auth, draft.id, {
      expectedRevision: draft.revision,
      mode: 'selected',
      groups: [optionGroup('设备', groupId, [{ id: one, name: '一台' }, { id: three, name: '三台' }])],
      combinations: [
        { optionValueIds: [one], salePrice: '1.00', enabled: true },
        { optionValueIds: [three], salePrice: '2.00', enabled: true },
      ],
    })
    const product = populated.json<{ data: { product: ProductDetail } }>().data.product
    const defaultSkuId = product.variants[0]!.id
    const secondSkuId = product.variants[1]!.id

    let releaseBarrier!: () => void
    const bothTransactionsReady = new Promise<void>((resolve) => { releaseBarrier = resolve })
    let arrivals = 0
    const waitForBothTransactions = async () => {
      arrivals += 1
      if (arrivals === 2) releaseBarrier()
      await bothTransactionsReady
    }
    const deleteInTransaction = (skuId: string) => db.transaction().setIsolationLevel(isolation).execute(async (trx) => {
      await trx.selectFrom('products').select('id').where('id', '=', product.id).executeTakeFirstOrThrow()
      await waitForBothTransactions()
      await trx.deleteFrom('product_variants').where('id', '=', skuId).execute()
    })
    const results = await Promise.allSettled([
      deleteInTransaction(defaultSkuId),
      deleteInTransaction(secondSkuId),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toMatchObject({ code: expectedCode })
    expect(await db.selectFrom('product_variants').select('id').where('product_id', '=', product.id).execute())
      .toHaveLength(1)
  }, 30_000)

  it('enforces a four-level category tree and rejects cycles and deep subtree moves', async () => {
    const auth = await loginAdmin()
    const createCategory = async (name: string, parentId?: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth),
        payload: { name, ...(parentId ? { parentId } : {}) },
      })
      expect(response.statusCode).toBe(201)
      return response.json<{ data: { id: string; parentId: string | null; revision: number } }>().data
    }
    const level1 = await createCategory('根')
    const level2 = await createCategory('子', level1.id)
    const level3 = await createCategory('孙', level2.id)
    const level4 = await createCategory('曾孙', level3.id)
    const tooDeep = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth),
      payload: { name: '第五级', parentId: level4.id },
    })
    expect(tooDeep.statusCode).toBe(400)
    expect(tooDeep.json().error.code).toBe('CATEGORY_DEPTH_LIMIT')

    const directCycle = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${level1.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: level1.revision, parentId: level2.id },
    })
    expect(directCycle.statusCode).toBe(400)
    expect(directCycle.json().error.code).toBe('CATEGORY_CYCLE')
    const indirectCycle = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${level2.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: level2.revision, parentId: level4.id },
    })
    expect(indirectCycle.statusCode).toBe(400)
    expect(indirectCycle.json().error.code).toBe('CATEGORY_CYCLE')

    const target1 = await createCategory('目标根')
    const target2 = await createCategory('目标二级', target1.id)
    const target3 = await createCategory('目标三级', target2.id)
    const source1 = await createCategory('待移动根')
    const source2 = await createCategory('待移动二级', source1.id)
    await createCategory('待移动三级', source2.id)
    const tooDeepMove = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${source1.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: source1.revision, parentId: target3.id },
    })
    expect(tooDeepMove.statusCode).toBe(400)
    expect(tooDeepMove.json().error.code).toBe('CATEGORY_DEPTH_LIMIT')

    const deleteParent = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/categories/${level1.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: level1.revision },
    })
    expect(deleteParent.statusCode).toBe(409)
    expect(deleteParent.json().error.code).toBe('CATEGORY_HAS_CHILDREN')
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/categories', headers: { cookie: auth.sessionCookie } })
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: { categories: Array<{ id: string }> } }>().data.categories).toHaveLength(10)
  })

  it('serializes opposite category moves so concurrent edits cannot form a cycle', async () => {
    const auth = await loginAdmin()
    const create = async (name: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name },
      })
      return response.json<{ data: { id: string; revision: number } }>().data
    }
    const left = await create('并发左')
    const right = await create('并发右')
    const results = await Promise.all([
      app.inject({
        method: 'PATCH', url: `/api/v1/admin/categories/${left.id}`, headers: productHeaders(auth),
        payload: { expectedRevision: left.revision, parentId: right.id },
      }),
      app.inject({
        method: 'PATCH', url: `/api/v1/admin/categories/${right.id}`, headers: productHeaders(auth),
        payload: { expectedRevision: right.revision, parentId: left.id },
      }),
    ])
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400])
    expect(results.find((result) => result.statusCode === 400)?.json().error.code).toBe('CATEGORY_CYCLE')
    const rows = await db.selectFrom('product_categories').select(['id', 'parent_id'])
      .where('id', 'in', [left.id, right.id]).execute()
    expect(rows.filter((row) => row.parent_id === null)).toHaveLength(1)
    expect(rows.filter((row) => row.parent_id !== null)).toHaveLength(1)
  })

  it('keeps multi-category relations explicit, ordered per product, and safe to delete', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '多分类商品')
    const secondProduct = await createTestProduct(auth, '独立分类排序商品')
    const createCategory = async (name: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name },
      })
      expect(response.statusCode).toBe(201)
      return response.json<{ data: { id: string; revision: number; isVisible: boolean } }>().data
    }
    const primary = await createCategory('主类')
    const secondary = await createCategory('辅类')

    const assigned = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision,
        assignments: [
          { categoryId: primary.id, isPrimary: true, sortOrder: 10 },
          { categoryId: secondary.id, isPrimary: false, sortOrder: 2 },
        ],
      },
    })
    expect(assigned.statusCode).toBe(200)
    const categorized = assigned.json<{ data: ProductDetail }>().data
    expect(categorized.categories.map((entry) => [entry.categoryId, entry.isPrimary])).toEqual([
      [primary.id, true], [secondary.id, false],
    ])
    expect(categorized.status).toBe('draft')

    const hideSecondary = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${secondary.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: secondary.revision, isVisible: false },
    })
    expect(hideSecondary.statusCode).toBe(200)
    const stillDraft = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    expect(stillDraft.json<{ data: ProductDetail }>().data.status).toBe('draft')

    const duplicate = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: {
        expectedRevision: categorized.revision,
        assignments: [
          { categoryId: primary.id, isPrimary: true, sortOrder: 0 },
          { categoryId: primary.id, isPrimary: false, sortOrder: 1 },
        ],
      },
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().error.code).toBe('DUPLICATE_PRODUCT_CATEGORY')
    const noPrimary = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: categorized.revision, assignments: [{ categoryId: primary.id, isPrimary: false, sortOrder: 0 }] },
    })
    expect(noPrimary.statusCode).toBe(400)
    expect(noPrimary.json().error.code).toBe('PRIMARY_CATEGORY_REQUIRED')

    const deletePrimary = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/categories/${primary.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: primary.revision },
    })
    expect(deletePrimary.statusCode).toBe(409)
    expect(deletePrimary.json().error.code).toBe('PRIMARY_CATEGORY_IN_USE')
    const deleteSecondary = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/categories/${secondary.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: hideSecondary.json<{ data: { revision: number } }>().data.revision },
    })
    expect(deleteSecondary.statusCode).toBe(409)
    expect(deleteSecondary.json().error.code).toBe('CATEGORY_HAS_PRODUCTS')

    const assignedSecond = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${secondProduct.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: secondProduct.revision, assignments: [{ categoryId: primary.id, isPrimary: true, sortOrder: 1 }] },
    })
    expect(assignedSecond.statusCode).toBe(200)
    const categoryOrders = await db.selectFrom('product_category_assignments').select(['product_id', 'sort_order'])
      .where('category_id', '=', primary.id).orderBy('product_id').execute()
    expect(categoryOrders.map((row) => row.sort_order).sort()).toEqual([1, 10])

    const movePrimary = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: categorized.revision, assignments: [{ categoryId: secondary.id, isPrimary: true, sortOrder: 3 }] },
    })
    expect(movePrimary.statusCode).toBe(200)
    const clearSecond = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${secondProduct.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: assignedSecond.json<{ data: ProductDetail }>().data.revision, assignments: [] },
    })
    expect(clearSecond.statusCode).toBe(200)
    const deletePrimaryAfterMove = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/categories/${primary.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: primary.revision },
    })
    expect(deletePrimaryAfterMove.statusCode).toBe(200)

    const clearFirst = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: movePrimary.json<{ data: ProductDetail }>().data.revision, assignments: [] },
    })
    expect(clearFirst.statusCode).toBe(200)
    const deleteSecondaryAfterMove = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/categories/${secondary.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: hideSecondary.json<{ data: { revision: number } }>().data.revision },
    })
    expect(deleteSecondaryAfterMove.statusCode).toBe(200)
    expect(await db.selectFrom('products').select('id').where('id', '=', product.id).executeTakeFirst()).toEqual({ id: product.id })
  })

  it('serializes concurrent product category replacements and keeps one primary category', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '并发分类关系商品')
    const createCategory = async (name: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name },
      })
      return response.json<{ data: { id: string } }>().data.id
    }
    const first = await createCategory('并发分类一')
    const second = await createCategory('并发分类二')
    const replacements = await Promise.all([
      app.inject({
        method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
        payload: { expectedRevision: product.revision, assignments: [{ categoryId: first, isPrimary: true, sortOrder: 0 }] },
      }),
      app.inject({
        method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
        payload: { expectedRevision: product.revision, assignments: [{ categoryId: second, isPrimary: true, sortOrder: 0 }] },
      }),
    ])
    expect(replacements.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const persisted = await db.selectFrom('product_category_assignments').select(['category_id', 'is_primary'])
      .where('product_id', '=', product.id).execute()
    expect(persisted).toHaveLength(1)
    expect(persisted.filter((assignment) => assignment.is_primary)).toHaveLength(1)
  })

  it('stores structured display attributes with stable IDs, sorting, deletion, and strict limits', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '展示属性商品')
    const initial = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision,
        attributes: [
          { name: '支持平台', value: 'Windows、macOS', sortOrder: 5 },
          { name: '软件版本', value: '2026', sortOrder: 1 },
          { name: '开发商', value: 'Example', sortOrder: 9 },
        ],
      },
    })
    expect(initial.statusCode).toBe(200)
    const first = initial.json<{ data: ProductDetail }>().data
    expect(first.attributes.map((attribute) => attribute.name)).toEqual(['软件版本', '支持平台', '开发商'])
    const byName = new Map(first.attributes.map((attribute) => [attribute.name, attribute]))

    const edited = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: {
        expectedRevision: first.revision,
        attributes: [
          { id: byName.get('开发商')!.id, name: '开发商', value: 'Example Studio', sortOrder: 0 },
          { id: byName.get('软件版本')!.id, name: '软件版本', value: '2026.1', sortOrder: 3 },
        ],
      },
    })
    expect(edited.statusCode).toBe(200)
    const second = edited.json<{ data: ProductDetail }>().data
    expect(second.attributes.map((attribute) => attribute.id).sort()).toEqual([
      byName.get('开发商')!.id, byName.get('软件版本')!.id,
    ].sort())
    expect(second.attributes.find((attribute) => attribute.name === '开发商')?.value).toBe('Example Studio')

    const tooMany = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: {
        expectedRevision: second.revision,
        attributes: Array.from({ length: 31 }, (_, index) => ({ name: `属性${index}`, value: '值', sortOrder: index })),
      },
    })
    expect(tooMany.statusCode).toBe(400)
    expect(tooMany.json().error.code).toBe('VALIDATION_ERROR')
    const tooLong = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: { expectedRevision: second.revision, attributes: [{ name: '平台', value: 'x'.repeat(501), sortOrder: 0 }] },
    })
    expect(tooLong.statusCode).toBe(400)
    expect(tooLong.json().error.code).toBe('VALIDATION_ERROR')
    const emptyName = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: { expectedRevision: second.revision, attributes: [{ name: '   ', value: '值', sortOrder: 0 }] },
    })
    expect(emptyName.statusCode).toBe(400)
    expect(emptyName.json().error.code).toBe('INVALID_PRODUCT_ATTRIBUTE')
    const duplicateNames = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: {
        expectedRevision: second.revision,
        attributes: [
          { name: '平台', value: 'Windows', sortOrder: 0 },
          { name: '平台', value: 'macOS', sortOrder: 1 },
        ],
      },
    })
    expect(duplicateNames.statusCode).toBe(400)
    expect(duplicateNames.json().error.code).toBe('PRODUCT_ATTRIBUTE_NAME_CONFLICT')

    const removed = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: { expectedRevision: second.revision, attributes: [] },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json<{ data: ProductDetail }>().data.attributes).toEqual([])
  })

  it('previews a sparse dynamic matrix and saves four valid combinations from six possible options', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '部分规格矩阵')
    const durations = ['30天', '90天', '365天'].map((name) => ({ id: randomUUID(), name }))
    const devices = ['1台', '3台'].map((name) => ({ id: randomUUID(), name }))
    const groups = [
      optionGroup('期限', randomUUID(), durations),
      optionGroup('设备', randomUUID(), devices, 2),
    ]
    const combinations = [
      { optionValueIds: [durations[0]!.id, devices[0]!.id], salePrice: '10.00', enabled: true },
      { optionValueIds: [durations[1]!.id, devices[0]!.id], salePrice: '20.00', enabled: true },
      { optionValueIds: [durations[1]!.id, devices[1]!.id], salePrice: '30.00', enabled: true },
      { optionValueIds: [durations[2]!.id, devices[1]!.id], salePrice: '40.00', enabled: true },
    ]
    const body = { expectedRevision: product.revision, mode: 'selected', groups, combinations }
    const preview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: body,
    })
    expect(preview.statusCode).toBe(200)
    const predicted = preview.json<{ data: { currentRevision: number; possibleCombinationCount: number; requestedSkuCount: number; changes: Array<Record<string, unknown>> } }>().data
    expect(predicted).toMatchObject({ currentRevision: product.revision, possibleCombinationCount: 6, requestedSkuCount: 4 })
    expect(predicted.changes).toHaveLength(5)
    expect(predicted.changes.filter((change) => change.change === 'added' && change.skuId === null)).toHaveLength(4)
    expect(predicted.changes.some((change) => 'combinationKey' in change)).toBe(false)
    expect(await db.selectFrom('product_option_groups').select('id').where('product_id', '=', product.id).execute()).toHaveLength(0)

    const saved = await saveMatrix(auth, product.id, body)
    expect(saved.statusCode).toBe(200)
    const result = saved.json<{ data: { product: ProductDetail; changes: Array<{ change: string }> } }>().data
    expect(result.product.optionGroups).toHaveLength(2)
    expect(result.product.optionGroups.reduce((count, group) => count + group.values.length, 0)).toBe(5)
    expect(result.product.variants).toHaveLength(4)
    expect(result.product.variants.every((variant) => !variant.isDefault && variant.options.length === 2)).toBe(true)
    expect(result.product.variants.map((variant) => variant.salePrice).sort()).toEqual(['10.00', '20.00', '30.00', '40.00'])
    expect(result.changes.filter((change) => change.change === 'added')).toHaveLength(4)
    expect(result.changes.some((change) => change.change === 'removed' && change.skuId === product.variants[0]!.id)).toBe(true)

    const internalRows = await db.selectFrom('product_variants').select(['id', 'combination_key'])
      .where('product_id', '=', product.id).execute()
    for (const variant of result.product.variants) {
      const expectedKey = `v1:${variant.options.map((option) => option.valueId).sort().join('.')}`
      expect(internalRows.find((row) => row.id === variant.id)?.combination_key).toBe(expectedKey)
    }
    const read = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    expect(read.json<{ data: ProductDetail }>().data).toEqual(result.product)
  })

  it('auto-generates a bounded matrix only with explicit new-SKU price and enabled defaults', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '自动规格矩阵')
    const first = ['A', 'B'].map((name) => ({ id: randomUUID(), name }))
    const second = ['1', '2', '3'].map((name) => ({ id: randomUUID(), name }))
    const body = {
      expectedRevision: product.revision,
      mode: 'all',
      groups: [optionGroup('套餐', randomUUID(), first), optionGroup('设备', randomUUID(), second, 1)],
      newSkuDefaults: { salePrice: '5.00', enabled: true },
    }
    const preview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: body,
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json<{ data: { possibleCombinationCount: number; requestedSkuCount: number } }>().data)
      .toMatchObject({ possibleCombinationCount: 6, requestedSkuCount: 6 })
    const saved = await saveMatrix(auth, product.id, body)
    expect(saved.statusCode).toBe(200)
    const result = saved.json<{ data: { product: ProductDetail } }>().data.product
    expect(result.variants).toHaveLength(6)
    expect(result.variants.every((variant) => variant.enabled && variant.salePrice === '5.00')).toBe(true)
    expect(new Set(result.variants.map((variant) => variant.id)).size).toBe(6)
    expect(new Set(result.variants.map((variant) => variant.skuCode)).size).toBe(6)
  })

  it('rejects oversized, duplicate, cross-product, and incomplete option combinations before saving', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '非法规格检查')
    const groupId = randomUUID()
    const one = randomUUID()
    const two = randomUUID()
    const baseGroups = [optionGroup('设备', groupId, [{ id: one, name: '一台' }, { id: two, name: '三台' }])]
    const duplicateValue = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision, mode: 'selected', groups: baseGroups,
      combinations: [{ optionValueIds: [one, one], salePrice: '1.00', enabled: true }],
    })
    expect(duplicateValue.statusCode).toBe(400)
    expect(duplicateValue.json().error.code).toBe('DUPLICATE_OPTION_VALUE_SELECTION')
    const sameGroupTwice = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision, mode: 'selected', groups: baseGroups,
      combinations: [{ optionValueIds: [one, two], salePrice: '1.00', enabled: true }],
    })
    expect(sameGroupTwice.statusCode).toBe(400)
    expect(sameGroupTwice.json().error.code).toBe('INCOMPLETE_OPTION_COMBINATION')
    const duplicateCombination = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision, mode: 'selected', groups: baseGroups,
      combinations: [
        { optionValueIds: [one], salePrice: '1.00', enabled: true },
        { optionValueIds: [one], salePrice: '2.00', enabled: true },
      ],
    })
    expect(duplicateCombination.statusCode).toBe(400)
    expect(duplicateCombination.json().error.code).toBe('DUPLICATE_SKU_COMBINATION')
    const foreignProduct = await createTestProduct(auth, '规格跨商品引用源')
    const foreignGroupId = randomUUID()
    const foreignValueId = randomUUID()
    const foreignOtherValueId = randomUUID()
    const foreignSchema = await saveMatrix(auth, foreignProduct.id, {
      expectedRevision: foreignProduct.revision,
      mode: 'selected',
      groups: [optionGroup('来源规格', foreignGroupId, [{ id: foreignValueId, name: '来源值' }, { id: foreignOtherValueId, name: '另一个值' }])],
      combinations: [{ optionValueIds: [foreignValueId], salePrice: '2.00', enabled: true }],
    })
    expect(foreignSchema.statusCode).toBe(200)
    const foreignVariant = foreignSchema.json<{ data: { product: ProductDetail } }>().data.product.variants[0]!
    await expect(db.insertInto('product_variant_option_values').values({
      product_id: product.id,
      product_variant_id: product.variants[0]!.id,
      option_group_id: foreignGroupId,
      option_value_id: foreignValueId,
    }).execute()).rejects.toMatchObject({ code: '23503', constraint: 'product_variant_option_values_group_fkey' })
    await expect(db.insertInto('product_variant_option_values').values({
      product_id: foreignProduct.id,
      product_variant_id: foreignVariant.id,
      option_group_id: foreignGroupId,
      option_value_id: foreignOtherValueId,
    }).execute()).rejects.toMatchObject({ code: '23505', constraint: 'product_variant_option_values_pkey' })
    await expect(db.updateTable('product_variants').set({ combination_key: `v1:${randomUUID()}` })
      .where('id', '=', foreignVariant.id).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'product_variant_combination_key_consistent' })
    const foreignValue = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision, mode: 'selected', groups: baseGroups,
      combinations: [{ optionValueIds: [foreignValueId], salePrice: '1.00', enabled: true }],
    })
    expect(foreignValue.statusCode).toBe(400)
    expect(foreignValue.json().error.code).toBe('OPTION_VALUE_REFERENCE_INVALID')

    const tooManyGroups = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision, mode: 'all',
      groups: Array.from({ length: 6 }, (_, index) => optionGroup(`G${index}`, randomUUID(), [{ id: randomUUID(), name: '值' }])),
      newSkuDefaults: { salePrice: '1.00', enabled: true },
    })
    expect(tooManyGroups.statusCode).toBe(400)
    expect(tooManyGroups.json().error.code).toBe('VALIDATION_ERROR')

    const tooManyValues = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision, mode: 'all',
        groups: [optionGroup('过多取值', randomUUID(), Array.from({ length: 51 }, (_, index) => ({ id: randomUUID(), name: `V${index}` })))],
        newSkuDefaults: { salePrice: '1.00', enabled: true },
      },
    })
    expect(tooManyValues.statusCode).toBe(400)
    expect(tooManyValues.json().error.code).toBe('VALIDATION_ERROR')

    const largeGroups = Array.from({ length: 5 }, (_, groupIndex) => optionGroup(
      `G${groupIndex}`, randomUUID(), Array.from({ length: 50 }, (_, valueIndex) => ({ id: randomUUID(), name: `V${valueIndex}` })),
    ))
    const tooManyCombinations = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision, mode: 'all', groups: largeGroups,
        newSkuDefaults: { salePrice: '1.00', enabled: true },
      },
    })
    expect(tooManyCombinations.statusCode).toBe(400)
    expect(tooManyCombinations.json().error.code).toBe('SKU_LIMIT_EXCEEDED')
    expect(await db.selectFrom('product_option_groups').select('id').where('product_id', '=', product.id).execute()).toHaveLength(0)
  })

  it('rolls back a matrix that would leave only disabled SKUs', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '非法批量回滚商品')
    const defaultSku = product.variants[0]!
    const groupId = randomUUID()
    const valueId = randomUUID()
    const response = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('期限', groupId, [{ id: valueId, name: '月卡' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '10.00', enabled: false }],
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('PRODUCT_VALID_SKU_REQUIRED')
    const after = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    const unchanged = after.json<{ data: ProductDetail }>().data
    expect(unchanged.revision).toBe(product.revision)
    expect(unchanged.optionGroups).toEqual([])
    expect(unchanged.variants).toEqual([defaultSku])
  })

  it('protects D2 management routes with administrator auth, CSRF, and strict TypeBox payloads', async () => {
    const unauthorizedList = await app.inject({ method: 'GET', url: '/api/v1/admin/categories' })
    expect(unauthorizedList.statusCode).toBe(401)
    const unauthorizedWrite = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories', payload: { name: '未授权分类' },
    })
    expect(unauthorizedWrite.statusCode).toBe(401)

    const auth = await loginAdmin()
    const product = await createTestProduct(auth, 'D2 安全边界')
    const missingCsrf = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`,
      headers: { cookie: auth.sessionCookie, origin: testOrigin }, payload: { expectedRevision: product.revision, attributes: [] },
    })
    expect(missingCsrf.statusCode).toBe(403)
    expect(missingCsrf.json().error.code).toBe('CSRF_INVALID')

    const unknownMatrixField = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision, mode: 'all', groups: [],
        newSkuDefaults: { salePrice: '1.00', enabled: true }, combinationKey: 'client-controlled',
      },
    })
    expect(unknownMatrixField.statusCode).toBe(400)
    expect(unknownMatrixField.json().error.code).toBe('VALIDATION_ERROR')
    const unknownNestedField = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision, mode: 'all',
        groups: [{ id: randomUUID(), name: '规格', sortOrder: 0, enabled: true, values: [], combinationKey: 'internal' }],
        newSkuDefaults: { salePrice: '1.00', enabled: true },
      },
    })
    expect(unknownNestedField.statusCode).toBe(400)
    expect(unknownNestedField.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('preserves a referenced legacy SKU as disabled during the default-to-options upgrade', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '有历史引用的默认 SKU')
    const legacySku = product.variants[0]!
    await sql`
      CREATE TABLE d2_sku_history_probe (
        variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT
      )
    `.execute(db)
    try {
      await sql`INSERT INTO d2_sku_history_probe (variant_id) VALUES (${legacySku.id})`.execute(db)
      const groupId = randomUUID()
      const valueId = randomUUID()
      const base = {
        expectedRevision: product.revision,
        mode: 'selected',
        groups: [optionGroup('期限', groupId, [{ id: valueId, name: '年卡' }])],
        combinations: [{ optionValueIds: [valueId], salePrice: '30.00', enabled: true }],
      }
      const unsafeRemoval = await saveMatrix(auth, product.id, base)
      expect(unsafeRemoval.statusCode).toBe(409)
      expect(unsafeRemoval.json().error.code).toBe('SKU_HAS_REFERENCES')

      const retained = await saveMatrix(auth, product.id, { ...base, retireSkuIds: [legacySku.id] })
      expect(retained.statusCode).toBe(200)
      const variants = retained.json<{ data: { product: ProductDetail } }>().data.product.variants
      const preserved = variants.find((variant) => variant.id === legacySku.id)!
      expect(preserved.skuCode).toBe(legacySku.skuCode)
      expect(preserved.enabled).toBe(false)
      expect(preserved.isDefault).toBe(true)
      expect(variants.some((variant) => variant.id !== legacySku.id && variant.enabled)).toBe(true)
    } finally {
      await sql`DROP TABLE IF EXISTS d2_sku_history_probe`.execute(db)
    }
  })

  it('serializes concurrent matrix saves by product revision', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '并发规格保存')
    const makeBody = (name: string) => {
      const groupId = randomUUID()
      const valueId = randomUUID()
      return {
        expectedRevision: product.revision,
        mode: 'selected',
        groups: [optionGroup(name, groupId, [{ id: valueId, name: '唯一值' }])],
        combinations: [{ optionValueIds: [valueId], salePrice: '12.00', enabled: true }],
      }
    }
    const results = await Promise.all([
      saveMatrix(auth, product.id, makeBody('并发规格甲')),
      saveMatrix(auth, product.id, makeBody('并发规格乙')),
    ])
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409])
    const conflict = results.find((result) => result.statusCode === 409)!
    expect(conflict.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
    const read = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    const saved = read.json<{ data: ProductDetail }>().data
    expect(saved.optionGroups).toHaveLength(1)
    expect(saved.variants).toHaveLength(1)
    expect(saved.variants[0]?.options).toHaveLength(1)
  })

  it('refuses to retire a SKU that still references a removed option and permits a safe atomic group removal', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '规格组安全删除')
    const groupId = randomUUID()
    const one = randomUUID()
    const two = randomUUID()
    const populated = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('设备', groupId, [{ id: one, name: '一台' }, { id: two, name: '三台' }])],
      combinations: [
        { optionValueIds: [one], salePrice: '10.00', enabled: true },
        { optionValueIds: [two], salePrice: '20.00', enabled: true },
      ],
    })
    const current = populated.json<{ data: { product: ProductDetail } }>().data.product
    const skuToRetain = current.variants.find((variant) => variant.options[0]?.valueId === one)!
    const removeSpecsBody = {
      expectedRevision: current.revision,
      mode: 'selected',
      groups: [],
      combinations: [{ optionValueIds: [], salePrice: '9.00', enabled: true }],
    }
    const unsafe = await saveMatrix(auth, product.id, { ...removeSpecsBody, retireSkuIds: [skuToRetain.id] })
    expect(unsafe.statusCode).toBe(409)
    expect(unsafe.json().error.code).toBe('SPECIFICATION_VALUE_IN_USE')
    const unchanged = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    expect(unchanged.json<{ data: ProductDetail }>().data.optionGroups).toHaveLength(1)

    const safe = await saveMatrix(auth, product.id, removeSpecsBody)
    expect(safe.statusCode).toBe(200)
    const result = safe.json<{ data: { product: ProductDetail } }>().data.product
    expect(result.optionGroups).toEqual([])
    expect(result.variants).toHaveLength(1)
    expect(result.variants[0]?.isDefault).toBe(true)
    expect(result.variants[0]?.id).not.toBe(skuToRetain.id)
  })
})
