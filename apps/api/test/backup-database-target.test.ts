import { describe, expect, it, vi } from 'vitest'
import { withProvenProductionDatabaseTarget } from '../src/backup/database-target.js'

const noop = async () => {}
function target() {
  return { databaseConfig: { host: 'db', port: 5432, user: 'aikayun_bootstrap', database: 'aikayun', password: 'fixture' },
    dockerBinary: '/docker', dockerSocket: '/socket', containerId: 'a'.repeat(64),
    postgresImage: `docker.io/library/postgres@sha256:${'b'.repeat(64)}`, database: 'aikayun', bootstrapUser: 'aikayun_bootstrap',
    assertLock: vi.fn(noop), assertSignedDeployment: vi.fn(noop) }
}
describe('production database connection boundary', () => {
  it('refuses a missing password, URL override or non-fixed host without connecting', () => {
    for (const databaseConfig of [
      { ...target().databaseConfig, password: '' },
      { ...target().databaseConfig, host: 'other' },
      { ...target().databaseConfig, connectionString: 'postgresql://other/fixture' },
      { ...target().databaseConfig, user: 'other' },
    ]) {
      const input = { ...target(), databaseConfig }
      expect(() => withProvenProductionDatabaseTarget(input, async () => {})).toThrow('BACKUP_DATABASE_TARGET_UNVERIFIED')
      expect(input.assertLock).not.toHaveBeenCalled()
    }
  })
})
