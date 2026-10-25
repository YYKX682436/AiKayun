import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Keep a cart's last-valid draft bound while a separate edit draft is incomplete. */
export const cartReplacementDraftsMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE purchase_draft_attachments
      ADD COLUMN replaces_attachment_id uuid,
      ADD CONSTRAINT purchase_draft_attachments_replaces_fkey
        FOREIGN KEY (replaces_attachment_id) REFERENCES purchase_draft_attachments (id)
        ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED`.execute(db)
    await sql`CREATE UNIQUE INDEX purchase_draft_attachments_replaces_idx
      ON purchase_draft_attachments (replaces_attachment_id)
      WHERE replaces_attachment_id IS NOT NULL AND status IN ('uploading', 'ready', 'failed')`.execute(db)

    await sql`
      CREATE TABLE customer_cart_line_replacement_drafts (
        line_id uuid PRIMARY KEY,
        customer_id uuid NOT NULL,
        source_draft_id uuid NOT NULL,
        replacement_draft_id uuid NOT NULL UNIQUE,
        source_line_revision integer NOT NULL CHECK (source_line_revision >= 1),
        source_draft_revision integer NOT NULL CHECK (source_draft_revision >= 1),
        omitted_source_attachment_ids uuid[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customer_cart_line_replacement_line_fkey
          FOREIGN KEY (line_id) REFERENCES customer_cart_items (line_id) ON DELETE CASCADE
          DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT customer_cart_line_replacement_customer_fkey
          FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
        CONSTRAINT customer_cart_line_replacement_source_draft_fkey
          FOREIGN KEY (source_draft_id) REFERENCES purchase_drafts (id) ON DELETE RESTRICT
          DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT customer_cart_line_replacement_draft_fkey
          FOREIGN KEY (replacement_draft_id) REFERENCES purchase_drafts (id) ON DELETE CASCADE
          DEFERRABLE INITIALLY DEFERRED
      )
    `.execute(db)
    await sql`CREATE INDEX customer_cart_line_replacement_source_idx
      ON customer_cart_line_replacement_drafts (source_draft_id)`.execute(db)
    await sql`
      CREATE FUNCTION guard_customer_cart_line_replacement_draft() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE line_row customer_cart_items%ROWTYPE;
      DECLARE source_row purchase_drafts%ROWTYPE;
      DECLARE replacement_row purchase_drafts%ROWTYPE;
      BEGIN
        SELECT * INTO line_row FROM customer_cart_items WHERE line_id = NEW.line_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Cart replacement line does not exist'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_replacement_draft_invalid';
        END IF;
        SELECT * INTO source_row FROM purchase_drafts WHERE id = NEW.source_draft_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Cart replacement source draft does not exist'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_replacement_draft_invalid';
        END IF;
        SELECT * INTO replacement_row FROM purchase_drafts WHERE id = NEW.replacement_draft_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Cart replacement draft does not exist'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_replacement_draft_invalid';
        END IF;
        IF line_row.customer_id IS DISTINCT FROM NEW.customer_id
          OR line_row.draft_id IS DISTINCT FROM NEW.source_draft_id
          OR line_row.revision IS DISTINCT FROM NEW.source_line_revision
          OR line_row.draft_revision IS DISTINCT FROM NEW.source_draft_revision
          OR source_row.customer_id IS DISTINCT FROM NEW.customer_id
          OR source_row.guest_order_session_id IS NOT NULL
          OR source_row.status <> 'active' OR source_row.expires_at <= statement_timestamp()
          OR source_row.revision IS DISTINCT FROM NEW.source_draft_revision
          OR replacement_row.customer_id IS DISTINCT FROM NEW.customer_id
          OR replacement_row.guest_order_session_id IS NOT NULL
          OR replacement_row.status <> 'active' OR replacement_row.expires_at <= statement_timestamp()
          OR EXISTS (SELECT 1 FROM customer_cart_items AS bound
            WHERE bound.draft_id = NEW.replacement_draft_id)
          OR EXISTS (SELECT 1 FROM customer_cart_line_replacement_drafts AS other
            WHERE other.replacement_draft_id = NEW.replacement_draft_id AND other.line_id <> NEW.line_id) THEN
          RAISE EXCEPTION 'Cart replacement draft does not match its owner and source line'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_replacement_draft_invalid';
        END IF;
        IF EXISTS (
          SELECT 1 FROM unnest(NEW.omitted_source_attachment_ids) AS omitted(id)
          LEFT JOIN purchase_draft_attachments AS attachment ON attachment.id = omitted.id
          LEFT JOIN purchase_draft_attachment_references AS reference
            ON reference.draft_id = NEW.source_draft_id AND reference.attachment_id = omitted.id
          WHERE attachment.id IS NULL OR attachment.draft_id <> NEW.source_draft_id
            OR attachment.status <> 'ready' OR reference.attachment_id IS NULL
        ) THEN
          RAISE EXCEPTION 'Cart replacement omitted attachment is not a referenced source image'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_replacement_attachment_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER customer_cart_line_replacement_draft_guard
      BEFORE INSERT OR UPDATE ON customer_cart_line_replacement_drafts
      FOR EACH ROW EXECUTE FUNCTION guard_customer_cart_line_replacement_draft()`.execute(db)

    await sql`
      CREATE FUNCTION guard_purchase_draft_attachment_replacement() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE old_row purchase_draft_attachments%ROWTYPE;
      DECLARE replacement_row customer_cart_line_replacement_drafts%ROWTYPE;
      DECLARE draft_row purchase_drafts%ROWTYPE;
      DECLARE source_row purchase_drafts%ROWTYPE;
      DECLARE line_row customer_cart_items%ROWTYPE;
      BEGIN
        IF NEW.replaces_attachment_id IS NULL THEN RETURN NEW; END IF;
        SELECT * INTO old_row FROM purchase_draft_attachments WHERE id = NEW.replaces_attachment_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Replacement source attachment does not exist'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_attachment_replacement_invalid';
        END IF;
        SELECT * INTO replacement_row FROM customer_cart_line_replacement_drafts
          WHERE replacement_draft_id = NEW.draft_id;
        SELECT * INTO draft_row FROM purchase_drafts WHERE id = NEW.draft_id;
        SELECT * INTO source_row FROM purchase_drafts WHERE id = old_row.draft_id;
        SELECT * INTO line_row FROM customer_cart_items WHERE line_id = replacement_row.line_id;
        IF replacement_row.replacement_draft_id IS NULL OR old_row.status <> 'ready'
          OR NEW.status NOT IN ('uploading', 'ready')
          OR old_row.draft_id IS DISTINCT FROM replacement_row.source_draft_id
          OR old_row.field_id IS DISTINCT FROM NEW.field_id
          OR draft_row.customer_id IS DISTINCT FROM replacement_row.customer_id
          OR source_row.status <> 'active' OR source_row.expires_at <= statement_timestamp()
          OR source_row.revision IS DISTINCT FROM replacement_row.source_draft_revision
          OR line_row.customer_id IS DISTINCT FROM replacement_row.customer_id
          OR line_row.draft_id IS DISTINCT FROM replacement_row.source_draft_id
          OR line_row.revision IS DISTINCT FROM replacement_row.source_line_revision
          OR NOT EXISTS (SELECT 1 FROM purchase_draft_attachment_references AS reference
            WHERE reference.draft_id = replacement_row.source_draft_id AND reference.attachment_id = old_row.id) THEN
          RAISE EXCEPTION 'Replacement attachment does not match its cart edit'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_attachment_replacement_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_draft_attachment_replacement_guard
      BEFORE INSERT OR UPDATE OF replaces_attachment_id, draft_id, field_id ON purchase_draft_attachments
      FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_attachment_replacement()`.execute(db)
  },
  async down(db) {
    await sql`DROP TRIGGER purchase_draft_attachment_replacement_guard ON purchase_draft_attachments`.execute(db)
    await sql`DROP FUNCTION guard_purchase_draft_attachment_replacement()`.execute(db)
    await sql`DROP TRIGGER customer_cart_line_replacement_draft_guard ON customer_cart_line_replacement_drafts`.execute(db)
    await sql`DROP FUNCTION guard_customer_cart_line_replacement_draft()`.execute(db)
    await sql`DROP TABLE customer_cart_line_replacement_drafts`.execute(db)
    await sql`DROP INDEX purchase_draft_attachments_replaces_idx`.execute(db)
    await sql`ALTER TABLE purchase_draft_attachments
      DROP CONSTRAINT purchase_draft_attachments_replaces_fkey,
      DROP COLUMN replaces_attachment_id`.execute(db)
  },
}
