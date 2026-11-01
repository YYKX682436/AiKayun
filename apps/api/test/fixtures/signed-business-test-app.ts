import { afterAll } from 'vitest'
import { Pool } from 'pg'
import { createApp as createProductionApp } from './create-app-with-license.js'
import { createSignedBusinessLicense } from './signed-business-license.js'

type AppOptions = Parameters<typeof createProductionApp>[0]
let fixture: Awaited<ReturnType<typeof createSignedBusinessLicense>> | undefined
let licensePool: Pool | undefined
let initialization: Promise<void> | undefined

async function dispose() {
  await fixture?.close()
  await licensePool?.end()
  fixture = undefined
  licensePool = undefined
}

afterAll(dispose, 30_000)

export function currentSignedBusinessLicense() {
  if (!fixture) throw new Error('Signed business test fixture has not been initialized')
  return { releaseConfig: fixture.options.releaseConfig, identityRoot: fixture.options.identityRoot,
    pendingKeyRoot: fixture.options.pendingKeyRoot, trustRoot: fixture.trustRoot }
}

/** Real, signed license for business integration tests; no production code path imports this module. */
export async function createApp(options: AppOptions) {
  const databaseUrl = process.env.TEST_DATABASE_URL
  const centerCheckout = process.env.LICENSE_CENTER_CHECKOUT
  if (!databaseUrl || !new URL(databaseUrl).pathname.slice(1).endsWith('_test') || !centerCheckout) {
    throw new Error('Business integration tests require TEST_DATABASE_URL and the frozen LICENSE_CENTER_CHECKOUT')
  }
  // Historical migration tests intentionally start an app before the license tables exist.
  // They receive no test grant and retain the production fail-closed behavior.
  let binding
  try {
    binding = await options.db.selectFrom('installation_binding').select('database_id')
      .where('singleton', '=', true).executeTakeFirst()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '42P01') {
      return await createProductionApp(options)
    }
    throw error
  }
  if (!binding) {
    if (!initialization) initialization = (async () => {
      await dispose()
      licensePool = new Pool({ ...options.config.database, max: 8 })
      fixture = await createSignedBusinessLicense({ db: options.db, pool: licensePool, databaseUrl, centerCheckout })
    })().finally(() => { initialization = undefined })
    await initialization
  }
  if (!fixture || !licensePool) throw new Error('Test database has an unexpected installation binding')
  return await createProductionApp({ ...options,
    config: { ...options.config, identityRoot: fixture.options.identityRoot, licensePendingKeyRoot: fixture.options.pendingKeyRoot },
    licenseForTests: { releaseConfig: fixture.options.releaseConfig, trustStore: fixture.options.trustStore, pool: licensePool },
  })
}
