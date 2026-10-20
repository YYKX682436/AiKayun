import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance } from 'fastify'
import type { CustomerProfile, CustomerSession } from '@aikayun/contracts'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { hashPassword } from '../src/auth/password.js'
import { hashToken } from '../src/auth/security.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const testOrigin = 'http://localhost:3000'
const oldPassword = 'Customer-Password-2026!'
const newPassword = 'Customer-Password-Updated-2026!'

let app: FastifyInstance
let db: Kysely<Database>
let nextIp = 10

function nextRemoteAddress(): string {
  const address = nextIp
  nextIp = nextIp === 250 ? 10 : nextIp + 1
  return `198.51.100.${address}`
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find(value => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0] ?? ''
}

function valueFromCookie(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1)
}

async function customerCsrf(target: FastifyInstance = app): Promise<{ token: string; cookie: string }> {
  const response = await target.inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
  expect(response.statusCode).toBe(200)
  return { token: response.json().data.csrfToken, cookie: cookieFrom(response, 'aikayun_customer_csrf') }
}

function customerHeaders(
  csrf: { token: string; cookie: string },
  sessionCookie?: string,
): Record<string, string> {
  return {
    origin: testOrigin,
    cookie: [sessionCookie, csrf.cookie].filter(Boolean).join('; '),
    'x-csrf-token': csrf.token,
  }
}

async function register(
  payload: Record<string, unknown>,
  options: { remoteAddress?: string; csrf?: { token: string; cookie: string } } = {},
) {
  const csrf = options.csrf ?? await customerCsrf()
  return app.inject({
    method: 'POST',
    url: '/api/v1/customer/auth/register',
    remoteAddress: options.remoteAddress ?? nextRemoteAddress(),
    headers: customerHeaders(csrf),
    payload,
  })
}

async function login(
  username: string,
  password: string,
  options: { remoteAddress?: string; sessionCookie?: string; csrf?: { token: string; cookie: string } } = {},
) {
  const csrf = options.csrf ?? await customerCsrf()
  return app.inject({
    method: 'POST',
    url: '/api/v1/customer/auth/login',
    remoteAddress: options.remoteAddress ?? nextRemoteAddress(),
    headers: customerHeaders(csrf, options.sessionCookie),
    payload: { username, password },
  })
}

async function registerAndReadSession(username: string, password = oldPassword) {
  const response = await register({ username, password })
  expect(response.statusCode).toBe(201)
  return {
    customer: response.json<{ data: CustomerSession }>().data.customer,
    sessionCookie: cookieFrom(response, 'aikayun_customer_session'),
  }
}

function customerReadHeaders(sessionCookie: string) {
  return { cookie: sessionCookie }
}

beforeAll(async () => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test')
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run customer API integration tests unless TEST_DATABASE_URL names a database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`drop schema public cascade`.execute(db)
  await sql`create schema public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error

  await db.insertInto('admin_users').values({
    id: randomUUID(),
    email: 'customer-auth-admin@example.test',
    password_hash: await hashPassword('Admin-Only-Password-2026!'),
  }).execute()

  const config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: testOrigin,
    COOKIE_SECURE: 'false',
  })
  app = await createApp({ db, config, logger: false })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
})

afterEach(async () => {
  if (db) {
    await db.updateTable('storefront_customer_policy').set({
      require_email: false,
      require_phone: false,
      guest_checkout_enabled: false,
      guest_free_claim_enabled: false,
    }).execute()
  }
})

describe('customer authentication and storefront policy with PostgreSQL', () => {
  it('registers atomically, hashes passwords, stores only a session digest and logs in case-insensitively', async () => {
    const csrf = await customerCsrf()
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/auth/register',
      headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token },
      payload: { username: 'new-customer', password: oldPassword },
    })
    expect(missingOrigin.statusCode).toBe(403)

    const response = await register({ username: 'NewCustomer', password: oldPassword }, { csrf })
    expect(response.statusCode).toBe(201)
    const result = response.json<{ data: CustomerSession }>().data
    expect(result.customer).toMatchObject({ id: expect.any(String), username: 'NewCustomer' })
    expect(JSON.stringify(response.json())).not.toContain(oldPassword)
    expect(JSON.stringify(response.json())).not.toContain('scrypt$')

    const sessionCookie = cookieFrom(response, 'aikayun_customer_session')
    const setCookies = response.headers['set-cookie']
    const sessionSetCookie = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .find(value => value?.startsWith('aikayun_customer_session='))
    expect(sessionSetCookie).toContain('HttpOnly')
    expect(sessionSetCookie).toContain('SameSite=Lax')
    expect(sessionSetCookie).not.toContain('Secure')
    const rawToken = valueFromCookie(sessionCookie)
    const customer = await db.selectFrom('customers').selectAll().where('id', '=', result.customer.id).executeTakeFirstOrThrow()
    expect(customer.password_hash).toMatch(/^scrypt\$/)
    expect(customer.password_hash).not.toContain(oldPassword)
    expect(customer).toMatchObject({ email: null, email_verified_at: null, phone: null, phone_verified_at: null })
    expect(await db.selectFrom('wallet_accounts').select('customer_id').where('customer_id', '=', customer.id).executeTakeFirst())
      .toEqual({ customer_id: customer.id })

    const session = await db.selectFrom('customer_sessions').selectAll().where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(session.token_hash).toBe(hashToken(rawToken))
    expect(session.token_hash).not.toContain(rawToken)
    expect(JSON.stringify(response.json())).not.toContain(rawToken)

    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/session',
      headers: customerReadHeaders(sessionCookie),
    })
    expect(current.statusCode).toBe(200)
    expect(current.json().data.customer.id).toBe(customer.id)

    const profile = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/profile',
      headers: customerReadHeaders(sessionCookie),
    })
    expect(profile.statusCode).toBe(200)
    expect(JSON.stringify(profile.json())).not.toContain(customer.password_hash)

    const caseInsensitiveLogin = await login('newcustomer', oldPassword)
    expect(caseInsensitiveLogin.statusCode).toBe(200)
    expect(cookieFrom(caseInsensitiveLogin, 'aikayun_customer_session')).not.toBe(sessionCookie)

    const duplicateCase = await register({ username: 'newcustomer', password: oldPassword })
    expect(duplicateCase.statusCode).toBe(409)
    expect(duplicateCase.json().error.code).toBe('USERNAME_TAKEN')

    const concurrent = await Promise.all([
      register({ username: 'raceusername', password: oldPassword }),
      register({ username: 'RACEUSERNAME', password: oldPassword }),
    ])
    expect(concurrent.map(result => result.statusCode).sort()).toEqual([201, 409])

    const wrongPassword = await login('NewCustomer', 'Wrong-Customer-Password-2026!')
    const unknownUsername = await login('unknown-customer', oldPassword)
    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownUsername.statusCode).toBe(401)
    expect(wrongPassword.json().error).toEqual(unknownUsername.json().error)
  })

  it('enforces per-IP login rate limits without requiring a captcha', async () => {
    const remoteAddress = '198.51.100.90'
    const results = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      results.push(await login('no-such-account', oldPassword, { remoteAddress }))
    }
    expect(results.every(response => response.statusCode === 401)).toBe(true)
    const limited = await login('no-such-account', oldPassword, { remoteAddress })
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('RATE_LIMITED')

    const registrationRemoteAddress = '198.51.100.91'
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const registered = await register({
        username: `rate-limited-${attempt}`,
        password: oldPassword,
      }, { remoteAddress: registrationRemoteAddress })
      expect(registered.statusCode).toBe(201)
    }
    const registrationLimited = await register({
      username: 'rate-limited-final',
      password: oldPassword,
    }, { remoteAddress: registrationRemoteAddress })
    expect(registrationLimited.statusCode).toBe(429)
    expect(registrationLimited.json().error.code).toBe('RATE_LIMITED')
  })

  it('sets secure session and CSRF cookies when the API runs in production mode', async () => {
    const productionConfig = readConfig({
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://store.example.test',
      COOKIE_SECURE: 'true',
    })
    const productionApp = await createApp({ db, config: productionConfig, logger: false })
    try {
      const csrf = await customerCsrf(productionApp)
      const csrfCookie = (await productionApp.inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' }))
      const csrfSetCookie = csrfCookie.headers['set-cookie']
      const csrfCookieHeader = (Array.isArray(csrfSetCookie) ? csrfSetCookie : [csrfSetCookie])
        .find(value => value?.startsWith('aikayun_customer_csrf='))
      expect(csrfCookieHeader).toContain('Secure')
      expect(csrfCookieHeader).toContain('SameSite=Strict')
      expect(csrfCookieHeader).not.toContain('HttpOnly')

      const response = await productionApp.inject({
        method: 'POST',
        url: '/api/v1/customer/auth/register',
        remoteAddress: nextRemoteAddress(),
        headers: { ...customerHeaders(csrf), origin: 'https://store.example.test' },
        payload: { username: 'secure-cookie-user', password: oldPassword },
      })
      expect(response.statusCode).toBe(201)
      const sessionSetCookie = (Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie']
        : [response.headers['set-cookie']])
        .find(value => value?.startsWith('aikayun_customer_session='))
      expect(sessionSetCookie).toContain('Secure')
      expect(sessionSetCookie).toContain('HttpOnly')
      expect(sessionSetCookie).toContain('SameSite=Lax')
      expect(sessionSetCookie).toContain('Max-Age=43200')
    } finally {
      await productionApp.close()
    }
  })

  it('applies current email and phone requirements only at registration and permits shared unverified contacts', async () => {
    const legacy = await registerAndReadSession('legacy-no-contact')
    await db.updateTable('storefront_customer_policy').set({ require_email: true }).execute()

    const missingEmail = await register({ username: 'email-required-user', password: oldPassword })
    expect(missingEmail.statusCode).toBe(400)
    expect(missingEmail.json().error.message).toContain('邮箱')

    const emailOnly = await register({
      username: 'email-only-user', password: oldPassword, email: 'shared@example.test',
    })
    expect(emailOnly.statusCode).toBe(201)
    await db.updateTable('storefront_customer_policy').set({ require_phone: true }).execute()

    const missingPhone = await register({
      username: 'phone-required-user', password: oldPassword, email: 'phone@example.test',
    })
    expect(missingPhone.statusCode).toBe(400)
    expect(missingPhone.json().error.message).toContain('手机号')

    const both = await register({
      username: 'both-required-user',
      password: oldPassword,
      email: 'shared@example.test',
      phone: '+86 138 0000 0001',
    })
    expect(both.statusCode).toBe(201)
    const sameUnverifiedContact = await register({
      username: 'same-unverified-contact',
      password: oldPassword,
      email: 'shared@example.test',
      phone: '+8613800000001',
    })
    expect(sameUnverifiedContact.statusCode).toBe(201)

    const legacyLogin = await login('LEGACY-NO-CONTACT', oldPassword)
    expect(legacyLogin.statusCode).toBe(200)
    expect((await app.inject({
      method: 'GET',
      url: '/api/v1/customer/session',
      headers: customerReadHeaders(legacy.sessionCookie),
    })).statusCode).toBe(200)
  })

  it('scopes profile access to the session customer and clears verification on contact changes', async () => {
    const first = await registerAndReadSession('profile-owner')
    const second = await registerAndReadSession('other-profile')
    const verifiedAt = new Date()
    await db.updateTable('customers').set({
      email: 'old@example.test',
      email_verified_at: verifiedAt,
      phone: '+8613900000000',
      phone_verified_at: verifiedAt,
    }).where('id', '=', first.customer.id).execute()

    const csrf = await customerCsrf()
    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/customer/profile',
      headers: customerHeaders(csrf, first.sessionCookie),
      payload: { email: 'new@example.test', phone: '+86 (139) 0000-0001' },
    })
    expect(changed.statusCode).toBe(200)
    const profile = changed.json<{ data: CustomerProfile }>().data
    expect(profile).toMatchObject({
      id: first.customer.id,
      email: 'new@example.test',
      emailVerifiedAt: null,
      phone: '+8613900000001',
      phoneVerifiedAt: null,
    })

    const ownWithSpoofedQuery = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/profile?customerId=${second.customer.id}`,
      headers: customerReadHeaders(first.sessionCookie),
    })
    expect(ownWithSpoofedQuery.json().data.id).toBe(first.customer.id)

    const spoofedUpdate = await app.inject({
      method: 'PATCH',
      url: '/api/v1/customer/profile',
      headers: customerHeaders(await customerCsrf(), first.sessionCookie),
      payload: { customerId: second.customer.id, email: 'attacker@example.test' },
    })
    expect(spoofedUpdate.statusCode).toBe(400)
    expect((await db.selectFrom('customers').select(['email', 'phone']).where('id', '=', second.customer.id)
      .executeTakeFirstOrThrow())).toEqual({ email: null, phone: null })

    const invalidOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/v1/customer/profile',
      headers: { ...customerHeaders(await customerCsrf(), first.sessionCookie), origin: 'https://attacker.example' },
      payload: { email: 'another@example.test' },
    })
    expect(invalidOrigin.statusCode).toBe(403)
    const invalidCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/customer/profile',
      headers: { ...customerHeaders(await customerCsrf(), first.sessionCookie), 'x-csrf-token': 'wrong-token' },
      payload: { email: 'another@example.test' },
    })
    expect(invalidCsrf.statusCode).toBe(403)
  })

  it('rotates sessions on password changes and immediately invalidates disabled, deleted and expired accounts', async () => {
    const account = await registerAndReadSession('password-owner')
    const secondLogin = await login('password-owner', oldPassword)
    const secondSession = cookieFrom(secondLogin, 'aikayun_customer_session')

    const wrongCurrentCsrf = await customerCsrf()
    const wrongCurrentPassword = await app.inject({
      method: 'PUT',
      url: '/api/v1/customer/password',
      headers: customerHeaders(wrongCurrentCsrf, account.sessionCookie),
      payload: { currentPassword: 'incorrect-current-password', newPassword },
    })
    expect(wrongCurrentPassword.statusCode).toBe(400)
    expect(wrongCurrentPassword.json().error.code).toBe('CURRENT_PASSWORD_INCORRECT')

    const changeCsrf = await customerCsrf()
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/v1/customer/password',
      headers: customerHeaders(changeCsrf, account.sessionCookie),
      payload: { currentPassword: oldPassword, newPassword },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().data.passwordChanged).toBe(true)
    const rotatedCookie = cookieFrom(changed, 'aikayun_customer_session')
    expect(rotatedCookie).not.toBe(account.sessionCookie)

    for (const oldCookie of [account.sessionCookie, secondSession]) {
      const oldSession = await app.inject({ method: 'GET', url: '/api/v1/customer/session', headers: customerReadHeaders(oldCookie) })
      expect(oldSession.statusCode).toBe(401)
    }
    expect((await app.inject({
      method: 'GET', url: '/api/v1/customer/session', headers: customerReadHeaders(rotatedCookie),
    })).statusCode).toBe(200)
    expect((await login('password-owner', oldPassword)).statusCode).toBe(401)
    expect((await login('password-owner', newPassword)).statusCode).toBe(200)

    const disabled = await registerAndReadSession('disabled-owner')
    await db.updateTable('customers').set({ status: 'disabled' }).where('id', '=', disabled.customer.id).execute()
    const revokedByDisable = await db.selectFrom('customer_sessions').select('revoked_at')
      .where('customer_id', '=', disabled.customer.id).executeTakeFirstOrThrow()
    expect(revokedByDisable.revoked_at).toBeInstanceOf(Date)
    expect((await app.inject({
      method: 'GET', url: '/api/v1/customer/session', headers: customerReadHeaders(disabled.sessionCookie),
    })).statusCode).toBe(401)
    await db.updateTable('customers').set({ status: 'active' }).where('id', '=', disabled.customer.id).execute()
    expect((await app.inject({
      method: 'GET', url: '/api/v1/customer/session', headers: customerReadHeaders(disabled.sessionCookie),
    })).statusCode).toBe(401)
    expect((await login('disabled-owner', oldPassword)).statusCode).toBe(200)

    const deleted = await registerAndReadSession('deleted-owner')
    await db.updateTable('customers').set({
      status: 'deleted',
      username: null,
      password_hash: null,
      email: null,
      email_verified_at: null,
      phone: null,
      phone_verified_at: null,
    }).where('id', '=', deleted.customer.id).execute()
    expect((await app.inject({
      method: 'GET', url: '/api/v1/customer/session', headers: customerReadHeaders(deleted.sessionCookie),
    })).statusCode).toBe(401)
    expect((await login('deleted-owner', oldPassword)).statusCode).toBe(401)
    const reusedUsername = await register({ username: 'deleted-owner', password: oldPassword })
    expect(reusedUsername.statusCode).toBe(201)
    expect(reusedUsername.json().data.customer.id).not.toBe(deleted.customer.id)
    expect((await db.selectFrom('customers').select(['status', 'username']).where('id', '=', deleted.customer.id)
      .executeTakeFirstOrThrow())).toEqual({ status: 'deleted', username: null })

    const expired = await registerAndReadSession('expired-owner')
    await db.updateTable('customer_sessions').set({
      created_at: new Date(Date.now() - 5000),
      expires_at: new Date(Date.now() - 1000),
    })
      .where('token_hash', '=', hashToken(valueFromCookie(expired.sessionCookie))).execute()
    expect((await app.inject({
      method: 'GET', url: '/api/v1/customer/session', headers: customerReadHeaders(expired.sessionCookie),
    })).statusCode).toBe(401)
  })

  it('serializes a concurrent logout and password rotation without leaving an unexpected active session', async () => {
    const account = await registerAndReadSession('concurrent-account-actions')
    const logoutCsrf = await customerCsrf()
    const passwordCsrf = await customerCsrf()
    const [logoutResponse, passwordResponse] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/customer/auth/logout',
        headers: customerHeaders(logoutCsrf, account.sessionCookie),
      }),
      app.inject({
        method: 'PUT',
        url: '/api/v1/customer/password',
        headers: customerHeaders(passwordCsrf, account.sessionCookie),
        payload: { currentPassword: oldPassword, newPassword },
      }),
    ])

    expect([200, 401]).toContain(logoutResponse.statusCode)
    expect([200, 401]).toContain(passwordResponse.statusCode)
    const activeSessions = await db.selectFrom('customer_sessions')
      .select('id')
      .where('customer_id', '=', account.customer.id)
      .where('revoked_at', 'is', null)
      .execute()

    if (logoutResponse.statusCode === 200) {
      expect(activeSessions).toHaveLength(0)
      if (passwordResponse.statusCode === 200) {
        const rotatedCookie = cookieFrom(passwordResponse, 'aikayun_customer_session')
        expect((await app.inject({
          method: 'GET',
          url: '/api/v1/customer/session',
          headers: customerReadHeaders(rotatedCookie),
        })).statusCode).toBe(401)
      }
    } else {
      expect(passwordResponse.statusCode).toBe(200)
      expect(activeSessions).toHaveLength(1)
      const rotatedCookie = cookieFrom(passwordResponse, 'aikayun_customer_session')
      expect((await app.inject({
        method: 'GET',
        url: '/api/v1/customer/session',
        headers: customerReadHeaders(rotatedCookie),
      })).statusCode).toBe(200)
    }
    expect((await app.inject({
      method: 'GET',
      url: '/api/v1/customer/session',
      headers: customerReadHeaders(account.sessionCookie),
    })).statusCode).toBe(401)
  })

  it('isolates customer and administrator cookies and protects real policy settings', async () => {
    const customer = await registerAndReadSession('policy-owner')
    const publicDefaults = await app.inject('/api/v1/public/storefront/customer-policy')
    expect(publicDefaults.statusCode).toBe(200)
    expect(publicDefaults.json().data).toMatchObject({
      requireEmail: false,
      requirePhone: false,
      guestCheckoutEnabled: false,
      guestFreeClaimEnabled: false,
    })

    const protectedWithoutAdmin = await app.inject('/api/v1/admin/storefront/customer-policy')
    expect(protectedWithoutAdmin.statusCode).toBe(401)

    const adminCsrf = await app.inject('/api/v1/admin/auth/csrf')
    const adminCsrfToken = adminCsrf.json().data.csrfToken as string
    const adminCsrfCookie = cookieFrom(adminCsrf, 'aikayun_admin_csrf')
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      remoteAddress: nextRemoteAddress(),
      headers: {
        origin: testOrigin,
        cookie: adminCsrfCookie,
        'x-csrf-token': adminCsrfToken,
      },
      payload: { email: 'customer-auth-admin@example.test', password: 'Admin-Only-Password-2026!' },
    })
    expect(adminLogin.statusCode).toBe(200)
    const adminCookie = cookieFrom(adminLogin, 'aikayun_admin_session')

    const adminCookieCannotReadCustomer = await app.inject({
      method: 'GET', url: '/api/v1/customer/profile', headers: customerReadHeaders(adminCookie),
    })
    expect(adminCookieCannotReadCustomer.statusCode).toBe(401)
    const customerCookieCannotReadAdmin = await app.inject({
      method: 'GET', url: '/api/v1/admin/overview', headers: customerReadHeaders(customer.sessionCookie),
    })
    expect(customerCookieCannotReadAdmin.statusCode).toBe(401)

    const policyCsrf = await app.inject('/api/v1/admin/auth/csrf')
    const policyCsrfToken = policyCsrf.json().data.csrfToken as string
    const policyCsrfCookie = cookieFrom(policyCsrf, 'aikayun_admin_csrf')
    const policyPayload = {
      requireEmail: true,
      requirePhone: true,
      guestCheckoutEnabled: true,
      guestFreeClaimEnabled: true,
      unpaidOrderTimeoutMinutes: 15,
      walletTopUpEnabled: false,
      walletTopUpMinAmount: '1.00',
      walletTopUpMaxAmount: '1000.00',
    }
    const badOrigin = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/storefront/customer-policy',
      headers: {
        origin: 'https://attacker.example',
        cookie: `${adminCookie}; ${policyCsrfCookie}`,
        'x-csrf-token': policyCsrfToken,
      },
      payload: policyPayload,
    })
    expect(badOrigin.statusCode).toBe(403)

    const update = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/storefront/customer-policy',
      headers: {
        origin: testOrigin,
        cookie: `${adminCookie}; ${policyCsrfCookie}`,
        'x-csrf-token': policyCsrfToken,
      },
      payload: policyPayload,
    })
    expect(update.statusCode).toBe(200)
    expect(update.json().data).toMatchObject(policyPayload)
    expect((await app.inject('/api/v1/public/storefront/customer-policy')).json().data).toMatchObject(policyPayload)

    const legacyLogin = await login('policy-owner', oldPassword)
    expect(legacyLogin.statusCode).toBe(200)
    const newAccountWithoutContacts = await register({ username: 'new-policy-owner', password: oldPassword })
    expect(newAccountWithoutContacts.statusCode).toBe(400)
    expect((await app.inject('/api/v1/customer/orders')).statusCode).toBe(401)
  })
})
