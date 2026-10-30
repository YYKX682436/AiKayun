import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.LICENSE_CENTER_CHECKOUT
const infoPath = process.env.LICENSE_CENTER_INTEROP_INFO
const expectedCommit = '6f554b51b867a15ad7747c6d002b548e016f65c6'
if (!checkout || !infoPath) throw new Error('interop fixture requires an isolated center checkout and output path')

const centerImport = async (relativePath) => import(pathToFileURL(join(checkout, relativePath)).href)
const [{ createTestSigningRuntime }, { createDatabase, migrateToLatest }, { createApp }, offlineTrust, { initializeSignerRequestDigest }] = await Promise.all([
  centerImport('test/support/runtime.ts'),
  centerImport('src/db/database.ts'),
  centerImport('src/app.ts'),
  centerImport('tools/offline-trust/trust-bundle-signing.ts'),
  centerImport('src/admin/signing-service.ts'),
])

const pgUrl = process.env.LICENSE_TEST_DATABASE_URL
if (!pgUrl) throw new Error('interop fixture requires an isolated PostgreSQL test database')

let runtime
let db
let app
let shuttingDown = false

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function cleanup() {
  if (app) await app.close().catch(() => undefined)
  await db?.destroy().catch(() => undefined)
  await runtime?.cleanup().catch(() => undefined)
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await cleanup()
  process.exit(0)
}

process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })

try {
  const port = await availablePort()
  const origin = `https://license.example.test:${port}`
  runtime = await createTestSigningRuntime()
  runtime.config.issuer = origin
  runtime.config.publicOrigin = origin
  runtime.config.port = port
  const now = Math.floor(Date.now() / 1000)
  const claims = await offlineTrust.buildTrustBundleClaims(origin, {
    bundle_version: '1',
    iat: now - 60,
    nbf: now - 30,
    exp: now + 30 * 24 * 60 * 60,
    propagation_budget_seconds: 24 * 60 * 60,
    keys: [runtime.onlineKey.record],
  }, runtime.offlineRootPublicJwk)
  const bundle = await offlineTrust.signTrustBundle(claims, runtime.offlineRootPrivateKey, runtime.offlineRootPublicJwk)
  db = createDatabase(runtime.config.databaseUrl)
  await migrateToLatest(db)
  const admin = runtime.createAdminService(db)
  const initializeRequest = {
    operationId: randomUUID(),
    expectedSignerRevision: '0',
    activeKid: runtime.onlineKey.kid,
    bundleJws: bundle.token,
    reason: 'initialize disposable 3C-2A interop signer',
  }
  await admin.initialize({
    ...initializeRequest,
    rolloutGate: 'isolated-development-confirmed',
    confirmedRequestDigest: initializeSignerRequestDigest(initializeRequest),
  })
  app = createApp({ config: runtime.config, db })
  await app.listen({ host: '127.0.0.1', port })
  const databaseName = new URL(runtime.config.databaseUrl).pathname.slice(1)
  await writeFile(infoPath, JSON.stringify({
    source_commit: expectedCommit,
    issuer: origin,
    origin,
    port,
    database_name: databaseName,
    trust_bundle: bundle.token,
    root_public_jwk: runtime.offlineRootPublicJwk,
    root_kid: runtime.config.trustedOfflineRoot.kid,
    tls_ca: runtime.config.tlsCertificate.toString('utf8'),
  }), { mode: 0o600, flag: 'wx' })
  process.stdout.write('READY\n')
} catch {
  process.stderr.write('Isolated authorization center fixture failed to start.\n')
  await cleanup()
  process.exitCode = 1
}
