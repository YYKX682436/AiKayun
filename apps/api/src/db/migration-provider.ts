import type { Migration, MigrationProvider } from 'kysely/migration'
import { adminAuthMigration } from './migrations/202610150001_admin_auth.js'

export class AppMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { '202610150001_admin_auth': adminAuthMigration }
  }
}
