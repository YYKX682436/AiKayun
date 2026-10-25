import { createDatabase } from '../db/pool.js'
import { readConfig } from '../config.js'
import { reconcilePurchaseOrderAttachments } from '../commerce/purchase-order-attachments.js'
import { PurchaseOrderAttachmentStorage } from './purchase-order-attachment-storage.js'

const mode = process.argv[2] === '--repair' ? 'repair' : process.argv[2] === '--check' ? 'check' : undefined
if (!mode || process.argv.length !== 3) throw new Error('Use --check or --repair')

const config = readConfig()
const db = createDatabase()
try {
  const report = await reconcilePurchaseOrderAttachments(
    db, new PurchaseOrderAttachmentStorage(config.privateFileRoot), { repair: mode === 'repair' },
  )
  process.stdout.write(`${JSON.stringify({ mode, ...report })}\n`)
  if (report.missingRetained > 0 || report.orphanFiles > 0 || report.deleting > 0) process.exitCode = 1
} finally {
  await db.destroy()
}
