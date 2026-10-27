import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createDatabase } from '../src/db/pool.js'
import type { Database } from '../src/db/types.js'
import { procurementIdentityConflictGuardMigration } from '../src/db/migrations/202610270006_procurement_identity_conflict_guard.js'

// Minimal isolated pre-006 schema. Its only data models a historical risk
// release followed by an identity-conflict fact with no reinstatement. The
// full application migration and request flow are covered by the executor suite.
const testDatabaseUrl = process.env.TEST_DATABASE_URL
let db: Kysely<Database>
const operationId = randomUUID(), evidenceId = randomUUID()

beforeAll(async () => {
  if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.endsWith('_test')) {
    throw new Error('Requires an isolated PostgreSQL database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  await sql`CREATE TABLE procurement_execution_evidence(id uuid PRIMARY KEY, operation_id uuid NOT NULL, kind text NOT NULL, unit_indices integer[] NOT NULL DEFAULT '{}')`.execute(db)
  await sql`CREATE TABLE procurement_risk_events(operation_id uuid NOT NULL, kind text NOT NULL)`.execute(db)
  await sql`CREATE TABLE procurement_operation_units(operation_id uuid NOT NULL, order_item_id uuid NOT NULL, unit_index integer NOT NULL, state text NOT NULL)`.execute(db)
  await sql`CREATE TABLE procurement_operations(id uuid PRIMARY KEY, order_item_id uuid, state text NOT NULL)`.execute(db)
  await sql`CREATE TABLE order_items(id uuid PRIMARY KEY, order_id uuid, fulfillment_reserved_quantity integer NOT NULL DEFAULT 0)`.execute(db)
  await sql`CREATE TABLE order_item_fulfillment_attempts(order_item_id uuid, status text)`.execute(db)
  // The migration modifies real function definitions in place; these stubs
  // preserve precisely the old kind-list anchors that it must find.
  await sql`CREATE FUNCTION procurement_risk_apply_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    EXECUTE 'SELECT ''success'', ''debit_confirmed'''; RETURN NEW; END $$`.execute(db)
  await sql`CREATE FUNCTION procurement_risk_reinstate_from_evidence(evidence_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    IF 'success' IN ('success', 'debit_confirmed') THEN RETURN; END IF; END $$`.execute(db)
  await sql`CREATE FUNCTION procurement_evidence_restore_risk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.kind IN ('success','debit_confirmed') THEN RETURN NEW; END IF; RETURN NEW; END $$`.execute(db)
  await sql`INSERT INTO procurement_execution_evidence(id, operation_id, kind) VALUES (${evidenceId}::uuid, ${operationId}::uuid, 'identity_conflict')`.execute(db)
  await sql`INSERT INTO procurement_risk_events VALUES (${operationId}::uuid, 'release')`.execute(db)
})

afterAll(async () => { if (db) await db.destroy() })

it('rejects upgrading an unreinstated historical conflict and rolls back without altering existing facts', async () => {
  await expect(db.transaction().execute(trx => procurementIdentityConflictGuardMigration.up(trx)))
    .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('Unreconciled historical identity conflict') })
  const evidence = await sql<{ id: string; kind: string }>`SELECT id,kind FROM procurement_execution_evidence`.execute(db)
  const risk = await sql<{ operation_id: string; kind: string }>`SELECT operation_id,kind FROM procurement_risk_events`.execute(db)
  expect(evidence.rows).toEqual([{ id: evidenceId, kind: 'identity_conflict' }])
  expect(risk.rows).toEqual([{ operation_id: operationId, kind: 'release' }])
  const rolledBack = await sql<{ name: string | null }>`SELECT to_regprocedure('procurement_has_identity_conflict(uuid)')::text AS name`.execute(db)
  expect(rolledBack.rows[0]!.name).toBeNull()
})
