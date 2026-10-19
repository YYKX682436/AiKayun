import { createApp } from './app.js'
import { readConfig } from './config.js'
import { createDatabase } from './db/pool.js'
import { startUnpaidOrderExpiryWorker } from './commerce/unpaid-order-expiry.js'

const config = readConfig()
const db = createDatabase()
const app = await createApp({ db, config })
const stopUnpaidOrderExpiry = startUnpaidOrderExpiryWorker(db, app.log)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await stopUnpaidOrderExpiry()
    await app.close()
    await db.destroy()
    process.exit(0)
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error({ err: error }, 'API failed to start')
  await db.destroy()
  process.exitCode = 1
}
