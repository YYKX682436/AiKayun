import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { failure } from '@aikayun/contracts'
import type { Database } from '../src/db/types.js'
import { storefrontBrandSettingsMigration } from '../src/db/migrations/202611090001_storefront_brand_settings.js'
import { readConfig } from '../src/config.js'
import { hashToken } from '../src/auth/security.js'
import { registerStoreBrandRoutes } from '../src/auth/store-brand.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'

describe.skipIf(!testDatabaseUrl)('single-instance storefront brand settings', () => {
  let masterPool: Pool
  let pool: Pool
  let db: Kysely<Database>
  let app: FastifyInstance
  let schema: string
  let adminCookie: string
  let csrfToken: string

  beforeAll(async () => {
    const databaseUrl = new URL(testDatabaseUrl!)
    if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
      throw new Error('Store brand integration tests require TEST_DATABASE_URL to name an isolated _test database')
    }

    masterPool = new Pool({ connectionString: testDatabaseUrl, max: 2 })
    await masterPool.query('SELECT 1')
    schema = `store_brand_${randomUUID().replaceAll('-', '')}`
    await masterPool.query(`CREATE SCHEMA "${schema}"`)
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`)
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 5 })
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await pool.query(`
      CREATE TABLE admin_users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        password_hash text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE admin_sessions (
        id uuid PRIMARY KEY,
        admin_user_id uuid NOT NULL REFERENCES admin_users(id),
        token_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      );
    `)
    await storefrontBrandSettingsMigration.up!(db)

    const adminId = randomUUID()
    const sessionToken = `integration-session-${randomUUID()}`
    csrfToken = `integration-csrf-${randomUUID()}`
    await db.insertInto('admin_users').values({
      id: adminId,
      email: 'brand-admin@example.test',
      password_hash: 'not-used-for-route-auth',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    }).execute()
    await db.insertInto('admin_sessions').values({
      id: randomUUID(), admin_user_id: adminId, token_hash: hashToken(sessionToken),
      created_at: new Date(), expires_at: new Date(Date.now() + 60 * 60_000), revoked_at: null,
    }).execute()
    adminCookie = `aikayun_admin_session=${sessionToken}; aikayun_admin_csrf=${csrfToken}`

    app = Fastify({ logger: false })
    await app.register(cookie)
    app.setErrorHandler((error, request, reply) => reply.code(error.statusCode ?? 500).send(failure(
      error.validation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      error.validation ? 'The request contains invalid data' : 'An unexpected error occurred',
      request.id,
    )))
    registerStoreBrandRoutes(app, db, readConfig({
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: origin,
      COOKIE_SECURE: 'false',
    }))
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (db) await db.destroy()
    if (masterPool && schema) await masterPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await masterPool?.end()
  })

  it('requires admin auth and CSRF, validates input, persists one row, and exposes only public brand fields', async () => {
    const initialPublic = await app.inject('/api/v1/public/storefront/brand')
    expect(initialPublic.statusCode).toBe(200)
    expect(initialPublic.headers['cache-control']).toContain('no-store')
    expect(initialPublic.json().data).toEqual({ brand: null })

    expect((await app.inject('/api/v1/admin/storefront/brand')).statusCode).toBe(401)
    expect((await app.inject({
      method: 'PUT', url: '/api/v1/admin/storefront/brand',
      payload: { storeName: '未授权', storeLogoUrl: '', storeBrandColor: '#2563EB' },
    })).statusCode).toBe(401)

    const noCsrf = await app.inject({
      method: 'PUT', url: '/api/v1/admin/storefront/brand',
      headers: { origin, cookie: adminCookie, 'x-csrf-token': 'incorrect-token' },
      payload: { storeName: '未授权', storeLogoUrl: '', storeBrandColor: '#2563EB' },
    })
    expect(noCsrf.statusCode).toBe(403)

    const headers = { origin, cookie: adminCookie, 'x-csrf-token': csrfToken }
    const validBody = { storeName: '  青屿数字商店  ', storeLogoUrl: '/assets/store-logo.svg', storeBrandColor: '#7c3aed' }
    const update = await app.inject({ method: 'PUT', url: '/api/v1/admin/storefront/brand', headers, payload: validBody })
    expect(update.statusCode).toBe(200)
    expect(update.headers['cache-control']).toContain('no-store')
    expect(update.json().data.brand).toEqual({
      storeName: '青屿数字商店', storeLogoUrl: '/assets/store-logo.svg', storeBrandColor: '#7C3AED',
    })

    const adminRead = await app.inject({ url: '/api/v1/admin/storefront/brand', headers })
    const publicRead = await app.inject('/api/v1/public/storefront/brand')
    expect(adminRead.json().data).toEqual(update.json().data)
    expect(publicRead.json().data).toEqual(update.json().data)
    expect(Object.keys(publicRead.json().data.brand).sort()).toEqual(['storeBrandColor', 'storeLogoUrl', 'storeName'])
    expect(await db.selectFrom('storefront_brand_settings').selectAll().execute()).toHaveLength(1)

    const httpsLogo = await app.inject({
      method: 'PUT', url: '/api/v1/admin/storefront/brand', headers,
      payload: { ...validBody, storeLogoUrl: 'https://cdn.example.test/logo.svg' },
    })
    expect(httpsLogo.statusCode).toBe(200)
    expect(httpsLogo.json().data.brand.storeLogoUrl).toBe('https://cdn.example.test/logo.svg')

    for (const body of [
      { ...validBody, storeLogoUrl: 'javascript:alert(1)' },
      { ...validBody, storeLogoUrl: 'http://example.test/logo.png' },
      { ...validBody, storeLogoUrl: '//example.test/logo.png' },
      { ...validBody, storeName: '<script>alert(1)</script>' },
      { ...validBody, storeName: 'a'.repeat(81) },
      { ...validBody, storeBrandColor: 'red; background:url(javascript:alert(1))' },
    ]) {
      const rejected = await app.inject({ method: 'PUT', url: '/api/v1/admin/storefront/brand', headers, payload: body })
      expect(rejected.statusCode).toBe(400)
    }

    const persisted = await db.selectFrom('storefront_brand_settings')
      .select(['store_name', 'store_logo_url', 'store_brand_color'])
      .where('singleton', '=', true)
      .executeTakeFirstOrThrow()
    expect(persisted).toEqual({
      store_name: '青屿数字商店', store_logo_url: 'https://cdn.example.test/logo.svg', store_brand_color: '#7C3AED',
    })
  })
})
