import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'
const bindingHeader = 'x-aikayun-guest-session-id'
let app: FastifyInstance
let db: Kysely<Database>
let privateRoot: string
let nextIp = 1

function inject(options: InjectOptions) {
  return app.inject({ ...options, remoteAddress: `198.51.100.${nextIp++}` })
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const raw = response.headers['set-cookie']
  const cookie = (Array.isArray(raw) ? raw : raw ? [raw] : []).find(value => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Missing test cookie ${name}`)
  return cookie.split(';', 1)[0]!
}

async function csrf() {
  const result = await inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
  expect(result.statusCode).toBe(200)
  return { token: result.json().data.csrfToken as string, cookie: cookieFrom(result, 'aikayun_customer_csrf') }
}

async function guest() {
  const security = await csrf()
  const result = await inject({ method: 'POST', url: '/api/v1/guest/session',
    headers: { origin, cookie: security.cookie, 'x-csrf-token': security.token } })
  expect(result.statusCode).toBe(201)
  return {
    id: result.json().data.sessionId as string,
    headers: { origin, cookie: `${security.cookie}; ${cookieFrom(result, 'aikayun_guest_order_session')}`, 'x-csrf-token': security.token },
  }
}

async function catalog() {
  const productId = randomUUID()
  const skuId = randomUUID()
  await db.transaction().execute(async trx => {
    await trx.insertInto('products').values({ id: productId, name: `R1 guest binding ${productId}`, description: '', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({ id: skuId, product_id: productId,
      sku_code: `R1-${skuId}`, combination_key: '', sale_price: '2.00',
      enabled: true, inventory_mode: 'quantity' }).execute()
    await trx.insertInto('product_variant_quantity_inventory').values({ product_id: productId, product_variant_id: skuId, stocked: 10, reserved: 0 }).execute()
    await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: skuId, method: 'manual', manual_delivery_ready: true }).execute()
  })
  return skuId
}

async function requestBody(skuId: string, headers: Record<string, string>, version: 1 | 2) {
  const items = version === 2 ? [{ lineId: randomUUID(), skuId, quantity: 1 }] : [{ skuId, quantity: 1 }]
  const result = await inject({ method: 'POST', url: '/api/v1/checkout/quote', headers,
    payload: { ...(version === 2 ? { version: 2 } : {}), items } })
  expect(result.statusCode).toBe(200)
  expect(result.json().data.canContinue).toBe(true)
  return { ...(version === 2 ? { version: 2 } : {}), idempotencyKey: randomUUID(), quoteToken: result.json().data.quoteToken as string, items }
}

async function state(key: string) {
  return {
    orders: await db.selectFrom('orders').select(['id', 'request_sha256', 'customer_id', 'guest_order_session_id']).where('idempotency_key', '=', key).execute(),
    reservations: await db.selectFrom('order_inventory_reservations as reservation')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .innerJoin('orders as order', 'order.id', 'item.order_id')
      .select(['reservation.id', 'reservation.quantity']).where('order.idempotency_key', '=', key).execute(),
  }
}

beforeAll(async () => {
  if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.slice(1).endsWith('_test')) throw new Error('Dedicated _test database required')
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migration = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
  if (migration.error) throw migration.error
  await db.updateTable('storefront_customer_policy').set({ guest_checkout_enabled: true }).execute()
  privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-r1-guest-api-'))
  const config = readConfig({ ...process.env, DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test',
    PUBLIC_ORIGIN: origin, COOKIE_SECURE: 'false', MEDIA_ROOT: join(privateRoot, 'media'), PRIVATE_FILE_ROOT: join(privateRoot, 'private') })
  app = await createApp({ db, config, logger: false })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true })
})

describe('⑥-2B R1 guest order subject binding', () => {
  it.each([1, 2] as const)('rejects a real different guest cookie before any v%s order or stock reservation', async version => {
    const first = await guest()
    const second = await guest()
    const skuId = await catalog()
    const body = await requestBody(skuId, first.headers, version)
    const response = await inject({ method: 'POST', url: '/api/v1/checkout/orders',
      headers: { ...second.headers, [bindingHeader]: first.id }, payload: body })
    expect({ status: response.statusCode, code: response.json().error?.code, ...await state(body.idempotencyKey) })
      .toEqual({ status: 409, code: 'GUEST_SESSION_CHANGED', orders: [], reservations: [] })
    expect(await db.selectFrom('product_variant_quantity_inventory').select('reserved').where('product_variant_id', '=', skuId).executeTakeFirstOrThrow()).toEqual({ reserved: 0 })
  })

  it('rejects guest-bound material when the actual cookie authenticates a customer', async () => {
    const original = await guest()
    const skuId = await catalog()
    const registered = await inject({ method: 'POST', url: '/api/v1/customer/auth/register', headers: original.headers,
      payload: { username: `r1-${randomUUID().replaceAll('-', '').slice(0, 20)}`, password: 'R1-Guest-Binding-Password-2026!!' } })
    expect(registered.statusCode).toBe(201)
    const customerHeaders = { ...original.headers,
      cookie: `${original.headers.cookie}; ${cookieFrom(registered, 'aikayun_customer_session')}` }
    const customerBody = await requestBody(skuId, customerHeaders, 2)
    const response = await inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: {
      ...customerHeaders, [bindingHeader]: original.id,
    }, payload: customerBody })
    expect({ status: response.statusCode, code: response.json().error?.code, ...await state(customerBody.idempotencyKey) })
      .toEqual({ status: 409, code: 'GUEST_SESSION_CHANGED', orders: [], reservations: [] })
  })

  it.each([1, 2] as const)('replays an old v%s body and key with the matching subject header without reinterpreting its quote', async version => {
    const original = await guest()
    const skuId = await catalog()
    const body = await requestBody(skuId, original.headers, version)
    const first = await inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: original.headers, payload: body })
    expect(first.statusCode).toBe(201)
    const saved = await state(body.idempotencyKey)
    expect(saved.orders).toEqual([expect.objectContaining({ id: first.json().data.order.id, guest_order_session_id: original.id, customer_id: null })])
    expect(saved.reservations).toEqual([{ id: expect.any(String), quantity: 1 }])
    await db.updateTable('product_variants').set({ sale_price: '3.00' }).where('id', '=', skuId).execute()
    const replay = await inject({ method: 'POST', url: '/api/v1/checkout/orders',
      headers: { ...original.headers, [bindingHeader]: original.id }, payload: body })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: first.json().data.order.id } })
    expect(await state(body.idempotencyKey)).toEqual(saved)
    const missingCsrf = await inject({ method: 'POST', url: '/api/v1/checkout/orders',
      headers: { origin, cookie: original.headers.cookie, [bindingHeader]: original.id }, payload: body })
    expect(missingCsrf.statusCode).toBe(403)
    expect(await state(body.idempotencyKey)).toEqual(saved)
  })
})
