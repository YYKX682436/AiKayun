import { createDatabase } from '../db/pool.js'
import { readConfig } from '../config.js'
import { PurchaseAttachmentStorage } from './purchase-attachment-storage.js'
import { reconcilePurchaseDrafts } from '../commerce/purchase-forms.js'

const mode = process.argv[2] === '--repair' ? 'repair' : process.argv[2] === '--check' ? 'check' : undefined
if (!mode || process.argv.length !== 3) throw new Error('Use --check or --repair')

const config = readConfig()
const db = createDatabase()
try {
  const report = await reconcilePurchaseDrafts(db, new PurchaseAttachmentStorage(config.privateFileRoot), { repair: mode === 'repair' })
  process.stdout.write(`${JSON.stringify({ mode, ...report })}\n`)
  if (report.missingObjects > 0 || report.oldOrphanFiles > 0 || report.deletingAttachments > 0) process.exitCode = 1
} finally {
  await db.destroy()
}
