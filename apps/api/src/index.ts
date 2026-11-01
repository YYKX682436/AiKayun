import { createApp } from './app.js'
import { readConfig } from './config.js'
import { createDatabase, createPostgresPool } from './db/pool.js'
import { startUnpaidOrderExpiryWorker } from './commerce/unpaid-order-expiry.js'
import { startDigitalDeliveryWorker } from './commerce/code-pool-delivery-worker.js'
import { startLicenseRenewalWorker } from './licensing/license-renewal-worker.js'

const config = readConfig()
const db = createDatabase()
const app = await createApp({
  db,
  config,
  ...(process.env.PAYMENT_PROVIDER_BASE_URL_FOR_TESTS
    ? { paymentProviderBaseUrlForTests: process.env.PAYMENT_PROVIDER_BASE_URL_FOR_TESTS }
    : {}),
})
const stopUnpaidOrderExpiry = startUnpaidOrderExpiryWorker(db, app.log)
const stopDigitalDelivery = startDigitalDeliveryWorker(db, config, app.log)
const licensePool = createPostgresPool({ applicationName: 'aikayun-license-worker' })
const stopLicenseRenewal = startLicenseRenewalWorker({
  db, pool: licensePool, identityRoot: config.identityRoot, pendingKeyRoot: config.licensePendingKeyRoot,
  trustStoreRoot: config.licenseTrustStoreRoot, logger: app.log,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await stopUnpaidOrderExpiry()
    await stopDigitalDelivery()
    await stopLicenseRenewal()
    await app.close()
    await licensePool.end()
    await db.destroy()
    process.exit(0)
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error({ err: error }, 'API failed to start')
  await stopLicenseRenewal()
  await licensePool.end()
  await db.destroy()
  process.exitCode = 1
}
