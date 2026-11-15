import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const removeShoppingCartMigration: Migration = {
  async up(db) {
    // 1. Drop trigger and function for cart replacement draft attachment guard
    await sql`DROP TRIGGER IF EXISTS purchase_draft_attachment_replacement_guard ON purchase_draft_attachments`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_draft_attachment_replacement()`.execute(db)

    // 2. Drop trigger and function for cart line replacement draft guard
    await sql`DROP TRIGGER IF EXISTS customer_cart_line_replacement_draft_guard ON customer_cart_line_replacement_drafts`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_customer_cart_line_replacement_draft()`.execute(db)

    // 3. Drop customer_cart_line_replacement_drafts table
    await sql`DROP TABLE IF EXISTS customer_cart_line_replacement_drafts CASCADE`.execute(db)

    // 4. Drop replaces_attachment_id index, constraint, and column from purchase_draft_attachments
    await sql`DROP INDEX IF EXISTS purchase_draft_attachments_replaces_idx`.execute(db)
    await sql`ALTER TABLE purchase_draft_attachments
      DROP CONSTRAINT IF EXISTS purchase_draft_attachments_replaces_fkey,
      DROP COLUMN IF EXISTS replaces_attachment_id`.execute(db)

    // 5. Drop purchase_draft_cart_payload_binding trigger and function from purchase_drafts
    await sql`DROP TRIGGER IF EXISTS purchase_draft_cart_payload_binding ON purchase_drafts`.execute(db)
    await sql`DROP FUNCTION IF EXISTS assert_purchase_draft_cart_payload_binding()`.execute(db)

    // 6. Drop customer_cart_merge_requests table
    await sql`DROP TABLE IF EXISTS customer_cart_merge_requests CASCADE`.execute(db)

    // 7. Drop customer_cart_items triggers and functions
    await sql`DROP TRIGGER IF EXISTS customer_cart_form_binding ON customer_cart_items`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_customer_cart_form_binding()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS customer_cart_line_revision ON customer_cart_items`.execute(db)
    await sql`DROP FUNCTION IF EXISTS bump_customer_cart_line_revision()`.execute(db)

    // 8. Drop customer_cart_items table
    await sql`DROP TABLE IF EXISTS customer_cart_items CASCADE`.execute(db)
  },

  async down(_db) {
    // Cart removal is permanent; no legacy rollback needed.
  },
}
