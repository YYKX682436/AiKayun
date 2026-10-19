import { randomUUID } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ChangeCustomerPasswordBodySchema,
  CsrfTokenSchema,
  CustomerLoginBodySchema,
  CustomerLogoutSchema,
  CustomerPasswordChangedSchema,
  CustomerProfileSchema,
  CustomerRegisterBodySchema,
  CustomerSessionSchema,
  UpdateCustomerProfileBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  ChangeCustomerPasswordBody,
  CustomerLoginBody,
  CustomerRegisterBody,
  UpdateCustomerProfileBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  clearCsrfCookie,
  clearSessionCookie,
  createOpaqueToken,
  hashToken,
  setCsrfCookie,
  setSessionCookie,
  verifyDoubleSubmitCsrf,
} from './security.js'

export const CUSTOMER_SESSION_COOKIE = 'aikayun_customer_session'
export const CUSTOMER_CSRF_COOKIE = 'aikayun_customer_csrf'

export interface AuthenticatedCustomer {
  id: string
  username: string
  sessionId: string
  expiresAt: Date
}

declare module 'fastify' {
  interface FastifyRequest {
    customer: AuthenticatedCustomer | null
  }
}

class CustomerRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CustomerRouteError'
  }
}

function postgresConstraint(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (typeof candidate.constraint === 'string') return candidate.constraint
    current = candidate.cause
  }
  return undefined
}

function normalizeEmail(email: string | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? ''
  return normalized || null
}

function normalizePhone(phone: string | undefined): string | null {
  if (!phone) return null
  const normalized = phone.trim().replace(/[ ()-]/g, '')
  return normalized || null
}

function customerSession(
  customer: { id: string; username: string | null },
  expiresAt: Date,
) {
  if (!customer.username) throw new Error('Active customer is missing its username')
  return {
    customer: { id: customer.id, username: customer.username },
    expiresAt: expiresAt.toISOString(),
  }
}

function isPlausibleSessionToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
}

export function requireCustomer(db: Kysely<Database>, config: AppConfig): preHandlerHookHandler {
  return async (request, reply) => {
    const token = request.cookies[CUSTOMER_SESSION_COOKIE]
    if (!isPlausibleSessionToken(token)) {
      if (token) clearSessionCookie(reply, CUSTOMER_SESSION_COOKIE, config)
      return reply.code(401).send(failure('UNAUTHORIZED', 'Customer authentication is required', request.id))
    }

    const session = await db
      .selectFrom('customer_sessions')
      .innerJoin('customers', 'customers.id', 'customer_sessions.customer_id')
      .select([
        'customer_sessions.id as session_id',
        'customer_sessions.expires_at as expires_at',
        'customers.id as customer_id',
        'customers.username as username',
      ])
      .where('customer_sessions.token_hash', '=', hashToken(token))
      .where('customer_sessions.revoked_at', 'is', null)
      .where('customer_sessions.expires_at', '>', new Date())
      .where('customers.status', '=', 'active')
      .executeTakeFirst()

    if (!session || !session.username) {
      clearSessionCookie(reply, CUSTOMER_SESSION_COOKIE, config)
      return reply.code(401).send(failure('UNAUTHORIZED', 'Customer authentication is required', request.id))
    }

    request.customer = {
      id: session.customer_id,
      username: session.username,
      sessionId: session.session_id,
      expiresAt: new Date(session.expires_at),
    }
  }
}

export function registerCustomerAuthRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
  dummyPasswordHash: string,
): void {
  const csrfCheck = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)
  const authenticate = requireCustomer(db, config)

  app.get('/api/v1/customer/auth/csrf', {
    schema: {
      tags: ['customer-auth'],
      summary: 'Issue a CSRF token for customer actions',
      response: { 200: ApiSuccessSchemaOf(CsrfTokenSchema) },
    },
  }, async (request, reply) => {
    const csrfToken = createOpaqueToken()
    setCsrfCookie(reply, CUSTOMER_CSRF_COOKIE, csrfToken, config)
    reply.header('cache-control', 'no-store')
    return success({ csrfToken }, request.id)
  })

  app.post('/api/v1/customer/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: csrfCheck,
    schema: {
      tags: ['customer-auth'],
      summary: 'Register a storefront customer and create a customer session',
      body: CustomerRegisterBodySchema,
      response: {
        201: ApiSuccessSchemaOf(CustomerSessionSchema),
        400: ApiErrorSchema,
        403: ApiErrorSchema,
        409: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as CustomerRegisterBody
    const email = normalizeEmail(body.email)
    const phone = normalizePhone(body.phone)
    const passwordHash = await hashPassword(body.password)
    const sessionToken = createOpaqueToken()
    const customerId = randomUUID()
    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000)

    try {
      await db.transaction().execute(async (trx) => {
        const policy = await sql<{ require_email: boolean; require_phone: boolean }>`
          SELECT require_email, require_phone
          FROM storefront_customer_policy
          WHERE singleton
          FOR SHARE
        `.execute(trx)
        const requirements = policy.rows[0]
        if (!requirements) throw new Error('The storefront customer policy row is missing')
        if (requirements.require_email && !email) {
          throw new CustomerRouteError(400, 'REGISTRATION_REQUIREMENTS_NOT_MET', '注册需要填写有效邮箱地址。')
        }
        if (requirements.require_phone && !phone) {
          throw new CustomerRouteError(400, 'REGISTRATION_REQUIREMENTS_NOT_MET', '注册需要填写有效手机号。')
        }

        await trx.insertInto('customers').values({
          id: customerId,
          username: body.username,
          password_hash: passwordHash,
          email,
          email_verified_at: null,
          phone,
          phone_verified_at: null,
          status: 'active',
        }).execute()
        await trx.insertInto('customer_sessions').values({
          id: sessionId,
          customer_id: customerId,
          token_hash: hashToken(sessionToken),
          expires_at: expiresAt,
          revoked_at: null,
        }).execute()
      })
    } catch (error) {
      if (error instanceof CustomerRouteError) {
        return reply.code(400).send(failure(error.code, error.message, request.id))
      }
      if (postgresConstraint(error) === 'customers_username_lower_unique') {
        return reply.code(409).send(failure('USERNAME_TAKEN', '该用户名已被使用，请换一个用户名。', request.id))
      }
      throw error
    }

    setSessionCookie(reply, CUSTOMER_SESSION_COOKIE, sessionToken, config)
    reply.code(201)
    return success(customerSession({ id: customerId, username: body.username }, expiresAt), request.id)
  })

  app.post('/api/v1/customer/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: csrfCheck,
    schema: {
      tags: ['customer-auth'],
      summary: 'Create a storefront customer session',
      body: CustomerLoginBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerSessionSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as CustomerLoginBody
    const sessionToken = createOpaqueToken()
    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000)
    const previousToken = request.cookies[CUSTOMER_SESSION_COOKIE]
    let signedInCustomer: { id: string; username: string | null } | undefined

    const candidate = await db.selectFrom('customers')
      .select(['id', 'username', 'password_hash', 'status'])
      .where(sql<string>`lower(username)`, '=', body.username.toLowerCase())
      .executeTakeFirst()
    const passwordIsValid = await verifyPassword(body.password, candidate?.password_hash ?? dummyPasswordHash)
    if (!candidate || candidate.status !== 'active' || !passwordIsValid || !candidate.password_hash) {
      return reply.code(401).send(failure('INVALID_CREDENTIALS', '用户名或密码不正确。', request.id))
    }

    await db.transaction().execute(async (trx) => {
      const lockedCustomer = await trx.selectFrom('customers')
        .select(['id', 'username', 'password_hash', 'status'])
        .where('id', '=', candidate.id)
        .forUpdate()
        .executeTakeFirst()
      if (!lockedCustomer || lockedCustomer.status !== 'active'
        || lockedCustomer.password_hash !== candidate.password_hash || !lockedCustomer.username) return

      if (isPlausibleSessionToken(previousToken)) {
        await trx.updateTable('customer_sessions')
          .set({ revoked_at: new Date() })
          .where('token_hash', '=', hashToken(previousToken))
          .where('revoked_at', 'is', null)
          .execute()
      }
      await trx.insertInto('customer_sessions').values({
        id: sessionId,
        customer_id: lockedCustomer.id,
        token_hash: hashToken(sessionToken),
        expires_at: expiresAt,
        revoked_at: null,
      }).execute()
      signedInCustomer = { id: lockedCustomer.id, username: lockedCustomer.username }
    })

    if (!signedInCustomer) {
      return reply.code(401).send(failure('INVALID_CREDENTIALS', '用户名或密码不正确。', request.id))
    }

    setSessionCookie(reply, CUSTOMER_SESSION_COOKIE, sessionToken, config)
    reply.header('cache-control', 'no-store')
    return success(customerSession(signedInCustomer, expiresAt), request.id)
  })

  app.get('/api/v1/customer/session', {
    preHandler: authenticate,
    schema: {
      tags: ['customer-auth'],
      summary: 'Get the current storefront customer session',
      response: {
        200: ApiSuccessSchemaOf(CustomerSessionSchema),
        401: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return success(customerSession(request.customer!, request.customer!.expiresAt), request.id)
  })

  app.post('/api/v1/customer/auth/logout', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['customer-auth'],
      summary: 'Revoke the current storefront customer session',
      response: {
        200: ApiSuccessSchemaOf(CustomerLogoutSchema),
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const customer = request.customer
    if (customer) {
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom('customers')
          .select('id')
          .where('id', '=', customer.id)
          .forUpdate()
          .executeTakeFirst()
        const revokedCurrentSession = await trx.updateTable('customer_sessions')
          .set({ revoked_at: new Date() })
          .where('id', '=', customer.sessionId)
          .where('customer_id', '=', customer.id)
          .where('revoked_at', 'is', null)
          .returning('id')
          .executeTakeFirst()
        if (!revokedCurrentSession) {
          await trx.updateTable('customer_sessions')
            .set({ revoked_at: new Date() })
            .where('customer_id', '=', customer.id)
            .where('revoked_at', 'is', null)
            .execute()
        }
      })
    }
    clearSessionCookie(reply, CUSTOMER_SESSION_COOKIE, config)
    clearCsrfCookie(reply, CUSTOMER_CSRF_COOKIE, config)
    reply.header('cache-control', 'no-store')
    return success({ loggedOut: true }, request.id)
  })

  app.get('/api/v1/customer/profile', {
    preHandler: authenticate,
    schema: {
      tags: ['customer'],
      summary: 'Get the current customer profile',
      response: {
        200: ApiSuccessSchemaOf(CustomerProfileSchema),
        401: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const profile = await db.selectFrom('customers')
      .select(['id', 'username', 'email', 'email_verified_at', 'phone', 'phone_verified_at', 'created_at'])
      .where('id', '=', request.customer!.id)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (!profile) return reply.code(401).send(failure('UNAUTHORIZED', 'Customer authentication is required', request.id))

    reply.header('cache-control', 'no-store')
    return success({
      id: profile.id,
      username: profile.username!,
      email: profile.email,
      emailVerifiedAt: profile.email_verified_at?.toISOString() ?? null,
      phone: profile.phone,
      phoneVerifiedAt: profile.phone_verified_at?.toISOString() ?? null,
      createdAt: profile.created_at.toISOString(),
    }, request.id)
  })

  app.patch('/api/v1/customer/profile', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['customer'],
      summary: 'Update the current customer contact details',
      body: UpdateCustomerProfileBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerProfileSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as UpdateCustomerProfileBody
    const updates: { email?: string | null; phone?: string | null; updated_at: Date } = { updated_at: new Date() }
    if (Object.hasOwn(body, 'email')) updates.email = body.email ? normalizeEmail(body.email) : null
    if (Object.hasOwn(body, 'phone')) updates.phone = body.phone ? normalizePhone(body.phone) : null

    let profile
    try {
      profile = await db.transaction().execute(async (trx) => {
        const lockedCustomer = await trx.selectFrom('customers')
          .select('id')
          .where('id', '=', request.customer!.id)
          .where('status', '=', 'active')
          .forUpdate()
          .executeTakeFirst()
        if (!lockedCustomer) {
          throw new CustomerRouteError(401, 'UNAUTHORIZED', 'Customer authentication is required')
        }

        const activeSession = await trx.selectFrom('customer_sessions')
          .select('id')
          .where('id', '=', request.customer!.sessionId)
          .where('customer_id', '=', request.customer!.id)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', new Date())
          .forUpdate()
          .executeTakeFirst()
        if (!activeSession) {
          throw new CustomerRouteError(401, 'UNAUTHORIZED', 'Customer authentication is required')
        }

        return trx.updateTable('customers')
          .set(updates)
          .where('id', '=', request.customer!.id)
          .where('status', '=', 'active')
          .returning(['id', 'username', 'email', 'email_verified_at', 'phone', 'phone_verified_at', 'created_at'])
          .executeTakeFirst()
      })
    } catch (error) {
      if (error instanceof CustomerRouteError) {
        return reply.code(401).send(failure(error.code, error.message, request.id))
      }
      throw error
    }
    if (!profile) return reply.code(401).send(failure('UNAUTHORIZED', 'Customer authentication is required', request.id))

    reply.header('cache-control', 'no-store')
    return success({
      id: profile.id,
      username: profile.username!,
      email: profile.email,
      emailVerifiedAt: profile.email_verified_at?.toISOString() ?? null,
      phone: profile.phone,
      phoneVerifiedAt: profile.phone_verified_at?.toISOString() ?? null,
      createdAt: profile.created_at.toISOString(),
    }, request.id)
  })

  app.put('/api/v1/customer/password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['customer-auth'],
      summary: 'Change the customer password and rotate the current session',
      body: ChangeCustomerPasswordBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerPasswordChangedSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as ChangeCustomerPasswordBody
    const current = request.customer!
    const nextToken = createOpaqueToken()
    const nextSessionId = randomUUID()
    const nextExpiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000)
    const customerSnapshot = await db.selectFrom('customers')
      .select(['id', 'password_hash', 'status'])
      .where('id', '=', current.id)
      .executeTakeFirst()
    if (!customerSnapshot || customerSnapshot.status !== 'active' || !customerSnapshot.password_hash) {
      return reply.code(401).send(failure('UNAUTHORIZED', 'Customer authentication is required', request.id))
    }
    if (!await verifyPassword(body.currentPassword, customerSnapshot.password_hash)) {
      return reply.code(400).send(failure('CURRENT_PASSWORD_INCORRECT', '当前密码不正确。', request.id))
    }
    const nextPasswordHash = await hashPassword(body.newPassword)

    try {
      await db.transaction().execute(async (trx) => {
        const customer = await trx.selectFrom('customers')
          .select(['id', 'password_hash', 'status'])
          .where('id', '=', current.id)
          .forUpdate()
          .executeTakeFirst()
        if (!customer || customer.status !== 'active' || !customer.password_hash
          || customer.password_hash !== customerSnapshot.password_hash) {
          throw new CustomerRouteError(401, 'UNAUTHORIZED', 'Customer authentication is required')
        }

        const activeSession = await trx.selectFrom('customer_sessions')
          .select('id')
          .where('id', '=', current.sessionId)
          .where('customer_id', '=', current.id)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', new Date())
          .forUpdate()
          .executeTakeFirst()
        if (!activeSession) throw new CustomerRouteError(401, 'UNAUTHORIZED', 'Customer authentication is required')

        await trx.updateTable('customers')
          .set({ password_hash: nextPasswordHash, updated_at: new Date() })
          .where('id', '=', current.id)
          .execute()
        await trx.updateTable('customer_sessions')
          .set({ revoked_at: new Date() })
          .where('customer_id', '=', current.id)
          .where('revoked_at', 'is', null)
          .execute()
        await trx.insertInto('customer_sessions').values({
          id: nextSessionId,
          customer_id: current.id,
          token_hash: hashToken(nextToken),
          expires_at: nextExpiresAt,
          revoked_at: null,
        }).execute()
      })
    } catch (error) {
      if (error instanceof CustomerRouteError) {
        if (error.status === 401) return reply.code(401).send(failure(error.code, error.message, request.id))
        return reply.code(400).send(failure(error.code, error.message, request.id))
      }
      throw error
    }

    setSessionCookie(reply, CUSTOMER_SESSION_COOKIE, nextToken, config)
    reply.header('cache-control', 'no-store')
    return success({ passwordChanged: true, expiresAt: nextExpiresAt.toISOString() }, request.id)
  })
}
