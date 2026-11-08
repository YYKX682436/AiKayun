import { createApp } from './app.js'
import { readConfig } from './config.js'
import { createDatabase, createPostgresPool } from './db/pool.js'
import { startUnpaidOrderExpiryWorker } from './commerce/unpaid-order-expiry.js'
import { startDigitalDeliveryWorker } from './commerce/code-pool-delivery-worker.js'
import { startLicenseRenewalWorker } from './licensing/license-renewal-worker.js'
import { isUpgradeProbeOnly } from './ops/upgrade-probe.js'

const upgradeProbeOnly = isUpgradeProbeOnly()
const config = readConfig()
const db = createDatabase()
const app = await createApp({
  db,
  config,
  ...(process.env.PAYMENT_PROVIDER_BASE_URL_FOR_TESTS
    ? { paymentProviderBaseUrlForTests: process.env.PAYMENT_PROVIDER_BASE_URL_FOR_TESTS }
    : {}),
})
const stopNothing = async () => undefined
let stopUnpaidOrderExpiry: () => Promise<void> = stopNothing
let stopDigitalDelivery: () => Promise<void> = stopNothing
let stopLicenseRenewal: () => Promise<void> = stopNothing
let licensePool: ReturnType<typeof createPostgresPool> | undefined

// Upgrade probes run with Caddy stopped. Keeping workers disabled makes a
// failed pre-acceptance health check safe to roll back without replaying
// business or external operations from two application versions.
if (!upgradeProbeOnly) {
  stopUnpaidOrderExpiry = startUnpaidOrderExpiryWorker(db, app.log)
  stopDigitalDelivery = startDigitalDeliveryWorker(db, config, app.log)
  licensePool = createPostgresPool({ applicationName: 'aikayun-license-worker' })
  stopLicenseRenewal = startLicenseRenewalWorker({
    db, pool: licensePool, identityRoot: config.identityRoot, pendingKeyRoot: config.licensePendingKeyRoot,
    trustStoreRoot: config.licenseTrustStoreRoot, logger: app.log,
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await stopUnpaidOrderExpiry()
    await stopDigitalDelivery()
    await stopLicenseRenewal()
    await app.close()
    await licensePool?.end()
    await db.destroy()
    process.exit(0)
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error({ err: error }, 'API failed to start')
  await stopUnpaidOrderExpiry()
  await stopDigitalDelivery()
  await stopLicenseRenewal()
  await licensePool?.end()
  await db.destroy()
  process.exitCode = 1
}
