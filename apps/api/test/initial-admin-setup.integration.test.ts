import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { readConfig } from '../src/config.js'
import { createAppInternal } from '../src/app-factory.js'
import { initializeAdminThroughCli, issueInitialSetupToken } from '../src/auth/initial-admin.js'
import { hashToken } from '../src/auth/security.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const publicOrigin = 'http://localhost:3000'
describe.skipIf(!testDatabaseUrl)('first-run admin setup PostgreSQL integration', () => {
  let masterPool: Pool
  const sandboxes = new Set<{ schema: string; db: Kysely<Database>; app: FastifyInstance; root: string }>()
  let remoteAddress = 10

  beforeAll(async () => {
    if (!testDatabaseUrl) return
    const url = new URL(testDatabaseUrl)
    if (!url.pathname.slice(1).endsWith('_test')) {
      throw new Error('Admin setup integration tests require TEST_DATABASE_URL to name an isolated _test database')
    }
    masterPool = new Pool({ connectionString: testDatabaseUrl, max: 2 })
    await masterPool.query('SELECT 1')
  })

  afterAll(async () => {
    for (const sandbox of sandboxes) {
      await sandbox.app.close()
      await sandbox.db.destroy()
      await masterPool.query(`DROP SCHEMA IF EXISTS "${sandbox.schema}" CASCADE`)
      await rm(sandbox.root, { recursive: true, force: true })
    }
    await masterPool?.end()
  })

  async function createSandbox(afterAdminSetupCommit?: () => void) {
    const schema = `admin_setup_${randomUUID().replaceAll('-', '')}`
    await masterPool.query(`CREATE SCHEMA "${schema}"`)
    const databaseUrl = new URL(testDatabaseUrl!)
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`)
    const pool = new Pool({ connectionString: databaseUrl.toString(), max: 10 })
    const schemaContext = await pool.query<{ current_schema: string; search_path: string }>(
      'SELECT current_schema() AS current_schema, current_setting(\'search_path\') AS search_path',
    )
    expect(schemaContext.rows[0]?.current_schema).toBe(schema)
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    const migration = new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema })
    const migrated = await migration.migrateToLatest()
    if (migrated.error) throw migrated.error

    const root = await mkdtemp(join(tmpdir(), 'aikayun-admin-setup-test-'))
    const config = readConfig({
      ...process.env,
      DATABASE_URL: databaseUrl.toString(),
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: publicOrigin,
      COOKIE_SECURE: 'false',
      MEDIA_ROOT: join(root, 'media'),
      PRIVATE_FILE_ROOT: join(root, 'private-files'),
      INSTANCE_IDENTITY_ROOT: join(root, 'identity'),
      LICENSE_TRUST_STORE_ROOT: join(root, 'trust'),
      LICENSE_PENDING_KEY_ROOT: join(root, 'pending'),
    })
    const app = await createAppInternal({
      db, config, logger: false,
      ...(afterAdminSetupCommit ? { adminSetupForTests: { afterAdminSetupCommit } } : {}),
    })
    await app.ready()
    const sandbox = { schema, db, app, root }
    sandboxes.add(sandbox)
    return sandbox
  }

  function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
    const header = response.headers['set-cookie']
    const cookies = Array.isArray(header) ? header : header ? [header] : []
    const cookie = cookies.find(value => value.startsWith(`${name}=`))
    if (!cookie) throw new Error(`Expected ${name} cookie`)
    return cookie.split(';', 1)[0] ?? ''
  }

  async function issueCsrf(app: FastifyInstance) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/setup/csrf' })
    expect(response.statusCode).toBe(200)
    return {
      value: response.json<{ data: { csrfToken: string } }>().data.csrfToken,
      cookie: cookieFrom(response, 'aikayun_setup_csrf'),
    }
  }

  async function verifySetupToken(app: FastifyInstance, token: string) {
    const csrf = await issueCsrf(app)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/setup/verify',
      remoteAddress: `198.51.100.${remoteAddress++}`,
      headers: { origin: publicOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.value },
      payload: { token },
    })
    return { response, cookie: response.statusCode === 200 ? cookieFrom(response, 'aikayun_setup_session') : '' }
  }

  async function createAdminRequest(
    app: FastifyInstance,
    email: string,
    password: string,
    sessionCookie: string,
  ) {
    const csrf = await issueCsrf(app)
    return app.inject({
      method: 'POST', url: '/api/v1/setup/admin',
      remoteAddress: `198.51.100.${remoteAddress++}`,
      headers: { origin: publicOrigin, cookie: `${sessionCookie}; ${csrf.cookie}`, 'x-csrf-token': csrf.value },
      payload: { email, password },
    })
  }

  it('allows two browsers to race and permanently closes setup after one atomic administrator commit', async () => {
    const sandbox = await createSandbox()
    const issued = await issueInitialSetupToken(sandbox.db)
    expect(issued.status).toBe('issued')
    if (issued.status !== 'issued') throw new Error('Expected an initial setup token')
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 60 * 1000)

    const status = await sandbox.app.inject('/api/v1/setup/status')
    expect(status.json().data.status).toBe('required')

    const csrf = await issueCsrf(sandbox.app)
    const badOrigin = await sandbox.app.inject({
      method: 'POST', url: '/api/v1/setup/verify',
      headers: { origin: 'https://attacker.example', cookie: csrf.cookie, 'x-csrf-token': csrf.value },
      payload: { token: issued.token },
    })
    expect(badOrigin.statusCode).toBe(403)

    const invalidToken = `${issued.token[0] === 'A' ? 'B' : 'A'}${issued.token.slice(1)}`
    const invalid = await verifySetupToken(sandbox.app, invalidToken)
    expect(invalid.response.statusCode).toBe(401)
    expect(invalid.response.body).not.toContain(issued.token)

    const first = await verifySetupToken(sandbox.app, issued.token)
    const second = await verifySetupToken(sandbox.app, issued.token)
    expect(first.response.statusCode).toBe(200)
    expect(second.response.statusCode).toBe(200)
    const sessionCookie = first.response.headers['set-cookie']
    expect(Array.isArray(sessionCookie) ? sessionCookie.join(';') : sessionCookie).toContain('HttpOnly')

    const weakPassword = await createAdminRequest(sandbox.app, 'owner@example.com', 'short', first.cookie)
    expect(weakPassword.statusCode).toBe(400)

    const submissions = await Promise.all([
      createAdminRequest(sandbox.app, 'owner@example.com', 'Correct-Horse-Battery-2026! strong', first.cookie),
      createAdminRequest(sandbox.app, 'owner@example.com', 'Correct-Horse-Battery-2026! strong', second.cookie),
    ])
    expect(submissions.map(response => response.statusCode).sort()).toEqual([200, 409])
    expect(submissions.find(response => response.statusCode === 409)?.json().error.code).toBe('SETUP_ALREADY_COMPLETED')
    expect(await sandbox.db.selectFrom('admin_users').select('id').execute()).toHaveLength(1)
    expect((await sandbox.db.selectFrom('admin_setup_state').select('state').executeTakeFirstOrThrow()).state).toBe('completed')

    const usedToken = await verifySetupToken(sandbox.app, issued.token)
    expect(usedToken.response.statusCode).toBe(409)
    expect(usedToken.response.json().error.code).toBe('SETUP_ALREADY_COMPLETED')
    await sandbox.db.deleteFrom('admin_users').execute()
    expect((await sandbox.app.inject('/api/v1/setup/status')).json().data.status).toBe('completed')
    expect(await issueInitialSetupToken(sandbox.db)).toEqual({ status: 'completed' })
    const staleBrowser = await createAdminRequest(sandbox.app, 'owner@example.com', 'Correct-Horse-Battery-2026! strong', first.cookie)
    expect(staleBrowser.statusCode).toBe(409)
    expect(staleBrowser.json().error.code).toBe('SETUP_ALREADY_COMPLETED')
    await expect(sql`DELETE FROM admin_setup_state`.execute(sandbox.db)).rejects.toMatchObject({ code: '55000' })
    await expect(sql`TRUNCATE admin_setup_state`.execute(sandbox.db)).rejects.toMatchObject({ code: '55000' })
    await expect(sql`UPDATE admin_setup_state SET state = 'locked' WHERE singleton = true`.execute(sandbox.db))
      .rejects.toMatchObject({ code: '55000' })
  })

  it('resolves a lost COMMIT acknowledgement by reading the persisted winner without creating a second administrator', async () => {
    let injectUnknownCommit = true
    const sandbox = await createSandbox(() => {
      if (!injectUnknownCommit) return
      injectUnknownCommit = false
      throw new Error('simulated_setup_commit_acknowledgement_loss')
    })
    const issued = await issueInitialSetupToken(sandbox.db)
    if (issued.status !== 'issued') throw new Error('Expected an initial setup token')
    const verified = await verifySetupToken(sandbox.app, issued.token)
    expect(verified.response.statusCode).toBe(200)
    const created = await createAdminRequest(sandbox.app, 'first@example.com', 'Correct-Horse-Battery-2026! strong', verified.cookie)
    expect(created.statusCode).toBe(200)
    expect(created.json().data.completed).toBe(true)
    expect(await sandbox.db.selectFrom('admin_users').select('id').execute()).toHaveLength(1)
    expect((await sandbox.app.inject('/api/v1/setup/status')).json().data.status).toBe('completed')
  })

  it('expires setup tokens after 30 minutes and invalidates sessions when the operator reissues one', async () => {
    const sandbox = await createSandbox()
    const first = await issueInitialSetupToken(sandbox.db)
    if (first.status !== 'issued') throw new Error('Expected an initial setup token')
    const oldSession = await verifySetupToken(sandbox.app, first.token)
    expect(oldSession.response.statusCode).toBe(200)
    await sandbox.db.updateTable('admin_setup_state').set({ token_expires_at: new Date(Date.now() - 1000) })
      .where('singleton', '=', true).execute()
    const staleToken = await verifySetupToken(sandbox.app, first.token)
    expect(staleToken.response.statusCode).toBe(401)
    expect(staleToken.response.json().error.code).toBe('SETUP_TOKEN_INVALID_OR_EXPIRED')

    const reissued = await issueInitialSetupToken(sandbox.db)
    if (reissued.status !== 'issued') throw new Error('Expected a reissued setup token')
    const current = await sandbox.db.selectFrom('admin_setup_state').select(['token_hash', 'token_generation'])
      .where('singleton', '=', true).executeTakeFirstOrThrow()
    expect(current.token_hash).toBe(hashToken(reissued.token))
    expect(current.token_hash).not.toBe(reissued.token)
    expect(BigInt(current.token_generation)).toBeGreaterThan(1n)
    const revokedSession = await sandbox.app.inject({
      method: 'POST', url: '/api/v1/setup/admin',
      headers: { origin: publicOrigin, cookie: oldSession.cookie, 'x-csrf-token': 'invalid' },
      payload: { email: 'owner@example.com', password: 'Correct-Horse-Battery-2026! strong' },
    })
    expect(revokedSession.statusCode).toBe(401)
  })

  it('serializes admin:init and the web setup transaction through the same one-time lock', async () => {
    const sandbox = await createSandbox()
    const issued = await issueInitialSetupToken(sandbox.db)
    if (issued.status !== 'issued') throw new Error('Expected an initial setup token')
    const verified = await verifySetupToken(sandbox.app, issued.token)
    expect(verified.response.statusCode).toBe(200)
    const pageCreation = createAdminRequest(sandbox.app, 'web@example.com', 'Correct-Horse-Battery-2026! strong', verified.cookie)
    const cliCreation = initializeAdminThroughCli(sandbox.db, 'cli@example.com', 'Different-Horse-Battery-2026! strong')
    const [page, cli] = await Promise.allSettled([pageCreation, cliCreation])
    const pageWon = page.status === 'fulfilled' && page.value.statusCode === 200
    const cliWon = cli.status === 'fulfilled'
    expect(Number(pageWon) + Number(cliWon)).toBe(1)
    if (!pageWon) {
      expect(page.status).toBe('fulfilled')
      expect(page.status === 'fulfilled' ? page.value.statusCode : 0).toBe(409)
    }
    if (!cliWon) {
      expect(cli.status).toBe('rejected')
      expect(cli.status === 'rejected' ? String(cli.reason) : '').toContain('one-time only')
    }
    expect(await sandbox.db.selectFrom('admin_users').select('id').execute()).toHaveLength(1)
    expect((await sandbox.app.inject('/api/v1/setup/status')).json().data.status).toBe('completed')
  })
})

describe('combined activation credential parser', () => {
  it('accepts only AK1, a UUID license id and one canonical 32-byte activation code', async () => {
    const { randomBytes, randomUUID } = await import('node:crypto')
    const { parseCombinedActivationCredential } = await import('../src/licensing/admin-activation.js')
    const licenseId = randomUUID()
    const activationCode = randomBytes(32).toString('base64url')
    expect(parseCombinedActivationCredential(`AK1.${licenseId}.${activationCode}`)).toEqual({
      licenseId, activationCode,
    })
    expect(() => parseCombinedActivationCredential(`AK2.${licenseId}.${activationCode}`)).toThrow()
    expect(() => parseCombinedActivationCredential(`AK1.${licenseId}.not-base64`)).toThrow()
    expect(() => parseCombinedActivationCredential(`AK1.${licenseId}. ${activationCode}`)).toThrow()
    expect(() => parseCombinedActivationCredential(`AK1.not-a-uuid.${activationCode}`)).toThrow()
  })
})
