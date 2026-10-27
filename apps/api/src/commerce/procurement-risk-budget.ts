import { sql, type Transaction } from 'kysely'
import type { Database } from '../db/types.js'

/** These are fixture inputs, never prices or supplier quotes. TST is not a real currency. */
export type SyntheticProcurementRiskLimits = {
  perOperationMinor: string
  globalDailyMinor: string
  globalOutstandingMinor: string
  supplierDailyMinor: string
  supplierOutstandingMinor: string
  skuDailyMinor: string
  skuOutstandingMinor: string
}

export type ProcurementRisk = {
  operationId: string
  currency: string
  reservedMinor: string
  debitMinor: string
  releasedMinor: string
  outstandingMinor: string
}

export class ProcurementRiskError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProcurementRiskError' }
}

function amount(value: string, allowZero = false): string {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || (!allowZero && value === '0')) {
    throw new ProcurementRiskError('invalid_amount')
  }
  return value
}

function syntheticCurrency(currency: string): void {
  if (currency !== 'TST') throw new ProcurementRiskError('synthetic_currency_required')
}

/** Immutable limits are installed once; later callers cannot silently raise them. */
export async function initializeSyntheticProcurementRiskPolicy(
  trx: Transaction<Database>, input: { currency: string; limits: SyntheticProcurementRiskLimits },
): Promise<void> {
  syntheticCurrency(input.currency)
  const l = input.limits
  const values = [amount(l.perOperationMinor), amount(l.globalDailyMinor, true), amount(l.globalOutstandingMinor, true),
    amount(l.supplierDailyMinor, true), amount(l.supplierOutstandingMinor, true),
    amount(l.skuDailyMinor, true), amount(l.skuOutstandingMinor, true)]
  await sql`INSERT INTO procurement_risk_policies (currency, per_operation_minor, global_daily_minor,
    global_outstanding_minor, supplier_daily_minor, supplier_outstanding_minor, sku_daily_minor, sku_outstanding_minor)
    VALUES (${input.currency}, ${values[0]}::numeric, ${values[1]}::numeric, ${values[2]}::numeric,
      ${values[3]}::numeric, ${values[4]}::numeric, ${values[5]}::numeric, ${values[6]}::numeric)
    ON CONFLICT (currency) DO NOTHING`.execute(trx)
  const result = await sql<{ identical: boolean }>`SELECT ROW(per_operation_minor, global_daily_minor,
    global_outstanding_minor, supplier_daily_minor, supplier_outstanding_minor, sku_daily_minor, sku_outstanding_minor)
    = ROW(${values[0]}::numeric, ${values[1]}::numeric, ${values[2]}::numeric, ${values[3]}::numeric,
      ${values[4]}::numeric, ${values[5]}::numeric, ${values[6]}::numeric) AS identical
    FROM procurement_risk_policies WHERE currency = ${input.currency} FOR UPDATE`.execute(trx)
  if (!result.rows[0]?.identical) throw new ProcurementRiskError('policy_mismatch')
}

export async function setSyntheticProcurementRiskPause(
  trx: Transaction<Database>, input: { currency: string; paused: boolean },
): Promise<void> {
  syntheticCurrency(input.currency)
  const updated = await sql`UPDATE procurement_risk_policies SET paused = ${input.paused}
    WHERE currency = ${input.currency}`.execute(trx)
  if (updated.numAffectedRows !== 1n) throw new ProcurementRiskError('policy_missing')
}

/** Read-only; caller holds the order lock when using this to make a decision. */
export async function readProcurementRisk(trx: Transaction<Database>, operationId: string): Promise<ProcurementRisk | null> {
  const result = await sql<{ operation_id: string; currency: string; reserved_minor: string;
    debit_minor: string; released_minor: string; outstanding_minor: string }>`
    SELECT r.operation_id, r.currency, r.amount_minor::text AS reserved_minor,
      COALESCE(sum(e.amount_minor) FILTER (WHERE e.kind = 'debit'), 0)::text AS debit_minor,
      COALESCE(sum(e.amount_minor) FILTER (WHERE e.kind = 'release'), 0)::text AS released_minor,
      (r.amount_minor - COALESCE(sum(e.amount_minor) FILTER (WHERE e.kind IN ('debit', 'release')), 0)
        + COALESCE(sum(e.amount_minor) FILTER (WHERE e.kind = 'reinstate'), 0))::text AS outstanding_minor
    FROM procurement_risk_reservations r LEFT JOIN procurement_risk_events e ON e.operation_id = r.operation_id
    WHERE r.operation_id = ${operationId}::uuid GROUP BY r.operation_id, r.currency, r.amount_minor`.execute(trx)
  const row = result.rows[0]
  return row ? { operationId: row.operation_id, currency: row.currency, reservedMinor: row.reserved_minor,
    debitMinor: row.debit_minor, releasedMinor: row.released_minor, outstandingMinor: row.outstanding_minor } : null
}

/** Must run in the transaction which inserted this operation and sealed its units. */
export async function reserveProcurementRisk(trx: Transaction<Database>, input: {
  operationId: string; currency: string; maxAmountMinor: string; utcDay?: string
}): Promise<ProcurementRisk> {
  syntheticCurrency(input.currency)
  amount(input.maxAmountMinor)
  if (input.utcDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.utcDay)) throw new ProcurementRiskError('invalid_day')
  const existing = await readProcurementRisk(trx, input.operationId)
  if (existing) {
    if (existing.currency !== input.currency || existing.reservedMinor !== input.maxAmountMinor) {
      throw new ProcurementRiskError('reservation_mismatch')
    }
    return existing
  }
  const created = await sql`INSERT INTO procurement_risk_reservations
    (operation_id, supplier_connection_id, product_variant_id, currency, amount_minor, utc_day)
    SELECT o.id, s.supplier_connection_id, s.product_variant_id, ${input.currency}, ${input.maxAmountMinor}::numeric,
      COALESCE(${input.utcDay ?? null}::date, (clock_timestamp() AT TIME ZONE 'UTC')::date)
    FROM procurement_operations o JOIN order_item_procurement_sources s ON s.id = o.source_id
    WHERE o.id = ${input.operationId}::uuid`.execute(trx)
  if (created.numAffectedRows !== 1n) throw new ProcurementRiskError('operation_missing')
  return (await readProcurementRisk(trx, input.operationId))!
}

/** Serialize all evidence with settlement, including after pause or full settlement. */
export async function lockProcurementRiskPolicy(trx: Transaction<Database>, operationId: string): Promise<void> {
  const result = await sql`SELECT p.currency FROM procurement_risk_policies p
    JOIN procurement_risk_reservations r ON r.currency = p.currency
    WHERE r.operation_id = ${operationId}::uuid FOR UPDATE OF p`.execute(trx)
  if (!result.rows.length) throw new ProcurementRiskError('reservation_missing')
}

/** Acquire policy first, before the operation and unit locks, and hold until send intent commits. */
export async function assertProcurementRiskSendAllowed(trx: Transaction<Database>, operationId: string): Promise<ProcurementRisk> {
  const policy = await sql<{ paused: boolean }>`SELECT p.paused FROM procurement_risk_policies p
    JOIN procurement_risk_reservations r ON r.currency = p.currency
    WHERE r.operation_id = ${operationId}::uuid FOR UPDATE OF p`.execute(trx)
  if (!policy.rows[0]) throw new ProcurementRiskError('reservation_missing')
  if (policy.rows[0].paused) throw new ProcurementRiskError('paused')
  const risk = await readProcurementRisk(trx, operationId)
  if (!risk || BigInt(risk.outstandingMinor) <= 0n) throw new ProcurementRiskError('exposure_missing')
  return risk
}

/** Only reliable evidence can settle exposure. The evidence trigger is installed by execution migration. */
export async function recordProcurementRiskFact(trx: Transaction<Database>, input: {
  operationId: string; factId: string; kind: 'debit' | 'release'; amountMinor: string; evidenceId: string
}): Promise<ProcurementRisk> {
  amount(input.amountMinor)
  const policy = await sql<{ currency: string }>`SELECT p.currency FROM procurement_risk_policies p
    JOIN procurement_risk_reservations r ON r.currency = p.currency WHERE r.operation_id = ${input.operationId}::uuid
    FOR UPDATE OF p`.execute(trx)
  if (!policy.rows[0]) throw new ProcurementRiskError('reservation_missing')
  const existing = await sql<{ operation_id: string; kind: string; amount_minor: string; evidence_id: string }>`
    SELECT operation_id, kind, amount_minor::text, evidence_id FROM procurement_risk_events WHERE id = ${input.factId}::uuid`.execute(trx)
  if (existing.rows[0]) {
    const row = existing.rows[0]
    if (row.operation_id !== input.operationId || row.kind !== input.kind || row.amount_minor !== input.amountMinor
      || row.evidence_id !== input.evidenceId) throw new ProcurementRiskError('fact_mismatch')
  } else {
    await sql`INSERT INTO procurement_risk_events (id, operation_id, currency, kind, amount_minor, evidence_id)
      VALUES (${input.factId}::uuid, ${input.operationId}::uuid, ${policy.rows[0].currency}, ${input.kind},
        ${input.amountMinor}::numeric, ${input.evidenceId}::uuid)`.execute(trx)
  }
  return (await readProcurementRisk(trx, input.operationId))!
}
