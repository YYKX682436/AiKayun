import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import cookie from '@fastify/cookie'
import { registerAjvFormats, TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { failure } from '@aikayun/contracts'
import type { Database } from '../src/db/types.js'
import { storefrontFeaturedProductsMigration } from '../src/db/migrations/202611090002_storefront_featured_products.js'
import { readConfig } from '../src/config.js'
import { hashToken } from '../src/auth/security.js'
import { registerPublicProductRoutes } from '../src/catalog/public-products.js'
import { registerStorefrontFeaturedProductRoutes } from '../src/catalog/storefront-featured-products.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'

describe.skipIf(!testDatabaseUrl)('single-instance storefront featured products', () => {
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
      throw new Error('Featured product integration tests require an isolated _test database')
    }

    masterPool = new Pool({ connectionString: testDatabaseUrl, max: 2 })
    await masterPool.query('SELECT 1')
    schema = 'featured_' + randomUUID().replaceAll('-', '')
    await masterPool.query('CREATE SCHEMA "' + schema + '"')
    databaseUrl.searchParams.set('options', '-c search_path=' + schema)
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 5 })
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await pool.query([
      'CREATE TABLE admin_users (id uuid PRIMARY KEY, email text NOT NULL, password_hash text NOT NULL, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());',
      'CREATE TABLE admin_sessions (id uuid PRIMARY KEY, admin_user_id uuid NOT NULL REFERENCES admin_users(id), token_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz);',
      'CREATE TABLE products (id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL, product_type text NOT NULL, status text NOT NULL);',
      'CREATE TABLE product_variants (id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES products(id), sale_price numeric(15, 2) NOT NULL, inventory_mode text, enabled boolean NOT NULL, retired_at timestamptz);',
      'CREATE TABLE product_option_groups (id uuid PRIMARY KEY, product_id uuid NOT NULL, enabled boolean NOT NULL);',
      'CREATE TABLE product_option_values (id uuid PRIMARY KEY, product_id uuid NOT NULL, option_group_id uuid NOT NULL, enabled boolean NOT NULL);',
      'CREATE TABLE product_variant_option_values (product_id uuid NOT NULL, product_variant_id uuid NOT NULL, option_group_id uuid NOT NULL, option_value_id uuid NOT NULL);',
      'CREATE TABLE product_variant_quantity_inventory (product_id uuid NOT NULL, product_variant_id uuid NOT NULL, stocked integer NOT NULL, reserved integer NOT NULL);',
      'CREATE TABLE product_media (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());',
      'CREATE TABLE product_media_references (product_id uuid NOT NULL, media_id uuid NOT NULL, source text NOT NULL, sort_order integer NOT NULL);',
      'CREATE TABLE product_media_variants (media_id uuid NOT NULL, variant text NOT NULL, width integer NOT NULL, height integer NOT NULL);',
    ].join(' '))
    await storefrontFeaturedProductsMigration.up!(db)

    const adminId = randomUUID()
    const sessionToken = 'integration-session-' + randomUUID()
    csrfToken = 'integration-csrf-' + randomUUID()
    await pool.query(
      'INSERT INTO admin_users(id, email, password_hash, is_active) VALUES($1, $2, $3, true)',
      [adminId, 'featured-admin@example.test', 'not-used-for-route-auth'],
    )
    await pool.query(
      'INSERT INTO admin_sessions(id, admin_user_id, token_hash, expires_at) VALUES($1, $2, $3, $4)',
      [randomUUID(), adminId, hashToken(sessionToken), new Date(Date.now() + 60 * 60_000)],
    )
    adminCookie = 'aikayun_admin_session=' + sessionToken + '; aikayun_admin_csrf=' + csrfToken

    app = Fastify({ logger: false })
    registerAjvFormats(app)
    app.setValidatorCompiler(TypeBoxValidatorCompiler)
    await app.register(cookie)
    app.setErrorHandler((error, request, reply) => reply.code(error.statusCode ?? 500).send(failure(
      error.validation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      error.validation ? 'The request contains invalid data' : 'An unexpected error occurred',
      request.id,
    )))
    registerPublicProductRoutes(app, db)
    registerStorefrontFeaturedProductRoutes(app, db, readConfig({
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
    if (masterPool && schema) await masterPool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE')
    await masterPool?.end()
  })

  async function createProduct(name: string, status: 'active' | 'paused', price: string, withCover = false) {
    const id = randomUUID()
    const variantId = randomUUID()
    await pool.query(
      'INSERT INTO products(id, name, description, product_type, status) VALUES($1, $2, $3, $4, $5)',
      [id, name, name + ' 描述', 'digital', status],
    )
    await pool.query(
      'INSERT INTO product_variants(id, product_id, sale_price, inventory_mode, enabled, retired_at) VALUES($1, $2, $3, $4, true, NULL)',
      [variantId, id, price, 'quantity'],
    )
    await pool.query(
      'INSERT INTO product_variant_quantity_inventory(product_id, product_variant_id, stocked, reserved) VALUES($1, $2, 12, 2)',
      [id, variantId],
    )
    if (withCover) {
      const mediaId = randomUUID()
      await pool.query('INSERT INTO product_media(id) VALUES($1)', [mediaId])
      await pool.query(
        'INSERT INTO product_media_references(product_id, media_id, source, sort_order) VALUES($1, $2, $3, 0)',
        [id, mediaId, 'gallery'],
      )
      await pool.query(
        'INSERT INTO product_media_variants(media_id, variant, width, height) VALUES($1, $2, 640, 480), ($1, $3, 640, 480)',
        [mediaId, 'card', 'detail'],
      )
    }
    return id
  }

  async function save(productIds: string[], headers: { origin: string; cookie: string; 'x-csrf-token': string }) {
    return await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/storefront/featured-products',
      headers,
      payload: { productIds },
    })
  }

  it('protects admin writes, validates the whole list, persists order, and hides or restores inactive products', async () => {
    const alpha = await createProduct('精选商品 Alpha', 'active', '19.90', true)
    const beta = await createProduct('精选商品 Beta', 'active', '29.90')
    const paused = await createProduct('已暂停候选商品', 'paused', '39.90')
    const headers = { origin, cookie: adminCookie, 'x-csrf-token': csrfToken }

    const empty = await app.inject('/api/v1/public/storefront/featured-products')
    expect(empty.statusCode).toBe(200)
    expect(empty.headers['cache-control']).toContain('no-store')
    expect(empty.json().data.products).toEqual([])

    expect((await app.inject('/api/v1/admin/storefront/featured-products')).statusCode).toBe(401)
    expect((await save([alpha], { origin, cookie: '', 'x-csrf-token': csrfToken })).statusCode).toBe(401)
    expect((await save([alpha], { ...headers, 'x-csrf-token': 'incorrect-token' })).statusCode).toBe(403)

    const duplicate = await save([alpha, alpha], headers)
    expect(duplicate.statusCode).toBe(400)
    const tooMany = await save(Array.from({ length: 9 }, () => randomUUID()), headers)
    expect(tooMany.statusCode).toBe(400)
    const missing = await save([randomUUID()], headers)
    expect(missing.statusCode).toBe(404)
    const inactiveNew = await save([paused], headers)
    expect(inactiveNew.statusCode).toBe(409)

    const created = await save([alpha, beta], headers)
    expect(created.statusCode).toBe(200)
    expect(created.json().data.items.map((item: { id: string }) => item.id)).toEqual([alpha, beta])
    expect(created.json().data.items[0]).toMatchObject({
      id: alpha,
      name: '精选商品 Alpha',
      status: 'active',
      coverImage: {
        cardUrl: '/api/v1/media/' + (await pool.query(
          'SELECT media_id FROM product_media_references WHERE product_id = $1',
          [alpha],
        )).rows[0].media_id + '/card.webp',
      },
    })

    const publicResponse = await app.inject('/api/v1/public/storefront/featured-products')
    expect(publicResponse.statusCode).toBe(200)
    expect(publicResponse.json().data.products.map((item: { id: string }) => item.id)).toEqual([alpha, beta])
    const publicAlpha = publicResponse.json().data.products[0]
    const alphaMediaId = (await pool.query(
      'SELECT media_id FROM product_media_references WHERE product_id = $1',
      [alpha],
    )).rows[0].media_id
    expect(publicAlpha).toMatchObject({
      name: '精选商品 Alpha',
      priceRange: { min: '19.90', max: '19.90', currency: 'CNY' },
      inventoryStatus: 'in_stock',
      cover: {
        url: '/api/v1/media/' + alphaMediaId + '/card.webp',
        width: 640,
        height: 480,
        alt: '精选商品 Alpha',
      },
    })
    expect(Object.keys(publicAlpha).sort()).toEqual([
      'cover', 'description', 'id', 'inventoryStatus', 'name', 'priceRange', 'productType', 'selectionStatus',
    ])
    const publicList = await app.inject('/api/v1/public/products?page=1&pageSize=24&sort=newest')
    expect(publicList.statusCode).toBe(200)
    const cardsById = new Map(publicList.json().data.items.map((item: { id: string }) => [item.id, item]))
    for (const featuredCard of publicResponse.json().data.products) {
      expect(featuredCard).toEqual(cardsById.get(featuredCard.id))
    }

    await pool.query('UPDATE products SET status = $1 WHERE id = $2', ['paused', alpha])
    const hidden = await app.inject('/api/v1/public/storefront/featured-products')
    expect(hidden.json().data.products.map((item: { id: string }) => item.id)).toEqual([beta])
    const retained = await app.inject({ url: '/api/v1/admin/storefront/featured-products', headers })
    expect(retained.json().data.items.map((item: { id: string }) => item.id)).toEqual([alpha, beta])
    expect(retained.json().data.items[0].status).toBe('paused')

    const partialFailure = await save([beta, paused], headers)
    expect(partialFailure.statusCode).toBe(409)
    const unchanged = await app.inject({ url: '/api/v1/admin/storefront/featured-products', headers })
    expect(unchanged.json().data.items.map((item: { id: string }) => item.id)).toEqual([alpha, beta])

    const reordered = await save([beta, alpha], headers)
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().data.items.map((item: { id: string }) => item.id)).toEqual([beta, alpha])
    await pool.query('UPDATE products SET status = $1 WHERE id = $2', ['active', alpha])
    const restored = await app.inject('/api/v1/public/storefront/featured-products')
    expect(restored.json().data.products.map((item: { id: string }) => item.id)).toEqual([beta, alpha])

    await pool.query('UPDATE products SET status = $1 WHERE id = $2', ['archived', beta])
    const archivedAdmin = await app.inject({ url: '/api/v1/admin/storefront/featured-products', headers })
    expect(archivedAdmin.json().data.items.map((item: { id: string }) => item.id)).toEqual([beta, alpha])
    expect(archivedAdmin.json().data.items[0].status).toBe('archived')
    const archivedPublic = await app.inject('/api/v1/public/storefront/featured-products')
    expect(archivedPublic.json().data.products.map((item: { id: string }) => item.id)).toEqual([alpha])

    const cleared = await save([], headers)
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().data.items).toEqual([])
    expect(await db.selectFrom('storefront_featured_products').selectAll().execute()).toEqual([])
  })
})
