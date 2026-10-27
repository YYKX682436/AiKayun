import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'

const require = createRequire('/app/package.json')
const sharp = require('sharp')
const { sql } = require('kysely')

const { readConfig } = await import('/app/dist/config.js')
const { createDatabase } = await import('/app/dist/db/pool.js')
const { hashToken } = await import('/app/dist/auth/security.js')
const { encryptSupplierCredentials } = await import('/app/dist/commerce/supplier-api-crypto.js')
const { createPurchaseDraft, savePurchaseDraft, uploadPurchaseDraftAttachment } = await import('/app/dist/commerce/purchase-forms.js')
const { PurchaseAttachmentStorage } = await import('/app/dist/media/purchase-attachment-storage.js')
const { recordWalletOrderPayment } = await import('/app/dist/finance/wallet.js')
const { initializeSyntheticProcurementRiskPolicy, recordProcurementRiskFact, lockProcurementRiskPolicy } =
  await import('/app/dist/commerce/procurement-risk-budget.js')
const { prepareProcurementWithRisk, runProcurementFixturePass } = await import('/app/dist/commerce/procurement-executor.js')
const { finalizeProcurementUnit } = await import('/app/dist/commerce/procurement-finalization.js')

const config = readConfig()
if (!String(config.database.database || '').endsWith('_test')) {
  throw new Error('Procurement backup seed refuses a non-test database')
}
if (!config.paymentCredentialKeyRing?.keys['legacy-test'] || !config.paymentCredentialKeyRing.keys['current-test']) {
  throw new Error('Both synthetic historical and current test keys must be configured')
}
const legacyConfig = { ...config, paymentCredentialKeyRing: {
  ...config.paymentCredentialKeyRing, activeKeyId: 'legacy-test',
} }
const db = createDatabase()
const digest = value => createHash('sha256').update(value).digest('hex')
const supplierUrl = process.env.AIKAYUN_RECOVERY_SUPPLIER_URL || 'http://127.0.0.1:3102'
const responseDigest = digest('isolated-procurement-backup-response')
const accountField = randomUUID(), imageField = randomUUID()
const templateId = randomUUID(), templateVersionId = randomUUID()
const templateDefinition = { fields: [
  { id: accountField, meaningKey: 'account', type: 'text', label: 'Account', required: true, maxLength: 120 },
  { id: imageField, meaningKey: 'proof', type: 'image', label: 'Proof', required: false, maxCount: 1 },
] }
const templateHash = digest(JSON.stringify(templateDefinition))
const structureHash = digest('synthetic-procurement-structure')
const rulesHash = digest('synthetic-procurement-rules')
const admin = await db.selectFrom('admin_users').select('id').orderBy('created_at').executeTakeFirstOrThrow()
const productId = randomUUID(), skuId = randomUUID(), mappingId = randomUUID(), mappingVersionId = randomUUID()
const supplierId = randomUUID(), supplierVersionId = randomUUID()
const credentials = { providerType: 'kayixin_customer_v3', appId: '123456789', appSecret: 'synthetic-only-backup-fixture' }
const credentialEnvelope = encryptSupplierCredentials(legacyConfig, supplierId, 1, credentials)

try {
  await db.transaction().execute(async trx => {
    await trx.insertInto('purchase_form_templates').values({ id: templateId, name: 'Synthetic recovery purchase form',
      definition: templateDefinition, created_by_admin_id: admin.id, updated_by_admin_id: admin.id }).execute()
    await trx.insertInto('purchase_form_template_versions').values({ id: templateVersionId, template_id: templateId,
      version_number: 1, name: 'Synthetic recovery form v1', definition: templateDefinition, sha256: templateHash,
      created_by_admin_id: admin.id }).execute()
    await trx.insertInto('supplier_connections').values({ id: supplierId, display_name: 'Synthetic recovery supplier',
      provider_type: 'kayixin_customer_v3', enabled: false, current_version_id: null, tested_version_id: null,
      created_by_admin_id: admin.id }).execute()
    await trx.insertInto('supplier_connection_credentials').values({ supplier_connection_id: supplierId,
      credential_version: 1, provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3',
      key_id: credentialEnvelope.keyId, nonce: credentialEnvelope.nonce, ciphertext: credentialEnvelope.ciphertext,
      auth_tag: credentialEnvelope.authTag }).execute()
    await trx.insertInto('supplier_connection_versions').values({ id: supplierVersionId, supplier_connection_id: supplierId,
      version_number: 1, display_name: 'Synthetic recovery supplier v1', provider_type: 'kayixin_customer_v3',
      auth_scheme: 'app_signature_v3', base_url: 'https://synthetic.invalid', credential_version: 1,
      created_by_admin_id: admin.id }).execute()
    await trx.updateTable('supplier_connections').set({ current_version_id: supplierVersionId })
      .where('id', '=', supplierId).execute()
    await trx.insertInto('products').values({ id: productId, name: 'Synthetic procurement recovery item',
      description: 'Isolated backup and restore acceptance', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({ id: skuId, product_id: productId, sku_code: 'RECOVERY-PROCUREMENT-1',
      combination_key: '', sale_price: '2.00', enabled: true, inventory_mode: 'quantity' }).execute()
    await trx.insertInto('product_variant_quantity_inventory').values({ product_id: productId, product_variant_id: skuId,
      stocked: 0, reserved: 0 }).execute()
    await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: skuId,
      method: 'manual', manual_delivery_ready: true }).execute()
    await trx.insertInto('product_purchase_form_settings').values({ product_id: productId, mode: 'template',
      template_version_id: templateVersionId, applied_mode: 'template', applied_template_version_id: templateVersionId,
      updated_by_admin_id: admin.id }).execute()
    await sql`INSERT INTO supplier_product_mapping_heads
      (id, product_id, product_variant_id, supplier_connection_id, supplier_connection_version_id,
       upstream_product_id, upstream_product_name, upstream_sku_type, upstream_sku_code, upstream_combination,
       upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at, template_id, template_version_id,
       template_sha256, normalization_version, rules, rules_sha256, created_by_admin_id, updated_by_admin_id)
      VALUES (${mappingId}::uuid, ${productId}::uuid, ${skuId}::uuid, ${supplierId}::uuid, ${supplierVersionId}::uuid,
        '731002', 'Synthetic recovery product', 0, NULL, '[]'::jsonb, '{}'::jsonb, ${structureHash}, now(),
        ${templateId}::uuid, ${templateVersionId}::uuid, ${templateHash}, 1, '{"version":1,"fields":[]}'::jsonb,
        ${rulesHash}, ${admin.id}::uuid, ${admin.id}::uuid)`.execute(trx)
    await sql`INSERT INTO supplier_product_mapping_versions
      (id, mapping_id, version_number, product_id, product_variant_id, supplier_connection_id, supplier_connection_version_id,
       provider_type, upstream_product_id, upstream_product_name, upstream_sku_type, upstream_sku_code, upstream_combination,
       upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at, template_id, template_version_id,
       template_sha256, normalization_version, rules_version, rules, rules_sha256, administrator_id)
      SELECT ${mappingVersionId}::uuid, id, 1, product_id, product_variant_id, supplier_connection_id,
        supplier_connection_version_id, provider_type, upstream_product_id, upstream_product_name, upstream_sku_type,
        upstream_sku_code, upstream_combination, upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at,
        template_id, template_version_id, template_sha256, normalization_version, rules_version, rules, rules_sha256,
        ${admin.id}::uuid FROM supplier_product_mapping_heads WHERE id=${mappingId}::uuid`.execute(trx)
    await trx.updateTable('supplier_product_mapping_heads').set({ status: 'reviewed', revision: 2,
      latest_review_version_id: mappingVersionId, latest_version_number: 1 }).where('id', '=', mappingId).execute()
    await trx.updateTable('storefront_customer_policy').set({ purchase_forms_status: 'active' }).where('singleton', '=', true).execute()
  })

  // The source-selection loader is test-only and only affects this disposable process.
  process.env.AIKAYUN_SYNTHETIC_PROCUREMENT_SELECTION = JSON.stringify([{ skuId, mappingVersionId }])
  const { createApp } = await import('/app/dist/app.js')
  const app = await createApp({ db, config: legacyConfig, logger: false })
  await app.ready()

  const adminCsrfResponse = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf', headers: { origin: config.publicOrigin } })
  const adminCookies = adminCsrfResponse.headers['set-cookie']
  const adminCookieRows = Array.isArray(adminCookies) ? adminCookies : [adminCookies || '']
  const adminCsrfCookie = adminCookieRows.find(value => value.startsWith('aikayun_admin_csrf='))?.split(';')[0]
  const adminCsrfToken = adminCsrfResponse.json().data.csrfToken
  if (!adminCsrfCookie || !adminCsrfToken) throw new Error('Synthetic administrator CSRF setup failed')
  const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
    headers: { origin: config.publicOrigin, cookie: adminCsrfCookie, 'x-csrf-token': adminCsrfToken },
    payload: { email: 'recovery-test@example.com', password: 'Isolated-Recovery-Password-2026!!' } })
  if (adminLogin.statusCode !== 200) throw new Error('Synthetic administrator login failed: ' + adminLogin.body)
  const adminSessionCookie = adminCookieRows.concat(Array.isArray(adminLogin.headers['set-cookie'])
    ? adminLogin.headers['set-cookie'] : [adminLogin.headers['set-cookie'] || ''])
    .find(value => value.startsWith('aikayun_admin_session='))?.split(';')[0]
  if (!adminSessionCookie) throw new Error('Synthetic administrator session cookie is missing')
  const adminHeaders = { origin: config.publicOrigin, cookie: adminSessionCookie + '; ' + adminCsrfCookie,
    'x-csrf-token': adminCsrfToken }
  const inventoryAdjustment = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/variants/${skuId}/inventory/adjustments`,
    headers: adminHeaders, payload: { operationId: randomUUID(), expectedInventoryRevision: 0,
      action: 'increase', quantity: 10, reason: 'synthetic procurement recovery opening stock' } })
  if (inventoryAdjustment.statusCode !== 201) throw new Error('Synthetic opening inventory adjustment failed: ' + inventoryAdjustment.body)

  const customerId = randomUUID(), sessionId = randomUUID(), customerToken = randomBytes(32).toString('base64url')
  await db.insertInto('customers').values({ id: customerId, username: 'recovery-' + customerId.slice(0, 12),
    password_hash: 'synthetic-fixture', status: 'active' }).execute()
  await db.insertInto('customer_sessions').values({ id: sessionId, customer_id: customerId,
    token_hash: hashToken(customerToken), expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), revoked_at: null }).execute()
  const csrfResponse = await app.inject({ method: 'GET', url: '/api/v1/customer/auth/csrf', headers: { origin: config.publicOrigin } })
  const cookieHeader = csrfResponse.headers['set-cookie']
  const cookies = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader || '']
  const csrfCookie = cookies.find(value => value.startsWith('aikayun_customer_csrf='))?.split(';')[0]
  const csrfToken = csrfResponse.json().data.csrfToken
  if (!csrfCookie || !csrfToken) throw new Error('Synthetic customer CSRF setup failed')
  const headers = { origin: config.publicOrigin, cookie: 'aikayun_customer_session=' + customerToken + '; ' + csrfCookie,
    'x-csrf-token': csrfToken }
  const owner = { kind: 'customer', customer: { id: customerId, sessionId } }
  const purchaseStorage = new PurchaseAttachmentStorage(config.privateFileRoot)
  const imageBytes = await sharp({ create: { width: 48, height: 48, channels: 3, background: '#5680a4' } }).png().toBuffer()

  async function paidOrder(label, attachImage) {
    const draft = await createPurchaseDraft(db, legacyConfig, owner, templateVersionId)
    let attachmentId = null
    if (attachImage) {
      const uploaded = await uploadPurchaseDraftAttachment(db, legacyConfig, purchaseStorage, owner, {
        draftId: draft.id, expectedRevision: draft.revision, fieldId: imageField,
        claimedMimeType: 'image/png', stream: Readable.from([imageBytes]),
      })
      attachmentId = uploaded.attachmentId
    }
    const saved = await savePurchaseDraft(db, legacyConfig, owner, { draftId: draft.id,
      expectedRevision: draft.revision, values: { [accountField]: label, [imageField]: attachmentId ? [attachmentId] : [] } })
    const items = [{ lineId: randomUUID(), skuId, quantity: 1, draftId: draft.id, draftRevision: saved.revision }]
    const quote = await app.inject({ method: 'POST', url: '/api/v1/checkout/quote', headers, payload: { version: 2, items } })
    if (quote.statusCode !== 200 || !quote.json().data.canContinue) throw new Error('Synthetic recovery quote failed: ' + quote.body)
    const idempotencyKey = randomUUID()
    const created = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers,
      payload: { version: 2, items, idempotencyKey, quoteToken: quote.json().data.quoteToken } })
    if (created.statusCode !== 201) throw new Error('Synthetic recovery checkout failed: ' + created.body)
    const order = created.json().data.order
    const amount = (await db.selectFrom('orders').select('total_amount').where('id', '=', order.id).executeTakeFirstOrThrow()).total_amount
    const walletOperationId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('wallet_operations').values({ id: walletOperationId, customer_id: customerId,
        operation_type: 'gift', request_sha256: digest('isolated-recovery-wallet'), actor_admin_id: admin.id }).execute()
      await trx.insertInto('wallet_ledger_entries').values({ id: randomUUID(), wallet_operation_id: walletOperationId,
        line_no: 1, customer_id: customerId, bucket: 'gift', action: 'credit_available', amount,
        payment_attempt_id: null, refund_allocation_id: null, withdrawal_id: null }).execute()
    })
    await db.transaction().execute(trx => recordWalletOrderPayment(trx, { customerId, orderId: order.id,
      operationId: randomUUID(), requestSha256: digest('isolated-recovery-payment:' + order.id), amount }))
    return { id: order.id, itemId: order.items[0].id, attachmentId, sourceDraftId: draft.id, idempotencyKey }
  }

  await db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, { currency: 'TST', limits: {
    perOperationMinor: '100', globalDailyMinor: '10000', globalOutstandingMinor: '10000',
    supplierDailyMinor: '10000', supplierOutstandingMinor: '10000', skuDailyMinor: '10000', skuOutstandingMinor: '10000',
  } }))
  const supplierResponse = async (request) => {
    const response = await fetch(supplierUrl + '/' + request.action, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    if (!response.ok) throw new Error('Synthetic supplier fixture returned ' + response.status)
    return await response.json()
  }
  const prepare = async order => await db.transaction().execute(trx => prepareProcurementWithRisk(trx, {
    requestId: randomUUID(), orderId: order.id, orderItemId: order.itemId, unitIndices: [1],
    currency: 'TST', maxAmountMinor: '10',
  }))

  const completedOrder = await paidOrder('historical-key-completed-order', true)
  const completedOperation = await prepare(completedOrder)
  const ready = await fetch(supplierUrl + '/health')
  if (!ready.ok) throw new Error('Independent procurement supplier fixture is unavailable')
  await fetch(supplierUrl + '/control', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'success', execute: true, holdSubmit: false, unitIndices: [1] }) })
  await runProcurementFixturePass(db, completedOperation.id, supplierResponse, async () => true, 1_000, 900)
  if (await finalizeProcurementUnit(db, completedOperation.id, 1) !== 'completed') throw new Error('Synthetic procurement delivery did not complete')

  const collisionNumber = 'backup-conflict-' + randomUUID()
  const rejectedOrder = await paidOrder('rejected-and-reinstated', false)
  const rejectedOperation = await prepare(rejectedOrder)
  await fetch(supplierUrl + '/control', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'rejected', execute: true, supplierOrderNumber: collisionNumber }) })
  await runProcurementFixturePass(db, rejectedOperation.id, supplierResponse, async () => true, 1_000, 900)
  const rejectionIntent = await db.selectFrom('procurement_request_intents').select(['generation', 'request_identity'])
    .where('operation_id', '=', rejectedOperation.id).where('action', '=', 'submit').executeTakeFirstOrThrow()
  const rejectionEvidenceId = randomUUID()
  await db.transaction().execute(async trx => {
    await lockProcurementRiskPolicy(trx, rejectedOperation.id)
    await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,
      supplier_order_number,response_digest,amount_minor,currency)
      VALUES (${rejectionEvidenceId}::uuid,${rejectedOperation.id}::uuid,${rejectionIntent.generation},'submit','rejected',
        ${rejectionIntent.request_identity},${collisionNumber},${responseDigest},10,'TST')`.execute(trx)
    await recordProcurementRiskFact(trx, { operationId: rejectedOperation.id, factId: randomUUID(), kind: 'release',
      amountMinor: '10', evidenceId: rejectionEvidenceId })
    await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${rejectedOperation.id}::uuid`.execute(trx)
    await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${rejectedOperation.id}::uuid`.execute(trx)
  })

  const collisionOrder = await paidOrder('late-provider-number-collision', false)
  const collisionOperation = await prepare(collisionOrder)
  await fetch(supplierUrl + '/control', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'accepted', execute: true, supplierOrderNumber: collisionNumber }) })
  await runProcurementFixturePass(db, collisionOperation.id, supplierResponse, async () => true, 1_000, 900)

  const unknownOrder = await paidOrder('unknown-submit-recovery', false)
  const unknownOperation = await prepare(unknownOrder)
  await fetch(supplierUrl + '/control', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'unknown', execute: false, supplierOrderNumber: null }) })
  await runProcurementFixturePass(db, unknownOperation.id, supplierResponse, async () => true, 1_000, 900)

  const completedRead = await app.inject({ method: 'GET', url: '/api/v1/customer/orders/' + completedOrder.id, headers })
  if (completedRead.statusCode !== 200 || completedRead.json().data.items[0].purchaseData.state !== 'filled') {
    throw new Error('Completed purchase data was not authorized and readable before backup')
  }
  const attachmentMeta = completedRead.json().data.items[0].purchaseData.attachments[0]
  const attachmentRead = await app.inject({ method: 'GET', url: attachmentMeta.url, headers })
  if (attachmentRead.statusCode !== 200 || digest(attachmentRead.rawPayload) !== attachmentMeta.sha256) {
    throw new Error('Private purchase archive failed its pre-backup authorized SHA-256 check')
  }
  const counts = await sql`SELECT
    (SELECT count(*)::text FROM procurement_operations) AS procurement_operations,
    (SELECT count(*)::text FROM procurement_request_intents) AS request_intents,
    (SELECT count(*)::text FROM procurement_execution_evidence) AS evidence,
    (SELECT count(*)::text FROM procurement_execution_conflicts) AS conflicts,
    (SELECT count(*)::text FROM procurement_risk_events WHERE kind='reinstate') AS reinstatements,
    (SELECT count(*)::text FROM order_item_fulfillment_deliveries delivery JOIN order_item_fulfillment_attempts attempt
      ON attempt.id=delivery.fulfillment_attempt_id WHERE attempt.delivery_source='procurement') AS procurement_deliveries,
    (SELECT count(*)::text FROM order_inventory_events event JOIN order_inventory_reservations reservation
      ON reservation.id=event.reservation_id WHERE reservation.order_item_id=${completedOrder.itemId}::uuid
        AND event.action='consume') AS inventory_consumes,
    (SELECT count(*)::text FROM purchase_order_attachment_objects WHERE status='retained') AS retained_purchase_attachments`.execute(db)
  const stats = await fetch(supplierUrl + '/stats').then(response => response.json())
  const metadata = { customerToken, customerId, accountField, productVariantId: skuId,
    completedOrderId: completedOrder.id, completedItemId: completedOrder.itemId,
    attachmentId: completedOrder.attachmentId, attachmentSha256: attachmentMeta.sha256,
    rejectedOperationId: rejectedOperation.id, collisionOperationId: collisionOperation.id,
    unknownOperationId: unknownOperation.id, supplierId, supplierVersionId, completedOperationId: completedOperation.id,
    expectedKeyId: 'legacy-test', supplierBeforeBackup: {
      submitRequests: stats.submitRequests, queryRequests: stats.queryRequests, executions: stats.executions,
    }, counts: counts.rows[0] }
  await app.close()
  await db.destroy()
  process.stdout.write('PROCUREMENT_RECOVERY_SEED=' + JSON.stringify(metadata) + '\n')
} catch (error) {
  await db.destroy().catch(() => undefined)
  throw error
}
