import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import { failure } from '@aikayun/contracts'

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function verifyDoubleSubmitCsrf(config: AppConfig, csrfCookieName: string): preHandlerHookHandler {
  return async (request, reply) => {
    const csrfCookie = request.cookies[csrfCookieName]
    const csrfHeader = request.headers['x-csrf-token']
    const headerToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader
    if (request.headers.origin !== config.publicOrigin || !constantTimeEqual(csrfCookie, headerToken)) {
      return reply.code(403).send(failure('CSRF_INVALID', 'The request could not be verified', request.id))
    }
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  name: string,
  token: string,
  config: AppConfig,
  maxAge = config.sessionTtlSeconds,
): void {
  reply.setCookie(name, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  })
}

export function clearSessionCookie(reply: FastifyReply, name: string, config: AppConfig): void {
  reply.clearCookie(name, { path: '/', secure: config.cookieSecure, sameSite: 'lax' })
}

export function setCsrfCookie(reply: FastifyReply, name: string, token: string, config: AppConfig): void {
  reply.setCookie(name, token, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionTtlSeconds,
  })
}

export function clearCsrfCookie(reply: FastifyReply, name: string, config: AppConfig): void {
  reply.clearCookie(name, { path: '/', secure: config.cookieSecure, sameSite: 'strict' })
}
