// Test-only worker. It uses the production procurement transactions with a real
// PostgreSQL pool and a separate, persistent HTTP supplier fixture.
import { Pool, type PoolClient } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Database } from '../../src/db/types.js'
import { readConfig } from '../../src/config.js'
import { prepareProcurementWithRisk, runProcurementFixturePass } from '../../src/commerce/procurement-executor.js'
import { finalizeProcurementUnit } from '../../src/commerce/procurement-finalization.js'

const config = readConfig()
const databaseName = new URL(process.env.DATABASE_URL || '').pathname.slice(1)
if (config.nodeEnv !== 'test' || !databaseName.endsWith('_test') || !process.send) {
  throw new Error('Procurement crash fixtures require an isolated _test database and IPC')
}

const requestedCheckpoint = process.env.PROCUREMENT_CRASH_CHECKPOINT
let checkpointReached = false
async function checkpoint(name: string): Promise<void> {
  if (requestedCheckpoint !== name || checkpointReached) return
  checkpointReached = true
  process.send!({ checkpoint: name, pid: process.pid })
  await new Promise<void>(() => undefined)
}

const pool = new Pool({ ...config.database, max: 1, application_name: 'aikayun-procurement-crash-' + process.pid })
pool.on('connect', (client: PoolClient) => {
  const original = client.query.bind(client)
  let preparationWrites = false
  let submitIntent = false
  let evidenceWritten = false
  let deliveryWritten = false
  let unitCompleted = false
  client.query = (async (queryText: string, values?: unknown[]) => {
    const text = queryText.toLowerCase().trim()
    if (text.startsWith('insert into "procurement_operations"') || text.startsWith('insert into procurement_operations')
      || text.startsWith('insert into "procurement_risk_reservations"') || text.startsWith('insert into procurement_risk_reservations')
      || text.startsWith('insert into "procurement_preparation_requests"') || text.startsWith('insert into procurement_preparation_requests')) {
      preparationWrites = true
    }
    if (text.startsWith('insert into "procurement_request_intents"') || text.startsWith('insert into procurement_request_intents')) submitIntent = true
    if (text.startsWith('insert into "procurement_execution_evidence"') || text.startsWith('insert into procurement_execution_evidence')) evidenceWritten = true
    if (text.startsWith('insert into "order_item_fulfillment_deliveries"') || text.startsWith('insert into order_item_fulfillment_deliveries')) deliveryWritten = true
    if (text.startsWith('update "procurement_operation_units"') && values?.includes('completed')) unitCompleted = true

    if (text === 'commit' && requestedCheckpoint === 'preparation_uncommitted' && preparationWrites) {
      await checkpoint('preparation_uncommitted')
    }
    const result = await original(queryText, values)
    if ((text.startsWith('insert into "procurement_execution_evidence"') || text.startsWith('insert into procurement_execution_evidence'))
      && requestedCheckpoint === 'evidence_uncommitted') {
      await checkpoint('evidence_uncommitted')
    }
    if ((text.startsWith('insert into "order_item_fulfillment_deliveries"') || text.startsWith('insert into order_item_fulfillment_deliveries'))
      && requestedCheckpoint === 'delivery_uncommitted') {
      await checkpoint('delivery_uncommitted')
    }
    if (text === 'commit') {
      if (preparationWrites && requestedCheckpoint === 'preparation_committed') await checkpoint('preparation_committed')
      if (submitIntent && requestedCheckpoint === 'intent_committed') await checkpoint('intent_committed')
      if (evidenceWritten && requestedCheckpoint === 'evidence_committed') await checkpoint('evidence_committed')
      if ((deliveryWritten || unitCompleted) && requestedCheckpoint === 'finalization_committed') {
        await checkpoint('finalization_committed')
      }
      preparationWrites = false
      submitIntent = false
      evidenceWritten = false
      deliveryWritten = false
      unitCompleted = false
    }
    return result
  }) as typeof client.query
})

const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
process.send!({ ready: { pid: process.pid, backendPid: backend.rows[0]!.pid } })

process.on('message', async (message) => {
  if (!message || typeof message !== 'object' || !('action' in message)) return
  try {
    const command = message as Record<string, unknown>
    if (command.action === 'prepare') {
      const result = await db.transaction().execute(trx => prepareProcurementWithRisk(trx, command.input as {
        requestId: string; orderId: string; orderItemId: string; unitIndices: number[]; currency: string; maxAmountMinor: string
      }))
      process.send!({ done: command.action, result })
    } else if (command.action === 'pass') {
      const operationId = String(command.operationId)
      const fixtureUrl = String(command.fixtureUrl)
      const completed = await runProcurementFixturePass(db, operationId, async request => {
        await checkpoint('intent_committed')
        const response = await fetch(fixtureUrl + '/' + request.action, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
        if (!response.ok) throw new Error('Controlled supplier fixture returned HTTP ' + response.status)
        const result = await response.json() as Parameters<Parameters<typeof runProcurementFixturePass>[2]>[0]
        await checkpoint('response_parsed')
        return result
      }, async () => true, Number(command.leaseMs ?? 1_000), Number(command.requestTimeoutMs ?? 900))
      await checkpoint('evidence_committed')
      process.send!({ done: command.action, result: completed })
    } else if (command.action === 'finalize') {
      const result = await finalizeProcurementUnit(db, String(command.operationId), Number(command.unitIndex))
      await checkpoint('finalization_committed')
      process.send!({ done: command.action, result })
    } else if (command.action === 'identity') {
      const result = await sql<{ operation_id: string; state: string; business_number: string; backend_pid: number }>`
        SELECT operation.id AS operation_id, operation.state, operation.local_business_number AS business_number,
          pg_backend_pid() AS backend_pid FROM procurement_operations operation WHERE operation.id=${String(command.operationId)}::uuid
      `.execute(db)
      process.send!({ done: command.action, result: result.rows[0] ?? null })
    } else {
      throw new Error('Unknown procurement crash fixture action')
    }
  } catch (error) {
    process.send!({ failed: error instanceof Error ? error.stack || error.message : String(error) })
  } finally {
    await db.destroy().catch(() => undefined)
    process.disconnect?.()
  }
})
