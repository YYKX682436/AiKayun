import { randomUUID } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { Type } from 'typebox'
import { ApiErrorSchema, ApiSuccessSchemaOf, failure, success } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { hashPassword } from './password.js'
import {
  clearCsrfCookie,
  createOpaqueToken,
  hashToken,
  setCsrfCookie,
  verifyDoubleSubmitCsrf,
} from './security.js'

export const SETUP_SESSION_COOKIE = 'aikayun_setup_session'
export const SETUP_CSRF_COOKIE = 'aikayun_setup_csrf'
const SETUP_LOCK = 'aikayun:admin:init'

declare module 'fastify' {
  interface FastifyRequest {
    setupSessionHash: string | null
  }
}

export class InitialAdminInputError extends Error {
  constructor(readonly code: 'invalid_email' | 'password_too_short' | 'password_too_long' | 'password_contains_email_name') {
    super(code)
    this.name = 'InitialAdminInputError'
  }
}

export function normalizeAndValidateInitialAdmin(emailValue: string, password: string): string {
  const email = emailValue.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new InitialAdminInputError('invalid_email')
  }
  if (password.length < 14) throw new InitialAdminInputError('password_too_short')
  if (password.length > 1024) throw new InitialAdminInputError('password_too_long')
  const localPart = email.split('@')[0] ?? ''
  if (localPart && password.toLowerCase().includes(localPart)) {
    throw new InitialAdminInputError('password_contains_email_name')
  }
  return email
}

/** Compatibility path for the existing one-shot `admin:init` CLI. */
export async function initializeAdminThroughCli(
  db: Kysely<Database>,
  emailValue: string,
  password: string,
): Promise<{ id: string; email: string }> {
  const email = normalizeAndValidateInitialAdmin(emailValue, password)
  const passwordHash = await hashPassword(password)
  const id = randomUUID()
  await db.transaction().execute(async transaction => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`.execute(transaction)
    const setupState = await transaction.selectFrom('admin_setup_state').selectAll()
      .where('singleton', '=', true).forUpdate().executeTakeFirst()
    if (!setupState) throw new Error('Initial setup state is unavailable; apply database migrations first')
    const adminCount = await transaction.selectFrom('admin_users')
      .select(expression => expression.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow()
    if (setupState.state === 'completed' || Number(adminCount.count) > 0) {
      throw new Error('An administrator already exists; initial setup is one-time only')
    }
    await transaction.insertInto('admin_users').values({ id, email, password_hash: passwordHash }).execute()
    await transaction.updateTable('admin_setup_state').set({
      state: 'completed', token_hash: null, token_expires_at: null,
      admin_user_id: id, completed_by_session_hash: null,
      completed_at: new Date(), updated_at: new Date(),
    }).where('singleton', '=', true).execute()
  })
  return { id, email }
}

export async function issueInitialSetupToken(db: Kysely<Database>): Promise<
  { status: 'issued'; token: string; expiresAt: string } | { status: 'completed' }
> {
  const token = createOpaqueToken()
  const tokenHash = hashToken(token)
  try {
    await db.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`.execute(trx)
      const state = await trx.selectFrom('admin_setup_state').selectAll()
        .where('singleton', '=', true).forUpdate().executeTakeFirst()
      if (!state) throw new Error('admin_setup_state_missing')
      const administrator = await trx.selectFrom('admin_users').select('id').limit(1).executeTakeFirst()
      if (state.state === 'completed' || administrator) {
        if (state.state !== 'completed') {
          await trx.updateTable('admin_setup_state').set({
            state: 'completed', token_hash: null, token_expires_at: null,
            admin_user_id: administrator?.id ?? null, completed_at: new Date(),
            completed_by_session_hash: null, updated_at: new Date(),
          }).where('singleton', '=', true).execute()
        }
        return
      }
      const row = await sql<{ expires_at: Date; generation: string }>`
        UPDATE admin_setup_state
        SET state = 'open', token_hash = ${tokenHash},
            token_expires_at = clock_timestamp() + interval '30 minutes',
            token_generation = token_generation + 1,
            admin_user_id = NULL, completed_by_session_hash = NULL,
            completed_at = NULL, updated_at = clock_timestamp()
        WHERE singleton = true
        RETURNING token_expires_at AS expires_at, token_generation::text AS generation
      `.execute(trx)
      if (!row.rows[0]) throw new Error('admin_setup_state_missing')
      await trx.deleteFrom('admin_setup_sessions')
        .where('token_generation', '<>', row.rows[0].generation)
        .execute()
      await sql`DELETE FROM admin_setup_sessions WHERE expires_at <= clock_timestamp()`.execute(trx)
    })
  } catch (error) {
    // COMMIT may have succeeded while its acknowledgement was lost. Only print the token
    // if the database confirms that this exact hash is still the active, unexpired token.
    const state = await db.selectFrom('admin_setup_state').select(['state', 'token_hash', 'token_expires_at',
      sql<boolean>`token_expires_at > clock_timestamp()`.as('token_is_fresh')])
      .where('singleton', '=', true).executeTakeFirst().catch(() => undefined)
    if (!state || state.state !== 'open' || state.token_hash !== tokenHash ||
      !state.token_expires_at || !state.token_is_fresh) {
      if (state?.state === 'completed') return { status: 'completed' }
      throw error
    }
  }
  const state = await db.selectFrom('admin_setup_state').select(['state', 'token_hash', 'token_expires_at',
    sql<boolean>`token_expires_at > clock_timestamp()`.as('token_is_fresh')])
    .where('singleton', '=', true).executeTakeFirst()
  if (state?.state === 'completed') return { status: 'completed' }
  if (state?.state !== 'open' || state.token_hash !== tokenHash || !state.token_expires_at || !state.token_is_fresh) {
    throw new Error('setup_token_commit_unavailable')
  }
  return { status: 'issued', token, expiresAt: state.token_expires_at.toISOString() }
}

function requireSetupHttps(config: AppConfig): preHandlerHookHandler {
  return async (request, reply) => {
    if (config.nodeEnv === 'production' && (config.publicOrigin.startsWith('https://') !== true || request.protocol !== 'https')) {
      return reply.code(403).send(failure('SETUP_HTTPS_REQUIRED', 'Setup is available only through HTTPS', request.id))
    }
  }
}

function requireSetupSession(db: Kysely<Database>, config: AppConfig): preHandlerHookHandler {
  return async (request, reply) => {
    const cookie = request.cookies[SETUP_SESSION_COOKIE]
    const sessionHash = cookie ? hashToken(cookie) : null
    if (!sessionHash) return reply.code(401).send(failure('SETUP_SESSION_REQUIRED', 'A valid setup session is required', request.id))
    const current = await sql<{
      setup_state: 'locked' | 'open' | 'completed'
      session_hash: string | null
      token_generation: string | null
    }>`
      SELECT state.state AS setup_state, sessions.session_hash, sessions.token_generation::text
      FROM admin_setup_state AS state
      LEFT JOIN admin_setup_sessions AS sessions
        ON sessions.session_hash = ${sessionHash}
        AND sessions.expires_at > clock_timestamp()
        AND state.state = 'open'
        AND state.token_expires_at > clock_timestamp()
        AND state.token_generation = sessions.token_generation
      WHERE state.singleton = true
    `.execute(db).catch(() => undefined)
    if (current?.rows[0]?.setup_state === 'completed') {
      return reply.code(409).send(failure('SETUP_ALREADY_COMPLETED', 'Initial setup has already been completed', request.id))
    }
    if (!current?.rows[0]?.session_hash) {
      clearCsrfCookie(reply, SETUP_CSRF_COOKIE, config)
      return reply.code(401).send(failure('SETUP_SESSION_EXPIRED', 'The setup session has expired', request.id))
    }
    request.setupSessionHash = current.rows[0].session_hash
  }
}

export function registerInitialAdminSetupRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
  testHooks?: { afterAdminSetupCommit?: () => void | Promise<void> },
): void {
  app.decorateRequest('setupSessionHash', null)
  const requireHttps = requireSetupHttps(config)
  const verifyCsrf = verifyDoubleSubmitCsrf(config, SETUP_CSRF_COOKIE)
  const setupSession = requireSetupSession(db, config)

  app.get('/api/v1/setup/status', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { response: { 200: ApiSuccessSchemaOf(Type.Object({ status: Type.String() })), 503: ApiErrorSchema } },
  }, async request => {
    const state = await db.selectFrom('admin_setup_state').select(['state']).where('singleton', '=', true).executeTakeFirst()
    if (!state) return success({ status: 'unavailable' }, request.id)
    const administrator = await db.selectFrom('admin_users').select('id').limit(1).executeTakeFirst()
    return success({ status: state.state === 'completed' || administrator ? 'completed' : 'required' }, request.id)
  })

  app.get('/api/v1/setup/csrf', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const token = createOpaqueToken()
    setCsrfCookie(reply, SETUP_CSRF_COOKIE, token, config)
    return success({ csrfToken: token }, request.id)
  })

  app.post('/api/v1/setup/verify', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: [requireHttps, verifyCsrf],
    schema: {
      body: Type.Object({ token: Type.String({ minLength: 43, maxLength: 43 }) }, { additionalProperties: false }),
      response: { 200: ApiSuccessSchemaOf(Type.Object({ authenticated: Type.Boolean() })), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { token } = request.body as { token: string }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token ||
      Buffer.from(token, 'base64url').length !== 32) {
      return reply.code(400).send(failure('SETUP_TOKEN_INVALID', 'The setup token is invalid or has expired', request.id))
    }
    const tokenHash = hashToken(token)
    const opaqueSession = createOpaqueToken()
    const sessionHash = hashToken(opaqueSession)
    const result = await db.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`.execute(trx)
      const state = await trx.selectFrom('admin_setup_state').selectAll()
        .where('singleton', '=', true).forUpdate().executeTakeFirst()
      if (!state) return { status: 'invalid' as const }
      const admin = await trx.selectFrom('admin_users').select('id').limit(1).executeTakeFirst()
      if (state.state === 'completed' || admin) return { status: 'completed' as const }
      const inserted = await sql<{ expires_at: Date }>`
        INSERT INTO admin_setup_sessions (session_hash, token_generation, expires_at)
        SELECT ${sessionHash}, token_generation,
          LEAST(clock_timestamp() + interval '10 minutes', token_expires_at)
        FROM admin_setup_state
        WHERE singleton = true AND state = 'open' AND token_hash = ${tokenHash}
          AND token_expires_at > clock_timestamp()
        RETURNING expires_at
      `.execute(trx)
      const sessionExpiresAt = inserted.rows[0]?.expires_at
      if (!sessionExpiresAt || state.state !== 'open' || state.token_hash !== tokenHash) return { status: 'invalid' as const }
      await sql`DELETE FROM admin_setup_sessions WHERE expires_at <= clock_timestamp()`.execute(trx)
      return { status: 'ok' as const }
    })
    if (result.status === 'completed') return reply.code(409).send(failure('SETUP_ALREADY_COMPLETED', 'Initial setup has already been completed', request.id))
    if (result.status !== 'ok') {
      return reply.code(401).send(failure('SETUP_TOKEN_INVALID_OR_EXPIRED', 'The setup token is invalid or has expired', request.id))
    }
    reply.setCookie(SETUP_SESSION_COOKIE, opaqueSession, {
      httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/',
      maxAge: 10 * 60,
    })
    return success({ authenticated: true }, request.id)
  })

  app.post('/api/v1/setup/admin', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: [requireHttps, setupSession, verifyCsrf],
    schema: {
      body: Type.Object({ email: Type.String({ minLength: 3, maxLength: 254 }), password: Type.String({ minLength: 14, maxLength: 1024 }) }, { additionalProperties: false }),
      response: { 200: ApiSuccessSchemaOf(Type.Object({ completed: Type.Boolean() })), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const sessionHash = request.setupSessionHash
    if (!sessionHash) return reply.code(401).send(failure('SETUP_SESSION_REQUIRED', 'A valid setup session is required', request.id))
    const body = request.body as { email: string; password: string }
    let email: string
    try { email = normalizeAndValidateInitialAdmin(body.email, body.password) } catch (error) {
      const code = error instanceof InitialAdminInputError ? error.code : 'invalid_email'
      const messages: Record<string, string> = {
        invalid_email: 'Enter a valid administrator email address',
        password_too_short: 'Use a password with at least 14 characters',
        password_too_long: 'Use a password with no more than 1024 characters',
        password_contains_email_name: 'The password cannot contain the email name',
      }
      return reply.code(400).send(failure('SETUP_ADMIN_CREDENTIALS_INVALID', messages[code]!, request.id))
    }
    const adminId = randomUUID()
    const passwordHash = await hashPassword(body.password)
    let created = false
    let conflict = false
    try {
      await db.transaction().execute(async trx => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`.execute(trx)
        const state = await trx.selectFrom('admin_setup_state').selectAll()
          .where('singleton', '=', true).forUpdate().executeTakeFirst()
        if (!state) throw new Error('admin_setup_state_missing')
        if (state.state === 'completed') { conflict = true; return }
        const tokenFresh = await sql<{ fresh: boolean }>`
          SELECT token_expires_at > clock_timestamp() AS fresh
          FROM admin_setup_state WHERE singleton = true
        `.execute(trx)
        if (state.state !== 'open' || !state.token_expires_at || !tokenFresh.rows[0]?.fresh ||
          state.token_hash === null) throw new Error('setup_token_expired')
        const session = await sql<{ session_hash: string }>`
          SELECT session_hash
          FROM admin_setup_sessions
          WHERE session_hash = ${sessionHash} AND token_generation = ${state.token_generation}
            AND expires_at > clock_timestamp()
          FOR UPDATE
        `.execute(trx)
        if (!session.rows[0]) throw new Error('setup_session_expired')
        const existing = await trx.selectFrom('admin_users').select('id').limit(1).executeTakeFirst()
        if (existing) { conflict = true; return }
        await trx.insertInto('admin_users').values({ id: adminId, email, password_hash: passwordHash }).execute()
        await trx.updateTable('admin_setup_state').set({
          state: 'completed', token_hash: null, token_expires_at: null, admin_user_id: adminId,
          completed_by_session_hash: sessionHash, completed_at: new Date(), updated_at: new Date(),
        }).where('singleton', '=', true).execute()
        created = true
      })
      if (created) await testHooks?.afterAdminSetupCommit?.()
    } catch (error) {
      // Resolve an unknown COMMIT by reading committed state; never retry an insert or password update.
      const state = await db.selectFrom('admin_setup_state').select(['state', 'completed_by_session_hash'])
        .where('singleton', '=', true).executeTakeFirst().catch(() => undefined)
      if (state?.state === 'completed' && state.completed_by_session_hash === sessionHash) {
        reply.clearCookie(SETUP_SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'strict' })
        clearCsrfCookie(reply, SETUP_CSRF_COOKIE, config)
        return success({ completed: true }, request.id)
      }
      if (state?.state === 'completed') conflict = true
      else if (error instanceof Error && ['setup_token_expired', 'setup_session_expired'].includes(error.message)) {
        return reply.code(401).send(failure('SETUP_SESSION_EXPIRED', 'The setup session has expired', request.id))
      } else {
        return reply.code(503).send(failure('SETUP_RESULT_UNAVAILABLE', 'Setup result could not be confirmed; check the server setup status before retrying', request.id))
      }
    }
    if (conflict || !created) return reply.code(409).send(failure('SETUP_ALREADY_COMPLETED', 'Initial setup has already been completed', request.id))
    reply.clearCookie(SETUP_SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'strict' })
    clearCsrfCookie(reply, SETUP_CSRF_COOKIE, config)
    return success({ completed: true }, request.id)
  })
}
