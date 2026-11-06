import { trustedAncestors } from './restic-local.js'
import { lstat, realpath } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { isAbsolute, resolve } from 'node:path'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import type { QuiesceAdapter } from './coordinator.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { dockerExec } from './docker-client.js'

type Role = 'aikayun_app' | 'aikayun_migrator'
type Container = { Id: string; Config: { Labels: Record<string, string> }; State: { Status: string; Running: boolean; Paused: boolean; Restarting: boolean }; Mounts: { Name?: string; Type: string; RW: boolean; Destination: string }[] }
type Managed = { id: string; service: string }

/** Supplied by the signed host process that owns the original locked FD. An
 * unrelated lock holder or a test that merely sees a lock file is not proof. */
export interface HostFenceProof {
  assertOwnedLock(): Promise<void>
  verifyDeployment(expected: string): Promise<void>
}

/** All names and identities are supplied by an authenticated deployment loader.
 * Production must use its fixed deployment; fixture IDs are isolated separately. */
export interface DockerPgFenceConfiguration {
  dockerBinary?: string
  dockerSocket?: string
  dockerHome?: string
  project: string
  deployment: string
  stateVolumes: readonly [string, string, string]
  managed: readonly Managed[]
  db: Kysely<Database>
  host: HostFenceProof
  /** A short, bounded grace period for PostgreSQL to observe clients disconnecting
   * after their containers have stopped. This never permits a remaining client. */
  databaseClientDrainTimeoutMs?: number
}

const idPattern = /^[a-f0-9]{64}$/
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const DEFAULT_DATABASE_CLIENT_DRAIN_TIMEOUT_MS = 10_000
const DATABASE_CLIENT_DRAIN_POLL_INTERVAL_MS = 100

export async function waitForDatabaseClientsToDrain(
  db: Kysely<Database>,
  timeoutMs = DEFAULT_DATABASE_CLIENT_DRAIN_TIMEOUT_MS,
  pollIntervalMs = DATABASE_CLIENT_DRAIN_POLL_INTERVAL_MS,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000) {
    throw new Error('FENCE_DATABASE_CLIENT_PRESENT')
  }
  const deadline = performance.now() + timeoutMs
  while (true) {
    const result = await sql<{ count: string; prepared: string }>`SELECT
      (SELECT count(*)::text FROM pg_catalog.pg_stat_activity
        WHERE pid <> pg_backend_pid() AND backend_type IN ('client backend', 'logical replication worker', 'walsender')) AS count,
      (SELECT count(*)::text FROM pg_catalog.pg_prepared_xacts) AS prepared`.execute(db)
    const row = result.rows[0]
    if (result.rows.length !== 1 || !row || !/^\d+$/.test(row.count) || !/^\d+$/.test(row.prepared)) {
      throw new Error('FENCE_DATABASE_CLIENT_PRESENT')
    }
    if (row.prepared !== '0') throw new Error('FENCE_DATABASE_CLIENT_PRESENT')
    if (row.count === '0') return
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) throw new Error('FENCE_DATABASE_CLIENT_PRESENT')
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, remainingMs))))
  }
}

/** Root/Docker administrators are trusted to use the signed, shared-lock
 * commands. They can intentionally bypass this protocol, which cannot be
 * prevented by container inspection. This class is not a production entrypoint. */
export class DockerPgQuiesceAdapter implements QuiesceAdapter {
  private readonly services = new Map<string, string>()
  private readonly volumes: Set<string>
  private readonly databaseClientDrainTimeoutMs: number
  constructor(private readonly config: DockerPgFenceConfiguration) {
    if (!config.host || typeof config.host.assertOwnedLock !== 'function' || typeof config.host.verifyDeployment !== 'function' ||
        !/^[a-f0-9]{64}$/.test(config.deployment) || !namePattern.test(config.project) || config.managed.length === 0 ||
        config.stateVolumes.length !== 3 || new Set(config.stateVolumes).size !== 3 || !config.stateVolumes.every(name => namePattern.test(name))) {
      throw new Error('FENCE_CONFIGURATION_INVALID')
    }
    this.databaseClientDrainTimeoutMs = config.databaseClientDrainTimeoutMs ?? DEFAULT_DATABASE_CLIENT_DRAIN_TIMEOUT_MS
    if (!Number.isSafeInteger(this.databaseClientDrainTimeoutMs) || this.databaseClientDrainTimeoutMs < 0 ||
        this.databaseClientDrainTimeoutMs > 30_000) throw new Error('FENCE_CONFIGURATION_INVALID')
    for (const service of config.managed) {
      // The PostgreSQL server must remain up for the controlled dump.
      if (!idPattern.test(service.id) || !['api', 'web', 'caddy', 'db-role-init', 'state-volume-init', 'migrate', 'production-install-init'].includes(service.service) || this.services.has(service.id)) throw new Error('FENCE_CONFIGURATION_INVALID')
      this.services.set(service.id, service.service)
    }
    this.volumes = new Set(config.stateVolumes)
  }

  async assertLock(): Promise<void> { await this.config.host.assertOwnedLock() }

  private async docker(args: string[]): Promise<string> {
    const { dockerBinary, dockerSocket, dockerHome } = this.config
    if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') {
      try { return await dockerExec(undefined, undefined, args, { timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 }) }
      catch { throw new Error('FENCE_DOCKER_UNAVAILABLE') }
    }
    if (!dockerBinary || !dockerSocket || !dockerHome || ![dockerBinary, dockerSocket, dockerHome].every(path => isAbsolute(path) && resolve(path) === path)) throw new Error('FENCE_DOCKER_CONFIGURATION_INVALID')
    const socket = await lstat(dockerSocket)
    if (!socket.isSocket() || socket.isSymbolicLink() || (socket.uid !== 0 && socket.uid !== process.getuid?.()) || await realpath(dockerSocket) !== dockerSocket) throw new Error('FENCE_DOCKER_SOCKET_INVALID')
    const binary = await lstat(dockerBinary)
    const uid = process.getuid?.()
    if (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0 ||
        (uid !== undefined && binary.uid !== 0 && binary.uid !== uid) || await realpath(dockerBinary) !== dockerBinary) throw new Error('FENCE_DOCKER_BINARY_INVALID')
    await trustedAncestors(dockerBinary)
    await trustedAncestors(dockerSocket)
    try {
      // stop allows 30 seconds for graceful shutdown before Docker sends KILL;
      // the client deadline must be longer, or a normal stop appears unknown.
      return await dockerExec(dockerBinary, dockerSocket, args, { ...(dockerHome ? { home: dockerHome } : {}), timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 })
    } catch { throw new Error('FENCE_DOCKER_UNAVAILABLE') }
  }

  private async inspect(ids: string[]): Promise<Container[]> {
    if (!ids.every(id => idPattern.test(id)) || new Set(ids).size !== ids.length) throw new Error('FENCE_CONTAINER_ID_INVALID')
    if (!ids.length) return []
    // Inspect only the required fields: full Docker inspect contains environment
    // variables and can include credentials belonging to other containers.
    const template = '{{json .Id}}\t{{json (index .Config.Labels "com.docker.compose.project")}}\t{{json (index .Config.Labels "com.docker.compose.service")}}\t{{json .State.Status}}\t{{json .State.Running}}\t{{json .State.Paused}}\t{{json .State.Restarting}}\t{{json .Mounts}}'
    const raw = await this.docker(['inspect', '--type', 'container', '--format', template, ...ids])
    const lines = raw.trim().split('\n')
    if (lines.length !== ids.length) throw new Error('FENCE_INSPECT_FAILED')
    const containers: Container[] = []
    for (const line of lines) {
      let columns: unknown[]
      try { columns = line.split('\t').map(value => JSON.parse(value) as unknown) } catch { throw new Error('FENCE_INSPECT_FAILED') }
      const [id, project, service, status, running, paused, restarting, mounts] = columns
      if (columns.length !== 8 || typeof id !== 'string' || !ids.includes(id) ||
          !(project === null || typeof project === 'string') || !(service === null || typeof service === 'string') ||
          typeof status !== 'string' || typeof running !== 'boolean' || typeof paused !== 'boolean' || typeof restarting !== 'boolean' ||
          !Array.isArray(mounts) || mounts.some((mount: { Type?: unknown; RW?: unknown; Name?: unknown; Destination?: unknown }) => typeof mount.Type !== 'string' || typeof mount.RW !== 'boolean' || typeof mount.Destination !== 'string' || (mount.Type === 'volume' && typeof mount.Name !== 'string'))) throw new Error('FENCE_INSPECT_FAILED')
      containers.push({ Id: id, Config: { Labels: { 'com.docker.compose.project': project ?? '', 'com.docker.compose.service': service ?? '' } },
        State: { Status: status, Running: running, Paused: paused, Restarting: restarting }, Mounts: mounts })
    }
    if (new Set(containers.map(item => item.Id)).size !== ids.length) throw new Error('FENCE_INSPECT_FAILED')
    return containers
  }

  private async managed(id: string): Promise<Container> {
    const service = this.services.get(id)
    if (!service) throw new Error('FENCE_CONTAINER_NOT_MANAGED')
    const container = (await this.inspect([id]))[0]!
    if (container.Config.Labels['com.docker.compose.project'] !== this.config.project ||
        container.Config.Labels['com.docker.compose.service'] !== service) throw new Error('FENCE_CONTAINER_IDENTITY_CHANGED')
    const expected: Record<string, string> = {}
    if (['api', 'state-volume-init', 'migrate', 'production-install-init'].includes(service)) expected['/var/lib/aikayun'] = this.config.stateVolumes[0]
    if (service === 'caddy') {
      expected['/data'] = this.config.stateVolumes[1]
      expected['/config'] = this.config.stateVolumes[2]
    }
    const actual = container.Mounts.filter(mount => mount.Type === 'volume')
    const postgresDefaults = actual.filter(mount => mount.Destination === '/var/lib/postgresql' &&
      (service === 'db-role-init' || service === 'state-volume-init'))
    if (postgresDefaults.length > 1) throw new Error('FENCE_CONTAINER_MOUNTS_INVALID')
    if (postgresDefaults.length === 1) {
      const mount = postgresDefaults[0]!
      if (!mount.RW || !mount.Name || !/^[a-f0-9]{64}$/.test(mount.Name)) throw new Error('FENCE_CONTAINER_MOUNTS_INVALID')
      let volume: unknown
      try { volume = JSON.parse(await this.docker(['volume', 'inspect', mount.Name])) as unknown }
      catch { throw new Error('FENCE_CONTAINER_MOUNTS_INVALID') }
      if (!Array.isArray(volume) || volume.length !== 1 || !volume[0] || typeof volume[0] !== 'object' ||
          volume[0].Name !== mount.Name || volume[0].Driver !== 'local' || volume[0].Scope !== 'local' ||
          !volume[0].Labels || typeof volume[0].Labels !== 'object' || !Object.hasOwn(volume[0].Labels, 'com.docker.volume.anonymous') ||
          (volume[0].Options !== null && volume[0].Options !== undefined &&
            (typeof volume[0].Options !== 'object' || Array.isArray(volume[0].Options) || Object.keys(volume[0].Options).length !== 0))) throw new Error('FENCE_CONTAINER_MOUNTS_INVALID')
    }
    const controlled = actual.filter(mount => !postgresDefaults.includes(mount))
    if (controlled.length !== Object.keys(expected).length || controlled.some(mount => !mount.RW || expected[mount.Destination] !== mount.Name) ||
        container.Mounts.some(mount => mount.Type === 'bind' && mount.RW)) throw new Error('FENCE_CONTAINER_MOUNTS_INVALID')
    return container
  }

  async assertDeployment(expected: string): Promise<void> {
    await this.assertLock()
    if (expected !== this.config.deployment) throw new Error('FENCE_DEPLOYMENT_CHANGED')
    await this.config.host.verifyDeployment(expected)
    for (const id of this.services.keys()) await this.managed(id)
  }

  async containerState(id: string): Promise<'running' | 'stopped' | 'unknown'> {
    await this.assertLock()
    const container = await this.managed(id)
    if (container.State.Paused || container.State.Restarting) return 'unknown'
    if (container.State.Running && container.State.Status === 'running') return 'running'
    if (!container.State.Running && (container.State.Status === 'exited' || container.State.Status === 'created')) return 'stopped'
    return 'unknown'
  }

  async stopContainer(id: string): Promise<void> {
    await this.assertLock()
    if (await this.containerState(id) !== 'running') throw new Error('FENCE_CONTAINER_STATE_UNCERTAIN')
    try { await this.docker(['stop', '--time', '30', id]) }
    catch { throw new UnsafeMaintenanceRecoveryError('FENCE_CONTAINER_COMMAND_UNCERTAIN') }
  }

  async startContainer(id: string): Promise<void> {
    await this.assertLock()
    if (await this.containerState(id) !== 'stopped') throw new Error('FENCE_CONTAINER_STATE_UNCERTAIN')
    try { await this.docker(['start', id]) }
    catch { throw new UnsafeMaintenanceRecoveryError('FENCE_CONTAINER_COMMAND_UNCERTAIN') }
  }

  async roleLogin(name: Role): Promise<boolean | null> {
    await this.assertLock()
    if (name !== 'aikayun_app' && name !== 'aikayun_migrator') throw new Error('FENCE_ROLE_INVALID')
    const rows = await sql<{ rolcanlogin: boolean }>`SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = ${name}`.execute(this.config.db)
    return rows.rows.length === 1 && typeof rows.rows[0]?.rolcanlogin === 'boolean' ? rows.rows[0].rolcanlogin : null
  }

  async setRoleLogin(name: Role, allowed: boolean): Promise<void> {
    await this.assertLock()
    if ((name !== 'aikayun_app' && name !== 'aikayun_migrator') || typeof allowed !== 'boolean') throw new Error('FENCE_ROLE_INVALID')
    // Both identifiers and actions are closed allowlists; never interpolate input.
    const statement = name === 'aikayun_app'
      ? allowed ? 'ALTER ROLE aikayun_app LOGIN' : 'ALTER ROLE aikayun_app NOLOGIN'
      : allowed ? 'ALTER ROLE aikayun_migrator LOGIN' : 'ALTER ROLE aikayun_migrator NOLOGIN'
    try { await sql.raw(statement).execute(this.config.db) }
    catch { throw new UnsafeMaintenanceRecoveryError('FENCE_ROLE_CHANGE_UNCERTAIN') }
  }

  private async assertVolumeWriters(allowManaged: boolean): Promise<void> {
    // Docker's volume filter avoids a race with unrelated short-lived
    // containers elsewhere on the host. Every relevant container is still
    // inspected; disappearance or any other uncertainty remains a failure.
    const ids = new Set<string>()
    for (const volume of this.volumes) {
      const raw = await this.docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `volume=${volume}`])
      for (const id of raw.trim() ? raw.trim().split(/\s+/) : []) {
        if (!idPattern.test(id)) throw new Error('FENCE_INSPECT_FAILED')
        ids.add(id)
      }
    }
    const containers = await this.inspect([...ids])
    for (const container of containers) {
      const writing = container.Mounts.some(mount => mount.Type === 'volume' && mount.RW && mount.Name && this.volumes.has(mount.Name))
      if (!writing || (!container.State.Running && !container.State.Paused && !container.State.Restarting)) continue
      if (!allowManaged || !this.services.has(container.Id)) throw new Error('FENCE_VOLUME_WRITER_PRESENT')
      await this.managed(container.Id)
    }
  }

  private async assertNoClients(): Promise<void> {
    await waitForDatabaseClientsToDrain(this.config.db, this.databaseClientDrainTimeoutMs)
  }

  async assertNoWriters(): Promise<void> {
    await this.assertLock()
    await this.assertVolumeWriters(false)
    if (await this.roleLogin('aikayun_app') !== false || await this.roleLogin('aikayun_migrator') !== false) throw new Error('FENCE_ROLE_LOGIN_ENABLED')
    await this.assertNoClients()
  }

  async assertRestorationSafe(): Promise<void> {
    await this.assertLock()
    await this.assertVolumeWriters(true)
    await this.assertNoClients()
  }
}

/** Fixed customer deployment; arbitrary names are reserved for isolated tests. */
export function productionDockerPgFence(config: Omit<DockerPgFenceConfiguration, 'project' | 'stateVolumes'>): DockerPgQuiesceAdapter {
  return new DockerPgQuiesceAdapter({ ...config, project: 'aikayun', stateVolumes: ['aikayun_state', 'aikayun_caddy_data', 'aikayun_caddy_config'] })
}
