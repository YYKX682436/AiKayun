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
import { hashPassword } from './auth/password.js'
import { registerAdminProductRoutes } from './catalog/admin-products.js'
import { defaultProductIdentityFactory } from './catalog/admin-products.js'
import type { ProductIdentityFactory } from './catalog/admin-products.js'
import { registerAdminCategoryRoutes } from './catalog/admin-categories.js'
import { registerAdminProductDetailRoutes } from './catalog/admin-product-details.js'
import { registerAdminVariantMatrixRoutes } from './catalog/admin-variant-matrix.js'

export async function createApp(options: {
  db: Kysely<Database>
  config: AppConfig
  logger?: boolean
  productIdentityFactory?: ProductIdentityFactory
}) {
  const { db, config } = options
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
        { name: 'catalog', description: 'Product and SKU administration' },
      ],
    },
  })
  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  await app.register(swaggerUi, { routePrefix: '/api/docs' })

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
  const identityFactory = options.productIdentityFactory ?? defaultProductIdentityFactory
  registerAdminProductRoutes(app, db, config, identityFactory)
  registerAdminCategoryRoutes(app, db, config)
  registerAdminProductDetailRoutes(app, db, config)
  registerAdminVariantMatrixRoutes(app, db, config, identityFactory)
  return app
}
