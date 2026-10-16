import type { Migration, MigrationProvider } from 'kysely/migration'
import { adminAuthMigration } from './migrations/202610150001_admin_auth.js'
import { productCatalogCoreMigration } from './migrations/202610160001_product_catalog_core.js'

export class AppMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '202610150001_admin_auth': adminAuthMigration,
      '202610160001_product_catalog_core': productCatalogCoreMigration,
    }
  }
}
