/**
 * This release has no eligible procurement source. In particular, a reviewed
 * mapping is not eligibility. No environment variable, database setting or
 * administrator/customer route can change this decision.
 *
 * The isolated integration fixture replaces this module at test import time;
 * it is never wired into the production application.
 */
export interface CheckoutProcurementSourceSelection {
  skuId: string
  mappingVersionId: string
}

export function selectCheckoutProcurementSources(): readonly CheckoutProcurementSourceSelection[] {
  return []
}
