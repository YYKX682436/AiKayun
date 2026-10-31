// Isolated Compose acceptance only. Creates and removes its own project/volumes.
// Real SIGKILL checkpoints live in the API PostgreSQL tests; this also proves
// container replacement and the actual backup/restore scripts retain delivery.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
const directory = await mkdtemp(join(tmpdir(), 'aikayun-digital-recovery-test-'))
const supplierDirectory = join(directory, 'supplier-fixture-data')
await mkdir(supplierDirectory, { recursive: true, mode: 0o777 })
await chmod(supplierDirectory, 0o777)
const project = `aikayun-digital-recovery-test-${process.pid}`
const port = async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return String(value)
}
const httpPort = await port()
const supplierPort = await port()
const origin = `http://localhost:${httpPort}`
const ring = JSON.stringify({ activeKeyId: 'current-test', keys: {
  'current-test': randomBytes(32).toString('base64'), 'legacy-test': randomBytes(32).toString('base64'),
} })
const trustStoreMarker = randomBytes(24).toString('base64url')
const pendingActivationCode = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const overridePath = join(directory, 'supplier-fixture.json')
await chmod(directory, 0o777)
await writeFile(overridePath, JSON.stringify({ services: { api: {
  environment: { SUPPLIER_HTTP_TEST_ALLOWLIST: 'http://127.0.0.1:3101,http://127.0.0.1:3102' },
  volumes: [
    `${join(workspace, 'apps/api/test/fixtures/http-json-v1-server.ts')}:/test/http-json-v1-server.ts:ro`,
    `${join(workspace, 'apps/api/test/fixtures/procurement-supplier-process.mjs')}:/test/procurement-supplier-process.mjs:ro`,
    `${join(workspace, 'scripts/fixtures/register-procurement-selection-loader.mjs')}:/test/register-procurement-selection-loader.mjs:ro`,
    `${join(workspace, 'scripts/fixtures/procurement-selection-loader.mjs')}:/test/procurement-selection-loader.mjs:ro`,
    `${join(workspace, 'scripts/fixtures/seed-procurement-recovery.mjs')}:/test/seed-procurement-recovery.mjs:ro`,
    `${join(workspace, 'scripts/fixtures/verify-procurement-recovery.mjs')}:/test/verify-procurement-recovery.mjs:ro`,
    `${join(workspace, 'apps/api/test/fixtures/trust-store-compose-restore.mjs')}:/app/trust-store-compose-restore.mjs:ro`,
    `${join(workspace, 'apps/api/test/fixtures/license-pending-compose-recovery.mjs')}:/app/license-pending-compose-recovery.mjs:ro`,
    `${supplierDirectory}:/test-output`,
  ],
} } }))
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: `${join(workspace, 'compose.yaml')}:${join(workspace, 'compose.e2e.yaml')}:${overridePath}`,
  POSTGRES_USER: 'aikayun', POSTGRES_PASSWORD: randomBytes(24).toString('hex'), POSTGRES_DB: 'aikayun_digital_recovery_test',
  PG_PORT: await port(), HTTP_PORT: httpPort, HTTPS_PORT: await port(), API_PORT: await port(),
  ZPAY_FIXTURE_PORT: supplierPort, HTTP_BIND_ADDRESS: '127.0.0.1', SITE_ADDRESS: ':80', PUBLIC_ORIGIN: origin,
  COOKIE_SECURE: 'false', TRUST_PROXY: 'true', MEDIA_ROOT: '/var/lib/aikayun/media', PRIVATE_FILE_ROOT: '/var/lib/aikayun/private-files',
  LICENSE_TRUST_STORE_ROOT: '/var/lib/aikayun/license-trust',
  PAYMENT_CREDENTIAL_KEY_RING: ring, CODE_POOL_ENCRYPTION_KEY_RING: ring,
  NUXT_PUBLIC_SITE_URL: origin,
}
const command = (binary, args, options = {}) => execFileSync(binary, args, {
  cwd: workspace, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000, ...options,
})
const compose = (...args) => command('docker', ['compose', ...args])
const database = query => compose('exec', '-T', 'db', 'psql', '-U', 'aikayun', '-d', env.POSTGRES_DB, '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query).trim()
async function until(action, description, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value } catch { /* readiness retry */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
const ready = () => until(async () => (await fetch(`${origin}/api/v1/health/ready`)).ok, 'isolated API readiness')
const jar = () => new Map()
const headers = (cookies, token) => ({ origin, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...(token ? { 'x-csrf-token': token } : {}) })
async function request(path, { cookies, token, body, method = 'GET', expected = 200 } = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers: {
    ...(cookies ? headers(cookies, token) : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
  }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) })
  for (const cookie of response.headers.getSetCookie()) {
    const [name, ...value] = cookie.split(';')[0].split('=')
    cookies?.set(name, value.join('='))
  }
  const text = await response.text()
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${text}`)
  return JSON.parse(text).data
}
const historyTables = ['orders', 'order_items', 'order_inventory_reservations', 'order_inventory_events', 'payment_attempts',
  'payment_receipts', 'payment_provider_events', 'order_refunds', 'order_refund_allocations', 'order_refund_audit_events',
  'order_refund_manual_attempts', 'withdrawals', 'withdrawal_payout_attempts', 'withdrawal_audit_events',
  'withdrawal_settings_audit_events', 'withdrawal_private_files', 'withdrawal_payout_results', 'code_pool_withdrawal_entries',
  'product_variant_inventory_adjustments',
  'order_item_fulfillment_attempts', 'order_item_fulfillment_deliveries',
  'product_variant_fulfillment_versions', 'private_file_objects', 'code_pool_batches', 'code_pool_entries',
  'supplier_api_delivery_operations', 'supplier_api_delivery_events', 'supplier_connection_versions', 'supplier_connection_credentials',
  'supplier_product_mapping_heads', 'supplier_product_mapping_versions', 'wallet_operations', 'wallet_ledger_entries',
  'order_item_procurement_sources', 'procurement_operations', 'procurement_operation_units', 'procurement_operation_events',
  'procurement_unit_events', 'procurement_execution_leases', 'procurement_request_intents', 'procurement_execution_evidence',
  'procurement_preparation_requests', 'procurement_execution_conflicts', 'procurement_risk_policies', 'procurement_risk_buckets',
  'procurement_risk_daily', 'procurement_risk_reservations', 'procurement_risk_events', 'order_item_purchase_snapshots',
  'purchase_order_attachment_objects', 'order_item_purchase_attachments']
const snapshot = () => database(historyTables.map(table => `SELECT '${table}' AS table_name, count(*)::text, md5(COALESCE(string_agg(to_jsonb(row)::text, '' ORDER BY to_jsonb(row)::text), '')) FROM ${table} AS row`).join(' UNION ALL '))
const proof = { project, database: env.POSTGRES_DB, sigkill: [], backupRestore: false, licensePendingBackupRestore: false, procurementBackupRestore: null, tlsRejected: false }
try {
  console.log('Starting isolated recovery Compose project')
  compose('up', '-d', '--build')
  await ready()
  const initializedIdentity = JSON.parse(compose('exec', '-T', '-e', 'NODE_ENV=test', 'api', 'node',
    'dist/licensing/installation-identity-cli.js', 'init', '--mode', 'fresh'))
  assert.equal(initializedIdentity.status, 'ready')
  const verifiedIdentity = JSON.parse(compose('exec', '-T', '-e', 'NODE_ENV=test', 'api', 'node',
    'dist/licensing/installation-identity-cli.js', 'verify'))
  assert.deepEqual(verifiedIdentity, initializedIdentity)
  const testDatabaseUrl = `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@db:5432/${env.POSTGRES_DB}`
  compose('exec', '-T', '-e', 'NODE_ENV=test', '-e', `TEST_DATABASE_URL=${testDatabaseUrl}`, 'api', 'node',
    'dist/licensing/pending-encryption-key-cli.js', 'init', '--temporary', '--environment', 'test',
    '--pending-key-dir', '/var/lib/aikayun/license-pending')
  const fixtureResult = output => {
    const line = output.split('\n').find(value => value.startsWith('RESULT_JWS='))
    assert.ok(line, 'license result archive missing from fixture')
    return Buffer.from(line.slice('RESULT_JWS='.length), 'base64url')
  }
  const fixtureCenterEvidence = output => {
    const line = output.split('\n').find(value => value.startsWith('CENTER_EVIDENCE='))
    assert.ok(line, 'terminal center evidence missing from fixture')
    return Buffer.from(line.slice('CENTER_EVIDENCE='.length), 'base64url')
  }
  const seededLicensePending = compose('exec', '-T', 'api', 'node', '/app/license-pending-compose-recovery.mjs', 'seed')
  const originalResultJws = fixtureResult(seededLicensePending)
  const originalCenterEvidence = fixtureCenterEvidence(seededLicensePending)
  assert.ok(!compose('logs', 'api').includes(pendingActivationCode), 'activation code leaked to API logs')
  const trustFixtureOutput = compose('exec', '-T', 'api', 'node', '/app/trust-store-compose-restore.mjs', 'import')
  const trustFixtureLine = trustFixtureOutput.split('\n').find(line => line.startsWith('TRUST_STORE_FIXTURE='))
  assert.ok(trustFixtureLine, `isolated trust store seed did not emit metadata: ${trustFixtureOutput}`)
  const trustFixture = JSON.parse(trustFixtureLine.slice('TRUST_STORE_FIXTURE='.length))
  compose('exec', '-T', 'api', 'node', '-e', `require('node:fs').writeFileSync(require('node:path').join(process.env.LICENSE_TRUST_STORE_ROOT,'acceptance-marker.json'),${JSON.stringify(trustStoreMarker)}+'\\n',{mode:0o600})`)
  proof.installationIdentity = {
    databaseId: initializedIdentity.databaseId,
    instanceId: initializedIdentity.instanceId,
    identityJkt: initializedIdentity.identityJkt,
  }
  compose('exec', '-d', 'api', 'node', '--experimental-strip-types', '/test/http-json-v1-server.ts', '--serve')
  await until(() => {
    compose('exec', '-T', 'api', 'node', '-e', "fetch('http://127.0.0.1:3101/__fixture/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")
    return true
  }, 'controlled supplier fixture')
  await until(async () => (await fetch(`http://localhost:${supplierPort}/__fixture/health`)).ok, 'controlled payment fixture')
  compose('exec', '-T', '-e', 'ADMIN_INITIAL_EMAIL=recovery-test@example.com', '-e', 'ADMIN_INITIAL_PASSWORD=Isolated-Recovery-Password-2026!!', 'api', 'node', 'dist/admin-init.js')
  const admin = jar()
  const adminCsrf = (await request('/api/v1/admin/auth/csrf', { cookies: admin })).csrfToken
  await request('/api/v1/admin/auth/login', { cookies: admin, token: adminCsrf, method: 'POST',
    body: { email: 'recovery-test@example.com', password: 'Isolated-Recovery-Password-2026!!' } })
  const adminWrite = (path, method, body, expected = 200) => request(path, { cookies: admin, token: adminCsrf, method, body, expected })
  let product = await adminWrite('/api/v1/admin/products', 'POST', {
    name: '隔离恢复验收文件', description: 'Synthetic acceptance data', productType: 'digital', defaultSku: { salePrice: '2.00' },
  }, 201)
  product = await adminWrite(`/api/v1/admin/products/${product.id}/lifecycle`, 'PATCH', { expectedRevision: product.revision, status: 'active' })
  const skuId = product.variants[0].id
  const inventoryPath = `/api/v1/admin/products/${product.id}/variants/${skuId}`
  const inventory = await request(`/api/v1/admin/products/${product.id}/inventory`, { cookies: admin })
  const sku = inventory.variants[0]
  await adminWrite(`${inventoryPath}/inventory-mode`, 'PUT', { expectedRevision: inventory.productRevision, expectedSkuRevision: sku.skuRevision,
    expectedInventoryRevision: sku.inventoryRevision, inventoryMode: 'quantity' })
  const configured = await request(`/api/v1/admin/products/${product.id}/inventory`, { cookies: admin })
  await adminWrite(`${inventoryPath}/inventory/adjustments`, 'POST', { operationId: randomUUID(), expectedInventoryRevision: configured.variants[0].inventoryRevision,
    action: 'increase', quantity: 3, reason: 'isolated recovery opening stock' }, 201)
  const bytes = Buffer.from('Persistent private file and verified paid-order recovery.\n'.repeat(4096))
  const digest = createHash('sha256').update(bytes).digest('hex')
  const form = new FormData()
  form.set('file', new Blob([bytes]), 'persistent-recovery.txt')
  const filePath = `${inventoryPath}/private-files`
  const uploaded = await adminWrite(`${filePath}/uploads`, 'POST', form, 201)
  const current = await request(filePath, { cookies: admin })
  const saved = await adminWrite(`${filePath}/versions`, 'POST', { expectedRevision: current.configurationRevision,
    uploadId: uploaded.uploadId, displayFilename: 'persistent-recovery.txt' })
  await adminWrite(`${filePath}/readiness`, 'PUT', { expectedRevision: saved.configurationRevision, enabled: true })
  const items = [{ skuId, quantity: 2 }]
  for (const method of ['manual', 'code_pool', 'fixed_content', 'link', 'api']) {
    let extra = await adminWrite('/api/v1/admin/products', 'POST', { name: `隔离恢复 ${method}`, description: 'Synthetic recovery data',
      productType: 'digital', defaultSku: { salePrice: '2.00' } }, 201)
    extra = await adminWrite(`/api/v1/admin/products/${extra.id}/lifecycle`, 'PATCH', { expectedRevision: extra.revision, status: 'active' })
    const extraId = extra.variants[0].id
    const base = `/api/v1/admin/products/${extra.id}/variants/${extraId}`
    let stock = await request(`/api/v1/admin/products/${extra.id}/inventory`, { cookies: admin })
    await adminWrite(`${base}/inventory-mode`, 'PUT', { expectedRevision: stock.productRevision, expectedSkuRevision: stock.variants[0].skuRevision,
      expectedInventoryRevision: stock.variants[0].inventoryRevision, inventoryMode: 'quantity' })
    stock = await request(`/api/v1/admin/products/${extra.id}/inventory`, { cookies: admin })
    if (method === 'code_pool') {
      const poolReadiness = (enabled, variant) => adminWrite(`${base}/code-pool/readiness`, 'PUT', {
        enabled, expectedSkuRevision: variant.skuRevision, expectedInventoryRevision: variant.inventoryRevision,
      })
      await poolReadiness(false, stock.variants[0])
      await adminWrite(`${base}/code-pool/batches`, 'POST', { operationId: randomUUID(), format: 'paste',
        sourceText: 'recovery-code-1\nrecovery-code-2\nrecovery-code-3' }, 201)
      stock = await request(`/api/v1/admin/products/${extra.id}/inventory`, { cookies: admin })
      await poolReadiness(true, stock.variants[0])
    } else {
      await adminWrite(`${base}/inventory/adjustments`, 'POST', { operationId: randomUUID(), expectedInventoryRevision: stock.variants[0].inventoryRevision,
        action: 'increase', quantity: 3, reason: 'isolated recovery opening stock' }, 201)
      if (method === 'manual') await adminWrite(`${base}/manual-fulfillment`, 'PUT', { enabled: true })
      else if (method === 'api') {
        const supplier = (await adminWrite('/api/v1/admin/supplier-connections', 'POST', { name: '恢复验收供应商', providerType: 'http_json_v1',
          baseUrl: 'http://127.0.0.1:3101', bearerToken: 'playwright-only-supplier-token' }, 201))[0]
        const tested = await adminWrite(`/api/v1/admin/supplier-connections/${supplier.id}/test`, 'POST')
        assert.equal(tested.queryCapable, true)
        await adminWrite(`/api/v1/admin/supplier-connections/${supplier.id}/enabled`, 'PUT', { enabled: true })
        const currentApi = await request(`${base}/api-fulfillment`, { cookies: admin })
        const savedApi = await adminWrite(`${base}/api-fulfillment/versions`, 'POST', { expectedRevision: currentApi.configurationRevision,
          supplierConnectionVersionId: supplier.currentVersion.id, supplierProductId: 'recovery-supplier-product', parameters: {} })
        await adminWrite(`${base}/api-fulfillment/readiness`, 'PUT', { expectedRevision: savedApi.configuration.configurationRevision, enabled: true })
      } else {
        const currentFixed = await request(`${base}/fixed-delivery`, { cookies: admin })
        const savedFixed = await adminWrite(`${base}/fixed-delivery/versions`, 'POST', { expectedRevision: currentFixed.configurationRevision, method,
          ...(method === 'fixed_content' ? { content: 'historical encrypted recovery text' }
            : { url: 'https://delivery.example/never-fetched', title: 'Historical recovery link', accessInstructions: 'recovery instructions' }) })
        await adminWrite(`${base}/fixed-delivery/readiness`, 'PUT', { expectedRevision: savedFixed.configurationRevision, enabled: true })
      }
    }
    items.push({ skuId: extraId, quantity: 2 })
  }
  const channel = await adminWrite('/api/v1/admin/payment-channels', 'POST', { providerType: 'zpay_epay_v1', name: 'Isolated payment fixture', enabled: true,
    paymentMethods: ['alipay'], displayOrder: 1, merchantId: 'playwright-fixture-merchant', merchantKey: 'playwright-only-secret-never-returned' }, 201)
  const customer = jar()
  const customerCsrf = (await request('/api/v1/customer/auth/csrf', { cookies: customer })).csrfToken
  await request('/api/v1/customer/auth/register', { cookies: customer, token: customerCsrf, method: 'POST', expected: 201,
    body: { username: `restore-${randomUUID().slice(0, 12)}`, password: 'Isolated-Customer-Password-2026!!' } })
  const quote = await request('/api/v1/checkout/quote', { cookies: customer, token: customerCsrf, method: 'POST', body: { items } })
  assert.equal(quote.canContinue, true)
  const created = await request('/api/v1/checkout/orders', { cookies: customer, token: customerCsrf, method: 'POST', expected: 201,
    body: { items, quoteToken: quote.quoteToken, idempotencyKey: randomUUID() } })
  const orderId = created.order.id
  await request(`/api/v1/orders/${orderId}/payments`, { cookies: customer, token: customerCsrf, method: 'POST', expected: 201,
    body: { idempotencyKey: randomUUID(), channelId: channel.channel.id, paymentMethod: 'alipay' } })
  const paid = await fetch(`http://localhost:${supplierPort}/__fixture/mark-paid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.json())
  const callback = await fetch(`${origin}/api/v1/payments/callback/zpay?${new URLSearchParams(paid.callback)}`)
  assert.equal(await callback.text(), 'success')
  const automatic = await until(async () => {
    const order = await request(`/api/v1/customer/orders/${orderId}`, { cookies: customer })
    return order.items.filter(item => item.fulfillmentMethod !== 'manual').every(item => item.fulfilledQuantity === 2) ? order : null
  }, 'paid automatic file delivery')
  assert.equal(automatic.status, 'processing')
  const manualItem = automatic.items.find(item => item.fulfillmentMethod === 'manual')
  await adminWrite(`/api/v1/admin/orders/${orderId}/items/${manualItem.id}/fulfillments`, 'POST', { operationId: randomUUID(),
    deliveries: [{ content: 'historical manual recovery unit one' }, { content: 'historical manual recovery unit two' }] })
  const detail = await request(`/api/v1/customer/orders/${orderId}`, { cookies: customer })
  assert.equal(detail.status, 'completed')
  const authorizedView = JSON.stringify(detail)
  const downloadPath = detail.items.find(item => item.fulfillmentMethod === 'file').deliveries[0].downloadUrl
  async function verifyDownload() {
    const response = await fetch(`${origin}${downloadPath}`, { headers: headers(customer) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control'), /no-store/u)
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), digest)
    assert.equal(JSON.stringify(await request(`/api/v1/customer/orders/${orderId}`, { cookies: customer })), authorizedView)
  }
  await verifyDownload()
  compose('exec', '-d', 'api', 'node', '/test/procurement-supplier-process.mjs', '/test-output/procurement-supplier', '3102')
  await until(async () => {
    compose('exec', '-T', 'api', 'node', '-e', "fetch('http://127.0.0.1:3102/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")
    return true
  }, 'independent procurement supplier fixture')
  console.log('Seed isolated procurement operations, cross-operation conflict, historical key, and private purchase archive')
  const seedOutput = compose('exec', '-T', '-e', 'AIKAYUN_RECOVERY_SUPPLIER_URL=http://127.0.0.1:3102',
    'api', 'node', '--import', '/test/register-procurement-selection-loader.mjs', '/test/seed-procurement-recovery.mjs')
  const seedLine = seedOutput.split('\n').find(line => line.startsWith('PROCUREMENT_RECOVERY_SEED='))
  assert.ok(seedLine, `isolated procurement seed did not emit metadata: ${seedOutput}`)
  const seed = JSON.parse(seedLine.slice('PROCUREMENT_RECOVERY_SEED='.length))
  assert.equal(seed.counts.procurement_operations, '4')
  assert.equal(seed.counts.request_intents, '4')
  assert.equal(seed.counts.evidence, '6')
  assert.equal(seed.counts.conflicts, '2')
  assert.equal(seed.counts.reinstatements, '1')
  assert.equal(seed.counts.procurement_deliveries, '1')
  assert.equal(seed.counts.inventory_consumes, '1')
  assert.equal(seed.counts.retained_purchase_attachments, '1')
  const facts = snapshot()
  const reconciliationSql = await readFile(join(workspace, 'scripts/reconcile-digital-fulfillment.sql'), 'utf8')
  const reconcile = () => database(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${reconciliationSql}\nCOMMIT;`)
  assert.equal(reconcile(), '')
  assert.equal(database('SELECT count(*) FROM payment_receipts'), '5')
  assert.equal(database(`SELECT count(*) FROM product_variant_quantity_inventory
    WHERE product_variant_id <> '${seed.productVariantId}' AND (stocked <> 1 OR reserved <> 0)`), '0')
  assert.equal(database(`SELECT stocked::text || ':' || reserved::text FROM product_variant_quantity_inventory
    WHERE product_variant_id='${seed.productVariantId}'`), '9:3')
  for (const service of ['api', 'db']) {
    console.log(`SIGKILL and replace isolated ${service} container`)
    const oldId = compose('ps', '-q', service).trim()
    compose('kill', '-s', 'SIGKILL', service)
    compose('up', '-d', '--no-deps', '--force-recreate', service)
    const newId = compose('ps', '-q', service).trim()
    assert.notEqual(newId, oldId)
    await ready()
    const verifiedLicensePending = compose('exec', '-T', 'api', 'node', '/app/license-pending-compose-recovery.mjs', 'verify')
    assert.deepEqual(fixtureResult(verifiedLicensePending), originalResultJws)
    assert.deepEqual(fixtureCenterEvidence(verifiedLicensePending), originalCenterEvidence)
    await verifyDownload()
    assert.equal(snapshot(), facts)
    proof.sigkill.push({ service, replaced: true, historyIdentical: true, sha256: digest })
  }
  console.log('Back up the database, business files, instance identity, trust store and paired license Pending key, then restore in isolation')
  command('bash', ['scripts/backup-compose-data.sh', join(directory, 'backup')])
  await ready()
  await verifyDownload()
  const backups = await readdir(join(directory, 'backup'))
  assert.equal(backups.length, 1)
  const backupSummary = `${await readFile(join(directory, 'backup', backups[0], 'manifest.txt'), 'utf8')}
${await readFile(join(directory, 'backup', backups[0], 'SHA256SUMS'), 'utf8')}`
  assert.ok(!backupSummary.includes(pendingActivationCode), 'activation code leaked to backup summary')
  compose('exec', '-T', 'api', 'node', '-e', `require('node:fs').unlinkSync(require('node:path').join(process.env.LICENSE_TRUST_STORE_ROOT,'acceptance-marker.json'))`)
  compose('exec', '-T', 'api', 'node', '-e', `const fs=require('node:fs'),path=require('node:path'),root=process.env.LICENSE_TRUST_STORE_ROOT;for(const name of ['trust-bundle-state.json','trust-bundle-store.marker.json'])fs.rmSync(path.join(root,name),{force:true})`)
  compose('exec', '-T', 'api', 'node', '-e', `const fs=require('node:fs'),path=require('node:path'),id=${JSON.stringify(uploaded.uploadId)};fs.unlinkSync(path.join(process.env.PRIVATE_FILE_ROOT,'objects',id.slice(0,2),id+'.bin'))`)
  const missing = await fetch(`${origin}${downloadPath}`, { headers: headers(customer) })
  assert.equal(missing.status, 410)
  command('bash', ['scripts/restore-test-compose-data.sh', join(directory, 'backup', backups[0])], { env: { ...env, ALLOW_TEST_DATABASE_RESTORE: 'YES' } })
  await ready()
  const restoredLicensePending = compose('exec', '-T', 'api', 'node', '/app/license-pending-compose-recovery.mjs', 'verify')
  assert.deepEqual(fixtureResult(restoredLicensePending), originalResultJws)
  assert.deepEqual(fixtureCenterEvidence(restoredLicensePending), originalCenterEvidence)
  const restoredTrustMarker = compose('exec', '-T', 'api', 'node', '-e', `process.stdout.write(require('node:fs').readFileSync(require('node:path').join(process.env.LICENSE_TRUST_STORE_ROOT,'acceptance-marker.json'),'utf8').trim())`).trim()
  assert.equal(restoredTrustMarker, trustStoreMarker)
  const trustRestoreOutput = compose('exec', '-T', '-e', `TRUST_STORE_TEST_FIXTURE=${JSON.stringify(trustFixture)}`,
    'api', 'node', '/app/trust-store-compose-restore.mjs', 'verify')
  const trustRestoreLine = trustRestoreOutput.split('\n').find(line => line.startsWith('TRUST_STORE_RESTORED='))
  assert.ok(trustRestoreLine, `restored trust bundle was not verified: ${trustRestoreOutput}`)
  const restoredTrust = JSON.parse(trustRestoreLine.slice('TRUST_STORE_RESTORED='.length))
  assert.equal(restoredTrust.bundleVersion, trustFixture.bundleVersion)
  assert.equal(restoredTrust.artifactSha256, trustFixture.artifactSha256)
  const restoredIdentity = JSON.parse(compose('exec', '-T', '-e', 'NODE_ENV=test', 'api', 'node',
    'dist/licensing/installation-identity-cli.js', 'verify'))
  assert.deepEqual(restoredIdentity, initializedIdentity)
  compose('exec', '-d', 'api', 'node', '/test/procurement-supplier-process.mjs', '/test-output/procurement-supplier', '3102')
  await until(async () => {
    compose('exec', '-T', 'api', 'node', '-e', "fetch('http://127.0.0.1:3102/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")
    return true
  }, 'restored independent procurement supplier fixture')
  await verifyDownload()
  assert.equal(snapshot(), facts)
  assert.equal(reconcile(), '')
  const reconciliation = JSON.parse(compose('exec', '-T', 'api', 'node', 'dist/media/private-file-reconcile-cli.js', '--check'))
  assert.equal(reconciliation.needsAttention, false)
  assert.equal(reconciliation.verifiedObjects, 1)
  proof.backupRestore = true
  proof.licensePendingBackupRestore = true
  proof.trustStoreBackupRestore = true
  proof.fileSha256 = digest
  proof.paymentReceipts = 5
  proof.procurementPaymentReceipts = 4
  proof.deliveredUnits = 12
  proof.methods = detail.items.map(item => item.fulfillmentMethod).sort()
  proof.authorizedAllMethodsRestored = true
  proof.reconciliationDifferences = 0

  console.log('Verify restored procurement budget, historical key, purchase archive, and query-only recovery')
  const verifyOutput = compose('exec', '-T', '-e', `AIKAYUN_PROCUREMENT_RECOVERY_METADATA=${JSON.stringify(seed)}`,
    'api', 'node', '/test/verify-procurement-recovery.mjs')
  const verifyLine = verifyOutput.split('\n').find(line => line.startsWith('PROCUREMENT_RECOVERY_VERIFY='))
  assert.ok(verifyLine, `isolated procurement restore verification did not emit proof: ${verifyOutput}`)
  proof.procurementBackupRestore = JSON.parse(verifyLine.slice('PROCUREMENT_RECOVERY_VERIFY='.length))

  console.log('Verify a real untrusted TLS handshake in an isolated network namespace')
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    '-days', '1', '-subj', '/CN=93.184.216.34'], { stdio: 'ignore' })
  const image = compose('images', '-q', 'api').trim().split('\n')[0]
  command('docker', ['run', '--rm', '--network=none', '--cap-add=NET_ADMIN', '--user=0',
    '-v', `${directory}:/tls:ro`, '-v', `${join(workspace, 'apps/api/test/fixtures/tls-rejection.mjs')}:/test/tls-rejection.mjs:ro`,
    '--entrypoint', 'sh', image, '-c', 'ip addr add 93.184.216.34/32 dev lo && node /test/tls-rejection.mjs'])
  proof.tlsRejected = true
  if (process.env.AIKAYUN_RECOVERY_REPORT) await writeFile(process.env.AIKAYUN_RECOVERY_REPORT, `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify(proof))
} finally {
  console.log('Removing only the isolated recovery project and its volumes')
  try { compose('down', '-v', '--remove-orphans', '--rmi', 'local') } finally { await rm(directory, { recursive: true, force: true }) }
}
