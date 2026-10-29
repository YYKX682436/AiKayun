import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { calculateJwkThumbprint } from 'jose'

export type InstallationInitializationMode = 'fresh' | 'adopt_existing'
export type IdentityDiagnosticStatus = 'ready' | 'identity_mismatch' | 'unavailable' | 'not_verified'

export interface InstallationIdentitySnapshot {
  status: IdentityDiagnosticStatus
  code: string
  databaseId?: string
  instanceId?: string
  identityJkt?: string
  bindingRevision?: string
  bindingState?: 'ready' | 'rebind_pending'
  initializationMode?: InstallationInitializationMode
  businessDataProvenance?: 'empty_at_initialization' | 'operator_confirmed_not_verified'
}

export class InstallationIdentityError extends Error {
  constructor(
    readonly status: Exclude<IdentityDiagnosticStatus, 'ready'>,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'InstallationIdentityError'
  }
}

export interface InstallationIdentityOptions {
  identityRoot: string
  mode: InstallationInitializationMode
  confirmExistingData?: boolean
  forbiddenRoots?: string[]
  /** Checkpoint injection is only used by integration tests to simulate process death. */
  onCheckpoint?: (checkpoint: IdentityInitializationCheckpoint) => void | Promise<void>
}

export type IdentityInitializationCheckpoint =
  | 'initialization_journal_committed'
  | 'identity_intent_persisted'
  | 'private_key_persisted'
  | 'identity_manifest_persisted'
  | 'identity_directory_installed'
  | 'binding_transaction_before_commit'
  | 'binding_transaction_committed'

interface InitializationJournal {
  operation_id: string
  mode: InstallationInitializationMode
  state: 'preparing' | 'identity_material_saved' | 'identity_staged' | 'committed'
}

interface BindingRow {
  database_id: string
  instance_id: string
  identity_jkt: string
  binding_revision: string
  binding_state: 'ready' | 'rebind_pending'
}

interface IdentityIntent {
  schema: 1
  operation_id: string
  mode: InstallationInitializationMode
  database_id: string
  instance_id: string
}

interface IdentityManifest {
  schema: 1
  operation_id: string
  database_id: string
  instance_id: string
  identity_jkt: string
  public_jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }
  private_key_file: 'instance-private-key.pk8.pem'
}

interface ValidatedIdentity extends IdentityManifest {
  initializationMode: InstallationInitializationMode
}

const currentDirectoryName = 'current'
const intentFileName = 'identity-intent.json'
const manifestFileName = 'identity.json'
const privateKeyFileName = 'instance-private-key.pk8.pem'
const lockKey = 'aikayun:installation-identity:init:v1'
const identityMetadataTables = new Set([
  'kysely_migration',
  'kysely_migration_lock',
  'installation_identity_initializations',
  'installation_binding',
])
const defaultBootstrapRows: Record<string, Record<string, unknown>> = {
  storefront_customer_policy: {
    singleton: true,
    require_email: false,
    require_phone: false,
    guest_checkout_enabled: false,
    guest_free_claim_enabled: false,
    unpaid_order_timeout_minutes: 15,
    wallet_top_up_enabled: false,
    wallet_top_up_min_amount: 1,
    wallet_top_up_max_amount: 1000,
    withdrawal_enabled: false,
    withdrawal_min_amount: 1,
    withdrawal_max_amount: 10000,
    withdrawal_fixed_fee: 0,
    withdrawal_percent_fee: 0,
    withdrawal_methods: ['alipay', 'wechat', 'bank_card'],
    purchase_forms_status: 'preparing',
  },
  product_category_tree_guard: { singleton: true, revision: 0 },
}

function fail(
  status: Exclude<IdentityDiagnosticStatus, 'ready'>,
  code: string,
  message: string,
): never {
  throw new InstallationIdentityError(status, code, message)
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function isPathWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function repositoryRoot(): string | undefined {
  const starts = [process.cwd(), import.meta.dirname]
  for (const start of starts) {
    let candidate = resolve(start)
    while (true) {
      if (existsSync(join(candidate, 'apps/api/package.json'))
        && existsSync(join(candidate, 'packages/contracts/package.json'))) {
        return candidate
      }
      const parent = dirname(candidate)
      if (parent === candidate) break
      candidate = parent
    }
  }
  return undefined
}

function assertPathBoundary(identityRoot: string, forbiddenRoots: string[]): void {
  if (!isAbsolute(identityRoot)) {
    fail('identity_mismatch', 'identity_path_not_absolute', 'INSTANCE_IDENTITY_ROOT must be an absolute path')
  }
  const normalizedRoot = resolve(identityRoot)
  const repository = repositoryRoot()
  const protectedRoots = [...(repository ? [repository] : []), ...forbiddenRoots].map(root => resolve(root))
  for (const protectedRoot of protectedRoots) {
    if (isPathWithin(protectedRoot, normalizedRoot) || isPathWithin(normalizedRoot, protectedRoot)) {
      fail('identity_mismatch', 'identity_path_not_isolated', 'Instance identity storage overlaps the repository or another private-data root')
    }
  }
}

async function canonicalPath(path: string): Promise<string> {
  let cursor = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const resolvedCursor = await realpath(cursor)
      return resolve(resolvedCursor, ...missing.reverse())
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

async function assertCanonicalPathBoundary(identityRoot: string, forbiddenRoots: string[]): Promise<void> {
  const repository = repositoryRoot()
  const protectedRoots = [...(repository ? [repository] : []), ...forbiddenRoots]
  const canonicalIdentityRoot = await canonicalPath(identityRoot)
  for (const root of protectedRoots) {
    const canonicalProtectedRoot = await canonicalPath(root)
    if (isPathWithin(canonicalProtectedRoot, canonicalIdentityRoot)
      || isPathWithin(canonicalIdentityRoot, canonicalProtectedRoot)) {
      fail('identity_mismatch', 'identity_path_not_isolated', 'Instance identity storage overlaps the repository or another private-data root')
    }
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

async function validateDirectory(path: string, purpose: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      fail('identity_mismatch', `${purpose}_missing`, `${purpose} is missing`)
    }
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('identity_mismatch', `${purpose}_type_invalid`, `${purpose} must be a real directory`)
  }
  if ((info.mode & 0o777) !== 0o700 || (currentUid() !== undefined && info.uid !== currentUid())) {
    fail('identity_mismatch', `${purpose}_permissions_invalid`, `${purpose} must be owned by the API user with POSIX mode 0700`)
  }
}

async function createIdentityRoot(identityRoot: string, forbiddenRoots: string[]): Promise<string> {
  assertPathBoundary(identityRoot, forbiddenRoots)
  try {
    await mkdir(identityRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new InstallationIdentityError('unavailable', 'identity_root_unavailable', 'Instance identity storage cannot be created', { cause: error })
  }
  await validateDirectory(identityRoot, 'identity_root')
  const canonicalRoot = await realpath(identityRoot)
  await assertCanonicalPathBoundary(canonicalRoot, forbiddenRoots)
  return canonicalRoot
}

async function requireIdentityRoot(identityRoot: string, forbiddenRoots: string[]): Promise<string> {
  assertPathBoundary(identityRoot, forbiddenRoots)
  try {
    await validateDirectory(identityRoot, 'identity_root')
    const canonicalRoot = await realpath(identityRoot)
    await assertCanonicalPathBoundary(canonicalRoot, forbiddenRoots)
    return canonicalRoot
  } catch (error) {
    if (error instanceof InstallationIdentityError) throw error
    throw new InstallationIdentityError('unavailable', 'identity_root_unavailable', 'Instance identity storage cannot be inspected', { cause: error })
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readProtectedFile(path: string, purpose: string): Promise<Buffer> {
  let before
  try {
    before = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      fail('identity_mismatch', `${purpose}_missing`, `${purpose} is missing`)
    }
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail('identity_mismatch', `${purpose}_type_invalid`, `${purpose} must be a single-link regular file`)
  }
  if ((before.mode & 0o777) !== 0o600 || (currentUid() !== undefined && before.uid !== currentUid())) {
    fail('identity_mismatch', `${purpose}_permissions_invalid`, `${purpose} must be owned by the API user with POSIX mode 0600`)
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const after = await handle.stat()
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      fail('identity_mismatch', `${purpose}_changed_during_read`, `${purpose} changed while being read`)
    }
    if (after.size > 16 * 1024) {
      fail('identity_mismatch', `${purpose}_size_invalid`, `${purpose} exceeds its permitted size`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function writeFileAtomically(path: string, directory: string, contents: string): Promise<void> {
  const temporaryPath = join(directory, `.${path.split(sep).at(-1)}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
    await fsyncDirectory(directory)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    if (errorCode(error) === 'EEXIST') {
      fail('identity_mismatch', 'identity_file_already_exists', 'An identity file already exists and will not be overwritten')
    }
    throw error
  }
}

function assertJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('identity_mismatch', 'identity_document_invalid', 'Identity metadata is not a JSON object')
  }
  return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected.sort()[index])
}

function parseUuidV4(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

async function parseJsonFile(path: string, purpose: string): Promise<Record<string, unknown>> {
  const bytes = await readProtectedFile(path, purpose)
  try {
    return assertJsonObject(JSON.parse(bytes.toString('utf8')) as unknown)
  } catch (error) {
    if (error instanceof InstallationIdentityError) throw error
    fail('identity_mismatch', `${purpose}_invalid`, `${purpose} is not valid JSON`)
  }
}

async function readAndValidateIdentityDirectory(directory: string): Promise<ValidatedIdentity> {
  await validateDirectory(directory, 'identity_directory')
  const entryNames = (await readdir(directory)).sort()
  const expectedNames = [intentFileName, manifestFileName, privateKeyFileName]
  if (entryNames.some(name => !expectedNames.includes(name))) {
    fail('identity_mismatch', 'identity_directory_contents_invalid', 'Identity directory must contain only its intent, manifest and PKCS#8 key files')
  }
  const manifestValue = await parseJsonFile(join(directory, manifestFileName), 'identity_manifest')
  if (!hasExactKeys(manifestValue, ['schema', 'operation_id', 'database_id', 'instance_id', 'identity_jkt', 'public_jwk', 'private_key_file'])
    || manifestValue.schema !== 1
    || typeof manifestValue.operation_id !== 'string'
    || !parseUuidV4(manifestValue.database_id)
    || !parseUuidV4(manifestValue.instance_id)
    || typeof manifestValue.identity_jkt !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(manifestValue.identity_jkt)
    || manifestValue.private_key_file !== privateKeyFileName) {
    fail('identity_mismatch', 'identity_manifest_invalid', 'Instance identity metadata has an unsupported or malformed schema')
  }
  const jwkValue = assertJsonObject(manifestValue.public_jwk)
  if (!hasExactKeys(jwkValue, ['kty', 'crv', 'x']) || jwkValue.kty !== 'OKP'
    || jwkValue.crv !== 'Ed25519' || typeof jwkValue.x !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(jwkValue.x)) {
    fail('identity_mismatch', 'identity_public_key_invalid', 'Instance identity public key is not a strict Ed25519 OKP JWK')
  }
  const intentValue = await parseJsonFile(join(directory, intentFileName), 'identity_intent')
  if (!hasExactKeys(intentValue, ['schema', 'operation_id', 'mode', 'database_id', 'instance_id'])
    || intentValue.schema !== 1 || intentValue.operation_id !== manifestValue.operation_id
    || !['fresh', 'adopt_existing'].includes(String(intentValue.mode))
    || intentValue.database_id !== manifestValue.database_id
    || intentValue.instance_id !== manifestValue.instance_id) {
    fail('identity_mismatch', 'identity_intent_mismatch', 'Instance identity intent does not match its manifest')
  }
  const keyBytes = await readProtectedFile(join(directory, privateKeyFileName), 'identity_private_key')
  let privateKey
  try {
    privateKey = createPrivateKey({ key: keyBytes, format: 'pem', type: 'pkcs8' })
  } catch (error) {
    throw new InstallationIdentityError('identity_mismatch', 'identity_private_key_invalid', 'Instance PKCS#8 private key cannot be imported', { cause: error })
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('identity_mismatch', 'identity_private_key_type_invalid', 'Instance private key is not Ed25519')
  }
  const publicKey = createPublicKey(privateKey)
  const exportedJwk = publicKey.export({ format: 'jwk' })
  if (exportedJwk.kty !== 'OKP' || exportedJwk.crv !== 'Ed25519' || typeof exportedJwk.x !== 'string') {
    fail('identity_mismatch', 'identity_public_key_invalid', 'Node.js could not derive an Ed25519 public JWK from the private key')
  }
  const publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string } = {
    kty: 'OKP', crv: 'Ed25519', x: exportedJwk.x,
  }
  const identityJkt = await calculateJwkThumbprint(publicJwk)
  if (identityJkt !== manifestValue.identity_jkt
    || publicJwk.x !== jwkValue.x) {
    fail('identity_mismatch', 'identity_key_mismatch', 'Instance private key, public JWK and RFC 7638 thumbprint do not match')
  }
  return {
    ...(manifestValue as unknown as IdentityManifest),
    initializationMode: intentValue.mode as InstallationInitializationMode,
  }
}

async function cleanupInterruptedWrites(stageDirectory: string): Promise<void> {
  const names = await readdir(stageDirectory)
  const temporaryFilePattern = /^\.(identity-intent\.json|identity\.json|instance-private-key\.pk8\.pem)\.[0-9a-f-]{36}\.tmp$/iu
  for (const name of names) {
    if (!temporaryFilePattern.test(name)) {
      continue
    }
    const path = join(stageDirectory, name)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600
      || (currentUid() !== undefined && info.uid !== currentUid())) {
      fail('identity_mismatch', 'identity_temporary_file_invalid', 'Interrupted identity write has an unsafe temporary file')
    }
    await unlink(path)
  }
  const remaining = (await readdir(stageDirectory)).filter(name => !temporaryFilePattern.test(name))
  if (remaining.some(name => ![intentFileName, manifestFileName, privateKeyFileName].includes(name))) {
    fail('identity_mismatch', 'identity_directory_unexpected_file', 'Identity staging directory contains an unexpected file')
  }
}

async function prepareIdentityStage(
  root: string,
  journal: InitializationJournal,
  client: PoolClient,
  onCheckpoint?: InstallationIdentityOptions['onCheckpoint'],
): Promise<IdentityManifest> {
  const stagePath = join(root, `.staging-${journal.operation_id}`)
  try {
    await mkdir(stagePath, { mode: 0o700 })
    await fsyncDirectory(root)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  await validateDirectory(stagePath, 'identity_staging_directory')
  await cleanupInterruptedWrites(stagePath)

  const intentPath = join(stagePath, intentFileName)
  let intent: IdentityIntent
  try {
    const existing = await parseJsonFile(intentPath, 'identity_intent')
    if (!hasExactKeys(existing, ['schema', 'operation_id', 'mode', 'database_id', 'instance_id'])
      || existing.schema !== 1 || existing.operation_id !== journal.operation_id
      || existing.mode !== journal.mode || !parseUuidV4(existing.database_id) || !parseUuidV4(existing.instance_id)) {
      fail('identity_mismatch', 'identity_intent_mismatch', 'Staged identity intent does not match the database initialization journal')
    }
    intent = existing as unknown as IdentityIntent
  } catch (error) {
    if (!(error instanceof InstallationIdentityError) || error.code !== 'identity_intent_missing') throw error
    if (journal.state !== 'preparing' || (await readdir(stagePath)).length > 0) {
      fail('identity_mismatch', 'identity_material_missing', 'Database records staged identity material that is missing from disk')
    }
    intent = {
      schema: 1,
      operation_id: journal.operation_id,
      mode: journal.mode,
      database_id: randomUUID(),
      instance_id: randomUUID(),
    }
    await writeFileAtomically(intentPath, stagePath, `${JSON.stringify(intent)}\n`)
    await onCheckpoint?.('identity_intent_persisted')
  }

  const privateKeyPath = join(stagePath, privateKeyFileName)
  const filesBeforeKey = await readdir(stagePath)
  try {
    await readProtectedFile(privateKeyPath, 'identity_private_key')
  } catch (error) {
    if (!(error instanceof InstallationIdentityError) || error.code !== 'identity_private_key_missing') throw error
    if (journal.state !== 'preparing' || filesBeforeKey.includes(manifestFileName)) {
      fail('identity_mismatch', 'identity_private_key_missing', 'Database records staged identity material but the private key is missing')
    }
    const { privateKey } = generateKeyPairSync('ed25519')
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    await writeFileAtomically(privateKeyPath, stagePath, privatePem)
  }
  await advanceJournalState(client, journal.operation_id, 'identity_material_saved')
  await onCheckpoint?.('private_key_persisted')

  const existingManifest = await readdir(stagePath)
  if (!existingManifest.includes(manifestFileName)) {
    const keyBytes = await readProtectedFile(privateKeyPath, 'identity_private_key')
    const imported = createPrivateKey({ key: keyBytes, format: 'pem', type: 'pkcs8' })
    const exportedJwk = createPublicKey(imported).export({ format: 'jwk' })
    if (exportedJwk.kty !== 'OKP' || exportedJwk.crv !== 'Ed25519' || typeof exportedJwk.x !== 'string') {
      fail('identity_mismatch', 'identity_public_key_invalid', 'Node.js could not derive an Ed25519 public JWK')
    }
    const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: exportedJwk.x }
    const manifest: IdentityManifest = {
      schema: 1,
      operation_id: intent.operation_id,
      database_id: intent.database_id,
      instance_id: intent.instance_id,
      identity_jkt: await calculateJwkThumbprint(publicJwk),
      public_jwk: publicJwk,
      private_key_file: privateKeyFileName,
    }
    await writeFileAtomically(join(stagePath, manifestFileName), stagePath, `${JSON.stringify(manifest)}\n`)
    await onCheckpoint?.('identity_manifest_persisted')
  }
  return readAndValidateIdentityDirectory(stagePath)
}

async function listInitializationStages(root: string): Promise<string[]> {
  const names = await readdir(root)
  const stages: string[] = []
  for (const name of names) {
    if (!name.startsWith('.staging-')) continue
    const operationId = name.slice('.staging-'.length)
    if (!parseUuidV4(operationId)) {
      fail('identity_mismatch', 'identity_staging_name_invalid', 'Identity storage contains an invalid staging path')
    }
    const path = join(root, name)
    await validateDirectory(path, 'identity_staging_directory')
    stages.push(operationId)
  }
  return stages
}

async function validateIdentityRootEntries(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    const path = join(root, name)
    if (name === currentDirectoryName) {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        fail('identity_mismatch', 'identity_directory_type_invalid', 'Installed identity path must be a real directory')
      }
      continue
    }
    if (!name.startsWith('.staging-') || !parseUuidV4(name.slice('.staging-'.length))) {
      fail('identity_mismatch', 'identity_root_contents_invalid', 'Identity root contains an unexpected file or directory')
    }
    await validateDirectory(path, 'identity_staging_directory')
  }
}

async function readJournal(client: PoolClient): Promise<InitializationJournal | undefined> {
  const result = await client.query<InitializationJournal>(
    `SELECT operation_id::text, mode, state FROM installation_identity_initializations WHERE singleton = true`,
  )
  return result.rows[0]
}

async function readBinding(client: PoolClient): Promise<BindingRow | undefined> {
  const result = await client.query<BindingRow>(`
    SELECT database_id::text, instance_id::text, identity_jkt, binding_revision::text, binding_state
    FROM installation_binding WHERE singleton = true
  `)
  return result.rows[0]
}

async function assertIdentitySchema(client: PoolClient): Promise<void> {
  const result = await client.query<{ binding: string | null; initializations: string | null }>(`
    SELECT to_regclass(format('%I.%I', current_schema(), 'installation_binding'))::text AS binding,
      to_regclass(format('%I.%I', current_schema(), 'installation_identity_initializations'))::text AS initializations
  `)
  if (!result.rows[0]?.binding || !result.rows[0]?.initializations) {
    fail('unavailable', 'identity_schema_missing', 'The installation identity migration has not been applied')
  }
}

async function findExistingBusinessData(client: PoolClient): Promise<string[]> {
  const tables = await client.query<{ tablename: string }>(`
    SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname = current_schema()
    ORDER BY tablename
  `)
  const present: string[] = []
  for (const { tablename } of tables.rows) {
    if (identityMetadataTables.has(tablename)) continue
    const escaped = `"${tablename.replaceAll('"', '""')}"`
    const defaultRow = defaultBootstrapRows[tablename]
    if (defaultRow) {
      const rows = await client.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(bootstrap_row) - 'updated_at' AS row FROM ${escaped} AS bootstrap_row`,
      )
      if (rows.rows.length === 1 && isDeepStrictEqual(rows.rows[0]?.row, defaultRow)) continue
      if (rows.rows.length === 0) continue
      present.push(tablename)
      continue
    }
    const rows = await client.query(`SELECT EXISTS (SELECT 1 FROM ${escaped} LIMIT 1) AS has_rows`)
    if (rows.rows[0]?.has_rows === true) present.push(tablename)
  }
  return present
}

async function commitInitializationJournal(client: PoolClient, journal: InitializationJournal): Promise<void> {
  await client.query('BEGIN')
  try {
    const locked = await client.query<{ state: string }>(`
      SELECT state FROM installation_identity_initializations WHERE singleton = true FOR UPDATE
    `)
    if (locked.rows[0]?.state === 'preparing' || locked.rows[0]?.state === 'identity_material_saved') {
      await client.query(`
        UPDATE installation_identity_initializations SET state = 'identity_staged'
        WHERE singleton = true AND operation_id = $1 AND state IN ('preparing', 'identity_material_saved')
      `, [journal.operation_id])
    } else if (locked.rows[0]?.state !== 'identity_staged') {
      fail('identity_mismatch', 'identity_initialization_state_invalid', 'Database initialization is not in a recoverable state')
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function advanceJournalState(
  client: PoolClient,
  operationId: string,
  nextState: 'identity_material_saved',
): Promise<void> {
  await client.query('BEGIN')
  try {
    const result = await client.query(`
      UPDATE installation_identity_initializations SET state = $2
      WHERE singleton = true AND operation_id = $1 AND state = 'preparing'
    `, [operationId, nextState])
    if (result.rowCount === 0) {
      const current = await client.query<{ state: string }>(`
        SELECT state FROM installation_identity_initializations WHERE singleton = true AND operation_id = $1
      `, [operationId])
      if (!['identity_material_saved', 'identity_staged'].includes(current.rows[0]?.state ?? '')) {
        fail('identity_mismatch', 'identity_initialization_state_invalid', 'Database initialization state cannot be resumed')
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function bindInstallation(
  client: PoolClient,
  journal: InitializationJournal,
  identity: IdentityManifest,
  onCheckpoint?: InstallationIdentityOptions['onCheckpoint'],
): Promise<void> {
  await client.query('BEGIN')
  try {
    if (journal.mode === 'fresh') {
      await client.query(`SET LOCAL lock_timeout = '5s'`)
      const applicationTables = await client.query<{ tablename: string }>(`
        SELECT tablename FROM pg_catalog.pg_tables
        WHERE schemaname = current_schema()
        ORDER BY tablename
      `)
      for (const { tablename } of applicationTables.rows) {
        if (identityMetadataTables.has(tablename)) continue
        const escaped = `"${tablename.replaceAll('"', '""')}"`
        await client.query(`LOCK TABLE ${escaped} IN SHARE MODE`)
      }
      if ((await findExistingBusinessData(client)).length > 0) {
        fail('not_verified', 'existing_business_data_requires_adoption', 'Business data appeared during initialization; explicit controlled adoption is required')
      }
    }
    const locked = await client.query<{ operation_id: string; mode: InstallationInitializationMode; state: string }>(`
      SELECT operation_id::text, mode, state FROM installation_identity_initializations
      WHERE singleton = true FOR UPDATE
    `)
    const current = locked.rows[0]
    if (!current || current.operation_id !== journal.operation_id || current.mode !== journal.mode) {
      fail('identity_mismatch', 'identity_initialization_changed', 'Database initialization journal changed during identity installation')
    }
    const binding = await readBinding(client)
    if (binding) {
      if (binding.database_id !== identity.database_id || binding.instance_id !== identity.instance_id
        || binding.identity_jkt !== identity.identity_jkt || binding.binding_revision !== '1'
        || binding.binding_state !== 'ready') {
        fail('identity_mismatch', 'identity_binding_mismatch', 'Database binding does not match the staged instance identity')
      }
    } else {
      if (current.state !== 'identity_staged') {
        fail('identity_mismatch', 'identity_material_not_staged', 'Database identity cannot bind before the private key and manifest are durable')
      }
      await client.query(`
        INSERT INTO installation_binding
          (singleton, database_id, instance_id, identity_jkt, binding_revision, binding_state)
        VALUES (true, $1, $2, $3, 1, 'ready')
      `, [identity.database_id, identity.instance_id, identity.identity_jkt])
    }
    await client.query(`
      UPDATE installation_identity_initializations
      SET state = 'committed', committed_at = clock_timestamp()
      WHERE singleton = true AND operation_id = $1 AND state = 'identity_staged'
    `, [journal.operation_id])
    await onCheckpoint?.('binding_transaction_before_commit')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
  await onCheckpoint?.('binding_transaction_committed')
}

async function compareIdentity(
  client: PoolClient,
  root: string,
): Promise<InstallationIdentitySnapshot> {
  const journal = await readJournal(client)
  const binding = await readBinding(client)
  const currentPath = join(root, currentDirectoryName)
  let currentExists = false
  const rootEntries = await readdir(root)
  for (const name of rootEntries) {
    if (name === currentDirectoryName) continue
    if (!name.startsWith('.staging-') || !parseUuidV4(name.slice('.staging-'.length))) {
      fail('identity_mismatch', 'identity_root_contents_invalid', 'Identity root contains an unexpected file or directory')
    }
    await validateDirectory(join(root, name), 'identity_staging_directory')
  }
  try {
    const currentInfo = await lstat(currentPath)
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) {
      fail('identity_mismatch', 'identity_directory_type_invalid', 'Installed identity path must be a real directory')
    }
    currentExists = true
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }

  if (!binding) {
    if (currentExists || journal) {
      return {
        status: 'identity_mismatch',
        code: journal ? 'identity_initialization_incomplete' : 'identity_files_without_database_binding',
      }
    }
    return { status: 'not_verified', code: 'identity_not_initialized' }
  }
  if (!journal || journal.state !== 'committed') {
    return { status: 'identity_mismatch', code: 'identity_journal_binding_mismatch' }
  }
  if (rootEntries.some(name => name.startsWith('.staging-'))) {
    return {
      status: 'identity_mismatch',
      code: 'identity_staging_present',
      databaseId: binding.database_id,
      instanceId: binding.instance_id,
      identityJkt: binding.identity_jkt,
      bindingRevision: binding.binding_revision,
      bindingState: binding.binding_state,
      initializationMode: journal.mode,
    }
  }
  if (binding.binding_state !== 'ready') {
    return {
      status: 'unavailable',
      code: 'identity_rebind_pending',
      databaseId: binding.database_id,
      instanceId: binding.instance_id,
      identityJkt: binding.identity_jkt,
      bindingRevision: binding.binding_revision,
      bindingState: binding.binding_state,
      initializationMode: journal.mode,
    }
  }
  if (!currentExists) {
    return {
      status: 'identity_mismatch',
      code: 'identity_files_missing',
      databaseId: binding.database_id,
      instanceId: binding.instance_id,
      identityJkt: binding.identity_jkt,
      bindingRevision: binding.binding_revision,
      bindingState: binding.binding_state,
      initializationMode: journal.mode,
    }
  }
  const identity = await readAndValidateIdentityDirectory(currentPath)
  if (identity.operation_id !== journal.operation_id || identity.database_id !== binding.database_id
    || identity.instance_id !== binding.instance_id || identity.identity_jkt !== binding.identity_jkt
    || binding.binding_revision !== '1' || identity.initializationMode !== journal.mode) {
    return {
      status: 'identity_mismatch',
      code: identity.initializationMode !== journal.mode ? 'identity_intent_journal_mismatch' : 'identity_binding_mismatch',
      databaseId: binding.database_id,
      instanceId: binding.instance_id,
      identityJkt: binding.identity_jkt,
      bindingRevision: binding.binding_revision,
      bindingState: binding.binding_state,
      initializationMode: journal.mode,
    }
  }
  return {
    status: 'ready',
    code: 'identity_verified',
    databaseId: binding.database_id,
    instanceId: binding.instance_id,
    identityJkt: binding.identity_jkt,
    bindingRevision: binding.binding_revision,
    bindingState: binding.binding_state,
    initializationMode: journal.mode,
    businessDataProvenance: journal.mode === 'fresh'
      ? 'empty_at_initialization'
      : 'operator_confirmed_not_verified',
  }
}

export async function initializeInstallationIdentity(
  pool: Pool,
  options: InstallationIdentityOptions,
): Promise<InstallationIdentitySnapshot> {
  const root = await createIdentityRoot(options.identityRoot, options.forbiddenRoots ?? [])
  await validateIdentityRootEntries(root)
  const client = await pool.connect()
  let lockAcquired = false
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
    lockAcquired = true
    await assertIdentitySchema(client)

    const existingBinding = await readBinding(client)
    if (existingBinding) {
      const verified = await compareIdentity(client, root)
      if (verified.status !== 'ready') {
        fail(verified.status === 'not_verified' ? 'identity_mismatch' : verified.status,
          verified.code, 'Existing database binding does not match a complete instance identity; automatic replacement is forbidden')
      }
      if (verified.initializationMode !== options.mode) {
        fail('identity_mismatch', 'initialization_mode_mismatch', 'Repeated initialization must use the original persisted initialization mode')
      }
      return verified
    }

    let journal = await readJournal(client)
    const installedPath = join(root, currentDirectoryName)
    const installedInfo = await lstat(installedPath).catch(error => {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    })
    if (!journal && installedInfo) {
      fail('identity_mismatch', 'identity_files_without_database_binding', 'Identity files exist without their original database initialization journal')
    }
    if (journal?.state === 'committed') {
      fail('identity_mismatch', 'identity_binding_missing', 'Database initialization is committed but its binding is missing')
    }

    const businessTables = await findExistingBusinessData(client)
    if (options.mode === 'fresh' && businessTables.length > 0) {
      fail('not_verified', 'existing_business_data_requires_adoption', 'Existing application data requires the explicit controlled-adoption flow')
    }
    if (options.mode === 'adopt_existing' && businessTables.length > 0 && options.confirmExistingData !== true) {
      fail('not_verified', 'existing_data_confirmation_required', 'Controlled adoption requires the explicit --confirm-existing-data confirmation')
    }

    if (!journal) {
      const operationId = randomUUID()
      await client.query('BEGIN')
      try {
        await client.query(`
          INSERT INTO installation_identity_initializations (singleton, operation_id, mode, state)
          VALUES (true, $1, $2, 'preparing')
        `, [operationId, options.mode])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
      journal = { operation_id: operationId, mode: options.mode, state: 'preparing' }
      await options.onCheckpoint?.('initialization_journal_committed')
    } else if (journal.mode !== options.mode) {
      fail('identity_mismatch', 'initialization_mode_mismatch', 'Resume must use the same explicit initialization mode as the persisted journal')
    }

    const otherStages = (await listInitializationStages(root)).filter(operationId => operationId !== journal?.operation_id)
    if (!installedInfo && otherStages.length > 0) {
      fail('not_verified', 'identity_initialization_ambiguous', 'Another interrupted initialization is present; operator must identify the intended database before recovery')
    }

    let identity: IdentityManifest
    if (installedInfo) {
      await validateDirectory(installedPath, 'identity_directory')
      identity = await readAndValidateIdentityDirectory(installedPath)
      if (identity.operation_id !== journal.operation_id) {
        fail('identity_mismatch', 'identity_directory_database_mismatch', 'Installed identity belongs to a different database initialization')
      }
    } else {
      if (journal.state === 'identity_material_saved' || journal.state === 'identity_staged') {
        const stagePath = join(root, `.staging-${journal.operation_id}`)
        const stageInfo = await lstat(stagePath).catch(error => {
          if (errorCode(error) === 'ENOENT') return undefined
          throw error
        })
        if (!stageInfo) {
          fail('identity_mismatch', 'identity_material_missing', 'Database records staged identity material that is missing from disk')
        }
      }
      identity = await prepareIdentityStage(root, journal, client, options.onCheckpoint)
      const stagePath = join(root, `.staging-${journal.operation_id}`)
      try {
        await rename(stagePath, installedPath)
      } catch (error) {
        if (errorCode(error) === 'EEXIST' || errorCode(error) === 'ENOTEMPTY') {
          fail('identity_mismatch', 'identity_directory_claimed', 'Another identity directory was installed concurrently; automatic replacement is forbidden')
        }
        throw error
      }
      await fsyncDirectory(root)
      await options.onCheckpoint?.('identity_directory_installed')
      identity = await readAndValidateIdentityDirectory(installedPath)
    }

    await commitInitializationJournal(client, journal)
    journal = { ...journal, state: 'identity_staged' }
    await bindInstallation(client, journal, identity, options.onCheckpoint)
    const verified = await compareIdentity(client, root)
    if (verified.status !== 'ready') {
      fail(verified.status === 'not_verified' ? 'identity_mismatch' : verified.status,
        verified.code, 'Identity initialization committed but final verification did not match')
    }
    return verified
  } catch (error) {
    if (error instanceof InstallationIdentityError) throw error
    throw new InstallationIdentityError('unavailable', 'identity_initialization_unavailable', 'Instance identity initialization could not be completed', { cause: error })
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined)
    }
    client.release()
  }
}

export async function verifyInstallationIdentity(
  pool: Pool,
  identityRoot: string,
  forbiddenRoots: string[] = [],
): Promise<InstallationIdentitySnapshot> {
  let root: string
  try {
    root = await requireIdentityRoot(identityRoot, forbiddenRoots)
  } catch (error) {
    if (error instanceof InstallationIdentityError) return { status: error.status, code: error.code }
    return { status: 'unavailable', code: 'identity_root_unavailable' }
  }
  const client = await pool.connect()
  try {
    await assertIdentitySchema(client)
    return await compareIdentity(client, root)
  } catch (error) {
    if (error instanceof InstallationIdentityError) return { status: error.status, code: error.code }
    return { status: 'unavailable', code: 'identity_verification_unavailable' }
  } finally {
    client.release()
  }
}

export function identityDataDirectory(identityRoot: string): string {
  return join(resolve(identityRoot), currentDirectoryName)
}

export function isIdentityPathWithin(parent: string, child: string): boolean {
  return isPathWithin(resolve(parent), resolve(child))
}
