import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  StorefrontCustomerPolicySchema,
  UpdateStorefrontCustomerPolicyBodySchema,
  success,
} from '@aikayun/contracts'
import type { UpdateStorefrontCustomerPolicyBody } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { requireAdmin, verifyCsrf } from './admin.js'

function toPolicy(policy: {
  require_email: boolean
  require_phone: boolean
  guest_checkout_enabled: boolean
  guest_free_claim_enabled: boolean
  updated_at: Date
}) {
  return {
    requireEmail: policy.require_email,
    requirePhone: policy.require_phone,
    guestCheckoutEnabled: policy.guest_checkout_enabled,
    guestFreeClaimEnabled: policy.guest_free_claim_enabled,
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
      .select(['require_email', 'require_phone', 'guest_checkout_enabled', 'guest_free_claim_enabled', 'updated_at'])
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
      .select(['require_email', 'require_phone', 'guest_checkout_enabled', 'guest_free_claim_enabled', 'updated_at'])
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
    const policy = await db.transaction().execute(async (trx) => trx.updateTable('storefront_customer_policy')
      .set({
        require_email: body.requireEmail,
        require_phone: body.requirePhone,
        guest_checkout_enabled: body.guestCheckoutEnabled,
        guest_free_claim_enabled: body.guestFreeClaimEnabled,
        updated_at: new Date(),
      })
      .where('singleton', '=', true)
      .returning(['require_email', 'require_phone', 'guest_checkout_enabled', 'guest_free_claim_enabled', 'updated_at'])
      .executeTakeFirstOrThrow())
    reply.header('cache-control', 'no-store')
    return success(toPolicy(policy), request.id)
  })
}
