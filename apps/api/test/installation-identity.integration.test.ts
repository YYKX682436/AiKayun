import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Pool as PgPool } from 'pg'
import type { Database } from '../src/db/types.js'
import { installationIdentityMigration } from '../src/db/migrations/202610290001_installation_identity.js'
import {
  initializeInstallationIdentity,
  verifyInstallationIdentity,
  InstallationIdentityError,
  type InstallationIdentitySnapshot,
} from '../src/licensing/installation-identity.js'
import { parseIdentityCliArguments } from '../src/licensing/installation-identity-cli.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const integration = describe.skipIf(!testDatabaseUrl)('installation identity PostgreSQL integration', () => {
  let adminPool: PgPool
  const schemas = new Set<string>()
  const identityRoots = new Set<string>()

  interface Sandbox {
    schema: string
    pool: PgPool
    db: Kysely<Database>
    identityRoot: string
  }

  beforeAll(async () => {
    if (!testDatabaseUrl) return
    const url = new URL(testDatabaseUrl)
    if (!url.pathname.slice(1).endsWith('_test')) {
      throw new Error('Installation identity tests require an isolated PostgreSQL database ending in _test')
    }
    adminPool = new Pool({ connectionString: testDatabaseUrl, max: 2 })
    await adminPool.query('SELECT 1')
  })

  afterAll(async () => {
    for (const schema of schemas) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
    await adminPool?.end()
    for (const identityRoot of identityRoots) {
      await rm(identityRoot, { recursive: true, force: true })
    }
  })

  async function createSandbox(): Promise<Sandbox> {
    const schema = `identity_test_${randomUUID().replaceAll('-', '')}`
    schemas.add(schema)
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    const pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schema}`,
      max: 4,
    })
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await installationIdentityMigration.up(db)
    const identityRoot = await mkdtemp(join(tmpdir(), 'aikayun-identity-test-'))
    identityRoots.add(identityRoot)
    return { schema, pool, db, identityRoot }
  }

  async function closeSandbox(sandbox: Sandbox): Promise<void> {
    await sandbox.db.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${sandbox.schema}" CASCADE`)
    schemas.delete(sandbox.schema)
    await rm(sandbox.identityRoot, { recursive: true, force: true })
    identityRoots.delete(sandbox.identityRoot)
  }

  async function withSandbox<T>(work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const sandbox = await createSandbox()
    try {
      return await work(sandbox)
    } finally {
      await closeSandbox(sandbox)
    }
  }

  function childProcess(sandbox: Sandbox, checkpoint?: string): Promise<{ signal: NodeJS.Signals | null; code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [
        '--import', resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'),
        resolve(import.meta.dirname, 'fixtures/installation-identity-child.ts'),
        sandbox.schema,
        sandbox.identityRoot,
        checkpoint ?? '',
      ], {
        cwd: resolve(import.meta.dirname, '../../..'),
        env: { ...process.env, TEST_DATABASE_URL: testDatabaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }))
    })
  }

  function cliProcess(sandbox: Sandbox, command: 'init' | 'verify', mode?: 'fresh' | 'adopt-existing', confirmExistingData = false) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const databaseUrl = new URL(testDatabaseUrl!)
      databaseUrl.searchParams.set('options', `-c search_path=${sandbox.schema}`)
      const args = [
        '--import', resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'),
        resolve(import.meta.dirname, '../src/licensing/installation-identity-cli.ts'),
        command,
        ...(mode ? ['--mode', mode] : []),
        ...(confirmExistingData ? ['--confirm-existing-data'] : []),
      ]
      const child = spawn(process.execPath, args, {
        cwd: resolve(import.meta.dirname, '../../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrl.toString(),
          INSTANCE_IDENTITY_ROOT: sandbox.identityRoot,
          TEST_DATABASE_URL: testDatabaseUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', code => resolveResult({ code, stdout, stderr }))
    })
  }

  async function initialize(sandbox: Sandbox, mode: 'fresh' | 'adopt_existing' = 'fresh', confirmExistingData = false) {
    return initializeInstallationIdentity(sandbox.pool, {
      identityRoot: sandbox.identityRoot,
      mode,
      confirmExistingData,
      forbiddenRoots: ['/var/lib/aikayun/media', '/var/lib/aikayun/private-files'],
    })
  }

  async function expectIdentityError(
    action: Promise<unknown>,
    status: InstallationIdentityError['status'],
    code: string,
  ): Promise<void> {
    await expect(action).rejects.toMatchObject({ status, code })
  }

  async function seedEmptyBootstrapRows(pool: PgPool): Promise<void> {
    await pool.query(`
      CREATE TABLE storefront_customer_policy (
        singleton boolean NOT NULL DEFAULT true,
        require_email boolean NOT NULL DEFAULT false,
        require_phone boolean NOT NULL DEFAULT false,
        guest_checkout_enabled boolean NOT NULL DEFAULT false,
        guest_free_claim_enabled boolean NOT NULL DEFAULT false,
        unpaid_order_timeout_minutes integer NOT NULL DEFAULT 15,
        wallet_top_up_enabled boolean NOT NULL DEFAULT false,
        wallet_top_up_min_amount numeric(18, 2) NOT NULL DEFAULT 1.00,
        wallet_top_up_max_amount numeric(18, 2) NOT NULL DEFAULT 1000.00,
        withdrawal_enabled boolean NOT NULL DEFAULT false,
        withdrawal_min_amount numeric(18, 2) NOT NULL DEFAULT 1.00,
        withdrawal_max_amount numeric(18, 2) NOT NULL DEFAULT 10000.00,
        withdrawal_fixed_fee numeric(18, 2) NOT NULL DEFAULT 0.00,
        withdrawal_percent_fee numeric(7, 4) NOT NULL DEFAULT 0.0000,
        withdrawal_methods text[] NOT NULL DEFAULT ARRAY['alipay', 'wechat', 'bank_card']::text[],
        purchase_forms_status varchar(16) NOT NULL DEFAULT 'preparing',
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await pool.query('INSERT INTO storefront_customer_policy DEFAULT VALUES')
    await pool.query('CREATE TABLE product_category_tree_guard (singleton boolean PRIMARY KEY, revision bigint NOT NULL DEFAULT 0)')
    await pool.query('INSERT INTO product_category_tree_guard (singleton) VALUES (true)')
  }

  it('creates one Ed25519 identity, repeats idempotently, and survives process re-entry', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const first = await initialize(sandbox)
      const repeated = await initialize(sandbox)
      const verified = await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)
      expect(first.status).toBe('ready')
      expect(first).toEqual(repeated)
      expect(verified).toEqual(first)
      expect(first.databaseId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(first.identityJkt).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(first.bindingRevision).toBe('1')
      expect(first.bindingState).toBe('ready')

      const currentPath = join(sandbox.identityRoot, 'current')
      const names = (await readdir(currentPath)).sort()
      expect(names).toEqual(['identity-intent.json', 'identity.json', 'instance-private-key.pk8.pem'])
      expect((await lstat(currentPath)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(currentPath, 'identity.json'))).mode & 0o777).toBe(0o600)
      expect((await lstat(join(currentPath, 'instance-private-key.pk8.pem'))).mode & 0o777).toBe(0o600)
      const manifest = JSON.parse(await readFile(join(currentPath, 'identity.json'), 'utf8')) as {
        database_id: string; instance_id: string; identity_jkt: string; private_key_file: string
      }
      expect(manifest.database_id).toBe(first.databaseId)
      expect(manifest.instance_id).toBe(first.instanceId)
      expect(manifest.identity_jkt).toBe(first.identityJkt)
      expect(manifest.private_key_file).toBe('instance-private-key.pk8.pem')
    })
  })

  it('serializes two concurrent processes to the same durable identity', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const [one, two] = await Promise.all([childProcess(sandbox), childProcess(sandbox)])
      expect(one.code, one.stderr).toBe(0)
      expect(two.code, two.stderr).toBe(0)
      const first = JSON.parse(one.stdout.trim()) as InstallationIdentitySnapshot
      const second = JSON.parse(two.stdout.trim()) as InstallationIdentitySnapshot
      expect(first.status).toBe('ready')
      expect(second).toEqual(first)
      const count = await sandbox.pool.query('SELECT count(*)::text AS count FROM installation_binding')
      expect(count.rows[0]?.count).toBe('1')
    })
  }, 30_000)

  it('runs the explicit init and verify CLI against an isolated PostgreSQL schema', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const initialized = await cliProcess(sandbox, 'init', 'fresh')
      expect(initialized.code, initialized.stderr).toBe(0)
      const initResult = JSON.parse(initialized.stdout.trim()) as InstallationIdentitySnapshot
      expect(initResult).toMatchObject({ status: 'ready', initializationMode: 'fresh', bindingState: 'ready' })

      const verified = await cliProcess(sandbox, 'verify')
      expect(verified.code, verified.stderr).toBe(0)
      expect(JSON.parse(verified.stdout.trim())).toEqual(initResult)
    })
  }, 30_000)

  it('recovers a SIGKILL after key persistence without generating a replacement key', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const killed = await childProcess(sandbox, 'private_key_persisted')
      expect(killed.signal, `${killed.stdout} ${killed.stderr}`).toBe('SIGKILL')
      expect(killed.code).toBeNull()
      const stages = (await readdir(sandbox.identityRoot)).filter(name => name.startsWith('.staging-'))
      expect(stages).toHaveLength(1)
      const stagedKey = await readFile(join(sandbox.identityRoot, stages[0]!, 'instance-private-key.pk8.pem'))
      const first = await initialize(sandbox)
      expect(first.status).toBe('ready')
      expect(await readFile(join(sandbox.identityRoot, 'current', 'instance-private-key.pk8.pem'))).toEqual(stagedKey)
      expect(await readdir(sandbox.identityRoot)).toEqual(['current'])
    })
  }, 30_000)

  it('resumes a SIGKILL after manifest persistence with the exact same key and identity fields', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const killed = await childProcess(sandbox, 'identity_manifest_persisted')
      expect(killed.signal, `${killed.stdout} ${killed.stderr}`).toBe('SIGKILL')
      const stage = (await readdir(sandbox.identityRoot)).find(name => name.startsWith('.staging-'))!
      const stagePath = join(sandbox.identityRoot, stage)
      const manifestBefore = await readFile(join(stagePath, 'identity.json'))
      const keyBefore = await readFile(join(stagePath, 'instance-private-key.pk8.pem'))
      expect((await sandbox.pool.query('SELECT state FROM installation_identity_initializations')).rows[0]?.state)
        .toBe('identity_material_saved')
      const resumed = await initialize(sandbox)
      expect(resumed).toMatchObject({ status: 'ready', identityJkt: JSON.parse(manifestBefore.toString()).identity_jkt })
      expect(await readFile(join(sandbox.identityRoot, 'current', 'identity.json'))).toEqual(manifestBefore)
      expect(await readFile(join(sandbox.identityRoot, 'current', 'instance-private-key.pk8.pem'))).toEqual(keyBefore)
    })
  }, 30_000)

  it('resumes after an intent fsync interruption and discards an incomplete atomic temp file', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const killed = await childProcess(sandbox, 'identity_intent_persisted')
      expect(killed.signal, `${killed.stdout} ${killed.stderr}`).toBe('SIGKILL')
      const stages = (await readdir(sandbox.identityRoot)).filter(name => name.startsWith('.staging-'))
      expect(stages).toHaveLength(1)
      const stagePath = join(sandbox.identityRoot, stages[0]!)
      const intent = JSON.parse(await readFile(join(stagePath, 'identity-intent.json'), 'utf8')) as {
        database_id: string; instance_id: string
      }
      const interruptedTemp = join(stagePath, `.identity.json.${randomUUID()}.tmp`)
      await writeFile(interruptedTemp, '{"partial":', { mode: 0o600 })
      const resumed = await initialize(sandbox)
      expect(resumed.status).toBe('ready')
      expect(resumed.databaseId).toBe(intent.database_id)
      expect(resumed.instanceId).toBe(intent.instance_id)
      expect((await readdir(sandbox.identityRoot)).sort()).toEqual(['current'])
      await expect(lstat(interruptedTemp)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }, 30_000)

  it('resumes after the atomic identity-directory install but before the DB binding transaction', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const killed = await childProcess(sandbox, 'identity_directory_installed')
      expect(killed.signal, `${killed.stdout} ${killed.stderr}`).toBe('SIGKILL')
      const before = JSON.parse(await readFile(join(sandbox.identityRoot, 'current', 'identity.json'), 'utf8')) as { database_id: string; instance_id: string; identity_jkt: string }
      expect((await sandbox.pool.query('SELECT count(*)::text AS count FROM installation_binding')).rows[0]?.count).toBe('0')
      expect((await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)).code).toBe('identity_initialization_incomplete')
      const resumed = await initialize(sandbox)
      expect(resumed.status).toBe('ready')
      expect(resumed.databaseId).toBe(before.database_id)
      expect(resumed.instanceId).toBe(before.instance_id)
      expect(resumed.identityJkt).toBe(before.identity_jkt)
    })
  }, 30_000)

  it('rolls back a killed pre-commit binding transaction and resumes with the same key', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const killed = await childProcess(sandbox, 'binding_transaction_before_commit')
      expect(killed.signal, `${killed.stdout} ${killed.stderr}`).toBe('SIGKILL')
      const before = JSON.parse(await readFile(join(sandbox.identityRoot, 'current', 'identity.json'), 'utf8')) as { database_id: string; instance_id: string; identity_jkt: string }
      expect((await sandbox.pool.query('SELECT count(*)::text AS count FROM installation_binding')).rows[0]?.count).toBe('0')
      const resumed = await initialize(sandbox)
      expect(resumed.status).toBe('ready')
      expect(resumed.databaseId).toBe(before.database_id)
      expect(resumed.instanceId).toBe(before.instance_id)
      expect(resumed.identityJkt).toBe(before.identity_jkt)
    })
  }, 30_000)

  it('recovers a SIGKILL after the DB commit as an idempotent verification', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      const killed = await childProcess(sandbox, 'binding_transaction_committed')
      expect(killed.signal, `${killed.stdout} ${killed.stderr}`).toBe('SIGKILL')
      const verified = await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)
      expect(verified.status).toBe('ready')
      expect((await initialize(sandbox)).identityJkt).toBe(verified.identityJkt)
      expect((await sandbox.pool.query('SELECT count(*)::text AS count FROM installation_binding')).rows[0]?.count).toBe('1')
    })
  }, 30_000)

  it('rejects automatic fresh initialization over commercial data and requires explicit adoption', async () => {
    await withSandbox(async (sandbox) => {
      await sandbox.pool.query('CREATE TABLE orders (id integer PRIMARY KEY, total numeric NOT NULL)')
      await sandbox.pool.query('INSERT INTO orders VALUES (1, 42.00)')
      const before = await sandbox.pool.query('SELECT * FROM orders')
      await expectIdentityError(initialize(sandbox), 'not_verified', 'existing_business_data_requires_adoption')
      await expectIdentityError(initialize(sandbox, 'adopt_existing'), 'not_verified', 'existing_data_confirmation_required')
      expect((await sandbox.pool.query('SELECT count(*)::text AS count FROM installation_identity_initializations')).rows[0]?.count).toBe('0')
      const adopted = await initialize(sandbox, 'adopt_existing', true)
      expect(adopted.status).toBe('ready')
      expect(adopted.businessDataProvenance).toBe('operator_confirmed_not_verified')
      expect((await sandbox.pool.query('SELECT * FROM orders')).rows).toEqual(before.rows)
    })
  })

  it('does not classify customized store policy as an untouched bootstrap database', async () => {
    await withSandbox(async (sandbox) => {
      await sandbox.pool.query(`
        CREATE TABLE storefront_customer_policy (
          singleton boolean PRIMARY KEY DEFAULT true,
          require_email boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await sandbox.pool.query(`INSERT INTO storefront_customer_policy (singleton, require_email) VALUES (true, true)`)
      await expectIdentityError(initialize(sandbox), 'not_verified', 'existing_business_data_requires_adoption')
      const adopted = await initialize(sandbox, 'adopt_existing', true)
      expect(adopted).toMatchObject({ status: 'ready', businessDataProvenance: 'operator_confirmed_not_verified' })
      expect((await sandbox.pool.query('SELECT require_email FROM storefront_customer_policy')).rows[0]?.require_email).toBe(true)
    })
  })

  it('recognizes only the exact migrated default storefront policy row as bootstrap metadata', async () => {
    await withSandbox(async (sandbox) => {
      await seedEmptyBootstrapRows(sandbox.pool)
      expect(await initialize(sandbox)).toMatchObject({ status: 'ready', businessDataProvenance: 'empty_at_initialization' })
    })
  })

  it('does not alter existing orders, wallet, funds, stock, or fulfillment rows during controlled adoption', async () => {
    await withSandbox(async (sandbox) => {
      const tables = [
        'orders', 'wallet_accounts', 'wallet_ledger_entries', 'payment_attempts',
        'product_variant_quantity_inventory', 'order_item_fulfillment_deliveries',
      ]
      for (const table of tables) {
        await sandbox.pool.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY, value text NOT NULL)`)
        await sandbox.pool.query(`INSERT INTO "${table}" VALUES (1, $1)`, [`${table}-historical-row`])
      }
      const before = await Promise.all(tables.map(async table => (await sandbox.pool.query(`SELECT * FROM "${table}" ORDER BY id`)).rows))
      const adopted = await initialize(sandbox, 'adopt_existing', true)
      expect(adopted.status).toBe('ready')
      const after = await Promise.all(tables.map(async table => (await sandbox.pool.query(`SELECT * FROM "${table}" ORDER BY id`)).rows))
      expect(after).toEqual(before)
    })
  })

  it('refuses a DB binding when its private key is missing and never recreates it', async () => {
    await withSandbox(async (sandbox) => {
      const created = await initialize(sandbox)
      const keyPath = join(sandbox.identityRoot, 'current', 'instance-private-key.pk8.pem')
      await rm(keyPath)
      const verified = await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)
      expect(verified).toMatchObject({ status: 'identity_mismatch', code: 'identity_private_key_missing' })
      await expectIdentityError(initialize(sandbox), 'identity_mismatch', 'identity_private_key_missing')
      await expect(rm(keyPath, { force: false })).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await sandbox.pool.query('SELECT database_id::text FROM installation_binding')).rows[0]?.database_id).toBe(created.databaseId)
    })
  })

  it('rejects replaced keys and mismatched database or identity-only restores', async () => {
    const first = await createSandbox()
    const second = await createSandbox()
    const third = await createSandbox()
    try {
      const identityA = await initialize(first)
      const identityB = await initialize(second)
      expect(identityA.identityJkt).not.toBe(identityB.identityJkt)

      const keyA = join(first.identityRoot, 'current', 'instance-private-key.pk8.pem')
      const keyB = join(second.identityRoot, 'current', 'instance-private-key.pk8.pem')
      const replacement = await readFile(keyB)
      await writeFile(keyA, replacement, { mode: 0o600 })
      await chmod(keyA, 0o600)
      expect(await verifyInstallationIdentity(first.pool, first.identityRoot)).toMatchObject({ status: 'identity_mismatch', code: 'identity_key_mismatch' })

      expect(await verifyInstallationIdentity(first.pool, second.identityRoot)).toMatchObject({ status: 'identity_mismatch' })
      expect(await verifyInstallationIdentity(third.pool, first.identityRoot)).toMatchObject({ status: 'identity_mismatch', code: 'identity_files_without_database_binding' })

      const dbOnly = await createSandbox()
      try {
        const dbIdentity = await initialize(dbOnly)
        await rm(dbOnly.identityRoot, { recursive: true, force: true })
        expect(await verifyInstallationIdentity(dbOnly.pool, dbOnly.identityRoot)).toMatchObject({ status: 'identity_mismatch', code: 'identity_root_missing' })
        expect(dbIdentity.status).toBe('ready')
      } finally {
        await closeSandbox(dbOnly)
      }
    } finally {
      await closeSandbox(first)
      await closeSandbox(second)
      await closeSandbox(third)
    }
  })

  it('rejects unsafe POSIX modes, symbolic links, non-regular key files, and repository paths', async () => {
    await withSandbox(async (sandbox) => {
      await initialize(sandbox)
      await chmod(sandbox.identityRoot, 0o755)
      expect(await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)).toMatchObject({ status: 'identity_mismatch', code: 'identity_root_permissions_invalid' })
      await chmod(sandbox.identityRoot, 0o700)

      const keyPath = join(sandbox.identityRoot, 'current', 'instance-private-key.pk8.pem')
      const parkedRoot = await mkdtemp(join(tmpdir(), 'aikayun-identity-key-test-'))
      identityRoots.add(parkedRoot)
      const parkedKey = join(parkedRoot, 'key.saved')
      await rename(keyPath, parkedKey)
      await symlink(parkedKey, keyPath)
      expect(await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)).toMatchObject({ status: 'identity_mismatch', code: 'identity_private_key_type_invalid' })
      await rm(keyPath)
      await rename(parkedKey, keyPath)
      await chmod(keyPath, 0o644)
      expect(await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)).toMatchObject({ status: 'identity_mismatch', code: 'identity_private_key_permissions_invalid' })
      await chmod(keyPath, 0o600)

      const symlinkRoot = `${sandbox.identityRoot}-symlink`
      await symlink(sandbox.identityRoot, symlinkRoot)
      identityRoots.add(symlinkRoot)
      expect(await verifyInstallationIdentity(sandbox.pool, symlinkRoot)).toMatchObject({ status: 'identity_mismatch', code: 'identity_root_type_invalid' })
      await expectIdentityError(initializeInstallationIdentity(sandbox.pool, {
        identityRoot: resolve(import.meta.dirname, '../../..'),
        mode: 'fresh',
      }), 'identity_mismatch', 'identity_path_not_isolated')
    })
  })

  it('prevents ordinary UPDATE, DELETE, and TRUNCATE from clearing or downgrading the binding', async () => {
    await withSandbox(async (sandbox) => {
      await initialize(sandbox)
      await expect(sandbox.pool.query(`UPDATE installation_binding SET binding_state = 'rebind_pending', binding_revision = 2`))
        .rejects.toMatchObject({ constraint: 'installation_binding_immutable' })
      await expect(sandbox.pool.query('UPDATE installation_binding SET binding_revision = 0'))
        .rejects.toMatchObject({ constraint: 'installation_binding_immutable' })
      await expect(sandbox.pool.query('DELETE FROM installation_binding'))
        .rejects.toMatchObject({ constraint: 'installation_binding_immutable' })
      await expect(sandbox.pool.query('TRUNCATE installation_binding'))
        .rejects.toMatchObject({ constraint: 'installation_identity_truncate_forbidden' })
      await expect(sandbox.pool.query('DELETE FROM installation_identity_initializations'))
        .rejects.toMatchObject({ constraint: 'installation_identity_initializations_immutable' })
      await expect(sandbox.pool.query('TRUNCATE installation_identity_initializations'))
        .rejects.toMatchObject({ constraint: 'installation_identity_truncate_forbidden' })
      expect((await verifyInstallationIdentity(sandbox.pool, sandbox.identityRoot)).status).toBe('ready')
    })
  })

  it('requires an explicit initialization mode and keeps CLI input limited to isolated actions', () => {
    expect(() => parseIdentityCliArguments(['init'])).toThrow(/explicit --mode/u)
    expect(parseIdentityCliArguments(['init', '--mode', 'fresh'])).toEqual({ command: 'init', mode: 'fresh', confirmExistingData: false })
    expect(parseIdentityCliArguments(['init', '--mode', 'adopt-existing', '--confirm-existing-data'])).toEqual({
      command: 'init', mode: 'adopt_existing', confirmExistingData: true,
    })
    expect(parseIdentityCliArguments(['verify'])).toEqual({ command: 'verify', confirmExistingData: false })
    expect(() => parseIdentityCliArguments(['reset'])).toThrow(/Usage/u)
    expect(() => parseIdentityCliArguments(['init', '--mode', 'fresh', '--force'])).toThrow(/Unsupported/u)
  })
})

void integration
