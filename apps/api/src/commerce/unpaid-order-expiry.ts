import type { FastifyBaseLogger } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { expireDueUnpaidOrders } from './orders.js'
import { createWorkerObserver } from '../ops/worker-health.js'
import { expireDuePaymentAttempts } from '../payments/attempts.js'

const pollIntervalMs = 60_000
const batchSize = 100

/**
 * One runner per API instance. Payment expiry locks one payment context at a
 * time; SKIP LOCKED distributes order closure across instances.
 */
export function startUnpaidOrderExpiryWorker(
  db: Kysely<Database>,
  logger: FastifyBaseLogger,
): () => Promise<void> {
  const observe = createWorkerObserver(db, 'unpaid_expiry')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let activeRun: Promise<void> | undefined

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => { void run() }, pollIntervalMs)
    timer.unref()
  }

  const run = async () => {
    if (stopped) return
    activeRun = (async () => {
      let closedCount = 0
      try {
        while (!stopped) {
          if (await expireDuePaymentAttempts(db, batchSize) < batchSize) break
        }
        const now = new Date()
        while (!stopped) {
          const closed = await expireDueUnpaidOrders(db, now, batchSize)
          closedCount += closed
          if (closed < batchSize) break
        }
        observe(true)
        if (closedCount > 0) logger.info({ closedCount }, 'expired unpaid orders closed')
      } catch {
        observe(false)
        logger.warn({ errorCode: 'SCAN_FAILED' }, 'unpaid order expiry pass failed')
      } finally {
        activeRun = undefined
        schedule()
      }
    })()
    await activeRun
  }

  void run()
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    await activeRun
  }
}
