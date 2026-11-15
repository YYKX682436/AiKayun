import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely, Transaction } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CheckoutQuoteBodySchema,
  CheckoutQuoteSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type { CheckoutQuoteBody } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { optionalCustomer, type AuthenticatedCustomer, CUSTOMER_CSRF_COOKIE } from '../auth/customer.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import { quoteCheckoutPurchaseLines, CheckoutQuoteError } from './checkout-quote.js'
import { assertGuestSession, guestSessionCookie } from './orders.js'
import { PurchaseDraftServiceError } from './purchase-forms.js'
import { PurchaseLineError } from './purchase-lines.js'

async function lockCustomer(
  trx: Transaction<Database>,
  customer: AuthenticatedCustomer,
): Promise<void> {
  const owner = await trx.selectFrom('customers').select(['id', 'status', 'username'])
    .where('id', '=', customer.id)
    .forUpdate()
    .executeTakeFirst()
  if (!owner || owner.status !== 'active' || !owner.username) {
    throw new CheckoutQuoteError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
  }
}

function mapError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof CheckoutQuoteError
    || error instanceof PurchaseDraftServiceError
    || error instanceof PurchaseLineError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return reply.code(422).send(failure('QUOTE_AMOUNT_OUT_OF_RANGE', '报价金额超出当前结算金额范围。', requestId))
  }
  throw error
}

export function registerCheckoutQuoteRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticateOptionalCustomer = optionalCustomer(db, config)
  const csrfCheck = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)

  app.post('/api/v1/checkout/quote', {
    preHandler: [authenticateOptionalCustomer, csrfCheck],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'],
      summary: 'Calculate a fresh single-product checkout quote without creating an order',
      body: CheckoutQuoteBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CheckoutQuoteSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as CheckoutQuoteBody
      const quote = await db.transaction().execute(async (trx) => {
        if (request.customer) {
          await lockCustomer(trx, request.customer)
        }
        if (!request.customer && body.items.some(item => 'draftId' in item && item.draftId)) {
          await assertGuestSession(trx, request.cookies[guestSessionCookie], true)
        }
        const owner = request.customer
          ? { kind: 'customer' as const, customer: request.customer }
          : { kind: 'guest' as const, guestSessionToken: request.cookies[guestSessionCookie] ?? '' }
        return (await quoteCheckoutPurchaseLines(trx, body.items, owner, config)).quote
      })
      reply.header('cache-control', 'no-store')
      return success(quote, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })
}
