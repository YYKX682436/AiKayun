import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { createAppInternal } from '../src/app-factory.js'
import { readConfig } from '../src/config.js'
import { initializeAdminThroughCli } from '../src/auth/initial-admin.js'
import { createSignedBusinessLicense } from './fixtures/signed-business-license.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const centerCheckout = process.env.LICENSE_CENTER_CHECKOUT
describe.skipIf(!testDatabaseUrl || !centerCheckout)('admin activation page flow with the frozen HTTPS license center', () => {
  let masterPool: Pool
  const schemas = new Set<string>()
  const roots = new Set<string>()
  const databases: Array<{ db: Kysely<Database>; pool: Pool }> = []
  const apps: Array<{ close(): Promise<void> }> = []
  const centerFixtures: Array<{ close(): Promise<void> }> = []

  beforeAll(async () => {
    if (!testDatabaseUrl) return
    const url = new URL(testDatabaseUrl)
    if (!url.pathname.slice(1).endsWith('_test')) throw new Error('Activation route interop requires an isolated _test database')
    masterPool = new Pool({ connectionString: testDatabaseUrl, max: 2 })
    await masterPool.query('SELECT 1')
  })

  afterAll(async () => {
    for (const app of apps) await app.close()
    for (const fixture of centerFixtures) await fixture.close()
    for (const { db } of databases) await db.destroy()
    for (const schema of schemas) await masterPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    for (const root of roots) await rm(root, { recursive: true, force: true })
    await masterPool?.end()
  }, 60_000)

  it('activates once from the AK1 single field, resumes the stored operation, and never echoes the credential', async () => {
    const schema = `admin_activation_${randomUUID().replaceAll('-', '')}`
    schemas.add(schema)
    await masterPool.query(`CREATE SCHEMA "${schema}"`)
    const databaseUrl = new URL(testDatabaseUrl!)
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`)
    const pool = new Pool({ connectionString: databaseUrl.toString(), max: 12 })
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    databases.push({ db, pool })
    const migrator = new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema })
    const migrated = await migrator.migrateToLatest()
    if (migrated.error) throw migrated.error

    const mediaRoot = await mkdtemp(join(tmpdir(), 'aikayun-admin-activation-test-'))
    roots.add(mediaRoot)
    const licensePool = new Pool({ connectionString: databaseUrl.toString(), max: 8 })
    databases.push({ db: new Kysely<Database>({ dialect: new PostgresDialect({ pool: licensePool }) }), pool: licensePool })
    const fixture = await createSignedBusinessLicense({
      db, pool: licensePool, databaseUrl: testDatabaseUrl!, centerCheckout: centerCheckout!,
      skipInitialActivation: true,
    })
    centerFixtures.push(fixture)

    const administrator = { email: 'activation-admin@example.com', password: 'Safe-First-Admin-Password-2026!' }
    await initializeAdminThroughCli(db, administrator.email, administrator.password)
    const config = readConfig({
      ...process.env,
      DATABASE_URL: databaseUrl.toString(),
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://localhost:3000',
      COOKIE_SECURE: 'false',
      MEDIA_ROOT: join(mediaRoot, 'media'),
      PRIVATE_FILE_ROOT: join(mediaRoot, 'private-files'),
      INSTANCE_IDENTITY_ROOT: fixture.options.identityRoot,
      LICENSE_TRUST_STORE_ROOT: join(mediaRoot, 'unused-trust-root'),
      LICENSE_PENDING_KEY_ROOT: fixture.options.pendingKeyRoot,
    })
    const app = await createAppInternal({
      db, config, logger: false,
      licenseForTests: {
        releaseConfig: fixture.options.releaseConfig,
        trustStore: fixture.options.trustStore,
        pool: licensePool,
        testTls: fixture.options.testTls,
      },
    })
    apps.push(app)
    await app.ready()

    const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
    const csrfToken = csrf.json<{ data: { csrfToken: string } }>().data.csrfToken
    const csrfSetCookie = csrf.headers['set-cookie']
    const csrfCookies = Array.isArray(csrfSetCookie) ? csrfSetCookie : [csrfSetCookie]
    const csrfCookie = csrfCookies.find(value => value?.startsWith('aikayun_admin_csrf='))?.split(';', 1)[0]
    expect(csrfCookie).toBeTruthy()
    const login = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', remoteAddress: '192.0.2.230',
      headers: { origin: config.publicOrigin, cookie: csrfCookie, 'x-csrf-token': csrfToken },
      payload: administrator,
    })
    expect(login.statusCode).toBe(200)
    const loginSetCookie = login.headers['set-cookie']
    const loginCookies = Array.isArray(loginSetCookie) ? loginSetCookie : [loginSetCookie]
    const sessionCookie = loginCookies.find(value => value?.startsWith('aikayun_admin_session='))?.split(';', 1)[0]
    expect(sessionCookie).toBeTruthy()

    const combined = `AK1.${fixture.activationCredential.licenseId}.${fixture.activationCredential.activationCode}`
    const activated = await app.inject({
      method: 'POST', url: '/api/v1/admin/license-activation', remoteAddress: '192.0.2.231',
      headers: {
        origin: config.publicOrigin,
        cookie: `${sessionCookie}; ${csrfCookie}`,
        'x-csrf-token': csrfToken,
      },
      payload: { credential: combined },
    })
    expect(activated.statusCode, activated.body).toBe(200)
    expect(activated.json().data.status).toBe('active')
    expect(activated.body).not.toContain(combined)
    expect(activated.body).not.toContain(fixture.activationCredential.activationCode)
    expect(activated.body).not.toContain(fixture.activationCredential.licenseId)

    const operation = await db.selectFrom('local_license_operations').select(['operation_id', 'state'])
      .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
    expect(operation.state).toBe('response_saved')
    const licenseState = await db.selectFrom('instance_license_state').select(['license_id', 'trust_bundle_head_version'])
      .where('singleton', '=', true).executeTakeFirstOrThrow()
    expect(licenseState.license_id).toBe(fixture.activationCredential.licenseId)
    expect(licenseState.trust_bundle_head_version).toBe('1')

    const duplicate = await app.inject({
      method: 'POST', url: '/api/v1/admin/license-activation', remoteAddress: '192.0.2.232',
      headers: { origin: config.publicOrigin, cookie: `${sessionCookie}; ${csrfCookie}`, 'x-csrf-token': csrfToken },
      payload: { credential: combined },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('LICENSE_ALREADY_BOUND')
    expect(await db.selectFrom('local_license_operations').select('operation_id').where('kind', '=', 'activation').execute()).toHaveLength(1)
  }, 120_000)
})
