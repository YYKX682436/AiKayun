import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../db/types.js'
import { allocateProcurementIdentity, procurementPreparationEligibility } from './procurement-identity.js'
import { assertProcurementRiskSendAllowed, lockProcurementRiskPolicy, ProcurementRiskError, readProcurementRisk, reserveProcurementRisk } from './procurement-risk-budget.js'

/** Internal protocol for a controlled fixture. There is no production transport or scheduler. */
export type ProcurementFixtureRequest = {
  operationId: string
  requestIdentity: string
  generation: number
  action: 'submit' | 'query'
  supplierOrderNumber: string | null
}
export type ProcurementFixtureResult = {
  requestIdentity: string
  kind: 'accepted' | 'pending' | 'success' | 'rejected' | 'unknown' | 'not_found'
  supplierOrderNumber: string | null
  unitIndices?: number[]
  deliveryConfirmed?: boolean
  responseDigest: string
}
export type ProcurementFixtureTransport = (request: ProcurementFixtureRequest) => Promise<ProcurementFixtureResult>
export type ProcurementFixtureSource = { supplierConnectionId: string; connectionVersionId: string; credentialVersion: number; credentialKeyId: string }
export type ProcurementFixtureSourceResolver = (source: ProcurementFixtureSource) => Promise<boolean>

type Operation = {
  id: string; order_id: string; order_item_id: string; local_business_number: string
  supplier_connection_id: string; state: string; supplier_order_number: string | null
}
type Lease = { lease_token: string | null; lease_expires_at: Date | null; request_generation: string | number; next_action_at: Date | null }
type Claim = ProcurementFixtureRequest & { token: string }

async function operationRow(trx: Transaction<Database>, id: string): Promise<Operation | undefined> {
  return (await sql<Operation>`SELECT p.id, s.order_id, p.order_item_id, p.local_business_number,
      s.supplier_connection_id, p.state, p.supplier_order_number
    FROM procurement_operations p JOIN order_item_procurement_sources s ON s.id = p.source_id
    WHERE p.id = ${id}::uuid`.execute(trx)).rows[0]
}

/** Identity and risk reservation are committed together; historical unbudgeted identities stay blocked. */
export async function prepareProcurementWithRisk(
  trx: Transaction<Database>, input: { requestId: string; orderId: string; orderItemId: string; unitIndices: readonly number[]; currency: string; maxAmountMinor: string },
): Promise<{ id: string; localBusinessNumber: string; repeated: boolean }> {
  const indexes = [...input.unitIndices].sort((a, b) => a - b)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)
    || !indexes.length || indexes.some((n, i) => !Number.isSafeInteger(n) || n < 1 || (i > 0 && indexes[i - 1] === n))) {
    throw new Error('Invalid procurement preparation identity')
  }
  await sql`SELECT id FROM orders WHERE id=${input.orderId}::uuid FOR UPDATE`.execute(trx)
  await sql`SELECT id FROM order_items WHERE id=${input.orderItemId}::uuid FOR UPDATE`.execute(trx)
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'procurement-preparation:' + input.requestId.toLowerCase()},0))`.execute(trx)
  const previous = (await sql<{ operation_id: string; order_id: string; order_item_id: string; unit_indices: number[];
    currency: string; max_amount_minor: string; local_business_number: string }>`
    SELECT r.operation_id,r.order_id,r.order_item_id,r.unit_indices,r.currency,r.max_amount_minor::text,
      o.local_business_number FROM procurement_preparation_requests r JOIN procurement_operations o ON o.id=r.operation_id
    WHERE r.request_id=${input.requestId}::uuid`.execute(trx)).rows[0]
  if (previous) {
    if (previous.order_id !== input.orderId || previous.order_item_id !== input.orderItemId
      || previous.currency !== input.currency || previous.max_amount_minor !== input.maxAmountMinor
      || previous.unit_indices.length !== indexes.length || previous.unit_indices.some((n, i) => n !== indexes[i])) {
      throw new Error('Procurement preparation identity mismatch')
    }
    return { id: previous.operation_id, localBusinessNumber: previous.local_business_number, repeated: true }
  }
  const operation = await allocateProcurementIdentity(trx, input.orderId, input.orderItemId, indexes)
  if (operation.repeated) throw new Error('Procurement units already have another preparation identity')
  await reserveProcurementRisk(trx, { operationId: operation.id, currency: input.currency, maxAmountMinor: input.maxAmountMinor })
  await sql`INSERT INTO procurement_preparation_requests(request_id,operation_id,order_id,order_item_id,unit_indices,currency,max_amount_minor)
    VALUES (${input.requestId}::uuid,${operation.id}::uuid,${input.orderId}::uuid,${input.orderItemId}::uuid,
      ${indexes}::integer[],${input.currency},${input.maxAmountMinor}::numeric)`.execute(trx)
  return operation
}

/** Candidate reads do not lock the operation: the order is always locked first. */
async function claim(db: Kysely<Database>, id: string, leaseMs: number): Promise<Claim | undefined> {
  return db.transaction().execute(async trx => {
    const initial = await operationRow(trx, id)
    if (!initial) return undefined
    await sql`SELECT id FROM orders WHERE id = ${initial.order_id}::uuid FOR UPDATE`.execute(trx)
    await sql`SELECT id FROM order_items WHERE id = ${initial.order_item_id}::uuid FOR UPDATE`.execute(trx)
    const current = await operationRow(trx, id)
    if (!current || !['prepared', 'submit_in_flight', 'accepted_pending', 'unknown', 'success_pending_finalize'].includes(current.state)) return undefined
    if (current.state === 'prepared') {
      const conflict = await sql<{ exists: boolean }>`SELECT procurement_unit_has_prior_execution(${id}::uuid) AS exists`.execute(trx)
      if (conflict.rows[0]!.exists) {
        await sql`UPDATE procurement_operations SET state='manual_review',revision=revision+1 WHERE id=${id}::uuid`.execute(trx)
        await sql`UPDATE procurement_operation_units SET state='manual_review' WHERE operation_id=${id}::uuid AND state='allocated'`.execute(trx)
        return undefined
      }
      const eligible = await procurementPreparationEligibility(trx, current.order_id, current.order_item_id)
      if (!eligible.eligible) return undefined
      try { await assertProcurementRiskSendAllowed(trx, id) } catch (error) {
        if (error instanceof ProcurementRiskError) return undefined
        throw error
      }
    } else {
      if (!await readProcurementRisk(trx, id)) return undefined
      await lockProcurementRiskPolicy(trx, id)
    }
    await sql`SELECT id FROM procurement_operations WHERE id = ${id}::uuid FOR UPDATE`.execute(trx)
    await sql`INSERT INTO procurement_execution_leases(operation_id) VALUES (${id}::uuid) ON CONFLICT DO NOTHING`.execute(trx)
    const lease = (await sql<Lease>`SELECT lease_token, lease_expires_at, request_generation, next_action_at
      FROM procurement_execution_leases WHERE operation_id = ${id}::uuid FOR UPDATE`.execute(trx)).rows[0]!
    const time = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)).rows[0]!.now
    if (lease.lease_token && lease.lease_expires_at && lease.lease_expires_at > time) return undefined
    if (lease.next_action_at && lease.next_action_at > time) return undefined
    let state = current.state
    if (state === 'submit_in_flight') {
      await sql`UPDATE procurement_operations SET state = 'unknown', revision = revision + 1 WHERE id = ${id}::uuid`.execute(trx)
      await sql`UPDATE procurement_operation_units SET state = 'unknown' WHERE operation_id = ${id}::uuid AND state = 'allocated'`.execute(trx)
      state = 'unknown'
    }
    const facts = (await sql<{ supplier_order_number: string | null; kind: string }>`SELECT DISTINCT supplier_order_number,kind
      FROM procurement_execution_evidence WHERE operation_id=${id}::uuid
        AND (supplier_order_number IS NOT NULL OR kind='identity_conflict')`.execute(trx)).rows
    const observedNumbers = [...new Set(facts.filter(fact => fact.kind !== 'identity_conflict' && fact.supplier_order_number !== null)
      .map(fact => fact.supplier_order_number!))]
    if (facts.some(fact => fact.kind === 'identity_conflict') || observedNumbers.length > 1) {
      await sql`UPDATE procurement_operations SET state='manual_review',revision=revision+1 WHERE id=${id}::uuid`.execute(trx)
      await sql`UPDATE procurement_operation_units SET state='manual_review' WHERE operation_id=${id}::uuid
        AND state IN ('allocated','unknown','success_pending_finalize')`.execute(trx)
      return undefined
    }
    if (current.state === 'success_pending_finalize') {
      const remaining = await sql<{ exists: boolean }>`SELECT EXISTS (SELECT 1 FROM procurement_operation_units
        WHERE operation_id=${id}::uuid AND (state IN ('allocated','unknown','manual_review')
          OR (state='success_pending_finalize' AND NOT EXISTS (SELECT 1 FROM procurement_execution_evidence e
            WHERE e.operation_id=procurement_operation_units.operation_id AND e.kind='delivery_confirmed'
              AND procurement_operation_units.unit_index=ANY(e.unit_indices))))) AS exists`.execute(trx)
      if (!remaining.rows[0]!.exists) return undefined
    }
    const action = state === 'prepared' ? 'submit' : 'query'
    const knownNumber = current.supplier_order_number ?? observedNumbers[0] ?? null
    const token = randomUUID()
    const generation = Number(lease.request_generation) + 1
    if (!Number.isSafeInteger(generation)) throw new Error('Procurement generation exhausted')
    await sql`UPDATE procurement_execution_leases SET lease_token = ${token}::uuid,
      lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'), request_generation = ${generation},
      next_action_at = NULL WHERE operation_id = ${id}::uuid`.execute(trx)
    await sql`INSERT INTO procurement_request_intents(id, operation_id, generation, action, request_identity)
      VALUES (${randomUUID()}::uuid, ${id}::uuid, ${generation}, ${action}, ${current.local_business_number})`.execute(trx)
    if (action === 'submit') await sql`UPDATE procurement_operations SET state = 'submit_in_flight', revision = revision + 1
      WHERE id = ${id}::uuid`.execute(trx)
    return { operationId: id, requestIdentity: current.local_business_number, generation, action,
      supplierOrderNumber: knownNumber, token }
  })
}

function normalizeResult(claimed: Claim, result: ProcurementFixtureResult): ProcurementFixtureResult {
  if (!result || !/^[a-f0-9]{64}$/.test(result.responseDigest)
    || !['accepted', 'pending', 'success', 'rejected', 'unknown', 'not_found'].includes(result.kind)
    || (result.supplierOrderNumber !== null && (typeof result.supplierOrderNumber !== 'string'
      || !result.supplierOrderNumber.trim() || result.supplierOrderNumber.length > 200))
    || (result.deliveryConfirmed !== undefined && typeof result.deliveryConfirmed !== 'boolean')
    || (result.unitIndices !== undefined && (!Array.isArray(result.unitIndices)
      || result.unitIndices.some(n => !Number.isSafeInteger(n) || n < 1)))) {
    return { requestIdentity: claimed.requestIdentity, kind: 'unknown', supplierOrderNumber: null, responseDigest: '0'.repeat(64) }
  }
  return result
}

/** Append verified identity-bound observations, including late observations, before changing state. */
async function record(db: Kysely<Database>, claimed: Claim, raw: ProcurementFixtureResult): Promise<void> {
  const invalidEncoding = raw?.unitIndices !== undefined && (!Array.isArray(raw.unitIndices)
    || raw.unitIndices.some(n => !Number.isSafeInteger(n) || n < 1)
    || new Set(raw.unitIndices).size !== raw.unitIndices.length)
  const result = normalizeResult(claimed, invalidEncoding ? { ...raw, unitIndices: [] } : raw)
  await db.transaction().execute(async trx => {
    const initial = await operationRow(trx, claimed.operationId)
    if (!initial) return
    await sql`SELECT id FROM orders WHERE id = ${initial.order_id}::uuid FOR UPDATE`.execute(trx)
    await sql`SELECT id FROM order_items WHERE id = ${initial.order_item_id}::uuid FOR UPDATE`.execute(trx)
    const op = await operationRow(trx, claimed.operationId)
    if (!op) return
    await lockProcurementRiskPolicy(trx, op.id)
    if (result.supplierOrderNumber) await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${'procurement-number:' + op.supplier_connection_id + ':' + result.supplierOrderNumber}, 0))`.execute(trx)
    const historicalFacts = (await sql<{ supplier_order_number: string | null; kind: string }>`SELECT DISTINCT supplier_order_number,kind
      FROM procurement_execution_evidence WHERE operation_id=${op.id}::uuid
        AND (supplier_order_number IS NOT NULL OR kind='identity_conflict')`.execute(trx)).rows
    const priorConflict = historicalFacts.some(fact => fact.kind === 'identity_conflict')
    const historicalNumbers = [...new Set(historicalFacts.filter(fact => fact.kind !== 'identity_conflict' && fact.supplier_order_number !== null)
      .map(fact => fact.supplier_order_number!))]
    const numberConflict = historicalNumbers.length > 1 || (result.supplierOrderNumber !== null
      && ((op.supplier_order_number !== null && result.supplierOrderNumber !== op.supplier_order_number)
        || historicalNumbers.some(number => number !== result.supplierOrderNumber)))
    const wrongIdentity = result.requestIdentity !== claimed.requestIdentity
    let kind: ProcurementFixtureResult['kind'] | 'identity_conflict' = wrongIdentity || numberConflict || invalidEncoding ? 'identity_conflict' : result.kind
    const indexes = [...new Set(result.unitIndices ?? [])].sort((a, b) => a - b)
    const assigned = (await sql<{ unit_index: number }>`SELECT unit_index FROM procurement_operation_units
      WHERE operation_id = ${op.id}::uuid ORDER BY unit_index`.execute(trx)).rows.map(row => row.unit_index)
    if (indexes.some(n => !assigned.includes(n)) || (kind === 'success' && !indexes.length)) kind = 'identity_conflict'
    if ((kind === 'accepted' || kind === 'pending') && !result.supplierOrderNumber && !op.supplier_order_number && !claimed.supplierOrderNumber) kind = 'unknown'
    const evidenceId = randomUUID()
    await sql`INSERT INTO procurement_execution_evidence(id, operation_id, generation, action, kind,
      supplier_order_number, request_identity, unit_indices, response_digest)
      VALUES (${evidenceId}::uuid, ${op.id}::uuid, ${claimed.generation}, ${claimed.action}, ${kind},
        ${result.supplierOrderNumber}, ${claimed.requestIdentity}, ${kind === 'identity_conflict' ? [] : indexes}::integer[], ${result.responseDigest})`.execute(trx)
    if (kind === 'success' && result.deliveryConfirmed === true) {
      await sql`INSERT INTO procurement_execution_evidence(id, operation_id, generation, action, kind,
        supplier_order_number, request_identity, unit_indices, response_digest)
        VALUES (${randomUUID()}::uuid, ${op.id}::uuid, ${claimed.generation}, ${claimed.action}, 'delivery_confirmed',
          ${result.supplierOrderNumber}, ${claimed.requestIdentity}, ${indexes}::integer[], ${result.responseDigest})`.execute(trx)
    }
    const collision = result.supplierOrderNumber ? (await sql<{ collision: boolean }>`SELECT EXISTS (
      SELECT 1 FROM procurement_execution_evidence e JOIN procurement_operations other ON other.id = e.operation_id
      JOIN order_item_procurement_sources s ON s.id = other.source_id
      WHERE s.supplier_connection_id = ${op.supplier_connection_id}::uuid AND e.supplier_order_number = ${result.supplierOrderNumber}
        AND e.operation_id <> ${op.id}::uuid) AS collision`.execute(trx)).rows[0]!.collision : false
    await sql`SELECT id FROM procurement_operations WHERE id = ${op.id}::uuid FOR UPDATE`.execute(trx)
    const lease = (await sql<Lease>`SELECT lease_token, lease_expires_at, request_generation, next_action_at
      FROM procurement_execution_leases WHERE operation_id = ${op.id}::uuid FOR UPDATE`.execute(trx)).rows[0]
    const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)).rows[0]!.now
    if (!lease || lease.lease_token !== claimed.token || Number(lease.request_generation) !== claimed.generation
      || !lease.lease_expires_at || lease.lease_expires_at <= now) return
    const current = await operationRow(trx, op.id)
    if (!current || ['completed', 'rejected'].includes(current.state)) return
    // A rejection is retained for manual adjudication; no implicit budget release occurs.
    let next = kind === 'identity_conflict' || priorConflict || collision || kind === 'rejected'
      || (kind === 'not_found' && (current.supplier_order_number !== null || claimed.supplierOrderNumber !== null)) ? 'manual_review'
      : kind === 'success' ? 'success_pending_finalize'
        : kind === 'accepted' || kind === 'pending' ? 'accepted_pending' : 'unknown'
    if (current.state === 'success_pending_finalize' && !collision && !priorConflict
      && kind !== 'identity_conflict' && kind !== 'rejected') next = 'success_pending_finalize'
    const number = current.supplier_order_number ?? (kind === 'identity_conflict' || priorConflict ? null : result.supplierOrderNumber ?? claimed.supplierOrderNumber)
    if (next !== current.state || number !== current.supplier_order_number) {
      await sql`UPDATE procurement_operations SET state = ${next}, supplier_order_number = ${number}, revision = revision + 1
        WHERE id = ${op.id}::uuid`.execute(trx)
    }
    if (next === 'unknown') await sql`UPDATE procurement_operation_units SET state = 'unknown'
      WHERE operation_id = ${op.id}::uuid AND state IN ('allocated', 'manual_review')`.execute(trx)
    if (next === 'manual_review') await sql`UPDATE procurement_operation_units SET state = 'manual_review'
      WHERE operation_id = ${op.id}::uuid AND state IN ('allocated', 'unknown', 'success_pending_finalize')`.execute(trx)
    if (next === 'success_pending_finalize') await sql`UPDATE procurement_operation_units SET state = 'success_pending_finalize'
      WHERE operation_id = ${op.id}::uuid AND unit_index = ANY(${indexes}::integer[]) AND state IN ('allocated', 'unknown', 'manual_review')`.execute(trx)
    await sql`UPDATE procurement_execution_leases SET lease_token = NULL, lease_expires_at = NULL,
      next_action_at = CASE WHEN ${next} IN ('unknown', 'accepted_pending', 'success_pending_finalize') THEN clock_timestamp() + interval '30 seconds' ELSE NULL END
      WHERE operation_id = ${op.id}::uuid`.execute(trx)
  })
}

/** One controlled pass: it never repeats submit, and performs I/O outside the transaction. */
export async function runProcurementFixturePass(
  db: Kysely<Database>, operationId: string, transport: ProcurementFixtureTransport,
  resolveSource: ProcurementFixtureSourceResolver, leaseMs = 30_000, requestTimeoutMs = Math.min(20_000, leaseMs - 1),
  onLateEvidenceFailure: (context: { operationId: string; generation: number }) => void = context => {
    process.emitWarning(`Late procurement evidence could not be saved for ${context.operationId} generation ${context.generation}`)
  },
): Promise<boolean> {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error('Invalid procurement lease duration')
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs >= leaseMs) throw new Error('Invalid procurement request timeout')
  const source = (await sql<{ supplier_connection_id: string; supplier_connection_version_id: string; credential_version: number; key_id: string }>`
    SELECT s.supplier_connection_id, s.supplier_connection_version_id, s.credential_version, c.key_id
    FROM procurement_operations p JOIN order_item_procurement_sources s ON s.id=p.source_id
    JOIN supplier_connection_credentials c ON c.supplier_connection_id=s.supplier_connection_id
      AND c.credential_version=s.credential_version WHERE p.id=${operationId}::uuid`.execute(db)).rows[0]
  if (!source) return false
  try {
    if (!await resolveSource({ supplierConnectionId: source.supplier_connection_id,
      connectionVersionId: source.supplier_connection_version_id, credentialVersion: source.credential_version, credentialKeyId: source.key_id })) return false
  } catch { return false }
  const claimed = await claim(db, operationId, leaseMs)
  if (!claimed) return false
  const request = { operationId: claimed.operationId, requestIdentity: claimed.requestIdentity,
    generation: claimed.generation, action: claimed.action, supplierOrderNumber: claimed.supplierOrderNumber }
  const unknown: ProcurementFixtureResult = { requestIdentity: claimed.requestIdentity, kind: 'unknown',
    supplierOrderNumber: null, responseDigest: '0'.repeat(64) }
  const call = Promise.resolve().then(() => transport(request))
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    call.then(value => ({ type: 'result' as const, value }), () => ({ type: 'failure' as const })),
    new Promise<{ type: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ type: 'timeout' }), requestTimeoutMs) }),
  ])
  if (timer) clearTimeout(timer)
  if (outcome.type === 'timeout') {
    await record(db, claimed, unknown)
    // A response may still arrive after the caller has stopped waiting. Its evidence
    // is appended but the cleared lease prevents it from changing authority.
    void call.then(async value => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await record(db, claimed, value); return } catch {
          if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 25 * (attempt + 1)))
        }
      }
      try { onLateEvidenceFailure({ operationId: claimed.operationId, generation: claimed.generation }) } catch {
        process.emitWarning('Late procurement evidence failure callback failed')
      }
    }, () => undefined)
  } else {
    await record(db, claimed, outcome.type === 'result' ? outcome.value : unknown)
  }
  return true
}
