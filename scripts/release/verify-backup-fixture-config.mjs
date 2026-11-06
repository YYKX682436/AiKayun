import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export function verifyFixtureConfig(config, project, allowedBinds = [], allowedLoopbackPort) {
  if (!/^aikayun-75a-test-[a-f0-9]{24}$/.test(project)) throw new Error('Unsafe fixture project')
  const keys = ['postgres_data', 'aikayun_state', 'caddy_data', 'caddy_config']
  if (!config || typeof config !== 'object' || config.name !== project || !config.volumes || !config.services || !config.networks) throw new Error('Invalid fixture config')
  if (Object.keys(config.volumes).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Unexpected fixture volumes')
  const allowed = new Set(keys.map(key => `${project}_${key}`))
  for (const key of keys) if (config.volumes[key]?.name !== `${project}_${key}`) throw new Error('Unexpected volume name')
  if (config.networks.private?.name !== `${project}_private`) throw new Error('Unexpected network name')
  const networks = Object.keys(config.networks).sort()
  if (networks.some(name => name !== 'private' && name !== 'postgres_test')) throw new Error('Unexpected fixture network')
  if (config.networks.postgres_test && (config.networks.postgres_test.name !== `${project}_postgres_test` ||
      config.networks.postgres_test.driver !== 'bridge' || config.networks.postgres_test.internal === true ||
      config.networks.postgres_test.driver_opts?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false')) {
    throw new Error('Unsafe PostgreSQL test network')
  }
  for (const [serviceName, service] of Object.entries(config.services)) {
    const attached = Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {})
    if (attached.some(name => name !== 'private' && !(serviceName === 'db' && name === 'postgres_test'))) {
      throw new Error('Unexpected service network')
    }
    if (config.networks.postgres_test && serviceName === 'db' && !attached.includes('postgres_test')) {
      throw new Error('PostgreSQL test path is missing')
    }
    if (config.networks.postgres_test && serviceName !== 'db' && attached.includes('postgres_test')) {
      throw new Error('Only the isolated database may use the test path')
    }
    for (const mount of service.volumes ?? []) {
      if (mount.type === 'volume' && !allowed.has(config.volumes[mount.source]?.name ?? mount.source)) throw new Error(`Unexpected service volume: ${mount.source}`)
      if (mount.type === 'bind' && !allowedBinds.includes(mount.source)) throw new Error('Unsafe bind mount')
    }
    for (const port of service.ports ?? []) {
      const ephemeral = port.published === undefined || port.published === '0'
      const expectedDynamic = allowedLoopbackPort !== undefined && port.published === String(allowedLoopbackPort)
      if (port.host_ip !== '127.0.0.1' || (!ephemeral && !expectedDynamic)) {
        throw new Error('Unsafe published port')
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, project, root, work, port] = process.argv.slice(2)
  if (!file || !project || !root || !work) throw new Error('Usage: verify-backup-fixture-config.mjs CONFIG PROJECT ROOT WORK [LOOPBACK_PORT]')
  const allowedBinds = [`${root}/deploy/Caddyfile`, `${root}/deploy/bootstrap-production-db-roles.sh`,
    `${root}/deploy/prepare-state-volume.sh`, `${root}/apps/api/test/fixtures/isolated-restore-business-seed.mjs`,
    `${root}/apps/api/test/fixtures/license-pending-compose-recovery.mjs`, `${work}/trust.jws`]
  verifyFixtureConfig(JSON.parse(await readFile(file, 'utf8')), project, allowedBinds, port)
  console.log('Isolated Compose configuration verified')
}
