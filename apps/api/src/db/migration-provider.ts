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
import { productCreationIdempotencyMigration } from './migrations/202610170004_product_creation_idempotency.js'
import { tradeFoundationMigration } from './migrations/202610180001_trade_foundation.js'
import { customerSessionsMigration } from './migrations/202610190001_customer_sessions.js'
import { customerManagementMigration } from './migrations/202610190002_customer_management.js'
import { customerCartMigration } from './migrations/202610190003_customer_cart.js'
import { ordersMigration } from './migrations/202610190004_orders.js'
import { purchaseLimitsMigration } from './migrations/202610200001_purchase_limits.js'
import { onlinePaymentsMigration } from './migrations/202610200002_online_payments.js'
import { paymentReconciliationMigration } from './migrations/202610200003_payment_reconciliation.js'
import { walletPaymentsMigration } from './migrations/202610200004_wallet_payments.js'
import { refundsMigration } from './migrations/202610200005_refunds.js'
import { withdrawalsMigration } from './migrations/202610210001_withdrawals.js'
import { codePoolMigration } from './migrations/202610210002_code_pool.js'
import { codePoolOperationKeyMigration } from './migrations/202610210003_code_pool_operation_key.js'
import { fixedDeliveryMigration } from './migrations/202610210004_fixed_delivery.js'
import { privateFileDeliveryMigration } from './migrations/202610210005_private_file_delivery.js'
import { externalApiDeliveryMigration } from './migrations/202610230001_external_api_delivery.js'
import { digitalFulfillmentAcceptanceMigration } from './migrations/202610230002_digital_fulfillment_acceptance.js'

import { kayixinReadonlyMigration } from './migrations/202610240001_kayixin_readonly.js'
import { purchaseFormsDraftsMigration } from './migrations/202610240002_purchase_forms_drafts.js'
import { purchaseFormAuditProductIdentityMigration } from './migrations/202610240003_purchase_form_audit_product_identity.js'
import { purchaseLinesMigration } from './migrations/202610250001_purchase_lines.js'
import { purchaseSnapshotManifestR1Migration } from './migrations/202610250002_purchase_snapshot_manifest_r1.js'
import { purchaseFormActivationStateMigration } from './migrations/202610250003_purchase_form_activation_state.js'
import { cartReplacementDraftsMigration } from './migrations/202610250004_cart_replacement_drafts.js'
import { supplierProductMappingsMigration } from './migrations/202610260001_supplier_product_mappings.js'
import { productPricingRulesMigration } from './migrations/202610260002_product_pricing_rules.js'
import { supplierQuoteObservationsMigration } from './migrations/202610270001_supplier_quote_observations.js'
import { supplierQuoteSourceConsistencyMigration } from './migrations/202610270002_supplier_quote_source_consistency.js'
import { procurementIdentityMigration } from './migrations/202610270003_procurement_identity.js'

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
      '202610170004_product_creation_idempotency': productCreationIdempotencyMigration,
      '202610180001_trade_foundation': tradeFoundationMigration,
      '202610190001_customer_sessions': customerSessionsMigration,
      '202610190002_customer_management': customerManagementMigration,
      '202610190003_customer_cart': customerCartMigration,
      '202610190004_orders': ordersMigration,
      '202610200001_purchase_limits': purchaseLimitsMigration,
      '202610200002_online_payments': onlinePaymentsMigration,
      '202610200003_payment_reconciliation': paymentReconciliationMigration,
      '202610200004_wallet_payments': walletPaymentsMigration,
      '202610200005_refunds': refundsMigration,
      '202610210001_withdrawals': withdrawalsMigration,
      '202610210002_code_pool': codePoolMigration,
      '202610210003_code_pool_operation_key': codePoolOperationKeyMigration,
      '202610210004_fixed_delivery': fixedDeliveryMigration,
      '202610210005_private_file_delivery': privateFileDeliveryMigration,
      '202610230001_external_api_delivery': externalApiDeliveryMigration,
      '202610230002_digital_fulfillment_acceptance': digitalFulfillmentAcceptanceMigration,
      '202610240001_kayixin_readonly': kayixinReadonlyMigration,
      '202610240002_purchase_forms_drafts': purchaseFormsDraftsMigration,
      '202610240003_purchase_form_audit_product_identity': purchaseFormAuditProductIdentityMigration,
      '202610250001_purchase_lines': purchaseLinesMigration,
      '202610250002_purchase_snapshot_manifest_r1': purchaseSnapshotManifestR1Migration,
      '202610250003_purchase_form_activation_state': purchaseFormActivationStateMigration,
      '202610250004_cart_replacement_drafts': cartReplacementDraftsMigration,
      '202610260001_supplier_product_mappings': supplierProductMappingsMigration,
      '202610260002_product_pricing_rules': productPricingRulesMigration,
      '202610270001_supplier_quote_observations': supplierQuoteObservationsMigration,
      '202610270002_supplier_quote_source_consistency': supplierQuoteSourceConsistencyMigration,
      '202610270003_procurement_identity': procurementIdentityMigration,
    }
  }
}
