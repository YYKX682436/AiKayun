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

    await db.insertInto('product_variants').values({
      id: randomUUID(),
      product_id: product.id,
      sku_code: `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
      combination_key: 'v1:option-value-blue',
      sale_price: '19.90',
    }).execute()
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

    await db.updateTable('products').set({ description: '修订触发器验证' }).where('id', '=', product.id).execute()
    const revised = await db.selectFrom('products').select('revision').where('id', '=', product.id).executeTakeFirstOrThrow()
    expect(revised.revision).toBe(2)
    expect(sku.revision).toBe(1)

    await expect(sql`TRUNCATE TABLE product_variants`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'product_requires_sku' })
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
      'admin_sessions', 'admin_users', 'product_variants', 'products',
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
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: productBody('允许移除默认 SKU'),
    })
    expect(created.statusCode).toBe(201)
    const product = created.json<{ data: ProductDetail }>().data
    const defaultSku = product.variants[0]!

    const blueSkuId = randomUUID()
    const redSkuId = randomUUID()
    await db.insertInto('product_variants').values([
      {
        id: blueSkuId,
        product_id: product.id,
        sku_code: `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
        combination_key: 'v1:option-value-blue',
        sale_price: '0.00',
      },
      {
        id: redSkuId,
        product_id: product.id,
        sku_code: `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
        combination_key: 'v1:option-value-red',
        sale_price: '19.90',
      },
    ]).execute()

    const withCombinations = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${product.id}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(withCombinations.statusCode).toBe(200)
    expect(withCombinations.json<{ data: ProductDetail }>().data.variants).toHaveLength(3)

    await db.deleteFrom('product_variants').where('id', '=', defaultSku.id).execute()
    const onlyRealCombinations = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${product.id}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(onlyRealCombinations.statusCode).toBe(200)
    const remaining = onlyRealCombinations.json<{ data: ProductDetail }>().data.variants
    expect(remaining.map((variant) => variant.id).sort()).toEqual([blueSkuId, redSkuId].sort())
    expect(remaining.every((variant) => !variant.isDefault)).toBe(true)
  })

  it('swaps SKU combinations transactionally without changing SKU identities and rolls back invalid replacements', async () => {
    const auth = await loginAdmin()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(auth),
      payload: productBody('规格组合替换'),
    })
    const product = created.json<{ data: ProductDetail }>().data
    const firstSku = product.variants[0]!
    const secondSkuId = randomUUID()
    await db.insertInto('product_variants').values({
      id: secondSkuId,
      product_id: product.id,
      sku_code: `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
      combination_key: 'v1:option-value-blue',
      sale_price: '1.00',
    }).execute()
    const thirdSkuId = randomUUID()
    await db.insertInto('product_variants').values({
      id: thirdSkuId,
      product_id: product.id,
      sku_code: `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
      combination_key: 'v1:option-value-red',
      sale_price: '2.00',
    }).execute()

    const before = await db.selectFrom('product_variants')
      .select(['id', 'sku_code', 'combination_key', 'sale_price', 'revision'])
      .where('product_id', '=', product.id)
      .orderBy('id')
      .execute()
    await expect(db.transaction().execute(async (trx) => {
      await sql`SET CONSTRAINTS product_variants_product_combination_unique DEFERRED`.execute(trx)
      await trx.updateTable('product_variants').set({ combination_key: 'v1:option-value-blue' })
        .where('id', '=', firstSku.id).execute()
    })).rejects.toMatchObject({ code: '23505', constraint: 'product_variants_product_combination_unique' })
    expect(await db.selectFrom('product_variants')
      .select(['id', 'sku_code', 'combination_key', 'sale_price', 'revision'])
      .where('product_id', '=', product.id)
      .orderBy('id')
      .execute()).toEqual(before)

    await db.transaction().execute(async (trx) => {
      await sql`SET CONSTRAINTS product_variants_product_combination_unique DEFERRED`.execute(trx)
      await trx.updateTable('product_variants').set({ combination_key: 'v1:option-value-red' })
        .where('id', '=', secondSkuId).execute()
      await trx.updateTable('product_variants').set({ combination_key: 'v1:option-value-blue' })
        .where('id', '=', thirdSkuId).execute()
    })

    const after = await db.selectFrom('product_variants')
      .select(['id', 'sku_code', 'combination_key'])
      .where('product_id', '=', product.id)
      .execute()
    expect(after).toHaveLength(3)
    expect(after.find((variant) => variant.id === firstSku.id)?.sku_code).toBe(firstSku.skuCode)
    expect(after.find((variant) => variant.id === secondSkuId)?.combination_key).toBe('v1:option-value-red')
    expect(after.find((variant) => variant.id === thirdSkuId)?.combination_key).toBe('v1:option-value-blue')
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
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: productHeaders(await loginAdmin()),
      payload: productBody(`并发删除 ${isolation}`),
    })
    const product = created.json<{ data: ProductDetail }>().data
    const defaultSkuId = product.variants[0]!.id
    const secondSkuId = randomUUID()
    await db.insertInto('product_variants').values({
      id: secondSkuId,
      product_id: product.id,
      sku_code: `SKU-${randomUUID().replaceAll('-', '').toUpperCase()}`,
      combination_key: 'v1:concurrent-option',
      sale_price: '0.00',
    }).execute()

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
})
