import { createHash } from 'node:crypto'
import { lstat, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { MediaStorage } from './storage.js'

export interface MediaReconcileOptions {
  deleteUnreferencedOlderThanMs?: number
  now?: number
}

export interface MediaReconcileReport {
  metadataVariants: number
  verifiedVariants: number
  missingFiles: number
  invalidFiles: number
  unreferencedFiles: number
  staleStagingFiles: number
  deletedFiles: number
  needsAttention: boolean
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function reconcileProductMedia(
  db: Kysely<Database>,
  storage: MediaStorage,
  options: MediaReconcileOptions = {},
): Promise<MediaReconcileReport> {
  const now = options.now ?? Date.now()
  const grace = options.deleteUnreferencedOlderThanMs ?? 24 * 60 * 60 * 1000
  const cleanupEnabled = options.deleteUnreferencedOlderThanMs !== undefined
  const metadata = await db.selectFrom('product_media_variants').select([
    'storage_key', 'size_bytes', 'sha256',
  ]).execute()
  const metadataByKey = new Map(metadata.map((row) => [row.storage_key, row]))
  let files = await storage.scanGeneratedFiles()
  let missingFiles = 0
  let invalidFiles = 0
  const deletions: Array<{ storageKey: string; path: string; staged: boolean }> = []
  const presentKeys = new Set<string>()

  for (const file of files) {
    if (file.staged) {
      if (now - file.mtimeMs >= grace) {
        if (cleanupEnabled) deletions.push({ storageKey: file.storageKey, path: file.path, staged: true })
      }
      continue
    }
    presentKeys.add(file.storageKey)
    const row = metadataByKey.get(file.storageKey)
    if (!row) {
      if (cleanupEnabled && now - file.mtimeMs >= grace) deletions.push({ storageKey: file.storageKey, path: file.path, staged: false })
      continue
    }
    try {
      const info = await lstat(file.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== row.size_bytes
        || await sha256File(file.path) !== row.sha256.trim()) {
        invalidFiles += 1
      }
    } catch {
      invalidFiles += 1
    }
  }
  for (const key of metadataByKey.keys()) {
    if (!presentKeys.has(key)) missingFiles += 1
  }

  let deletedFiles = 0
  for (const file of deletions) {
    // Recheck that a delayed upload did not commit metadata since the initial
    // scan. The age threshold must exceed the bounded image processing time.
    if (!file.staged) {
      const stillRegistered = await db.selectFrom('product_media_variants').select('storage_key')
        .where('storage_key', '=', file.storageKey).executeTakeFirst()
      if (stillRegistered) continue
    }
    const info = await lstat(file.path)
    if (!info.isFile() || info.isSymbolicLink()) continue
    await unlink(file.path)
    deletedFiles += 1
  }

  if (deletedFiles > 0) files = await storage.scanGeneratedFiles()
  const remainingKeys = new Set(files.filter((file) => !file.staged).map((file) => file.storageKey))
  const remainingOrphans = [...remainingKeys].filter((key) => !metadataByKey.has(key)).length
  const remainingStaging = files.filter((file) => file.staged && now - file.mtimeMs >= grace).length
  const needsAttention = missingFiles > 0 || invalidFiles > 0 || remainingOrphans > 0 || remainingStaging > 0

  return {
    metadataVariants: metadata.length,
    verifiedVariants: Math.max(0, metadata.length - missingFiles - invalidFiles),
    missingFiles,
    invalidFiles,
    unreferencedFiles: remainingOrphans,
    staleStagingFiles: remainingStaging,
    deletedFiles,
    needsAttention,
  }
}
