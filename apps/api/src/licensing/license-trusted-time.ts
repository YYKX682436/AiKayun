import { sql } from 'kysely'
import type { Kysely, Selectable, Transaction } from 'kysely'
import type { Database, InstanceLicenseStateTable } from '../db/types.js'
import { loadLicensePendingKey } from './pending-encryption-key.js'
import { readCurrentProcessSignedTimeMs } from './trust/time-anchor-client.js'
import {
  advanceTrustedTimeWatermarkFile,
  readTrustedTimeWatermark,
} from './trusted-time-watermark.js'
import type { TimeWatermarkIdentity } from './trusted-time-watermark.js'

const CLOCK_ROLLBACK_LIMIT_MS = 60_000

type LicenseStateRow = Selectable<InstanceLicenseStateTable>
type LicenseStateTransaction = Transaction<Database> | Kysely<Database>

export class LicenseClockSuspectError extends Error {
  constructor(readonly reason: 'watermark_missing' | 'watermark_corrupt' | 'watermark_identity_mismatch' |
    'watermark_rollback' | 'clock_rollback' | 'clock_anchor_conflict') {
    super(`license_clock_suspect_${reason}`)
    this.name = 'LicenseClockSuspectError'
  }
}

function parseWatermark(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,15}$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Caller must already hold installation_binding then instance_license_state FOR UPDATE.
 * File first, then DB: a rolled back/unknown SQL commit can only leave the durable file ahead.
 */
export async function advanceLicenseTrustedTime(input: {
  tx: LicenseStateTransaction
  row: LicenseStateRow
  pendingRoot: string
  identity: TimeWatermarkIdentity
  signedTimeMs?: number | null
  databaseTimeMs?: number
  useProcessAnchor?: boolean
}): Promise<{ readonly trustedTimeMs: number; readonly trustedTimeSeconds: number }> {
  const wall = await sql<{ now_ms: string }>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms
  `.execute(input.tx)
  const wallMs = input.databaseTimeMs ?? Number(wall.rows[0]?.now_ms)
  if (!Number.isSafeInteger(wallMs) || wallMs <= 0) throw new Error('license_trusted_database_clock_unavailable')

  const persistedDbMs = parseWatermark(input.row.trusted_time_high_water_ms)
  if (input.row.trusted_time_high_water_ms !== null && persistedDbMs === null) {
    throw new LicenseClockSuspectError('watermark_corrupt')
  }
  await loadLicensePendingKey(input.pendingRoot)
  const file = await readTrustedTimeWatermark(input.pendingRoot, input.identity)
  if (file.status === 'corrupt') {
    throw new LicenseClockSuspectError('watermark_identity_mismatch')
  }
  if (file.status === 'missing' && (input.row.license_id !== null || persistedDbMs !== null)) {
    throw new LicenseClockSuspectError('watermark_missing')
  }
  const fileMs = file.status === 'valid' ? file.record.high_water_ms : null
  if (persistedDbMs !== null && fileMs !== null && persistedDbMs > fileMs) {
    // The protocol always fsyncs the file before committing this DB column. A DB-only lead
    // therefore means a stale/partial restore or an unrecognized writer, not a normal crash.
    throw new LicenseClockSuspectError('watermark_rollback')
  }

  const existingHighWaterMs = Math.max(persistedDbMs ?? 0, fileMs ?? 0)
  const processAnchorMs = input.useProcessAnchor === false ? null : input.signedTimeMs ?? readCurrentProcessSignedTimeMs()
  if (processAnchorMs !== null && processAnchorMs !== undefined) {
    if (!Number.isSafeInteger(processAnchorMs) || processAnchorMs <= 0) throw new LicenseClockSuspectError('clock_anchor_conflict')
    if (Math.abs(wallMs - processAnchorMs) > CLOCK_ROLLBACK_LIMIT_MS ||
      existingHighWaterMs > processAnchorMs + CLOCK_ROLLBACK_LIMIT_MS) {
      throw new LicenseClockSuspectError('clock_anchor_conflict')
    }
  }
  const floor = Math.max(wallMs, existingHighWaterMs, processAnchorMs ?? 0)
  if (existingHighWaterMs > 0 && wallMs + CLOCK_ROLLBACK_LIMIT_MS < existingHighWaterMs) {
    throw new LicenseClockSuspectError('clock_rollback')
  }
  if (processAnchorMs !== null && processAnchorMs !== undefined && wallMs + CLOCK_ROLLBACK_LIMIT_MS < processAnchorMs) {
    throw new LicenseClockSuspectError('clock_rollback')
  }

  // Preserve millisecond precision so the half-open JWT boundary is exact; JWT exp values
  // are integer seconds, and flooring below rejects at exp while preserving the final valid ms.
  const durableFloorMs = floor
  if (file.status !== 'valid' || fileMs! < durableFloorMs) {
    await advanceTrustedTimeWatermarkFile(input.pendingRoot, input.identity, durableFloorMs)
  }
  if (persistedDbMs === null || persistedDbMs < durableFloorMs) {
    await input.tx.updateTable('instance_license_state').set({ trusted_time_high_water_ms: String(durableFloorMs) })
      .where('singleton', '=', true).executeTakeFirstOrThrow()
  }
  return Object.freeze({ trustedTimeMs: durableFloorMs, trustedTimeSeconds: Math.floor(durableFloorMs / 1_000) })
}
