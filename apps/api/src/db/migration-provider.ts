import type { Migration, MigrationProvider } from 'kysely/migration'
import { adminAuthMigration } from './migrations/202610150001_admin_auth.js'
import { productCatalogCoreMigration } from './migrations/202610160001_product_catalog_core.js'
import { productSkuInvariantMigration } from './migrations/202610160002_product_sku_invariant.js'
import { productTaxonomyOptionsMigration } from './migrations/202610160003_product_taxonomy_options.js'
import { productCatalogR1Migration } from './migrations/202610160004_product_catalog_r1.js'
import { productPricingInventoryMigration } from './migrations/202610160005_product_pricing_inventory.js'
import { inventoryRetirementSafetyMigration } from './migrations/202610170001_inventory_retirement_safety.js'
import { productManagementMigration } from './migrations/202610170002_product_management.js'
import { productMediaAndRichContentMigration } from './migrations/202610170003_product_media_and_rich_content.js'

export class AppMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '202610150001_admin_auth': adminAuthMigration,
      '202610160001_product_catalog_core': productCatalogCoreMigration,
      '202610160002_product_sku_invariant': productSkuInvariantMigration,
      '202610160003_product_taxonomy_options': productTaxonomyOptionsMigration,
      '202610160004_product_catalog_r1': productCatalogR1Migration,
      '202610160005_product_pricing_inventory': productPricingInventoryMigration,
      '202610170001_inventory_retirement_safety': inventoryRetirementSafetyMigration,
      '202610170002_product_management': productManagementMigration,
      '202610170003_product_media_and_rich_content': productMediaAndRichContentMigration,
    }
  }
}
