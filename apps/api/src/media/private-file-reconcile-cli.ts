import { createDatabase } from '../db/pool.js'
import { readConfig } from '../config.js'
import { PrivateFileStorage } from './private-file-storage.js'
import { reconcilePrivateFiles } from './private-file-reconcile.js'

const mode = process.argv[2] === '--repair' ? 'repair' : process.argv[2] === '--check' ? 'check' : undefined
if (!mode || process.argv.length !== 3) {
  throw new Error('Use --check or --repair')
}

const config = readConfig()
const db = createDatabase()
try {
  const report = await reconcilePrivateFiles(db, new PrivateFileStorage(config.privateFileRoot), mode)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.needsAttention) process.exitCode = 1
} finally {
  await db.destroy()
}
