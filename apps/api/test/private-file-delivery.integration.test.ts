import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { Migrator } from 'kysely/migration'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/password.js'
import { readConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { startDigitalDeliveryWorker } from '../src/commerce/code-pool-delivery-worker.js'
import type { AppConfig } from '../src/config.js'
import { PrivateFileStorage, newPrivateFileId } from '../src/media/private-file-storage.js'
import { reconcilePrivateFiles } from '../src/media/private-file-reconcile.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'
const password = 'Private-File-Integration-Password-2026!'
const digest = 'a'.repeat(64)
let app: FastifyInstance
let db: Kysely<Database>
let config: AppConfig
let privateRoot: string
let nextIp = 1

type Admin = { id: string; cookie: string; csrfToken: string; csrfCookie: string }
type Customer = { id: string; username: string; cookie: string; csrfToken: string; csrfCookie: string }
type Catalog = { productId: string; skuId: string; name: string }

function inject(options: InjectOptions) {
  return app.inject({ ...options, remoteAddress: `198.51.100.${(nextIp++ % 240) + 1}` })
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers['set-cookie']
  const cookies = Array.isArray(value) ? value : value ? [value] : []
  const cookie = cookies.find(row => row.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0]!
}

async function csrf(owner: 'admin' | 'customer' = 'customer') {
  const response = await inject({ method: 'GET', url: `/api/v1/${owner}/auth/csrf` })
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
  const cookieName = owner === 'admin' ? 'aikayun_admin_csrf' : 'aikayun_customer_csrf'
  return { token: response.json().data.csrfToken as string, cookie: cookieFrom(response, cookieName) }
}

async function createAdmin(): Promise<Admin> {
  const id = randomUUID()
  const email = `private-${id.slice(0, 8)}@example.test`
  await db.insertInto('admin_users').values({ id, email, password_hash: await hashPassword(password) }).execute()
  const token = await csrf('admin')
  const login = await inject({
    method: 'POST', url: '/api/v1/admin/auth/login',
    headers: { origin, cookie: token.cookie, 'x-csrf-token': token.token },
    payload: { email, password },
  })
  expect(login.statusCode).toBe(200)
  return { id, cookie: cookieFrom(login, 'aikayun_admin_session'), csrfToken: token.token, csrfCookie: token.cookie }
}

function adminHeaders(admin: Admin) {
  return { origin, cookie: `${admin.cookie}; ${admin.csrfCookie}`, 'x-csrf-token': admin.csrfToken }
}

async function createCustomer(): Promise<Customer> {
  const token = await csrf()
  const username = `private-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/auth/register',
    headers: { origin, cookie: token.cookie, 'x-csrf-token': token.token },
    payload: { username, password },
  })
  expect(response.statusCode).toBe(201)
  return {
    id: response.json().data.customer.id as string,
    username,
    cookie: cookieFrom(response, 'aikayun_customer_session'),
    csrfToken: token.token,
    csrfCookie: token.cookie,
  }
}

async function createGuest() {
  const token = await csrf()
  const response = await inject({
    method: 'POST', url: '/api/v1/guest/session',
    headers: { origin, cookie: token.cookie, 'x-csrf-token': token.token },
  })
  expect([200, 201]).toContain(response.statusCode)
  return {
    cookie: cookieFrom(response, 'aikayun_guest_order_session'),
    csrfToken: token.token,
    csrfCookie: token.cookie,
  }
}

async function createCatalog(price = '0.00', inventoryMode: 'quantity' | 'unlimited' = 'quantity'): Promise<Catalog> {
  const productId = randomUUID()
  const skuId = randomUUID()
  const name = `私有文件商品-${productId.slice(0, 8)}`
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({ id: productId, name, description: '', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({
      id: skuId, product_id: productId, sku_code: `PFILE-${skuId.slice(0, 8)}`, combination_key: '',
      sale_price: price, enabled: true, retired_at: null, inventory_mode: inventoryMode,
    }).execute()
    if (inventoryMode === 'quantity') {
      await trx.insertInto('product_variant_quantity_inventory').values({
        product_id: productId, product_variant_id: skuId, stocked: 10, reserved: 0,
      }).execute()
    }
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: skuId, method: 'manual', manual_delivery_ready: false,
    }).execute()
  })
  return { productId, skuId, name }
}

async function uploadFile(catalog: Catalog, admin: Admin, filename: string, contents: Buffer) {
  const boundary = `aikayun-${randomUUID()}`
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    contents,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return inject({
    method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/private-files/uploads`,
    headers: { ...adminHeaders(admin), 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
    payload: body,
  })
}

async function saveFile(catalog: Catalog, admin: Admin, filename: string, contents: Buffer) {
  const uploaded = await uploadFile(catalog, admin, filename, contents)
  expect(uploaded.statusCode, JSON.stringify(uploaded.json())).toBe(201)
  const configUrl = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/private-files`
  const current = await inject({ method: 'GET', url: configUrl, headers: { cookie: admin.cookie } })
  expect(current.statusCode).toBe(200)
  const response = await inject({
    method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
    payload: {
      expectedRevision: current.json().data.configurationRevision,
      uploadId: uploaded.json().data.uploadId,
      displayFilename: filename,
    },
  })
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
  return response.json().data as {
    configurationRevision: number
    automaticDeliveryReady: boolean
    currentVersion: { id: string; versionNumber: number; sha256: string; fileSizeBytes: number }
  }
}

async function setReadiness(catalog: Catalog, admin: Admin, expectedRevision: number, enabled: boolean) {
  return inject({
    method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/private-files/readiness`,
    headers: adminHeaders(admin), payload: { expectedRevision, enabled },
  })
}

async function order(catalog: Catalog, customer: Customer, quantity: number) {
  const items = [{ skuId: catalog.skuId, quantity }]
  const quote = await inject({
    method: 'POST', url: '/api/v1/checkout/quote',
    headers: { origin, cookie: `${customer.cookie}; ${customer.csrfCookie}`, 'x-csrf-token': customer.csrfToken },
    payload: { items },
  })
  expect(quote.statusCode).toBe(200)
  expect(quote.json().data.canContinue).toBe(true)
  return inject({
    method: 'POST', url: '/api/v1/checkout/orders',
    headers: { origin, cookie: `${customer.cookie}; ${customer.csrfCookie}`, 'x-csrf-token': customer.csrfToken },
    payload: { idempotencyKey: randomUUID(), quoteToken: quote.json().data.quoteToken, items },
  })
}

async function guestOrder(catalog: Catalog, guest: Awaited<ReturnType<typeof createGuest>>, quantity: number) {
  const items = [{ skuId: catalog.skuId, quantity }]
  const headers = { origin, cookie: `${guest.cookie}; ${guest.csrfCookie}`, 'x-csrf-token': guest.csrfToken }
  const quote = await inject({ method: 'POST', url: '/api/v1/checkout/quote', headers, payload: { items } })
  expect(quote.statusCode).toBe(200)
  expect(quote.json().data.canContinue).toBe(true)
  return inject({
    method: 'POST', url: '/api/v1/checkout/orders', headers,
    payload: { idempotencyKey: randomUUID(), quoteToken: quote.json().data.quoteToken, items },
  })
}

async function waitForCompletion(orderId: string, itemId: string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const [orderRow, itemRow] = await Promise.all([
      db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirst(),
      db.selectFrom('order_items').select(['fulfilled_quantity', 'fulfillment_status']).where('id', '=', itemId).executeTakeFirst(),
    ])
    if (orderRow?.status === 'completed' && itemRow?.fulfillment_status === 'completed') return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`File delivery did not complete for order ${orderId}`)
}

async function waitForFailure(itemId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const attempt = await db.selectFrom('order_item_fulfillment_attempts').select('failure_code')
      .where('order_item_id', '=', itemId).where('delivery_source', '=', 'file')
      .orderBy('created_at', 'desc').executeTakeFirst()
    if (attempt?.failure_code === expected) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`File delivery failure ${expected} was not recorded for item ${itemId}`)
}

beforeAll(async () => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must point to an isolated PostgreSQL database ending in _test')
  if (!new URL(testDatabaseUrl).pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to reset a PostgreSQL database that does not end in _test')
  }
  privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-private-file-integration-'))
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  const repeated = await migrator.migrateToLatest()
  if (repeated.error) throw repeated.error
  config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    PRIVATE_FILE_ROOT: privateRoot,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: origin,
    COOKIE_SECURE: 'false',
    CODE_POOL_ENCRYPTION_KEY_RING: JSON.stringify({
      activeKeyId: 'private-file-test-v1',
      keys: { 'private-file-test-v1': Buffer.alloc(32, 0x71).toString('base64') },
    }),
  })
  app = await createApp({ db, config, logger: false })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true })
})

describe('private-file delivery on real PostgreSQL and filesystem', () => {
  it('keeps immutable versions, delivers each unit, and authorizes full, HEAD, and Range downloads from order facts', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const stranger = await createCustomer()
    const catalog = await createCatalog()
    const v1Bytes = Buffer.from('私有文件第一版：逐字节校验\n')
    const savedV1 = await saveFile(catalog, admin, '交付说明.txt', v1Bytes)
    expect(savedV1.automaticDeliveryReady).toBe(false)
    expect(savedV1.currentVersion).toMatchObject({
      versionNumber: 1, fileSizeBytes: v1Bytes.length, sha256: createHash('sha256').update(v1Bytes).digest('hex'),
    })

    const oldQuote = await inject({
      method: 'POST', url: '/api/v1/checkout/quote',
      headers: { origin, cookie: `${customer.cookie}; ${customer.csrfCookie}`, 'x-csrf-token': customer.csrfToken },
      payload: { items: [{ skuId: catalog.skuId, quantity: 2 }] },
    })
    expect(oldQuote.json().data.canContinue).toBe(false)

    const enabledV1 = await setReadiness(catalog, admin, savedV1.configurationRevision, true)
    expect(enabledV1.statusCode).toBe(200)
    expect(enabledV1.json().data.automaticDeliveryReady).toBe(true)
    const createdV1 = await order(catalog, customer, 2)
    expect(createdV1.statusCode).toBe(201)
    const orderV1 = createdV1.json().data.order
    const orderIdV1 = orderV1.id as string
    const itemIdV1 = orderV1.items[0].id as string
    expect(orderV1.status).toBe('processing')

    const savedV2 = await saveFile(catalog, admin, '交付说明.txt', Buffer.from('第二版内容\n'))
    expect(savedV2.automaticDeliveryReady).toBe(false)
    const staleCheckout = await inject({
      method: 'POST', url: '/api/v1/checkout/orders',
      headers: { origin, cookie: `${customer.cookie}; ${customer.csrfCookie}`, 'x-csrf-token': customer.csrfToken },
      payload: { idempotencyKey: randomUUID(), quoteToken: oldQuote.json().data.quoteToken, items: [{ skuId: catalog.skuId, quantity: 2 }] },
    })
    expect(staleCheckout.statusCode).toBe(409)
    expect(staleCheckout.json().error.code).toBe('CHECKOUT_QUOTE_CHANGED')

    const stopWorkers = [startDigitalDeliveryWorker(db, config, app.log), startDigitalDeliveryWorker(db, config, app.log)]
    try { await waitForCompletion(orderIdV1, itemIdV1) } finally { await Promise.all(stopWorkers.map(stop => stop())) }

    const deliveriesV1 = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select(['delivery.id', 'delivery.unit_index', 'delivery.content', 'delivery.fulfillment_content_version_id'])
      .where('attempt.order_item_id', '=', itemIdV1).where('attempt.status', '=', 'succeeded')
      .orderBy('delivery.unit_index').execute()
    expect(deliveriesV1).toHaveLength(2)
    expect(deliveriesV1.map(row => row.unit_index)).toEqual([1, 2])
    expect(deliveriesV1.every(row => row.content === null && row.fulfillment_content_version_id === savedV1.currentVersion.id)).toBe(true)

    const details = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: customer.cookie } })
    expect(details.statusCode).toBe(200)
    expect(details.json().data.items[0].deliveries.map((delivery: { fileName: string; fileSizeBytes: number }) => delivery))
      .toMatchObject([{ fileName: '交付说明.txt', fileSizeBytes: v1Bytes.length }, { fileName: '交付说明.txt', fileSizeBytes: v1Bytes.length }])
    expect(JSON.stringify(details.json())).not.toContain(deliveriesV1[0]!.fulfillment_content_version_id)

    const downloadUrl = `/api/v1/customer/orders/${orderIdV1}/items/${itemIdV1}/deliveries/${deliveriesV1[0]!.id}/file`
    const unauthorized = await inject({ method: 'GET', url: downloadUrl, headers: { cookie: stranger.cookie, range: 'bytes=0-3' } })
    expect(unauthorized.statusCode).toBe(404)
    const unauthorizedHead = await inject({ method: 'HEAD', url: downloadUrl, headers: { cookie: stranger.cookie } })
    expect(unauthorizedHead.statusCode).toBe(404)
    const ranged = await inject({ method: 'GET', url: downloadUrl, headers: { cookie: customer.cookie, range: 'bytes=2-7' } })
    expect(ranged.statusCode).toBe(206)
    expect(ranged.headers['content-range']).toBe(`bytes 2-7/${v1Bytes.length}`)
    expect(ranged.rawPayload).toEqual(v1Bytes.subarray(2, 8))
    const head = await inject({ method: 'HEAD', url: downloadUrl, headers: { cookie: customer.cookie, range: 'bytes=2-7' } })
    expect(head.statusCode).toBe(200)
    expect(head.headers['content-length']).toBe(String(v1Bytes.length))
    expect(head.rawPayload).toHaveLength(0)
    const full = await inject({ method: 'GET', url: downloadUrl, headers: { cookie: customer.cookie } })
    expect(full.statusCode).toBe(200)
    expect(full.headers['cache-control']).toContain('no-store')
    expect(full.headers['x-content-type-options']).toBe('nosniff')
    expect(decodeURIComponent(full.headers['content-disposition']!.split("filename*=UTF-8''")[1]!)).toBe('交付说明.txt')
    expect(createHash('sha256').update(full.rawPayload).digest('hex')).toBe(savedV1.currentVersion.sha256)
    expect(full.rawPayload).toEqual(v1Bytes)
    const invalidRange = await inject({ method: 'GET', url: downloadUrl, headers: { cookie: customer.cookie, range: 'bytes=1-2,5-7' } })
    expect(invalidRange.statusCode).toBe(416)
    const anonymous = await inject({ method: 'GET', url: downloadUrl })
    expect(anonymous.statusCode).toBe(401)

    const enabledV2 = await setReadiness(catalog, admin, savedV2.configurationRevision, true)
    expect(enabledV2.statusCode).toBe(200)
    const createdV2 = await order(catalog, customer, 1)
    expect(createdV2.statusCode).toBe(201)
    const orderIdV2 = createdV2.json().data.order.id as string
    const itemIdV2 = createdV2.json().data.order.items[0].id as string
    const stopV2 = startDigitalDeliveryWorker(db, config, app.log)
    try { await waitForCompletion(orderIdV2, itemIdV2) } finally { await stopV2() }
    const deliveryV2 = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select(['delivery.id', 'delivery.fulfillment_content_version_id'])
      .where('attempt.order_item_id', '=', itemIdV2).where('attempt.status', '=', 'succeeded').executeTakeFirstOrThrow()
    expect(deliveryV2.fulfillment_content_version_id).toBe(savedV2.currentVersion.id)
    const fullV2 = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderIdV2}/items/${itemIdV2}/deliveries/${deliveryV2.id}/file`,
      headers: { cookie: customer.cookie },
    })
    expect(fullV2.rawPayload).toEqual(Buffer.from('第二版内容\n'))
    expect(createHash('sha256').update(fullV2.rawPayload).digest('hex')).toBe(savedV2.currentVersion.sha256)
    expect(deliveriesV1.every(row => row.fulfillment_content_version_id !== deliveryV2.fulfillment_content_version_id)).toBe(true)

    const sourceRevision = await db.selectFrom('products').select('revision').where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const copied = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/copy`, headers: adminHeaders(admin),
      payload: { expectedRevision: sourceRevision.revision },
    })
    expect(copied.statusCode).toBe(201)
    expect(await db.selectFrom('product_variant_fulfillment_versions')
      .select('id').where('product_variant_id', '=', copied.json().data.variants[0].id).execute()).toEqual([])

    const productRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const archived = await inject({
      method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/lifecycle`,
      headers: adminHeaders(admin), payload: { expectedRevision: productRevision.revision, status: 'archived' },
    })
    expect(archived.statusCode).toBe(200)
    expect(archived.json().data.status).toBe('archived')
    const archivedDownload = await inject({ method: 'GET', url: downloadUrl, headers: { cookie: customer.cookie } })
    expect(archivedDownload.statusCode).toBe(200)
    expect(createHash('sha256').update(archivedDownload.rawPayload).digest('hex')).toBe(savedV1.currentVersion.sha256)

    const stock = await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()
    expect(stock).toEqual({ stocked: 7, reserved: 0 })
    const events = await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .select(['event.action', sql<number>`sum(event.quantity)::integer`.as('quantity')])
      .where('reservation.product_variant_id', '=', catalog.skuId).groupBy('event.action').execute()
    expect(events).toEqual(expect.arrayContaining([{ action: 'reserve', quantity: 3 }, { action: 'consume', quantity: 3 }]))
  }, 30_000)

  it('cleans a durable file when its staged database update fails', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog()
    await sql`
      CREATE OR REPLACE FUNCTION fail_private_file_stage_test() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'staged' THEN RAISE EXCEPTION 'simulated private-file metadata failure'; END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER fail_private_file_stage_test
      BEFORE UPDATE OF status ON private_file_objects
      FOR EACH ROW EXECUTE FUNCTION fail_private_file_stage_test()
    `.execute(db)
    let uploadResponse: Awaited<ReturnType<typeof uploadFile>>
    try {
      uploadResponse = await uploadFile(catalog, admin, 'database-failure.txt', Buffer.from('persisted before metadata failure'))
    } finally {
      await sql`DROP TRIGGER IF EXISTS fail_private_file_stage_test ON private_file_objects`.execute(db)
      await sql`DROP FUNCTION IF EXISTS fail_private_file_stage_test()`.execute(db)
    }
    expect(uploadResponse!.statusCode).toBe(500)
    const failedUpload = await db.selectFrom('private_file_objects').select(['id', 'status'])
      .where('uploaded_by_admin_id', '=', admin.id).where('upload_filename', '=', 'database-failure.txt')
      .executeTakeFirstOrThrow()
    expect(failedUpload.status).toBe('failed')
    expect((await new PrivateFileStorage(privateRoot).scanGeneratedFiles())
      .some(file => file.id === failedUpload.id)).toBe(false)
    expect(await db.selectFrom('product_variant_fulfillment').select('automatic_delivery_ready')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).toEqual({ automatic_delivery_ready: false })
  })

  it('pauses file sales when the stored object disappears and invalidates an earlier quote', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog('0.00', 'unlimited')
    const saved = await saveFile(catalog, admin, 'missing-after-enable.txt', Buffer.from('available while quoted'))
    expect((await setReadiness(catalog, admin, saved.configurationRevision, true)).statusCode).toBe(200)
    const quoteHeaders = { origin, cookie: `${customer.cookie}; ${customer.csrfCookie}`, 'x-csrf-token': customer.csrfToken }
    const quoteBody = { items: [{ skuId: catalog.skuId, quantity: 1 }] }
    const earlierQuote = await inject({ method: 'POST', url: '/api/v1/checkout/quote', headers: quoteHeaders, payload: quoteBody })
    expect(earlierQuote.statusCode).toBe(200)
    expect(earlierQuote.json().data.canContinue).toBe(true)

    const object = await db.selectFrom('product_variant_fulfillment_versions')
      .select('private_file_object_id').where('id', '=', saved.currentVersion.id).executeTakeFirstOrThrow()
    await new PrivateFileStorage(privateRoot).removeObject(object.private_file_object_id!)

    const staleOrder = await inject({
      method: 'POST', url: '/api/v1/checkout/orders', headers: quoteHeaders,
      payload: { idempotencyKey: randomUUID(), quoteToken: earlierQuote.json().data.quoteToken, ...quoteBody },
    })
    expect(staleOrder.statusCode).toBe(409)
    expect(staleOrder.json().error.code).toBe('CHECKOUT_QUOTE_CHANGED')
    const freshQuote = await inject({ method: 'POST', url: '/api/v1/checkout/quote', headers: quoteHeaders, payload: quoteBody })
    expect(freshQuote.statusCode).toBe(200)
    expect(freshQuote.json().data.canContinue).toBe(false)
    expect(freshQuote.json().data.items[0].reason).toBe('fulfillment_not_ready')
    expect((await db.selectFrom('private_file_objects').select('status')
      .where('id', '=', object.private_file_object_id!).executeTakeFirstOrThrow()).status).toBe('missing')
    expect((await db.selectFrom('product_variant_fulfillment').select('automatic_delivery_ready')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).automatic_delivery_ready).toBe(false)
    expect(await db.selectFrom('orders as order_row').innerJoin('order_items as item', 'item.order_id', 'order_row.id')
      .where('item.product_id', '=', catalog.productId).execute()).toHaveLength(0)
  }, 30_000)

  it('records a missing-file retry, repairs the same bytes, and resumes delivery after a worker restart', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog('0.00', 'unlimited')
    const bytes = Buffer.from('restored original object after a safe retry\n')
    const saved = await saveFile(catalog, admin, 'restart-recovery.txt', bytes)
    expect((await setReadiness(catalog, admin, saved.configurationRevision, true)).statusCode).toBe(200)
    const created = await order(catalog, customer, 1)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const version = await db.selectFrom('product_variant_fulfillment_versions')
      .select('private_file_object_id').where('id', '=', saved.currentVersion.id).executeTakeFirstOrThrow()
    const objectId = version.private_file_object_id!
    const storage = new PrivateFileStorage(privateRoot)
    await storage.removeObject(objectId)

    const firstWorker = startDigitalDeliveryWorker(db, config, app.log)
    try { await waitForFailure(itemId, 'FILE_DELIVERY_OBJECT_UNAVAILABLE') } finally { await firstWorker() }
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
    expect(await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .where('attempt.order_item_id', '=', itemId).execute()).toHaveLength(0)

    const restored = await storage.storeUpload(objectId, Readable.from([bytes]), 'restart-recovery.txt')
    expect(restored.sha256).toBe(saved.currentVersion.sha256)
    const repaired = await reconcilePrivateFiles(db, storage, 'repair')
    expect(repaired.verifiedObjects).toBeGreaterThan(0)
    expect(repaired.missingObjects).toBeGreaterThanOrEqual(1)
    expect(repaired.needsAttention).toBe(true)
    expect((await db.selectFrom('private_file_objects').select('status')
      .where('id', '=', objectId).executeTakeFirstOrThrow()).status).toBe('available')
    const restartedWorker = startDigitalDeliveryWorker(db, config, app.log)
    try { await waitForCompletion(orderId, itemId) } finally { await restartedWorker() }
    const delivery = await db.selectFrom('order_item_fulfillment_deliveries as row')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'row.fulfillment_attempt_id')
      .select(['row.id', 'row.fulfillment_content_version_id'])
      .where('attempt.order_item_id', '=', itemId).where('attempt.status', '=', 'succeeded').executeTakeFirstOrThrow()
    expect(delivery.fulfillment_content_version_id).toBe(saved.currentVersion.id)
    const download = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}/items/${itemId}/deliveries/${delivery.id}/file`,
      headers: { cookie: customer.cookie },
    })
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload).toEqual(bytes)
    expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(saved.currentVersion.sha256)
  }, 30_000)

  it('fails closed on post-delivery file corruption and preserves successful history', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog('0.00', 'unlimited')
    const bytes = Buffer.from('immutable bytes must never silently change')
    const saved = await saveFile(catalog, admin, 'corruption-check.txt', bytes)
    expect((await setReadiness(catalog, admin, saved.configurationRevision, true)).statusCode).toBe(200)
    const created = await order(catalog, customer, 1)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const stop = startDigitalDeliveryWorker(db, config, app.log)
    try { await waitForCompletion(orderId, itemId) } finally { await stop() }
    const object = await db.selectFrom('product_variant_fulfillment_versions')
      .select('private_file_object_id').where('id', '=', saved.currentVersion.id).executeTakeFirstOrThrow()
    const storage = new PrivateFileStorage(privateRoot)
    const file = (await storage.scanGeneratedFiles()).find(row => row.id === object.private_file_object_id)
    expect(file).toBeDefined()
    await chmod(file!.path, 0o600)
    await writeFile(file!.path, Buffer.from('corrupted bytes must not be returned'))
    const delivery = await db.selectFrom('order_item_fulfillment_deliveries as row')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'row.fulfillment_attempt_id')
      .select(['row.id', 'row.content_sha256'])
      .where('attempt.order_item_id', '=', itemId).where('attempt.status', '=', 'succeeded').executeTakeFirstOrThrow()
    const response = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}/items/${itemId}/deliveries/${delivery.id}/file`,
      headers: { cookie: customer.cookie },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error.code).toBe('PRIVATE_FILE_INTEGRITY_FAILED')
    expect(response.rawPayload).not.toEqual(Buffer.from('corrupted bytes must not be returned'))
    expect((await db.selectFrom('private_file_objects').select('status')
      .where('id', '=', object.private_file_object_id!).executeTakeFirstOrThrow()).status).toBe('corrupt')
    expect((await db.selectFrom('product_variant_fulfillment').select('automatic_delivery_ready')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).automatic_delivery_ready).toBe(false)
    expect((await db.selectFrom('order_item_fulfillment_attempts').select('status')
      .where('order_item_id', '=', itemId).where('status', '=', 'succeeded').execute())).toHaveLength(1)
    expect((await db.selectFrom('order_item_fulfillment_deliveries').select('id')
      .where('content_sha256', '=', delivery.content_sha256).execute())).toHaveLength(1)
  }, 30_000)

  it('rejects damaged content and blocks pending payment and reconciliation cases from delivery and download', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog('2.50')
    const bad = await uploadFile(catalog, admin, 'forged.pdf', Buffer.from('this is not a PDF'))
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('PRIVATE_FILE_CONTENT_INVALID')

    const saved = await saveFile(catalog, admin, 'paid.txt', Buffer.from('paid order file'))
    const enabled = await setReadiness(catalog, admin, saved.configurationRevision, true)
    expect(enabled.statusCode).toBe(200)
    const pendingOrder = await order(catalog, customer, 1)
    expect(pendingOrder.statusCode).toBe(201)
    expect(pendingOrder.json().data.order.status).toBe('pending_payment')
    expect(pendingOrder.json().data.order.items[0].deliveries).toEqual([])
    const fakeDownload = await inject({
      method: 'GET',
      url: `/api/v1/customer/orders/${pendingOrder.json().data.order.id}/items/${pendingOrder.json().data.order.items[0].id}/deliveries/${randomUUID()}/file`,
      headers: { cookie: customer.cookie, range: 'bytes=0-100' },
    })
    expect(fakeDownload.statusCode).toBe(404)
    const attempts = await db.selectFrom('payment_attempts').select('id').where('order_id', '=', pendingOrder.json().data.order.id).execute()
    expect(attempts).toHaveLength(0)

    const paidReceipt = await db.transaction().execute(async (trx) => {
      const attemptId = randomUUID()
      const receiptId = randomUUID()
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: pendingOrder.json().data.order.id,
        topup_customer_id: null, source: 'external', amount: '2.50', status: 'created', provider: 'integration',
        provider_payment_id: `private-${attemptId}`, wallet_operation_id: null, wallet_hold_operation_id: null,
        requested_wallet_amount: null, expires_at: new Date(Date.now() + 60 * 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
      await trx.insertInto('payment_receipts').values({
        id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
        provider_transaction_id: `private-receipt-${receiptId}`, wallet_operation_id: null, wallet_line_no: null, amount: '2.50',
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'succeeded' }).where('id', '=', attemptId).execute()
      const eventId = randomUUID()
      await trx.insertInto('payment_provider_events').values({
        id: eventId, payment_attempt_id: attemptId, source: 'callback', event_sha256: digest,
        verification: 'verified', disposition: 'reconciliation_required', provider_status: 'paid',
        provider_transaction_id: `private-conflict-${receiptId}`, reported_amount: '2.50', currency: 'CNY',
        provider_paid_at: new Date(), provider_time_text: null, payload: { outcome: 'conflicting_callback' },
        error_code: 'CALLBACK_QUERY_MISMATCH',
      }).execute()
      await trx.insertInto('payment_provider_reconciliation_cases').values({
        id: randomUUID(), payment_attempt_id: attemptId, reason: 'callback_query_mismatch',
        opening_callback_event_id: eventId, opening_query_event_id: null,
      }).execute()
      return { attemptId, receiptId }
    })
    const orderId = pendingOrder.json().data.order.id as string
    const itemId = pendingOrder.json().data.order.items[0].id as string
    const stop = startDigitalDeliveryWorker(db, config, app.log)
    try {
      const deadline = Date.now() + 5_000
      let failure: string | undefined
      while (Date.now() < deadline && !failure) {
        failure = (await db.selectFrom('order_item_fulfillment_attempts').select('failure_code')
          .where('order_item_id', '=', itemId).where('delivery_source', '=', 'file')
          .orderBy('created_at', 'desc').executeTakeFirst())?.failure_code ?? undefined
        if (!failure) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(failure).toBe('FILE_DELIVERY_PAYMENT_UNRESOLVED')
    } finally { await stop() }
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', paidReceipt.attemptId).executeTakeFirstOrThrow()).status).toBe('succeeded')
    expect((await db.selectFrom('payment_receipts').select('disposition').where('id', '=', paidReceipt.receiptId).executeTakeFirstOrThrow()).disposition).toBe('on_time')
    expect(await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .where('attempt.order_item_id', '=', itemId).execute()).toHaveLength(0)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status).toBe('processing')
  }, 30_000)

  it('delivers a paid file only after a confirmed receipt and isolates zero-price guest downloads', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const paidCatalog = await createCatalog('4.25', 'unlimited')
    const paidBytes = Buffer.from('已确认收款后的真实文件交付\n')
    const savedPaid = await saveFile(paidCatalog, admin, 'paid-order.txt', paidBytes)
    expect((await setReadiness(paidCatalog, admin, savedPaid.configurationRevision, true)).statusCode).toBe(200)
    const paidOrder = await order(paidCatalog, customer, 2)
    expect(paidOrder.statusCode).toBe(201)
    const paidOrderId = paidOrder.json().data.order.id as string
    const paidItemId = paidOrder.json().data.order.items[0].id as string
    expect(paidOrder.json().data.order.status).toBe('pending_payment')

    const paymentAttemptId = randomUUID()
    const receiptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_attempts').values({
        id: paymentAttemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: paidOrderId,
        topup_customer_id: null, source: 'external', amount: '8.50', status: 'created', provider: 'integration',
        provider_payment_id: `private-success-${paymentAttemptId}`, wallet_operation_id: null,
        wallet_hold_operation_id: null, requested_wallet_amount: null,
        expires_at: new Date(Date.now() + 60 * 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', paymentAttemptId).execute()
      await trx.insertInto('payment_receipts').values({
        id: receiptId, payment_attempt_id: paymentAttemptId, source_bucket: 'external', provider: 'integration',
        provider_transaction_id: `private-success-receipt-${receiptId}`, wallet_operation_id: null,
        wallet_line_no: null, amount: '8.50',
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'succeeded' }).where('id', '=', paymentAttemptId).execute()
    })
    expect((await db.selectFrom('orders').select('status').where('id', '=', paidOrderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
    expect((await db.selectFrom('payment_receipts').select('disposition').where('id', '=', receiptId).executeTakeFirstOrThrow()).disposition)
      .toBe('on_time')
    const stopPaid = startDigitalDeliveryWorker(db, config, app.log)
    try { await waitForCompletion(paidOrderId, paidItemId) } finally { await stopPaid() }
    const paidDelivery = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select(['delivery.id', 'delivery.fulfillment_content_version_id'])
      .where('attempt.order_item_id', '=', paidItemId).where('attempt.status', '=', 'succeeded')
      .executeTakeFirstOrThrow()
    expect(paidDelivery.fulfillment_content_version_id).toBe(savedPaid.currentVersion.id)
    const paidDownload = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${paidOrderId}/items/${paidItemId}/deliveries/${paidDelivery.id}/file`,
      headers: { cookie: customer.cookie },
    })
    expect(paidDownload.statusCode).toBe(200)
    expect(paidDownload.rawPayload).toEqual(paidBytes)
    expect(createHash('sha256').update(paidDownload.rawPayload).digest('hex')).toBe(savedPaid.currentVersion.sha256)
    expect(await db.selectFrom('order_inventory_reservations').select('id').where('order_item_id', '=', paidItemId).execute())
      .toEqual([])

    await db.updateTable('storefront_customer_policy').set({
      guest_checkout_enabled: true, guest_free_claim_enabled: true,
    }).where('singleton', '=', true).execute()
    const guestCatalog = await createCatalog('0.00', 'unlimited')
    const guestBytes = Buffer.from('游客独立会话的免费交付内容')
    const savedGuest = await saveFile(guestCatalog, admin, 'guest-free.txt', guestBytes)
    expect((await setReadiness(guestCatalog, admin, savedGuest.configurationRevision, true)).statusCode).toBe(200)
    const guestA = await createGuest()
    const guestB = await createGuest()
    const guestOrderA = await guestOrder(guestCatalog, guestA, 1)
    expect(guestOrderA.statusCode).toBe(201)
    const guestOrderId = guestOrderA.json().data.order.id as string
    const guestItemId = guestOrderA.json().data.order.items[0].id as string
    expect(guestOrderA.json().data.order.status).toBe('processing')
    const stopGuest = startDigitalDeliveryWorker(db, config, app.log)
    try { await waitForCompletion(guestOrderId, guestItemId) } finally { await stopGuest() }
    const guestDelivery = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select('delivery.id').where('attempt.order_item_id', '=', guestItemId).where('attempt.status', '=', 'succeeded')
      .executeTakeFirstOrThrow()
    const guestDownloadPath = `/api/v1/guest/orders/${guestOrderId}/items/${guestItemId}/deliveries/${guestDelivery.id}/file`
    const guestDownload = await inject({ method: 'GET', url: guestDownloadPath, headers: { cookie: guestA.cookie } })
    expect(guestDownload.statusCode).toBe(200)
    expect(guestDownload.rawPayload).toEqual(guestBytes)
    expect(createHash('sha256').update(guestDownload.rawPayload).digest('hex')).toBe(savedGuest.currentVersion.sha256)
    expect((await inject({ method: 'GET', url: guestDownloadPath, headers: { cookie: guestB.cookie } })).statusCode).toBe(404)
    expect((await inject({ method: 'GET', url: guestDownloadPath })).statusCode).toBe(401)
  }, 30_000)

  it('checks and repairs interrupted upload rows and old filesystem orphans', async () => {
    const admin = await createAdmin()
    const storage = new PrivateFileStorage(privateRoot)
    const orphanId = newPrivateFileId()
    await storage.storeUpload(orphanId, Readable.from([Buffer.from('orphan recovery payload')]), 'orphan.txt')
    const orphan = (await storage.scanGeneratedFiles()).find(file => file.id === orphanId)
    expect(orphan).toBeDefined()
    const oldDate = new Date(Date.now() - 48 * 60 * 60_000)
    await utimes(orphan!.path, oldDate, oldDate)

    const staleId = randomUUID()
    const createdAt = new Date(Date.now() - 48 * 60 * 60_000)
    const expiresAt = new Date(Date.now() - 60_000)
    await db.insertInto('private_file_objects').values({
      id: staleId, uploaded_by_admin_id: admin.id, upload_filename: 'interrupted.txt',
      status: 'uploading', media_type: null, size_bytes: null, sha256: null,
      created_at: createdAt, updated_at: createdAt, expires_at: expiresAt,
    }).execute()

    const beforeRepair = await reconcilePrivateFiles(db, storage, 'check')
    expect(beforeRepair).toMatchObject({ staleUploadRows: 1, orphanFiles: 1, needsAttention: true })
    const repaired = await reconcilePrivateFiles(db, storage, 'repair')
    expect(repaired).toMatchObject({ removedOrphans: 1, staleUploadRows: 1, needsAttention: true })
    expect(await db.selectFrom('private_file_objects').select('id').where('id', '=', staleId).execute()).toEqual([])
    expect((await storage.scanGeneratedFiles()).some(file => file.id === orphanId)).toBe(false)
    const finalCheck = await reconcilePrivateFiles(db, storage, 'check')
    expect(finalCheck, JSON.stringify(finalCheck)).toMatchObject({ needsAttention: true })
  }, 30_000)
})
