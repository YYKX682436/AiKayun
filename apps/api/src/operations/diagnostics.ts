import { access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { failure, success } from '@aikayun/contracts'
import { requireAdmin } from '../auth/admin.js'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'

type Diagnostic = { key: string; status: 'ok' | 'problem' | 'unknown'; reason: string; impact: string }

async function directory(key: string, path: string): Promise<Diagnostic> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid')
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK)
    return { key, status: 'ok', reason: 'DIRECTORY_ACCESSIBLE', impact: 'STORAGE' }
  } catch {
    return { key, status: 'problem', reason: 'DIRECTORY_UNAVAILABLE', impact: 'STORAGE' }
  }
}

async function files(key: string, paths: string[], impact: string): Promise<Diagnostic> {
  try {
    for (const path of paths) {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid')
      await access(path, constants.R_OK)
    }
    // Presence does not prove authenticity, key binding, decryption or validity.
    return { key, status: 'unknown', reason: 'PRESENT_NOT_VERIFIED', impact }
  } catch {
    return { key, status: 'problem', reason: 'FILE_UNAVAILABLE', impact }
  }
}

export function createOperationsDiagnostics(db: Kysely<Database>, config: AppConfig) {
  let active: Promise<{ checkedAt: string; checks: Diagnostic[] }> | undefined
  const read = async () => {
    const paymentKeys = Object.keys(config.paymentCredentialKeyRing?.keys ?? {})
    const deliveryKeys = Object.keys(config.codePoolEncryptionKeyRing?.keys ?? {})
    const [media, privateFiles, identity, trust, pending, missing] = await Promise.all([
      directory('media_directory', config.mediaRoot),
      directory('private_directory', config.privateFileRoot),
      files('identity', [join(config.identityRoot, 'current', 'identity.json'), join(config.identityRoot, 'current', 'instance-private-key.pk8.pem')], 'NEW_BUSINESS'),
      files('trust_store', [join(config.licenseTrustStoreRoot, 'trust-bundle-state.json'), join(config.licenseTrustStoreRoot, 'trust-bundle-store.marker.json')], 'NEW_BUSINESS'),
      files('pending_key', [join(config.licensePendingKeyRoot, 'license-pending-aes-256-gcm.json')], 'LICENSE_RECOVERY'),
      db.transaction().execute(async tx => {
        await sql`SET LOCAL statement_timeout = '1500ms'`.execute(tx)
        const rows = await sql<{ payment: boolean; delivery: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM payment_channels WHERE config_key_id IS NOT NULL AND NOT (config_key_id = ANY(${paymentKeys}::text[]))
            UNION ALL SELECT 1 FROM payment_attempt_secrets WHERE NOT (key_id = ANY(${paymentKeys}::text[]))
            UNION ALL SELECT 1 FROM supplier_connection_credentials WHERE NOT (key_id = ANY(${paymentKeys}::text[]))
            UNION ALL SELECT 1 FROM purchase_drafts WHERE NOT (encryption_key_id = ANY(${paymentKeys}::text[]))
            UNION ALL SELECT 1 FROM order_item_purchase_snapshots WHERE encryption_key_id IS NOT NULL AND NOT (encryption_key_id = ANY(${paymentKeys}::text[]))
          ) AS payment,
          EXISTS (
            SELECT 1 FROM code_pool_entries WHERE NOT (encryption_key_id = ANY(${deliveryKeys}::text[])) OR NOT (fingerprint_key_id = ANY(${deliveryKeys}::text[]))
            UNION ALL SELECT 1 FROM code_pool_batches WHERE request_fingerprint_key_id IS NOT NULL AND NOT (request_fingerprint_key_id = ANY(${deliveryKeys}::text[]))
            UNION ALL SELECT 1 FROM product_variant_fulfillment_versions WHERE encryption_key_id IS NOT NULL AND NOT (encryption_key_id = ANY(${deliveryKeys}::text[]))
            UNION ALL SELECT 1 FROM order_item_fulfillment_deliveries WHERE (encryption_key_id IS NOT NULL AND NOT (encryption_key_id = ANY(${deliveryKeys}::text[]))) OR (supplier_fingerprint_key_id IS NOT NULL AND NOT (supplier_fingerprint_key_id = ANY(${deliveryKeys}::text[])))
            UNION ALL SELECT 1 FROM supplier_api_delivery_operations WHERE result_key_id IS NOT NULL AND NOT (result_key_id = ANY(${deliveryKeys}::text[]))
          ) AS delivery
        `.execute(tx)
        return rows.rows[0]!
      }),
    ])
    const keyStatus = (key: string, absent: boolean, configured: boolean): Diagnostic => absent
      ? { key, status: 'problem', reason: 'HISTORICAL_KEY_MISSING', impact: 'HISTORICAL_OBLIGATIONS' }
      : { key, status: 'unknown', reason: configured ? 'KEY_IDS_PRESENT_NOT_DECRYPTED' : 'KEY_RING_NOT_CONFIGURED', impact: 'HISTORICAL_OBLIGATIONS' }
    const payment = keyStatus('payment_keys', missing.payment, paymentKeys.length > 0)
    const delivery = keyStatus('delivery_keys', missing.delivery, deliveryKeys.length > 0)
    const historyProblem = payment.status === 'problem' || delivery.status === 'problem' || privateFiles.status === 'problem'
    const history: Diagnostic = { key: 'historical_obligations', status: historyProblem ? 'problem' : 'unknown',
      reason: historyProblem ? 'DEPENDENCY_UNAVAILABLE' : 'NOT_FULLY_VERIFIED', impact: 'HISTORICAL_OBLIGATIONS' }
    return { checkedAt: new Date().toISOString(), checks: [media, privateFiles, identity, trust, pending, payment, delivery, history] }
  }
  return async () => {
    if (!active) active = read().finally(() => { active = undefined })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([active, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 2000) })])
    } finally { if (timer) clearTimeout(timer) }
  }
}

export function registerOperationsDiagnosticsRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig) {
  const read = createOperationsDiagnostics(db, config)
  app.get('/api/v1/admin/operations/diagnostics', { preHandler: requireAdmin(db, config) }, async (request, reply) => {
    try { return success(await read(), request.id) }
    catch { return reply.code(503).send(failure('OPERATIONS_UNAVAILABLE', 'Operations data is temporarily unavailable', request.id)) }
  })
}
