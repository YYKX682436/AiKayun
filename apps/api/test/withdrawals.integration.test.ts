import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { hashPassword } from '../src/auth/password.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { createDatabase } from '../src/db/pool.js'
import type { Database } from '../src/db/types.js'
import { startZpayHttpFixture } from './fixtures/zpay-http-server.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const testOrigin = 'http://localhost:3000'
const password = 'Withdrawals-Integration-Password-2026!'

type Session = { id: string; cookie: string; csrfCookie: string; csrfToken: string }

let app: FastifyInstance
let secondApp: FastifyInstance
let db: Kysely<Database>
let secondDb: Kysely<Database>
let admin: Session
let secondAdmin: Session
let adminId: string
let paymentChannelId: string
let paymentFixture: Awaited<ReturnType<typeof startZpayHttpFixture>>
let nextIp = 1
const merchantId = 'withdrawal-race-fixture'
const merchantKey = 'withdrawal-race-only-test-credential'

function remoteAddress(): string {
  const value = (nextIp++ % 250) + 1
  return `198.51.100.${value}`
}

function inject(options: InjectOptions) {
  return app.inject({ ...options, remoteAddress: remoteAddress() })
}

function injectSecond(options: InjectOptions) {
  return secondApp.inject({ ...options, remoteAddress: remoteAddress() })
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find(value => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0]!
}

async function csrf(kind: 'customer' | 'admin') {
  const response = await inject({ method: 'GET', url: `/api/v1/${kind}/auth/csrf` })
  expect(response.statusCode).toBe(200)
  return {
    token: response.json().data.csrfToken as string,
    cookie: cookieFrom(response, kind === 'customer' ? 'aikayun_customer_csrf' : 'aikayun_admin_csrf'),
  }
}

async function createAdmin(emailPrefix: string): Promise<{ session: Session; id: string }> {
  const id = randomUUID()
  const email = `${emailPrefix}-${id.slice(0, 8)}@example.test`
  await db.insertInto('admin_users').values({ id, email, password_hash: await hashPassword(password) }).execute()
  const security = await csrf('admin')
  const login = await inject({
    method: 'POST', url: '/api/v1/admin/auth/login',
    headers: { origin: testOrigin, cookie: security.cookie, 'x-csrf-token': security.token },
    payload: { email, password },
  })
  expect(login.statusCode).toBe(200)
  return {
    id,
    session: {
      id,
      cookie: cookieFrom(login, 'aikayun_admin_session'),
      csrfCookie: security.cookie,
      csrfToken: security.token,
    },
  }
}

async function createCustomer(usernamePrefix = 'withdrawal'): Promise<Session> {
  const security = await csrf('customer')
  const username = `${usernamePrefix}-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/auth/register',
    headers: { origin: testOrigin, cookie: security.cookie, 'x-csrf-token': security.token },
    payload: { username, password },
  })
  expect(response.statusCode).toBe(201)
  return {
    id: response.json().data.customer.id as string,
    cookie: cookieFrom(response, 'aikayun_customer_session'),
    csrfCookie: security.cookie,
    csrfToken: security.token,
  }
}

function customerHeaders(customer: Session, includeCsrf = true) {
  return {
    origin: testOrigin,
    cookie: `${customer.cookie}; ${customer.csrfCookie}`,
    ...(includeCsrf ? { 'x-csrf-token': customer.csrfToken } : {}),
  }
}

function adminHeaders(session: Session = admin, includeCsrf = true) {
  return {
    origin: testOrigin,
    cookie: `${session.cookie}; ${session.csrfCookie}`,
    ...(includeCsrf ? { 'x-csrf-token': session.csrfToken } : {}),
  }
}

async function configureWithdrawals(input: Partial<{
  enabled: boolean
  minAmount: string
  maxAmount: string
  fixedFee: string
  percentFee: string
  methods: Array<'alipay' | 'wechat' | 'bank_card'>
}> = {}) {
  const current = await inject({ method: 'GET', url: '/api/v1/admin/withdrawals/settings', headers: adminHeaders() })
  expect(current.statusCode).toBe(200)
  const response = await inject({
    method: 'PUT', url: '/api/v1/admin/withdrawals/settings', headers: adminHeaders(),
    payload: {
      enabled: input.enabled ?? true,
      minAmount: input.minAmount ?? '5.00',
      maxAmount: input.maxAmount ?? '500.00',
      fixedFee: input.fixedFee ?? '0.75',
      percentFee: input.percentFee ?? '1.2500',
      methods: input.methods ?? ['alipay', 'wechat', 'bank_card'],
    },
  })
  expect(response.statusCode).toBe(200)
  return response.json().data
}

async function creditBalance(customer: Session, amount: string, bucket: 'cash' | 'gift' = 'cash') {
  const operationId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('wallet_operations').values({
      id: operationId, customer_id: customer.id, operation_type: 'adjustment',
      request_sha256: createHash('sha256').update(`${customer.id}:${operationId}`).digest('hex'), actor_admin_id: adminId,
    }).execute()
    await trx.insertInto('wallet_ledger_entries').values({
      id: randomUUID(), wallet_operation_id: operationId, line_no: 1, customer_id: customer.id,
      bucket, action: 'credit_available', amount, payment_attempt_id: null,
      refund_allocation_id: null, withdrawal_id: null,
    }).execute()
  })
}

async function createPaymentChannel(): Promise<string> {
  const response = await inject({
    method: 'POST', url: '/api/v1/admin/payment-channels', headers: adminHeaders(),
    payload: {
      providerType: 'zpay_epay_v1', name: '提现并发集成测试通道', enabled: true,
      paymentMethods: ['alipay', 'wechat'], displayOrder: 50, merchantId, merchantKey,
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json().data.channel.id as string
}

async function createOrder(customer: Session, amount: string): Promise<string> {
  const productId = randomUUID()
  const variantId = randomUUID()
  const orderId = randomUUID()
  const itemId = randomUUID()
  const name = `提现并发订单-${randomUUID().slice(0, 8)}`
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: productId, name, description: 'Withdrawal race integration fixture', product_type: 'digital', status: 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: variantId, product_id: productId, sku_code: `WDR-${variantId.slice(0, 8)}`,
      combination_key: '', sale_price: amount, compare_at_price: null, cost_price: null,
      enabled: true, retired_at: null, inventory_mode: 'unlimited',
    }).execute()
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: variantId, method: 'manual', manual_delivery_ready: true,
    }).execute()
    await trx.insertInto('orders').values({
      id: orderId, customer_id: customer.id, guest_order_session_id: null,
      idempotency_key: randomUUID(), request_sha256: digestFor(`${customer.id}:${orderId}`), total_amount: amount,
      unpaid_expires_at: new Date(Date.now() + 15 * 60_000), history_hidden_at: null,
      history_hidden_by_admin_id: null, history_hidden_reason: null,
    }).execute()
    await trx.insertInto('order_items').values({
      id: itemId, order_id: orderId, product_id: productId, product_variant_id: variantId,
      product_name_snapshot: name, product_type_snapshot: 'digital', sku_code_snapshot: `WDR-${variantId.slice(0, 8)}`,
      sku_snapshot: JSON.stringify([]), inventory_mode_snapshot: 'unlimited', fulfillment_method_snapshot: 'manual',
      unit_price: amount, quantity: 1, line_amount: amount,
    }).execute()
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
  })
  return orderId
}

function digestFor(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function createExternalPayment(orderId: string, customer: Session, walletAmount?: string) {
  return inject({
    method: 'POST', url: `/api/v1/orders/${orderId}/payments`, headers: customerHeaders(customer),
    payload: { idempotencyKey: randomUUID(), channelId: paymentChannelId, paymentMethod: 'alipay', ...(walletAmount ? { walletAmount } : {}) },
  })
}

async function createTopUp(customer: Session, amount: string) {
  return inject({
    method: 'POST', url: '/api/v1/customer/wallet/top-ups', headers: customerHeaders(customer),
    payload: { idempotencyKey: randomUUID(), amount, channelId: paymentChannelId, paymentMethod: 'alipay' },
  })
}

async function completeExternalPayment(paymentAttemptId: string) {
  const attempt = await db.selectFrom('payment_attempts').select('merchant_order_no')
    .where('id', '=', paymentAttemptId).executeTakeFirstOrThrow()
  const callback = paymentFixture.setPaid(attempt.merchant_order_no!)
  return inject({ method: 'GET', url: `/api/v1/payments/callback/zpay?${new URLSearchParams(callback).toString()}` })
}

async function createWithdrawal(customer: Session, options: {
  amount?: string
  idempotencyKey?: string
  payoutMethod?: 'alipay' | 'wechat' | 'bank_card'
  recipient?: Record<string, unknown>
  includeCsrf?: boolean
} = {}) {
  return inject({
    method: 'POST', url: '/api/v1/customer/wallet/withdrawals',
    headers: customerHeaders(customer, options.includeCsrf),
    payload: {
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      amount: options.amount ?? '100.00',
      payoutMethod: options.payoutMethod ?? 'alipay',
      recipient: options.recipient ?? { account: 'alice@example.test', accountName: 'Alice' },
    },
  })
}

async function approve(withdrawalId: string, session = admin) {
  return inject({
    method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/approve`,
    headers: adminHeaders(session), payload: { idempotencyKey: randomUUID() },
  })
}

async function startPayout(withdrawalId: string, session = admin) {
  return inject({
    method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/payout-attempts`,
    headers: adminHeaders(session), payload: { idempotencyKey: randomUUID() },
  })
}

async function walletFor(customerId: string) {
  return db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow()
}

async function expectWalletMatchesLedger(customerId: string) {
  const [account, ledger] = await Promise.all([
    walletFor(customerId),
    sql<{ bucket: 'cash' | 'gift'; available: string; frozen: string }>`
      SELECT bucket,
        COALESCE(sum(CASE WHEN action IN ('credit_available', 'unfreeze') THEN amount
          WHEN action IN ('debit_available', 'freeze') THEN -amount ELSE 0 END), 0)::text AS available,
        COALESCE(sum(CASE WHEN action = 'freeze' THEN amount
          WHEN action IN ('unfreeze', 'debit_frozen') THEN -amount ELSE 0 END), 0)::text AS frozen
      FROM wallet_ledger_entries WHERE customer_id = ${customerId}::uuid GROUP BY bucket
    `.execute(db),
  ])
  for (const bucket of ['cash', 'gift'] as const) {
    const row = ledger.rows.find(item => item.bucket === bucket)
    const normalize = (amount: string) => {
      const [whole, fraction = '00'] = amount.split('.')
      return `${BigInt(whole!)}.${fraction.padEnd(2, '0')}`
    }
    expect(normalize(row?.available ?? '0.00')).toBe(normalize(bucket === 'cash' ? account.cash_available : account.gift_available))
    expect(normalize(row?.frozen ?? '0.00')).toBe(normalize(bucket === 'cash' ? account.cash_frozen : account.gift_frozen))
  }
}

beforeAll(async () => {
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run withdrawal integration tests unless TEST_DATABASE_URL names a database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  const repeated = await migrator.migrateToLatest()
  if (repeated.error) throw repeated.error

  const config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: testOrigin,
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'true',
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({ activeKeyId: 'withdrawal-test', keys: { 'withdrawal-test': randomBytes(32).toString('base64') } }),
  })
  paymentFixture = await startZpayHttpFixture({ merchantCredentials: { [merchantId]: merchantKey } })
  app = await createApp({ db, config, logger: false, paymentProviderBaseUrlForTests: paymentFixture.baseUrl })
  await app.ready()
  secondDb = createDatabase()
  secondApp = await createApp({ db: secondDb, config, logger: false, paymentProviderBaseUrlForTests: paymentFixture.baseUrl })
  await secondApp.ready()
  const first = await createAdmin('withdrawal-admin')
  admin = first.session
  adminId = first.id
  const second = await createAdmin('withdrawal-admin-two')
  secondAdmin = second.session
  paymentChannelId = await createPaymentChannel()
  await db.updateTable('storefront_customer_policy').set({
    wallet_top_up_enabled: true, wallet_top_up_min_amount: '1.00', wallet_top_up_max_amount: '1000.00',
  }).where('singleton', '=', true).execute()
})

afterAll(async () => {
  if (secondApp) await secondApp.close()
  if (app) await app.close()
  if (paymentFixture) await paymentFixture.close()
  if (secondDb) await secondDb.destroy()
  if (db) await db.destroy()
})

describe('withdrawal applications, ledger freeze and manual payout through PostgreSQL', () => {
  it('checks customer identity, disabled accounts, payout configuration, amount limits and cash-only eligibility', async () => {
    const customer = await createCustomer()
    await creditBalance(customer, '100.00', 'gift')
    const guestAdminSettings = await inject({ method: 'GET', url: '/api/v1/admin/withdrawals/settings' })
    expect(guestAdminSettings.statusCode).toBe(401)
    const guestRequest = await inject({
      method: 'POST', url: '/api/v1/customer/wallet/withdrawals',
      headers: { origin: testOrigin }, payload: { idempotencyKey: randomUUID(), amount: '5.00', payoutMethod: 'alipay', recipient: { account: 'guest' } },
    })
    expect(guestRequest.statusCode).toBe(401)

    const disabledByDefault = await createWithdrawal(customer, { amount: '5.00' })
    expect(disabledByDefault.statusCode).toBe(409)
    expect(disabledByDefault.json().error.code).toBe('WITHDRAWAL_DISABLED')

    await configureWithdrawals({ enabled: true, minAmount: '10.00', maxAmount: '100.00', methods: ['alipay'] })
    const settings = {
      enabled: true, minAmount: '10.00', maxAmount: '100.00', fixedFee: '0.75', percentFee: '1.2500', methods: ['alipay'],
    }
    const missingAdminCsrf = await inject({
      method: 'PUT', url: '/api/v1/admin/withdrawals/settings', headers: adminHeaders(admin, false), payload: settings,
    })
    const wrongAdminOrigin = await inject({
      method: 'PUT', url: '/api/v1/admin/withdrawals/settings',
      headers: { ...adminHeaders(), origin: 'https://attacker.example' }, payload: settings,
    })
    expect(missingAdminCsrf.statusCode).toBe(403)
    expect(wrongAdminOrigin.statusCode).toBe(403)
    const underMinimum = await createWithdrawal(customer, { amount: '9.99' })
    const overMaximum = await createWithdrawal(customer, { amount: '100.01' })
    const unavailableMethod = await createWithdrawal(customer, { amount: '20.00', payoutMethod: 'bank_card', recipient: { recipientName: 'Alice', bankName: 'Bank', cardNumber: '123456789012' } })
    expect(underMinimum.statusCode).toBe(422)
    expect(overMaximum.statusCode).toBe(422)
    expect(unavailableMethod.statusCode).toBe(422)

    const noCash = await createWithdrawal(customer, { amount: '10.00' })
    expect(noCash.statusCode).toBe(409)
    expect(noCash.json().error.code).toBe('WITHDRAWAL_CASH_INSUFFICIENT')
    expect((await walletFor(customer.id)).cash_frozen).toBe('0.00')

    await configureWithdrawals({ methods: ['alipay', 'wechat', 'bank_card'] })
    const methodsCustomer = await createCustomer('wdmethods')
    await creditBalance(methodsCustomer, '100.00')
    const methodScenarios = [
      { payoutMethod: 'alipay' as const, recipient: { account: 'alipay-owner@example.test', accountName: 'Ali Payee' } },
      { payoutMethod: 'wechat' as const, recipient: { account: 'wechat-owner@example.test', accountName: 'WeChat Payee' } },
      { payoutMethod: 'bank_card' as const, recipient: { recipientName: 'Bank Payee', bankName: '测试银行', cardNumber: '6222000000001234' } },
    ]
    for (const scenario of methodScenarios) {
      const application = await createWithdrawal(methodsCustomer, { amount: '10.00', ...scenario })
      expect(application.statusCode).toBe(201)
      const withdrawal = application.json().data.withdrawal
      expect(withdrawal).toMatchObject({ payoutMethod: scenario.payoutMethod, recipient: scenario.recipient })
      if (scenario.payoutMethod === 'bank_card') {
        const rows = await inject({ method: 'GET', url: '/api/v1/admin/withdrawals?status=pending_review', headers: adminHeaders() })
        const item = rows.json().data.items.find((entry: { id: string }) => entry.id === withdrawal.id)
        expect(item.maskedRecipient).toContain('1234')
        expect(item.maskedRecipient).not.toContain(scenario.recipient.cardNumber)
      }
      const cancelled = await inject({
        method: 'POST', url: `/api/v1/customer/wallet/withdrawals/${withdrawal.id}/cancel`,
        headers: customerHeaders(methodsCustomer), payload: { idempotencyKey: randomUUID() },
      })
      expect(cancelled.statusCode).toBe(200)
      expect(cancelled.json().data.withdrawal.status).toBe('cancelled')
    }
    await expectWalletMatchesLedger(methodsCustomer.id)

    await creditBalance(customer, '100.00', 'cash')
    const invalidCsrf = await createWithdrawal(customer, { amount: '10.00', includeCsrf: false })
    expect(invalidCsrf.statusCode).toBe(403)

    await db.updateTable('customers').set({ status: 'disabled' }).where('id', '=', customer.id).execute()
    const disabledCustomer = await createWithdrawal(customer, { amount: '10.00' })
    expect(disabledCustomer.statusCode).toBe(401)
    expect((await walletFor(customer.id)).cash_frozen).toBe('0.00')
    await expectWalletMatchesLedger(customer.id)
  })

  it('settles exact percentage plus fixed fees, snapshots settings, freezes full cash once and reconciles ledger balances', async () => {
    await configureWithdrawals({ minAmount: '5.00', maxAmount: '500.00', fixedFee: '0.75', percentFee: '1.2500' })
    const customer = await createCustomer()
    await creditBalance(customer, '200.00')
    await creditBalance(customer, '50.00', 'gift')
    const key = randomUUID()
    const body = { idempotencyKey: key, amount: '100.00', payoutMethod: 'alipay', recipient: { account: 'alice@example.test', accountName: 'Alice' } }
    const created = await inject({ method: 'POST', url: '/api/v1/customer/wallet/withdrawals', headers: customerHeaders(customer), payload: body })
    expect(created.statusCode).toBe(201)
    const original = created.json().data.withdrawal
    expect(original).toMatchObject({ amount: '100.00', feeAmount: '2.00', payoutAmount: '98.00', status: 'pending_review' })
    expect(original.recipient).toEqual({ account: 'alice@example.test', accountName: 'Alice' })
    expect(await walletFor(customer.id)).toMatchObject({ cash_available: '100.00', cash_frozen: '100.00', gift_available: '50.00', gift_frozen: '0.00' })

    await configureWithdrawals({ fixedFee: '10.00', percentFee: '0.0000' })
    const replay = await inject({ method: 'POST', url: '/api/v1/customer/wallet/withdrawals', headers: customerHeaders(customer), payload: body })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.repeated).toBe(true)
    expect(replay.json().data.withdrawal).toMatchObject({ id: original.id, feeAmount: '2.00', payoutAmount: '98.00' })
    expect((await walletFor(customer.id)).cash_frozen).toBe('100.00')

    const feeBoundary = await createWithdrawal(customer, { amount: '10.00' })
    expect(feeBoundary.statusCode).toBe(422)
    expect(feeBoundary.json().error.code).toBe('WITHDRAWAL_INPUT_INVALID')
    expect((await db.selectFrom('withdrawals').select('id').where('customer_id', '=', customer.id).execute())).toHaveLength(1)
    expect((await walletFor(customer.id)).cash_frozen).toBe('100.00')

    const view = await inject({ method: 'GET', url: '/api/v1/customer/wallet/withdrawals', headers: customerHeaders(customer) })
    expect(view.statusCode).toBe(200)
    expect(view.json().data.policy.fixedFee).toBe('10.00')
    expect(view.json().data.items[0].recipient.account).toBe('alice@example.test')
    await expectWalletMatchesLedger(customer.id)
  })

  it('rolls back the wallet operation and freeze when a later request audit write fails', async () => {
    await configureWithdrawals({ fixedFee: '0.00', percentFee: '0.0000' })
    const customer = await createCustomer()
    await creditBalance(customer, '100.00')
    await sql`
      CREATE FUNCTION fail_customer_withdrawal_audit_for_test() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'customer_requested' THEN
          RAISE EXCEPTION 'test-only withdrawal audit failure' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER fail_customer_withdrawal_audit_for_test
      BEFORE INSERT ON withdrawal_audit_events FOR EACH ROW
      EXECUTE FUNCTION fail_customer_withdrawal_audit_for_test()`.execute(db)
    const failed = await createWithdrawal(customer, { amount: '25.00' }).finally(async () => {
      await sql`DROP TRIGGER fail_customer_withdrawal_audit_for_test ON withdrawal_audit_events`.execute(db)
      await sql`DROP FUNCTION fail_customer_withdrawal_audit_for_test()`.execute(db)
    })
    expect(failed.statusCode).toBe(500)
    expect(await db.selectFrom('withdrawals').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(0)
    expect(await db.selectFrom('wallet_operations').select('id').where('customer_id', '=', customer.id)
      .where('operation_type', '=', 'withdrawal_freeze').execute()).toHaveLength(0)
    expect((await walletFor(customer.id)).cash_available).toBe('100.00')
    expect((await walletFor(customer.id)).cash_frozen).toBe('0.00')
    await expectWalletMatchesLedger(customer.id)
  })

  it('serializes same-account withdrawals and makes cancellation, approval and rejection mutually exclusive', async () => {
    await configureWithdrawals({ fixedFee: '0.00', percentFee: '0.0000', minAmount: '1.00', maxAmount: '500.00' })
    const concurrentCustomer = await createCustomer()
    await creditBalance(concurrentCustomer, '300.00')
    const attempts = await Promise.all([
      createWithdrawal(concurrentCustomer, { amount: '200.00' }),
      createWithdrawal(concurrentCustomer, { amount: '200.00' }),
    ])
    expect(attempts.filter(response => response.statusCode === 201)).toHaveLength(1)
    expect(attempts.filter(response => response.statusCode === 409)).toHaveLength(1)
    expect((await walletFor(concurrentCustomer.id)).cash_available).toBe('100.00')
    expect((await walletFor(concurrentCustomer.id)).cash_frozen).toBe('200.00')

    const racedCustomer = await createCustomer()
    await creditBalance(racedCustomer, '100.00')
    const pending = await createWithdrawal(racedCustomer, { amount: '80.00' })
    const pendingId = pending.json().data.withdrawal.id as string
    const [cancel, review] = await Promise.all([
      inject({
        method: 'POST', url: `/api/v1/customer/wallet/withdrawals/${pendingId}/cancel`,
        headers: customerHeaders(racedCustomer), payload: { idempotencyKey: randomUUID() },
      }),
      approve(pendingId, secondAdmin),
    ])
    expect([cancel.statusCode, review.statusCode].filter(status => status < 300)).toHaveLength(1)
    expect([cancel.statusCode, review.statusCode].filter(status => status === 409)).toHaveLength(1)
    const afterRace = await db.selectFrom('withdrawals').select('status').where('id', '=', pendingId).executeTakeFirstOrThrow()
    if (afterRace.status === 'cancelled') {
      expect((await walletFor(racedCustomer.id)).cash_available).toBe('100.00')
      expect((await walletFor(racedCustomer.id)).cash_frozen).toBe('0.00')
    } else {
      expect(afterRace.status).toBe('pending_transfer')
      expect((await walletFor(racedCustomer.id)).cash_available).toBe('20.00')
      expect((await walletFor(racedCustomer.id)).cash_frozen).toBe('80.00')
    }

    const rejectedCustomer = await createCustomer()
    await creditBalance(rejectedCustomer, '80.00')
    const rejectedRequest = await createWithdrawal(rejectedCustomer, { amount: '40.00' })
    const rejectedId = rejectedRequest.json().data.withdrawal.id as string
    const rejection = await inject({
      method: 'POST', url: `/api/v1/admin/withdrawals/${rejectedId}/reject`, headers: adminHeaders(),
      payload: { idempotencyKey: randomUUID(), reason: '收款资料需要重新核验。' },
    })
    expect(rejection.statusCode).toBe(200)
    expect(rejection.json().data).toMatchObject({ status: 'rejected', rejectionReason: '收款资料需要重新核验。', reviewedByAdminId: adminId })
    expect((await walletFor(rejectedCustomer.id)).cash_available).toBe('80.00')
    expect((await walletFor(rejectedCustomer.id)).cash_frozen).toBe('0.00')
    await expectWalletMatchesLedger(concurrentCustomer.id)
    await expectWalletMatchesLedger(racedCustomer.id)
    await expectWalletMatchesLedger(rejectedCustomer.id)
  })

  it('keeps historical withdrawals manageable after account disable and protects active attempts from duplicate starts', async () => {
    await configureWithdrawals({ fixedFee: '0.00', percentFee: '0.0000' })
    const customer = await createCustomer()
    await creditBalance(customer, '120.00')
    const pending = await createWithdrawal(customer, { amount: '60.00' })
    const withdrawalId = pending.json().data.withdrawal.id as string
    await db.updateTable('customers').set({ status: 'disabled' }).where('id', '=', customer.id).execute()
    const blocked = await createWithdrawal(customer, { amount: '10.00' })
    expect(blocked.statusCode).toBe(401)

    const accepted = await approve(withdrawalId)
    expect(accepted.statusCode).toBe(200)
    const [firstStart, secondStart] = await Promise.all([
      startPayout(withdrawalId),
      injectSecond({
        method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/payout-attempts`,
        headers: adminHeaders(secondAdmin), payload: { idempotencyKey: randomUUID() },
      }),
    ])
    expect([firstStart.statusCode, secondStart.statusCode].sort()).toEqual([200, 409])
    const started = firstStart.statusCode === 200 ? firstStart : secondStart
    expect(started.statusCode).toBe(200)
    expect(started.json().data.status).toBe('transfer_processing')
    const attempt = started.json().data.payoutAttempts.at(-1)
    expect(attempt.status).toBe('started')
    expect(attempt.operationId).toBeTruthy()

    const activeAttempts = await db.selectFrom('withdrawal_payout_attempts').select('id')
      .where('withdrawal_id', '=', withdrawalId).execute()
    expect(activeAttempts).toHaveLength(1)
    expect((await walletFor(customer.id)).cash_frozen).toBe('60.00')
    await expectWalletMatchesLedger(customer.id)
  })

  it('holds unknown results, requires confirmed no-transfer for safe retry, records final evidence separately, and debits once', async () => {
    await configureWithdrawals({ fixedFee: '0.75', percentFee: '1.2500' })
    const customer = await createCustomer()
    await creditBalance(customer, '300.00')
    const created = await createWithdrawal(customer, { amount: '100.00' })
    const withdrawalId = created.json().data.withdrawal.id as string
    expect(created.json().data.withdrawal.payoutAmount).toBe('98.00')
    expect((await approve(withdrawalId)).statusCode).toBe(200)

    const started = await startPayout(withdrawalId)
    expect(started.statusCode).toBe(200)
    const firstAttemptId = started.json().data.payoutAttempts[0].id as string
    const firstOperationId = started.json().data.payoutAttempts[0].operationId as string
    const evidenceSha256 = createHash('sha256').update(`test-evidence:${firstOperationId}`).digest('hex')
    const unknownBody = { idempotencyKey: randomUUID(), outcome: 'unknown', evidenceSha256, evidenceSummary: '集成测试中断，模拟仍未核实的结果。' }
    const unknown = await inject({
      method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/payout-attempts/${firstAttemptId}/resolve`,
      headers: adminHeaders(), payload: unknownBody,
    })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json().data.status).toBe('transfer_uncertain')
    expect((await walletFor(customer.id)).cash_frozen).toBe('100.00')
    expect((await startPayout(withdrawalId, secondAdmin)).statusCode).toBe(409)

    const failed = await inject({
      method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/payout-attempts/${firstAttemptId}/resolve`,
      headers: adminHeaders(secondAdmin),
      payload: { idempotencyKey: randomUUID(), outcome: 'failed', confirmedNoTransfer: true, evidenceSha256, evidenceSummary: '通过转账记录核对，确认没有发生转账。' },
    })
    expect(failed.statusCode).toBe(200)
    expect(failed.json().data.status).toBe('pending_transfer')
    expect((await walletFor(customer.id)).cash_frozen).toBe('100.00')

    const retried = await startPayout(withdrawalId)
    expect(retried.statusCode).toBe(200)
    const secondAttempt = retried.json().data.payoutAttempts.at(-1)
    expect(secondAttempt.id).not.toBe(firstAttemptId)
    expect(secondAttempt.operationId).not.toBe(firstOperationId)
    const successKey = randomUUID()
    const successBody = {
      idempotencyKey: successKey,
      outcome: 'succeeded',
      providerReference: `BANK-TRANSFER-${randomUUID()}`,
      actualPayoutAmount: '98.00',
      actualPayoutAt: new Date().toISOString(),
      evidenceSha256: createHash('sha256').update(`settled:${secondAttempt.operationId}`).digest('hex'),
      evidenceSummary: '测试夹具模拟管理员提交已确认转账凭证摘要，不代表真实外部转账。',
    }
    const competingSuccessBody = { ...successBody, idempotencyKey: randomUUID() }
    const [firstResolution, secondResolution] = await Promise.all([
      inject({
        method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/payout-attempts/${secondAttempt.id}/resolve`,
        headers: adminHeaders(), payload: successBody,
      }),
      injectSecond({
        method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/payout-attempts/${secondAttempt.id}/resolve`,
        headers: adminHeaders(secondAdmin), payload: competingSuccessBody,
      }),
    ])
    expect([firstResolution.statusCode, secondResolution.statusCode].sort()).toEqual([200, 409])
    const successfulResolution = firstResolution.statusCode === 200 ? firstResolution : secondResolution
    const winningBody = firstResolution.statusCode === 200 ? successBody : competingSuccessBody
    expect(successfulResolution.json().data.status).toBe('completed')
    expect((await walletFor(customer.id)).cash_available).toBe('200.00')
    expect((await walletFor(customer.id)).cash_frozen).toBe('0.00')
    const finalAttempt = await db.selectFrom('withdrawal_payout_attempts').select(['status', 'provider_reference'])
      .where('id', '=', secondAttempt.id).executeTakeFirstOrThrow()
    expect(finalAttempt).toEqual({ status: 'succeeded', provider_reference: null })
    const payoutResult = await db.selectFrom('withdrawal_payout_results').selectAll().where('attempt_id', '=', secondAttempt.id).executeTakeFirstOrThrow()
    expect(payoutResult).toMatchObject({ outcome: 'succeeded', provider_reference: successBody.providerReference, actual_payout_amount: '98.00' })

    const lostResponseReplay = await inject({
      method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/payout-attempts/${secondAttempt.id}/resolve`,
      headers: adminHeaders(), payload: winningBody,
    })
    expect(lostResponseReplay.statusCode).toBe(200)
    expect((await walletFor(customer.id)).cash_available).toBe('200.00')
    expect(await db.selectFrom('wallet_ledger_entries').select('id').where('withdrawal_id', '=', withdrawalId).where('action', '=', 'debit_frozen').execute()).toHaveLength(1)

    await expect(db.updateTable('withdrawal_payout_results').set({ outcome: 'failed' }).where('attempt_id', '=', secondAttempt.id).execute()).rejects.toThrow()
    await expect(db.deleteFrom('withdrawal_payout_results').where('attempt_id', '=', secondAttempt.id).execute()).rejects.toThrow()
    await expect(db.updateTable('withdrawal_payout_attempts').set({ status: 'failed' }).where('id', '=', secondAttempt.id).execute()).rejects.toThrow()
    await expect(db.deleteFrom('withdrawal_payout_attempts').where('id', '=', secondAttempt.id).execute()).rejects.toThrow()
    await expectWalletMatchesLedger(customer.id)
  })

  it('enforces one real transfer reference across applications and lets two administrators race safely', async () => {
    await configureWithdrawals({ fixedFee: '0.00', percentFee: '0.0000' })
    const customer = await createCustomer()
    await creditBalance(customer, '200.00')
    const first = await createWithdrawal(customer, { amount: '50.00' })
    const second = await createWithdrawal(customer, { amount: '50.00' })
    const firstId = first.json().data.withdrawal.id as string
    const secondId = second.json().data.withdrawal.id as string
    const [firstReview, secondReview] = await Promise.all([
      approve(firstId), injectSecond({
        method: 'POST', url: `/api/v1/admin/withdrawals/${secondId}/approve`, headers: adminHeaders(secondAdmin),
        payload: { idempotencyKey: randomUUID() },
      }),
    ])
    expect(firstReview.statusCode).toBe(200)
    expect(secondReview.statusCode).toBe(200)
    const firstStarted = await startPayout(firstId)
    const secondStarted = await startPayout(secondId, secondAdmin)
    expect(firstStarted.statusCode).toBe(200)
    expect(secondStarted.statusCode).toBe(200)
    const firstAttempt = firstStarted.json().data.payoutAttempts[0]
    const secondAttempt = secondStarted.json().data.payoutAttempts[0]
    const ref = `SHARED-${randomUUID()}`
    const makeSuccess = (attempt: { id: string; operationId: string }) => ({
      idempotencyKey: randomUUID(), outcome: 'succeeded', providerReference: ref,
      actualPayoutAmount: '50.00', actualPayoutAt: new Date().toISOString(),
      evidenceSha256: createHash('sha256').update(attempt.operationId).digest('hex'), evidenceSummary: '测试用的重复参考号约束场景。',
    })
    const payloadA = makeSuccess(firstAttempt)
    const payloadB = makeSuccess(secondAttempt)
    const [resolvedA, resolvedB] = await Promise.all([
      inject({ method: 'POST', url: `/api/v1/admin/withdrawals/${firstId}/payout-attempts/${firstAttempt.id}/resolve`, headers: adminHeaders(), payload: payloadA }),
      injectSecond({ method: 'POST', url: `/api/v1/admin/withdrawals/${secondId}/payout-attempts/${secondAttempt.id}/resolve`, headers: adminHeaders(secondAdmin), payload: payloadB }),
    ])
    expect([resolvedA.statusCode, resolvedB.statusCode].sort()).toEqual([200, 409])
    const finalStates = await db.selectFrom('withdrawals').select(['id', 'status']).where('id', 'in', [firstId, secondId]).execute()
    expect(finalStates.filter(row => row.status === 'completed')).toHaveLength(1)
    expect(finalStates.filter(row => row.status === 'transfer_processing')).toHaveLength(1)
    const usedReference = await db.selectFrom('withdrawal_payout_results').select('provider_reference').where('provider_reference', '=', ref).execute()
    expect(usedReference).toHaveLength(1)

    const reviewCustomer = await createCustomer()
    await creditBalance(reviewCustomer, '100.00')
    const reviewRequest = await createWithdrawal(reviewCustomer, { amount: '25.00' })
    const reviewId = reviewRequest.json().data.withdrawal.id as string
    const race = await Promise.all([
      approve(reviewId, admin),
      injectSecond({ method: 'POST', url: `/api/v1/admin/withdrawals/${reviewId}/approve`, headers: adminHeaders(secondAdmin), payload: { idempotencyKey: randomUUID() } }),
    ])
    expect(race.filter(response => response.statusCode === 200)).toHaveLength(1)
    expect(race.filter(response => response.statusCode === 409)).toHaveLength(1)
    await expectWalletMatchesLedger(customer.id)
    await expectWalletMatchesLedger(reviewCustomer.id)
  })

  it('serializes withdrawals against real recharge callbacks, wallet purchases and wallet refunds', async () => {
    await configureWithdrawals({ fixedFee: '0.00', percentFee: '0.0000', minAmount: '1.00', maxAmount: '500.00' })

    const rechargeCustomer = await createCustomer()
    await creditBalance(rechargeCustomer, '100.00')
    const topUp = await createTopUp(rechargeCustomer, '100.00')
    expect(topUp.statusCode).toBe(201)
    const topUpAttemptId = topUp.json().data.items[0].id as string
    const [withdrawalVsTopUp, topUpCallback] = await Promise.all([
      createWithdrawal(rechargeCustomer, { amount: '150.00' }),
      completeExternalPayment(topUpAttemptId),
    ])
    expect(topUpCallback.statusCode).toBe(200)
    expect(topUpCallback.body).toBe('success')
    expect([201, 409]).toContain(withdrawalVsTopUp.statusCode)
    const afterRechargeRace = await walletFor(rechargeCustomer.id)
    if (withdrawalVsTopUp.statusCode === 201) {
      expect(afterRechargeRace).toMatchObject({ cash_available: '50.00', cash_frozen: '150.00' })
    } else {
      expect(afterRechargeRace).toMatchObject({ cash_available: '200.00', cash_frozen: '0.00' })
    }
    await expectWalletMatchesLedger(rechargeCustomer.id)

    const purchaseCustomer = await createCustomer()
    await creditBalance(purchaseCustomer, '100.00')
    const purchaseOrderId = await createOrder(purchaseCustomer, '80.00')
    const [withdrawalVsPurchase, walletPayment] = await Promise.all([
      createWithdrawal(purchaseCustomer, { amount: '50.00' }),
      createExternalPayment(purchaseOrderId, purchaseCustomer, '80.00'),
    ])
    expect([201, 409]).toContain(withdrawalVsPurchase.statusCode)
    expect([201, 409]).toContain(walletPayment.statusCode)
    expect(Number(withdrawalVsPurchase.statusCode === 201) + Number(walletPayment.statusCode === 201)).toBe(1)
    const afterPurchaseRace = await walletFor(purchaseCustomer.id)
    expect(Number(afterPurchaseRace.cash_available)).toBeGreaterThanOrEqual(0)
    expect(Number(afterPurchaseRace.cash_frozen)).toBeGreaterThanOrEqual(0)
    const purchaseLedger = await db.selectFrom('wallet_ledger_entries').select(['action', 'amount'])
      .where('customer_id', '=', purchaseCustomer.id).where('bucket', '=', 'cash').execute()
    expect(purchaseLedger.some(entry => entry.action === 'freeze' && entry.amount === '50.00')).toBe(withdrawalVsPurchase.statusCode === 201)
    expect(purchaseLedger.some(entry => entry.action === 'debit_available' && entry.amount === '80.00')).toBe(walletPayment.statusCode === 201)
    await expectWalletMatchesLedger(purchaseCustomer.id)

    const refundCustomer = await createCustomer()
    await creditBalance(refundCustomer, '100.00')
    const refundOrderId = await createOrder(refundCustomer, '100.00')
    const externalPayment = await createExternalPayment(refundOrderId, refundCustomer)
    expect(externalPayment.statusCode).toBe(201)
    const externalAttemptId = externalPayment.json().data.attempt.id as string
    expect((await completeExternalPayment(externalAttemptId)).body).toBe('success')
    const refundRequest = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${refundOrderId}/refunds`, headers: customerHeaders(refundCustomer),
      payload: { idempotencyKey: randomUUID(), amount: '100.00', reason: '并发提现与退款入账验证' },
    })
    expect(refundRequest.statusCode).toBe(201)
    const refundId = refundRequest.json().data.refunds.items[0].id as string
    const [withdrawalVsRefund, refundApproval] = await Promise.all([
      createWithdrawal(refundCustomer, { amount: '150.00' }),
      injectSecond({
        method: 'POST', url: `/api/v1/admin/orders/${refundOrderId}/refunds/${refundId}/approve`,
        headers: adminHeaders(secondAdmin), payload: { idempotencyKey: randomUUID() },
      }),
    ])
    expect(refundApproval.statusCode).toBe(200)
    expect([201, 409]).toContain(withdrawalVsRefund.statusCode)
    const afterRefundRace = await walletFor(refundCustomer.id)
    if (withdrawalVsRefund.statusCode === 201) {
      expect(afterRefundRace).toMatchObject({ cash_available: '50.00', cash_frozen: '150.00' })
    } else {
      expect(afterRefundRace).toMatchObject({ cash_available: '200.00', cash_frozen: '0.00' })
    }
    await expectWalletMatchesLedger(refundCustomer.id)
  })

  it('stores QR images privately, validates content and prevents cross-customer access', async () => {
    await configureWithdrawals({ fixedFee: '0.00', percentFee: '0.0000', methods: ['alipay', 'wechat'] })
    const owner = await createCustomer()
    const other = await createCustomer()
    await creditBalance(owner, '100.00')
    const fixturePath = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/test/fixtures/d6-upload.png')
    const image = await readFile(fixturePath)
    const boundary = `----withdrawal-${randomUUID()}`
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recipient.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const uploaded = await inject({
      method: 'POST', url: '/api/v1/customer/wallet/withdrawal-qr', headers: {
        ...customerHeaders(owner), 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(multipartBody.length),
      }, payload: multipartBody,
    })
    expect(uploaded.statusCode).toBe(201)
    expect(uploaded.headers['cache-control']).toContain('no-store')
    const file = uploaded.json().data as { id: string; sha256: string; mimeType: string }
    expect(file.mimeType).toBe('image/png')
    const customerQr = await inject({ method: 'GET', url: `/api/v1/customer/wallet/withdrawal-qr/${file.id}`, headers: customerHeaders(owner, false) })
    expect(customerQr.statusCode).toBe(200)
    expect(customerQr.headers['x-content-type-options']).toBe('nosniff')
    const foreignQr = await inject({ method: 'GET', url: `/api/v1/customer/wallet/withdrawal-qr/${file.id}`, headers: customerHeaders(other, false) })
    expect(foreignQr.statusCode).toBe(404)
    const unauthorizedQr = await inject({ method: 'GET', url: `/api/v1/customer/wallet/withdrawal-qr/${file.id}` })
    expect(unauthorizedQr.statusCode).toBe(401)

    const badBoundary = `----withdrawal-${randomUUID()}`
    const invalidBody = Buffer.concat([
      Buffer.from(`--${badBoundary}\r\nContent-Disposition: form-data; name="file"; filename="not-image.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.7 private'), Buffer.from(`\r\n--${badBoundary}--\r\n`),
    ])
    const invalid = await inject({
      method: 'POST', url: '/api/v1/customer/wallet/withdrawal-qr', headers: {
        ...customerHeaders(owner), 'content-type': `multipart/form-data; boundary=${badBoundary}`, 'content-length': String(invalidBody.length),
      }, payload: invalidBody,
    })
    expect(invalid.statusCode).toBe(415)

    const damagedBoundary = `----withdrawal-${randomUUID()}`
    const damagedImage = image.subarray(0, 85)
    const damagedBody = Buffer.concat([
      Buffer.from(`--${damagedBoundary}\r\nContent-Disposition: form-data; name="file"; filename="damaged.png"\r\nContent-Type: image/png\r\n\r\n`),
      damagedImage, Buffer.from(`\r\n--${damagedBoundary}--\r\n`),
    ])
    const damaged = await inject({
      method: 'POST', url: '/api/v1/customer/wallet/withdrawal-qr', headers: {
        ...customerHeaders(owner), 'content-type': `multipart/form-data; boundary=${damagedBoundary}`, 'content-length': String(damagedBody.length),
      }, payload: damagedBody,
    })
    expect(damaged.statusCode).toBe(400)

    const create = await createWithdrawal(owner, { amount: '20.00', recipient: { account: 'owner@wallet.test', qrFileId: file.id } })
    expect(create.statusCode).toBe(201)
    const withdrawalId = create.json().data.withdrawal.id as string
    const authorizedAdminQr = await inject({ method: 'GET', url: `/api/v1/admin/withdrawals/${withdrawalId}/recipient-qr`, headers: adminHeaders() })
    expect(authorizedAdminQr.statusCode).toBe(200)
    const adminList = await inject({ method: 'GET', url: '/api/v1/admin/withdrawals', headers: adminHeaders() })
    expect(adminList.statusCode).toBe(200)
    expect(adminList.body).not.toContain('owner@wallet.test')
    const foreignWithdrawalQr = await inject({ method: 'GET', url: `/api/v1/admin/withdrawals/${randomUUID()}/recipient-qr`, headers: adminHeaders() })
    expect(foreignWithdrawalQr.statusCode).toBe(404)
    await expectWalletMatchesLedger(owner.id)
  })
})
