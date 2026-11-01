import { createDatabase } from '../../db/pool.js'
import { readConfig } from '../../config.js'
import { loadEmbeddedTrustedReleaseLicenseConfig } from '../trusted-release-config.js'
import { createTrustDatabaseCoordinator } from './trust-database-coordinator.js'
import { createReleaseBoundTrustStore } from './service.js'
import { fetchTrustedTimeAnchor } from './time-anchor-client.js'

const confirmation = process.argv[2]
if (confirmation !== '--initialize-current-trust-store-as-database-head') {
  throw new Error('Pass --initialize-current-trust-store-as-database-head to bind the current signed Trust Store to this database')
}

const appConfig = readConfig()
const releaseConfig = await loadEmbeddedTrustedReleaseLicenseConfig()
if (!releaseConfig) throw new Error('No immutable trusted release license configuration is embedded in this build')

const db = createDatabase()
try {
  const coordinator = createTrustDatabaseCoordinator({ db, identityRoot: appConfig.identityRoot })
  const store = createReleaseBoundTrustStore(releaseConfig, appConfig.licenseTrustStoreRoot, coordinator)
  const candidate = await store.getCandidateForDatabaseHeadBootstrap()
  const sample = await fetchTrustedTimeAnchor(releaseConfig, candidate)
  sample.assertFresh()
  const accepted = await store.initializeDatabaseHead(sample.readCurrentTrustedTime)
  process.stdout.write(`Trust Store head is bound to database: bundle ${accepted.bundleVersion}.\n`)
} finally {
  await db.destroy()
}
