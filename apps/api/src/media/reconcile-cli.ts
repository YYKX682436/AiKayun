import { createDatabase } from '../db/pool.js'
import { readConfig } from '../config.js'
import { MediaStorage } from './storage.js'
import { reconcileProductMedia } from './reconcile.js'

function parseGracePeriod(argument: string | undefined): number | undefined {
  if (!argument || argument === '--check') return undefined
  const match = /^--delete-unreferenced-older-than=(\d+)(h|d)$/.exec(argument)
  if (!match || !match[1] || !match[2]) {
    throw new Error('Use --check or --delete-unreferenced-older-than=<hours>h|<days>d')
  }
  const amount = Number(match[1])
  const milliseconds = amount * (match[2] === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 24 * 60 * 60 * 1000 || milliseconds > 365 * 24 * 60 * 60 * 1000) {
    throw new Error('The cleanup grace period must be between 24 hours and 365 days')
  }
  return milliseconds
}

const gracePeriod = parseGracePeriod(process.argv[2])
if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--check' && gracePeriod === undefined)) {
  throw new Error('Use --check or --delete-unreferenced-older-than=<hours>h|<days>d')
}

const config = readConfig()
const db = createDatabase()
try {
  const report = await reconcileProductMedia(db, new MediaStorage(config.mediaRoot), {
    ...(gracePeriod === undefined ? {} : { deleteUnreferencedOlderThanMs: gracePeriod }),
  })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.needsAttention) process.exitCode = 1
} finally {
  await db.destroy()
}
