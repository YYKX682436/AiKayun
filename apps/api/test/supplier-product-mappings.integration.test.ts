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
import { procurementPreparationEligibility } from '../src/commerce/procurement-identity.js'
import type { Database } from '../src/db/types.js'
import { fixtureKayixinCredentials, fixtureProduct, startKayixinV3Fixture } from './fixtures/kayixin-v3-server.js'
import type { PurchaseFormDefinition, SupplierMappingRules } from '@aikayun/contracts'

// This suite exercises a real downgrade to the quote migration and upgrades it
// again. Keep its isolated database at the last reversible historical boundary;
// later procurement migrations deliberately refuse to roll back.
class LegacySupplierMappingMigrationProvider extends AppMigrationProvider {
  override async getMigrations() {
    const migrations = await super.getMigrations()
    return Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= '202610270003_procurement_identity'))
  }
}

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
  const region = id(), north = id(), city = id(), south = id(), verification = id(), verificationOption = id(), extraNote = id()
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
    }, { id: south, meaningKey: 'south_china_other', label: '广东', expandedFields: [], children: [] }] },
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
      { localOptionId: south, localMeaningKey: 'south_china_other', upstreamPath: [{ kind: 'field', index: 5 }, { kind: 'option', index: 1 }] },
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
    ensureAlternateCascadeOption(row)
    return row
  })
}
function ensureAlternateCascadeOption(row: FixtureProductData) {
  const cascade = row.rechargeTemplates?.find(field => field.type === 16)
  if (!cascade || Number(row.skuType) === 0) return
  cascade.options ??= []
  if (cascade.options.length === 1) cascade.options.push({ name: '广东', value: 'guangdong', children: [], expand: [] })
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
  const migrated = await new Migrator({ db, provider: new LegacySupplierMappingMigrationProvider() }).migrateToLatest()
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
    const customerQuoteHistory = await inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes`,
      headers: { cookie: `aikayun_customer_session=${customerA.token}` } })
    expect(customerQuoteHistory.statusCode).toBe(401)
    const connection = (await connections()).find(row => row.id === connectionId)!
    const noCsrf = await inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings/observe',
      headers: { origin, cookie: adminCookie }, payload: { connectionId, expectedConfigurationVersionId: connection.currentVersion.id,
        upstreamProductId: '201001', upstreamSkuType: 1, upstreamSkuCode: 'cn-member' } })
    expect(noCsrf.statusCode).toBe(403)
    const noQuoteCsrf = await inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes/observe`,
      headers: { origin, cookie: adminCookie }, payload: { expectedProductRevision: 1, expectedSkuRevision: 1, expectedMappingRevision: null } })
    expect(noQuoteCsrf.statusCode).toBe(403)
    expect(JSON.stringify([guest.json(), noCsrf.json(), customerQuoteHistory.json(), noQuoteCsrf.json()])).not.toContain(fixtureKayixinCredentials.appSecret)
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

    const localRevisions = await db.selectFrom('products').innerJoin('product_variants', 'product_variants.product_id', 'products.id')
      .select(['products.revision as product_revision', 'product_variants.revision as sku_revision'])
      .where('products.id', '=', productId).where('product_variants.id', '=', skuId).executeTakeFirstOrThrow()
    const observeQuote = (productRevision: number, skuRevision: number) => inject({
      method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes/observe`, headers: adminHeaders,
      payload: { expectedProductRevision: productRevision, expectedSkuRevision: skuRevision,
        expectedMappingRevision: reviewed.json().data.mapping.revision },
    })
    const firstQuote = await observeQuote(localRevisions.product_revision, localRevisions.sku_revision)
    expect(firstQuote.statusCode, firstQuote.body).toBe(200)
    expect(firstQuote.json().data).toMatchObject({
      productId, skuId, mappingId, mappingStatus: 'reviewed', mappingVersionId: reviewed.json().data.mapping.reviewedVersionId,
      source: { connectionId, protocol: 'kayixin_customer_v3', configurationVersionNumber: 1 },
      upstreamProductId: '201001', upstreamSkuType: 1, upstreamSkuCode: 'cn-member',
      quoteScope: 'variant', quoteAmount: '12.345678901234567890', quoteCurrency: null,
      currencyStatus: 'unspecified', quoteBasis: 'upstream_account_reference',
      quoteUnitStatus: 'unverified', actualDebitVerified: false, outcome: 'observed',
      comparison: { comparable: false, reason: 'first_observation', rawReferenceDelta: null },
    })
    fixture.setData((path, body) => {
      if (path.endsWith('/getList')) return { allCount: 3, allPage: 1,
        items: [fixtureProduct(201001), fixtureProduct(201002), fixtureProduct(203001)] }
      if (!path.endsWith('/getDetail')) return { balance: '1.00' }
      const product = fixtureProduct(Number(body.goodsId)) as FixtureProductData
      const deep = product.rechargeTemplates?.[5]?.options?.[0]?.expand?.[0]?.options?.[0]?.expand?.[0]
      if (deep) deep.required = 0
      ensureAlternateCascadeOption(product)
      const detail = product.goodsSku?.details?.find((item) => item.sku === 'cn-member') as Record<string, unknown> | undefined
      if (detail) detail.money = '10.25'
      return product
    })
    const secondQuote = await observeQuote(localRevisions.product_revision, localRevisions.sku_revision)
    expect(secondQuote.statusCode, secondQuote.body).toBe(200)
    expect(secondQuote.json().data).toMatchObject({ quoteAmount: '10.25', actualDebitVerified: false,
      comparison: { comparable: true, reason: 'comparable_same_source_and_structure', previousAmount: '12.345678901234567890',
        rawReferenceDelta: '-2.095678901234567890' } })
    fixture.setData((path, body) => {
      if (path.endsWith('/getList')) return { allCount: 3, allPage: 1,
        items: [fixtureProduct(201001), fixtureProduct(201002), fixtureProduct(203001)] }
      if (!path.endsWith('/getDetail')) return { balance: '1.00' }
      const product = fixtureProduct(Number(body.goodsId)) as FixtureProductData
      const deep = product.rechargeTemplates?.[5]?.options?.[0]?.expand?.[0]?.options?.[0]?.expand?.[0]
      if (deep) deep.required = 0
      ensureAlternateCascadeOption(product)
      const detail = product.goodsSku?.details?.find((item) => (item as { sku?: string }).sku === 'cn-member') as Record<string, unknown> | undefined
      if (detail) detail.money = null
      return product
    })
    const missingQuote = await observeQuote(localRevisions.product_revision, localRevisions.sku_revision)
    expect(missingQuote.statusCode, missingQuote.body).toBe(200)
    expect(missingQuote.json().data).toMatchObject({ outcome: 'quote_missing', quoteAmount: null, actualDebitVerified: false,
      comparison: { comparable: false, reason: 'quote_missing', previousAmount: '10.25', rawReferenceDelta: null } })
    const quoteHistory = await inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes`, headers: adminHeaders })
    expect(quoteHistory.statusCode, quoteHistory.body).toBe(200)
    expect(quoteHistory.json().data.items).toHaveLength(3)
    expect(JSON.stringify([firstQuote.json(), secondQuote.json(), quoteHistory.json()])).not.toContain(fixtureKayixinCredentials.appSecret)
    const publicProduct = await inject({ method: 'GET', url: `/api/v1/public/products/${productId}` })
    expect(publicProduct.statusCode, publicProduct.body).toBe(200)
    expect(publicProduct.body).not.toContain('12.345678901234567890')
    expect(publicProduct.body).not.toContain('10.25')
    expect(publicProduct.body).not.toContain('quoteAmount')
    expect(publicProduct.body).not.toContain('actualDebitVerified')
    for (let index = 0; index < 48; index += 1) {
      const repeated = await observeQuote(localRevisions.product_revision, localRevisions.sku_revision)
      expect(repeated.statusCode, repeated.body).toBe(200)
    }
    const boundedQuoteHistory = await inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes`, headers: adminHeaders })
    expect(boundedQuoteHistory.json().data.items).toHaveLength(50)
    expect(boundedQuoteHistory.json().data.items.some((item: { id: string }) => item.id === firstQuote.json().data.id)).toBe(false)

    const beforeDuplicateAttempt = await db.selectFrom('supplier_product_mapping_versions').select('id').where('mapping_id', '=', mappingId).execute()
    const duplicateOptionRules = structuredClone(rules)
    duplicateOptionRules.fields.find(rule => rule.localMeaningKey === 'region')!.options[2]!.upstreamPath = [
      { kind: 'field', index: 5 }, { kind: 'option', index: 0 },
    ]
    const duplicateDraft = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders,
      payload: { expectedRevision: reviewed.json().data.mapping.revision, productId, skuId, observationId, templateVersionId, rules: duplicateOptionRules } })
    expect(duplicateDraft.statusCode, duplicateDraft.body).toBe(200)
    const duplicateReview = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: duplicateDraft.json().data.revision } })
    expect(duplicateReview.statusCode, duplicateReview.body).toBe(200)
    expect(duplicateReview.json().data.reviewed).toBe(false)
    expect(duplicateReview.json().data.issues).toContainEqual(expect.objectContaining({ code: 'UPSTREAM_OPTION_TARGET_REUSED', blocking: true }))
    expect(await db.selectFrom('supplier_product_mapping_versions').select('id').where('mapping_id', '=', mappingId).execute())
      .toEqual(beforeDuplicateAttempt)
  }, 45_000)

  it('⑥-3C replays a filled order after a mapping change without consulting the supplier during checkout', async () => {
    setProductOverride()
    const targetProductId = randomUUID()
    const targetSkuId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('products').values({ id: targetProductId, name: '映射订单隔离商品', description: '',
        product_type: 'digital', status: 'active' }).execute()
      await trx.insertInto('product_variants').values({ id: targetSkuId, product_id: targetProductId,
        sku_code: `MAP-ORDER-${targetSkuId.slice(0, 8)}`, combination_key: '', sale_price: '1.00',
        enabled: true, retired_at: null, inventory_mode: 'unlimited' }).execute()
      await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: targetSkuId,
        method: 'manual', manual_delivery_ready: true }).execute()
      await trx.insertInto('product_purchase_form_settings').values({ product_id: targetProductId,
        mode: 'template', template_version_id: templateVersionId, applied_mode: 'template',
        applied_template_version_id: templateVersionId, updated_by_admin_id: adminId }).execute()
    })
    const initialObservation = await createObservation('201001', 1, 'cn-member')
    expect(initialObservation.statusCode, initialObservation.body).toBe(200)
    const createdMapping = await inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings', headers: adminHeaders,
      payload: { productId: targetProductId, skuId: targetSkuId, observationId: initialObservation.json().data.id, templateVersionId, rules } })
    expect(createdMapping.statusCode, createdMapping.body).toBe(201)
    const targetMappingId = createdMapping.json().data.id as string
    const reviewed = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${targetMappingId}/review`,
      headers: adminHeaders, payload: { expectedRevision: createdMapping.json().data.revision } })
    expect(reviewed.statusCode, reviewed.body).toBe(200)
    expect(reviewed.json().data.reviewed).toBe(true)
    const customerCsrf = await inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
    const csrfCookie = cookie(customerCsrf, 'aikayun_customer_csrf')
    const csrf = customerCsrf.json().data.csrfToken as string
    const registration = await inject({ method: 'POST', url: '/api/v1/customer/auth/register',
      headers: { origin, cookie: csrfCookie, 'x-csrf-token': csrf },
      payload: { username: `map-order-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        password: 'Mapping-Order-Customer-2026!' } })
    expect(registration.statusCode, registration.body).toBe(201)
    const customerHeaders = { origin, cookie: `${csrfCookie}; ${cookie(registration, 'aikayun_customer_session')}`,
      'x-csrf-token': csrf }
    const draftResponse = await inject({ method: 'POST', url: '/api/v1/storefront/purchase-drafts',
      headers: customerHeaders, payload: { skuId: targetSkuId } })
    expect(draftResponse.statusCode, draftResponse.body).toBe(201)
    const draft = draftResponse.json().data as { id: string; revision: number }
    const account = definition.fields.find(field => field.meaningKey === 'account_name')!
    const digits = definition.fields.find(field => field.meaningKey === 'member_number')!
    const channel = definition.fields.find(field => field.meaningKey === 'channel')!
    const region = definition.fields.find(field => field.meaningKey === 'region')!
    if (channel.type !== 'select' || region.type !== 'cascade') throw new Error('Invalid mapping test template')
    const savedDraft = await inject({ method: 'PUT', url: `/api/v1/storefront/purchase-drafts/${draft.id}`,
      headers: customerHeaders, payload: { skuId: targetSkuId, expectedRevision: draft.revision, values: {
        [account.id]: 'synthetic-private-account', [digits.id]: '123456', [channel.id]: channel.options[0]!.id,
        [region.id]: { path: [region.options[1]!.id], expanded: {} },
      } } })
    expect(savedDraft.statusCode, savedDraft.body).toBe(200)
    expect(savedDraft.json().data.complete).toBe(true)
    const items = [{ lineId: randomUUID(), skuId: targetSkuId, quantity: 1, draftId: draft.id, draftRevision: savedDraft.json().data.revision }]
    const supplierCallsBeforeCheckout = fixture.requests.length
    const quoted = await inject({ method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders,
      payload: { version: 2, items } })
    expect(quoted.statusCode, quoted.body).toBe(200)
    expect(quoted.json().data).toMatchObject({ canContinue: true, totalAmount: '1.00' })
    const orderBody = { version: 2, items, idempotencyKey: randomUUID(), quoteToken: quoted.json().data.quoteToken }
    const created = await inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders, payload: orderBody })
    expect(created.statusCode, created.body).toBe(201)
    expect(fixture.requests.length).toBe(supplierCallsBeforeCheckout)
    const orderId = created.json().data.order.id as string
    const orderItemId = created.json().data.order.items[0].id as string
    // This suite uses the actual production selector, not the synthetic mock.
    expect(await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', orderId).execute()).toEqual([])
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, orderId, orderItemId)))
      .toEqual({ eligible: false, reason: 'source_missing' })

    const current = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${targetMappingId}`,
      headers: adminHeaders })).json().data
    const alternate = await createObservation('201001', 1, 'global-member')
    expect(alternate.statusCode, alternate.body).toBe(200)
    const changed = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${targetMappingId}`, headers: adminHeaders,
      payload: { expectedRevision: current.revision, productId: targetProductId, skuId: targetSkuId,
        observationId: alternate.json().data.id, templateVersionId, rules } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.json().data.revision).toBeGreaterThan(current.revision)
    const supplierCallsBeforeReplay = fixture.requests.length
    const replay = await inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders, payload: orderBody })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: orderId, totalAmount: '1.00' } })
    expect(fixture.requests.length).toBe(supplierCallsBeforeReplay)
    expect(await db.selectFrom('orders').select('id').where('idempotency_key', '=', orderBody.idempotencyKey).execute()).toHaveLength(1)
    expect(await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', orderId).execute()).toEqual([])
    expect(await db.selectFrom('procurement_operations').selectAll().where('order_item_id', '=', orderItemId).execute()).toEqual([])
    expect(await db.selectFrom('order_items').select(['unit_price', 'line_amount']).where('order_id', '=', orderId).execute())
      .toEqual([{ unit_price: '1.00', line_amount: '1.00' }])
    const publicProduct = await inject({ method: 'GET', url: `/api/v1/public/products/${targetProductId}` })
    expect(publicProduct.body).not.toContain('synthetic-private-account')
    expect(publicProduct.body).not.toContain(fixtureKayixinCredentials.appSecret)
  })

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
      ensureAlternateCascadeOption(product)
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
      ensureAlternateCascadeOption(product)
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
    const quoteTarget = await db.selectFrom('products').innerJoin('product_variants', 'product_variants.product_id', 'products.id')
      .select(['products.revision as product_revision', 'product_variants.revision as sku_revision'])
      .where('products.id', '=', productId).where('product_variants.id', '=', skuId).executeTakeFirstOrThrow()
    const requestCountBeforeStaleQuote = fixture.requests.length
    const staleConfigurationQuote = await inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes/observe`,
      headers: adminHeaders, payload: { expectedProductRevision: quoteTarget.product_revision,
        expectedSkuRevision: quoteTarget.sku_revision, expectedMappingRevision: afterConfigRotation.json().data.revision } })
    expect(staleConfigurationQuote.statusCode, staleConfigurationQuote.body).toBe(200)
    expect(staleConfigurationQuote.json().data).toMatchObject({ outcome: 'configuration_changed', quoteAmount: null,
      actualDebitVerified: false, mappingStatus: 'stale', comparison: { comparable: false } })
    expect(fixture.requests).toHaveLength(requestCountBeforeStaleQuote)
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
      ensureAlternateCascadeOption(product)
      return product
    })
    const restoredStructure = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/refresh`, headers: adminHeaders,
      payload: { expectedRevision: templateRefresh.json().data.mapping.revision } })
    expect(restoredStructure.statusCode, restoredStructure.body).toBe(200)
    expect(restoredStructure.json().data.structureChanged).toBe(true)

    const originalObservation = await createObservation('201001', 1, 'cn-member')
    expect(originalObservation.statusCode, originalObservation.body).toBe(200)
    const originalDraft = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders,
      payload: { expectedRevision: restoredStructure.json().data.mapping.revision, productId, skuId,
        observationId: originalObservation.json().data.id, templateVersionId: alternateTemplateVersionId, rules } })
    expect(originalDraft.statusCode, originalDraft.body).toBe(200)
    const originalReview = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: originalDraft.json().data.revision } })
    expect(originalReview.json().data.reviewed).toBe(true)
    const observeReviewedQuote = async (mappingRevision: number) => {
      const target = await db.selectFrom('products').innerJoin('product_variants', 'product_variants.product_id', 'products.id')
        .select(['products.revision as product_revision', 'product_variants.revision as sku_revision'])
        .where('products.id', '=', productId).where('product_variants.id', '=', skuId).executeTakeFirstOrThrow()
      return inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes/observe`, headers: adminHeaders,
        payload: { expectedProductRevision: target.product_revision, expectedSkuRevision: target.sku_revision, expectedMappingRevision: mappingRevision } })
    }
    const originalQuote = await observeReviewedQuote(originalReview.json().data.mapping.revision)
    expect(originalQuote.statusCode, originalQuote.body).toBe(200)
    expect(originalQuote.json().data.outcome).toBe('observed')

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
    const switchedQuote = await observeReviewedQuote(switchedReview.json().data.mapping.revision)
    expect(switchedQuote.statusCode, switchedQuote.body).toBe(200)
    expect(switchedQuote.json().data).toMatchObject({ outcome: 'observed', comparison: {
      comparable: false, reason: 'different_connection', rawReferenceDelta: null } })

    const rotatedAlternate = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-connections/${alternateConnectionId}`, headers: adminHeaders,
      payload: { name: '第二个只读连接配置轮换', baseUrl: fixture.baseUrl, providerType: 'kayixin_customer_v3', credentials: fixtureKayixinCredentials } })
    expect(rotatedAlternate.statusCode, rotatedAlternate.body).toBe(200)
    const rotatedObservation = await createObservation('201001', 1, 'cn-member', alternateConnectionId)
    expect(rotatedObservation.statusCode, rotatedObservation.body).toBe(200)
    const currentAfterRotation = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const rotatedDraft = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders,
      payload: { expectedRevision: currentAfterRotation.revision, productId, skuId, observationId: rotatedObservation.json().data.id,
        templateVersionId: alternateTemplateVersionId, rules } })
    expect(rotatedDraft.statusCode, rotatedDraft.body).toBe(200)
    const rotatedReview = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: rotatedDraft.json().data.revision } })
    expect(rotatedReview.json().data.reviewed).toBe(true)
    const rotatedQuote = await observeReviewedQuote(rotatedReview.json().data.mapping.revision)
    expect(rotatedQuote.statusCode, rotatedQuote.body).toBe(200)
    expect(rotatedQuote.json().data).toMatchObject({ outcome: 'observed', comparison: {
      comparable: false, reason: 'different_configuration', rawReferenceDelta: null } })

    const otherSkuObservation = await createObservation('201001', 1, 'global-member', alternateConnectionId)
    expect(otherSkuObservation.statusCode, otherSkuObservation.body).toBe(200)
    const otherSkuDraft = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders,
      payload: { expectedRevision: rotatedReview.json().data.mapping.revision, productId, skuId, observationId: otherSkuObservation.json().data.id,
        templateVersionId: alternateTemplateVersionId, rules } })
    expect(otherSkuDraft.statusCode, otherSkuDraft.body).toBe(200)
    const otherSkuReview = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: otherSkuDraft.json().data.revision } })
    expect(otherSkuReview.json().data.reviewed).toBe(true)
    const otherSkuQuote = await observeReviewedQuote(otherSkuReview.json().data.mapping.revision)
    expect(otherSkuQuote.statusCode, otherSkuQuote.body).toBe(200)
    expect(otherSkuQuote.json().data).toMatchObject({ outcome: 'observed', upstreamSkuCode: 'global-member', comparison: {
      comparable: false, reason: 'different_sku', rawReferenceDelta: null } })
    const switchedHistory = await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/history`, headers: adminHeaders })
    expect(switchedHistory.json().data.items.some((item: { connectionId: string }) => item.connectionId === alternateConnectionId)).toBe(true)
    expect(switchedHistory.json().data.items.some((item: { connectionId: string }) => item.connectionId === connectionId)).toBe(true)
  }, 90_000)

  async function startRacingQuote() {
    const mapping = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const target = await db.selectFrom('products').innerJoin('product_variants', 'product_variants.product_id', 'products.id')
      .select(['products.revision as product_revision', 'product_variants.revision as sku_revision'])
      .where('products.id', '=', productId).where('product_variants.id', '=', skuId).executeTakeFirstOrThrow()
    const pause = fixture.pauseNextGoodDetail()
    const response = inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes/observe`,
      headers: adminHeaders, payload: { expectedProductRevision: target.product_revision, expectedSkuRevision: target.sku_revision,
        expectedMappingRevision: mapping.revision } })
    await pause.received
    return { mapping, pause, response }
  }

  it('R1 rejects a delayed A quote when another administrator reviews a B mapping', async () => {
    const secondId = randomUUID()
    const secondEmail = `quote-race-${secondId.slice(0, 8)}@example.test`
    await db.insertInto('admin_users').values({ id: secondId, email: secondEmail, password_hash: await hashPassword(adminPassword) }).execute()
    const csrf = await inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
    const csrfCookie = cookie(csrf, 'aikayun_admin_csrf')
    const login = await inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers: { origin, cookie: csrfCookie,
      'x-csrf-token': csrf.json().data.csrfToken }, payload: { email: secondEmail, password: adminPassword } })
    expect(login.statusCode, login.body).toBe(200)
    const otherHeaders = { origin, cookie: `${csrfCookie}; ${cookie(login, 'aikayun_admin_session')}`,
      'x-csrf-token': csrf.json().data.csrfToken }
    const created = await inject({ method: 'POST', url: '/api/v1/admin/supplier-connections', headers: otherHeaders,
      payload: { name: 'R1 供应商 B', providerType: 'kayixin_customer_v3', baseUrl: fixture.baseUrl, credentials: fixtureKayixinCredentials } })
    expect(created.statusCode, created.body).toBe(201)
    const sourceB = created.json().data[0]
    const bObservation = await inject({ method: 'POST', url: '/api/v1/admin/supplier-product-mappings/observe', headers: otherHeaders,
      payload: { connectionId: sourceB.id, expectedConfigurationVersionId: sourceB.currentVersion.id,
        upstreamProductId: '201001', upstreamSkuType: 1, upstreamSkuCode: 'cn-member' } })
    expect(bObservation.statusCode, bObservation.body).toBe(200)
    const pricesBefore = await db.selectFrom('product_variants').select(['cost_price', 'sale_price', 'compare_at_price']).where('id', '=', skuId).executeTakeFirstOrThrow()
    const ordersBefore = await db.selectFrom('orders').select(sql<string>`count(*)::text`.as('count')).executeTakeFirstOrThrow()
    const race = await startRacingQuote()
    try {
      const saved = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: otherHeaders,
        payload: { expectedRevision: race.mapping.revision, productId, skuId, observationId: bObservation.json().data.id,
          templateVersionId: race.mapping.templateVersion.id, rules } })
      expect(saved.statusCode, saved.body).toBe(200)
      const reviewed = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: otherHeaders,
        payload: { expectedRevision: saved.json().data.revision } })
      expect(reviewed.statusCode, reviewed.body).toBe(200)
      expect(reviewed.json().data.reviewed).toBe(true)
    } finally { race.pause.release() }
    const result = await race.response
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().data).toMatchObject({ outcome: 'mapping_changed', quoteAmount: null,
      source: { connectionId: race.mapping.connectionId }, upstreamSkuCode: race.mapping.upstreamSkuCode,
      comparison: { comparable: false, rawReferenceDelta: null } })
    const history = await inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes`, headers: adminHeaders })
    expect(history.json().data.items[0]).toMatchObject({ id: result.json().data.id, quoteAmount: null })
    expect(history.body).not.toContain(fixtureKayixinCredentials.appSecret)
    expect(await db.selectFrom('product_variants').select(['cost_price', 'sale_price', 'compare_at_price']).where('id', '=', skuId).executeTakeFirstOrThrow()).toEqual(pricesBefore)
    expect(await db.selectFrom('orders').select(sql<string>`count(*)::text`.as('count')).executeTakeFirstOrThrow()).toEqual(ordersBefore)
    const current = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const revisions = await db.selectFrom('products').innerJoin('product_variants', 'product_variants.product_id', 'products.id')
      .select(['products.revision as product_revision', 'product_variants.revision as sku_revision'])
      .where('products.id', '=', productId).where('product_variants.id', '=', skuId).executeTakeFirstOrThrow()
    const next = await inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes/observe`, headers: adminHeaders,
      payload: { expectedProductRevision: revisions.product_revision, expectedSkuRevision: revisions.sku_revision, expectedMappingRevision: current.revision } })
    expect(next.statusCode, next.body).toBe(200)
    expect(next.json().data).toMatchObject({ outcome: 'observed', comparison: { comparable: false,
      reason: 'previous_observation_unusable', rawReferenceDelta: null } })
    expect(fixture.requests.every(request => ['/api/v3/user/getAccount', '/api/v3/goods/getList', '/api/v3/goods/getDetail'].includes(request.path))).toBe(true)
  })

  it('R1 discards a delayed quote when the local SKU revision changes', async () => {
    const race = await startRacingQuote()
    try {
      await db.updateTable('product_variants').set({ sku_code: `R1-${skuId.slice(0, 8)}` }).where('id', '=', skuId).execute()
    } finally { race.pause.release() }
    const result = await race.response
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().data).toMatchObject({ outcome: 'sku_changed', quoteAmount: null,
      source: { connectionId: race.mapping.connectionId }, comparison: { comparable: false, rawReferenceDelta: null } })
  })

  it('R1 discards a delayed quote when the same mapping receives a new revision', async () => {
    const mapping = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const observation = await createObservation(mapping.upstreamProductId, mapping.upstreamSkuType, mapping.upstreamSkuCode, mapping.connectionId)
    expect(observation.statusCode, observation.body).toBe(200)
    const race = await startRacingQuote()
    try {
      const saved = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders,
        payload: { expectedRevision: race.mapping.revision, productId, skuId, observationId: observation.json().data.id,
          templateVersionId: race.mapping.templateVersion.id, rules } })
      expect(saved.statusCode, saved.body).toBe(200)
    } finally { race.pause.release() }
    const result = await race.response
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().data).toMatchObject({ outcome: 'mapping_changed', quoteAmount: null,
      mappingRevision: race.mapping.revision, comparison: { comparable: false, rawReferenceDelta: null } })
  })

  it('R1 records a changed upstream structure without a comparable quote', async () => {
    const mapping = (await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })).json().data
    const reviewed = await inject({ method: 'POST', url: `/api/v1/admin/supplier-product-mappings/${mappingId}/review`, headers: adminHeaders,
      payload: { expectedRevision: mapping.revision } })
    expect(reviewed.statusCode, reviewed.body).toBe(200)
    expect(reviewed.json().data.reviewed).toBe(true)
    fixture.setData((path, body) => {
      if (!path.endsWith('/getDetail')) return { balance: '1.00' }
      const product = fixtureProduct(Number(body.goodsId)) as FixtureProductData
      const deep = product.rechargeTemplates?.[5]?.options?.[0]?.expand?.[0]?.options?.[0]?.expand?.[0]
      if (deep) deep.required = 1
      ensureAlternateCascadeOption(product)
      return product
    })
    try {
      const target = await db.selectFrom('products').innerJoin('product_variants', 'product_variants.product_id', 'products.id')
        .select(['products.revision as product_revision', 'product_variants.revision as sku_revision'])
        .where('products.id', '=', productId).where('product_variants.id', '=', skuId).executeTakeFirstOrThrow()
      const result = await inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes/observe`, headers: adminHeaders,
        payload: { expectedProductRevision: target.product_revision, expectedSkuRevision: target.sku_revision,
          expectedMappingRevision: reviewed.json().data.mapping.revision } })
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json().data).toMatchObject({ outcome: 'structure_changed', quoteAmount: null,
        comparison: { comparable: false, rawReferenceDelta: null } })
      const latestMapping = await inject({ method: 'GET', url: `/api/v1/admin/supplier-product-mappings/${mappingId}`, headers: adminHeaders })
      expect(latestMapping.json().data.status).toBe('stale')
    } finally { setProductOverride() }
  })

  it('R1 upgrades immutable legacy failures without presenting their uncertain source or amount', async () => {
    const migrator = new Migrator({ db, provider: new LegacySupplierMappingMigrationProvider() })
    const down = await migrator.migrateTo('202610270001_supplier_quote_observations')
    if (down.error) throw down.error
    const legacyId = randomUUID()
    await sql`
      INSERT INTO supplier_reference_quote_observations (
        id, administrator_id, product_id, product_variant_id, mapping_id, mapping_version_id, mapping_revision, mapping_status,
        supplier_connection_id, supplier_connection_version_id, configuration_version_number, upstream_product_id, upstream_sku_type,
        upstream_sku_code, upstream_combination, quote_scope, quote_amount, quote_currency, currency_status, quote_basis,
        quote_unit_status, actual_debit_verified, outcome, observed_at, source_read_at, structure_fingerprint, failure_code,
        comparable_to_previous, comparison_reason, previous_observation_id, previous_amount, raw_reference_delta
      ) SELECT ${legacyId}::uuid, administrator_id, product_id, product_variant_id, mapping_id, mapping_version_id, mapping_revision, mapping_status,
        supplier_connection_id, supplier_connection_version_id, configuration_version_number, upstream_product_id, upstream_sku_type,
        upstream_sku_code, upstream_combination, quote_scope, quote_amount, quote_currency, currency_status, quote_basis,
        quote_unit_status, actual_debit_verified, 'mapping_changed', clock_timestamp(), source_read_at, structure_fingerprint, 'LEGACY_RACE',
        false, 'previous_observation_unusable', NULL, NULL, NULL
      FROM supplier_reference_quote_observations WHERE product_id = ${productId}::uuid AND outcome = 'observed' LIMIT 1
    `.execute(db)
    const up = await migrator.migrateToLatest()
    if (up.error) throw up.error
    const raw = await db.selectFrom('supplier_reference_quote_observations').selectAll().where('id', '=', legacyId).executeTakeFirstOrThrow()
    expect(raw.quote_amount).not.toBeNull()
    expect(raw.source_snapshot_consistent).toBe(false)
    const history = await inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/variants/${skuId}/reference-quotes`, headers: adminHeaders })
    const legacy = history.json().data.items.find((item: { id: string }) => item.id === legacyId)
    expect(legacy).toMatchObject({ outcome: 'mapping_changed', sourceSnapshotConsistent: false,
      source: null, mappingId: null, upstreamProductId: null, upstreamSkuCode: null, quoteAmount: null })
    await expect(db.updateTable('supplier_reference_quote_observations').set({ quote_amount: null }).where('id', '=', legacyId).execute()).rejects.toThrow()
    await expect(sql`INSERT INTO supplier_reference_quote_observations
      (id, administrator_id, product_id, product_variant_id, mapping_status, outcome, quote_amount, comparison_reason)
      VALUES (${randomUUID()}::uuid, ${adminId}::uuid, ${productId}::uuid, ${skuId}::uuid, 'none', 'sku_changed', '1.00', 'first_observation')`.execute(db)).rejects.toThrow()
  })

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
