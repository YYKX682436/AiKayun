import type { Kysely } from 'kysely'
import type { Database, PrivateFileObjectStatus } from '../db/types.js'
import { PRIVATE_FILE_STAGE_TTL_MS, PrivateFileError, PrivateFileStorage } from './private-file-storage.js'

export interface PrivateFileReconciliationReport {
  mode: 'check' | 'repair'
  referencedObjects: number
  verifiedObjects: number
  missingObjects: number
  corruptObjects: number
  unknownObjects: number
  staleUploadRows: number
  orphanFiles: number
  repairedObjects: number
  removedOrphans: number
  needsAttention: boolean
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

export async function reconcilePrivateFiles(
  db: Kysely<Database>,
  storage: PrivateFileStorage,
  mode: 'check' | 'repair',
): Promise<PrivateFileReconciliationReport> {
  const repair = mode === 'repair'
  const report: PrivateFileReconciliationReport = {
    mode, referencedObjects: 0, verifiedObjects: 0, missingObjects: 0,
    corruptObjects: 0, unknownObjects: 0, staleUploadRows: 0,
    orphanFiles: 0, repairedObjects: 0, removedOrphans: 0, needsAttention: false,
  }
  const now = new Date()
  const staleBefore = now.getTime() - PRIVATE_FILE_STAGE_TTL_MS
  const referenced = await db.selectFrom('private_file_objects as object')
    .innerJoin('product_variant_fulfillment_versions as version', 'version.private_file_object_id', 'object.id')
    .select([
      'object.id', 'object.status', 'object.size_bytes', 'object.sha256', 'object.media_type',
      'version.id as version_id', 'version.product_variant_id',
    ])
    .orderBy('object.id').execute()
  report.referencedObjects = referenced.length

  for (const row of referenced) {
    let actual: 'verified' | 'missing' | 'corrupt' | 'unknown' = 'unknown'
    if (row.size_bytes !== null && row.sha256 && row.media_type) {
      try {
        const opened = await storage.openVerified(row.id, { sizeBytes: row.size_bytes, sha256: row.sha256.trim() })
        await opened.handle.close()
        actual = 'verified'
      } catch (error) {
        actual = error instanceof PrivateFileError
          ? error.code === 'PRIVATE_FILE_INTEGRITY_FAILED' ? 'corrupt' : 'missing'
          : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(errno(error) ?? '') ? 'missing' : 'unknown'
      }
    }
    if (actual === 'verified') report.verifiedObjects += 1
    else if (actual === 'missing') {
      report.missingObjects += 1
      report.needsAttention = true
    } else if (actual === 'corrupt') {
      report.corruptObjects += 1
      report.needsAttention = true
    }
    else report.unknownObjects += 1

    if (actual !== 'unknown') {
      const next: PrivateFileObjectStatus = actual === 'verified' ? 'available' : actual
      if (row.status !== next) {
        report.needsAttention = true
        if (repair) {
          if (next !== 'available') {
            await db.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: false })
              .where('product_variant_id', '=', row.product_variant_id).where('method', '=', 'file')
              .where('current_content_version_id', '=', row.version_id).where('automatic_delivery_ready', '=', true).execute()
          }
          await db.updateTable('private_file_objects').set({ status: next })
            .where('id', '=', row.id).where('status', 'in', ['available', 'missing', 'corrupt']).execute()
          report.repairedObjects += 1
        }
      }
      if (repair && next !== 'available') {
        await db.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: false })
          .where('product_variant_id', '=', row.product_variant_id).where('method', '=', 'file')
          .where('current_content_version_id', '=', row.version_id).where('automatic_delivery_ready', '=', true).execute()
      }
    } else {
      report.needsAttention = true
    }
  }

  const staleRows = await db.selectFrom('private_file_objects')
    .select(['id', 'status'])
    .where('status', 'in', ['uploading', 'staged', 'failed'])
    .where('expires_at', '<=', now).orderBy('id').execute()
  report.staleUploadRows = staleRows.length
  if (staleRows.length) report.needsAttention = true
  if (repair) {
    for (const row of staleRows) {
      await db.transaction().execute(async (trx) => {
        const locked = await trx.selectFrom('private_file_objects').select(['id', 'status', 'expires_at'])
          .where('id', '=', row.id).forUpdate().skipLocked().executeTakeFirst()
        if (!locked || locked.status !== row.status || locked.expires_at > now) return
        await storage.removeStaging(row.id)
        await storage.removeObject(row.id)
        await trx.deleteFrom('private_file_objects').where('id', '=', row.id)
          .where('status', '=', row.status).execute()
      })
    }
  }

  const known = new Set((await db.selectFrom('private_file_objects').select('id').execute()).map(row => row.id))
  const generated = await storage.scanGeneratedFiles()
  const orphans = generated.filter(file => !known.has(file.id) && file.mtimeMs <= staleBefore)
  report.orphanFiles = orphans.length
  if (orphans.length) report.needsAttention = true
  if (repair) {
    for (const file of orphans) {
      if (file.staged) await storage.removeStaging(file.id)
      else await storage.removeObject(file.id)
      report.removedOrphans += 1
    }
  }
  if (repair && report.removedOrphans === report.orphanFiles
    && report.staleUploadRows === staleRows.length
    && report.unknownObjects === 0) {
    report.needsAttention = report.missingObjects > 0 || report.corruptObjects > 0
  }
  return report
}
