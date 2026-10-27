import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const { sql } = createRequire('/app/package.json')('kysely')

const metadata = JSON.parse(process.env.AIKAYUN_PROCUREMENT_RECOVERY_METADATA || '{}')
if (!metadata.unknownOperationId || !metadata.completedOrderId) throw new Error('Missing isolated recovery metadata')
const { readConfig } = await import('/app/dist/config.js')
const { createDatabase } = await import('/app/dist/db/pool.js')
const { createApp } = await import('/app/dist/app.js')
const { decryptSupplierCredentials } = await import('/app/dist/commerce/supplier-api-crypto.js')
const { runProcurementFixturePass } = await import('/app/dist/commerce/procurement-executor.js')
const { readProcurementRisk } = await import('/app/dist/commerce/procurement-risk-budget.js')
const { PurchaseOrderAttachmentStorage } = await import('/app/dist/media/purchase-order-attachment-storage.js')

const config = readConfig()
const databaseName = String(config.database.database || '')
if (config.nodeEnv !== 'test' || !databaseName.endsWith('_test')
  || !config.paymentCredentialKeyRing?.keys['legacy-test']) {
  throw new Error('Recovery check requires the isolated Compose test database and historical synthetic key')
}
const db = createDatabase()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const proof = { database: databaseName, historicalKeyId: null, authorizedPurchaseRead: false,
  attachmentSha256: null, unknownQueryOnly: false, procurementLedger: null }

try {
  const credential = await db.selectFrom('supplier_connection_credentials').selectAll()
    .where('supplier_connection_id', '=', metadata.supplierId).where('credential_version', '=', 1).executeTakeFirstOrThrow()
  proof.historicalKeyId = credential.key_id
  if (credential.key_id !== 'legacy-test') throw new Error('Supplier credential did not retain its historical key id')
  const plaintext = decryptSupplierCredentials(config, metadata.supplierId, 1, 'kayixin_customer_v3', {
    keyId: credential.key_id, nonce: credential.nonce, ciphertext: credential.ciphertext, authTag: credential.auth_tag,
  })
  if (plaintext.appSecret !== 'synthetic-only-backup-fixture') throw new Error('Historical supplier key could not decrypt its synthetic envelope')

  const operationStates = await sql`SELECT id,state,supplier_order_number FROM procurement_operations
    WHERE id=ANY(${[metadata.completedOperationId, metadata.rejectedOperationId, metadata.collisionOperationId,
      metadata.unknownOperationId]}::uuid[]) ORDER BY id`.execute(db)
  const byId = new Map(operationStates.rows.map(row => [row.id, row]))
  if (byId.get(metadata.completedOperationId)?.state !== 'completed'
    || byId.get(metadata.rejectedOperationId)?.state !== 'rejected'
    || byId.get(metadata.collisionOperationId)?.state !== 'manual_review'
    || byId.get(metadata.unknownOperationId)?.state !== 'unknown') {
    throw new Error('Restored procurement operation states differ from the seed')
  }
  const conflicts = await sql`SELECT count(*)::text AS count FROM procurement_execution_conflicts
    WHERE operation_id IN (${metadata.rejectedOperationId}::uuid,${metadata.collisionOperationId}::uuid)
      AND reason='supplier_number'`.execute(db)
  const reinstatements = await sql`SELECT count(*)::text AS count FROM procurement_risk_events
    WHERE operation_id=${metadata.rejectedOperationId}::uuid AND kind='reinstate'`.execute(db)
  if (conflicts.rows[0].count !== '2' || reinstatements.rows[0].count !== '1') {
    throw new Error('Restored global conflict or one-time budget reinstatement is missing')
  }
  const operationRisk = await Promise.all([metadata.completedOperationId, metadata.rejectedOperationId,
    metadata.collisionOperationId, metadata.unknownOperationId].map(operationId =>
    db.transaction().execute(trx => readProcurementRisk(trx, operationId))))
  if (operationRisk.some(row => row?.outstandingMinor !== '10')) throw new Error('Restored operation risk reservations do not reconcile')
  const bucketTotals = await sql`SELECT scope_kind,outstanding_minor::text AS outstanding FROM procurement_risk_buckets
    WHERE currency='TST' ORDER BY scope_kind`.execute(db)
  if (bucketTotals.rows.length !== 3 || bucketTotals.rows.some(row => row.outstanding !== '40')) {
    throw new Error('Restored global, supplier and SKU risk buckets do not equal the four operation reservations')
  }
  const unitStates = await sql`SELECT state,count(*)::text AS count FROM procurement_operation_units
    WHERE operation_id=ANY(${[metadata.completedOperationId, metadata.rejectedOperationId,
      metadata.collisionOperationId, metadata.unknownOperationId]}::uuid[]) GROUP BY state ORDER BY state`.execute(db)
  const unitCounts = Object.fromEntries(unitStates.rows.map(row => [row.state, row.count]))
  if (unitCounts.completed !== '1' || unitCounts.rejected !== '1' || unitCounts.manual_review !== '1' || unitCounts.unknown !== '1') {
    throw new Error('Restored procurement units do not reconcile with their four operation states')
  }
  const facts = await sql`SELECT
    (SELECT count(*)::text FROM payment_receipts receipt JOIN payment_attempts payment ON payment.id=receipt.payment_attempt_id
      JOIN orders parent ON parent.id=payment.order_id WHERE parent.customer_id=${metadata.customerId}::uuid) AS receipts,
    (SELECT count(*)::text FROM order_item_fulfillment_deliveries delivery JOIN order_item_fulfillment_attempts attempt
      ON attempt.id=delivery.fulfillment_attempt_id WHERE attempt.procurement_operation_id=${metadata.completedOperationId}::uuid) AS deliveries,
    (SELECT count(*)::text FROM order_inventory_events event JOIN order_inventory_reservations reservation
      ON reservation.id=event.reservation_id WHERE reservation.order_item_id=${metadata.completedItemId}::uuid AND event.action='consume') AS consumes,
    (SELECT count(*)::text FROM purchase_order_attachment_objects object JOIN order_item_purchase_attachments reference
      ON reference.archive_object_id=object.id WHERE reference.order_item_id=${metadata.completedItemId}::uuid AND object.status='retained') AS retained_attachments,
    (SELECT count(*)::text FROM procurement_request_intents WHERE operation_id=${metadata.unknownOperationId}::uuid AND action='submit') AS unknown_submit_intents`.execute(db)
  if (facts.rows[0].receipts !== '4' || facts.rows[0].deliveries !== '1' || facts.rows[0].consumes !== '1'
    || facts.rows[0].retained_attachments !== '1' || facts.rows[0].unknown_submit_intents !== '1') {
    throw new Error('Restored payment, fulfillment, inventory, attachment or unknown-intent facts do not reconcile')
  }

  const app = await createApp({ db, config, logger: false })
  await app.ready()
  const headers = { origin: config.publicOrigin, cookie: 'aikayun_customer_session=' + metadata.customerToken }
  const detailResponse = await app.inject({ method: 'GET', url: '/api/v1/customer/orders/' + metadata.completedOrderId, headers })
  if (detailResponse.statusCode !== 200) throw new Error('Restored completed order is not authorized for its owner: ' + detailResponse.body)
  const detail = detailResponse.json().data
  const item = detail.items.find(row => row.id === metadata.completedItemId)
  if (detail.status !== 'completed' || !item || item.purchaseData.state !== 'filled'
    || item.purchaseData.values[metadata.accountField] !== 'historical-key-completed-order') {
    throw new Error('Restored completed order or historical-key purchase snapshot is invalid')
  }
  const attachment = item.purchaseData.attachments.find(row => row.attachmentId === metadata.attachmentId)
  if (!attachment || attachment.sha256 !== metadata.attachmentSha256) throw new Error('Restored purchase attachment reference is invalid')
  const fileResponse = await app.inject({ method: 'GET', url: attachment.url, headers })
  if (fileResponse.statusCode !== 200 || hash(fileResponse.rawPayload) !== attachment.sha256) {
    throw new Error('Restored private purchase file failed its authorized SHA-256 read')
  }
  const object = await db.selectFrom('order_item_purchase_attachments as reference')
    .innerJoin('purchase_order_attachment_objects as object', 'object.id', 'reference.archive_object_id')
    .select(['reference.sha256 as reference_sha256', 'object.sha256 as object_sha256', 'object.byte_size', 'object.storage_key'])
    .where('reference.order_item_id', '=', metadata.completedItemId)
    .where('reference.source_attachment_id', '=', metadata.attachmentId).executeTakeFirstOrThrow()
  const fileId = object.storage_key.slice('order-objects/'.length).split('/')[1]?.replace(/\.webp$/u, '')
  if (!fileId) throw new Error('Restored private purchase file identity is invalid')
  const bytes = await new PurchaseOrderAttachmentStorage(config.privateFileRoot)
    .readVerified(fileId, object.storage_key, object.byte_size, object.object_sha256)
  if (object.reference_sha256 !== object.object_sha256 || hash(bytes) !== object.object_sha256) {
    throw new Error('Restored database attachment SHA-256 differs from the private file')
  }
  proof.authorizedPurchaseRead = true
  proof.attachmentSha256 = object.object_sha256

  const supplierUrl = 'http://127.0.0.1:3102'
  const statsBefore = await fetch(supplierUrl + '/stats').then(response => response.json())
  if (statsBefore.submitRequests !== metadata.supplierBeforeBackup.submitRequests
    || statsBefore.executions !== metadata.supplierBeforeBackup.executions) {
    throw new Error('Persistent synthetic supplier counts changed across backup restore')
  }
  await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second'
    WHERE operation_id=${metadata.unknownOperationId}::uuid`.execute(db)
  const transport = async request => {
    const response = await fetch(supplierUrl + '/' + request.action, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    if (!response.ok) throw new Error('Restored supplier query failed: ' + response.status)
    return await response.json()
  }
  await runProcurementFixturePass(db, metadata.unknownOperationId, transport, async source =>
    source.supplierConnectionId === metadata.supplierId && source.connectionVersionId === metadata.supplierVersionId, 1_000, 900)
  const statsAfter = await fetch(supplierUrl + '/stats').then(response => response.json())
  const unknown = await db.selectFrom('procurement_operations').select('state').where('id', '=', metadata.unknownOperationId).executeTakeFirstOrThrow()
  const queryIntents = await db.selectFrom('procurement_request_intents').select('action').where('operation_id', '=', metadata.unknownOperationId)
    .orderBy('generation').execute()
  const unknownRisk = await db.transaction().execute(trx => readProcurementRisk(trx, metadata.unknownOperationId))
  if (unknown.state !== 'unknown' || unknownRisk?.outstandingMinor !== '10'
    || statsAfter.submitRequests !== statsBefore.submitRequests || statsAfter.queryRequests !== statsBefore.queryRequests + 1
    || statsAfter.executions !== statsBefore.executions || queryIntents.map(row => row.action).join(',') !== 'submit,query') {
    throw new Error('Unknown operation did not remain eligible for query-only recovery after restore')
  }
  proof.unknownQueryOnly = true
  proof.procurementLedger = { operationStates: Object.fromEntries(operationStates.rows.map(row => [row.id, row.state])),
    unitStates: unitCounts, conflicts: conflicts.rows[0].count, reinstatements: reinstatements.rows[0].count,
    riskScopes: bucketTotals.rows, paymentAndDelivery: facts.rows[0],
    supplierCountsBeforeRestore: metadata.supplierBeforeBackup,
    supplierCountsAfterQueryRecovery: { submitRequests: statsAfter.submitRequests,
      queryRequests: statsAfter.queryRequests, executions: statsAfter.executions } }
  await app.close()
  await db.destroy()
  process.stdout.write('PROCUREMENT_RECOVERY_VERIFY=' + JSON.stringify(proof) + '\n')
} catch (error) {
  await db.destroy().catch(() => undefined)
  throw error
}
