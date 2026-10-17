import type { Kysely, Selectable } from 'kysely'
import type { Database, ProductsTable } from '../db/types.js'
import { CatalogError } from './errors.js'

export type LockedProduct = Selectable<ProductsTable>

/** Locks the product row and validates the revision used by catalog mutations. */
export async function lockProductAtRevision(
  db: Kysely<Database>,
  productId: string,
  expectedRevision: number,
): Promise<LockedProduct> {
  const product = await db.selectFrom('products').selectAll()
    .where('id', '=', productId).forUpdate().executeTakeFirst()
  if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
  if (product.revision !== expectedRevision) {
    throw new CatalogError(409, 'PRODUCT_REVISION_CONFLICT', 'The product changed; reload it and retry')
  }
  return product
}

/** Call after taking the product row lock for any operating-configuration edit. */
export function assertProductNotArchived(product: Pick<LockedProduct, 'status'>): void {
  if (product.status === 'archived') {
    throw new CatalogError(409, 'PRODUCT_ARCHIVED', 'Restore the archived product to draft before changing its configuration')
  }
}
