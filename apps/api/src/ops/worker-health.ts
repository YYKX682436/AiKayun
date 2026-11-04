import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'

export type ObservedWorker = 'unpaid_expiry' | 'local_delivery' | 'supplier_delivery' | 'license_renewal'

/**
 * A best-effort observation, never awaited by the business loop. Each process
 * and worker writes at most one periodic observation and two state transitions
 * per minute. A stuck pool acquisition leaves one in-flight write, not a queue.
 * Observations are persisted only after the installation binding is committed;
 * uninitialized installations remain unknown. PostgreSQL supplies timestamps
 * and serializes concurrent instance upserts.
 */
export function createWorkerObserver(db: Kysely<Database>, worker: ObservedWorker) {
  let lastAttempt = -Infinity
  type Observation = boolean | 'unavailable'
  let lastObserved: Observation | undefined
  let windowStart = performance.now()
  let transitions = 0
  let inFlight = false
  const pending: Observation[] = []

  const observe = (outcome: Observation) => {
    const succeeded = outcome === true
    const failed = outcome === false
    const unavailable = outcome === 'unavailable'
    if (inFlight) {
      // Keep the first transition and latest state, with a fixed memory bound.
      if ((pending.at(-1) ?? lastObserved) !== outcome) {
        if (pending.length < 2) pending.push(outcome)
        else pending[1] = outcome
      }
      return
    }
    const now = performance.now()
    if (now - windowStart >= 60_000) {
      windowStart = now
      transitions = 0
    }
    const changed = lastObserved !== undefined && lastObserved !== outcome
    if (now - lastAttempt < 60_000 && (!changed || transitions >= 2)) return
    if (changed) transitions += 1
    lastAttempt = now
    lastObserved = outcome
    inFlight = true
    void db.transaction().execute(async tx => {
      await sql`SET LOCAL statement_timeout = '1500ms'`.execute(tx)
      await sql`
        INSERT INTO operations_worker_health (worker, last_scan_at, last_success_at, last_failure_at, last_failure_code, last_unavailable_at, last_unavailable_code)
        SELECT ${worker}, CASE WHEN NOT ${unavailable} THEN clock_timestamp() END,
          CASE WHEN ${succeeded} THEN clock_timestamp() END,
          CASE WHEN ${failed} THEN clock_timestamp() END, CASE WHEN ${failed} THEN 'SCAN_FAILED' END,
          CASE WHEN ${unavailable} THEN clock_timestamp() END, CASE WHEN ${unavailable} THEN 'RELEASE_NOT_CONFIGURED' END
        WHERE EXISTS (SELECT 1 FROM installation_binding b JOIN installation_identity_initializations j ON j.singleton = b.singleton
          WHERE b.singleton = true AND b.binding_state = 'ready' AND j.state = 'committed')
        ON CONFLICT (worker) DO UPDATE SET
          last_scan_at = CASE WHEN NOT ${unavailable} THEN clock_timestamp() ELSE operations_worker_health.last_scan_at END,
          last_success_at = CASE WHEN ${succeeded} THEN clock_timestamp() ELSE operations_worker_health.last_success_at END,
          last_failure_at = CASE WHEN ${failed} THEN clock_timestamp() ELSE operations_worker_health.last_failure_at END,
          last_failure_code = CASE WHEN ${failed} THEN 'SCAN_FAILED' ELSE operations_worker_health.last_failure_code END,
          last_unavailable_at = CASE WHEN ${unavailable} THEN clock_timestamp() ELSE operations_worker_health.last_unavailable_at END,
          last_unavailable_code = CASE WHEN ${unavailable} THEN 'RELEASE_NOT_CONFIGURED' ELSE operations_worker_health.last_unavailable_code END
      `.execute(tx)
    }).catch(() => { /* Monitoring failure must not affect the business worker. */ }).finally(() => {
      inFlight = false
      const queued = pending.splice(0)
      for (const state of queued) observe(state)
    })
  }
  return observe
}
