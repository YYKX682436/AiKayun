import { randomUUID } from 'node:crypto'
import type { PoolConfig } from 'pg'
import { DockerPgQuiesceAdapter, type DockerPgFenceConfiguration, type HostFenceProof } from './docker-pg-fence.js'
import { withProvenFixtureDatabaseTarget, withProvenProductionDatabaseTarget } from './database-target.js'
import type { loadFixedReleaseSource } from './fixed-release-source.js'
import { dockerExec } from './docker-client.js'

type Service = DockerPgFenceConfiguration['managed'][number]['service']
type Images = Record<'api' | 'web' | 'postgres' | 'caddy', string>
type DiscoveryInput = {
  binary?: string; socket?: string; dockerHome?: string; project: string; stateVolumes: readonly [string, string, string]
  postgresImage: string; images: Images; databaseConfig: PoolConfig; database: string; bootstrapUser: string
  fingerprint: string; host: HostFenceProof
}
const order = ['caddy', 'web', 'api', 'production-install-init', 'migrate', 'db-role-init', 'state-volume-init'] as const

async function discover(input: DiscoveryInput, fixture?: string) {
  async function docker(args: string[]) {
    try { return (await dockerExec(input.binary, input.socket, args, { ...(input.dockerHome ? { home: input.dockerHome } : {}), timeoutMs: 30000, maxBuffer: 1024 * 1024 })).trim() }
    catch { throw new Error('BACKUP_DISCOVERY_UNAVAILABLE') }
  }
  async function list() {
    const output = await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=com.docker.compose.project=${input.project}`])
    const ids = output ? output.split(/\s+/).sort() : []
    if (!ids.length || ids.length > 32 || ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('BACKUP_DISCOVERY_INVALID')
    return ids
  }
  await input.host.assertOwnedLock()
  await input.host.verifyDeployment(input.fingerprint)
  const ids = await list()
  const managed: { id: string; service: Service }[] = []
  let databaseId = ''
  for (const id of ids) {
    const text = await docker(['inspect', '--type', 'container', '--format', '{{json .Id}}\t{{json (index .Config.Labels "com.docker.compose.project")}}\t{{json (index .Config.Labels "com.docker.compose.service")}}\t{{json .Config.Image}}', id])
    let values: unknown[]
    try { values = text.split('\t').map(value => JSON.parse(value) as unknown) } catch { throw new Error('BACKUP_DISCOVERY_INVALID') }
    const [actualId, project, service, image] = values
    if (values.length !== 4 || actualId !== id || project !== input.project || typeof service !== 'string' || typeof image !== 'string') throw new Error('BACKUP_DISCOVERY_INVALID')
    if (service === 'db') {
      if (databaseId || image !== input.postgresImage) throw new Error('BACKUP_DISCOVERY_INVALID')
      databaseId = id
      continue
    }
    if (!order.includes(service as typeof order[number])) throw new Error('BACKUP_DISCOVERY_INVALID')
    const expected = service === 'api' || service === 'migrate' || service === 'production-install-init' ? input.images.api
      : service === 'web' ? input.images.web : service === 'caddy' ? input.images.caddy : input.postgresImage
    if (image !== expected) throw new Error('BACKUP_DISCOVERY_IMAGE_MISMATCH')
    managed.push({ id, service })
  }
  if (!databaseId || ['api', 'web', 'caddy'].some(name => managed.filter(item => item.service === name).length !== 1)) throw new Error('BACKUP_DISCOVERY_INVALID')
  managed.sort((a, b) => order.indexOf(a.service as typeof order[number]) - order.indexOf(b.service as typeof order[number]) || a.id.localeCompare(b.id))
  const targetInput = { databaseConfig: input.databaseConfig, ...(input.binary ? { dockerBinary: input.binary } : {}), ...(input.socket ? { dockerSocket: input.socket } : {}),
    containerId: databaseId, postgresImage: input.postgresImage, database: input.database, bootstrapUser: input.bootstrapUser,
    assertLock: () => input.host.assertOwnedLock(), assertSignedDeployment: () => input.host.verifyDeployment(input.fingerprint) }
  const callback = async (target: Parameters<Parameters<typeof withProvenProductionDatabaseTarget>[1]>[0]) => {
    const adapter = new DockerPgQuiesceAdapter({ ...(input.binary ? { dockerBinary: input.binary } : {}), ...(input.socket ? { dockerSocket: input.socket } : {}), ...(input.dockerHome ? { dockerHome: input.dockerHome } : {}),
      project: input.project, stateVolumes: input.stateVolumes, deployment: input.fingerprint, managed, db: target.db, host: input.host })
    await adapter.assertDeployment(input.fingerprint)
    const services = []
    for (const item of managed) {
      const state = await adapter.containerState(item.id)
      if (state === 'unknown' || (state === 'running' && !['api', 'web', 'caddy'].includes(item.service))) throw new Error('BACKUP_DISCOVERY_STATE_UNCERTAIN')
      services.push({ name: item.service, containerId: item.id, running: state === 'running' })
    }
    const app = await adapter.roleLogin('aikayun_app'), migrator = await adapter.roleLogin('aikayun_migrator')
    if (app === null || migrator === null) throw new Error('BACKUP_DISCOVERY_STATE_UNCERTAIN')
    await target.assertBound()
    if ((await list()).join(',') !== ids.join(',')) throw new Error('BACKUP_DISCOVERY_CHANGED')
    return { databaseContainerId: databaseId, managed, snapshot: { deployment: input.fingerprint, backupSetId: randomUUID(), services,
      roles: [{ name: 'aikayun_app' as const, canLogin: app }, { name: 'aikayun_migrator' as const, canLogin: migrator }] } }
  }
  const result = fixture ? await withProvenFixtureDatabaseTarget(targetInput, fixture, callback)
    : await withProvenProductionDatabaseTarget(targetInput, callback)
  await input.host.assertOwnedLock()
  return result
}

/** Only fixed production paths and authenticated release references. */
export async function discoverFixedDeployment(source: Awaited<ReturnType<typeof loadFixedReleaseSource>>) {
  if (!source?.host || !source.databaseConfig) throw new Error('BACKUP_DISCOVERY_INVALID')
  const release = await source.readAuthenticatedRelease()
  const hostBroker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
  return discover({ ...(hostBroker ? {} : { binary: '/usr/bin/docker', socket: '/run/docker.sock', dockerHome: '/var/empty' }), project: 'aikayun',
    stateVolumes: ['aikayun_state', 'aikayun_caddy_data', 'aikayun_caddy_config'], postgresImage: release.postgresImage,
    images: { api: `ghcr.io/yykx682436/aikayun-api@${release.images.api}`, web: `ghcr.io/yykx682436/aikayun-web@${release.images.web}`,
      postgres: release.postgresImage, caddy: `docker.io/library/caddy@${release.images.caddy}` },
    databaseConfig: source.databaseConfig, database: 'aikayun', bootstrapUser: 'aikayun_bootstrap', fingerprint: source.fingerprint, host: source.host })
}

/** Only random labeled fixtures; cannot point at the production project. */
export async function discoverFixtureDeployment(input: DiscoveryInput, fixture: string) {
  if (process.env.NODE_ENV !== 'test' || !/^aikayun-75a-test-[a-f0-9]{24}$/.test(fixture) || input.project !== fixture ||
      input.stateVolumes.join(',') !== [`${fixture}_aikayun_state`, `${fixture}_caddy_data`, `${fixture}_caddy_config`].join(',')) {
    throw new Error('BACKUP_DISCOVERY_FIXTURE_INVALID')
  }
  return discover(input, fixture)
}
