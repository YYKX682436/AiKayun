import type { FastifyBaseLogger } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { expireDueUnpaidOrders } from './orders.js'

const pollIntervalMs = 60_000
const batchSize = 100

/**
 * One in-process runner per API instance. PostgreSQL row locks plus
 * SKIP LOCKED distribute work across instances; the first run after startup
 * recovers anything that expired while the service was down.
 */
export function startUnpaidOrderExpiryWorker(
  db: Kysely<Database>,
  logger: FastifyBaseLogger,
): () => Promise<void> {
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
          const closed = await expireDueUnpaidOrders(db, new Date(), batchSize)
          closedCount += closed
          if (closed < batchSize) break
        }
        if (closedCount > 0) logger.info({ closedCount }, 'expired unpaid orders closed')
      } catch (error) {
        logger.warn({ err: error }, 'unpaid order expiry pass failed')
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
