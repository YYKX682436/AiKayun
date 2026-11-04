/** Explicit, read-only file audit. Never run repair from this process. */
import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { createPostgresPool, createDatabase } from '../db/pool.js'
import { readConfig } from '../config.js'
import { MediaStorage } from './storage.js'
import { PrivateFileStorage } from './private-file-storage.js'
import { PurchaseAttachmentStorage } from './purchase-attachment-storage.js'
import { PurchaseOrderAttachmentStorage } from './purchase-order-attachment-storage.js'
import { reconcileProductMedia } from './reconcile.js'
import { reconcilePrivateFiles } from './private-file-reconcile.js'
import { reconcilePurchaseDrafts } from '../commerce/purchase-forms.js'
import { reconcilePurchaseOrderAttachments } from '../commerce/purchase-order-attachments.js'

const MAX_RUNTIME_MS = 5 * 60_000
const MIN_INTERVAL_HOURS = 6
const ATTACHMENT_HASH_LIMIT = 1000
const kinds = ['media', 'private', 'draft', 'order'] as const
type Counts = Record<string, number>

if (process.argv.length !== 2) throw new Error('This command accepts no arguments and performs only a read-only check')
const config = readConfig()
const pool = createPostgresPool({ applicationName: 'aikayun-file-check' })
const db = createDatabase()
const session = await pool.connect().catch(() => {
  process.stderr.write('File check unavailable; inspect the database connection.\n')
  process.exit(1)
})
let acquired = false
let timer: NodeJS.Timeout | undefined
try {
  acquired = (await session.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended('aikayun-operations-file-check', 0)) AS acquired",
  )).rows[0]?.acquired === true
  if (!acquired) throw new Error('A file check is already running')
  const recent = await session.query<{ recent: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM operations_file_checks WHERE started_at > clock_timestamp() - ($1 * interval '1 hour')) AS recent",
    [MIN_INTERVAL_HOURS],
  )
  if (recent.rows[0]?.recent) throw new Error('File checks are limited to once per six hours')
  // Persist running before scanning. SIGKILL, timeout or loss of DB connection
  // leaves an explicitly unknown/incomplete result, never an old green result.
  const started = await session.query(`INSERT INTO operations_file_checks (kind, started_at, completed_at, status, counts)
    SELECT kind, clock_timestamp(), NULL, 'running', '{}'::jsonb FROM unnest($1::text[]) AS kind
    WHERE EXISTS (SELECT 1 FROM installation_binding b JOIN installation_identity_initializations j ON j.singleton = b.singleton
      WHERE b.singleton = true AND b.binding_state = 'ready' AND j.state = 'committed')
    ON CONFLICT (kind) DO UPDATE SET started_at = EXCLUDED.started_at,
      completed_at = NULL, status = 'running', counts = '{}'::jsonb`, [kinds])
  if (started.rowCount !== kinds.length) {
    process.stderr.write('File check unavailable: installation identity is not initialized.\n')
    process.exitCode = 1
    throw new Error('IDENTITY_NOT_INITIALIZED')
  }
  timer = setTimeout(() => process.exit(2), MAX_RUNTIME_MS)
  const outcomes: Record<string, string> = {}
  for (const kind of kinds) {
    let status: 'ok' | 'attention' | 'unknown' = 'unknown'
    let counts: Counts = {}
    try {
      await assertRoot(kind === 'media' ? config.mediaRoot : config.privateFileRoot)
      if (kind === 'media') {
        const r = await reconcileProductMedia(db, new MediaStorage(config.mediaRoot))
        counts = selectCounts(r, ['metadataVariants', 'verifiedVariants', 'missingFiles', 'invalidFiles', 'unreferencedFiles', 'staleStagingFiles'])
        status = r.needsAttention ? 'attention' : 'ok'
      } else if (kind === 'private') {
        const r = await reconcilePrivateFiles(db, new PrivateFileStorage(config.privateFileRoot), 'check')
        counts = selectCounts(r, ['referencedObjects', 'verifiedObjects', 'missingObjects', 'corruptObjects', 'unknownObjects', 'staleUploadRows', 'orphanFiles'])
        status = r.unknownObjects ? 'unknown' : r.needsAttention ? 'attention' : 'ok'
      } else if (kind === 'draft') {
        const storage = new PurchaseAttachmentStorage(config.privateFileRoot)
        const r = await reconcilePurchaseDrafts(db, storage, { repair: false })
        const rows = await db.selectFrom('purchase_draft_attachments').select(['id', 'storage_key', 'byte_size', 'sha256'])
          .where('status', '=', 'ready').orderBy('id').limit(ATTACHMENT_HASH_LIMIT + 1).execute()
        const hash = await verifyAttachments(rows, row => row.byte_size !== null && row.sha256 !== null
          ? storage.readVerified(row.id, row.storage_key, row.byte_size, row.sha256.trim()) : Promise.reject())
        counts = { ...selectCounts(r, ['deletingAttachments', 'missingObjects', 'oldOrphanFiles']), ...hash.counts }
        status = hash.incomplete ? 'unknown' : r.missingObjects || r.oldOrphanFiles || r.deletingAttachments || hash.counts.hashFailed ? 'attention' : 'ok'
      } else {
        const storage = new PurchaseOrderAttachmentStorage(config.privateFileRoot)
        const r = await reconcilePurchaseOrderAttachments(db, storage, { repair: false })
        const rows = await db.selectFrom('purchase_order_attachment_objects').select(['id', 'storage_key', 'byte_size', 'sha256'])
          .where('status', '=', 'retained').orderBy('id').limit(ATTACHMENT_HASH_LIMIT + 1).execute()
        const hash = await verifyAttachments(rows, row => storage.readVerified(row.id, row.storage_key, row.byte_size, row.sha256.trim()))
        counts = { ...selectCounts(r, ['prepared', 'deleting', 'missingRetained', 'orphanFiles']), ...hash.counts }
        status = hash.incomplete ? 'unknown' : r.missingRetained || r.orphanFiles || r.deleting || hash.counts.hashFailed ? 'attention' : 'ok'
      }
    } catch {
      // No exception text, paths, object IDs or provider/database data leave the audit.
      status = 'unknown'
      counts = {}
    }
    await session.query(`UPDATE operations_file_checks SET status = $2, counts = $3::jsonb,
      completed_at = clock_timestamp() WHERE kind = $1`, [kind, status, JSON.stringify(counts)])
    outcomes[kind] = status
  }
  process.stdout.write(`${JSON.stringify(outcomes)}\n`)
  if (Object.values(outcomes).some(status => status !== 'ok')) process.exitCode = 1
} catch {
  process.stderr.write('File check did not complete; inspect the operations status.\n')
  process.exitCode = 1
} finally {
  if (timer) clearTimeout(timer)
  if (acquired) await session.query("SELECT pg_advisory_unlock(hashtextextended('aikayun-operations-file-check', 0))").catch(() => undefined)
  session.release()
  await Promise.all([pool.end(), db.destroy()])
}

async function assertRoot(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid storage root')
  await access(path, constants.R_OK | constants.X_OK)
}

function selectCounts(report: object, keys: string[]): Counts {
  const result: Counts = {}
  for (const key of keys) {
    const count = (report as Record<string, unknown>)[key]
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error('Invalid check count')
    result[key] = count as number
  }
  return result
}

async function verifyAttachments<T>(rows: T[], verify: (row: T) => Promise<unknown>): Promise<{ counts: Counts; incomplete: boolean }> {
  let hashVerified = 0
  let hashFailed = 0
  for (const row of rows.slice(0, ATTACHMENT_HASH_LIMIT)) {
    try { await verify(row); hashVerified += 1 } catch { hashFailed += 1 }
  }
  // More than the cap is explicitly incomplete, never reported as healthy.
  return { counts: { hashVerified, hashFailed, hashLimitReached: rows.length > ATTACHMENT_HASH_LIMIT ? 1 : 0 }, incomplete: rows.length > ATTACHMENT_HASH_LIMIT }
}
