import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { multiplyUnitAmount, settleAmount } from '@aikayun/money'
import sharp from 'sharp'
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
import { productRichContentToSafeHtml } from '@aikayun/contracts'
import type { CreateProductBody, ProductDetail } from '@aikayun/contracts'
import { MediaStorage } from '../src/media/storage.js'
import { reconcileProductMedia } from '../src/media/reconcile.js'
import { insertNoFormPurchaseSnapshot } from './fixtures/purchase-line.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const testEmail = 'admin@example.com'
const testPassword = 'TestOnly-Valid-Password-2026!'
const testOrigin = 'http://localhost:3000'
const mediaTestRoot = mkdtempSync(join(tmpdir(), 'aikayun-d5-media-test-'))

let app: FastifyInstance
let db: Kysely<Database>
let skuCodeOverride: string | undefined
let nextTestClient = 20
let mediaUploadRemoteAddress = 1
const migrationSentinel = {
  productId: '00000000-0000-4000-8000-000000000101',
  variantId: '00000000-0000-4000-8000-000000000102',
  skuCode: 'SKU-MIGRATION-SENTINEL',
}
const migrationD2Sentinel = {
  productId: '00000000-0000-4000-8000-000000000201',
  variantId: '00000000-0000-4000-8000-000000000202',
  skuCode: 'SKU-D2-MIGRATION-SENTINEL',
}
const legacyRetiredInventorySentinel = {
  productId: '00000000-0000-4000-8000-000000000301',
  variantId: '00000000-0000-4000-8000-000000000302',
  skuCode: 'SKU-LEGACY-RETIRED-STOCK',
  adjustmentId: '00000000-0000-4000-8000-000000000303',
  operationId: '00000000-0000-4000-8000-000000000304',
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

async function getCsrf(target: FastifyInstance = app): Promise<{ token: string; cookie: string }> {
  const response = await target.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  expect(response.statusCode).toBe(200)
  const body = response.json<{ data: { csrfToken: string } }>()
  return { token: body.data.csrfToken, cookie: cookieFrom(response, 'aikayun_admin_csrf') }
}

async function loginAdmin(
  target: FastifyInstance = app,
  credentials: { email: string; password: string } = { email: testEmail, password: testPassword },
): Promise<{ sessionCookie: string; csrf: { token: string; cookie: string } }> {
  const csrf = await getCsrf(target)
  const login = await target.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    remoteAddress: `192.0.2.${nextTestClient++}`,
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    payload: credentials,
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

async function getInventorySummary(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  quantity?: number,
) {
  const suffix = quantity === undefined ? '' : `?quantity=${quantity}`
  return app.inject({
    method: 'GET', url: `/api/v1/admin/products/${productId}/inventory${suffix}`,
    headers: { cookie: auth.sessionCookie },
  })
}

async function setInventoryMode(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  skuId: string,
  body: Record<string, unknown>,
  csrf = true,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/admin/products/${productId}/variants/${skuId}/inventory-mode`,
    headers: csrf ? productHeaders(auth) : { cookie: auth.sessionCookie, origin: testOrigin },
    payload: body,
  })
}

async function adjustInventory(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  skuId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/admin/products/${productId}/variants/${skuId}/inventory/adjustments`,
    headers: productHeaders(auth),
    payload: body,
  })
}

async function patchSkuPrices(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  skuId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/admin/products/${productId}/variants/${skuId}/prices`,
    headers: productHeaders(auth),
    payload: body,
  })
}

async function editProduct(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  body: Record<string, unknown>,
  csrf = true,
) {
  return app.inject({
    method: 'PATCH', url: `/api/v1/admin/products/${productId}`,
    headers: csrf ? productHeaders(auth) : { cookie: auth.sessionCookie, origin: testOrigin },
    payload: body,
  })
}

async function changeProductLifecycle(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'PATCH', url: `/api/v1/admin/products/${productId}/lifecycle`,
    headers: productHeaders(auth), payload: body,
  })
}

async function createReservedOrderForTest(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  variantId: string,
  quantity: number,
): Promise<string> {
  let current = (await app.inject({
    method: 'GET', url: `/api/v1/admin/products/${productId}`, headers: { cookie: auth.sessionCookie },
  })).json<{ data: ProductDetail }>().data
  if (current.status !== 'active') {
    const activated = await changeProductLifecycle(auth, productId, { expectedRevision: current.revision, status: 'active' })
    expect(activated.statusCode).toBe(200)
    current = activated.json<{ data: ProductDetail }>().data
  }
  const sku = current.variants.find((variant) => variant.id === variantId)
  if (!sku) throw new Error(`Test SKU ${variantId} is missing`)
  const customerId = randomUUID()
  const orderId = randomUUID()
  const itemId = randomUUID()
  const unitPrice = settleAmount(sku.salePrice)
  const lineAmount = settleAmount(multiplyUnitAmount(sku.salePrice, quantity))
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('customers').values({
      id: customerId, username: `reserved-${customerId.slice(0, 8)}`, password_hash: 'test-only-password-hash',
      email: null, email_verified_at: null, phone: null, phone_verified_at: null, status: 'active',
    }).execute()
    await trx.selectFrom('products').select('id').where('id', '=', productId).forUpdate().executeTakeFirstOrThrow()
    await trx.selectFrom('product_variants').select('id').where('id', '=', variantId).forUpdate().executeTakeFirstOrThrow()
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: variantId, method: 'manual', manual_delivery_ready: true,
    }).onConflict((conflict) => conflict.column('product_variant_id').doUpdateSet({
      method: 'manual', manual_delivery_ready: true,
    })).execute()
    await trx.insertInto('orders').values({
      id: orderId, customer_id: customerId, guest_order_session_id: null,
      idempotency_key: randomUUID(), request_sha256: 'a'.repeat(64), total_amount: lineAmount,
      unpaid_expires_at: new Date(Date.now() + 60_000), history_hidden_at: null,
      history_hidden_by_admin_id: null, history_hidden_reason: null,
    }).execute()
    await trx.insertInto('order_items').values({
      id: itemId, order_id: orderId, purchase_line_id: randomUUID(), product_id: productId, product_variant_id: variantId,
      product_name_snapshot: current.name, product_type_snapshot: current.productType,
      sku_code_snapshot: sku.skuCode, sku_snapshot: '[]', inventory_mode_snapshot: 'quantity',
      fulfillment_method_snapshot: 'manual', unit_price: unitPrice, quantity, line_amount: lineAmount,
    }).execute()
    await insertNoFormPurchaseSnapshot(trx, itemId, variantId)
    await trx.insertInto('order_inventory_reservations').values({
      id: randomUUID(), order_item_id: itemId, product_id: productId, product_variant_id: variantId, quantity,
    }).execute()
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
  })
  return orderId
}

async function copyProduct(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  expectedRevision: number,
) {
  return app.inject({
    method: 'POST', url: `/api/v1/admin/products/${productId}/copy`,
    headers: productHeaders(auth), payload: { expectedRevision },
  })
}

async function deleteProduct(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  expectedRevision: number,
) {
  return app.inject({
    method: 'DELETE', url: `/api/v1/admin/products/${productId}`,
    headers: productHeaders(auth), payload: { expectedRevision },
  })
}

interface MultipartPart {
  name: string
  bytes?: Buffer
  mimeType?: string
  filename?: string
  value?: string
}

function multipartPayload(parts: MultipartPart[]) {
  const boundary = 'aikayun-d5-integration-boundary'
  const chunks: Buffer[] = []
  for (const part of parts) {
    if (part.bytes) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename ?? 'client-file.bin'}"\r\nContent-Type: ${part.mimeType ?? 'application/octet-stream'}\r\n\r\n`))
      chunks.push(part.bytes)
      chunks.push(Buffer.from('\r\n'))
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\nContent-Type: text/plain\r\n\r\n${part.value ?? ''}\r\n`))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    boundary,
    body: Buffer.concat(chunks),
  }
}

async function uploadMedia(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  bytes: Buffer,
  mimeType = 'image/png',
  filename = 'client-image.png',
  target: FastifyInstance = app,
) {
  const form = multipartPayload([{ name: 'file', bytes, mimeType, filename }])
  return target.inject({
    method: 'POST',
    url: '/api/v1/admin/media',
    remoteAddress: `198.51.100.${mediaUploadRemoteAddress++}`,
    headers: { ...productHeaders(auth), 'content-type': `multipart/form-data; boundary=${form.boundary}` },
    payload: form.body,
  })
}

async function replaceGallery(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  expectedRevision: number,
  mediaIds: string[],
) {
  return app.inject({
    method: 'PUT', url: `/api/v1/admin/products/${productId}/media`,
    headers: productHeaders(auth), payload: { expectedRevision, mediaIds },
  })
}

async function saveRichContent(
  auth: Awaited<ReturnType<typeof loginAdmin>>,
  productId: string,
  expectedRevision: number,
  content: unknown,
) {
  return app.inject({
    method: 'PUT', url: `/api/v1/admin/products/${productId}/rich-content`,
    headers: productHeaders(auth), payload: { expectedRevision, content },
  })
}

async function getAdminProduct(auth: Awaited<ReturnType<typeof loginAdmin>>, productId: string) {
  return app.inject({
    method: 'GET', url: `/api/v1/admin/products/${productId}`, headers: { cookie: auth.sessionCookie },
  })
}

async function samplePng(): Promise<Buffer> {
  return sharp({
    create: { width: 48, height: 32, channels: 4, background: { r: 220, g: 40, b: 90, alpha: 0.45 } },
  }).png().toBuffer()
}

async function sampleOrientedJpeg(): Promise<Buffer> {
  const jpeg = await sharp({
    create: { width: 48, height: 24, channels: 3, background: { r: 60, g: 110, b: 220 } },
  }).jpeg().toBuffer()
  const exifOrientation6 = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ])
  return Buffer.concat([jpeg.subarray(0, 2), exifOrientation6, jpeg.subarray(2)])
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

  const migratedD2Schema = await migrator.migrateTo('202610160004_product_catalog_r1')
  if (migratedD2Schema.error) throw migratedD2Schema.error
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: migrationD2Sentinel.productId,
      name: 'D2 迁移基线商品',
      description: 'D3 前进迁移必须保留商品、SKU 和分类规格基础',
      product_type: 'digital',
      status: 'draft',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: migrationD2Sentinel.variantId,
      product_id: migrationD2Sentinel.productId,
      sku_code: migrationD2Sentinel.skuCode,
      combination_key: '',
      sale_price: '29.90',
      enabled: true,
    }).execute()
  })

  const migratedD3Schema = await migrator.migrateTo('202610160005_product_pricing_inventory')
  if (migratedD3Schema.error) throw migratedD3Schema.error
  const migrationAdmin = await db.selectFrom('admin_users').select('id').where('email', '=', testEmail).executeTakeFirstOrThrow()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: legacyRetiredInventorySentinel.productId,
      name: '升级前遗留退役库存',
      product_type: 'digital',
      status: 'draft',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: legacyRetiredInventorySentinel.variantId,
      product_id: legacyRetiredInventorySentinel.productId,
      sku_code: legacyRetiredInventorySentinel.skuCode,
      combination_key: '',
      sale_price: '7.50',
      enabled: true,
    }).execute()
    await trx.updateTable('product_variants').set({ inventory_mode: 'quantity', inventory_revision: 1 })
      .where('id', '=', legacyRetiredInventorySentinel.variantId).execute()
    await trx.insertInto('product_variant_quantity_inventory').values({
      product_id: legacyRetiredInventorySentinel.productId,
      product_variant_id: legacyRetiredInventorySentinel.variantId,
      stocked: 5,
      reserved: 0,
    }).execute()
    await trx.insertInto('product_variant_inventory_adjustments').values({
      id: legacyRetiredInventorySentinel.adjustmentId,
      product_id: legacyRetiredInventorySentinel.productId,
      product_variant_id: legacyRetiredInventorySentinel.variantId,
      operation_id: legacyRetiredInventorySentinel.operationId,
      administrator_id: migrationAdmin.id,
      action: 'increase',
      requested_quantity: 5,
      quantity_before: 0,
      quantity_after: 5,
      quantity_delta: 5,
      inventory_revision: 1,
      reason: 'D3 R1 migration preservation fixture',
    }).execute()
    await trx.updateTable('product_variants').set({ enabled: false, retired_at: new Date() })
      .where('id', '=', legacyRetiredInventorySentinel.variantId).execute()
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
    MEDIA_ROOT: mediaTestRoot,
  })
  app = await createApp({ db, config, logger: false, productIdentityFactory })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
  rmSync(mediaTestRoot, { recursive: true, force: true })
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
    const before = await sql<{ products: string; variants: string; audit_events: string }>`
      select
        (select count(*)::text from products) as products,
        (select count(*)::text from product_variants) as variants,
        (select count(*)::text from product_management_audit_events) as audit_events
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
    const after = await sql<{ products: string; variants: string; audit_events: string }>`
      select
        (select count(*)::text from products) as products,
        (select count(*)::text from product_variants) as variants,
        (select count(*)::text from product_management_audit_events) as audit_events
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
      'admin_product_creation_requests', 'admin_sessions', 'admin_users', 'api_fulfillment_audit_events', 'code_pool_batches',
      'code_pool_entries', 'code_pool_withdrawal_entries', 'customer_cart_items', 'customer_cart_line_replacement_drafts',
      'customer_cart_merge_requests', 'customer_management_audit',
      'customer_sessions', 'customers', 'guest_order_sessions',
      'order_inventory_events', 'order_inventory_reservations', 'order_item_fulfillment_attempts',
      'order_item_fulfillment_deliveries', 'order_item_purchase_attachments', 'order_item_purchase_snapshots', 'order_items',
      'order_refund_allocations', 'order_refund_audit_events', 'order_refund_manual_attempts',
      'order_refunds', 'order_status_events', 'orders',
      'payment_attempt_provider_state', 'payment_attempt_secrets', 'payment_attempts',
      'payment_channel_audit_events', 'payment_channels', 'payment_provider_events',
      'payment_provider_reconciliation_cases', 'payment_receipts', 'private_file_objects',
      'product_attributes', 'product_categories', 'product_category_assignments',
      'product_category_tree_guard', 'product_management_audit_events',
      'product_media', 'product_media_references', 'product_media_variants',
      'product_option_groups', 'product_option_values',
      'product_purchase_form_settings',
      'product_variant_fulfillment', 'product_variant_fulfillment_versions', 'product_variant_inventory_adjustments', 'product_variant_option_values',
      'product_variant_quantity_inventory', 'product_variants', 'products',
      'purchase_draft_attachment_references', 'purchase_draft_attachments', 'purchase_drafts',
      'purchase_form_audit_events', 'purchase_form_template_identities', 'purchase_form_template_versions', 'purchase_form_templates',
      'purchase_order_attachment_objects',
      'sku_purchase_form_overrides',
      'storefront_customer_policy', 'supplier_api_delivery_events', 'supplier_api_delivery_operations',
      'supplier_api_operations_admin_audit', 'supplier_connection_audit_events', 'supplier_connection_credentials', 'supplier_connection_tests',
      'supplier_connection_versions', 'supplier_connections',
      'supplier_product_mapping_audit_events', 'supplier_product_mapping_heads',
      'supplier_product_mapping_observations', 'supplier_product_mapping_versions',
      'wallet_accounts', 'wallet_ledger_entries', 'wallet_operations',
      'withdrawal_audit_events', 'withdrawal_payout_attempts', 'withdrawal_payout_results',
      'withdrawal_private_files', 'withdrawal_settings_audit_events', 'withdrawals',
    ])
    const admin = await db.selectFrom('admin_users').select('email').where('email', '=', testEmail).executeTakeFirst()
    expect(admin?.email).toBe(testEmail)
    const migratedProduct = await db.selectFrom('products').select(['id', 'name']).where('id', '=', migrationSentinel.productId).executeTakeFirst()
    expect(migratedProduct).toEqual({ id: migrationSentinel.productId, name: '迁移前已有商品' })
    expect(await db.selectFrom('product_management_audit_events').select('id')
      .where('product_id', '=', migrationSentinel.productId).execute()).toEqual([])
    expect(await db.selectFrom('products').select('rich_content').where('id', '=', migrationSentinel.productId).executeTakeFirstOrThrow())
      .toEqual({ rich_content: { type: 'doc', content: [{ type: 'paragraph' }] } })
    const migratedSku = await db.selectFrom('product_variants').select(['id', 'sku_code', 'sale_price'])
      .where('id', '=', migrationSentinel.variantId).executeTakeFirst()
    expect(migratedSku).toEqual({
      id: migrationSentinel.variantId,
      sku_code: migrationSentinel.skuCode,
      sale_price: '19.90000',
    })
    const migratedInventoryDefaults = await db.selectFrom('product_variants')
      .select(['inventory_mode', 'inventory_revision', 'compare_at_price', 'cost_price'])
      .where('id', '=', migrationSentinel.variantId).executeTakeFirstOrThrow()
    expect(migratedInventoryDefaults).toEqual({
      inventory_mode: null,
      inventory_revision: 0,
      compare_at_price: null,
      cost_price: null,
    })
    expect(await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
      .where('product_variant_id', '=', migrationSentinel.variantId).execute()).toEqual([])
    const d2Product = await db.selectFrom('products').select(['id', 'name'])
      .where('id', '=', migrationD2Sentinel.productId).executeTakeFirst()
    expect(d2Product).toEqual({ id: migrationD2Sentinel.productId, name: 'D2 迁移基线商品' })
    const d2Sku = await db.selectFrom('product_variants').select(['id', 'sku_code', 'sale_price', 'inventory_mode', 'inventory_revision'])
      .where('id', '=', migrationD2Sentinel.variantId).executeTakeFirst()
    expect(d2Sku).toEqual({
      id: migrationD2Sentinel.variantId,
      sku_code: migrationD2Sentinel.skuCode,
      sale_price: '29.90000',
      inventory_mode: null,
      inventory_revision: 0,
    })
    expect(await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
      .where('product_variant_id', '=', migrationD2Sentinel.variantId).execute()).toEqual([])
    const legacyInventory = await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', legacyRetiredInventorySentinel.variantId).executeTakeFirst()
    expect(legacyInventory).toEqual({ stocked: 5, reserved: 0 })
    const legacyAdjustment = await db.selectFrom('product_variant_inventory_adjustments')
      .select(['id', 'quantity_before', 'quantity_after', 'reason'])
      .where('id', '=', legacyRetiredInventorySentinel.adjustmentId).executeTakeFirst()
    expect(legacyAdjustment).toEqual({
      id: legacyRetiredInventorySentinel.adjustmentId,
      quantity_before: 0,
      quantity_after: 5,
      reason: 'D3 R1 migration preservation fixture',
    })
  })

  it('preserves and permits audited reduction of retired inventory left by the earlier D3 migration', async () => {
    const auth = await loginAdmin()
    const summary = await getInventorySummary(auth, legacyRetiredInventorySentinel.productId)
    const legacySku = summary.json().data.variants[0]
    expect(legacySku).toMatchObject({
      skuId: legacyRetiredInventorySentinel.variantId,
      retiredAt: expect.any(String),
      inventory: { mode: 'quantity', stocked: 5, reserved: 0, available: 5 },
    })

    const cleanup = await adjustInventory(auth, legacyRetiredInventorySentinel.productId,
      legacyRetiredInventorySentinel.variantId, {
        expectedInventoryRevision: 1,
        operationId: randomUUID(),
        action: 'decrease',
        quantity: 5,
        reason: '受控清退升级前已退役 SKU 库存',
      })
    expect(cleanup.statusCode).toBe(201)
    const cleared = await getInventorySummary(auth, legacyRetiredInventorySentinel.productId)
    expect(cleared.json().data.variants[0]).toMatchObject({
      retiredAt: expect.any(String),
      inventory: { stocked: 0, reserved: 0, available: 0 },
    })
    expect(await db.selectFrom('product_variant_inventory_adjustments').select(['id', 'quantity_before', 'quantity_after'])
      .where('product_variant_id', '=', legacyRetiredInventorySentinel.variantId)
      .orderBy('inventory_revision').execute()).toEqual([
      { id: legacyRetiredInventorySentinel.adjustmentId, quantity_before: 0, quantity_after: 5 },
      { id: cleanup.json().data.id, quantity_before: 5, quantity_after: 0 },
    ])
    const cannotRestock = await adjustInventory(auth, legacyRetiredInventorySentinel.productId,
      legacyRetiredInventorySentinel.variantId, {
        expectedInventoryRevision: 3,
        operationId: randomUUID(), action: 'increase', quantity: 1, reason: '退役后禁止补货',
      })
    expect(cannotRestock.statusCode).toBe(409)
    expect(cannotRestock.json().error.code).toBe('SKU_PERMANENTLY_RETIRED')
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

  it('allows a temporarily disabled SKU to be re-enabled with the same identity', async () => {
    const auth = await loginAdmin()
    const draft = await createTestProduct(auth, '临时停用 SKU')
    const groupId = randomUUID()
    const valueId = randomUUID()
    const options = [optionGroup('期限', groupId, [{ id: valueId, name: '月卡' }])]
    const created = await saveMatrix(auth, draft.id, {
      expectedRevision: draft.revision,
      mode: 'selected',
      groups: options,
      combinations: [{ optionValueIds: [valueId], salePrice: '9.90', enabled: true }],
    })
    const first = created.json<{ data: { product: ProductDetail } }>().data.product
    const sku = first.variants[0]!

    const paused = await saveMatrix(auth, draft.id, {
      expectedRevision: first.revision,
      mode: 'selected',
      groups: options,
      combinations: [{ skuId: sku.id, optionValueIds: [valueId], enabled: false }],
    })
    expect(paused.statusCode).toBe(200)
    const pausedProduct = paused.json<{ data: { product: ProductDetail } }>().data.product
    expect(pausedProduct.variants[0]).toMatchObject({ id: sku.id, skuCode: sku.skuCode, salePrice: '9.90', enabled: false, retiredAt: null })

    const resumed = await saveMatrix(auth, draft.id, {
      expectedRevision: pausedProduct.revision,
      mode: 'selected',
      groups: options,
      combinations: [{ skuId: sku.id, optionValueIds: [valueId], enabled: true }],
    })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json<{ data: { product: ProductDetail } }>().data.product.variants[0])
      .toMatchObject({ id: sku.id, skuCode: sku.skuCode, salePrice: '9.90', enabled: true, retiredAt: null })
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
    const selfParentId = randomUUID()
    await expect(db.insertInto('product_categories').values({
      id: selfParentId,
      parent_id: selfParentId,
      name: '数据库自引用拒绝',
      sort_order: 0,
      is_visible: true,
    }).execute()).rejects.toMatchObject({ code: '23514', constraint: 'product_categories_no_cycle' })
    expect(await db.selectFrom('product_categories').select('id').where('id', '=', selfParentId).execute()).toHaveLength(0)
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

  it('reorders duplicate-ranked category siblings transactionally and normalizes both sides of a move', async () => {
    const auth = await loginAdmin()
    const create = async (name: string, parentId?: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth),
        payload: { name, ...(parentId ? { parentId } : {}) },
      })
      expect(response.statusCode).toBe(201)
      return response.json<{ data: { id: string; parentId: string | null; sortOrder: number; revision: number } }>().data
    }
    const patch = (category: { id: string; revision: number }, payload: Record<string, unknown>) => app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${category.id}`, headers: productHeaders(auth),
      payload: { expectedRevision: category.revision, ...payload },
    })
    const read = async () => (await app.inject({
      method: 'GET', url: '/api/v1/admin/categories', headers: { cookie: auth.sessionCookie },
    })).json<{ data: { categories: Array<{ id: string; parentId: string | null; sortOrder: number; revision: number }> } }>().data.categories
    const assertContiguous = (categories: Array<{ sortOrder: number }>) => {
      expect(categories.map(category => category.sortOrder)).toEqual(categories.map((_, index) => index))
    }

    const originals = await Promise.all(['排序甲', '排序乙', '排序丙'].map(name => create(name)))
    const initial = await read()
    const rootOrder = initial.filter(category => category.parentId === null)
    const trackedOrder = rootOrder.filter(category => originals.some(original => original.id === category.id))
    expect(trackedOrder.map(category => category.sortOrder)).toEqual([0, 0, 0])
    const firstBeforeMove = trackedOrder[0]!
    const lastBeforeMove = trackedOrder.at(-1)!
    const moveToFirst = await patch(lastBeforeMove, { sortOrder: 0 })
    expect(moveToFirst.statusCode).toBe(200)
    let allRoots = (await read()).filter(category => category.parentId === null)
    assertContiguous(allRoots)
    expect(allRoots[0]!.id).toBe(lastBeforeMove.id)
    let reordered = allRoots.filter(category => originals.some(original => original.id === category.id))

    const freshFirst = reordered.find(category => category.id === firstBeforeMove.id)!
    const moveToLast = await patch(freshFirst, { sortOrder: 1_000_000 })
    expect(moveToLast.statusCode).toBe(200)
    allRoots = (await read()).filter(category => category.parentId === null)
    assertContiguous(allRoots)
    expect(allRoots.at(-1)!.id).toBe(firstBeforeMove.id)
    reordered = allRoots.filter(category => originals.some(original => original.id === category.id))

    const otherParent = await create('独立父类')
    const otherSiblings = await Promise.all(['独立子甲', '独立子乙'].map(name => create(name, otherParent.id)))
    const toMove = reordered[1]!
    const moved = await patch(toMove, { parentId: otherParent.id })
    expect(moved.statusCode).toBe(200)
    expect(moved.json<{ data: { parentId: string; sortOrder: number } }>().data).toMatchObject({
      parentId: otherParent.id, sortOrder: 2,
    })
    const afterMove = await read()
    const sourceRoots = afterMove.filter(category => category.parentId === null)
    assertContiguous(sourceRoots)
    expect(sourceRoots.some(category => category.id === toMove.id)).toBe(false)
    const destination = afterMove.filter(category => category.parentId === otherParent.id)
    assertContiguous(destination)
    expect(otherSiblings.every(sibling => destination.some(category => category.id === sibling.id))).toBe(true)
    const normalizedSibling = reordered.find((category) => {
      if (category.id === toMove.id) return false
      const currentSibling = afterMove.find(candidate => candidate.id === category.id)
      return currentSibling !== undefined && currentSibling.revision > category.revision
    })
    if (normalizedSibling) {
      const currentSibling = afterMove.find(category => category.id === normalizedSibling.id)!
      expect(currentSibling.sortOrder).not.toBe(normalizedSibling.sortOrder)
    }
    const staleCategory = normalizedSibling ?? toMove
    const staleWrite = await patch(staleCategory, { name: '不可覆盖的旧修订' })
    expect(staleWrite.statusCode).toBe(409)
    expect(staleWrite.json().error.code).toBe('CATEGORY_REVISION_CONFLICT')
  })

  it.each([
    ['read committed', 'read committed', '23514'],
    ['repeatable read', 'repeatable read', '40001'],
  ] as const)('protects opposite category moves at %s isolation, including stale snapshots', async (_label, isolation, expectedCode) => {
    const auth = await loginAdmin()
    const create = async (name: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name },
      })
      return response.json<{ data: { id: string; revision: number } }>().data
    }
    const left = await create('并发左')
    const right = await create('并发右')

    let releaseFirst!: () => void
    let firstHasMoved!: () => void
    let secondIsWaiting!: () => void
    const release = new Promise<void>((resolve) => { releaseFirst = resolve })
    const moved = new Promise<void>((resolve) => { firstHasMoved = resolve })
    const waiting = new Promise<void>((resolve) => { secondIsWaiting = resolve })
    const first = db.transaction().setIsolationLevel(isolation).execute(async (trx) => {
      await sql`UPDATE product_category_tree_guard SET revision = revision + 1 WHERE singleton`.execute(trx)
      await trx.updateTable('product_categories').set({ parent_id: right.id }).where('id', '=', left.id).execute()
      firstHasMoved()
      await release
    })
    await moved

    let secondPid = 0
    const second = db.transaction().setIsolationLevel(isolation).execute(async (trx) => {
      // Establish a snapshot before waiting for the first transaction's shared guard row.
      await trx.selectFrom('product_categories').select('id').execute()
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`.execute(trx)
      secondPid = pid.rows[0]!.pid
      secondIsWaiting()
      await sql`UPDATE product_category_tree_guard SET revision = revision + 1 WHERE singleton`.execute(trx)
      await trx.updateTable('product_categories').set({ parent_id: left.id }).where('id', '=', right.id).execute()
    })
    await waiting

    const deadline = Date.now() + 5_000
    let blocked = false
    while (Date.now() < deadline) {
      const activity = await sql<{ wait_event_type: string | null }>`
        SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${secondPid}
      `.execute(db)
      if (activity.rows[0]?.wait_event_type === 'Lock') {
        blocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(blocked).toBe(true)
    releaseFirst()
    await first
    const secondResult = await Promise.allSettled([second])
    expect(secondResult[0]?.status).toBe('rejected')
    if (secondResult[0]?.status === 'rejected') expect(secondResult[0].reason).toMatchObject({ code: expectedCode })
    const rows = await db.selectFrom('product_categories').select(['id', 'parent_id'])
      .where('id', 'in', [left.id, right.id]).execute()
    expect(rows.filter((row) => row.parent_id === null)).toHaveLength(1)
    expect(rows.filter((row) => row.parent_id !== null)).toHaveLength(1)
  }, 30_000)

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

  it('uses automatic matrix defaults only for new SKUs and keeps preview aligned with saved existing SKUs', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '保留自动矩阵现有价格')
    const groupId = randomUUID()
    const values = [
      { id: randomUUID(), name: '月卡' },
      { id: randomUUID(), name: '季卡' },
      { id: randomUUID(), name: '年卡' },
    ]
    const initial = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('期限', groupId, values)],
      combinations: [
        { optionValueIds: [values[0]!.id], salePrice: '9.90', enabled: true },
        { optionValueIds: [values[1]!.id], salePrice: '25.00', enabled: false },
        { optionValueIds: [values[2]!.id], salePrice: '88.00', enabled: true },
      ],
    })
    expect(initial.statusCode).toBe(200)
    const populated = initial.json<{ data: { product: ProductDetail } }>().data.product
    const monthSku = populated.variants.find((variant) => variant.options[0]?.valueId === values[0]!.id)!
    const addedValue = { id: randomUUID(), name: '两年卡' }
    const groups = [optionGroup('期限', groupId, [...values, addedValue])]
    const body = {
      expectedRevision: populated.revision,
      mode: 'all',
      groups,
      newSkuDefaults: { salePrice: '1.00', enabled: false },
      skuEnabledUpdates: [{ skuId: monthSku.id, enabled: false }],
    }
    const preview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: body,
    })
    expect(preview.statusCode).toBe(200)
    const previewData = preview.json<{ data: { requestedSkuCount: number; changes: Array<{
      change: string; skuId: string | null; skuCode: string | null; salePrice: string | null; enabled: boolean | null;
      options: Array<{ valueId: string }>
    }> } }>().data
    expect(previewData.requestedSkuCount).toBe(4)
    expect(previewData.changes.find((change) => change.skuId === monthSku.id))
      .toMatchObject({ change: 'modified', skuCode: monthSku.skuCode, salePrice: '9.90', enabled: false })
    const retainedPreview = previewData.changes.filter((change) => change.change === 'retained')
    expect(retainedPreview).toHaveLength(2)
    const expected = new Map([
      [values[0]!.id, { salePrice: '9.90', enabled: false }],
      [values[1]!.id, { salePrice: '25.00', enabled: false }],
      [values[2]!.id, { salePrice: '88.00', enabled: true }],
    ])
    for (const change of retainedPreview) {
      const valueId = change.options[0]!.valueId
      expect(change).toMatchObject({ ...expected.get(valueId), skuId: expect.any(String), skuCode: expect.any(String) })
    }
    const newPreview = previewData.changes.find((change) => change.change === 'added')
    expect(newPreview).toMatchObject({ skuId: null, skuCode: null, salePrice: '1.00', enabled: false })

    const saved = await saveMatrix(auth, product.id, body)
    expect(saved.statusCode).toBe(200)
    const savedData = saved.json<{ data: { product: ProductDetail; changes: Array<{
      change: string; skuId: string | null; skuCode: string | null; salePrice: string | null; enabled: boolean | null;
      options: Array<{ valueId: string }>
    }> } }>().data
    expect(savedData.product.variants).toHaveLength(4)
    for (const variant of populated.variants) {
      const result = savedData.product.variants.find((candidate) => candidate.id === variant.id)!
      expect(result).toMatchObject({
        id: variant.id,
        skuCode: variant.skuCode,
        salePrice: variant.salePrice,
        enabled: variant.id === monthSku.id ? false : variant.enabled,
        retiredAt: null,
      })
      expect(savedData.changes.find((change) => change.skuId === variant.id))
        .toMatchObject({ change: variant.id === monthSku.id ? 'modified' : 'retained', skuCode: variant.skuCode,
          salePrice: variant.salePrice, enabled: variant.id === monthSku.id ? false : variant.enabled })
    }
    expect(savedData.product.variants.find((variant) => variant.options[0]?.valueId === addedValue.id))
      .toMatchObject({ salePrice: '1.00', enabled: false })

    await expect(sql`TRUNCATE TABLE product_variant_option_values`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'product_variant_option_values_truncate_forbidden' })
    await expect(sql`TRUNCATE TABLE product_option_values CASCADE`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'product_variant_option_values_truncate_forbidden' })
    const associations = await db.selectFrom('product_variant_option_values').selectAll()
      .where('product_id', '=', product.id).execute()
    expect(associations).toHaveLength(4)
    for (const variant of savedData.product.variants) {
      const stored = await db.selectFrom('product_variants').select('combination_key').where('id', '=', variant.id).executeTakeFirstOrThrow()
      expect(stored.combination_key).toBe(`v1:${variant.options[0]!.valueId}`)
    }
  })

  it('rejects automatic-matrix attempts to re-enable a permanently retired SKU', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '自动矩阵退役 SKU 不可恢复')
    const optionGroupId = randomUUID()
    const value = { id: randomUUID(), name: '标准版' }
    const groups = [optionGroup('版本', optionGroupId, [value])]
    const initialized = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups,
      combinations: [{ optionValueIds: [value.id], salePrice: '12.00', enabled: true }],
      retireSkuIds: [product.variants[0]!.id],
    })
    expect(initialized.statusCode).toBe(200)
    const retiredSkuId = product.variants[0]!.id
    const current = initialized.json<{ data: { product: ProductDetail } }>().data.product
    const attempt = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth),
      payload: {
        expectedRevision: current.revision,
        mode: 'all',
        groups,
        newSkuDefaults: { salePrice: '8.00', enabled: true },
        skuEnabledUpdates: [{ skuId: retiredSkuId, enabled: true }],
      },
    })
    expect(attempt.statusCode).toBe(409)
    expect(attempt.json().error.code).toBe('SKU_RETIRED')
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

  it('allows every SKU to be temporarily disabled while retaining the SKU minimum', async () => {
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
    expect(response.statusCode).toBe(200)
    const after = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    const saved = after.json<{ data: ProductDetail }>().data
    expect(saved.revision).toBeGreaterThan(product.revision)
    expect(saved.optionGroups).toHaveLength(1)
    expect(saved.variants).toHaveLength(1)
    expect(saved.variants[0]).toMatchObject({ enabled: false, retiredAt: null, salePrice: '10.00' })
    expect(saved.variants[0]?.id).not.toBe(defaultSku.id)
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
      expect(preserved.retiredAt).toBeTruthy()
      expect(preserved.isDefault).toBe(true)
      expect(variants.some((variant) => variant.id !== legacySku.id && variant.enabled)).toBe(true)

      const reenable = await saveMatrix(auth, product.id, {
        expectedRevision: retained.json<{ data: { product: ProductDetail } }>().data.product.revision,
        mode: 'selected',
        groups: [optionGroup('期限', groupId, [{ id: valueId, name: '年卡' }])],
        combinations: [{ skuId: legacySku.id, optionValueIds: [valueId], salePrice: '30.00', enabled: true }],
      })
      expect(reenable.statusCode).toBe(409)
      expect(reenable.json().error.code).toBe('SKU_RETIRED')
      await expect(db.updateTable('product_variants').set({ enabled: true }).where('id', '=', legacySku.id).execute())
        .rejects.toMatchObject({ code: '23514', constraint: 'product_variant_retired_immutable' })
      const stillRetired = await db.selectFrom('product_variants').select(['enabled', 'retired_at', 'sku_code', 'combination_key'])
        .where('id', '=', legacySku.id).executeTakeFirstOrThrow()
      expect(stillRetired).toMatchObject({ enabled: false, sku_code: legacySku.skuCode, combination_key: '' })
      expect(stillRetired.retired_at).toBeTruthy()
    } finally {
      await sql`DROP TABLE IF EXISTS d2_sku_history_probe`.execute(db)
    }
  })

  it('keeps permanently retired option SKUs and their specification references in later matrix edits', async () => {
    const auth = await loginAdmin()
    const draft = await createTestProduct(auth, '规格退役历史保留')
    const groupId = randomUUID()
    const values = [
      { id: randomUUID(), name: '月卡' },
      { id: randomUUID(), name: '季卡' },
      { id: randomUUID(), name: '年卡' },
    ]
    const initial = await saveMatrix(auth, draft.id, {
      expectedRevision: draft.revision,
      mode: 'selected',
      groups: [optionGroup('期限', groupId, values)],
      combinations: values.map((value, index) => ({
        optionValueIds: [value.id], salePrice: ['9.90', '25.00', '88.00'][index]!, enabled: true,
      })),
    })
    const populated = initial.json<{ data: { product: ProductDetail } }>().data.product
    const retiredSku = populated.variants.find((variant) => variant.options[0]?.valueId === values[0]!.id)!
    const activeSkus = populated.variants.filter((variant) => variant.id !== retiredSku.id)
    const retire = await saveMatrix(auth, draft.id, {
      expectedRevision: populated.revision,
      mode: 'selected',
      groups: [optionGroup('期限', groupId, values)],
      combinations: activeSkus.map((variant) => ({
        skuId: variant.id,
        optionValueIds: [variant.options[0]!.valueId],
      })),
      retireSkuIds: [retiredSku.id],
    })
    expect(retire.statusCode).toBe(200)
    const retiredProduct = retire.json<{ data: { product: ProductDetail } }>().data.product
    const retainedHistory = retiredProduct.variants.find((variant) => variant.id === retiredSku.id)!
    expect(retainedHistory).toMatchObject({
      id: retiredSku.id, skuCode: retiredSku.skuCode, enabled: false, isDefault: false,
      retiredAt: expect.any(String),
      options: [{ groupId, valueId: values[0]!.id }],
    })

    const renamed = await saveMatrix(auth, draft.id, {
      expectedRevision: retiredProduct.revision,
      mode: 'selected',
      groups: [optionGroup('销售期限', groupId, [
        { ...values[0]!, name: '已停月卡', sortOrder: 2 },
        { ...values[1]!, name: '季卡 2026', sortOrder: 0 },
        { ...values[2]!, name: '年卡 2026', sortOrder: 1 },
      ], 4)],
      combinations: [{ skuId: activeSkus[0]!.id, optionValueIds: [values[1]!.id] }],
    })
    expect(renamed.statusCode).toBe(200)
    const afterRename = renamed.json<{ data: { product: ProductDetail } }>().data.product
    const preservedAfterRename = afterRename.variants.find((variant) => variant.id === retiredSku.id)!
    expect(preservedAfterRename).toMatchObject({
      id: retiredSku.id, skuCode: retiredSku.skuCode, enabled: false,
      options: [{ groupId, valueId: values[0]!.id, groupName: '销售期限', valueName: '已停月卡' }],
    })

    const unsafeRemoval = await saveMatrix(auth, draft.id, {
      expectedRevision: afterRename.revision,
      mode: 'selected',
      groups: [optionGroup('销售期限', groupId, [{ ...values[1]!, name: '季卡 2026' }], 4)],
      combinations: [{ skuId: activeSkus[0]!.id, optionValueIds: [values[1]!.id] }],
    })
    expect(unsafeRemoval.statusCode).toBe(409)
    expect(unsafeRemoval.json().error.code).toBe('SPECIFICATION_VALUE_IN_USE')
    await expect(db.deleteFrom('product_variant_option_values').where('product_variant_id', '=', retiredSku.id).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'product_variant_retired_options_immutable' })
    const unchanged = await db.selectFrom('product_variant_option_values').select(['option_group_id', 'option_value_id'])
      .where('product_variant_id', '=', retiredSku.id).executeTakeFirstOrThrow()
    expect(unchanged).toEqual({ option_group_id: groupId, option_value_id: values[0]!.id })
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

  it('manages per-SKU CNY pricing with product and SKU revisions and keeps cost data internal', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/admin/products/00000000-0000-4000-8000-000000000001/variants/00000000-0000-4000-8000-000000000002/prices' })
    expect(unauthorized.statusCode).toBe(401)
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, 'D3 SKU 价格')
    const groupId = randomUUID()
    const firstValueId = randomUUID()
    const secondValueId = randomUUID()
    const matrix = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('时长', groupId, [{ id: firstValueId, name: '月卡' }, { id: secondValueId, name: '年卡' }])],
      combinations: [
        { optionValueIds: [firstValueId], salePrice: '19.90', enabled: true },
        { optionValueIds: [secondValueId], salePrice: '129.00', enabled: true },
      ],
    })
    const current = matrix.json<{ data: { product: ProductDetail } }>().data.product
    const sku = current.variants.find((variant) => variant.options[0]?.valueId === firstValueId)!
    const otherSku = current.variants.find((variant) => variant.id !== sku.id)!
    const initialRead = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/prices`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(initialRead.statusCode).toBe(200)
    const initialPrice = initialRead.json<{ data: { productRevision: number; skuRevision: number; salePrice: string; compareAtPrice: string | null; costPrice: string | null } }>().data
    expect(initialPrice).toMatchObject({ salePrice: '19.90', compareAtPrice: null, costPrice: null })

    const missingCsrf = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/prices`,
      headers: { cookie: `${auth.sessionCookie}; ${auth.csrf.cookie}`, origin: testOrigin },
      payload: { expectedRevision: initialPrice.productRevision, expectedSkuRevision: initialPrice.skuRevision, salePrice: '0.00' },
    })
    expect(missingCsrf.statusCode).toBe(403)

    const repriced = await patchSkuPrices(auth, product.id, sku.id, {
      expectedRevision: initialPrice.productRevision,
      expectedSkuRevision: initialPrice.skuRevision,
      salePrice: '0.00',
      compareAtPrice: '9.99',
      costPrice: '1.23456',
    })
    expect(repriced.statusCode).toBe(200)
    const savedPrice = repriced.json<{ data: { productRevision: number; skuRevision: number; salePrice: string; compareAtPrice: string | null; costPrice: string | null } }>().data
    expect(savedPrice).toMatchObject({ salePrice: '0.00', compareAtPrice: '9.99', costPrice: '1.23456' })
    expect(savedPrice.productRevision).toBeGreaterThan(initialPrice.productRevision)
    expect(savedPrice.skuRevision).toBeGreaterThan(initialPrice.skuRevision)
    const dbPrice = await db.selectFrom('product_variants').select(['sale_price', 'compare_at_price', 'cost_price'])
      .where('id', '=', sku.id).executeTakeFirstOrThrow()
    expect(dbPrice).toEqual({ sale_price: '0.00000', compare_at_price: '9.99000', cost_price: '1.23456' })
    await expect(db.updateTable('product_variants').set({ compare_at_price: '0.00000' })
      .where('id', '=', sku.id).execute()).rejects.toMatchObject({
      code: '23514', constraint: 'product_variants_compare_at_price_check',
    })
    await expect(db.updateTable('product_variants').set({ cost_price: '-0.00001' })
      .where('id', '=', sku.id).execute()).rejects.toMatchObject({
      code: '23514', constraint: 'product_variants_cost_price_check',
    })

    const otherPrice = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/variants/${otherSku.id}/prices`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(otherPrice.json<{ data: { salePrice: string } }>().data.salePrice).toBe('129.00')
    const productRead = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie } })
    expect(JSON.stringify(productRead.json())).not.toContain('costPrice')
    const inventoryBeforePrice = await db.selectFrom('product_variants').select('inventory_revision')
      .where('id', '=', sku.id).executeTakeFirstOrThrow()
    expect(inventoryBeforePrice.inventory_revision).toBe(0)

    for (const invalid of ['1.001', '-0.01', '1e2', '10000000000000.00']) {
      const response = await patchSkuPrices(auth, product.id, sku.id, {
        expectedRevision: savedPrice.productRevision,
        expectedSkuRevision: savedPrice.skuRevision,
        salePrice: invalid,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('VALIDATION_ERROR')
    }
    for (const invalid of ['-0.01', '1.000001', '1e2', '10000000000000.00000']) {
      const response = await patchSkuPrices(auth, product.id, sku.id, {
        expectedRevision: savedPrice.productRevision,
        expectedSkuRevision: savedPrice.skuRevision,
        costPrice: invalid,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('VALIDATION_ERROR')
    }
    const invalidComparePrecision = await patchSkuPrices(auth, product.id, sku.id, {
      expectedRevision: savedPrice.productRevision,
      expectedSkuRevision: savedPrice.skuRevision,
      compareAtPrice: '1.001',
    })
    expect(invalidComparePrecision.statusCode).toBe(400)
    expect(invalidComparePrecision.json().error.code).toBe('VALIDATION_ERROR')
    const falseDiscount = await patchSkuPrices(auth, product.id, sku.id, {
      expectedRevision: savedPrice.productRevision,
      expectedSkuRevision: savedPrice.skuRevision,
      compareAtPrice: '0.00',
    })
    expect(falseDiscount.statusCode).toBe(400)
    expect(falseDiscount.json().error.code).toBe('INVALID_COMPARE_AT_PRICE')

    const cleared = await patchSkuPrices(auth, product.id, sku.id, {
      expectedRevision: savedPrice.productRevision,
      expectedSkuRevision: savedPrice.skuRevision,
      compareAtPrice: null,
      costPrice: null,
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().data).toMatchObject({ salePrice: '0.00', compareAtPrice: null, costPrice: null })
    const staleProduct = await patchSkuPrices(auth, product.id, sku.id, {
      expectedRevision: savedPrice.productRevision,
      expectedSkuRevision: cleared.json<{ data: { skuRevision: number } }>().data.skuRevision,
      salePrice: '1.00',
    })
    expect(staleProduct.statusCode).toBe(409)
    expect(staleProduct.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
  })

  it('does not permit repricing a permanently retired SKU', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '退役 SKU 价格')
    const retiredSku = product.variants[0]!
    const valueId = randomUUID()
    const saved = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('版本', randomUUID(), [{ id: valueId, name: '正式版' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '20.00', enabled: true }],
      retireSkuIds: [retiredSku.id],
    })
    expect(saved.statusCode).toBe(200)
    const savedProduct = saved.json<{ data: { product: ProductDetail } }>().data.product
    const retired = savedProduct.variants.find((variant) => variant.id === retiredSku.id)!
    const response = await patchSkuPrices(auth, product.id, retired.id, {
      expectedRevision: savedProduct.revision,
      expectedSkuRevision: retired.revision,
      salePrice: '1.00',
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('SKU_PERMANENTLY_RETIRED')
  })

  it('enforces existing compare-at prices in matrix preview and save without overwriting optional prices', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '规格矩阵沿用划线价约束')
    const sku = product.variants[0]!
    const initialPrices = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/prices`,
      headers: { cookie: auth.sessionCookie },
    })
    const price = initialPrices.json<{ data: { productRevision: number; skuRevision: number } }>().data
    const configured = await patchSkuPrices(auth, product.id, sku.id, {
      expectedRevision: price.productRevision,
      expectedSkuRevision: price.skuRevision,
      salePrice: '19.90',
      compareAtPrice: '29.90',
      costPrice: '4.44444',
    })
    expect(configured.statusCode).toBe(200)
    const configuredPrice = configured.json<{ data: { productRevision: number; skuRevision: number } }>().data
    const excessive = {
      expectedRevision: configuredPrice.productRevision,
      mode: 'selected',
      groups: [],
      combinations: [{ skuId: sku.id, optionValueIds: [], salePrice: '39.90', enabled: true }],
    }
    const invalidPreview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: excessive,
    })
    expect(invalidPreview.statusCode).toBe(400)
    expect(invalidPreview.json().error.code).toBe('INVALID_COMPARE_AT_PRICE')
    const invalidSave = await saveMatrix(auth, product.id, excessive)
    expect(invalidSave.statusCode).toBe(400)
    expect(invalidSave.json().error.code).toBe('INVALID_COMPARE_AT_PRICE')

    const afterRejectedSave = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/prices`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(afterRejectedSave.json().data).toMatchObject({
      salePrice: '19.90', compareAtPrice: '29.90', costPrice: '4.44444',
    })
    expect(afterRejectedSave.json().data.productRevision).toBe(configuredPrice.productRevision)

    const legal = { ...excessive, expectedRevision: configuredPrice.productRevision, combinations: [
      { skuId: sku.id, optionValueIds: [], salePrice: '24.90', enabled: true },
    ] }
    const legalPreview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: legal,
    })
    expect(legalPreview.statusCode).toBe(200)
    const legalSave = await saveMatrix(auth, product.id, legal)
    expect(legalSave.statusCode).toBe(200)
    const finalPrices = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/prices`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(finalPrices.json().data).toMatchObject({ salePrice: '24.90', compareAtPrice: '29.90', costPrice: '4.44444' })
  })

  it('uses separate quantity inventory revisions, reserved boundaries, idempotency, and truthful mode states', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, 'D3 库存边界')
    const sku = product.variants[0]!
    const initialSummary = await getInventorySummary(auth, product.id)
    expect(initialSummary.statusCode).toBe(200)
    expect(initialSummary.json().data.variants[0].inventory).toMatchObject({
      mode: null, configured: false, hasTrustedQuantity: false, stocked: null, reserved: null,
      available: null, sufficient: null, sourceReady: false, status: 'not_configured',
    })

    const unauthenticatedAdjust = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/inventory/adjustments`,
      payload: { expectedInventoryRevision: 0, operationId: randomUUID(), action: 'increase', quantity: 1, reason: '未授权' },
    })
    expect(unauthenticatedAdjust.statusCode).toBe(401)
    const noCsrf = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision, expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    }, false)
    expect(noCsrf.statusCode).toBe(403)
    const noAdjustmentCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/inventory/adjustments`,
      headers: { cookie: `${auth.sessionCookie}; ${auth.csrf.cookie}`, origin: testOrigin },
      payload: { expectedInventoryRevision: 0, operationId: randomUUID(), action: 'increase', quantity: 1, reason: '缺少 CSRF' },
    })
    expect(noAdjustmentCsrf.statusCode).toBe(403)

    const quantityMode = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    expect(quantityMode.statusCode).toBe(200)
    let modeState = quantityMode.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number; inventory: Record<string, unknown> } }>().data
    expect(modeState.inventory).toMatchObject({ mode: 'quantity', stocked: 0, reserved: 0, available: 0, sufficient: false, sourceReady: true, status: 'ready' })
    expect(modeState.inventoryRevision).toBe(1)

    const operationId = randomUUID()
    const increaseBody = {
      expectedInventoryRevision: modeState.inventoryRevision,
      operationId,
      action: 'increase',
      quantity: 100,
      reason: '首批入库',
    }
    const increased = await adjustInventory(auth, product.id, sku.id, increaseBody)
    expect(increased.statusCode).toBe(201)
    const adjustment = increased.json<{ data: { id: string; quantityBefore: number; quantityAfter: number; quantityDelta: number; inventoryRevision: number } }>().data
    expect(adjustment).toMatchObject({ quantityBefore: 0, quantityAfter: 100, quantityDelta: 100, inventoryRevision: 2 })
    const duplicate = await adjustInventory(auth, product.id, sku.id, increaseBody)
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().data).toEqual(adjustment)
    const reusedOperation = await adjustInventory(auth, product.id, sku.id, { ...increaseBody, quantity: 99 })
    expect(reusedOperation.statusCode).toBe(409)
    expect(reusedOperation.json().error.code).toBe('INVENTORY_OPERATION_ID_CONFLICT')

    const decreased = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: adjustment.inventoryRevision,
      operationId: randomUUID(), action: 'decrease', quantity: 10, reason: '盘点扣减',
    })
    expect(decreased.statusCode).toBe(201)
    const afterDecrease = decreased.json<{ data: { inventoryRevision: number } }>().data
    const firstReservedOrderId = await createReservedOrderForTest(auth, product.id, sku.id, 10)
    modeState.productRevision = (await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })).json<{ data: ProductDetail }>().data.revision
    const firstReservedRevision = await db.selectFrom('product_variants').select('inventory_revision')
      .where('id', '=', sku.id).executeTakeFirstOrThrow()
    const pauseAfterReservation = await changeProductLifecycle(auth, product.id, {
      expectedRevision: modeState.productRevision, status: 'paused',
    })
    expect(pauseAfterReservation.statusCode).toBe(200)
    modeState.productRevision = pauseAfterReservation.json<{ data: ProductDetail }>().data.revision
    await expect(db.updateTable('product_variant_quantity_inventory').set({ reserved: 91 })
      .where('product_variant_id', '=', sku.id).execute()).rejects.toMatchObject({
      code: '23514', constraint: 'inventory_reserved_requires_order_event',
    })
    const blockedByReservation = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: modeState.productRevision,
      expectedSkuRevision: modeState.skuRevision,
      expectedInventoryRevision: firstReservedRevision.inventory_revision,
      inventoryMode: 'external',
    })
    expect(blockedByReservation.statusCode).toBe(409)
    expect(blockedByReservation.json().error.code).toBe('INVENTORY_MODE_SWITCH_BLOCKED')
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', firstReservedOrderId).execute()
    await expect(db.updateTable('product_variant_quantity_inventory').set({ stocked: -1 })
      .where('product_variant_id', '=', sku.id).execute()).rejects.toMatchObject({
      code: '23514',
    })
    const secondReservedOrderId = await createReservedOrderForTest(auth, product.id, sku.id, 10)
    modeState.productRevision = (await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })).json<{ data: ProductDetail }>().data.revision
    const secondReservedRevision = await db.selectFrom('product_variants').select('inventory_revision')
      .where('id', '=', sku.id).executeTakeFirstOrThrow()
    const pauseWithSecondReservation = await changeProductLifecycle(auth, product.id, {
      expectedRevision: modeState.productRevision, status: 'paused',
    })
    expect(pauseWithSecondReservation.statusCode).toBe(200)
    modeState.productRevision = pauseWithSecondReservation.json<{ data: ProductDetail }>().data.revision
    const belowReserved = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: secondReservedRevision.inventory_revision,
      operationId: randomUUID(), action: 'decrease', quantity: 81, reason: '超出可售库存',
    })
    expect(belowReserved.statusCode).toBe(409)
    expect(belowReserved.json().error.code).toBe('STOCK_BELOW_RESERVED_QUANTITY')
    const setBelowReserved = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: secondReservedRevision.inventory_revision,
      operationId: randomUUID(), action: 'set', quantity: 9, reason: '错误目标值',
    })
    expect(setBelowReserved.statusCode).toBe(409)
    const overflow = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: secondReservedRevision.inventory_revision,
      operationId: randomUUID(), action: 'increase', quantity: 2_147_483_647, reason: '超范围补货',
    })
    expect(overflow.statusCode).toBe(400)
    expect(overflow.json().error.code).toBe('INVENTORY_QUANTITY_OUT_OF_RANGE')
    const invalidInteger = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: secondReservedRevision.inventory_revision,
      operationId: randomUUID(), action: 'increase', quantity: 2_147_483_648, reason: '超过整数上限',
    })
    expect(invalidInteger.statusCode).toBe(400)
    expect(invalidInteger.json().error.code).toBe('VALIDATION_ERROR')

    const atReserved = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: secondReservedRevision.inventory_revision,
      operationId: randomUUID(), action: 'decrease', quantity: 80, reason: '保留预留数量',
    })
    expect(atReserved.statusCode).toBe(201)
    const afterReserved = atReserved.json<{ data: { inventoryRevision: number } }>().data
    const reservedSummary = await getInventorySummary(auth, product.id, 11)
    expect(reservedSummary.json().data.variants[0].inventory).toMatchObject({
      mode: 'quantity', stocked: 10, reserved: 10, available: 0, sufficient: false,
    })
    await expect(db.updateTable('product_variants').set({ inventory_mode: 'unlimited' })
      .where('id', '=', sku.id).execute()).rejects.toMatchObject({
      code: '23514', constraint: 'product_variant_quantity_state_consistent',
    })

    const productAfterStock = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie } })
    const skuAfterStock = productAfterStock.json<{ data: ProductDetail }>().data.variants[0]!
    expect(productAfterStock.json().data.revision).toBe(modeState.productRevision)
    expect(skuAfterStock.revision).toBe(modeState.skuRevision)
    const staleRevision = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: afterDecrease.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 1, reason: '旧库存版本',
    })
    expect(staleRevision.statusCode).toBe(409)
    expect(staleRevision.json().error.code).toBe('INVENTORY_REVISION_CONFLICT')

    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', secondReservedOrderId).execute()
    const afterRelease = await db.selectFrom('product_variants').select('inventory_revision')
      .where('id', '=', sku.id).executeTakeFirstOrThrow()
    const drained = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: afterRelease.inventory_revision,
      operationId: randomUUID(), action: 'decrease', quantity: 10, reason: '清空库存',
    })
    expect(drained.statusCode).toBe(201)
    modeState = {
      ...modeState,
      inventoryRevision: drained.json<{ data: { inventoryRevision: number } }>().data.inventoryRevision,
    }
    const setMode = async (
      nextMode: 'quantity' | 'resource_pool' | 'unlimited' | 'external' | null,
      current: { productRevision: number; skuRevision: number; inventoryRevision: number },
    ) => setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: current.productRevision,
      expectedSkuRevision: current.skuRevision,
      expectedInventoryRevision: current.inventoryRevision,
      inventoryMode: nextMode,
    })

    const toPool = await setMode('resource_pool', modeState)
    expect(toPool.statusCode).toBe(200)
    modeState = toPool.json().data
    expect(modeState.inventory).toMatchObject({ mode: 'resource_pool', stocked: null, reserved: null, available: null, sufficient: null, sourceReady: false, status: 'not_ready' })
    const noFakePoolAdjustment = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: modeState.inventoryRevision, operationId: randomUUID(),
      action: 'increase', quantity: 5, reason: '不支持资源池手工库存',
    })
    expect(noFakePoolAdjustment.statusCode).toBe(409)
    expect(noFakePoolAdjustment.json().error.code).toBe('INVENTORY_MODE_CONFLICT')

    for (const [nextMode, expected] of [
      ['unlimited', { sufficient: true, sourceReady: true, status: 'ready' }],
      ['external', { sufficient: null, sourceReady: false, status: 'not_ready' }],
      [null, { sufficient: null, sourceReady: false, status: 'not_configured' }],
      ['quantity', { stocked: 0, reserved: 0, available: 0, sourceReady: true, status: 'ready' }],
    ] as const) {
      const changed = await setMode(nextMode, modeState)
      expect(changed.statusCode).toBe(200)
      modeState = changed.json().data
      expect(modeState.inventory).toMatchObject(expected)
    }
    expect(modeState.inventoryRevision).toBeGreaterThan(afterReserved.inventoryRevision)

    const history = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/inventory/adjustments?limit=2`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(history.statusCode).toBe(200)
    const historyPage = history.json<{ data: { adjustments: Array<{ id: string; quantityAfter: number }>; nextCursor: { createdAt: string; id: string } | null } }>().data
    expect(historyPage.adjustments).toHaveLength(2)
    expect(historyPage.nextCursor).toBeTruthy()
    const pageTwo = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/inventory/adjustments?limit=2&beforeCreatedAt=${encodeURIComponent(historyPage.nextCursor!.createdAt)}&beforeId=${historyPage.nextCursor!.id}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(pageTwo.statusCode).toBe(200)
    expect(pageTwo.json().data.adjustments).toHaveLength(2)
    expect(pageTwo.json().data.adjustments.map((row: { id: string }) => row.id).some((id: string) => historyPage.adjustments.some((row) => row.id === id))).toBe(false)
    await expect(db.updateTable('product_variant_inventory_adjustments').set({ reason: '改写历史' }).where('id', '=', adjustment.id).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'product_variant_inventory_adjustments_immutable' })
    await expect(db.deleteFrom('product_variant_inventory_adjustments').where('id', '=', adjustment.id).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'product_variant_inventory_adjustments_immutable' })

    const refilled = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: modeState.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 1, reason: '验证停用与库存状态独立',
    })
    expect(refilled.statusCode).toBe(201)
    const currentProduct = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie } })
    const productBeforePause = currentProduct.json<{ data: ProductDetail }>().data
    const skuBeforePause = productBeforePause.variants.find((variant) => variant.id === sku.id)!
    const paused = await saveMatrix(auth, product.id, {
      expectedRevision: productBeforePause.revision,
      mode: 'selected', groups: [],
      combinations: [{ skuId: sku.id, optionValueIds: [], salePrice: skuBeforePause.salePrice, enabled: false }],
    })
    expect(paused.statusCode).toBe(200)
    const disabledAndInStock = await getInventorySummary(auth, product.id, 1)
    expect(disabledAndInStock.json().data.variants[0]).toMatchObject({
      enabled: false,
      inventory: { mode: 'quantity', stocked: 1, available: 1, sufficient: true },
    })
  })

  it('allows disabling and re-enabling an in-stock SKU without retiring or changing its quantity', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '有库存 SKU 临时停用')
    const sku = product.variants[0]!
    const configured = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const mode = configured.json<{ data: { productRevision: number; inventoryRevision: number } }>().data
    const stocked = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: mode.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 3, reason: '临时停用状态测试库存',
    })
    expect(stocked.statusCode).toBe(201)
    const productAfterStock = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    const current = productAfterStock.json<{ data: ProductDetail }>().data
    const currentSku = current.variants.find((variant) => variant.id === sku.id)!
    const paused = await saveMatrix(auth, product.id, {
      expectedRevision: current.revision,
      mode: 'selected', groups: [],
      combinations: [{ skuId: sku.id, optionValueIds: [], salePrice: currentSku.salePrice, enabled: false }],
    })
    expect(paused.statusCode).toBe(200)
    const pausedSku = paused.json<{ data: { product: ProductDetail } }>().data.product.variants.find((variant) => variant.id === sku.id)!
    expect(pausedSku).toMatchObject({ enabled: false, retiredAt: null })
    expect((await getInventorySummary(auth, product.id)).json().data.variants[0].inventory)
      .toMatchObject({ stocked: 3, reserved: 0, available: 3 })

    const resumed = await saveMatrix(auth, product.id, {
      expectedRevision: paused.json<{ data: { product: ProductDetail } }>().data.product.revision,
      mode: 'selected', groups: [],
      combinations: [{ skuId: sku.id, optionValueIds: [], salePrice: currentSku.salePrice, enabled: true }],
    })
    expect(resumed.statusCode).toBe(200)
    const resumedSku = resumed.json<{ data: { product: ProductDetail } }>().data.product.variants.find((variant) => variant.id === sku.id)!
    expect(resumedSku).toMatchObject({ enabled: true, retiredAt: null })
    expect((await getInventorySummary(auth, product.id)).json().data.variants[0].inventory)
      .toMatchObject({ stocked: 3, reserved: 0, available: 3 })
  })

  it('prevents permanent retirement while quantity is reserved and marks that reason in matrix preview', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '预留阻止 SKU 退役')
    const sku = product.variants[0]!
    const configured = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision, expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const mode = configured.json<{ data: { productRevision: number; inventoryRevision: number } }>().data
    expect((await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: mode.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 4, reason: '预留测试库存',
    })).statusCode).toBe(201)
    await createReservedOrderForTest(auth, product.id, sku.id, 2)
    const current = (await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })).json<{ data: ProductDetail }>().data
    const paused = await changeProductLifecycle(auth, product.id, { expectedRevision: current.revision, status: 'paused' })
    expect(paused.statusCode).toBe(200)
    const pausedProduct = paused.json<{ data: ProductDetail }>().data

    const groupId = randomUUID()
    const valueId = randomUUID()
    const retirement = {
      expectedRevision: pausedProduct.revision,
      mode: 'selected',
      groups: [optionGroup('替代方案', groupId, [{ id: valueId, name: '新方案' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '8.00', enabled: true }],
      retireSkuIds: [sku.id],
    }
    const preview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: retirement,
    })
    const retireChange = preview.json().data.changes.find((change: { skuId: string; change: string }) => change.skuId === sku.id && change.change === 'retired')
    expect(retireChange).toMatchObject({ retirementBlocked: true, retirementBlockReason: 'reserved_quantity' })
    const rejected = await saveMatrix(auth, product.id, retirement)
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json().error.code).toBe('SKU_STOCK_RESERVED')
    await expect(db.updateTable('product_variants').set({ enabled: false, retired_at: new Date() })
      .where('id', '=', sku.id).execute()).rejects.toMatchObject({
      code: '23514', constraint: 'product_variant_retirement_reserved_check',
    })
    expect(await db.selectFrom('product_variants').select('retired_at').where('id', '=', sku.id).executeTakeFirstOrThrow())
      .toEqual({ retired_at: null })
    expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', sku.id).executeTakeFirstOrThrow()).toEqual({ stocked: 4, reserved: 2 })
  })

  it('blocks inventory table TRUNCATE and TRUNCATE CASCADE without removing SKU or audit data', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '库存表禁止 TRUNCATE')
    const sku = product.variants[0]!
    const configured = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision, expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const mode = configured.json<{ data: { inventoryRevision: number } }>().data
    await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: mode.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 1, reason: 'TRUNCATE 保护流水',
    })

    await expect(sql`TRUNCATE TABLE product_variant_inventory_adjustments`.execute(db)).rejects.toMatchObject({
      code: '23514', constraint: 'product_variant_inventory_adjustments_truncate_forbidden',
    })
    await expect(sql`TRUNCATE TABLE product_variant_quantity_inventory`.execute(db)).rejects.toMatchObject({
      code: '23514', constraint: 'product_variant_quantity_inventory_truncate_forbidden',
    })
    await expect(sql`TRUNCATE TABLE product_variants CASCADE`.execute(db)).rejects.toMatchObject({ code: '23514' })
    expect(await db.selectFrom('product_variants').select('id').where('id', '=', sku.id).execute()).toHaveLength(1)
    expect(await db.selectFrom('product_variant_quantity_inventory').select('stocked')
      .where('product_variant_id', '=', sku.id).executeTakeFirstOrThrow()).toEqual({ stocked: 1 })
    expect(await db.selectFrom('product_variant_inventory_adjustments').select('id')
      .where('product_variant_id', '=', sku.id).execute()).toHaveLength(1)
  })

  it('serializes quantity adjustment and permanent retirement without leaving a retired in-stock SKU', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '库存调整与退役并发')
    const sku = product.variants[0]!
    const configured = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision, expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const mode = configured.json<{ data: { productRevision: number; inventoryRevision: number } }>().data
    const groupId = randomUUID()
    const valueId = randomUUID()
    const retirement = {
      expectedRevision: mode.productRevision,
      mode: 'selected',
      groups: [optionGroup('后续规格', groupId, [{ id: valueId, name: '替换 SKU' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '8.00', enabled: true }],
      retireSkuIds: [sku.id],
    }
    const [adjustment, matrixSave] = await Promise.all([
      adjustInventory(auth, product.id, sku.id, {
        expectedInventoryRevision: mode.inventoryRevision,
        operationId: randomUUID(), action: 'increase', quantity: 1, reason: '与永久退役竞争',
      }),
      saveMatrix(auth, product.id, retirement),
    ])
    expect([adjustment.statusCode, matrixSave.statusCode].filter((status) => status === 409)).toHaveLength(1)
    expect([adjustment.statusCode, matrixSave.statusCode].filter((status) => status >= 200 && status < 300)).toHaveLength(1)
    const finalSummary = await getInventorySummary(auth, product.id)
    const finalSku = finalSummary.json().data.variants.find((variant: { skuId: string }) => variant.skuId === sku.id)
    if (matrixSave.statusCode === 200) {
      expect(finalSku).toMatchObject({ retiredAt: expect.any(String), inventory: { stocked: 0, reserved: 0 } })
      expect(adjustment.json().error.code).toBe('SKU_PERMANENTLY_RETIRED')
    } else {
      expect(finalSku).toMatchObject({ retiredAt: null, inventory: { stocked: 1, reserved: 0 } })
      expect(matrixSave.json().error.code).toBe('SKU_STOCK_NOT_CLEARED')
    }
  })

  it('serializes concurrent inventory adjustments without lost updates or negative stock', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '并发库存调整')
    const sku = product.variants[0]!
    const modeResponse = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision, expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const mode = modeResponse.json<{ data: { inventoryRevision: number } }>().data
    const makeIncrease = () => ({
      expectedInventoryRevision: mode.inventoryRevision, operationId: randomUUID(),
      action: 'increase', quantity: 10, reason: '并发补货',
    })
    const concurrent = [makeIncrease(), makeIncrease()]
    const results = await Promise.all(concurrent.map((body) => adjustInventory(auth, product.id, sku.id, body)))
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409])
    const stale = results.find((result) => result.statusCode === 409)!
    expect(stale.json().error.code).toBe('INVENTORY_REVISION_CONFLICT')
    const summary = await getInventorySummary(auth, product.id)
    expect(summary.json().data.variants[0].inventory.stocked).toBe(10)

    const currentRevision = summary.json().data.variants[0].inventoryRevision as number
    const retry = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: currentRevision, operationId: randomUUID(),
      action: 'increase', quantity: 10, reason: '并发补货重试',
    })
    expect(retry.statusCode).toBe(201)
    const beforeDecreases = await getInventorySummary(auth, product.id)
    const revision = beforeDecreases.json().data.variants[0].inventoryRevision as number
    const concurrentDecreases = await Promise.all([1, 2].map(() => adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: revision, operationId: randomUUID(),
      action: 'decrease', quantity: 15, reason: '并发扣减',
    })))
    expect(concurrentDecreases.map((result) => result.statusCode).sort()).toEqual([201, 409])
    const after = await getInventorySummary(auth, product.id)
    expect(after.json().data.variants[0].inventory.stocked).toBe(5)
    expect(after.json().data.variants[0].inventory.available).toBe(5)
    expect(after.json().data.variants[0].inventory.stocked).toBeGreaterThanOrEqual(0)

    const concurrentRetry = {
      expectedInventoryRevision: after.json().data.variants[0].inventoryRevision as number,
      operationId: randomUUID(), action: 'increase', quantity: 2, reason: '并发幂等补货',
    }
    const retries = await Promise.all([
      adjustInventory(auth, product.id, sku.id, concurrentRetry),
      adjustInventory(auth, product.id, sku.id, concurrentRetry),
    ])
    expect(retries.map((result) => result.statusCode).sort()).toEqual([200, 201])
    expect(retries[0]!.json().data.id).toBe(retries[1]!.json().data.id)
    const afterRetry = await getInventorySummary(auth, product.id)
    expect(afterRetry.json().data.variants[0].inventory.stocked).toBe(7)
  })

  it('does not deadlock when a quantity adjustment races an inventory mode switch', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '模式切换与库存调整并发')
    const sku = product.variants[0]!
    const configured = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const version = configured.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number } }>().data
    const [adjustment, modeSwitch] = await Promise.all([
      adjustInventory(auth, product.id, sku.id, {
        expectedInventoryRevision: version.inventoryRevision,
        operationId: randomUUID(), action: 'increase', quantity: 1, reason: '模式切换并发补货',
      }),
      setInventoryMode(auth, product.id, sku.id, {
        expectedRevision: version.productRevision,
        expectedSkuRevision: version.skuRevision,
        expectedInventoryRevision: version.inventoryRevision,
        inventoryMode: 'unlimited',
      }),
    ])
    expect([adjustment.statusCode, modeSwitch.statusCode].filter((status) => status === 409)).toHaveLength(1)
    expect([adjustment.statusCode, modeSwitch.statusCode].filter((status) => status >= 200 && status < 300)).toHaveLength(1)

    const summary = await getInventorySummary(auth, product.id)
    const inventory = summary.json().data.variants[0].inventory
    if (modeSwitch.statusCode === 200) {
      expect(inventory).toMatchObject({ mode: 'unlimited', stocked: null, available: null, sourceReady: true })
      expect(await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
        .where('product_variant_id', '=', sku.id).executeTakeFirst()).toBeUndefined()
      expect(adjustment.json().error.code).toBe('INVENTORY_MODE_CONFLICT')
    } else {
      expect(inventory).toMatchObject({ mode: 'quantity', stocked: 1, available: 1 })
      expect(modeSwitch.json().error.code).toBe('INVENTORY_REVISION_CONFLICT')
    }
  })

  it('protects inventory history from matrix deletion and preserves SKU ownership through specification edits', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '库存引用阻止规格误删')
    const legacySku = product.variants[0]!
    const mode = await setInventoryMode(auth, product.id, legacySku.id, {
      expectedRevision: product.revision, expectedSkuRevision: legacySku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const inventoryMode = mode.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number } }>().data
    const adjustment = await adjustInventory(auth, product.id, legacySku.id, {
      expectedInventoryRevision: inventoryMode.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 5, reason: '有意义的库存历史',
    })
    expect(adjustment.statusCode).toBe(201)
    const groupId = randomUUID()
    const valueId = randomUUID()
    const body = {
      expectedRevision: inventoryMode.productRevision,
      mode: 'selected',
      groups: [optionGroup('版本', groupId, [{ id: valueId, name: '当前版' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '20.00', enabled: true }],
    }
    const preview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: body,
    })
    expect(preview.statusCode).toBe(200)
    const removal = preview.json().data.changes.find((change: { skuId: string; change: string }) => change.skuId === legacySku.id && change.change === 'removed')
    expect(removal).toMatchObject({ inventoryMutationBlocked: true, inventoryMutationBlockReason: 'adjustment_history' })
    const blocked = await saveMatrix(auth, product.id, body)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('SKU_HAS_REFERENCES')

    const retirementBody = { ...body, retireSkuIds: [legacySku.id] }
    const retirementPreview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: retirementBody,
    })
    expect(retirementPreview.statusCode).toBe(200)
    const retirementChange = retirementPreview.json().data.changes.find((change: { skuId: string; change: string }) => change.skuId === legacySku.id && change.change === 'retired')
    expect(retirementChange).toMatchObject({ retirementBlocked: true, retirementBlockReason: 'stocked_quantity' })
    const stockedRetirement = await saveMatrix(auth, product.id, retirementBody)
    expect(stockedRetirement.statusCode).toBe(409)
    expect(stockedRetirement.json().error.code).toBe('SKU_STOCK_NOT_CLEARED')
    await expect(db.updateTable('product_variants').set({ enabled: false, retired_at: new Date() })
      .where('id', '=', legacySku.id).execute()).rejects.toMatchObject({
      code: '23514', constraint: 'product_variant_retirement_stocked_check',
    })
    const stillActive = await db.selectFrom('product_variants').select(['retired_at', 'enabled'])
      .where('id', '=', legacySku.id).executeTakeFirstOrThrow()
    expect(stillActive).toEqual({ retired_at: null, enabled: true })

    const drained = await adjustInventory(auth, product.id, legacySku.id, {
      expectedInventoryRevision: inventoryMode.inventoryRevision + 1,
      operationId: randomUUID(), action: 'decrease', quantity: 5, reason: '永久退役前清零库存',
    })
    expect(drained.statusCode).toBe(201)
    const retired = await saveMatrix(auth, product.id, retirementBody)
    expect(retired.statusCode).toBe(200)
    const retiredProduct = retired.json<{ data: { product: ProductDetail } }>().data.product
    expect(retiredProduct.variants.find((variant) => variant.id === legacySku.id)).toMatchObject({ retiredAt: expect.any(String), enabled: false })
    const afterRetirement = await getInventorySummary(auth, product.id)
    expect(afterRetirement.json().data.variants.find((variant: { skuId: string }) => variant.skuId === legacySku.id).inventory)
      .toMatchObject({ stocked: 0, reserved: 0, available: 0 })
    expect(await db.selectFrom('product_variant_inventory_adjustments').select('id')
      .where('product_variant_id', '=', legacySku.id).execute()).toHaveLength(2)
    const retiredAdjustment = await adjustInventory(auth, product.id, legacySku.id, {
      expectedInventoryRevision: inventoryMode.inventoryRevision + 2,
      operationId: randomUUID(), action: 'increase', quantity: 1, reason: '退役后不得补货',
    })
    expect(retiredAdjustment.statusCode).toBe(409)
    expect(retiredAdjustment.json().error.code).toBe('SKU_PERMANENTLY_RETIRED')
  })

  it('allows safe deletion of an empty quantity record and rejects inventory identity remapping', async () => {
    const auth = await loginAdmin()
    const emptyProduct = await createTestProduct(auth, '空库存 SKU 可安全删除')
    const emptySku = emptyProduct.variants[0]!
    const quantityMode = await setInventoryMode(auth, emptyProduct.id, emptySku.id, {
      expectedRevision: emptyProduct.revision, expectedSkuRevision: emptySku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const modeData = quantityMode.json<{ data: { productRevision: number } }>().data
    const valueId = randomUUID()
    const groupId = randomUUID()
    const removed = await saveMatrix(auth, emptyProduct.id, {
      expectedRevision: modeData.productRevision,
      mode: 'selected',
      groups: [optionGroup('类型', groupId, [{ id: valueId, name: '数字版' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '5.00', enabled: true }],
    })
    expect(removed.statusCode).toBe(200)
    expect(await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
      .where('product_variant_id', '=', emptySku.id).execute()).toEqual([])

    const product = await createTestProduct(auth, '规格库存身份稳定')
    const group = randomUUID()
    const alpha = randomUUID()
    const beta = randomUUID()
    const created = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('方案', group, [{ id: alpha, name: '甲', sortOrder: 0 }, { id: beta, name: '乙', sortOrder: 1 }])],
      combinations: [
        { optionValueIds: [alpha], salePrice: '10.00', enabled: true },
        { optionValueIds: [beta], salePrice: '20.00', enabled: true },
      ],
    })
    const before = created.json<{ data: { product: ProductDetail } }>().data.product
    const alphaSku = before.variants.find((variant) => variant.options[0]?.valueId === alpha)!
    const betaSku = before.variants.find((variant) => variant.options[0]?.valueId === beta)!
    const alphaMode = await setInventoryMode(auth, product.id, alphaSku.id, {
      expectedRevision: before.revision, expectedSkuRevision: alphaSku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const alphaState = alphaMode.json<{ data: { inventoryRevision: number } }>().data
    expect((await adjustInventory(auth, product.id, alphaSku.id, {
      expectedInventoryRevision: alphaState.inventoryRevision, operationId: randomUUID(),
      action: 'increase', quantity: 3, reason: '绑定到甲规格',
    })).statusCode).toBe(201)

    const renamed = await saveMatrix(auth, product.id, {
      expectedRevision: alphaMode.json<{ data: { productRevision: number } }>().data.productRevision,
      mode: 'selected',
      groups: [optionGroup('方案名称已更新', group, [
        { id: alpha, name: '甲改名', sortOrder: 1 }, { id: beta, name: '乙改名', sortOrder: 0 },
      ])],
      combinations: [
        { skuId: alphaSku.id, optionValueIds: [alpha], salePrice: '10.00', enabled: true },
        { skuId: betaSku.id, optionValueIds: [beta], salePrice: '20.00', enabled: true },
      ],
    })
    expect(renamed.statusCode).toBe(200)
    const renamedProduct = renamed.json<{ data: { product: ProductDetail } }>().data.product
    const afterRename = await getInventorySummary(auth, product.id)
    expect(afterRename.json().data.variants.find((variant: { skuId: string }) => variant.skuId === alphaSku.id).inventory.stocked).toBe(3)
    expect(renamedProduct.variants.find((variant) => variant.id === alphaSku.id)?.options[0]?.valueId).toBe(alpha)

    const swap = {
      expectedRevision: renamedProduct.revision,
      mode: 'selected',
      groups: [optionGroup('方案名称已更新', group, [
        { id: alpha, name: '甲改名', sortOrder: 1 }, { id: beta, name: '乙改名', sortOrder: 0 },
      ])],
      combinations: [
        { skuId: alphaSku.id, optionValueIds: [beta], salePrice: '10.00', enabled: true },
        { skuId: betaSku.id, optionValueIds: [alpha], salePrice: '20.00', enabled: true },
      ],
    }
    const swapPreview = await app.inject({
      method: 'POST', url: `/api/v1/admin/products/${product.id}/variant-matrix/preview`,
      headers: productHeaders(auth), payload: swap,
    })
    expect(swapPreview.statusCode).toBe(200)
    expect(swapPreview.json().data.changes.find((change: { skuId: string }) => change.skuId === alphaSku.id))
      .toMatchObject({ inventoryMutationBlocked: true, inventoryMutationBlockReason: 'adjustment_history' })
    const blockedSwap = await saveMatrix(auth, product.id, swap)
    expect(blockedSwap.statusCode).toBe(409)
    expect(blockedSwap.json().error.code).toBe('SKU_HAS_REFERENCES')
  })

  it('enforces the product lifecycle graph, permits unavailable products, and keeps state requests idempotent', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '生命周期商品')
    const sku = product.variants[0]!
    const quantityMode = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    expect(quantityMode.statusCode).toBe(200)
    const modeState = quantityMode.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number } }>().data
    const disabled = await saveMatrix(auth, product.id, {
      expectedRevision: modeState.productRevision,
      mode: 'selected',
      groups: [],
      combinations: [{ skuId: sku.id, optionValueIds: [], enabled: false }],
    })
    expect(disabled.statusCode).toBe(200)
    const draft = disabled.json<{ data: { product: ProductDetail } }>().data.product
    const publish = await changeProductLifecycle(auth, product.id, {
      expectedRevision: draft.revision, status: 'active',
    })
    expect(publish.statusCode).toBe(200)
    const active = publish.json<{ data: ProductDetail }>().data
    expect(active.status).toBe('active')
    expect(active.variants[0]).toMatchObject({ id: sku.id, skuCode: sku.skuCode, enabled: false })

    const inventory = await getInventorySummary(auth, product.id)
    expect(inventory.json().data.variants[0].inventory).toMatchObject({
      mode: 'quantity', stocked: 0, reserved: 0, available: 0, sufficient: false,
    })
    const beforeRepeat = await db.selectFrom('product_management_audit_events').select('id')
      .where('product_id', '=', product.id).execute()
    const repeated = await changeProductLifecycle(auth, product.id, {
      expectedRevision: active.revision, status: 'active',
    })
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json().data.revision).toBe(active.revision)
    expect(await db.selectFrom('product_management_audit_events').select('id')
      .where('product_id', '=', product.id).execute()).toEqual(beforeRepeat)

    const pausedResponse = await changeProductLifecycle(auth, product.id, {
      expectedRevision: active.revision, status: 'paused',
    })
    expect(pausedResponse.statusCode).toBe(200)
    const paused = pausedResponse.json<{ data: ProductDetail }>().data
    const relistedResponse = await changeProductLifecycle(auth, product.id, {
      expectedRevision: paused.revision, status: 'active',
    })
    expect(relistedResponse.statusCode).toBe(200)
    const relisted = relistedResponse.json<{ data: ProductDetail }>().data
    expect(relisted.status).toBe('active')

    const archiveResponse = await changeProductLifecycle(auth, product.id, {
      expectedRevision: relisted.revision, status: 'archived',
    })
    expect(archiveResponse.statusCode).toBe(200)
    const archived = archiveResponse.json<{ data: ProductDetail }>().data
    expect(archived.status).toBe('archived')
    expect(archived.variants[0]).toMatchObject({ id: sku.id, skuCode: sku.skuCode, enabled: false })
    const forbiddenPublish = await changeProductLifecycle(auth, product.id, {
      expectedRevision: archived.revision, status: 'active',
    })
    expect(forbiddenPublish.statusCode).toBe(409)
    expect(forbiddenPublish.json().error.code).toBe('PRODUCT_LIFECYCLE_TRANSITION_INVALID')
    const restoredResponse = await changeProductLifecycle(auth, product.id, {
      expectedRevision: archived.revision, status: 'draft',
    })
    expect(restoredResponse.statusCode).toBe(200)
    const restored = restoredResponse.json<{ data: ProductDetail }>().data
    expect(restored.status).toBe('draft')

    const history = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/history`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(history.statusCode).toBe(200)
    expect(history.json().data.events.map((event: { operation: string }) => event.operation)).toEqual([
      'restored', 'archived', 'relisted', 'paused', 'published', 'created',
    ])
    const anonymousHistory = await app.inject(`/api/v1/admin/products/${product.id}/history`)
    expect(anonymousHistory.statusCode).toBe(401)
    const firstHistoryPage = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/history?limit=2`,
      headers: { cookie: auth.sessionCookie },
    })
    const firstHistoryData = firstHistoryPage.json<{ data: { events: Array<{ id: string }>; nextCursor: { createdAt: string; id: string } | null } }>().data
    expect(firstHistoryData.events).toHaveLength(2)
    expect(firstHistoryData.nextCursor).not.toBeNull()
    const nextHistoryPage = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${product.id}/history?limit=2&beforeCreatedAt=${encodeURIComponent(firstHistoryData.nextCursor!.createdAt)}&beforeId=${firstHistoryData.nextCursor!.id}`,
      headers: { cookie: auth.sessionCookie },
    })
    const nextHistoryData = nextHistoryPage.json<{ data: { events: Array<{ id: string }>; nextCursor: { createdAt: string; id: string } | null } }>().data
    expect(nextHistoryData.events).toHaveLength(2)
    expect(nextHistoryData.events.some((event) => firstHistoryData.events.some((firstEvent) => firstEvent.id === event.id))).toBe(false)
    const partialCursor = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/history?beforeId=${firstHistoryData.nextCursor!.id}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(partialCursor.statusCode).toBe(400)
    const stateAfter = await db.selectFrom('product_variants').select(['enabled', 'inventory_mode', 'inventory_revision'])
      .where('id', '=', sku.id).executeTakeFirstOrThrow()
    expect(stateAfter).toMatchObject({ enabled: false, inventory_mode: 'quantity', inventory_revision: 1 })

    const invalid = await changeProductLifecycle(auth, product.id, {
      expectedRevision: restored.revision - 1, status: 'archived',
    })
    expect(invalid.statusCode).toBe(409)
    expect(invalid.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
    const unknownField = await changeProductLifecycle(auth, product.id, {
      expectedRevision: restored.revision, status: 'archived', surprise: true,
    })
    expect(unknownField.statusCode).toBe(400)
    const noCsrf = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/products/${product.id}/lifecycle`,
      headers: { cookie: auth.sessionCookie, origin: testOrigin },
      payload: { expectedRevision: restored.revision, status: 'archived' },
    })
    expect(noCsrf.statusCode).toBe(403)
  })

  it('edits only changed basic fields with revision protection and rejects unsafe product type changes', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '基础信息商品')
    const originalSku = product.variants[0]!
    const originalInventoryRevision = await db.selectFrom('product_variants').select('inventory_revision')
      .where('id', '=', originalSku.id).executeTakeFirstOrThrow()

    const edited = await editProduct(auth, product.id, {
      expectedRevision: product.revision,
      name: '  新名称  ',
      description: '更新后的基础描述',
      productType: 'physical',
    })
    expect(edited.statusCode).toBe(200)
    const updated = edited.json<{ data: ProductDetail }>().data
    expect(updated).toMatchObject({ id: product.id, name: '新名称', description: '更新后的基础描述', productType: 'physical' })
    expect(updated.revision).toBe(product.revision + 1)
    expect(updated.variants[0]).toMatchObject({ id: originalSku.id, skuCode: originalSku.skuCode, salePrice: originalSku.salePrice })
    expect(await db.selectFrom('product_variants').select(['sale_price', 'inventory_revision'])
      .where('id', '=', originalSku.id).executeTakeFirstOrThrow()).toEqual({
      sale_price: '19.90000', inventory_revision: originalInventoryRevision.inventory_revision,
    })
    const editHistory = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/history`, headers: { cookie: auth.sessionCookie },
    })
    expect(editHistory.statusCode).toBe(200)
    expect(editHistory.json().data.events[0]).toMatchObject({
      operation: 'updated',
      before: { description: product.description },
      after: { description: updated.description },
    })

    const auditBeforeNoop = await db.selectFrom('product_management_audit_events').select('id')
      .where('product_id', '=', product.id).execute()
    const noChange = await editProduct(auth, product.id, {
      expectedRevision: updated.revision,
      name: '新名称',
      description: '更新后的基础描述',
      productType: 'physical',
    })
    expect(noChange.statusCode).toBe(200)
    expect(noChange.json().data.revision).toBe(updated.revision)
    expect(await db.selectFrom('product_management_audit_events').select('id')
      .where('product_id', '=', product.id).execute()).toEqual(auditBeforeNoop)

    const blankName = await editProduct(auth, product.id, { expectedRevision: updated.revision, name: '   ' })
    expect(blankName.statusCode).toBe(400)
    expect(blankName.json().error.code).toBe('INVALID_PRODUCT_NAME')
    const invalidType = await editProduct(auth, product.id, { expectedRevision: updated.revision, productType: 'other' })
    expect(invalidType.statusCode).toBe(400)
    const unknown = await editProduct(auth, product.id, { expectedRevision: updated.revision, name: '应拒绝', internal: true })
    expect(unknown.statusCode).toBe(400)
    const stale = await editProduct(auth, product.id, { expectedRevision: product.revision, name: '旧修订覆盖' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
    const missingCsrf = await editProduct(auth, product.id, { expectedRevision: updated.revision, name: '无 CSRF' }, false)
    expect(missingCsrf.statusCode).toBe(403)

    const inventoryProduct = await createTestProduct(auth, '已配置库存的性质保护')
    const inventorySku = inventoryProduct.variants[0]!
    const mode = await setInventoryMode(auth, inventoryProduct.id, inventorySku.id, {
      expectedRevision: inventoryProduct.revision,
      expectedSkuRevision: inventorySku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const modeData = mode.json<{ data: { productRevision: number } }>().data
    const blockedTypeChange = await editProduct(auth, inventoryProduct.id, {
      expectedRevision: modeData.productRevision, productType: 'physical',
    })
    expect(blockedTypeChange.statusCode).toBe(409)
    expect(blockedTypeChange.json().error.code).toBe('PRODUCT_TYPE_CHANGE_BLOCKED')

    const historyProduct = await createTestProduct(auth, '性质修改库存历史保护')
    const historySku = historyProduct.variants[0]!
    const historyMode = await setInventoryMode(auth, historyProduct.id, historySku.id, {
      expectedRevision: historyProduct.revision,
      expectedSkuRevision: historySku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const historyModeData = historyMode.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number } }>().data
    const increase = await adjustInventory(auth, historyProduct.id, historySku.id, {
      expectedInventoryRevision: historyModeData.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 1, reason: '性质历史保护补货',
    })
    expect(increase.statusCode).toBe(201)
    const decrease = await adjustInventory(auth, historyProduct.id, historySku.id, {
      expectedInventoryRevision: historyModeData.inventoryRevision + 1,
      operationId: randomUUID(), action: 'decrease', quantity: 1, reason: '性质历史保护清零',
    })
    expect(decrease.statusCode).toBe(201)
    const unsetMode = await setInventoryMode(auth, historyProduct.id, historySku.id, {
      expectedRevision: historyModeData.productRevision,
      expectedSkuRevision: historyModeData.skuRevision,
      expectedInventoryRevision: historyModeData.inventoryRevision + 2,
      inventoryMode: null,
    })
    expect(unsetMode.statusCode).toBe(200)
    const historyBlockedTypeChange = await editProduct(auth, historyProduct.id, {
      expectedRevision: unsetMode.json<{ data: { productRevision: number } }>().data.productRevision,
      productType: 'service',
    })
    expect(historyBlockedTypeChange.statusCode).toBe(409)
    expect(historyBlockedTypeChange.json().error.code).toBe('PRODUCT_TYPE_CHANGE_BLOCKED')

    const publishedProduct = await createTestProduct(auth, '先下架再改性质')
    const published = await changeProductLifecycle(auth, publishedProduct.id, {
      expectedRevision: publishedProduct.revision, status: 'active',
    })
    const live = published.json<{ data: ProductDetail }>().data
    const activeTypeChange = await editProduct(auth, publishedProduct.id, {
      expectedRevision: live.revision, productType: 'service',
    })
    expect(activeTypeChange.statusCode).toBe(409)
    expect(activeTypeChange.json().error.code).toBe('PRODUCT_TYPE_CHANGE_REQUIRES_DRAFT_OR_PAUSED')
    const paused = await changeProductLifecycle(auth, publishedProduct.id, {
      expectedRevision: live.revision, status: 'paused',
    })
    const pausedProduct = paused.json<{ data: ProductDetail }>().data
    const safeTypeChange = await editProduct(auth, publishedProduct.id, {
      expectedRevision: pausedProduct.revision, productType: 'service',
    })
    expect(safeTypeChange.statusCode).toBe(200)
    expect(safeTypeChange.json().data.productType).toBe('service')
  })

  it('lists products with bounded stable pagination, filters, SKU search, and non-duplicating category summaries', async () => {
    const auth = await loginAdmin()
    const alpha = await createTestProduct(auth, 'D4 列表 Alpha')
    const beta = await app.inject({
      method: 'POST', url: '/api/v1/admin/products', headers: productHeaders(auth),
      payload: { ...productBody('D4 列表 Beta', '2.00'), productType: 'physical' },
    })
    const gamma = await app.inject({
      method: 'POST', url: '/api/v1/admin/products', headers: productHeaders(auth),
      payload: { ...productBody('D4 列表 Gamma', '5.00'), productType: 'digital' },
    })
    const delta = await app.inject({
      method: 'POST', url: '/api/v1/admin/products', headers: productHeaders(auth),
      payload: { ...productBody('D4 列表 Delta', '3.00'), productType: 'service' },
    })
    expect([beta.statusCode, gamma.statusCode, delta.statusCode]).toEqual([201, 201, 201])
    const betaProduct = beta.json<{ data: ProductDetail }>().data
    let gammaProduct = gamma.json<{ data: ProductDetail }>().data
    const deltaProduct = delta.json<{ data: ProductDetail }>().data
    const gammaGroupId = randomUUID()
    const gammaLowValueId = randomUUID()
    const gammaHighValueId = randomUUID()
    const gammaMatrix = await saveMatrix(auth, gammaProduct.id, {
      expectedRevision: gammaProduct.revision,
      mode: 'selected',
      groups: [optionGroup('D4 列表规格', gammaGroupId, [
        { id: gammaLowValueId, name: '低价 SKU' }, { id: gammaHighValueId, name: '高价 SKU' },
      ])],
      combinations: [
        { optionValueIds: [gammaLowValueId], salePrice: '3.00', enabled: true },
        { optionValueIds: [gammaHighValueId], salePrice: '7.00', enabled: true },
      ],
    })
    expect(gammaMatrix.statusCode).toBe(200)
    gammaProduct = gammaMatrix.json<{ data: { product: ProductDetail } }>().data.product
    const active = await changeProductLifecycle(auth, alpha.id, { expectedRevision: alpha.revision, status: 'active' })
    expect(active.statusCode).toBe(200)

    const categoryOne = await app.inject({ method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name: 'D4 列表分类一' } })
    const categoryTwo = await app.inject({ method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name: 'D4 列表分类二' } })
    const firstCategory = categoryOne.json<{ data: { id: string } }>().data
    const secondCategory = categoryTwo.json<{ data: { id: string } }>().data
    const categorized = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${gammaProduct.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: gammaProduct.revision, assignments: [
        { categoryId: firstCategory.id, isPrimary: true, sortOrder: 1 },
        { categoryId: secondCategory.id, isPrimary: false, sortOrder: 0 },
      ] },
    })
    expect(categorized.statusCode).toBe(200)

    const unauthorized = await app.inject('/api/v1/admin/products')
    expect(unauthorized.statusCode).toBe(401)
    const pageOne = await app.inject({
      method: 'GET', url: '/api/v1/admin/products?search=D4%20%E5%88%97%E8%A1%A8&page=1&pageSize=2&sortBy=price&sortOrder=asc',
      headers: { cookie: auth.sessionCookie },
    })
    expect(pageOne.statusCode).toBe(200)
    const firstPage = pageOne.json<{ data: { items: Array<{ id: string; skuCount: number; priceRange: { min: string; max: string; currency: string } | null; categories: unknown[] }>; page: number; pageSize: number; total: number; totalPages: number } }>().data
    expect(firstPage).toMatchObject({ page: 1, pageSize: 2, total: 4, totalPages: 2 })
    const tiedById = [gammaProduct.id, deltaProduct.id].sort((left, right) => left.localeCompare(right))
    expect(firstPage.items.map((item) => item.id)).toEqual([betaProduct.id, tiedById[0]])
    expect(firstPage.items.every((item) => !('costPrice' in item))).toBe(true)
    const pageTwo = await app.inject({
      method: 'GET', url: '/api/v1/admin/products?search=D4%20%E5%88%97%E8%A1%A8&page=2&pageSize=2&sortBy=price&sortOrder=asc',
      headers: { cookie: auth.sessionCookie },
    })
    expect(pageTwo.statusCode).toBe(200)
    const secondPage = pageTwo.json<{ data: { items: Array<{ id: string; skuCount: number; priceRange: { min: string; max: string; currency: string } | null; categories: unknown[] }> } }>().data.items
    const gammaSummary = [...firstPage.items, ...secondPage].find((item) => item.id === gammaProduct.id)
    expect(gammaSummary?.categories).toHaveLength(2)
    expect(gammaSummary).toMatchObject({
      skuCount: 2,
      priceRange: { min: '3.00', max: '7.00', currency: 'CNY' },
    })
    expect(secondPage.map((item) => item.id)).toEqual([tiedById[1], alpha.id])
    expect([...firstPage.items.map((item) => item.id), ...secondPage.map((item) => item.id)]).toHaveLength(4)
    expect(new Set([...firstPage.items.map((item) => item.id), ...secondPage.map((item) => item.id)]).size).toBe(4)

    const queries = [
      `/api/v1/admin/products?search=${encodeURIComponent('D4 列表 Alpha')}`,
      `/api/v1/admin/products?search=${alpha.id}`,
      `/api/v1/admin/products?search=${betaProduct.variants[0]!.skuCode}`,
      `/api/v1/admin/products?status=active&search=D4%20%E5%88%97%E8%A1%A8`,
      `/api/v1/admin/products?productType=physical&search=D4%20%E5%88%97%E8%A1%A8`,
      `/api/v1/admin/products?categoryId=${firstCategory.id}`,
      `/api/v1/admin/products?categoryId=${secondCategory.id}`,
    ]
    const results = await Promise.all(queries.map((url) => app.inject({ method: 'GET', url, headers: { cookie: auth.sessionCookie } })))
    expect(results.map((response) => response.statusCode)).toEqual(Array(queries.length).fill(200))
    expect(results[0]!.json().data.items.map((item: { id: string }) => item.id)).toEqual([alpha.id])
    expect(results[1]!.json().data.items.map((item: { id: string }) => item.id)).toEqual([alpha.id])
    expect(results[2]!.json().data.items.map((item: { id: string }) => item.id)).toEqual([betaProduct.id])
    expect(results[3]!.json().data.items.map((item: { id: string }) => item.id)).toEqual([alpha.id])
    expect(results[4]!.json().data.items.map((item: { id: string }) => item.id)).toEqual([betaProduct.id])
    expect(results[5]!.json().data.items.map((item: { id: string }) => item.id)).toEqual([gammaProduct.id])
    expect(results[6]!.json().data.items.map((item: { id: string }) => item.id)).toEqual([gammaProduct.id])

    const invalidPage = await app.inject({ method: 'GET', url: '/api/v1/admin/products?pageSize=101', headers: { cookie: auth.sessionCookie } })
    expect(invalidPage.statusCode).toBe(400)
    const invalidSearch = await app.inject({ method: 'GET', url: '/api/v1/admin/products?search=%20%20', headers: { cookie: auth.sessionCookie } })
    expect(invalidSearch.statusCode).toBe(400)
    expect(deltaProduct.status).toBe('draft')
  })

  it('blocks archived catalog edits across D2 and D3 while retaining reads and inventory maintenance', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '归档一致性商品')
    const category = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name: '归档商品分类' },
    })
    const secondCategory = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name: '替换商品分类' },
    })
    const categoryId = category.json<{ data: { id: string; revision: number } }>().data.id
    const secondCategoryId = secondCategory.json<{ data: { id: string } }>().data.id
    const assigned = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: product.revision, assignments: [{ categoryId, isPrimary: true, sortOrder: 0 }] },
    })
    expect(assigned.statusCode).toBe(200)
    let current = assigned.json<{ data: ProductDetail }>().data
    const attributes = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
      payload: { expectedRevision: current.revision, attributes: [{ name: '颜色', value: '蓝色', sortOrder: 0 }] },
    })
    expect(attributes.statusCode).toBe(200)
    current = attributes.json<{ data: ProductDetail }>().data

    const groupId = randomUUID()
    const lowValueId = randomUUID()
    const liveValueId = randomUUID()
    const matrix = await saveMatrix(auth, product.id, {
      expectedRevision: current.revision,
      mode: 'selected',
      groups: [optionGroup('归档规格', groupId, [
        { id: lowValueId, name: '低价' }, { id: liveValueId, name: '保留' },
      ])],
      combinations: [
        { optionValueIds: [lowValueId], salePrice: '2.00', enabled: true },
        { optionValueIds: [liveValueId], salePrice: '3.00', enabled: true },
      ],
    })
    expect(matrix.statusCode).toBe(200)
    current = matrix.json<{ data: { product: ProductDetail } }>().data.product
    const sku = current.variants.find((variant) => variant.options[0]?.valueId === liveValueId)!
    const mode = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: current.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    expect(mode.statusCode).toBe(200)
    const modeData = mode.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number } }>().data
    const stocked = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: modeData.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 4, reason: '归档状态测试库存初始化',
    })
    expect(stocked.statusCode).toBe(201)
    const beforeArchive = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    expect(beforeArchive.statusCode).toBe(200)
    current = beforeArchive.json<{ data: ProductDetail }>().data

    const archivedResponse = await changeProductLifecycle(auth, product.id, {
      expectedRevision: current.revision, status: 'archived',
    })
    expect(archivedResponse.statusCode).toBe(200)
    const archived = archivedResponse.json<{ data: ProductDetail }>().data
    expect(archived).toMatchObject({ status: 'archived', name: '归档一致性商品', categories: [{ categoryId }], attributes: [{ value: '蓝色' }] })
    expect(archived.variants.find((variant) => variant.id === sku.id)).toMatchObject({ enabled: true, retiredAt: null })
    expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', sku.id).executeTakeFirstOrThrow()).toEqual({ stocked: 4, reserved: 0 })

    const edits = await Promise.all([
      editProduct(auth, product.id, { expectedRevision: archived.revision, name: '不应改名' }),
      app.inject({
        method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
        payload: { expectedRevision: archived.revision, assignments: [{ categoryId: secondCategoryId, isPrimary: true, sortOrder: 0 }] },
      }),
      app.inject({
        method: 'PUT', url: `/api/v1/admin/products/${product.id}/attributes`, headers: productHeaders(auth),
        payload: { expectedRevision: archived.revision, attributes: [{ name: '颜色', value: '红色', sortOrder: 0 }] },
      }),
      saveMatrix(auth, product.id, {
        expectedRevision: archived.revision,
        mode: 'selected',
        groups: [optionGroup('归档规格已改', groupId, [
          { id: lowValueId, name: '低价' }, { id: liveValueId, name: '保留' },
        ])],
        combinations: [
          { skuId: archived.variants[0]!.id, optionValueIds: [lowValueId], salePrice: '2.00', enabled: true },
          { skuId: sku.id, optionValueIds: [liveValueId], salePrice: '3.00', enabled: true },
        ],
      }),
      patchSkuPrices(auth, product.id, sku.id, {
        expectedRevision: archived.revision, expectedSkuRevision: sku.revision, salePrice: '30.00',
      }),
      setInventoryMode(auth, product.id, sku.id, {
        expectedRevision: archived.revision,
        expectedSkuRevision: modeData.skuRevision,
        expectedInventoryRevision: modeData.inventoryRevision + 1,
        inventoryMode: null,
      }),
    ])
    expect(edits.map((response) => response.statusCode)).toEqual([409, 409, 409, 409, 409, 409])
    expect(edits.map((response) => response.json().error.code)).toEqual(Array(6).fill('PRODUCT_ARCHIVED'))

    const categoryEdit = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${categoryId}`, headers: productHeaders(auth),
      payload: { expectedRevision: category.json<{ data: { revision: number } }>().data.revision, name: '归档商品分类仍可独立维护' },
    })
    expect(categoryEdit.statusCode).toBe(200)

    const archivedDetail = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    expect(archivedDetail.statusCode).toBe(200)
    expect(archivedDetail.json().data).toMatchObject({ status: 'archived', name: '归档一致性商品' })
    expect(archivedDetail.json().data.categories[0].name).toBe('归档商品分类仍可独立维护')
    expect(archivedDetail.json().data.attributes).toMatchObject([{ name: '颜色', value: '蓝色' }])
    expect(archivedDetail.json().data.optionGroups).toMatchObject([{ name: '归档规格' }])
    expect(archivedDetail.json().data.variants.find((variant: { id: string }) => variant.id === sku.id))
      .toMatchObject({ salePrice: '3.00', enabled: true, retiredAt: null })
    const archivedInventory = await getInventorySummary(auth, product.id)
    expect(archivedInventory.statusCode).toBe(200)
    expect(archivedInventory.json().data.variants.find((variant: { skuId: string }) => variant.skuId === sku.id).inventory)
      .toMatchObject({ mode: 'quantity', stocked: 4, reserved: 0 })
    const archivedHistory = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/history`, headers: { cookie: auth.sessionCookie },
    })
    expect(archivedHistory.statusCode).toBe(200)
    expect(archivedHistory.json().data.events[0]).toMatchObject({ operation: 'archived' })

    const clearOut = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: modeData.inventoryRevision + 1,
      operationId: randomUUID(), action: 'decrease', quantity: 4, reason: '归档 SKU 合法清退库存',
    })
    expect(clearOut.statusCode).toBe(201)
    const stillArchived = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    expect(stillArchived.json().data.status).toBe('archived')
    const restored = await changeProductLifecycle(auth, product.id, {
      expectedRevision: archived.revision, status: 'draft',
    })
    expect(restored.statusCode).toBe(200)
    const restoredProduct = restored.json<{ data: ProductDetail }>().data
    const editableAgain = await editProduct(auth, product.id, {
      expectedRevision: restoredProduct.revision, name: '恢复后的正常编辑',
    })
    expect(editableAgain.statusCode).toBe(200)
    expect(editableAgain.json().data.name).toBe('恢复后的正常编辑')
  })

  it('serializes archive transitions with D3 pricing writes using the same product revision lock', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, '归档价格并发商品')
    const sku = product.variants[0]!
    const [archive, reprice] = await Promise.all([
      changeProductLifecycle(auth, product.id, { expectedRevision: product.revision, status: 'archived' }),
      patchSkuPrices(auth, product.id, sku.id, {
        expectedRevision: product.revision, expectedSkuRevision: sku.revision, salePrice: '29.00',
      }),
    ])
    const latest = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers: { cookie: auth.sessionCookie },
    })
    const finalProduct = latest.json<{ data: ProductDetail }>().data
    if (archive.statusCode === 200) {
      expect(reprice.statusCode).toBe(409)
      expect(finalProduct.status).toBe('archived')
      expect(finalProduct.variants[0]!.salePrice).toBe(sku.salePrice)
    } else {
      expect(archive.statusCode).toBe(409)
      expect(reprice.statusCode).toBe(200)
      expect(finalProduct.status).toBe('draft')
      expect(finalProduct.variants[0]!.salePrice).toBe('29.00')
    }
  })

  it('excludes retired SKU prices from nullable list ranges and stable ascending and descending sorts', async () => {
    const auth = await loginAdmin()
    const varied = await createTestProduct(auth, 'D4R1 价格范围 多 SKU')
    const groupId = randomUUID()
    const valueIds = [randomUUID(), randomUUID(), randomUUID()]
    const matrix = await saveMatrix(auth, varied.id, {
      expectedRevision: varied.revision,
      mode: 'selected',
      groups: [optionGroup('价格范围规格', groupId, valueIds.map((id, index) => ({ id, name: `规格${index}` })))],
      combinations: valueIds.map((id, index) => ({ optionValueIds: [id], salePrice: ['1.00', '5.00', '9.00'][index]!, enabled: true })),
    })
    expect(matrix.statusCode).toBe(200)
    const variedProduct = matrix.json<{ data: { product: ProductDetail } }>().data.product
    const low = variedProduct.variants.find((variant) => variant.options[0]?.valueId === valueIds[0])!
    const middle = variedProduct.variants.find((variant) => variant.options[0]?.valueId === valueIds[1])!
    const high = variedProduct.variants.find((variant) => variant.options[0]?.valueId === valueIds[2])!
    const retireExtremes = await saveMatrix(auth, varied.id, {
      expectedRevision: variedProduct.revision,
      mode: 'selected',
      groups: [optionGroup('价格范围规格', groupId, valueIds.map((id, index) => ({ id, name: `规格${index}` })))],
      combinations: [{ skuId: middle.id, optionValueIds: [valueIds[1]!], enabled: false }],
      retireSkuIds: [low.id, high.id],
    })
    expect(retireExtremes.statusCode).toBe(200)

    const tied = await createTestProduct(auth, 'D4R1 价格范围 同价')
    const expensive = await createTestProduct(auth, 'D4R1 价格范围 高价')
    const noPrice = await createTestProduct(auth, 'D4R1 价格范围 全退役')
    const tiedPrice = await patchSkuPrices(auth, tied.id, tied.variants[0]!.id, {
      expectedRevision: tied.revision, expectedSkuRevision: tied.variants[0]!.revision, salePrice: '5.00',
    })
    const expensivePrice = await patchSkuPrices(auth, expensive.id, expensive.variants[0]!.id, {
      expectedRevision: expensive.revision, expectedSkuRevision: expensive.variants[0]!.revision, salePrice: '10.00',
    })
    expect([tiedPrice.statusCode, expensivePrice.statusCode]).toEqual([200, 200])
    await db.updateTable('product_variants').set({ enabled: false, retired_at: new Date() })
      .where('product_id', '=', noPrice.id).execute()

    const list = async (order: 'asc' | 'desc', page: number) => app.inject({
      method: 'GET',
      url: `/api/v1/admin/products?search=${encodeURIComponent('D4R1 价格范围')}&page=${page}&pageSize=2&sortBy=price&sortOrder=${order}`,
      headers: { cookie: auth.sessionCookie },
    })
    const ascOne = await list('asc', 1)
    const ascTwo = await list('asc', 2)
    const ascThree = await list('asc', 3)
    expect([ascOne.statusCode, ascTwo.statusCode, ascThree.statusCode]).toEqual([200, 200, 200])
    const ascItems = [
      ...ascOne.json().data.items,
      ...ascTwo.json().data.items,
      ...ascThree.json().data.items,
    ] as Array<{ id: string; skuCount: number; priceRange: { min: string; max: string; currency: string } | null; costPrice?: unknown }>
    const tiedIds = [varied.id, tied.id].sort((left, right) => left.localeCompare(right))
    expect(ascItems.map((item) => item.id)).toEqual([tiedIds[0], tiedIds[1], expensive.id, noPrice.id])
    expect(ascItems.find((item) => item.id === varied.id)).toMatchObject({
      skuCount: 3,
      priceRange: { min: '5.00', max: '5.00', currency: 'CNY' },
    })
    expect(ascItems.find((item) => item.id === noPrice.id)).toMatchObject({ skuCount: 1, priceRange: null })
    expect(ascItems.every((item) => !('costPrice' in item))).toBe(true)

    const descOne = await list('desc', 1)
    const descTwo = await list('desc', 2)
    const descItems = [...descOne.json().data.items, ...descTwo.json().data.items] as Array<{ id: string; priceRange: unknown }>
    expect(descItems.map((item) => item.id)).toEqual([expensive.id, tiedIds[0], tiedIds[1], noPrice.id])
    expect(descItems.at(-1)?.priceRange).toBeNull()
    expect(new Set([...ascItems.map((item) => item.id), ...descItems.map((item) => item.id)]).size).toBe(4)
    const retiredPrices = await db.selectFrom('product_variants').select(['id', 'sale_price', 'retired_at'])
      .where('id', 'in', [low.id, high.id]).orderBy('sale_price').execute()
    expect(retiredPrices.map((row) => row.sale_price)).toEqual(['1.00000', '9.00000'])
    expect(retiredPrices.every((row) => row.retired_at !== null)).toBe(true)
  })

  it('copies catalog identities and mappings while resetting every inventory identity', async () => {
    const auth = await loginAdmin()
    const source = await createTestProduct(auth, '复制源商品')
    const groupId = randomUUID()
    const valueIds = [randomUUID(), randomUUID(), randomUUID()]
    const matrix = await saveMatrix(auth, source.id, {
      expectedRevision: source.revision,
      mode: 'selected',
      groups: [optionGroup('授权期限', groupId, [
        { id: valueIds[0]!, name: '月卡' },
        { id: valueIds[1]!, name: '季卡' },
        { id: valueIds[2]!, name: '年卡' },
      ])],
      combinations: [
        { optionValueIds: [valueIds[0]!], salePrice: '10.00', enabled: true },
        { optionValueIds: [valueIds[1]!], salePrice: '20.00', enabled: true },
        { optionValueIds: [valueIds[2]!], salePrice: '30.00', enabled: true },
      ],
    })
    expect(matrix.statusCode).toBe(200)
    let sourceDetail = matrix.json<{ data: { product: ProductDetail } }>().data.product
    const monthSku = sourceDetail.variants.find((variant) => variant.options[0]?.valueName === '月卡')!
    const quarterSku = sourceDetail.variants.find((variant) => variant.options[0]?.valueName === '季卡')!
    const retiredSku = sourceDetail.variants.find((variant) => variant.options[0]?.valueName === '年卡')!
    const priceUpdate = await patchSkuPrices(auth, source.id, monthSku.id, {
      expectedRevision: sourceDetail.revision,
      expectedSkuRevision: monthSku.revision,
      compareAtPrice: '15.00',
      costPrice: '1.23456',
    })
    expect(priceUpdate.statusCode).toBe(200)
    const priceData = priceUpdate.json<{ data: { productRevision: number; skuRevision: number } }>().data
    const attributes = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${source.id}/attributes`, headers: productHeaders(auth),
      payload: { expectedRevision: priceData.productRevision, attributes: [
        { name: '授权范围', value: '多设备', sortOrder: 1 },
        { name: '有效期', value: '按 SKU 规格', sortOrder: 0 },
      ] },
    })
    expect(attributes.statusCode).toBe(200)
    sourceDetail = attributes.json<{ data: ProductDetail }>().data

    const category = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name: '复制共用分类' },
    })
    const categoryId = category.json<{ data: { id: string } }>().data.id
    const assigned = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${source.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: sourceDetail.revision, assignments: [
        { categoryId, isPrimary: true, sortOrder: 0 },
      ] },
    })
    expect(assigned.statusCode).toBe(200)
    sourceDetail = assigned.json<{ data: ProductDetail }>().data

    const sourceMonthSku = sourceDetail.variants.find((variant) => variant.id === monthSku.id)!
    const quantityMode = await setInventoryMode(auth, source.id, sourceMonthSku.id, {
      expectedRevision: sourceDetail.revision,
      expectedSkuRevision: sourceMonthSku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const modeData = quantityMode.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number } }>().data
    const stocked = await adjustInventory(auth, source.id, sourceMonthSku.id, {
      expectedInventoryRevision: modeData.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 4, reason: '复制源库存不应复制',
    })
    expect(stocked.statusCode).toBe(201)
    const latestResponse = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${source.id}`, headers: { cookie: auth.sessionCookie },
    })
    sourceDetail = latestResponse.json<{ data: ProductDetail }>().data
    const liveGroups = sourceDetail.optionGroups.map((group) => optionGroup(group.name, group.id,
      group.values.map((value) => ({ id: value.id, name: value.name, sortOrder: value.sortOrder, enabled: value.enabled })),
      group.sortOrder, group.enabled))
    const retire = await saveMatrix(auth, source.id, {
      expectedRevision: sourceDetail.revision,
      mode: 'selected',
      groups: liveGroups,
      combinations: [monthSku.id, quarterSku.id].map((skuId) => {
        const variant = sourceDetail.variants.find((candidate) => candidate.id === skuId)!
        return { skuId, optionValueIds: variant.options.map((option) => option.valueId), enabled: variant.enabled }
      }),
      retireSkuIds: [retiredSku.id],
    })
    expect(retire.statusCode).toBe(200)
    const retiredProduct = retire.json<{ data: { product: ProductDetail } }>().data.product
    expect(retiredProduct.variants.find((variant) => variant.id === retiredSku.id)?.retiredAt).toBeTruthy()

    const copied = await copyProduct(auth, source.id, retiredProduct.revision)
    expect(copied.statusCode).toBe(201)
    const clone = copied.json<{ data: ProductDetail }>().data
    expect(clone).toMatchObject({
      name: source.name, description: source.description, productType: source.productType, status: 'draft',
    })
    expect(clone.id).not.toBe(source.id)
    expect(clone.categories.map((entry) => entry.categoryId)).toEqual([categoryId])
    expect(clone.optionGroups).toHaveLength(1)
    expect(clone.optionGroups[0]!.id).not.toBe(sourceDetail.optionGroups[0]!.id)
    expect(clone.optionGroups[0]!.values.map((value) => value.id)).not.toEqual(sourceDetail.optionGroups[0]!.values.map((value) => value.id))
    expect(clone.attributes.map((attribute) => attribute.id)).not.toEqual(sourceDetail.attributes.map((attribute) => attribute.id))
    expect(clone.attributes.map((attribute) => [attribute.name, attribute.value, attribute.sortOrder]))
      .toEqual(sourceDetail.attributes.map((attribute) => [attribute.name, attribute.value, attribute.sortOrder]))
    expect(clone.variants).toHaveLength(2)
    expect(clone.variants.some((variant) => variant.id === retiredSku.id || variant.skuCode === retiredSku.skuCode)).toBe(false)
    for (const sourceSku of [monthSku, quarterSku]) {
      const clonedSku = clone.variants.find((variant) => variant.options[0]?.valueName === sourceSku.options[0]?.valueName)!
      expect(clonedSku.id).not.toBe(sourceSku.id)
      expect(clonedSku.skuCode).not.toBe(sourceSku.skuCode)
      expect(clonedSku.options[0]?.groupId).not.toBe(sourceSku.options[0]?.groupId)
      expect(clonedSku.options[0]?.valueId).not.toBe(sourceSku.options[0]?.valueId)
      const clonedInventory = await db.selectFrom('product_variants').select(['inventory_mode', 'inventory_revision', 'compare_at_price', 'cost_price'])
        .where('id', '=', clonedSku.id).executeTakeFirstOrThrow()
      expect(clonedInventory).toMatchObject({ inventory_mode: null, inventory_revision: 0 })
      expect(await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
        .where('product_variant_id', '=', clonedSku.id).execute()).toEqual([])
      expect(await db.selectFrom('product_variant_inventory_adjustments').select('id')
        .where('product_variant_id', '=', clonedSku.id).execute()).toEqual([])
      if (sourceSku.id === monthSku.id) {
        expect(clonedInventory).toMatchObject({ compare_at_price: '15.00000', cost_price: '1.23456' })
      }
    }
    const copiedHistory = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${clone.id}/history`, headers: { cookie: auth.sessionCookie },
    })
    expect(copiedHistory.statusCode).toBe(200)
    expect(copiedHistory.json().data.events[0]).toMatchObject({
      operation: 'copied', after: { sourceProductId: source.id, skuCount: 2 },
    })

    const beforeFailedCopy = await sql<{ products: string; audit_events: string }>`
      SELECT (SELECT count(*)::text FROM products) AS products,
        (SELECT count(*)::text FROM product_management_audit_events) AS audit_events
    `.execute(db)
    skuCodeOverride = monthSku.skuCode
    let failedCopy: Awaited<ReturnType<typeof copyProduct>>
    try {
      failedCopy = await copyProduct(auth, source.id, retiredProduct.revision)
    } finally {
      skuCodeOverride = undefined
    }
    expect(failedCopy!.statusCode).toBe(409)
    expect(failedCopy!.json().error.code).toBe('SKU_CODE_CONFLICT')
    const afterFailedCopy = await sql<{ products: string; audit_events: string }>`
      SELECT (SELECT count(*)::text FROM products) AS products,
        (SELECT count(*)::text FROM product_management_audit_events) AS audit_events
    `.execute(db)
    expect(afterFailedCopy.rows[0]).toEqual(beforeFailedCopy.rows[0])

    const allRetired = await createTestProduct(auth, '全部 SKU 退役的复制源')
    const retiredOnlySku = allRetired.variants[0]!
    await db.updateTable('product_variants').set({ enabled: false, retired_at: new Date() })
      .where('id', '=', retiredOnlySku.id).execute()
    const retiredSourceRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', allRetired.id).executeTakeFirstOrThrow()
    const fallbackCopy = await copyProduct(auth, allRetired.id, retiredSourceRevision.revision)
    expect(fallbackCopy.statusCode, fallbackCopy.body).toBe(201)
    const fallback = fallbackCopy.json<{ data: ProductDetail }>().data
    expect(fallback.status).toBe('draft')
    expect(fallback.variants).toHaveLength(1)
    expect(fallback.variants[0]).toMatchObject({
      isDefault: true, enabled: false, retiredAt: null, salePrice: retiredOnlySku.salePrice, options: [],
    })
    expect(fallback.variants[0]!.id).not.toBe(retiredOnlySku.id)
    expect(fallback.variants[0]!.skuCode).not.toBe(retiredOnlySku.skuCode)
    expect(await db.selectFrom('product_variants').select(['inventory_mode', 'inventory_revision'])
      .where('id', '=', fallback.variants[0]!.id).executeTakeFirstOrThrow())
      .toEqual({ inventory_mode: null, inventory_revision: 0 })
  })

  it('permanently deletes a safe product atomically and preserves product, SKU, stock, and retirement references', async () => {
    const auth = await loginAdmin()
    const category = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name: '永久删除共享分类' },
    })
    const categoryId = category.json<{ data: { id: string } }>().data.id
    const deletable = await createTestProduct(auth, '可安全永久删除')
    const retained = await createTestProduct(auth, '共享分类仍保留的商品')
    const assignCategory = async (product: ProductDetail) => app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: { expectedRevision: product.revision, assignments: [
        { categoryId, isPrimary: true, sortOrder: 0 },
      ] },
    })
    const assigned = await assignCategory(deletable)
    const retainedAssignment = await assignCategory(retained)
    expect(assigned.statusCode).toBe(200)
    expect(retainedAssignment.statusCode).toBe(200)
    let detail = assigned.json<{ data: ProductDetail }>().data
    const groupId = randomUUID()
    const valueId = randomUUID()
    const matrix = await saveMatrix(auth, detail.id, {
      expectedRevision: detail.revision,
      mode: 'selected',
      groups: [optionGroup('清理规格组', groupId, [{ id: valueId, name: '唯一规格值' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '4.50', enabled: true }],
    })
    detail = matrix.json<{ data: { product: ProductDetail } }>().data.product
    const sku = detail.variants[0]!
    const quantityMode = await setInventoryMode(auth, detail.id, sku.id, {
      expectedRevision: detail.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    expect(quantityMode.statusCode).toBe(200)
    const expectedRevision = quantityMode.json<{ data: { productRevision: number } }>().data.productRevision

    const deleted = await deleteProduct(auth, detail.id, expectedRevision)
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().data).toEqual({ productId: detail.id, deleted: true })
    expect(await db.selectFrom('products').select('id').where('id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_variants').select('id').where('product_id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
      .where('product_id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_variant_option_values').select('product_variant_id')
      .where('product_id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_option_values').select('id').where('product_id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_option_groups').select('id').where('product_id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_attributes').select('id').where('product_id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_category_assignments').select('product_id')
      .where('product_id', '=', detail.id).execute()).toEqual([])
    expect(await db.selectFrom('product_categories').select('id').where('id', '=', categoryId).execute()).toHaveLength(1)
    expect(await db.selectFrom('product_category_assignments').select(['product_id', 'category_id'])
      .where('product_id', '=', retained.id).execute()).toEqual([{ product_id: retained.id, category_id: categoryId }])

    const deletedHistory = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${detail.id}/history`, headers: { cookie: auth.sessionCookie },
    })
    expect(deletedHistory.statusCode).toBe(200)
    expect(deletedHistory.json().data.events[0]).toMatchObject({ productId: detail.id, operation: 'deleted', after: null })
    const deletedAuditId = deletedHistory.json().data.events[0].id as string
    await expect(db.deleteFrom('product_management_audit_events').where('id', '=', deletedAuditId).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'product_management_audit_immutable' })

    const withStock = await createTestProduct(auth, '有实际库存的删除保护')
    const stockedSku = withStock.variants[0]!
    const stockedMode = await setInventoryMode(auth, withStock.id, stockedSku.id, {
      expectedRevision: withStock.revision, expectedSkuRevision: stockedSku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    await db.updateTable('product_variant_quantity_inventory').set({ stocked: 2 })
      .where('product_variant_id', '=', stockedSku.id).execute()
    const stockBlocked = await deleteProduct(auth, withStock.id,
      stockedMode.json<{ data: { productRevision: number } }>().data.productRevision)
    expect(stockBlocked.statusCode).toBe(409)
    expect(stockBlocked.json().error.code).toBe('PRODUCT_HAS_INVENTORY')
    expect(await db.selectFrom('products').select('id').where('id', '=', withStock.id).execute()).toHaveLength(1)

    const withReservation = await createTestProduct(auth, '有库存预留的删除保护')
    const reservedSku = withReservation.variants[0]!
    const reservedMode = await setInventoryMode(auth, withReservation.id, reservedSku.id, {
      expectedRevision: withReservation.revision, expectedSkuRevision: reservedSku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const reservedModeData = reservedMode.json<{ data: { productRevision: number; inventoryRevision: number } }>().data
    expect((await adjustInventory(auth, withReservation.id, reservedSku.id, {
      expectedInventoryRevision: reservedModeData.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 2, reason: '删除预留保护测试库存',
    })).statusCode).toBe(201)
    await createReservedOrderForTest(auth, withReservation.id, reservedSku.id, 1)
    const reservedDetail = (await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${withReservation.id}`, headers: { cookie: auth.sessionCookie },
    })).json<{ data: ProductDetail }>().data
    const reservedPaused = await changeProductLifecycle(auth, withReservation.id, {
      expectedRevision: reservedDetail.revision, status: 'paused',
    })
    expect(reservedPaused.statusCode).toBe(200)
    const reservedBlocked = await deleteProduct(auth, withReservation.id,
      reservedPaused.json<{ data: ProductDetail }>().data.revision)
    expect(reservedBlocked.statusCode).toBe(409)
    expect(reservedBlocked.json().error.code).toBe('PRODUCT_HAS_ORDER_HISTORY')

    const withHistory = await createTestProduct(auth, '归档后仍有库存流水')
    const historySku = withHistory.variants[0]!
    const historyMode = await setInventoryMode(auth, withHistory.id, historySku.id, {
      expectedRevision: withHistory.revision, expectedSkuRevision: historySku.revision,
      expectedInventoryRevision: 0, inventoryMode: 'quantity',
    })
    const historyModeData = historyMode.json<{ data: { productRevision: number; inventoryRevision: number } }>().data
    expect((await adjustInventory(auth, withHistory.id, historySku.id, {
      expectedInventoryRevision: historyModeData.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 2, reason: '删除保护测试补货',
    })).statusCode).toBe(201)
    expect((await adjustInventory(auth, withHistory.id, historySku.id, {
      expectedInventoryRevision: historyModeData.inventoryRevision + 1,
      operationId: randomUUID(), action: 'decrease', quantity: 2, reason: '清零后仍保留流水',
    })).statusCode).toBe(201)
    const archived = await changeProductLifecycle(auth, withHistory.id, {
      expectedRevision: historyModeData.productRevision, status: 'archived',
    })
    expect(archived.statusCode).toBe(200)
    const historyBlocked = await deleteProduct(auth, withHistory.id, archived.json<{ data: ProductDetail }>().data.revision)
    expect(historyBlocked.statusCode).toBe(409)
    expect(historyBlocked.json().error.code).toBe('PRODUCT_HAS_INVENTORY_HISTORY')
    expect(await db.selectFrom('product_variant_inventory_adjustments').select('id')
      .where('product_variant_id', '=', historySku.id).execute()).toHaveLength(2)

    const retiredProduct = await createTestProduct(auth, '有永久退役 SKU 的商品')
    const retiredGroupId = randomUUID()
    const retainedValueId = randomUUID()
    const toRetireValueId = randomUUID()
    const populatedRetiredProduct = await saveMatrix(auth, retiredProduct.id, {
      expectedRevision: retiredProduct.revision,
      mode: 'selected',
      groups: [optionGroup('退役规格', retiredGroupId, [
        { id: retainedValueId, name: '保留 SKU' }, { id: toRetireValueId, name: '退役 SKU' },
      ])],
      combinations: [
        { optionValueIds: [retainedValueId], salePrice: '1.00', enabled: true },
        { optionValueIds: [toRetireValueId], salePrice: '2.00', enabled: true },
      ],
    })
    expect(populatedRetiredProduct.statusCode).toBe(200)
    const populated = populatedRetiredProduct.json<{ data: { product: ProductDetail } }>().data.product
    const keptSku = populated.variants.find((variant) => variant.options[0]?.valueId === retainedValueId)!
    const skuToRetire = populated.variants.find((variant) => variant.options[0]?.valueId === toRetireValueId)!
    const retired = await saveMatrix(auth, retiredProduct.id, {
      expectedRevision: populated.revision,
      mode: 'selected',
      groups: [optionGroup('退役规格', retiredGroupId, [
        { id: retainedValueId, name: '保留 SKU' }, { id: toRetireValueId, name: '退役 SKU' },
      ])],
      combinations: [{ skuId: keptSku.id, optionValueIds: [retainedValueId], enabled: true }],
      retireSkuIds: [skuToRetire.id],
    })
    expect(retired.statusCode).toBe(200)
    const retiredDetail = retired.json<{ data: { product: ProductDetail } }>().data.product
    expect(retiredDetail.variants.find((variant) => variant.id === skuToRetire.id)?.retiredAt).toBeTruthy()
    const retiredBlocked = await deleteProduct(auth, retiredProduct.id, retiredDetail.revision)
    expect(retiredBlocked.statusCode).toBe(409)
    expect(retiredBlocked.json().error.code).toBe('PRODUCT_HAS_RETIRED_SKU')
  })

  it('serializes competing lifecycle writes and prevents inventory adjustment from racing product deletion', async () => {
    const auth = await loginAdmin()
    const concurrent = await createTestProduct(auth, '生命周期并发商品')
    const attempts = await Promise.all([
      changeProductLifecycle(auth, concurrent.id, { expectedRevision: concurrent.revision, status: 'active' }),
      changeProductLifecycle(auth, concurrent.id, { expectedRevision: concurrent.revision, status: 'archived' }),
    ])
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const conflict = attempts.find((response) => response.statusCode === 409)!
    expect(conflict.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
    const audit = await db.selectFrom('product_management_audit_events').select('operation')
      .where('product_id', '=', concurrent.id).execute()
    expect(audit).toHaveLength(2)

    const race = await createTestProduct(auth, '库存调整与删除竞争商品')
    const sku = race.variants[0]!
    const mode = await setInventoryMode(auth, race.id, sku.id, {
      expectedRevision: race.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const modeData = mode.json<{ data: { productRevision: number; inventoryRevision: number } }>().data
    const [adjustment, deletion] = await Promise.all([
      adjustInventory(auth, race.id, sku.id, {
        expectedInventoryRevision: modeData.inventoryRevision,
        operationId: randomUUID(), action: 'increase', quantity: 1, reason: '删除并发保护补货',
      }),
      deleteProduct(auth, race.id, modeData.productRevision),
    ])
    if (deletion.statusCode === 200) {
      expect(adjustment.statusCode).toBe(404)
      expect(await db.selectFrom('products').select('id').where('id', '=', race.id).execute()).toEqual([])
      expect(await db.selectFrom('product_variant_inventory_adjustments').select('id')
        .where('product_id', '=', race.id).execute()).toEqual([])
    } else {
      expect(deletion.statusCode).toBe(409)
      expect(adjustment.statusCode).toBe(201)
      expect(['PRODUCT_HAS_INVENTORY', 'PRODUCT_HAS_INVENTORY_HISTORY']).toContain(deletion.json().error.code)
      expect(await db.selectFrom('products').select('id').where('id', '=', race.id).execute()).toHaveLength(1)
      expect(await db.selectFrom('product_variant_inventory_adjustments').select('id')
        .where('product_id', '=', race.id).execute()).toHaveLength(1)
      expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
        .where('product_variant_id', '=', sku.id).executeTakeFirstOrThrow()).toEqual({ stocked: 1, reserved: 0 })
    }
  }, 30_000)
})

describe('D5 product media and rich content', () => {
  it('authenticates uploads, processes supported images, and serves immutable WebP variants safely', async () => {
    const auth = await loginAdmin()
    const png = await samplePng()
    const jpeg = await sampleOrientedJpeg()
    const webp = await sharp(png).webp().toBuffer()
    const anonymousForm = multipartPayload([{ name: 'file', bytes: png }])
    const anonymous = await app.inject({
      method: 'POST', url: '/api/v1/admin/media',
      headers: { 'content-type': `multipart/form-data; boundary=${anonymousForm.boundary}` },
      payload: anonymousForm.body,
    })
    expect(anonymous.statusCode).toBe(401)

    const noCsrf = await app.inject({
      method: 'POST', url: '/api/v1/admin/media',
      headers: {
        origin: testOrigin,
        cookie: `${auth.sessionCookie}; ${auth.csrf.cookie}`,
        'content-type': `multipart/form-data; boundary=${anonymousForm.boundary}`,
      },
      payload: anonymousForm.body,
    })
    expect(noCsrf.statusCode).toBe(403)

    const pngUpload = await uploadMedia(auth, png, 'image/png', '../../server-secret.png')
    const jpegUpload = await uploadMedia(auth, jpeg, 'image/jpeg', 'photo.jpg')
    const webpUpload = await uploadMedia(auth, webp, 'image/webp', 'photo.webp')
    expect([pngUpload.statusCode, jpegUpload.statusCode, webpUpload.statusCode]).toEqual([201, 201, 201])
    const pngMeta = pngUpload.json<{ data: { id: string; variants: Array<{ variant: string; url: string; contentType: string; width: number; height: number; sha256: string; sizeBytes: number }> } }>().data
    const jpegMeta = jpegUpload.json<{ data: { id: string; variants: Array<{ variant: string; width: number; height: number }> } }>().data
    const webpMeta = webpUpload.json<{ data: { id: string; variants: Array<{ variant: string; contentType: string }> } }>().data
    expect(pngMeta.variants.map((item) => item.variant)).toEqual(['thumbnail', 'card', 'detail'])
    expect(pngMeta.variants.every((item) => item.contentType === 'image/webp' && item.width <= 1920 && item.height <= 1920)).toBe(true)
    expect(jpegMeta.variants.find((item) => item.variant === 'detail')).toMatchObject({ width: 24, height: 48 })
    expect(webpMeta.variants.every((item) => item.contentType === 'image/webp')).toBe(true)

    const detail = pngMeta.variants.find((item) => item.variant === 'detail')!
    const image = await app.inject(detail.url)
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/webp')
    expect(image.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(image.headers['etag']).toBe(`"${detail.sha256}"`)
    expect(Number(image.headers['content-length'])).toBe(detail.sizeBytes)
    expect(createHash('sha256').update(image.rawPayload).digest('hex')).toBe(detail.sha256)
    expect((await sharp(image.rawPayload).metadata()).hasAlpha).toBe(true)
    const head = await app.inject({ method: 'HEAD', url: detail.url })
    expect(head.statusCode).toBe(200)
    expect(head.rawPayload.length).toBe(0)
    expect((await app.inject({ method: 'GET', url: detail.url, headers: { 'if-none-match': `"${detail.sha256}"` } })).statusCode).toBe(304)
    expect((await app.inject({ method: 'GET', url: detail.url, headers: { 'if-modified-since': image.headers['last-modified']! } })).statusCode).toBe(304)
    expect((await app.inject(`/api/v1/media/${randomUUID()}/detail.webp`)).statusCode).toBe(404)
    expect((await app.inject(`/api/v1/media/${pngMeta.id}/../../etc/passwd`)).statusCode).toBe(404)

    const storedKey = await db.selectFrom('product_media_variants').select('storage_key')
      .where('media_id', '=', pngMeta.id).where('variant', '=', 'detail').executeTakeFirstOrThrow()
    expect(storedKey.storage_key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+-detail\.webp$/)
    expect(storedKey.storage_key).not.toContain('server-secret')

    const badMime = await uploadMedia(auth, png, 'image/jpeg')
    const html = await uploadMedia(auth, Buffer.from('<!doctype html><script>alert(1)</script>'), 'image/png')
    const svg = await uploadMedia(auth, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')
    const damaged = await uploadMedia(auth, Buffer.from('not an image'), 'image/webp')
    const tooLarge = await uploadMedia(auth, Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png')
    expect([badMime.statusCode, html.statusCode, svg.statusCode, damaged.statusCode]).toEqual([400, 400, 400, 400])
    expect(tooLarge.statusCode).toBe(413)

    const hugePng = Buffer.alloc(45)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(hugePng, 0)
    hugePng.writeUInt32BE(13, 8)
    hugePng.write('IHDR', 12)
    hugePng.writeUInt32BE(50_000, 16)
    hugePng.writeUInt32BE(50_000, 20)
    hugePng[24] = 8
    hugePng[25] = 6
    hugePng.writeUInt32BE(0, 33)
    hugePng.write('IEND', 37)
    const dimensions = await uploadMedia(auth, hugePng, 'image/png')
    expect(dimensions.statusCode).toBe(400)

    const multiple = multipartPayload([
      { name: 'file', bytes: png, mimeType: 'image/png' },
      { name: 'file', bytes: png, mimeType: 'image/png' },
    ])
    const multipleFiles = await app.inject({
      method: 'POST', url: '/api/v1/admin/media',
      headers: { ...productHeaders(auth), 'content-type': `multipart/form-data; boundary=${multiple.boundary}` },
      payload: multiple.body,
    })
    expect([400, 413]).toContain(multipleFiles.statusCode)
    const extraField = multipartPayload([
      { name: 'file', bytes: png, mimeType: 'image/png' },
      { name: 'unexpected', value: 'field' },
    ])
    const fields = await app.inject({
      method: 'POST', url: '/api/v1/admin/media',
      headers: { ...productHeaders(auth), 'content-type': `multipart/form-data; boundary=${extraField.boundary}` },
      payload: extraField.body,
    })
    expect([400, 413]).toContain(fields.statusCode)
  }, 30_000)

  it('cleans files when metadata persistence fails and leaves no records after a storage write failure', async () => {
    const auth = await loginAdmin()
    const before = await db.selectFrom('product_media').select('id').execute()
    await sql`CREATE FUNCTION fail_d5_media_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected integration failure'; END; $$`.execute(db)
    await sql`CREATE TRIGGER fail_d5_media_insert BEFORE INSERT ON product_media
      FOR EACH ROW EXECUTE FUNCTION fail_d5_media_insert()`.execute(db)
    let failedInsert
    try {
      failedInsert = await uploadMedia(auth, await samplePng())
    } finally {
      await sql`DROP TRIGGER fail_d5_media_insert ON product_media`.execute(db)
      await sql`DROP FUNCTION fail_d5_media_insert()`.execute(db)
    }
    expect(failedInsert!.statusCode).toBe(500)
    expect(await db.selectFrom('product_media').select('id').execute()).toHaveLength(before.length)
    const registeredKeys = new Set((await db.selectFrom('product_media_variants').select('storage_key').execute())
      .map((row) => row.storage_key))
    const stored = await new MediaStorage(mediaTestRoot).scanGeneratedFiles()
    expect(stored.filter((file) => file.staged)).toHaveLength(0)
    expect(stored.filter((file) => !file.staged && !registeredKeys.has(file.storageKey))).toHaveLength(0)

    const blockedStorage = join(mediaTestRoot, 'not-a-directory')
    writeFileSync(blockedStorage, 'regular file')
    const badConfig = readConfig({
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: testOrigin,
      COOKIE_SECURE: 'false',
      MEDIA_ROOT: blockedStorage,
    })
    const badApp = await createApp({ db, config: badConfig, logger: false, productIdentityFactory })
    await badApp.ready()
    try {
      const badAuth = await loginAdmin(badApp)
      const response = await uploadMedia(badAuth, await samplePng(), 'image/png', 'ignored.png', badApp)
      expect(response.statusCode).toBe(500)
      expect(await db.selectFrom('product_media').select('id').execute()).toHaveLength(before.length)
    } finally {
      await badApp.close()
      rmSync(blockedStorage, { force: true })
    }
  }, 30_000)

  it('orders gallery references, protects shared media, copies content references, and only removes product-owned links', async () => {
    const auth = await loginAdmin()
    const image1 = (await uploadMedia(auth, await samplePng())).json<{ data: { id: string } }>().data
    const image2 = (await uploadMedia(auth, await samplePng())).json<{ data: { id: string } }>().data
    const image3 = (await uploadMedia(auth, await samplePng())).json<{ data: { id: string } }>().data
    const first = await createTestProduct(auth, 'D5 gallery owner')
    const second = await createTestProduct(auth, 'D5 shared image owner')
    const skuBefore = first.variants[0]!

    const gallery = await replaceGallery(auth, first.id, first.revision, [image1.id, image2.id])
    expect(gallery.statusCode).toBe(200)
    const galleryData = gallery.json<{ data: { revision: number; images: Array<{ id: string; sortOrder: number }> } }>().data
    expect(galleryData.images.map((item) => [item.id, item.sortOrder])).toEqual([[image1.id, 0], [image2.id, 1]])
    expect((await replaceGallery(auth, first.id, galleryData.revision, [image1.id, image1.id])).statusCode).toBe(400)
    expect((await replaceGallery(auth, first.id, first.revision, [image2.id, image1.id])).json().error.code)
      .toBe('PRODUCT_REVISION_CONFLICT')
    const secondGallery = await replaceGallery(auth, second.id, second.revision, [image1.id])
    expect(secondGallery.statusCode).toBe(200)

    const richContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '商品详情', marks: [{ type: 'bold' }] }] },
        { type: 'paragraph', content: [
          { type: 'text', text: '阅读说明 ' },
          { type: 'text', text: '安全链接', marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }, { type: 'italic' }] },
        ] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '内容项' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用内容' }] }] },
        { type: 'image', attrs: { mediaId: image2.id, alt: '产品图片' } },
        { type: 'image', attrs: { mediaId: image2.id, alt: '重复引用同一媒体' } },
        { type: 'horizontalRule' },
      ],
    }
    const contentSaved = await saveRichContent(auth, first.id, galleryData.revision, richContent)
    expect(contentSaved.statusCode).toBe(200)
    const saved = contentSaved.json<{ data: { revision: number; content: typeof richContent } }>().data
    const detail = await getAdminProduct(auth, first.id)
    const product = detail.json<{ data: ProductDetail }>().data
    expect(product.richContent).toEqual(saved.content)
    expect(product.gallery.map((item) => item.id)).toEqual([image1.id, image2.id])
    expect(product.description).toBe(first.description)
    expect(product.variants[0]).toMatchObject({ id: skuBefore.id, salePrice: skuBefore.salePrice, revision: skuBefore.revision })
    const contentReferences = await db.selectFrom('product_media_references').select('media_id')
      .where('product_id', '=', first.id).where('source', '=', 'rich_content').execute()
    expect(contentReferences.map((row) => row.media_id)).toEqual([image2.id])
    const history = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${first.id}/history`, headers: { cookie: auth.sessionCookie },
    })
    const operations = history.json<{ data: { events: Array<{ operation: string; after: Record<string, unknown> | null }> } }>()
      .data.events.map((event) => event.operation)
    expect(operations).toContain('gallery_updated')
    expect(operations).toContain('rich_content_updated')
    expect(JSON.stringify(history.json()).length).toBeLessThan(20_000)
    expect(productRichContentToSafeHtml(richContent)).toContain('<img src="/api/v1/media/')

    const archived = await changeProductLifecycle(auth, first.id, { expectedRevision: saved.revision, status: 'archived' })
    expect(archived.statusCode).toBe(200)
    const archivedRevision = archived.json<{ data: ProductDetail }>().data.revision
    expect((await replaceGallery(auth, first.id, archivedRevision, [])).json().error.code).toBe('PRODUCT_ARCHIVED')
    expect((await saveRichContent(auth, first.id, archivedRevision, { type: 'doc', content: [] })).json().error.code)
      .toBe('PRODUCT_ARCHIVED')
    const restored = await changeProductLifecycle(auth, first.id, { expectedRevision: archivedRevision, status: 'draft' })
    expect(restored.statusCode).toBe(200)
    const restoredProduct = restored.json<{ data: ProductDetail }>().data

    const copied = await copyProduct(auth, first.id, restoredProduct.revision)
    expect(copied.statusCode).toBe(201)
    const copy = copied.json<{ data: ProductDetail }>().data
    expect(copy.status).toBe('draft')
    expect(copy.gallery.map((item) => item.id)).toEqual([image1.id, image2.id])
    expect(copy.richContent).toEqual(product.richContent)
    expect((await db.selectFrom('product_media_references').select('source')
      .where('product_id', '=', copy.id).where('media_id', '=', image2.id).execute()).map((row) => row.source).sort())
      .toEqual(['gallery', 'rich_content'])

    const sharedDelete = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/media/${image1.id}`,
      headers: productHeaders(auth),
    })
    expect(sharedDelete.statusCode, sharedDelete.body).toBe(409)
    expect(sharedDelete.json().error.code).toBe('MEDIA_STILL_REFERENCED')
    const bodyReferencedDelete = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/media/${image2.id}`,
      headers: productHeaders(auth),
    })
    expect(bodyReferencedDelete.statusCode).toBe(409)

    const deletedFirst = await deleteProduct(auth, first.id, restoredProduct.revision)
    expect(deletedFirst.statusCode).toBe(200)
    expect(await db.selectFrom('product_media_references').select('media_id').where('product_id', '=', first.id).execute())
      .toEqual([])
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/media/${image1.id}`, headers: productHeaders(auth) })).statusCode)
      .toBe(409)

    const secondCurrent = await getAdminProduct(auth, second.id)
    const secondRevision = secondCurrent.json<{ data: ProductDetail }>().data.revision
    const secondCleared = await replaceGallery(auth, second.id, secondRevision, [])
    const copyClearedGallery = await replaceGallery(auth, copy.id, copy.revision, [])
    const copyRevisionAfterGallery = copyClearedGallery.json<{ data: { revision: number } }>().data.revision
    expect(secondCleared.statusCode).toBe(200)
    expect(copyClearedGallery.statusCode).toBe(200)
    const copyClearedContent = await saveRichContent(auth, copy.id, copyRevisionAfterGallery, { type: 'doc', content: [] })
    expect(copyClearedContent.statusCode).toBe(200)

    for (const media of [image1, image2, image3]) {
      const removed = await app.inject({
        method: 'DELETE', url: `/api/v1/admin/media/${media.id}`, headers: productHeaders(auth),
      })
      expect(removed.statusCode).toBe(200)
      expect(removed.json().data.deleted).toBe(true)
      expect((await app.inject(`/api/v1/media/${media.id}/detail.webp`)).statusCode).toBe(404)
    }
  }, 30_000)

  it('validates Tiptap structure, bounds text and nesting, synchronizes references, and serializes concurrent saves', async () => {
    const auth = await loginAdmin()
    const uploaded = await uploadMedia(auth, await samplePng())
    const media = uploaded.json<{ data: { id: string } }>().data
    const product = await createTestProduct(auth, 'D5 rich content safety')
    const valid = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert("x")</script>' }] },
        { type: 'image', attrs: { mediaId: media.id, alt: '" onerror="alert(1)' } }],
    }
    const initial = await saveRichContent(auth, product.id, product.revision, valid)
    expect(initial.statusCode).toBe(200)
    const savedRevision = initial.json<{ data: { revision: number } }>().data.revision
    const serialized = productRichContentToSafeHtml(valid)
    expect(serialized).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(serialized).toContain('alt="&quot; onerror=&quot;alert(1)"')
    expect(serialized).not.toContain('<script>')
    expect(serialized).not.toContain('data:')

    const invalidDocuments: unknown[] = [
      { type: 'doc', content: [{ type: 'script', content: [] }] },
      { type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' } }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
      { type: 'doc', content: [{ type: 'image', attrs: { src: 'data:image/png;base64,AAAA' } }] },
      { type: 'doc', content: [{ type: 'image', attrs: { mediaId: randomUUID(), src: '/private/file.png' } }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsafe', marks: [{ type: 'link', attrs: { href: '//evil.example' } }] }] }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsafe', marks: [{ type: 'link', attrs: { href: '/\\\\evil.example' } }] }] }] },
    ]
    for (const content of invalidDocuments) {
      const rejected = await saveRichContent(auth, product.id, savedRevision, content)
      expect(rejected.statusCode).toBe(400)
    }
    const missingMedia = await saveRichContent(auth, product.id, savedRevision, {
      type: 'doc', content: [{ type: 'image', attrs: { mediaId: randomUUID() } }],
    })
    expect(missingMedia.statusCode).toBe(400)
    expect(missingMedia.json().error.code).toBe('MEDIA_NOT_FOUND')
    const tooManyImages = await saveRichContent(auth, product.id, savedRevision, {
      type: 'doc', content: Array.from({ length: 101 }, () => ({ type: 'image', attrs: { mediaId: media.id } })),
    })
    expect(tooManyImages.statusCode).toBe(400)
    const oversizedJson = await saveRichContent(auth, product.id, savedRevision, {
      type: 'doc',
      content: Array.from({ length: 80 }, () => ({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: `https://example.com/${'a'.repeat(2000)}` } }] }],
      })),
    })
    expect(oversizedJson.statusCode).toBe(400)
    expect(oversizedJson.json().error.code).toBe('INVALID_PRODUCT_RICH_CONTENT')
    const tooMuchText = await saveRichContent(auth, product.id, savedRevision, {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '汉'.repeat(45_000) }] }],
    })
    expect(tooMuchText.statusCode).toBe(400)
    expect(tooMuchText.json().error.code).toBe('INVALID_PRODUCT_RICH_CONTENT')
    const tooManyNodes = await saveRichContent(auth, product.id, savedRevision, {
      type: 'doc', content: Array.from({ length: 500 }, () => ({ type: 'paragraph' })),
    })
    expect(tooManyNodes.statusCode).toBe(400)
    let deeplyNested: Record<string, unknown> = { type: 'paragraph' }
    for (let index = 0; index < 20; index += 1) deeplyNested = { type: 'blockquote', content: [deeplyNested] }
    const tooDeep = await saveRichContent(auth, product.id, savedRevision, { type: 'doc', content: [deeplyNested] })
    expect(tooDeep.statusCode).toBe(400)

    const failedRevision = savedRevision
    await sql`CREATE FUNCTION fail_d5_content_reference() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.source = 'rich_content' THEN RAISE EXCEPTION 'injected reference failure'; END IF;
        RETURN OLD;
      END; $$`.execute(db)
    await sql`CREATE TRIGGER fail_d5_content_reference BEFORE DELETE ON product_media_references
      FOR EACH ROW EXECUTE FUNCTION fail_d5_content_reference()`.execute(db)
    let failedContentSave
    try {
      failedContentSave = await saveRichContent(auth, product.id, savedRevision, { type: 'doc', content: [] })
    } finally {
      await sql`DROP TRIGGER fail_d5_content_reference ON product_media_references`.execute(db)
      await sql`DROP FUNCTION fail_d5_content_reference()`.execute(db)
    }
    expect(failedContentSave!.statusCode).toBe(500)
    const rolledBackProduct = await getAdminProduct(auth, product.id)
    expect(rolledBackProduct.json<{ data: ProductDetail }>().data.revision).toBe(failedRevision)
    expect(rolledBackProduct.json<{ data: ProductDetail }>().data.richContent).toEqual(valid)
    expect(await db.selectFrom('product_media_references').select('media_id')
      .where('product_id', '=', product.id).where('source', '=', 'rich_content').execute()).toEqual([{ media_id: media.id }])

    const emptySave = await saveRichContent(auth, product.id, savedRevision, { type: 'doc', content: [] })
    expect(emptySave.statusCode).toBe(200)
    const emptyRevision = emptySave.json<{ data: { revision: number } }>().data.revision
    expect(emptySave.json<{ data: { content: unknown } }>().data.content)
      .toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(await db.selectFrom('product_media_references').select('media_id')
      .where('product_id', '=', product.id).where('source', '=', 'rich_content').execute()).toEqual([])

    const concurrent = await Promise.all([
      saveRichContent(auth, product.id, emptyRevision, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first write' }] }] }),
      saveRichContent(auth, product.id, emptyRevision, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second write' }] }] }),
    ])
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const current = await getAdminProduct(auth, product.id)
    const currentData = current.json<{ data: ProductDetail }>().data
    expect(currentData.revision).toBe(emptyRevision + 1)
    expect(['first write', 'second write']).toContain((currentData.richContent.content[0] as { content: Array<{ text: string }> }).content[0]!.text)
  }, 30_000)

  it('checks media checksums and only prunes aged unregistered files after explicit cleanup', async () => {
    const auth = await loginAdmin()
    const registered = await uploadMedia(auth, await samplePng())
    expect(registered.statusCode).toBe(201)
    const mediaId = registered.json<{ data: { id: string } }>().data.id
    const detail = await db.selectFrom('product_media_variants').select(['storage_key', 'sha256'])
      .where('media_id', '=', mediaId).where('variant', '=', 'detail').executeTakeFirstOrThrow()
    const storage = new MediaStorage(mediaTestRoot)
    const detailPath = join(mediaTestRoot, detail.storage_key)
    const originalBytes = readFileSync(detailPath)
    writeFileSync(detailPath, Buffer.from('corrupt'))
    const corrupted = await reconcileProductMedia(db, storage)
    expect(corrupted.invalidFiles).toBe(1)
    expect(corrupted.needsAttention).toBe(true)
    writeFileSync(detailPath, originalBytes)
    expect(createHash('sha256').update(readFileSync(detailPath)).digest('hex')).toBe(detail.sha256.trim())

    const orphan = await storage.publishImage({ bytes: await samplePng(), mimeType: 'image/png' })
    const staleStage = join(mediaTestRoot, '.staging', `upload-${randomUUID()}-thumbnail-${randomUUID()}.tmp`)
    writeFileSync(staleStage, 'incomplete staging bytes')
    const older = new Date(Date.now() - 2 * 60 * 60 * 1000)
    for (const variant of orphan.variants) utimesSync(join(mediaTestRoot, variant.storageKey), older, older)
    utimesSync(staleStage, older, older)

    const now = Date.now() + 26 * 60 * 60 * 1000
    const dryRun = await reconcileProductMedia(db, storage, { now })
    expect(dryRun.unreferencedFiles).toBe(3)
    expect(dryRun.staleStagingFiles).toBe(1)
    expect(dryRun.deletedFiles).toBe(0)
    expect(readFileSync(staleStage, 'utf8')).toBe('incomplete staging bytes')

    const cleanup = await reconcileProductMedia(db, storage, {
      now,
      deleteUnreferencedOlderThanMs: 60 * 60 * 1000,
    })
    expect(cleanup.deletedFiles).toBe(4)
    expect(cleanup.unreferencedFiles).toBe(0)
    expect(cleanup.staleStagingFiles).toBe(0)
    expect(cleanup.invalidFiles).toBe(0)
    expect(cleanup.needsAttention).toBe(false)
    expect(readFileSync(detailPath)).toEqual(originalBytes)
    expect(() => readFileSync(staleStage)).toThrow()
    expect(await db.selectFrom('product_media').select('id').where('id', '=', mediaId).execute()).toHaveLength(1)
  }, 30_000)

  it('fails closed when a gallery media record is missing a processed variant', async () => {
    const auth = await loginAdmin()
    const uploaded = await uploadMedia(auth, await samplePng())
    const mediaId = uploaded.json<{ data: { id: string } }>().data.id
    const product = await createTestProduct(auth, 'D5 incomplete media fails closed')
    const gallery = await replaceGallery(auth, product.id, product.revision, [mediaId])
    expect(gallery.statusCode).toBe(200)

    await db.deleteFrom('product_media_variants').where('media_id', '=', mediaId).where('variant', '=', 'card').execute()
    const detail = await getAdminProduct(auth, product.id)
    expect(detail.statusCode).toBe(503)
    expect(detail.json().error.code).toBe('MEDIA_VARIANT_UNAVAILABLE')
  }, 30_000)
})

describe('D6 product management API additions', () => {
  it('replays product draft creation by idempotency key and rejects changed payloads', async () => {
    const auth = await loginAdmin()
    const key = randomUUID()
    const headers = { ...productHeaders(auth), 'idempotency-key': key }
    const body = productBody('D6 idempotent draft')

    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/products', headers, payload: body })
    const replayed = await app.inject({ method: 'POST', url: '/api/v1/admin/products', headers, payload: body })
    expect(created.statusCode).toBe(201)
    expect(replayed.statusCode).toBe(200)
    expect(replayed.json<{ data: ProductDetail }>().data.id).toBe(created.json<{ data: ProductDetail }>().data.id)

    const changed = await app.inject({
      method: 'POST', url: '/api/v1/admin/products', headers, payload: productBody('D6 changed payload'),
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json().error.code).toBe('PRODUCT_CREATION_KEY_CONFLICT')

    const concurrentKey = randomUUID()
    const concurrentBody = productBody('D8 concurrent idempotent draft')
    const concurrentHeaders = { ...productHeaders(auth), 'idempotency-key': concurrentKey }
    const concurrentCreates = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/admin/products', headers: concurrentHeaders, payload: concurrentBody }),
      app.inject({ method: 'POST', url: '/api/v1/admin/products', headers: concurrentHeaders, payload: concurrentBody }),
    ])
    expect(concurrentCreates.map((response) => response.statusCode).sort()).toEqual([200, 201])
    const concurrentProductIds = concurrentCreates.map((response) => response.json<{ data: ProductDetail }>().data.id)
    expect(concurrentProductIds[0]).toBe(concurrentProductIds[1])
    expect(await db.selectFrom('products').select('id').where('id', '=', concurrentProductIds[0]!).execute())
      .toHaveLength(1)
    expect(await db.selectFrom('product_management_audit_events').select('id')
      .where('product_id', '=', concurrentProductIds[0]!).where('operation', '=', 'created').execute())
      .toHaveLength(1)
  })

  it('pages and atomically updates SKU prices with revision checks', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, 'D6 paginated price management')
    const groupId = randomUUID()
    const firstValueId = randomUUID()
    const secondValueId = randomUUID()
    const matrix = await saveMatrix(auth, product.id, {
      expectedRevision: product.revision,
      mode: 'selected',
      groups: [optionGroup('版本', groupId, [{ id: firstValueId, name: '标准' }, { id: secondValueId, name: '高级' }])],
      combinations: [
        { optionValueIds: [firstValueId], salePrice: '19.90', enabled: true },
        { optionValueIds: [secondValueId], salePrice: '39.90', enabled: true },
      ],
    })
    const updatedProduct = matrix.json<{ data: { product: ProductDetail } }>().data.product
    const pageOne = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/prices?page=1&pageSize=1`,
      headers: { cookie: auth.sessionCookie },
    })
    const pageTwo = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/prices?page=2&pageSize=1`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(pageOne.statusCode).toBe(200)
    expect(pageTwo.statusCode).toBe(200)
    const first = pageOne.json<{ data: { items: Array<{ skuId: string; skuRevision: number; productRevision: number }>; total: number; totalPages: number } }>().data
    const second = pageTwo.json<{ data: { items: Array<{ skuId: string; skuRevision: number }> } }>().data
    expect(first).toMatchObject({ total: 2, totalPages: 2 })
    expect(first.items[0]?.productRevision).toBe(updatedProduct.revision)
    expect(first.items[0]?.skuId).not.toBe(second.items[0]?.skuId)

    const prices = [first.items[0]!, second.items[0]!]
    const batch = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/products/${product.id}/prices/batch`,
      headers: productHeaders(auth),
      payload: {
        expectedRevision: first.items[0]!.productRevision,
        updates: prices.map((price, index) => ({
          skuId: price.skuId,
          expectedSkuRevision: price.skuRevision,
          ...(index === 0 ? { salePrice: '18.80', compareAtPrice: '28.80' } : { salePrice: '38.80', costPrice: '1.23456' }),
        })),
      },
    })
    expect(batch.statusCode).toBe(200)
    const batchData = batch.json<{ data: { productRevision: number; items: Array<{ skuId: string; salePrice: string; compareAtPrice: string | null; costPrice: string | null }> } }>().data
    const saved = batchData.items
    expect(saved.map(item => item.salePrice).sort()).toEqual(['18.80', '38.80'])
    expect(saved.find(item => item.salePrice === '18.80')).toMatchObject({ compareAtPrice: '28.80', costPrice: null })
    expect(saved.find(item => item.salePrice === '38.80')).toMatchObject({ costPrice: '1.23456' })

    const staleBatch = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/products/${product.id}/prices/batch`,
      headers: productHeaders(auth),
      payload: {
        expectedRevision: batchData.productRevision,
        updates: prices.map((price, index) => ({
          skuId: price.skuId,
          expectedSkuRevision: index === 0 ? 99 : price.skuRevision,
          salePrice: '1.00',
        })),
      },
    })
    expect(staleBatch.statusCode).toBe(409)
    const afterConflict = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/prices?page=1&pageSize=20`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(afterConflict.json<{ data: { items: Array<{ salePrice: string }> } }>().data.items.map(item => item.salePrice).sort())
      .toEqual(['18.80', '38.80'])
  })

  it('lists reusable media, exposes the gallery cover, and filters inventory history by operation ID', async () => {
    const auth = await loginAdmin()
    const uploaded = await uploadMedia(auth, await samplePng())
    expect(uploaded.statusCode).toBe(201)
    const media = uploaded.json<{ data: { id: string; variants: Array<{ variant: string }> } }>().data
    const library = await app.inject({ method: 'GET', url: '/api/v1/admin/media?page=1&pageSize=2', headers: { cookie: auth.sessionCookie } })
    expect(library.statusCode).toBe(200)
    expect(library.json<{ data: { items: Array<{ id: string; referenceCount: number; variants: Array<{ variant: string; url: string }> }> } }>().data.items)
      .toContainEqual(expect.objectContaining({ id: media.id, referenceCount: 0, variants: expect.arrayContaining([expect.objectContaining({ variant: 'detail', url: `/api/v1/media/${media.id}/detail.webp` })]) }))

    const product = await createTestProduct(auth, 'D6 list cover and inventory operation')
    const gallery = await replaceGallery(auth, product.id, product.revision, [media.id])
    expect(gallery.statusCode).toBe(200)
    const list = await app.inject({
      method: 'GET', url: `/api/v1/admin/products?search=${encodeURIComponent(product.name)}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(list.json<{ data: { items: Array<{ coverImage: { id: string; cardUrl: string } | null }> } }>().data.items[0]?.coverImage)
      .toMatchObject({ id: media.id, cardUrl: `/api/v1/media/${media.id}/card.webp` })

    const detail = await getAdminProduct(auth, product.id)
    const current = detail.json<{ data: ProductDetail }>().data
    const sku = current.variants[0]!
    const inventoryBeforeMode = await getInventorySummary(auth, product.id)
    const inventorySku = inventoryBeforeMode.json<{ data: { variants: Array<{ skuId: string; inventoryRevision: number }> } }>().data.variants[0]!
    const mode = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: current.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: inventorySku.inventoryRevision,
      inventoryMode: 'quantity',
    })
    expect(mode.statusCode).toBe(200)
    const modeData = mode.json<{ data: { inventoryRevision: number } }>().data
    const operationId = randomUUID()
    const adjustment = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: modeData.inventoryRevision,
      operationId,
      action: 'increase',
      quantity: 3,
      reason: 'D6 operation query',
    })
    expect(adjustment.statusCode).toBe(201)
    const history = await app.inject({
      method: 'GET', url: `/api/v1/admin/products/${product.id}/variants/${sku.id}/inventory/adjustments?operationId=${operationId}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(history.statusCode).toBe(200)
    expect(history.json().data.adjustments).toHaveLength(1)
    expect(history.json().data.adjustments[0].operationId).toBe(operationId)
  }, 30_000)

  it('serves only active public products and omits disabled or retired SKU business data', async () => {
    const auth = await loginAdmin()
    const draft = await createTestProduct(auth, 'D7 草稿不可公开商品')
    const draftRead = await app.inject(`/api/v1/public/products/${draft.id}`)
    expect(draftRead.statusCode).toBe(404)

    const publishedResponse = await changeProductLifecycle(auth, draft.id, {
      expectedRevision: draft.revision, status: 'active',
    })
    expect(publishedResponse.statusCode).toBe(200)
    const published = publishedResponse.json<{ data: ProductDetail }>().data
    const publicRead = await app.inject(`/api/v1/public/products/${published.id}`)
    expect(publicRead.statusCode).toBe(200)
    expect(publicRead.headers['cache-control']).toBe('no-store')
    expect(publicRead.json().data).toMatchObject({
      id: published.id,
      name: published.name,
      selectionStatus: 'available',
      priceRange: { min: '19.90', max: '19.90', currency: 'CNY' },
    })
    const publicJson = JSON.stringify(publicRead.json().data)
    expect(publicJson).not.toMatch(/costPrice|skuCode|combination_key|revision|administrator|audit|stocked|reserved|inventoryAdjustment/iu)
    expect((await app.inject('/api/v1/public/products?pageSize=48')).json().data.items)
      .toContainEqual(expect.objectContaining({ id: published.id, priceRange: expect.objectContaining({ min: '19.90' }) }))

    const pausedResponse = await changeProductLifecycle(auth, published.id, {
      expectedRevision: published.revision, status: 'paused',
    })
    expect(pausedResponse.statusCode).toBe(200)
    const paused = pausedResponse.json<{ data: ProductDetail }>().data
    expect((await app.inject(`/api/v1/public/products/${paused.id}`)).statusCode).toBe(404)
    expect((await app.inject(`/api/v1/public/search?q=${encodeURIComponent(paused.name)}`)).json().data.items)
      .not.toContainEqual(expect.objectContaining({ id: paused.id }))

    const archivedResponse = await changeProductLifecycle(auth, paused.id, {
      expectedRevision: paused.revision, status: 'archived',
    })
    expect(archivedResponse.statusCode).toBe(200)
    const archived = archivedResponse.json<{ data: ProductDetail }>().data
    expect((await app.inject(`/api/v1/public/products/${archived.id}`)).statusCode).toBe(404)
    const deleted = await deleteProduct(auth, archived.id, archived.revision)
    expect(deleted.statusCode).toBe(200)
    expect((await app.inject(`/api/v1/public/products/${archived.id}`)).statusCode).toBe(404)

    const disabled = await createTestProduct(auth, 'D7 所有规格停用仍可展示')
    const groupId = randomUUID()
    const valueId = randomUUID()
    const matrix = await saveMatrix(auth, disabled.id, {
      expectedRevision: disabled.revision,
      mode: 'selected',
      groups: [optionGroup('期限', groupId, [{ id: valueId, name: '月卡' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '8.80', enabled: false }],
    })
    expect(matrix.statusCode).toBe(200)
    await db.updateTable('product_variants').set({ cost_price: '7.12345', inventory_mode: 'external' })
      .where('product_id', '=', disabled.id).execute()
    const disabledBeforePublish = await getAdminProduct(auth, disabled.id)
    const disabledLiveResponse = await changeProductLifecycle(auth, disabled.id, {
      expectedRevision: disabledBeforePublish.json<{ data: ProductDetail }>().data.revision, status: 'active',
    })
    expect(disabledLiveResponse.statusCode, disabledLiveResponse.body).toBe(200)

    const disabledCard = await app.inject('/api/v1/public/products?pageSize=48')
    expect(disabledCard.statusCode).toBe(200)
    expect(disabledCard.json().data.items).toContainEqual(expect.objectContaining({
      id: disabled.id,
      priceRange: null,
      selectionStatus: 'none',
      inventoryStatus: 'not_applicable',
    }))
    const largeRichContent = {
      type: 'doc' as const,
      content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: '<'.repeat(50_000) }] }],
    }
    await db.updateTable('products').set({ rich_content: largeRichContent }).where('id', '=', disabled.id).execute()
    const disabledDetail = await app.inject(`/api/v1/public/products/${disabled.id}`)
    expect(disabledDetail.statusCode).toBe(200)
    expect(disabledDetail.json().data).toMatchObject({
      selectionStatus: 'none',
      priceRange: null,
      variants: [],
      optionGroups: [{ id: groupId, values: [{ id: valueId, available: false }] }],
    })
    expect(disabledDetail.json().data.richContentHtml.length).toBeGreaterThan(200_000)
    expect(disabledDetail.json().data.richContentHtml.length).toBeGreaterThan(200_000)
    expect(JSON.stringify(disabledDetail.json().data)).not.toMatch(/7\.12345|costPrice|skuCode|combination_key|inventoryAdjustment/iu)

    const retired = await createTestProduct(auth, 'D7 退役规格价格不可公开')
    await db.updateTable('product_variants').set({ enabled: false, retired_at: new Date(), cost_price: '2.12345' })
      .where('id', '=', retired.variants[0]!.id).execute()
    const retiredBeforePublish = await getAdminProduct(auth, retired.id)
    const retiredResponse = await changeProductLifecycle(auth, retired.id, {
      expectedRevision: retiredBeforePublish.json<{ data: ProductDetail }>().data.revision, status: 'active',
    })
    expect(retiredResponse.statusCode).toBe(200)
    const retiredPublic = await app.inject(`/api/v1/public/products/${retired.id}`)
    expect(retiredPublic.statusCode).toBe(200)
    expect(retiredPublic.json().data).toMatchObject({ selectionStatus: 'none', priceRange: null, variants: [] })
  }, 30_000)

  it('publishes a four-level visible category tree and searches public Chinese product text without duplicates', async () => {
    const auth = await loginAdmin()
    const createCategory = async (name: string, parentId?: string, isVisible = true) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth),
        payload: { name, ...(parentId ? { parentId } : {}), isVisible },
      })
      expect(response.statusCode).toBe(201)
      return response.json<{ data: { id: string; revision: number } }>().data
    }
    const root = await createCategory('D7可见根类')
    const level2 = await createCategory('D7可见二级', root.id)
    const level3 = await createCategory('D7可见三级', level2.id)
    const level4 = await createCategory('D7可见四级', level3.id)
    const hidden = await createCategory('D7隐藏祖先', undefined, false)
    const hiddenDescendant = await createCategory('D7隐藏后代', hidden.id)

    const product = await createTestProduct(auth, 'D7公开商品中文检索词')
    const assigned = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${product.id}/categories`, headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision,
        assignments: [
          { categoryId: root.id, isPrimary: true, sortOrder: 2 },
          { categoryId: level4.id, isPrimary: false, sortOrder: 1 },
          { categoryId: hiddenDescendant.id, isPrimary: false, sortOrder: 0 },
        ],
      },
    })
    expect(assigned.statusCode).toBe(200)
    const assignedProduct = assigned.json<{ data: ProductDetail }>().data
    const published = await changeProductLifecycle(auth, product.id, {
      expectedRevision: assignedProduct.revision, status: 'active',
    })
    expect(published.statusCode).toBe(200)

    const publicTree = await app.inject('/api/v1/public/categories')
    expect(publicTree.statusCode).toBe(200)
    const categories = publicTree.json<{ data: { categories: Array<{ id: string; level: number; path: Array<{ id: string }> }> } }>().data.categories
    expect(categories.find(item => item.id === root.id)?.level).toBe(0)
    const publicLevel4 = categories.find(item => item.id === level4.id)!
    expect(publicLevel4.level).toBe(3)
    expect(publicLevel4.path.map(item => item.id)).toEqual([root.id, level2.id, level3.id, level4.id])
    expect(categories.map(item => item.id)).not.toContain(hidden.id)
    expect(categories.map(item => item.id)).not.toContain(hiddenDescendant.id)

    const rootProducts = await app.inject(`/api/v1/public/categories/${root.id}/products?page=1&pageSize=48`)
    expect(rootProducts.statusCode).toBe(200)
    expect(rootProducts.json().data.products.items.filter((item: { id: string }) => item.id === product.id)).toHaveLength(1)
    expect((await app.inject(`/api/v1/public/categories/${hiddenDescendant.id}/products`)).statusCode).toBe(404)

    const search = await app.inject(`/api/v1/public/search?q=${encodeURIComponent('中文检索词')}&categoryId=${root.id}&sort=price_asc`)
    expect(search.statusCode).toBe(200)
    expect(search.json().data.items.map((item: { id: string }) => item.id)).toContain(product.id)
    const blankSearch = await app.inject('/api/v1/public/search?q=%20%20')
    expect(blankSearch.statusCode).toBe(400)
    const sitemap = await app.inject('/api/v1/public/sitemap?page=1&pageSize=50000')
    expect(sitemap.json().data.items).toContainEqual(expect.objectContaining({ type: 'product', id: product.id }))
    expect(sitemap.json().data.items).not.toContainEqual(expect.objectContaining({ type: 'product', id: hiddenDescendant.id }))
  }, 30_000)

  it('exposes only truthful public inventory summaries independently from SKU selection and price', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, 'D7 公开库存状态')
    const variant = product.variants[0]!
    const published = await changeProductLifecycle(auth, product.id, {
      expectedRevision: product.revision, status: 'active',
    })
    expect(published.statusCode).toBe(200)

    const initial = await app.inject(`/api/v1/public/products/${product.id}`)
    expect(initial.statusCode).toBe(200)
    expect(initial.json().data.variants[0].inventory).toMatchObject({ mode: null, status: 'not_configured' })

    const pausedForQuantity = await changeProductLifecycle(auth, product.id, {
      expectedRevision: published.json<{ data: ProductDetail }>().data.revision, status: 'paused',
    })
    expect(pausedForQuantity.statusCode).toBe(200)
    const quantityMode = await setInventoryMode(auth, product.id, variant.id, {
      expectedRevision: pausedForQuantity.json<{ data: ProductDetail }>().data.revision,
      expectedSkuRevision: variant.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    expect(quantityMode.statusCode).toBe(200)
    let state = quantityMode.json<{ data: { productRevision: number; skuRevision: number; inventoryRevision: number } }>().data
    const liveQuantity = await changeProductLifecycle(auth, product.id, {
      expectedRevision: state.productRevision, status: 'active',
    })
    expect(liveQuantity.statusCode).toBe(200)
    state.productRevision = liveQuantity.json<{ data: ProductDetail }>().data.revision
    expect((await app.inject(`/api/v1/public/products/${product.id}`)).json().data.variants[0].inventory)
      .toMatchObject({ mode: 'quantity', status: 'out_of_stock' })

    const stocked = await adjustInventory(auth, product.id, variant.id, {
      expectedInventoryRevision: state.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 2, reason: 'D7 前台库存验收',
    })
    expect(stocked.statusCode).toBe(201)
    state.inventoryRevision = stocked.json<{ data: { inventoryRevision: number } }>().data.inventoryRevision
    const inStock = await app.inject(`/api/v1/public/products/${product.id}`)
    expect(inStock.json().data.variants[0].inventory).toMatchObject({ mode: 'quantity', status: 'in_stock' })

    const reservedOrderId = await createReservedOrderForTest(auth, product.id, variant.id, 2)
    const fullyReserved = await app.inject(`/api/v1/public/products/${product.id}`)
    expect(fullyReserved.json().data.variants[0].inventory).toMatchObject({ mode: 'quantity', status: 'out_of_stock' })
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', reservedOrderId).execute()
    const afterOrderRelease = await db.selectFrom('product_variants').select('inventory_revision')
      .where('id', '=', variant.id).executeTakeFirstOrThrow()
    const drained = await adjustInventory(auth, product.id, variant.id, {
      expectedInventoryRevision: afterOrderRelease.inventory_revision,
      operationId: randomUUID(), action: 'decrease', quantity: 2, reason: 'D7 库存模式切换验收',
    })
    expect(drained.statusCode).toBe(201)
    state.inventoryRevision = drained.json<{ data: { inventoryRevision: number } }>().data.inventoryRevision

    for (const [mode, expected] of [
      ['external', { mode: 'external', status: 'not_ready' }],
      ['resource_pool', { mode: 'resource_pool', status: 'not_ready' }],
      ['unlimited', { mode: 'unlimited', status: 'unlimited' }],
    ] as const) {
      const pauseForModeChange = await changeProductLifecycle(auth, product.id, {
        expectedRevision: state.productRevision, status: 'paused',
      })
      expect(pauseForModeChange.statusCode).toBe(200)
      state.productRevision = pauseForModeChange.json<{ data: ProductDetail }>().data.revision
      const changed = await setInventoryMode(auth, product.id, variant.id, {
        expectedRevision: state.productRevision,
        expectedSkuRevision: state.skuRevision,
        expectedInventoryRevision: state.inventoryRevision,
        inventoryMode: mode,
      })
      expect(changed.statusCode, changed.body).toBe(200)
      state = changed.json<{ data: typeof state }>().data
      const restoreToActive = await changeProductLifecycle(auth, product.id, {
        expectedRevision: state.productRevision, status: 'active',
      })
      expect(restoreToActive.statusCode).toBe(200)
      state.productRevision = restoreToActive.json<{ data: ProductDetail }>().data.revision
      const publicDetail = await app.inject(`/api/v1/public/products/${product.id}`)
      expect(publicDetail.statusCode).toBe(200)
      expect(publicDetail.json().data.variants[0].inventory).toMatchObject(expected)
      expect(JSON.stringify(publicDetail.json().data)).not.toMatch(/stocked|reserved|inventoryAdjustment/iu)
    }

    expect((await app.inject('/api/v1/public/products')).headers['cache-control']).toBe('no-store')
    expect((await app.inject('/api/v1/public/categories')).headers['cache-control']).toBe('no-store')
  }, 30_000)
})

describe('D8 cross-module PostgreSQL concurrency acceptance', () => {
  it('returns serialization conflicts as 409 and keeps database deadlocks as redacted server errors', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, 'D8 deadlock classification probe')
    await sql`CREATE FUNCTION d8_raise_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.name = 'D8 deadlock classification probe' THEN
          RAISE EXCEPTION 'synthetic PostgreSQL deadlock' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END; $$`.execute(db)
    await sql`CREATE TRIGGER d8_raise_deadlock BEFORE UPDATE OF name ON products
      FOR EACH ROW EXECUTE FUNCTION d8_raise_deadlock()`.execute(db)
    let response: Awaited<ReturnType<typeof editProduct>> | undefined
    try {
      response = await editProduct(auth, product.id, {
        expectedRevision: product.revision, name: 'This update must fail closed',
      })
    } finally {
      await sql`DROP TRIGGER d8_raise_deadlock ON products`.execute(db)
      await sql`DROP FUNCTION d8_raise_deadlock()`.execute(db)
    }
    expect(response!.statusCode).toBe(500)
    expect(response!.json().error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' })
    expect(response!.body).not.toContain('synthetic PostgreSQL deadlock')
    expect((await getAdminProduct(auth, product.id)).json<{ data: ProductDetail }>().data.name)
      .toBe('D8 deadlock classification probe')
  })

  it('serializes edits from two independent administrator sessions by product revision', async () => {
    const firstAdmin = await loginAdmin()
    const secondEmail = `d8-${randomUUID()}@example.com`
    const secondPassword = 'Second-Admin-Only-Password-2026!'
    await db.insertInto('admin_users').values({
      id: randomUUID(), email: secondEmail, password_hash: await hashPassword(secondPassword), is_active: true,
    }).execute()
    const secondAdmin = await loginAdmin(app, { email: secondEmail, password: secondPassword })
    const product = await createTestProduct(firstAdmin, 'D8 双管理员修订竞争')

    const results = await Promise.all([
      editProduct(firstAdmin, product.id, { expectedRevision: product.revision, name: '双管理员编辑甲' }),
      editProduct(secondAdmin, product.id, { expectedRevision: product.revision, name: '双管理员编辑乙' }),
    ])
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(results.find((response) => response.statusCode === 409)?.json().error.code)
      .toBe('PRODUCT_REVISION_CONFLICT')

    const current = (await getAdminProduct(firstAdmin, product.id)).json<{ data: ProductDetail }>().data
    expect(['双管理员编辑甲', '双管理员编辑乙']).toContain(current.name)
    expect(current.revision).toBe(product.revision + 1)
    const winningIndex = results.findIndex((response) => response.statusCode === 200)
    const winningEmail = winningIndex === 0 ? testEmail : secondEmail
    const winningAdmin = await db.selectFrom('admin_users').select('id')
      .where('email', '=', winningEmail).executeTakeFirstOrThrow()
    const editEvents = await db.selectFrom('product_management_audit_events')
      .select(['administrator_id', 'operation']).where('product_id', '=', product.id).execute()
    expect(editEvents).toHaveLength(2)
    expect(editEvents.map((event) => event.administrator_id)).toContain(winningAdmin.id)
  })

  it('serializes archive against SKU matrix and rich-content edits', async () => {
    const auth = await loginAdmin()
    const matrixProduct = await createTestProduct(auth, 'D8 归档与 SKU 矩阵竞争')
    const matrixGroupId = randomUUID()
    const matrixValueId = randomUUID()
    const [archive, matrix] = await Promise.all([
      changeProductLifecycle(auth, matrixProduct.id, {
        expectedRevision: matrixProduct.revision, status: 'archived',
      }),
      saveMatrix(auth, matrixProduct.id, {
        expectedRevision: matrixProduct.revision,
        mode: 'selected',
        groups: [optionGroup('授权期限', matrixGroupId, [{ id: matrixValueId, name: '年度' }])],
        combinations: [{ optionValueIds: [matrixValueId], salePrice: '38.00', enabled: true }],
      }),
    ])
    expect([archive.statusCode, matrix.statusCode].sort()).toEqual([200, 409])
    const matrixConflict = matrix.json().error
    expect(matrix.statusCode === 409 ? matrixConflict.code : archive.json().error.code)
      .toBe('PRODUCT_REVISION_CONFLICT')
    const matrixFinal = (await getAdminProduct(auth, matrixProduct.id)).json<{ data: ProductDetail }>().data
    if (archive.statusCode === 200) {
      expect(matrixFinal.status).toBe('archived')
      expect(matrixFinal.optionGroups).toHaveLength(0)
    } else {
      expect(matrixFinal.status).toBe('draft')
      expect(matrixFinal.optionGroups).toHaveLength(1)
      expect(matrixFinal.variants[0]?.salePrice).toBe('38.00')
    }

    const richProduct = await createTestProduct(auth, 'D8 归档与富文本竞争')
    const richDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '归档竞争中的真实商品正文' }] }],
    }
    const [richArchive, richSave] = await Promise.all([
      changeProductLifecycle(auth, richProduct.id, {
        expectedRevision: richProduct.revision, status: 'archived',
      }),
      saveRichContent(auth, richProduct.id, richProduct.revision, richDocument),
    ])
    expect([richArchive.statusCode, richSave.statusCode].sort()).toEqual([200, 409])
    const richFinal = (await getAdminProduct(auth, richProduct.id)).json<{ data: ProductDetail }>().data
    if (richArchive.statusCode === 200) {
      expect(richFinal.status).toBe('archived')
      expect(JSON.stringify(richFinal.richContent)).not.toContain('归档竞争中的真实商品正文')
    } else {
      expect(richFinal.status).toBe('draft')
      expect(richFinal.richContent).toEqual(richDocument)
    }
  })

  it('serializes SKU retirement against inventory deduction and deduplicates retried deductions', async () => {
    const auth = await loginAdmin()
    const product = await createTestProduct(auth, 'D8 SKU 退役与扣减竞争')
    const sku = product.variants[0]!
    const modeResponse = await setInventoryMode(auth, product.id, sku.id, {
      expectedRevision: product.revision,
      expectedSkuRevision: sku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const mode = modeResponse.json<{ data: { productRevision: number; inventoryRevision: number } }>().data
    const replenished = await adjustInventory(auth, product.id, sku.id, {
      expectedInventoryRevision: mode.inventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 5, reason: 'D8 退役竞争预置库存',
    })
    const replenishedRevision = replenished.json<{ data: { inventoryRevision: number } }>().data.inventoryRevision
    const groupId = randomUUID()
    const valueId = randomUUID()
    const retirementBody = {
      expectedRevision: mode.productRevision,
      mode: 'selected',
      groups: [optionGroup('交付周期', groupId, [{ id: valueId, name: '一季' }])],
      combinations: [{ optionValueIds: [valueId], salePrice: '19.00', enabled: true }],
      retireSkuIds: [sku.id],
    }
    const [deduction, retirement] = await Promise.all([
      adjustInventory(auth, product.id, sku.id, {
        expectedInventoryRevision: replenishedRevision,
        operationId: randomUUID(), action: 'decrease', quantity: 5, reason: 'D8 与 SKU 退役同时扣减',
      }),
      saveMatrix(auth, product.id, retirementBody),
    ])
    const finalInventory = (await getInventorySummary(auth, product.id))
      .json<{ data: { variants: Array<{ skuId: string; retiredAt: string | null; inventory: { stocked: number } }> } }>()
      .data.variants.find((variant) => variant.skuId === sku.id)!
    expect(deduction.statusCode).toBe(201)
    if (retirement.statusCode === 200) {
      expect(finalInventory).toMatchObject({ retiredAt: expect.any(String), inventory: { stocked: 0 } })
    } else {
      expect(retirement.statusCode).toBe(409)
      expect(retirement.json().error.code).toBe('SKU_STOCK_NOT_CLEARED')
      expect(finalInventory).toMatchObject({ retiredAt: null, inventory: { stocked: 0 } })
    }

    const retryProduct = await createTestProduct(auth, 'D8 扣减请求安全重放')
    const retrySku = retryProduct.variants[0]!
    const retryMode = await setInventoryMode(auth, retryProduct.id, retrySku.id, {
      expectedRevision: retryProduct.revision,
      expectedSkuRevision: retrySku.revision,
      expectedInventoryRevision: 0,
      inventoryMode: 'quantity',
    })
    const retryInventoryRevision = retryMode.json<{ data: { inventoryRevision: number } }>().data.inventoryRevision
    const refill = await adjustInventory(auth, retryProduct.id, retrySku.id, {
      expectedInventoryRevision: retryInventoryRevision,
      operationId: randomUUID(), action: 'increase', quantity: 3, reason: 'D8 扣减幂等预置',
    })
    const operation = {
      expectedInventoryRevision: refill.json<{ data: { inventoryRevision: number } }>().data.inventoryRevision,
      operationId: randomUUID(), action: 'decrease', quantity: 3, reason: 'D8 幂等扣减重放',
    }
    const retries = await Promise.all([
      adjustInventory(auth, retryProduct.id, retrySku.id, operation),
      adjustInventory(auth, retryProduct.id, retrySku.id, operation),
    ])
    expect(retries.map((response) => response.statusCode).sort()).toEqual([200, 201])
    expect(retries[0]!.json().data.id).toBe(retries[1]!.json().data.id)
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${retryProduct.id}/variants/${retrySku.id}/inventory/adjustments?operationId=${operation.operationId}`,
      headers: { cookie: auth.sessionCookie },
    })
    expect(history.json().data.adjustments).toHaveLength(1)
    expect((await getInventorySummary(auth, retryProduct.id)).json().data.variants[0].inventory.stocked).toBe(0)
  }, 30_000)

  it('serializes concurrent category moves through the public API and shared PostgreSQL tree guard', async () => {
    const auth = await loginAdmin()
    const createCategory = async (name: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/admin/categories', headers: productHeaders(auth), payload: { name },
      })
      expect(response.statusCode).toBe(201)
      return response.json<{ data: { id: string; revision: number } }>().data
    }
    const left = await createCategory('D8 并发分类左')
    const right = await createCategory('D8 并发分类右')
    const moving = await createCategory('D8 并发移动目标')
    const results = await Promise.all([
      app.inject({
        method: 'PATCH', url: `/api/v1/admin/categories/${moving.id}`, headers: productHeaders(auth),
        payload: { expectedRevision: moving.revision, parentId: left.id },
      }),
      app.inject({
        method: 'PATCH', url: `/api/v1/admin/categories/${moving.id}`, headers: productHeaders(auth),
        payload: { expectedRevision: moving.revision, parentId: right.id },
      }),
    ])
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(results.find((response) => response.statusCode === 409)?.json().error.code)
      .toBe('CATEGORY_REVISION_CONFLICT')
    const current = (await app.inject({ method: 'GET', url: '/api/v1/admin/categories', headers: { cookie: auth.sessionCookie } }))
      .json<{ data: { categories: Array<{ id: string; parentId: string | null }> } }>().data.categories
      .find((category) => category.id === moving.id)
    expect([left.id, right.id]).toContain(current?.parentId)
  })

  it('serializes batched SKU price changes against an ordinary product edit without partial prices', async () => {
    const auth = await loginAdmin()
    const created = await createTestProduct(auth, 'D8 批量价格与普通编辑竞争')
    const groupId = randomUUID()
    const valueIds = [randomUUID(), randomUUID()]
    const matrix = await saveMatrix(auth, created.id, {
      expectedRevision: created.revision,
      mode: 'selected',
      groups: [optionGroup('批量规格', groupId, [
        { id: valueIds[0]!, name: '入门' }, { id: valueIds[1]!, name: '完整' },
      ])],
      combinations: [
        { optionValueIds: [valueIds[0]!], salePrice: '10.00', enabled: true },
        { optionValueIds: [valueIds[1]!], salePrice: '20.00', enabled: true },
      ],
    })
    const product = matrix.json<{ data: { product: ProductDetail } }>().data.product
    const batch = app.inject({
      method: 'PATCH', url: `/api/v1/admin/products/${product.id}/prices/batch`, headers: productHeaders(auth),
      payload: {
        expectedRevision: product.revision,
        updates: product.variants.map((variant, index) => ({
          skuId: variant.id,
          expectedSkuRevision: variant.revision,
          salePrice: index === 0 ? '12.00' : '22.00',
        })),
      },
    })
    const ordinaryEdit = editProduct(auth, product.id, {
      expectedRevision: product.revision, name: 'D8 普通资料编辑胜出',
    })
    const [batchResult, editResult] = await Promise.all([batch, ordinaryEdit])
    expect([batchResult.statusCode, editResult.statusCode].sort()).toEqual([200, 409])
    const final = (await getAdminProduct(auth, product.id)).json<{ data: ProductDetail }>().data
    if (batchResult.statusCode === 200) {
      expect(editResult.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
      expect(final.name).toBe(product.name)
      expect(final.variants.map((variant) => variant.salePrice).sort()).toEqual(['12.00', '22.00'])
    } else {
      expect(batchResult.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
      expect(final.name).toBe('D8 普通资料编辑胜出')
      expect(final.variants.map((variant) => variant.salePrice).sort()).toEqual(['10.00', '20.00'])
    }
  })

  it('copies a consistent source snapshot while specification changes compete for the same product lock', async () => {
    const auth = await loginAdmin()
    const created = await createTestProduct(auth, 'D8 复制与规格变更竞争')
    const groupId = randomUUID()
    const valueIds = [randomUUID(), randomUUID()]
    const initial = await saveMatrix(auth, created.id, {
      expectedRevision: created.revision,
      mode: 'selected',
      groups: [optionGroup('初始方案', groupId, [
        { id: valueIds[0]!, name: '月度' }, { id: valueIds[1]!, name: '年度' },
      ])],
      combinations: [
        { optionValueIds: [valueIds[0]!], salePrice: '9.00', enabled: true },
        { optionValueIds: [valueIds[1]!], salePrice: '49.00', enabled: true },
      ],
    })
    const source = initial.json<{ data: { product: ProductDetail } }>().data.product
    const changedSpecifications = {
      expectedRevision: source.revision,
      mode: 'selected',
      groups: [optionGroup('更新方案', groupId, [
        { id: valueIds[0]!, name: '月卡' }, { id: valueIds[1]!, name: '年卡' },
      ])],
      combinations: source.variants.map((variant) => ({
        skuId: variant.id,
        optionValueIds: variant.options.map((option) => option.valueId),
        salePrice: variant.salePrice,
        enabled: variant.enabled,
      })),
    }
    const [copy, matrix] = await Promise.all([
      copyProduct(auth, source.id, source.revision),
      saveMatrix(auth, source.id, changedSpecifications),
    ])
    expect(matrix.statusCode).toBe(200)
    expect([201, 409]).toContain(copy.statusCode)
    const updatedSource = matrix.json<{ data: { product: ProductDetail } }>().data.product
    expect(updatedSource.optionGroups[0]?.name).toBe('更新方案')
    expect(updatedSource.variants.map((variant) => variant.options[0]?.valueName).sort()).toEqual(['年卡', '月卡'])
    if (copy.statusCode === 201) {
      const clone = copy.json<{ data: ProductDetail }>().data
      expect(clone.id).not.toBe(source.id)
      expect(clone.optionGroups[0]?.name).toBe('初始方案')
      expect(clone.variants.map((variant) => variant.options[0]?.valueName).sort()).toEqual(['年度', '月度'])
      expect(clone.variants.every((variant) => !source.variants.some((original) => original.id === variant.id))).toBe(true)
    } else {
      expect(copy.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
      expect(await db.selectFrom('products').select('id').where('name', '=', source.name).execute()).toHaveLength(1)
    }
  }, 30_000)
})
