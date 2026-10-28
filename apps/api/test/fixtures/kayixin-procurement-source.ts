import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types.js'
import type { AppConfig } from '../../src/config.js'
import type { ProcurementFixtureSource } from '../../src/commerce/procurement-executor.js'
import { validateKayixinBaseUrl, type KayixinV3Supplier } from '../../src/commerce/kayixin-customer-v3.js'
import { decryptSupplierCredentials } from '../../src/commerce/supplier-api-crypto.js'

/** Test-only frozen source resolution. It never creates a network transport. */
export async function resolveKayixinFixtureSource(db: Kysely<Database>, config: AppConfig, source: ProcurementFixtureSource): Promise<KayixinV3Supplier | null> {
  const row = await db.selectFrom('supplier_connection_versions as v')
    .innerJoin('supplier_connection_credentials as c', join => join
      .onRef('c.supplier_connection_id', '=', 'v.supplier_connection_id')
      .onRef('c.credential_version', '=', 'v.credential_version'))
    .select(['v.base_url', 'v.provider_type as version_provider', 'v.auth_scheme as version_auth',
      'c.provider_type as credential_provider', 'c.auth_scheme as credential_auth', 'c.key_id', 'c.nonce', 'c.ciphertext', 'c.auth_tag'])
    .where('v.id', '=', source.connectionVersionId).where('v.supplier_connection_id', '=', source.supplierConnectionId)
    .where('v.credential_version', '=', source.credentialVersion).executeTakeFirst()
  if (!row || row.version_provider !== 'kayixin_customer_v3' || row.credential_provider !== 'kayixin_customer_v3'
    || row.version_auth !== 'app_signature_v3' || row.credential_auth !== 'app_signature_v3' || row.key_id !== source.credentialKeyId) return null
  try {
    validateKayixinBaseUrl(row.base_url, config)
    const credentials = decryptSupplierCredentials(config, source.supplierConnectionId, source.credentialVersion, 'kayixin_customer_v3', {
      keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
    })
    if (credentials.providerType !== 'kayixin_customer_v3') return null
    return { baseUrl: row.base_url, appId: credentials.appId, appSecret: credentials.appSecret }
  } catch { return null }
}
