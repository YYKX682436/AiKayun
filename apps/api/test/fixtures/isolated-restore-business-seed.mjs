import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { createDatabase } from '/app/dist/db/pool.js'
import { readConfig } from '/app/dist/config.js'
import { encryptPaymentConfig } from '/app/dist/payments/credentials.js'
import { encryptPurchaseOrderValues, purchaseFormContentIdentity } from '/app/dist/commerce/purchase-form-crypto.js'
import { encryptSupplierCredentials } from '/app/dist/commerce/supplier-api-crypto.js'
import {
  encryptFixedDeliveryPayload,
  fixedDeliveryDeliveryContext,
  fixedDeliveryPayloadDigest,
  fixedDeliveryVersionContext,
} from '/app/dist/commerce/fixed-delivery-crypto.js'
import { purchaseLineContentIdentity } from '/app/dist/commerce/purchase-lines.js'
import { persistCheckoutProcurementSource } from '/app/dist/commerce/procurement-identity.js'
import { initializeSyntheticProcurementRiskPolicy } from '/app/dist/commerce/procurement-risk-budget.js'
import { prepareProcurementWithRisk, runProcurementFixturePass } from '/app/dist/commerce/procurement-executor.js'
import { MediaStorage } from '/app/dist/media/storage.js'
import { PrivateFileStorage } from '/app/dist/media/private-file-storage.js'

const require = createRequire('/app/package.json')
const { sql } = require('kysely')
const sharp = require('sharp')
const config = readConfig()
const db = createDatabase()
const sha = (value) => createHash('sha256').update(value).digest('hex')
const paymentKeyId = 'fixture-history'
const deliveryKeyId = 'fixture-history'

assert.ok(config.paymentCredentialKeyRing?.keys[paymentKeyId])
assert.ok(config.codePoolEncryptionKeyRing?.keys[deliveryKeyId])

try {
  const admin = await db.selectFrom('admin_users').select('id').orderBy('created_at').executeTakeFirst()
  const adminId = admin?.id ?? randomUUID()
  const customerId = randomUUID()
  if (!admin) {
    await db.insertInto('admin_users').values({ id: adminId,
      email: `restore-fixture-${adminId}@example.invalid`, password_hash: 'synthetic-only' }).execute()
  }
  await db.insertInto('customers').values({ id: customerId,
    username: `restore-${customerId.slice(0, 12)}`, password_hash: 'synthetic-only', status: 'active' }).execute()

  const mediaProductId = randomUUID(), mediaSkuId = randomUUID()
  const fixedProductId = randomUUID(), fixedSkuId = randomUUID()
  const privateObjectId = randomUUID(), fixedVersionId = randomUUID(), fileVersionId = randomUUID()
  const fileBytes = Buffer.from('synthetic private fulfillment file; historical authorization remains attached\n')
  const privateStorage = new PrivateFileStorage(config.privateFileRoot)
  const storedFile = await privateStorage.storeUpload(privateObjectId, Readable.from([fileBytes]), 'restore-private.txt')
  assert.equal(storedFile.sha256, sha(fileBytes))

  const fixedPayload = { method: 'fixed_content', content: 'synthetic fixed fulfillment secret' }
  const fixedEnvelope = encryptFixedDeliveryPayload(config,
    fixedDeliveryVersionContext(fixedSkuId, fixedVersionId, 'fixed_content'), fixedPayload, deliveryKeyId)
  const fixedDigest = fixedDeliveryPayloadDigest(config, fixedPayload, deliveryKeyId)
  const paymentChannelId = randomUUID()
  const channelPlaintext = Buffer.from(JSON.stringify({ merchantId: 'synthetic-only', merchantKey: 'synthetic-only' }))
  const channelEnvelope = encryptPaymentConfig(config,
    `payment-channel:${paymentChannelId}:credential:1`, channelPlaintext, paymentKeyId)
  channelPlaintext.fill(0)

  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values([
      { id: mediaProductId, name: 'Restore file fixture', description: 'Synthetic restore acceptance', product_type: 'digital', status: 'active' },
      { id: fixedProductId, name: 'Restore fixed fixture', description: 'Synthetic restore acceptance', product_type: 'digital', status: 'active' },
    ]).execute()
    await trx.insertInto('product_variants').values([
      { id: mediaSkuId, product_id: mediaProductId, sku_code: `RESTORE-FILE-${mediaSkuId.slice(0, 8)}`,
        combination_key: '', sale_price: '19.95', enabled: true, inventory_mode: 'quantity' },
      { id: fixedSkuId, product_id: fixedProductId, sku_code: `RESTORE-FIXED-${fixedSkuId.slice(0, 8)}`,
        combination_key: '', sale_price: '23.50', enabled: true, inventory_mode: 'quantity' },
    ]).execute()
    await trx.insertInto('product_variant_quantity_inventory').values([
      { product_id: mediaProductId, product_variant_id: mediaSkuId, stocked: 4, reserved: 0 },
      { product_id: fixedProductId, product_variant_id: fixedSkuId, stocked: 4, reserved: 0 },
    ]).execute()
    await trx.insertInto('private_file_objects').values({ id: privateObjectId, uploaded_by_admin_id: adminId,
      upload_filename: 'restore-private.txt', status: 'available', media_type: storedFile.mediaType,
      size_bytes: storedFile.sizeBytes, sha256: storedFile.sha256, expires_at: new Date(Date.now() + 86_400_000) }).execute()
    await trx.insertInto('product_variant_fulfillment_versions').values([
      { id: fixedVersionId, product_variant_id: fixedSkuId, version_number: 1, method: 'fixed_content',
        encrypted_content: fixedEnvelope.ciphertext, content_nonce: fixedEnvelope.nonce,
        content_auth_tag: fixedEnvelope.authTag, encryption_key_id: fixedEnvelope.keyId,
        content_sha256: fixedDigest, created_by_admin_id: adminId },
      { id: fileVersionId, product_variant_id: mediaSkuId, version_number: 1, method: 'file',
        encrypted_content: null, content_nonce: null, content_auth_tag: null, encryption_key_id: null,
        content_sha256: storedFile.sha256, created_by_admin_id: adminId,
        private_file_object_id: privateObjectId, display_filename: 'restore-private.txt' },
    ]).execute()
    await trx.insertInto('product_variant_fulfillment').values([
      { product_variant_id: mediaSkuId, method: 'file', automatic_delivery_ready: true,
        current_content_version_id: fileVersionId },
      { product_variant_id: fixedSkuId, method: 'fixed_content', automatic_delivery_ready: true,
        current_content_version_id: fixedVersionId },
    ]).execute()
    await sql`SELECT set_config('aikayun.admin_id', ${adminId}, true)`.execute(trx)
    await trx.insertInto('payment_channels').values({ id: paymentChannelId, provider_type: 'zpay_epay_v1',
      name: 'Restore synthetic payment', enabled: true, payment_methods: ['alipay'], display_order: 1,
      config_ciphertext: channelEnvelope.ciphertext, config_nonce: channelEnvelope.nonce,
      config_auth_tag: channelEnvelope.authTag, config_key_id: channelEnvelope.keyId, credential_version: 1,
      created_by_admin_id: adminId, updated_by_admin_id: adminId }).execute()
  })

  const inputImage = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#7356a8' } }).png().toBuffer()
  const media = await new MediaStorage(config.mediaRoot).publishImage({ bytes: inputImage, mimeType: 'image/png' })
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('product_media').values({ id: media.id }).execute()
    await trx.insertInto('product_media_variants').values(media.variants.map((variant) => ({
      media_id: media.id, variant: variant.variant, storage_key: variant.storageKey, format: 'webp',
      width: variant.width, height: variant.height, size_bytes: variant.sizeBytes, sha256: variant.sha256,
      processing_version: variant.processingVersion,
    }))).execute()
    await trx.insertInto('product_media_references').values({ product_id: mediaProductId, media_id: media.id,
      source: 'gallery', sort_order: 0 }).execute()
  })

  const makeOrder = async ({ productId, skuId, name, skuCode, versionId, price, pending }) => {
    const orderId = randomUUID(), itemId = randomUUID(), lineId = randomUUID()
    const hash = sha(`restore-order:${orderId}`)
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('orders').values({ id: orderId, customer_id: customerId,
        guest_order_session_id: null, idempotency_key: randomUUID(), request_sha256: hash,
        total_amount: price, unpaid_expires_at: new Date(Date.now() + 3_600_000),
        history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null }).execute()
      await trx.insertInto('order_items').values({ id: itemId, purchase_line_id: lineId, order_id: orderId,
        product_id: productId, product_variant_id: skuId, product_name_snapshot: name,
        product_type_snapshot: 'digital', sku_code_snapshot: skuCode, sku_snapshot: JSON.stringify([]),
        inventory_mode_snapshot: 'quantity', fulfillment_method_snapshot: versionId === fileVersionId ? 'file' : 'fixed_content',
        fulfillment_content_version_id: versionId, unit_price: price, quantity: 1, line_amount: price,
      }).execute()
      await trx.insertInto('order_item_purchase_snapshots').values({ order_item_id: itemId,
        template_version_id: null, normalization_version: null,
        content_identity: purchaseLineContentIdentity(skuId, null, null, null),
        encrypted_values: null, values_nonce: null, values_auth_tag: null, encryption_key_id: null,
        attachment_ids: [],
      }).execute()
      await trx.insertInto('order_inventory_reservations').values({ id: randomUUID(), order_item_id: itemId,
        product_id: productId, product_variant_id: skuId, quantity: 1 }).execute()
      await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
    })
    return { orderId, itemId, price, pending }
  }

  const fileOrder = await makeOrder({ productId: mediaProductId, skuId: mediaSkuId, name: 'Restore file fixture',
    skuCode: `RESTORE-FILE-${mediaSkuId.slice(0, 8)}`, versionId: fileVersionId, price: '19.95', pending: true })
  const fixedOrder = await makeOrder({ productId: fixedProductId, skuId: fixedSkuId, name: 'Restore fixed fixture',
    skuCode: `RESTORE-FIXED-${fixedSkuId.slice(0, 8)}`, versionId: fixedVersionId, price: '23.50', pending: false })
  const deliveredFileOrder = await makeOrder({ productId: mediaProductId, skuId: mediaSkuId, name: 'Restore file fixture',
    skuCode: `RESTORE-FILE-${mediaSkuId.slice(0, 8)}`, versionId: fileVersionId, price: '19.95', pending: false })

  const createAttempt = async ({ orderId, amount, provider, online, unresolved }) => {
    const id = randomUUID()
    const merchantOrderNo = randomUUID().replaceAll('-', '').slice(0, 24).toUpperCase()
    const attempt = { id, order_id: orderId, topup_customer_id: null, source: 'external', amount,
      status: 'created', provider, idempotency_key: randomUUID(), request_sha256: sha(`restore-attempt:${id}`),
      expires_at: new Date(Date.now() + 1_800_000), ...(online ? { payment_channel_id: paymentChannelId,
        provider_type_snapshot: 'zpay_epay_v1', payment_method_snapshot: 'alipay',
        payment_channel_name_snapshot: 'Restore synthetic payment', channel_credential_version: 1,
        merchant_order_no: merchantOrderNo } : {}) }
    await db.insertInto('payment_attempts').values(attempt).execute()
    const secret = encryptPaymentConfig(config, `payment-attempt:${id}:config:1`,
      Buffer.from(JSON.stringify({ merchantId: 'synthetic-only', merchantKey: 'synthetic-only' })), paymentKeyId)
    await db.insertInto('payment_attempt_secrets').values({ payment_attempt_id: id, envelope_version: 1,
      config_version: 1, key_id: secret.keyId, nonce: secret.nonce, ciphertext: secret.ciphertext,
      auth_tag: secret.authTag }).execute()
    if (unresolved) await db.insertInto('payment_attempt_provider_state').values({ payment_attempt_id: id,
      state: 'unknown', action: null, provider_order_id: null, last_error_code: 'SYNTHETIC_UNKNOWN' }).execute()
    return id
  }

  const pendingAttemptId = await createAttempt({ orderId: fileOrder.orderId, amount: fileOrder.price,
    provider: 'zpay_epay_v1', online: true, unresolved: true })
  const settledAttemptId = await createAttempt({ orderId: fixedOrder.orderId, amount: fixedOrder.price,
    provider: 'zpay_epay_v1', online: true, unresolved: false })
  const deliveredFileAttemptId = await createAttempt({ orderId: deliveredFileOrder.orderId,
    amount: deliveredFileOrder.price, provider: 'zpay_epay_v1', online: true, unresolved: false })
  const receiptId = randomUUID()
  await db.insertInto('payment_receipts').values({ id: receiptId, payment_attempt_id: settledAttemptId,
    source_bucket: 'external', provider: 'zpay_epay_v1', provider_transaction_id: `synthetic-${receiptId}`,
    amount: fixedOrder.price }).execute()
  await db.insertInto('payment_provider_events').values({ id: randomUUID(), payment_attempt_id: settledAttemptId,
    source: 'callback', event_sha256: sha(`synthetic-provider-event:${receiptId}`), verification: 'verified',
    disposition: 'settled', provider_status: 'paid', provider_transaction_id: `synthetic-${receiptId}`,
    reported_amount: fixedOrder.price, currency: 'CNY', provider_paid_at: new Date(), provider_time_text: 'synthetic',
    payload: { fixture: 'isolated-restore-acceptance' } }).execute()
  const fileReceiptId = randomUUID()
  await db.insertInto('payment_receipts').values({ id: fileReceiptId, payment_attempt_id: deliveredFileAttemptId,
    source_bucket: 'external', provider: 'zpay_epay_v1', provider_transaction_id: `synthetic-${fileReceiptId}`,
    amount: deliveredFileOrder.price }).execute()
  await db.insertInto('payment_provider_events').values({ id: randomUUID(), payment_attempt_id: deliveredFileAttemptId,
    source: 'callback', event_sha256: sha(`synthetic-provider-event:${fileReceiptId}`), verification: 'verified',
    disposition: 'settled', provider_status: 'paid', provider_transaction_id: `synthetic-${fileReceiptId}`,
    reported_amount: deliveredFileOrder.price, currency: 'CNY', provider_paid_at: new Date(), provider_time_text: 'synthetic',
    payload: { fixture: 'isolated-restore-file-download-authorization' } }).execute()

  const deliveryId = randomUUID(), fulfillmentAttemptId = randomUUID()
  const deliveryEnvelope = encryptFixedDeliveryPayload(config,
    fixedDeliveryDeliveryContext(fixedOrder.itemId, deliveryId, fixedVersionId, 'fixed_content'),
    fixedPayload, deliveryKeyId)
  await db.insertInto('order_item_fulfillment_attempts').values({ id: fulfillmentAttemptId,
    order_item_id: fixedOrder.itemId, operation_id: randomUUID(), quantity: 1, status: 'processing',
    delivery_source: 'fixed_content' }).execute()
  await db.insertInto('order_item_fulfillment_deliveries').values({ id: deliveryId,
    fulfillment_attempt_id: fulfillmentAttemptId, delivery_source: 'fixed_content', started_by_admin_id: null, unit_index: 1,
    content: null, content_sha256: fixedDigest, encrypted_content: deliveryEnvelope.ciphertext,
    content_nonce: deliveryEnvelope.nonce, content_auth_tag: deliveryEnvelope.authTag,
    encryption_key_id: deliveryEnvelope.keyId, code_pool_entry_id: null,
    fulfillment_content_version_id: fixedVersionId }).execute()
  await db.updateTable('order_item_fulfillment_attempts').set({ status: 'succeeded',
    result_sha256: sha(`fixed-delivery-result:${deliveryId}`) }).where('id', '=', fulfillmentAttemptId).execute()

  const fileDeliveryId = randomUUID(), fileFulfillmentAttemptId = randomUUID()
  await db.insertInto('order_item_fulfillment_attempts').values({ id: fileFulfillmentAttemptId,
    order_item_id: deliveredFileOrder.itemId, operation_id: randomUUID(), quantity: 1, status: 'processing',
    delivery_source: 'file' }).execute()
  await db.insertInto('order_item_fulfillment_deliveries').values({ id: fileDeliveryId,
    fulfillment_attempt_id: fileFulfillmentAttemptId, delivery_source: 'file', started_by_admin_id: null,
    unit_index: 1, content: null, content_sha256: storedFile.sha256, encrypted_content: null,
    content_nonce: null, content_auth_tag: null, encryption_key_id: null, code_pool_entry_id: null,
    fulfillment_content_version_id: fileVersionId }).execute()
  await db.updateTable('order_item_fulfillment_attempts').set({ status: 'succeeded',
    result_sha256: storedFile.sha256 }).where('id', '=', fileFulfillmentAttemptId).execute()

  const refundId = randomUUID()
  await db.insertInto('order_refunds').values({ id: refundId, order_id: fixedOrder.orderId,
    idempotency_key: randomUUID(), request_sha256: sha(`restore-refund:${refundId}`), amount: '5.00',
    reason: 'Synthetic pending original-source refund' }).execute()
  await db.updateTable('order_refunds').set({ status: 'approved', reviewed_by_admin_id: adminId,
    reviewed_at: new Date() }).where('id', '=', refundId).execute()
  const allocationId = randomUUID()
  await db.insertInto('order_refund_allocations').values({ id: allocationId, refund_id: refundId,
    source_payment_receipt_id: receiptId, operation_id: randomUUID(), request_sha256: sha(`restore-refund-allocation:${refundId}`),
    destination: 'cash_balance', amount: '5.00' }).execute()
  await db.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()

  const topupAttemptId = randomUUID()
  await db.insertInto('payment_attempts').values({ id: topupAttemptId, idempotency_key: randomUUID(),
    request_sha256: sha(`restore-topup:${topupAttemptId}`), order_id: null, topup_customer_id: customerId,
    source: 'external', amount: '40.00', status: 'created', provider: 'synthetic-topup',
    expires_at: new Date(Date.now() + 1_800_000) }).execute()
  const topupSecret = encryptPaymentConfig(config, `payment-attempt:${topupAttemptId}:config:1`,
    Buffer.from(JSON.stringify({ provider: 'synthetic-topup' })), paymentKeyId)
  await db.insertInto('payment_attempt_secrets').values({ payment_attempt_id: topupAttemptId, envelope_version: 1,
    config_version: 1, key_id: topupSecret.keyId, nonce: topupSecret.nonce,
    ciphertext: topupSecret.ciphertext, auth_tag: topupSecret.authTag }).execute()
  const topupReceiptId = randomUUID()
  await db.insertInto('payment_receipts').values({ id: topupReceiptId, payment_attempt_id: topupAttemptId,
    source_bucket: 'external', provider: 'synthetic-topup', provider_transaction_id: `synthetic-${topupReceiptId}`,
    amount: '40.00' }).execute()

  const withdrawalId = randomUUID(), withdrawalOperationId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('wallet_operations').values({ id: withdrawalOperationId, customer_id: customerId,
      operation_type: 'withdrawal_freeze', request_sha256: sha(`restore-withdrawal:${withdrawalId}`) }).execute()
    await trx.insertInto('withdrawals').values({ id: withdrawalId, customer_id: customerId,
      idempotency_key: randomUUID(), request_sha256: sha(`restore-withdrawal:${withdrawalId}`),
      wallet_operation_id: withdrawalOperationId, amount: '10.00', fee_amount: '0.00', payout_amount: '10.00',
      payout_method: 'alipay', recipient_snapshot: { channel: 'synthetic', account: 'fixture-only' } }).execute()
  })
  await db.updateTable('withdrawals').set({ status: 'pending_transfer', reviewed_by_admin_id: adminId,
    reviewed_at: new Date() }).where('id', '=', withdrawalId).execute()
  const payoutAttemptId = randomUUID()
  await db.insertInto('withdrawal_payout_attempts').values({ id: payoutAttemptId,
    withdrawal_id: withdrawalId, operation_id: randomUUID(), started_by_admin_id: adminId,
    status: 'started' }).execute()
  await db.updateTable('withdrawal_payout_attempts').set({ status: 'unknown' }).where('id', '=', payoutAttemptId).execute()

  // Exercise a genuine, version-bound procurement source and its reservation.
  // The fixture transport is in-memory and returns an unknown result; it never
  // opens a supplier connection or authorizes a second submit after restore.
  const procurementProductId = randomUUID(), procurementSkuId = randomUUID()
  const supplierId = randomUUID(), supplierVersionId = randomUUID(), supplierCredentialVersion = 1
  const mappingId = randomUUID(), mappingVersionId = randomUUID()
  const templateId = randomUUID(), templateVersionId = randomUUID()
  const templateFieldId = randomUUID()
  const templateDefinition = { fields: [{ id: templateFieldId, meaningKey: 'account', type: 'text',
    label: 'Account', required: true, maxLength: 120 }] }
  const procurementPurchaseValues = { [templateFieldId]: 'synthetic-restore-account' }
  const templateHash = sha(JSON.stringify(templateDefinition))
  const structureHash = sha('synthetic-restore-procurement-structure')
  const rulesHash = sha('synthetic-restore-procurement-rules')
  const historicalSupplierConfig = { ...config, paymentCredentialKeyRing: {
    ...config.paymentCredentialKeyRing, activeKeyId: paymentKeyId,
  } }
  const supplierEnvelope = encryptSupplierCredentials(historicalSupplierConfig, supplierId, supplierCredentialVersion, {
    providerType: 'kayixin_customer_v3', appId: '123456789', appSecret: 'synthetic-only-procurement-fixture',
  })
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('supplier_connections').values({ id: supplierId, display_name: 'Synthetic restore supplier',
      provider_type: 'kayixin_customer_v3', enabled: false, current_version_id: null, tested_version_id: null,
      created_by_admin_id: adminId }).execute()
    await trx.insertInto('supplier_connection_credentials').values({ supplier_connection_id: supplierId,
      credential_version: supplierCredentialVersion, provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3',
      key_id: supplierEnvelope.keyId, nonce: supplierEnvelope.nonce, ciphertext: supplierEnvelope.ciphertext,
      auth_tag: supplierEnvelope.authTag }).execute()
    await trx.insertInto('supplier_connection_versions').values({ id: supplierVersionId, supplier_connection_id: supplierId,
      version_number: 1, display_name: 'Synthetic restore supplier v1', provider_type: 'kayixin_customer_v3',
      auth_scheme: 'app_signature_v3', base_url: 'https://synthetic.invalid', credential_version: supplierCredentialVersion,
      created_by_admin_id: adminId }).execute()
    await trx.updateTable('supplier_connections').set({ current_version_id: supplierVersionId })
      .where('id', '=', supplierId).execute()
    await trx.insertInto('purchase_form_templates').values({ id: templateId, name: 'Synthetic restore procurement form',
      definition: templateDefinition, created_by_admin_id: adminId, updated_by_admin_id: adminId }).execute()
    await trx.insertInto('purchase_form_template_versions').values({ id: templateVersionId, template_id: templateId,
      version_number: 1, name: 'Synthetic restore procurement form v1', definition: templateDefinition,
      sha256: templateHash, created_by_admin_id: adminId }).execute()
    await trx.insertInto('products').values({ id: procurementProductId, name: 'Synthetic restore procurement item',
      description: 'Isolated recovery only', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({ id: procurementSkuId, product_id: procurementProductId,
      sku_code: `RESTORE-PROC-${procurementSkuId.slice(0, 8)}`, combination_key: '', sale_price: '2.00',
      enabled: true, inventory_mode: 'quantity' }).execute()
    await trx.insertInto('product_variant_quantity_inventory').values({ product_id: procurementProductId,
      product_variant_id: procurementSkuId, stocked: 1, reserved: 0 }).execute()
    await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: procurementSkuId,
      method: 'manual', manual_delivery_ready: true }).execute()
    await trx.insertInto('product_purchase_form_settings').values({ product_id: procurementProductId, mode: 'template',
      template_version_id: templateVersionId, updated_by_admin_id: adminId }).execute()
    await sql`INSERT INTO supplier_product_mapping_heads
      (id, product_id, product_variant_id, supplier_connection_id, supplier_connection_version_id,
       upstream_product_id, upstream_product_name, upstream_sku_type, upstream_sku_code, upstream_combination,
       upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at, template_id, template_version_id,
       template_sha256, normalization_version, rules, rules_sha256, created_by_admin_id, updated_by_admin_id)
      VALUES (${mappingId}::uuid, ${procurementProductId}::uuid, ${procurementSkuId}::uuid, ${supplierId}::uuid,
        ${supplierVersionId}::uuid, '731003', 'Synthetic restore procurement item', 0, NULL, '[]'::jsonb, '{}'::jsonb,
        ${structureHash}, now(), ${templateId}::uuid, ${templateVersionId}::uuid, ${templateHash}, 1,
        '{"version":1,"fields":[]}'::jsonb, ${rulesHash}, ${adminId}::uuid, ${adminId}::uuid)`.execute(trx)
    await sql`INSERT INTO supplier_product_mapping_versions
      (id, mapping_id, version_number, product_id, product_variant_id, supplier_connection_id, supplier_connection_version_id,
       provider_type, upstream_product_id, upstream_product_name, upstream_sku_type, upstream_sku_code, upstream_combination,
       upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at, template_id, template_version_id,
       template_sha256, normalization_version, rules_version, rules, rules_sha256, administrator_id)
      SELECT ${mappingVersionId}::uuid, id, 1, product_id, product_variant_id, supplier_connection_id,
        supplier_connection_version_id, provider_type, upstream_product_id, upstream_product_name, upstream_sku_type,
        upstream_sku_code, upstream_combination, upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at,
        template_id, template_version_id, template_sha256, normalization_version, rules_version, rules, rules_sha256,
        ${adminId}::uuid FROM supplier_product_mapping_heads WHERE id=${mappingId}::uuid`.execute(trx)
    await trx.updateTable('supplier_product_mapping_heads').set({ status: 'reviewed', revision: 2,
      latest_review_version_id: mappingVersionId, latest_version_number: 1 }).where('id', '=', mappingId).execute()
  })

  const procurementOrderId = randomUUID(), procurementItemId = randomUUID(), procurementLineId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('orders').values({ id: procurementOrderId, customer_id: customerId,
      guest_order_session_id: null, idempotency_key: randomUUID(), request_sha256: sha(`restore-procurement-order:${procurementOrderId}`),
      total_amount: '2.00', unpaid_expires_at: new Date(Date.now() + 3_600_000), items_sealed: false,
      history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null }).execute()
    await trx.insertInto('order_items').values({ id: procurementItemId, purchase_line_id: procurementLineId,
      order_id: procurementOrderId, product_id: procurementProductId, product_variant_id: procurementSkuId,
      product_name_snapshot: 'Synthetic restore procurement item', product_type_snapshot: 'digital',
      sku_code_snapshot: `RESTORE-PROC-${procurementSkuId.slice(0, 8)}`, sku_snapshot: JSON.stringify([]),
      inventory_mode_snapshot: 'quantity', fulfillment_method_snapshot: 'manual', unit_price: '2.00',
      quantity: 1, line_amount: '2.00' }).execute()
    await trx.insertInto('order_inventory_reservations').values({ id: randomUUID(), order_item_id: procurementItemId,
      product_id: procurementProductId, product_variant_id: procurementSkuId, quantity: 1 }).execute()
    const purchaseEnvelope = encryptPurchaseOrderValues(config, procurementItemId, procurementPurchaseValues)
    await trx.insertInto('order_item_purchase_snapshots').values({ order_item_id: procurementItemId,
      template_version_id: templateVersionId, normalization_version: 1,
      content_identity: purchaseFormContentIdentity(templateVersionId, procurementPurchaseValues),
      encrypted_values: purchaseEnvelope.ciphertext, values_nonce: purchaseEnvelope.nonce,
      values_auth_tag: purchaseEnvelope.authTag, encryption_key_id: purchaseEnvelope.keyId, attachment_ids: [] }).execute()
    const mapping = await trx.selectFrom('supplier_product_mapping_versions').selectAll()
      .where('id', '=', mappingVersionId).executeTakeFirstOrThrow()
    await persistCheckoutProcurementSource(trx, procurementOrderId, procurementItemId, mapping)
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', procurementOrderId).execute()
  })
  const procurementPaymentAttemptId = randomUUID()
  await db.insertInto('payment_attempts').values({ id: procurementPaymentAttemptId, idempotency_key: randomUUID(),
    request_sha256: sha(`restore-procurement-payment:${procurementPaymentAttemptId}`), order_id: procurementOrderId,
    topup_customer_id: null, source: 'external', amount: '2.00', status: 'created', provider: 'synthetic-procurement',
    expires_at: new Date(Date.now() + 1_800_000) }).execute()
  const procurementPaymentSecret = encryptPaymentConfig(config,
    `payment-attempt:${procurementPaymentAttemptId}:config:1`, Buffer.from(JSON.stringify({ provider: 'synthetic-procurement' })), paymentKeyId)
  await db.insertInto('payment_attempt_secrets').values({ payment_attempt_id: procurementPaymentAttemptId, envelope_version: 1,
    config_version: 1, key_id: procurementPaymentSecret.keyId, nonce: procurementPaymentSecret.nonce,
    ciphertext: procurementPaymentSecret.ciphertext, auth_tag: procurementPaymentSecret.authTag }).execute()
  const procurementReceiptId = randomUUID()
  await db.insertInto('payment_receipts').values({ id: procurementReceiptId, payment_attempt_id: procurementPaymentAttemptId,
    source_bucket: 'external', provider: 'synthetic-procurement', provider_transaction_id: `synthetic-${procurementReceiptId}`,
    amount: '2.00' }).execute()
  await db.updateTable('payment_attempts').set({ status: 'succeeded' })
    .where('id', '=', procurementPaymentAttemptId).execute()
  const orderState = await db.selectFrom('orders').select('status').where('id', '=', procurementOrderId).executeTakeFirstOrThrow()
  if (orderState.status === 'pending_payment') {
    await db.updateTable('orders').set({ status: 'processing' }).where('id', '=', procurementOrderId).execute()
  }

  await db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, { currency: 'TST', limits: {
    perOperationMinor: '100', globalDailyMinor: '1000', globalOutstandingMinor: '1000',
    supplierDailyMinor: '1000', supplierOutstandingMinor: '1000', skuDailyMinor: '1000', skuOutstandingMinor: '1000',
  } }))
  const procurementOperation = await db.transaction().execute(trx => prepareProcurementWithRisk(trx, {
    requestId: randomUUID(), orderId: procurementOrderId, orderItemId: procurementItemId,
    unitIndices: [1], currency: 'TST', maxAmountMinor: '10',
  }))
  let syntheticSupplierSubmits = 0
  let syntheticSupplierSourceResolved = false
  const procurementPass = await runProcurementFixturePass(db, procurementOperation.id, async (request) => {
    if (request.action === 'submit') syntheticSupplierSubmits++
    return { requestIdentity: request.requestIdentity, kind: 'unknown', supplierOrderNumber: null,
      responseDigest: sha(`synthetic-restore-procurement-response:${request.operationId}`) }
  }, async source => {
    syntheticSupplierSourceResolved = source.supplierConnectionId === supplierId
      && source.connectionVersionId === supplierVersionId && source.credentialKeyId === paymentKeyId
    return syntheticSupplierSourceResolved
  }, 1_000, 900)
  const procurementState = await db.selectFrom('procurement_operations').select(['state', 'source_id'])
    .where('id', '=', procurementOperation.id).executeTakeFirstOrThrow()
  const procurementRisk = await db.transaction().execute(trx => import('/app/dist/commerce/procurement-risk-budget.js')
    .then(({ readProcurementRisk }) => readProcurementRisk(trx, procurementOperation.id)))
  assert.equal(syntheticSupplierSourceResolved, true)
  assert.equal(procurementPass, true)
  assert.equal(syntheticSupplierSubmits, 1)
  assert.equal(procurementState.state, 'unknown')
  assert.equal(procurementRisk?.outstandingMinor, '10')

  const report = {
    orders: Number((await db.selectFrom('orders').select(({ fn }) => fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    settledReceipt: receiptId,
    pendingPaymentAttempt: pendingAttemptId,
    pendingRefund: refundId,
    uncertainWithdrawal: withdrawalId,
    fixedDeliveryEnvelope: deliveryId,
    privateFileSha256: storedFile.sha256,
    publicMediaVariants: media.variants.length,
  }
  assert.ok(report.orders === 4 && report.publicMediaVariants === 3)
  process.stdout.write(`${JSON.stringify({ operation: 'synthetic-restore-business-seed', status: 'seeded',
    orders: report.orders, pendingPayment: true, refundReserved: true, withdrawalUncertain: true, historicalFileDownloadAuthorized: true,
    privateFileSha256Verified: true, publicMediaVariants: report.publicMediaVariants,
    procurementSourceAndRisk: true, procurementOperationUnknown: true, procurementRiskOutstandingMinor: procurementRisk.outstandingMinor,
    historicalPaymentKey: paymentKeyId, historicalDeliveryKey: deliveryKeyId })}\n`)
} finally {
  await db.destroy()
}
