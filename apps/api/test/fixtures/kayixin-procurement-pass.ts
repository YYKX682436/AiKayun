import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types.js'
import type { AppConfig } from '../../src/config.js'
import type { KayixinV3Supplier } from '../../src/commerce/kayixin-customer-v3.js'
import { runProcurementFixturePass } from '../../src/commerce/procurement-executor.js'
import { resolveKayixinFixtureSource } from './kayixin-procurement-source.js'
import { createKayixinProcurementFixtureTransport, type KayixinFixtureWire } from './kayixin-procurement-transport.js'

/** A single isolated pass: source resolution and transport share the same frozen material. */
export async function runKayixinFixturePass(db: Kysely<Database>, config: AppConfig, operationId: string,
  wire: KayixinFixtureWire, outerNumberForOperation: (id: string, identity: string) => string | null): Promise<boolean> {
  let supplier: KayixinV3Supplier | null = null
  return runProcurementFixturePass(db, operationId, request => {
    if (!supplier) throw new Error('fixture_source_unavailable')
    return createKayixinProcurementFixtureTransport({ supplier, wire,
      timestamp: () => '1700000000', outerNumberForOperation })(request)
  }, async source => {
    supplier = await resolveKayixinFixtureSource(db, config, source)
    return supplier !== null
  })
}
