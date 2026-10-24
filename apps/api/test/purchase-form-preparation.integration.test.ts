import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Kysely, KyselyPlugin, Transaction } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { Migrator } from 'kysely/migration'
import sharp from 'sharp'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/password.js'
import { hashToken } from '../src/auth/security.js'
import type { AuthenticatedCustomer } from '../src/auth/customer.js'
import { readConfig } from '../src/config.js'
import type { AppConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import {
  claimGuestPurchaseDrafts,
  createPurchaseDraft,
  getPurchaseDraft,
  readPurchaseDraftAttachment,
  reconcilePurchaseDrafts,
  renewPurchaseDraft,
  requestPurchaseDraftAttachmentDeletion,
  requestPurchaseDraftDeletion,
  savePurchaseDraft,
  uploadPurchaseDraftAttachment,
  validatePurchaseDraftForPurchase,
} from '../src/commerce/purchase-forms.js'
import { PurchaseAttachmentStorage } from '../src/media/purchase-attachment-storage.js'
import { PrivateFileStorage } from '../src/media/private-file-storage.js'
import { reconcilePrivateFiles } from '../src/media/private-file-reconcile.js'
import type { PurchaseFormDefinition } from '@aikayun/contracts'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'
const keyA = Buffer.alloc(32, 0x31)
const keyB = Buffer.alloc(32, 0x52)
let app: FastifyInstance
let db: Kysely<Database>
let privateRoot: string
let publicRoot: string
let configA: AppConfig
let configRotated: AppConfig
let adminId: string
let adminCookie: string
let adminCsrfToken: string
let adminCsrfCookie: string
let nextIp = 1

type OwnerCustomer = Pick<AuthenticatedCustomer, 'id' | 'sessionId'> & { username: string; token: string }
type Guest = { id: string; token: string }
type TemplateFixture = { id: string; versionId: string; definition: PurchaseFormDefinition; ids: Record<string, string>; options: Record<string, string> }

function inject(options: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject({ ...options, remoteAddress: `198.51.100.${(nextIp++ % 240) + 1}` })
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find(value => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0] ?? ''
}

function adminHeaders() {
  return {
    origin,
    cookie: `${adminCookie}; ${adminCsrfCookie}`,
    'x-csrf-token': adminCsrfToken,
  }
}

async function makeCustomer(status: 'active' | 'disabled' = 'active', expiresInMs = 60 * 60_000): Promise<OwnerCustomer> {
  const id = randomUUID()
  const username = `draft-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const token = randomBytes(32).toString('base64url')
  const sessionId = randomUUID()
  const createdAt = new Date(Date.now() - (expiresInMs <= 0 ? 2 * 60 * 60_000 : 0))
  await db.insertInto('customers').values({
    id, username, password_hash: 'integration-only-not-a-real-password-hash', status,
  }).execute()
  await db.insertInto('customer_sessions').values({
    id: sessionId, customer_id: id, token_hash: hashToken(token),
    created_at: createdAt, expires_at: new Date(Date.now() + expiresInMs), revoked_at: null,
  }).execute()
  return { id, sessionId, username, token }
}

async function makeGuest(expiresInMs = 60 * 60_000): Promise<Guest> {
  const id = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const createdAt = new Date(Date.now() - (expiresInMs <= 0 ? 2 * 60 * 60_000 : 0))
  await db.insertInto('guest_order_sessions').values({
    id, token_hash: hashToken(token), created_at: createdAt,
    expires_at: new Date(Date.now() + expiresInMs), revoked_at: null,
  }).execute()
  return { id, token }
}

function customerOwner(customer: OwnerCustomer) {
  return { kind: 'customer' as const, customer: { id: customer.id, sessionId: customer.sessionId } }
}
function guestOwner(guest: Guest) { return { kind: 'guest' as const, guestSessionToken: guest.token } }

async function createCatalog() {
  const productId = randomUUID()
  const skuId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: productId, name: `准备关联隔离商品-${productId.slice(0, 8)}`,
      description: 'Integration fixture', product_type: 'digital', status: 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: skuId, product_id: productId, sku_code: `PREP-${skuId.slice(0, 8)}`,
      combination_key: '', sale_price: '12.50', enabled: true, retired_at: null,
      inventory_mode: 'unlimited', inventory_revision: 1,
    }).execute()
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: skuId, method: 'manual', manual_delivery_ready: true,
    }).execute()
  })
  return { productId, skuId }
}

function definitionFixture(): TemplateFixture {
  const accountId = randomUUID()
  const selectId = randomUUID()
  const planA = randomUUID()
  const planB = randomUUID()
  const cascadeId = randomUUID()
  const regionId = randomUUID()
  const serverId = randomUUID()
  const playerId = randomUUID()
  const imageId = randomUUID()
  const definition: PurchaseFormDefinition = {
    fields: [
      { id: accountId, meaningKey: 'account_number', type: 'digits', label: '账号编号', required: true, maxLength: 128 },
      { id: selectId, meaningKey: 'plan', type: 'select', label: '套餐', required: true, options: [
        { id: planA, meaningKey: 'standard', label: '标准' },
        { id: planB, meaningKey: 'premium', label: '高级' },
      ] },
      { id: cascadeId, meaningKey: 'region', type: 'cascade', label: '区服', required: true, options: [{
        id: regionId, meaningKey: 'east', label: '东区', children: [{
          id: serverId, meaningKey: 'server_1', label: '一区', expandedFields: [
            { id: playerId, meaningKey: 'player_name', type: 'text', label: '角色名', required: true, maxLength: 80 },
          ],
        }],
      }] },
      { id: imageId, meaningKey: 'screenshot', type: 'image', label: '截图', required: false, maxCount: 1 },
    ],
  }
  return {
    id: '', versionId: '', definition,
    ids: { accountId, selectId, cascadeId, regionId, serverId, playerId, imageId },
    options: { planA, planB },
  }
}

async function createTemplateFixture(admin: Awaited<ReturnType<typeof makeAdminSession>>): Promise<TemplateFixture> {
  const fixture = definitionFixture()
  const created = await inject({
    method: 'POST', url: '/api/v1/admin/purchase-form-templates', headers: admin.headers,
    payload: { name: '本地填写模板', definition: fixture.definition },
  })
  expect(created.statusCode, JSON.stringify(created.json())).toBe(201)
  const createdTemplate = created.json().data.template as { id: string; revision: number }
  fixture.id = createdTemplate.id

  const freeze = async (expectedRevision: number) => {
    const result = await inject({
      method: 'POST', url: `/api/v1/admin/purchase-form-templates/${fixture.id}/versions`,
      headers: admin.headers, payload: { expectedRevision },
    })
    expect(result.statusCode, JSON.stringify(result.json())).toBe(201)
    return result.json().data as { id: string; versionNumber: number }
  }

  const first = await freeze(createdTemplate.revision)
  fixture.versionId = first.id
  return fixture
}

async function makeAdminSession() {
  const token = randomBytes(32).toString('base64url')
  await db.insertInto('admin_sessions').values({
    id: randomUUID(), admin_user_id: adminId, token_hash: hashToken(token),
    expires_at: new Date(Date.now() + 60 * 60_000), revoked_at: null,
  }).execute()
  const csrf = await inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  expect(csrf.statusCode).toBe(200)
  const csrfToken = csrf.json().data.csrfToken as string
  const csrfCookie = cookieFrom(csrf, 'aikayun_admin_csrf')
  const cookie = `aikayun_admin_session=${token}`
  return {
    headers: { origin, cookie: `${cookie}; ${csrfCookie}`, 'x-csrf-token': csrfToken },
    cookie,
    csrfToken,
    csrfCookie,
  }
}

beforeAll(async () => {
  if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.slice(1).endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name an isolated PostgreSQL database ending in _test')
  }
  privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-purchase-form-integration-'))
  publicRoot = await mkdtemp(join(tmpdir(), 'aikayun-purchase-form-public-test-'))
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  const rotatedRing = JSON.stringify({ activeKeyId: 'draft-b', keys: { 'draft-a': keyA.toString('base64'), 'draft-b': keyB.toString('base64') } })
  const baseEnv = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    PRIVATE_FILE_ROOT: privateRoot,
    MEDIA_ROOT: publicRoot,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: origin,
    COOKIE_SECURE: 'false',
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({ activeKeyId: 'draft-a', keys: { 'draft-a': keyA.toString('base64') } }),
    CODE_POOL_ENCRYPTION_KEY_RING: JSON.stringify({ activeKeyId: 'code-pool-test', keys: { 'code-pool-test': Buffer.alloc(32, 0x68).toString('base64') } }),
  }
  configA = readConfig(baseEnv)
  configRotated = readConfig({ ...baseEnv, PAYMENT_CREDENTIAL_KEY_RING: rotatedRing })
  adminId = randomUUID()
  await db.insertInto('admin_users').values({
    id: adminId, email: `purchase-forms-${adminId.slice(0, 8)}@example.test`, password_hash: await hashPassword('integration-admin-password'),
  }).execute()
  app = await createApp({ db, config: configA, logger: false })
  await app.ready()
  const admin = await makeAdminSession()
  adminCookie = admin.cookie
  adminCsrfToken = admin.csrfToken
  adminCsrfCookie = admin.csrfCookie
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true })
  if (publicRoot) await rm(publicRoot, { recursive: true, force: true })
})

describe('⑥-2A preparation and private draft foundations on PostgreSQL', () => {
  it('preserves frozen templates, identities and audit payloads while applying the forward delete fix', async () => {
    const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
    const baseline = await migrator.migrateTo('202610240002_purchase_forms_drafts')
    expect(baseline.error).toBeUndefined()
    const admin = await makeAdminSession()
    const fixture = await createTemplateFixture(admin)
    const catalog = await createCatalog()
    const product = await db.selectFrom('products').select('revision').where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const productAssignment = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/purchase-form`, headers: admin.headers,
      payload: { expectedRevision: product.revision, mode: 'template', templateVersionId: fixture.versionId },
    })
    expect(productAssignment.statusCode).toBe(200)
    const current = await db.selectFrom('products').select('revision').where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const skuAssignment = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/purchase-form`, headers: admin.headers,
      payload: { expectedRevision: current.revision, mode: 'none' },
    })
    expect(skuAssignment.statusCode).toBe(200)
    const versionBefore = await db.selectFrom('purchase_form_template_versions').selectAll()
      .where('id', '=', fixture.versionId).executeTakeFirstOrThrow()
    const identitiesBefore = await db.selectFrom('purchase_form_template_identities').selectAll()
      .where('template_id', '=', fixture.id).orderBy('id').execute()
    const eventsBefore = await db.selectFrom('purchase_form_audit_events').selectAll()
      .where('product_id', '=', catalog.productId).orderBy('created_at').orderBy('id').execute()
    expect(eventsBefore).toHaveLength(2)

    const upgraded = await migrator.migrateToLatest()
    expect(upgraded.error).toBeUndefined()
    expect(await db.selectFrom('purchase_form_template_versions').selectAll()
      .where('id', '=', fixture.versionId).executeTakeFirstOrThrow()).toEqual(versionBefore)
    expect(await db.selectFrom('purchase_form_template_identities').selectAll()
      .where('template_id', '=', fixture.id).orderBy('id').execute()).toEqual(identitiesBefore)
    expect(await db.selectFrom('purchase_form_audit_events').selectAll()
      .where('product_id', '=', catalog.productId).orderBy('created_at').orderBy('id').execute()).toEqual(eventsBefore)
    await expect(sql`UPDATE purchase_form_audit_events SET summary = summary WHERE id = ${eventsBefore[0]!.id}`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'purchase_form_history_immutable' })
    await expect(sql`DELETE FROM purchase_form_audit_events WHERE id = ${eventsBefore[0]!.id}`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'purchase_form_history_immutable' })
    expect((await db.selectFrom('product_purchase_form_settings').select('template_version_id')
      .where('product_id', '=', catalog.productId).executeTakeFirstOrThrow()).template_version_id).toBe(fixture.versionId)
  }, 45_000)

  it('rejects malformed nested expanded fields on create and revision without partial writes', async () => {
    const admin = await makeAdminSession()
    const fixture = definitionFixture()
    const created = await inject({
      method: 'POST', url: '/api/v1/admin/purchase-form-templates', headers: admin.headers,
      payload: { name: '非法深层字段回归', definition: fixture.definition },
    })
    expect(created.statusCode).toBe(201)
    const templateId = created.json().data.template.id as string
    const revision = created.json().data.template.revision as number
    const baselineIdentityCount = Number((await db.selectFrom('purchase_form_template_identities')
      .select(db.fn.countAll<number>().as('count')).where('template_id', '=', templateId).executeTakeFirstOrThrow()).count)
    const baselineAuditCount = Number((await db.selectFrom('purchase_form_audit_events')
      .select(db.fn.countAll<number>().as('count')).where('template_id', '=', templateId).executeTakeFirstOrThrow()).count)

    for (const malformed of [null, 9, []]) {
      const definition = structuredClone(fixture.definition) as unknown as Record<string, unknown>
      const fields = definition.fields as Array<Record<string, unknown>>
      const cascade = fields.find(row => row.type === 'cascade')!
      const rootOption = (cascade.options as Array<Record<string, unknown>>)[0]!
      let deepest = (rootOption.children as Array<Record<string, unknown>>)[0]!
      for (let depth = 3; depth <= 5; depth += 1) {
        const child = { id: randomUUID(), meaningKey: `deep_option_${depth}`, label: `第${depth}层` }
        const children = deepest.children as Array<Record<string, unknown>> | undefined
        deepest.children = children ? [...children, child] : [child]
        deepest = child
      }
      deepest.expandedFields = [malformed]
      const payload = { name: '非法深层字段回归', definition }
      const badCreate = await inject({
        method: 'POST', url: '/api/v1/admin/purchase-form-templates', headers: admin.headers, payload,
      })
      expect(badCreate.statusCode, JSON.stringify(badCreate.json())).toBe(400)
      const badUpdate = await inject({
        method: 'PUT', url: `/api/v1/admin/purchase-form-templates/${templateId}`, headers: admin.headers,
        payload: { ...payload, expectedRevision: revision },
      })
      expect(badUpdate.statusCode, JSON.stringify(badUpdate.json())).toBe(400)
      expect(await db.selectFrom('purchase_form_templates').select('revision').where('id', '=', templateId).executeTakeFirstOrThrow())
        .toEqual({ revision })
      expect(Number((await db.selectFrom('purchase_form_template_identities').select(db.fn.countAll<number>().as('count'))
        .where('template_id', '=', templateId).executeTakeFirstOrThrow()).count)).toBe(baselineIdentityCount)
      expect(Number((await db.selectFrom('purchase_form_audit_events').select(db.fn.countAll<number>().as('count'))
        .where('template_id', '=', templateId).executeTakeFirstOrThrow()).count)).toBe(baselineAuditCount)
    }

    let deepest: Record<string, unknown> = {
      id: randomUUID(), meaningKey: 'deep_choice_5', label: '第五层',
      expandedFields: [{
        id: randomUUID(), meaningKey: 'deep_expanded_select', type: 'select', label: '深层单选', required: true,
        options: [{ id: randomUUID(), meaningKey: 'deep_expanded_option', label: '选项一' }],
      }],
    }
    for (let depth = 4; depth >= 2; depth -= 1) {
      deepest = { id: randomUUID(), meaningKey: `deep_choice_${depth}`, label: `第${depth}层`, children: [deepest] }
    }
    const legalDefinition = structuredClone(fixture.definition)
    const legalCascade = legalDefinition.fields.find(row => row.type === 'cascade')
    if (legalCascade?.type !== 'cascade') throw new Error('cascade fixture missing')
    legalCascade.options = [{ id: randomUUID(), meaningKey: 'legal_root', label: '第一层', children: [deepest as never] }]
    const legal = await inject({
      method: 'POST', url: '/api/v1/admin/purchase-form-templates', headers: admin.headers,
      payload: { name: '五级级联单选扩展', definition: legalDefinition },
    })
    expect(legal.statusCode, JSON.stringify(legal.json())).toBe(201)
  }, 45_000)

  it('deletes only safe prepared products while retaining immutable purchase-form audit identities', async () => {
    const admin = await makeAdminSession()
    const fixture = await createTemplateFixture(admin)
    const putProductAssignment = async (productId: string, mode: 'template' | 'not_configured', versionId?: string) => {
      const product = await db.selectFrom('products').select('revision').where('id', '=', productId).executeTakeFirstOrThrow()
      return inject({
        method: 'PUT', url: `/api/v1/admin/products/${productId}/purchase-form`, headers: admin.headers,
        payload: { expectedRevision: product.revision, mode, ...(versionId ? { templateVersionId: versionId } : {}) },
      })
    }
    const deleteAtCurrentRevision = async (productId: string) => {
      const product = await db.selectFrom('products').select('revision').where('id', '=', productId).executeTakeFirstOrThrow()
      return inject({
        method: 'DELETE', url: `/api/v1/admin/products/${productId}`, headers: admin.headers,
        payload: { expectedRevision: product.revision },
      })
    }
    const retainedEvents = async (productId: string) => db.selectFrom('purchase_form_audit_events').selectAll()
      .where('product_id', '=', productId).orderBy('created_at').orderBy('id').execute()

    const configured = await createCatalog()
    expect((await putProductAssignment(configured.productId, 'template', fixture.versionId)).statusCode).toBe(200)
    const configuredEvents = await retainedEvents(configured.productId)
    expect(configuredEvents).toHaveLength(1)
    const configuredDelete = await deleteAtCurrentRevision(configured.productId)
    expect(configuredDelete.statusCode, JSON.stringify(configuredDelete.json())).toBe(200)
    expect(await db.selectFrom('products').select('id').where('id', '=', configured.productId).execute()).toHaveLength(0)
    expect(await retainedEvents(configured.productId)).toEqual(configuredEvents)
    expect(configuredEvents[0]).toMatchObject({ product_id: configured.productId, operation: 'product_assignment_updated' })

    const cleared = await createCatalog()
    expect((await putProductAssignment(cleared.productId, 'template', fixture.versionId)).statusCode).toBe(200)
    expect((await putProductAssignment(cleared.productId, 'not_configured')).statusCode).toBe(200)
    const clearedEvents = await retainedEvents(cleared.productId)
    expect(await db.selectFrom('product_purchase_form_settings').select('product_id').where('product_id', '=', cleared.productId).execute()).toEqual([])
    const clearedDelete = await deleteAtCurrentRevision(cleared.productId)
    expect(clearedDelete.statusCode, JSON.stringify(clearedDelete.json())).toBe(200)
    expect(await retainedEvents(cleared.productId)).toEqual(clearedEvents)

    const inherited = await createCatalog()
    const skuProduct = await db.selectFrom('products').select('revision').where('id', '=', inherited.productId).executeTakeFirstOrThrow()
    const override = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${inherited.productId}/variants/${inherited.skuId}/purchase-form`, headers: admin.headers,
      payload: { expectedRevision: skuProduct.revision, mode: 'template', templateVersionId: fixture.versionId },
    })
    expect(override.statusCode).toBe(200)
    const currentSkuProduct = await db.selectFrom('products').select('revision').where('id', '=', inherited.productId).executeTakeFirstOrThrow()
    const restoreInheritance = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${inherited.productId}/variants/${inherited.skuId}/purchase-form`, headers: admin.headers,
      payload: { expectedRevision: currentSkuProduct.revision, mode: 'product_default' },
    })
    expect(restoreInheritance.statusCode).toBe(200)
    expect(await db.selectFrom('sku_purchase_form_overrides').selectAll().where('product_id', '=', inherited.productId).execute()).toEqual([])
    const inheritedEvents = await retainedEvents(inherited.productId)
    expect(inheritedEvents).toHaveLength(2)
    const inheritedDelete = await deleteAtCurrentRevision(inherited.productId)
    expect(inheritedDelete.statusCode, JSON.stringify(inheritedDelete.json())).toBe(200)
    expect(await retainedEvents(inherited.productId)).toEqual(inheritedEvents)

    const stocked = await createCatalog()
    expect((await putProductAssignment(stocked.productId, 'template', fixture.versionId)).statusCode).toBe(200)
    const product = await db.selectFrom('products').select('revision').where('id', '=', stocked.productId).executeTakeFirstOrThrow()
    const sku = await db.selectFrom('product_variants').select(['revision', 'inventory_revision'])
      .where('id', '=', stocked.skuId).executeTakeFirstOrThrow()
    const quantityMode = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${stocked.productId}/variants/${stocked.skuId}/inventory-mode`, headers: admin.headers,
      payload: {
        expectedRevision: product.revision, expectedSkuRevision: sku.revision,
        expectedInventoryRevision: sku.inventory_revision, inventoryMode: 'quantity',
      },
    })
    expect(quantityMode.statusCode, JSON.stringify(quantityMode.json())).toBe(200)
    await db.updateTable('product_variant_quantity_inventory').set({ stocked: 1 })
      .where('product_variant_id', '=', stocked.skuId).execute()
    const blocked = await deleteAtCurrentRevision(stocked.productId)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('PRODUCT_HAS_INVENTORY')
    expect(await db.selectFrom('products').select('id').where('id', '=', stocked.productId).execute()).toHaveLength(1)
    expect(await retainedEvents(stocked.productId)).toHaveLength(1)
  }, 45_000)

  it('revision-checks admin template edits, freezes immutable history and stores only preparation associations', async () => {
    const unauthorized = await inject({ method: 'GET', url: '/api/v1/admin/purchase-form-templates' })
    expect(unauthorized.statusCode).toBe(401)

    const fixture = definitionFixture()
    const created = await inject({
      method: 'POST', url: '/api/v1/admin/purchase-form-templates', headers: adminHeaders(),
      payload: { name: '本地填写模板', definition: fixture.definition },
    })
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201)
    const createdTemplate = created.json().data.template as { id: string; revision: number }
    fixture.id = createdTemplate.id

    const relabelled = structuredClone(fixture.definition)
    relabelled.fields[0]!.label = '账号'
    const update = await inject({
      method: 'PUT', url: `/api/v1/admin/purchase-form-templates/${fixture.id}`, headers: adminHeaders(),
      payload: { expectedRevision: createdTemplate.revision, name: '本地填写模板', definition: relabelled },
    })
    expect(update.statusCode).toBe(200)
    const updatedTemplate = update.json().data.template as { revision: number }

    const stale = await inject({
      method: 'PUT', url: `/api/v1/admin/purchase-form-templates/${fixture.id}`, headers: adminHeaders(),
      payload: { expectedRevision: createdTemplate.revision, name: '过期覆盖', definition: relabelled },
    })
    expect(stale.statusCode).toBe(409)
    const changedMeaning = structuredClone(relabelled)
    changedMeaning.fields[0]!.meaningKey = 'different_business_meaning'
    const meaningReuse = await inject({
      method: 'PUT', url: `/api/v1/admin/purchase-form-templates/${fixture.id}`, headers: adminHeaders(),
      payload: { expectedRevision: updatedTemplate.revision, name: '本地填写模板', definition: changedMeaning },
    })
    expect(meaningReuse.statusCode).toBe(409)
    expect(meaningReuse.json().error.code).toBe('PURCHASE_FORM_IDENTITY_REUSE')

    const freeze = await inject({
      method: 'POST', url: `/api/v1/admin/purchase-form-templates/${fixture.id}/versions`, headers: adminHeaders(),
      payload: { expectedRevision: updatedTemplate.revision },
    })
    expect(freeze.statusCode).toBe(201)
    const version = freeze.json().data as { id: string; name: string; versionNumber: number; definition: PurchaseFormDefinition }
    fixture.versionId = version.id
    expect(version.versionNumber).toBe(1)
    expect(version.definition.fields[0]?.label).toBe('账号')
    await expect(db.updateTable('purchase_form_template_versions').set({ name: 'SQL rewrite' })
      .where('id', '=', version.id).execute()).rejects.toMatchObject({ constraint: 'purchase_form_history_immutable' })
    await expect(db.deleteFrom('purchase_form_template_versions').where('id', '=', version.id).execute())
      .rejects.toMatchObject({ constraint: 'purchase_form_history_immutable' })
    await expect(sql`TRUNCATE TABLE purchase_form_template_versions CASCADE`.execute(db))
      .rejects.toMatchObject({ constraint: 'purchase_form_history_immutable' })
    await expect(sql`TRUNCATE TABLE purchase_form_template_identities`.execute(db))
      .rejects.toMatchObject({ constraint: 'purchase_form_history_immutable' })

    const catalog = await createCatalog()
    const productBefore = await db.selectFrom('products').select(['status', 'revision']).where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const variantBefore = await db.selectFrom('product_variants').select(['sale_price', 'inventory_mode', 'inventory_revision', 'enabled'])
      .where('id', '=', catalog.skuId).executeTakeFirstOrThrow()
    const fulfillmentBefore = await db.selectFrom('product_variant_fulfillment').selectAll().where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()
    const publicBefore = await inject({ method: 'GET', url: `/api/v1/public/products/${catalog.productId}` })
    expect(publicBefore.statusCode).toBe(200)

    const productAssignment = await inject({ method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/purchase-form`, headers: adminHeaders() })
    expect(productAssignment.json().data.mode).toBe('not_configured')
    const buyer = await makeCustomer()
    const buyerCsrfResponse = await inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
    const buyerCsrf = buyerCsrfResponse.json().data.csrfToken as string
    const buyerCsrfCookie = cookieFrom(buyerCsrfResponse, 'aikayun_customer_csrf')
    const buyerHeaders = {
      origin,
      cookie: `aikayun_customer_session=${buyer.token}; ${buyerCsrfCookie}`,
      'x-csrf-token': buyerCsrf,
    }
    const quoteBefore = await inject({
      method: 'POST', url: '/api/v1/checkout/quote', headers: buyerHeaders,
      payload: { items: [{ skuId: catalog.skuId, quantity: 1 }] },
    })
    expect(quoteBefore.statusCode, JSON.stringify(quoteBefore.json())).toBe(200)
    expect(quoteBefore.json().data.canContinue).toBe(true)
    const assignedProduct = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/purchase-form`, headers: adminHeaders(),
      payload: { expectedRevision: productBefore.revision, mode: 'template', templateVersionId: version.id },
    })
    expect(assignedProduct.statusCode, JSON.stringify(assignedProduct.json())).toBe(200)
    expect(assignedProduct.json().data.mode).toBe('template')
    expect(assignedProduct.json().data.templateVersion.templateName).toBe(version.name)
    const templateRevision = await db.selectFrom('purchase_form_templates').select('revision')
      .where('id', '=', fixture.id).executeTakeFirstOrThrow()
    const renamedTemplate = await inject({
      method: 'PUT', url: `/api/v1/admin/purchase-form-templates/${fixture.id}`, headers: adminHeaders(),
      payload: { expectedRevision: templateRevision.revision, name: '修改后的模板名称', definition: fixture.definition },
    })
    expect(renamedTemplate.statusCode).toBe(200)
    const assignmentAfterRename = await inject({
      method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/purchase-form`, headers: adminHeaders(),
    })
    expect(assignmentAfterRename.json().data.templateVersion.templateName).toBe(version.name)
    const assignedSku = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/purchase-form`, headers: adminHeaders(),
      payload: { expectedRevision: assignedProduct.json().data.productRevision, mode: 'none' },
    })
    expect(assignedSku.statusCode).toBe(200)
    expect(assignedSku.json().data.mode).toBe('none')

    const [productAfter, variantAfter, fulfillmentAfter, publicAfter] = await Promise.all([
      db.selectFrom('products').select(['status']).where('id', '=', catalog.productId).executeTakeFirstOrThrow(),
      db.selectFrom('product_variants').select(['sale_price', 'inventory_mode', 'inventory_revision', 'enabled']).where('id', '=', catalog.skuId).executeTakeFirstOrThrow(),
      db.selectFrom('product_variant_fulfillment').selectAll().where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow(),
      inject({ method: 'GET', url: `/api/v1/public/products/${catalog.productId}` }),
    ])
    expect(productAfter.status).toBe(productBefore.status)
    expect(variantAfter).toEqual(variantBefore)
    expect(fulfillmentAfter).toEqual(fulfillmentBefore)
    expect(publicAfter.statusCode).toBe(200)
    expect(JSON.stringify(publicAfter.json().data)).not.toContain('purchaseForm')
    expect((await inject({ method: 'GET', url: `/api/v1/public/purchase-form-templates/${version.id}` })).statusCode).toBe(404)
    expect((await inject({ method: 'POST', url: '/api/v1/customer/purchase-drafts', payload: { templateVersionId: version.id } })).statusCode).toBe(404)
    const quoteAfter = await inject({
      method: 'POST', url: '/api/v1/checkout/quote', headers: buyerHeaders,
      payload: { items: [{ skuId: catalog.skuId, quantity: 1 }] },
    })
    expect(quoteAfter.statusCode).toBe(200)
    expect(quoteAfter.json().data.canContinue).toBe(true)
    expect(quoteBefore.json().data.items[0].lineTotal).toBe('12.50')
    expect(quoteAfter.json().data.items[0].lineTotal).toBe('12.50')
    expect(quoteAfter.json().data.items[0].lineTotal).toBe(quoteBefore.json().data.items[0].lineTotal)
    const order = await inject({
      method: 'POST', url: '/api/v1/checkout/orders', headers: buyerHeaders,
      payload: { idempotencyKey: randomUUID(), quoteToken: quoteAfter.json().data.quoteToken, items: [{ skuId: catalog.skuId, quantity: 1 }] },
    })
    expect(order.statusCode, JSON.stringify(order.json())).toBe(201)
  }, 45_000)

  it('isolates customer and guest draft ownership, pins versions, checks completeness and performs one-way claim', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const ordersBeforeClaim = await db.selectFrom('orders').select(db.fn.countAll<number>().as('total')).executeTakeFirstOrThrow()
    const customerA = await makeCustomer()
    const customerB = await makeCustomer()
    const guestX = await makeGuest()
    const guestY = await makeGuest()
    const ownerA = customerOwner(customerA)
    const ownerB = customerOwner(customerB)
    const ownerX = guestOwner(guestX)
    const ownerY = guestOwner(guestY)
    const customerDraft = await createPurchaseDraft(db, configA, ownerA, fixture.versionId)
    const guestDraft = await createPurchaseDraft(db, configA, ownerX, fixture.versionId)
    const otherGuestDraft = await createPurchaseDraft(db, configA, ownerY, fixture.versionId)
    await expect(getPurchaseDraft(db, configA, ownerB, customerDraft.id)).rejects.toMatchObject({ status: 404 })
    await expect(getPurchaseDraft(db, configA, ownerX, customerDraft.id)).rejects.toMatchObject({ status: 404 })
    await expect(getPurchaseDraft(db, configA, ownerY, guestDraft.id)).rejects.toMatchObject({ status: 404 })
    await expect(savePurchaseDraft(db, configA, ownerB, {
      draftId: customerDraft.id, expectedRevision: 1, values: {},
    })).rejects.toMatchObject({ status: 404 })

    const incomplete = await savePurchaseDraft(db, configA, ownerA, {
      draftId: customerDraft.id, expectedRevision: 1, values: { [fixture.ids.accountId]: '000000000000000000123' },
    })
    expect(incomplete.complete).toBe(false)
    expect(incomplete.incompleteFieldIds).toEqual([fixture.ids.selectId, fixture.ids.cascadeId].sort())
    await expect(validatePurchaseDraftForPurchase(db, configA, ownerA, customerDraft.id))
      .rejects.toMatchObject({ status: 400, fieldIds: expect.arrayContaining([fixture.ids.selectId, fixture.ids.cascadeId]) })
    const completeValues = {
      [fixture.ids.accountId]: '000000000000000000123',
      [fixture.ids.selectId]: fixture.options.planA,
      [fixture.ids.cascadeId]: { path: [fixture.ids.regionId, fixture.ids.serverId], expanded: { [fixture.ids.playerId]: ' Player-X ' } },
    }
    const saved = await savePurchaseDraft(db, configA, ownerA, {
      draftId: customerDraft.id, expectedRevision: incomplete.revision, values: completeValues,
    })
    expect(saved.complete).toBe(true)
    expect(saved.normalizedValues[fixture.ids.accountId]).toBe('000000000000000000123')
    const encryptedRow = await db.selectFrom('purchase_drafts').select(['encrypted_payload', 'encryption_key_id', 'revision'])
      .where('id', '=', customerDraft.id).executeTakeFirstOrThrow()
    expect(encryptedRow.encryption_key_id).toBe('draft-a')
    expect(encryptedRow.encrypted_payload.includes(Buffer.from('Player-X'))).toBe(false)
    expect(encryptedRow.encrypted_payload.includes(Buffer.from('000000000000000000123'))).toBe(false)
    const rotatedView = await getPurchaseDraft(db, configRotated, ownerA, customerDraft.id)
    expect(rotatedView.values).toEqual(saved.normalizedValues)
    const secondSave = await savePurchaseDraft(db, configRotated, ownerA, {
      draftId: customerDraft.id, expectedRevision: saved.revision, values: completeValues,
    })
    expect((await db.selectFrom('purchase_drafts').select('encryption_key_id').where('id', '=', customerDraft.id).executeTakeFirstOrThrow()).encryption_key_id).toBe('draft-b')
    await expect(savePurchaseDraft(db, configA, ownerA, {
      draftId: customerDraft.id, expectedRevision: saved.revision, values: {},
    })).rejects.toMatchObject({ status: 409 })
    const beforeRenewal = (await getPurchaseDraft(db, configRotated, ownerA, customerDraft.id)).expiresAt
    const renewed = await renewPurchaseDraft(db, ownerA, customerDraft.id, secondSave.revision)
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(new Date(beforeRenewal).getTime())

    const renamed = structuredClone(fixture.definition)
    renamed.fields[0]!.label = '新账号标题'
    const detail = await inject({ method: 'GET', url: `/api/v1/admin/purchase-form-templates/${fixture.id}`, headers: adminHeaders() })
    const update = await inject({
      method: 'PUT', url: `/api/v1/admin/purchase-form-templates/${fixture.id}`, headers: adminHeaders(),
      payload: { expectedRevision: detail.json().data.template.revision, name: '新版本名称', definition: renamed },
    })
    expect(update.statusCode).toBe(200)
    const updated = update.json().data.template as { revision: number }
    const frozen = await inject({
      method: 'POST', url: `/api/v1/admin/purchase-form-templates/${fixture.id}/versions`, headers: adminHeaders(),
      payload: { expectedRevision: updated.revision },
    })
    expect(frozen.statusCode).toBe(201)
    const latestVersion = frozen.json().data as { id: string; versionNumber: number }
    expect(latestVersion.versionNumber).toBe(2)
    expect((await getPurchaseDraft(db, configRotated, ownerA, customerDraft.id)).templateVersionId).toBe(fixture.versionId)
    expect((await getPurchaseDraft(db, configRotated, ownerA, customerDraft.id)).values[fixture.ids.accountId]).toBe('000000000000000000123')

    const claim = await claimGuestPurchaseDrafts(db, customerA, guestX.token, [guestDraft.id])
    expect(claim).toEqual({ claimedCount: 1, alreadyClaimedCount: 0 })
    expect(await claimGuestPurchaseDrafts(db, customerA, guestX.token, [guestDraft.id]))
      .toEqual({ claimedCount: 0, alreadyClaimedCount: 1 })
    await expect(getPurchaseDraft(db, configA, ownerX, guestDraft.id)).rejects.toMatchObject({ status: 404 })
    await expect(getPurchaseDraft(db, configA, ownerB, guestDraft.id)).rejects.toMatchObject({ status: 404 })
    await expect(claimGuestPurchaseDrafts(db, customerB, guestX.token, [guestDraft.id])).rejects.toMatchObject({ status: 404 })
    await expect(db.updateTable('purchase_drafts').set({ customer_id: customerB.id })
      .where('id', '=', guestDraft.id).execute()).rejects.toMatchObject({ constraint: 'purchase_draft_owner_transfer_invalid' })
    const guestRow = await db.selectFrom('purchase_drafts').select(['customer_id', 'guest_order_session_id', 'claimed_from_guest_order_session_id'])
      .where('id', '=', guestDraft.id).executeTakeFirstOrThrow()
    expect(guestRow).toMatchObject({ customer_id: customerA.id, guest_order_session_id: null, claimed_from_guest_order_session_id: guestX.id })
    const ordersAfterClaim = await db.selectFrom('orders').select(db.fn.countAll<number>().as('total')).executeTakeFirstOrThrow()
    expect(Number(ordersAfterClaim.total)).toBe(Number(ordersBeforeClaim.total))
    expect((await getPurchaseDraft(db, configA, ownerY, otherGuestDraft.id)).templateVersionId).toBe(fixture.versionId)

    const expiredCustomer = await makeCustomer('active', -1)
    const expiredGuest = await makeGuest(-1)
    await expect(createPurchaseDraft(db, configA, customerOwner(expiredCustomer), fixture.versionId)).rejects.toMatchObject({ status: 401 })
    await expect(createPurchaseDraft(db, configA, guestOwner(expiredGuest), fixture.versionId)).rejects.toMatchObject({ status: 401 })
    const revokedCustomer = await makeCustomer()
    const revokedCustomerDraft = await createPurchaseDraft(db, configA, customerOwner(revokedCustomer), fixture.versionId)
    await db.updateTable('customer_sessions').set({ revoked_at: new Date() }).where('id', '=', revokedCustomer.sessionId).execute()
    await expect(getPurchaseDraft(db, configA, customerOwner(revokedCustomer), revokedCustomerDraft.id)).rejects.toMatchObject({ status: 401 })
    const revokedGuest = await makeGuest()
    const revokedGuestDraft = await createPurchaseDraft(db, configA, guestOwner(revokedGuest), fixture.versionId)
    await db.updateTable('guest_order_sessions').set({ revoked_at: new Date() }).where('id', '=', revokedGuest.id).execute()
    await expect(getPurchaseDraft(db, configA, guestOwner(revokedGuest), revokedGuestDraft.id)).rejects.toMatchObject({ status: 401 })
    await db.updateTable('customers').set({ status: 'disabled' }).where('id', '=', customerB.id).execute()
    await expect(createPurchaseDraft(db, configA, ownerB, fixture.versionId)).rejects.toMatchObject({ status: 401 })
  }, 45_000)

  it('serializes draft creation and guest claiming against the per-owner active draft cap', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const fill = async (owner: ReturnType<typeof customerOwner> | ReturnType<typeof guestOwner>, count: number) => {
      const ids: string[] = []
      for (let index = 0; index < count; index += 1) {
        ids.push((await createPurchaseDraft(db, configA, owner, fixture.versionId)).id)
      }
      return ids
    }
    const countForCustomer = async (customerId: string) => Number((await db.selectFrom('purchase_drafts')
      .select(db.fn.countAll<number>().as('count')).where('customer_id', '=', customerId)
      .where('status', '=', 'active').where('expires_at', '>', new Date()).executeTakeFirstOrThrow()).count)
    const countForGuest = async (guestId: string) => Number((await db.selectFrom('purchase_drafts')
      .select(db.fn.countAll<number>().as('count')).where('guest_order_session_id', '=', guestId)
      .where('status', '=', 'active').where('expires_at', '>', new Date()).executeTakeFirstOrThrow()).count)

    for (const kind of ['customer', 'guest'] as const) {
      const identity = kind === 'customer' ? await makeCustomer() : await makeGuest()
      const owner = kind === 'customer' ? customerOwner(identity as OwnerCustomer) : guestOwner(identity as Guest)
      await fill(owner, 49)
      const concurrent = await Promise.allSettled([
        createPurchaseDraft(db, configA, owner, fixture.versionId),
        createPurchaseDraft(db, configA, owner, fixture.versionId),
      ])
      expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1)
      if (kind === 'customer') expect(await countForCustomer((identity as OwnerCustomer).id)).toBe(50)
      else expect(await countForGuest((identity as Guest).id)).toBe(50)
    }

    const alreadyClaimedCustomer = await makeCustomer()
    const alreadyClaimedGuest = await makeGuest()
    await fill(customerOwner(alreadyClaimedCustomer), 49)
    const claimedDraft = await createPurchaseDraft(db, configA, guestOwner(alreadyClaimedGuest), fixture.versionId)
    expect(await claimGuestPurchaseDrafts(db, alreadyClaimedCustomer, alreadyClaimedGuest.token, [claimedDraft.id]))
      .toEqual({ claimedCount: 1, alreadyClaimedCount: 0 })
    expect(await countForCustomer(alreadyClaimedCustomer.id)).toBe(50)
    expect(await claimGuestPurchaseDrafts(db, alreadyClaimedCustomer, alreadyClaimedGuest.token, [claimedDraft.id]))
      .toEqual({ claimedCount: 0, alreadyClaimedCount: 1 })

    const fullCustomer = await makeCustomer()
    const fullGuest = await makeGuest()
    await fill(customerOwner(fullCustomer), 50)
    const unclaimed = await createPurchaseDraft(db, configA, guestOwner(fullGuest), fixture.versionId)
    await expect(claimGuestPurchaseDrafts(db, fullCustomer, fullGuest.token, [unclaimed.id]))
      .rejects.toMatchObject({ status: 409, code: 'PURCHASE_DRAFT_LIMIT' })
    await expect(getPurchaseDraft(db, configA, guestOwner(fullGuest), unclaimed.id)).resolves.toMatchObject({ id: unclaimed.id })

    const batchCustomer = await makeCustomer()
    const batchGuest = await makeGuest()
    await fill(customerOwner(batchCustomer), 49)
    const batch = await Promise.all([
      createPurchaseDraft(db, configA, guestOwner(batchGuest), fixture.versionId),
      createPurchaseDraft(db, configA, guestOwner(batchGuest), fixture.versionId),
    ])
    await expect(claimGuestPurchaseDrafts(db, batchCustomer, batchGuest.token, batch.map(row => row.id)))
      .rejects.toMatchObject({ status: 409, code: 'PURCHASE_DRAFT_LIMIT' })
    for (const draft of batch) {
      await expect(getPurchaseDraft(db, configA, guestOwner(batchGuest), draft.id)).resolves.toMatchObject({ id: draft.id })
      await expect(getPurchaseDraft(db, configA, customerOwner(batchCustomer), draft.id)).rejects.toMatchObject({ status: 404 })
    }

    const racingCustomer = await makeCustomer()
    const racingGuest = await makeGuest()
    await fill(customerOwner(racingCustomer), 49)
    const guestDraft = await createPurchaseDraft(db, configA, guestOwner(racingGuest), fixture.versionId)
    const raced = await Promise.allSettled([
      createPurchaseDraft(db, configA, customerOwner(racingCustomer), fixture.versionId),
      claimGuestPurchaseDrafts(db, racingCustomer, racingGuest.token, [guestDraft.id]),
    ])
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await countForCustomer(racingCustomer.id)).toBe(50)
  }, 120_000)

  it('stores private images, enforces field ownership and replacement identity, and isolates both cleaners', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const customer = await makeCustomer()
    const stranger = await makeCustomer()
    const owner = customerOwner(customer)
    const strangerOwner = customerOwner(stranger)
    const draft = await createPurchaseDraft(db, configA, owner, fixture.versionId)
    const storage = new PurchaseAttachmentStorage(privateRoot)
    const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#2669bd' } }).png().toBuffer()
    await expect(uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/jpeg', stream: Readable.from([png]),
    })).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_MIME_MISMATCH' })
    const first = await uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', expectedBytes: 1, stream: Readable.from([png]),
    })
    expect(first.byteSize).toBeGreaterThan(1)
    expect(first.byteSize).toBeLessThanOrEqual(png.length + 1024)
    expect(await stat(join(privateRoot, 'purchase-attachments', storage.storageKey(first.attachmentId))).then(row => row.mode & 0o777)).toBe(0o400)
    expect((await db.selectFrom('purchase_draft_attachments').select('byte_size').where('id', '=', first.attachmentId).executeTakeFirstOrThrow()).byte_size).toBe(first.byteSize)
    const authorizedBytes = await readPurchaseDraftAttachment(db, storage, owner, draft.id, first.attachmentId)
    expect(createHash('sha256').update(authorizedBytes.bytes).digest('hex')).toBe(first.sha256)
    await expect(readPurchaseDraftAttachment(db, storage, strangerOwner, draft.id, first.attachmentId)).rejects.toMatchObject({ status: 404 })
    await expect(uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_FIELD_LIMIT' })
    const strangerDraft = await createPurchaseDraft(db, configA, strangerOwner, fixture.versionId)
    await expect(savePurchaseDraft(db, configA, strangerOwner, {
      draftId: strangerDraft.id, expectedRevision: strangerDraft.revision, values: { [fixture.ids.imageId]: [first.attachmentId] },
    })).rejects.toMatchObject({ status: 400, fieldIds: [fixture.ids.imageId] })

    const saved = await savePurchaseDraft(db, configA, owner, {
      draftId: draft.id, expectedRevision: draft.revision, values: { [fixture.ids.imageId]: [first.attachmentId] },
    })
    await expect(requestPurchaseDraftAttachmentDeletion(db, owner, draft.id, first.attachmentId, saved.revision))
      .rejects.toMatchObject({ status: 409, code: 'PURCHASE_ATTACHMENT_STILL_REFERENCED' })
    const removedFromDraft = await savePurchaseDraft(db, configA, owner, {
      draftId: draft.id, expectedRevision: saved.revision, values: {},
    })
    const deleting = await requestPurchaseDraftAttachmentDeletion(db, owner, draft.id, first.attachmentId, removedFromDraft.revision)
    expect(deleting.revision).toBe(removedFromDraft.revision + 1)

    const legacyStorage = new PrivateFileStorage(privateRoot)
    await legacyStorage.ensureReady()
    const oldCleaner = await reconcilePrivateFiles(db, legacyStorage, 'repair')
    expect(oldCleaner.orphanFiles).toBe(0)
    expect(await readFile(join(privateRoot, 'purchase-attachments', storage.storageKey(first.attachmentId)))).toEqual(authorizedBytes.bytes)

    const firstCleanup = await reconcilePurchaseDrafts(db, storage, { repair: true })
    expect(firstCleanup.removedFiles).toBe(1)
    expect(await db.selectFrom('purchase_draft_attachments').select('id').where('id', '=', first.attachmentId).execute()).toHaveLength(0)
    const repeatedCleanup = await reconcilePurchaseDrafts(db, storage, { repair: true })
    expect(repeatedCleanup.removedFiles).toBe(0)

    const replacement = await uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: deleting.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })
    expect(replacement.attachmentId).not.toBe(first.attachmentId)
    await savePurchaseDraft(db, configA, owner, {
      draftId: draft.id, expectedRevision: deleting.revision, values: { [fixture.ids.imageId]: [replacement.attachmentId] },
    })
    const check = await reconcilePurchaseDrafts(db, storage, { repair: false })
    expect(check).toMatchObject({ missingObjects: 0, oldOrphanFiles: 0 })
    const deleted = await getPurchaseDraft(db, configA, owner, draft.id)
    expect(deleted.attachments.map(attachment => attachment.id)).toEqual([replacement.attachmentId])
  }, 45_000)

  it('releases a confirmed stale upload reservation so the same image field can be retried immediately', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const customer = await makeCustomer()
    const owner = customerOwner(customer)
    const draft = await createPurchaseDraft(db, configA, owner, fixture.versionId)
    const storage = new PurchaseAttachmentStorage(privateRoot)
    const png = await sharp({ create: { width: 9, height: 7, channels: 4, background: '#4b258a' } }).png().toBuffer()
    let release!: () => void
    let paused!: () => void
    const pausedSignal = new Promise<void>(resolve => { paused = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    async function* pausedStream() {
      yield png
      paused()
      await gate
    }
    const upload = uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: pausedStream(),
    })
    await pausedSignal
    const saved = await savePurchaseDraft(db, configA, owner, {
      draftId: draft.id, expectedRevision: draft.revision, values: {},
    })
    expect(saved.revision).toBe(draft.revision + 1)
    release()
    await expect(upload).rejects.toMatchObject({ status: 409, code: 'PURCHASE_DRAFT_REVISION_CONFLICT' })

    const staleRows = await db.selectFrom('purchase_draft_attachments').select(['id', 'status'])
      .where('draft_id', '=', draft.id).execute()
    expect(staleRows.filter(row => row.status !== 'deleting')).toEqual([])
    const retry = await uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: saved.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })
    expect(retry.mimeType).toBe('image/webp')
    const ready = await db.selectFrom('purchase_draft_attachments').select(['id', 'status'])
      .where('draft_id', '=', draft.id).execute()
    expect(ready).toContainEqual({ id: retry.attachmentId, status: 'ready' })
    const retryRead = await readPurchaseDraftAttachment(db, storage, owner, draft.id, retry.attachmentId)
    expect(retryRead.sha256).toBe(retry.sha256)
    await savePurchaseDraft(db, configA, owner, {
      draftId: draft.id, expectedRevision: saved.revision, values: { [fixture.ids.imageId]: [retry.attachmentId] },
    })
    const cleanup = await reconcilePurchaseDrafts(db, storage, { repair: true })
    expect(cleanup.removedFiles).toBe(0)
    expect(await db.selectFrom('purchase_draft_attachments').select('id').where('id', '=', retry.attachmentId).execute())
      .toHaveLength(1)
    expect(await readPurchaseDraftAttachment(db, storage, owner, draft.id, retry.attachmentId)
      .then(file => file.sha256)).toBe(retry.sha256)
    expect((await reconcilePurchaseDrafts(db, storage, { repair: true })).removedFiles).toBe(0)
  }, 45_000)

  it('releases the upload reservation when storage initialization fails before finalization begins', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const customer = await makeCustomer()
    const owner = customerOwner(customer)
    const draft = await createPurchaseDraft(db, configA, owner, fixture.versionId)
    const storage = new PurchaseAttachmentStorage(privateRoot)
    const png = await sharp({ create: { width: 9, height: 7, channels: 4, background: '#4b258a' } }).png().toBuffer()
    const existingObjectIds = new Set((await storage.scanFiles()).filter(file => file.location === 'object').map(file => file.id))
    let transactionCount = 0
    const databaseWithTransactionCount = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return () => {
            const builder = target.transaction()
            return {
              execute: async <T>(callback: (trx: Transaction<Database>) => Promise<T>): Promise<T> => {
                transactionCount += 1
                return builder.execute(callback)
              },
            }
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Kysely<Database>
    const storageWithInjectedInitializationFailure = Object.create(storage) as PurchaseAttachmentStorage
    storageWithInjectedInitializationFailure.ensureReady = async () => {
      // The synthetic ENOSPC is injected at the store() -> ensureReady() boundary,
      // after the reservation transaction committed and before finalization starts.
      expect(transactionCount).toBe(1)
      throw Object.assign(new Error('test-injected ENOSPC during private storage initialization'), { code: 'ENOSPC' })
    }

    await expect(uploadPurchaseDraftAttachment(databaseWithTransactionCount, configA, storageWithInjectedInitializationFailure, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_STORAGE_FAILED' })
    // Reservation plus conditional cleanup; the final confirmation transaction never starts.
    expect(transactionCount).toBe(2)
    expect(await db.selectFrom('purchase_draft_attachments').select(['id', 'status'])
      .where('draft_id', '=', draft.id).execute()).toEqual([])
    expect((await storage.scanFiles()).filter(file => file.location === 'object' && !existingObjectIds.has(file.id))).toEqual([])

    const retry = await uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })
    expect((await db.selectFrom('purchase_draft_attachments').select('status')
      .where('id', '=', retry.attachmentId).executeTakeFirstOrThrow()).status).toBe('ready')
    expect((await readPurchaseDraftAttachment(db, storage, owner, draft.id, retry.attachmentId)).sha256).toBe(retry.sha256)
  }, 45_000)

  it('preserves a ready file when the database commit succeeds but its acknowledgement is lost', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const customer = await makeCustomer()
    const owner = customerOwner(customer)
    const draft = await createPurchaseDraft(db, configA, owner, fixture.versionId)
    const storage = new PurchaseAttachmentStorage(privateRoot)
    const png = await sharp({ create: { width: 11, height: 8, channels: 4, background: '#736326' } }).png().toBuffer()
    let transactionCount = 0
    const databaseWithLostCommitAck = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return () => {
            const builder = target.transaction()
            return {
              execute: async <T>(callback: (trx: Transaction<Database>) => Promise<T>): Promise<T> => {
                const result = await builder.execute(callback)
                transactionCount += 1
                if (transactionCount === 2) throw new Error('test simulated a lost commit acknowledgement')
                return result
              },
            }
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Kysely<Database>
    await expect(uploadPurchaseDraftAttachment(databaseWithLostCommitAck, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })).rejects.toMatchObject({ status: 400, code: 'PURCHASE_ATTACHMENT_UPLOAD_FAILED' })
    expect(transactionCount).toBe(2)
    const committed = await db.selectFrom('purchase_draft_attachments').selectAll()
      .where('draft_id', '=', draft.id).where('status', '=', 'ready').executeTakeFirstOrThrow()
    expect(committed.byte_size).not.toBeNull()
    const committedBytes = await storage.readVerified(committed.id, committed.storage_key, committed.byte_size!, committed.sha256!)
    expect(createHash('sha256').update(committedBytes).digest('hex')).toBe(committed.sha256)

    await savePurchaseDraft(db, configA, owner, {
      draftId: draft.id, expectedRevision: draft.revision, values: { [fixture.ids.imageId]: [committed.id] },
    })
    const firstCleanup = await reconcilePurchaseDrafts(db, storage, { repair: true })
    const secondCleanup = await reconcilePurchaseDrafts(db, storage, { repair: true })
    expect(firstCleanup.removedFiles).toBe(0)
    expect(secondCleanup.removedFiles).toBe(0)
    expect((await readPurchaseDraftAttachment(db, storage, owner, draft.id, committed.id)).sha256).toBe(committed.sha256)
  }, 45_000)

  it('recovers interrupted uploads and rejects a stale completion after draft deletion', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const customer = await makeCustomer()
    const owner = customerOwner(customer)
    const draft = await createPurchaseDraft(db, configA, owner, fixture.versionId)
    const storage = new PurchaseAttachmentStorage(privateRoot)
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#a73356' } }).png().toBuffer()
    let release!: () => void
    let paused!: () => void
    const pausedSignal = new Promise<void>((resolve) => { paused = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    async function* pausedStream() {
      yield png
      paused()
      await gate
    }
    const uploading = uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: pausedStream(),
    })
    await pausedSignal
    const pending = await db.selectFrom('purchase_draft_attachments').select(['id', 'status']).where('draft_id', '=', draft.id).executeTakeFirstOrThrow()
    expect(pending.status).toBe('uploading')
    await requestPurchaseDraftDeletion(db, owner, draft.id, draft.revision)
    release()
    await expect(uploading).rejects.toMatchObject({ status: 404 })
    const cleanupTime = new Date(Date.now() + 25 * 60 * 60_000)
    expect(await db.selectFrom('purchase_draft_attachments').select('id').where('id', '=', pending.id).execute()).toHaveLength(0)
    expect((await storage.scanFiles()).some(file => file.id === pending.id)).toBe(false)
    const repaired = await reconcilePurchaseDrafts(db, storage, { repair: true, now: cleanupTime, graceHours: 24 })
    expect(repaired.removedFiles).toBe(0)
    expect(await db.selectFrom('purchase_drafts').select('id').where('id', '=', draft.id).execute()).toHaveLength(0)
    expect((await storage.scanFiles()).some(file => file.id === pending.id)).toBe(false)
    const retry = await reconcilePurchaseDrafts(db, storage, { repair: true, now: cleanupTime, graceHours: 24 })
    expect(retry.removedFiles).toBe(0)
  }, 45_000)

  it('rechecks renewed draft expiry after an old-ready candidate query and rejects renewal after cleanup wins', async () => {
    const fixture = await createTemplateFixture({ headers: adminHeaders() } as Awaited<ReturnType<typeof makeAdminSession>>)
    const customer = await makeCustomer()
    const owner = customerOwner(customer)
    const storage = new PurchaseAttachmentStorage(privateRoot)
    const png = await sharp({ create: { width: 10, height: 6, channels: 4, background: '#2d7242' } }).png().toBuffer()
    const draft = await createPurchaseDraft(db, configA, owner, fixture.versionId)
    const attachment = await uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: draft.id, expectedRevision: draft.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })
    const referencesBeforeRenewal = await db.selectFrom('purchase_draft_attachment_references').select('attachment_id')
      .where('draft_id', '=', draft.id).where('attachment_id', '=', attachment.attachmentId).execute()
    expect(referencesBeforeRenewal).toEqual([])
    await db.updateTable('purchase_drafts').set({ expires_at: new Date(Date.now() + 24 * 60 * 60_000) })
      .where('id', '=', draft.id).execute()
    const revisionBeforeRenewal = (await db.selectFrom('purchase_drafts').select('revision')
      .where('id', '=', draft.id).executeTakeFirstOrThrow()).revision

    await sql`CREATE TABLE purchase_draft_reconcile_gate (id integer PRIMARY KEY)`.execute(db)
    await sql`INSERT INTO purchase_draft_reconcile_gate (id) VALUES (1)`.execute(db)
    await sql`
      CREATE FUNCTION pause_purchase_draft_expiry_for_test() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM id FROM purchase_draft_reconcile_gate WHERE id = 1 FOR UPDATE;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER zz_purchase_draft_expiry_gate_for_test
      BEFORE UPDATE OF expires_at ON purchase_drafts
      FOR EACH ROW EXECUTE FUNCTION pause_purchase_draft_expiry_for_test()`.execute(db)

    const cleanupGate = async () => {
      await sql`DROP TRIGGER IF EXISTS zz_purchase_draft_expiry_gate_for_test ON purchase_drafts`.execute(db)
      await sql`DROP FUNCTION IF EXISTS pause_purchase_draft_expiry_for_test()`.execute(db)
      await sql`DROP TABLE IF EXISTS purchase_draft_reconcile_gate`.execute(db)
    }

    let releaseTrigger!: () => void
    let releaseCandidate!: () => void
    let releaseTriggerForCleanup: (() => void) | undefined
    let releaseCandidateForCleanup: (() => void) | undefined
    try {
    let lockedGate!: (pid: number) => void
    const triggerGate = new Promise<void>(resolve => { releaseTrigger = resolve; releaseTriggerForCleanup = resolve })
    const gateReady = new Promise<number>(resolve => { lockedGate = resolve })
    let candidateReached!: () => void
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; releaseCandidateForCleanup = resolve })
    const candidateReady = new Promise<void>(resolve => { candidateReached = resolve })
    let renewResult: Awaited<ReturnType<typeof renewPurchaseDraft>> | undefined
    let reconcileResult: Awaited<ReturnType<typeof reconcilePurchaseDrafts>> | undefined
    const gateHolder = db.transaction().execute(async trx => {
      await sql`SELECT id FROM purchase_draft_reconcile_gate WHERE id = 1 FOR UPDATE`.execute(trx)
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      lockedGate(Number(pid.rows[0]!.pid))
      await triggerGate
    })
    const gatePid = await gateReady
    let renewalError: unknown
    const renewal = renewPurchaseDraft(db, owner, draft.id, revisionBeforeRenewal)
      .then(value => { renewResult = value }, error => { renewalError = error })
    const waitForLock = async (blockerPid: number) => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const blocked = await sql<{ pid: number }>`
          SELECT activity.pid
          FROM pg_stat_activity AS activity
          WHERE activity.wait_event_type = 'Lock'
            AND activity.datname = current_database()
            AND ${blockerPid} = ANY(pg_blocking_pids(activity.pid))
          LIMIT 1
        `.execute(db)
        if (blocked.rows[0]) return Number(blocked.rows[0].pid)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('Timed out waiting for the renewal trigger to block on its PostgreSQL gate')
    }
    await waitForLock(gatePid)
    const plugin: KyselyPlugin = {
      transformQuery: ({ node }) => node,
      async transformResult(args) {
        const candidate = args.result.rows.some(row => row.id === attachment.attachmentId && row.draft_id === draft.id)
        if (candidate) {
          candidateReached()
          await candidateGate
        }
        return args.result
      },
    }
    const reconcileNow = new Date(Date.now() + 2 * 24 * 60 * 60_000)
    let cleaningError: unknown
    const cleaning = reconcilePurchaseDrafts(db.withPlugin(plugin), storage, {
      repair: true, now: reconcileNow, graceHours: 24,
    }).then(value => { reconcileResult = value }, error => { cleaningError = error })
    await candidateReady
    releaseTrigger()
    await gateHolder
    await renewal
    expect(renewalError).toBeUndefined()
    expect(renewResult?.revision).toBe(revisionBeforeRenewal + 1)
    releaseCandidate()
    await cleaning
    expect(cleaningError).toBeUndefined()
    expect(reconcileResult).toMatchObject({ expiredDrafts: 0, removedFiles: 0 })
    const renewedDraft = await db.selectFrom('purchase_drafts').select(['status', 'expires_at'])
      .where('id', '=', draft.id).executeTakeFirstOrThrow()
    expect(renewedDraft.status).toBe('active')
    expect(renewedDraft.expires_at.getTime()).toBeGreaterThan(reconcileNow.getTime())
    expect(await db.selectFrom('purchase_draft_attachments').select('status').where('id', '=', attachment.attachmentId).executeTakeFirstOrThrow())
      .toEqual({ status: 'ready' })
    const afterRenewal = await getPurchaseDraft(db, configA, owner, draft.id)
    expect(afterRenewal.attachments.map(row => row.id)).toEqual([attachment.attachmentId])
    const objectPath = join(privateRoot, 'purchase-attachments', storage.storageKey(attachment.attachmentId))
    expect(createHash('sha256').update(await readFile(objectPath)).digest('hex')).toBe(attachment.sha256)
    expect((await readPurchaseDraftAttachment(db, storage, owner, draft.id, attachment.attachmentId)).sha256).toBe(attachment.sha256)
    const repeatedCleanup = await reconcilePurchaseDrafts(db, storage, { repair: true, now: reconcileNow, graceHours: 24 })
    expect(repeatedCleanup.removedFiles).toBe(0)
    expect(await db.selectFrom('purchase_draft_attachments').select('status')
      .where('id', '=', attachment.attachmentId).executeTakeFirstOrThrow()).toEqual({ status: 'ready' })
    expect(createHash('sha256').update(await readFile(objectPath)).digest('hex')).toBe(attachment.sha256)
    expect((await readPurchaseDraftAttachment(db, storage, owner, draft.id, attachment.attachmentId)).sha256).toBe(attachment.sha256)

    await cleanupGate()

    expect(afterRenewal.revision).toBe(revisionBeforeRenewal + 1)
    const expiring = await createPurchaseDraft(db, configA, owner, fixture.versionId)
    const expiringAttachment = await uploadPurchaseDraftAttachment(db, configA, storage, owner, {
      draftId: expiring.id, expectedRevision: expiring.revision, fieldId: fixture.ids.imageId,
      claimedMimeType: 'image/png', stream: Readable.from([png]),
    })
    const cleanupTime = new Date(Date.now() + 31 * 24 * 60 * 60_000)
    const cleaned = await reconcilePurchaseDrafts(db, storage, { repair: true, now: cleanupTime, graceHours: 0, batchSize: 500 })
    expect(cleaned.removedFiles).toBeGreaterThanOrEqual(1)
    await expect(renewPurchaseDraft(db, owner, expiring.id, expiring.revision)).rejects.toMatchObject({ status: 404 })
    expect(await db.selectFrom('purchase_draft_attachments').select('id').where('id', '=', expiringAttachment.attachmentId).execute())
      .toEqual([])
    } finally {
      releaseTriggerForCleanup?.()
      releaseCandidateForCleanup?.()
      await cleanupGate()
    }
  }, 60_000)
})
