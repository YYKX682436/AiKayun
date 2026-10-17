import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productMediaAndRichContentMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE products
      ADD COLUMN rich_content jsonb NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,
      ADD CONSTRAINT products_rich_content_object_check CHECK (jsonb_typeof(rich_content) = 'object')`.execute(db)

    await sql`ALTER TABLE product_management_audit_events
      DROP CONSTRAINT product_management_audit_operation_check,
      ALTER COLUMN operation TYPE varchar(32)`.execute(db)
    await sql`ALTER TABLE product_management_audit_events
      ADD CONSTRAINT product_management_audit_operation_check CHECK (operation IN (
        'created', 'updated', 'published', 'paused', 'relisted', 'archived', 'restored',
        'copied', 'deleted', 'gallery_updated', 'rich_content_updated'
      ))`.execute(db)

    await sql`
      CREATE TABLE product_media (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db)

    await sql`
      CREATE TABLE product_media_variants (
        media_id uuid NOT NULL,
        variant varchar(16) NOT NULL,
        storage_key text NOT NULL UNIQUE,
        format varchar(16) NOT NULL DEFAULT 'webp',
        width integer NOT NULL,
        height integer NOT NULL,
        size_bytes integer NOT NULL,
        sha256 char(64) NOT NULL,
        processing_version varchar(32) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_media_variants_pkey PRIMARY KEY (media_id, variant),
        CONSTRAINT product_media_variants_media_fkey
          FOREIGN KEY (media_id) REFERENCES product_media(id) ON DELETE CASCADE,
        CONSTRAINT product_media_variants_variant_check
          CHECK (variant IN ('thumbnail', 'card', 'detail')),
        CONSTRAINT product_media_variants_format_check CHECK (format = 'webp'),
        CONSTRAINT product_media_variants_dimensions_check
          CHECK (width BETWEEN 1 AND 1920 AND height BETWEEN 1 AND 1920),
        CONSTRAINT product_media_variants_size_check CHECK (size_bytes BETWEEN 1 AND 20971520),
        CONSTRAINT product_media_variants_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT product_media_variants_version_check
          CHECK (processing_version ~ '^[a-z0-9-]{1,32}$'),
        CONSTRAINT product_media_variants_storage_key_check CHECK (
          storage_key = 'objects/' || substr(media_id::text, 1, 2) || '/' ||
            media_id::text || '-' || variant || '.webp'
        )
      )
    `.execute(db)

    await sql`
      CREATE TABLE product_media_references (
        product_id uuid NOT NULL,
        media_id uuid NOT NULL,
        source varchar(16) NOT NULL,
        sort_order integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_media_references_pkey PRIMARY KEY (product_id, media_id, source),
        CONSTRAINT product_media_references_product_fkey
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        CONSTRAINT product_media_references_media_fkey
          FOREIGN KEY (media_id) REFERENCES product_media(id) ON DELETE RESTRICT,
        CONSTRAINT product_media_references_source_check CHECK (source IN ('gallery', 'rich_content')),
        CONSTRAINT product_media_references_order_check CHECK (
          (source = 'gallery' AND sort_order IS NOT NULL AND sort_order BETWEEN 0 AND 19)
          OR (source = 'rich_content' AND sort_order IS NULL)
        )
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX product_media_references_gallery_order_unique
      ON product_media_references (product_id, sort_order) WHERE source = 'gallery'`.execute(db)
    await sql`CREATE INDEX product_media_references_media_idx
      ON product_media_references (media_id, product_id)`.execute(db)
  },

  async down(db) {
    await sql`DROP TABLE product_media_references`.execute(db)
    await sql`DROP TABLE product_media_variants`.execute(db)
    await sql`DROP TABLE product_media`.execute(db)
    await sql`ALTER TABLE products DROP CONSTRAINT products_rich_content_object_check, DROP COLUMN rich_content`.execute(db)
    // The widened audit operation type and entries are retained so audit history
    // stays immutable when the media schema is rolled back.
  },
}
