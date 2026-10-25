import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../src/db/types.js'
import { purchaseLineContentIdentity } from '../../src/commerce/purchase-lines.js'

/** Stage-2B no-form fact for direct-SQL order fixtures. */
export async function insertNoFormPurchaseSnapshot(
  db: Kysely<Database> | Transaction<Database>, orderItemId: string, skuId: string,
): Promise<void> {
  await db.insertInto('order_item_purchase_snapshots').values({
    order_item_id: orderItemId,
    template_version_id: null,
    normalization_version: null,
    content_identity: purchaseLineContentIdentity(skuId, null, null, null),
    encrypted_values: null,
    values_nonce: null,
    values_auth_tag: null,
    encryption_key_id: null,
    attachment_ids: [],
  }).execute()
}
