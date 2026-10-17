import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { ProductManagementOperation } from '../db/types.js'
import type { Database } from '../db/types.js'

export type ProductAuditData = Record<string, unknown> | null

export interface ProductAuditInput {
  id?: string
  productId: string
  administratorId: string
  operation: ProductManagementOperation
  before: ProductAuditData
  after: ProductAuditData
}

export async function appendProductAudit(
  db: Kysely<Database>,
  event: ProductAuditInput,
): Promise<void> {
  await db.insertInto('product_management_audit_events').values({
    id: event.id ?? randomUUID(),
    product_id: event.productId,
    administrator_id: event.administratorId,
    operation: event.operation,
    before_data: event.before,
    after_data: event.after,
  }).execute()
}
