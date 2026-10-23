// Test-only process. Gates the real pg driver at transaction boundaries; no
// fault hooks, mock database, or alternative fulfillment code enter production.
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from '../../src/db/types.js'
import { readConfig } from '../../src/config.js'
import { createApp } from '../../src/app.js'
import { runDigitalDeliveryRecoveryPass } from '../../src/commerce/code-pool-delivery-worker.js'

const config = readConfig()
const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
if (config.nodeEnv !== 'test' || !databaseName.endsWith('_test') || !process.send) {
  throw new Error('Crash fixtures require an explicit isolated _test database and IPC')
}
const checkpoint = process.env.CRASH_CHECKPOINT
let gated = false
let resume: (() => void) | undefined
async function gate(name: string) {
  if (checkpoint !== name || gated) return
  gated = true
  process.send!({ checkpoint: name })
  await new Promise<void>((resolve) => { resume = resolve })
}
const pool = new Pool({ ...config.database, max: 10, application_name: 'aikayun-phase55-crash-test' })
pool.on('connect', (client) => {
  const original = client.query.bind(client)
  let operationCreated = false
  let resultStored = false
  let delivered = false
  let leaseClaimed = false
  // Kysely uses the promise overload exclusively. Keep the wrapper inside this
  // disposable child, so SIGKILL also closes its real PostgreSQL connections.
  client.query = (async (queryText: string, values?: unknown[]) => {
    const text = queryText.toLowerCase()
    if (text.startsWith('update "supplier_api_delivery_operations"') && values?.includes('succeeded_pending_finalize')) {
      await gate('response_received')
      resultStored = true
    }
    if (text.startsWith('update "private_file_objects"') && values?.includes('staged')) await gate('upload_published')
    const result = await original(queryText, values)
    if (text.includes('from orders as order_row') && text.includes('item.fulfillment_method_snapshot in')) await gate('candidate_selected')
    if (process.env.CRASH_TARGET_OPERATION && text.startsWith('select "id" from "supplier_api_delivery_operations"')
      && values?.includes('succeeded_pending_finalize')) {
      result.rows = result.rows.filter(row => row.id === process.env.CRASH_TARGET_OPERATION)
    }
    if (text.includes('with requested as materialized')) await gate('duplicate_checked')
    if (text.startsWith('insert into "supplier_api_delivery_operations"')) operationCreated = true
    if (text.startsWith('insert into "supplier_api_delivery_events"') && values?.includes('create_started')) leaseClaimed = true
    if (text.startsWith('insert into "order_inventory_reservations"')) await gate('code_reserved_uncommitted')
    if (text.startsWith('insert into "order_item_fulfillment_deliveries"')) {
      delivered = true
      await gate('delivery_uncommitted')
    }
    if (text === 'commit') {
      if (operationCreated) await gate('operation_committed')
      if (leaseClaimed) await gate('lease_committed')
      if (resultStored) await gate('result_committed')
      if (delivered) await gate('delivery_committed')
      operationCreated = false
      resultStored = false
      delivered = false
      leaseClaimed = false
    }
    return result
  }) as typeof client.query
})
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const app = await createApp({ db, config, logger: checkpoint === 'capture_logs' })
app.get('/__test/resources', async () => ({ memory: process.memoryUsage(), cpu: process.cpuUsage(), resource: process.resourceUsage() }))
await app.listen({ host: '127.0.0.1', port: 0 })
process.send!({ ready: app.listeningOrigin })
process.on('message', (message) => {
  if (message === 'resume') resume?.()
  if (message && typeof message === 'object' && 'run' in message) void runDigitalDeliveryRecoveryPass(db, config)
    .then(() => process.send!({ done: message.run }))
    .catch(error => process.send!({ failed: String(error) }))
})
