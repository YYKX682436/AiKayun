import { isBackupPostgresImage } from './postgres-image.js'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolConfig } from 'pg'
import type { Database } from '../db/types.js'
import { trustedAncestors } from './restic-local.js'
import { dockerExec } from './docker-client.js'

type DatabaseTargetInput = {
  /** A dedicated bootstrap pool; ownership stays within this scope. */
  databaseConfig: PoolConfig
  dockerBinary?: string
  dockerSocket?: string
  containerId: string
  postgresImage: string
  database: string
  bootstrapUser: string
  /** Must prove the inherited exclusive host lock each time. */
  assertLock(): Promise<void>
  /** Must authenticate the installer-owned signed deployment and image. */
  assertSignedDeployment(): Promise<void>
}
export interface ProvenDatabaseTarget {
  /** A single pinned connection. The adapter and capture operations must share it. */
  db: Kysely<Database>
  /** Re-prove lock, signature, container identity and this exact backend. */
  assertBound(): Promise<void>
}
type Fixture = { project: string; volume: string }

async function verifyExecutable(input: DatabaseTargetInput) {
  if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') return
  const binaryPath = input.dockerBinary, socketPath = input.dockerSocket
  if (!binaryPath || !socketPath) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
  for (const path of [binaryPath, socketPath]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
    await trustedAncestors(path)
  }
  const [binary, socket] = await Promise.all([lstat(binaryPath), lstat(socketPath)])
  const uid = process.getuid?.()
  if (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || (binary.mode & 0o022) !== 0 ||
      (binary.mode & 0o111) === 0 || (binary.uid !== 0 && binary.uid !== uid) || !socket.isSocket() || socket.isSymbolicLink() ||
      (socket.uid !== 0 && socket.uid !== uid)) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
}

/** Internal scope: holds one DB connection throughout the callback. An
 * arbitrary pooled connection or matching database UUID alone is not proof. */
async function withTarget<T>(input: DatabaseTargetInput, scope: Fixture, operation: (target: ProvenDatabaseTarget) => Promise<T>): Promise<T> {
  if (!input || !input.databaseConfig || typeof operation !== 'function' || typeof input.assertLock !== 'function' ||
      typeof input.assertSignedDeployment !== 'function' || !/^[a-f0-9]{64}$/.test(input.containerId) ||
      !isBackupPostgresImage(input.postgresImage) ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(input.database) || !/^[a-z_][a-z0-9_]{0,62}$/.test(input.bootstrapUser)) {
    throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
  }
  async function docker(args: string[]) {
    if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') {
      try { return await dockerExec(undefined, undefined, args, { timeoutMs: 30000, maxBuffer: 1024 * 1024 }) }
      catch { throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED') }
    }
    await verifyExecutable(input)
    try {
      return await dockerExec(input.dockerBinary, input.dockerSocket, args, { timeoutMs: 30000, maxBuffer: 1024 * 1024 })
    } catch { throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED') }
  }
  async function inspect() {
    const format = '{{json .Id}}\t{{json .Config.Image}}\t{{json (index .Config.Labels "com.docker.compose.project")}}\t{{json (index .Config.Labels "com.docker.compose.service")}}\t{{json .State.Running}}\t{{json .State.StartedAt}}\t{{json .Mounts}}'
    const text = await docker(['inspect', '--type', 'container', '--format', format, input.containerId])
    let fields: unknown[]
    try { fields = text.trim().split('\t').map(value => JSON.parse(value) as unknown) } catch { throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED') }
    const [id, image, project, service, running, started, mounts] = fields
    if (fields.length !== 7 || id !== input.containerId || image !== input.postgresImage || project !== scope.project || service !== 'db' ||
        running !== true || typeof started !== 'string' || !started || !Array.isArray(mounts)) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
    const writable = mounts.filter((item: { RW?: unknown }) => item.RW === true)
    if (writable.length !== 1 || writable[0]?.Type !== 'volume' || writable[0]?.Name !== scope.volume ||
        writable[0]?.Destination !== '/var/lib/postgresql' || mounts.some((item: { Type?: unknown; Name?: unknown }) =>
          item.Type === 'volume' && item.Name !== scope.volume)) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
    return started
  }
  // Do not even open a DB connection until lock, release and container identity
  // have been authenticated. The callback must also authenticate the network.
  await input.assertLock()
  await input.assertSignedDeployment()
  await inspect()
  await input.assertLock()
  let connectionLost = false
  const pool = new Pool({ ...input.databaseConfig, max: 1 })
  // pg emits errors on a checked-out client when the server disappears.
  // Consume them without logging provider details and invalidate this proof.
  pool.on('connect', client => { client.on('error', () => { connectionLost = true }) })
  pool.on('error', () => { connectionLost = true })
  const database = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  try { return await database.connection().execute(async db => {
    let originalBackend: string | undefined
    let originalStart: string | undefined
    let active = true
    async function assertBound() {
      if (!active || connectionLost) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
      await input.assertLock()
      await input.assertSignedDeployment()
      const started = await inspect()
      await db.transaction().execute(async tx => {
        await sql`SET TRANSACTION READ ONLY`.execute(tx)
        const marker = `aikayun_backup_proof_${randomBytes(16).toString('hex')}`
        await sql`SELECT set_config('application_name', ${marker}, true)`.execute(tx)
        const result = await sql<{ pid: number; backend: string; database: string; username: string; version: number }>`
          SELECT pg_backend_pid() AS pid, backend_start::text AS backend, current_database() AS database,
            current_user AS username, current_setting('server_version_num')::int / 10000 AS version
          FROM pg_catalog.pg_stat_activity WHERE pid = pg_backend_pid()
        `.execute(tx)
        const row = result.rows[0]
        if (result.rows.length !== 1 || !row || !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.backend !== 'string' ||
            row.database !== input.database || row.username !== input.bootstrapUser || row.version !== 18) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
        const fingerprint = `${row.pid}:${row.backend}`
        if ((originalBackend && originalBackend !== fingerprint) || (originalStart && originalStart !== started)) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
        // All interpolation is from closed names, integer PID or generated hex;
        // no password or business data is passed to Docker or logs.
        const query = `SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid = ${row.pid} AND datname = '${input.database}' AND usename = '${input.bootstrapUser}' AND application_name = '${marker}'`
        const seen = await docker(['exec', input.containerId, 'psql', '-X', '--no-password', '--host=/var/run/postgresql',
          `--username=${input.bootstrapUser}`, `--dbname=${input.database}`, '-v', 'ON_ERROR_STOP=1', '-Atc', query])
        if (seen.trim() !== '1') throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
        originalBackend = fingerprint
        originalStart = started
      })
      if (await inspect() !== started) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
      await input.assertSignedDeployment()
      await input.assertLock()
      if (connectionLost) throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
    }
    try {
      await assertBound()
      const result = await operation({ db, assertBound })
      await assertBound()
      return result
    } finally { active = false }
  }) } finally { await database.destroy() }
}

/** Fixed customer identifiers; the caller must supply real lock and signature
 * proofs and use target.db for both the fence adapter and evidence reads. */
export function withProvenProductionDatabaseTarget<T>(input: DatabaseTargetInput,
  operation: (target: ProvenDatabaseTarget) => Promise<T>): Promise<T> {
  if (input?.bootstrapUser !== 'aikayun_bootstrap' || !input.databaseConfig || input.databaseConfig.connectionString !== undefined ||
      input.databaseConfig.host !== 'db' || input.databaseConfig.port !== 5432 || input.databaseConfig.user !== input.bootstrapUser ||
      input.databaseConfig.database !== input.database || typeof input.databaseConfig.password !== 'string' || !input.databaseConfig.password) {
    throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
  }
  return withTarget(input, { project: 'aikayun', volume: 'aikayun_postgres_data' }, operation)
}

/** Isolated test container and random volume only. */
export function withProvenFixtureDatabaseTarget<T>(input: DatabaseTargetInput, fixture: string,
  operation: (target: ProvenDatabaseTarget) => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'test' || !/^aikayun-75a-test-[a-f0-9]{24}$/.test(fixture) || input?.bootstrapUser !== 'fixture') {
    throw new Error('BACKUP_DATABASE_TARGET_UNVERIFIED')
  }
  return withTarget(input, { project: fixture, volume: `${fixture}_postgres_data` }, operation)
}
