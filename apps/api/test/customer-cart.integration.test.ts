import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import type { AppConfig } from '../src/config.js'
import { hashPassword } from '../src/auth/password.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { createDatabase } from '../src/db/pool.js'
import type { Database, ProductInventoryMode, ProductStatus } from '../src/db/types.js'
import { createPurchaseDraft, getPurchaseDraft, savePurchaseDraft, requestPurchaseDraftDeletion } from '../src/commerce/purchase-forms.js'
import { getOwnedOrderPurchaseSnapshot } from '../src/commerce/purchase-order-attachments.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const testOrigin = 'http://localhost:3000'
const password = 'Cart-Integration-Password-2026!'

let app: FastifyInstance
let db: Kysely<Database>
let config: AppConfig
let nextIp = 10

type CustomerFixture = { id: string; sessionCookie: string; csrf: { token: string; cookie: string } }
type CatalogFixture = { productId: string; skuId: string; productName: string }

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find(value => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0] ?? ''
}

async function customerCsrf(target: FastifyInstance = app) {
  const response = await target.inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
  expect(response.statusCode).toBe(200)
  return { token: response.json().data.csrfToken as string, cookie: cookieFrom(response, 'aikayun_customer_csrf') }
}

function customerHeaders(customer: CustomerFixture, includeSession = true) {
  return {
    origin: testOrigin,
    cookie: [includeSession ? customer.sessionCookie : '', customer.csrf.cookie].filter(Boolean).join('; '),
    'x-csrf-token': customer.csrf.token,
  }
}

async function createCustomer(): Promise<CustomerFixture> {
  const csrf = await customerCsrf()
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/customer/auth/register',
    remoteAddress: `198.51.100.${nextIp++}`,
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    payload: { username: `cart-${randomUUID().replaceAll('-', '').slice(0, 20)}`, password },
  })
  expect(response.statusCode).toBe(201)
  return {
    id: response.json().data.customer.id as string,
    sessionCookie: cookieFrom(response, 'aikayun_customer_session'),
    csrf,
  }
}

async function createAdminSession() {
  const email = `cart-admin-${randomUUID().slice(0, 8)}@example.test`
  const id = randomUUID()
  await db.insertInto('admin_users').values({ id, email, password_hash: await hashPassword(password) }).execute()
  const csrfResponse = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  const csrf = csrfResponse.json().data.csrfToken as string
  const csrfCookie = cookieFrom(csrfResponse, 'aikayun_admin_csrf')
  const login = await app.inject({
    method: 'POST', url: '/api/v1/admin/auth/login',
    headers: { origin: testOrigin, cookie: csrfCookie, 'x-csrf-token': csrf },
    payload: { email, password },
  })
  expect(login.statusCode).toBe(200)
  return {
    id,
    csrf,
    cookie: `${cookieFrom(login, 'aikayun_admin_session')}; ${csrfCookie}`,
  }
}

async function createCatalog(options: {
  price?: string
  mode?: ProductInventoryMode | null
  stocked?: number
  status?: ProductStatus
  enabled?: boolean
  retired?: boolean
  fulfillmentMethod?: 'manual' | 'code_pool' | 'fixed_content' | 'link' | 'file' | 'api' | null
  count?: number
} = {}): Promise<CatalogFixture[]> {
  const result: CatalogFixture[] = []
  await db.transaction().execute(async (trx) => {
    for (let index = 0; index < (options.count ?? 1); index += 1) {
      const productId = randomUUID()
      const skuId = randomUUID()
      const productName = `Cart fixture ${randomUUID().slice(0, 8)}`
      await trx.insertInto('products').values({
        id: productId,
        name: productName,
        description: '',
        product_type: 'digital',
        status: options.status ?? 'active',
      }).execute()
      await trx.insertInto('product_variants').values({
        id: skuId,
        product_id: productId,
        sku_code: `CART-${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        combination_key: '',
        sale_price: options.price ?? '0.10',
        enabled: options.enabled ?? true,
        retired_at: options.retired ? new Date() : null,
        inventory_mode: options.mode ?? null,
      }).execute()
      if (options.mode === 'quantity') {
        await trx.insertInto('product_variant_quantity_inventory').values({
          product_id: productId,
          product_variant_id: skuId,
          stocked: options.stocked ?? 10,
        }).execute()
      }
      if (options.fulfillmentMethod) {
        await trx.insertInto('product_variant_fulfillment').values({
          product_variant_id: skuId,
          method: options.fulfillmentMethod,
        }).execute()
      }
      result.push({ productId, skuId, productName })
    }
  })
  return result
}

async function createOptionCatalog(): Promise<CatalogFixture> {
  const productId = randomUUID()
  const skuId = randomUUID()
  const groupId = randomUUID()
  const valueId = randomUUID()
  const productName = `Cart option fixture ${randomUUID().slice(0, 8)}`
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: productId, name: productName, description: '', product_type: 'digital', status: 'active',
    }).execute()
    await trx.insertInto('product_option_groups').values({
      id: groupId, product_id: productId, name: '套餐', sort_order: 0, enabled: true,
    }).execute()
    await trx.insertInto('product_option_values').values({
      id: valueId, product_id: productId, option_group_id: groupId, name: '基础版', sort_order: 0, enabled: true,
    }).execute()
    await trx.insertInto('product_variants').values({
      id: skuId, product_id: productId, sku_code: `CART-${randomUUID().slice(0, 12)}`,
      combination_key: '', sale_price: '0.50', enabled: true, retired_at: null, inventory_mode: null,
    }).execute()
    await trx.insertInto('product_variant_option_values').values({
      product_id: productId, product_variant_id: skuId, option_group_id: groupId, option_value_id: valueId,
    }).execute()
    await sql`UPDATE product_variants SET combination_key = product_variant_combination_key(${productId}::uuid, ${skuId}::uuid) WHERE id = ${skuId}::uuid`.execute(trx)
  })
  return { productId, skuId, productName }
}

async function addCartItem(customer: CustomerFixture, skuId: string, quantity: number, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: 'POST', url: '/api/v1/customer/cart/items',
    headers: { ...customerHeaders(customer), ...extraHeaders },
    payload: { skuId, quantity },
  })
}

async function findQueryBlockedBy(queryFragment: string, blockerPid: number, excludePid?: number): Promise<number | null> {
  const activity = await sql<{ pid: number }>`
    SELECT activity.pid
    FROM pg_stat_activity AS activity
    WHERE activity.datname = current_database()
      AND activity.application_name = 'aikayun-api'
      AND activity.state = 'active'
      AND activity.wait_event_type = 'Lock'
      AND activity.query ILIKE ${`%${queryFragment}%`}
      AND (${excludePid ?? -1} = -1 OR activity.pid <> ${excludePid ?? -1})
      AND ${blockerPid} = ANY(pg_blocking_pids(activity.pid))
    LIMIT 1
  `.execute(db)
  return activity.rows[0] ? Number(activity.rows[0].pid) : null
}

async function waitForQueryBlockedBy(queryFragment: string, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const pid = await findQueryBlockedBy(queryFragment, blockerPid)
    if (pid !== null) return pid
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Expected a PostgreSQL query containing ${queryFragment} to wait on PID ${blockerPid}`)
}

async function quote(items: Array<{ skuId: string; quantity: number }>, customer?: CustomerFixture,
  remoteAddress?: string) {
  const csrf = customer?.csrf ?? await customerCsrf()
  return app.inject({
    method: 'POST', url: '/api/v1/checkout/quote',
    remoteAddress,
    headers: {
      origin: testOrigin,
      cookie: [customer?.sessionCookie, csrf.cookie].filter(Boolean).join('; '),
      'x-csrf-token': csrf.token,
    },
    payload: { items },
  })
}

beforeAll(async () => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test')
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run cart API integration tests unless TEST_DATABASE_URL names a database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`drop schema public cascade`.execute(db)
  await sql`create schema public`.execute(db)
  const { Migrator } = await import('kysely/migration')
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  const repeated = await migrator.migrateToLatest()
  if (repeated.error) throw repeated.error

  config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: testOrigin,
    COOKIE_SECURE: 'false',
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({ activeKeyId: 'purchase-line-test',
      keys: { 'purchase-line-test': Buffer.alloc(32, 0x51).toString('base64') } }),
  })
  app = await createApp({ db, config, logger: false })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
})

beforeEach(async () => {
  // Each scenario starts from the real migrated lifecycle default. Production never permits
  // returning from active to preparing; schema reset is confined to the dedicated _test DB.
  if (app) await app.close()
  await sql`drop schema public cascade`.execute(db)
  await sql`create schema public`.execute(db)
  const { Migrator } = await import('kysely/migration')
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  const repeated = await migrator.migrateToLatest()
  if (repeated.error) throw repeated.error
  app = await createApp({ db, config, logger: false })
  await app.ready()
})

describe('customer cart and checkout quote with PostgreSQL', () => {
  it('activates a frozen SKU form explicitly, uses owner-bound HTTP drafts and preserves orders across pause', async () => {
    const admin = await createAdminSession()
    const [catalog] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', catalog!.skuId).execute()
    const accountId = randomUUID()
    const regionId = randomUUID()
    const optionId = randomUUID()
    const forgedOptionId = randomUUID()
    const definition = { fields: [
      { id: accountId, meaningKey: 'account_id', type: 'digits', label: '账号编号', required: true, maxLength: 64 },
      { id: regionId, meaningKey: 'region', type: 'select', label: '区服', required: true,
        options: [{ id: optionId, meaningKey: 'east', label: '东区' }] },
    ] }
    const adminHeaders = { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf }
    const templateResponse = await app.inject({ method: 'POST', url: '/api/v1/admin/purchase-form-templates',
      headers: adminHeaders, payload: { name: '正式流程 PostgreSQL 模板', definition } })
    expect(templateResponse.statusCode, JSON.stringify(templateResponse.json())).toBe(201)
    const template = templateResponse.json().data.template as { id: string; revision: number }
    const frozen = await app.inject({ method: 'POST', url: `/api/v1/admin/purchase-form-templates/${template.id}/versions`,
      headers: adminHeaders, payload: { expectedRevision: template.revision } })
    expect(frozen.statusCode, JSON.stringify(frozen.json())).toBe(201)
    const versionId = frozen.json().data.id as string
    const product = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog!.productId).executeTakeFirstOrThrow()
    const prepared = await app.inject({ method: 'PUT', url: `/api/v1/admin/products/${catalog!.productId}/purchase-form`,
      headers: adminHeaders, payload: { expectedRevision: product.revision, mode: 'template', templateVersionId: versionId } })
    expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(200)

    const preparingForm = await app.inject({ method: 'GET', url: `/api/v1/storefront/skus/${catalog!.skuId}/purchase-form` })
    expect(preparingForm.json().data).toMatchObject({ status: 'preparing', required: false, templateVersionId: null })
    const owner = await createCustomer()
    const inactiveCreate = await app.inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId } })
    expect(inactiveCreate.statusCode).toBe(409)

    const impact = await app.inject({ method: 'GET', url: '/api/v1/admin/storefront/purchase-forms', headers: adminHeaders })
    expect(impact.json().data).toMatchObject({ status: 'preparing', readyToActivate: true })
    const staleActivation = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: adminHeaders, payload: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: '0'.repeat(64) } })
    expect(staleActivation.statusCode).toBe(409)
    expect(staleActivation.json().error.code).toBe('PURCHASE_FORMS_IMPACT_CHANGED')
    const activated = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: adminHeaders, payload: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: impact.json().data.impactHash } })
    expect(activated.statusCode, JSON.stringify(activated.json())).toBe(200)
    expect(activated.json().data.status).toBe('active')

    const activeForm = await app.inject({ method: 'GET', url: `/api/v1/storefront/skus/${catalog!.skuId}/purchase-form` })
    expect(activeForm.json().data).toMatchObject({ status: 'active', required: true, templateVersionId: versionId, definition })
    const draftResponse = await app.inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId } })
    expect(draftResponse.statusCode, JSON.stringify(draftResponse.json())).toBe(201)
    const draft = draftResponse.json().data as { id: string; revision: number }
    const ownerRead = await app.inject({ method: 'GET', url: `/api/v1/storefront/purchase-drafts/${draft.id}?skuId=${catalog!.skuId}`,
      headers: { cookie: owner.sessionCookie } })
    expect(ownerRead.statusCode).toBe(200)
    expect(ownerRead.headers['cache-control']).toContain('no-store')
    expect(JSON.stringify(ownerRead.json())).not.toMatch(/cipher|nonce|auth.?tag|storage.?key|file.?path/iu)
    const foreign = await createCustomer()
    expect((await app.inject({ method: 'GET', url: `/api/v1/storefront/purchase-drafts/${draft.id}?skuId=${catalog!.skuId}`,
      headers: { cookie: foreign.sessionCookie } })).statusCode).toBe(404)

    const incomplete = await app.inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${draft.id}`,
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId, expectedRevision: 1,
        values: { [accountId]: '000000000000000012345678' } } })
    expect(incomplete.statusCode, JSON.stringify(incomplete.json())).toBe(200)
    expect(incomplete.json().data).toMatchObject({ revision: 2, complete: false, incompleteFieldIds: [regionId] })
    const forgedValue = await app.inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${draft.id}`,
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId, expectedRevision: 2,
        values: { [accountId]: '000000000000000012345678', [regionId]: forgedOptionId } } })
    expect(forgedValue.statusCode).toBe(400)
    const completed = await app.inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${draft.id}`,
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId, expectedRevision: 2,
        values: { [accountId]: '000000000000000012345678', [regionId]: optionId } } })
    expect(completed.statusCode, JSON.stringify(completed.json())).toBe(200)
    expect(completed.json().data).toMatchObject({ revision: 3, complete: true, incompleteFieldIds: [] })
    const validation = await app.inject({ method: 'POST', url: `/api/v1/storefront/purchase-drafts/${draft.id}/validate`,
      headers: customerHeaders(owner), payload: { expectedRevision: 3 } })
    expect(validation.statusCode).toBe(200)
    expect(validation.json().data).toMatchObject({ revision: 3, complete: true })

    const guestCsrf = await customerCsrf()
    const guestSession = await app.inject({ method: 'POST', url: '/api/v1/guest/session',
      headers: { origin: testOrigin, cookie: guestCsrf.cookie, 'x-csrf-token': guestCsrf.token } })
    expect(guestSession.statusCode).toBe(201)
    const guestCookie = cookieFrom(guestSession, 'aikayun_guest_order_session')
    const guestHeaders = { origin: testOrigin, cookie: `${guestCookie}; ${guestCsrf.cookie}`, 'x-csrf-token': guestCsrf.token }
    const guestDraftResponse = await app.inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: guestHeaders, payload: { skuId: catalog!.skuId } })
    expect(guestDraftResponse.statusCode).toBe(201)
    const guestDraft = guestDraftResponse.json().data as { id: string; revision: number }
    const untouchedResponse = await app.inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: guestHeaders, payload: { skuId: catalog!.skuId } })
    expect(untouchedResponse.statusCode).toBe(201)
    const untouched = untouchedResponse.json().data as { id: string; revision: number }
    const guestSaved = await app.inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${guestDraft.id}`,
      headers: guestHeaders, payload: { skuId: catalog!.skuId, expectedRevision: guestDraft.revision,
        values: { [accountId]: '0007', [regionId]: optionId } } })
    expect(guestSaved.statusCode, JSON.stringify(guestSaved.json())).toBe(200)
    const guestLineId = randomUUID()
    const merge = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge',
      headers: { ...customerHeaders(owner), cookie: `${owner.sessionCookie}; ${owner.csrf.cookie}; ${guestCookie}` },
      payload: { version: 2, mergeId: randomUUID(), items: [{ lineId: guestLineId, skuId: catalog!.skuId,
        quantity: 1, draftId: guestDraft.id, draftRevision: guestSaved.json().data.revision }] } })
    expect(merge.statusCode, JSON.stringify(merge.json())).toBe(200)
    expect(merge.json().data.cart.items).toHaveLength(1)
    const retainedGuestLineId = merge.json().data.cart.items[0].lineId as string
    expect((await app.inject({ method: 'GET', url: `/api/v1/storefront/purchase-drafts/${guestDraft.id}?skuId=${catalog!.skuId}`,
      headers: { cookie: owner.sessionCookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/v1/storefront/purchase-drafts/${untouched.id}?skuId=${catalog!.skuId}`,
      headers: { cookie: owner.sessionCookie } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/storefront/purchase-drafts/${untouched.id}?skuId=${catalog!.skuId}`,
      headers: { cookie: guestCookie } })).statusCode).toBe(200)

    const duplicateDraftResponse = await app.inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId } })
    const duplicateDraft = duplicateDraftResponse.json().data as { id: string; revision: number }
    const duplicateSaved = await app.inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${duplicateDraft.id}`,
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId, expectedRevision: duplicateDraft.revision,
        values: { [accountId]: '0007', [regionId]: optionId } } })
    const duplicateAdd = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items', headers: customerHeaders(owner),
      payload: { version: 2, skuId: catalog!.skuId, quantity: 1, draftId: duplicateDraft.id,
        draftRevision: duplicateSaved.json().data.revision } })
    expect(duplicateAdd.statusCode).toBe(200)
    expect(duplicateAdd.json().data).toMatchObject({ retainedLineId: retainedGuestLineId, cart: { itemCount: 1, totalQuantity: 2 } })

    const differentDraftResponse = await app.inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId } })
    const differentDraft = differentDraftResponse.json().data as { id: string; revision: number }
    const differentSaved = await app.inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${differentDraft.id}`,
      headers: customerHeaders(owner), payload: { skuId: catalog!.skuId, expectedRevision: differentDraft.revision,
        values: { [accountId]: '0008', [regionId]: optionId } } })
    const differentAdd = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items', headers: customerHeaders(owner),
      payload: { version: 2, skuId: catalog!.skuId, quantity: 1, draftId: differentDraft.id,
        draftRevision: differentSaved.json().data.revision } })
    expect(differentAdd.statusCode).toBe(200)
    const cart = await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: owner.sessionCookie } })
    const lines = cart.json().data.items as Array<{ lineId: string; skuId: string; quantity: number; draftId: string; draftRevision: number }>
    expect(lines).toHaveLength(2)
    expect(lines.find(line => line.lineId === retainedGuestLineId)?.quantity).toBe(2)
    const items = lines.map(line => ({ lineId: line.lineId, skuId: line.skuId, quantity: line.quantity,
      draftId: line.draftId, draftRevision: line.draftRevision }))
    const quoteResponse = await app.inject({ method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders(owner),
      payload: { version: 2, items } })
    expect(quoteResponse.statusCode).toBe(200)
    expect(quoteResponse.json().data.canContinue).toBe(true)
    expect(quoteResponse.json().data.items).toHaveLength(2)
    expect(quoteResponse.json().data.items.some((item: { purchasePreview: { values: Record<string, unknown> } | null }) =>
      item.purchasePreview?.values[accountId] === '0008')).toBe(true)
    const orderBody = { version: 2, items, idempotencyKey: randomUUID(), quoteToken: quoteResponse.json().data.quoteToken as string }
    const orderCreated = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(owner), payload: orderBody })
    expect(orderCreated.statusCode, JSON.stringify(orderCreated.json())).toBe(201)
    const orderId = orderCreated.json().data.order.id as string
    expect(orderCreated.json().data.order.items).toHaveLength(2)
    expect(orderCreated.json().data.order.items.find((item: { lineId: string }) => item.lineId === retainedGuestLineId)?.quantity).toBe(2)

    const pause = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: adminHeaders, payload: { expectedStatus: 'active', nextStatus: 'paused' } })
    expect(pause.statusCode).toBe(200)
    expect(pause.json().data.status).toBe('paused')
    const replay = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(owner), payload: orderBody })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: orderId } })
    const newPausedQuote = await app.inject({ method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders(owner),
      payload: { version: 2, items } })
    expect(newPausedQuote.statusCode).toBe(200)
    expect(newPausedQuote.json().data.canContinue).toBe(false)
    expect(newPausedQuote.json().data.items.every((item: { reason: string }) => item.reason === 'purchase_forms_paused')).toBe(true)
    const deniedNewOrder = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(owner),
      payload: { ...orderBody, idempotencyKey: randomUUID(), quoteToken: newPausedQuote.json().data.quoteToken } })
    expect(deniedNewOrder.statusCode).toBe(409)
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', owner.id).execute()).toHaveLength(1)

    const [legacyCatalog] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', legacyCatalog!.skuId).execute()
    const legacyQuote = await quote([{ skuId: legacyCatalog!.skuId, quantity: 1 }], owner)
    expect(legacyQuote.json().data.canContinue).toBe(true)
    const legacyOrder = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(owner),
      payload: { items: [{ skuId: legacyCatalog!.skuId, quantity: 1 }], idempotencyKey: randomUUID(),
        quoteToken: legacyQuote.json().data.quoteToken } })
    expect(legacyOrder.statusCode).toBe(201)

    const optionalField = randomUUID()
    const optionalTemplateResponse = await app.inject({ method: 'POST', url: '/api/v1/admin/purchase-form-templates',
      headers: adminHeaders, payload: { name: '全选填模板', definition: { fields: [
        { id: optionalField, meaningKey: 'optional_note', type: 'text', label: '可选资料', required: false },
      ] } } })
    expect(optionalTemplateResponse.statusCode).toBe(201)
    const optionalTemplate = optionalTemplateResponse.json().data.template as { id: string; revision: number }
    const optionalFrozen = await app.inject({ method: 'POST', url: `/api/v1/admin/purchase-form-templates/${optionalTemplate.id}/versions`,
      headers: adminHeaders, payload: { expectedRevision: optionalTemplate.revision } })
    const optionalVersionId = optionalFrozen.json().data.id as string
    const [optionalCatalog] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', optionalCatalog!.skuId).execute()
    const optionalProductRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', optionalCatalog!.productId).executeTakeFirstOrThrow()
    const optionalPrepared = await app.inject({ method: 'PUT', url: `/api/v1/admin/products/${optionalCatalog!.productId}/purchase-form`,
      headers: adminHeaders, payload: { expectedRevision: optionalProductRevision.revision, mode: 'template', templateVersionId: optionalVersionId } })
    expect(optionalPrepared.statusCode).toBe(200)
    const optionalRevision = optionalPrepared.json().data.productRevision as number
    const applied = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${optionalCatalog!.productId}/purchase-form/apply`,
      headers: adminHeaders, payload: { expectedRevision: optionalRevision, expectedMode: 'template', expectedTemplateVersionId: optionalVersionId } })
    expect(applied.statusCode).toBe(200)
    const optionalForm = await app.inject({ method: 'GET', url: `/api/v1/storefront/skus/${optionalCatalog!.skuId}/purchase-form` })
    expect(optionalForm.json().data).toMatchObject({ required: true, templateVersionId: optionalVersionId })
    const optionalQuote = await quote([{ skuId: optionalCatalog!.skuId, quantity: 1 }], owner)
    expect(optionalQuote.json().data.items[0]).toMatchObject({ canPurchase: false, reason: 'purchase_forms_paused' })

    const resume = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: adminHeaders, payload: { expectedStatus: 'paused', nextStatus: 'active' } })
    expect(resume.statusCode).toBe(200)
    expect(resume.json().data.status).toBe('active')
  })

  it('applies a SKU template before cart-line edits with one PostgreSQL lock order', async () => {
    const admin = await createAdminSession()
    const adminHeaders = { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf }
    const customer = await createCustomer()
    const [catalog] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', catalog!.skuId).execute()
    const makeVersion = async (name: string, fieldId: string) => {
      const templateResponse = await app.inject({ method: 'POST', url: '/api/v1/admin/purchase-form-templates',
        headers: adminHeaders, payload: { name, definition: { fields: [
          { id: fieldId, meaningKey: 'account', type: 'text', label: '账号', required: true, maxLength: 80 },
        ] } } })
      expect(templateResponse.statusCode, JSON.stringify(templateResponse.json())).toBe(201)
      const template = templateResponse.json().data.template as { id: string; revision: number }
      const frozen = await app.inject({ method: 'POST', url: `/api/v1/admin/purchase-form-templates/${template.id}/versions`,
        headers: adminHeaders, payload: { expectedRevision: template.revision } })
      expect(frozen.statusCode, JSON.stringify(frozen.json())).toBe(201)
      return frozen.json().data.id as string
    }
    const firstFieldId = randomUUID()
    const firstVersionId = await makeVersion('SKU 并发旧模板', firstFieldId)
    const product = await db.selectFrom('products').select('revision').where('id', '=', catalog!.productId).executeTakeFirstOrThrow()
    const prepared = await app.inject({ method: 'PUT', url: `/api/v1/admin/products/${catalog!.productId}/purchase-form`,
      headers: adminHeaders, payload: { expectedRevision: product.revision, mode: 'template', templateVersionId: firstVersionId } })
    expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(200)
    const impact = await app.inject({ method: 'GET', url: '/api/v1/admin/storefront/purchase-forms', headers: adminHeaders })
    const activated = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: adminHeaders, payload: { expectedStatus: 'preparing', nextStatus: 'active',
        expectedImpactHash: impact.json().data.impactHash } })
    expect(activated.statusCode).toBe(200)

    const draftResponse = await app.inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: customerHeaders(customer), payload: { skuId: catalog!.skuId } })
    expect(draftResponse.statusCode).toBe(201)
    const draft = draftResponse.json().data as { id: string; revision: number }
    const saved = await app.inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${draft.id}`,
      headers: customerHeaders(customer), payload: { skuId: catalog!.skuId, expectedRevision: draft.revision,
        values: { [firstFieldId]: 'account-0007' } } })
    expect(saved.statusCode).toBe(200)
    const added = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items', headers: customerHeaders(customer),
      payload: { version: 2, skuId: catalog!.skuId, quantity: 1,
        draftId: draft.id, draftRevision: saved.json().data.revision } })
    expect(added.statusCode, JSON.stringify(added.json())).toBe(200)
    const cartLine = added.json().data.cart.items[0] as {
      lineId: string; lineRevision: number; draftRevision: number
    }

    const secondVersionId = await makeVersion('SKU 并发新模板', randomUUID())
    const currentProduct = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog!.productId).executeTakeFirstOrThrow()
    const staged = await app.inject({ method: 'PUT',
      url: `/api/v1/admin/products/${catalog!.productId}/variants/${catalog!.skuId}/purchase-form`,
      headers: adminHeaders, payload: { expectedRevision: currentProduct.revision, mode: 'template',
        templateVersionId: secondVersionId } })
    expect(staged.statusCode, JSON.stringify(staged.json())).toBe(200)

    let releaseGate!: () => void
    let reportGatePid!: (pid: number) => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const gatePidPromise = new Promise<number>(resolve => { reportGatePid = resolve })
    const gateHolder = db.transaction().execute(async trx => {
      await trx.selectFrom('storefront_customer_policy').select('singleton')
        .where('singleton', '=', true).forShare().executeTakeFirstOrThrow()
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      reportGatePid(Number(pid.rows[0]!.pid))
      await gate
    })
    const gatePid = await gatePidPromise
    let applyResponse: Awaited<ReturnType<typeof app.inject>> | undefined
    let editResponse: Awaited<ReturnType<typeof app.inject>> | undefined
    let applyError: unknown
    let editError: unknown
    const applyRequest = (async () => {
      const apply = await app.inject({ method: 'POST',
        url: `/api/v1/admin/products/${catalog!.productId}/variants/${catalog!.skuId}/purchase-form/apply`,
        headers: adminHeaders,
        payload: { expectedRevision: staged.json().data.productRevision, expectedMode: 'template',
          expectedTemplateVersionId: secondVersionId } })
      applyResponse = apply
    })().catch((error: unknown) => { applyError = error })
    let editRequest: Promise<void> | undefined

    try {
      const applyPid = await waitForQueryBlockedBy('storefront_customer_policy', gatePid)
      editRequest = (async () => {
        const edited = await app.inject({ method: 'PATCH',
          url: `/api/v1/customer/cart/lines/${cartLine.lineId}/purchase-form`,
          headers: customerHeaders(customer), payload: {
            expectedLineRevision: cartLine.lineRevision, expectedDraftRevision: cartLine.draftRevision,
            draftRevision: cartLine.draftRevision, values: { [firstFieldId]: 'account-0008' },
          } })
        editResponse = edited
      })().catch((error: unknown) => { editError = error })
      const editDeadline = Date.now() + 5_000
      let editBlockedPid: number | null = null
      while (Date.now() < editDeadline && !editResponse && !editError) {
        editBlockedPid = await findQueryBlockedBy('storefront_customer_policy', gatePid, applyPid)
        if (editBlockedPid !== null) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(Boolean(editResponse || editBlockedPid), 'cart edit either finishes before apply or waits on lifecycle status').toBe(true)
      if (editBlockedPid !== null) {
        const variantStillAvailable = await db.transaction().execute(async trx => {
          const row = await trx.selectFrom('product_variants').select('id').where('id', '=', catalog!.skuId)
            .forUpdate().skipLocked().executeTakeFirst()
          return Boolean(row)
        })
        expect(variantStillAvailable, 'cart edits wait for lifecycle status before locking an SKU').toBe(true)
      }
      releaseGate()
      await Promise.all([applyRequest, editRequest])
    } finally {
      releaseGate()
      await gateHolder
      await applyRequest
      await editRequest
    }
    expect(applyError).toBeUndefined()
    expect(applyResponse?.statusCode, JSON.stringify(applyResponse?.json())).toBe(200)
    expect(editError).toBeUndefined()
    expect([200, 409]).toContain(editResponse?.statusCode)
    if (editResponse?.statusCode === 409) {
      expect(editResponse.json().error.code).toBe('PURCHASE_TEMPLATE_VERSION_CONFLICT')
    }
  })

  it('claims only specified guest drafts with cart merge atomically and replays after guest expiry', async () => {
    const admin = await createAdminSession()
    const fieldId = randomUUID()
    const createdTemplate = await app.inject({
      method: 'POST', url: '/api/v1/admin/purchase-form-templates',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { name: '游客合并模板', definition: { fields: [{
        id: fieldId, meaningKey: 'account', type: 'text', label: '账号', required: true, maxLength: 80,
      }] } },
    })
    expect(createdTemplate.statusCode).toBe(201)
    const template = createdTemplate.json().data.template as { id: string; revision: number }
    const frozen = await app.inject({
      method: 'POST', url: `/api/v1/admin/purchase-form-templates/${template.id}/versions`,
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { expectedRevision: template.revision },
    })
    expect(frozen.statusCode).toBe(201)
    const versionId = frozen.json().data.id as string
    const [catalog] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    await db.insertInto('product_purchase_form_settings').values({
      product_id: catalog!.productId, mode: 'template', template_version_id: versionId,
      applied_mode: 'template', applied_template_version_id: versionId,
      updated_by_admin_id: admin.id,
    }).execute()
    const lifecycle = await app.inject({ method: 'GET', url: '/api/v1/admin/storefront/purchase-forms',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf } })
    const activated = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: lifecycle.json().data.impactHash } })
    expect(activated.statusCode, JSON.stringify(activated.json())).toBe(200)
    const csrf = await customerCsrf()
    const guestResponse = await app.inject({ method: 'POST', url: '/api/v1/guest/session',
      headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token } })
    expect(guestResponse.statusCode).toBe(201)
    const guestCookie = cookieFrom(guestResponse, 'aikayun_guest_order_session')
    const guestToken = guestCookie.split('=')[1]!
    const guestSession = await db.selectFrom('guest_order_sessions').select('id')
      .where('token_hash', '=', (await import('../src/auth/security.js')).hashToken(guestToken))
      .executeTakeFirstOrThrow()
    const guestOwner = { kind: 'guest' as const, guestSessionToken: guestToken }
    const draft = await createPurchaseDraft(db, config, guestOwner, versionId)
    const saved = await savePurchaseDraft(db, config, guestOwner, {
      draftId: draft.id, expectedRevision: draft.revision, values: { [fieldId]: 'guest-0007' },
    })
    const untouched = await createPurchaseDraft(db, config, guestOwner, versionId)
    const customer = await createCustomer()
    const other = await createCustomer()
    const mergeId = randomUUID()
    const body = { version: 2, mergeId, items: [{ lineId: randomUUID(), skuId: catalog!.skuId,
      quantity: 2, draftId: saved.id, draftRevision: saved.revision }] }
    const headers = { ...customerHeaders(customer), cookie: `${customer.sessionCookie}; ${customer.csrf.cookie}; ${guestCookie}` }
    const fillers = await createCatalog({ count: 50, mode: 'unlimited', fulfillmentMethod: 'manual' })
    const filled = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge',
      headers: customerHeaders(customer), payload: { mergeId: randomUUID(),
        items: fillers.map(item => ({ skuId: item.skuId, quantity: 1 })) } })
    expect(filled.statusCode).toBe(200)
    const fullAttempt = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge', headers, payload: body })
    expect(fullAttempt.statusCode).toBe(409)
    expect((await db.selectFrom('purchase_drafts').select(['customer_id', 'guest_order_session_id'])
      .where('id', '=', saved.id).executeTakeFirstOrThrow()))
      .toMatchObject({ customer_id: null, guest_order_session_id: guestSession.id })
    expect(await db.selectFrom('customer_cart_merge_requests').select('merge_id')
      .where('customer_id', '=', customer.id).where('merge_id', '=', mergeId).executeTakeFirst()).toBeUndefined()
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/customer/cart',
      headers: customerHeaders(customer) })).statusCode).toBe(200)
    const first = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge', headers, payload: body })
    expect(first.statusCode, JSON.stringify(first.json())).toBe(200)
    expect(first.json().data.cart.items).toHaveLength(1)
    expect(first.json().data.cart.items[0].quantity).toBe(2)
    expect((await db.selectFrom('purchase_drafts').select('customer_id').where('id', '=', saved.id)
      .executeTakeFirstOrThrow()).customer_id).toBe(customer.id)
    expect((await db.selectFrom('purchase_drafts').select('guest_order_session_id').where('id', '=', untouched.id)
      .executeTakeFirstOrThrow()).guest_order_session_id).toBe(guestSession.id)
    await db.updateTable('guest_order_sessions').set({ revoked_at: new Date() })
      .where('id', '=', guestSession.id).execute()
    const replay = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge', headers, payload: body })
    expect(replay.statusCode, JSON.stringify(replay.json())).toBe(200)
    expect(replay.json().data.changed).toBe(false)
    expect(replay.json().data.cart.items[0].quantity).toBe(2)
    const wrongOwner = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge',
      headers: { ...customerHeaders(other), cookie: `${other.sessionCookie}; ${other.csrf.cookie}; ${guestCookie}` },
      payload: body })
    expect(wrongOwner.statusCode).toBe(401)
    expect((await db.selectFrom('purchase_drafts').select('customer_id').where('id', '=', saved.id)
      .executeTakeFirstOrThrow()).customer_id).toBe(customer.id)
  })

  it('keeps effective form content as separate lines, snapshots both, and replays after draft changes', async () => {
    const customer = await createCustomer()
    const admin = await createAdminSession()
    const [catalog] = await createCatalog({ mode: 'quantity', stocked: 6, fulfillmentMethod: 'manual' })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', catalog!.skuId).execute()
    const fieldId = randomUUID()
    const createdTemplate = await app.inject({
      method: 'POST', url: '/api/v1/admin/purchase-form-templates',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { name: '购买行测试模板', definition: { fields: [{
        id: fieldId, meaningKey: 'account', type: 'text', label: '账号', required: true, maxLength: 80,
      }] } },
    })
    expect(createdTemplate.statusCode, JSON.stringify(createdTemplate.json())).toBe(201)
    const template = createdTemplate.json().data.template as { id: string; revision: number }
    const frozen = await app.inject({
      method: 'POST', url: `/api/v1/admin/purchase-form-templates/${template.id}/versions`,
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { expectedRevision: template.revision },
    })
    expect(frozen.statusCode, JSON.stringify(frozen.json())).toBe(201)
    const versionId = frozen.json().data.id as string
    await db.insertInto('product_purchase_form_settings').values({
      product_id: catalog!.productId, mode: 'template', template_version_id: versionId,
      applied_mode: 'template', applied_template_version_id: versionId,
      updated_by_admin_id: admin.id,
    }).execute()
    const lifecycle = await app.inject({ method: 'GET', url: '/api/v1/admin/storefront/purchase-forms',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf } })
    const activated = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: lifecycle.json().data.impactHash } })
    expect(activated.statusCode, JSON.stringify(activated.json())).toBe(200)
    const session = await db.selectFrom('customer_sessions').select('id')
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    const owner = { kind: 'customer' as const, customer: { id: customer.id, sessionId: session.id } }
    const makeDraft = async (account: string) => {
      const draft = await createPurchaseDraft(db, config, owner, versionId)
      const saved = await savePurchaseDraft(db, config, owner, {
        draftId: draft.id, expectedRevision: draft.revision, values: { [fieldId]: account },
      })
      expect(saved.complete).toBe(true)
      return saved
    }
    const first = await makeDraft('00041')
    const duplicate = await makeDraft('00041')
    const different = await makeDraft('00042')
    const addForm = (draft: typeof first, quantity: number) => app.inject({
      method: 'POST', url: '/api/v1/customer/cart/items', headers: customerHeaders(customer),
      payload: { version: 2, skuId: catalog!.skuId, quantity,
        draftId: draft.id, draftRevision: draft.revision },
    })
    const addedFirst = await addForm(first, 2)
    expect(addedFirst.statusCode, JSON.stringify(addedFirst.json())).toBe(200)
    const retainedLineId = addedFirst.json().data.retainedLineId as string
    const [secondCatalog] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    await db.insertInto('product_purchase_form_settings').values({
      product_id: secondCatalog!.productId, mode: 'template', template_version_id: versionId,
      applied_mode: 'template', applied_template_version_id: versionId,
      updated_by_admin_id: admin.id,
    }).execute()
    const reusedDraftOnAnotherSku = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/items', headers: customerHeaders(customer),
      payload: { version: 2, skuId: secondCatalog!.skuId, quantity: 1,
        draftId: first.id, draftRevision: first.revision },
    })
    expect(reusedDraftOnAnotherSku.statusCode).toBe(409)
    expect((await db.selectFrom('customer_cart_items').select('line_id')
      .where('customer_id', '=', customer.id).execute())).toHaveLength(1)
    const addedDuplicate = await addForm(duplicate, 1)
    expect(addedDuplicate.statusCode, JSON.stringify(addedDuplicate.json())).toBe(200)
    expect(addedDuplicate.json().data.retainedLineId).toBe(retainedLineId)
    const addedDifferent = await addForm(different, 2)
    expect(addedDifferent.statusCode, JSON.stringify(addedDifferent.json())).toBe(200)
    const lines = addedDifferent.json().data.cart.items as Array<{
      lineId: string; skuId: string; quantity: number; draftId: string; draftRevision: number; lineRevision: number
    }>
    expect(lines).toHaveLength(2)
    expect(lines.find(line => line.lineId === retainedLineId)?.quantity).toBe(3)
    const overLimitLine = lines.find(line => line.lineId !== retainedLineId)!
    const overLimitEdit = await app.inject({ method: 'PATCH',
      url: `/api/v1/customer/cart/lines/${overLimitLine.lineId}`, headers: customerHeaders(customer),
      payload: { quantity: 98, expectedLineRevision: overLimitLine.lineRevision } })
    expect(overLimitEdit.statusCode).toBe(409)
    expect((await db.selectFrom('customer_cart_items').select('quantity')
      .where('line_id', '=', overLimitLine.lineId).executeTakeFirstOrThrow()).quantity).toBe(2)
    const beforeActivationQuote = await quote([{ skuId: catalog!.skuId, quantity: 1 }], customer)
    expect(beforeActivationQuote.json().data).toMatchObject({ canContinue: false,
      items: [{ reason: 'purchase_form_required' }] })
    const legacyAfterActivation = await quote([{ skuId: catalog!.skuId, quantity: 1 }], customer)
    expect(legacyAfterActivation.statusCode).toBe(200)
    expect(legacyAfterActivation.json().data).toMatchObject({ canContinue: false,
      items: [{ reason: 'purchase_form_required' }] })
    const orderLines = lines.map(line => ({ lineId: line.lineId, skuId: line.skuId,
      quantity: line.quantity, draftId: line.draftId, draftRevision: line.draftRevision }))
    const duplicateSourceLineIds = [randomUUID(), randomUUID()].sort()
    const simultaneousQuotes = await Promise.all([orderLines, [
      { lineId: duplicateSourceLineIds[0], skuId: catalog!.skuId, quantity: 2,
        draftId: first.id, draftRevision: first.revision },
      { lineId: duplicateSourceLineIds[1], skuId: catalog!.skuId, quantity: 1,
        draftId: duplicate.id, draftRevision: duplicate.revision },
    ]].map(items => app.inject({
      method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders(customer),
      payload: { version: 2, items },
    })))
    expect(simultaneousQuotes.map(response => response.statusCode)).toEqual([200, 200])
    expect(simultaneousQuotes[1]!.json().data.items).toHaveLength(1)
    expect(simultaneousQuotes[1]!.json().data.items[0]).toMatchObject({
      quantity: 3, lineId: duplicateSourceLineIds[0], sourceLineIds: duplicateSourceLineIds,
    })
    const overStock = await app.inject({
      method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders(customer),
      payload: { version: 2, items: orderLines.map((line, index) => ({
        ...line, quantity: line.quantity + (index === 0 ? 2 : 0),
      })) },
    })
    expect(overStock.statusCode).toBe(200)
    expect(overStock.json().data.canContinue).toBe(false)
    expect(overStock.json().data.items.every((item: { reason: string }) => item.reason === 'insufficient_inventory')).toBe(true)
    const quoted = await app.inject({
      method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders(customer),
      payload: { version: 2, items: orderLines },
    })
    expect(quoted.statusCode, JSON.stringify(quoted.json())).toBe(200)
    expect(quoted.json().data.canContinue).toBe(true)
    const orderBody = { version: 2, items: orderLines, idempotencyKey: randomUUID(),
      quoteToken: quoted.json().data.quoteToken as string }
    const created = await app.inject({
      method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(customer), payload: orderBody,
    })
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201)
    const order = created.json().data.order as { id: string; items: Array<{ id: string; lineId: string }> }
    expect(order.items).toHaveLength(2)
    expect(new Set(order.items.map(item => item.lineId))).toEqual(new Set(lines.map(line => line.lineId)))
    const firstOrderItem = order.items.find(item => item.lineId === retainedLineId)!
    const snapshot = await getOwnedOrderPurchaseSnapshot(db, config, owner, firstOrderItem.id)
    expect(snapshot).toMatchObject({ state: 'filled', templateVersionId: versionId,
      values: { [fieldId]: '00041' } })
    const other = await createCustomer()
    const otherSession = await db.selectFrom('customer_sessions').select('id')
      .where('customer_id', '=', other.id).executeTakeFirstOrThrow()
    await expect(getOwnedOrderPurchaseSnapshot(db, config, {
      kind: 'customer', customer: { id: other.id, sessionId: otherSession.id },
    }, firstOrderItem.id)).rejects.toMatchObject({ status: 404 })

    const otherLine = lines.find(line => line.lineId !== retainedLineId)!
    const collision = await app.inject({
      method: 'PATCH', url: `/api/v1/customer/cart/lines/${otherLine.lineId}/purchase-form`,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: otherLine.lineRevision, expectedDraftRevision: different.revision, draftRevision: different.revision,
        values: { [fieldId]: '00041' },
      },
    })
    expect(collision.statusCode, JSON.stringify(collision.json())).toBe(200)
    expect(collision.json().data.retainedLineId).toBe(retainedLineId)
    expect(collision.json().data.cart.items).toHaveLength(1)
    expect(collision.json().data.cart.items[0].quantity).toBe(5)
    const mergedRevision = collision.json().data.cart.items[0].lineRevision as number
    const concurrentEdits = await Promise.all([6, 7].map(quantity => app.inject({
      method: 'PATCH', url: `/api/v1/customer/cart/lines/${retainedLineId}`,
      headers: customerHeaders(customer), payload: { quantity, expectedLineRevision: mergedRevision },
    })))
    expect(concurrentEdits.map(response => response.statusCode).sort()).toEqual([200, 409])
    const oldQuoteOrder = await app.inject({
      method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(customer),
      payload: { ...orderBody, idempotencyKey: randomUUID() },
    })
    expect(oldQuoteOrder.statusCode).toBe(409)
    const removed = await app.inject({ method: 'DELETE',
      url: `/api/v1/customer/cart/lines/${retainedLineId}`, headers: customerHeaders(customer) })
    expect(removed.statusCode).toBe(200)
    await requestPurchaseDraftDeletion(db, owner, first.id, first.revision)
    const replay = await app.inject({
      method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(customer), payload: orderBody,
    })
    expect(replay.statusCode, JSON.stringify(replay.json())).toBe(200)
    expect(replay.json().data.order.id).toBe(order.id)
    expect((await getOwnedOrderPurchaseSnapshot(db, config, owner, firstOrderItem.id)).values)
      .toEqual({ [fieldId]: '00041' })
    const freshBound = await addForm(duplicate, 1)
    expect(freshBound.statusCode).toBe(200)
    const staleLineId = freshBound.json().data.retainedLineId as string
    // Simulate the expiry cleaner marking a formerly bound draft unavailable.
    await db.updateTable('purchase_drafts').set({ status: 'deleting' })
      .where('id', '=', duplicate.id).execute()
    const replacementDraft = await makeDraft('00041')
    const refreshed = await addForm(replacementDraft, 1)
    expect(refreshed.statusCode, JSON.stringify(refreshed.json())).toBe(200)
    expect(refreshed.json().data.retainedLineId).toBe(staleLineId)
    expect(refreshed.json().data.cart.items[0]).toMatchObject({
      lineId: staleLineId, quantity: 2, draftId: replacementDraft.id,
    })
  })

  it('keeps the last valid cart binding when a customer saves an incomplete edit', async () => {
    const customer = await createCustomer()
    const admin = await createAdminSession()
    const [catalog] = await createCatalog({ mode: 'quantity', stocked: 4, fulfillmentMethod: 'manual' })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', catalog!.skuId).execute()

    const fieldId = randomUUID()
    const templateResponse = await app.inject({
      method: 'POST', url: '/api/v1/admin/purchase-form-templates',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { name: '部分编辑事务回归', definition: { fields: [
        { id: fieldId, meaningKey: 'account', type: 'text', label: '账号', required: true, maxLength: 80 },
      ] } },
    })
    expect(templateResponse.statusCode, JSON.stringify(templateResponse.json())).toBe(201)
    const template = templateResponse.json().data.template as { id: string; revision: number }
    const frozen = await app.inject({
      method: 'POST', url: `/api/v1/admin/purchase-form-templates/${template.id}/versions`,
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { expectedRevision: template.revision },
    })
    expect(frozen.statusCode, JSON.stringify(frozen.json())).toBe(201)
    const versionId = frozen.json().data.id as string
    const product = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog!.productId).executeTakeFirstOrThrow()
    const prepared = await app.inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog!.productId}/purchase-form`,
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { expectedRevision: product.revision, mode: 'template', templateVersionId: versionId },
    })
    expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(200)
    const impact = await app.inject({ method: 'GET', url: '/api/v1/admin/storefront/purchase-forms',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf } })
    const activated = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: { origin: testOrigin, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: impact.json().data.impactHash } })
    expect(activated.statusCode, JSON.stringify(activated.json())).toBe(200)

    const session = await db.selectFrom('customer_sessions').select('id')
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    const owner = { kind: 'customer' as const, customer: { id: customer.id, sessionId: session.id } }
    const draft = await createPurchaseDraft(db, config, owner, versionId)
    const initial = await savePurchaseDraft(db, config, owner, {
      draftId: draft.id, expectedRevision: draft.revision, values: { [fieldId]: 'original-account' },
    })
    const added = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items',
      headers: customerHeaders(customer), payload: {
        version: 2, skuId: catalog!.skuId, quantity: 1, draftId: initial.id, draftRevision: initial.revision,
      } })
    expect(added.statusCode, JSON.stringify(added.json())).toBe(200)
    let line = added.json().data.cart.items[0] as {
      lineId: string; lineRevision: number; draftId: string; draftRevision: number; contentIdentity: string
    }

    const replacementPath = `/api/v1/customer/cart/lines/${line.lineId}/purchase-form/replacement-draft`
    const started = await app.inject({
      method: 'POST', url: replacementPath,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: line.lineRevision, expectedDraftRevision: line.draftRevision,
      },
    })
    expect(started.statusCode, JSON.stringify(started.json())).toBe(201)
    const replacement = started.json().data as {
      replacementDraftId: string; replacementDraftRevision: number; sourceDraftId: string
    }
    expect(replacement.sourceDraftId).toBe(line.draftId)

    // A second independently saved draft with the same content adds quantity to
    // the existing line. The edit relation must follow that quantity-only
    // revision so the customer can resume the same in-progress edit.
    const duplicateDraft = await createPurchaseDraft(db, config, owner, versionId)
    const duplicate = await savePurchaseDraft(db, config, owner, {
      draftId: duplicateDraft.id, expectedRevision: duplicateDraft.revision,
      values: { [fieldId]: 'original-account' },
    })
    const appended = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items',
      headers: customerHeaders(customer), payload: {
        version: 2, skuId: catalog!.skuId, quantity: 1, draftId: duplicate.id, draftRevision: duplicate.revision,
      } })
    expect(appended.statusCode, JSON.stringify(appended.json())).toBe(200)
    expect(appended.json().data.retainedLineId).toBe(line.lineId)
    line = appended.json().data.cart.items[0] as typeof line
    expect(line).toMatchObject({ quantity: 2, lineRevision: 2, draftId: initial.id })
    const quantityThree = await app.inject({ method: 'PATCH', url: `/api/v1/customer/cart/lines/${line.lineId}`,
      headers: customerHeaders(customer), payload: { expectedLineRevision: line.lineRevision, quantity: 3 } })
    expect(quantityThree.statusCode, JSON.stringify(quantityThree.json())).toBe(200)
    line = quantityThree.json().data.cart.items[0] as typeof line
    const quantityTwo = await app.inject({ method: 'PATCH', url: `/api/v1/customer/cart/lines/${line.lineId}`,
      headers: customerHeaders(customer), payload: { expectedLineRevision: line.lineRevision, quantity: 2 } })
    expect(quantityTwo.statusCode, JSON.stringify(quantityTwo.json())).toBe(200)
    line = quantityTwo.json().data.cart.items[0] as typeof line
    const resumed = await app.inject({ method: 'GET', url: replacementPath,
      headers: { cookie: customer.sessionCookie } })
    expect(resumed.statusCode, JSON.stringify(resumed.json())).toBe(200)
    expect(resumed.json().data).toMatchObject({
      lineId: line.lineId,
      skuId: catalog!.skuId,
      quantity: 2,
      sourceDraftId: line.draftId,
      sourceDraftRevision: line.draftRevision,
      sourceLineRevision: line.lineRevision,
      replacementDraftId: replacement.replacementDraftId,
    })
    replacement.replacementDraftRevision = resumed.json().data.replacementDraftRevision as number

    const partial = await app.inject({
      method: 'PUT', url: replacementPath,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: line.lineRevision,
        expectedDraftRevision: line.draftRevision,
        expectedReplacementDraftRevision: replacement.replacementDraftRevision,
        omittedSourceAttachmentIds: [],
        values: {},
      },
    })
    const afterPartialLine = await db.selectFrom('customer_cart_items').selectAll()
      .where('customer_id', '=', customer.id).where('line_id', '=', line.lineId).executeTakeFirstOrThrow()
    const afterPartialDraft = await getPurchaseDraft(db, config, owner, line.draftId)
    expect(partial.statusCode, JSON.stringify({ response: partial.json(), line: afterPartialLine })).toBe(200)
    expect(partial.json().data).toMatchObject({ complete: false, incompleteFieldIds: [fieldId] })
    expect(afterPartialLine).toMatchObject({
      draft_id: line.draftId, draft_revision: line.draftRevision,
      revision: line.lineRevision, content_identity: line.contentIdentity,
    })
    expect(afterPartialDraft.values).toEqual({ [fieldId]: 'original-account' })

    const completed = await app.inject({
      method: 'PATCH', url: `/api/v1/customer/cart/lines/${line.lineId}/purchase-form`,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: line.lineRevision,
        expectedDraftRevision: line.draftRevision,
        replacementDraft: { draftId: replacement.replacementDraftId, draftRevision: partial.json().data.replacementDraftRevision },
        values: { [fieldId]: 'updated-account' },
      },
    })
    expect(completed.statusCode, JSON.stringify(completed.json())).toBe(200)
    expect(completed.json().data.cart.items[0]).toMatchObject({
      lineId: line.lineId, quantity: 2, draftId: replacement.replacementDraftId,
      draftRevision: partial.json().data.replacementDraftRevision + 1, lineRevision: line.lineRevision + 1,
    })
    expect((await getPurchaseDraft(db, config, owner, replacement.replacementDraftId)).values)
      .toEqual({ [fieldId]: 'updated-account' })
    expect(await db.selectFrom('purchase_drafts').select('status').where('id', '=', line.draftId).executeTakeFirstOrThrow())
      .toMatchObject({ status: 'deleting' })

    const committedLine = completed.json().data.cart.items[0] as typeof line
    const nextEdit = await app.inject({ method: 'POST', url: replacementPath,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: committedLine.lineRevision, expectedDraftRevision: committedLine.draftRevision,
      } })
    expect(nextEdit.statusCode, JSON.stringify(nextEdit.json())).toBe(201)
    const changedSource = await app.inject({ method: 'PATCH',
      url: `/api/v1/customer/cart/lines/${line.lineId}/purchase-form`, headers: customerHeaders(customer), payload: {
        expectedLineRevision: committedLine.lineRevision,
        expectedDraftRevision: committedLine.draftRevision,
        draftRevision: committedLine.draftRevision,
        values: { [fieldId]: 'changed-source-account' },
      } })
    expect(changedSource.statusCode, JSON.stringify(changedSource.json())).toBe(200)
    const staleRecovery = await app.inject({ method: 'GET', url: replacementPath,
      headers: { cookie: customer.sessionCookie } })
    expect(staleRecovery.statusCode, JSON.stringify(staleRecovery.json())).toBe(404)
    expect(await db.selectFrom('customer_cart_line_replacement_drafts').select('line_id')
      .where('line_id', '=', line.lineId).execute()).toEqual([])
    expect(await db.selectFrom('purchase_drafts').select('status')
      .where('id', '=', nextEdit.json().data.replacementDraftId).executeTakeFirstOrThrow()).toEqual({ status: 'deleting' })

    const changedLine = changedSource.json().data.cart.items[0] as typeof line
    const mergeCollisionDraft = await createPurchaseDraft(db, config, owner, versionId)
    const mergeCollisionSaved = await savePurchaseDraft(db, config, owner, {
      draftId: mergeCollisionDraft.id, expectedRevision: mergeCollisionDraft.revision,
      values: { [fieldId]: 'collision-account' },
    })
    const secondAdded = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items',
      headers: customerHeaders(customer), payload: {
        version: 2, skuId: catalog!.skuId, quantity: 1,
        draftId: mergeCollisionSaved.id, draftRevision: mergeCollisionSaved.revision,
      } })
    expect(secondAdded.statusCode, JSON.stringify(secondAdded.json())).toBe(200)
    const destinationLine = secondAdded.json().data.cart.items.find((item: typeof line) => item.lineId !== changedLine.lineId) as typeof line
    const destinationPath = `/api/v1/customer/cart/lines/${destinationLine.lineId}/purchase-form/replacement-draft`
    const destinationEdit = await app.inject({ method: 'POST', url: destinationPath,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: destinationLine.lineRevision, expectedDraftRevision: destinationLine.draftRevision,
      } })
    const sourceEdit = await app.inject({ method: 'POST', url: replacementPath,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: changedLine.lineRevision, expectedDraftRevision: changedLine.draftRevision,
      } })
    expect(destinationEdit.statusCode, JSON.stringify(destinationEdit.json())).toBe(201)
    expect(sourceEdit.statusCode, JSON.stringify(sourceEdit.json())).toBe(201)
    const collisionMerge = await app.inject({ method: 'PATCH',
      url: `/api/v1/customer/cart/lines/${changedLine.lineId}/purchase-form`, headers: customerHeaders(customer), payload: {
        expectedLineRevision: changedLine.lineRevision,
        expectedDraftRevision: changedLine.draftRevision,
        replacementDraft: {
          draftId: sourceEdit.json().data.replacementDraftId,
          draftRevision: sourceEdit.json().data.replacementDraftRevision,
        },
        values: { [fieldId]: 'collision-account' },
      } })
    expect(collisionMerge.statusCode, JSON.stringify(collisionMerge.json())).toBe(200)
    expect(collisionMerge.json().data.cart.items).toHaveLength(1)
    expect(collisionMerge.json().data.cart.items[0]).toMatchObject({
      lineId: destinationLine.lineId, quantity: 3,
    })
    const resumedCollisionEdit = await app.inject({ method: 'GET', url: destinationPath,
      headers: { cookie: customer.sessionCookie } })
    expect(resumedCollisionEdit.statusCode, JSON.stringify(resumedCollisionEdit.json())).toBe(200)
    expect(resumedCollisionEdit.json().data).toMatchObject({
      replacementDraftId: destinationEdit.json().data.replacementDraftId,
      sourceLineRevision: collisionMerge.json().data.cart.items[0].lineRevision,
    })
    const replayedStart = await app.inject({ method: 'POST', url: destinationPath,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: resumedCollisionEdit.json().data.sourceLineRevision,
        expectedDraftRevision: resumedCollisionEdit.json().data.sourceDraftRevision,
      } })
    expect(replayedStart.statusCode, JSON.stringify(replayedStart.json())).toBe(200)
    expect(replayedStart.json().data.replacementDraftId).toBe(destinationEdit.json().data.replacementDraftId)
    const revoked = await app.inject({ method: 'DELETE', url: destinationPath, headers: customerHeaders(customer), payload: {
      expectedLineRevision: resumedCollisionEdit.json().data.sourceLineRevision,
      expectedDraftRevision: resumedCollisionEdit.json().data.sourceDraftRevision,
      expectedReplacementDraftRevision: resumedCollisionEdit.json().data.replacementDraftRevision,
    } })
    expect(revoked.statusCode, JSON.stringify(revoked.json())).toBe(200)
    expect((await app.inject({ method: 'GET', url: destinationPath,
      headers: { cookie: customer.sessionCookie } })).statusCode).toBe(404)
    const deletionEdit = await app.inject({ method: 'POST', url: destinationPath,
      headers: customerHeaders(customer), payload: {
        expectedLineRevision: resumedCollisionEdit.json().data.sourceLineRevision,
        expectedDraftRevision: resumedCollisionEdit.json().data.sourceDraftRevision,
      } })
    expect(deletionEdit.statusCode, JSON.stringify(deletionEdit.json())).toBe(201)
    const deletedLine = await app.inject({ method: 'DELETE',
      url: `/api/v1/customer/cart/lines/${destinationLine.lineId}`, headers: customerHeaders(customer) })
    expect(deletedLine.statusCode, JSON.stringify(deletedLine.json())).toBe(200)
    expect(await db.selectFrom('customer_cart_line_replacement_drafts').select('line_id')
      .where('line_id', '=', destinationLine.lineId).execute()).toEqual([])
    expect(await db.selectFrom('purchase_drafts').select('status')
      .where('id', '=', deletionEdit.json().data.replacementDraftId).executeTakeFirstOrThrow()).toEqual({ status: 'deleting' })
  })

  it('isolates authenticated carts, merges concurrent adds, supports quantity changes and enforces CSRF', async () => {
    const [owner, other] = await Promise.all([createCustomer(), createCustomer()])
    const [skuA, skuB] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual', count: 2 })

    expect((await addCartItem(owner, skuA!.skuId, 1, { origin: 'https://attacker.example' })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items', headers: { origin: testOrigin, cookie: owner.sessionCookie }, payload: { skuId: skuA!.skuId, quantity: 1 } })).statusCode).toBe(403)
    expect((await addCartItem(owner, skuA!.skuId, 0)).statusCode).toBe(400)
    expect((await addCartItem(owner, randomUUID(), 1)).statusCode).toBe(404)
    expect((await addCartItem(owner, skuA!.skuId, 1, { cookie: `${owner.sessionCookie}; ${owner.csrf.cookie}` })).statusCode).toBe(200)

    const additions = await Promise.all([
      addCartItem(owner, skuA!.skuId, 2),
      addCartItem(owner, skuA!.skuId, 3),
    ])
    expect(additions.map(response => response.statusCode)).toEqual([200, 200])
    const crossDeviceRead = await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: owner.sessionCookie } })
    expect(crossDeviceRead.statusCode).toBe(200)
    expect(crossDeviceRead.json().data.items).toHaveLength(1)
    expect(crossDeviceRead.json().data.items[0]).toMatchObject({ skuId: skuA!.skuId, quantity: 6 })

    expect((await addCartItem(owner, skuB!.skuId, 2)).statusCode).toBe(200)
    const otherRead = await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: other.sessionCookie } })
    expect(otherRead.json().data.items).toEqual([])
    const clientCustomerId = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/items', headers: customerHeaders(owner),
      payload: { customerId: other.id, skuId: skuB!.skuId, quantity: 1 },
    })
    expect(clientCustomerId.statusCode).toBe(400)

    const update = await app.inject({
      method: 'PATCH', url: `/api/v1/customer/cart/items/${skuA!.skuId}`,
      headers: customerHeaders(owner), payload: { quantity: 4 },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json().data.cart.items.find((item: { skuId: string }) => item.skuId === skuA!.skuId).quantity).toBe(4)
    expect((await app.inject({
      method: 'DELETE', url: `/api/v1/customer/cart/items/${skuA!.skuId}`, headers: customerHeaders(owner),
    })).json().data.cart.items).toHaveLength(1)
    const cleared = await app.inject({ method: 'DELETE', url: '/api/v1/customer/cart', headers: customerHeaders(owner) })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().data.cart.items).toEqual([])

    const logout = await app.inject({ method: 'POST', url: '/api/v1/customer/auth/logout', headers: customerHeaders(owner) })
    expect(logout.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: owner.sessionCookie } })).statusCode).toBe(401)
    expect((await quote([{ skuId: skuA!.skuId, quantity: 1 }], owner)).statusCode).toBe(401)
  })

  it('merges guest items atomically, skips unknown SKUs, and makes merge replay idempotent', async () => {
    const owner = await createCustomer()
    const other = await createCustomer()
    const [skuA, skuB] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual', count: 2 })
    const mergeId = randomUUID()
    const body = {
      mergeId,
      items: [
        { skuId: skuA!.skuId, quantity: 2 },
        { skuId: skuA!.skuId, quantity: 1 },
        { skuId: skuB!.skuId, quantity: 2 },
      ],
    }
    const merge = () => app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge', headers: customerHeaders(owner), payload: body })
    const first = await merge()
    expect(first.statusCode).toBe(200)
    expect(first.json().data.cart.items).toHaveLength(2)
    expect(first.json().data.cart.items.find((item: { skuId: string }) => item.skuId === skuA!.skuId).quantity).toBe(3)
    const replay = await merge()
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.cart.items.find((item: { skuId: string }) => item.skuId === skuA!.skuId).quantity).toBe(3)
    expect(replay.json().data.changed).toBe(false)
    const persistedMerge = await db.selectFrom('customer_cart_merge_requests').selectAll()
      .where('customer_id', '=', owner.id).where('merge_id', '=', mergeId).execute()
    expect(persistedMerge).toHaveLength(1)
    const persistedCart = await db.selectFrom('customer_cart_items').select(['sku_id', 'quantity'])
      .where('customer_id', '=', owner.id).orderBy('sku_id').execute()
    expect(persistedCart).toHaveLength(2)
    expect(persistedCart.find(item => item.sku_id === skuA!.skuId)?.quantity).toBe(3)

    const reused = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/merge', headers: customerHeaders(owner),
      payload: { mergeId, items: [{ skuId: skuA!.skuId, quantity: 4 }] },
    })
    expect(reused.statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: other.sessionCookie } })).json().data.items).toEqual([])

    const unknownSku = randomUUID()
    const partialMerge = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/merge', headers: customerHeaders(other),
      payload: { mergeId: randomUUID(), items: [{ skuId: skuB!.skuId, quantity: 1 }, { skuId: unknownSku, quantity: 1 }] },
    })
    expect(partialMerge.statusCode).toBe(200)
    expect(partialMerge.json().data.skippedSkuIds).toEqual([unknownSku])
    expect(partialMerge.json().data.cart.items).toHaveLength(1)
  })

  it('re-quotes current prices and inventory, checks policies and eligibility, and has no transaction side effects', async () => {
    const customer = await createCustomer()
    const quantitySku = (await createCatalog({ mode: 'quantity', stocked: 2, fulfillmentMethod: 'manual' }))[0]!
    const unlimitedSku = (await createCatalog({ mode: 'unlimited', price: '0.20', fulfillmentMethod: 'manual' }))[0]!
    const freeSku = (await createCatalog({ mode: 'unlimited', price: '0.00', fulfillmentMethod: 'manual' }))[0]!

    const before = {
      product: await db.selectFrom('products').select('revision').where('id', '=', quantitySku!.productId).executeTakeFirstOrThrow(),
      variant: await db.selectFrom('product_variants').select(['revision', 'inventory_revision']).where('id', '=', quantitySku!.skuId).executeTakeFirstOrThrow(),
      inventory: await db.selectFrom('product_variant_quantity_inventory').selectAll().where('product_variant_id', '=', quantitySku!.skuId).executeTakeFirstOrThrow(),
      orders: await db.selectFrom('orders').select(eb => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
      reservations: await db.selectFrom('order_inventory_reservations').select(eb => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
      ledger: await db.selectFrom('wallet_ledger_entries').select(eb => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
    }

    const duplicateSkuQuote = await quote([
      { skuId: unlimitedSku!.skuId, quantity: 1 },
      { skuId: unlimitedSku!.skuId, quantity: 2 },
    ])
    expect(duplicateSkuQuote.statusCode).toBe(200)
    expect(duplicateSkuQuote.json().data.items).toHaveLength(1)
    expect(duplicateSkuQuote.json().data.items[0]).toMatchObject({ quantity: 3, unitPrice: '0.20', lineTotal: '0.60' })

    const multiQuote = await quote([
      { skuId: quantitySku!.skuId, quantity: 3 },
      { skuId: unlimitedSku!.skuId, quantity: 2 },
    ])
    expect(multiQuote.statusCode).toBe(200)
    expect(multiQuote.json().data.pricedSubtotal).toBe('0.70')
    expect(multiQuote.json().data.totalAmount).toBe('0.70')
    expect(multiQuote.json().data.items.find((item: { skuId: string }) => item.skuId === quantitySku!.skuId))
      .toMatchObject({ lineTotal: '0.30', reason: 'insufficient_inventory' })
    expect(multiQuote.json().data.items.find((item: { skuId: string }) => item.skuId === unlimitedSku!.skuId))
      .toMatchObject({ lineTotal: '0.40', reason: 'fulfillment_not_ready' })
    expect(multiQuote.json().data.policyReasons).toContain('guest_checkout_disabled')
    expect(multiQuote.headers['cache-control']).toContain('no-store')
    expect((await app.inject({
      method: 'POST', url: '/api/v1/checkout/quote', headers: { origin: testOrigin },
      payload: { items: [{ skuId: quantitySku.skuId, quantity: 1 }] },
    })).statusCode).toBe(403)

    const afterQuotes = {
      product: await db.selectFrom('products').select('revision').where('id', '=', quantitySku.productId).executeTakeFirstOrThrow(),
      variant: await db.selectFrom('product_variants').select(['revision', 'inventory_revision']).where('id', '=', quantitySku.skuId).executeTakeFirstOrThrow(),
      inventory: await db.selectFrom('product_variant_quantity_inventory').selectAll().where('product_variant_id', '=', quantitySku.skuId).executeTakeFirstOrThrow(),
      orders: await db.selectFrom('orders').select(eb => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
      reservations: await db.selectFrom('order_inventory_reservations').select(eb => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
      ledger: await db.selectFrom('wallet_ledger_entries').select(eb => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
    }
    expect(afterQuotes).toEqual(before)

    await db.updateTable('storefront_customer_policy').set({
      guest_checkout_enabled: true,
      guest_free_claim_enabled: true,
    }).execute()
    const freeQuote = await quote([{ skuId: freeSku!.skuId, quantity: 1 }])
    expect(freeQuote.json().data.guestFreeClaimEnabled).toBe(true)
    await db.updateTable('storefront_customer_policy').set({ guest_free_claim_enabled: false }).execute()
    const deniedFreeQuote = await quote([{ skuId: freeSku!.skuId, quantity: 1 }])
    expect(deniedFreeQuote.json().data.policyReasons).toContain('guest_free_claim_disabled')
    expect(deniedFreeQuote.json().data.canContinue).toBe(false)
    const authenticatedFreeQuote = await quote([{ skuId: freeSku.skuId, quantity: 1 }], customer)
    expect(authenticatedFreeQuote.json().data.customerAuthenticated).toBe(true)
    expect(authenticatedFreeQuote.json().data.policyReasons).toEqual([])

    for (const mode of ['resource_pool', 'external'] as const) {
      const notReadySku = (await createCatalog({ mode, fulfillmentMethod: 'manual' }))[0]!
      const result = await quote([{ skuId: notReadySku.skuId, quantity: 1 }])
      expect(result.json().data.items[0]).toMatchObject({ inventoryMode: mode, reason: 'inventory_not_ready' })
    }
    const draftSku = (await createCatalog({ status: 'draft', mode: 'unlimited', fulfillmentMethod: 'manual' }))[0]!
    expect((await quote([{ skuId: draftSku.skuId, quantity: 1 }])).json().data.items[0])
      .toMatchObject({ productStatus: 'draft', reason: 'product_not_active' })
    const unconfiguredSku = (await createCatalog())[0]!
    expect((await quote([{ skuId: unconfiguredSku.skuId, quantity: 1 }])).json().data.items[0].reason)
      .toBe('inventory_not_configured')
    const optionSku = await createOptionCatalog()
    await db.updateTable('product_option_groups').set({ name: '新套餐' }).where('product_id', '=', optionSku.productId).execute()
    await db.updateTable('product_option_values').set({ name: '年度版' }).where('product_id', '=', optionSku.productId).execute()
    expect((await quote([{ skuId: optionSku.skuId, quantity: 1 }])).json().data.items[0].options)
      .toEqual([{ groupId: expect.any(String), groupName: '新套餐', valueId: expect.any(String), valueName: '年度版' }])

    await db.updateTable('product_variants').set({ sale_price: '0.30' }).where('id', '=', quantitySku!.skuId).execute()
    const changedPriceQuote = await quote([{ skuId: quantitySku!.skuId, quantity: 2 }])
    expect(changedPriceQuote.json().data.items[0]).toMatchObject({ unitPrice: '0.30', lineTotal: '0.60' })
    await db.updateTable('products').set({ status: 'paused' }).where('id', '=', quantitySku!.productId).execute()
    const pausedQuote = await quote([{ skuId: quantitySku!.skuId, quantity: 1 }])
    expect(pausedQuote.json().data.items[0]).toMatchObject({ productStatus: 'paused', unitPrice: '0.30', reason: 'product_not_active' })
    await db.updateTable('products').set({ status: 'active' }).where('id', '=', quantitySku!.productId).execute()
    await db.updateTable('products').set({ status: 'archived' }).where('id', '=', quantitySku!.productId).execute()
    expect((await quote([{ skuId: quantitySku!.skuId, quantity: 1 }])).json().data.items[0].reason).toBe('product_not_active')
    await db.updateTable('products').set({ status: 'active' }).where('id', '=', quantitySku!.productId).execute()
    await db.updateTable('product_variants').set({ enabled: false }).where('id', '=', quantitySku!.skuId).execute()
    expect((await quote([{ skuId: quantitySku!.skuId, quantity: 1 }])).json().data.items[0].reason).toBe('sku_disabled')
    const retiredSku = (await createCatalog({ enabled: false }))[0]!
    await db.updateTable('product_variants').set({ retired_at: new Date() }).where('id', '=', retiredSku.skuId).execute()
    expect((await quote([{ skuId: retiredSku.skuId, quantity: 1 }])).json().data.items[0].reason).toBe('sku_retired')

    const switchableSku = (await createCatalog({ mode: 'quantity', stocked: 0, fulfillmentMethod: 'manual' }))[0]!
    const revisions = await db.selectFrom('products')
      .innerJoin('product_variants', 'product_variants.product_id', 'products.id')
      .select([
        'products.revision as productRevision',
        'product_variants.revision as skuRevision',
        'product_variants.inventory_revision as inventoryRevision',
      ])
      .where('products.id', '=', switchableSku.productId)
      .where('product_variants.id', '=', switchableSku.skuId)
      .executeTakeFirstOrThrow()
    const administrator = await createAdminSession()
    const modeChange = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/products/${switchableSku.productId}/variants/${switchableSku.skuId}/inventory-mode`,
      headers: { origin: testOrigin, cookie: administrator.cookie, 'x-csrf-token': administrator.csrf },
      payload: {
        expectedRevision: revisions.productRevision,
        expectedSkuRevision: revisions.skuRevision,
        expectedInventoryRevision: revisions.inventoryRevision,
        inventoryMode: 'unlimited',
      },
    })
    expect(modeChange.statusCode).toBe(200)
    expect((await quote([{ skuId: switchableSku.skuId, quantity: 1 }])).json().data.items[0])
      .toMatchObject({ inventoryMode: 'unlimited', reason: 'fulfillment_not_ready' })
  })

  it('rejects oversized cart inputs and settlement totals without floating-point arithmetic', async () => {
    const customer = await createCustomer()
    const [sku] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    expect((await quote([{ skuId: sku!.skuId, quantity: 0 }])).statusCode).toBe(400)
    expect((await quote([{ skuId: sku!.skuId, quantity: 100 }])).statusCode).toBe(400)
    expect((await quote([{ skuId: 'not-a-uuid', quantity: 1 }])).statusCode).toBe(400)
    expect((await quote([{ skuId: sku!.skuId, quantity: 99 }, { skuId: sku!.skuId, quantity: 1 }])).statusCode).toBe(400)
    const unknown = await quote([{ skuId: randomUUID(), quantity: 2 }])
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json().data.items[0]).toMatchObject({ identityValid: false, lineTotal: null, reason: 'sku_not_found' })
    expect(unknown.json().data.totalAmount).toBeNull()

    const largeSkus = await createCatalog({ price: '9999999999999.99', mode: 'unlimited', fulfillmentMethod: 'manual', count: 12 })
    // Isolate this amount-boundary assertion from earlier quote rate-limit use.
    const overflow = await quote(largeSkus.map(item => ({ skuId: item.skuId, quantity: 99 })),
      undefined, '192.0.2.44')
    expect(overflow.statusCode).toBe(422)

    const missingSkuAdd = await addCartItem(customer, randomUUID(), 1)
    expect(missingSkuAdd.statusCode).toBe(404)
  })

  it('enforces the 50-SKU cart cap and keeps retired catalog identities safe to read', async () => {
    const customer = await createCustomer()
    const skus = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual', count: 51 })
    const merged = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/merge', headers: customerHeaders(customer),
      payload: { mergeId: randomUUID(), items: skus.slice(0, 50).map(item => ({ skuId: item.skuId, quantity: 1 })) },
    })
    expect(merged.statusCode).toBe(200)
    expect(merged.json().data.cart.itemCount).toBe(50)
    expect((await addCartItem(customer, skus[50]!.skuId, 1)).statusCode).toBe(409)

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('product_variants').where('id', '=', skus[0]!.skuId).execute()
      await trx.deleteFrom('products').where('id', '=', skus[0]!.productId).execute()
    })
    const staleCart = await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: customer.sessionCookie } })
    expect(staleCart.statusCode).toBe(200)
    expect(staleCart.json().data.items.some((item: { skuId: string }) => item.skuId === skus[0]!.skuId)).toBe(true)
    expect(staleCart.json().data.items.find((item: { skuId: string }) => item.skuId === skus[0]!.skuId))
      .toMatchObject({ identityValid: false, reason: 'sku_not_found', lineTotal: null })
  })

  it('revokes disabled sessions and clears cart identity data on customer anonymization', async () => {
    const disabled = await createCustomer()
    const [disabledSku] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    expect((await addCartItem(disabled, disabledSku!.skuId, 1)).statusCode).toBe(200)
    await db.updateTable('customers').set({ status: 'disabled' }).where('id', '=', disabled.id).execute()
    expect((await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: disabled.sessionCookie } })).statusCode).toBe(401)
    expect((await addCartItem(disabled, disabledSku!.skuId, 1)).statusCode).toBe(401)

    const deleted = await createCustomer()
    const [deletedSku] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    expect((await addCartItem(deleted, deletedSku!.skuId, 1)).statusCode).toBe(200)
    const mergeId = randomUUID()
    expect((await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/merge', headers: customerHeaders(deleted),
      payload: { mergeId, items: [{ skuId: deletedSku!.skuId, quantity: 1 }] },
    })).statusCode).toBe(200)
    const administrator = await createAdminSession()
    const [formSku] = await createCatalog({ mode: 'unlimited', fulfillmentMethod: 'manual' })
    const fieldId = randomUUID()
    const createdTemplate = await app.inject({
      method: 'POST', url: '/api/v1/admin/purchase-form-templates',
      headers: { origin: testOrigin, cookie: administrator.cookie, 'x-csrf-token': administrator.csrf },
      payload: { name: '顾客删除回收模板', definition: { fields: [{
        id: fieldId, meaningKey: 'account', type: 'text', label: '账号', required: true, maxLength: 80,
      }] } },
    })
    expect(createdTemplate.statusCode, JSON.stringify(createdTemplate.json())).toBe(201)
    const frozen = await app.inject({
      method: 'POST', url: `/api/v1/admin/purchase-form-templates/${createdTemplate.json().data.template.id}/versions`,
      headers: { origin: testOrigin, cookie: administrator.cookie, 'x-csrf-token': administrator.csrf },
      payload: { expectedRevision: createdTemplate.json().data.template.revision },
    })
    expect(frozen.statusCode, JSON.stringify(frozen.json())).toBe(201)
    const versionId = frozen.json().data.id as string
    await db.insertInto('product_purchase_form_settings').values({
      product_id: formSku!.productId, mode: 'template', template_version_id: versionId,
      applied_mode: 'template', applied_template_version_id: versionId,
      updated_by_admin_id: administrator.id,
    }).execute()
    const lifecycle = await app.inject({ method: 'GET', url: '/api/v1/admin/storefront/purchase-forms',
      headers: { origin: testOrigin, cookie: administrator.cookie, 'x-csrf-token': administrator.csrf } })
    const activated = await app.inject({ method: 'POST', url: '/api/v1/admin/storefront/purchase-forms/transition',
      headers: { origin: testOrigin, cookie: administrator.cookie, 'x-csrf-token': administrator.csrf },
      payload: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: lifecycle.json().data.impactHash } })
    expect(activated.statusCode, JSON.stringify(activated.json())).toBe(200)
    const session = await db.selectFrom('customer_sessions').select('id')
      .where('customer_id', '=', deleted.id).executeTakeFirstOrThrow()
    const owner = { kind: 'customer' as const, customer: { id: deleted.id, sessionId: session.id } }
    const draft = await createPurchaseDraft(db, config, owner, versionId)
    const saved = await savePurchaseDraft(db, config, owner, {
      draftId: draft.id, expectedRevision: draft.revision, values: { [fieldId]: 'delete-owner' },
    })
    const addedForm = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items',
      headers: customerHeaders(deleted), payload: { version: 2, skuId: formSku!.skuId,
        quantity: 1, draftId: saved.id, draftRevision: saved.revision } })
    expect(addedForm.statusCode, JSON.stringify(addedForm.json())).toBe(200)
    const line = await db.selectFrom('customer_cart_items').select(['line_id', 'revision', 'draft_revision'])
      .where('customer_id', '=', deleted.id).where('sku_id', '=', formSku!.skuId).executeTakeFirstOrThrow()
    const edit = await app.inject({ method: 'POST',
      url: `/api/v1/customer/cart/lines/${line.line_id}/purchase-form/replacement-draft`,
      headers: customerHeaders(deleted), payload: { expectedLineRevision: line.revision,
        expectedDraftRevision: line.draft_revision } })
    expect(edit.statusCode, JSON.stringify(edit.json())).toBe(201)
    const replacementId = edit.json().data.replacementDraftId as string
    const anonymized = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/customers/${deleted.id}`,
      headers: { origin: testOrigin, cookie: administrator.cookie, 'x-csrf-token': administrator.csrf },
    })
    expect(anonymized.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { cookie: deleted.sessionCookie } })).statusCode).toBe(401)
    expect(await db.selectFrom('customer_cart_items').select('sku_id').where('customer_id', '=', deleted.id).execute()).toEqual([])
    expect(await db.selectFrom('customer_cart_merge_requests').select('merge_id').where('customer_id', '=', deleted.id).execute()).toEqual([])
    expect(await db.selectFrom('customer_cart_line_replacement_drafts').select('line_id')
      .where('line_id', '=', line.line_id).execute()).toEqual([])
    expect(await db.selectFrom('purchase_drafts').select('status').where('id', '=', replacementId)
      .executeTakeFirstOrThrow()).toEqual({ status: 'deleting' })
  })
})
