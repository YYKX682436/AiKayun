import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashToken } from '../src/auth/security.js'
import { readConfig } from '../src/config.js'
import { adminAuthMigration } from '../src/db/migrations/202610150001_admin_auth.js'
import { storefrontSupportSettingsMigration } from '../src/db/migrations/202611100001_storefront_support_settings.js'
import type { Database } from '../src/db/types.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const publicPath = '/api/v1/public/storefront/support'
const adminPath = '/api/v1/admin/storefront/support'
const origin = 'http://localhost:3000'

describe.skipIf(!testDatabaseUrl)('single-instance storefront support settings', () => {
  const schema = `storefront_support_${randomUUID().replaceAll('-', '')}`
  const sessionToken = randomUUID()
  const csrfToken = randomUUID()
  const cookie = `aikayun_admin_session=${sessionToken}; aikayun_admin_csrf=${csrfToken}`
  const headers = { origin, cookie, 'x-csrf-token': csrfToken }
  let master: Pool
  let db: Kysely<Database>
  let app: FastifyInstance

  beforeAll(async () => {
    const databaseUrl = new URL(testDatabaseUrl!)
    if (!databaseUrl.pathname.endsWith('_test')) {
      throw new Error('Storefront support tests require TEST_DATABASE_URL to name an isolated _test database')
    }
    master = new Pool({ connectionString: testDatabaseUrl })
    await master.query(`CREATE SCHEMA "${schema}"`)
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`)
    const pool = new Pool({ connectionString: databaseUrl.toString() })
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await adminAuthMigration.up!(db)
    await storefrontSupportSettingsMigration.up!(db)

    const id = randomUUID()
    await db.insertInto('admin_users').values({
      id, email: 'support-admin@example.test', password_hash: 'not-used-for-route-auth',
    }).execute()
    await db.insertInto('admin_sessions').values({
      id: randomUUID(), admin_user_id: id, token_hash: hashToken(sessionToken),
      expires_at: new Date(Date.now() + 60_000), revoked_at: null,
    }).execute()

    app = await createApp({
      db, logger: false,
      config: readConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl.toString(), PUBLIC_ORIGIN: origin, COOKIE_SECURE: 'false' }),
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await db?.destroy()
    await master?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await master?.end()
  })

  it('publishes an empty list by default and protects both admin routes', async () => {
    const empty = await app.inject(publicPath)
    expect(empty.statusCode).toBe(200)
    expect(empty.headers['cache-control']).toBe('no-store')
    expect(empty.json().data).toEqual({ channels: [] })
    expect((await app.inject(adminPath)).statusCode).toBe(401)
    const payload = { channels: [{ name: 'QQ 客服', type: 'account', content: '12345' }] }
    expect((await app.inject({ url: adminPath, method: 'PUT', payload })).statusCode).toBe(401)
    for (const unsafe of [{ origin, cookie }, { ...headers, origin: 'https://other.example.test' }]) {
      const rejected = await app.inject({ url: adminPath, method: 'PUT', headers: unsafe, payload })
      expect(rejected.statusCode).toBe(403)
      expect(rejected.json()).toMatchObject({ error: { code: expect.any(String) }, meta: { requestId: expect.any(String) } })
    }
    expect((await app.inject({ url: adminPath, headers })).json().data).toEqual({ channels: [] })
    expect((await app.inject(publicPath)).json().data).toEqual({ channels: [] })
  })

  it('publishes normalized contacts in order, rejects invalid replacements and can clear the list', async () => {
    const account = { name: '售后账号', type: 'account', content: '<support@example.test>' }
    const link = { name: '商家帮助中心', type: 'https', content: 'https://support.example.test/' }
    const put = (channels: unknown[]) => app.inject({ url: adminPath, method: 'PUT', headers, payload: { channels } })
    const update = await put([account, { ...link, name: ' 商家帮助中心 ', content: 'https://SUPPORT.example.test:443' }])
    expect(update.statusCode, update.body).toBe(200)
    expect(update.json().data).toEqual({ channels: [account, link] })
    expect((await app.inject({ url: adminPath, headers })).json().data).toEqual(update.json().data)
    const publicRead = await app.inject(publicPath)
    expect(publicRead.headers['cache-control']).toBe('no-store')
    expect(publicRead.json().data).toEqual(update.json().data)

    for (const channels of [
      [account, link, { ...account, content: '789' }, { ...account, content: '987' }],
      [{ ...account, type: 'email' }],
      [account, { ...account, name: '另一个名称', content: ` ${account.content} ` }],
      [link, { ...link, content: 'HTTPS://SUPPORT.EXAMPLE.TEST:443' }],
      [{ ...account, name: '   ' }],
      [{ ...account, content: '   ' }],
      [{ ...account, name: '客\t服' }],
      [{ ...account, content: 'abc\u0085def' }],
      [{ ...account, content: 'abc\ud800def' }],
      [{ ...account, name: '客'.repeat(41) }],
      [{ ...account, content: 'a'.repeat(201) }],
      ...[
        'https://', 'https:/support.example.test', 'https:///support.example.test',
        'https://support.example.test:99999', 'https://exa mple.test',
        'https://user:password@support.example.test', 'https://@support.example.test',
        'https://support.example.test\\@other.example.test',
        'http://support.example.test', '//support.example.test',
        'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/support',
        `https://support.example.test/${'客'.repeat(250)}`,
      ].map(content => [{ ...link, content }]),
    ]) {
      const rejected = await put(channels)
      expect(rejected.statusCode, rejected.body).toBe(400)
      expect(rejected.json()).toMatchObject({
        error: { code: expect.stringMatching(/^(VALIDATION_ERROR|STOREFRONT_SUPPORT_INVALID)$/) },
        meta: { requestId: expect.any(String) },
      })
    }
    expect((await app.inject(publicPath)).json().data).toEqual({ channels: [account, link] })
    expect((await put([link, account])).statusCode).toBe(200)
    expect((await app.inject(publicPath)).json().data).toEqual({ channels: [link, account] })
    expect(await db.selectFrom('storefront_support_settings').selectAll().execute()).toHaveLength(1)
    const cleared = await put([])
    expect(cleared.statusCode).toBe(200)
    expect((await app.inject(publicPath)).json().data).toEqual({ channels: [] })
  })
})
