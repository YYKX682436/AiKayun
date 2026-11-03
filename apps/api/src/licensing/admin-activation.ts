import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Pool } from 'pg'
import { Type } from 'typebox'
import { ApiErrorSchema, ApiSuccessSchemaOf, failure, success } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import { withVerifiedInstallationSigningContext } from './installation-identity.js'
import type { NewObligationGate } from './new-obligation-gate.js'
import { createOrLoadActivationOperation, readActivationOperationPayload } from './license-operation-store.js'
import { activationCodeSha256 } from './license-intent.js'
import { createLicenseActivationClient, LicenseActivationClientError } from './license-activation-client.js'
import { createLicenseOperationRecoveryClient } from './license-operation-recovery-client.js'
import { createLicenseStateProjectionClient } from './license-state-projection.js'
import type { TestLicenseTlsOptions } from './license-request-http.js'
import type { TrustedReleaseLicenseConfig } from './trusted-release-config.js'
import { initializeReleaseTrustBundleIfNeeded } from './trust/initialize-release-bundle.js'
import { createLicenseTrustService } from './trust/service.js'
import type { TrustBundleStore } from './trust/trust-bundle-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CREDENTIAL = /^AK1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u

export class CombinedActivationCredentialError extends Error {
  constructor(readonly code: 'format_invalid' | 'license_id_invalid' | 'activation_code_invalid') {
    super(code)
    this.name = 'CombinedActivationCredentialError'
  }
}

export function parseCombinedActivationCredential(value: unknown): { licenseId: string; activationCode: string } {
  if (typeof value !== 'string' || value.length > 128) throw new CombinedActivationCredentialError('format_invalid')
  const match = CREDENTIAL.exec(value)
  if (!match) throw new CombinedActivationCredentialError('format_invalid')
  const licenseId = match[1]!
  if (!UUID.test(licenseId)) throw new CombinedActivationCredentialError('license_id_invalid')
  const activationCode = match[2]!
  try { activationCodeSha256(activationCode) } catch { throw new CombinedActivationCredentialError('activation_code_invalid') }
  return { licenseId: licenseId.toLowerCase(), activationCode }
}

async function findPendingActivation(db: Kysely<Database>, licenseId: string) {
  return db.selectFrom('local_license_operations').select(['operation_id', 'license_id', 'state'])
    .where('kind', '=', 'activation')
    .where('license_id', '=', licenseId)
    .where('state', 'in', ['pending', 'response_saved', 'projected'])
    .orderBy('created_at', 'desc').limit(1).executeTakeFirst()
}

function sameSecret(left: string, right: string): boolean {
  const leftHash = Buffer.from(activationCodeSha256(left), 'ascii')
  const rightHash = Buffer.from(activationCodeSha256(right), 'ascii')
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash)
}

function safeFailure(code: string): { message: string; retryable: boolean } {
  const retryable = !['activation_code_invalid', 'activation_license_invalid', 'operation_id_intent_conflict',
    'identity_binding_conflict', 'release_trust_unconfigured'].includes(code)
  const message = code === 'activation_code_invalid' || code === 'activation_license_invalid'
    ? '组合授权凭证无效，请核对后重试。'
    : code === 'license_trust_bundle_missing' || code === 'release_trust_store_unavailable'
      ? '发行信任材料尚未就绪，请检查签名发行工件后重试。'
      : '授权中心暂时无法确认本次操作。再次提交相同组合凭证会继续原操作。'
  return { message, retryable }
}

export function registerAdminLicenseActivationRoutes(input: {
  app: FastifyInstance
  db: Kysely<Database>
  pool: Pool
  config: AppConfig
  gate: NewObligationGate
  releaseConfig: TrustedReleaseLicenseConfig | null
  trustStore: TrustBundleStore | null
  testTls?: TestLicenseTlsOptions
}): void {
  const { app, db, pool, config, gate, releaseConfig, trustStore, testTls } = input
  const testTransport = testTls === undefined ? {} : { testTls }
  const authenticated = requireAdmin(db, config)
  const csrf = verifyCsrf(config)
  const activation = releaseConfig && trustStore ? createLicenseActivationClient({
    db, pool, identityRoot: config.identityRoot, pendingKeyRoot: config.licensePendingKeyRoot,
    releaseConfig, trustStore, ...testTransport,
  }) : null
  const recovery = releaseConfig && trustStore ? createLicenseOperationRecoveryClient({
    db, pool, identityRoot: config.identityRoot, pendingKeyRoot: config.licensePendingKeyRoot,
    releaseConfig, trustStore, ...testTransport,
  }) : null
  const projection = releaseConfig && trustStore ? createLicenseStateProjectionClient({
    db, pool, identityRoot: config.identityRoot, pendingKeyRoot: config.licensePendingKeyRoot,
    releaseConfig, trustStore, ...testTransport,
  }) : null

  app.get('/api/v1/admin/license-activation/status', {
    preHandler: authenticated,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], response: { 200: ApiSuccessSchemaOf(Type.Object({
      status: Type.String(), allowedUntil: Type.Union([Type.String(), Type.Null()]), retryable: Type.Boolean(),
      pendingOperation: Type.Union([Type.String(), Type.Null()]), trustBundle: Type.String(),
    })), 401: ApiErrorSchema } },
  }, async request => {
    const [license, pending, state] = await Promise.all([
      gate.getDiagnostic(),
      db.selectFrom('local_license_operations').select('state').where('kind', '=', 'activation')
        .where('state', 'in', ['pending', 'response_saved', 'projected']).orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
      db.selectFrom('instance_license_state').select(['license_id']).where('singleton', '=', true).executeTakeFirst(),
    ])
    let trustBundle: string
    if (!releaseConfig || !trustStore) trustBundle = 'release_unconfigured'
    else {
      try {
        const state = await createLicenseTrustService({ config: releaseConfig, store: trustStore,
          ...(testTls?.ca === undefined ? {} : { testCa: testTls.ca }),
          ...(testTls?.lookup === undefined ? {} : { testLookup: testTls.lookup }),
        }).status()
        trustBundle = state.status === 'ready' ? 'ready' : 'uninitialized'
      } catch {
        trustBundle = 'uninitialized'
      }
    }
    const pendingOperation = state?.license_id
      ? null
      : pending?.state === 'projected' ? 'projected' : pending?.state ?? null
    return success({ status: license.status, allowedUntil: license.allowedUntil, retryable: license.retryable,
      pendingOperation, trustBundle }, request.id)
  })

  app.post('/api/v1/admin/license-trust-bundle/import', {
    preHandler: [authenticated, csrf],
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'], summary: 'Import a root-signed license Trust Bundle',
      body: Type.Object({ bundleJws: Type.String({ minLength: 100, maxLength: 16 * 1024 }) }, { additionalProperties: false }),
      response: {
        200: ApiSuccessSchemaOf(Type.Object({ imported: Type.Boolean(), bundleVersion: Type.String() })),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    if (!releaseConfig || !trustStore) {
      return reply.code(503).send(failure('LICENSE_TRUST_UNCONFIGURED', '本发行版本没有可用的固定授权根。', request.id))
    }
    const bundleJws = (request.body as { bundleJws: string }).bundleJws
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(bundleJws)) {
      return reply.code(400).send(failure('LICENSE_TRUST_BUNDLE_INVALID', '签名信任文件格式无效。', request.id))
    }
    try {
      const imported = await createLicenseTrustService({ config: releaseConfig, store: trustStore }).importProvidedBundle(bundleJws)
      return success({ imported: true, bundleVersion: imported.bundleVersion }, request.id)
    } catch {
      return reply.code(400).send(failure('LICENSE_TRUST_BUNDLE_REJECTED', '签名、发行者、有效期或版本未通过固定授权根验证。', request.id))
    }
  })

  app.post('/api/v1/admin/license-activation', {
    preHandler: [authenticated, csrf],
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    schema: {
      tags: ['admin'], summary: 'Activate the installation with a combined license credential',
      body: Type.Object({ credential: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
      response: { 200: ApiSuccessSchemaOf(Type.Object({ status: Type.String(), allowedUntil: Type.Union([Type.String(), Type.Null()]), retryable: Type.Boolean() })),
        202: ApiSuccessSchemaOf(Type.Object({ status: Type.String(), allowedUntil: Type.Union([Type.String(), Type.Null()]), retryable: Type.Boolean() })),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    let credential: { licenseId: string; activationCode: string }
    try { credential = parseCombinedActivationCredential((request.body as { credential: string }).credential) } catch {
      return reply.code(400).send(failure('LICENSE_ACTIVATION_FORMAT_INVALID', '凭证格式应为 AK1.<licenseId>.<activationCode>。', request.id))
    }
    if (!releaseConfig || !trustStore || !activation || !recovery || !projection) {
      return reply.code(503).send(failure('LICENSE_TRUST_UNCONFIGURED', '本发行版本没有完整的生产授权信任配置。', request.id))
    }
    const currentState = await db.selectFrom('instance_license_state').select(['license_id'])
      .where('singleton', '=', true).executeTakeFirst()
    if (currentState?.license_id) {
      const license = await gate.getDiagnostic()
      return reply.code(409).send(failure('LICENSE_ALREADY_BOUND',
        license.status === 'active' || license.status === 'offline_valid'
          ? '此实例已经绑定授权。' : '此实例已有授权记录，请使用现有续签或恢复流程。', request.id))
    }

    let operationId: string | undefined
    try {
      await initializeReleaseTrustBundleIfNeeded({ config, releaseConfig, store: trustStore, ...testTransport })
      let existing = await findPendingActivation(db, credential.licenseId)
      if (existing) {
        const payload = await readActivationOperationPayload(db, config.licensePendingKeyRoot, existing.operation_id)
        if (!sameSecret(payload.activationCode, credential.activationCode)) {
          return reply.code(409).send(failure('LICENSE_ACTIVATION_PENDING',
            '此授权已有未完成操作，请使用原组合凭证继续。', request.id))
        }
        operationId = existing.operation_id
      } else {
        const identity = await withVerifiedInstallationSigningContext(pool, config.identityRoot, async snapshot => ({
          databaseId: snapshot.databaseId, instanceId: snapshot.instanceId, identityJkt: snapshot.identityJkt,
        }))
        const proposedOperationId = randomUUID()
        try {
          const stored = await createOrLoadActivationOperation(db, config.licensePendingKeyRoot, {
            operationId: proposedOperationId,
            licenseId: credential.licenseId,
            activationCode: credential.activationCode,
            instanceId: identity.instanceId,
            databaseId: identity.databaseId,
            identityJkt: identity.identityJkt,
            origin: null,
          })
          operationId = stored.operationId
        } catch (error) {
          // Handle a concurrent or unknown-COMMIT create by reading committed state and reusing it.
          existing = await findPendingActivation(db, credential.licenseId)
          if (!existing) throw error
          const payload = await readActivationOperationPayload(db, config.licensePendingKeyRoot, existing.operation_id)
          if (!sameSecret(payload.activationCode, credential.activationCode)) {
            return reply.code(409).send(failure('LICENSE_ACTIVATION_PENDING',
              '此授权已有未完成操作，请使用原组合凭证继续。', request.id))
          }
          operationId = existing.operation_id
        }
      }
      const attempts = await db.selectFrom('local_license_operation_attempts').select('attempt_no')
        .where('operation_id', '=', operationId).where('purpose', '=', 'activation').limit(1).executeTakeFirst()
      let rejectedCode: string | null = null
      if (!attempts) {
        const evidence = await activation.submitPendingActivation(operationId)
        if (evidence.purpose === 'verified_activation_rejection_unprojected') rejectedCode = evidence.outcomeCode
      } else {
        const result = await recovery.continuePendingActivation(operationId)
        const evidence = result.continuation ?? result.query
        if (evidence.state === 'rejected') rejectedCode = evidence.outcomeCode
        if (evidence.state === 'cancelled') {
          return reply.code(409).send(failure('LICENSE_ACTIVATION_CANCELLED', '授权中心已结束此激活操作。', request.id))
        }
      }
      if (rejectedCode === 'ACTIVATION_AUTHORIZATION_INVALID') {
        return reply.code(400).send(failure('LICENSE_ACTIVATION_CREDENTIAL_INVALID', '授权凭证未获授权，请核对组合凭证。', request.id))
      }
      await projection.projectPersistedOperation(operationId)
      const license = await projection.getLicenseSnapshot()
      if (license.status === 'active' || license.status === 'offline_valid') {
        return success({ status: license.status, allowedUntil: license.allowedUntil, retryable: false }, request.id)
      }
      return reply.code(202).send(success({ status: 'pending', allowedUntil: license.allowedUntil, retryable: true }, request.id))
    } catch (error) {
      const code = error instanceof LicenseActivationClientError ? error.code
        : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
          : error instanceof Error && /^[a-z][a-z0-9_]{1,96}$/u.test(error.message) ? error.message : 'activation_unavailable'
      const safe = safeFailure(code)
      return reply.code(safe.retryable ? 503 : 400).send(failure(
        safe.retryable ? 'LICENSE_ACTIVATION_UNAVAILABLE' : 'LICENSE_ACTIVATION_REJECTED', safe.message, request.id,
      ))
    }
  })
}
