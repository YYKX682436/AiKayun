import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely, type Transaction } from 'kysely'
import { createDatabase } from '../src/db/pool.js'
import type { Database } from '../src/db/types.js'
import { procurementRiskBudgetMigration } from '../src/db/migrations/202610270004_procurement_risk_budget.js'
import { assertProcurementRiskSendAllowed, initializeSyntheticProcurementRiskPolicy, readProcurementRisk,
  recordProcurementRiskFact, reserveProcurementRisk, setSyntheticProcurementRiskPause } from '../src/commerce/procurement-risk-budget.js'

// A deliberately minimal schema isolates the migration's PostgreSQL locking and accounting
// behavior. End-to-end order and fulfillment checks use the full application fixture.
const databaseUrl = process.env.TEST_DATABASE_URL
let db: Kysely<Database>
let releasedOperation = '', activeOperation = ''
const supplier = randomUUID(), sku = randomUUID(), source = randomUUID()
const limits = { perOperationMinor: '80', globalDailyMinor: '100', globalOutstandingMinor: '100',
  supplierDailyMinor: '100', supplierOutstandingMinor: '100', skuDailyMinor: '100', skuOutstandingMinor: '100' }
async function identity(trx: Transaction<Database>): Promise<string> {
  const id = randomUUID()
  await sql`INSERT INTO procurement_operations(id,source_id,state,allocations_sealed)
    VALUES (${id}::uuid, ${source}::uuid, 'prepared', true)`.execute(trx)
  await sql`INSERT INTO procurement_operation_events(operation_id,revision) VALUES (${id}::uuid, 0)`.execute(trx)
  return id
}

beforeAll(async () => {
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Requires isolated _test database')
  process.env.DATABASE_URL = databaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  await sql`CREATE TABLE supplier_connections(id uuid PRIMARY KEY)`.execute(db)
  await sql`CREATE TABLE product_variants(id uuid PRIMARY KEY)`.execute(db)
  await sql`CREATE TABLE order_item_procurement_sources(id uuid PRIMARY KEY, supplier_connection_id uuid NOT NULL, product_variant_id uuid NOT NULL)`.execute(db)
  await sql`CREATE TABLE procurement_operations(id uuid PRIMARY KEY, source_id uuid NOT NULL, state text NOT NULL, allocations_sealed boolean NOT NULL, revision integer NOT NULL DEFAULT 0)`.execute(db)
  await sql`CREATE TABLE procurement_operation_events(operation_id uuid NOT NULL, revision integer NOT NULL, previous_state text, next_state text, UNIQUE(operation_id, revision))`.execute(db)
  await sql`CREATE TABLE procurement_operation_units(operation_id uuid NOT NULL, unit_index integer NOT NULL, PRIMARY KEY(operation_id,unit_index))`.execute(db)
  await sql`CREATE FUNCTION protect_order_purchase_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$`.execute(db)
  await procurementRiskBudgetMigration.up(db)
  await sql`CREATE TABLE procurement_execution_evidence(id uuid PRIMARY KEY, operation_id uuid NOT NULL, kind text NOT NULL, amount_minor numeric(20,0), currency text, unit_indices integer[] NOT NULL DEFAULT '{}')`.execute(db)
  await sql`CREATE FUNCTION test_note_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM procurement_risk_note_from_evidence(NEW.id); PERFORM procurement_risk_note_from_evidence(NEW.id); RETURN NEW; END $$`.execute(db)
  await sql`CREATE TRIGGER test_note_evidence AFTER INSERT ON procurement_execution_evidence FOR EACH ROW EXECUTE FUNCTION test_note_evidence()`.execute(db)
  await sql`CREATE FUNCTION test_note_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM procurement_risk_note_from_review(NEW.operation_id, NEW.revision);
    PERFORM procurement_risk_note_from_review(NEW.operation_id, NEW.revision); RETURN NEW; END $$`.execute(db)
  await sql`CREATE TRIGGER test_note_review AFTER INSERT ON procurement_operation_events FOR EACH ROW EXECUTE FUNCTION test_note_review()`.execute(db)
  await sql`CREATE FUNCTION test_append_operation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO procurement_operation_events(operation_id, revision, previous_state, next_state)
      VALUES (NEW.id, NEW.revision, OLD.state, NEW.state); RETURN NEW; END $$`.execute(db)
  await sql`CREATE TRIGGER test_append_operation_event AFTER UPDATE ON procurement_operations FOR EACH ROW EXECUTE FUNCTION test_append_operation_event()`.execute(db)
  await sql`INSERT INTO supplier_connections VALUES (${supplier}::uuid)`.execute(db)
  await sql`INSERT INTO product_variants VALUES (${sku}::uuid)`.execute(db)
  await sql`INSERT INTO order_item_procurement_sources VALUES (${source}::uuid, ${supplier}::uuid, ${sku}::uuid)`.execute(db)
  await db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, { currency: 'TST', limits }))
})
afterAll(async () => { if (db) await db.destroy() })

describe('synthetic procurement risk ledger', () => {
  it('reserves atomically, holds exposure across days, settles only with matching evidence and never refunds daily gross', async () => {
    let operationId = ''
    const risk = await db.transaction().execute(async trx => {
      operationId = await identity(trx)
      return reserveProcurementRisk(trx, { operationId, currency: 'TST', maxAmountMinor: '60', utcDay: '2026-01-01' })
    })
    releasedOperation = operationId
    expect(risk).toMatchObject({ reservedMinor: '60', outstandingMinor: '60' })
    await expect(db.transaction().execute(async trx => {
      const id = await identity(trx)
      await reserveProcurementRisk(trx, { operationId: id, currency: 'TST', maxAmountMinor: '50', utcDay: '2026-01-02' })
    })).rejects.toThrow('Risk budget exceeded')
    const evidence = randomUUID(), fact = randomUUID()
    await expect(db.transaction().execute(trx => recordProcurementRiskFact(trx, {
      operationId, factId: fact, kind: 'release', amountMinor: '60', evidenceId: evidence,
    }))).rejects.toThrow('matching execution evidence')
    await db.transaction().execute(async trx => {
      await sql`INSERT INTO procurement_execution_evidence(id,operation_id,kind,amount_minor,currency) VALUES (${evidence}::uuid, ${operationId}::uuid, 'rejected', 60, 'TST')`.execute(trx)
      const first = await recordProcurementRiskFact(trx, { operationId, factId: fact, kind: 'release', amountMinor: '60', evidenceId: evidence })
      expect(first.outstandingMinor).toBe('0')
      expect(await recordProcurementRiskFact(trx, { operationId, factId: fact, kind: 'release', amountMinor: '60', evidenceId: evidence })).toEqual(first)
    })
    await expect(db.transaction().execute(async trx => {
      const id = await identity(trx)
      await reserveProcurementRisk(trx, { operationId: id, currency: 'TST', maxAmountMinor: '50', utcDay: '2026-01-01' })
    })).rejects.toThrow('Risk budget exceeded')
    await db.transaction().execute(async trx => {
      const id = await identity(trx)
      activeOperation = id
      expect((await reserveProcurementRisk(trx, { operationId: id, currency: 'TST', maxAmountMinor: '80', utcDay: '2026-01-02' })).outstandingMinor).toBe('80')
    })
    const historical = await db.transaction().execute(identity)
    await expect(db.transaction().execute(trx => reserveProcurementRisk(trx, { operationId: historical, currency: 'TST', maxAmountMinor: '1' }))).rejects.toThrow('accompany new prepared identity')
    expect(await db.transaction().execute(trx => readProcurementRisk(trx, historical))).toBeNull()
  })

  it('persists limits and pause and prevents unbudgeted sends', async () => {
    await expect(db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, {
      currency: 'TST', limits: { ...limits, globalOutstandingMinor: '999' },
    }))).rejects.toThrow('policy_mismatch')
    await expect(db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, {
      currency: 'CNY', limits,
    }))).rejects.toThrow('synthetic_currency_required')
    await db.transaction().execute(trx => setSyntheticProcurementRiskPause(trx, { currency: 'TST', paused: true }))
    await expect(db.transaction().execute(async trx => {
      const id = await identity(trx)
      await reserveProcurementRisk(trx, { operationId: id, currency: 'TST', maxAmountMinor: '1' })
    })).rejects.toThrow('paused')
    const historical = await db.transaction().execute(identity)
    await expect(db.transaction().execute(trx => assertProcurementRiskSendAllowed(trx, historical))).rejects.toThrow('reservation_missing')
    await db.transaction().execute(trx => setSyntheticProcurementRiskPause(trx, { currency: 'TST', paused: false }))
  })

  it('serializes concurrent reservations across database connections without exceeding exposure', async () => {
    let unblock!: () => void, ready!: (pid: number) => void, secondReady!: (pid: number) => void
    const release = new Promise<void>(resolve => { unblock = resolve })
    const firstReady = new Promise<number>(resolve => { ready = resolve })
    const otherReady = new Promise<number>(resolve => { secondReady = resolve })
    const first = db.transaction().execute(async trx => {
      const pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
      const id = await identity(trx)
      await reserveProcurementRisk(trx, { operationId: id, currency: 'TST', maxAmountMinor: '15', utcDay: '2026-01-03' })
      ready(pid)
      await release
    })
    const firstPid = await firstReady
    const second = db.transaction().execute(async trx => {
      const pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
      const id = await identity(trx)
      secondReady(pid)
      await reserveProcurementRisk(trx, { operationId: id, currency: 'TST', maxAmountMinor: '15', utcDay: '2026-01-03' })
    }).then(() => null, error => error as Error)
    const secondPid = await otherReady
    let blocked = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !blocked) {
      const result = await sql<{ blocked: boolean }>`SELECT ${firstPid} = ANY(pg_blocking_pids(${secondPid})) AS blocked`.execute(db)
      blocked = result.rows[0]!.blocked
      if (!blocked) await new Promise<void>(resolve => setImmediate(resolve))
    }
    unblock()
    await first
    const rejected = await second
    expect(blocked).toBe(true)
    expect(rejected?.message).toContain('Risk budget exceeded')
    const remaining = await sql<{ outstanding_minor: string }>`SELECT outstanding_minor::text
      FROM procurement_risk_buckets WHERE currency = 'TST' AND scope_kind = 'global' AND scope_key = '*'`.execute(db)
    expect(remaining.rows[0]!.outstanding_minor).toBe('95')
  })

  it('reinstates released risk for late contradictory evidence even above the cap and prevents direct counter writes', async () => {
    const evidence = randomUUID()
    await db.transaction().execute(async trx => {
      await sql`INSERT INTO procurement_execution_evidence(id, operation_id, kind) VALUES (${evidence}::uuid, ${releasedOperation}::uuid, 'success')`.execute(trx)
      await sql`SELECT procurement_risk_reinstate_from_evidence(${evidence}::uuid)`.execute(trx)
      await sql`SELECT procurement_risk_reinstate_from_evidence(${evidence}::uuid)`.execute(trx)
      expect((await readProcurementRisk(trx, releasedOperation))!.outstandingMinor).toBe('60')
    })
    const total = await sql<{ amount: string }>`SELECT outstanding_minor::text AS amount FROM procurement_risk_buckets
      WHERE currency = 'TST' AND scope_kind = 'global' AND scope_key = '*'`.execute(db)
    expect(total.rows[0]!.amount).toBe('155')
    await expect(sql`UPDATE procurement_risk_buckets SET outstanding_minor = 0`.execute(db)).rejects.toThrow('ledger triggers')
    await expect(sql`UPDATE procurement_risk_daily SET gross_minor = 0`.execute(db)).rejects.toThrow('ledger triggers')
    await expect(sql`DELETE FROM procurement_risk_buckets`.execute(db)).rejects.toThrow('ledger triggers')
    await expect(sql`TRUNCATE procurement_risk_daily`.execute(db)).rejects.toThrow()
  })

  it('rejects full release after partial success and books only an explicitly confirmed debit', async () => {
    const successId = randomUUID(), rejectedId = randomUUID(), debitId = randomUUID(), debitFact = randomUUID()
    await db.transaction().execute(async trx => {
      await sql`INSERT INTO procurement_execution_evidence(id,operation_id,kind) VALUES (${successId}::uuid, ${activeOperation}::uuid, 'success')`.execute(trx)
      await sql`INSERT INTO procurement_execution_evidence(id,operation_id,kind,amount_minor,currency)
        VALUES (${rejectedId}::uuid, ${activeOperation}::uuid, 'rejected', 80, 'TST')`.execute(trx)
    })
    await expect(db.transaction().execute(trx => recordProcurementRiskFact(trx, {
      operationId: activeOperation, factId: randomUUID(), kind: 'release', amountMinor: '80', evidenceId: rejectedId,
    }))).rejects.toThrow('matching execution evidence')
    await db.transaction().execute(async trx => {
      await sql`INSERT INTO procurement_execution_evidence(id,operation_id,kind,amount_minor,currency)
        VALUES (${debitId}::uuid, ${activeOperation}::uuid, 'debit_confirmed', 20, 'TST')`.execute(trx)
      const risk = await recordProcurementRiskFact(trx, { operationId: activeOperation, factId: debitFact,
        kind: 'debit', amountMinor: '20', evidenceId: debitId })
      expect(risk).toMatchObject({ debitMinor: '20', releasedMinor: '0', outstandingMinor: '60' })
    })
    await expect(sql`UPDATE procurement_risk_events SET amount_minor = 1 WHERE id = ${debitFact}::uuid`.execute(db)).rejects.toThrow()
  })

  it('records partial success and manual review exactly once without changing outstanding risk', async () => {
    const evidenceId = randomUUID()
    const initial = await db.transaction().execute(trx => readProcurementRisk(trx, activeOperation))
    await sql`INSERT INTO procurement_operation_units VALUES (${activeOperation}::uuid, 1), (${activeOperation}::uuid, 2)`.execute(db)
    await sql`INSERT INTO procurement_execution_evidence(id,operation_id,kind,unit_indices)
      VALUES (${evidenceId}::uuid, ${activeOperation}::uuid, 'success', ARRAY[1])`.execute(db)
    await sql`UPDATE procurement_operations SET state='manual_review', revision=1 WHERE id=${activeOperation}::uuid`.execute(db)
    const facts = await sql<{ kind: string; amount: string; evidence_id: string | null; operation_revision: number | null }>`
      SELECT kind, amount_minor::text AS amount, evidence_id, operation_revision FROM procurement_risk_events
      WHERE operation_id=${activeOperation}::uuid AND kind IN ('partial','review') ORDER BY kind`.execute(db)
    expect(facts.rows).toEqual([
      { kind: 'partial', amount: '0', evidence_id: evidenceId, operation_revision: null },
      { kind: 'review', amount: '0', evidence_id: null, operation_revision: 1 },
    ])
    expect(await db.transaction().execute(trx => readProcurementRisk(trx, activeOperation))).toEqual(initial)
    await expect(sql`INSERT INTO procurement_risk_events(id,operation_id,currency,kind,amount_minor,evidence_id)
      VALUES (${randomUUID()}::uuid, ${activeOperation}::uuid, 'TST', 'partial', 0, ${evidenceId}::uuid)`.execute(db)).rejects.toThrow('requires execution evidence')
    await expect(sql`INSERT INTO procurement_risk_events(id,operation_id,currency,kind,amount_minor,operation_revision)
      VALUES (${randomUUID()}::uuid, ${activeOperation}::uuid, 'TST', 'review', 0, 1)`.execute(db)).rejects.toThrow('requires its operation transition')
    await expect(sql`UPDATE procurement_risk_events SET amount_minor=1 WHERE operation_id=${activeOperation}::uuid AND kind='review'`.execute(db)).rejects.toThrow()
  })

  it('rejects reversed direct SQL lock order without waiting for the policy holder', async () => {
    const evidence = randomUUID()
    await sql`INSERT INTO procurement_execution_evidence(id,operation_id,kind,amount_minor,currency)
      VALUES (${evidence}::uuid, ${activeOperation}::uuid, 'debit_confirmed', 1, 'TST')`.execute(db)
    let release!: () => void, ready!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const locked = new Promise<void>(resolve => { ready = resolve })
    const holder = db.transaction().execute(async trx => {
      await sql`SELECT currency FROM procurement_risk_policies WHERE currency='TST' FOR UPDATE`.execute(trx)
      ready()
      await gate
    })
    await locked
    try {
      await expect(db.transaction().execute(async trx => {
        await sql`SELECT id FROM procurement_operations WHERE id=${activeOperation}::uuid FOR UPDATE`.execute(trx)
        await sql`INSERT INTO procurement_risk_events(id,operation_id,currency,kind,amount_minor,evidence_id)
          VALUES (${randomUUID()}::uuid, ${activeOperation}::uuid, 'TST', 'debit', 1, ${evidence}::uuid)`.execute(trx)
      })).rejects.toThrow('could not obtain lock')
    } finally {
      release()
      await holder
    }
  })
})
