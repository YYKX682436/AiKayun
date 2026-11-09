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
import { sql, type Kysely } from 'kysely'
import { Pool } from 'pg'
import { Type } from 'typebox'
import type { AppConfig } from './config.js'
import type { Database } from './db/types.js'
import { registerAdminAuthRoutes } from './auth/admin.js'
import { requireAdmin } from './auth/admin.js'
import { registerInitialAdminSetupRoutes } from './auth/initial-admin.js'
import { registerCustomerAuthRoutes } from './auth/customer.js'
import { registerCustomerPolicyRoutes } from './auth/customer-policy.js'
import { registerStoreBrandRoutes } from './auth/store-brand.js'
import { registerAdminCustomerRoutes } from './customers/admin.js'
import { hashPassword } from './auth/password.js'
import { registerAdminProductRoutes } from './catalog/admin-products.js'
import { registerAdminProductManagementRoutes } from './catalog/admin-product-management.js'
import { defaultProductIdentityFactory } from './catalog/admin-products.js'
import type { ProductIdentityFactory } from './catalog/admin-products.js'
import { registerAdminCategoryRoutes } from './catalog/admin-categories.js'
import { registerAdminProductDetailRoutes } from './catalog/admin-product-details.js'
import { registerAdminPurchaseFormRoutes } from './catalog/admin-purchase-forms.js'
import { registerAdminPurchaseFormLifecycleRoutes } from './catalog/admin-purchase-form-lifecycle.js'
import { registerAdminVariantMatrixRoutes } from './catalog/admin-variant-matrix.js'
import { registerAdminProductPriceRoutes } from './catalog/admin-product-prices.js'
import { registerAdminProductPricingRuleRoutes } from './catalog/admin-product-pricing-rules.js'
import { registerAdminInventoryRoutes } from './catalog/admin-inventory.js'
import { registerAdminCodePoolRoutes } from './catalog/admin-code-pool.js'
import { registerAdminFixedDeliveryRoutes } from './catalog/admin-fixed-delivery.js'
import { registerAdminPrivateFileDeliveryRoutes } from './catalog/admin-private-file-delivery.js'
import { registerAdminSupplierConnectionRoutes } from './catalog/admin-supplier-connections.js'
import { registerAdminSupplierProductMappingRoutes } from './catalog/admin-supplier-product-mappings.js'
import { registerAdminApiFulfillmentRoutes } from './catalog/admin-api-fulfillment.js'
import { registerProductMediaRoutes } from './media/admin.js'
import { registerPublicProductRoutes } from './catalog/public-products.js'
import { registerStorefrontFeaturedProductRoutes } from './catalog/storefront-featured-products.js'
import { registerCustomerCartRoutes } from './commerce/customer-cart.js'
import { registerCustomerPurchaseFormRoutes } from './commerce/customer-purchase-forms.js'
import { registerOrderRoutes } from './commerce/orders.js'
import { registerPrivateFileDownloadRoutes } from './commerce/private-file-downloads.js'
import { registerPaymentRoutes } from './payments/routes.js'
import { registerRefundRoutes } from './commerce/refunds.js'
import { registerWithdrawalRoutes } from './commerce/withdrawals.js'
import { ZpayEpayProvider } from './payments/zpay-epay.js'
import { createNewObligationGate, LicenseNewObligationError } from './licensing/new-obligation-gate.js'
import type { TrustedReleaseLicenseConfig } from './licensing/trusted-release-config.js'
import { loadEmbeddedTrustedReleaseLicenseConfig } from './licensing/trusted-release-config.js'
import { createReleaseBoundTrustStore } from './licensing/trust/service.js'
import { createTrustDatabaseCoordinator } from './licensing/trust/trust-database-coordinator.js'
import type { TrustBundleStore } from './licensing/trust/trust-bundle-store.js'
import { registerAdminLicenseActivationRoutes } from './licensing/admin-activation.js'
import type { TestLicenseTlsOptions } from './licensing/license-request-http.js'
import { createReadinessCheck } from './ops/readiness.js'
import { registerOperationsFileRoutes, registerOperationsRiskRoutes, registerOperationsWorkerRoutes } from './operations/risk.js'
import { registerOperationsDiagnosticsRoutes } from './operations/diagnostics.js'

export async function createAppInternal(options: {
  db: Kysely<Database>
  config: AppConfig
  logger?: boolean
  productIdentityFactory?: ProductIdentityFactory
  /** Loopback-only service endpoint for integration tests; rejected outside NODE_ENV=test. */
  paymentProviderBaseUrlForTests?: string
  /** Real signed evidence and trust configuration, for isolated integration tests only. */
  licenseForTests?: { releaseConfig: TrustedReleaseLicenseConfig; trustStore: TrustBundleStore; pool?: Pool; testTls?: TestLicenseTlsOptions }
  /** Simulates an unknown setup COMMIT acknowledgement; accepted only in a dedicated _test database. */
  adminSetupForTests?: { afterAdminSetupCommit?: () => void | Promise<void> }
}) {
  const { db, config } = options
  if (options.licenseForTests && (config.nodeEnv !== 'test' || process.env.NODE_ENV !== 'test')) {
    throw new Error('license_gate_test_options_forbidden')
  }
  if (options.adminSetupForTests && (config.nodeEnv !== 'test' || process.env.NODE_ENV !== 'test')) {
    throw new Error('admin_setup_test_options_forbidden')
  }
  if (options.adminSetupForTests) {
    const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)
    if (!database.rows[0]?.name.endsWith('_test')) throw new Error('admin_setup_test_database_required')
  }
  if (options.licenseForTests) {
    const businessDatabase = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)
    const name = businessDatabase.rows[0]?.name
    if (!name?.endsWith('_test')) throw new Error('license_gate_test_database_required')
    if (options.licenseForTests.pool) {
      const poolDatabase = await options.licenseForTests.pool.query<{ name: string }>('SELECT current_database() AS name')
      if (poolDatabase.rows[0]?.name !== name) throw new Error('license_gate_test_database_mismatch')
    }
  }
  const licensePool = options.licenseForTests?.pool ?? new Pool({
    ...config.database, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    application_name: 'aikayun-license-gate',
  })
  if (options.licenseForTests && !options.licenseForTests.pool) {
    try {
      const business = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)
      const poolDatabase = await licensePool.query<{ name: string }>('SELECT current_database() AS name')
      if (poolDatabase.rows[0]?.name !== business.rows[0]?.name) throw new Error('license_gate_test_database_mismatch')
    } catch (error) {
      await licensePool.end()
      throw error
    }
  }
  const gate = createNewObligationGate({ db, pool: licensePool, identityRoot: config.identityRoot,
    pendingKeyRoot: config.licensePendingKeyRoot, trustStoreRoot: config.licenseTrustStoreRoot,
    ...(options.licenseForTests ? { test: options.licenseForTests } : {}),
  })
  let releaseConfig: TrustedReleaseLicenseConfig | null = options.licenseForTests?.releaseConfig ?? null
  if (!releaseConfig) {
    try { releaseConfig = await loadEmbeddedTrustedReleaseLicenseConfig() } catch { releaseConfig = null }
  }
  const trustCoordinator = createTrustDatabaseCoordinator({ db, identityRoot: config.identityRoot })
  const activationTrustStore = releaseConfig
    ? options.licenseForTests?.trustStore.withCoordinator(trustCoordinator)
      ?? createReleaseBoundTrustStore(releaseConfig, config.licenseTrustStoreRoot, trustCoordinator)
    : null
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
      // Never serialize an exception's message, stack, cause, or attached data.
      serializers: { err: () => ({ type: 'Error', message: 'Operation failed', stack: '', code: 'UNEXPECTED_ERROR' }) },
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token', 'res.headers.set-cookie', 'req.body', 'req.body.bearerToken', 'req.body.credentials', 'req.headers.x-signature'],
        censor: '[REDACTED]',
      },
    },
    disableRequestLogging: true,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>()
  app.addHook('onRequest', async (request) => {
    request.log.info({ method: request.method, route: request.routeOptions.url ?? 'unmatched' }, 'request started')
  })
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ method: request.method, route: request.routeOptions.url ?? 'unmatched',
      statusCode: reply.statusCode, responseTime: reply.elapsedTime }, 'request completed')
  })
  if (!options.licenseForTests?.pool) app.addHook('onClose', async () => { await licensePool.end() })

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
  if (config.nodeEnv !== 'production') await app.register(swaggerUi, { routePrefix: '/api/docs' })

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v1/public/')
      || request.url.startsWith('/api/v1/customer/')
      || request.url.startsWith('/api/v1/checkout/')
      || request.url.startsWith('/api/v1/guest/')
      || request.url.startsWith('/api/v1/setup/')
      || request.url.startsWith('/api/v1/admin/')) {
      const cacheControl = String(reply.getHeader('cache-control') ?? '').toLowerCase()
      if (!cacheControl.split(',').some((directive) => directive.trim() === 'private')) {
        reply.header('cache-control', 'no-store')
      }
    }
    return payload
  })

  app.setErrorHandler((untypedError, request, reply) => {
    if (untypedError instanceof LicenseNewObligationError) {
      const message = untypedError.statusCode === 403
        ? '店铺暂时无法接受新的订单或充值。' : '店铺经营状态暂时无法确认。'
      return reply.code(untypedError.statusCode).send({
        error: { code: untypedError.code, message, details: untypedError.details }, meta: { requestId: request.id },
      })
    }
    const error = untypedError as FastifyError & { validation?: unknown }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500
    if (status >= 500) {
      // Errors may embed a rejected database row or a provider response in
      // arbitrary fields, including name and code. Log only a fixed category.
      request.log.error({ errorCode: 'INTERNAL_ERROR' }, 'request failed')
    }
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

  const checkReadiness = createReadinessCheck(db, config)
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
    if (await checkReadiness()) {
      return success({ status: 'ok', service: 'aikayun-api', database: 'ready' }, request.id)
    }
    return reply.code(503).send(failure('NOT_READY', 'The service is not ready', request.id))
  })

  registerOperationsDiagnosticsRoutes(app, db, config)
  registerOperationsRiskRoutes(app, db, config)
  registerOperationsWorkerRoutes(app, db, config)
  registerOperationsFileRoutes(app, db, config)

  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('base64url'))
  registerInitialAdminSetupRoutes(app, db, config, options.adminSetupForTests)
  registerAdminAuthRoutes(app, db, config, dummyPasswordHash)
  app.get('/api/v1/admin/license-status', {
    preHandler: requireAdmin(db, config),
    schema: { tags: ['admin'], summary: 'Read the local business license status', response: {
      200: ApiSuccessSchemaOf(Type.Object({ status: Type.String(), allowedUntil: Type.Union([Type.String(), Type.Null()]), retryable: Type.Boolean() })),
      401: ApiErrorSchema,
    } },
  }, async (request) => success(await gate.getDiagnostic(), request.id))
  registerAdminLicenseActivationRoutes({
    app, db, pool: licensePool, config, gate, releaseConfig, trustStore: activationTrustStore,
    ...(options.licenseForTests?.testTls === undefined ? {} : { testTls: options.licenseForTests.testTls }),
  })
  registerCustomerAuthRoutes(app, db, config, dummyPasswordHash)
  registerCustomerCartRoutes(app, db, config)
  await registerCustomerPurchaseFormRoutes(app, db, config)
  registerOrderRoutes(app, db, config, gate)
  registerPrivateFileDownloadRoutes(app, db, config)
  registerRefundRoutes(app, db, config)
  await registerWithdrawalRoutes(app, db, config)
  registerPaymentRoutes(app, db, config, new ZpayEpayProvider(paymentProviderBaseUrl), gate)
  registerCustomerPolicyRoutes(app, db, config)
  registerStoreBrandRoutes(app, db, config)
  registerAdminCustomerRoutes(app, db, config)
  const identityFactory = options.productIdentityFactory ?? defaultProductIdentityFactory
  registerAdminProductRoutes(app, db, config, identityFactory)
  registerAdminProductManagementRoutes(app, db, config, identityFactory)
  registerAdminCategoryRoutes(app, db, config)
  registerAdminProductDetailRoutes(app, db, config)
  registerAdminPurchaseFormRoutes(app, db, config)
  registerAdminPurchaseFormLifecycleRoutes(app, db, config)
  registerAdminVariantMatrixRoutes(app, db, config, identityFactory)
  registerAdminProductPriceRoutes(app, db, config)
  registerAdminProductPricingRuleRoutes(app, db, config)
  registerAdminInventoryRoutes(app, db, config)
  registerAdminCodePoolRoutes(app, db, config)
  registerAdminFixedDeliveryRoutes(app, db, config)
  registerAdminSupplierConnectionRoutes(app, db, config)
  registerAdminSupplierProductMappingRoutes(app, db, config)
  registerAdminApiFulfillmentRoutes(app, db, config)
  await registerAdminPrivateFileDeliveryRoutes(app, db, config)
  await registerProductMediaRoutes(app, db, config)
  registerPublicProductRoutes(app, db)
  registerStorefrontFeaturedProductRoutes(app, db, config)
  return app
}
