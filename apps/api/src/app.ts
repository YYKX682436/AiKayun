import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { registerAjvFormats, TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyError } from 'fastify'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  failure,
  HealthSchema,
  ReadySchema,
  success,
} from '@aikayun/contracts'
import type { Kysely } from 'kysely'
import type { AppConfig } from './config.js'
import type { Database } from './db/types.js'
import { registerAdminAuthRoutes } from './auth/admin.js'
import { registerCustomerAuthRoutes } from './auth/customer.js'
import { registerCustomerPolicyRoutes } from './auth/customer-policy.js'
import { registerAdminCustomerRoutes } from './customers/admin.js'
import { hashPassword } from './auth/password.js'
import { registerAdminProductRoutes } from './catalog/admin-products.js'
import { registerAdminProductManagementRoutes } from './catalog/admin-product-management.js'
import { defaultProductIdentityFactory } from './catalog/admin-products.js'
import type { ProductIdentityFactory } from './catalog/admin-products.js'
import { registerAdminCategoryRoutes } from './catalog/admin-categories.js'
import { registerAdminProductDetailRoutes } from './catalog/admin-product-details.js'
import { registerAdminVariantMatrixRoutes } from './catalog/admin-variant-matrix.js'
import { registerAdminProductPriceRoutes } from './catalog/admin-product-prices.js'
import { registerAdminInventoryRoutes } from './catalog/admin-inventory.js'
import { registerProductMediaRoutes } from './media/admin.js'
import { registerPublicProductRoutes } from './catalog/public-products.js'
import { registerCustomerCartRoutes } from './commerce/customer-cart.js'
import { registerOrderRoutes } from './commerce/orders.js'
import { registerPaymentRoutes } from './payments/routes.js'
import { registerRefundRoutes } from './commerce/refunds.js'
import { registerWithdrawalRoutes } from './commerce/withdrawals.js'
import { ZpayEpayProvider } from './payments/zpay-epay.js'

export async function createApp(options: {
  db: Kysely<Database>
  config: AppConfig
  logger?: boolean
  productIdentityFactory?: ProductIdentityFactory
  /** Loopback-only service endpoint for integration tests; rejected outside NODE_ENV=test. */
  paymentProviderBaseUrlForTests?: string
}) {
  const { db, config } = options
  let paymentProviderBaseUrl = 'https://zpayz.cn'
  if (options.paymentProviderBaseUrlForTests) {
    const testProviderUrl = new URL(options.paymentProviderBaseUrlForTests)
    if (config.nodeEnv !== 'test' || testProviderUrl.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(testProviderUrl.hostname)) {
      throw new Error('The payment provider test endpoint is restricted to loopback HTTP in NODE_ENV=test')
    }
    paymentProviderBaseUrl = options.paymentProviderBaseUrlForTests
  }
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token', 'res.headers.set-cookie'],
        censor: '[REDACTED]',
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorateRequest('admin', null)
  app.decorateRequest('customer', null)
  registerAjvFormats()
  app.setValidatorCompiler(TypeBoxValidatorCompiler)

  await app.register(swagger, {
    openapi: {
      info: { title: 'AiKayun API', version: '0.1.0', description: 'AiKayun digital commerce platform API' },
      servers: [{ url: config.publicOrigin }],
      tags: [
        { name: 'health', description: 'Service health checks' },
        { name: 'admin-auth', description: 'Administrator authentication' },
        { name: 'admin', description: 'Protected administrator APIs' },
        { name: 'customer-auth', description: 'Storefront customer authentication' },
        { name: 'customer', description: 'Protected storefront customer APIs' },
        { name: 'public-storefront', description: 'Public storefront settings' },
        { name: 'catalog', description: 'Product and SKU administration' },
        { name: 'customers', description: 'Protected customer administration and audit' },
        { name: 'public-catalog', description: 'Public product and visible category reads' },
        { name: 'payments', description: 'Customer payment attempts and provider callbacks' },
        { name: 'admin-payments', description: 'Protected payment channel configuration and reconciliation evidence' },
      ],
    },
  })
  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  await app.register(swaggerUi, { routePrefix: '/api/docs' })

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v1/public/')
      || request.url.startsWith('/api/v1/customer/')
      || request.url.startsWith('/api/v1/checkout/')
      || request.url.startsWith('/api/v1/guest/')
      || request.url.startsWith('/api/v1/admin/')) {
      reply.header('cache-control', 'no-store')
    }
    return payload
  })

  app.setErrorHandler((untypedError, request, reply) => {
    const error = untypedError as FastifyError & { validation?: unknown }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    const code = error.validation
      ? 'VALIDATION_ERROR'
      : status === 429
        ? 'RATE_LIMITED'
        : status >= 500
          ? 'INTERNAL_ERROR'
          : 'REQUEST_ERROR'
    const message = status === 429
      ? 'Too many requests'
      : status >= 500
        ? 'An unexpected error occurred'
        : error.validation
          ? 'The request contains invalid data'
          : error.message
    return reply.code(status).send(failure(code, message, request.id))
  })
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(failure('NOT_FOUND', 'The requested resource does not exist', request.id))
  })

  app.get('/api/v1/health/live', {
    schema: {
      tags: ['health'],
      summary: 'Check that the API process is alive',
      response: { 200: ApiSuccessSchemaOf(HealthSchema) },
    },
  }, async (request) => success({ status: 'ok' as const, service: 'aikayun-api' as const }, request.id))

  app.get('/api/v1/health/ready', {
    schema: {
      tags: ['health'],
      summary: 'Check API and database readiness',
      response: {
        200: ApiSuccessSchemaOf(ReadySchema),
        503: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      await db.selectNoFrom((expression) => expression.val(1).as('ready')).executeTakeFirstOrThrow()
      return success({ status: 'ok', service: 'aikayun-api', database: 'ready' }, request.id)
    } catch {
      return reply.code(503).send(failure('NOT_READY', 'The database is not available', request.id))
    }
  })

  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('base64url'))
  registerAdminAuthRoutes(app, db, config, dummyPasswordHash)
  registerCustomerAuthRoutes(app, db, config, dummyPasswordHash)
  registerCustomerCartRoutes(app, db, config)
  registerOrderRoutes(app, db, config)
  registerRefundRoutes(app, db, config)
  await registerWithdrawalRoutes(app, db, config)
  registerPaymentRoutes(app, db, config, new ZpayEpayProvider(paymentProviderBaseUrl))
  registerCustomerPolicyRoutes(app, db, config)
  registerAdminCustomerRoutes(app, db, config)
  const identityFactory = options.productIdentityFactory ?? defaultProductIdentityFactory
  registerAdminProductRoutes(app, db, config, identityFactory)
  registerAdminProductManagementRoutes(app, db, config, identityFactory)
  registerAdminCategoryRoutes(app, db, config)
  registerAdminProductDetailRoutes(app, db, config)
  registerAdminVariantMatrixRoutes(app, db, config, identityFactory)
  registerAdminProductPriceRoutes(app, db, config)
  registerAdminInventoryRoutes(app, db, config)
  await registerProductMediaRoutes(app, db, config)
  registerPublicProductRoutes(app, db)
  return app
}
