// Test-only Fastify child. Storage and checkout code remain the production
// implementations; only this disposable process installs checkpoint wrappers.
import { open } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Database } from '../../src/db/types.js'
import { readConfig } from '../../src/config.js'
import { createApp } from '../../src/app.js'

const config = readConfig()
const databaseName = new URL(process.env.DATABASE_URL || '').pathname.slice(1)
if (config.nodeEnv !== 'test' || !databaseName.endsWith('_test') || !process.send) {
  throw new Error('Purchase archive crash fixture requires an isolated _test database and IPC')
}

const target = process.env.PURCHASE_ARCHIVE_CRASH_CHECKPOINT
let checkpointReached = false
async function checkpoint(name: string): Promise<void> {
  if (target !== name || checkpointReached) return
  checkpointReached = true
  process.send!({ checkpoint: name, pid: process.pid })
  await new Promise<void>(() => undefined)
}

if (target === 'archive_partial_copy') {
  const handle = await open('/dev/null', 'r')
  const prototype = Object.getPrototypeOf(handle) as { writeFile: (...args: unknown[]) => Promise<void> }
  await handle.close()
  const originalWriteFile = prototype.writeFile
  let split = false
  prototype.writeFile = async function (data: unknown, ...options: unknown[]) {
    if (!split && Buffer.isBuffer(data) && data.length > 1) {
      split = true
      const boundary = Math.max(1, Math.floor(data.length / 2))
      await originalWriteFile.call(this, data.subarray(0, boundary), ...options)
      await checkpoint('archive_partial_copy')
      return
    }
    return await originalWriteFile.call(this, data, ...options)
  }
}

const pool = new Pool({ ...config.database, max: 1, application_name: 'aikayun-purchase-archive-crash-' + process.pid })
pool.on('connect', (client: PoolClient) => {
  const original = client.query.bind(client)
  let checkoutWrites = false
  client.query = (async (queryText: string, values?: unknown[]) => {
    const text = queryText.toLowerCase().trim()
    if (text.startsWith('insert into "orders"') || text.startsWith('insert into orders')
      || text.startsWith('insert into "order_item_purchase_snapshots"')
      || text.startsWith('insert into order_item_purchase_snapshots')
      || text.startsWith('insert into "order_item_purchase_attachments"')
      || text.startsWith('insert into order_item_purchase_attachments')) checkoutWrites = true
    const result = await original(queryText, values)
    if ((text.startsWith('insert into "purchase_order_attachment_objects"')
      || text.startsWith('insert into purchase_order_attachment_objects')) && target === 'archive_object_registered') {
      await checkpoint('archive_object_registered')
    }
    if ((text.startsWith('insert into "order_item_purchase_attachments"')
      || text.startsWith('insert into order_item_purchase_attachments')) && target === 'attachment_binding_uncommitted') {
      await checkpoint('attachment_binding_uncommitted')
    }
    if (text === 'commit' && checkoutWrites && target === 'checkout_committed') {
      await checkpoint('checkout_committed')
    }
    if (text === 'commit') checkoutWrites = false
    return result
  }) as typeof client.query
})

const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
const app = await createApp({ db, config, logger: false })
await app.listen({ host: '127.0.0.1', port: 0 })
process.send!({ ready: { url: app.listeningOrigin, pid: process.pid, backendPid: backend.rows[0]!.pid } })

async function stop(): Promise<void> {
  await app.close().catch(() => undefined)
  await db.destroy().catch(() => undefined)
  process.disconnect?.()
}
process.once('message', message => {
  if (message === 'stop') void stop()
})
