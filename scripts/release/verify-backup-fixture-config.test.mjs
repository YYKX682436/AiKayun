import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { verifyFixtureConfig } from './verify-backup-fixture-config.mjs'

const project = `aikayun-75a-test-${'a'.repeat(24)}`
const base = () => ({ name: project,
  volumes: Object.fromEntries(['postgres_data', 'aikayun_state', 'caddy_data', 'caddy_config'].map(name => [name, { name: `${project}_${name}` }])),
  networks: { private: { name: `${project}_private` } }, services: {
    db: { volumes: [{ type: 'volume', source: `${project}_postgres_data` }] },
    caddy: { volumes: [{ type: 'volume', source: `${project}_caddy_data` }], ports: [{ host_ip: '127.0.0.1', published: '0' }] },
  } })
test('allows only the exact isolated deployment', () => { verifyFixtureConfig(base(), project) })
test('allows a loopback-only dynamic port without a fixed host port', () => {
  const config = base()
  config.services.db.ports = [{ host_ip: '127.0.0.1', target: 5432, protocol: 'tcp' }]
  verifyFixtureConfig(config, project)
})
test('allows only the generated loopback test port', () => {
  const config = base()
  config.services.db.ports = [{ host_ip: '127.0.0.1', published: '43210', target: 5432, protocol: 'tcp' }]
  verifyFixtureConfig(config, project, [], 43210)
  assert.throws(() => verifyFixtureConfig(config, project, [], 43211))
})
test('allows the database-only loopback bridge with external masquerading disabled', () => {
  const config = base()
  config.networks.postgres_test = { name: `${project}_postgres_test`, driver: 'bridge', internal: false,
    driver_opts: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' } }
  config.services.db.networks = { private: {}, postgres_test: {} }
  config.services.db.ports = [{ host_ip: '127.0.0.1', published: '43210', target: 5432, protocol: 'tcp' }]
  verifyFixtureConfig(config, project, [], 43210)
  config.services.caddy.networks = { private: {}, postgres_test: {} }
  assert.throws(() => verifyFixtureConfig(config, project, [], 43210))
})
test('rejects production volume, network, bind mount and exposed port', () => {
  for (const mutate of [
    c => { c.volumes.aikayun_state.name = 'aikayun_state' },
    c => { c.services.db.volumes[0].source = 'aikayun_postgres_data' },
    c => { c.networks.private.name = 'aikayun_private' },
    c => { c.services.db.volumes.push({ type: 'bind', source: '/opt/aikayun/secrets' }) },
    c => { c.services.caddy.ports[0].host_ip = '0.0.0.0' },
    c => { c.services.db.ports = [{ host_ip: '127.0.0.1', published: '5432', target: 5432 }] },
  ]) {
    const config = base(); mutate(config)
    assert.throws(() => verifyFixtureConfig(config, project))
  }
})
