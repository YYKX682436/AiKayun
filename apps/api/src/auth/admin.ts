import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { Kysely } from 'kysely'
import {
  AdminLoginBodySchema,
  AdminLogoutSchema,
  AdminOverviewSchema,
  AdminSessionSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CsrfTokenSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type { AdminLoginBody } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { verifyPassword } from './password.js'

export const SESSION_COOKIE = 'aikayun_admin_session'
export const CSRF_COOKIE = 'aikayun_admin_csrf'

export interface AuthenticatedAdmin {
  id: string
  email: string
  sessionId: string
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AuthenticatedAdmin | null
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function verifyCsrf(config: AppConfig): preHandlerHookHandler {
  return async (request, reply) => {
    const csrfCookie = request.cookies[CSRF_COOKIE]
    const csrfHeader = request.headers['x-csrf-token']
    const headerToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader
    if (request.headers.origin !== config.publicOrigin || !constantTimeEqual(csrfCookie, headerToken)) {
      return reply.code(403).send(failure('CSRF_INVALID', 'The request could not be verified', request.id))
    }
  }
}

export function requireAdmin(db: Kysely<Database>, config: AppConfig): preHandlerHookHandler {
  return async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (!token) {
      return reply.code(401).send(failure('UNAUTHORIZED', 'Administrator authentication is required', request.id))
    }

    const session = await db
      .selectFrom('admin_sessions')
      .innerJoin('admin_users', 'admin_users.id', 'admin_sessions.admin_user_id')
      .select([
        'admin_sessions.id as session_id',
        'admin_users.id as admin_id',
        'admin_users.email as email',
      ])
      .where('admin_sessions.token_hash', '=', hashToken(token))
      .where('admin_sessions.revoked_at', 'is', null)
      .where('admin_sessions.expires_at', '>', new Date())
      .where('admin_users.is_active', '=', true)
      .executeTakeFirst()

    if (!session) {
      reply.clearCookie(SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'lax' })
      return reply.code(401).send(failure('UNAUTHORIZED', 'Administrator authentication is required', request.id))
    }

    request.admin = { id: session.admin_id, email: session.email, sessionId: session.session_id }
  }
}

export function registerAdminAuthRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
  dummyPasswordHash: string,
): void {
  const csrfCheck = verifyCsrf(config)
  const authenticate = requireAdmin(db, config)

  app.get('/api/v1/admin/auth/csrf', {
    schema: {
      tags: ['admin-auth'],
      summary: 'Issue a CSRF token for the admin session',
      response: { 200: ApiSuccessSchemaOf(CsrfTokenSchema) },
    },
  }, async (request, reply) => {
    const csrfToken = randomBytes(32).toString('base64url')
    reply.setCookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: config.sessionTtlSeconds,
    })
    return success({ csrfToken }, request.id)
  })

  app.post('/api/v1/admin/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: csrfCheck,
    schema: {
      tags: ['admin-auth'],
      summary: 'Create an administrator session',
      body: AdminLoginBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminSessionSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as AdminLoginBody
    const email = body.email.trim().toLowerCase()
    const admin = await db.selectFrom('admin_users')
      .select(['id', 'email', 'password_hash', 'is_active'])
      .where('email', '=', email)
      .executeTakeFirst()
    const passwordIsValid = await verifyPassword(body.password, admin?.password_hash ?? dummyPasswordHash)

    if (!admin || !admin.is_active || !passwordIsValid) {
      return reply.code(401).send(failure('INVALID_CREDENTIALS', 'Email or password is incorrect', request.id))
    }

    const sessionToken = randomBytes(32).toString('base64url')
    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000)
    await db.insertInto('admin_sessions').values({
      id: sessionId,
      admin_user_id: admin.id,
      token_hash: hashToken(sessionToken),
      expires_at: expiresAt,
      revoked_at: null,
    }).execute()

    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionTtlSeconds,
    })
    return success({
      admin: { id: admin.id, email: admin.email },
      expiresAt: expiresAt.toISOString(),
    }, request.id)
  })

  app.get('/api/v1/admin/session', {
    preHandler: authenticate,
    schema: {
      tags: ['admin-auth'],
      summary: 'Get the authenticated administrator session',
      response: { 200: ApiSuccessSchemaOf(AdminSessionSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const admin = request.admin
    if (!admin) return reply.code(401).send(failure('UNAUTHORIZED', 'Administrator authentication is required', request.id))
    const session = await db.selectFrom('admin_sessions')
      .select('expires_at')
      .where('id', '=', admin.sessionId)
      .executeTakeFirstOrThrow()
    return success({
      admin: { id: admin.id, email: admin.email },
      expiresAt: new Date(session.expires_at).toISOString(),
    }, request.id)
  })

  app.post('/api/v1/admin/auth/logout', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin-auth'],
      summary: 'Revoke the administrator session',
      response: {
        200: ApiSuccessSchemaOf(AdminLogoutSchema),
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const admin = request.admin
    if (admin) {
      await db.updateTable('admin_sessions')
        .set({ revoked_at: new Date() })
        .where('id', '=', admin.sessionId)
        .where('revoked_at', 'is', null)
        .execute()
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'lax' })
    reply.clearCookie(CSRF_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'strict' })
    return success({ loggedOut: true }, request.id)
  })

  app.get('/api/v1/admin/overview', {
    preHandler: authenticate,
    schema: {
      tags: ['admin'],
      summary: 'Administrator overview',
      response: { 200: ApiSuccessSchemaOf(AdminOverviewSchema), 401: ApiErrorSchema },
    },
  }, async (request, reply) => {
    if (!request.admin) return reply.code(401).send(failure('UNAUTHORIZED', 'Administrator authentication is required', request.id))
    return success({ administrator: request.admin.email, status: 'ready' }, request.id)
  })
}
