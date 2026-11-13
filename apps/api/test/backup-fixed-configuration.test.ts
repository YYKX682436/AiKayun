import { describe, expect, it } from 'vitest'
import { assertFixedComposeConfiguration } from '../src/backup/fixed-configuration.js'

const sha = 'a'.repeat(64)
const expected = { domain: 'shop.example.invalid', api: `ghcr.io/yykx682436/aikayun-api@sha256:${sha}`,
  web: `ghcr.io/yykx682436/aikayun-web@sha256:${sha}`, postgres: `docker.io/library/postgres@sha256:${sha}`,
  caddy: `docker.io/library/caddy@sha256:${sha}` }
const fixture = Buffer.from([
  `AIKAYUN_PUBLIC_HOST=${expected.domain}`, `AIKAYUN_API_IMAGE=${expected.api}`, `AIKAYUN_WEB_IMAGE=${expected.web}`,
  `AIKAYUN_POSTGRES_IMAGE=${expected.postgres}`, `AIKAYUN_CADDY_IMAGE=${expected.caddy}`,
  'AIKAYUN_LICENSE_TRUST_BUNDLE_FILE=/opt/aikayun/release/license-trust-bundle.jws',
  'AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE=/opt/aikayun/secrets/postgres_admin_password',
  'AIKAYUN_API_DATABASE_PASSWORD_FILE=/opt/aikayun/secrets/api_database_password',
  'AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE=/opt/aikayun/secrets/migrator_database_password',
  'AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE=/opt/aikayun/secrets/payment_credential_key_ring',
  'AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE=/opt/aikayun/secrets/code_pool_encryption_key_ring', '',
].join('\n'))
describe('fixed installer configuration', () => {
  it('accepts only the exact configuration derived from authenticated inputs', () => {
    expect(() => assertFixedComposeConfiguration(fixture, expected)).not.toThrow()
    for (const value of [
      Buffer.concat([fixture, Buffer.from('AIKAYUN_DB_NAME=other\n')]),
      Buffer.from(fixture.toString().replace('/opt/aikayun/secrets/postgres_admin_password', '/tmp/password')),
      Buffer.from(fixture.toString().replace(expected.postgres, `docker.io/library/postgres@sha256:${'b'.repeat(64)}`)),
      Buffer.from(fixture.toString().replace(`AIKAYUN_PUBLIC_HOST=${expected.domain}`, `AIKAYUN_PUBLIC_HOST=${expected.domain}\nAIKAYUN_PUBLIC_HOST=other`)),
    ]) expect(() => assertFixedComposeConfiguration(value, expected)).toThrow('BACKUP_FIXED_CONFIGURATION_INVALID')
  })
  it('rejects malformed authenticated metadata and hostile interpolation', () => {
    expect(() => assertFixedComposeConfiguration(fixture, { ...expected, domain: '$(unsafe)' })).toThrow('BACKUP_FIXED_CONFIGURATION_INVALID')
    expect(() => assertFixedComposeConfiguration(fixture, { ...expected, api: `ghcr.io/other/aikayun-api@sha256:${sha}` })).toThrow('BACKUP_FIXED_CONFIGURATION_INVALID')
  })
  it('accepts the signed project PostgreSQL image but still binds its exact digest', () => {
    const postgres = `ghcr.io/yykx682436/aikayun-postgres@sha256:${sha}`
    const projectFixture = Buffer.from(fixture.toString().replace(expected.postgres, postgres))
    expect(() => assertFixedComposeConfiguration(projectFixture, { ...expected, postgres })).not.toThrow()
    expect(() => assertFixedComposeConfiguration(projectFixture, { ...expected, postgres: `ghcr.io/yykx682436/aikayun-postgres@sha256:${'b'.repeat(64)}` })).toThrow('BACKUP_FIXED_CONFIGURATION_INVALID')
    expect(() => assertFixedComposeConfiguration(projectFixture, { ...expected, postgres: `ghcr.io/other/aikayun-postgres@sha256:${sha}` })).toThrow('BACKUP_FIXED_CONFIGURATION_INVALID')
  })
})
