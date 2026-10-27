import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Migrator } from 'kysely/migration'
import { sql, type Kysely } from 'kysely'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/password.js'
import { readConfig, type AppConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { decryptSupplierBearerToken, decryptSupplierCredentials, encryptSupplierBearerToken } from '../src/commerce/supplier-api-crypto.js'
import { fixtureKayixinCredentials, fixtureProduct, fixtureKayixinSpecialCredentials, startKayixinV3Fixture } from './fixtures/kayixin-v3-server.js'

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const origin = 'http://localhost:3000'
const keyA = randomBytes(32), keyB = randomBytes(32)
const rotated = { appId: '602402', appSecret: 'rotated-fixture-secret-never-real!' }
const legacyId = randomUUID(), legacyVersionId = randomUUID(), adminId = randomUUID()
const legacyToken = 'phase-five-legacy-ciphertext-token'
let app: FastifyInstance, db: Kysely<Database>, config: AppConfig
let fixture: Awaited<ReturnType<typeof startKayixinV3Fixture>>
let headers: Record<string, string>, nextIp = 1
let legacyEnvelope: ReturnType<typeof encryptSupplierBearerToken>
const inject = (options: InjectOptions) => app.inject({ ...options, remoteAddress: `198.51.100.${nextIp++ % 240 + 1}` })
function cookie(response: { headers: Record<string, string | string[] | undefined> }, key: string) {
  const values = response.headers['set-cookie']; const lines = Array.isArray(values) ? values : [values ?? '']
  return lines.find(row => row.startsWith(`${key}=`))!.split(';')[0]!
}
beforeAll(async () => {
  if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Requires isolated _test database')
  fixture = await startKayixinV3Fixture({ credentials: [fixtureKayixinCredentials, rotated, ...fixtureKayixinSpecialCredentials] })
  config = readConfig({ ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', PUBLIC_ORIGIN: origin,
    COOKIE_SECURE: 'false', SUPPLIER_HTTP_TEST_ALLOWLIST: fixture.baseUrl,
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({ activeKeyId: 'a', keys: { a: keyA.toString('base64'), b: keyB.toString('base64') } }),
  })
  process.env.DATABASE_URL = databaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db); await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const baseline = await migrator.migrateTo('202610230002_digital_fulfillment_acceptance')
  if (baseline.error) throw baseline.error
  const password = 'Phase6-readonly-integration-test-password!'
  await db.insertInto('admin_users').values({ id: adminId, email: 'readonly-admin@example.test', password_hash: await hashPassword(password) }).execute()
  legacyEnvelope = encryptSupplierBearerToken(config, legacyId, 1, legacyToken)
  await db.transaction().execute(async trx => {
    await trx.insertInto('supplier_connections').values({ id: legacyId, display_name: '阶段⑤历史连接', enabled: false, current_version_id: null, tested_version_id: null, created_by_admin_id: adminId }).execute()
    await trx.insertInto('supplier_connection_credentials').values({ supplier_connection_id: legacyId, credential_version: 1,
      key_id: legacyEnvelope.keyId, nonce: legacyEnvelope.nonce, ciphertext: legacyEnvelope.ciphertext, auth_tag: legacyEnvelope.authTag }).execute()
    await trx.insertInto('supplier_connection_versions').values({ id: legacyVersionId, supplier_connection_id: legacyId,
      version_number: 1, display_name: '阶段⑤历史连接', provider_type: 'http_json_v1', auth_scheme: 'bearer',
      base_url: 'https://legacy.example.test', credential_version: 1, created_by_admin_id: adminId }).execute()
    await trx.updateTable('supplier_connections').set({ current_version_id: legacyVersionId }).where('id', '=', legacyId).execute()
    await trx.updateTable('supplier_connections').set({ tested_version_id: legacyVersionId, enabled: true }).where('id', '=', legacyId).execute()
  })
  const upgraded = await migrator.migrateToLatest(); if (upgraded.error) throw upgraded.error
  expect(upgraded.results?.map(row => row.migrationName)).toEqual([
    '202610240001_kayixin_readonly',
    '202610240002_purchase_forms_drafts',
    '202610240003_purchase_form_audit_product_identity',
    '202610250001_purchase_lines',
    '202610250002_purchase_snapshot_manifest_r1',
    '202610250003_purchase_form_activation_state',
    '202610250004_cart_replacement_drafts',
    '202610260001_supplier_product_mappings',
    '202610260002_product_pricing_rules',
    '202610270001_supplier_quote_observations',
    '202610270002_supplier_quote_source_consistency',
    '202610270003_procurement_identity',
    '202610270004_procurement_risk_budget',
    '202610270005_procurement_execution',
  ])
  const repeat = await migrator.migrateToLatest(); if (repeat.error) throw repeat.error
  expect(repeat.results).toEqual([])
  app = await createApp({ db, config, logger: process.env.AIKAYUN_TEST_SUPPLIER_LOGGING === 'true' }); await app.ready()
  const csrf = await inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  headers = { origin, cookie: cookie(csrf, 'aikayun_admin_csrf'), 'x-csrf-token': csrf.json().data.csrfToken }
  const login = await inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers, payload: { email: 'readonly-admin@example.test', password } })
  expect(login.statusCode, login.body).toBe(200)
  headers.cookie += `; ${cookie(login, 'aikayun_admin_session')}`
})
afterAll(async () => { await app?.close(); await db?.destroy(); await fixture?.close() })
async function createConnection() {
  const response = await inject({ method: 'POST', url: '/api/v1/admin/supplier-connections', headers,
    payload: { name: `只读夹具 ${randomUUID()}`, providerType: 'kayixin_customer_v3', baseUrl: fixture.baseUrl, credentials: fixtureKayixinCredentials } })
  expect(response.statusCode, response.body).toBe(201)
  expect(response.body).not.toContain(fixtureKayixinCredentials.appSecret)
  return response.json().data[0] as { id: string; currentVersion: { id: string; versionNumber: number; credentialVersion: number } }
}
async function connections() { return (await inject({ method: 'GET', url: '/api/v1/admin/supplier-connections', headers })).json().data as Array<{ id: string; enabled: boolean; fulfillmentEligible: boolean; lastTest: unknown }> }

describe('⑥-1 PostgreSQL protocol, credential and fulfillment boundaries', () => {
  it('upgrades the actual frozen schema without changing legacy ciphertext, AAD, test readiness or historical references', async () => {
    const row = await db.selectFrom('supplier_connection_credentials').selectAll().where('supplier_connection_id', '=', legacyId).executeTakeFirstOrThrow()
    expect(row.ciphertext.equals(legacyEnvelope.ciphertext)).toBe(true)
    expect(row).toMatchObject({ provider_type: 'http_json_v1', auth_scheme: 'bearer', credential_version: 1 })
    expect(decryptSupplierBearerToken(config, legacyId, 1, { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag })).toBe(legacyToken)
    expect((await connections()).find(row => row.id === legacyId)).toMatchObject({ enabled: true, fulfillmentEligible: true })
    expect((await db.selectFrom('supplier_connections').selectAll().where('id', '=', legacyId).executeTakeFirstOrThrow()).current_version_id).toBe(legacyVersionId)
  })
  it('creates structured encrypted V3 credentials and appends versions, retaining and rewrapping both protocol histories', async () => {
    const connection = await createConnection()
    const id = connection.id, root = `/api/v1/admin/supplier-connections/${id}`
    const changed = await inject({ method: 'PUT', url: root, headers, payload: { name: '凭据已轮换', baseUrl: fixture.baseUrl, providerType: 'kayixin_customer_v3', credentials: rotated } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.json().data[0].currentVersion).toMatchObject({ versionNumber: 2, credentialVersion: 2, authScheme: 'app_signature_v3' })
    expect(changed.json().data[0]).toMatchObject({ enabled: false, lastTest: null, fulfillmentEligible: false })
    config.paymentCredentialKeyRing!.activeKeyId = 'b'
    for (const connectionId of [id, legacyId]) {
      const wrapped = await inject({ method: 'POST', url: `/api/v1/admin/supplier-connections/${connectionId}/rewrap-credentials`, headers })
      expect(wrapped.statusCode, wrapped.body).toBe(200)
      expect(wrapped.json().data.rewrappedCredentialVersions).toBe(connectionId === id ? 2 : 1)
      const rows = await db.selectFrom('supplier_connection_credentials').selectAll().where('supplier_connection_id', '=', connectionId).orderBy('credential_version').execute()
      const keyBOnly = { ...config, paymentCredentialKeyRing: { activeKeyId: 'b', keys: { b: keyB } } }
      for (const row of rows) {
        const envelope = { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag }
        const plaintext = decryptSupplierCredentials(keyBOnly, connectionId, row.credential_version, row.provider_type, envelope)
        expect(plaintext).toEqual(connectionId === legacyId ? { providerType: 'http_json_v1', bearerToken: legacyToken }
          : { providerType: 'kayixin_customer_v3', ...(row.credential_version === 1 ? fixtureKayixinCredentials : rotated) })
        expect(() => decryptSupplierCredentials(keyBOnly, connectionId, row.credential_version,
          row.provider_type === 'http_json_v1' ? 'kayixin_customer_v3' : 'http_json_v1', envelope)).toThrow()
        expect(row.ciphertext.toString('utf8')).not.toContain('Secret')
      }
    }
    const versions = await inject({ method: 'GET', url: `${root}/versions`, headers })
    expect(versions.json().data.items).toHaveLength(2)
    expect(versions.body).not.toContain(rotated.appSecret)
    const tested = await inject({ method: 'POST', url: `${root}/test`, headers })
    expect(tested.json().data.connectionOk, tested.body).toBe(true)
  })
  it.each(fixtureKayixinSpecialCredentials)('R1 protects API responses, persisted test results and audits for AppID $appId', async credentials => {
    const created = await inject({ method: 'POST', url: '/api/v1/admin/supplier-connections', headers,
      payload: { name: `特殊凭据 ${credentials.appId}`, providerType: 'kayixin_customer_v3', baseUrl: fixture.baseUrl, credentials } })
    expect(created.statusCode).toBe(201)
    const root = `/api/v1/admin/supplier-connections/${created.json().data[0].id}`
    const clean = await inject({ method: 'POST', url: `${root}/test`, headers })
    expect(clean.json().data).toMatchObject({ connectionOk: true, queryCapable: false })
    fixture.setData(path => path.endsWith('/getAccount') ? { balance: '1.00' }
      : path.endsWith('/getList') ? { allCount: 1, allPage: 1, items: [fixtureProduct()] }
        : { ...fixtureProduct(), goodsDescribe: `禁止展示 ${credentials.appSecret}` })
    try {
      const detail = await inject({ method: 'POST', url: `${root}/catalog/goods/201001`, headers })
      expect(detail.statusCode).toBe(502)
      expect(detail.json().error.code).toBe('KAYIXIN_SENSITIVE_RESPONSE')
      const tested = await inject({ method: 'POST', url: `${root}/test`, headers })
      expect(tested.json().data).toMatchObject({ connectionOk: false, errorCode: 'kayixin_sensitive_response', queryCapable: false })
      const audit = await inject({ method: 'GET', url: `${root}/audit`, headers })
      expect(audit.json().data.events[0].details).toMatchObject({ errorCode: 'kayixin_sensitive_response', scope: 'catalog_read_v3' })
      for (const response of [created, clean, detail, tested, audit]) {
        expect(response.body).not.toContain('R1-fixture-')
        expect(response.body).not.toContain(credentials.appSecret)
        expect(response.body).not.toContain(JSON.stringify(credentials.appSecret).slice(1, -1))
      }
    } finally { fixture.setData() }
  })
  it('rejects mixed auth structures and protocol mutation at both API and SQL layers', async () => {
    const connection = await createConnection()
    const invalidBase = await inject({ method: 'POST', url: '/api/v1/admin/supplier-connections', headers,
      payload: { name: '固定路径保护', providerType: 'kayixin_customer_v3', baseUrl: `${fixture.baseUrl}/api/v3`, credentials: fixtureKayixinCredentials } })
    expect(invalidBase.statusCode, invalidBase.body).toBe(400)
    for (const payload of [
      { providerType: 'kayixin_customer_v3', bearerToken: 'wrong-place-token' },
      { providerType: 'http_json_v1', credentials: fixtureKayixinCredentials },
      { providerType: 'kayixin_customer_v3', credentials: { appId: fixtureKayixinCredentials.appId, appSecret: fixtureKayixinCredentials.appSecret, bearerToken: 'mixed' } },
    ]) {
      const response = await inject({ method: 'POST', url: '/api/v1/admin/supplier-connections', headers, payload: { name: '混用', baseUrl: fixture.baseUrl, ...payload } })
      expect(response.statusCode).toBe(400)
      expect(response.body).not.toContain(fixtureKayixinCredentials.appSecret)
    }
    const updated = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-connections/${connection.id}`, headers,
      payload: { name: '协议修改', baseUrl: fixture.baseUrl, bearerToken: 'cannot-change-protocol' } })
    expect(updated.statusCode).toBe(409)
    await expect(db.updateTable('supplier_connections').set({ provider_type: 'http_json_v1' }).where('id', '=', connection.id).execute()).rejects.toMatchObject({ constraint: 'supplier_connection_protocol_immutable' })
    await expect(db.insertInto('supplier_connection_versions').values({ id: randomUUID(), supplier_connection_id: connection.id,
      version_number: 2, display_name: '无效认证', provider_type: 'kayixin_customer_v3', auth_scheme: 'bearer',
      base_url: fixture.baseUrl, credential_version: 1, created_by_admin_id: adminId }).execute()).rejects.toMatchObject({ constraint: 'supplier_version_protocol_auth_check' })
    await expect(db.insertInto('supplier_connection_versions').values({ id: randomUUID(), supplier_connection_id: connection.id,
      version_number: 2, display_name: '跨协议版本', provider_type: 'http_json_v1', auth_scheme: 'bearer',
      base_url: fixture.baseUrl, credential_version: 1, created_by_admin_id: adminId }).execute()).rejects.toHaveProperty('code', '23503')
    const envelope = encryptSupplierBearerToken(config, connection.id, 99, 'invalid-protocol-token')
    await expect(db.insertInto('supplier_connection_credentials').values({ supplier_connection_id: connection.id, credential_version: 99,
      provider_type: 'kayixin_customer_v3', auth_scheme: 'bearer', key_id: envelope.keyId, nonce: envelope.nonce,
      ciphertext: envelope.ciphertext, auth_tag: envelope.authTag }).execute()).rejects.toMatchObject({ constraint: 'supplier_credential_protocol_auth_check' })
  })
  it('records read-only scope and current version but blocks connection sales, SKU API config and direct database bypasses', async () => {
    const connection = await createConnection(), id = connection.id, versionId = connection.currentVersion.id
    const tested = await inject({ method: 'POST', url: `/api/v1/admin/supplier-connections/${id}/test`, headers })
    expect(tested.json().data, tested.body).toMatchObject({ connectionOk: true, queryCapable: false, scope: 'catalog_read_v3', configurationVersionId: versionId })
    expect((await connections()).find(row => row.id === id)).toMatchObject({ enabled: false, fulfillmentEligible: false, lastTest: { connectionOk: true, scope: 'catalog_read_v3' } })
    expect((await db.selectFrom('supplier_connections').select('tested_version_id').where('id', '=', id).executeTakeFirstOrThrow()).tested_version_id).toBeNull()
    const enabled = await inject({ method: 'PUT', url: `/api/v1/admin/supplier-connections/${id}/enabled`, headers, payload: { enabled: true } })
    expect(enabled.statusCode, enabled.body).toBe(409)
    for (const set of [{ enabled: true, tested_version_id: versionId }, { tested_version_id: versionId }]) {
      await expect(db.updateTable('supplier_connections').set(set).where('id', '=', id).execute()).rejects.toMatchObject({ constraint: 'supplier_protocol_readonly' })
    }
    const productId = randomUUID(), skuId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('products').values({ id: productId, name: '只读不能销售', description: '', product_type: 'digital', status: 'active' }).execute()
      await trx.insertInto('product_variants').values({ id: skuId, product_id: productId, sku_code: `READ-${skuId}`, combination_key: '', sale_price: '1.00', enabled: true, retired_at: null, inventory_mode: 'unlimited' }).execute()
    })
    const root = `/api/v1/admin/products/${productId}/variants/${skuId}/api-fulfillment`
    const response = await inject({ method: 'POST', url: `${root}/versions`, headers, payload: { expectedRevision: 0, supplierConnectionVersionId: versionId, supplierProductId: '201001', parameters: {} } })
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('SUPPLIER_READ_ONLY')
    await expect(db.insertInto('product_variant_fulfillment_versions').values({ id: randomUUID(), product_variant_id: skuId, version_number: 1,
      method: 'api', encrypted_content: null, content_nonce: null, content_auth_tag: null, encryption_key_id: null, content_sha256: 'a'.repeat(64),
      private_file_object_id: null, display_filename: null, supplier_connection_version_id: versionId, supplier_product_id: '201001', supplier_parameters: {}, created_by_admin_id: adminId }).execute()).rejects.toMatchObject({ constraint: 'supplier_protocol_readonly' })
    const testRow = await db.selectFrom('supplier_connection_tests').selectAll().where('supplier_connection_id', '=', id).executeTakeFirstOrThrow()
    await expect(db.updateTable('supplier_connection_tests').set({ passed: false }).where('id', '=', testRow.id).execute()).rejects.toMatchObject({ constraint: 'supplier_api_audit_immutable' })
  })
  it('fails safely when the encryption key required by the current credential is missing', async () => {
    const connection = await createConnection()
    const ring = config.paymentCredentialKeyRing!
    const key = ring.keys[ring.activeKeyId]!
    delete ring.keys[ring.activeKeyId]
    try {
      const response = await inject({ method: 'POST', url: `/api/v1/admin/supplier-connections/${connection.id}/catalog/account`, headers })
      expect(response.statusCode, response.body).toBe(503)
      expect(response.body).not.toContain(fixtureKayixinCredentials.appSecret)
      const tested = await inject({ method: 'POST', url: `/api/v1/admin/supplier-connections/${connection.id}/test`, headers })
      expect(tested.json().data).toMatchObject({ connectionOk: false, errorCode: 'credential_unavailable', queryCapable: false })
    } finally { ring.keys[ring.activeKeyId] = key }
  })
  it('does not promote an old in-flight test to the new configuration version', async () => {
    const connection = await createConnection(), root = `/api/v1/admin/supplier-connections/${connection.id}`
    const gate = fixture.pauseNextAccount()
    const pending = inject({ method: 'POST', url: `${root}/test`, headers }).then(response => response)
    await gate.received
    const update = await inject({ method: 'PUT', url: root, headers, payload: { providerType: 'kayixin_customer_v3', name: '测试期间配置更新', baseUrl: fixture.baseUrl } })
    expect(update.statusCode, update.body).toBe(200)
    gate.release()
    const stale = await pending
    expect(stale.statusCode, stale.body).toBe(409)
    expect((await connections()).find(row => row.id === connection.id)).toMatchObject({ lastTest: null, enabled: false, fulfillmentEligible: false })
    expect(await db.selectFrom('supplier_connection_tests').select('id').where('supplier_connection_id', '=', connection.id).execute()).toHaveLength(0)
    const currentTest = await inject({ method: 'POST', url: `${root}/test`, headers })
    expect(currentTest.json().data).toMatchObject({ connectionOk: true, configurationVersionId: update.json().data[0].currentVersion.id })
    const rotatedConfig = await inject({ method: 'PUT', url: root, headers, payload: { providerType: 'kayixin_customer_v3', name: '再次更新', baseUrl: fixture.baseUrl, credentials: rotated } })
    expect(rotatedConfig.json().data[0].lastTest).toBeNull()
  })
  it('serves only typed read observations, reports safe auth failures, and never changes catalog/inventory/wallet facts', async () => {
    const connection = await createConnection(), root = `/api/v1/admin/supplier-connections/${connection.id}`
    const snapshot = async () => (await sql<{ facts: unknown }>`SELECT jsonb_build_object(
      'sku', (SELECT jsonb_agg(to_jsonb(v)) FROM product_variants v),
      'inventory', (SELECT jsonb_agg(to_jsonb(v)) FROM product_variant_quantity_inventory v),
      'events', (SELECT jsonb_agg(to_jsonb(v)) FROM order_inventory_events v),
      'fulfillment', (SELECT jsonb_agg(to_jsonb(v)) FROM product_variant_fulfillment v),
      'wallet', (SELECT jsonb_agg(to_jsonb(v)) FROM wallet_ledger_entries v)) AS facts`.execute(db)).rows[0]!.facts
    const before = await snapshot()
    for (const [url, payload] of [[`${root}/catalog/account`, undefined], [`${root}/catalog/goods`, { page: 2 }], [`${root}/catalog/goods/201001`, undefined]] as const) {
      const response = await inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) })
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200)
      expect(response.body).not.toContain(fixtureKayixinCredentials.appSecret)
      expect(response.json().data.source).toMatchObject({ configurationVersionId: connection.currentVersion.id, protocol: 'kayixin_customer_v3' })
    }
    expect(await snapshot()).toEqual(before)
    fixture.setMode('auth')
    try {
      const response = await inject({ method: 'POST', url: `${root}/test`, headers })
      expect(response.json().data).toMatchObject({ connectionOk: false, queryCapable: false, errorCode: 'kayixin_authentication_failed' })
      expect(response.body).not.toContain(fixtureKayixinCredentials.appSecret)
      const audit = await inject({ method: 'GET', url: `${root}/audit`, headers })
      expect(audit.body).not.toContain(fixtureKayixinCredentials.appSecret)
      expect(audit.body).not.toContain(rotated.appSecret)
      expect(audit.body).not.toContain('签名错误')
    } finally { fixture.setMode('ok') }
    const count = fixture.requests.length
    expect((await inject({ method: 'POST', url: `${root}/catalog/account` })).statusCode).toBe(401)
    expect((await inject({ method: 'POST', url: `${root}/catalog/account`, headers: { cookie: headers.cookie, origin } })).statusCode).toBe(403)
    expect((await inject({ method: 'POST', url: `${root}/catalog/goods`, headers, payload: { path: '/api/v3/order/create', operation: 'purchase' } })).statusCode).toBe(400)
    expect(fixture.requests.length).toBe(count)
    expect(fixture.requests.every(row => ['/api/v3/user/getAccount', '/api/v3/goods/getList', '/api/v3/goods/getDetail'].includes(row.path))).toBe(true)
  })
})
