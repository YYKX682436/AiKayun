import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/password.js'
import { hashToken } from '../src/auth/security.js'
import { readConfig, type AppConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { fixtureKayixinCredentials, fixtureProduct, startKayixinV3Fixture } from './fixtures/kayixin-v3-server.js'
import type { PurchaseFormDefinition, SupplierMappingRules } from '@aikayun/contracts'

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const origin = 'http://localhost:3000'
const secretKey = randomBytes(32)
const adminId = randomUUID()
const adminPassword = 'Supplier-mapping-integration-password!'
type FixtureNode = {
  required?: number
  options?: FixtureNode[]
  expand?: FixtureNode[]
  children?: FixtureNode[]
  [key: string]: unknown
}
type FixtureProductData = {
  skuType?: number
  goodsSku?: { typeNames: unknown[]; details: unknown[] }
  goodsSpec?: unknown[]
  rechargeTemplates?: FixtureNode[]
  name?: string
  salesPrice?: string
  stockCount?: number
  [key: string]: unknown
}
let app: FastifyInstance
let db: Kysely<Database>
let config: AppConfig
let fixture: Awaited<ReturnType<typeof startKayixinV3Fixture>>
let adminCookie = ''
let adminHeaders: Record<string, string> = {}
let nextIp = 1
let connectionId = ''
let productId = ''
let skuId = ''
let foreignProductId = ''
let foreignSkuId = ''
let templateId = ''
let templateVersionId = ''
let mappingId = ''
let observationId = ''
let rules: SupplierMappingRules
let definition: PurchaseFormDefinition

const inject = (options: InjectOptions) => app.inject({ ...options, remoteAddress: `198.51.100.${(nextIp++ % 240) + 1}` })
function cookie(response: { headers: Record<string, string | string[] | undefined> }, name: string) {
  const values = response.headers['set-cookie']
  const lines = Array.isArray(values) ? values : [values ?? '']
  const value = lines.find(row => row.startsWith(`${name}=`))
  if (!value) throw new Error(`Expected ${name} cookie`)
  return value.split(';')[0]!
}

function templateFixture() {
  const id = () => randomUUID()
  const account = id(), image = id(), digits = id(), channel = id(), channelOption = id(), note = id()
  const region = id(), north = id(), city = id(), verification = id(), verificationOption = id(), extraNote = id()
  const definition: PurchaseFormDefinition = { fields: [
    { id: account, meaningKey: 'account_name', type: 'text', label: '账号', required: true, maxLength: 120 },
    { id: image, meaningKey: 'proof_image', type: 'image', label: '凭证图片', required: false, maxCount: 2 },
    { id: digits, meaningKey: 'member_number', type: 'digits', label: '会员编号', required: true, maxLength: 128 },
    { id: channel, meaningKey: 'channel', type: 'select', label: '渠道', required: true,
      options: [{ id: channelOption, meaningKey: 'default_channel', label: '默认渠道' }] },
    { id: note, meaningKey: 'note', type: 'textarea', label: '备注', required: false, maxLength: 1000 },
    { id: region, meaningKey: 'region', type: 'cascade', label: '地区与验证', required: true, options: [{
      id: north, meaningKey: 'south_china', label: '广西', expandedFields: [
        { id: verification, meaningKey: 'verification_code', type: 'select', label: '验证方式', required: true,
          options: [{ id: verificationOption, meaningKey: 'identity_tail', label: '身份证后六位' }] },
        { id: extraNote, meaningKey: 'extra_note', type: 'text', label: '扩展备注', required: false },
      ], children: [{ id: city, meaningKey: 'nanning', label: '南宁市' }],
    }] },
  ] }
  const field = (index: number, localFieldId: string, localMeaningKey: string, options: SupplierMappingRules['fields'][number]['options'] = []) => ({
    localFieldId, localMeaningKey, upstreamPath: [{ kind: 'field' as const, index }], options,
  })
  const rules: SupplierMappingRules = { version: 1, fields: [
    field(0, account, 'account_name'), field(1, image, 'proof_image'), field(2, digits, 'member_number'),
    field(3, channel, 'channel', [{ localOptionId: channelOption, localMeaningKey: 'default_channel',
      upstreamPath: [{ kind: 'field', index: 3 }, { kind: 'option', index: 0 }] }]),
    field(4, note, 'note'),
    field(5, region, 'region', [
      { localOptionId: north, localMeaningKey: 'south_china', upstreamPath: [{ kind: 'field', index: 5 }, { kind: 'option', index: 0 }] },
      { localOptionId: city, localMeaningKey: 'nanning', upstreamPath: [{ kind: 'field', index: 5 }, { kind: 'option', index: 0 }, { kind: 'child', index: 0 }] },
    ]),
    { localFieldId: verification, localMeaningKey: 'verification_code',
      upstreamPath: [{ kind: 'field', index: 5 }, { kind: 'option', index: 0 }, { kind: 'expand', index: 0 }],
      options: [{ localOptionId: verificationOption, localMeaningKey: 'identity_tail',
        upstreamPath: [{ kind: 'field', index: 5 }, { kind: 'option', index: 0 }, { kind: 'expand', index: 0 }, { kind: 'option', index: 0 }] }] },
    { localFieldId: extraNote, localMeaningKey: 'extra_note',
      upstreamPath: [{ kind: 'field', index: 5 }, { kind: 'option', index: 0 }, { kind: 'expand', index: 1 }], options: [] },
  ] }
  return { definition, rules }
}

async function createObservation(goodsId: string, skuType: 0 | 1 | 2, skuCode: string | null, sourceConnectionId = connectionId) {
  return inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings/observe', headers: adminHeaders,
    payload: { connectionId: sourceConnectionId, expectedConfigurationVersionId: (await connections()).find(row => row.id === sourceConnectionId)!.currentVersion.id,
      upstreamProductId: goodsId, upstreamSkuType: skuType, upstreamSkuCode: skuCode } })
}
async function connections() {
  return (await inject({ method: 'GET', url: '/api/v1/admin/supplier-connections', headers: adminHeaders })).json().data as Array<{
    id: string; enabled: boolean; fulfillmentEligible: boolean; currentVersion: { id: string; versionNumber: number }
  }>
}
function setProductOverride() {
  fixture.setData((path, body) => {
    if (path.endsWith('/getList')) return { allCount: 3, allPage: 1,
      items: [fixtureProduct(201001), fixtureProduct(201002), fixtureProduct(203001)] }
    if (!path.endsWith('/getDetail')) return { balance: '1.00' }
    const goodsId = Number(body.goodsId)
    const row = fixtureProduct(goodsId) as FixtureProductData
    if (goodsId === 203001) {
      row.skuType = 0
      row.goodsSku = { typeNames: [], details: [] }
      row.goodsSpec = []
      row.rechargeTemplates = []
    }
    const region = row.rechargeTemplates[5]?.options?.[0]
    const deep = region?.expand?.[0]?.options?.[0]?.expand?.[0]
    if (deep) deep.required = 0
    return row
  })
}

beforeAll(async () => {
  if (!new URL(databaseUrl).pathname.slice(1).endsWith('_test')) throw new Error('Requires an isolated _test PostgreSQL database')
  fixture = await startKayixinV3Fixture({ credentials: [fixtureKayixinCredentials] })
  setProductOverride()
  process.env.DATABASE_URL = databaseUrl
  config = readConfig({ ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', PUBLIC_ORIGIN: origin,
    COOKIE_SECURE: 'false', SUPPLIER_HTTP_TEST_ALLOWLIST: fixture.baseUrl,
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({ activeKeyId: 'mapping-test', keys: { 'mapping-test': secretKey.toString('base64') } }),
  })
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrated = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
  if (migrated.error) throw migrated.error
  await db.insertInto('admin_users').values({ id: adminId, email: `supplier-map-${adminId.slice(0, 8)}@example.test`,
    password_hash: await hashPassword(adminPassword) }).execute()
  app = await createApp({ db, config, logger: false }); await app.ready()
  const csrf = await inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  const csrfCookie = cookie(csrf, 'aikayun_admin_csrf')
  const login = await inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers: {
    origin, cookie: csrfCookie, 'x-csrf-token': csrf.json().data.csrfToken,
  }, payload: { email: `supplier-map-${adminId.slice(0, 8)}@example.test`, password: adminPassword } })
  if (login.statusCode !== 200) throw new Error(`Admin test login failed: ${login.statusCode}`)
  adminCookie = cookie(login, 'aikayun_admin_session')
  adminHeaders = { origin, cookie: `${csrfCookie}; ${adminCookie}`, 'x-csrf-token': csrf.json().data.csrfToken }

  const createdConnection = await inject({ method: 'POST', url: '/api/v1/admin/supplier-connections', headers: adminHeaders,
    payload: { name: '只读映射夹具', providerType: 'kayixin_customer_v3', baseUrl: fixture.baseUrl, credentials: fixtureKayixinCredentials } })
  if (createdConnection.statusCode !== 201) throw new Error(`Kayixin test connection failed: ${createdConnection.body}`)
  connectionId = createdConnection.json().data[0].id

  const preparedTemplate = templateFixture()
  definition = preparedTemplate.definition; rules = preparedTemplate.rules
  const createTemplate = await inject({ method: 'POST', url: '/api/v1/admin/purchase-form-templates', headers: adminHeaders,
    payload: { name: '只读映射冻结模板', definition } })
  if (createTemplate.statusCode !== 201) throw new Error(`Purchase template fixture failed: ${createTemplate.body}`)
  templateId = createTemplate.json().data.template.id
  const freezeTemplate = await inject({ method: 'POST', url: `/api/v1/admin/purchase-form-templates/${templateId}/versions`, headers: adminHeaders,
    payload: { expectedRevision: createTemplate.json().data.template.revision } })
  if (freezeTemplate.statusCode !== 201) throw new Error(`Freeze template fixture failed: ${freezeTemplate.body}`)
  templateVersionId = freezeTemplate.json().data.id

  productId = randomUUID(); skuId = randomUUID()
  foreignProductId = randomUUID(); foreignSkuId = randomUUID()
  await db.transaction().execute(async trx => {
    await trx.insertInto('products').values({ id: productId, name: '映射隔离商品', description: '', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({ id: skuId, product_id: productId, sku_code: `MAP-${skuId.slice(0, 8)}`,
      combination_key: '', sale_price: '1.00', enabled: true, retired_at: null, inventory_mode: 'unlimited' }).execute()
    await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: skuId, method: 'manual', manual_delivery_ready: true }).execute()
    await trx.insertInto('products').values({ id: foreignProductId, name: '映射跨商品引用隔离商品', description: '', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({ id: foreignSkuId, product_id: foreignProductId, sku_code: `MAP-X-${foreignSkuId.slice(0, 8)}`,
      combination_key: '', sale_price: '1.00', enabled: true, retired_at: null, inventory_mode: 'unlimited' }).execute()
    await trx.insertInto('product_purchase_form_settings').values({ product_id: productId, mode: 'template', template_version_id: templateVersionId,
      applied_mode: 'template', applied_template_version_id: templateVersionId, updated_by_admin_id: adminId }).execute()
    await trx.updateTable('storefront_customer_policy').set({ purchase_forms_status: 'active' }).where('singleton', '=', true).execute()
  })
})

afterAll(async () => { await app?.close(); await db?.destroy(); await fixture?.close() })

describe('⑥-2C-2 supplier product mapping preparation on PostgreSQL', () => {
  it('keeps guest and customer identities outside admin mapping routes and requires CSRF for writes', async () => {
    const customerA = { id: randomUUID(), token: randomBytes(32).toString('base64url') }
    const customerB = { id: randomUUID(), token: randomBytes(32).toString('base64url') }
    const guestToken = randomBytes(32).toString('base64url')
    for (const [index, customer] of [customerA, customerB].entries()) {
      await db.insertInto('customers').values({ id: customer.id, username: `map-${index}-${customer.id.slice(0, 8)}`,
        password_hash: 'mapping-integration-only', status: 'active' }).execute()
      await db.insertInto('customer_sessions').values({ id: randomUUID(), customer_id: customer.id, token_hash: hashToken(customer.token),
        expires_at: new Date(Date.now() + 60 * 60_000), revoked_at: null }).execute()
    }
    await db.insertInto('guest_order_sessions').values({ id: randomUUID(), token_hash: hashToken(guestToken),
      expires_at: new Date(Date.now() + 60 * 60_000), revoked_at: null }).execute()
    for (const cookieHeader of ['', `aikayun_customer_session=${customerA.token}`, `aikayun_customer_session=${customerB.token}`]) {
      const response = await inject({ method: 'GET', url: '/api/v1/admin/supplier-product-mappings/catalog', headers: cookieHeader ? { cookie: cookieHeader } : {} })
      expect(response.statusCode).toBe(401)
      const list = await inject({ method: 'GET', url: '/api/v1/admin/supplier-product-mappings', headers: cookieHeader ? { cookie: cookieHeader } : {} })
      expect(list.statusCode).toBe(401)
    }
    const guest = await inject({ method: 'GET', url: '/api/v1/admin/supplier-product-mappings', headers: { cookie: `aikayun_guest_session=${guestToken}` } })
    expect(guest.statusCode).toBe(401)
    const connection = (await connections()).find(row => row.id === connectionId)!
    const noCsrf = await inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings/observe',
      headers: { origin, cookie: adminCookie }, payload: { connectionId, expectedConfigurationVersionId: connection.currentVersion.id,
        upstreamProductId: '201001', upstreamSkuType: 1, upstreamSkuCode: 'cn-member' } })
    expect(noCsrf.statusCode).toBe(403)
    expect(JSON.stringify([guest.json(), noCsrf.json()])).not.toContain(fixtureKayixinCredentials.appSecret)
  })

  it('distinguishes no-SKU, skuType 1 and skuType 2 by stable upstream codes, and refuses unknown or ambiguous identities', async () => {
    const none = await createObservation('203001', 0, null)
    expect(none.statusCode, none.body).toBe(200)
    expect(none.json().data).toMatchObject({ upstreamProductId: '203001', skuType: 0, skuCode: null, combination: [] })
    const single = await createObservation('201001', 1, 'cn-member')
    expect(single.statusCode, single.body).toBe(200)
    expect(single.json().data).toMatchObject({ upstreamProductId: '201001', skuType: 1, skuCode: 'cn-member', combination: [{ title: '地区', value: '中国' }] })
    const multi = await createObservation('201002', 2, 'monthly')
    expect(multi.statusCode, multi.body).toBe(200)
    expect(multi.json().data).toMatchObject({ upstreamProductId: '201002', skuType: 2, skuCode: 'monthly', combination: [{ title: '套餐', value: '月卡' }] })
    const mismatched = await createObservation('201001', 2, 'cn-member')
    expect(mismatched.statusCode).toBe(409)
    expect(mismatched.json().error.code).toBe('UPSTREAM_SKU_IDENTITY_CHANGED')
    const unknownType = await inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings/observe', headers: adminHeaders,
      payload: { connectionId, expectedConfigurationVersionId: (await connections()).find(row => row.id === connectionId)!.currentVersion.id,
        upstreamProductId: '201001', upstreamSkuType: 99, upstreamSkuCode: 'cn-member' } })
    expect(unknownType.statusCode).toBe(400)
    const crossProductSku = await inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings', headers: adminHeaders,
      payload: { productId: foreignProductId, skuId, observationId: single.json().data.id, templateVersionId, rules } })
    expect(crossProductSku.statusCode).toBe(404)
    expect(crossProductSku.json().error.code).toBe('LOCAL_SKU_NOT_FOUND')
    observationId = single.json().data.id
    expect(single.body).not.toContain(fixtureKayixinCredentials.appSecret)
  })

  it('saves incomplete drafts, rejects review until structural rules are complete, then appends immutable history', async () => {
    const observed = await createObservation('201001', 1, 'cn-member')
    expect(observed.statusCode).toBe(200)
    observationId = observed.json().data.id
    const incomplete: SupplierMappingRules = { version: 1, fields: rules.fields.filter(rule => rule.localMeaningKey !== 'account_name') }
    const created = await inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings', headers: adminHeaders,
      payload: { productId, skuId, observationId, templateVersionId, rules: incomplete } })
    expect(created.statusCode, created.body).toBe(201)
    mappingId = created.json().data.id
    expect(created.json().data.status).toBe('draft')
    expect(created.json().data.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LOCAL_FIELD_UNMAPPED', blocking: true })]))
    const blocked = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: created.json().data.revision } })
    expect(blocked.statusCode).toBe(200)
    expect(blocked.json().data.reviewed).toBe(false)
    expect(blocked.json().data.issues.some((issue: { blocking: boolean }) => issue.blocking)).toBe(true)

    const saved = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders,
      payload: { expectedRevision: created.json().data.revision, productId, skuId, observationId, templateVersionId, rules } })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().data.status).toBe('draft')
    const reviewed = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: saved.json().data.revision } })
    expect(reviewed.statusCode, reviewed.body).toBe(200)
    expect(reviewed.json().data.reviewed).toBe(true)
    expect(reviewed.json().data.mapping).toMatchObject({ status: 'reviewed', reviewedVersionId: expect.any(String) })
    expect(reviewed.json().data.mapping.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'IMAGE_ENCODING_UNVERIFIED', blocking: false })]))
    const history = await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/history`, headers: adminHeaders })
    expect(history.statusCode, history.body).toBe(200)
    expect(history.json().data.items).toHaveLength(1)
    expect(history.json().data.items[0]).toMatchObject({ upstreamProductId: '201001', upstreamProductName: '夹具会员 中文 & 特殊字符', upstreamSkuType: 1,
      templateVersion: { id: templateVersionId }, rulesSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    const connectionState = (await connections()).find(row => row.id === connectionId)!
    expect(connectionState).toMatchObject({ enabled: false, fulfillmentEligible: false })
    expect((await inject({ method: 'POST', url: `/api/v1/admin/supplier-connections/${connectionId}/catalog/goods/201001`, headers: adminHeaders })).json().data.procurementReady).toBe(false)
    expect(reviewed.body).not.toContain(fixtureKayixinCredentials.appSecret)
  }, 45_000)

  it('uses optimistic revisions, preserves reviewed rows, and treats price/name/stock as non-structural observations', async () => {
    const historyBefore = await db.selectFrom('supplier_product_mapping_versions').selectAll().where('mapping_id', '=', mappingId).executeTakeFirstOrThrow()
    await expect(db.updateTable('supplier_product_mapping_versions').set({ upstream_product_name: 'SQL rewrite' })
      .where('id', '=', historyBefore.id).execute()).rejects.toMatchObject({ code: '23514', constraint: 'supplier_mapping_history_immutable' })
    await expect(db.deleteFrom('supplier_product_mapping_versions').where('id', '=', historyBefore.id).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'supplier_mapping_history_immutable' })

    const current = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const concurrentPayload = { expectedRevision: current.revision, productId, skuId, observationId, templateVersionId, rules }
    const concurrent = await Promise.all([1, 2].map(() => inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`,
      headers: adminHeaders, payload: concurrentPayload })))
    expect(concurrent.map(response => response.statusCode).sort()).toEqual([200, 409])
    const afterConflict = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const approvedAgain = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: afterConflict.revision } })
    expect(approvedAgain.json().data.reviewed).toBe(true)

    const beforeRefresh = approvedAgain.json().data.mapping
    fixture.setData((path, body) => {
      if (path.endsWith('/getList')) return { allCount: 3, allPage: 1, items: [fixtureProduct(201001), fixtureProduct(201002), fixtureProduct(203001)] }
      if (!path.endsWith('/getDetail')) return { balance: '999.00' }
      const product = fixtureProduct(Number(body.goodsId)) as FixtureProductData
      const deep = product.rechargeTemplates[5]?.options?.[0]?.expand?.[0]?.options?.[0]?.expand?.[0]
      if (deep) deep.required = 0
      product.name = '夹具会员改名'
      product.salesPrice = '987.654321'
      product.stockCount = 0
      return product
    })
    const refreshed = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/refresh`, headers: adminHeaders,
      payload: { expectedRevision: beforeRefresh.revision } })
    expect(refreshed.statusCode, refreshed.body).toBe(200)
    expect(refreshed.json().data).toMatchObject({ structureChanged: false, configurationChanged: false, templateChanged: false })
    expect(refreshed.json().data.mapping.status).toBe('reviewed')
    expect(refreshed.json().data.mapping.revision).toBe(beforeRefresh.revision)
    expect((await db.selectFrom('supplier_product_mapping_versions').selectAll().where('id', '=', historyBefore.id).executeTakeFirstOrThrow())).toEqual(historyBefore)
  }, 45_000)

  it('marks structure and configuration drift stale, refreshes after config rotation, and requires explicit review of a new immutable version', async () => {
    const before = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    fixture.setData((path, body) => {
      if (path.endsWith('/getList')) return { allCount: 3, allPage: 1, items: [fixtureProduct(201001), fixtureProduct(201002), fixtureProduct(203001)] }
      if (!path.endsWith('/getDetail')) return { balance: '1.00' }
      const product = fixtureProduct(Number(body.goodsId)) as FixtureProductData
      product.rechargeTemplates.unshift({ type: 15, title: '新增上游字段', placeholder: '', required: 1, regex: '', options: [] })
      const deep = product.rechargeTemplates[6]?.options?.[0]?.expand?.[0]?.options?.[0]?.expand?.[0]
      if (deep) deep.required = 0
      return product
    })
    const structureRefresh = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/refresh`, headers: adminHeaders,
      payload: { expectedRevision: before.revision } })
    expect(structureRefresh.statusCode, structureRefresh.body).toBe(200)
    expect(structureRefresh.json().data).toMatchObject({ structureChanged: true, mapping: { status: 'stale' } })
    const blocked = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: structureRefresh.json().data.mapping.revision } })
    expect(blocked.statusCode).toBe(200)
    expect(blocked.json().data.reviewed).toBe(false)
    expect(blocked.json().data.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UPSTREAM_REQUIRED_FIELD_UNMAPPED', blocking: true })]))

    const changedConnection = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-connections/${connectionId}`, headers: adminHeaders,
      payload: { name: '只读映射配置轮换', baseUrl: fixture.baseUrl, providerType: 'kayixin_customer_v3', credentials: fixtureKayixinCredentials } })
    expect(changedConnection.statusCode, changedConnection.body).toBe(200)
    const afterConfigRotation = await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })
    expect(afterConfigRotation.json().data.status).toBe('stale')
    const configRefresh = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/refresh`, headers: adminHeaders,
      payload: { expectedRevision: afterConfigRotation.json().data.revision } })
    expect(configRefresh.statusCode, configRefresh.body).toBe(200)
    expect(configRefresh.json().data.configurationChanged).toBe(true)
    expect(configRefresh.json().data.observation.source.configurationVersionNumber).toBe(2)
    expect(configRefresh.json().data.mapping.status).toBe('stale')
    const sourceHistory = await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/history?page=1&pageSize=50`, headers: adminHeaders })
    expect(sourceHistory.json().data.items.length).toBeGreaterThanOrEqual(2)
    expect(sourceHistory.body).not.toContain(fixtureKayixinCredentials.appSecret)

    const lateRead = fixture.pauseNextGoodDetail()
    const readPromise = createObservation('201001', 1, 'cn-member')
    await lateRead.received
    const thirdConfiguration = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-connections/${connectionId}`, headers: adminHeaders,
      payload: { name: '只读映射迟到读取配置轮换', baseUrl: fixture.baseUrl, providerType: 'kayixin_customer_v3', credentials: fixtureKayixinCredentials } })
    expect(thirdConfiguration.statusCode, thirdConfiguration.body).toBe(200)
    lateRead.release()
    const lateResponse = await readPromise
    expect(lateResponse.statusCode).toBe(409)
    expect(lateResponse.json().error.code).toBe('SUPPLIER_VERSION_CHANGED')

    const alternateTemplateResponse = await inject({ method: 'POST', url: '/api/v1/admin/purchase-form-templates', headers: adminHeaders,
      payload: { name: '切换来源后的冻结模板', definition } })
    expect(alternateTemplateResponse.statusCode).toBe(201)
    const alternateTemplate = alternateTemplateResponse.json().data.template
    const alternateFrozenResponse = await inject({ method: 'POST', url: `/api/v1/admin/purchase-form-templates/${alternateTemplate.id}/versions`,
      headers: adminHeaders, payload: { expectedRevision: alternateTemplate.revision } })
    expect(alternateFrozenResponse.statusCode).toBe(201)
    const alternateTemplateVersionId = alternateFrozenResponse.json().data.id as string
    const latestProduct = await inject({ method: 'GET', url: `/api/v1/admin/products/${productId}`, headers: adminHeaders })
    expect((await inject({ method: 'PUT', url: `/api/v1/admin/products/${productId}/purchase-form`, headers: adminHeaders,
      payload: { expectedRevision: latestProduct.json().data.revision, mode: 'template', templateVersionId: alternateTemplateVersionId } })).statusCode).toBe(200)
    const productForApply = await inject({ method: 'GET', url: `/api/v1/admin/products/${productId}`, headers: adminHeaders })
    const appliedTemplate = await inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/purchase-form/apply`, headers: adminHeaders,
      payload: { expectedRevision: productForApply.json().data.revision, expectedMode: 'template', expectedTemplateVersionId: alternateTemplateVersionId } })
    expect(appliedTemplate.statusCode, appliedTemplate.body).toBe(200)
    const currentMapping = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    expect(currentMapping.status).toBe('stale')
    const templateRefresh = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/refresh`, headers: adminHeaders,
      payload: { expectedRevision: currentMapping.revision } })
    expect(templateRefresh.statusCode, templateRefresh.body).toBe(200)
    expect(templateRefresh.json().data).toMatchObject({ configurationChanged: true, templateChanged: true,
      mapping: { status: 'stale', templateVersion: { id: templateVersionId } } })
    expect(templateRefresh.json().data.mapping.templateVersion.id).not.toBe(alternateTemplateVersionId)

    fixture.setData((path, body) => {
      if (path.endsWith('/getList')) return { allCount: 3, allPage: 1, items: [fixtureProduct(201001), fixtureProduct(201002), fixtureProduct(203001)] }
      if (!path.endsWith('/getDetail')) return { balance: '1.00' }
      const product = fixtureProduct(Number(body.goodsId)) as FixtureProductData
      const deep = product.rechargeTemplates[5]?.options?.[0]?.expand?.[0]?.options?.[0]?.expand?.[0]
      if (deep) deep.required = 0
      return product
    })
    const restoredStructure = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/refresh`, headers: adminHeaders,
      payload: { expectedRevision: templateRefresh.json().data.mapping.revision } })
    expect(restoredStructure.statusCode, restoredStructure.body).toBe(200)
    expect(restoredStructure.json().data.structureChanged).toBe(true)

    const alternateConnectionResponse = await inject({ method: 'POST', url: '/api/v1/admin/supplier-connections', headers: adminHeaders,
      payload: { name: '第二个只读映射连接', providerType: 'kayixin_customer_v3', baseUrl: fixture.baseUrl, credentials: fixtureKayixinCredentials } })
    expect(alternateConnectionResponse.statusCode).toBe(201)
    const alternateConnectionId = alternateConnectionResponse.json().data[0].id as string
    const alternateObservation = await createObservation('201001', 1, 'cn-member', alternateConnectionId)
    expect(alternateObservation.statusCode, alternateObservation.body).toBe(200)
    const currentForSwitch = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const switched = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders,
      payload: { expectedRevision: currentForSwitch.revision, productId, skuId, observationId: alternateObservation.json().data.id,
        templateVersionId: alternateTemplateVersionId, rules } })
    expect(switched.statusCode, switched.body).toBe(200)
    expect(switched.json().data).toMatchObject({ status: 'stale', connectionId: alternateConnectionId })
    const switchedReview = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: switched.json().data.revision } })
    expect(switchedReview.json().data.reviewed).toBe(true)
    const switchedHistory = await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/history`, headers: adminHeaders })
    expect(switchedHistory.json().data.items.some((item: { connectionId: string }) => item.connectionId === alternateConnectionId)).toBe(true)
    expect(switchedHistory.json().data.items.some((item: { connectionId: string }) => item.connectionId === connectionId)).toBe(true)
  }, 45_000)

  it('lets the existing safe product delete cascade the mutable mapping head without deleting audit history', async () => {
    const currentProduct = await db.selectFrom('products').select(['revision']).where('id', '=', productId).executeTakeFirstOrThrow()
    const deleted = await inject({ method: 'DELETE', url: `/api/v1/admin/products/${productId}`, headers: adminHeaders,
      payload: { expectedRevision: currentProduct.revision } })
    expect(deleted.statusCode, deleted.body).toBe(200)
    expect(await db.selectFrom('supplier_product_mapping_heads').select('id').where('id', '=', mappingId).execute()).toEqual([])
    expect(await db.selectFrom('supplier_product_mapping_versions').select('id').where('mapping_id', '=', mappingId).execute()).not.toHaveLength(0)
    expect(await db.selectFrom('supplier_product_mapping_audit_events').select('id').where('mapping_id', '=', mappingId).execute()).not.toHaveLength(0)
  })
})
