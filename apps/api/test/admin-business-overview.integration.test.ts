import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerAjvFormats, TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox'
import { failure } from '@aikayun/contracts'
import type { Database } from '../src/db/types.js'
import { readConfig } from '../src/config.js'
import { hashToken } from '../src/auth/security.js'
import { registerAdminBusinessOverviewRoutes } from '../src/commerce/admin-business-overview.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'
const testCookie = 'business-overview-session-' + randomUUID()

describe.skipIf(!testDatabaseUrl)('admin business overview PostgreSQL aggregation', () => {
  let masterPool: Pool
  let pool: Pool
  let db: Kysely<Database>
  let app: FastifyInstance
  let schema: string
  let adminCookie: string

  beforeAll(async () => {
    const databaseUrl = new URL(testDatabaseUrl!)
    if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
      throw new Error('Business overview integration tests require an isolated _test database')
    }

    masterPool = new Pool({ connectionString: testDatabaseUrl, max: 2 })
    await masterPool.query('SELECT 1')
    schema = 'business_overview_' + randomUUID().replaceAll('-', '')
    await masterPool.query('CREATE SCHEMA "' + schema + '"')
    databaseUrl.searchParams.set('options', '-c search_path=' + schema)
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 1 })
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await pool.query([
      'CREATE TABLE admin_users (id uuid PRIMARY KEY, email text NOT NULL, is_active boolean NOT NULL DEFAULT true);',
      'CREATE TABLE admin_sessions (id uuid PRIMARY KEY, admin_user_id uuid NOT NULL REFERENCES admin_users(id), token_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz);',
      'CREATE TABLE orders (id uuid PRIMARY KEY, status text NOT NULL, created_at timestamptz NOT NULL);',
      'CREATE TABLE payment_attempts (id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id), topup_customer_id uuid, source text NOT NULL, status text NOT NULL);',
      'CREATE TABLE payment_receipts (id uuid PRIMARY KEY, payment_attempt_id uuid NOT NULL REFERENCES payment_attempts(id), source_bucket text NOT NULL, amount numeric(18, 2) NOT NULL, disposition text NOT NULL, refunded_amount numeric(18, 2) NOT NULL DEFAULT 0, received_at timestamptz NOT NULL);',
      'CREATE TABLE payment_provider_reconciliation_cases (id uuid PRIMARY KEY, payment_attempt_id uuid NOT NULL REFERENCES payment_attempts(id), state text NOT NULL);',
    ].join(' '))

    const adminId = randomUUID()
    const sessionToken = testCookie
    await pool.query('INSERT INTO admin_users(id, email, is_active) VALUES($1, $2, true)', [adminId, 'business-overview@example.test'])
    await pool.query(
      'INSERT INTO admin_sessions(id, admin_user_id, token_hash, expires_at) VALUES($1, $2, $3, $4)',
      [randomUUID(), adminId, hashToken(sessionToken), new Date(Date.now() + 60 * 60_000)],
    )
    adminCookie = 'aikayun_admin_session=' + sessionToken

    const config = readConfig({
      ...process.env,
      DATABASE_URL: databaseUrl.toString(),
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: origin,
      COOKIE_SECURE: 'false',
    })
    app = Fastify({ logger: false })
    registerAjvFormats(app)
    app.setValidatorCompiler(TypeBoxValidatorCompiler)
    await app.register(cookie)
    app.setErrorHandler((error, request, reply) => reply.code(error.statusCode ?? 500).send(failure(
      error.validation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      error.validation ? 'The request contains invalid data' : 'An unexpected error occurred',
      request.id,
    )))
    registerAdminBusinessOverviewRoutes(app, db, config)
    await app.ready()

    // Prove the SQL boundaries do not use the PostgreSQL session's local timezone.
    await pool.query("SET TIME ZONE 'Pacific/Honolulu'")
  })

  afterAll(async () => {
    if (app) await app.close()
    if (db) await db.destroy()
    if (masterPool && schema) await masterPool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE')
    await masterPool?.end()
  })

  async function addOrder(status: string, createdAt: Date): Promise<string> {
    const id = randomUUID()
    await pool.query('INSERT INTO orders(id, status, created_at) VALUES($1, $2, $3)', [id, status, createdAt])
    return id
  }

  async function addAttempt(options: {
    orderId: string | null
    topupCustomerId?: string | null
    source?: 'external' | 'wallet'
    status: string
  }): Promise<string> {
    const id = randomUUID()
    await pool.query(
      'INSERT INTO payment_attempts(id, order_id, topup_customer_id, source, status) VALUES($1, $2, $3, $4, $5)',
      [id, options.orderId, options.topupCustomerId ?? null, options.source ?? 'external', options.status],
    )
    return id
  }

  async function addReceipt(options: {
    paymentAttemptId: string
    bucket: 'external' | 'cash' | 'gift'
    amount: string
    disposition?: string
    refundedAmount?: string
    receivedAt: Date
  }): Promise<void> {
    await pool.query(
      'INSERT INTO payment_receipts(id, payment_attempt_id, source_bucket, amount, disposition, refunded_amount, received_at) VALUES($1, $2, $3, $4, $5, $6, $7)',
      [randomUUID(), options.paymentAttemptId, options.bucket, options.amount, options.disposition ?? 'on_time', options.refundedAmount ?? '0.00', options.receivedAt],
    )
  }

  it('returns zeroes, respects Shanghai day boundaries, and counts only confirmed gross order receipts', async () => {
    expect((await app.inject('/api/v1/admin/business-overview')).statusCode).toBe(401)
    const invalidAdmin = await app.inject({
      url: '/api/v1/admin/business-overview',
      headers: { cookie: 'aikayun_admin_session=not-a-session' },
    })
    expect(invalidAdmin.statusCode).toBe(401)

    const empty = await app.inject({ url: '/api/v1/admin/business-overview', headers: { cookie: adminCookie } })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().data).toMatchObject({
      todayNewOrders: 0,
      pendingPaymentOrders: 0,
      processingOrders: 0,
      completedOrders: 0,
      todayConfirmedOrderPaymentAmount: '0.00',
      currency: 'CNY',
      paymentRule: 'succeeded_on_time_order_receipts_excluding_open_reconciliation',
      paymentTimeBasis: 'payment_receipts.received_at',
      includedPaymentSources: ['external', 'cash', 'gift'],
      refundsDeducted: false,
    })

    const { periodStart, periodEnd } = empty.json().data as { periodStart: string; periodEnd: string }
    const start = Date.parse(periodStart)
    const end = Date.parse(periodEnd)
    expect(new Date(start).getUTCHours()).toBe(16)
    expect(new Date(start).getUTCMinutes()).toBe(0)
    expect(end - start).toBe(24 * 60 * 60 * 1000)
    const at = (offset: number) => new Date(start + offset)

    const todayProcessing = await addOrder('processing', at(0))
    const todayClosed = await addOrder('closed', at(24 * 60 * 60 * 1000 - 1))
    await addOrder('closed', at(24 * 60 * 60 * 1000 - 10))
    await addOrder('pending_payment', at(-1))
    const completedYesterday = await addOrder('completed', at(-24 * 60 * 60 * 1000))
    await addOrder('completed', new Date(end))

    const externalAttempt = await addAttempt({ orderId: todayProcessing, status: 'succeeded' })
    await addReceipt({ paymentAttemptId: externalAttempt, bucket: 'external', amount: '0.10', receivedAt: at(0) })

    const walletAttempt = await addAttempt({ orderId: todayProcessing, source: 'wallet', status: 'succeeded' })
    await addReceipt({ paymentAttemptId: walletAttempt, bucket: 'cash', amount: '0.20', receivedAt: at(24 * 60 * 60 * 1000 - 1) })
    await addReceipt({
      paymentAttemptId: walletAttempt,
      bucket: 'gift',
      amount: '12345678901234.57',
      refundedAmount: '12345678901234.55',
      receivedAt: at(24 * 60 * 60 * 1000 - 1),
    })

    const yesterdayAttempt = await addAttempt({ orderId: completedYesterday, status: 'succeeded' })
    await addReceipt({ paymentAttemptId: yesterdayAttempt, bucket: 'external', amount: '9.99', receivedAt: at(-1) })

    const openCaseAttempt = await addAttempt({ orderId: todayClosed, status: 'succeeded' })
    await addReceipt({ paymentAttemptId: openCaseAttempt, bucket: 'external', amount: '2.00', receivedAt: at(1000) })
    await pool.query('INSERT INTO payment_provider_reconciliation_cases(id, payment_attempt_id, state) VALUES($1, $2, $3)', [randomUUID(), openCaseAttempt, 'open'])

    const lateAttempt = await addAttempt({ orderId: todayClosed, status: 'late_succeeded' })
    await addReceipt({ paymentAttemptId: lateAttempt, bucket: 'external', amount: '3.00', disposition: 'late', receivedAt: at(1000) })
    const mismatchAttempt = await addAttempt({ orderId: todayClosed, status: 'succeeded' })
    await addReceipt({ paymentAttemptId: mismatchAttempt, bucket: 'external', amount: '4.00', disposition: 'amount_mismatch', receivedAt: at(1000) })
    const failedAttempt = await addAttempt({ orderId: todayClosed, status: 'failed' })
    await addReceipt({ paymentAttemptId: failedAttempt, bucket: 'external', amount: '5.00', receivedAt: at(1000) })
    const pendingAttempt = await addAttempt({ orderId: todayClosed, status: 'pending' })
    await addReceipt({ paymentAttemptId: pendingAttempt, bucket: 'external', amount: '6.00', receivedAt: at(1000) })
    const reconcilingAttempt = await addAttempt({ orderId: todayClosed, status: 'reconciliation_required' })
    await addReceipt({ paymentAttemptId: reconcilingAttempt, bucket: 'external', amount: '7.00', receivedAt: at(1000) })
    const excessAttempt = await addAttempt({ orderId: todayClosed, status: 'succeeded' })
    await addReceipt({ paymentAttemptId: excessAttempt, bucket: 'external', amount: '8.00', disposition: 'excess', receivedAt: at(1000) })
    const topUpAttempt = await addAttempt({ orderId: null, topupCustomerId: randomUUID(), status: 'succeeded' })
    await addReceipt({ paymentAttemptId: topUpAttempt, bucket: 'external', amount: '99.00', receivedAt: at(1000) })

    const response = await app.inject({ url: '/api/v1/admin/business-overview', headers: { cookie: adminCookie } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({
      todayNewOrders: 3,
      pendingPaymentOrders: 1,
      processingOrders: 1,
      completedOrders: 2,
      todayConfirmedOrderPaymentAmount: '12345678901234.87',
      periodStart,
      periodEnd,
    })
    expect(Date.parse(response.json().data.measuredAt)).toBeGreaterThanOrEqual(start)
    expect(Date.parse(response.json().data.measuredAt)).toBeLessThan(end)
    expect(Object.keys(response.json().data).sort()).toEqual([
      'completedOrders',
      'currency',
      'includedPaymentSources',
      'measuredAt',
      'paymentRule',
      'paymentTimeBasis',
      'pendingPaymentOrders',
      'periodEnd',
      'periodStart',
      'processingOrders',
      'refundsDeducted',
      'todayConfirmedOrderPaymentAmount',
      'todayNewOrders',
    ])

    await pool.query('ALTER TABLE orders RENAME TO missing_orders')
    const unavailable = await app.inject({ url: '/api/v1/admin/business-overview', headers: { cookie: adminCookie } })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json().error.code).toBe('BUSINESS_OVERVIEW_UNAVAILABLE')
  })
})
