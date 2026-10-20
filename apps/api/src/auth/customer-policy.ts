import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  StorefrontCustomerPolicySchema,
  UpdateStorefrontCustomerPolicyBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type { UpdateStorefrontCustomerPolicyBody } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { normalizeWalletAmount } from '@aikayun/money'
import { requireAdmin, verifyCsrf } from './admin.js'

function toPolicy(policy: {
  require_email: boolean
  require_phone: boolean
  guest_checkout_enabled: boolean
  guest_free_claim_enabled: boolean
  unpaid_order_timeout_minutes: number
  wallet_top_up_enabled: boolean
  wallet_top_up_min_amount: string
  wallet_top_up_max_amount: string
  updated_at: Date
}) {
  return {
    requireEmail: policy.require_email,
    requirePhone: policy.require_phone,
    guestCheckoutEnabled: policy.guest_checkout_enabled,
    guestFreeClaimEnabled: policy.guest_free_claim_enabled,
    unpaidOrderTimeoutMinutes: policy.unpaid_order_timeout_minutes as 5 | 15 | 30,
    walletTopUpEnabled: policy.wallet_top_up_enabled,
    walletTopUpMinAmount: policy.wallet_top_up_min_amount,
    walletTopUpMaxAmount: policy.wallet_top_up_max_amount,
    updatedAt: policy.updated_at.toISOString(),
  }
}

export function registerCustomerPolicyRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  app.get('/api/v1/public/storefront/customer-policy', {
    schema: {
      tags: ['public-storefront'],
      summary: 'Read public customer registration and guest policy',
      response: { 200: ApiSuccessSchemaOf(StorefrontCustomerPolicySchema) },
    },
  }, async (request, reply) => {
    const policy = await db.selectFrom('storefront_customer_policy')
      .select(['require_email', 'require_phone', 'guest_checkout_enabled', 'guest_free_claim_enabled', 'unpaid_order_timeout_minutes', 'wallet_top_up_enabled', 'wallet_top_up_min_amount', 'wallet_top_up_max_amount', 'updated_at'])
      .where('singleton', '=', true)
      .executeTakeFirstOrThrow()
    reply.header('cache-control', 'no-store')
    return success(toPolicy(policy), request.id)
  })

  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/storefront/customer-policy', {
    preHandler: authenticate,
    schema: {
      tags: ['admin'],
      summary: 'Read customer registration and guest policy settings',
      response: {
        200: ApiSuccessSchemaOf(StorefrontCustomerPolicySchema),
        401: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const policy = await db.selectFrom('storefront_customer_policy')
      .select(['require_email', 'require_phone', 'guest_checkout_enabled', 'guest_free_claim_enabled', 'unpaid_order_timeout_minutes', 'wallet_top_up_enabled', 'wallet_top_up_min_amount', 'wallet_top_up_max_amount', 'updated_at'])
      .where('singleton', '=', true)
      .executeTakeFirstOrThrow()
    reply.header('cache-control', 'no-store')
    return success(toPolicy(policy), request.id)
  })

  app.put('/api/v1/admin/storefront/customer-policy', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin'],
      summary: 'Update customer registration and guest policy settings',
      body: UpdateStorefrontCustomerPolicyBodySchema,
      response: {
        200: ApiSuccessSchemaOf(StorefrontCustomerPolicySchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as UpdateStorefrontCustomerPolicyBody
    const updateResult = await db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('storefront_customer_policy')
        .select(['wallet_top_up_enabled', 'wallet_top_up_min_amount', 'wallet_top_up_max_amount'])
        .where('singleton', '=', true).forUpdate().executeTakeFirstOrThrow()
      let minTopUp: string
      let maxTopUp: string
      try {
        minTopUp = normalizeWalletAmount(body.walletTopUpMinAmount ?? current.wallet_top_up_min_amount)
        maxTopUp = normalizeWalletAmount(body.walletTopUpMaxAmount ?? current.wallet_top_up_max_amount)
      } catch {
        return { invalidLimits: '充值额度必须是有效的两位小数金额。' } as const
      }
      const toCents = (amount: string) => {
        const [whole, fraction] = amount.split('.')
        return BigInt(whole!) * 100n + BigInt(fraction!)
      }
      if (toCents(minTopUp) <= 0n || toCents(maxTopUp) < toCents(minTopUp)) {
        return { invalidLimits: '充值最高金额必须大于或等于最低金额，且最低金额必须大于零。' } as const
      }
      const policy = await trx.updateTable('storefront_customer_policy')
        .set({
          require_email: body.requireEmail,
          require_phone: body.requirePhone,
          guest_checkout_enabled: body.guestCheckoutEnabled,
          guest_free_claim_enabled: body.guestFreeClaimEnabled,
          unpaid_order_timeout_minutes: body.unpaidOrderTimeoutMinutes,
          wallet_top_up_enabled: body.walletTopUpEnabled ?? current.wallet_top_up_enabled,
          wallet_top_up_min_amount: minTopUp,
          wallet_top_up_max_amount: maxTopUp,
          updated_at: new Date(),
        })
        .where('singleton', '=', true)
        .returning(['require_email', 'require_phone', 'guest_checkout_enabled', 'guest_free_claim_enabled', 'unpaid_order_timeout_minutes', 'wallet_top_up_enabled', 'wallet_top_up_min_amount', 'wallet_top_up_max_amount', 'updated_at'])
        .executeTakeFirstOrThrow()
      return { policy } as const
    })
    if ('invalidLimits' in updateResult) {
      return reply.code(400).send(failure('TOP_UP_LIMIT_INVALID', updateResult.invalidLimits, request.id))
    }
    reply.header('cache-control', 'no-store')
    return success(toPolicy(updateResult.policy), request.id)
  })
}
